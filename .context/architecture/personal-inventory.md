# P3 个人有限库存

## Context（上下文）

- 适用于用户 fork 的 P3，依据 `C:\Users\26656\.claude\plans\iridescent-brewing-raccoon.md` 的个人池要求；不是上游官方规则变更。
- 开局实际真人与显式 AI 数量超过四人时，`runtimeContext.personalPools` 冻结为真；容量、空位、观战和之后的淘汰均不能重算该条件。
- 2026-10-21 已实施库存这一子项，随后补齐个人机变与重复策略，详见 `.context/architecture/personal-sp-and-bands.md`；仍不能据此宣称真实十六人浏览器或部署验收。

## Fact / Pitfall（事实与边界）

- `Match.js` 为每名玩家绑定 `ps.chessPool` 与 `ps.itemPool`。四人以内引用原共享对象；超过四人创建每人一套原合作模式基数，不乘人数。扩展局的 `m.pool/m.itemPool` 明确为空，禁止偷偷回退共享池。
- `SharedPool` 记录普通干员副本；`SharedItemPool` 用玩家持有物回调统计装备，保留已有装备透支账本。个人装备回调只返回库存所有者，无需维护第二份持有计数。
- `ps.poolOf(baseId)` 优先返回该玩家自选库存，否则返回其普通干员池。自选库存份数和既有规则不变。
- 商店展示不预留；已展示奖励的干员负余量及装备透支按原规则保留。销毁、消耗或淘汰只偿还/归还原玩家所属池，不用别人的余量抵账。
- `Match.rollItemId/rollPool` 在个人规则下必须传入本局玩家实例，否则显式抛错。效果上下文固定传当前接收者，团队奖励应对每个接收者分别抽取、记账。
- `completeSetupReroll` 先构建全部普通池与自选数据，全部成功后才提交；保留装备池实例与透支，不在仍持有装备时重置账本。
- 审计按实际普通池分别守恒、按实际装备池分别检查透支，并标出所有者。原测试辅助审计也使用相同作用域，不能以全队总量掩盖相反错账。

## Solution / Convention（后续实施）

1. 新增奖励入口必须从接收玩家取池，不读取扩展局为空的共享别名。`finalAssault.js` 的 `pool` 是 Boss 血池，不是库存，不能机械替换。
2. 扩展局已改为每人原数量私有候选，保留顺序轮选；四人以内仍使用原共享牌面。独立随机流、实例修订、重连、AI、超时和退出使用同一生命周期。
3. 领取必须校验当前个人标识。失效候选同族补充，必要时用原补给；全部有限装备不可用时选现有纯资金或免费刷新战术。扩展自定义数据没有合法战术则开局预检失败，不虚构无限装备或静默跳过。
4. 重复起始策略已开放；团队效果按来源实例处理，个人效果保持原接收者语义。鸭爵和外勤医疗的实例规则及验证见 `.context/architecture/personal-sp-and-bands.md`。
5. 保持用户要求的有界验证；不为本库存改动重跑全部认证、浏览器、黄金结果或历史平台故障。

## Verification（2026-10-21 定向结果）

- `node --test test/match/shared-stock.test.js test/match/pool.test.js test/match/feedback5-we2-diy-grants.test.js test/match/setup-reroll.test.js`：36 项，36 通过，0 失败/跳过/取消，约一秒。包含新增五人隔离与透支/淘汰、个人池重抽、十六池独立及相反错账不能抵消三项用例。
- `node --test test/docs-consistency.test.js test/docs-paths.test.js`：32 项，32 通过，0 失败/跳过/取消。
- 对本次十八个源码/测试文件执行现有 ESLint：0 错误、2 警告，分别为 `spDraft.js` 的原有初始赋值和 `economy.js` 的原有未使用参数；未为清零警告改无关代码。
- 定向 `git diff --check` 退出 0。未运行完整 CI、浏览器矩阵、黄金结果、生产部署或真实十六人联机验收；历史失败仍保持原记录。

## Reference（溯源）

- 原计划：`C:\Users\26656\.claude\plans\iridescent-brewing-raccoon.md`，P3。
- 初始绑定：`server/match/Match.js`；库存实现：`server/match/pool.js`；自选路由：`server/match/player/diy.js`。
- 商店与领取：`server/match/player/economy.js`、`server/match/player/acquire.js`、`server/match/player/items.js`。
- 随机与效果：`server/match/match/spDraft.js`、`server/match/effectsMeta.js`、`server/match/choices.js`。
- 重抽与审计：`server/match/match/setupVote.js`、`server/match/invariants.js`、`server/match/audit.js`。
- 定向用例：`test/match/shared-stock.test.js`、`test/match/pool.test.js`、`test/match/feedback5-we2-diy-grants.test.js`。
