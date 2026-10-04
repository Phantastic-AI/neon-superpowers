import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import { createLoisModel, type LoisModel } from "../packages/lois/model.js";
import type { ResolvedLoisRuntimeModel } from "../tools/lois-env.js";
import {
  initializeSmokeRun,
  type SmokeInferencePlan,
  type SmokeRunPaths,
} from "../tools/lois-smoke-run.js";
import { resolveRuntimeInference } from "./inference.js";
import { resolveSidecarRuntime } from "./runtime.js";

const roots: string[] = [];
const NOW = new Date("2026-08-29T12:00:00.000Z");
const HEAD = "700914dfb3a396db64507d2faff9bfa3010dff8f";
const PLAN: SmokeInferencePlan = {
  model: "z-ai/glm-5.3-flash",
  pricing: {
    inputUsdPerMillion: 0.075,
    outputUsdPerMillion: 0.25,
    source: "https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints",
    checkedAt: NOW.toISOString(),
    catalogVerifiedAt: NOW.toISOString(),
    catalogEligibleEndpoints: 1,
  },
  defaultMaxOutputTokens: 1_200,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeModel(modelId = PLAN.model): ResolvedLoisRuntimeModel {
  const model: LoisModel = {
    model: {} as LoisModel["model"],
    complete: vi.fn(async () => "{}"),
    respondToWave: vi.fn(async () => []),
  };
  return {
    model,
    modelId,
    baseUrl: "https://openrouter.ai/api/v1",
    endpointsUrl: `https://openrouter.ai/api/v1/models/${modelId}/endpoints`,
    fetchEndpoints: vi.fn(async () => new Response()),
  };
}

function dispatchingModel(modelId = PLAN.model): ResolvedLoisRuntimeModel {
  const raw = {
    specificationVersion: "v4",
    provider: "test",
    modelId,
    supportedUrls: {},
    doGenerate: vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
      warnings: [],
    })),
    doStream: vi.fn(),
  } as unknown as LanguageModel;
  return {
    model: createLoisModel(raw),
    modelId,
    baseUrl: "https://openrouter.ai/api/v1",
    endpointsUrl: `https://openrouter.ai/api/v1/models/${modelId}/endpoints`,
    fetchEndpoints: vi.fn(async () => new Response()),
  };
}

function smokeRun(paid: boolean, inference: SmokeInferencePlan = PLAN): SmokeRunPaths {
  const base = mkdtempSync(resolve(tmpdir(), "lois-runtime-inference-test-"));
  roots.push(base);
  const seed = resolve(base, "seed");
  mkdirSync(seed);
  writeFileSync(resolve(seed, "stream.jsonl"), "", "utf8");
  writeFileSync(resolve(seed, "persons.json"), "[]\n", "utf8");
  writeFileSync(resolve(seed, "contexts.json"), "[]\n", "utf8");
  writeFileSync(resolve(seed, "gatherings.json"), "[]\n", "utf8");
  return initializeSmokeRun({
    baseDir: base,
    runId: paid ? "metered-app" : "cold-app",
    mockUrl: "http://127.0.0.1:4319/event/3cs?shape=v2",
    seedVaultDir: seed,
    product: { repo: "/repo/superpowers-app", head: HEAD, clean: true },
    artifactHashes: { contract: "aaa", prd: "bbb", testSpec: "ccc" },
    ...(paid ? { inference, paidInferenceApproved: true } : {}),
    createdAt: NOW.toISOString(),
  });
}

describe("sidecar runtime inference binding", () => {
  it("keeps a browser-only smoke envelope brain-cold without resolving a provider", () => {
    const run = smokeRun(false);
    const resolveModel = vi.fn(() => fakeModel());

    const binding = resolveRuntimeInference(
      resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: run.root }),
      { resolveModel, now: NOW },
    );

    expect(binding.status).toEqual({ mode: "cold-smoke", model: null });
    expect(binding.model).toBeNull();
    expect(binding.models).toBeUndefined();
    expect(resolveModel).not.toHaveBeenCalled();
    expect(readFileSync(run.modelUsagePath, "utf8")).toBe("");
  });

  it("binds all sidecar roles to one metered smoke budget", async () => {
    const run = smokeRun(true);
    const binding = resolveRuntimeInference(
      resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: run.root }),
      {
        resolveModel: () => fakeModel(),
        assertProductHead: () => HEAD,
        now: NOW,
      },
    );

    expect(binding.model).toBeNull();
    expect(binding.models).toMatchObject({ mouth: {}, critic: {}, goldfish: {} });
    expect(binding.status).toMatchObject({
      mode: "metered-smoke",
      model: PLAN.model,
      limits: { callsPerTurn: 60, callsPerRun: 72, runUsd: 1, dailyUsd: 10 },
    });
    expect(binding.budget?.summary()).toMatchObject({ admittedCalls: 0, completedCalls: 0, runUsd: 0 });
    await expect(binding.runTurn("manual-turn-1", async () => "scoped")).resolves.toBe("scoped");
  });

  it("keeps the originating turn id on a detached role dispatch", async () => {
    const run = smokeRun(true);
    const binding = resolveRuntimeInference(
      resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: run.root }),
      {
        resolveModel: () => dispatchingModel(),
        assertProductHead: () => HEAD,
        now: NOW,
      },
    );
    let detached: Promise<string> | undefined;
    await binding.runTurn("manual-turn-7", async () => {
      detached = new Promise<void>((resolveLater) => setTimeout(resolveLater, 0))
        .then(() => binding.models!.critic!.complete({ system: "critic", user: "draft" }));
      return "mouth returned";
    });
    await detached;

    const rows = readFileSync(run.modelUsagePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "admitted", actor: "critic", turnId: "manual-turn-7" }),
      expect.objectContaining({ state: "completed", actor: "critic", turnId: "manual-turn-7" }),
    ]));
  });

  it("refuses a stale pricing plan before resolving the provider", () => {
    const stale = {
      ...PLAN,
      pricing: { ...PLAN.pricing, checkedAt: "2026-08-27T11:59:59.000Z" },
    };
    const run = smokeRun(true, stale);
    const resolveModel = vi.fn(() => fakeModel());

    expect(() => resolveRuntimeInference(
      resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: run.root }),
      { resolveModel, assertProductHead: () => HEAD, now: NOW },
    )).toThrow("pricing plan is invalid or older than 24 hours");
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it("refuses a model mismatch after the committed product check", () => {
    const run = smokeRun(true);

    expect(() => resolveRuntimeInference(
      resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: run.root }),
      {
        resolveModel: () => fakeModel("another/model"),
        assertProductHead: () => HEAD,
        now: NOW,
      },
    )).toThrow(`pricing names ${PLAN.model}, but the configured Lois model is another/model`);
  });

  it("refuses an approved run if the current product HEAD differs", () => {
    const run = smokeRun(true);
    const resolveModel = vi.fn(() => fakeModel());

    expect(() => resolveRuntimeInference(
      resolveSidecarRuntime({ LOIS_SMOKE_RUN_ROOT: run.root }),
      {
        resolveModel,
        assertProductHead: () => "different-head",
        now: NOW,
      },
    )).toThrow("Smoke product HEAD changed");
    expect(resolveModel).not.toHaveBeenCalled();
  });
});
