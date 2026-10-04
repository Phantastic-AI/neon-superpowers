// senders — the adapter registry and getSender() (D-066).
//
// The config picks the adapter; the code never does. `getSender(name?)`
// selects by the SENDER env (default "dry-run", the safe default — nothing
// sends by accident), with "composio-gmail" available.
//
// ── Adding a new adapter is ONE file + ONE registry line ────────────────
// Say the operator wants a gog/Google-CLI or SMTP sender (D-066 names both):
//   1. Write `packages/senders/gog-cli.ts` exporting a class that
//      `implements EmailSender` (types.ts) — name, authStatus(), send().
//   2. Add one line to REGISTRY below:  "gog-cli": () => new GogCliSender(),
// That is the whole change. Nothing upstream (the queue, the gate, callers)
// touches an adapter directly — they call getSender() and get the port.

import type { EmailSender } from "./types.js";
import { DryRunSender } from "./dry-run.js";
import { ComposioGmailSender } from "./composio-gmail.js";

export type { EmailMessage, EmailSender, SendResult } from "./types.js";
export { messageProblem } from "./types.js";
export { DryRunSender } from "./dry-run.js";
export type { RecordedMessage, DryRunConfig } from "./dry-run.js";
export { ComposioGmailSender } from "./composio-gmail.js";
export type { ComposioGmailConfig } from "./composio-gmail.js";

/**
 * The adapter registry: name -> a factory that builds the adapter lazily.
 * Lazy so that merely listing/selecting adapters constructs nothing and
 * touches no network. Add a new adapter here (one line) — see the header.
 */
const REGISTRY: Record<string, () => EmailSender> = {
  "dry-run": () => new DryRunSender(process.env.SENDER_OUT ? { outDir: process.env.SENDER_OUT } : {}),
  "composio-gmail": () => new ComposioGmailSender(),
};

/** The default adapter when nothing is configured: records, never delivers. */
export const DEFAULT_SENDER = "dry-run";

/** Every adapter name the registry knows. */
export const SENDER_NAMES = Object.keys(REGISTRY);

/**
 * Resolve an EmailSender. Precedence: explicit `name` arg, else the SENDER
 * env, else the safe default "dry-run". An unknown name throws, naming the
 * adapters that DO exist — so a typo never silently falls back to sending.
 */
export function getSender(name?: string): EmailSender {
  const chosen = name ?? process.env.SENDER ?? DEFAULT_SENDER;
  const factory = REGISTRY[chosen];
  if (factory === undefined) {
    throw new Error(`unknown sender "${chosen}" — available: {${SENDER_NAMES.join(", ")}} (default "${DEFAULT_SENDER}")`);
  }
  return factory();
}
