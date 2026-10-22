# Fork accounts and active-seat admission

This is the **fork-only** contract for the account/authentication and global Admission integration based on upstream
0.3.1. These are deliberate deployment customizations approved for this fork, not official-mode rules, not features
of the upstream 0.3.1 release. Capacity integration uses fork protocol version **2**. The normative implementation is in `server/auth/`,
`server/index.js`, `server/http/`, `server/net.js` and `server/lobby.js`; match-host leave confirmation is in
`server/match/host/`. Operational examples are in [DEPLOY.md](DEPLOY.md).

## 1. Three different identity layers

| Layer | Credential / state | What it means |
|---|---|---|
| Entry grant | Signed `sp_gate` cookie, obtained with the deployment's entry token | Permission to register an account; not required for subsequent login or game access |
| Server account and HTTP session | Durable account `accountId`; opaque `sp_session` cookie and paired CSRF | Authenticated account identity, freshly checked against SQLite |
| Game Session | In-memory `playerId`, reconnect `token`, room membership and socket owner | A retained game presence belonging to that authenticated account; not an HTTP login credential |

A nickname, room code, IP address, socket, browser-local profile or client-supplied `accountId` cannot establish account
identity. The server generates stable account IDs (`a_` plus 32 lowercase hex digits). There is at most one retained
game Session per authenticated account, even when the account has several valid HTTP sessions. That Session's
`playerId` is not the durable account ID.

Accounts and hashed HTTP session records survive a restart when their private SQLite state and deployment secrets
are retained. **Rooms, matches, game Sessions, reconnect tokens and Admission leases are in memory only.** Restarting
the authoritative process ends every run; a durable account is neither a saved match nor cloud match history.

## 2. Fail-closed startup configuration

`startServer()` validates configuration before opening the listener and constructs `AuthStore`, `Passwords`,
`AuthService` and exactly one `Admission`. There is no unauthenticated production mode or weak fallback secret.
Invalid/missing required settings fail startup with `AUTH_CONFIG`. `authEnv` is an internal way to supply the same
validated settings, not an authentication bypass. Independently constructed components with `auth = null` preserve
legacy/test behavior only.

The application does **not** load dotenv files. Supply environment variables through the actual launching process or
service manager. `server/auth/config.js` recognizes these settings:

| Setting | Contract |
|---|---|
| `SP_AUTH_ORIGIN` | Required exact serialized public Origin, e.g. `https://game.example.com`; no trailing slash, path, query, fragment or credentials. HTTPS is required except for the explicit loopback development exception below. |
| `SP_ENTRY_TOKEN` **or** `SP_ENTRY_TOKEN_FILE` | Exactly one required. Entry token shared with invited players; never a URL parameter. |
| `SP_SESSION_SECRET` **or** `SP_SESSION_SECRET_FILE` | Exactly one required. Independent server-only signing/session secret; never share it with players. Must differ from the entry token. |
| `SP_STATE_DIR` | Absolute private writable state directory; default `<repository-root>/var`. Database is `<stateDir>/auth.sqlite`. |
| `SP_AUTH_ALLOW_HTTP` | Default `false`. Only `1` / `true` / `0` / `false` are accepted. `true` permits `http:` only for `127.0.0.1`, `localhost` or `[::1]`, not LAN, VPN or public HTTP. |
| `SP_REGISTRATION_OPEN` | Default `true`; the same strict boolean syntax. `false` closes registration, not login for existing accounts. |
| `SP_BOT_LIMIT` | Separate server-wide AI-seat budget, default `16`; integer `0`–`256`. `0` prevents starting a roster containing AI seats. |

The human participation limit is fixed at **16** by production configuration; there is no `SP_HUMAN_LIMIT` setting.
Cookie lifetimes are constructor defaults (registration grant 12 hours; HTTP session and its paired CSRF cookie 7 days),
not configurable TTL environment variables. Successful registration/login clears the registration grant. Expired HTTP
sessions require username/password login, not the shared entry token; account existence does not expire with cookies.

Each secret must be well-formed UTF-8, 32–512 bytes, without leading/trailing whitespace or control characters. File
settings must be absolute paths to bounded regular non-symlink files; one final LF/CRLF is removed. Do not set both
inline and `_FILE` forms for a secret. State and secret-file paths are checked both lexically and canonically against
served roots, including custom roots. They must not be under `public/`, `data/`, `shared/`, the served sim, `packs/`
or `plugins/`. Do not include them in source archives, container build contexts, public mounts, logs or diagnostics.

The configured Origin is not inferred from `Host`, `Origin`, forwarded headers or `TRUST_PROXY`. A reverse proxy may
forward to loopback HTTP while browsers use the configured HTTPS Origin. Changing a tunnel domain or port requires
matching configuration and a restart. Rotating the entry token invalidates registration grants only. Rotating the
session secret invalidates registration grants and account sessions. Neither rotation deletes durable accounts.

## 3. Private SQLite and local maintenance

`AuthStore` uses native `node:sqlite`, schema version **1**, foreign keys, WAL and `synchronous=FULL`. The runtime
requirement in `package.json` is Node **`^22.16.0 || >=24.0.0`**. Do not substitute an older Node 22 minor.

The database stores account ID, normalized username, display name, a versioned salted scrypt password record,
disabled/credential-version state and timestamps. HTTP sessions store token and CSRF **hashes**, account/credential
version and expiry; plaintext passwords, session tokens and CSRF tokens are not stored. Current password derivation
uses scrypt `N=32768, r=8, p=1`, a 16-byte random salt and a 32-byte key, with a bounded asynchronous worker queue.
These are private authentication records, not match/result/profile-cloud tables.

New state parent directories use POSIX mode `0700`; database and regular WAL/SHM sidecars use `0600`. Existing parent
permissions are not repaired. **Windows ACLs are deliberately not changed**: the operator must protect directories,
secret files, sidecars and backups, and grant only the service identity the required access. File/path checks are
not a substitute for OS permissions or an isolated deployment account.

The store's defaults (10,000 accounts, 8,000 HTTP sessions and 8 HTTP sessions per account) are storage/credential
limits, **not** the global 16-human participation limit. Issuing another HTTP session can evict the oldest session
for that account; every continuing authorization check consults current store state.

Local administration is the direct CLI below, not an HTTP admin API or an npm account command. These are command
forms for an operator to run; `<...>` values are placeholders, not real private paths or credentials:

```text
node server/auth/admin.js --help
node server/auth/admin.js disable --db <existing-auth.sqlite> --username <username>
node server/auth/admin.js enable --db <existing-auth.sqlite> --username <username>
node server/auth/admin.js reset-password --db <existing-auth.sqlite> --username <username>
node server/auth/admin.js backup --db <existing-auth.sqlite> --output <new-backup-file>
```

- `--db` must select an existing, initialized, nonempty regular non-symlink database with supported schema. A typo
  cannot initialize a new database. The CLI loads no environment and opens no listener.
- `reset-password` reads the new password from **non-interactive UTF-8 standard input**, not a terminal prompt,
  argument or environment variable. One final LF/CRLF is removed; input is bounded and times out. Supply it using
  trusted local secret tooling; do not put a password literal in shell history or publish password-bearing output.
- Disable and password reset increment the credential version and revoke account HTTP sessions. Enabling an account
  does not restore old sessions. Fresh checks make online CLI changes visible to sockets on their next validation.
- Backup uses SQLite's consistent online backup, including committed WAL data, and exclusively creates a new output
  file. An existing destination is never overwritten. **Do not copy only a live `auth.sqlite` main file** and call it
  a backup. Keep backups private; plan and verify restore separately. A DB backup never contains resumable matches.

## 4. HTTP boundary, Origin and CSRF

The small `/auth/` shell is a separate public module graph. Its exact static allowlist is `/auth`, `/auth/`, its
`client.js` / `style.css` and four small auth language packs (`en`, `ja`, `ko`, `zh-TW`); it does not expose the game
module graph. Like the main UI, this shell starts in Chinese unless a supported explicit device preference
`sp.pref.lang` is already saved; it does not infer or auto-select a language from `navigator` ([I18N.md](I18N.md)).
Auth APIs are `GET`/`HEAD /auth/status` and `POST /auth/admit`, `/auth/register`, `/auth/login`,
`/auth/logout`. Status provides the current safe projection and CSRF bootstrap; the entry token travels in JSON,
never in a query string.

The default shell shows username/password login without an entry-token prompt. Switching to registration requires
`/auth/admit` followed by `/auth/register`; only registration requires a valid `sp_gate`. `/auth/login` accepts existing
account credentials without that grant, while retaining exact-Origin, CSRF and rate-limit checks. `/auth/status` may
return a valid `account` with `admitted: false`: `admitted` describes registration permission, not login identity.

All auth writes require `Origin === SP_AUTH_ORIGIN`. The `X-CSRF-Token` header must match the `sp_csrf` cookie and the
expected bootstrap/gate/session value; authenticated/gated values are compared through their stored/signed hash.
Cookies are path `/`, `SameSite=Strict`; gate and session are `HttpOnly`; CSRF is browser-readable. HTTPS deployment
adds `Secure`. JSON bodies and password work have bounded sizes, deadlines, rate buckets and concurrency. These
controls complement authentication; an IP bucket is not account identity or Admission accounting.

Without authenticated identity, `/` and `/index.html` redirect to `/auth/`; game code, data, assets, plugin routes and
Studio do not become public static mounts. Anonymous `GET`/`HEAD /healthz` returns only minimal `{ok}` readiness,
not build/room/content/traffic or lease details. Authenticated health retains its existing statistics and separate
traffic address gate; its room/socket statistics must not be mistaken for the Admission ledger.

`privateResponse` makes responses private and varies them by Cookie, preserving relevant cache directives. The auth
shell and APIs use no-store; the shell has a separate strict CSP. Preserve these headers at the proxy. Do not force
shared/public edge caching of authenticated resources, strip cookies, or publish a second ungated assets mount.
Browser-private hashed-asset caching is not permission to bypass the server boundary. The same-origin
`/manifest.json` is protected too: the game document's manifest link uses `crossorigin="use-credentials"` to send
its existing authenticated cookies. Anonymous manifest requests remain 401/no-store; there is no manifest-specific
public exception, Cookie-policy change or CSP relaxation.

## 5. WebSocket authentication and recovery

`/ws` upgrade requires the exact configured Origin and a valid account-session cookie, not a registration grant. Invalid identity
is refused before upgrade (401); an authorization-store failure fails closed (503). Trusted identity is attached
out of band to `Network.handleConnection(ws, req, identity)`, copied into the connection, and never derived from a
frame's account fields.

Authorization is **fresh**, not a cached upgrade decision: adoption, every inbound frame, ping/pong liveness,
heartbeat, actual execution of queued room/game work and asynchronous reply settlement check current validity.
`AuthService.validateIdentity` freshly checks the HTTP session against an enabled account with matching account ID,
credential version and unexpired session. The prepared boolean query does not materialize or parse the password record;
it does not cache authorization, so revocation remains effective on the next validation. Failures/exceptions use `AUTH_REQUIRED` and close code
**4003**. Normal transport closure does not destroy the retained game Session or release its active-seat lease.

Handlers receive the original connection guard as `onMessage(session, msg, {isCurrent})` and
`routeGame(session, msg, {isCurrent})`. Lobby queues retain that captured guard until actual execution; asynchronous
responses use it again. A replaced, revoked or expired connection cannot borrow the later socket's identity or
mutate its Session. Logout revokes the exact `(accountId, tokenHash)` pair through `network.revoke`, including a
socket still awaiting hello, rather than revoking every valid HTTP session of the account.

Authenticated `hello` requires the current fork protocol version **2**; omitted, null and old versions are rejected
before creating or adopting a game Session. Only independently constructed null-auth compatibility components may omit
it. Recovery semantics remain deliberate:

- An explicitly supplied reconnect token must name an unexpired retained game Session owned by the cookie-authenticated
  account. Empty, unknown, expired, foreign or inconsistent explicit recovery returns `INVALID_RECONNECT`, not a new
  guest/Session. Ownership is checked before touching the old holder; another account's token cannot eject it.
- Omitting the token finds only this authenticated account's own retained Session (or creates its one new Session
  after expiry cleanup). Nicknames and IP addresses are never recovery keys.
- A connected holder is replaced only by a dedicated user action sending `takeover:true`. `noReplace:true` always
  forbids replacement, including when takeover is also requested. Explicit takeover may override old `claimAt`;
  ordinary reload/reconnect does not silently take over a live page.
- The normal browser hello sends `noReplace:true`. The separate takeover path sends `takeover:true` with
  `noReplace:false`. `INVALID_RECONNECT` / `SESSION_IN_USE` stop automatic recovery; a rejected token is preserved
  until an explicit action. `SESSION_IN_USE` and `REPLACED` offer takeover, not automatic replacement or navigation.
- Only the explicit `INVALID_RECONNECT` recovery action closes the old transport, confirms an account-scoped
  sessionStorage handoff by writing and reading it back, then stops the old page and replaces the document at `/`.
  A restart can interrupt the lazy simulator module graph; the old document never reconnects first. If the handoff
  cannot be confirmed, the page stays offline with a storage error and preserves the rejected in-memory token.
  Login cookies are not cleared. The handoff is local token-selection/notice state, not an authentication credential.
- The new document revalidates the HTTP account before loading the game graph. A valid handoff suppresses both its
  own old game token and **all** recent-token fallbacks, including saved-seat resume, and sends an ordinary tokenless
  `noReplace:true` hello. It cannot take over another live page. Only a matching validated welcome, after its new
  token is accepted, consumes the handoff and can report the previous Session's reset. An already closed room has
  no second reset notice. The handoff never causes boot/welcome navigation; failure to clear storage cannot create
  an automatic reload loop. Notice consumption is once per document; if every subsequent storage write/delete fails,
  exactly-once consumption across a later manual reload cannot be guaranteed.
- Recovery/takeover uses the existing connection UI position, rendered as a priority `Modal` above ordinary dialogs
  and the guide. Its Tab/focus trap remains active even if a lower-priority dialog opens later; guide and pending
  settings-key capture yield without cancelling their underlying state. Neither Escape nor the backdrop dismisses
  account recovery: the user chooses recovery/takeover or returns to login. Merely displaying recovery does not clear
  the old dialogs. Successful explicit invalid-token handoff destroys their old document; same-document takeover
  retains the existing welcome-based stale-state cleanup. Neither path resumes an in-memory match lost in a restart.
- `welcome.account` is the owning connection's safe projection (`id`, `username`, `name`, `tag`, `local:false`), not
  a roster-wide account directory, password hash or HTTP-session credential. Other players do not inherit its avatar.

The old bearer-token/`claimAt` arbitration remains only in explicitly null-auth component compatibility. In
particular, its unknown-token fallback and same-stamp replacement are not the production account policy.

## 6. One central Admission ledger and permanent departure

The authoritative app instance constructs one synchronous in-memory `Admission`; Lobby owns its lifecycle. Waiting,
login, a lobby seat and a spectator do not reserve a participating-human slot. Immediately before constructing and
starting a match, Lobby takes the **actual participating roster**, maps each real human `playerId` to its trusted
Session `accountId`, validates complete unique bindings, and atomically reserves that roster. A duplicate account
on two human seats is rejected, not deduplicated into one slot. The same account cannot participate in another match.

- **Humans:** at most 16 distinct participating account IDs across arbitrary rooms. This is not room capacity,
  registered-user count, connected sockets or an IP/network count. Full budget is `SERVER_FULL`; an already reserved
  account is `ACCOUNT_BUSY`. Existing per-address abuse/resource limits remain separate.
- **AI seats:** a separate budget of 16 by default (`SP_BOT_LIMIT`), reserved from the actual bot roster. Filling
  human slots does not consume AI allowance and vice versa. Disconnect, elimination or human AI 托管 does not convert
  the human's reservation into an AI seat.
- Preflight work occurs before reservation where applicable. A captured failed start rolls back its own reservation;
  synchronous/returned errors and supported asynchronous failure paths are handled. A hosted start notification is
  not a new startup-ack protocol; later host failure/end cleans that original match context.

A temporary disconnect keeps the retained game Session and its human reservation for the normal **10-minute**
reconnect grace, **including solo**. Authenticated Lobby does not apply the upstream solo `singleReconnectTime`
24-hour extension. Logout/auth rejection is a transport/credential event, not proof of permanent game departure.
Elimination while still retained/observing is not a release either. A match that ends during grace releases its
lease at match end; grace does not keep a finished match reserved.

Permanent quit or expiry is released only after the original match's real `onLeave` completes successfully. The
local Match hook is synchronous (void success is valid); a thenable is not an accepted local lifecycle result. A
hosted MatchProxy sends an ID-bearing request and waits for an acknowledged `{ok:true}` reply. Missing hooks,
throws, returned errors, rejected/timed-out requests or invalid acknowledgements retain the reservation; a posted
notification or `onDisconnect` fallback is not confirmation. A failed departure remains conservatively retained for
retry/resynchronization or later whole-match cleanup.

Lobby's captured match context retains the frozen original roster, account mapping and opaque nonserializable Symbol
lease. Match receives the gameplay seat list, but the trusted account mapping, auth services and Admission lease are
never placed in Match options, plugin APIs or IPC. Releases use the original lease and mapping, not the current
room/match or a new registry lookup. `releaseAccount`, whole-match release and rollback are
idempotent and stale-safe. Normal end, failed start, disposal, destruction and shutdown release the original remaining
humans/AI once; old callbacks cannot release a later match's or account's reservation.

Deploy **one authoritative application instance**. SQLite does not make Admission or game Sessions shared. Do not
use cluster/PM2 multi-instance/replicas behind a load balancer, even with a shared DB or sticky sockets. Plugin match
children are subordinate execution hosts, not independent auth or Admission authorities.

## 7. Account-scoped browser data and Studio

Game boot first verifies `/auth/status`, binds its server account, then dynamically imports preference-owning game
modules. Missing/changed identity suspends work; switching accounts requires a new document so old module caches
cannot become another account's state. Logout suspends transport/pending work before the write; an unconfirmed
logout is displayed as unconfirmed, not simulated by clearing a local profile.

Avatar, operator loadout/ownership/DIY, skins, statistics/history, personal plugin storage and browser script consent
are scoped to the verified account **in that browser**. Preferences use `sp.account.<id>.pref.*`; game recovery uses
`sp.account.<id>.identity.*`; avatar uses its account key. A null scope does not read/write an unscoped guest fallback.
Old guest data is not automatically claimed by nickname, account creation or first login. Language, screen-fit and
hub-backdrop remain device conveniences. Browser consent is account-scoped in addition to the current room-seat/
content-hash consent gate; detailed plugin contracts remain in [PLUGINS.md](PLUGINS.md).

This is not cloud synchronization, a cross-device avatar/profile service or server match records/achievements.
Origin changes also separate browser storage. Preserving the server account DB cannot restore erased local history.

Local history persistence re-reads the verified account's current envelope before every write attempt, including
quota retries. A newer version or failed storage read refuses stale import, confirmed clear and recorder writes;
this is not an atomic cross-tab transaction. An unreadable value is backed up under that account's `.damaged` key.
If no current envelope exists, subsequent reads retain the backup notice even after the lobby's achievements read
first. A successful current-history save ends the notice without deleting the backup. No other account or guest
namespace is consulted. The lobby account panel's 统计数据 button opens this browser-local history.
Native trusted plugins still execute with their documented process/filesystem powers: removing private auth/state
environment variables through `childEnvironment` is not a filesystem or process-capability sandbox.

Production Studio is **off by default**. Explicit `SP_STUDIO=lan`, `local` or `loopback` (or the internal
`studio:true` option) enables its original gates, not public authoring. Peer and all recognized forwarded addresses
must pass the private/loopback policy; `local`/`loopback` narrows it; Host must be local or allowed by
`SP_STUDIO_HOSTS`. Writes still need the owner key (`X-SP-Studio`) and original Origin/site checks. Extra Host entries,
proxy trust and game-account login cannot grant owner authorization or bypass the address gate.

## 8. Current limits and verification status

`shared/constants.js` defines **`DEFAULT_SEATS = 4`**, **`MAX_SEATS = 16`**, **`ROOM_CAPACITIES = [4, 8, 16]`**,
**`MAX_SPECTATORS = 2`** and **`PROTOCOL_VERSION = 2`**. Co-op creation and host-only pre-match resizing accept only
those capacity tiers. Shrinking refuses any occupied higher seat, including a disconnected human's retained seat;
it never moves or evicts players. Solo keeps its original one-human/no-AI behavior (internal capacity 4).

An actual occupied roster of 1..capacity may start after the existing ready/content/consent gates, without filling
empty seats or adding AI. Only actual humans consume the central 16-account ledger; two capacity16 rooms with eight
humans each do not reserve 32 places. Capacity controls require the connected server's `welcome.roomCapacity`
capability, not a client-only protocol guess.

The frozen runtime context is `{version:1, capacity, participantCount, personalPools}`. `participantCount` includes
actual humans and explicitly added AI, excluding empty/spectator seats; `personalPools` selects N>4 at start and does
not change on elimination/departure. Local Match, host creation/IPC, public reconnect state and test trace/replay
preserve and validate this metadata independently of content hashes/plugin rules. **Personal ordinary operator and
equipment inventories are now implemented as a P3 slice:** each N>4 player owns the original co-op-sized stock,
with scoped rolls, gains, debt repayment, elimination, opening rerolls and invariant checks; N≤4 retains shared stock.
**Personal SP choices and repeated-strategy sources are now implemented locally:** private original-sized decks,
instance/revision claims, stock-aware refill, one effect per holder and independent same-position medical devices.
Boss HP uses actual alive participants; unite progress accepts 15 real sources, and oversized accounting explicitly
requests a bounded server takeover rather than dropping ledger entries. Browser-local records retain 16 rows;
an explicit selfId with no matching row stays unknown and earns no teammate statistics. Opening/settlement layouts
retain high sparse seats and expanded lists scroll. These changes are not full >4-player gameplay acceptance.
See [META.md](META.md), [design/network.md](design/network.md) and [design/client.md](design/client.md).
Auth-aware single-instance Compose, file secrets, read-only pinned assets and local draining control are now
implemented; see [COMPOSE.md](COMPOSE.md). Actual container build/cold start, HTTPS/WS and restoration remain
unverified. Existing upstream installers and packaging examples are not evidence of production acceptance.

Inventory-slice verification on **2026-10-21**: stock/DIY/opening-reroll targeted tests passed **36/36**;
documentation consistency/path checks passed **32/32**; ESLint on the 18 touched source/test files reported zero
errors and two existing warnings. No full CI, browser matrix, personal-SP/repeated-strategy acceptance or production
deployment was run for this slice. Earlier failures below are not reclassified by these passes.

Further local implementation verification on **2026-10-21**, in separate targeted runs: personal-SP-related tests
**55/55**; repeated-band tests **73/73**; client statistics/opening/settlement tests **74/74**. Battle-accounting tests
ended at **56/57**, with the remaining new runner fixture then corrected and its selected case passing **1/1**;
the combined 57 cases were not rerun afterwards. Targeted ESLint reported no errors (existing warnings remain in
the match/report files). Exact scope and limitations are indexed in the root AGENTS.md memory entries. No real
16-human/mobile rendered acceptance, full CI, 4c4g measurement or Compose deployment is claimed by these runs.

P6 local verification on **2026-10-21**: deployment/static-route tests **7/7**, Python archive-security fixtures
**5/5**, scoped ESLint zero errors and two existing Lobby warnings. Fixed release range inspection verified the
archive directory/whitelist and top-level references, not the full downloaded hash or complete nested closure.
Docker is absent on this workstation; the new Linux CI job has not run. No container acceptance is inferred.

Earlier verification recorded on **2026-10-20** (separate targeted runs, not one passing full-CI run):

| Scope | Recorded result and boundary |
|---|---|
| Foundational `passwords`, `store`, `service`, `admin`, `config`, `admission` suites | Historical **86/86**; not a substitute for later integration |
| `test/auth/*.test.js` + identity handshake/session + WS compression | Joint run **258/258**, no skips, covering foundational auth, HTTP/WS, ongoing freshness, scoped frames, recovery and inflated-frame limits; not browser evidence |
| `http-integration.test.js` | **6/6** through real HTTP/WS, including fail-closed routes, cookies, ownership/takeover/logout, Admission, restart and cleanup |
| `lobby.test.js` | **75/75**, no skips; authenticated integration plus explicitly null-auth compatibility component cases |
| Seven Match integration files / seven additional Lobby files | **48/48** / **49/49**; real bounded account actors and original worker/plugin assertions retained |
| `client-identity-session.test.js`, `asset-index.test.js`, `traffic.test.js` | **3/3**, **15/15**, **4/4**, respectively; actual HTTP/WS, not browser UI evidence |
| Five Studio test files, most recent per-file runs | **42 pass / 2 fail / 2 existing skips** out of 46. Both failures require file symlinks that return Windows `EPERM`; they were not replaced with directory junctions or skipped. The Studio Forge standalone run is **4/4** after its directory-view portability fix |
| Forge import fixture isolation | One exact-name, serial TAP run: **9 pass / 1 fail / 0 skipped / 0 cancelled**, 16.812 s, exit **1**. All nine selected existing fixture/bait cases pass, including the original malicious-directory refusal and target-preservation checks. A separate genuine file-symlink case fails at `fs.symlinkSync(..., 'file')` with Windows `EPERM`, before importer refusal or unchanged-target assertions; no fallback, skip, elevation or retry. Six syntax checks, named lint and scoped whitespace checks exit 0 (two existing lint warnings). Static checks find no fixed external bait literal in those six files, whose before/after hashes match. Not the entire Forge suite, a native-copy repair or full regression |
| `client-static.test.js` | **655/655**; static source/CSS checks, not an interactive browser result |
| `i18n-packs.test.js` + `i18n.test.js` | **24/24**; strict four-pack check **2410/2410** used messages each, zero missing/errors |
| `ci.test.js` + `doctor.test.js` | **21/21**, no skips; strict authenticated full-health checks and negative unauthenticated/redirect/minimal-health cases |
| `node tools/ci.mjs --only smoke` | Exit **0**: real CLI on owned loopback state, real HTTP admission/registration/login, authenticated full health, byte-exact game index/vendor and strict stdin-auth doctor; not browser or deployment evidence |
| `npm run lint` from the repository cwd | Exit **0**, **0 errors / 163 warnings**; an earlier invocation from the parent cwd incorrectly scanned ignored vendor files and failed, so only the corrected repository invocation is the full-tree lint result |
| TypeScript `--noEmit --checkJs -p jsconfig.json` | Latest separate run exits **0**; does not certify every later edit or full CI |
| `node tools/golden.mjs --jobs 2` | Exit **0**, all **288** scenarios match (49 roster / 46 bonds / 22 fields / 21 matches / 10 standins / 140 diy); comparison only, no fixture update |
| `node tools/check-imports.mjs --strict` | Exit **1** for the existing `server/sim/nodeData.js` imports of `node:fs`, `node:path`, `node:url`; unchanged from HEAD and explicitly pinned by `test/check-imports.test.js`. Default mode exits 0 while reporting the same three violations; strict is not passing |
| Fixed `TEST_FILES` non-browser regression (Node 24.14.1 / Windows) | Exit **1**: **8742 tests**, **615 suites**, **8660 pass / 34 fail / 48 skipped / 0 cancelled / 0 todo**, 590734.1883 ms. Four browser flags were explicitly 0; skipped browser suites are not interaction evidence |
| Eleven scoped-client/UI/font/documentation files after targeted repairs | Exit **0**: **158 tests, 155 pass / 0 fail / 3 existing conditional skips**. Account-scoped fixtures, deferred game-graph checks, build-guard lifecycle, current loadout/report contracts, registry-backed report icons and readable font-size/shorthand gates remain enabled; this is not browser validation or a new full regression. Targeted syntax/lint checks exit 0; lint retains one existing unused-assignment warning in `sweep.js` |
| `docs-consistency.test.js` + `docs-paths.test.js`; `check-imports.test.js` | Recorded **32/32** documentation checks plus **4/4** import-checker/baseline tests, **36/36** jointly, no skips; the latter explicitly verifies the strict CLI's expected exit 1, not a strict boundary pass or certification of later edits |
| `pwa-install-023.test.js` and actual browser manifest request | **5/5** static/behavioral contracts; separate real-account title/lobby interaction observes the browser's own same-origin manifest GET **200**, after registration. Anonymous manifest GET remains **401/no-store**. That run still reports the old helper's two pre-session favicon diagnostics and is not an all-diagnostics pass |
| Shared Client diagnostics + owned browser-pipe cleanup contracts | Latest joint run **59/59**, no failures/skips/cancellations, after a URL-path redaction repair. Syntax, named JS lint and whitespace checks exit 0; `client.mjs` has syntax coverage, not lint coverage from the current JS-only test config. Separate real-account title/lobby interaction before that path-only repair retains all three proved pre-session favicon entries, **0 unexpected** entries and the original mutable `problems` array, with owned-browser exit/loopback closure confirmed; not a full-match or recovery result |
| Natural two-human complete-match browser lifecycle | One selected `coop-full` case passes, **1 pass / 0 fail / 0 cancelled / 4 unselected skips**, 200.891 s; two independent durable synthetic accounts, round 1, actual UI buying/deployment, natural elimination after passing round 9 (PREP 1–10), both personal/team reports and return to the same original room. Both clients have zero unexpected diagnostics; owned browser exits and loopback closure are confirmed. Only combat is accelerated (24×), with normal preparation/draft timers, no bots, round jump, starter kit or forced finish. Original outer collection still records `acceptance: false`: it parsed TAP `#` summaries but Node emitted spec `ℹ` summaries. A separate offline reconciliation verifies the successful Node exit, exact selected-case counts, reports/return and recorded cleanup without rerunning or changing original evidence. Not victory, Boss/Hidden Core, restart/recovery, all 1–4 players or rendered-pixel acceptance |
| Same-account two-tab explicit takeover | Selected real-browser case **1/1**, no failures/skips/cancellations, 10.172 s. Ordinary second-tab hello is refused; real mouse takeover and keyboard takeover back retain the same account, game Session, host and exact waiting-room seat. Both pages retain zero unexpected diagnostics; the single owned browser exits normally and the owned port closes. The first attempt failed on an actual authenticated favicon 404 caused by the test's JSON-document landing page; the test now navigates directly to the game and verifies account status in that document, without waiving 404s. Not active-match takeover or complete recovery coverage |
| Active same-account takeover, ordinary reconnect and natural solo settlement | Selected real-browser case **1/1**, no failures/skips/cancellations, 191.671 s. Starting at round 1 with one durable synthetic human account, actual UI purchases/deployments and no bots, round jump, starter kit or forced finish, the paused normal battle survives explicit mouse takeover and keyboard takeover back with the same account, player, room, seat, battle and field. Real server `b.start` messages retain client authority for both takeovers; actual socket closure then reconnects without takeover, preserving the battle while removing local authority and resuming simulation. The match naturally ends in defeat at round 9 after eight rounds passed (PREP 1–9, nine purchases, eight deployments); personal/team reports identify the same human, and return reaches the exact original room/seat. Both pages retain zero unexpected diagnostics; the single owned browser exits 0 and the owned loopback port closes. Only combat is accelerated (8×), with normal phase timers. The first attempt remains **0/1**: it reached reconnect but incorrectly required an info log from the test server's quiet logger; real protocol/runner assertions replace that log dependency, not production behavior or diagnostics. Syntax, selected JS lint and whitespace checks exit 0. Not victory/Hidden Core, all 1–4 players, strict restart recovery, reliable rendered-pixel, full-regression, P1 or deployment acceptance |
| Account-local history persistence contracts | Latest complete `stats.test.js` run **56/56**, no failures/skips/cancellations; selected syntax, JS lint and whitespace checks exit 0. Before the fixes, two exact regressions fail on stale newer-history overwrites/unreadable storage, and one later regression fails when a lobby read consumes the damaged-history notice. Every actual write now re-reads the current account envelope, including quota retries, and refuses newer versions or unreadable storage; later reads retain the account-local backup notice until a current envelope is saved. Synchronous version protection, not atomic cross-tab compare-and-swap or cloud history |
| Authenticated browser-local history data actions | Two exact selected real-browser cases **2/2**, no failures/skips/cancellations, 56.750 s without outer timeout. Actual export/import, deduplication, corrupt/newer-file refusal, new-record merge, stale import and confirmed-clear refusal, cancel/confirm clear, damaged-backup notice and newer-storage protection pass via the lobby account panel. Three fresh synthetic-account clients/browsers retain zero unexpected diagnostics; all owned browsers exit 0 and the owned loopback port closes. The first run remains **0/2**: the test directly removed Preact-managed toast nodes, hiding a repeated merged toast; independently, the lobby's earlier history read exposed the real missing-backup-notice defect. Tests now dismiss toasts by real clicks; persistence is repaired without new diagnostic exemptions or timeout increases. Five screenshot checkpoints are recorded, not reliable rendered-pixel acceptance. Not the entire statistics browser suite, same-browser A/B account switching, concurrent-tab transactions, P1 or deployment acceptance |
| Test-only child shutdown control | **6/6**, no failures/skips/cancellations, with syntax, named JS lint and whitespace checks passing. Real synthetic children confirm Windows native `child.kill('SIGTERM')` bypasses the JavaScript handler; private parent-child IPC invokes the child's existing handler and requires confirmed exit. POSIX retains native SIGTERM, but actual POSIX delivery was not run on this Windows host. The first run remains **4 pass / 2 fail**, caused by asserting the message event's entire argument array instead of its message argument |
| Actual process restart and explicit browser recovery, original functional run | Historical selected case **1/1**, no failures/skips/cancellations, 24.734 s, with owned-browser exit and owned-port closure confirmed. Hard crash and normal shutdown-handler restart both preserve the durable HTTP account; recovery is explicit, clears the stale match/dialog only after a new welcome, and returns to the lobby. The normal path also verifies the maintenance notice and absence of a duplicate reset notice. This is a **functional pass, not a strict-diagnostics pass**: that version's broad `net::ERR_` filter masked image failures and a refused `/shared/plugins/textPatterns.js` request retained in the raw ledger. That filter has since been removed; this historical result does not prove later local combat works |
| Strict restart diagnostic contracts | **96/96** jointly for the exact owned-socket classifier and shared browser diagnostic observer, with syntax/named JS lint/whitespace checks passing. Recorded restart windows must be complete, successful and nonoverlapping; only a uniquely matched exact owned WebSocket-refusal log/console pair inside its window is expected. Resource/module failures, HTTP errors, CSP and page exceptions remain unexpected. Failed-resource CDP request/response/loading-failure metadata is redacted; no headers/bodies are captured. Pure/fake-observer contracts, not a browser recovery pass |
| Restart followed by actual local combat, before the recovery repair | Selected real-browser case **0/1**, 39.047 s, no outer timeout; both explicit recoveries reach the lobby and the next real solo run reaches server phase `COMBAT`, but the own local Battle does not advance within the unchanged 15 s bound. The raw ledger includes `[runner] simulation unavailable` / failed dynamic `/sim/spec.js` import and refused sim/shared dependencies interrupted by restart. The final strict diagnostic assertion is not reached, not passed. Owned-browser exit and owned-port closure are confirmed; this is a real post-recovery failure, not merely diagnostic noise |
| Explicit fresh-document recovery contracts | Account/lifecycle/controlled server-handshake contracts **31/31**, selected existing net/identity/recovery contracts **48/48**, no failures/skips/cancellations. Five syntax checks, named JS lint, strict i18n and named whitespace checks exit 0. Synthetic contracts, not browser interaction or a new full regression |
| Restart followed by actual local combat, after the fresh-document repair | Selected real-browser case still **0/1**, 26.078 s, no outer timeout. Both explicit actions now replace the document, revalidate the same durable HTTP account and return to the lobby; the graceful path observes maintenance without a duplicate reset notice. The next actual solo game reaches `COMBAT` and the own local `Battle.time > 0` assertion passes within the unchanged 15 s bound, producing the fourth combat checkpoint. The same CDP session retains the entire earlier ledger. The final strict diagnostic assertion is reached and **fails: 228 unexpected entries** (235 total, 4 exact restart-socket entries classified expected); no broad resource exception is added. This is verified functional recovery, **not** an overall browser/diagnostic pass. Offline analysis groups the 228 entries into 76 failed requests, each recorded by request failure, console and browser log; all recorded timestamps fall inside the two restart windows (105 hard / 123 graceful), with none outside. Those are Node receipt timestamps, not document identities: absent navigation epochs/loader IDs, old-versus-recovered-document attribution and complete final-document resource coverage remain unproved. The entries alone do not establish a post-recovery failure or justify another production repair, broad exemptions or clearing the ledger. Owned-browser exit and owned-port closure are confirmed; screenshots are not reliable rendered-pixel acceptance |

The full regression's 34 failures comprise seven file-process native exits (`0xC0000409`, cause not established;
coverage in those files is incomplete), nine Windows `symlinkSync` `EPERM` failures (including the two Studio cases
above), three tracked-only packaging-plan failures on new untracked dependencies, two sandbox setup timeouts,
two performance-threshold failures, one real-time battle/report mismatch and ten client/mock/source-contract
failures. No permission elevation, additional skips, directory-junction substitutes for file links, timeout/threshold
relaxation or source changes were used in that read-only run. Targeted fixes and reruns must be recorded separately;
passing subsets do not erase this failed run.

An isolated sanitized-environment, per-file serial diagnostic still reproduces all seven native process exits with
`0xC0000409` and no nonempty stderr/native stack. They are file-level failures, not seven located JavaScript
assertions; only two named CSP checks completed before that file failed. Subsequent exact-name CSP runs separately
pass the Worker-response case (**1/1**) and Pixi no-eval case (**1/1**), while the UI-frame case alone still exits
natively (`0xC0000409`, empty stderr, no named assertion result). A separate single staged counterpart then records
successful imports, temporary-directory creation and cleanup registration, followed by `template.cpSync.begin` and
another native exit before `template.cpSync.complete`. Registry, policy, request and assertion stages are not reached
in that trace; fixture cleanup is not confirmed. This bounds that reproduction to the copy-call window, not a native
root cause or a repair of the other six files. Those six also contain recursive `fs.cpSync` calls, but their actual
failing stages remain unobserved. A later one-shot minimal script imports only `node:fs`, `node:path` and `node:os`,
uses the same Node 24.14.1, cwd, temporary prefix and original recursive copy call, and again exits `0xC0000409`
between `copy.begin` and `copy.complete` (0.375 s; no timeout or JavaScript exception). It loads no test runner,
registry, HTTP, authentication or page modules. Copy completion and cleanup are unconfirmed; its newly owned
fixture is retained, with no scan or cleanup of older temporary directories. This narrows dependencies, not the
native cause, and does not establish the failing stage of the other six files. A later inert, self-created two-file
synthetic tree also exits `0xC0000409` during a single D-drive-source to C-drive-temp recursive copy (0.421 s),
without loading the original template or application graph. The separately scheduled same-C-drive-root counterpart
returns normally (0.187 s), with copy, owned-root cleanup and normal-exit markers confirmed. Neither run times out.
This supports investigating path-placement conditions, not a proven cross-volume cause or Node defect: source path,
volume and directory layout differ, and no native exception record, faulting module or stack has been captured.
Native-failure fixtures remain retained and unscanned; the successful counterpart cleans only its new root. Four
named SOURCE/template path components independently show no directory link/reparse point, not a recursive audit of
all ancestors or descendants. No retry, Node substitution or copy implementation change repairs the original seven
file-level failures. The two sandbox-timeout files and the real-time report file exit 0 in the separate serial
diagnostic, without relaxed limits; their original failures and unresolved cause remain recorded.

A later sequential performance-only run, with browser flags 0 and no inherited `CI`, retains the original local
**0.5 ms/tick** assertions: both `perf.test.js` cases pass (**2/2**; 54.2 and 95.5 microseconds/tick), and the exact heavy
boss case passes (**1/1**; 205.8 / 160.3 / 154.0 microseconds/tick, best 154.0). This does not erase the two full-run
performance failures, identify their cause, or measure the target 4-core/4-GB server.

Static classification of the nine Windows link-failure entry points identifies four directory fixtures and five
file-link fixtures, with further link calls hidden behind the first failure in some tests. Directory fixtures now use
the existing Windows `junction` / other-platform `dir` convention; Forge's escape target is a newly created, owned
sibling directory rather than the uncontrolled `/tmp` path. Original refusal/rename/target-preservation assertions
remain. Four syntax checks, repository-cwd lint and diff checking exit 0 (lint retains two existing Forge warnings).
Three subsequent exact-name runs each pass **1/1, no skips**: installer refusal/rename/target preservation, the generated
script harness, and presentation candidate refusal/clone fallback/cleanup. A later Forge fixture-isolation run
passes its original compound malicious-input case among nine selected existing passes; the separate genuine file-link
case still fails at Windows `EPERM` before its refusal assertions. These are not all nine original failures passing.
File-link fixtures still require actual file symlinks: no junction, hard-link/copy/mock substitute, permission change
or new skip is used. Forge's poison sources remain unarmed; only an allowlisted disposable fixture copy receives its
newly owned case-local bait path as a generated string literal. The old fixed external bait path is never inspected
or removed. This safety change is not evidence that the unresolved native recursive-copy failures are repaired.

Packaging's three full-regression failures arise from tracked callers importing new untracked dependencies:
`allowDirty` does not add untracked files, and the existing runtime shipping allowlist already covers their paths.
A separate isolated **explicit `opts.paths` candidate** uses 1991 tracked paths plus exactly 31 named new runtime
paths. Its lite-plan API command exits **0**, with 970 selected source files plus one virtual `packs/index.json`,
`problems: []`; all seven auth-shell resources, the admin CLI and `cloudStats` dependencies are selected. This is not
default `trackedFiles`, a clean checkout, an installed/built package or the original three tests passing. The source
index is unchanged. A separate conservative selected-source closure scan exits **1** for the script template's
relative harness import at its original `_template` location; that template only executes after installation under
`plugins/<id>/`, where its relative harness path has a different base. No template or checker was changed to hide
the scan result. The isolated full plan intentionally has no art and reports 16713 missing-art entries plus the
no-art summary, not a full-package success. `docs/AUTH.md` remains excluded by the current player-doc allowlist.

The first complete authenticated Modal run recorded **5 pass / 3 fail / 0 skip**: one diagnostic clock-association
failure and two cases with real CSP-rejected external font requests. The default page's remote font dependency has
been removed, and diagnostics use same-CDP request wall time. The subsequent fresh complete Modal browser run passes
**8/8, no skips**. All 24 diagnostic entries are eight uniquely correlated pre-session favicon-401 triplets; there
are **0 unexpected** warnings/errors, page/request failures or HTTP errors. The owned browser exits and the owned
loopback port refuses connections after stop. Its coordinating agent later failed with an API/context error, but
the independent runner, full TAP and cleanup evidence had already completed successfully; no successful test was
rerun to replace that agent report. This suite covers Modal/guide/settings focus and interaction, not complete-match
or actual restart/recovery UI acceptance. Three screenshots were read as image payloads, but rendered pixels could
not be reliably inspected through the current tool; visual layering/legibility/clipping acceptance remains open.

The shared `Client` now installs diagnostics before authentication, retains a redacted raw ledger, and defers only
its initial classification. Only a uniquely correlated same-CDP-session, main-frame status-document favicon
GET/401 before the successful registration/login boundary can be marked expected; missing/duplicate/redirected or
late evidence fails closed. HTTP/response/network-log correlation uses the request ID and CDP occurrence clocks;
console messages have no network request ID and additionally require exact resource/text, no script arguments and
one unambiguous nearby network log. Manifest failures, other HTTP errors, CSP, page errors and request failures are
not covered by that exception. The pre-existing media-source-swap abort exception remains separate and visible in
the raw ledger. URL paths are redacted as well as URLs/text. Snapshots are copies; consumers keep their original
mutable `problems` array and its splice/alias behavior. A stopped auxiliary experiment lacking ownership/shutdown
evidence is excluded from the recorded verification results; stopped agents alone do not prove child cleanup.

Readable lobby font sizes/shorthands now use the shared text root without the achievement panel's local override,
with pixel floors/layout geometry and existing exclusions retained. The real-account text-scale suite has been
migrated to three scenarios: all four phone settings steps with same-account reload, real solo-standard PREP geometry,
and phone/desktop hub/achievement inheritance and reachability. Syntax/lint/diff checks pass and the static text gate
is **13/13, no skips**. Its first real browser run records **1 pass / 2 fail / 0 skip**: the four-step settings and
same-account reload case passes; real PREP field/canvas/shopbar geometry remains equal, but two actual worker CSP
errors reject a `data:image/png` fetch; the new hub case stops on a missing `.hub-recruit__en` sample before desktop
coverage/readability acceptance. No CSP origin or error exemption was added to hide these failures. The suite's
teardown completes without a hook failure, including owned-browser exit and loopback closure assertions. This is
not a complete text-scale or screenshot pass. Read-only dependency tracing identifies the exact data PNG as Pixi
7.4.2's optional `createImageBitmap` worker probe, not an authentication or game-asset request. Pixi setup now calls
its supported `Assets.setPreferences({ preferWorkers: false })` in both setup branches, selecting the normal image
loader without broadening `connect-src 'self'` or suppressing errors. Shader adaptation and image-bitmap decoding
remain. Its four-case setup contract passes **4/4, no skips** (mock DOM/Pixi, not GPU coverage). After a narrowly
schema-aware recruit assertion fix, the second real browser run records **2 pass / 1 fail / 0 skip**: all four
settings steps/same-account reload and real PREP geometry pass, and all three cases have three expected pre-session
favicon diagnostics with **0 unexpected** entries. The former Pixi worker CSP error is absent without changing the
strict diagnostic gate. Current `room.list` capability is absent, so recruit DOM/text/sample absence is explicitly
required; enabled-protocol coverage remains. Phone/desktop sm/xl measurements finish, but the conservative DOM
Range font/line-box sibling gate fails (phone-sm title 4.40625 px, mode 1.375 px and maxima 2 px overlaps). These
are not measured painted-ink overlaps. Phone-xl top also records actual 12 px horizontal overflow, bottom 0.
The achievement header, mode rows/cells and maxima now keep minimum rather than fixed internal heights, with
normal wrapping and spaced line boxes inside the unchanged outer panel. A dedicated hex-label entry animation
retains percentage centring; source geometry closely matches the transient 12 px shift, but the old run did not
record per-node animation timing. Browser readiness now includes those finite label animations. These latest
CSS/readiness edits subsequently pass the complete three-scenario real browser suite: **3/3, no failures/skips or
cancellations**, 30.781 s, no timeout. All nine diagnostic entries are narrowly correlated expected pre-session
favicon triplets, with zero unexpected entries; teardown confirms owned-browser exit and loopback closure. Phone
844×390 and desktop 1920×1080 sm/xl retain layout roots 40/100 and achievement outer boxes 696×354/1740×906;
sampled top/bottom clipping, sibling Range overlap and horizontal overflow are within the unchanged 1 px gate
(phone-xl top overflow is now 0). Real wheel scrolling reaches all three section headings and the final record
content, and controls remain reachable. The static text gate including the new growth/animation contracts passes
**15/15**, and separate current docs/import-baseline checks pass **36/36**. This is narrow automated DOM/interaction
coverage, not complete texture/Spine/GPU coverage, painted-ink measurement, every viewport or pixel-level visual
acceptance; the screenshots still lack reliable rendered-pixel inspection. Do not present static checks, skipped
browser suites, a launched service or older upstream/STAGE screenshots as current SOURCE interaction evidence.
The first restart-browser attempt failed waiting 15 s for the maintenance notice. The Windows helper had used native
`child.kill('SIGTERM')`, which exited the child without running its registered JavaScript handler. The correction is
confined to test process control: a private IPC channel accepts one fixed shutdown action, without an HTTP/TCP
endpoint or arbitrary-code interface, and invokes the child's existing SIGTERM handler. Confirmed normal exit,
no forced fallback, handler acknowledgement and the real boot shutdown marker are asserted. Production auth,
Lobby notification and shutdown ordering are unchanged. The successful Windows handler path is not evidence of
Linux OS-signal delivery, container shutdown or Compose acceptance. Original failed attempts and raw browser errors
remain recorded; the functional runner's `acceptance: true` does not establish strict network/resource acceptance.

Separate lint/type/golden/smoke results are not one passing integrated CI run, and the known import baseline must
not be hidden by weakening the checker. Broader original 1–4-player and multi-human active-match coverage,
same-browser A-logout/A-login/B-login/A-return account isolation, strict restart diagnostics/document attribution and
complete post-recovery resource coverage, actual 16-human room combinations, 4/8/16 capacity/personal-pool gameplay,
Compose cold start, and 4-core/4-GB/traffic measurements remain open. The selected natural two-human and active-solo
lifecycles, waiting-room takeover, local-history data actions and functional restart paths above, including the
now-advancing post-recovery local Battle, do not complete P1 or those remaining gates. The results above are neither
a deployment result nor a security certification.

### 2026-10-21 交付前账号切换补查

旧用例等待 `.lo .lo-card` 超时，实际调配页默认展示卡片，行选择器仅存在于列表视图。
本地用例改为通过筛选菜单切换列表后，同一浏览器的 A 注册、昵称/头像/调配及本机历史、A 注销重登录、
B 注册与隔离、再返回 A 的完整路径 1/1 通过。只修正了测试操作，业务代码未加兜底。
该历史为导入合成记录，非本次完成的对局；不覆盖非默认皮肤、云记录、十六真人或部署。
测试修改按用户要求留在工作区，不纳入提交；诊断来源及操作入口见 `.context/pitfalls/loadout-deck-selector.md`。
