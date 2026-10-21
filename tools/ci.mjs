#!/usr/bin/env node
// tools/ci.mjs — run the checks of .github/workflows/ci.yml locally, one after another (CONTRIBUTING.md §2).
//
//   node tools/ci.mjs                    every step; stops at the first failing one (exit 1)
//   node tools/ci.mjs --keep-going       run every step even after a failure (exit 1 when any failed)
//   node tools/ci.mjs --only lint,test   only the named steps (in the workflow's order)
//   node tools/ci.mjs --list             print the steps and the ci.yml step each one mirrors
//   npm run ci                           the same as the first line
//
// Steps, in the order of ci.yml (job `test`, then job `tooling`):
//   setup      node tools/setup.mjs --check --no-local
//   test       npm test: node --test over TEST_FILES (package.json "test")
//   smoke      real CLI on loopback with owned temporary state/secrets, real HTTP admission/account login,
//              authenticated health + byte-exact index/vendor, then doctor's strict stdin-auth probe; always clean up
//   lint       eslint .                                   (npm run lint; warnings do not fail it)
//   imports    node tools/check-imports.mjs               (npm run check:imports)
//   typecheck  tsc --noEmit --checkJs -p jsconfig.json    (npm run typecheck)
// The job `test` steps get ci.yml's env (SP_E2E=0, SP_REAL_E2E=0, RENDER_E2E=0, NO_COLOR=1) unless already set.
//
// Not mirrored: actions/checkout and actions/setup-node (GitHub runner setup) and `npm ci` (the install — run it
// yourself; replacing node_modules is not a check). The OS × Node matrix is whatever this machine has.
// Every child is `process.execPath` with a script path (eslint and tsc from node_modules/<pkg>/package.json `bin`),
// never npm or a shell, so the run does not depend on PATH or on the shell npm uses for scripts.
// test/ci.test.js keeps this list and ci.yml in step: a ci.yml step this file does not know fails it.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isFullHealth } from './doctor.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The env of ci.yml's job `test` (test/ci.test.js compares it with the workflow). */
export const CI_TEST_ENV = { SP_E2E: '0', SP_REAL_E2E: '0', RENDER_E2E: '0', NO_COLOR: '1' };

/** The real game resources checked after HTTP admission and account authentication. */
export const SMOKE_PATHS = ['/healthz', '/', '/vendor/pixi.min.js'];
export const SMOKE_COMMAND = 'node tools/ci.mjs --only smoke';

/**
 * The test files `npm test` runs (package.json "test", which ci.yml runs): every *.test.js under test/, the browser E2E
 * test/e2e/coop.e2e.mjs (it skips itself without Chrome) and the plugin template's author test (it skips itself outside
 * `node tools/plugin.mjs test`). A bare `node --test` uses Node's default patterns, which take every other .js under
 * test/ for a test file too: the helpers, the child-process entries and the Forge fixtures — untrusted bait that writes
 * files when it runs. test/ci.test.js checks this list against the tree.
 */
export const TEST_FILES = ['test/**/*.test.js', 'test/e2e/coop.e2e.mjs', 'plugins/_template/**/*.test.js'];

/** ci.yml steps that only make sense on a GitHub runner, by `uses:` action or by step name. */
export const SKIPPED_CI_STEPS = [
  { uses: 'actions/checkout', why: 'GitHub runner: the checkout is this folder' },
  { uses: 'actions/setup-node', why: 'GitHub runner: the Node.js of this machine is used' },
  { name: 'Install (npm ci → postinstall copies public/vendor)', why: 'run `npm ci` yourself; it is not a check' },
];

/**
 * The local steps (runStep runs them). `ci` names the ci.yml job and step it mirrors; `npm` the package.json script
 * ci.yml runs there, and `describe` is that script's command (test/ci.test.js checks both).
 * @typedef {{ id: string, ci: { job: string, name: string }, npm?: string, describe: string }} Step
 * @type {Step[]}
 */
export const STEPS = [
  { id: 'setup', ci: { job: 'test', name: 'Setup check (no downloads)' }, describe: 'node tools/setup.mjs --check --no-local' },
  // (the globs quoted: no shell expands them — Node's test runner does, the same on every OS)
  { id: 'test', ci: { job: 'test', name: 'Unit & integration tests' }, npm: 'test',
    describe: `node --test ${TEST_FILES.map((g) => `"${g}"`).join(' ')}` },
  { id: 'smoke', ci: { job: 'test', name: 'Server smoke test (boot, /healthz, index.html, doctor)' },
    describe: `server on a free port: GET ${SMOKE_PATHS.join(', ')}; node tools/doctor.mjs` },
  { id: 'lint', ci: { job: 'tooling', name: 'Lint (warnings allowed)' }, npm: 'lint', describe: 'eslint .' },
  { id: 'imports', ci: { job: 'tooling', name: 'Import boundaries' }, npm: 'check:imports', describe: 'node tools/check-imports.mjs' },
  { id: 'typecheck', ci: { job: 'tooling', name: 'Typecheck' }, npm: 'typecheck', describe: 'tsc --noEmit --checkJs -p jsconfig.json' },
];

// ---------------------------------------------------------------------------------------------------------------------
// ci.yml, read just far enough: jobs, each job's env (flat KEY: value) and steps (name, uses, run, shell; the names
// of any other step keys in `other`, so test/ci.test.js can refuse per-step config this script does not mirror).

const unquote = (s) => {
  const v = s.trim();
  return /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v;
};

/**
 * A line-based reader for the shape of .github/workflows/ci.yml (block mappings, `- ` step lists, `run: |` blocks).
 * Not a YAML parser: flow mappings, anchors and multi-document files are not handled.
 * @param {string} text
 * @returns {{ jobs: Record<string, { env: Record<string, string>, steps: { name?: string, uses?: string, run?: string, shell?: string, other?: string[] }[] }> }}
 */
export function parseWorkflow(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const indentOf = (l) => l.length - l.trimStart().length;
  const blank = (l) => l.trim() === '' || l.trim().startsWith('#');
  /** @type {Record<string, { env: Record<string, string>, steps: any[] }>} */
  const jobs = {};
  let i = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (i < 0) return { jobs };
  let jobIndent = -1;
  let job = null;
  let section = null; // 'env' | 'steps' | null
  let sectionIndent = -1;
  let step = null;
  let stepIndent = -1;
  for (i += 1; i < lines.length; i++) {
    const line = lines[i];
    if (blank(line)) continue;
    const ind = indentOf(line);
    if (ind === 0) break; // the next top-level key
    const t = line.trim();
    if (jobIndent < 0) jobIndent = ind;
    if (ind === jobIndent) {
      const m = /^([\w-]+):\s*$/.exec(t);
      job = m ? (jobs[m[1]] = { env: {}, steps: [] }) : null;
      section = null; step = null;
      continue;
    }
    if (!job) continue;
    if (section && ind <= sectionIndent) { section = null; step = null; }
    if (!section) {
      const m = /^(env|steps):\s*$/.exec(t);
      if (m) { section = m[1]; sectionIndent = ind; }
      continue;
    }
    if (section === 'env') {
      const m = /^([\w-]+):\s*(.*)$/.exec(t);
      if (m) job.env[m[1]] = unquote(m[2]);
      continue;
    }
    // steps
    let body = t;
    if (t.startsWith('- ')) {
      step = /** @type {{ name?: string, uses?: string, run?: string, shell?: string, other?: string[] }} */ ({});
      job.steps.push(step);
      stepIndent = ind + 2;
      body = t.slice(2).trim();
    } else if (!step || ind < stepIndent) continue;
    else if (ind > stepIndent) continue; // nested (with: …)
    const m = /^(name|uses|run|shell):\s*(.*)$/.exec(body);
    if (!m) {
      const k = /^([\w-]+):/.exec(body); // env, if, with, continue-on-error, working-directory, …: the key name only
      if (k) (step.other ||= []).push(k[1]);
      continue;
    }
    if (m[1] === 'run' && /^[|>][-+]?$/.test(m[2].trim())) {
      const block = [];
      let j = i + 1;
      let blockIndent = -1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === '') { block.push(''); continue; }
        const li = indentOf(l);
        if (li < stepIndent || (blockIndent < 0 && li <= stepIndent)) break;
        if (blockIndent < 0) blockIndent = li;
        if (li < blockIndent) break;
        block.push(l.slice(blockIndent));
      }
      i = j - 1;
      step.run = block.join('\n').replace(/\n+$/, '');
    } else {
      step[m[1]] = unquote(m[2]);
    }
  }
  return { jobs };
}

/** Is a ci.yml step one of SKIPPED_CI_STEPS? @param {{ name?: string, uses?: string }} s */
export function isSkippedCiStep(s) {
  return SKIPPED_CI_STEPS.some((k) => (k.uses ? (s.uses || '').split('@')[0] === k.uses : s.name === k.name));
}

// ---------------------------------------------------------------------------------------------------------------------
// Arguments, env, summary.

/**
 * @param {string[]} argv
 * @returns {{ keepGoing: boolean, only: string[] | null, list: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const o = { keepGoing: false, only: /** @type {string[] | null} */ (null), list: false, help: false };
  const ids = new Set(STEPS.map((s) => s.id));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep-going' || a === '-k') o.keepGoing = true;
    else if (a === '--list') o.list = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--only' || a.startsWith('--only=')) {
      const v = a === '--only' ? argv[++i] : a.slice('--only='.length);
      if (!v) throw new Error('--only needs step names: ' + [...ids].join(','));
      for (const id of v.split(',').map((x) => x.trim()).filter(Boolean)) {
        if (!ids.has(id)) throw new Error(`unknown step "${id}" (steps: ${[...ids].join(', ')})`);
        (o.only ??= []).push(id);
      }
    } else throw new Error(`unknown option ${a} (node tools/ci.mjs --help)`);
  }
  return o;
}

/** The steps to run, in workflow order. @param {string[] | null} only */
export function selectSteps(only) {
  return only ? STEPS.filter((s) => only.includes(s.id)) : STEPS.slice();
}

// Smoke is not a deployment: select names before touching values (including getters in regression tests).
// Only platform/process necessities survive. In particular no auth/state/*_FILE, Node/native preload,
// inherited listener, proxy, studio or application settings can reach either smoke child.
const SMOKE_ENV_NAMES = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'CI', 'NO_COLOR',
]);
export function smokeEnvironment(source = process.env) {
  const env = {};
  for (const key of Object.keys(source)) {
    if (!SMOKE_ENV_NAMES.has(key.toUpperCase())) continue;
    const value = source[key];
    if (typeof value === 'string') env[key] = value;
  }
  return Object.assign(env, CI_TEST_ENV);
}

/** Other steps retain their old env contract; smoke filters before any inherited value is read. */
export function stepEnv(step, base = process.env) {
  const env = step.id === 'smoke' ? smokeEnvironment(base) : { ...base };
  if (step.ci.job === 'test') for (const [k, v] of Object.entries(CI_TEST_ENV)) if (env[k] === undefined) env[k] = v;
  return env;
}

/** @param {number} ms */
export function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

/**
 * The summary table. `status`: ok | fail | not run.
 * @param {{ id: string, status: 'ok' | 'fail' | 'not run', ms?: number, note?: string }[]} results
 */
export function formatSummary(results) {
  const w = Math.max(...results.map((r) => r.id.length), 4);
  const label = { ok: 'ok', fail: 'FAIL', 'not run': '-' };
  const rows = results.map((r) => {
    const time = r.ms == null ? '' : formatDuration(r.ms);
    return `  ${label[r.status].padEnd(5)} ${r.id.padEnd(w)}  ${time.padStart(7)}${r.note ? '  ' + r.note : ''}`.trimEnd();
  });
  const failed = results.filter((r) => r.status === 'fail').map((r) => r.id);
  const tail = failed.length ? `FAILED: ${failed.join(', ')}` : results.some((r) => r.status === 'ok') ? 'all steps passed' : 'nothing ran';
  return ['', '── ci summary ──', ...rows, tail, ''].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// Running.

/** The JS entry of a dependency's bin, e.g. ('eslint', 'eslint') → node_modules/eslint/bin/eslint.js. */
export function binPath(pkg, name, root = ROOT) {
  const dir = path.join(root, 'node_modules', pkg);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {
    throw new Error(`${pkg} is not installed (node_modules/${pkg}) — run npm ci first`);
  }
  const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[name];
  if (!rel) throw new Error(`node_modules/${pkg}/package.json has no bin "${name}"`);
  return path.join(dir, rel);
}

/** Run `node <args>` in ROOT with inherited stdio; resolves to the exit code (1 when killed by a signal). */
function node(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' });
    child.on('error', (e) => { console.error(e.message); resolve(1); });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** A free TCP port on 127.0.0.1. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
  });
}

/** Live server children, killed if this process exits early. @type {Set<import('node:child_process').ChildProcess>} */
const servers = new Set();
process.on('exit', () => { for (const c of servers) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

/** Stop a server child: SIGTERM (graceful on POSIX; on Windows kill() terminates), SIGKILL after 8 s. */
function stopServer(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) { servers.delete(child); return Promise.resolve(); }
  return new Promise((resolve) => {
    const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 8000);
    child.once('exit', () => { clearTimeout(force); servers.delete(child); resolve(); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(force); servers.delete(child); resolve(); }
  });
}

/** Literal loopback HTTP only: no proxy/redirect machinery and no destination from credentials or environment. */
export function smokeRequest(port, rawPath, { method = 'GET', headers = {}, body } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/(?!\/)[^\r\n]*$/.test(rawPath)) {
    throw new Error('Invalid smoke request target');
  }
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: rawPath, method, agent: false, timeout: 10000,
      headers: { 'Accept-Encoding': 'identity', ...headers,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) req.destroy(new Error('Smoke response too large'));
        else chunks.push(chunk);
      });
      res.on('error', () => reject(new Error('Smoke response interrupted')));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', e => reject(new Error(`Smoke HTTP request failed (${e.code || 'HTTP_ERROR'})`)));
    req.on('timeout', () => req.destroy(new Error('Smoke request timed out')));
    req.end(payload);
  });
}

function smokeJson(response, label) {
  if (response.status !== 200) throw new Error(`${label}: HTTP ${response.status}, expected 200`);
  if (!/^application\/json\b/i.test(response.headers['content-type'] || '')) throw new Error(`${label}: expected JSON`);
  try { return JSON.parse(response.body.toString('utf8')); }
  catch { throw new Error(`${label}: invalid JSON`); }
}

/** One bounded real account, registered then logged in over the same admission/CSRF HTTP protocol as the UI. */
export async function smokeAccount(port, entryToken, password) {
  const jar = new Map();
  const origin = `http://127.0.0.1:${port}`;
  let csrf;
  const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  const request = async (route, body) => {
    const response = await smokeRequest(port, route, {
      method: body === undefined ? 'GET' : 'POST', body,
      headers: { Origin: origin, Cookie: cookie(), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    });
    const json = smokeJson(response, route);
    for (const line of response.headers['set-cookie'] || []) {
      const pair = line.split(';', 1)[0], eq = pair.indexOf('=');
      const name = pair.slice(0, eq), value = pair.slice(eq + 1);
      if (!['sp_gate', 'sp_session', 'sp_csrf'].includes(name)) throw new Error('Unexpected smoke auth cookie');
      if (!value || /;\s*Max-Age=0(?:;|$)/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
    csrf = json.csrf;
    if (!/^[a-f0-9]{64}$/.test(csrf || '') || jar.get('sp_csrf') !== csrf) throw new Error('Smoke CSRF bootstrap failed');
    return json;
  };
  const initial = await request('/auth/status');
  if (initial.admitted !== false || initial.account !== null || initial.registrationOpen !== true) throw new Error('Smoke state is not fresh');
  if ((await request('/auth/admit', { token: entryToken })).admitted !== true) throw new Error('Smoke admission failed');
  const username = 'ci_smoke';
  const registered = await request('/auth/register', { username, password, name: 'CI Smoke' });
  const id = registered.account?.id;
  if (!/^a_[a-f0-9]{32}$/.test(id || '') || registered.account.username !== username) throw new Error('Smoke registration failed');
  const loggedIn = await request('/auth/login', { username, password });
  if (loggedIn.account?.id !== id) throw new Error('Smoke login changed account');
  const status = await request('/auth/status');
  if (status.admitted !== true || status.account?.id !== id || !jar.has('sp_gate') || !jar.has('sp_session')) {
    throw new Error('Smoke account session was not established');
  }
  return { cookie: cookie() };
}

/** Strict 200, complete health, and byte-exact real game files: an auth page can never satisfy the index check. */
export function checkSmokeResponse(route, response, expected = null) {
  if (response.status !== 200) throw new Error(`${route}: HTTP ${response.status}, expected 200`);
  if (route === '/healthz') {
    if (!isFullHealth(smokeJson(response, route))) throw new Error('Authenticated full health required');
    return;
  }
  const type = response.headers['content-type'] || '';
  if (route === '/' ? !/^text\/html\b/i.test(type) : !/^(?:text|application)\/javascript\b/i.test(type)) {
    throw new Error(`${route}: unexpected MIME type`);
  }
  if (!Buffer.isBuffer(expected) || !expected.length || !response.body.equals(expected)) throw new Error(`${route}: not the real game file`);
  if (route === '/' && !/<script\b[^>]*\bsrc=["']\/js\/main\.js["']/i.test(response.body.toString('utf8'))) {
    throw new Error('Game index entry missing');
  }
}

function smokeDoctor(port, auth, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['tools/doctor.mjs', '--auth-stdin', '--port', String(port), '--host', '127.0.0.1'], {
      cwd: ROOT, env, stdio: ['pipe', 'inherit', 'inherit'],
    });
    servers.add(child);
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 10000);
    child.once('error', () => { clearTimeout(timer); servers.delete(child); resolve(1); });
    child.once('close', code => { clearTimeout(timer); servers.delete(child); resolve(code ?? 1); });
    child.stdin.on('error', () => { /* exit/timeout is checked, never print credential-bearing stream errors */ });
    child.stdin.end(JSON.stringify(auth));
  });
}

/** Shared workflow/local smoke. No deployment files are loaded; only this invocation's root may be removed. */
async function smoke(env) {
  let root, child, log = '';
  const secrets = [];
  try {
    const safe = smokeEnvironment(env), port = await freePort();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ci-smoke-'));
    const state = path.join(root, 'state');
    fs.mkdirSync(state, { mode: 0o700 });
    const entryToken = randomBytes(32).toString('hex'), sessionSecret = randomBytes(32).toString('hex');
    const password = randomBytes(24).toString('hex');
    secrets.push(entryToken, sessionSecret, password);
    const childEnv = { ...safe, PORT: String(port), HOST: '127.0.0.1', TRUST_PROXY: '0',
      SP_STATE_DIR: state, SP_AUTH_ORIGIN: `http://127.0.0.1:${port}`, SP_AUTH_ALLOW_HTTP: '1',
      SP_ENTRY_TOKEN: entryToken, SP_SESSION_SECRET: sessionSecret, SP_REGISTRATION_OPEN: '1',
      SP_STUDIO: 'off', SP_PLUGIN_SCRIPTS: 'off', SP_ASSET_INDEX: '0' };
    child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    servers.add(child);
    const record = bytes => { log = (log + bytes.toString('utf8')).slice(-65536); };
    child.stdout.on('data', record);
    child.stderr.on('data', record);
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => reject(new Error('Smoke server could not start')));
    });
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Smoke server exited before readiness');
      try {
        const json = smokeJson(await smokeRequest(port, '/healthz'), '/healthz');
        ready = json.ok === true && Object.keys(json).length === 1;
      } catch { /* not listening yet */ }
      if (!ready) await delay(1000);
    }
    if (!ready) throw new Error('No anonymous readiness within 30 attempts');
    const anonymousIndex = await smokeRequest(port, '/');
    const anonymousVendor = await smokeRequest(port, '/vendor/pixi.min.js');
    if (anonymousIndex.status !== 303 || anonymousIndex.headers.location !== '/auth/' || anonymousVendor.status !== 401) {
      throw new Error('Anonymous game boundary changed');
    }
    console.log('smoke: anonymous readiness and game auth boundary verified');
    const auth = await smokeAccount(port, entryToken, password);
    secrets.push(auth.cookie);
    console.log('smoke: one account registered and logged in through real HTTP admission');
    for (const route of SMOKE_PATHS) {
      const response = await smokeRequest(port, route, { headers: { Cookie: auth.cookie } });
      const file = route === '/' ? 'public/index.html' : route === '/vendor/pixi.min.js' ? 'public/vendor/pixi.min.js' : null;
      checkSmokeResponse(route, response, file ? fs.readFileSync(path.join(ROOT, file)) : null);
      console.log(`smoke: authenticated GET ${route} → 200${file ? ', real file verified' : ', full health verified'}`);
    }
    const code = await smokeDoctor(port, auth, safe);
    if (code !== 0) throw new Error(`Authenticated doctor failed (exit ${code})`);
    return 0;
  } catch (e) {
    let detail = `${e?.message || 'Smoke failed'}\n── server log ──\n${log}`;
    for (const value of secrets) detail = detail.replaceAll(value, '[redacted]');
    detail = detail.replace(/sp_(?:gate|session|csrf)=[^\s;]+/g, '[redacted-cookie]');
    console.error(`smoke: ${detail}`);
    return 1;
  } finally {
    if (child) await stopServer(child);
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

/** @param {Step} step @param {Record<string, string | undefined>} env */
function runStep(step, env) {
  switch (step.id) {
    case 'setup': return node(['tools/setup.mjs', '--check', '--no-local'], env);
    case 'test': return node(['--test', ...TEST_FILES], env);
    case 'smoke': return smoke(env);
    case 'lint': return node([binPath('eslint', 'eslint'), '.'], env);
    case 'imports': return node(['tools/check-imports.mjs'], env);
    case 'typecheck': return node([binPath('typescript', 'tsc'), '--noEmit', '--checkJs', '-p', 'jsconfig.json'], env);
    default: throw new Error(`no runner for step ${step.id}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (opts.help) {
    console.log('node tools/ci.mjs [--keep-going] [--only <step,…>] [--list]  — the checks of .github/workflows/ci.yml');
    console.log('steps: ' + STEPS.map((s) => s.id).join(', '));
    return 0;
  }
  if (opts.list) {
    for (const s of STEPS) console.log(`${s.id.padEnd(10)} ${s.describe}\n${''.padEnd(10)} ← ci.yml ${s.ci.job}: ${s.ci.name}`);
    for (const s of SKIPPED_CI_STEPS) console.log(`(skipped)  ${s.uses || s.name} — ${s.why}`);
    return 0;
  }
  const steps = selectSteps(opts.only);
  const results = steps.map((s) => ({ id: s.id, status: /** @type {'ok' | 'fail' | 'not run'} */ ('not run'), ms: undefined, note: undefined }));
  let stopped = false;
  for (let i = 0; i < steps.length; i++) {
    if (stopped) break;
    const step = steps[i];
    console.log(`\n▶ ${step.id} — ${step.describe}`);
    const t0 = performance.now();
    let code;
    try { code = await runStep(step, stepEnv(step)); } catch (e) { console.error(e?.message || e); code = 1; }
    results[i].ms = performance.now() - t0;
    results[i].status = code === 0 ? 'ok' : 'fail';
    if (code !== 0) {
      results[i].note = `exit ${code}`;
      if (!opts.keepGoing) stopped = true;
    }
  }
  console.log(formatSummary(results));
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}

function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) main().then((code) => { process.exitCode = code; }, (e) => { console.error(e?.stack || e); process.exitCode = 1; });
