import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ options: {} as Record<string, unknown>, evaluate: vi.fn(), verify: vi.fn(), bind: vi.fn(), head: "head-a" }));
vi.mock("./lois-paid-smoke.js", () => ({ parsePaidSmokeCli: () => mocks.options, preflightPaidSmoke: () => ({ head: "head-a", repo: "/test", resolvedModel: { model: {} } }), verifyPaidSmokePricing: mocks.verify }));
vi.mock("./lois-capability-smoke.js", () => ({ assertCleanHead: () => mocks.head }));
vi.mock("../packages/lois/inference-budget.js", () => ({ createInferenceBudget: () => ({ summary: () => ({ runUsd: .001 }) }) }));
vi.mock("../sidecar/inference.js", () => ({ bindBudgetedRoleModel: mocks.bind }));
vi.mock("../packages/lois/organizer-goldfish.js", () => ({ evaluateOrganizerPage: mocks.evaluate }));
import { runPeopleGoldfish } from "./lois-people-goldfish.js";
import { assertSmokeRunRootAvailable } from "./lois-smoke-run.js";

let dir: string, path: string, screens: string[];
beforeEach(() => {
  vi.clearAllMocks(); mocks.head = "head-a";
  dir = mkdtempSync(join(tmpdir(), "people-fish-test-")); path = join(dir, "smoke.json");
  screens = [1440, 375].map(width => { const p = join(dir, `people-${width}.png`); writeFileSync(p, `pixels-${width}`); return p; });
  mocks.options = { baseDir: dir, runId: "fish", inference: { model: "configured-model", pricing: {}, defaultMaxOutputTokens: 1200 } };
  mocks.verify.mockResolvedValue({ source: "official" }); mocks.bind.mockImplementation(() => ({}));
  mocks.evaluate.mockResolvedValue({ verdict: "swims", confusing: [] });
  writeFileSync(path, JSON.stringify({ product: { head: "head-a", clean: true }, screens }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("gives each fish the actual whole-page image and a brief without an answer key", async () => {
  const result = await runPeopleGoldfish(path, []);
  expect(result.green).toBe(true); expect(result.comprehensionOnly).toBe(true);
  expect(mocks.bind).toHaveBeenCalledTimes(2);
  expect(mocks.evaluate.mock.calls.map(call => call[1].toString())).toEqual(["pixels-1440", "pixels-375"]);
  expect(mocks.evaluate.mock.calls[0]![2]).not.toMatch(/Avery|five|2 of 3|verified/);
  expect(JSON.parse(readFileSync(join(dir, "superpowers-3cs-fish", "result.json"), "utf8")).usage.runUsd).toBe(.001);
});
it("reserves the same run ID as ordinary paid smoke before any model call", async () => {
  await runPeopleGoldfish(path, []);
  expect(() => assertSmokeRunRootAvailable(dir, "fish")).toThrow();
  await expect(runPeopleGoldfish(path, [])).rejects.toThrow();
  expect(mocks.evaluate).toHaveBeenCalledTimes(2);
});
it("refuses dirty or different-version screenshots before paid inference", async () => {
  for (const product of [{ head: "head-a", clean: false }, { head: "old-head", clean: true }]) {
    writeFileSync(path, JSON.stringify({ product, screens }));
    await expect(runPeopleGoldfish(path, [])).rejects.toThrow("committed, clean");
  }
  expect(mocks.evaluate).not.toHaveBeenCalled(); expect(mocks.verify).not.toHaveBeenCalled();
});
it("retains a sinking verdict without rewriting it as success", async () => {
  mocks.evaluate.mockResolvedValueOnce({ verdict: "sinks", confusing: ["Can't tell what was saved"] });
  const result = await runPeopleGoldfish(path, []);
  expect(result.green).toBe(false); expect(result.swims[0]!.verdict.confusing).toEqual(["Can't tell what was saved"]);
});
