import { randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, lstatSync, mkdirSync, openSync, unlinkSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { validatePasswordRecord } from './passwords.js';

const ACCOUNT_ID = /^a_[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SCHEMA_VERSION = 1;
const ACCOUNT_COLUMNS = 'accountId, username, name, hash AS passwordHash, disabled, credentialVersion, createdAt';

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeUsername(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return /^[a-z0-9_]{3,32}$/.test(value) ? value : null;
}

/** Names are inert text, not HTML/URLs. The UI must render them as text too. */
export function sanitizeDisplayName(raw) {
  if (typeof raw !== 'string' || !raw.isWellFormed()) return null;
  const value = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
  const length = [...value].length;
  // Never silently truncate a rejected overlength name into a different identity.
  return length >= 1 && length <= 16 ? value : null;
}

export function publicAccount(account) {
  if (!account) return null;
  return {
    id: account.accountId,
    username: account.username,
    name: account.name,
    tag: account.accountId.slice(-6),
    local: false,
  };
}

function passwordJson(record) {
  // Use data descriptors, not getters/toJSON supplied by a caller. Validation
  // permits only our fixed-cost scrypt format, including exact hex lengths.
  try {
    if (!validatePasswordRecord(record)) throw new Error('Invalid record');
    const descriptors = Object.getOwnPropertyDescriptors(record);
    const snapshot = {};
    for (const field of ['algorithm', 'version', 'N', 'r', 'p', 'salt', 'key']) {
      const descriptor = descriptors[field];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid record');
      snapshot[field] = descriptor.value;
    }
    if (!validatePasswordRecord(snapshot)) throw new Error('Invalid record');
    return JSON.stringify(snapshot);
  } catch {
    throw failure('INVALID', 'Invalid password record');
  }
}

function checkedFile(file) {
  if (typeof file !== 'string' || file.length === 0 || file.trim() === '' || /[\u0000-\u001f]/.test(file)) {
    throw failure('INVALID', 'Invalid database file');
  }
  return resolve(file);
}

function privateParent(file) {
  // mode applies only to newly-created directories; existing parents are not altered.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
}

function privateFile(file) {
  // Windows ACLs are deliberately not changed. SQLite inherits the main file's
  // POSIX mode for sidecars; additionally restrict any existing regular sidecars.
  if (process.platform === 'win32') return;
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      if (lstatSync(candidate).isFile()) chmodSync(candidate, 0o600);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function reserveDatabase(file) {
  privateParent(file);
  let descriptor;
  try {
    descriptor = openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = lstatSync(file);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw failure('INVALID', 'Database path must be a regular file');
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  privateFile(file);
}

/**
 * All public database operations are synchronous except backup/close.
 * Stored hash is a JSON password record; returned internal accounts expose it as
 * passwordHash. No plaintext password, session token, or CSRF token is stored.
 * Per-account overflow atomically evicts the oldest session (rowid breaks ties).
 * Global overflow after pruning/that eviction is rejected with SESSIONS_FULL.
 */
export class AuthStore {
  #db;
  #file;
  #now;
  #maxAccounts;
  #maxSessions;
  #maxSessionsPerAccount;
  #closed = false;
  #closePromise;
  #backups = new Set();
  #statements;

  constructor({ file, now = Date.now, maxAccounts = 10_000, maxSessions = 8_000,
    maxSessionsPerAccount = 8 } = {}) {
    if (typeof now !== 'function' || ![maxAccounts, maxSessions, maxSessionsPerAccount]
      .every((value) => Number.isSafeInteger(value) && value >= 1)) {
      throw failure('INVALID', 'Invalid auth store options');
    }
    this.#file = file === ':memory:' ? file : checkedFile(file);
    this.#now = now;
    this.#maxAccounts = maxAccounts;
    this.#maxSessions = maxSessions;
    this.#maxSessionsPerAccount = maxSessionsPerAccount;
    if (this.#file !== ':memory:') reserveDatabase(this.#file);
    try {
      this.#db = new DatabaseSync(this.#file, { enableForeignKeyConstraints: true, allowExtension: false });
      this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      this.#migrate();
      // SQLite uses MEMORY journal mode for :memory: databases by design.
      this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      if (this.#file !== ':memory:') privateFile(this.#file);
      this.#prepare();
    } catch (error) {
      try { this.#db?.close(); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  #assertOpen() {
    if (this.#closed) throw failure('CLOSED', 'Auth store is closed');
  }

  #time() {
    const time = this.#now();
    if (!Number.isSafeInteger(time) || time < 0) throw failure('INVALID', 'Invalid auth clock');
    return time;
  }

  #transaction(work) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  #migrate() {
    this.#transaction(() => {
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      if (version > SCHEMA_VERSION) throw failure('FUTURE_VERSION', 'Unsupported future auth database version');
      if (version !== 0 && version !== SCHEMA_VERSION) throw failure('SCHEMA_ERROR', 'Unsupported auth database version');
      if (version === SCHEMA_VERSION) return;
      const existing = this.#db.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get();
      if (existing) throw failure('SCHEMA_ERROR', 'Unversioned nonempty auth database');
      this.#db.exec(`
        CREATE TABLE accounts (
          accountId TEXT PRIMARY KEY NOT NULL,
          username TEXT NOT NULL UNIQUE
            CHECK (length(username) BETWEEN 3 AND 32 AND username NOT GLOB '*[^a-z0-9_]*'),
          name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 16),
          hash TEXT NOT NULL CHECK (json_valid(hash)),
          disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
          credentialVersion INTEGER NOT NULL DEFAULT 1 CHECK (credentialVersion >= 1),
          createdAt INTEGER NOT NULL CHECK (createdAt >= 0)
        ) STRICT;
        CREATE TABLE sessions (
          tokenHash TEXT PRIMARY KEY NOT NULL
            CHECK (length(tokenHash) = 64 AND tokenHash NOT GLOB '*[^0-9a-f]*'),
          csrfHash TEXT NOT NULL
            CHECK (length(csrfHash) = 64 AND csrfHash NOT GLOB '*[^0-9a-f]*'),
          accountId TEXT NOT NULL REFERENCES accounts(accountId) ON DELETE CASCADE,
          credentialVersion INTEGER NOT NULL CHECK (credentialVersion >= 1),
          createdAt INTEGER NOT NULL CHECK (createdAt >= 0),
          expiresAt INTEGER NOT NULL CHECK (expiresAt > createdAt)
        ) STRICT;
        CREATE INDEX sessions_by_account_age ON sessions(accountId, createdAt);
        CREATE INDEX sessions_by_expiry ON sessions(expiresAt);
        PRAGMA user_version = 1;
      `);
    });
  }

  #prepare() {
    const sql = {
      accountByUsername: `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE username = ?`,
      accountById: `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE accountId = ?`,
      accountCount: 'SELECT count(*) AS count FROM accounts',
      insertAccount: 'INSERT INTO accounts (accountId, username, name, hash, createdAt) VALUES (?, ?, ?, ?, ?)',
      sessionByHash: `SELECT a.accountId, a.username, a.name, a.hash AS passwordHash,
        a.disabled, a.credentialVersion, a.createdAt, s.tokenHash, s.csrfHash, s.expiresAt,
        s.credentialVersion AS sessionCredentialVersion, s.createdAt AS sessionCreatedAt
        FROM sessions AS s JOIN accounts AS a ON a.accountId = s.accountId
        WHERE s.tokenHash = ? AND a.disabled = 0 AND s.credentialVersion = a.credentialVersion AND s.expiresAt > ?`,
      sessionExists: 'SELECT 1 AS present FROM sessions WHERE tokenHash = ?',
      sessionCount: 'SELECT count(*) AS count FROM sessions',
      accountSessionCount: 'SELECT count(*) AS count FROM sessions WHERE accountId = ?',
      insertSession: 'INSERT INTO sessions (tokenHash, csrfHash, accountId, credentialVersion, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?)',
      evictSessions: 'DELETE FROM sessions WHERE tokenHash IN (SELECT tokenHash FROM sessions WHERE accountId = ? ORDER BY createdAt ASC, rowid ASC LIMIT ?)',
      revokeSession: 'DELETE FROM sessions WHERE tokenHash = ?',
      revokeAccountSessions: 'DELETE FROM sessions WHERE accountId = ?',
      setDisabled: 'UPDATE accounts SET disabled = ?, credentialVersion = credentialVersion + 1 WHERE accountId = ?',
      setPassword: 'UPDATE accounts SET hash = ?, credentialVersion = credentialVersion + 1 WHERE accountId = ?',
      prune: `DELETE FROM sessions WHERE expiresAt <= ? OR EXISTS (
        SELECT 1 FROM accounts WHERE accounts.accountId = sessions.accountId
          AND (accounts.disabled = 1 OR accounts.credentialVersion <> sessions.credentialVersion))`,
    };
    this.#statements = Object.fromEntries(Object.entries(sql).map(([name, text]) => [name, this.#db.prepare(text)]));
  }

  #account(row) {
    if (!row) return null;
    let passwordHash;
    try { passwordHash = JSON.parse(row.passwordHash); } catch { /* Checked below. */ }
    if (!validatePasswordRecord(passwordHash)) throw failure('SCHEMA_ERROR', 'Invalid stored password record');
    return {
      accountId: row.accountId, username: row.username, name: row.name, passwordHash,
      disabled: row.disabled === 1, credentialVersion: row.credentialVersion, createdAt: row.createdAt,
    };
  }

  createAccount(input) {
    this.#assertOpen();
    if (!isObject(input)) throw failure('INVALID', 'Invalid account');
    const username = normalizeUsername(input.username);
    const name = sanitizeDisplayName(input.name);
    if (username === null || name === null) throw failure('INVALID', 'Invalid account');
    const hash = passwordJson(input.passwordHash);
    const now = this.#time();
    return this.#transaction(() => {
      if (this.#statements.accountByUsername.get(username)) throw failure('USERNAME_TAKEN', 'Username is taken');
      if (this.#statements.accountCount.get().count >= this.#maxAccounts) throw failure('ACCOUNTS_FULL', 'Account limit reached');
      const accountId = `a_${randomBytes(16).toString('hex')}`;
      this.#statements.insertAccount.run(accountId, username, name, hash, now);
      return this.#account(this.#statements.accountById.get(accountId));
    });
  }

  accountByUsername(username) {
    this.#assertOpen();
    const normalized = normalizeUsername(username);
    return normalized === null ? null : this.#account(this.#statements.accountByUsername.get(normalized));
  }

  accountById(id) {
    this.#assertOpen();
    return typeof id === 'string' && ACCOUNT_ID.test(id)
      ? this.#account(this.#statements.accountById.get(id)) : null;
  }

  createSession(input) {
    this.#assertOpen();
    if (!isObject(input) || typeof input.accountId !== 'string' || !ACCOUNT_ID.test(input.accountId)
      || typeof input.tokenHash !== 'string' || !DIGEST.test(input.tokenHash)
      || typeof input.csrfHash !== 'string' || !DIGEST.test(input.csrfHash)
      || !Number.isSafeInteger(input.expiresAt)
      || (input.expectedCredentialVersion !== undefined && (!Number.isSafeInteger(input.expectedCredentialVersion)
        || input.expectedCredentialVersion < 1))) throw failure('INVALID', 'Invalid session');
    const { accountId, tokenHash, csrfHash, expiresAt, expectedCredentialVersion } = input;
    const now = this.#time();
    if (expiresAt <= now) throw failure('INVALID', 'Session must expire in the future');
    return this.#transaction(() => {
      this.#statements.prune.run(now);
      const account = this.#account(this.#statements.accountById.get(accountId));
      if (!account) throw failure('ACCOUNT_NOT_FOUND', 'Account not found');
      if (account.disabled) throw failure('ACCOUNT_DISABLED', 'Account is disabled');
      // Tie an asynchronous password check to this transaction's fresh account
      // version, including when a separate administrative process changed it.
      if (expectedCredentialVersion !== undefined && expectedCredentialVersion !== account.credentialVersion) {
        throw failure('CREDENTIALS_CHANGED', 'Account credentials changed');
      }
      if (this.#statements.sessionExists.get(tokenHash)) throw failure('SESSION_EXISTS', 'Session digest already exists');
      const count = this.#statements.accountSessionCount.get(accountId).count;
      const excess = count - this.#maxSessionsPerAccount + 1;
      if (excess > 0) this.#statements.evictSessions.run(accountId, excess);
      if (this.#statements.sessionCount.get().count >= this.#maxSessions) throw failure('SESSIONS_FULL', 'Session limit reached');
      this.#statements.insertSession.run(tokenHash, csrfHash, accountId, account.credentialVersion, now, expiresAt);
      return { account, accountId, tokenHash, csrfHash, expiresAt, credentialVersion: account.credentialVersion, createdAt: now };
    });
  }

  sessionByHash(tokenHash) {
    this.#assertOpen();
    if (typeof tokenHash !== 'string' || !DIGEST.test(tokenHash)) return null;
    // One fresh join for every call: external/CLI disables and password changes
    // cannot leave a websocket authenticated through an in-memory account cache.
    const row = this.#statements.sessionByHash.get(tokenHash, this.#time());
    if (!row) return null;
    return {
      account: this.#account(row), accountId: row.accountId, tokenHash: row.tokenHash,
      csrfHash: row.csrfHash, expiresAt: row.expiresAt,
      credentialVersion: row.sessionCredentialVersion, createdAt: row.sessionCreatedAt,
    };
  }

  revokeSession(tokenHash) {
    this.#assertOpen();
    if (typeof tokenHash !== 'string' || !DIGEST.test(tokenHash)) throw failure('INVALID', 'Invalid session digest');
    return this.#statements.revokeSession.run(tokenHash).changes > 0;
  }

  revokeAccountSessions(id) {
    this.#assertOpen();
    if (typeof id !== 'string' || !ACCOUNT_ID.test(id)) throw failure('INVALID', 'Invalid account id');
    return this.#statements.revokeAccountSessions.run(id).changes;
  }

  #requireAccount(id) {
    const account = this.#account(this.#statements.accountById.get(id));
    if (!account) throw failure('ACCOUNT_NOT_FOUND', 'Account not found');
    if (!Number.isSafeInteger(account.credentialVersion + 1)) throw failure('INVALID', 'Credential version exhausted');
    return account;
  }

  setDisabled(id, disabled) {
    this.#assertOpen();
    if (typeof id !== 'string' || !ACCOUNT_ID.test(id) || typeof disabled !== 'boolean') throw failure('INVALID', 'Invalid account update');
    return this.#transaction(() => {
      this.#requireAccount(id);
      this.#statements.setDisabled.run(Number(disabled), id);
      this.#statements.revokeAccountSessions.run(id);
      return this.#account(this.#statements.accountById.get(id));
    });
  }

  setPassword(id, passwordHash) {
    this.#assertOpen();
    if (typeof id !== 'string' || !ACCOUNT_ID.test(id)) throw failure('INVALID', 'Invalid account id');
    const hash = passwordJson(passwordHash);
    return this.#transaction(() => {
      this.#requireAccount(id);
      this.#statements.setPassword.run(hash, id);
      this.#statements.revokeAccountSessions.run(id);
      return this.#account(this.#statements.accountById.get(id));
    });
  }

  prune() {
    this.#assertOpen();
    return this.#statements.prune.run(this.#time()).changes;
  }

  /**
   * SQLite's online backup includes committed WAL data and stays consistent.
   * Never use an fs copy of a live .db (that can omit its WAL). Reserve an empty
   * destination exclusively so an existing file is never overwritten.
   */
  async backup(destFile) {
    this.#assertOpen();
    if (destFile === ':memory:') throw failure('INVALID', 'Backup requires a file');
    const destination = checkedFile(destFile);
    privateParent(destination);
    let descriptor;
    try {
      descriptor = openSync(destination, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') throw failure('BACKUP_EXISTS', 'Backup destination already exists');
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    const reserved = lstatSync(destination);
    const operation = (async () => {
      try {
        const pages = await sqliteBackup(this.#db, destination, { rate: 100 });
        privateFile(destination);
        return { file: destination, pages };
      } catch (error) {
        // Remove only the placeholder owned by this call, never a replacement.
        try {
          const current = lstatSync(destination);
          if (current.dev === reserved.dev && current.ino === reserved.ino) unlinkSync(destination);
        } catch { /* Keep the original backup/permission error. */ }
        throw error;
      }
    })();
    this.#backups.add(operation);
    try { return await operation; } finally { this.#backups.delete(operation); }
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    if (this.#backups.size > 0) {
      this.#closePromise = Promise.allSettled([...this.#backups]).then(() => { this.#db.close(); });
    } else {
      try {
        this.#db.close();
        this.#closePromise = Promise.resolve();
      } catch (error) {
        this.#closePromise = Promise.reject(error);
      }
    }
    return this.#closePromise;
  }
}
