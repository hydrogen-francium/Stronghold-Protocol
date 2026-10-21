# 部署指南

本 fork 的目标是单实例长期开服；Windows / macOS / Linux 的原有安装、素材和插件运维说明保留在下方。
**必须先配置本 fork 的账号认证（§0.1）**，不能直接照上游免配置启动。所有命令均为供服主另行操作的说明，
在项目根目录执行。最新 Compose 实施及本地定向验证见 [COMPOSE.md](COMPOSE.md)；未执行真实容器部署，
下方保留的上游测量或历史验证不能代替当前 fork 的生产验收。
完整契约见 [AUTH.md](AUTH.md)，账号/Admission 是本 fork 有意定制，不是上游 0.3.1 发布功能。
上游 Releases 整合包或上游 `git clone` 不包含这些定制，不要把它们覆盖到本 fork 后仍当成同一服务。

## 0. 资源需求

下表保留上游的资源与流量测量，不是本 fork 最新认证集成或全服 16 真人负载的实测结果。

| 项目 | 说明 |
|---|---|
| 服务器 CPU | 战斗在各玩家浏览器里模拟（DESIGN §14），服务器只负责回合、经济和校验：**每个房间每个作战回合约 1 ms CPU**。AI 队友 / 掉线玩家的战场由服务器模拟：作战开始时 3 个 AI 战场在开发机上约 0.2–0.5 s CPU，小主机上可能要几秒（分成 8 ms 小片执行，不会卡住其他房间）。`SP_VERIFY=all` 会复算每个真人战场，CPU 明显增加，小主机建议保持 `off` 或 `sample`。AI 布阵的试算也会消耗 CPU；原版房间可设 `SP_BOT_REHEARSAL=host`，让房主浏览器代算（见下面）。 |
| 服务器内存 | 空闲约 100 MB，每个进行中的对局再增加几 MB。 |
| 网络 | 4 人对局中服务器每回合下行约 0.25 MB（DESIGN §14 实测；0.2.6 起 1 KB 以上的 WebSocket 消息用 permessage-deflate 压缩，实测一局单人对局的服务器消息从 173 KB 降到 60 KB，约为原来的三分之一）。首次进入游戏时浏览器要从主机下载所需的图片 / Spine 模型 / 音频（按需加载，之后走浏览器缓存），公网隧道带宽小时第一次会慢一些。0.2.6 起服务器启动后在后台给素材算内容哈希（第一次约 1–20 秒，看机器和硬盘；之后只检查大小和修改时间），下发的素材清单里每个地址带上哈希：浏览器把图片、模型和音频缓存一年，服务器更新、重新解压或 Docker 重建之后，玩家只重新下载内容真的变了的文件。哈希存在 `.cache/asset-hashes.json`，删掉会重新计算；目录不可写（例如只读的容器）时只在内存里算。 |
| 磁盘 | 素材约 720 MB（`public/assets`，含中文约 65 MB、日文约 85 MB、英文约 71 MB、韩文约 80 MB、本土语言约 18 MB 的干员语音）+ 依赖约 125 MB（`node_modules`；整合包只带运行依赖，约 65 MB）；可选的本地提取约 40 MB（`.venv-extract`）+ 约 330 MB（贴图、各战场官方场景和官方战斗特效，见第 6 节）。完整包解压后约 1.16 GB。 |
| 玩家设备 | 支持 WebGL 的现代浏览器（Chrome / Edge / Firefox / Safari 最新版），电脑或手机平板（横屏）。老旧设备可在设置里调低画质或访问 `/?board=2d`。 |

**持久化边界：**长期账号及 HTTP 会话哈希保存在私有 `<SP_STATE_DIR>/auth.sqlite`，默认状态目录为项目根目录的
`var/`。房间、对局、游戏 Session/reconnect token 和中央 Admission 仅在内存中；重启即结束所有模拟，账号仍在
不等于可重启续局或启用云战绩。认证 fork 的断线保留为 **10 分钟，含独立模拟**，不是上游 solo 的 24 小时。
自己安装/制作的插件、`plugins/config.json`、工作台钥匙仍在 `plugins/`，和账号状态分开备份。

### 0.1 本 fork 必需的认证配置（所有启动方式都适用）

运行环境以 `package.json` 为准：Node **`^22.16.0 || >=24.0.0`**，使用原生 `node:sqlite`，不是任意 Node 22。
`startServer()` 在监听前校验配置；缺少 Origin/密钥或配置非法就以 `AUTH_CONFIG` 拒绝启动，没有游客/弱密钥生产回退。
应用**不自动加载 `.env`**，必须让实际 Node 进程继承环境。内部 `authEnv` 和组件的 null-auth 兼容不是免认证开关。

| 变量 | 要求 |
|---|---|
| `SP_AUTH_ORIGIN` | 必需，浏览器访问的精确 Origin，例如 `https://game.example.com`；无尾斜杠、路径、查询或片段。不是从 Host / 代理头自动推导。 |
| `SP_ENTRY_TOKEN` 或 `SP_ENTRY_TOKEN_FILE` | 必需且二选一；准入共享口令，只给受邀玩家，在登录页提交，不放 URL。 |
| `SP_SESSION_SECRET` 或 `SP_SESSION_SECRET_FILE` | 必需且二选一；独立的服务端秘密，不得与准入口令相同，不给玩家。 |
| `SP_STATE_DIR` | 绝对、私有、服务用户可写目录，默认 `<项目根>/var`；保存 `auth.sqlite` 及 WAL/SHM。 |
| `SP_AUTH_ALLOW_HTTP` | 默认 `false`；仅接受 `1` / `true` / `0` / `false`。只给 `localhost` / `127.0.0.1` / `[::1]` 的 HTTP 本机开发放行，**不允许局域网、VPN 或公网 HTTP**。 |
| `SP_REGISTRATION_OPEN` | 默认 `true`，同上严格布尔值；设为 `false` 只关注册，已有账号仍可登录。 |
| `SP_BOT_LIMIT` | 全服独立 AI 预算，默认 16，整数 0–256；0 表示不能开含 AI 席位的对局。 |

两份秘密各为 32–512 UTF-8 字节，无首尾空白、控制字符，必须不同。`_FILE` 需要私有绝对路径的普通非符号链接
文件，允许去掉末尾一个 LF/CRLF。文件/状态目录不得落在任何静态服务根下（包括 `public`、`data`、`shared`、
`server/sim`、`packs`、`plugins` 或自定义根），不能进入源码归档、镜像上下文、日志、诊断或公开挂载。
轮换任一秘密会使旧准入授权/游戏访问失效，但不删除账号。

先在操作系统/秘密管理工具中准备互不相同的随机秘密文件并限制权限，再把它们的**路径**交给进程。
下面只说明变量名和启动关系；路径/域名是占位示例，文件不会由应用示例自动创建，也没有示例口令：

```powershell
# Windows：先准备这些私有目录/文件和服务用户 ACL；替换域名/绝对路径
$env:HOST = '127.0.0.1'
$env:PORT = '3000'
$env:SP_AUTH_ORIGIN = 'https://game.example.com'
$env:SP_STATE_DIR = 'C:\Stronghold-private\state'
$env:SP_ENTRY_TOKEN_FILE = 'C:\Stronghold-private\secrets\entry-token'
$env:SP_SESSION_SECRET_FILE = 'C:\Stronghold-private\secrets\session-secret'
$env:SP_STUDIO = 'off'
node server/index.js
```

```sh
# POSIX：私有文件已由部署者准备；反向代理提供下面的 HTTPS Origin
export HOST=127.0.0.1 PORT=3000
export SP_AUTH_ORIGIN=https://game.example.com
export SP_STATE_DIR=/var/lib/stronghold
export SP_ENTRY_TOKEN_FILE=/etc/stronghold/entry-token
export SP_SESSION_SECRET_FILE=/etc/stronghold/session-secret
export SP_STUDIO=off
node server/index.js
```

若继承过对应 inline 秘密，使用 `_FILE` 前先移除，不能同时设置两种形式。以上 `HOST=127.0.0.1` 的 HTTP 仅是代理
后端；玩家必须使用配置的 HTTPS 地址。仅在本机开发时可改成精确 `SP_AUTH_ORIGIN=http://127.0.0.1:3000` 并设
`SP_AUTH_ALLOW_HTTP=true`，浏览器也须使用同一地址；这不会放行 `http://192.168.*` / `100.*` 等来源。

新建 POSIX 状态目录为 `0700`，数据库及普通 WAL/SHM 为 `0600`；既有父目录不会自动修复。**Windows ACL 不会被
应用修改**，请服主自行保护状态、秘密及备份并给予实际服务身份所需权限。数据库只存 scrypt 密码记录和
HTTP-session/CSRF 哈希，不存明文密码/会话凭证，不是战绩数据库。

**人数与部署边界：**只能运行一个权威应用实例，不要开 cluster / PM2 多实例 / 多副本负载均衡；共享 SQLite
或粘滞连接不会共享内存 Admission。全服按实际开局 roster 的唯一参战 `accountId` 预留 **16 真人**，不是登录数、
房间容量、IP 或 socket 数；AI 另有默认 16 预算。大厅等待/观战不占，暂断（含 solo）、被淘汰仍保留或 AI 托管
不提前释放；真实永久离场成功确认或原局结束/失败/销毁清理才幂等释放。当前为 **`MAX_SEATS=16`、协议 2**，
房间容量为 4/8/16；超过四人的个人库存/机变、重复策略及大报告接管已本地实施，真实多人组合验收另行进行。
认证版 Compose、素材初始化与排空入口见 [COMPOSE.md](COMPOSE.md)，不能把配置已写好算作容器部署已通过。

**工作台默认关闭。**确需启用时显式设 `SP_STUDIO=lan`、`local` 或 `loopback`；仍须满足原有 peer/所有转发地址、
Host（及 `SP_STUDIO_HOSTS`）限制和写入 owner key (`X-SP-Studio`)。账号登录不是工作台所有权，额外 Host 白名单
也不能取消地址门禁。公网生产建议保持关闭；§8 的控制台同样受此约束。

### 0.2 账号维护与备份

实际 CLI 为 `server/auth/admin.js`（本地维护，不开 HTTP，不加载 env）；`<...>` 为待替换参数：

```text
node server/auth/admin.js --help
node server/auth/admin.js disable --db <existing-auth.sqlite> --username <username>
node server/auth/admin.js enable --db <existing-auth.sqlite> --username <username>
node server/auth/admin.js reset-password --db <existing-auth.sqlite> --username <username>
node server/auth/admin.js backup --db <existing-auth.sqlite> --output <new-backup-file>
```

数据库须已初始化、非空、普通非符号链接且为支持的 schema 1；拼错路径不会建库。密码重置只从**非交互 UTF-8
标准输入**读取新密码，不是终端提示，不支持密码参数/环境变量；末尾一处 LF/CRLF 会移除，有大小/等待时限。
请用可信本机秘密工具供给，不要把密码写进命令历史。禁用/重置会提高凭证版本并撤销该账号 HTTP 会话；启用
不会恢复旧会话。在线维护后的 socket 在下次 fresh 验证失效，不依赖旧账号缓存。

`backup` 使用 SQLite 在线一致性备份（含已提交 WAL），独占新输出文件、绝不覆盖已有目标。**不能只复制运行中
`auth.sqlite` 主文件**而漏掉 WAL；备份同样私有。升级/迁移前保存一致备份及独立秘密配置，停服恢复与可用性需
另行验证。账号备份不能恢复正在进行的房间，也不包含玩家浏览器里的头像、调配、皮肤、战绩或插件本机数据。

### 0.3 本次验证状态

只有六个基础 auth 套件（`passwords`、`store`、`service`、`admin`、`config`、`admission`）有历史 **86/86** 实跑证据。
最新 HTTP/Network/Lobby/worker/前端联调、部署、浏览器流程和文档一致性检查均未在本次执行，不能称为已通过。
下文保留的上游性能/测试实测不证明这个 fork 已完成集成验收。

**房主帮 AI 试算布阵（可选）：**环境变量 `SP_BOT_REHEARSAL` 不设或设为 `server` 时，AI 布阵试算仍在服务器上（默认）。设为 `host` 后，当前房主的浏览器在整备阶段用同源的模块 Worker（`/js/battle/rehearsalWorker.js`，不绘图、不用 `eval`）比较 AI 队友的几种布阵，只把选中的序号发回；服务器直接采用，不再重算。房主掉线、换人、报错、答案不合法或超时（默认 3 秒）时，服务器用同一批候选自己算。整备先结束则取消试算、保留默认布阵，不延长回合。正式战斗和真人「AI 托管」不受影响。开了玩法插件的房间不走这条路：对局在内容组合自己的进程里，仍由服务器试算，避免浏览器用错数据包或绕过脚本额度。没有可用房主时也不会减少服务器负担。浏览器会多算一些，耗时取决于房主设备和局面。这个接口（任务、答案序号、超时、回退到服务器）以后可以换成本机或外部计算，当前版本不会对外发起网络请求。

## 1. Windows 小主机：一步步

### 1.1 安装与首次启动

本节下载/整合包资料是上游安装参考；运行本 fork 必须使用本 fork 的代码与匹配依赖/素材，不是仅下载上游
0.3.1 zip 就获得账号服务。先完成 §0.1 的私有配置，再考虑启动脚本；资源准备工具不会替你创建认证秘密。

1. 安装符合 `^22.16.0 || >=24.0.0` 的 Node.js 和 Git（在 PowerShell 或「终端」里；整合包不需要 Git）：
   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   ```
   装完**关闭并重新打开**终端，`node -v` 必须满足上述精确范围（22 至少 22.16.0，或 24 及以上；不是只看主版本 22）。没有 winget 时从 <https://nodejs.org/zh-cn/download> 和 <https://git-scm.com/download/win> 下载安装。
2. 将本 fork 的源码及匹配依赖/素材放在固定、短、**不在 OneDrive 同步范围内**的目录，例如 `C:\Stronghold-Protocol`。下面三种是**上游获取方式的参考**，不是认证 fork 的下载地址；不要用上游代码覆盖定制：
   - **完整包（推荐）**：在仓库的 [Releases](https://github.com/sganggs/Stronghold-Protocol/releases) 页面下载最新版本的 `Stronghold-Protocol-v<版本>.zip`（约 800 MB，解压后约 1.16 GB；已含运行依赖、前端库和全部素材，包括中文、日文、英文、韩文和本土语言的干员语音和官方 3D 棋盘、各战场官方场景、官方战斗特效等本地客户端素材），解压后把里面的 `Stronghold-Protocol` 文件夹放到上述位置。不需要 Git，首次启动也不用再下载素材。素材版权归上海鹰角网络 / Yostar，仅限非商业使用，见 [NOTICE.md](../NOTICE.md)。
   - **精简包**：同一页面的 `Stronghold-Protocol-v<版本>-lite.zip`（约 25 MB）。代码、运行依赖和前端库与完整包相同，但不带素材：美术、Spine 模型、音频（含全部干员语音）、字体、表情和「玩法说明」教程图在首次启动时由 setup 从公开镜像下载（约 720 MB，显示进度，可中断续传；镜像设置见下面的「国内镜像下载」）。官方 3D 棋盘等本地客户端素材需要用本机客户端提取，或从同一版本的完整包复制（第 6 节）。适合下载大文件不方便、或想先下一个小包的情况；放置方式同完整包。
   - **源码**：
     ```powershell
     git clone https://github.com/sganggs/Stronghold-Protocol.git C:\Stronghold-Protocol
     ```
3. 先将本 fork 放到固定目录并配置 §0.1，再从**具有这些环境的同一终端**运行 `scripts\start-windows.bat`。它原有的准备流程是：安装依赖（`npm ci`；依赖已含时跳过）→ 复制前端库 → setup 准备素材/可选本机提取 → 启动。资源管理器双击不继承当前 PowerShell 的临时 `$env:`，不能用它替代服务配置；缺项时生产服务应拒绝启动。
4. 玩家只打开与 `SP_AUTH_ORIGIN` 一致的 HTTPS 地址，先经 `/auth/` 准入并注册/登录，再进入游戏。启动脚本打印的 `http://192.168.*:3000` 是原有网络探测信息，不是本 fork 可用的账号入口。仅本机开发可用 §0.1 的 loopback HTTP 例外。关闭前台窗口即停止服务器，并结束内存中的对局。

手动准备仍可用 `npm ci`、`node tools/setup.mjs`；启动是**带必需配置环境**的 `npm start`（即 `node server/index.js`）。这些包装脚本尚不能视为已完成认证部署向导。

**插件需要的官方数据表（0.3.1）：**完整包和精简包都不内置官方 excel 缓存。只有 Forge 导入要推导名单外官方干员，
或 setup（包括启动、更新前的缺项检查）发现已安装插件引用这类干员时，才补齐
`.cache/gamedata/excel/` 的 `character_table.json`、`skill_table.json`、`range_table.json`、
`uniequip_table.json`、`battle_equip_table.json`、`activity_table.json`（约 50 MB，未压缩估算；日志列出本次缺的表、大小与原因）。
来源与语音表相同：Kengxxiao/ArknightsGameData 的 zh_CN 官方数据镜像，原始源 → jsDelivr，沿用下方的源与代理选项。
已有表不再下载，只有 `--refresh-index` 会重新获取；JSON、表结构和大小校验通过才原子写入。
`--check`、`--no-assets` 不下载这些表；新增 `--offline` / `--no-network` 等价于只读 `--check`，整个 setup 不联网。
下载失败或拒绝不会阻断 setup / 导入：导入报告仍写明跳过的干员和原因，缺表的美术 / 特效发现保持原来的回退。
表下载不等于同意提取美术，客户端素材提取仍按第 6 节单独选择。大厅、对局与游戏客户端不会获取这些表。
规则与限制见 [§34.33](history/0.3.1.md#3433-official-tables-for-plugin-operators-outside-the-roster-downloaded-when-needed)（维护者 2026-10-17 决定）。

#### 国内镜像下载

Setup 默认使用「GitHub 原始源 → jsDelivr」，不查询公网 IP，也不请求 gh-proxy.com。GitHub 下载失败时会提示如何手动开启镜像；仅添加提示，不自动切换到第三方代理。

镜像方法是在完整 GitHub 链接前加 `https://gh-proxy.com/`，例如：

```text
https://gh-proxy.com/https://raw.githubusercontent.com/OWNER/REPO/BRANCH/file.png
```

手动开启后顺序为「前缀镜像 → 原始源 → jsDelivr」。索引、图片、Spine、音频和字体都使用此规则（音频 voice 分支跳过 jsDelivr）。镜像是第三方代理；当前只校验格式和大小，没有内容哈希校验，请自行决定是否信任并启用。npm / pip 依赖不使用 GitHub 前缀。

```powershell
node tools/setup.mjs --asset-source=mirror  # 手动优先国内镜像
node tools/setup.mjs --asset-source=direct  # 默认：仅原始源和 jsDelivr，不使用前缀代理
$env:SP_ASSET_SOURCE = 'mirror'             # 也可用环境变量显式启用
```

`node tools/fetch-assets.mjs` 同样支持 `--asset-source=direct|mirror`。命令行优先于 `SP_ASSET_SOURCE`。默认镜像前缀为 `https://gh-proxy.com/`，可通过 `SP_GITHUB_PROXY` 指定其他 HTTPS 前缀；仅配置前缀不会启用镜像。将 `SP_GITHUB_PROXY` 设为空字符串（或全空格）可彻底禁用前缀代理，即使选择了 `mirror` 模式；未设置此变量与显式设空不同，前者使用默认前缀。Windows PowerShell 的某些版本会将空值视为删除变量，可设置 `$env:SP_GITHUB_PROXY = ' '` 或使用 `--asset-source=direct` 来明确禁用。前缀只处理 GitHub 下载链接，不重复添加。

镜像请求每个 URL 只尝试一次，响应头超时 8 秒，响应体有独立的空闲超时，失败即尝试原始源。连续 3 次网络错误、HTTP 错误或无效内容会在本次运行中关闭镜像，后续索引、素材和字体共享该状态；正在进行的镜像请求也会中止并回退。成功会清零连续失败次数；404 / 410 是资源不存在，不触发熔断。再次运行脚本会重新尝试手动启用的镜像。原始源的重试、已有文件跳过和 0.1.1 的清单缩减保护保持不变。

从历史下载记录派生的 Spine 补充贴图也按本次设置重新选择来源，禁用后不会沿用旧代理地址。

### 1.2 防火墙

- 同机 HTTPS 代理配 `HOST=127.0.0.1` 时，不需要让朋友直接连 Node 的 3000 端口；只开放代理实际监听的 HTTPS 入口。Windows 的程序入站提示本身不完成证书、Origin 或账号配置。
- 如果 HTTPS 代理确实监听 443，可由管理员按实际网络配置添加对应规则，例如（不同代理/端口须另配）：
  ```powershell
  netsh advfirewall firewall add rule name="Stronghold HTTPS" dir=in action=allow protocol=TCP localport=443 profile=private,domain
  ```
  原开机自启安装器会为游戏后端端口添加规则，不是本 fork 的 HTTPS 部署向导；须另行审查，不要把后端绑定到公网来迁就它。
- 家里的网络要是「公用网络」，Windows 会拦截入站连接。改成专用（管理员 PowerShell；网卡名用 `Get-NetConnectionProfile` 查看）：
  ```powershell
  Set-NetConnectionProfile -InterfaceAlias "以太网" -NetworkCategory Private
  ```
- `node tools/doctor.mjs` 保留原有规则/网络类型/地址诊断；打印的 HTTP 地址不代表通过本 fork 认证的玩家入口，须使用配置的 HTTPS Origin。
- 本地认证 smoke 统一用 `node tools/ci.mjs --only smoke`：自选空闲 loopback 端口及临时私有状态/随机秘密，真实准入、注册、登录后检查完整 health、实际游戏 HTML/vendor，再调用严格 doctor；结束会清理自有子进程和状态。它不读取真实账号库，不是 Compose、TLS、公网或浏览器验收。
- 自动化服务探针可用 `node tools/doctor.mjs --auth-stdin --port <实际端口> --host 127.0.0.1`。该模式只从有界非交互 stdin 接收 `cookie` JSON 字段（必须恰含三种认证 cookie），不从 argv/env/文件取凭据，不进行客户端/防火墙扫描；401、303、匿名最小 health 或空闲端口均不能算成功。不要把真实 cookie 写进命令、日志或仓库；CI smoke 自行通过管道传递其合成凭据。

### 1.3 固定局域网 IP（推荐）

当路由器转发或另一台机器上的代理依赖后端局域网 IP 时，固定它可避免路由失效；玩家仍收藏配置的 HTTPS Origin，而不是裸 IP/HTTP。可在**路由器**后台的「DHCP 静态分配 / 地址保留」里把小主机的 MAC 地址绑定到固定 IP（如 `192.168.1.50`），或在 Windows「设置 → 网络和 Internet → 属性 → IP 分配 → 编辑」里手动设置（IP、子网掩码、网关、DNS 与路由器一致，且不要与别的设备冲突）。

### 1.4 开机自动在后台运行

**认证集成限制：**当前 `install-service-windows.ps1` 只生成 `NODE_EXE`、`PORT`、`HOST`、`SP_COMBAT`、`SP_VERIFY`，
并以 SYSTEM 任务立即启动；它没有认证参数/私有状态初始化。`run-server.cmd` 会读 `scripts\service.env.cmd`，
但安装器重跑会重写该文件。下面保留原任务管理用法，**不是可直接使用的认证安装步骤**。先停服，在实际任务/
服务启动环境中安全提供 §0.1 的必需变量（只放秘密文件路径，不放秘密值），并处理 SYSTEM/服务身份 ACL；
不要假设用户终端环境或 `.env` 会被任务继承，不要把私有配置写进会被重写/发布的源码文件。未补齐时它会反复
fail-closed 重启。认证部署包装尚待集成验收，推荐优先使用单一低权限服务身份，而不是依赖此历史 SYSTEM 默认。

先关闭前台服务器窗口（否则端口冲突）。原安装器命令（仅在上述启动环境问题已解决后）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1
```

它会：运行一次 `tools/setup.mjs` → 把设置写入 `scripts\service.env.cmd`（node.exe 路径、端口等）→ 注册计划任务 **StrongholdProtocol**（开机 20 秒后以 SYSTEM 身份运行 `scripts\run-server.cmd`，无需登录；服务器退出后 5 秒自动重启）→ 添加防火墙规则 → 立即启动并显示状态。日志在 `logs\server.log`（超过 10 MB 自动轮换）。

| 需求 | 命令（都加在 `powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1` 之后） |
|---|---|
| 换端口 / 其他设置 | `-Port 8080`、`-Verify sample`、`-Combat server`、`-BindHost 127.0.0.1`（只给反向代理用） |
| 公用网络也放行 | `-AllowPublicNetwork`（一般不需要；Tailscale 网卡被识别为公用网络时可能需要） |
| 查看状态和最近日志 | `-Status` |
| 重启（更新代码后） | `-Restart` |
| 停止 | `-Stop`（下次开机仍会自动启动） |
| 卸载 | `-Uninstall`（删除计划任务、防火墙规则和 `service.env.cmd`） |

建议同时关闭睡眠，否则小主机会在无人操作时休眠：`powercfg /change standby-timeout-ac 0`。

<details>
<summary>替代方案：NSSM 的原有服务管理参考（须另供认证环境）</summary>

以下上游命令仅展示服务路径、日志与普通监听配置；`AppEnvironmentExtra` 还须完整提供 §0.1 的 Origin、
私有状态和秘密文件路径，设置服务身份/ACL 后才能启动。只执行下面的 PORT/HOST 行不能运行本 fork。

```powershell
winget install NSSM.NSSM            # 或从 https://nssm.cc 下载
nssm install StrongholdProtocol "C:\Program Files\nodejs\node.exe" server\index.js
nssm set StrongholdProtocol AppDirectory C:\Stronghold-Protocol
nssm set StrongholdProtocol AppEnvironmentExtra PORT=3000 HOST=127.0.0.1
nssm set StrongholdProtocol AppStdout C:\Stronghold-Protocol\logs\server.log
nssm set StrongholdProtocol AppStderr C:\Stronghold-Protocol\logs\server.log
nssm start StrongholdProtocol
```

防火墙规则仍需按 1.2 手动添加。两种方式只选一种。
</details>

### 1.5 更新

本 fork 不能直接套用上游发布包/分支覆盖更新；下方是保留的上游更新工具流程，升级来源须由服主确认仍包含
本 fork 定制。升级前按 §0.2 做一致性账号备份，分别保存私有秘密、插件配置，确认服务身份/环境仍能读取它们。
停止或重启会结束所有内存对局；浏览器本机资料不在账号 DB。自动任务的重装/重启仍受 §1.4 的配置缺口约束。

```powershell
cd C:\Stronghold-Protocol
powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1 -Stop   # 装了开机自启时
git checkout -- data/assets.json    # 素材清单由 setup 重新生成，先还原以免 git pull 冲突
git pull
npm ci
node tools/setup.mjs                # 补下载新增的素材（已有文件会跳过）
powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1 -Restart
```

没装开机自启的话，最后一步改成在具有 §0.1 必需环境的终端重新运行 `scripts\start-windows.bat`，不要假设资源管理器双击会继承临时环境。

#### 用整合包安装的：更新包

0.2.1 起，Releases 里每个版本除了完整包和精简包，还有更新包 `Stronghold-Protocol-v<版本>-update.zip`：只含比说明中列出的旧版本改动过的文件（程序、数据、运行依赖，以及改动过的素材），通常只有几 MB。它用来升级用 0.2.0 及以后的完整包或精简包装好的文件夹（适用的版本写在 Releases 说明里）；全新安装、0.1.x 和 GitHub「Download ZIP」源码包请用完整包或精简包，`git clone` 的用上面的 `git pull`。

```powershell
cd C:\Stronghold-Protocol
powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1 -Stop   # 装了开机自启时；没装就关掉服务器窗口
Expand-Archive -Force <下载目录>\Stronghold-Protocol-v<版本>-update.zip C:\       # 解压到安装文件夹的上一层，合并进 C:\Stronghold-Protocol、覆盖同名文件
powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1 -Restart
```

没装开机自启的，最后一步改成在具有 §0.1 必需环境的终端运行 `scripts\start-windows.bat`。也可以在资源管理器里打开 zip，把其中 `Stronghold-Protocol` 文件夹的全部内容复制到安装文件夹，选「替换目标中的文件」。macOS / Linux：停止服务器后运行 `unzip -o Stronghold-Protocol-v<版本>-update.zip -d <安装文件夹的上一层>`（安装文件夹名为 `Stronghold-Protocol`）；不要用访达拖放，它会把同名文件夹整个替换掉。

启动时（双击启动、`npm start`、开机自启的计划任务、NSSM / systemd 都一样）服务器先完成更新：按 `MANIFEST.json` 核对全部程序文件（代码、数据、运行依赖、前端库和说明文档；素材归 setup 管，不在其中），删除 `UPDATE.json` 列出的、新版本不再使用的旧文件（只删内容与旧版本发布时完全一样的文件：自己改过的文件、自己装的内容包、`logs`、`.cache` 都不会动），再把 `UPDATE.json` 改名为 `.update-applied.json`，然后照常启动，日志里有一行「已更新到 v<版本>」。

- **文件夹不是更新包对应的版本**（例如 0.1.x、只解压了一部分、程序文件被改过）：服务器**不启动**，提示「这个更新包只能覆盖在 v0.2.0 … 的整合包安装上（检测到 N 个文件与 v<版本> 不一致或缺失）」并举出几个文件（开机自启的，`-Status` 显示的日志里能看到）。新旧文件混在一起运行，容易出现看起来像游戏 bug 的错误，所以宁可不启动。下载完整包重新安装，或把更新包重新完整解压一遍再启动（`UPDATE.json` 还在，会重新检查；在此之前什么都不删）。
- 只有说明文档、`scripts\`、`tools\` 里的文件不一致：照常启动，日志里列出是哪些文件。`UPDATE.json` 损坏：跳过并提示，按现有文件启动。
- **精简包装的也能用**：程序部分与完整包完全相同；更新包带着完整包里改动过的素材，其余素材仍由 setup 补齐。如果更新包带来了新的本地客户端素材清单（`data/local-assets.json`）而这台电脑没有对应的素材，启动时会提示：从同一版本的完整包复制 `public/assets/local/`（第 6 节），或运行 `node tools/setup.mjs --local` 提取，不需要时删掉 `data/local-assets.json` 即可。
- 更新包不联网、不会自动更新，和完整包一样从 Releases 手动下载。`npm run doctor` 的「文件校验 MANIFEST.json」一行随时显示全部程序文件是否与这个版本一致（源码目录没有这个文件，不做校验）。

不用更新包也可以：停止服务器，把新版本的整合包解压到新目录后从那里启动（完整包已含素材；装了开机自启的，在新目录重新运行一次 `install-service-windows.ps1`）。用精简包或 GitHub「Download ZIP」源码包的：解压新版本后，把旧目录里的 `public\assets`、`public\fonts`、`.cache` 和 `data\local-assets.json`（若有）复制过去，可避免重新下载（setup 只补下新增的素材）。

## 2. 让不在同一网络的朋友加入

### 2.1 Tailscale / ZeroTier（推荐给家用小主机）

组一个虚拟局域网可以减少公网暴露，但**不能替代本 fork 的 HTTPS、精确 Origin、准入和账号认证**。

- **Tailscale**：主机和朋友安装 <https://tailscale.com/download> 并在 tailnet / 分享策略中授权。选择稳定的 HTTPS 名称，按所用工具的 HTTPS/反代能力接到本机 HTTP 后端，再令 `SP_AUTH_ORIGIN` 与该 HTTPS 地址精确一致。不要直接用 `http://100.x.y.z:3000` 或 HTTP MagicDNS 名称当账号入口。
- **ZeroTier**：在 <https://my.zerotier.com> 创建网络并授权设备；同样需要浏览器可信的 HTTPS 入口，不能直接用虚拟网卡的 HTTP 地址登录。
- VPN 账号不是游戏账号。连通性排错仍检查防火墙/网络类型（1.2），但打开端口不能解除 Origin/认证门禁。

### 2.2 cloudflared 临时隧道（朋友什么都不用装）

```powershell
winget install --id Cloudflare.cloudflared      # macOS: brew install cloudflared
cloudflared tunnel --url http://localhost:3000
```

把输出的 `https://xxxx.trycloudflare.com` 作为本次精确 `SP_AUTH_ORIGIN`，连同其他必需配置启动/重启游戏进程后，
再让朋友访问。页面 HTTPS 会自动使用同源 `wss://`，但**认证 Origin 不是自动配置**；域名更换必须同步修改并
重启，不能沿用旧值或通配放行。隧道到 loopback 的 HTTP 是后端连接，不需要为公网开启 HTTP 例外。
服务器原有 `TRUST_PROXY=auto` 可按可信本机代理的转发地址做限流，但不会据此推导或绕过 Origin。临时隧道每次
地址不同且无可用性保证，长期开服优先稳定的命名隧道/域名；此说明没有验证隧道的实际可用性。

**固定 HTTPS Origin 能保留本机资料与缓存**：浏览器缓存、Cookie、账号作用域的设置/统计/恢复令牌都按 Origin
隔离，账号 ID 相同也不会跨 Origin 搬迁。临时隧道换域名即是新网站，需要重新准入/登录并重新取得素材缓存；
旧头像、调配、皮肤和本机战绩不会因服务器账号还在而自动同步。固定朋友圈子应保持一个稳定 HTTPS 入口和
匹配的 `SP_AUTH_ORIGIN`，而不是绕开门禁另用 IP/HTTP 地址。

### 2.3 路由器端口转发

仅当你有**公网 IPv4**（很多宽带是运营商级 NAT，没有公网 IP，此时请用 2.1 / 2.2）：

1. 先固定主机局域网地址，在 HTTPS 代理上配置可信证书及稳定入口（§2.4）。
2. 只转发该 HTTPS 入口所需端口到代理；游戏 HTTP 后端优先绑定 loopback，不把裸 `:3000` 公开给玩家。
3. 设精确 `SP_AUTH_ORIGIN` 并配置独立秘密/私有状态，再让朋友使用对应 `https://` 地址经准入/账号登录。

本 fork 已有账号系统，不再是「知道地址就能进」。按地址的原有 socket/房间/对局防滥用限制仍在，但与按
真实参战账号的中央 16 真人 Admission 完全不同，也不能替代 HTTPS/认证。只给朋友玩仍优先限制来源或 VPN。

### 2.4 反向代理与 HTTPS（有域名时）

必须部署在**域名根路径**（客户端使用 `/data/`、`/vendor/`、`/ws` 等绝对路径，不支持挂在子路径下）。
代理转发 `/ws` 升级、Cookie、Origin、CSRF 头及响应的 Set-Cookie / CSP / 缓存策略，不要改成另一个浏览器 Origin。
如下面使用 `game.example.com`，就必须配 `SP_AUTH_ORIGIN=https://game.example.com`。应用本身只提供 HTTP，建议
`HOST=127.0.0.1`，只让同机 HTTPS 代理访问；`TRUST_PROXY` 只影响可信来源解析，不决定认证 Origin。

**Caddy**（自动申请 HTTPS 证书，WebSocket 无需额外配置）：

```caddy
game.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**Nginx**：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
server {
    listen 443 ssl http2;   # 新版 Nginx（1.25.1 起）写成 listen 443 ssl; 加一行 http2 on;
    server_name game.example.com;
    ssl_certificate     /etc/letsencrypt/live/game.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/game.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;      # WebSocket 长连接
    }
}
```

**HTTP/2**：客户端由数百个小脚本模块组成（0.2.0 起进入对局时约 340 个），隔着公网时建议让代理以 HTTP/2 提供页面：所有模块走同一条连接，远距离玩家首次进入对局明显更快。Caddy 默认就是 HTTP/2；Nginx 见上面的 `http2`。服务器本身只说 HTTP/1.1，局域网或本机游玩不受影响。HTTP/2 省的是往返等待，不减少字节数。

**压缩**：服务器自己压缩脚本、样式、数据和 Spine 的 `.skel` / `.atlas`：浏览器支持 brotli 时用 brotli（0.2.6 起，质量 5，比 gzip 快且更小：实测 `.skel` 小约 27%、游戏数据 JSON 小约 26%、前端库小约 14%、脚本小约 5%），否则用 gzip；图片和音频本来就是压缩格式，原样发送。浏览器只在 HTTPS 页面（以及 localhost）上声明支持 brotli；本 fork 的非本机玩家本来就须走 HTTPS。代理不需要另开重复压缩（Caddy 的 `encode`、Nginx 的 `gzip` 遇到已经压缩的响应会跳过）。这些历史流量实测不等于最新认证集成验收。

**Cloudflare / 共享代理缓存**：本 fork 的 `privateResponse` 会为认证服务响应强制 `Cache-Control: private` 并
`Vary: Cookie`，认证壳/API 另有 no-store。不要沿用上游「把 `/assets/`、`/fonts/`、`/media/` 强制变为边缘公开
缓存」的规则，不设 Cache Everything / 无视源站私有策略，也不要另开不受认证保护的静态域名。带哈希的素材
仍可在玩家自己的浏览器里按私有策略缓存；内容不可变不代表可绕开账号门禁。代理须保留 Cookie/Set-Cookie、
Vary、CSP 和源站缓存指令。使用第三方媒体分发仍需自行考虑版权及服务条款。

https / wss：浏览器使用精确配置的 HTTPS Origin，客户端自动连接同源 `wss://…/ws`，证书由代理/隧道负责。
只有 §0.1 的显式 loopback HTTP 开发例外才使用 `ws://`。代理与后端同机/可信内网时，`TRUST_PROXY=auto` 沿用
原来源解析；若代理在公网另一台机器上，`TRUST_PROXY=1` 只能在后端端口严格仅对该代理开放时使用。信任代理
头不是任意 Origin 放行；WebSocket 升级先检查准入/账号 Cookie 和精确 Origin，后续仍 fresh 验证。

### 2.5 玩家导入已有素材（需要 HTTPS）

标题画面登录框下面并排有两个按钮：「下载完整素材」从这台服务器下载全部素材（打开窗口就开始）；「导入素材包」读取玩家自己的文件夹或 zip，用来少传重复的美术。打开导入窗口不会向服务器请求任何素材，也不会开始下载；真正开始导入时，浏览器只向服务器读取三份素材清单。

- 只有 **HTTPS** 或 localhost 安全上下文能导入（Service Worker / Cache Storage 的要求）。本 fork 的非本机账号入口必须使用 HTTPS，不能沿用上游「局域网 HTTP 能玩但不能导入」的部署方式。已有素材缓存是设备便利，不提供账号认证或云同步。
- 玩家导入的是自己已经有的文件：维护者另外提供的素材包 `Stronghold-Protocol-v<版本>-assets.zip`（见第 7 节，不在 GitHub Releases 里），setup 得到的 `public/assets`，或完整发布包 zip。校验通过的文件存在这台浏览器里，并且按地址分开：换了域名或端口就要重新导入。整套素材包约 3.1 万个文件，桌面版 Chrome 导入约 1–2 分钟；zip 分段读取，不会整个读进内存。
- 和服务器清单里 SHA-256 一致的文件不再向这台服务器请求。整套美术大约 1 GB（下载的约 720 MB，加本地提取的场景和官方战斗特效）；玩家第一局真正用到的通常约 20–50 MB。导入能省下的，是这些本来会从你的机器发出去的字节。哈希对不上的旧版本文件会被拒绝，仍走下载。
- 导入不经过服务器，服务器日志里看不到这些文件。Service Worker 只回答带内容哈希的 `/assets/`、`/fonts/`、`/media/`。页面、脚本、`/data/`、`/sim/` 和 `/ws` 仍每次走网络。

## 3. Docker 与单实例 Compose

正式配置、空卷素材初始化、秘密文件、权限、备份/恢复、升级排空与验收边界统一见
[COMPOSE.md](COMPOSE.md)。仓库已有 `compose.yaml`、仅 loopback 的 `compose.local.yaml`、Caddy HTTPS 配置及
独立素材初始化镜像；app 不对外发布端口，账号状态、插件、哈希缓存与 TLS 分卷，素材版本根只读挂载。

应用基于精确 `node:24.14.1-bookworm-slim` 及 digest，构建只含生产依赖并生成 vendor；
`FETCH_ASSETS` 构建参数已移除，素材下载/大小/完整 SHA-256/白名单/引用校验失败不会只打 warning 后放行。
账号 CLI 仍使用 §0.2；健康检查仍是匿名最小 `{ok}`，不是认证或多人验收。
`/app/plugin-resources` 只读模板与 `/app/plugins` 可写插件卷分离，Studio 和插件脚本默认关闭。
秘密、旧卷权限与单实例限制不能省略；配置缺失时拒绝启动，不提供游客或弱密码回退。

2026-10-21 本机没有 Docker，故这里只确认代码与配置已实施、定向契约通过；容器构建、真实素材冷启动、
HTTPS/WS、数据库恢复及资源容量仍须在 Linux 执行，不能把新增 CI 配置写成实际 CI 已通过。

## 4. macOS / Linux 常驻

- 临时开服：先按 §0.1 在同一进程环境提供全部认证配置，再运行 `scripts/start.sh`（或 `npm start`）；保持终端打开。macOS 的入站提示不等于完成 HTTPS/账号配置。
- Linux systemd（`/etc/systemd/system/stronghold.service`，路径、域名与用户按实际修改；先创建私有状态/秘密文件，并使 `stronghold` 用户有恰当读写权限，前面部署 HTTPS 代理）：

  ```ini
  [Unit]
  Description=Stronghold Protocol game server
  After=network-online.target
  Wants=network-online.target

  [Service]
  WorkingDirectory=/opt/Stronghold-Protocol
  ExecStart=/usr/bin/node server/index.js
  Environment=PORT=3000 HOST=127.0.0.1
  Environment=SP_AUTH_ORIGIN=https://game.example.com
  Environment=SP_STATE_DIR=/var/lib/stronghold
  Environment=SP_ENTRY_TOKEN_FILE=/etc/stronghold/entry-token
  Environment=SP_SESSION_SECRET_FILE=/etc/stronghold/session-secret
  Environment=SP_STUDIO=off
  Restart=always
  RestartSec=5
  User=stronghold

  [Install]
  WantedBy=multi-user.target
  ```

  配置中的私有目录/秘密文件须另行准备，此 unit 不自动创建；不要把秘密值写进 unit。也可用服务管理器自己的
  私有 `EnvironmentFile` 提供同名变量，但这不是应用自动读取 `.env`。确认没有另一个应用实例后再由服主管理：
  `sudo systemctl daemon-reload && sudo systemctl enable --now stronghold`；日志 `journalctl -u stronghold -f`。
  只对外开放 HTTPS 代理所需端口，不把 loopback `3000` 改成公网裸 HTTP 来绕过配置。

## 5. 排错

| 现象 | 处理 |
|---|---|
| 任何问题 | `node tools/doctor.mjs`：Node 版本、依赖、素材完整性、端口、局域网地址、防火墙、网络类型 |
| `端口已被占用 / EADDRINUSE` | 已经有一个服务器在运行（自启任务？）或其他程序占用 3000：换端口 `scripts\start-windows.bat --port 3001` |
| `AUTH_CONFIG` / 启动即退出 | 核对 §0.1 的必需 Origin、不同的两份秘密、inline/FILE 二选一、绝对私有路径、真实服务环境及 Node 范围；只诊断设置名，不输出秘密。应用不会自动读取 `.env` |
| 准入/登录写入失败、WS 401/4003 | 检查浏览器 Origin 是否精确等于 `SP_AUTH_ORIGIN`、HTTPS/Cookie/CSRF 是否被代理保留，准入/会话是否过期或被维护撤销；回 `/auth/` 重新验证，不通过关闭门禁解决 |
| `INVALID_RECONNECT` | 显式恢复令牌为空、未知、过期或不属于当前账号；不会创建游客，也不会自动清除令牌。确认账号后选「重新恢复当前账号」，不要把别人令牌或昵称当登录凭证 |
| `SESSION_IN_USE` / 4001 | 普通 `noReplace:true` 不替换在线页面；只有确认后使用专门的「接管此账号」才会断开旧页，不开自动抢占重试 |
| `SERVER_FULL` / `ACCOUNT_BUSY` | 中央实际参战 roster 达到真人/AI 预算，或账号已在另一场模拟；不是 IP/socket/房间容量统计。断线、被淘汰仍保留、AI 托管不立刻释放，须真实永久离场确认或原局清理 |
| 工作台/测试控制台打不开 | fork 默认关闭；确需时显式 `SP_STUDIO=lan`、`local` 或 `loopback`，仍检查原地址、全部转发地址、Host 和 owner key，账号登录不能代替所有权 |
| 朋友打不开页面 | 检查稳定 HTTPS 入口、精确 Origin 与代理/防火墙（§2），不要让玩家改用未配置的 LAN/HTTP 地址；访客 Wi-Fi 可能有 AP 隔离，VPN 也不取消 HTTPS/账号要求 |
| 画面是占位图、没有声音 | 素材没下完：重新运行 `node tools/setup.mjs`（会续传）；缺失明细在 `.cache/assets-report.json`。默认仅原始源和 jsDelivr；可用 `--asset-source=mirror` 手动开启前缀镜像（见上文） |
| 素材下载很慢 / 失败 | 网络问题可随时中断，重新运行会跳过已完成的文件；`node tools/fetch-assets.mjs --concurrency=4` 降低并发。有文件没下载成功时，素材清单 `data/assets.json` 保持不变（脚本列出缺少的条目并以非零状态结束；游戏里缺的图片用占位图，缺的声音不播放），重新运行即可补齐 |
| 表情显示成默认图标、「玩法说明」只有文字要点 | 素材没下载完整：重新运行 `node tools/setup.mjs`（表情和教程图随其他素材一起从公开镜像下载，不需要客户端）；缺失明细在 `.cache/assets-report.json` |
| 本地提取失败 | 游戏照常运行，只是第 6 节表格里的几样换成替代样式。确认客户端已下载全部资源；Python 版本太新导致依赖安装失败时，安装 Python 3.12 后删除 `.venv-extract` 再运行 `node tools/setup.mjs --local` |
| 3D 棋盘没出现 | 需要本地提取的棋盘贴图（`node tools/doctor.mjs` 会显示「3D 棋盘可用」），以及支持 WebGL2 的浏览器。没有客户端的服务器可以从同一版本的整合包复制本地素材（第 6 节） |
| 素材地址里的 `~` 加一串字母数字 | `/assets/~<哈希>/…` 是 0.2.6 起的带版本地址（见第 0 节「网络」），浏览器可以长期缓存，属于正常现象。怀疑它导致问题时，可以用 `SP_ASSET_INDEX=0` 启动服务器临时关闭（清单改回普通地址），并请在 issue 里说明 |
| 想知道开服电脑上传了多少流量 | 先在配置的 HTTPS Origin 完成准入/登录，再打开同源 `/healthz?traffic=1`；认证之外还须通过原有本机/私网地址门禁（按 `clientAddress` / `TRUST_PROXY` 识别），登录不绕过该门禁。符合时，`traffic.http` 是服务器启动以来各类内容（`assets` 图片和模型、`audio` 音频、`code` 页面和脚本、`data` 游戏数据和素材清单）发出的字节数和请求数（压缩后的实际字节，`notModified` 是只回了「没变」的 304），`traffic.ws` 是 WebSocket 的线上字节（`wireOut` / `wireIn`，压缩后）和压缩前的消息字节（`payloadOut` / `payloadIn`）。数字只在内存里，重启后从 0 开始；识别为公网的请求只拿普通认证 health，匿名请求即使带 `traffic=1` 也只有最小 `{ok}`。不要切换到未配置的 localhost/HTTP 地址绕过账号要求。玩家那边：设置 →「问题反馈」复制的诊断里有一行 `traffic:`，是这个页面从打开起下载的字节数（`cached` 是浏览器缓存直接给的，不占流量；`external` 是其他网站，例如 Google 字体） |
| 断线 | 认证 fork 的正常恢复窗为 **10 分钟，含独立模拟**；同账号重新验证后可恢复其保留 Session，在线旧页须显式接管。暂断仍占 Admission；同盟按原阵容自动作战/到时准备，不代买；AI 托管另选。窗口到期发起真实永久离场确认；失败则保守保留名额，原局结束/清理也会释放。账号持久不等于 solo 24 小时、重启续局或云战绩 |

## 6. 本地客户端素材（可选）

`public/assets/local/` 和 `data/local-assets.json` 是从本机安装的《明日方舟》客户端里提取的官方素材（`tools/local-extract`，DESIGN §13）：`node tools/setup.mjs` 检测到客户端时会询问是否提取，之后可以用 `node tools/setup.mjs --local` 重新提取，或用 `--game "<…/StreamingAssets/AB/Windows>"` 指定客户端目录。setup 从公开镜像下载的素材不包含这部分，所以在没有客户端的电脑上（例如 Linux 服务器）用源码或精简包部署时不会有它；Releases 的完整包里已经带上了。

没有本地素材时游戏照常运行，只是下面几样换成替代样式：

| 内容 | 没有本地素材时 |
|---|---|
| 官方 3D 棋盘（贴图、模型、地图特效） | 2D 棋盘，地块由程序绘制 |
| 各战场的官方场景（沙地等 11 个战场；完整包在提取后带上，精简包和源码可在本机下载并提取，见下） | 3D 棋盘用程序生成的金属地块 |
| 部分官方界面图标与底板：交流按钮和表情面板的边框、暂停面板、装备替换窗口、干员调配界面、队友状态与漏怪标记、模组类型图标等 | 样式相近的替代图形、图标或文字 |
| 灼热 / 炽焰源石虫的官方模型 | 染成橙色 / 红橙色的普通源石虫 |
| 39 个召唤物的官方模型（多数自选召唤物，以及凯瑟琳的爬行号·防护单元、凛御银灰的风雪之眼；公开镜像没有） | 召唤物头像（菱形底板） |
| 官方战斗特效（0.3.0「官方特效」：普攻、弹道、命中、状态、阵亡、部署和技能；`extract.py --only fx --fx-set used` 单独提取，约 8800 个文件、磁盘约 190 MB，清单是 `data/local-fx.json`；完整包附带一份，精简包和源码需要本机提取） | 本作自己绘制的特效，设置里不显示「官方特效」 |

表情（6 套 × 6 个）和「玩法说明」的 19 页教程图公开镜像也有：`node tools/setup.mjs` 会和其他素材一起下载（约 21 MB），不需要客户端；有本地素材时优先显示本地的。

**没有客户端的服务器**想要上表中的官方素材：从**同一版本**的完整包（[Releases](https://github.com/sganggs/Stronghold-Protocol/releases)）里，把 `public/assets/local/` 文件夹和 `data/local-assets.json`（还有官方战斗特效的清单 `data/local-fx.json`）复制到服务器项目目录下的相同位置。服务器每次请求都会重新读取这两处，不必重启，玩家刷新页面即可。一定要用与服务器代码相同版本的完整包：各版本提取的内容和清单可能不同（例如灼热 / 炽焰源石虫的模型是 0.1.0 之后才加入的，召唤物模型是 0.2.0 加入的），混用其他版本的文件会缺图或用错图。复制后 `node tools/doctor.mjs` 会显示本地素材的条目数和「3D 棋盘可用」。分组或官方特效清单和这一版对不上时，它会提示已有多少、这一版期望多少。

**分组对不上这一版提取器的**：`node tools/setup.mjs` 对照当前提取器会写出的分组（`tools/local-extract/extract.py --print-jobs` 里的 `expectedGroups`，不需要客户端）。少了分组，或清单写的条目数和分组里列出的不一致，会提示已有多少个分组、多少项，这一版期望多少个分组。缺的不是战场场景时，请用 `node tools/setup.mjs --local` 重新提取。缺的分组如果全是 `scene/`（某个战场，或共用贴图 `scene/tex`），有客户端时改为 `node tools/setup.mjs --scenes`，没有客户端时改为从同一版本的完整包复制 `public/assets/local` 和 `data/local-assets.json`：`--local` 不会下载战场场景。召唤物模型是 0.2.0 新增的提取项（`spine/token/<id>`）；只想补这一项也可以在提取用的 Python 环境里运行 `tools/local-extract/extract.py --only spine/token`（新文件写入 `public/assets/local/spine/token/`，清单里其他条目保持不变）。官方特效清单 `data/local-fx.json` 是另一步，用项目里的 `.venv-extract/bin/python`（Windows 是 `.venv-extract\Scripts\python.exe`）运行 `tools/local-extract/extract.py --only fx --fx-set used`：没有它只记一行「未提取」，不把本地美术算成失败；有了但分组、条目数或版本不对会单独警告。

**各战场的官方场景**（维护者 2026-10-12 起随完整包提供；精简包和源码安装可以在本机下载）：官方棋盘是每个战场一个做好的场景（11 个战场，其中 9 个是沙地）。提取不全（少了某个战场，或少了共用贴图 `scene/tex`）时，setup 不会把它报成已完成，而是提示已有多少个战场、这一版期望多少。分组都在、但每个战场清单里的 `scene` 记录（kind 为 Scene）不是这一版 `--print-jobs` 的 `scenes.version` 时，同样不算完成：有客户端请重新运行 `node tools/setup.mjs --scenes` 一次，没有客户端则从同一版本的完整包复制。`scene.json` 的网格版本不变，旧场景在重新提取前仍能显示。有客户端时请用 `--scenes` 补；没有客户端时改为从完整包复制，不提示 `--scenes`。已经有一部分战场时，直接回车或等待不会从客户端提取，回答「是」也不会；只有 `--scenes` 或 `--yes` 会。分组都在、只是清单里的场景版本旧了时，仍是这一句提问（默认否，回车和等待不提取）。回答「是」会像第一次一样下载并运行 `extract.py --only scene`；回答「否」会记住，之后不再问。场景包只在赛季开放期间随客户端分发，赛季外的客户端里没有。仓库不存放这些官方文件。有客户端的电脑可以 `node tools/setup.mjs --scenes`（询问或强制下载并提取；`--no-scenes` 跳过）。也可以分两步：`python3 tools/local-extract/fetch_scenes.py`（从官方 CDN 下载赛季版本 `26-04-13-12-31-42_e9b560` 的 33 个场景包，共 22,801,308 字节，放进 `.cache/official-scenes/`；`--list` 只看清单不下载），再用提取环境的 Python 运行 `tools/local-extract/extract.py --only scene`（材质和贴图仍取自本机客户端；`--game` 可指定客户端目录）。没有 Python 3.8+，或 UnityPy / lz4 / Pillow 没装好时，setup 只提示并继续，3D 棋盘用金属地块。没有客户端时贴图取不出来，从同一版本的完整包复制 `public/assets/local/` 和 `data/local-assets.json`。作者估计每个场景在进对局时另下载约 2–7 MB，各场景共用贴图约 3 MB；本机没有跑过提取，完整包因此增加的解压体积没有实测。

**3D 棋盘贴图的下载量**：每位玩家进入对局时都要从开服的电脑下载 3D 棋盘的 12 张贴图。提取时会给这 12 张各写一份 WebP（颜色贴图有损、质量 95，法线和数据贴图无损），清单里列的是 WebP，同名 PNG 留在旁边给裁切工具和 setup 用。这部分下载量从约 6.7 MB 降到约 2 MB，网速慢的远程联机最明显。只有 PNG 的本地素材（例如在这一改动之前提取的）可以用提取时的 Python 环境运行 `tools/local-extract/extract.py --webp` 就地补上，只需要 Pillow，不需要客户端。

**「玩法说明」教程图的下载量**（0.2.6 起）：本地提取的 19 页教程图每页 1.2–1.5 MB，玩家每翻一页都要从开服的电脑下载。提取时同样给每页写一份 WebP（有损，质量 90，放大两倍对比看不出差别），清单列 WebP，PNG 留在旁边；19 页合计从约 25.6 MB 降到约 4.2 MB。看说明时只预载下一页（以前前后两页都预载）。已经提取过的同样用 `tools/local-extract/extract.py --webp` 补上。

## 7. 打包发布（维护者）

Releases 的 zip（完整包、精简包，0.2.1 起还有更新包）由 `tools/package.mjs` 生成，在**源码仓库**里运行（整合包里没有这个工具）：

```bash
npm run package -- --dry-run --list   # 只检查：列出每个文件和大小，不写任何文件（精简包加 --lite）
npm run package -- --out <目录>        # 完整包 Stronghold-Protocol-v<版本>.zip
npm run package:lite -- --out <目录>   # 精简包 Stronghold-Protocol-v<版本>-lite.zip
npm run package -- --update --from <旧版本的完整包>[,<…>] --out <目录>   # 更新包 Stronghold-Protocol-v<版本>-update.zip
node tools/package.mjs --assets --out <目录>   # 素材包 Stronghold-Protocol-v<版本>-assets.zip（给「导入素材包」用，不放进 Releases）
```

完整包在打包机已经提取战场场景时带上 `public/assets/local/scene/`（`--dry-run` 摘要里的 `battlefield scenes` 一行）。还没有提取时完整包仍能打，棋盘用金属地块。要带上 11 个官方场景，先运行 `python3 tools/local-extract/fetch_scenes.py`，再用提取环境的 Python 运行 `tools/local-extract/extract.py --only scene`（或 `node tools/setup.mjs --scenes`），然后再 `npm run package`。精简包不带场景。`.cache/official-scenes/` 在拒绝名单里，不会打进任何包。`tools/local-extract/scenes.py` 和 `fetch_scenes.py` 必须先提交：打包读的是 `git ls-files`，未提交的脚本不会进玩家包。

- **打进去的**：`git ls-files` 里的 `server/`、`shared/`、`data/`、`public/`（不含 `public/dev/`）、`packs/`（随仓库提交的内容包；只在本机安装、没提交的不打进去）、`plugins/`（只允许 `README.md`、`AGENTS.md` 与 `_template/`，即使误跟踪服主插件也不打进去；服务器自己放进去的插件不会提交，也不打进去，见 [PLUGINS.md](PLUGINS.md)）、启动脚本、玩家会运行的工具（setup、vendor、fetch-assets 与 `tools/assets/`、doctor，以及 setup 调用的 `tools/local-extract/` 和 `crop-board-atlas.mjs`）、`tools/plugin.mjs`、`schemas/`、插件作者文档（`docs/PLUGINS.md`、`docs/PLUGIN-GUIDE.md`、`docs/PLUGIN-DSL.md`、`docs/PLUGIN-API.md` 与目录示例）、`test/helpers/battleHarness.js`（作者测试使用，只依赖包内的 server/shared）、服务器和 fetch-assets 读取的 4 张研究数据表（`docs/research/` 的 `03-operators`、`05-enemies`、`05-maps`、`07-assets` 四个 JSON）、`package.json` / `package-lock.json`、许可证与说明（`LICENSE`、`NOTICE.md`、`THIRD-PARTY-NOTICES.md`、`README.md`、`CHANGELOG.md`）、`docs/PLAYING.md` 和本文；然后在临时目录里生成 `packs/index.json`（打进去的语言包和内容包的列表，供纯静态托管使用；服务器自己会实时列出，见 [PACKS.md](PACKS.md)），再 `npm ci --omit=dev` 装上运行依赖和 `public/vendor`（含沙箱必需的 SES / Acorn 及其浏览器文件，玩家无需另装）。完整包再加上 `data/assets.json` 列出的素材、`public/fonts`，以及本地提取的 `public/assets/local/` 和 `data/local-assets.json`。磁盘上有、清单却没列出的文件不打进去（例如 0.2.0 移出自选的焰狐龙梓兰的旧素材）。日文干员语音（`audio.voiceJp`，`public/assets/audio/voice/jp/` 的 2674 个文件，约 85 MB，zip 后约 76 MB）默认也打进完整包；`tools/package.mjs` 里的开关 `FULL_ZIP_JP_VOICE` 改成 `false` 时，完整包（以及由它比较出的更新包）不带这些文件：玩家首次启动时 setup 会像精简包那样下载它们，下载完成前选「日本語」会播中文语音，更新包也不会删除玩家已有的日文语音。英语、韩语和本土语言配音（`audio.voiceEn` / `audio.voiceKr` / `audio.voiceNative`）同样默认打进完整包（5712 个文件，约 169 MB，zip 后约 157 MB）；开关是 `FULL_ZIP_OPTIONAL_VOICE`（`tools/package.mjs`，默认 `true`）。改成 `false` 时完整包不带这些文件，玩家首次启动时 setup 再下载，下载完成前缺的那一句播中文，更新包也不会删除玩家已有的这些配音。
- **不打进去的**：`test/` 除上述作者助手外的文件、维护用的工具（数据构建、golden、botbench、i18n、导入检查、本工具等）、`scripts/make-windows-bundle.mjs`（Windows 便携包，见 [WINDOWS.md](WINDOWS.md)）、其他文档、研究笔记和 `docs/img/`、`handoff/`、`.github/`、`types/`、lint / 编辑器 / Docker 配置。和 0.1.x 的整树打包（全部跟踪文件加上 `public/assets` 的全部内容）相比，0.2.0 的完整包少了约 640 个文件、解压后小约 26 MB，zip 小约 8 MB。
- **打包前的检查**（`--dry-run` 也全部做一遍）：拒绝名单（`pv`、`review`、`.cache`、`.claude`、`.git`、`logs`、`.env`、`scripts/service.env.cmd`、`handoff`、`test` 除精确允许的作者助手外、服主自己的插件、`plugins/_dist/` / `_moved/` 等）；每个打进去的模块的相对导入、玩家用的 npm 脚本（start / setup / doctor / launch / postinstall / vendor / assets）都指向包里的文件；完整包里 `data/assets.json` 和 `data/local-assets.json` 列出的文件都在（缺了先运行 `node tools/fetch-assets.mjs`）；没有只差大小写的两个路径；包里的文件（二进制素材也查）不含个人目录路径（`/Users/…`、`C:\Users\…`、`/home/…`）或本机的账户名（运行时从系统读取；`SP_PACKAGE_SCAN_NAMES=a,b` 可以再加名字）；打进去的已跟踪文件没有未提交的改动（重新生成的 `data/assets.json` 要先提交）。有任何问题都会列出原因、以非零状态结束，不写 zip；正式打包时还会核对临时目录里的文件和计划完全一致。
- **玩家包里的脚本和文档链接**：临时目录里的 `package.json` 只留下每条 `node <文件>` 都指向包内文件、并且至少指出一个文件的脚本（`start`、`dev`、`setup`、`doctor`、`launch`、`postinstall`、`vendor`、`assets`）。`test`、`golden`、数据构建、lint、本工具等不留，避免玩家运行 `npm test` 时在没有测试文件的情况下得到「0 个测试、成功退出」。`README.md`、`CHANGELOG.md`、`NOTICE.md`、`THIRD-PARTY-NOTICES.md`、`docs/PLAYING.md`、本文、插件参考和作者指南里，指向包内没有的文件的相对链接改成该版本 GitHub 标签上的同一路径（版本号去掉末尾的 `-dev` 后加 `v`；图片用 `raw`，其余用 `blob`）；`../../releases/latest` 改为仓库的 Releases 地址。源码仓库里的这些文件仍是相对链接。
- **MANIFEST.json**：三种包的根目录都有（`npm ci` 之后写入）：除素材（`public/assets/`、`public/fonts/`、`data/assets.json`、`data/local-assets.json`，归 setup 管）以外每个文件的大小和 sha256，同一版本的三种包内容相同。`npm run doctor` 和更新包的启动检查（`server/update.js`）用它核对安装。
- **更新包**（0.2.1 起，每个版本都发）：`--from` 后面列出**此次支持升级的每个旧版本完整包**（Releases 上的 zip，或它解压出来、没动过的文件夹；逗号分隔或写多个 `--from`），例如发布 0.2.2 时 `--from Stronghold-Protocol-v0.2.0.zip,Stronghold-Protocol-v0.2.1.zip`。工具照常构建完整包的临时目录（`npm ci` 等），逐个文件（大小 + sha256）和每个旧版本比较：和任何一个旧版本不同、或旧版本没有的文件都打进去，所以一个更新包能覆盖在列出的每个版本上；旧版本有、新版本没有的文件记进 `UPDATE.json` 的 `removed`（连同各旧版本里的 sha256，玩家那边只删内容一致的文件；只差大小写的同名文件和 `.env` 之类的本机文件名不删，摘要里会列出）。旧版本必须比当前版本旧、带素材（不能是精简包或更新包）、每个版本只给一次，`--dry-run` 只读取并检查旧版本。更新包里还有新版本的 `MANIFEST.json` 和 `UPDATE.json`（适用的旧版本、文件数、字节数、文件列表和 `removed`），同样经过拒绝名单和个人信息检查；摘要列出和每个旧版本相比改动 / 新增 / 删除的文件数和更新包里各类文件的数量。发布时在 Releases 说明里写明更新包适用的版本（即 `--from` 列出的版本）。0.3.0 至少以 0.2.6 完整包为基线；新增的插件模块、Schemas、作者工具、模板、SES / Acorn 与前端库都会作为新增或改变的文件进入更新包。删除列表以实际基线比较为准，不要凭开发过程里曾出现过的页面名手写。`--keep-stage` 保留更新包目录和完整包的临时目录（`<目录>/Stronghold-Protocol-v<版本>-update/` 里的 `Stronghold-Protocol/` 和 `.full/`）。
- **素材包**（`--assets`，0.3.0 起，可选）：给标题画面「导入素材包」用的范例，只含这个版本导入时能收下的美术——`data/assets.json`、`data/local-assets.json`、`data/local-fx.json` 列出的文件（字体也在其中），按打包机上的语音和官方特效开关取舍，和完整包一致；不含清单本身（浏览器读的是服务器上的清单）、清单没有列出的本地提取残留文件，也不含任何代码。zip 里只有一个文件夹 `Stronghold-Protocol-v<版本>-assets/`，里面是 `public/assets/…`、`public/fonts/…` 和中英文说明 `README.txt`（是什么、对应哪个版本的清单、怎么导入；其他版本的服务器上，内容变了的文件校验不符、不会收下）。每个路径都带 `public/`，导入时整包按同一个前缀识别；说明文件是导入结果里唯一「跳过」的文件。打包前做和完整包相同的检查：清单列出的文件都在、没有只差大小写的路径、个人信息扫描（素材也查）、`data/assets.json` 已提交（`--allow-dirty` 跳过这一项）、开发版本要加 `--allow-dev`；`--dry-run [--list]` 只检查、不写文件。不运行 `npm ci`，也没有 `MANIFEST.json`。素材包要和发布的完整包用同一份素材来打：打包后又重新提取过本地素材（例如官方特效）就要重打，改过的文件在别人的服务器上会校验不符；本地提取的那部分（场景、官方特效等）也只对提供同一份提取结果的服务器（这个版本的完整包）有效，自己从其他客户端版本提取的服务器会拒收这些文件，其余照常导入。0.3.0 的素材包是 30936 个文件、990 MB，zip 约 711 MB。素材包**不附在 GitHub Release 上，也不提交到仓库**：维护者可以把它放到网盘等处另行提供下载；Releases 仍然只有完整包、精简包和更新包。
- **需要**：已下载素材的仓库（完整包）——打包前先联网运行一次 `node tools/fetch-assets.mjs`，补齐清单计划但本机还没有的素材（清单只列出磁盘上有的文件，打包工具看不出缺了哪些；`data/assets.json` 有变化就先提交）；能访问 npm 的网络（`npm ci`）；`zip`（或 bsdtar 的 `tar`，Windows 10 起自带）；更新包还要之前各版本的完整包（工具自己读 zip，不需要 `unzip`；Releases 上可以重新下载）。`--out` 默认是系统临时目录下的 `stronghold-protocol-release`，不能在仓库里面；`--force` 覆盖已有的 zip，`--keep-stage` 保留打包用的目录供检查。

## 8. 插件：服主策略文件（0.3.0 起）

插件放在 `plugins/<id>/`（见 [PLUGINS.md](PLUGINS.md) §2）。房主在房间的「插件」面板里开关：外观插件只换画面和声音，对局仍是原版；**改变玩法的插件**（数据 / DSL，以及显式启用的脚本）让这个房间玩一套自己的内容组合，每位博士的页面都会下载并逐字节校验，对局标为「非官方」，默认不计入统计总览（PLUGINS.md §11）。

房间能用哪些插件由服主决定：在 `plugins/` 里放一个可选的 `config.json`（和服务器自己的插件一样不会提交、不会被更新覆盖）。没有这个文件、且未开启脚本执行时，就是下面的默认值：

```json
{
  "rooms": "host",
  "default": [],
  "allow": ["*"],
  "classes": { "cosmetic": true, "content": true },
  "limits": { "maxSets": 4 },
  "allowIncompatible": false
}
```

| 字段 | 含义 |
|---|---|
| `rooms` | `"host"`：房主自己选插件（默认）；`"fixed"`：每个房间都固定用 `default` 里的插件，房主不能改；`"off"`：房间只玩原版（玩家在「设置」里给自己开的外观插件不受影响，它们不会进房间） |
| `default` | 新房间一开始就开着的插件 id（默认没有：原版） |
| `allow` | 房间可以用的插件：`["*"]` 全部，或列出 id |
| `classes` | 关掉某一类：例如 `{ "content": false }` 只允许外观插件；`classes` 按项覆盖默认值：默认允许 cosmetic/content；开启 sandbox 时再默认允许 script，trusted 模式再默认允许 trusted。其他未列出的类别不允许。ui 只供个人开启，不进房间组合 |
| `limits.maxSets` | 同时运行的「改变玩法」内容组合上限（0–64，默认 4）；超过时房主会看到「本服务器同时运行的插件组合已达上限，请稍后再试」 |
| `allowIncompatible` | 为其他游戏版本制作的改变玩法插件默认不能启用；设成 `true` 时大厅放行（房间里会提示）——但目前内容组合的构建本身仍会拒绝这类插件，所以暂时还开不了（DESIGN §32.6 待办）。外观插件只提示，不拦 |
| `allowDownloadHosts` | 按地址安装时额外允许的主机（字符串数组，默认没有）。一项是主机名（任意端口），或 `主机:端口`，IPv6 写成 `[地址]` 或 `[地址]:端口`。没有通配符。点名的主机才可以不是公网地址、才可以用 443 以外的端口。目录文件自己不能往这份名单里加。这个字段不参与房间策略；写错或文件坏了就当作没有额外主机，公网 https 下载不受影响。也可以用环境变量 `SP_PLUGIN_DOWNLOAD_ALLOW`（逗号分隔），和文件里的名单一起生效 |

- 环境变量 `SP_PLUGINS=off|host|fixed` 优先于文件里的 `rooms`，例如 `SP_PLUGINS=off npm start` 临时让所有房间只玩原版。
- 文件改了不用重启：房主下一次操作时（最多每秒检查一次）按新内容生效。写错的字段保持默认值，并在服务器日志里提示一次（`[plugins] …`）。
- 用了改变玩法插件的房间，对局在单独的子进程里运行（每套内容组合一个，同一组合的房间共用）：开发机实测子进程启动约 0.2 秒，载入数据和对局代码后约占 117 MB 内存（RSS），每个的堆上限 768 MB，最多同时 4 个，空闲 10 分钟后自动结束。子进程卡死（10 秒没有心跳）、崩溃或内存用尽时，只结束这套组合的对局，房间回到大厅并提示原因，服务器和其他房间不受影响。
- `SP_MATCH_HOST=worker` 改用 worker 线程（在服务器进程里运行，不另起 Node 进程）。**公网服务器不要用**：在 Node 22 上实测，worker 线程里一次性的超大分配用尽内存时，会让**整个服务器进程**退出（`FATAL ERROR: … Allocation failed`，退出码 134），原版房间也一起断开；子进程同样的情况只结束子进程。默认就是子进程（DESIGN §32.6）。
- 在配置的 Origin 完成准入/登录后，同源 `/healthz` 的 `content.sets` 是当前在用的改变玩法内容组合数；匿名 health 只有最小 `{ok}`，该数值也不是 Admission 参战名额。
- 按地址安装（[PLUGINS.md](PLUGINS.md) §17）只接受公网 https 的 443 端口，并且必须校验 zip 的 SHA-256；服务器下载后先检查再放入 `plugins/`，不执行包里的任何代码。内网、本机、链路本地和 `.local` 默认拒绝，重定向到这些地址或离开 https 也会拒绝。一次等待包含正文，不是每一跳重新计时。服主要放行某个主机，写在上面的 `allowDownloadHosts` 或 `SP_PLUGIN_DOWNLOAD_ALLOW` 里。
- 有人反馈问题时，诊断信息里的 `content:` 一行写着房间用的内容（`MODDED cs=… plugins=…` 表示开了改变玩法的插件），问题模板也会问「是否开了插件」。插件房间的问题请先找插件作者，并尽量在原版里复现。


### 测试控制台（0.3.1）

须先显式启用 Studio（本 fork 默认关闭，见 §0.1），再从满足原地址/Host 门禁的访问路径打开工作台，使用
启动窗口里的同一把 owner key，点击顶栏「测试控制台」，或访问 `/studio/console.html`。游戏账号登录不提供
工作台所有权；`SP_STUDIO=off` 保持关闭，不新增端口。
场景在服务器校验，战斗在浏览器运行，不创建对局、不记战绩，也不修改普通房间。场景只保存在浏览器，
需长期保存或迁移时下载 JSON。操作见 [插件新手指南](PLUGIN-GUIDE.md#测试控制台)。

战斗沙盒只跑一场战斗，不创建房间。完整对局的测试房间默认关闭。

开启：环境变量 `SP_TEST_MODE=1`，或启动脚本 `scripts/start.sh --test-mode 1`（`scripts\start-windows.bat` 同样）。
不带取值的 `--test-mode` 等同于 `--test-mode 1`。取值 `off` / `1` / `force`。`off` 会去掉继承来的变量。`1`（以及 `true` / `yes` / `on` / `local`）在明确的本机或局域网地址上生效。默认绑定 `::` / `0.0.0.0` 时，看这台机器的网卡：非内部地址都是回环、私网（含 CGNAT `100.64.0.0/10`）、链路本地或 IPv6 ULA 时，按局域网接受 `1`（[ASSUMED] 路由器上的端口转发和写明局域网地址一样，由服主自己负责）。任一公网地址，或监听地址本身是公网，则 `1` 不开启，启动脚本和服务器日志用中文说明：仅本机用 `--host 127.0.0.1`，局域网用 `--host <局域网IP>`，要在公网监听上开则用 `--test-mode force`（或 `SP_TEST_MODE=force`）。`force` 在公网监听上仍会警告。写了认不出的值（例如 `forced`）保持关闭，并在启动时警告。
经公网反代转到本机回环的，仍按公网部署处理：进程只看自己绑定的地址和本机网卡。地址还不知道时（还没绑定）一律不开。没写这个变量就是关闭，欢迎消息里没有 `testMode`，大厅不显示「测试房间」，任何测试请求都拒绝。
服务器已经在运行时，`--test-mode` 不会改它，要先停掉再开。

谁能用：只有房主能建测试房，也只有当时的房主能下测试指令。同盟测试房可以有其他人，加入或观战前必须确认「测试」提示，最近房间入口和房间卡保留标记，指令仍只有房主能发。普通房间不能在开局前或对局中改成测试房。观战席不能发。

指令走对局自己的操作（加资金、获得棋子和装备、开回合、商店刷新、升级、悬赏、选策略、休整倒计时），不另写一套规则。可以改资金、把内容里有的棋子 / 装备 / 所属召唤物拿到手牌、改自己的目标生命、改领袖池生命和队伍生命、跳到某一回合或阶段、指定下一次商店、关掉或恢复阶段计时、设置盟约额外人数来激活盟约并叠到指定层数、换策略、升一级调度中心、加一条悬赏、替自己选一张机变。数量和 id 不对就拒绝，不会悄悄改成合法值。过长的 id 或字符串同样直接拒绝，不会裁短，也不会写进输入日志。每种指令 10 秒内最多 8 条，房客和观战席的尝试也计入，并且先计数再记审计。目标生命已经是 0 时，跳回合会按结算同样的方式淘汰；场上没有存活玩家就结束对局，不再进入新回合。生命写成 0 本身不立刻淘汰，下一场战斗仍会进入结算。跳进隐藏首领回合时，如果队伍生命还没合并过，会按决战开始时的方式合并。

记下什么：每一条送达测试对局的指令（包括拒绝）都进 `[test-audit ROOM]` 日志（谁、哪条、调度器时间、成功或错误码），局内面板能看到最近的记录。结算和回放带「测试」以及成功执行了几次。测试结果和退出都不保存到本地对局记录。服务端不授予称号、奖杯或奖励，统计、成就、徽章和卫戍认证也不算它；没有「含测试对局」开关。标记由服务端创建，不接受客户端更改。

此外，`[test-input ROOM]` JSON 日志记录初始配置、平台输入和实际触发的计时回调。被时间片切开的回调额外记下走了多少步，重演按这个步数停下，不再读墙钟。一局日志最多 4096 行；写满后该局标成不能重演，日志以一条 capped 记录结束，而不是悄悄截断。保留同一局从 init 开始的完整日志，使用同版本和同内容集的 `server/match/testReplay.js` 离线重演；它不是客户端接口。日志由原有服务端 logger 输出，不单独开文件。房间可复用，按 init 行区分局次。真实调度器上的测试局仍用 8 毫秒的机器人休整和服务器战斗时间片，虚拟时间才不限。

测试指令只改当前房间里房主自己的席位，不到别的房间、别人的私人状态、服务器文件或插件脚本。战斗沙盒仍只在浏览器里跑，不写服务器对局。官方 3D 场景和特效仍依赖第 6 节的本地素材。

## 9. 脚本沙箱与 CSP（0.3.0 起）

`SP_PLUGIN_SCRIPTS=sandbox` 开启 script 类的 SES 沙箱执行，默认关闭；trusted 类遵循第 10 节的原生执行门槛，永远
不进入此沙箱。用启动脚本开服时也可以不设环境变量，直接加参数：`scripts/start.sh --scripts sandbox`、
`scripts\start-windows.bat --scripts sandbox`；Windows 上双击 `scripts\start-windows-sandbox.bat` 等于后者（参数取
`off` / `sandbox` / `trusted` / `trusted-force`，`off` 会去掉继承来的环境变量；服务器已经在运行时参数不生效，要先停止它）。此开关允许公网部署，要求有效 lock 和全部文件字节一致，但不要求 trusted pin，也不要求逐人同意
（维护者 2026-10-14 确认）。房间标「脚本（沙箱）」；同一 SDK、描述符与预算已接通，不降级执行。所有玩法插件的浏览器战斗都在专用 Worker 中，卡死看门狗默认 2 秒。
首次应用未缓存的脚本时，每个插件的注册探测默认最多 5 秒，大厅（含原版房间）可能短暂停顿；`SP_SCRIPT_PROBE_MS` 可设为 500–60000 毫秒，慢机器可提高。成功与失败都会缓存，文件或设置变了需重新探测。
沙箱脚本服务器宿主强制子进程，忽略 `SP_MATCH_HOST=worker`；Node 22 `--permission` 只开放安装目录读取，没有写文件、
起子进程、起线程或原生扩展权限，通过 JSON IPC 收取内容，保留现有内存上限和心跳看门狗。

Node 22 权限模型不是恶意代码安全边界，且不限制网络。SES/V8 逃逸后仍可能访问内网、安装目录和已打开的文件描述符；
安装目录内指向外部的符号链接可能扩大可见范围，也可能被 Node 的真实路径权限检查拒绝。`node_modules` 必须实际装在安装目录里，不要链接到外部目录，否则沙箱可能无法加载 SES / Acorn。建议用低权限用户，最好部署在限制出站/内网访问、内存与 CPU 的容器中
[ASSUMED]。不要把启用沙箱等同于可以安全运行任何来源的插件。官方说明见
[Node 22 permissions](https://nodejs.org/docs/latest-v22.x/api/permissions.html)。

整站默认发送 CSP，覆盖主页、开发页面和 `/studio/`；importmap 用精确内容的 SHA-256 放行，页面没有 unsafe-eval。
CSP 仍保留原 Google Fonts 域名白名单，但本 fork 的默认主页/UI gallery 只加载同源字体 CSS 和系统 CJK 回退，
不再自动请求远程字体样式；没有为测试中出现的未知 `font.im` 来源扩域。样式允许 unsafe-inline，图片允许 data/blob，WebSocket 与同源连接以及 blob Worker
保留。Pixi 使用无动态求值的 uniform 适配器。服主可设 `SP_CSP=off` 关闭整站策略 [ASSUMED]；界面插件 `/p/` 和
模拟 Worker 自己的 CSP 不随此开关关闭。整站 connect-src 仅保留 'self'，现有同源 WebSocket 仍可连接。反向代理应保留 CSP 响应头，不要额外叠加会阻断 importmap 或 Worker 的策略。
Worker 响应单独允许 unsafe-eval 供 SES evaluate 使用，并设 `connect-src 'none'`。
受信任页面脚本从同源 `/cs/<cs16>/scripts/<id>/<entry>` 下发，先校验描述符与响应字节，再原生 import；
无需给页面 script-src 加 data:、blob: 或 unsafe-eval。script 与 trusted 混合组合整体按受信任处理，逐人同意。

CSP 和沙箱在 Chrome 里有浏览器测试（`SP_E2E=1 node --test test/ui/sandbox.e2e.test.js` 及 DESIGN §32.11 列出的套件）；
Firefox 和 Safari 还没有专门测过，遇到问题请附浏览器版本反馈。

## 10. Trusted script plugins（原生受信任执行，实验接口）

Scripts are off by default. After reviewing every file, pack the plugin and set `SP_PLUGIN_SCRIPTS=trusted`.
In `plugins/config.json`, add `"trusted": { "<id>": "<SHA-256 of plugin.lock.json>" }`. The exact lock and every
file must match; repack and repin after edits. The catalogue still lists disabled scripts with a refusal reason.

Bind to an explicit loopback or private LAN IP. Public addresses and wildcard listeners (`0.0.0.0`, `::`) refuse
trusted code; `SP_PLUGIN_SCRIPTS=trusted-force` explicitly overrides this [ASSUMED name]. The check uses the listening
address, never a request's address. If a public reverse proxy fronts the server, make the same public-deployment
`trusted-force` decision even when the listener is on a loopback address. Existing room class/allow policy still applies.
All numeric spellings of IPv6 zero, IPv4 0/8 and IPv4-mapped equivalents are refused;
the actual address returned after binding is checked again, and any refused trusted service is killed and reaped.

This executes native third-party code: it can control a player's whole game page, and server code can access the
server account's files and network. The lexical “sandboxable” label is not isolation. Every seated player must accept
the current content hash before starting; a red banner stays visible. Unconsenting spectators receive data/snapshots
only. Infinite loops in the page are not stopped by P3a's action budget. Use only code all participants trust.

Gameplay code always runs in a match child, including bots and SP_VERIFY; it never runs in the main server.
Experimental trusted server entries use a separate child and become active at startup. Restart to change/revoke those
entries; end an active match to revoke its already pinned snapshot. Activation/request timeouts (5 s), startup failures
and shutdown use SIGKILL and wait for that child to exit. Its 128 MB old-space heap limit is not a total memory or
subprocess sandbox. Health extensions are limited to 16 KiB of UTF-8 JSON per plugin.

Composition keeps the synchronous C1 interface: an uncached registration probe pauses the lobby for up to 5 s per
plugin (`SP_SCRIPT_PROBE_MS`, 500–60000: raise it on a slow machine, where starting the engine and SES takes longer),
including vanilla rooms — once per plugin version and settings, since results are cached. Probes use SIGKILL and cache successes/failures by plugin, lock, source descriptor and
settings (256 recent results). The explicit local `node tools/plugin.mjs test <id>` command authorizes execution
without server mode or trusted-pin checks; it is not evidence that those files match the production pin.
Full SDK, pinning, consent and limitations:
[PLUGINS §13](PLUGINS.md#13-scripts-p3a).

Node 22 的 `--permission` **不限制网络**（TCP/UDP/DNS/监听均可能可用）。安装根内指向外部的符号链接也会
扩大可读范围：不要在安装根中放此类链接，包括外链 node_modules、npm link 和配置/存储链接。建议使用容器或
网络命名空间限制出站与内网访问，并设置 OS 内存/CPU 限额。父进程已对日志、启动错误、发送帧、RPC 回复等 IPC
做形态和长度复核（DESIGN §32.11），但 Node 在复核前已解码 IPC，不能据此声称免疫内存炸弹或消息洪泛。
