// The stateless PNG + tiny brief contract follows Lois's organizer-page reader.
// This module contains no provider SDK, credentials, network transport or evalkit code.
const CONTRACT = [
  'You are a fresh reader seeing this product for the first time.',
  'Judge only visible pixels in this whole-page PNG. The tiny brief names the job, not evidence.',
  'Do not credit hidden traces, writer intentions, prior conversation or unreadable text.',
  'Return strict JSON: {"job":string,"visible_state":string,"next_step":string,',
  '"lois_was_sane":boolean,"browser_state_clear":boolean,"choices_visible":nonnegative integer,',
  '"confusing":string[],"verdict":"swims"|"sinks"}.',
  'A page swims only when its purpose, current state and safe next action are clear without inventing context.',
].join('\n');

export async function evaluatePage({ provider, screenshot, brief }) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!(screenshot instanceof Uint8Array) || !signature.every((byte, i) => screenshot[i] === byte)) {
    throw new Error('A captured PNG is required before a Goldfish call.');
  }
  if (typeof brief !== 'string' || !brief.trim() || brief.length > 600) throw new Error('Supply a tiny job brief (1–600 characters).');
  if (typeof provider?.complete !== 'function') throw new Error('Configure a fresh-call model provider before a Goldfish read.');
  const raw = await provider.complete({
    system: CONTRACT,
    user: `Tiny job brief: ${brief}`,
    images: [{ data: screenshot, mediaType: 'image/png' }],
    json: true,
  });
  let verdict;
  try { verdict = JSON.parse(raw); } catch { throw new Error('Goldfish returned invalid JSON evidence.'); }
  const valid = verdict && ['job', 'visible_state', 'next_step'].every(k => typeof verdict[k] === 'string' && verdict[k].trim())
    && ['lois_was_sane', 'browser_state_clear'].every(k => typeof verdict[k] === 'boolean')
    && Number.isInteger(verdict.choices_visible) && verdict.choices_visible >= 0
    && Array.isArray(verdict.confusing) && verdict.confusing.every(s => typeof s === 'string')
    && ['swims', 'sinks'].includes(verdict.verdict);
  if (!valid) throw new Error('Goldfish returned invalid structured evidence.');
  // A contradictory positive verdict is never accepted merely because its label says "swims".
  if (!verdict.lois_was_sane || !verdict.browser_state_clear || verdict.confusing.length) verdict.verdict = 'sinks';
  return Object.fromEntries(['job', 'visible_state', 'next_step', 'lois_was_sane', 'browser_state_clear', 'choices_visible', 'confusing', 'verdict'].map(key => [key, verdict[key]]));
}
