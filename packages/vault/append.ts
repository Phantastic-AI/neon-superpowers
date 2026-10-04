// appendEntry — the vault's ONE write path, validation-first.
//
// Reject-don't-repair: an invalid append throws with a specific reason and
// the vault is untouched (all validation happens before the single
// appendFileSync in store.ts, so a throw can never leave a partial line).
//
// The rules are the seed world's OWN vocabulary and evidence, D-026's law
// ("every type has a structured schema validated at append time"):
//   - type must be one of ENTRY_TYPES (the sealed set, seed-world/types.ts);
//   - required fields per type are what the sealed 964-entry stream itself
//     evidences (counts cited inline; thin-evidence types are named in the
//     README "Ambiguities" section, validated per their exemplars);
//   - context must exist in the vault's registry;
//   - persons must exist in the vault's registry;
//   - about must name a registered gathering (every `about` in the seed
//     stream is a gathering id);
//   - refs / supersedes must point at existing entry ids — already appended,
//     therefore cursor <= the new entry's cursor. Visibility is append
//     order (memory-design "Time is a cursor"): nothing may reference a
//     line the stream has not yet seen;
//   - confidence/epistemics are fact-only (D-041; types.ts: "Fact entries
//     only") — required on every fact, rejected anywhere else.

import { ENTRY_TYPES } from "../../tools/seed-world/types.js";
import type { Entry, EntryType } from "../../tools/seed-world/types.js";
import { ANCHOR_KINDS, commitValidated, type Vault } from "./store.js";
import { validatePeopleProspectEntry } from "./people-prospect-validation.js";
import { validateSecretaryClaimEntry } from "./secretary-validation.js";

const ACTOR_KINDS = ["app", "lois", "human"] as const;
const CONFIDENCES = ["open", "chatham", "confided"] as const;
const EPISTEMICS = ["stated", "inferred"] as const;

/** What a caller hands appendEntry: an Entry whose id/cursor the vault may assign. */
export type NewEntry = Omit<Entry, "id" | "cursor"> & { id?: string; cursor?: number };

function reject(reason: string): never {
  throw new Error(`appendEntry: ${reason}`);
}

const payloadOf = (e: NewEntry): Record<string, unknown> => e.payload as Record<string, unknown>;
const hasPersons = (e: NewEntry): boolean => Array.isArray(e.persons) && e.persons.length >= 1;

/** These four organizer subtypes extend Interaction, not the sealed type set. */
function validatePeopleInteraction(e: NewEntry): void {
  if (!["people-order", "people-note", "people-notes-submitted", "people-notes-finished"].includes(e.subtype ?? "")) return;
  const p = payloadOf(e);
  const text = (value: unknown, key: string): void => {
    if (typeof value !== "string" || !value.trim()) reject(`${e.subtype} requires ${key} (non-empty string)`);
  };
  const revision = (value: unknown, key: string): void => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) reject(`${e.subtype} requires ${key} (non-negative integer)`);
  };
  const ids = (value: unknown, key: string): string[] => {
    if (!Array.isArray(value) || !value.length) reject(`${e.subtype} requires non-empty ${key}`);
    for (const id of value) text(id, key);
    if (new Set(value).size !== value.length) reject(`${e.subtype} requires unique ${key}`);
    return value as string[];
  };
  text(p.viewId, "viewId"); text(p.requestId, "requestId");
  if (e.subtype === "people-order" || e.subtype === "people-note") {
    revision(p.baseRevision, "baseRevision"); revision(p.revision, "revision");
    if (p.revision !== (p.baseRevision as number) + 1) reject(`${e.subtype} revision must follow baseRevision`);
  }
  if (e.subtype === "people-order") {
    const order = ids(p.personIds, "personIds");
    if (order.length !== e.persons!.length || order.some((id, i) => id !== e.persons![i])) reject("people-order persons must match personIds");
  } else if (e.subtype === "people-note") {
    text(p.noteId, "noteId"); text(p.personId, "personId"); text(p.text, "text");
    if (e.persons!.length !== 1 || e.persons![0] !== p.personId) reject("people-note persons must match personId");
    if (!["draft", "submitted", "resolved", "hidden"].includes(p.state as string)) reject("people-note requires a valid state");
    if (p.replyTo !== undefined) text(p.replyTo, "replyTo");
    if (p.waveId !== undefined) {
      text(p.waveId, "waveId");
      if (!p.replyTo || !e.refs?.includes(p.waveId as string)) reject("people-note wave reply must reference its submitted wave");
    }
  } else if (e.subtype === "people-notes-submitted") {
    const noteIds = ids(p.noteIds, "noteIds");
    revision(p.orderRevision, "orderRevision");
    if (p.baseRevision !== undefined) revision(p.baseRevision, "baseRevision");
    if (!Array.isArray(p.notes) || p.notes.length !== noteIds.length) reject("people-notes-submitted requires one snapshot per noteId");
    const persons = new Set<string>();
    for (let index = 0; index < p.notes.length; index++) {
      const note = p.notes[index] as Record<string, unknown>;
      if (!note || typeof note !== "object") reject("people-notes-submitted requires note objects");
      if (note.noteId !== noteIds[index]) reject("people-notes-submitted snapshots must match noteIds");
      text(note.personId, "notes.personId"); text(note.text, "notes.text"); text(note.entryId, "notes.entryId");
      revision(note.revision, "notes.revision");
      if (note.state !== "draft") reject("people-notes-submitted snapshots must be drafts");
      if (!e.refs?.includes(note.entryId as string)) reject("people-notes-submitted must reference each saved draft");
      persons.add(note.personId as string);
    }
    if (persons.size !== e.persons!.length || e.persons!.some((id) => !persons.has(id))) reject("people-notes-submitted persons must match note snapshots");
  } else {
    text(p.waveId, "waveId"); revision(p.revision, "revision");
    if (p.status !== "completed" && p.status !== "failed") reject("people-notes-finished requires completed or failed status");
    if (!e.refs?.includes(p.waveId as string)) reject("people-notes-finished must reference its submitted wave");
  }
}

/**
 * Per-type required fields, exactly as evidenced by the sealed seed stream
 * (964 entries; evidence counts in comments). Each rule throws with the
 * missing requirement; none repairs.
 */
const TYPE_RULES: Record<EntryType, (e: NewEntry) => void> = {
  // 4/4: subtype "created", payload.name
  context: (e) => {
    if (e.subtype !== "created") reject(`type=context requires subtype "created" (got "${e.subtype}")`);
    if (typeof payloadOf(e).name !== "string") reject("type=context requires payload.name (string)");
  },
  // 4/4: subtype "declared", payload.anchor is an anchor kind
  anchor: (e) => {
    if (e.subtype !== "declared") reject(`type=anchor requires subtype "declared" (got "${e.subtype}")`);
    const a = payloadOf(e).anchor;
    if (typeof a !== "string" || !(ANCHOR_KINDS as readonly string[]).includes(a))
      reject(`type=anchor requires payload.anchor in {${ANCHOR_KINDS.join(", ")}} (got "${String(a)}")`);
  },
  // 1/1 (thin evidence — README): payload.public
  consented: (e) => {
    if (payloadOf(e).public === undefined) reject("type=consented requires payload.public");
  },
  // 5/5: subtype names the Grant kind; grant id present. Payload per
  // subtype as evidenced: appscope(3) payload.app; supervision(1)
  // payload.grantee + payload.window; disclosure(1) payload.widens.
  granted: (e) => {
    if (e.subtype !== "appscope" && e.subtype !== "supervision" && e.subtype !== "disclosure")
      reject(`type=granted requires subtype in {appscope, supervision, disclosure} (got "${e.subtype}")`);
    if (typeof e.grant !== "string" || e.grant.length === 0) reject("type=granted requires grant (the Grant id)");
    const p = payloadOf(e);
    if (e.subtype === "appscope" && typeof p.app !== "string") reject("type=granted subtype=appscope requires payload.app");
    if (e.subtype === "supervision" && (typeof p.grantee !== "string" || p.window === undefined))
      reject("type=granted subtype=supervision requires payload.grantee and payload.window");
    if (e.subtype === "disclosure" && typeof p.widens !== "string") reject("type=granted subtype=disclosure requires payload.widens");
  },
  // 156/156: subtype "guest", persons (all exactly 1 — README ambiguity:
  // validator requires >=1), about (a gathering), source (import provenance)
  imported: (e) => {
    if (e.subtype !== "guest") reject(`type=imported requires subtype "guest" (got "${e.subtype}")`);
    if (!hasPersons(e)) reject("type=imported requires persons (>=1: the guest(s) imported)");
    if (e.about === undefined) reject("type=imported requires about (the gathering the row concerns)");
    if (typeof e.source !== "string" || e.source.length === 0) reject("type=imported requires source (import provenance)");
  },
  // 281/281: subtype in {attendance, lookup, sighting}; persons >=1;
  // confidence+epistemics (D-041, checked below for all facts);
  // attendance(66/66) additionally carries about.
  fact: (e) => {
    if (e.subtype !== "attendance" && e.subtype !== "lookup" && e.subtype !== "sighting")
      reject(`type=fact requires subtype in {attendance, lookup, sighting} (got "${e.subtype}")`);
    if (!hasPersons(e)) reject("type=fact requires persons (>=1: who the fact is about)");
    if (e.subtype === "attendance" && e.about === undefined) reject("type=fact subtype=attendance requires about (which gathering was attended)");
  },
  // 72/72: persons present — all exactly 1 in the sealed stream, though
  // types.ts says "interactions need >=2" (contradiction filed in README
  // "Ambiguities"; the validator follows the evidence: >=1)
  interaction: (e) => {
    if (!hasPersons(e)) reject("type=interaction requires persons (>=1)");
    validatePeopleInteraction(e);
  },
  // 38/38: persons >=1; payload.how in {anchor, operator} (types.ts
  // MergeRecord vocabulary; sealed stream evidences "anchor" only);
  // payload.anchor names the corroborating anchor (C16's law)
  merged: (e) => {
    if (!hasPersons(e)) reject("type=merged requires persons (>=1: the surviving Person)");
    const p = payloadOf(e);
    if (p.how !== "anchor" && p.how !== "operator") reject(`type=merged requires payload.how in {anchor, operator} (got "${String(p.how)}")`);
    if (p.anchor === undefined) reject("type=merged requires payload.anchor (the corroborating anchor — verified anchor or no merge)");
  },
  // 105/105: persons >=1 (about present only on event drafts — optional)
  proposed: (e) => {
    if (!hasPersons(e)) reject("type=proposed requires persons (>=1: the addressee)");
  },
  // 95/95: subtype in {plan, draft}; draft(93/93) requires persons;
  // plan(2/2) requires about (a plan is about a gathering, not a person)
  approved: (e) => {
    if (e.subtype !== "plan" && e.subtype !== "draft") reject(`type=approved requires subtype in {plan, draft} (got "${e.subtype}")`);
    if (e.subtype === "draft" && !hasPersons(e)) reject("type=approved subtype=draft requires persons (>=1: the addressee)");
    if (e.subtype === "plan" && e.about === undefined) reject("type=approved subtype=plan requires about (the gathering the plan concerns)");
  },
  // 93/93: persons >=1
  released: (e) => {
    if (!hasPersons(e)) reject("type=released requires persons (>=1: the addressee)");
  },
  // 93/93: persons >=1
  landed: (e) => {
    if (!hasPersons(e)) reject("type=landed requires persons (>=1: the addressee)");
  },
  // 1/1 (thin evidence — README): subtype "session"
  healed: (e) => {
    if (e.subtype !== "session") reject(`type=healed requires subtype "session" (got "${e.subtype}")`);
  },
  // 2/2 (thin evidence — README): about (the listed gathering), payload.gathering
  listing: (e) => {
    if (e.about === undefined) reject("type=listing requires about (the gathering listed)");
    if (typeof payloadOf(e).gathering !== "string") reject("type=listing requires payload.gathering");
  },
  // 12/12: persons >=1; about; payload.listing
  follow: (e) => {
    if (!hasPersons(e)) reject("type=follow requires persons (>=1: who followed)");
    if (e.about === undefined) reject("type=follow requires about (the gathering followed)");
    if (typeof payloadOf(e).listing !== "string") reject("type=follow requires payload.listing");
  },
  // 2/2 (thin evidence — README): subtype in {joined, ended}; grant (the
  // supervision Grant the session runs under — "visible and logged")
  session: (e) => {
    if (e.subtype !== "joined" && e.subtype !== "ended") reject(`type=session requires subtype in {joined, ended} (got "${e.subtype}")`);
    if (typeof e.grant !== "string" || e.grant.length === 0) reject("type=session requires grant (the supervision Grant id)");
  },
};

/**
 * Validate and append one Entry. Returns the entry with its assigned
 * cursor (= current stream length; line order IS the cursor, "Time is a
 * cursor"). A caller-supplied id is preserved (replay fidelity) but must
 * be unique; a caller-supplied cursor must equal the assigned one — the
 * vault assigns positions, it never renumbers (reject-don't-repair). When
 * id is absent the vault assigns the seed world's own convention,
 * e-%06d = cursor + 1.
 */
export function appendEntry(vault: Vault, entry: NewEntry): Entry {
  // --- base shape ---
  if (typeof entry !== "object" || entry === null) reject("entry must be an object");
  if (typeof entry.at !== "string" || Number.isNaN(Date.parse(entry.at))) reject(`entry.at must be an ISO timestamp (got ${JSON.stringify(entry.at)})`);
  if (!(ENTRY_TYPES as readonly string[]).includes(entry.type)) reject(`unknown entry type "${String(entry.type)}" — not in the sealed ENTRY_TYPES set`);
  if (typeof entry.actor !== "object" || entry.actor === null) reject("entry.actor is required");
  if (!(ACTOR_KINDS as readonly string[]).includes(entry.actor.kind)) reject(`unknown actor kind "${String(entry.actor.kind)}" (honest actor for every append)`);
  if (typeof entry.actor.ref !== "string" || entry.actor.ref.length === 0) reject("entry.actor.ref must be a non-empty string");
  if (typeof entry.payload !== "object" || entry.payload === null || Array.isArray(entry.payload)) reject("entry.payload must be an object (964/964 evidenced)");

  // --- cursor and id: the vault assigns; a supplied cursor must agree ---
  const cursor = vault.entries.length;
  if (entry.cursor !== undefined && entry.cursor !== cursor)
    reject(`cursor mismatch: entry carries cursor ${entry.cursor} but the stream assigns ${cursor} — the vault never renumbers`);
  const id = entry.id ?? `e-${String(cursor + 1).padStart(6, "0")}`;
  if (typeof id !== "string" || id.length === 0) reject("entry.id must be a non-empty string when supplied");
  if (vault.entryById.has(id)) reject(`duplicate entry id ${id}`);

  // --- boundary: exactly one context, and it must exist ---
  if (typeof entry.context !== "string" || entry.context.length === 0) reject("entry.context is required — every Entry files under exactly one Context");
  if (!vault.contextById.has(entry.context)) reject(`unknown context "${entry.context}" — register the Context before filing entries under it`);

  // --- persons must exist in the registry ---
  if (entry.persons !== undefined) {
    if (!Array.isArray(entry.persons)) reject("entry.persons must be an array of person ids");
    for (const p of entry.persons) {
      if (!vault.personById.has(p)) reject(`unknown person "${p}" — register the Person before naming them in an entry`);
    }
  }

  // --- about must name a registered gathering ---
  if (entry.about !== undefined && !vault.gatheringById.has(entry.about))
    reject(`unknown gathering "${entry.about}" in about — register the Gathering first`);

  // --- refs / supersedes: existing entry ids only (already appended => cursor <= this one) ---
  if (entry.refs !== undefined) {
    if (!Array.isArray(entry.refs)) reject("entry.refs must be an array of entry ids");
    for (const r of entry.refs) {
      if (!vault.entryById.has(r)) reject(`dangling ref "${r}" — refs must point at entries already in the stream (visibility is append order)`);
    }
  }
  if (entry.supersedes !== undefined && !vault.entryById.has(entry.supersedes))
    reject(`dangling supersedes "${entry.supersedes}" — the replaced entry must already be in the stream`);

  // --- confidence / epistemics: fact entries only (D-041) ---
  if (entry.type === "fact") {
    if (entry.confidence === undefined || !(CONFIDENCES as readonly string[]).includes(entry.confidence))
      reject(`type=fact requires confidence in {${CONFIDENCES.join(", ")}} (D-041; got "${String(entry.confidence)}")`);
    if (entry.epistemics === undefined || !(EPISTEMICS as readonly string[]).includes(entry.epistemics))
      reject(`type=fact requires epistemics in {${EPISTEMICS.join(", ")}} (D-041; got "${String(entry.epistemics)}")`);
  } else {
    if (entry.confidence !== undefined) reject(`confidence is fact-only (D-041) — not allowed on type=${entry.type}`);
    if (entry.epistemics !== undefined) reject(`epistemics is fact-only (D-041) — not allowed on type=${entry.type}`);
  }

  // --- per-type required fields, as evidenced ---
  TYPE_RULES[entry.type](entry);
  validatePeopleProspectEntry(vault, entry);
  validateSecretaryClaimEntry(vault, entry);

  // --- commit: preserve a replayed line's exact object (byte fidelity),
  //     else assemble in the seed world's key order ---
  const full: Entry =
    entry.id !== undefined && entry.cursor !== undefined ? (entry as Entry) : ({ id, cursor, ...entry } as Entry);
  return commitValidated(vault, full);
}
