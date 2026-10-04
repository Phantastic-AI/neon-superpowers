// sidecar/vault — THE one vault loader (kills the three copies that grew in
// vite.config, lois-run, and lois-learn-demo). Reads the four files the face
// bundles, from disk: his real Hacker Garage vault when built, else the seed.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Entry, Gathering, Person, World } from "../tools/projections/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

export const HG_VAULT_DIR = resolve(ROOT, "apps", "face", "vaults", "hacker-garage");
const SEED_DIR = resolve(ROOT, "tools", "seed-world", "out");

/** The active vault dir: the real HG vault when built on disk, else the seed. */
export function resolveVaultDir(): string {
  return existsSync(resolve(HG_VAULT_DIR, "stream.jsonl")) ? HG_VAULT_DIR : SEED_DIR;
}

export function loadVaultWorld(dir: string = resolveVaultDir()): World {
  const read = (f: string): string => {
    const p = resolve(dir, f);
    if (!existsSync(p)) throw new Error(`vault: ${f} not found in ${dir}. Build it first: pnpm seed`);
    return readFileSync(p, "utf8");
  };
  return {
    entries: read("stream.jsonl").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Entry),
    persons: JSON.parse(read("persons.json")) as Person[],
    contexts: JSON.parse(read("contexts.json")) as Context[],
    gatherings: JSON.parse(read("gatherings.json")) as Gathering[],
  };
}
