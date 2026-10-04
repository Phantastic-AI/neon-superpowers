import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer as createViteServer } from "vite";
import { Trace } from "../packages/lois/trace.js";
import type { BrowserInputResult } from "../tools/lois-dive.js";
import { browserJobState, createLoisServer, projectLoisJob, type BuiltSidecar } from "./server.js";
import type { World } from "../tools/projections/types.js";

const servers: ReturnType<typeof createLoisServer>[] = [];

const fakeWorld: World = {
  entries: [],
  persons: [],
  contexts: [
    {
      id: "3cs",
      name: "3Cs",
      kind: "social",
      anchor: "email",
      profile: "luma",
      created_at: "2026-08-29T00:00:00.000Z",
    },
  ],
  gatherings: [
    {
      id: "3cs-next",
      context: "3cs",
      name: "3Cs Dinner",
      date: "2026-09-18T01:30:00.000Z",
      upcoming: true,
    },
  ],
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

type PaneInput = (
  input: Parameters<BuiltSidecar["runtime"]["dive"]["dive_input"]>[0],
  owner?: "automation" | "pane",
) => Promise<BrowserInputResult>;

function fakeSidecar(
  diveInput: PaneInput,
  diveOverrides: Partial<BuiltSidecar["runtime"]["dive"]> = {},
  runtimeOverrides: Partial<Pick<BuiltSidecar["runtime"], "tracePath">> = {},
): BuiltSidecar {
  const unavailable = async () => "No browser window is open.";
  return {
    world: fakeWorld,
    vaultDir: "/tmp/fake-lois-vault",
    system: {
      tell: async () => ({ ok: false, why: "not used" }),
      cancel: () => undefined,
      idle: async () => undefined,
      trace: new Trace(),
      roster: () => [],
    },
    runtime: {
      mode: "smoke",
      runRoot: "/tmp/fake-lois-run",
      vaultDir: "/tmp/fake-lois-vault",
      tracePath: runtimeOverrides.tracePath ?? "/tmp/fake-lois-run/trace/run-trace.jsonl",
      browserStartUrl: "http://127.0.0.1:4319/luma",
      browserStartDescription: "fake",
      browserCloseDescription: "fake",
      dive: {
        dive_start: unavailable,
        dive_capture: unavailable,
        dive_status: unavailable,
        dive_close: unavailable,
        dive_summon: unavailable,
        dive_dismiss: unavailable,
        dive_observe: unavailable,
        dive_follow: unavailable,
        dive_prepare: unavailable,
        dive_input: diveInput,
        ...diveOverrides,
      },
    },
  } as BuiltSidecar;
}

async function listen(
  diveInput: PaneInput,
  diveOverrides: Partial<BuiltSidecar["runtime"]["dive"]> = {},
  runtimeOverrides: Partial<Pick<BuiltSidecar["runtime"], "tracePath">> = {},
): Promise<{ baseUrl: string }> {
  const server = createLoisServer(fakeSidecar(diveInput, diveOverrides, runtimeOverrides));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("Lois sidecar browser input route", () => {
  it("returns 400 for malformed input and 409 for a valid input without a browser lease", async () => {
    const diveInput = vi.fn(async () => ({ ok: false, note: "No browser window is open." }));
    const { baseUrl } = await listen(diveInput);

    const malformed = await fetch(`${baseUrl}/api/lois/browser/input`, {
      method: "POST",
      body: JSON.stringify({ type: "click", nx: 2, ny: 0.5 }),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ ok: false, note: "Invalid browser input." });
    expect(diveInput).not.toHaveBeenCalled();

    const leaseRefusal = await fetch(`${baseUrl}/api/lois/browser/input`, {
      method: "POST",
      body: JSON.stringify({ type: "click", nx: 0.5, ny: 0.5 }),
    });
    expect(leaseRefusal.status).toBe(409);
    expect(await leaseRefusal.json()).toMatchObject({ ok: false });
    expect(diveInput).toHaveBeenCalledOnce();
  });

  it("hands the same browser lease to the human and reconciles it back to the pane", async () => {
    const diveInput = vi.fn(async () => ({ ok: true, note: "not used" }));
    const summon = vi.fn(async () => "Her window is on-screen and in front, on http://127.0.0.1/mock.");
    const dismiss = vi.fn(async () => "Her window is off-screen again. The pane has control.");
    const { baseUrl } = await listen(diveInput, {
      dive_summon: summon,
      dive_dismiss: dismiss,
    });

    const summoned = await fetch(`${baseUrl}/api/lois/browser/summon`, { method: "POST" });
    expect(summoned.status).toBe(200);
    expect(await summoned.json()).toMatchObject({ ok: true, note: expect.stringContaining("on-screen") });

    const dismissed = await fetch(`${baseUrl}/api/lois/browser/dismiss`, { method: "POST" });
    expect(dismissed.status).toBe(200);
    expect(await dismissed.json()).toMatchObject({ ok: true, note: expect.stringContaining("off-screen again") });
    expect(summon).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledWith("pane");
  });
});

describe("Lois sidecar browser job state", () => {
  it.each([
    { mode: "embedded" as const, inputOwner: "automation" as const, open: true, state: "working" },
    { mode: "closed" as const, inputOwner: null, open: false, state: "working" },
    { mode: "foreground_hands" as const, inputOwner: "hands" as const, open: true, state: "waiting" },
  ])("keeps detached research visible with a $mode browser", ({ state, ...browser }) => {
    const job = { version: 1 as const, id: "background-job", intent: "Read selected sources.", status: "running" as const,
      createdAt: 10, updatedAt: 20, hostEvidenceCategories: [], continuations: [],
      progress: { completedCalls: 3, lastTool: "people_import", traceSeq: 15, at: 20 } };
    expect(projectLoisJob({ job, browser, artifactCount: 1, trace: [], turnActive: false })).toMatchObject({
      state, phase: "researching", progress: job.progress,
    });
    expect(projectLoisJob({ job: { ...job, status: "awaiting_human" }, browser, artifactCount: 1, trace: [], turnActive: false })).toMatchObject({
      state: "waiting", phase: "waiting", waitingOnHuman: true,
    });
  });

  it("distinguishes active browser work from an open or human-owned window", () => {
    expect(browserJobState({ mode: "embedded", inputOwner: "automation" }, true)).toBe("working");
    expect(browserJobState({ mode: "embedded", inputOwner: "automation" }, false)).toBe("open");
    expect(browserJobState({ mode: "foreground_hands", inputOwner: "hands" })).toBe("waiting");
    expect(browserJobState({ mode: "embedded", inputOwner: "pane" })).toBe("open");
    expect(browserJobState({ mode: "closed", inputOwner: null })).toBe("open");
  });

  it("projects lifecycle, blocker, artifact, lease, and speech readiness without transcript copy", () => {
    const trace = new Trace();
    trace.append({
      actor: "diver",
      kind: "model.reply",
      label: "dive complete",
      detail: { jobId: "9e0d19e3-3149-4ba0-9bf1-f4db91f1d287" },
    });
    trace.append({
      actor: "diver",
      kind: "heard",
      label: "worker result",
      detail: { text: "worker result", jobId: "9e0d19e3-3149-4ba0-9bf1-f4db91f1d287" },
    });
    trace.append({ actor: "lois", kind: "model.reply", label: "turn landed", detail: { say: "All set." } });

    const projected = projectLoisJob({
      job: {
        version: 1,
        id: "9e0d19e3-3149-4ba0-9bf1-f4db91f1d287",
        intent: "Build the series history.",
        status: "complete",
        createdAt: 10,
        updatedAt: 20,
        summary: "Series history built from owned exports.",
        hostEvidenceCategories: ["series_attendance_index"],
        continuations: [],
      },
      browser: { open: true, mode: "embedded", inputOwner: "automation", url: "https://lu.ma/home" },
      artifactCount: 3,
      trace: trace.all(),
    });

    expect(projected).toMatchObject({
      phase: "done",
      artifactCount: 3,
      waitingOnHuman: false,
      terminalSpeechReady: true,
      leaseMode: "embedded",
      leaseOwner: "automation",
    });
    expect(JSON.stringify(projected)).not.toContain("All set.");
  });
});

describe("Lois sidecar world route", () => {
  it("serves the exact world bound to this runtime", async () => {
    const { baseUrl } = await listen(async () => ({ ok: true, note: "not used" }));

    const response = await fetch(`${baseUrl}/api/lois/world`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ world: fakeWorld });

    const lookalike = await fetch(`${baseUrl}/api/lois/world-not-really`);
    expect(lookalike.status).toBe(404);
  });
});

describe("Lois sidecar trace projection", () => {
  it("projects persisted run-trace entries with per-turn latency and tool metrics", async () => {
    const runDir = mkdtempSync(resolve(tmpdir(), "superpowers-trace-"));
    const tracePath = resolve(runDir, "run-trace.jsonl");
    writeFileSync(tracePath, JSON.stringify({
      seq: 0,
      at: "2026-08-30T10:00:00.000Z",
      actor: "lois",
      kind: "model.call",
      label: "think (one run)",
      detail: { promptDigest: "abc" },
    }) + "\n" + JSON.stringify({
      seq: 1,
      at: "2026-08-30T10:00:00.050Z",
      actor: "lois",
      kind: "model.reply",
      label: "turn: 1 proposal(s), 0 memory claim(s), 0 question(s)",
      detail: {
        ms: 210,
        steps: 2,
        toolCalls: 1,
        usage: {
          inputTokens: 32,
          outputTokens: 16,
          totalTokens: 48,
          cacheReadTokens: 10,
          cacheWriteTokens: 2,
          reasoningTokens: 22,
          textTokens: 26,
        },
      },
    }) + "\n" + JSON.stringify({
      seq: 2,
      at: "2026-08-30T10:00:01.000Z",
      actor: "critic",
      kind: "note",
      label: "internal note",
    }) + "\n");

    const { baseUrl } = await listen(async () => ({ ok: true, note: "not used" }), {}, { tracePath });
    const response = await fetch(`${baseUrl}/api/lois/trace`);
    const projection = (await response.json()) as {
      ok: boolean;
      turns: Array<{ seq: number; latencyMs?: number; steps?: number; toolCalls?: number; usage?: Record<string, number>; label: string; at: string }>;
      timeline: Array<{ seq: number; actor: string; kind: string; label: string; at: string }>;
    };

    expect(response.status).toBe(200);
    expect(projection.ok).toBe(true);
    expect(projection.turns).toEqual([
      expect.objectContaining({
        seq: 1,
        latencyMs: 210,
        steps: 2,
        toolCalls: 1,
        usage: {
          inputTokens: 32,
          outputTokens: 16,
          totalTokens: 48,
          cacheReadTokens: 10,
          cacheWriteTokens: 2,
          reasoningTokens: 22,
          textTokens: 26,
        },
      }),
    ]);
    expect(projection.timeline).toHaveLength(3);
    expect(projection.timeline.map((event) => event.kind)).toEqual(["model.call", "model.reply", "note"]);
  });
});

describe("Lois sidecar conversation route", () => {
  it.each([false, true])("acknowledges SSE before model speech (face proxy: %s)", async (throughFace) => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const built = fakeSidecar(async () => ({ ok: true, note: "not used" }));
    built.system.tell = vi.fn(async () => { await pending; return { ok: false, why: "controlled completion" }; });
    const server = createLoisServer(built);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const sidecarUrl = `http://127.0.0.1:${address.port}`;
    const proxy = throughFace ? await createViteServer({
      configFile: false, logLevel: "silent", server: {
        host: "127.0.0.1", port: 0, hmr: false,
        proxy: { "/api/lois": { target: sidecarUrl, changeOrigin: false } },
      },
    }) : undefined;
    await proxy?.listen();
    const proxyAddress = proxy?.httpServer?.address() as AddressInfo | undefined;
    const baseUrl = proxyAddress ? `http://127.0.0.1:${proxyAddress.port}` : sidecarUrl;
    const request = fetch(`${baseUrl}/api/lois/tell`, {
      method: "POST", body: JSON.stringify({ message: "Research my guests" }),
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([request, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Headers waited for model speech")), 1000);
      })]);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
    } finally {
      clearTimeout(deadline);
      finish();
      await (await request).text();
      await proxy?.close();
    }
  });

  it("streams a durable worker completion back into the visible tell transcript", async () => {
    let publish!: (turn: Parameters<NonNullable<BuiltSidecar["backgroundTurns"]>["subscribe"]>[0] extends (turn: infer T) => void ? T : never) => void;
    const built = fakeSidecar(async () => ({ ok: true, note: "not used" }));
    built.backgroundTurns = {
      subscribe(listener) {
        publish = listener;
        return () => undefined;
      },
    };
    const server = createLoisServer(built);
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/lois/tell`);
    const reader = response.body!.getReader();

    publish({
      eventId: 12,
      ok: true,
      output: {
        say: "The series history is ready from three owned exports.",
        ui: [{ show: "keep" }],
        proposals: [],
        memory: [],
        questions: [],
        replies: [],
      },
      traceTail: [],
    });

    let streamed = "";
    while (!streamed.includes("series history is ready")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      streamed += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(streamed).toContain("event: turn");
    expect(streamed).toContain("The series history is ready from three owned exports.");
  });

  it("replays finished worker speech from the durable trace after a pane reload", async () => {
    const built = fakeSidecar(async () => ({ ok: true, note: "not used" }));
    built.system.trace.append({
      actor: "diver",
      kind: "heard",
      label: "worker report",
      detail: { text: "worker report", jobId: "job-1" },
    });
    const reply = built.system.trace.append({
      actor: "lois",
      kind: "model.reply",
      label: "turn landed",
      detail: { say: "I recovered the finished answer after your pane came back." },
    });
    const server = createLoisServer(built);
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/lois/tell`);
    const reader = response.body!.getReader();

    let streamed = "";
    while (!streamed.includes("recovered the finished answer")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      streamed += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();

    expect(streamed).toContain(`id: ${reply.seq}`);
    expect(streamed).toContain("I recovered the finished answer after your pane came back.");
  });

  it("keeps an overlapping turn from stealing the active turn's response", async () => {
    let landFirst!: (result: Awaited<ReturnType<BuiltSidecar["system"]["tell"]>>) => void;
    const firstTurn = new Promise<Awaited<ReturnType<BuiltSidecar["system"]["tell"]>>>((resolve) => {
      landFirst = resolve;
    });
    const built = fakeSidecar(async () => ({ ok: true, note: "not used" }));
    built.system.tell = vi.fn(async () => firstTurn);
    const server = createLoisServer(built);
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const firstResponse = fetch(`${baseUrl}/api/lois/tell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "first" }),
    });
    await vi.waitFor(() => expect(built.system.tell).toHaveBeenCalledOnce());

    const overlap = await fetch(`${baseUrl}/api/lois/tell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "second" }),
    });
    expect(overlap.status).toBe(409);
    expect(await overlap.json()).toEqual({
      error: "Lois is already answering. Let that turn land first.",
    });

    landFirst({
      ok: true,
      output: {
        say: "First answer.",
        ui: [],
        proposals: [],
        memory: [],
        questions: [],
        replies: [],
      },
    });
    const landed = await firstResponse;
    expect(landed.status).toBe(200);
    expect(await landed.text()).toContain("First answer.");
    expect(built.system.tell).toHaveBeenCalledOnce();
  });
});
