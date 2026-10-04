#!/usr/bin/env -S npx tsx
// A repeatable real-browser rehearsal: replace only the rehearsal vault,
// preserve its signed-in Chrome profile, then start the ordinary app.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { liveBrowserWorkspace } from "../sidecar/runtime.js";
import { assertLoopbackPortsAvailable } from "./lois-paid-app.js";
import { createDiveHands, diveWorkspaceProfilePids } from "./lois-dive.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DEFAULT_LIVE_ROOT = resolve(
  homedir(),
  "Library",
  "Application Support",
  "Neon Superpowers Rehearsal",
);

export interface LiveAppStateOptions {
  vaultDir: string;
  vaultArchiveDir: string;
  resetId: string;
}

export interface LiveAppReset {
  vaultArchive?: string;
}

export interface LiveBrowserBoundary {
  close(): Promise<string>;
  profilePids(): readonly number[];
}

function assertResetId(resetId: string): void {
  if (!resetId || basename(resetId) !== resetId || resetId === "." || resetId === "..") {
    throw new Error("Live reset id must be one path segment.");
  }
}

function writeEmptyVault(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "stream.jsonl"), "", { encoding: "utf8", flag: "wx" });
  for (const file of ["persons.json", "contexts.json", "gatherings.json"]) {
    writeFileSync(resolve(dir, file), "[]\n", { encoding: "utf8", flag: "wx" });
  }
}

/** Replace the rehearsal vault recoverably while leaving browser state alone. */
export function resetLiveAppVault(options: LiveAppStateOptions): LiveAppReset {
  assertResetId(options.resetId);
  const vaultDir = resolve(options.vaultDir);
  const vaultArchive = resolve(options.vaultArchiveDir, options.resetId);
  const stagedVault = resolve(dirname(vaultDir), `.${basename(vaultDir)}-${options.resetId}.tmp`);
  const hasVault = existsSync(vaultDir);

  for (const destination of [...(hasVault ? [vaultArchive] : []), stagedVault]) {
    if (existsSync(destination)) {
      throw new Error(`Live reset destination already exists: ${destination}`);
    }
  }

  mkdirSync(dirname(vaultDir), { recursive: true });
  mkdirSync(options.vaultArchiveDir, { recursive: true });
  writeEmptyVault(stagedVault);

  let movedVault = false;
  try {
    if (hasVault) {
      renameSync(vaultDir, vaultArchive);
      movedVault = true;
    }
    renameSync(stagedVault, vaultDir);
  } catch (error) {
    rmSync(stagedVault, { recursive: true, force: true });
    if (movedVault && !existsSync(vaultDir)) renameSync(vaultArchive, vaultDir);
    throw error;
  }

  return movedVault ? { vaultArchive } : {};
}

export async function closeThenResetLiveAppState(
  options: LiveAppStateOptions,
  browser: LiveBrowserBoundary,
): Promise<{ browserClose: string; reset: LiveAppReset }> {
  const browserClose = await browser.close();
  const residue = browser.profilePids();
  if (residue.length > 0) {
    throw new Error(`Live reset stopped: browser process ${residue.join(", ")} still owns the profile.`);
  }
  return { browserClose, reset: resetLiveAppVault(options) };
}

function resetId(now: Date = new Date()): string {
  return `live-${now.toISOString().split(".")[0]!.replaceAll(":", "-")}`;
}

function liveRoot(env: Record<string, string | undefined> = process.env): string {
  const configured = env.LOIS_LIVE_ROOT?.trim();
  if (Object.prototype.hasOwnProperty.call(env, "LOIS_LIVE_ROOT") && !configured) {
    throw new Error("LOIS_LIVE_ROOT is present but empty.");
  }
  return resolve(configured ?? DEFAULT_LIVE_ROOT);
}

export async function runLiveApp(): Promise<number> {
  await assertLoopbackPortsAvailable();
  const root = liveRoot();
  const vaultDir = resolve(root, "vault");
  const browserRoot = resolve(root, "browser");
  const workspace = liveBrowserWorkspace(browserRoot);
  const dive = createDiveHands({ workspace });
  const { browserClose, reset } = await closeThenResetLiveAppState(
    {
      vaultDir,
      vaultArchiveDir: resolve(root, "vault-archives"),
      resetId: resetId(),
    },
    {
      close: () => dive.dive_close(),
      profilePids: () => diveWorkspaceProfilePids(workspace),
    },
  );

  console.log("\nLive Superpowers rehearsal is ready.");
  console.log(`  root: ${root}`);
  console.log(`  vault: empty${reset.vaultArchive ? ` (archive: ${reset.vaultArchive})` : ""}`);
  console.log(`  browser: preserved at ${browserRoot}`);
  console.log(`  prior browser: ${browserClose}\n`);

  const child = spawn("pnpm", ["app"], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      LOIS_VAULT_DIR: vaultDir,
      LOIS_BROWSER_WORKSPACE_ROOT: browserRoot,
    },
  });
  return new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(code ?? (signal === "SIGINT" ? 130 : 1)));
  });
}

export function isDirectLiveApp(
  metaUrl: string = import.meta.url,
  argv: string[] = process.argv,
): boolean {
  const entry = argv[1];
  return Boolean(entry) && pathToFileURL(resolve(entry!)).href === metaUrl;
}

if (isDirectLiveApp()) {
  void runLiveApp()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
