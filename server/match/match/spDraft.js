// server/match/match/spDraft.js — Match methods: the 机变 draft (SP_DRAFT: turn order, timers, AI picks, the card applied
// by choices.js applyCard), the personal bounty choice of the Art 教鞭 (offerBountyChoice / pickPersonalChoice /
// autoPickPersonalChoice: held by the player inside PREP — no phase, no timer of its own) and the rolls the meta effects
// ask for — bounties (addBounty), item ids (rollItemId) and choices.json pools (rollPool).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, ERR } from '../../../shared/constants.js';
import { generateDraft, applyCard, bountyBattles, isMultiRoundBounty, bountyCard, stockIndependentTactic, draftCardCount, cardTargetBonds } from '../choices.js';
import { createRng, deriveSeed } from '../../sim/rng.js';
import { onPickCard } from '../botEmotes.js';
import { weightedPick } from '../waves.js';
import { botPickCard } from '../bot.js';
import { OK, fail, DELAYS } from './common.js';

/** Cards of the personal choice (PRTS 卫戍协议：盟约 下半 §法术 教鞭: "于3个战术特训的悬赏任务中选择一项"). */
const PERSONAL_OFFER_SIZE = 3;

/** 对局机变、个人教鞭与随机奖励方法；随机库存必须遵守冻结的共享或个人作用域。 */
export class MatchSpDraft {
  /** 按实际规则返回随机奖励使用的库存；个人规则必须显式指定本局玩家，避免跨账号扣账。 */
  rollStocks(player) {
    if (!this.runtimeContext.personalPools) return { chess: this.pool, items: this.itemPool };
    if (!player || this.players.get(player.playerId) !== player) throw new TypeError("个人库存抽取必须指定本局玩家");
    return { chess: player.chessPool, items: player.itemPool };
  }

  /** 创建机变轮选；扩展局为每名存活玩家生成独立私有牌面，四人以内保留原随机流与共享牌面。 */
  enterSpDraft() {
    const alive = this.alivePlayers();
    const personal = this.runtimeContext.personalPools;
    const draft = personal ? {} : generateDraft(this.gd, this.rngDraft, this.round, { stageId: this.stageId, bondAvailable: (bondId) => this.bondLive(bondId), itemAvailable: id => alive.some((ps) => ps.itemPool.canGain(id)) });
    if (!draft || !alive.length) { this.beforePrepOffers(); return; }
    this.phase = PHASE.SP_DRAFT;
    let order = alive.map((p) => p.playerId);
    if (!this.isSolo) this.rngDraft.shuffle(order);
    // 「AI 队友最后选择」 (GitHub #338): humans before AI seats, after the same shuffle (MatchPhases.humansFirst)
    order = this.humansFirst(order);
    // untimed: solo and any single-human match (soloUntimed); the co-op order / 6 cards stay
    const untimed = this.soloUntimed;
    this.sp = { ...draft, order, idx: 0, picks: {}, taken: {}, untimed, turnDeadline: 0 };
    if (personal) {
      this.sp.personal = true;
      this.sp.instance = ++this._spSeq;
      this.sp.decks = new Map();
      // 每人的牌面随机流不受其他玩家生成、补牌或超时消耗影响。
      for (const ps of alive) {
        const rng = createRng(deriveSeed(this.seed, `sp:${this.battlePrefix}:${this.round}:${ps.playerId}`));
        this.sp.decks.set(ps.playerId, { rng, revision: 0, ...this.personalSpDraft(ps, rng) });
        this.reviseSpDeck(ps);
      }
    }
    this.setDeadline(0);
    this.startSpTurn();
    this.markPublic();
  }

  /** 按接收者库存生成原家族牌面；原补给也无货时仅使用数据中无库存依赖的原战术，奖励数值不变。 */
  personalSpDraft(ps, rng, family = null) {
    const opts = { stageId: this.stageId, bondAvailable: (id) => this.spBondAvailable(ps, id), itemAvailable: (id) => ps.itemPool.canGain(id), family };
    const draft = generateDraft(this.gd, rng, this.round, opts);
    const count = draftCardCount(this.gd, this.round);
    if (draft?.cards.length === count) return draft;
    // 自定义悬赏表不足原数量时也不能缩短个人牌面，先沿用原补给回退再考虑无库存战术。
    const supply = generateDraft(this.gd, rng, this.round, { ...opts, family: 'supply' });
    if (supply?.cards.length === count) return supply;
    const fallback = generateDraft(this.gd, rng, this.round, { ...opts, family: 'tactic', tacticAvailable: (c) => stockIndependentTactic(this.gd, c) });
    if (!fallback) throw new TypeError('个人机变无合法候选：内容不满足开局预检契约');
    return fallback;
  }

  /** 个人机变的羁绊候选必须在该接收者普通或自选库存中有剩余，不借用队友的可用副本。 */
  spBondAvailable(ps, bondId) {
    if (this.gd.modeInactiveBonds.has(bondId)) return false;
    return [...ps.chessPool.entries, ...(ps.diyStockEntries() ?? [])].some(([id, entry]) =>
      entry.left > 0 && ps.gd.chess(id)?.bonds?.includes(bondId));
  }

  /** 更新个人牌面修订号并推送所有者私有状态，使迟到请求无法领取被替换的卡。 */
  reviseSpDeck(ps) {
    const deck = this.sp.decks.get(ps.playerId);
    deck.id = `${this.battlePrefix}.sp.${this.round}.${this.sp.instance}.${ps.seat}.${++deck.revision}`;
    this.markPrivate(ps);
  }

  /** 返回指定玩家的原始候选；未指定玩家时读取当前轮选者，不将个人牌面暴露给公共视图。 */
  spCards(ps = this.players.get(this.spTurn())) {
    return this.sp?.personal ? this.sp.decks.get(ps?.playerId)?.cards ?? [] : this.sp?.cards ?? [];
  }

  /** 库存被团队奖励改变时仅替换失效项；原家族无货才整副改为原补给或无库存依赖战术，并刷新实例标识。 */
  refreshSpDeck(ps) {
    if (!this.sp.personal) return false;
    const deck = this.sp.decks.get(ps.playerId);
    const invalid = deck.cards.filter((c) => !this.spCardAvailable(c, ps));
    if (!invalid.length) return false;
    const replacement = this.personalSpDraft(ps, deck.rng, deck.family);
    if (replacement.family !== deck.family) Object.assign(deck, replacement);
    else {
      // 装备家族允许放回抽样，保留仍合法的卡及其索引，避免无关选项随补牌跳变。
      for (const card of invalid) deck.cards[card.idx] = { ...replacement.cards[card.idx % replacement.cards.length], idx: card.idx };
    }
    this.reviseSpDeck(ps);
    return true;
  }

  spTurn() {
    const s = this.sp;
    if (!s) return null;
    return s.order[s.idx] ?? null;
  }

  /** 校验当前回合卡片是否仍可领取；装备始终复核领取者库存，不预留展示卡。 */
  spCardAvailable(card, ps = this.players.get(this.spTurn())) {
    if (!card || !ps || (!this.sp?.personal && this.sp?.taken[card.idx] != null)) return false;
    if (card.kind === 'item') return ps.itemPool.canGain(card.id);
    const bonds = this.sp?.personal && card.kind === 'tactic' ? cardTargetBonds(this.gd, card.id) : null;
    return !bonds || bonds.some((id) => this.spBondAvailable(ps, id));
  }

  /** 推进共享轮选至尚未领取的存活玩家；名单耗尽后进入下一阶段。 */
  startSpTurn() {
    const s = this.sp;
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    // 只向前扫描有限的轮选名单，退出或淘汰的玩家不再占用回合。
    while (s.idx < s.order.length) {
      const ps = this.players.get(s.order[s.idx]);
      if (ps && ps.alive && s.picks[ps.playerId] == null) break;
      s.idx++;
    }
    if (s.idx >= s.order.length) { this.setDeadline(0); this.later(0, () => this.finishSpDraft()); return; }
    this.refreshSpDeck(this.players.get(this.spTurn()));
    const available = this.spCards().filter(c => this.spCardAvailable(c)).map(c => c.idx);
    if (!available.length) { this.setDeadline(0); this.later(0, () => this.finishSpDraft()); return; }
    const token = ++this._turnToken;
    if (!s.untimed) {
      const first = s.idx === 0;
      const secs = first ? this.gd.timer('spFirst') : this.gd.timer('spTurn');
      this.setDeadline(secs, () => {
        if (this.phase !== PHASE.SP_DRAFT || token !== this._turnToken) return;
        const ps = this.players.get(this.spTurn());
        if (!ps) return;
        this.refreshSpDeck(ps);
        const avail = this.spCards(ps).filter(c => this.spCardAvailable(c, ps)).map(c => c.idx);
        if (!avail.length) { this.finishSpDraft(); return; }
        const rng = s.personal ? s.decks.get(ps.playerId).rng : this.rngDraft;
        this._applyCard(ps, avail[Math.floor(rng() * avail.length)]);
      });
      s.turnDeadline = this.deadline;
    } else {
      this.setDeadline(0);
    }
    const cur = this.players.get(this.spTurn());
    if (cur && cur.botControlled) this.scheduleSpBot();
    this.markPublic();
  }

  scheduleSpBot() {
    const token = this._turnToken;
    this.later(this.scaled(DELAYS.BOT_ACTION), () => {
      if (this.phase !== PHASE.SP_DRAFT || token !== this._turnToken || !this.sp) return;
      const ps = this.players.get(this.spTurn());
      if (!ps || !ps.botControlled) return;
      this.refreshSpDeck(ps);
      const cards = this.spCards(ps);
      const avail = cards.filter(c => this.spCardAvailable(c, ps)).map(c => c.idx);
      if (!avail.length) return;
      this._applyCard(ps, botPickCard(this, ps, cards, avail));
    });
  }

  /** 校验轮次、所有者、候选索引和个人修订号后领取；重复或过期请求不发奖。 */
  pickCard(ps, idx, choiceId) {
    if (this.phase !== PHASE.SP_DRAFT || !this.sp) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (this.sp.picks[ps.playerId] != null) return fail(ERR.ALREADY);
    if (this.spTurn() !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (this.sp.personal) {
      if (choiceId !== this.sp.decks.get(ps.playerId).id) return fail(ERR.BAD_TARGET);
      if (this.refreshSpDeck(ps)) return fail(ERR.BAD_TARGET);
    }
    const cards = this.spCards(ps);
    if (!Number.isInteger(idx) || idx < 0 || idx >= cards.length) return fail(ERR.BAD_TARGET);
    if (!this.spCardAvailable(cards[idx], ps)) return fail(ERR.SOLD_OUT);
    this._applyCard(ps, idx);
    return OK;
  }

  /** 将一名玩家的一次选择应用到原效果分发器；团队战术仍逐目标应用一次，不重复遍历持有人。 */
  _applyCard(ps, idx) {
    const s = this.sp;
    const cards = this.spCards(ps);
    if (!s || s.picks[ps.playerId] != null || !this.spCardAvailable(cards[idx], ps)) return;
    const card = cards[idx];
    if (!card) return;
    s.picks[ps.playerId] = idx;
    if (!s.personal) s.taken[idx] = ps.playerId;
    try { applyCard(this, ps, card); } catch (e) { this.reportError(`applyCard ${card.id}`, e); }
    this.markPrivate(ps);
    this.markPublic();
    onPickCard(this, ps, card); // AI bots say "思考" when they take a bounty (enabled by default; SP_BOT_EMOTES=0 silences it)
    this.startSpTurn();
  }

  finishSpDraft() {
    if (this.phase !== PHASE.SP_DRAFT) return;
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    this.beforePrepOffers();
  }

  /**
   * 教鞭 (content/items/meta.js, ctx.offerBountyChoice): the Art opens a PERSONAL choice (act2autochess choice event
   * `hunter_band_1`, choiceType PERSONAL_CHOOSE) between up to three of `candidates` — drawn once from the meta rng, kept in
   * `ps.personalChoice` (m.private only) until the owner confirms one with `g.choice { idx, choiceId }`. It lives inside
   * PREP: no phase of its own and no timer — the prep's deadline resolves it (prepDeadline), Ready is refused while it is
   * pending (PlayerPrep.setReady). Refused — before an rng draw or an id is used, so the Art stays in the hand — when it
   * is not the player's PREP, a choice is already open or no card is left to offer.
   * @param {import('../PlayerState.js').PlayerState} ps @param {any[]} candidates cards.bounty entries
   * @param {string} sourceItemId the Art
   */
  offerBountyChoice(ps, candidates, sourceItemId) {
    if (this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (ps.ready) return fail(ERR.WRONG_PHASE, 'ready');
    if (ps.personalChoice) return fail(ERR.BAD_TARGET, '请先完成当前教鞭选择'); // i18n-ignore: developer error detail
    if (!candidates.length) return fail(ERR.BAD_TARGET, '当前没有可用的战术特训'); // i18n-ignore: developer error detail
    const cards = this.rngMeta.shuffle(candidates.slice()).slice(0, PERSONAL_OFFER_SIZE);
    ps.personalChoice = { id: `${this.battlePrefix}.choice.${this.nextUid()}`, round: this.round, sourceItemId, cards };
    ps.dirty();
    return OK;
  }

  /** g.choice { idx, choiceId }: the owner's pick of its open personal choice — the card becomes a bounty on its next battles. */
  pickPersonalChoice(ps, idx, choiceId) {
    if (this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (ps.ready) return fail(ERR.WRONG_PHASE, 'ready');
    const pending = ps.personalChoice;
    if (!pending || pending.id !== choiceId || pending.round !== this.round) return fail(ERR.BAD_TARGET);
    if (!Number.isInteger(idx) || idx < 0 || idx >= pending.cards.length) return fail(ERR.BAD_TARGET);
    if (!this.addBounty(ps, pending.cards[idx])) return fail(ERR.BAD_TARGET);
    ps.personalChoice = null;
    ps.dirty();
    return OK;
  }

  /**
   * The pick made for a player who did not make it. 'bot': an AI seat or a human under AI 托管 — the bounty scorer of the
   * 机变 draft (bot.js botPickCard: the expected pay minus the expected LP lost against the own board, the bots' seeded rng
   * only breaks ties); 'random': the prep's deadline and a seat the engine finishes by other means — one of the cards at
   * random from the meta rng, like a 机变 turn that runs out. Nothing pending: nothing happens, no rng draw.
   */
  autoPickPersonalChoice(ps, mode) {
    const pending = ps.personalChoice;
    if (!pending) return undefined;
    const indices = pending.cards.map((c, i) => i);
    const idx = mode === 'bot'
      ? botPickCard(this, ps, pending.cards.map((c) => bountyCard(this.gd, c)), indices)
      : this.rngMeta.pick(indices);
    return this.pickPersonalChoice(ps, idx, pending.id);
  }

  addBounty(ps, card) {
    if (!ps || !card || !this.gd.enemy(card.enemyKey)) return null;
    // a multi-round card lasts MULTI_ROUND_BOUNTY_BATTLES battles (choices.js; the user's call after playtest #6)
    const rounds = bountyBattles(card);
    const b = {
      id: `bounty:${this.nextUid()}`,
      card: { effectId: card.effectId ?? card.id ?? null, name: card.name ?? '悬赏', desc: card.desc ?? '', tier: card.tier ?? 1, coin: Math.max(0, Math.trunc(Number(card.coin) || 0)), payout: card.payout === 'perfect' ? 'perfect' : 'kill', rounds, multiRound: isMultiRoundBounty(card), enemyKey: card.enemyKey, count: Math.max(1, Math.min(20, Number.isInteger(card.count) ? card.count : 1)) }, // i18n-ignore: a data-less card's fallback name
      roundsLeft: rounds,
    };
    ps.bounties.push(b);
    ps.dirty();
    return b.id;
  }

  /** Random item id: a choices.json server pool ({ pool }), a tier, or ≤ maxTier shop-eligible items.
   * `also` (pool_equip_kathe: 突变细胞) joins the draw even though it is shopExcluded. The shop item slot does not
   * read it. `pick` still drops ids that `canGain` refuses, so an empty shop item stays out and an uncapped `also`
   * id can still be drawn. `exclude` removes ids before sampling (Cathy's match-long allowance / distinct choices). */
  /** 按池配置、等级和排除项抽装备编号，不扣库存；个人规则必须传领取玩家，无货返回空。 */
  rollItemId({ pool = null, tier = null, maxTier = 6, shopLevel = 6, exclude = [], player = null } = {}) {
    const stock = this.rollStocks(player).items;
    const pools = this.gd.choices.pools && typeof this.gd.choices.pools === 'object' ? this.gd.choices.pools : {};
    const p = typeof pool === 'string' && Object.hasOwn(pools, pool) ? pools[pool] : null;
    const rng = this.rngMeta;
    const pick = (ids, weights = null) => stock.pick(rng, ids.filter((id) => !exclude.includes(id)), weights);
    const tierList = (lo, hi) => { const out = []; for (let t = lo; t <= hi; t++) for (const id of this.gd.shopItemsByTier[t] || []) out.push(id); return out; };
    const also = p && Array.isArray(p.also) ? p.also.filter((id) => typeof id === 'string' && this.gd.item(id)) : [];
    const withAlso = (list) => {
      const out = list.slice();
      for (const id of also) if (!out.includes(id)) out.push(id);
      return out;
    };
    if (p && p.kind === 'equip') {
      if (Array.isArray(p.weighted) && p.weighted.length) {
        const pairs = p.weighted.filter((x) => Array.isArray(x) && this.gd.item(x[0]) && stock.canGain(x[0]));
        for (const id of also) if (!pairs.some((x) => x[0] === id)) pairs.push([id, 1]);
        return pick(pairs.map(x => x[0]), new Map(pairs));
      }
      if (Array.isArray(p.items) && p.items.length) {
        const items = p.items.filter((id) => this.gd.item(id));
        return pick(withAlso(items));
      }
      let list;
      if (Array.isArray(p.tiers) && p.tiers.length) list = p.tiers.flatMap((t) => this.gd.shopItemsByTier[t] || []);
      else list = tierList(1, p.maxTier === 'shopLevel' ? Math.max(1, Math.min(6, shopLevel)) : 6);
      return pick(withAlso(list));
    }
    const list = Number.isInteger(tier) ? tierList(tier, tier) : tierList(1, Math.max(1, Math.min(6, maxTier)));
    return pick(list);
  }

  /**
   * Roll a choices.json pool (ctx.rollPool). Equip pools → rollItemId. Chess pools: an `items` (uniform) or `weighted`
   * list — only chess with a free pool copy (or outside the pool) qualify — else a copy-weighted draw from the shared
   * pool filtered by `tier` / `minTier` / `maxTier` (number or 'shopLevel') / `bond`; `golden: true` yields the elite id.
   * `extra` (the drawing player's 自选 stock, player/diy.js diyStockEntries) joins that shared-pool draw, `chessOf` reads the
   * bonds (the player's data view: a slotted slot's operator) — 0.2.0 WE2.
   * @returns {{ kind: 'item'|'chess', id: string, golden?: boolean } | null}
   */
  /** 从指定奖励池抽取干员或装备，结合领取者库存与自选条目返回结果，不在展示时扣账。 */
  rollPool(poolId, { shopLevel = 6, extra = null, chessOf = null, exclude = [], player = null } = {}) {
    const stock = this.rollStocks(player).chess;
    const pools = this.gd.choices.pools && typeof this.gd.choices.pools === 'object' ? this.gd.choices.pools : {};
    const p = typeof poolId === 'string' && Object.hasOwn(pools, poolId) ? pools[poolId] : null;
    if (!p || typeof p !== 'object') return null;
    const lvl = Math.max(1, Math.min(6, Number.isInteger(shopLevel) ? shopLevel : 6));
    if (p.kind === 'equip') {
      const id = this.rollItemId({ pool: poolId, shopLevel: lvl, exclude, player });
      return id ? { kind: 'item', id } : null;
    }
    if (p.kind !== 'chess') return null;
    const rng = this.rngMeta;
    const free = (id) => {
      if (typeof id !== 'string' || !this.gd.chess(id)) return false;
      const base = this.gd.baseIdOf(id);
      return !stock.has(base) || stock.left(base) > 0;
    };
    let id = null;
    if (Array.isArray(p.weighted) && p.weighted.length) {
      const pairs = p.weighted.filter((x) => Array.isArray(x) && free(x[0]));
      id = pairs.length ? weightedPick(rng, pairs) : null;
    } else if (Array.isArray(p.items) && p.items.length) {
      const list = p.items.filter(free);
      id = list.length ? list[Math.floor(rng() * list.length)] : null;
    } else {
      const maxTier = p.maxTier === 'shopLevel' ? lvl : Number.isInteger(p.maxTier) ? p.maxTier : 6;
      const minTier = Number.isInteger(p.minTier) ? p.minTier : 1;
      const bond = typeof p.bond === 'string' ? p.bond : null;
      const recOf = typeof chessOf === 'function' ? chessOf : (cid) => this.gd.chess(cid);
      id = stock.roll(rng, {
        tier: Number.isInteger(p.tier) ? p.tier : null,
        maxTier,
        filter: (cid, e) => e.tier >= minTier && (!bond || (Array.isArray(recOf(cid)?.bonds) && recOf(cid).bonds.includes(bond))),
        extra,
      });
    }
    if (!id) return null;
    const golden = !!p.golden;
    return { kind: 'chess', id: golden ? this.gd.goldenIdOf(id) || id : id, golden };
  }
}
