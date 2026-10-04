import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeThenResetColdAppState, resetColdAppState } from "./lois-cold-app.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  root: string;
  vaultDir: string;
  vaultArchiveDir: string;
  browserStateDir: string;
  browserArchiveDir: string;
} {
  const root = mkdtempSync(resolve(tmpdir(), "lois-cold-app-test-"));
  roots.push(root);
  const vaultDir = resolve(root, "vaults", "hacker-garage");
  const vaultArchiveDir = resolve(root, "vaults", "_cold-archives");
  const browserStateDir = resolve(root, "Application Support", "Superpowers");
  const browserArchiveDir = resolve(root, "Application Support", "Superpowers Cold Archives");

  mkdirSync(resolve(vaultDir, "_source"), { recursive: true });
  writeFileSync(resolve(vaultDir, "stream.jsonl"), '{"seq":1,"kind":"old"}\n', "utf8");
  writeFileSync(resolve(vaultDir, "persons.json"), '[{"id":"person-1"}]\n', "utf8");
  writeFileSync(resolve(vaultDir, "contexts.json"), '[{"id":"world-1"}]\n', "utf8");
  writeFileSync(resolve(vaultDir, "gatherings.json"), '[{"id":"3cs"}]\n', "utf8");
  writeFileSync(resolve(vaultDir, "run-trace.jsonl"), '{"label":"old turn"}\n', "utf8");
  writeFileSync(resolve(vaultDir, "voice-calibration.json"), '[{"lesson":"old"}]\n', "utf8");
  writeFileSync(resolve(vaultDir, "_source", "roster.json"), '{"source":"luma"}\n', "utf8");

  mkdirSync(resolve(browserStateDir, "profiles", "hacker-garage"), { recursive: true });
  mkdirSync(resolve(browserStateDir, "captures"), { recursive: true });
  writeFileSync(resolve(browserStateDir, "profiles", "hacker-garage", "Cookies"), "signed-in", "utf8");
  writeFileSync(resolve(browserStateDir, "captures", "old.png"), "evidence", "utf8");

  return { root, vaultDir, vaultArchiveDir, browserStateDir, browserArchiveDir };
}

describe("cold app state", () => {
  it("archives every active vault and browser artifact before creating an empty vault", () => {
    const paths = fixture();

    const reset = resetColdAppState({ ...paths, resetId: "cold-20260829" });

    expect(readFileSync(resolve(paths.vaultDir, "stream.jsonl"), "utf8")).toBe("");
    for (const file of ["persons.json", "contexts.json", "gatherings.json"]) {
      expect(JSON.parse(readFileSync(resolve(paths.vaultDir, file), "utf8"))).toEqual([]);
    }
    for (const old of ["run-trace.jsonl", "voice-calibration.json", "_source"]) {
      expect(existsSync(resolve(paths.vaultDir, old))).toBe(false);
    }
    expect(readFileSync(resolve(reset.vaultArchive!, "run-trace.jsonl"), "utf8")).toContain("old turn");
    expect(readFileSync(resolve(reset.vaultArchive!, "_source", "roster.json"), "utf8")).toContain("luma");

    expect(existsSync(paths.browserStateDir)).toBe(false);
    expect(readFileSync(resolve(reset.browserArchive!, "profiles", "hacker-garage", "Cookies"), "utf8"))
      .toBe("signed-in");
    expect(readFileSync(resolve(reset.browserArchive!, "captures", "old.png"), "utf8")).toBe("evidence");
  });

  it("refuses an archive collision without changing the active state", () => {
    const paths = fixture();
    mkdirSync(resolve(paths.vaultArchiveDir, "cold-taken"), { recursive: true });

    expect(() => resetColdAppState({ ...paths, resetId: "cold-taken" })).toThrow(/already exists/i);

    expect(readFileSync(resolve(paths.vaultDir, "stream.jsonl"), "utf8")).toContain('"old"');
    expect(readFileSync(resolve(paths.browserStateDir, "profiles", "hacker-garage", "Cookies"), "utf8"))
      .toBe("signed-in");
  });

  it("leaves active state untouched when the exact browser profile still has a live process", async () => {
    const paths = fixture();

    await expect(closeThenResetColdAppState(
      { ...paths, resetId: "cold-browser-live" },
      {
        close: async () => "close attempted",
        profilePids: () => [8123],
      },
    )).rejects.toThrow(/still owns the profile/i);

    expect(readFileSync(resolve(paths.vaultDir, "stream.jsonl"), "utf8")).toContain('"old"');
    expect(readFileSync(resolve(paths.browserStateDir, "profiles", "hacker-garage", "Cookies"), "utf8"))
      .toBe("signed-in");
  });
});
