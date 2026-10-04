import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPersistentTraceFile } from "../tools/lois-persist.js";
import { initializeSmokeRun, type SmokeRunPaths } from "../tools/lois-smoke-run.js";
import { Trace } from "../packages/lois/trace.js";
import { loadVaultWorld } from "./vault.js";
import { openVault } from "../packages/vault/store.js";
import { createVaultSnapshot, restoreVaultSnapshot } from "../packages/vault/snapshot.js";
import { buildSystem, isDirectSidecar } from "./server.js";
import {
  closeRuntimeBrowser,
  createDiverCapabilities,
  createRuntimeHands,
  idleRuntimeDiver,
  createRuntimeDiverContinuationPump,
  liveBrowserWorkspace,
  LOIS_TURN_MAX_STEPS,
  resolveSidecarRuntime,
  runtimeTurnMaxSteps,
  startRuntimeBrowser,
} from "./runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function smokeRun(): SmokeRunPaths {
  const base = mkdtempSync(resolve(tmpdir(), "lois-sidecar-run-test-"));
  roots.push(base);
  const seed = resolve(base, "seed");
  mkdirSync(seed);
  writeFileSync(resolve(seed, "stream.jsonl"), "", "utf8");
  writeFileSync(resolve(seed, "persons.json"), "[]\n", "utf8");
  writeFileSync(resolve(seed, "contexts.json"), "[]\n", "utf8");
  writeFileSync(resolve(seed, "gatherings.json"), "[]\n", "utf8");
  return initializeSmokeRun({
    baseDir: base,
    runId: "sidecar-binding",
    mockUrl: "http://127.0.0.1:4319/event/3cs?shape=v2",
    seedVaultDir: seed,
    product: { repo: "/repo/superpowers-app", head: "8380f24", clean: true },
    artifactHashes: { contract: "aaa", prd: "bbb", testSpec: "ccc" },
  });
}

describe("Lois sidecar smoke runtime", () => {
  it("binds the vault, trace, browser, evidence, and URL to one run envelope", async () => {
    const run = smokeRun();
    const runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: run.root });

    expect(runtime).toMatchObject({
      mode: "smoke",
      runRoot: run.root,
      vaultDir: run.vaultDir,
      tracePath: run.tracePath,
      browserStartUrl: "http://127.0.0.1:4319/event/3cs?shape=v2",
    });
    expect(await runtime.dive.dive_start("https://lu.ma/not-the-mock")).toMatch(
      /^Refused browser start: Smoke browser start must stay on mock origin/,
    );
    expect(existsSync(resolve(run.root, "chrome.debug-port"))).toBe(false);
  });

  it("passes the explicit manifest URL to the run-owned hands and closes that same instance", async () => {
    const runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: smokeRun().root });
    const start = vi.fn(async () => "started");
    const close = vi.fn(async () => "closed");
    runtime.dive.dive_start = start;
    runtime.dive.dive_close = close;

    await expect(startRuntimeBrowser(runtime)).resolves.toBe("started");
    await expect(closeRuntimeBrowser(runtime)).resolves.toBe("closed");
    expect(start).toHaveBeenCalledWith(runtime.browserStartUrl, true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("gives Lois thirty native-tool moves in product turns and keeps smoke within its budget", () => {
    expect(LOIS_TURN_MAX_STEPS).toBe(30);
    expect(runtimeTurnMaxSteps(resolveSidecarRuntime({}))).toBe(30);
    expect(runtimeTurnMaxSteps(resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: smokeRun().root }))).toBe(10);
  });

  it("starts persistent browser work in the embedded pane for observation before handoff", async () => {
    const runtime = resolveSidecarRuntime({});
    const start = vi.fn(async () => "started");
    runtime.dive.dive_start = start;

    await expect(startRuntimeBrowser(runtime, "https://lu.ma/home")).resolves.toBe("started");

    expect(start).toHaveBeenCalledWith("https://lu.ma/home", true);
  });

  it("looks at the opened page before asking the organizer for hands", () => {
    const runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: smokeRun().root });
    const capabilities = createDiverCapabilities(runtime, loadVaultWorld(runtime.vaultDir));

    expect(runtime.browserStartDescription).toMatch(/observe the page/i);
    expect(capabilities.browser_start.description).toMatch(/returns.*observation/i);
    expect(capabilities.browser_observe.description).toMatch(/immediately after opening/i);
    expect(capabilities.browser_follow.description).toMatch(/read-only.*fence|blocks.*write/i);
    expect(capabilities.browser_download.description).toMatch(/download.*owned|owned.*download/i);
    expect(capabilities.browser_capture.description).toMatch(/do not assume.*sign in/i);
  });

  it("opens and observes in one evidence-bearing browser move", async () => {
    const runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: smokeRun().root });
    runtime.dive.dive_start = vi.fn(async () => "Browser opened.");
    runtime.dive.dive_observe = vi.fn(async () => "Observation obs-1: 3 people visible.");
    const capabilities = createDiverCapabilities(runtime, loadVaultWorld(runtime.vaultDir));

    const output = await capabilities.browser_start.run({});

    expect(output).toContain("Browser opened.");
    expect(output).toContain("Observation obs-1: 3 people visible.");
    expect(runtime.dive.dive_start).toHaveBeenCalledWith(runtime.browserStartUrl, true);
    expect(runtime.dive.dive_observe).toHaveBeenCalledOnce();
    expect(capabilities.browser_start.evidenceCategories?.({}, output)).toEqual(["browser_frame"]);
  });

  it("routes an exact observed download ref through the diver's bounded browser capability", async () => {
    const runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: smokeRun().root });
    runtime.dive.dive_download = vi.fn(async () => "Downloaded people.csv.");
    const capabilities = createDiverCapabilities(runtime, loadVaultWorld(runtime.vaultDir));

    await expect(
      capabilities.browser_download.run({ observationId: "obs-8", ref: "f11e124" }),
    ).resolves.toBe("Downloaded people.csv.");
    expect(runtime.dive.dive_download).toHaveBeenCalledWith({ observationId: "obs-8", ref: "f11e124" });
  });

  it("lets the diver page through its latest captured artifact without accepting a path", async () => {
    const runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: smokeRun().root });
    runtime.dive.dive_read_download = vi.fn(async () => "Captured artifact strange-name.\nContents:\nname,email");
    const capabilities = createDiverCapabilities(runtime, loadVaultWorld(runtime.vaultDir));

    await expect(capabilities.browser_read_artifact.run({ offset: 0, maxChars: 20_000 })).resolves.toContain("name,email");
    expect(runtime.dive.dive_read_download).toHaveBeenCalledWith({ offset: 0, maxChars: 20_000 });
    expect(capabilities.browser_read_artifact.inputSchema.safeParse({ path: "/tmp/neon-demo-downloads/file.csv" }).success).toBe(false);
  });

  it("reads one exact owned artifact id and lists history without exposing local paths", async () => {
    const runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: smokeRun().root });
    runtime.dive.dive_read_download = vi.fn(async () => "Captured artifact older.csv.");
    runtime.dive.dive_list_artifacts = vi.fn(async () => ({
      artifacts: [{
        schemaVersion: 1 as const,
        jobId: "job-history",
        attemptId: "attempt-old",
        artifactId: "artifact_older",
        kind: "download" as const,
        sourceUrl: "https://lu.ma/event/older",
        filename: "older.csv",
        bytes: 42,
        capturedAt: 1,
        readOffset: 0,
        readMaxChars: 20_000,
        freshness: { attemptId: "attempt-old", attemptStartedAt: 1, currentAtCapture: true },
        summary: "Captured download older.csv (42 bytes).",
      }],
      nextCursor: null,
      total: 1,
    }));
    const capabilities = createDiverCapabilities(runtime, loadVaultWorld(runtime.vaultDir));

    await expect(
      capabilities.browser_read_artifact.run({ artifactId: "artifact_older", offset: 0, maxChars: 20_000 }),
    ).resolves.toContain("older.csv");
    const listed = JSON.parse(await capabilities.browser_list_artifacts.run({ limit: 10 })) as {
      artifacts: Array<Record<string, unknown>>;
    };

    expect(runtime.dive.dive_read_download).toHaveBeenCalledWith({
      artifactId: "artifact_older",
      offset: 0,
      maxChars: 20_000,
    });
    expect(runtime.dive.dive_list_artifacts).toHaveBeenCalledWith({ limit: 10 });
    expect(listed.artifacts[0]).toMatchObject({ artifactId: "artifact_older", filename: "older.csv" });
    expect(listed.artifacts[0]).not.toHaveProperty("path");
    expect(capabilities.browser_list_artifacts.inputSchema.safeParse({ path: "/tmp" }).success).toBe(false);
  });

  it("records completion evidence only when every claimed source artifact is owned", async () => {
    const runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: smokeRun().root });
    runtime.dive.dive_list_artifacts = vi.fn(async () => ({
      artifacts: [{
        schemaVersion: 1 as const,
        jobId: "job-history",
        attemptId: "attempt-1",
        artifactId: "artifact_owned",
        kind: "download" as const,
        sourceUrl: "https://lu.ma/event/one",
        filename: "one.csv",
        bytes: 42,
        capturedAt: 1,
        readOffset: 0,
        readMaxChars: 20_000,
        freshness: { attemptId: "attempt-1", attemptStartedAt: 1, currentAtCapture: true },
        summary: "Captured download one.csv (42 bytes).",
      }],
      nextCursor: null,
      total: 1,
    }));
    const capabilities = createDiverCapabilities(runtime, loadVaultWorld(runtime.vaultDir));
    const input = {
      category: "current_event_csv",
      artifactIds: ["artifact_owned"],
      summary: "Current-event guests read from the owned export.",
    };

    const accepted = await capabilities.research_record_evidence.run(input);
    const refused = await capabilities.research_record_evidence.run({
      ...input,
      artifactIds: ["artifact_missing"],
    });

    expect(JSON.parse(accepted)).toMatchObject({ ok: true, category: "current_event_csv" });
    expect(capabilities.research_record_evidence.evidenceCategories?.(input, accepted)).toEqual([
      "current_event_csv",
    ]);
    expect(JSON.parse(refused)).toMatchObject({ ok: false, missingArtifactIds: ["artifact_missing"] });
    expect(capabilities.research_record_evidence.evidenceCategories?.(input, refused)).toEqual([]);

    const unsaved = { ...input, category: "guestlist_saved" };
    const unearned = await capabilities.research_record_evidence.run(unsaved);
    expect(JSON.parse(unearned).ok).toBe(false);
    expect(capabilities.research_record_evidence.evidenceCategories?.(unsaved, unearned)).toEqual([]);

    const oneEventCannotBecomeSeries = await capabilities.research_record_evidence.run({
      category: "series_attendance_index",
      artifactIds: ["artifact_owned"],
      summary: "One event is not a series.",
    });
    expect(JSON.parse(oneEventCannotBecomeSeries)).toMatchObject({
      ok: false,
      why: expect.stringContaining("at least two distinct owned source artifacts"),
    });
    expect(capabilities.research_record_evidence.evidenceCategories?.(
      {
        category: "series_attendance_index",
        artifactIds: ["artifact_owned"],
        summary: "One event is not a series.",
      },
      oneEventCannotBecomeSeries,
    )).toEqual([]);
  });

  it("binds captured artifacts to the durable diver job as soon as that job is saved", async () => {
    const runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: smokeRun().root });
    runtime.dive.dive_bind_job = vi.fn();
    const hands = createRuntimeHands(runtime, loadVaultWorld(runtime.vaultDir), {
      model: {} as never,
      trace: new Trace(),
      runModel: async () => ({
        text: JSON.stringify({
          status: "complete",
          goalCategory: "current_event_export",
          summary: "The export is captured.",
          evidence: ["artifact_owned"],
          evidenceCategories: ["current_event_csv"],
        }),
        steps: 1,
        toolCalls: 1,
        hostEvidenceCategories: ["current_event_csv"],
      }),
    });

    const report = JSON.parse(await hands.dive.run({ intent: "Export this event." })) as { jobId: string };

    expect(runtime.dive.dive_bind_job).toHaveBeenNthCalledWith(1, null);
    expect(runtime.dive.dive_bind_job).toHaveBeenCalledWith(report.jobId);
    expect(runtime.dive.dive_bind_job).toHaveBeenLastCalledWith(null);
  });

  it("gives the mouth one dive door while the diver alone receives browser implementation tools", () => {
    const runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: smokeRun().root });
    const world = loadVaultWorld(runtime.vaultDir);
    const hands = createRuntimeHands(runtime, world, { model: null, trace: new Trace() });
    const capabilities = createDiverCapabilities(runtime, world);

    expect(Object.keys(hands)).toEqual(expect.arrayContaining(["dive", "remember_event", "remember_world", "people_read", "people_order", "people_reply", "people_finish_notes"]));
    expect(capabilities.people_import_csv).toBeDefined();
    expect(capabilities.people_select_sources).toBeDefined();
    expect(hands.dive.inputSchema.safeParse({ intent: "Find the event in my browser." }).success).toBe(true);
    expect(Object.keys(capabilities)).toEqual(expect.arrayContaining([
      "browser_observe",
      "browser_follow",
      "browser_download",
      "browser_read_artifact",
      "browser_list_artifacts",
      "research_record_evidence",
    ]));
  });

  it("resumes an awaiting-human dive from the run-owned durable job record", async () => {
    const runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: smokeRun().root });
    const world = loadVaultWorld(runtime.vaultDir);
    const first = createRuntimeHands(runtime, world, {
      model: {} as never,
      trace: new Trace(),
      runModel: async () => ({
        text: JSON.stringify({
          status: "awaiting_human",
          goalCategory: "current_event_export",
          summary: "The browser needs the organizer's confirmation.",
          next: "Confirm access, then tell Lois it is done.",
          evidence: ["owned browser handoff"],
          evidenceCategories: ["browser_frame"],
        }),
        steps: 2,
        toolCalls: 1,
      }),
    });

    const waiting = JSON.parse(await first.dive.run({ intent: "Export the current event's people." })) as {
      jobId: string;
    };
    await idleRuntimeDiver(runtime);
    expect(existsSync(runtime.diverStatePath)).toBe(true);

    let resumedPrompt = "";
    const afterRestart = createRuntimeHands(runtime, world, {
      model: {} as never,
      trace: new Trace(),
      runModel: async ({ prompt }) => {
        resumedPrompt = prompt;
        return {
          text: JSON.stringify({
            status: "complete",
            goalCategory: "current_event_export",
            summary: "The export is captured.",
            evidence: ["latest browser artifact"],
            evidenceCategories: ["current_event_csv"],
          }),
          steps: 2,
          toolCalls: 1,
          hostEvidenceCategories: ["current_event_csv"],
        };
      },
    });
    const complete = JSON.parse(await afterRestart.dive.run({
      intent: "The organizer completed the confirmation.",
    })) as { jobId: string; status: string };
    await idleRuntimeDiver(runtime);
    expect(complete.jobId).toBe(waiting.jobId);
    expect(JSON.parse(readFileSync(runtime.diverStatePath, "utf8"))).toMatchObject({ id: waiting.jobId, status: "complete" });
    expect(resumedPrompt).toContain("Export the current event's people.");
    expect(resumedPrompt).toContain("The organizer completed the confirmation.");
  });

  it("resumes an awaiting-human dive when the browser reports new durable evidence", async () => {
    const runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: smokeRun().root });
    const world = loadVaultWorld(runtime.vaultDir);
    let calls = 0;
    let resumedPrompt = "";
    let resumed!: () => void;
    const resumedDone = new Promise<void>((resolve) => {
      resumed = resolve;
    });
    const hands = createRuntimeHands(runtime, world, {
      model: {} as never,
      trace: new Trace(),
      runModel: async ({ prompt }) => {
        calls += 1;
        if (calls === 1) {
          return {
            text: JSON.stringify({
              status: "awaiting_human",
              goalCategory: "current_event_export",
              summary: "The browser is waiting for a human confirmation.",
              next: "Complete the challenge.",
              evidence: ["foreground browser"],
              evidenceCategories: ["browser_frame"],
            }),
            steps: 2,
            toolCalls: 1,
          };
        }
        resumedPrompt = prompt;
        resumed();
        return {
          text: JSON.stringify({
            status: "complete",
            goalCategory: "current_event_export",
            summary: "The captured artifact was read.",
            evidence: ["owned artifact"],
            evidenceCategories: ["current_event_csv"],
          }),
          steps: 2,
          toolCalls: 1,
          hostEvidenceCategories: ["current_event_csv"],
        };
      },
    });

    const waiting = JSON.parse(await hands.dive.run({ intent: "Export the current people list." })) as {
      jobId: string;
    };
    await idleRuntimeDiver(runtime);
    runtime.dive.dive_emit_continue({
      type: "diver.continue",
      reason: "owned_download_captured",
      key: "owned_download_captured:attempt-1:people.csv:32",
      at: Date.now() + 1,
      controlEpoch: 2,
      navigationEpoch: 9,
      attemptId: "attempt-1",
      artifactEpoch: 1,
    });

    await resumedDone;
    await vi.waitFor(() => {
      const stored = JSON.parse(readFileSync(runtime.diverStatePath, "utf8")) as { id: string; status: string };
      expect(stored).toMatchObject({ id: waiting.jobId, status: "complete" });
    });
    expect(resumedPrompt).toContain("Export the current people list.");
    expect(resumedPrompt).toContain('"type":"diver.continue"');
    expect(resumedPrompt).toContain('"reason":"owned_download_captured"');
  });

  it("reuses an active background resume and starts fresh work only after it lands", async () => {
    const runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: smokeRun().root });
    const world = loadVaultWorld(runtime.vaultDir);
    let calls = 0;
    let releaseResume!: () => void;
    const resumeHeld = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const hands = createRuntimeHands(runtime, world, {
      model: {} as never,
      trace: new Trace(),
      runModel: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            text: JSON.stringify({
              status: "awaiting_human",
              goalCategory: "current_event_export",
              summary: "Waiting for the browser.",
              next: "Finish the browser step.",
              evidence: ["browser handoff"],
              evidenceCategories: ["browser_frame"],
            }),
            steps: 2,
            toolCalls: 1,
          };
        }
        if (calls === 2) await resumeHeld;
        return {
          text: JSON.stringify({
            status: "complete",
            goalCategory: "current_event_export",
            summary: calls === 2 ? "The resumed export finished." : "The fresh export finished.",
            evidence: [calls === 2 ? "artifact-resumed" : "artifact-fresh"],
            evidenceCategories: ["current_event_csv"],
          }),
          steps: 2,
          toolCalls: 1,
          hostEvidenceCategories: ["current_event_csv"],
        };
      },
    });
    const waiting = JSON.parse(await hands.dive.run({ intent: "Resume this export." })) as { jobId: string };
    await idleRuntimeDiver(runtime);
    runtime.dive.dive_emit_continue({
      type: "diver.continue",
      reason: "owned_download_captured",
      key: "owned_download_captured:serialized-resume",
      at: Date.now() + 1,
      controlEpoch: 2,
      navigationEpoch: 9,
      attemptId: "attempt-resume",
      artifactEpoch: 1,
    });
    await vi.waitFor(() => expect(calls).toBe(2));

    const busy = JSON.parse(await hands.dive.run({ intent: "Start a fresh export." }));
    expect(busy).toMatchObject({ jobId: waiting.jobId, alreadyRunning: true });
    expect(calls).toBe(2);
    releaseResume();
    await idleRuntimeDiver(runtime);
    const fresh = JSON.parse(await hands.dive.run({ intent: "Start a fresh export." })) as { jobId: string; status: string };
    await idleRuntimeDiver(runtime);
    const stored = JSON.parse(readFileSync(runtime.diverStatePath, "utf8")) as { id: string; status: string };

    expect(calls).toBe(3);
    expect(fresh.jobId).not.toBe(waiting.jobId);
    expect(stored).toMatchObject({ id: fresh.jobId, status: "complete" });
  });

  it("recovers a browser continuation persisted before the runtime subscribes", async () => {
    const runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: smokeRun().root });
    const world = loadVaultWorld(runtime.vaultDir);
    const waitingAt = Date.now();
    const jobId = "9e0d19e3-3149-4ba0-9bf1-f4db91f1d287";
    writeFileSync(runtime.diverStatePath, `${JSON.stringify({
      version: 1,
      id: jobId,
      intent: "Export the current people list.",
      status: "awaiting_human",
      createdAt: waitingAt - 100,
      updatedAt: waitingAt,
      summary: "The browser is waiting for the organizer.",
      continuations: [],
    })}\n`, "utf8");
    runtime.dive.dive_emit_continue({
      type: "diver.continue",
      reason: "owned_download_captured",
      key: "owned_download_captured:restart-proof",
      at: waitingAt + 100,
      controlEpoch: 4,
      navigationEpoch: 8,
      attemptId: "attempt-restart",
      artifactEpoch: 1,
      filename: "people.csv",
      bytes: 32,
    });

    let resumed!: () => void;
    const resumedDone = new Promise<void>((resolve) => {
      resumed = resolve;
    });
    const settled = vi.fn();
    createRuntimeHands(runtime, world, {
      model: {} as never,
      trace: new Trace(),
      onWorkerSettled: settled,
      runModel: async ({ prompt }) => {
        expect(prompt).toContain("Export the current people list.");
        expect(prompt).toContain('"key":"owned_download_captured:restart-proof"');
        resumed();
        return {
          text: JSON.stringify({
            status: "complete",
            goalCategory: "current_event_export",
            summary: "The persisted artifact is ready.",
            evidence: ["owned artifact"],
            evidenceCategories: ["current_event_csv"],
          }),
          steps: 1,
          toolCalls: 1,
          hostEvidenceCategories: ["current_event_csv"],
        };
      },
    });

    await resumedDone;
    await vi.waitFor(() => {
      const stored = JSON.parse(readFileSync(runtime.diverStatePath, "utf8")) as {
        id: string;
        status: string;
      };
      expect(stored).toMatchObject({ id: jobId, status: "complete" });
    });
    await idleRuntimeDiver(runtime);
    expect(settled).toHaveBeenCalledOnce();
    expect(settled.mock.calls[0][0]).toMatchObject({ jobId, detail: {
      reason: "owned_download_captured", continuationKeyDigest: expect.any(String),
    } });
    expect(settled.mock.calls[0][0].detail.continuationKeyDigest).not.toBe("owned_download_captured:restart-proof");
  });

  it("does not resume the source vault's saved work when a snapshot fork opens", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "lois-snapshot-runtime-test-"));
    roots.push(root);
    const source = resolve(root, "source");
    openVault(source);
    const waitingAt = Date.now();
    const sourceJob = `${JSON.stringify({
      version: 1,
      id: "9e0d19e3-3149-4ba0-9bf1-f4db91f1d287",
      intent: "Export the original event's people.",
      status: "awaiting_human",
      createdAt: waitingAt - 100,
      updatedAt: waitingAt,
      summary: "The source browser is waiting for the organizer.",
      continuations: [],
    })}\n`;
    writeFileSync(resolve(source, "diver-job.json"), sourceJob, "utf8");
    const sourceTracePath = resolve(source, "run-trace.jsonl");
    openPersistentTraceFile(sourceTracePath).append({
      actor: "lois",
      kind: "proposed",
      label: "A source-only invitation is waiting for review.",
    });
    const sourceTrace = readFileSync(sourceTracePath, "utf8");

    const snapshot = createVaultSnapshot(source, "before-invites");
    const restored = restoreVaultSnapshot(snapshot.directory, resolve(root, "replay"));
    const runtime = resolveSidecarRuntime({
      LOIS_VAULT_DIR: restored.directory,
      LOIS_BROWSER_WORKSPACE_ROOT: resolve(root, "replay-browser"),
    });
    expect(existsSync(runtime.diverStatePath)).toBe(false);
    expect(existsSync(runtime.tracePath)).toBe(false);
    const trace = openPersistentTraceFile(runtime.tracePath);
    expect(trace.all()).toEqual([]);
    const runModel = vi.fn(async () => {
      throw new Error("A restored vault must not run the source's saved job.");
    });
    runtime.dive.dive_start = vi.fn(async () => "Unexpected browser start.");
    runtime.dive.dive_latest_continue = vi.fn(() => ({
      type: "diver.continue" as const,
      reason: "owned_download_captured" as const,
      key: "owned_download_captured:source-before-snapshot",
      at: waitingAt + 100,
      controlEpoch: 4,
      navigationEpoch: 8,
      attemptId: "attempt-before-snapshot",
      artifactEpoch: 1,
    }));

    createRuntimeHands(runtime, loadVaultWorld(runtime.vaultDir), {
      model: {} as never,
      trace,
      runModel,
    });

    await vi.waitFor(() => {
      expect(trace.all().map((event) => event.label)).toContain(
        "ignored diver continuation because no job is awaiting human input",
      );
    });
    expect(runtime.dive.dive_latest_continue).toHaveBeenCalledOnce();
    expect(runModel).not.toHaveBeenCalled();
    expect(runtime.dive.dive_start).not.toHaveBeenCalled();
    expect(existsSync(runtime.diverStatePath)).toBe(false);
    expect(trace.all().some((event) => event.kind === "proposed")).toBe(false);
    expect(readFileSync(resolve(source, "diver-job.json"), "utf8")).toBe(sourceJob);
    expect(readFileSync(sourceTracePath, "utf8")).toBe(sourceTrace);
  });

  it("dedupes browser continuation facts and does not resume non-waiting jobs", async () => {
    const runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: smokeRun().root });
    const trace = new Trace();
    const store = {
      current: null as ReturnType<typeof JSON.parse> | null,
      load() {
        return this.current;
      },
      save(job: ReturnType<typeof JSON.parse>) {
        this.current = structuredClone(job);
      },
    };
    let releaseResume!: () => void;
    const resumeHeld = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    let runs = 0;
    const settled = vi.fn();
    const pump = createRuntimeDiverContinuationPump({
      trace,
      store,
      run: async () => {
        runs += 1;
        await resumeHeld;
        store.save({ ...store.load(), status: "complete" });
        return "{}";
      },
      onSettled: settled,
    });
    store.save({
      version: 1,
      id: "f121428e-6ccb-4199-9db0-26c08c633dca",
      intent: "Export people.",
      status: "awaiting_human",
      createdAt: 1,
      updatedAt: 1,
      continuations: [],
    });
    const fact = {
      type: "diver.continue" as const,
      reason: "browser_control_returned" as const,
      key: "browser_control_returned:2:9",
      at: 2000,
      controlEpoch: 2,
      navigationEpoch: 9,
      attemptId: null,
      artifactEpoch: 0,
    };

    void pump.wake(fact);
    void pump.wake(fact);
    await Promise.resolve();
    expect(runs).toBe(1);
    releaseResume();
    await pump.idle();
    await pump.wake({ ...fact, key: "browser_control_returned:3:9" });

    expect(runs).toBe(1);
    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({
      report: "{}",
      jobId: "f121428e-6ccb-4199-9db0-26c08c633dca",
    }));
    expect(trace.all().map((event) => event.label)).toEqual(expect.arrayContaining([
      "resume diver after browser continuation",
      "ignored duplicate diver continuation",
      "ignored diver continuation because no job is awaiting human input",
    ]));
  });

  it("does not let a continuation older than the current wait wake the job", async () => {
    const trace = new Trace();
    const store = {
      load: () => ({
        version: 1 as const,
        id: "fc98e544-d135-40d7-9dc2-acde4a1e73f9",
        intent: "Export people.",
        status: "awaiting_human" as const,
        createdAt: 100,
        updatedAt: 500,
        continuations: [],
      }),
      save: vi.fn(),
    };
    const run = vi.fn(async () => "{}");
    const pump = createRuntimeDiverContinuationPump({ trace, store, run });

    await pump.wake({
      type: "diver.continue",
      reason: "browser_control_returned",
      key: "browser_control_returned:old",
      at: 499,
      controlEpoch: 1,
      navigationEpoch: 1,
      attemptId: null,
      artifactEpoch: 0,
    });

    expect(run).not.toHaveBeenCalled();
    expect(trace.all().map((event) => event.label)).toContain("ignored stale diver continuation");
  });

  it("records one observed event in the vault and makes it visible to the live world", async () => {
    const runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: smokeRun().root });
    const world = loadVaultWorld(runtime.vaultDir);
    runtime.dive.dive_evidence = vi.fn(async () => ({
      ok: true,
      note: "The current browser observation still matches the live page.",
      url: "http://127.0.0.1:4319/event/3cs",
    }));
    const hands = createRuntimeHands(runtime, world, { model: null, trace: new Trace() });
    const input = {
      observationId: "obs-7",
      platform: "luma",
      world: { name: "3Cs", lane: "topical" },
      gathering: { name: "3Cs Dinner", startsAt: "2026-09-01T19:00:00-07:00" },
    };

    await expect(hands.remember_event.run(input)).resolves.toMatch(/Recorded.*3Cs Dinner.*vault/i);

    const vault = openVault(runtime.vaultDir);
    expect(vault.contexts).toHaveLength(1);
    expect(vault.contexts[0]).toMatchObject({ name: "3Cs", kind: "professional", profile: "luma" });
    expect(vault.gatherings).toHaveLength(1);
    expect(vault.gatherings[0]).toMatchObject({
      context: vault.contexts[0].id,
      name: "3Cs Dinner",
      date: "2026-09-02T02:00:00.000Z",
      upcoming: true,
    });
    expect(vault.entries).toHaveLength(3);
    expect(vault.entries[0].payload).toMatchObject({
      name: "3Cs",
      lane: "topical",
      platform: "luma",
      sourceUrl: "http://127.0.0.1:4319/event/3cs",
    });
    expect(world.contexts).toEqual(vault.contexts);
    expect(world.gatherings).toEqual(vault.gatherings);
    expect(world.entries).toEqual(vault.entries);

    await expect(hands.remember_event.run(input)).resolves.toMatch(/already.*connected/i);
    expect(openVault(runtime.vaultDir).entries).toHaveLength(3);
  });

  it("leaves the vault untouched when browser evidence is stale", async () => {
    const runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: smokeRun().root });
    const world = loadVaultWorld(runtime.vaultDir);
    runtime.dive.dive_evidence = vi.fn(async () => ({
      ok: false,
      note: "That browser observation is stale. Observe the page again.",
    }));
    const hands = createRuntimeHands(runtime, world, { model: null, trace: new Trace() });

    await expect(hands.remember_event.run({
      observationId: "obs-2",
      platform: "luma",
      world: { name: "3Cs", lane: "topical" },
      gathering: { name: "3Cs Dinner", startsAt: "2026-09-01T19:00:00-07:00" },
    })).resolves.toMatch(/stale.*observe/i);

    expect(openVault(runtime.vaultDir).entries).toHaveLength(0);
    expect(world.contexts).toHaveLength(0);
  });

  it("fails closed when a smoke manifest points outside its run envelope", () => {
    const run = smokeRun();
    const manifest = JSON.parse(readFileSync(run.manifestPath, "utf8")) as {
      paths: Record<string, string>;
    };
    manifest.paths.vaultDir = resolve(run.root, "..", "persistent-vault");
    writeFileSync(run.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    expect(() => resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: run.root })).toThrow(
      "Smoke manifest paths do not match its run envelope.",
    );
  });

  it("fails closed when the requested smoke root has no manifest", () => {
    const root = mkdtempSync(resolve(tmpdir(), "lois-sidecar-missing-run-test-"));
    roots.push(root);

    expect(() => resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: root })).toThrow(
      `Smoke manifest not found: ${resolve(root, "manifest.json")}`,
    );
  });

  it("fails closed when the smoke root variable is present but blank", () => {
    expect(() => resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: "   " })).toThrow(
      "LOIS_SMOKE_RUN_ROOT is present but empty.",
    );
  });

  it("fails closed when smoke browser preflight is not clean", () => {
    const run = smokeRun();
    const manifest = JSON.parse(readFileSync(run.manifestPath, "utf8")) as {
      product: { clean: boolean };
      preflight: { browserAllowed: boolean };
    };
    manifest.product.clean = false;
    manifest.preflight.browserAllowed = false;
    writeFileSync(run.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    expect(() => resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: run.root })).toThrow(
      "Smoke browser startup requires a clean product tree recorded in the run manifest.",
    );
  });

  it("rejects truthy non-boolean clean-preflight values", () => {
    const run = smokeRun();
    const manifest = JSON.parse(readFileSync(run.manifestPath, "utf8")) as {
      product: { clean: unknown };
      preflight: { browserAllowed: unknown };
    };
    manifest.product.clean = "false";
    manifest.preflight.browserAllowed = { value: true };
    writeFileSync(run.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    expect(() => resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: run.root })).toThrow(
      "Smoke browser startup requires a clean product tree recorded in the run manifest.",
    );
  });

  it("persists the trace at the envelope path rather than beside the vault", () => {
    const run = smokeRun();
    const trace = openPersistentTraceFile(run.tracePath);

    trace.append({ actor: "organizer", kind: "heard", label: "hello" });

    expect(readFileSync(run.tracePath, "utf8")).toContain('"label":"hello"');
    expect(existsSync(resolve(run.vaultDir, "run-trace.jsonl"))).toBe(false);
  });

  it("assembles the sidecar system over that exact run trace", () => {
    const run = smokeRun();
    const built = buildSystem({ LOIS_SMOKE_RUN_ROOT: run.root });

    built.system.trace.append({ actor: "organizer", kind: "heard", label: "sidecar hello" });

    expect(readFileSync(run.tracePath, "utf8")).toContain('"label":"sidecar hello"');
    expect(existsSync(resolve(run.vaultDir, "run-trace.jsonl"))).toBe(false);
  });

  it("preserves the existing persistent binding when smoke mode is absent", () => {
    const runtime = resolveSidecarRuntime({});

    expect(runtime.mode).toBe("persistent");
    expect(runtime.runRoot).toBeUndefined();
    expect(runtime.tracePath).toBe(resolve(runtime.vaultDir, "run-trace.jsonl"));
    expect(runtime.browserStartUrl).toBeNull();
  });

  it("can bind a disposable live workspace without turning it into a smoke fixture", () => {
    const root = mkdtempSync(resolve(tmpdir(), "lois-live-workspace-test-"));
    roots.push(root);
    const vaultDir = resolve(root, "vault");
    const browserRoot = resolve(root, "browser");
    mkdirSync(vaultDir);
    writeFileSync(resolve(vaultDir, "stream.jsonl"), "", "utf8");
    writeFileSync(resolve(vaultDir, "persons.json"), "[]\n", "utf8");
    writeFileSync(resolve(vaultDir, "contexts.json"), "[]\n", "utf8");
    writeFileSync(resolve(vaultDir, "gatherings.json"), "[]\n", "utf8");

    const runtime = resolveSidecarRuntime({
      LOIS_VAULT_DIR: vaultDir,
      LOIS_BROWSER_WORKSPACE_ROOT: browserRoot,
    });

    expect(runtime).toMatchObject({
      mode: "persistent",
      vaultDir,
      tracePath: resolve(vaultDir, "run-trace.jsonl"),
      browserStartUrl: null,
      browserWorkspaceRoot: browserRoot,
    });
    expect(liveBrowserWorkspace(browserRoot)).toEqual({
      profileDir: resolve(browserRoot, "profile"),
      captureDir: resolve(browserRoot, "captures"),
      portFile: resolve(browserRoot, "chrome.debug-port"),
      defaultStartUrl: "https://luma.com",
      allowedStartOrigin: null,
      requireExplicitStartUrl: false,
    });
  });

  it("does not mix smoke envelopes with persistent workspace overrides", () => {
    expect(() => resolveSidecarRuntime({
      LOIS_SMOKE_RUN_ROOT: smokeRun().root,
      LOIS_VAULT_DIR: "/tmp/not-the-run-vault",
    })).toThrow(/cannot be combined/i);
  });

  it.each(["LOIS_VAULT_DIR", "LOIS_BROWSER_WORKSPACE_ROOT"] as const)(
    "fails clearly when %s is present but blank",
    (key) => {
      expect(() => resolveSidecarRuntime({ [key]: "   " })).toThrow(`${key} is present but empty.`);
    },
  );
});

describe("Lois sidecar entry boundary", () => {
  it("assembles and listens only when invoked as the direct entrypoint", () => {
    const cli = "file:///repo/sidecar/server.ts";
    expect(isDirectSidecar(cli, ["node", "/repo/sidecar/server.test.ts"])).toBe(false);
    expect(isDirectSidecar(cli, ["node", "/repo/sidecar/server.ts"])).toBe(true);
  });
});
