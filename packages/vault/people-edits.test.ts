import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEntry } from "./append.js";
import { openVault, registerContext, registerGathering, registerPerson, type Vault } from "./store.js";
import { loadWorld } from "./world.js";
import { finishPeopleNotes, readPeopleWorkspace, savePeopleNote, savePeopleOrder, submitPeopleNotes } from "./people-edits.js";

const roots: string[] = [];
const at = "2026-09-05T12:00:00Z";
const scope = { contextId: "W", viewId: "3cs" };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function addSource(vault: Vault, eventId: string, people: Array<[string, string]>, context = "W", viewId = "3cs") {
  if (!vault.gatheringById.has(eventId)) registerGathering(vault, { id: eventId, context, name: eventId, date: at, upcoming: false });
  const peopleSource = { platform: "luma", accountId: "owner", eventId };
  const rows = people.map(([id, name], index) => {
    if (!vault.personById.has(id)) registerPerson(vault, { id, name, anchors: [], merged: [], sighted_at: at, state: "active" });
    return appendEntry(vault, { at, context, type: "imported", subtype: "guest", actor: { kind: "app", ref: "import" }, persons: [id], about: eventId, source: `artifact:${eventId}`, payload: { peopleSource, rowId: String(index), name, anchors: [], identity: "unresolved", version: 1, evidence: [`artifact:${eventId}`] } }).id;
  });
  const payload = { ...peopleSource, name: eventId, date: at, url: `https://luma.com/${eventId}`, evidence: [`artifact:${eventId}`], gathering: eventId, viewId, viewName: "3Cs people", selected: true, discoveryComplete: false };
  appendEntry(vault, { at, context, type: "listing", subtype: "people-source", actor: { kind: "app", ref: "import" }, about: eventId, payload: { ...payload, operation: "selection", readState: "unread", rowCount: 0, rowEntryIds: [] } });
  appendEntry(vault, { at, context, type: "listing", subtype: "people-source", actor: { kind: "app", ref: "import" }, about: eventId, payload: { ...payload, operation: "read", readState: "read", rowCount: rows.length, rowEntryIds: rows } });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "people-edits-")); roots.push(root);
  const vault = openVault(root);
  for (const id of ["W", "X"]) registerContext(vault, { id, name: id, kind: "social", anchor: "email", created_at: at });
  addSource(vault, "A", [["avery", "Avery"], ["sam1", "Sam"], ["sam2", "Sam"]]);
  addSource(vault, "X-event", [["foreign", "Foreign"]], "X");
  return vault;
}
const workspace = (vault: Vault) => readPeopleWorkspace(loadWorld(vault), "W", "3cs")!;
const note = (extra = {}) => ({ ...scope, noteId: "note-one", personId: "sam1", text: "Move above Avery", state: "draft" as const, baseRevision: 0, requestId: "note-save", at, ...extra });

describe("durable people organizer edits", () => {
  it("accepts older aliased edit targets and retries without rewriting immutable request payloads", () => {
    const vault = fixture();
    const original = note();
    const saved = savePeopleNote(vault, original);
    const merge = appendEntry(vault, { at, context: "W", type: "merged", subtype: "people-identity", actor: { kind: "lois", ref: "diver" }, persons: ["sam2"], payload: { how: "anchor", fromPersonIds: ["sam1"], anchor: { kind: "email", value: "same@example.test" } } });
    const read = vault.entries.find(entry => entry.context === "W" && entry.payload.operation === "read")!;
    appendEntry(vault, { at, context: "W", type: "listing", subtype: "people-source", about: read.about, actor: { kind: "lois", ref: "diver" }, payload: { ...read.payload, identityMergeIds: [merge.id] } });
    expect(savePeopleNote(vault, original)).toEqual({ ...saved, replayed: true });
    const update = note({ text: "Updated after reconciliation", baseRevision: 1, requestId: "after-merge" });
    savePeopleNote(vault, update);
    savePeopleOrder(vault, { ...scope, personIds: ["sam1", "avery", "sam2"], baseRevision: 0, requestId: "old-tab-order" });
    expect(workspace(openVault(vault.dir))).toMatchObject({ order: ["sam2", "avery"], notes: [{ personId: "sam2", text: update.text, revision: 2 }] });
    expect(vault.entries.find(entry => entry.id === saved.entryId)!.payload.personId).toBe("sam1");
    expect(() => savePeopleNote(vault, note({ personId: "foreign", baseRevision: 2, requestId: "foreign-after-merge" }))).toThrow(/member/);
  });

  it("reconstructs saved manual order after reopening the same vault", () => {
    const vault = fixture();
    expect(workspace(vault).orderRevision).toBe(0);
    savePeopleOrder(vault, { ...scope, personIds: ["sam2", "avery", "sam1"], baseRevision: 0, requestId: "rank", at });
    expect(workspace(openVault(vault.dir))).toMatchObject({ order: ["sam2", "avery", "sam1"], orderRevision: 1 });
  });

  it("appends newly imported people after manual order and undo is another append", () => {
    const vault = fixture(); const initial = workspace(vault).order;
    savePeopleOrder(vault, { ...scope, personIds: ["sam2", "avery", "sam1"], baseRevision: 0, requestId: "rank" });
    addSource(vault, "B", [["morgan", "Morgan"], ["avery", "Avery"]]);
    expect(workspace(vault).order).toEqual(["sam2", "avery", "sam1", "morgan"]);
    const before = readFileSync(join(vault.dir, "stream.jsonl"), "utf8");
    savePeopleOrder(vault, { ...scope, personIds: initial, baseRevision: 1, requestId: "undo" });
    expect(workspace(vault).order).toEqual([...initial, "morgan"]);
    expect(readFileSync(join(vault.dir, "stream.jsonl"), "utf8").startsWith(before)).toBe(true);
  });

  it("replays identical requests even after newer revisions but rejects changed request payloads", () => {
    const vault = fixture(); const request = { ...scope, personIds: ["sam2", "avery", "sam1"], baseRevision: 0, requestId: "rank" };
    const first = savePeopleOrder(vault, request);
    savePeopleOrder(vault, { ...request, personIds: ["sam1", "avery", "sam2"], baseRevision: 1, requestId: "rank-two" });
    const length = vault.entries.length;
    expect(savePeopleOrder(vault, request)).toEqual({ ...first, replayed: true });
    expect(vault.entries).toHaveLength(length);
    expect(() => savePeopleOrder(vault, { ...request, personIds: ["avery", "sam1", "sam2"] })).toThrow(/request.*different/i);
  });

  it("rejects stale, duplicate, empty and foreign ranking without changing the stream", () => {
    const vault = fixture(); const initial = vault.entries.length;
    for (const personIds of [[], ["sam1", "sam1"], ["foreign"], ["missing"]]) {
      expect(() => savePeopleOrder(vault, { ...scope, personIds, baseRevision: 0, requestId: "invalid" })).toThrow();
    }
    expect(() => savePeopleOrder(vault, { ...scope, personIds: ["avery"], baseRevision: -1, requestId: "bad-revision" })).toThrow(/revision/i);
    expect(vault.entries).toHaveLength(initial);
    savePeopleOrder(vault, { ...scope, personIds: ["avery", "sam1", "sam2"], baseRevision: 0, requestId: "rank" });
    expect(() => savePeopleOrder(vault, { ...scope, personIds: ["sam1", "avery", "sam2"], baseRevision: 0, requestId: "stale" })).toThrow(/revision/i);
  });

  it("does not append empty order for an empty imported view", () => {
    const vault = fixture(); addSource(vault, "empty", [], "W", "empty");
    expect(readPeopleWorkspace(loadWorld(vault), "W", "empty")?.order).toEqual([]);
    expect(() => savePeopleOrder(vault, { ...scope, viewId: "empty", personIds: [], baseRevision: 0, requestId: "empty" })).toThrow(/empty/i);
  });

  it("keeps same-name note anchors, drafts and replies across restart, reorder and rename", () => {
    const vault = fixture();
    savePeopleNote(vault, note());
    savePeopleNote(vault, note({ noteId: "note-two", personId: "sam2", text: "Different Sam", requestId: "note-two" }));
    savePeopleOrder(vault, { ...scope, personIds: ["sam2", "sam1", "avery"], baseRevision: 0, requestId: "rank" });
    savePeopleNote(vault, note({ noteId: "reply", replyTo: "note-one", text: "Got it", actor: { kind: "lois", ref: "lois" }, requestId: "reply" }));
    addSource(vault, "A", [["avery", "Avery"], ["sam1", "Samuel"], ["sam2", "Sam"]]);
    const notes = workspace(openVault(vault.dir)).notes;
    expect(workspace(openVault(vault.dir)).people.find((person) => person.personId === "sam1")?.name).toBe("Samuel");
    expect(notes.map((n) => [n.noteId, n.personId, n.replyTo])).toEqual([["note-one", "sam1", undefined], ["note-two", "sam2", undefined], ["reply", "sam1", "note-one"]]);
    expect(notes[2].actor.kind).toBe("lois");
    expect(() => savePeopleNote(vault, note({ personId: "sam2", baseRevision: 1, requestId: "reanchor" }))).toThrow(/anchor/i);
    expect(() => savePeopleNote(vault, note({ personId: "foreign", noteId: "foreign-note", requestId: "foreign-note" }))).toThrow(/member/i);
    expect(() => savePeopleNote(vault, note({ personId: "sam2", noteId: "wrong-reply", replyTo: "note-one", requestId: "wrong-reply" }))).toThrow(/anchor/i);
  });

  it("saves note edits independently with per-note revisions and idempotent retries", () => {
    const vault = fixture(); const request = note(); const first = savePeopleNote(vault, request);
    savePeopleNote(vault, note({ text: "Edited", baseRevision: 1, requestId: "edit" }));
    expect(savePeopleNote(vault, request)).toEqual({ ...first, replayed: true });
    expect(() => savePeopleNote(vault, note({ text: "Lost update", requestId: "stale" }))).toThrow(/revision/i);
    expect(() => savePeopleNote(vault, note({ text: "Changed retry" }))).toThrow(/request.*different/i);
    expect(workspace(vault).notes[0]).toMatchObject({ text: "Edited", revision: 2 });
  });

  it("submits one immutable wave, allowing new note drafts and organizer order changes", () => {
    const vault = fixture(); savePeopleNote(vault, note());
    const request = { ...scope, noteIds: ["note-one"], baseRevision: 1, requestId: "wave" };
    const wave = submitPeopleNotes(vault, request);
    expect(wave).toMatchObject({ status: "pending", orderRevision: 0, notes: [{ text: "Move above Avery", revision: 1 }] });
    expect(workspace(vault).notes[0]).toMatchObject({ state: "submitted", revision: 2 });
    savePeopleNote(vault, note({ text: "Actually leave this one", baseRevision: 2, requestId: "new-draft" }));
    expect(vault.entries.at(-1)?.supersedes).toBeUndefined();
    expect(vault.entries.at(-1)?.refs).toContain(wave.entryId);
    savePeopleOrder(vault, { ...scope, personIds: ["sam2", "avery", "sam1"], baseRevision: 0, requestId: "organizer-move" });
    expect(submitPeopleNotes(vault, request)).toMatchObject({ waveId: wave.waveId, replayed: true });
    expect(() => submitPeopleNotes(vault, { ...scope, noteIds: ["note-one"], requestId: "second-wave" })).toThrow(/wave.*pending/i);
    expect(workspace(openVault(vault.dir)).waves[0].notes[0].text).toBe("Move above Avery");
    expect(() => savePeopleOrder(vault, { ...scope, personIds: ["sam1", "avery", "sam2"], baseRevision: wave.orderRevision, requestId: "late-model" })).toThrow(/revision/i);
    finishPeopleNotes(vault, { ...scope, waveId: wave.waveId, status: "failed", requestId: "failure" });
    expect(workspace(vault).notes[0].text).toBe("Actually leave this one");
    expect(submitPeopleNotes(vault, { ...scope, noteIds: ["note-one"], requestId: "second-wave" }).status).toBe("pending");
  });

  it("keeps hidden and resolved note history without mutating submitted contents", () => {
    const vault = fixture(); savePeopleNote(vault, note());
    const wave = submitPeopleNotes(vault, { ...scope, noteIds: ["note-one"], requestId: "wave" });
    savePeopleNote(vault, note({ state: "resolved", baseRevision: 2, requestId: "resolve" }));
    savePeopleNote(vault, note({ state: "hidden", baseRevision: 3, requestId: "hide" }));
    const finished = finishPeopleNotes(vault, { ...scope, waveId: wave.waveId, status: "completed", requestId: "finish" });
    expect(finishPeopleNotes(vault, { ...scope, waveId: wave.waveId, status: "completed", requestId: "finish" })).toEqual({ ...finished, replayed: true });
    const read = workspace(openVault(vault.dir));
    expect(read.notes[0]).toMatchObject({ state: "hidden", revision: 4 });
    expect(read.waves[0]).toMatchObject({ status: "completed", notes: [{ text: "Move above Avery", state: "draft" }] });
    expect(vault.entries.filter((e) => e.subtype === "people-note")).toHaveLength(3);
  });

  it("rejects empty, stale, unknown and repeated note selection before appending a wave", () => {
    const vault = fixture(); savePeopleNote(vault, note()); const length = vault.entries.length;
    for (const noteIds of [[], ["missing"], ["note-one", "note-one"]]) expect(() => submitPeopleNotes(vault, { ...scope, noteIds, requestId: "bad-wave" })).toThrow();
    expect(() => submitPeopleNotes(vault, { ...scope, noteIds: ["note-one"], baseRevision: 0, requestId: "stale-wave" })).toThrow(/revision/i);
    expect(vault.entries).toHaveLength(length);
  });

  it("keeps caller objects and projected snapshots detached from the journal", () => {
    const vault = fixture(); const request = { ...scope, personIds: ["sam2", "avery", "sam1"], baseRevision: 0, requestId: "rank" };
    savePeopleOrder(vault, request); request.personIds.reverse();
    expect(workspace(vault).order).toEqual(["sam2", "avery", "sam1"]);
    savePeopleNote(vault, note());
    const wave = submitPeopleNotes(vault, { ...scope, noteIds: ["note-one"], requestId: "wave" });
    wave.notes[0].text = "mutated return value";
    wave.notes[0].actor.ref = "another actor";
    const read = workspace(vault);
    expect(read.notes[0].text).toBe("Move above Avery");
    expect(read.waves[0].notes[0].actor.ref).toBe("organizer");
  });

  it("rejects reused operation IDs across actions or actors and leaves successful work intact", () => {
    const vault = fixture(); savePeopleNote(vault, note()); const size = vault.entries.length;
    expect(() => savePeopleOrder(vault, { ...scope, personIds: ["avery"], baseRevision: 0, requestId: "note-save" })).toThrow(/different operation/);
    expect(() => savePeopleNote(vault, note({ actor: { kind: "lois", ref: "lois" } }))).toThrow(/different operation/);
    expect(vault.entries).toHaveLength(size);
  });

  it("reports missing view separately and retains a failed wave for an explicit interpretation retry", () => {
    const vault = fixture();
    expect(readPeopleWorkspace(loadWorld(vault), "W", "unknown")).toBeUndefined();
    expect(() => savePeopleNote(vault, note({ viewId: "unknown" }))).toThrow(expect.objectContaining({ code: "not_found" }));
    savePeopleNote(vault, note());
    const wave = submitPeopleNotes(vault, { ...scope, noteIds: ["note-one"], requestId: "wave" });
    finishPeopleNotes(vault, { ...scope, waveId: wave.waveId, status: "failed", requestId: "failure" });
    const size = vault.entries.length;
    expect(submitPeopleNotes(vault, { ...scope, noteIds: ["note-one"], requestId: "wave" })).toMatchObject({ status: "failed", waveId: wave.waveId, replayed: true });
    expect(vault.entries).toHaveLength(size);
    finishPeopleNotes(vault, { ...scope, waveId: wave.waveId, status: "completed", requestId: "recovered" });
    expect(workspace(vault).waves).toHaveLength(1);
    expect(workspace(vault).waves[0].status).toBe("completed");
  });

  it("attributes a reply to the exact submitted wave without letting that attribution change", () => {
    const vault = fixture(); savePeopleNote(vault, note());
    const wave = submitPeopleNotes(vault, { ...scope, noteIds: ["note-one"], requestId: "wave" });
    const reply = note({ noteId: "reply", replyTo: "note-one", waveId: wave.waveId, text: "Moved", state: "resolved", actor: { kind: "lois", ref: "lois" }, requestId: "reply" });
    savePeopleNote(vault, reply);
    expect(workspace(openVault(vault.dir)).notes.find((item) => item.noteId === "reply")).toMatchObject({ waveId: wave.waveId });
    expect(vault.entries.at(-1)?.refs).toContain(wave.entryId);
    expect(() => savePeopleNote(vault, { ...reply, waveId: "unknown", baseRevision: 1, requestId: "reassign" })).toThrow(/wave|anchor/i);
    expect(() => savePeopleNote(vault, note({ noteId: "other-reply", personId: "sam2", replyTo: "note-one", waveId: wave.waveId, requestId: "bad-reply" }))).toThrow(/anchor/i);
  });

  it("validates organizer interaction payloads at the shared append door", () => {
    const vault = fixture();
    const entry = { at, context: "W", type: "interaction" as const, actor: { kind: "human" as const, ref: "organizer" }, persons: ["avery"] };
    expect(() => appendEntry(vault, { ...entry, subtype: "people-order", payload: {} })).toThrow(/viewId/i);
    expect(() => appendEntry(vault, { ...entry, subtype: "people-note", payload: { viewId: "3cs", requestId: "n", baseRevision: 0, revision: 1, noteId: "n", personId: "sam1", text: "hello", state: "draft" } })).toThrow(/person/i);
    expect(() => appendEntry(vault, { ...entry, subtype: "people-order", payload: { viewId: "3cs", requestId: "o", baseRevision: 0, revision: 1, personIds: ["avery", "avery"] } })).toThrow(/unique/i);
  });
});
