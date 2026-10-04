// lois-smoke-run — the file-backed boundary for one harmless 3Cs proof.
//
// This module only creates paths and evidence. It never starts Chrome, reads a
// model key, or makes a network request. A later runner must pass
// assertBrowserPreflight() before it may hand the owned profile to the dive.

import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const WORLD_FILES = ["stream.jsonl", "persons.json", "contexts.json", "gatherings.json"] as const;

export interface SmokeRunPaths {
  root: string;
  vaultDir: string;
  chromeProfileDir: string;
  tracePath: string;
  evidenceDir: string;
  manifestPath: string;
  modelUsagePath: string;
  approvalsPath: string;
  receiptsPath: string;
}

export interface SmokeRunProduct {
  repo: string;
  head: string;
  clean: boolean;
}

export interface SmokeRunArtifactHashes {
  contract: string;
  prd: string;
  testSpec: string;
}

export interface SmokeInferencePlan {
  model: string;
  pricing: {
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
    source: string;
    checkedAt: string;
    catalogVerifiedAt?: string;
    catalogEligibleEndpoints?: number;
  };
  defaultMaxOutputTokens: number;
}

export interface SmokeRunManifest {
  schemaVersion: number;
  runId: string;
  createdAt: string;
  mockUrl: string;
  product: SmokeRunProduct;
  artifactHashes: SmokeRunArtifactHashes;
  budget: typeof SMOKE_BUDGET;
  inference?: SmokeInferencePlan;
  paidInferenceApproved: boolean;
  preflight: {
    browserAllowed: boolean;
    paidInferenceAllowed: boolean;
  };
  paths: SmokeRunPaths;
}

export interface InitializeSmokeRunOptions {
  baseDir: string;
  runId: string;
  mockUrl: string;
  seedVaultDir: string;
  product: SmokeRunProduct;
  artifactHashes: SmokeRunArtifactHashes;
  inference?: SmokeInferencePlan;
  paidInferenceApproved?: boolean;
  createdAt?: string;
}

export const SMOKE_BUDGET = Object.freeze({
  // Model dispatches are a diagnostic fence, not the economic authority. A
  // research-shaped turn may legitimately use a 20-step mouth round and two
  // observed 20-step diver continuations in the same organizer turn. Keep
  // enough runway to finish and let the $1 cap govern spend.
  callsPerTurn: 60,
  callsPerRun: 72,
  runUsd: 1,
  dailyUsd: 10,
  backgroundJobs: 4,
});

function layout(root: string): SmokeRunPaths {
  return {
    root,
    vaultDir: resolve(root, "vault"),
    chromeProfileDir: resolve(root, "chrome-profile"),
    tracePath: resolve(root, "trace", "run-trace.jsonl"),
    evidenceDir: resolve(root, "evidence"),
    manifestPath: resolve(root, "manifest.json"),
    modelUsagePath: resolve(root, "model-usage.jsonl"),
    approvalsPath: resolve(root, "approvals.jsonl"),
    receiptsPath: resolve(root, "receipts.jsonl"),
  };
}

const PATH_KEYS: (keyof SmokeRunPaths)[] = [
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

export function readSmokeRunManifest(run: SmokeRunPaths): SmokeRunManifest {
  if (!existsSync(run.manifestPath)) {
    throw new Error(`Smoke manifest not found: ${run.manifestPath}`);
  }
  let manifest: SmokeRunManifest;
  try {
    manifest = JSON.parse(readFileSync(run.manifestPath, "utf8")) as SmokeRunManifest;
  } catch {
    throw new Error(`Smoke manifest is not valid JSON: ${run.manifestPath}`);
  }
  if (manifest.schemaVersion !== 1 || !manifest.mockUrl || !manifest.paths) {
    throw new Error("Smoke manifest is missing its required run fields.");
  }
  return manifest;
}

export function loadSmokeRun(root: string): SmokeRunPaths {
  const run = layout(resolve(root));
  const manifest = readSmokeRunManifest(run);
  if (PATH_KEYS.some((key) => manifest.paths[key] !== run[key])) {
    throw new Error("Smoke manifest paths do not match its run envelope.");
  }
  return run;
}

function assertRunId(runId: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) {
    throw new Error("Smoke run id must use lowercase letters, digits, and internal hyphens only.");
  }
}

/** Pure ignition preflight: validate ownership and refuse an existing run. */
export function assertSmokeRunRootAvailable(baseDir: string, runId: string): string {
  assertRunId(runId);
  const root = resolve(resolve(baseDir), `superpowers-3cs-${runId}`);
  if (existsSync(root)) throw new Error(`Smoke run already exists: ${root}`);
  return root;
}

function assertLoopbackUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Smoke mock URL must be an explicit loopback HTTP URL.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback) {
    throw new Error("Smoke mock URL must be an explicit loopback HTTP URL.");
  }
}

export function assertSmokeSeedVault(seedVaultDir: string): void {
  for (const file of WORLD_FILES) {
    if (!existsSync(resolve(seedVaultDir, file))) {
      throw new Error(`Smoke seed vault is missing ${file}.`);
    }
  }
}

function writeEmpty(path: string): void {
  writeFileSync(path, "", { encoding: "utf8", flag: "wx" });
}

export function initializeSmokeRun(options: InitializeSmokeRunOptions): SmokeRunPaths {
  const root = assertSmokeRunRootAvailable(options.baseDir, options.runId);
  assertLoopbackUrl(options.mockUrl);
  assertSmokeSeedVault(options.seedVaultDir);

  const baseDir = resolve(options.baseDir);
  mkdirSync(baseDir, { recursive: true });
  const stagingRoot = resolve(baseDir, `.superpowers-3cs-${options.runId}-${randomUUID()}.tmp`);
  const staged = layout(stagingRoot);
  const final = layout(root);

  try {
    mkdirSync(staged.vaultDir, { recursive: true });
    mkdirSync(staged.chromeProfileDir, { recursive: true });
    mkdirSync(resolve(stagingRoot, "trace"), { recursive: true });
    mkdirSync(staged.evidenceDir, { recursive: true });

    for (const file of WORLD_FILES) {
      copyFileSync(resolve(options.seedVaultDir, file), resolve(staged.vaultDir, file));
    }
    writeEmpty(staged.tracePath);
    writeEmpty(staged.modelUsagePath);
    writeEmpty(staged.approvalsPath);
    writeEmpty(staged.receiptsPath);

    const browserAllowed = options.product.clean;
    const paidInferenceApproved = options.paidInferenceApproved === true;
    const paidInferenceAllowed = browserAllowed && paidInferenceApproved && options.inference !== undefined;
    const manifest = {
      schemaVersion: 1,
      runId: options.runId,
      createdAt: options.createdAt ?? new Date().toISOString(),
      mockUrl: options.mockUrl,
      product: options.product,
      artifactHashes: options.artifactHashes,
      budget: SMOKE_BUDGET,
      ...(options.inference ? { inference: options.inference } : {}),
      paidInferenceApproved,
      preflight: {
        browserAllowed,
        paidInferenceAllowed,
      },
      paths: final,
    };
    writeFileSync(staged.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });

    renameSync(stagingRoot, root);
    return final;
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export function assertBrowserPreflight(run: SmokeRunPaths): void {
  const manifest = readSmokeRunManifest(run);
  if (manifest.product?.clean !== true || manifest.preflight?.browserAllowed !== true) {
    throw new Error("Smoke browser startup requires a clean product tree recorded in the run manifest.");
  }
}

export function assertPaidInferencePreflight(
  run: SmokeRunPaths,
  now: Date = new Date(),
): SmokeRunManifest {
  const manifest = readSmokeRunManifest(run);
  if (
    manifest.product?.clean !== true ||
    manifest.preflight?.paidInferenceAllowed !== true ||
    manifest.paidInferenceApproved !== true ||
    manifest.inference === undefined
  ) {
    throw new Error("Paid inference requires a clean product tree, an explicit approval, and a recorded pricing plan.");
  }
  const inference = manifest.inference;
  const budgetIsCanonical =
    manifest.budget?.callsPerTurn === SMOKE_BUDGET.callsPerTurn &&
    manifest.budget?.callsPerRun === SMOKE_BUDGET.callsPerRun &&
    manifest.budget?.runUsd === SMOKE_BUDGET.runUsd &&
    manifest.budget?.dailyUsd === SMOKE_BUDGET.dailyUsd &&
    manifest.budget?.backgroundJobs === SMOKE_BUDGET.backgroundJobs;
  if (!budgetIsCanonical) {
    throw new Error("Paid inference run budget does not match the committed smoke policy.");
  }
  const checkedAt = new Date(inference.pricing.checkedAt);
  const age = now.getTime() - checkedAt.getTime();
  const catalogVerifiedAt = new Date(inference.pricing.catalogVerifiedAt ?? "");
  const catalogAge = now.getTime() - catalogVerifiedAt.getTime();
  let source: URL;
  try {
    source = new URL(inference.pricing.source);
  } catch {
    throw new Error("Paid inference pricing source must be an exact HTTPS URL.");
  }
  const modelParts = inference.model.split("/");
  const expectedSource = modelParts.length === 2 && modelParts.every(Boolean)
    ? `https://openrouter.ai/api/v1/models/${modelParts.map(encodeURIComponent).join("/")}/endpoints`
    : "";
  if (
    !inference.model.trim() ||
    !Number.isFinite(inference.pricing.inputUsdPerMillion) ||
    inference.pricing.inputUsdPerMillion <= 0 ||
    !Number.isFinite(inference.pricing.outputUsdPerMillion) ||
    inference.pricing.outputUsdPerMillion <= 0 ||
    source.href !== expectedSource ||
    !Number.isFinite(checkedAt.getTime()) ||
    age < -5 * 60_000 ||
    age > 24 * 60 * 60_000 ||
    !Number.isFinite(catalogVerifiedAt.getTime()) ||
    catalogAge < -5 * 60_000 ||
    catalogAge > 24 * 60 * 60_000 ||
    !Number.isInteger(inference.pricing.catalogEligibleEndpoints) ||
    (inference.pricing.catalogEligibleEndpoints ?? 0) <= 0 ||
    !Number.isInteger(inference.defaultMaxOutputTokens) ||
    inference.defaultMaxOutputTokens <= 0 ||
    inference.defaultMaxOutputTokens > 4_000
  ) {
    throw new Error("Paid inference pricing plan is invalid or older than 24 hours.");
  }
  return manifest;
}
