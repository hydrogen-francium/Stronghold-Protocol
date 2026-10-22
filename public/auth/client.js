// Independent authentication shell: no imports, game graph, credential persistence, or URL tokens.
const LANGS = ['zh', 'en', 'ja', 'ko', 'zh-TW'];
const LANGUAGE_NAMES = ['简体中文', '英语', '日语', '韩语', '繁体中文'];
const ACCOUNT_ID = /^a_[0-9a-f]{32}$/;
const CSRF = /^[0-9a-f]{64}$/;
const source = Object.freeze({
  title: '服务器账号登录', about: '自建服务器 · 非官方账号，与任何官方游戏账号无关。',
  language: '语言', zh: '简体中文', en: '英语', ja: '日语', ko: '韩语', tw: '繁体中文',
  checking: '正在验证服务器准入…', admit: '注册准入', entry: '共享准入令牌',
  entryHint: '仅注册时需要，向本服管理员获取。已有账号直接使用用户名和密码登录。令牌不会放入网址或本机存储。',
  admitButton: '验证准入令牌', login: '登录', register: '注册', username: '用户名',
  usernameHint: '3–32 位小写英文字母、数字或下划线；登录时不区分大小写。',
  name: '显示昵称', nameHint: '1–16 个字符；控制字符会被移除。昵称不是账号标识。',
  password: '密码', passwordHint: '12–128 个 Unicode 字符，最多 512 UTF-8 字节；空格会保留。请使用本服专用密码。',
  confirm: '再次输入密码', loginButton: '登录并进入', registerButton: '注册并进入',
  closed: '本服暂未开放注册，请使用已有账号登录。', retry: '重新验证状态',
  privacy: '账号由当前服务器管理。头像、调配、皮肤及战绩仅按账号保存在本机浏览器，不是云同步；旧游客资料不会自动归入账号。',
  busy: '正在提交…', badEntry: '请输入有效的共享准入令牌。',
  badUsername: '用户名须为 3–32 位英文字母、数字或下划线。',
  badName: '显示昵称须为 1–16 个有效字符。',
  badPassword: '密码须为 12–128 个有效 Unicode 字符，且不超过 512 UTF-8 字节。',
  mismatch: '两次输入的密码不一致。', network: '无法连接服务器，请重试；请勿重复注册。',
  invalidReply: '服务器响应无效，请重新验证状态。',
  entryRequired: '请先验证共享准入令牌。', entryInvalid: '准入令牌无效，请向本服管理员确认。',
  credentials: '用户名或密码不正确。', csrf: '验证状态已过期，请重新验证状态后重试。',
  origin: '请求来源不被允许，请使用本服的正确网址。', usernameTaken: '该用户名已被注册。',
  capacity: '服务器账号或会话已满，请联系管理员。', rate: '请求过于频繁，请稍后再试。',
  unavailable: '服务器暂时无法处理请求，请稍后再试。', invalid: '输入不符合服务器要求，请检查后重试。',
  languageFailed: '语言包读取失败，请重试或切换语言。',
});
let lang = 'zh', catalog = {}, languageSwitch = 0;
let csrf = null, admitted = false, registrationOpen = false, ready = false, mode = 'login', busy = false;
let messageKey = '', loadingLanguage = false;
let dom = null;

function t(msgid) { return typeof catalog[msgid] === 'string' ? catalog[msgid] : msgid; }
function text(key) { return t(source[key]); }
function initialLanguage() {
  try { const saved = JSON.parse(globalThis.localStorage?.getItem('sp.pref.lang') || 'null'); if (LANGS.includes(saved)) return saved; } catch { /* optional convenience */ }
  return 'zh';
}
function saveLanguage(value) { try { globalThis.localStorage?.setItem('sp.pref.lang', JSON.stringify(value)); } catch { /* optional convenience */ } }
function node(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'className') el.className = value;
    else if (key === 'onClick') el.addEventListener('click', value);
    else if (key === 'onSubmit') el.addEventListener('submit', value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value);
  }
  for (const child of children) el.append(child);
  return el;
}
function label(key, input, hintKey = null) {
  const title = node('span'); title.dataset.text = key;
  const hint = hintKey ? node('small', { id: `${input.id}-hint` }) : null;
  if (hint) { hint.dataset.text = hintKey; input.setAttribute('aria-describedby', hint.id); }
  return node('label', {}, hint ? [title, input, hint] : [title, input]);
}
function button(key, props = {}) { const el = node('button', { type: 'button', ...props }); el.dataset.text = key; return el; }
function input(id, props) { return node('input', { id, name: id, ...props }); }
function setMessage(key = '') { messageKey = key; update(); }
function clearSecrets() {
  if (!dom) return;
  dom.entry.value = ''; dom.password.value = ''; dom.confirm.value = '';
}
function build() {
  const root = document.getElementById('auth');
  const title = node('h1'); title.dataset.text = 'title';
  const about = node('p', { className: 'note' }); about.dataset.text = 'about';
  const language = node('select', { id: 'language', name: 'language' });
  LANGS.forEach((code, i) => { const option = node('option', { value: code }); option.textContent = t(LANGUAGE_NAMES[i]); language.append(option); });
  const languageLabel = node('label', { htmlFor: 'language' }); languageLabel.dataset.text = 'language';
  language.addEventListener('change', () => { clearSecrets(); void switchLanguage(language.value); });
  const languageRow = node('div', { className: 'language' }, [languageLabel, language]);
  const checking = node('p', { role: 'status' }); checking.dataset.text = 'checking';
  const entry = input('entry', { type: 'password', autoComplete: 'off', maxLength: 512, spellcheck: false, required: true });
  const admitTitle = node('h2'); admitTitle.dataset.text = 'admit';
  const admitSubmit = button('admitButton', { type: 'submit' });
  const admitForm = node('form', { onSubmit: submitAdmission, noValidate: true }, [admitTitle, label('entry', entry, 'entryHint'), admitSubmit]);
  const loginTab = button('login', { className: 'secondary', onClick: () => changeMode('login') });
  const registerTab = button('register', { className: 'secondary', onClick: () => changeMode('register') });
  const tabs = node('div', { className: 'tabs' }, [loginTab, registerTab]);
  const username = input('username', { type: 'text', autoComplete: 'username', maxLength: 32, spellcheck: false,
    autoCapitalize: 'none', required: true });
  const name = input('name', { type: 'text', autoComplete: 'nickname', maxLength: 128, required: true });
  const password = input('password', { type: 'password', autoComplete: 'current-password', maxLength: 256, required: true });
  const confirm = input('confirm', { type: 'password', autoComplete: 'new-password', maxLength: 256, required: true });
  const nameField = label('name', name, 'nameHint');
  const confirmField = label('confirm', confirm);
  const accountSubmit = button('loginButton', { type: 'submit' });
  const accountForm = node('form', { onSubmit: submitAccount, noValidate: true }, [label('username', username, 'usernameHint'), nameField,
    label('password', password, 'passwordHint'), confirmField, accountSubmit]);
  const closed = node('p', { className: 'note' }); closed.dataset.text = 'closed';
  const accounts = node('div', {}, [tabs, closed, accountForm]);
  const message = node('p', { className: 'message', role: 'alert', 'aria-live': 'polite' });
  const retry = button('retry', { className: 'secondary', onClick: () => { clearSecrets(); void refreshStatus(); } });
  const privacy = node('p'); privacy.dataset.text = 'privacy';
  root.replaceChildren(node('header', {}, [title, about]), languageRow, node('section', {}, [checking, admitForm, accounts, message, retry]), node('footer', {}, [privacy]));
  dom = { root, language, checking, entry, admitForm, admitSubmit, loginTab, registerTab, accounts, username, name,
    nameField, password, confirm, confirmField, accountForm, accountSubmit, closed, message, retry };
  update();
}
/** 切换登录或注册模式，清空密码和令牌，避免在两种用途之间复用敏感输入。 */
function changeMode(next) { clearSecrets(); mode = next === 'register' && registrationOpen ? 'register' : 'login'; setMessage(); }
/** 根据账号模式和注册授权刷新表单；登录不展示也不依赖准入令牌。 */
function update() {
  if (!dom) return;
  document.title = text('title'); document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  for (const el of dom.root.querySelectorAll('[data-text]')) el.textContent = text(el.dataset.text);
  [...dom.language.options].forEach((option, i) => { option.textContent = t(LANGUAGE_NAMES[i]); });
  dom.language.value = lang;
  dom.checking.hidden = ready || (!busy && !loadingLanguage);
  dom.admitForm.hidden = !ready || mode !== 'register' || admitted;
  dom.accounts.hidden = !ready;
  dom.accountForm.hidden = mode === 'register' && !admitted;
  dom.nameField.hidden = mode !== 'register'; dom.name.disabled = mode !== 'register';
  dom.confirmField.hidden = mode !== 'register'; dom.confirm.disabled = mode !== 'register';
  dom.password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  dom.closed.hidden = registrationOpen;
  dom.loginTab.setAttribute('aria-pressed', String(mode === 'login'));
  dom.registerTab.setAttribute('aria-pressed', String(mode === 'register'));
  for (const el of dom.root.querySelectorAll('input,button')) el.disabled = busy || loadingLanguage;
  dom.name.disabled = busy || loadingLanguage || mode !== 'register';
  dom.confirm.disabled = busy || loadingLanguage || mode !== 'register';
  dom.registerTab.disabled = busy || loadingLanguage || !registrationOpen;
  dom.language.disabled = busy || loadingLanguage;
  dom.accountSubmit.textContent = text(busy ? 'busy' : mode === 'register' ? 'registerButton' : 'loginButton');
  dom.admitSubmit.textContent = text(busy ? 'busy' : 'admitButton');
  dom.message.textContent = messageKey ? text(messageKey) : '';
  dom.retry.hidden = busy || (!messageKey && ready);
  dom.root.setAttribute('aria-busy', String(busy || loadingLanguage));
}
async function switchLanguage(next) {
  const requested = LANGS.includes(next) ? next : 'zh';
  const sequence = ++languageSwitch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  loadingLanguage = true; update();
  try {
    const response = requested === 'zh' ? null : await fetch(`/auth/i18n/${requested}.json`, { credentials: 'same-origin', cache: 'no-store', mode: 'same-origin', redirect: 'error', signal: controller.signal });
    if (response && !response.ok) throw new Error('language');
    const pack = response ? await response.json() : {};
    if (sequence !== languageSwitch) return;
    if (!pack || typeof pack !== 'object' || [...Object.values(source)].some((key) => requested !== 'zh' && typeof pack[key] !== 'string')) throw new Error('language');
    lang = requested; catalog = pack; saveLanguage(lang);
  } catch {
    if (sequence !== languageSwitch) return;
    messageKey = 'languageFailed';
  } finally {
    clearTimeout(timer);
    if (sequence === languageSwitch) { loadingLanguage = false; update(); }
  }
}
const errorKeys = {
  ENTRY_REQUIRED: 'entryRequired', ENTRY_INVALID: 'entryInvalid', CREDENTIALS_INVALID: 'credentials',
  REGISTRATION_CLOSED: 'closed', USERNAME_TAKEN: 'usernameTaken', ACCOUNTS_FULL: 'capacity', SESSIONS_FULL: 'capacity',
  CSRF: 'csrf', ORIGIN: 'origin', RATE: 'rate', AUTH_BUSY: 'unavailable', MAINTENANCE: 'unavailable',
  INVALID: 'invalid', BODY: 'invalid', TOO_LARGE: 'invalid', INTERNAL: 'unavailable',
};
function authError(key, code = '') { const error = new Error(key); error.key = key; error.code = code; return error; }
async function request(path, fields) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const write = fields !== undefined;
    if (write && !CSRF.test(csrf || '')) throw authError('csrf', 'CSRF');
    // Browser supplies the exact same-origin Origin; never forge it or put secrets in a URL.
    const response = await fetch(path, { method: write ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
      headers: { Accept: 'application/json', ...(write ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}) },
      ...(write ? { body: JSON.stringify(fields) } : {}), signal: controller.signal });
    let body;
    try { body = await response.json(); } catch { throw authError('invalidReply'); }
    if (!response.ok) {
      const code = typeof body?.error === 'string' ? body.error : '';
      if (code === 'ENTRY_REQUIRED') admitted = false;
      if (code === 'CSRF' || code === 'ORIGIN') { csrf = null; ready = false; }
      if (code === 'REGISTRATION_CLOSED') { registrationOpen = false; mode = 'login'; }
      throw authError(errorKeys[code] || 'unavailable', code);
    }
    if (!body || typeof body !== 'object' || !CSRF.test(body.csrf || '')) throw authError('invalidReply');
    csrf = body.csrf;
    return body;
  } catch (error) {
    if (error.key) throw error;
    throw authError('network');
  } finally { clearTimeout(timer); }
}
/** 拉取账号与注册授权状态并刷新防伪令牌；有效账号直接进入游戏。 */
async function refreshStatus() {
  if (busy) return;
  busy = true; ready = false; messageKey = ''; clearSecrets(); update();
  try {
    const body = await request('/auth/status');
    if (body.account && ACCOUNT_ID.test(body.account.id || '')) { location.replace('/'); return; }
    if (body.account) throw authError('invalidReply');
    admitted = body.admitted === true; registrationOpen = body.registrationOpen === true; ready = true;
    if (!registrationOpen) mode = 'login';
  } catch (error) { messageKey = error.key || 'network'; }
  finally { busy = false; update(); }
}
function wellFormed(value) {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function validPassword(value) { return wellFormed(value) && [...value].length >= 12 && [...value].length <= 128 && new TextEncoder().encode(value).length <= 512; }
function validName(value) { const name = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim(); return wellFormed(value) && [...name].length >= 1 && [...name].length <= 16 ? name : null; }
async function submitAdmission(event) {
  event.preventDefault();
  if (busy || !ready || admitted) return;
  const token = dom.entry.value;
  if (!wellFormed(token) || new TextEncoder().encode(token).length < 32 || new TextEncoder().encode(token).length > 512) { clearSecrets(); setMessage('badEntry'); return; }
  busy = true; messageKey = ''; update();
  try { const body = await request('/auth/admit', { token });
    if (body.admitted !== true) throw authError('invalidReply');
    admitted = true;
  } catch (error) { messageKey = error.key || 'network'; }
  finally { clearSecrets(); busy = false; update(); }
  // Admission rotates CSRF and may change registration availability; read the fresh server policy.
  if (admitted && !messageKey) await refreshStatus();
}
/** 提交当前账号表单；仅注册要求准入授权，成功后跳转并清除敏感输入。 */
async function submitAccount(event) {
  event.preventDefault();
  if (busy || !ready || (mode === 'register' && !admitted)) return;
  const username = dom.username.value.trim().toLowerCase();
  const password = dom.password.value;
  const name = mode === 'register' ? validName(dom.name.value) : null;
  let error = '';
  if (!/^[a-z0-9_]{3,32}$/.test(username)) error = 'badUsername';
  else if (!validPassword(password)) error = 'badPassword';
  else if (mode === 'register' && !name) error = 'badName';
  else if (mode === 'register' && password !== dom.confirm.value) error = 'mismatch';
  if (error) { clearSecrets(); setMessage(error); return; }
  busy = true; messageKey = ''; update();
  try {
    const body = await request(mode === 'register' ? '/auth/register' : '/auth/login', { username, password, ...(mode === 'register' ? { name } : {}) });
    if (!ACCOUNT_ID.test(body.account?.id || '')) throw authError('invalidReply');
    clearSecrets(); location.replace('/');
  } catch (error) { messageKey = error.key || 'network'; }
  finally { clearSecrets(); busy = false; update(); }
}

if (typeof document !== 'undefined') {
  build();
  // Status/CSRF is the first request, independent of translation loading.
  void refreshStatus();
  void switchLanguage(initialLanguage());
  globalThis.addEventListener('pagehide', clearSecrets);
  globalThis.addEventListener('pageshow', (event) => { if (event.persisted) { clearSecrets(); void refreshStatus(); } });
}
