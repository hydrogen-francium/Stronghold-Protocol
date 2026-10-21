# Compose、固定素材版本与维护排空

## Context（上下文）

2026-10-21 继续执行 Claude 主计划 P6；源码仓库 `D:\卫\Stronghold-Protocol-source`，不改运行副本。
用户要求直接推进、不要阶段性停顿，也不要以清零历史测试代替功能实施。本机有 Node 24.14.1、Python 3.12，
没有 Docker 命令；不安装系统组件、不连接真实服务器、不提交或推送。

## Fact / Pitfall（事实与边界）

- `compose.yaml` 使用独立 assets-init、单个 app 和 Caddy；只发布 80/443。app 内部网络、精确 HTTPS Origin、
  两份独立 file secret、非 root 和只读根文件系统；素材只读，账号/插件/哈希缓存/TLS 独立卷。
  `compose.local.yaml` 只开放 127.0.0.1:3000，允许 loopback HTTP 并关闭代理信任，不关闭认证。
- `shared/asset-release.json` 固定上游 v0.3.1 URL、845522197 字节及 SHA-256
  `d2f48f7fd2698f330b86c897d93ada2d7066825593cce4de8add46dfa68c3db1`。
  应用 Node 24.14.1、初始化 Python 3.12.10、Caddy 2.10.2 镜像均固定完整 digest，已向官方注册表核对存在；
  不是“最新/无漏洞/实际构建通过”的承诺。
- `tools/deploy/init-assets.py` 必须用 `python -I`；正式初始化需 POSIX 文件锁。下载包不在脚本目录，
  完整大小/哈希核验后只解压素材、字体和三份清单；拒绝越界、链接、大小写冲突及异常展开。
  锁互斥、临时目录、引用闭包、完成标记和目录原子更名组成正式就绪条件。已完成版本校验后复用，不重新下载。
- 引用闭包使用待处理栈和已访问集合，不能在每个文件上反复计算整个引用集合之差，否则数万文件会变成平方级开销。
  正常失败只清理本次临时目录；强杀/掉电残留由维护者核查，不自动清空素材卷或旧版本。
- `SP_ASSET_BUNDLE_DIR` 是显式素材版本根，不是整个 app/data 根。`assetBundleFrom()` 检查完成标记及三份清单摘要；
  static/manifest views/插件原生美术授权识别使用该素材根，内容规则、HTML、脚本及其他生成数据仍来自源码镜像。
  不能挂空卷遮蔽整个 public/data，也不能修改生成 JSON 来硬编码运行路径。
- `SP_DRAIN_FILE` 只接受私有状态目录的固定 `draining`；检查器进入 Lobby，维护期间拒绝 room.create/join/start，
  包括直接 startMatch 调用。已有连接、游戏意图、恢复及离开不被该门禁关闭。登录健康页新增 draining 状态；
  未新增公开管理 API，也未接通额外 UI 推送维护横幅。
- `tools/deploy/control.mjs` 提供 secrets/drain/resume：生成强秘密并拒绝覆盖，维护标记持久化，不添加自动重试或游客回退。
  Compose file secrets 的宿主权限必须真实允许 UID 1000 读取，不能依赖 uid/mode 声明自动重写绑定文件权限。
- 日志、临时空间、容器内存/进程及现有压缩内存缓存有界；普通命名卷没有硬磁盘配额，宿主配额/监控仍需落实。
  排空不保存内存 Match；现有进程首个 SIGTERM 关闭房间/socket，五秒强制退出边界未改变。

## Solution / Convention（执行与验证）

正式操作、配置、私有备份/离线恢复、迁移和升级入口统一在 `docs/COMPOSE.md`。旧 DEPLOY 中的
FETCH_ASSETS 构建期下载、node:22-alpine、MAX_SEATS=4/协议1 等失效描述已修正；历史上游规则不按 fork 改写。

实际本地验证：

```text
node --test --test-reporter=spec test/deploy.test.js test/static-local-art.test.js
python -I tools/deploy/test-init-assets.py
npx eslint server/index.js server/http/assetBundle.js server/http/drain.js server/http/static.js server/http/websocket.js server/plugins/registry.js server/lobby.js shared/constants.js tools/deploy/control.mjs test/deploy.test.js
python -I tools/deploy/init-assets.py --inspect-release
node --test --test-reporter=spec test/asset-index.test.js test/docs-consistency.test.js test/docs-paths.test.js
```

- Node 7/7，Python 5/5；ESLint 零错误、两个原有 Lobby 警告。
- 最后一次素材哈希路由与文档一致性/路径组合 47/47（其中素材 15、文档 32），定向 git diff --check 退出 0。
- 第一次 Node 运行 6/7，新增维护夹具漏了必填 difficulty；按已存在协议补 NORMAL 后第二次 7/7。
  没有增加生产兼容默认值或扩大超时。
- 实际远程 Range 检查 40444 条 ZIP 目录；白名单 32899 条、声明展开 1115474197 字节、顶层 30944 条引用均在包内，
  并读取三份清单与字体样式。没有整包下载/复算 SHA-256，也没有逐个读完全部嵌套素材。
- 这些夹具不证明 Linux flock 并发/中断恢复、Docker 卷权限、镜像构建、TLS/WS、账号重启或恢复已通过。
  维护测试覆盖保持连接、健康查询与离开，未模拟真实进行中十六人战斗排空。
- `.github/workflows/ci.yml` 新 compose job 可做 Linux 配置/构建/Caddy 校验，但本次未运行远端 CI，
  也不在普通 CI 自动拉取完整素材包。实际冷启动与 4c4g/流量测量仍是开放验收项。

## Reference（溯源）

- 需求：`C:\Users\26656\.claude\plans\iridescent-brewing-raccoon.md` §P6 与冷启动验收。
- 本地实现：`Dockerfile`、`deploy/assets.Dockerfile`、`compose.yaml`、`compose.local.yaml`、`deploy/Caddyfile`、
  `shared/asset-release.json`、`tools/deploy/`、`server/http/assetBundle.js`、`server/http/drain.js`、`server/lobby.js`。
- 发布信息：https://api.github.com/repos/sganggs/Stronghold-Protocol/releases/tags/v0.3.1。
- 官方注册表：https://registry-1.docker.io/v2/library/node/manifests/24.14.1-bookworm-slim，
  同接口 library/python 的 3.12.10-slim-bookworm 与 library/caddy 的 2.10.2-alpine；核对日期 2026-10-21。
- 配置机制及更多来源见 `docs/COMPOSE.md` 来源段；账号备份实现 `server/auth/admin.js`，停止边界 `server/http/boot.js`。
