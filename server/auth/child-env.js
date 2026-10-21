// Keep coordinator authentication/state configuration out of child/worker environment copies.
// This removes an implicit transport, not native trusted code's filesystem or process capabilities.
const PRIVATE_KEYS = new Set([
  'SP_ENTRY_TOKEN', 'SP_ENTRY_TOKEN_FILE', 'SP_SESSION_SECRET', 'SP_SESSION_SECRET_FILE', 'SP_STATE_DIR',
]);

/** A detached environment for non-auth children; never mutate the parent's environment. */
export function childEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (PRIVATE_KEYS.has(name) || name.startsWith('SP_AUTH_')) delete env[key];
  }
  return env;
}
