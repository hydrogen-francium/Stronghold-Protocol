// Local maintenance only. No HTTP listener, environment loading, or password arguments.
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { AuthStore, normalizeUsername, publicAccount } from './store.js';
import { Passwords, validatePassword } from './passwords.js';

const HELP = `Usage: node server/auth/admin.js <command> --db <existing-auth.sqlite> <options>

Commands:
  disable        --username <username>   Disable an account and revoke its sessions
  enable         --username <username>   Enable an account without restoring sessions
  reset-password --username <username>   Read a new password from standard input
  backup         --output <new-file>     Create a consistent, exclusive SQLite backup

Passwords are never accepted in arguments or environment variables.
For reset-password, supply UTF-8 on standard input; one final LF/CRLF is removed.
The database must already exist. This command does not initialize databases.
`;
const COMMANDS = new Set(['disable', 'enable', 'reset-password', 'backup']);
const ERRORS = Object.freeze({
  ARGUMENTS: 'Invalid arguments. Use --help for usage.',
  DATABASE_NOT_FOUND: 'The selected authentication database does not exist.',
  DATABASE_INVALID: 'Select an initialized, regular authentication database file.',
  FUTURE_VERSION: 'This authentication database requires a newer application version.',
  SCHEMA_ERROR: 'The selected authentication database has an unsupported schema.',
  ACCOUNT_NOT_FOUND: 'The selected account does not exist.',
  PASSWORD_STDIN_REQUIRED: 'Supply the new password on non-interactive standard input.',
  PASSWORD_INPUT: 'Cannot read the password from standard input.',
  PASSWORD_INVALID: 'The password must satisfy the application password policy.',
  PASSWORD_TIMEOUT: 'Timed out waiting for the password on standard input.',
  BACKUP_EXISTS: 'The backup destination already exists; nothing was overwritten.',
  CLOSED: 'The authentication database is closed.',
  INVALID: 'The requested operation is invalid.',
  ADMIN_FAILED: 'The account maintenance operation failed.',
});

function failure(code) { return Object.assign(new Error(code), { code }); }

function argumentsOf(argv) {
  if (!Array.isArray(argv) || argv.length > 7 || argv.some(value =>
    typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f]/.test(value))) throw failure('ARGUMENTS');
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === 'help')) return null;
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command) || rest.length !== 4) throw failure('ARGUMENTS');
  const options = Object.create(null);
  const target = command === 'backup' ? '--output' : '--username';
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if ((key !== '--db' && key !== target) || Object.hasOwn(options, key) || !value || value.startsWith('--')) {
      throw failure('ARGUMENTS');
    }
    options[key] = value;
  }
  if (!options['--db'] || !options[target]) throw failure('ARGUMENTS');
  const username = command === 'backup' ? null : normalizeUsername(options[target]);
  if (command !== 'backup' && username === null) throw failure('ARGUMENTS');
  return { command, file: resolve(options['--db']), username,
    destination: command === 'backup' ? resolve(options[target]) : null };
}

function openExisting(file) {
  let stat;
  try { stat = lstatSync(file); } catch (error) {
    throw failure(error.code === 'ENOENT' ? 'DATABASE_NOT_FOUND' : 'DATABASE_INVALID');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw failure('DATABASE_INVALID');
  // Probe read-only first: a typo must not create/migrate an unrelated database.
  let probe;
  try {
    probe = new DatabaseSync(file, { readOnly: true, allowExtension: false });
    const version = probe.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw failure('FUTURE_VERSION');
    if (version !== 1) throw failure('SCHEMA_ERROR');
    probe.prepare('SELECT accountId, username, name, hash, disabled, credentialVersion, createdAt FROM accounts LIMIT 0').all();
    probe.prepare('SELECT tokenHash, csrfHash, accountId, credentialVersion, createdAt, expiresAt FROM sessions LIMIT 0').all();
  } catch (error) {
    if (error.code === 'FUTURE_VERSION' || error.code === 'SCHEMA_ERROR') throw error;
    throw failure('DATABASE_INVALID');
  } finally { probe?.close(); }
  return new AuthStore({ file });
}

async function passwordFrom(input) {
  if (input.isTTY) throw failure('PASSWORD_STDIN_REQUIRED');
  const chunks = [];
  let size = 0, timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(failure('PASSWORD_TIMEOUT'));
      input.destroy?.();
    }, 15_000);
    timer.unref?.();
  });
  const read = (async () => {
    try {
      for await (const chunk of input) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 514) throw failure('PASSWORD_INVALID');
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks);
      let password;
      try { password = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r?\n$/, ''); }
      catch { throw failure('PASSWORD_INVALID'); }
      finally { bytes.fill(0); }
      if (!validatePassword(password)) throw failure('PASSWORD_INVALID');
      return password;
    } catch (error) {
      if (error.code === 'PASSWORD_INVALID') throw error;
      throw failure('PASSWORD_INPUT');
    } finally { for (const chunk of chunks) chunk.fill(0); }
  })();
  try { return await Promise.race([read, timeout]); } finally { clearTimeout(timer); }
}

/** Returns an exit code. Only detached public account fields reach stdout. */
export async function runAdmin(argv, { input = process.stdin, output = process.stdout, error = process.stderr } = {}) {
  let store, passwords;
  try {
    const options = argumentsOf(argv);
    if (!options) { output.write(HELP); return 0; }
    store = openExisting(options.file);
    if (options.command === 'backup') {
      const { pages } = await store.backup(options.destination);
      output.write(JSON.stringify({ ok: true, action: 'backup', pages }) + '\n');
    } else {
      const account = store.accountByUsername(options.username);
      if (!account) throw failure('ACCOUNT_NOT_FOUND');
      let updated;
      if (options.command === 'reset-password') {
        const password = await passwordFrom(input);
        passwords = new Passwords();
        updated = store.setPassword(account.accountId, await passwords.hash(password));
      } else updated = store.setDisabled(account.accountId, options.command === 'disable');
      output.write(JSON.stringify({ ok: true, action: options.command, account: publicAccount(updated),
        disabled: updated.disabled, sessionsRevoked: true }) + '\n');
    }
    return 0;
  } catch (caught) {
    // Do not print exception text: SQLite/OS errors can contain private paths or inputs.
    const code = Object.hasOwn(ERRORS, caught?.code) ? caught.code : 'ADMIN_FAILED';
    error.write(JSON.stringify({ ok: false, error: code, message: ERRORS[code] }) + '\n');
    return code === 'ARGUMENTS' || code.startsWith('PASSWORD_') ? 2 : 1;
  } finally {
    await passwords?.close();
    await store?.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runAdmin(process.argv.slice(2));
}
