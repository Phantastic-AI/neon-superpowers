import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPageCli } from './goldfish-page.mjs';

test('single PNG CLI keeps usage beside verdict without declaring capability acceptance and always closes provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'neon-goldfish-page-cli-'));
  const path = join(root, 'page.png'); let closed = 0;
  writeFileSync(path, Buffer.from([137,80,78,71,13,10,26,10]));
  const providerFactory = () => ({
    async complete(input) { assert.equal(input.user, 'Tiny job brief: Review.'); return JSON.stringify({ job: 'Review', visible_state: 'Pending', next_step: 'Review words', lois_was_sane: true, browser_state_clear: true, choices_visible: 1, confusing: [], verdict: 'swims' }); },
    latestEvidence: () => ({ id: 'fixture-request', costUsd: null, costSource: 'unknown' }),
    close() { closed += 1; },
  });
  try {
    const result = await runPageCli(['--png', path, '--brief', 'Review.'], { providerFactory });
    assert.equal(result.exitCode, 0); assert.equal(result.report.status, 'pass');
    assert.equal(result.report.kind, 'whole-page-comprehension'); assert.equal('accepted' in result.report, false);
    assert.equal(result.report.providerEvidence.costUsd, null); assert.equal(closed, 1);
    const failed = await runPageCli(['--png', path, '--brief', 'Review.'], { providerFactory: () => ({ complete: async () => '{}', close: () => { closed += 1; } }) });
    assert.equal(failed.exitCode, 1); assert.equal(failed.report.status, 'fail'); assert.equal(closed, 2);
    await assert.rejects(runPageCli(['--png', path, '--history', 'writer']), /Usage/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
