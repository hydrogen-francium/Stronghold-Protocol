# Fork 单实例 Compose 部署与维护

适用源码：账号认证、协议 2、4/8/16 房间及超过四人个人池 fork。此文不是上游 0.3.1 部署说明。
配置入口为仓库根 `compose.yaml`，本机调试叠加 `compose.local.yaml`；不要复制发行目录替代源码树。

**验证边界（2026-10-21）：**已完成本地挂载/认证/维护契约 7 项及 Python 解包安全夹具 5 项验证；
已通过远程范围读取核对固定发布包目录、白名单、顶层引用及字体样式。本机未发现 Docker，未执行镜像构建、
完整包下载和 SHA-256 复算、Linux 锁/卷权限、空卷冷启动、证书申请、真实 WS 或停止/恢复验收。
CI 已增加容器配置、构建和 Caddy 校验入口，但本次没有运行远端 CI。不能据此标为可上线或真实十六人通过。
补充素材哈希路由与文档一致性/路径定向检查 47/47；没有复跑全量历史回归。
交付前另通过真实账号切换浏览器用例、4/8/16 容量及五名显式参与者开局浏览器用例各 1/1，
并通过 HTTP 认证冒烟；844×390 桌面视口可滚动到第十六席，不等于实体手机或十六真人整局。

## 1. 配置与首次启动

目标环境是 Ubuntu Server 24.04 LTS x64、Docker Engine 和支持条件依赖的 Compose v2。先用
`docker compose version` 确认已安装；本项目不自动安装系统组件。公网域名解析到服务器，允许 TCP 80/443；
不要把 app 的 3000 端口发布到公网，也不要扩展 app 副本数。秘密、账号、TLS、插件及备份均不能进入 Git。

在源码根目录执行以下配置步骤，示例域名和邮箱必须换成实际值：

```sh
cp deploy/environment.example .env
# 编辑 .env：SP_DOMAIN、ACME_EMAIL、两份秘密文件路径，以及是否开放注册。
node tools/deploy/control.mjs secrets "$PWD/deploy/secrets"
sudo chown 1000:1000 deploy/secrets/entry-token deploy/secrets/session-secret
docker compose config --quiet
docker compose up -d --build
docker compose ps -a
docker compose logs --tail 80 assets-init app proxy
```

秘密生成步骤需要宿主 Node（仓库要求 `^22.16.0 || >=24.0.0`）；生成器只接受全新绝对目录，不覆盖已有秘密，
两个独立随机值各 48 字节，目录 0700、文件 0400。应用身份为 1000:1000，因此须核对文件实际所有者。
不要用 Compose secrets 的 `uid`/`mode` 声明替代宿主文件权限检查。`.env` 是 Compose 插值输入，应用本身不加载它；
文件里只填写秘密路径，不填写秘密正文。已有部署必须保留原秘密，不要为升级重新生成。

`SP_REGISTRATION_OPEN=1` 明确允许注册，设为 `0` 关闭新注册，已有账号仍需通过准入和登录。
通过私密渠道分发 `entry-token`；`session-secret` 只由部署维护者保管。匿名 `/healthz` 仅返回最小存活响应，
不能代替真实准入、登录、受保护素材与 WS 验收。所有认证约束仍见 [AUTH.md](AUTH.md)。

### 仅本机调试

保留 `.env` 中完整占位域名/邮箱/秘密路径（基础配置插值仍要求存在），改用：

```sh
docker compose -f compose.yaml -f compose.local.yaml config --quiet
docker compose -f compose.yaml -f compose.local.yaml up -d --build
```

只发布 `127.0.0.1:3000`，默认不启动 proxy。精确 Origin 为 `http://127.0.0.1:3000`，仅此覆盖启用 loopback HTTP，
且关闭代理信任；准入、账号、CSRF 和 WebSocket 认证并未关闭。不要把此覆盖改成 `0.0.0.0` 部署。
本机与公网配置不要同时运行同名 Compose 项目。

## 2. 素材初始化与只读路径

**不提交素材不等于部署缺素材。** Git 只保存源码、初始化脚本和固定版本锁；首次 `docker compose up -d --build`
会先运行 `assets-init`，下载、校验并解包到 Docker 素材持久卷，成功后才启动 app，再启动 proxy。
服务器必须可以访问固定 GitHub 发布包；网络不可达应先解决服务器下载条件，不能跳过校验或把空卷当成功。
后续启动复用合法版本，普通重建镜像不需要重新下载。不要执行 `docker compose down -v`，它会删除素材及其他持久卷。

固定来源由 `shared/asset-release.json` 唯一定义：上游 `v0.3.1` 完整发布包，845522197 字节，
SHA-256 为 `d2f48f7fd2698f330b86c897d93ada2d7066825593cce4de8add46dfa68c3db1`。
发布 API 摘要已核对；实际初始化仍必须下载并复算全包，而不是相信响应头或仅核对文件名。

`assets-init` 使用隔离 Python，在独立素材卷持非阻塞排他锁；锁竞争、下载或校验失败直接退出，app 不得就绪。
只提取 `public/assets/`、`public/fonts/` 和 `data/assets.json`、`local-assets.json`、`local-fx.json`，
不取源码、node_modules 或配置。全部条目先做路径检查，选中条目再检查链接、大小写冲突、加密、压缩类型和展开上限。
上限为十万条目、单文件 256 MiB、总展开 4 GiB。三份清单及其站内素材引用闭包、字体样式引用必须完整。

只有全部成功才写 `complete.json`，将本次临时版本目录原子更名为 `v0.3.1-d2f48f7fd269`。
再次启动会检查标记、清单摘要和引用，合法版本直接复用，不重新下载。正常失败清理本次临时目录；
强杀或掉电可能留下 `.init-*`，须在确认初始化进程已停止后由维护者核对和清理，不自动删除其他历史目录。
这里的原子更名不等于对掉电后的所有文件作持久性担保。

app 只读挂载素材卷，通过 `SP_ASSET_BUNDLE_DIR` 使用版本根：只替换 `/assets/`、`/fonts/`、相关音频路径和
三份素材清单，页面、脚本、其他业务 `data` 与插件仍来自源码镜像。素材仍先过账号静态门禁；
缺标记、清单被改写或素材根无效直接拒绝启动。运行时启动检查不逐个复算所有素材文件；宿主仍须保护素材卷。

实际范围读取统计为 40444 个 ZIP 条目，白名单 32899 条、声明展开 1115474197 字节、顶层引用 30944 个；
这是目录证据，不是全包摘要或完整嵌套引用实测。首次下载至少约 846 MB，初始化还同时占用 ZIP、展开目录和镜像空间；
建议至少预留 6 GiB 空闲空间并计入镜像、数据库、插件及备份的额外增长。200 GB 流量包够用与否仍须按实际计费口径测量。

## 3. 网络、权限与资源边界

- 仅 proxy 发布 80/443。Caddy 使用域名自动 HTTPS，转发时覆盖客户端转发地址头；app 只在内部网络监听，
  `TRUST_PROXY=1` 依赖这个不可绕过的网络边界。若另加入口或暴露 app 端口，必须重新审核信任链。
- app 非 root、根文件系统只读、删除全部能力并禁止提权；素材只读。`state`、`plugins`、`cache`、`tls`、
  `proxy_config` 分卷；新卷依赖镜像预建目录的 1000:1000 所有者，已有卷与绑定目录必须单独核对，应用不偷偷修权限。
- app 配置上限 2 CPU / 3 GiB / 256 进程；proxy 为 0.5 CPU / 256 MiB / 64 进程；初始化为
  1 CPU / 512 MiB / 32 进程，完成后退出。初始化 `/tmp` 32 MiB、app `/tmp` 128 MiB；日志单服务 10 MB × 3。
  内存压缩缓存沿用源码 96 MiB 总量、8 MiB 单文件阈值。缓存卷只保存素材哈希索引及写入临时文件，不复制全部素材。
- 普通 Docker 命名卷并不自动具备硬磁盘配额。账号、插件、TLS、哈希缓存和备份的磁盘上限需由宿主文件系统配额/监控落实；
  不能把上述内存、日志和临时目录限制当作卷配额，也不能承诺 4 核 4 GB 容量已验收。
- Studio 与脚本插件默认关闭；开启须另外审查权限与资源。app 的内部网络默认没有直接公网出口，依赖远端请求的自定义插件
  不应在未审查网络策略时启用。缓存、插件和素材卷都不能保存认证秘密。

## 4. 排空、备份与停止

单实例更新不能无缝恢复内存对局。先禁止新增房间/入房/开局，不关闭现有游戏连接或正在进行的 Match：

```sh
docker compose exec app node tools/deploy/control.mjs drain
```

已登录维护者在同源浏览器查看 `/healthz`，确认 `draining: true`，等待 `matches: 0`；匿名响应没有这些字段。
断线重连仍使用原账号/原局；新的 room.create/join/start 返回既有维护提示。维护标记固定在私有状态目录，
不会新增公开管理接口。命令重复执行会报错，不静默假装成功。当前本地验证覆盖维护期间的连接、查询和离开，
尚未证明真实进行中的十六人战斗可以平稳排空。

在新的私有输出名下做 SQLite 一致性备份，并把结果移出服务器故障域：

```sh
docker compose exec app node server/auth/admin.js backup --db /srv/state/auth.sqlite --output /srv/state/auth-before-upgrade.sqlite
mkdir -p deploy/backups
chmod 700 deploy/backups
docker compose cp app:/srv/state/auth-before-upgrade.sqlite deploy/backups/auth-before-upgrade.sqlite
chmod 600 deploy/backups/auth-before-upgrade.sqlite
docker compose stop app
```

备份名必须每次更换，已有文件会被拒绝；成功复制后，状态卷中的旧备份由维护者确认留存策略。
不要直接复制运行中的 `auth.sqlite` 当作一致性备份。另行加密备份两份秘密、配置与必要插件/TLS 状态；
账号库不含可恢复的 Match，服务器账号备份也不包含浏览器本机战绩、配装或皮肤设置。
备份完成后到停止前仍可能有账号变更；若要求严格切换时间点，应先在入口阻断新访问并通知用户，再完成最后备份/停止。

现有进程首个 SIGTERM 会关闭房间、断开 socket 并关闭服务，五秒后有强制退出兜底；第二个信号立即退出。
Compose 的 15 秒停止宽限不是保存对局，不能跳过排空。异常长局只能由维护者明确决定继续等待或中断，不自动强杀来冒充排空。

### 离线恢复

1. 阻断入口，停止 app，确认没有其他实例或管理进程打开状态卷；保留当前卷的离线副本。
2. 在私有目录验证所选一致性备份可读、schema 合适，保留对应部署秘密与配置；新版本数据库不可盲目降级。
3. 由维护者挂载实际的 `stronghold_state` 卷，核对绝对目标路径与所有者，将旧 `auth.sqlite` 及其 WAL/SHM
   一并归档到另一个私有目录，再放入备份为新的 `auth.sqlite`，设所有者 1000:1000、权限 0600。
   不把旧 WAL/SHM 混入恢复库，不递归清空状态卷，不在未知运行状态下删除文件。
4. 启动单个 app，核对登录、账号禁用/准入和认证静态门禁；旧对局不可恢复。确认后再恢复入口。

此流程尚未执行真实容器恢复验收。不要运行 `docker compose down -v`，它会删除包括账号和 TLS 在内的持久卷。

## 5. 升级、迁移与验收入口

排空和备份后，取得已审阅源码，在同一项目/卷下执行 `docker compose build app`，再执行
`docker compose up -d app proxy`。若改变素材版本，须同时更新固定元数据、版本根和初始化服务，再重新完整验收。
`draining` 标记持久化，重启不会自动开放；确认健康、认证和 WS 后执行：

```sh
docker compose exec app node tools/deploy/control.mjs resume
```

迁移旧部署只搬运核对过的私有 SQLite 一致性备份、原秘密、必要插件与 TLS；不覆盖源码镜像的 public/data，
不把 Windows 发行包的 node_modules 或账号状态带入构建上下文，不依据昵称把游客本机历史归给服务器账号。
本地提交不等于远端已更新；从远端部署前须先由维护者推送对应分支，并核对服务器取得的提交号。

本地验证记录见项目接手文档；按交付要求，本次新增测试脚本与测试修改留在开发工作区，不包含在提交中，
部署无需运行这些本地脚本。原仓库受跟踪的测试保持原样，未因忽略规则被删除。
Linux CI 的独立 compose job 检查正式/本机配置、构建固定镜像、校验 Caddy；不在普通 CI 自动下载 846 MB 素材。
正式验收必须在干净源码与空卷实际运行本页首次启动命令，补做中断初始化、缺素材拒绝、HTTPS/WS、
账号重启持久化、完整备份/恢复、维护排空及 4c4g 下真实多局测量。真实十六人和手机横屏仍是独立开放门禁。

## 来源

- 本地契约：`Dockerfile`、`compose.yaml`、`compose.local.yaml`、`deploy/`、`tools/deploy/`、
  `server/http/assetBundle.js`、`server/http/drain.js`、`server/http/boot.js`、`server/auth/admin.js`。
- 固定发布：[GitHub 发布 API](https://api.github.com/repos/sganggs/Stronghold-Protocol/releases/tags/v0.3.1)，
  [完整包](https://github.com/sganggs/Stronghold-Protocol/releases/download/v0.3.1/Stronghold-Protocol-v0.3.1.zip)。
- 配置机制：[Compose services](https://docs.docker.com/reference/compose-file/services/)、
  [Compose secrets](https://docs.docker.com/reference/compose-file/secrets/)、
  [Caddy HTTPS](https://caddyserver.com/docs/automatic-https)、
  [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。
- 精确镜像清单：`node:24.14.1-bookworm-slim`、`python:3.12.10-slim-bookworm`、`caddy:2.10.2-alpine`
  的 digest 已于 2026-10-21 向 Docker 官方注册表核对，具体值见两个 Dockerfile 与 compose.yaml；
  固定 digest 只表明选择可复现，不表示最新版本、漏洞审计或实际构建已通过。
