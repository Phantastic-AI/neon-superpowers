// lois/mind — the mouth: the one model-backed foreground agent (D-111, D-113).
//
// THE SUPPLE LAW: the model is the mind; code is memory (the log), senses
// (senses.ts), hands (injected, gated), and eyes (the trace). This file holds
// NO sentence Lois might say, NO plan she might make, NO decision she might
// take, and no fallback copy — a missing or failing brain is reported
// honestly, never mimed.
//
// One turn: wake on `heard` -> assemble warm context + voice evidence + the
// thread (the log IS the conversation memory) -> ONE streamText run with
// native tools (senses + hands) -> land say/ui/proposals/memory/questions on
// the bus. Proposals wake the critic/goldfish/gate via the pump. Her say
// streams out as she writes it (the latency law, D-118/D-119).

import { streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { parseJsonLoose, type LoisModel } from "./model.js";
import { digest } from "./trace.js";
import { sayScanner } from "./say-stream.js";
import { createSenses } from "./senses.js";
import type { AgentSpec, WakeContext } from "./registry.js";
import type { TraceEvent } from "./trace.js";
import { learnVoice, voiceBrief, type CalibrationPair, type VoiceKey } from "./voice.js";
import type { World } from "../../tools/projections/types.js";

// ---------------------------------------------------------------------------
// The mind-output — what one turn produces. zod owns the boundary (D-121).
// ---------------------------------------------------------------------------

const MindOutputSchema = z.object({
  say: z.string().default(""),
  ui: z.array(z.record(z.string(), z.unknown())).default([]),
  proposals: z.array(z.record(z.string(), z.unknown())).default([]),
  memory: z
    .array(z.object({ about: z.string().optional(), claim: z.string(), epistemics: z.string().optional() }))
    .default([]),
  questions: z
    .array(
      z
        .union([z.string(), z.object({ ask: z.string(), about: z.string().optional() })])
        .transform((q) => (typeof q === "string" ? { ask: q } : q)),
    )
    .default([]),
  replies: z.array(z.object({ on: z.string(), reply: z.string() })).default([]),
});

export interface Proposal {
  kind: string;
  [k: string]: unknown;
}

export interface MindOutput {
  say: string;
  ui: Record<string, unknown>[];
  proposals: Proposal[];
  memory: { about?: string; claim: string; epistemics?: string }[];
  questions: { ask: string; about?: string }[];
  replies: { on: string; reply: string }[];
}

export interface TurnResult {
  ok: boolean;
  why?: string;
  output?: MindOutput;
}

export interface MouthOptions {
  gatheringId?: string;
  channel?: string;
  purpose?: string;
  calibration?: CalibrationPair[];
  voiceNotes?: string;
  /** Cap on model steps per turn (thinking + tool rounds). Default 4. */
  maxSteps?: number;
  onTurn?: (result: TurnResult) => void;
  /** Streams her say as she writes it (first words ~1-3s, the latency law). */
  onSay?: (delta: string) => void;
  /**
   * HER HANDS (D-117), injected server-side only: named actions she may take
   * with the organizer's spoken consent (the dive). Absent in browser bundles
   * and the no-hands CLI, so the tools simply don't exist there.
   */
  hands?: Record<
    string,
    {
      description: string;
      inputSchema: z.ZodType<unknown>;
      /** Explicit safe projection for durable trace evidence. Raw hand input is never traced by default. */
      traceInput?: (input: unknown) => Record<string, unknown>;
      run: (
        input: unknown,
        context?: { signal?: AbortSignal; onProgress?: () => void },
      ) => Promise<string>;
    }
  >;
}

function finalStepSpeaks(maxSteps: number) {
  return ({ stepNumber }: { stepNumber: number }) =>
    stepNumber === maxSteps - 1 ? { toolChoice: "none" as const } : {};
}

function createIdleWatchdog(timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const renew = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  renew();
  return {
    signal: controller.signal,
    renew,
    abort: () => controller.abort(),
    timedOut: () => timedOut,
    close: () => clearTimeout(timer),
  };
}

// ---------------------------------------------------------------------------
// The output contract. Structure, not content.
// ---------------------------------------------------------------------------

const CONTRACT = [
  "When you have what you need, answer with STRICT JSON, nothing else:",
  "  {",
  '    "say": "<what you tell the organizer, in your voice>",',
  '    "ui": [<one stage decision: {"show": "room" | "plan" | "queue" | "browser" | "keep"}>],',
  '    "proposals": [<things you want made real, e.g. {"kind": "draft", "to": "<first name>", "channel": "...", "subject": "...", "body": "..."} or {"kind": "plan", "steps": ["..."]}>],',
  '    "memory": [<facts worth keeping, e.g. {"about": "<person>", "claim": "...", "epistemics": "stated" | "inferred"}>],',
  '    "questions": [<anything you need the organizer to decide, e.g. {"ask": "...", "about": "<the first name or thing it concerns, when it concerns one>"}>],',
  '    "replies": [<ONLY when the organizer\'s message carried notes on specific people or things: one warm line per note, {"on": "<the note\'s exact anchor>", "reply": "<what you will do about it>"}>]',
  "  }",
  'Put "say" FIRST in the JSON.',
  "How you speak (the say, the replies, your questions): plain words, short sentences, concrete",
  "names and numbers. Someone reading one reply cold, knowing nothing, should understand what",
  "happened and what happens next. Never compress so hard the organizer must already know what",
  "you mean; never trail off with a colon into nothing.",
  "Every proposal is held for the organizer's approval before it is committed; propose freely.",
  "Move one thing at a time. If the organizer says to start with one part, finish and show that",
  "part before advancing. If you ask whether to draft, research, browse, or otherwise do something,",
  "do not also propose that same work in the turn that asks. Wait for the answer.",
  "Treat the organizer's latest message as the acceptance contract for this turn. Before you answer,",
  "check every explicit instruction in it: what to include, what to omit, how many, for whom, and",
  "which tools may be used. Do not add a signature, name, person, field, action, or flourish they told",
  "you to omit. When an older preference conflicts with the latest message, the latest message wins.",
  "An omission covers the whole semantic unit and its conventional equivalents, not only the exact",
  "word. If they say to omit a signature, end after the requested message: no farewell or sender line.",
  "A draft proposal means the draft is already written. Include one only after the organizer asked",
  "for the draft or said yes to your offer. When a turn asks you to inspect or check something before",
  "other work, that inspection is the whole turn. Show what you found and what changed, ask one next",
  "question, and leave proposals empty. After that requested checkpoint, later work begins on the organizer's next turn.",
  "A progress reply does not finish or pause an already-requested research job. A running dive continues",
  "while you talk. Its settled report wakes you to inspect saved state and continue useful unfinished work",
  "within the same request, unless the organizer stopped it, set a checkpoint, or a real blocker remains.",
  "A launch receipt is not a finished result. requestApplied=false means the running worker did not receive your new intent.",
  "When the organizer changes or stops active research, use research_cancel; do not claim it was steered without a receipt.",
  "The ui decision and your say must agree. Use {\"show\":\"keep\"} when the organizer asks to keep",
  "the current stage in place. Use {\"show\":\"browser\"} to bring an already-open browser back to",
  "the stage. A contextual room, plan, or queue hint must not contradict what you just told them.",
  "Speak every question once in say. The questions array is only a machine-addressed mirror for",
  "the trace and must never introduce a second question that the say did not ask.",
  "Use ONLY people, events, dates, claims, and acronym expansions from the context and your tools.",
  "A dive's modelReport is the diver's account, not a host receipt. Its top-level status reflects host",
  "completion checks; hostEvidenceCategories come from capabilities. A partial result remains unfinished even if the account",
  "says done. Use people_read for current saved-list counts and coverage, rather than copying a",
  "contradictory summary or a turn-start snapshot. Continue useful unfinished work within the organizer's request",
  "when the available capabilities can resolve it; ask only for a real missing decision or human action.",
  "Identity assessment is part of combining lists, not a separate favor to ask permission for.",
  "Use people_read with includeEvidence on a small page when you need saved contacts, source rows,",
  "and their provenance. Have the diver assess the source's identity semantics and refine the saved",
  "import where evidence supports it. The same name is not proof of one person. Keep genuine missing",
  "or conflicting identities visible; distinguish saved source coverage from finished combination.",
  "When the organizer asks you to check a named source or the browser, checking that source is the",
  "acceptance criterion. Use the available hand even when saved context seems to contain an answer;",
  "saved context is not evidence of what the source shows now. Never say you opened, read, or checked",
  "a page unless the corresponding hand returned evidence in this turn.",
  "An event name or acronym you cannot explain from evidence is a source-reading task, not a creative",
  "blank: read the source or ask one concrete question. If neither holds the answer, say plainly that",
  "you cannot see it and which tool would show it — never guess or turn a plausible phrase into a fact.",
  "Never say a World or Gathering was created, connected, saved, or remembered unless the corresponding hand returned success in this turn.",
  "If that hand is unavailable or fails, say what is still missing instead of narrating success.",
  "If you got something wrong, correct it once from the",
  "data; do not apologize repeatedly.",
].join("\n");

const WORKER_RESULT_GUIDANCE = [
  "This is new evidence from work you already started, not a new organizer instruction.",
  "This worker invocation has ended. A partial report is saved unfinished work, not a running worker.",
  "If useful work remains within the organizer's request, call dive to resume from its saved state",
  "before saying research continues. A plan or next field in the report does not execute itself.",
  "When your saved-list inspection resolves the worker's remaining question, pass that reconciliation to dive as continuation evidence for the same saved job.",
  "Have the worker verify the saved result with people_read and assess the full original intent before reporting completion.",
  "It may settle from current saved evidence without reopening browser pages; ask it to read a source only if the original intent still needs that source.",
  "Use research_status if current activity is unclear. Respect a stop, requested checkpoint, or real",
  "human blocker; otherwise continue the goal. If complete, inspect the saved result and report it.",
].join("\n");

export const __mindTest = {
  finalStepSpeaks, createIdleWatchdog, contract: CONTRACT, heardLine,
  workerResultGuidance: WORKER_RESULT_GUIDANCE,
};

function heardLine(event: TraceEvent): string {
  const message = (event.detail?.text as string | undefined) ?? event.label;
  return event.actor === "organizer"
    ? `organizer: ${message}`
    : `worker update: ${message}`;
}

// ---------------------------------------------------------------------------
// loisMouth — the agent. Wakes on `heard`, thinks, appends the turn.
// ---------------------------------------------------------------------------

export function loisMouth(model: LoisModel | null, opts: MouthOptions = {}): AgentSpec {
  return {
    name: "lois",
    role: "mouth",
    purpose: "the foreground mind: hears the organizer, thinks in one call, speaks and proposes",
    triggersOn: (event) => event.kind === "heard",
    run: async (ctx, event) => {
      const result = await think(ctx, event, model, opts);
      opts.onTurn?.(result);
    },
  };
}

async function think(ctx: WakeContext, event: TraceEvent, model: LoisModel | null, opts: MouthOptions): Promise<TurnResult> {
  const { world, trace } = ctx;
  const message = (event.detail?.text as string | undefined) ?? event.label;
  const gathering = resolveGatheringFocus(world, opts.gatheringId);
  const key: VoiceKey | null = gathering
    ? { context: gathering.context, channel: opts.channel ?? "email", purpose: opts.purpose ?? "invite" }
    : null;
  const voice = key ? learnVoice(world, key, opts.calibration ?? [], opts.voiceNotes) : null;

  if (!model) {
    const why = "Lois's brain is not connected (no model). Nothing was generated.";
    trace.append({ actor: "lois", kind: "note", label: why });
    return { ok: false, why };
  }

  // Senses (traced, turn-cached) + her hands (server-injected, consented).
  const senses = createSenses(world, gathering, trace);
  let handSignal = ctx.signal;
  let handProgress: (() => void) | undefined;
  const hands = Object.fromEntries(
    Object.entries(opts.hands ?? {}).map(([name, hand]) => [
      name,
      tool({
        description: hand.description,
        inputSchema: hand.inputSchema,
        execute: async (input) => {
          const detail = { tool: name, ...(hand.traceInput?.(input) ?? {}) };
          const tc = trace.append({ actor: "lois", kind: "tool.call", label: name, detail });
          const obs = await hand.run(input, { signal: handSignal, onProgress: handProgress });
          trace.append({ actor: "lois", kind: "tool.return", label: obs, refs: [tc.seq] });
          return obs;
        },
      }),
    ]),
  );

  const warm = await senses.warm();
  trace.append({
    actor: "voice",
    kind: "note",
    label: voice
      ? `voice evidence: ${voice.source}`
      : "voice evidence: no gathering is focused; general Lois voice over the deslop floor",
  });

  // Conversation memory = the trace (the log IS the thread).
  const thread: string[] = [];
  for (const e of trace.all()) {
    if (e.kind === "heard") thread.push(heardLine(e));
    if (e.kind === "model.reply" && e.actor === "lois" && typeof e.detail?.say === "string" && e.detail.say) {
      thread.push(`you said: ${e.detail.say}`);
    }
  }
  const recent = thread.slice(-8, -1);
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });

  const system = [
    voice
      ? `You are Lois, the event concierge for ${voice.world}. You run the organizer's events with them:`
      : "You are Lois, the event concierge in Superpowers. You work with the organizer across their event worlds:",
    "you read the room, remember people, draft outbound in the organizer's voice, and hold every",
    "send for their approval. You decide what this turn needs; call tools when the context below",
    "does not already hold the answer.",
    "A gathering is optional focus, not a prerequisite. You may work in a focused gathering, help",
    "choose among existing gatherings, or help set up a new event world. When none is focused, do",
    "not invent event facts; ask for what you need and use the worlds sense when it helps.",
    "Historical people can be useful before any next gathering exists. Reuse the appropriate World ID",
    "and saved people view, or use remember_world if the organizer wants a new World. Never create a fake",
    "upcoming event just to access people. Give a guestlist diver any known World/view IDs; it can look up",
    "or establish the requested local World itself. Keep the requested saved-list outcome intact: save",
    "source-backed people, not merely download files or recite names. The saved source coverage is the",
    "basis for any claim about completeness; a list membership is not proof of attendance.",
    "For submitted Post-it notes, read the immutable wave with people_read. Interpret the organizer's",
    "intent; use people_order for requested ordering changes, then save your actual reply to each note",
    "with people_reply and finish the wave. A reply is not a substitute for the requested action.",
    "If the organizer changed the order while you worked, read the current revision and reconcile the",
    "instruction with their newer edits. Never quietly overwrite them. Ask about genuinely ambiguous",
    "instructions; note-wave completion means responses are saved, never that invitations were sent.",
    "Use dive for research-shaped browser work: give the diver the complete outcome and boundaries",
    "once, then work from its compact report. Do not narrate or reconstruct its browser steps.",
    "Do NOT call dive unless the organizer asks to connect their event, already-requested research needs",
    "its saved worker, or you need to read a page you cannot see otherwise. A greeting or a question from your senses needs",
    "no browser — just answer.",
    "Honor the organizer's boundary for this turn. If they say not to use the browser this turn,",
    "do not call dive.",
    "",
    ...(voice ? [voiceBrief(voice)] : [
      "No gathering-specific voice evidence is selected yet. Speak as Lois in plain, warm, concrete words.",
      "Learn the organizer's event and voice from this conversation instead of assuming them.",
    ]),
    "",
    CONTRACT,
  ].join("\n");

  const user = [
    ...(recent.length > 0 ? ["The conversation so far:", ...recent.map((t) => `- ${t}`), ""] : []),
    "Current state:",
    `- Today is ${today}.`,
    `- ${warm.look}`,
    `- ${warm.rank}`,
    "",
    event.actor === "organizer"
      ? `The organizer says: ${message}`
      : `Your bounded research worker reports: ${message}`,
    ...(event.actor === "organizer" ? [] : [WORKER_RESULT_GUIDANCE]),
    "Before returning JSON, compare your answer and every proposal against each explicit include,",
    "omit, count, recipient, tool-use, and action constraint in that message. Repair any mismatch now.",
  ].join("\n");

  const call = trace.append({
    actor: "lois",
    kind: "model.call",
    label: "think (one run, native tools)",
    detail: { promptDigest: digest(system + user) },
  });

  // The watchdog (goldfish finding, 2026-08-29): a hung provider stream must
  // never mean "thinking…" forever. Her own abort fires at the deadline; the
  // organizer's cancel rides the same controller.
  const WATCHDOG_IDLE_MS = 75_000;
  const watchdog = createIdleWatchdog(WATCHDOG_IDLE_MS);
  if (ctx.signal?.aborted) watchdog.abort();
  else ctx.signal?.addEventListener("abort", watchdog.abort, { once: true });
  handSignal = watchdog.signal;
  handProgress = watchdog.renew;

  const modelStartedAt = Date.now();
  const chunks = { text: 0, reasoning: 0, toolInput: 0 };
  let firstChunkMs: number | null = null, lastChunkMs: number | null = null;
  const timingEvidence = () => ({
    ms: Date.now() - modelStartedAt,
    streamProgress: { chunks: { ...chunks }, firstChunkMs, lastChunkMs },
  });
  let streamed = false;
  try {
    const scan = opts.onSay ? sayScanner((d) => { streamed = true; opts.onSay!(d); }) : undefined;
    const maxSteps = opts.maxSteps ?? 4;
    const result = streamText({
      model: model.model,
      system,
      prompt: user,
      tools: { ...senses.tools, ...hands },
      stopWhen: stepCountIs(maxSteps),
      // A tool call cannot consume the last slot and strand the organizer
      // without speech. The model still decides everything it says; the host
      // only reserves the final protocol beat for saying it.
      prepareStep: finalStepSpeaks(maxSteps),
      abortSignal: watchdog.signal,
      onChunk: ({ chunk }) => {
        // Native stream progress precedes both a finished step and an
        // executable tool call. Empty deltas and transport metadata do not
        // renew the idle window; no chunk content enters the diagnostic.
        let kind: keyof typeof chunks, size: number;
        switch (chunk.type) {
          case "text-delta": kind = "text"; size = chunk.text.length; break;
          case "reasoning-delta": kind = "reasoning"; size = chunk.text.length; break;
          case "tool-input-delta": kind = "toolInput"; size = chunk.delta.length; break;
          default: return;
        }
        if (!size) return;
        chunks[kind] += 1;
        lastChunkMs = Date.now() - modelStartedAt;
        firstChunkMs ??= lastChunkMs;
        watchdog.renew();
      },
      onStepEnd: watchdog.renew,
      onToolExecutionEnd: watchdog.renew,
    });
    if (scan) {
      for await (const part of result.textStream) scan(part);
    }
    const text = await result.text;
    const [usage, steps, toolCalls] = await Promise.all([
      result.usage,
      result.steps,
      result.toolCalls,
    ]);
    const modelEvidence = {
      ...timingEvidence(),
      steps: steps.length,
      toolCalls: toolCalls.length,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
        cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens,
        reasoningTokens: usage.outputTokenDetails.reasoningTokens,
        textTokens: usage.outputTokenDetails.textTokens,
      },
    };

    // The SDK may resolve a prior completed step when the next step aborts.
    // Retained speech is not a completed turn: cancellation still wins.
    ctx.signal?.throwIfAborted();
    if (watchdog.timedOut()) {
      const why = `Lois's brain stalled (no progress for ${Math.round(WATCHDOG_IDLE_MS / 1000)}s) — say it again and she retries fresh.`;
      trace.append({
        actor: "lois",
        kind: "note",
        label: why,
        detail: modelEvidence,
        refs: [call.seq],
      });
      return { ok: false, why };
    }
    watchdog.signal.throwIfAborted();

    // Prefer the JSON envelope; but a plain conversational reply (common after
    // tool rounds, or for a greeting) is NOT an error — her words ARE the turn.
    // Only a truly empty answer fails. Discarding real speech was the bug.
    const parsed = MindOutputSchema.safeParse(parseJsonLoose(text));
    const empty: MindOutput = { say: "", ui: [], proposals: [], memory: [], questions: [], replies: [] };
    let output: MindOutput;
    if (parsed.success && (parsed.data.say || parsed.data.proposals.length || parsed.data.questions.length || parsed.data.replies.length)) {
      output = { ...parsed.data, proposals: parsed.data.proposals.map((p) => ({ ...p, kind: typeof p.kind === "string" ? p.kind : "proposal" })) };
    } else {
      const say = plainSay(text);
      if (!say) {
        const why = "Lois's brain returned nothing. Say that again.";
        trace.append({ actor: "lois", kind: "note", label: why, detail: modelEvidence, refs: [call.seq] });
        return { ok: false, why };
      }
      output = { ...empty, say };
      if (opts.onSay && !streamed) opts.onSay(say); // stream it if the JSON scanner never fired
    }

    trace.append({
      actor: "lois",
      kind: "model.reply",
      label: `turn: ${output.proposals.length} proposal(s), ${output.memory.length} memory claim(s), ${output.questions.length} question(s)`,
      detail: { say: output.say, ...modelEvidence },
      refs: [call.seq],
    });
    for (const p of output.proposals) {
      const body = [p.subject, p.body, ...(Array.isArray(p.steps) ? (p.steps as unknown[]) : [])].filter(Boolean).join("\n");
      trace.append({
        actor: "lois",
        kind: "proposed",
        label: `${p.kind}${p.to ? ` for ${p.to}` : ""}${p.subject ? `: "${p.subject}"` : ""}`,
        detail: { ...p, digest: digest(body) },
      });
    }
    for (const m of output.memory) {
      trace.append({
        actor: "lois",
        kind: "proposed",
        label: `memory${m.about ? ` about ${m.about}` : ""}: ${oneLine(m.claim)}`,
        detail: { kind: "memory", ...m },
      });
    }
    return { ok: true, output };
  } catch (err) {
    const why = ctx.signal?.aborted
      ? "cancelled by the organizer mid-turn"
      : watchdog.timedOut()
        ? `Lois's brain stalled (no progress for ${Math.round(WATCHDOG_IDLE_MS / 1000)}s) — say it again and she retries fresh.`
        : `Lois's brain errored: ${err instanceof Error ? err.message : String(err)}. Nothing was generated.`;
    trace.append({ actor: "lois", kind: "note", label: why, detail: timingEvidence(), refs: [call.seq] });
    return { ok: false, why };
  } finally {
    watchdog.close();
  }
}


export function resolveGatheringFocus(world: World, gatheringId?: string) {
  if (gatheringId) {
    const g = world.gatherings.find((x) => x.id === gatheringId);
    if (!g) throw new Error(`mind: no gathering "${gatheringId}"`);
    return g;
  }
  const upcoming = world.gatherings.filter((g) => g.upcoming);
  return upcoming.length === 1 ? upcoming[0] : null;
}

function oneLine(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/**
 * Recover her words from a non-envelope reply. If it's a JSON object with a
 * say, use that; if it's a bare `{"say":"..."}` we half-parsed, pull the value;
 * otherwise the whole trimmed text is what she said.
 */
function plainSay(text: string): string {
  const val = parseJsonLoose(text);
  if (val && typeof val === "object" && typeof (val as Record<string, unknown>).say === "string") {
    return ((val as Record<string, unknown>).say as string).trim();
  }
  const m = text.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) return m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
  return text.trim();
}
