// tools/lois-calibration — the node-side store for drafted-vs-sent rewrite pairs
// (D-111). "we rewrite the drafts and it just learns."
//
// The pairs live next to the vault they belong to
// (apps/face/vaults/<vault>/voice-calibration.json), gitignored like the rest of
// the vault (they are derived from the organizer's real sends). The face never
// touches this file; only the node agent path loads it and passes the pairs in,
// which keeps voice.ts browser-safe. The learning is real and persistent: a pair
// written here informs every future run for its (world x channel x context) key.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { recordRewrite, type CalibrationPair } from "../packages/lois/voice.js";

function storePath(vaultDir: string): string {
  return resolve(vaultDir, "voice-calibration.json");
}

/** Load the calibration pairs for a vault, or [] if none recorded yet. */
export function loadCalibration(vaultDir: string): CalibrationPair[] {
  const path = storePath(vaultDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? (parsed as CalibrationPair[]) : [];
  } catch {
    return [];
  }
}

/**
 * Record one drafted->sent rewrite and persist it. Returns the full updated
 * list. A no-op rewrite (sent === drafted, or empty sent) is not stored — there
 * is nothing to learn from a draft that was sent unchanged.
 */
export function appendCalibration(vaultDir: string, pair: CalibrationPair): CalibrationPair[] {
  const updated = recordRewrite(loadCalibration(vaultDir), pair);
  writeFileSync(storePath(vaultDir), JSON.stringify(updated, null, 2) + "\n", "utf8");
  return updated;
}
