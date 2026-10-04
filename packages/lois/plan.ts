// hg/plan — the re-invite plan, as pure reads over the World (D-042).
//
// Shared by the running face panes AND the node re-invite flow proof
// (tools/hg-vault/reinvite-flow.ts), so the ranking + draft copy are ONE
// definition, exercised two ways. No DOM, no node: pure functions over the
// projection contracts' World shape, so both callers import the same file.
//
// The re-invite audience is the RETURNING past guests (D-059 series memory,
// D-065 spans-the-series): persons a fact/attendance Entry names about an
// earlier gathering in this Context. Loyalty = how many past dinners a
// person attended (the count of those attendance receipts) — the same
// loyalty rank his real Hacker Garage data carries. Nothing here invents a
// number: every figure is a count over Entries.

import type { Entry, World } from "../../tools/projections/types.js";

/** One past guest, aggregated + loyalty-scored from the Stream. */
export interface PastGuest {
  /** Person id (the ego-graph node). */
  person: string;
  name: string;
  /** First-name merge token for the low-personalization draft. */
  firstName: string;
  /** Email anchor in this Context, when held (email is the send + join key). */
  email?: string;
  /** Loyalty = count of fact/attendance receipts about earlier gatherings. */
  loyalty: number;
  /** ISO date of the most recent past gathering this person attended. */
  lastAttended?: string;
}

/** First-name token: strip a trailing "(LLL)"-style tag, take the first word. */
export function firstNameOf(name: string): string {
  const cleaned = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const tok = cleaned.split(/\s+/)[0] ?? cleaned;
  return tok.length > 0 ? tok : name;
}

/**
 * The re-invite audience for `upcomingGatheringId`: past guests who attended
 * an earlier gathering in the same Context, ranked by loyalty (desc) and
 * then by person id (stable) — which reproduces his real loyalty ranking,
 * since the vault registers persons in that ranked order.
 */
export function aggregateReturning(world: World, upcomingGatheringId: string): PastGuest[] {
  const gathering = world.gatherings.find((g) => g.id === upcomingGatheringId);
  if (!gathering) throw new Error(`aggregateReturning: no gathering "${upcomingGatheringId}"`);
  const ctxId = gathering.context;
  const here = new Date(gathering.date).getTime();

  // Earlier gatherings in this Context (series memory, GMA #2).
  const earlier = new Map(
    world.gatherings
      .filter((g) => g.context === ctxId && g.id !== gathering.id && new Date(g.date).getTime() < here)
      .map((g) => [g.id, g] as const),
  );

  // Loyalty = count of fact/attendance receipts about earlier gatherings.
  const loyalty = new Map<string, number>();
  const lastAt = new Map<string, string>();
  for (const e of world.entries) {
    if (e.context !== ctxId) continue;
    if (e.type !== "fact" || e.subtype !== "attendance") continue;
    if (e.about === undefined || !earlier.has(e.about)) continue;
    const when = earlier.get(e.about)!.date;
    for (const p of e.persons ?? []) {
      loyalty.set(p, (loyalty.get(p) ?? 0) + 1);
      const prev = lastAt.get(p);
      if (prev === undefined || new Date(when).getTime() > new Date(prev).getTime()) lastAt.set(p, when);
    }
  }

  const personById = new Map(world.persons.map((p) => [p.id, p]));
  const rows: PastGuest[] = [];
  for (const [person, count] of loyalty) {
    const rec = personById.get(person);
    const email = rec?.anchors.find((a) => a.kind === "email" && a.context === ctxId)?.value;
    rows.push({
      person,
      name: rec?.name ?? person,
      firstName: firstNameOf(rec?.name ?? person),
      email,
      loyalty: count,
      lastAttended: lastAt.get(person),
    });
  }

  // Loyalty desc, then person id asc (the vault's ranked registration order).
  rows.sort((a, b) => b.loyalty - a.loyalty || a.person.localeCompare(b.person));
  return rows;
}

// ---------------------------------------------------------------------------
// The draft — low personalization, warm Hacker Garage voice, first-name merge.
// COPY-PENDING (the deslop rite seals the final words). Plain speech; no em or
// en dashes in customer strings (T1); one gathering name merged in.
// ---------------------------------------------------------------------------

export function draftSubject(gatheringName: string): string {
  return `Back for ${gatheringName}?`;
}

export function draftBody(firstName: string, gatheringName: string): string {
  return (
    `${firstName}, good having you at Hacker Garage. ` +
    `We are back Monday for ${gatheringName}, same table, come hungry. ` +
    `Seat is yours if you want it. Just say the word.`
  );
}

/** The plan-as-story glance (D-063): the waves, as a simple summary. */
export function planWaves(keptCount: number): string[] {
  return [
    `Today: invite all ${keptCount}, by email.`,
    "As people reply yes: I show you each one so you can wave them in.",
    "Saturday: nudge the people you most want, if they have not answered.",
    "Sunday: one reminder to everyone confirmed.",
  ];
}

/** The one join key a draft carries so its lifecycle Entries reconcile. */
export function inviteKind(): string {
  return "invite";
}

/** Distinct returning persons — a figure, not a guess. */
export function countReturning(world: World, upcomingGatheringId: string): number {
  return aggregateReturning(world, upcomingGatheringId).length;
}

export type { Entry };
