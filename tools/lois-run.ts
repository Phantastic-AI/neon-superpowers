#!/usr/bin/env -S npx tsx
// lois-run — one turn of the evented Lois metasystem over his REAL Hacker
// Garage vault (D-111, D-113).
//
//   npx tsx tools/lois-run.ts ["what the organizer says"]
//
// What happens: the message lands as a `heard` event on the bus; the pump wakes
// the mouth (one GLM call, full mind-output), her proposals wake the critic
// (deslop cold-read) and the gate (D-086 hold); the whole cascade prints as the
// trace timeline. No fallback content exists: if the brain is missing or errors,
// this prints WHY and nothing else.
//
// PII: prints first names only, never an email address. The key is read
// server-side from the repo-root .env (tools/lois-env.ts) and never printed.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLois } from "../packages/lois/system.js";
import { renderTrace } from "../packages/lois/trace.js";
import { resolveLoisModel } from "./lois-env.js";
import { loadCalibration } from "./lois-calibration.js";
import type { Context, Entry, Gathering, Person, World } from "./projections/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT_DIR = resolve(HERE, "..", "apps", "face", "vaults", "hacker-garage");
const MESSAGE = process.argv[2] ?? "fill Monday's 3Cs dinner by re-inviting the regulars";

function loadWorld(dir: string): World {
  const read = (f: string): string => {
    const p = resolve(dir, f);
    if (!existsSync(p)) throw new Error(`lois-run: ${f} not found in ${dir}. Build the vault first: pnpm seed`);
    return readFileSync(p, "utf8");
  };
  return {
    entries: read("stream.jsonl").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Entry),
    persons: JSON.parse(read("persons.json")) as Person[],
    contexts: JSON.parse(read("contexts.json")) as Context[],
    gatherings: JSON.parse(read("gatherings.json")) as Gathering[],
  };
}

async function main(): Promise<void> {
  const world = loadWorld(VAULT_DIR);
  const model = resolveLoisModel();
  const calibration = loadCalibration(VAULT_DIR);

  console.log("Lois — evented metasystem, Hacker Garage vault (dry slice)");
  if (calibration.length > 0) console.log(`Voice: ${calibration.length} rewrite(s) learned for this vault.`);
  console.log("");

  const lois = createLois({ world, model, calibration });
  console.log("Roster:", lois.roster().map((a) => `${a.name} (${a.role})`).join(" · "));
  console.log("");

  const result = await lois.tell(MESSAGE);

  console.log("TRACE (the bus, as it happened):");
  console.log(renderTrace(lois.trace));
  console.log("");

  if (!result.ok) {
    console.log(`NO TURN: ${result.why}`);
    return;
  }
  const o = result.output!;
  console.log("LOIS SAYS:");
  console.log(`  ${o.say}`);
  if (o.ui.length > 0) {
    console.log("\nSTAGE (semantic UI plan):");
    for (const u of o.ui) console.log(`  ${JSON.stringify(u)}`);
  }
  if (o.proposals.length > 0) {
    console.log("\nPROPOSALS (all held at the gate, D-086):");
    for (const p of o.proposals) {
      console.log(`  [${p.kind}]${p.to ? ` to ${p.to}` : ""}${p.subject ? ` — ${p.subject}` : ""}`);
      if (typeof p.body === "string") console.log(`    ${String(p.body).split("\n").join("\n    ")}`);
      if (Array.isArray(p.steps)) for (const s of p.steps as unknown[]) console.log(`    - ${s}`);
    }
  }
  if (o.memory.length > 0) {
    console.log("\nMEMORY CLAIMS (proposed, not stored):");
    for (const m of o.memory) console.log(`  ${m.about ? `${m.about}: ` : ""}${m.claim}${m.epistemics ? ` (${m.epistemics})` : ""}`);
  }
  if (o.questions.length > 0) {
    console.log("\nSHE ASKS:");
    for (const q of o.questions) console.log(`  - ${q}`);
  }
}

export function isDirectLoisRun(metaUrl: string = import.meta.url, argv: string[] = process.argv): boolean {
  const entry = argv[1];
  return Boolean(entry) && pathToFileURL(resolve(entry)).href === metaUrl;
}

if (isDirectLoisRun()) {
  void main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
