import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tsImport } from 'tsx/esm/api';
import { configureNeonLaunch } from '../tools/neon-launch-env.mjs';

const { seedNeonDemo } = await tsImport('../tools/neon-seed.ts', import.meta.url);
const { buildSystem, createLoisServer, closeSidecar } = await tsImport('../sidecar/server.ts', import.meta.url);
const { createNeonService } = await tsImport('../sidecar/neon/server.ts', import.meta.url);
const { loadVaultWorld } = await tsImport('../sidecar/vault.ts', import.meta.url);
const root = resolve(import.meta.dirname, '..');
const listen = server => new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });

for (const custom of [false, true]) test(`both actual cold HTTP services read the ${custom ? 'custom path with spaces' : 'clean default seeded vault'}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'neon-launch-proof-'));
  const relative = custom ? 'custom vault with spaces' : '.local/demo-vault';
  let lois, neon, built;
  try {
    const seed = seedNeonDemo(join(directory, relative));
    const env = configureNeonLaunch({ ...(custom ? { NEON_VAULT_DIRECTORY: relative } : {}), LOIS_VAULT_DIR: '/unrelated/legacy/vault', LOIS_BROWSER_WORKSPACE_ROOT: join(directory, 'owned-browser-workspace') }, directory);
    assert.equal(env.NEON_VAULT_DIRECTORY, seed.vaultDir);
    assert.equal(env.LOIS_VAULT_DIR, seed.vaultDir);
    built = buildSystem(env, { resolveModel: () => null });
    lois = createLoisServer(built);
    neon = createNeonService({ directory: join(directory, 'state'), env, vaultDirectory: env.NEON_VAULT_DIRECTORY, world: () => loadVaultWorld(env.NEON_VAULT_DIRECTORY), ready: () => false,
      async runtimeFactory() { throw new Error('Cold startup must not run inference.'); },
      async connectorsFactory() { throw new Error('Cold startup must not contact connectors.'); },
    });
    await listen(lois); await listen(neon);
    const read = async (server, path) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { Host: 'localhost:5299' } });
      assert.equal(response.status, 200); return response.json();
    };
    const health = await read(lois, '/api/lois/health');
    assert.equal(health.vault, seed.vaultDir);
    const legacyPeople = await read(lois, '/api/lois/people');
    const neonPeople = await read(neon, '/api/neon/people-workspace');
    assert.deepEqual(neonPeople, legacyPeople);
    assert.ok(JSON.stringify(neonPeople).includes('Synthetic dinner circle'));
    assert.equal((await read(neon, '/api/neon/status')).keysReady, false);
  } finally {
    if (neon?.listening) await new Promise(yes => { neon.close(yes); neon.closeAllConnections(); });
    if (lois?.listening) await closeSidecar(lois, built);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the actual Node preload reads env-file configuration before resolving a shared absolute vault', () => {
  const directory = mkdtempSync(join(tmpdir(), 'neon-preload-proof-'));
  try {
    const vault = join(directory, 'vault with spaces'); seedNeonDemo(vault);
    const envFile = join(directory, 'fixture.env');
    writeFileSync(envFile, `NEON_VAULT_DIRECTORY="${vault}"\nLOIS_VAULT_DIR="/unrelated/vault"\n`);
    const child = spawnSync(process.execPath, [`--env-file=${envFile}`, '--import', './tools/neon-launch-preload.mjs', '--input-type=module', '-e', 'console.log(JSON.stringify([process.env.NEON_VAULT_DIRECTORY,process.env.LOIS_VAULT_DIR]))'], { cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), [vault, vault]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('missing, empty and incompatible workspace configuration fails before spawning services', () => {
  assert.throws(() => configureNeonLaunch({}, '/nonexistent/neon-fixture'), /pnpm seed:neon/);
  assert.throws(() => configureNeonLaunch({ NEON_VAULT_DIRECTORY: ' ' }), /present but empty/);
  assert.throws(() => configureNeonLaunch({ LOIS_SMOKE_RUN_ROOT: '/fixture' }), /cannot use/);
});
