# 宿主 Nginx 共存部署

## Context（上下文）

- 用户在 2026-10-21 提供 Ubuntu Server 24.04 LTS、Docker Compose v5.5.0 的实际输出。
- 游戏域名为 `game.hydrate.top`。宿主 Nginx 已占用 80/443，现有站点必须保留。
- `new-api` 发布宿主 3000；另一游戏站点发布 `127.0.0.1:3101`，经 `web.hydrate.top` 访问。
- 本记录包含部署方案及用户回传结果；助手未连接服务器。用户已确认素材、密钥权限修复、容器健康与宿主回环访问通过；公网证书和真实游戏验收尚未确认。

## Fact / Pitfall（事实与坑点）

- 默认 `compose.yaml` 的 Caddy 服务发布 80/443，与现有入口冲突。
- `compose.local.yaml` 是 HTTP 本地验收配置，不适用于当前 HTTPS 域名部署。
- `server/net.js` 优先读取 `CF-Connecting-IP`，再读取 `X-Real-IP` 和转发地址。因此宿主代理除覆盖真实地址头外，还必须移除用户可伪造的 `CF-Connecting-IP`。
- `compose.yaml` 会插值解析未启用服务的环境配置，仍需填写 `ACME_EMAIL`，即使不用内置 Caddy。
- Compose 的服务名显式指定会启用该服务的 profile；不能用 `up app proxy` 代替本方案的启动命令。

## Solution / Convention（部署规约）

1. 用户实测 3102 无监听、磁盘剩余 25 GB、可用内存约 2.7 GiB；域名解析到 `124.222.156.102`，是否与服务器公网地址一致仍由部署者核对。采用 `127.0.0.1:3102:3000`。
2. 在服务器项目根新增 `compose.override.yaml`，给 app 发布上述回环端口，并将 app 连接到既有 `backend` 与 `edge` 两个网络；proxy 设置 `profiles: [bundled-proxy]`。`edge` 是非内部网络，是此宿主端口发布方案需要的出口；app 因此也获得出站网络能力，不能继续描述为仅内部网络隔离。
3. 保留 `SP_AUTH_ORIGIN=https://game.hydrate.top`、`TRUST_PROXY=1`，不启用 HTTP 认证降级。
4. 使用 `docker compose config --quiet` 校验，使用 `docker compose up -d --build app` 启动 app 及素材初始化依赖；不启动 proxy。
5. 只新增 `game.hydrate.top` 的 Nginx 配置；不覆盖旧站点，不停止 Nginx、不释放 80/443。
6. 方案假定域名直接指向宿主；新增 CDN 或其他代理前必须重新核对信任链。宿主入口覆盖 `X-Real-IP`、`X-Forwarded-For`、`X-Forwarded-Proto`，移除 `CF-Connecting-IP`，转发 WebSocket 升级头。
7. 先启用新域名的 HTTP 验证目录，再用 Certbot webroot 申请独立域名证书，最后启用 HTTPS；旧域名证书是否覆盖新域名未知，不能直接复用。
8. 使用编辑器编写文件；每次修改 Nginx 后先执行 `nginx -t`，成功才 reload。证书成功续期后的 deploy hook 同样先校验再 reload。
9. 不执行全局清理，不停止旧容器，不使用 `docker compose down -v`；账号、素材和配置必须保留。
10. 既有 app 的 3 GiB 内存上限不是服务器剩余资源或并发容量的证明；与旧服务共用宿主仍需核对实际余量。

## 素材下载断开与显式本地包导入

### Context（上下文）

- 用户已用浅克隆取得部署提交 `8b0bff0`，随后提供素材服务下载阶段的 `http.client.RemoteDisconnected`。
- 同一组输出中 app 为 Created，素材服务为 Up；历史错误日志不代表当前容器已经退出，不能凭此宣称下载已恢复或服务已失败退出。

### Fact / Pitfall（事实与坑点）

- 异常发生在读取 HTTP 响应时；不足以断言是 GitHub 服务、网络中间设备或某个代理关闭了连接。
- app 依赖素材服务成功退出，故素材尚未就绪时回环健康检查连接失败不能单独归因于应用或 Nginx。
- `init-assets.py` 已支持显式 `--archive`，无需新增下载重试代码或跳过哈希检查。
- 镜像入口固定为 Python 初始化器，默认命令才携带 `--root /srv/assets`。Compose run 传入参数会替换默认命令，导入时必须同时传入 `--root` 与 `--archive`。

### Solution / Convention（解决步骤）

1. 若切换到本地包导入，先只停止 `assets-init`，避免多个初始化器争用素材锁；不停止其他项目服务。
2. 使用宿主 curl 下载锁定发布包，保存到 `deploy/downloads/Stronghold-Protocol-v0.3.1.zip`；可通过 `--continue-at -` 在维护者再次手动执行时续传，不增加自动重试循环。
3. 下载目录设 0755、公开发布 ZIP 设 0644，让容器内 1000:1000 用户可读。不能将这些权限套用到密钥目录或私有状态。
4. 只读挂载该目录到 `/input`，执行 `docker compose run --rm --no-deps --volume "$PWD/deploy/downloads:/input:ro" assets-init --root /srv/assets --archive /input/Stronghold-Protocol-v0.3.1.zip`。
5. 初始化器仍校验完整长度、SHA-256、压缩包路径及素材引用，成功后原子发布到同一命名卷。
6. 仅在导入成功后执行 `docker compose up -d app`；普通素材服务会验证并复用完整卷，不需要重新构建镜像。
7. 用户随后实际完成本地 ZIP 哈希核对与导入，输出 `reused: false`、30944 个引用；普通素材服务随后 `reused: true` 并 Exited (0)，证明本次素材准备和复用已通过。不能扩展为应用、TLS 或对局验收通过。

### 已解决：认证秘密文件读取权限

- 用户最新输出中 app 因 `AUTH_CONFIG / SP_ENTRY_TOKEN_FILE` 重启，调用栈位于 `server/auth/config.js` 的 `fileSecret`。
- 该函数会将文件元信息、打开、读取或 UTF-8 解码异常统一转换为配置错误；仅凭日志不能断言一定是所有者或权限问题。
- 先停止 app 重启循环；用 Docker inspect 查看实际用户和挂载源，再用同一服务配置的一次性 stat 命令检查 `/run/secrets/entry_token` 与 `/run/secrets/session_secret` 的类型、数字所有者、权限和大小。
- 元信息检查不得输出密钥正文，不应为排查而重新生成秘密、重新下载素材、放宽到公开可读或关闭认证。
- 既定部署契约为 app 1000:1000、秘密普通文件 1000:1000 且 0400；生成器每个文件写入 64 个 ASCII 字节。真实修复须以服务器元信息为依据。
- 用户后续实际检查确认：app 为 `1000:1000`，两份密钥在容器内均为普通文件、`uid=0 gid=0 mode=400 size=64`。绑定源是项目 `deploy/secrets/entry-token` 与 `deploy/secrets/session-secret`，已确认所有者与读取权限不匹配。
- 修复只需将这两个已确认的宿主文件改为 `1000:1000`，保留 0400 及密钥内容；不修改整个部署目录，不重新生成秘密。
- 为取得新的启动日志，可只重建 app 容器，保留所有命名卷并跳过已就绪的素材依赖：`docker compose up -d --no-deps --force-recreate --wait --wait-timeout 120 app`。这是等待健康状态的命令期限，不是容量或业务启动时延保证。
- 用户实际修改两份文件的所有者后，元信息为 `1000:1000 / 0400 / 64 字节`，app 6.1 秒内被 Compose 标记 Healthy。此处认证文件读取阻塞已解除；不代表宿主端口、公网入口或业务验收通过。

### 已解决：宿主 3102 未发布

- 同次输出中 `docker compose ps -a` 的 app PORTS 仅显示 `3000/tcp`，而宿主 curl 到 `127.0.0.1:3102` 连接失败；当前容器缺少预期的宿主端口发布，不能归因于证书或 SQLite 提示。
- 镜像的健康检查从容器内部访问 3000，Healthy 不证明宿主 3102 已映射。Dockerfile 的 EXPOSE 也不等于宿主发布。
- 用户随后截图确认覆盖文件原本就有正确的回环发布配置、HTTPS Origin 和 proxy profile；显式加载两份文件并重建 app 后仍仅显示 `3000/tcp`，port 子命令报 `invalid IP:0`。不能继续将问题断言为覆盖文件缺失或遗漏 ports。
- 重新核对基础配置发现 app 仅连接 `backend`，该网络设置 `internal: true`。此前给出的宿主 Nginx 方案只增加 ports，遗漏了非内部网络；这是此前部署指导的实际缺陷。
- 已核对 Docker Moby v28.0.0 的 `libnetwork/endpoint.go`：内部网络跳过 `ProgramExternalConnectivity`；`libnetwork/drivers/bridge/bridge_linux.go` 中此调用负责建立端口映射。仅内部网络与当前未发布端口的现象一致，但尚未取得服务器 Engine 版本与实际网络 inspect，不能把它写成已完成现场根因验证。
- 下一步用 `docker inspect` 查看 HostConfig.PortBindings 与 NetworkSettings.Ports，并用 `docker network inspect stronghold_backend` 核对 Internal。用编辑器在覆盖文件 app 增加 `networks: [backend, edge]`，使用基础文件已定义的非内部 edge，不改 backend 属性、不影响其他项目网络。出站联网能力随该变更启用，宿主入站仍限制为回环。
- 修改后只重建 app，不重建镜像、不重新下载素材、不触动其他站点；启动时显式传入两份配置，以 `docker compose ... port app 3000` 返回 `127.0.0.1:3102` 和宿主健康接口响应作为下一步条件。用户随后回复“完成，结果正确”，确认本次端口与宿主健康检查修复通过；未提供具体 inspect 输出，不追加未知的 Engine 版本等现场事实。

## 当前后续：域名 HTTPS 入口

- 仅操作独立的 `/etc/nginx/sites-available/game.hydrate.top` 与对应启用链接；使用 root 编辑，不覆盖已有其他域名配置、不停止 Nginx。
- 证书尚未确认存在时先提供 HTTP 验证目录和临时 503，不能先引用不存在的证书后再 reload；Certbot 使用 webroot，避免 standalone 抢占 80 或插件修改已有站点。
- 证书取得成功后才配置 HTTPS，代理到 `127.0.0.1:3102`，显式使用 HTTP/1.1、Upgrade 与独立命名的 Connection 映射，保留 HTTP 验证目录供续期使用。
- 此方案假定 DNS 直接指向宿主。真实地址头覆盖与 CF-Connecting-IP 清空仍不可省略；启用 CDN 需要重新核对客户端地址信任链。
- 单独配置 Certbot 的 Nginx 校验与 reload 部署钩子，避免证书文件更新后 Nginx 仍提供旧证书。既有 Certbot 安装和定时器优先复用，不并行安装多套 Certbot。
- 用户随后回复“好了”并询问获取准入令牌，表示已完成上述入口配置；未回传证书续期与真实房间输出，不将其扩展为全流程验收通过。
- 已有准入令牌位于 `/opt/stronghold-protocol/deploy/secrets/entry-token`，由维护者在服务器私有终端读取后输入网页或通过私密渠道分发。`session-secret` 是会话签名秘密，不是准入令牌，不应提供给玩家。获取令牌不需要重新生成秘密或重启服务；不得将真实令牌写入本记忆、提交或排障截图。

## 普通用户上传素材时权限被拒绝

### Context（上下文）

- 用户上传截图的终端身份是 `ubuntu`，目标位于 `/opt/stronghold-protocol/deploy/downloads`，传输错误为远端打开文件 `Permission denied`。
- 前面的部署步骤由 root 创建目录并设为 0755；该权限不允许其他普通用户向目录写入文件。旧 ZIP 也可能由 root 创建，实际所有者仍可用 `ls -ld` 核对。

### Solution / Convention（解决规约）

1. 不建议将项目目录递归改为普通用户所有，也不使用 0777 或开放 root 远程登录来处理上传。
2. 让维护者执行 `printf` 查看当前 `$HOME`，在文件管理器中上传到这个用户自己的主目录；不要凭用户名硬编码私有主目录。
3. 确认旧 curl 已停止、完整包上传结束后，在终端使用 `sudo install -o root -g root -m 0644 -- "$HOME/Stronghold-Protocol-v0.3.1.zip" /opt/stronghold-protocol/deploy/downloads/Stronghold-Protocol-v0.3.1.zip`，复制公开素材 ZIP 并覆盖指定的未完成下载。
4. install 操作保留主目录中的原包，不修改项目或密钥目录所有者；验证目标包 SHA-256 后再继续既有本地导入流程。
5. 此处纠正此前直接向 root 管理目录上传的指导遗漏；具体上传会话的身份和目录权限仍以服务器输出为准。

## Reference（溯源）

- 用户提供的 `docker ps`、`ss -lntp`、`nginx -T` 与域名，2026-10-21。
- 项目实现：`compose.yaml`、`compose.local.yaml`、`server/net.js`、`tools/deploy/control.mjs`、`docs/COMPOSE.md`。
- Docker 配置合并：https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/。
- Docker profiles：https://docs.docker.com/compose/how-tos/profiles/。
- Docker 内部网络：https://docs.docker.com/reference/cli/docker/network/create/#network-internal-mode---internal。
- Docker 端口发布实现：https://github.com/moby/moby/blob/v28.0.0/libnetwork/endpoint.go 与 https://github.com/moby/moby/blob/v28.0.0/libnetwork/drivers/bridge/bridge_linux.go。
- Nginx WebSocket：https://nginx.org/en/docs/http/websocket.html。
- Nginx 代理请求头与清空头字段：https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header。
- Certbot webroot 与续期钩子：https://eff-certbot.readthedocs.io/en/stable/using.html。
- Docker Compose 单次运行及命令替换：https://docs.docker.com/reference/cli/docker/compose/run/。
- curl 续传参数：https://curl.se/docs/manpage.html#-C。
- Python 异常定义：https://docs.python.org/3.12/library/http.client.html#http.client.RemoteDisconnected。
- GNU install 的复制、所有者与权限参数：https://www.gnu.org/software/coreutils/manual/html_node/install-invocation.html。
