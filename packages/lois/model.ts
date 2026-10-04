// lois/model — Lois's brain, on the AI SDK (hygiene refactor, D-118 debt).
//
// Ports and adapters, same law as before: the rest of the app depends on this
// PORT; the OpenRouter provider is one adapter and swapping providers is a
// config change. What changed: the hand-rolled fetch, SSE frame parsing, and
// JSON salvage are GONE — the AI SDK owns transport and streaming, zod owns
// validation at the boundary ("type the rails", D-121).
//
//   model         — the raw SDK LanguageModel, for the mind's streamText with
//                   NATIVE tool-calls (kills the {"need":[...]} convention).
//   complete()    — one structured call (critic, goldfish, CLI paths).
//   respondToWave — the comment-mode wave contract, unchanged behavior.
//
// This module never reads process.env and never touches a filesystem. The
// server hands it the key explicitly; the key never reaches a browser bundle.

import { generateText, Output, type LanguageModel } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";

/** A single freeform note the organizer left on a specific past guest. */
export interface WaveNoteInput {
  anchor: string;
  text: string;
}

/** Lois's reply to one note: what she will do about it, in her own words. */
export interface WaveReplyOutput {
  anchor: string;
  reply: string;
}

export interface LoisModel {
  /** The raw SDK model — the mind runs streamText + native tools over this. */
  model: LanguageModel;
  /** One structured call; onDelta streams raw text as it arrives. */
  complete(input: {
    system: string;
    user: string;
    images?: { data: Uint8Array; mediaType: string }[];
    json?: boolean;
    onDelta?: (chunk: string) => void;
    signal?: AbortSignal;
  }): Promise<string>;
  /** The comment-mode wave: exactly one reply per note, matched by anchor. */
  respondToWave(input: { notes: WaveNoteInput[]; context?: string }): Promise<WaveReplyOutput[]>;
}

export interface OpenRouterConfig {
  /** Server-side only. Never logged. */
  apiKey: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  /**
   * Reasoning throttle (LOIS_REASONING): "off" disables hybrid reasoning;
   * "minimal".."high" set effort. Measured 2026-08-28: glm-5.3-flash default
   * reasoning = ~14s of pre-token silence; same model at "minimal" = 2.7s TTFW
   * with the best honest answer in the field.
   */
  reasoning?: "off" | "minimal" | "low" | "medium" | "high";
  /**
   * Hard OpenRouter routing ceiling in USD per million tokens. When present,
   * endpoints above the recorded paid-run price cannot receive the request.
   */
  maxPriceUsdPerMillion?: {
    prompt: number;
    completion: number;
  };
  /** Per-request OpenRouter privacy and provider constraints. */
  providerRouting?: {
    zdr?: boolean;
    data_collection?: "deny" | "allow";
    only?: string[];
    ignore?: string[];
    order?: string[];
    allow_fallbacks?: boolean;
  };
}

export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_MODEL = "z-ai/glm-5.3-flash";

export interface LoisModelAdapterOptions {
  temperature?: number;
}

const WAVE_SYSTEM = [
  "You are Lois, a warm, brief event concierge helping an organizer curate a guest list.",
  "The organizer leaves freeform sticky notes about specific past guests. Each note has an",
  "`anchor` (the guest) and `text` (their instruction or observation, in their own words).",
  "",
  "Reply to EVERY note in ONE or TWO plain, warm sentences saying what you will DO about it.",
  "Speak as Lois, first person, concrete and reassuring. Do not restate the note back",
  "verbatim, do not ask questions, do not use em or en dashes.",
  "",
  "Return STRICT JSON and nothing else:",
  '{"replies":[{"anchor":"<the note\'s exact anchor>","reply":"<your one or two sentences>"}]}',
].join("\n");

const WaveReplies = z.object({
  replies: z.array(z.object({ anchor: z.string(), reply: z.string() })),
});

/** Build Lois's port over any AI SDK model, including a metered wrapper. */
export function createLoisModel(
  model: LanguageModel,
  options: LoisModelAdapterOptions = {},
): LoisModel {
  const temperature = options.temperature ?? 0.5;
  return {
    model,

    async complete({ system, user, images, json, onDelta, signal }) {
      // generateText for the plain case; when the caller streams, we still use
      // generateText and forward the full text once — complete()'s streaming
      // consumers moved to the mind's native streamText path.
      const prompt = images?.length
        ? [{
            role: "user" as const,
            content: [
              { type: "text" as const, text: user },
              ...images.map((image) => ({
                type: "file" as const,
                data: image.data,
                mediaType: image.mediaType,
              })),
            ],
          }]
        : user;
      if (json) {
        const res = await generateText({
          model,
          system,
          prompt,
          temperature,
          abortSignal: signal,
          output: Output.json(),
        });
        const text = res.output === undefined ? res.text : JSON.stringify(res.output);
        if (onDelta) onDelta(text);
        return text;
      }
      const res = await generateText({ model, system, prompt, temperature, abortSignal: signal });
      if (onDelta) onDelta(res.text);
      return res.text;
    },

    async respondToWave({ notes, context }) {
      if (!notes || notes.length === 0) return [];
      const user = [
        ...(context && context.trim() ? [`Context: ${context.trim()}`, ""] : []),
        "Notes (reply to each, keyed by its anchor):",
        JSON.stringify({ notes }, null, 2),
      ].join("\n");
      const res = await generateText({ model, system: WAVE_SYSTEM, prompt: user, temperature });
      const parsed = WaveReplies.safeParse(parseJsonLoose(res.text));
      const replies = parsed.success ? parsed.data.replies : [];
      return alignToNotes(replies, notes);
    },
  };
}

function openRouterExtraBody(cfg: OpenRouterConfig): Record<string, unknown> | undefined {
  const extraBody: Record<string, unknown> = {};
  if (cfg.reasoning === "off") extraBody.reasoning = { enabled: false };
  else if (cfg.reasoning) extraBody.reasoning = { effort: cfg.reasoning };
  const provider: Record<string, unknown> = cfg.providerRouting
    ? { ...cfg.providerRouting }
    : {};
  if (cfg.maxPriceUsdPerMillion) {
    provider.max_price = {
      prompt: cfg.maxPriceUsdPerMillion.prompt,
      completion: cfg.maxPriceUsdPerMillion.completion,
      request: 0,
      image: 0,
    };
  }
  if (Object.keys(provider).length) extraBody.provider = provider;
  return Object.keys(extraBody).length ? extraBody : undefined;
}

export const __modelTest = { openRouterExtraBody };

export function createOpenRouterLoisModel(cfg: OpenRouterConfig): LoisModel {
  const provider = createOpenRouter({
    apiKey: cfg.apiKey,
    baseURL: (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    extraBody: openRouterExtraBody(cfg),
  });
  return createLoisModel(provider.chat(cfg.model || DEFAULT_MODEL), { temperature: cfg.temperature });
}

// ---------------------------------------------------------------------------
// parseJsonLoose — tolerate fences and stray prose around a JSON value. Kept
// because model text is model text; zod validates whatever this finds.
// ---------------------------------------------------------------------------

export function parseJsonLoose(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const trimmed = (fence ? fence[1] : text).trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
      const start = trimmed.indexOf(open);
      const end = trimmed.lastIndexOf(close);
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1));
        } catch {
          // try next bracket kind
        }
      }
    }
    return undefined;
  }
}

/** Exactly one reply per note, in input order; unanswered notes get a plain fallback. */
function alignToNotes(parsed: WaveReplyOutput[], notes: WaveNoteInput[]): WaveReplyOutput[] {
  const byLoose = new Map<string, string>();
  for (const p of parsed) {
    const k = p.anchor.trim().toLowerCase();
    if (!byLoose.has(k)) byLoose.set(k, p.reply);
  }
  return notes.map((n, i) => ({
    anchor: n.anchor,
    reply:
      byLoose.get(n.anchor.trim().toLowerCase()) ??
      (parsed.length === notes.length ? parsed[i].reply : `Noted on ${n.anchor}. I will weigh that when I sort and draft.`),
  }));
}
