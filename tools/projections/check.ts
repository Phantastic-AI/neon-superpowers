#!/usr/bin/env -S npx tsx
// Projection-contract cross-check — derives The Room and the queue from the
// PERSISTED seed world under tools/seed-world/out/ (never from in-memory
// build objects) and asserts every figure against the spec's worked
// arithmetic (superpowers/docs/seed-world.md §3.2/§4.2/§7.2/§10.2) and
// against ground-truth counts of the underlying entries computed
// independently in this file. Exit nonzero, naming the failing figure, on
// any miss. Nothing is fudged to make a check pass.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Entry, Person, Context, Gathering, Figure, RsvpStatus, RoomView, QueueView, World } from "./types.js";
import { deriveRoom } from "./room.js";
import { deriveQueue } from "./queue.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "seed-world", "out");

if (!existsSync(OUT_DIR)) {
  console.error(`check.ts: no seed world found at ${OUT_DIR} — run tools/seed-world/generate.ts first.`);
  process.exit(1);
}

function readJson<T>(relPath: string): T {
  return JSON.parse(readFileSync(join(OUT_DIR, relPath), "utf8")) as T;
}
function readJsonl<T>(relPath: string): T[] {
  const raw = readFileSync(join(OUT_DIR, relPath), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

const entries = readJsonl<Entry>("stream.jsonl");
const world: World = {
  entries,
  persons: readJson<Person[]>("persons.json"),
  contexts: readJson<Context[]>("contexts.json"),
  gatherings: readJson<Gathering[]>("gatherings.json"),
};

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
}

const fmtStatuses = (r: RoomView) =>
  `accepted=${r.statusCounts.accepted.count}, tentative=${r.statusCounts.tentative.count}, declined=${r.statusCounts.declined.count}, ` +
  `no-reply=${r.statusCounts["no-reply"].count}, uninvited=${r.statusCounts.uninvited.count}, total=${r.total.count}`;
const statusSum = (r: RoomView) =>
  (["accepted", "tentative", "declined", "no-reply", "uninvited"] as RsvpStatus[]).reduce((s, k) => s + r.statusCounts[k].count, 0);

// =======================================================================
// Independent ground truths — computed here, from the raw entries, without
// touching room.ts/queue.ts internals.
// =======================================================================

/** Independent RSVP fold for any event context (mirrors C7/C8 arithmetic). */
function inlineRoomCounts(ctx: string, gatheringId: string, maxCursor: number) {
  const es = entries.filter((e) => e.cursor <= maxCursor && e.context === ctx);
  const roster = new Set<string>();
  for (const e of es) if (e.type === "imported" && e.subtype === "guest") for (const p of e.persons ?? []) roster.add(p);
  const counts: Record<string, number> = { accepted: 0, tentative: 0, declined: 0, "no-reply": 0, uninvited: 0 };
  for (const id of roster) {
    const imp = es.find((e) => e.type === "imported" && e.subtype === "guest" && e.about === gatheringId && (e.persons ?? []).includes(id));
    let s = ((imp?.payload as Record<string, unknown> | undefined)?.rsvp as string | undefined) ?? "uninvited";
    const landed = es.some(
      (e) => e.type === "landed" && e.about === gatheringId && (e.payload as Record<string, unknown>)?.kind === "invite" && (e.persons ?? []).includes(id),
    );
    if (landed && s === "uninvited") s = "no-reply";
    let latest: Entry | undefined;
    for (const e of es) {
      if (e.type === "interaction" && e.about === gatheringId && (e.persons ?? []).includes(id) && typeof (e.payload as Record<string, unknown>)?.response === "string")
        latest = e;
    }
    if (latest) s = (latest.payload as Record<string, unknown>).response as string;
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return { roster: roster.size, counts };
}

/** Independent draft-lifecycle count (the queue's ground truth). */
function inlineQueueCounts(maxCursor: number, ctxFilter?: string, aboutFilter?: string) {
  const es = entries.filter((e) => e.cursor <= maxCursor);
  const proposed = es.filter(
    (e) => e.type === "proposed" && (ctxFilter === undefined || e.context === ctxFilter) && (aboutFilter === undefined || e.about === aboutFilter),
  );
  const matches = (p: Entry, e: Entry): boolean => {
    if (e.context !== p.context) return false;
    const pDraft = (p.payload as Record<string, unknown>)?.draft;
    if (pDraft !== undefined) return (e.payload as Record<string, unknown>)?.draft === pDraft;
    return (
      (e.persons ?? [])[0] === (p.persons ?? [])[0] &&
      e.about === p.about &&
      (e.payload as Record<string, unknown>)?.kind === (p.payload as Record<string, unknown>)?.kind
    );
  };
  const out = { proposed: proposed.length, queued: 0, approved: 0, released: 0, landed: 0 };
  for (const p of proposed) {
    if (es.some((e) => e.type === "landed" && matches(p, e))) out.landed += 1;
    else if (es.some((e) => e.type === "released" && matches(p, e))) out.released += 1;
    else if (es.some((e) => e.type === "approved" && e.subtype === "draft" && matches(p, e))) out.approved += 1;
    else out.queued += 1;
  }
  return out;
}

const LAST_CURSOR = entries[entries.length - 1].cursor;

// =======================================================================
// The Room — Fogline (spec §4.2, §7.2, §4.4)
// =======================================================================
const fogline = deriveRoom(world, "fogline");
check(
  "ROOM Fogline: derives 41/9/6/19/3 of 78 (§4.2), cross-footed",
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
const foglineInline = inlineRoomCounts("fogline", "fogline-event", LAST_CURSOR);
check(
  "ROOM Fogline: equals an independent count of the underlying entries",
  fogline.total.count === foglineInline.roster &&
    (["accepted", "tentative", "declined", "no-reply", "uninvited"] as RsvpStatus[]).every(
      (s) => fogline.statusCounts[s].count === foglineInline.counts[s],
    ),
  `independent: roster=${foglineInline.roster}, ${JSON.stringify(foglineInline.counts)}`,
);
check(
  "ROOM Fogline anchors: email 44, phone 60, linkedin 27 (§7.2, matches seed world's own figures)",
  fogline.anchors.email.count === 44 && fogline.anchors.phone.count === 60 && fogline.anchors.linkedin.count === 27,
  `email=${fogline.anchors.email.count}, phone=${fogline.anchors.phone.count}, linkedin=${fogline.anchors.linkedin.count}`,
);
const foglineLookupReceipts = entries.filter((e) => e.context === "fogline" && e.type === "fact" && e.subtype === "lookup").length;
check(
  "ROOM Fogline meter: 119 consumed / 881 remain of 1,000 (§4.4), a projection over receipts",
  fogline.lookups.consumed.count === 119 && fogline.lookups.remaining === 881 && fogline.lookups.consumed.count === foglineLookupReceipts,
  `consumed=${fogline.lookups.consumed.count} (independent receipt count=${foglineLookupReceipts}), remaining=${fogline.lookups.remaining}`,
);
check(
  "ROOM Fogline: no series split (a one-time event has no earlier gatherings)",
  fogline.series === undefined,
  `series=${fogline.series === undefined ? "absent" : "present"}`,
);

// =======================================================================
// The Room — Ember dinner #4 (spec §3.2, C5/C7, §7.2, §3.3)
// =======================================================================
const ember = deriveRoom(world, "dinner-4");
check(
  "ROOM Ember dinner #4: derives 19/6/15/17 of 57, tentative 0 (§3.2), cross-footed",
  ember.statusCounts.accepted.count === 19 &&
    ember.statusCounts.declined.count === 6 &&
    ember.statusCounts["no-reply"].count === 15 &&
    ember.statusCounts.uninvited.count === 17 &&
    ember.statusCounts.tentative.count === 0 &&
    ember.total.count === 57 &&
    statusSum(ember) === 57,
  fmtStatuses(ember),
);
const emberInline = inlineRoomCounts("ember-dinners", "dinner-4", LAST_CURSOR);
check(
  "ROOM Ember: equals an independent count of the underlying entries",
  ember.total.count === emberInline.roster &&
    (["accepted", "tentative", "declined", "no-reply", "uninvited"] as RsvpStatus[]).every((s) => ember.statusCounts[s].count === emberInline.counts[s]),
  `independent: roster=${emberInline.roster}, ${JSON.stringify(emberInline.counts)}`,
);
check(
  "ROOM Ember series memory: returning 45 / first-timers 12; accepted 19 = 14 returning + 5 first-time (C5/C7)",
  ember.series !== undefined &&
    ember.series.returning.count === 45 &&
    ember.series.firstTimers.count === 12 &&
    ember.series.acceptedReturning.count === 14 &&
    ember.series.acceptedFirstTimers.count === 5,
  ember.series
    ? `returning=${ember.series.returning.count}, first-timers=${ember.series.firstTimers.count}, accepted split=${ember.series.acceptedReturning.count}+${ember.series.acceptedFirstTimers.count}`
    : "series split missing",
);
check(
  "ROOM Ember anchors: email 57, phone 12, linkedin 41 (§7.2)",
  ember.anchors.email.count === 57 && ember.anchors.phone.count === 12 && ember.anchors.linkedin.count === 41,
  `email=${ember.anchors.email.count}, phone=${ember.anchors.phone.count}, linkedin=${ember.anchors.linkedin.count}`,
);
const emberLookupReceipts = entries.filter((e) => e.context === "ember-dinners" && e.type === "fact" && e.subtype === "lookup").length;
check(
  "ROOM Ember meter: 76 consumed / 924 remain of 1,000 (§3.3), a projection over receipts",
  ember.lookups.consumed.count === 76 && ember.lookups.remaining === 924 && ember.lookups.consumed.count === emberLookupReceipts,
  `consumed=${ember.lookups.consumed.count} (independent receipt count=${emberLookupReceipts}), remaining=${ember.lookups.remaining}`,
);

// =======================================================================
// The queue — whole vault and per scope (§10.2, §12 timeline, C9/C12)
// =======================================================================
const queueAll = deriveQueue(world, "all");
const queueAllInline = inlineQueueCounts(LAST_CURSOR);
check(
  "QUEUE all: 105 drafts = 40 Ember + 27 Fogline + 38 LinkedIn (§10.2); queued 12, landed 93; cross-footed",
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
check(
  "QUEUE all: equals an independent count of the underlying entries",
  queueAll.counts.proposed.count === queueAllInline.proposed &&
    queueAll.counts.queued.count === queueAllInline.queued &&
    queueAll.counts.approved.count === queueAllInline.approved &&
    queueAll.counts.released.count === queueAllInline.released &&
    queueAll.counts.landed.count === queueAllInline.landed,
  `independent: ${JSON.stringify(queueAllInline)}`,
);

const queueFogline = deriveQueue(world, "fogline-event");
const queueFoglineInline = inlineQueueCounts(LAST_CURSOR, "fogline", "fogline-event");
check(
  "QUEUE Fogline: 27 drafts, 3 queued, 24 landed (C9; §12: 'Queue holds 3 Fogline')",
  queueFogline.rows.length === 27 &&
    queueFogline.counts.queued.count === 3 &&
    queueFogline.counts.landed.count === 24 &&
    queueFogline.counts.queued.count === queueFoglineInline.queued &&
    queueFogline.counts.landed.count === queueFoglineInline.landed,
  `proposed=${queueFogline.rows.length}, queued=${queueFogline.counts.queued.count}, landed=${queueFogline.counts.landed.count} (independent: ${JSON.stringify(queueFoglineInline)})`,
);
const queueLinkedIn = deriveQueue(world, "meeras-linkedin");
const queueLinkedInInline = inlineQueueCounts(LAST_CURSOR, "meeras-linkedin");
check(
  "QUEUE LinkedIn: 38 drafts, 9 undecided, 29 landed (C12; the spec's 4-queued/5-lapsed split is underivable — README gaps)",
  queueLinkedIn.rows.length === 38 &&
    queueLinkedIn.counts.queued.count === 9 &&
    queueLinkedIn.counts.landed.count === 29 &&
    queueLinkedIn.counts.queued.count === queueLinkedInInline.queued,
  `proposed=${queueLinkedIn.rows.length}, queued=${queueLinkedIn.counts.queued.count}, landed=${queueLinkedIn.counts.landed.count} (independent: ${JSON.stringify(queueLinkedInInline)})`,
);
const queueEmber = deriveQueue(world, "dinner-4");
check(
  "QUEUE Ember dinner #4: 40 drafts, 0 queued, 40 landed (C7: all invites approved and verified)",
  queueEmber.rows.length === 40 && queueEmber.counts.queued.count === 0 && queueEmber.counts.landed.count === 40,
  `proposed=${queueEmber.rows.length}, queued=${queueEmber.counts.queued.count}, landed=${queueEmber.counts.landed.count}`,
);

// =======================================================================
// Cross-surface agreement — the queue's queued count and the Room's
// "awaiting your yes" are the same fact read twice (SOCIAL-1 / LOOP-1
// crossTruths: "they must agree to the digit"). room.ts derives its figure
// via deriveQueue, so this can only fail if that wiring breaks.
// =======================================================================
check(
  "CROSS-SURFACE: queue queued == Room awaiting — Fogline 3, Ember 0 — against independent ground truth",
  fogline.awaiting.count === queueFogline.counts.queued.count &&
    fogline.awaiting.count === queueFoglineInline.queued &&
    fogline.awaiting.count === 3 &&
    ember.awaiting.count === queueEmber.counts.queued.count &&
    ember.awaiting.count === 0,
  `fogline: room=${fogline.awaiting.count}, queue=${queueFogline.counts.queued.count}, independent=${queueFoglineInline.queued}; ember: room=${ember.awaiting.count}, queue=${queueEmber.counts.queued.count}`,
);
check(
  "CROSS-SURFACE: queue landed == Room sent-and-verified figure (LOOP-1 crossTruth shape)",
  fogline.landed.count === queueFogline.counts.landed.count && ember.landed.count === queueEmber.counts.landed.count,
  `fogline room=${fogline.landed.count}/queue=${queueFogline.counts.landed.count}; ember room=${ember.landed.count}/queue=${queueEmber.counts.landed.count}`,
);

// =======================================================================
// Time is a cursor — derive mid-stream and match an independent count of
// entries at-or-before that cursor.
// =======================================================================
const MID = 550;
const foglineMid = deriveRoom(world, "fogline", MID);
const foglineMidInline = inlineRoomCounts("fogline", "fogline-event", MID);
check(
  `CURSOR: Fogline Room @${MID} equals an independent count over entries with cursor<=${MID}`,
  foglineMid.cursor === MID &&
    foglineMid.total.count === foglineMidInline.roster &&
    (["accepted", "tentative", "declined", "no-reply", "uninvited"] as RsvpStatus[]).every(
      (s) => foglineMid.statusCounts[s].count === foglineMidInline.counts[s],
    ) &&
    statusSum(foglineMid) === foglineMid.total.count,
  `derived: ${fmtStatuses(foglineMid)}; independent: roster=${foglineMidInline.roster}, ${JSON.stringify(foglineMidInline.counts)}`,
);
check(
  `CURSOR: the cursor bites — Fogline Room @${MID} differs from the full-stream Room`,
  (["accepted", "tentative", "declined", "no-reply", "uninvited"] as RsvpStatus[]).some(
    (s) => foglineMid.statusCounts[s].count !== fogline.statusCounts[s].count,
  ),
  `@${MID}: ${fmtStatuses(foglineMid)} vs full: ${fmtStatuses(fogline)}`,
);
const queueMid = deriveQueue(world, "fogline-event", MID);
const queueMidInline = inlineQueueCounts(MID, "fogline", "fogline-event");
check(
  `CURSOR: Fogline queue @${MID} equals an independent count over entries with cursor<=${MID}`,
  queueMid.rows.length === queueMidInline.proposed &&
    queueMid.counts.queued.count === queueMidInline.queued &&
    queueMid.counts.approved.count === queueMidInline.approved &&
    queueMid.counts.released.count === queueMidInline.released &&
    queueMid.counts.landed.count === queueMidInline.landed &&
    queueMid.rows.length !== queueFogline.rows.length,
  `derived: proposed=${queueMid.rows.length}, queued=${queueMid.counts.queued.count}, approved=${queueMid.counts.approved.count}, released=${queueMid.counts.released.count}, landed=${queueMid.counts.landed.count}; independent: ${JSON.stringify(queueMidInline)} (full-stream rows=${queueFogline.rows.length})`,
);
check(
  `CURSOR: Room@${MID} awaiting == queue@${MID} queued (agreement holds at every cursor)`,
  foglineMid.awaiting.count === queueMid.counts.queued.count,
  `room=${foglineMid.awaiting.count}, queue=${queueMid.counts.queued.count}`,
);

// =======================================================================
// Introspection — every figure explains itself.
// =======================================================================
function figuresOf(room: RoomView): Figure[] {
  const figs: Figure[] = [room.total, room.awaiting, room.landed, room.lookups.consumed, ...Object.values(room.statusCounts)];
  figs.push(room.anchors.email, room.anchors.phone, room.anchors.linkedin);
  if (room.series) figs.push(room.series.returning, room.series.firstTimers, room.series.acceptedReturning, room.series.acceptedFirstTimers);
  return figs;
}
function figuresOfQueue(q: QueueView): Figure[] {
  return Object.values(q.counts);
}
const allFigures = [...figuresOf(fogline), ...figuresOf(ember), ...figuresOf(foglineMid), ...figuresOfQueue(queueAll), ...figuresOfQueue(queueFogline), ...figuresOfQueue(queueMid)];
const badFigures = allFigures.filter(
  (f) => f.count < 0 || f.filter.length === 0 || (f.source === "entries" && (!f.entryTypes || f.entryTypes.length === 0)) || (f.source === "persons" && f.entryTypes !== undefined),
);
const rowsWithoutWhy = [...fogline.guests, ...ember.guests].filter((g) => g.rsvpWhy.length === 0);
const rowsWithoutLifecycle = queueAll.rows.filter((r) => r.lifecycle.proposed !== r.id);
check(
  "INTROSPECT: every figure carries provenance (entry types + filter); every row names its deciding entries",
  badFigures.length === 0 && rowsWithoutWhy.length === 0 && rowsWithoutLifecycle.length === 0,
  `figures checked=${allFigures.length} (bad=${badFigures.length}), guest rows without rsvpWhy=${rowsWithoutWhy.length}, queue rows with broken lifecycle ref=${rowsWithoutLifecycle.length}`,
);

// =======================================================================
// Report
// =======================================================================
const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
}
console.log("");
const rowsWithText = queueAll.rows.filter((r) => r.text !== undefined).length;
console.log(
  `note: ${rowsWithText}/${queueAll.rows.length} queue rows carry outbound text — the seed world's draft entries hold none (README gaps; no fixture invented here).`,
);
if (failed.length > 0) {
  console.error(`check.ts: ${failed.length} of ${results.length} checks FAILED:`);
  for (const r of failed) console.error(`  - ${r.name}: ${r.detail}`);
  process.exit(1);
}
console.log(`check.ts: all ${results.length} checks passed.`);
