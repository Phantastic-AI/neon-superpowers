#!/usr/bin/env -S npx tsx
// Paid manual 3Cs session: one owned app, browser, mock, and inference envelope.
//
// This is intentionally cold by default. The shared paid CLI parser requires
// explicit approval plus a fresh exact pricing plan before this file may bind
// the mock, sidecar, face, Chrome, or provider. The sidecar independently
// rechecks the committed HEAD and binds every model role to the run ledger.

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSystem, createLoisServer, type BuiltSidecar } from "../sidecar/server.js";
import { closeRuntimeBrowser, idleRuntimeDiver } from "../sidecar/runtime.js";
import { assertCleanHead, processResidue } from "./lois-capability-smoke.js";
import {
  assertPaidSmokeIgnitionHead,
  initializePaidSmokeEnvelope,
  parsePaidSmokeCli,
  preflightPaidSmoke,
  type PaidSmokeOptions,
  verifyPaidSmokePricing,
} from "./lois-paid-smoke.js";
import { startMockLuma } from "./mock-luma.js";
import type { SmokeRunPaths } from "./lois-smoke-run.js";

const SIDECAR_PORT = 5175;

export interface PaidSmokeAppPorts { sidecarPort?: number; facePort?: number }
export function paidSmokeAppPorts(input: PaidSmokeAppPorts = {}) {
  const sidecarPort = input.sidecarPort ?? SIDECAR_PORT, facePort = input.facePort ?? 5199;
  for (const port of [sidecarPort, facePort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("App ports must be integers from 1 through 65535.");
  }
  if (sidecarPort === facePort) throw new Error("Face and sidecar ports must be distinct.");
  return { sidecarPort, facePort, appUrl: `http://127.0.0.1:${facePort}/pane/lois` };
}

export type LoopbackPortProbe = (port: number) => Promise<boolean>;

export interface PaidSmokeAppSessionContext {
  appUrl: string;
  mockUrl: string;
  run: SmokeRunPaths;
  built: BuiltSidecar;
}

export type PaidSmokeAppDriver = (context: PaidSmokeAppSessionContext) => Promise<void>;

/** A detached worker must settle before browser teardown and the final usage read. */
export async function quiescePaidSmokeApp(built: Pick<BuiltSidecar, "system" | "runtime">): Promise<void> {
  built.system.cancel();
  const settled = await Promise.allSettled([built.system.idle(), idleRuntimeDiver(built.runtime)]);
  const failed = settled.find((value): value is PromiseRejectedResult => value.status === "rejected");
  if (failed) throw failed.reason;
}

async function probeLoopbackPort(port: number): Promise<boolean> {
  return new Promise((resolveProbe, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (task: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      task();
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => finish(() => resolveProbe(true)));
    socket.once("timeout", () => finish(() => reject(new Error(`Timed out probing loopback port ${port}.`))));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") finish(() => resolveProbe(false));
      else finish(() => reject(error));
    });
  });
}

export async function assertLoopbackPortsAvailable(
  ports: readonly number[] = [SIDECAR_PORT, 5199],
  probe: LoopbackPortProbe = probeLoopbackPort,
): Promise<void> {
  for (const port of ports) {
    if (await probe(port)) {
      throw new Error(`Loopback port ${port} is already occupied; refusing to trust a stale app or sidecar.`);
    }
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function waitForFace(child: ChildProcess, appUrl: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Face exited before readiness with code ${child.exitCode}.`);
    try {
      const response = await fetch(appUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Face exited during readiness settling (${child.exitCode ?? child.signalCode}).`);
        }
        return;
      }
    } catch {
      // Vite is still coming up.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Timed out waiting for the Lois face at ${appUrl}.`);
}

function stopRequest(): { promise: Promise<NodeJS.Signals>; dispose(): void } {
  let onInterrupt: () => void;
  let onTerminate: () => void;
  const promise = new Promise<NodeJS.Signals>((resolveStop) => {
    onInterrupt = () => resolveStop("SIGINT");
    onTerminate = () => resolveStop("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
  });
  return {
    promise,
    dispose: () => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    },
  };
}

function childExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = childExit(child);
  child.kill("SIGTERM");
  const timeout = new Promise<"timeout">((resolveTimeout) => {
    setTimeout(() => resolveTimeout("timeout"), 5_000).unref();
  });
  if (await Promise.race([exited.then(() => "exited" as const), timeout]) === "timeout") {
    child.kill("SIGKILL");
    await childExit(child).catch(() => undefined);
  }
}

export async function runPaidSmokeApp(
  options: PaidSmokeOptions,
  drive?: PaidSmokeAppDriver,
  ports: PaidSmokeAppPorts = {},
): Promise<void> {
  const { sidecarPort, facePort, appUrl } = paidSmokeAppPorts(ports);
  const preflight = preflightPaidSmoke(options);
  await assertLoopbackPortsAvailable([sidecarPort, facePort]);
  const verifiedPricing = await verifyPaidSmokePricing(options, preflight);
  assertPaidSmokeIgnitionHead(preflight);

  let run: SmokeRunPaths | undefined;
  let built: BuiltSidecar | undefined;
  let server: Server | undefined;
  let face: ChildProcess | undefined;
  let faceExitPromise: ReturnType<typeof childExit> | undefined;
  let stop: ReturnType<typeof stopRequest> | undefined;
  let stopReason = "startup failure";
  let sessionError: unknown;
  const mock = await startMockLuma({ runId: options.runId });

  try {
    stop = stopRequest();
    run = initializePaidSmokeEnvelope(
      options,
      preflight,
      mock.variantUrl(options.variant),
      verifiedPricing,
    );
    const env = {
      ...process.env,
      LOIS_PORT: String(sidecarPort),
      LOIS_SMOKE_RUN_ROOT: run.root,
    };
    built = buildSystem(env);
    server = createLoisServer(built);
    await listen(server, sidecarPort);
    // Vite reads the product tree after it starts, so repeat the gate at that
    // exact boundary rather than relying only on the sidecar's check.
    assertPaidSmokeIgnitionHead(preflight);
    face = spawn("pnpm", ["--filter", "@browser-operator/face", "exec", "vite", "--host", "127.0.0.1", "--port", String(facePort), "--strictPort"], {
      cwd: preflight.repo,
      env,
      stdio: "inherit",
    });
    faceExitPromise = childExit(face);
    await Promise.race([
      waitForFace(face, appUrl),
      faceExitPromise.then(({ code, signal }) => {
        throw new Error(`Face exited before readiness (${code ?? signal ?? "unknown"}).`);
      }),
    ]);
    console.log("\nLois manual smoke is ready.");
    console.log(`  app: ${appUrl}`);
    console.log(`  mock Luma: ${mock.variantUrl(options.variant)}`);
    console.log(`  run evidence: ${run.root}`);
    console.log(`  committed HEAD: ${preflight.head}`);
    console.log(`  paid ceiling: $${built.inference?.status.limits?.runUsd.toFixed(2)} this run`);
    console.log("  stop: Ctrl-C (the launcher closes Chrome, face, sidecar, and mock)\n");

    const outcome = await Promise.race([
      ...(drive
        ? [drive({
            appUrl,
            mockUrl: mock.variantUrl(options.variant),
            run,
            built,
          }).then(() => ({ kind: "driver-complete" as const }))]
        : []),
      stop.promise.then((signal) => ({ kind: "stop" as const, signal })),
      faceExitPromise.then((value) => ({ kind: "face-exit" as const, ...value })),
    ]);
    if (outcome.kind === "face-exit") {
      stopReason = `face exited (${outcome.code ?? outcome.signal ?? "unknown"})`;
      if (outcome.code !== 0) throw new Error(`Lois face exited unexpectedly with code ${outcome.code}.`);
    } else if (outcome.kind === "stop") {
      stopReason = outcome.signal;
    } else {
      stopReason = "automated session complete";
    }
  } catch (error) {
    sessionError = error;
    throw error;
  } finally {
    stop?.dispose();
    if (face) await stopChild(face).catch(() => undefined);
    let cascadeClose = "not started";
    let browserClose = "not started";
    if (built) {
      cascadeClose = await quiescePaidSmokeApp(built)
        .then(() => "quiet")
        .catch((error) => `Runtime cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      browserClose = await closeRuntimeBrowser(built.runtime).catch((error) =>
        `Browser cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (server) await closeServer(server).catch(() => undefined);

    const receipts = mock.receipts();
    if (run) {
      for (const receipt of receipts) {
        appendFileSync(run.receiptsPath, `${JSON.stringify(receipt)}\n`, "utf8");
      }
    }
    await mock.close().catch(() => undefined);

    const residue = run ? processResidue(run.chromeProfileDir) : [];
    let cleanAfterSession = false;
    try {
      cleanAfterSession = assertCleanHead(preflight.repo) === preflight.head;
    } catch {
      cleanAfterSession = false;
    }
    if (run) {
      writeFileSync(
        resolve(run.evidenceDir, "manual-app-session.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          runId: options.runId,
          appUrl,
          mockUrl: mock.variantUrl(options.variant),
          head: preflight.head,
          stopReason,
          ...(sessionError ? {
            error: sessionError instanceof Error ? sessionError.message : String(sessionError),
          } : {}),
          cascadeClose,
          browserClose,
          receipts,
          usage: built?.inference?.budget?.summary(),
          cleanAfterSession,
          chromeProcessResidue: residue.length,
        }, null, 2)}\n`,
        "utf8",
      );
    }
    if (residue.length) {
      throw new Error(`Run-owned Chrome process remained after cleanup: ${residue.join(" | ")}`);
    }
  }
}

export function isDirectPaidSmokeApp(
  metaUrl: string = import.meta.url,
  argv: string[] = process.argv,
): boolean {
  const entry = argv[1];
  return Boolean(entry) && pathToFileURL(resolve(entry)).href === metaUrl;
}

if (isDirectPaidSmokeApp()) {
  void runPaidSmokeApp(parsePaidSmokeCli(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
