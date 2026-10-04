// Local-only child-process fixture for the real app approval ledger.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalLedger } from '../sidecar/neon/ledger.ts';

const { dir, payload, auth, mode } = JSON.parse(process.argv[2]);
const ledger = new ApprovalLedger(dir);
process.send?.({ event: 'ready' });
await new Promise(resolve => process.once('message', resolve));
try {
  const result = mode === 'prepare' ? ledger.prepare(payload) : await ledger.run(payload, auth, async () => {
    appendFileSync(join(dir, 'dispatches.jsonl'), JSON.stringify({ pid: process.pid }) + '\n');
    process.send?.({ event: 'dispatch' });
    if (mode === 'hold-send') await new Promise(resolve => process.once('message', resolve));
    return { id: 'fixture-receipt' };
  });
  process.send?.({ event: 'result', ok: true, result });
} catch (error) {
  process.send?.({ event: 'result', ok: false, reason: error.message });
}
process.disconnect();
