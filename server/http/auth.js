// The public authentication shell has an exact allowlist, not a second static mount.
// Its code never imports the game graph; all other routes are behind AuthService.
import { constants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sendJson } from './common.js';

const SHELL_FILES = new Map([
  ['/auth', ['index.html', 'text/html; charset=utf-8']],
  ['/auth/', ['index.html', 'text/html; charset=utf-8']],
  ['/auth/client.js', ['client.js', 'text/javascript; charset=utf-8']],
  ['/auth/style.css', ['style.css', 'text/css; charset=utf-8']],
  ...['en', 'ja', 'ko', 'zh-TW'].map(lang =>
    [`/auth/i18n/${lang}.json`, [`i18n/${lang}.json`, 'application/json; charset=utf-8']]),
]);
const SHELL_MAX_BYTES = 1024 * 1024;
export const AUTH_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** Make the final cache policy private, including handlers which set writeHead headers themselves. */
export function privateResponse(res) {
  const writeHead = res.writeHead;
  res.writeHead = function privateWriteHead(status, reason, supplied) {
    const hasReason = typeof reason === 'string';
    const headers = hasReason ? supplied : reason;
    const pairs = Array.isArray(headers)
      ? Array.from({ length: headers.length / 2 }, (_, i) => [headers[i * 2], headers[i * 2 + 1]])
      : Object.entries(headers || {});
    const cacheHeaders = [], varyHeaders = [], kept = [];
    for (const [key, value] of pairs) {
      if (key.toLowerCase() === 'cache-control') cacheHeaders.push(value);
      else if (key.toLowerCase() === 'vary') varyHeaders.push(value);
      else kept.push([key, value]);
    }
    // writeHead fields replace setHeader fields, but repeated list-valued fields
    // within this call combine: a later line must not erase no-store or Vary: *.
    const cache = cacheHeaders.length ? cacheHeaders.join(', ') : this.getHeader('Cache-Control');
    const vary = varyHeaders.length ? varyHeaders.join(', ') : this.getHeader('Vary');
    const policies = String(cache || 'no-store').split(',').map(s => s.trim())
      .filter(s => s && !/^(?:public|private)$/i.test(s));
    this.setHeader('Cache-Control', ['private', ...policies].join(', '));
    const varies = String(vary || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!varies.some(s => s === '*' || s.toLowerCase() === 'cookie')) varies.push('Cookie');
    this.setHeader('Vary', varies.join(', '));
    const filtered = Array.isArray(headers) ? kept.flat() : Object.fromEntries(kept);
    return hasReason ? writeHead.call(this, status, reason, filtered) : writeHead.call(this, status, filtered);
  };
}

/** Serve only the fixed authentication files; never decode a path into the allowlist. */
export function createAuthShell(publicDir) {
  const root = path.resolve(publicDir, 'auth');
  return async function serveAuthShell(req, res, rawPath) {
    const file = SHELL_FILES.get(rawPath);
    if (!file) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendJson(req, res, 405, { error: 'METHOD' });
      return true;
    }
    let handle;
    try {
      let selected = root;
      const rootStat = await fsp.lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('auth shell directory');
      const parts = file[0].split('/');
      for (const part of parts.slice(0, -1)) {
        selected = path.join(selected, part);
        const stat = await fsp.lstat(selected);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('auth shell directory');
      }
      selected = path.join(selected, parts.at(-1));
      const before = await fsp.lstat(selected);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error('auth shell file');
      handle = await fsp.open(selected, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > SHELL_MAX_BYTES) throw new Error('auth shell bounds');
      const body = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < body.length) {
        const { bytesRead } = await handle.read(body, length, body.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > stat.size) throw new Error('auth shell changed');
      res.setHeader('Content-Security-Policy', AUTH_CSP);
      res.writeHead(200, { 'Content-Type': file[1], 'Content-Length': length, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body.subarray(0, length));
    } catch {
      // No paths or filesystem errors are exposed; an incomplete shell is not a game-page fallback.
      sendJson(req, res, 503, { error: 'AUTH_UNAVAILABLE' });
    } finally { await handle?.close(); }
    return true;
  };
}
