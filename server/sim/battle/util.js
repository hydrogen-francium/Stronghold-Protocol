// server/sim/battle/util.js — small helpers shared by the Battle method modules (server/sim/battle/*.js).

/** Finite number or the default (content may pass undefined/NaN/Infinity/strings to helpers). */
export const fin = (v, d) => { const n = typeof v === 'number' ? v : (v == null || v === '' ? NaN : Number(v)); return Number.isFinite(n) ? n : d; };

export function clone(v) {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clone);
  const o = {};
  for (const k of Object.keys(v)) o[k] = clone(v[k]);
  return o;
}

/** 判断两个地图医疗实例能否共用原位置；仅同目标玩家、不同策略来源的地图角色可以叠放。 */
export function shareMapCharTile(a, b) {
  return !!(a?.mapCharSource && b?.mapCharSource && a.ownerId === b.ownerId
    && (a.mapCharSource.playerId !== b.mapCharSource.playerId || a.mapCharSource.bandId !== b.mapCharSource.bandId));
}
