// Synthetic local Post-it workspace, using the same vault/import APIs as
// lois-people-smoke. Run: pnpm seed:neon
// Then start the service with NEON_VAULT_DIRECTORY=.local/demo-vault.
// Existing owned demos are read without reseeding; other destinations refuse.
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { openVault, registerContext } from "../packages/vault/store.js";
import { loadWorld } from "../packages/vault/world.js";
import { selectPeopleSources, importPeopleSource } from "../packages/organs/people.js";
import { projectPeopleViews, type PeopleSourceRow } from "./projections/people.js";

export const NEON_DEMO_VAULT_DIRECTORY = resolve(import.meta.dirname, "..", ".local", "demo-vault");
const markerFile = "neon-demo-vault.json";
const seedId = "neon-superpowers-synthetic-v1";
const files = ["stream.jsonl", "persons.json", "contexts.json", "gatherings.json"];
const at = "2026-09-01T12:00:00Z";
const actor = { kind: "app" as const, ref: "neon-synthetic-seed" };
const fixtures = [
  { id: "synthetic-dinners", name: "Synthetic dinner circle", view: "Synthetic past dinner lists", kind: "social" as const,
    lists: [["Avery", "Sam", "Taylor", "Riley"], ["Avery", "Riley", "Jordan", "Casey"]] },
  { id: "synthetic-reading", name: "Synthetic reading circle", view: "Synthetic past reading lists", kind: "professional" as const,
    lists: [["Morgan", "Quinn", "Jamie"], ["Morgan", "Rowan"]] },
];

function summary(vaultDir: string, created: boolean) {
  const views = projectPeopleViews(loadWorld(openVault(vaultDir)));
  return { vaultDir, created, synthetic: true as const, worlds: views.map(view => ({
    contextId: view.contextId, name: view.contextName, viewId: view.viewId, viewName: view.name,
    people: view.people.length, sources: view.sources.length,
    memberships: view.people.reduce((total, person) => total + person.memberships.length, 0), coverage: view.coverage,
  })) };
}

export function seedNeonDemo(directory = NEON_DEMO_VAULT_DIRECTORY) {
  const vaultDir = resolve(directory);
  if (existsSync(vaultDir)) {
    if (!lstatSync(vaultDir).isDirectory() || lstatSync(vaultDir).isSymbolicLink()) throw new Error("Existing unowned demo destination refused");
    const marker = join(vaultDir, markerFile);
    if (!existsSync(marker) || !lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink()) throw new Error("Existing unowned demo vault refused; choose a new directory");
    const owner = JSON.parse(readFileSync(marker, "utf8"));
    if (owner.seedId !== seedId || owner.synthetic !== true) throw new Error("Existing unowned demo vault refused; choose a new directory");
    // openVault creates missing files, so validate them first on the reuse path.
    if (files.some(file => !existsSync(join(vaultDir, file)) || !lstatSync(join(vaultDir, file)).isFile() || lstatSync(join(vaultDir, file)).isSymbolicLink())) throw new Error("Existing demo vault is incomplete; refusing to repair or replace it");
    return summary(vaultDir, false);
  }
  mkdirSync(dirname(vaultDir), { recursive: true });
  mkdirSync(vaultDir); // Exclusive creation: an existing destination is never overwritten.
  const vault = openVault(vaultDir);
  for (const fixture of fixtures) {
    const viewId = "synthetic-saved-people";
    registerContext(vault, { id: fixture.id, name: fixture.name, kind: fixture.kind, anchor: "email", created_at: at });
    const sources = fixture.lists.map((_, index) => ({ platform: "synthetic-fixture", accountId: "synthetic-organizer",
      eventId: `${fixture.id}-${index + 1}`, name: `${fixture.name} — Synthetic list ${index + 1}`,
      date: `2026-08-${index === 0 ? "10" : "24"}T19:00:00Z`, url: `https://example.test/synthetic/${fixture.id}/${index + 1}`,
      evidence: [`fixture:${seedId}:${fixture.id}:${index + 1}`],
    }));
    selectPeopleSources(vault, { contextId: fixture.id, viewId, viewName: fixture.view, sources, discoveryComplete: true, at, actor });
    for (const [index, names] of fixture.lists.entries()) {
      const proof = sources[index].evidence[0];
      const rows: PeopleSourceRow[] = names.map(name => ({ rowId: `synthetic-${name.toLowerCase()}`, name: `Demo ${name}`,
        anchors: [{ kind: "email", value: `synthetic-${name.toLowerCase()}@example.test`, verified: true, evidence: proof }], evidence: [proof] }));
      importPeopleSource(vault, { contextId: fixture.id, viewId, source: sources[index], rows, readState: "read", evidence: [proof], at, actor });
    }
  }
  const result = summary(vaultDir, true);
  if (result.worlds.length !== 2 || result.worlds.some(world => !world.coverage.complete || world.people < 4)) throw new Error("Synthetic seed did not produce the required saved people workspaces");
  writeFileSync(join(vaultDir, markerFile), JSON.stringify({ seedId, synthetic: true }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length > 2) throw new Error("Usage: pnpm seed:neon (writes only the dedicated local demo vault)");
  console.log(JSON.stringify(seedNeonDemo(), null, 2));
}
