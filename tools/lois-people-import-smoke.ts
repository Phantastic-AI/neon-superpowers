#!/usr/bin/env -S npx tsx
// Paid, real-inference people-import canary. Cold by default.
//
// This sibling runner reuses the ordinary paid-smoke envelope, budget, model
// binding and runtime hands. It swaps only the seed vault and mock source URL:
// an empty vault, plus a local historical Luma account with two CSV exports.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertPaidSmokeIgnitionHead,
  initializePaidSmokeEnvelope,
  parsePaidSmokeCli,
  preflightPaidSmoke,
  verifyPaidSmokePricing,
  type PaidSmokeOptions,
  type PaidSmokePreflight,
  type VerifiedPaidSmokePricing,
} from "./lois-paid-smoke.js";
import { startMockLuma } from "./mock-luma.js";
import { createInferenceBudget } from "../packages/lois/inference-budget.js";
import { createLois } from "../packages/lois/system.js";
import { openPersistentTraceFile } from "./lois-persist.js";
import { bindBudgetedRoleModel } from "../sidecar/inference.js";
import { createRuntimeHands, readRuntimeDiverJob, resolveSidecarRuntime } from "../sidecar/runtime.js";
import { loadVaultWorld } from "../sidecar/vault.js";
import { assertPaidInferencePreflight, type SmokeRunPaths } from "./lois-smoke-run.js";
import { openVault } from "../packages/vault/store.js";
import { projectPeopleViews } from "./projections/people.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASE_DIR = resolve(tmpdir(), "superpowers-paid-runs");
const SCENARIO_PATH = resolve(HERE, "fixtures", "people-import-scenario.json");
const ALLOWED_MAX_STEPS = new Set([10, 20, 30]);

interface Scenario {
  worldName: string;
  viewId: string;
  viewName: string;
  platform: string;
  accountId: string;
  sources: Array<{ eventId: string; name: string; date: string; filename: string; sha256: string; rows: number }>;
  expected: {
    coverage: { selected: number; read: number; complete: boolean };
    people: number;
    unresolved: number;
    sourceMemberships: number;
    recurringVerified: string[];
    sameNameDifferentIdentities: string[];
  };
}

export interface PeopleImportSmokeOptions {
  paidOptions: PaidSmokeOptions;
  maxSteps: 10 | 20 | 30;
}

export interface PreparedPeopleImportSmoke {
  paidOptions: PaidSmokeOptions;
  preflight: PaidSmokePreflight & { artifactHashes: PaidSmokePreflight["artifactHashes"] & { peopleImportScenario: string } };
  verifiedPricing: VerifiedPaidSmokePricing;
}

export interface PeopleImportOutcomeSummary {
  coverage: {
    selected: number;
    read: number;
    complete: boolean;
  };
  people: number;
  unresolved: number;
  sourceMemberships: number;
  recurringVerified: string[];
  sameNameDifferentIdentities: string[];
}

export interface PeopleImportSmokeResult extends PeopleImportOutcomeSummary {
  green: boolean;
  runId: string;
  runRoot: string;
  head: string;
  model: string;
  peopleImportScenario: string;
  calls: number;
  runUsd: number;
  maxSteps: 10 | 20 | 30;
  diveStatus: string;
  guestlistSaved: boolean;
  durableComplete: boolean;
  upcomingGatherings: number;
  proposals: number;
  memoryClaims: number;
  receipts: number;
  tracePath: string;
}

interface PeopleImportOutcomeView {
  coverage: {
    selected: number;
    read: number;
    complete: boolean;
  };
  people: Array<{
    personId: string;
    name: string;
    identity: string;
    sourceCount: number;
    memberships: Array<{
      platform: string;
      accountId: string;
      eventId: string;
      name: string;
      date: string;
      url: string;
      evidence: string[];
    }>;
  }>;
}

function readScenario(): Scenario {
  return JSON.parse(readFileSync(SCENARIO_PATH, "utf8")) as Scenario;
}

export function scenarioHash(): string {
  return createHash("sha256").update(readFileSync(SCENARIO_PATH)).digest("hex");
}

function splitPeopleFlags(argv: string[]): { paidArgv: string[]; maxSteps: 10 | 20 | 30 } {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const paidArgv: string[] = [];
  let maxSteps: 10 | 20 | 30 = 10;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--max-steps") {
      paidArgv.push(arg);
      continue;
    }
    const value = Number(args[index + 1]);
    if (!ALLOWED_MAX_STEPS.has(value)) throw new Error("People import smoke --max-steps must be 10, 20, or 30.");
    maxSteps = value as 10 | 20 | 30;
    index += 1;
  }
  return { paidArgv, maxSteps };
}

export function parsePeopleImportSmokeCli(argv: string[]): PeopleImportSmokeOptions {
  const { paidArgv, maxSteps } = splitPeopleFlags(argv);
  return { paidOptions: parsePaidSmokeCli(paidArgv), maxSteps };
}

export function createEmptyPeopleImportSeedVault(baseDir: string): string {
  mkdirSync(baseDir, { recursive: true });
  const seed = mkdtempSync(resolve(baseDir, ".people-import-empty-seed-"));
  openVault(seed);
  return seed;
}

function sameSourceDay(actual: string, expected: string): boolean {
  const expectedDay = expected.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDay)) return false;
  if (actual.slice(0, 10) === expectedDay) return true;
  const parsed = new Date(actual);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === expectedDay;
}

export async function preparePeopleImportSmoke(options: PeopleImportSmokeOptions): Promise<PreparedPeopleImportSmoke> {
  const seedVaultDir = createEmptyPeopleImportSeedVault(resolve(options.paidOptions.baseDir || DEFAULT_BASE_DIR));
  const paidOptions = { ...options.paidOptions, seedVaultDir };
  const basePreflight = preflightPaidSmoke(paidOptions);
  const preflight = {
    ...basePreflight,
    artifactHashes: { ...basePreflight.artifactHashes, peopleImportScenario: scenarioHash() },
  };
  const verifiedPricing = await verifyPaidSmokePricing(paidOptions, preflight);
  return { paidOptions, preflight, verifiedPricing };
}

export function assertPeopleImportSmokeOutcome(view: PeopleImportOutcomeView): PeopleImportOutcomeSummary {
  const scenario = readScenario();
  const coverage = {
    selected: view.coverage.selected,
    read: view.coverage.read,
    complete: view.coverage.complete,
  };
  if (
    coverage.selected !== scenario.expected.coverage.selected ||
    coverage.read !== scenario.expected.coverage.read ||
    coverage.complete !== scenario.expected.coverage.complete
  ) {
    throw new Error(`People import coverage did not reach ${scenario.expected.coverage.selected} of ${scenario.expected.coverage.selected}.`);
  }
  const people = view.people.length;
  const unresolved = view.people.filter((person) => person.identity === "unresolved").length;
  const sourceMemberships = view.people.reduce((sum, person) => sum + person.memberships.length, 0);
  if (people !== scenario.expected.people) throw new Error(`Expected ${scenario.expected.people} people; saw ${people}.`);
  if (unresolved !== scenario.expected.unresolved) throw new Error(`Expected ${scenario.expected.unresolved} unresolved people; saw ${unresolved}.`);
  if (sourceMemberships !== scenario.expected.sourceMemberships) throw new Error(`Expected ${scenario.expected.sourceMemberships} source memberships; saw ${sourceMemberships}.`);
  for (const source of scenario.sources) {
    const memberships = view.people.flatMap((person) => person.memberships.filter((membership) =>
      membership.platform === scenario.platform &&
      membership.accountId === scenario.accountId &&
      membership.eventId === source.eventId &&
      membership.name === source.name &&
      sameSourceDay(membership.date, source.date) &&
      // people_import_csv emits the primary imported file pointers first:
      // artifact id, exact file hash, then source URL. Later identity evidence
      // may add other artifact hashes and must not satisfy source provenance.
      membership.evidence[0]?.startsWith("artifact:") &&
      membership.evidence[1] === `sha256:${source.sha256}` &&
      membership.evidence[2] === `url:${membership.url}` &&
      membership.evidence.some((item) => item.startsWith("csv-data-row:")),
    ));
    if (memberships.length !== source.rows) {
      throw new Error(`Expected ${source.rows} retained provenance row(s) for source ${source.eventId}; saw ${memberships.length}.`);
    }
    const rowPointers = memberships.flatMap((membership) => membership.evidence.filter((item) => item.startsWith("csv-data-row:")));
    if (new Set(rowPointers).size !== source.rows) {
      throw new Error(`Source ${source.eventId} did not retain distinct CSV row provenance.`);
    }
  }

  const recurringVerified = view.people
    .filter((person) => person.identity === "verified" && person.sourceCount === 2)
    .map((person) => person.name)
    .sort();
  for (const name of scenario.expected.recurringVerified) {
    if (!recurringVerified.includes(name)) throw new Error(`Missing recurring verified identity: ${name}.`);
  }
  const names = new Map<string, Set<string>>();
  for (const person of view.people) {
    const ids = names.get(person.name) ?? new Set<string>();
    ids.add(person.personId);
    names.set(person.name, ids);
  }
  const sameNameDifferentIdentities = [...names]
    .filter(([name, ids]) => ids.size > 1 && scenario.expected.sameNameDifferentIdentities.includes(name))
    .map(([name]) => name)
    .sort();
  for (const name of scenario.expected.sameNameDifferentIdentities) {
    if (!sameNameDifferentIdentities.includes(name)) throw new Error(`Missing same-name/different-identity coverage for ${name}.`);
  }
  return { coverage, people, unresolved, sourceMemberships, recurringVerified, sameNameDifferentIdentities };
}

function readJsonl(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function assertPeopleImportProposalScope(traces: readonly Record<string, unknown>[]): {
  proposals: number;
  memoryClaims: number;
} {
  let proposals = 0;
  let memoryClaims = 0;
  for (const event of traces) {
    if (event.kind !== "proposed") continue;
    const detail = event.detail;
    // mind records local memory claims and actionable proposals separately.
    // Unknown/missing proposal kinds still fail this read-only import scenario.
    if (detail && typeof detail === "object" && "kind" in detail && detail.kind === "memory") memoryClaims += 1;
    else proposals += 1;
  }
  if (proposals > 0) throw new Error(`People import smoke produced ${proposals} proposal(s).`);
  return { proposals, memoryClaims };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function runPeopleImportSmoke(options: PeopleImportSmokeOptions): Promise<PeopleImportSmokeResult> {
  const prepared = await preparePeopleImportSmoke(options);
  const { paidOptions, preflight, verifiedPricing } = prepared;
  assertPaidSmokeIgnitionHead(preflight);
  const mock = await startMockLuma({ runId: paidOptions.runId });
  let run: SmokeRunPaths | undefined;
  let runtime: ReturnType<typeof resolveSidecarRuntime> | undefined;
  let budget: ReturnType<typeof createInferenceBudget> | undefined;
  let closeNote = "not started";
  try {
    run = initializePaidSmokeEnvelope(paidOptions, preflight, mock.historyUrl(), verifiedPricing);
    const manifest = assertPaidInferencePreflight(run);
    budget = createInferenceBudget({
      runId: paidOptions.runId,
      model: paidOptions.inference.model,
      ledgerPath: run.modelUsagePath,
      dailyLedgerPath: resolve(paidOptions.baseDir || DEFAULT_BASE_DIR, "daily-model-usage.jsonl"),
      pricing: paidOptions.inference.pricing,
      limits: manifest.budget,
    });
    let currentTurn = "preflight";
    const turnId = () => currentTurn;
    const mouth = bindBudgetedRoleModel(preflight.resolvedModel.model, budget, "lois", "people import conversation", turnId, paidOptions.inference.defaultMaxOutputTokens);
    const diver = bindBudgetedRoleModel(preflight.resolvedModel.model, budget, "diver", "historical guestlist import", turnId, paidOptions.inference.defaultMaxOutputTokens);

    runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: run.root });
    const trace = openPersistentTraceFile(run.tracePath);
    const world = loadVaultWorld(run.vaultDir);
    const system = createLois({
      world,
      model: null,
      models: { mouth },
      trace,
      hands: createRuntimeHands(runtime, world, { model: diver, trace, maxSteps: options.maxSteps }),
      maxSteps: options.maxSteps,
    });

    currentTurn = "turn-1";
    const scenario = readScenario();
    const request = [
      `Use my browser to combine the old dinner guestlists into a saved list in ${scenario.worldName}.`,
      `The historical Luma history is ${mock.historyUrl()}.`,
      "Do not create a new event, publish anything, or contact guests.",
    ].join(" ");
    const result = await system.tell(request);
    await system.idle();
    if (!result.ok || !result.output) throw new Error(result.why ?? "People import smoke produced no Lois turn.");

    const views = projectPeopleViews(openVault(run.vaultDir));
    const view = views.find((item) => item.contextName === scenario.worldName && item.coverage.selected === scenario.expected.coverage.selected);
    if (!view) throw new Error("People import smoke did not save a two-source people view.");
    const summary = assertPeopleImportSmokeOutcome(view);
    const traces = readJsonl(run.tracePath);
    const { proposals, memoryClaims } = assertPeopleImportProposalScope(traces);
    const reopened = openVault(run.vaultDir);
    const upcomingGatherings = reopened.gatherings.filter((gathering) => gathering.upcoming).length;
    if (upcomingGatherings !== 0) throw new Error(`People import smoke created ${upcomingGatherings} upcoming gathering(s).`);
    const diverJob = readRuntimeDiverJob(runtime);
    const diveStatus = diverJob?.status ?? "";
    const guestlistSaved = Array.isArray(diverJob?.hostEvidenceCategories) && diverJob.hostEvidenceCategories.includes("guestlist_saved");
    const durableComplete = diveStatus === "complete";
    const receipts = mock.receipts().length;
    if (receipts !== 0) throw new Error("People import smoke unexpectedly created an invitation receipt.");
    if (!guestlistSaved || !durableComplete) throw new Error("People import smoke did not finish with durable guestlist_saved evidence.");

    closeNote = await runtime.dive.dive_close();
    const completed = readJsonl(run.modelUsagePath).filter((row) => row.state === "completed");
    const budgetSummary = budget.summary();
    const output: PeopleImportSmokeResult = {
      green: true,
      runId: paidOptions.runId,
      runRoot: run.root,
      head: preflight.head,
      model: paidOptions.inference.model,
      peopleImportScenario: scenarioHash(),
      calls: completed.length,
      runUsd: budgetSummary.runUsd,
      maxSteps: options.maxSteps,
      diveStatus,
      guestlistSaved,
      durableComplete,
      upcomingGatherings,
      proposals,
      memoryClaims,
      receipts,
      tracePath: run.tracePath,
      ...summary,
    };
    writeJson(resolve(run.evidenceDir, "people-import-smoke-result.json"), { ...output, close: closeNote });
    return output;
  } catch (error) {
    if (run) {
      mkdirSync(run.evidenceDir, { recursive: true });
      writeJson(resolve(run.evidenceDir, "people-import-smoke-failure.json"), {
        schemaVersion: 1,
        runId: paidOptions.runId,
        runRoot: run.root,
        head: preflight.head,
        model: paidOptions.inference.model,
        maxSteps: options.maxSteps,
        peopleImportScenario: scenarioHash(),
        tracePath: run.tracePath,
        modelUsagePath: run.modelUsagePath,
        calls: existsSync(run.modelUsagePath) ? readJsonl(run.modelUsagePath).filter((row) => row.state === "completed").length : 0,
        runUsd: budget?.summary().runUsd,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    if (runtime && !closeNote.startsWith("Closed ")) await runtime.dive.dive_close().catch(() => undefined);
    await mock.close().catch(() => undefined);
  }
}

export function isDirectPeopleImportSmoke(metaUrl: string = import.meta.url, argv: string[] = process.argv): boolean {
  const entry = argv[1];
  return Boolean(entry) && pathToFileURL(resolve(entry)).href === metaUrl;
}

if (isDirectPeopleImportSmoke()) {
  void runPeopleImportSmoke(parsePeopleImportSmokeCli(process.argv.slice(2)))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.green) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
}
