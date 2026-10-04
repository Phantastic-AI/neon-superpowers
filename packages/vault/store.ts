// Vault store — the on-disk, append-only vault behind the D-042 boundary.
//
// This is the first REAL engine piece: the seed world's `out/` directory,
// grown a write path. The layout is the seed world's own:
//
//   stream.jsonl       — the Stream, one Entry per line, line order = cursor.
//                        APPEND IS THE ONLY WRITE. No line is ever rewritten,
//                        reordered, or removed (Stream is RULED append-only;
//                        corrections are new lines, D-026 supersedes).
//   persons.json       — registry of Person records.
//   contexts.json      — registry of Context records.
//   gatherings.json    — registry of Gathering records.
//
// HONESTY NOTE on the three registries (README "Decisions", D-042 lane):
// the task's ideal is registries as projections of the stream. In the seed
// world they are NOT derivable: Person.anchors / .merged / .state, Context
// kind/anchor/profile/created_at, and Gathering records never appear as
// entry payloads (the system-home context has no `context` entry at all;
// gatherings are only ever *referenced* by `about`). So v0 mirrors the seed
// world's treatment honestly: persons/contexts/gatherings are PRIMARY
// records, written through explicit register* calls, and the registry files
// are maintained registries — rewritten on register, unlike the stream,
// which only ever grows. What could later become stream-derived is named in
// the README (e.g. Person.merged mirrors `merged` entries; a Context could
// be born from its `context`/created entry if the entry carried the full
// record).
//
// Honest v0 limits (named, not hidden — see README): one file, no locks,
// one process at a time, no encryption, no keychain.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Entry, Person, Context, Gathering, AnchorKind } from "../../tools/seed-world/types.js";

export const ANCHOR_KINDS: readonly AnchorKind[] = ["linkedin", "phone", "email"] as const;
const CONTEXT_KINDS = ["professional", "social", "public", "system"] as const;
const PERSON_STATES = ["active", "merged"] as const;

export interface Vault {
  /** The vault directory this handle is bound to. */
  readonly dir: string;
  /** stream.jsonl in cursor order — THE ground truth. entries[i].cursor === i always. */
  readonly entries: Entry[];
  /** id -> Entry, for refs/supersedes validation (append.ts). */
  readonly entryById: Map<string, Entry>;
  /** Primary registries (see honesty note above). */
  readonly persons: Person[];
  readonly personById: Map<string, Person>;
  readonly contexts: Context[];
  readonly contextById: Map<string, Context>;
  readonly gatherings: Gathering[];
  readonly gatheringById: Map<string, Gathering>;
}

const STREAM = "stream.jsonl";
const REGISTRY_FILES = { persons: "persons.json", contexts: "contexts.json", gatherings: "gatherings.json" } as const;

function fail(reason: string): never {
  throw new Error(`vault: ${reason}`);
}

/**
 * Open (or create) a vault at `dir`. A fresh dir gets an empty stream and
 * empty registries — the only moment stream.jsonl is written by anything
 * other than an append is its creation as a zero-byte file. On open, every
 * stream line is checked against its line index: a vault whose entries
 * disagree with their cursor is corrupt, and we refuse it rather than
 * repair it (reject-don't-repair, same law as append).
 */
export function openVault(dir: string): Vault {
  mkdirSync(dir, { recursive: true });
  const streamPath = join(dir, STREAM);
  if (!existsSync(streamPath)) writeFileSync(streamPath, "", "utf8");
  for (const file of Object.values(REGISTRY_FILES)) {
    const p = join(dir, file);
    if (!existsSync(p)) writeFileSync(p, "[]\n", "utf8");
  }

  const entries: Entry[] = readFileSync(streamPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l, i) => {
      let e: Entry;
      try {
        e = JSON.parse(l) as Entry;
      } catch {
        fail(`corrupt vault: stream.jsonl line ${i} is not valid JSON`);
      }
      if (e.cursor !== i) fail(`corrupt vault: stream.jsonl line ${i} carries cursor ${e.cursor} (cursor must equal line index)`);
      return e;
    });
  const entryById = new Map<string, Entry>();
  for (const e of entries) {
    if (entryById.has(e.id)) fail(`corrupt vault: duplicate entry id ${e.id} in stream.jsonl`);
    entryById.set(e.id, e);
  }

  const readRegistry = <T extends { id: string }>(file: string): { list: T[]; byId: Map<string, T> } => {
    const list = JSON.parse(readFileSync(join(dir, file), "utf8")) as T[];
    const byId = new Map<string, T>();
    for (const r of list) {
      if (byId.has(r.id)) fail(`corrupt vault: duplicate id ${r.id} in ${file}`);
      byId.set(r.id, r);
    }
    return { list, byId };
  };
  const persons = readRegistry<Person>(REGISTRY_FILES.persons);
  const contexts = readRegistry<Context>(REGISTRY_FILES.contexts);
  const gatherings = readRegistry<Gathering>(REGISTRY_FILES.gatherings);

  return {
    dir,
    entries,
    entryById,
    persons: persons.list,
    personById: persons.byId,
    contexts: contexts.list,
    contextById: contexts.byId,
    gatherings: gatherings.list,
    gatheringById: gatherings.byId,
  };
}

/** Registry files are registries, not the stream: rewriting them on register is allowed. */
function writeRegistry(vault: Vault, file: string, records: unknown[]): void {
  writeFileSync(join(vault.dir, file), JSON.stringify(records, null, 2) + "\n", "utf8");
}

/** Register a Context (primary record — see honesty note). Rejects duplicates and malformed records. */
export function registerContext(vault: Vault, context: Context): Context {
  if (typeof context.id !== "string" || context.id.length === 0) fail("registerContext: context.id must be a non-empty string");
  if (vault.contextById.has(context.id)) fail(`registerContext: duplicate context id ${context.id}`);
  if (typeof context.name !== "string" || context.name.length === 0) fail(`registerContext: context ${context.id} needs a name`);
  if (!CONTEXT_KINDS.includes(context.kind)) fail(`registerContext: context ${context.id} has unknown kind "${context.kind}"`);
  if (!ANCHOR_KINDS.includes(context.anchor)) fail(`registerContext: context ${context.id} has unknown anchor "${context.anchor}"`);
  if (typeof context.created_at !== "string" || Number.isNaN(Date.parse(context.created_at)))
    fail(`registerContext: context ${context.id} needs an ISO created_at`);
  vault.contexts.push(context);
  vault.contextById.set(context.id, context);
  writeRegistry(vault, REGISTRY_FILES.contexts, vault.contexts);
  return context;
}

/** Register a Gathering (primary record — gatherings never appear as entries in the seed world). */
export function registerGathering(vault: Vault, gathering: Gathering): Gathering {
  if (typeof gathering.id !== "string" || gathering.id.length === 0) fail("registerGathering: gathering.id must be a non-empty string");
  if (vault.gatheringById.has(gathering.id)) fail(`registerGathering: duplicate gathering id ${gathering.id}`);
  if (!vault.contextById.has(gathering.context)) fail(`registerGathering: gathering ${gathering.id} names unknown context "${gathering.context}"`);
  if (typeof gathering.name !== "string" || gathering.name.length === 0) fail(`registerGathering: gathering ${gathering.id} needs a name`);
  if (typeof gathering.date !== "string" || Number.isNaN(Date.parse(gathering.date))) fail(`registerGathering: gathering ${gathering.id} needs an ISO date`);
  if (typeof gathering.upcoming !== "boolean") fail(`registerGathering: gathering ${gathering.id} needs upcoming: boolean`);
  vault.gatherings.push(gathering);
  vault.gatheringById.set(gathering.id, gathering);
  writeRegistry(vault, REGISTRY_FILES.gatherings, vault.gatherings);
  return gathering;
}

/** Register a Person (primary record — anchors/merged/state are not derivable from the seed stream). */
export function registerPerson(vault: Vault, person: Person): Person {
  if (typeof person.id !== "string" || person.id.length === 0) fail("registerPerson: person.id must be a non-empty string");
  if (vault.personById.has(person.id)) fail(`registerPerson: duplicate person id ${person.id}`);
  if (typeof person.name !== "string" || person.name.length === 0) fail(`registerPerson: person ${person.id} needs a name`);
  if (!Array.isArray(person.anchors)) fail(`registerPerson: person ${person.id} needs anchors: Anchor[]`);
  for (const a of person.anchors) {
    if (!ANCHOR_KINDS.includes(a.kind)) fail(`registerPerson: person ${person.id} anchor has unknown kind "${a.kind}"`);
    if (typeof a.value !== "string" || a.value.length === 0) fail(`registerPerson: person ${person.id} anchor needs a value`);
    if (typeof a.verified !== "boolean") fail(`registerPerson: person ${person.id} anchor needs verified: boolean`);
    if (!vault.contextById.has(a.context)) fail(`registerPerson: person ${person.id} anchor names unknown context "${a.context}"`);
  }
  if (!Array.isArray(person.merged)) fail(`registerPerson: person ${person.id} needs merged: MergeRecord[]`);
  if (typeof person.sighted_at !== "string" || Number.isNaN(Date.parse(person.sighted_at)))
    fail(`registerPerson: person ${person.id} needs an ISO sighted_at`);
  if (!PERSON_STATES.includes(person.state)) fail(`registerPerson: person ${person.id} has unknown state "${person.state}"`);
  vault.persons.push(person);
  vault.personById.set(person.id, person);
  writeRegistry(vault, REGISTRY_FILES.persons, vault.persons);
  return person;
}

/**
 * Commit a fully-validated Entry to the stream: one appendFileSync, one
 * in-memory push. The ONLY legitimate caller is appendEntry (append.ts),
 * which owns all validation — nothing else in this repo may write the
 * stream. Serializes the given object verbatim (JSON key order preserved),
 * so a replayed seed line commits byte-identical to its source.
 */
export function commitValidated(vault: Vault, entry: Entry): Entry {
  appendFileSync(join(vault.dir, STREAM), JSON.stringify(entry) + "\n", "utf8");
  vault.entries.push(entry);
  vault.entryById.set(entry.id, entry);
  return entry;
}
