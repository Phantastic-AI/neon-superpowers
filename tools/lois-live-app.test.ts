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
import { closeThenResetLiveAppState, resetLiveAppVault } from "./lois-live-app.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  root: string;
  vaultDir: string;
  vaultArchiveDir: string;
  browserRoot: string;
} {
  const root = mkdtempSync(resolve(tmpdir(), "lois-live-app-test-"));
  roots.push(root);
  const vaultDir = resolve(root, "vault");
  const vaultArchiveDir = resolve(root, "vault-archives");
  const browserRoot = resolve(root, "browser");

  mkdirSync(resolve(vaultDir, "_source"), { recursive: true });
  writeFileSync(resolve(vaultDir, "stream.jsonl"), '{"seq":1,"kind":"old"}\n', "utf8");
  writeFileSync(resolve(vaultDir, "persons.json"), '[{"id":"person-1"}]\n', "utf8");
  writeFileSync(resolve(vaultDir, "contexts.json"), '[{"id":"world-1"}]\n', "utf8");
  writeFileSync(resolve(vaultDir, "gatherings.json"), '[{"id":"3cs"}]\n', "utf8");
  writeFileSync(resolve(vaultDir, "_source", "roster.json"), '{"source":"luma"}\n', "utf8");

  mkdirSync(resolve(browserRoot, "profile"), { recursive: true });
  writeFileSync(resolve(browserRoot, "profile", "Cookies"), "signed-in", "utf8");

  return { root, vaultDir, vaultArchiveDir, browserRoot };
}

describe("live app state", () => {
  it("archives the prior vault and preserves the signed-in rehearsal browser", async () => {
    const paths = fixture();

    const prepared = await closeThenResetLiveAppState(
      { vaultDir: paths.vaultDir, vaultArchiveDir: paths.vaultArchiveDir, resetId: "live-20260830" },
      {
        close: async () => "browser closed",
        profilePids: () => [],
      },
    );

    expect(prepared.browserClose).toBe("browser closed");
    expect(readFileSync(resolve(paths.vaultDir, "stream.jsonl"), "utf8")).toBe("");
    for (const file of ["persons.json", "contexts.json", "gatherings.json"]) {
      expect(JSON.parse(readFileSync(resolve(paths.vaultDir, file), "utf8"))).toEqual([]);
    }
    expect(readFileSync(resolve(prepared.reset.vaultArchive!, "_source", "roster.json"), "utf8"))
      .toContain("luma");
    expect(readFileSync(resolve(paths.browserRoot, "profile", "Cookies"), "utf8"))
      .toBe("signed-in");
  });

  it("refuses an archive collision without changing either state surface", () => {
    const paths = fixture();
    mkdirSync(resolve(paths.vaultArchiveDir, "live-taken"), { recursive: true });

    expect(() => resetLiveAppVault({
      vaultDir: paths.vaultDir,
      vaultArchiveDir: paths.vaultArchiveDir,
      resetId: "live-taken",
    })).toThrow(/already exists/i);

    expect(readFileSync(resolve(paths.vaultDir, "stream.jsonl"), "utf8")).toContain('"old"');
    expect(readFileSync(resolve(paths.browserRoot, "profile", "Cookies"), "utf8"))
      .toBe("signed-in");
  });

  it("leaves the vault untouched while the exact rehearsal profile is still live", async () => {
    const paths = fixture();

    await expect(closeThenResetLiveAppState(
      { vaultDir: paths.vaultDir, vaultArchiveDir: paths.vaultArchiveDir, resetId: "live-browser-open" },
      {
        close: async () => "close attempted",
        profilePids: () => [8123],
      },
    )).rejects.toThrow(/still owns the profile/i);

    expect(readFileSync(resolve(paths.vaultDir, "stream.jsonl"), "utf8")).toContain('"old"');
    expect(existsSync(resolve(paths.vaultArchiveDir, "live-browser-open"))).toBe(false);
    expect(readFileSync(resolve(paths.browserRoot, "profile", "Cookies"), "utf8"))
      .toBe("signed-in");
  });
});
