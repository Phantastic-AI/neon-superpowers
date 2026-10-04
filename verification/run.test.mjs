import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './run.mjs';

test('no adapter emits an explicit unverified report and nonzero status', async () => {
  const { report, exitCode } = await runCli([]);
  assert.equal(exitCode, 2);
  assert.equal(report.accepted, false);
  assert.equal(report.capability.status, 'unverified');
});

test('provider startup failure still closes an already-created app adapter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neon-verification-startup-'));
  try {
    const adapter = join(dir, 'adapter.mjs'), provider = join(dir, 'provider.mjs'), marker = join(dir, 'closed');
    writeFileSync(adapter, `import {writeFileSync} from 'node:fs'; export function createAdapter(){ return {adapter:{close(){writeFileSync(${JSON.stringify(marker)},'closed')}},environment:{kind:'fixture',revision:'test'}}; }`);
    writeFileSync(provider, "export function createProvider(){throw new Error('Provider not configured')}");
    await assert.rejects(runCli(['--adapter', adapter, '--provider', provider]), /Provider not configured/);
    assert.equal(existsSync(marker), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown, duplicate, or incomplete options refuse before runtime import', async () => {
  for (const args of [['--paid'], ['--scenario'], ['--scenario', 'one', '--scenario', 'two']]) {
    await assert.rejects(runCli(args), /Usage/);
  }
});
