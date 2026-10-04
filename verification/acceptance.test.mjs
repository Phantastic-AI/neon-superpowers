import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAcceptance } from './acceptance.mjs';

const scenario = { goal: 'Prepare one invitation', editedText: 'Revised invitation', expectedOutcome: 'sent once', requiredSponsors: ['neon'], recipient: 'controlled@example.invalid', expectedShortlistIds: ['known-1', 'prospect-1'], selectedPersonIds: ['known-1'] };
const environment = { kind: 'fixture', revision: 'test-revision' };

function fixtureDriver({ leak = false, forget = false, staleAccepted = false, retryUnknown = false, wrongRecipient = false, fakeSponsor = false } = {}) {
  let state;
  const invoked = [];
  return {
    invoked,
    async reset({ caseId }) {
      invoked.push(`reset:${caseId}`);
      state = { goal: null, proposal: null, receipts: [], outcome: null, sponsorEvidence: [], replies: [], selectedPersonIds: [] };
    },
    async startGoal(goal) {
      invoked.push('startGoal');
      assert.equal(goal, scenario.goal);
      state.goal = { id: 'goal-1', status: 'review' };
      state.proposal = { id: 'proposal-1', version: 1, digest: 'digest-1', body: 'Invitation', status: 'pending' };
      state.shortlist = scenario.expectedShortlistIds.map(personId => ({ personId, rationale: 'Relevant dinner guest', evidenceIds: ['source-1'] }));
      state.sponsorEvidence = [{ id: 'usage-1', sponsorId: 'neon', operationId: 'db-write-1', evidenceId: 'receipt-db-1', costUsd: 0, costSource: 'provider', kind: 'database' }];
    },
    async waitFor() { invoked.push('waitFor'); },
    async inspect() {
      invoked.push('inspect');
      if (leak && state.receipts.length === 0) state.receipts.push({ id: 'leak', proposalId: 'proposal-1', proposalVersion: 1, payloadDigest: 'digest-1', recipient: scenario.recipient });
      return structuredClone(state);
    },
    async steerSelection(ids) { invoked.push('steerSelection'); state.selectedPersonIds = [...ids]; },
    async fetchReply(receiptId) { invoked.push('fetchReply'); state.replies = [{ id: 'reply-1', inReplyToReceiptId: receiptId, evidenceId: 'reply-source-1' }]; },
    async readEvidence(id) {
      invoked.push('readEvidence');
      if (id === 'receipt-db-1') return { operationId: fakeSponsor ? 'unrelated-operation' : 'db-write-1', sponsorId: 'neon', costUsd: 0, costSource: 'provider' };
      return { id, source: 'synthetic-fixture' };
    },
    async capturePage({ id }) { invoked.push('capturePage'); return { evidenceId: `png-${id}`, png: Buffer.from([137,80,78,71,13,10,26,10]) }; },
    async induceUnknownSendOutcome() { invoked.push('induceUnknownSendOutcome'); state.delivery = { status: 'unknown', dispatchAttempts: 1 }; },
    async editProposal(id, body) {
      invoked.push('editProposal');
      assert.equal(id, state.proposal.id);
      state.proposal = { ...state.proposal, body, version: 2, digest: 'digest-2', status: 'pending' };
    },
    async approve(binding) {
      invoked.push('approve');
      const p = state.proposal;
      if (state.delivery?.status === 'unknown') { if (retryUnknown) state.delivery.dispatchAttempts++; return { accepted: false }; }
      const matches = binding.proposalId === p.id && binding.version === p.version && binding.digest === p.digest;
      if (!matches && !staleAccepted) return { accepted: false };
      if (state.receipts.length === 0) state.receipts.push({ id: 'send-1', proposalId: p.id, proposalVersion: p.version, payloadDigest: p.digest, recipient: wrongRecipient ? 'wrong@example.invalid' : scenario.recipient });
      state.goal.status = 'complete';
      state.proposal.status = 'approved';
      state.outcome = 'sent once';
      return { accepted: true };
    },
    async restart() { invoked.push('restart'); if (forget) state.goal = null; },
  };
}

test('absent app driver and missing screenshot evidence never pass', async () => {
  const report = await runAcceptance({ scenario, environment });
  assert.equal(report.capability.status, 'unverified');
  assert.equal(report.comprehension.status, 'unverified');
  assert.equal(report.accepted, false);
  assert.ok(report.capability.cases.every(c => c.status === 'unverified'));
});

test('drives app operations and retains distinct fixture capability/comprehension results', async () => {
  const adapter = fixtureDriver();
  const report = await runAcceptance({ adapter, scenario, environment });
  assert.equal(report.capability.status, 'pass');
  assert.equal(report.comprehension.status, 'unverified');
  assert.equal(report.accepted, false);
  assert.equal(report.environment.kind, 'fixture');
  assert.ok(adapter.invoked.includes('editProposal'));
  assert.ok(adapter.invoked.includes('restart'));
  assert.equal(adapter.invoked.filter(v => v.startsWith('reset:')).length, 7);
  assert.deepEqual(report.capability.cases.map(c => c.id), ['full-journey', 'approval-no-send', 'approval-edited', 'approval-stale', 'restart-idempotence', 'unknown-send-outcome', 'sponsor-evidence']);
});

test('detects unauthorized delivery, accepted stale approval and lost restart state', async () => {
  for (const options of [{ leak: true }, { staleAccepted: true }, { forget: true }]) {
    const report = await runAcceptance({ adapter: fixtureDriver(options), scenario, environment });
    assert.equal(report.capability.status, 'fail');
    assert.equal(report.accepted, false);
  }
});

test('incomplete evidence and unsupported adapter methods remain unverified', async () => {
  const adapter = fixtureDriver();
  delete adapter.restart;
  const report = await runAcceptance({ adapter, scenario: { ...scenario, requiredSponsors: [] }, environment });
  assert.equal(report.capability.status, 'unverified');
  assert.equal(report.capability.cases.find(c => c.id === 'restart-idempotence').status, 'unverified');
  assert.equal(report.capability.cases.find(c => c.id === 'sponsor-evidence').status, 'unverified');
});

test('detects blind resend after receipt loss, wrong recipient and unrelated sponsor evidence', async () => {
  for (const options of [{ retryUnknown: true }, { wrongRecipient: true }, { fakeSponsor: true }]) {
    const report = await runAcceptance({ adapter: fixtureDriver(options), scenario, environment });
    assert.equal(report.capability.status, 'fail');
    assert.equal(report.accepted, false);
  }
});

test('live report cannot perform receipt-loss injection on a real recipient', async () => {
  const adapter = fixtureDriver();
  const report = await runAcceptance({ adapter, scenario, environment: { ...environment, kind: 'live' } });
  assert.equal(adapter.invoked.includes('induceUnknownSendOutcome'), false);
  assert.equal(report.capability.cases.find(c => c.id === 'unknown-send-outcome').status, 'unverified');
  assert.equal(report.accepted, false);
});

test('no proof can promote fixture observations to live launch acceptance', async () => {
  const report = await runAcceptance({ adapter: fixtureDriver(), scenario, environment, provider: { complete: async () => JSON.stringify({ job: 'Review invitation', visible_state: 'Awaiting approval', next_step: 'Review the draft', lois_was_sane: true, browser_state_clear: true, choices_visible: 1, confusing: [], verdict: 'swims' }) } });
  assert.equal(report.accepted, true);
  assert.equal(report.liveAccepted, false);
});

test('whole-page reports attach only their own provider usage evidence, including sanitized failed calls', async () => {
  let observed, calls = 0;
  const provider = {
    latestEvidence: () => observed,
    async complete() {
      calls += 1;
      observed = { id: `fixture-call-${calls}`, status: calls === 1 ? 'complete' : 'http_error', costUsd: null, costSource: 'unknown' };
      if (calls === 2) throw new Error('Goldfish provider http_error.');
      return JSON.stringify({ job: 'Review invitation', visible_state: 'Pending', next_step: 'Review', lois_was_sane: true, browser_state_clear: true, choices_visible: 1, confusing: [], verdict: 'swims' });
    },
  };
  const report = await runAcceptance({ adapter: fixtureDriver(), scenario, environment, provider });
  assert.equal(report.comprehension.pages[0].providerEvidence.id, 'fixture-call-1');
  assert.equal(report.comprehension.pages[1].providerEvidence.id, 'fixture-call-2');
  assert.equal(report.comprehension.pages[1].providerEvidence.costUsd, null);
  assert.equal(report.comprehension.pages[1].status, 'fail'); assert.equal(report.accepted, false);
});
