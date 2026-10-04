// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeopleView } from "../../../tools/projections/people.js";
import type { PeopleNotesWave } from "../../../packages/vault/people-edits.js";

const people = vi.hoisted(() => ({ list: vi.fn(), mount: vi.fn(), refresh: vi.fn(), destroy: vi.fn() }));
vi.mock("./lois/people-client.js", () => ({ createPeopleApi: () => ({ list: people.list }) }));
vi.mock("./hg/people-workspace.js", () => ({ mountPeopleWorkspace: people.mount }));
import { renderHgLoisFlow } from "./hg/lois-flow.js";

const empty = { entries: [], persons: [], contexts: [], gatherings: [] };
const view = { contextId: "world-a", contextName: "My dinners", viewId: "past", name: "Past dinners", people: [], sources: [], coverage: { selected: 2, read: 1, partial: 0, unread: 1, failed: 0, discoveryComplete: true, complete: false }, cursor: 1 } satisfies PeopleView;
let output = { say: "Saved the list.", ui: [{ show: "room" }], proposals: [], memory: [], questions: [], replies: [] };
let tellOk = true;
let requests: string[];

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="app"></div>';
  HTMLElement.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn();
  vi.stubGlobal("EventSource", class {
    addEventListener = vi.fn();
    close = vi.fn();
  });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
  people.list.mockResolvedValue([view]);
  people.refresh.mockResolvedValue(undefined);
  people.mount.mockImplementation((host: HTMLElement) => {
    host.textContent = "Durable people";
    return { refresh: people.refresh, destroy: people.destroy };
  });
  tellOk = true;
  requests = [];
  output = { say: "Saved the list.", ui: [{ show: "room" }], proposals: [], memory: [], questions: [], replies: [] };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/lois/jobs") return Response.json({ jobs: [] });
    if (url === "/api/lois/trace") return Response.json({ ok: true, turns: [], timeline: [] });
    if (url === "/api/lois/browser/status") return Response.json({ open: true, mode: "embedded" });
    if (url === "/api/lois/tell") {
      requests.push(JSON.parse(String(init?.body)).message);
      return new Response(`event: turn\ndata: ${JSON.stringify({ ok: tellOk, ...(tellOk ? { output } : { why: "offline" }), traceTail: [] })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error(url);
  }));
});
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("durable people in the Lois shell", () => {
  it("opens a saved list without requiring an upcoming gathering", async () => {
    const root = document.getElementById("app")!;
    renderHgLoisFlow(root, empty);
    await vi.waitFor(() => expect(root.querySelector(".stage")?.textContent).toContain("Durable people"));
    expect(people.mount.mock.calls[0]?.[1].scope).toEqual({ contextId: view.contextId, viewId: view.viewId });
    expect(root.querySelectorAll(".pickhit")).toHaveLength(0);
  });

  it("refreshes and shows a newly imported list from a room turn", async () => {
    people.list.mockResolvedValueOnce([]).mockResolvedValue([view]);
    const root = document.getElementById("app")!;
    renderHgLoisFlow(root, empty);
    await vi.waitFor(() => expect(people.list).toHaveBeenCalledTimes(1));
    root.querySelector<HTMLInputElement>(".composer__input")!.value = "get my old lists";
    root.querySelector<HTMLButtonElement>(".composer__send")!.click();
    await vi.waitFor(() => expect(root.querySelector(".stage")?.textContent).toContain("Durable people"));
  });

  it("submits exact saved wave IDs without a browser stealing the people pane", async () => {
    const root = document.getElementById("app")!;
    renderHgLoisFlow(root, empty);
    await vi.waitFor(() => expect(people.mount).toHaveBeenCalled());
    const options = people.mount.mock.calls[0]![1];
    await options.onWave(options.scope, { waveId: "wave-123", notes: [{ text: "Move Avery first" }] } as PeopleNotesWave);
    expect(requests[0]).toContain("world-a");
    expect(requests[0]).toContain("past");
    expect(requests[0]).toContain("wave-123");
    expect(root.querySelector(".stage")?.textContent).toContain("Durable people");
    expect(people.refresh).toHaveBeenCalled();
  });

  it("leaves a failed wave truthful and refreshes writes made before the failure", async () => {
    tellOk = false;
    const root = document.getElementById("app")!;
    renderHgLoisFlow(root, empty);
    await vi.waitFor(() => expect(people.mount).toHaveBeenCalled());
    const options = people.mount.mock.calls[0]![1];
    await expect(options.onWave(options.scope, { waveId: "wave-failed", notes: [] } as unknown as PeopleNotesWave)).rejects.toThrow("offline");
    expect(root.textContent).not.toContain("Got it, noted.");
    expect(people.refresh).toHaveBeenCalled();
  });

  it("switches mobile panes without remounting the saved editor", async () => {
    const root = document.getElementById("app")!;
    renderHgLoisFlow(root, empty);
    await vi.waitFor(() => expect(people.mount).toHaveBeenCalled());
    root.querySelector<HTMLButtonElement>('[data-desk-tab="lois"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-desk-tab="stage"]')!.click();
    expect(people.mount).toHaveBeenCalledTimes(1);
    expect(root.querySelector(".stage")?.textContent).toContain("Durable people");
  });

  it("keeps the mobile browser reachable when a saved list also exists", async () => {
    output.ui = [{ show: "browser" }];
    const root = document.getElementById("app")!;
    renderHgLoisFlow(root, empty);
    await vi.waitFor(() => expect(people.mount).toHaveBeenCalled());
    root.querySelector<HTMLInputElement>(".composer__input")!.value = "open my browser";
    root.querySelector<HTMLButtonElement>(".composer__send")!.click();
    await vi.waitFor(() => expect(root.querySelector(".macwin")).not.toBeNull());
    const current = root.querySelector<HTMLButtonElement>('[data-desk-tab="stage"]')!;
    expect(current.textContent).toBe("Browser");
    current.click();
    expect(root.querySelector(".macwin")).not.toBeNull();
    const other = root.querySelector<HTMLButtonElement>('[data-desk-tab="alternate"]')!;
    expect(other.textContent).toBe("People");
    other.click();
    expect(root.querySelector(".stage")?.textContent).toContain("Durable people");
    expect(other.textContent).toBe("Browser");
    other.click();
    expect(root.querySelector(".macwin")).not.toBeNull();
    expect(people.mount).toHaveBeenCalledTimes(1);
  });
});
