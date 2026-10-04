import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { __loisDiveTest, createDiveHands } from "./lois-dive.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(resolve(tmpdir(), "lois-artifact-text-test-"));
  roots.push(root);
  const captureDir = resolve(root, "captures");
  const downloads = resolve(captureDir, "downloads");
  mkdirSync(downloads, { recursive: true });
  __loisDiveTest.bindOwnedDownloadJob(downloads, "job-one", 100);
  __loisDiveTest.beginOwnedDownloadAttempt(downloads, "https://example.com/event/people?private=yes", 200);
  const hands = createDiveHands({ workspace: {
    profileDir: resolve(root, "profile"), captureDir, portFile: resolve(root, "port"),
    defaultStartUrl: null, allowedStartOrigin: null, requireExplicitStartUrl: false,
  } });
  return { root, downloads, hands };
}

async function capture(downloads: string, content: string | Buffer) {
  await __loisDiveTest.captureOwnedDownload({
    suggestedFilename: () => "opaque-download", failure: async () => null,
    saveAs: async (path: string) => { writeFileSync(path, content); },
  }, downloads, "https://example.com/event/people?private=yes", 300);
  return __loisDiveTest.listOwnedDownloadArtifacts(downloads).artifacts[0]!;
}

function captureObservation(downloads: string, observationId = "obs-9876541") {
  return __loisDiveTest.captureOwnedSemanticObservation(downloads, {
    observationId,
    sourceUrl: "https://example.com/profile",
    text: `Observation ${observationId}\nPage: Ada\nURL: https://example.com/profile\nSemantic view: 1/1 signal lines\n- heading "Ada" [ref=e1]`,
  }, 350);
}

describe("host-owned artifact text bridge", () => {
  it("keeps the ownership epoch stable when the same active job is rebound", () => {
    const { downloads } = workspace();
    const ownerPath = resolve(downloads, ".download-state", "owner.json");
    __loisDiveTest.bindOwnedDownloadJob(downloads, "job-one", 200);
    expect(JSON.parse(readFileSync(ownerPath, "utf8"))).toEqual({ jobId: "job-one", setAt: 100 });
    __loisDiveTest.bindOwnedDownloadJob(downloads, "job-two", 300);
    expect(JSON.parse(readFileSync(ownerPath, "utf8"))).toEqual({ jobId: "job-two", setAt: 300 });
  });

  it("retains immutable job-owned semantic observations across recreated hands", async () => {
    const { root, downloads, hands } = workspace();
    const artifact = captureObservation(downloads);
    const expectedHash = createHash("sha256").update(`Observation obs-9876541\nPage: Ada\nURL: https://example.com/profile\nSemantic view: 1/1 signal lines\n- heading "Ada" [ref=e1]`).digest("hex");

    await expect(hands.dive_read_observation("obs-9876541")).resolves.toMatchObject({ ok: true, artifact: {
      artifactId: artifact.artifactId,
      observationId: "obs-9876541",
      kind: "semantic_observation",
      jobId: "job-one",
      sourceUrl: "https://example.com/profile",
      capturedAt: 350,
      sha256: expectedHash,
    } });
    const recreated = createDiveHands({ workspace: {
      profileDir: resolve(root, "profile"), captureDir: resolve(root, "captures"), portFile: resolve(root, "port"),
      defaultStartUrl: null, allowedStartOrigin: null, requireExplicitStartUrl: false,
    } });
    await expect(recreated.dive_read_observation("obs-9876541")).resolves.toMatchObject({ ok: true });
    await expect(recreated.dive_read_observation("obs-unknown")).resolves.toMatchObject({ ok: false });
    __loisDiveTest.bindOwnedDownloadJob(downloads, "job-two", 500);
    await expect(recreated.dive_read_observation("obs-9876541")).resolves.toMatchObject({ ok: false });
    __loisDiveTest.bindOwnedDownloadJob(downloads, null, 600);
    await expect(recreated.dive_read_observation("obs-9876541")).resolves.toMatchObject({ ok: false });
  });

  it("stores sanitized observation bytes privately without becoming a download receipt", () => {
    const { downloads } = workspace();
    const artifact = captureObservation(downloads);
    const index = readFileSync(resolve(downloads, ".download-state", "index.jsonl"), "utf8");
    expect(index).not.toMatch(/private|pageToken|navigationEpoch|controlEpoch|control value/);
    expect(statSync(artifact.path).mode & 0o777).toBe(0o600);
    expect(__loisDiveTest.readLatestOwnedDownload(downloads)).not.toContain("Observation obs-9876541");
    expect(__loisDiveTest.listOwnedDownloadArtifacts(downloads)).toMatchObject({ artifacts: [], total: 0 });
  });

  it("rejects tampered or symlink-substituted retained observations", async () => {
    const { root, downloads, hands } = workspace();
    const tampered = captureObservation(downloads, "obs-9876541");
    writeFileSync(tampered.path, "changed after capture", { mode: 0o600 });
    await expect(hands.dive_read_observation("obs-9876541")).resolves.toMatchObject({ ok: false, note: expect.stringMatching(/changed|digest|hash|tamper/i) });

    const linked = captureObservation(downloads, "obs-9876542");
    const outside = resolve(root, "outside-observation");
    writeFileSync(outside, readFileSync(linked.path));
    rmSync(linked.path);
    symlinkSync(outside, linked.path);
    await expect(hands.dive_read_observation("obs-9876542")).resolves.toMatchObject({ ok: false });
  });

  it("reads all captured text with provenance and digest, never a filesystem path", async () => {
    const { downloads, hands } = workspace();
    const text = `Name,Email\n${"Ada,a@example.com\n".repeat(2_000)}`;
    const artifact = await capture(downloads, text);
    const result = await hands.dive_read_artifact_text({ artifactId: artifact.artifactId });
    expect(result).toMatchObject({ ok: true, text, artifact: {
      artifactId: artifact.artifactId, jobId: "job-one", sourceUrl: "https://example.com/event/people",
      sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text),
    } });
    if (result.ok) expect(result.artifact).not.toHaveProperty("path");
    expect(JSON.stringify(result)).not.toContain("private=yes");
  });

  it("reads an exact older artifact after a new attempt, but never another job or fallback", async () => {
    const { downloads, hands } = workspace();
    const artifact = await capture(downloads, "Name\nAda\n");
    __loisDiveTest.beginOwnedDownloadAttempt(downloads, "https://example.com/next", 400);
    expect(await hands.dive_read_artifact_text({ artifactId: artifact.artifactId })).toMatchObject({ ok: true });
    expect(await hands.dive_read_artifact_text({ artifactId: "unknown" })).toMatchObject({ ok: false });
    expect(await hands.dive_read_artifact_text({ artifactId: "" })).toMatchObject({ ok: false });
    __loisDiveTest.bindOwnedDownloadJob(downloads, "job-two", 500);
    expect(await hands.dive_read_artifact_text({ artifactId: artifact.artifactId })).toMatchObject({ ok: false });
  });

  it.each([
    [Buffer.from([0x61, 0, 0x62]), /binary/i],
    [Buffer.from([0xc3, 0x28]), /readable text/i],
    [Buffer.alloc(1_000_001, "a"), /too large/i],
  ])("rejects unreadable or oversized content", async (content, note) => {
    const { downloads, hands } = workspace();
    const artifact = await capture(downloads, content);
    expect(await hands.dive_read_artifact_text({ artifactId: artifact.artifactId })).toMatchObject({ ok: false, note: expect.stringMatching(note) });
  });

  it("does not follow a captured filename replaced by a symlink", async () => {
    const { root, downloads, hands } = workspace();
    const artifact = await capture(downloads, "Name\nAda\n");
    const path = resolve(downloads, artifact.filename);
    const outside = resolve(root, "not-a-download");
    writeFileSync(outside, "not owned text");
    rmSync(path);
    symlinkSync(outside, path);
    expect(await hands.dive_read_artifact_text({ artifactId: artifact.artifactId })).toMatchObject({ ok: false });
    expect(__loisDiveTest.readLatestOwnedDownload(downloads, { artifactId: artifact.artifactId })).not.toContain("not owned text");
  });

  it("requires a bound job for host imports, without changing legacy prose reads", async () => {
    const { downloads, hands } = workspace();
    const artifact = await capture(downloads, "Name\nAda\n");
    __loisDiveTest.bindOwnedDownloadJob(downloads, null, 400);
    expect(await hands.dive_read_artifact_text({ artifactId: artifact.artifactId })).toMatchObject({ ok: false });
    expect(__loisDiveTest.readLatestOwnedDownload(downloads, { artifactId: artifact.artifactId })).toContain("Ada");
  });

  it("rejects a substituted FIFO without waiting for a writer", async () => {
    const { root, downloads } = workspace();
    const artifact = await capture(downloads, "Name\nAda\n");
    const path = resolve(downloads, artifact.filename);
    rmSync(path);
    execFileSync("mkfifo", [path]);
    const config = { profileDir: resolve(root, "profile"), captureDir: resolve(root, "captures"), portFile: resolve(root, "port"), defaultStartUrl: null, allowedStartOrigin: null, requireExplicitStartUrl: false };
    // Bound the test process too: a regression must fail, never hang the suite.
    const script = `import { createDiveHands } from ${JSON.stringify(pathToFileURL(resolve("tools/lois-dive.ts")).href)};
      const result = await createDiveHands({workspace:${JSON.stringify(config)}}).dive_read_artifact_text(${JSON.stringify({ artifactId: artifact.artifactId })});
      process.stdout.write(JSON.stringify(result));`;
    const result = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { encoding: "utf8", timeout: 2_000 });
    expect(JSON.parse(result)).toMatchObject({ ok: false, note: expect.stringContaining("regular file") });
  });
});
