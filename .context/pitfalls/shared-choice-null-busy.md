# 共享机变界面空请求导致读取索引崩溃

## Context（上下文）

2026-10-21，用户报告三人对局第四回合出现界面错误，提示 `Cannot read properties of null (reading 'idx')`，数分钟后恢复。随后补充生产浏览器调用栈：`MatchScreen (game.js:1778:53)`，由 `main.js:376` 的界面错误边界记录。行号对应已部署旧版共享机变的忙碌卡片表达式，确认本地修复命中线上报错位置；恢复的具体机制仍未验证。

## Fact / Pitfall（事实或坑点）

- 在本地找到并复现同文案的确定性缺陷：`public/js/screens/game.js` 使用 `spBusy?.choiceId === sp.id ? spBusy.idx : null`。
- `spBusy` 的合法初始值为 `null`，而 `public/js/ui/gameLogic/draft.js` 的共享 `normalizeSp()` 结果没有个人选择标识 `id`。两个比较项均为 `undefined`，比较成立后读取 `null.idx`，导致界面异常。
- 单独给比较左侧添加可选链并不意味着三元表达式的真分支安全。该缺陷与服务器带宽、素材下载速度无关；等待或一次恢复不能证明已修复。
- 同次日志还含图片懒加载提示与 `Page entered Back-Forward Cache` 导致的连接关闭消息，均不是上述读取空对象的调用栈。`public/js/main.js` 已在恢复的 `pageshow` 事件中检查 `persisted` 并重新加载页面，不因这条浏览器生命周期日志修改服务端连接策略。

## Solution / Convention（解决方案与规约）

- 渲染忙碌卡片时先验证合法请求状态不是 `null`，然后比较选择标识。共享选择继续使用没有个人标识的既有契约，不伪造标识、不修改服务端协议。
- 同步明确个人教鞭忙碌状态的相同存在性约束，不添加吞错、自动重试或默认卡片。
- 本地未提交回归文件 `test/ui/sp-busy-null.test.js` 直接提取模板属性表达式并结合三人共享牌面执行：修复前两项精确抛出截图错误，修复后四项通过。
- 与既有机变界面、游戏纯逻辑测试合跑共 64 项通过。语法检查通过；未进行生产三人第四回合复现或完整多人浏览器验收。
- 测试文件受 `.gitignore` 排除，不将本地测试证据误写为远端已有测试。

## Reference（溯源）

- `public/js/screens/game.js`：`spBusy`、`personalBusy` 及两个 `ChoiceOverlay` 的 `busyIdx`。
- `public/js/ui/gameLogic/draft.js`：`normalizeSp()`。
- `server/match/match/spDraft.js`、`server/match/match/views.js`：共享与个人机变契约。
- `test/ui/sp-draft-look.test.js`、`test/ui/gameLogic.test.js`：本次定向验证范围。
- 用户提供的生产控制台调用栈：`main.js:376` → `MatchScreen (game.js:1778:53)`；`public/js/main.js` 的 `pageshow` 处理。
