// The world builder — one function, pure, deterministic in (seed, epoch).
//
// This module builds BOTH layers from seed-world.md in one pass:
//   Layer B (the vault): Contexts, Persons, Grants, Entries (the Stream).
//   Layer A (the platform): Luma/Partiful-shaped roster fixtures, derived
//     from the same guest-imported Entries so C17 (replay-coherence) holds
//     by construction.
//
// Every count below is picked to make the two independent decompositions of
// §10.2 (by context, by subtype) equal 964, and to satisfy C1-C17. Where the
// spec doesn't pin a specific crowd member to a specific slot, this file
// assigns slots deterministically (seeded shuffles / fixed index ranges) so
// reruns with the same WORLD_SEED are byte-identical (rebuild contract #2).

import { Rng, subRng, shuffle } from "./rng.js";
import { drawName } from "./names.js";
import { Clock, makeClock } from "./time.js";
import type {
  Entry,
  EntryType,
  Person,
  Context,
  Grant,
  Gathering,
  Anchor,
  AnchorKind,
  PlatformFixture,
  Confidence,
  Epistemics,
} from "../types.js";

export interface VoiceSample {
  id: string;
  label: string;
  text: string;
}
export interface Profile {
  id: string;
  name: "luma" | "partiful" | "linkedin" | "gmail";
  boundTo: string;
}

export interface BuildResult {
  seed: number;
  epoch: string;
  contexts: Context[];
  gatherings: Gathering[];
  persons: Person[];
  grants: Grant[];
  entries: Entry[];
  platform: PlatformFixture[];
  voiceSamples: VoiceSample[];
  profiles: Profile[];
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
}

export function buildWorld(seed: number, epochIso: string): BuildResult {
  const clock: Clock = makeClock(epochIso);
  const rngNames = subRng(seed, "names");
  const usedNames = new Set<string>();
  // Reserve every pinned cast name so the crowd RNG can never collide with
  // one (drawName only re-draws on names it knows are taken).
  for (const n of ["Nadia Osei", "Marcus Liang", "Daniel Park", "Sarah Kim", "David Nguyen", "Priya Patel", "Emily Zhang", "Omar Hassan"]) {
    usedNames.add(n);
  }

  // ---------------------------------------------------------------------
  // Containers + id counters
  // ---------------------------------------------------------------------
  const persons: Person[] = [];
  const entries: Entry[] = [];
  let personSeq = 0;
  let entrySeq = 0;

  function newPersonId(): string {
    personSeq += 1;
    return `p-${String(personSeq).padStart(4, "0")}`;
  }

  function makeAnchor(kind: AnchorKind, personIndex: number, name: string, context: string): Anchor {
    const s = slug(name);
    const value =
      kind === "email"
        ? `${s}.${personIndex}@example.net`
        : kind === "phone"
        ? `+1555${String(7000000 + personIndex).slice(-7)}`
        : `https://linkedin.com/in/${s}-${personIndex}`;
    return { kind, value, verified: true, context };
  }

  function newPerson(name: string, sightedAt: string, anchors: Anchor[]): Person {
    const id = newPersonId();
    const p: Person = { id, name, anchors, merged: [], sighted_at: sightedAt, state: "active" };
    persons.push(p);
    return p;
  }

  function append(e: Omit<Entry, "id" | "cursor">): Entry {
    entrySeq += 1;
    const entry: Entry = { id: `e-${String(entrySeq).padStart(6, "0")}`, cursor: entries.length, ...e };
    entries.push(entry);
    return entry;
  }

  const factConfidence = (c: Confidence, ep: Epistemics) => ({ confidence: c, epistemics: ep });

  // ---------------------------------------------------------------------
  // Contexts
  // ---------------------------------------------------------------------
  const contexts: Context[] = [];
  const CTX = {
    ember: "ember-dinners",
    fogline: "fogline",
    linkedin: "meeras-linkedin",
    public: "public",
    systemHome: "system-home",
  } as const;

  contexts.push({
    id: CTX.systemHome,
    name: "System home",
    kind: "system",
    anchor: "email",
    apps_never_read: true,
    created_at: clock.at(-14),
  });
  contexts.push({
    id: CTX.linkedin,
    name: "Meera's LinkedIn",
    kind: "professional",
    anchor: "linkedin",
    profile: "linkedin",
    created_at: clock.at(-14),
  });
  contexts.push({
    id: CTX.ember,
    name: "Ember Dinners",
    kind: "social",
    anchor: "email",
    profile: "luma",
    created_at: clock.at(-7),
  });
  contexts.push({
    id: CTX.public,
    name: "The public context",
    kind: "public",
    anchor: "email",
    public: true,
    created_at: clock.at(-5),
  });
  contexts.push({
    id: CTX.fogline,
    name: "Fogline",
    kind: "social",
    anchor: "phone",
    profile: "partiful",
    created_at: clock.at(-3),
  });

  // ---------------------------------------------------------------------
  // Gatherings
  // ---------------------------------------------------------------------
  const gatherings: Gathering[] = [
    { id: "dinner-1", context: CTX.ember, name: "Ember Dinners #1", date: clock.at(-110), upcoming: false },
    { id: "dinner-2", context: CTX.ember, name: "Ember Dinners #2", date: clock.at(-82), upcoming: false },
    { id: "dinner-3", context: CTX.ember, name: "Ember Dinners #3", date: clock.at(-47), upcoming: false },
    { id: "dinner-4", context: CTX.ember, name: "Ember Dinners #4", date: clock.at(9), upcoming: true },
    { id: "fogline-event", context: CTX.fogline, name: "Fogline — a Tech Week evening", date: clock.at(22), upcoming: true },
  ];

  // ---------------------------------------------------------------------
  // Grants (objects; issuance Entries appended at their timeline moment)
  // ---------------------------------------------------------------------
  const grants: Grant[] = [];

  // ---------------------------------------------------------------------
  // Actors
  // ---------------------------------------------------------------------
  const actorMeera = { kind: "human" as const, ref: "meera" };
  const actorJonah = { kind: "human" as const, ref: "jonah" };
  const actorLois = { kind: "lois" as const, ref: "lois" };
  const actorEventApp = { kind: "app" as const, ref: "app-event" };
  const actorLinkedInApp = { kind: "app" as const, ref: "app-linkedin" };

  // =======================================================================
  // E-14d — Install day: LinkedIn context, LinkedIn App grant, supervision
  // =======================================================================
  append({ at: clock.at(-14), context: CTX.linkedin, type: "context", subtype: "created", actor: actorMeera, payload: { name: "Meera's LinkedIn" } });
  append({ at: clock.at(-14, 1), context: CTX.linkedin, type: "anchor", subtype: "declared", actor: actorMeera, payload: { anchor: "linkedin" } });

  const g3: Grant = { id: "g-3", kind: "appscope", app: "app-linkedin", context: CTX.linkedin, granted_by: "meera", granted_at: clock.at(-14, 2) };
  grants.push(g3);
  append({ at: g3.granted_at, context: CTX.linkedin, type: "granted", subtype: "appscope", actor: actorMeera, grant: g3.id, payload: { app: "app-linkedin", kind: "appscope" } });

  const g5: Grant = {
    id: "g-5",
    kind: "supervision",
    grantee: "jonah",
    window: { from: clock.at(-14), to: clock.at(15) },
    granted_by: "meera",
    granted_at: clock.at(-14, 3),
  };
  grants.push(g5);
  append({ at: g5.granted_at, context: CTX.systemHome, type: "granted", subtype: "supervision", actor: actorMeera, grant: g5.id, payload: { grantee: "jonah", window: g5.window } });

  append({ at: clock.at(-14, 4), context: CTX.systemHome, type: "session", subtype: "joined", actor: actorJonah, grant: g5.id, payload: { mode: "observing", workspace: "linkedin" } });
  append({ at: clock.at(-14, 4 + 42), context: CTX.systemHome, type: "session", subtype: "ended", actor: actorJonah, grant: g5.id, payload: { durationMinutes: 42 } });

  const voiceSamples: VoiceSample[] = [
    { id: "voice-1", label: "Dinner #3 recap post", text: "Recap: what made dinner #3 click." },
    { id: "voice-2", label: "Point-of-view post on community building", text: "Community compounds when the guest list has memory." },
    { id: "voice-3", label: "Short invite note", text: "You'd like this one — small table, good people." },
  ];
  const profiles: Profile[] = [
    { id: "profile-luma", name: "luma", boundTo: "meera" },
    { id: "profile-partiful", name: "partiful", boundTo: "meera" },
    { id: "profile-linkedin", name: "linkedin", boundTo: "meera" },
    { id: "profile-gmail", name: "gmail", boundTo: "meera" },
  ];

  // =======================================================================
  // Ember Dinners — cast, cohorts, and tags
  // =======================================================================

  // --- 45 past attendees, in fixed cohort-slot order (index 41 = Nadia) ---
  type Dinner = 1 | 2 | 3;
  const cohortSpec: { dinners: Dinner[]; count: number }[] = [
    { dinners: [1], count: 1 },
    { dinners: [2], count: 12 },
    { dinners: [3], count: 14 },
    { dinners: [1, 2], count: 6 },
    { dinners: [1, 3], count: 8 },
    { dinners: [2, 3], count: 1 }, // Nadia's slot
    { dinners: [1, 2, 3], count: 3 },
  ];
  const emberPastSlots: { dinners: Dinner[] }[] = [];
  for (const c of cohortSpec) for (let i = 0; i < c.count; i++) emberPastSlots.push({ dinners: c.dinners });
  const NADIA_SLOT = 41; // 1 + 12 + 14 + 6 + 8 = 41 (0-based)

  const emberPastPersons: Person[] = new Array(45);
  const nadia = newPerson("Nadia Osei", clock.at(-82), []);
  emberPastPersons[NADIA_SLOT] = nadia;

  // Identity tags over the other 44 slots (deterministic shuffle).
  const nonNadiaSlots = Array.from({ length: 45 }, (_, i) => i).filter((i) => i !== NADIA_SLOT);
  const shuffledSlots = shuffle(subRng(seed, "ember-tags"), nonNadiaSlots);
  const HELD_NAMES = ["Daniel Park", "Sarah Kim", "David Nguyen", "Priya Patel", "Emily Zhang", "Omar Hassan"];
  const heldSlots = shuffledSlots.slice(0, 6);
  const emailMergeOtherSlots = shuffledSlots.slice(6, 11); // 5
  const urlMergeOtherSlots = shuffledSlots.slice(11, 14); // 3
  const liSeriesOtherSlots = shuffledSlots.slice(14, 23); // 9 (index 0 = Marcus's slot, +8 others)
  const plainPastSlots = shuffledSlots.slice(23); // 21

  const heldSlotSet = new Set(heldSlots);

  function dinnerImportDate(dinners: Dinner[]): string {
    const dates: Record<Dinner, number> = { 1: -110, 2: -82, 3: -47 };
    return clock.at(dates[dinners[0]]);
  }

  const marcusSlot = liSeriesOtherSlots[0];
  const marcus = newPerson("Marcus Liang", dinnerImportDate(emberPastSlots[marcusSlot].dinners), []);
  emberPastPersons[marcusSlot] = marcus;

  heldSlots.forEach((slotIdx, i) => {
    const name = HELD_NAMES[i];
    const p = newPerson(name, dinnerImportDate(emberPastSlots[slotIdx].dinners), []);
    emberPastPersons[slotIdx] = p;
  });
  for (const slotIdx of nonNadiaSlots) {
    if (heldSlotSet.has(slotIdx)) continue; // already created above
    if (slotIdx === marcusSlot) continue; // already created above
    const name = drawName(rngNames, usedNames);
    const p = newPerson(name, dinnerImportDate(emberPastSlots[slotIdx].dinners), []);
    emberPastPersons[slotIdx] = p;
  }

  // --- 12 fresh names pasted for dinner #4 ---
  const emberFreshPersons: Person[] = [];
  for (let i = 0; i < 12; i++) {
    const name = drawName(rngNames, usedNames);
    emberFreshPersons.push(newPerson(name, clock.at(-6), []));
  }

  // --- Anchor assignment (57 = 12 email-only + 4 email+phone + 33 email+linkedin + 8 all-three) ---
  let anchorIdx = 0;
  function assignAnchors(p: Person, kinds: AnchorKind[], context: string) {
    anchorIdx += 1;
    for (const k of kinds) p.anchors.push(makeAnchor(k, anchorIdx, p.name, context));
  }

  // email-only (12): Nadia + held(6) + emailMergeOthers(5)
  assignAnchors(nadia, ["email"], CTX.ember);
  for (const slotIdx of heldSlots) assignAnchors(emberPastPersons[slotIdx], ["email"], CTX.ember);
  for (const slotIdx of emailMergeOtherSlots) assignAnchors(emberPastPersons[slotIdx], ["email"], CTX.ember);

  // email+linkedin, tagged portion (12): urlMergeOthers(3) + liSeries incl Marcus(9)
  for (const slotIdx of urlMergeOtherSlots) assignAnchors(emberPastPersons[slotIdx], ["email", "linkedin"], CTX.ember);
  assignAnchors(marcus, ["email", "linkedin"], CTX.ember);
  for (const slotIdx of liSeriesOtherSlots.slice(1)) assignAnchors(emberPastPersons[slotIdx], ["email", "linkedin"], CTX.ember);

  // Untagged pool (33 = 21 plain-past + 12 fresh): 4 email+phone, 21 email+linkedin, 8 all-three
  const untaggedEmber: Person[] = [...plainPastSlots.map((i) => emberPastPersons[i]), ...emberFreshPersons];
  untaggedEmber.slice(0, 4).forEach((p) => assignAnchors(p, ["email", "phone"], CTX.ember));
  untaggedEmber.slice(4, 25).forEach((p) => assignAnchors(p, ["email", "linkedin"], CTX.ember));
  untaggedEmber.slice(25, 33).forEach((p) => assignAnchors(p, ["email", "phone", "linkedin"], CTX.ember));

  const ember57: Person[] = [...emberPastPersons, ...emberFreshPersons];

  // --- Entries: context/anchor/grant for Ember ---
  append({ at: clock.at(-7), context: CTX.ember, type: "context", subtype: "created", actor: actorMeera, payload: { name: "Ember Dinners" } });
  append({ at: clock.at(-7, 1), context: CTX.ember, type: "anchor", subtype: "declared", actor: actorMeera, payload: { anchor: "email" } });
  const g1: Grant = { id: "g-1", kind: "appscope", app: "app-event", context: CTX.ember, granted_by: "meera", granted_at: clock.at(-7, 2) };
  grants.push(g1);
  append({ at: g1.granted_at, context: CTX.ember, type: "granted", subtype: "appscope", actor: actorMeera, grant: g1.id, payload: { app: "app-event", kind: "appscope" } });

  // --- guest-imported (66 rows) + fact-attendance (66), one pair per dinner-row ---
  const dinnerDate: Record<Dinner, number> = { 1: -110, 2: -82, 3: -47 };
  const dinnerId: Record<Dinner, string> = { 1: "dinner-1", 2: "dinner-2", 3: "dinner-3" };
  const attendanceFactByPersonAndDinner = new Map<string, string>(); // `${personId}:${dinner}` -> entry id
  for (const dinner of [1, 2, 3] as Dinner[]) {
    let row = 0;
    for (let slotIdx = 0; slotIdx < 45; slotIdx++) {
      const slot = emberPastSlots[slotIdx];
      if (!slot.dinners.includes(dinner)) continue;
      row += 1;
      const person = emberPastPersons[slotIdx];
      const at = clock.at(-7, row);
      append({ at, context: CTX.ember, type: "imported", subtype: "guest", actor: actorEventApp, persons: [person.id], about: dinnerId[dinner], source: `luma-import-dinner-${dinner}-row-${row}`, payload: { row } });
      const factEntry = append({ at: clock.at(-7, row + 0.5), context: CTX.ember, type: "fact", subtype: "attendance", actor: actorEventApp, persons: [person.id], about: dinnerId[dinner], ...factConfidence("chatham", "stated"), payload: { attended: true, dinner: dinnerId[dinner] } });
      attendanceFactByPersonAndDinner.set(`${person.id}:${dinner}`, factEntry.id);
    }
  }

  // --- guest-imported (12 fresh, dinner #4 shell) ---
  emberFreshPersons.forEach((p, i) => {
    append({ at: clock.at(-6, i), context: CTX.ember, type: "imported", subtype: "guest", actor: actorEventApp, persons: [p.id], about: "dinner-4", source: "csv-fresh-names", payload: { row: i + 1 } });
  });

  // --- plan-approved (Ember) ---
  append({ at: clock.at(-6, 20), context: CTX.ember, type: "approved", subtype: "plan", actor: actorMeera, about: "dinner-4", payload: { invite: 40, returning: 28, fresh: 12 } });

  // --- dinner #4 invite lifecycle: 28 returning-invited + 12 fresh-invited = 40 sent ---
  const returningInvitedSlots = [NADIA_SLOT, ...shuffle(subRng(seed, "ember-d4-invite"), nonNadiaSlots).slice(0, 27)];
  const returningInvitedSet = new Set(returningInvitedSlots);
  const uninvitedSlots = nonNadiaSlots.filter((i) => !returningInvitedSet.has(i));

  // within 28 returning-invited: 14 accept (Nadia + 13), 4 decline, 10 no-reply
  const othersInvited = returningInvitedSlots.filter((i) => i !== NADIA_SLOT); // 27
  const returningAccept = [NADIA_SLOT, ...othersInvited.slice(0, 13)]; // 14
  const returningDecline = othersInvited.slice(13, 17); // 4
  const returningNoReply = othersInvited.slice(17, 27); // 10

  // within 12 fresh-invited: 5 accept, 2 decline, 5 no-reply
  const freshAccept = emberFreshPersons.slice(0, 5);
  const freshDecline = emberFreshPersons.slice(5, 7);
  const freshNoReply = emberFreshPersons.slice(7, 12);

  const d4InvitedPersons: { person: Person; response: "accepted" | "declined" | "noreply" }[] = [
    ...returningAccept.map((i) => ({ person: emberPastPersons[i], response: "accepted" as const })),
    ...returningDecline.map((i) => ({ person: emberPastPersons[i], response: "declined" as const })),
    ...returningNoReply.map((i) => ({ person: emberPastPersons[i], response: "noreply" as const })),
    ...freshAccept.map((person) => ({ person, response: "accepted" as const })),
    ...freshDecline.map((person) => ({ person, response: "declined" as const })),
    ...freshNoReply.map((person) => ({ person, response: "noreply" as const })),
  ];
  // sanity: 40 total
  d4InvitedPersons.forEach(({ person }, i) => {
    append({ at: clock.at(-6, 30 + i), context: CTX.ember, type: "proposed", actor: actorEventApp, persons: [person.id], about: "dinner-4", payload: { kind: "invite" } });
  });
  d4InvitedPersons.forEach(({ person }, i) => {
    append({ at: clock.at(-5, i), context: CTX.ember, type: "approved", subtype: "draft", actor: actorMeera, persons: [person.id], about: "dinner-4", payload: { kind: "invite" } });
  });
  d4InvitedPersons.forEach(({ person }, i) => {
    append({ at: clock.at(-5, 20 + i), context: CTX.ember, type: "released", actor: actorEventApp, persons: [person.id], about: "dinner-4", payload: { kind: "invite" } });
  });
  d4InvitedPersons.forEach(({ person }, i) => {
    append({ at: clock.at(-4, i), context: CTX.ember, type: "landed", actor: actorEventApp, persons: [person.id], about: "dinner-4", payload: { kind: "invite" } });
  });
  // Interaction entries: only for people who actually responded (19 accept + 6 decline = 25)
  d4InvitedPersons
    .filter((x) => x.response !== "noreply")
    .forEach(({ person, response }, i) => {
      append({ at: clock.at(-3, i), context: CTX.ember, type: "interaction", actor: actorEventApp, persons: [person.id], about: "dinner-4", payload: { response } });
    });

  // --- lookups: 57 initial + 19 deep (accepted only) = 76 ---
  ember57.forEach((p, i) => {
    append({ at: clock.at(-7, 60 + i), context: CTX.ember, type: "fact", subtype: "lookup", actor: actorEventApp, persons: [p.id], ...factConfidence("chatham", "inferred"), payload: { kind: "initial" } });
  });
  const emberAccepted = d4InvitedPersons.filter((x) => x.response === "accepted");
  emberAccepted.forEach(({ person }, i) => {
    append({ at: clock.at(-4, 40 + i), context: CTX.ember, type: "fact", subtype: "lookup", actor: actorEventApp, persons: [person.id], ...factConfidence("chatham", "inferred"), payload: { kind: "deep" } });
  });

  // --- disclosure Grant G-4 (Nadia): a Fogline draft wants her dinner-#3 fact ---
  const nadiaDinner3FactId = attendanceFactByPersonAndDinner.get(`${nadia.id}:3`)!;
  const g4: Grant = { id: "g-4", kind: "disclosure", person: nadia.id, context: CTX.ember, destinationContext: CTX.fogline, granted_by: "meera", granted_at: clock.at(-2) };
  grants.push(g4);
  append({ at: g4.granted_at, context: CTX.ember, type: "granted", subtype: "disclosure", actor: actorMeera, grant: g4.id, persons: [nadia.id], refs: [nadiaDinner3FactId], payload: { widens: CTX.fogline } });

  // =======================================================================
  // Public context
  // =======================================================================
  append({ at: clock.at(-5), context: CTX.public, type: "context", subtype: "created", actor: actorLois, payload: { name: "The public context" } });
  append({ at: clock.at(-5, 1), context: CTX.public, type: "anchor", subtype: "declared", actor: actorLois, payload: { anchor: "email" } });
  append({ at: clock.at(-5, 2), context: CTX.public, type: "consented", actor: actorMeera, payload: { public: true } });
  append({ at: clock.at(-5, 3), context: CTX.public, type: "listing", actor: actorMeera, about: "dinner-4", payload: { gathering: "dinner-4", postedAt: clock.at(-5) } });
  append({ at: clock.at(-2, 5), context: CTX.public, type: "listing", actor: actorMeera, about: "fogline-event", payload: { gathering: "fogline-event", postedAt: clock.at(-2) } });

  // =======================================================================
  // Fogline — persons, anchors, entries
  // =======================================================================
  append({ at: clock.at(-3), context: CTX.fogline, type: "context", subtype: "created", actor: actorMeera, payload: { name: "Fogline" } });
  append({ at: clock.at(-3, 1), context: CTX.fogline, type: "anchor", subtype: "declared", actor: actorMeera, payload: { anchor: "phone" } });
  const g2: Grant = { id: "g-2", kind: "appscope", app: "app-event", context: CTX.fogline, granted_by: "meera", granted_at: clock.at(-3, 2) };
  grants.push(g2);
  append({ at: g2.granted_at, context: CTX.fogline, type: "granted", subtype: "appscope", actor: actorMeera, grant: g2.id, payload: { app: "app-event", kind: "appscope" } });

  // --- held pairs (Fogline-side, new records, phone-only) ---
  const foglineHeld: Person[] = HELD_NAMES.map((name) => newPerson(name, clock.at(-3), []));
  foglineHeld.forEach((p) => assignAnchors(p, ["phone"], CTX.fogline));

  // --- 9 event-overlap merges: 6 email (Nadia + 5), 3 linkedin (crowd) ---
  const emailMergePersons: Person[] = [nadia, ...emailMergeOtherSlots.map((i) => emberPastPersons[i])];
  const urlMergePersons: Person[] = urlMergeOtherSlots.map((i) => emberPastPersons[i]);
  emailMergePersons.forEach((p) => {
    // corroborating email, re-observed in Fogline
    const emailAnchor = p.anchors.find((a) => a.kind === "email")!;
    p.anchors.push({ kind: "email", value: emailAnchor.value, verified: true, context: CTX.fogline });
    assignAnchors(p, ["phone"], CTX.fogline);
  });
  urlMergePersons.forEach((p) => {
    const liAnchor = p.anchors.find((a) => a.kind === "linkedin")!;
    p.anchors.push({ kind: "linkedin", value: liAnchor.value, verified: true, context: CTX.fogline });
    assignAnchors(p, ["phone"], CTX.fogline);
  });

  // --- 11 LinkedIn-context merges, Fogline-side (new persons, linkedin+phone) ---
  const liMergedFogline: Person[] = [];
  for (let i = 0; i < 11; i++) {
    const name = drawName(rngNames, usedNames);
    const p = newPerson(name, clock.at(-3), []);
    assignAnchors(p, ["linkedin", "phone"], CTX.fogline);
    liMergedFogline.push(p);
  }

  // --- plain-52: e1x14, p1x9, ep x16, el x4, pl x5, t x4 ---
  function drawPlain(n: number): Person[] {
    const out: Person[] = [];
    for (let i = 0; i < n; i++) out.push(newPerson(drawName(rngNames, usedNames), clock.at(-3), []));
    return out;
  }
  const e1 = drawPlain(14);
  const p1 = drawPlain(9);
  const ep = drawPlain(16);
  const el = drawPlain(4);
  const pl = drawPlain(5);
  const t = drawPlain(4);
  e1.forEach((p) => assignAnchors(p, ["email"], CTX.fogline));
  p1.forEach((p) => assignAnchors(p, ["phone"], CTX.fogline));
  ep.forEach((p) => assignAnchors(p, ["email", "phone"], CTX.fogline));
  el.forEach((p) => assignAnchors(p, ["email", "linkedin"], CTX.fogline));
  pl.forEach((p) => assignAnchors(p, ["phone", "linkedin"], CTX.fogline));
  t.forEach((p) => assignAnchors(p, ["email", "phone", "linkedin"], CTX.fogline));

  // Sub-tags within plain-52, per the derivation in the README's arithmetic notes:
  const dmInvited = [...pl, ...t, el[0]]; // 5 + 4 + 1 = 10, all carry linkedin
  const emailInvited = e1.slice(0, 13); // 13, all carry email
  const queued = [el[1], el[2], el[3]]; // 3
  const importedPlain = [e1[13], ...p1, ...ep]; // 1 + 9 + 16 = 26

  // --- RSVP buckets, computed before the guest-imported entries so the
  // observed-at-import state can be embedded in each entry's payload (the
  // Room must derive from Entries, never from a side-channel). ---
  // Imported-52: 30 accepted, 7 tentative, 4 declined, 11 no-reply
  const imported52Order: Person[] = [...foglineHeld, ...emailMergePersons, ...urlMergePersons, ...liMergedFogline, ...importedPlain];
  const imp_accepted = imported52Order.slice(0, 30);
  const imp_tentative = imported52Order.slice(30, 37);
  const imp_declined = imported52Order.slice(37, 41);
  const imp_noreply = imported52Order.slice(41, 52);
  const importedRsvp = new Map<string, string>();
  imp_accepted.forEach((p) => importedRsvp.set(p.id, "accepted"));
  imp_tentative.forEach((p) => importedRsvp.set(p.id, "tentative"));
  imp_declined.forEach((p) => importedRsvp.set(p.id, "declined"));
  imp_noreply.forEach((p) => importedRsvp.set(p.id, "no-reply"));

  // App-invited-23: 11 accepted, 2 tentative, 2 declined, 8 no-reply
  const invitedOrder: Person[] = [...emailInvited, ...dmInvited];
  const inv_accepted = invitedOrder.slice(0, 11);
  const inv_tentative = invitedOrder.slice(11, 13);
  const inv_declined = invitedOrder.slice(13, 15);
  const inv_noreply = invitedOrder.slice(15, 23);

  const foglineAccepted = [...imp_accepted, ...inv_accepted]; // 41

  // --- guest-imported: 52 at connect (held6 + emailMerge6 + urlMerge3 + liMergedFogline11 + importedPlain26) ---
  // Each carries the RSVP state AS OBSERVED ON PARTIFUL AT IMPORT TIME
  // (Meera already had this list; the import brings the platform's current
  // state along with it) — the Room reads this directly, no fold needed.
  const importedAtConnect: Person[] = [...foglineHeld, ...emailMergePersons, ...urlMergePersons, ...liMergedFogline, ...importedPlain];
  importedAtConnect.forEach((p, i) => {
    append({ at: clock.at(-3, 10 + i), context: CTX.fogline, type: "imported", subtype: "guest", actor: actorEventApp, persons: [p.id], about: "fogline-event", source: "partiful-import-connect", payload: { row: i + 1, rsvp: importedRsvp.get(p.id) } });
  });

  // 9 anchor merges at connect (Ember<->Fogline overlap): 6 email, 3 linkedin
  emailMergePersons.forEach((p, i) => {
    p.merged.push({ person: `pre-merge:${p.id}:ember-sighting`, at: clock.at(-3, 200 + i), how: "anchor" });
    const emailAnchor = p.anchors.find((a) => a.kind === "email" && a.context === CTX.ember)!;
    append({ at: clock.at(-3, 200 + i), context: CTX.fogline, type: "merged", actor: actorEventApp, persons: [p.id], payload: { how: "anchor", anchor: { kind: "email", value: emailAnchor.value }, contexts: [CTX.ember, CTX.fogline] } });
  });
  urlMergePersons.forEach((p, i) => {
    p.merged.push({ person: `pre-merge:${p.id}:ember-sighting`, at: clock.at(-3, 220 + i), how: "anchor" });
    const liAnchor = p.anchors.find((a) => a.kind === "linkedin" && a.context === CTX.ember)!;
    append({ at: clock.at(-3, 220 + i), context: CTX.fogline, type: "merged", actor: actorEventApp, persons: [p.id], payload: { how: "anchor", anchor: { kind: "linkedin", value: liAnchor.value }, contexts: [CTX.ember, CTX.fogline] } });
  });

  // --- 26 added after connect: 13 email-invited + 10 DM-invited + 3 queued ---
  // All start `uninvited` — genuinely nobody had a Partiful RSVP yet; state
  // moves forward only via the invite-lifecycle and response Entries below.
  const addedAfterConnect: Person[] = [...emailInvited, ...dmInvited, ...queued];
  addedAfterConnect.forEach((p, i) => {
    append({ at: clock.at(-2, 10 + i), context: CTX.fogline, type: "imported", subtype: "guest", actor: actorMeera, persons: [p.id], about: "fogline-event", source: "csv-paste-added", payload: { row: i + 1, rsvp: "uninvited" } });
  });

  // plan-approved (Fogline)
  append({ at: clock.at(-2, 40), context: CTX.fogline, type: "approved", subtype: "plan", actor: actorMeera, about: "fogline-event", payload: { added: 26, invitedSoFar: 23 } });

  // Nadia's nudge: proposed/approved/released/landed, gated by G-4
  append({ at: clock.at(-2, 41), context: CTX.fogline, type: "proposed", actor: actorEventApp, persons: [nadia.id], about: "fogline-event", refs: [nadiaDinner3FactId], payload: { kind: "nudge" } });
  append({ at: clock.at(-2, 42), context: CTX.fogline, type: "approved", subtype: "draft", actor: actorMeera, persons: [nadia.id], about: "fogline-event", grant: g4.id, payload: { kind: "nudge" } });
  append({ at: clock.at(-1, 0), context: CTX.fogline, type: "released", actor: actorEventApp, persons: [nadia.id], about: "fogline-event", payload: { kind: "nudge" } });
  append({ at: clock.at(-1, 1), context: CTX.fogline, type: "landed", actor: actorEventApp, persons: [nadia.id], about: "fogline-event", payload: { kind: "nudge" } });

  // 23 invites (13 email + 10 DM): proposed@E-2d, approved@E-2d, released/landed@E-1d
  const invitedSoFar = [...emailInvited.map((p) => ({ p, channel: "email" })), ...dmInvited.map((p) => ({ p, channel: "linkedin" }))];
  invitedSoFar.forEach(({ p, channel }, i) => {
    append({ at: clock.at(-2, 50 + i), context: CTX.fogline, type: "proposed", actor: actorEventApp, persons: [p.id], about: "fogline-event", payload: { kind: "invite", channel } });
  });
  invitedSoFar.forEach(({ p, channel }, i) => {
    append({ at: clock.at(-2, 80 + i), context: CTX.fogline, type: "approved", subtype: "draft", actor: actorMeera, persons: [p.id], about: "fogline-event", payload: { kind: "invite", channel } });
  });
  invitedSoFar.forEach(({ p, channel }, i) => {
    append({ at: clock.at(-1, 10 + i), context: CTX.fogline, type: "released", actor: actorEventApp, persons: [p.id], about: "fogline-event", payload: { kind: "invite", channel } });
  });
  invitedSoFar.forEach(({ p, channel }, i) => {
    append({ at: clock.at(-1, 40 + i), context: CTX.fogline, type: "landed", actor: actorEventApp, persons: [p.id], about: "fogline-event", payload: { kind: "invite", channel } });
  });
  // 3 queued: proposed only
  queued.forEach((p, i) => {
    append({ at: clock.at(-2, 90 + i), context: CTX.fogline, type: "proposed", actor: actorEventApp, persons: [p.id], about: "fogline-event", payload: { kind: "invite" } });
  });

  // session-healed (partiful profile watchdog repair)
  append({ at: clock.at(-1, 60), context: CTX.fogline, type: "healed", subtype: "session", actor: actorLois, payload: { profile: "partiful" } });

  // --- RSVP response Interactions: 15 responses (23 invited - 8 no-reply) ---
  const invitedResponders = [
    ...inv_accepted.map((p) => ({ p, rsvp: "accepted" })),
    ...inv_tentative.map((p) => ({ p, rsvp: "tentative" })),
    ...inv_declined.map((p) => ({ p, rsvp: "declined" })),
  ]; // 15
  invitedResponders.forEach(({ p, rsvp }, i) => {
    append({ at: clock.at(-1, 70 + i), context: CTX.fogline, type: "interaction", actor: actorEventApp, persons: [p.id], about: "fogline-event", payload: { response: rsvp } });
  });
  // 6 imported guests changed their RSVP after connect (their current state
  // is already the one recorded on their guest-imported entry above; this
  // Interaction is the audit trail of the change itself).
  const rsvpChanged = importedPlain.slice(0, 6);
  rsvpChanged.forEach((p, i) => {
    append({ at: clock.at(-1, 90 + i), context: CTX.fogline, type: "interaction", actor: actorEventApp, persons: [p.id], about: "fogline-event", payload: { rsvp_change: true, to: importedRsvp.get(p.id) } });
  });

  // --- lookups: 78 initial + 41 deep (accepted) = 119 ---
  const fogline78: Person[] = [...foglineHeld, ...emailMergePersons, ...urlMergePersons, ...liMergedFogline, ...importedPlain, ...emailInvited, ...dmInvited, ...queued];
  fogline78.forEach((p, i) => {
    append({ at: clock.at(-3, 300 + i), context: CTX.fogline, type: "fact", subtype: "lookup", actor: actorEventApp, persons: [p.id], ...factConfidence("chatham", "inferred"), payload: { kind: "initial" } });
  });
  foglineAccepted.forEach((p, i) => {
    append({ at: clock.at(-1, 100 + i), context: CTX.fogline, type: "fact", subtype: "lookup", actor: actorEventApp, persons: [p.id], ...factConfidence("chatham", "inferred"), payload: { kind: "deep" } });
  });

  // =======================================================================
  // Meera's LinkedIn — sightings, interactions, drafts, merges
  // =======================================================================
  const liSeries9: Person[] = [marcus, ...liSeriesOtherSlots.slice(1).map((i) => emberPastPersons[i])];
  const linkedin20: Person[] = [...liSeries9, ...liMergedFogline];

  linkedin20.forEach((p, i) => {
    append({ at: clock.at(-13, i), context: CTX.linkedin, type: "fact", subtype: "sighting", actor: actorLinkedInApp, persons: [p.id], confidence: "open", epistemics: "stated", payload: { post: `linkedin-post-${(i % 6) + 1}` } });
  });
  // 26 interactions (reply threads) across the 20, cycling so everyone gets >=1
  for (let i = 0; i < 26; i++) {
    const p = linkedin20[i % linkedin20.length];
    append({ at: clock.at(-12, i), context: CTX.linkedin, type: "interaction", actor: actorMeera, persons: [p.id], payload: { thread: i + 1 } });
  }
  // 20 merges into event-side records (9 series-side, 11 Fogline-side)
  linkedin20.forEach((p, i) => {
    p.merged.push({ person: `pre-merge:${p.id}:linkedin-sighting`, at: clock.at(-11, i), how: "anchor" });
    const liAnchor = p.anchors.find((a) => a.kind === "linkedin")!;
    append({ at: clock.at(-11, i), context: CTX.linkedin, type: "merged", actor: actorLinkedInApp, persons: [p.id], payload: { how: "anchor", anchor: { kind: "linkedin", value: liAnchor.value } } });
  });

  // Drafts: 38 proposed, 29 approved/released/landed
  for (let i = 0; i < 38; i++) {
    const p = linkedin20[i % linkedin20.length];
    append({ at: clock.at(-10 + Math.floor(i / 4), i), context: CTX.linkedin, type: "proposed", actor: actorLinkedInApp, persons: [p.id], payload: { draft: i + 1 } });
  }
  // 29 approvals land on exactly 9 of the 14 elapsed days (D-110: a day
  // bills only if it posted something approved) -> 9 billable, 5 dead (C12).
  const billableDayOffsets = [-14, -13, -11, -10, -8, -7, -5, -3, -1];
  for (let i = 0; i < 29; i++) {
    const p = linkedin20[i % linkedin20.length];
    const day = billableDayOffsets[i % billableDayOffsets.length];
    append({ at: clock.at(day, 60 + i), context: CTX.linkedin, type: "approved", subtype: "draft", actor: actorMeera, persons: [p.id], payload: { draft: i + 1 } });
  }
  for (let i = 0; i < 29; i++) {
    const p = linkedin20[i % linkedin20.length];
    append({ at: clock.at(-8 + Math.floor(i / 4), i), context: CTX.linkedin, type: "released", actor: actorLinkedInApp, persons: [p.id], payload: { draft: i + 1 } });
  }
  for (let i = 0; i < 29; i++) {
    const p = linkedin20[i % linkedin20.length];
    append({ at: clock.at(-7 + Math.floor(i / 4), i), context: CTX.linkedin, type: "landed", actor: actorLinkedInApp, persons: [p.id], payload: { draft: i + 1 } });
  }

  // =======================================================================
  // Public — Follows (12: 5 dinner-4, 7 fogline), 9 matched + 3 new
  // =======================================================================
  // Matched: 4 dinner-4 (Ember, from fresh pool), 5 fogline (from importedPlain, must have email)
  const dinner4MatchPersons = emberFreshPersons.slice(0, 4);
  const foglineEmailHolders = [...importedPlain.filter((p) => p.anchors.some((a) => a.kind === "email"))];
  const foglineMatchPersons = foglineEmailHolders.slice(0, 5);

  const newPublicOnly: Person[] = [];
  for (let i = 0; i < 3; i++) {
    const name = drawName(rngNames, usedNames);
    newPublicOnly.push(newPerson(name, clock.at(-4 + i), [makeAnchor("email", 9000 + i, name, CTX.public)]));
  }

  const dinner4Follows: { person: Person; matched: boolean }[] = [
    ...dinner4MatchPersons.map((p) => ({ person: p, matched: true })),
    { person: newPublicOnly[0], matched: false },
  ]; // 5
  const foglineFollows: { person: Person; matched: boolean }[] = [
    ...foglineMatchPersons.map((p) => ({ person: p, matched: true })),
    { person: newPublicOnly[1], matched: false },
    { person: newPublicOnly[2], matched: false },
  ]; // 7

  dinner4Follows.forEach(({ person, matched }, i) => {
    if (matched) {
      const email = person.anchors.find((a) => a.kind === "email")!;
      person.anchors.push({ kind: "email", value: email.value, verified: true, context: CTX.public });
    }
    append({ at: clock.at(-4, i), context: CTX.public, type: "follow", actor: actorLois, persons: [person.id], about: "dinner-4", payload: { listing: "dinner-4" } });
  });
  foglineFollows.forEach(({ person, matched }, i) => {
    if (matched) {
      const email = person.anchors.find((a) => a.kind === "email")!;
      person.anchors.push({ kind: "email", value: email.value, verified: true, context: CTX.public });
    }
    append({ at: clock.at(-1, 200 + i), context: CTX.public, type: "follow", actor: actorLois, persons: [person.id], about: "fogline-event", payload: { listing: "fogline-event" } });
  });

  // 9 merge-confirmed (public): 4 dinner-4-matched + 5 fogline-matched
  [...dinner4MatchPersons, ...foglineMatchPersons].forEach((p, i) => {
    p.merged.push({ person: `pre-merge:${p.id}:public-follow`, at: clock.at(-4, 50 + i), how: "anchor" });
    const email = p.anchors.find((a) => a.kind === "email" && a.context === CTX.public)!;
    append({ at: clock.at(-4, 50 + i), context: CTX.public, type: "merged", actor: actorLois, persons: [p.id], payload: { how: "anchor", anchor: { kind: "email", value: email.value } } });
  });

  // =======================================================================
  // Platform fixtures — Layer A (Luma / Partiful shaped)
  // =======================================================================
  const lumaRosterRows = [];
  for (const dinner of [1, 2, 3] as Dinner[]) {
    for (let slotIdx = 0; slotIdx < 45; slotIdx++) {
      if (!emberPastSlots[slotIdx].dinners.includes(dinner)) continue;
      const person = emberPastPersons[slotIdx];
      lumaRosterRows.push({ gathering: dinnerId[dinner], personName: person.name, personId: person.id, rsvp: "attended" });
    }
  }
  emberFreshPersons.forEach((p) => {
    const entry = d4InvitedPersons.find((x) => x.person.id === p.id)!;
    lumaRosterRows.push({ gathering: "dinner-4", personName: p.name, personId: p.id, rsvp: entry.response === "noreply" ? "no-reply" : entry.response });
  });
  // returning invitees also show a dinner-4 row on Luma once invited
  returningInvitedSlots.forEach((slotIdx) => {
    const person = emberPastPersons[slotIdx];
    const entry = d4InvitedPersons.find((x) => x.person.id === person.id)!;
    lumaRosterRows.push({ gathering: "dinner-4", personName: person.name, personId: person.id, rsvp: entry.response === "noreply" ? "no-reply" : entry.response });
  });
  const lumaFixture: PlatformFixture = {
    platform: "luma",
    context: CTX.ember,
    rosterRows: lumaRosterRows,
    releasedInvites: d4InvitedPersons.map(({ person }) => ({ personId: person.id, gathering: "dinner-4" })),
  };

  const rsvpLabel = (p: Person): string => {
    if (imp_accepted.includes(p) || inv_accepted.includes(p)) return "accepted";
    if (imp_tentative.includes(p) || inv_tentative.includes(p)) return "tentative";
    if (imp_declined.includes(p) || inv_declined.includes(p)) return "declined";
    if (imp_noreply.includes(p) || inv_noreply.includes(p)) return "no-reply";
    return "uninvited";
  };
  const partifulRosterRows = [
    ...importedAtConnect.map((p) => ({ gathering: "fogline-event", personName: p.name, personId: p.id, rsvp: rsvpLabel(p) })),
    ...invitedSoFar.map(({ p }) => ({ gathering: "fogline-event", personName: p.name, personId: p.id, rsvp: rsvpLabel(p) })),
  ];
  const partifulFixture: PlatformFixture = {
    platform: "partiful",
    context: CTX.fogline,
    rosterRows: partifulRosterRows,
    releasedInvites: [...invitedSoFar.map(({ p }) => ({ personId: p.id, gathering: "fogline-event" })), { personId: nadia.id, gathering: "fogline-event" }],
  };

  return {
    seed,
    epoch: epochIso,
    contexts,
    gatherings,
    persons,
    grants,
    entries,
    platform: [lumaFixture, partifulFixture],
    voiceSamples,
    profiles,
  };
}
