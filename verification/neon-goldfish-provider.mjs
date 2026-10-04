// One bounded OpenAI-compatible vision request per whole-page read.
// No conversation state, writer prompt, automatic retry or pricing estimate.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,256}$/.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
class ProviderFailure extends Error { constructor(code) { super(`Goldfish provider ${code}.`); this.code = code; } }
const reject = code => { throw new ProviderFailure(code); };

function configuration(env, config) {
  const apiKey = config?.apiKey ?? env.NEON_AI_GATEWAY_TOKEN ?? env.NEON_AI_GATEWAY_API_KEY;
  const baseURL = config?.baseURL ?? env.NEON_AI_GATEWAY_BASE_URL;
  const model = config?.model ?? env.NEON_GOLDFISH_MODEL;
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey) || !id(model)) reject('not_configured');
  let url;
  try { url = new URL(baseURL); } catch { reject('invalid_gateway'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) reject('invalid_gateway');
  return { apiKey, origin: url.origin, model };
}

async function boundedJson(response, limit) {
  if (!response.body) reject('invalid_response');
  const reader = response.body.getReader(), parts = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length; if (length > limit) reject('response_too_large');
      parts.push(Buffer.from(part.value));
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { reject('invalid_response'); }
  } finally { await reader.cancel().catch(() => {}); }
}

/** Defaults suit the two review/completion reads. Injection is for trusted
 * local fixtures or an approved caller; never accept these options from HTTP.
 * Construction does not call the gateway. Readiness is rechecked per request.
 */
export function createProvider({ env = process.env, config, fetchImpl = globalThis.fetch,
  ready = () => existsSync(resolve(root, '.local/keys-ready')),
  evidencePath = resolve(root, '.local/verification/goldfish-calls.jsonl'),
  timeoutMs = 30000, maxCalls = 2, maxOutputTokens = 1024,
} = {}) {
  const selected = configuration(env, config);
  if (typeof ready !== 'function' || typeof fetchImpl !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
    || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 8
    || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 4096) reject('invalid_limits');
  const records = [];
  let calls = 0, busy = false, closed = false, activeController;
  const record = evidence => {
    if (evidencePath !== null) {
      try { mkdirSync(dirname(evidencePath), { recursive: true, mode: 0o700 }); appendFileSync(evidencePath, JSON.stringify(evidence) + '\n', { mode: 0o600 }); }
      catch { reject('evidence_unavailable'); }
    }
    const previous = records.findIndex(r => r.id === evidence.id);
    if (previous === -1) records.push(structuredClone(evidence)); else records[previous] = structuredClone(evidence);
  };
  return {
    evidence: () => structuredClone(records),
    latestEvidence: () => records.length ? structuredClone(records.at(-1)) : null,
    async complete(input) {
      if (closed || busy) reject('unavailable');
      if (!ready()) reject('keys_not_ready');
      if (calls >= maxCalls) reject('call_limit');
      if (!input || Object.keys(input).some(k => !['system', 'user', 'images', 'json'].includes(k))
        || typeof input.system !== 'string' || !input.system.trim() || input.system.length > 10000
        || typeof input.user !== 'string' || !input.user.startsWith('Tiny job brief: ') || input.user.length > 620
        || input.json !== true || !Array.isArray(input.images) || input.images.length !== 1) reject('invalid_page_input');
      const image = input.images[0];
      if (image?.mediaType !== 'image/png' || !(image.data instanceof Uint8Array) || image.data.length > 8 * 1024 * 1024
        || ![137,80,78,71,13,10,26,10].every((byte, i) => image.data[i] === byte)) reject('invalid_png');
      const png = Buffer.from(image.data);
      const payload = { model: selected.model, messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: [{ type: 'text', text: input.user }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}`, detail: 'high' } }] },
      ], response_format: { type: 'json_object' }, max_completion_tokens: maxOutputTokens, stream: false };
      const body = JSON.stringify(payload), operationId = randomUUID();
      const evidence = { id: `goldfish:${operationId}`, sponsorId: 'neon', operationId, kind: 'model',
        model: selected.model, gatewayHost: new URL(selected.origin).hostname,
        requestHash: hash(body), pngHash: hash(png), pngBytes: png.length,
        startedAt: new Date().toISOString(), status: 'requested', requestId: null,
        providerResponseId: null, providerModel: null, usage: null, costUsd: null, costSource: 'unknown' };
      // If local evidence cannot be recorded, do not dispatch a paid request.
      record(evidence); calls += 1; busy = true;
      const controller = new AbortController();
      activeController = controller;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${selected.origin}/v1/chat/completions`, {
          method: 'POST', headers: { Authorization: `Bearer ${selected.apiKey}`, 'Content-Type': 'application/json' },
          body, signal: controller.signal, redirect: 'error',
        });
        evidence.httpStatus = response.status;
        evidence.requestId = id(response.headers.get('x-request-id'));
        if (!response.ok) { await response.body?.cancel().catch(() => {}); reject('http_error'); }
        const result = await boundedJson(response, 128 * 1024);
        evidence.providerResponseId = id(result?.id); evidence.providerModel = id(result?.model);
        const usage = result?.usage;
        if (count(usage?.prompt_tokens) !== null && count(usage?.completion_tokens) !== null && count(usage?.total_tokens) !== null
          && usage.total_tokens === usage.prompt_tokens + usage.completion_tokens) {
          evidence.usage = { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens };
        }
        const choice = result?.choices?.[0], text = choice?.message?.content;
        if (!Array.isArray(result?.choices) || result.choices.length !== 1 || choice.finish_reason !== 'stop'
          || choice.message?.role !== 'assistant' || choice.message.refusal || choice.message.tool_calls?.length
          || typeof text !== 'string' || !text.trim()) reject('invalid_response');
        try { const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) reject('invalid_response'); }
        catch { reject('invalid_response'); }
        // Optional provider extension; absent, negative or non-numeric cost is
        // unknown. Token usage alone is not a measured dollar cost.
        if (typeof usage?.cost_usd === 'number' && Number.isFinite(usage.cost_usd) && usage.cost_usd >= 0) {
          evidence.costUsd = usage.cost_usd; evidence.costSource = 'provider';
        }
        evidence.status = 'complete'; evidence.completedAt = new Date().toISOString(); record(evidence);
        return text;
      } catch (error) {
        const code = controller.signal.aborted ? closed ? 'cancelled' : 'timeout' : error instanceof ProviderFailure ? error.code : 'network_error';
        evidence.status = code; evidence.completedAt = new Date().toISOString();
        // Failed calls may still have incurred spend; never invent a zero.
        evidence.costUsd = null; evidence.costSource = 'unknown';
        record(evidence); throw new ProviderFailure(code);
      } finally { clearTimeout(timer); busy = false; activeController = undefined; }
    },
    async close() { closed = true; activeController?.abort(); },
  };
}
