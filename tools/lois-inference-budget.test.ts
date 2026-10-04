import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createInferenceBudget,
  inferenceBudgetMiddleware,
  type ModelUsage,
} from "../packages/lois/inference-budget.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(overrides: Partial<Parameters<typeof createInferenceBudget>[0]> = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "lois-budget-test-"));
  roots.push(root);
  let sequence = 0;
  const budget = createInferenceBudget({
    runId: "run-1",
    model: "test/model",
    ledgerPath: resolve(root, "model-usage.jsonl"),
    dailyLedgerPath: resolve(root, "daily-model-usage.jsonl"),
    pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
    limits: { callsPerTurn: 3, callsPerRun: 24, runUsd: 0.1, dailyUsd: 1 },
    now: () => new Date("2026-08-29T12:00:00.000Z"),
    idFactory: () => `call-${++sequence}`,
    ...overrides,
  });
  return { budget, root };
}

function usage(inputTokens = 100, outputTokens = 50): ModelUsage {
  return {
    inputTokens: { total: inputTokens },
    outputTokens: { total: outputTokens },
  };
}

function rows(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const seen: T[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) return seen;
    seen.push(next.value);
  }
}

describe("shared inference budget", () => {
  it("records attempted, admitted, and completed provider dispatches without prompt content", () => {
    const { budget, root } = harness();
    const call = budget.reserve({
      actor: "lois",
      turnId: "turn-1",
      purpose: "organizer reply",
      estimatedInputTokens: 100,
      maxOutputTokens: 50,
    });
    call.complete(usage());

    expect(budget.summary()).toMatchObject({ admittedCalls: 1, completedCalls: 1, runUsd: 0.0002 });
    expect(rows(resolve(root, "model-usage.jsonl"))).toEqual([
      expect.objectContaining({ callId: "call-1", state: "attempted", actor: "lois", turnId: "turn-1" }),
      expect.objectContaining({ callId: "call-1", state: "admitted", reservedUsd: 0.0002 }),
      expect.objectContaining({ callId: "call-1", state: "completed", inputTokens: 100, outputTokens: 50, actualUsd: 0.0002 }),
    ]);
    expect(readFileSync(resolve(root, "model-usage.jsonl"), "utf8")).not.toContain("organizer reply text");
  });

  it("refuses the fourth provider dispatch in one turn across different actors", () => {
    const { budget, root } = harness();
    for (const actor of ["lois", "critic", "goldfish"]) {
      budget
        .reserve({ actor, turnId: "turn-1", purpose: "test", estimatedInputTokens: 1, maxOutputTokens: 1 })
        .complete(usage(1, 1));
    }

    expect(() =>
      budget.reserve({ actor: "goldfish", turnId: "turn-1", purpose: "fourth", estimatedInputTokens: 1, maxOutputTokens: 1 }),
    ).toThrow(/calls per turn/i);
    expect(rows(resolve(root, "model-usage.jsonl")).at(-1)).toMatchObject({ state: "refused", reason: "calls_per_turn" });
  });

  it("refuses the twenty-fifth provider dispatch in a run", () => {
    const { budget } = harness({
      limits: { callsPerTurn: 30, callsPerRun: 24, runUsd: 1, dailyUsd: 2 },
    });
    for (let i = 0; i < 24; i += 1) {
      budget
        .reserve({ actor: "lois", turnId: "turn-1", purpose: "test", estimatedInputTokens: 1, maxOutputTokens: 1 })
        .complete(usage(1, 1));
    }
    expect(() =>
      budget.reserve({ actor: "lois", turnId: "turn-2", purpose: "overflow", estimatedInputTokens: 1, maxOutputTokens: 1 }),
    ).toThrow(/calls per run/i);
  });

  it("reserves worst-case cost before send and refuses a run-cap overflow", () => {
    const { budget } = harness();
    expect(() =>
      budget.reserve({
        actor: "lois",
        turnId: "turn-1",
        purpose: "too expensive",
        estimatedInputTokens: 1,
        maxOutputTokens: 50_000,
      }),
    ).toThrow(/run usd/i);
    expect(budget.summary()).toMatchObject({ admittedCalls: 0, runUsd: 0 });
  });

  it("keeps the reply and charges the reserved ceiling when provider usage is missing", () => {
    const { budget, root } = harness();
    const call = budget.reserve({
      actor: "critic",
      turnId: "turn-1",
      purpose: "voice review",
      estimatedInputTokens: 100,
      maxOutputTokens: 50,
    });
    expect(() => call.complete({ inputTokens: {}, outputTokens: {} })).not.toThrow();
    expect(budget.summary()).toMatchObject({ admittedCalls: 1, completedCalls: 1, runUsd: 0.0002, reservedUsd: 0 });
    expect(rows(resolve(root, "model-usage.jsonl")).at(-1)).toMatchObject({
      state: "completed",
      reason: "missing_provider_usage",
      usageBasis: "reserved_ceiling",
      actualUsd: 0.0002,
    });
  });

  it("uses provider cost when it is the only returned usage evidence", () => {
    const { budget, root } = harness();
    budget
      .reserve({ actor: "lois", turnId: "turn-1", purpose: "tool round", estimatedInputTokens: 100, maxOutputTokens: 50 })
      .complete({ inputTokens: {}, outputTokens: {} }, { openrouter: { cost: 0.00004 } });

    expect(budget.summary().runUsd).toBe(0.00004);
    expect(rows(resolve(root, "model-usage.jsonl")).at(-1)).toMatchObject({
      state: "completed",
      reason: "missing_provider_usage",
      usageBasis: "provider_cost",
      actualUsd: 0.00004,
      providerCostUsd: 0.00004,
    });
  });

  it("captures a streaming finish and fails a stream that closes without usage", async () => {
    const { budget, root } = harness();
    const good = budget.trackStream(
      { actor: "lois", turnId: "turn-1", purpose: "reply", estimatedInputTokens: 100, maxOutputTokens: 50 },
      new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-delta", id: "text", delta: "hello" });
          controller.enqueue({ type: "finish", usage: usage(), finishReason: { unified: "stop", raw: "stop" } });
          controller.close();
        },
      }),
    );
    await drain(good);

    const broken = budget.trackStream(
      { actor: "lois", turnId: "turn-2", purpose: "reply", estimatedInputTokens: 100, maxOutputTokens: 50 },
      new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-delta", id: "text", delta: "unfinished" });
          controller.close();
        },
      }),
    );
    await expect(drain(broken)).rejects.toThrow(/finish usage/i);
    expect(rows(resolve(root, "model-usage.jsonl")).at(-1)).toMatchObject({ state: "failed", reason: "stream_without_finish" });
  });

  it("counts completed usage from the shared daily ledger before admitting a new run", () => {
    const first = harness({
      limits: { callsPerTurn: 3, callsPerRun: 24, runUsd: 2, dailyUsd: 2 },
    });
    first.budget
      .reserve({ actor: "lois", turnId: "turn-1", purpose: "prior", estimatedInputTokens: 100, maxOutputTokens: 50 })
      .complete(usage(600_000, 200_000));

    const second = createInferenceBudget({
      runId: "run-2",
      model: "test/model",
      ledgerPath: resolve(first.root, "run-2.jsonl"),
      dailyLedgerPath: resolve(first.root, "daily-model-usage.jsonl"),
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      limits: { callsPerTurn: 3, callsPerRun: 24, runUsd: 1, dailyUsd: 1 },
      now: () => new Date("2026-08-29T13:00:00.000Z"),
      idFactory: () => "run-2-call-1",
    });
    expect(() =>
      second.reserve({ actor: "lois", turnId: "turn-1", purpose: "overflow", estimatedInputTokens: 1, maxOutputTokens: 1 }),
    ).toThrow(/daily usd/i);
  });

  it("fails closed when another process holds the shared daily admission lock", () => {
    const { budget, root } = harness();
    writeFileSync(resolve(root, "daily-model-usage.jsonl.lock"), "held\n", "utf8");

    expect(() =>
      budget.reserve({ actor: "lois", turnId: "turn-1", purpose: "contended", estimatedInputTokens: 1, maxOutputTokens: 1 }),
    ).toThrow(/daily ledger is busy/i);
    expect(rows(resolve(root, "model-usage.jsonl")).at(-1)).toMatchObject({
      state: "deferred",
      reason: "daily_ledger_busy",
    });
    expect(rows(resolve(root, "daily-model-usage.jsonl")).some((row) => row.state === "admitted")).toBe(false);
  });

  it("restores the run counter and spend from its ledger after a process restart", () => {
    const first = harness({
      limits: { callsPerTurn: 3, callsPerRun: 1, runUsd: 0.0003, dailyUsd: 1 },
    });
    first.budget
      .reserve({ actor: "lois", turnId: "turn-1", purpose: "prior", estimatedInputTokens: 100, maxOutputTokens: 50 })
      .complete(usage());

    const restarted = createInferenceBudget({
      runId: "run-1",
      model: "test/model",
      ledgerPath: resolve(first.root, "model-usage.jsonl"),
      dailyLedgerPath: resolve(first.root, "daily-model-usage.jsonl"),
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      limits: { callsPerTurn: 3, callsPerRun: 1, runUsd: 0.0003, dailyUsd: 1 },
      now: () => new Date("2026-08-29T13:00:00.000Z"),
      idFactory: () => "call-after-restart",
    });

    expect(restarted.summary()).toMatchObject({ admittedCalls: 1, completedCalls: 1, runUsd: 0.0002 });
    expect(() =>
      restarted.reserve({ actor: "critic", turnId: "turn-2", purpose: "overflow", estimatedInputTokens: 1, maxOutputTokens: 1 }),
    ).toThrow(/calls per run/i);
  });

  it("uses a higher provider-reported charge as the actual spend", () => {
    const { budget, root } = harness();
    budget
      .reserve({ actor: "lois", turnId: "turn-1", purpose: "routed", estimatedInputTokens: 1, maxOutputTokens: 1 })
      .complete(usage(1, 1), { openrouter: { cost: 0.08 } });

    expect(budget.summary().runUsd).toBe(0.08);
    expect(rows(resolve(root, "model-usage.jsonl")).at(-1)).toMatchObject({
      state: "completed",
      actualUsd: 0.08,
      providerCostUsd: 0.08,
    });
  });

  it("caps SDK output before dispatch and meters the transformed provider call", async () => {
    const { budget, root } = harness();
    const middleware = inferenceBudgetMiddleware(budget, {
      actor: "lois",
      purpose: "organizer reply",
      turnId: () => "turn-1",
      defaultMaxOutputTokens: 500,
    });
    const transformed = await middleware.transformParams!({
      type: "generate",
      params: { prompt: [], maxOutputTokens: 5_000 } as never,
      model: {} as never,
    });
    expect(transformed.maxOutputTokens).toBe(500);

    const generate = middleware.wrapGenerate!;
    await generate({
      doGenerate: async () =>
        ({
          content: [],
          finishReason: { unified: "stop", raw: "stop" },
          usage: usage(10, 5),
          warnings: [],
        }) as never,
      doStream: async () => {
        throw new Error("not used");
      },
      params: transformed,
      model: {} as never,
    });

    expect(rows(resolve(root, "model-usage.jsonl"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "admitted", actor: "lois", turnId: "turn-1", maxOutputTokens: 500 }),
        expect.objectContaining({ state: "completed", inputTokens: 10, outputTokens: 5 }),
      ]),
    );
  });
});
