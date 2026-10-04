// Direct organizer edits do not wait for Lois. The host supplies the vault and
// actor; the client supplies stable object IDs and optimistic revisions.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  PeopleEditError, readPeopleWorkspace, savePeopleNote, savePeopleOrder, submitPeopleNotes,
  type SavePeopleNoteInput, type SavePeopleOrderInput, type SubmitPeopleNotesInput,
} from "../packages/vault/people-edits.js";
import { openVault } from "../packages/vault/store.js";
import { loadWorld } from "../packages/vault/world.js";
import { projectPeopleViews } from "../tools/projections/people.js";
import type { World } from "../tools/projections/types.js";

interface PeopleHost { vaultDir: string; world: World }
const base = "/api/lois/people";
const mutations = new Set([`${base}/order`, `${base}/note`, `${base}/waves`]);

function loopbackOrigin(host: string | undefined): string | undefined {
  if (!host || host !== host.trim()) return undefined;
  try {
    const url = new URL(`http://${host}`);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
    return url.origin;
  } catch { return undefined; }
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}
function invalid(message: string): never { throw new PeopleEditError("invalid", message); }
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("The edit must be a JSON object.");
  const input = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(input).some(key => !allowed.has(key)) || required.some(key => !(key in input))) invalid("The edit has missing or unsupported fields.");
  return input;
}
function scope(input: Record<string, unknown>): { contextId: string; viewId: string; requestId: string } {
  for (const key of ["contextId", "viewId", "requestId"]) if (typeof input[key] !== "string" || !(input[key] as string).trim()) invalid(`${key} must be a non-empty string.`);
  return { contextId: input.contextId as string, viewId: input.viewId as string, requestId: input.requestId as string };
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return invalid("The edit must contain valid JSON."); }
}
function failure(res: ServerResponse, error: unknown): void {
  if (error instanceof PeopleEditError) {
    json(res, error.code === "conflict" ? 409 : error.code === "not_found" ? 404 : 400, { ok: false, code: error.code, error: error.message });
  } else {
    // An IO failure is not an invalid organizer choice; no success is claimed.
    json(res, 500, { ok: false, code: "unavailable", error: "The people workspace could not be read or saved." });
  }
}

/** Returns true only for this exact bounded HTTP surface. */
export function handlePeopleApi(req: IncomingMessage, res: ServerResponse, host: PeopleHost): boolean {
  const path = (req.url ?? "").split("?")[0];
  if (path !== base && !mutations.has(path)) return false;
  // Origin equality alone admits a foreign hostname rebound onto loopback.
  // Check Host before exposing people, including read-only requests. The dev
  // proxy preserves the face's loopback Host; its port need not be ours.
  const origin = loopbackOrigin(req.headers.host);
  if (!origin) {
    json(res, 403, { ok: false, error: "Open the people workspace through the local app." });
    return true;
  }
  const url = new URL(req.url!, "http://localhost");
  if (req.method === "GET" && url.pathname === base) {
    try {
      const params = url.searchParams;
      if ([...params.keys()].some(key => !["contextId", "viewId"].includes(key)) || params.getAll("contextId").length > 1 || params.getAll("viewId").length > 1) invalid("Use one World and one people view.");
      if (!params.size) json(res, 200, { ok: true, views: projectPeopleViews(host.world) });
      else {
        const contextId = params.get("contextId"), viewId = params.get("viewId");
        if (!contextId?.trim() || !viewId?.trim()) invalid("Provide both contextId and viewId.");
        const workspace = readPeopleWorkspace(host.world, contextId, viewId);
        if (!workspace) throw new PeopleEditError("not_found", "People view not found in this World.");
        json(res, 200, { ok: true, workspace });
      }
    } catch (error) { failure(res, error); }
    return true;
  }
  if (req.method !== "POST" || !mutations.has(url.pathname)) {
    res.setHeader("Allow", url.pathname === base ? "GET" : "POST");
    json(res, 405, { ok: false, error: "This people route does not support that method." });
    return true;
  }
  if (req.headers.origin && req.headers.origin !== origin) {
    json(res, 403, { ok: false, error: "Save people changes from the app's own origin." });
    return true;
  }
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
    json(res, 415, { ok: false, error: "People edits need application/json." });
    return true;
  }
  void (async () => {
    try {
      if (url.search) invalid("People edits take their scope in the JSON body.");
      const raw = await readJson(req);
      const common = ["contextId", "viewId", "requestId"];
      const input = url.pathname === `${base}/order`
        ? fields(raw, [...common, "personIds", "baseRevision"])
        : url.pathname === `${base}/note`
          ? fields(raw, [...common, "noteId", "personId", "text", "state", "baseRevision"], ["replyTo"])
          : fields(raw, [...common, "noteIds"], ["baseRevision"]);
      const ids = scope(input);
      // Fresh after the asynchronous body read. Each command and refresh runs
      // synchronously in the owning process, so imports cannot be overwritten
      // by an old in-memory vault handle.
      const vault = openVault(host.vaultDir);
      let result;
      if (url.pathname === `${base}/order`) result = savePeopleOrder(vault, input as unknown as SavePeopleOrderInput);
      else if (url.pathname === `${base}/note`) {
        if (!["draft", "resolved", "hidden"].includes(input.state as string)) invalid("Use the note wave to submit a saved draft.");
        result = savePeopleNote(vault, input as unknown as SavePeopleNoteInput);
      } else result = submitPeopleNotes(vault, input as unknown as SubmitPeopleNotesInput);
      Object.assign(host.world, loadWorld(vault));
      json(res, 200, { ok: true, result, workspace: readPeopleWorkspace(host.world, ids.contextId, ids.viewId) });
    } catch (error) { failure(res, error); }
  })();
  return true;
}
