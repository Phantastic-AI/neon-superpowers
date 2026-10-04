import type { World } from "./types.js";
import type { AnchorKind, Confidence, Entry } from "../seed-world/types.js";

/** Platform IDs are opaque and scoped to the authenticated source account. */
export interface PeopleSourceIdentity {
  platform: string;
  accountId: string;
  eventId: string;
}

export interface PeopleAnchor {
  kind: AnchorKind;
  value: string;
  verified: boolean;
  /** Required for a verified anchor; points to retained source evidence. */
  evidence?: string;
  /** The model's source-level judgment, distinct from mere file possession. */
  adjudication?: { rationale: string; evidence: string[] };
}

export interface PeopleSourceSelection extends PeopleSourceIdentity {
  name: string;
  date: string;
  url: string;
  evidence: string[];
}

/** A row key is event-local; neither it nor a name establishes global identity. */
export interface PeopleSourceRow {
  rowId: string;
  name: string;
  anchors?: PeopleAnchor[];
  rsvp?: string;
  attendance?: string;
  evidence: string[];
}

export type PeopleReadState = "unread" | "partial" | "read" | "failed";
export type PeopleIdentityState = "verified" | "unresolved" | "conflict";

export interface PeopleSource extends PeopleSourceSelection {
  sourceId: string;
  gatheringId: string;
  readState: PeopleReadState;
  rowCount: number;
  entryId: string;
}

export interface PeopleMembership extends PeopleSourceIdentity {
  sourceId: string;
  gatheringId: string;
  name: string;
  date: string;
  url: string;
  rowId: string;
  entryId: string;
  version: number;
  evidence: string[];
  rsvp?: string;
  attendance?: string;
}

export interface PeopleProspectSource {
  platform: string;
  /** Optional because some observed sources are list-only, not account-bound. */
  accountId?: string;
  sourceId: string;
  label: string;
  url?: string;
}

export interface PeopleProspectReason {
  text: string;
  evidence: string[];
  epistemics: "inferred";
  confidence: Confidence;
}

export interface PeopleProspectFinding extends PeopleProspectSource {
  /** Namespaced projection key; sourceId remains the original platform ID. */
  sourceKey: string;
  sourceRowId: string;
  observationEntryId: string;
  reasonEntryId: string;
  name: string;
  version: number;
  evidence: string[];
  confidence: Confidence;
  reason: PeopleProspectReason;
}

export interface PeopleRow {
  personId: string;
  name: string;
  identity: PeopleIdentityState;
  sourceCount: number;
  memberships: PeopleMembership[];
  anchors: PeopleAnchor[];
  prospects: PeopleProspectFinding[];
}

export interface PeopleView {
  contextId: string;
  contextName: string;
  viewId: string;
  name: string;
  cursor: number;
  sources: PeopleSource[];
  people: PeopleRow[];
  coverage: {
    selected: number;
    unread: number;
    partial: number;
    read: number;
    failed: number;
    discoveryComplete: boolean;
    complete: boolean;
  };
}

/** Durable listing payload; the listing is the commit marker for its row set. */
export interface PeopleSourcePayload extends PeopleSourceSelection {
  /** Selection is view-local; read state is canonical for this World/source. */
  operation: "selection" | "read";
  gathering: string;
  viewId: string;
  viewName: string;
  selected: boolean;
  discoveryComplete: boolean;
  readState: PeopleReadState;
  rowCount: number;
  rowEntryIds: string[];
  /** Like row versions, identity decisions become visible only at this commit. */
  identityMergeIds?: string[];
}

export interface PeopleIdentityMerge {
  how: "anchor";
  fromPersonIds: string[];
  anchor: PeopleAnchor;
  anchors: PeopleAnchor[];
  rationale: string;
  evidence: string[];
  peopleSource: PeopleSourceIdentity | (PeopleProspectSource & { viewId: string; rowId: string });
}

export interface PeopleProspectPayload {
  viewId: string;
  requestId: string;
  source: PeopleProspectSource;
  rowId: string;
  name: string;
  anchors: PeopleAnchor[];
  identity: PeopleIdentityState;
  version: number;
  evidence: string[];
  reason: PeopleProspectReason;
  identityMergeIds?: string[];
}

/** World-local aliases; never mutate the shared Person registry or old facts. */
export function peopleAliases(world: World, contextId: string, atCursor = Number.POSITIVE_INFINITY): Map<string, string> {
  const committed = new Set<string>();
  const entries = world.entries.filter(entry => entry.context === contextId && entry.cursor <= atCursor);
  for (const entry of entries) {
    const read = peopleSourcePayload(entry);
    if (read?.operation === "read") for (const id of read.identityMergeIds ?? []) committed.add(id);
    const prospect = peopleProspectPayload(entry);
    for (const id of prospect?.identityMergeIds ?? []) committed.add(id);
  }
  const aliases = new Map<string, string>();
  for (const entry of entries) {
    if (!committed.has(entry.id) || entry.type !== "merged" || entry.subtype !== "people-identity" || !entry.persons?.[0]) continue;
    const payload = entry.payload as unknown as PeopleIdentityMerge;
    const survivor = resolvePeopleId(aliases, entry.persons[0]);
    for (const old of payload.fromPersonIds) {
      const from = resolvePeopleId(aliases, old);
      if (from !== survivor) aliases.set(from, survivor);
    }
  }
  return aliases;
}

export function resolvePeopleId(aliases: ReadonlyMap<string, string>, personId: string): string {
  const visited = new Set<string>();
  while (aliases.has(personId) && !visited.has(personId)) {
    visited.add(personId);
    personId = aliases.get(personId)!;
  }
  return personId;
}

export interface PeopleImportedPayload {
  peopleSource: PeopleSourceIdentity;
  rowId: string;
  name: string;
  anchors: PeopleAnchor[];
  identity: PeopleIdentityState;
  version: number;
  evidence: string[];
  rsvp?: string;
  attendance?: string;
}

/** Tuple encoding is collision-free even when IDs contain delimiters. */
export function peopleSourceId(source: PeopleSourceIdentity): string {
  return JSON.stringify([source.platform, source.accountId, source.eventId]);
}

export function peopleSourcePayload(entry: Entry): PeopleSourcePayload | undefined {
  if (entry.type !== "listing" || entry.subtype !== "people-source") return undefined;
  return entry.payload as unknown as PeopleSourcePayload;
}

export function peopleImportedPayload(entry: Entry): PeopleImportedPayload | undefined {
  if (entry.type !== "imported" || entry.subtype !== "guest" || !entry.payload.peopleSource) return undefined;
  return entry.payload as unknown as PeopleImportedPayload;
}

export function peopleProspectSourceId(source: PeopleProspectSource): string {
  return JSON.stringify(["prospect", source.platform, source.accountId ?? null, source.sourceId]);
}

export function peopleProspectObservationKey(contextId: string, payload: Pick<PeopleProspectPayload, "source" | "rowId">): string {
  return JSON.stringify([contextId, peopleProspectSourceId(payload.source), payload.rowId]);
}

export function peopleProspectPayload(entry: Entry): PeopleProspectPayload | undefined {
  if (entry.type !== "fact" || entry.subtype !== "sighting") return undefined;
  const payload = entry.payload.peopleProspect;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload as unknown as PeopleProspectPayload;
}

/** The latest observed source row is shared; list inclusion and reasons are not. */
export function peopleProspectObservations(world: World, contextId: string, atCursor = Number.POSITIVE_INFINITY): Map<string, { entry: Entry; payload: PeopleProspectPayload }> {
  const latest = new Map<string, { entry: Entry; payload: PeopleProspectPayload }>();
  for (const entry of world.entries) {
    if (entry.context !== contextId || entry.cursor > atCursor) continue;
    const payload = peopleProspectPayload(entry);
    if (payload) latest.set(peopleProspectObservationKey(contextId, payload), { entry, payload });
  }
  return latest;
}

/** One committed read per source; view selection never supplies read authority. */
export function peopleSourceReads(world: World, contextId: string, atCursor = Number.POSITIVE_INFINITY): Map<string, { entry: Entry; payload: PeopleSourcePayload }> {
  const reads = new Map<string, { entry: Entry; payload: PeopleSourcePayload }>();
  for (const entry of world.entries) {
    if (entry.context !== contextId || entry.cursor > atCursor) continue;
    const payload = peopleSourcePayload(entry);
    if (payload?.operation === "read") reads.set(peopleSourceId(payload), { entry, payload });
  }
  return reads;
}

export function projectPeopleViews(world: World, atCursor = Number.POSITIVE_INFINITY): PeopleView[] {
  const keys = new Map<string, { contextId: string; viewId: string }>();
  for (const entry of world.entries) {
    if (entry.cursor > atCursor) continue;
    const payload = peopleSourcePayload(entry);
    if (payload?.operation === "selection") keys.set(JSON.stringify([entry.context, payload.viewId]), { contextId: entry.context, viewId: payload.viewId });
  }
  return [...keys.values()].flatMap(({ contextId, viewId }) => {
    const view = projectPeopleView(world, contextId, viewId, atCursor);
    return view ? [view] : [];
  });
}

/** Source membership comes only from committed imported rows, never attendance facts. */
export function projectPeopleView(world: World, contextId: string, viewId: string, atCursor = Number.POSITIVE_INFINITY): PeopleView | undefined {
  const context = world.contexts.find((item) => item.id === contextId);
  if (!context || context.apps_never_read) return undefined;
  const entries = world.entries.filter((entry) => entry.cursor <= atCursor);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const reads = peopleSourceReads(world, contextId, atCursor);
  const aliases = peopleAliases(world, contextId, atCursor);
  const latest = new Map<string, { entry: Entry; payload: PeopleSourcePayload }>();
  let name = "";
  let discoveryComplete = false;
  for (const entry of entries) {
    if (entry.context !== contextId) continue;
    const payload = peopleSourcePayload(entry);
    if (!payload || payload.operation !== "selection" || payload.viewId !== viewId) continue;
    latest.set(peopleSourceId(payload), { entry, payload });
    name = payload.viewName;
    discoveryComplete = payload.discoveryComplete;
  }
  if (!latest.size) return undefined;
  const sources: PeopleSource[] = [];
  const people = new Map<string, PeopleRow>();
  for (const [sourceId, { entry, payload }] of latest) {
    if (!payload.selected) continue;
    const read = reads.get(sourceId);
    const source: PeopleSource = {
      sourceId, gatheringId: payload.gathering, platform: payload.platform,
      accountId: payload.accountId, eventId: payload.eventId, name: payload.name,
      date: payload.date, url: payload.url, evidence: [...new Set([...payload.evidence, ...(read?.payload.evidence ?? [])])],
      readState: read?.payload.readState ?? "unread", rowCount: 0, entryId: read?.entry.id ?? entry.id,
    };
    for (const id of read?.payload.rowEntryIds ?? []) {
      const imported = byId.get(id);
      const row = imported && peopleImportedPayload(imported);
      const personId = imported?.persons?.[0] && resolvePeopleId(aliases, imported.persons[0]);
      if (!imported || !row || !personId || imported.context !== contextId || imported.about !== payload.gathering || peopleSourceId(row.peopleSource) !== sourceId) continue;
      source.rowCount++;
      let person = people.get(personId);
      if (!person) {
        person = { personId, name: row.name, identity: row.identity, sourceCount: 0, memberships: [], anchors: [], prospects: [] };
        people.set(personId, person);
      }
      if (row.identity === "conflict") person.identity = "conflict";
      else if (row.identity === "verified" && person.identity !== "conflict") person.identity = "verified";
      person.memberships.push({
        sourceId, gatheringId: payload.gathering, platform: payload.platform,
        accountId: payload.accountId, eventId: payload.eventId, name: payload.name,
        date: payload.date, url: payload.url, rowId: row.rowId, entryId: imported.id,
        version: row.version, evidence: [...row.evidence],
        ...(row.rsvp === undefined ? {} : { rsvp: row.rsvp }),
        ...(row.attendance === undefined ? {} : { attendance: row.attendance }),
      });
      for (const anchor of row.anchors) {
        if (!person.anchors.some((prior) => prior.kind === anchor.kind && prior.value === anchor.value && prior.verified === anchor.verified)) person.anchors.push(structuredClone(anchor));
      }
    }
    sources.push(source);
  }
  const latestObservation = peopleProspectObservations(world, contextId, atCursor);
  const latestReceiptByView = new Map<string, { entry: Entry; payload: PeopleProspectPayload }>();
  for (const entry of entries) {
    if (entry.context !== contextId) continue;
    const payload = peopleProspectPayload(entry);
    if (!payload) continue;
    const observationKey = peopleProspectObservationKey(entry.context, payload);
    latestReceiptByView.set(JSON.stringify([payload.viewId, observationKey]), { entry, payload });
  }
  for (const { entry: receiptEntry, payload: receipt } of latestReceiptByView.values()) {
    if (receipt.viewId !== viewId) continue;
    const current = latestObservation.get(peopleProspectObservationKey(contextId, receipt));
    if (!current?.entry.persons?.[0]) continue;
    const currentPersonId = resolvePeopleId(aliases, current.entry.persons[0]);
    let person = people.get(currentPersonId);
    if (!person) {
      person = { personId: currentPersonId, name: current.payload.name, identity: current.payload.identity, sourceCount: 0, memberships: [], anchors: [], prospects: [] };
      people.set(currentPersonId, person);
    }
    if (current.payload.identity === "conflict") person.identity = "conflict";
    else if (current.payload.identity === "verified" && person.identity !== "conflict") person.identity = "verified";
    for (const anchor of current.payload.anchors) {
      if (!person.anchors.some((prior) => prior.kind === anchor.kind && prior.value === anchor.value && prior.verified === anchor.verified)) person.anchors.push(structuredClone(anchor));
    }
    person.prospects.push({
      ...current.payload.source,
      sourceKey: peopleProspectSourceId(current.payload.source),
      sourceRowId: current.payload.rowId,
      observationEntryId: current.entry.id,
      reasonEntryId: receiptEntry.id,
      name: current.payload.name,
      version: current.payload.version,
      evidence: [...current.payload.evidence],
      confidence: current.entry.confidence!,
      reason: structuredClone(receipt.reason),
    });
  }
  for (const person of people.values()) person.sourceCount = new Set(person.memberships.map((membership) => membership.sourceId)).size;
  const coverage = {
    selected: sources.length,
    unread: sources.filter((source) => source.readState === "unread").length,
    partial: sources.filter((source) => source.readState === "partial").length,
    read: sources.filter((source) => source.readState === "read").length,
    failed: sources.filter((source) => source.readState === "failed").length,
    discoveryComplete,
    complete: discoveryComplete && sources.length > 0 && sources.every((source) => source.readState === "read"),
  };
  return { contextId, contextName: context.name, viewId, name, cursor: entries.at(-1)?.cursor ?? -1, sources, people: [...people.values()].sort((a, b) => b.sourceCount - a.sourceCount || a.name.localeCompare(b.name) || a.personId.localeCompare(b.personId)), coverage };
}
