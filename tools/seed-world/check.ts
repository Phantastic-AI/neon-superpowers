#!/usr/bin/env -S npx tsx
// Seed-world self-check — verifies C1-C17 (superpowers/docs/seed-world.md
// §11) plus the structural invariants from the build contract, by READING
// the persisted artifact under out/ (never the generator's in-memory
// objects) — a true self-check of what actually got written.
//
// Exit nonzero, naming the failing equation, on any miss (rebuild contract
// #5). Every check runs; failures are collected and reported together.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Entry, Person, Context, Grant, PlatformFixture } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "out");

if (!existsSync(OUT_DIR)) {
  console.error(`check.ts: no build found at ${OUT_DIR} — run generate.ts first.`);
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
const persons = readJson<Person[]>("persons.json");
const contexts = readJson<Context[]>("contexts.json");
const grants = readJson<Grant[]>("grants.json");
const luma = readJson<PlatformFixture>(join("platform", "luma.json"));
const partiful = readJson<PlatformFixture>(join("platform", "partiful.json"));

const CTX = {
  ember: "ember-dinners",
  fogline: "fogline",
  linkedin: "meeras-linkedin",
  public: "public",
  systemHome: "system-home",
};

const personById = new Map(persons.map((p) => [p.id, p]));
const contextIds = new Set(contexts.map((c) => c.id));
const entryById = new Map(entries.map((e) => [e.id, e]));

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------
function entriesIn(ctx: string, type?: string, subtype?: string): Entry[] {
  return entries.filter(
    (e) => e.context === ctx && (type === undefined || e.type === type) && (subtype === undefined || e.subtype === subtype),
  );
}
function distinctPersonIds(es: Entry[]): Set<string> {
  const s = new Set<string>();
  for (const e of es) for (const p of e.persons ?? []) s.add(p);
  return s;
}
function personIdsWithGuestImport(ctx: string): Set<string> {
  return distinctPersonIds(entriesIn(ctx, "imported", "guest"));
}

// =======================================================================
// §10.2 audit table — the two independent decompositions of 964
// =======================================================================
const CTX_KEYS = ["ember", "fogline", "linkedin", "public", "systemHome"] as const;
type CtxKey = (typeof CTX_KEYS)[number];
const CTX_ID: Record<CtxKey, string> = { ember: CTX.ember, fogline: CTX.fogline, linkedin: CTX.linkedin, public: CTX.public, systemHome: CTX.systemHome };

const AUDIT_ROWS: { label: string; type: string; subtype?: string; ember: number; fogline: number; linkedin: number; public: number; systemHome: number }[] = [
  { label: "context-created", type: "context", subtype: "created", ember: 1, fogline: 1, linkedin: 1, public: 1, systemHome: 0 },
  { label: "anchor-declared", type: "anchor", subtype: "declared", ember: 1, fogline: 1, linkedin: 1, public: 1, systemHome: 0 },
  { label: "consented-public", type: "consented", ember: 0, fogline: 0, linkedin: 0, public: 1, systemHome: 0 },
  { label: "grant-issued (app scope)", type: "granted", subtype: "appscope", ember: 1, fogline: 1, linkedin: 1, public: 0, systemHome: 0 },
  { label: "grant-issued (disclosure)", type: "granted", subtype: "disclosure", ember: 1, fogline: 0, linkedin: 0, public: 0, systemHome: 0 },
  { label: "grant-issued (supervision)", type: "granted", subtype: "supervision", ember: 0, fogline: 0, linkedin: 0, public: 0, systemHome: 1 },
  { label: "supervision join / end", type: "session", ember: 0, fogline: 0, linkedin: 0, public: 0, systemHome: 2 },
  { label: "guest-imported", type: "imported", subtype: "guest", ember: 78, fogline: 78, linkedin: 0, public: 0, systemHome: 0 },
  { label: "Fact — attendance", type: "fact", subtype: "attendance", ember: 66, fogline: 0, linkedin: 0, public: 0, systemHome: 0 },
  { label: "Fact — lookup", type: "fact", subtype: "lookup", ember: 76, fogline: 119, linkedin: 0, public: 0, systemHome: 0 },
  { label: "Fact — sighting", type: "fact", subtype: "sighting", ember: 0, fogline: 0, linkedin: 20, public: 0, systemHome: 0 },
  { label: "Interaction", type: "interaction", ember: 25, fogline: 21, linkedin: 26, public: 0, systemHome: 0 },
  { label: "merge-confirmed", type: "merged", ember: 0, fogline: 9, linkedin: 20, public: 9, systemHome: 0 },
  { label: "draft-proposed", type: "proposed", ember: 40, fogline: 27, linkedin: 38, public: 0, systemHome: 0 },
  { label: "draft-approved", type: "approved", subtype: "draft", ember: 40, fogline: 24, linkedin: 29, public: 0, systemHome: 0 },
  { label: "draft-released", type: "released", ember: 40, fogline: 24, linkedin: 29, public: 0, systemHome: 0 },
  { label: "verified-landed", type: "landed", ember: 40, fogline: 24, linkedin: 29, public: 0, systemHome: 0 },
  { label: "session-healed", type: "healed", ember: 0, fogline: 1, linkedin: 0, public: 0, systemHome: 0 },
  { label: "plan-approved", type: "approved", subtype: "plan", ember: 1, fogline: 1, linkedin: 0, public: 0, systemHome: 0 },
  { label: "Listing", type: "listing", ember: 0, fogline: 0, linkedin: 0, public: 2, systemHome: 0 },
  { label: "Follow", type: "follow", ember: 0, fogline: 0, linkedin: 0, public: 12, systemHome: 0 },
];

const colTotals: Record<CtxKey, number> = { ember: 0, fogline: 0, linkedin: 0, public: 0, systemHome: 0 };
const rowMismatches: string[] = [];
let rowSumTotal = 0;
for (const row of AUDIT_ROWS) {
  let rowSum = 0;
  for (const key of CTX_KEYS) {
    const actual = entriesIn(CTX_ID[key], row.type, row.subtype).length;
    const expected = row[key];
    rowSum += actual;
    colTotals[key] += actual;
    if (actual !== expected) {
      rowMismatches.push(`${row.label} / ${key}: expected ${expected}, got ${actual}`);
    }
  }
  rowSumTotal += rowSum;
}
const colTotal964 = CTX_KEYS.reduce((sum, k) => sum + colTotals[k], 0);
check(
  "AUDIT §10.2 (both decompositions)",
  rowMismatches.length === 0 && rowSumTotal === 964 && colTotal964 === 964 && entries.length === 964,
  rowMismatches.length
    ? `${rowMismatches.length} cell mismatch(es): ${rowMismatches.slice(0, 10).join("; ")}`
    : `row-sum=${rowSumTotal}, column-sum=${colTotal964}, total entries in stream=${entries.length} (all must equal 964)`,
);
check(
  "AUDIT context totals (410/331/194/26/3)",
  colTotals.ember === 410 && colTotals.fogline === 331 && colTotals.linkedin === 194 && colTotals.public === 26 && colTotals.systemHome === 3,
  `ember=${colTotals.ember}, fogline=${colTotals.fogline}, linkedin=${colTotals.linkedin}, public=${colTotals.public}, systemHome=${colTotals.systemHome}`,
);

// =======================================================================
// Overlap / headcount primitives, reused by C1-C4
// =======================================================================
const emberPersonIds = personIdsWithGuestImport(CTX.ember); // 57
const foglinePersonIds = personIdsWithGuestImport(CTX.fogline); // 78
const sharedIds = new Set([...emberPersonIds].filter((id) => foglinePersonIds.has(id))); // reused/merged (9)

const HELD_NAMES = new Set(["Daniel Park", "Sarah Kim", "David Nguyen", "Priya Patel", "Emily Zhang", "Omar Hassan"]);
let heldPairCount = 0;
for (const name of HELD_NAMES) {
  const emberMatch = [...emberPersonIds].some((id) => personById.get(id)?.name === name);
  const foglineMatch = [...foglinePersonIds].some((id) => personById.get(id)?.name === name);
  const emberId = [...emberPersonIds].find((id) => personById.get(id)?.name === name);
  const foglineId = [...foglinePersonIds].find((id) => personById.get(id)?.name === name);
  if (emberMatch && foglineMatch && emberId !== foglineId) heldPairCount += 1;
}
const overlap = sharedIds.size + heldPairCount; // should be 15

// =======================================================================
// C1-C17
// =======================================================================

// C1
const c1 = emberPersonIds.size + foglinePersonIds.size - overlap;
check(
  "C1 distinct event guests: 57+78-15=120",
  emberPersonIds.size === 57 && foglinePersonIds.size === 78 && overlap === 15 && c1 === 120,
  `ember=${emberPersonIds.size}, fogline=${foglinePersonIds.size}, overlap=${overlap} (shared-id=${sharedIds.size}, held-pairs=${heldPairCount}), total=${c1}`,
);

// C2
const followPersonIds = distinctPersonIds(entriesIn(CTX.public, "follow"));
const mergedInPublicIds = distinctPersonIds(entriesIn(CTX.public, "merged"));
const publicOnlyIds = new Set([...followPersonIds].filter((id) => !mergedInPublicIds.has(id)));
const c2 = c1 + publicOnlyIds.size;
check(
  "C2 humans represented: 120+3=123",
  publicOnlyIds.size === 3 && c2 === 123,
  `public-only=${publicOnlyIds.size}, total=${c2}`,
);

// C3
const c3 = c2 + heldPairCount;
check(
  "C3 Person records: 123+6=129",
  c3 === 129 && persons.length === 129,
  `humans=${c2} + held-pairs=${heldPairCount} = ${c3}; persons.json has ${persons.length}`,
);

// C4
const mergedInLinkedInIds = distinctPersonIds(entriesIn(CTX.linkedin, "merged"));
const spans = 15 + mergedInLinkedInIds.size + mergedInPublicIds.size;
const mergesTotal = entries.filter((e) => e.type === "merged").length;
const mergesFogline = entriesIn(CTX.fogline, "merged").length;
const mergesLinkedIn = entriesIn(CTX.linkedin, "merged").length;
const mergesPublic = entriesIn(CTX.public, "merged").length;
check(
  "C4 cross-context spans 15+20+9=44; merges 44-6=38=9+20+9",
  mergedInLinkedInIds.size === 20 &&
    mergedInPublicIds.size === 9 &&
    spans === 44 &&
    mergesTotal === 38 &&
    spans - heldPairCount === 38 &&
    mergesFogline === 9 &&
    mergesLinkedIn === 20 &&
    mergesPublic === 9,
  `spans=15+${mergedInLinkedInIds.size}+${mergedInPublicIds.size}=${spans}; merges total=${mergesTotal} (fogline=${mergesFogline}, linkedin=${mergesLinkedIn}, public=${mergesPublic})`,
);

// C5 / C6 — series attendance and returning-guest arithmetic
const attendanceFacts = entriesIn(CTX.ember, "fact", "attendance");
const dinnerAttendees: Record<string, Set<string>> = { "dinner-1": new Set(), "dinner-2": new Set(), "dinner-3": new Set() };
for (const e of attendanceFacts) {
  if (e.about && dinnerAttendees[e.about]) for (const p of e.persons ?? []) dinnerAttendees[e.about].add(p);
}
const firstAttendedOffset = new Map<string, number>();
const dinnerOffset: Record<string, number> = { "dinner-1": 1, "dinner-2": 2, "dinner-3": 3 };
for (const [dinner, ids] of Object.entries(dinnerAttendees)) {
  for (const id of ids) {
    const off = dinnerOffset[dinner];
    if (!firstAttendedOffset.has(id) || off < firstAttendedOffset.get(id)!) firstAttendedOffset.set(id, off);
  }
}
const slots1 = dinnerAttendees["dinner-1"].size;
const slots2 = dinnerAttendees["dinner-2"].size;
const slots3 = dinnerAttendees["dinner-3"].size;
const firstTime2 = [...dinnerAttendees["dinner-2"]].filter((id) => firstAttendedOffset.get(id) === 2).length;
const firstTime3 = [...dinnerAttendees["dinner-3"]].filter((id) => firstAttendedOffset.get(id) === 3).length;
const returning2 = slots2 - firstTime2;
const returning3 = slots3 - firstTime3;
const distinctPastAttendees = new Set([...dinnerAttendees["dinner-1"], ...dinnerAttendees["dinner-2"], ...dinnerAttendees["dinner-3"]]);
check(
  "C5 series attendance: 18+22+26=66 slots; 45 distinct; returning 21=9+12",
  slots1 === 18 &&
    slots2 === 22 &&
    slots3 === 26 &&
    distinctPastAttendees.size === 45 &&
    returning2 === 9 &&
    returning3 === 12 &&
    slots1 + slots2 + slots3 - distinctPastAttendees.size === 21,
  `slots=${slots1}+${slots2}+${slots3}=${slots1 + slots2 + slots3}; distinct=${distinctPastAttendees.size}; returning@d2=${returning2}, returning@d3=${returning3}`,
);

const emberFreshIds = new Set([...emberPersonIds].filter((id) => !distinctPastAttendees.has(id)));
const c6 = distinctPastAttendees.size + emberFreshIds.size;
check(
  "C6 series Persons: 45+12=57",
  emberFreshIds.size === 12 && c6 === 57 && c6 === emberPersonIds.size,
  `past=${distinctPastAttendees.size}, fresh=${emberFreshIds.size}, total=${c6}`,
);

// C7 — dinner #4 invite arithmetic
const d4Invited = distinctPersonIds(entries.filter((e) => e.context === CTX.ember && e.type === "proposed" && e.about === "dinner-4" && (e.payload as any)?.kind === "invite"));
const d4Responses = entriesIn(CTX.ember, "interaction").filter((e) => e.about === "dinner-4");
const d4Accepted = d4Responses.filter((e) => (e.payload as any).response === "accepted");
const d4Declined = d4Responses.filter((e) => (e.payload as any).response === "declined");
const d4NoReply = d4Invited.size - d4Responses.length;
const d4Uninvited = emberPersonIds.size - d4Invited.size;
const acceptedReturning = d4Accepted.filter((e) => distinctPastAttendees.has((e.persons ?? [])[0])).length;
const acceptedFresh = d4Accepted.length - acceptedReturning;
check(
  "C7 dinner #4: sent 40=19+6+15; uninvited 17=57-40=45-28; accepted 19=14+5",
  d4Invited.size === 40 &&
    d4Accepted.length === 19 &&
    d4Declined.length === 6 &&
    d4NoReply === 15 &&
    d4Uninvited === 17 &&
    d4Uninvited === 45 - 28 &&
    acceptedReturning === 14 &&
    acceptedFresh === 5,
  `invited=${d4Invited.size}, accepted=${d4Accepted.length} (returning=${acceptedReturning}, fresh=${acceptedFresh}), declined=${d4Declined.length}, no-reply=${d4NoReply}, uninvited=${d4Uninvited}`,
);

// C8 — Fogline roster + RSVP states
function foglineRsvp(personId: string): string {
  const importEntry = entries.find((e) => e.context === CTX.fogline && e.type === "imported" && e.subtype === "guest" && (e.persons ?? []).includes(personId));
  let state = (importEntry?.payload as any)?.rsvp ?? "uninvited";
  const landed = entries.some((e) => e.context === CTX.fogline && e.type === "landed" && (e.payload as any)?.kind === "invite" && (e.persons ?? []).includes(personId));
  if (landed && state === "uninvited") state = "no-reply";
  const response = entries.find((e) => e.context === CTX.fogline && e.type === "interaction" && (e.persons ?? []).includes(personId) && (e.payload as any)?.response);
  if (response) state = (response.payload as any).response;
  return state;
}
const foglineStates = { accepted: 0, tentative: 0, declined: 0, "no-reply": 0, uninvited: 0 } as Record<string, number>;
for (const id of foglinePersonIds) {
  const s = foglineRsvp(id);
  foglineStates[s] = (foglineStates[s] ?? 0) + 1;
}
const foglineStateSum = Object.values(foglineStates).reduce((a, b) => a + b, 0);
check(
  "C8 Fogline roster: 78=52+26; states 41+9+6+19+3=78",
  foglinePersonIds.size === 78 &&
    foglineStates.accepted === 41 &&
    foglineStates.tentative === 9 &&
    foglineStates.declined === 6 &&
    foglineStates["no-reply"] === 19 &&
    foglineStates.uninvited === 3 &&
    foglineStateSum === 78,
  `accepted=${foglineStates.accepted}, tentative=${foglineStates.tentative}, declined=${foglineStates.declined}, no-reply=${foglineStates["no-reply"]}, uninvited=${foglineStates.uninvited}`,
);

// C9 — Fogline drafts
const foglineProposed = entriesIn(CTX.fogline, "proposed");
const foglineApproved = entriesIn(CTX.fogline, "approved", "draft");
const foglineReleased = entriesIn(CTX.fogline, "released");
const foglineLanded = entriesIn(CTX.fogline, "landed");
const foglineNudgeProposed = foglineProposed.filter((e) => (e.payload as any)?.kind === "nudge").length;
const foglineInviteProposed = foglineProposed.filter((e) => (e.payload as any)?.kind === "invite").length;
const emailInviteEntries = entries.filter((e) => e.context === CTX.fogline && e.type === "landed" && (e.payload as any)?.channel === "email");
const dmInviteEntries = entries.filter((e) => e.context === CTX.fogline && e.type === "landed" && (e.payload as any)?.channel === "linkedin");
check(
  "C9 Fogline drafts: proposed 27=23+3+1; approved=released=landed=24; channels 23=13+10",
  foglineProposed.length === 27 &&
    foglineApproved.length === 24 &&
    foglineReleased.length === 24 &&
    foglineLanded.length === 24 &&
    foglineNudgeProposed === 1 &&
    emailInviteEntries.length === 13 &&
    dmInviteEntries.length === 10,
  `proposed=${foglineProposed.length} (invite=${foglineInviteProposed}, nudge=${foglineNudgeProposed}), approved=${foglineApproved.length}, released=${foglineReleased.length}, landed=${foglineLanded.length}, email=${emailInviteEntries.length}, dm=${dmInviteEntries.length}`,
);

// C10 — Fogline responses
const foglineResponseInteractions = entriesIn(CTX.fogline, "interaction").filter((e) => (e.payload as any)?.response);
const foglineRsvpChangeInteractions = entriesIn(CTX.fogline, "interaction").filter((e) => (e.payload as any)?.rsvp_change);
const foglineInteractionsTotal = entriesIn(CTX.fogline, "interaction").length;
check(
  "C10 Fogline responses: 15=23-8; interactions 21=15+6",
  foglineResponseInteractions.length === 15 && foglineRsvpChangeInteractions.length === 6 && foglineInteractionsTotal === 21,
  `responses=${foglineResponseInteractions.length}, rsvp-changes=${foglineRsvpChangeInteractions.length}, total=${foglineInteractionsTotal}`,
);

// C11 — lookups
const emberLookups = entriesIn(CTX.ember, "fact", "lookup");
const foglineLookups = entriesIn(CTX.fogline, "fact", "lookup");
const emberInitialLookups = emberLookups.filter((e) => (e.payload as any).kind === "initial").length;
const emberDeepLookups = emberLookups.filter((e) => (e.payload as any).kind === "deep").length;
const foglineInitialLookups = foglineLookups.filter((e) => (e.payload as any).kind === "initial").length;
const foglineDeepLookups = foglineLookups.filter((e) => (e.payload as any).kind === "deep").length;
check(
  "C11 lookups: Ember 76=57+19 (924 remain); Fogline 119=78+41 (881 remain)",
  emberLookups.length === 76 &&
    emberInitialLookups === 57 &&
    emberDeepLookups === 19 &&
    1000 - emberLookups.length === 924 &&
    foglineLookups.length === 119 &&
    foglineInitialLookups === 78 &&
    foglineDeepLookups === 41 &&
    1000 - foglineLookups.length === 881,
  `ember=${emberLookups.length} (${emberInitialLookups}+${emberDeepLookups}), fogline=${foglineLookups.length} (${foglineInitialLookups}+${foglineDeepLookups})`,
);

// C12 — LinkedIn billable days
const liApproved = entriesIn(CTX.linkedin, "approved", "draft");
const liProposed = entriesIn(CTX.linkedin, "proposed");
const dayKey = (iso: string) => iso.slice(0, 10);
const billableDays = new Set(liApproved.map((e) => dayKey(e.at)));
const elapsedDays = 14;
const deadDays = elapsedDays - billableDays.size;
check(
  "C12 LinkedIn: 14 elapsed=9 billable+5 dead; drafts 38=29+9; $27=9x$3",
  liProposed.length === 38 && liApproved.length === 29 && billableDays.size === 9 && deadDays === 5 && billableDays.size * 3 === 27,
  `proposed=${liProposed.length}, approved=${liApproved.length}, distinct billable days=${billableDays.size}, dead=${deadDays}, accrued=$${billableDays.size * 3}`,
);

// C13 — money
const totalMoney = 100 + 100 + billableDays.size * 3;
check("C13 money: $227 = 2x$100 + $27", totalMoney === 227, `2x$100 + $${billableDays.size * 3} = $${totalMoney}`);

// C14 — entries total
check("C14 entries: 410+331+194+26+3=964 (matches §10.2)", entries.length === 964 && colTotal964 === 964, `stream has ${entries.length} entries; §10.2 columns sum to ${colTotal964}`);

// C15 — grants
const grantIssuedEntries = entries.filter((e) => e.type === "granted");
const appscopeGrants = grants.filter((g) => g.kind === "appscope").length;
const disclosureGrants = grants.filter((g) => g.kind === "disclosure").length;
const supervisionGrants = grants.filter((g) => g.kind === "supervision").length;
check(
  "C15 Grants: 5=3 appscope+1 disclosure+1 supervision; grant-issued entries sum to 5",
  grants.length === 5 && appscopeGrants === 3 && disclosureGrants === 1 && supervisionGrants === 1 && grantIssuedEntries.length === 5,
  `grants=${grants.length} (appscope=${appscopeGrants}, disclosure=${disclosureGrants}, supervision=${supervisionGrants}); grant-issued entries=${grantIssuedEntries.length}`,
);

// C16 — every merge names a corroborating anchor; held pairs share no anchor value
const mergedEntries = entries.filter((e) => e.type === "merged");
const missingAnchorOnMerge = mergedEntries.filter((e) => {
  const anchor = (e.payload as any)?.anchor;
  return !anchor || !anchor.kind || !anchor.value;
});
const emailMerges = mergedEntries.filter((e) => (e.payload as any)?.anchor?.kind === "email" && e.context === CTX.fogline).length;
const urlMergesEvents = mergedEntries.filter((e) => (e.payload as any)?.anchor?.kind === "linkedin" && e.context === CTX.fogline).length;
const linkedinMerges = mergedEntries.filter((e) => (e.payload as any)?.anchor?.kind === "linkedin" && e.context === CTX.linkedin).length;
const publicEmailMerges = mergedEntries.filter((e) => (e.payload as any)?.anchor?.kind === "email" && e.context === CTX.public).length;
// held pairs share no anchor value anywhere in the world
const allAnchorValues = new Map<string, Set<string>>(); // value -> set of person ids holding it
for (const p of persons) for (const a of p.anchors) {
  if (!allAnchorValues.has(a.value)) allAnchorValues.set(a.value, new Set());
  allAnchorValues.get(a.value)!.add(p.id);
}
let heldShareViolation = false;
for (const name of HELD_NAMES) {
  const holders = persons.filter((p) => p.name === name);
  if (holders.length !== 2) { heldShareViolation = true; continue; }
  const [a, b] = holders;
  const aValues = new Set(a.anchors.map((x) => x.value));
  const bValues = new Set(b.anchors.map((x) => x.value));
  for (const v of aValues) if (bValues.has(v)) heldShareViolation = true;
}
check(
  "C16 anchors: every merge names its anchor (6 email+3 linkedin events; 20 linkedin; 9 email public); held pairs share none",
  missingAnchorOnMerge.length === 0 && emailMerges === 6 && urlMergesEvents === 3 && linkedinMerges === 20 && publicEmailMerges === 9 && !heldShareViolation,
  `email(events)=${emailMerges}, linkedin(events)=${urlMergesEvents}, linkedin(LI ctx)=${linkedinMerges}, email(public)=${publicEmailMerges}, missing-anchor=${missingAnchorOnMerge.length}, held-share-violation=${heldShareViolation}`,
);

// C17 — Layer coherence
const lumaRowsHaveImport = luma.rosterRows.every((r) =>
  entries.some((e) => e.context === CTX.ember && e.type === "imported" && (e.persons ?? []).includes(r.personId)),
);
const partifulRowsHaveImport = partiful.rosterRows.every((r) =>
  entries.some((e) => e.context === CTX.fogline && e.type === "imported" && (e.persons ?? []).includes(r.personId)),
);
const lumaReleasedVisible = luma.releasedInvites.every((r) => luma.rosterRows.some((row) => row.personId === r.personId));
const partifulReleasedVisible = partiful.releasedInvites.every((r) => partiful.rosterRows.some((row) => row.personId === r.personId));
check(
  "C17 Layer coherence: every Layer-A row has a guest-imported Entry; every released invite is visible on Layer-A",
  lumaRowsHaveImport && partifulRowsHaveImport && lumaReleasedVisible && partifulReleasedVisible,
  `luma rows=${luma.rosterRows.length} (all matched=${lumaRowsHaveImport}), partiful rows=${partiful.rosterRows.length} (all matched=${partifulRowsHaveImport}), luma released visible=${lumaReleasedVisible}, partiful released visible=${partifulReleasedVisible}`,
);

// =======================================================================
// Additional structural checks (beyond C1-C17)
// =======================================================================

// Every entry has exactly one context, and it must be a real context.
const badContext = entries.filter((e) => !e.context || !contextIds.has(e.context));
check("STRUCT: every entry has exactly one (valid) context", badContext.length === 0, `${badContext.length} entries with a missing/invalid context`);

// Every fact entry carries confidence + epistemics (D-041).
const factEntries = entries.filter((e) => e.type === "fact");
const factsMissingConfidence = factEntries.filter((e) => !e.confidence || !e.epistemics);
check(
  "STRUCT: every fact carries confidence+epistemics (D-041)",
  factsMissingConfidence.length === 0,
  `${factsMissingConfidence.length} of ${factEntries.length} fact entries missing confidence/epistemics`,
);
const openFacts = factEntries.filter((e) => e.confidence === "open");
check(
  "STRUCT: confidence=open only for public-forum provenance (D-041 exception)",
  openFacts.length > 0 && openFacts.every((e) => e.subtype === "sighting"),
  `${openFacts.length} open-confidence facts, all subtype=sighting: ${openFacts.every((e) => e.subtype === "sighting")}`,
);

// The 6 same-name pairs remain unmerged.
let anyHeldPairMerged = false;
for (const name of HELD_NAMES) {
  const holders = persons.filter((p) => p.name === name);
  if (holders.length !== 2) anyHeldPairMerged = true;
  for (const p of holders) {
    const mergedWithOther = p.merged.some((m) => holders.some((h) => h.id !== p.id && m.person.includes(h.id)));
    if (mergedWithOther) anyHeldPairMerged = true;
  }
}
check("STRUCT: the 6 same-name pairs remain unmerged", !anyHeldPairMerged, anyHeldPairMerged ? "a held pair was merged or missing" : "all 6 pairs present as 2 unmerged records each");

// supersedes chains are acyclic
let supersedesCycle = false;
for (const e of entries) {
  if (!e.supersedes) continue;
  const seen = new Set<string>([e.id]);
  let cur: string | undefined = e.supersedes;
  while (cur) {
    if (seen.has(cur)) { supersedesCycle = true; break; }
    seen.add(cur);
    cur = entryById.get(cur)?.supersedes;
  }
}
check("STRUCT: supersedes chains are acyclic", !supersedesCycle, supersedesCycle ? "a supersedes cycle was found" : "no supersedes cycles (none used in v0 — vacuously acyclic)");

// System home: exists, flagged apps-never-read, and holds the 3 supervision
// entries per D-030 (rulings outrank artifacts) — the G-5 grant-issued entry
// plus its two Supervised-Session join/end entries file here, not in
// Meera's LinkedIn (D-013's one-context law: an Entry carries exactly one
// context, and D-030 names this exact kind of Entry as system-home content).
const systemHome = contexts.find((c) => c.id === CTX.systemHome);
const systemHomeEntries = entriesIn(CTX.systemHome);
check(
  "STRUCT: system home exists, flagged apps-never-read (D-030), holds the 3 supervision entries",
  !!systemHome && systemHome.apps_never_read === true && systemHomeEntries.length === 3,
  systemHome
    ? `system home present, apps_never_read=${systemHome.apps_never_read}, entries filed here=${systemHomeEntries.length} (expected 3: grant-issued supervision + session joined + session ended)`
    : "system home context missing",
);

// =======================================================================
// §7.2 anchor coverage (not itself a C-numbered equation, but part of the
// spec's worked arithmetic — checked because it's cheap and it's real).
// =======================================================================
function anchorCoverage(personIds: Set<string>, ctx: string) {
  let email = 0,
    phone = 0,
    linkedin = 0;
  const byKindCount: Record<number, number> = {};
  for (const id of personIds) {
    const p = personById.get(id)!;
    const kinds = new Set(p.anchors.filter((a) => a.context === ctx).map((a) => a.kind));
    if (kinds.has("email")) email += 1;
    if (kinds.has("phone")) phone += 1;
    if (kinds.has("linkedin")) linkedin += 1;
    byKindCount[kinds.size] = (byKindCount[kinds.size] ?? 0) + 1;
  }
  return { email, phone, linkedin, one: byKindCount[1] ?? 0, two: byKindCount[2] ?? 0, three: byKindCount[3] ?? 0 };
}
const emberCoverage = anchorCoverage(emberPersonIds, CTX.ember);
const foglineCoverage = anchorCoverage(foglinePersonIds, CTX.fogline);
check(
  "§7.2 Ember anchor coverage: email 57, phone 12, linkedin 41 (12 email-only, 8 all-three)",
  emberCoverage.email === 57 && emberCoverage.phone === 12 && emberCoverage.linkedin === 41 && emberCoverage.one === 12 && emberCoverage.three === 8,
  `email=${emberCoverage.email}, phone=${emberCoverage.phone}, linkedin=${emberCoverage.linkedin}, one-anchor=${emberCoverage.one}, two-anchor=${emberCoverage.two}, three-anchor=${emberCoverage.three}`,
);
check(
  "§7.2 Fogline anchor coverage: email 44, phone 60, linkedin 27 (29/45/4 one/two/three-anchor)",
  foglineCoverage.email === 44 &&
    foglineCoverage.phone === 60 &&
    foglineCoverage.linkedin === 27 &&
    foglineCoverage.one === 29 &&
    foglineCoverage.two === 45 &&
    foglineCoverage.three === 4,
  `email=${foglineCoverage.email}, phone=${foglineCoverage.phone}, linkedin=${foglineCoverage.linkedin}, one-anchor=${foglineCoverage.one}, two-anchor=${foglineCoverage.two}, three-anchor=${foglineCoverage.three}`,
);

// =======================================================================
// Derived Rooms — must match §3.2 / §4.2 exactly (rebuild contract #6)
// =======================================================================
check(
  "ROOM: Ember dinner #4 derives to 19/6/15/17 of 57",
  d4Accepted.length === 19 && d4Declined.length === 6 && d4NoReply === 15 && d4Uninvited === 17 && emberPersonIds.size === 57,
  `accepted=${d4Accepted.length}, declined=${d4Declined.length}, no-reply=${d4NoReply}, uninvited=${d4Uninvited}, total=${emberPersonIds.size}`,
);
check(
  "ROOM: Fogline derives to 41/9/6/19/3 of 78",
  foglineStates.accepted === 41 && foglineStates.tentative === 9 && foglineStates.declined === 6 && foglineStates["no-reply"] === 19 && foglineStates.uninvited === 3,
  `accepted=${foglineStates.accepted}, tentative=${foglineStates.tentative}, declined=${foglineStates.declined}, no-reply=${foglineStates["no-reply"]}, uninvited=${foglineStates.uninvited}`,
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
  console.error(`check.ts: ${failed.length} of ${results.length} checks FAILED:`);
  for (const r of failed) console.error(`  - ${r.name}: ${r.detail}`);
  process.exit(1);
}
console.log(`check.ts: all ${results.length} checks passed.`);
