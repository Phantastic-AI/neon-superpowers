import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as append from "../vault/append.js";
import { openVault, registerContext, type Vault } from "../vault/store.js";
import { readPeopleWorkspace, savePeopleNote, savePeopleOrder, submitPeopleNotes } from "../vault/people-edits.js";
import { importPeopleSource, savePeopleProspect, selectPeopleSources, type SavePeopleProspectInput } from "./people.js";

const at = "2026-09-07T03:00:00Z";
const scope = { contextId: "W", viewId: "people" };
const source = { platform: "luma", accountId: "owner", eventId: "past", name: "Past dinner", date: at, url: "https://luma.com/past", evidence: ["artifact:past"] };
let dir: string, vault: Vault;
const bytes = () => ["stream.jsonl", "persons.json", "contexts.json", "gatherings.json"].map(file => readFileSync(join(dir, file), "utf8"));
const view = (viewId = "people") => readPeopleWorkspace(vault, "W", viewId)!;
const csvRow = (rowId: string, email?: string) => ({ rowId, name: rowId, evidence: ["artifact:past"], anchors: email ? [{ kind: "email" as const, value: email, verified: true, evidence: "artifact:past" }] : [] });
const ingest = (rows: ReturnType<typeof csvRow>[]) => importPeopleSource(vault, { ...scope, at, source, readState: "read", evidence: ["artifact:past"], rows });
function request(rowId = "one", email?: string): SavePeopleProspectInput {
  return { ...scope, at, requestId: `find-${rowId}`, rowId, name: "Avery", confidence: "confided",
    source: { platform: "linkedin", sourceId: "observed-search", label: "Actual search results" },
    evidence: ["artifact:profile"], anchors: email ? [{ kind: "email", value: email, verified: true, evidence: "artifact:profile" }] : [],
    reason: { text: "Invests in agent tools.", epistemics: "inferred", confidence: "confided", evidence: ["artifact:profile"] },
  };
}
const save = (input = request()) => savePeopleProspect(vault, input);
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "people-prospects-")); vault = openVault(dir);
  for (const id of ["W", "X"]) registerContext(vault, { id, name: id, kind: "professional", anchor: "email", created_at: at });
  for (const contextId of ["W", "X"]) for (const viewId of ["people", "other"]) selectPeopleSources(vault, { contextId, viewId, at, viewName: viewId, sources: [source], discoveryComplete: true });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe("prospects in the shared people list", () => {
  it.each(["csv-first", "prospect-first"])("retains identity and organizer edits through %s", order => {
    if (order === "csv-first") ingest([csvRow("past-one", "avery@example.test")]);
    else save(request("one", "avery@example.test"));
    const personId = view().people[0].personId;
    savePeopleOrder(vault, { ...scope, at, personIds: [personId], baseRevision: 0, requestId: "rank" });
    savePeopleNote(vault, { ...scope, at, personId, noteId: "note", text: "Put them near the top", state: "draft", baseRevision: 0, requestId: "note" });
    if (order === "csv-first") save(request("one", "avery@example.test"));
    else ingest([csvRow("past-one", "avery@example.test")]);
    vault = openVault(dir);
    expect(view()).toMatchObject({ order: [personId], orderRevision: 1, notes: [{ personId, text: "Put them near the top" }] });
    expect(view().people).toHaveLength(1);
    expect(view().people[0]).toMatchObject({ personId, sourceCount: 1, memberships: [{ rowId: "past-one" }], prospects: [{ reason: { text: "Invests in agent tools." } }] });
    expect(view().coverage).toMatchObject({ selected: 1, read: 1, complete: true });
    expect(vault.gatherings.every(item => !item.upcoming)).toBe(true);
  });

  it("stores list-only people in only the requested view without contact or attendance guesses", () => {
    const input = request(); input.source = { platform: "whatsapp", sourceId: "organizer-list", label: "People to consider" };
    const count = vault.gatherings.length;
    save(input); save({ ...request("two"), source: input.source });
    vault = openVault(dir);
    expect(view().people).toHaveLength(2);
    for (const person of view().people) {
      expect(person).toMatchObject({ identity: "unresolved", sourceCount: 0, memberships: [], anchors: [] });
      expect(person.prospects[0].accountId).toBeUndefined();
    }
    expect(view("other").people).toEqual([]);
    expect(readPeopleWorkspace(vault, "X", "people")!.people).toEqual([]);
    expect(vault.gatherings).toHaveLength(count);
    expect(vault.entries.filter(e => e.type === "fact").every(e => e.subtype === "sighting" && !e.about)).toBe(true);
  });

  it("withdraws canonical verification across views without losing local reasons or old request receipts", () => {
    const first = request("one", "avery@example.test"); save(first);
    const personId = view().people[0].personId;
    save({ ...first, viewId: "other", requestId: "withdraw", anchors: [], reason: { ...first.reason, text: "Need more evidence before prioritizing." } });
    for (const viewId of ["people", "other"]) expect(view(viewId).people[0]).toMatchObject({ personId, anchors: [], identity: "unresolved", prospects: [{ version: 2 }] });
    expect(view().people[0].prospects[0].reason.text).toBe(first.reason.text);
    expect(view("other").people[0].prospects[0].reason.text).toBe("Need more evidence before prioritizing.");
    const before = bytes(); save({ ...first, at: "2026-09-07T04:00:00Z" }); expect(bytes()).toEqual(before);
    ingest([csvRow("new", "avery@example.test")]);
    expect(view().people).toHaveLength(2);
    expect(view().people.find(p => p.memberships.length)?.personId).not.toBe(personId);
  });

  it("rejects changed retries and invalid evidence before any registry or stream writes", () => {
    const input = request(); save(input);
    const before = bytes();
    for (const invalid of [
      { ...input, name: "Changed retry" },
      { ...request("fresh"), viewId: "missing" },
      { ...request("fresh"), reason: { ...input.reason, evidence: ["artifact:foreign"] } },
      { ...request("fresh", "new@example.test"), confidence: "not-a-confidence" },
    ]) {
      expect(() => save(invalid as SavePeopleProspectInput)).toThrow(); expect(bytes()).toEqual(before);
    }
  });

  it("never chooses between established owners or lends a conflict's fresh anchors", () => {
    ingest([csvRow("one", "one@example.test"), csvRow("two", "two@example.test")]);
    const input = request("conflict", "one@example.test");
    input.anchors!.push({ kind: "email", value: "two@example.test", verified: true, evidence: "artifact:profile" }, { kind: "linkedin", value: "observed-profile", verified: true, evidence: "artifact:profile" });
    save(input);
    expect(view().people.find(p => p.prospects.length)?.identity).toBe("conflict");
    save({ ...request("fresh"), anchors: [{ kind: "linkedin", value: "observed-profile", verified: true, evidence: "artifact:profile" }] });
    expect(view().people).toHaveLength(4);
    expect(vault.entries.filter(e => e.type === "merged")).toEqual([]);
  });

  it("commits adjudicated aliases atomically, preserving edits and immutable submitted waves", () => {
    ingest([csvRow("past", "avery@example.test")]);
    const established = view().people[0].personId;
    const first = request(); save(first);
    const provisional = view().people.find(p => p.prospects.length)!.personId;
    const note = { ...scope, personId: provisional, noteId: "note", text: "Important guest", state: "draft" as const, baseRevision: 0, requestId: "note", at };
    savePeopleNote(vault, note);
    savePeopleOrder(vault, { ...scope, personIds: [provisional, established], baseRevision: 0, requestId: "rank", at });
    submitPeopleNotes(vault, { ...scope, noteIds: ["note"], requestId: "submit", at });
    const waveBefore = structuredClone(view().waves);
    const refine = request("one", "avery@example.test"); refine.requestId = "refine";
    refine.anchors![0].adjudication = { rationale: "The observed profile establishes this contact identity.", evidence: ["artifact:profile"] };
    const actual = append.appendEntry;
    vi.spyOn(append, "appendEntry").mockImplementation((target, entry) => {
      if (entry.payload.peopleProspect) throw new Error("interrupted finding commit");
      return actual(target, entry);
    });
    expect(() => save(refine)).toThrow(/interrupted/);
    expect(view().people).toHaveLength(2); expect(view().order).toEqual([provisional, established]);
    expect(vault.entries.filter(e => e.type === "merged")).toHaveLength(1);
    vi.restoreAllMocks(); vault = openVault(dir); save(refine);
    expect(view().people).toHaveLength(1); expect(view().order).toEqual([established]);
    expect(view().notes[0].personId).toBe(established); expect(view().waves).toEqual(waveBefore);
    expect(savePeopleNote(vault, note).replayed).toBe(true);
    expect(vault.entries.filter(e => e.type === "merged")).toHaveLength(1);
    save({ ...refine, requestId: "unverify", anchors: [] });
    expect(view().order).toEqual([established]); expect(view().waves).toEqual(waveBefore);
  });
});
