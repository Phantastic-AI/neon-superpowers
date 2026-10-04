import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const required = ['stream.jsonl', 'persons.json', 'contexts.json', 'gatherings.json'];

// Resolve once before concurrently starts either sidecar. An inherited legacy
// override must not silently put the browser pane in a different workspace.
export function configureNeonLaunch(env = process.env, root = ROOT) {
  const configured = env.NEON_VAULT_DIRECTORY;
  if (configured !== undefined && !configured.trim()) throw new Error('NEON_VAULT_DIRECTORY is present but empty.');
  if (env.LOIS_SMOKE_RUN_ROOT !== undefined) throw new Error('app:neon cannot use LOIS_SMOKE_RUN_ROOT.');
  const vault = resolve(root, configured ?? '.local/demo-vault');
  try {
    if (!statSync(vault).isDirectory() || required.some(name => !statSync(resolve(vault, name)).isFile())) throw new Error('incomplete');
  } catch {
    throw new Error('Neon vault is missing or incomplete. Run pnpm seed:neon for the default demo, or set NEON_VAULT_DIRECTORY to an existing vault.');
  }
  env.NEON_VAULT_DIRECTORY = vault;
  env.LOIS_VAULT_DIR = vault;
  return env;
}
