#!/usr/bin/env -S npx tsx
// Seed-world generator — CP1 day-0.5 work (superpowers/docs/seed-world.md).
//
// One command, deterministic, offline, <10s:
//   npx tsx generate.ts
//   pnpm seed
//
// Inputs: WORLD_SEED (int, default 20260915), WORLD_EPOCH (timestamp,
// default 2026-09-15T09:00:00-07:00). Same inputs -> byte-identical output
// (rebuild contract #2). Writes ONLY under tools/seed-world/out/ — this
// script computes that path from its own location, never from cwd, so it
// can never be aimed at anything else (rebuild contract #4).

import { mkdirSync, writeFileSync, rmSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorld } from "./lib/world.js";
import { resolveSeed, resolveEpoch } from "./lib/time.js";

const start = Date.now();

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "out");
const TMP_DIR = join(HERE, ".out.building");

// Refuse to run anywhere but the designated demo vault directory.
if (!OUT_DIR.endsWith(join("seed-world", "out"))) {
  throw new Error(`Refusing to write outside the seed-world demo vault: ${OUT_DIR}`);
}

const seed = resolveSeed(process.env);
const epoch = resolveEpoch(process.env);

const world = buildWorld(seed, epoch);

// --- write atomically: build into a temp dir, then swap it in ---
rmSync(TMP_DIR, { recursive: true, force: true });
mkdirSync(join(TMP_DIR, "entries"), { recursive: true });
mkdirSync(join(TMP_DIR, "platform"), { recursive: true });

function writeJson(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}
function writeJsonl(path: string, rows: unknown[]) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
}

writeJson(join(TMP_DIR, "contexts.json"), world.contexts);
writeJson(join(TMP_DIR, "gatherings.json"), world.gatherings);
writeJson(join(TMP_DIR, "persons.json"), world.persons);
writeJson(join(TMP_DIR, "grants.json"), world.grants);
writeJson(join(TMP_DIR, "voice-samples.json"), world.voiceSamples);
writeJson(join(TMP_DIR, "profiles.json"), world.profiles);
writeJson(
  join(TMP_DIR, "manifest.json"),
  {
    seed: world.seed,
    epoch: world.epoch,
    counts: {
      contexts: world.contexts.length,
      persons: world.persons.length,
      grants: world.grants.length,
      entries: world.entries.length,
    },
  },
);

// The full Stream, cursor-ordered — the ground truth.
writeJsonl(join(TMP_DIR, "stream.jsonl"), world.entries);

// Per-context split, for convenience (derived from the same array — never a
// second source of truth).
for (const ctx of world.contexts) {
  const rows = world.entries.filter((e) => e.context === ctx.id);
  writeJsonl(join(TMP_DIR, "entries", `${ctx.id}.jsonl`), rows);
}

// Layer A — platform-shaped fixtures.
for (const fixture of world.platform) {
  writeJson(join(TMP_DIR, "platform", `${fixture.platform}.json`), fixture);
}

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
renameSync(TMP_DIR, OUT_DIR);

const elapsedMs = Date.now() - start;
console.log(
  `seed-world: wrote ${world.entries.length} entries, ${world.persons.length} persons, ` +
    `${world.contexts.length} contexts, ${world.grants.length} grants -> ${OUT_DIR} (${elapsedMs}ms)`,
);
