// Client entry: boot (fonts, identity, socket), net → store wiring, router, global overlays.
//
// Router (derived from the store, no URL routes):
//   not entered            → Title
//   m.public.phase ≠ LOBBY → Game (screens/game.js: briefing / band draft / match / result by phase)
//   room.inMatch           → Game (match starting, m.public on its way)
//   in a room              → Room
//   otherwise              → Lobby
// Deep link `?room=CODE`: remembered at boot, auto-joined once the player has entered and the
// session is online (after a short grace period in case the server restores a room on resume).
// Reloading a tab that already passed the title re-enters automatically (sessionStorage flag) and
// resumes the server session with the saved token; stale room/match state is dropped if the
// server does not re-push it within RESTORE_GRACE_MS after `welcome`. Boot waits for
// server account, then `identity.init()`, before the first connection; a page restored from the
// back/forward cache reloads instead of reusing another account's module caches.
// A `welcome` with a NEW playerId (the server restarted / the session expired) while a room or match was on screen:
// toast 「服务器会话已重置，上一局模拟已结束」 (store.js sessionResetNotice) and return to the lobby with nothing stale.
//
// Shared modules are imported relatively ('../../shared/…' resolves to /shared/… in the browser).
// Multi-device support (ui/device.js + css/devices.css): feature classes on <html>, no page zoom, safe areas, rotation
// re-layout; ui/compat.js polyfills are imported before anything else.
// 干员调配 (DESIGN §16): an overlay over any route (<LoadoutHost/>, opened from lobby / room / briefing); its loadout is
// kept in sync with the server by installLoadoutSync (room.loadout after every welcome and edit), its 干员持有 tab's
// not-owned list (0.2.0 补位) by installOwnershipSync (room.ownership, likewise), the 自选编队 picks (0.2.0 DIY) by
// installDiySync (room.diy, likewise; it also keeps welcome.diyKitted for the picker).
// Game data: every text of the game is static data (/data/*.json) downloaded once per page; the in-match files are
// warmed in the background as soon as the player is in a room (warmGameData), before the match needs them.
// Language (ui/lang.js, docs/I18N.md): chosen before the first render (initLang); App re-renders on a switch (useLang).
// Server texts are translated on arrival: m.toast / m.ticker frames (msgid + params, or the text as a msgid; a
// config.broadcasts line from its id + args), error codes (ui/toasts.js describeError) and room.closed reasons.
// Cosmetic plugins (DESIGN §32 P1a): installContent (content.js) lays the room's visual set and the player's personal
// plugins over the art manifest every screen reads. Gameplay plugins (§32.6): installContentSet (content.js) downloads and
// checks a room's content set and makes it the data every screen and the battle runner read.

// Only this audited, cache-free graph is evaluated before the verified preference binding:
// compat; accounts -> components -> data/assetUrls; store -> shared constants/i18n;
// vendor preact/hooks/htm and the pure shared i18n data/pack helpers. None initialise account prefs.
import './ui/compat.js';
import * as accounts from './ui/accounts.js';
import { store, useStore, setAccountScope, emptyMatch, selectRoute, sessionResetNotice, isSpectating, roomCapacityOptions } from './store.js';
import { t, N_, translateWire } from '../../shared/i18n.js';

let net, identity, NetError;
let render, useErrorBoundary, html, UiHosts, Modal, Button, MicroLabel, closeAllDialogs;
let ConnectionBanner, ToastHost, toast, toastError, describeError, data, GAME_FILES;
let TitleScreen, sanitizeName, LobbyScreen, rememberRoom, parseRoomParam, joinKnown, RoomScreen, TrustedNotice, GameScreen;
let audio, installAudio, settingsStore, GuideHost, installDeviceSupport, registerImportedAssetWorker, LoadoutHost, StatsHost;
let installRehearsal, recordResult, installStatsRecorder, installLoadoutSync, installOwnershipSync, installDiySync, installSkinsSync;
let startBuildGuard, initLang, useLang, tickerText, recordError, installTrafficMeter, installContent, installContentSet, cosmetics, stopPluginFrames;
let SCREENS, preloadGameScreen, assetWarmup, stopAssetWarmup;

/** loadout/skins/content and every module-time preference consumer are evaluated ONLY after setAccountScope. */
async function loadGameGraph() {
  const modules = await Promise.all([
    import('../vendor/preact.module.js'), import('../vendor/hooks.module.js'), import('./ui/components.js'),
    import('./ui/connBanner.js'), import('./ui/toasts.js'), import('./data.js'), import('./ui/gameComponents.js'),
    import('./screens/title.js'), import('./screens/lobby.js'), import('./screens/room.js'), import('./screens/gameLoader.js'),
    import('./audio.js'), import('./ui/settings.js'), import('./ui/guide.js'), import('./ui/device.js'), import('./assetCache.js'),
    import('./screens/loadout.js'), import('./screens/stats.js'), import('./battle/rehearsal.js'), import('./ui/stats.js'),
    import('./ui/loadoutSync.js'), import('./ui/buildGuard.js'), import('./ui/lang.js'), import('./diag.js'),
    import('./content.js'), import('./cosmetics.js'), import('./ui/pluginFrame.js').then((module) => {
      // Logout can finish while these imports are still fetching/evaluating. Terminate a late frame module too.
      stopPluginFrames = module.stopPluginFrames;
      if (accountPageStopped) stopPluginFrames();
      return module;
    }),
  ]);
  [{ render }, { useErrorBoundary }, { html, UiHosts, Modal, Button, MicroLabel, closeAllDialogs },
    { ConnectionBanner }, { ToastHost, toast, toastError, describeError }, { data }, { GAME_FILES },
    { TitleScreen, sanitizeName }, { LobbyScreen, rememberRoom, parseRoomParam, joinKnown }, { RoomScreen, TrustedNotice }, { GameScreen, preloadGameScreen },
    { audio, installAudio }, { settingsStore }, { GuideHost }, { installDeviceSupport }, { registerImportedAssetWorker },
    { LoadoutHost }, { StatsHost }, { installRehearsal }, { recordResult, installStatsRecorder },
    { installLoadoutSync, installOwnershipSync, installDiySync, installSkinsSync }, { startBuildGuard },
    { initLang, useLang, tickerText }, { recordError, installTrafficMeter }, { installContent, installContentSet }, { cosmetics }, { stopPluginFrames }] = modules;
  SCREENS = { title: TitleScreen, lobby: LobbyScreen, room: RoomScreen, game: GameScreen };
}

const RESTORE_GRACE_MS = 1500;
const JOIN_DELAY_MS = 350;
const TICKER_KEEP = 20;
const EMOTE_KEEP = 20;

/** Copy of a server message without transport fields. */
function payload(msg) {
  const { t, rid, ...rest } = msg;
  return rest;
}

function clearRoomParam() {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has('room')) return;
    url.searchParams.delete('room');
    history.replaceState(history.state, '', url.pathname + (url.search || '') + url.hash);
  } catch { /* ignore */ }
}

// ---- net → store wiring ---------------------------------------------------------------------------

let seq = 0;
let welcomeAt = 0;
let roomStateAt = 0;
let matchAt = 0;
let restoreTimer = null;
let joinTimer = null;
let joinInFlight = false;
/** The rehearsal installer (battle/rehearsal.js): its tasks follow the match on screen (see wireNet's store hook). */
let rehearsal = null;
let buildGuard = null;
let accountPageStopped = false;
let accountRecoveryStarted = false;

function clearPendingJoin() {
  store.patch('ui', { pendingJoin: null });
  clearRoomParam();
}

/** Auto-join the deep-linked room once entered + online (idempotent). */
function schedulePendingJoin() {
  clearTimeout(joinTimer);
  joinTimer = setTimeout(async () => {
    const s = store.get();
    const code = s.ui.pendingJoin;
    if (!code || joinInFlight || !s.session.entered || net.status !== 'online') return;
    if (s.room) {
      if (s.room.code !== code) toast(t('你已在其他同盟中，请先离开当前同盟'), 'warn');
      clearPendingJoin();
      return;
    }
    joinInFlight = true;
    try {
      await joinKnown('room.join', code);
    } catch (err) {
      if (!accountPageStopped) toastError(err);
    } finally {
      joinInFlight = false;
      if (!accountPageStopped) clearPendingJoin();
    }
  }, JOIN_DELAY_MS);
}

/** End the post-resume "syncing" state early once the server re-pushed what we were showing. */
function maybeFinishRestore() {
  const s = store.get();
  if (!s.ui.restoring) return;
  const roomOk = !s.room || roomStateAt >= welcomeAt;
  const matchOk = !s.match.public || matchAt >= welcomeAt || !s.room?.inMatch;
  if (roomOk && matchOk) {
    clearTimeout(restoreTimer);
    store.patch('ui', { restoring: false });
  }
}

/**
 * Leave whatever room / match was on screen for the lobby with nothing stale left behind: open imperative dialogs,
 * the post-resume restore timer, ticker lines and emote bubbles of the old match (the battle runner and the 暂离 flag
 * follow the store themselves).
 */
function backToLobby() {
  identity.rememberMatch(null);
  clearTimeout(restoreTimer);
  const s = store.get();
  if (s.room || s.match.public) closeAllDialogs();
  store.set({ room: null, match: emptyMatch(), ticker: [], emotes: [] });
  store.patch('ui', { restoring: false });
}

/** The unofficial plugins a server counts in welcome / /healthz `content.plugins` (absent: none — DESIGN §32 P1a). */
const pluginCount = (content) => (content && Number.isInteger(content.plugins) && content.plugins > 0 ? content.plugins : 0);

function onWelcome(msg) {
  identity.saveToken(msg.token);
  let resetNotice = identity.finishRecovery(msg.playerId);
  identity.rememberMatch(null);
  const prev = store.get();
  const prevId = prev.me.playerId;
  const name = typeof msg.name === 'string' && msg.name ? msg.name : prev.me.name;
  identity.saveName(name);
  store.set({
    me: { playerId: msg.playerId ?? null, name, token: typeof msg.token === 'string' ? msg.token : null },
    // the server's content identity (DESIGN §32): the diagnostics name it (diag.js contentLine)
    content: msg.content && typeof msg.content.vanilla === 'string' ? { vanilla: msg.content.vanilla } : null,
    // how many unofficial plugins it has (P1a — absent: none; content.js fetches the catalogue only when there are some)
    installedPlugins: pluginCount(msg.content),
    installedNotices: msg.content?.notices === true,
    testMode: msg.testMode === true,
    roomCapacities: roomCapacityOptions(msg.roomCapacity),
  });
  welcomeAt = Date.now();

  if (prevId != null && prevId !== msg.playerId) {
    // A brand-new server session (the server restarted — crashed / killed, so no room.closed arrived — or this session
    // expired on it): whatever we showed before is gone — back to the lobby cleanly and say why.
    resetNotice ||= sessionResetNotice(prev, msg.playerId);
    backToLobby();
  } else if (prev.room || prev.match.public) {
    // Resumed session: the server re-pushes room/match state; drop whatever it doesn't.
    store.patch('ui', { restoring: true });
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      const s = store.get();
      const patch = {};
      if (s.room && roomStateAt < welcomeAt) patch.room = null;
      if (s.match.public && matchAt < welcomeAt) patch.match = emptyMatch();
      store.set(patch);
      store.patch('ui', { restoring: false });
    }, RESTORE_GRACE_MS);
  }
  if (resetNotice) toast(t(resetNotice), 'warn', { ttl: 7000 });
  schedulePendingJoin();
}

function onRoomState(msg) {
  const room = payload(msg);
  roomStateAt = Date.now();
  const myId = store.get().me.playerId;
  const seats = Array.isArray(room.seats) ? room.seats : [];
  if (myId != null && seats.length && !seats.some((s) => s && s.playerId === myId) && !isSpectating(room, myId)) {
    // We are no longer seated (kicked / left elsewhere) — neither in a player seat nor a spectator seat.
    if (store.get().room) toast(t('你已不在该同盟中'), 'warn');
    store.set({ room: null, match: emptyMatch() });
    return;
  }
  const prevRoom = store.get().room;
  // A (new) match starts: forget the previous match's state so stale results never show.
  if (room.inMatch && !(prevRoom && prevRoom.inMatch && prevRoom.code === room.code)) store.set({ match: emptyMatch() });
  store.set({ room });
  identity.rememberMatch(room.inMatch && seats.some((seat) => seat?.playerId === myId)
    ? { name: store.get().me.name, code: room.code || '' } : null);
  if (room.mode === 'coop' && typeof room.code === 'string') rememberRoom(room.code, room.test === true);
  maybeFinishRestore();
}

const CLOSE_REASON = {
  // 'timeout' = this player was removed after staying disconnected past the lobby grace (server/lobby.js)
  host_left: N_('创建者已离开，同盟已解散'), timeout: N_('由于长时间断开连接，你已离开同盟'), empty: N_('同盟已解散'),
  kicked: N_('你已被移出同盟'), ended: N_('模拟已结束'), expired: N_('同盟已过期'), shutdown: N_('服务器维护中，同盟已关闭'),
};

function wireNet() {
  net.on('status', (snap) => {
    const cur = store.get().connection;
    store.set({
      connection: {
        status: snap.status, ping: snap.ping, attempt: snap.attempt, retryAt: snap.retryAt,
        lastError: snap.lastError, everOnline: cur.everOnline || snap.status === 'online',
      },
    });
  });
  net.on('clock', (c) => store.set({ clock: { offset: c.offset, rtt: c.rtt, synced: c.synced } }));
  net.on('welcome', onWelcome);
  net.on('helloError', (err) => {
    // A refused token stays saved until the user explicitly chooses account recovery.
    toastError(err);
  });
  net.on('authRequired', () => {
    stopAccountPage();
    location.replace('/auth');
  });
  net.on('replaced', () => toast(t('该身份已在其他页面登录，本页已断开'), 'warn', { ttl: 6000 }));
  net.on('unhandledError', (err) => toastError(err));
  net.on('room.state', onRoomState);
  net.on('room.closed', (msg) => {
    backToLobby();
    const known = Object.hasOwn(CLOSE_REASON, String(msg.reason)) ? CLOSE_REASON[msg.reason] : null;
    toast(known ? t(known) : typeof msg.reason === 'string' && msg.reason.length < 60 ? t('同盟已关闭：{reason}', { reason: msg.reason }) : t('同盟已关闭'), 'warn');
  });
  net.on('m.public', (msg) => { matchAt = Date.now(); store.patch('match', { public: payload(msg) }); maybeFinishRestore(); });
  net.on('m.private', (msg) => { matchAt = Date.now(); store.patch('match', { private: payload(msg) }); });
  net.on('m.layer', (msg) => {
    const s = store.get();
    if (selectRoute(s) === 'game' && msg.playerId === s.me?.playerId) audio.layerGain(msg.bondId, msg.add);
  });
  net.on('m.field', (msg) => store.patch('match', { field: payload(msg) }));
  net.on('m.result', (msg) => {
    const res = payload(msg);
    store.patch('match', { result: res });
    // 本机统计 (PR #323): every arrival, including the lobby's result replay after a reconnect / reload —
    // replays dedupe by content id inside recordResult (spectator seats' copies build no record at all)
    // (`vs`: the room's cosmetic plugins, recorded — such a match still counts as the original game: ui/stats.js)
    // (`content`: the room's content set when it played gameplay plugins — such a match is unofficial: ui/stats.js)
    if (store.get().room?.test !== true && store.get().match.public?.test !== true) recordResult(res, { myId: store.get().me.playerId, roomMode: store.get().room?.mode ?? null, vs: store.get().room?.content?.vs ?? null, content: store.get().room?.content ?? null, now: Date.now() });
  });
  net.on('m.toast', (msg) => {
    const kind = ['info', 'success', 'warn', 'error'].includes(msg.kind) ? msg.kind : 'info';
    // msgid + params (server ≥ 0.2.0) or the text itself as a msgid, in the current language
    toast(translateWire(msg), kind);
  });
  net.on('m.ticker', (msg) => {
    if (typeof msg.text !== 'string') return;
    const text = tickerText(msg);
    // type, player + the round it came in: a BOSS_HIT line is dropped once its boss round is over and superseded by the
    // same player's next one (ui/ticker.js tickerLineLive / tickerSupersedes)
    const type = typeof msg.type === 'string' ? msg.type : null;
    const playerId = typeof msg.playerId === 'string' ? msg.playerId : null;
    // its broadcast priority: the strip plays the highest first (ui/ticker.js enqueueTickerLines)
    const priority = Number.isFinite(msg.priority) ? msg.priority : 0;
    store.set((s) => ({ ticker: [...s.ticker.slice(-(TICKER_KEEP - 1)), { id: ++seq, text, at: Date.now(), type, playerId, round: s.match?.public?.round ?? null, priority }] }));
  });
  net.on('m.emote', (msg) => {
    store.set((s) => ({ emotes: [...s.emotes.slice(-(EMOTE_KEEP - 1)), { seq: ++seq, playerId: msg.playerId, id: msg.id, at: Date.now() }] }));
  });

  // Entering (title → lobby) while already online also needs the deep-link join.
  store.subscribe((s, prev) => {
    if (s.session.entered && !prev.session.entered) schedulePendingJoin();
    // in a room (co-op or solo, also a resumed one) a match is near: its data starts downloading
    if (s.room && !prev.room) warmGameData();
    // the match on screen is over (left, closed, kicked, a new session): a rehearsal task of it is dead, and the frame
    // that cancels it may never arrive (a disposed match sends nothing) — the page stops what it is running itself
    if (selectRoute(prev) === 'game' && selectRoute(s) !== 'game') rehearsal?.clear();
  });
}

/**
 * 进入房间后立即预热对局模块、静态数据和当前需要的美术素材；不阻塞标题页。
 * 数据与模块复用已有下载结果，插件内容仍由内容系统加载；注销账号时停止继续预热。
 */
function warmGameData() {
  if (accountPageStopped) return;
  // 加入房间即开始下载，不再额外等待浏览器空闲；插件房间的数据仍由内容系统提供。
  preloadGameScreen().catch((error) => console.warn('[assets] game module warmup failed', error));
  if (store.get().room?.content?.vanilla !== false) data.loadAll(GAME_FILES).catch((error) => console.warn('[assets] game data warmup failed', error));
  assetWarmup ??= import('./assetWarmup.js').then(({ installAssetWarmup }) => {
    if (!accountPageStopped) stopAssetWarmup = installAssetWarmup();
  });
  assetWarmup.catch((error) => console.warn('[assets] warmup installation failed', error));
}

// ---- UI chrome (the connection banner lives in ui/connBanner.js) -----------------------------------

function ScreenCrashed({ error, reset }) {
  return html`<div class="screen crash">
    <div class="crash__box brackets">
      <${MicroLabel} tone="mint">SYSTEM FAULT<//>
      <h2>${t('界面发生错误')}</h2>
      <p class="t-lo">${String(error?.message || error).slice(0, 200)}</p>
      <${Button} variant="primary" icon="refresh" onClick=${reset}>${t('重新加载界面')}<//>
    </div>
  </div>`;
}

function recoverAccount() {
  if (accountPageStopped || accountRecoveryStarted || net.lastError?.code !== 'INVALID_RECONNECT') return;
  accountRecoveryStarted = true;
  const prev = store.get();
  net.close();
  // A restart may have interrupted the lazy ESM graph. Only the explicit action rebuilds this document, not welcome.
  if (!identity.beginRecovery({ previousPlayerId: prev.me.playerId,
    notice: prev.match.public || prev.room?.inMatch ? 'match' : prev.room ? 'room' : null })) {
    accountRecoveryStarted = false;
    toast(t('无法写入本机存储，可能已满'), 'error');
    return;
  }
  stopAccountPage();
  location.replace('/');
}

function AccountConnectionBanner() {
  const conn = useStore((s) => s.connection);
  const code = conn.lastError?.code;
  if (code !== 'SESSION_IN_USE' && code !== 'REPLACED' && code !== 'INVALID_RECONNECT') return html`<${ConnectionBanner} />`;
  const invalid = code === 'INVALID_RECONNECT';
  const takeover = () => net.takeOver(net.name || store.get().me.name);
  return html`<${Modal} open=${true} priority=${true} closeOnBackdrop=${false} class="account-connection"
    title=${invalid ? t('重新恢复当前账号') : t('接管此账号')}
    actions=${html`
      <${Button} variant="secondary" data-autofocus onClick=${invalid ? recoverAccount : takeover}>${invalid ? t('重新恢复当前账号') : t('接管此账号')}<//>
      <${Button} variant="ghost" onClick=${() => location.replace('/auth')}>${t('返回登录页')}<//>`}>
    <p class="modal__text" role="alert">${invalid ? t('恢复凭证已失效，尚未清除；可重新恢复当前账号') : t('该账号正在其他页面使用；接管会断开那一页')}</p>
  <//>`;
}

function App() {
  const route = useStore(selectRoute);
  useLang(); // a language switch re-renders the whole tree in place
  const [error, resetError] = useErrorBoundary((err) => console.error('[ui] screen crashed', err));
  const Screen = SCREENS[route] || LobbyScreen;
  return html`<div class="app-root">
    <div class="app-bg" aria-hidden="true"></div>
    ${error ? html`<${ScreenCrashed} error=${error} reset=${resetError} />` : html`<${Screen} key=${route} />`}
    <${TrustedNotice} />
    <${AccountConnectionBanner} />
    <${ToastHost} />
    <${UiHosts} />
    <${GuideHost} />
    <${LoadoutHost} />
    <${StatsHost} />
  </div>`;
}

// ---- boot -----------------------------------------------------------------------------------------

async function waitForFonts(ms) {
  const fonts = document.fonts;
  if (!fonts || typeof fonts.load !== 'function') return;
  const loads = [
    fonts.load('900 1em "Noto Sans SC"', '卫戍协议盟约'), // i18n-ignore (font sample)
    fonts.load('700 1em "Noto Sans SC"', '开始'), // i18n-ignore (font sample)
    fonts.load('700 1em Bender', '0123456789'),
    fonts.load('700 1em Rajdhani', '0123456789'),
  ].map((p) => p.catch(() => null));
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, ms))]);
}

function installGlobalErrorHandlers() {
  window.addEventListener('unhandledrejection', (ev) => {
    if (accountPageStopped) return;
    const err = ev.reason;
    // Media autoplay/abort rejections (audio.play() before a user gesture, interrupted loads) are
    // expected browser behaviour, not app errors: log quietly, never toast.
    if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) { console.warn('[app] ignored rejection', err.name); return; }
    console.error('[app] unhandled rejection', err);
    recordError('rejection', err);
    if (err instanceof NetError) toastError(err);
    else toast(t('发生意外错误：{error}', { error: describeError(err) }).slice(0, 120), 'error');
  });
  window.addEventListener('error', (ev) => {
    if (!(ev instanceof ErrorEvent)) return; // resource load errors are not script errors
    console.error('[app] uncaught error', ev.error || ev.message);
    recordError('error', ev.error || ev.message, ev.error ? null : `${ev.filename || '?'}:${ev.lineno || 0}:${ev.colno || 0}`);
  });
}

function stopAccountPage() {
  if (accountPageStopped) return;
  accountPageStopped = true;
  stopAssetWarmup?.();
  accounts.suspendAccount();
  // Terminal before logout: stop traffic and prevent this document's caches from being reused by another login.
  try { stopPluginFrames?.(); } catch (err) { console.warn('[accounts] plugin cleanup failed', err); }
  setAccountScope(null);
  net?.setAccount(null);
  identity?.setAccount(null);
  clearTimeout(restoreTimer); clearTimeout(joinTimer);
  try { rehearsal?.clear(); } catch (err) { console.warn('[accounts] rehearsal cleanup failed', err); }
  try { closeAllDialogs?.(); } catch (err) { console.warn('[accounts] dialog cleanup failed', err); }
  try { buildGuard?.stop(); } catch (err) { console.warn('[accounts] build guard cleanup failed', err); }
  buildGuard = null;
  store.reset();
  if (typeof render === 'function') render(null, document.getElementById('app'));
}

async function boot() {
  accounts.configureAccountLifecycle({ stop: stopAccountPage, navigate: (path) => location.replace(path) });
  const verifiedAccount = await accounts.refreshAccount();
  if (accountPageStopped) return;
  if (!verifiedAccount?.id || !/^a_[0-9a-f]{32}$/.test(verifiedAccount.id)) { location.replace('/auth'); return; }
  setAccountScope(verifiedAccount.id);
  ({ net, identity, NetError } = await import('./net.js'));
  if (accountPageStopped) { net.setAccount(null); identity.setAccount(null); return; }
  identity.setAccount(verifiedAccount);
  net.setAccount(verifiedAccount);
  await loadGameGraph();
  if (accountPageStopped) { stopPluginFrames?.(); return; }
  accounts.startAccounts();
  installGlobalErrorHandlers();
  // what this page downloads, by category, for the 问题反馈 report's traffic line (diag.js; nothing is sent anywhere)
  installTrafficMeter();
  // touch / hover / fullscreen classes, zoom-gesture blocking, rotation re-layout (ui/device.js, css/devices.css)
  installDeviceSupport();
  // Hashed art a player imported. HTTPS or localhost only; a failure here must not stop boot.
  void registerImportedAssetWorker();
  // A page restored from the back/forward cache has a dead socket and a stale token choice: start over.
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) location.reload(); });
  // Only after the HTTP account binding may this tab restore its game reconnect claim.
  const identityReady = identity.init();

  const pendingJoin = parseRoomParam(location.search);
  const savedName = sanitizeName(identity.loadName() || verifiedAccount.name);
  const entered = identity.wasEntered() && !!savedName;
  store.set((s) => ({
    me: { ...s.me, name: savedName },
    session: { entered },
    ui: { ...s.ui, pendingJoin },
  }));

  wireNet();
  installStatsRecorder(store); // follows the match on screen, so a 放弃模拟 can be recorded (ui/stats.js)
  installLoadoutSync({ net });
  installOwnershipSync({ net });
  installDiySync({ net });
  // 干员皮肤 (docs/SKINS.md): keeps the server's copy of this browser's chosen appearances current (room.skins), from
  // ui/skins.js' own store — its 皮肤 section is rendered by screens/loadout.js.
  installSkinsSync({ net });
  // the room's cosmetic plugins and the player's own over the art manifest (content.js; nothing is fetched without them)
  installContent({ toast });
  // a room with gameplay plugins: its content set downloaded, checked and shown (content.js — DESIGN §32.6)
  installContentSet({ toast });
  // A bot prep's layout rehearsal the server offers this host's browser (DESIGN §14, SP_BOT_REHEARSAL=host on the
  // server): a same-origin module Worker simulates the candidates off the main thread and answers with its pick; a
  // browser that cannot run one answers `error` and the server rehearses itself. Nothing happens while the server
  // does not delegate. A gameplay-plugin room is never offered (the server keeps that rehearsal).
  rehearsal = installRehearsal({ net });
  net.attachBrowserHooks();
  // Audio: unlock on first gesture, BGM follows the route / match phase (js/audio.js).
  // a cosmetic plugin's sound that will not load falls back like its art (content.js, DESIGN §32 P1a)
  installAudio({ getManifest: () => data.get('assets'), subscribe: store.subscribe, getState: store.get, selectRoute, settings: settingsStore.get(),
    onFailed: (url) => cosmetics.fail(url) });
  // …and the music follows the art: the screen's track again when the cosmetic layers change its URLs
  cosmetics.subscribe(() => audio.refreshBgm());
  data.load('assets').catch(() => {});
  // Warm the data cache in the background (missing files are tolerated).
  data.loadAll('config').catch(() => {});
  // Optional local-client art manifest (emotes, tutorial pages, official UI sprites; DESIGN §13).
  data.load('local').catch(() => {});

  const connectWhenReady = identityReady.then(() => {
    if (accountPageStopped) return;
    if (entered) net.setName(savedName);
    else net.connect();
  });
  // the language (and its UI translations) before the first render: no Chinese flash for an English player
  const langReady = initLang().catch((err) => console.warn('[app] language setup failed', err));
  await Promise.all([waitForFonts(1200), connectWhenReady, langReady]);
  if (accountPageStopped) return;
  const root = document.getElementById('app');
  render(html`<${App} />`, root);

  const splash = document.getElementById('boot');
  if (splash) {
    splash.classList.add('is-done');
    setTimeout(() => splash.remove(), 300);
  }
  globalThis.__SP__ = { store, net, data, version: 1 };
  // A page keeps the modules it imported at load time for its whole lifetime, so a deploy cannot reach an open tab
  // (ui/buildGuard.js): watch `/healthz.build`. Outside a match the page reloads itself; during a match the guard says
  // so instead (the connection banner offers 刷新页面) and reloads once the match — settlement screen included — is over,
  // so a running game is never thrown away.
  try {
    buildGuard = startBuildGuard({
      inMatch: () => selectRoute(store.get()) === 'game',
      onStale: ({ waiting }) => { if (!accountPageStopped && waiting) store.patch('ui', { buildStale: true }); },
      // the same /healthz names how many plugins the server has: the title screen shows it before any hello
      onHealth: (h) => {
        if (accountPageStopped) return;
        const n = pluginCount(h.content), notices = h.content?.notices === true;
        if (n !== store.get().installedPlugins || notices !== store.get().installedNotices) store.set({ installedPlugins: n, installedNotices: notices });
      },
    });
  } catch (err) {
    console.warn('[app] build guard failed to start', err);
  }
}

boot().catch((err) => {
  if (accountPageStopped) return;
  console.error('[app] boot failed', err);
  const el = document.getElementById('boot-err');
  if (el) el.textContent = t('启动失败，请刷新页面重试');
});
