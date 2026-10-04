#!/usr/bin/env -S npx tsx
// One cold operator read: archive the active vault and Superpowers-owned
// browser runtime, create a valid empty vault, then start the ordinary app.
// The archive is recoverable; the model and product wiring are unchanged.

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
import { assertLoopbackPortsAvailable } from "./lois-paid-app.js";
import { createDiveHands, persistentDiveProfilePids } from "./lois-dive.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const APP_SUPPORT = resolve(homedir(), "Library", "Application Support");

export interface ColdAppStateOptions {
  vaultDir: string;
  vaultArchiveDir: string;
  browserStateDir: string;
  browserArchiveDir: string;
  resetId: string;
}

export interface ColdAppReset {
  vaultArchive?: string;
  browserArchive?: string;
}

export interface ColdBrowserBoundary {
  close(): Promise<string>;
  profilePids(): readonly number[];
}

function assertResetId(resetId: string): void {
  if (!resetId || basename(resetId) !== resetId || resetId === "." || resetId === "..") {
    throw new Error("Cold reset id must be one path segment.");
  }
}

function writeEmptyVault(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "stream.jsonl"), "", { encoding: "utf8", flag: "wx" });
  for (const file of ["persons.json", "contexts.json", "gatherings.json"]) {
    writeFileSync(resolve(dir, file), "[]\n", { encoding: "utf8", flag: "wx" });
  }
}

/**
 * Replace the active state without deleting it. Paths are injected so the
 * archive boundary can be proven without touching the operator's real state.
 */
export function resetColdAppState(options: ColdAppStateOptions): ColdAppReset {
  assertResetId(options.resetId);
  const vaultDir = resolve(options.vaultDir);
  const browserStateDir = resolve(options.browserStateDir);
  const vaultArchive = resolve(options.vaultArchiveDir, options.resetId);
  const browserArchive = resolve(options.browserArchiveDir, options.resetId);
  const stagedVault = resolve(dirname(vaultDir), `.${basename(vaultDir)}-${options.resetId}.tmp`);
  const hasVault = existsSync(vaultDir);
  const hasBrowser = existsSync(browserStateDir);

  for (const archive of [
    ...(hasVault ? [vaultArchive] : []),
    ...(hasBrowser ? [browserArchive] : []),
    stagedVault,
  ]) {
    if (existsSync(archive)) throw new Error(`Cold reset destination already exists: ${archive}`);
  }

  mkdirSync(dirname(vaultDir), { recursive: true });
  mkdirSync(options.vaultArchiveDir, { recursive: true });
  mkdirSync(options.browserArchiveDir, { recursive: true });
  writeEmptyVault(stagedVault);

  let movedVault = false;
  let movedBrowser = false;
  try {
    if (hasVault) {
      renameSync(vaultDir, vaultArchive);
      movedVault = true;
    }
    if (hasBrowser) {
      renameSync(browserStateDir, browserArchive);
      movedBrowser = true;
    }
    renameSync(stagedVault, vaultDir);
  } catch (error) {
    rmSync(stagedVault, { recursive: true, force: true });
    if (movedBrowser && !existsSync(browserStateDir)) renameSync(browserArchive, browserStateDir);
    if (movedVault && !existsSync(vaultDir)) renameSync(vaultArchive, vaultDir);
    throw error;
  }

  return {
    ...(movedVault ? { vaultArchive } : {}),
    ...(movedBrowser ? { browserArchive } : {}),
  };
}

export async function closeThenResetColdAppState(
  options: ColdAppStateOptions,
  browser: ColdBrowserBoundary,
): Promise<{ browserClose: string; reset: ColdAppReset }> {
  const browserClose = await browser.close();
  const residue = browser.profilePids();
  if (residue.length > 0) {
    throw new Error(`Cold reset stopped: browser process ${residue.join(", ")} still owns the profile.`);
  }
  return { browserClose, reset: resetColdAppState(options) };
}

function resetId(now: Date = new Date()): string {
  return `cold-${now.toISOString().split(".")[0]!.replaceAll(":", "-")}`;
}

export async function runColdApp(): Promise<number> {
  await assertLoopbackPortsAvailable();
  const dive = createDiveHands();
  const prepared = await closeThenResetColdAppState(
    {
      vaultDir: resolve(ROOT, "apps", "face", "vaults", "hacker-garage"),
      vaultArchiveDir: resolve(ROOT, "apps", "face", "vaults", "_cold-archives"),
      browserStateDir: resolve(APP_SUPPORT, "Neon Superpowers"),
      browserArchiveDir: resolve(APP_SUPPORT, "Neon Superpowers Cold Archives"),
      resetId: resetId(),
    },
    {
      close: () => dive.dive_close(),
      profilePids: persistentDiveProfilePids,
    },
  );
  const { browserClose, reset } = prepared;

  console.log("\nCold Superpowers app state is ready.");
  console.log(`  vault: empty${reset.vaultArchive ? ` (archive: ${reset.vaultArchive})` : ""}`);
  console.log(`  browser: unsigned${reset.browserArchive ? ` (archive: ${reset.browserArchive})` : ""}`);
  console.log(`  prior browser: ${browserClose}\n`);

  const child = spawn("pnpm", ["app"], { cwd: ROOT, stdio: "inherit" });
  return new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(code ?? (signal === "SIGINT" ? 130 : 1)));
  });
}

export function isDirectColdApp(
  metaUrl: string = import.meta.url,
  argv: string[] = process.argv,
): boolean {
  const entry = argv[1];
  return Boolean(entry) && pathToFileURL(resolve(entry!)).href === metaUrl;
}

if (isDirectColdApp()) {
  void runColdApp()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
