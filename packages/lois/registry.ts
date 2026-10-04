// lois/registry — the evented metasystem's one mechanism (D-111, D-113).
//
// The trace IS the bus. A sense appends a `heard` event; the PUMP walks the bus
// and wakes every agent whose trigger matches; agents append their own events
// (proposals, verdicts, holds) as they work; the pump keeps walking until the
// bus goes quiet. The mouth, the critic, and the gate are all just agents on
// this one mechanism — nothing is hand-wired to anything.
//
// pi-agent principle: the whole coordination layer is this file, and it is
// small on purpose. An agent is a name, a trigger, and a run function; model-
// backed or deterministic is the agent's business (the gate is deterministic
// and that is LEGITIMATE determinism — the hands' guard; the mouth and critic
// are model-backed, per the supple law).

import type { Trace, TraceEvent } from "./trace.js";
import type { World } from "../../tools/projections/types.js";

export interface WakeContext {
  /** The vault world (durable truth) the agent reads. */
  world: World;
  /** The bus: append what you did, read what others did. */
  trace: Trace;
  /** Cancellation (D-119): aborts in-flight model calls, stops the cascade. */
  signal?: AbortSignal;
}

export type AgentRole = "mouth" | "worker" | "gate";

export interface AgentSpec {
  /** Stable name — the actor on every event this agent emits. */
  name: string;
  role: AgentRole;
  /** One line: what this agent is for. */
  purpose: string;
  /** Does this event concern me? Pure and cheap — no model call here. */
  triggersOn: (event: TraceEvent) => boolean;
  /** Take one turn on the triggering event. Append everything observable. */
  run: (ctx: WakeContext, event: TraceEvent) => Promise<void>;
}

export class Registry {
  private readonly specs: AgentSpec[] = [];

  register(spec: AgentSpec): this {
    if (this.specs.some((s) => s.name === spec.name)) throw new Error(`registry: duplicate agent "${spec.name}"`);
    this.specs.push(spec);
    return this;
  }

  /** Introspection: what agents exist — the "what's in the brain" view. */
  roster(): { name: string; role: AgentRole; purpose: string }[] {
    return this.specs.map((s) => ({ name: s.name, role: s.role, purpose: s.purpose }));
  }

  /**
   * The pump. Walk the bus from `fromSeq`, waking every matching agent on every
   * event, including events appended DURING this pump (the cascade: heard wakes
   * the mouth, her proposal wakes the critic and the gate). Runs until the bus
   * is quiet. A throwing agent is isolated as a trace note; the cap is a
   * runaway backstop, far above any real cascade.
   */
  async pump(ctx: WakeContext, fromSeq: number): Promise<void> {
    let cursor = fromSeq;
    let guard = 0;
    while (cursor < ctx.trace.cursor) {
      if (++guard > 200) {
        ctx.trace.append({ actor: "pump", kind: "note", label: "cascade cap hit (200 waves) — stopping the pump" });
        return;
      }
      if (ctx.signal?.aborted) {
        ctx.trace.append({ actor: "pump", kind: "note", label: "cancelled by the organizer — cascade stopped" });
        return;
      }
      const wave = ctx.trace.since(cursor);
      cursor = ctx.trace.cursor;
      for (const event of wave) {
        for (const spec of this.specs) {
          if (spec.name === event.actor) continue; // agents don't wake on their own events
          if (!spec.triggersOn(event)) continue;
          ctx.trace.append({ actor: spec.name, kind: "woke", label: `on: ${event.label}`, refs: [event.seq] });
          try {
            await spec.run(ctx, event);
          } catch (err) {
            ctx.trace.append({ actor: spec.name, kind: "note", label: `failed: ${err instanceof Error ? err.message : String(err)}` });
          }
        }
      }
    }
  }
}
