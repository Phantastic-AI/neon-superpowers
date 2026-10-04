// lois/voice — voice as LEARNED EVIDENCE, not authored constants (D-112, and
// the 2026-08-28 suppleness correction: "what is all this hardcoding? where is
// the suppleness?").
//
// The inner truth (the operator): voice = before->after rewrite examples + deslop
// techniques, keyed by (world x channel x purpose). The code holds exactly
// three things:
//
//   1. the KEY   — plain strings to file evidence under. The world IS the
//                  audience bucket for now; finer distinctions (parents vs kids
//                  at one event) ride the organizer's freeform NOTES, in their
//                  words, not our enums.
//   2. EVIDENCE  — drafted->sent rewrite pairs (Lago's "the gap between draft
//                  and send is your voice") + the organizer's notes.
//   3. TRIPWIRES — deslop's deterministic floor: checks that are ALWAYS wrong
//                  (em/en dashes, filler vocabulary, bracketed placeholders).
//                  Mechanical only. Passing means nothing except that the model-
//                  graded critic is allowed to have an opinion later.
//
// Everything else — register, warmth, channel length, how to talk to whom — is
// the MODEL's job, informed by the evidence. GLM knows what an SMS is. We do
// not teach a language model the concept of brevity in a string constant.
//
// Browser-safe: no node built-ins. Evidence is loaded by the node side
// (tools/lois-calibration.ts) and passed in.

import type { World } from "../../tools/projections/types.js";

// ---------------------------------------------------------------------------
// The key — where a piece of evidence is filed, and looked up.
// ---------------------------------------------------------------------------

export interface VoiceKey {
  /** The world/series context id — also the audience bucket, for now. */
  context: string;
  /** Medium: email | linkedin | sms | whatsapp. */
  channel: string;
  /** The message's job: invite | reply | nudge | reminder | thanks. */
  purpose: string;
  /** For replies only: accept | decline | question. */
  intent?: string;
}

export function keyString(k: VoiceKey): string {
  return [k.context, k.channel, k.purpose, k.intent ?? ""].filter(Boolean).join(" · ");
}

/**
 * Widening lookup: exact (channel+purpose) -> same channel -> same world.
 * Never crosses worlds — another world is another voice.
 */
function keyMatch(pairKey: VoiceKey, key: VoiceKey, tier: number): boolean {
  if (pairKey.context !== key.context) return false;
  if (tier === 0) return pairKey.channel === key.channel && pairKey.purpose === key.purpose;
  if (tier === 1) return pairKey.channel === key.channel;
  return true;
}

// ---------------------------------------------------------------------------
// The evidence — the Lago "Drafted vs Sent" unit, plus the organizer's notes.
// ---------------------------------------------------------------------------

export interface CalibrationPair {
  key: VoiceKey;
  /** What Lois drafted. */
  drafted: string;
  /** What the organizer actually sent, after rewriting. */
  sent: string;
  /** Optional one-line takeaway, in the organizer's or Lois's words. */
  lesson?: string;
  at?: string;
}

export interface VoiceProfile {
  key: VoiceKey;
  world: string;
  /** The organizer's freeform voice notes for this world, verbatim. */
  notes?: string;
  /** The matched drafted->sent pairs — THE learned signal. */
  calibration: CalibrationPair[];
  /** Plain-stated provenance — honest about what informs this profile. */
  source: string;
  learnedFrom: number;
}

/**
 * Gather the voice evidence for one key. No authored registers, no channel
 * tables: what the organizer rewrote, what they noted, and which world this is.
 */
export function learnVoice(
  world: World,
  key: VoiceKey,
  pairs: CalibrationPair[] = [],
  notes?: string,
): VoiceProfile {
  const ctx = world.contexts.find((c) => c.id === key.context);
  const worldName = ctx?.name ?? key.context;

  let matched: CalibrationPair[] = [];
  for (let tier = 0; tier <= 2 && matched.length === 0; tier++) {
    matched = pairs.filter((p) => keyMatch(p.key, key, tier));
  }

  const parts: string[] = [];
  if (matched.length > 0) parts.push(`${matched.length} drafted-vs-sent rewrite(s) at (${keyString(key)})`);
  if (notes) parts.push("the organizer's voice notes");
  const source = parts.length > 0
    ? `learned from ${parts.join(" + ")}, over the deslop floor`
    : `no rewrites or notes yet at (${keyString(key)}); the model writes for ${worldName} over the deslop floor alone. Learns as you rewrite drafts.`;

  return { key, world: worldName, notes, calibration: matched.slice(-5), source, learnedFrom: matched.length };
}

/**
 * The learning step: append a drafted->sent pair. A draft sent unchanged
 * teaches nothing and is not stored.
 */
export function recordRewrite(pairs: CalibrationPair[], pair: CalibrationPair): CalibrationPair[] {
  const drafted = pair.drafted.trim();
  const sent = pair.sent.trim();
  if (!sent || drafted === sent) return pairs;
  return [...pairs, { ...pair, drafted, sent }];
}

// ---------------------------------------------------------------------------
// The tripwires — deslop's deterministic floor. Only always-wrong mechanics.
// ---------------------------------------------------------------------------

// Verbatim from deslop's check-copy-v1.1.mjs, plus the trade-jargon law (T8).
const FILLER = ["effortless", "leverage", "seamless", "supercharge", "transform", "unlock"];
const JARGON = ["agentic", "workflow", "enrichment", "orchestration", "ai-powered", "copilot"];

export interface VoiceFlag {
  rule: string;
  detail: string;
}

export function checkVoice(_profile: VoiceProfile, text: string): VoiceFlag[] {
  const flags: VoiceFlag[] = [];
  if (/[–—]/.test(text)) flags.push({ rule: "T1", detail: "contains an em or en dash" });
  const lower = text.toLowerCase();
  for (const w of JARGON) if (new RegExp(`\\b${w}\\b`).test(lower)) flags.push({ rule: "T8", detail: `trade jargon: "${w}"` });
  for (const w of FILLER) if (new RegExp(`\\b${w}\\b`).test(lower)) flags.push({ rule: "filler", detail: `deslop filler: "${w}"` });
  if (/\[[^\]]+\]/.test(text)) flags.push({ rule: "placeholder", detail: "contains a [bracketed] placeholder" });
  return flags;
}

// ---------------------------------------------------------------------------
// voiceBrief — hand the model the evidence and get out of its way.
// ---------------------------------------------------------------------------

export function voiceBrief(profile: VoiceProfile): string {
  const k = profile.key;
  const lines = [
    `You are writing for ${profile.world}: a ${k.purpose}, by ${k.channel}. Write the way a`,
    `person writes on that medium for that job; you know its natural length and form.`,
    "Floor rules: no em or en dashes; no bracketed placeholders; no marketing filler",
    `(${FILLER.join(", ")}); no trade jargon. Plain, warm, concrete words.`,
  ];
  if (profile.notes) {
    lines.push("", "The organizer's own notes on how to write for this crowd:", profile.notes);
  }
  if (profile.calibration.length > 0) {
    lines.push("", "How the organizer rewrote past drafts. Match the SENT version, not the DRAFTED one. This is the voice:");
    for (const c of profile.calibration) {
      lines.push(`DRAFTED: ${c.drafted}`, `SENT:    ${c.sent}`, ...(c.lesson ? [`LESSON:  ${c.lesson}`] : []), "");
    }
  }
  return lines.join("\n");
}
