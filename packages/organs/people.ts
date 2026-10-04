// Normalized source facts enter through the ordinary vault write path. The
// model interprets pages; this module checks identities, evidence and storage.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { anchorKey, committedPeopleEvidence } from "../../tools/projections/people-identity.js";
import type { Actor, Confidence, Entry, Person } from "../../tools/seed-world/types.js";
import {
  resolvePeopleId, peopleImportedPayload, peopleSourceId, peopleSourcePayload, peopleSourceReads, projectPeopleView,
  type PeopleAnchor, type PeopleIdentityState, type PeopleImportedPayload,
  type PeopleReadState, type PeopleSourceIdentity, type PeopleSourcePayload,
  type PeopleSourceRow, type PeopleSourceSelection, type PeopleView, type PeopleIdentityMerge,
  peopleProspectPayload, peopleProspectSourceId, peopleProspectObservationKey, peopleProspectObservations,
  type PeopleProspectPayload, type PeopleProspectSource, type PeopleProspectReason,
} from "../../tools/projections/people.js";
import { appendEntry, type NewEntry } from "../vault/append.js";
import { validatePeopleProspectShape } from "../vault/people-prospect-validation.js";
import { ANCHOR_KINDS, registerGathering, registerPerson, type Vault } from "../vault/store.js";

export type { PeopleSourceIdentity, PeopleSourceRow, PeopleSourceSelection, PeopleAnchor } from "../../tools/projections/people.js";

interface PeopleCommand {
  contextId: string;
  viewId: string;
  at?: string;
  actor?: Actor;
}

export interface SelectPeopleSourcesInput extends PeopleCommand {
  viewName: string;
  /** Exact selected scope. Previously selected sources omitted here are deselected. */
  sources: PeopleSourceSelection[];
  discoveryComplete?: boolean;
}

export interface ImportPeopleSourceInput extends PeopleCommand {
  source: PeopleSourceIdentity;
  /** Stable event-local row keys, supplied by the observed source or importer. */
  rows: PeopleSourceRow[];
  /** Partial reads retain prior known rows; a complete read replaces the row set. */
  readState: Exclude<PeopleReadState, "unread">;
  evidence: string[];
}

export interface SavePeopleProspectInput extends PeopleCommand {
  requestId: string;
  /** Host command fingerprint for receipt replay after live evidence expires. */
  requestDigest?: string;
  source: PeopleProspectSource;
  rowId: string;
  name: string;
  anchors?: PeopleAnchor[];
  evidence: string[];
  confidence: Confidence;
  reason: PeopleProspectReason;
}

function fail(reason: string): never { throw new Error(`people: ${reason}`); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value.trim();
}
function timestamp(value: unknown, label: string): string {
  const result = text(value, label);
  // Structural ISO validation, including calendar rollover that Date.parse accepts.
  if (!/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(result) || !Number.isFinite(Date.parse(result))) fail(`${label} must be a valid ISO date`);
  const day = result.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) fail(`${label} must be a valid calendar date`);
  return result;
}
function evidence(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} needs retained evidence pointers`);
  return [...new Set(value.map((pointer) => text(pointer, label)))];
}
function identity(value: unknown): PeopleSourceIdentity {
  const item = object(value, "source");
  return { platform: text(item.platform, "platform"), accountId: text(item.accountId, "accountId"), eventId: text(item.eventId, "eventId") };
}
function selection(value: unknown): PeopleSourceSelection {
  const item = object(value, "source");
  const url = text(item.url, "source URL");
  let parsed: URL;
  try { parsed = new URL(url); } catch { return fail("source URL must be HTTP(S)"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) fail("source URL must be HTTP(S), without credentials");
  return { ...identity(item), name: text(item.name, "source name"), date: timestamp(item.date, "source date"), url, evidence: evidence(item.evidence, "source evidence") };
}
function command(vault: Vault, value: PeopleCommand): Required<PeopleCommand> {
  const input = object(value, "input");
  const contextId = text(input.contextId, "World ID");
  const context = vault.contextById.get(contextId);
  if (!context || context.apps_never_read) fail(`World ${contextId} is unavailable to the people importer`);
  const actor = input.actor === undefined ? { kind: "app", ref: "app-event" } : object(input.actor, "actor");
  if (!["app", "lois", "human"].includes(actor.kind as string)) fail("actor kind is invalid");
  return { contextId, viewId: text(input.viewId, "viewId"), at: timestamp(input.at ?? new Date().toISOString(), "at"), actor: { kind: actor.kind as Actor["kind"], ref: text(actor.ref, "actor ref") } };
}
function normalizeRow(value: unknown, sourceEvidence: string[]): Required<Pick<PeopleSourceRow, "rowId" | "name" | "anchors" | "evidence">> & Pick<PeopleSourceRow, "rsvp" | "attendance"> {
  const item = object(value, "row");
  const pointers = evidence(item.evidence, "row evidence");
  if (item.anchors !== undefined && !Array.isArray(item.anchors)) fail("row anchors must be an array");
  const anchors: PeopleAnchor[] = (item.anchors ?? []).map((value: unknown) => {
    const anchor = object(value, "anchor");
    if (!(ANCHOR_KINDS as readonly unknown[]).includes(anchor.kind) || typeof anchor.verified !== "boolean") fail("anchor needs a known kind and verified boolean");
    const pointer = anchor.evidence === undefined ? undefined : text(anchor.evidence, "anchor evidence");
    if (anchor.verified && (!pointer || (!pointers.includes(pointer) && !sourceEvidence.includes(pointer)))) fail("verified anchor needs a retained evidence pointer from this read");
    let adjudication: PeopleAnchor["adjudication"];
    if (anchor.adjudication !== undefined) {
      const decision = object(anchor.adjudication, "identity adjudication");
      const proof = evidence(decision.evidence, "identity adjudication evidence");
      if (!anchor.verified || proof.some(item => !pointers.includes(item) && !sourceEvidence.includes(item))) fail("identity adjudication needs verified, retained evidence from this read");
      adjudication = { rationale: text(decision.rationale, "identity rationale"), evidence: proof };
    }
    const raw = text(anchor.value, "anchor value");
    return { kind: anchor.kind as PeopleAnchor["kind"], value: anchor.kind === "email" ? raw.toLowerCase() : raw, verified: anchor.verified, ...(pointer ? { evidence: pointer } : {}), ...(adjudication ? { adjudication } : {}) };
  });
  const keys = anchors.map((anchor) => JSON.stringify([anchor.kind, anchor.value]));
  if (new Set(keys).size !== keys.length) fail("row has duplicate anchors");
  return {
    rowId: text(item.rowId, "rowId"), name: text(item.name, "row name"), anchors, evidence: pointers,
    ...(item.rsvp === undefined ? {} : { rsvp: text(item.rsvp, "rsvp") }),
    ...(item.attendance === undefined ? {} : { attendance: text(item.attendance, "attendance") }),
  };
}

function selections(vault: Vault, contextId: string, viewId: string): Map<string, { entry: Entry; payload: PeopleSourcePayload }> {
  const latest = new Map<string, { entry: Entry; payload: PeopleSourcePayload }>();
  for (const entry of vault.entries) {
    const payload = peopleSourcePayload(entry);
    if (entry.context === contextId && payload?.operation === "selection" && payload.viewId === viewId) latest.set(peopleSourceId(payload), { entry, payload });
  }
  return latest;
}
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

function appendListing(vault: Vault, cmd: Required<PeopleCommand>, payload: PeopleSourcePayload, prior?: Entry): Entry {
  return appendEntry(vault, {
    at: cmd.at, context: cmd.contextId, type: "listing", subtype: "people-source", actor: cmd.actor,
    about: payload.gathering, source: `${payload.platform}-people-source`, payload: { ...payload },
    refs: payload.rowEntryIds, ...(prior ? { supersedes: prior.id } : {}),
  });
}

/** All structural and source-scope validation finishes before any registry/stream write. */
export function selectPeopleSources(vault: Vault, input: SelectPeopleSourcesInput): PeopleView {
  const cmd = command(vault, input);
  const viewName = text(input.viewName, "view name");
  if (!Array.isArray(input.sources) || input.sources.length === 0) fail("select at least one source gathering");
  if (input.discoveryComplete !== undefined && typeof input.discoveryComplete !== "boolean") fail("discoveryComplete must be boolean");
  const sources = input.sources.map(selection);
  const keys = sources.map(peopleSourceId);
  if (new Set(keys).size !== keys.length) fail("duplicate source identity in selected scope");
  const previous = selections(vault, cmd.contextId, cmd.viewId);
  const reads = peopleSourceReads(vault, cmd.contextId);
  const changes: { payload: PeopleSourcePayload; prior?: Entry }[] = [];
  for (const source of sources) {
    const sourceId = peopleSourceId(source);
    const prior = previous.get(sourceId);
    const gathering = reads.get(sourceId)?.payload.gathering ?? prior?.payload.gathering ?? `g-people-${hash([cmd.contextId, sourceId])}`;
    const registered = vault.gatheringById.get(gathering);
    if (registered && registered.context !== cmd.contextId) fail("source gathering belongs to a different World");
    const payload: PeopleSourcePayload = {
      ...source, operation: "selection", gathering, viewId: cmd.viewId, viewName, selected: true,
      discoveryComplete: input.discoveryComplete ?? false,
      readState: "unread", rowCount: 0, rowEntryIds: [],
    };
    if (!prior || !same(prior.payload, payload)) changes.push({ payload, prior: prior?.entry });
  }
  for (const [key, prior] of previous) {
    if (keys.includes(key) || !prior.payload.selected) continue;
    changes.push({ payload: { ...prior.payload, viewName, selected: false, discoveryComplete: input.discoveryComplete ?? false }, prior: prior.entry });
  }
  for (const { payload } of changes) {
    if (!vault.gatheringById.has(payload.gathering)) registerGathering(vault, { id: payload.gathering, context: cmd.contextId, name: payload.name, date: payload.date, upcoming: false });
  }
  for (const { payload, prior } of changes) appendListing(vault, cmd, payload, prior);
  return projectPeopleView(vault, cmd.contextId, cmd.viewId)!;
}

type NormalizedRow = ReturnType<typeof normalizeRow>;
interface RowIdentity { personId: string; identity: PeopleIdentityState }

/** Only an evidence-bearing adjudication can retire an already-visible provisional ID. */
function reconcileProvisionalPeople(
  rows: NormalizedRow[], knownRows: Map<string, Entry>, retained: Map<string, Set<string>>,
  established: Set<string>, source: PeopleIdentityMerge["peopleSource"],
): Array<{ survivor: string; payload: PeopleIdentityMerge }> {
  const parents = new Map<string, string>();
  const root = (id: string): string => {
    if (!parents.has(id)) parents.set(id, id);
    const parent = parents.get(id)!;
    if (parent === id) return id;
    const result = root(parent); parents.set(id, result); return result;
  };
  const join = (a: string, b: string) => { parents.set(root(a), root(b)); };
  const existing = new Set<string>();
  const authorized = new Set<string>();
  const decisions: Array<{ node: string; anchor: PeopleAnchor }> = [];
  const firstByAnchor = new Map<string, string>();
  for (const row of rows) {
    const person = knownRows.get(row.rowId)?.persons?.[0];
    // New rows participate in conflict detection but are not old identities to retire.
    const node = person ? `person:${person}` : `row:${row.rowId}`;
    if (person) existing.add(person);
    for (const anchor of row.anchors.filter(item => item.verified)) {
      const key = anchorKey(anchor);
      root(node);
      if (anchor.adjudication) {
        if (person) authorized.add(person);
        decisions.push({ node, anchor });
      }
      for (const owner of retained.get(key) ?? []) { existing.add(owner); join(node, `person:${owner}`); }
      const prior = firstByAnchor.get(key);
      if (prior) join(node, prior); else firstByAnchor.set(key, node);
    }
  }
  const groups = new Map<string, string[]>();
  for (const person of existing) {
    const key = root(`person:${person}`);
    const group = groups.get(key) ?? []; group.push(person); groups.set(key, group);
  }
  return [...groups].flatMap(([key, people]) => {
    if (people.length < 2) return [];
    const verified = people.filter(person => established.has(person));
    // Never choose between two established identities. Every provisional owner
    // must have current adjudicated evidence, not merely a matching raw address.
    if (verified.length > 1 || people.some(person => !established.has(person) && !authorized.has(person))) return [];
    const anchors = decisions.filter(item => root(item.node) === key).map(item => item.anchor);
    if (!anchors.length) return [];
    const survivor = verified[0] ?? [...people].sort()[0];
    return [{ survivor, payload: {
      how: "anchor" as const, fromPersonIds: people.filter(person => person !== survivor).sort(),
      anchor: anchors[0], anchors, peopleSource: source,
      rationale: [...new Set(anchors.map(anchor => anchor.adjudication!.rationale))].join("\n\n"),
      evidence: [...new Set(anchors.flatMap(anchor => anchor.adjudication!.evidence))],
    } }];
  });
}

/**
 * Resolve the batch before writing or lending new identity evidence.
 * Established row IDs stay put. Only nonconflicting current evidence from
 * those rows can inform new rows; conflicting rows lend no other anchors.
 * New rows are resolved as connected verified-anchor components, so their
 * input order never creates competing people that did not previously exist.
 */
function resolveRowIdentities(
  rows: NormalizedRow[], knownRows: Map<string, Entry>,
  retainedAnchors: Map<string, Set<string>>, contextId: string, sourceId: string,
): Map<string, RowIdentity> {
  const result = new Map<string, RowIdentity>();
  const known = rows.flatMap((row) => {
    const personId = knownRows.get(row.rowId)?.persons?.[0];
    return personId ? [{ row, personId, keys: row.anchors.filter((anchor) => anchor.verified).map(anchorKey) }] : [];
  });
  const baseConflicts = new Set(known.filter(({ personId, keys }) => keys.some((key) => [...(retainedAnchors.get(key) ?? [])].some((owner) => owner !== personId))).map(({ row }) => row.rowId));
  const claims = new Map<string, Set<string>>();
  for (const candidate of known) {
    if (baseConflicts.has(candidate.row.rowId)) continue;
    for (const key of candidate.keys) {
      const owners = claims.get(key) ?? new Set<string>();
      owners.add(candidate.personId); claims.set(key, owners);
    }
  }
  const conflicts = new Set(known.filter(({ row, keys }) => baseConflicts.has(row.rowId) || keys.some((key) => (claims.get(key)?.size ?? 0) > 1)).map(({ row }) => row.rowId));
  const authority = new Map([...retainedAnchors].map(([key, owners]) => [key, new Set(owners)]));
  for (const { row, personId, keys } of known) {
    const identity = conflicts.has(row.rowId) ? "conflict" : keys.length > 0 ? "verified" : "unresolved";
    result.set(row.rowId, { personId, identity });
    if (identity !== "verified") continue;
    for (const key of keys) {
      const owners = authority.get(key) ?? new Set<string>();
      owners.add(personId); authority.set(key, owners);
    }
  }

  const fresh = rows.filter((row) => !result.has(row.rowId));
  const parents = fresh.map((_, index) => index);
  const find = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const firstRow = new Map<string, number>();
  for (const [index, row] of fresh.entries()) for (const anchor of row.anchors) {
    if (!anchor.verified) continue;
    const key = anchorKey(anchor);
    const prior = firstRow.get(key);
    if (prior !== undefined) parents[find(index)] = find(prior);
    else firstRow.set(key, index);
  }
  const components = new Map<number, NormalizedRow[]>();
  for (const [index, row] of fresh.entries()) {
    const key = find(index);
    const component = components.get(key) ?? [];
    component.push(row); components.set(key, component);
  }
  for (const component of components.values()) {
    const keys = new Set(component.flatMap((row) => row.anchors.filter((anchor) => anchor.verified).map(anchorKey)));
    const owners = new Set([...keys].flatMap((key) => [...(authority.get(key) ?? [])]));
    const identity = owners.size > 1 ? "conflict" : keys.size > 0 ? "verified" : "unresolved";
    // Canonicalize opaque row identity, never names or anchor counts. Existing
    // committed identities always win over this new-component representative.
    const representative = component.map((row) => row.rowId).sort()[0];
    const shared = owners.size === 1 ? [...owners][0] : `p-people-${hash([contextId, sourceId, representative])}`;
    for (const row of component) result.set(row.rowId, {
      personId: identity === "conflict" ? `p-people-${hash([contextId, sourceId, row.rowId])}` : shared,
      identity,
    });
  }
  return result;
}

/** Save one observed candidate into an existing list, not into a fake dinner.
 * The final sighting commits the observation and any adjudicated identity
 * decisions. A request receipt survives later observations and alias changes. */
export function savePeopleProspect(vault: Vault, input: SavePeopleProspectInput): PeopleView {
  const cmd = command(vault, input);
  const currentView = projectPeopleView(vault, cmd.contextId, cmd.viewId);
  if (!currentView) fail("prospect needs an existing People view");
  const rawSource = object(input.source, "prospect source");
  const source: PeopleProspectSource = {
    platform: text(rawSource.platform, "platform"), sourceId: text(rawSource.sourceId, "sourceId"), label: text(rawSource.label, "source label"),
    ...(rawSource.accountId === undefined ? {} : { accountId: text(rawSource.accountId, "accountId") }),
    ...(rawSource.url === undefined ? {} : { url: text(rawSource.url, "source URL") }),
  };
  const pointers = evidence(input.evidence, "finding evidence");
  const row = normalizeRow({ rowId: input.rowId, name: input.name, anchors: input.anchors, evidence: pointers }, pointers);
  const rawReason = object(input.reason, "prospect reason");
  const reason: PeopleProspectReason = {
    text: text(rawReason.text, "reason text"), evidence: evidence(rawReason.evidence, "reason evidence"),
    epistemics: rawReason.epistemics as "inferred", confidence: rawReason.confidence as Confidence,
  };
  const intent = { viewId: cmd.viewId, requestId: text(input.requestId, "requestId"), source, ...row, reason };
  const payload: PeopleProspectPayload = { ...intent, identity: "unresolved", version: 1 };
  const entry: NewEntry = {
    at: cmd.at, context: cmd.contextId, type: "fact", subtype: "sighting", actor: cmd.actor,
    persons: ["preflight-person"], source: `${source.platform}-people-prospect`,
    evidence: pointers[0], confidence: input.confidence, epistemics: "stated", payload: { peopleProspect: payload },
  };
  if (input.requestDigest !== undefined) entry.payload.peopleProspectRequestDigest = text(input.requestDigest, "requestDigest");
  validatePeopleProspectShape(entry);
  for (const prior of vault.entries) {
    if (prior.context !== cmd.contextId) continue;
    const p = peopleProspectPayload(prior);
    if (!p || p.viewId !== cmd.viewId || p.requestId !== intent.requestId) continue;
    const { identity: _identity, version: _version, identityMergeIds: _merges, ...priorIntent } = p;
    if (!isDeepStrictEqual(priorIntent, intent) || !isDeepStrictEqual(prior.actor, cmd.actor) || prior.confidence !== input.confidence || prior.payload.peopleProspectRequestDigest !== input.requestDigest) fail("requestId already names a different prospect finding");
    return currentView;
  }

  const key = peopleProspectObservationKey(cmd.contextId, payload);
  const previous = peopleProspectObservations(vault, cmd.contextId).get(key);
  const { aliases, anchorIndex, established } = committedPeopleEvidence(vault, cmd.contextId, candidate => {
    const p = peopleProspectPayload(candidate);
    return Boolean(p && peopleProspectObservationKey(cmd.contextId, p) === key);
  });
  const knownRows = new Map<string, Entry>();
  if (previous?.entry.persons?.[0]) knownRows.set(row.rowId, { ...previous.entry, persons: [resolvePeopleId(aliases, previous.entry.persons[0])] });
  const merges = reconcileProvisionalPeople([row], knownRows, anchorIndex, established, { ...source, viewId: cmd.viewId, rowId: row.rowId });
  for (const merge of merges) for (const id of merge.payload.fromPersonIds) aliases.set(id, merge.survivor);
  for (const [anchor, owners] of anchorIndex) anchorIndex.set(anchor, new Set([...owners].map(id => resolvePeopleId(aliases, id))));
  for (const [id, known] of knownRows) knownRows.set(id, { ...known, persons: [resolvePeopleId(aliases, known.persons![0])] });
  const resolved = resolveRowIdentities([row], knownRows, anchorIndex, cmd.contextId, peopleProspectSourceId(source)).get(row.rowId)!;
  payload.identity = resolved.identity;
  payload.version = (previous?.payload.version ?? 0) + 1;
  entry.persons = [resolved.personId];
  if (previous) entry.supersedes = previous.entry.id;

  // All caller-controlled structure is checked. The remaining refs and version
  // are derived synchronously from this vault, before the final commit marker.
  if (!vault.personById.has(resolved.personId)) registerPerson(vault, {
    id: resolved.personId, name: row.name, anchors: row.anchors.map(anchor => ({ kind: anchor.kind, value: anchor.value, verified: false, context: cmd.contextId })),
    merged: [], sighted_at: cmd.at, state: "active",
  });
  const mergeIds: string[] = [];
  for (const merge of merges) {
    const existing = vault.entries.find(candidate => candidate.context === cmd.contextId && candidate.type === "merged" && candidate.subtype === "people-identity" && candidate.persons?.[0] === merge.survivor && same(candidate.payload, merge.payload));
    const decision = existing ?? appendEntry(vault, {
      at: cmd.at, context: cmd.contextId, type: "merged", subtype: "people-identity", actor: cmd.actor,
      persons: [merge.survivor], source: entry.source, evidence: merge.payload.evidence[0], payload: { ...merge.payload },
    });
    mergeIds.push(decision.id);
  }
  if (mergeIds.length) payload.identityMergeIds = mergeIds;
  entry.refs = [...mergeIds, ...(previous ? [previous.entry.id] : [])];
  appendEntry(vault, entry);
  return projectPeopleView(vault, cmd.contextId, cmd.viewId)!;
}

/**
 * Persist one normalized read. Rows append first; the final listing names the
 * exact visible row-version set. Interrupted rows cannot masquerade as a
 * completed import. An IO failure may leave unused registry records/row facts;
 * a retry reuses their deterministic identities and finishes the listing.
 */
export function importPeopleSource(vault: Vault, input: ImportPeopleSourceInput): PeopleView {
  const cmd = command(vault, input);
  const source = identity(input.source);
  const sourceId = peopleSourceId(source);
  const prior = selections(vault, cmd.contextId, cmd.viewId).get(sourceId);
  if (!prior?.payload.selected) fail("source is not selected in this people view");
  if (!["partial", "read", "failed"].includes(input.readState)) fail("readState must be partial, read or failed");
  const pointers = evidence(input.evidence, "read evidence");
  if (!Array.isArray(input.rows)) fail("rows must be an array");
  const rows = input.rows.map((value) => normalizeRow(value, pointers));
  if (new Set(rows.map((row) => row.rowId)).size !== rows.length) fail("duplicate rowId; ambiguous source rows need distinct stable keys");
  if (input.readState === "failed" && rows.length > 0) fail("a failed read cannot introduce rows; use partial for observed rows");

  const reads = peopleSourceReads(vault, cmd.contextId);
  const previousRead = reads.get(sourceId);
  const incomingRowIds = new Set(rows.map((row) => row.rowId));
  const { aliases, anchorIndex, established, history } = committedPeopleEvidence(vault, cmd.contextId, entry => {
    const row = peopleImportedPayload(entry);
    return Boolean(row && peopleSourceId(row.peopleSource) === sourceId && (input.readState === "read" || incomingRowIds.has(row.rowId)));
  });
  const oldRows = new Map<string, Entry>();
  const knownRows = new Map<string, Entry>();
  for (const entry of vault.entries) {
    if (entry.context !== cmd.contextId) continue;
    const row = peopleImportedPayload(entry);
    if (!row || !entry.persons?.[0]) continue;
    if (peopleSourceId(row.peopleSource) === sourceId) {
      oldRows.set(row.rowId, entry);
      if (history.has(entry.id)) knownRows.set(row.rowId, { ...entry, persons: [resolvePeopleId(aliases, entry.persons[0])] });
    }
  }
  const merges = reconcileProvisionalPeople(rows, knownRows, anchorIndex, established, source);
  for (const merge of merges) for (const id of merge.payload.fromPersonIds) aliases.set(id, merge.survivor);
  for (const [key, owners] of anchorIndex) anchorIndex.set(key, new Set([...owners].map(id => resolvePeopleId(aliases, id))));
  for (const [key, entry] of knownRows) knownRows.set(key, { ...entry, persons: [resolvePeopleId(aliases, entry.persons![0])] });
  const resolved = resolveRowIdentities(rows, knownRows, anchorIndex, cmd.contextId, sourceId);

  const pending: { row: PeopleImportedPayload; personId: string; person?: Person; prior?: Entry; existing?: Entry }[] = [];
  for (const row of rows) {
    const previous = oldRows.get(row.rowId);
    const { personId, identity: state } = resolved.get(row.rowId)!;
    const person = vault.personById.has(personId) || pending.some((item) => item.personId === personId) ? undefined : {
      id: personId, name: row.name, anchors: row.anchors.map((anchor) => ({ kind: anchor.kind, value: anchor.value, verified: false, context: cmd.contextId })),
      merged: [], sighted_at: cmd.at, state: "active" as const,
    };
    const priorPayload = previous && peopleImportedPayload(previous);
    const payload: PeopleImportedPayload = { peopleSource: source, ...row, identity: state, version: priorPayload?.version ?? 1 };
    const samePerson = previous?.persons?.[0] === personId;
    if (priorPayload && (!same(priorPayload, payload) || !samePerson)) payload.version++;
    pending.push({ row: payload, personId, person, prior: previous, ...(priorPayload && samePerson && same(priorPayload, payload) ? { existing: previous } : {}) });
  }

  // Preflight is complete. No model decision or IO occurs inside this write sequence.
  const membership = new Map<string, string>();
  if (input.readState !== "read") for (const id of previousRead?.payload.rowEntryIds ?? []) {
    const entry = vault.entryById.get(id);
    const row = entry && peopleImportedPayload(entry);
    if (row) membership.set(row.rowId, id);
  }
  for (const item of pending) {
    if (item.person) registerPerson(vault, item.person);
    const entry = item.existing ?? appendEntry(vault, {
      at: cmd.at, context: cmd.contextId, type: "imported", subtype: "guest", actor: cmd.actor,
      persons: [item.personId], about: prior.payload.gathering, source: `${source.platform}-people-source`,
      evidence: item.row.evidence[0], payload: { ...item.row },
      ...(item.prior ? { supersedes: item.prior.id } : {}),
    });
    membership.set(item.row.rowId, entry.id);
  }
  const mergeIds = [...previousRead?.payload.identityMergeIds ?? []];
  for (const merge of merges) {
    // An interrupted attempt can leave an uncommitted decision. Reuse it, but
    // only the final source listing below makes it effective in projections.
    const existing = vault.entries.find(entry => entry.context === cmd.contextId && entry.type === "merged" && entry.subtype === "people-identity" && entry.persons?.[0] === merge.survivor && same(entry.payload, merge.payload));
    const entry = existing ?? appendEntry(vault, {
      at: cmd.at, context: cmd.contextId, type: "merged", subtype: "people-identity", actor: cmd.actor,
      persons: [merge.survivor], source: `${source.platform}-people-source`, evidence: merge.payload.evidence[0], payload: { ...merge.payload },
    });
    if (!mergeIds.includes(entry.id)) mergeIds.push(entry.id);
  }
  const payload: PeopleSourcePayload = {
    ...prior.payload, operation: "read", readState: input.readState, evidence: pointers,
    rowCount: membership.size, rowEntryIds: [...membership.values()],
    ...(mergeIds.length ? { identityMergeIds: mergeIds } : {}),
  };
  if (!previousRead || !same(previousRead.payload, payload)) appendListing(vault, cmd, payload, previousRead?.entry);
  return projectPeopleView(vault, cmd.contextId, cmd.viewId)!;
}
