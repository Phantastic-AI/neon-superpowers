// Projection contracts — The Room and the queue (the D-042 boundary).
//
// These are the ONLY shapes the UI consumes for the two first surfaces. The
// real engine later slides in behind deriveRoom/deriveQueue unchanged: same
// World in, same views out. The laws these shapes obey:
//
//   - The Room is a Projection: every figure equals a count over Entries in
//     the Context — one fact, derived at read time, never stored twice
//     (spec §0 "Projections are never seeded"; GMA #1/#5; rebuild contract
//     #6). No field below is projection-private state; every field is a
//     pure function of World (+ cursor).
//   - Meters are Projections over receipts, never counters: the lookup
//     meter is a count over fact/lookup Entries (the receipts), and the
//     allowance is a product constant (D-004), not stored state.
//   - Every figure explains itself: counts are `Figure`s carrying the entry
//     types and the mechanical filter that produced them, so "why is this
//     number here" is answerable mechanically.
//   - One word per state (D-024): every enum below reuses the seed world's
//     entry-type words and §10.1's state words verbatim. The word "pending"
//     never appears (§10.1) — unanswered invites are `no-reply`, undecided
//     drafts are `queued`, so the two can never be confused.
//   - Time is a cursor: both derive functions take an optional cursor
//     (position in stream.jsonl's append order, = Entry.cursor) and compute
//     strictly over entries at-or-before it. Default: the full stream.

import type {
  Entry,
  EntryType,
  Person,
  Context,
  Gathering,
  AnchorKind,
} from "../seed-world/types.js";

export type { Entry, EntryType, Person, Context, Gathering, AnchorKind };

// ---------------------------------------------------------------------------
// World — the generated seed world, as read from tools/seed-world/out/
// ---------------------------------------------------------------------------

export interface World {
  /** stream.jsonl in line order — the line at index i carries cursor i. */
  entries: Entry[];
  persons: Person[];
  contexts: Context[];
  gatherings: Gathering[];
}

// ---------------------------------------------------------------------------
// Figure — a count that explains itself (the introspection law)
// ---------------------------------------------------------------------------

export interface Figure {
  count: number;
  /**
   * What the count is over. "entries" for everything Stream-derived;
   * "persons" only for anchor coverage — §7.2's coverage table reads
   * Anchors off the Person records (the ego-graph), the one non-Entry read
   * these views make, exactly as the seed world's own check does.
   */
  source: "entries" | "persons";
  /** Entry types the count was derived over, verbatim ENTRY_TYPES words. Present iff source === "entries". */
  entryTypes?: EntryType[];
  /** The mechanical filter: context / subtype / about / payload predicates and the fold rule applied. */
  filter: string;
}

// ---------------------------------------------------------------------------
// State vocabularies — §10.1 verbatim, one word per state (D-024)
// ---------------------------------------------------------------------------

/** Invite/RSVP words: "uninvited · no-reply · accepted · tentative · declined" (§10.1). */
export const RSVP_STATUSES = ["accepted", "tentative", "declined", "no-reply", "uninvited"] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

/**
 * The draft states a queue row can currently hold. `queued` is §10.1's own
 * derived word (proposed, undecided); the rest are the entry-type words
 * verbatim (`landed` is the seed world's enum word for §10.1's
 * "verified-landed"). §10.1 also names `lapsed` (proposed, never decided) —
 * distinguishing lapsed from queued needs a decision/expiry policy the seed
 * world does not encode, so this contract derives only the honest union
 * (undecided = queued) and the README files the gap.
 */
export const DRAFT_STATUSES = ["queued", "approved", "released", "landed"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

// ---------------------------------------------------------------------------
// RoomView — The Room: who is coming, derived
// ---------------------------------------------------------------------------

export interface RoomGuestRow {
  /** Person id (the vault's ego-graph node). */
  person: string;
  /** Display name, from the Person record. */
  name: string;
  /** RSVP state relative to the Room's gathering — §10.1 words only. */
  rsvp: RsvpStatus;
  /** Introspection: which entry (by id) and which fold rule decided `rsvp`. */
  rsvpWhy: string;
  /** Anchor kinds this Context holds for the person (Person.anchors filtered to the Room's context, §7.2). */
  anchors: AnchorKind[];
  /** Enrichment state: which lookup receipts (fact/lookup Entries) name this person. */
  lookups: { initial: boolean; deep: boolean };
  /** Series contexts only: a fact/attendance Entry about an earlier gathering names this person. */
  returning?: boolean;
}

/** The first-timers vs returning split — series gatherings only (GMA #2: the Context has memory). */
export interface SeriesSplit {
  returning: Figure;
  firstTimers: Figure;
  /** C7's finer split: of the accepted, how many are returning vs first-time. */
  acceptedReturning: Figure;
  acceptedFirstTimers: Figure;
}

/** §7.2 anchor coverage over the roster (a Person counts once per kind held in this Context). */
export interface AnchorCoverage {
  email: Figure;
  phone: Figure;
  linkedin: Figure;
}

/** The lookup allowance meter — a Projection over receipts, never a counter (D-004: 1,000 included). */
export interface LookupMeter {
  /** Count of fact/lookup Entries in the Context (the receipts). */
  consumed: Figure;
  /** The product constant, D-004 — not stored state. */
  allowance: number;
  /** allowance − consumed.count — derived, never stored. */
  remaining: number;
}

export interface RoomView {
  /** The Context this Room projects over — every figure is a count inside this boundary. */
  context: string;
  contextName: string;
  /** The gathering the Room is about (the upcoming one, or the one asked for). */
  gathering: string;
  gatheringName: string;
  gatheringDate: string;
  upcoming: boolean;
  /** The cursor this view was derived at (entries with Entry.cursor <= this were read). */
  cursor: number;
  /** One row per Person sighted via a guest-imported Entry in the Context, in first-import order. */
  guests: RoomGuestRow[];
  /** Distinct Persons over imported/guest Entries in the Context = guests.length. */
  total: Figure;
  /** The §10.1 states, each a Figure; the five counts sum to total.count. */
  statusCounts: Record<RsvpStatus, Figure>;
  /**
   * "Awaiting your yes" — queued outbound drafts about this gathering.
   * This IS deriveQueue(world, gathering, cursor).counts.queued, the very
   * Figure the queue serves for the same scope: the same fact read twice,
   * so cross-surface disagreement is unrepresentable (SOCIAL-1/LOOP-1
   * crossTruths: "they must agree to the digit").
   */
  awaiting: Figure;
  /** Sent-and-verified for this gathering — deriveQueue(...).counts.landed, same shared derivation (LOOP-1 crossTruth). */
  landed: Figure;
  /** Present iff the Context holds gatherings earlier than this one (series memory, GMA #2). */
  series?: SeriesSplit;
  /** §7.2 coverage over the roster. Read from Person records — not cursor-scoped (anchors carry no append position). */
  anchors: AnchorCoverage;
  /** The lookup allowance meter (D-004), a Projection over fact/lookup receipts. */
  lookups: LookupMeter;
}

// ---------------------------------------------------------------------------
// QueueView — the approval queue: drafts awaiting, and what became of the rest
// ---------------------------------------------------------------------------

export interface QueueRow {
  /** The draft-proposed Entry's id — a queue row IS a proposed Entry, projected. */
  id: string;
  context: string;
  /** The gathering this draft concerns, when the Entry says (event drafts do; LinkedIn drafts don't). */
  about?: string;
  /** Addressee Person id (persons[0] on the proposed Entry), when the Entry names one. */
  person?: string;
  /** Addressee display name, from the Person record. */
  addressee?: string;
  /** payload.kind verbatim where the Entry carries it (invite | nudge); absent where it doesn't. */
  kind?: string;
  /** payload.channel verbatim where the Entry carries it (email | linkedin); absent where it doesn't. */
  channel?: string;
  /**
   * The full outbound text, verbatim from the Entry payload, where the seed
   * carries it. D-022's approval-gate law wants every text shown in full;
   * this seed world's draft Entries carry no text, so this field is honestly
   * absent everywhere — see README "Gaps". The contract field exists so the
   * engine can populate it without a shape change.
   */
  text?: string;
  /** Current state: furthest lifecycle stage reached (§10.1 derived; queued = proposed, undecided). */
  status: DraftStatus;
  proposedAt: string;
  /**
   * Introspection: the lifecycle Entries (by id) this row's status was
   * derived from. The join key is documented in queue.ts (payload.draft
   * number where present, else person+gathering+kind) — these ids make
   * every join auditable.
   */
  lifecycle: { proposed: string; approved?: string; released?: string; landed?: string };
}

export interface QueueView {
  /** "all", a context id, or a gathering id. */
  scope: string;
  /** The cursor this view was derived at. */
  cursor: number;
  /** One row per draft-proposed Entry in scope, in append order. */
  rows: QueueRow[];
  /**
   * Counts by current status. Each row lands in exactly one bucket, so
   * proposed = queued + approved + released + landed. `queued` is the
   * "awaiting your yes" figure — §10.1: the word "pending" never appears.
   */
  counts: {
    proposed: Figure;
    queued: Figure;
    approved: Figure;
    released: Figure;
    landed: Figure;
  };
}
