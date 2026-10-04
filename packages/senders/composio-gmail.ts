// senders/composio-gmail — the first REAL adapter (D-066, extends D-062).
//
// ComposioGmailSender implements EmailSender by driving Composio's managed
// Gmail toolkit. It talks to Composio's REST API over `fetch` (Node 22's
// global) rather than pulling in the `@composio/core` SDK — a deliberate
// choice matching this repo's zero-dependency, node-builtins-only,
// tsx-runnable house style (see packages/vault and packages/organs, both
// with empty devDependencies). Three documented REST calls beat an
// ESM-only SDK dependency tree here; the SDK method names are noted beside
// each call so a later swap to the SDK is mechanical.
//
// ── What is real (verified against docs.composio.dev, 2026-08) ──────────
//   • SDK/base: `@composio/core`; REST base https://backend.composio.dev/api/v3,
//     auth header `x-api-key: <COMPOSIO_API_KEY>`.
//   • Send action slug: GMAIL_SEND_EMAIL. Arguments (verified): required
//     `recipient_email`; `subject`; `body`; `is_html` (true only when body
//     is HTML — ours is plain text, so false).
//       REST:  POST /api/v3/tools/execute/GMAIL_SEND_EMAIL
//              body { user_id, arguments, connected_account_id? }
//       SDK:   composio.tools.execute("GMAIL_SEND_EMAIL", { userId, arguments, connectedAccountId })
//   • Connect a Gmail account (managed-OAuth "link" flow — the path that
//     replaced the now-retiring POST /connected_accounts for managed OAuth):
//       REST:  POST /api/v3/connected_accounts/link
//              body { user_id, auth_config_id, callback_url? }  → redirect_url
//       SDK:   composio.connectedAccounts.link(userId, authConfigId, { callbackUrl })
//     The operator opens redirect_url once, authorizes Gmail, done.
//
// ── TODO — confirm live, against the operator's own Composio org ─────────
//   (T1) GMAIL_SEND_EMAIL has no verified `reply_to` field. EmailMessage.replyTo
//        is sent best-effort as `reply_to` in `arguments` and IGNORED by
//        Composio if unsupported; confirm the real field name (or that
//        Reply-To must be set via a raw-MIME send action instead).
//   (T2) execute: standard execution is scoped to `user_id` and Composio
//        resolves that user's active Gmail connected account; `connected_account_id`
//        is sent only when configured (required for proxy execution). Confirm
//        whether your org needs it explicitly.
//   (T3) The exact JSON path of the OAuth URL in the /connected_accounts/link
//        response — read robustly here (top-level `redirect_url`, or nested
//        under `connectionData`/`connection_data`). Confirm the shape.
//   (T4) authStatus() reports key-presence + config only; it does NOT probe
//        Composio for an ACTIVE connection (that would be a live call). Wire
//        a GET /api/v3/connected_accounts?user_ids=…&toolkit_slugs=gmail read
//        when you want a true liveness check, and confirm the query params.
//
// This adapter is a dumb pipe: it runs only after the upstream approval
// gate (D-066). Nothing here decides to send.

import type { EmailMessage, EmailSender, SendResult } from "./types.js";
import { messageProblem } from "./types.js";

const DEFAULT_BASE_URL = "https://backend.composio.dev/api/v3";
const SEND_ACTION = "GMAIL_SEND_EMAIL";

export interface ComposioGmailConfig {
  /** Composio API key. Default: env COMPOSIO_API_KEY. Never hard-code. */
  apiKey?: string;
  /**
   * The Composio "entity"/user id the Gmail account is connected under.
   * Default: env COMPOSIO_USER_ID, else "default".
   */
  userId?: string;
  /**
   * The auth config id for the Gmail integration (from the Composio
   * dashboard). Needed only to INITIATE a connection. Default: env
   * COMPOSIO_GMAIL_AUTH_CONFIG_ID.
   */
  authConfigId?: string;
  /**
   * Pin a specific connected account for sends (see TODO T2). Optional.
   * Default: env COMPOSIO_CONNECTED_ACCOUNT_ID.
   */
  connectedAccountId?: string;
  /** Override the REST base (tests, self-hosted). Default backend.composio.dev. */
  baseUrl?: string;
}

/** Composio's standard tool-execution envelope. */
interface ExecuteResponse {
  data?: Record<string, unknown>;
  error?: string | null;
  successful?: boolean;
}

export class ComposioGmailSender implements EmailSender {
  readonly name = "composio-gmail";
  private readonly apiKey?: string;
  private readonly userId: string;
  private readonly authConfigId?: string;
  private readonly connectedAccountId?: string;
  private readonly baseUrl: string;

  constructor(config: ComposioGmailConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.COMPOSIO_API_KEY;
    this.userId = config.userId ?? process.env.COMPOSIO_USER_ID ?? "default";
    this.authConfigId = config.authConfigId ?? process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID;
    this.connectedAccountId = config.connectedAccountId ?? process.env.COMPOSIO_CONNECTED_ACCOUNT_ID;
    this.baseUrl = (config.baseUrl ?? process.env.COMPOSIO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  /**
   * Key-and-config presence only — NO live call, so it is safe from a
   * health check and from tests with no key (returns connected:false,
   * never throws, never sends). A true liveness probe is TODO T4.
   */
  async authStatus(): Promise<{ connected: boolean; detail?: string }> {
    if (this.apiKey === undefined || this.apiKey.length === 0) {
      return { connected: false, detail: "COMPOSIO_API_KEY not set" };
    }
    return {
      connected: true,
      detail:
        `COMPOSIO_API_KEY present; user "${this.userId}"` +
        (this.connectedAccountId ? `, connected account "${this.connectedAccountId}"` : "") +
        " (key present — not a live connection check; see TODO T4)",
    };
  }

  async send(msg: EmailMessage): Promise<SendResult> {
    const problem = messageProblem(msg);
    if (problem !== null) return { ok: false, error: problem };
    if (this.apiKey === undefined || this.apiKey.length === 0) {
      return { ok: false, error: "COMPOSIO_API_KEY not set — cannot send" };
    }

    // GMAIL_SEND_EMAIL arguments (verified fields; reply_to is TODO T1).
    const args: Record<string, unknown> = {
      recipient_email: msg.to,
      subject: msg.subject,
      body: msg.body,
      is_html: false,
    };
    if (msg.replyTo !== undefined) args.reply_to = msg.replyTo; // T1: best-effort, ignored if unsupported

    const body: Record<string, unknown> = { user_id: this.userId, arguments: args };
    if (this.connectedAccountId !== undefined) body.connected_account_id = this.connectedAccountId; // T2

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/tools/execute/${SEND_ACTION}`, {
        method: "POST",
        headers: { "x-api-key": this.apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { ok: false, error: `Composio request failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    const text = await res.text();
    if (!res.ok) return { ok: false, error: `Composio ${res.status}: ${text.slice(0, 500)}` };

    let parsed: ExecuteResponse;
    try {
      parsed = JSON.parse(text) as ExecuteResponse;
    } catch {
      return { ok: false, error: `Composio returned non-JSON: ${text.slice(0, 200)}` };
    }

    const ok = parsed.successful === true || (parsed.successful === undefined && !parsed.error);
    if (!ok) return { ok: false, error: parsed.error ?? "Composio reported the send unsuccessful" };
    return { ok: true, id: pickMessageId(parsed.data) };
  }

  /**
   * Return the OAuth authorization URL for connecting a Gmail account, so
   * the operator authorizes ONCE (open the URL, grant Gmail, done). Uses
   * the managed-OAuth "link" flow. Requires COMPOSIO_API_KEY and an
   * auth config id. Throws (naming the missing piece) rather than send.
   *
   * @param callbackUrl optional URL Composio returns the operator to.
   */
  async initiateGmailConnection(callbackUrl?: string): Promise<string> {
    if (this.apiKey === undefined || this.apiKey.length === 0) {
      throw new Error("initiateGmailConnection: COMPOSIO_API_KEY not set");
    }
    if (this.authConfigId === undefined || this.authConfigId.length === 0) {
      throw new Error("initiateGmailConnection: COMPOSIO_GMAIL_AUTH_CONFIG_ID not set (Gmail auth config id from the Composio dashboard)");
    }

    const body: Record<string, unknown> = { user_id: this.userId, auth_config_id: this.authConfigId };
    if (callbackUrl !== undefined) body.callback_url = callbackUrl;

    // SDK equivalent: composio.connectedAccounts.link(userId, authConfigId, { callbackUrl })
    const res = await fetch(`${this.baseUrl}/connected_accounts/link`, {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`initiateGmailConnection: Composio ${res.status}: ${text.slice(0, 500)}`);

    const parsed = JSON.parse(text) as Record<string, unknown>;
    const url = pickRedirectUrl(parsed); // T3
    if (url === undefined) {
      throw new Error(`initiateGmailConnection: no redirect_url in Composio response: ${text.slice(0, 300)}`);
    }
    return url;
  }
}

/** Read the Gmail message id from a few likely paths in the tool output. */
function pickMessageId(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  const candidates = [data["id"], data["message_id"], data["messageId"], (data["response_data"] as Record<string, unknown> | undefined)?.["id"]];
  for (const c of candidates) if (typeof c === "string" && c.length > 0) return c;
  return undefined;
}

/** Read the OAuth redirect URL from top-level or the nested connection data (TODO T3). */
function pickRedirectUrl(obj: Record<string, unknown>): string | undefined {
  const nests = [obj, obj["connectionData"] as Record<string, unknown> | undefined, obj["connection_data"] as Record<string, unknown> | undefined];
  for (const n of nests) {
    if (!n) continue;
    const v = n["redirect_url"] ?? n["redirectUrl"] ?? (n["val"] as Record<string, unknown> | undefined)?.["redirect_url"];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}
