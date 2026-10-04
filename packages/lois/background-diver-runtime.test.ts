import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { AsyncLocalStorage } from "node:async_hooks";
import { Trace } from "./trace.js";
import { openVault } from "../vault/store.js";
import { loadWorld } from "../vault/world.js";
import { createRuntimeHands, resolveSidecarRuntime, cancelRuntimeDiver, idleRuntimeDiver, readRuntimeDiverJob } from "../../sidecar/runtime.js";
import { createLois, type LoisSystem } from "./system.js";
import { createLoisModel } from "./model.js";
import type { WorkerSettlement } from "../../sidecar/background-diver.js";
import { closeSidecar, createLoisServer, type BuiltSidecar } from "../../sidecar/server.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "lois-background-test-"));
  roots.push(root);
  const runtime = resolveSidecarRuntime({ LOIS_VAULT_DIR: resolve(root, "vault"), LOIS_BROWSER_WORKSPACE_ROOT: resolve(root, "browser") });
  return { runtime, world: loadWorld(openVault(runtime.vaultDir)), trace: new Trace() };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const complete = () => ({
  text: JSON.stringify({ status: "complete", goalCategory: "live_readonly_canary", summary: "The test research is complete.", evidence: ["test-observation"], evidenceCategories: ["browser_frame"] }),
  steps: 2, toolCalls: 1, hostEvidenceCategories: ["browser_frame"],
});

describe("background diver launch contract", () => {
  it("drains cancelled research before ordinary sidecar shutdown closes its browser", async () => {
    const { runtime, world, trace } = fixture();
    const held = deferred();
    let signal: AbortSignal | undefined;
    const closed = vi.fn(async () => "closed");
    runtime.dive.dive_close = closed;
    const hands = createRuntimeHands(runtime, world, {
      model: {} as never, trace,
      runModel: async input => { signal = input.signal; await held.promise; return complete(); },
    });
    const system = createLois({ world, model: null, trace, hands, onCancel: () => cancelRuntimeDiver(runtime) });
    const built = { system, world, runtime, vaultDir: runtime.vaultDir } as BuiltSidecar;
    const server = createLoisServer(built);
    await hands.dive.run({ intent: "Read the source." });
    const shutdown = closeSidecar(server, built);
    expect(signal?.aborted).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    held.release();
    await shutdown;
    expect(closed).toHaveBeenCalledOnce();
    expect(JSON.parse(await hands.research_status.run({}))).toMatchObject({ status: "blocked", active: false });
  });

  it("returns the persisted launch receipt while the worker is still running", async () => {
    const { runtime, world, trace } = fixture();
    const held = deferred();
    const settled = vi.fn();
    const hands = createRuntimeHands(runtime, world, {
      model: {} as never, trace,
      onWorkerSettled: settled,
      runModel: async ({ capabilities }) => {
        await capabilities.remember_world.run({ name: "Research World", lane: "social", anchor: "email", requestId: "background-world" });
        await held.promise;
        return complete();
      },
    });
    let receipt: Record<string, unknown> | undefined;
    const launched = hands.dive.run({ intent: "Build my research World." }).then(value => { receipt = JSON.parse(value); });
    try {
      await vi.waitFor(() => expect(receipt).toMatchObject({ status: "running", accepted: true }), { timeout: 150 });
      const saved = JSON.parse(readFileSync(runtime.diverStatePath, "utf8"));
      expect(saved).toMatchObject({ id: receipt!.jobId, status: "running" });
      expect(settled).not.toHaveBeenCalled();
      const status = JSON.parse(await hands.research_status.run({}));
      expect(status).toMatchObject({ jobId: receipt!.jobId, status: "running", progress: { completedCalls: 1, lastTool: "remember_world" } });
      expect(openVault(runtime.vaultDir).contexts.map(context => context.name)).toEqual(["Research World"]);
    } finally {
      held.release();
      await launched;
    }
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
  });

  it("does not launch a duplicate flight when Lois asks about active work", async () => {
    const { runtime, world, trace } = fixture();
    const held = deferred();
    const runModel = vi.fn(async () => { await held.promise; return complete(); });
    const hands = createRuntimeHands(runtime, world, { model: {} as never, trace, runModel });
    let first: Record<string, unknown> | undefined;
    const launch = hands.dive.run({ intent: "Read the selected sources." }).then(value => { first = JSON.parse(value); });
    try {
      await vi.waitFor(() => expect(first?.status).toBe("running"), { timeout: 150 });
      const again = JSON.parse(await hands.dive.run({ intent: "Actually, inspect a different source." }));
      expect(again).toMatchObject({ jobId: first!.jobId, status: "running", alreadyRunning: true, requestApplied: false });
      expect(runModel).toHaveBeenCalledOnce();
    } finally { held.release(); await launch; }
    await idleRuntimeDiver(runtime);
  });

  it("does not acknowledge an old job when the new launch cannot be persisted", async () => {
    const { runtime, world, trace } = fixture();
    const runModel = vi.fn(async () => complete());
    const hands = createRuntimeHands(runtime, world, {
      model: {} as never, trace, runModel,
      store: {
        load: () => ({ version: 1, id: "old-job", intent: "Earlier work", status: "complete", createdAt: 1, updatedAt: 2, hostEvidenceCategories: [], continuations: [] }),
        save: () => { throw new Error("test disk unavailable"); },
      },
    });
    await expect(hands.dive.run({ intent: "Start new research." })).rejects.toThrow("test disk unavailable");
    await idleRuntimeDiver(runtime);
    expect(runModel).not.toHaveBeenCalled();
  });

  it("keeps explicit cancellation durable and ignores a late successful model result", async () => {
    const { runtime, world, trace } = fixture();
    const held = deferred();
    const settled = vi.fn();
    let workerSignal: AbortSignal | undefined;
    const hands = createRuntimeHands(runtime, world, {
      model: {} as never, trace, onWorkerSettled: settled,
      runModel: async ({ signal }) => { workerSignal = signal; await held.promise; return complete(); },
    });
    const foreground = new AbortController();
    await hands.dive.run({ intent: "Collect the source." }, { signal: foreground.signal });
    foreground.abort();
    expect(workerSignal?.aborted).toBe(false);
    expect(JSON.parse(await hands.research_cancel.run({}))).toMatchObject({ cancelled: true });
    expect(workerSignal?.aborted).toBe(true);
    expect(JSON.parse(await hands.research_status.run({}))).toMatchObject({ status: "blocked", summary: "The dive was cancelled." });
    held.release();
    await idleRuntimeDiver(runtime);
    expect(settled).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(runtime.diverStatePath, "utf8"))).toMatchObject({ status: "blocked" });
  });

  it.each(["partial", "awaiting_human"] as const)("stops a settled %s job before a browser wake or changed request", async status => {
    const { runtime, world, trace } = fixture();
    const runModel = vi.fn(async () => ({ ...complete(), text: JSON.stringify({ status, goalCategory: "live_readonly_canary", summary: "Old work is waiting.", next: "Continue old work.", evidence: [], evidenceCategories: [] }) }));
    const hands = createRuntimeHands(runtime, world, { model: {} as never, trace, runModel });
    const first = JSON.parse(await hands.dive.run({ intent: "Old scope." }));
    await idleRuntimeDiver(runtime);
    expect(JSON.parse(await hands.research_status.run({}))).toMatchObject({ status });
    expect(JSON.parse(await hands.research_cancel.run({}))).toMatchObject({ cancelled: true, job: { status: "blocked" } });
    expect(JSON.parse(await hands.research_cancel.run({}))).toMatchObject({ cancelled: false, job: { status: "blocked" } });
    runtime.dive.dive_emit_continue({ type: "diver.continue", reason: "owned_download_captured", key: "late-after-stop", at: Date.now() + 1,
      controlEpoch: 1, navigationEpoch: 1, attemptId: "late", artifactEpoch: 1 });
    await idleRuntimeDiver(runtime);
    expect(runModel).toHaveBeenCalledOnce();
    const changed = JSON.parse(await hands.dive.run({ intent: "Different scope." }));
    await idleRuntimeDiver(runtime);
    expect(changed.jobId).not.toBe(first.jobId);
    expect(changed.intent).toBe("Different scope.");
    expect(changed.continuations).toEqual([]);
  });

  it("preserves a settled human wait when shutting down rather than stopping the goal", async () => {
    const { runtime, world, trace } = fixture();
    runtime.dive.dive_close = vi.fn(async () => "closed");
    const hands = createRuntimeHands(runtime, world, { model: {} as never, trace,
      runModel: async () => ({ ...complete(), text: JSON.stringify({ status: "awaiting_human", goalCategory: "live_readonly_canary", summary: "Sign in when ready.", evidence: [], evidenceCategories: [] }) }) });
    await hands.dive.run({ intent: "Read the selected source." });
    await idleRuntimeDiver(runtime);
    const system = createLois({ world, model: null, trace, hands, onCancel: () => cancelRuntimeDiver(runtime) });
    const built = { system, world, runtime, vaultDir: runtime.vaultDir } as BuiltSidecar;
    await closeSidecar(createLoisServer(built), built);
    expect(JSON.parse(readFileSync(runtime.diverStatePath, "utf8"))).toMatchObject({ status: "awaiting_human" });
  });

  it("resumes a persisted partial job without discarding its saved progress", async () => {
    const { runtime, world, trace } = fixture();
    const workingMessages = [{ role: "user" as const, content: "private source artifact-123" }];
    const settled = vi.fn();
    const first = createRuntimeHands(runtime, world, {
      model: {} as never, trace, onWorkerSettled: settled,
      runModel: async ({ capabilities }) => {
        await capabilities.remember_world.run({ name: "Known World", lane: "social", anchor: "email", requestId: "partial-world" });
        return { ...complete(), workingMessages, text: JSON.stringify({ status: "partial", goalCategory: "local_world", summary: "The World is saved, further work remains.", next: "Continue source research.", evidence: [], evidenceCategories: [] }) };
      },
    });
    const receipt = JSON.parse(await first.dive.run({ intent: "Research the World." }));
    await idleRuntimeDiver(runtime);
    expect(JSON.parse(readFileSync(runtime.diverStatePath, "utf8")).workingMessages).toEqual(workingMessages);
    expect(statSync(runtime.diverStatePath).mode & 0o777).toBe(0o600);
    expect(readRuntimeDiverJob(runtime)).not.toHaveProperty("workingMessages");
    expect(await first.research_status.run({})).not.toContain("private source");
    const resumed = createRuntimeHands(runtime, world, {
      model: {} as never, trace, onWorkerSettled: settled,
      runModel: async ({ prompt, workingMessages: retained }) => {
        expect(prompt).toContain("The World is saved, further work remains.");
        expect(prompt).toContain("Previous suggested next action (not yet executed): Continue source research.");
        expect(retained).toEqual(workingMessages);
        return complete();
      },
    });
    expect(JSON.parse(await resumed.dive.run({ intent: "Continue from the saved World." })).jobId).toBe(receipt.jobId);
    await idleRuntimeDiver(runtime);
    expect(settled).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await resumed.research_status.run({}))).toMatchObject({ status: "complete", progress: { completedCalls: 1 } });
    expect(openVault(runtime.vaultDir).contexts).toHaveLength(1);
  });

  it("keeps the worker's originating inference scope while another mouth turn runs", async () => {
    const { runtime, world, trace } = fixture();
    const held = deferred();
    const scope = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    const hands = createRuntimeHands(runtime, world, {
      model: {} as never, trace,
      runModel: async () => { seen.push(scope.getStore()); await held.promise; seen.push(scope.getStore()); return complete(); },
    });
    await scope.run("research-origin", () => hands.dive.run({ intent: "Read the source." }));
    await scope.run("second-mouth-turn", () => hands.research_status.run({}));
    held.release();
    await idleRuntimeDiver(runtime);
    expect(seen).toEqual(["research-origin", "research-origin"]);
  });

  it("records delivery failure instead of losing it as an unhandled promise", async () => {
    const { runtime, world, trace } = fixture();
    const hands = createRuntimeHands(runtime, world, {
      model: {} as never, trace, runModel: async () => complete(),
      onWorkerSettled: async () => { throw new Error("test mouth unavailable"); },
    });
    await hands.dive.run({ intent: "Read the source." });
    await idleRuntimeDiver(runtime);
    expect(trace.all()).toEqual(expect.arrayContaining([expect.objectContaining({ label: "research result delivery failed", detail: expect.objectContaining({ error: "test mouth unavailable" }) })]));
  });
});

describe("real mouth loop with a background worker", () => {
  it("cancels a worker result already queued behind an organizer turn", async () => {
    const { runtime, world, trace } = fixture();
    const mouthHeld = deferred();
    const workerHeld = deferred();
    const provider = new MockLanguageModelV4({ doStream: async () => {
      await mouthHeld.promise;
      return { stream: new ReadableStream({ start(sink) {
        sink.enqueue({ type: "text-start", id: "say" });
        sink.enqueue({ type: "text-delta", id: "say", delta: '{"say":"Your current answer."}' });
        sink.enqueue({ type: "text-end", id: "say" });
        sink.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: undefined, reasoning: undefined } } });
        sink.close();
      } }) };
    } });
    let lois!: LoisSystem;
    const settled = vi.fn(async ({ report, jobId, signal }: WorkerSettlement) => { await lois.continueFromWorker(report, { jobId }, signal); });
    const hands = createRuntimeHands(runtime, world, {
      model: {} as never, trace,
      runModel: async () => { await workerHeld.promise; return complete(); },
      onWorkerSettled: settled,
    });
    lois = createLois({ world, model: createLoisModel(provider), hands, trace });
    const foreground = lois.tell("Talk to me while the worker finishes.");
    await hands.dive.run({ intent: "Read one source." });
    workerHeld.release();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    createRuntimeHands(runtime, world, { model: null, trace });
    cancelRuntimeDiver(runtime);
    expect(settled.mock.calls[0][0].signal.aborted).toBe(true);
    mouthHeld.release();
    await foreground;
    await idleRuntimeDiver(runtime);
    await lois.idle();
    expect(trace.all().filter(event => event.kind === "heard" && event.actor === "diver")).toEqual([]);
    expect(provider.doStreamCalls).toHaveLength(1);
    expect(trace.all().some(event => event.label === "research result delivery failed")).toBe(false);
  });

  it("answers a second organizer turn during research, then wakes once with the worker result", async () => {
    const { runtime, world, trace } = fixture();
    const held = deferred();
    type Stream = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"];
    type Part = Stream extends ReadableStream<infer Value> ? Value : never;
    const finish = (reason: "stop" | "tool-calls"): Part => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: undefined, reasoning: undefined } } });
    const provider = new MockLanguageModelV4({ doStream: async () => {
      const n = provider.doStreamCalls.length;
      const parts: Part[] = n === 1 || n === 3
        ? [{ type: "tool-call", toolCallId: `call-${n}`, toolName: n === 1 ? "dive" : "research_status", input: n === 1 ? JSON.stringify({ intent: "Create the research World." }) : "{}" }, finish("tool-calls")]
        : [{ type: "text-start", id: `say-${n}` }, { type: "text-delta", id: `say-${n}`, delta: JSON.stringify({ say: n === 2 ? "I started the research." : n === 4 ? "One finding is saved; research continues." : "The research finished." }) }, { type: "text-end", id: `say-${n}` }, finish("stop")];
      return { stream: new ReadableStream<Part>({ start(sink) { for (const part of parts) sink.enqueue(part); sink.close(); } }) };
    } });
    let lois!: LoisSystem;
    const results: unknown[] = [];
    const hands = createRuntimeHands(runtime, world, {
      model: {} as never, trace,
      runModel: async ({ capabilities }) => {
        await capabilities.remember_world.run({ name: "My series", lane: "social", anchor: "email", requestId: "chatty-world" });
        await held.promise;
        return complete();
      },
      onWorkerSettled: async ({ report, jobId }) => { results.push(await lois.continueFromWorker(report, { jobId })); },
    });
    lois = createLois({ world, model: createLoisModel(provider), hands, trace, onCancel: () => cancelRuntimeDiver(runtime) });
    try {
      await expect(lois.tell("Build my research World.")).resolves.toMatchObject({ ok: true, output: { say: "I started the research." } });
      await lois.idle();
      expect(JSON.parse(await hands.research_status.run({})).status).toBe("running");
      await expect(lois.tell("What have you saved?")).resolves.toMatchObject({ ok: true, output: { say: "One finding is saved; research continues." } });
      await lois.idle();
      expect(JSON.stringify(provider.doStreamCalls[3].prompt)).toContain("remember_world");
    } finally { held.release(); await idleRuntimeDiver(runtime); await lois.idle(); }
    expect(results).toEqual([expect.objectContaining({ ok: true, output: expect.objectContaining({ say: "The research finished." }) })]);
    expect(trace.all().filter(event => event.kind === "heard" && event.actor === "diver")).toHaveLength(1);
    expect(JSON.stringify(provider.doStreamCalls.at(-1)!.prompt)).toContain("This worker invocation has ended");
    expect(JSON.stringify(provider.doStreamCalls.at(-1)!.prompt)).toContain("call dive to resume");
  });
});
