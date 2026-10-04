import type {
  PeopleNotesWave, PeopleWorkspace, SavePeopleNoteInput, SavePeopleOrderInput, SubmitPeopleNotesInput,
} from "../../../../packages/vault/people-edits.js";
import type { PeopleView } from "../../../../tools/projections/people.js";

export interface PeopleScope { contextId: string; viewId: string }
export interface PeopleApi {
  list(): Promise<PeopleView[]>;
  read(scope: PeopleScope): Promise<PeopleWorkspace>;
  order(input: SavePeopleOrderInput): Promise<PeopleWorkspace>;
  note(input: SavePeopleNoteInput): Promise<PeopleWorkspace>;
  submit(input: SubmitPeopleNotesInput): Promise<{ workspace: PeopleWorkspace; wave: PeopleNotesWave }>;
}
export class PeopleApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly workspace?: PeopleWorkspace) {
    super(message);
    this.name = "PeopleApiError";
  }
}


const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const revision = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// Check the response envelope and projection shape here. The host owns the
// domain validation; this adapter does not duplicate its import/edit rules.
function isView(value: unknown): value is PeopleView {
  return record(value) && typeof value.contextId === "string" && typeof value.viewId === "string" &&
    typeof value.contextName === "string" && typeof value.name === "string" && typeof value.cursor === "number" &&
    Array.isArray(value.people) && Array.isArray(value.sources) && record(value.coverage);
}
function isWorkspace(value: unknown): value is PeopleWorkspace {
  return isView(value) && record(value) && strings(value.order) && revision(value.orderRevision) &&
    Array.isArray(value.notes) && revision(value.notesRevision) && Array.isArray(value.waves);
}
function isWave(value: unknown): value is PeopleNotesWave {
  return record(value) && typeof value.waveId === "string" && typeof value.entryId === "string" && strings(value.noteIds) &&
    Array.isArray(value.notes) && revision(value.orderRevision) && revision(value.revision) &&
    ["pending", "completed", "failed"].includes(value.status as string) && record(value.actor) && typeof value.at === "string";
}
const malformed = (status: number): PeopleApiError => new PeopleApiError("The people service returned an invalid response.", status, "invalid_response");

/** Request IDs belong to the caller. No automatic retries can duplicate edits
 * or conceal an uncertain save; a caller may retry the same request ID. */
export function createPeopleApi(fetcher: typeof fetch = fetch, base = "/api/lois/people"): PeopleApi {
  async function call(url: string, init: RequestInit): Promise<{ body: Record<string, unknown>; status: number }> {
    let response: Response;
    try { response = await fetcher(url, init); }
    catch { throw new PeopleApiError("Could not confirm the request with the people service.", 0, "network"); }
    let body: unknown;
    try { body = await response.json(); }
    catch { throw malformed(response.status); }
    if (!record(body)) throw malformed(response.status);
    if (!response.ok || body.ok === false) {
      throw new PeopleApiError(
        typeof body.error === "string" ? body.error : `The people request failed (${response.status}).`,
        response.status, typeof body.code === "string" ? body.code : undefined,
        isWorkspace(body.workspace) ? body.workspace : undefined,
      );
    }
    if (body.ok !== true) throw malformed(response.status);
    return { body, status: response.status };
  }
  function workspace(result: { body: Record<string, unknown>; status: number }): PeopleWorkspace {
    if (!isWorkspace(result.body.workspace)) throw malformed(result.status);
    return result.body.workspace;
  }
  const post = (route: string, body: unknown) => call(`${base}/${route}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return {
    async list() {
      const result = await call(base, { cache: "no-store" });
      if (!Array.isArray(result.body.views) || !result.body.views.every(isView)) throw malformed(result.status);
      return result.body.views;
    },
    async read(scope) {
      const query = new URLSearchParams({ contextId: scope.contextId, viewId: scope.viewId });
      return workspace(await call(`${base}?${query}`, { cache: "no-store" }));
    },
    async order(input) {
      const { contextId, viewId, personIds, baseRevision, requestId } = input;
      return workspace(await post("order", { contextId, viewId, personIds, baseRevision, requestId }));
    },
    async note(input) {
      // Actor, clock and model-wave attribution are host-owned, not browser
      // inputs, even though the shared core command type also serves models.
      const { contextId, viewId, noteId, personId, text, state, baseRevision, requestId, replyTo } = input;
      return workspace(await post("note", { contextId, viewId, noteId, personId, text, state, baseRevision, requestId, replyTo }));
    },
    async submit(input) {
      const { contextId, viewId, noteIds, baseRevision, requestId } = input;
      const result = await post("waves", { contextId, viewId, noteIds, baseRevision, requestId });
      const saved = workspace(result);
      if (!isWave(result.body.result)) throw malformed(result.status);
      return { workspace: saved, wave: result.body.result };
    },
  };
}
