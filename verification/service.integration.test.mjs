import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { tsImport } from 'tsx/esm/api';

const { createNeonService } = await tsImport('../sidecar/neon/server.ts', import.meta.url);
const { createConnectors } = await tsImport('../integrations/connectors/index.ts', import.meta.url);
const { openVault, registerContext } = await tsImport('../packages/vault/store.ts', import.meta.url);
const { loadWorld } = await tsImport('../packages/vault/world.ts', import.meta.url);
const { importPeopleSource, selectPeopleSources } = await tsImport('../packages/organs/people.ts', import.meta.url);

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'neon-service-proof-'));
  const vaultDirectory = join(root, 'vault'), directory = join(root, 'service');
  const vault = openVault(vaultDirectory), scope = { contextId: 'fixture-world', viewId: 'fixture-dinners' };
  const source = { platform: 'luma', accountId: 'fixture-organizer', eventId: 'fixture-event' };
  registerContext(vault, { id: scope.contextId, name: 'Invented dinner world', kind: 'social', anchor: 'email', created_at: '2026-09-05T12:00:00Z' });
  selectPeopleSources(vault, { ...scope, viewName: 'Invented dinners', discoveryComplete: false, sources: [{ ...source, name: 'Fixture event', date: '2026-08-31', url: 'https://fixture.invalid/event', evidence: ['fixture:observation'] }] });
  const imported = importPeopleSource(vault, { ...scope, source, readState: 'read', evidence: ['fixture:artifact'], rows: ['Fixture Avery', 'Fixture Riley'].map(name => ({ rowId: name, name, evidence: ['fixture:artifact'] })) });
  const personIds = imported.people.map(p => p.personId), dispatches = [];
  let server, base, receiptLoss = false, connectorInitializations = 0;
  const env = { NEON_DEMO_RECIPIENT: 'controlled@example.invalid', COMPOSIO_USER_ID: 'fixture-user' };
  const start = async () => {
    server = createNeonService({ directory, vaultDirectory, env, ready: () => true, world: () => loadWorld(openVault(vaultDirectory)),
      async connectorsFactory({ userId, approval }) {
        connectorInitializations += 1;
        return createConnectors({ userId, approval, agentMailInboxId: 'fixture-inbox', agentmail: {
          async sendMessage(inboxId, payload) {
            const receipt = { messageId: `fixture-send-${dispatches.length + 1}` };
            dispatches.push({ inboxId, payload: structuredClone(payload), receipt });
            if (receiptLoss) throw new Error('Fixture transport accepted send but lost receipt.');
            return receipt;
          },
        } });
      },
      async runtimeFactory() { throw new Error('This fixture must never initialize a model.'); },
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => {
    if (!server?.listening) return;
    await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  };
  const wire = (path, { method = 'GET', input, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers: { Host: 'localhost:5299', ...(method !== 'GET' ? { Origin: 'http://localhost:5299', 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.end(input === undefined ? undefined : JSON.stringify(input));
  });
  const prepare = async () => {
    const tool = async (id, input) => server.neon.capabilities().find(t => t.id === id).execute(input, {});
    const people = (await tool('read_local_people', {})).people;
    await tool('set_goal', { text: 'Prepare an invented dinner invitation.' });
    await tool('set_shortlist', { people: people.map(p => ({ personId: p.id, rationale: 'This invented person has a local source record.', sources: p.sources })) });
    await tool('select_people', { personIds: [personIds[0]] });
    return tool('prepare_invitation', { provider: 'agentmail', subject: 'Fixture invitation', body: 'Original fixture words.' });
  };
  await start();
  return { scope, personIds, dispatches, wire, prepare, get server() { return server; }, get connectorInitializations() { return connectorInitializations; },
    setReceiptLoss(value) { receiptLoss = value; }, async restart() { await stop(); await start(); },
    async close() { await stop(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('real HTTP approval routes bind edited payload, refuse invalid approval and replay one stored receipt after restart', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.wire('/api/neon/status')).status, 200);
    assert.equal(f.connectorInitializations, 0, 'status must remain cold');
    const original = await f.prepare(), approvalPath = id => `/api/neon/approvals/${id}`;
    assert.equal((await f.wire(approvalPath(original.id), { method: 'POST', input: { hash: original.hash }, headers: { Origin: '' } })).status, 403);
    assert.equal((await f.wire(approvalPath(original.id), { method: 'POST', input: { hash: '0'.repeat(64) } })).status, 409);
    assert.equal((await f.wire(approvalPath(original.id), { method: 'POST', input: { hash: original.hash, body: 'Unreviewed words' } })).status, 400);
    assert.equal((await f.wire(`/api/neon/drafts/${original.id}`, { method: 'POST', input: { to: ['other@example.invalid'], subject: 'Fixture', body: 'Wrong recipient' } })).status, 409);
    const edit = await f.wire(`/api/neon/drafts/${original.id}`, { method: 'POST', input: { to: ['controlled@example.invalid'], subject: 'Edited fixture', body: 'Exact edited fixture words.' } });
    assert.equal(edit.status, 200); assert.notEqual(edit.body.hash, original.hash);
    assert.equal((await f.wire(approvalPath(original.id), { method: 'POST', input: { hash: original.hash } })).status, 409);
    assert.equal(f.dispatches.length, 0);
    const before = (await f.wire('/api/neon/status')).body;
    await f.restart();
    const reopened = (await f.wire('/api/neon/status')).body;
    assert.deepEqual(reopened.goal, before.goal); assert.deepEqual(reopened.selectedPersonIds, before.selectedPersonIds);
    assert.deepEqual(reopened.pending, before.pending); assert.equal(f.dispatches.length, 0);
    const sent = await f.wire(approvalPath(edit.body.id), { method: 'POST', input: { hash: edit.body.hash } });
    assert.equal(sent.status, 200); assert.equal(f.dispatches.length, 1);
    assert.deepEqual(f.dispatches[0].payload, { to: ['controlled@example.invalid'], subject: 'Edited fixture', text: 'Exact edited fixture words.' });
    await f.restart();
    const replay = await f.wire(approvalPath(edit.body.id), { method: 'POST', input: { hash: edit.body.hash } });
    assert.equal(replay.status, 200); assert.deepEqual(replay.body, sent.body); assert.equal(f.dispatches.length, 1);
    assert.equal((await f.wire(`/api/neon/drafts/${edit.body.id}`, { method: 'DELETE' })).status, 409);
    const status = (await f.wire('/api/neon/status')).body;
    assert.equal(status.receipts.filter(r => r.action === 'dispatch' && r.status === 'complete').length, 1);
  } finally { await f.close(); }
});

test('real HTTP unknown dispatch remains blocked through service restart and repeated approval', async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare(), path = `/api/neon/approvals/${draft.id}`, input = { hash: draft.hash };
    f.setReceiptLoss(true);
    assert.equal((await f.wire(path, { method: 'POST', input })).status, 409);
    assert.equal(f.dispatches.length, 1);
    assert.equal((await f.wire('/api/neon/status')).body.receipts[0].status, 'uncertain');
    await f.restart(); f.setReceiptLoss(false);
    assert.equal((await f.wire(path, { method: 'POST', input })).status, 409);
    assert.equal(f.dispatches.length, 1);
    assert.equal((await f.wire('/api/neon/status')).body.receipts[0].status, 'uncertain');
  } finally { await f.close(); }
});

test('real Neon people routes persist order, a Post-it and an immutable pending wave through restart without claiming a model reply', async () => {
  const f = await fixture();
  try {
    const path = '/api/neon/people-workspace', query = `?contextId=${f.scope.contextId}&viewId=${f.scope.viewId}`;
    const reversed = [...f.personIds].reverse();
    const order = await f.wire(`${path}/order`, { method: 'POST', input: { ...f.scope, requestId: 'fixture-order', personIds: reversed, baseRevision: 0 } });
    assert.equal(order.status, 200); assert.deepEqual(order.body.workspace.order, reversed);
    const note = { ...f.scope, requestId: 'fixture-note', noteId: 'fixture-post-it', personId: f.personIds[0], text: 'Move this invented guest later.', state: 'draft', baseRevision: 0 };
    assert.equal((await f.wire(`${path}/note`, { method: 'POST', input: note })).status, 200);
    const wave = await f.wire(`${path}/waves`, { method: 'POST', input: { ...f.scope, requestId: 'fixture-wave', noteIds: [note.noteId], baseRevision: 1 } });
    assert.equal(wave.status, 200); assert.equal(wave.body.result.status, 'pending');
    assert.equal((await f.wire(`${path}/note`, { method: 'POST', input: { ...note, requestId: 'fixture-edit-note', text: 'A newer draft.', baseRevision: 2 } })).status, 200);
    await f.restart();
    const read = await f.wire(`${path}${query}`);
    assert.equal(read.status, 200); assert.deepEqual(read.body.workspace.order, reversed);
    assert.equal(read.body.workspace.notes[0].text, 'A newer draft.');
    assert.equal(read.body.workspace.waves[0].notes[0].text, note.text);
    assert.equal(read.body.workspace.waves[0].status, 'pending');
    assert.equal(f.connectorInitializations, 0); assert.equal(f.dispatches.length, 0);
  } finally { await f.close(); }
});
