import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';

/** 仅转换界面图片；不改动骨骼纹理、法线图或用户下载校验所依赖的原始字节。 */
export function wantsWebp(req, segments, size) {
  if (req.headers.range || size < 4096 || segments[0] !== 'assets') return false;
  if (!['char', 'item', 'band', 'bond', 'prof', 'skill', 'ui'].includes(segments[1])) return false;
  if (!segments.at(-1).toLowerCase().endsWith('.png')) return false;
  return String(req.headers.accept || '').split(',').some((entry) => {
    const [type, ...params] = entry.trim().split(';');
    const quality = params.find((param) => param.trim().startsWith('q='));
    return type === 'image/webp' && (!quality || Number(quality.trim().slice(2)) > 0);
  });
}

/**
 * 创建无损图片派生缓存；只写应用缓存目录，原素材卷保持只读。转换最多并行两份，避免挤占对局线程。
 * @param {string} directory 派生文件目录，需由应用用户可写。
 * @returns {(source: string, stat: import('node:fs').Stats, hash?: string) => Promise<{path: string, stat: import('node:fs').Stats}>}
 */
export function createImageVariants(directory) {
  const pending = new Map();
  const waiting = [];
  let active = 0;

  /** 为转换保留一个工作位；磁盘命中不进入队列，调用者在结束时释放。 */
  async function enter() {
    if (active < 2) { active++; return; }
    await new Promise((resolve) => waiting.push(resolve));
  }

  /** 直接把工作位交给下一份图片，确保新请求不会越过已等待的转换。 */
  function leave() {
    if (waiting.length) waiting.shift()();
    else active--;
  }

  /**
   * 返回与源文件版本绑定的 WebP；同图并发共享转换，错误直接交由现有 HTTP 错误处理报告。
   * @param {string} source 已通过静态路由路径检查的原文件。
   * @param {import('node:fs').Stats} stat 原文件状态，用于未建立素材索引时区分版本。
   * @param {string} [hash] 素材索引的内容哈希。
   */
  return function variant(source, stat, hash) {
    const identity = `${source}\0${hash || `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`}`;
    const key = createHash('sha256').update(identity).digest('hex');
    if (pending.has(key)) return pending.get(key);
    const destination = path.join(directory, `${key}.webp`);
    const task = (async () => {
      try { return { path: destination, stat: await fs.stat(destination) }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await enter();
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(directory, { recursive: true });
        // 无损保留尺寸和透明度；低编码强度减少第一次请求的转换时间。格式能力见官方文档。
        // https://sharp.pixelplumbing.com/api-output/#webp
        await sharp(source).webp({ lossless: true, effort: 1 }).toFile(temporary);
        await fs.rename(temporary, destination);
        return { path: destination, stat: await fs.stat(destination) };
      } finally {
        leave();
        await fs.rm(temporary, { force: true });
      }
    })();
    pending.set(key, task);
    // 同时移除成功和失败任务，不永久保留所有图片对象，也不在这里增加自动重试。
    task.then(() => pending.delete(key), () => pending.delete(key));
    return task;
  };
}
