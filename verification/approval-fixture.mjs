// Actual app ledger/state/connectors with a local fixture-only AgentMail port.
// This proves the approval joint, not the model, shortlist, UI or live provider.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { Unverified } from './acceptance.mjs';

const { ApprovalLedger } = await tsImport('../sidecar/neon/ledger.ts', import.meta.url);
const { LaunchState } = await tsImport('../sidecar/neon/state.ts', import.meta.url);
const { createConnectors } = await tsImport('../integrations/connectors/index.ts', import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));

export async function createAdapter({ scenario }) {
  if (!scenario.recipient?.endsWith('.invalid')) throw new Error('This adapter requires an invented .invalid fixture recipient.');
  const envelope = { operation: 'send_email', provider: 'agentmail', userId: 'fixture-operator', accountId: 'fixture-inbox@agentmail.invalid', to: [scenario.recipient], subject: 'Fixture dinner', body: 'One locally held fixture invitation.' };
  const base = mkdtempSync(join(tmpdir(), 'neon-approval-fixture-'));
  let directory, currentCase, ledger, state, connectors, loseReceipt = false;
  const dispatches = () => {
    const path = join(directory, 'fixture-dispatches.jsonl');
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  const reopen = () => {
    ledger = new ApprovalLedger(directory);
    state = new LaunchState(directory);
    connectors = createConnectors({ userId: envelope.userId, agentMailInboxId: envelope.accountId, approval: ledger, agentmail: {
      async sendMessage(inboxId, payload) {
        const messageId = randomUUID();
        appendFileSync(join(directory, 'fixture-dispatches.jsonl'), JSON.stringify({ messageId, inboxId, payload }) + '\n', { mode: 0o600 });
        if (loseReceipt) throw new Error('Fixture lost provider receipt after accepting delivery.');
        return { messageId, threadId: `fixture-${messageId}` };
      },
    } });
  };
  const inspect = () => {
    const stored = ledger.inspect(), app = state.read(), drafts = Object.values(stored.drafts);
    const current = drafts.filter(draft => !draft.revokedAt).at(-1);
    const version = draft => drafts.findIndex(candidate => candidate.id === draft.id) + 1;
    const operations = Object.values(stored.operations);
    const receipts = operations.filter(op => op.state === 'complete').map(op => {
      const approval = stored.approvals[op.approvalId], draft = stored.drafts[approval.draftId];
      return { id: op.receipt.messageId, proposalId: draft.id, proposalVersion: version(draft), payloadDigest: op.hash, recipient: draft.payload.to[0] };
    });
    const uncertain = operations.some(op => op.state !== 'complete');
    return {
      goal: app.goal && { id: app.goal.id, status: receipts.length ? 'complete' : 'review' },
      proposal: current && { id: current.id, version: version(current), digest: current.hash, body: current.payload.body, status: current.approvalId ? 'approved' : 'pending' },
      receipts, shortlist: app.shortlist, selectedPersonIds: app.selectedPersonIds, replies: [],
      outcome: { invitesSent: receipts.length, recipient: receipts.length === 1 ? receipts[0].recipient : null },
      delivery: { status: uncertain ? 'unknown' : receipts.length ? 'complete' : 'not-started', dispatchAttempts: dispatches().length },
      sponsorEvidence: [],
    };
  };
  const approve = async binding => {
    try {
      const draft = ledger.inspect().drafts[binding.proposalId];
      const approval = ledger.approve(binding.proposalId, binding.digest);
      await connectors.sendPrepared(draft.payload, { approvalId: approval.id, idempotencyKey: draft.id });
      return { accepted: true };
    } catch (error) {
      if (/revoked|changed|invalid approval|uncertain|consumed|no longer exists/.test(error.message)) return { accepted: false, reason: error.message };
      throw error;
    }
  };
  const adapter = {
    async reset({ caseId }) {
      if (!/^[a-z][a-z0-9-]{1,60}$/.test(caseId)) throw new Error('Invalid fixture case ID.');
      currentCase = caseId; directory = join(base, caseId); loseReceipt = false;
      rmSync(directory, { recursive: true, force: true }); reopen();
    },
    async startGoal(goal) {
      if (['full-journey', 'sponsor-evidence'].includes(currentCase)) throw new Unverified('Approval component fixture does not exercise model research, real sponsor operations, or the app journey.');
      state.setGoal(goal);
      const prepared = await connectors.prepareSend(envelope);
      ledger.prepare(prepared);
    },
    async waitFor(expected) {
      if (inspect().goal?.status !== expected) throw new Error(`App ledger did not reach ${expected}.`);
    },
    async inspect() { return inspect(); },
    async editProposal(id, body) {
      const stored = ledger.inspect();
      if (!Object.hasOwn(stored.drafts, id)) throw new Error('Unknown fixture proposal.');
      const prepared = await connectors.prepareSend({ ...stored.drafts[id].payload, body });
      ledger.replace(id, prepared);
    },
    approve,
    async restart() { reopen(); },
    async induceUnknownSendOutcome(binding) {
      loseReceipt = true;
      try { await approve(binding); } catch (error) { if (inspect().delivery.status !== 'unknown') throw error; }
      finally { loseReceipt = false; }
    },
    async close() { rmSync(base, { recursive: true, force: true }); },
  };
  const hash = createHash('sha256');
  for (const path of ['sidecar/neon/ledger.ts', 'sidecar/neon/state.ts', 'integrations/connectors/index.ts']) hash.update(readFileSync(join(root, path)));
  return { adapter, environment: { kind: 'fixture', revision: `source-sha256:${hash.digest('hex')}`, scope: 'approval-components', boundaries: { ledger: 'real', state: 'real', connectors: 'real', delivery: 'fixture', model: 'unverified', ui: 'unverified', sponsors: 'unverified' } } };
}
