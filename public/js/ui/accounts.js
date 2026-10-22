// Server authentication is separate from the game's reconnect token. Only the avatar is local.
// This small pre-boot graph must not import loadout/skins/content stores before account scope is bound.
import { html, AvatarFrame, MicroLabel, Icon, Modal, Button } from './components.js';
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { render } from '../../vendor/preact.module.js';
import { store } from '../store.js';
import { t } from '../../../shared/i18n.js';

export const LOCAL_ACCOUNT = false;
const ACCOUNT_ID = /^a_[0-9a-f]{32}$/;
const AVATAR_MAX = 160_000;
const listeners = new Set();
let account = null;
let documentAccountId = null;
let avatar = null;
let loaded = false;
let csrf = null;
let refreshPending = null;
let logoutPending = null;
let suspended = false;
let lifecycle = { stop: () => {}, navigate: (path) => globalThis.location?.replace(path) };

/** Dependency injection avoids accounts <-> net/store lifecycle cycles. stop must synchronously close and clear pending. */
export function configureAccountLifecycle(hooks = {}) {
  if (typeof hooks.stop === 'function') lifecycle.stop = hooks.stop;
  if (typeof hooks.navigate === 'function') lifecycle.navigate = hooks.navigate;
}
const avatarKey = (id) => `sp.account.${id}.avatar`;
const validAvatar = (value) => typeof value === 'string' && value.length <= AVATAR_MAX && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value);
function readAvatar(id) {
  try { const raw = globalThis.localStorage?.getItem(avatarKey(id)); return validAvatar(raw) ? raw : null; } catch { return null; }
}
function writeAvatar(value) {
  if (!account || suspended) return;
  avatar = validAvatar(value) ? value : null;
  try {
    if (avatar) globalThis.localStorage?.setItem(avatarKey(account.id), avatar);
    else globalThis.localStorage?.removeItem(avatarKey(account.id));
  } catch { /* kept for this page only */ }
  emit();
}
function emit() { for (const fn of [...listeners]) { try { fn(); } catch { /* isolated listener */ } } }
export function normalizeAccount(value) {
  if (!value || typeof value.id !== 'string' || !ACCOUNT_ID.test(value.id) || typeof value.username !== 'string' || typeof value.name !== 'string') return null;
  return { id: value.id, accountId: value.id, username: value.username, name: value.name,
    tag: value.id.slice(-6), local: false, card: null };
}
export function currentAccount() { return account && !suspended ? { ...account, avatar } : null; }
/** Clear only this document's projection; this does not claim that server cookies were revoked. */
export function suspendAccount() { suspended = true; account = null; avatar = null; loaded = true; emit(); }
export function onAccountChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function timeoutSignal(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; }
async function authFetch(path, options, readBody = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(path, { ...options, signal: controller.signal });
    return readBody ? { response, body: await response.json() } : response;
  } finally { clearTimeout(timer); }
}

/** 从服务端验证账号并更新页面身份；注册凭证不参与登录身份判断，失败不得降级为游客。 */
export async function refreshAccount() {
  if (suspended) return null;
  if (refreshPending) return refreshPending;
  refreshPending = (async () => {
    const { response, body } = await authFetch('/auth/status', { credentials: 'same-origin', cache: 'no-store', mode: 'same-origin', redirect: 'error',
      headers: { Accept: 'application/json' } }, true);
    if (!response.ok) throw new Error(t('账号验证失败，请重新加载页面'));
    csrf = typeof body.csrf === 'string' && /^[0-9a-f]{64}$/.test(body.csrf) ? body.csrf : null;
    const next = normalizeAccount(body.account);
    if (!csrf || (body.account && !next)) throw new Error(t('账号验证失败，请重新加载页面'));
    if (suspended) return null;
    // Module caches belong to one verified account for the whole document lifetime.
    if (documentAccountId && next?.id !== documentAccountId) {
      suspended = true; account = null; avatar = null; loaded = true;
      lifecycle.stop(); emit(); lifecycle.navigate(next ? '/' : '/auth');
      return null;
    }
    account = next;
    if (next) documentAccountId = next.id;
    avatar = next ? readAvatar(next.id) : null;
    loaded = true; emit();
    return currentAccount();
  })();
  try { return await refreshPending; } finally { refreshPending = null; }
}

/** A failed logout stays suspended: cookie revocation is never faked by clearing local data. */
export async function logoutAccount() {
  if (logoutPending) return logoutPending;
  suspended = true;
  lifecycle.stop(); // close transport + reject pending + unbind page state BEFORE the write
  account = null; avatar = null; loaded = true; emit();
  logoutPending = (async () => {
    if (!csrf) throw new Error(t('注销未确认，请重新验证账号；不要将本页视为已登出'));
    const response = await authFetch('/auth/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store', mode: 'same-origin', redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: '{}' });
    if (response.ok || response.status === 401) { csrf = null; lifecycle.navigate('/auth'); return; }
    throw new Error(t('注销未确认，请重新验证账号；不要将本页视为已登出'));
  })();
  try { return await logoutPending; } finally { logoutPending = null; }
}

export function useCurrentAccount() {
  const [state, setState] = useState(() => ({ me: currentAccount(), loaded }));
  useEffect(() => { const update = () => setState({ me: currentAccount(), loaded });
    listeners.add(update); update(); return () => listeners.delete(update); }, []);
  return state;
}
const isMe = (playerId) => !!playerId && playerId === store.get().me?.playerId;
/** Other players never inherit this device's avatar. Remote profiles are not implemented. */
export function accountOf(playerId) { return isMe(playerId) ? currentAccount() : null; }
export function useAccount(playerId) { const { me } = useCurrentAccount(); return isMe(playerId) ? me : null; }
export function AccountTag({ playerId }) {
  const info = useAccount(playerId);
  return info ? html`<span class="acct-tag" title=${t('服务器账号 {name}#{tag}', { name: info.name, tag: info.tag })}>#${info.tag}</span>` : null;
}
export function decorateChatName(element, playerId) {
  const info = accountOf(playerId);
  if (element && info && !element.querySelector('.acct-tag')) {
    const tag = document.createElement('span'); tag.className = 'acct-tag'; tag.textContent = `#${info.tag}`; element.append(tag);
  }
  return element;
}

async function squareAvatar(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error(t('图片读取失败'))); i.src = url; });
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    if (!s) throw new Error(t('图片读取失败'));
    const c = document.createElement('canvas'); c.width = c.height = 128;
    c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, 128, 128);
    return c.toDataURL('image/jpeg', 0.86);
  } finally { URL.revokeObjectURL(url); }
}
function ensureStyle() {
  if (document.getElementById('local-acct-style')) return;
  const st = document.createElement('style'); st.id = 'local-acct-style';
  st.textContent = `.acct-tag{margin-left:.06em;font-size:.8em;font-weight:600;opacity:.62;letter-spacing:.02em}
.lacct{display:flex;flex-direction:column;gap:.16rem;min-width:min(5.6rem,86vw)}
.lacct__who{display:flex;align-items:center;gap:.16rem}
.lacct__pic{width:.9rem;height:.9rem;flex:none;display:grid;place-items:center;overflow:hidden;border:2px solid var(--mint-700,#2b7);background:#101614;font-size:.4rem;font-weight:900}
.lacct__pic img{width:100%;height:100%;object-fit:cover}
.lacct__name{font-size:.3rem;font-weight:900}
.lacct__note{margin:0;font-size:.17rem;line-height:1.5;opacity:.72}
.lacct__btns{display:flex;flex-wrap:wrap;gap:.1rem}`;
  document.head.appendChild(st);
}
let host = null;
function AccountPanel({ onStats, onClose }) {
  const { me } = useCurrentAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pick = () => {
    if (!me || busy) return;
    const id = me.id;
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
    input.onchange = async () => {
      const f = input.files?.[0]; if (!f) return;
      setBusy(true); setError('');
      try { const d = await squareAvatar(f); if (d.length > AVATAR_MAX) throw new Error(t('图片读取失败'));
        if (currentAccount()?.id === id) writeAvatar(d);
      } catch { setError(t('图片读取失败')); } finally { setBusy(false); input.value = ''; }
    };
    input.click();
  };
  const logout = async () => {
    setBusy(true); setError('');
    try { await logoutAccount(); }
    catch { setError(t('注销未确认，请重新验证账号；不要将本页视为已登出')); }
    finally { setBusy(false); }
  };
  return html`<${Modal} open=${true} title=${t('服务器账号')} micro=${t('自建服务器 · 非官方账号')} onClose=${onClose}>
    <div class="lacct">
      ${me ? html`<div class="lacct__who">
        <span class="lacct__pic">${me.avatar ? html`<img src=${me.avatar} alt="" />` : [...me.name][0]}</span>
        <span><b class="lacct__name">${me.name}<span class="acct-tag">#${me.tag}</span></b><br /><${MicroLabel}>${me.username}<//></span>
      </div>` : null}
      <p class="lacct__note">${t('登录凭证由本服务器保存；头像、调配、皮肤和战绩仅按账号保存在当前浏览器，不是云同步。旧游客资料不会自动归入账号。')}</p>
      ${error ? html`<p class="lacct__note" role="alert">${error}</p>` : null}
      <div class="lacct__btns">
        ${me ? html`<${Button} size="sm" variant="secondary" icon="edit" loading=${busy} onClick=${pick}>${t('更换头像')}<//>
          ${me.avatar ? html`<${Button} size="sm" variant="ghost" disabled=${busy} onClick=${() => writeAvatar(null)}>${t('移除头像')}<//>` : null}
          ${onStats ? html`<${Button} size="sm" variant="primary" icon="chart" onClick=${() => { onClose(); onStats(); }}>${t('统计数据')}<//>` : null}` : null}
        <${Button} size="sm" variant="ghost" loading=${busy} onClick=${logout}>${t('注销账号')}<//>
        ${!me ? html`<${Button} size="sm" variant="secondary" onClick=${() => location.reload()}>${t('重新验证账号')}<//>` : null}
      </div>
    </div>
  <//>`;
}
export function openAccountPanel(opts = {}) {
  ensureStyle();
  if (!host) { host = document.createElement('div'); host.className = 'local-acct-host'; document.body.appendChild(host); }
  const close = () => render(null, host);
  render(html`<${AccountPanel} onStats=${opts.onStats} onClose=${close} />`, host);
}
export function AccountMeChip({ player, onStats }) {
  const { me } = useCurrentAccount(); useEffect(ensureStyle, []);
  if (!me) return null;
  const name = player?.name || me.name;
  return html`<button type="button" class="me-chip me-chip--btn stats-entry" onClick=${() => openAccountPanel({ onStats })} title=${t('服务器账号 · 统计数据')} aria-label=${t('服务器账号')}>
    <${AvatarFrame} size="sm" name=${name} seat=${0} self=${true} src=${me.avatar || undefined} />
    <span class="me-chip__text"><span class="me-chip__name">${name}<span class="acct-tag">#${me.tag}</span></span><${MicroLabel}>${t('自建服务器账号')}<//></span>
    <${Icon} name="user" class="me-chip__stats" />
  </button>`;
}

/** Revalidate on visibility/focus: a different cookie account must never reuse old module caches. */
export function startAccounts() {
  if (startAccounts.started) return;
  startAccounts.started = true;
  const check = () => { if (!suspended && !globalThis.document?.hidden) void refreshAccount().catch(() => {}); };
  globalThis.addEventListener?.('focus', check);
  globalThis.document?.addEventListener('visibilitychange', check);
}
globalThis.addEventListener?.('storage', (e) => { if (account && e.key === avatarKey(account.id)) { avatar = readAvatar(account.id); emit(); } });
