import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter } from './approval-fixture.mjs';
import { runAcceptance } from './acceptance.mjs';

const scenario = { goal: 'Prepare one dinner invite', recipient: 'controlled@example.invalid', editedText: 'Edited local fixture invitation.', expectedOutcome: { invitesSent: 1, recipient: 'controlled@example.invalid' }, expectedShortlistIds: ['known-1'], selectedPersonIds: ['known-1'], requiredSponsors: ['neon'] };

test('real ledger/state/connector fixture proves five gate cases while journey and sponsor proof stay unverified', async () => {
  const { adapter, environment } = await createAdapter({ scenario });
  try {
    const report = await runAcceptance({ adapter, environment, scenario });
    const statuses = Object.fromEntries(report.capability.cases.map(item => [item.id, item.status]));
    assert.deepEqual(statuses, { 'full-journey': 'unverified', 'approval-no-send': 'pass', 'approval-edited': 'pass', 'approval-stale': 'pass', 'restart-idempotence': 'pass', 'unknown-send-outcome': 'pass', 'sponsor-evidence': 'unverified' });
    assert.equal(report.accepted, false);
    assert.equal(report.comprehension.status, 'unverified');
    assert.equal(report.environment.boundaries.delivery, 'fixture');
    assert.equal(report.environment.boundaries.ledger, 'real');
  } finally { await adapter.close(); }
});

test('component fixture refuses any real recipient', async () => {
  await assert.rejects(createAdapter({ scenario: { ...scenario, recipient: 'real@example.com' } }), /invented.*fixture recipient/);
});
