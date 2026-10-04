// lois/diver — one research door, one isolated working context (D-117/D-128).
//
// The mouth states an intent. The diver gets the capability library and its
// own model runway; raw browser material never joins the mouth's warm thread.
// This is deliberately a session boundary, not a fake in-process REPL. The
// eventual isolated TypeScript runtime can replace the model runner without
// changing the mouth door or the host-owned capabilities.

import { randomUUID } from "node:crypto";
import { hasToolCall, modelMessageSchema, stepCountIs, streamText, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { parseJsonLoose, type LoisModel } from "./model.js";
import { digest, type Trace } from "./trace.js";
import { retainDiverMessages } from "./diver-context.js";

export interface DiverCapability {
  description: string;
  inputSchema: z.ZodType<unknown>;
  traceInput?: (input: unknown) => Record<string, unknown>;
  run: (input: unknown) => Promise<string>;
  /** Host-derived semantic evidence emitted only after this capability succeeds. */
  evidenceCategories?: (input: unknown, output: string) => readonly string[];
  /** Successful state changes can make an earlier completion receipt stale. */
  invalidatesEvidenceCategories?: (input: unknown, output: string) => readonly string[];
}

export type DiverCapabilities = Record<string, DiverCapability>;

export const DiveIntentSchema = z
  .object({ intent: z.string().trim().min(1).max(4_000) })
  .strict();

export type DiveIntent = z.infer<typeof DiveIntentSchema>;

// Reporting is not an authority boundary. Keep its shape deliberately flat so
// a provider cannot lose completed research to union/strict-schema ceremony.
// Capability calls in the host trace are the proof that work happened; these
// strings are compact pointers that help the mouth explain that work.
const KnownGoalCategorySchema = z.enum([
  "guestlist_import",
  "prospect_research",
  "series_history",
  "current_event_export",
  "human_boundary",
  "browser_reclaim",
  "final_speech",
  "live_readonly_canary",
]);

const KnownEvidenceCategorySchema = z.enum([
  "guestlist_saved",
  "prospect_saved",
  "current_event_csv",
  "series_attendance_index",
  "browser_frame",
  "browser_lease_event",
  "artifact_index_entry",
  "progress_snapshot",
  "final_turn",
]);

const DiverModelReportSchema = z.object({
  status: z.enum(["complete", "partial", "awaiting_human", "blocked"]),
  // Strings keep the report open-set. The host recognizes the laws it knows;
  // unfamiliar categories remain usable model context but cannot self-certify.
  goalCategory: z.string().trim().min(1).max(100),
  summary: z.string().trim().min(1).max(4_000),
  next: z.string().trim().min(1).max(1_000).optional(),
  evidence: z.array(z.string().trim().min(1).max(500)).max(12).default([]),
  evidenceCategories: z.array(z.string().trim().min(1).max(100)).max(12),
});

export type DiverStatus = z.infer<typeof DiverModelReportSchema>["status"];

const DiverJobSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    intent: z.string().min(1).max(4_000),
    status: z.enum(["running", "complete", "partial", "awaiting_human", "blocked"]),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    summary: z.string().max(4_000).optional(),
    next: z.string().max(1_000).optional(),
    hostEvidenceCategories: z.array(z.string().trim().min(1).max(100)).max(24).default([]),
    continuations: z.array(z.string().min(1).max(4_000)).max(8).default([]),
    // Private to this research job; never part of mouth/UI status projections.
    workingMessages: z.array(modelMessageSchema).optional(),
    progress: z.object({
      completedCalls: z.number().int().nonnegative(),
      lastTool: z.string(),
      traceSeq: z.number().int().nonnegative(),
      at: z.number().int().nonnegative(),
    }).optional(),
  })
  .strict();

export type DiverJob = z.infer<typeof DiverJobSchema>;

export function publicDiverJob(job: DiverJob): Omit<DiverJob, "workingMessages"> {
  const { workingMessages: _workingMessages, ...status } = job;
  return status;
}

export interface DiverJobStore {
  load(): DiverJob | null;
  save(job: DiverJob): void;
}

export function parseDiverJob(value: unknown): DiverJob | null {
  const parsed = DiverJobSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function createMemoryDiverJobStore(initial?: DiverJob): DiverJobStore {
  let current = initial ? structuredClone(initial) : null;
  return {
    load: () => (current ? structuredClone(current) : null),
    save: (job) => {
      current = structuredClone(job);
    },
  };
}

export interface DiverModelRunInput {
  model: LoisModel;
  system: string;
  prompt: string;
  capabilities: DiverCapabilities;
  maxSteps: number;
  signal?: AbortSignal;
  onProgress?: () => void;
  readHostEvidenceCategories?: () => readonly string[];
  workingMessages?: ModelMessage[];
}

export interface DiverModelRunResult {
  text: string;
  steps: number;
  toolCalls: number;
  report?: unknown;
  /** Trusted adapter evidence for tests/custom runners; never parsed from model text. */
  hostEvidenceCategories?: string[];
  workingMessages?: ModelMessage[];
}

export type DiverModelRun = (input: DiverModelRunInput) => Promise<DiverModelRunResult>;

export interface CreateDiverOptions {
  model: LoisModel | null;
  trace: Trace;
  capabilities: DiverCapabilities;
  store: DiverJobStore;
  maxSteps?: number;
  signal?: AbortSignal;
  runModel?: DiverModelRun;
  now?: () => number;
}

const DIVER_SYSTEM = [
  "You are Lois's diver: a separate research worker, not her foreground voice.",
  "Complete the organizer's intent by composing only the capabilities supplied to you.",
  "Observe before acting, and re-observe after the organizer's hands may have changed the page.",
  "Prior tool exchanges are working memory, not fresh browser state. Reuse captured artifacts and saved findings;",
  "observe again before using an old page action ref. A prior report ended one invocation, not necessarily the job.",
  "The browser and its captured artifacts are yours to operate. Do not ask the organizer to find,",
  "rename, upload, or paste an artifact your browser can capture and read itself.",
  "Follow observed navigation refs; do not invent URLs. Do not restart a healthy, observable browser.",
  "When a requested detail is absent and no visible navigation leads to it, report what the source",
  "contains and what is absent instead of probing imagined routes.",
  "browser_start already returns its opening semantic observation. For a read-only page question,",
  "report immediately when that observation answers the intent. Capture or page through artifacts only when",
  "the intent needs a durable file, full-page material omitted from observation, or synthesis across sources.",
  "Use small artifact pages first and continue only when the task needs more. Do not slurp by ritual.",
  "When the outcome is a saved historical guestlist, use people_select_sources and people_import_csv.",
  "For observed prospects from LinkedIn, mail or another source, use people_save_prospect in the existing People view.",
  "Save useful findings incrementally with observed evidence and a separately inferred reason; a terminal summary alone does not save people.",
  "Use people_read with includeEvidence to inspect saved prospect reasons as well as historical memberships. One saved prospect does not establish that research is complete.",
  "If no usable World ID is in your context, read worlds, then use remember_world only when needed.",
  "Read the CSV header/sample, map its columns once, and let the import hand read all rows directly.",
  "The source account and event IDs come from observed evidence. Preserve actual selected-source scope,",
  "not a count of downloads. List membership and RSVP do not establish attendance or anchor verification.",
  "Identity assessment is part of combining lists. Use the source's description of its identifiers,",
  "not just column names: a source-backed guest registration address can support an identity judgment",
  "without asking the organizer to verify it again. Record that judgment through the import's identity",
  "field when supported; retain missing or conflicting identities rather than merging by name.",
  "Use people_read with includeEvidence on small pages to inspect saved anchors and source-row provenance.",
  "You can refine a provisional import through people_import_csv with a supported identity judgment;",
  "existing source rows, organizer ranks and notes are preserved. Source coverage proves rows were saved, not that identity assessment is finished.",
  "For this outcome report guestlist_import with guestlist_saved only after the host returns saved coverage.",
  "If a sign-in, consent, challenge, or native picker genuinely needs human hands, summon the browser,",
  "then report awaiting_human with one concrete next action. Do not spin or pretend the action happened.",
  "Never send invitations, publish, delete, or cross an approval boundary. A capability's refusal is",
  "evidence about the current state; inspect and adapt instead of inventing success.",
  "Finish by calling report exactly once. Call it only after capability evidence supports the status.",
  "When a capability answers the intent, call report on your very next step instead of emitting prose alone.",
  "The report summary must carry the exact observed values the intent requested, not only field labels.",
  "Complete means the entire intent is done and therefore has no next action. Human waits require one",
  "concrete next action. Partial means useful evidence exists but the whole intent is not done.",
  "Choose the closest semantic goalCategory and evidenceCategories; unfamiliar future categories are allowed",
  "but cannot certify completion on their own. Evidence is a short list of exact observation or artifact refs.",
  "Never invent a ref. A completion category counts only when a host capability also recorded it. Semantic",
  "browser observations record browser_frame automatically. Use the evidence-recording capability only after",
  "you have actually read and synthesized its owned source artifacts.",
].join("\n");

const completionEvidenceByGoal: Record<
  z.infer<typeof KnownGoalCategorySchema>,
  readonly z.infer<typeof KnownEvidenceCategorySchema>[]
> = {
  guestlist_import: ["guestlist_saved"],
  prospect_research: ["prospect_saved"],
  series_history: ["series_attendance_index"],
  current_event_export: ["current_event_csv"],
  human_boundary: ["browser_lease_event"],
  browser_reclaim: ["browser_lease_event"],
  final_speech: ["final_turn"],
  live_readonly_canary: ["browser_frame"],
};

type CompletionCheck = {
  status: "downgraded";
  reason: "unknown_goal" | "missing_required_evidence";
  goalCategory: string;
  requiredEvidenceCategories: string[];
  missingModelEvidenceCategories: string[];
  missingHostEvidenceCategories: string[];
};

function completionDowngradeCheck(
  report: z.infer<typeof DiverModelReportSchema>,
  hostEvidenceCategories: readonly string[],
): CompletionCheck | null {
  if (report.status !== "complete") return null;
  const goal = KnownGoalCategorySchema.safeParse(report.goalCategory);
  if (!goal.success) {
    return {
      status: "downgraded",
      reason: "unknown_goal",
      goalCategory: report.goalCategory,
      requiredEvidenceCategories: [],
      missingModelEvidenceCategories: [],
      missingHostEvidenceCategories: [],
    };
  }
  const modelEvidence = new Set(
    report.evidenceCategories.flatMap((category) => {
      const parsed = KnownEvidenceCategorySchema.safeParse(category);
      return parsed.success ? [parsed.data] : [];
    }),
  );
  const hostEvidence = new Set(
    hostEvidenceCategories.flatMap((category) => {
      const parsed = KnownEvidenceCategorySchema.safeParse(category);
      return parsed.success ? [parsed.data] : [];
    }),
  );
  const requirements = completionEvidenceByGoal[goal.data];
  const hasPrimaryEvidence = requirements.some((category) =>
    modelEvidence.has(category) && hostEvidence.has(category),
  );
  if (hasPrimaryEvidence) return null;
  return {
    status: "downgraded",
    reason: "missing_required_evidence",
    goalCategory: goal.data,
    requiredEvidenceCategories: [...requirements],
    missingModelEvidenceCategories: requirements.filter((category) => !modelEvidence.has(category)),
    missingHostEvidenceCategories: requirements.filter((category) => !hostEvidence.has(category)),
  };
}

function adjudicateCompletion(
  report: z.infer<typeof DiverModelReportSchema>,
  hostEvidenceCategories: readonly string[],
): z.infer<typeof DiverModelReportSchema> {
  return completionDowngradeCheck(report, hostEvidenceCategories) ? { ...report, status: "partial" } : report;
}

function finalStepReports(maxSteps: number) {
  return ({ stepNumber }: { stepNumber: number }) =>
    stepNumber === maxSteps - 1
      ? {
          activeTools: ["report"] as const,
          toolChoice: { type: "tool" as const, toolName: "report" as const },
        }
      : {};
}

function currentHostEvidenceCategories(read?: () => readonly string[]): string[] {
  return [...new Set(read?.() ?? [])].slice(-24);
}

function hostEvidenceInstructions(categories: readonly string[]): string {
  return [
    `Host evidence categories currently recorded by capability returns: ${categories.length > 0 ? categories.join(", ") : "none"}.`,
    "Host evidence categories are trusted receipts from successful capability returns. Model evidenceCategories are only claims.",
    "Host evidence categories do not establish precise counts, values, or scope by themselves; use the actual capability results for those details.",
    "When reporting, keep your summary factual and choose status from the host evidence actually listed here.",
  ].join(" ");
}

function instructionsWithHostEvidence(
  baseInstructions: string,
  readHostEvidenceCategories?: () => readonly string[],
): string {
  return `${baseInstructions}\n\n${hostEvidenceInstructions(currentHostEvidenceCategories(readHostEvidenceCategories))}`;
}

function prepareDiverStep(maxSteps: number, baseInstructions: string, readHostEvidenceCategories?: () => readonly string[]) {
  return ({ stepNumber }: { stepNumber: number }) => ({
    instructions: instructionsWithHostEvidence(baseInstructions, readHostEvidenceCategories),
    ...finalStepReports(maxSteps)({ stepNumber }),
  });
}

function preserveNarrative(
  report: z.infer<typeof DiverModelReportSchema>,
  narrative: string,
): z.infer<typeof DiverModelReportSchema> {
  const useful = narrative.trim();
  if (!useful) return report;
  return {
    ...report,
    summary: `${useful}\n\n${report.summary}`.slice(0, 4_000),
  };
}

function isMeaningfulStreamChunk(chunk: { type: string; text?: string; delta?: string }): boolean {
  if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") return Boolean(chunk.text?.trim());
  if (chunk.type === "tool-input-delta") return Boolean(chunk.delta?.trim());
  return chunk.type === "tool-call" || chunk.type === "tool-result" || chunk.type === "tool-error";
}

function renewOnMeaningfulStreamChunk(onProgress?: () => void) {
  return ({ chunk }: { chunk: { type: string; text?: string; delta?: string } }) => {
    if (isMeaningfulStreamChunk(chunk)) onProgress?.();
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  signal.throwIfAborted();
}

function streamFailureTracker(signal?: AbortSignal): {
  onError: ({ error }: { error: unknown }) => void;
  rethrow: () => void;
} {
  let streamError: unknown;
  return {
    onError: ({ error }) => {
      streamError ??= error;
    },
    rethrow: () => {
      throwIfAborted(signal);
      if (streamError) throw streamError;
    },
  };
}

async function defaultRunDiverModel(input: DiverModelRunInput): Promise<DiverModelRunResult> {
  const messages: ModelMessage[] = [...(input.workingMessages ?? []), { role: "user", content: input.prompt }];
  let terminalReport: z.infer<typeof DiverModelReportSchema> | undefined;
  const capabilityTools = Object.fromEntries(
    Object.entries(input.capabilities).map(([name, capability]) => [
      name,
      tool({
        description: capability.description,
        inputSchema: capability.inputSchema,
        execute: capability.run,
      }),
    ]),
  );
  const tools = {
    ...capabilityTools,
    report: tool({
      description: "Record the diver's typed terminal report and end this research session.",
      inputSchema: DiverModelReportSchema,
      execute: async (report) => {
        terminalReport = report;
        return "Terminal report recorded.";
      },
    }),
  };
  const failure = streamFailureTracker(input.signal);
  const result = streamText({
    model: input.model.model,
    system: input.system,
    messages,
    tools,
    stopWhen: [hasToolCall("report"), stepCountIs(input.maxSteps)],
    prepareStep: prepareDiverStep(input.maxSteps, input.system, input.readHostEvidenceCategories),
    abortSignal: input.signal,
    onChunk: renewOnMeaningfulStreamChunk(input.onProgress),
    onError: failure.onError,
    onStepEnd: input.onProgress,
    onToolExecutionEnd: input.onProgress,
  });
  const [text, steps, toolCalls, responseMessages] = await Promise.all([
    result.text,
    result.steps,
    result.toolCalls,
    result.responseMessages,
  ]);
  failure.rethrow();
  let reportSteps = 0;
  let reportToolCalls = 0;
  let reportText = "";
  const narrative = text.trim();
  if (!terminalReport && narrative) {
    const directReport = DiverModelReportSchema.safeParse(parseJsonLoose(narrative));
    if (directReport.success) terminalReport = directReport.data;
  }
  let forcedReport = false;
  let terminalMessages: ModelMessage[] = [];
  if (!terminalReport && !input.signal?.aborted) {
    forcedReport = true;
    input.onProgress?.();
    const terminalFailure = streamFailureTracker(input.signal);
    const terminal = streamText({
      model: input.model.model,
      system: input.system,
      messages: [
        ...messages,
        ...responseMessages,
        {
          role: "user",
          content: "Exploration has ended. Call report now, using only the capability results above. Do not add new facts.",
        },
      ],
      tools,
      activeTools: ["report"],
      toolChoice: { type: "tool", toolName: "report" },
      stopWhen: [hasToolCall("report"), stepCountIs(1)],
      prepareStep: prepareDiverStep(1, input.system, input.readHostEvidenceCategories),
      abortSignal: input.signal,
      onChunk: renewOnMeaningfulStreamChunk(input.onProgress),
      onError: terminalFailure.onError,
      onStepEnd: input.onProgress,
      onToolExecutionEnd: input.onProgress,
    });
    const [terminalText, terminalSteps, terminalToolCalls, terminalResponses] = await Promise.all([
      terminal.text,
      terminal.steps,
      terminal.toolCalls,
      terminal.responseMessages,
    ]);
    terminalFailure.rethrow();
    reportSteps = terminalSteps.length;
    reportToolCalls = terminalToolCalls.filter((call) => call.toolName !== "report").length;
    reportText = terminalText;
    terminalMessages = terminalResponses;
  }
  if (terminalReport && forcedReport) terminalReport = preserveNarrative(terminalReport, narrative);
  return {
    text: text || reportText,
    steps: steps.length + reportSteps,
    toolCalls:
      toolCalls.filter((call) => call.toolName !== "report").length + reportToolCalls,
    report: terminalReport,
    workingMessages: retainDiverMessages([...messages, ...responseMessages, ...terminalMessages]),
  };
}

function tracedCapabilities(
  trace: Trace,
  capabilities: DiverCapabilities,
  onProgress?: () => void,
  onEvidence?: (categories: readonly string[]) => void,
  onInvalidatedEvidence?: (categories: readonly string[]) => void,
  onCompleted?: (tool: string, traceSeq: number) => void,
  beforeCall?: () => void,
): DiverCapabilities {
  return Object.fromEntries(
    Object.entries(capabilities).map(([name, capability]) => [
      name,
      {
        ...capability,
        run: async (input: unknown) => {
          beforeCall?.();
          onProgress?.();
          const call = trace.append({
            actor: "diver",
            kind: "tool.call",
            label: name,
            detail: { tool: name, ...(capability.traceInput?.(input) ?? {}) },
          });
          try {
            const output = await capability.run(input);
            const returned = trace.append({
              actor: "diver",
              kind: "tool.return",
              label: `${name} returned ${output.length} character(s)`,
              detail: { tool: name, chars: output.length, outputDigest: digest(output) },
              refs: [call.seq],
            });
            onInvalidatedEvidence?.(capability.invalidatesEvidenceCategories?.(input, output) ?? []);
            onEvidence?.(capability.evidenceCategories?.(input, output) ?? []);
            onCompleted?.(name, returned.seq);
            return output;
          } finally {
            onProgress?.();
          }
        },
      },
    ]),
  );
}

function promptFor(
  job: DiverJob,
  continuation: string | null,
  hostEvidenceCategories: readonly string[] = [],
  previousHostStatus: DiverJob["status"] | null = null,
): string {
  return [
    `Job id: ${job.id}`,
    `Original intent: ${job.intent}`,
    ...(previousHostStatus ? [`Previous host-adjudicated status: ${previousHostStatus}`] : []),
    ...(job.summary ? [`Previous model-authored summary: ${job.summary}`] : []),
    ...(job.next ? [`Previous suggested next action (not yet executed): ${job.next}`] : []),
    `Host evidence categories currently recorded: ${hostEvidenceCategories.length > 0 ? hostEvidenceCategories.join(", ") : "none"}.`,
    ...(continuation ? [`Continuation evidence: ${continuation}`] : []),
    "Work from current capability truth. Finish the job or report the one real handoff/blocker.",
  ].join("\n");
}

function diverReturnPayload(
  jobId: string,
  report: z.infer<typeof DiverModelReportSchema>,
  modelReport: z.infer<typeof DiverModelReportSchema> | null,
  hostEvidenceCategories: readonly string[],
  includeHostSummary = false,
  completionCheck: CompletionCheck | null = null,
) {
  return {
    jobId,
    status: report.status,
    ...(modelReport ? { reportedStatus: modelReport.status } : {}),
    ...(includeHostSummary ? { summary: report.summary } : {}),
    ...(includeHostSummary && report.next ? { next: report.next } : {}),
    hostEvidenceCategories: [...hostEvidenceCategories].slice(-24),
    ...(completionCheck ? { completionCheck } : {}),
    ...(modelReport ? { modelReport } : {}),
  };
}

function normalizeReport(text: string): z.infer<typeof DiverModelReportSchema> {
  const parsed = DiverModelReportSchema.safeParse(parseJsonLoose(text));
  if (parsed.success) return parsed.data;
  return {
    status: "blocked",
    goalCategory: "unknown",
    summary: text.trim()
      ? "The diver's brain returned a malformed report. No completion was recorded."
      : "The diver's brain returned no report. No completion was recorded.",
    evidence: [],
    evidenceCategories: [],
  };
}

export interface DiverRunContext {
  signal?: AbortSignal;
  onProgress?: () => void;
  /** A launch receipt only exists after the running job was durably saved. */
  onStarted?: (job: DiverJob) => void;
}

export function createDiver(options: CreateDiverOptions): (input: DiveIntent, context?: DiverRunContext) => Promise<string> {
  const runModel = options.runModel ?? defaultRunDiverModel;
  const now = options.now ?? Date.now;

  return async (rawInput, context = {}): Promise<string> => {
    const input = DiveIntentSchema.parse(rawInput);
    const signal = context.signal ?? options.signal;
    const prior = options.store.load();
    const resuming = prior?.status === "awaiting_human" || prior?.status === "partial";
    const previousHostStatus = resuming ? prior.status : null;
    const at = now();
    const continuation = resuming ? input.intent : null;
    const job: DiverJob = resuming
      ? {
          ...prior,
          status: "running",
          updatedAt: at,
          continuations: [...prior.continuations, input.intent].slice(-8),
        }
      : {
          version: 1,
          id: randomUUID(),
          intent: input.intent,
          status: "running",
          createdAt: at,
          updatedAt: at,
          hostEvidenceCategories: [],
          continuations: [],
        };
    const hostEvidenceCategories = new Set(job.hostEvidenceCategories);
    const capabilities = tracedCapabilities(
      options.trace,
      options.capabilities,
      context.onProgress,
      (categories) => categories.forEach((category) => hostEvidenceCategories.add(category)),
      (categories) => categories.forEach((category) => hostEvidenceCategories.delete(category)),
      (lastTool, traceSeq) => {
        const current = options.store.load();
        if (current?.id !== job.id || current.status !== "running") return;
        options.store.save({
          ...current,
          progress: { completedCalls: (current.progress?.completedCalls ?? 0) + 1, lastTool, traceSeq, at: now() },
          hostEvidenceCategories: [...hostEvidenceCategories].slice(-24),
        });
      },
      () => throwIfAborted(signal),
    );
    options.store.save(job);
    context.onStarted?.(job);
    const call = options.trace.append({
      actor: "diver",
      kind: "model.call",
      label: resuming ? "resume isolated dive" : "start isolated dive",
      detail: { jobId: job.id, intentDigest: digest(job.intent), resumed: resuming },
    });

    if (!options.model) {
      const report = {
        jobId: job.id,
        status: "blocked" as const,
        summary: "The diver's brain is not connected. No browser work was attempted.",
        evidence: [] as string[],
      };
      options.store.save({ ...job, status: "blocked", summary: report.summary, updatedAt: now() });
      options.trace.append({
        actor: "diver",
        kind: "note",
        label: report.summary,
        detail: { jobId: job.id },
        refs: [call.seq],
      });
      return JSON.stringify(report);
    }

    try {
      const modelResult = await runModel({
        model: options.model,
        system: DIVER_SYSTEM,
        prompt: promptFor(job, continuation, [...hostEvidenceCategories], previousHostStatus),
        capabilities,
        maxSteps: options.maxSteps ?? 20,
        signal,
        onProgress: context.onProgress,
        readHostEvidenceCategories: () => [...hostEvidenceCategories],
        workingMessages: job.workingMessages,
      });
      throwIfAborted(signal);
      const structured = DiverModelReportSchema.safeParse(modelResult.report);
      const parsedText = structured.success
        ? null
        : DiverModelReportSchema.safeParse(parseJsonLoose(modelResult.text));
      const modelReport = structured.success
        ? structured.data
        : parsedText?.success
          ? parsedText.data
          : null;
      let report = modelReport ?? normalizeReport(modelResult.text);
      const hostGeneratedReport = !structured.success && !parsedText?.success;
      let includeHostSummary = hostGeneratedReport;
      if (report.status !== "blocked" && modelResult.toolCalls === 0) {
        report = {
          status: "blocked",
          summary: "The diver reported a result without using any capability. No completion or human handoff was recorded.",
          evidence: [],
          goalCategory: report.goalCategory,
          evidenceCategories: [],
        };
        includeHostSummary = true;
      }
      for (const category of modelResult.hostEvidenceCategories ?? []) {
        hostEvidenceCategories.add(category);
      }
      const completionCheck = completionDowngradeCheck(report, [...hostEvidenceCategories]);
      report = completionCheck ? { ...report, status: "partial" } : report;
      const current = options.store.load();
      if (current?.id !== job.id) {
        const summary = "This diver result arrived after a newer research job took ownership. It remains in the trace but cannot overwrite the current job.";
        options.trace.append({
          actor: "diver",
          kind: "note",
          label: "ignored superseded diver result",
          detail: { jobId: job.id, currentJobId: current?.id ?? null },
          refs: [call.seq],
        });
        return JSON.stringify({
          jobId: job.id,
          status: "blocked",
          summary,
          hostEvidenceCategories: [],
          ...(modelReport ? { reportedStatus: modelReport.status, modelReport } : {}),
        });
      }
      const landed: DiverJob = {
        ...current,
        status: report.status,
        summary: report.summary,
        ...(modelResult.workingMessages ? { workingMessages: retainDiverMessages(modelResult.workingMessages) } : {}),
        ...(report.next ? { next: report.next } : { next: undefined }),
        hostEvidenceCategories: [...hostEvidenceCategories].slice(-24),
        updatedAt: now(),
      };
      options.store.save(landed);
      options.trace.append({
        actor: "diver",
        kind: "model.reply",
        label: `dive ${report.status}`,
        detail: {
          jobId: job.id,
          status: report.status,
          steps: modelResult.steps,
          toolCalls: modelResult.toolCalls,
          reportDigest: digest(modelResult.text),
        },
        refs: [call.seq],
      });
      return JSON.stringify(diverReturnPayload(
        job.id,
        report,
        modelReport,
        [...hostEvidenceCategories],
        includeHostSummary,
        completionCheck,
      ));
    } catch (error) {
      const current = options.store.load();
      const superseded = current?.id !== job.id;
      const summary = superseded
        ? "This diver stopped after a newer research job took ownership. It remains in the trace but cannot overwrite the current job."
        : signal?.aborted
        ? "The dive was cancelled."
        : `The diver stopped with an error: ${error instanceof Error ? error.message : String(error)}`;
      if (!superseded) {
        // A failed report does not undo completed capabilities or restore evidence
        // invalidated by them. Retain those facts without claiming completion.
        options.store.save({ ...current, status: "blocked", summary,
          hostEvidenceCategories: [...hostEvidenceCategories].slice(-24), updatedAt: now() });
      }
      options.trace.append({
        actor: "diver",
        kind: "note",
        label: summary,
        detail: { jobId: job.id },
        refs: [call.seq],
      });
      return JSON.stringify({
        jobId: job.id,
        status: "blocked",
        summary,
        hostEvidenceCategories: superseded ? [] : [...hostEvidenceCategories].slice(-24),
      });
    }
  };
}

export const __diverTest = {
  system: DIVER_SYSTEM,
  finalStepReports,
  prepareDiverStep,
  instructionsWithHostEvidence,
  preserveNarrative,
  normalizeReport,
  adjudicateCompletion,
  completionDowngradeCheck,
  defaultRunDiverModel,
  isMeaningfulStreamChunk,
};
