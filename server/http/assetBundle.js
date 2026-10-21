import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 固定包的素材清单白名单；不能把素材卷当成业务数据或脚本根目录。 */
export const BUNDLE_MANIFESTS = Object.freeze(['assets.json', 'local-assets.json', 'local-fx.json']);
const release = JSON.parse(fs.readFileSync(new URL('../../shared/asset-release.json', import.meta.url), 'utf8'));

/**
 * 验证显式素材版本根与完成标记，返回只读静态根；缺失或损坏直接阻止启动。
 * @param {string | undefined} directory 绝对版本目录；未配置时沿用本地素材流程。
 * @returns {{ publicDir: string, dataDir: string } | null} 经校验的素材及清单目录。
 */
export function assetBundleFrom(directory) {
  if (directory === undefined) return null;
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('SP_ASSET_BUNDLE_DIR 必须是绝对版本目录');
  const root = fs.realpathSync(directory);
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'complete.json'), 'utf8'));
  if (marker.version !== release.version || marker.sha256 !== release.sha256) throw new Error('素材版本或哈希不匹配');
  const dataDir = path.join(root, 'data'), publicDir = path.join(root, 'public');
  for (const name of BUNDLE_MANIFESTS) {
    const bytes = fs.readFileSync(path.join(dataDir, name));
    if (createHash('sha256').update(bytes).digest('hex') !== marker.manifests?.[name]) throw new Error(`素材清单校验失败：${name}`);
    JSON.parse(bytes.toString('utf8'));
  }
  for (const name of ['assets', 'fonts']) {
    if (!fs.lstatSync(path.join(publicDir, name)).isDirectory()) throw new Error(`素材目录无效：${name}`);
  }
  return { publicDir, dataDir };
}
