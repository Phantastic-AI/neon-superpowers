import type { World } from "./types.js";
import type { Entry } from "../seed-world/types.js";
import {
  peopleAliases, resolvePeopleId, peopleSourceReads, peopleSourcePayload,
  peopleImportedPayload, peopleProspectPayload, peopleProspectObservations, type PeopleAnchor,
} from "./people.js";

export function anchorKey(anchor: Pick<PeopleAnchor, "kind" | "value">): string {
  return JSON.stringify([anchor.kind, anchor.kind === "email" ? anchor.value.trim().toLowerCase() : anchor.value.trim()]);
}

/** Shared by writers and the append boundary. Current authority, historic row
 * bindings and ever-established owners are deliberately distinct. */
export function committedPeopleEvidence(vault: World, contextId: string, exclude: (entry: Entry) => boolean) {
  const current = new Set<string>();
  const history = new Set<string>();
  for (const { payload } of peopleSourceReads(vault, contextId).values()) for (const id of payload.rowEntryIds) current.add(id);
  for (const { entry } of peopleProspectObservations(vault, contextId).values()) current.add(entry.id);
  for (const entry of vault.entries) {
    if (entry.context !== contextId) continue;
    const read = peopleSourcePayload(entry);
    if (read?.operation === "read") for (const id of read.rowEntryIds) history.add(id);
    if (peopleProspectPayload(entry)) history.add(entry.id);
  }
  const aliases = peopleAliases(vault, contextId);
  const anchorIndex = new Map<string, Set<string>>();
  const established = new Set<string>();
  const addAnchor = (id: string, anchor: PeopleAnchor): void => {
    if (!anchor.verified) return;
    const key = anchorKey(anchor);
    const owners = anchorIndex.get(key) ?? new Set<string>();
    owners.add(resolvePeopleId(aliases, id)); anchorIndex.set(key, owners);
  };
  for (const person of vault.persons) {
    if (person.state !== "active" || person.id.startsWith("p-people-")) continue;
    for (const anchor of person.anchors) if (anchor.context === contextId && anchor.verified) {
      addAnchor(person.id, anchor); established.add(resolvePeopleId(aliases, person.id));
    }
  }
  for (const entry of vault.entries) {
    if (entry.context !== contextId || !entry.persons?.[0]) continue;
    const row = peopleImportedPayload(entry) ?? peopleProspectPayload(entry);
    if (!row || row.identity === "conflict") continue;
    if (history.has(entry.id) && row.anchors.some(anchor => anchor.verified)) established.add(resolvePeopleId(aliases, entry.persons[0]));
    if (current.has(entry.id) && !exclude(entry)) for (const anchor of row.anchors) addAnchor(entry.persons[0], anchor);
  }
  return { aliases, anchorIndex, established, history };
}
