import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { seedPeopleSmoke, qualifyPeopleEvidence } from "./lois-people-smoke.js";
import { readPeopleWorkspace } from "../packages/vault/people-edits.js";
it("starts the same partial people rehearsal with no future event or real contacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "people-rehearsal-test-"));
  try {
    const fixture = seedPeopleSmoke(dir);
    const view = readPeopleWorkspace(fixture.world, fixture.contextId, fixture.viewId)!;
    expect(view.people).toHaveLength(5);
    expect(view.coverage).toMatchObject({ selected: 3, read: 2, unread: 1, complete: false });
    expect(view.people.find(p => p.name === "Avery Okafor")?.sourceCount).toBe(2);
    expect(view.people.filter(p => p.name === "Sam Rivera")).toHaveLength(2);
    expect(fixture.world.gatherings.some(g => g.upcoming)).toBe(false);
    expect(view.notes).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("does not label a changed or dirty browser rehearsal as committed evidence", () => {
  const start = { head: "a", clean: true };
  expect(qualifyPeopleEvidence(start, start).clean).toBe(true);
  for (const finish of [{ head: "b", clean: true }, { head: "a", clean: false }]) expect(qualifyPeopleEvidence(start, finish).clean).toBe(false);
  expect(qualifyPeopleEvidence({ ...start, clean: false }, start).clean).toBe(false);
});
