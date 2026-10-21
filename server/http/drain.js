import fs from 'node:fs';
import path from 'node:path';

/**
 * 为单实例创建维护文件检查器；仅接受私有状态目录的固定标记，读取错误不放行。
 * @param {string | undefined} file 显式维护标记路径。
 * @param {string} stateDir 认证已验证的私有状态目录。
 * @returns {(() => boolean) | null} 未配置时不开启文件控制；检查不修改文件。
 */
export function drainCheckFrom(file, stateDir) {
  if (file === undefined) return null;
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== path.join(stateDir, 'draining')) {
    throw new TypeError('SP_DRAIN_FILE 必须指向私有状态目录下的 draining');
  }
  /** 每次新开局前读取标记，允许当前对局继续；异常权限或符号链接不能被当作未维护。 */
  function isDraining() {
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('维护标记必须是普通文件');
    return true;
  }
  isDraining();
  return isDraining;
}
