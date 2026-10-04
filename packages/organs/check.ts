#!/usr/bin/env -S npx tsx
// Organs check — proves that a Partiful-shaped PAGE becomes vault entries
// whose derived Room reproduces the seed world's arithmetic, and that the
// morning sweep is an honest, append-only, idempotent organ:
//
//   (a) fresh vault + connect on fixtures/fogline-day1.html -> deriveRoom
//       equals Fogline's known books 41/9/6/19/3 of 78 and anchors
//       44/60/27 — the seed world's numbers, reproduced FROM A PAGE — and
//       the per-guest name/rsvp pairs equal the seed world's own Room;
//   (b) sweep on fixtures/fogline-day2.html applies the fixture's declared
//       day-2 delta (2 new guests both accepted; 3 no-reply -> accepted;
//       1 accepted -> declined) in exactly 6 appended entries: the Room
//       goes to 45/9/7/16/3 of 80, anchors 45/61/27;
//   (c) sweep is idempotent: the same page swept twice appends nothing the
//       second time (the diff is against DERIVED state, so this is
//       structural, and here it is also verified);
//   (d) append-only holds: across connect and every sweep the stream file
//       only grows and every prior byte is intact;
//   (e) malformed pages (unknown status word, missing name, duplicate
//       guest id) and a contradictory page (a known accepted guest shown
//       as not-yet-invited) are rejected loudly, vault untouched;
//   (f) the SAME organs, the luma contract: connect on
//       fixtures/ember-04.html into a fresh vault -> deriveRoom equals
//       Ember dinner #4's known books 19/0/6/15/17 of 57 and anchors
//       57/12/41, name/rsvp pairs matching the seed world's own Room
//       guest for guest — one contract shape, two platforms;
//   (g) the partiful checks above all still pass, rerun in this same file
//       alongside the luma contract.
//
// Exit nonzero, naming the failing figure, on any miss. Nothing is fudged
// to make a check pass. On failure the temp vault is kept for inspection.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Entry, Person, Context, Gathering, RoomView, RsvpStatus, World } from "../../tools/projections/types.js";
import { deriveRoom } from "../../tools/projections/room.js";
import { openVault } from "../vault/store.js";
import { loadWorld } from "../vault/world.js";
import { connectEvent } from "./connect.js";
import { sweepEvent } from "./sweep.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const DAY1 = join(FIXTURES, "fogline-day1.html");
const DAY2 = join(FIXTURES, "fogline-day2.html");
const SEED_OUT = join(HERE, "..", "..", "tools", "seed-world", "out");

const IDS = { contextId: "fogline-organ", gatheringId: "fogline-organ-event" };
const DAY1_AT = "2026-09-30T16:00:00.000Z";
const DAY2_AT = "2026-10-01T16:00:00.000Z";

const EMBER = join(FIXTURES, "ember-04.html");
const EMBER_IDS = { contextId: "ember-organ", gatheringId: "ember-organ-dinner-4" };
const EMBER_AT = "2026-09-17T16:00:00.000Z";

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
}
async function throwsAsync(name: string, fn: () => Promise<unknown>, pattern: RegExp) {
  let detail = "did NOT throw";
  let pass = false;
  try {
    await fn();
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
    pass = pattern.test(detail);
  }
  check(name, pass, detail);
}

const STATUSES: RsvpStatus[] = ["accepted", "tentative", "declined", "no-reply", "uninvited"];
const fmtStatuses = (r: RoomView) =>
  `accepted=${r.statusCounts.accepted.count}, tentative=${r.statusCounts.tentative.count}, declined=${r.statusCounts.declined.count}, ` +
  `no-reply=${r.statusCounts["no-reply"].count}, uninvited=${r.statusCounts.uninvited.count}, total=${r.total.count}`;
const statusSum = (r: RoomView) => STATUSES.reduce((s, k) => s + r.statusCounts[k].count, 0);

const tempRoot = mkdtempSync(join(tmpdir(), "organs-check-"));
const vaultDir = join(tempRoot, "vault");
const streamPath = join(vaultDir, "stream.jsonl");

async function main() {
  // =====================================================================
  // (a) connect: the page becomes a vault, and the Room reproduces the
  //     seed world's Fogline books
  // =====================================================================
  const vault = openVault(vaultDir);
  const connected = await connectEvent(vault, DAY1, IDS, { at: DAY1_AT, operator: "operator", contextName: "Fogline" });
  check(
    "CONNECT: day1 page imported — 78 guests, 81 entries (context/created + anchor/declared + granted/appscope + 78 imports), 78 persons, 1 context, 1 gathering",
    connected.guests === 78 &&
      connected.entries === 81 &&
      vault.entries.length === 81 &&
      vault.persons.length === 78 &&
      vault.contexts.length === 1 &&
      vault.gatherings.length === 1,
    `report guests=${connected.guests}, entries=${connected.entries}; vault entries=${vault.entries.length}, persons=${vault.persons.length}, contexts=${vault.contexts.length}, gatherings=${vault.gatherings.length}`,
  );
  const bytesAfterConnect = readFileSync(streamPath);

  // Reopen FROM DISK: everything below reads the persisted vault, not the
  // in-memory handle connect wrote through.
  const vault2 = openVault(vaultDir);
  const day1Room = deriveRoom(loadWorld(vault2), IDS.gatheringId);
  check(
    "ROOM from the page (day1): 41/9/6/19/3 of 78 — the seed world's Fogline books (§4.2), reproduced FROM A PAGE, cross-footed",
    day1Room.statusCounts.accepted.count === 41 &&
      day1Room.statusCounts.tentative.count === 9 &&
      day1Room.statusCounts.declined.count === 6 &&
      day1Room.statusCounts["no-reply"].count === 19 &&
      day1Room.statusCounts.uninvited.count === 3 &&
      day1Room.total.count === 78 &&
      day1Room.guests.length === 78 &&
      statusSum(day1Room) === day1Room.total.count,
    fmtStatuses(day1Room),
  );
  check(
    "ROOM from the page (day1): anchors email 44 / phone 60 / linkedin 27 (§7.2) — page anchor hints landed on Person records; no drafts, so awaiting 0",
    day1Room.anchors.email.count === 44 &&
      day1Room.anchors.phone.count === 60 &&
      day1Room.anchors.linkedin.count === 27 &&
      day1Room.awaiting.count === 0,
    `email=${day1Room.anchors.email.count}, phone=${day1Room.anchors.phone.count}, linkedin=${day1Room.anchors.linkedin.count}, awaiting=${day1Room.awaiting.count}`,
  );

  // Guest for guest against the seed world's own Room — not just the sums.
  // (Order-independent: the page groups by status; the seed imports in row
  // order. Person ids differ by construction; name+rsvp pairs must not.)
  const seedWorld: World = {
    entries: readFileSync(join(SEED_OUT, "stream.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Entry),
    persons: JSON.parse(readFileSync(join(SEED_OUT, "persons.json"), "utf8")) as Person[],
    contexts: JSON.parse(readFileSync(join(SEED_OUT, "contexts.json"), "utf8")) as Context[],
    gatherings: JSON.parse(readFileSync(join(SEED_OUT, "gatherings.json"), "utf8")) as Gathering[],
  };
  const seedRoom = deriveRoom(seedWorld, "fogline");
  const pairs = (r: RoomView) => r.guests.map((g) => `${g.name}|${g.rsvp}`).sort();
  const organPairs = pairs(day1Room);
  const seedPairs = pairs(seedRoom);
  const mismatches = organPairs.filter((p, i) => p !== seedPairs[i]);
  check(
    "ROOM from the page (day1): all 78 name/rsvp pairs equal the seed world's own Fogline Room, guest for guest",
    organPairs.length === seedPairs.length && mismatches.length === 0,
    `pairs=${organPairs.length} vs seed=${seedPairs.length}, mismatches=${mismatches.length}${mismatches.length > 0 ? ` (first: ${mismatches[0]})` : ""}`,
  );

  // =====================================================================
  // (b) sweep: day1 again is silent; day2 applies the declared delta
  // =====================================================================
  const noChange = await sweepEvent(vault2, DAY1, IDS, { at: DAY1_AT });
  check(
    "SWEEP: the day1 page swept right after connect finds an empty diff (0 new, 0 changes, 0 appended)",
    noChange.newGuests === 0 && noChange.rsvpChanges === 0 && noChange.appended === 0 && vault2.entries.length === 81,
    `newGuests=${noChange.newGuests}, rsvpChanges=${noChange.rsvpChanges}, appended=${noChange.appended}, entries=${vault2.entries.length}`,
  );

  const swept = await sweepEvent(vault2, DAY2, IDS, { at: DAY2_AT });
  check(
    "SWEEP day2: exactly the fixture's declared delta — 2 new guests, 4 rsvp changes, 6 entries appended (81 -> 87), 80 persons",
    swept.newGuests === 2 &&
      swept.rsvpChanges === 4 &&
      swept.appended === 6 &&
      vault2.entries.length === 87 &&
      vault2.persons.length === 80,
    `newGuests=${swept.newGuests}, rsvpChanges=${swept.rsvpChanges}, appended=${swept.appended}, entries=${vault2.entries.length}, persons=${vault2.persons.length}; ` +
      `changes=[${swept.changes.map((c) => `${c.name}:${c.from}->${c.to}`).join(", ")}]`,
  );

  // Reopen from disk again: the sweep must have persisted.
  const vault3 = openVault(vaultDir);
  const day2Room = deriveRoom(loadWorld(vault3), IDS.gatheringId);
  check(
    "ROOM after sweep (day2): 45/9/7/16/3 of 80 — accepted 41+3-1+2, declined 6+1, no-reply 19-3 (the fixture's hand arithmetic), cross-footed",
    day2Room.statusCounts.accepted.count === 45 &&
      day2Room.statusCounts.tentative.count === 9 &&
      day2Room.statusCounts.declined.count === 7 &&
      day2Room.statusCounts["no-reply"].count === 16 &&
      day2Room.statusCounts.uninvited.count === 3 &&
      day2Room.total.count === 80 &&
      statusSum(day2Room) === 80,
    fmtStatuses(day2Room),
  );
  check(
    "ROOM after sweep (day2): anchors email 45 / phone 61 / linkedin 27 — the two new guests' hints landed",
    day2Room.anchors.email.count === 45 && day2Room.anchors.phone.count === 61 && day2Room.anchors.linkedin.count === 27,
    `email=${day2Room.anchors.email.count}, phone=${day2Room.anchors.phone.count}, linkedin=${day2Room.anchors.linkedin.count}`,
  );
  const rowByName = new Map(day2Room.guests.map((g) => [g.name, g]));
  const daniel = rowByName.get("Daniel Park");
  const divya = rowByName.get("Divya Flores");
  const rina = rowByName.get("Rina Kobayashi");
  const alexei = rowByName.get("Alexei Morozov");
  const sophie = rowByName.get("Sophie Farouk");
  check(
    "ROOM after sweep (day2), named rows: Daniel Park declined VIA AN INTERACTION (the import underneath still says accepted — nothing rewrote); " +
      "Divya Flores accepted; new guests Rina Kobayashi + Alexei Morozov accepted; Sophie Farouk still uninvited",
    daniel?.rsvp === "declined" &&
      /interaction/.test(daniel?.rsvpWhy ?? "") &&
      divya?.rsvp === "accepted" &&
      /interaction/.test(divya?.rsvpWhy ?? "") &&
      rina?.rsvp === "accepted" &&
      alexei?.rsvp === "accepted" &&
      sophie?.rsvp === "uninvited",
    `daniel=${daniel?.rsvp} (${daniel?.rsvpWhy}); divya=${divya?.rsvp}; rina=${rina?.rsvp}; alexei=${alexei?.rsvp}; sophie=${sophie?.rsvp}`,
  );

  // =====================================================================
  // (c) idempotence: the same page swept twice appends nothing
  // =====================================================================
  const sizeBeforeResweep = statSync(streamPath).size;
  const resweep = await sweepEvent(vault3, DAY2, IDS, { at: "2026-10-01T18:00:00.000Z" });
  check(
    "IDEMPOTENT: sweeping day2 a second time appends nothing (0/0/0; stream size unchanged) — the diff is against DERIVED state, not a stored page",
    resweep.appended === 0 && resweep.newGuests === 0 && resweep.rsvpChanges === 0 && statSync(streamPath).size === sizeBeforeResweep,
    `appended=${resweep.appended}, size=${statSync(streamPath).size} (was ${sizeBeforeResweep})`,
  );

  // =====================================================================
  // (d) append-only: the stream only ever grew, prior bytes intact
  // =====================================================================
  const bytesFinal = readFileSync(streamPath);
  check(
    "APPEND-ONLY: across connect and every sweep the stream only grew and the post-connect bytes are an exact prefix of the final stream",
    bytesFinal.length > bytesAfterConnect.length && bytesFinal.subarray(0, bytesAfterConnect.length).equals(bytesAfterConnect),
    `size ${bytesAfterConnect.length} -> ${bytesFinal.length}, prefix intact=${bytesFinal.subarray(0, bytesAfterConnect.length).equals(bytesAfterConnect)}`,
  );

  // =====================================================================
  // (e) malformed and contradictory pages reject loudly, vault untouched
  // =====================================================================
  const eventAttrs = `data-event data-event-title="Fogline — a Tech Week evening" data-event-date="2026-10-07T16:00:00.000Z"`;
  const page = (rows: string) => `<!doctype html><html><body><main ${eventAttrs}>${rows}</main></body></html>`;
  const goodRow = `<div data-guest data-guest-id="pf-good" data-rsvp-status="GOING"><span data-guest-name>Fine Guest</span></div>`;
  const badStatusPath = join(tempRoot, "malformed-status.html");
  writeFileSync(
    badStatusPath,
    page(goodRow + `<div data-guest data-guest-id="pf-bad" data-rsvp-status="WOBBLY"><span data-guest-name>Wobbly Guest</span></div>`),
  );
  const noNamePath = join(tempRoot, "malformed-name.html");
  writeFileSync(noNamePath, page(goodRow + `<div data-guest data-guest-id="pf-anon" data-rsvp-status="GOING"></div>`));
  const dupIdPath = join(tempRoot, "malformed-dup.html");
  writeFileSync(dupIdPath, page(goodRow + goodRow));
  // Sarah Kim (pf-0059) is accepted in the vault; a page claiming she was
  // never invited contradicts the derived state — refuse, don't repair.
  const contradictionPath = join(tempRoot, "contradiction.html");
  writeFileSync(contradictionPath, page(`<div data-guest data-guest-id="pf-0059" data-rsvp-status="ADDED"><span data-guest-name>Sarah Kim</span></div>`));

  const sizeBeforeBad = statSync(streamPath).size;
  const personsBeforeBad = vault3.persons.length;
  await throwsAsync(
    'MALFORMED: an unknown rsvp status word rejects loudly, naming the row ("WOBBLY")',
    () => sweepEvent(vault3, badStatusPath, IDS, { at: DAY2_AT }),
    /unknown rsvp status "WOBBLY"/,
  );
  await throwsAsync(
    "MALFORMED: a row missing its guest name rejects loudly",
    () => sweepEvent(vault3, noNamePath, IDS, { at: DAY2_AT }),
    /missing name/,
  );
  await throwsAsync(
    "MALFORMED: a duplicate guest id rejects loudly (identity must be unambiguous before anything appends)",
    () => sweepEvent(vault3, dupIdPath, IDS, { at: DAY2_AT }),
    /duplicate guest id "pf-good"/,
  );
  await throwsAsync(
    "CONTRADICTION: a known accepted guest shown as added-not-invited refuses the whole sweep before any append (plan-then-append)",
    () => sweepEvent(vault3, contradictionPath, IDS, { at: DAY2_AT }),
    /platforms don't un-invite/,
  );
  await throwsAsync(
    "GUARD: sweeping a context that was never connected refuses",
    () => sweepEvent(vault3, DAY2, { contextId: "never-connected", gatheringId: "nope" }, { at: DAY2_AT }),
    /unknown context "never-connected"/,
  );
  check(
    "UNTOUCHED: every rejected page left the vault exactly as it was (stream size and person count unchanged)",
    statSync(streamPath).size === sizeBeforeBad && vault3.persons.length === personsBeforeBad && vault3.entries.length === 87,
    `size=${statSync(streamPath).size} (was ${sizeBeforeBad}), persons=${vault3.persons.length} (was ${personsBeforeBad}), entries=${vault3.entries.length}`,
  );

  // A malformed page must also fail a CONNECT with the fresh vault untouched.
  const freshDir = join(tempRoot, "fresh-vault");
  const freshVault = openVault(freshDir);
  await throwsAsync(
    "MALFORMED at connect: a bad page fails the first read too, and the fresh vault stays empty",
    () => connectEvent(freshVault, badStatusPath, { contextId: "c2", gatheringId: "g2" }, { at: DAY1_AT }),
    /unknown rsvp status "WOBBLY"/,
  );
  check(
    "UNTOUCHED at connect: the fresh vault has 0 entries, 0 persons, 0 contexts after the rejected connect",
    freshVault.entries.length === 0 && freshVault.persons.length === 0 && freshVault.contexts.length === 0,
    `entries=${freshVault.entries.length}, persons=${freshVault.persons.length}, contexts=${freshVault.contexts.length}`,
  );

  // =====================================================================
  // (f) LUMA: the SAME organs through the luma contract — Ember dinner
  //     #4's Luma-shaped page becomes a fresh vault whose Room reproduces
  //     the seed world's books. One contract shape, two platforms.
  // =====================================================================
  const partifulChecks = results.length;
  const lumaDir = join(tempRoot, "luma-vault");
  const lumaVault = openVault(lumaDir);
  const lumaConnected = await connectEvent(lumaVault, EMBER, EMBER_IDS, {
    at: EMBER_AT,
    operator: "operator",
    contextName: "Ember Dinners",
    platform: "luma",
  });
  check(
    "LUMA CONNECT: ember-04 page imported through the luma contract — 57 guests, 60 entries (3 connect-moment + 57 imports), 57 persons, 1 context (email-anchored, profile luma), 1 gathering",
    lumaConnected.guests === 57 &&
      lumaConnected.entries === 60 &&
      lumaVault.entries.length === 60 &&
      lumaVault.persons.length === 57 &&
      lumaVault.contexts.length === 1 &&
      lumaVault.contexts[0].anchor === "email" &&
      lumaVault.contexts[0].profile === "luma" &&
      lumaVault.gatherings.length === 1,
    `report guests=${lumaConnected.guests}, entries=${lumaConnected.entries}; vault entries=${lumaVault.entries.length}, persons=${lumaVault.persons.length}, ` +
      `contexts=${lumaVault.contexts.length} (anchor=${lumaVault.contexts[0]?.anchor}, profile=${lumaVault.contexts[0]?.profile}), gatherings=${lumaVault.gatherings.length}`,
  );

  // Reopen FROM DISK, same law as (a): the Room reads the persisted vault.
  const lumaVault2 = openVault(lumaDir);
  const emberRoom = deriveRoom(loadWorld(lumaVault2), EMBER_IDS.gatheringId);
  check(
    "LUMA ROOM from the page: 19/0/6/15/17 of 57 — the seed world's Ember dinner #4 books (§3.2), reproduced FROM A LUMA-SHAPED PAGE, cross-footed",
    emberRoom.statusCounts.accepted.count === 19 &&
      emberRoom.statusCounts.tentative.count === 0 &&
      emberRoom.statusCounts.declined.count === 6 &&
      emberRoom.statusCounts["no-reply"].count === 15 &&
      emberRoom.statusCounts.uninvited.count === 17 &&
      emberRoom.total.count === 57 &&
      emberRoom.guests.length === 57 &&
      statusSum(emberRoom) === emberRoom.total.count,
    fmtStatuses(emberRoom),
  );
  check(
    "LUMA ROOM from the page: anchors email 57 / phone 12 / linkedin 41 (§7.2) — luma attribute names landed as Person anchors; no drafts, so awaiting 0",
    emberRoom.anchors.email.count === 57 &&
      emberRoom.anchors.phone.count === 12 &&
      emberRoom.anchors.linkedin.count === 41 &&
      emberRoom.awaiting.count === 0,
    `email=${emberRoom.anchors.email.count}, phone=${emberRoom.anchors.phone.count}, linkedin=${emberRoom.anchors.linkedin.count}, awaiting=${emberRoom.awaiting.count}`,
  );

  // Guest for guest against the seed world's own Ember #4 Room — not just
  // the sums (same law as (a); order-independent, name+rsvp pairs).
  const emberSeedRoom = deriveRoom(seedWorld, "dinner-4");
  const emberOrganPairs = pairs(emberRoom);
  const emberSeedPairs = pairs(emberSeedRoom);
  const emberMismatches = emberOrganPairs.filter((p, i) => p !== emberSeedPairs[i]);
  check(
    "LUMA ROOM from the page: all 57 name/rsvp pairs equal the seed world's own Ember #4 Room, guest for guest",
    emberOrganPairs.length === emberSeedPairs.length && emberMismatches.length === 0,
    `pairs=${emberOrganPairs.length} vs seed=${emberSeedPairs.length}, mismatches=${emberMismatches.length}${emberMismatches.length > 0 ? ` (first: ${emberMismatches[0]})` : ""}`,
  );

  // The context remembers its platform: reading it through the other
  // platform's contract is a category error, refused before the page opens.
  await throwsAsync(
    "GUARD: sweeping the luma-connected context through the partiful contract refuses (context.profile remembers the platform)",
    () => sweepEvent(lumaVault2, EMBER, EMBER_IDS, { at: EMBER_AT }),
    /connected as luma, not partiful/,
  );

  // =====================================================================
  // (g) the partiful checks all still pass — rerun above, this same file
  // =====================================================================
  const partifulFailures = results.slice(0, partifulChecks).filter((r) => !r.pass);
  check(
    `PARTIFUL UNCHANGED: all ${partifulChecks} partiful checks above ((a)-(e), same file, same fixtures) still pass beside the luma contract`,
    partifulFailures.length === 0,
    `failures=${partifulFailures.length}${partifulFailures.length > 0 ? ` (first: ${partifulFailures[0].name})` : ""}`,
  );

  // =====================================================================
  // Report
  // =====================================================================
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
}

main().catch((err) => {
  console.error(`check.ts: crashed (temp vault kept at ${vaultDir}):`, err);
  process.exit(1);
});
