#!/usr/bin/env -S npx tsx
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  createVaultSnapshot, listVaultSnapshots, restoreVaultSnapshot, verifyVaultSnapshot,
} from "../packages/vault/snapshot.js";

const HELP = `Vault checkpoints (database only; never browser logins)

pnpm vault:snapshot create before-invites
pnpm vault:snapshot list
pnpm vault:snapshot verify /absolute/path/to/snapshot
pnpm vault:snapshot restore /absolute/path/to/snapshot --to /new/vault/path

create/list use the running sidecar on LOIS_PORT (default 5175).
--server http://127.0.0.1:PORT selects another local sidecar.
create NAME --offline-vault PATH is for a vault whose sole writer is stopped.
list --root PATH lists a snapshot directory without a running app.

Restore makes a NEW copy, never replaces the original. It does not restore
browser sessions, conversation traces, or unfinished jobs. A saved database
cannot undo messages already sent or events already published.
`;

export type SnapshotCommand =
  | { action: "help" }
  | { action: "create"; name: string; server: string; offlineVault?: never }
  | { action: "create"; name: string; offlineVault: string; server?: never }
  | { action: "list"; server: string; root?: never }
  | { action: "list"; root: string; server?: never }
  | { action: "verify"; snapshot: string }
  | { action: "restore"; snapshot: string; destination: string };

export function parseSnapshotCommand(
  args: string[], env: Record<string, string | undefined> = process.env,
): SnapshotCommand {
  const { values, positionals } = parseArgs({
    args: args[0] === "--" ? args.slice(1) : args,
    allowPositionals: true,
    options: {
      server: { type: "string" }, "offline-vault": { type: "string" },
      root: { type: "string" }, to: { type: "string" }, help: { type: "boolean" },
    },
  });
  if (values.help || positionals[0] === "help" || !args.length) return { action: "help" };
  const [action, target] = positionals;
  const requireOptions = (allowed: string[]) => {
    for (const key of Object.keys(values)) {
      if (!allowed.includes(key)) throw new Error(`${action} does not use --${key}.`);
      if (values[key as keyof typeof values] === "") throw new Error(`--${key} needs a value.`);
    }
  };
  const server = () => {
    const url = new URL(values.server ?? `http://127.0.0.1:${env.LOIS_PORT ?? "5175"}`);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("--server must be a loopback HTTP origin.");
    }
    return url.origin;
  };
  if (action === "create" && target && positionals.length === 2) {
    requireOptions(["server", "offline-vault"]);
    if (values.server && values["offline-vault"]) throw new Error("Cannot combine --server and --offline-vault.");
    return values["offline-vault"]
      ? { action, name: target, offlineVault: values["offline-vault"] }
      : { action, name: target, server: server() };
  }
  if (action === "list" && positionals.length === 1) {
    requireOptions(["server", "root"]);
    if (values.server && values.root) throw new Error("Cannot combine --server and --root.");
    return values.root ? { action, root: values.root } : { action, server: server() };
  }
  if (action === "verify" && target && positionals.length === 2) {
    requireOptions([]);
    return { action, snapshot: target };
  }
  if (action === "restore" && target && positionals.length === 2) {
    requireOptions(["to"]);
    if (!values.to) throw new Error("restore needs --to with a new destination directory.");
    return { action, snapshot: target, destination: values.to };
  }
  throw new Error("Use create NAME, list, verify PATH, or restore PATH --to NEW_PATH. See --help.");
}

export async function runSnapshotCommand(command: SnapshotCommand, request: typeof fetch = fetch): Promise<unknown> {
  if (command.action === "help") return HELP;
  if (command.action === "verify") return verifyVaultSnapshot(command.snapshot);
  if (command.action === "restore") return restoreVaultSnapshot(command.snapshot, command.destination);
  if (command.action === "create" && command.offlineVault) return createVaultSnapshot(command.offlineVault, command.name);
  if (command.action === "list" && command.root) return listVaultSnapshots(command.root);
  const response = await request(`${command.server}/api/lois/snapshots`, {
    ...(command.action === "create" ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: command.name }),
    } : {}),
    signal: AbortSignal.timeout(30_000), redirect: "error",
  });
  if (response.status === 404) {
    throw new Error("This sidecar needs the checkpoint update. Restart it with current code, or use --offline-vault with its writer stopped.");
  }
  const payload = await response.json() as { ok: boolean; error?: string; snapshot?: unknown; snapshots?: unknown };
  if (!response.ok || !payload.ok) throw new Error(payload.error ?? `Snapshot request failed (${response.status}).`);
  return command.action === "create" ? payload.snapshot : payload.snapshots;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve().then(() => runSnapshotCommand(parseSnapshotCommand(process.argv.slice(2))))
    .then(result => console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
