#!/usr/bin/env -S npx tsx
// import-seed — replay the sealed seed world into a fresh vault.
//
//   npx tsx import-seed.ts <target-dir>
//   pnpm --filter @browser-operator/vault import-seed -- <target-dir>
//
// Every stream line goes through appendEntry — the real validator, no side
// door — so a green import PROVES the validator accepts the entire sealed
// seed world (964 entries, all 16 types). Registries import first as
// primary records (store.ts honesty note): contexts, then gatherings, then
// persons — the order their cross-references require.
//
// Refuses a non-empty target dir: the vault is append-only and an import is
// a birth, not a merge.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Entry, Person, Context, Gathering } from "../../tools/seed-world/types.js";
import { openVault, registerContext, registerGathering, registerPerson, type Vault } from "./store.js";
import { appendEntry } from "./append.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SEED_OUT = join(HERE, "..", "..", "tools", "seed-world", "out");

export interface ImportResult {
  vault: Vault;
  contexts: number;
  gatherings: number;
  persons: number;
  entries: number;
}

export function importSeed(targetDir: string, seedOutDir: string = DEFAULT_SEED_OUT): ImportResult {
  if (!existsSync(seedOutDir)) throw new Error(`import-seed: no seed world at ${seedOutDir} — run tools/seed-world/generate.ts first`);
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0)
    throw new Error(`import-seed: refusing non-empty target dir ${targetDir} — the vault is append-only; import only into a fresh dir`);

  const readJson = <T>(name: string): T => JSON.parse(readFileSync(join(seedOutDir, name), "utf8")) as T;

  const vault = openVault(targetDir);
  for (const c of readJson<Context[]>("contexts.json")) registerContext(vault, c);
  for (const g of readJson<Gathering[]>("gatherings.json")) registerGathering(vault, g);
  for (const p of readJson<Person[]>("persons.json")) registerPerson(vault, p);

  const lines = readFileSync(join(seedOutDir, "stream.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  let entries = 0;
  for (const line of lines) {
    // The parsed line carries its seed id and cursor; appendEntry preserves
    // the id and rejects any cursor that disagrees with the stream's own
    // count — so a completed replay is order-exact by construction.
    appendEntry(vault, JSON.parse(line) as Entry);
    entries += 1;
  }
  return { vault, contexts: vault.contexts.length, gatherings: vault.gatherings.length, persons: vault.persons.length, entries };
}

// --- CLI ---
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: npx tsx import-seed.ts <target-dir> [seed-out-dir]");
    process.exit(1);
  }
  const start = Date.now();
  const result = importSeed(resolve(target), process.argv[3] ? resolve(process.argv[3]) : DEFAULT_SEED_OUT);
  console.log(
    `import-seed: replayed ${result.entries} entries (all via appendEntry), ` +
      `${result.persons} persons, ${result.contexts} contexts, ${result.gatherings} gatherings -> ${resolve(target)} (${Date.now() - start}ms)`,
  );
}
