# P4 扩展人数血池、联防来源与报告预算

## Context（上下文）

- 2026-10-21，依据 Claude Code 主计划 P4，在原有战场与结算架构中实施。
- 房间最多十六人不等于每个战场十六人。普通场仍一人、首领两两配对且奇数单人、联防最多两名协防者。

## Fact / Pitfall（事实与坑点）

- `bossPoolShareOf` 原来把开战存活人数截为 `aliveFull`（默认四），导致扩展局血池不足。现按实际存活数计算，保留单人、固定血池和模式覆盖规则；容量、空位、库存倍率不参与计算。
- `RESULT_LIMITS.players = 4` 是原报告的单战场结构上限，不应机械扩大成十六。联防 `left` 独立使用 `MAX_UNITE_SOURCES = MAX_SEATS - 1`，最多十五个真实来源，客户端不再裁成四个。
- `validateClientResult/specBounds` 保留来源、敌人类型、派生生成与每来源预算。发现旧逻辑会把未知联防漏怪来源改成同类敌人的第一来源；现直接拒绝，不把别人收益或损失归错人。
- 旧 `compactResult` 有四百条列表裁剪，旧 `fitResult` 为压预算会删除修正乃至首领漏怪。权威服务端结果不能经过该路径结算。
- 新 `prepareResultReport` 先检查完整账本：漏怪、未出生敌人、续战单位、层数和修正超结构上限则返回 `accounting_limit`。合法账本压缩后按完整信封的 UTF-8 字节计算六十千字节预算，含内容集及请求编号；只可删除展示用逐单位统计，仍装不下返回 `frame_budget`。
- 页面模拟宿主与工作线程都返回明确的报告决策。客户端以 `b.resultFallback {battleId, reason, cs?}` 请求接管，绝不发送删账后的“成功”报告。
- 回退仅当前战场当前权威可触发；完成、已持有结果、验证中、已改服务端权威或旧场次均不再排任务。内容集要求沿用原规则。现有超时重发和断线重送不增加新重试机制。
- 回退复用 `_runOnServer`：普通/联防是 `HeadlessJob` 分片，首领是 `HeadlessPacer`。每场最多一个任务，排队规模受实际战场数和十六席上限约束；原硬上限 `HARD_CAP_SECONDS = 3700` 与波次时限保留，不新增无界队列或分块结果协议。
- 服务端任务直接保存原始 `battle.result()`，四百条以上仍完整参与结算。首领进度也汇总全部漏怪，不再套展示裁剪。

## Solution / Convention（后续约定）

1. 报告发送必须经 `prepareResultReport`；`compactResult` 只用于有界表示与既有验证摘要比较，不能作为服务端结算输入。
2. 新增列表或账本字段必须同时核对结构上限、字节预算及服务端语义预算，不能仅提高全局人数常量。
3. 单战场任务数有界和模拟硬上限不等于低配部署性能达标；十六真人、真实手机、峰值内存、网络流量与首领大报告接管的生产测量尚未完成。

## Verification（2026-10-21）

- 五个文件的定向组合：`large-party-reports`、`boss-hp-scaling`、`runner`、`sim-host`、`clientCombat-review`，第二次运行 57 项中 56 通过；仅新发送测试的夹具仍失败。
- 该夹具直接修改战斗结束位，帧调度器会跳过已结束战场；改用正式 `b.end` 入口后仅重跑该项，1/1 通过。没有再重跑整组，不把这两次结果描述为同一次全绿。
- 包含十五来源的一/二协防者、伪造来源拒绝、五百条首领进度、四百零一条服务端原始账本、重复/旧场/非权威声明、非 ASCII 字节边界、工作线程与页面模拟一致性。
- 对十四个相关源码/测试文件执行 ESLint：0 错误、4 个既有警告。没有清理警告、全量 CI 或生产部署。

## Reference（溯源）

- 原计划：`C:\Users\26656\.claude\plans\iridescent-brewing-raccoon.md`，P4。
- 血池：`server/match/gamedata.js`、`server/match/finalAssault.js`；来源与结构：`shared/protocol.js`。
- 预算与完整账本：`server/sim/spec.js`、`public/js/battle/simHost.js`、`public/js/battle/simWorkerRuntime.js`、`public/js/battle/runner.js`。
- 权威接管及校验：`server/match/match/reports.js`、`server/match/match/clientCombat.js`、`server/match/match/bossRounds.js`、`server/match/fields.js`。
- 定向用例：`test/match/large-party-reports.test.js`、`test/match/runner.test.js`、`test/match/clientCombat-review.test.js`。
