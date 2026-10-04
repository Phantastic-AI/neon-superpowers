// hg/draft-entries — the session's draft lifecycle Entries (browser side).
//
// The face runs the re-invite flow live: aggregating past guests, drafting,
// and moving each draft through queued -> approved -> released -> landed.
// Those transitions ARE Entries in the sealed stream vocabulary. On disk the
// engine writes them through appendEntry (packages/vault) — proven end to end
// by tools/hg-vault/reinvite-flow.ts. In the browser (no node fs) we build
// the SAME Entry shapes as SESSION state and derive the queue over
// {...world, entries: [...world.entries, ...session]} — exactly the pattern
// the seed queue pane documents ("the engine later writes approved/released
// Entries behind the same contract"). This module never touches the vault;
// it only constructs Entry objects in the projections' World shape so
// deriveQueue reads them unchanged.

import type { Entry } from "../../../../tools/projections/types.js";
import { inviteKind } from "./plan.js";

/** Lois is the drafting actor; the app moves the lifecycle. */
const LOIS = { kind: "lois" as const, ref: "lois" };
const APP = { kind: "app" as const, ref: "app-event" };

/** A draft the flow carries in memory, with its addressee + text. */
export interface SessionDraft {
  person: string;
  name: string;
  email?: string;
  subject: string;
  body: string;
}

/**
 * Build the proposed-draft Entries for the kept re-invites, assigning cursors
 * after the loaded world's last entry (Time is a cursor: append order). Each
 * draft carries payload.kind=invite, payload.channel=email, and the full
 * outbound text, so deriveQueue serves QueueRow.text/channel and the whole
 * lifecycle reconciles on (context, person, about, kind).
 */
export function proposedEntries(
  drafts: SessionDraft[],
  ctx: string,
  gatheringId: string,
  baseCursor: number,
  at: string,
): Entry[] {
  return drafts.map((d, i) => {
    const cursor = baseCursor + i;
    return {
      id: `e-${String(cursor + 1).padStart(6, "0")}`,
      cursor,
      at,
      context: ctx,
      type: "proposed",
      actor: LOIS,
      persons: [d.person],
      about: gatheringId,
      payload: { kind: inviteKind(), channel: "email", text: d.body, subject: d.subject },
    } satisfies Entry;
  });
}

/** One lifecycle-stage Entry per draft (approved/released/landed), same join key. */
export function lifecycleEntries(
  drafts: SessionDraft[],
  ctx: string,
  gatheringId: string,
  stage: "approved" | "released" | "landed",
  baseCursor: number,
  at: string,
): Entry[] {
  return drafts.map((d, i) => {
    const cursor = baseCursor + i;
    const base = {
      id: `e-${String(cursor + 1).padStart(6, "0")}`,
      cursor,
      at,
      context: ctx,
      actor: stage === "approved" ? LOIS : APP,
      persons: [d.person],
      about: gatheringId,
    };
    if (stage === "approved") {
      return { ...base, type: "approved", subtype: "draft", payload: { kind: inviteKind(), channel: "email" } } satisfies Entry;
    }
    return { ...base, type: stage, payload: { kind: inviteKind(), channel: "email" } } satisfies Entry;
  });
}
