// tools/lois-dive — the dive as HER HANDS, driven from chat (D-117, D-052).
//
// Server-side singleton around Superpowers' own persistent Chrome profile.
// The isolated diver gets these browser organs through the server's bounded
// capability library; the mouth sees only dive(intent). The organizer enters
// the loop only when the observed page itself presents a human-only step.
//
// Never the operator's browser (D-052). The profile keeps the session, so
// sign-in happens once. Captures carry real PII: local capture dir only.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, extname, resolve } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Download,
  type Locator,
  type Page,
  type Route,
} from "playwright-core";
import { assertBrowserPreflight, type SmokeRunPaths } from "./lois-smoke-run.js";
import {
  createSemanticSession,
  type SemanticControlMetadata,
  type SemanticDownloadActivation,
  type SemanticFacts,
  type SemanticEvidenceResult,
  type SemanticObservationSnapshot,
  type SemanticPage,
  type SemanticPrepareInput,
} from "./lois-semantic.js";
import type {
  OwnedArtifactReadInput,
  SemanticDownloadInput,
  SemanticFollowInput,
} from "../packages/lois/hand-schemas.js";

const APP_DIR = resolve(homedir(), "Library", "Application Support", "Neon Superpowers");

export interface DiveWorkspace {
  profileDir: string;
  captureDir: string;
  /** Beside the profile, never inside it (Chrome owns the profile dir). */
  portFile: string;
  defaultStartUrl: string | null;
  allowedStartOrigin: string | null;
  requireExplicitStartUrl: boolean;
}

const DEFAULT_WORKSPACE: DiveWorkspace = Object.freeze({
  profileDir: resolve(APP_DIR, "profiles", "hacker-garage"),
  captureDir: resolve(APP_DIR, "captures"),
  portFile: resolve(APP_DIR, "profiles", "hacker-garage.debug-port"),
  defaultStartUrl: "https://lu.ma",
  allowedStartOrigin: null,
  requireExplicitStartUrl: false,
});

function sameWorkspace(left: DiveWorkspace, right: DiveWorkspace): boolean {
  return (
    left.profileDir === right.profileDir &&
    left.captureDir === right.captureDir &&
    left.portFile === right.portFile &&
    left.defaultStartUrl === right.defaultStartUrl &&
    left.allowedStartOrigin === right.allowedStartOrigin &&
    left.requireExplicitStartUrl === right.requireExplicitStartUrl
  );
}

function workspaceLeaseRefusal(
  active: DiveWorkspace | null,
  requested: DiveWorkspace,
): string | null {
  if (!active || sameWorkspace(active, requested)) return null;
  return "another browser workspace owns the live lease";
}

function loopbackOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Smoke manifest mock URL is invalid.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback) {
    throw new Error("Smoke manifest mock URL must be loopback HTTP.");
  }
  return url.origin;
}

function createSmokeWorkspace(run: SmokeRunPaths): DiveWorkspace {
  assertBrowserPreflight(run);
  const manifest = JSON.parse(readFileSync(run.manifestPath, "utf8")) as {
    mockUrl?: string;
    paths?: Partial<SmokeRunPaths>;
  };
  const pathKeys: (keyof SmokeRunPaths)[] = [
    "root",
    "vaultDir",
    "chromeProfileDir",
    "tracePath",
    "evidenceDir",
    "manifestPath",
    "modelUsagePath",
    "approvalsPath",
    "receiptsPath",
  ];
  if (pathKeys.some((key) => manifest.paths?.[key] !== run[key])) {
    throw new Error("Smoke manifest paths do not match the requested run envelope.");
  }
  if (!manifest.mockUrl) throw new Error("Smoke manifest is missing its mock URL.");
  return {
    profileDir: resolve(run.chromeProfileDir),
    captureDir: resolve(run.evidenceDir),
    portFile: resolve(run.root, "chrome.debug-port"),
    defaultStartUrl: null,
    allowedStartOrigin: loopbackOrigin(manifest.mockUrl),
    requireExplicitStartUrl: true,
  };
}

function resolveStartUrl(workspace: DiveWorkspace, requested?: string): string {
  if (!requested && workspace.requireExplicitStartUrl) {
    throw new Error("Smoke browser start requires an explicit URL.");
  }
  const raw = requested ?? workspace.defaultStartUrl;
  if (!raw) throw new Error("Browser start requires a URL.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Browser start URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser start URL must use HTTP or HTTPS.");
  }
  if (workspace.allowedStartOrigin && url.origin !== workspace.allowedStartOrigin) {
    throw new Error(`Smoke browser start must stay on mock origin ${workspace.allowedStartOrigin}.`);
  }
  return url.href;
}

// The IRONCLAD launch (proven on the estate — apps/desktop/src-tauri/src/
// browser_workspace.rs `browser_args`, written up in docs/browser-antibot-note.md;
// re-proven 2026-08-29 when Cloudflare Turnstile rejected playwright's
// launchPersistentContext): spawn REAL Chrome as a NORMAL process — profile
// dir + debugging port and NOTHING else, no --enable-automation, no sandbox
// tweaks, no --disable-blink-features — then merely ATTACH over CDP.
// navigator.webdriver stays false; the browser is indistinguishable from a
// person's because it IS one. Cloudflare fingerprints the engine (TLS/JA3,
// HTTP/2 frames, JS quirks), not the UA string, so the only way past it is to
// actually be a stock Chrome.
//
// Launched through LaunchServices (`open -n -a`), exactly as browser_workspace.rs
// does on macOS: a new instance, foreground, ordinary process shape. `open`
// returns at once, so readiness is the DEBUG PORT answering, never a child handle.
const CHROME_APP = "Google Chrome";
const DEFAULT_CDP_PORT = 9223;

// Off-screen by default (D-124): the embedded pane is where the browser
// APPEARS; the real window is parked off the desktop and driven over CDP.
// Window geometry is not an automation fingerprint — a person can have an
// off-screen window, and Cloudflare fingerprints the engine, not the desktop.
//
// macOS will NOT be told this on the command line: --window-position=-32000
// is clamped back to {0,39} at launch (measured 2026-08-29). Only CDP
// Browser.setWindowBounds moves it out, and even that clamps to keep ~40px
// reachable — so the honest result is a sliver at the left edge, off the
// working area, still rendering. The flags below are kept for the SIZE (and
// they cost nothing); the parking is done over CDP right after attaching.
const OFFSCREEN = { left: -32000, top: -32000, width: 1280, height: 900 };
const ONSCREEN = { left: 100, top: 100, width: 1280, height: 900 };
const SCREENCAST_OPTIONS = Object.freeze({
  format: "jpeg" as const,
  quality: 60,
  maxWidth: 1280,
  maxHeight: 960,
  // A static page may emit only its initial paint; the pane must not skip it.
  everyNthFrame: 1,
});

/** The whole flag set. Anything added here is a fingerprint; add nothing. */
function chromeArgs(workspace: DiveWorkspace, port: number, url: string): string[] {
  return [
    `--user-data-dir=${workspace.profileDir}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    `--window-position=${OFFSCREEN.left},${OFFSCREEN.top}`,
    `--window-size=${OFFSCREEN.width},${OFFSCREEN.height}`,
    "--new-window",
    url,
  ];
}

/** The `open` process only — Chrome is NOT our child; it outlives this handle. */
let launcher: ChildProcess | null = null;
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let screencast: CDPSession | null = null;
let cdpPort: number | null = null;
let activeWorkspace: DiveWorkspace | null = null;
let closingBrowser = false;

type PageRef = {
  url(): string;
  isClosed(): boolean;
};

export type BrowserMode = "embedded" | "foreground_hands" | "reconciling" | "blocked" | "closed";
export type BrowserInputOwner = "automation" | "pane" | "hands";
type EmbeddedInputOwner = Exclude<BrowserInputOwner, "hands">;

export type DiveContinuationReason = "owned_download_captured" | "browser_control_returned";

export interface DiveContinuationFact {
  type: "diver.continue";
  reason: DiveContinuationReason;
  key: string;
  at: number;
  controlEpoch: number;
  navigationEpoch: number;
  attemptId: string | null;
  artifactEpoch: number;
  url?: string;
  filename?: string;
  bytes?: number;
}

type DiveContinuationInternalFact = DiveContinuationFact & { workspaceKey: string };
type DiveContinuationSubscriber = (event: DiveContinuationFact) => void;
const diveContinuationSubscribers = new Set<(event: DiveContinuationInternalFact) => void>();
const CONTINUATION_LOG = "continuations.jsonl";
const MAX_CONTINUATION_TAIL_BYTES = 256 * 1024;

function diveWorkspaceKey(workspace: DiveWorkspace): string {
  return [
    resolve(workspace.profileDir),
    resolve(workspace.captureDir),
    resolve(workspace.portFile),
    workspace.allowedStartOrigin ?? "",
  ].join("\n");
}

function continuationLogPath(workspace: DiveWorkspace): string {
  return resolve(workspace.captureDir, ".diver-state", CONTINUATION_LOG);
}

function isDiveContinuationFact(value: unknown): value is DiveContinuationFact {
  if (!value || typeof value !== "object") return false;
  const fact = value as Partial<DiveContinuationFact>;
  return (
    fact.type === "diver.continue" &&
    (fact.reason === "owned_download_captured" || fact.reason === "browser_control_returned") &&
    typeof fact.key === "string" &&
    typeof fact.at === "number" &&
    typeof fact.controlEpoch === "number" &&
    typeof fact.navigationEpoch === "number" &&
    (fact.attemptId === null || typeof fact.attemptId === "string") &&
    typeof fact.artifactEpoch === "number"
  );
}

/** Read only a bounded tail: continuation history is append-only and may live forever. */
function readDiveContinuationTail(workspace: DiveWorkspace): DiveContinuationFact[] {
  const path = continuationLogPath(workspace);
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, MAX_CONTINUATION_TAIL_BYTES);
    const offset = size - length;
    const buffer = Buffer.alloc(length);
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, length, offset);
    const lines = buffer.toString("utf8").split("\n");
    if (offset > 0) lines.shift();
    return lines.flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const parsed: unknown = JSON.parse(line);
        return isDiveContinuationFact(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function persistDiveContinuation(workspace: DiveWorkspace, event: DiveContinuationFact): boolean {
  try {
    const path = continuationLogPath(workspace);
    mkdirSync(resolve(path, ".."), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function emitDiveContinuation(
  workspace: DiveWorkspace,
  event: DiveContinuationFact,
): boolean {
  // The fact becomes durable before listeners can try to resume the job. A
  // sidecar death between those two operations is recovered from this log.
  if (!persistDiveContinuation(workspace, event)) return false;
  const workspaceKey = diveWorkspaceKey(workspace);
  const internal = { ...event, workspaceKey };
  for (const subscriber of diveContinuationSubscribers) subscriber(internal);
  return true;
}

function latestDiveContinuation(workspace: DiveWorkspace): DiveContinuationFact | null {
  return readDiveContinuationTail(workspace).at(-1) ?? null;
}

function nextArtifactEpoch(workspace: DiveWorkspace): number {
  return latestArtifactEpoch(workspace) + 1;
}

function latestArtifactEpoch(workspace: DiveWorkspace): number {
  return readDiveContinuationTail(workspace).reduce(
    (latest, event) => Math.max(latest, event.artifactEpoch),
    0,
  );
}

function onDiveContinuation(
  workspace: DiveWorkspace,
  subscriber: DiveContinuationSubscriber,
): () => void {
  const key = diveWorkspaceKey(workspace);
  const filtered = (event: DiveContinuationInternalFact): void => {
    if (event.workspaceKey !== key) return;
    const { workspaceKey: _workspaceKey, ...publicEvent } = event;
    subscriber(publicEvent);
  };
  diveContinuationSubscribers.add(filtered);
  return () => diveContinuationSubscribers.delete(filtered);
}

function createBrowserControlState(initialOwner: EmbeddedInputOwner | null = null) {
  let mode: BrowserMode = initialOwner === null ? "closed" : "embedded";
  let inputOwner: BrowserInputOwner | null = initialOwner;
  let resumeOwner: EmbeddedInputOwner | null = initialOwner;
  let controlEpoch = 0;

  function enter(nextMode: BrowserMode, nextOwner: BrowserInputOwner | null): void {
    mode = nextMode;
    inputOwner = nextOwner;
    controlEpoch += 1;
  }

  return {
    snapshot(): { mode: BrowserMode; inputOwner: BrowserInputOwner | null } {
      return { mode, inputOwner };
    },
    accepts(owner: BrowserInputOwner): boolean {
      return inputOwner === owner;
    },
    epoch(): number {
      return controlEpoch;
    },
    open(owner: BrowserInputOwner): void {
      resumeOwner = owner === "hands" ? null : owner;
      enter(owner === "hands" ? "foreground_hands" : "embedded", owner);
    },
    claim(owner: EmbeddedInputOwner): boolean {
      if (mode !== "embedded") return false;
      if (inputOwner === owner) return true;
      resumeOwner = owner;
      enter("embedded", owner);
      return true;
    },
    summon(): boolean {
      if (mode === "foreground_hands" && inputOwner === "hands") return true;
      if (mode !== "embedded") return false;
      resumeOwner = inputOwner === "hands" ? null : inputOwner;
      enter("foreground_hands", "hands");
      return true;
    },
    dismiss(): boolean {
      if (mode !== "foreground_hands") return false;
      enter("reconciling", null);
      return true;
    },
    reconcile(valid: boolean, owner: EmbeddedInputOwner = resumeOwner ?? "pane"): boolean {
      if (mode !== "reconciling" && mode !== "blocked") return false;
      if (!valid) {
        enter("blocked", null);
        return false;
      }
      resumeOwner = owner;
      enter("embedded", owner);
      return true;
    },
    block(): void {
      enter("blocked", null);
    },
    close(): void {
      resumeOwner = null;
      enter("closed", null);
    },
  };
}

type BrowserControlState = ReturnType<typeof createBrowserControlState>;

function createSerialActions() {
  let tail: Promise<void> = Promise.resolve();

  return {
    run<T>(action: () => T | Promise<T>): Promise<T> {
      const result = tail.then(action, action);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

function isRealPageUrl(url: string): boolean {
  if (!url) return false;
  if (url === "about:blank") return false;
  if (url.startsWith("data:")) return false;
  return true;
}

function createPageFocusState<T extends PageRef>() {
  let focused: T | null = null;
  const seenAt = new WeakMap<T, number>();
  let sequence = 0;

  function remember(page: T): void {
    if (!page.isClosed() && isRealPageUrl(page.url())) {
      seenAt.set(page, ++sequence);
    }
  }

  function active(pages: readonly T[]): T | null {
    if (focused && !focused.isClosed() && pages.includes(focused)) return focused;
    focused = null;
    const realPages = pages.filter((page) => !page.isClosed() && isRealPageUrl(page.url()));
    realPages.sort((a, b) => (seenAt.get(b) ?? 0) - (seenAt.get(a) ?? 0));
    return realPages[0] ?? null;
  }

  return {
    remember,
    focus(page: T): void {
      focused = page;
      remember(page);
    },
    active,
    clear(): void {
      focused = null;
    },
  };
}

const pageFocus = createPageFocusState<Page>();
const browserControl = createBrowserControlState();
const browserActions = createSerialActions();
const pageNavigationEpoch = new WeakMap<Page, number>();
const trackedPages = new WeakSet<Page>();
const capturedDownloads = new WeakMap<object, Promise<CapturedDownloadReceipt>>();
const continuedDownloads = new WeakSet<object>();
let handoffPage: Page | null = null;

// ── Her window, and only ever hers ────────────────────────────────────────
// Ownership is decided by the EXACT --user-data-dir, so nothing below can
// see, reuse, or kill the operator's own Chrome (D-052).

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function psList(): { pid: number; command: string }[] {
  try {
    return execFileSync("/bin/ps", ["ax", "-o", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const at = line.indexOf(" ");
        const pid = Number(line.slice(0, at));
        return Number.isFinite(pid) ? [{ pid, command: line.slice(at + 1).trim() }] : [];
      });
  } catch {
    return [];
  }
}

/** True only for a command whose --user-data-dir IS her profile (not a prefix of it). */
function ownsProfile(command: string, workspace: DiveWorkspace): boolean {
  const arg = `--user-data-dir=${workspace.profileDir}`;
  const at = command.indexOf(arg);
  if (at < 0) return false;
  const next = command[at + arg.length];
  return next === undefined || /\s/.test(next);
}

function profilePids(workspace: DiveWorkspace): number[] {
  return psList()
    .filter((p) => ownsProfile(p.command, workspace))
    .map((p) => p.pid);
}

/** Exact-process postcondition for a caller-owned browser workspace. */
export function diveWorkspaceProfilePids(workspace: DiveWorkspace): number[] {
  return profilePids({ ...workspace, profileDir: resolve(workspace.profileDir) });
}

/** Exact-process postcondition for callers that will move the persistent profile. */
export function persistentDiveProfilePids(): number[] {
  return diveWorkspaceProfilePids(DEFAULT_WORKSPACE);
}

function debugPortOf(command: string): number | null {
  for (const part of command.split(/\s+/)) {
    if (part.startsWith("--remote-debugging-port=")) {
      const port = Number(part.slice("--remote-debugging-port=".length));
      if (Number.isFinite(port)) return port;
    }
  }
  return null;
}

/** A live DevTools endpoint that provably belongs to HER profile. */
function portBelongsToProfile(port: number, workspace: DiveWorkspace): boolean {
  return psList().some((p) => ownsProfile(p.command, workspace) && debugPortOf(p.command) === port);
}

async function endpointAnswers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function savedPort(workspace: DiveWorkspace): number | null {
  try {
    const port = Number(readFileSync(workspace.portFile, "utf8").trim());
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** A leftover window of hers that is still healthy: attach to it rather than fight it. */
async function reusableDebugPort(workspace: DiveWorkspace): Promise<number | null> {
  const live = psList()
    .filter((p) => ownsProfile(p.command, workspace))
    .flatMap((p) => {
      const port = debugPortOf(p.command);
      return port === null ? [] : [port];
    });
  const candidates = [savedPort(workspace), DEFAULT_CDP_PORT, ...live].filter(
    (port): port is number => typeof port === "number",
  );
  for (const port of new Set(candidates)) {
    if (portBelongsToProfile(port, workspace) && (await endpointAnswers(port))) return port;
  }
  return null;
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? done(port) : fail(new Error("no free port"))));
    });
  });
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.on("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });
}

async function allocateDebugPort(): Promise<number> {
  return (await portIsFree(DEFAULT_CDP_PORT)) ? DEFAULT_CDP_PORT : await freePort();
}

/**
 * A stale Chrome on her profile holds the SingletonLock, so a fresh spawn would
 * just hand off to it and exit. Clear it — SIGTERM (Chrome flushes the session),
 * then SIGKILL whatever refuses.
 */
async function clearStaleProfileChrome(workspace: DiveWorkspace): Promise<number> {
  const pids = profilePids(workspace);
  if (pids.length === 0) return 0;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  for (let i = 0; i < 24 && profilePids(workspace).length > 0; i++) await sleep(250);
  for (const pid of profilePids(workspace)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await sleep(300);
  return pids.length;
}

function resetState(): void {
  launcher = null;
  browser = null;
  context = null;
  screencast = null;
  cdpPort = null;
  activeWorkspace = null;
  pageFocus.clear();
  browserControl.close();
  handoffPage = null;
  openedAt = null;
  latestFrame = null;
  closingBrowser = false;
}

function forgetAttachedBrowser(): void {
  browser = null;
  context = null;
  screencast = null;
  cdpPort = null;
  handoffPage = null;
  latestFrame = null;
}

function shouldResumeAfterHumanClose(control: { mode: BrowserMode; inputOwner: BrowserInputOwner | null }): boolean {
  return !closingBrowser && control.mode === "foreground_hands" && control.inputOwner === "hands";
}

// The live viewport (the embed, D-115/D-122): latest screencast frame + url,
// pushed to whoever subscribes (the sidecar streams them to the face, which
// paints them inside the System 7 macwin — beat 4's theater become real).
export interface BrowserFrame {
  /** base64 JPEG of the page as Chrome painted it. */
  data: string;
  url: string;
  at: number;
}
let latestFrame: BrowserFrame | null = null;
const frameSubs = new Set<(f: BrowserFrame) => void>();

export function onBrowserFrame(sub: (f: BrowserFrame) => void): () => void {
  frameSubs.add(sub);
  if (latestFrame) sub(latestFrame);
  return () => frameSubs.delete(sub);
}

function rememberPage(page: Page, workspace: DiveWorkspace): void {
  pageFocus.remember(page);
  if (trackedPages.has(page)) return;
  trackedPages.add(page);
  pageNavigationEpoch.set(page, pageNavigationEpoch.get(page) ?? 0);
  page.on("download", (download) => {
    void captureOwnedDownloadForWorkspace(download, workspace, page.url()).catch(() => undefined);
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      pageNavigationEpoch.set(page, (pageNavigationEpoch.get(page) ?? 0) + 1);
      pageFocus.remember(page);
    }
  });
}

function installPageTracking(nextContext: BrowserContext, workspace: DiveWorkspace): void {
  for (const page of nextContext.pages()) rememberPage(page, workspace);
  nextContext.on("page", (page) => rememberPage(page, workspace));
}

function activePage(): Page | null {
  if (!context) return null;
  return pageFocus.active(context.pages());
}

function bootstrapPage(): Page | null {
  if (!context) return null;
  return activePage() ?? context.pages().at(-1) ?? null;
}

function downloadTargetPath(directory: string, suggestedFilename: string, now = Date.now()): string {
  const fromServer = basename(suggestedFilename.trim()).replace(/[\u0000-\u001f\u007f]/g, "_");
  const filename = fromServer && fromServer !== "." && fromServer !== ".." ? fromServer : "download";
  const first = resolve(directory, filename);
  if (!existsSync(first)) return first;
  const extension = extname(filename);
  const stem = filename.slice(0, filename.length - extension.length) || "download";
  let attempt = 1;
  while (true) {
    const suffix = attempt === 1 ? `${now}` : `${now}-${attempt}`;
    const candidate = resolve(directory, `${stem}-${suffix}${extension}`);
    if (!existsSync(candidate)) return candidate;
    attempt += 1;
  }
}

const LATEST_DOWNLOAD_RECEIPT = "latest.json";
const CURRENT_DOWNLOAD_ATTEMPT = "attempt.json";
const CURRENT_DOWNLOAD_OWNER = "owner.json";
const DOWNLOAD_ARTIFACT_INDEX = "index.jsonl";
const MAX_ARTIFACT_TEXT_BYTES = 1_000_000;

type BrowserDownload = Pick<Download, "failure" | "saveAs" | "suggestedFilename">;
type OwnedArtifactReadRequest = Partial<OwnedArtifactReadInput> & { artifactId?: string };
type OwnedArtifactListInput = { cursor?: string | null; limit?: number };
type OwnedArtifactListResult = {
  artifacts: Omit<DownloadArtifactRecord, "path">[];
  nextCursor: string | null;
  total: number;
};
export interface OwnedArtifactTextInput {
  artifactId: string;
}
type OwnedArtifactMetadata =
  | (Omit<DownloadArtifactRecord, "path"> & { sha256: string })
  | Omit<SemanticObservationArtifactRecord, "path">;
export type OwnedArtifactTextResult =
  | { ok: true; text: string; artifact: OwnedArtifactMetadata }
  | { ok: false; note: string };
type CapturedDownloadReceipt =
  | {
      ok: true;
      filename: string;
      path: string;
      bytes: number;
      capturedAt: number;
    }
  | { ok: false; reason: "failed" };

type DownloadAttempt = {
  id: string;
  startedAt: number;
  sourceUrl: string;
};

type DownloadOwner = {
  jobId: string | null;
  setAt: number;
};

type StoredDownloadReceipt = {
  jobId?: string | null;
  filename: string;
  bytes: number;
  capturedAt: number;
  attemptId: string | null;
  sourceUrl: string;
  artifactId?: string;
};

type DownloadArtifactRecord = {
  schemaVersion: 1;
  jobId: string | null;
  attemptId: string | null;
  artifactId: string;
  kind: "download";
  sourceUrl: string;
  filename: string;
  path: string;
  bytes: number;
  capturedAt: number;
  readOffset: number;
  readMaxChars: number;
  freshness: {
    attemptId: string | null;
    attemptStartedAt: number | null;
    currentAtCapture: boolean;
  };
  summary: string;
};

type SemanticObservationArtifactRecord = {
  schemaVersion: 1;
  jobId: string;
  artifactId: string;
  kind: "semantic_observation";
  observationId: string;
  sourceUrl: string;
  filename: string;
  path: string;
  bytes: number;
  capturedAt: number;
  sha256: string;
};

type OwnedArtifactRecord = DownloadArtifactRecord | SemanticObservationArtifactRecord;

function downloadStateDir(destinationDir: string): string {
  return resolve(destinationDir, ".download-state");
}

function legacyDownloadStateDir(destinationDir: string): string {
  return resolve(destinationDir, "..", ".download-state");
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function currentDownloadAttempt(destinationDir: string): DownloadAttempt | null {
  return (
    readJson<DownloadAttempt>(resolve(downloadStateDir(destinationDir), CURRENT_DOWNLOAD_ATTEMPT)) ??
    readJson<DownloadAttempt>(resolve(legacyDownloadStateDir(destinationDir), CURRENT_DOWNLOAD_ATTEMPT))
  );
}

function currentDownloadOwner(destinationDir: string): DownloadOwner | null {
  return readJson<DownloadOwner>(resolve(downloadStateDir(destinationDir), CURRENT_DOWNLOAD_OWNER));
}

function bindOwnedDownloadJob(
  destinationDir: string,
  jobId: string | null,
  setAt = Date.now(),
): DownloadOwner {
  const current = currentDownloadOwner(destinationDir);
  if (current && current.jobId === jobId) return current;
  const owner: DownloadOwner = { jobId, setAt };
  const stateDir = downloadStateDir(destinationDir);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(resolve(stateDir, CURRENT_DOWNLOAD_OWNER), `${JSON.stringify(owner)}\n`, "utf8");
  return owner;
}

function beginOwnedDownloadAttempt(
  destinationDir: string,
  sourceUrl: string,
  startedAt = Date.now(),
): DownloadAttempt {
  const stateDir = downloadStateDir(destinationDir);
  mkdirSync(stateDir, { recursive: true });
  const attempt = {
    id: `${startedAt}-${Math.random().toString(36).slice(2)}`,
    startedAt,
    sourceUrl,
  };
  writeFileSync(resolve(stateDir, CURRENT_DOWNLOAD_ATTEMPT), `${JSON.stringify(attempt)}\n`, "utf8");
  return attempt;
}

function artifactIndexPath(destinationDir: string): string {
  return resolve(downloadStateDir(destinationDir), DOWNLOAD_ARTIFACT_INDEX);
}

function semanticObservationDir(destinationDir: string): string {
  return resolve(downloadStateDir(destinationDir), "observations");
}

function artifactIdFor(record: Omit<DownloadArtifactRecord, "artifactId">): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        jobId: record.jobId,
        attemptId: record.attemptId,
        sourceUrl: record.sourceUrl,
        filename: record.filename,
        path: record.path,
        bytes: record.bytes,
        capturedAt: record.capturedAt,
      }),
    )
    .digest("hex")
    .slice(0, 20);
  return `artifact_${hash}`;
}

function isDownloadArtifactRecord(value: unknown): value is DownloadArtifactRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<DownloadArtifactRecord>;
  return (
    record.schemaVersion === 1 &&
    (record.jobId === null || typeof record.jobId === "string") &&
    (record.attemptId === null || typeof record.attemptId === "string") &&
    typeof record.artifactId === "string" &&
    record.kind === "download" &&
    typeof record.sourceUrl === "string" &&
    typeof record.filename === "string" &&
    typeof record.path === "string" &&
    typeof record.bytes === "number" &&
    typeof record.capturedAt === "number" &&
    typeof record.readOffset === "number" &&
    typeof record.readMaxChars === "number" &&
    typeof record.summary === "string" &&
    !!record.freshness &&
    typeof record.freshness === "object"
  );
}

function isSemanticObservationArtifactRecord(value: unknown): value is SemanticObservationArtifactRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SemanticObservationArtifactRecord>;
  return (
    record.schemaVersion === 1 &&
    typeof record.jobId === "string" &&
    typeof record.artifactId === "string" &&
    record.kind === "semantic_observation" &&
    typeof record.observationId === "string" &&
    typeof record.sourceUrl === "string" &&
    typeof record.filename === "string" &&
    typeof record.path === "string" &&
    typeof record.bytes === "number" &&
    typeof record.capturedAt === "number" &&
    typeof record.sha256 === "string"
  );
}

function readDownloadArtifactIndex(destinationDir: string): OwnedArtifactRecord[] {
  try {
    return readFileSync(artifactIndexPath(destinationDir), "utf8")
      .split("\n")
      .flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const parsed: unknown = JSON.parse(line);
          return isDownloadArtifactRecord(parsed) || isSemanticObservationArtifactRecord(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function appendDownloadArtifactRecord(
  destinationDir: string,
  receipt: Extract<CapturedDownloadReceipt, { ok: true }>,
  sourceUrl: string,
  attempt: DownloadAttempt | null,
): DownloadArtifactRecord {
  const owner = currentDownloadOwner(destinationDir);
  const currentAtCapture = Boolean(attempt && receipt.capturedAt >= attempt.startedAt);
  const withoutId: Omit<DownloadArtifactRecord, "artifactId"> = {
    schemaVersion: 1,
    jobId: owner?.jobId ?? null,
    attemptId: currentAtCapture ? attempt?.id ?? null : null,
    kind: "download",
    sourceUrl,
    filename: receipt.filename,
    path: receipt.path,
    bytes: receipt.bytes,
    capturedAt: receipt.capturedAt,
    readOffset: 0,
    readMaxChars: 20_000,
    freshness: {
      attemptId: attempt?.id ?? null,
      attemptStartedAt: attempt?.startedAt ?? null,
      currentAtCapture,
    },
    summary: `Captured download ${receipt.filename} (${receipt.bytes} bytes).`,
  };
  const record = { ...withoutId, artifactId: artifactIdFor(withoutId) };
  const stateDir = downloadStateDir(destinationDir);
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(artifactIndexPath(destinationDir), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  return record;
}

function semanticArtifactIdFor(
  jobId: string,
  snapshot: SemanticObservationSnapshot,
  capturedAt: number,
  sha256: string,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ jobId, observationId: snapshot.observationId, sourceUrl: snapshot.sourceUrl, capturedAt, sha256 }))
    .digest("hex")
    .slice(0, 20);
  return `artifact_${hash}`;
}

function captureOwnedSemanticObservation(
  destinationDir: string,
  snapshot: SemanticObservationSnapshot,
  capturedAt = Date.now(),
): SemanticObservationArtifactRecord {
  const owner = currentDownloadOwner(destinationDir);
  if (!owner?.jobId) throw new Error("No research job is bound to this browser observation");
  if (readDownloadArtifactIndex(destinationDir).some(record =>
    record.kind === "semantic_observation" &&
    record.jobId === owner.jobId &&
    record.observationId === snapshot.observationId
  )) throw new Error("That observation id is already retained for this research job");

  const text = Buffer.from(snapshot.text, "utf8");
  if (text.byteLength > MAX_ARTIFACT_TEXT_BYTES) throw new Error("Semantic observation exceeds the bounded artifact limit");
  const sha256 = createHash("sha256").update(text).digest("hex");
  const artifactId = semanticArtifactIdFor(owner.jobId, snapshot, capturedAt, sha256);
  const filename = `${artifactId}.txt`;
  const directory = semanticObservationDir(destinationDir);
  const path = resolve(directory, filename);
  const record: SemanticObservationArtifactRecord = {
    schemaVersion: 1,
    jobId: owner.jobId,
    artifactId,
    kind: "semantic_observation",
    observationId: snapshot.observationId,
    sourceUrl: publicArtifactSource(snapshot.sourceUrl),
    filename,
    path,
    bytes: text.byteLength,
    capturedAt,
    sha256,
  };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { flag: "wx", mode: 0o600 });
  try {
    appendFileSync(artifactIndexPath(destinationDir), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
  return record;
}

function encodeArtifactCursor(start: number): string {
  return Buffer.from(JSON.stringify({ start }), "utf8").toString("base64url");
}

function decodeArtifactCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { start?: unknown };
    return typeof parsed.start === "number" && Number.isInteger(parsed.start) && parsed.start >= 0
      ? parsed.start
      : 0;
  } catch {
    return 0;
  }
}

function publicArtifactSource(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return sourceUrl;
  }
}

function listOwnedDownloadArtifacts(
  destinationDir: string,
  input: OwnedArtifactListInput = {},
  jobId?: string,
): OwnedArtifactListResult {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 20), 1), 50);
  const start = decodeArtifactCursor(input.cursor);
  const scopedJobId = jobId ?? currentDownloadOwner(destinationDir)?.jobId ?? null;
  const artifacts = readDownloadArtifactIndex(destinationDir)
    .filter((artifact): artifact is DownloadArtifactRecord => artifact.kind === "download")
    .filter((artifact) => scopedJobId === null || artifact.jobId === scopedJobId)
    .slice()
    .sort((left, right) => right.capturedAt - left.capturedAt || right.artifactId.localeCompare(left.artifactId));
  const page = artifacts.slice(start, start + limit);
  const nextStart = start + page.length;
  return {
    artifacts: page.map(({ path: _path, ...artifact }) => ({
      ...artifact,
      sourceUrl: publicArtifactSource(artifact.sourceUrl),
    })),
    nextCursor: nextStart < artifacts.length ? encodeArtifactCursor(nextStart) : null,
    total: artifacts.length,
  };
}

async function captureOwnedDownload(
  download: BrowserDownload,
  destinationDir: string,
  sourceUrl: string,
  now = Date.now(),
): Promise<CapturedDownloadReceipt> {
  const existing = capturedDownloads.get(download);
  if (existing) return existing;

  const capture = (async (): Promise<CapturedDownloadReceipt> => {
    mkdirSync(destinationDir, { recursive: true });
    if (await download.failure()) return { ok: false, reason: "failed" };
    const path = downloadTargetPath(destinationDir, download.suggestedFilename(), now);
    try {
      await download.saveAs(path);
      const receipt = {
        ok: true as const,
        filename: basename(path),
        path,
        bytes: statSync(path).size,
        capturedAt: now,
      };
      const attempt = currentDownloadAttempt(destinationDir);
      const attemptId = attempt && receipt.capturedAt >= attempt.startedAt ? attempt.id : null;
      const artifact = appendDownloadArtifactRecord(destinationDir, receipt, sourceUrl, attempt);
      const stored: StoredDownloadReceipt = {
        jobId: artifact.jobId,
        filename: receipt.filename,
        bytes: receipt.bytes,
        capturedAt: receipt.capturedAt,
        // A confirmation or auth hop may legitimately change the URL before
        // the browser emits the file. Time + the owned workspace bind this to
        // the active attempt without treating URL spelling as semantic truth.
        attemptId,
        sourceUrl,
        artifactId: artifact.artifactId,
      };
      const stateDir = downloadStateDir(destinationDir);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        resolve(stateDir, LATEST_DOWNLOAD_RECEIPT),
        `${JSON.stringify(stored)}\n`,
        "utf8",
      );
      return receipt;
    } catch {
      return { ok: false, reason: "failed" };
    }
  })();
  capturedDownloads.set(download, capture);
  return capture;
}

async function captureOwnedDownloadForWorkspace(
  download: BrowserDownload,
  workspace: DiveWorkspace,
  sourceUrl: string,
  now = Date.now(),
): Promise<CapturedDownloadReceipt> {
  const destinationDir = resolve(workspace.captureDir, "downloads");
  const receipt = await captureOwnedDownload(download, destinationDir, sourceUrl, now);
  if (receipt.ok && !continuedDownloads.has(download)) {
    continuedDownloads.add(download);
    const attempt = currentDownloadAttempt(destinationDir);
    const attemptId = attempt && receipt.capturedAt >= attempt.startedAt ? attempt.id : null;
    emitOwnedDownloadContinuation(workspace, receipt, sourceUrl, attemptId);
  }
  return receipt;
}

function emitOwnedDownloadContinuation(
  workspace: DiveWorkspace,
  receipt: Extract<CapturedDownloadReceipt, { ok: true }>,
  sourceUrl: string,
  attemptId: string | null,
): void {
  const page = activePage();
  const artifactEpoch = nextArtifactEpoch(workspace);
  emitDiveContinuation(workspace, {
    type: "diver.continue",
    reason: "owned_download_captured",
    key: [
      "owned_download_captured",
      browserControl.epoch(),
      page ? pageNavigationEpoch.get(page) ?? 0 : 0,
      attemptId ?? "no-attempt",
      artifactEpoch,
    ].join(":"),
    at: receipt.capturedAt,
    controlEpoch: browserControl.epoch(),
    navigationEpoch: page ? pageNavigationEpoch.get(page) ?? 0 : 0,
    attemptId,
    artifactEpoch,
    url: sourceUrl,
    filename: receipt.filename,
    bytes: receipt.bytes,
  });
}

function emitBrowserControlReturnedContinuation(
  workspace: DiveWorkspace,
  facts: { controlEpoch: number; navigationEpoch: number; url: string | null },
): void {
  const attemptId = currentDownloadAttempt(resolve(workspace.captureDir, "downloads"))?.id ?? null;
  const artifactEpoch = latestArtifactEpoch(workspace);
  const at = Date.now();
  emitDiveContinuation(workspace, {
    type: "diver.continue",
    reason: "browser_control_returned",
    key: [
      "browser_control_returned",
      facts.controlEpoch,
      facts.navigationEpoch,
      attemptId ?? "no-attempt",
      artifactEpoch,
      at,
    ].join(":"),
    at,
    controlEpoch: facts.controlEpoch,
    navigationEpoch: facts.navigationEpoch,
    attemptId,
    artifactEpoch,
    ...(facts.url ? { url: facts.url } : {}),
  });
}

function readLatestOwnedDownload(
  destinationDir: string,
  input: OwnedArtifactReadRequest = { offset: 0, maxChars: 20_000 },
  jobId?: string,
): string {
  const offset = input.offset ?? 0;
  const maxChars = input.maxChars ?? 20_000;
  const attempt = currentDownloadAttempt(destinationDir);
  const scopedJobId = jobId ?? currentDownloadOwner(destinationDir)?.jobId ?? null;
  const indexed = readDownloadArtifactIndex(destinationDir).filter(
    (artifact): artifact is DownloadArtifactRecord =>
      artifact.kind === "download" && (scopedJobId === null || artifact.jobId === scopedJobId),
  );
  const receipt =
    input.artifactId
      ? indexed.find((artifact) => artifact.artifactId === input.artifactId) ?? null
      : currentReadableArtifact(destinationDir, attempt, indexed, scopedJobId);
  if (!receipt) {
    return "No captured download yet. If the page is waiting for human confirmation, finish it and ask me to read the download again.";
  }
  const result = readOwnedDownloadText(destinationDir, receipt);
  if (!result.ok) return result.note;
  const { text: contents, bytes: size } = result;
  const start = Math.min(offset, contents.length);
  const end = Math.min(start + maxChars, contents.length);
  const page = contents.slice(start, end);
  const continuation = end < contents.length
    ? `More remains; read again from offset ${end}.`
    : "End of artifact.";
  return (
    `Captured artifact ${receipt.filename} (${size} bytes, artifact ${receipt.artifactId ?? "latest"}, characters ${start}-${end} of ${contents.length}).\n` +
    `Contents:\n${page}\n${continuation}`
  );
}

/** Shared transport read. Keep format/prose out so host imports never parse a tool response. */
function readOwnedTextFile(
  path: string,
  filename: string,
  expected?: { bytes: number; sha256: string },
): { ok: true; text: string; bytes: number; sha256: string } | { ok: false; note: string } {
  let descriptor: number | undefined;
  try {
    if (!existsSync(path)) return { ok: false, note: "The captured artifact is missing. Capture it again." };
    // Open exactly the captured file, not a symlink substituted for it. A bounded
    // descriptor read also prevents a file growing between stat and read from
    // turning this host-only bridge into an unbounded read.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return { ok: false, note: "The captured download is not a regular file." };
    const size = stat.size;
    if (size > MAX_ARTIFACT_TEXT_BYTES) {
      return { ok: false, note: `Captured artifact ${filename} (${size} bytes), but it is too large for the bounded text reader.` };
    }
    const buffer = Buffer.alloc(MAX_ARTIFACT_TEXT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_ARTIFACT_TEXT_BYTES) {
      return { ok: false, note: `Captured artifact ${filename} is too large for the bounded text reader.` };
    }
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0)) {
      return { ok: false, note: `Captured artifact ${filename} (${length} bytes), but it is binary rather than readable text.` };
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (expected && (length !== expected.bytes || sha256 !== expected.sha256)) {
      return { ok: false, note: `Captured artifact ${filename} changed after it was retained.` };
    }
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), bytes: length, sha256 };
  } catch {
    return { ok: false, note: "The latest captured artifact is not readable text. Download it again or use a text export." };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readOwnedDownloadText(
  destinationDir: string,
  receipt: DownloadArtifactRecord | StoredDownloadReceipt,
): { ok: true; text: string; bytes: number; sha256: string } | { ok: false; note: string } {
  if (typeof receipt.filename !== "string" || basename(receipt.filename) !== receipt.filename) {
    return { ok: false, note: "The latest download receipt is invalid. Download the file again." };
  }
  return readOwnedTextFile(resolve(destinationDir, receipt.filename), receipt.filename);
}

function readOwnedArtifactText(destinationDir: string, input: OwnedArtifactTextInput): OwnedArtifactTextResult {
  const scopedJobId = currentDownloadOwner(destinationDir)?.jobId ?? null;
  if (!scopedJobId) return { ok: false, note: "No research job is bound to these captured artifacts." };
  const receipt = readDownloadArtifactIndex(destinationDir).find((artifact): artifact is DownloadArtifactRecord =>
    artifact.kind === "download" && artifact.artifactId === input.artifactId && artifact.jobId === scopedJobId,
  );
  if (!receipt) return { ok: false, note: "No captured artifact with that id belongs to this research job." };
  const result = readOwnedDownloadText(destinationDir, receipt);
  if (!result.ok) return result;
  const { path: _path, ...artifact } = receipt;
  return { ok: true, text: result.text, artifact: {
    ...artifact, sourceUrl: publicArtifactSource(artifact.sourceUrl), bytes: result.bytes, sha256: result.sha256,
  } };
}

function readOwnedObservationText(destinationDir: string, observationId: string): OwnedArtifactTextResult {
  const scopedJobId = currentDownloadOwner(destinationDir)?.jobId ?? null;
  if (!scopedJobId) return { ok: false, note: "No research job is bound to these captured artifacts." };
  const receipt = readDownloadArtifactIndex(destinationDir).find((artifact): artifact is SemanticObservationArtifactRecord =>
    artifact.kind === "semantic_observation" &&
    artifact.observationId === observationId &&
    artifact.jobId === scopedJobId,
  );
  if (!receipt) return { ok: false, note: "No retained observation with that id belongs to this research job." };
  if (basename(receipt.filename) !== receipt.filename) {
    return { ok: false, note: "The retained observation receipt is invalid." };
  }
  const expectedPath = resolve(semanticObservationDir(destinationDir), receipt.filename);
  if (receipt.path !== expectedPath) return { ok: false, note: "The retained observation receipt is invalid." };
  const result = readOwnedTextFile(expectedPath, receipt.filename, receipt);
  if (!result.ok) return result;
  const { path: _path, ...artifact } = receipt;
  return { ok: true, text: result.text, artifact: {
    ...artifact,
    sourceUrl: publicArtifactSource(artifact.sourceUrl),
    bytes: result.bytes,
    sha256: result.sha256,
  } };
}

function currentReadableArtifact(
  destinationDir: string,
  attempt: DownloadAttempt | null,
  indexed: DownloadArtifactRecord[],
  scopedJobId: string | null,
): (DownloadArtifactRecord | StoredDownloadReceipt) | null {
  const current = attempt
    ? indexed
        .filter(
          (artifact) =>
            artifact.attemptId === attempt.id &&
            artifact.capturedAt >= attempt.startedAt &&
            artifact.freshness.currentAtCapture,
        )
        .sort((left, right) => right.capturedAt - left.capturedAt)[0] ?? null
    : null;
  if (current) return current;
  const receipt =
    readJson<StoredDownloadReceipt>(resolve(downloadStateDir(destinationDir), LATEST_DOWNLOAD_RECEIPT)) ??
    readJson<StoredDownloadReceipt>(resolve(legacyDownloadStateDir(destinationDir), LATEST_DOWNLOAD_RECEIPT));
  if (
    !attempt ||
    !receipt ||
    receipt.attemptId !== attempt.id ||
    receipt.capturedAt < attempt.startedAt ||
    (scopedJobId !== null && receipt.jobId !== scopedJobId)
  ) {
    return null;
  }
  return receipt;
}

export const __loisDiveTest = {
  createPageFocusState,
  createBrowserControlState,
  createSerialActions,
  createSmokeWorkspace,
  resolveStartUrl,
  chromeArgs,
  ownsProfile,
  workspaceLeaseRefusal,
  inputRefusal,
  liveInputRefusal,
  downloadTargetPath,
  bindOwnedDownloadJob,
  beginOwnedDownloadAttempt,
  captureOwnedDownload,
  captureOwnedDownloadForWorkspace,
  captureOwnedSemanticObservation,
  createOwnedSemanticSession,
  listOwnedDownloadArtifacts,
  readLatestOwnedDownload,
  onDiveContinuation,
  latestDiveContinuation,
  emitBrowserControlReturnedContinuation,
  semanticOriginAllowed: (workspace: DiveWorkspace, rawUrl: string) => semanticOriginAllowed(workspace, rawUrl),
  shouldResumeAfterHumanClose,
  screencastOptions: () => ({ ...SCREENCAST_OPTIONS }),
  pageRef(url: string, options: { closed?: boolean } = {}): PageRef {
    return {
      url: () => url,
      isClosed: () => options.closed ?? false,
    };
  },
};

/** Start (or restart) the CDP screencast on the active page. */
async function startScreencast(page: Page): Promise<void> {
  try {
    screencast = await page.context().newCDPSession(page);
    screencast.on("Page.screencastFrame", (ev: { data: string; sessionId: number }) => {
      latestFrame = { data: ev.data, url: page.url(), at: Date.now() };
      for (const sub of frameSubs) sub(latestFrame);
      void screencast?.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => undefined);
    });
    await screencast.send("Page.startScreencast", SCREENCAST_OPTIONS);
  } catch {
    screencast = null; // the live embed is a flourish; the dive works without it
  }
}

// ── Where the window sits (D-124) ─────────────────────────────────────────
// Browser.* is browser-scoped, so moving the window needs the BROWSER-level
// CDP session plus the windowId that owns the page's target.

async function windowHandle(): Promise<{ session: CDPSession; windowId: number } | null> {
  const page = activePage();
  if (!browser || !context || !page) return null;
  try {
    const pageSession = await context.newCDPSession(page);
    const { targetInfo } = await pageSession.send("Target.getTargetInfo");
    const session = await browser.newBrowserCDPSession();
    const { windowId } = await session.send("Browser.getWindowForTarget", {
      targetId: targetInfo.targetId,
    });
    await pageSession.detach().catch(() => undefined);
    return { session, windowId };
  } catch {
    return null;
  }
}

async function moveWindow(to: typeof ONSCREEN): Promise<boolean> {
  const handle = await windowHandle();
  if (!handle) return false;
  try {
    await handle.session.send("Browser.setWindowBounds", {
      windowId: handle.windowId,
      bounds: { ...to, windowState: "normal" },
    });
    return true;
  } catch {
    return false;
  }
}

/** The one Chrome process that IS her window (the one holding the debug port). */
function mainProfilePid(workspace: DiveWorkspace): number | null {
  const proc = psList().find(
    (p) => ownsProfile(p.command, workspace) && debugPortOf(p.command) !== null,
  );
  return proc?.pid ?? null;
}

/**
 * Raise her window to the front of the desktop. Targeted by unix id, so it can
 * only ever raise HER Chrome — never the operator's (`open -a "Google Chrome"`
 * would be ambiguous between instances, which is why it is not used here).
 * Needs Accessibility permission; if that is denied, Page.bringToFront alone
 * has to carry it, so this is best-effort and reports whether it landed.
 */
function raiseProfileChrome(workspace: DiveWorkspace): boolean {
  const pid = mainProfilePid(workspace);
  if (pid === null) return false;
  try {
    execFileSync(
      "/usr/bin/osascript",
      ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`],
      { stdio: "ignore", timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

export interface DiveHands {
  /**
   * Open her window. `park` decides who the window is FOR: false (default)
   * means the organizer is about to use their own hands — sign in, a consent
   * screen — so it comes up on-screen and in front. true means Lois is the
   * one working, so it parks off the desktop and the pane is the only view.
   */
  dive_start(url?: string, park?: boolean): Promise<string>;
  dive_capture(): Promise<string>;
  dive_status(): Promise<string>;
  dive_close(): Promise<string>;
  /** Bring the real window on-screen and to the front (OAuth popups, file pickers, a Turnstile that wants a genuine trusted click). */
  dive_summon(): Promise<string>;
  /** Send it back off-screen; callers may choose whether the pane or automation resumes control. */
  dive_dismiss(owner?: EmbeddedInputOwner): Promise<string>;
  /** Read a bounded, scrubbed AI-ARIA snapshot from the isolated local rehearsal page. */
  dive_observe(): Promise<string>;
  /** Bind a vault fact to the exact current observation without exposing private URL data. */
  dive_evidence(observationId: string): Promise<SemanticEvidenceResult>;
  /** Follow one same-origin anchor or activate one native view button behind a read-only network fence. */
  dive_follow(input: SemanticFollowInput): Promise<string>;
  /** Save the file emitted by one exact observed control into this workspace's owned download directory. */
  dive_download(input: SemanticDownloadInput): Promise<string>;
  /** Page through the latest text artifact captured by this owned browser; accepts no path. */
  dive_read_download(input?: OwnedArtifactReadRequest): Promise<string>;
  /** Host-only exact-artifact text for parsers/importers; never exposed as a raw model capability. */
  dive_read_artifact_text(input: OwnedArtifactTextInput): Promise<OwnedArtifactTextResult>;
  /** Host-only historical semantic proof for the exact bound research job; never authorizes a live action. */
  dive_read_observation(observationId: string): Promise<OwnedArtifactTextResult>;
  /** List owned browser artifacts without exposing arbitrary filesystem reads. */
  dive_list_artifacts(input?: OwnedArtifactListInput, jobId?: string): Promise<OwnedArtifactListResult>;
  /** Bind later browser artifacts to the persisted diver job that owns the current research. */
  dive_bind_job(jobId: string | null): void;
  /** Fill/check/select refs from the latest observation. This API cannot click or submit. */
  dive_prepare(input: SemanticPrepareInput): Promise<string>;
  /** Coordinate/key input bound to this handle's exact workspace lease. */
  dive_input(
    input: BrowserInput,
    owner?: Exclude<BrowserInputOwner, "hands">,
  ): Promise<BrowserInputResult>;
  /** Subscribe to typed browser facts that can wake an awaiting diver job. */
  dive_on_continue(subscriber: DiveContinuationSubscriber): () => void;
  /** Latest typed browser fact, used to recover an unhandled durable wait after restart. */
  dive_latest_continue(): DiveContinuationFact | null;
  /** Test-only/event-injection hook; production browser code emits through the same subscription rail. */
  dive_emit_continue(event: DiveContinuationFact): void;
}

function semanticLocator(page: Page, locator: Locator): ReturnType<SemanticPage["locator"]> {
  return {
    count: () => locator.count(),
    isVisible: () => locator.isVisible(),
    isEnabled: () => locator.isEnabled(),
    inspect: () =>
      locator.evaluate((node): SemanticControlMetadata => {
        const element = node as HTMLElement;
        const input = element instanceof HTMLInputElement ? element : null;
        const button = element instanceof HTMLButtonElement ? element : null;
        const select = element instanceof HTMLSelectElement ? element : null;
        const descriptors = [
          element.getAttribute("name"),
          element.getAttribute("id"),
          element.getAttribute("placeholder"),
          element.getAttribute("aria-label"),
          element.getAttribute("autocomplete"),
          element.getAttribute("role"),
        ].filter((value): value is string => Boolean(value));
        return {
          tag: element.tagName.toLowerCase(),
          type: input?.type ?? button?.type ?? "",
          role: element.getAttribute("role") ?? "",
          readOnly:
            (input?.readOnly ?? false) ||
            (element instanceof HTMLTextAreaElement ? element.readOnly : false),
          multiple: select?.multiple ?? false,
          hidden: input?.type === "hidden" || element.hidden,
          href: element instanceof HTMLAnchorElement ? element.href : null,
          formAssociated: Boolean(button?.form),
          descriptor: descriptors.join(" "),
          options: select
            ? Array.from(select.options, (option) => ({
                label: option.label,
                disabled: option.disabled,
              }))
            : [],
        };
      }),
    fill: (text) => locator.fill(text),
    check: (checked) => (checked ? locator.check() : locator.uncheck()),
    select: async (labels) => {
      await locator.selectOption(labels.map((label) => ({ label })));
    },
    activate: async () => {
      let blockedWrite = false;
      let blockedCrossSiteNavigation = false;
      const sourceOrigin = new URL(page.url()).origin;
      const guard = async (route: Route): Promise<void> => {
        const request = route.request();
        const method = request.method().toUpperCase();
        if (!new Set(["GET", "HEAD", "OPTIONS"]).has(method)) {
          blockedWrite = true;
          await route.abort("blockedbyclient");
          return;
        }
        if (request.isNavigationRequest() && new URL(request.url()).origin !== sourceOrigin) {
          blockedCrossSiteNavigation = true;
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      };

      await page.route("**/*", guard);
      try {
        await locator.click();
        await page.waitForTimeout(750);
      } catch (error) {
        if (!blockedWrite && !blockedCrossSiteNavigation) throw error;
      } finally {
        await page.unroute("**/*", guard);
      }
      return { blockedWrite, blockedCrossSiteNavigation };
    },
    download: async (destinationDir): Promise<SemanticDownloadActivation> => {
      mkdirSync(destinationDir, { recursive: true });
      const pending = page.waitForEvent("download", { timeout: 5_000 });
      try {
        await locator.click();
      } catch {
        void pending.catch(() => undefined);
        return { ok: false, reason: "failed" };
      }
      const download = await pending.catch(() => null);
      if (!download) return { ok: false, reason: "no-download" };
      const receipt = await captureOwnedDownload(download, destinationDir, page.url());
      return receipt.ok
        ? {
            ok: true,
            filename: receipt.filename,
            path: receipt.path,
            bytes: receipt.bytes,
          }
        : receipt;
    },
  };
}

function semanticPage(page: Page): SemanticPage {
  return {
    url: () => page.url(),
    title: () => page.title(),
    ariaSnapshot: () => page.ariaSnapshot({ mode: "ai", depth: 12 }),
    locator: (ref) => semanticLocator(page, page.locator(`aria-ref=${ref}`)),
    navigate: async (url) => {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    },
  };
}

let openedAt: number | null = null;

/**
 * Input forwarding (the embed, phase 2): clicks and keys from the pane land in
 * her REAL browser via playwright — never anywhere near the model. Coordinates
 * arrive normalized (0..1) against the frame; we map them to the live viewport.
 */
export type BrowserInput =
  | { type: "click"; nx: number; ny: number }
  | { type: "key"; key: string }
  | { type: "text"; text: string };

export interface BrowserInputResult {
  ok: boolean;
  note: string;
}

function inputRefusal(
  control: BrowserControlState,
  owner: Exclude<BrowserInputOwner, "hands">,
): BrowserInputResult | null {
  if (control.accepts(owner)) return null;
  return {
    ok: false,
    note: `Browser input is locked while control is ${control.snapshot().mode}.`,
  };
}

interface LiveInputFacts {
  workspaceOwned: boolean;
  leaseLive: boolean;
  pageUrl: string | null;
  frameUrl: string | null;
}

function liveInputRefusal(
  control: BrowserControlState,
  owner: Exclude<BrowserInputOwner, "hands">,
  facts: LiveInputFacts,
): BrowserInputResult | null {
  const ownerRefusal = inputRefusal(control, owner);
  if (ownerRefusal) return ownerRefusal;
  if (!facts.workspaceOwned) {
    return { ok: false, note: "Browser input is not bound to the active workspace lease." };
  }
  if (!facts.pageUrl) return { ok: false, note: "No browser window is open." };
  if (!facts.leaseLive) {
    return { ok: false, note: "Browser input is blocked because the live browser lease changed." };
  }
  if (!facts.frameUrl) {
    return { ok: false, note: "Browser input is blocked until the pane has a current frame." };
  }
  if (facts.frameUrl !== facts.pageUrl) {
    return { ok: false, note: "Browser input is blocked because the pane frame is stale." };
  }
  return null;
}

export async function diveInput(
  ev: BrowserInput,
  owner: Exclude<BrowserInputOwner, "hands"> = "pane",
  requestedWorkspace: DiveWorkspace | null = activeWorkspace,
  invalidateObservation: () => void = () => undefined,
): Promise<BrowserInputResult> {
  return browserActions.run(async () => {
    invalidateObservation();
    const page = activePage();
    const workspaceOwned = Boolean(
      requestedWorkspace && activeWorkspace && sameWorkspace(activeWorkspace, requestedWorkspace),
    );
    const leaseLive = Boolean(
      page && requestedWorkspace && workspaceOwned && (await liveLeaseMatches(page, requestedWorkspace)),
    );
    const refusal = liveInputRefusal(browserControl, owner, {
      workspaceOwned,
      leaseLive,
      pageUrl: page?.url() ?? null,
      frameUrl: latestFrame?.url ?? null,
    });
    if (refusal) return refusal;
    if (!page) return { ok: false, note: "No browser window is open." };
    try {
      if (ev.type === "click") {
        const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
        await page.mouse.click(Math.round(ev.nx * size.w), Math.round(ev.ny * size.h));
        return { ok: true, note: "clicked" };
      }
      if (ev.type === "text") {
        await page.keyboard.type(ev.text);
        return { ok: true, note: "typed" };
      }
      await page.keyboard.press(ev.key);
      return { ok: true, note: "pressed" };
    } catch (err) {
      return { ok: false, note: `Input failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });
}

/** The jobs list's view of the dive (D-119: a plain list, what's running since when). */
export function diveInfo(): {
  open: boolean;
  url?: string;
  since?: number;
  frameUrl?: string;
  frameAt?: number;
  mode: BrowserMode;
  inputOwner: BrowserInputOwner | null;
} {
  const control = browserControl.snapshot();
  const page = activePage();
  if (!page) return { open: false, ...control };
  return {
    open: true,
    url: page.url(),
    since: openedAt ?? undefined,
    frameUrl: latestFrame?.url,
    frameAt: latestFrame?.at,
    ...control,
  };
}

async function liveLeaseMatches(page: Page, workspace: DiveWorkspace): Promise<boolean> {
  const port = cdpPort;
  if (!browser || !context || port === null || page.isClosed()) return false;
  if (!activeWorkspace || !sameWorkspace(activeWorkspace, workspace)) return false;
  if (!context.pages().includes(page) || activePage() !== page) return false;
  if (!isRealPageUrl(page.url()) || !portBelongsToProfile(port, workspace)) return false;
  return endpointAnswers(port);
}

async function currentSemanticFacts(
  page: Page,
  workspace: DiveWorkspace,
): Promise<SemanticFacts | null> {
  if (!browserControl.accepts("automation")) return null;
  if (!activeWorkspace || !sameWorkspace(activeWorkspace, workspace)) return null;
  if (!semanticOriginAllowed(workspace, page.url())) return null;
  if (!(await liveLeaseMatches(page, workspace))) return null;
  return {
    pageToken: page,
    rawUrl: page.url(),
    navigationEpoch: pageNavigationEpoch.get(page) ?? 0,
    controlEpoch: browserControl.epoch(),
  };
}

function semanticOriginAllowed(workspace: DiveWorkspace, rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return workspace.allowedStartOrigin ? url.origin === workspace.allowedStartOrigin : true;
}

/**
 * Close her window. Chrome is LaunchServices' child, not ours, so the polite
 * close is CDP `Browser.close` on the browser-level session — Chrome shuts
 * itself down and flushes the profile. (Playwright's own `browser.close()`
 * merely DISCONNECTS an attached browser — verified 2026-08-29, the Chrome
 * kept running — so it cannot be the closer.) If the port is already dead or
 * Chrome ignores it, fall back to signalling ONLY pids whose --user-data-dir
 * is exactly her profile; the operator's own Chrome is invisible to this.
 */
async function closeDive(requestedWorkspace: DiveWorkspace): Promise<string> {
  const refusal = workspaceLeaseRefusal(activeWorkspace, requestedWorkspace);
  if (refusal) return `Refused browser close: ${refusal}.`;
  const workspace = activeWorkspace ?? requestedWorkspace;
  const open = context !== null || profilePids(workspace).length > 0;
  try {
    await screencast?.send("Page.stopScreencast");
  } catch {
    /* the window may already be gone */
  }
  try {
    await screencast?.detach();
  } catch {
    /* ditto */
  }
  if (browser) {
    try {
      closingBrowser = true;
      const session = await browser.newBrowserCDPSession();
      await Promise.race([session.send("Browser.close"), sleep(3000)]);
    } catch {
      /* the fallback below closes it */
    }
    // Wait for Chrome to actually go, then drop our end of the connection.
    for (let i = 0; i < 12 && profilePids(workspace).length > 0; i++) await sleep(250);
    try {
      await Promise.race([browser.close(), sleep(2000)]);
    } catch {
      /* disconnect is best-effort */
    }
  }
  if (profilePids(workspace).length > 0) await clearStaleProfileChrome(workspace);
  if (launcher && launcher.exitCode === null) {
    try {
      launcher.kill("SIGKILL");
    } catch {
      /* `open` has almost certainly exited already */
    }
  }
  try {
    rmSync(workspace.portFile, { force: true });
  } catch {
    /* nothing to forget */
  }
  resetState();
  return open
    ? "Closed the window. The session stays saved in the profile."
    : "No browser window is open.";
}

export interface CreateDiveHandsOptions {
  workspace?: DiveWorkspace;
}

let semanticHostSessionSequence = 0;

function semanticObservationIdPrefix(): string {
  const entropy = `${process.pid}:${Date.now()}:${++semanticHostSessionSequence}:${Math.random()}`;
  return BigInt(`0x${createHash("sha256").update(entropy).digest("hex").slice(0, 16)}`).toString(10);
}

function createOwnedSemanticSession(
  observationDestination: string,
  observationIdPrefix = semanticObservationIdPrefix(),
) {
  return createSemanticSession({
    observationIdPrefix,
    observationOwner: () => {
      const owner = currentDownloadOwner(observationDestination);
      return owner?.jobId ? `${JSON.stringify(owner.jobId)}:${owner.setAt}` : null;
    },
    onObservation: snapshot => {
      // Direct browser/capability canaries legitimately run without a diver
      // job. Their live observation remains usable, but it is not retained or
      // readable as historical job evidence.
      if (!currentDownloadOwner(observationDestination)?.jobId) return;
      captureOwnedSemanticObservation(observationDestination, snapshot);
    },
  });
}

export function createDiveHands(options: CreateDiveHandsOptions = {}): DiveHands {
  const selected = options.workspace ?? DEFAULT_WORKSPACE;
  const workspace: DiveWorkspace = Object.freeze({
    ...selected,
    profileDir: resolve(selected.profileDir),
    captureDir: resolve(selected.captureDir),
    portFile: resolve(selected.portFile),
  });
  const observationDestination = resolve(workspace.captureDir, "downloads");
  const semantic = createOwnedSemanticSession(observationDestination);

  const hands: DiveHands = {
    async dive_start(requestedUrl, park = false) {
      let url: string;
      try {
        url = resolveStartUrl(workspace, requestedUrl);
      } catch (error) {
        return `Refused browser start: ${error instanceof Error ? error.message : String(error)}`;
      }

      return browserActions.run(async () => {
        semantic.invalidate();
        try {
          const refusal = workspaceLeaseRefusal(activeWorkspace, workspace);
          if (refusal) return `Refused browser start: ${refusal}.`;
          if (context) {
            let page = activePage();
            if (!page) {
              page = await context.newPage();
              await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
              pageFocus.focus(page);
              const control = browserControl.snapshot();
              const returningFromHands =
                shouldResumeAfterHumanClose(control) || control.mode === "reconciling";
              if (shouldResumeAfterHumanClose(control)) {
                browserControl.dismiss();
              }
              if (returningFromHands) {
                const reconciled = browserControl.reconcile(
                  await liveLeaseMatches(page, workspace),
                  "automation",
                );
                if (reconciled) {
                  emitBrowserControlReturnedContinuation(workspace, {
                    controlEpoch: browserControl.epoch(),
                    navigationEpoch: pageNavigationEpoch.get(page) ?? 0,
                    url: page.url(),
                  });
                }
              } else {
                browserControl.open(park ? "automation" : "hands");
              }
              if (park) await moveWindow(OFFSCREEN);
              else {
                await moveWindow(ONSCREEN);
                raiseProfileChrome(workspace);
              }
              void startScreencast(page);
              return `The browser window is open again on ${page.url()}. ${park ? "It sits off-screen; the pane is the window" : "The window is on-screen and in front, ready for their hands"}. Observe the page now.`;
            }
            if (park && browserControl.accepts("pane")) {
              if (!(await liveLeaseMatches(page, workspace))) {
                browserControl.block();
                return "The embedded browser lease changed. Browser input is blocked.";
              }
              browserControl.claim("automation");
              handoffPage = null;
              pageFocus.focus(page);
              void startScreencast(page);
            }
            if (requestedUrl) {
              if (!browserControl.accepts("automation")) {
                return `The browser window is already open on ${page.url()}, but control is ${browserControl.snapshot().mode}.`;
              }
              await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
              pageFocus.focus(page);
              void startScreencast(page);
              return `The browser window is already open. Moved it to ${page.url()}. Observe the page now.`;
            }
            return `The browser window is already open on ${page.url()}. ${browserControl.accepts("automation") ? "Automation has control. Observe the page now." : `Control is ${browserControl.snapshot().mode}.`}`;
          }

          // Reserve before the first await. The shared action rail keeps this
          // reservation, launch, attach, and owner transition indivisible.
          activeWorkspace = workspace;
          mkdirSync(workspace.profileDir, { recursive: true });
          mkdirSync(workspace.captureDir, { recursive: true });

          // A window of hers may already be up (sidecar restart, earlier dive).
          // Attaching beats killing: it keeps whatever the organizer was doing.
          const reused = await reusableDebugPort(workspace);
          let stderr = "";
          if (reused !== null) {
            cdpPort = reused;
          } else {
            // Otherwise clear any stale Chrome holding this profile's SingletonLock,
            // then launch REAL Chrome the way the proven path does: through
            // LaunchServices (`open -n -a`), so it comes up as an ordinary
            // foreground app, not as a driver's child. `open` exits immediately —
            // the debug port, not a child handle, is what tells us Chrome is up.
            await clearStaleProfileChrome(workspace);
            cdpPort = await allocateDebugPort();
            launcher = spawn(
              "/usr/bin/open",
              ["-n", "-a", CHROME_APP, "--args", ...chromeArgs(workspace, cdpPort, url)],
              {
                detached: false,
                stdio: ["ignore", "ignore", "pipe"],
              },
            );
            launcher.stderr?.on("data", (chunk: Buffer) => {
              if (stderr.length < 4000) stderr += String(chunk);
            });
          }

          // Attach over CDP once the port answers (never launch() — that is the tell).
          let lastErr: unknown = null;
          for (let i = 0; i < 40 && !browser; i++) {
            if (i > 0) await sleep(400);
            if (!(await endpointAnswers(cdpPort))) continue;
            try {
              browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
            } catch (err) {
              lastErr = err;
            }
          }
          if (!browser) {
            const why =
              lastErr instanceof Error
                ? lastErr.message
                : `no answer on the debug port${stderr ? `; Chrome said: ${stderr.trim().split("\n").slice(-3).join(" / ")}` : ""}`;
            await closeDive(workspace);
            return `Could not attach to the browser (${why}).`;
          }
          browser.on("disconnected", () => {
            const control = browserControl.snapshot();
            const page = activePage();
            const url = page?.url() ?? null;
            forgetAttachedBrowser();
            if (shouldResumeAfterHumanClose(control)) {
              browserControl.dismiss();
              // Closing the foreground window ends the handoff. Recreate her
              // owned Chrome off-screen first; dive_start emits the wake only
              // after the new page and local lease are observable.
              void hands.dive_start(url ?? undefined, true);
              return;
            }
            resetState();
          });
          writeFileSync(workspace.portFile, String(cdpPort), "utf8");
          context = browser.contexts()[0] ?? null;
          openedAt = Date.now();
          if (context) installPageTracking(context, workspace);
          let page = bootstrapPage();
          if (!page && context) page = await context.newPage();
          // LaunchServices can swallow the positional URL (it adds its own
          // --no-startup-window), so a blank page gets steered by hand. A page the
          // organizer is already on is left exactly where it is.
          const blank = page ? /^(about:blank)?$/.test(page.url()) : false;
          if (page && blank) {
            await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
          }
          if (page) pageFocus.focus(page);
          // Park it off the desktop (D-124) — rendering does NOT stop out there,
          // the screencast keeps producing frames, so the pane is the only place
          // the browser shows up. BUT parking is for when SHE is working: if the
          // organizer has to do something with their own hands (sign in, a consent
          // screen), a hidden window is a bug, not a feature. Callers say which.
          const parked = park ? await moveWindow(OFFSCREEN) : false;
          if (!park) {
            await moveWindow(ONSCREEN);
            raiseProfileChrome(workspace);
          }
          if (parked) {
            if (browserControl.snapshot().mode === "reconciling") {
              const reconciled = page
                ? browserControl.reconcile(await liveLeaseMatches(page, workspace), "automation")
                : false;
              if (reconciled && page) {
                emitBrowserControlReturnedContinuation(workspace, {
                  controlEpoch: browserControl.epoch(),
                  navigationEpoch: pageNavigationEpoch.get(page) ?? 0,
                  url: page.url(),
                });
              } else {
                browserControl.block();
              }
            } else {
              browserControl.open("automation");
            }
            handoffPage = null;
          } else if (park) {
            browserControl.block();
            handoffPage = null;
          } else {
            browserControl.open("hands");
            handoffPage = page;
          }
          const opened = page;
          void (async () => {
            if (opened) {
              await opened.waitForLoadState("domcontentloaded").catch(() => undefined);
              void startScreencast(opened);
            }
          })();
          const where = opened?.url() && !blank ? opened.url() : url;
          const seat = parked
            ? "It sits off-screen; the pane is the window"
            : "The window is on-screen and in front, ready for their hands";
          return `Opened Superpowers' own browser window on ${where}. ${seat}. Observe the page now. Ask for the organizer's hands only if the page itself shows a sign-in, consent screen, challenge, or another human-only step.`;
        } catch (error) {
          if (activeWorkspace && sameWorkspace(activeWorkspace, workspace)) {
            await closeDive(workspace);
          }
          return `Could not start the browser (${error instanceof Error ? error.message : String(error)}).`;
        }
      });
    },

    async dive_capture() {
      return browserActions.run(async () => {
        const refusal = workspaceLeaseRefusal(activeWorkspace, workspace);
        if (refusal) return `Refused browser capture: ${refusal}.`;
        const page = activePage();
        if (!page) return "No browser window is open. dive_start first.";
        if (!(await liveLeaseMatches(page, workspace))) {
          return "Refused browser capture: the live browser lease changed.";
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const htmlPath = resolve(workspace.captureDir, `luma-${stamp}.html`);
        const pngPath = resolve(workspace.captureDir, `luma-${stamp}.png`);
        writeFileSync(htmlPath, await page.content(), "utf8");
        await page.screenshot({ path: pngPath, fullPage: true }).catch(() => undefined);
        return `Captured ${page.url()} (DOM + screenshot saved locally). The page is now readable evidence.`;
      });
    },

    async dive_status() {
      return browserActions.run(async () => {
        const refusal = workspaceLeaseRefusal(activeWorkspace, workspace);
        if (refusal) return `Refused browser status: ${refusal}.`;
        const page = activePage();
        if (!page) return "No browser window is open.";
        if (!(await liveLeaseMatches(page, workspace))) {
          return "Refused browser status: the live browser lease changed.";
        }
        const control = browserControl.snapshot();
        return `The window is open on ${page.url()}; control is ${control.mode}.`;
      });
    },

    async dive_summon() {
      return browserActions.run(async () => {
        semantic.invalidate();
        const refusal = workspaceLeaseRefusal(activeWorkspace, workspace);
        if (refusal) return `Refused browser summon: ${refusal}.`;
        const page = activePage();
        if (!page) return "No browser window is open. dive_start first.";
        if (!browserControl.summon()) {
          return `Cannot summon the window while control is ${browserControl.snapshot().mode}.`;
        }
        handoffPage = page;
        const moved = await moveWindow(ONSCREEN);
        // Two different raises, both needed: bringToFront raises the TAB inside
        // Chrome, the osascript raises CHROME above the other apps. hasFocus is
        // true even while parked, so it cannot gate the second one.
        await page.bringToFront().catch(() => undefined);
        const raised = raiseProfileChrome(workspace);
        await sleep(400);
        if (!moved) {
          browserControl.block();
          return "Could not move the window on-screen. Browser input is blocked.";
        }
        return raised
          ? `Her window is on-screen and in front, on ${page.url()}. Do the thing only a real click can do there; dive_dismiss puts it back.`
          : `Her window is on-screen on ${page.url()}, but macOS would not raise it (Accessibility permission) — click it in the Dock. dive_dismiss puts it back.`;
      });
    },

    async dive_dismiss(owner) {
      return browserActions.run(async () => {
        semantic.invalidate();
        const refusal = workspaceLeaseRefusal(activeWorkspace, workspace);
        if (refusal) return `Refused browser dismiss: ${refusal}.`;
        const page = activePage();
        if (!page) return "No browser window is open.";
        if (!browserControl.dismiss()) {
          return `Cannot dismiss the window while control is ${browserControl.snapshot().mode}.`;
        }
        if (!(await moveWindow(OFFSCREEN))) {
          browserControl.block();
          return "Could not move the window off-screen. Browser input is blocked.";
        }
        const expectedPage = handoffPage ?? page;
        const reconciled = browserControl.reconcile(
          await liveLeaseMatches(expectedPage, workspace),
          owner,
        );
        if (!reconciled) {
          return "Her window is off-screen, but the browser lease changed. Browser input is blocked.";
        }
        pageFocus.focus(expectedPage);
        handoffPage = null;
        if (browserControl.accepts("automation")) {
          emitBrowserControlReturnedContinuation(workspace, {
            controlEpoch: browserControl.epoch(),
            navigationEpoch: pageNavigationEpoch.get(expectedPage) ?? 0,
            url: expectedPage.url(),
          });
        }
        return `Her window is off-screen again. ${browserControl.accepts("automation") ? "Automation" : "The pane"} has control.`;
      });
    },

    async dive_observe() {
      return browserActions.run(async () => {
        const refusal = workspaceLeaseRefusal(activeWorkspace, workspace);
        if (refusal) return `Refused browser observation: ${refusal}.`;
        const page = activePage();
        if (!page) return "No browser window is open. dive_start first.";
        const facts = await currentSemanticFacts(page, workspace);
        if (!facts) {
          return "Refused browser observation: the local automation lease, page, or origin changed.";
        }
        const result = await semantic.observe(
          semanticPage(page),
          facts,
          () => currentSemanticFacts(page, workspace),
        );
        return result.note;
      });
    },

    async dive_evidence(observationId) {
      return browserActions.run(async () => {
        const refusal = workspaceLeaseRefusal(activeWorkspace, workspace);
        if (refusal) return { ok: false, note: `Refused browser evidence: ${refusal}.` };
        const page = activePage();
        if (!page) return { ok: false, note: "No browser window is open. dive_start first." };
        const facts = await currentSemanticFacts(page, workspace);
        if (!facts) {
          semantic.invalidate();
          return {
            ok: false,
            note: "Refused browser evidence: the local automation lease, page, or origin changed.",
          };
        }
        return semantic.evidence(
          semanticPage(page),
          facts,
          observationId,
          () => currentSemanticFacts(page, workspace),
        );
      });
    },

    async dive_prepare(input) {
      return browserActions.run(async () => {
        const refusal = workspaceLeaseRefusal(activeWorkspace, workspace);
        if (refusal) return `Refused browser preparation: ${refusal}.`;
        const page = activePage();
        if (!page) return "No browser window is open. dive_start first.";
        const facts = await currentSemanticFacts(page, workspace);
        if (!facts) {
          semantic.invalidate();
          return "Refused browser preparation: the local automation lease, page, or origin changed.";
        }
        const result = await semantic.prepare(
          semanticPage(page),
          facts,
          input,
          () => currentSemanticFacts(page, workspace),
        );
        return result.note;
      });
    },

    async dive_follow(input) {
      return browserActions.run(async () => {
        const refusal = workspaceLeaseRefusal(activeWorkspace, workspace);
        if (refusal) return `Refused browser follow: ${refusal}.`;
        const page = activePage();
        if (!page) return "No browser window is open. dive_start first.";
        const facts = await currentSemanticFacts(page, workspace);
        if (!facts) {
          semantic.invalidate();
          return "Refused browser follow: the local automation lease, page, or origin changed.";
        }
        const result = await semantic.follow(
          semanticPage(page),
          facts,
          input,
          () => currentSemanticFacts(page, workspace),
        );
        if (!result.ok) return result.note;
        const nextFacts = await currentSemanticFacts(page, workspace);
        if (!nextFacts) return `${result.note} The changed page could not be observed.`;
        const observation = await semantic.observe(
          semanticPage(page),
          nextFacts,
          () => currentSemanticFacts(page, workspace),
        );
        return `${result.note}\n${observation.note}`;
      });
    },

    async dive_download(input) {
      return browserActions.run(async () => {
        const refusal = workspaceLeaseRefusal(activeWorkspace, workspace);
        if (refusal) return `Refused browser download: ${refusal}.`;
        const page = activePage();
        if (!page) return "No browser window is open. dive_start first.";
        const facts = await currentSemanticFacts(page, workspace);
        if (!facts) {
          semantic.invalidate();
          return "Refused browser download: the local automation lease, page, or origin changed.";
        }
        const destinationDir = resolve(workspace.captureDir, "downloads");
        beginOwnedDownloadAttempt(destinationDir, page.url());
        const result = await semantic.download(
          semanticPage(page),
          facts,
          input,
          () => currentSemanticFacts(page, workspace),
          destinationDir,
        );
        return result.note;
      });
    },

    async dive_read_download(input = { offset: 0, maxChars: 20_000 }) {
      return readLatestOwnedDownload(resolve(workspace.captureDir, "downloads"), input);
    },
    async dive_read_artifact_text(input) {
      return readOwnedArtifactText(resolve(workspace.captureDir, "downloads"), input);
    },
    async dive_read_observation(observationId) {
      return readOwnedObservationText(resolve(workspace.captureDir, "downloads"), observationId);
    },
    async dive_list_artifacts(input = {}, jobId) {
      return listOwnedDownloadArtifacts(resolve(workspace.captureDir, "downloads"), input, jobId);
    },
    dive_bind_job(jobId) {
      bindOwnedDownloadJob(resolve(workspace.captureDir, "downloads"), jobId);
    },

    dive_close: () =>
      browserActions.run(() => {
        semantic.invalidate();
        return closeDive(workspace);
      }),
    dive_input: (input, owner = "pane") =>
      diveInput(input, owner, workspace, () => semantic.invalidate()),
    dive_on_continue: (subscriber) => onDiveContinuation(workspace, subscriber),
    dive_latest_continue: () => latestDiveContinuation(workspace),
    dive_emit_continue: (event) => emitDiveContinuation(workspace, event),
  };
  return hands;
}

export function createSmokeDiveHands(run: SmokeRunPaths): DiveHands {
  return createDiveHands({ workspace: createSmokeWorkspace(run) });
}
