// connect — the first read: an event page becomes a vault context.
//
// connectEvent mirrors, entry for entry, the connect moment the sealed seed
// stream itself evidences at the top of the fogline context (e-000422..):
//
//   1. registerContext + registerGathering       (primary records, store.ts)
//   2. context/created                            appendEntry
//   3. anchor/declared                            appendEntry — the CONTEXT's
//      anchor, the platform contract's own kind (Partiful is phone-anchored,
//      Luma email-anchored); per-person anchors live on the Person records,
//      where the Room's coverage figures read them (§7.2)
//   4. granted/appscope — THE EVENT-CONNECTED ENTRY. There is no "connected"
//      word in the sealed ENTRY_TYPES set; the moment an event is connected
//      IS the operator granting the event app scope over the new context,
//      and that is exactly the entry the seed world appends here (e-000424).
//   5. one imported/guest entry per page row, source = the platform
//      contract's connect provenance word (e.g. "partiful-import-connect",
//      the seed's own pattern), payload.rsvp = the page state — ABSENT for
//      added-but-not-invited rows, which is how the Room fold derives
//      `uninvited`.
//
// Every append goes through the vault's own validator (append.ts); connect
// invents no write path and no vocabulary. Connect is a birth, not a merge:
// a context id that already exists in the vault is refused (registerContext
// throws), the same law as import-seed.

import type { Anchor, AnchorKind } from "../../tools/seed-world/types.js";
import { registerContext, registerGathering, registerPerson, type Vault } from "../vault/store.js";
import { appendEntry } from "../vault/append.js";
import { loadGuests, PAGE_CONTRACTS, type PageEvent, type PageGuest, type Platform } from "./read-page.js";

/** The event app's honest actor ref — the seed world's own word. */
export const APP_REF = "app-event";

export interface EventIds {
  contextId: string;
  gatheringId: string;
}

export interface ConnectOptions {
  /** ISO timestamp for the appended entries; default: now. */
  at?: string;
  /** The operator's actor ref for the human-actor entries; default "operator". */
  operator?: string;
  /** Context display name; default: the page's event title. */
  contextName?: string;
  /** Which PAGE_CONTRACTS entry reads the page; default "partiful" (v0's first platform). */
  platform?: Platform;
  /** Product opening lane; maps to the vault's existing Context kind vocabulary. */
  lane?: "topical" | "social";
  /** Public browser provenance, stripped of query and fragment before this boundary. */
  sourceUrl?: string;
}

export interface ConnectReport {
  title: string;
  /** Guests imported (= page rows = persons registered). */
  guests: number;
  /** Entries appended (3 connect-moment entries + one import per guest). */
  entries: number;
}

/** Mint the next person id in the vault (p-%06d over existing p-N ids). */
export function mintPersonId(vault: Vault): string {
  let max = 0;
  for (const p of vault.persons) {
    const m = /^p-(\d+)$/.exec(p.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `p-${String(max + 1).padStart(6, "0")}`;
}

/**
 * Register one page guest as a Person and append their imported/guest entry.
 * Shared by connect (first read) and sweep (new guests later) so both reads
 * land the identical shape. The page's anchor hints become Person anchors in
 * this context with verified: false — an import is a sighting, not a
 * verification (verified anchor or no merge; nothing here merges).
 * payload.guest carries the platform's stable guest id: the ONLY join key a
 * later sweep uses to recognize the row again — never the name (the
 * same-name trap).
 */
export function importGuest(vault: Vault, guest: PageGuest, ids: EventIds, source: string, at: string): string {
  const personId = mintPersonId(vault);
  const anchors: Anchor[] = (Object.entries(guest.anchors) as [AnchorKind, string][]).map(([kind, value]) => ({
    kind,
    value,
    verified: false,
    context: ids.contextId,
  }));
  registerPerson(vault, {
    id: personId,
    name: guest.name,
    anchors,
    merged: [],
    sighted_at: at,
    state: "active",
  });
  appendEntry(vault, {
    at,
    context: ids.contextId,
    type: "imported",
    subtype: "guest",
    actor: { kind: "app", ref: APP_REF },
    persons: [personId],
    about: ids.gatheringId,
    source,
    payload: {
      row: guest.row,
      guest: guest.guestId,
      ...(guest.rsvp === null ? {} : { rsvp: guest.rsvp }),
    },
  });
  return personId;
}

export function connectPageEvent(
  vault: Vault,
  page: PageEvent,
  ids: EventIds,
  options: ConnectOptions = {},
): ConnectReport {
  const at = options.at ?? new Date().toISOString();
  const operator = options.operator ?? "operator";
  const platform = options.platform ?? "partiful";
  const contract = PAGE_CONTRACTS[platform];
  const human = { kind: "human" as const, ref: operator };
  const contextName = options.contextName ?? page.title;

  // 1. Primary records. Platform defaults come from the contract: a context
  // anchored on the platform's own anchor kind (Partiful is
  // phone-anchored, Luma email-anchored — the seed world's own words), with
  // the platform filed as the context's profile (D-018, exactly as the seed
  // contexts carry profile: "partiful" / "luma"); the gathering is the
  // page's own title and date, upcoming (you connect events that are still
  // ahead of you — v1 scope, event-onboarding.md).
  registerContext(vault, {
    id: ids.contextId,
    name: contextName,
    kind: options.lane === "topical" ? "professional" : "social",
    anchor: contract.contextAnchor,
    profile: platform,
    created_at: at,
  });
  registerGathering(vault, {
    id: ids.gatheringId,
    context: ids.contextId,
    name: page.title,
    date: page.date,
    upcoming: true,
  });

  // 2-4. The connect moment, exactly as the seed stream evidences it.
  appendEntry(vault, {
    at,
    context: ids.contextId,
    type: "context",
    subtype: "created",
    actor: human,
    payload: {
      name: contextName,
      ...(options.lane ? { lane: options.lane } : {}),
      ...(options.sourceUrl ? { sourceUrl: options.sourceUrl, platform } : {}),
    },
  });
  appendEntry(vault, { at, context: ids.contextId, type: "anchor", subtype: "declared", actor: human, payload: { anchor: contract.contextAnchor } });
  appendEntry(vault, {
    at,
    context: ids.contextId,
    type: "granted",
    subtype: "appscope",
    actor: human,
    grant: `grant-appscope-${ids.contextId}`,
    payload: { app: APP_REF, kind: "appscope" },
  });

  // 5. One import per page row, in page order, with the platform's own
  // provenance word (the seed stream's pattern: partiful-* / luma-*).
  for (const guest of page.guests) importGuest(vault, guest, ids, contract.sources.connect, at);

  return { title: page.title, guests: page.guests.length, entries: 3 + page.guests.length };
}

export async function connectEvent(vault: Vault, fixturePath: string, ids: EventIds, options: ConnectOptions = {}): Promise<ConnectReport> {
  const platform = options.platform ?? "partiful";
  return connectPageEvent(vault, await loadGuests(fixturePath, platform), ids, options);
}
