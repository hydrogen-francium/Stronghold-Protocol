// server/index.js — process entry & boot (DESIGN §1, §2). Plain node:http + ws, no framework: startServer() below
// wires the modules under server/http/, in this order —
//
//   http/config.js     ROOT, the served directories, the environment (PORT 3000, HOST '::' dual-stack, TRUST_PROXY auto, DEBUG),
//                      which startServer() options go to net.js / lobby.js, the console logger
//   http/websocket.js  session wiring (SessionRegistry → Lobby → Network) and the WebSocket at /ws (maxPayload 64 KB,
//                      permessage-deflate from 1 KB; refused at upgrade with 404 / 429 per network / 503)
//   http/static.js     the static mounts (/ → public/, /data/, /shared/, /sim/ `.js` only), the /data.js browser stand-in,
//                      the language packs (/packs/index.json, /packs/<id>/<file>), the plugin catalogue
//                      (/plugins/index.json — the registry is plugins/registry.js), the vanilla content set's manifest
//                      (/cs/<cs16>/index.json — plugins/identity.js: the content hash `cs`, DESIGN §32), the visual sets
//                      of cosmetic plugins (/vs/<vs16>/…, plugins/visualSet.js) and their files (/p/<id>/<hash8>/…),
//                      the content sets of gameplay plugins (/cs/<cs16>/…, plugins/contentSets.js — DESIGN §32.6; the
//                      server owner's plugins/config.json: plugins/policy.js; a room's plugins: plugins/roomSets.js; its
//                      match then runs in that set's worker: match/host/)
//   http/media.js      /media/bgm/act1 → public/assets/audio/bgm/act1.mp3 (audio addressed without its extension)
//   http/files.js      one file → response: MIME, brotli / gzip + memory cache, ETag / Last-Modified / 304, Cache-Control, ranges
//   http/assetIndex.js the content hashes of public/assets and public/fonts (built in the background, cached in
//                      .cache/asset-hashes.json by path + size + mtime; Spine models share one hash)
//   http/assetViews.js the served /data/assets.json, /data/local-assets.json and /data/local-fx.json: every art URL with
//                      its hash segment (/assets/~<hash>/…, immutable when the hash matches); the files stay unchanged
//   http/buildTag.js   the build tag of the served browser runtime (/healthz `build`, public/js/ui/buildGuard.js)
//   http/routes.js     the request listener: security headers, 414 / 400, the plugin studio (/studio/, studio/index.js —
//                      this machine and the local network only), 405, GET /healthz → JSON status, else static
//   http/traffic.js    the traffic counters: bytes sent per category (assets / audio / code / data) and on the
//                      WebSocket, since the start (GET /healthz?traffic=1)
//   http/common.js     what every answer shares: security headers, URL split, error page, JSON replies, bare 400
//   http/boot.js       a pending update package first (update.js: old files deleted, the install verified against
//                      MANIFEST.json), banner (Local / LAN / tunnel URLs), port-in-use hint, graceful shutdown on SIGINT /
//                      SIGTERM
//
// Per-network limits for internet clients (see net.js clientAddress; local/LAN peers are exempt): open sockets
// (maxConnectionsPerAddr, refused at upgrade with 429), rooms and running matches (lobby.js).
//
// Programmatic use: supply validated authEnv (synthetic private state in tests), then await srv.close().
// The server only auto-listens when this file is the process entry point.

import http from 'node:http';
import path from 'node:path';
import { assetBundleFrom } from './http/assetBundle.js';
import { drainCheckFrom } from './http/drain.js';
import { getData, loadData } from './data.js';
import { ROOT, listenAddress, bindCandidates, serveDirs, makeLogger, parseTrustProxy, assetIndexOptionsFrom } from './http/config.js';
import { WS_MAX_PAYLOAD, createSessionStack, attachWebSocket } from './http/websocket.js';
import { siteCsp } from './http/csp.js';
import { DATA_SHIM_JS, createStaticHandler } from './http/static.js';
import { createPluginRegistry } from './plugins/registry.js';
import { computeVanillaContent } from './plugins/identity.js';
import { createVisualSets } from './plugins/visualSet.js';
import { createContentSets } from './plugins/contentSets.js';
import { createPluginPolicy } from './plugins/policy.js';
import { createRoomSets } from './plugins/roomSets.js';
import { createMatchHosts } from './match/host/index.js';
import { createTrustedRuntime } from './plugins/trustedRuntime.js';
import { trustedHostAllowed } from './plugins/trusted.js';
import { createStudio } from './studio/index.js';
import { MIME, COMPRESSIBLE, acceptsGzip, pickEncoding, parseRange } from './http/files.js';
import { BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag } from './http/buildTag.js';
import { createRequestHandler } from './http/routes.js';
import { createTrafficCounter } from './http/traffic.js';
import { createAssetIndex } from './http/assetIndex.js';
import { createManifestViews } from './http/assetViews.js';
import { answerClientError } from './http/common.js';
import { lanUrls, displayHost, isProcessEntry, runMain } from './http/boot.js';
import { clientAddress } from './net.js';
import { authConfigFrom } from './auth/config.js';
import { AuthStore } from './auth/store.js';
import { Passwords } from './auth/passwords.js';
import { AuthService } from './auth/service.js';
import { Admission } from './auth/admission.js';
import { createAuthShell } from './http/auth.js';
import { studioMode } from './studio/gate.js';

// The public API of this module (tests and tools import it from here); the code lives in ./http/.
export {
  ROOT, WS_MAX_PAYLOAD, DATA_SHIM_JS, MIME, COMPRESSIBLE, BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag,
  acceptsGzip, pickEncoding, parseRange, createStaticHandler, lanUrls, parseTrustProxy,
};

/**
 * 构建并启动认证、房间、静态资源与实时服务；启动失败关闭已取得的资源。
 * @param {{
 *   port?: number, host?: string, quiet?: boolean, log?: object,
 *   publicDir?: string, dataDir?: string, sharedDir?: string, packsDir?: string, pluginsDir?: string, assetBundleDir?: string, drainFile?: string,
 *   MatchClass?: Function, seedFn?: () => number,
 *   lobbyGraceMs?: number, reconnectWindowMs?: number, heartbeatMs?: number, helloTimeoutMs?: number,
 *   ratePerSec?: number, rateBurst?: number, maxConnections?: number, maxSessions?: number, maxRooms?: number,
 *   maxConnectionsPerAddr?: number, maxRoomsPerAddr?: number, maxMatchesPerAddr?: number, resyncMinGapMs?: number,
 *   heavyPerSec?: number, heavyBurst?: number, trustProxy?: 'auto' | boolean, soloReconnectWindowMs?: number,
 *   assetIndex?: boolean | { cacheFile?: string | null, delayMs?: number }, studio?: boolean,
 *   matchHost?: object, authEnv?: Record<string, string | undefined>,
 * }} [opts]
 *   assetIndex: the content-hash index (default on; false or SP_ASSET_INDEX=0: off — config.js assetIndexOptionsFrom);
 *   studio: the plugin studio at /studio/ (fork default off; true or SP_STUDIO=lan|local enables the original
 *   address/Host/owner-key gates; false: none). authEnv supplies deployment settings, never an auth bypass;
 *   matchHost: options of the match hosts (server/match/host/index.js — watchdogMs, matchOptions …; tests)
 * @returns {Promise<{ port: number, host: string, url: string, server: http.Server, wss: import('ws').WebSocketServer,
 *                     lobby: import('./lobby.js').Lobby, network: import('./net.js').Network,
 *                     registry: import('./net.js').SessionRegistry, packs: ReturnType<typeof createPluginRegistry>,
 *                     content: import('./plugins/identity.js').VanillaContent, visual: ReturnType<typeof createVisualSets>,
 *                     contents: ReturnType<typeof createContentSets>, hosts: ReturnType<typeof createMatchHosts>, admission: Admission,
 *                     traffic: ReturnType<typeof createTrafficCounter>, assetIndex: ReturnType<typeof createAssetIndex> | null,
 *                     views: ReturnType<typeof createManifestViews> | null, studio: ReturnType<typeof createStudio> | null,
 *                     close: () => Promise<void> }>}
 */
export async function startServer(opts = {}) {
  const { port, host } = listenAddress(opts);
  const log = opts.log || makeLogger(!!opts.quiet);
  const { publicDir, dataDir, sharedDir, packsDir, pluginsDir } = serveDirs(opts);
  const bundle = assetBundleFrom(opts.assetBundleDir ?? process.env.SP_ASSET_BUNDLE_DIR);
  const assetPublicDir = bundle?.publicDir ?? publicDir;
  const assetDataDir = bundle?.dataDir ?? dataDir;
  const simDir = path.join(ROOT, 'server', 'sim');
  // Fork deployment: there is no unauthenticated production mode. Programmatic tests
  // provide synthetic settings through authEnv, subject to the same validation.
  const config = authConfigFrom(opts.authEnv ?? process.env, {
    root: ROOT, publicDirs: [publicDir, dataDir, sharedDir, simDir, packsDir, pluginsDir, assetPublicDir, assetDataDir],
  });
  const isDraining = drainCheckFrom(opts.drainFile ?? process.env.SP_DRAIN_FILE, config.stateDir);
  const trustProxy = opts.trustProxy ?? parseTrustProxy(process.env.TRUST_PROXY);
  let store, passwords, auth, admission, registry, lobby, network, hosts;
  let assetIndex, studio, trustedRuntime, server, wss;
  let closing = null;

  // Used for both partial startup and normal shutdown. Mark auth closed first, so
  // in-flight/queued work fails closed while sockets and match hosts are drained.
  function close() {
    if (closing) return closing;
    closing = (async () => {
      const pending = [], errors = [];
      const failed = (label, error) => {
        errors.push(error);
        log.error(`[shutdown] ${label}`, error?.code || 'CLOSE_FAILED');
      };
      const stop = (label, action) => {
        try { pending.push(Promise.resolve(action()).catch(e => failed(label, e))); }
        catch (e) { failed(label, e); }
      };
      if (auth) stop('auth', () => auth.close());
      else {
        if (passwords) stop('passwords', () => passwords.close());
        if (store) stop('auth store', () => store.close());
      }
      if (lobby) stop('lobby', () => lobby.shutdown('shutdown'));
      if (network) stop('network', () => network.close());
      if (hosts) stop('match hosts', () => hosts.close());
      if (assetIndex) stop('asset index', () => assetIndex.close());
      if (studio) stop('studio', () => studio.close());
      if (trustedRuntime) stop('trusted runtime', () => trustedRuntime.close());
      if (wss) stop('websocket', () => new Promise((resolve, reject) => {
        wss.close(error => error ? reject(error) : resolve());
      }));
      if (server) stop('http', () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { server.closeAllConnections?.(); }, 500);
        timer.unref?.();
        const done = (error) => {
          clearTimeout(timer);
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        };
        try {
          server.close(done);
          server.closeIdleConnections?.();
        } catch (e) { done(e); }
      }));
      await Promise.all(pending);
      if (errors.length) throw new AggregateError(errors, 'Server cleanup failed');
    })();
    return closing;
  }

  try {
    store = new AuthStore(config.store);
    passwords = new Passwords();
    auth = new AuthService({
      ...config.service, store, passwords,
      addressKey: req => {
        const address = clientAddress(req, trustProxy);
        return address.key || address.ip;
      },
      onRevoke: (accountId, tokenHash) => network?.revoke(accountId, tokenHash),
    });
    // The only active-seat ledger in this app instance. Never send its lease tokens
    // or the account/session service into Match options, plugins, or IPC.
    admission = new Admission(config.admission);

    // The process-wide singleton serves the default data dir; a custom dir (tests) gets its own copy.
    const data = opts.dataDir ? loadData(dataDir, { log }) : getData({ dir: dataDir, log });
    const content = computeVanillaContent({ simDir, sharedDir, dataDir, shim: DATA_SHIM_JS, log });
    log.info(`[content] vanilla ${content.cs.slice(0, 16)} (${Object.keys(content.simFiles).length} code files, ${Object.keys(content.data).length} data files)`);
    const scriptMode = process.env.SP_PLUGIN_SCRIPTS;
    const packs = createPluginRegistry({ publicDir, dataDir, assetDataDir, packsDir, pluginsDir }, { log, scriptHost: host, scriptMode });
    packs.refresh(true);
    const indexOptions = assetIndexOptionsFrom(opts, publicDir);
    assetIndex = indexOptions ? createAssetIndex({ publicDir: assetPublicDir, log, ...indexOptions }) : null;
    const views = createManifestViews({ dataDir: assetDataDir, index: assetIndex, log });
    const visual = createVisualSets({ registry: packs, log });
    const policy = createPluginPolicy({ pluginsDir, log });
    const contents = createContentSets({ registry: packs, vanillaData: data, log, maxSets: () => policy.get().maxSets });
    const roomSets = createRoomSets({ registry: packs, visual, contents, policy });
    const transport = String(process.env.SP_MATCH_HOST || '').trim().toLowerCase() === 'worker' ? 'worker' : 'process';
    hosts = createMatchHosts({ contents, log, options: { transport, maxWorkers: Math.max(1, policy.get().maxSets), ...(opts.matchHost || {}) } });
    ({ registry, lobby, network } = createSessionStack(opts, { data, log, content, plugins: roomSets, hosts, auth, admission, isDraining }));
    const serveStatic = createStaticHandler({ publicDir, dataDir, assetPublicDir, assetDataDir, sharedDir, simDir, packsDir, pluginsDir, packs, content, log, assetIndex, views, visual, contents });
    // A persistent game login is not studio ownership. Explicit enabling still
    // retains the original local/Host/owner-key gates; the public fork defaults off.
    const studioEnabled = opts.studio === true || (opts.studio !== false &&
      ['lan', 'local', 'loopback'].includes(String(process.env.SP_STUDIO ?? '').trim().toLowerCase()));
    studio = studioEnabled ? createStudio({ publicDir, pluginsDir, dataDir, registry: packs, lobby, sessions: registry, log, fetch: opts.fetch, mode: studioMode() }) : null;
    trustedRuntime = await createTrustedRuntime({ registry: packs, log });
    lobby.trustedRuntime = trustedRuntime;
    const startedAt = Date.now();
    resetBuildTag();
    buildTag();

    const traffic = createTrafficCounter();
    server = http.createServer(createRequestHandler({
      serveStatic, csp: process.env.SP_CSP === 'off' ? null : siteCsp(publicDir),
      health: { startedAt, network, registry, lobby, content, traffic, assetIndex, views, trusted: trustedRuntime?.health },
      log, trustProxy: network.opts.trustProxy, studio, trustedRuntime,
      auth, authShell: createAuthShell(publicDir),
    }));
    server.on('clientError', answerClientError);
    wss = attachWebSocket(server, { network, log, traffic, auth });

    let bound = null, lastError = null;
    const candidates = bindCandidates(host);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      try {
        await new Promise((resolve, reject) => {
          const onError = (e) => { server.off('listening', onListening); reject(e); };
          const onListening = () => { server.off('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, candidate);
        });
        bound = candidate;
        break;
      } catch (e) {
        lastError = e;
        const retry = ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL'].includes(e.code) && i < candidates.length - 1;
        if (!retry) break;
        log.warn(`[boot] cannot bind ${candidate} (${e.code}) — falling back to IPv4 only`);
      }
    }
    if (bound === null) throw lastError;
    // Check the kernel's address too: aliases/DNS and bind fallback cannot weaken the owner gate.
    const actual = server.address();
    const scriptHost = actual && typeof actual === 'object' ? actual.address : '';
    packs.setScriptHost(scriptHost);
    const testGate = lobby.setTestHost(scriptHost);
    if (testGate.warn) log.warn(`[test-mode] ${testGate.warn}`);
    else if (testGate.enabled) log.info('[test-mode] test rooms enabled');
    if (!trustedHostAllowed(scriptHost, scriptMode)) {
      lobby.trustedRuntime = null;
      await trustedRuntime?.close();
    }
    server.on('error', (e) => log.error('[http] server error', e));
    assetIndex?.start();
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    const url = `http://${displayHost(bound)}:${actualPort}`;
    return { port: actualPort, host: bound, url, server, wss, lobby, network, registry, packs, content, visual, contents, hosts, admission, traffic, assetIndex, views, studio, close };
  } catch (error) {
    try { await close(); } catch { /* preserve the original startup failure */ }
    throw error;
  }
}

// `node server/index.js` / npm start: listen, print the banner, stop on SIGINT / SIGTERM (http/boot.js).
if (isProcessEntry(import.meta.url)) runMain(startServer);
