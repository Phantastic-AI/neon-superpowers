import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openVault, registerContext } from "../packages/vault/store.js";
import { projectPeopleView } from "../tools/projections/people.js";
import { __loisDiveTest, createDiveHands, type DiveHands, type OwnedArtifactTextResult } from "../tools/lois-dive.js";
import type { SemanticFacts, SemanticPage } from "../tools/lois-semantic.js";
import { createPeopleCapabilities, createPeopleWorldHand } from "./people-capabilities.js";
import { createDiver, createMemoryDiverJobStore } from "../packages/lois/diver.js";
import { Trace } from "../packages/lois/trace.js";
import { createSenses } from "../packages/lois/senses.js";
import { createPeopleHands } from "./people-hands.js";
import { readPeopleWorkspace, savePeopleNote, savePeopleOrder, submitPeopleNotes } from "../packages/vault/people-edits.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const peopleImportScenario = JSON.parse(readFileSync(join(import.meta.dirname, "..", "tools", "fixtures", "people-import-scenario.json"), "utf8")) as {
  platform: string;
  accountId: string;
  worldName: string;
  viewId: string;
  viewName: string;
  sources: { eventId: string; name: string; date: string; filename: string; sha256: string; rows: number }[];
  expected: { coverage: { selected: number; read: number; complete: boolean }; people: number; unresolved: number; sourceMemberships: number };
};

function setup() {
  const vaultDir = mkdtempSync(join(tmpdir(), "people-capabilities-")); roots.push(vaultDir);
  const vault = openVault(vaultDir);
  registerContext(vault, { id: "c1", name: "Our dinners", kind: "social", anchor: "email", created_at: "2026-09-01T00:00:00Z" });
  const world = { entries: vault.entries, persons: vault.persons, contexts: vault.contexts, gatherings: vault.gatherings };
  const artifacts = new Map<string, string>([["a", 'ID,Full name,Email,Status\n1,"Avery, A",avery@example.test,Going\n2,Sam,sam@example.test,Invited\n']]);
  const read = vi.fn(async ({ artifactId }: { artifactId: string }): Promise<OwnedArtifactTextResult> => artifacts.has(artifactId)
    ? { ok: true, text: artifacts.get(artifactId)!, artifact: { artifactId, sourceUrl: "https://events.example.test/admin/a", capturedAt: 10, bytes: 100, sha256: "abc", filename: "export.csv", jobId: "job1", attemptId: "attempt1" } } as OwnedArtifactTextResult
    : { ok: false, note: "Artifact not owned by this job" });
  const readObservation = vi.fn(async (observationId: string): Promise<OwnedArtifactTextResult> => ({
    ok: true,
    text: `Observation ${observationId}\nPage: Profile\nURL: https://events.example.test/home`,
    artifact: {
      schemaVersion: 1, artifactId: `artifact_${observationId}`, kind: "semantic_observation",
      observationId, sourceUrl: "https://events.example.test/home", capturedAt: 11,
      bytes: 80, sha256: `sha-${observationId}`, filename: `${observationId}.txt`, jobId: "job1",
    },
  }));
  const dive = { dive_read_artifact_text: read, dive_read_observation: readObservation } as Pick<DiveHands, "dive_read_artifact_text" | "dive_read_observation">;
  const caps = createPeopleCapabilities({ vaultDir, dive }, world);
  return { vaultDir, world, artifacts, dive, caps };
}
const source = { platform: "example", accountId: "our-account", eventId: "a", name: "Dinner A", date: "2026-08-24", url: "https://events.example.test/a" };
const select = { contextId: "c1", viewId: "dinners", viewName: "Our dinner people", sources: [{ ...source, evidence: { artifactId: "a" } }], discoveryComplete: true };
const csvInput = { contextId: "c1", viewId: "dinners", source: { platform: "example", accountId: "our-account", eventId: "a" }, artifactId: "a", columns: { rowId: "ID", name: ["Full name"], email: "Email", rsvp: "Status" }, readState: "read" };
const decision = (artifactId: string) => ({ kind: "email", rationale: "The signed-in organizer export identifies each registered guest by their account email, not a guessed contact address.", evidence: [{ artifactId }] });

const prospectInput = {
  contextId: "c1", viewId: "dinners", requestId: "profile-one", rowId: "profile-one", name: "Avery, A",
  source: { platform: "linkedin", sourceId: "profile-one", label: "Observed investor profile", url: "https://www.linkedin.com/in/example" },
  evidence: [{ observationId: "profile" }], confidence: "chatham",
  anchors: [{ kind: "email", value: "avery@example.test", identity: { rationale: "The profile lists this contact email", evidence: [{ observationId: "profile" }] } }],
  reason: { text: "Invests in agent tools; a relevant person to invite.", evidence: [{ observationId: "profile" }], confidence: "chatham" },
};

it("lets the diver save source-backed prospects into the existing list and read their reasons", async () => {
  const { caps, vaultDir, dive } = setup();
  await caps.people_select_sources.run(select);
  await caps.people_import_csv.run({ ...csvInput, identity: decision("a") });
  const save = caps.people_save_prospect;
  expect(save).toBeDefined();
  const result = JSON.parse(await save.run(prospectInput));
  expect(result).toMatchObject({ ok: true, people: 2 });
  expect(dive.dive_read_observation).toHaveBeenCalledTimes(1);
  const before = readFileSync(join(vaultDir, "stream.jsonl"), "utf8");
  dive.dive_read_observation = async () => ({ ok: false, note: "Observation no longer available" });
  await save.run(prospectInput);
  expect(readFileSync(join(vaultDir, "stream.jsonl"), "utf8")).toBe(before);
  await expect(save.run({ ...prospectInput, name: "Different person" })).rejects.toThrow(/request/i);
  const roster = JSON.parse(await caps.people_read.run({ contextId: "c1", viewId: "dinners", includeEvidence: true }));
  expect(roster.people.find((person: any) => person.name === "Avery, A").prospects[0]).toMatchObject({
    platform: "linkedin", reason: { text: prospectInput.reason.text, epistemics: "inferred" }, evidence: expect.arrayContaining([
      "observation:profile", "artifact:artifact_profile", "sha256:sha-profile", "url:https://events.example.test/home",
    ]),
  });
  expect(JSON.stringify(save.traceInput!(prospectInput))).not.toContain("avery@example.test");
  expect(projectPeopleView(openVault(vaultDir), "c1", "dinners")!.people).toHaveLength(2);
});

it.each([false, true])("settles a real saved prospect job after vault verification (replayed=%s)", async replayed => {
  const { caps, vaultDir } = setup();
  await caps.people_select_sources.run(select);
  await caps.people_import_csv.run({ ...csvInput, identity: decision("a") });
  if (replayed) await caps.people_save_prospect.run(prospectInput);
  const before = readFileSync(join(vaultDir, "stream.jsonl"), "utf8");
  const store = createMemoryDiverJobStore();
  let calls = 0;
  const diver = createDiver({ model: {} as never, trace: new Trace(), store, capabilities: caps,
    runModel: async ({ capabilities }) => {
      calls += 1;
      if (calls === 1) {
        const saved = JSON.parse(await capabilities.people_save_prospect.run(prospectInput));
        expect(saved).toMatchObject({ ok: true, savedRequestId: prospectInput.requestId });
        expect(Boolean(saved.replayed)).toBe(replayed);
      } else {
        const roster = JSON.parse(await capabilities.people_read.run({ contextId: "c1", viewId: "dinners", includeEvidence: true }));
        expect(roster.people.find((person: any) => person.name === prospectInput.name).prospects[0]).toMatchObject({
          platform: prospectInput.source.platform,
          reason: { text: prospectInput.reason.text, epistemics: "inferred" },
          evidence: expect.arrayContaining(["observation:profile", "artifact:artifact_profile"]),
        });
      }
      return { text: JSON.stringify({ status: calls === 1 ? "partial" : "complete", goalCategory: "prospect_research",
        summary: calls === 1 ? "Finding saved; verify the current People view." : "The requested finding is saved and verified.",
        ...(calls === 1 ? { next: "Verify the saved finding." } : {}),
        evidence: [prospectInput.requestId], evidenceCategories: ["prospect_saved"] }), steps: 2, toolCalls: 1 };
    },
  });
  const partial = JSON.parse(await diver({ intent: "Save the observed prospect and verify the finding in the People view." }));
  const afterSave = readFileSync(join(vaultDir, "stream.jsonl"), "utf8");
  const complete = JSON.parse(await diver({ intent: "Verify the saved prospect in the current People view." }));
  expect(partial.status).toBe("partial");
  expect(complete).toMatchObject({ jobId: partial.jobId, status: "complete" });
  expect(store.load()).toMatchObject({ id: partial.jobId, status: "complete", hostEvidenceCategories: ["prospect_saved"] });
  expect(projectPeopleView(openVault(vaultDir), "c1", "dinners")!.people.some(person => person.prospects?.some(prospect => prospect.reason.text === prospectInput.reason.text))).toBe(true);
  expect(readFileSync(join(vaultDir, "stream.jsonl"), "utf8")).toBe(afterSave);
  if (replayed) expect(afterSave).toBe(before);
  else expect(afterSave).not.toBe(before);
});

it("does not certify prospect evidence when the real save loses its observation", async () => {
  const { caps, vaultDir, dive } = setup();
  await caps.people_select_sources.run(select);
  const before = readFileSync(join(vaultDir, "stream.jsonl"), "utf8");
  dive.dive_read_observation = async () => ({ ok: false, note: "Observation no longer available" });
  const store = createMemoryDiverJobStore();
  const diver = createDiver({ model: {} as never, trace: new Trace(), store, capabilities: caps,
    runModel: async ({ capabilities }) => {
      await capabilities.people_save_prospect.run(prospectInput);
      throw new Error("A refused save must not return");
    },
  });
  expect(JSON.parse(await diver({ intent: "Save the observed prospect." })).status).toBe("blocked");
  expect(store.load()?.hostEvidenceCategories).toEqual([]);
  expect(readFileSync(join(vaultDir, "stream.jsonl"), "utf8")).toBe(before);
});

it("files observation A after following to B through the production retained-observation bridge", async () => {
  const base = setup();
  await base.caps.people_select_sources.run(select);
  await base.caps.people_import_csv.run({ ...csvInput, identity: decision("a") });

  const captureDir = join(base.vaultDir, "browser-captures");
  const downloads = join(captureDir, "downloads");
  mkdirSync(downloads, { recursive: true });
  __loisDiveTest.bindOwnedDownloadJob(downloads, "job-retained-observation", 10);
  __loisDiveTest.beginOwnedDownloadAttempt(downloads, "https://events.example.test/export", 20);
  await __loisDiveTest.captureOwnedDownload({
    suggestedFilename: () => "people.csv",
    failure: async () => null,
    saveAs: async path => { writeFileSync(path, "Name\nAda\n"); },
  }, downloads, "https://events.example.test/export", 30);

  const hands = createDiveHands({ workspace: {
    profileDir: join(base.vaultDir, "browser-profile"), captureDir, portFile: join(base.vaultDir, "browser.port"),
    defaultStartUrl: null, allowedStartOrigin: null, requireExplicitStartUrl: false,
  } });
  const semantic = __loisDiveTest.createOwnedSemanticSession(downloads, "987654");
  const pageToken = {};
  let rawUrl = "https://events.example.test/profile/a?private=yes#contact";
  let snapshot = '- link "Next" [ref=e1]\n- heading "Avery profile" [ref=e2]';
  const page: SemanticPage = {
    url: () => rawUrl,
    title: async () => "Avery profile",
    ariaSnapshot: async () => snapshot,
    locator: () => ({
      count: async () => 1, isVisible: async () => true, isEnabled: async () => true,
      inspect: async () => ({ tag: "a", type: "", role: "link", readOnly: false, multiple: false, hidden: false,
        descriptor: "Next", options: [], href: "https://events.example.test/profile/b?secret=two" }),
      fill: async () => undefined, check: async () => undefined, select: async () => undefined,
      activate: async () => ({ blockedWrite: false, blockedCrossSiteNavigation: false }),
      download: async () => ({ ok: false as const, reason: "no-download" as const }),
    }),
    navigate: async url => { rawUrl = url; snapshot = '- heading "Second profile" [ref=e3]'; },
  };
  let liveFacts: SemanticFacts = { pageToken, rawUrl, navigationEpoch: 1, controlEpoch: 1 };
  const current = async () => liveFacts;
  const observedA = await semantic.observe(page, liveFacts, current);
  const observationA = observedA.note.match(/Observation (obs-\d+)/)?.[1];
  expect(observationA).toBe("obs-9876541");
  expect(await semantic.follow(page, liveFacts, { observationId: observationA!, ref: "e1" }, current)).toMatchObject({ ok: true });
  liveFacts = { ...liveFacts, rawUrl, navigationEpoch: 2 };
  const observedB = await semantic.observe(page, liveFacts, current);
  const observationB = observedB.note.match(/Observation (obs-\d+)/)?.[1];
  expect(observationB).toBe("obs-9876542");
  await expect(semantic.evidence(page, liveFacts, observationA!, current)).resolves.toMatchObject({ ok: false });
  await expect(semantic.follow(page, liveFacts, { observationId: observationA!, ref: "e1" }, current)).resolves.toMatchObject({ ok: false });

  const retainedA = await hands.dive_read_observation(observationA!);
  const retainedB = await hands.dive_read_observation(observationB!);
  expect(retainedA).toMatchObject({ ok: true, artifact: { sourceUrl: "https://events.example.test/profile/a" } });
  expect(retainedB).toMatchObject({ ok: true, artifact: { sourceUrl: "https://events.example.test/profile/b" } });
  expect(__loisDiveTest.readLatestOwnedDownload(downloads)).toContain("Ada");
  if (!retainedA.ok) throw new Error(retainedA.note);

  const retainedCaps = createPeopleCapabilities({ vaultDir: base.vaultDir, dive: hands }, base.world);
  const evidence = [{ observationId: observationA! }];
  await retainedCaps.people_save_prospect.run({
    ...prospectInput,
    requestId: "retained-profile-a",
    rowId: "retained-profile-a",
    evidence,
    anchors: [{ ...prospectInput.anchors[0], identity: { ...prospectInput.anchors[0].identity, evidence } }],
    reason: { ...prospectInput.reason, evidence },
  });
  const roster = JSON.parse(await retainedCaps.people_read.run({ contextId: "c1", viewId: "dinners", includeEvidence: true }));
  expect(roster.people.flatMap((person: any) => person.prospects).find((item: any) => item.sourceRowId === "retained-profile-a").evidence)
    .toEqual(expect.arrayContaining([
      `observation:${observationA}`,
      `artifact:${retainedA.artifact.artifactId}`,
      `sha256:${retainedA.artifact.sha256}`,
      "url:https://events.example.test/profile/a",
    ]));

  const firstHost = __loisDiveTest.createOwnedSemanticSession(downloads);
  const secondHost = __loisDiveTest.createOwnedSemanticSession(downloads);
  const firstId = (await firstHost.observe(page, liveFacts, current)).note.match(/Observation (obs-\d+)/)?.[1];
  const secondId = (await secondHost.observe(page, liveFacts, current)).note.match(/Observation (obs-\d+)/)?.[1];
  expect(firstId).toMatch(/^obs-\d+$/);
  expect(secondId).toMatch(/^obs-\d+$/);
  expect(secondId).not.toBe(firstId);
});

it("does not save a prospect when its evidence cannot be retrieved", async () => {
  const { caps, vaultDir } = setup();
  await caps.people_select_sources.run(select);
  expect(caps.people_save_prospect).toBeDefined();
  const before = ["stream.jsonl", "persons.json"].map(file => readFileSync(join(vaultDir, file), "utf8"));
  await expect(caps.people_save_prospect.run({ ...prospectInput, evidence: [{ artifactId: "foreign" }] })).rejects.toThrow("Artifact not owned");
  expect(["stream.jsonl", "persons.json"].map(file => readFileSync(join(vaultDir, file), "utf8"))).toEqual(before);
});

it("preserves organizer edits that land while a prospect's observation is being retrieved", async () => {
  const { caps, vaultDir, dive, world } = setup();
  await caps.people_select_sources.run(select);
  await caps.people_import_csv.run({ ...csvInput, identity: decision("a") });
  const view = readPeopleWorkspace(openVault(vaultDir), "c1", "dinners")!;
  const order = [...view.order].reverse();
  const evidence = dive.dive_read_observation;
  dive.dive_read_observation = async id => {
    savePeopleOrder(openVault(vaultDir), { contextId: "c1", viewId: "dinners", personIds: order, baseRevision: view.orderRevision, requestId: "while-reading" });
    return evidence(id);
  };
  await caps.people_save_prospect.run(prospectInput);
  expect(readPeopleWorkspace(world, "c1", "dinners")!.order).toEqual(order);
  expect(readPeopleWorkspace(openVault(vaultDir), "c1", "dinners")!.order).toEqual(order);
});

it("rejects unavailable observation proof without any partial prospect writes", async () => {
  const { caps, vaultDir, dive } = setup();
  await caps.people_select_sources.run(select);
  dive.dive_read_observation = async () => ({ ok: false, note: "Observation no longer available" });
  const before = ["stream.jsonl", "persons.json"].map(file => readFileSync(join(vaultDir, file), "utf8"));
  await expect(caps.people_save_prospect.run(prospectInput)).rejects.toThrow("Observation no longer available");
  expect(["stream.jsonl", "persons.json"].map(file => readFileSync(join(vaultDir, file), "utf8"))).toEqual(before);
});

function emptySetup(artifacts: Map<string, string>) {
  const vaultDir = mkdtempSync(join(tmpdir(), "people-capabilities-empty-")); roots.push(vaultDir);
  const vault = openVault(vaultDir);
  const world = { entries: vault.entries, persons: vault.persons, contexts: vault.contexts, gatherings: vault.gatherings };
  const read = vi.fn(async ({ artifactId }: { artifactId: string }): Promise<OwnedArtifactTextResult> => {
    const text = artifacts.get(artifactId);
    return text === undefined
      ? { ok: false, note: "Artifact not owned by this job" }
      : { ok: true, text, artifact: {
          schemaVersion: 1,
          artifactId,
          kind: "download",
          sourceUrl: `https://events.example.test/downloads/${artifactId}`,
          capturedAt: 10,
          bytes: Buffer.byteLength(text),
          sha256: createHash("sha256").update(text).digest("hex"),
          filename: artifactId,
          jobId: "job-local-world",
          attemptId: "attempt-local-world",
          readOffset: 0,
          readMaxChars: 20_000,
          freshness: {
            attemptId: "attempt-local-world",
            attemptStartedAt: 1,
            currentAtCapture: true,
          },
          summary: `Captured download ${artifactId}.`,
        } };
  });
  const dive = {
    dive_read_artifact_text: read,
    dive_read_observation: vi.fn(async (observationId: string): Promise<OwnedArtifactTextResult> => ({
      ok: true,
      text: `Observation ${observationId}`,
      artifact: {
        schemaVersion: 1, artifactId: `artifact_${observationId}`, kind: "semantic_observation",
        observationId, sourceUrl: "https://events.example.test/home", capturedAt: 11,
        bytes: 20, sha256: `sha-${observationId}`, filename: `${observationId}.txt`, jobId: "job-local-world",
      },
    })),
  } as Pick<DiveHands, "dive_read_artifact_text" | "dive_read_observation">;
  const caps = createPeopleCapabilities({ vaultDir, dive }, world);
  return { vaultDir, world, dive, caps };
}

function scenarioArtifacts() {
  return new Map<string, string>([
    ["summer", [
      "Registration ID,Full name,Email,RSVP,Attendance",
      "jul-001,Nina Patel,nina.patel@example.test,Going,Checked in",
      "jul-002,Jordan Lee,jordan.summer@example.test,Going,Checked in",
      "jul-003,Casey Morgan,,Going,",
      "jul-004,Priya Shah,priya.shah@example.test,Invited,",
      "",
    ].join("\n")],
    ["late-summer", [
      "Registration ID,Full name,Email,RSVP,Attendance",
      "aug-001,Nina Patel,nina.patel@example.test,Going,Checked in",
      "aug-002,Jordan Lee,jordan.winter@example.test,Going,Checked in",
      "aug-003,Casey Morgan,,Going,",
      "aug-004,Priya Shah,priya.shah@example.test,Going,Checked in",
      "",
    ].join("\n")],
  ]);
}

async function twoDinners() {
  const fixture = setup();
  fixture.artifacts.set("b", "ID,Full name,Email,Status\n1,Avery Again,avery@example.test,Going\n2,Sam,other-sam@example.test,Invited\n");
  await fixture.caps.people_select_sources.run({ ...select, sources: [...select.sources, { ...source, eventId: "b", name: "Dinner B", evidence: { artifactId: "b" } }] });
  return { ...fixture, second: { ...csvInput, source: { ...csvInput.source, eventId: "b" }, artifactId: "b" } };
}

it("lets the diver read and create a local World before importing two historical CSVs", async () => {
  const { caps, world, vaultDir, dive } = emptySetup(scenarioArtifacts());
  const sources = peopleImportScenario.sources.map((item, index) => ({
    platform: peopleImportScenario.platform,
    accountId: peopleImportScenario.accountId,
    eventId: item.eventId,
    name: item.name,
    date: item.date,
    url: `https://events.example.test/history/${item.eventId}`,
    evidence: { artifactId: index === 0 ? "summer" : "late-summer" },
  }));
  const store = createMemoryDiverJobStore();
  const trace = new Trace();
  const mouthSenses = createSenses(world, null, trace);
  expect((await mouthSenses.warm()).look).toContain("No event worlds");
  const mouthHands = createPeopleHands(vaultDir, world);
  const diveHand = createDiver({
    model: {} as never,
    trace,
    store,
    capabilities: caps,
    runModel: async ({ capabilities }) => {
      expect(JSON.parse(await capabilities.worlds.run({}))).toEqual([]);
      const created = JSON.parse(await capabilities.remember_world.run({
        name: peopleImportScenario.worldName,
        lane: "social",
        anchor: "email",
        requestId: "local-world-import",
      })) as { contextId: string; createdEvent: boolean };
      expect(created.createdEvent).toBe(false);
      await capabilities.people_select_sources.run({
        contextId: created.contextId,
        viewId: peopleImportScenario.viewId,
        viewName: peopleImportScenario.viewName,
        discoveryComplete: true,
        sources,
      });
      for (const [index, item] of peopleImportScenario.sources.entries()) {
        await capabilities.people_import_csv.run({
          contextId: created.contextId,
          viewId: peopleImportScenario.viewId,
          source: {
            platform: peopleImportScenario.platform,
            accountId: peopleImportScenario.accountId,
            eventId: item.eventId,
          },
          artifactId: index === 0 ? "summer" : "late-summer",
          columns: {
            rowId: "Registration ID",
            name: ["Full name"],
            email: "Email",
            rsvp: "RSVP",
            attendance: "Attendance",
          },
          identity: decision(index === 0 ? "summer" : "late-summer"),
          readState: "read",
        });
      }
      return {
        text: "",
        steps: 4,
        toolCalls: 5,
        report: {
          status: "complete",
          goalCategory: "guestlist_import",
          summary: "Saved two historical source lists into a local people view.",
          evidence: [],
          evidenceCategories: ["guestlist_saved"],
        },
      };
    },
  });

  const result = JSON.parse(await diveHand({ intent: "Save historical guestlists into a local World." }));
  expect(result.status).toBe("complete");
  expect(store.load()?.hostEvidenceCategories).toContain("guestlist_saved");
  expect(dive.dive_read_artifact_text).toHaveBeenCalledTimes(4);
  const view = projectPeopleView(world, world.contexts[0].id, peopleImportScenario.viewId)!;
  expect(view.coverage).toMatchObject(peopleImportScenario.expected.coverage);
  expect(view.people).toHaveLength(peopleImportScenario.expected.people);
  expect(view.people.filter(person => person.identity !== "verified")).toHaveLength(peopleImportScenario.expected.unresolved);
  expect(view.people.flatMap(person => person.memberships)).toHaveLength(peopleImportScenario.expected.sourceMemberships);
  expect(world.gatherings.filter(gathering => gathering.upcoming)).toHaveLength(0);
  expect(trace.all().map(event => event.label)).not.toContain("remember_event");
  const discovered = await mouthSenses.tools.worlds.execute!({}, { toolCallId: "refresh-after-diver", messages: [], context: {} });
  expect(discovered).toContain(`contextId=${view.contextId}`);
  expect(discovered).toContain(`viewId=${view.viewId}`);
  const read = JSON.parse(await mouthHands.people_read.run({ contextId: view.contextId, viewId: view.viewId }));
  expect(read).toMatchObject({ ok: true, total: peopleImportScenario.expected.people, coverage: peopleImportScenario.expected.coverage });
  expect(trace.all().filter(event => event.actor === "lois" && event.kind === "tool.call" && event.label === "worlds")).toHaveLength(1);
});

it("keeps world creation idempotent inside diver capabilities", async () => {
  const { caps, world } = emptySetup(new Map());
  const input = { name: "No next event", lane: "social", anchor: "email", requestId: "same-world" };

  const first = JSON.parse(await caps.remember_world.run(input));
  const second = JSON.parse(await caps.remember_world.run(input));

  expect(second).toMatchObject({ ok: true, contextId: first.contextId, replayed: true, createdEvent: false });
  expect(world.contexts).toHaveLength(1);
  expect(world.gatherings).toHaveLength(0);
});

it("lists only app-readable Worlds from the current vault and refreshes after construction", async () => {
  const { caps, world, vaultDir } = emptySetup(new Map());
  registerContext(openVault(vaultDir), { id: "system", name: "System", kind: "system", anchor: "email", apps_never_read: true, created_at: "2026-09-01T00:00:00Z" });
  registerContext(openVault(vaultDir), { id: "public", name: "Public listing", kind: "public", anchor: "email", created_at: "2026-09-01T00:00:00Z" });
  registerContext(openVault(vaultDir), { id: "social", name: "Dinner friends", kind: "social", anchor: "email", created_at: "2026-09-01T00:00:00Z" });

  const worlds = JSON.parse(await caps.worlds.run({}));

  expect(worlds).toEqual([
    { contextId: "public", name: "Public listing", kind: "public", anchor: "email" },
    { contextId: "social", name: "Dinner friends", kind: "social", anchor: "email" },
  ]);
  expect(world.contexts.map(context => context.id)).toEqual(["system", "public", "social"]);
  expect(JSON.stringify(worlds)).not.toContain("apps_never_read");
  expect(JSON.stringify(worlds)).not.toContain("created_at");
});

it("combines repeated people through the actual CSV hand only with a retained, reasoned identity decision", async () => {
  const { caps, world, second } = await twoDinners();
  await caps.people_import_csv.run({ ...csvInput, identity: decision("a") });
  await caps.people_import_csv.run({ ...second, identity: decision("b") });
  const view = projectPeopleView(world, "c1", "dinners")!;
  expect(view.people).toHaveLength(3);
  expect(view.people.filter(person => person.name === "Sam")).toHaveLength(2);
  const recurring = view.people.find(person => person.sourceCount === 2)!;
  expect(recurring.identity).toBe("verified");
  expect(recurring.anchors[0]).toMatchObject({ verified: true, adjudication: { rationale: decision("a").rationale, evidence: expect.arrayContaining(["artifact:a"]) } });
});

it("lets a diver inspect provisional saved evidence and refine identity without losing organizer edits", async () => {
  const { caps, world, vaultDir, second } = await twoDinners();
  await caps.people_import_csv.run(csvInput);
  await caps.people_import_csv.run(second);
  const before = readPeopleWorkspace(world, "c1", "dinners")!;
  expect(before.people).toHaveLength(4);
  expect(before.people.every(person => person.identity === "unresolved")).toBe(true);
  const order = [...before.order].reverse();
  savePeopleOrder(openVault(vaultDir), { contextId: "c1", viewId: "dinners", personIds: order, baseRevision: 0, requestId: "organizer-order" });
  savePeopleNote(openVault(vaultDir), { contextId: "c1", viewId: "dinners", noteId: "organizer-note", personId: order[0], text: "Keep this guest near the top", state: "draft", baseRevision: 0, requestId: "organizer-note" });
  const entries = openVault(vaultDir).entries;

  expect(caps.people_read).toBeDefined();
  const detailed = JSON.parse(await caps.people_read.run({ contextId: "c1", viewId: "dinners", includeEvidence: true }));
  expect(detailed).toMatchObject({ ok: true, total: 4, orderRevision: 1 });
  expect(detailed.people.map((person: { personId: string }) => person.personId)).toEqual(order);
  for (const person of detailed.people) {
    const stored = before.people.find(row => row.personId === person.personId)!;
    expect(person.anchors).toEqual(stored.anchors);
    expect(person.memberships).toEqual(stored.memberships);
    expect(person.anchors.every((anchor: { verified: boolean }) => !anchor.verified)).toBe(true);
  }
  expect(openVault(vaultDir).entries).toEqual(entries);

  // A caller's source-level judgment is still necessary: the read itself merges nothing.
  await caps.people_import_csv.run({ ...csvInput, identity: decision("a") });
  await caps.people_import_csv.run({ ...second, identity: decision("b") });
  const after = JSON.parse(await caps.people_read.run({ contextId: "c1", viewId: "dinners", includeEvidence: true }));
  expect(after).toMatchObject({ ok: true, total: 3, orderRevision: 1 });
  expect(after.people.filter((person: { name: string }) => person.name === "Sam")).toHaveLength(2);
  const combined = after.people.find((person: { sourceCount: number }) => person.sourceCount === 2);
  expect(combined.anchors[0]).toMatchObject({ verified: true, adjudication: { rationale: decision("a").rationale } });
  const saved = readPeopleWorkspace(openVault(vaultDir), "c1", "dinners")!;
  expect(saved.notes[0]).toMatchObject({ noteId: "organizer-note", text: "Keep this guest near the top", state: "draft" });
  expect(saved.order[0]).toBe(order[0]);
});

it("rejects absent or foreign identity evidence before any import writes", async () => {
  const { caps, world, vaultDir, dive } = setup();
  await caps.people_select_sources.run(select);
  const before = readFileSync(join(vaultDir, "stream.jsonl"), "utf8");
  for (const identity of [
    { ...decision("a"), evidence: [] },
    { ...decision("a"), rationale: "" },
    { ...decision("a"), kind: "phone" },
    { ...decision("a"), evidence: [{ artifactId: "foreign-job" }] },
  ]) await expect(caps.people_import_csv.run({ ...csvInput, identity })).rejects.toThrow();
  dive.dive_read_observation = async () => ({ ok: false, note: "Not the current job observation" });
  await expect(caps.people_import_csv.run({ ...csvInput, identity: { ...decision("a"), evidence: [{ observationId: "foreign" }] } })).rejects.toThrow("observation");
  expect(readFileSync(join(vaultDir, "stream.jsonl"), "utf8")).toBe(before);
  expect(world.persons).toHaveLength(0);
});

it("keeps fallback row keys stable when verification is added and retains current observation evidence", async () => {
  const { caps, world } = setup();
  await caps.people_select_sources.run(select);
  const input = { ...csvInput, columns: { name: ["Full name"], email: "Email" } };
  await caps.people_import_csv.run(input);
  const before = projectPeopleView(world, "c1", "dinners")!;
  await caps.people_import_csv.run({ ...input, identity: { ...decision("a"), evidence: [{ observationId: "current" }] } });
  const after = projectPeopleView(world, "c1", "dinners")!;
  expect(after.people.map(p => p.personId)).toEqual(before.people.map(p => p.personId));
  expect(after.people.flatMap(p => p.memberships.map(m => m.rowId))).toEqual(before.people.flatMap(p => p.memberships.map(m => m.rowId)));
  expect(after.people.every(p => p.identity === "verified")).toBe(true);
  expect(after.people[0].anchors[0].adjudication?.evidence).toContain("observation:current");
});

it("reconciles earlier provisional sightings without rewriting ranks, notes or submitted wave history", async () => {
  const { caps, world, second, vaultDir } = await twoDinners();
  await caps.people_import_csv.run(csvInput);
  await caps.people_import_csv.run(second);
  const before = projectPeopleView(world, "c1", "dinners")!;
  const a = before.people.find(p => p.name === "Avery, A")!.personId;
  const b = before.people.find(p => p.name === "Avery Again")!.personId;
  const others = before.people.filter(p => p.personId !== a && p.personId !== b).map(p => p.personId);
  const scope = { contextId: "c1", viewId: "dinners" };
  let vault = openVault(vaultDir);
  savePeopleOrder(vault, { ...scope, personIds: [b, ...others, a], baseRevision: 0, requestId: "order" });
  savePeopleNote(vault, { ...scope, personId: a, noteId: "a-note", text: "A regular", state: "draft", baseRevision: 0, requestId: "a-note" });
  savePeopleNote(vault, { ...scope, personId: b, noteId: "b-note", text: "Met again", state: "draft", baseRevision: 0, requestId: "b-note" });
  const wave = submitPeopleNotes(vault, { ...scope, noteIds: ["b-note"], requestId: "wave" });
  const stream = readFileSync(join(vaultDir, "stream.jsonl"), "utf8");
  await caps.people_import_csv.run({ ...csvInput, identity: decision("a") });
  await caps.people_import_csv.run({ ...second, identity: decision("b") });
  vault = openVault(vaultDir);
  const saved = readPeopleWorkspace(vault, "c1", "dinners")!;
  expect(saved.people).toHaveLength(3);
  const survivor = saved.people.find(p => p.sourceCount === 2)!.personId;
  expect(saved.order).toEqual([survivor, ...others]);
  expect(saved.orderRevision).toBe(1);
  expect(saved.notes.map(n => n.personId)).toEqual([survivor, survivor]);
  expect(saved.notes.map(n => n.revision)).toEqual([1, 2]);
  const { replayed: _replayed, ...waveSnapshot } = wave;
  expect(saved.waves[0]).toEqual(waveSnapshot);
  expect(saved.waves[0].notes[0].personId).toBe(b);
  expect(readFileSync(join(vaultDir, "stream.jsonl"), "utf8").startsWith(stream)).toBe(true);
  const merge = vault.entries.find(e => e.type === "merged")!;
  expect(merge).toMatchObject({ context: "c1", subtype: "people-identity", payload: { how: "anchor", rationale: decision("b").rationale } });
  savePeopleNote(vault, { ...scope, personId: survivor, noteId: "reply", text: "Combined your notes", state: "resolved", replyTo: "b-note", waveId: wave.waveId, baseRevision: 0, requestId: "reply" });
  const count = vault.entries.length;
  await caps.people_import_csv.run({ ...second, identity: decision("b") });
  expect(openVault(vaultDir).entries).toHaveLength(count);
});

it("imports an exact owned CSV through a model-chosen header map, with retained evidence and no attendance invention", async () => {
  const { caps, world, vaultDir } = setup();
  await caps.people_select_sources.run(select);
  const result = JSON.parse(await caps.people_import_csv.run(csvInput));
  expect(result).toMatchObject({ ok: true, importedRows: 2, people: 2, coverage: { complete: true }, evidenceCategory: "guestlist_saved" });
  expect(caps.people_import_csv.evidenceCategories?.(csvInput, JSON.stringify(result))).toEqual(["guestlist_saved"]);
  const view = projectPeopleView(world, "c1", "dinners")!;
  expect(view.people.find(p => p.name === "Avery, A")).toMatchObject({ identity: "unresolved", anchors: [{ verified: false }], memberships: [{ rsvp: "Going" }] });
  expect(view.people[0].memberships[0].evidence.join(" ")).toContain("sha256:abc");
  expect(view.people[0].memberships[0]).not.toHaveProperty("attendance");
  const count = world.entries.length;
  await caps.people_import_csv.run(csvInput);
  expect(world.entries).toHaveLength(count);
  expect(projectPeopleView(openVault(vaultDir), "c1", "dinners")?.people).toHaveLength(2);
});

it("rejects missing artifact, invalid header or malformed row before any import writes", async () => {
  const { caps, world, artifacts, vaultDir } = setup();
  await caps.people_select_sources.run(select);
  const count = world.entries.length;
  expect(JSON.parse(await caps.people_import_csv.run({ ...csvInput, artifactId: "not-mine" })).ok).toBe(false);
  await expect(caps.people_import_csv.run({ ...csvInput, columns: { name: ["Imagined name"] } })).rejects.toThrow("column");
  artifacts.set("a", "ID,Full name,Email,Status\n1,Avery,a@example.test,Going\n2,,s@example.test,Invited\n");
  await expect(caps.people_import_csv.run(csvInput)).rejects.toThrow("name");
  expect(openVault(vaultDir).persons).toHaveLength(0);
  expect(world.entries).toHaveLength(count);
  expect(world.persons).toHaveLength(0);
});

it("uses event-scoped content keys without treating a name or CSV email as verified identity", async () => {
  const { caps, artifacts, world } = setup();
  artifacts.set("a", "Name,Email,RSVP\nSam,,Going\nSam,,Going\n");
  await caps.people_select_sources.run(select);
  const input = { ...csvInput, columns: { name: ["Name"], email: "Email", rsvp: "RSVP" } };
  await caps.people_import_csv.run(input);
  const first = projectPeopleView(world, "c1", "dinners")!;
  expect(first.people).toHaveLength(2);
  artifacts.set("a", "Name,Email,RSVP\nSam,,Invited\nSam,,Going\n");
  await caps.people_import_csv.run(input);
  const reread = projectPeopleView(world, "c1", "dinners")!;
  expect(reread.people.map(p => p.personId)).toEqual(first.people.map(p => p.personId));
});

it("maps exact CSV headers including significant spaces", async () => {
  const { caps, artifacts, world } = setup();
  artifacts.set("a", " Full name , Email \nAvery,a@example.test\n");
  await caps.people_select_sources.run(select);
  await caps.people_import_csv.run({ ...csvInput, columns: { name: [" Full name "], email: " Email " } });
  expect(projectPeopleView(world, "c1", "dinners")?.people[0].name).toBe("Avery");
});

it("reopens the vault after asynchronous artifact reads so concurrent local edits are preserved", async () => {
  const { caps, dive, world, vaultDir } = setup();
  await caps.people_select_sources.run(select);
  const original = dive.dive_read_artifact_text;
  dive.dive_read_artifact_text = async input => {
    registerContext(openVault(vaultDir), { id: "c2", name: "Added while reading", kind: "social", anchor: "email", created_at: "2026-09-01T00:00:00Z" });
    return original(input);
  };
  await caps.people_import_csv.run(csvInput);
  expect(world.contexts.map(c => c.id)).toEqual(["c1", "c2"]);
});

it("creates a World without inventing an upcoming event, and replays its request id", async () => {
  const { world, vaultDir } = setup();
  const hand = createPeopleWorldHand(vaultDir, world);
  const input = { name: "The garden", lane: "topical", anchor: "email", requestId: "create-garden" };
  const first = JSON.parse(await hand.run(input));
  const second = JSON.parse(await hand.run(input));
  expect(second.contextId).toBe(first.contextId);
  expect(world.contexts).toHaveLength(2);
  expect(world.gatherings).toHaveLength(0);
  await expect(hand.run({ ...input, name: "Different" })).rejects.toThrow("request");
});

it("withdraws an old saved-list receipt when the diver expands scope to an unread event", async () => {
  const { caps, artifacts } = setup();
  artifacts.set("b", "Name\nRiley\n");
  const store = createMemoryDiverJobStore();
  const dive = createDiver({ model: {} as never, trace: new Trace(), store, capabilities: caps,
    runModel: async ({ capabilities }) => {
      await capabilities.people_select_sources.run(select);
      await capabilities.people_import_csv.run(csvInput);
      await capabilities.people_select_sources.run({ ...select, sources: [...select.sources, { ...source, eventId: "b", name: "Dinner B", evidence: { artifactId: "b" } }] });
      return { text: JSON.stringify({ status: "complete", goalCategory: "guestlist_import", summary: "Found two source lists", evidence: ["a", "b"], evidenceCategories: ["guestlist_saved"] }), steps: 4, toolCalls: 3 };
    },
  });
  expect(JSON.parse(await dive({ intent: "Save the two dinner lists" })).status).toBe("partial");
  expect(store.load()?.hostEvidenceCategories).not.toContain("guestlist_saved");
});
