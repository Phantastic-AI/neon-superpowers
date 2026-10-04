import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  options: {} as Record<string, unknown>,
  preflight: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("./lois-paid-smoke.js", () => ({
  parsePaidSmokeCli: () => mocks.options,
  preflightPaidSmoke: mocks.preflight,
  verifyPaidSmokePricing: mocks.verify,
  assertPaidSmokeIgnitionHead: vi.fn(),
  initializePaidSmokeEnvelope: vi.fn(),
}));
import {
  assertPeopleImportSmokeOutcome,
  assertPeopleImportProposalScope,
  createEmptyPeopleImportSeedVault,
  parsePeopleImportSmokeCli,
  preparePeopleImportSmoke,
  scenarioHash,
} from "./lois-people-import-smoke.js";

const scenario = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "people-import-scenario.json"), "utf8")) as {
  expected: { coverage: { selected: number; read: number; complete: boolean } };
};

let roots: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  roots = [];
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("parses only bounded people-import runner overrides and preserves paid-smoke options", () => {
  mocks.options = {
    approved: true,
    runId: "people-proof",
    baseDir: "/tmp/paid",
    seedVaultDir: "/old-seed",
    inference: { model: "configured/model", pricing: {}, defaultMaxOutputTokens: 1200 },
  };

  const parsed = parsePeopleImportSmokeCli(["--approve-paid", "--max-steps", "20", "--model", "configured/model"]);

  expect(parsed.maxSteps).toBe(20);
  expect(parsed.paidOptions).toMatchObject({ runId: "people-proof", seedVaultDir: "/old-seed" });
  expect(() => parsePeopleImportSmokeCli(["--max-steps", "11"])).toThrow(/10, 20, or 30/);
});

it("creates an empty seed vault through openVault for the ordinary smoke envelope", () => {
  const root = mkdtempSync(join(tmpdir(), "people-import-seed-test-"));
  roots.push(root);

  const seed = createEmptyPeopleImportSeedVault(root);

  expect(readFileSync(join(seed, "stream.jsonl"), "utf8")).toBe("");
  expect(JSON.parse(readFileSync(join(seed, "persons.json"), "utf8"))).toEqual([]);
  expect(JSON.parse(readFileSync(join(seed, "contexts.json"), "utf8"))).toEqual([]);
  expect(JSON.parse(readFileSync(join(seed, "gatherings.json"), "utf8"))).toEqual([]);
});

it("uses an exclusive empty seed instead of silently reusing a contaminated prior seed", () => {
  const root = mkdtempSync(join(tmpdir(), "people-import-seed-test-"));
  roots.push(root);
  const first = createEmptyPeopleImportSeedVault(root);
  writeFileSync(join(first, "stream.jsonl"), JSON.stringify({ id: "warm", cursor: 0 }) + "\n", "utf8");

  const second = createEmptyPeopleImportSeedVault(root);

  expect(second).not.toBe(first);
  expect(readFileSync(join(second, "stream.jsonl"), "utf8")).toBe("");
});

it("records the import scenario hash beside inherited paid-smoke hashes before ignition", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "people-import-envelope-test-"));
  roots.push(baseDir);
  mocks.options = {
    approved: true,
    runId: "people-envelope",
    baseDir,
    seedVaultDir: "/default-seed",
    inference: { model: "configured/model", pricing: {}, defaultMaxOutputTokens: 1200 },
  };
  mocks.preflight.mockReturnValue({
    repo: "/repo",
    head: "head-a",
    resolvedModel: { model: {} },
    artifactHashes: { contract: "aaa", prd: "bbb", testSpec: "ccc" },
  });
  mocks.verify.mockResolvedValue({ source: "official", eligibleEndpoints: 1, catalogVerifiedAt: "2026-09-06T00:00:00.000Z" });

  const { preflight, verifiedPricing } = await preparePeopleImportSmoke(parsePeopleImportSmokeCli([]));

  expect((mocks.preflight.mock.calls[0]?.[0] as { seedVaultDir?: string }).seedVaultDir).not.toBe("/default-seed");
  expect(preflight.artifactHashes).toMatchObject({ contract: "aaa", prd: "bbb", testSpec: "ccc", peopleImportScenario: scenarioHash() });
  expect(verifiedPricing).toMatchObject({ eligibleEndpoints: 1 });
});

it("validates the fresh vault outcome without a baked-in model transcript", () => {
  const result = assertPeopleImportSmokeOutcome(validView());

  expect(result).toMatchObject({
    coverage: scenario.expected.coverage,
    people: 6,
    unresolved: 2,
    sourceMemberships: 8,
    recurringVerified: expect.arrayContaining(["Nina Patel"]),
    sameNameDifferentIdentities: expect.arrayContaining(["Jordan Lee"]),
  });
});

it("counts typed local memory claims separately from outbound or event proposals", () => {
  expect(assertPeopleImportProposalScope([
    { kind: "model.reply", detail: { kind: "memory" } },
    { kind: "proposed", detail: { kind: "memory", fact: "The source list is historical." } },
    { kind: "proposed", detail: { kind: "memory", fact: "The organizer requested ranking." } },
  ])).toEqual({ proposals: 0, memoryClaims: 2 });
});

it.each(["send", "event", "publish", "unknown", undefined])(
  "still rejects a %s proposal alongside permitted local memory",
  (kind) => {
    expect(() => assertPeopleImportProposalScope([
      { kind: "proposed", detail: { kind: "memory" } },
      { kind: "proposed", ...(kind ? { detail: { kind } } : {}) },
    ])).toThrow(/1 proposal/);
  },
);

it("rejects missing coverage, unresolved rows, or collapsed same-name identities", () => {
  const good = validView();

  expect(() => assertPeopleImportSmokeOutcome({ ...good, coverage: { ...good.coverage, read: 1 } })).toThrow(/coverage/i);
  expect(() => assertPeopleImportSmokeOutcome({
    ...good,
    people: good.people.map((person) => person.identity === "unresolved" ? { ...person, identity: "verified" } : person),
  })).toThrow(/unresolved/i);
  expect(() => assertPeopleImportSmokeOutcome({
    ...good,
    people: good.people.map((person) => person.personId === "jordan-winter" ? { ...person, name: "Jordan Winter" } : person),
  })).toThrow(/same-name/i);
});

it("rejects source rows attached to the wrong downloaded bytes", () => {
  const good = validView();
  const swapped = {
    ...good,
    people: good.people.map((person) => ({
      ...person,
      memberships: person.memberships.map((item) => item.eventId === "3cs-2026-07-12"
        ? { ...item, evidence: [
            ...item.evidence.map((evidence) => evidence.startsWith("sha256:") ? `sha256:${AUG_SHA}` : evidence),
            `sha256:${JUL_SHA}`,
          ] }
        : item),
    })),
  };

  expect(() => assertPeopleImportSmokeOutcome(swapped)).toThrow(/provenance/i);
});

function validView() {
  return {
    coverage: { selected: 2, read: 2, complete: true },
    people: [
      { personId: "nina", name: "Nina Patel", identity: "verified", sourceCount: 2, memberships: [membership("3cs-2026-07-12", 1), membership("3cs-2026-08-09", 1, "2026-08-09T19:00:00.000Z")] },
      { personId: "jordan-summer", name: "Jordan Lee", identity: "verified", sourceCount: 1, memberships: [membership("3cs-2026-07-12", 2)] },
      { personId: "jordan-winter", name: "Jordan Lee", identity: "verified", sourceCount: 1, memberships: [membership("3cs-2026-08-09", 2)] },
      { personId: "casey-summer", name: "Casey Morgan", identity: "unresolved", sourceCount: 1, memberships: [membership("3cs-2026-07-12", 3)] },
      { personId: "casey-winter", name: "Casey Morgan", identity: "unresolved", sourceCount: 1, memberships: [membership("3cs-2026-08-09", 3)] },
      { personId: "priya", name: "Priya Shah", identity: "verified", sourceCount: 2, memberships: [membership("3cs-2026-07-12", 4), membership("3cs-2026-08-09", 4)] },
    ],
  };
}

function membership(eventId: "3cs-2026-07-12" | "3cs-2026-08-09", row: number, dateOverride?: string) {
  const source = eventId === "3cs-2026-07-12"
    ? { eventId, name: "3Cs Summer Table", date: "2026-07-12", path: "/account/3cs/history/3cs-2026-07-12", sha: JUL_SHA }
    : { eventId, name: "3Cs Late Summer Table", date: "2026-08-09", path: "/account/3cs/history/3cs-2026-08-09", sha: AUG_SHA };
  return {
    platform: "luma",
    accountId: "mock-luma-3cs-host",
    eventId: source.eventId,
    name: source.name,
    date: source.date,
    url: `http://127.0.0.1:4319${source.path}`,
    ...(dateOverride ? { date: dateOverride } : {}),
    evidence: ["artifact:a", `sha256:${source.sha}`, `url:http://127.0.0.1:4319${source.path}`, `csv-data-row:${row}`],
  };
}

const JUL_SHA = "79fcd412d23a6f4df5e4c0620b2a1c7070bf5f2eba3b2ff02a722b445f5b70f0";
const AUG_SHA = "17468a7835bf7a8fe8f70ae352b86297b077665722fb7acdce0b0fa652ca7f74";
