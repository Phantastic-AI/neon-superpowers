#!/usr/bin/env -S npx tsx
// Paid, real-inference 3Cs proof. This file is cold by default.
//
// The CLI refuses before starting the mock, Chrome, or a provider unless it
// receives an explicit --approve-paid flag plus a fresh exact pricing plan.
// It then rechecks a committed clean HEAD and runs the same Lois/browser hands
// used by the app against a loopback-only Luma boundary.

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createInferenceBudget,
  type InferenceBudget,
} from "../packages/lois/inference-budget.js";
import { DEFAULT_BASE_URL } from "../packages/lois/model.js";
import { evaluateOrganizerConversation } from "../packages/lois/organizer-goldfish.js";
import { createLois } from "../packages/lois/system.js";
import type { TraceEvent } from "../packages/lois/trace.js";
import { createRuntimeHands, resolveSidecarRuntime } from "../sidecar/runtime.js";
import { bindBudgetedRoleModel } from "../sidecar/inference.js";
import { loadVaultWorld } from "../sidecar/vault.js";
import {
  assertCleanHead,
  hashSmokeArtifact,
  processResidue,
  until,
} from "./lois-capability-smoke.js";
import {
  openRouterModelEndpointsUrl,
  resolveLoisRuntimeModel,
  type ResolvedLoisRuntimeModel,
} from "./lois-env.js";
import { openPersistentTraceFile } from "./lois-persist.js";
import {
  assertPaidInferencePreflight,
  assertSmokeRunRootAvailable,
  assertSmokeSeedVault,
  initializeSmokeRun,
  SMOKE_BUDGET,
  type SmokeInferencePlan,
  type SmokeRunPaths,
} from "./lois-smoke-run.js";
import { onBrowserFrame } from "./lois-dive.js";
import { startMockLuma, type MockLumaVariant } from "./mock-luma.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DEFAULT_BASE_DIR = resolve(tmpdir(), "superpowers-paid-runs");
const DEFAULT_SEED_VAULT = resolve(HERE, "fixtures", "3cs-smoke-vault");
const DEFAULT_MAX_OUTPUT_TOKENS = 1_200;
const PRICING_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface PaidSmokeOptions {
  approved: true;
  runId: string;
  variant: MockLumaVariant;
  baseDir: string;
  seedVaultDir: string;
  inference: SmokeInferencePlan;
}

export interface PaidSmokeTurn {
  id: string;
  organizer: string;
  lois: string;
  tools: string[];
  visibleProposals: string[];
}

export interface PaidSmokeResult {
  green: boolean;
  runId: string;
  runRoot: string;
  head: string;
  model: string;
  calls: number;
  runUsd: number;
  recipientGoldfish: unknown;
  organizerGoldfish: unknown;
  critic: unknown;
  receipt: unknown;
  cleanAfterRun: boolean;
  chromeProcessResidue: number;
}

export interface PaidSmokePreflight {
  repo: string;
  head: string;
  resolvedModel: ResolvedLoisRuntimeModel;
  artifactHashes: {
    contract: string;
    prd: string;
    testSpec: string;
  };
}

export interface VerifiedPaidSmokePricing {
  source: string;
  eligibleEndpoints: number;
  catalogVerifiedAt: string;
}

export function assertPaidSmokeAuthorization(
  options: PaidSmokeOptions,
  now: Date = new Date(),
): void {
  if (options.approved !== true) throw new Error("Paid smoke authorization was not explicit.");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.runId)) throw new Error("Paid smoke run id is invalid.");
  if (options.variant !== "v1" && options.variant !== "v2") throw new Error("Paid smoke variant is invalid.");
  if (!options.inference.model.trim()) throw new Error("Paid smoke model identity is missing.");
  positiveNumber(String(options.inference.pricing.inputUsdPerMillion), "input price");
  positiveNumber(String(options.inference.pricing.outputUsdPerMillion), "output price");
  const source = new URL(options.inference.pricing.source);
  if (source.protocol !== "https:") throw new Error("Paid smoke pricing source must be HTTPS.");
  const expectedSource = openRouterModelEndpointsUrl(options.inference.model);
  if (source.href !== expectedSource) {
    throw new Error(`Paid smoke pricing source must be the official endpoint catalog: ${expectedSource}`);
  }
  freshIso(options.inference.pricing.checkedAt, now);
  if (
    !Number.isInteger(options.inference.defaultMaxOutputTokens) ||
    options.inference.defaultMaxOutputTokens <= 0 ||
    options.inference.defaultMaxOutputTokens > 4_000
  ) {
    throw new Error("Paid smoke maximum output tokens must be a whole number from 1 through 4000.");
  }
}

function finitePrice(value: unknown, label: string): number {
  const price = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  if (!Number.isFinite(price) || price < 0) {
    throw new Error(`OpenRouter endpoint catalog contains an invalid ${label} price.`);
  }
  return price;
}

function hasUnsupportedPricingCharge(pricing: Record<string, unknown>): boolean {
  const prompt = finitePrice(pricing.prompt, "prompt");
  for (const [key, value] of Object.entries(pricing)) {
    if (key === "prompt" || key === "completion" || key === "min_context") continue;
    // Cache reads replace ordinary prompt-token billing. Reserving every input
    // token at the prompt ceiling remains conservative when this rate is lower.
    if (key === "input_cache_read") {
      if (finitePrice(value, "input_cache_read") > prompt) return true;
      continue;
    }
    // Catalog discounts are routing metadata, not a separately billed unit.
    if (key === "discount") {
      if (finitePrice(value, "discount") > 1) return true;
      continue;
    }
    // Conditional overrides require their own conservative interpreter. This
    // smoke refuses them instead of pretending the base price is sufficient.
    if (key === "overrides") return true;
    const numeric = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
    // Zero-valued extra dimensions are harmless. Any nonzero or unrecognized
    // value could bill outside the prompt/completion reservation model.
    if (!Number.isFinite(numeric) || numeric !== 0) return true;
  }
  return false;
}

/**
 * Bind the approved ceiling to OpenRouter's live endpoint catalog before any
 * mock, local app, browser, or paid completion starts. The provider adapter
 * independently sends the same values as `provider.max_price` on every call.
 */
export async function verifyPaidSmokePricing(
  options: PaidSmokeOptions,
  preflight: PaidSmokePreflight,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<VerifiedPaidSmokePricing> {
  assertPaidSmokeAuthorization(options, now);
  if (preflight.resolvedModel.endpointsUrl !== options.inference.pricing.source) {
    throw new Error("Configured model endpoint catalog does not match the approved pricing source.");
  }
  const response = await preflight.resolvedModel.fetchEndpoints(fetchImpl);
  if (!response.ok) {
    throw new Error(`OpenRouter endpoint pricing check failed with HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("OpenRouter endpoint pricing check did not return JSON.");
  }
  const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : undefined;
  const record = data && typeof data === "object" ? data as Record<string, unknown> : undefined;
  if (record?.id !== options.inference.model || !Array.isArray(record.endpoints) || record.endpoints.length === 0) {
    throw new Error("OpenRouter endpoint pricing check did not return the approved model and its endpoints.");
  }
  let eligibleEndpoints = 0;
  for (const endpoint of record.endpoints) {
    if (!endpoint || typeof endpoint !== "object") {
      throw new Error("OpenRouter endpoint catalog contains an invalid endpoint.");
    }
    const endpointRecord = endpoint as { pricing?: unknown; status?: unknown };
    const pricing = endpointRecord.pricing;
    const tiers = Array.isArray(pricing) ? pricing : [pricing];
    if (tiers.length === 0 || tiers.some((tier) => !tier || typeof tier !== "object" || Array.isArray(tier))) {
      throw new Error("OpenRouter endpoint catalog contains unsupported pricing.");
    }
    const prices = tiers.map((tier) => tier as Record<string, unknown>);
    const inputUsdPerMillion = Math.max(...prices.map((price) => finitePrice(price.prompt, "prompt") * 1_000_000));
    const outputUsdPerMillion = Math.max(...prices.map((price) => finitePrice(price.completion, "completion") * 1_000_000));
    const requestUsd = Math.max(...prices.map((price) =>
      price.request === undefined ? 0 : finitePrice(price.request, "request")));
    const hasUnsupportedCharge = prices.some(hasUnsupportedPricingCharge);
    if (
      (endpointRecord.status === undefined || endpointRecord.status === 0) &&
      !hasUnsupportedCharge &&
      inputUsdPerMillion <= options.inference.pricing.inputUsdPerMillion + 1e-9 &&
      outputUsdPerMillion <= options.inference.pricing.outputUsdPerMillion + 1e-9 &&
      requestUsd === 0
    ) {
      eligibleEndpoints += 1;
    }
  }
  if (eligibleEndpoints === 0) {
    throw new Error("No current OpenRouter endpoint fits the approved prompt, completion, and zero-request price ceiling.");
  }
  return {
    source: preflight.resolvedModel.endpointsUrl,
    eligibleEndpoints,
    catalogVerifiedAt: now.toISOString(),
  };
}

function exactFlagValues(argv: string[]): Map<string, string | true> {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const allowed = new Set([
    "--approve-paid",
    "--run-id",
    "--variant",
    "--model",
    "--input-usd-per-million",
    "--output-usd-per-million",
    "--pricing-source",
    "--pricing-checked-at",
    "--max-output-tokens",
  ]);
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!allowed.has(flag)) throw new Error(`Unknown paid smoke argument: ${flag}`);
    if (flags.has(flag)) throw new Error(`Paid smoke argument repeated: ${flag}`);
    if (flag === "--approve-paid") {
      flags.set(flag, true);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Paid smoke argument requires a value: ${flag}`);
    flags.set(flag, value);
    index += 1;
  }
  return flags;
}

function required(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string" || !value.trim()) throw new Error(`Paid smoke requires ${name}.`);
  return value.trim();
}

function positiveNumber(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

function freshIso(raw: string, now: Date): string {
  const checked = new Date(raw);
  const age = now.getTime() - checked.getTime();
  if (!Number.isFinite(checked.getTime()) || age < -5 * 60_000 || age > PRICING_MAX_AGE_MS) {
    throw new Error("--pricing-checked-at must be a valid current timestamp from the last 24 hours.");
  }
  return checked.toISOString();
}

export function parsePaidSmokeCli(
  argv: string[],
  now: Date = new Date(),
): PaidSmokeOptions {
  const flags = exactFlagValues(argv);
  if (flags.get("--approve-paid") !== true) {
    throw new Error("Paid smoke is cold: explicit --approve-paid authorization is required before any ignition.");
  }
  const model = required(flags, "--model");
  const source = required(flags, "--pricing-source");
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(source);
  } catch {
    throw new Error("--pricing-source must be an exact HTTPS URL.");
  }
  if (sourceUrl.protocol !== "https:") throw new Error("--pricing-source must be an exact HTTPS URL.");
  const expectedSource = openRouterModelEndpointsUrl(model);
  if (sourceUrl.href !== expectedSource) {
    throw new Error(`Paid smoke pricing source must be the official endpoint catalog: ${expectedSource}`);
  }

  const maxOutputTokens = flags.has("--max-output-tokens")
    ? positiveNumber(required(flags, "--max-output-tokens"), "--max-output-tokens")
    : DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens > 4_000) {
    throw new Error("--max-output-tokens must be a whole number no greater than 4000.");
  }
  const variant = (flags.get("--variant") ?? "v2") as string;
  if (variant !== "v1" && variant !== "v2") throw new Error("--variant must be v1 or v2.");
  const runId = typeof flags.get("--run-id") === "string"
    ? String(flags.get("--run-id"))
    : `paid-${now.getTime().toString(36)}`;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) {
    throw new Error("--run-id must use lowercase letters, digits, and internal hyphens only.");
  }

  return {
    approved: true,
    runId,
    variant,
    baseDir: DEFAULT_BASE_DIR,
    seedVaultDir: DEFAULT_SEED_VAULT,
    inference: {
      model,
      pricing: {
        inputUsdPerMillion: positiveNumber(
          required(flags, "--input-usd-per-million"),
          "--input-usd-per-million",
        ),
        outputUsdPerMillion: positiveNumber(
          required(flags, "--output-usd-per-million"),
          "--output-usd-per-million",
        ),
        source: sourceUrl.href,
        checkedAt: freshIso(required(flags, "--pricing-checked-at"), now),
      },
      defaultMaxOutputTokens: maxOutputTokens,
    },
  };
}

function jsonlRows(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function appendJsonl(path: string, row: Record<string, unknown>): void {
  appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
}

function traceTools(events: readonly TraceEvent[]): string[] {
  return events
    .filter((event) =>
      (event.actor === "lois" || event.actor === "diver") &&
      (event.kind === "tool.call" || event.kind === "tool.return"),
    )
    .map((event) => `${event.actor} ${event.kind}: ${event.label}`);
}

function visibleProposals(events: readonly TraceEvent[]): string[] {
  return events
    .filter((event) => event.kind === "proposed")
    .flatMap((event) => {
      const detail = event.detail ?? {};
      if (detail.kind === "draft") {
        return [JSON.stringify({
          kind: "draft",
          to: detail.to,
          channel: detail.channel,
          subject: detail.subject,
          body: detail.body,
        })];
      }
      if (detail.kind === "plan") {
        return [JSON.stringify({ kind: "plan", steps: detail.steps })];
      }
      return [];
    });
}

function conversationForFreshReader(turns: PaidSmokeTurn[], receiptSummary: string): string {
  return [
    "COMPLETE RUN TRANSCRIPT AND BOUNDED ACTION EVIDENCE:",
    ...turns.flatMap((turn) => [
      `[${turn.id}] organizer: ${turn.organizer}`,
      `[${turn.id}] Lois: ${turn.lois}`,
      ...turn.visibleProposals.map((proposal) => `[${turn.id}] organizer-visible proposal: ${proposal}`),
      ...turn.tools.map((tool) => `[${turn.id}] ${tool}`),
    ]),
    receiptSummary,
  ].join("\n");
}

export const __paidSmokeEvidenceTest = { conversationForFreshReader, visibleProposals };

function assertNoDraftProposals(events: readonly TraceEvent[], turnId: string): void {
  const count = events.filter(
    (event) => event.kind === "proposed" && event.detail?.kind === "draft",
  ).length;
  if (count > 0) throw new Error(`${turnId} produced ${count} unexpected outbound draft proposal(s).`);
}

function selectedDraft(events: readonly TraceEvent[]): {
  seq: number;
  to: string;
  subject: string;
  body: string;
  digest: string;
} {
  const drafts = events.filter(
    (event) => event.kind === "proposed" && event.detail?.kind === "draft",
  );
  if (drafts.length !== 1) throw new Error(`Draft turn must produce exactly one draft; saw ${drafts.length}.`);
  const detail = drafts[0].detail ?? {};
  const to = typeof detail.to === "string" ? detail.to.trim() : "";
  const body = typeof detail.body === "string" ? detail.body.trim() : "";
  const subject = typeof detail.subject === "string" ? detail.subject.trim() : "";
  if (to.toLowerCase() !== "maya" || !body) {
    throw new Error('The selected outbound draft must carry non-empty words and exact recipient "Maya".');
  }
  return {
    seq: drafts[0].seq,
    to,
    subject,
    body,
    digest: typeof detail.digest === "string" ? detail.digest : sha256(`${subject}\n${body}`),
  };
}

function artifactPaths(repo: string) {
  return {
    contract: resolve(repo, "docs", "browser-experience-contract.md"),
    prd: resolve(repo, "docs", "3cs-browser-goldfish-smoke.md"),
    testSpec: resolve(repo, "docs", "3cs-browser-goldfish-test-spec.md"),
  };
}

/** Pure/read-only paid preflight. It must finish before any mock or app binds. */
export function preflightPaidSmoke(options: PaidSmokeOptions): PaidSmokePreflight {
  assertPaidSmokeAuthorization(options);
  assertSmokeRunRootAvailable(options.baseDir, options.runId);
  assertSmokeSeedVault(options.seedVaultDir);
  const head = assertCleanHead(REPO);
  const resolvedModel = resolveLoisRuntimeModel(options.inference.pricing);
  if (!resolvedModel) throw new Error("Paid smoke cannot find a configured OpenRouter model in the repo .env file.");
  if (resolvedModel.modelId !== options.inference.model) {
    throw new Error(
      `Pricing plan names ${options.inference.model}, but the configured Lois model is ${resolvedModel.modelId}.`,
    );
  }
  if (resolvedModel.baseUrl.replace(/\/+$/, "") !== DEFAULT_BASE_URL) {
    throw new Error(`Paid smoke requires the canonical OpenRouter base URL: ${DEFAULT_BASE_URL}`);
  }
  const artifacts = artifactPaths(REPO);
  return {
    repo: REPO,
    head,
    resolvedModel,
    artifactHashes: {
      contract: hashSmokeArtifact(artifacts.contract),
      prd: hashSmokeArtifact(artifacts.prd),
      testSpec: hashSmokeArtifact(artifacts.testSpec),
    },
  };
}

/** Last read-only interlock immediately before a process is allowed to bind. */
export function assertPaidSmokeIgnitionHead(preflight: PaidSmokePreflight): void {
  const ignitionHead = assertCleanHead(preflight.repo);
  if (ignitionHead !== preflight.head) throw new Error("Product HEAD changed during paid preflight.");
}

/** Record the exact committed envelope after the loopback mock supplies its URL. */
export function initializePaidSmokeEnvelope(
  options: PaidSmokeOptions,
  preflight: PaidSmokePreflight,
  mockUrl: string,
  verifiedPricing: VerifiedPaidSmokePricing,
): SmokeRunPaths {
  const committedHead = assertCleanHead(preflight.repo);
  if (committedHead !== preflight.head) {
    throw new Error("Product HEAD changed before the run envelope was recorded.");
  }
  return initializeSmokeRun({
    baseDir: options.baseDir,
    runId: options.runId,
    mockUrl,
    seedVaultDir: options.seedVaultDir,
    product: { repo: preflight.repo, head: preflight.head, clean: true },
    artifactHashes: preflight.artifactHashes,
    inference: {
      ...options.inference,
      pricing: {
        ...options.inference.pricing,
        catalogVerifiedAt: verifiedPricing.catalogVerifiedAt,
        catalogEligibleEndpoints: verifiedPricing.eligibleEndpoints,
      },
    },
    paidInferenceApproved: true,
  });
}

export async function runPaidSmoke(options: PaidSmokeOptions): Promise<PaidSmokeResult> {
  const preflight = preflightPaidSmoke(options);
  const { head, resolvedModel } = preflight;
  const verifiedPricing = await verifyPaidSmokePricing(options, preflight);
  assertPaidSmokeIgnitionHead(preflight);
  const mock = await startMockLuma({ runId: options.runId });
  let run: SmokeRunPaths | undefined;
  let runtime: ReturnType<typeof resolveSidecarRuntime> | undefined;
  let stopFrames: (() => void) | undefined;
  let latestFrameUrl = "";
  let closeNote = "not started";
  try {
    run = initializePaidSmokeEnvelope(
      options,
      preflight,
      mock.variantUrl(options.variant),
      verifiedPricing,
    );
    const manifest = assertPaidInferencePreflight(run);
    const budget = createInferenceBudget({
      runId: options.runId,
      model: options.inference.model,
      ledgerPath: run.modelUsagePath,
      dailyLedgerPath: resolve(options.baseDir, "daily-model-usage.jsonl"),
      pricing: options.inference.pricing,
      limits: manifest.budget,
    });
    let currentTurn = "preflight";
    const turnId = () => currentTurn;
    const mouth = bindBudgetedRoleModel(
      resolvedModel.model,
      budget,
      "lois",
      "organizer conversation",
      turnId,
      options.inference.defaultMaxOutputTokens,
    );
    const critic = bindBudgetedRoleModel(
      resolvedModel.model,
      budget,
      "critic",
      "cold voice review",
      turnId,
      options.inference.defaultMaxOutputTokens,
    );
    const recipientFish = bindBudgetedRoleModel(
      resolvedModel.model,
      budget,
      "goldfish-recipient",
      "fresh recipient comprehension read",
      turnId,
      options.inference.defaultMaxOutputTokens,
    );
    const organizerFish = bindBudgetedRoleModel(
      resolvedModel.model,
      budget,
      "goldfish-organizer",
      "fresh organizer conversation read",
      turnId,
      options.inference.defaultMaxOutputTokens,
    );
    const diver = bindBudgetedRoleModel(
      resolvedModel.model,
      budget,
      "diver",
      "bounded browser research",
      turnId,
      options.inference.defaultMaxOutputTokens,
    );

    runtime = resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: run.root });
    const trace = openPersistentTraceFile(run.tracePath);
    const world = loadVaultWorld(run.vaultDir);
    const system = createLois({
      world,
      model: null,
      models: { mouth, critic, goldfish: recipientFish },
      gatheringId: "3cs-next",
      channel: "email",
      purpose: "invite",
      trace,
      hands: createRuntimeHands(runtime, world, { model: diver, trace }),
      maxSteps: 10,
      goldfish: { readers: "recipient-only", recipient: "Maya", maxReads: 1 },
    });
    const turns: PaidSmokeTurn[] = [];
    const tell = async (id: string, organizer: string): Promise<TraceEvent[]> => {
      currentTurn = id;
      const from = trace.cursor;
      const result = await system.tell(organizer);
      await system.idle();
      const events = trace.since(from);
      if (!result.ok || !result.output) throw new Error(result.why ?? `${id} produced no Lois turn.`);
      turns.push({
        id,
        organizer,
        lois: result.output.say,
        tools: traceTools(events),
        visibleProposals: visibleProposals(events),
      });
      return events;
    };

    const opening = await tell(
      "turn-1",
      "I need to fill Thursday's 3Cs dinner. I am behind. Start by telling me who our saved Luma history says has come before. Do not draft or propose any message yet, and do not open a browser until you ask and I say yes.",
    );
    if (opening.some((event) => event.actor === "diver" && event.kind === "tool.call" && event.label === "browser_start")) {
      throw new Error("Lois opened the browser before the organizer consented.");
    }
    assertNoDraftProposals(opening, "turn-1");

    stopFrames = onBrowserFrame((frame) => {
      latestFrameUrl = frame.url;
    });
    const browserTurn = await tell(
      "turn-2",
      "Yes. Open only the local Luma rehearsal for this run and read it. Leave the browser open in the embedded pane; do not summon or dismiss it. Do not draft or propose any message, do not prepare or submit anything yet, and do not contact a real guest.",
    );
    if (!browserTurn.some((event) => event.actor === "diver" && event.kind === "tool.call" && event.label === "browser_start")) {
      throw new Error("Lois did not use the owned browser after explicit consent.");
    }
    assertNoDraftProposals(browserTurn, "turn-2");
    await until(() => latestFrameUrl === mock.variantUrl(options.variant), "paid smoke browser on exact mock URL");

    const draftEvents = await tell(
      "turn-3",
      "Draft exactly one short, warm invitation for Maya. Set the proposal recipient to Maya. Say what 3Cs is, Thursday September 17 at 6:30 PM, and make the ask clear. End the body immediately after its one clear RSVP question: no farewell, sign-off, signature, sender line, or any other words after that question. Luma already identifies the host. Do not use the browser this turn and do not draft for anyone else.",
    );
    if (draftEvents.some((event) =>
      event.kind === "tool.call" &&
      ((event.actor === "lois" && event.label === "dive") ||
        (event.actor === "diver" && event.label.startsWith("browser_"))),
    )) {
      throw new Error("Lois used the browser during the browser-free drafting turn.");
    }
    const draft = selectedDraft(draftEvents);

    const prepareEvents = await tell(
      "turn-4",
      [
        "Use the local rehearsal browser already open. Do not draft or propose anything new.",
        "Have the diver prepare the held invitation for Maya in the already-open local rehearsal. It must fill the message first and select Maya last. Do not click, submit, or activate the form.",
        "Use this exact held draft:",
        draft.body,
      ].join("\n"),
    );
    for (const requiredTool of ["browser_observe", "browser_prepare"]) {
      if (!prepareEvents.some((event) => event.actor === "diver" && event.kind === "tool.call" && event.label === requiredTool)) {
        throw new Error(`The diver did not use ${requiredTool} during the preparation turn.`);
      }
    }
    assertNoDraftProposals(prepareEvents, "turn-4");

    const approvalText = [
      "I approve activating this prepared local rehearsal once. It may create one local Maya-only receipt. It must not contact Luma or any real guest.",
      "Acknowledge this in plain text only. Do not call a browser tool; the trusted local runner will perform the one already-approved activation.",
    ].join(" ");
    appendJsonl(run.approvalsPath, {
      schemaVersion: 1,
      at: new Date().toISOString(),
      runId: options.runId,
      action: "activate-prepared-loopback-form",
      targetOrigin: mock.origin,
      recipient: "Maya",
      draftDigest: draft.digest,
      approvalTextDigest: sha256(approvalText),
      localOnly: true,
    });
    const approvalEvents = await tell("turn-5", approvalText);
    assertNoDraftProposals(approvalEvents, "turn-5");

    const tab = await runtime.dive.dive_input({ type: "key", key: "Tab" }, "automation");
    if (!tab.ok) throw new Error(tab.note);
    const enter = await runtime.dive.dive_input({ type: "key", key: "Enter" }, "automation");
    if (!enter.ok) throw new Error(enter.note);
    await until(() => mock.receipts().length === 1, "one paid-smoke mock receipt");
    const receipt = mock.receipts()[0];
    if (receipt.recipients.length !== 1 || receipt.recipients[0] !== "maya") {
      throw new Error(`Expected one Maya-only receipt; got ${receipt.recipients.join(", ")}.`);
    }
    if (receipt.message !== draft.body) throw new Error("Mock receipt words do not match the selected held draft.");
    appendJsonl(run.receiptsPath, receipt as unknown as Record<string, unknown>);
    await until(() => latestFrameUrl.includes("/receipts/"), "paid-smoke receipt page");
    const capture = await runtime.dive.dive_capture();
    if (!capture.startsWith("Captured ")) throw new Error(capture);
    closeNote = await runtime.dive.dive_close();

    const recipientReads = trace.all().filter(
      (event) => event.actor === "goldfish" && event.kind === "note" && event.detail?.reading,
    );
    if (recipientReads.length !== 1) {
      throw new Error(`Expected exactly one fresh recipient goldfish read; saw ${recipientReads.length}.`);
    }
    if (!recipientReads[0].refs?.includes(draft.seq)) {
      throw new Error("The recipient goldfish did not read the one selected outbound draft.");
    }
    const recipientGoldfish = recipientReads[0].detail?.reading as Record<string, unknown>;
    if (
      typeof recipientGoldfish.what !== "string" ||
      typeof recipientGoldfish.when_where !== "string" ||
      typeof recipientGoldfish.ask !== "string" ||
      !Array.isArray(recipientGoldfish.assumed) ||
      (recipientGoldfish.verdict !== "swims" && recipientGoldfish.verdict !== "sinks")
    ) {
      throw new Error("Recipient goldfish returned incomplete or invalid evidence.");
    }
    const criticReads = trace.all().filter(
      (event) => event.actor === "critic" && event.kind === "note" && event.detail?.verdict,
    );
    const criticVerdict = criticReads.length === 1 ? criticReads[0].detail : { verdict: "unjudged" };

    currentTurn = "goldfish-organizer";
    const organizerGoldfish = await evaluateOrganizerConversation(
      organizerFish,
      conversationForFreshReader(
        turns,
        "[local evidence] Chrome created exactly one Maya-only mock receipt. Nothing reached Luma or a real guest.",
      ),
    );
    writeFileSync(
      resolve(run.evidenceDir, "recipient-goldfish.json"),
      `${JSON.stringify(recipientGoldfish, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      resolve(run.evidenceDir, "organizer-goldfish.json"),
      `${JSON.stringify(organizerGoldfish, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      resolve(run.evidenceDir, "conversation.json"),
      `${JSON.stringify(turns, null, 2)}\n`,
      "utf8",
    );

    const usageRows = jsonlRows(run.modelUsagePath);
    const admitted = usageRows.filter((row) => row.state === "admitted");
    const completed = usageRows.filter((row) => row.state === "completed");
    const failedOrRefused = usageRows.filter((row) => row.state === "failed" || row.state === "refused");
    const goldfishCalls = completed.filter(
      (row) => row.actor === "goldfish-recipient" || row.actor === "goldfish-organizer",
    );
    const budgetSummary = budget.summary();
    const residue = processResidue(run.chromeProfileDir);
    const cleanAfterRun = assertCleanHead(preflight.repo) === head;
    const green =
      recipientGoldfish.verdict === "swims" &&
      organizerGoldfish.verdict === "swims" &&
      organizerGoldfish.instruction_fidelity === true &&
      criticVerdict?.verdict === "clean" &&
      goldfishCalls.length === 2 &&
      admitted.length === completed.length &&
      failedOrRefused.length === 0 &&
      budgetSummary.runUsd <= manifest.budget.runUsd &&
      receipt.recipients.length === 1 &&
      residue.length === 0 &&
      cleanAfterRun;
    const result: PaidSmokeResult = {
      green,
      runId: options.runId,
      runRoot: run.root,
      head,
      model: options.inference.model,
      calls: completed.length,
      runUsd: budgetSummary.runUsd,
      recipientGoldfish,
      organizerGoldfish,
      critic: criticVerdict,
      receipt,
      cleanAfterRun,
      chromeProcessResidue: residue.length,
    };
    writeFileSync(
      resolve(run.evidenceDir, "paid-smoke-result.json"),
      `${JSON.stringify({ ...result, capture, close: closeNote }, null, 2)}\n`,
      "utf8",
    );
    return result;
  } catch (error) {
    if (run) {
      writeFileSync(
        resolve(run.evidenceDir, "paid-smoke-failure.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          runId: options.runId,
          head,
          error: error instanceof Error ? error.message : String(error),
        }, null, 2)}\n`,
        "utf8",
      );
    }
    throw error;
  } finally {
    stopFrames?.();
    if (runtime && !closeNote.startsWith("Closed ")) {
      await runtime.dive.dive_close().catch(() => undefined);
    }
    await mock.close().catch(() => undefined);
  }
}

export function isDirectPaidSmoke(metaUrl: string = import.meta.url, argv: string[] = process.argv): boolean {
  const entry = argv[1];
  return Boolean(entry) && pathToFileURL(resolve(entry)).href === metaUrl;
}

if (isDirectPaidSmoke()) {
  void runPaidSmoke(parsePaidSmokeCli(process.argv.slice(2)))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.green) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
}
