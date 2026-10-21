// public/js/render/app/pixi.js — load PIXI and pixi-spine once (one module-level promise).

import { installPixiNoEval } from './pixiNoEval.js';

const VENDOR = { pixi: '/vendor/pixi.min.js', spine: '/vendor/pixi-spine.js' };

let pixiPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

function configurePixi(PIXI) {
  installPixiNoEval(PIXI);
  // Pixi's optional worker probe fetches a data: image, forbidden by connect-src 'self'.
  PIXI.Assets.setPreferences({ preferWorkers: false });
  return PIXI;
}

/** Make sure PIXI and PIXI.spine exist (classic scripts; loaded once). */
export function ensurePixi() {
  if (globalThis.PIXI && globalThis.PIXI.spine) return Promise.resolve(configurePixi(globalThis.PIXI));
  if (!pixiPromise) {
    pixiPromise = (async () => {
      if (!globalThis.PIXI) await loadScript(VENDOR.pixi);
      configurePixi(globalThis.PIXI);
      if (!globalThis.PIXI?.spine) await loadScript(VENDOR.spine);
      if (!globalThis.PIXI || !globalThis.PIXI.spine) throw new Error('PIXI / pixi-spine unavailable');
      return globalThis.PIXI;
    })();
    pixiPromise.catch(() => { pixiPromise = null; });
  }
  return pixiPromise;
}
