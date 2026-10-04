// mock-luma — a harmless, loopback-only platform boundary for the 3Cs smoke.
//
// It is deliberately NOT a Luma adapter and product code must never branch on
// it. The two pages carry the same meaning through different markup, labels,
// ordering, and controls. Chrome performs the form mutation; this server only
// enforces a one-time browser-shaped request and records the receipt.

import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type MockLumaVariant = "v1" | "v2";

export interface MockLumaHistoricalSource {
  eventId: string;
  name: string;
  date: string;
  pagePath: string;
  downloadPath: string;
  filename: string;
  csv: string;
}

export interface MockLumaReceipt {
  schemaVersion: 1;
  receiptId: string;
  runId: string;
  eventId: "3cs";
  variant: MockLumaVariant;
  action: "invite";
  recipients: string[];
  message: string;
  at: string;
  browserDriven: true;
  request: {
    origin: string;
    secFetchSite: "same-origin";
    secFetchMode: "navigate";
    secFetchUser: "?1";
    userAgent: string;
  };
}

export interface StartMockLumaOptions {
  runId: string;
  port?: number;
  now?: () => string;
  receiptId?: () => string;
}

export interface MockLumaServer {
  origin: string;
  variantUrl(variant: MockLumaVariant): string;
  historyUrl(): string;
  sourceUrl(eventId: string): string;
  downloadUrl(eventId: string): string;
  historicalSources(): MockLumaHistoricalSource[];
  receipts(): MockLumaReceipt[];
  close(): Promise<void>;
}

interface PageSession {
  csrf: string;
  variant: MockLumaVariant;
  state: "fresh" | "processing" | "used";
}

interface LoopbackServer {
  once(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  listen(port: number, host: "127.0.0.1", listener: () => void): unknown;
  close(listener: (error?: Error) => void): unknown;
}

const PEOPLE = Object.freeze([
  { id: "maya", name: "Maya Chen", detail: "Joined the last two gatherings" },
  { id: "idris", name: "Idris Bello", detail: "Came once and introduced two people" },
  { id: "samira", name: "Samira Noor", detail: "New to 3Cs" },
]);

const EVENT_TITLE = "3Cs: Community, Care & Curiosity";
const EVENT_DATE = "Thursday, September 17, 2026 at 6:30 PM";
const SESSION_COOKIE = "mock_luma_session";
const MOCK_ACCOUNT_ID = "mock-luma-3cs-host";

const HISTORICAL_SOURCES: readonly MockLumaHistoricalSource[] = Object.freeze([
  Object.freeze({
    eventId: "3cs-2026-07-12",
    name: "3Cs Summer Table",
    date: "2026-07-12",
    pagePath: "/account/3cs/history/3cs-2026-07-12",
    downloadPath: "/account/3cs/history/3cs-2026-07-12/export.csv",
    filename: "3cs-summer-table.csv",
    csv: [
      "Registration ID,Full name,Email,RSVP,Attendance",
      "jul-001,Nina Patel,nina.patel@example.test,Going,Checked in",
      "jul-002,Jordan Lee,jordan.summer@example.test,Going,Checked in",
      "jul-003,Casey Morgan,,Going,",
      "jul-004,Priya Shah,priya.shah@example.test,Invited,",
      "",
    ].join("\n"),
  }),
  Object.freeze({
    eventId: "3cs-2026-08-09",
    name: "3Cs Late Summer Table",
    date: "2026-08-09",
    pagePath: "/account/3cs/history/3cs-2026-08-09",
    downloadPath: "/account/3cs/history/3cs-2026-08-09/download",
    filename: "guestlist-export",
    csv: [
      "Registration ID,Full name,Email,RSVP,Attendance",
      "aug-001,Nina Patel,nina.patel@example.test,Going,Checked in",
      "aug-002,Jordan Lee,jordan.winter@example.test,Going,Checked in",
      "aug-003,Casey Morgan,,Going,",
      "aug-004,Priya Shah,priya.shah@example.test,Going,Checked in",
      "",
    ].join("\n"),
  }),
]);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pageShell(content: string, title = `${EVENT_TITLE} · local event workspace`): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; color: #24201f; background: #f5f0e8; }
    body { margin: 0; }
    main { max-width: 760px; margin: 36px auto; padding: 32px; background: #fffdf8; border: 1px solid #d8cfc0; border-radius: 18px; box-shadow: 0 18px 55px rgba(64, 48, 34, .12); }
    h1, h2 { font-family: Georgia, serif; }
    .local-note { padding: 10px 12px; background: #e7f3e7; border: 1px solid #b7d5b8; border-radius: 9px; }
    .person, option { line-height: 1.45; }
    fieldset { border: 0; padding: 0; margin: 24px 0; }
    label, legend { font-weight: 650; }
    textarea, select { box-sizing: border-box; width: 100%; margin-top: 8px; padding: 10px; font: inherit; }
    button { border: 0; border-radius: 999px; padding: 11px 18px; color: white; background: #2f5b3b; font: inherit; font-weight: 700; cursor: pointer; }
    .rows { display: grid; gap: 10px; margin-top: 12px; }
    .person { padding: 12px; border: 1px solid #ddd3c4; border-radius: 10px; }
    small { display: block; color: #6f675e; }
  </style>
</head>
<body>${content}</body>
</html>`;
}

function renderV1(csrf: string): string {
  const people = PEOPLE.map(
    (person) => `<label class="person">
      <input type="checkbox" name="recipient" value="${person.id}">
      <span>${escapeHtml(person.name)}</span>
      <small>${escapeHtml(person.detail)}</small>
    </label>`,
  ).join("\n");
  return pageShell(`<main>
  <p class="local-note">Local Superpowers smoke. Nothing here reaches a real guest.</p>
  <header><h1>${EVENT_TITLE}</h1><p>${EVENT_DATE}</p></header>
  <form method="post" action="/event/3cs/invitations">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <fieldset><legend>Choose guests</legend><div class="rows">${people}</div></fieldset>
    <label>Invitation note<textarea name="message" rows="5" required></textarea></label>
    <p><button type="submit">Send invitations</button></p>
  </form>
</main>`);
}

function renderV2(csrf: string): string {
  const options = PEOPLE.map(
    (person) => `<option value="${person.id}">${escapeHtml(person.name)} — ${escapeHtml(person.detail)}</option>`,
  ).join("\n");
  return pageShell(`<main>
  <aside class="local-note">Safe rehearsal workspace · local only · no real delivery</aside>
  <form method="post" action="/event/3cs/invitations">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <section aria-labelledby="draft-heading">
      <h2 id="draft-heading">A note from the host</h2>
      <textarea aria-label="Message for the invitation" name="message" rows="5" required></textarea>
    </section>
    <section aria-labelledby="people-heading">
      <h2 id="people-heading">Who should get the note?</h2>
      <select name="recipient" aria-label="People" multiple size="3" required>${options}</select>
    </section>
    <p><button type="submit">Invite the selected people</button></p>
  </form>
  <footer><h1>${EVENT_TITLE}</h1><p>${EVENT_DATE}</p></footer>
</main>`);
}

function renderHistoricalIndex(origin: string): string {
  const rows = HISTORICAL_SOURCES.map((source) => `<li>
    <a href="${escapeHtml(source.pagePath)}">${escapeHtml(source.name)}</a>
    <small>Luma account ${escapeHtml(MOCK_ACCOUNT_ID)} · event ${escapeHtml(source.eventId)} · ${escapeHtml(source.date)}</small>
  </li>`).join("\n");
  return pageShell(`<main>
  <p class="local-note">Synthetic Luma history for a local import canary. Downloads are local CSV fixtures.</p>
  <header>
    <h1>Host history for 3Cs</h1>
    <p>Signed-in source account: <strong>${escapeHtml(MOCK_ACCOUNT_ID)}</strong></p>
    <p>History URL: ${escapeHtml(origin)}/account/3cs/history</p>
  </header>
  <section aria-labelledby="events-heading">
    <h2 id="events-heading">Historical guest lists</h2>
    <ul>${rows}</ul>
  </section>
</main>`);
}

function renderHistoricalSource(origin: string, source: MockLumaHistoricalSource): string {
  return pageShell(`<main>
  <p class="local-note">Local-only source page. This is historical guest-list membership, not a future event.</p>
  <header>
    <h1>${escapeHtml(source.name)}</h1>
    <p>Luma account ${escapeHtml(MOCK_ACCOUNT_ID)}</p>
    <p>Event identity: <strong>${escapeHtml(source.eventId)}</strong></p>
    <p>Date: <time datetime="${escapeHtml(source.date)}">${escapeHtml(source.date)}</time></p>
  </header>
  <section aria-labelledby="identity-heading">
    <h2 id="identity-heading">Registration identity semantics</h2>
    <p>Registration records are exported by the signed-in host account. The Email column is the address a guest used on their Luma registration.</p>
    <p>Some registration records in this export do not include an email address.</p>
  </section>
  <p>
    <a download="${escapeHtml(source.filename)}" href="${escapeHtml(source.downloadPath)}">
      Download registered guests CSV for ${escapeHtml(source.name)}
    </a>
  </p>
  <p><a href="/account/3cs/history">Back to host history</a></p>
  <small>Canonical source URL: ${escapeHtml(origin)}${escapeHtml(source.pagePath)}</small>
</main>`);
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'",
  );
}

function html(res: ServerResponse, status: number, content: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  securityHeaders(res);
  res.end(content);
}

function text(res: ServerResponse, status: number, content: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  securityHeaders(res);
  res.end(content);
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function readBody(req: IncomingMessage, maxBytes = 32 * 1024): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function copyReceipt(receipt: MockLumaReceipt): MockLumaReceipt {
  return {
    ...receipt,
    recipients: [...receipt.recipients],
    request: { ...receipt.request },
  };
}

function assertRunId(runId: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) {
    throw new Error("Mock Luma run id must use lowercase letters, digits, and internal hyphens only.");
  }
}

async function listenOnLoopback(server: LoopbackServer, port: number): Promise<void> {
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolveListen();
      });
    });
  } catch (error) {
    await new Promise<void>((resolveClose) => {
      try {
        server.close(() => resolveClose());
      } catch {
        resolveClose();
      }
    });
    throw error;
  }
}

export const __mockLumaTest = {
  listen: listenOnLoopback,
};

// Source pages only: no Person registry entries, oracle outcomes, or agent instructions.
const NETWORK_PROFILES = [
  { id: "nina-patel", name: "Nina Patel", topic: "fundraising", headline: "Angel investor and former startup founder", about: "I invest in early-stage AI software companies and help founders prepare their first fundraising round.", email: "nina.patel@example.test" },
  { id: "amara-chen", name: "Amara Chen", topic: "fundraising", headline: "Seed-stage venture investor", about: "I back teams building AI agents and developer tools, and connect technical founders with early-stage investors.", email: "amara.chen@example.test" },
  { id: "owen-park", name: "Owen Park", topic: "design", headline: "Ceramics and furniture designer", about: "I design small-batch furniture and teach weekend pottery classes.", email: "owen.park@example.test" },
] as const;

function renderNetwork(path: string): string | undefined {
  const header = `<p class="local-note">Local professional-network rehearsal. Fictional people; no messages are sent.</p>
    <p>LinkedIn-like network · signed-in account: <strong>mock-network-organizer</strong></p>`;
  if (path === "/network") return pageShell(`<main>${header}<h1>Your professional network</h1>
    <p>Browse people by their work and interests.</p><nav><ul>
    <li><a href="/network/people/fundraising">Startups and investment</a></li>
    <li><a href="/network/people/design">Design and craft</a></li>
    </ul></nav></main>`, "Your professional network · local rehearsal");
  const topic = path.match(/^\/network\/people\/(fundraising|design)$/)?.[1];
  if (topic) return pageShell(`<main>${header}<a href="/network">Your network</a>
    <h1>${topic === "fundraising" ? "Startups and investment" : "Design and craft"}</h1>
    ${NETWORK_PROFILES.filter(profile => profile.topic === topic).map(profile => `<article>
      <h2><a href="/network/in/${profile.id}">${escapeHtml(profile.name)}</a></h2><p>${escapeHtml(profile.headline)}</p>
    </article>`).join("")}
    ${topic === "fundraising" ? `<article><h2>Devon Brooks</h2><p>Community member suggestion · reference: suggestion-devon-brooks</p>
      <p>Startup founder who hosts introductions between AI builders, angel investors, and seed funds.</p>
      <p>No profile or contact details shared.</p></article>` : ""}
    </main>`, "People by interest · local rehearsal");
  const profile = NETWORK_PROFILES.find(item => path === `/network/in/${item.id}`);
  if (!profile) return undefined;
  return pageShell(`<main>${header}<a href="/network/people/${profile.topic}">People in this field</a>
    <h1>${escapeHtml(profile.name)}</h1><p>${escapeHtml(profile.headline)}</p>
    <p>Profile ID: ${profile.id}</p><h2>About</h2><p>${escapeHtml(profile.about)}</p>
    <h2>Contact information</h2><p>Email, member supplied and verified: ${escapeHtml(profile.email)}</p>
    </main>`, `${profile.name} · professional profile`);
}

export async function startMockLuma(options: StartMockLumaOptions): Promise<MockLumaServer> {
  assertRunId(options.runId);
  const sessions = new Map<string, PageSession>();
  const receiptSessions = new Map<string, string>();
  const receiptLog: MockLumaReceipt[] = [];
  const now = options.now ?? (() => new Date().toISOString());
  const nextReceiptId = options.receiptId ?? (() => `receipt-${randomUUID()}`);
  let origin = "";

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      const network = req.method === "GET" ? renderNetwork(url.pathname) : undefined;
      if (network) {
        html(res, 200, network);
        return;
      }

      if (req.method === "GET" && url.pathname === "/account/3cs/history") {
        html(res, 200, renderHistoricalIndex(origin));
        return;
      }

      const source = HISTORICAL_SOURCES.find((item) => item.pagePath === url.pathname);
      if (req.method === "GET" && source) {
        html(res, 200, renderHistoricalSource(origin, source));
        return;
      }

      const download = HISTORICAL_SOURCES.find((item) => item.downloadPath === url.pathname);
      if (req.method === "GET" && download) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${download.filename}"`);
        securityHeaders(res);
        res.end(download.csv);
        return;
      }

      if (req.method === "GET" && url.pathname === "/event/3cs") {
        const variant: MockLumaVariant = url.searchParams.get("shape") === "v2" ? "v2" : "v1";
        const sessionId = randomUUID();
        const csrf = randomUUID();
        sessions.set(sessionId, { csrf, variant, state: "fresh" });
        res.setHeader(
          "Set-Cookie",
          `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict`,
        );
        html(res, 200, variant === "v1" ? renderV1(csrf) : renderV2(csrf));
        return;
      }

      if (req.method === "POST" && url.pathname === "/event/3cs/invitations") {
        const sessionId = cookieValue(req, SESSION_COOKIE);
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (!sessionId || !session) {
          text(res, 403, "No issued mock-browser session.");
          return;
        }
        if (session.state !== "fresh") {
          text(res, 409, "This mock-browser session is already processing or has produced a receipt.");
          return;
        }
        if (
          req.headers.origin !== origin ||
          req.headers["sec-fetch-site"] !== "same-origin" ||
          req.headers["sec-fetch-mode"] !== "navigate" ||
          req.headers["sec-fetch-user"] !== "?1"
        ) {
          text(res, 403, "The mock mutation must come from an activated same-origin browser form.");
          return;
        }

        // Admission is atomic and happens before the first body-read await.
        // A concurrent replay sees `processing` and cannot mint a second receipt.
        session.state = "processing";

        let form: URLSearchParams;
        try {
          form = new URLSearchParams(await readBody(req));
        } catch {
          session.state = "fresh";
          text(res, 413, "Mock invitation form is too large.");
          return;
        }
        if (form.get("csrf") !== session.csrf) {
          session.state = "fresh";
          text(res, 403, "The mock invitation token is invalid.");
          return;
        }
        const allowed = new Set(PEOPLE.map((person) => person.id));
        const recipients = [...new Set(form.getAll("recipient"))];
        const message = (form.get("message") ?? "")
          .replaceAll("\r\n", "\n")
          .replaceAll("\r", "\n")
          .trim();
        if (recipients.length === 0 || recipients.some((id) => !allowed.has(id))) {
          session.state = "fresh";
          text(res, 422, "Choose one or more people from this mock event.");
          return;
        }
        if (message.length === 0 || message.length > 2_000) {
          session.state = "fresh";
          text(res, 422, "Write a mock invitation note between 1 and 2000 characters.");
          return;
        }

        const receiptId = nextReceiptId();
        if (!/^[a-zA-Z0-9-]{1,80}$/.test(receiptId) || receiptLog.some((r) => r.receiptId === receiptId)) {
          session.state = "fresh";
          text(res, 500, "Could not allocate a unique mock receipt.");
          return;
        }
        const receipt: MockLumaReceipt = Object.freeze({
          schemaVersion: 1,
          receiptId,
          runId: options.runId,
          eventId: "3cs",
          variant: session.variant,
          action: "invite",
          recipients: Object.freeze([...recipients]) as unknown as string[],
          message,
          at: now(),
          browserDriven: true,
          request: Object.freeze({
            origin,
            secFetchSite: "same-origin",
            secFetchMode: "navigate",
            secFetchUser: "?1",
            userAgent: req.headers["user-agent"] ?? "",
          }),
        });
        session.state = "used";
        receiptLog.push(receipt);
        receiptSessions.set(receiptId, sessionId);
        res.statusCode = 303;
        res.setHeader("Location", `/receipts/${encodeURIComponent(receiptId)}`);
        securityHeaders(res);
        res.end();
        return;
      }

      const receiptMatch = req.method === "GET" ? url.pathname.match(/^\/receipts\/([a-zA-Z0-9-]+)$/) : null;
      if (receiptMatch) {
        const receipt = receiptLog.find((item) => item.receiptId === receiptMatch[1]);
        const sessionId = cookieValue(req, SESSION_COOKIE);
        if (!receipt || !sessionId || receiptSessions.get(receipt.receiptId) !== sessionId) {
          text(res, 404, "No receipt for this mock-browser session.");
          return;
        }
        const names = receipt.recipients
          .map((id) => PEOPLE.find((person) => person.id === id)?.name ?? id)
          .join(", ");
        html(
          res,
          200,
          pageShell(`<main data-receipt-id="${escapeHtml(receipt.receiptId)}">
  <p class="local-note">Local receipt recorded. No real invitation was delivered.</p>
  <h1>Invitation rehearsal complete</h1>
  <p>Receipt <strong>${escapeHtml(receipt.receiptId)}</strong></p>
  <p>Selected people: ${escapeHtml(names)}</p>
  <p>Run: ${escapeHtml(receipt.runId)} · shape: ${receipt.variant}</p>
</main>`),
        );
        return;
      }

      text(res, 404, "No such local mock route.");
    })().catch((error) => {
      if (!res.writableEnded) text(res, 500, error instanceof Error ? error.message : "Mock server error.");
    });
  });

  await listenOnLoopback(server, options.port ?? 0);
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    variantUrl: (variant) => `${origin}/event/3cs?shape=${variant}`,
    historyUrl: () => `${origin}/account/3cs/history`,
    sourceUrl: (eventId) => {
      const source = HISTORICAL_SOURCES.find((item) => item.eventId === eventId);
      if (!source) throw new Error(`Unknown mock Luma historical source: ${eventId}`);
      return `${origin}${source.pagePath}`;
    },
    downloadUrl: (eventId) => {
      const source = HISTORICAL_SOURCES.find((item) => item.eventId === eventId);
      if (!source) throw new Error(`Unknown mock Luma historical source: ${eventId}`);
      return `${origin}${source.downloadPath}`;
    },
    historicalSources: () => HISTORICAL_SOURCES.map((source) => ({ ...source })),
    receipts: () => receiptLog.map(copyReceipt),
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}
