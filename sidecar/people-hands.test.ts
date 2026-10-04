import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVault, registerContext } from "../packages/vault/store.js";
import { loadWorld } from "../packages/vault/world.js";
import { readPeopleWorkspace, savePeopleNote, savePeopleOrder, submitPeopleNotes } from "../packages/vault/people-edits.js";
import { importPeopleSource, selectPeopleSources } from "../packages/organs/people.js";
import { createPeopleHands } from "./people-hands.js";

const roots: string[] = [];
const scope = { contextId: "W", viewId: "3cs" };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "people-hands-")); roots.push(dir);
  const vault = openVault(dir);
  registerContext(vault, { id: "W", name: "World", kind: "social", anchor: "email", created_at: "2026-09-05T00:00:00Z" });
  const source = { platform: "luma", accountId: "owner", eventId: "A", name: "Dinner", date: "2026-08-01T00:00:00Z", url: "https://luma.com/a", evidence: ["artifact:A"] };
  selectPeopleSources(vault, { ...scope, viewName: "People", sources: [source], discoveryComplete: true });
  const people = importPeopleSource(vault, { ...scope, source, readState: "read", evidence: ["artifact:A"], rows: ["Avery", "Riley", "Taylor"].map((name) => ({ rowId: name, name, evidence: ["artifact:A"] })) }).people;
  const world = loadWorld(vault);
  return { dir, vault, world, source, hands: createPeopleHands(dir, world), ids: people.map((person) => person.personId) };
}
function waveFor(s: ReturnType<typeof setup>) {
  const vault = openVault(s.dir);
  savePeopleNote(vault, { ...scope, noteId: "n1", personId: s.ids[0], text: "Move below Riley", state: "draft", baseRevision: 0, requestId: "n1" });
  savePeopleNote(vault, { ...scope, noteId: "n2", personId: s.ids[1], text: "An important guest", state: "draft", baseRevision: 0, requestId: "n2" });
  return submitPeopleNotes(vault, { ...scope, noteIds: ["n1", "n2"], requestId: "wave" });
}

describe("model-facing local people hands", () => {
  it("returns fresh view choices for a missing World/view pair without choosing or writing", async () => {
    const s = setup();
    // The hands already exist before these new views land.
    const vault = openVault(s.dir);
    registerContext(vault, { id: "W2", name: "Another World", kind: "social", anchor: "email", created_at: "2026-09-05T00:00:00Z" });
    selectPeopleSources(vault, { contextId: "W2", viewId: "other", viewName: "Other people", sources: [s.source], discoveryComplete: false });
    registerContext(vault, { id: "hidden", name: "Private system", kind: "system", anchor: "email", apps_never_read: true, created_at: "2026-09-05T00:00:00Z" });
    const before = openVault(s.dir).entries;

    const result = JSON.parse(await s.hands.people_read.run({ contextId: "W", viewId: "other" }));

    expect(result).toEqual({
      ok: false, code: "not_found", error: "People view not found in this World",
      availableViews: [
        { contextId: "W", contextName: "World", viewId: "3cs", name: "People" },
        { contextId: "W2", contextName: "Another World", viewId: "other", name: "Other people" },
      ],
    });
    expect(JSON.parse(await s.hands.people_order.run({ contextId: "W", viewId: "other", personIds: s.ids, baseRevision: 0, requestId: "wrong-pair" }))).toEqual(result);
    expect(openVault(s.dir).entries).toEqual(before);
    expect(JSON.parse(await s.hands.people_read.run(result.availableViews[1]))).toMatchObject({ ok: true, contextId: "W2", viewId: "other", total: 0 });
  });

  it("distinguishes an empty vault from a missing scoped view in a populated vault", async () => {
    const dir = mkdtempSync(join(tmpdir(), "people-hands-empty-")); roots.push(dir);
    const hands = createPeopleHands(dir, loadWorld(openVault(dir)));
    expect(JSON.parse(await hands.people_read.run(scope))).toMatchObject({ ok: false, code: "not_found", availableViews: [] });
  });

  it("reads and answers historical wave identities after reconciliation through the actual model hands", async () => {
    const s = setup(); const wave = waveFor(s);
    const vault = openVault(s.dir);
    importPeopleSource(vault, { ...scope, source: s.source, readState: "read", evidence: ["artifact:A"], rows: ["Avery", "Riley", "Taylor"].map(name => ({ rowId: name, name, evidence: ["artifact:A"], anchors: name === "Taylor" ? [] : [{ kind: "email", value: "same@example.test", verified: true, evidence: "artifact:A", adjudication: { rationale: "Two sightings of the same registered account", evidence: ["artifact:A"] } }] })) });
    const current = readPeopleWorkspace(vault, "W", "3cs")!;
    expect(current.people).toHaveLength(2);
    const survivor = current.notes[0].personId;
    const read = JSON.parse(await s.hands.people_read.run({ ...scope, waveId: wave.waveId }));
    expect(read.wave.notes.map((note: { personId: string }) => note.personId)).toEqual(wave.notes.map(note => note.personId));
    expect(read.wave.notes.every((note: { personName: string | null }) => note.personName !== null)).toBe(true);
    const canonical = { ...scope, waveId: wave.waveId, noteId: "canonical-reply", personId: survivor, replyTo: "n1", text: "Your note is saved on the combined person", baseRevision: 0, requestId: "canonical-reply" };
    const historical = { ...canonical, noteId: "historical-reply", personId: s.ids[1], replyTo: "n2", requestId: "historical-reply" };
    expect(JSON.parse(await s.hands.people_reply.run(canonical))).toMatchObject({ ok: true });
    expect(JSON.parse(await s.hands.people_reply.run(historical))).toMatchObject({ ok: true });
    expect(JSON.parse(await s.hands.people_reply.run(canonical))).toMatchObject({ ok: true, replayed: true });
    expect(JSON.parse(await s.hands.people_finish_notes.run({ ...scope, waveId: wave.waveId, status: "completed", requestId: "done" }))).toMatchObject({ ok: true });
    expect(readPeopleWorkspace(openVault(s.dir), "W", "3cs")!.waves[0].notes).toEqual(wave.notes);
  });

  it("pages the current ordered roster and reads the exact immutable submitted notes", async () => {
    const s = setup(); const wave = waveFor(s);
    const first = JSON.parse(await s.hands.people_read.run({ ...scope, limit: 1 }));
    expect(first).toMatchObject({ ok: true, total: 3, nextOffset: 1, people: [{ personId: s.ids[0], position: 1 }], waves: [{ waveId: wave.waveId }] });
    expect(first.people[0]).not.toHaveProperty("anchors");
    expect(first.people[0]).not.toHaveProperty("memberships");
    const notes = JSON.parse(await s.hands.people_read.run({ ...scope, waveId: wave.waveId, offset: 1, limit: 1 }));
    expect(notes).toMatchObject({ ok: true, total: 2, nextOffset: null, wave: { waveId: wave.waveId, notes: [{ noteId: "n2", text: "An important guest" }] } });
    expect(s.world.entries.length).toBe(openVault(s.dir).entries.length);
  });

  it("includes source identity evidence only for the requested roster page without writing", async () => {
    const s = setup();
    const vault = openVault(s.dir);
    importPeopleSource(vault, {
      ...scope,
      source: s.source,
      readState: "read",
      evidence: ["artifact:A"],
      rows: ["Avery", "Riley", "Taylor"].map((name) => ({
        rowId: name,
        name,
        evidence: [`artifact:A/row:${name}`],
        anchors: name === "Riley"
          ? [
              {
                kind: "email" as const,
                value: "Riley@Example.Test",
                verified: true,
                evidence: `artifact:A/row:${name}`,
                adjudication: {
                  rationale: "The source page says account email is verified at registration.",
                  evidence: [`artifact:A/row:${name}`],
                },
              },
              { kind: "phone" as const, value: "+15550100", verified: false },
            ]
          : [],
      })),
    });
    const otherSource = { ...s.source, eventId: "B", name: "Other Dinner", url: "https://luma.com/b", evidence: ["artifact:B"] };
    selectPeopleSources(vault, { contextId: "W", viewId: "other", viewName: "Other People", sources: [otherSource], discoveryComplete: true });
    importPeopleSource(vault, {
      contextId: "W",
      viewId: "other",
      source: otherSource,
      readState: "read",
      evidence: ["artifact:B"],
      rows: [{ rowId: "Morgan", name: "Morgan", evidence: ["artifact:B/row:Morgan"] }],
    });
    const before = openVault(s.dir).entries;

    const read = JSON.parse(await s.hands.people_read.run({ ...scope, includeEvidence: true, offset: 1, limit: 1 }));

    expect(read).toMatchObject({ ok: true, total: 3, offset: 1, nextOffset: 2 });
    expect(read.people).toHaveLength(1);
    expect(read.people[0]).toMatchObject({
      name: "Riley",
      position: 2,
      sourceCount: 1,
      identity: "verified",
      anchors: [
        {
          kind: "email",
          value: "riley@example.test",
          verified: true,
          evidence: "artifact:A/row:Riley",
          adjudication: {
            rationale: "The source page says account email is verified at registration.",
            evidence: ["artifact:A/row:Riley"],
          },
        },
        { kind: "phone", value: "+15550100", verified: false },
      ],
      memberships: [
        {
          platform: "luma",
          accountId: "owner",
          eventId: "A",
          name: "Dinner",
          url: "https://luma.com/a",
          rowId: "Riley",
          evidence: ["artifact:A/row:Riley"],
        },
      ],
    });
    expect(JSON.stringify(read.people)).not.toContain("artifact:B");
    expect(JSON.stringify(read.people)).not.toContain("Morgan");
    expect(JSON.stringify(read.people)).not.toContain('"eventId":"B"');
    expect(openVault(s.dir).entries).toEqual(before);
  });

  it("does not add roster evidence to immutable wave reads", async () => {
    const s = setup(); const wave = waveFor(s);

    const compact = JSON.parse(await s.hands.people_read.run({ ...scope, waveId: wave.waveId, limit: 1 }));
    const detailed = JSON.parse(await s.hands.people_read.run({ ...scope, waveId: wave.waveId, limit: 1, includeEvidence: true }));

    expect(detailed).toEqual(compact);
    expect(JSON.stringify(detailed.wave.notes)).not.toContain("memberships");
    expect(JSON.stringify(detailed.wave.notes)).not.toContain("anchors");
  });

  it("persists a model-chosen order and reply without invoking a model or replacing source facts", async () => {
    const s = setup(); const wave = waveFor(s);
    const order = [s.ids[1], s.ids[0], s.ids[2]];
    const result = JSON.parse(await s.hands.people_order.run({ ...scope, personIds: order, baseRevision: wave.orderRevision, requestId: "wave-order", waveId: wave.waveId }));
    expect(result).toMatchObject({ ok: true, revision: 1, order });
    const reply = { ...scope, waveId: wave.waveId, noteId: "reply1", personId: s.ids[0], replyTo: "n1", text: "Moved below Riley.", baseRevision: 0, requestId: "reply1" };
    expect(JSON.parse(await s.hands.people_reply.run(reply))).toMatchObject({ ok: true, revision: 1, replayed: false });
    expect(JSON.parse(await s.hands.people_reply.run(reply))).toMatchObject({ ok: true, replayed: true });
    const read = readPeopleWorkspace(loadWorld(openVault(s.dir)), "W", "3cs")!;
    expect(read.notes.find((note) => note.noteId === "reply1")).toMatchObject({ actor: { kind: "lois", ref: "lois" }, waveId: wave.waveId, state: "resolved" });
    expect(read.people.flatMap((person) => person.memberships)).toHaveLength(3);
  });

  it("rejects a delayed model order after an organizer edit and returns current revision", async () => {
    const s = setup(); const wave = waveFor(s);
    savePeopleOrder(openVault(s.dir), { ...scope, personIds: [...s.ids].reverse(), baseRevision: 0, requestId: "human" });
    const result = JSON.parse(await s.hands.people_order.run({ ...scope, personIds: s.ids, baseRevision: wave.orderRevision, requestId: "late", waveId: wave.waveId }));
    expect(result).toMatchObject({ ok: false, code: "conflict", orderRevision: 1 });
    expect(result.error).toContain("revision");
    expect(readPeopleWorkspace(loadWorld(openVault(s.dir)), "W", "3cs")?.order).toEqual([...s.ids].reverse());
  });

  it("will not claim a wave completed before every note has a reply saved by Lois", async () => {
    const s = setup(); const wave = waveFor(s);
    const finish = { ...scope, waveId: wave.waveId, status: "completed", requestId: "complete" };
    expect(JSON.parse(await s.hands.people_finish_notes.run(finish))).toMatchObject({ ok: false, code: "conflict", unansweredNoteIds: ["n1", "n2"] });
    for (let i = 0; i < 2; i++) await s.hands.people_reply.run({ ...scope, waveId: wave.waveId, noteId: `reply${i}`, personId: s.ids[i], replyTo: `n${i + 1}`, text: "Saved reply", baseRevision: 0, requestId: `reply${i}` });
    expect(JSON.parse(await s.hands.people_finish_notes.run(finish))).toMatchObject({ ok: true, replayed: false });
    expect(JSON.parse(await s.hands.people_finish_notes.run(finish))).toMatchObject({ ok: true, replayed: true });
    expect(readPeopleWorkspace(loadWorld(openVault(s.dir)), "W", "3cs")?.waves[0].status).toBe("completed");
  });

  it("does not count a preexisting reply, an organizer reply or another wave's reply as the answer", async () => {
    const s = setup(); const wave = waveFor(s);
    savePeopleNote(openVault(s.dir), { ...scope, noteId: "human-reply", personId: s.ids[0], replyTo: "n1", waveId: wave.waveId, text: "My own reply", state: "resolved", baseRevision: 0, requestId: "human-reply" });
    savePeopleNote(openVault(s.dir), { ...scope, noteId: "unattributed", personId: s.ids[1], replyTo: "n2", text: "Old reply", state: "resolved", actor: { kind: "lois", ref: "lois" }, baseRevision: 0, requestId: "unattributed" });
    expect(JSON.parse(await s.hands.people_finish_notes.run({ ...scope, waveId: wave.waveId, status: "completed", requestId: "finish" }))).toMatchObject({ ok: false, unansweredNoteIds: ["n1", "n2"] });
  });

  it("allows honest failure without replies while preserving notes for recovery", async () => {
    const s = setup(); const wave = waveFor(s);
    expect(JSON.parse(await s.hands.people_finish_notes.run({ ...scope, waveId: wave.waveId, status: "failed", requestId: "failed" }))).toMatchObject({ ok: true });
    expect(readPeopleWorkspace(loadWorld(openVault(s.dir)), "W", "3cs")?.notes.map((note) => note.text)).toEqual(["Move below Riley", "An important guest"]);
  });

  it("returns structural errors without appending and keeps tool inputs bounded", async () => {
    const s = setup(); const length = openVault(s.dir).entries.length;
    expect(JSON.parse(await s.hands.people_read.run({ ...scope, limit: 500 }))).toMatchObject({ ok: false, code: "invalid" });
    expect(JSON.parse(await s.hands.people_reply.run({ ...scope, waveId: "missing", noteId: "reply", personId: s.ids[0], replyTo: "missing", text: "Hi", baseRevision: 0, requestId: "invalid" }))).toMatchObject({ ok: false, code: "not_found" });
    expect(openVault(s.dir).entries).toHaveLength(length);
  });
});
