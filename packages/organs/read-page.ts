// read-page — the organ that turns an event page into a guest roster.
//
// v0 drives playwright-core (channel "chrome", headless) over a file:// URL
// to a platform-SHAPED static fixture (fixtures/). No sessions, no live
// platform, no navigation beyond the one page handed in.
//
// Reject-don't-repair at the page edge: a row missing its guest id or name,
// a duplicate guest id, or an rsvp word outside the contract's vocabulary
// throws loudly with the row's identity — nothing is guessed, skipped, or
// repaired, and (because the reader touches no vault) nothing is appended.

import { chromium } from "playwright-core";
import { pathToFileURL } from "node:url";
import type { AnchorKind } from "../../tools/seed-world/types.js";
import type { RsvpStatus } from "../../tools/projections/types.js";

// ---------------------------------------------------------------------------
// THE EXTRACTION CONTRACTS — one exported object per platform, and nothing
// else. Every platform has the SAME shape (PlatformContract): what varies
// between Partiful and Luma is DATA in the object, never code around it.
//
// Everything the organs know about a platform — selectors, attribute names,
// status vocabulary, the context anchor kind the platform is anchored on,
// and the provenance words its reads file — lives HERE. A real adapter
// later (CP2, with the operator's session) replaces exactly one entry of
// this table — selectors for the real markup, status words for the real
// badge vocabulary — and read-page.ts, connect.ts, sweep.ts, and check.ts
// change NOT AT ALL. Keep it that way: if a change elsewhere is needed to
// point these organs at a real platform, the contract has leaked and the
// design is broken.
// ---------------------------------------------------------------------------
export interface PlatformContract {
  /** The context anchor kind this platform is anchored on (connect declares it). */
  contextAnchor: AnchorKind;
  /** Provenance words the organs file on this platform's appended entries. */
  sources: { connect: string; sweep: string; via: string };
  /** The event root element and its attributes. */
  event: { root: string; title: string; date: string };
  /** One guest row. */
  guestRow: string;
  /** Attribute on the row: the platform's own stable guest id (the join key). */
  guestId: string;
  /** Element inside the row carrying the display name. */
  guestName: string;
  /** Attribute on the row: the platform's rsvp state word. */
  rsvpStatus: string;
  /** Attributes on the row: anchor hints the page exposes, per kind. */
  anchors: Record<AnchorKind, string>;
  /**
   * Platform status word -> the vault's own rsvp word (§10.1, one word per
   * state). null means "on the list but no invite sent yet": the import
   * entry carries NO payload.rsvp, which is exactly how the Room fold
   * derives `uninvited`. A page word outside this table is a loud reject.
   */
  statusWords: Record<string, RsvpStatus | null>;
}

export const PAGE_CONTRACTS: Record<"partiful" | "luma", PlatformContract> = {
  // Partiful: attribute-driven rows, SHOUTED status words, phone-anchored.
  partiful: {
    contextAnchor: "phone",
    sources: { connect: "partiful-import-connect", sweep: "partiful-import-sweep", via: "partiful-sweep" },
    event: { root: "[data-event]", title: "data-event-title", date: "data-event-date" },
    guestRow: "[data-guest]",
    guestId: "data-guest-id",
    guestName: "[data-guest-name]",
    rsvpStatus: "data-rsvp-status",
    anchors: { email: "data-email", phone: "data-phone", linkedin: "data-linkedin" },
    statusWords: {
      GOING: "accepted",
      MAYBE: "tentative",
      CANT_GO: "declined",
      INVITED: "no-reply",
      ADDED: null,
    },
  },
  // Luma: class-driven rows, lowercase approval words ("Going / Not Going /
  // Invited" idiom), email-anchored — deliberately a different page shape,
  // so the per-platform contract is actually exercised, not decorative.
  luma: {
    contextAnchor: "email",
    sources: { connect: "luma-import-connect", sweep: "luma-import-sweep", via: "luma-sweep" },
    event: { root: "[data-lu-event]", title: "data-lu-title", date: "data-lu-starts-at" },
    guestRow: ".lu-attendee",
    guestId: "data-attendee-key",
    guestName: ".lu-attendee-name",
    rsvpStatus: "data-approval-status",
    anchors: { email: "data-contact-email", phone: "data-contact-phone", linkedin: "data-profile-linkedin" },
    statusWords: {
      approved: "accepted",
      maybe: "tentative",
      declined: "declined",
      invited: "no-reply",
      not_yet_invited: null,
    },
  },
};

/** A platform the organs hold a contract for. */
export type Platform = keyof typeof PAGE_CONTRACTS;

/** One guest as read off the page (platform identity + vault-vocabulary rsvp). */
export interface PageGuest {
  /** The platform's stable guest id — the organs' ONLY join key (never the name). */
  guestId: string;
  name: string;
  /** Vault rsvp word, or null = added-but-not-invited (no rsvp on the import). */
  rsvp: RsvpStatus | null;
  /** Anchor hints present on the row, by kind. */
  anchors: Partial<Record<AnchorKind, string>>;
  /** 1-based position on the page — import provenance only, never identity. */
  row: number;
}

export interface PageEvent {
  title: string;
  /** ISO date the page declares for the event. */
  date: string;
  guests: PageGuest[];
}

/** What page.$$eval hands back before vocabulary mapping (raw page words). */
interface RawRow {
  guestId: string | null;
  name: string | null;
  status: string | null;
  anchors: Partial<Record<AnchorKind, string>>;
}

function fail(reason: string): never {
  throw new Error(`read-page: ${reason}`);
}

/**
 * Extract the roster from an ALREADY-OPEN page through a platform contract.
 * This is the shared organ core: the fixture path (loadGuests) and the live
 * session path (the diver, CP2) both end here, so extraction + loud rejection
 * are ONE definition. `where` names the page for error messages.
 */
export async function extractGuests(
  page: import("playwright-core").Page,
  contract: PlatformContract,
  where: string,
): Promise<PageEvent> {
  const root = await page.$(contract.event.root);
  if (!root) fail(`no event root matching "${contract.event.root}" on ${where}`);
  const title = await root.getAttribute(contract.event.title);
  const date = await root.getAttribute(contract.event.date);
  if (typeof title !== "string" || title.length === 0) fail(`event root carries no ${contract.event.title}`);
  if (typeof date !== "string" || Number.isNaN(Date.parse(date))) fail(`event root carries no ISO ${contract.event.date}`);

  // One DOM pass, contract passed in (it is plain serializable data).
  const raw: RawRow[] = await page.$$eval(
    contract.guestRow,
    (rows, c) =>
      rows.map((row) => {
        const anchors: Record<string, string> = {};
        for (const [kind, attr] of Object.entries(c.anchors)) {
          const v = row.getAttribute(attr);
          if (v !== null && v.length > 0) anchors[kind] = v;
        }
        return {
          guestId: row.getAttribute(c.guestId),
          name: row.querySelector(c.guestName)?.textContent?.trim() ?? null,
          status: row.getAttribute(c.rsvpStatus),
          anchors,
        };
      }),
    contract,
  );

  // Vocabulary mapping + loud rejection, outside the browser.
  const guests: PageGuest[] = [];
  const seen = new Set<string>();
  raw.forEach((r, i) => {
    const at = `row ${i + 1} of ${where}`;
    if (r.guestId === null || r.guestId.length === 0) fail(`${at}: missing ${contract.guestId}`);
    if (seen.has(r.guestId)) fail(`${at}: duplicate guest id "${r.guestId}"`);
    seen.add(r.guestId);
    if (r.name === null || r.name.length === 0) fail(`${at} (guest ${r.guestId}): missing name (${contract.guestName})`);
    if (r.status === null || !(r.status in contract.statusWords))
      fail(
        `${at} (guest ${r.guestId} "${r.name}"): unknown rsvp status "${String(r.status)}" — ` +
          `page words are {${Object.keys(contract.statusWords).join(", ")}}`,
      );
    guests.push({ guestId: r.guestId, name: r.name, rsvp: contract.statusWords[r.status], anchors: r.anchors, row: i + 1 });
  });
  if (guests.length === 0) fail(`no guest rows matching "${contract.guestRow}" on ${where}`);

  return { title, date, guests };
}

/**
 * Load the guest roster from an event page, through the named platform's
 * contract. v0: `fixturePath` is a local platform-shaped HTML file; the live
 * path (the diver) opens the operator's session and calls extractGuests on
 * the same contract.
 */
export async function loadGuests(fixturePath: string, platform: Platform): Promise<PageEvent> {
  const contract = PAGE_CONTRACTS[platform];
  if (contract === undefined) fail(`unknown platform "${String(platform)}" — contracts exist for {${Object.keys(PAGE_CONTRACTS).join(", ")}}`);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(fixturePath).href);
    return await extractGuests(page, contract, fixturePath);
  } finally {
    await browser.close();
  }
}
