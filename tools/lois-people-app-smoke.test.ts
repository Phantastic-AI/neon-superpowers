import { describe, expect, it, vi } from "vitest";
import {
  assertPeopleAppProspects,
  assertPeopleAppTrace,
  assertPeopleAppTurn,
  assertPeopleAppSession,
  assertPeopleAppResearchActive,
  waitForSavedView,
  hasSettledPeopleAppResearch,
  isDirectPeopleAppSmoke,
  peopleAppRequests,
  runPeopleAppSmoke,
  tell,
} from "./lois-people-app-smoke.js";
import type { PeopleView } from "./projections/people.js";

const origin = "http://127.0.0.1:4321";

describe("combined-source app proof boundary", () => {
  it("lets the app consume its live SSE response before retrieving the completed body", async () => {
    let landed = false;
    const body = 'event: turn\ndata: {"ok":true}\n\nevent: done\ndata: {}\n\n';
    const page = {
      waitForResponse: async () => ({ ok: () => true, headers: () => ({ "content-type": "text/event-stream" }),
        text: async () => { if (!landed) throw new Error("Open event stream has no retrievable body yet"); return body; } }),
      getByRole: () => ({ fill: async () => {}, click: async () => {} }),
      waitForFunction: async () => { landed = true; },
    };
    await expect(tell(page as never, "Read my sources")).resolves.toBe(body);
  });

  it("stays cold on import and without the shared explicit paid gate", async () => {
    const cli = "file:///repo/tools/lois-people-app-smoke.ts";
    expect(isDirectPeopleAppSmoke(cli, ["node", "/repo/tools/lois-people-app-smoke.test.ts"])).toBe(false);
    expect(isDirectPeopleAppSmoke(cli, ["node", "/repo/tools/lois-people-app-smoke.ts"])).toBe(true);
    await expect(runPeopleAppSmoke([])).rejects.toThrow(/explicit --approve-paid authorization/i);
  });

  it("gives the model source entrances and intent, never expected candidates or tool instructions", () => {
    const requests = peopleAppRequests(`${origin}/event/3cs?shape=v2`).join(" ");
    expect(requests).toContain(`${origin}/account/3cs/history`);
    expect(requests).toContain(`${origin}/network`);
    expect(requests).toContain("same saved list");
    expect(requests).toContain("contact details are missing");
    expect(requests).toContain("raise startup investment for Superpowers");
    expect(requests).not.toMatch(/charit|philanthrop|donor|nonprofit/i);
    for (const hidden of ["Nina Patel", "Amara Chen", "Devon Brooks", "Owen Park", "people_save_prospect", "people_import_csv", "eight people", "three prospects"]) expect(requests).not.toContain(hidden);
  });

  it("accepts discovered prospects alongside the unchanged historical identity", () => {
    expect(assertPeopleAppProspects(prospectView(), origin)).toEqual({ prospects: 3, newPeople: 2, recurringPersonId: "nina", missingContactPersonId: "devon" });
  });

  it("accepts a collection source label when its retained evidence is the discovered profile", () => {
    const view = prospectView();
    view.people[1].prospects[0].url = `${origin}/network/people/fundraising`;
    expect(() => assertPeopleAppProspects(view, origin)).not.toThrow();
  });

  it("rejects a duplicated recurring person or fabricated contact/attendance", () => {
    const duplicated = prospectView();
    duplicated.people.push({ ...structuredClone(duplicated.people[0]), personId: "duplicate", memberships: [], sourceCount: 0 });
    expect(() => assertPeopleAppProspects(duplicated, origin)).toThrow(/recurring|duplicate/i);
    const invented = prospectView();
    invented.people[2].anchors = [{ kind: "email", value: "guessed@example.test", verified: false }];
    expect(() => assertPeopleAppProspects(invented, origin)).toThrow(/contact/i);
    const attendance = prospectView();
    attendance.people[1].memberships = [...attendance.people[0].memberships];
    expect(() => assertPeopleAppProspects(attendance, origin)).toThrow(/membership/i);
  });

  it("rejects missing, foreign, or merely asserted source evidence and relevance", () => {
    const missing = prospectView(); missing.people.pop();
    expect(() => assertPeopleAppProspects(missing, origin)).toThrow(/missing/i);
    const foreign = prospectView(); foreign.people[1].prospects[0].evidence = ["url:https://foreign.test/profile"];
    expect(() => assertPeopleAppProspects(foreign, origin)).toThrow(/evidence/i);
    const reason = prospectView(); reason.people[1].prospects[0].reason.text = "";
    expect(() => assertPeopleAppProspects(reason, origin)).toThrow(/reason/i);
  });

  it("requires successful browser discovery/import/save/read calls and rejects outbound proposals", () => {
    const trace = ["browser_follow", "people_import_csv", "people_save_prospect", "people_read"].map(tool => ({ actor: "diver", kind: "tool.return", detail: { tool } }));
    expect(() => assertPeopleAppTrace(trace)).not.toThrow();
    expect(() => assertPeopleAppTrace(trace.filter(row => row.detail.tool !== "people_save_prospect"))).toThrow(/people_save_prospect/);
    expect(() => assertPeopleAppTrace([...trace, { actor: "lois", kind: "proposed", detail: { kind: "send" } }])).toThrow(/proposal/i);
  });

  it("resolves ordinary mouth returns through call refs and rejects a failed saved-view read", () => {
    const trace = ["browser_follow", "people_import_csv", "people_save_prospect"].map(tool => ({ actor: "diver", kind: "tool.return", detail: { tool } }));
    const call = { seq: 40, actor: "lois", kind: "tool.call", detail: { tool: "people_read" } };
    expect(() => assertPeopleAppTrace([...trace, call, { kind: "tool.return", refs: [40], label: '{"ok":true}' }])).not.toThrow();
    expect(() => assertPeopleAppTrace([...trace, call, { kind: "tool.return", refs: [40], label: '{"ok":false}' }])).toThrow(/people_read/);
  });

  it("requires a successful completed app SSE turn", () => {
    expect(() => assertPeopleAppTurn('event: turn\ndata: {"ok":true}\n\nevent: done\ndata: {}\n\n')).not.toThrow();
    expect(() => assertPeopleAppTurn('event: turn\ndata: {"ok":false,"why":"failed"}\n\nevent: done\ndata: {}\n\n')).toThrow(/failed/i);
    expect(() => assertPeopleAppTurn('event: turn\ndata: {"ok":true}\n\n')).toThrow(/finish/i);
  });

  it("does not mistake an earlier finished request for the current research", () => {
    const trace = [
      { seq: 10, actor: "diver", kind: "model.reply", detail: { jobId: "old" } },
      { seq: 11, actor: "diver", kind: "heard", detail: { jobId: "old" } },
      { seq: 12, actor: "lois", kind: "model.reply" },
    ];
    expect(hasSettledPeopleAppResearch(trace, 0)).toBe(true);
    expect(hasSettledPeopleAppResearch(trace, 12)).toBe(false);
    expect(hasSettledPeopleAppResearch([...trace, { seq: 15, actor: "diver", kind: "model.reply", detail: { jobId: "new" } }], 12)).toBe(false);
  });

  it("fails stopped unfinished work after the mouth has landed, not while continuation is possible", () => {
    expect(() => assertPeopleAppResearchActive([{ phase: "partial" }], false)).not.toThrow();
    expect(() => assertPeopleAppResearchActive([{ phase: "researching" }], true)).not.toThrow();
    expect(() => assertPeopleAppResearchActive([{ phase: "done" }], true)).not.toThrow();
    expect(() => assertPeopleAppResearchActive([{ phase: "partial" }], true)).toThrow(/without resuming/);
  });

  it("does not reject a resumed worker when an old partial HTTP response arrives late", async () => {
    let release!: (response: Response) => void;
    const oldJobs = new Promise<Response>(resolve => { release = resolve; });
    let jobReads = 0, cursor = 1, landed = false;
    const view = { ...prospectView(), contextName: "3Cs" };
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => {
      if (url.pathname.endsWith("/jobs")) {
        jobReads += 1;
        return jobReads === 1 ? oldJobs : Response.json({ jobs: [{ phase: "done" }] });
      }
      return Response.json({ views: [view] });
    }));
    try {
      const waiting = waitForSavedView(origin, () => undefined, () => landed, () => cursor);
      await vi.waitFor(() => expect(jobReads).toBe(1));
      cursor = 2; landed = true; // Resume and its mouth reply occurred during the HTTP read.
      release(Response.json({ jobs: [{ phase: "partial" }] }));
      await expect(waiting).resolves.toEqual(view);
      expect(jobReads).toBe(2);
    } finally { vi.unstubAllGlobals(); }
  });

  it("cannot publish a green result when runtime or browser cleanup failed", () => {
    const session = { receipts: [], cleanAfterSession: true, chromeProcessResidue: 0, cascadeClose: "quiet", browserClose: "Closed the window. The session stays saved in the profile." };
    expect(() => assertPeopleAppSession(session)).not.toThrow();
    for (const failure of [
      { cascadeClose: "Runtime cleanup failed: provider still active" },
      { browserClose: "Browser cleanup failed: close rejected" },
      { browserClose: "not started" },
    ]) expect(() => assertPeopleAppSession({ ...session, ...failure })).toThrow(/cleanup/i);
    expect(() => assertPeopleAppSession({ ...session, receipts: [{}] })).toThrow();
    expect(() => assertPeopleAppSession({ ...session, cleanAfterSession: false })).toThrow();
    expect(() => assertPeopleAppSession({ ...session, chromeProcessResidue: 1 })).toThrow();
  });
});

function prospectView(): PeopleView {
  const finding = (name: string, path: string) => ({ platform: "linkedin", accountId: "mock-network-organizer", sourceId: path, label: "Fundraising network", url: `${origin}${path}`, sourceKey: path, sourceRowId: path, observationEntryId: `observed-${path}`, reasonEntryId: `reason-${path}`, name, version: 1, confidence: "chatham" as const, evidence: [`observation:1`, `url:${origin}${path}`], reason: { text: "Relevant fundraising experience", epistemics: "inferred" as const, confidence: "chatham" as const, evidence: [`observation:1`, `url:${origin}${path}`] } });
  const member = (eventId: string) => ({ platform: "luma", accountId: "mock-luma-3cs-host", eventId, sourceId: eventId, gatheringId: eventId, name: eventId, date: "2026-08-01", url: `${origin}/account/3cs/history/${eventId}`, rowId: eventId, entryId: eventId, version: 1, evidence: [eventId] });
  return {
    contextId: "W", contextName: "3Cs", viewId: "saved", name: "People", cursor: 10, sources: [],
    coverage: { selected: 2, read: 2, complete: true, discoveryComplete: true, unread: 0, partial: 0, failed: 0 },
    people: [
      { personId: "nina", name: "Nina Patel", identity: "verified", sourceCount: 2, memberships: [member("july"), member("august")], anchors: [{ kind: "email", value: "nina.patel@example.test", verified: true, evidence: "observation:1" }], prospects: [finding("Nina Patel", "/network/in/nina-patel")] },
      { personId: "amara", name: "Amara Chen", identity: "verified", sourceCount: 0, memberships: [], anchors: [{ kind: "email", value: "amara.chen@example.test", verified: true, evidence: "observation:1" }], prospects: [finding("Amara Chen", "/network/in/amara-chen")] },
      { personId: "devon", name: "Devon Brooks", identity: "unresolved", sourceCount: 0, memberships: [], anchors: [], prospects: [finding("Devon Brooks", "/network/people/fundraising")] },
    ],
  };
}
