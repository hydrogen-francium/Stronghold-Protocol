# AGENTS.md

Entry point for AI coding assistants (Codex, Claude Code, Cursor, Copilot …) working on this repository. It only
indexes the existing documents and their hard rules; when this file and a linked document disagree, the document wins.
Human contributors: [CONTRIBUTING.md](CONTRIBUTING.md) is the same material in full.

## What this is

A non-commercial fan remake of Arknights「卫戍协议：盟约」 that runs in the browser: a Node.js server (economy, rounds,
rooms) and a deterministic battle sim shared by the server and the browser. It aims to be faithful to the official mode.

## Read first

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the code map: where things live, data flow, golden results,
   import boundaries, where common changes start.
2. [docs/DESIGN.md](docs/DESIGN.md) — the index of the rules: current rules in `docs/design/`, each release's
   revisions and their evidence in `docs/history/`.
3. The reference for the part you touch: [docs/SIM.md](docs/SIM.md) (battle engine API, hooks, test harness),
   [docs/META.md](docs/META.md) (match flow, shop, protocol), [docs/DATA.md](docs/DATA.md) (generated data),
   [docs/I18N.md](docs/I18N.md) (interface strings), `server/sim/content/kits/README.md` (operator kits).

## Hard rules

- **Official first.** Rules come from the official data tables (`.cache/gamedata/excel/` after setup) and
  [PRTS](https://prts.wiki/). A detail no source settles is implemented the simplest way and marked `[ASSUMED]` in the
  code and the PR. Deliberate deviations from the official mode are the maintainer's decision only.
- **Determinism.** `server/sim/` is plain ESM that runs in Node and in browsers: no Node APIs, no `Math.random`, no
  clocks, and no engine-approximated Math functions (use `server/sim/detmath.js`; ESLint and
  `test/sim/detmath.test.js` enforce it).
- **Golden results.** A refactor must not change `test/golden/*.json`. An intended gameplay change runs
  `npm run golden:update` in the same commit, and the commit / PR names every moved scenario and why
  ([test/golden/README.md](test/golden/README.md)).
- **Generated data.** Never hand-edit `data/*.json`: change `tools/build-data.mjs` and regenerate.
- **No game art in git.** `public/assets/` is ignored; never commit extracted or downloaded game files.
- **Interface strings** go through `t('…')`, with entries in every pack under `public/i18n/`
  (`node tools/i18n.mjs check --all --strict`).
- **Docs follow the code.** A rule change updates `docs/design/`, the current `docs/history/` file and the reference
  docs; run `node --test test/docs-consistency.test.js test/docs-paths.test.js`.
- **Commits and PRs**: one topic per PR; a one-line message of what changed (Chinese or English) with the issue number;
  no attribution trailers (`Co-Authored-By:`, `Generated with …`). The PR description states what, why, the sources,
  the `[ASSUMED]` points, the tests you ran (paste the summary lines) and the golden moves. No ads, payments or other
  monetisation — the project stays non-commercial.

## Verify

Run the tests of what you touched first, then everything before opening the PR:

```bash
node --test test/<area>/<file>.test.js      # targeted
npm run ci                                  # the CI checks locally (tools/ci.mjs): npm test, smoke, lint, imports, types
npm run golden                              # golden results
```

Browser suites are off by default and need Chrome: `SP_E2E=1` (UI), `SP_REAL_E2E=1` (real match, needs assets),
`RENDER_E2E=1`, `SIM_E2E=1` — see CONTRIBUTING.md §2. Battle tests are easiest with the helpers described in
docs/SIM.md (the test harness section) and the patterns in `test/content/op_siege.test.js`.

## 执行补充规约

- **不要钻测试的牛角尖。** 以当前功能交付和实际可用为主，只做与改动相关的必要验证；不以清零历史测试失败为默认目标。非阻塞问题记录后继续推进，真实阻塞和安全风险不得掩盖。
- 同一问题连续两轮“定位—修改—定向验证”未解决，就停止自动深入、记录影响并后置，不扩建诊断体系。用户默认同意主计划范围内的下一步本地实施，不进行阶段性询问或汇报；不因此自动提交、推送、发布或连接生产服务器。

## 当前仓库索引

- 遇到 `表情发不出去、收到 m.emote 但看不到、队友栏表情气泡消失或滚动裁剪行外气泡` 时，**必须**优先读取 `.context/pitfalls/emote-scroll-clipping.md`。
- 遇到 `头像立绘加载慢、第三回合素材才出现、棋盘场景加载慢、棋盘预热、基础场景与细节分层、无损 WebP 或 http-images-v1 缓存` 时，**必须**优先读取 `.context/architecture/asset-loading.md`。
- 遇到 `三人对局机变界面崩溃、Cannot read properties of null (reading idx)、spBusy 或 busyIdx 空值判断` 时，**必须**优先读取 `.context/pitfalls/shared-choice-null-busy.md`。
- 遇到 `同盟模拟休整期没有倒计时、一名真人加三名 AI、loneHuman 或 soloUntimed` 时，**必须**优先读取 `.context/architecture/single-human-phase-timers.md`。
- 遇到 `项目接手、源码与运行副本区分、认证与 Admission、4/8/16 人容量、Compose 验收或账号切换浏览器失败` 时，**必须**优先读取 `.context/architecture/project-handover.md`。
- 遇到 `测试投入范围、历史失败排查、反复重跑、验证阻塞功能推进或接手优先级` 时，**必须**优先读取 `.context/conventions/verification-scope.md`。
- 遇到 `Claude Code 主计划、原始交付目标、P0 至 P6 阶段或 Ubuntu Compose 整合范围` 时，**必须**优先读取 `.context/architecture/project-handover.md` 中的主计划入口，并继续读取其指向的原计划文件。
- 遇到 `个人干员池、个人装备池、库存透支、库存作用域、开局重抽或 P3 个人机变前置` 时，**必须**优先读取 `.context/architecture/personal-inventory.md`。
- 遇到 `个人机变、choiceId 修订、重复策略、鸭爵来源、外勤医疗叠加或同格医疗设备` 时，**必须**优先读取 `.context/architecture/personal-sp-and-bands.md`。
- 遇到 `扩展人数首领血池、十五个联防来源、四百条报告上限、UTF-8 信封预算或 b.resultFallback` 时，**必须**优先读取 `.context/architecture/large-party-accounting.md`。
- 遇到 `第七至十六行战绩、selfId 缺本人误归属、稀疏席位开场结算、队友栏滚动或准备就绪换行` 时，**必须**优先读取 `.context/architecture/large-party-ui-and-stats.md`。
- 遇到 `Compose 启动、固定素材初始化、SP_ASSET_BUNDLE_DIR、卷权限、维护排空、SP_DRAIN_FILE 或容器备份恢复` 时，**必须**优先读取 `.context/architecture/compose-and-assets.md`。
- 遇到 `调配页 .lo-card 等待超时、默认卡片视图或账号切换旧选择器失败` 时，**必须**优先读取 `.context/pitfalls/loadout-deck-selector.md`。
- 遇到 `源码提交、不提交测试、gitignore 对受跟踪文件无效、素材不入 Git 或用户手动部署` 时，**必须**优先读取 `.context/conventions/source-delivery.md`。
- 遇到 `game.hydrate.top、获取准入令牌、宿主 Nginx 已占用 80/443、与 new-api 共存、3102 回环端口、Healthy 但 PORTS 只有 3000/tcp、invalid IP:0、internal 网络发布端口、Certbot webroot、证书续期后 Nginx 未重载、素材下载 RemoteDisconnected、--archive 本地包导入、ubuntu 上传 ZIP 时 Permission denied 或 AUTH_CONFIG / SP_ENTRY_TOKEN_FILE 启动失败` 时，**必须**优先读取 `.context/architecture/nginx-fronted-deployment.md`。
