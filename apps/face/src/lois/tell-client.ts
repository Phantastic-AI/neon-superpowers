// lois/tell-client — the face's line to the one brain, STREAMING (D-111, D-113).
//
// POST /api/lois/tell answers over SSE: `say` deltas the moment she writes them
// (measured TTFT ~0.9s — the latency law), `bus` events for trace-aware
// consumers, then the full `turn`. The key stays server-side. No canned
// fallback: a dead brain arrives as ok:false with why, and the console says so honestly.

import type { MindOutput } from "../../../../packages/lois/mind.js";

export interface BusLine {
  seq: number;
  actor: string;
  kind: string;
  label: string;
}

export interface TellResponse {
  ok: boolean;
  why?: string;
  output?: MindOutput;
  traceTail: BusLine[];
  /** Wall-clock for the whole turn, from the server — the EBS actual. */
  ms?: number;
}

export interface TellHooks {
  /** Her words, as she writes them. */
  onSay?: (delta: string) => void;
  /** A worker spoke (critic, goldfish, gate). Customer surfaces leave this unset. */
  onBus?: (line: BusLine) => void;
}

export async function tellLois(message: string, hooks: TellHooks = {}): Promise<TellResponse> {
  const res = await fetch("/api/lois/tell", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok || !res.body) {
    let why = `the line to Lois's brain failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) why = `the line to Lois's brain failed: ${body.error}`;
    } catch {
      // keep the status-line reason
    }
    return { ok: false, why, traceTail: [] };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let turn: TellResponse | null = null;

  const handle = (event: string, data: string) => {
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (event === "say" && typeof parsed.delta === "string") hooks.onSay?.(parsed.delta);
      else if (event === "bus") hooks.onBus?.(parsed as unknown as BusLine);
      else if (event === "turn") turn = parsed as unknown as TellResponse;
    } catch {
      // malformed frame; skip
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line; each carries event: + data:.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) handle(event, data);
    }
  }

  return turn ?? { ok: false, why: "the stream ended without a turn", traceTail: [] };
}
