// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { loadVaultWorld } from "../../../sidecar/vault.js";
import { renderHgLoisFlow } from "./hg/lois-flow.js";

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser copy", () => {
  it("opens a genuinely empty vault with the two event-kind choices", () => {
    const root = document.getElementById("app")!;
    renderHgLoisFlow(root, { entries: [], persons: [], contexts: [], gatherings: [] });

    expect(root.querySelector<HTMLInputElement>(".composer__input")).not.toBeNull();
    expect(root.textContent).toContain("I am Lois, the AI concierge in Superpowers. What kind of event are you throwing?");
    expect([...root.querySelectorAll(".thread .chip")].map((button) => button.textContent)).toEqual([
      "TOPICALtalks, demos, panels, themed dinners",
      "SOCIALbirthdays, housewarmings, parties",
    ]);
    expect(root.textContent).not.toContain("3Cs");
    expect(root.textContent).not.toContain("Monday");
  });

  it("sends a cold-open choice through the real Lois conversation", async () => {
    const requests: string[] = [];
    const output = {
      say: "Topical. What are you planning?",
      ui: [{ show: "keep" }],
      proposals: [],
      memory: [],
      questions: [{ ask: "What are you planning?" }],
      replies: [],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/lois/jobs") return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
      if (url === "/api/lois/tell") {
        requests.push(String(init?.body));
        const sse = `event: turn\ndata: ${JSON.stringify({ ok: true, output, traceTail: [], ms: 12 })}\n\n`;
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      throw new Error(`unexpected request: ${url}`);
    }));

    const root = document.getElementById("app")!;
    renderHgLoisFlow(root, { entries: [], persons: [], contexts: [], gatherings: [] });
    root.querySelector<HTMLButtonElement>(".thread .chip")!.click();

    await vi.waitFor(() => expect(root.querySelector(".thread")?.textContent).toContain("Topical. What are you planning?"));
    expect(JSON.parse(requests[0]!)).toEqual({ message: "I'm throwing a topical event." });
    expect(root.querySelector(".thread")?.textContent).toContain("I'm throwing a topical event.");
  });

  it("opens as one conversation instead of a walkthrough menu", () => {
    const root = document.getElementById("app")!;
    const world = loadVaultWorld(resolve(process.cwd(), "tools/fixtures/3cs-smoke-vault"));
    renderHgLoisFlow(root, world);

    expect(root.textContent).toContain("Tell me what you're trying to get done");
    expect(root.querySelector<HTMLInputElement>(".composer__input")).not.toBeNull();
    expect([...root.querySelectorAll(".thread button")].map((button) => button.textContent)).toEqual([]);
    expect(root.textContent).not.toContain("TOPICAL");
    expect(root.textContent).not.toContain("SOCIAL");
    expect(root.textContent).not.toContain("PARTIFUL");
    expect(root.textContent).not.toContain("LUMA");
    expect(document.querySelector<HTMLButtonElement>(".cm-toggle")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>(".cm-sidebar")?.hidden).toBe(true);
  });

  it("shows complete drafts while keeping worker notes out of the conversation", async () => {
    const output = {
      say: "Two drafts are ready. Read them and tell me what to change.",
      // The model may also suggest the people pane after reading history.
      // Completed work wins the stage: this hint must not hide the drafts.
      ui: [{ show: "room" }],
      proposals: [
        {
          kind: "draft",
          to: "Maya",
          channel: "email",
          subject: "The next 3Cs dinner",
          body: "Hi Maya,\n\nWould you like to join us again?",
        },
        {
          kind: "draft",
          to: "Idris",
          channel: "email",
          subject: "Come back to 3Cs",
          body: "Hi Idris,\n\nIt would be good to have you back.",
        },
      ],
      memory: [],
      questions: [],
      replies: [],
    };
    const sse = [
      'event: bus\ndata: {"seq":9,"actor":"critic","kind":"note","label":"internal tripwire"}',
      `event: turn\ndata: ${JSON.stringify({ ok: true, output, traceTail: [], ms: 12 })}`,
      "",
    ].join("\n\n");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/lois/jobs") {
        return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
      }
      if (url === "/api/lois/tell") {
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      throw new Error(`unexpected request: ${url}`);
    }));

    const root = document.getElementById("app")!;
    const world = loadVaultWorld(resolve(process.cwd(), "tools/fixtures/3cs-smoke-vault"));
    renderHgLoisFlow(root, world);
    const input = root.querySelector<HTMLInputElement>(".composer__input")!;
    input.value = "draft Maya and Idris";
    root.querySelector<HTMLButtonElement>(".composer__send")!.click();

    await vi.waitFor(() => expect(root.querySelector(".stage")?.textContent).toContain("HER DRAFTS"));
    expect(root.querySelector(".stage")?.textContent).toContain("Would you like to join us again?");
    expect(root.querySelector(".stage")?.textContent).toContain("It would be good to have you back.");
    expect(root.querySelector(".thread")?.textContent).not.toContain("internal tripwire");
    expect(root.querySelectorAll(".stage .qpaper")).toHaveLength(2);
    expect(root.querySelector<HTMLButtonElement>(".thread .chip")?.textContent).toContain("STAGE HER 2 DRAFTS");
  });

  it("shows a collective draft before the vault has a gathering or roster", async () => {
    const output = {
      say: "The draft is ready for review.",
      ui: [{ show: "browser" }],
      proposals: [{
        kind: "draft",
        to: "past 3Cs guests (10 people)",
        channel: "Luma blast draft, unsent",
        subject: "3Cs tomorrow",
        body: "You joined us for 3Cs before. We are gathering again tomorrow.",
      }],
      memory: [],
      questions: [],
      replies: [],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/lois/jobs") return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
      if (url === "/api/lois/tell") {
        const sse = `event: turn\ndata: ${JSON.stringify({ ok: true, output, traceTail: [], ms: 12 })}\n\n`;
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      throw new Error(`unexpected request: ${url}`);
    }));

    const root = document.getElementById("app")!;
    renderHgLoisFlow(root, { entries: [], persons: [], contexts: [], gatherings: [] });
    const input = root.querySelector<HTMLInputElement>(".composer__input")!;
    input.value = "draft the invitation";
    root.querySelector<HTMLButtonElement>(".composer__send")!.click();

    await vi.waitFor(() => expect(root.querySelector(".stage")?.textContent).toContain("HER DRAFTS"));
    expect(root.querySelector(".stage")?.textContent).toContain("past 3Cs guests (10 people)");
    expect(root.querySelector(".stage")?.textContent).toContain("You joined us for 3Cs before.");
    expect(root.querySelector(".stage")?.textContent).not.toContain("THE BROWSER");
    expect([...root.querySelectorAll(".thread .chip")].map((chip) => chip.textContent).join(" ")).not.toContain("STAGE HER");
  });

  it("keeps the current stage when Lois says it stays", async () => {
    const turns = [
      {
        output: {
          say: "Here is the plan.",
          ui: [{ show: "plan" }],
          proposals: [{ kind: "plan", steps: ["Read the room", "Draft the note"] }],
          memory: [],
          questions: [],
          replies: [],
        },
        traceTail: [],
      },
      {
        output: {
          say: "The plan stays where it is.",
          ui: [{ show: "keep" }],
          proposals: [],
          memory: [],
          questions: [],
          replies: [],
        },
        // A contextual read may suggest another useful pane. The model's
        // explicit stage decision still owns what the organizer sees.
        traceTail: [{ actor: "lois", kind: "tool.call", label: "history" }],
      },
    ];
    let turn = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/lois/jobs") {
        return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
      }
      if (url === "/api/lois/tell") {
        const next = turns[turn++];
        const sse = `event: turn\ndata: ${JSON.stringify({ ok: true, ...next, ms: 12 })}\n\n`;
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      throw new Error(`unexpected request: ${url}`);
    }));

    const root = document.getElementById("app")!;
    const world = loadVaultWorld(resolve(process.cwd(), "tools/fixtures/3cs-smoke-vault"));
    renderHgLoisFlow(root, world);
    const input = root.querySelector<HTMLInputElement>(".composer__input")!;
    const send = root.querySelector<HTMLButtonElement>(".composer__send")!;

    input.value = "show me the plan";
    send.click();
    await vi.waitFor(() => expect(root.querySelector(".stage")?.textContent).toContain("THE PLAN"));

    input.value = "keep it there";
    send.click();
    await vi.waitFor(() => expect(root.querySelector(".thread")?.textContent).toContain("The plan stays where it is."));
    expect(root.querySelector(".stage")?.textContent).toContain("THE PLAN");
    expect(root.querySelector(".stage")?.textContent).not.toContain("YOUR PEOPLE");
  });

  it("keeps a collapsed browser snapshot in the transcript when the live pane receives pixels", async () => {
    const listeners = new Map<string, (ev: MessageEvent) => void>();
    class FakeEventSource {
      constructor(readonly url: string) {}
      addEventListener(name: string, cb: EventListener): void {
        listeners.set(name, cb as (ev: MessageEvent) => void);
      }
      close = vi.fn();
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/lois/jobs") return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
      if (url === "/api/lois/browser/status") {
        return new Response(JSON.stringify({ open: true, mode: "embedded" }), { status: 200 });
      }
      if (url === "/api/lois/tell") {
        const output = {
          say: "I opened the browser and I can see it.",
          ui: [],
          proposals: [],
          memory: [],
          questions: [],
          replies: [],
        };
        const traceTail = [{ actor: "diver", kind: "tool.call", label: "browser_start" }];
        const sse = `event: turn\ndata: ${JSON.stringify({ ok: true, output, traceTail, ms: 12 })}\n\n`;
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      throw new Error(`unexpected request: ${url}`);
    }));

    const root = document.getElementById("app")!;
    const world = loadVaultWorld(resolve(process.cwd(), "tools/fixtures/3cs-smoke-vault"));
    renderHgLoisFlow(root, world);
    const input = root.querySelector<HTMLInputElement>(".composer__input")!;
    input.value = "open luma";
    root.querySelector<HTMLButtonElement>(".composer__send")!.click();

    await vi.waitFor(() => expect(root.querySelector(".stage")?.textContent).toContain("THE BROWSER"));
    listeners.get("frame")?.(new MessageEvent("frame", {
      data: JSON.stringify({ url: "https://lu.ma/home", data: "abc123" }),
    }));

    await vi.waitFor(() => expect(root.querySelector(".thread")?.textContent).toContain("Browser snapshot"));
    expect(root.querySelector<HTMLDetailsElement>(".browser-moment")?.open).toBe(false);
    expect(root.querySelector<HTMLImageElement>(".browser-moment__img")?.src).toContain("abc123");
  });

  it("shows the live browser while Lois is still answering", async () => {
    class FakeEventSource {
      constructor(readonly url: string) {}
      addEventListener(): void {}
      close = vi.fn();
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    let finishTell!: () => void;
    const tellPending = new Promise<void>((resolve) => {
      finishTell = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/lois/jobs") return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
      if (url === "/api/lois/browser/status") {
        return new Response(JSON.stringify({
          open: true,
          url: "https://lu.ma/home",
          mode: "embedded",
          inputOwner: "automation",
        }), { status: 200 });
      }
      if (url === "/api/lois/tell") {
        await tellPending;
        const output = {
          say: "I can see Luma now.",
          ui: [],
          proposals: [],
          memory: [],
          questions: [],
          replies: [],
        };
        const sse = `event: turn\ndata: ${JSON.stringify({ ok: true, output, traceTail: [], ms: 12 })}\n\n`;
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      throw new Error(`unexpected request: ${url}`);
    }));

    const root = document.getElementById("app")!;
    const world = loadVaultWorld(resolve(process.cwd(), "tools/fixtures/3cs-smoke-vault"));
    renderHgLoisFlow(root, world);
    const input = root.querySelector<HTMLInputElement>(".composer__input")!;
    input.value = "open luma";
    root.querySelector<HTMLButtonElement>(".composer__send")!.click();

    await vi.waitFor(() => expect(root.querySelector(".stage")?.textContent).toContain("THE BROWSER"));
    expect(root.querySelector(".stage")?.textContent).toContain("Lois has control");
    expect(root.querySelector(".thread")?.textContent).not.toContain("I can see Luma now.");

    finishTell();
    await vi.waitFor(() => expect(root.querySelector(".thread")?.textContent).toContain("I can see Luma now."));
  });

  it("labels an open browser without a working spinner", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/lois/jobs") {
        return new Response(JSON.stringify({
          jobs: [{
            id: "dive",
            label: "her browser, on lu.ma/home",
            since: Date.now(),
            state: "open",
          }],
        }), { status: 200 });
      }
      throw new Error(`unexpected request: ${url}`);
    }));

    const root = document.getElementById("app")!;
    const world = loadVaultWorld(resolve(process.cwd(), "tools/fixtures/3cs-smoke-vault"));
    renderHgLoisFlow(root, world);

    await vi.waitFor(() => expect(root.querySelector(".jobs")?.textContent).toContain("open: her browser"));
    expect(root.querySelector(".jobs")?.textContent).not.toContain("⏳");
  });

  it("lands a durable background continuation as Lois speech in the visible thread", async () => {
    let land!: (turn: unknown) => void;
    class FakeEventSource {
      constructor(readonly url: string) {}
      addEventListener(type: string, listener: EventListener): void {
        if (type === "turn") {
          land = (turn) => listener(new MessageEvent("turn", { data: JSON.stringify(turn) }));
        }
      }
      close(): void {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/lois/jobs") {
        return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    }));

    const root = document.getElementById("app")!;
    renderHgLoisFlow(root, loadVaultWorld(resolve(process.cwd(), "tools/fixtures/3cs-smoke-vault")));
    land({
      ok: true,
      output: {
        say: "I finished the series history. Three owned exports support it.",
        ui: [{ show: "keep" }],
        proposals: [],
        memory: [],
        questions: [],
        replies: [],
      },
      traceTail: [],
    });

    await vi.waitFor(() => expect(root.querySelector(".thread")?.textContent).toContain(
      "I finished the series history. Three owned exports support it.",
    ));
  });

  it("keeps BACK TO PANE visible when dismiss fails and backend says foreground still owns control", async () => {
    class FakeEventSource {
      constructor(readonly url: string) {}
      addEventListener(): void {}
      close = vi.fn();
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/lois/jobs") return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
      if (url === "/api/lois/browser/status") {
        return new Response(JSON.stringify({
          open: true,
          url: "https://lu.ma/home",
          mode: "foreground_hands",
          inputOwner: "hands",
        }), { status: 200 });
      }
      if (url === "/api/lois/browser/dismiss") {
        return new Response(JSON.stringify({ ok: false, note: "Could not move the window off-screen." }), { status: 409 });
      }
      if (url === "/api/lois/tell") {
        const output = { say: "Take over.", ui: [{ show: "browser" }], proposals: [], memory: [], questions: [], replies: [] };
        const sse = `event: turn\ndata: ${JSON.stringify({ ok: true, output, traceTail: [], ms: 12 })}\n\n`;
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      throw new Error(`unexpected request: ${url}`);
    }));

    const root = document.getElementById("app")!;
    const world = loadVaultWorld(resolve(process.cwd(), "tools/fixtures/3cs-smoke-vault"));
    renderHgLoisFlow(root, world);
    const input = root.querySelector<HTMLInputElement>(".composer__input")!;
    input.value = "show browser";
    root.querySelector<HTMLButtonElement>(".composer__send")!.click();

    await vi.waitFor(() => expect(root.querySelector(".stage")?.textContent).toContain("BACK TO PANE"));
    root.querySelector<HTMLButtonElement>(".macwin__handoff:not([hidden])")!.click();

    await vi.waitFor(() => expect(root.querySelector(".stage")?.textContent).toContain("Could not move"));
    const buttons = [...root.querySelectorAll<HTMLButtonElement>(".macwin__handoff")];
    expect(buttons.find((button) => button.textContent === "BACK TO PANE")?.hidden).toBe(false);
    expect(buttons.find((button) => button.textContent === "TAKE OVER")?.hidden).toBe(true);
  });
});
