import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePage } from './goldfish.mjs';

const png = Buffer.from([137,80,78,71,13,10,26,10]);
const good = { job: 'Review invitation', visible_state: 'Awaiting approval', next_step: 'Review draft', lois_was_sane: true, browser_state_clear: true, choices_visible: 1, confusing: [], verdict: 'swims' };

test('each page read supplies only PNG and tiny brief to one fresh provider call', async () => {
  const calls = [];
  const provider = { complete: async input => { calls.push(input); return JSON.stringify(good); } };
  await evaluatePage({ provider, screenshot: png, brief: 'Prepare one invitation.' });
  await evaluatePage({ provider, screenshot: png, brief: 'Review the result.' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].images, [{ data: png, mediaType: 'image/png' }]);
  assert.equal(calls[0].user, 'Tiny job brief: Prepare one invitation.');
  assert.equal('messages' in calls[0], false);
  assert.equal('trace' in calls[0], false);
  assert.match(calls[0].system, /visible pixels/);
});

test('refuses malformed evidence and non-PNG data before provider dispatch', async () => {
  let called = false;
  const provider = { complete: async () => { called = true; return '{}'; } };
  await assert.rejects(evaluatePage({ provider, screenshot: Buffer.from('text'), brief: 'A job' }), /PNG/);
  assert.equal(called, false);
  await assert.rejects(evaluatePage({ provider, screenshot: png, brief: 'A job' }), /invalid.*evidence/i);
});

test('contradictory pass verdict cannot hide a failed state or confusion', async () => {
  const provider = { complete: async () => JSON.stringify({ ...good, confusing: ['Cannot tell whether anything was sent.'] }) };
  const result = await evaluatePage({ provider, screenshot: png, brief: 'A job' });
  assert.equal(result.verdict, 'sinks');
});
