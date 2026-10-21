import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 32_768;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const MAXMEM = 64 * 1024 * 1024;
const RECORD_KEYS = Object.freeze(['algorithm', 'version', 'N', 'r', 'p', 'salt', 'key']);

// Public, deliberately non-secret fixture. dummyVerify always returns false,
// including when its input happens to match this known password's key.
const DUMMY_PASSWORD = 'stronghold-public-dummy-only';
const DUMMY_RECORD = Object.freeze({
  algorithm: 'scrypt',
  version: 1,
  N,
  r: R,
  p: P,
  salt: '00000000000000000000000000000000',
  key: '86a11bdec1925114cd0c0f378234a774992942082de4892636ae851394728f9e',
});

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

/** No trimming, Unicode normalization, coercion, or replacement of lone surrogates. */
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) return false;
  if (!password.isWellFormed() || Buffer.byteLength(password, 'utf8') > 512) return false;
  const points = [...password].length;
  return points >= 12 && points <= 128;
}

function recordSnapshot(record) {
  try {
    if (record === null || typeof record !== 'object') return null;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(record).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(record);
    if (Object.keys(descriptors).length !== RECORD_KEYS.length) return null;
    const result = {};
    for (const key of RECORD_KEYS) {
      const descriptor = descriptors[key];
      // Do not execute getters or accept properties that disappear in JSON.
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
      result[key] = descriptor.value;
    }
    if (result.algorithm !== 'scrypt' || result.version !== 1 || result.N !== N
      || result.r !== R || result.p !== P) return null;
    if (typeof result.salt !== 'string' || !/^[0-9a-f]{32}$/.test(result.salt)) return null;
    if (typeof result.key !== 'string' || !/^[0-9a-f]{64}$/.test(result.key)) return null;
    return result;
  } catch {
    return null;
  }
}

/** Also used by AuthStore before persisting a password record as JSON. */
export function validatePasswordRecord(record) {
  return recordSnapshot(record) !== null;
}

function derive(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAXMEM }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

async function matches(password, record) {
  const salt = Buffer.from(record.salt, 'hex');
  const expected = Buffer.from(record.key, 'hex');
  let actual;
  try {
    actual = await derive(password, salt);
    return timingSafeEqual(actual, expected);
  } finally {
    salt.fill(0);
    expected.fill(0);
    actual?.fill(0);
  }
}

/**
 * Each instance runs at most two asynchronous scrypt jobs (~32 MiB each).
 * maxQueued counts waiting jobs only, not running jobs. There is no sync KDF.
 * close rejects waiting/new work with CLOSED and waits for running KDFs to finish.
 */
export class Passwords {
  #concurrency;
  #maxQueued;
  #active = 0;
  #queue = [];
  #closed = false;
  #closePromise;
  #resolveClosed;

  constructor({ concurrency = 2, maxQueued = 32 } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2
      || !Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 1_024) {
      throw failure('INVALID', 'Invalid password worker limits');
    }
    this.#concurrency = concurrency;
    this.#maxQueued = maxQueued;
  }

  hash(password) {
    return this.#enqueue(async () => {
      if (!validatePassword(password)) throw failure('INVALID', 'Invalid password');
      const salt = randomBytes(SALT_BYTES);
      let key;
      try {
        key = await derive(password, salt);
        return {
          algorithm: 'scrypt', version: 1, N, r: R, p: P,
          salt: salt.toString('hex'), key: key.toString('hex'),
        };
      } finally {
        salt.fill(0);
        key?.fill(0);
      }
    });
  }

  verify(password, record) {
    // Snapshot before queueing so subsequent caller mutations cannot change cost.
    const snapshot = recordSnapshot(record);
    return this.#enqueue(async () => {
      if (!validatePassword(password) || snapshot === null) return false;
      return matches(password, snapshot);
    });
  }

  dummyVerify(password) {
    return this.#enqueue(async () => {
      // Even malformed/oversized inputs take one bounded, production-cost KDF;
      // never send an unbounded input to crypto merely to conceal an unknown user.
      const candidate = validatePassword(password) ? password : DUMMY_PASSWORD;
      await matches(candidate, DUMMY_RECORD);
      return false;
    });
  }

  #enqueue(work) {
    if (this.#closed) return Promise.reject(failure('CLOSED', 'Password workers are closed'));
    return new Promise((resolve, reject) => {
      const job = { work, resolve, reject };
      if (this.#active < this.#concurrency) this.#start(job);
      else if (this.#queue.length < this.#maxQueued) this.#queue.push(job);
      else reject(failure('AUTH_BUSY', 'Password work queue is full'));
    });
  }

  #start(job) {
    this.#active += 1;
    // Catch both synchronous failures and asynchronous KDF errors. This internal
    // task never rejects: only the caller's returned promise receives the error.
    void (async () => {
      try {
        job.resolve(await job.work());
      } catch (error) {
        job.reject(error);
      } finally {
        this.#active -= 1;
        while (!this.#closed && this.#active < this.#concurrency && this.#queue.length > 0) {
          this.#start(this.#queue.shift());
        }
        if (this.#closed && this.#active === 0) this.#resolveClosed?.();
      }
    })();
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = new Promise((resolve) => { this.#resolveClosed = resolve; });
    for (const job of this.#queue.splice(0)) {
      job.reject(failure('CLOSED', 'Password workers are closed'));
    }
    if (this.#active === 0) this.#resolveClosed();
    return this.#closePromise;
  }
}
