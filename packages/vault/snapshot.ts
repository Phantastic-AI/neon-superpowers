// A checkpoint is the four-file product database, not a browser/session backup.
// Capture is synchronous: call inside the owning vault process (or while it is
// stopped). Like store.ts, this does not coordinate independent writer processes.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { openVault } from "./store.js";

export const VAULT_FILES = ["stream.jsonl", "persons.json", "contexts.json", "gatherings.json"] as const;
type VaultFile = (typeof VAULT_FILES)[number];
type VaultBytes = Record<VaultFile, Buffer>;
const COUNT_KEYS = ["entries", "persons", "contexts", "gatherings"] as const;

export interface SnapshotManifest {
  version: 1;
  name: string;
  createdAt: string;
  sourceVault: string;
  /** Preserved when checkpointing a restored copy; later sends reconcile here. */
  originalSourceVault?: string;
  files: Record<VaultFile, { sha256: string; bytes: number }>;
  counts: Record<(typeof COUNT_KEYS)[number], number>;
}
export interface SnapshotInfo {
  directory: string;
  manifest: SnapshotManifest;
}

function assertName(name: string): void {
  if (typeof name !== "string" || !name.trim() || name === "." || name === ".." || basename(name) !== name || name.includes("\\") || name.includes("\0")) {
    throw new Error("snapshot: name must be a single non-empty filename");
  }
}

function optionalStat(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`snapshot: expected a regular directory, not a symlink: ${directory}`);
}

function readRegularFile(path: string): Buffer {
  if (!lstatSync(path).isFile()) throw new Error(`snapshot: expected a regular file, not a symlink: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`snapshot: expected a regular file: ${path}`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function readVaultBytes(directory: string): VaultBytes {
  assertDirectory(directory);
  return Object.fromEntries(VAULT_FILES.map((file) => [file, readRegularFile(join(directory, file))])) as VaultBytes;
}

function writePrivate(path: string, bytes: string | Buffer): void {
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
}

function inspectBytes(bytes: VaultBytes): SnapshotManifest["counts"] {
  // openVault can create missing files. Only ever give it our complete private
  // staging copy, never the original vault or a checkpoint being verified.
  const staging = mkdtempSync(join(tmpdir(), "lois-vault-checkpoint-"));
  try {
    for (const file of VAULT_FILES) writePrivate(join(staging, file), bytes[file]);
    const vault = openVault(staging);
    return { entries: vault.entries.length, persons: vault.persons.length, contexts: vault.contexts.length, gatherings: vault.gatherings.length };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function restoreOrigin(directory: string): string | undefined {
  const path = join(directory, "snapshot-restore.json");
  if (!optionalStat(path)) return undefined;
  let value: unknown;
  try { value = JSON.parse(readRegularFile(path).toString("utf8")); }
  catch (error) { throw new Error("snapshot: cannot read restore provenance", { cause: error }); }
  if (!record(value) || value.version !== 1 || typeof value.sourceVault !== "string" || !isAbsolute(value.sourceVault)
    || typeof value.snapshotDirectory !== "string" || !isAbsolute(value.snapshotDirectory)
    || typeof value.restoredAt !== "string" || Number.isNaN(Date.parse(value.restoredAt))
    || (value.originalSourceVault !== undefined && (typeof value.originalSourceVault !== "string" || !isAbsolute(value.originalSourceVault)))) {
    throw new Error("snapshot: invalid restore provenance");
  }
  return (value.originalSourceVault ?? value.sourceVault) as string;
}

function readManifest(directory: string): SnapshotManifest {
  let value: unknown;
  try { value = JSON.parse(readRegularFile(join(directory, "manifest.json")).toString("utf8")); }
  catch (error) { throw new Error("snapshot: cannot read manifest.json", { cause: error }); }
  if (!record(value) || value.version !== 1 || typeof value.name !== "string"
    || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))
    || typeof value.sourceVault !== "string" || !isAbsolute(value.sourceVault)
    || (value.originalSourceVault !== undefined && (typeof value.originalSourceVault !== "string" || !isAbsolute(value.originalSourceVault)))
    || !record(value.files) || Object.keys(value.files).length !== VAULT_FILES.length || !record(value.counts)) {
    throw new Error("snapshot: invalid or unsupported manifest");
  }
  assertName(value.name);
  for (const file of VAULT_FILES) {
    const digest = value.files[file];
    if (!record(digest) || typeof digest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(digest.sha256)
      || !Number.isSafeInteger(digest.bytes) || (digest.bytes as number) < 0) throw new Error(`snapshot: invalid manifest file record: ${file}`);
  }
  for (const key of COUNT_KEYS) {
    if (!Number.isSafeInteger(value.counts[key]) || (value.counts[key] as number) < 0) throw new Error(`snapshot: invalid manifest count: ${key}`);
  }
  return value as unknown as SnapshotManifest;
}

function readVerified(directory: string): { manifest: SnapshotManifest; bytes: VaultBytes } {
  assertDirectory(directory);
  const manifest = readManifest(directory);
  const bytes = readVaultBytes(directory);
  for (const file of VAULT_FILES) {
    if (manifest.files[file].bytes !== bytes[file].length || manifest.files[file].sha256 !== hash(bytes[file])) {
      throw new Error(`snapshot: integrity check failed for ${file}`);
    }
  }
  const counts = inspectBytes(bytes);
  for (const key of COUNT_KEYS) {
    if (counts[key] !== manifest.counts[key]) throw new Error(`snapshot: manifest count differs for ${key}`);
  }
  return { manifest, bytes };
}

function publishNew(directory: string, write: () => void): void {
  // Exclusive mkdir, not rename: POSIX rename may replace an existing empty
  // directory. On interruption a partial directory remains, never an overwritten
  // checkpoint. A snapshot is complete only when its final manifest exists.
  mkdirSync(directory, { mode: 0o700 });
  try { write(); }
  catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function createVaultSnapshot(vaultDir: string, name: string, snapshotRoot = `${resolve(vaultDir)}.snapshots`): SnapshotInfo {
  assertName(name);
  const sourceVault = resolve(vaultDir);
  const root = resolve(snapshotRoot);
  const directory = join(root, name);
  const bytes = readVaultBytes(sourceVault);
  const originalSourceVault = restoreOrigin(sourceVault);
  const counts = inspectBytes(bytes);
  const manifest: SnapshotManifest = {
    version: 1, name, createdAt: new Date().toISOString(), sourceVault,
    ...(originalSourceVault ? { originalSourceVault } : {}),
    files: Object.fromEntries(VAULT_FILES.map((file) => [file, { sha256: hash(bytes[file]), bytes: bytes[file].length }])) as SnapshotManifest["files"],
    counts,
  };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertDirectory(root);
  publishNew(directory, () => {
    for (const file of VAULT_FILES) writePrivate(join(directory, file), bytes[file]);
    writePrivate(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  });
  return { directory, manifest };
}

export function verifyVaultSnapshot(snapshotDir: string): SnapshotInfo {
  const directory = resolve(snapshotDir);
  return { directory, manifest: readVerified(directory).manifest };
}

export function listVaultSnapshots(snapshotRoot: string): SnapshotInfo[] {
  const root = resolve(snapshotRoot);
  if (!optionalStat(root)) return [];
  assertDirectory(root);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && optionalStat(join(root, entry.name, "manifest.json")))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => verifyVaultSnapshot(join(root, entry.name)));
}

export function restoreVaultSnapshot(snapshotDir: string, destination: string): SnapshotInfo {
  const snapshotDirectory = resolve(snapshotDir);
  const directory = resolve(destination);
  const { manifest, bytes } = readVerified(snapshotDirectory);
  publishNew(directory, () => {
    // Provenance comes first: even an interrupted restore must never look like
    // an ordinary live vault that forgot the original's later send receipts.
    writePrivate(join(directory, "snapshot-restore.json"), JSON.stringify({
      version: 1, snapshotDirectory, sourceVault: manifest.sourceVault, restoredAt: new Date().toISOString(),
      originalSourceVault: manifest.originalSourceVault ?? manifest.sourceVault,
    }, null, 2) + "\n");
    for (const file of VAULT_FILES) writePrivate(join(directory, file), bytes[file]);
  });
  return { directory, manifest };
}
