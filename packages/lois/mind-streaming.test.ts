import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { createLoisModel } from "./model.js";
import { createLois, type LoisSystem } from "./system.js";

type ProviderStream = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"];
type Part = ProviderStream extends ReadableStream<infer Value> ? Value : never;
const systems: LoisSystem[] = [];
const answer = '{"say":"All set."}';
const finish = (reason: "stop" | "tool-calls" = "stop"): Part => ({
  type: "finish", finishReason: { unified: reason, raw: reason },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: undefined, reasoning: undefined },
  },
});
const answerParts = (): Part[] => [
  { type: "text-start", id: "answer" },
  { type: "text-delta", id: "answer", delta: answer },
  { type: "text-end", id: "answer" }, finish(),
];

async function start(onSay?: (delta: string) => void, nextStep?: (signal: AbortSignal) => void) {
  let controller!: ReadableStreamDefaultController<Part>;
  let signal!: AbortSignal;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const hand = vi.fn(async () => "Read complete.");
  const provider = new MockLanguageModelV4({
    doStream: async options => {
      if (provider.doStreamCalls.length > 1) {
        nextStep?.(options.abortSignal!);
        return { stream: new ReadableStream<Part>({ start(sink) { for (const part of answerParts()) sink.enqueue(part); sink.close(); } }) };
      }
      signal = options.abortSignal!;
      const stream = new ReadableStream<Part>({ start(sink) {
        controller = sink;
        signal.addEventListener("abort", () => sink.error(signal.reason), { once: true });
      } });
      started(); return { stream };
    },
  });
  const lois = createLois({
    world: { entries: [], persons: [], contexts: [], gatherings: [] },
    model: createLoisModel(provider), onSay,
    hands: { read_note: { description: "Read a local test note.", inputSchema: z.object({ value: z.string() }), run: hand } },
  });
  systems.push(lois);
  const turn = lois.tell("Read the note and report back.");
  await ready; await vi.advanceTimersByTimeAsync(0);
  const send = async (...parts: Part[]) => { for (const part of parts) controller.enqueue(part); await vi.advanceTimersByTimeAsync(0); };
  const end = async (...parts: Part[]) => { await send(...parts); controller.close(); await vi.advanceTimersByTimeAsync(0); };
  return { lois, provider, signal, turn, send, end, hand };
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const lois of systems) lois.cancel();
  await vi.advanceTimersByTimeAsync(0);
  await Promise.all(systems.splice(0).map(lois => lois.idle()));
  vi.useRealTimers();
});

describe("Lois streaming watchdog through the SDK", () => {
  it.each([false, true])("accepts a 140-second healthy text stream (say callback: %s)", async withSay => {
    const onSay = withSay ? vi.fn() : undefined;
    const run = await start(onSay);
    await run.send({ type: "text-start", id: "answer" });
    await vi.advanceTimersByTimeAsync(70_000);
    await run.send({ type: "text-delta", id: "answer", delta: '{"say":"All ' });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(run.signal.aborted).toBe(false);
    await run.end({ type: "text-delta", id: "answer", delta: 'set."}' }, { type: "text-end", id: "answer" }, finish());
    await expect(run.turn).resolves.toMatchObject({ ok: true, output: { say: "All set." } });
    expect(run.provider.doStreamCalls).toHaveLength(1);
    if (onSay) expect(onSay.mock.calls.flat().join("")).toBe("All set.");
    const replies = run.lois.trace.all().filter(event => event.kind === "model.reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]!.detail).toMatchObject({ ms: 140_000, streamProgress: {
      chunks: { text: 2, reasoning: 0, toolInput: 0 }, firstChunkMs: 70_000, lastChunkMs: 140_000,
    } });
  });

  it("renews on reasoning deltas without recording their content", async () => {
    const run = await start();
    await run.send({ type: "reasoning-start", id: "reason" });
    await vi.advanceTimersByTimeAsync(70_000);
    await run.send({ type: "reasoning-delta", id: "reason", delta: "PRIVATE_REASONING_ONE" });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(run.signal.aborted).toBe(false);
    await run.end({ type: "reasoning-delta", id: "reason", delta: "PRIVATE_REASONING_TWO" }, { type: "reasoning-end", id: "reason" }, ...answerParts());
    await expect(run.turn).resolves.toMatchObject({ ok: true });
    const trace = run.lois.trace.all();
    expect(trace.find(event => event.kind === "model.reply")!.detail).toMatchObject({ streamProgress: {
      chunks: { text: 1, reasoning: 2, toolInput: 0 }, firstChunkMs: 70_000, lastChunkMs: 140_000,
    } });
    expect(JSON.stringify(trace)).not.toContain("PRIVATE_REASONING");
  });

  it("renews while tool input streams, before the hand can execute", async () => {
    const run = await start();
    await run.send({ type: "tool-input-start", id: "read-1", toolName: "read_note" });
    await vi.advanceTimersByTimeAsync(70_000);
    await run.send({ type: "tool-input-delta", id: "read-1", delta: '{"value":"PRIVATE_' });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(run.signal.aborted).toBe(false); expect(run.hand).not.toHaveBeenCalled();
    await run.end(
      { type: "tool-input-delta", id: "read-1", delta: 'INPUT"}' }, { type: "tool-input-end", id: "read-1" },
      { type: "tool-call", toolCallId: "read-1", toolName: "read_note", input: '{"value":"PRIVATE_INPUT"}' }, finish("tool-calls"),
    );
    await expect(run.turn).resolves.toMatchObject({ ok: true });
    expect(run.hand).toHaveBeenCalledOnce();
    const trace = run.lois.trace.all();
    expect(trace.find(event => event.kind === "model.reply")!.detail).toMatchObject({ streamProgress: {
      chunks: { text: 1, reasoning: 0, toolInput: 2 }, firstChunkMs: 70_000, lastChunkMs: 140_000,
    } });
    expect(JSON.stringify(trace)).not.toContain("PRIVATE_INPUT");
  });

  it("still times out silence at 75 seconds and records a content-free diagnostic", async () => {
    const run = await start();
    await vi.advanceTimersByTimeAsync(74_999); expect(run.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(run.signal.aborted).toBe(true);
    await expect(run.turn).resolves.toMatchObject({ ok: false, why: expect.stringContaining("no progress for 75s") });
    expect(run.lois.trace.all().find(event => event.label.includes("brain stalled"))!.detail).toEqual({
      ms: 75_000, streamProgress: { chunks: { text: 0, reasoning: 0, toolInput: 0 }, firstChunkMs: null, lastChunkMs: null },
    });
  });

  it("does not treat empty deltas or provider metadata as progress", async () => {
    const run = await start();
    await run.send({ type: "text-start", id: "text" }, { type: "reasoning-start", id: "reason" }, { type: "tool-input-start", id: "read", toolName: "read_note" });
    await vi.advanceTimersByTimeAsync(70_000);
    await run.send(
      { type: "text-delta", id: "text", delta: "" }, { type: "reasoning-delta", id: "reason", delta: "" },
      { type: "tool-input-delta", id: "read", delta: "" }, { type: "response-metadata", id: "PRIVATE_METADATA" },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run.signal.aborted).toBe(true);
    await expect(run.turn).resolves.toMatchObject({ ok: false, why: expect.stringContaining("no progress for 75s") });
    const note = run.lois.trace.all().find(event => event.label.includes("brain stalled"))!;
    expect(note.detail).toEqual({ ms: 75_000, streamProgress: { chunks: { text: 0, reasoning: 0, toolInput: 0 }, firstChunkMs: null, lastChunkMs: null } });
    expect(JSON.stringify(note)).not.toContain("PRIVATE_METADATA");
  });

  it("times out 75 seconds after the last meaningful chunk, with the observed timing retained", async () => {
    const run = await start();
    await run.send({ type: "reasoning-start", id: "reason" });
    await vi.advanceTimersByTimeAsync(10_000);
    await run.send({ type: "reasoning-delta", id: "reason", delta: "PRIVATE_REASONING" });
    await vi.advanceTimersByTimeAsync(74_999); expect(run.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(run.signal.aborted).toBe(true);
    await expect(run.turn).resolves.toMatchObject({ ok: false, why: expect.stringContaining("no progress for 75s") });
    expect(run.lois.trace.all().find(event => event.label.includes("brain stalled"))!.detail).toEqual({
      ms: 85_000, streamProgress: { chunks: { text: 0, reasoning: 1, toolInput: 0 }, firstChunkMs: 10_000, lastChunkMs: 10_000 },
    });
    expect(JSON.stringify(run.lois.trace.all())).not.toContain("PRIVATE_REASONING");
  });

  it("still honors organizer cancellation during a healthy stream", async () => {
    const run = await start();
    await vi.advanceTimersByTimeAsync(10_000);
    await run.send({ type: "reasoning-start", id: "reason" }, { type: "reasoning-delta", id: "reason", delta: "PRIVATE_REASONING" });
    run.lois.cancel(); await vi.advanceTimersByTimeAsync(0);
    expect(run.signal.aborted).toBe(true);
    await expect(run.turn).resolves.toMatchObject({ ok: false, why: "cancelled by the organizer mid-turn" });
    expect(run.lois.trace.all().find(event => event.label.includes("cancelled by the organizer"))!.detail).toEqual({
      ms: 10_000, streamProgress: { chunks: { text: 0, reasoning: 1, toolInput: 0 }, firstChunkMs: 10_000, lastChunkMs: 10_000 },
    });
  });

  it.each([false, true])("rejects prior-step speech when the organizer cancels in step two (say callback: %s)", async withSay => {
    const run = await start(withSay ? vi.fn() : undefined, signal => {
      run.lois.cancel(); signal.throwIfAborted();
    });
    await run.end(
      { type: "text-start", id: "progress" },
      { type: "text-delta", id: "progress", delta: '{"say":"I am reading it now."}' },
      { type: "text-end", id: "progress" },
      { type: "tool-call", toolCallId: "read-1", toolName: "read_note", input: '{"value":"a note"}' }, finish("tool-calls"),
    );
    expect(run.hand).toHaveBeenCalledOnce(); expect(run.provider.doStreamCalls).toHaveLength(2);
    await expect(run.turn).resolves.toEqual({ ok: false, why: "cancelled by the organizer mid-turn" });
    expect(run.lois.trace.all().filter(event => event.kind === "model.reply" || event.kind === "proposed")).toEqual([]);
    expect(run.lois.trace.all().find(event => event.label.includes("cancelled by the organizer"))!.detail).toMatchObject({
      streamProgress: { chunks: { text: 1, reasoning: 0, toolInput: 0 } },
    });
  });
});
