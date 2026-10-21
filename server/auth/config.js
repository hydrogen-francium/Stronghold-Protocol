// Deployment inputs only. No dotenv loading, weak defaults, database creation, or logging.
import { constants, fstatSync, lstatSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import path from 'node:path';

function failure(setting) {
  return Object.assign(new Error(`Invalid authentication configuration: ${setting}`), { code: 'AUTH_CONFIG', setting });
}
function valueOf(env, key) {
  const value = env[key];
  if (value !== undefined && typeof value !== 'string') throw failure(key);
  return value;
}
function booleanOf(env, key, fallback) {
  const value = valueOf(env, key);
  if (value === undefined) return fallback;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw failure(key);
}
function integerOf(env, key, fallback, maximum) {
  const raw = valueOf(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^(?:0|[1-9][0-9]{0,3})$/.test(raw) || !Number.isSafeInteger(value) || value > maximum) throw failure(key);
  return value;
}
function absolutePath(value, key) {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value) || !path.isAbsolute(value)) {
    throw failure(key);
  }
  return path.resolve(value);
}
function canonicalPath(value, key) {
  const suffix = [];
  let current = value;
  for (;;) {
    try { return path.join(realpathSync.native(current), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw failure(key);
      const parent = path.dirname(current);
      if (parent === current) throw failure(key);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}
function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function fileSecret(file, key) {
  let descriptor;
  const bytes = Buffer.alloc(515);
  try {
    const selected = absolutePath(file, key);
    const before = lstatSync(selected);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 514) throw failure(key);
    descriptor = openSync(selected, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > 514) throw failure(key);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(descriptor, bytes, size, bytes.length - size, null);
      if (read === 0) break;
      size += read;
    }
    if (size > 514) throw failure(key);
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)).replace(/\r?\n$/, '');
  } catch { throw failure(key); }
  finally {
    bytes.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
function assertPrivate(selected, served, key) {
  const canonical = canonicalPath(selected, key);
  for (const directory of served) {
    if (within(directory, selected) || within(canonicalPath(directory, 'publicDirs'), canonical)) throw failure(key);
  }
}
function secretOf(env, key, served) {
  const inline = valueOf(env, key), file = valueOf(env, key + '_FILE');
  if ((inline === undefined) === (file === undefined)) throw failure(key);
  if (file !== undefined) assertPrivate(absolutePath(file, key + '_FILE'), served, key + '_FILE');
  const value = file === undefined ? inline : fileSecret(file, key + '_FILE');
  if (Buffer.byteLength(value, 'utf8') < 32 || Buffer.byteLength(value, 'utf8') > 512 || !value.isWellFormed() ||
      value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) throw failure(key);
  return value;
}

/**
 * Call once in the authoritative process. publicDirs must include every host-served
 * directory (including custom data/content/plugin roots). Secret values are never
 * suitable for diagnostics; report only error.code/error.setting on failure.
 */
export function authConfigFrom(env, { root, publicDirs = [] } = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw failure('environment');
  root = absolutePath(root, 'root');
  if (!Array.isArray(publicDirs) || publicDirs.length > 128) throw failure('publicDirs');
  const served = ['public', 'data', 'shared', 'packs', 'plugins'].map(name => path.join(root, name));
  for (const directory of publicDirs) served.push(absolutePath(directory, 'publicDirs'));
  const stateDir = absolutePath(valueOf(env, 'SP_STATE_DIR') ?? path.join(root, 'var'), 'SP_STATE_DIR');
  assertPrivate(stateDir, served, 'SP_STATE_DIR');
  const origin = valueOf(env, 'SP_AUTH_ORIGIN');
  const allowHttp = booleanOf(env, 'SP_AUTH_ALLOW_HTTP', false);
  let parsed;
  try { parsed = new URL(origin); } catch { throw failure('SP_AUTH_ORIGIN'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.origin !== origin || parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.protocol !== 'https:' && !(allowHttp && loopback && parsed.protocol === 'http:'))) throw failure('SP_AUTH_ORIGIN');
  const entryToken = secretOf(env, 'SP_ENTRY_TOKEN', served);
  const sessionSecret = secretOf(env, 'SP_SESSION_SECRET', served);
  if (entryToken === sessionSecret) throw failure('SP_SESSION_SECRET');
  return Object.freeze({
    stateDir,
    store: Object.freeze({ file: path.join(stateDir, 'auth.sqlite') }),
    service: Object.freeze({ origin, entryToken, sessionSecret, allowHttp,
      registrationOpen: booleanOf(env, 'SP_REGISTRATION_OPEN', true) }),
    admission: Object.freeze({ humanLimit: 16, botLimit: integerOf(env, 'SP_BOT_LIMIT', 16, 256) }),
  });
}
