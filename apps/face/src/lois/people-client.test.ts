import { describe, expect, it, vi } from "vitest";
import type { PeopleNotesWave, PeopleWorkspace } from "../../../../packages/vault/people-edits.js";
import { createPeopleApi, PeopleApiError } from "./people-client.js";

const scope = { contextId: "world & one", viewId: "past/dinners?" };
const workspace: PeopleWorkspace = {
  ...scope, contextName: "Dinner world", name: "Past dinners", cursor: 3,
  people: [], sources: [], coverage: { selected: 0, unread: 0, partial: 0, read: 0, failed: 0, discoveryComplete: false, complete: false },
  order: [], orderRevision: 0, notes: [], notesRevision: 0, waves: [],
};
const wave: PeopleNotesWave = {
  waveId: "entry-wave", entryId: "entry-wave", noteIds: ["note-one"], notes: [],
  orderRevision: 3, revision: 1, status: "pending", actor: { kind: "human", ref: "organizer" }, at: "2026-09-05T12:00:00Z",
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("people browser API adapter", () => {
  it("keeps the inherited people contract on the Neon sidecar alias", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ok:true, views:[workspace]}))
      .mockResolvedValueOnce(response({ok:true, workspace}));
    const api=createPeopleApi(fetcher,"/api/neon/people-workspace");
    await api.list();
    await api.order({...scope,personIds:[],baseRevision:0,requestId:"neon-rank"});
    expect(fetcher.mock.calls.map(([url])=>url)).toEqual(["/api/neon/people-workspace","/api/neon/people-workspace/order"]);
  });

  it("lists views and reads the exact encoded scope", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ ok: true, views: [workspace] }))
      .mockResolvedValueOnce(response({ ok: true, workspace }));
    const api = createPeopleApi(fetcher);
    expect(await api.list()).toEqual([workspace]);
    expect(await api.read(scope)).toEqual(workspace);
    expect(fetcher.mock.calls).toEqual([
      ["/api/lois/people", { cache: "no-store" }],
      ["/api/lois/people?contextId=world+%26+one&viewId=past%2Fdinners%3F", { cache: "no-store" }],
    ]);
  });

  it("posts organizer order and notes as JSON and keeps caller request IDs", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ ok: true, result: { entryId: "saved", revision: 1, replayed: false }, workspace }));
    const api = createPeopleApi(fetcher);
    const order = { ...scope, personIds: ["person-two", "person-one"], baseRevision: 4, requestId: "caller-rank-id" };
    const note = { ...scope, noteId: "note-one", personId: "person-one", text: "Move above Riley", state: "draft" as const, baseRevision: 2, requestId: "caller-note-id", replyTo: "earlier-note" };
    expect(await api.order(order)).toEqual(workspace);
    expect(await api.note(note)).toEqual(workspace);
    expect(fetcher.mock.calls).toEqual([
      ["/api/lois/people/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(order) }],
      ["/api/lois/people/note", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(note) }],
    ]);
  });

  it("returns the immutable submitted wave alongside the updated workspace", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true, result: { ...wave, replayed: false }, workspace }));
    const input = { ...scope, noteIds: ["note-one"], baseRevision: 2, requestId: "caller-wave-id" };
    const result = await createPeopleApi(fetcher).submit(input);
    expect(result).toEqual({ workspace, wave: { ...wave, replayed: false } });
    expect(fetcher.mock.calls).toEqual([["/api/lois/people/waves", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }]]);
  });

  it("serializes only the browser edit fields, leaving actor and attribution to the host", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true, workspace }));
    await createPeopleApi(fetcher).note({ ...scope, noteId: "note", personId: "person", text: "My note", state: "draft", baseRevision: 0, requestId: "caller-id", actor: { kind: "lois", ref: "lois" }, at: "2026-01-01", waveId: "model-wave" });
    const sent = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(sent).toEqual({ ...scope, noteId: "note", personId: "person", text: "My note", state: "draft", baseRevision: 0, requestId: "caller-id" });
  });

  it("preserves conflict status, server code, message and optional workspace without retrying", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ok: false, code: "conflict", error: "Order changed since you read it.", workspace }, 409));
    const promise = createPeopleApi(fetcher).order({ ...scope, personIds: ["person"], baseRevision: 0, requestId: "caller-id" });
    await expect(promise).rejects.toBeInstanceOf(PeopleApiError);
    await expect(promise).rejects.toMatchObject({ status: 409, code: "conflict", message: "Order changed since you read it.", workspace });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports network uncertainty without retrying or manufacturing success", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Connection closed"));
    const promise = createPeopleApi(fetcher).order({ ...scope, personIds: ["person"], baseRevision: 0, requestId: "keep-for-retry" });
    await expect(promise).rejects.toMatchObject({ status: 0, code: "network" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports non-JSON and malformed success envelopes honestly", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 502 }))
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({ ok: true, views: [null] }))
      .mockResolvedValueOnce(response({ ok: true, workspace, result: { status: "pending" } }));
    const api = createPeopleApi(fetcher);
    await expect(api.read(scope)).rejects.toMatchObject({ status: 502, code: "invalid_response" });
    await expect(api.read(scope)).rejects.toMatchObject({ status: 200, code: "invalid_response" });
    await expect(api.list()).rejects.toMatchObject({ status: 200, code: "invalid_response" });
    await expect(api.submit({ ...scope, noteIds: ["note"], requestId: "once" })).rejects.toMatchObject({ status: 200, code: "invalid_response" });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("does not treat an error envelope with HTTP 200 as success", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ok: false, error: "Could not save." }));
    await expect(createPeopleApi(fetcher).read(scope)).rejects.toMatchObject({ status: 200, message: "Could not save." });
  });
});
