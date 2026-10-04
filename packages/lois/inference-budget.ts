// lois-inference-budget — one fail-closed meter around every paid provider dispatch.
//
// This is deliberately run infrastructure, not Lois's mind. It records only
// accounting metadata: never prompts, replies, tool arguments, or secrets.

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";

export interface InferencePricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface InferenceLimits {
  callsPerTurn: number;
  callsPerRun: number;
  runUsd: number;
  dailyUsd: number;
}

export interface ModelUsage {
  inputTokens: { total?: number };
  outputTokens: { total?: number };
  raw?: unknown;
}

export interface InferenceCall {
  actor: string;
  turnId: string;
  purpose: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
}

export interface InferenceBudgetOptions {
  runId: string;
  model: string;
  ledgerPath: string;
  dailyLedgerPath: string;
  pricing: InferencePricing;
  limits: InferenceLimits;
  /** Keep a failed dispatch's reserved ceiling when provider billing is unknown. */
  retainFailedReservations?: boolean;
  now?: () => Date;
  idFactory?: () => string;
}

export interface InferenceReservation {
  readonly callId: string;
  complete(usage: ModelUsage, providerMetadata?: unknown): void;
  fail(error: unknown, reason?: string): void;
}

export interface InferenceBudgetSummary {
  admittedCalls: number;
  completedCalls: number;
  runUsd: number;
  reservedUsd: number;
  dailyUsd: number;
}

export interface InferenceBudget {
  reserve(call: InferenceCall): InferenceReservation;
  trackStream<T extends { type: string; usage?: ModelUsage }>(call: InferenceCall, stream: ReadableStream<T>): ReadableStream<T>;
  summary(): InferenceBudgetSummary;
}

export interface InferenceMiddlewareBinding {
  actor: string;
  purpose: string;
  turnId: () => string;
  /** Provider output ceiling reserved before every SDK dispatch. */
  defaultMaxOutputTokens: number;
}

interface ActiveReservation {
  call: InferenceCall;
  callId: string;
  reservedUsd: number;
  settled: boolean;
}

type LedgerState = "attempted" | "admitted" | "completed" | "failed" | "refused" | "deferred";

interface LedgerRow {
  schemaVersion: 1;
  at: string;
  date: string;
  runId: string;
  callId: string;
  state: LedgerState;
  model: string;
  actor: string;
  turnId: string;
  purpose: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  reservedUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  actualUsd?: number;
  providerCostUsd?: number;
  providerName?: string;
  usageBasis?: "provider_tokens" | "provider_cost" | "reserved_ceiling";
  billingStatus?: "unresolved";
  reason?: string;
  error?: string;
}

export class InferenceBudgetError extends Error {}

class InferenceLedgerBusyError extends InferenceBudgetError {}

const roundUsd = (value: number): number => Number(value.toFixed(12));

function assertPositiveWhole(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
}

function costOf(pricing: InferencePricing, inputTokens: number, outputTokens: number): number {
  return roundUsd((inputTokens * pricing.inputUsdPerMillion + outputTokens * pricing.outputUsdPerMillion) / 1_000_000);
}

function appendJsonl(path: string, row: LedgerRow): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
}

function withDailyLedgerLock<T>(path: string, task: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new InferenceLedgerBusyError(
        "Inference budget deferred: the shared daily ledger is busy or has a stale safety lock.",
      );
    }
    throw error;
  }
  try {
    return task();
  } finally {
    closeSync(descriptor);
    unlinkSync(lockPath);
  }
}

function readRows(path: string): LedgerRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LedgerRow];
      } catch {
        throw new Error(`Inference usage ledger is not valid JSONL: ${path}`);
      }
    });
}

function committedDailyUsd(path: string, date: string): number {
  const finalByCall = new Map<string, LedgerRow>();
  for (const row of readRows(path)) {
    if (row.date === date) finalByCall.set(`${row.runId}:${row.callId}`, row);
  }
  let total = 0;
  for (const row of finalByCall.values()) {
    if (row.state === "completed") total += row.actualUsd ?? 0;
    if (row.state === "admitted") total += row.reservedUsd ?? 0;
    if (row.state === "failed" && row.billingStatus === "unresolved") total += row.reservedUsd ?? 0;
  }
  return roundUsd(total);
}

function providerCost(providerMetadata: unknown): number | undefined {
  if (!providerMetadata || typeof providerMetadata !== "object") return undefined;
  const candidates: unknown[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || !value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (/^(cost|costUsd|totalCost|totalCostUsd)$/i.test(key)) candidates.push(nested);
      else visit(nested, depth + 1);
    }
  };
  visit(providerMetadata, 0);
  const found = candidates.find((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  return typeof found === "number" ? roundUsd(found) : undefined;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 240);
}

export function createInferenceBudget(options: InferenceBudgetOptions): InferenceBudget {
  const now = options.now ?? (() => new Date());
  const priorRows = readRows(options.ledgerPath).filter((row) => row.runId === options.runId);
  const knownCallIds = new Set(priorRows.map((row) => row.callId));
  let sequence = 0;
  const idFactory = options.idFactory ?? (() => {
    let candidate: string;
    do candidate = `${options.runId}-${++sequence}`;
    while (knownCallIds.has(candidate));
    return candidate;
  });
  const active = new Map<string, ActiveReservation>();
  const callsByTurn = new Map<string, number>();
  const admittedByCall = new Map<string, LedgerRow>();
  const finalByCall = new Map<string, LedgerRow>();
  for (const row of priorRows) {
    if (row.state === "admitted") admittedByCall.set(row.callId, row);
    finalByCall.set(row.callId, row);
  }
  for (const row of admittedByCall.values()) {
    callsByTurn.set(row.turnId, (callsByTurn.get(row.turnId) ?? 0) + 1);
  }
  let admittedCalls = admittedByCall.size;
  let completedCalls = 0;
  let actualRunUsd = 0;
  let reservedRunUsd = 0;
  for (const row of finalByCall.values()) {
    if (row.state === "completed") {
      completedCalls += 1;
      actualRunUsd += row.actualUsd ?? row.providerCostUsd ?? 0;
    }
    // A process that died after admission leaves a conservative reservation.
    // A failed dispatch can also retain its ceiling when provider billing is
    // unknown. Neither can be settled after restart, so both remain reserved.
    if (row.state === "admitted" || (row.state === "failed" && row.billingStatus === "unresolved")) {
      reservedRunUsd += row.reservedUsd ?? 0;
    }
  }
  actualRunUsd = roundUsd(actualRunUsd);
  reservedRunUsd = roundUsd(reservedRunUsd);

  const write = (row: LedgerRow): void => {
    appendJsonl(options.ledgerPath, row);
    if (options.dailyLedgerPath !== options.ledgerPath) appendJsonl(options.dailyLedgerPath, row);
  };

  const baseRow = (callId: string, call: InferenceCall, state: LedgerState): LedgerRow => {
    const at = now().toISOString();
    return {
      schemaVersion: 1,
      at,
      date: at.slice(0, 10),
      runId: options.runId,
      callId,
      state,
      model: options.model,
      actor: call.actor,
      turnId: call.turnId,
      purpose: call.purpose,
      estimatedInputTokens: call.estimatedInputTokens,
      maxOutputTokens: call.maxOutputTokens,
    };
  };

  const refuse = (reservation: ActiveReservation, reason: string, message: string): never => {
    write({ ...baseRow(reservation.callId, reservation.call, "refused"), reason });
    throw new InferenceBudgetError(message);
  };

  const reserve = (call: InferenceCall): InferenceReservation => {
    assertPositiveWhole("estimated input tokens", call.estimatedInputTokens);
    assertPositiveWhole("maximum output tokens", call.maxOutputTokens);
    if (!call.actor || !call.turnId || !call.purpose) throw new Error("Inference call identity is incomplete.");

    const callId = idFactory();
    if (knownCallIds.has(callId)) {
      throw new InferenceBudgetError(`Inference call id already exists in this run: ${callId}`);
    }
    knownCallIds.add(callId);
    const reservedUsd = costOf(options.pricing, call.estimatedInputTokens, call.maxOutputTokens);
    const reservation: ActiveReservation = { call, callId, reservedUsd, settled: false };
    write(baseRow(callId, call, "attempted"));

    if ((callsByTurn.get(call.turnId) ?? 0) >= options.limits.callsPerTurn) {
      return refuse(reservation, "calls_per_turn", "Inference budget refused: calls per turn limit reached.");
    }
    if (admittedCalls >= options.limits.callsPerRun) {
      return refuse(reservation, "calls_per_run", "Inference budget refused: calls per run limit reached.");
    }
    if (actualRunUsd + reservedRunUsd + reservedUsd > options.limits.runUsd) {
      return refuse(reservation, "run_usd", "Inference budget refused: run USD limit would be exceeded.");
    }
    try {
      withDailyLedgerLock(options.dailyLedgerPath, () => {
        const dailyCommittedUsd = committedDailyUsd(options.dailyLedgerPath, now().toISOString().slice(0, 10));
        if (dailyCommittedUsd + reservedUsd > options.limits.dailyUsd) {
          return refuse(reservation, "daily_usd", "Inference budget refused: daily USD limit would be exceeded.");
        }

        admittedCalls += 1;
        callsByTurn.set(call.turnId, (callsByTurn.get(call.turnId) ?? 0) + 1);
        reservedRunUsd = roundUsd(reservedRunUsd + reservedUsd);
        active.set(callId, reservation);
        write({ ...baseRow(callId, call, "admitted"), reservedUsd });
      });
    } catch (error) {
      if (error instanceof InferenceLedgerBusyError) {
        appendJsonl(options.ledgerPath, {
          ...baseRow(callId, call, "deferred"),
          reason: "daily_ledger_busy",
        });
      }
      throw error;
    }

    const settleFailure = (reason: string, error: unknown): void => {
      if (reservation.settled) return;
      reservation.settled = true;
      active.delete(callId);
      if (!options.retainFailedReservations) {
        reservedRunUsd = roundUsd(reservedRunUsd - reservedUsd);
      }
      write({
        ...baseRow(callId, call, "failed"),
        reservedUsd,
        ...(options.retainFailedReservations ? { billingStatus: "unresolved" as const } : {}),
        reason,
        error: errorText(error),
      });
    };

    return {
      callId,
      complete(usage, metadata) {
        if (reservation.settled) throw new Error(`Inference call ${callId} is already settled.`);
        const inputTokens = usage.inputTokens?.total;
        const outputTokens = usage.outputTokens?.total;
        const hasProviderTokens =
          Number.isInteger(inputTokens) &&
          (inputTokens ?? -1) >= 0 &&
          Number.isInteger(outputTokens) &&
          (outputTokens ?? -1) >= 0;
        reservation.settled = true;
        active.delete(callId);
        reservedRunUsd = roundUsd(reservedRunUsd - reservedUsd);
        const reportedProviderUsd = providerCost(metadata);
        const reportedProvider = (metadata as { openrouter?: { provider?: unknown } } | undefined)?.openrouter?.provider;
        // Provider tokens are the normal evidence. Some routed tool-call
        // responses omit them; a provider-reported cost remains exact enough,
        // and otherwise the pre-dispatch ceiling is the honest conservative
        // charge. Missing telemetry must not discard an otherwise valid reply.
        const calculatedUsd = hasProviderTokens
          ? costOf(options.pricing, inputTokens as number, outputTokens as number)
          : undefined;
        const actualUsd = roundUsd(
          hasProviderTokens
            ? Math.max(calculatedUsd ?? 0, reportedProviderUsd ?? 0)
            : (reportedProviderUsd ?? reservedUsd),
        );
        const usageBasis = hasProviderTokens
          ? "provider_tokens"
          : reportedProviderUsd !== undefined
            ? "provider_cost"
            : "reserved_ceiling";
        actualRunUsd = roundUsd(actualRunUsd + actualUsd);
        completedCalls += 1;
        write({
          ...baseRow(callId, call, "completed"),
          reservedUsd,
          ...(hasProviderTokens
            ? { inputTokens: inputTokens as number, outputTokens: outputTokens as number }
            : { reason: "missing_provider_usage" }),
          actualUsd,
          providerCostUsd: reportedProviderUsd,
          ...(typeof reportedProvider === 'string' && reportedProvider ? { providerName: reportedProvider } : {}),
          usageBasis,
        });
        const dailyUsd = committedDailyUsd(options.dailyLedgerPath, now().toISOString().slice(0, 10));
        if (actualRunUsd > options.limits.runUsd || dailyUsd > options.limits.dailyUsd) {
          throw new InferenceBudgetError("Provider usage exceeded a USD limit despite the pre-send reservation.");
        }
      },
      fail(error, reason = "provider_error") {
        settleFailure(reason, error);
      },
    };
  };

  const attachStream = <T extends { type: string; usage?: ModelUsage }>(
    reservation: InferenceReservation,
    stream: ReadableStream<T>,
  ): ReadableStream<T> => {
    const reader = stream.getReader();
    let finished = false;
    return new ReadableStream<T>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            if (!finished) {
              const error = new InferenceBudgetError("Provider stream closed without finish usage.");
              reservation.fail(error, "stream_without_finish");
              controller.error(error);
              return;
            }
            controller.close();
            return;
          }
          if (next.value.type === "finish") {
            try {
              reservation.complete(next.value.usage ?? { inputTokens: {}, outputTokens: {} });
              finished = true;
            } catch (error) {
              controller.error(error);
              return;
            }
          }
          controller.enqueue(next.value);
        } catch (error) {
          reservation.fail(error, "stream_error");
          controller.error(error);
        }
      },
      async cancel(reason) {
        reservation.fail(reason, "stream_cancelled");
        await reader.cancel(reason);
      },
    });
  };

  return {
    reserve,
    trackStream(call, stream) {
      return attachStream(reserve(call), stream);
    },
    summary: () => {
      const dailyUsd = committedDailyUsd(options.dailyLedgerPath, now().toISOString().slice(0, 10));
      return {
        admittedCalls,
        completedCalls,
        runUsd: roundUsd(actualRunUsd),
        reservedUsd: roundUsd(reservedRunUsd),
        dailyUsd,
      };
    },
  };
}

function estimateInputTokens(params: {
  prompt?: unknown;
  tools?: unknown;
  responseFormat?: unknown;
  providerOptions?: unknown;
}): number {
  let serialized = "";
  try {
    serialized = JSON.stringify({
      prompt: params.prompt ?? "",
      tools: params.tools,
      responseFormat: params.responseFormat,
      providerOptions: params.providerOptions,
    });
  } catch {
    serialized = "";
  }
  // UTF-8 bytes are a deliberately conservative token ceiling for the text
  // and schemas we send. We reserve this larger number, never a chars/4
  // average, because the reservation is a safety rail rather than an estimate
  // shown as provider truth.
  return Math.max(1, Buffer.byteLength(serialized, "utf8"));
}

/** AI SDK middleware: one reservation for every underlying doGenerate/doStream dispatch. */
export function inferenceBudgetMiddleware(
  budget: InferenceBudget,
  binding: InferenceMiddlewareBinding,
): LanguageModelMiddleware {
  const callFor = (params: { prompt?: unknown; maxOutputTokens?: number }): InferenceCall => ({
    actor: binding.actor,
    turnId: binding.turnId(),
    purpose: binding.purpose,
    estimatedInputTokens: estimateInputTokens(params),
    maxOutputTokens: params.maxOutputTokens ?? binding.defaultMaxOutputTokens,
  });

  return {
    specificationVersion: "v4",
    async transformParams({ params }) {
      return {
        ...params,
        maxOutputTokens: Math.min(params.maxOutputTokens ?? binding.defaultMaxOutputTokens, binding.defaultMaxOutputTokens),
      };
    },
    async wrapGenerate({ doGenerate, params }) {
      const reservation = budget.reserve(callFor(params));
      try {
        const result = await doGenerate();
        reservation.complete(result.usage, result.providerMetadata);
        return result;
      } catch (error) {
        reservation.fail(error);
        throw error;
      }
    },
    async wrapStream({ doStream, params }) {
      const call = callFor(params);
      const reservation = budget.reserve(call);
      try {
        const result = await doStream();
        const reader = result.stream.getReader();
        let finished = false;
        const stream = new ReadableStream({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {
                if (!finished) {
                  const error = new InferenceBudgetError("Provider stream closed without finish usage.");
                  reservation.fail(error, "stream_without_finish");
                  controller.error(error);
                  return;
                }
                controller.close();
                return;
              }
              if (next.value.type === "finish") {
                try {
                  reservation.complete(next.value.usage, next.value.providerMetadata);
                  finished = true;
                } catch (error) {
                  controller.error(error);
                  return;
                }
              }
              controller.enqueue(next.value);
            } catch (error) {
              reservation.fail(error, "stream_error");
              controller.error(error);
            }
          },
          async cancel(reason) {
            reservation.fail(reason, "stream_cancelled");
            await reader.cancel(reason);
          },
        });
        return { ...result, stream };
      } catch (error) {
        reservation.fail(error);
        throw error;
      }
    },
  };
}

/** Bind one actor identity to a shared budget without exposing the raw provider path. */
export function budgetedLanguageModel(
  model: LanguageModel,
  budget: InferenceBudget,
  binding: InferenceMiddlewareBinding,
): LanguageModel {
  if (typeof model === "string") {
    throw new Error("A budgeted model must be a resolved AI SDK provider model, not a registry id.");
  }
  return wrapLanguageModel({
    model,
    middleware: inferenceBudgetMiddleware(budget, binding),
  });
}
