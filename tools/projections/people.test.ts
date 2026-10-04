import { describe, expect, it } from "vitest";
import type { Entry } from "../seed-world/types.js";
import type { World } from "./types.js";
import { peopleAliases, peopleProspectSourceId, projectPeopleView, projectPeopleViews, resolvePeopleId } from "./people.js";

const at = "2026-09-05T00:00:00Z";
function fixture(): World {
  return {
    contexts: [{ id: "W", name: "Our World", kind: "social", anchor: "email", created_at: at }],
    gatherings: [{ id: "A", context: "W", name: "Dinner A", date: "2026-08-01", upcoming: false }],
    persons: [{ id: "person", name: "Registry name", anchors: [], merged: [], sighted_at: at, state: "active" }],
    entries: [],
  };
}
function append(world: World, value: Omit<Entry, "id" | "cursor" | "at" | "context" | "actor"> & Partial<Pick<Entry, "context">>): Entry {
  const entry = { id: `e-${world.entries.length}`, cursor: world.entries.length, at, context: "W", actor: { kind: "app" as const, ref: "test" }, ...value };
  world.entries.push(entry);
  return entry;
}
const identity = { platform: "luma", accountId: "owner", eventId: "a" };
function listing(world: World, rows: string[], selected = true, viewId = "dinners"): Entry {
  const payload = { ...identity, name: "Dinner A", date: "2026-08-01", url: "https://luma.com/a", evidence: ["artifact:a"], gathering: "A", viewId, viewName: "Our dinner people", selected, discoveryComplete: true };
  const selection = append(world, { type: "listing", subtype: "people-source", about: "A", payload: { ...payload, operation: "selection", readState: "unread", rowCount: 0, rowEntryIds: [] } });
  return rows.length === 0 ? selection : append(world, { type: "listing", subtype: "people-source", about: "A", payload: { ...payload, operation: "read", readState: "read", rowCount: rows.length, rowEntryIds: rows } });
}
function imported(world: World, name = "Observed name", overrides: Partial<Entry> = {}): Entry {
  return append(world, { type: "imported", subtype: "guest", about: "A", persons: ["person"], source: "luma-people-source", payload: { peopleSource: identity, rowId: "registration-a", name, anchors: [], identity: "unresolved", version: 1, evidence: ["artifact:a/row:registration-a"] }, ...overrides });
}
const prospectSource = { platform: "linkedin", sourceId: "search-1", label: "LinkedIn search: Bay Area climate founders", accountId: "operator", url: "https://linkedin.com/search/results/people/?keywords=climate" };
function prospect(world: World, name = "Prospect name", overrides: Partial<Entry> = {}): Entry {
  if (!world.persons.some(person => person.id === "prospect")) world.persons.push({ id: "prospect", name, anchors: [], merged: [], sighted_at: at, state: "active" });
  return append(world, {
    type: "fact", subtype: "sighting", persons: ["prospect"], source: "linkedin-people-prospect",
    evidence: "artifact:linkedin/row:1", confidence: "open", epistemics: "stated",
    payload: { peopleProspect: {
      viewId: "dinners", requestId: "request-1", source: prospectSource, rowId: "row-1", name,
      anchors: [{ kind: "email", value: "prospect@example.test", verified: true, evidence: "artifact:linkedin/row:1" }],
      identity: "verified", version: 1, evidence: ["artifact:linkedin/row:1"],
      reason: { text: "Leads climate partnerships.", evidence: ["artifact:linkedin/row:1"], epistemics: "inferred", confidence: "open" },
    } },
    ...overrides,
  });
}

describe("people projection", () => {
  it("does not lend mutable identity adjudication evidence out of the journal", () => {
    const world = fixture();
    const observed = imported(world);
    observed.payload.anchors = [{ kind: "email", value: "a@example.test", verified: true, evidence: "artifact:a", adjudication: { rationale: "Observed account identity", evidence: ["artifact:a"] } }];
    listing(world, [observed.id]);
    const projected = projectPeopleView(world, "W", "dinners")!;
    projected.people[0].anchors[0].adjudication!.evidence.push("not-source-evidence");
    expect(projectPeopleView(world, "W", "dinners")!.people[0].anchors[0].adjudication!.evidence).toEqual(["artifact:a"]);
  });

  it("applies only committed World-local identity aliases, including later chains", () => {
    const world = fixture();
    const observed = imported(world);
    const read = listing(world, [observed.id]);
    const merge = append(world, { type: "merged", subtype: "people-identity", persons: ["survivor"], payload: { fromPersonIds: ["person"], how: "anchor", anchor: { kind: "email", value: "a@example.test" } } });
    expect(peopleAliases(world, "W").size).toBe(0);
    const committed = append(world, { type: "listing", subtype: "people-source", payload: { ...read.payload, identityMergeIds: [merge.id] } });
    expect(projectPeopleView(world, "W", "dinners")!.people[0].personId).toBe("survivor");
    expect(projectPeopleView(world, "W", "dinners", merge.cursor)!.people[0].personId).toBe("person");
    expect(peopleAliases(world, "X").size).toBe(0);
    const next = append(world, { type: "merged", subtype: "people-identity", persons: ["canonical"], payload: { fromPersonIds: ["survivor"], how: "anchor", anchor: { kind: "email", value: "a@example.test" } } });
    append(world, { type: "listing", subtype: "people-source", payload: { ...read.payload, identityMergeIds: [merge.id, next.id] } });
    expect(resolvePeopleId(peopleAliases(world, "W"), "person")).toBe("canonical");
    expect(resolvePeopleId(peopleAliases(world, "W", committed.cursor), "person")).toBe("survivor");
    expect(world.entries.find(entry => entry.id === observed.id)!.persons).toEqual(["person"]);
  });

  it("ignores inferred attendance and legacy import rows as source membership", () => {
    const world = fixture();
    listing(world, []);
    append(world, { type: "fact", subtype: "attendance", persons: ["person"], about: "A", confidence: "open", epistemics: "inferred", payload: { attended: true } });
    append(world, { type: "imported", subtype: "guest", persons: ["person"], about: "A", source: "fixture-import", payload: { row: 1, guest: "a" } });
    expect(projectPeopleView(world, "W", "dinners")?.people).toEqual([]);
  });

  it("shows only row versions named by the committed source at the requested cursor", () => {
    const world = fixture();
    const selected = listing(world, []);
    const observed = imported(world);
    expect(projectPeopleView(world, "W", "dinners")?.coverage.read).toBe(0);
    expect(projectPeopleView(world, "W", "dinners")?.people).toEqual([]);
    const committed = listing(world, [observed.id]);
    const changed = imported(world, "Corrected name", { supersedes: observed.id });
    expect(projectPeopleView(world, "W", "dinners")?.people[0].name).toBe("Observed name");
    listing(world, [changed.id]);
    expect(projectPeopleView(world, "W", "dinners")?.people[0].name).toBe("Corrected name");
    expect(projectPeopleView(world, "W", "dinners", selected.cursor)?.people).toEqual([]);
    expect(projectPeopleView(world, "W", "dinners", committed.cursor)?.people[0].name).toBe("Observed name");
    expect(projectPeopleView(world, "W", "dinners", -1)).toBeUndefined();
  });

  it("does not depend on any future event and never reads foreign rows", () => {
    const world = fixture();
    const observed = imported(world);
    const foreign = imported(world, "Foreign", { context: "X" });
    listing(world, [observed.id, foreign.id]);
    const original = projectPeopleView(world, "W", "dinners");
    expect(original?.people).toHaveLength(1);
    expect(original?.sources[0].rowCount).toBe(1);
    for (let number = 1; number <= 2; number++) {
      world.gatherings.push({ id: `future-${number}`, context: "W", name: "Future", date: at, upcoming: true });
      expect(projectPeopleView(world, "W", "dinners")).toEqual(original);
    }
  });

  it("uses exact selected scope and does not expose a system World", () => {
    const world = fixture();
    const observed = imported(world);
    listing(world, [observed.id]);
    expect(projectPeopleViews(world)).toHaveLength(1);
    listing(world, [observed.id], false);
    expect(projectPeopleView(world, "W", "dinners")?.people).toEqual([]);
    expect(projectPeopleView(world, "W", "dinners")?.coverage.complete).toBe(false);
    world.contexts[0].apps_never_read = true;
    expect(projectPeopleViews(world)).toEqual([]);
  });

  it("keeps title, discovery and selection separate from a later source read", () => {
    const world = fixture();
    const observed = imported(world);
    const originalRead = listing(world, [observed.id]);
    const scope = world.entries.find((entry) => entry.payload.operation === "selection")!;
    append(world, { type: "listing", subtype: "people-source", about: "A", payload: { ...scope.payload, viewName: "Renamed people", discoveryComplete: false } });
    append(world, { type: "listing", subtype: "people-source", about: "A", payload: { ...originalRead.payload, viewName: "Stale title", discoveryComplete: true } });
    expect(projectPeopleView(world, "W", "dinners")).toMatchObject({ name: "Renamed people", coverage: { discoveryComplete: false } });
    append(world, { type: "listing", subtype: "people-source", about: "A", payload: { ...scope.payload, selected: false } });
    append(world, { type: "listing", subtype: "people-source", about: "A", payload: { ...originalRead.payload, selected: true } });
    expect(projectPeopleView(world, "W", "dinners")?.people).toEqual([]);
    expect(projectPeopleView(world, "W", "dinners")?.coverage.selected).toBe(0);
  });

  it("projects current source-backed prospect findings without historical membership or coverage inflation", () => {
    const world = fixture();
    listing(world, []);
    const observed = prospect(world);
    const projected = projectPeopleView(world, "W", "dinners")!;
    expect(projected.coverage).toMatchObject({ selected: 1, unread: 1, read: 0 });
    expect(projected.sources[0].rowCount).toBe(0);
    expect(projected.people).toHaveLength(1);
    expect(projected.people[0]).toMatchObject({ personId: "prospect", name: "Prospect name", identity: "verified", sourceCount: 0, memberships: [] });
    expect(projected.people[0].prospects).toEqual([expect.objectContaining({
      observationEntryId: observed.id, reasonEntryId: observed.id,
      sourceId: prospectSource.sourceId,
      sourceKey: peopleProspectSourceId(prospectSource),
      platform: "linkedin",
      sourceRowId: "row-1",
      name: "Prospect name",
      reason: expect.objectContaining({ epistemics: "inferred", confidence: "open" }),
      evidence: ["artifact:linkedin/row:1"],
    })]);
  });

  it("keeps prospect findings view-scoped while using the latest World source row for identity authority", () => {
    const world = fixture();
    listing(world, [], true, "dinners");
    listing(world, [], true, "sibling");
    const first = prospect(world, "First view prospect");
    const second = prospect(world, "Sibling withdrawal", {
      supersedes: first.id,
      payload: { peopleProspect: { ...(first.payload.peopleProspect as object), viewId: "sibling", requestId: "request-2", name: "Sibling withdrawal", anchors: [], identity: "unresolved", version: 2, reason: { text: "Only a list mention remains.", evidence: ["artifact:linkedin/row:1"], epistemics: "inferred", confidence: "open" } } },
    });
    for (const [viewId, reasonEntryId, reasonText] of [["dinners", first.id, "Leads climate partnerships."], ["sibling", second.id, "Only a list mention remains."]]) {
      const person = projectPeopleView(world, "W", viewId)!.people[0];
      expect(person).toMatchObject({ name: "Sibling withdrawal", identity: "unresolved", anchors: [] });
      expect(person.prospects[0]).toMatchObject({ observationEntryId: second.id, reasonEntryId, version: 2, reason: { text: reasonText } });
    }
  });

  it("activates identity aliases only when a committed prospect finding references the merge", () => {
    const world = fixture();
    listing(world, []);
    const observed = imported(world);
    listing(world, [observed.id]);
    const finding = prospect(world);
    const merge = append(world, { type: "merged", subtype: "people-identity", persons: ["person"], payload: { fromPersonIds: ["prospect"], how: "anchor", anchor: { kind: "email", value: "prospect@example.test", verified: true, evidence: "artifact:linkedin/row:1" }, anchors: [{ kind: "email", value: "prospect@example.test", verified: true, evidence: "artifact:linkedin/row:1" }], peopleSource: prospectSource, rationale: "Same verified contact", evidence: ["artifact:linkedin/row:1"] } });
    expect(projectPeopleView(world, "W", "dinners")!.people.map(person => person.personId).sort()).toEqual(["person", "prospect"]);
    append(world, { type: "fact", subtype: "sighting", persons: ["person"], source: "linkedin-people-prospect", evidence: "artifact:linkedin/row:1", confidence: "open", epistemics: "stated", payload: { peopleProspect: { ...(finding.payload.peopleProspect as object), requestId: "request-2", version: 2, identityMergeIds: [merge.id] } }, supersedes: finding.id });
    expect(resolvePeopleId(peopleAliases(world, "W"), "prospect")).toBe("person");
    expect(projectPeopleView(world, "W", "dinners")!.people).toHaveLength(1);
  });
});
