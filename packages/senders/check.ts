#!/usr/bin/env -S npx tsx
// Senders check — proves the send layer is a safe, pluggable port (D-066):
//
//   (a) the port shape holds: both adapters expose name/authStatus/send,
//       and messageProblem guards a bad message the same way for both;
//   (b) DryRunSender records a sample message and returns ok — in memory
//       and, when given an out dir, as one JSONL line — and DELIVERS
//       NOTHING; an invalid message returns ok:false and records nothing;
//   (c) the registry resolves BOTH adapters by name, and an unknown name
//       throws (naming the real adapters, so a typo never sends);
//   (d) getSender() with nothing configured defaults to dry-run — the safe
//       default: nothing sends by accident — and SENDER selects the adapter;
//   (e) ComposioGmailSender never sends or hits the network without a key:
//       authStatus() reports not-connected, send() returns ok:false, and
//       initiateGmailConnection() throws — all with COMPOSIO_API_KEY unset,
//       none of them throwing on the authStatus/send paths.
//
// NO live Composio call is made (no key, and the composio checks force the
// key unset). Exit nonzero, naming the miss, on any failure. On failure the
// temp out dir is kept for inspection.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmailMessage, EmailSender } from "./types.js";
import { messageProblem } from "./types.js";
import { DryRunSender } from "./dry-run.js";
import { ComposioGmailSender } from "./composio-gmail.js";
import { getSender, SENDER_NAMES, DEFAULT_SENDER } from "./index.js";

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
}
async function throwsAsync(name: string, fn: () => Promise<unknown>, pattern: RegExp) {
  let detail = "did NOT throw";
  let pass = false;
  try {
    await fn();
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
    pass = pattern.test(detail);
  }
  check(name, pass, detail);
}

const hasPort = (s: EmailSender) =>
  typeof s.name === "string" && s.name.length > 0 && typeof s.authStatus === "function" && typeof s.send === "function";

const SAMPLE: EmailMessage = {
  to: "ada@example.com",
  toName: "Ada Lovelace",
  subject: "Fogline — a Tech Week evening",
  body: "Hi Ada,\n\nWe'd love to have you at Fogline next week.\n\n— The desk",
  replyTo: "operator@example.com",
};

const tempRoot = mkdtempSync(join(tmpdir(), "senders-check-"));
const outDir = join(tempRoot, "out");

async function main() {
  // =====================================================================
  // (a) the port shape holds for both adapters; the guard is shared
  // =====================================================================
  const dry = new DryRunSender();
  const composio = new ComposioGmailSender();
  check(
    "PORT: DryRunSender and ComposioGmailSender both satisfy EmailSender (name/authStatus/send), named dry-run and composio-gmail",
    hasPort(dry) && hasPort(composio) && dry.name === "dry-run" && composio.name === "composio-gmail",
    `dry.name=${dry.name}, composio.name=${composio.name}`,
  );
  check(
    "PORT: messageProblem accepts a good message and rejects a recipient-less one, naming the fault",
    messageProblem(SAMPLE) === null && (messageProblem({ ...SAMPLE, to: "" }) ?? "").includes("recipient"),
    `good=${messageProblem(SAMPLE)}, bad=${messageProblem({ ...SAMPLE, to: "" })}`,
  );

  // =====================================================================
  // (b) DryRunSender records and returns ok; delivers nothing; guards bad
  // =====================================================================
  const dryFile = new DryRunSender({ outDir });
  const r1 = await dryFile.send(SAMPLE);
  check(
    "DRY-RUN: send() returns ok with an id, and the message is recorded in memory (sent.length 0 -> 1)",
    r1.ok === true && typeof r1.id === "string" && dryFile.sent.length === 1 && dryFile.sent[0].to === SAMPLE.to && dryFile.sent[0].sender === "dry-run",
    `ok=${r1.ok}, id=${r1.id}, sent=${dryFile.sent.length}, to=${dryFile.sent[0]?.to}`,
  );
  const jsonlPath = join(outDir, "sent.jsonl");
  const lines = readFileSync(jsonlPath, "utf8").trim().split("\n");
  const logged = JSON.parse(lines[0]) as Record<string, unknown>;
  check(
    "DRY-RUN: the message was also recorded as exactly one JSONL line under the out dir (to/subject/body/id round-trip)",
    lines.length === 1 && logged.to === SAMPLE.to && logged.subject === SAMPLE.subject && logged.body === SAMPLE.body && typeof logged.id === "string",
    `lines=${lines.length}, path=${jsonlPath}`,
  );
  const dryAuth = await dry.authStatus();
  check(
    "DRY-RUN: authStatus() is connected:true but its detail names that it DELIVERS NOTHING (honest safe default)",
    dryAuth.connected === true && /deliver/i.test(dryAuth.detail ?? "") && /nothing/i.test(dryAuth.detail ?? ""),
    `connected=${dryAuth.connected}, detail=${dryAuth.detail}`,
  );
  const bad = await dryFile.send({ ...SAMPLE, to: "not-an-email" });
  check(
    "DRY-RUN: an invalid message returns ok:false and is NOT recorded (still 1 recorded, guard behaves like a real sender)",
    bad.ok === false && (bad.error ?? "").length > 0 && dryFile.sent.length === 1,
    `ok=${bad.ok}, error=${bad.error}, sent=${dryFile.sent.length}`,
  );

  // =====================================================================
  // (c) the registry resolves both by name; unknown name throws
  // =====================================================================
  check(
    "REGISTRY: SENDER_NAMES holds both adapters; getSender('dry-run') and getSender('composio-gmail') resolve to the right ports",
    SENDER_NAMES.includes("dry-run") &&
      SENDER_NAMES.includes("composio-gmail") &&
      getSender("dry-run").name === "dry-run" &&
      getSender("composio-gmail").name === "composio-gmail",
    `names={${SENDER_NAMES.join(", ")}}`,
  );
  let threw = "";
  try {
    getSender("smtp-typo");
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check(
    "REGISTRY: an unknown name throws, naming the real adapters (a typo never silently falls back to a real send)",
    /unknown sender "smtp-typo"/.test(threw) && /dry-run/.test(threw) && /composio-gmail/.test(threw),
    `threw=${threw}`,
  );

  // =====================================================================
  // (d) getSender() defaults to dry-run; SENDER selects — nothing sends
  //     by accident. Save/restore the env around the assertions.
  // =====================================================================
  const savedSender = process.env.SENDER;
  delete process.env.SENDER;
  check(
    `DEFAULT: with SENDER unset, getSender() resolves to "${DEFAULT_SENDER}" — the safe default, so nothing ever sends by accident`,
    getSender().name === DEFAULT_SENDER && DEFAULT_SENDER === "dry-run",
    `getSender().name=${getSender().name}, DEFAULT_SENDER=${DEFAULT_SENDER}`,
  );
  process.env.SENDER = "composio-gmail";
  check(
    'SELECT: SENDER="composio-gmail" makes getSender() resolve to the Composio adapter',
    getSender().name === "composio-gmail",
    `getSender().name=${getSender().name}`,
  );
  if (savedSender === undefined) delete process.env.SENDER;
  else process.env.SENDER = savedSender;

  // =====================================================================
  // (e) Composio adapter is inert without a key: no send, no network,
  //     no throw on authStatus/send. Force the key unset for determinism.
  // =====================================================================
  const savedKey = process.env.COMPOSIO_API_KEY;
  delete process.env.COMPOSIO_API_KEY;
  const noKey = new ComposioGmailSender();
  const noKeyAuth = await noKey.authStatus();
  check(
    "COMPOSIO (no key): authStatus() returns connected:false naming COMPOSIO_API_KEY, without throwing and without any network call",
    noKeyAuth.connected === false && /COMPOSIO_API_KEY/.test(noKeyAuth.detail ?? ""),
    `connected=${noKeyAuth.connected}, detail=${noKeyAuth.detail}`,
  );
  const noKeySend = await noKey.send(SAMPLE);
  check(
    "COMPOSIO (no key): send() returns ok:false with a clear error and NEVER reaches the network (no real email, ever)",
    noKeySend.ok === false && /COMPOSIO_API_KEY/.test(noKeySend.error ?? ""),
    `ok=${noKeySend.ok}, error=${noKeySend.error}`,
  );
  await throwsAsync(
    "COMPOSIO (no key): initiateGmailConnection() throws naming the missing key, before any network call",
    () => noKey.initiateGmailConnection(),
    /COMPOSIO_API_KEY not set/,
  );
  // With a key but no auth config id, the connection flow still refuses before the wire.
  const keyNoConfig = new ComposioGmailSender({ apiKey: "test-not-real", authConfigId: undefined });
  await throwsAsync(
    "COMPOSIO: initiateGmailConnection() with a key but no auth config id throws naming COMPOSIO_GMAIL_AUTH_CONFIG_ID, before any network call",
    () => keyNoConfig.initiateGmailConnection(),
    /COMPOSIO_GMAIL_AUTH_CONFIG_ID not set/,
  );
  if (savedKey === undefined) delete process.env.COMPOSIO_API_KEY;
  else process.env.COMPOSIO_API_KEY = savedKey;

  // =====================================================================
  // Report
  // =====================================================================
  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
  }
  console.log("");
  if (failed.length > 0) {
    console.error(`check.ts: ${failed.length} of ${results.length} checks FAILED (temp out kept at ${outDir}):`);
    for (const r of failed) console.error(`  - ${r.name}: ${r.detail}`);
    process.exit(1);
  }
  rmSync(tempRoot, { recursive: true, force: true });
  console.log(`check.ts: all ${results.length} checks passed.`);
}

main().catch((err) => {
  console.error(`check.ts: crashed (temp out kept at ${outDir}):`, err);
  process.exit(1);
});
