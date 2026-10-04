import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __mockLumaTest, startMockLuma, type MockLumaServer } from "./mock-luma.js";

const importScenario = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "people-import-scenario.json"), "utf8")) as {
  sources: Array<{ eventId: string; sha256: string }>;
};

const servers: MockLumaServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function browserPostHeaders(cookie: string): Record<string, string> {
  return {
    "content-type": "application/x-www-form-urlencoded",
    cookie,
    origin: "http://127.0.0.1",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "navigate",
    "sec-fetch-user": "?1",
    "user-agent": "Mozilla/5.0 Mock Chrome",
  };
}

function csrfFrom(html: string): string {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  if (!match) throw new Error("fixture did not expose csrf field");
  return match[1];
}

function postBrowserForm(
  url: string,
  headers: Record<string, string>,
  body: URLSearchParams,
): Promise<{ status: number; location?: string; body: string }> {
  const encoded = body.toString();
  return new Promise((resolvePost, reject) => {
    const req = request(url, {
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(encoded)) },
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on("end", () =>
        resolvePost({
          status: res.statusCode ?? 0,
          location: typeof res.headers.location === "string" ? res.headers.location : undefined,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    req.end(encoded);
  });
}

function beginBrowserForm(
  url: string,
  headers: Record<string, string>,
  body: URLSearchParams,
): { send(): void; result: Promise<{ status: number; location?: string; body: string }> } {
  const encoded = body.toString();
  let resolvePost!: (value: { status: number; location?: string; body: string }) => void;
  let rejectPost!: (error: Error) => void;
  const result = new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
    resolvePost = resolve;
    rejectPost = reject;
  });
  const req = request(url, {
    method: "POST",
    headers: { ...headers, "content-length": String(Buffer.byteLength(encoded)) },
  });
  req.on("response", (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    res.on("end", () =>
      resolvePost({
        status: res.statusCode ?? 0,
        location: typeof res.headers.location === "string" ? res.headers.location : undefined,
        body: Buffer.concat(chunks).toString("utf8"),
      }),
    );
  });
  req.on("error", rejectPost);
  req.flushHeaders();
  return { send: () => req.end(encoded), result };
}

describe("local mock Luma boundary", () => {
  it("closes the server object when loopback acquisition fails", async () => {
    let rejectListen: ((error: Error) => void) | undefined;
    let closed = false;
    const server = {
      once: (_event: string, listener: (error: Error) => void) => {
        rejectListen = listener;
      },
      off: () => undefined,
      listen: () => queueMicrotask(() => rejectListen?.(new Error("listen failed"))),
      close: (callback: () => void) => {
        closed = true;
        callback();
      },
    };

    await expect(__mockLumaTest.listen(server, 0)).rejects.toThrow("listen failed");
    expect(closed).toBe(true);
  });

  it("serves two different page shapes with the same semantic event and mock people", async () => {
    const server = await startMockLuma({ runId: "variant-proof" });
    servers.push(server);

    const [v1, v2] = await Promise.all([fetch(server.variantUrl("v1")), fetch(server.variantUrl("v2"))]);
    const [one, two] = await Promise.all([v1.text(), v2.text()]);

    expect(v1.status).toBe(200);
    expect(v2.status).toBe(200);
    expect(one).not.toBe(two);
    for (const value of ["3Cs: Community, Care & Curiosity", "Maya Chen", "Idris Bello", "Samira Noor"]) {
      expect(one).toContain(value);
      expect(two).toContain(value);
    }
    expect(one).toContain("Choose guests");
    expect(two).toContain("Who should get the note?");
    expect(one).toContain('type="checkbox"');
    expect(two).toContain("multiple");
    expect(one).not.toContain("lu.ma");
    expect(two).not.toContain("lu.ma");
  });

  it("serves historical account pages with two real CSV download attachments", async () => {
    const server = await startMockLuma({ runId: "history-proof" });
    servers.push(server);

    const index = await fetch(server.historyUrl());
    const indexHtml = await index.text();
    const sources = server.historicalSources();

    expect(index.status).toBe(200);
    expect(sources).toHaveLength(2);
    expect(indexHtml).toContain("Host history for 3Cs");
    expect(indexHtml).toContain("mock-luma-3cs-host");
    for (const source of sources) {
      expect(indexHtml).toContain(source.eventId);
      const page = await fetch(server.sourceUrl(source.eventId));
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html).toContain(source.name);
      expect(html).toContain("Registration identity semantics");
      expect(html).toContain("The Email column is the address a guest used on their Luma registration");
      expect(html).not.toContain("different identities");

      const download = await fetch(server.downloadUrl(source.eventId));
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toContain("text/csv");
      expect(download.headers.get("content-disposition")).toContain(source.filename);
      const csv = await download.text();
      expect(csv).toBe(source.csv);
      expect(createHash("sha256").update(csv).digest("hex")).toBe(
        importScenario.sources.find((item) => item.eventId === source.eventId)?.sha256,
      );
    }
    expect(sources.map((source) => source.filename)).toContain("guestlist-export");
  });

  it("lets browser readers discover fundraising profiles and a list-only suggestion without an answer list", async () => {
    const server = await startMockLuma({ runId: "network-proof" });
    servers.push(server);
    const home = await fetch(`${server.origin}/network`);
    expect(home.status).toBe(200);
    const homeHtml = await home.text();
    expect(homeHtml).toContain('href="/network/people/fundraising"');
    expect(homeHtml).toContain('href="/network/people/design"');
    expect(homeHtml).not.toContain("Nina Patel");
    const directory = await fetch(`${server.origin}/network/people/fundraising`);
    const directoryHtml = await directory.text();
    expect(directoryHtml).toContain('href="/network/in/nina-patel"');
    expect(directoryHtml).toContain('href="/network/in/amara-chen"');
    expect(directoryHtml).toContain("Devon Brooks");
    expect(directoryHtml).toContain("No profile or contact details shared");
    expect(directoryHtml).not.toContain("nina.patel@example.test");
    const profile = await fetch(`${server.origin}/network/in/nina-patel`);
    const profileHtml = await profile.text();
    expect(profile.status).toBe(200);
    expect(profileHtml).toContain("nina.patel@example.test");
    expect(profileHtml).toContain("member supplied and verified");
    expect(profileHtml).toContain("early-stage AI software companies");
    expect(profileHtml).not.toMatch(/charit|philanthrop|donor|nonprofit/i);
    expect(profileHtml).not.toMatch(/recurring|expected|people_save_prospect|guestlist_saved/i);
    expect(profileHtml).not.toContain("<form");
    expect((await fetch(`${server.origin}/network/in/missing`)).status).toBe(404);
    expect((await fetch(`${server.origin}/network/people/fundraising`, { method: "POST" })).status).toBe(404);
    expect(server.receipts()).toEqual([]);
  });

  it("refuses direct or stale mutation attempts without recording a receipt", async () => {
    const server = await startMockLuma({ runId: "refusal-proof" });
    servers.push(server);
    const page = await fetch(server.variantUrl("v1"));
    const html = await page.text();
    const cookie = page.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const body = new URLSearchParams({ csrf: csrfFrom(html), recipient: "maya", message: "Come to 3Cs." });

    const direct = await fetch(`${server.origin}/event/3cs/invitations`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body,
      redirect: "manual",
    });

    expect(direct.status).toBe(403);
    expect(server.receipts()).toEqual([]);
  });

  it("records one browser-driven receipt and refuses replay", async () => {
    const server = await startMockLuma({
      runId: "receipt-proof",
      now: () => "2026-08-29T12:00:00.000Z",
      receiptId: () => "receipt-001",
    });
    servers.push(server);
    const page = await fetch(server.variantUrl("v2"));
    const html = await page.text();
    const cookie = page.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const body = new URLSearchParams([
      ["csrf", csrfFrom(html)],
      ["recipient", "maya"],
      ["recipient", "samira"],
      ["message", "I would love to have you at 3Cs.\r\n\r\nCan you come?"],
    ]);
    const headers = browserPostHeaders(cookie);
    headers.origin = server.origin;

    const sent = await postBrowserForm(`${server.origin}/event/3cs/invitations`, headers, body);

    expect(sent.status).toBe(303);
    expect(sent.location).toBe("/receipts/receipt-001");
    expect(server.receipts()).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        receiptId: "receipt-001",
        runId: "receipt-proof",
        eventId: "3cs",
        variant: "v2",
        action: "invite",
        recipients: ["maya", "samira"],
        message: "I would love to have you at 3Cs.\n\nCan you come?",
        at: "2026-08-29T12:00:00.000Z",
        browserDriven: true,
      }),
    ]);

    const receiptPage = await fetch(`${server.origin}/receipts/receipt-001`, { headers: { cookie } });
    expect(receiptPage.status).toBe(200);
    expect(await receiptPage.text()).toContain("receipt-001");

    const replay = await postBrowserForm(`${server.origin}/event/3cs/invitations`, headers, body);
    expect(replay.status).toBe(409);
    expect(server.receipts()).toHaveLength(1);
  });

  it("atomically admits only one of two concurrent posts for the same session", async () => {
    let receipt = 0;
    const server = await startMockLuma({
      runId: "concurrent-proof",
      receiptId: () => `receipt-${++receipt}`,
    });
    servers.push(server);
    const page = await fetch(server.variantUrl("v1"));
    const html = await page.text();
    const cookie = page.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const body = new URLSearchParams({
      csrf: csrfFrom(html),
      recipient: "idris",
      message: "Join us for a local-only 3Cs rehearsal.",
    });
    const headers = { ...browserPostHeaders(cookie), origin: server.origin };
    const first = beginBrowserForm(`${server.origin}/event/3cs/invitations`, headers, body);
    const second = beginBrowserForm(`${server.origin}/event/3cs/invitations`, headers, body);

    // Let both server handlers reach their first body-read await before either
    // client releases a body. This deterministically exercises admission.
    await new Promise<void>((resolveTurn) => setTimeout(resolveTurn, 50));
    first.send();
    second.send();
    const responses = await Promise.all([first.result, second.result]);

    expect(responses.map((response) => response.status).sort()).toEqual([303, 409]);
    expect(server.receipts()).toHaveLength(1);
  });
});
