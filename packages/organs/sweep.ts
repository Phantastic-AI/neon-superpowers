// sweep — the later read: the morning organ (event-onboarding.md organ
// table: "read RSVPs, new guests, replies, event changes").
//
// The law of this organ: the page is diffed against the vault's CURRENT
// DERIVED state — deriveRoom over loadWorld(vault), the same fold every
// surface reads — NEVER against a stored copy of the page. There is no
// stored copy; the stream is the only memory. Consequences, all structural:
//
//   - idempotence: appends move the derived state to the page state, so
//     sweeping the same page twice finds an empty diff the second time;
//   - nothing rewrites: a change is a NEW interaction entry whose
//     payload.response the fold lets win (room.ts rule 3) — the imported
//     base entry stands forever underneath it;
//   - identity is the platform's guest id, filed as payload.guest on the
//     imported entry at first sight — never the display name (the
//     same-name trap: a stranger must not land on a friend by name alone).
//
// Plan-then-append (append.ts's validate-then-commit shape, at organ
// scale): the WHOLE diff is computed and checked before the first append,
// so a rejected sweep leaves the vault untouched.
//
// What a v0 sweep refuses loudly rather than guesses (README "What v0 is
// not"): a known guest reverting to added-not-invited (platforms don't
// un-invite; that page is wrong or the world model is), and a bare
// uninvited -> no-reply flip (an invite landed outside the spine — v0 has
// no honest entry for an unwitnessed send; "no-reply" is not a reply).

import type { RsvpStatus } from "../../tools/projections/types.js";
import { deriveRoom } from "../../tools/projections/room.js";
import type { Vault } from "../vault/store.js";
import { appendEntry } from "../vault/append.js";
import { loadWorld } from "../vault/world.js";
import { loadGuests, PAGE_CONTRACTS, type PageGuest, type Platform } from "./read-page.js";
import { APP_REF, importGuest, type EventIds } from "./connect.js";

export interface SweepOptions {
  /** ISO timestamp for the appended entries; default: now. */
  at?: string;
  /** Which PAGE_CONTRACTS entry reads the page; default "partiful" (v0's first platform). */
  platform?: Platform;
}

export interface RsvpChange {
  guestId: string;
  personId: string;
  name: string;
  from: RsvpStatus;
  to: RsvpStatus;
}

export interface SweepReport {
  /** New page rows imported (persons registered = imports appended). */
  newGuests: number;
  /** Known guests whose page state moved (interaction entries appended). */
  rsvpChanges: number;
  /** Total entries appended = newGuests + rsvpChanges. */
  appended: number;
  changes: RsvpChange[];
}

/** Responses a page can honestly report a guest gave (a reply is one of these). */
const RESPONSES: readonly RsvpStatus[] = ["accepted", "tentative", "declined"];

function refuse(reason: string): never {
  throw new Error(`sweep: ${reason} — sweep refused, vault untouched`);
}

export async function sweepEvent(vault: Vault, fixturePath: string, ids: EventIds, options: SweepOptions = {}): Promise<SweepReport> {
  const at = options.at ?? new Date().toISOString();
  const platform = options.platform ?? "partiful";
  const contract = PAGE_CONTRACTS[platform];
  const context = vault.contextById.get(ids.contextId);
  if (context === undefined) refuse(`unknown context "${ids.contextId}" — connect the event first`);
  if (!vault.gatheringById.has(ids.gatheringId)) refuse(`unknown gathering "${ids.gatheringId}" — connect the event first`);
  // The context remembers which platform connected it (profile, filed at
  // connect); sweeping it through a different platform's contract is a
  // category error, refused before the page is even read.
  if (context.profile !== undefined && context.profile !== platform)
    refuse(`context "${ids.contextId}" was connected as ${context.profile}, not ${platform}`);

  const page = await loadGuests(fixturePath, platform);

  // The vault's CURRENT derived state — the same Room every surface reads.
  const room = deriveRoom(loadWorld(vault), ids.gatheringId);
  const derivedRsvp = new Map<string, RsvpStatus>(room.guests.map((g) => [g.person, g.rsvp]));

  // The join key: platform guest id -> person id, off the imported entries'
  // own payload.guest (filed at first sight; provenance-born identity).
  const personByGuestId = new Map<string, string>();
  for (const e of vault.entries) {
    if (e.context !== ids.contextId || e.type !== "imported" || e.subtype !== "guest") continue;
    const gid = (e.payload as Record<string, unknown>).guest;
    const pid = (e.persons ?? [])[0];
    if (typeof gid === "string" && typeof pid === "string" && !personByGuestId.has(gid)) personByGuestId.set(gid, pid);
  }

  // ------------------------------------------------------------------
  // Plan the whole diff first. Nothing appends until every row is judged.
  // ------------------------------------------------------------------
  const newGuests: PageGuest[] = [];
  const changes: { guest: PageGuest; personId: string; from: RsvpStatus; to: RsvpStatus }[] = [];
  for (const guest of page.guests) {
    const personId = personByGuestId.get(guest.guestId);
    if (personId === undefined) {
      newGuests.push(guest);
      continue;
    }
    const from = derivedRsvp.get(personId);
    if (from === undefined) refuse(`guest ${guest.guestId} ("${guest.name}") maps to person ${personId} who is missing from the derived Room`);
    const to: RsvpStatus = guest.rsvp ?? "uninvited";
    if (to === from) continue;
    if (to === "uninvited")
      refuse(`guest ${guest.guestId} ("${guest.name}") shows added-not-invited on the page but derives "${from}" in the vault — platforms don't un-invite; v0 won't repair this`);
    if (!RESPONSES.includes(to))
      refuse(
        `guest ${guest.guestId} ("${guest.name}") moved ${from} -> ${to}; only a reply {${RESPONSES.join(", ")}} can move a guest forward in v0 ` +
          `(an ${from} -> ${to} flip means an invite landed outside the spine — no honest entry exists for that yet)`,
      );
    changes.push({ guest, personId, from, to });
  }
  // Page rows absent for a known person append nothing: the vault never
  // erases, and v0 has no removal vocabulary (README "What v0 is not").

  // ------------------------------------------------------------------
  // Append: new guests first (page order), then the responses (page order).
  // Every append is the vault's own validated write path.
  // ------------------------------------------------------------------
  for (const guest of newGuests) importGuest(vault, guest, ids, contract.sources.sweep, at);
  const reported: RsvpChange[] = [];
  for (const { guest, personId, from, to } of changes) {
    appendEntry(vault, {
      at,
      context: ids.contextId,
      type: "interaction",
      actor: { kind: "app", ref: APP_REF },
      persons: [personId],
      about: ids.gatheringId,
      // The seed stream's own response shape (e.g. e-000613): the fold's
      // rule 3 lets the latest payload.response win. payload.via is sweep
      // provenance (payload is subtype-owned; the validator stays sealed).
      payload: { response: to, via: contract.sources.via },
    });
    reported.push({ guestId: guest.guestId, personId, name: guest.name, from, to });
  }

  return {
    newGuests: newGuests.length,
    rsvpChanges: reported.length,
    appended: newGuests.length + reported.length,
    changes: reported,
  };
}
