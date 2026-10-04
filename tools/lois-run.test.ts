import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isDirectLoisRun } from "./lois-run.js";
import {
  assertBrowserPreflight,
  assertPaidInferencePreflight,
  assertSmokeRunRootAvailable,
  initializeSmokeRun,
} from "./lois-smoke-run.js";

const CANONICAL_SMOKE_BUDGET = {
  callsPerTurn: 60,
  callsPerRun: 72,
  runUsd: 1,
  dailyUsd: 10,
  backgroundJobs: 4,
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedVault(base: string): string {
  const seed = resolve(base, "seed");
  mkdirSync(seed, { recursive: true });
  writeFileSync(resolve(seed, "stream.jsonl"), '{"seq":1}\n', "utf8");
  writeFileSync(resolve(seed, "persons.json"), "[]\n", "utf8");
  writeFileSync(resolve(seed, "contexts.json"), "[]\n", "utf8");
  writeFileSync(resolve(seed, "gatherings.json"), "[]\n", "utf8");
  writeFileSync(resolve(seed, "run-trace.jsonl"), '{"must":"not copy"}\n', "utf8");
  return seed;
}

describe("3Cs smoke run envelope", () => {
  it("does not treat the paid Lois CLI as direct execution when another module imports it", () => {
    const cli = "file:///repo/tools/lois-run.ts";
    expect(isDirectLoisRun(cli, ["node", "/repo/tools/lois-run.test.ts"])).toBe(false);
    expect(isDirectLoisRun(cli, ["node", "/repo/tools/lois-run.ts"])).toBe(true);
  });

  it("creates the exact clean run layout without copying prior run state", () => {
    const base = mkdtempSync(resolve(tmpdir(), "lois-run-test-"));
    roots.push(base);

    const run = initializeSmokeRun({
      baseDir: base,
      runId: "proof-001",
      mockUrl: "http://127.0.0.1:4319/luma",
      seedVaultDir: seedVault(base),
      createdAt: "2026-08-29T10:00:00.000Z",
      product: { repo: "/repo/superpowers-app", head: "6f69685", clean: true },
      artifactHashes: { contract: "aaa", prd: "bbb", testSpec: "ccc" },
    });

    expect(run.root).toBe(resolve(base, "superpowers-3cs-proof-001"));
    expect(run).toMatchObject({
      vaultDir: resolve(run.root, "vault"),
      chromeProfileDir: resolve(run.root, "chrome-profile"),
      tracePath: resolve(run.root, "trace", "run-trace.jsonl"),
      evidenceDir: resolve(run.root, "evidence"),
      manifestPath: resolve(run.root, "manifest.json"),
      modelUsagePath: resolve(run.root, "model-usage.jsonl"),
      approvalsPath: resolve(run.root, "approvals.jsonl"),
      receiptsPath: resolve(run.root, "receipts.jsonl"),
    });
    for (const path of [
      run.chromeProfileDir,
      run.evidenceDir,
      run.tracePath,
      run.modelUsagePath,
      run.approvalsPath,
      run.receiptsPath,
    ]) {
      expect(existsSync(path)).toBe(true);
    }
    expect(readFileSync(resolve(run.vaultDir, "stream.jsonl"), "utf8")).toBe('{"seq":1}\n');
    expect(existsSync(resolve(run.vaultDir, "run-trace.jsonl"))).toBe(false);
    expect(readFileSync(run.tracePath, "utf8")).toBe("");
    expect(readFileSync(run.modelUsagePath, "utf8")).toBe("");

    expect(JSON.parse(readFileSync(run.manifestPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      runId: "proof-001",
      createdAt: "2026-08-29T10:00:00.000Z",
      mockUrl: "http://127.0.0.1:4319/luma",
      product: { repo: "/repo/superpowers-app", head: "6f69685", clean: true },
      artifactHashes: { contract: "aaa", prd: "bbb", testSpec: "ccc" },
      budget: CANONICAL_SMOKE_BUDGET,
      paidInferenceApproved: false,
      preflight: { browserAllowed: true, paidInferenceAllowed: false },
      paths: run,
    });
  });

  it("starts every replay from the same fixture and no earlier run state", () => {
    const base = mkdtempSync(resolve(tmpdir(), "lois-run-replay-test-"));
    roots.push(base);
    const seedVaultDir = seedVault(base);
    const common = {
      baseDir: base,
      mockUrl: "http://127.0.0.1:4319/luma",
      seedVaultDir,
      createdAt: "2026-08-29T10:00:00.000Z",
      product: { repo: "/repo/superpowers-app", head: "6f69685", clean: true },
      artifactHashes: { contract: "aaa", prd: "bbb", testSpec: "ccc" },
    };

    const first = initializeSmokeRun({ ...common, runId: "replay-001" });
    writeFileSync(resolve(first.vaultDir, "stream.jsonl"), '{"seq":2,"from":"first-run"}\n', "utf8");
    writeFileSync(first.tracePath, '{"kind":"old-turn"}\n', "utf8");
    writeFileSync(first.receiptsPath, '{"kind":"old-receipt"}\n', "utf8");
    writeFileSync(resolve(first.chromeProfileDir, "old-session"), "signed-in", "utf8");

    const replay = initializeSmokeRun({ ...common, runId: "replay-002" });

    for (const file of ["stream.jsonl", "persons.json", "contexts.json", "gatherings.json"]) {
      expect(readFileSync(resolve(replay.vaultDir, file), "utf8")).toBe(
        readFileSync(resolve(seedVaultDir, file), "utf8"),
      );
    }
    for (const path of [
      replay.tracePath,
      replay.modelUsagePath,
      replay.approvalsPath,
      replay.receiptsPath,
    ]) {
      expect(readFileSync(path, "utf8")).toBe("");
    }
    expect(existsSync(resolve(replay.chromeProfileDir, "old-session"))).toBe(false);
  });

  it.each(["https://lu.ma/3cs", "http://example.com/luma", "file:///tmp/luma.html"])(
    "rejects a non-loopback mock URL: %s",
    (mockUrl) => {
      const base = mkdtempSync(resolve(tmpdir(), "lois-run-test-"));
      roots.push(base);
      expect(() =>
        initializeSmokeRun({
          baseDir: base,
          runId: "proof-002",
          mockUrl,
          seedVaultDir: seedVault(base),
          product: { repo: "/repo/superpowers-app", head: "6f69685", clean: true },
          artifactHashes: { contract: "aaa", prd: "bbb", testSpec: "ccc" },
        }),
      ).toThrow(/loopback/i);
    },
  );

  it("records dirty state, refuses browser startup, and never overwrites an existing run", () => {
    const base = mkdtempSync(resolve(tmpdir(), "lois-run-test-"));
    roots.push(base);
    const seedVaultDir = seedVault(base);
    const common = {
      baseDir: base,
      runId: "proof-003",
      mockUrl: "http://localhost:4319/luma",
      seedVaultDir,
      artifactHashes: { contract: "aaa", prd: "bbb", testSpec: "ccc" },
    };

    const dirty = initializeSmokeRun({
      ...common,
      product: { repo: "/repo/superpowers-app", head: "6f69685", clean: false },
    });
    expect(JSON.parse(readFileSync(dirty.manifestPath, "utf8"))).toMatchObject({
      product: { clean: false },
      preflight: { browserAllowed: false, paidInferenceAllowed: false },
    });
    expect(() => assertBrowserPreflight(dirty)).toThrow(/clean product tree/i);

    const existing = resolve(base, "superpowers-3cs-proof-004");
    mkdirSync(existing);
    writeFileSync(resolve(existing, "keep"), "operator-owned", "utf8");
    expect(() =>
      initializeSmokeRun({
        ...common,
        runId: "proof-004",
        product: { repo: "/repo/superpowers-app", head: "6f69685", clean: true },
      }),
    ).toThrow(/already exists/i);
    expect(readFileSync(resolve(existing, "keep"), "utf8")).toBe("operator-owned");
  });

  it("rejects a run id that could escape the owned root", () => {
    const base = mkdtempSync(resolve(tmpdir(), "lois-run-test-"));
    roots.push(base);
    expect(() =>
      initializeSmokeRun({
        baseDir: base,
        runId: "../escape",
        mockUrl: "http://127.0.0.1:4319/luma",
        seedVaultDir: seedVault(base),
        product: { repo: "/repo/superpowers-app", head: "6f69685", clean: true },
        artifactHashes: { contract: "aaa", prd: "bbb", testSpec: "ccc" },
      }),
    ).toThrow(/run id/i);
  });

  it("refuses an existing run root during the pure pre-ignition check", () => {
    const base = mkdtempSync(resolve(tmpdir(), "lois-run-test-"));
    roots.push(base);
    const existing = resolve(base, "superpowers-3cs-already-used");
    mkdirSync(existing);

    expect(() => assertSmokeRunRootAvailable(base, "already-used")).toThrow(/already exists/i);
  });

  it("arms paid inference only when approval and an exact pricing plan are recorded together", () => {
    const base = mkdtempSync(resolve(tmpdir(), "lois-run-test-"));
    roots.push(base);
    const common = {
      baseDir: base,
      mockUrl: "http://127.0.0.1:4319/luma",
      seedVaultDir: seedVault(base),
      product: { repo: "/repo/superpowers-app", head: "e3fcb0d", clean: true },
      artifactHashes: { contract: "aaa", prd: "bbb", testSpec: "ccc" },
    };
    const unapproved = initializeSmokeRun({ ...common, runId: "paid-off" });
    expect(() => assertPaidInferencePreflight(unapproved)).toThrow(/explicit approval/i);

    const approved = initializeSmokeRun({
      ...common,
      runId: "paid-on",
      paidInferenceApproved: true,
      inference: {
        model: "test/model",
        pricing: {
          inputUsdPerMillion: 0.075,
          outputUsdPerMillion: 0.25,
          source: "https://openrouter.ai/api/v1/models/test/model/endpoints",
          checkedAt: "2026-08-29T12:00:00.000Z",
          catalogVerifiedAt: "2026-08-29T12:30:00.000Z",
          catalogEligibleEndpoints: 1,
        },
        defaultMaxOutputTokens: 1_200,
      },
    });
    expect(assertPaidInferencePreflight(approved, new Date("2026-08-29T13:00:00.000Z"))).toMatchObject({
      paidInferenceApproved: true,
      budget: CANONICAL_SMOKE_BUDGET,
      preflight: { browserAllowed: true, paidInferenceAllowed: true },
      inference: { model: "test/model", defaultMaxOutputTokens: 1_200 },
    });

    for (const [field, staleValue] of [
      ["callsPerTurn", 30],
      ["callsPerTurn", 61],
      ["callsPerRun", 73],
      ["runUsd", 10],
      ["dailyUsd", 11],
      ["backgroundJobs", 5],
    ] as const) {
      const manifest = JSON.parse(readFileSync(approved.manifestPath, "utf8")) as {
        budget: Record<string, number>;
      };
      manifest.budget[field] = staleValue;
      writeFileSync(approved.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      expect(() =>
        assertPaidInferencePreflight(approved, new Date("2026-08-29T13:00:00.000Z")),
      ).toThrow(/committed smoke policy/i);
      manifest.budget[field] = CANONICAL_SMOKE_BUDGET[field];
      writeFileSync(approved.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }
  });
});
