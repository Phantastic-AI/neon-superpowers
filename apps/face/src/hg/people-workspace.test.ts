// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeopleNotesWave, PeopleWorkspace } from "../../../../packages/vault/people-edits.js";
import { PeopleApiError, type PeopleApi } from "../lois/people-client.js";
import { mountPeopleWorkspace } from "./people-workspace.js";

const scope = { contextId: "world-dinners", viewId: "past" };
function fixture(): PeopleWorkspace {
  return { ...scope, contextName: "Our dinners", name: "Past dinner guests", cursor: 10,
    sources: [{ sourceId: "s1", gatheringId: "g1", platform: "luma", accountId: "owner", eventId: "one", name: "August dinner", date: "2026-08-01", url: "https://luma.com/one", evidence: ["e1"], readState: "read", rowCount: 3, entryId: "e1" }],
    people: ["Avery", "Blair", "Casey"].map((name, i) => ({ personId: `p${i}`, name, identity: "verified", sourceCount: 3 - i, anchors: [], prospects: [], memberships: [{ sourceId: "s1", gatheringId: "g1", platform: "luma", accountId: "owner", eventId: "one", name: "August dinner", date: "2026-08-01", url: "https://luma.com/one", rowId: `r${i}`, entryId: `e${i}`, version: 1, evidence: [] }] })),
    coverage: { selected: 2, read: 1, partial: 0, unread: 1, failed: 0, discoveryComplete: false, complete: false },
    order: ["p0", "p1", "p2"], orderRevision: 0, notes: [], notesRevision: 0, waves: [],
  };
}
let current: PeopleWorkspace, api: PeopleApi, host: HTMLElement, mounted: ReturnType<typeof mountPeopleWorkspace>;
let onWave: ReturnType<typeof vi.fn>;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(node => node.getAttribute("aria-label") === label || node.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}\n${host.textContent}`);
  return found;
}
function order(): string[] { return [...host.querySelectorAll<HTMLElement>("[data-person-id]")].map(row => row.dataset.personId!); }
function saveOpenNote(): void { host.querySelector("textarea")!.dispatchEvent(new Event("blur")); }
function measureRows(reduced = false) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduced })));
  const root = host.querySelector<HTMLElement>(".people-workspace")!;
  root.style.setProperty("--ease-out", "cubic-bezier(0.16, 1, 0.3, 1)");
  root.style.setProperty("--dur-micro", "120ms");
  const heights: Record<string, number> = { p0: 72, p1: 110, p2: 85 };
  const animations = new Map<string, ReturnType<typeof vi.fn>>();
  for (const row of host.querySelectorAll<HTMLElement>("[data-person-id]")) {
    vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => {
      const siblings = [...row.parentElement!.children] as HTMLElement[];
      const top = siblings.slice(0, siblings.indexOf(row)).reduce((sum, sibling) => sum + (heights[sibling.dataset.personId!] ?? 72), 0);
      return new DOMRect(0, top, 500, heights[row.dataset.personId!] ?? 72);
    });
    const animate = vi.fn(() => ({ cancel: vi.fn(), addEventListener: vi.fn() }) as unknown as Animation);
    row.animate = animate; animations.set(row.dataset.personId!, animate);
  }
  return animations;
}
async function start() { mounted = mountPeopleWorkspace(host, { api, scope, onWave }); await tick(); if (current.contextId === scope.contextId && host.querySelectorAll("[data-person-id]").length) button("Your order").click(); }
beforeEach(() => {
  current = fixture();
  host = document.createElement("div"); document.body.append(host);
  onWave = vi.fn(async () => {});
  api = {
    list: vi.fn(async () => []), read: vi.fn(async () => structuredClone(current)),
    order: vi.fn(async input => { current = { ...current, cursor: current.cursor + 1, order: input.personIds, orderRevision: current.orderRevision + 1 }; return structuredClone(current); }),
    note: vi.fn(async input => {
      current = { ...current, cursor: current.cursor + 1, notesRevision: current.notesRevision + 1, notes: [...current.notes.filter(n => n.noteId !== input.noteId), { ...input, revision: input.baseRevision + 1, entryId: `e${current.cursor}`, actor: { kind: "human", ref: "organizer" }, at: "2026-09-01" }] };
      return structuredClone(current);
    }),
    submit: vi.fn(async input => {
      const wave: PeopleNotesWave = { waveId: "wave-1", entryId: "wave-1", noteIds: input.noteIds, notes: structuredClone(current.notes.filter(n => input.noteIds.includes(n.noteId))), orderRevision: current.orderRevision, revision: 1, status: "pending", actor: { kind: "human", ref: "organizer" }, at: "2026-09-01" };
      current = { ...current, cursor: current.cursor + 1, notesRevision: current.notesRevision + 1, notes: current.notes.map(n => input.noteIds.includes(n.noteId) ? { ...n, state: "submitted", revision: n.revision + 1 } : n), waves: [wave] };
      return { workspace: structuredClone(current), wave };
    }),
  };
});
afterEach(() => { mounted?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("durable people stage", () => {
  it("reads exact scope, discloses incomplete source coverage and never calls it attendance", async () => {
    await start();
    expect(api.read).toHaveBeenCalledWith(scope);
    expect(host.textContent).toContain("1 of 2 selected lists read");
    expect(host.textContent).toContain("Past-list search unfinished");
    expect(host.textContent).toContain("On 3 lists");
    expect(host.textContent).not.toContain("3 attended");
    expect(host.querySelector('a[href="https://luma.com/one"]')).not.toBeNull();
    expect(order()).toEqual(current.order);
  });

  it("shows unfinished source names and states without opening the source disclosure", async () => {
    const base = current.sources[0]!;
    current.sources.push(
      { ...base, sourceId: "s2", eventId: "two", name: "September dinner", url: "https://luma.com/two", readState: "unread", rowCount: 0 },
      { ...base, sourceId: "s3", eventId: "three", name: "Garden dinner", url: "https://luma.com/three", readState: "partial", rowCount: 1 },
      { ...base, sourceId: "s4", eventId: "four", name: "Founders dinner", url: "https://luma.com/four", readState: "failed", rowCount: 0 },
    );
    current.coverage = { selected: 4, read: 1, unread: 1, partial: 1, failed: 1, discoveryComplete: false, complete: false };
    await start();
    const state = host.querySelector(".people-workspace__source-state")!;
    expect(state.closest("details")).toBeNull();
    expect(state.textContent).toContain("Past-list search unfinished");
    for (const text of ["Not read yet: September dinner", "Partly read: Garden dinner", "Could not read: Founders dinner"]) expect(state.textContent).toContain(text);
    expect(state.querySelector('a[href="https://luma.com/two"]')).not.toBeNull();
    expect(host.querySelector<HTMLDetailsElement>(".people-workspace__sources")!.open).toBe(false);
    expect(state.textContent).not.toMatch(/reading|working|still finding/i);
    expect(api.order).not.toHaveBeenCalled(); expect(api.note).not.toHaveBeenCalled();
  });

  it("qualifies equal names with actual distinct contacts without merging or changing them", async () => {
    for (const [i, email] of ["sam1@example.test", "sam2@example.test"].entries()) {
      current.people[i]!.name = "Sam Rivera";
      current.people[i]!.anchors = [{ kind: "email", value: email, verified: true }];
    }
    await start();
    expect(host.textContent).toContain("Same name, different saved contacts; kept separate.");
    for (const [i, email] of ["sam1@example.test", "sam2@example.test"].entries()) {
      const row = host.querySelector(`[data-person-id="p${i}"]`)!;
      const qualifier = row.querySelector(".people-workspace__identity-detail")!;
      expect(qualifier.textContent).toContain(email); expect(qualifier.closest("details")).toBeNull();
    }
    expect(order()).toEqual(["p0", "p1", "p2"]);
    expect(host.querySelector('[data-person-id="p2"] .people-workspace__identity-detail')!.textContent).toBe("");
    button("Source frequency").click();
    expect(host.querySelector('[data-person-id="p1"] .people-workspace__identity-detail')!.textContent).toContain("sam2@example.test");
    expect(api.order).not.toHaveBeenCalled(); expect(api.note).not.toHaveBeenCalled();
  });

  it("uses real source metadata when same-name identities are uncertain and points to the existing note", async () => {
    current.people[0]!.name = current.people[1]!.name = "Sam Rivera";
    current.people[0]!.identity = "unresolved"; current.people[1]!.identity = "conflict";
    current.people[0]!.anchors = [{ kind: "email", value: "unconfirmed@example.test", verified: false }];
    current.people[1]!.memberships[0] = { ...current.people[1]!.memberships[0]!, sourceId: "s2", name: "Garden dinner", date: "2026-08-15" };
    await start();
    expect(host.textContent).not.toContain("Same name, different saved contacts; kept separate.");
    const first = host.querySelector('[data-person-id="p0"]')!;
    const second = host.querySelector('[data-person-id="p1"]')!;
    expect(first.querySelector(".people-workspace__identity-detail")!.textContent).toBe("From August dinner · 2026-08-01");
    expect(second.querySelector(".people-workspace__identity-detail")!.textContent).toBe("From Garden dinner · 2026-08-15");
    expect(first.textContent).toContain("Identity not yet verified. Add what you know in a note to Lois.");
    expect(second.textContent).toContain("Identity needs a look. Add what you know in a note to Lois.");
    const note = first.querySelector<HTMLButtonElement>(".people-workspace__note-toggle")!;
    expect(note.textContent).toBe("+ Note"); note.click();
    expect(host.querySelector("textarea")!.closest("[data-person-id]")!.getAttribute("data-person-id")).toBe("p0");
    expect(onWave).not.toHaveBeenCalled(); expect(api.note).not.toHaveBeenCalled();
    expect(order()).toHaveLength(3);
  });

  it("does not claim different saved contacts from shared or unverified anchors", async () => {
    current.people[0]!.name = current.people[1]!.name = "Sam Rivera";
    current.people[0]!.anchors = [{ kind: "email", value: "sam@example.test", verified: true }];
    current.people[1]!.anchors = [{ kind: "email", value: "sam@example.test", verified: true }, { kind: "phone", value: "+15550101234", verified: false }];
    await start();
    expect(host.textContent).not.toContain("Same name, different saved contacts; kept separate.");
    expect(order()).toEqual(current.order);
  });

  it("Done waits for a durable draft save, closes it, and never sends it to Lois", async () => {
    await start(); button("Note on Avery").click();
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "Keep Avery near the top"; input.dispatchEvent(new Event("input"));
    const persist = api.note;
    let finish!: () => void;
    api.note = vi.fn(request => new Promise<PeopleWorkspace>(resolve => { finish = () => { void persist(request).then(resolve); }; }));
    button("Done").click();
    expect(host.contains(input)).toBe(true); expect(host.textContent).toContain("Saving note…");
    expect([...host.querySelectorAll("button")].some(button => ["Save note", "Close note"].includes(button.textContent!))).toBe(false);
    finish(); await tick();
    expect(host.querySelector("textarea")).toBeNull();
    expect(current.notes[0]).toMatchObject({ text: "Keep Avery near the top", state: "draft" });
    expect(button("Note on Avery").textContent).toBe("Notes 1");
    button("Note on Avery").click();
    expect(host.querySelector("textarea")!.value).toBe("Keep Avery near the top");
    expect(host.textContent).toContain("Saved · not sent to Lois");
    expect(button("Remove draft")).toBeDefined();
    expect(api.submit).not.toHaveBeenCalled(); expect(onWave).not.toHaveBeenCalled();
  });

  it("keeps an unsaved note open when Done cannot confirm its save", async () => {
    await start(); button("Note on Avery").click();
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "A thought to keep"; input.dispatchEvent(new Event("input"));
    vi.mocked(api.note).mockRejectedValueOnce(new PeopleApiError("offline", 0, "network"));
    button("Done").click(); await tick();
    expect(host.contains(input)).toBe(true); expect(input.value).toBe("A thought to keep");
    expect(button("Retry note")).toBeDefined();
    expect(api.submit).not.toHaveBeenCalled(); expect(onWave).not.toHaveBeenCalled();
  });

  it("Remove draft excludes the saved instruction from sending but keeps its history", async () => {
    await start(); button("Note on Avery").click();
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "A withdrawn instruction"; input.dispatchEvent(new Event("input"));
    button("Done").click(); await tick(); button("Note on Avery").click();
    button("Remove draft").click(); await tick();
    expect(host.querySelector("textarea")).toBeNull();
    expect(current.notes[0]).toMatchObject({ state: "hidden", text: "A withdrawn instruction" });
    expect(host.querySelector(".people-workspace__all-comments")!.textContent).toContain("A withdrawn instruction");
    expect(button("Send notes to Lois").disabled).toBe(true);
    expect(api.submit).not.toHaveBeenCalled(); expect(onWave).not.toHaveBeenCalled();
  });

  it("Hide from list keeps an already sent wave intact and does not send again", async () => {
    await start(); button("Note on Avery").click();
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "The instruction Lois received"; input.dispatchEvent(new Event("input"));
    button("Done").click(); await tick(); button("Send notes to Lois").click(); await tick(); await tick();
    const wave = structuredClone(current.waves[0]);
    button("Note on Avery").click();
    expect(host.textContent).toContain("Sent to Lois");
    expect(host.textContent).not.toContain("Saved · not sent to Lois");
    button("Hide from list").click(); await tick();
    expect(current.notes[0]!.state).toBe("hidden"); expect(current.waves[0]).toEqual(wave);
    expect(api.submit).toHaveBeenCalledTimes(1); expect(onWave).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".people-workspace__all-comments")!.textContent).toContain("The instruction Lois received");
  });

  it("search and source frequency are presentation only", async () => {
    current.order = ["p2", "p1", "p0"]; current.orderRevision = 1;
    await start();
    button("Source frequency").click(); expect(order()).toEqual(["p0", "p1", "p2"]);
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "blair"; search.dispatchEvent(new Event("input")); expect(order()).toEqual(["p1"]);
    expect(api.order).not.toHaveBeenCalled();
    expect(button("Move Blair up").disabled).toBe(true);
  });

  it("moves immediately through a dedicated keyboard grip, persists and offers undo", async () => {
    await start();
    button("Reorder Blair").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(order()).toEqual(["p1", "p0", "p2"]);
    await tick();
    expect(api.order).toHaveBeenCalledWith(expect.objectContaining({ ...scope, personIds: ["p1", "p0", "p2"], baseRevision: 0 }));
    button("Undo move").click(); await tick();
    expect(order()).toEqual(["p0", "p1", "p2"]);
    expect(host.querySelector('[data-person-id="p1"]')?.getAttribute("draggable")).toBeNull();
  });

  it("animates the measured displacement of both reordered rows using the motion tokens", async () => {
    await start(); const animations = measureRows();
    const grip = button("Reorder Blair"); grip.focus();
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(order()).toEqual(["p1", "p0", "p2"]); expect(document.activeElement).toBe(grip);
    expect(animations.get("p1")).toHaveBeenCalledWith([{ transform: "translate(0px, 72px)" }, { transform: "translate(0px, 0px)" }], { duration: 120, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    expect(animations.get("p0")).toHaveBeenCalledWith([{ transform: "translate(0px, -110px)" }, { transform: "translate(0px, 0px)" }], expect.any(Object));
    expect(animations.get("p2")).not.toHaveBeenCalled();
    await tick();
    expect(animations.get("p1")).toHaveBeenCalledTimes(1);
  });

  it("never transforms rows in reduced-motion mode, while still saving their final order", async () => {
    await start(); const animations = measureRows(true);
    button("Move Blair up").click(); await tick();
    expect(order()).toEqual(["p1", "p0", "p2"]); expect(api.order).toHaveBeenCalled();
    for (const animate of animations.values()) expect(animate).not.toHaveBeenCalled();
  });

  it("does not parade rows on unchanged refresh, import append, note opening or filtering", async () => {
    await start(); const animations = measureRows();
    await mounted.refresh();
    current = { ...current, cursor: current.cursor + 1, order: [...current.order, "p3"], people: [...current.people, { ...current.people[0]!, personId: "p3", name: "Devon" }] };
    await mounted.refresh(); button("Note on Blair").click();
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "Blair"; search.dispatchEvent(new Event("input"));
    for (const animate of animations.values()) expect(animate).not.toHaveBeenCalled();
  });

  it("rolls back an uncertain save and retries the same operation ID", async () => {
    vi.mocked(api.order).mockRejectedValueOnce(new PeopleApiError("offline", 0, "network"));
    await start(); button("Move Blair up").click(); await tick();
    expect(order()).toEqual(["p0", "p1", "p2"]);
    const first = vi.mocked(api.order).mock.calls[0]![0];
    button("Retry move").click(); await tick();
    expect(vi.mocked(api.order).mock.calls[1]![0]).toEqual(first);
    expect(order()).toEqual(["p1", "p0", "p2"]);
  });

  it("retries a move against the latest revision without losing another editor or imports", async () => {
    await start();
    current = { ...current, cursor: 14, order: ["p2", "p0", "p1", "p3"], orderRevision: 2, people: [...current.people, { ...current.people[0]!, personId: "p3", name: "Devon" }] };
    vi.mocked(api.order).mockRejectedValueOnce(new PeopleApiError("Changed", 409, "conflict", structuredClone(current)));
    button("Move Blair up").click(); await tick();
    expect(order()).toEqual(["p2", "p0", "p1", "p3"]);
    button("Retry move").click(); await tick();
    expect(api.order).toHaveBeenLastCalledWith(expect.objectContaining({ baseRevision: 2, personIds: ["p2", "p1", "p0", "p3"] }));
  });

  it("keeps a yellow draft anchored across a sort, persists it, then sends only the saved wave", async () => {
    await start(); button("Note on Blair").click();
    const text = host.querySelector<HTMLTextAreaElement>("textarea")!;
    text.value = "Put Blair ahead of Avery"; text.dispatchEvent(new Event("input"));
    saveOpenNote(); await tick();
    expect(api.note).toHaveBeenCalledWith(expect.objectContaining({ ...scope, personId: "p1", text: text.value, state: "draft", baseRevision: 0 }));
    button("Source frequency").click();
    expect(host.querySelector('textarea')?.closest('[data-person-id]')?.getAttribute("data-person-id")).toBe("p1");
    button("Send notes to Lois").click(); await tick(); await tick();
    expect(api.submit).toHaveBeenCalledWith(expect.objectContaining({ ...scope, noteIds: [current.notes[0]!.noteId] }));
    expect(onWave).toHaveBeenCalledWith(scope, expect.objectContaining({ waveId: "wave-1" }));
    expect(host.textContent).not.toContain("Got it");
    expect(host.querySelector("textarea")?.disabled).toBe(false);
  });

  it("preserves unsaved text through a refresh and allows another draft during a pending wave", async () => {
    await start(); button("Note on Avery").click();
    const text = host.querySelector<HTMLTextAreaElement>("textarea")!;
    text.value = "A thought still being written"; text.dispatchEvent(new Event("input"));
    current = { ...current, cursor: 20, waves: [{ waveId: "prior", entryId: "prior", noteIds: [], notes: [], orderRevision: 0, revision: 1, status: "pending", actor: { kind: "human", ref: "organizer" }, at: "2026-09-01" }] };
    await mounted.refresh();
    expect(host.querySelector("textarea")?.value).toBe(text.value);
    expect(host.querySelector("textarea")?.disabled).toBe(false);
    expect(button("Send notes to Lois").disabled).toBe(true);
    saveOpenNote(); await tick(); expect(api.note).toHaveBeenCalled();
  });

  it("keeps draft text and offers retry when a note save fails", async () => {
    vi.mocked(api.note).mockRejectedValueOnce(new PeopleApiError("offline", 0, "network"));
    await start(); button("Note on Casey").click();
    const text = host.querySelector<HTMLTextAreaElement>("textarea")!;
    text.value = "Ask about the fund"; text.dispatchEvent(new Event("input"));
    saveOpenNote(); await tick();
    expect(host.querySelector("textarea")?.value).toBe("Ask about the fund");
    const first = vi.mocked(api.note).mock.calls[0]![0];
    button("Retry note").click(); await tick();
    expect(vi.mocked(api.note).mock.calls[1]![0]).toEqual(first);
  });

  it("does not manufacture replies when model continuation fails", async () => {
    onWave.mockRejectedValueOnce(new Error("Mind offline"));
    await start(); button("Note on Avery").click();
    const text = host.querySelector<HTMLTextAreaElement>("textarea")!;
    text.value = "Please move Avery"; text.dispatchEvent(new Event("input"));
    saveOpenNote(); await tick(); button("Send notes to Lois").click(); await tick(); await tick();
    expect(host.textContent).toContain("Notes saved. Lois could not finish");
    expect(host.querySelectorAll(".people-workspace__reply")).toHaveLength(0);
    expect(button("Note on Blair").disabled).toBe(false);
  });

  it("starts with labelled source frequency until the organizer chooses an order", async () => {
    mounted = mountPeopleWorkspace(host, { api, scope, onWave }); await tick();
    expect(button("Source frequency").getAttribute("aria-pressed")).toBe("true");
    expect(api.order).not.toHaveBeenCalled();
  });

  it("hides a cleared saved note without sending its old text and keeps its history", async () => {
    await start(); button("Note on Avery").click();
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "A note to keep in history"; input.dispatchEvent(new Event("input"));
    saveOpenNote(); await tick();
    input.value = ""; input.dispatchEvent(new Event("input"));
    saveOpenNote(); await tick();
    expect(api.note).toHaveBeenLastCalledWith(expect.objectContaining({ state: "hidden", text: "A note to keep in history" }));
    expect(button("Send notes to Lois").disabled).toBe(true);
    expect(host.querySelector(".people-workspace__all-comments")?.textContent).toContain("A note to keep in history");
    expect(host.querySelector(".people-workspace__all-comments")?.textContent).toContain("hidden");
  });

  it("does not submit old text when Send is clicked immediately after erasing a saved draft", async () => {
    await start(); button("Note on Avery").click();
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "An instruction I changed my mind about"; input.dispatchEvent(new Event("input"));
    saveOpenNote(); await tick();
    input.value = ""; input.dispatchEvent(new Event("input"));
    button("Send notes to Lois").click(); await tick(); await tick();
    expect(current.notes[0]?.state).toBe("hidden");
    expect(api.submit).not.toHaveBeenCalled(); expect(onWave).not.toHaveBeenCalled();
  });

  it("trusts durable completion over a late model connection error and removes retry", async () => {
    onWave.mockImplementationOnce(async () => {
      current = { ...current, cursor: current.cursor + 1, waves: current.waves.map(wave => ({ ...wave, status: "completed" as const, revision: wave.revision + 1 })) };
      throw new Error("Stream disconnected after completion");
    });
    await start(); button("Note on Avery").click();
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "Move Avery"; input.dispatchEvent(new Event("input"));
    saveOpenNote(); await tick(); button("Send notes to Lois").click(); await tick(); await tick();
    expect(current.waves[0]?.status).toBe("completed");
    expect(host.textContent).not.toContain("could not finish");
    expect(host.textContent).not.toContain("Ask Lois to continue");
    expect(onWave).toHaveBeenCalledTimes(1);
  });

  it("reconciles a late durable completion during a later public refresh", async () => {
    onWave.mockRejectedValueOnce(new Error("Connection lost"));
    await start(); button("Note on Avery").click();
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "Move Avery"; input.dispatchEvent(new Event("input"));
    saveOpenNote(); await tick(); button("Send notes to Lois").click(); await tick(); await tick();
    expect(host.textContent).toContain("Ask Lois to continue");
    current = { ...current, cursor: current.cursor + 1, waves: current.waves.map(wave => ({ ...wave, status: "completed" as const, revision: wave.revision + 1 })) };
    await mounted.refresh();
    expect(host.textContent).not.toContain("could not finish");
    expect(host.textContent).not.toContain("Ask Lois to continue");
  });

  it("keeps selection and focus while new imports refresh an open note", async () => {
    await start(); button("Note on Blair").click();
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "My unfinished thought"; input.dispatchEvent(new Event("input")); input.setSelectionRange(3, 8);
    current = { ...current, cursor: 12, order: [...current.order, "p3"], people: [...current.people, { ...current.people[0]!, personId: "p3", name: "Devon" }] };
    await mounted.refresh();
    expect(document.activeElement).toBe(input); expect(input.selectionStart).toBe(3); expect(input.selectionEnd).toBe(8);
    expect(order()).toEqual(["p0", "p1", "p2", "p3"]);
  });

  it("shows the immutable submitted text beside newer edits and a real Lois reply", async () => {
    await start(); button("Note on Avery").click();
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "First thought"; input.dispatchEvent(new Event("input")); saveOpenNote(); await tick();
    button("Send notes to Lois").click(); await tick(); await tick();
    input.value = "Second thought"; input.dispatchEvent(new Event("input")); saveOpenNote(); await tick();
    current.notes.push({ noteId: "reply", personId: "p0", replyTo: current.notes[0]!.noteId, waveId: "wave-1", text: "I moved Avery above Blair.", state: "resolved", revision: 1, entryId: "reply-entry", actor: { kind: "lois", ref: "lois" }, at: "2026-09-01" }); current.cursor++;
    await mounted.refresh();
    expect(host.querySelector(".people-workspace__notes")?.textContent).toContain("First thought");
    expect(host.querySelector(".people-workspace__reply")?.textContent).toContain("I moved Avery above Blair.");
    expect(input.value).toBe("Second thought");
  });

  it("rejects a wrong-scope response and ignores a read that finishes after destroy", async () => {
    api.read = vi.fn(async () => ({ ...current, contextId: "another-world" }));
    await start(); expect(order()).toEqual([]); expect(host.textContent).toContain("different World");
    mounted.destroy();
    let resolve!: (value: PeopleWorkspace) => void;
    api.read = vi.fn(() => new Promise<PeopleWorkspace>(done => { resolve = done; }));
    mounted = mountPeopleWorkspace(host, { api, scope, onWave }); mounted.destroy();
    resolve(current); await tick(); expect(host.children).toHaveLength(0);
  });
});
