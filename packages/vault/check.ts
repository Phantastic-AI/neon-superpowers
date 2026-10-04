#!/usr/bin/env -S npx tsx
// Vault check — proves the engine spine slid in behind the sealed contracts
// (D-042: same World in, same views out) over a REAL on-disk vault:
//
//   (a) import the sealed seed world into a temp vault by replaying every
//       stream line through appendEntry (the validator accepts all 964);
//   (b) reopen the vault FROM DISK and run both existing check suites' key
//       assertions through the real deriveRoom/deriveQueue over the
//       vault-loaded World — Fogline 41/9/6/19/3 of 78, Ember #4
//       19/6/15/17 of 57, queue counts, cross-surface awaiting==queued,
//       and a mid-stream cursor test;
//   (c) append ONE new valid guest-imported entry to Fogline — the
//       first-ever real write changing a real projection: 78 -> 79;
//   (d) append-only holds: the stream file only grows, byte-prefix intact,
//       and a second import into the same dir refuses;
//   (e) invalid appends throw, each with its specific reason, and leave
//       the vault untouched.
//
// Exit nonzero, naming the failing figure, on any miss. Nothing is fudged
// to make a check pass. On failure the temp vault is kept for inspection.

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Person } from "../../tools/seed-world/types.js";
import type { RoomView, RsvpStatus } from "../../tools/projections/types.js";
import { deriveRoom } from "../../tools/projections/room.js";
import { deriveQueue } from "../../tools/projections/queue.js";
import { openVault, registerPerson } from "./store.js";
import { appendEntry } from "./append.js";
import { loadWorld } from "./world.js";
import { importSeed, DEFAULT_SEED_OUT } from "./import-seed.js";

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
}
function throws(name: string, fn: () => void, pattern: RegExp) {
  let detail = "did NOT throw";
  let pass = false;
  try {
    fn();
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
    pass = pattern.test(detail);
  }
  check(name, pass, detail);
}

const fmtStatuses = (r: RoomView) =>
  `accepted=${r.statusCounts.accepted.count}, tentative=${r.statusCounts.tentative.count}, declined=${r.statusCounts.declined.count}, ` +
  `no-reply=${r.statusCounts["no-reply"].count}, uninvited=${r.statusCounts.uninvited.count}, total=${r.total.count}`;
const STATUSES: RsvpStatus[] = ["accepted", "tentative", "declined", "no-reply", "uninvited"];
const statusSum = (r: RoomView) => STATUSES.reduce((s, k) => s + r.statusCounts[k].count, 0);

const tempRoot = mkdtempSync(join(tmpdir(), "vault-check-"));
const vaultDir = join(tempRoot, "vault");
const streamPath = join(vaultDir, "stream.jsonl");

// =======================================================================
// (a) Import: replay the whole sealed seed world through appendEntry
// =======================================================================
const imported = importSeed(vaultDir);
check(
  "IMPORT: appendEntry accepted the entire sealed seed world (964 entries, 129 persons, 5 contexts, 5 gatherings)",
  imported.entries === 964 && imported.persons === 129 && imported.contexts === 5 && imported.gatherings === 5,
  `entries=${imported.entries}, persons=${imported.persons}, contexts=${imported.contexts}, gatherings=${imported.gatherings}`,
);

const seedStreamBytes = readFileSync(join(DEFAULT_SEED_OUT, "stream.jsonl"));
const vaultStreamBytes = readFileSync(streamPath);
check(
  "IMPORT: the replayed stream.jsonl is byte-identical to the sealed seed stream (replay fidelity)",
  vaultStreamBytes.equals(seedStreamBytes),
  `seed=${seedStreamBytes.length} bytes, vault=${vaultStreamBytes.length} bytes, equal=${vaultStreamBytes.equals(seedStreamBytes)}`,
);

// =======================================================================
// (b) Reopen FROM DISK; both suites' key assertions over the vault World
// =======================================================================
const vault = openVault(vaultDir);
const world = loadWorld(vault);
check(
  "REOPEN: openVault reads the imported vault back off disk (964 entries, cursor==line index enforced)",
  world.entries.length === 964 && world.persons.length === 129 && world.contexts.length === 5 && world.gatherings.length === 5,
  `entries=${world.entries.length}, persons=${world.persons.length}, contexts=${world.contexts.length}, gatherings=${world.gatherings.length}`,
);

// --- The Room, Fogline (projections suite + seed-world suite headline) ---
const fogline = deriveRoom(world, "fogline");
check(
  "ROOM Fogline (vault-loaded): 41/9/6/19/3 of 78, cross-footed",
  fogline.statusCounts.accepted.count === 41 &&
    fogline.statusCounts.tentative.count === 9 &&
    fogline.statusCounts.declined.count === 6 &&
    fogline.statusCounts["no-reply"].count === 19 &&
    fogline.statusCounts.uninvited.count === 3 &&
    fogline.total.count === 78 &&
    fogline.guests.length === 78 &&
    statusSum(fogline) === fogline.total.count,
  fmtStatuses(fogline),
);
check(
  "ROOM Fogline (vault-loaded): anchors 44/60/27, meter 119 consumed / 881 remain (§7.2, §4.4)",
  fogline.anchors.email.count === 44 &&
    fogline.anchors.phone.count === 60 &&
    fogline.anchors.linkedin.count === 27 &&
    fogline.lookups.consumed.count === 119 &&
    fogline.lookups.remaining === 881,
  `email=${fogline.anchors.email.count}, phone=${fogline.anchors.phone.count}, linkedin=${fogline.anchors.linkedin.count}, ` +
    `consumed=${fogline.lookups.consumed.count}, remaining=${fogline.lookups.remaining}`,
);

// --- The Room, Ember dinner #4 ---
const ember = deriveRoom(world, "dinner-4");
check(
  "ROOM Ember dinner #4 (vault-loaded): 19/6/15/17 of 57, tentative 0, cross-footed",
  ember.statusCounts.accepted.count === 19 &&
    ember.statusCounts.declined.count === 6 &&
    ember.statusCounts["no-reply"].count === 15 &&
    ember.statusCounts.uninvited.count === 17 &&
    ember.statusCounts.tentative.count === 0 &&
    ember.total.count === 57 &&
    statusSum(ember) === 57,
  fmtStatuses(ember),
);
check(
  "ROOM Ember series memory (vault-loaded): returning 45 / first-timers 12; accepted 19 = 14 + 5 (C5/C7)",
  ember.series !== undefined &&
    ember.series.returning.count === 45 &&
    ember.series.firstTimers.count === 12 &&
    ember.series.acceptedReturning.count === 14 &&
    ember.series.acceptedFirstTimers.count === 5,
  ember.series
    ? `returning=${ember.series.returning.count}, first-timers=${ember.series.firstTimers.count}, accepted split=${ember.series.acceptedReturning.count}+${ember.series.acceptedFirstTimers.count}`
    : "series split missing",
);

// --- The queue: whole vault and per scope (§10.2, C9/C12) ---
const queueAll = deriveQueue(world, "all");
check(
  "QUEUE all (vault-loaded): 105 drafts, 12 queued, 93 landed, cross-footed (§10.2)",
  queueAll.rows.length === 105 &&
    queueAll.counts.proposed.count === 105 &&
    queueAll.counts.queued.count === 12 &&
    queueAll.counts.approved.count === 0 &&
    queueAll.counts.released.count === 0 &&
    queueAll.counts.landed.count === 93 &&
    queueAll.counts.queued.count + queueAll.counts.approved.count + queueAll.counts.released.count + queueAll.counts.landed.count ===
      queueAll.counts.proposed.count,
  `proposed=${queueAll.counts.proposed.count}, queued=${queueAll.counts.queued.count}, approved=${queueAll.counts.approved.count}, released=${queueAll.counts.released.count}, landed=${queueAll.counts.landed.count}`,
);
const queueFogline = deriveQueue(world, "fogline-event");
const queueLinkedIn = deriveQueue(world, "meeras-linkedin");
const queueEmber = deriveQueue(world, "dinner-4");
check(
  "QUEUE scopes (vault-loaded): Fogline 27/3 queued/24 landed (C9); LinkedIn 38/9/29 (C12); Ember #4 40/0/40 (C7)",
  queueFogline.rows.length === 27 &&
    queueFogline.counts.queued.count === 3 &&
    queueFogline.counts.landed.count === 24 &&
    queueLinkedIn.rows.length === 38 &&
    queueLinkedIn.counts.queued.count === 9 &&
    queueLinkedIn.counts.landed.count === 29 &&
    queueEmber.rows.length === 40 &&
    queueEmber.counts.queued.count === 0 &&
    queueEmber.counts.landed.count === 40,
  `fogline=${queueFogline.rows.length}/${queueFogline.counts.queued.count}/${queueFogline.counts.landed.count}, ` +
    `linkedin=${queueLinkedIn.rows.length}/${queueLinkedIn.counts.queued.count}/${queueLinkedIn.counts.landed.count}, ` +
    `ember=${queueEmber.rows.length}/${queueEmber.counts.queued.count}/${queueEmber.counts.landed.count}`,
);

// --- Cross-surface: queue queued == Room awaiting (same fact, read twice) ---
check(
  "CROSS-SURFACE (vault-loaded): Room awaiting == queue queued (Fogline 3, Ember 0); landed agrees too",
  fogline.awaiting.count === queueFogline.counts.queued.count &&
    fogline.awaiting.count === 3 &&
    ember.awaiting.count === queueEmber.counts.queued.count &&
    ember.awaiting.count === 0 &&
    fogline.landed.count === queueFogline.counts.landed.count &&
    ember.landed.count === queueEmber.counts.landed.count,
  `fogline room=${fogline.awaiting.count}/queue=${queueFogline.counts.queued.count}, ember room=${ember.awaiting.count}/queue=${queueEmber.counts.queued.count}; ` +
    `landed fogline=${fogline.landed.count}/${queueFogline.counts.landed.count}, ember=${ember.landed.count}/${queueEmber.counts.landed.count}`,
);

// --- Time is a cursor: loadWorld(vault, MID) == deriveRoom(world, MID) ---
const MID = 550;
const worldMid = loadWorld(vault, MID);
const roomViaLoad = deriveRoom(worldMid, "fogline");
const roomViaParam = deriveRoom(world, "fogline", MID);
check(
  `CURSOR: loadWorld(vault, ${MID}) serves entries strictly <= ${MID} and the Room agrees with deriveRoom(world, "fogline", ${MID})`,
  worldMid.entries.length === MID + 1 &&
    worldMid.entries.every((e) => e.cursor <= MID) &&
    roomViaLoad.total.count === roomViaParam.total.count &&
    STATUSES.every((s) => roomViaLoad.statusCounts[s].count === roomViaParam.statusCounts[s].count) &&
    statusSum(roomViaLoad) === roomViaLoad.total.count,
  `entries@${MID}=${worldMid.entries.length}; via loadWorld: ${fmtStatuses(roomViaLoad)}; via cursor param: ${fmtStatuses(roomViaParam)}`,
);
check(
  `CURSOR: the cursor bites — Fogline Room @${MID} differs from the full-stream Room, and awaiting==queued holds mid-stream`,
  STATUSES.some((s) => roomViaLoad.statusCounts[s].count !== fogline.statusCounts[s].count) &&
    roomViaLoad.awaiting.count === deriveQueue(worldMid, "fogline-event").counts.queued.count,
  `@${MID}: ${fmtStatuses(roomViaLoad)} vs full: ${fmtStatuses(fogline)}; awaiting@${MID}=${roomViaLoad.awaiting.count}`,
);

// =======================================================================
// (c) The first real write: one new guest-imported entry -> 78 becomes 79
// =======================================================================
const sizeBefore = statSync(streamPath).size;
const bytesBefore = readFileSync(streamPath);

const newGuest: Person = {
  id: "p-0130",
  name: "Tessa Brightwater",
  anchors: [{ kind: "phone", value: "+15557000130", verified: true, context: "fogline" }],
  merged: [],
  sighted_at: "2026-09-14T18:00:00-07:00",
  state: "active",
};
registerPerson(vault, newGuest);
const appended = appendEntry(vault, {
  at: "2026-09-14T18:05:00-07:00",
  context: "fogline",
  type: "imported",
  subtype: "guest",
  actor: { kind: "app", ref: "app-event" },
  persons: [newGuest.id],
  about: "fogline-event",
  source: "partiful-import-late-add",
  payload: { row: 79, rsvp: "accepted" },
});
check(
  "WRITE: appendEntry assigned cursor 964 and the seed-convention id e-000965 to the new guest-imported entry",
  appended.cursor === 964 && appended.id === "e-000965",
  `cursor=${appended.cursor}, id=${appended.id}`,
);

// Reopen from disk AGAIN: the write must have persisted, and the Room must move.
const vaultAfter = openVault(vaultDir);
const worldAfter = loadWorld(vaultAfter);
const room79 = deriveRoom(worldAfter, "fogline");
check(
  "WRITE-THROUGH: the Room total is 79 and accepted 41 -> 42 per the entry (rsvp=accepted); every other figure unmoved",
  room79.total.count === 79 &&
    room79.statusCounts.accepted.count === 42 &&
    room79.statusCounts.accepted.count === fogline.statusCounts.accepted.count + 1 &&
    room79.statusCounts["no-reply"].count === 19 &&
    room79.statusCounts["no-reply"].count === fogline.statusCounts["no-reply"].count &&
    room79.statusCounts.tentative.count === 9 &&
    room79.statusCounts.declined.count === 6 &&
    room79.statusCounts.uninvited.count === 3 &&
    statusSum(room79) === 79,
  fmtStatuses(room79),
);
const room78Again = deriveRoom(worldAfter, "fogline", 963);
check(
  "WRITE-THROUGH: at cursor 963 the Room still shows 78/41 — visibility is append order, the new entry exists only from its cursor forward",
  room78Again.total.count === 78 && room78Again.statusCounts.accepted.count === 41,
  `@963: ${fmtStatuses(room78Again)}`,
);
const queueFogline79 = deriveQueue(worldAfter, "fogline-event");
check(
  "WRITE-THROUGH: the queue is unmoved by the import (still 3 queued / 24 landed) and Room awaiting still agrees",
  queueFogline79.counts.queued.count === 3 && queueFogline79.counts.landed.count === 24 && room79.awaiting.count === 3,
  `queued=${queueFogline79.counts.queued.count}, landed=${queueFogline79.counts.landed.count}, room awaiting=${room79.awaiting.count}`,
);

// =======================================================================
// (d) Append-only: the file only grows; a second import refuses
// =======================================================================
const sizeAfter = statSync(streamPath).size;
const bytesAfter = readFileSync(streamPath);
check(
  "APPEND-ONLY: stream.jsonl only grew, and every prior byte is intact (the old stream is an exact prefix of the new)",
  sizeAfter > sizeBefore && bytesAfter.subarray(0, sizeBefore).equals(bytesBefore),
  `size ${sizeBefore} -> ${sizeAfter}, prefix intact=${bytesAfter.subarray(0, sizeBefore).equals(bytesBefore)}`,
);
throws(
  "APPEND-ONLY: a second import into the same dir refuses (an import is a birth, not a merge)",
  () => importSeed(vaultDir),
  /refusing non-empty target dir/,
);

// =======================================================================
// (e) Invalid appends throw, each with its specific reason
// =======================================================================
const base = {
  at: "2026-09-14T19:00:00-07:00",
  context: "fogline",
  actor: { kind: "app" as const, ref: "app-event" },
};
throws(
  "INVALID: unknown entry type rejects",
  () => appendEntry(vaultAfter, { ...base, type: "gossip" as never, payload: {} }),
  /unknown entry type "gossip"/,
);
throws(
  "INVALID: a dangling ref rejects (refs must point at entries already in the stream)",
  () =>
    appendEntry(vaultAfter, {
      ...base,
      type: "proposed",
      persons: ["p-0130"],
      about: "fogline-event",
      refs: ["e-999999"],
      payload: { kind: "nudge" },
    }),
  /dangling ref "e-999999"/,
);
throws(
  "INVALID: a missing context rejects (every Entry files under exactly one existing Context)",
  () => appendEntry(vaultAfter, { ...base, context: "narnia", type: "interaction", persons: ["p-0130"], payload: { response: "accepted" } }),
  /unknown context "narnia"/,
);
throws(
  "INVALID: an unknown person rejects",
  () =>
    appendEntry(vaultAfter, {
      ...base,
      type: "imported",
      subtype: "guest",
      persons: ["p-9999"],
      about: "fogline-event",
      source: "csv",
      payload: { row: 1 },
    }),
  /unknown person "p-9999"/,
);
throws(
  "INVALID: a fact without confidence/epistemics rejects (D-041)",
  () => appendEntry(vaultAfter, { ...base, type: "fact", subtype: "lookup", persons: ["p-0130"], payload: { kind: "initial" } }),
  /type=fact requires confidence/,
);
throws(
  "INVALID: a caller-supplied cursor that disagrees with the stream rejects (the vault never renumbers)",
  () => appendEntry(vaultAfter, { ...base, cursor: 12, type: "interaction", persons: ["p-0130"], payload: { response: "accepted" } }),
  /cursor mismatch/,
);
throws(
  "INVALID: a duplicate entry id rejects",
  () => appendEntry(vaultAfter, { ...base, id: "e-000001", type: "interaction", persons: ["p-0130"], payload: { response: "accepted" } }),
  /duplicate entry id e-000001/,
);
check(
  "INVALID: every rejected append left the vault untouched (still 965 entries, stream size unchanged)",
  vaultAfter.entries.length === 965 && statSync(streamPath).size === sizeAfter,
  `entries=${vaultAfter.entries.length}, size=${statSync(streamPath).size} (was ${sizeAfter})`,
);

// =======================================================================
// Report
// =======================================================================
const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
}
console.log("");
if (failed.length > 0) {
  console.error(`check.ts: ${failed.length} of ${results.length} checks FAILED (temp vault kept at ${vaultDir}):`);
  for (const r of failed) console.error(`  - ${r.name}: ${r.detail}`);
  process.exit(1);
}
rmSync(tempRoot, { recursive: true, force: true });
console.log(`check.ts: all ${results.length} checks passed.`);
