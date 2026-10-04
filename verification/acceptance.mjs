import assert from 'node:assert/strict';
import { evaluatePage } from './goldfish.mjs';

export class Unverified extends Error {}
const CASE_IDS = ['full-journey', 'approval-no-send', 'approval-edited', 'approval-stale', 'restart-idempotence', 'unknown-send-outcome', 'sponsor-evidence'];
const PAGES = ['review', 'complete'];

function requireEvidence(condition, why) { if (!condition) throw new Unverified(why); }
function binding(proposal) { return { proposalId: proposal.id, version: proposal.version, digest: proposal.digest }; }
function aggregate(cases) {
  return cases.some(c => c.status === 'fail') ? 'fail' : cases.length && cases.every(c => c.status === 'pass') ? 'pass' : 'unverified';
}

/** The adapter performs ordinary app actions and reads host-backed projections/receipts.
 * It is not a manifest grader. No adapter, unsupported operations and missing evidence fail acceptance. */
export async function runAcceptance({ adapter, scenario = {}, environment = {}, provider } = {}) {
  const cases = [];
  const pages = [];
  const call = async (method, ...args) => {
    requireEvidence(typeof adapter?.[method] === 'function', `App adapter does not implement ${method}.`);
    return adapter[method](...args);
  };
  const inspect = async () => {
    const state = await call('inspect');
    requireEvidence(state && Array.isArray(state.receipts), 'App did not expose its actual delivery receipts.');
    return state;
  };
  const pending = async () => {
    await call('startGoal', scenario.goal);
    await call('waitFor', 'review');
    const state = await inspect();
    requireEvidence(state.goal?.id && state.proposal?.id && Number.isInteger(state.proposal.version)
      && state.proposal.digest && typeof state.proposal.body === 'string', 'App lacks a persisted goal or reviewable proposal binding.');
    assert.equal(state.proposal.status, 'pending', 'A new proposal must be pending approval.');
    assert.equal(state.receipts.length, 0, 'Nothing may be delivered before approval.');
    return state;
  };
  const finish = async (prior) => {
    await call('approve', binding(prior.proposal));
    await call('waitFor', 'complete');
    const state = await inspect();
    assert.equal(state.goal?.id, prior.goal.id, 'Completion belongs to the started goal.');
    assert.equal(state.goal.status, 'complete', 'The app must settle its goal.');
    assert.equal(state.receipts.length, 1, 'Exactly one delivery receipt is required.');
    const receipt = state.receipts[0];
    requireEvidence(receipt.id && receipt.proposalId && Number.isInteger(receipt.proposalVersion)
      && receipt.payloadDigest, 'Delivery receipt lacks persisted identity and payload binding.');
    assert.equal(receipt.proposalId, prior.proposal.id);
    assert.equal(receipt.proposalVersion, prior.proposal.version);
    assert.equal(receipt.payloadDigest, prior.proposal.digest, 'Delivery must use the approved words.');
    requireEvidence(typeof scenario.recipient === 'string' && scenario.recipient.trim(), 'Configure the controlled demo recipient.');
    assert.equal(receipt.recipient, scenario.recipient, 'Delivery must target only the configured demo recipient.');
    return state;
  };
  const readPage = async (id, brief) => {
    if (!provider) { pages.push({ id, status: 'unverified', reason: 'No model provider configured; no inference called.' }); return; }
    const priorRequestId = provider.latestEvidence?.()?.id;
    const requestEvidence = () => {
      const observed = provider.latestEvidence?.();
      return observed && observed.id !== priorRequestId ? { providerEvidence: observed } : {};
    };
    try {
      const capture = await call('capturePage', { id });
      requireEvidence(capture?.evidenceId, 'Whole-page PNG must have an evidence ID.');
      const verdict = await evaluatePage({ provider, screenshot: capture.png, brief });
      pages.push({ id, status: verdict.verdict === 'swims' ? 'pass' : 'fail', evidenceId: capture.evidenceId, verdict, ...requestEvidence() });
    } catch (error) {
      pages.push({ id, status: error instanceof Unverified ? 'unverified' : 'fail', reason: error.message, ...requestEvidence() });
    }
  };
  const checks = {
    async 'full-journey'() {
      requireEvidence(scenario.expectedOutcome !== undefined, 'Declare the goal outcome independently of the app.');
      requireEvidence(Array.isArray(scenario.expectedShortlistIds) && scenario.expectedShortlistIds.length
        && Array.isArray(scenario.selectedPersonIds) && scenario.selectedPersonIds.length, 'Declare expected shortlist and organizer-selected person IDs.');
      const initial = await pending();
      requireEvidence(Array.isArray(initial.shortlist), 'App did not expose the sourced shortlist.');
      assert.deepEqual(initial.shortlist.map(person => person.personId).sort(), [...scenario.expectedShortlistIds].sort());
      for (const person of initial.shortlist) {
        requireEvidence(person.rationale?.trim() && Array.isArray(person.evidenceIds) && person.evidenceIds.length,
          'Every shortlisted person needs a visible rationale and source evidence.');
        for (const evidenceId of person.evidenceIds) requireEvidence(await call('readEvidence', evidenceId), `Missing shortlist source ${evidenceId}.`);
      }
      await call('steerSelection', scenario.selectedPersonIds);
      const steered = await inspect();
      assert.deepEqual(steered.selectedPersonIds, scenario.selectedPersonIds, 'The saved guest selection must reflect organizer steering.');
      assert.equal(steered.receipts.length, 0, 'Steering cannot authorize delivery.');
      await readPage('review', 'Understand the proposed work and review it before authorizing delivery.');
      const complete = await finish(steered);
      assert.deepEqual(complete.outcome, scenario.expectedOutcome, 'The delivered outcome must match the declared task.');
      await call('fetchReply', complete.receipts[0].id);
      const replied = await inspect();
      requireEvidence(Array.isArray(replied.replies) && replied.replies.length, 'App did not fetch an actual reply.');
      const reply = replied.replies.find(r => r.inReplyToReceiptId === complete.receipts[0].id);
      requireEvidence(reply?.id && reply.evidenceId, 'Reply must link to the delivery receipt and source evidence.');
      requireEvidence(await call('readEvidence', reply.evidenceId), 'Reply source evidence is unavailable.');
      await call('restart');
      const restored = await inspect();
      assert.equal(restored.goal?.id, complete.goal.id);
      assert.deepEqual(restored.receipts, complete.receipts, 'Restart must preserve the approved send receipt.');
      assert.deepEqual(restored.replies, replied.replies, 'Restart must preserve the fetched reply.');
      assert.deepEqual(restored.selectedPersonIds, scenario.selectedPersonIds);
      assert.deepEqual(restored.proposal, replied.proposal, 'Restart must preserve the exact approved proposal.');
      await readPage('complete', 'Understand what completed and whether anything remains to do.');
      return { goalId: complete.goal.id, selectedPersonIds: scenario.selectedPersonIds, receiptIds: complete.receipts.map(r => r.id), replyIds: replied.replies.map(r => r.id) };
    },
    async 'approval-no-send'() {
      const before = await pending();
      await call('restart');
      const after = await inspect();
      assert.equal(after.receipts.length, 0, 'Restart cannot release unapproved work.');
      assert.equal(after.goal?.id, before.goal.id, 'Restart must retain the pending goal.');
      assert.deepEqual(after.proposal, before.proposal, 'Restart must retain the exact held proposal.');
      return { goalId: before.goal.id, proposalId: before.proposal.id, receiptIds: [] };
    },
    async 'approval-edited'() {
      requireEvidence(typeof scenario.editedText === 'string' && scenario.editedText.trim(), 'Declare replacement words.');
      const before = await pending();
      await call('editProposal', before.proposal.id, scenario.editedText);
      const edited = await inspect();
      assert.equal(edited.proposal?.body, scenario.editedText, 'The reviewed proposal must show the edit.');
      assert.notEqual(edited.proposal.version, before.proposal.version, 'Editing invalidates the old version.');
      assert.notEqual(edited.proposal.digest, before.proposal.digest, 'Editing changes the approved payload binding.');
      assert.equal(edited.receipts.length, 0, 'Editing does not authorize delivery.');
      const complete = await finish(edited);
      return { proposalId: edited.proposal.id, version: edited.proposal.version, receiptIds: complete.receipts.map(r => r.id) };
    },
    async 'approval-stale'() {
      requireEvidence(typeof scenario.editedText === 'string' && scenario.editedText.trim(), 'Declare replacement words.');
      const before = await pending();
      await call('editProposal', before.proposal.id, scenario.editedText);
      await call('restart');
      await call('approve', binding(before.proposal));
      const after = await inspect();
      assert.equal(after.receipts.length, 0, 'A stale approval must not deliver, including after restart.');
      assert.equal(after.proposal?.status, 'pending', 'Stale approval cannot authorize the replacement proposal.');
      return { rejectedVersion: before.proposal.version, receiptIds: [] };
    },
    async 'restart-idempotence'() {
      const before = await pending();
      const complete = await finish(before);
      await call('restart');
      await call('approve', binding(before.proposal));
      const after = await inspect();
      assert.equal(after.goal?.id, complete.goal.id, 'Restart must preserve goal identity.');
      assert.equal(after.goal.status, 'complete', 'Restart must preserve completion.');
      assert.deepEqual(after.receipts, complete.receipts, 'Replayed approval must not duplicate delivery.');
      assert.deepEqual(after.outcome, complete.outcome, 'Restart must preserve the actual outcome.');
      return { goalId: after.goal.id, receiptIds: after.receipts.map(r => r.id) };
    },
    async 'unknown-send-outcome'() {
      requireEvidence(environment.kind === 'fixture', 'Receipt-loss injection belongs to an isolated fixture transport, not a live recipient.');
      const before = await pending();
      await call('induceUnknownSendOutcome', binding(before.proposal));
      const unknown = await inspect();
      requireEvidence(Number.isInteger(unknown.delivery?.dispatchAttempts), 'The transport must expose observed dispatch attempts.');
      assert.equal(unknown.delivery.status, 'unknown', 'Receipt loss must remain an unknown outcome.');
      assert.equal(unknown.delivery.dispatchAttempts, 1);
      assert.equal(unknown.receipts.length, 0, 'An unknown outcome cannot manufacture a completed receipt.');
      await call('restart');
      await call('approve', binding(before.proposal));
      const after = await inspect();
      assert.equal(after.delivery?.status, 'unknown');
      assert.equal(after.delivery.dispatchAttempts, 1, 'Restart or repeated approval must not blindly resend an unknown delivery.');
      assert.equal(after.receipts.length, 0);
      return { goalId: before.goal.id, dispatchAttempts: after.delivery.dispatchAttempts, outcome: 'unknown' };
    },
    async 'sponsor-evidence'() {
      requireEvidence(Array.isArray(scenario.requiredSponsors) && scenario.requiredSponsors.length, 'Declare required sponsor IDs.');
      await pending();
      const state = await inspect();
      requireEvidence(Array.isArray(state.sponsorEvidence) && state.sponsorEvidence.length, 'App has no sponsor-operation evidence.');
      const ids = new Set(), operations = new Set(), evidenceIds = new Set();
      for (const record of state.sponsorEvidence) {
        requireEvidence(record.id && record.sponsorId && record.operationId && record.evidenceId, 'Sponsor operation lacks linked IDs.');
        assert.ok(!ids.has(record.id), 'Sponsor evidence IDs must be unique.'); ids.add(record.id);
        assert.ok(!operations.has(record.operationId), 'Sponsor operations cannot be counted twice.'); operations.add(record.operationId);
        assert.ok(!evidenceIds.has(record.evidenceId), 'Sponsor evidence cannot be counted twice.'); evidenceIds.add(record.evidenceId);
        requireEvidence(Number.isFinite(record.costUsd) && record.costUsd >= 0 && record.costSource === 'provider', 'Sponsor cost must be measured/provider reported, including explicit zero.');
        const witness = await call('readEvidence', record.evidenceId);
        requireEvidence(witness, 'Sponsor operation evidence cannot be resolved.');
        assert.equal(witness.operationId, record.operationId);
        assert.equal(witness.sponsorId, record.sponsorId);
        assert.equal(witness.costUsd, record.costUsd);
        assert.equal(witness.costSource, 'provider', 'Sponsor witness must support the recorded actual cost.');
        if (record.kind === 'model') requireEvidence(witness.model && Number.isInteger(witness.inputTokens)
          && witness.inputTokens >= 0 && Number.isInteger(witness.outputTokens) && witness.outputTokens >= 0, 'Model evidence requires model identity and provider token usage.');
      }
      for (const id of scenario.requiredSponsors) assert.ok(state.sponsorEvidence.some(r => r.sponsorId === id), `No observed operation for sponsor ${id}.`);
      return { evidence: state.sponsorEvidence, costUsd: state.sponsorEvidence.reduce((sum, r) => sum + r.costUsd, 0) };
    },
  };
  for (const id of CASE_IDS) {
    try {
      requireEvidence(['fixture', 'live'].includes(environment.kind) && environment.revision, 'Label the environment fixture/live and pin its app revision.');
      requireEvidence(typeof scenario.goal === 'string' && scenario.goal.trim(), 'Declare the task goal.');
      await call('reset', { caseId: id });
      const evidence = await checks[id]();
      cases.push({ id, status: 'pass', evidence });
    } catch (error) {
      cases.push({ id, status: error instanceof Unverified ? 'unverified' : 'fail', reason: error.message });
    }
  }
  for (const id of PAGES) if (!pages.some(page => page.id === id)) pages.push({ id, status: 'unverified', reason: 'The journey did not reach this whole-page capture.' });
  const capability = { status: aggregate(cases), cases };
  const comprehension = { status: aggregate(pages), pages };
  const accepted = capability.status === 'pass' && comprehension.status === 'pass';
  return { schemaVersion: 1, environment, capability, comprehension, accepted, liveAccepted: accepted && environment.kind === 'live' };
}
