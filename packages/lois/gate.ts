// lois/gate — the hands' guard, as an agent on the same bus (D-086, D-111).
// Deterministic on purpose: the ONE place determinism is law, the
// proposal -> commit line. Everything proposed is held until the organizer's
// yes; in this slice nothing is ever delivered. The authoritative Rust tier
// classifier slots in behind this same event when real sends arm.

import type { AgentSpec } from "./registry.js";

export function theGate(): AgentSpec {
  return {
    name: "gate",
    role: "gate",
    purpose: "hold every proposal at the proposal -> commit line until the organizer's yes (D-086)",
    triggersOn: (event) => event.kind === "proposed",
    run: async (ctx, event) => {
      ctx.trace.append({
        actor: "gate",
        kind: "gate",
        label: "held for approval (D-086) — nothing is delivered in this slice",
        detail: { tier: "human-approval", decision: "hold" },
        refs: [event.seq],
      });
    },
  };
}
