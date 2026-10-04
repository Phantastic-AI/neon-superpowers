#!/usr/bin/env -S npx tsx
// lois-learn-demo — prove the voice learns from rewrites, on the evented system
// (D-111, D-112, D-113). "we rewrite the drafts and it just learns."
//
//   npx tsx tools/lois-learn-demo.ts
//
// Three acts:
//   1. Lois drafts with NO rewrites learned (deslop floor alone).
//   2. We record ONE drafted->sent rewrite — standing in for the organizer's
//      real edit (the SENT line is SYNTHETIC; the learning loop is real).
//   3. Lois drafts again; the calibration pair now informs the voice. Nothing
//      else changed.
//
// The pair goes to a SCRATCH dir, not the real vault, so the demo is repeatable.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLois } from "../packages/lois/system.js";
import type { VoiceKey } from "../packages/lois/voice.js";
import { resolveLoisModel } from "./lois-env.js";
import { loadCalibration, appendCalibration } from "./lois-calibration.js";
import type { Context, Entry, Gathering, Person, World } from "./projections/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT_DIR = resolve(HERE, "..", "apps", "face", "vaults", "hacker-garage");
const SCRATCH = resolve(HERE, "..", ".scratch-calibration");
const MESSAGE = "fill Monday's 3Cs dinner by re-inviting the regulars";

function loadWorld(dir: string): World {
  const read = (f: string) => readFileSync(resolve(dir, f), "utf8");
  return {
    entries: read("stream.jsonl").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Entry),
    persons: JSON.parse(read("persons.json")) as Person[],
    contexts: JSON.parse(read("contexts.json")) as Context[],
    gatherings: JSON.parse(read("gatherings.json")) as Gathering[],
  };
}

async function draftOnce(world: World): Promise<string> {
  const model = resolveLoisModel();
  if (!model) throw new Error("no model in .env — the demo needs the real brain (D-113: nothing is mimed)");
  const lois = createLois({ world, model, calibration: loadCalibration(SCRATCH) });
  const r = await lois.tell(MESSAGE);
  if (!r.ok) throw new Error(r.why);
  const draft = r.output!.proposals.find((p) => p.kind === "draft");
  return typeof draft?.body === "string" ? (draft.body as string) : "(no draft proposed this turn)";
}

async function main(): Promise<void> {
  if (existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });

  const world = loadWorld(VAULT_DIR);
  const upcoming = world.gatherings.find((g) => g.upcoming);
  if (!upcoming) throw new Error("no upcoming gathering");
  const key: VoiceKey = { context: upcoming.context, channel: "email", purpose: "invite" };

  console.log("Lois voice-learning demo — Hacker Garage, (world x email x invite)\n");

  const d1 = await draftOnce(world);
  console.log("ACT 1 — Lois drafts (deslop floor, no rewrites learned):");
  console.log(indent(d1), "\n");

  const sent = "SE, 3Cs is back Monday. Same table, come hungry. Want you there. Reply yes and the seat is yours.";
  appendCalibration(SCRATCH, { key, drafted: d1, sent, lesson: "tighter, punchier, one line; keep 'come hungry'" });
  console.log("ACT 2 — the organizer rewrites and sends this (SYNTHETIC, stands in for a real edit):");
  console.log(indent(sent), "\n");

  const d2 = await draftOnce(world);
  console.log("ACT 3 — Lois drafts AGAIN, having learned that one rewrite:");
  console.log(indent(d2), "\n");

  console.log("The only thing that changed between Act 1 and Act 3 is the one rewrite.");
  rmSync(SCRATCH, { recursive: true, force: true });
}

function indent(s: string): string {
  return s.split("\n").map((l) => "    " + l).join("\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
