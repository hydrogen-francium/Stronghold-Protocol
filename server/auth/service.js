// Entry admission and durable accounts are separate from the game's reconnect token.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { publicAccount, normalizeUsername, sanitizeDisplayName } from './store.js';
import { validatePassword } from './passwords.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
const MAX_BODY = 4096;
const TOKEN = /^[a-f0-9]{64}$/;
const COOKIE_NAMES = Object.freeze({ gate: 'sp_gate', session: 'sp_session', csrf: 'sp_csrf' });
const ACTIONS = new Set(['admit', 'register', 'login', 'logout']);
const HASH_DOMAIN = 'stronghold-auth-v1';
const digest = value => createHash('sha256').update(value).digest('hex');
const secretToken = () => randomBytes(32).toString('hex');

function failure(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}
function constantEqual(a, b) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function positiveInt(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function parseOrigin(value, allowHttp) {
  let url;
  try { url = new URL(value); } catch { throw failure('AUTH_CONFIG'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.origin !== value || url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(allowHttp && loopback && url.protocol === 'http:'))) {
    throw failure('AUTH_CONFIG');
  }
  return url;
}
function readCookies(req) {
  const result = Object.create(null);
  const header = req.headers?.cookie;
  if (typeof header !== 'string' || header.length > 8192) return result;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim(), value = part.slice(eq + 1).trim();
    // Duplicate cookies are ambiguous (a sibling path must not shadow the authentication cookie).
    if (Object.hasOwn(result, key)) result[key] = null;
    else result[key] = value;
  }
  return result;
}
function send(req, res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Cookie, Origin',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}
async function bodyOf(req) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) throw failure('JSON_REQUIRED', 415);
  const declared = req.headers['content-length'];
  if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) throw failure('BODY_TOO_LARGE', 413);
  const chunks = [];
  let size = 0, timer;
  const timedOut = new Promise((resolve, reject) => {
    timer = setTimeout(() => { reject(failure('REQUEST_TIMEOUT', 408)); req.destroy(); }, 5000);
    timer.unref?.();
  });
  const read = (async () => {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw failure('BODY_TOO_LARGE', 413);
      chunks.push(chunk);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('INVALID', 400); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('INVALID', 400);
    return value;
  })();
  try { return await Promise.race([read, timedOut]); } finally { clearTimeout(timer); }
}

// In-memory, bounded token buckets: normal shared-NAT parties have room to register sixteen accounts.
class Limits {
  constructor(now, maxKeys = 4096) { this.now = now; this.maxKeys = maxKeys; this.buckets = new Map(); }
  take(key, burst, period) {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        for (const [id, old] of this.buckets) if (now - old.at > old.period) this.buckets.delete(id);
        if (this.buckets.size >= this.maxKeys) return false;
      }
      bucket = { tokens: burst, at: now, period };
      this.buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, now - bucket.at) * burst / period);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens--;
    return true;
  }
  clear() { this.buckets.clear(); }
}

export class AuthService {
  #closePromise;
  #resolveIdle;

  constructor({ store, passwords, origin, entryToken, sessionSecret, allowHttp = false,
    registrationOpen = true, now = Date.now, addressKey = req => req.socket?.remoteAddress || '?',
    onRevoke = () => {}, sessionTtlMs = 7 * DAY, gateTtlMs = 12 * 60 * MINUTE }) {
    if (!store || !passwords || typeof entryToken !== 'string' || Buffer.byteLength(entryToken) < 32 ||
        Buffer.byteLength(entryToken) > 512 || typeof sessionSecret !== 'string' || Buffer.byteLength(sessionSecret) < 32 ||
        Buffer.byteLength(sessionSecret) > 512 || constantEqual(entryToken, sessionSecret) ||
        !positiveInt(sessionTtlMs, MINUTE, 30 * DAY) || !positiveInt(gateTtlMs, MINUTE, DAY) ||
        typeof allowHttp !== 'boolean' || typeof registrationOpen !== 'boolean' || typeof now !== 'function' || typeof addressKey !== 'function' ||
        typeof onRevoke !== 'function') throw failure('AUTH_CONFIG');
    this.origin = parseOrigin(origin, allowHttp).origin;
    this.secure = this.origin.startsWith('https:');
    this.store = store;
    this.passwords = passwords;
    this.now = now;
    this.addressKey = addressKey;
    this.onRevoke = onRevoke;
    this.registrationOpen = registrationOpen;
    this.sessionTtlMs = sessionTtlMs;
    this.gateTtlMs = gateTtlMs;
    // Rotation of either deployment secret invalidates all old entry grants and game access.
    this.key = createHmac('sha256', sessionSecret).update(HASH_DOMAIN).digest();
    this.entryDigest = digest(entryToken);
    this.gateVersion = createHmac('sha256', this.key).update(this.entryDigest).digest('hex');
    this.limits = new Limits(now);
    this.inFlight = 0;
    this.maxInFlight = 48;
    this.closed = false;
  }

  cookie(name, value, maxAge, httpOnly = true) {
    return `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Strict${httpOnly ? '; HttpOnly' : ''}${this.secure ? '; Secure' : ''}`;
  }
  setCookies(res, values) { res.setHeader('Set-Cookie', values); }
  clearCookies(res) { this.setCookies(res, Object.values(COOKIE_NAMES).map(name => this.cookie(name, '', 0, name !== COOKIE_NAMES.csrf))); }
  signature(value) { return createHmac('sha256', this.key).update(value).digest('hex'); }
  grantGate(csrf) {
    const payload = Buffer.from(JSON.stringify({ v: this.gateVersion, exp: this.now() + this.gateTtlMs, nonce: secretToken(), csrf: digest(csrf) })).toString('base64url');
    return payload + '.' + this.signature(payload);
  }
  readGate(cookies) {
    const value = cookies[COOKIE_NAMES.gate];
    if (typeof value !== 'string' || value.length > 1024) return null;
    const [payload, signature, extra] = value.split('.');
    if (extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload) || !TOKEN.test(signature || '') || !constantEqual(signature, this.signature(payload))) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return data.v === this.gateVersion && Number.isSafeInteger(data.exp) && data.exp > this.now() &&
        data.exp <= this.now() + this.gateTtlMs && TOKEN.test(data.nonce) && TOKEN.test(data.csrf) ? data : null;
    } catch { return null; }
  }
  sessionHash(token) { return createHmac('sha256', this.key).update('session:' + token).digest('hex'); }
  #cookieSession(cookies) {
    const token = cookies[COOKIE_NAMES.session];
    return TOKEN.test(token || '') ? this.store.sessionByHash(this.sessionHash(token)) : null;
  }
  #revokeCookieSession(cookies, identity = null) {
    const session = identity || this.#cookieSession(cookies);
    if (!session) return;
    this.store.revokeSession(session.tokenHash);
    this.onRevoke(session.accountId, session.tokenHash);
  }
  identity(req) {
    if (this.closed) return null;
    const cookies = readCookies(req), gate = this.readGate(cookies);
    const token = cookies[COOKIE_NAMES.session];
    if (!gate || !TOKEN.test(token || '')) return null;
    const tokenHash = this.sessionHash(token);
    const session = this.store.sessionByHash(tokenHash);
    if (!session) return null;
    return { accountId: session.account.accountId, account: publicAccount(session.account), tokenHash,
      csrfHash: session.csrfHash, expiresAt: session.expiresAt, gateExpiresAt: gate.exp, gateVersion: gate.v };
  }
  // Upgrade and every inbound game frame use the same check; logout/disable cannot leave an authorised socket alive.
  validateIdentity(identity) {
    if (this.closed || !identity?.tokenHash || !identity.accountId || identity.gateVersion !== this.gateVersion ||
        !Number.isSafeInteger(identity.gateExpiresAt) || identity.gateExpiresAt <= this.now()) return false;
    const session = this.store.sessionByHash(identity.tokenHash);
    return !!session && session.account.accountId === identity.accountId;
  }
  checkOrigin(req) { return req.headers?.origin === this.origin; }
  csrfValid(req, cookies, expected) {
    const token = req.headers['x-csrf-token'];
    return typeof token === 'string' && TOKEN.test(token) && cookies[COOKIE_NAMES.csrf] === token && constantEqual(digest(token), expected);
  }
  websocketIdentity(req) {
    if (!this.checkOrigin(req)) return null;
    return this.identity(req);
  }

  status(req, res) {
    const cookies = readCookies(req);
    let gate = this.readGate(cookies), identity = this.identity(req), csrf = cookies[COOKIE_NAMES.csrf];
    const expected = identity?.csrfHash || gate?.csrf;
    if (!TOKEN.test(csrf || '') || (expected && !constantEqual(digest(csrf), expected))) {
      // Without the paired CSRF cookie, restart the entry flow rather than returning an unusable authenticated form.
      this.#revokeCookieSession(cookies, identity);
      csrf = secretToken();
      gate = null;
      identity = null;
      this.setCookies(res, [this.cookie(COOKIE_NAMES.gate, '', 0), this.cookie(COOKIE_NAMES.session, '', 0),
        this.cookie(COOKIE_NAMES.csrf, csrf, Math.floor(this.gateTtlMs / SECOND), false)]);
    }
    send(req, res, 200, { admitted: !!gate, account: identity?.account || null, csrf,
      registrationOpen: this.registrationOpen });
  }

  async handle(req, res, path) {
    if (path === '/auth' || path === '/auth/') {
      if (req.method !== 'GET' && req.method !== 'HEAD') { send(req, res, 405, { error: 'METHOD' }); return true; }
      // The minimal shell and its two local files are served by the host, never the game module graph.
      return false;
    }
    if (!path.startsWith('/auth/')) return false;
    if (this.closed) { send(req, res, 503, { error: 'MAINTENANCE' }); return true; }
    if (path === '/auth/status' && (req.method === 'GET' || req.method === 'HEAD')) {
      this.status(req, res); return true;
    }
    const action = path.slice('/auth/'.length);
    if (!ACTIONS.has(action)) { send(req, res, 404, { error: 'NOT_FOUND' }); return true; }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); send(req, res, 405, { error: 'METHOD' }); return true; }
    if (!this.checkOrigin(req)) { send(req, res, 403, { error: 'ORIGIN' }); return true; }
    if (this.inFlight >= this.maxInFlight) { res.setHeader('Retry-After', '5'); send(req, res, 503, { error: 'AUTH_BUSY' }); return true; }
    const key = String(this.addressKey(req)).slice(0, 160);
    const burst = action === 'admit' ? 64 : action === 'register' ? 32 : 96;
    if (!this.limits.take(action + ':' + key, burst, 10 * MINUTE)) {
      res.setHeader('Retry-After', '60'); send(req, res, 429, { error: 'RATE' }); return true;
    }
    const cookies = readCookies(req), gate = this.readGate(cookies), identity = this.identity(req);
    if (action !== 'admit') {
      if (!gate) { send(req, res, 401, { error: 'ENTRY_REQUIRED' }); return true; }
      if (!this.csrfValid(req, cookies, identity?.csrfHash || gate.csrf)) { send(req, res, 403, { error: 'CSRF' }); return true; }
    } else {
      // Bootstrap POST uses an exact Origin plus the same-origin status cookie; the shared token never enters a URL.
      const csrf = req.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !TOKEN.test(csrf) || cookies[COOKIE_NAMES.csrf] !== csrf) {
        send(req, res, 403, { error: 'CSRF' }); return true;
      }
    }
    this.inFlight++;
    try {
      const body = await bodyOf(req);
      if (this.closed) throw failure('MAINTENANCE', 503);
      if (action === 'admit') {
        if (typeof body.token !== 'string' || Buffer.byteLength(body.token) > 512 || !constantEqual(digest(body.token), this.entryDigest)) throw failure('ENTRY_INVALID', 401);
        this.#revokeCookieSession(cookies, identity);
        const csrf = secretToken();
        this.setCookies(res, [this.cookie(COOKIE_NAMES.gate, this.grantGate(csrf), Math.floor(this.gateTtlMs / SECOND)),
          this.cookie(COOKIE_NAMES.csrf, csrf, Math.floor(this.gateTtlMs / SECOND), false), this.cookie(COOKIE_NAMES.session, '', 0)]);
        send(req, res, 200, { admitted: true, csrf });
      } else if (action === 'logout') {
        if (identity) { this.store.revokeSession(identity.tokenHash); this.onRevoke(identity.accountId, identity.tokenHash); }
        this.clearCookies(res);
        send(req, res, 200, { ok: true });
      } else {
        const username = normalizeUsername(body.username), password = body.password;
        if (!username || !validatePassword(password)) throw failure('CREDENTIALS_INVALID', 401);
        let account;
        // A bounded per-username bucket complements the shared-address bucket without enabling unbounded map growth.
        if (!this.limits.take('credential:' + username, 12, 10 * MINUTE)) throw failure('RATE', 429);
        if (action === 'register') {
          if (!this.registrationOpen) throw failure('REGISTRATION_CLOSED', 403);
          const name = sanitizeDisplayName(body.name || username);
          if (!name) throw failure('INVALID', 400);
          const passwordHash = await this.passwords.hash(password);
          if (this.closed) throw failure('MAINTENANCE', 503);
          account = this.store.createAccount({ username, name, passwordHash });
        } else {
          account = this.store.accountByUsername(username);
          const valid = account ? await this.passwords.verify(password, account.passwordHash) : await this.passwords.dummyVerify(password);
          if (!account || account.disabled || !valid) throw failure('CREDENTIALS_INVALID', 401);
        }
        if (this.closed) throw failure('MAINTENANCE', 503);
        // Re-fetch after asynchronous scrypt: a concurrent administrative disable/reset must not authorise an old credential.
        const current = this.store.accountById(account.accountId);
        if (!current || current.disabled || current.credentialVersion !== account.credentialVersion) throw failure('CREDENTIALS_INVALID', 401);
        const token = secretToken(), csrf = secretToken(), tokenHash = this.sessionHash(token);
        this.store.createSession({ accountId: account.accountId, tokenHash, csrfHash: digest(csrf),
          expiresAt: this.now() + this.sessionTtlMs, expectedCredentialVersion: account.credentialVersion });
        if (identity) { this.store.revokeSession(identity.tokenHash); this.onRevoke(identity.accountId, identity.tokenHash); }
        this.setCookies(res, [this.cookie(COOKIE_NAMES.session, token, Math.floor(this.sessionTtlMs / SECOND)),
          this.cookie(COOKIE_NAMES.gate, this.grantGate(csrf), Math.floor(this.gateTtlMs / SECOND)),
          this.cookie(COOKIE_NAMES.csrf, csrf, Math.floor(this.gateTtlMs / SECOND), false)]);
        send(req, res, 200, { account: publicAccount(current), csrf });
      }
    } catch (error) {
      const statuses = { AUTH_BUSY: 503, USERNAME_TAKEN: 409, ACCOUNTS_FULL: 503, SESSIONS_FULL: 503,
        INVALID: 400, RATE: 429, CLOSED: 503, ACCOUNT_DISABLED: 401, ACCOUNT_NOT_FOUND: 401, CREDENTIALS_CHANGED: 401 };
      const status = error.status || statuses[error.code] || 500;
      if (status === 429 || status === 503) res.setHeader('Retry-After', '10');
      if (!res.headersSent && !res.destroyed) send(req, res, status, { error: status === 500 ? 'INTERNAL' : error.code });
    } finally {
      this.inFlight--;
      if (this.closed && this.inFlight === 0) this.#resolveIdle?.();
    }
    return true;
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.closed = true;
    this.limits.clear();
    const idle = this.inFlight === 0 ? Promise.resolve() : new Promise(resolve => { this.#resolveIdle = resolve; });
    this.#closePromise = (async () => {
      await this.passwords.close();
      await idle;
      await this.store.close();
    })();
    return this.#closePromise;
  }
}
