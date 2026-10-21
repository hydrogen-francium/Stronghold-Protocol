# P5 动态人数展示与个人统计

## Context（上下文）

- 2026-10-21，按 Claude Code 主计划 P5 推进，不以历史 P0/P1 失败清零为前置。
- 统计仍为已验证账号作用域的浏览器本机记录，不是云端权威收益。房间人数最多十六，单战场报告的四人边界与此无关。

## Fact / Pitfall（事实与坑点）

- `ui/stats.js` 旧 `MAX_PLAYERS = 6` 会在规范化时丢掉第七至十六行；后续 `selfRowOf` 又会在明确的本人标识缺行时取第一名真人，导致收益、胜负和成就误归属。
- 开场 `ProtocolBoot` 原先只取前六人；结算雷达只查零至三号席位，三人稀疏分布于零、七、十五号时也会漏掉两名实际成员。
- 结算团队卡居中且没有滚动，扩展人数会在两端越界。队友栏没有高度/滚动限制；机变轮选标记也依赖此栏。准备就绪标记原为单行。

## Solution / Convention（解决方案与规约）

1. 记录人数上限复用 `MAX_SEATS`，保留原字段边界、总条数/字符预算和旧记录压缩机制，不扩大其他无关数字。
2. 有 `selfId` 时必须精确命中；缺行返回 `null`，不计个人累计，个人胜利和回合不得借用团队字段。没有 `selfId` 的既有导入记录保留原有规则，不自动迁移昵称归属。
3. 构建、规范化、迁移、导入导出、回放和压缩共用同一套数据链路；策略徽章及结算等级沿用 `selfRowOf`，因此不计明确缺失的本人。
4. 四人以内保留原开场位置，五至十六人使用紧凑两列；空输入为空布局，越界/非整数人数显式报错。编号显示真实席位，不将紧凑排列下标冒认为席位。
5. `settlementIntroSeats` 在原四席使用原素材布局，扩展或稀疏高位席位按实际成员布置编号卡。密集卡片缩短动画错峰，避免演出结束前高位成员还未显示。
6. 扩展团队结算卡改为可滚动列表；队友/轮选栏限高纵向滚动；就绪标记换行。房间 `rs--big` 和测试面板原有滚动已经存在，本次未重复重构。
7. 不修改模拟缓存四项淘汰策略、棋盘四邻域或特效预算；保留减少动画分支。布局源码及纯函数通过不代表实际手机/十六真人渲染已验收。

## 验证记录

```text
node --test --test-reporter=spec test/ui/large-party-ui.test.js test/ui/stats.test.js test/ui/protocol-boot.test.js test/ui/settle.test.js
74 tests / 74 pass / 0 fail / 0 skipped

npx eslint public/js/ui/stats.js public/js/ui/protocolBoot.js public/js/ui/gameLogic/result.js public/js/screens/settle.js test/ui/large-party-ui.test.js test/ui/stats.test.js test/ui/protocol-boot.test.js
退出 0，无错误或警告
```

新增三例覆盖第七/八/十六席本人收益、奖杯/回合/击杀最大值、迁移/导入导出/回放/压缩、缺本人零归属、成就及空/满/稀疏布局。未执行实际浏览器截图、手机触摸、真实十六人整局或部署性能验收。

## Reference（溯源）

- 主计划：`C:\Users\26656\.claude\plans\iridescent-brewing-raccoon.md`，P5。
- 实现：`public/js/ui/stats.js`、`public/js/ui/protocolBoot.js`、`public/js/ui/gameLogic/result.js`、`public/js/screens/settle.js`。
- 样式：`public/css/screens/protocol-boot.css`、`public/css/screens/settle.css`、`public/css/screens/game.css`、`public/css/screens/briefing.css`。
- 已有动态边界：`public/js/screens/room.js`、`public/css/screens/lobby.css`、`public/js/ui/testConsole.js`。
- 规则：`docs/design/client.md`；相关测试：`test/ui/large-party-ui.test.js`。
