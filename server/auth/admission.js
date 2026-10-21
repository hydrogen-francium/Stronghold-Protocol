/**
 * Pure, synchronous, in-memory admission ledger; no sockets, IPs, timers or I/O.
 *
 * Integration (not wired to the lobby here):
 * - Keep ONE Admission instance in the authoritative server process. Separate
 *   processes/workers must route admission through that one authority; creating
 *   an instance per room/process does not provide a server-wide limit.
 * - Waiting/login do not call reserve. Reserve the complete roster immediately
 *   before starting a match; if startup fails, rollback(theCapturedLease.token).
 * - Capture that token in departure/end callbacks. Never recover a release
 *   token by re-reserving an old matchId. Only confirmed departure (e.g. lobby
 *   disconnect expiry) calls releaseAccount; elimination alone does NOT release.
 * - releaseMatch/rollback release both human and AI reservations. releaseAccount
 *   releases only that human; remaining bots need releaseMatch at match end.
 * - A lease is internal: its immutable IDs describe the ORIGINAL reservation,
 *   not the remaining roster after individual departures. Retrying reserve is
 *   idempotent, not a way to reacquire a departed account. Only snapshot() is
 *   intended as public statistics. Never send a lease/token to clients.
 *
 * API:
 *   new Admission({ humanLimit = 16, botLimit = 16 })
 *   reserve(matchId, { accountIds, botIds? OR botCount? }) -> frozen lease
 *   releaseAccount(lease.token, accountId) -> boolean
 *   releaseMatch(lease.token) / rollback(lease.token) -> boolean
 *   snapshot() -> frozen counts only
 *
 * Limits: humans 1..16, bots 0..256 (0 disables AI). IDs are case-sensitive,
 * nonempty, unpadded strings of at most 256 UTF-16 code units. Bot IDs are
 * match-scoped, not account IDs. Named bots and count-only bots are distinct
 * reservations; all zero-bot representations are equivalent.
 * Tokens are opaque Symbols, unique per reservation, usable only in this live
 * instance/process, and deliberately not serializable. Reusing a released
 * matchId always creates a new token. No release method accepts a matchId.
 */

const MAX_HUMANS = 16;
const MAX_BOTS = 256;
const MAX_ID_LENGTH = 256;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export class AdmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AdmissionError';
    this.code = code; // 'invalid' | 'busy' | 'full'; messages never contain IDs.
  }
}

function reject(code, message) {
  throw new AdmissionError(code, message);
}

function record(value, allowedKeys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    reject('invalid', `${label} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    reject('invalid', `${label} must be a plain record`);
  }
  for (const key of Reflect.ownKeys(value)) {
    // Reject unknown fields and accessors, rather than retaining request/profile
    // objects or invoking their getters. Only the documented ID/count fields fit.
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowedKeys.includes(key) || !own(descriptor, 'value')) {
      reject('invalid', `${label} contains an unsupported field or accessor`);
    }
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || value.length === 0 ||
      value.length > MAX_ID_LENGTH || value.trim() !== value) {
    reject('invalid', `${label} must be a nonempty, unpadded ID of at most 256 code units`);
  }
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    reject('invalid', `${label} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function identifiers(value, label, minimum, maximum, overflowCode = 'invalid') {
  if (!Array.isArray(value) || value.length < minimum) {
    reject('invalid', `${label} must be an ID array with at least ${minimum} entries`);
  }
  // Bound work before traversing an oversized input. No state is written here.
  const length = value.length;
  if (length > maximum) reject(overflowCode, `${label} exceeds the supported limit`);
  const result = [];
  const seen = new Set();
  for (let index = 0; index < length; index += 1) {
    const id = identifier(value[index], label);
    if (seen.has(id)) reject('invalid', `${label} contains duplicate IDs`);
    seen.add(id);
    result.push(id);
  }
  return result.sort(); // Canonicalize sets; retries may reorder the roster.
}

function sameIds(left, right) {
  return left === right || (left !== null && right !== null &&
    left.length === right.length && left.every((id, index) => id === right[index]));
}

function reservation(matchId, options) {
  identifier(matchId, 'matchId');
  record(options, ['accountIds', 'botIds', 'botCount'], 'reservation');
  if (!own(options, 'accountIds')) reject('invalid', 'accountIds is required');
  const accountIds = identifiers(options.accountIds, 'accountIds', 1, MAX_HUMANS, 'full');
  const hasBotIds = own(options, 'botIds');
  const hasBotCount = own(options, 'botCount');
  if (hasBotIds && hasBotCount) reject('invalid', 'Use botIds OR botCount, not both');
  let botIds = null;
  let botCount = 0;
  if (hasBotIds) {
    const ids = identifiers(options.botIds, 'botIds', 0, MAX_BOTS);
    botCount = ids.length;
    if (botCount !== 0) botIds = Object.freeze(ids);
  } else if (hasBotCount) {
    botCount = integer(options.botCount, 0, MAX_BOTS, 'botCount');
  }
  return { matchId, accountIds: Object.freeze(accountIds), botIds, botCount };
}

export class Admission {
  #humanLimit;
  #botLimit;
  #matches = new Map();
  #leases = new Map();
  #accounts = new Map();
  #botsInUse = 0;

  constructor(options = {}) {
    record(options, ['humanLimit', 'botLimit'], 'configuration');
    this.#humanLimit = integer(own(options, 'humanLimit') ? options.humanLimit : 16,
      1, MAX_HUMANS, 'humanLimit');
    this.#botLimit = integer(own(options, 'botLimit') ? options.botLimit : 16,
      0, MAX_BOTS, 'botLimit');
  }

  reserve(matchId, options) {
    // All caller input is normalized/copied before consulting or mutating state.
    // There is no await or external callback between checks and the commit.
    const requested = reservation(matchId, options);
    const existing = this.#matches.get(matchId);
    if (existing) {
      const lease = existing.lease;
      if (!sameIds(lease.accountIds, requested.accountIds) ||
          !sameIds(lease.botIds, requested.botIds) || lease.botCount !== requested.botCount) {
        reject('busy', 'matchId already has a different reservation');
      }
      return lease; // Even at full capacity; never re-add individually released IDs.
    }
    for (const accountId of requested.accountIds) {
      if (this.#accounts.has(accountId)) reject('busy', 'An account is reserved by another match');
    }
    if (this.#accounts.size + requested.accountIds.length > this.#humanLimit) {
      reject('full', 'Human admission limit reached');
    }
    if (this.#botsInUse + requested.botCount > this.#botLimit) {
      reject('full', 'AI admission limit reached');
    }

    const lease = Object.freeze({ ...requested, token: Symbol('admission-lease') });
    const entry = { lease, accounts: new Set(lease.accountIds) };
    this.#matches.set(matchId, entry);
    this.#leases.set(lease.token, entry);
    for (const accountId of entry.accounts) this.#accounts.set(accountId, entry);
    this.#botsInUse += lease.botCount;
    return lease;
  }

  #lookup(token) {
    if (typeof token !== 'symbol') reject('invalid', 'An opaque lease token is required');
    return this.#leases.get(token); // Unknown, foreign and stale tokens are no-ops.
  }

  #forget(entry) {
    this.#leases.delete(entry.lease.token);
    this.#matches.delete(entry.lease.matchId);
    // No tombstones or history: each live entry consumes >=1 human or AI slot.
  }

  releaseAccount(token, accountId) {
    identifier(accountId, 'accountId');
    const entry = this.#lookup(token);
    if (!entry || this.#accounts.get(accountId) !== entry) return false;
    this.#accounts.delete(accountId);
    entry.accounts.delete(accountId);
    if (entry.accounts.size === 0 && entry.lease.botCount === 0) this.#forget(entry);
    return true;
  }

  releaseMatch(token) {
    const entry = this.#lookup(token);
    if (!entry) return false;
    // Individually departed accounts have already been removed from this set,
    // so releasing the old match cannot remove their newer reservations.
    for (const accountId of entry.accounts) this.#accounts.delete(accountId);
    entry.accounts.clear();
    this.#botsInUse -= entry.lease.botCount;
    this.#forget(entry);
    return true;
  }

  rollback(token) {
    return this.releaseMatch(token);
  }

  snapshot() {
    return Object.freeze({
      limits: Object.freeze({ humans: this.#humanLimit, bots: this.#botLimit }),
      inUse: Object.freeze({ humans: this.#accounts.size, bots: this.#botsInUse }),
      available: Object.freeze({
        humans: this.#humanLimit - this.#accounts.size,
        bots: this.#botLimit - this.#botsInUse,
      }),
      matches: this.#matches.size,
    });
  }
}
