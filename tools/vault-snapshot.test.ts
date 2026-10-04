import { describe, expect, it, vi } from "vitest";
import { parseSnapshotCommand, runSnapshotCommand } from "./vault-snapshot.js";

describe("vault snapshot command", () => {
  it("defaults to the owning live sidecar, never guesses a vault path", () => {
    expect(parseSnapshotCommand(["create", "before-invites"], {})).toEqual({
      action: "create", name: "before-invites", server: "http://127.0.0.1:5175",
    });
    expect(parseSnapshotCommand(["list"], { LOIS_PORT: "6123" })).toEqual({
      action: "list", server: "http://127.0.0.1:6123",
    });
  });

  it("requires a new restore destination and makes offline capture deliberate", () => {
    expect(() => parseSnapshotCommand(["restore", "/snapshot"], {})).toThrow(/--to/);
    expect(parseSnapshotCommand(["restore", "/snapshot", "--to", "/copy"], {}))
      .toEqual({ action: "restore", snapshot: "/snapshot", destination: "/copy" });
    expect(parseSnapshotCommand(["create", "saved", "--offline-vault", "/vault"], {}))
      .toEqual({ action: "create", name: "saved", offlineVault: "/vault" });
    expect(() => parseSnapshotCommand(["create", "saved", "--offline-vault", "/vault", "--server", "http://127.0.0.1:5175"], {}))
      .toThrow(/combine/);
  });

  it("rejects extra arguments and non-loopback live servers", () => {
    for (const args of [["list", "stray"], ["verify"], ["create", "one", "two"], ["list", "--to", "/x"]]) {
      expect(() => parseSnapshotCommand(args, {})).toThrow();
    }
    expect(() => parseSnapshotCommand(["list", "--server", "https://example.com"], {})).toThrow(/loopback/);
  });

  it("sends only the requested name to the bound server", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ ok: true, snapshot: { directory: "/saved" } })));
    await expect(runSnapshotCommand({ action: "create", name: "before-invites", server: "http://127.0.0.1:5175" }, request))
      .resolves.toEqual({ directory: "/saved" });
    expect(request).toHaveBeenCalledWith("http://127.0.0.1:5175/api/lois/snapshots", expect.objectContaining({
      method: "POST", body: JSON.stringify({ name: "before-invites" }),
    }));
  });

  it("surfaces a failed live capture instead of silently copying some other vault", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "checkpoint exists" }), { status: 409 }));
    await expect(runSnapshotCommand({ action: "create", name: "saved", server: "http://127.0.0.1:5175" }, request))
      .rejects.toThrow("checkpoint exists");
    expect(request).toHaveBeenCalledOnce();
  });
});
