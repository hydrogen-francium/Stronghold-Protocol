# 调配页默认卡片与旧列表选择器

## Context（上下文）

适用于迁入 0.3.1 界面后的调配页，以及账号切换浏览器流程。记录日期为 2026-10-21。

## Fact / Pitfall（事实与坑点）

- `public/js/screens/loadout.js` 的 `loadoutViewPref` 默认返回 `deck`，默认界面是 `.lo--deck` 下的卡片。
- `.lo-card` 只属于可切换的列表视图；直接等待 `.lo .lo-card` 会超时，并不能证明调配数据或账号隔离损坏。
- 本次先按原用例复现一次超时，再只修改本地测试操作：打开筛选菜单，点击列表视图，随后读取原有干员行。
- 修正操作后，同一浏览器 A 注册、修改头像/昵称/调配、导入本机历史、注销并重新登录、注册 B、再返回 A，完整用例 1/1 通过。
- 历史是合成导入记录，不是本次完成的一局；没有验证非默认皮肤、云端战绩或真实手机。业务代码未因这个超时增加兼容逻辑。

## Solution / Convention（执行规约）

1. 排查旧选择器失败，先核对当前默认视图和可操作的切换入口，不先修改业务默认值或提高超时。
2. 账号隔离可用性按真实界面和账号作用域核实，不能以一个默认视图不匹配的等待结论覆盖整个 P1。
3. 本地测试修改按用户要求不纳入此次提交；测试记录与产品改动必须区分。

## Reference（溯源）

- `public/js/screens/loadout.js`：`loadoutViewPref`、`LoadoutScreen` 与筛选菜单的列表按钮。
- 本地 `test/ui/account-switch.e2e.test.js`：`openLoadout` 与完整账号切换流程。
- 运行：`SP_E2E=1`、`CHROME_PATH` 指向本机 Edge，执行 `node --test --test-reporter=spec test/ui/account-switch.e2e.test.js`，1/1 通过，约 14 秒。
