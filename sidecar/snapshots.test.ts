import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openVault } from "../packages/vault/store.js";
import { createLoisServer, type BuiltSidecar } from "./server.js";

const roots: string[] = [];
const servers: ReturnType<typeof createLoisServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).filter(server => server.listening).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lois-snapshot-http-"));
  roots.push(root);
  const vaultDir = join(root, "active-vault");
  openVault(vaultDir);
  writeFileSync(join(vaultDir, "diver-job.json"), '{"status":"awaiting_human"}');
  const tell = vi.fn();
  const server = createLoisServer({ vaultDir, system: { tell, cancel: vi.fn() } } as unknown as BuiltSidecar);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { root, vaultDir, base, tell };
}

describe("sidecar-owned vault checkpoints", () => {
  it("captures its bound vault and lists it without calling Lois or restarting jobs", async () => {
    const { vaultDir, base, tell } = await fixture();
    const response = await fetch(`${base}/api/lois/snapshots`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "before-invites" }),
    });
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result.snapshot.manifest.sourceVault).toBe(vaultDir);
    expect(result.snapshot.manifest.counts).toEqual({ entries: 0, persons: 0, contexts: 0, gatherings: 0 });
    expect(readFileSync(join(vaultDir, "diver-job.json"), "utf8")).toContain("awaiting_human");
    expect(existsSync(join(result.snapshot.directory, "diver-job.json"))).toBe(false);
    expect(tell).not.toHaveBeenCalled();
    const listed = await fetch(`${base}/api/lois/snapshots`);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect((await listed.json()).snapshots).toEqual([result.snapshot]);
  });

  it("does not accept arbitrary vault paths or cross-site form posts", async () => {
    const { base } = await fixture();
    const post = (body: unknown, headers: Record<string, string>) => fetch(`${base}/api/lois/snapshots`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
    expect((await post({ name: "x", vaultDir: "/elsewhere" }, { "Content-Type": "application/json" })).status).toBe(400);
    expect((await post({ name: "x" }, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post({ name: "x" }, { "Content-Type": "application/json", Origin: "https://example.com" })).status).toBe(403);
    expect((await fetch(`${base}/api/lois/snapshots-not-really`)).status).toBe(404);
  });

  it("runs the real CLI through live create/list, verification, and a fork-only restore", async () => {
    const { base, root, vaultDir } = await fixture();
    const cli = async (...args: string[]) => {
      const result = await promisify(execFile)("pnpm", ["--silent", "vault:snapshot", ...args], {
        cwd: new URL("..", import.meta.url), timeout: 10_000,
      });
      return JSON.parse(result.stdout);
    };
    const created = await cli("create", "cli-before-invites", "--server", base);
    expect(created.manifest.sourceVault).toBe(vaultDir);
    expect(await cli("list", "--server", base)).toEqual([created]);
    expect(await cli("verify", created.directory)).toEqual(created);
    const restored = await cli("restore", created.directory, "--to", join(root, "cli-copy"));
    expect(restored.directory).toBe(join(root, "cli-copy"));
    expect(existsSync(join(restored.directory, "snapshot-restore.json"))).toBe(true);
    expect(existsSync(join(restored.directory, "diver-job.json"))).toBe(false);
    expect(readFileSync(join(vaultDir, "diver-job.json"), "utf8")).toContain("awaiting_human");
    await expect(cli("restore", created.directory, "--to", vaultDir)).rejects.toThrow();
  }, 20_000);
});
