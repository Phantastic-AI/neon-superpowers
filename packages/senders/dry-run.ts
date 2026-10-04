// senders/dry-run — the SAFE DEFAULT adapter (D-066).
//
// DryRunSender implements EmailSender but DELIVERS NOTHING. It validates
// the message like a real sender, RECORDS it (to an in-memory list, and
// optionally as one JSONL line per message under an out dir), and returns
// ok. This is what staging and every test point at, so nothing can send a
// real email by accident — the registry's default (index.ts) is this.
//
// It behaves like a real sender in every way EXCEPT the wire: an invalid
// message is rejected here too (returns ok:false, records nothing), so a
// test against the dry-run exercises the same guard the live path would.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EmailMessage, EmailSender, SendResult } from "./types.js";
import { messageProblem } from "./types.js";

/** One recorded send: the message, when it was recorded, and its id. */
export interface RecordedMessage extends EmailMessage {
  id: string;
  at: string;
  sender: "dry-run";
}

export interface DryRunConfig {
  /**
   * If set, every recorded message is also appended as one JSONL line to
   * `<outDir>/sent.jsonl`. If unset, recording is in-memory only.
   */
  outDir?: string;
  /** Override the JSONL filename (default "sent.jsonl"). */
  file?: string;
}

export class DryRunSender implements EmailSender {
  readonly name = "dry-run";
  private readonly outDir?: string;
  private readonly file: string;
  private counter = 0;
  /** Everything this sender has "sent" (recorded) this process, in order. */
  readonly sent: RecordedMessage[] = [];

  constructor(config: DryRunConfig = {}) {
    this.outDir = config.outDir;
    this.file = config.file ?? "sent.jsonl";
  }

  /** Always ready to record; honest that it never delivers. Never sends. */
  async authStatus(): Promise<{ connected: boolean; detail?: string }> {
    return {
      connected: true,
      detail: this.outDir
        ? `dry-run: records messages to ${join(this.outDir, this.file)}, delivers nothing`
        : "dry-run: records messages in memory, delivers nothing",
    };
  }

  async send(msg: EmailMessage): Promise<SendResult> {
    const problem = messageProblem(msg);
    if (problem !== null) return { ok: false, error: problem };

    const id = `dryrun-${++this.counter}`;
    const record: RecordedMessage = { ...msg, id, at: new Date().toISOString(), sender: "dry-run" };
    this.sent.push(record);

    if (this.outDir !== undefined) {
      mkdirSync(this.outDir, { recursive: true });
      appendFileSync(join(this.outDir, this.file), JSON.stringify(record) + "\n");
    }

    return { ok: true, id };
  }
}
