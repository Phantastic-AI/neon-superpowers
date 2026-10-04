// sidecar/runtime — one explicit binding for every mutable sidecar surface.
//
// Normal app sessions keep the established persistent vault/profile. A smoke
// session names a committed run root and either receives that exact envelope
// or fails closed; it never falls back into the organizer's persistent state.

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createDiveHands,
  createSmokeDiveHands,
  type DiveContinuationFact,
  type DiveHands,
  type DiveWorkspace,
} from "../tools/lois-dive.js";
import {
  BrowserStartInputSchema,
  EmptyHandInputSchema,
  OwnedArtifactListInputSchema,
  OwnedArtifactReadInputSchema,
  ResearchEvidenceInputSchema,
  RememberEventInputSchema,
  SemanticDownloadInputSchema,
  SemanticFollowInputSchema,
  SemanticPrepareInputSchema,
  semanticDownloadTrace,
  semanticFollowTrace,
  semanticPrepareTrace,
} from "../packages/lois/hand-schemas.js";
import {
  createDiver,
  type DiveIntent,
  DiveIntentSchema,
  parseDiverJob,
  publicDiverJob,
  type DiverCapabilities,
  type DiverJobStore,
  type DiverModelRun,
} from "../packages/lois/diver.js";
import type { MouthOptions } from "../packages/lois/mind.js";
import type { LoisModel } from "../packages/lois/model.js";
import { digest, type Trace } from "../packages/lois/trace.js";
import { connectPageEvent } from "../packages/organs/connect.js";
import { openVault, type Vault } from "../packages/vault/store.js";
import type { World } from "../tools/projections/types.js";
import { tracePath as persistentTracePath } from "../tools/lois-persist.js";
import {
  assertBrowserPreflight,
  loadSmokeRun,
  readSmokeRunManifest,
} from "../tools/lois-smoke-run.js";
import { resolveVaultDir } from "./vault.js";
import { createPeopleCapabilities, createPeopleWorldHand } from "./people-capabilities.js";
import { createPeopleHands } from "./people-hands.js";
import { createBackgroundDiver, type BackgroundDiver, type WorkerSettlement } from "./background-diver.js";

export const LOIS_TURN_MAX_STEPS = 30;
const LOIS_SMOKE_TURN_MAX_STEPS = 10;
export const LOIS_DIVER_MAX_STEPS = 20;
const LOIS_SMOKE_DIVER_MAX_STEPS = 10;

export function runtimeTurnMaxSteps(runtime: Pick<SidecarRuntime, "mode">): number {
  return runtime.mode === "smoke" ? LOIS_SMOKE_TURN_MAX_STEPS : LOIS_TURN_MAX_STEPS;
}

export function runtimeDiverMaxSteps(runtime: Pick<SidecarRuntime, "mode">): number {
  return runtime.mode === "smoke" ? LOIS_SMOKE_DIVER_MAX_STEPS : LOIS_DIVER_MAX_STEPS;
}

export interface SidecarRuntime {
  mode: "persistent" | "smoke";
  runRoot?: string;
  vaultDir: string;
  tracePath: string;
  diverStatePath: string;
  browserStartUrl: string | null;
  browserStartDescription: string;
  browserCloseDescription: string;
  /** Present only when a persistent run uses a caller-owned browser workspace. */
  browserWorkspaceRoot?: string;
  dive: DiveHands;
}

export interface RuntimeDiverContinuationPumpOptions {
  trace: Trace;
  store: DiverJobStore;
  run: (input: DiveIntent, context?: { onProgress?: () => void; continuation?: DiveContinuationFact }) => Promise<string>;
  onSettled?: (result: { event: DiveContinuationFact; report: string; jobId: string }) => void | Promise<void>;
}

// One durable diver job path has one live continuation consumer. Rebuilding
// runtime hands replaces the old pump instead of leaving a stale model/store
// subscribed to the same browser workspace.
const runtimeContinuationUnsubscribers = new Map<string, () => void>();
const runtimeDiverFlights = new Map<string, BackgroundDiver>();

export function cancelRuntimeDiver(runtime: Pick<SidecarRuntime, "diverStatePath">): void {
  runtimeDiverFlights.get(runtime.diverStatePath)?.cancel();
}

export async function idleRuntimeDiver(runtime: Pick<SidecarRuntime, "diverStatePath">): Promise<void> {
  await runtimeDiverFlights.get(runtime.diverStatePath)?.idle();
}

/** Shutdown only: stop wake subscriptions before draining the owned flight. */
export async function closeRuntimeDiver(runtime: Pick<SidecarRuntime, "diverStatePath">): Promise<void> {
  runtimeContinuationUnsubscribers.get(runtime.diverStatePath)?.();
  runtimeContinuationUnsubscribers.delete(runtime.diverStatePath);
  const background = runtimeDiverFlights.get(runtime.diverStatePath);
  background?.cancel({ preserveWaiting: true });
  await background?.idle();
  if (runtimeDiverFlights.get(runtime.diverStatePath) === background) runtimeDiverFlights.delete(runtime.diverStatePath);
}

export function createRuntimeDiverContinuationPump(
  options: RuntimeDiverContinuationPumpOptions,
): {
  wake(event: DiveContinuationFact): Promise<void>;
  idle(): Promise<void>;
} {
  const seen = new Set<string>();
  let inFlight: Promise<void> | null = null;
  let queued: DiveContinuationFact | null = null;

  const intentFor = (event: DiveContinuationFact): string => JSON.stringify({
    type: event.type,
    reason: event.reason,
    key: event.key,
    at: event.at,
    controlEpoch: event.controlEpoch,
    navigationEpoch: event.navigationEpoch,
    attemptId: event.attemptId,
    artifactEpoch: event.artifactEpoch,
    ...(event.url ? { url: event.url } : {}),
    ...(event.filename ? { filename: event.filename } : {}),
    ...(typeof event.bytes === "number" ? { bytes: event.bytes } : {}),
  });

  async function wake(event: DiveContinuationFact): Promise<void> {
    const job = options.store.load();
    const intent = intentFor(event);
    const wakeKey = job ? `${job.id}:${event.key}` : event.key;
    if (seen.has(wakeKey) || job?.continuations.includes(intent)) {
      options.trace.append({
        actor: "diver",
        kind: "note",
        label: "ignored duplicate diver continuation",
        detail: { ...(job ? { jobId: job.id } : {}), reason: event.reason, keyDigest: digest(event.key) },
      });
      return;
    }
    if (job && event.at < job.updatedAt) {
      options.trace.append({
        actor: "diver",
        kind: "note",
        label: "ignored stale diver continuation",
        detail: { jobId: job.id, reason: event.reason, keyDigest: digest(event.key) },
      });
      return;
    }
    if (inFlight) {
      queued = event;
      options.trace.append({
        actor: "diver",
        kind: "note",
        label: "queued diver continuation while resume is already running",
        detail: { ...(job ? { jobId: job.id } : {}), reason: event.reason, keyDigest: digest(event.key) },
      });
      return;
    }
    if (job?.status !== "awaiting_human") {
      options.trace.append({
        actor: "diver",
        kind: "note",
        label: "ignored diver continuation because no job is awaiting human input",
        detail: { reason: event.reason, keyDigest: digest(event.key) },
      });
      return;
    }
    seen.add(wakeKey);
    const woke = options.trace.append({
      actor: "diver",
      kind: "woke",
      label: "resume diver after browser continuation",
      detail: { jobId: job.id, reason: event.reason, keyDigest: digest(event.key) },
    });
    inFlight = (async () => {
      try {
        const report = await options.run({ intent }, {
          continuation: event,
          onProgress: () => {
            options.trace.append({
              actor: "diver",
              kind: "note",
              label: "browser continuation resume made progress",
              detail: { jobId: job.id },
              refs: [woke.seq],
            });
          },
        });
        try {
          await options.onSettled?.({ event, report, jobId: job.id });
        } catch (error) {
          options.trace.append({
            actor: "diver",
            kind: "note",
            label: "diver result landed but Lois could not speak it yet",
            detail: {
              jobId: job.id,
              error: error instanceof Error ? error.message : String(error),
            },
            refs: [woke.seq],
          });
        }
      } catch (error) {
        options.trace.append({
          actor: "diver",
          kind: "note",
          label: "browser continuation resume failed",
          detail: {
            jobId: job.id,
            error: error instanceof Error ? error.message : String(error),
          },
          refs: [woke.seq],
        });
      }
    })().finally(() => {
      inFlight = null;
      const next = queued;
      queued = null;
      if (next) void wake(next);
    });
    await inFlight;
  }

  return {
    wake,
    idle: async () => {
      while (inFlight || queued) {
        await inFlight;
        await Promise.resolve();
      }
    },
  };
}

function optionalPath(
  env: Record<string, string | undefined>,
  key: "LOIS_VAULT_DIR" | "LOIS_BROWSER_WORKSPACE_ROOT",
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(env, key)) return undefined;
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is present but empty.`);
  return resolve(value);
}

export function liveBrowserWorkspace(root: string): DiveWorkspace {
  return {
    profileDir: resolve(root, "profile"),
    captureDir: resolve(root, "captures"),
    portFile: resolve(root, "chrome.debug-port"),
    defaultStartUrl: "https://luma.com",
    allowedStartOrigin: null,
    requireExplicitStartUrl: false,
  };
}

export function resolveSidecarRuntime(
  env: Record<string, string | undefined> = process.env,
): SidecarRuntime {
  const smokeRequested = Object.prototype.hasOwnProperty.call(env, "LOIS_SMOKE_RUN_ROOT");
  const requestedRoot = env.LOIS_SMOKE_RUN_ROOT?.trim();
  const vaultOverride = optionalPath(env, "LOIS_VAULT_DIR");
  const browserRoot = optionalPath(env, "LOIS_BROWSER_WORKSPACE_ROOT");
  if (smokeRequested && !requestedRoot) {
    throw new Error("LOIS_SMOKE_RUN_ROOT is present but empty.");
  }
  if (requestedRoot) {
    if (vaultOverride || browserRoot) {
      throw new Error("LOIS_SMOKE_RUN_ROOT cannot be combined with persistent workspace overrides.");
    }
    const run = loadSmokeRun(requestedRoot);
    assertBrowserPreflight(run);
    const manifest = readSmokeRunManifest(run);
    return {
      mode: "smoke",
      runRoot: run.root,
      vaultDir: run.vaultDir,
      tracePath: run.tracePath,
      diverStatePath: resolve(dirname(run.tracePath), "diver-job.json"),
      browserStartUrl: manifest.mockUrl,
      browserStartDescription:
        `Open the run-owned browser on the local 3Cs mock at ${manifest.mockUrl}. ` +
        "Use only after the organizer consents in this conversation, then observe the page before deciding what happens next. This proof is local: no real invitations can leave it.",
      browserCloseDescription:
        "Close this run's browser window. Its isolated test profile remains only in the run envelope.",
      dive: createSmokeDiveHands(run),
    };
  }

  const vaultDir = vaultOverride ?? resolveVaultDir();
  const tracePath = persistentTracePath(vaultDir);
  const browserWorkspace = browserRoot ? liveBrowserWorkspace(browserRoot) : undefined;
  return {
    mode: "persistent",
    vaultDir,
    tracePath,
    diverStatePath: resolve(dirname(tracePath), "diver-job.json"),
    browserStartUrl: null,
    browserStartDescription:
      "Open Superpowers' own browser window on Luma (your persistent profile, never the organizer's browser). Use only after the organizer consents in this conversation, then observe the page before deciding what happens next. Ask for their hands only when the observed page presents a human-only step; you cannot see their password.",
    browserCloseDescription: "Close your browser window. The signed-in session stays saved in your profile.",
    ...(browserRoot ? { browserWorkspaceRoot: browserRoot } : {}),
    dive: createDiveHands(browserWorkspace ? { workspace: browserWorkspace } : undefined),
  };
}

export function startRuntimeBrowser(runtime: SidecarRuntime, requestedUrl?: string): Promise<string> {
  return runtime.dive.dive_start(
    requestedUrl ?? runtime.browserStartUrl ?? undefined,
    true,
  );
}

export function closeRuntimeBrowser(runtime: SidecarRuntime): Promise<string> {
  return runtime.dive.dive_close();
}

function connectedContextForSource(vault: Vault, sourceUrl: string): string | null {
  const entry = vault.entries.find(
    (candidate) => candidate.type === "context" && candidate.payload.sourceUrl === sourceUrl,
  );
  return entry?.context ?? null;
}

function syncWorld(world: World, vault: Vault): void {
  world.entries = vault.entries;
  world.persons = vault.persons;
  world.contexts = vault.contexts;
  world.gatherings = vault.gatherings;
}

/** The capability library belongs to the isolated diver, never the mouth. */
export function createDiverCapabilities(runtime: SidecarRuntime, world: World): DiverCapabilities {
  // Artifact possession can support artifact research, never certify a write
  // performed by another hand (such as saving a people list).
  const artifactEvidenceCategories = new Set(["current_event_csv", "series_attendance_index"]);
  return {
    ...createPeopleCapabilities(runtime, world),
    browser_start: {
      description: `${runtime.browserStartDescription} The same move returns the page's first bounded semantic observation. This also resumes automation on a browser the organizer has finished using in the embedded pane; it never takes a foreground human window.`,
      inputSchema: BrowserStartInputSchema,
      run: async (input) => {
        const started = await startRuntimeBrowser(runtime, BrowserStartInputSchema.parse(input).url);
        const observed = await runtime.dive.dive_observe();
        return `${started}\n\n${observed}`;
      },
      evidenceCategories: () => ["browser_frame"],
    },
    browser_capture: {
      description:
        "Capture the page currently open in your browser window (DOM + screenshot, saved locally as evidence). Use when observation shows the relevant page is ready; do not assume the organizer must sign in first.",
      inputSchema: EmptyHandInputSchema,
      run: () => runtime.dive.dive_capture(),
    },
    browser_status: {
      description: "Check whether your browser window is open and what page it shows. Do not use this as a ritual check when the current task does not need the browser.",
      inputSchema: EmptyHandInputSchema,
      run: () => runtime.dive.dive_status(),
    },
    browser_summon: {
      description:
        "Bring your browser window on-screen and in front, for the moments only the organizer's own hands can do: signing in, a consent screen, a native file picker, a challenge that wants a real click.",
      inputSchema: EmptyHandInputSchema,
      run: () => runtime.dive.dive_summon(),
    },
    browser_dismiss: {
      description:
        "After browser_summon brought the browser into the foreground, put that same window back into the embedded pane. Never call this for a window that is already embedded.",
      inputSchema: EmptyHandInputSchema,
      run: () => runtime.dive.dive_dismiss(),
    },
    browser_observe: {
      description:
        "Read the currently open page as a bounded semantic snapshot. Call this immediately after opening the browser, before asking for the organizer's hands, and again before preparing fields. It returns ephemeral refs and omits credentials, entered values, and URL query data.",
      inputSchema: EmptyHandInputSchema,
      run: () => runtime.dive.dive_observe(),
      evidenceCategories: () => ["browser_frame"],
    },
    browser_follow: {
      description:
        "Follow one same-site link or activate one native view button from the latest observation by its exact ref. The same call returns a fresh observation of the changed page. Button activation runs behind a read-only browser fence that blocks write requests, form submission, and cross-site navigation.",
      inputSchema: SemanticFollowInputSchema,
      traceInput: semanticFollowTrace,
      run: (input) => runtime.dive.dive_follow(SemanticFollowInputSchema.parse(input)),
    },
    browser_download: {
      description:
        "Download or export a file from one exact control in the latest observation into your owned browser workspace. This is not a general click: use it only when the control's visible meaning is to download or export data, never to invite, publish, delete, or submit a form. If the page asks for human confirmation instead of emitting a file, observe and handle that state honestly.",
      inputSchema: SemanticDownloadInputSchema,
      traceInput: semanticDownloadTrace,
      run: (input) => runtime.dive.dive_download(SemanticDownloadInputSchema.parse(input)),
    },
    browser_read_artifact: {
      description:
        "Page through the latest readable artifact captured by your browser, or one exact owned artifactId. It accepts an offset and bounded character count, never a path. Start small; continue from the returned offset only when the task needs more.",
      inputSchema: OwnedArtifactReadInputSchema,
      run: (input) => runtime.dive.dive_read_download(OwnedArtifactReadInputSchema.parse(input)),
    },
    browser_list_artifacts: {
      description:
        "List the browser artifacts owned by this research workspace, newest first. Use the opaque cursor to page older history. The result exposes stable artifact ids and metadata, never an arbitrary filesystem read capability.",
      inputSchema: OwnedArtifactListInputSchema,
      run: async (input) => JSON.stringify(
        await runtime.dive.dive_list_artifacts(OwnedArtifactListInputSchema.parse(input)),
      ),
    },
    research_record_evidence: {
      description:
        "After reading the owned source artifacts needed for a conclusion, record one semantic evidence receipt. The host verifies every artifact id exists in this job-owned workspace before the category can support completion. Use current_event_csv for one event export and series_attendance_index only after you have actually synthesized the series history.",
      inputSchema: ResearchEvidenceInputSchema,
      traceInput: (input) => {
        const parsed = ResearchEvidenceInputSchema.parse(input);
        return {
          category: parsed.category,
          artifactCount: parsed.artifactIds.length,
          artifactIdDigests: parsed.artifactIds.map(digest),
          summaryDigest: digest(parsed.summary),
        };
      },
      run: async (input) => {
        const parsed = ResearchEvidenceInputSchema.parse(input);
        const wanted = new Set(parsed.artifactIds);
        const found = new Set<string>();
        let cursor: string | null | undefined;
        do {
          const page = await runtime.dive.dive_list_artifacts({ cursor, limit: 50 });
          for (const artifact of page.artifacts) {
            if (wanted.has(artifact.artifactId)) found.add(artifact.artifactId);
          }
          cursor = page.nextCursor;
        } while (cursor && found.size < wanted.size);
        const missing = parsed.artifactIds.filter((artifactId) => !found.has(artifactId));
        const evidenceLawFailure = !artifactEvidenceCategories.has(parsed.category)
          ? "This hand records artifact research. A saved result needs the receipt from the hand that saved it."
          : parsed.category === "series_attendance_index" && wanted.size < 2
          ? "A series attendance index needs at least two distinct owned source artifacts; one event export remains current-event evidence."
          : null;
        return JSON.stringify(missing.length === 0 && !evidenceLawFailure
          ? {
              ok: true,
              category: parsed.category,
              artifactIds: parsed.artifactIds,
              summaryDigest: digest(parsed.summary),
            }
          : {
              ok: false,
              category: parsed.category,
              ...(missing.length > 0 ? { missingArtifactIds: missing } : {}),
              ...(evidenceLawFailure ? { why: evidenceLawFailure } : {}),
            });
      },
      evidenceCategories: (input, output) => {
        const parsedInput = ResearchEvidenceInputSchema.safeParse(input);
        if (!parsedInput.success || !artifactEvidenceCategories.has(parsedInput.data.category)) return [];
        try {
          const receipt = JSON.parse(output) as { ok?: unknown };
          return receipt.ok === true ? [parsedInput.data.category] : [];
        } catch {
          return [];
        }
      },
    },
    browser_prepare: {
      description:
        "Prepare safe native fields from the latest observation using its exact refs. Put ordered field operations in one call. This may fill text, check checkboxes, or select visible option labels; it cannot click or submit.",
      inputSchema: SemanticPrepareInputSchema,
      traceInput: semanticPrepareTrace,
      run: (input) => runtime.dive.dive_prepare(SemanticPrepareInputSchema.parse(input)),
    },
    browser_close: {
      description: runtime.browserCloseDescription,
      inputSchema: EmptyHandInputSchema,
      run: () => runtime.dive.dive_close(),
    },
  };
}

function createFileDiverJobStore(path: string): DiverJobStore {
  return {
    load: () => {
      try {
        return parseDiverJob(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        return null;
      }
    },
    save: (job) => {
      mkdirSync(dirname(path), { recursive: true });
      const next = `${path}.next`;
      writeFileSync(next, `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      chmodSync(next, 0o600);
      renameSync(next, path);
    },
  };
}

export function readRuntimeDiverJob(runtime: Pick<SidecarRuntime, "diverStatePath">) {
  const job = createFileDiverJobStore(runtime.diverStatePath).load();
  return job ? publicDiverJob(job) : null;
}

function artifactOwnerFor(job: ReturnType<DiverJobStore["load"]>): string | null {
  return job && (job.status === "running" || job.status === "awaiting_human" || job.status === "partial")
    ? job.id
    : null;
}

export interface CreateRuntimeHandsOptions {
  model: LoisModel | null;
  trace: Trace;
  maxSteps?: number;
  runModel?: DiverModelRun;
  store?: DiverJobStore;
  onWorkerSettled?: (result: WorkerSettlement) => void | Promise<void>;
}

/** One browser door plus native local actions for the app server and smoke runner. */
export function createRuntimeHands(
  runtime: SidecarRuntime,
  world: World,
  options: CreateRuntimeHandsOptions,
): NonNullable<MouthOptions["hands"]> {
  const durableStore = options.store ?? createFileDiverJobStore(runtime.diverStatePath);
  const store: DiverJobStore = {
    load: () => durableStore.load(),
    save: (job) => {
      durableStore.save(job);
      runtime.dive.dive_bind_job(artifactOwnerFor(job));
    },
  };
  runtime.dive.dive_bind_job(artifactOwnerFor(store.load()));
  const runDiveUnserialized = createDiver({
    model: options.model,
    trace: options.trace,
    capabilities: createDiverCapabilities(runtime, world),
    store,
    maxSteps: options.maxSteps ?? runtimeDiverMaxSteps(runtime),
    runModel: options.runModel,
  });
  const existingFlight = runtimeDiverFlights.get(runtime.diverStatePath);
  const background = existingFlight?.hasPendingWork() ? existingFlight : createBackgroundDiver({
    store,
    run: runDiveUnserialized,
    onSettled: options.onWorkerSettled,
    onDeliveryError: (error, jobId) => options.trace.append({
      actor: "diver", kind: "note", label: "research result delivery failed",
      detail: { jobId, error: error instanceof Error ? error.message : String(error) },
    }),
  });
  background.setOnSettled(options.onWorkerSettled);
  runtimeDiverFlights.set(runtime.diverStatePath, background);
  const continuation = createRuntimeDiverContinuationPump({
    trace: options.trace,
    store,
    run: (input, context) => background.runAndWait(input, context, context?.continuation ? {
      reason: context.continuation.reason,
      continuationKeyDigest: digest(context.continuation.key),
    } : undefined),
  });
  runtimeContinuationUnsubscribers.get(runtime.diverStatePath)?.();
  const unsubscribe = runtime.dive.dive_on_continue((event) => {
    void continuation.wake(event);
  });
  runtimeContinuationUnsubscribers.set(runtime.diverStatePath, unsubscribe);
  const unhandled = runtime.dive.dive_latest_continue();
  if (unhandled) void continuation.wake(unhandled);
  return {
    remember_world: createPeopleWorldHand(runtime.vaultDir, world),
    ...createPeopleHands(runtime.vaultDir, world),
    dive: {
      description:
        "Launch a durable background research job and immediately receive its persisted job receipt, not the finished result. Preserve the organizer's complete outcome, including saving people, boundaries and known World/view IDs. The diver keeps working while you answer. Read research_status for progress; do not keep calling dive to poll. An active job is returned, never duplicated; requestApplied=false means your new intent was not sent to it. Use research_cancel to stop it before starting changed work. Its settled report will wake you. Reconcile partial results with saved state and call dive to continue useful unfinished work.",
      inputSchema: DiveIntentSchema,
      traceInput: (input) => {
        const parsed = DiveIntentSchema.parse(input);
        return { intentDigest: digest(parsed.intent), intentChars: parsed.intent.length };
      },
      run: (input, context) => background.start(DiveIntentSchema.parse(input), context?.signal),
    },
    research_status: {
      description: "Read the current persisted research job, its actual completed capability progress, saved-evidence categories and model-authored summary/next step. Running is not completion. This does not browse or launch work.",
      inputSchema: EmptyHandInputSchema,
      run: async () => JSON.stringify(background.status()),
    },
    research_cancel: {
      description: "Stop the current research job and any queued result reply when the organizer stops or redirects that work. Already saved findings remain. Read research_status until active=false before launching changed work; a pending capability must settle before another browser flight can start.",
      inputSchema: EmptyHandInputSchema,
      run: async () => JSON.stringify({ cancelled: background.cancel(), job: background.status() }),
    },
    remember_event: {
      description:
        "Connect one upcoming Gathering and its World in the vault after the organizer asked to connect it and the current browser observation supplied its event facts. This hand uses the current page, not a collection of earlier observations. Historical guestlists belong in the diver's saved-people import path, which needs no upcoming Gathering. This writes only Superpowers' local vault; it never creates or changes an event on Luma or Partiful. Claim a connection only after this hand returns success.",
      inputSchema: RememberEventInputSchema,
      run: async (input) => {
        const event = RememberEventInputSchema.parse(input);
        const evidence = await runtime.dive.dive_evidence(event.observationId);
        if (!evidence.ok || !evidence.url) return evidence.note;
        const vault = openVault(runtime.vaultDir);
        const connected = connectedContextForSource(vault, evidence.url);
        if (connected) {
          const name = vault.contextById.get(connected)?.name ?? connected;
          return `That observed event is already connected in the vault as World ${name}.`;
        }

        const contextId = `c-${randomUUID()}`;
        const gatheringId = `g-${randomUUID()}`;
        const startsAt = new Date(event.gathering.startsAt).toISOString();
        connectPageEvent(
          vault,
          { title: event.gathering.name, date: startsAt, guests: [] },
          { contextId, gatheringId },
          {
            contextName: event.world.name,
            lane: event.world.lane,
            platform: event.platform,
            sourceUrl: evidence.url,
          },
        );
        syncWorld(world, vault);
        return `Recorded ${event.gathering.name} in the vault under World ${event.world.name}. It is connected to ${evidence.url}; no invitations were sent.`;
      },
    },
  };
}
