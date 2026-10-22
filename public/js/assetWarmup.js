import { assets } from "./assets.js";
import { data } from "./data.js";
import { store, loadPref } from "./store.js";
import { cosmetics } from "./cosmetics.js";
import { chessAvatarUrl, chessPortraitUrl, itemIconUrl, enemyIconUrl, bandIconUrl, bondIconUrl, skillIconUrl, tokenAvatarUrl } from "./ui/assetUrls.js";
import { cardOperators, seatPortrait, CARD_PREF } from "./ui/seatArt.js";
import { ownDiyRecord } from "./ui/gameLogic/diy.js";
import { ownStandIn } from "./ui/gameLogic/standIn.js";

/** 根据已确认的房间和私人快照收集图片与模型；不枚举整包素材或其他玩家的隐藏手牌。 */
export function collectWarmAssets(state, source = data, art = assets) {
  const images = new Set(), models = new Map();
  const m = source.get("assets"), priv = state.match.private;
  const backups = source.get("backups");
  /** 去重有效清单地址，保持当前对局图片先于候选池的顺序。 */
  const image = (url) => { if (url) images.add(url); };
  /** 模型只取清单明确登记的骨骼，避免构造不存在的地址。 */
  const model = (id, skin) => {
    if (!id) return;
    const entry = art.spineEntry(id, skin ? { skin } : {});
    if (entry) models.set(entry.skel, entry);
  };
  /** 使用界面相同的自选和替补规约解析本人棋子，图片先行，模型只预热当前棋子。 */
  const piece = (p) => {
    if (!p) return;
    if (p.kind === "item") { image(itemIconUrl(m, source.lookup("items", p.id))); return; }
    // 召唤物使用独立头像清单，不应按干员编号查询而漏掉预热。
    if (p.kind === "token") { image(tokenAvatarUrl(m, p.id)); return; }
    const base = source.lookup("chess", p.id);
    if (!base) return;
    const rec = ownDiyRecord(base, priv, { chess: source.get("chess"), backups }) || ownStandIn(base, priv, backups) || base;
    image(chessAvatarUrl(m, rec));
    image(chessPortraitUrl(m, rec));
    image(skillIconUrl(m, rec));
    if (p.skin) {
      image(art.avatar(rec.charId, { skin: p.skin }));
      image(art.portrait(rec.charId, { skin: p.skin }));
    }
    model(rec.assets?.spine || rec.charId, p.skin);
    for (const item of p.items || []) image(itemIconUrl(m, source.lookup("items", item.id)));
  };
  for (const list of [priv?.board, priv?.hand, priv?.temp, priv?.shop?.slots, priv?.shop?.rewardOffer?.slots]) {
    for (const p of list || []) piece(p);
  }
  for (const unit of priv?.prepMapChars || []) model(unit.spine || unit.defId, unit.skin);
  for (const enemy of priv?.nextEnemies || []) {
    image(enemyIconUrl(m, enemy.enemyKey));
    model(enemy.enemyKey);
  }
  for (const bond of priv?.bonds || []) image(bondIconUrl(m, bond.bondId));
  for (const player of state.match.public?.players || []) image(bandIconUrl(m, player.bandId));

  const cards = cardOperators(source.list("chess"));
  const portraits = {
    pool: cards.filter((c) => (c.rarity ?? 0) >= 5).sort((a, b) => a.charId < b.charId ? -1 : 1),
    byChar: new Map(cards.map((c) => [c.charId, c])), m,
    myId: state.me.playerId, myCard: loadPref(CARD_PREF, ""),
  };
  for (const seat of state.room?.seats || []) image(seatPortrait(seat, portraits));
  // 房间等待期只下载最先出现的低阶干员；开局后不再让推测素材争抢当前回合带宽。
  if (!state.match.public) {
    for (const c of source.list("chess").filter((c) => c.visible !== false && !c.isGolden && !c.isDiy && c.tier <= 2).slice(0, 24)) {
      image(chessAvatarUrl(m, c));
      image(chessPortraitUrl(m, c));
    }
  }
  return { images: [...images], models: [...models.values()].slice(0, 16) };
}

/** 安装房间级预热：图片最多四路、骨骼最多一路；返回注销函数，退出账号后不再发起请求。 */
export function installAssetWarmup() {
  let stopped = false, scheduled = false, active = 0, modelActive = false;
  let images = [], models = [], renderer, boardModule;
  const started = new Set(), startedModels = new Set(), scenes = new Set();

  /** 并行预热渲染依赖与棋盘，返回模型加载所需的就绪状态；场景不等待这些大文件。 */
  async function prepareRenderer() {
    const preference = new URLSearchParams(location.search).get("render") || globalThis.__SP_RENDER__;
    if (preference === "fallback") return null;
    const boardPreference = new URLSearchParams(location.search).get("board");
    // 能力检查只执行一次；明确指定三维模式时与实际渲染器使用相同的慢速设备规则。
    boardModule = import("./render/board3d/load.js").then(async (board) => {
      if (stopped || !store.get().room || boardPreference === "2d" || !board.webgl2Available(boardPreference === "3d")) return null;
      return await board.boardArtListed(assets) ? board : null;
    });
    const [pixi] = await Promise.all([
      import("./render/app/pixi.js").then((module) => module.ensurePixi()),
      import("./render/boardArt.js").then((art) => stopped || !store.get().room ? null : art.loadBoardArt(assets)),
      boardModule.then(async (module) => {
        if (module) await Promise.all([module.loadThree(), module.loadBoardPack(assets)]);
        return module;
      }),
      import("./render/app.js"),
    ]);
    if (stopped || !store.get().room || !pixi) return null;
    // 二维模式也依赖骨骼运行库，不能因为没有三维棋盘就跳过当前单位模型预热。
    return true;
  }

  /** 图片队列空闲后才预热当前单位，完成后释放引用，仍受已有骨骼缓存预算约束。 */
  async function pumpModels() {
    if (stopped || modelActive || active || images.length || !models.length || !renderer || !store.get().room) return;
    modelActive = true;
    const entry = models.shift();
    startedModels.add(entry.skel);
    try {
      if (await renderer && !stopped && store.get().room) {
        try { await assets.spine.acquire(entry); }
        finally { assets.spine.release(entry); }
      }
    } catch (error) { console.warn("[assets] model warmup failed", entry.skel, error); }
    finally { modelActive = false; pumpModels(); }
  }

  /** 从最新快照重排后的队列启动图片，不让旧回合的等待项挤占下一回合。 */
  function pumpImages() {
    while (!stopped && store.get().room && active < 4 && images.length) {
      const url = images.shift();
      started.add(url);
      active++;
      assets.image(url).then((img) => {
        if (!img) console.warn("[assets] image warmup failed", url);
      }).finally(() => { active--; pumpImages(); });
    }
    pumpModels();
  }

  /** 同一消息批次只收集一次；先接收素材及装扮清单，再按实际状态选择下载内容。 */
  function refresh() {
    if (stopped || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (stopped) return;
      const state = store.get();
      if (!state.room) { images = []; models = []; return; }
      const manifest = data.getRaw("assets");
      if (!manifest) return;
      assets.seed(manifest);
      assets.seedLocal(data.getRaw("local"));
      const next = collectWarmAssets(state);
      images = next.images.filter((url) => !started.has(url));
      models = next.models.filter((entry) => !startedModels.has(entry.skel));
      if (!renderer && data.getRaw("local")) {
        renderer = prepareRenderer();
        renderer.catch((error) => console.warn("[assets] board warmup failed", error));
      }
      // 场景只按服务器实际选定的地图预热，不下载全部关卡。
      const stage = state.match.public?.stageId;
      if (boardModule && stage && !scenes.has(stage)) {
        scenes.add(stage);
        boardModule.then((board) => {
          if (board && !stopped && store.get().room) return board.loadScenePack(assets, stage);
        }).catch((error) => console.warn("[assets] scene warmup failed", stage, error));
      }
      pumpImages();
    });
  }
  /** 战场逐帧更新不影响素材清单，只在房间或服务端快照替换时重新收集。 */
  function onState(state, previous) {
    if (state.room !== previous.room || state.match.private !== previous.match.private || state.match.public !== previous.match.public) refresh();
  }
  const unsubscribe = [store.subscribe(onState), data.subscribe(refresh), cosmetics.subscribe(refresh)];
  refresh();
  return () => { stopped = true; images = []; models = []; for (const stop of unsubscribe) stop(); };
}
