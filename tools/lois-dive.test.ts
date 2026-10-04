import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __loisDiveTest } from "./lois-dive.js";
import { initializeSmokeRun, type SmokeRunPaths } from "./lois-smoke-run.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function smokeRun(): SmokeRunPaths {
  const base = mkdtempSync(resolve(tmpdir(), "lois-dive-run-test-"));
  roots.push(base);
  const seed = resolve(base, "seed");
  mkdirSync(seed);
  writeFileSync(resolve(seed, "stream.jsonl"), "", "utf8");
  writeFileSync(resolve(seed, "persons.json"), "[]\n", "utf8");
  writeFileSync(resolve(seed, "contexts.json"), "[]\n", "utf8");
  writeFileSync(resolve(seed, "gatherings.json"), "[]\n", "utf8");
  return initializeSmokeRun({
    baseDir: base,
    runId: "browser-lease",
    mockUrl: "http://127.0.0.1:4319/luma",
    seedVaultDir: seed,
    product: { repo: "/repo/superpowers-app", head: "8b47a48", clean: true },
    artifactHashes: { contract: "aaa", prd: "bbb", testSpec: "ccc" },
  });
}

describe("Lois dive page focus", () => {
  it("keeps the explicitly focused real page when a later scratch page opens", () => {
    const luma = __loisDiveTest.pageRef("https://lu.ma/signin");
    const scratch = __loisDiveTest.pageRef("data:text/html,<input autofocus>");
    const state = __loisDiveTest.createPageFocusState();

    state.remember(luma);
    state.focus(luma);
    state.remember(scratch);

    expect(state.active([luma, scratch])).toBe(luma);
  });

  it("falls back to the most recently seen real page when the focused page closes", () => {
    const older = __loisDiveTest.pageRef("https://example.com/older");
    const focused = __loisDiveTest.pageRef("https://lu.ma/signin", { closed: true });
    const scratch = __loisDiveTest.pageRef("about:blank");
    const state = __loisDiveTest.createPageFocusState();

    state.remember(older);
    state.remember(focused);
    state.focus(focused);
    state.remember(scratch);

    expect(state.active([older, focused, scratch])).toBe(older);
  });
});

describe("Lois dive input ownership", () => {
  it("keeps app input locked from foreground hands until reconciliation succeeds", () => {
    const control = __loisDiveTest.createBrowserControlState("automation");

    expect(control.snapshot()).toEqual({ mode: "embedded", inputOwner: "automation" });
    expect(control.accepts("automation")).toBe(true);

    control.summon();
    expect(control.snapshot()).toEqual({ mode: "foreground_hands", inputOwner: "hands" });
    expect(control.accepts("automation")).toBe(false);
    expect(control.accepts("pane")).toBe(false);
    expect(__loisDiveTest.inputRefusal(control, "pane")).toEqual({
      ok: false,
      note: "Browser input is locked while control is foreground_hands.",
    });

    control.dismiss();
    expect(control.snapshot()).toEqual({ mode: "reconciling", inputOwner: null });
    expect(control.accepts("automation")).toBe(false);
    expect(control.accepts("pane")).toBe(false);

    expect(control.reconcile(true, "automation")).toBe(true);
    expect(control.snapshot()).toEqual({ mode: "embedded", inputOwner: "automation" });
    expect(control.accepts("automation")).toBe(true);
    expect(__loisDiveTest.inputRefusal(control, "automation")).toBeNull();
  });

  it("fails closed when reconciliation cannot verify the live lease", () => {
    const control = __loisDiveTest.createBrowserControlState("pane");

    control.summon();
    control.dismiss();

    expect(control.reconcile(false, "pane")).toBe(false);
    expect(control.snapshot()).toEqual({ mode: "blocked", inputOwner: null });
    expect(control.accepts("pane")).toBe(false);
    expect(control.accepts("automation")).toBe(false);

    expect(control.reconcile(true, "pane")).toBe(true);
    expect(control.snapshot()).toEqual({ mode: "embedded", inputOwner: "pane" });
  });

  it("returns automation control after a temporary foreground-hands round trip", () => {
    const control = __loisDiveTest.createBrowserControlState("automation");

    expect(control.summon()).toBe(true);
    expect(control.dismiss()).toBe(true);
    expect(control.reconcile(true)).toBe(true);

    expect(control.snapshot()).toEqual({ mode: "embedded", inputOwner: "automation" });
    expect(control.accepts("automation")).toBe(true);
  });

  it("lets an explicit model resume reclaim a verified embedded pane", () => {
    const control = __loisDiveTest.createBrowserControlState("pane");

    expect(control.claim("automation")).toBe(true);
    expect(control.snapshot()).toEqual({ mode: "embedded", inputOwner: "automation" });
    expect(control.accepts("automation")).toBe(true);
  });

  it("does not reclaim a foreground human window", () => {
    const control = __loisDiveTest.createBrowserControlState("pane");

    expect(control.summon()).toBe(true);
    expect(control.claim("automation")).toBe(false);
    expect(control.snapshot()).toEqual({ mode: "foreground_hands", inputOwner: "hands" });
  });

  it("hands a newly opened foreground window to the pane after dismissal", () => {
    const control = __loisDiveTest.createBrowserControlState();

    control.open("hands");
    expect(control.dismiss()).toBe(true);
    expect(control.reconcile(true)).toBe(true);

    expect(control.snapshot()).toEqual({ mode: "embedded", inputOwner: "pane" });
    expect(control.accepts("pane")).toBe(true);
  });

  it("resumes only when the human closes the browser during a foreground handoff", () => {
    expect(
      __loisDiveTest.shouldResumeAfterHumanClose({ mode: "foreground_hands", inputOwner: "hands" }),
    ).toBe(true);
    expect(__loisDiveTest.shouldResumeAfterHumanClose({ mode: "embedded", inputOwner: "automation" })).toBe(
      false,
    );
    expect(__loisDiveTest.shouldResumeAfterHumanClose({ mode: "closed", inputOwner: null })).toBe(false);
  });

  it("emits a continuation fact when foreground hands reconcile back to automation", () => {
    const run = smokeRun();
    const workspace = __loisDiveTest.createSmokeWorkspace(run);
    const events: unknown[] = [];
    const unsubscribe = __loisDiveTest.onDiveContinuation(workspace, (event) => events.push(event));

    __loisDiveTest.emitBrowserControlReturnedContinuation(workspace, {
      controlEpoch: 7,
      navigationEpoch: 11,
      url: "http://127.0.0.1:4319/event/3cs",
    });
    unsubscribe();

    expect(events).toEqual([
      expect.objectContaining({
        type: "diver.continue",
        reason: "browser_control_returned",
        key: expect.stringMatching(/^browser_control_returned:7:11:/),
        controlEpoch: 7,
        navigationEpoch: 11,
      }),
    ]);
    expect(
      __loisDiveTest.latestDiveContinuation(__loisDiveTest.createSmokeWorkspace(run)),
    ).toEqual(events[0]);
  });


  it("finishes an admitted pane action before foreground hands take ownership", async () => {
    const control = __loisDiveTest.createBrowserControlState("pane");
    const actions = __loisDiveTest.createSerialActions();
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const paneInput = actions.run(async () => {
      order.push("input:start");
      await held;
      expect(control.accepts("pane")).toBe(true);
      order.push("input:end");
    });
    const summon = actions.run(() => {
      control.summon();
      order.push("hands");
    });

    await Promise.resolve();
    expect(order).toEqual(["input:start"]);
    expect(control.snapshot()).toEqual({ mode: "embedded", inputOwner: "pane" });

    release();
    await Promise.all([paneInput, summon]);

    expect(order).toEqual(["input:start", "input:end", "hands"]);
    expect(control.snapshot()).toEqual({ mode: "foreground_hands", inputOwner: "hands" });
  });

  it("refuses input when the live lease no longer matches the displayed page", () => {
    const control = __loisDiveTest.createBrowserControlState("pane");

    expect(
      __loisDiveTest.liveInputRefusal(control, "pane", {
        workspaceOwned: true,
        leaseLive: false,
        pageUrl: "http://127.0.0.1:4319/luma",
        frameUrl: "http://127.0.0.1:4319/luma",
      }),
    ).toMatchObject({ ok: false, note: expect.stringMatching(/lease/i) });

    expect(
      __loisDiveTest.liveInputRefusal(control, "pane", {
        workspaceOwned: true,
        leaseLive: true,
        pageUrl: "http://127.0.0.1:4319/luma?v=2",
        frameUrl: "http://127.0.0.1:4319/luma?v=1",
      }),
    ).toMatchObject({ ok: false, note: expect.stringMatching(/frame/i) });
  });

  it("admits input only when owner, workspace, live lease, page, and frame agree", () => {
    const control = __loisDiveTest.createBrowserControlState("pane");

    expect(
      __loisDiveTest.liveInputRefusal(control, "pane", {
        workspaceOwned: true,
        leaseLive: true,
        pageUrl: "http://127.0.0.1:4319/luma",
        frameUrl: "http://127.0.0.1:4319/luma",
      }),
    ).toBeNull();
  });
});

describe("Lois dive screencast", () => {
  it("does not skip the only paint from a static browser page", () => {
    expect(__loisDiveTest.screencastOptions()).toMatchObject({ everyNthFrame: 1 });
  });
});

describe("Lois bounded download paths", () => {
  it("keeps server filenames inside the owned directory and avoids collisions", () => {
    const root = mkdtempSync(resolve(tmpdir(), "lois-download-path-test-"));
    roots.push(root);
    const downloads = resolve(root, "captures", "downloads");
    mkdirSync(downloads, { recursive: true });
    writeFileSync(resolve(downloads, "people.csv"), "existing", "utf8");
    writeFileSync(resolve(downloads, "people-1234.csv"), "existing", "utf8");

    expect(__loisDiveTest.downloadTargetPath(downloads, "../../people.csv", 1234)).toBe(
      resolve(downloads, "people-1234-2.csv"),
    );
    expect(__loisDiveTest.downloadTargetPath(downloads, "../new.csv", 1234)).toBe(
      resolve(downloads, "new.csv"),
    );
  });

  it("captures and reads a resumed text download even when the server gives it a strange name", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "lois-resumed-download-test-"));
    roots.push(root);
    const downloads = resolve(root, "captures", "downloads");
    let saves = 0;
    const browserDownload = {
      suggestedFilename: () => "2f07a3d9-61ef-4ae1-9bbb-983c0a7d7542",
      failure: async () => null,
      saveAs: async (path: string) => {
        saves += 1;
        writeFileSync(path, "name,email\nAda,ada@example.com\n", "utf8");
      },
    };

    __loisDiveTest.beginOwnedDownloadAttempt(downloads, "https://luma.com/people", 1200);
    const receipt = await __loisDiveTest.captureOwnedDownload(
      browserDownload,
      downloads,
      "https://luma.com/people",
      1234,
    );

    expect(receipt).toEqual({
      ok: true,
      filename: "2f07a3d9-61ef-4ae1-9bbb-983c0a7d7542",
      path: resolve(downloads, "2f07a3d9-61ef-4ae1-9bbb-983c0a7d7542"),
      bytes: 31,
      capturedAt: 1234,
    });
    expect(saves).toBe(1);
    const artifactText = __loisDiveTest.readLatestOwnedDownload(downloads);
    expect(artifactText).toMatch(
      /^Captured artifact 2f07a3d9-61ef-4ae1-9bbb-983c0a7d7542 \(31 bytes, artifact artifact_[a-f0-9]+, characters 0-31 of 31\)\./,
    );
    expect(artifactText).toContain("Contents:\nname,email\nAda,ada@example.com\n\nEnd of artifact.");
  });

  it("emits a continuation fact only after an owned download receipt is durable", async () => {
    const run = smokeRun();
    const workspace = __loisDiveTest.createSmokeWorkspace(run);
    const downloads = resolve(workspace.captureDir, "downloads");
    const events: unknown[] = [];
    const unsubscribe = __loisDiveTest.onDiveContinuation(workspace, (event) => events.push(event));
    const browserDownload = {
      suggestedFilename: () => "people.csv",
      failure: async () => null,
      saveAs: async (path: string) => {
        expect(events).toHaveLength(0);
        writeFileSync(path, "name,email\nAda,ada@example.com\n", "utf8");
      },
    };

    __loisDiveTest.beginOwnedDownloadAttempt(downloads, "http://127.0.0.1:4319/people", 1200);
    await __loisDiveTest.captureOwnedDownloadForWorkspace(
      browserDownload,
      workspace,
      "http://127.0.0.1:4319/people",
      1300,
    );
    unsubscribe();

    expect(__loisDiveTest.readLatestOwnedDownload(downloads)).toContain("Ada,ada@example.com");
    expect(events).toEqual([
      expect.objectContaining({
        type: "diver.continue",
        reason: "owned_download_captured",
        key: expect.stringMatching(/^owned_download_captured:/),
        attemptId: expect.any(String),
        artifactEpoch: 1,
      }),
    ]);
  });

  it("coalesces the immediate and passive continuation for one browser download", async () => {
    const run = smokeRun();
    const workspace = __loisDiveTest.createSmokeWorkspace(run);
    const downloads = resolve(workspace.captureDir, "downloads");
    const events: unknown[] = [];
    const unsubscribe = __loisDiveTest.onDiveContinuation(workspace, (event) => events.push(event));
    const browserDownload = {
      suggestedFilename: () => "people.csv",
      failure: async () => null,
      saveAs: async (path: string) => writeFileSync(path, "name,email\nAda,ada@example.com\n", "utf8"),
    };

    __loisDiveTest.beginOwnedDownloadAttempt(downloads, "http://127.0.0.1:4319/people", 1200);
    await Promise.all([
      __loisDiveTest.captureOwnedDownloadForWorkspace(browserDownload, workspace, "http://127.0.0.1:4319/people", 1300),
      __loisDiveTest.captureOwnedDownloadForWorkspace(browserDownload, workspace, "http://127.0.0.1:4319/people", 1300),
    ]);
    unsubscribe();

    expect(events).toHaveLength(1);
  });

  it("pages through a larger artifact instead of slurping it into one model turn", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "lois-paged-download-test-"));
    roots.push(root);
    const downloads = resolve(root, "captures", "downloads");
    const browserDownload = {
      suggestedFilename: () => "people.csv",
      failure: async () => null,
      saveAs: async (path: string) => writeFileSync(path, "0123456789".repeat(400), "utf8"),
    };

    __loisDiveTest.beginOwnedDownloadAttempt(downloads, "https://luma.com/people", 1000);
    await __loisDiveTest.captureOwnedDownload(
      browserDownload,
      downloads,
      "https://luma.com/people",
      1100,
    );

    const first = __loisDiveTest.readLatestOwnedDownload(downloads, { offset: 0, maxChars: 1_000 });
    const second = __loisDiveTest.readLatestOwnedDownload(downloads, { offset: 1_000, maxChars: 1_000 });

    expect(first).toMatch(/characters 0-1000 of 4000/);
    expect(first).toMatch(/More remains; read again from offset 1000/);
    expect(second).toMatch(/characters 1000-2000 of 4000/);
    expect(second).not.toContain("characters 0-1000");
  });

  it("coalesces the persistent catcher and immediate tool receipt for the same browser download", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "lois-download-coalesce-test-"));
    roots.push(root);
    const downloads = resolve(root, "captures", "downloads");
    let saves = 0;
    const browserDownload = {
      suggestedFilename: () => "people.csv",
      failure: async () => null,
      saveAs: async (path: string) => {
        saves += 1;
        writeFileSync(path, "name,email\nAda,ada@example.com\n", "utf8");
      },
    };

    await Promise.all([
      __loisDiveTest.captureOwnedDownload(browserDownload, downloads, "https://luma.com/people", 1234),
      __loisDiveTest.captureOwnedDownload(browserDownload, downloads, "https://luma.com/people", 1234),
    ]);

    expect(saves).toBe(1);
  });

  it("does not mistake an older captured CSV for the current download attempt", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "lois-download-attempt-test-"));
    roots.push(root);
    const downloads = resolve(root, "captures", "downloads");
    const makeDownload = (filename: string, name: string) => ({
      suggestedFilename: () => filename,
      failure: async () => null,
      saveAs: async (path: string) => writeFileSync(path, `name,email\n${name},${name.toLowerCase()}@example.com\n`, "utf8"),
    });

    __loisDiveTest.beginOwnedDownloadAttempt(downloads, "https://luma.com/people", 1000);
    await __loisDiveTest.captureOwnedDownload(
      makeDownload("old.csv", "Old"),
      downloads,
      "https://luma.com/people",
      1100,
    );
    __loisDiveTest.beginOwnedDownloadAttempt(downloads, "https://luma.com/people", 2000);

    expect(__loisDiveTest.readLatestOwnedDownload(downloads)).toMatch(/No captured download yet/);

    await __loisDiveTest.captureOwnedDownload(
      makeDownload("new.csv", "New"),
      downloads,
      "https://luma.com/people",
      2100,
    );
    expect(__loisDiveTest.readLatestOwnedDownload(downloads)).toContain("New,new@example.com");
  });

  it("keeps older owned artifacts readable after latest/current freshness moves on", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "lois-download-history-test-"));
    roots.push(root);
    const downloads = resolve(root, "captures", "downloads");
    const makeDownload = (filename: string, name: string) => ({
      suggestedFilename: () => filename,
      failure: async () => null,
      saveAs: async (path: string) => writeFileSync(path, `name,email\n${name},${name.toLowerCase()}@example.com\n`, "utf8"),
    });

    __loisDiveTest.bindOwnedDownloadJob(downloads, "job-series-history", 900);
    const firstAttempt = __loisDiveTest.beginOwnedDownloadAttempt(downloads, "https://luma.com/people?token=secret", 1000);
    await __loisDiveTest.captureOwnedDownload(
      makeDownload("first.csv", "First"),
      downloads,
      "https://luma.com/people?token=secret",
      1100,
    );
    expect(existsSync(resolve(downloads, ".download-state", "index.jsonl"))).toBe(true);
    const firstArtifacts = __loisDiveTest.listOwnedDownloadArtifacts(downloads);
    expect(firstArtifacts.artifacts).toHaveLength(1);
    expect(firstArtifacts.total).toBe(1);
    expect(firstArtifacts.artifacts[0]).toMatchObject({
      schemaVersion: 1,
      jobId: "job-series-history",
      attemptId: firstAttempt.id,
      kind: "download",
      filename: "first.csv",
      bytes: 35,
      sourceUrl: "https://luma.com/people",
      freshness: { attemptId: firstAttempt.id, attemptStartedAt: 1000 },
    });
    const firstArtifactId = firstArtifacts.artifacts[0].artifactId;

    __loisDiveTest.beginOwnedDownloadAttempt(downloads, "https://luma.com/people", 2000);

    expect(__loisDiveTest.readLatestOwnedDownload(downloads)).toMatch(/No captured download yet/);
    expect(__loisDiveTest.readLatestOwnedDownload(downloads, { artifactId: firstArtifactId })).toContain(
      "First,first@example.com",
    );
    expect(__loisDiveTest.listOwnedDownloadArtifacts(downloads).artifacts.map((artifact) => artifact.artifactId)).toEqual([
      firstArtifactId,
    ]);
  });

  it("lists multiple captured artifacts newest-first with an opaque cursor", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "lois-download-list-test-"));
    roots.push(root);
    const downloads = resolve(root, "captures", "downloads");
    const makeDownload = (filename: string, name: string) => ({
      suggestedFilename: () => filename,
      failure: async () => null,
      saveAs: async (path: string) => writeFileSync(path, `name,email\n${name},${name.toLowerCase()}@example.com\n`, "utf8"),
    });

    __loisDiveTest.bindOwnedDownloadJob(downloads, "job-series-history", 900);
    __loisDiveTest.beginOwnedDownloadAttempt(downloads, "https://luma.com/people", 1000);
    await __loisDiveTest.captureOwnedDownload(makeDownload("first.csv", "First"), downloads, "https://luma.com/people", 1100);
    await __loisDiveTest.captureOwnedDownload(makeDownload("second.csv", "Second"), downloads, "https://luma.com/people", 1200);

    const firstPage = __loisDiveTest.listOwnedDownloadArtifacts(downloads, { limit: 1 });
    expect(firstPage.artifacts.map((artifact) => artifact.filename)).toEqual(["second.csv"]);
    expect(firstPage.total).toBe(2);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = __loisDiveTest.listOwnedDownloadArtifacts(downloads, { cursor: firstPage.nextCursor, limit: 1 });
    expect(secondPage.artifacts.map((artifact) => artifact.filename)).toEqual(["first.csv"]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("keeps one diver job from claiming another job's owned artifacts", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "lois-download-job-scope-test-"));
    roots.push(root);
    const downloads = resolve(root, "captures", "downloads");
    const makeDownload = (filename: string, name: string) => ({
      suggestedFilename: () => filename,
      failure: async () => null,
      saveAs: async (path: string) => writeFileSync(path, `name,email\n${name},${name.toLowerCase()}@example.com\n`, "utf8"),
    });

    __loisDiveTest.bindOwnedDownloadJob(downloads, "job-one", 900);
    __loisDiveTest.beginOwnedDownloadAttempt(downloads, "https://luma.com/people", 1000);
    await __loisDiveTest.captureOwnedDownload(makeDownload("one.csv", "One"), downloads, "https://luma.com/people", 1100);
    const firstId = __loisDiveTest.listOwnedDownloadArtifacts(downloads).artifacts[0].artifactId;

    __loisDiveTest.bindOwnedDownloadJob(downloads, "job-two", 1200);
    __loisDiveTest.beginOwnedDownloadAttempt(downloads, "https://luma.com/people", 1300);
    await __loisDiveTest.captureOwnedDownload(makeDownload("two.csv", "Two"), downloads, "https://luma.com/people", 1400);

    expect(__loisDiveTest.listOwnedDownloadArtifacts(downloads).artifacts.map((artifact) => artifact.filename)).toEqual([
      "two.csv",
    ]);
    expect(__loisDiveTest.listOwnedDownloadArtifacts(downloads, {}, "job-one").artifacts.map((artifact) => artifact.filename)).toEqual([
      "one.csv",
    ]);
    expect(__loisDiveTest.readLatestOwnedDownload(downloads, { artifactId: firstId })).toMatch(
      /No captured download yet/,
    );
  });

  it("keeps a current attempt across a legitimate confirmation redirect", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "lois-download-redirect-test-"));
    roots.push(root);
    const downloads = resolve(root, "captures", "downloads");
    const browserDownload = {
      suggestedFilename: () => "people.csv",
      failure: async () => null,
      saveAs: async (path: string) => writeFileSync(path, "name,email\nAda,ada@example.com\n", "utf8"),
    };

    __loisDiveTest.beginOwnedDownloadAttempt(downloads, "https://luma.com/people", 1000);
    await __loisDiveTest.captureOwnedDownload(
      browserDownload,
      downloads,
      "https://luma.com/confirm-access",
      1100,
    );

    expect(__loisDiveTest.readLatestOwnedDownload(downloads)).toContain("Ada,ada@example.com");
  });

  it("keeps receipt metadata separate from even a hostile-looking server filename", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "lois-download-receipt-test-"));
    roots.push(root);
    const downloads = resolve(root, "captures", "downloads");
    const browserDownload = {
      suggestedFilename: () => ".latest-download.json",
      failure: async () => null,
      saveAs: async (path: string) => writeFileSync(path, "name,email\nAda,ada@example.com\n", "utf8"),
    };

    __loisDiveTest.beginOwnedDownloadAttempt(downloads, "https://luma.com/people", 1000);
    await __loisDiveTest.captureOwnedDownload(
      browserDownload,
      downloads,
      "https://luma.com/people",
      1100,
    );

    expect(__loisDiveTest.readLatestOwnedDownload(downloads)).toContain("Ada,ada@example.com");
  });
});

describe("Lois smoke dive workspace", () => {
  it("derives every mutable browser path from the run envelope", () => {
    const run = smokeRun();
    const workspace = __loisDiveTest.createSmokeWorkspace(run);

    expect(workspace).toEqual({
      profileDir: run.chromeProfileDir,
      captureDir: run.evidenceDir,
      portFile: resolve(run.root, "chrome.debug-port"),
      defaultStartUrl: null,
      allowedStartOrigin: "http://127.0.0.1:4319",
      requireExplicitStartUrl: true,
    });
  });

  it("builds the proven stock-Chrome args with the run-owned profile", () => {
    const workspace = __loisDiveTest.createSmokeWorkspace(smokeRun());
    const args = __loisDiveTest.chromeArgs(workspace, 9444, "http://127.0.0.1:4319/luma");

    expect(args).toContain(`--user-data-dir=${workspace.profileDir}`);
    expect(args).toContain("--remote-debugging-port=9444");
    expect(args).toContain("http://127.0.0.1:4319/luma");
    expect(args.join(" ")).not.toMatch(/enable-automation|disable-blink-features|no-sandbox/);
  });

  it("matches process ownership only for the exact run profile", () => {
    const workspace = __loisDiveTest.createSmokeWorkspace(smokeRun());
    const exact = `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${workspace.profileDir} --remote-debugging-port=9444`;

    expect(__loisDiveTest.ownsProfile(exact, workspace)).toBe(true);
    expect(
      __loisDiveTest.ownsProfile(
        exact.replace(workspace.profileDir, `${workspace.profileDir}-other`),
        workspace,
      ),
    ).toBe(false);
    expect(
      __loisDiveTest.ownsProfile(
        exact.replace(workspace.profileDir, resolve(workspace.profileDir, "nested")),
        workspace,
      ),
    ).toBe(false);
  });

  it("requires an explicit URL on the recorded mock origin before launch", () => {
    const workspace = __loisDiveTest.createSmokeWorkspace(smokeRun());

    expect(() => __loisDiveTest.resolveStartUrl(workspace)).toThrow(/explicit URL/i);
    expect(() => __loisDiveTest.resolveStartUrl(workspace, "https://lu.ma/3cs")).toThrow(/mock origin/i);
    expect(() => __loisDiveTest.resolveStartUrl(workspace, "http://127.0.0.1:4320/luma")).toThrow(
      /mock origin/i,
    );
    expect(__loisDiveTest.resolveStartUrl(workspace, "http://127.0.0.1:4319/luma?v=2")).toBe(
      "http://127.0.0.1:4319/luma?v=2",
    );
  });

  it("keeps smoke semantic reads on the mock origin but lets persistent reads use real web pages", () => {
    const smoke = __loisDiveTest.createSmokeWorkspace(smokeRun());
    const persistent = {
      profileDir: resolve("/tmp", "profile"),
      captureDir: resolve("/tmp", "captures"),
      portFile: resolve("/tmp", "profile.debug-port"),
      defaultStartUrl: "https://lu.ma",
      allowedStartOrigin: null,
      requireExplicitStartUrl: false,
    };

    expect(__loisDiveTest.semanticOriginAllowed(smoke, "http://127.0.0.1:4319/luma")).toBe(true);
    expect(__loisDiveTest.semanticOriginAllowed(smoke, "https://lu.ma/home")).toBe(false);
    expect(__loisDiveTest.semanticOriginAllowed(persistent, "https://lu.ma/home")).toBe(true);
    expect(__loisDiveTest.semanticOriginAllowed(persistent, "http://example.test/event")).toBe(true);
    expect(__loisDiveTest.semanticOriginAllowed(persistent, "about:blank")).toBe(false);
  });

  it("refuses a handle whose workspace does not own the reserved lease", () => {
    const workspace = __loisDiveTest.createSmokeWorkspace(smokeRun());
    const foreign = { ...workspace, profileDir: `${workspace.profileDir}-foreign` };

    expect(__loisDiveTest.workspaceLeaseRefusal(null, workspace)).toBeNull();
    expect(__loisDiveTest.workspaceLeaseRefusal(workspace, { ...workspace })).toBeNull();
    expect(__loisDiveTest.workspaceLeaseRefusal(workspace, foreign)).toMatch(/another browser workspace/i);
  });
});
