// C4 simulation hosts (DESIGN §32.11). The clock belongs to runner.js. Only the vanilla host has a Battle on the page.
import { loadBrowserSim, checkOperatorTraitRuntime } from './simLoader.js';
import { unitStatsEntry } from '../../../shared/protocol.js';

/** [ASSUMED] 2 s per RPC, including construction and forceEnd (both can execute plugin hooks). */
export const WORKER_TIMEOUT_MS = 2000;
/** [ASSUMED] Trusted engine/module/data cold load can take longer; plugin code runs in a separate 2 s install RPC. */
export const WORKER_LOAD_TIMEOUT_MS = 15000;
const failure = (code, message) => Object.assign(new Error(message), { code });

/** 原版战斗的页面内模拟宿主；由调度器分配步数与时间预算，不改变确定性模拟规则。 */
export class InPageSimHost {
  constructor({ loadSim = loadBrowserSim } = {}) { this.loadSim = loadSim; this.remote = false; this.battle = null; }
  async load(cs = null, content = null) {
    this.sim = await this.loadSim(content ? { ...content, cs } : undefined);
    return this;
  }
  start(spec, opts = {}) {
    this.spec = spec;
    this.battle = this.sim.spec.createBattleFromSpec(spec, this.sim.ds, opts);
    this.meter = this.sim.spec.attachLpMeter(this.battle);
    return this;
  }
  /** 推进最多 n 个模拟刻；预算耗尽后返回实际刻数和事件，后续调用继续，不丢弃模拟状态。 */
  step(n, { slice = 0, budgetMs = Infinity } = {}) {
    const b = this.battle;
    const slices = [];
    const deadline = Number.isFinite(budgetMs) ? performance.now() + budgetMs : Infinity;
    let ticks = 0;
    // 在完整模拟刻之间让出线程，避免追赶几百刻时阻塞输入和 WebSocket 回包。
    while (ticks < n && !b.finished) {
      b.step();
      ticks++;
      if (slice && ticks % slice === 0 && ticks < n) {
        const ev = b.drainEvents() || [];
        if (ev.length) slices.push({ gt: Number(b.time) || 0, ev });
      }
      if (deadline !== Infinity && performance.now() >= deadline) break;
    }
    // Lazy reads keep the vanilla runner's snapshot/event timing unchanged.
    return { get snap() { return b.snapshot(); }, get ev() { return b.drainEvents() || []; }, state: b, ticks, slices };
  }
  progress() { return this.sim.spec.battleProgress(this.battle); }
  uniteLeft() { return this.sim.spec.uniteLeft(this.battle); }
  /** 返回可展示的有界报告；账本超限时为空，发送方须读取完整报告决策。 */
  compactResult(options) { return this.resultReport(options).result; }
  /** 根据原始账本与实际内容集构造发送决策，不修改模拟状态。 */
  resultReport(options) {
    return this.sim.spec.prepareResultReport(this.battle.result(), { battleId: this.spec.battleId, ...options, cs: this.sim.cs });
  }
  unitStats(id) {
    const u = this.battle?.unitById?.(id);
    return u ? unitStatsEntry(u, u._s || null) : null;
  }
  ownerOps(pid) {
    return (this.battle?.allyUnits || []).filter(u => u?.kind === 'op' && u.ownerId === pid && typeof u.defId === 'string').map(u => ({
      kind: 'op', ownerId: pid, defId: u.defId,
      ...(u.items?.length ? { items: [...u.items] } : {}),
      ...(u.def?.standInFor ? { standInFor: u.def.standInFor } : {}),
      ...(u.def?.diyFor && u.def.loadout?.diy ? { diy: { ...u.def.loadout.diy } } : {}),
    }));
  }
  syncPool(hp, acked) { this.battle?.sharedBoss?.sync?.(hp, acked); }
  forceEnd(reason) { this.battle?.forceEnd(reason); }
  stop() { this.battle = null; }
}

/** Wire state only: no engine import or engine object, including in the dev introspection hooks. */
export class WorkerSimHost {
  constructor({ workerFactory = () => new Worker(new URL('./simWorker.js', import.meta.url), { type: 'module' }),
    timeoutMs = WORKER_TIMEOUT_MS, loadTimeoutMs = WORKER_LOAD_TIMEOUT_MS, onFailure = () => {}, contentFor = null } = {}) {
    this.contentFor = contentFor;
    this.remote = true;
    this.timeoutMs = timeoutMs;
    this.loadTimeoutMs = loadTimeoutMs;
    this.onFailure = onFailure;
    this.worker = workerFactory();
    this.pending = new Map();
    this.seq = 0;
    this.stopped = false;
    this.events = [];
    this.statsCache = new Map();
    this.statsPending = new Set();
    this.battle = {
      snapshot: () => this.packet?.snap,
      drainEvents: () => this.events.splice(0),
      fieldMeta: () => this.packet?.meta || { units: [] },
      getPlayer: pid => this.packet?.players?.[pid],
    };
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data?.id);
      if (!p) return;
      this.pending.delete(data.id);
      clearTimeout(p.timer);
      if (data.error) { const err = failure(data.error.code || 'PLUGIN_WORKER_FAILED', data.error.message); p.reject(err); this.fail(err); }
      else p.resolve(data.value);
    };
    this.worker.onerror = () => this.fail(failure('PLUGIN_WORKER_FAILED', 'simulation worker failed'));
    this.worker.onmessageerror = () => this.fail(failure('PLUGIN_WORKER_FAILED', 'simulation worker message failed'));
  }
  rpc(method, args = [], timeoutMs = this.timeoutMs) {
    if (this.stopped) return Promise.reject(failure('PLUGIN_WORKER_STOPPED', 'simulation worker stopped'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(failure('PLUGIN_WORKER_TIMEOUT', `simulation worker ${method} exceeded ${timeoutMs} ms`)), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ id, method, args }); } catch (err) { this.fail(err); }
    });
  }
  fail(err) { if (this.stopped) return; this.stop(err); this.onFailure(err); }
  async load(cs, content = null) {
    content ||= await this.contentFor?.(cs);
    if (!content || content.cs !== cs || !content.data) throw failure('PLUGIN_WORKER_FAILED', 'no checked content set');
    this.cs = cs;
    const traitRuntimeVerified = await checkOperatorTraitRuntime(content.data);
    const ready = await this.rpc('load', [{ ...content, cs, traitRuntimeVerified }], this.loadTimeoutMs);
    if (ready.install) await this.rpc('install');
    return this;
  }
  accept(packet) {
    this.packet = packet;
    this.events.push(...packet.ev);
    Object.assign(this.battle, packet.state);
    this.meter = packet.meter;
    return packet;
  }
  async start(spec) { this.spec = spec; this.accept(await this.rpc('start', [spec])); return this; }
  async step(n, opts) { return this.accept(await this.rpc('step', [n, opts])); }
  progress() { return this.packet.progress; }
  uniteLeft() { return this.packet.left; }
  /** 返回工作线程已经审核预算的展示结果，不重新生成或截断账本。 */
  compactResult() { return this.packet.report?.result; }
  /** 返回工作线程的完整报告决策，供权威发送方选择报告或接管声明。 */
  resultReport() { return this.packet.report; }
  unitStats(id) {
    if (!this.stopped && !this.statsPending.has(id)) {
      this.statsPending.add(id);
      this.rpc('unitStats', [id]).then(v => this.statsCache.set(id, v), () => {}).finally(() => this.statsPending.delete(id));
    }
    return this.statsCache.get(id) || null;
  }
  ownerOps(pid) { return this.packet?.ops?.[pid] || []; }
  syncPool(hp, acked) { return this.rpc('syncPool', [hp, acked]).catch(() => {}); }
  async forceEnd(reason) { this.accept(await this.rpc('forceEnd', [reason])); }
  stop(err = failure('PLUGIN_WORKER_STOPPED', 'simulation worker stopped')) {
    if (this.stopped) return;
    this.stopped = true;
    this.worker.terminate();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }
}
