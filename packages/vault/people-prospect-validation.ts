import type { NewEntry } from "./append.js";
import { isDeepStrictEqual } from "node:util";
import { ANCHOR_KINDS, type Vault } from "./store.js";
import { projectPeopleView, resolvePeopleId, peopleProspectPayload, type PeopleAnchor } from "../../tools/projections/people.js";
import { anchorKey, committedPeopleEvidence } from "../../tools/projections/people-identity.js";

function reject(reason: string): never { throw new Error(`appendEntry: peopleProspect ${reason}`); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) reject(`${label} must be a non-empty string`);
}
function strings(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length)) reject(`${label} must be a ${allowEmpty ? "" : "non-empty "}array`);
  for (const item of value) text(item, label);
  if (new Set(value).size !== value.length) reject(`${label} must contain unique values`);
  return value as string[];
}
const marked = (entry: Pick<NewEntry, "payload">): boolean => Object.hasOwn(entry.payload, "peopleProspect");
const payload = (entry: Pick<NewEntry, "payload">) => object(entry.payload.peopleProspect, "payload");

/** Pure structural preflight, also used before the organ registers any Person. */
export function validatePeopleProspectShape(entry: NewEntry): void {
  if (!marked(entry)) return;
  if (entry.type !== "fact" || entry.subtype !== "sighting" || entry.about !== undefined) reject("requires fact/sighting without a Gathering");
  if (entry.persons?.length !== 1) reject("requires exactly one Person");
  if (!["open", "chatham", "confided"].includes(entry.confidence as string)) reject("requires explicit confidence (disclosure scope)");
  if (entry.epistemics !== "stated") reject("requires stated observations with a separately inferred reason");
  const p = payload(entry);
  for (const key of ["viewId", "requestId", "rowId", "name"]) text(p[key], key);
  if (!Number.isSafeInteger(p.version) || (p.version as number) < 1) reject("version must be a positive integer");
  if (!["verified", "unresolved", "conflict"].includes(p.identity as string)) reject("requires a known identity state");
  const source = object(p.source, "source");
  for (const key of ["platform", "sourceId", "label"]) text(source[key], `source.${key}`);
  if (source.accountId !== undefined) text(source.accountId, "source.accountId");
  if (source.url !== undefined) {
    text(source.url, "source.url");
    let url: URL;
    try { url = new URL(source.url); } catch { return reject("source.url must be HTTP(S)"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) reject("source.url must be HTTP(S), without credentials");
  }
  const evidence = strings(p.evidence, "evidence");
  if (typeof entry.evidence !== "string" || !evidence.includes(entry.evidence)) reject("entry evidence must belong to the retained finding evidence");
  const retained = (pointers: unknown, label: string): void => {
    if (strings(pointers, label).some(pointer => !evidence.includes(pointer))) reject(`${label} must belong to the retained finding evidence`);
  };
  const reason = object(p.reason, "reason");
  text(reason.text, "reason.text");
  if (reason.epistemics !== "inferred") reject("reason must be labelled inferred");
  const disclosure = ["open", "chatham", "confided"];
  if (!disclosure.includes(reason.confidence as string) || disclosure.indexOf(reason.confidence as string) < disclosure.indexOf(entry.confidence!)) reject("reason confidence must preserve the observation's disclosure scope");
  retained(reason.evidence, "reason.evidence");
  if (!Array.isArray(p.anchors)) reject("anchors must be an array");
  const keys = new Set<string>();
  for (const value of p.anchors) {
    const anchor = object(value, "anchor");
    if (!(ANCHOR_KINDS as readonly unknown[]).includes(anchor.kind) || typeof anchor.verified !== "boolean") reject("anchor needs a known kind and verified boolean");
    text(anchor.value, "anchor.value");
    const key = JSON.stringify([anchor.kind, anchor.kind === "email" ? anchor.value.trim().toLowerCase() : anchor.value.trim()]);
    if (keys.has(key)) reject("anchors must have unique kind/value pairs");
    keys.add(key);
    if (anchor.evidence !== undefined) text(anchor.evidence, "anchor.evidence");
    if (anchor.verified && (typeof anchor.evidence !== "string" || !evidence.includes(anchor.evidence))) reject("verified anchor requires retained evidence");
    if (anchor.adjudication !== undefined) {
      const adjudication = object(anchor.adjudication, "adjudication");
      if (!anchor.verified) reject("identity adjudication requires a verified anchor");
      text(adjudication.rationale, "adjudication.rationale");
      retained(adjudication.evidence, "adjudication.evidence");
    }
  }
  if (p.identityMergeIds !== undefined) strings(p.identityMergeIds, "identityMergeIds", true);
}

const originKey = (p: Record<string, unknown>): string => {
  const source = object(p.source, "source");
  return JSON.stringify([source.platform, source.accountId ?? null, source.sourceId, p.rowId]);
};

/** Marker-specific scope and commit checks; ordinary sightings remain unchanged. */
export function validatePeopleProspectEntry(vault: Vault, entry: NewEntry): void {
  if (!marked(entry)) return;
  validatePeopleProspectShape(entry);
  const p = payload(entry);
  if (!projectPeopleView(vault, entry.context, p.viewId as string)) reject("requires an existing accessible People view");
  let previous: (typeof vault.entries)[number] | undefined;
  for (const candidate of vault.entries) {
    if (candidate.context !== entry.context || candidate.type !== "fact" || candidate.subtype !== "sighting" || !marked(candidate)) continue;
    const prior = payload(candidate);
    if (prior.viewId === p.viewId && prior.requestId === p.requestId) reject("requestId already has a receipt; reuse it through the organ");
    if (originKey(prior) === originKey(p)) previous = candidate;
  }
  if (entry.supersedes !== previous?.id || p.version !== (previous ? (payload(previous).version as number) + 1 : 1)) reject("must supersede the latest finding in this World/source/row version chain");
  const mergeIds = (p.identityMergeIds ?? []) as string[];
  const expectedRefs = [...mergeIds, ...(previous ? [previous.id] : [])];
  const refs = strings(entry.refs ?? [], "refs", true);
  if (refs.length !== expectedRefs.length || expectedRefs.some(id => !refs.includes(id))) reject("refs must name only this finding's supersession and identity decisions");
  if (previous && !mergeIds.length) {
    const { aliases } = committedPeopleEvidence(vault, entry.context, () => false);
    if (resolvePeopleId(aliases, previous.persons![0]) !== entry.persons![0]) reject("superseding finding must retain its Person unless an identity decision authorizes the transition");
  }
  for (const id of mergeIds) {
    const merge = vault.entryById.get(id);
    if (!merge || merge.context !== entry.context || merge.type !== "merged" || merge.subtype !== "people-identity" || merge.persons?.[0] !== entry.persons?.[0]) reject("identity decision must be in this World and name the same surviving Person");
    // The prospect origin contract is checked alongside the writer's derived
    // merge payload; arbitrary same-World merges cannot be activated here.
    const origin = object(merge.payload.peopleSource, "identity decision source");
    const source = object(p.source, "source");
    if (origin.viewId !== p.viewId || origin.rowId !== p.rowId || origin.platform !== source.platform || origin.accountId !== source.accountId || origin.sourceId !== source.sourceId) reject("identity decision must belong to this view and prospect source row");
    const { aliases, anchorIndex, established } = committedPeopleEvidence(vault, entry.context, candidate => {
      const prior = peopleProspectPayload(candidate);
      return Boolean(prior && originKey(prior as unknown as Record<string, unknown>) === originKey(p));
    });
    const priorPerson = previous?.persons?.[0] && resolvePeopleId(aliases, previous.persons[0]);
    const survivor = entry.persons![0];
    const retired = strings(merge.payload.fromPersonIds, "identity decision retired people");
    if (merge.persons?.length !== 1 || merge.payload.how !== "anchor" || p.identity !== "verified" ||
        !priorPerson || established.has(priorPerson) || retired.length !== 1 || retired[0] !== priorPerson || survivor === priorPerson) reject("identity decision may retire only this row's previous provisional Person");
    const anchors = p.anchors as PeopleAnchor[];
    const owners = new Set(anchors.filter(anchor => anchor.verified).flatMap(anchor => [...(anchorIndex.get(anchorKey(anchor)) ?? [])]));
    if (owners.size !== 1 || !owners.has(survivor)) reject("identity decision survivor must be the unique current anchor owner");
    const decisions = anchors.filter(anchor => anchor.verified && anchor.adjudication);
    if (!decisions.length || !isDeepStrictEqual(merge.payload.anchors, decisions) || !isDeepStrictEqual(merge.payload.anchor, decisions[0])) reject("identity decision must retain this finding's verified adjudicated anchors");
    const proof = [...new Set(decisions.flatMap(anchor => anchor.adjudication!.evidence))];
    const rationale = [...new Set(decisions.map(anchor => anchor.adjudication!.rationale))].join("\n\n");
    if (!isDeepStrictEqual(merge.payload.evidence, proof) || merge.evidence !== proof[0] || merge.payload.rationale !== rationale) reject("identity decision must retain this finding's adjudication evidence and rationale");
  }
}
