// hg/send — the send layer, wired at the face's edge (D-066), dry-run only.
//
// The send port and its message guard are the REAL ones from
// packages/senders (types.ts is pure — no node fs — so the browser imports
// it directly). This mirrors getSender()'s precedence and its ONE law: the
// default is dry-run, so nothing sends by accident, and the gate lives
// UPSTREAM (the queue's approve). ComposioGmailSender is the live pipe, but
// it needs node fetch + the operator's Composio key + a one-time Gmail
// authorization (D-068) — none present in this browser build — so it is
// NEVER constructed here. This build records; it does not deliver.

import type { EmailMessage, EmailSender, SendResult } from "../../../../packages/senders/types.js";
import { messageProblem } from "../../../../packages/senders/types.js";

export interface RecordedMessage extends EmailMessage {
  id: string;
  at: string;
  sender: "dry-run";
}

/** Browser dry-run adapter: validates + records, delivers NOTHING. */
export class BrowserDryRunSender implements EmailSender {
  readonly name = "dry-run";
  private counter = 0;
  readonly sent: RecordedMessage[] = [];

  async authStatus(): Promise<{ connected: boolean; detail?: string }> {
    return { connected: true, detail: "dry-run: records messages in memory, delivers nothing" };
  }

  async send(msg: EmailMessage): Promise<SendResult> {
    const problem = messageProblem(msg);
    if (problem !== null) return { ok: false, error: problem };
    const id = `dryrun-${++this.counter}`;
    this.sent.push({ ...msg, id, at: new Date().toISOString(), sender: "dry-run" });
    return { ok: true, id };
  }
}

export interface SenderChoice {
  sender: EmailSender;
  /** Whether this sender can actually deliver in THIS build. Always false here. */
  live: boolean;
  /** One honest line for the operator about what will (not) happen. */
  note: string;
}

/**
 * Mirror getSender()'s precedence (VITE_SENDER env, else the safe default),
 * but never construct a live pipe in the browser: a "composio-gmail" request
 * is honored as SELECTED-but-not-wired, and the actual sender stays dry-run.
 * So the operator sees which pipe is configured, and still nothing sends.
 */
export function selectSender(): SenderChoice {
  const chosen = (import.meta.env.VITE_SENDER as string | undefined) ?? "dry-run";
  if (chosen === "composio-gmail") {
    return {
      sender: new BrowserDryRunSender(),
      live: false,
      note: "Composio-Gmail is selected as the live pipe, but it is not wired in this build (no key, no Gmail authorization). Recording only. Nothing sends.",
    };
  }
  return {
    sender: new BrowserDryRunSender(),
    live: false,
    note: "Send mode is dry-run: every message is validated and recorded, nothing is delivered.",
  };
}

export type { EmailMessage, SendResult };
