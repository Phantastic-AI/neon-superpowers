#!/usr/bin/env -S npx tsx
// sidecar/server — Lois's real server: the process the app runs on (D-111).
//
//   npx tsx sidecar/server.ts        (port 5175, or LOIS_PORT)
//
// This is the house everything proven in the dev harness moves into: ONE
// process that owns the brain (createLois), the persistent trace (her memory
// and the timing history, on disk beside the vault), the voice calibration,
// and her hands (the dive: her own Chrome profile, D-052/D-117).
//
// In dev, the face's vite server proxies /api/lois/* here. In prod, the Tauri
// shell spawns this same process and points the face at it. The OpenAPI spec
// (D-116) will describe exactly this surface; the MCP server and `sp` CLI
// derive from it.
//
// Endpoints:
//   POST /api/lois/tell    {message} -> SSE: say deltas, bus lines, turn, done
//   POST /api/lois/cancel  -> aborts the in-flight turn (D-119)
//   GET  /api/lois/health  -> {ok, roster, vault}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createLois, type LoisSystem } from "../packages/lois/system.js";
import type { TurnResult } from "../packages/lois/mind.js";
import { loadCalibration } from "../tools/lois-calibration.js";
import { openPersistentTraceFile, readPersistedEventsFile } from "../tools/lois-persist.js";
import { diveInfo, onBrowserFrame } from "../tools/lois-dive.js";
import { handleBrowserInput } from "./browser-input.js";
import {
  resolveRuntimeInference,
  type RuntimeInferenceBinding,
  type RuntimeInferenceDependencies,
} from "./inference.js";
import {
  closeRuntimeBrowser,
  closeRuntimeDiver,
  createRuntimeHands,
  readRuntimeDiverJob,
  cancelRuntimeDiver,
  resolveSidecarRuntime,
  runtimeTurnMaxSteps,
  type SidecarRuntime,
} from "./runtime.js";
import { loadVaultWorld } from "./vault.js";
import type { World } from "../tools/projections/types.js";
import { digest, type TraceEvent } from "../packages/lois/trace.js";
import { createVaultSnapshot, listVaultSnapshots } from "../packages/vault/snapshot.js";
import { handlePeopleApi } from "./people-api.js";

// ---------------------------------------------------------------------------
// The system, once per process. Her memory is the persistent trace.
// ---------------------------------------------------------------------------

let pushSay: ((delta: string) => void) | null = null;
let pushBus: ((e: { seq: number; actor: string; kind: string; label: string }) => void) | null = null;

export interface BuiltSidecar {
  system: LoisSystem;
  world: World;
  vaultDir: string;
  runtime: SidecarRuntime;
  inference?: RuntimeInferenceBinding;
  backgroundTurns?: {
    subscribe(listener: (turn: BackgroundTurn) => void): () => void;
  };
}

export interface BackgroundTurn extends TurnResult {
  eventId: number;
  traceTail: Array<{ seq: number; actor: string; kind: string; label: string }>;
}

function createBackgroundTurnBus(): {
  publish(turn: BackgroundTurn): void;
  subscribe(listener: (turn: BackgroundTurn) => void): () => void;
} {
  const listeners = new Set<(turn: BackgroundTurn) => void>();
  return {
    publish: (turn) => listeners.forEach((listener) => listener(turn)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function replayableBackgroundTurns(
  events: readonly TraceEvent[],
  afterSeq: number | null = null,
): BackgroundTurn[] {
  const turns: BackgroundTurn[] = [];
  let workerHeardAt: number | null = null;
  for (const event of events) {
    if (event.kind === "heard") {
      workerHeardAt = event.actor === "diver" ? event.seq : null;
      continue;
    }
    if (
      workerHeardAt !== null &&
      event.actor === "lois" &&
      event.kind === "model.reply" &&
      typeof event.detail?.say === "string" &&
      event.detail.say
    ) {
      if (afterSeq === null || event.seq > afterSeq) {
        turns.push({
          eventId: event.seq,
          ok: true,
          output: {
            say: event.detail.say,
            ui: [],
            proposals: [],
            memory: [],
            questions: [],
            replies: [],
          },
          traceTail: events
            .filter((candidate) => candidate.seq >= workerHeardAt! && candidate.seq <= event.seq)
            .map((candidate) => ({
              seq: candidate.seq,
              actor: candidate.actor,
              kind: candidate.kind,
              label: candidate.label,
            })),
        });
      }
      workerHeardAt = null;
    }
  }
  return turns;
}

function writeBackgroundTurn(res: ServerResponse, turn: BackgroundTurn): void {
  if (res.writableEnded) return;
  res.write(`id: ${turn.eventId}\nevent: turn\ndata: ${JSON.stringify(turn)}\n\n`);
}

type TraceUsageSummary = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  textTokens?: number;
};

export interface TraceTurnProjection {
  seq: number;
  at: string;
  latencyMs?: number;
  steps?: number;
  toolCalls?: number;
  usage?: TraceUsageSummary;
  label: string;
}

export interface TraceTimelineLine {
  seq: number;
  at: string;
  actor: string;
  kind: string;
  label: string;
}

export interface TraceProjection {
  ok: true;
  turns: TraceTurnProjection[];
  timeline: TraceTimelineLine[];
}

function summarizeTrace(events: TraceEvent[]): TraceProjection {
  const visibleEvents = events.slice(-200);
  const turns: TraceTurnProjection[] = [];
  const timeline: TraceTimelineLine[] = visibleEvents.map((event) => ({
    seq: event.seq,
    at: event.at,
    actor: event.actor,
    kind: event.kind,
    label: event.label,
  }));
  for (const e of visibleEvents) {
    if (e.actor === "lois" && e.kind === "model.reply") {
      const d = e.detail ?? {};
      turns.push({
        seq: e.seq,
        at: e.at,
        latencyMs: typeof d.ms === "number" ? d.ms : undefined,
        steps: typeof d.steps === "number" ? d.steps : undefined,
        toolCalls: typeof d.toolCalls === "number" ? d.toolCalls : undefined,
        usage: d.usage && typeof d.usage === "object" ? d.usage as TraceUsageSummary : undefined,
        label: e.label,
      });
    }
  }
  return { ok: true, turns, timeline };
}

export function browserJobState(
  d: Pick<ReturnType<typeof diveInfo>, "mode" | "inputOwner">,
  turnActive = false,
): "working" | "waiting" | "open" {
  if (turnActive && d.inputOwner === "automation") return "working";
  if (d.mode === "foreground_hands") return "waiting";
  return "open";
}

function browserPlace(rawUrl: string | undefined): string {
  if (!rawUrl) return "its last page";
  try {
    const url = new URL(rawUrl);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return "its last page";
  }
}

export interface LoisJobProjection {
  id: "dive";
  label: string;
  state: "working" | "waiting" | "open";
  phase: "researching" | "waiting" | "partial" | "finishing" | "done" | "blocked" | "open";
  blocker: string | null;
  artifactCount: number;
  waitingOnHuman: boolean;
  terminalSpeechReady: boolean;
  leaseMode: string;
  leaseOwner: string | null;
  since?: number;
  progress?: NonNullable<ReturnType<typeof readRuntimeDiverJob>>["progress"];
}

export function projectLoisJob(input: {
  job: ReturnType<typeof readRuntimeDiverJob>;
  browser: ReturnType<typeof diveInfo>;
  artifactCount: number;
  trace: readonly TraceEvent[];
  turnActive?: boolean;
}): LoisJobProjection | null {
  const { job, browser, artifactCount, trace, turnActive = false } = input;
  if (!job && !browser.open) return null;
  const diverReply = job
    ? [...trace].reverse().find((event) =>
        event.actor === "diver" &&
        event.kind === "model.reply" &&
        event.detail?.jobId === job.id)
    : undefined;
  const workerHeard = diverReply && job
    ? trace.find((event) =>
        event.seq > diverReply.seq &&
        event.actor === "diver" &&
        event.kind === "heard" &&
        event.detail?.jobId === job.id)
    : undefined;
  const terminalSpeechReady = Boolean(workerHeard && trace.some((event) =>
    event.seq > workerHeard.seq && event.actor === "lois" && event.kind === "model.reply",
  ));
  const phase: LoisJobProjection["phase"] = !job
    ? "open"
    : job.status === "running"
      ? "researching"
      : job.status === "awaiting_human"
        ? "waiting"
        : job.status === "partial"
          ? "partial"
          : job.status === "blocked"
            ? "blocked"
            : terminalSpeechReady
              ? "done"
              : "finishing";
  return {
    id: "dive",
    label: job?.summary ?? job?.intent ?? `her browser, on ${browserPlace(browser.url)}`,
    state: job?.status === "awaiting_human" || browser.mode === "foreground_hands"
      ? "waiting"
      : job?.status === "running" ? "working" : browserJobState(browser, turnActive),
    phase,
    blocker: job?.status === "awaiting_human" || job?.status === "blocked"
      ? job.next ?? job.summary ?? null
      : null,
    artifactCount,
    waitingOnHuman: job?.status === "awaiting_human",
    terminalSpeechReady,
    leaseMode: browser.mode,
    leaseOwner: browser.inputOwner,
    since: job?.createdAt ?? browser.since,
    ...(job?.progress ? { progress: job.progress } : {}),
  };
}

export function buildSystem(
  env: Record<string, string | undefined> = process.env,
  inferenceDependencies: RuntimeInferenceDependencies = {},
): BuiltSidecar {
  const runtime = resolveSidecarRuntime(env);
  const vaultDir = runtime.vaultDir;
  const world = loadVaultWorld(vaultDir);
  const inference = resolveRuntimeInference(runtime, inferenceDependencies);
  const backgroundTurns = createBackgroundTurnBus();
  const trace = openPersistentTraceFile(runtime.tracePath, (e) =>
    pushBus?.({ seq: e.seq, actor: e.actor, kind: e.kind, label: e.label }),
  );
  let resolveSystem!: (system: LoisSystem) => void;
  const systemReady = new Promise<LoisSystem>((resolve) => {
    resolveSystem = resolve;
  });
  const speakWorkerResult = async (report: string, jobId: string, signal: AbortSignal, detail: Record<string, unknown> = {}) => {
      const ready = await systemReady;
      signal.throwIfAborted();
      const from = ready.trace.cursor;
      const result = await inference.runTurn(`worker-${jobId}-${from}`, () => ready.continueFromWorker(report, {
        jobId,
        ...detail,
      }, signal));
      signal.throwIfAborted();
      const traceTail = ready.trace
        .since(from)
        .map((traceEvent) => ({
          seq: traceEvent.seq,
          actor: traceEvent.actor,
          kind: traceEvent.kind,
          label: traceEvent.label,
        }));
      backgroundTurns.publish({
        eventId: [...traceTail].reverse().find((traceEvent) =>
          traceEvent.actor === "lois" && traceEvent.kind === "model.reply")?.seq ??
          traceTail.at(-1)?.seq ??
          from,
        ...result,
        traceTail,
      });
  };
  const hands = createRuntimeHands(runtime, world, {
    model: inference.bindRole("diver", "bounded browser research"),
    trace,
    onWorkerSettled: ({ report, jobId, signal, detail }) => speakWorkerResult(report, jobId, signal, detail),
  });
  const system = createLois({
    world,
    model: inference.model,
    models: inference.models,
    calibration: loadCalibration(vaultDir),
    trace,
    onSay: (d) => pushSay?.(d),
    onCancel: () => cancelRuntimeDiver(runtime),
    hands,
    maxSteps: runtimeTurnMaxSteps(runtime),
  });
  resolveSystem(system);
  return { system, world, vaultDir, runtime, inference, backgroundTurns };
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    req.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rej);
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

export function createLoisServer(built: BuiltSidecar = buildSystem()): Server {
  const system = built.system;
  let turnSequence = 0;
  let turnActive = false;
  const server = createServer((req, res) => {
  const url = req.url ?? "";

  if (handlePeopleApi(req, res, built)) return;

  if (url === "/api/lois/snapshots" && req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    try {
      json(res, 200, { ok: true, snapshots: listVaultSnapshots(`${resolve(built.vaultDir)}.snapshots`) });
    } catch (error) {
      json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url === "/api/lois/snapshots" && req.method === "POST") {
    res.setHeader("Cache-Control", "no-store");
    // CLI/same-origin JSON only. A third-party page cannot create backups by
    // submitting a form. The request never chooses a source or output path.
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
      json(res, 403, { ok: false, error: "Use the local snapshot command or the same app origin." });
      return;
    }
    if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
      json(res, 415, { ok: false, error: "Snapshot creation needs application/json." });
      return;
    }
    void readBody(req).then(body => {
      const input: unknown = JSON.parse(body);
      if (!input || typeof input !== "object" || Array.isArray(input) ||
          Object.keys(input).length !== 1 || !("name" in input) || typeof input.name !== "string") {
        json(res, 400, { ok: false, error: "Provide only a checkpoint name." });
        return;
      }
      // No await in capture: all four primary files are read in this owning
      // process's event-loop turn, between the vault's synchronous writes.
      const snapshot = createVaultSnapshot(built.vaultDir, input.name);
      json(res, 201, { ok: true, snapshot });
    }).catch(error => {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return;
  }

  if (req.method === "GET" && url.startsWith("/api/lois/health")) {
    json(res, 200, {
      ok: true,
      roster: system.roster(),
      vault: built.vaultDir,
      mode: built.runtime.mode,
      runRoot: built.runtime.runRoot,
      inference: {
        ...built.inference?.status,
        usage: built.inference?.budget?.summary(),
      },
    });
    return;
  }

  if (req.method === "GET" && url === "/api/lois/world") {
    res.setHeader("Cache-Control", "no-store");
    json(res, 200, { world: built.world });
    return;
  }

  // The live viewport (the embed): her browser's pixels, streamed as SSE
  // frames into the System 7 macwin in the stage. The pane is interactive
  // only while the browser lease names it as the sole input owner.
  if (req.method === "GET" && url.startsWith("/api/lois/browser/stream")) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    const unsub = onBrowserFrame((f) => {
      if (!res.writableEnded) res.write(`event: frame\ndata: ${JSON.stringify({ url: f.url, at: f.at, data: f.data })}\n\n`);
    });
    const beat = setInterval(() => {
      if (!res.writableEnded) res.write(`: beat\n\n`);
    }, 15000);
    req.on("close", () => {
      unsub();
      clearInterval(beat);
    });
    return;
  }

  if (req.method === "GET" && url.startsWith("/api/lois/browser/status")) {
    json(res, 200, { ok: true, ...diveInfo() });
    return;
  }

  if (req.method === "GET" && url === "/api/lois/trace") {
    res.setHeader("Cache-Control", "no-store");
    json(res, 200, summarizeTrace(readPersistedEventsFile(built.runtime.tracePath)));
    return;
  }

  // The transcript stays on the tell surface even when a durable browser
  // continuation finishes after the organizer's request stream has closed.
  // This is speech, not a second progress channel.
  if (req.method === "GET" && url === "/api/lois/tell") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.write(": connected\n\n");
    const unsubscribe = built.backgroundTurns?.subscribe((turn) => writeBackgroundTurn(res, turn)) ??
      (() => undefined);
    const lastEventHeader = req.headers["last-event-id"];
    const lastEventValue = Array.isArray(lastEventHeader) ? lastEventHeader[0] : lastEventHeader;
    const parsedLastEvent = lastEventValue === undefined ? null : Number(lastEventValue);
    const lastEventId = parsedLastEvent !== null && Number.isSafeInteger(parsedLastEvent) && parsedLastEvent >= 0
      ? parsedLastEvent
      : null;
    const replay = replayableBackgroundTurns(system.trace.all(), lastEventId);
    for (const turn of lastEventId === null ? replay.slice(-1) : replay) {
      writeBackgroundTurn(res, turn);
    }
    const beat = setInterval(() => {
      if (!res.writableEnded) res.write(": beat\n\n");
    }, 15000);
    req.on("close", () => {
      unsubscribe();
      clearInterval(beat);
    });
    return;
  }

  // Human handoff is an app control, not a model-only privilege. These two
  // routes operate the exact same lease as the embedded pane and semantic
  // hands; the dive owns foreground lock + reconciliation.
  if (req.method === "POST" && url.startsWith("/api/lois/browser/summon")) {
    void built.runtime.dive.dive_summon()
      .then((note) => json(res, note.startsWith("Her window is on-screen") ? 200 : 409, { ok: note.startsWith("Her window is on-screen"), note }))
      .catch(() => json(res, 502, { ok: false, note: "Could not summon the browser window." }));
    return;
  }

  if (req.method === "POST" && url.startsWith("/api/lois/browser/dismiss")) {
    void built.runtime.dive.dive_dismiss("pane")
      .then((note) => json(res, note.startsWith("Her window is off-screen again") ? 200 : 409, { ok: note.startsWith("Her window is off-screen again"), note }))
      .catch(() => json(res, 502, { ok: false, note: "Could not return the browser to the pane." }));
    return;
  }

  if (req.method === "POST" && url.startsWith("/api/lois/cancel")) {
    system.cancel();
    json(res, 200, { ok: true });
    return;
  }

  // The jobs list (D-119): what's running, since when. A plain list.
  if (req.method === "GET" && url.startsWith("/api/lois/jobs")) {
    const job = readRuntimeDiverJob(built.runtime);
    const artifactList = built.runtime.dive.dive_list_artifacts?.({ limit: 1 }, job?.id) ??
      Promise.resolve({ artifacts: [], nextCursor: null, total: 0 });
    void artifactList
      .then((artifacts) => {
        const projected = projectLoisJob({
          job,
          browser: diveInfo(),
          artifactCount: artifacts.total,
          trace: system.trace.all(),
          turnActive,
        });
        json(res, 200, { jobs: projected ? [projected] : [] });
      })
      .catch(() => {
        const projected = projectLoisJob({
          job,
          browser: diveInfo(),
          artifactCount: 0,
          trace: system.trace.all(),
          turnActive,
        });
        json(res, 200, { jobs: projected ? [projected] : [] });
      });
    return;
  }

  // Input forwarding (embed phase 2): pane clicks/keys land in her REAL
  // browser via playwright and NOWHERE else — the model never sees them.
  if (req.method === "POST" && url.startsWith("/api/lois/browser/input")) {
    void readBody(req)
      .then(async (raw) => {
        const response = await handleBrowserInput(raw, built.runtime.dive.dive_input);
        json(res, response.status, response.payload);
      })
      .catch(() => json(res, 400, { ok: false, note: "Could not read browser input." }));
    return;
  }

  // Close a job from the face (the ✕): the dive's window, session preserved.
  if (req.method === "POST" && url.startsWith("/api/lois/jobs/dive/close")) {
    void closeRuntimeBrowser(built.runtime)
      .then((note) => json(res, 200, { ok: true, note }))
      .catch(() => json(res, 502, { ok: false }));
    return;
  }

  if (req.method === "POST" && url.startsWith("/api/lois/tell")) {
    void (async () => {
      let message = "";
      try {
        const parsed = JSON.parse((await readBody(req)) || "{}") as { message?: string };
        message = typeof parsed.message === "string" ? parsed.message.trim() : "";
      } catch {
        json(res, 400, { error: "bad request" });
        return;
      }
      if (!message) {
        json(res, 400, { error: "no message" });
        return;
      }
      if (turnActive) {
        json(res, 409, { error: "Lois is already answering. Let that turn land first." });
        return;
      }
      turnActive = true;

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      // Start the stream through buffering proxies independently of model latency.
      res.write(": connected\n\n");
      const emit = (event: string, data: unknown) => {
        if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      pushSay = (delta) => emit("say", { delta });
      pushBus = (e) => {
        // Verdicts and holds only — wake lines are pump mechanics, not news.
        if ((e.actor === "critic" || e.actor === "goldfish") && e.kind === "note") emit("bus", e);
        else if (e.actor === "gate" && e.kind === "gate") emit("bus", e);
      };

      const t0 = Date.now();
      try {
        const from = system.trace.cursor;
        const turnId = `app-turn-${++turnSequence}`;
        const result = await (built.inference?.runTurn(turnId, () => system.tell(message)) ?? system.tell(message));
        const traceTail = system.trace
          .since(from)
          .map((e) => ({ seq: e.seq, actor: e.actor, kind: e.kind, label: e.label }));
        emit("turn", { ...result, traceTail, ms: Date.now() - t0 });
      } catch (err) {
        emit("turn", { ok: false, why: err instanceof Error ? err.message : String(err), traceTail: [] });
      } finally {
        pushSay = null;
        pushBus = null;
        emit("done", { ms: Date.now() - t0 });
        res.end();
        void system.idle().finally(() => {
          turnActive = false;
        });
      }
    })();
    return;
  }

  json(res, 404, { error: "no such door — the spec (D-116) names what exists" });
  });
  server.once("close", () => system.cancel({ background: false }));
  return server;
}

/** Stop inputs, cancel/drain research and speech, then close the owned browser. */
export async function closeSidecar(server: Server, built: BuiltSidecar): Promise<void> {
  built.system.cancel({ background: false });
  const closed = new Promise<void>((resolve, reject) => {
    server.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
    server.closeAllConnections();
  });
  await Promise.all([closed, closeRuntimeDiver(built.runtime), built.system.idle()]);
  await closeRuntimeBrowser(built.runtime);
}

export function startSidecar(
  env: Record<string, string | undefined> = process.env,
): { server: Server; built: BuiltSidecar } {
  const port = Number(env.LOIS_PORT || 5175);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("LOIS_PORT must be an integer from 0 through 65535.");
  }
  const built = buildSystem(env);
  const server = createLoisServer(built);
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : port;
    console.log(`lois sidecar listening on http://127.0.0.1:${boundPort}`);
    console.log(`  mode: ${built.runtime.mode}`);
    console.log(`  vault: ${built.vaultDir}`);
    console.log(`  trace: ${built.runtime.tracePath}`);
    console.log(`  roster: ${built.system.roster().map((a) => `${a.name} (${a.role})`).join(" · ")}`);
  });
  return { server, built };
}

export function isDirectSidecar(metaUrl: string = import.meta.url, argv: string[] = process.argv): boolean {
  const entry = argv[1];
  return Boolean(entry) && pathToFileURL(resolve(entry)).href === metaUrl;
}

if (isDirectSidecar()) {
  try {
    const { server, built } = startSidecar();
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void closeSidecar(server, built).catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
