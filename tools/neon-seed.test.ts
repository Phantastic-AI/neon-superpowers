import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openVault } from "../packages/vault/store.js";
import { loadWorld } from "../packages/vault/world.js";
import { readPeopleWorkspace, savePeopleNote } from "../packages/vault/people-edits.js";
import { projectPeopleViews } from "./projections/people.js";
import { seedNeonDemo } from "./neon-seed.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function target() { const root = mkdtempSync(join(tmpdir(), "neon-seed-test-")); roots.push(root); return join(root, "vault"); }
function bytes(dir: string) { return Object.fromEntries(readdirSync(dir).map(file => [file, readFileSync(join(dir, file), "utf8")])); }

it("creates two actual synthetic people workspaces with retained source memberships", () => {
  const dir = target();
  expect(seedNeonDemo(dir)).toMatchObject({ created: true, synthetic: true });
  const world = loadWorld(openVault(dir));
  const views = projectPeopleViews(world);
  expect(views).toHaveLength(2);
  expect(views.map(view => view.people.length)).toEqual([6, 4]);
  for (const view of views) {
    expect(view.contextName).toContain("Synthetic");
    expect(view.name).toContain("Synthetic");
    expect(view.coverage).toMatchObject({ selected: 2, read: 2, complete: true });
    expect(view.people.every(person => person.memberships.length > 0)).toBe(true);
    expect(view.sources.every(source => source.name.includes("Synthetic") && new URL(source.url).hostname === "example.test")).toBe(true);
    expect(readPeopleWorkspace(world, view.contextId, view.viewId)?.order).toHaveLength(view.people.length);
  }
  expect(views.flatMap(view => view.people.flatMap(person => person.memberships))).toHaveLength(13);
  expect(views.flatMap(view => view.people.flatMap(person => person.anchors)).every(anchor => anchor.kind === "email" && anchor.value.endsWith("@example.test"))).toBe(true);
  expect(world.gatherings.every(gathering => !gathering.upcoming)).toBe(true);
});

it("reuses its owned vault without replacing organizer edits or appending seed entries", () => {
  const dir = target(); seedNeonDemo(dir);
  const vault = openVault(dir), view = projectPeopleViews(loadWorld(vault))[0];
  savePeopleNote(vault, { contextId: view.contextId, viewId: view.viewId, requestId: "synthetic-note-edit", noteId: "synthetic-note", personId: view.people[0].personId, text: "Synthetic note kept across setup runs.", state: "draft", baseRevision: 0 });
  const before = bytes(dir);
  expect(seedNeonDemo(dir)).toMatchObject({ created: false, synthetic: true });
  expect(bytes(dir)).toEqual(before);
  expect(readPeopleWorkspace(loadWorld(openVault(dir)), view.contextId, view.viewId)?.notes[0].text).toBe("Synthetic note kept across setup runs.");
});

it("refuses an existing unowned destination without touching its files", () => {
  const dir = target(); mkdirSync(dir); writeFileSync(join(dir, "keep.txt"), "existing local data");
  const before = bytes(dir);
  expect(() => seedNeonDemo(dir)).toThrow(/existing.*unowned/i);
  expect(bytes(dir)).toEqual(before);
});
