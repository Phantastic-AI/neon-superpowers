// lois/tools — Lois's TOOLS, as plain async functions over the existing engine.
//
// This is the "hands" the agent loop (agent.ts) reaches through. Each tool is a
// thin, pure wrapper over a capability the app ALREADY has — the projection
// contracts (deriveRoom/deriveQueue), the re-invite plan (hg/plan.ts), and the
// send PORT's shared guard (senders/types.ts). No tool invents a number: every
// figure it returns is a count or a derivation the untouched engine produces.
//
// Two tools are STUBS on purpose (this is the first slice):
//   - read():  the browser-driven page read is not live yet. read() returns
//              what we know from the already-built vault and says so, so a real
//              read-page organ can slot in behind the same shape later.
//   - send():  gated. It NEVER delivers in this slice, and it THROWS unless the
//              caller passes { approved: true } — the D-086 approval checkpoint,
//              represented in code: nothing leaves without the operator's yes.
//
// Browser-safe: this file imports only pure modules (projections, plan, the
// sender PORT types). No node built-ins, so it typechecks alongside the face
// bundle and could run either side of the wire.

import { deriveRoom } from "../../tools/projections/room.js";
import { deriveQueue } from "../../tools/projections/queue.js";
import { RSVP_STATUSES, type RsvpStatus, type World } from "../../tools/projections/types.js";
import { aggregateReturning } from "./plan.js";
import { messageProblem, type EmailMessage } from "../senders/types.js";

// ---------------------------------------------------------------------------
// look — read the Room: who is coming, as derived counts (deriveRoom/Queue).
// ---------------------------------------------------------------------------

export interface LookSummary {
  gathering: string;
  gatheringName: string;
  gatheringDate: string;
  upcoming: boolean;
  /** Distinct persons on the Context roster (deriveRoom.total). */
  totalGuests: number;
  /** The five §10.1 RSVP states, each a count. */
  rsvp: Record<RsvpStatus, number>;
  /** Returning past-attendees on the roster (series memory), 0 for one-offs. */
  returning: number;
  /** Queued outbound invites awaiting the operator's yes (deriveRoom.awaiting). */
  awaiting: number;
  /** Sent-and-verified invites for this gathering (deriveRoom.landed). */
  landed: number;
  /** Draft-proposed rows in scope (deriveQueue.counts.proposed). */
  proposed: number;
}

/** Read the Room for `gatheringId` and fold it into a compact, promptable summary. */
export async function look(world: World, gatheringId: string): Promise<LookSummary> {
  const room = deriveRoom(world, gatheringId);
  const queue = deriveQueue(world, gatheringId);
  const rsvp = {} as Record<RsvpStatus, number>;
  for (const s of RSVP_STATUSES) rsvp[s] = room.statusCounts[s].count;
  return {
    gathering: room.gathering,
    gatheringName: room.gatheringName,
    gatheringDate: room.gatheringDate,
    upcoming: room.upcoming,
    totalGuests: room.total.count,
    rsvp,
    returning: room.series ? room.series.returning.count : 0,
    awaiting: room.awaiting.count,
    landed: room.landed.count,
    proposed: queue.counts.proposed.count,
  };
}

// ---------------------------------------------------------------------------
// rank — the re-invite audience: returning regulars, loyalty-ranked (plan.ts).
// Emails are deliberately reduced to a boolean here so no address ever flows
// into a prompt or a printed trace (the send key stays out of the loop's mouth).
// ---------------------------------------------------------------------------

export interface RankedGuest {
  person: string;
  name: string;
  firstName: string;
  /** Loyalty = count of past dinners attended (fact/attendance receipts). */
  loyalty: number;
  lastAttended?: string;
  /** Whether an email anchor is held for this Context (the send key exists). */
  hasEmail: boolean;
}

/** Rank the returning regulars for `gatheringId` by loyalty (desc), then id. */
export async function rank(world: World, gatheringId: string): Promise<RankedGuest[]> {
  return aggregateReturning(world, gatheringId).map((g) => ({
    person: g.person,
    name: g.name,
    firstName: g.firstName,
    loyalty: g.loyalty,
    lastAttended: g.lastAttended,
    hasEmail: typeof g.email === "string" && g.email.length > 0,
  }));
}

// ---------------------------------------------------------------------------
// (draft() is GONE — D-113. A drafting "tool" that returns template copy is a
// sentence Lois might say, living in code. The mind authors every draft.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// read — STUB. The browser-driven page read is not live in this slice.
// Same shape a real read-page organ can return, so it slots in later.
// ---------------------------------------------------------------------------

export interface ReadResult {
  live: false;
  source: string;
  note: string;
  /** What we already know from the built vault (deriveRoom.total). */
  guests: number;
}

/** STUB: report the already-built vault; a live browser read slots in behind this later. */
export async function read(world: World, gatheringId: string): Promise<ReadResult> {
  const room = deriveRoom(world, gatheringId);
  return {
    live: false,
    source: "prebuilt-hacker-garage-vault",
    note:
      "read() is a stub in this slice: the live browser page read is not wired yet. " +
      "Figures come from the vault already built on disk, not from a fresh page read.",
    guests: room.total.count,
  };
}

// ---------------------------------------------------------------------------
// send — STUB + GUARDRAIL. The D-086 approval checkpoint, represented in code:
// throws unless { approved: true }, and never delivers in this slice.
// ---------------------------------------------------------------------------

export interface SendGateResult {
  delivered: false;
  gated: true;
  approved: true;
  to: string;
  subject: string;
  note: string;
}

/**
 * STUB: the approval gate, made real. Throws unless the caller passes
 * { approved: true } — nothing leaves without the operator's yes (D-086). Even
 * once approved, this slice wires no live sender, so it records the intent and
 * delivers NOTHING. A real EmailSender (getSender / selectSender) slots in here.
 */
export async function send(msg: EmailMessage, opts: { approved: boolean }): Promise<SendGateResult> {
  if (!opts || opts.approved !== true) {
    throw new Error(
      "send blocked: approval gate not passed (D-086). Pass { approved: true } only after the operator's explicit yes.",
    );
  }
  const problem = messageProblem(msg);
  if (problem) throw new Error(`send blocked: ${problem}`);
  return {
    delivered: false,
    gated: true,
    approved: true,
    to: msg.to,
    subject: msg.subject,
    note:
      "send() is a stub in this slice: the approval gate passed, but no live sender is wired. " +
      "Nothing was delivered.",
  };
}

// (TOOL_SPECS is GONE — D-113. The old tool-selection catalog belonged to the
// scripted loop; the mind's sense surface is declared where the mind is.)
