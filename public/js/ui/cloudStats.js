// Persistent login does not make these device records authoritative cloud statistics.
// They remain local, account-scoped browser data. No upload or social API is implemented.
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { loadStats } from './stats.js';
import { store } from '../store.js';
import { N_, t } from '../../../shared/i18n.js';

const listeners = new Set();
const NO_SERVICE = N_('本服未启用云战绩与社交服务；战绩和成就仅保存在本机');

/** Local records only, even though login is a persistent server account. */
export async function accountApi() { throw new Error(t(NO_SERVICE)); }

/** { records (newest first), source, ready, failed, likes } — the local account's list = this browser's records. */
export function currentRecords() {
  const records = [...loadStats().records].sort((a, b) => (b?.t || 0) - (a?.t || 0));
  return { records, source: 'device', local: true, ready: true, failed: false, likes: null };
}
export function syncRecords() { for (const fn of listeners) fn(); return Promise.resolve(); }
/** Nothing is uploaded: a record is never "on the account service". */
export async function ensureUploaded() { return false; }
export async function uploadRecords() { return 0; }
export const importDeviceRecords = () => uploadRecords();
export async function clearAccountRecords() {}
export async function loadFriendRecords() { throw new Error(t(NO_SERVICE)); }

/** Preact: the records, re-read when another tab writes them and when a match is recorded here. */
export function useRecords() {
  const [cur, setCur] = useState(currentRecords);
  useEffect(() => {
    const fn = () => setCur(currentRecords());
    listeners.add(fn);
    const onStorage = (e) => { if (!e.key || e.key === store.prefStorageKey('stats')) fn(); };
    addEventListener('storage', onStorage);
    const id = setInterval(() => { if (!document.hidden) fn(); }, 15000);
    return () => { listeners.delete(fn); removeEventListener('storage', onStorage); clearInterval(id); };
  }, []);
  return cur;
}
export function startCloudStats() {}
