// sidecar/inference — bind the app's model surface to one run envelope.
//
// Persistent app sessions keep their established model behavior. A smoke
// session is different: provider access is cold unless the run manifest says
// paid inference was explicitly approved, and every role shares one fail-
// closed budget/ledger. AsyncLocalStorage keeps overlapping HTTP turns from
// borrowing each other's per-turn allowance while their detached critics and
// goldfish finish in the background.

import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, resolve } from "node:path";
import {
  budgetedLanguageModel,
  createInferenceBudget,
  type InferenceBudget,
} from "../packages/lois/inference-budget.js";
import { createLoisModel, DEFAULT_BASE_URL, type LoisModel } from "../packages/lois/model.js";
import type { LoisSystemOptions } from "../packages/lois/system.js";
import {
  resolveLoisRuntimeModel,
  type ResolvedLoisRuntimeModel,
} from "../tools/lois-env.js";
import { assertCleanHead } from "../tools/lois-capability-smoke.js";
import {
  assertPaidInferencePreflight,
  loadSmokeRun,
} from "../tools/lois-smoke-run.js";
import type { SidecarRuntime } from "./runtime.js";

export interface RuntimeInferenceStatus {
  mode: "persistent" | "cold-smoke" | "metered-smoke";
  model: string | null;
  limits?: {
    callsPerTurn: number;
    callsPerRun: number;
    runUsd: number;
    dailyUsd: number;
  };
}

export interface RuntimeInferenceBinding {
  model: LoisModel | null;
  models?: LoisSystemOptions["models"];
  budget?: InferenceBudget;
  status: RuntimeInferenceStatus;
  bindRole(actor: string, purpose: string): LoisModel | null;
  runTurn<T>(turnId: string, task: () => Promise<T>): Promise<T>;
}

export interface RuntimeInferenceDependencies {
  resolveModel?: (pricingCap?: {
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
  }) => ResolvedLoisRuntimeModel | null;
  assertProductHead?: (repo: string) => string;
  now?: Date;
}

export function bindBudgetedRoleModel(
  base: LoisModel,
  budget: InferenceBudget,
  actor: string,
  purpose: string,
  turnId: () => string,
  defaultMaxOutputTokens: number,
): LoisModel {
  return createLoisModel(
    budgetedLanguageModel(base.model, budget, {
      actor,
      purpose,
      turnId,
      defaultMaxOutputTokens,
    }),
  );
}

const directTurn = async <T>(_turnId: string, task: () => Promise<T>): Promise<T> => task();

export function resolveRuntimeInference(
  runtime: SidecarRuntime,
  dependencies: RuntimeInferenceDependencies = {},
): RuntimeInferenceBinding {
  const resolveModel = dependencies.resolveModel ?? resolveLoisRuntimeModel;

  if (runtime.mode === "persistent") {
    const resolved = resolveModel();
    return {
      model: resolved?.model ?? null,
      status: { mode: "persistent", model: resolved?.modelId ?? null },
      bindRole: () => resolved?.model ?? null,
      runTurn: directTurn,
    };
  }

  if (!runtime.runRoot) throw new Error("Smoke inference requires the run root owned by its runtime.");
  const run = loadSmokeRun(runtime.runRoot);
  const manifest = (() => {
    try {
      return assertPaidInferencePreflight(run, dependencies.now);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Paid inference requires")) return null;
      throw error;
    }
  })();

  // A free browser-capability envelope remains useful, but it is brain-cold.
  // Crucially, it never falls through to the ordinary unmetered app model.
  if (!manifest?.inference) {
    return {
      model: null,
      status: { mode: "cold-smoke", model: null },
      bindRole: () => null,
      runTurn: directTurn,
    };
  }

  const currentHead = (dependencies.assertProductHead ?? assertCleanHead)(manifest.product.repo);
  if (currentHead !== manifest.product.head) {
    throw new Error(
      `Smoke product HEAD changed: manifest has ${manifest.product.head}, current HEAD is ${currentHead}.`,
    );
  }
  const resolved = resolveModel(manifest.inference.pricing);
  if (!resolved) throw new Error("Approved smoke inference cannot find the configured repo model.");
  if (resolved.modelId !== manifest.inference.model) {
    throw new Error(
      `Smoke pricing names ${manifest.inference.model}, but the configured Lois model is ${resolved.modelId}.`,
    );
  }
  if (resolved.baseUrl.replace(/\/+$/, "") !== DEFAULT_BASE_URL) {
    throw new Error(`Smoke inference requires the canonical OpenRouter base URL: ${DEFAULT_BASE_URL}`);
  }

  const turnScope = new AsyncLocalStorage<string>();
  const turnId = () => turnScope.getStore() ?? "background-without-turn";
  const budget = createInferenceBudget({
    runId: manifest.runId,
    model: manifest.inference.model,
    ledgerPath: run.modelUsagePath,
    dailyLedgerPath: resolve(dirname(run.root), "daily-model-usage.jsonl"),
    pricing: manifest.inference.pricing,
    limits: manifest.budget,
  });
  const bind = (actor: string, purpose: string): LoisModel =>
    bindBudgetedRoleModel(
      resolved.model,
      budget,
      actor,
      purpose,
      turnId,
      manifest.inference!.defaultMaxOutputTokens,
    );

  return {
    model: null,
    models: {
      mouth: bind("lois", "organizer conversation"),
      critic: bind("critic", "cold voice review"),
      goldfish: bind("goldfish-recipient", "fresh recipient comprehension read"),
    },
    budget,
    bindRole: bind,
    status: {
      mode: "metered-smoke",
      model: manifest.inference.model,
      limits: {
        callsPerTurn: manifest.budget.callsPerTurn,
        callsPerRun: manifest.budget.callsPerRun,
        runUsd: manifest.budget.runUsd,
        dailyUsd: manifest.budget.dailyUsd,
      },
    },
    runTurn: (id, task) => turnScope.run(id, task),
  };
}
