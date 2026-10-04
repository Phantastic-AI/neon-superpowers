// Deterministic, model-free proof of the 3Cs browser capability lane.
//
// This command drives stock Chrome against a loopback-only mock. It is not the
// paid Lois/goldfish proof: it invokes no model and makes no external write.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSmokeDiveHands, onBrowserFrame } from "./lois-dive.js";
import { initializeSmokeRun } from "./lois-smoke-run.js";
import { startMockLuma, type MockLumaVariant } from "./mock-luma.js";

export interface CapabilitySmokeConfig {
  repo: string;
  baseDir: string;
  seedVaultDir: string;
  artifactPaths: {
    contract: string;
    prd: string;
    testSpec: string;
  };
}

export function resolveCapabilitySmokeConfig(repoRoot: string): CapabilitySmokeConfig {
  const repo = resolve(repoRoot);
  return {
    repo,
    baseDir: resolve(tmpdir(), "superpowers-capability-runs"),
    seedVaultDir: resolve(repo, "tools/seed-world/out"),
    artifactPaths: {
      contract: resolve(repo, "docs/browser-experience-contract.md"),
      prd: resolve(repo, "docs/3cs-browser-goldfish-smoke.md"),
      testSpec: resolve(repo, "docs/3cs-browser-goldfish-test-spec.md"),
    },
  };
}

export function hashSmokeArtifact(path: string): string {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Capability smoke artifact is missing: ${path}`);
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function refOnLine(observation: string, needle: string): string {
  const line = observation
    .split("\n")
    .find((candidate) => candidate.includes(needle) && candidate.includes("[ref="));
  const match = line?.match(/\[ref=((?:f\d+)?e\d+)\]/);
  if (!match) throw new Error(`No semantic ref found for ${needle}.\n${observation}`);
  return match[1];
}

export function optionLabel(observation: string, needle: string): string {
  const line = observation
    .split("\n")
    .find((candidate) => candidate.includes(needle) && /option/i.test(candidate));
  const match = line?.match(/option\s+"([^"]+)"/i);
  if (!match) throw new Error(`No visible option label found for ${needle}.\n${observation}`);
  return match[1];
}

export async function until(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

export function assertCleanHead(repo: string): string {
  const status = git(repo, ["status", "--short"]);
  if (status) throw new Error(`Capability smoke requires a committed clean product tree:\n${status}`);
  return git(repo, ["rev-parse", "HEAD"]);
}

export function processResidue(profileDir: string): string[] {
  return execFileSync("/bin/ps", ["ax", "-o", "command="], { encoding: "utf8" })
    .split("\n")
    .filter((command) => command.includes(`--user-data-dir=${profileDir}`));
}

async function smokeVariant(
  config: CapabilitySmokeConfig,
  variant: MockLumaVariant,
): Promise<Record<string, unknown>> {
  const runId = `cap-${variant}-${Date.now().toString(36)}`;
  const head = assertCleanHead(config.repo);
  const mock = await startMockLuma({ runId });

  try {
    const url = mock.variantUrl(variant);
    const ignitionHead = assertCleanHead(config.repo);
    if (ignitionHead !== head) throw new Error("Product HEAD changed during capability preflight.");
    const run = initializeSmokeRun({
      baseDir: config.baseDir,
      runId,
      mockUrl: url,
      seedVaultDir: config.seedVaultDir,
      product: { repo: config.repo, head, clean: true },
      artifactHashes: {
        contract: hashSmokeArtifact(config.artifactPaths.contract),
        prd: hashSmokeArtifact(config.artifactPaths.prd),
        testSpec: hashSmokeArtifact(config.artifactPaths.testSpec),
      },
    });
    const hands = createSmokeDiveHands(run);
    let latestFrameUrl = "";
    const stopFrames = onBrowserFrame((frame) => {
      latestFrameUrl = frame.url;
    });
    let closeNote = "not started";

    try {
      const startNote = await hands.dive_start(url, true);
      if (!startNote.startsWith("Opened ")) throw new Error(startNote);
      await until(() => latestFrameUrl === url, `${variant} frame on its exact URL`);

      const observation = await hands.dive_observe();
      if (!observation.startsWith("Observation ")) throw new Error(observation);
      writeFileSync(resolve(run.evidenceDir, `${variant}-observation.txt`), observation, "utf8");
      const observationId = observation.match(/^Observation (obs-\d+)/)?.[1];
      if (!observationId) throw new Error("Observation id missing.");
      const messageRef = refOnLine(
        observation,
        variant === "v1" ? "Invitation note" : "Message for the invitation",
      );
      const operations = variant === "v1"
        ? [
            { kind: "check" as const, ref: refOnLine(observation, "Maya Chen"), checked: true },
            {
              kind: "fill" as const,
              ref: messageRef,
              text: "Come through — community, care, and curiosity.",
            },
          ]
        : [
            {
              kind: "fill" as const,
              ref: messageRef,
              text: "Come through — community, care, and curiosity.",
            },
            {
              kind: "select" as const,
              ref: refOnLine(observation, "People"),
              labels: [optionLabel(observation, "Maya Chen")],
            },
          ];
      const prepareNote = await hands.dive_prepare({ observationId, operations });
      if (prepareNote !== "Prepared 2 controls. Nothing was submitted.") throw new Error(prepareNote);

      const tab = await hands.dive_input({ type: "key", key: "Tab" }, "automation");
      if (!tab.ok) throw new Error(tab.note);
      const enter = await hands.dive_input({ type: "key", key: "Enter" }, "automation");
      if (!enter.ok) throw new Error(enter.note);
      await until(() => mock.receipts().length === 1, `${variant} browser-driven receipt`);
      await until(() => latestFrameUrl.includes("/receipts/"), `${variant} receipt frame`);

      const receipt = mock.receipts()[0];
      appendFileSync(run.receiptsPath, `${JSON.stringify(receipt)}\n`, "utf8");
      const captureNote = await hands.dive_capture();
      if (!captureNote.startsWith("Captured ")) throw new Error(captureNote);
      closeNote = await hands.dive_close();
      const residue = processResidue(run.chromeProfileDir);
      if (residue.length) throw new Error(`Run-owned Chrome process remained: ${residue.join(" | ")}`);
      if (readFileSync(run.modelUsagePath, "utf8") !== "") {
        throw new Error("Model usage appeared in the model-free capability lane.");
      }
      if (readFileSync(run.approvalsPath, "utf8") !== "") {
        throw new Error("Approval activity appeared in the deterministic capability lane.");
      }
      const postStatus = git(config.repo, ["status", "--short"]);
      if (postStatus) throw new Error(`Capability smoke dirtied the product tree:\n${postStatus}`);

      const evidence = {
        schemaVersion: 1,
        lane: "deterministic-browser-capability",
        variant,
        runId,
        runRoot: run.root,
        head,
        cleanAtIgnition: true,
        cleanAfterRun: true,
        url,
        semanticObservation: observationId,
        prepared: prepareNote,
        activation: [tab.note, enter.note],
        receipt,
        capture: captureNote,
        close: closeNote,
        chromeProcessResidue: 0,
        modelCalls: 0,
        externalWrites: 0,
      };
      writeFileSync(
        resolve(run.evidenceDir, `${variant}-capability.json`),
        `${JSON.stringify(evidence, null, 2)}\n`,
        "utf8",
      );
      return evidence;
    } catch (error) {
      writeFileSync(
        resolve(run.evidenceDir, `${variant}-failure.json`),
        `${JSON.stringify({
          schemaVersion: 1,
          lane: "deterministic-browser-capability",
          variant,
          runId,
          head,
          error: error instanceof Error ? error.message : String(error),
        }, null, 2)}\n`,
        "utf8",
      );
      throw error;
    } finally {
      stopFrames();
      if (!closeNote.startsWith("Closed ")) await hands.dive_close().catch(() => undefined);
    }
  } finally {
    await mock.close().catch(() => undefined);
  }
}

export async function runCapabilitySmoke(
  config: CapabilitySmokeConfig,
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  for (const variant of ["v1", "v2"] as const) {
    results.push(await smokeVariant(config, variant));
  }
  return results;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runCapabilitySmoke(resolveCapabilitySmokeConfig(repoRoot))
    .then((results) => console.log(JSON.stringify(results, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
}
