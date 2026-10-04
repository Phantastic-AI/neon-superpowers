// senders/types — the provider-agnostic send PORT (D-066).
//
// The send layer is ports-and-adapters: one small contract every adapter
// implements, and the config picks which adapter runs. Composio-Gmail is
// the first adapter, not the hardwiring — a future gog/Google-CLI or SMTP
// adapter is one more file implementing THIS interface and one registry
// line (index.ts), and nothing upstream changes.
//
// The law above every adapter (D-066): nothing sends without the
// operator's yes. The gate lives UPSTREAM (the queue/approval surface);
// an EmailSender is a dumb pipe that runs only after the yes, never a
// decision-maker. Keep this file minimal — no baroque options.

/** One message to send. Provider-agnostic: no Gmail/SMTP shapes leak in. */
export interface EmailMessage {
  /** Recipient address. The one required destination. */
  to: string;
  /** Recipient display name, when known (for "Name <addr>" niceties). */
  toName?: string;
  subject: string;
  /** Plain-text body. Adapters that speak HTML mark it themselves. */
  body: string;
  /** Reply-To address, when the operator wants replies routed elsewhere. */
  replyTo?: string;
}

/** What a send returns. `ok` is the only field every caller must read. */
export interface SendResult {
  ok: boolean;
  /** The provider's message id, when it hands one back. */
  id?: string;
  /** A human-readable reason when `ok` is false. Never a stack trace. */
  error?: string;
}

/** The port. Every adapter is exactly this shape and nothing more. */
export interface EmailSender {
  /** Registry name, e.g. "dry-run" or "composio-gmail". */
  name: string;
  /**
   * Can this adapter actually deliver right now? Cheap, honest, and it
   * NEVER sends — safe to call from a health check. `connected: false`
   * with a `detail` naming what is missing (a key, an authorized account).
   */
  authStatus(): Promise<{ connected: boolean; detail?: string }>;
  /** Deliver one message. Runs only after the upstream approval gate. */
  send(msg: EmailMessage): Promise<SendResult>;
}

/**
 * The port's own notion of a sendable message — one tiny guard both
 * adapters share so a malformed message fails the same way everywhere
 * (and, for the dry-run recorder, is never recorded as if it were sent).
 * Returns a reason string, or null when the message is fine.
 */
export function messageProblem(msg: EmailMessage): string | null {
  if (typeof msg.to !== "string" || msg.to.trim().length === 0) return "message has no recipient (to)";
  if (!msg.to.includes("@")) return `recipient "${msg.to}" is not an email address`;
  if (typeof msg.subject !== "string" || msg.subject.length === 0) return "message has no subject";
  if (typeof msg.body !== "string" || msg.body.length === 0) return "message has no body";
  return null;
}
