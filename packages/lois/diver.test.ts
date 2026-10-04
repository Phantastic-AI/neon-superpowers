import { describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { Trace } from "./trace.js";
import {
  __diverTest,
  createDiver,
  createMemoryDiverJobStore,
  parseDiverJob,
  type DiverCapability,
  type DiverModelRun,
} from "./diver.js";

function capability(
  run: DiverCapability["run"],
  evidenceCategories?: DiverCapability["evidenceCategories"],
): DiverCapability {
  return {
    description: "bounded test capability",
    inputSchema: { parse: (input: unknown) => input } as DiverCapability["inputSchema"],
    run,
    evidenceCategories,
  };
}

describe("Lois diver session", () => {
  it.each(["partial", "awaiting_human"])("restores tool evidence after %s, but not into a new job", async status => {
    const secret = "artifact-owned-47; headers Guest,Registration; private@example.test";
    let n = 0;
    const provider = new MockLanguageModelV4({ doStream: async () => {
      n += 1;
      const reporting = n % 2 === 0;
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: `call-${n}`, toolName: reporting ? "report" : "read",
          input: reporting ? JSON.stringify({ status: n === 2 ? status : "complete",
            goalCategory: "live_readonly_canary", summary: "Unhelpful summary",
            evidence: [], evidenceCategories: ["browser_frame"] }) : "{}" },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: usage() },
      ] }) };
    } });
    let saved = "null";
    const store = { load: () => parseDiverJob(JSON.parse(saved)), save: (job: unknown) => { saved = JSON.stringify(job); } };
    const trace = new Trace();
    const options = { model: { model: provider as unknown as LanguageModel } as never,
      trace, store, maxSteps: 2,
      capabilities: { read: { description: "Read evidence", inputSchema: z.object({}),
        run: async () => n === 1 ? secret : "current evidence", evidenceCategories: () => ["browser_frame"] } } };
    const first = await createDiver(options)({ intent: "Research the source" });
    const second = await createDiver(options)({ intent: "Continue the saved research" });
    expect(JSON.parse(first).status).toBe(status);
    expect(JSON.parse(second).jobId).toBe(JSON.parse(first).jobId);
    expect(JSON.stringify(provider.doStreamCalls[2].prompt)).toContain(secret);
    expect(first + second + JSON.stringify(trace.all())).not.toContain(secret);
    await createDiver(options)({ intent: "Research a different source" });
    expect(JSON.stringify(provider.doStreamCalls[4].prompt)).not.toContain(secret);
  });

  it("retains earned host evidence when reporting fails without certifying completion", async () => {
    const store = createMemoryDiverJobStore();
    const dive = createDiver({ model: {} as never, trace: new Trace(), store,
      capabilities: { save: capability(async () => "saved", () => ["guestlist_saved"]) },
      runModel: async ({ capabilities }) => {
        await capabilities.save.run({});
        throw new Error("Inference budget refused: calls per turn limit reached.");
      },
    });
    expect(JSON.parse(await dive({ intent: "Save the lists" })).status).toBe("blocked");
    expect(store.load()).toMatchObject({ status: "blocked", hostEvidenceCategories: ["guestlist_saved"] });
  });

  it("persists evidence invalidation even when the resumed report fails", async () => {
    const store = createMemoryDiverJobStore();
    const prior = { version: 1 as const, id: "job", intent: "Save the lists", status: "partial" as const,
      createdAt: 0, updatedAt: 0, hostEvidenceCategories: ["guestlist_saved"], continuations: [] };
    store.save(prior);
    const dive = createDiver({ model: {} as never, trace: new Trace(), store,
      capabilities: { select: { ...capability(async () => "scope changed"), invalidatesEvidenceCategories: () => ["guestlist_saved"] } },
      runModel: async ({ capabilities }) => {
        await capabilities.select.run({});
        throw new Error("provider unavailable");
      },
    });
    await dive({ intent: "Include another list" });
    expect(store.load()).toMatchObject({ status: "blocked", hostEvidenceCategories: [] });
  });

  it("requires a saved people receipt to certify a guestlist import", () => {
    const report = { status: "complete" as const, goalCategory: "guestlist_import", summary: "People saved", evidence: ["e-10"], evidenceCategories: ["guestlist_saved"] };
    expect(__diverTest.adjudicateCompletion(report, ["guestlist_saved"]).status).toBe("complete");
    expect(__diverTest.adjudicateCompletion(report, ["current_event_csv"]).status).toBe("partial");
    expect(__diverTest.adjudicateCompletion({ ...report, evidenceCategories: ["prospect_saved"] }, ["prospect_saved"]).status).toBe("partial");
  });

  it("certifies prospect research only when both the model and a successful host capability record the save", async () => {
    const prospectReport = {
      status: "complete" as const,
      goalCategory: "prospect_research",
      summary: "The source-backed prospect findings are saved and the requested research is complete.",
      evidence: ["saved-prospect-result"],
      evidenceCategories: ["prospect_saved"],
    };
    const saved = createDiver({
      model: {} as never,
      trace: new Trace(),
      store: createMemoryDiverJobStore(),
      capabilities: {
        people_save_prospect: capability(async () => "saved prospect", () => ["prospect_saved"]),
      },
      runModel: async ({ capabilities }) => {
        await capabilities.people_save_prospect.run({});
        return { text: JSON.stringify(prospectReport), steps: 2, toolCalls: 1 };
      },
    });
    const modelOnly = createDiver({
      model: {} as never,
      trace: new Trace(),
      store: createMemoryDiverJobStore(),
      capabilities: {},
      runModel: async () => ({ text: JSON.stringify(prospectReport), steps: 2, toolCalls: 1 }),
    });

    expect(JSON.parse(await saved({ intent: "Research and save source-backed prospects." })).status).toBe("complete");
    expect(JSON.parse(await modelOnly({ intent: "Research and save source-backed prospects." })).status).toBe("partial");
    expect(__diverTest.adjudicateCompletion({ ...prospectReport, status: "partial" }, ["prospect_saved"]).status).toBe("partial");
  });

  it("does not emit prospect evidence when the saving capability fails", async () => {
    const store = createMemoryDiverJobStore();
    const dive = createDiver({
      model: {} as never,
      trace: new Trace(),
      store,
      capabilities: {
        people_save_prospect: capability(async () => { throw new Error("save refused"); }, () => ["prospect_saved"]),
      },
      runModel: async ({ capabilities }) => {
        await capabilities.people_save_prospect.run({});
        return { text: "unreachable", steps: 1, toolCalls: 1 };
      },
    });

    await expect(dive({ intent: "Save a source-backed prospect." })).resolves.toContain('"status":"blocked"');
    expect(store.load()).toMatchObject({ status: "blocked", hostEvidenceCategories: [] });
  });
  it("does not reuse old completion evidence after a capability changes the source scope", async () => {
    const store = createMemoryDiverJobStore();
    const select = { ...capability(async () => "scope changed"), invalidatesEvidenceCategories: () => ["guestlist_saved"] };
    const dive = createDiver({ model: {} as never, trace: new Trace(), store,
      capabilities: { save: capability(async () => "saved", () => ["guestlist_saved"]), select },
      runModel: async ({ capabilities }) => {
        await capabilities.save.run({});
        await capabilities.select.run({});
        return { text: JSON.stringify({ status: "complete", goalCategory: "guestlist_import", summary: "A saved, B unread", evidence: ["e-10"], evidenceCategories: ["guestlist_saved"] }), steps: 3, toolCalls: 2 };
      },
    });
    expect(JSON.parse(await dive({ intent: "Combine two lists" })).status).toBe("partial");
    expect(store.load()?.hostEvidenceCategories).not.toContain("guestlist_saved");
  });
  it("keeps raw browser material inside the diver and returns a compact report to the mouth", async () => {
    const trace = new Trace();
    const raw = "name,email\nAda,ada@example.com\nGrace,grace@example.com";
    const observe = vi.fn(async () => raw);
    const runModel: DiverModelRun = vi.fn(async ({ capabilities }) => {
      const material = await capabilities.browser_observe.run({});
      expect(material).toBe(raw);
      return {
        text: JSON.stringify({
          status: "complete",
          goalCategory: "current_event_export",
          summary: "Found two people in the organizer's browser export.",
          evidence: ["current browser artifact"],
          evidenceCategories: ["current_event_csv"],
        }),
        steps: 2,
        toolCalls: 1,
      };
    });
    const dive = createDiver({
      model: {} as never,
      trace,
      capabilities: {
        browser_observe: capability(observe, () => ["current_event_csv"]),
      },
      store: createMemoryDiverJobStore(),
      runModel,
    });
    const onProgress = vi.fn();

    const report = JSON.parse(await dive(
      { intent: "Work out who is in this export." },
      { onProgress },
    )) as {
      status: string;
      modelReport?: { summary: string };
    };

    expect(report).toMatchObject({
      status: "complete",
      modelReport: {
        summary: "Found two people in the organizer's browser export.",
      },
    });
    expect(report).not.toHaveProperty("summary");
    expect(observe).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(trace.all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: "diver", kind: "tool.call", label: "browser_observe" }),
      expect.objectContaining({ actor: "diver", kind: "tool.return" }),
    ]));
    expect(JSON.stringify(trace.all())).not.toContain("ada@example.com");
    expect(JSON.stringify(trace.all())).not.toContain("grace@example.com");
  });

  it("renews progress from native streamed model chunks before the final step completes", async () => {
    const onProgress = vi.fn();
    const report = JSON.stringify({
      status: "complete",
      goalCategory: "current_event_export",
      summary: "The browser export was read.",
      evidence: ["artifact-1"],
      evidenceCategories: ["current_event_csv"],
    });
    const rawModel = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: report.slice(0, 30) },
            { type: "text-delta", id: "text-1", delta: report.slice(30) },
            { type: "text-end", id: "text-1" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
          ],
        }),
      }),
    });

    const result = await __diverTest.defaultRunDiverModel({
      model: { model: rawModel as unknown as LanguageModel } as never,
      system: "system",
      prompt: "prompt",
      capabilities: {},
      maxSteps: 2,
      onProgress,
    });

    expect(rawModel.doGenerateCalls).toHaveLength(0);
    expect(rawModel.doStreamCalls).toHaveLength(1);
    expect(result.report).toMatchObject({ status: "complete", summary: "The browser export was read." });
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("forces the terminal report with native streaming while preserving narrative and counts", async () => {
    const rawModel = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "narrative" },
              { type: "text-delta", id: "narrative", delta: "I found two old exports and one is saved." },
              { type: "text-end", id: "narrative" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "report-1",
                toolName: "report",
                input: JSON.stringify({
                  status: "partial",
                  goalCategory: "guestlist_import",
                  summary: "The typed report landed.",
                  evidence: ["artifact-a"],
                  evidenceCategories: ["guestlist_saved"],
                }),
              },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: usage() },
            ],
          }),
        },
      ],
    });

    const result = await __diverTest.defaultRunDiverModel({
      model: { model: rawModel as unknown as LanguageModel } as never,
      system: "system",
      prompt: "prompt",
      capabilities: {},
      maxSteps: 3,
      onProgress: vi.fn(),
    });

    expect(rawModel.doGenerateCalls).toHaveLength(0);
    expect(rawModel.doStreamCalls).toHaveLength(2);
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toBe(0);
    expect(result.report).toMatchObject({
      status: "partial",
      summary: expect.stringContaining("I found two old exports"),
    });
  });

  it("blocks a report tool-call when the same provider stream errors before completion", async () => {
    const store = createMemoryDiverJobStore();
    const probe = vi.fn(async () => "captured current event csv");
    const rawModel = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "probe-1", toolName: "probe", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: usage() },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "report-1",
                toolName: "report",
                input: JSON.stringify({
                  status: "complete",
                  goalCategory: "current_event_export",
                  summary: "The export is captured.",
                  evidence: ["artifact-current"],
                  evidenceCategories: ["current_event_csv"],
                }),
              },
              { type: "error", error: new Error("PROVIDER_STREAM_BROKE_AFTER_REPORT") },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: usage() },
            ],
          }),
        },
      ],
    });
    const dive = createDiver({
      model: { model: rawModel as unknown as LanguageModel } as never,
      trace: new Trace(),
      capabilities: {
        probe: {
          description: "probe",
          inputSchema: z.object({}),
          run: probe,
          evidenceCategories: () => ["current_event_csv"],
        },
      },
      store,
    });

    const report = JSON.parse(await dive({ intent: "Capture the export." })) as {
      status: string;
      summary: string;
    };

    expect(probe).toHaveBeenCalledOnce();
    expect(rawModel.doStreamCalls).toHaveLength(2);
    expect(report).toMatchObject({
      status: "blocked",
      summary: "The diver stopped with an error: PROVIDER_STREAM_BROKE_AFTER_REPORT",
    });
    expect(store.load()).toMatchObject({ status: "blocked" });
  });

  it("propagates native streaming abort errors as blocked dive state", async () => {
    const store = createMemoryDiverJobStore();
    const controller = new AbortController();
    const rawModel = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        controller.abort();
        abortSignal?.throwIfAborted();
        throw new Error("unreachable");
      },
    });
    const dive = createDiver({
      model: { model: rawModel as unknown as LanguageModel } as never,
      trace: new Trace(),
      capabilities: {},
      store,
    });

    const report = JSON.parse(await dive({ intent: "Keep working until cancelled." }, { signal: controller.signal })) as {
      status: string;
      summary: string;
    };

    expect(report).toMatchObject({ status: "blocked", summary: "The dive was cancelled." });
    expect(store.load()).toMatchObject({ status: "blocked", summary: "The dive was cancelled." });
  });

  it("does not force a terminal report after a provider stream error with partial text", async () => {
    const store = createMemoryDiverJobStore();
    const rawModel = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "partial" },
            { type: "text-delta", id: "partial", delta: "{\"status\":\"complete\"," },
            { type: "error", error: new Error("provider stream broke") },
          ],
        }),
      }),
    });
    const dive = createDiver({
      model: { model: rawModel as unknown as LanguageModel } as never,
      trace: new Trace(),
      capabilities: {},
      store,
    });

    const report = JSON.parse(await dive({ intent: "Read the stream." })) as {
      status: string;
      summary: string;
    };

    expect(report).toMatchObject({
      status: "blocked",
      summary: "The diver stopped with an error: provider stream broke",
    });
    expect(rawModel.doStreamCalls).toHaveLength(1);
    expect(store.load()).toMatchObject({ status: "blocked" });
  });

  it("treats abort after prior capability progress as cancellation instead of a partial report", async () => {
    const store = createMemoryDiverJobStore();
    const controller = new AbortController();
    const observe = vi.fn(async () => {
      controller.abort();
      return "observed current page";
    });
    const rawModel = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "observe-1",
              toolName: "browser_observe",
              input: "{}",
            },
            { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: usage() },
          ],
        }),
      }),
    });
    const dive = createDiver({
      model: { model: rawModel as unknown as LanguageModel } as never,
      trace: new Trace(),
      capabilities: {
        browser_observe: {
          description: "observe",
          inputSchema: z.object({}),
          run: observe,
          evidenceCategories: () => ["browser_frame"],
        },
      },
      store,
    });

    const report = JSON.parse(await dive({ intent: "Read until cancelled." }, { signal: controller.signal })) as {
      status: string;
      summary: string;
    };

    expect(observe).toHaveBeenCalledOnce();
    expect(report).toMatchObject({ status: "blocked", summary: "The dive was cancelled." });
    expect(store.load()).toMatchObject({ status: "blocked", summary: "The dive was cancelled." });
  });

  it("resumes the same persisted job after a human handoff", async () => {
    const store = createMemoryDiverJobStore();
    const prompts: string[] = [];
    const runModel: DiverModelRun = vi.fn(async ({ prompt }) => {
      prompts.push(prompt);
      return prompts.length === 1
        ? {
            text: JSON.stringify({
              status: "awaiting_human",
              goalCategory: "current_event_export",
              summary: "The browser is waiting for the organizer to confirm access.",
              next: "Confirm access in the browser, then tell Lois it is done.",
              evidence: ["owned browser handoff"],
              evidenceCategories: ["browser_frame"],
            }),
            steps: 3,
            toolCalls: 2,
            hostEvidenceCategories: ["browser_frame"],
          }
        : {
            text: JSON.stringify({
              status: "complete",
              goalCategory: "current_event_export",
              summary: "The confirmed export is captured and ready.",
              evidence: ["captured browser artifact"],
              evidenceCategories: ["current_event_csv"],
            }),
            steps: 2,
            toolCalls: 1,
            hostEvidenceCategories: ["current_event_csv"],
          };
    });
    const dive = createDiver({
      model: {} as never,
      trace: new Trace(),
      capabilities: {},
      store,
      runModel,
    });

    const waiting = JSON.parse(await dive({ intent: "Export the people for this event." })) as { jobId: string };
    const resumed = JSON.parse(await dive({ intent: "The organizer finished the browser confirmation." })) as {
      jobId: string;
      status: string;
    };

    expect(resumed).toMatchObject({ jobId: waiting.jobId, status: "complete" });
    expect(prompts[1]).toContain("Export the people for this event.");
    expect(prompts[1]).toContain("Previous host-adjudicated status: awaiting_human");
    expect(prompts[1]).toContain("Previous model-authored summary: The browser is waiting for the organizer to confirm access.");
    expect(prompts[1]).toContain("Host evidence categories currently recorded: browser_frame.");
    expect(prompts[1]).toContain("The organizer finished the browser confirmation.");
    expect(store.load()).toMatchObject({ id: waiting.jobId, status: "complete" });
  });

  it("reports a missing diver brain honestly without touching capabilities", async () => {
    const observe = vi.fn(async () => "not used");
    const dive = createDiver({
      model: null,
      trace: new Trace(),
      capabilities: { browser_observe: capability(observe) },
      store: createMemoryDiverJobStore(),
    });

    await expect(dive({ intent: "Read the browser." })).resolves.toMatch(/brain is not connected/i);
    expect(observe).not.toHaveBeenCalled();
  });

  it("blocks malformed brain output instead of claiming the job completed", async () => {
    const store = createMemoryDiverJobStore();
    const dive = createDiver({
      model: {} as never,
      trace: new Trace(),
      capabilities: {},
      store,
      runModel: async () => ({
        text: "I need the organizer to confirm something in the browser.",
        steps: 1,
        toolCalls: 0,
      }),
    });

    const report = JSON.parse(await dive({ intent: "Read the event people." })) as {
      status: string;
      summary: string;
      reportedStatus?: string;
      modelReport?: unknown;
    };

    expect(report).toMatchObject({
      status: "blocked",
      summary: "The diver's brain returned a malformed report. No completion was recorded.",
    });
    expect(report).not.toHaveProperty("reportedStatus");
    expect(report).not.toHaveProperty("modelReport");
    expect(store.load()).toMatchObject({
      status: "blocked",
      summary: "The diver's brain returned a malformed report. No completion was recorded.",
    });
  });

  it("uses the provider's schema-validated report instead of reparsing display text", async () => {
    const dive = createDiver({
      model: {} as never,
      trace: new Trace(),
      capabilities: {},
      store: createMemoryDiverJobStore(),
      runModel: async () => ({
        text: "provider display text is not the report contract",
        report: {
          status: "complete",
          goalCategory: "current_event_export",
          summary: "The bounded research completed.",
          evidence: ["obs-7"],
          evidenceCategories: ["current_event_csv"],
        },
        steps: 2,
        toolCalls: 1,
        hostEvidenceCategories: ["current_event_csv"],
      }),
    });

    await expect(dive({ intent: "Inspect the page." })).resolves.toContain(
      '"summary":"The bounded research completed."',
    );
  });

  it("rejects completion that has no capability work behind it", async () => {
    const dive = createDiver({
      model: {} as never,
      trace: new Trace(),
      capabilities: {},
      store: createMemoryDiverJobStore(),
      runModel: async () => ({
        text: "",
        report: {
          status: "complete",
          goalCategory: "current_event_export",
          summary: "I inspected the page.",
          evidence: ["obs-invented"],
          evidenceCategories: ["current_event_csv"],
        },
        steps: 1,
        toolCalls: 0,
      }),
    });

    await expect(dive({ intent: "Inspect the page." })).resolves.toContain(
      "without using any capability",
    );
  });

  it("keeps completion partial when the model claims evidence the host never observed", async () => {
    const dive = createDiver({
      model: {} as never,
      trace: new Trace(),
      capabilities: {},
      store: createMemoryDiverJobStore(),
      runModel: async () => ({
        text: JSON.stringify({
          status: "complete",
          goalCategory: "series_history",
          summary: "I say the series index exists.",
          evidence: ["invented-index"],
          evidenceCategories: ["series_attendance_index"],
        }),
        steps: 2,
        toolCalls: 1,
      }),
    });

    await expect(dive({ intent: "Build the series history." })).resolves.toContain('"status":"partial"');
  });

  it("returns host evidence and the model-authored report separately when completion is downgraded", async () => {
    const dive = createDiver({
      model: {} as never,
      trace: new Trace(),
      capabilities: {},
      store: createMemoryDiverJobStore(),
      runModel: async () => ({
        text: JSON.stringify({
          status: "complete",
          goalCategory: "guestlist_import",
          summary: "Both source lists are saved.",
          next: "No further work remains.",
          evidence: ["claimed-complete"],
          evidenceCategories: ["guestlist_saved"],
        }),
        steps: 2,
        toolCalls: 1,
        hostEvidenceCategories: ["current_event_csv"],
      }),
    });

    const report = JSON.parse(await dive({ intent: "Save the historical guestlists." })) as {
      status: string;
      reportedStatus?: string;
      hostEvidenceCategories?: string[];
      evidenceCategories?: string[];
      summary?: string;
      next?: string;
      modelReport?: {
        status: string;
        summary: string;
        next?: string;
        evidence: string[];
        evidenceCategories: string[];
      };
      completionCheck?: {
        status: string;
        reason: string;
        requiredEvidenceCategories: string[];
        missingModelEvidenceCategories: string[];
        missingHostEvidenceCategories: string[];
      };
    };

    expect(report).toMatchObject({
      status: "partial",
      reportedStatus: "complete",
      hostEvidenceCategories: ["current_event_csv"],
      completionCheck: {
        status: "downgraded",
        reason: "missing_required_evidence",
        requiredEvidenceCategories: ["guestlist_saved"],
        missingModelEvidenceCategories: [],
        missingHostEvidenceCategories: ["guestlist_saved"],
      },
      modelReport: {
        status: "complete",
        summary: "Both source lists are saved.",
        next: "No further work remains.",
        evidence: ["claimed-complete"],
        evidenceCategories: ["guestlist_saved"],
      },
    });
    expect(report).not.toHaveProperty("evidenceCategories");
    expect(report).not.toHaveProperty("summary");
    expect(report).not.toHaveProperty("next");
  });

  it("shows fresh host evidence to the native in-loop terminal report step after capability changes", async () => {
    const save = vi.fn(async () => "saved one source");
    const rawModel = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "save-1", toolName: "save", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: usage() },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "report-1",
                toolName: "report",
                input: JSON.stringify({
                  status: "complete",
                  goalCategory: "guestlist_import",
                  summary: "The saved source is recorded.",
                  evidence: ["artifact-a"],
                  evidenceCategories: ["guestlist_saved"],
                }),
              },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: usage() },
            ],
          }),
        },
      ],
    });

    await __diverTest.defaultRunDiverModel({
      model: { model: rawModel as unknown as LanguageModel } as never,
      system: "system",
      prompt: "prompt",
      capabilities: {
        save: {
          description: "save",
          inputSchema: z.object({}),
          run: save,
          evidenceCategories: () => ["guestlist_saved"],
        },
      },
      maxSteps: 2,
      readHostEvidenceCategories: () => save.mock.calls.length > 0 ? ["guestlist_saved"] : [],
    });

    expect(save).toHaveBeenCalledOnce();
    expect(JSON.stringify(rawModel.doStreamCalls[0])).toContain("Host evidence categories currently recorded by capability returns: none");
    expect(JSON.stringify(rawModel.doStreamCalls[1])).toContain("Host evidence categories currently recorded by capability returns: guestlist_saved");
  });

  it("shows fresh host evidence to the forced report fallback after capability invalidation", async () => {
    let hostEvidence = ["guestlist_saved"];
    const expandScope = vi.fn(async () => {
      hostEvidence = [];
      return "scope expanded";
    });
    const rawModel = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "expand-1", toolName: "expand", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: usage() },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "narrative" },
              { type: "text-delta", id: "narrative", delta: "I expanded the source scope and need to report." },
              { type: "text-end", id: "narrative" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "report-1",
                toolName: "report",
                input: JSON.stringify({
                  status: "partial",
                  goalCategory: "guestlist_import",
                  summary: "The source scope changed; more import work remains.",
                  evidence: ["artifact-a"],
                  evidenceCategories: ["guestlist_saved"],
                }),
              },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: usage() },
            ],
          }),
        },
      ],
    });

    await __diverTest.defaultRunDiverModel({
      model: { model: rawModel as unknown as LanguageModel } as never,
      system: "system",
      prompt: "prompt",
      capabilities: {
        expand: {
          description: "expand",
          inputSchema: z.object({}),
          run: expandScope,
          invalidatesEvidenceCategories: () => ["guestlist_saved"],
        },
      },
      maxSteps: 2,
      readHostEvidenceCategories: () => hostEvidence,
    });

    expect(expandScope).toHaveBeenCalledOnce();
    expect(rawModel.doStreamCalls).toHaveLength(3);
    expect(JSON.stringify(rawModel.doStreamCalls[1])).toContain("Host evidence categories currently recorded by capability returns: none");
    expect(JSON.stringify(rawModel.doStreamCalls[2])).toContain("Host evidence categories currently recorded by capability returns: none");
  });

  it("reserves the last step for the typed report tool", () => {
    const prepare = __diverTest.finalStepReports(20);

    expect(prepare({ stepNumber: 18 })).toEqual({});
    expect(prepare({ stepNumber: 19 })).toEqual({
      activeTools: ["report"],
      toolChoice: { type: "tool", toolName: "report" },
    });
  });

  it("navigates from observed evidence instead of inventing routes or restarting a healthy browser", () => {
    expect(__diverTest.system).toContain("Follow observed navigation refs; do not invent URLs");
    expect(__diverTest.system).toContain("Do not restart a healthy, observable browser");
    expect(__diverTest.system).toMatch(/report what the source\s+contains and what is absent/);
  });

  it("uses local World capabilities instead of job or source IDs when a people import needs a World", () => {
    expect(__diverTest.system).toContain("If no usable World ID is in your context, read worlds");
    expect(__diverTest.system).toContain("use remember_world only when needed");
  });

  it("distinguishes saved source coverage from assessed identity in combined people work", () => {
    expect(__diverTest.system).toContain("Identity assessment is part of combining lists");
    expect(__diverTest.system).toContain("includeEvidence");
    expect(__diverTest.system).toContain("Source coverage proves rows were saved, not that identity assessment is finished");
  });

  it("finishes a page read from the opening observation without artifact ceremony", () => {
    expect(__diverTest.system).toMatch(/browser_start already returns.*semantic observation/i);
    expect(__diverTest.system).toMatch(/report immediately.*answers the intent/i);
    expect(__diverTest.system).toMatch(/capture.*only when/i);
    expect(__diverTest.system).toMatch(/call report on your very next step/i);
    expect(__diverTest.system).toMatch(/exact observed values/i);
  });

  it("keeps a useful prose result when the typed report needs a second pass", () => {
    const report = __diverTest.preserveNarrative({
      status: "partial",
      goalCategory: "live_readonly_canary",
      summary: "The report envelope landed.",
      evidence: ["obs-1"],
      evidenceCategories: ["browser_frame"],
    }, "The page shows three people and a September 17 date.");

    expect(report.summary).toContain("three people and a September 17 date");
    expect(report.summary).toContain("The report envelope landed");
  });

  it("keeps human handoffs supple instead of requiring status-specific paperwork", () => {
    expect(__diverTest.normalizeReport(JSON.stringify({
      status: "awaiting_human",
      goalCategory: "current_event_export",
      summary: "Luma is showing its access confirmation.",
      next: "Enter the code in the summoned browser.",
      evidence: ["current browser observation"],
      evidenceCategories: ["browser_frame"],
      provider_note: "extra provider context is harmless",
    }))).toEqual({
      status: "awaiting_human",
      goalCategory: "current_event_export",
      summary: "Luma is showing its access confirmation.",
      next: "Enter the code in the summoned browser.",
      evidence: ["current browser observation"],
      evidenceCategories: ["browser_frame"],
    });
  });

  it("keeps a series-history job partial when it only found a current-event export", async () => {
    const store = createMemoryDiverJobStore();
    const dive = createDiver({
      model: {} as never,
      trace: new Trace(),
      capabilities: {},
      store,
      runModel: async () => ({
        text: JSON.stringify({
          status: "complete",
          goalCategory: "series_history",
          summary: "The current event export is captured.",
          evidence: ["artifact-current"],
          evidenceCategories: ["current_event_csv"],
        }),
        steps: 2,
        toolCalls: 1,
        hostEvidenceCategories: ["current_event_csv"],
      }),
    });

    const report = JSON.parse(await dive({ intent: "Build the attendance history for this series." })) as {
      status: string;
      completionCheck?: {
        reason: string;
        requiredEvidenceCategories: string[];
        missingModelEvidenceCategories: string[];
        missingHostEvidenceCategories: string[];
      };
    };

    expect(report.status).toBe("partial");
    expect(report.completionCheck).toMatchObject({
      reason: "missing_required_evidence",
      requiredEvidenceCategories: ["series_attendance_index"],
      missingModelEvidenceCategories: ["series_attendance_index"],
      missingHostEvidenceCategories: ["series_attendance_index"],
    });
    expect(store.load()).toMatchObject({ status: "partial" });
  });

  it("does not auto-complete unknown goal or evidence categories", async () => {
    for (const report of [
      {
        status: "complete",
        goalCategory: "future_world_shape",
        summary: "An unfamiliar goal was explored.",
        evidence: ["artifact-1"],
        evidenceCategories: ["artifact_index_entry"],
      },
      {
        status: "complete",
        goalCategory: "current_event_export",
        summary: "An unfamiliar artifact was found.",
        evidence: ["artifact-2"],
        evidenceCategories: ["future_artifact_shape"],
      },
    ]) {
      const dive = createDiver({
        model: {} as never,
        trace: new Trace(),
        capabilities: {},
        store: createMemoryDiverJobStore(),
        runModel: async () => ({
          text: JSON.stringify(report),
          steps: 2,
          toolCalls: 1,
        }),
      });

      const result = JSON.parse(await dive({ intent: "Research this open-ended goal." })) as {
        status: string;
        completionCheck?: { reason: string; goalCategory: string };
      };
      expect(result.status).toBe("partial");
      if (report.goalCategory === "future_world_shape") {
        expect(result.completionCheck).toMatchObject({
          reason: "unknown_goal",
          goalCategory: "future_world_shape",
        });
      } else {
        expect(result.completionCheck).toMatchObject({
          reason: "missing_required_evidence",
          goalCategory: "current_event_export",
        });
      }
    }
  });

  it("accepts completion when the typed goal has its primary evidence", async () => {
    const dive = createDiver({
      model: {} as never,
      trace: new Trace(),
      capabilities: {},
      store: createMemoryDiverJobStore(),
      runModel: async () => ({
        text: JSON.stringify({
          status: "complete",
          goalCategory: "series_history",
          summary: "The series attendance index is ready.",
          evidence: ["artifact-series"],
          evidenceCategories: ["series_attendance_index"],
        }),
        steps: 2,
        toolCalls: 1,
        hostEvidenceCategories: ["series_attendance_index"],
      }),
    });

    await expect(dive({ intent: "Build the series attendance history." })).resolves.toContain(
      '"status":"complete"',
    );
  });

  it("continues the same job after a partial report gathers more evidence", async () => {
    const store = createMemoryDiverJobStore();
    let calls = 0;
    const dive = createDiver({
      model: {} as never,
      trace: new Trace(),
      capabilities: {},
      store,
      runModel: async () => {
        calls += 1;
        return {
          text: JSON.stringify({
            status: "complete",
            goalCategory: "series_history",
            summary: calls === 1 ? "One event is captured." : "The series index is ready.",
            evidence: [calls === 1 ? "artifact-current" : "artifact-series"],
            evidenceCategories: [
              calls === 1 ? "current_event_csv" : "series_attendance_index",
            ],
          }),
          steps: 2,
          toolCalls: 1,
          hostEvidenceCategories: [
            calls === 1 ? "current_event_csv" : "series_attendance_index",
          ],
        };
      },
    });

    const partial = JSON.parse(await dive({ intent: "Build the series attendance history." })) as {
      jobId: string;
      status: string;
    };
    const complete = JSON.parse(await dive({ intent: "Continue from the owned evidence." })) as {
      jobId: string;
      status: string;
    };

    expect(partial.status).toBe("partial");
    expect(complete).toMatchObject({ jobId: partial.jobId, status: "complete" });
    expect(store.load()).toMatchObject({ id: partial.jobId, status: "complete" });
  });

  it("settles the same prospect job after saved-list reconciliation without revisiting the browser", async () => {
    const store = createMemoryDiverJobStore();
    const save = vi.fn(async () => "saved source-backed findings");
    const read = vi.fn(async () => "saved findings reconcile the remaining identity question");
    const browse = vi.fn(async () => "fresh browser material");
    const workingMessages = [{ role: "user" as const, content: "retained source analysis" }];
    let calls = 0;
    const originalIntent = "Research the relevant prospects, save the findings, and reconcile overlaps.";
    const reconciliation = "The saved People view confirms the overlapping source records refer to one person.";
    const dive = createDiver({
      model: {} as never,
      trace: new Trace(),
      store,
      capabilities: {
        people_save_prospect: capability(save, () => ["prospect_saved"]),
        people_read: capability(read),
        browser_observe: capability(browse, () => ["browser_frame"]),
      },
      runModel: async ({ prompt, capabilities, workingMessages: retained }) => {
        calls += 1;
        if (calls === 1) {
          await capabilities.people_save_prospect.run({});
          return {
            text: JSON.stringify({
              status: "partial",
              goalCategory: "prospect_research",
              summary: "The findings are saved, with one overlap still unresolved.",
              next: "Reconcile the saved overlap.",
              evidence: ["saved-prospect-result"],
              evidenceCategories: ["prospect_saved"],
            }),
            steps: 2,
            toolCalls: 1,
            workingMessages,
          };
        }
        expect(prompt).toContain(`Original intent: ${originalIntent}`);
        expect(prompt).toContain(`Continuation evidence: ${reconciliation}`);
        expect(prompt).toContain("Previous model-authored summary: The findings are saved, with one overlap still unresolved.");
        expect(retained).toEqual(workingMessages);
        await capabilities.people_read.run({});
        return {
          text: JSON.stringify({
            status: "complete",
            goalCategory: "prospect_research",
            summary: "The saved findings are verified and the full research request is complete.",
            evidence: ["saved-prospect-result"],
            evidenceCategories: ["prospect_saved"],
          }),
          steps: 2,
          toolCalls: 1,
        };
      },
    });

    const partial = JSON.parse(await dive({ intent: originalIntent })) as { jobId: string; status: string };
    const complete = JSON.parse(await dive({ intent: reconciliation })) as { jobId: string; status: string };

    expect(partial.status).toBe("partial");
    expect(complete).toMatchObject({ jobId: partial.jobId, status: "complete" });
    expect(store.load()).toMatchObject({
      id: partial.jobId,
      intent: originalIntent,
      status: "complete",
      continuations: [reconciliation],
      hostEvidenceCategories: ["prospect_saved"],
    });
    expect(save).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect(browse).not.toHaveBeenCalled();
  });

  it("does not let a superseded result overwrite the newer durable job", async () => {
    const store = createMemoryDiverJobStore();
    const newerJob = {
      version: 1 as const,
      id: "9e0d19e3-3149-4ba0-9bf1-f4db91f1d287",
      intent: "Newer research owns the lane.",
      status: "running" as const,
      createdAt: 20,
      updatedAt: 20,
      hostEvidenceCategories: [],
      continuations: [],
    };
    const trace = new Trace();
    const dive = createDiver({
      model: {} as never,
      trace,
      capabilities: {},
      store,
      runModel: async () => {
        store.save(newerJob);
        return {
          text: JSON.stringify({
            status: "complete",
            goalCategory: "current_event_export",
            summary: "The older export finished late.",
            evidence: ["artifact-old"],
            evidenceCategories: ["current_event_csv"],
          }),
          steps: 2,
          toolCalls: 1,
          hostEvidenceCategories: ["current_event_csv"],
        };
      },
    });

    const report = JSON.parse(await dive({ intent: "Older research." })) as {
      status: string;
      summary: string;
      hostEvidenceCategories?: string[];
    };

    expect(report).toMatchObject({
      status: "blocked",
      summary: expect.stringContaining("newer research job took ownership"),
      hostEvidenceCategories: [],
    });
    expect(store.load()).toEqual(newerJob);
    expect(trace.all().map((event) => event.label)).toContain("ignored superseded diver result");
  });

  it("does not return old host evidence when a failed report is superseded", async () => {
    const store = createMemoryDiverJobStore();
    const save = vi.fn(async () => "old job saved a list");
    const newerJob = {
      version: 1 as const,
      id: "9e0d19e3-3149-4ba0-9bf1-f4db91f1d287",
      intent: "Newer research owns the lane.",
      status: "running" as const,
      createdAt: 20,
      updatedAt: 20,
      hostEvidenceCategories: [],
      continuations: [],
    };
    const dive = createDiver({
      model: {} as never,
      trace: new Trace(),
      capabilities: {
        save: {
          description: "save",
          inputSchema: z.object({}),
          run: save,
          evidenceCategories: () => ["guestlist_saved"],
        },
      },
      store,
      runModel: async ({ capabilities }) => {
        await capabilities.save.run({});
        store.save(newerJob);
        throw new Error("old stream failed");
      },
    });

    const report = JSON.parse(await dive({ intent: "Older research." })) as {
      status: string;
      summary: string;
      hostEvidenceCategories?: string[];
    };

    expect(report).toMatchObject({
      status: "blocked",
      summary: expect.stringContaining("newer research job took ownership"),
      hostEvidenceCategories: [],
    });
    expect(save).toHaveBeenCalledOnce();
    expect(store.load()).toEqual(newerJob);
  });
});

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };
}
