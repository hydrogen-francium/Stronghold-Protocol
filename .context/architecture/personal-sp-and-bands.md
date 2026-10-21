# P3 个人机变与重复起始策略

## Context（上下文）

- 2026-10-21，接续个人库存实施；范围为 Claude Code 主计划 P3，不是上游官方四人规则变更。
- 仅冻结的 `runtimeContext.personalPools` 为真时启用，即开局实际真人与显式 AI 总数大于四。之后淘汰或离开不恢复共享规则。
- 用户明确要求直接推进功能、不在阶段节点等待确认；同一问题最多两轮定向修复，不清零历史测试。

## Fact / Pitfall（事实与边界）

- 机变仍逐人轮选，保留原时限、轮次、家族与奖励数值。每人使用原数量候选，不再共同消耗六张卡。
- 每人随机流由局种子、战斗前缀、轮次和玩家标识派生；一人的补牌不消耗另一人的随机流。
- 服务端保存个人牌组。公开状态只含顺序、当前轮选者和已完成玩家，不公开候选、候选家族或他人的选择下标。个人快照含实例与修订标识，客户端只合并本人且实例和轮次匹配的牌组。
- `g.choice` 在个人机变阶段必须携带当前 `choiceId`；错误玩家、旧实例、旧修订及重复请求不能发奖。普通四人共享机变和教鞭选择仍走原入口。
- 领取前失效先按同家族补充，必要时使用原补给；全部有限装备不可用时，只使用现有纯资金或免费刷新战术，不伪造无限装备。扩展局自定义数据缺少此类合法战术时在构造阶段明确报错。
- 同策略在扩展局允许重复，服务器、前端禁用态、默认选择、AI、跳过和超时使用一致的占用判断。四人以内继续互斥。
- 鸭爵按持有人独立运行原次数和原时间点，保留敌人数、路线、奖励归属；新增来源元数据供实例辨识，不重复处理已替换的鸭子。
- 外勤医疗使用显式持有人来源列表，不再将多个持有人合并成一个布尔值。每个接收阵地在原位置生成每来源一个独立医疗实例，不扩大地图或新增摆放点。
- 同位置医疗设备可共享占位代表，但每实例保留独立单位标识、来源与部署顺序。移除占位代表时由同格仍在场的合法实例接替；不允许普通干员或无关设备叠放。
- 离开玩家的局内团队医疗来源保留，沿用原来整局授予的语义。个人策略仍仅由当前事件接收者触发，不能遍历全部持有人后再次广播造成平方叠加。

## Solution / Convention（后续实施约定）

1. 新个人候选入口使用当前接收者库存，公开消息不能携带私有候选。
2. 新团队策略按来源建立实例；新增同位置单位规则必须有明确业务条件，不扩展成通用无限堆叠。
3. `.context/architecture/personal-inventory.md` 仍描述普通库存；本文件补齐 P3 其余实施边界。P4 报告与血池另见 `large-party-accounting.md`。
4. 单元和真实模拟实例通过不等于真实十六人浏览器验收、设备视觉验收或部署性能验收。

## Verification（2026-10-21）

- 个人机变定向组合：`node --test test/match/personal-sp.test.js test/match/draft.test.js test/match/feedback1-secret-shop.test.js test/match/feedback1-tactic.test.js test/content/choices.test.js test/ui/sp-draft-look.test.js`，55/55 通过。
- 重复策略定向组合：`node --test test/match/repeated-bands.test.js test/content/bands.test.js test/ui/bandDraft.test.js test/match/feedback1-ducklord.test.js`，73/73 通过。
- 覆盖五至十六人候选、私有重连、旧请求拒绝、库存失效、原战术回退、资金按接收者计数、AI/超时/退出，以及多医疗实例同格移除与鸭爵来源。不是全量回归。

## Reference（溯源）

- 原计划：`C:\Users\26656\.claude\plans\iridescent-brewing-raccoon.md`，P3。
- 候选、领取与视图：`server/match/match/spDraft.js`、`server/match/choices.js`、`server/match/player/views.js`、`server/match/match/views.js`、`public/js/ui/gameLogic/draft.js`、`public/js/screens/game.js`。
- 策略：`server/match/match/phases.js`、`public/js/screens/bandDraft.js`、`server/match/match/infra.js`、`server/sim/content/bands/meta.js`、`server/sim/content/bands/battle.js`。
- 医疗设备实例：`server/sim/content/tokens.js`、`server/sim/battle/util.js`、`server/sim/battle/summons.js`、`server/sim/battle/deploy.js`、`server/sim/snapshot.js`。
- 定向用例：`test/match/personal-sp.test.js`、`test/match/repeated-bands.test.js`。
