// lois/persist — the run trace written to disk as it happens (D-119).
//
// One JSONL file beside the vault: every bus event appended the moment it
// lands, same append-only discipline as the vault stream. What this buys:
//   - her conversation survives a restart (the trace IS the thread);
//   - timings become history ("typical 2s, worst 7s"), not RAM that dies;
//   - the chat budget is checkable against real days, not one dev session.
//
// Node-side only (the server/CLI call this; the face never touches disk).
// Rehydration rebuilds a Trace with the same events and a correct cursor.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Trace, type TraceEvent } from "../packages/lois/trace.js";

export function tracePath(vaultDir: string): string {
  return resolve(vaultDir, "run-trace.jsonl");
}

/**
 * A Trace whose every event also lands on disk, and which starts from
 * whatever the file already holds (seeded silently — history is not replayed
 * into the live stream). `extraSink` still fires per new event (the SSE
 * stream in the dev server rides it).
 */
export function openPersistentTrace(vaultDir: string, extraSink?: (e: TraceEvent) => void): Trace {
  return openPersistentTraceFile(tracePath(vaultDir), extraSink);
}

/** A persistent trace at an exact caller-owned path (used by isolated runs). */
export function openPersistentTraceFile(path: string, extraSink?: (e: TraceEvent) => void): Trace {
  const seed = readPersistedEventsFile(path);
  return new Trace((e) => {
    appendFileSync(path, JSON.stringify(e) + "\n", "utf8");
    extraSink?.(e);
  }, seed);
}

/** Read all persisted events for a vault (for rehydration or reporting). */
export function readPersistedEvents(vaultDir: string): TraceEvent[] {
  return readPersistedEventsFile(tracePath(vaultDir));
}

/** Read persisted events from an exact caller-owned trace path. */
export function readPersistedEventsFile(path: string): TraceEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TraceEvent);
}

/**
 * The timing report, from real history: per turn (heard -> its done marker),
 * how long to the first say and to the end. Derived, never stored — the same
 * projection law as everything else.
 */
export interface TurnTiming {
  at: string;
  message: string;
  /** ms from heard to the mouth's reply event (≈ answer complete). */
  toReply?: number;
}

export function timingReport(events: TraceEvent[]): { turns: TurnTiming[]; typicalMs?: number; worstMs?: number } {
  const turns: TurnTiming[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind !== "heard") continue;
    const t0 = new Date(e.at).getTime();
    const reply = events.slice(i + 1).find((x) => x.kind === "model.reply" && x.actor === "lois" && x.label.startsWith("turn:"));
    turns.push({
      at: e.at,
      message: e.label,
      toReply: reply ? new Date(reply.at).getTime() - t0 : undefined,
    });
  }
  const done = turns.map((t) => t.toReply).filter((n): n is number => n !== undefined).sort((a, b) => a - b);
  return {
    turns,
    typicalMs: done.length > 0 ? done[Math.floor(done.length / 2)] : undefined,
    worstMs: done.length > 0 ? done[done.length - 1] : undefined,
  };
}
