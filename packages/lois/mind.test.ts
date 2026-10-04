import { afterEach, describe, expect, it, vi } from "vitest";
import { createLois } from "./system.js";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { createLoisModel } from "./model.js";
import { __mindTest } from "./mind.js";
import type { World } from "../../tools/projections/types.js";

function worldWithUpcoming(count: number): World {
  return {
    entries: [],
    persons: [],
    contexts: Array.from({ length: count }, (_, index) => ({
      id: `world-${index}`,
      name: `World ${index}`,
      kind: "social",
      anchor: "email",
      created_at: "2026-08-29T00:00:00.000Z",
    })),
    gatherings: Array.from({ length: count }, (_, index) => ({
      id: `g-${index}`,
      context: `world-${index}`,
      name: `Gathering ${index}`,
      date: "2026-09-18T01:30:00.000Z",
      upcoming: true,
    })),
  };
}

describe("Lois gathering focus", () => {
  it.each([0, 2])("lets the world-level mind receive a turn with %i upcoming gatherings", async (count) => {
    const lois = createLois({ world: worldWithUpcoming(count), model: null });

    await expect(lois.tell("hello")).resolves.toMatchObject({
      ok: false,
      why: expect.stringMatching(/brain is not connected/i),
    });
    expect(lois.trace.all().map((event) => event.label).join("\n")).not.toMatch(/expected exactly one upcoming gathering/i);
    expect(lois.trace.all().map((event) => event.label).join("\n")).not.toMatch(/has not been spoken to yet/i);
  });

  it("lands a worker continuation as worker evidence rather than fake organizer speech", async () => {
    const lois = createLois({ world: worldWithUpcoming(0), model: null });

    await lois.continueFromWorker('{"jobId":"job-1","status":"complete"}', { jobId: "job-1" });

    expect(lois.trace.all()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor: "diver",
        kind: "heard",
        detail: expect.objectContaining({ jobId: "job-1" }),
      }),
    ]));
    expect(__mindTest.heardLine(lois.trace.all().find((event) => event.kind === "heard")!)).toContain(
      "worker update:",
    );
  });
});

describe("Lois tool runway", () => {
  it("reserves only the final allowed step for speech", () => {
    const prepare = __mindTest.finalStepSpeaks(30);

    expect(prepare({ stepNumber: 0 })).toEqual({});
    expect(prepare({ stepNumber: 28 })).toEqual({});
    expect(prepare({ stepNumber: 29 })).toEqual({ toolChoice: "none" });
  });

  it("treats healthy tool progress as renewal rather than spending a whole-turn wall clock", () => {
    vi.useFakeTimers();
    const watchdog = __mindTest.createIdleWatchdog(75_000);

    vi.advanceTimersByTime(70_000);
    watchdog.renew();
    vi.advanceTimersByTime(70_000);
    expect(watchdog.signal.aborted).toBe(false);

    vi.advanceTimersByTime(5_000);
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.timedOut()).toBe(true);
    watchdog.close();
  });

  it("treats an unresolved event acronym as evidence to retrieve, not copy to invent", () => {
    expect(__mindTest.contract).toContain(
      "An event name or acronym you cannot explain from evidence is a source-reading task",
    );
    expect(__mindTest.contract).toContain("never guess or turn a plausible phrase into a fact");
  });

  it("does not let narration masquerade as a saved event", () => {
    expect(__mindTest.contract).toContain(
      "Never say a World or Gathering was created, connected, saved, or remembered unless the corresponding hand returned success in this turn",
    );
  });

  it("distinguishes a diver's claims from current saved-list evidence", () => {
    expect(__mindTest.contract).toContain("modelReport is the diver's account, not a host receipt");
    expect(__mindTest.contract).toContain("Use people_read for current saved-list counts and coverage");
    expect(__mindTest.contract).toContain("Continue useful unfinished work within the organizer's request");
  });

  it("returns a mouth-side reconciliation to the same worker for saved-state verification", () => {
    expect(__mindTest.workerResultGuidance).toContain("pass that reconciliation to dive as continuation evidence for the same saved job");
    expect(__mindTest.workerResultGuidance).toContain("verify the saved result with people_read");
    expect(__mindTest.workerResultGuidance).toContain("without reopening browser pages");
    expect(__mindTest.workerResultGuidance).toContain("full original intent");
  });

  it.each([true, false])("sends reconciliation guidance only on a worker wake (%s)", async (workerWake) => {
    const provider = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({ chunks: [
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: '{"say":"The saved result is ready for review."}' },
          { type: "text-end", id: "answer" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 5, text: undefined, reasoning: undefined },
          } },
        ] }),
      },
    });
    const lois = createLois({ world: worldWithUpcoming(0), model: createLoisModel(provider) });
    try {
      const result = workerWake
        ? await lois.continueFromWorker('{"jobId":"job-1","status":"partial"}', { jobId: "job-1" })
        : await lois.tell("Read the saved findings.");
      expect(result.ok).toBe(true);
      expect(provider.doStreamCalls).toHaveLength(1);
      const prompt = JSON.stringify(provider.doStreamCalls[0]!.prompt);
      const reconciliation = "pass that reconciliation to dive as continuation evidence for the same saved job";
      if (workerWake) expect(prompt).toContain(reconciliation);
      else expect(prompt).not.toContain(reconciliation);
    } finally {
      lois.cancel();
      await lois.idle();
    }
  });

  it("allows ongoing research without weakening an organizer's requested checkpoint", () => {
    expect(__mindTest.contract).toContain("A progress reply does not finish or pause an already-requested research job");
    expect(__mindTest.contract).toContain("requestApplied=false means the running worker did not receive your new intent");
    expect(__mindTest.contract).toContain("do not also propose that same work in the turn that asks");
    expect(__mindTest.contract).toContain("that inspection is the whole turn");
    expect(__mindTest.contract).toContain("Every proposal is held for the organizer's approval before it is committed");
  });

  it("keeps source identity assessment inside the requested combined-list work", () => {
    expect(__mindTest.contract).toContain("Identity assessment is part of combining lists");
    expect(__mindTest.contract).toContain("includeEvidence");
    expect(__mindTest.contract).toContain("same name is not proof");
  });

  it("treats a requested source check as the work instead of answering from saved context", () => {
    expect(__mindTest.contract).toMatch(
      /When the organizer asks you to check a named source or the browser, checking that source is the\s+acceptance criterion/,
    );
    expect(__mindTest.contract).toMatch(
      /Never say you opened, read, or checked\s+a page unless the corresponding hand returned evidence in this turn/,
    );
  });
});

afterEach(() => vi.useRealTimers());
