// lois/trace — the observability substrate (D-111). "Observing this system is
// gonna be rough so if we don't set up the scaffold we have nothing."
//
// The principle (pi-recorder, 5.6's "capture now, execute replay later"): every
// wake, every context assembled, every model call, every tool call, every
// proposal, every gate decision lands as an immutable, seq-ordered TraceEvent on
// an append-only run trace. This is the SECOND append-log in the system, and its
// job is different from the vault stream:
//
//   - the VAULT stream (world.ts / stream.jsonl) is durable world TRUTH — who
//     exists, what was learned, what was drafted/approved/landed.
//   - the RUN trace (this file) is per-run runtime EVIDENCE — what Lois saw,
//     what she asked the model, what it said, why she acted. It is the bus the
//     agents of one run coordinate over, AND the thing a live view projects.
//
// Both are append-only, both carry a cursor. The trace is never the source of
// truth for the world (5.6's caveat: the recorder's snapshot is a projection,
// not history) — durable facts still land on the vault stream via the one write
// path. The trace is how we SEE the run, and the raw material recursive
// self-improvement learns from (traces + human edits + EBS actuals, D-093).
//
// Local-only: a run trace over his real vault carries real detail. It is runtime
// output, never committed, never published. Rendered console output stays
// PII-light by default (first names, counts), matching tools.ts's discipline.

// ---------------------------------------------------------------------------
// The event shape — one immutable line of runtime evidence.
// ---------------------------------------------------------------------------

/**
 * The kinds of thing worth seeing. Deliberately small — each names a moment the
 * pi-recorder would capture. `context` and `model.*` exist because 5.6 was
 * explicit: you cannot reconstruct WHY the model acted from tool traces alone —
 * you need the assembled context, the model id, and the prompt digest too.
 */
export type TraceKind =
  | "heard" //       an ingress event: a sense landed something (chat, wave, rsvp)
  | "woke" //        an agent began a turn (label = why it woke)
  | "context" //     the brief/state assembled for a model call (the turn-compiler output)
  | "model.call" //  a model request: model id, prompt digest, full prompt (local)
  | "model.reply" // the model's reply + any parsed decision
  | "tool.call" //   a tool invocation: name + args
  | "tool.return" // a tool result: the PII-light observation
  | "proposed" //    a proposal emitted (draft | plan) — the PROPOSE side of the one line
  | "gate" //        a gate decision (tier, allow | hold) — the COMMIT side of the one line
  | "note"; //       anything else worth seeing

export interface TraceEvent {
  /** Append cursor — the trace's total order (integer, 0-based). */
  seq: number;
  /** When appended, ISO 8601. Runtime code, so Date is available here. */
  at: string;
  /** Which agent/component emitted this — "lois", a worker name, "gate". */
  actor: string;
  kind: TraceKind;
  /** One-line, human-legible summary — what a person reads in the timeline. */
  label: string;
  /**
   * Structured detail, kind-owned. For model.call: { model, promptDigest,
   * prompt }. For tool.call: { tool, args }. For proposed: { kind, digest }.
   * For gate: { tier, decision }. Kept off the default render (PII / bulk).
   */
  detail?: Record<string, unknown>;
  /** Other event seqs this relates to (a reply refs its call; a gate refs its proposal). */
  refs?: number[];
}

/** What an emitter passes; seq/at are stamped by the trace. */
export type TraceInput = Omit<TraceEvent, "seq" | "at">;

// ---------------------------------------------------------------------------
// Trace — the append-only run trace. Append, read, subscribe.
// ---------------------------------------------------------------------------

export class Trace {
  private readonly events: TraceEvent[] = [];
  private readonly sink?: (e: TraceEvent) => void;

  /**
   * sink: called on every append, so a live view can stream (push, not poll).
   * seed: events rehydrated from disk (persist.ts) — loaded WITHOUT firing the
   * sink, so a restart does not replay history into the live stream.
   */
  constructor(sink?: (e: TraceEvent) => void, seed?: TraceEvent[]) {
    this.sink = sink;
    if (seed) this.events.push(...seed);
  }

  /** Append one immutable event, stamped with the next seq and the wall clock. */
  append(input: TraceInput): TraceEvent {
    const e: TraceEvent = { seq: this.events.length, at: new Date().toISOString(), ...input };
    this.events.push(e);
    this.sink?.(e);
    return e;
  }

  /** Every event in append order. The bus: a worker reads all() since its cursor. */
  all(): readonly TraceEvent[] {
    return this.events;
  }

  /** Events at-or-after a cursor — how one agent reads what happened since it last looked. */
  since(cursor: number): TraceEvent[] {
    return this.events.filter((e) => e.seq >= cursor);
  }

  /** The current cursor (= next seq to be assigned). */
  get cursor(): number {
    return this.events.length;
  }
}

// ---------------------------------------------------------------------------
// digest — a tiny, dependency-free content fingerprint (FNV-1a, 32-bit hex).
// ---------------------------------------------------------------------------

/**
 * Not cryptographic — just enough to answer "same prompt as last turn?" and to
 * bind a proposal to the exact content it carried (5.6's payload_digest idea, in
 * miniature) without dumping bulk text into the timeline. Pure, so it runs in
 * the face bundle too.
 */
export function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// renderTrace — the timeline, for the CLI. A live pane projects the same events.
// ---------------------------------------------------------------------------

const GLYPH: Record<TraceKind, string> = {
  heard: "»", //       » something landed from a sense
  woke: "◉", //        ◉ an agent turn opens
  context: "▦", //     ▦ state assembled
  "model.call": "→", // → asked the model
  "model.reply": "←", //← the model answered
  "tool.call": "⚙", //  ⚙ ran a tool
  "tool.return": "✓", //✓ tool returned
  proposed: "✎", //     ✎ a proposal (propose side)
  gate: "⛨", //         ⛨ a gate decision (commit side)
  note: "·", //         · a note
};

export interface RenderOptions {
  /** Show detail digests (model id, prompt digest, proposal digest). Default true. */
  showDigests?: boolean;
}

/**
 * A legible run timeline: one line per event, glyph + actor + label, with a
 * dim second line for the digest/model where it clarifies. PII-light by
 * construction — it renders `label`, which emitters keep to first-names/counts.
 */
export function renderTrace(trace: Trace, opts: RenderOptions = {}): string {
  const showDigests = opts.showDigests ?? true;
  const lines: string[] = [];
  for (const e of trace.all()) {
    const seq = String(e.seq).padStart(2, " ");
    lines.push(`${seq} ${GLYPH[e.kind]} ${e.actor.padEnd(6)} ${e.label}`);
    if (showDigests) {
      const d = e.detail ?? {};
      if (e.kind === "model.call" && (d.model || d.promptDigest)) {
        lines.push(`      ${dim(`${d.model ?? "model"} · prompt ${d.promptDigest ?? "?"}`)}`);
      } else if (e.kind === "proposed" && d.digest) {
        lines.push(`      ${dim(`content ${d.digest}`)}`);
      } else if (e.kind === "gate" && d.tier) {
        lines.push(`      ${dim(`tier ${d.tier} · ${d.decision ?? "?"}`)}`);
      }
    }
  }
  return lines.join("\n");
}

function dim(s: string): string {
  // ANSI dim; harmless in files/pipes, subtle in a terminal.
  return `[2m${s}[0m`;
}
