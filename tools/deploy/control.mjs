import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * 本地运维入口：生成独立强密钥，或切换私有状态目录的开局排空标记。
 * @param {string[]} argv 命令及绝对目录；不接受密钥或密码参数。
 * @param {Record<string, string | undefined>} env 状态目录配置。
 * @returns {void} 写入密钥或维护文件，失败直接抛错，不覆盖既有文件。
 */
export function control(argv, env = process.env) {
  const [command, directory] = argv;
  if (command === 'secrets' && argv.length === 2 && path.isAbsolute(directory)) {
    fs.mkdirSync(directory, { mode: 0o700 });
    for (const name of ['entry-token', 'session-secret']) {
      fs.writeFileSync(path.join(directory, name), randomBytes(48).toString('base64url'), { flag: 'wx', mode: 0o400 });
    }
    return;
  }
  if (argv.length !== 1 || !['drain', 'resume'].includes(command) || !env.SP_STATE_DIR || !path.isAbsolute(env.SP_STATE_DIR)) {
    throw new TypeError('用法：secrets <全新绝对目录>，或在已配置 SP_STATE_DIR 的应用容器内执行 drain / resume');
  }
  const file = path.join(env.SP_STATE_DIR, 'draining');
  if (command === 'drain') fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  else fs.unlinkSync(file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) control(process.argv.slice(2));
