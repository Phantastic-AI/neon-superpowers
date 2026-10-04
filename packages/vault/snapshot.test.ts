import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openVault, registerContext, registerGathering, registerPerson } from "./store.js";
import { createVaultSnapshot, listVaultSnapshots, restoreVaultSnapshot, VAULT_FILES, verifyVaultSnapshot } from "./snapshot.js";

let root: string;
let source: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vault-snapshot-test-"));
  source = join(root, "live");
  const vault = openVault(source);
  registerContext(vault, { id: "3cs", name: "3Cs", kind: "social", anchor: "email", created_at: "2026-09-01T00:00:00Z" });
  registerGathering(vault, { id: "dinner-1", context: "3cs", name: "Dinner", date: "2026-09-01T00:00:00Z", upcoming: false });
  registerPerson(vault, { id: "person-1", name: "Example", anchors: [], merged: [], sighted_at: "2026-09-01T00:00:00Z", state: "active" });
  appendFileSync(join(source, "stream.jsonl"), JSON.stringify({ id: "entry-1", cursor: 0, type: "context", context: "3cs", at: "2026-09-01T00:00:00Z", actor: { kind: "human", ref: "operator" }, payload: {} }) + "\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("vault snapshots", () => {
  it("round-trips exact product bytes and preserves an old checkpoint after later writes", () => {
    const original = Object.fromEntries(VAULT_FILES.map((file) => [file, readFileSync(join(source, file))]));
    const snapshot = createVaultSnapshot(source, "before-invites");
    expect(snapshot.directory).toBe(join(`${source}.snapshots`, "before-invites"));
    expect(snapshot.manifest.counts).toEqual({ entries: 1, persons: 1, contexts: 1, gatherings: 1 });
    expect(snapshot.manifest.sourceVault).toBe(source);
    expect(snapshot.manifest.version).toBe(1);
    for (const file of VAULT_FILES) {
      expect(readFileSync(join(source, file))).toEqual(original[file]);
      expect(snapshot.manifest.files[file]).toEqual({ bytes: original[file].length, sha256: createHash("sha256").update(original[file]).digest("hex") });
    }
    appendFileSync(join(source, "stream.jsonl"), JSON.stringify({ id: "entry-2", cursor: 1, type: "landed", context: "3cs", payload: { receipt: "real-send" } }) + "\n");
    const restored = restoreVaultSnapshot(snapshot.directory, join(root, "replay"));
    for (const file of VAULT_FILES) expect(readFileSync(join(restored.directory, file))).toEqual(original[file]);
    expect(openVault(restored.directory).entries).toHaveLength(1);
    expect(openVault(source).entries).toHaveLength(2);
    expect(verifyVaultSnapshot(snapshot.directory)).toEqual(snapshot);
  });

  it("copies no execution, browser, download, or credential state and records restore provenance", () => {
    for (const file of ["run-trace.jsonl", "diver-job.json", ".env", "download.csv"]) writeFileSync(join(source, file), "do not replay");
    mkdirSync(join(source, "browser"));
    writeFileSync(join(source, "browser", "Cookies"), "private");
    const snapshot = createVaultSnapshot(source, "checkpoint");
    expect(readdirSync(snapshot.directory).sort()).toEqual([...VAULT_FILES, "manifest.json"].sort());
    const restored = restoreVaultSnapshot(snapshot.directory, join(root, "replay"));
    expect(readdirSync(restored.directory).sort()).toEqual([...VAULT_FILES, "snapshot-restore.json"].sort());
    const marker = JSON.parse(readFileSync(join(restored.directory, "snapshot-restore.json"), "utf8"));
    expect(marker).toMatchObject({ version: 1, snapshotDirectory: snapshot.directory, sourceVault: source, originalSourceVault: source });
    expect(Number.isNaN(Date.parse(marker.restoredAt))).toBe(false);
  });

  it("retains the original source across checkpoints of restored copies", () => {
    const first = createVaultSnapshot(source, "first");
    const firstCopy = restoreVaultSnapshot(first.directory, join(root, "first-copy"));
    const second = createVaultSnapshot(firstCopy.directory, "second");
    expect(second.manifest.sourceVault).toBe(firstCopy.directory);
    expect(second.manifest.originalSourceVault).toBe(source);
    const finalCopy = restoreVaultSnapshot(second.directory, join(root, "final-copy"));
    const marker = JSON.parse(readFileSync(join(finalCopy.directory, "snapshot-restore.json"), "utf8"));
    expect(marker.originalSourceVault).toBe(source);
    expect(marker.sourceVault).toBe(firstCopy.directory);
  });

  it("does not turn malformed restore provenance into a new original source", () => {
    writeFileSync(join(source, "snapshot-restore.json"), "{}");
    expect(() => createVaultSnapshot(source, "bad-provenance")).toThrow(/provenance/i);
    expect(existsSync(join(`${source}.snapshots`, "bad-provenance"))).toBe(false);
  });

  it("creates private snapshot and restored files", () => {
    const snapshot = createVaultSnapshot(source, "private");
    const restored = restoreVaultSnapshot(snapshot.directory, join(root, "replay"));
    for (const directory of [`${source}.snapshots`, snapshot.directory, restored.directory]) {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      if (directory === `${source}.snapshots`) continue;
      for (const file of readdirSync(directory)) expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
    }
  });

  it("lists complete verified named checkpoints without creating an absent root", () => {
    const snapshots = join(root, "checkpoints");
    expect(listVaultSnapshots(snapshots)).toEqual([]);
    expect(existsSync(snapshots)).toBe(false);
    const first = createVaultSnapshot(source, "one", snapshots);
    const second = createVaultSnapshot(source, "two", snapshots);
    mkdirSync(join(snapshots, "interrupted"));
    expect(listVaultSnapshots(snapshots)).toEqual([first, second]);
  });

  it("never replaces an existing checkpoint or restore destination, including an empty directory", () => {
    const snapshot = createVaultSnapshot(source, "keep");
    expect(() => createVaultSnapshot(source, "keep")).toThrow(/exist/i);
    const destination = join(root, "empty");
    mkdirSync(destination);
    expect(() => restoreVaultSnapshot(snapshot.directory, destination)).toThrow(/exist/i);
    expect(readdirSync(destination)).toEqual([]);
    expect(() => restoreVaultSnapshot(snapshot.directory, source)).toThrow(/exist/i);
    expect(verifyVaultSnapshot(snapshot.directory)).toEqual(snapshot);
  });

  it.each(["", " ", ".", "..", "../escape", "/absolute", "nested/name", "nested\\name", "bad\0name"])("rejects unsafe checkpoint name %j", (name) => {
    expect(() => createVaultSnapshot(source, name)).toThrow(/name/i);
    expect(existsSync(`${source}.snapshots`)).toBe(false);
  });

  it("refuses missing source files without silently creating them", () => {
    rmSync(join(source, "persons.json"));
    expect(() => createVaultSnapshot(source, "broken")).toThrow();
    expect(existsSync(join(source, "persons.json"))).toBe(false);
    expect(existsSync(join(`${source}.snapshots`, "broken"))).toBe(false);
  });

  it("refuses corrupt source cursors without publishing", () => {
    writeFileSync(join(source, "stream.jsonl"), '{"id":"broken","cursor":3}\n');
    expect(() => createVaultSnapshot(source, "broken")).toThrow(/cursor/i);
    expect(existsSync(join(`${source}.snapshots`, "broken"))).toBe(false);
  });

  it("detects missing and modified checkpoint files without repairing them", () => {
    const snapshot = createVaultSnapshot(source, "good");
    writeFileSync(join(snapshot.directory, "persons.json"), "[]\n");
    expect(() => verifyVaultSnapshot(snapshot.directory)).toThrow(/integrity|hash|bytes/i);
    expect(() => restoreVaultSnapshot(snapshot.directory, join(root, "bad-copy"))).toThrow();
    expect(existsSync(join(root, "bad-copy"))).toBe(false);
    rmSync(join(snapshot.directory, "contexts.json"));
    expect(() => verifyVaultSnapshot(snapshot.directory)).toThrow();
    expect(existsSync(join(snapshot.directory, "contexts.json"))).toBe(false);
  });

  it("checks manifest counts and rejects unsupported or malformed manifests", () => {
    const snapshot = createVaultSnapshot(source, "good");
    const path = join(snapshot.directory, "manifest.json");
    writeFileSync(path, JSON.stringify({ ...snapshot.manifest, counts: { ...snapshot.manifest.counts, entries: 7 } }));
    expect(() => verifyVaultSnapshot(snapshot.directory)).toThrow(/count/i);
    for (const manifest of [{ ...snapshot.manifest, version: 2 }, { ...snapshot.manifest, files: {} }, null]) {
      writeFileSync(path, JSON.stringify(manifest));
      expect(() => verifyVaultSnapshot(snapshot.directory)).toThrow(/manifest/i);
    }
  });

  it("rejects symlink source files, snapshot roots, and restore destinations", () => {
    const snapshot = createVaultSnapshot(source, "good");
    const destination = join(root, "linked-destination");
    symlinkSync(source, destination, "dir");
    expect(() => restoreVaultSnapshot(snapshot.directory, destination)).toThrow();
    const linkedRoot = join(root, "linked-snapshots");
    symlinkSync(`${source}.snapshots`, linkedRoot, "dir");
    expect(() => createVaultSnapshot(source, "bad", linkedRoot)).toThrow(/symlink|directory/i);
    rmSync(join(source, "persons.json"));
    symlinkSync(join(snapshot.directory, "persons.json"), join(source, "persons.json"));
    expect(() => createVaultSnapshot(source, "bad")).toThrow(/regular|symlink/i);
    expect(openVault(snapshot.directory).persons).toHaveLength(1);
  });
});
