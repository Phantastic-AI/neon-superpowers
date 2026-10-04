import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createProvider } from './neon-goldfish-provider.mjs';
import { evaluatePage } from './goldfish.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const verdict = { job: 'Prepare a dinner', visible_state: 'Awaiting review', next_step: 'Review the draft', lois_was_sane: true, browser_state_clear: true, choices_visible: 1, confusing: [], verdict: 'swims' };
const env = { NEON_AI_GATEWAY_TOKEN: 'fixture-only-token', NEON_AI_GATEWAY_BASE_URL: 'https://fixture-branch.invalid', NEON_GOLDFISH_MODEL: 'fixture-vision' };
const responseBody = (content = JSON.stringify(verdict), usage = { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost_usd: 0.001 }) => ({ id: 'fixture-completion', model: 'fixture-vision', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }], usage });

async function fixture(reply = () => ({ status: 200, body: responseBody() })) {
  const requests = [], root = mkdtempSync(join(tmpdir(), 'neon-goldfish-http-'));
  const evidencePath = join(root, 'calls.jsonl');
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', data => chunks.push(data));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ path: req.url, method: req.method, headers: req.headers, body });
      const result = reply(requests.length);
      const send = () => { res.writeHead(result.status, { 'Content-Type': 'application/json', 'x-request-id': `fixture-request-${requests.length}` }); res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body)); };
      if (result.delay) setTimeout(send, result.delay); else send();
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = (url, options) => {
    assert.equal(url, 'https://fixture-branch.invalid/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    return fetch(`${base}/v1/chat/completions`, options);
  };
  return { requests, evidencePath, provider: createProvider({ env, ready: () => true, evidencePath, fetchImpl }),
    create: options => createProvider({ env, ready: () => true, evidencePath, fetchImpl, ...options }),
    async close() { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); rmSync(root, { recursive: true, force: true }); },
  };
}

test('actual HTTP request sends only fresh system + tiny brief + PNG, and persists provider IDs, hashes and measured usage', async () => {
  const f = await fixture();
  try {
    await evaluatePage({ provider: f.provider, screenshot: png, brief: 'Review the invitation.' });
    await evaluatePage({ provider: f.provider, screenshot: png, brief: 'Understand the result.' });
    assert.equal(f.requests.length, 2);
    for (const [i, request] of f.requests.entries()) {
      const body = JSON.parse(request.body);
      assert.equal(request.path, '/v1/chat/completions'); assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, 'Bearer fixture-only-token');
      assert.deepEqual(Object.keys(body).sort(), ['max_completion_tokens', 'messages', 'model', 'response_format', 'stream']);
      assert.equal(body.model, 'fixture-vision'); assert.equal(body.max_completion_tokens, 1024); assert.equal(body.stream, false);
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.equal(body.messages.length, 2); assert.equal(body.messages[0].role, 'system'); assert.match(body.messages[0].content, /visible pixels/);
      assert.equal(body.messages[1].role, 'user'); assert.equal(body.messages[1].content.length, 2);
      assert.equal(body.messages[1].content[0].text, `Tiny job brief: ${i ? 'Understand the result.' : 'Review the invitation.'}`);
      assert.deepEqual(body.messages[1].content[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}`, detail: 'high' } });
      const evidence = f.provider.evidence()[i];
      assert.equal(evidence.requestHash, createHash('sha256').update(request.body).digest('hex'));
      assert.equal(evidence.pngHash, createHash('sha256').update(png).digest('hex'));
      assert.deepEqual(evidence.usage, { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
      assert.equal(evidence.costUsd, 0.001); assert.equal(evidence.costSource, 'provider'); assert.equal(evidence.status, 'complete');
    }
    assert.notEqual(f.provider.evidence()[0].operationId, f.provider.evidence()[1].operationId);
    assert.equal(statSync(f.evidencePath).mode & 0o777, 0o600);
    const stored = readFileSync(f.evidencePath, 'utf8');
    assert.equal(stored.split('\n').filter(Boolean).length, 4);
    assert.equal(stored.includes('fixture-only-token'), false); assert.equal(stored.includes(png.toString('base64')), false);
    assert.equal(stored.includes('Review the invitation.'), false);
    await assert.rejects(evaluatePage({ provider: f.provider, screenshot: png, brief: 'One more.' }), /call_limit/);
    assert.equal(f.requests.length, 2);
  } finally { await f.provider.close(); await f.close(); }
});

test('HTTP errors are sanitized, are never retried and retain unknown spend rather than zero', async () => {
  const f = await fixture(() => ({ status: 503, body: { error: 'fixture-private-provider-body', usage: { cost_usd: 0 } } }));
  try {
    await assert.rejects(evaluatePage({ provider: f.provider, screenshot: png, brief: 'Review.' }), error => error.message === 'Goldfish provider http_error.');
    assert.equal(f.requests.length, 1);
    const evidence = f.provider.latestEvidence();
    assert.equal(evidence.status, 'http_error'); assert.equal(evidence.httpStatus, 503);
    assert.equal(evidence.costUsd, null); assert.equal(evidence.costSource, 'unknown'); assert.equal(evidence.usage, null);
    assert.equal(JSON.stringify(evidence).includes('fixture-private-provider-body'), false);
  } finally { await f.provider.close(); await f.close(); }
});

test('truncated or malformed completion cannot pass, while missing provider cost remains unknown', async () => {
  for (const result of [responseBody('{'), { ...responseBody(), choices: [{ finish_reason: 'length', message: { role: 'assistant', content: JSON.stringify(verdict) } }] }, { choices: [] }]) {
    const f = await fixture(() => ({ status: 200, body: result }));
    try {
      await assert.rejects(evaluatePage({ provider: f.provider, screenshot: png, brief: 'Review.' }), /invalid_response/);
      assert.equal(f.provider.latestEvidence().costUsd, null);
    } finally { await f.provider.close(); await f.close(); }
  }
  const f = await fixture(() => ({ status: 200, body: responseBody('{}', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) }));
  try {
    await assert.rejects(evaluatePage({ provider: f.provider, screenshot: png, brief: 'Review.' }), /invalid structured evidence/);
    assert.equal(f.provider.latestEvidence().costUsd, null); assert.equal(f.provider.latestEvidence().costSource, 'unknown');
    assert.deepEqual(f.provider.latestEvidence().usage, { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  } finally { await f.provider.close(); await f.close(); }
});

test('readiness, explicit vision model and bounded timeout prevent an implicit or hanging live request', async () => {
  assert.throws(() => createProvider({ env: { ...env, NEON_GOLDFISH_MODEL: undefined, NEON_MODEL: 'writer-model' } }), /not_configured/);
  assert.throws(() => createProvider({ env: { ...env, NEON_AI_GATEWAY_BASE_URL: 'https://fixture.invalid/v1' } }), /invalid_gateway/);
  const f = await fixture(() => ({ status: 200, body: responseBody(), delay: 80 }));
  const blocked = f.create({ ready: () => false }), timed = f.create({ timeoutMs: 10 });
  try {
    await assert.rejects(evaluatePage({ provider: blocked, screenshot: png, brief: 'Review.' }), /keys_not_ready/);
    assert.equal(f.requests.length, 0); assert.deepEqual(blocked.evidence(), []);
    await assert.rejects(evaluatePage({ provider: timed, screenshot: png, brief: 'Review.' }), /timeout/);
    assert.equal(timed.latestEvidence().status, 'timeout'); assert.equal(timed.latestEvidence().costUsd, null);
  } finally { await blocked.close(); await timed.close(); await f.close(); }
});
