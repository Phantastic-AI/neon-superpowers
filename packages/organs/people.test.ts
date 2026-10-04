import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as append from "../vault/append.js";
import { openVault, registerContext, registerPerson, type Vault } from "../vault/store.js";
import { importPeopleSource, selectPeopleSources } from "./people.js";
import { projectPeopleView, type PeopleSourceRow, type PeopleSourceSelection } from "../../tools/projections/people.js";

let dir: string;
let vault: Vault;
const at = "2026-09-05T12:00:00Z";
const source = (eventId: string): PeopleSourceSelection => ({ platform: "luma", accountId: "owner", eventId, name: `Dinner ${eventId}`, date: "2026-08-01T18:00:00Z", url: `https://luma.com/${eventId}`, evidence: [`artifact:${eventId}`] });
const row = (rowId: string, name: string, email?: string): PeopleSourceRow => ({ rowId, name, evidence: ["artifact:row"], anchors: email ? [{ kind: "email", value: email, verified: true, evidence: "artifact:row" }] : [] });
const select = (ids = ["A", "B", "C"], contextId = "W", viewId = "past-dinners") => selectPeopleSources(vault, { contextId, viewId, viewName: "Past dinner people", sources: ids.map(source), discoveryComplete: true, at });
const ingest = (eventId: string, rows: PeopleSourceRow[], readState: "read" | "partial" | "failed" = "read", contextId = "W", viewId = "past-dinners") => importPeopleSource(vault, { contextId, viewId, source: source(eventId), rows, readState, evidence: [`artifact:${eventId}`], at });
const view = () => projectPeopleView(vault, "W", "past-dinners")!;
const bytes = () => ["stream.jsonl", "persons.json", "contexts.json", "gatherings.json"].map((file) => readFileSync(join(dir, file), "utf8"));
const adjudicated = (rowId: string, name: string, email: string): PeopleSourceRow => ({ ...row(rowId, name, email), anchors: row(rowId, name, email).anchors!.map(anchor => ({ ...anchor, adjudication: { rationale: "Observed source establishes this registered identity", evidence: ["artifact:row"] } })) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "people-engine-"));
  vault = openVault(dir);
  for (const id of ["W", "X"]) registerContext(vault, { id, name: id, kind: "social", anchor: "email", created_at: at });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe("source-backed people import", () => {
  it("reconciles multiple previously provisional rows on adjudicated anchors, independently of input order", () => {
    select(["A"]);
    ingest("A", [row("a", "First sighting"), row("b", "Second sighting")]);
    const original = view().people.map(person => person.personId);
    const before = bytes();
    ingest("A", [adjudicated("b", "Second sighting", "a@example.test"), adjudicated("a", "First sighting", "a@example.test")]);
    expect(view().people).toHaveLength(1);
    expect(view().people[0]).toMatchObject({ personId: [...original].sort()[0], identity: "verified" });
    expect(view().people[0].memberships).toHaveLength(2);
    expect(bytes()[0].startsWith(before[0])).toBe(true);
    expect(bytes().slice(1)).toEqual(before.slice(1));
  });

  it("does not turn a model's new evidence into a guess between two established identities", () => {
    select(["A", "B"]);
    ingest("A", [row("a", "Avery", "a@example.test")]);
    ingest("B", [row("b", "Blair", "b@example.test")]);
    ingest("B", [adjudicated("b", "Blair", "a@example.test")]);
    expect(view().people).toHaveLength(2);
    expect(view().people.find(person => person.name === "Blair")?.identity).toBe("conflict");
    expect(vault.entries.filter(entry => entry.type === "merged")).toEqual([]);
  });

  it("rejects an adjudication with foreign retained evidence before registry or stream writes", () => {
    select(["A"]);
    const prior = bytes();
    const bad = adjudicated("a", "Avery", "a@example.test");
    bad.anchors![0].adjudication!.evidence = ["artifact:foreign"];
    expect(() => ingest("A", [bad])).toThrow(/retained evidence/);
    expect(bytes()).toEqual(prior);
  });

  it("keeps identity aliases inside their World and never mutates the shared Person registry", () => {
    select(["A", "B"]);
    ingest("A", [row("a", "Avery")]);
    ingest("B", [row("b", "Avery again")]);
    select(["A", "B"], "X");
    ingest("A", [row("a", "Other World A")], "read", "X");
    ingest("B", [row("b", "Other World B")], "read", "X");
    const other = projectPeopleView(vault, "X", "past-dinners")!.people;
    const registry = readFileSync(join(dir, "persons.json"), "utf8");
    ingest("A", [adjudicated("a", "Avery", "a@example.test")]);
    ingest("B", [adjudicated("b", "Avery again", "a@example.test")]);
    expect(view().people).toHaveLength(1);
    expect(projectPeopleView(vault, "X", "past-dinners")!.people).toEqual(other);
    expect(readFileSync(join(dir, "persons.json"), "utf8")).toEqual(registry);
  });

  it("publishes reconciliation only with the source commit and safely reuses interrupted merge entries", () => {
    select(["A", "B"]);
    ingest("A", [row("a", "Avery")]);
    ingest("B", [row("b", "Avery again")]);
    ingest("A", [adjudicated("a", "Avery", "a@example.test")]);
    const before = view();
    const actualAppend = append.appendEntry;
    const spy = vi.spyOn(append, "appendEntry").mockImplementation((target, entry) => {
      if (entry.type === "listing") throw new Error("simulated source commit interruption");
      return actualAppend(target, entry);
    });
    expect(() => ingest("B", [adjudicated("b", "Avery again", "a@example.test")])).toThrow(/interruption/);
    expect(view().people).toEqual(before.people);
    expect(vault.entries.filter(entry => entry.type === "merged")).toHaveLength(1);
    spy.mockRestore();
    vault = openVault(dir);
    ingest("B", [adjudicated("b", "Avery again", "a@example.test")]);
    expect(view().people).toHaveLength(1);
    expect(vault.entries.filter(entry => entry.type === "merged")).toHaveLength(1);
    expect(projectPeopleView(vault, "W", "past-dinners", before.cursor)!.people).toEqual(before.people);
  });

  it("combines independent A/B/C oracle without an upcoming event, name merge or invented attendance", () => {
    select();
    ingest("A", [row("a", "Avery", "a@example.test"), row("sam", "Sam", "s1@example.test"), row("t", "Taylor")]);
    ingest("B", [row("a2", "Avery", "a@example.test"), row("sam", "Sam", "s2@example.test"), row("r", "Riley", "r@example.test")]);
    select(["D"], "W", "other-dinners");
    ingest("D", [row("other", "Other")], "read", "W", "other-dinners");
    select(["A"], "X");
    ingest("A", [row("x", "Foreign Avery", "a@example.test")], "read", "X");
    const result = view();
    expect(result.people).toHaveLength(5);
    expect(result.people.reduce((sum, person) => sum + person.memberships.length, 0)).toBe(6);
    expect(result.people.filter((person) => person.name === "Sam")).toHaveLength(2);
    expect(result.people.find((person) => person.name === "Avery")?.sourceCount).toBe(2);
    expect(result.people.find((person) => person.name === "Taylor")?.identity).toBe("unresolved");
    expect(result.people.flatMap((person) => person.memberships).every((membership) => membership.attendance === undefined)).toBe(true);
    expect(result.coverage).toEqual({ selected: 3, unread: 1, partial: 0, read: 2, failed: 0, discoveryComplete: true, complete: false });
    expect(vault.gatherings.every((event) => !event.upcoming)).toBe(true);
    expect(projectPeopleView(openVault(dir), "W", "past-dinners")).toEqual(result);
  });

  it("rereads and duplicate exports cannot inflate source or person counts", () => {
    select(["A"]);
    ingest("A", [row("a", "Avery", "a@example.test")]);
    const saved = bytes();
    select(["A"]);
    ingest("A", [row("a", "Avery", "a@example.test")]);
    expect(bytes()).toEqual(saved);
    const id = view().people[0].personId;
    ingest("A", [{ ...row("a", "Avery Updated", "a@example.test"), rsvp: "going" }]);
    expect(view().people).toHaveLength(1);
    expect(view().people[0]).toMatchObject({ personId: id, name: "Avery Updated", sourceCount: 1 });
    expect(view().people[0].memberships[0]).toMatchObject({ version: 2, rsvp: "going" });
    expect(vault.entries.filter((entry) => entry.type === "imported")).toHaveLength(2);
    expect(vault.entries.find((entry) => entry.type === "imported")?.payload.name).toBe("Avery");
  });

  it("partial reads accumulate rows; a complete read replaces membership; failure preserves useful prior rows", () => {
    select(["A"]);
    ingest("A", [row("a", "Avery")], "partial");
    ingest("A", [row("b", "Blair")], "partial");
    expect(view().people).toHaveLength(2);
    expect(view().coverage.partial).toBe(1);
    ingest("A", [], "failed");
    expect(view().people).toHaveLength(2);
    expect(view().coverage.failed).toBe(1);
    ingest("A", [row("a", "Avery")]);
    expect(view().people.map((person) => person.name)).toEqual(["Avery"]);
    expect(view().coverage.complete).toBe(true);
    ingest("A", []);
    expect(view().people).toEqual([]);
    expect(view().sources[0].rowCount).toBe(0);
  });

  it("never merges event-local row IDs or unverified anchors across events", () => {
    select(["A", "B"]);
    const guest = { ...row("same-id", "Same Name"), anchors: [{ kind: "email" as const, value: "same@example.test", verified: false }] };
    ingest("A", [guest]);
    ingest("B", [guest]);
    expect(view().people).toHaveLength(2);
    expect(view().people.every((person) => person.identity === "unresolved")).toBe(true);
  });

  it("reuses a verified identity despite name changes while keeping observed names in source history", () => {
    select(["A", "B"]);
    ingest("A", [row("a", "Avery", "AVERY@example.test")]);
    ingest("B", [row("b", "Avery Renamed", "avery@example.test")]);
    expect(view().people).toHaveLength(1);
    expect(view().people[0].sourceCount).toBe(2);
    expect(vault.entries.filter((entry) => entry.type === "imported").map((entry) => entry.payload.name)).toEqual(["Avery", "Avery Renamed"]);
  });

  it("finishes a source commit on retry without duplicating already appended rows or people", () => {
    select(["A"]);
    const actualAppend = append.appendEntry;
    const spy = vi.spyOn(append, "appendEntry").mockImplementation((target, entry) => {
      if (entry.type === "listing") throw new Error("simulated disk interruption");
      return actualAppend(target, entry);
    });
    expect(() => ingest("A", [row("a", "Avery", "a@example.test")])).toThrow(/interruption/);
    expect(view().people).toEqual([]);
    expect(view().coverage.read).toBe(0);
    expect(vault.persons).toHaveLength(1);
    spy.mockRestore();
    vault = openVault(dir);
    ingest("A", [row("a", "Avery", "a@example.test")]);
    expect(view().people).toHaveLength(1);
    expect(view().coverage.read).toBe(1);
    expect(vault.persons).toHaveLength(1);
    expect(vault.entries.filter((entry) => entry.type === "imported")).toHaveLength(1);
  });

  it("keeps a newly verified but conflicting provisional identity visible for resolution", () => {
    select(["A", "B"]);
    ingest("A", [row("a", "Avery")]);
    ingest("B", [row("b", "Known Avery", "a@example.test")]);
    const provisional = view().people.find((person) => person.name === "Avery")!.personId;
    ingest("A", [row("a", "Avery", "a@example.test")]);
    expect(view().people).toHaveLength(2);
    expect(view().people.find((person) => person.personId === provisional)?.identity).toBe("conflict");
  });

  it("shares canonical source reads across views without stale selection or partial-read loss", () => {
    select(["A"], "W", "one");
    select(["A"], "W", "two");
    ingest("A", [row("a", "Avery"), row("b", "Blair")], "read", "W", "one");
    expect(projectPeopleView(vault, "W", "two")?.people.map((person) => person.name)).toEqual(["Avery", "Blair"]);
    ingest("A", [row("a", "Avery")], "partial", "W", "two");
    select(["A"], "W", "one");
    for (const viewId of ["one", "two"]) {
      expect(projectPeopleView(vault, "W", viewId)?.people.map((person) => person.name)).toEqual(["Avery", "Blair"]);
      expect(projectPeopleView(vault, "W", viewId)?.coverage).toMatchObject({ partial: 1, read: 0 });
    }
    ingest("A", [row("b", "Blair")], "read", "W", "two");
    expect(projectPeopleView(openVault(dir), "W", "one")?.people.map((person) => person.name)).toEqual(["Blair"]);
  });

  it.each(["imported", "listing"])("does not use uncommitted source identity after interruption at %s", (failedType) => {
    select(["C", "D"]);
    const actualAppend = append.appendEntry;
    const spy = vi.spyOn(append, "appendEntry").mockImplementation((target, entry) => {
      if (entry.type === failedType) throw new Error("simulated disk interruption");
      return actualAppend(target, entry);
    });
    expect(() => ingest("C", [row("c", "Ghost", "a@example.test")])).toThrow(/interruption/);
    const ghostId = vault.persons[0].id;
    spy.mockRestore();
    vault = openVault(dir);
    ingest("D", [row("d", "Real", "a@example.test")]);
    expect(view().people).toHaveLength(1);
    expect(view().people[0].personId).not.toBe(ghostId);
  });

  it("reconciles a never-visible orphan with a committed identity established before its retry", () => {
    select(["A", "B"]);
    const actualAppend = append.appendEntry;
    const spy = vi.spyOn(append, "appendEntry").mockImplementation((target, entry) => {
      if (entry.type === "listing") throw new Error("simulated disk interruption");
      return actualAppend(target, entry);
    });
    expect(() => ingest("A", [row("a", "Avery", "a@example.test")])).toThrow(/interruption/);
    const orphanRow = vault.entries.find((entry) => entry.type === "imported")!;
    spy.mockRestore();
    vault = openVault(dir);
    ingest("B", [row("b", "Avery", "a@example.test")]);
    const committedPerson = view().people[0].personId;
    ingest("A", [row("a", "Avery", "a@example.test")]);
    expect(view().people).toHaveLength(1);
    expect(view().people[0]).toMatchObject({ personId: committedPerson, identity: "verified", sourceCount: 2 });
    const recovered = vault.entries.filter((entry) => entry.type === "imported" && entry.payload.rowId === "a").at(-1)!;
    expect(recovered.id).not.toBe(orphanRow.id);
    expect(recovered.supersedes).toBe(orphanRow.id);
    expect(recovered.persons).toEqual([committedPerson]);
  });

  it("uses current committed anchor verification, not stale importer registry copies", () => {
    select(["A", "B", "C"]);
    ingest("A", [row("a", "Avery", "old@example.test")]);
    const a = view().people[0].personId;
    ingest("A", [row("a", "Avery", "new@example.test")]);
    ingest("B", [row("b", "Another", "old@example.test")]);
    expect(view().people).toHaveLength(2);
    expect(view().people.find((person) => person.name === "Another")?.personId).not.toBe(a);
    ingest("A", [{ ...row("a", "Avery"), anchors: [{ kind: "email", value: "new@example.test", verified: false }] }]);
    ingest("C", [row("c", "Third", "new@example.test")]);
    expect(view().people).toHaveLength(3);
  });

  it.each(["partial", "read"] as const)("withdraws replaced verification before reconciling other rows in the same %s import", (readState) => {
    select(["A"]);
    ingest("A", [row("a", "Avery", "x@example.test")]);
    const original = view().people[0].personId;
    ingest("A", [{ ...row("a", "Avery"), anchors: [{ kind: "email", value: "x@example.test", verified: false }] }, row("b", "Different", "x@example.test")], readState);
    expect(view().people).toHaveLength(2);
    expect(view().people.find((person) => person.name === "Avery")?.personId).toBe(original);
    expect(view().people.find((person) => person.name === "Different")?.personId).not.toBe(original);
  });

  it.each([true, false])("uses current known row identity independent of row order (new first: %s)", (newFirst) => {
    select(["A"]);
    ingest("A", [row("a", "Avery", "x@example.test")]);
    const original = view().people[0].personId;
    const currentRows = [row("a", "Avery", "x@example.test"), row("b", "Same Avery", "x@example.test")];
    ingest("A", newFirst ? [...currentRows].reverse() : currentRows);
    expect(view().people).toHaveLength(1);
    expect(view().people[0]).toMatchObject({ personId: original, identity: "verified" });
    expect(view().people[0].memberships).toHaveLength(2);
  });

  it.each([true, false])("a conflicting known row never lends its other anchors to new rows (new first: %s)", (newFirst) => {
    select(["A", "B"]);
    ingest("A", [row("a", "Unresolved Avery")]);
    ingest("B", [row("b", "Known Blair", "x@example.test")]);
    const makeAnchors = (...values: string[]) => values.map((value) => ({ kind: "email" as const, value, verified: true, evidence: "artifact:row" }));
    const incoming = [
      { ...row("a", "Unresolved Avery"), anchors: makeAnchors("x@example.test", "y@example.test") },
      row("c", "New Casey", "y@example.test"),
    ];
    ingest("A", newFirst ? [...incoming].reverse() : incoming);
    expect(view().people).toHaveLength(3);
    expect(view().people.find((person) => person.name === "Unresolved Avery")).toMatchObject({ identity: "conflict", memberships: [expect.objectContaining({ rowId: "a" })] });
    expect(view().people.find((person) => person.name === "New Casey")).toMatchObject({ identity: "verified", memberships: [expect.objectContaining({ rowId: "c" })] });
  });

  it("classifies conflicting incoming known-row chains before admitting any candidate anchors", () => {
    select(["A"]);
    ingest("A", [row("a", "Avery"), row("b", "Blair"), row("c", "Casey")]);
    const anchorRow = (id: string, name: string, values: string[]) => ({ ...row(id, name), anchors: values.map((value) => ({ kind: "email" as const, value, verified: true, evidence: "artifact:row" })) });
    ingest("A", [anchorRow("a", "Avery", ["x@example.test", "y@example.test"]), anchorRow("b", "Blair", ["y@example.test", "z@example.test"]), anchorRow("c", "Casey", ["z@example.test"]), row("d", "Dee", "x@example.test")]);
    expect(view().people).toHaveLength(4);
    expect(view().people.filter((person) => person.identity === "conflict").map((person) => person.name).sort()).toEqual(["Avery", "Blair", "Casey"]);
    expect(view().people.find((person) => person.name === "Dee")?.identity).toBe("verified");
  });

  it("resolves a fresh connected verified-anchor component identically in every row order", () => {
    const a = row("a", "Avery", "x@example.test");
    const b = { ...row("b", "Avery Phone"), anchors: [{ kind: "phone" as const, value: "+15550000002", verified: true, evidence: "artifact:row" }] };
    const c = { ...row("c", "Avery Both"), anchors: [...a.anchors!, ...b.anchors] };
    const orders = [[a, b, c], [c, a, b], [b, c, a], [a, c, b], [b, a, c], [c, b, a]];
    const personIds: string[] = [];
    for (const [index, rows] of orders.entries()) {
      vault = openVault(join(dir, `order-${index}`));
      registerContext(vault, { id: "W", name: "World", kind: "social", anchor: "email", created_at: at });
      select(["A"]);
      ingest("A", rows);
      expect(view().people).toHaveLength(1);
      expect(view().people[0].identity).toBe("verified");
      expect(view().people[0].memberships).toHaveLength(3);
      personIds.push(view().people[0].personId);
    }
    expect(new Set(personIds).size).toBe(1);
  });

  it("retains independently verified registry anchors on preexisting people", () => {
    registerPerson(vault, { id: "preexisting-person", name: "Known before import", anchors: [{ kind: "email", value: "known@example.test", verified: true, context: "W" }], merged: [], sighted_at: at, state: "active" });
    select(["A", "B"]);
    ingest("A", [{ ...row("a", "Known"), anchors: [{ kind: "email", value: "known@example.test", verified: false }] }]);
    ingest("B", [row("b", "Known", "known@example.test")]);
    expect(view().people.find((person) => person.memberships.some((membership) => membership.eventId === "B"))?.personId).toBe("preexisting-person");
  });

  it("flags conflicting verified anchors instead of choosing one existing person", () => {
    select(["A", "B"]);
    ingest("A", [row("a", "Avery", "a@example.test"), { ...row("b", "Blair"), anchors: [{ kind: "phone", value: "+15550000001", verified: true, evidence: "artifact:row" }] }]);
    ingest("B", [{ ...row("conflict", "Unknown"), anchors: [{ kind: "email", value: "a@example.test", verified: true, evidence: "artifact:row" }, { kind: "phone", value: "+15550000001", verified: true, evidence: "artifact:row" }] }]);
    expect(view().people).toHaveLength(3);
    expect(view().people.find((person) => person.name === "Unknown")?.identity).toBe("conflict");
  });

  it("keeps exact scope after reselection without erasing historical imports", () => {
    select(["A", "B"]);
    ingest("A", [row("a", "Avery")]);
    ingest("B", [row("b", "Blair")]);
    select(["A"]);
    expect(view().people.map((person) => person.name)).toEqual(["Avery"]);
    select(["A", "B"]);
    expect(view().people).toHaveLength(2);
    expect(view().coverage.read).toBe(2);
  });

  it("validates the entire selection and import before any persisted mutation", () => {
    const saved = bytes();
    expect(() => selectPeopleSources(vault, { contextId: "W", viewId: "bad", viewName: "Bad", sources: [source("A"), { ...source("B"), date: "2026-02-30" }], at })).toThrow(/date/i);
    expect(bytes()).toEqual(saved);
    select(["A"]);
    const selected = bytes();
    for (const rows of [
      [row("valid", "Valid"), { ...row("invalid", "Invalid"), name: "" }],
      [row("duplicate", "First"), row("duplicate", "Second")],
      [{ ...row("anchor", "Invalid anchor"), anchors: [{ kind: "email" as const, value: "a@example.test", verified: true }] }],
    ]) {
      expect(() => ingest("A", rows)).toThrow();
      expect(bytes()).toEqual(selected);
    }
    expect(() => ingest("unselected", [row("a", "Avery")])).toThrow(/selected/i);
    expect(bytes()).toEqual(selected);
  });

  it("refuses unknown or apps-never-read Worlds and leaves discovery completeness honest", () => {
    registerContext(vault, { id: "system", name: "System", kind: "system", anchor: "email", apps_never_read: true, created_at: at });
    expect(() => select(["A"], "system")).toThrow(/World/i);
    expect(() => select(["A"], "missing")).toThrow(/World/i);
    selectPeopleSources(vault, { contextId: "W", viewId: "past-dinners", viewName: "Past dinners", sources: [source("A")], at });
    ingest("A", [row("a", "Avery")]);
    expect(view().coverage).toMatchObject({ selected: 1, read: 1, discoveryComplete: false, complete: false });
  });
});
