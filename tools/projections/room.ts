// deriveRoom — The Room as a pure read over the Stream.
//
// The Room is a Projection: every figure below equals a count over Entries
// in the Context — one fact, derived at read time, never stored twice
// (spec §0; GMA #1/#5; rebuild contract #6: "Entries first, Projections
// never"). The RSVP fold is the same derivation the seed world's own
// check.ts proves possible at build time (C7/C8): imported platform state,
// moved forward only by invite-lifecycle and response Entries.

import type {
  AnchorCoverage,
  AnchorKind,
  Entry,
  Figure,
  Gathering,
  LookupMeter,
  RoomGuestRow,
  RoomView,
  RsvpStatus,
  SeriesSplit,
  World,
} from "./types.js";
import { deriveQueue } from "./queue.js";

/** D-004: 1,000 guest lookups included per event. A product constant, not stored state. */
const LOOKUP_ALLOWANCE = 1000;

export function deriveRoom(world: World, contextOrGatheringId: string, cursor?: number): RoomView {
  // Resolve the gathering the Room is about: a gathering id names it
  // directly; a context id means "the context's upcoming gathering" (the
  // Room's default face — both seed contexts have exactly one).
  let gathering: Gathering | undefined = world.gatherings.find((g) => g.id === contextOrGatheringId);
  if (!gathering) {
    const ctx = world.contexts.find((c) => c.id === contextOrGatheringId);
    if (!ctx) throw new Error(`deriveRoom: "${contextOrGatheringId}" is neither a gathering id nor a context id`);
    const upcoming = world.gatherings.filter((g) => g.context === ctx.id && g.upcoming);
    if (upcoming.length !== 1) {
      throw new Error(`deriveRoom: context "${ctx.id}" has ${upcoming.length} upcoming gatherings — pass a gathering id`);
    }
    gathering = upcoming[0];
  }
  const ctxId = gathering.context;
  const context = world.contexts.find((c) => c.id === ctxId);
  if (!context) throw new Error(`deriveRoom: gathering "${gathering.id}" names unknown context "${ctxId}"`);

  // Time is a cursor: read strictly at-or-before it; default = full stream.
  const atCursor = cursor ?? (world.entries.length > 0 ? world.entries[world.entries.length - 1].cursor : -1);
  const ctxEntries = world.entries.filter((e) => e.cursor <= atCursor && e.context === ctxId);

  // ---------------------------------------------------------------------
  // Roster: distinct Persons over imported/guest Entries in the Context,
  // in first-import order. §3.2's Room is "of 57 Persons in the Context" —
  // the whole Context, not just this gathering's rows — which is also why
  // uninvited is a state the Room can show at all.
  // ---------------------------------------------------------------------
  const imports = ctxEntries.filter((e) => e.type === "imported" && e.subtype === "guest");
  const rosterOrder: string[] = [];
  const seen = new Set<string>();
  for (const e of imports) {
    for (const p of e.persons ?? []) {
      if (!seen.has(p)) {
        seen.add(p);
        rosterOrder.push(p);
      }
    }
  }

  // ---------------------------------------------------------------------
  // RSVP fold, per person, relative to the Room's gathering (§10.1 words):
  //   1. base = payload.rsvp on the guest-imported Entry about this
  //      gathering (the platform state the import observed), else uninvited;
  //   2. a landed invite (type=landed, payload.kind=invite, about this
  //      gathering) moves uninvited -> no-reply (§10.1: unanswered invites
  //      are no-reply; the word "pending" never appears);
  //   3. the latest response Interaction (payload.response, about this
  //      gathering) wins. rsvp_change Interactions are audit trail of a
  //      state the import Entry already carries — they set nothing.
  // This is C8's derivation verbatim, and C7's when no import carries rsvp.
  // ---------------------------------------------------------------------
  const landedInvites = ctxEntries.filter(
    (e) => e.type === "landed" && e.about === gathering.id && (e.payload as Record<string, unknown>)?.kind === "invite",
  );
  const responses = ctxEntries.filter(
    (e) => e.type === "interaction" && e.about === gathering.id && typeof (e.payload as Record<string, unknown>)?.response === "string",
  );
  function rsvpFor(personId: string): { status: RsvpStatus; why: string } {
    const imp = imports.find((e) => e.about === gathering!.id && (e.persons ?? []).includes(personId));
    const importedRsvp = (imp?.payload as Record<string, unknown> | undefined)?.rsvp;
    let status: RsvpStatus = typeof importedRsvp === "string" ? (importedRsvp as RsvpStatus) : "uninvited";
    let why =
      typeof importedRsvp === "string"
        ? `imported ${imp!.id} payload.rsvp=${importedRsvp}`
        : `no imported rsvp about ${gathering!.id} -> uninvited`;
    const landed = landedInvites.find((e) => (e.persons ?? []).includes(personId));
    if (landed && status === "uninvited") {
      status = "no-reply";
      why = `landed invite ${landed.id} -> no-reply`;
    }
    let latest: Entry | undefined;
    for (const e of responses) if ((e.persons ?? []).includes(personId)) latest = e; // ctxEntries is in cursor order
    if (latest) {
      status = (latest.payload as Record<string, unknown>).response as RsvpStatus;
      why = `interaction ${latest.id} payload.response=${status}`;
    }
    return { status, why };
  }

  // ---------------------------------------------------------------------
  // Series memory (GMA #2): returning = a fact/attendance Entry about an
  // earlier gathering names the person. Present only where the Context has
  // earlier gatherings — a one-time event has no memory to split.
  // ---------------------------------------------------------------------
  const earlier = world.gatherings.filter(
    (g) => g.context === ctxId && g.id !== gathering!.id && new Date(g.date).getTime() < new Date(gathering!.date).getTime(),
  );
  const earlierIds = new Set(earlier.map((g) => g.id));
  const pastAttendees = new Set<string>();
  for (const e of ctxEntries) {
    if (e.type === "fact" && e.subtype === "attendance" && e.about !== undefined && earlierIds.has(e.about)) {
      for (const p of e.persons ?? []) pastAttendees.add(p);
    }
  }

  // Lookup receipts (fact/lookup Entries) — enrichment state per person, and
  // the meter's consumed count (a Projection over receipts, never a counter).
  const lookupEntries = ctxEntries.filter((e) => e.type === "fact" && e.subtype === "lookup");
  const lookupKinds = new Map<string, { initial: boolean; deep: boolean }>();
  for (const e of lookupEntries) {
    const kind = (e.payload as Record<string, unknown>)?.kind;
    for (const p of e.persons ?? []) {
      const state = lookupKinds.get(p) ?? { initial: false, deep: false };
      if (kind === "initial") state.initial = true;
      if (kind === "deep") state.deep = true;
      lookupKinds.set(p, state);
    }
  }

  const personById = new Map(world.persons.map((p) => [p.id, p]));
  const guests: RoomGuestRow[] = rosterOrder.map((personId) => {
    const person = personById.get(personId);
    const { status, why } = rsvpFor(personId);
    // Anchors this Context holds for the person — §7.2 reads coverage off
    // the Person records, exactly as the seed world's own check does.
    const kinds: AnchorKind[] = [];
    for (const a of person?.anchors ?? []) {
      if (a.context === ctxId && !kinds.includes(a.kind)) kinds.push(a.kind);
    }
    return {
      person: personId,
      name: person?.name ?? personId,
      rsvp: status,
      rsvpWhy: why,
      anchors: kinds,
      lookups: lookupKinds.get(personId) ?? { initial: false, deep: false },
      ...(earlier.length > 0 ? { returning: pastAttendees.has(personId) } : {}),
    };
  });

  // ---------------------------------------------------------------------
  // Figures — every count carries its provenance (the introspection law).
  // ---------------------------------------------------------------------
  const rsvpFold =
    `guest-imported payload.rsvp base, landed-invite -> no-reply, latest interaction payload.response wins; ` +
    `context=${ctxId}, gathering=${gathering.id}, cursor<=${atCursor}`;
  const statusFigure = (status: RsvpStatus): Figure => ({
    count: guests.filter((g) => g.rsvp === status).length,
    source: "entries",
    entryTypes: ["imported", "landed", "interaction"],
    filter: `${rsvpFold}; status=${status}`,
  });
  const statusCounts: Record<RsvpStatus, Figure> = {
    accepted: statusFigure("accepted"),
    tentative: statusFigure("tentative"),
    declined: statusFigure("declined"),
    "no-reply": statusFigure("no-reply"),
    uninvited: statusFigure("uninvited"),
  };

  const total: Figure = {
    count: guests.length,
    source: "entries",
    entryTypes: ["imported"],
    filter: `distinct persons over type=imported subtype=guest entries, context=${ctxId}, cursor<=${atCursor}`,
  };

  const anchorFigure = (kind: AnchorKind): Figure => ({
    count: guests.filter((g) => g.anchors.includes(kind)).length,
    source: "persons",
    filter: `roster persons holding a ${kind} anchor with anchor.context=${ctxId} (Person records, §7.2)`,
  });
  const anchors: AnchorCoverage = { email: anchorFigure("email"), phone: anchorFigure("phone"), linkedin: anchorFigure("linkedin") };

  const lookups: LookupMeter = {
    consumed: {
      count: lookupEntries.length,
      source: "entries",
      entryTypes: ["fact"],
      filter: `type=fact subtype=lookup entries (the receipts), context=${ctxId}, cursor<=${atCursor}`,
    },
    allowance: LOOKUP_ALLOWANCE,
    remaining: LOOKUP_ALLOWANCE - lookupEntries.length,
  };

  let series: SeriesSplit | undefined;
  if (earlier.length > 0) {
    const returningGuests = guests.filter((g) => g.returning === true);
    const seriesFilter = `fact/attendance entries about earlier gatherings [${earlier.map((g) => g.id).join(", ")}], context=${ctxId}, cursor<=${atCursor}`;
    series = {
      returning: { count: returningGuests.length, source: "entries", entryTypes: ["fact"], filter: `roster persons named by ${seriesFilter}` },
      firstTimers: { count: guests.length - returningGuests.length, source: "entries", entryTypes: ["fact"], filter: `roster persons NOT named by ${seriesFilter}` },
      acceptedReturning: {
        count: guests.filter((g) => g.rsvp === "accepted" && g.returning === true).length,
        source: "entries",
        entryTypes: ["fact", "imported", "landed", "interaction"],
        filter: `accepted (per rsvp fold) AND named by ${seriesFilter}`,
      },
      acceptedFirstTimers: {
        count: guests.filter((g) => g.rsvp === "accepted" && g.returning !== true).length,
        source: "entries",
        entryTypes: ["fact", "imported", "landed", "interaction"],
        filter: `accepted (per rsvp fold) AND NOT named by ${seriesFilter}`,
      },
    };
  }

  // "Awaiting your yes" and "sent and verified" are the queue's own figures
  // for this gathering — one derivation, read from two surfaces, so the
  // cross-surface agreement (SOCIAL-1 / LOOP-1 crossTruths) is structural:
  // disagreement is unrepresentable.
  const queue = deriveQueue(world, gathering.id, atCursor);

  return {
    context: ctxId,
    contextName: context.name,
    gathering: gathering.id,
    gatheringName: gathering.name,
    gatheringDate: gathering.date,
    upcoming: gathering.upcoming,
    cursor: atCursor,
    guests,
    total,
    statusCounts,
    awaiting: queue.counts.queued,
    landed: queue.counts.landed,
    series,
    anchors,
    lookups,
  };
}
