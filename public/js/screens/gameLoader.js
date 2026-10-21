import { html, Spinner } from "../ui/components.js";
import { useEffect, useState } from "../../vendor/hooks.module.js";

let graph;

/** 提前下载对局模块并复用同一结果；不在标题页阻塞首屏，也不自动重试导入错误。 */
export function preloadGameScreen() {
  return graph ??= import("./game.js");
}

/** 模块尚未下载时显示真实加载状态；导入失败交给既有界面错误边界。 */
export function GameScreen() {
  const [loaded, setLoaded] = useState(null);
  useEffect(() => {
    let mounted = true;
    preloadGameScreen().then(
      (module) => { if (mounted) setLoaded({ component: module.GameScreen }); },
      (error) => { if (mounted) setLoaded({ error }); },
    );
    return () => { mounted = false; };
  }, []);
  if (loaded?.error) throw loaded.error;
  if (loaded) return html`<${loaded.component} />`;
  return html`<div class="screen gload"><${Spinner} size="lg" /></div>`;
}
