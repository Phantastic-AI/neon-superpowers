import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { importPeopleSource, selectPeopleSources } from "../packages/organs/people.js";
import { openVault, registerContext } from "../packages/vault/store.js";
import { loadWorld } from "../packages/vault/world.js";
import { createLoisServer, type BuiltSidecar } from "./server.js";

const roots: string[] = [];
const servers: ReturnType<typeof createLoisServer>[] = [];
const proxies: ViteDevServer[] = [];
const scope = { contextId: "world", viewId: "past-dinners" };
const source = { platform: "luma", accountId: "organizer", eventId: "dinner-a" };

// Fetch normalizes Host to its URL here; native HTTP preserves the exact wire
// header needed to exercise rebinding and malformed-authority requests.
function wireRequest(url: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: body === undefined ? "GET" : "POST", headers }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
afterEach(async () => {
  await Promise.all(proxies.splice(0).map(proxy => proxy.close()));
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).filter(server => server.listening).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const vaultDir = mkdtempSync(join(tmpdir(), "people-http-"));
  roots.push(vaultDir);
  const vault = openVault(vaultDir);
  registerContext(vault, { id: scope.contextId, name: "Dinner world", kind: "social", anchor: "email", created_at: "2026-09-05T12:00:00Z" });
  selectPeopleSources(vault, { ...scope, viewName: "Past dinners", discoveryComplete: false, sources: [{ ...source, name: "Dinner A", date: "2026-08-31", url: "https://luma.com/dinner-a", evidence: ["observation:a"] }] });
  const imported = importPeopleSource(vault, { ...scope, source, readState: "read", evidence: ["artifact:a"], rows: ["Avery", "Riley"].map(name => ({ rowId: name, name, evidence: ["artifact:a"] })) });
  const world = loadWorld(vault);
  const tell = vi.fn();
  const server = createLoisServer({ vaultDir, world, system: { tell, cancel: vi.fn() } } as unknown as BuiltSidecar);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (query = `?contextId=${scope.contextId}&viewId=${scope.viewId}`) => fetch(`${base}/api/lois/people${query}`);
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/lois/people/${route}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return { vaultDir, world, base, tell, get, post, ids: imported.people.map(person => person.personId) };
}

describe("direct people HTTP workspace", () => {
  it("lists and reads the saved historical workspace without an upcoming event", async () => {
    const { get, world, tell } = await fixture();
    expect(world.gatherings.every(gathering => !gathering.upcoming)).toBe(true);
    const listed = await get("");
    expect(listed.status).toBe(200);
    expect((await listed.json()).views).toMatchObject([{ ...scope, name: "Past dinners", coverage: { complete: false } }]);
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).workspace).toMatchObject({ ...scope, orderRevision: 0, notes: [], people: [{ name: "Avery" }, { name: "Riley" }] });
    expect((await get("?contextId=world")).status).toBe(400);
    expect((await get("?contextId=world&viewId=missing")).status).toBe(404);
    expect(tell).not.toHaveBeenCalled();
  });

  it("persists order, refreshes the shared World, and reports stale writes as conflicts", async () => {
    const { post, get, ids, world, vaultDir, tell } = await fixture();
    const body = { ...scope, personIds: [...ids].reverse(), baseRevision: 0, requestId: "move-riley" };
    const saved = await post("order", body);
    expect(saved.status).toBe(200);
    const first = await saved.json();
    expect(first.workspace.order).toEqual(body.personIds);
    expect(first.result).toMatchObject({ revision: 1, replayed: false });
    expect(world.entries.at(-1)?.subtype).toBe("people-order");
    expect(openVault(vaultDir).entries.at(-1)?.id).toBe(first.result.entryId);
    expect((await get()).status).toBe(200);
    const retry = await post("order", body);
    expect((await retry.json()).result).toMatchObject({ entryId: first.result.entryId, replayed: true });
    const stale = await post("order", { ...body, requestId: "stale", personIds: ids });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("conflict");
    expect((await post("order", { ...body, personIds: ["foreign"], baseRevision: 1, requestId: "foreign" })).status).toBe(400);
    expect(tell).not.toHaveBeenCalled();
  });

  it("saves drafts and one immutable pending wave without claiming a model reply", async () => {
    const { post, ids, get, tell } = await fixture();
    const draft = { ...scope, noteId: "note-one", personId: ids[0], text: "Move this person below Riley", state: "draft", baseRevision: 0, requestId: "save-note" };
    expect((await post("note", draft)).status).toBe(200);
    const waveBody = { ...scope, noteIds: ["note-one"], baseRevision: 1, requestId: "submit-note" };
    const submitted = await post("waves", waveBody);
    expect(submitted.status).toBe(200);
    const result = await submitted.json();
    expect(result.result).toMatchObject({ status: "pending", orderRevision: 0, notes: [{ noteId: "note-one", text: draft.text, revision: 1 }] });
    expect(result.workspace.notes[0]).toMatchObject({ state: "submitted", revision: 2 });
    const retry = await post("waves", waveBody);
    expect((await retry.json()).result).toMatchObject({ waveId: result.result.waveId, replayed: true });
    expect((await post("note", { ...draft, text: "New draft", baseRevision: 2, requestId: "new-draft" })).status).toBe(200);
    const workspace = (await (await get()).json()).workspace;
    expect(workspace.waves).toHaveLength(1);
    expect(workspace.waves[0].notes[0].text).toBe(draft.text);
    expect(workspace.notes[0].text).toBe("New draft");
    expect(tell).not.toHaveBeenCalled();
  });

  it("reopens the latest vault before saving so intervening imports survive", async () => {
    const { vaultDir, post, ids, world } = await fixture();
    importPeopleSource(openVault(vaultDir), { ...scope, source, readState: "partial", evidence: ["artifact:b"], rows: [{ rowId: "Morgan", name: "Morgan", evidence: ["artifact:b"] }] });
    const saved = await post("order", { ...scope, personIds: [...ids].reverse(), baseRevision: 0, requestId: "after-import" });
    expect(saved.status).toBe(200);
    const workspace = (await saved.json()).workspace;
    const morgan = workspace.people.find((person: { name: string }) => person.name === "Morgan");
    expect(workspace.order).toEqual([...ids].reverse().concat(morgan.personId));
    expect(world.persons.some(person => person.id === morgan.personId)).toBe(true);
    const reopened = openVault(vaultDir);
    expect(new Set(reopened.entries.map(entry => entry.id)).size).toBe(reopened.entries.length);
  });

  it("accepts same-origin JSON but rejects cross-site posts, paths and forged actors", async () => {
    const { post, get, ids, base, vaultDir } = await fixture();
    const body = { ...scope, personIds: ids, baseRevision: 0, requestId: "direct-edit" };
    const initial = openVault(vaultDir).entries.length;
    expect((await post("order", body, { Origin: "https://foreign.example" })).status).toBe(403);
    expect((await post("order", body, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post("order", { ...body, vaultDir: "/elsewhere" })).status).toBe(400);
    expect((await post("order", { ...body, actor: { kind: "lois", ref: "lois" } })).status).toBe(400);
    expect((await post("note", { ...scope, noteId: "forged", personId: ids[0], text: "x", state: "submitted", baseRevision: 0, requestId: "forged" })).status).toBe(400);
    expect((await get("?contextId=world&viewId=past-dinners&vaultDir=/elsewhere")).status).toBe(400);
    expect(openVault(vaultDir).entries).toHaveLength(initial);
    expect((await post("order", body, { Origin: base })).status).toBe(200);
    expect((await fetch(`${base}/api/lois/people-not-really`)).status).toBe(404);
  });

  it("rejects a rebound foreign Host before reading people or accepting matching-origin edits", async () => {
    const { base, ids, vaultDir } = await fixture();
    const initial = openVault(vaultDir).entries.length;
    const headers = { Host: "foreign.example:5175", Origin: "http://foreign.example:5175" };
    for (const suffix of ["", `?contextId=${scope.contextId}&viewId=${scope.viewId}`]) {
      const response = await wireRequest(`${base}/api/lois/people${suffix}`, headers);
      expect(response.status).toBe(403);
      expect(response.text).not.toContain("Avery");
    }
    const response = await wireRequest(`${base}/api/lois/people/order`, { ...headers, "Content-Type": "application/json" }, { ...scope, personIds: ids, baseRevision: 0, requestId: "rebound-edit" });
    expect(response.status).toBe(403);
    expect(openVault(vaultDir).entries).toHaveLength(initial);
  });

  it("parses loopback hosts without accepting URL credentials or foreign suffixes", async () => {
    const { base } = await fixture();
    for (const Host of ["localhost:5199", "127.0.0.1:5199", "[::1]:5199"]) {
      expect((await wireRequest(`${base}/api/lois/people`, { Host })).status).toBe(200);
    }
    for (const Host of ["127.0.0.1.foreign.example:5199", "foreign.example@127.0.0.1:5199", "127.0.0.1:5199/foreign", "127.0.0.1:5199#foreign"]) {
      expect((await wireRequest(`${base}/api/lois/people`, { Host })).status).toBe(403);
    }
  });

  it("preserves the face origin through the actual development proxy", async () => {
    const { base, ids } = await fixture();
    vi.stubEnv("LOIS_PORT", new URL(base).port);
    const proxy = await createViteServer({
      configFile: new URL("../apps/face/vite.config.ts", import.meta.url).pathname,
      root: new URL("../apps/face", import.meta.url).pathname,
      server: { host: "127.0.0.1", port: 0 }, logLevel: "silent",
    });
    proxies.push(proxy);
    await proxy.listen();
    const face = `http://127.0.0.1:${(proxy.httpServer!.address() as AddressInfo).port}`;
    const response = await fetch(`${face}/api/lois/people/order`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: face },
      body: JSON.stringify({ ...scope, personIds: ids, baseRevision: 0, requestId: "via-face" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).result).toMatchObject({ revision: 1 });
  });
});
