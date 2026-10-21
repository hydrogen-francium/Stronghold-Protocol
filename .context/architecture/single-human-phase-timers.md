# 单真人同盟房间的阶段计时

## Context（上下文）

用户在同盟模拟中使用一名真人、三名 AI 队友测试，观察到休整期没有倒计时。

## Fact / Pitfall（事实或坑点）

- `server/match/Match.js` 在开局按 `!p.isBot` 统计真人席位，恰好一名真人时设置 `loneHuman = true`。AI 不计入真人人数。
- `server/match/match/infra.js` 的 `soloUntimed` 为 `isSolo || loneHuman`。因此同盟模式不等于必定开启休整期计时。
- `server/match/match/prep.js` 的 `enterPrep()` 在 `soloUntimed` 时将时长传为 `null`；`setDeadline()` 将截止时间设为零，不安排超时推进。
- `maybeEndPrep()` 仍在所有存活席位准备就绪后推进；AI 完成自身准备后自动就绪。单真人模式没有倒计时不能据此判定为端口、部署或前端故障。
- `docs/META.md` 明确规定：单真人同盟房间保留同盟玩法，但战斗外阶段不限时。至少两名真人开局的同盟房间按每回合的 `prepTime` 计时；该单真人标记不是随中途在线人数动态重算。

## Solution / Convention（处理规约）

- 排查同盟休整期计时前，先确认开局真人人数，而不是总席位数。
- 一名真人加三名 AI 无倒计时符合当前规则，无需修改部署配置或游戏代码。
- 验证多人倒计时须至少两个真人账号实际入座并开局，不能仅添加 AI 或增加旁观者。
- 如果需求是单真人加 AI 也必须限时，应将其作为明确的玩法规则变更处理，而非故障修复。

## Reference（溯源）

- `server/match/Match.js`：`loneHuman` 开局计算。
- `server/match/match/infra.js`：`soloUntimed`、`setDeadline()`。
- `server/match/match/prep.js`：`enterPrep()`、`maybeEndPrep()`。
- `docs/META.md`：阶段计时表及单真人规则说明。
