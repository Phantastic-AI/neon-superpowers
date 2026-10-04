import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEntry, type NewEntry } from "./append.js";
import { openVault, registerContext, registerPerson, type Vault } from "./store.js";
import { selectPeopleSources } from "../organs/people.js";

const at = "2026-09-06T10:00:00Z";
let dir: string;
let vault: Vault;
const bytes = () => ["stream.jsonl", "persons.json", "contexts.json", "gatherings.json"].map(file => readFileSync(join(dir, file), "utf8"));
function finding(): NewEntry {
  return {
    at, context: "W", type: "fact", subtype: "sighting", persons: ["p-one"],
    actor: { kind: "lois", ref: "lois" }, confidence: "confided", epistemics: "stated",
    evidence: "artifact:profile", payload: { peopleProspect: {
      viewId: "people", requestId: "find-one", rowId: "profile-one", name: "Avery",
      source: { platform: "linkedin", sourceId: "profile-one", label: "Observed profile", url: "https://www.linkedin.com/in/example" },
      anchors: [{ kind: "linkedin", value: "https://www.linkedin.com/in/example", verified: true, evidence: "artifact:profile" }],
      identity: "verified", version: 1, evidence: ["artifact:profile"],
      reason: { text: "Invests in agent tools; worth asking about the dinner.", epistemics: "inferred", confidence: "confided", evidence: ["artifact:profile"] },
    } },
  };
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prospect-append-"));
  vault = openVault(dir);
  for (const id of ["W", "X"]) registerContext(vault, { id, name: id, kind: "professional", anchor: "email", created_at: at });
  registerPerson(vault, { id: "p-one", name: "Avery", anchors: [], merged: [], sighted_at: at, state: "active" });
  for (const contextId of ["W", "X"]) for (const viewId of ["people", "other"]) selectPeopleSources(vault, {
    contextId, viewId, viewName: viewId, at,
    sources: [{ platform: "luma", accountId: "organizer", eventId: "past", name: "Past dinner", date: at, url: "https://luma.com/past", evidence: ["artifact:past"] }],
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("prospect finding append boundary", () => {
  it("files observed findings with a separate inferred reason and no fabricated Gathering", () => {
    const before = vault.gatherings.length;
    const result = appendEntry(vault, finding());
    expect(result.about).toBeUndefined();
    expect(result.confidence).toBe("confided");
    expect((result.payload.peopleProspect as any).reason.epistemics).toBe("inferred");
    expect(vault.gatherings).toHaveLength(before);
  });

  it.each([
    ["no selected view", (e: NewEntry) => { (e.payload.peopleProspect as any).viewId = "missing"; }],
    ["not a sighting", (e: NewEntry) => { e.subtype = "lookup"; }],
    ["fake attendance", (e: NewEntry) => { e.about = vault.gatherings[0].id; }],
    ["inference presented as observation", (e: NewEntry) => { (e.payload.peopleProspect as any).reason.epistemics = "stated"; }],
    ["missing reason", (e: NewEntry) => { delete (e.payload.peopleProspect as any).reason; }],
    ["foreign anchor evidence", (e: NewEntry) => { (e.payload.peopleProspect as any).anchors[0].evidence = "artifact:elsewhere"; }],
    ["foreign reason evidence", (e: NewEntry) => { (e.payload.peopleProspect as any).reason.evidence = ["artifact:elsewhere"]; }],
    ["missing source identity", (e: NewEntry) => { delete (e.payload.peopleProspect as any).source.sourceId; }],
    ["credentials in source URL", (e: NewEntry) => { (e.payload.peopleProspect as any).source.url = "https://user:password@example.test"; }],
    ["invalid first version", (e: NewEntry) => { (e.payload.peopleProspect as any).version = 2; }],
  ])("rejects %s without any vault mutation", (_label, change) => {
    const entry = finding();
    (change as (e: NewEntry) => void)(entry);
    const before = bytes();
    expect(() => appendEntry(vault, entry)).toThrow(/peopleProspect/);
    expect(bytes()).toEqual(before);
  });

  it.each(["World", "source"])("rejects a foreign %s supersession", scope => {
    const original = finding();
    if (scope === "World") original.context = "X";
    else (original.payload.peopleProspect as any).source.sourceId = "foreign";
    const saved = appendEntry(vault, original);
    const entry = finding();
    Object.assign(entry.payload.peopleProspect as object, { requestId: "update", version: 2 });
    entry.supersedes = saved.id;
    entry.refs = [saved.id];
    const before = bytes();
    expect(() => appendEntry(vault, entry)).toThrow(/peopleProspect/);
    expect(bytes()).toEqual(before);
  });

  it("keeps a source-row's observation chain canonical across views of the same World", () => {
    const first = appendEntry(vault, finding());
    const update = finding();
    Object.assign(update.payload.peopleProspect as object, { requestId: "other-view", viewId: "other", version: 2 });
    update.supersedes = first.id; update.refs = [first.id];
    expect(() => appendEntry(vault, update)).not.toThrow();
  });

  it("rejects a reused request and a stale version chain", () => {
    const first = appendEntry(vault, finding());
    const before = bytes();
    expect(() => appendEntry(vault, finding())).toThrow(/peopleProspect/);
    expect(bytes()).toEqual(before);
    const update = finding();
    Object.assign(update.payload.peopleProspect as object, { requestId: "update", version: 2 });
    update.supersedes = first.id; update.refs = [first.id];
    appendEntry(vault, update);
    const stale = structuredClone(update);
    (stale.payload.peopleProspect as any).requestId = "stale-update";
    const committed = bytes();
    expect(() => appendEntry(vault, stale)).toThrow(/peopleProspect/);
    expect(bytes()).toEqual(committed);
  });

  it("cannot move a superseding finding to another Person without an identity decision", () => {
    registerPerson(vault, { id: "unrelated", name: "Someone else", anchors: [], merged: [], sighted_at: at, state: "active" });
    const first = appendEntry(vault, finding());
    const next = finding();
    next.persons = ["unrelated"];
    next.supersedes = first.id;
    next.refs = [first.id];
    Object.assign(next.payload.peopleProspect as object, { requestId: "moved", version: 2 });
    const before = bytes();
    expect(() => appendEntry(vault, next)).toThrow(/peopleProspect/);
    expect(bytes()).toEqual(before);
  });

  it("does not change unrelated fact/sighting vocabulary", () => {
    const entry = finding();
    entry.payload = { text: "Observed a conversation." };
    expect(() => appendEntry(vault, entry)).not.toThrow();
  });

  it.each(["valid", "unverified", "unrelated retirement", "unrelated survivor", "established retirement", "foreign evidence", "different primary anchor", "no adjudication"])("checks the committed merge against its finding: %s", scenario => {
    for (const id of ["p-provisional", "p-other"]) registerPerson(vault, { id, name: id, anchors: [], merged: [], sighted_at: at, state: "active" });
    const prior = finding();
    prior.persons = ["p-provisional"];
    Object.assign(prior.payload.peopleProspect as object, { anchors: [], identity: "unresolved" });
    if (scenario === "established retirement") Object.assign(prior.payload.peopleProspect as object, {
      anchors: [{ kind: "email", value: "prior@example.test", verified: true, evidence: "artifact:profile" }], identity: "verified",
    });
    const saved = appendEntry(vault, prior);
    // A separately committed observation establishes the current anchor owner.
    const owner = finding();
    Object.assign(owner.payload.peopleProspect as object, { rowId: "owner", requestId: "owner" });
    appendEntry(vault, owner);
    const next = finding();
    const p = next.payload.peopleProspect as any;
    Object.assign(p, { requestId: "merge", version: 2 });
    p.anchors[0].adjudication = { rationale: "Same observed profile", evidence: ["artifact:profile"] };
    const anchor = structuredClone(p.anchors[0]);
    const decision: NewEntry = {
      at, context: "W", type: "merged", subtype: "people-identity", actor: next.actor,
      persons: ["p-one"], evidence: "artifact:profile", payload: {
        how: "anchor", fromPersonIds: ["p-provisional"], anchor, anchors: [anchor],
        rationale: "Same observed profile", evidence: ["artifact:profile"],
        peopleSource: { ...p.source, viewId: p.viewId, rowId: p.rowId },
      },
    };
    if (scenario === "unverified") { anchor.verified = false; delete anchor.adjudication; p.anchors = []; p.identity = "unresolved"; }
    if (scenario === "unrelated retirement") decision.payload.fromPersonIds = ["p-other"];
    if (scenario === "unrelated survivor") { decision.persons = ["p-other"]; next.persons = ["p-other"]; }
    if (scenario === "foreign evidence") decision.payload.evidence = ["artifact:foreign"];
    if (scenario === "different primary anchor") decision.payload.anchor = { ...anchor, value: "https://www.linkedin.com/in/different" };
    if (scenario === "no adjudication") { delete anchor.adjudication; delete p.anchors[0].adjudication; }
    const merged = appendEntry(vault, decision);
    next.supersedes = saved.id; next.refs = [merged.id, saved.id]; p.identityMergeIds = [merged.id];
    const before = bytes();
    if (scenario === "valid") expect(() => appendEntry(vault, next)).not.toThrow();
    else {
      expect(() => appendEntry(vault, next)).toThrow(/peopleProspect/);
      expect(bytes()).toEqual(before);
    }
  });
});
