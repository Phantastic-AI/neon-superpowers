import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const { ApprovalLedger } = await tsImport('../sidecar/neon/ledger.ts', import.meta.url);
const payload = { provider: 'fixture', account: 'isolated-inbox', to: 'controlled@example.invalid', subject: 'Dinner', body: 'Join us?' };
const helper = fileURLToPath(new URL('./ledger-child.mjs', import.meta.url));

function child(config) {
  const worker = fork(helper, [JSON.stringify(config)], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const received = [], waiters = [];
  let stderr = '';
  worker.stderr.on('data', chunk => { stderr += chunk; });
  worker.on('message', message => {
    received.push(message);
    for (const waiter of [...waiters]) if (message.event === waiter.event) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message); }
  });
  worker.on('error', error => { for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); } });
  const exited = new Promise(resolve => worker.once('exit', (code, signal) => {
    for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error(`Ledger fixture child exited ${code}/${signal}: ${stderr}`)); }
    resolve({ code, signal });
  }));
  return {
    worker, exited,
    wait(event) {
      const already = received.find(message => message.event === event);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const waiter = { event, resolve, reject, timer: undefined };
        waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`Timed out waiting for ledger child ${event}: ${stderr}`)); }, 10_000);
        waiters.push(waiter);
      });
    },
    start() { worker.send({ event: 'start' }); },
    release() { worker.send({ event: 'release' }); },
  };
}

async function scope(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'neon-ledger-process-proof-'));
  const workers = [];
  try { await fn(dir, config => { const item = child({ dir, payload, ...config }); workers.push(item); return item; }); }
  finally {
    for (const item of workers) if (item.worker.exitCode === null && item.worker.signalCode === null) item.worker.kill('SIGKILL');
    await Promise.all(workers.map(item => item.exited));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('separate processes cannot dispatch the same reserved approval twice', { timeout: 20_000 }, async () => scope(async (dir, spawn) => {
  const ledger = new ApprovalLedger(dir), draft = ledger.prepare(payload);
  const auth = { approvalId: ledger.approve(draft.id, draft.hash).id, idempotencyKey: 'same-send' };
  const first = spawn({ auth, mode: 'hold-send' });
  await first.wait('ready'); first.start(); await first.wait('dispatch');
  const second = spawn({ auth, mode: 'send' });
  await second.wait('ready'); second.start();
  const refusal = await second.wait('result');
  assert.equal(refusal.ok, false); assert.match(refusal.reason, /uncertain/);
  first.release(); assert.equal((await first.wait('result')).ok, true);
  await Promise.all([first.exited, second.exited]);
  assert.equal(readFileSync(join(dir, 'dispatches.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.equal(Object.values(new ApprovalLedger(dir).inspect().operations)[0].state, 'complete');
}));

test('killed dispatch process leaves a durable reservation that refuses automatic resend', { timeout: 20_000 }, async () => scope(async (dir, spawn) => {
  const ledger = new ApprovalLedger(dir), draft = ledger.prepare(payload);
  const auth = { approvalId: ledger.approve(draft.id, draft.hash).id, idempotencyKey: 'lost-receipt' };
  const first = spawn({ auth, mode: 'hold-send' });
  await first.wait('ready'); first.start(); await first.wait('dispatch');
  first.worker.kill('SIGKILL'); await first.exited;
  const restarted = spawn({ auth, mode: 'send' });
  await restarted.wait('ready'); restarted.start();
  const refusal = await restarted.wait('result');
  assert.equal(refusal.ok, false); assert.match(refusal.reason, /uncertain/);
  await restarted.exited;
  assert.equal(readFileSync(join(dir, 'dispatches.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.equal(Object.values(new ApprovalLedger(dir).inspect().operations)[0].state, 'reserved');
}));

test('concurrent process mutations retain every successfully committed draft', { timeout: 20_000 }, async () => scope(async (dir, spawn) => {
  const workers = Array.from({ length: 4 }, () => spawn({ mode: 'prepare' }));
  await Promise.all(workers.map(worker => worker.wait('ready')));
  workers.forEach(worker => worker.start());
  const results = await Promise.all(workers.map(worker => worker.wait('result')));
  await Promise.all(workers.map(worker => worker.exited));
  const successes = results.filter(result => result.ok).map(result => result.result.id).sort();
  assert.ok(successes.length > 0);
  for (const rejected of results.filter(result => !result.ok)) assert.match(rejected.reason, /EEXIST/);
  assert.deepEqual(Object.keys(new ApprovalLedger(dir).inspect().drafts).sort(), successes);
}));
