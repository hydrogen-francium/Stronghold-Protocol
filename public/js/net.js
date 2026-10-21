// WebSocket client for the game server (DESIGN §8).
//
// - One socket at ws(s)://<host>/ws, JSON text frames `{ t, ...payload }`.
// - Auto-reconnect with exponential backoff + jitter; a heartbeat (`ping`) measures latency and
//   detects dead sockets (a ping left unanswered — no inbound frame at all — for DEAD_AFTER_MS ⇒
//   close ⇒ reconnect). Measured from the oldest unanswered ping, not from the last inbound frame,
//   so a background tab whose timers the browser throttles to ~1/min is not mistaken for dead.
// - On every (re)connect, once a player name is known, sends `hello {name, token, version}`;
//   the session is "online" after `welcome`.
// - `request(t, fields)` adds a `rid` and resolves on the matching `ok` (or any reply carrying the
//   rid), rejects with a NetError on `error` or after REQUEST_TIMEOUT_MS. Requests made while
//   reconnecting are queued and flushed after `welcome` (still bound by their timeout).
// - Every server push is emitted by its `t` (see shared/protocol.js S2C) and as '*'.
//   Extra events: 'status', 'ping', 'clock', 'helloError', 'unhandledError', 'replaced'.
// - Server close code 4001 ("session replaced": the same token connected from another tab) stops
//   auto-reconnect (status 'closed', lastError REPLACED) so two tabs never fight over one session.
// - Before a name is known (title screen) the socket only pings; the server closes such sockets
//   with 4002 (hello timeout). That close is answered with a quiet swap: a fresh socket is opened
//   while the status stays 'connected', so the title's server indicator doesn't flicker.
// - Server clock offset (serverNow ≈ Date.now() + offset) from pong samples (lowest RTT wins),
//   bootstrapped from `welcome.serverNow` / `m.public.serverNow`.
//
// Identity persistence is account-scoped. A second tab claims the same account and is refused
// by default; only an explicit user action may set hello.takeover. No guest identity is allocated.
//
// Shared modules are imported relatively: in the browser '../../shared/x.js' from /js/ resolves
// to /shared/x.js (URL resolution clamps at the root); under Node it resolves to <repo>/shared.

import { PROTOCOL_VERSION, ERR_TEXT } from '../../shared/constants.js';
import { validateC2S } from '../../shared/protocol.js';
import { N_ } from '../../shared/i18n.js';

export const REQUEST_TIMEOUT_MS = 8000;
export const HELLO_TIMEOUT_MS = 8000;
export const PING_INTERVAL_MS = 4000;
export const DEAD_AFTER_MS = 15000;
export const BACKOFF = Object.freeze({ base: 500, factor: 2, max: 10000, jitter: 0.2 });

/** Client-side error codes (in addition to shared ERR codes). */
export const CLIENT_ERR_TEXT = Object.freeze({
  TIMEOUT: N_('请求超时，请重试'),
  OFFLINE: N_('未连接到服务器'),
  DISCONNECTED: N_('连接已断开，请重试'),
  CLOSED: N_('连接已关闭'),
  REPLACED: N_('该身份已在其他页面登录'),
  VERSION: N_('客户端版本与服务器不一致，请刷新页面'),
  ACCOUNT_MISMATCH: N_('账号已改变，请重新验证后进入游戏'),
});

/** Server close code: the session was taken over by another socket (server/net.js CLOSE.REPLACED). */
export const CLOSE_REPLACED = 4001;
/** Server close code: the socket never sent `hello` (server/net.js CLOSE.HELLO_TIMEOUT, ~30–60 s). */
export const CLOSE_HELLO_TIMEOUT = 4002;
/** Server-side cookie/session revocation: never retry under a stale account. */
export const CLOSE_AUTH_REQUIRED = 4003;
const ACCOUNT_ID = /^a_[0-9a-f]{32}$/;
/** A pre-hello socket must have lived this long before a 4002 close is swapped quietly (no loop). */
const QUIET_SWAP_MIN_AGE_MS = 5000;

/**
 * Human readable (Chinese) text for an error code.
 * @param {string} code
 * @param {string} [msg] server-provided message (fallback)
 * @returns {string}
 */
export function errorText(code, msg) {
  return ERR_TEXT[code] || CLIENT_ERR_TEXT[code] || (typeof msg === 'string' && msg) || String(code || N_('未知错误'));
}

/** Error thrown/rejected by requests. `code` is an ERR code or a CLIENT_ERR_TEXT key. */
export class NetError extends Error {
  /** @param {string} code @param {string} [msg] server text @param {string} [detail] server developer detail */
  constructor(code, msg, detail) {
    const versionMismatch = typeof detail === 'string' && /version/i.test(detail);
    super(versionMismatch ? CLIENT_ERR_TEXT.VERSION : errorText(code, msg));
    this.name = 'NetError';
    this.code = String(code || 'INTERNAL');
    this.serverMsg = msg ?? null;
    this.detail = typeof detail === 'string' ? detail : null;
  }
}

/**
 * Reconnect delay for the n-th consecutive failed attempt (0-based), with ±jitter.
 * @param {number} attempt
 * @param {() => number} [rand]
 * @returns {number} milliseconds
 */
export function backoffDelay(attempt, rand = Math.random) {
  const n = Math.max(0, Math.min(30, Math.floor(Number(attempt) || 0)));
  const raw = Math.min(BACKOFF.max, BACKOFF.base * BACKOFF.factor ** n);
  const jitter = raw * BACKOFF.jitter * (rand() * 2 - 1);
  return Math.max(100, Math.round(raw + jitter));
}

/**
 * WebSocket URL for the current page (`ws(s)://host/ws`).
 * @param {{protocol: string, host: string}} [loc]
 * @returns {string}
 */
export function defaultWsUrl(loc = globalThis.location) {
  if (!loc || !loc.host) return 'ws://localhost:3000/ws';
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

const WS_OPEN = 1;
const WS_CONNECTING = 0;

/**
 * Game server connection. Construct with injectable dependencies for tests.
 */
export class Net {
  /**
   * @param {object} [opts]
   * @param {string} [opts.url] socket URL (default: derived from location at connect time)
   * @param {any} [opts.WebSocket] WebSocket constructor (default: globalThis.WebSocket)
   * @param {() => (string|null)} [opts.getToken] reconnect-token provider for `hello`
   * @param {() => ({ noReplace: boolean, claimAt?: number })} [opts.getTokenClaim] local ownership for this hello
   * @param {() => (string|null)} [opts.getAccountId] currently verified identity owner; mismatches stop the document
   * @param {() => number} [opts.now]
   * @param {() => number} [opts.random]
   * @param {{setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function}} [opts.timers]
   */
  constructor(opts = {}) {
    this.url = opts.url || null;
    this.WS = opts.WebSocket || null;
    this.getToken = typeof opts.getToken === 'function' ? opts.getToken : () => null;
    this.getTokenClaim = typeof opts.getTokenClaim === 'function' ? opts.getTokenClaim : () => null;
    this.getAccountId = typeof opts.getAccountId === 'function' ? opts.getAccountId : () => this.accountId;
    this.accountId = null;
    this._documentAccountId = null;
    this._socketAccountId = null;
    this._helloAccountId = null;
    this._authBlocked = false;
    this._takeoverNext = false;
    this.now = opts.now || (() => Date.now());
    this.random = opts.random || Math.random;
    this.timers = opts.timers || {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id) => globalThis.clearTimeout(id),
      setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
      clearInterval: (id) => globalThis.clearInterval(id),
    };

    /** @type {'idle'|'connecting'|'connected'|'handshaking'|'online'|'reconnecting'|'closed'} */
    this.status = 'idle';
    this.ws = null;
    this.name = null;          // desired player name (hello is sent when set)
    this.helloName = null;     // name we sent in the hello that got the last welcome
    this.serverName = null;    // name as normalised by the server
    this.playerId = null;
    this.attempt = 0;          // consecutive failed connection attempts
    this.retryAt = 0;          // epoch ms of the next reconnect attempt (0 = none)
    this.ping = null;          // last RTT in ms
    this.lastError = null;     // last NetError relevant to the connection (e.g. hello rejected)
    this.clockOffset = 0;
    this.clockSynced = false;

    this._rid = 0;
    this._pending = new Map(); // rid -> { msg, resolve, reject, timer, sent }
    this._expired = new Set(); // rids that timed out locally (their late error was already reported)
    this._listeners = new Map();
    this._manualClose = false;
    this._quietSwap = false;   // next connect() keeps the current status (see CLOSE_HELLO_TIMEOUT)
    this._openedAt = 0;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._helloTimer = null;
    this._helloRid = null;
    this._helloSentName = null;
    this._helloToken = null;
    this._lastRx = 0;
    this._unansweredSince = null; // time of the oldest ping sent since the last inbound frame
    this._clockSamples = [];   // [{ offset, rtt }]
  }

  // ---- events ----------------------------------------------------------------------------------

  /**
   * Subscribe to a message type (any S2C `t`), '*' (all messages) or a client event
   * ('status' | 'ping' | 'clock' | 'helloError' | 'unhandledError').
   * @param {string} type
   * @param {(payload: any) => void} fn
   * @returns {() => void} unsubscribe
   */
  on(type, fn) {
    if (typeof fn !== 'function') return () => {};
    let set = this._listeners.get(type);
    if (!set) this._listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => this.off(type, fn);
  }

  /** @param {string} type @param {Function} fn */
  off(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }

  _emit(type, payload) {
    const set = this._listeners.get(type);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.error(`[net] listener for "${type}" failed`, err); }
    }
  }

  /** Snapshot of the connection state (what the 'status' event carries). */
  snapshot() {
    return {
      status: this.status, attempt: this.attempt, retryAt: this.retryAt, ping: this.ping,
      lastError: this.lastError ? { code: this.lastError.code, text: this.lastError.message } : null,
      playerId: this.playerId,
    };
  }

  _setStatus(status) {
    this.status = status;
    this._emit('status', this.snapshot());
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  /** One verified account per document. Binding never reads or fabricates an authentication cookie. */
  setAccount(account) {
    const id = typeof account === 'string' ? account : account?.id;
    if (id == null) {
      this._authBlocked = true;
      this.close(); this.accountId = null; this.playerId = null; this.name = null;
      this.helloName = null; this.serverName = null; return;
    }
    if (typeof id !== 'string' || !ACCOUNT_ID.test(id)) throw new Error('Invalid account binding');
    if (this._documentAccountId && this._documentAccountId !== id) {
      this._authenticationLost('ACCOUNT_MISMATCH');
      throw new Error('Account changes require a page reload');
    }
    this._documentAccountId = id; this.accountId = id;
  }

  _accountMatches() {
    return ACCOUNT_ID.test(this.accountId || '') && this.getAccountId() === this.accountId;
  }

  _authenticationLost(code = 'AUTH_REQUIRED') {
    if (this._authBlocked) { this._failPending(code, true); return; }
    this._authBlocked = true;
    this.close();
    this.accountId = null; this.playerId = null; this.name = null; this.helloName = null;
    this.lastError = new NetError(code);
    this._emit('status', this.snapshot());
    this._emit('authRequired', this.lastError);
  }

  /** This method is called only by the clearly labelled account takeover button. */
  takeOver(name = this.name) {
    if (!this._accountMatches() || this._authBlocked) return false;
    this.name = name; this._takeoverNext = true; this._manualClose = false;
    this.reconnectNow(name); return true;
  }

  /** Open the socket (no-op when already open/connecting). Also resumes after close()/replacement. */
  connect() {
    if (this._authBlocked) return;
    if (!this._accountMatches()) { this._authenticationLost('ACCOUNT_MISMATCH'); return; }
    const quiet = this._quietSwap;
    this._quietSwap = false;
    if (this.ws && (this.ws.readyState === WS_OPEN || this.ws.readyState === WS_CONNECTING)) return;
    this._manualClose = false;
    this._clearTimer('_reconnectTimer', 'clearTimeout');
    this.retryAt = 0;
    const WS = this.WS || globalThis.WebSocket;
    const url = this.url || defaultWsUrl();
    let ws;
    try {
      ws = new WS(url);
    } catch (err) {
      console.warn('[net] cannot create WebSocket', err);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    this._socketAccountId = this.accountId;
    if (!quiet) this._setStatus(this.attempt > 0 ? 'reconnecting' : 'connecting');
    ws.onopen = () => { if (ws === this.ws) this._onOpen(); };
    ws.onmessage = (ev) => { if (ws === this.ws) this._onMessage(ev?.data); };
    ws.onerror = () => { /* followed by close */ };
    ws.onclose = (ev) => { if (ws === this.ws) this._onClose(ev); };
  }

  /** Close for good (no reconnect). Pending requests reject with CLOSED. */
  close() {
    this._manualClose = true;
    this._takeoverNext = false;
    this._clearTimer('_reconnectTimer', 'clearTimeout');
    this.retryAt = 0;
    const ws = this.ws;
    this._teardownSocket();
    try { ws?.close(1000, 'client close'); } catch { /* ignore */ }
    this._failPending('CLOSED', true);
    this._setStatus('closed');
  }

  /** Skip the backoff wait and reconnect right now (used on `online` / tab focus / retry button). */
  retryNow() {
    if (this._manualClose) return;
    if (this.ws && (this.ws.readyState === WS_OPEN || this.ws.readyState === WS_CONNECTING)) return;
    this.connect();
  }

  /** Drop the current socket and reconnect immediately (fresh hello). */
  reconnectNow(name = this.name) {
    if (this._manualClose) return;
    this.name = name;
    const ws = this.ws;
    this._teardownSocket();
    try { ws?.close(4000, 'reconnect'); } catch { /* ignore */ }
    this._failPending('DISCONNECTED', false);
    this.attempt = 0;
    this.connect();
  }

  /**
   * Set the player name used in `hello`. Sends hello right away when the socket is open (the server
   * accepts a repeated hello on a live socket: it renames the session and resyncs room/match
   * state), otherwise as soon as it opens. No-op when that name is already accepted.
   * @param {string} name
   */
  setName(name) {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n) return;
    const changed = n !== this.name;
    this.name = n;
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      if (!this.ws && !this._reconnectTimer && !this._manualClose) this.connect();
      return; // hello goes out on open
    }
    if (this.status === 'online' && this.helloName === n) return;
    if (this.status === 'handshaking' && !changed && this._helloSentName === n) return;
    // The server accepts a repeated hello on a live socket (it renames the session and resyncs).
    this._sendHello();
  }

  _onOpen() {
    if (!this._accountMatches() || this._socketAccountId !== this.accountId) { this._authenticationLost('ACCOUNT_MISMATCH'); return; }
    this._openedAt = this.now();
    this._lastRx = this._openedAt;
    this._unansweredSince = null;
    this.retryAt = 0;
    this._startHeartbeat();
    if (this.name) {
      this._setStatus('handshaking');
      this._sendHello();
    } else {
      this.attempt = 0;
      this._setStatus('connected');
      this._sendPing();
    }
  }

  _onClose(ev) {
    this._teardownSocket();
    if (ev?.code === CLOSE_AUTH_REQUIRED) { this._authenticationLost(); return; }
    if (!this._accountMatches()) { this._authenticationLost('ACCOUNT_MISMATCH'); return; }
    this._failPending('DISCONNECTED', false);
    if (this._manualClose) { this._setStatus('closed'); return; }
    if (ev && ev.code === CLOSE_REPLACED) {
      // Another tab/socket took this session over: don't fight it; the user may reconnect manually.
      this._manualClose = true;
      this._failPending('REPLACED', true);
      this.lastError = new NetError('REPLACED');
      this._setStatus('closed');
      this._emit('replaced', this.lastError);
      return;
    }
    if (ev && ev.code === CLOSE_HELLO_TIMEOUT && !this.name && this.status === 'connected'
        && this.now() - this._openedAt >= QUIET_SWAP_MIN_AGE_MS) {
      // Idle pre-hello socket dropped by the server: replace it without a visible status change.
      this._quietSwap = true;
      this.connect();
      return;
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._manualClose) return;
    const delay = backoffDelay(this.attempt, this.random);
    this.attempt += 1;
    this.retryAt = this.now() + delay;
    this._clearTimer('_reconnectTimer', 'clearTimeout');
    this._reconnectTimer = this.timers.setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
    this._setStatus('reconnecting');
  }

  _teardownSocket() {
    const ws = this.ws;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    }
    this.ws = null;
    this._unansweredSince = null;
    this._clearTimer('_pingTimer', 'clearInterval');
    this._clearTimer('_helloTimer', 'clearTimeout');
    this._helloRid = null;
    this._helloSentName = null;
  }

  _clearTimer(field, fn) {
    if (this[field] != null) {
      try { this.timers[fn](this[field]); } catch { /* ignore */ }
      this[field] = null;
    }
  }

  // ---- handshake -------------------------------------------------------------------------------

  _sendHello() {
    if (!this.name) return;
    if (!this._accountMatches() || this._socketAccountId !== this.accountId) { this._authenticationLost('ACCOUNT_MISMATCH'); return; }
    const rid = this._nextRid();
    const takeover = this._takeoverNext;
    const msg = { t: 'hello', rid, name: this.name, version: PROTOCOL_VERSION, noReplace: !takeover };
    if (takeover) { msg.takeover = true; this._takeoverNext = false; }
    let token = null;
    try { token = this.getToken(); } catch { token = null; }
    if (typeof token === 'string' && token.length > 0 && token.length <= 64) {
      msg.token = token;
      const claim = this.getTokenClaim();
      if (!takeover && claim?.noReplace) msg.noReplace = true;
      if (Number.isFinite(claim?.claimAt)) msg.claimAt = claim.claimAt;
    }
    this._helloToken = token;
    this._helloAccountId = this.accountId;
    this._helloRid = rid;
    this._helloSentName = this.name;
    if (this.status !== 'handshaking') this._setStatus('handshaking');
    if (!this._sendRaw(msg)) return;
    this._clearTimer('_helloTimer', 'clearTimeout');
    this._helloTimer = this.timers.setTimeout(() => {
      this._helloTimer = null;
      if (this.status !== 'handshaking') return;
      console.warn('[net] hello timed out; reconnecting');
      const ws = this.ws;
      this._teardownSocket();
      try { ws?.close(4000, 'hello timeout'); } catch { /* ignore */ }
      this._failPending('DISCONNECTED', false);
      this._scheduleReconnect();
    }, HELLO_TIMEOUT_MS);
  }

  _onWelcome(msg) {
    if (!this._accountMatches() || this._socketAccountId !== this.accountId
        || this._helloAccountId !== this.accountId || msg.account?.id !== this.accountId) {
      this._authenticationLost('ACCOUNT_MISMATCH'); return;
    }
    this._clearTimer('_helloTimer', 'clearTimeout');
    this._helloRid = null;
    // Compare future setName() calls against what we sent (the server may normalise the name).
    this.helloName = this._helloSentName;
    this.serverName = typeof msg.name === 'string' && msg.name ? msg.name : this._helloSentName;
    this.playerId = msg.playerId ?? null;
    this.attempt = 0;
    this.lastError = null;
    if (Number.isFinite(msg.serverNow)) this._addClockSample(msg.serverNow + (this.ping ?? 0) / 2 - this.now(), Infinity);
    this._setStatus('online');
    this._flushQueue();
    this._sendPing();
  }

  _onHelloError(msg) {
    if (msg.code === 'AUTH_REQUIRED' || msg.code === 'ACCOUNT_MISMATCH') { this._authenticationLost(msg.code); return; }
    this._clearTimer('_helloTimer', 'clearTimeout');
    this._helloRid = null;
    this.lastError = new NetError(msg.code, msg.msg, msg.detail);
    // Bad reconnects and a live account in another tab require an explicit user choice.
    if (msg.code === 'INVALID_RECONNECT' || msg.code === 'SESSION_IN_USE') {
      const ws = this.ws;
      this._teardownSocket(); this._manualClose = true; this.retryAt = 0;
      this._clearTimer('_reconnectTimer', 'clearTimeout');
      try { ws?.close(1000, 'account recovery required'); } catch { /* ignore */ }
      this._setStatus('closed');
    } else this._setStatus('connected');
    this._failPending('OFFLINE', true);
    this._emit('helloError', this.lastError);
  }

  // ---- requests --------------------------------------------------------------------------------

  _nextRid() {
    this._rid = (this._rid % 2147483000) + 1;
    return this._rid;
  }

  /**
   * Send a request and wait for its `ok` (resolves with the reply message) or `error`
   * (rejects with NetError). Rejects with TIMEOUT after `timeout` ms, OFFLINE when there is no
   * session to send it on, BAD_MSG when it fails shared/protocol.js validation locally.
   * @param {string} t message type (C2S)
   * @param {object} [fields]
   * @param {{timeout?: number}} [opts]
   * @returns {Promise<any>}
   */
  request(t, fields = {}, opts = {}) {
    return new Promise((resolve, reject) => {
      if (!this._accountMatches() || this._authBlocked) {
        this._authenticationLost('ACCOUNT_MISMATCH'); reject(new NetError('ACCOUNT_MISMATCH')); return;
      }
      if (t === 'hello') { reject(new NetError('BAD_MSG', 'use setName() for hello')); return; }
      const rid = this._nextRid();
      const msg = { ...(fields && typeof fields === 'object' ? fields : {}), t, rid };
      const bad = validateC2S(msg);
      if (bad) {
        console.warn(`[net] refusing invalid ${t}: ${bad}`);
        reject(new NetError('BAD_MSG', bad));
        return;
      }
      // Queue while a session is being (re)established; fail fast when none can come.
      const establishing = this.status === 'connecting' || this.status === 'handshaking' || this.status === 'reconnecting';
      if (this.status !== 'online' && !(establishing && this.name && !this._manualClose)) {
        reject(new NetError(this._manualClose ? 'CLOSED' : 'OFFLINE'));
        return;
      }
      const timeout = Number.isFinite(opts.timeout) && opts.timeout > 0 ? opts.timeout : REQUEST_TIMEOUT_MS;
      const entry = { msg, resolve, reject, sent: false, timer: null, accountId: this.accountId };
      entry.timer = this.timers.setTimeout(() => {
        if (this._pending.get(rid) !== entry) return;
        this._pending.delete(rid);
        if (entry.sent) {
          this._expired.add(rid);
          if (this._expired.size > 64) this._expired.delete(this._expired.values().next().value);
        }
        reject(new NetError('TIMEOUT'));
      }, timeout);
      this._pending.set(rid, entry);
      if (this.status === 'online') entry.sent = this._sendRaw(msg);
    });
  }

  /**
   * Fire-and-forget message (no rid). Returns false when it could not be sent.
   * @param {string} t
   * @param {object} [fields]
   * @returns {boolean}
   */
  send(t, fields = {}) {
    if (!this._accountMatches() || this._authBlocked) { this._authenticationLost('ACCOUNT_MISMATCH'); return false; }
    if (t === 'hello') return false;
    const msg = { ...(fields && typeof fields === 'object' ? fields : {}), t };
    const bad = validateC2S(msg);
    if (bad) { console.warn(`[net] refusing invalid ${t}: ${bad}`); return false; }
    if (this.status !== 'online') return false;
    return this._sendRaw(msg);
  }

  _sendRaw(obj) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      console.warn('[net] send failed', err);
      return false;
    }
  }

  _flushQueue() {
    if (this._manualClose || !this._accountMatches() || this._socketAccountId !== this.accountId) {
      this._failPending('ACCOUNT_MISMATCH', true); return;
    }
    for (const [rid, entry] of [...this._pending]) {
      if (entry.accountId !== this.accountId) {
        this._pending.delete(rid); this._clearEntryTimer(entry); entry.reject(new NetError('ACCOUNT_MISMATCH')); continue;
      }
      if (!entry.sent) entry.sent = this._sendRaw(entry.msg);
    }
  }

  /**
   * Reject pending requests. Sent ones always fail (their reply is lost with the socket);
   * unsent (queued) ones fail only when `includeQueued` is true.
   */
  _failPending(code, includeQueued) {
    for (const [rid, entry] of [...this._pending]) {
      if (!entry.sent && !includeQueued) continue;
      this._pending.delete(rid);
      this._clearEntryTimer(entry);
      try { entry.reject(new NetError(code)); } catch { /* ignore */ }
    }
  }

  _clearEntryTimer(entry) {
    if (entry.timer != null) {
      try { this.timers.clearTimeout(entry.timer); } catch { /* ignore */ }
      entry.timer = null;
    }
  }

  /** Number of requests waiting for a reply (sent or queued). */
  get pendingCount() {
    return this._pending.size;
  }

  // ---- incoming --------------------------------------------------------------------------------

  _onMessage(data) {
    if (!this._accountMatches() || this._socketAccountId !== this.accountId) { this._authenticationLost('ACCOUNT_MISMATCH'); return; }
    this._lastRx = this.now();
    this._unansweredSince = null;
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      console.warn('[net] dropped non-JSON frame');
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return;
    const { t } = msg;
    if (t === 'error' && (msg.code === 'AUTH_REQUIRED' || msg.code === 'ACCOUNT_MISMATCH')) {
      this._authenticationLost(msg.code); return;
    }
    const rid = msg.rid;
    const isHelloError = t === 'error' && rid != null && rid === this._helloRid;

    if (t === 'welcome') {
      // Authenticate BEFORE status=online, publishing the welcome or flushing any queued game request.
      if (!this._accountMatches() || this._socketAccountId !== this.accountId
          || this._helloAccountId !== this.accountId || msg.account?.id !== this.accountId) {
        this._authenticationLost('ACCOUNT_MISMATCH'); return;
      }
      if (this._helloToken !== this.getToken()) { this.reconnectNow(); return; }
      this._onWelcome(msg);
      if (this._manualClose || !this._accountMatches() || this.status !== 'online') return;
    } else if (t === 'pong') {
      this._onPong(msg);
    } else if (isHelloError) {
      this._onHelloError(msg);
    } else if (t === 'm.public' && Number.isFinite(msg.serverNow) && !this.clockSynced) {
      this._addClockSample(msg.serverNow + (this.ping ?? 0) / 2 - this.now(), Infinity);
    }

    let handled = false;
    if (rid != null && t !== 'welcome' && this._pending.has(rid)) {
      const entry = this._pending.get(rid);
      this._pending.delete(rid);
      this._clearEntryTimer(entry);
      handled = true;
      try {
        if (t === 'error') entry.reject(new NetError(msg.code, msg.msg, msg.detail));
        else entry.resolve(msg);
      } catch (err) { console.error('[net] request callback failed', err); }
    }
    const late = rid != null && !handled && this._expired.delete(rid); // reply to a request that already timed out
    if (t === 'error' && !handled && !isHelloError && !late) {
      this._emit('unhandledError', new NetError(msg.code, msg.msg, msg.detail));
    }

    this._emit(t, msg);
    this._emit('*', msg);
  }

  // ---- heartbeat & clock -----------------------------------------------------------------------

  _startHeartbeat() {
    this._clearTimer('_pingTimer', 'clearInterval');
    this._pingTimer = this.timers.setInterval(() => this._heartbeat(), PING_INTERVAL_MS);
  }

  _heartbeat() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return;
    if (!this._accountMatches() || this._socketAccountId !== this.accountId) { this._authenticationLost('ACCOUNT_MISMATCH'); return; }
    const live = this.status === 'online' || this.status === 'connected';
    if (live && this._unansweredSince != null && this.now() - this._unansweredSince > DEAD_AFTER_MS) {
      console.warn('[net] connection silent; reconnecting');
      this._teardownSocket();
      try { ws.close(4000, 'heartbeat timeout'); } catch { /* ignore */ }
      this._failPending('DISCONNECTED', false);
      this._scheduleReconnect();
      return;
    }
    this._sendPing();
  }

  _sendPing() {
    if (this.status !== 'online' && this.status !== 'connected') return;
    const now = this.now();
    if (this._sendRaw({ t: 'ping', c: now }) && this._unansweredSince == null) this._unansweredSince = now;
  }

  /** Force an immediate latency probe (e.g. when the tab regains focus). */
  probe() {
    this._heartbeat();
  }

  _onPong(msg) {
    const now = this.now();
    const c = Number(msg.c);
    if (!Number.isFinite(c)) return;
    const rtt = now - c;
    if (!(rtt >= 0 && rtt < 60000)) return;
    this.ping = Math.round(rtt);
    if (Number.isFinite(msg.s)) this._addClockSample(msg.s + rtt / 2 - now, rtt);
    this._emit('ping', this.ping);
    this._emit('status', this.snapshot());
  }

  _addClockSample(offset, rtt) {
    if (!Number.isFinite(offset)) return;
    this._clockSamples.push({ offset, rtt });
    if (this._clockSamples.length > 8) this._clockSamples.shift();
    let best = this._clockSamples[0];
    for (const s of this._clockSamples) if (s.rtt < best.rtt) best = s;
    const prev = this.clockOffset;
    this.clockOffset = Math.round(best.offset);
    const wasSynced = this.clockSynced;
    this.clockSynced = this.clockSynced || Number.isFinite(rtt);
    if (Math.abs(prev - this.clockOffset) >= 1 || wasSynced !== this.clockSynced || this._clockSamples.length === 1) {
      this._emit('clock', { offset: this.clockOffset, rtt: Number.isFinite(best.rtt) ? best.rtt : null, synced: this.clockSynced });
    }
  }

  /** Current server time estimate (ms epoch). */
  serverNow() {
    return this.now() + this.clockOffset;
  }

  /**
   * Hook browser signals: reconnect immediately when the network comes back or the tab becomes
   * visible, and probe latency on focus. Safe to call in non-browser environments (no-op).
   */
  attachBrowserHooks() {
    if (typeof window === 'undefined' || this._hooked) return;
    this._hooked = true;
    window.addEventListener('online', () => this.retryNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (this.status === 'reconnecting') this.retryNow();
      else if (this.status === 'online' || this.status === 'connected') this.probe();
    });
  }
}

// ---- account-scoped identity persistence ----------------------------------------------------------
// Reconnect tokens are game-session claims, NOT authentication credentials. Nothing is read until
// setAccount() receives the verified HTTP identity. Old sp.* guest data is never adopted.
const RECENT_MAX = 4;
const TOKEN_MAX_LEN = 64;
const RECOVERY_NOTICE = Object.freeze({
  match: N_('服务器会话已重置，上一局模拟已结束'),
  room: N_('服务器会话已重置，已返回大厅'),
});
export const CLAIM_QUERY_MS = 150; // compatibility export; no BroadcastChannel guest election remains
function safeStorage(kind) { try { return globalThis[kind] || null; } catch { return null; } }
function sget(s, k) { try { return s && k ? s.getItem(k) : null; } catch { return null; } }
function sset(s, k, v) { try { if (s && k) s.setItem(k, v); } catch { /* quota / privacy mode */ } }
function sdel(s, k) { try { if (s && k) s.removeItem(k); } catch { /* ignore */ } }
const isToken = (t) => typeof t === 'string' && t.length > 0 && t.length <= TOKEN_MAX_LEN;

/** Stable token metadata ID; no cleartext token is used as a display identifier. */
export function tokenHash(token) {
  let h = 2166136261;
  const s = String(token);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** No storage access (even probing) or channels during module evaluation. */
export function createIdentity(deps = {}) {
  let local = null, session = null;
  let accountId = null, documentAccountId = null;
  let keys = null;
  let current = null, welcomeAt = null, initialized = false, recovery = null;
  const now = deps.now || (() => Date.now());
  const readRecovery = () => {
    try {
      const value = JSON.parse(sget(session, keys?.recovery) || 'null');
      if (value?.v !== 1 || !(value.previousPlayerId === null
        || (typeof value.previousPlayerId === 'string' && value.previousPlayerId.length > 0 && value.previousPlayerId.length <= 64))
        || ![null, 'match', 'room'].includes(value.notice)) return null;
      return { v: 1, previousPlayerId: value.previousPlayerId, notice: value.notice };
    } catch { return null; }
  };
  const readRecent = () => {
    if (!keys) return [];
    try { const value = JSON.parse(sget(local, keys.recent) || '[]'); return Array.isArray(value) ? value.filter(isToken) : []; }
    catch { return []; }
  };
  const writeRecent = (list) => { if (keys) sset(local, keys.recent, JSON.stringify([...new Set(list)].slice(0, RECENT_MAX))); };
  const readMatches = () => {
    if (!keys) return {};
    try { const value = JSON.parse(sget(local, keys.matches) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
    catch { return {}; }
  };
  const rememberMatch = (info) => {
    if (!keys || !current) return;
    const old = readMatches(), next = {};
    for (const token of readRecent()) {
      const hash = tokenHash(token), value = token === current ? info : old[hash];
      if (value && typeof value.name === 'string' && typeof value.code === 'string') next[hash] = { name: value.name.slice(0, 64), code: value.code.slice(0, 32) };
    }
    sset(local, keys.matches, JSON.stringify(next));
  };
  return {
    tabId: deps.tabId || '',
    setAccount(account) {
      const id = typeof account === 'string' ? account : account?.id;
      if (id == null) {
        accountId = null; keys = null; current = null; welcomeAt = null; initialized = false; recovery = null;
        local = null; session = null; return;
      }
      if (typeof id !== 'string' || !ACCOUNT_ID.test(id)) throw new Error('Invalid account binding');
      if (documentAccountId && documentAccountId !== id) throw new Error('Account changes require a page reload');
      if (accountId === id) return;
      documentAccountId = id; accountId = id;
      local = deps.local !== undefined ? deps.local : safeStorage('localStorage');
      session = deps.session !== undefined ? deps.session : safeStorage('sessionStorage');
      const prefix = `sp.account.${id}.identity.`;
      keys = Object.fromEntries(['name', 'token', 'welcome', 'recent', 'matches', 'entered', 'recovery'].map((k) => [k, prefix + k]));
      recovery = readRecovery();
      const own = recovery ? null : sget(session, keys.token);
      current = recovery ? null : isToken(own) ? own : readRecent()[0] || null;
      welcomeAt = null;
      if (current) try {
        const stamp = JSON.parse(sget(session, keys.welcome) || 'null');
        if (stamp?.hash === tokenHash(current) && Number.isFinite(stamp.at) && stamp.at >= 0) welcomeAt = stamp.at;
      } catch { /* stale stamp does not invalidate the saved token */ }
    },
    getAccountId: () => accountId,
    async init() {
      if (!accountId) throw new Error('A verified account is required');
      initialized = true;
      // Do not drop a token on peer conflict. The server denies a live second claim by default.
      return current;
    },
    rememberMatch,
    recoverable() {
      if (recovery) return [];
      const matches = readMatches();
      return readRecent().filter((token) => token !== current).flatMap((token) => {
        const hash = tokenHash(token), value = matches[hash];
        return value && typeof value.name === 'string' && typeof value.code === 'string'
          ? [{ id: hash, name: value.name.slice(0, 64), code: value.code.slice(0, 32) }] : [];
      });
    },
    /** Explicit saved-seat selection still uses noReplace and cannot silently take over another tab. */
    async resume(id) {
      if (!accountId || !initialized || recovery) return false;
      const token = readRecent().find((value) => value !== current && tokenHash(value) === id);
      if (!token || !this.recoverable().some((item) => item.id === id)) return false;
      current = token; welcomeAt = null; return true;
    },
    loadName: () => keys ? (sget(local, keys.name) || '').slice(0, 64) : '',
    saveName: (name) => { if (keys) sset(local, keys.name, String(name).slice(0, 64)); },
    getToken: () => accountId ? current : null,
    getTokenClaim: () => ({ noReplace: true, ...(welcomeAt != null ? { claimAt: welcomeAt } : {}) }),
    // Compatibility: a refused account claim must NOT erase its token and mint a guest.
    rejectToken() {},
    saveToken(token) {
      if (!keys || !isToken(token)) return;
      if (current !== token) { rememberMatch(null); welcomeAt = null; }
      if (welcomeAt == null) welcomeAt = now();
      current = token;
      sset(session, keys.token, token);
      sset(session, keys.welcome, JSON.stringify({ hash: tokenHash(token), at: welcomeAt }));
      writeRecent([token, ...readRecent().filter((value) => value !== token)]);
    },
    /** Only an explicit recovery action calls this; INVALID_RECONNECT alone never does. */
    clearToken() {
      if (!keys) return;
      rememberMatch(null);
      const old = current;
      current = null; welcomeAt = null;
      sdel(session, keys.token); sdel(session, keys.welcome);
      if (old) writeRecent(readRecent().filter((value) => value !== old));
    },
    /** Persist explicit recovery BEFORE destroying the document; a fresh graph must not reuse any old token. */
    beginRecovery({ previousPlayerId = null, notice = null } = {}) {
      if (!keys || !session) return false;
      const next = { v: 1,
        previousPlayerId: typeof previousPlayerId === 'string' && previousPlayerId.length > 0 && previousPlayerId.length <= 64 ? previousPlayerId : null,
        notice: ['match', 'room'].includes(notice) ? notice : null };
      const encoded = JSON.stringify(next);
      try {
        session.setItem(keys.recovery, encoded);
        if (session.getItem(keys.recovery) !== encoded) return false;
      } catch { return false; }
      recovery = next;
      this.clearToken();
      return true;
    },
    /** Called only after Net validates the account's welcome and saveToken accepts its new game token. */
    finishRecovery(playerId) {
      if (!keys || !recovery || !isToken(current) || typeof playerId !== 'string' || !playerId) return null;
      const previous = recovery;
      recovery = null;
      // Either operation can fail in privacy/quota modes; never navigate or replay this notice in this document.
      sset(session, keys.recovery, 'null'); sdel(session, keys.recovery);
      return previous.previousPlayerId && previous.previousPlayerId !== playerId
        ? RECOVERY_NOTICE[previous.notice] || null : null;
    },
    wasEntered: () => keys ? sget(session, keys.entered) === '1' : false,
    setEntered: (on) => { if (keys) { if (on) sset(session, keys.entered, '1'); else sdel(session, keys.entered); } },
  };
}

export const identity = createIdentity();
export const net = new Net({ getToken: () => identity.getToken(), getTokenClaim: () => identity.getTokenClaim(),
  getAccountId: () => identity.getAccountId() });
