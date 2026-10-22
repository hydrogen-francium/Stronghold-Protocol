# 项目接手基线

## Context（上下文）

- 探查日期：2026-10-21，时区 Asia/Shanghai。本文件是接手快照，不是部署、安全或全量测试验收报告。
- `D:\卫` 本身不是 Git 仓库。开发仓库为 `D:\卫\Stronghold-Protocol-source`。
- 探查时分支为 `feat/accounts-multiplayer-compose`，HEAD 为 `c9d804f470b8d7422ae04eb66faf671cef21ad52`。
- HEAD 提交标题标为 0.3.2，工作区 `package.json` 版本为 0.3.1；不能仅凭标签判断工作区功能状态。
- 写入本记录前，已有 130 个受跟踪文件修改、61 个未跟踪文件。这是接手前状态，不能清理或覆盖。
- 首次探查只补接手记忆和索引。用户之后授权直接本地实施，2026-10-21 已推进 P3 库存、个人机变与重复策略，P4 血池、联防来源及大报告接管，P5 十六行统计和动态布局，以及 P6 单实例 Compose、固定素材初始化与维护排空；对应细节见根索引。未更新黄金结果、安装依赖、启动真实部署或复跑全量回归。

## Fact / Pitfall（事实与边界）

### 1. 目录不能混用

| 目录 | 已核实的性质 |
|---|---|
| `D:\卫\Stronghold-Protocol-source` | 含 `.git`、根 `AGENTS.md`、源码及未提交的认证和多人改动，是本次接手对象 |
| `D:\卫\Stronghold-Protocol` | 含版本 0.3.1 的 `MANIFEST.json`，不含根 `.git`；其 `server/index.js`、`public/js/main.js` 的 SHA256 均与源码仓库不同，不能代替源码验证 |
| `D:\卫\ui-031-backup-20261019-1915` | 独立备份目录；本次未验证完整性或可恢复性 |
| `D:\卫\ui-031-stage-20261019-1915` | 独立暂存目录；不是本次开发仓库 |
| `D:\卫\ui-031-tools-20261019-1915` | 含诊断脚本、浏览器日志、测试结果、截图及隔离打包候选；不能把其中的子集通过记录算成当前源码全量验收 |

### 主计划入口与需求边界

- Claude Code 主计划位于 `C:\Users\26656\.claude\plans\iridescent-brewing-raccoon.md`，标题为《Stronghold Protocol 源码整合与公网部署》，本次于 2026-10-21 经用户提示后读取。首次接手探查时未读取它，不能把此前基于仓库文档提出的顺序当成完整主计划。
- 最终目标是将隔离适配的 0.3.1 UI、长期账号和多人扩展整合到用户 fork，在 Ubuntu Server 24.04 LTS x64 上 clone 成果、提供配置后用 Docker Compose 启动，不要求部署者修改服务器源码。
- 目标资源约束为 4 核、4 GB、200 GB 流量包；计费周期及流量方向尚不明确，容量是否满足必须实测，不能预先保证。
- 主计划阶段：P0 迁入 UI；P1 长期账号与中央真人配额；P2 容量/协议/冻结上下文；P3 个人池、个人机变与重复策略；P4 Boss/联防记账与有界传输；P5 动态 UI 与统计；P6 Compose 与素材初始化。阶段描述是计划，不代表完成状态。
- 超过四人的干员和装备采用每人独立有限池，不扩大共享库存；四人及以下保留原规则。Boss 共享血池不拆，个人机变、策略实例叠加及原固定阈值按主计划执行。
- 接手实施须先对照主计划定位当前阶段与缺口；测试投入同时受 `.context/conventions/verification-scope.md` 中用户较新要求约束，不能让历史测试清零取代功能交付。
- 主计划不等于 GitHub 写入、素材再分发或公网部署授权，不自动提交、推送、创建 PR、发布或连接真实服务器。原计划中的审批与当时工具可用性记录不能冒充当前授权或现状。
- 追加补查：根 `CLAUDE.md` 仅转向 `AGENTS.md`，不是另一份主计划；Claude Code 的持久记忆入口为 `C:\Users\26656\.claude\projects\d---\memory\MEMORY.md`，其下 `stronghold-server-deployment.md` 与 `bounded-implementation-validation.md` 分别补充原需求纠正和两轮失败停止条件。已读取三份文件，执行规约已同步到仓库，不能只查源码内的文档。

### 2. 架构与执行链

- 项目为明日方舟「卫戍协议：盟约」的非商业浏览器同人复刻。上游规则与本 fork 定制必须区分。
- 服务入口：`server/index.js`。原生 HTTP 与 `ws` 连接到 `server/net.js`、`server/lobby.js`、`server/match/`。
- 客户端：`public/`，使用 Preact、htm、PixiJS、pixi-spine、three；原生 ESM，无打包构建步骤。`tools/vendor.mjs` 准备 `public/vendor/`。
- `server/sim/` 是浏览器和 Node 共用的确定性战斗模拟。服务端管理权威房间、经济与回合；常规真人战斗在浏览器模拟，不能描述成全部战斗在服务器计算。
- 数据由 `tools/build-data.mjs` 生成到 `data/*.json`，禁止手改结果。素材在不入 Git 的 `public/assets/`。
- `Battle`、`Match`、`PlayerState` 的方法分散在对应子目录并按固定顺序装配，修改前不能只读类入口文件。

### 3. 认证与持久化契约

- `docs/AUTH.md` 是本 fork 的认证、Admission、账号本地隔离与验收状态契约，不是上游 0.3.1 的功能清单。
- 三层身份分别为注册授权 `sp_gate`、持久账号及 HTTP 会话 `sp_session`、内存游戏 Session。2026-10-22 起共享令牌仅用于注册，已有账号登录和游戏连接不再依赖 `sp_gate`；详见 `registration-and-realtime-latency.md`。昵称、IP、房间码或浏览器本地资料不能证明账号身份。
- `startServer()` 在监听前校验配置并创建账号服务和唯一的中央 Admission；缺少配置即拒绝启动。README 和 CONTRIBUTING 的上游启动示例不能替代 fork 配置。
- 必须配置 `SP_AUTH_ORIGIN`，以及各自二选一的 `SP_ENTRY_TOKEN` / `SP_ENTRY_TOKEN_FILE` 和 `SP_SESSION_SECRET` / `SP_SESSION_SECRET_FILE`。应用不自动加载 `.env`。
- 秘密和 SQLite 状态必须位于私有目录，不能进入静态服务根、打包产物、日志或诊断。详细约束以 `docs/AUTH.md` §2 和 `docs/DEPLOY.md` §0.1 为准。
- 账号和 HTTP 会话哈希保存在私有 SQLite 中；房间、对局、游戏 Session、重连令牌和 Admission 租约仅在内存中，重启即结束对局。
- 浏览器先验证账号并绑定偏好作用域，再动态导入拥有账号偏好的模块；账号变化停止旧页面工作并重新加载。战绩、头像、配装和脚本同意等是账号作用域的浏览器本地状态，不是云同步。
- 中央真人参战账本上限为 16 个不同账号，另有默认 16 的 AI 预算；房间容量、旁观者、等待人数、连接数不等于参战账本。断线保留期为 10 分钟，含单人局。
- 当前文档要求单个权威应用实例，多副本不能靠 SQLite 或粘性连接协调 Admission。

### 4. 大房间不是完整大人数玩法

- `shared/constants.js` 已定义协议版本 2、默认 4 席、最大 16 席、容量档位 `[4, 8, 16]`、最多 2 个旁观者。
- 容量操作依赖服务端 `welcome.roomCapacity` 能力；实际参战人数不要求填满容量。
- 固定运行时上下文包含 `version`、`capacity`、`participantCount`、`personalPools`。据此绑定个人普通干员池、个人装备池，并接入商店、奖励、效果、AI、透支归还、淘汰、开局重抽与分池审计；现也包含个人 SP 候选/修订领取及重复策略按持有人叠加，详见 `.context/architecture/personal-sp-and-bands.md`。
- P4 已实施实际存活人数首领血池、十五个联防来源、拒绝伪造来源及账本超限的显式原始结果接管，详见 `.context/architecture/large-party-accounting.md`。P5 已修复十六行统计和缺本人误归属，并扩展开场/结算/队友栏布局。P6 配置和本地契约已实施；真实容器冷启动/恢复、16 人组合、手机横屏渲染验收及 4 核 4 GB/流量测量仍未完成。

### 5. 失败证据与文档滞后

- `docs/AUTH.md` §8 记录多次分离验证，不是一条通过的完整 CI：历史全量非浏览器回归共 8742 项，8660 通过、34 失败、48 跳过。
- 34 个历史失败包含七个原生进程退出、九个 Windows 文件符号链接 `EPERM`、三个仅使用受跟踪文件的打包计划失败、两个沙箱超时、两个性能阈值失败、一个实时战报不一致和十个客户端/模拟/源码契约失败。后续子集通过不能抹掉原始失败。
- `0xC0000409` 的最小诊断缩小到部分递归复制调用窗口，尚无原生栈或根因定论。不得把跨盘或 Node 缺陷写成已证实根因。
- 严格导入检查仍发现 `server/sim/nodeData.js` 导入 `node:fs`、`node:path`、`node:url`。导入检查器基线测试通过不等于严格边界检查通过。
- 历史记录包含独立 lint、typecheck、认证冒烟、288 场景黄金结果以及部分真实浏览器生命周期通过；本次没有重跑这些范围。
- 晚于文档的账号切换记录：北京时间 2026-10-21 00:59，`p1-account-switch-20261020-a2.run.json` 为 1 项、0 通过、1 失败、退出 1、`acceptance: false`，不是外层超时。
- 对应 stdout 显示在 `test/ui/account-switch.e2e.test.js:114` 等待 `.lo .lo-card` 超时；首次接手时尚未确认根因。交付前已确认是默认卡片与列表选择器不匹配，仅修正本地测试交互后通过，详见本文件末尾和 `.context/pitfalls/loadout-deck-selector.md`。
- `p1-diagnostics-static-20261021-a1.results.json` 另记录诊断契约 60/60，范围为静态/单元契约、浏览器启动数 0；`AUTH.md` 中的 59/59 是较早记录，不能混淆。

## Solution / Convention（接手执行约定）

1. 阅读顺序：根 `AGENTS.md` → 本文件与验证投入规约 → 上述 Claude Code 主计划 → `docs/ARCHITECTURE.md` → `docs/AUTH.md` §8 → `docs/DESIGN.md` → 所改领域的设计与参考文档。主计划确定目标与范围，实际完成状态须核对源码和证据。
2. 网络/认证读 `docs/AUTH.md`、`docs/design/network.md`、`docs/DEPLOY.md`；战斗读 `docs/SIM.md` 和套件目录 README；回合与经济读 `docs/META.md`；插件改动先读 `plugins/AGENTS.md` 和插件契约。
3. cwd 必须是 `D:\卫\Stronghold-Protocol-source`。本次本地 Node 为 v24.14.1、npm 为 11.11.0；仓库要求 Node `^22.16.0 || >=24.0.0`。
4. 按 `.context/conventions/verification-scope.md` 限定验证投入：日常只做与改动相关的必要验证，完整验证在发布或提交前安排，不先清零历史失败。不要裸跑无文件筛选的 `node --test`，它可能执行夹具；全量入口为 `npm test` 或 `tools/ci.mjs` 的固定文件集合。
5. 不运行 `golden:update` 掩盖重构差异；保持模拟确定性，不在模拟中引入 Node API、随机时钟或非确定性数学。
6. 界面字符串走 `t()` 并覆盖所有语言包；新写或修改的函数与复杂逻辑遵守当前用户要求的简体中文文档注释。
7. 不默认添加重试、静默兜底、兼容垫片、放宽诊断或跳过失败；先确认证据和输入契约。
8. 用户于 2026-10-21 追加不要钻测试的牛角尖：以当前功能目标和实际主流程推进为先，不预设必须先修复账号切换用例或核对全部历史失败。同一问题两轮未解决即收口记录；按用户最新授权直接继续本地实施，不中途阶段性询问或汇报。

### 首次探查实际执行的轻量验证

```text
node --test --test-reporter=spec test/docs-consistency.test.js test/docs-paths.test.js test/check-imports.test.js test/ui/room-capacity.test.js
```

结果：39 项，39 通过，0 失败，0 跳过，0 取消。另执行严格导入检查，仍报告上述三个 Node 导入违规。此结果不证明认证浏览器流程、全量回归、完整大人数玩法或生产部署通过。

### 后续库存实施的定向验证

2026-10-21，库存、重抽与自选四份既有测试文件合计 36/36 通过；文档一致性与路径合计 32/32 通过；十八个相关源码/测试文件的 ESLint 为 0 错误、2 个原有警告。定向空白检查退出 0。准确命令与覆盖边界见 `.context/architecture/personal-inventory.md`；这些结果不证明个人机变、重复策略、完整 P3 或上线验收。

### 后续 P3 至 P5 实施的定向验证

2026-10-21，个人机变相关 55/55、重复策略相关 73/73、统计及开场/结算相关 74/74。报告相关五文件合计最后一次为 56/57，剩余新增 runner 夹具修正后仅重跑该例并通过 1/1，未整组合重跑。准确命令、源码边界及原失败见各专题记忆；不得改写成完整 CI、真实十六人、手机或部署已通过。

### 后续 P6 实施的定向验证

2026-10-21，部署/静态门禁契约 7/7、Python 解包安全夹具 5/5，相关 ESLint 零错误、两个原有警告。
实际远程 Range 核对固定包目录、白名单、顶层引用及字体样式；未整包下载/复算摘要。本机没有 Docker，
新增 Linux CI 配置未远端运行，不能写成容器部署已通过。运维入口与准确边界见 `.context/architecture/compose-and-assets.md`。
最后一次素材哈希路由与文档一致性/路径组合 47/47；定向空白检查退出 0。这不是全量 CI。

## 交付前补查（2026-10-21）

- 用户追加授权完成后本地提交，并由用户手动部署；提交范围见 `.context/conventions/source-delivery.md`。
- 使用本机 Edge 复现账号切换旧选择器失败，确认调配默认卡片与旧列表等待不匹配；仅修正本地测试的真实视图切换后，A 注销/重登录、B 注册隔离及返回 A 的完整用例 1/1 通过。详见 `.context/pitfalls/loadout-deck-selector.md`。
- 容量真实浏览器流程 1/1 通过：创建八席、切换 4/8/16、五名显式参与者开局且不填满。补查 844×390 桌面浏览器视口，可滚动到第十六席，已查看截图；不等于实体手机或十六真人整局。
- `node tools/ci.mjs --only smoke` 通过，覆盖匿名就绪、认证门禁、真实注册登录、完整健康、首页及 vendor 字节和运维诊断。
- 用 `git checkout-index --all` 导出独立暂存源码，再运行该目录的同一 HTTP 冒烟入口并通过；只链接本机已安装依赖与生成 vendor，不依赖未提交测试和本机游戏素材。这不是全新依赖安装或 Compose 素材挂载验证。
- 所有暂存的 JavaScript 文件定向 ESLint 为零错误、33 个警告；`npm run typecheck` 通过现有类型检查切片；文档一致性和路径定向检查 32/32。暂存区空白检查通过，测试路径、素材、秘密、数据库和压缩包均未暂存。
- 本轮没有完整游戏对局、容器构建或目标机器性能测量；未把测试通过写成全部验收完成。

## Reference（溯源）

- Claude Code 主计划：`C:\Users\26656\.claude\plans\iridescent-brewing-raccoon.md`；标题《Stronghold Protocol 源码整合与公网部署》。
- Claude Code 长期记忆：`C:\Users\26656\.claude\projects\d---\memory\MEMORY.md`、同目录的 `stronghold-server-deployment.md`、`bounded-implementation-validation.md`。
- 代码地图：`docs/ARCHITECTURE.md` §§1–6；规则索引：`docs/DESIGN.md`。
- fork 契约及历史验证：`docs/AUTH.md` §§1–8；部署前置条件：`docs/DEPLOY.md` §§0.1–0.3、§3。
- 实现：`server/index.js`、`server/auth/`、`server/http/`、`server/lobby.js`、`public/js/main.js`、`shared/constants.js`、`tools/ci.mjs`。
- 晚近账号切换失败：`D:\卫\ui-031-tools-20261019-1915\p1-account-switch-20261020-a2.run.json` 与同名 `.stdout.log`。
- 晚近诊断契约：`D:\卫\ui-031-tools-20261019-1915\p1-diagnostics-static-20261021-a1.results.json`。
- 开发契约：根 `AGENTS.md`、`CONTRIBUTING.md`、`package.json`、`test/golden/README.md`；Git 状态与本次测试为 2026-10-21 本地观察。
