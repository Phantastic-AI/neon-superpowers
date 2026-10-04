export type ApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected';
export type MissionStatus = 'draft' | 'ready' | 'running' | 'paused' | 'completed' | 'failed';
export type MissionItemStatus = 'queued' | 'evaluating' | 'needs_approval' | 'skipped' | 'failed';
export type FitStatus = 'unknown' | 'aligned' | 'not_aligned' | 'unclear';

export interface BrowserPageContext {
  url: string;
  title?: string;
  visibleText?: string;
  selectedText?: string;
  screenshotDataUrl?: string;
  capturedAt?: string;
}

export interface Evidence {
  sourceUrl: string;
  label: string;
  summary: string;
  observed: boolean;
}

export interface BrowserItemInput {
  id: string;
  name: string;
  organization?: string;
  sourceUrl?: string;
  notes?: string;
}

export interface MissionItem extends BrowserItemInput {
  status: MissionItemStatus;
  fit: FitStatus;
  evidence: Evidence[];
  summary?: string;
  suggestedNextAction?: string;
}

export interface Mission {
  id: string;
  name: string;
  thesis: string;
  status: MissionStatus;
  items: MissionItem[];
  auditLog: AuditEvent[];
  draftActions: DraftAction[];
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  missionId: string;
  missionItemId?: string;
  type: string;
  actor: 'user' | 'assistant' | 'system';
  source?: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export type ExternalActionType =
  | 'send_email'
  | 'send_social_action'
  | 'submit_form'
  | 'save_research_note';

export interface DraftAction {
  id: string;
  missionItemId: string;
  actionType: ExternalActionType;
  targetSurface: string;
  payload: Record<string, unknown>;
  requiresApproval: true;
  approvalStatus: ApprovalStatus;
  createdAt: string;
}

export type ActionSideEffectClass =
  | 'read_only'
  | 'side_effecting'
  | 'external_write'
  | 'irreversible_send'
  | 'social_action';

export type RunMode = 'rehearsal' | 'step_through' | 'autonomous';

export interface ActionIntent {
  id: string;
  skillId: string;
  runId: string;
  stepId: string;
  service: string;
  actionClass: string;
  sideEffectClass: ActionSideEffectClass;
  requiredCapabilities: string[];
  targetIdentity?: string | null;
  payload: unknown;
  idempotencyKey: string;
  createdAt: string;
}

export interface ActionContract {
  id: string;
  service: string;
  actionClass: string;
  sideEffectClass: ActionSideEffectClass;
  requiredCapabilities: string[];
  version: string;
}

export type ActionAttemptState =
  | 'pending'
  | 'blocked_by_tool_guard'
  | 'cost_budget_exhausted'
  | 'executing'
  | 'succeeded'
  | 'failed_before_remote_send'
  | 'failed_after_remote_send_unknown_effect'
  | 'failed_with_provider_error'
  | 'failed_with_rate_limit'
  | 'failed_due_to_auth'
  | 'failed_due_to_backend_outage'
  | 'failed_readback_verification';

export interface ActionAttempt {
  id: string;
  actionIntentId: string;
  state: ActionAttemptState;
  runMode: RunMode;
  latencyMs?: number | null;
  estimatedCostUsd?: number | null;
  actualCostUsd?: number | null;
  outcome?: string | null;
  evidenceRefs: string[];
  attemptNumber: number;
  startedAt: string;
  completedAt?: string | null;
}

export interface ActionLedgerEntry {
  id: string;
  sequenceNumber: number;
  intent: ActionIntent;
  attempt: ActionAttempt;
  runMode: RunMode;
  criticVerdict?: string | null;
  toolGuardReserve?: unknown;
  toolGuardException?: unknown;
  createdAt: string;
}

export type ApprovalGateCadence = 'every_row' | 'end_of_run';

export interface ApprovalGate {
  cadence: ApprovalGateCadence;
}

export interface Skill {
  id: string;
  name: string;
  goal: string;
  workerPrompt: string;
  approvalGate: ApprovalGate;
  createdAt: string;
}

export interface SkillSummary {
  skillId: string;
  skillName: string;
  startedAt: string;
  hasDraftTemplate: boolean;
  status?: string | null;
  derivedFromRunId?: string | null;
}

export interface SkillMetadata {
  skillId: string;
  skillName: string;
  goalTemplate: string;
  startedAt: string;
  forEachParam: string | null;
  draftTemplate: string | null;
  status?: string | null;
  derivedFromRunId?: string | null;
}

export interface SaveRunAsSkillResult {
  skillId: string;
  skillName: string;
  bundlePath: string;
  lintWarnings: string[];
}

export type SaveRunAsSkillError =
  | { kind: 'run_dir_not_found'; runId: string }
  | { kind: 'skill_id_conflict'; skillId: string }
  | { kind: 'io_error'; reason: string }
  | { kind: 'invalid_input'; reason: string };

export type Cadence =
  | { kind: 'daily'; atLocal: string }
  | { kind: 'weekly'; dow: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun'; atLocal: string };

export type ScheduleInput =
  | { kind: 'none' }
  | { kind: 'dossier'; table: string };

export type ScheduleOutput =
  | { kind: 'drafts' }
  | { kind: 'dossier'; table: string };

export type ScheduleStatus = 'active' | 'paused' | 'deleted';

export interface Schedule {
  schemaVersion: number;
  scheduleId: string;
  version: number;
  skillId: string;
  cadence: Cadence;
  input: ScheduleInput;
  output: ScheduleOutput;
  status: ScheduleStatus;
  misfirePolicy: { kind: 'run_once_within_grace' };
  nextDueAt: string;
  createdAt: string;
  updatedAt: string;
  maxCostUsd: number | null;
  timezone: string;
}

export type DraftState = 'generated' | 'edited' | 'approved' | 'request_redo' | 'released' | 'superseded';
export type ReviewDecision = 'approve' | 'request_redo';

export interface Draft {
  id: string;
  runReviewId: string;
  state: DraftState;
  reviewDecision?: ReviewDecision | null;
  releasedRevisionId?: string | null;
  currentRevisionId: string;
  revisionCount: number;
  createdAt: string;
}

export interface DraftRevision {
  revId: string;
  draftId: string;
  revisionNumber: number;
  content: string;
  superseded: boolean;
  createdAt: string;
}

export type PlayerRunMode = 'step_through' | 'autonomous' | 'rehearsal';

export type PlayerGateReason =
  | 'side_effecting_action'
  | 'max_steps_reached'
  | 'step_through_mode'
  | 'critic_flagged'
  | 'operator_requested';

/**
 * Slice 2.0.17a — discriminated union; previously a flat string union.
 * The `failed` variant now carries `errorMessage: string` so the FE
 * transcript + trace can render the browser error verbatim instead of
 * a generic "step failed" string. Other variants stay unit-shaped.
 */
export type PlayerAttemptOutcome =
  | { kind: 'succeeded' }
  | { kind: 'failed'; errorMessage: string }
  | { kind: 'blocked_by_guard' }
  | { kind: 'rehearsal_skipped' };

export type PlayerCancellationSource = 'operator' | 'timeout' | 'system_error';

export interface PlayerPageObservation {
  url: string;
  title?: string | null;
  visibleText?: string | null;
}

export interface PlayerActionDocument {
  kind: string;
  targetUrl?: string | null;
  readableSummary: string;
  payload: unknown;
}

export type PlayerSideEffectClass = 'read_only' | 'side_effecting';

/**
 * Slice 2.0.17b — research scratchpad threaded through every state
 * from Observing onward. Mirrors `RunResearchState` in
 * `apps/desktop/src-tauri/src/player_loop.rs`. Bounded structures:
 * notes cap at 12, recent_actions at 8 — older entries drop at head.
 */
export type ResearchSourceStatus =
  | 'pending'
  | 'observed'
  | 'summarized'
  | 'blocked'
  | 'needs_more';

export interface ResearchSource {
  url: string;
  status: ResearchSourceStatus;
  title?: string | null;
  summary?: string | null;
  lastObservedStep?: string | null;
}

export interface ResearchNote {
  sourceUrl?: string | null;
  summary: string;
  facts: string[];
  scoreSignals: string[];
}

export interface StepMemory {
  stepId: string;
  kind: string;
  targetUrl?: string | null;
  readableSummary: string;
  outcome?: PlayerAttemptOutcome | null;
  /** Slice 2.0.23 — snapshot of `action.payload.selector` so the model
   *  on retry knows WHICH selector it tried (not just THAT it did
   *  fill_form). Surfaced in `render_recent_actions_for_prompt`. */
  selector?: string | null;
  /** Slice 2.0.23 — first 80 chars of `action.payload.text` for fill /
   *  type kinds. Bounded to keep the recent_actions prompt section
   *  small; the full text lives in the trace's `payloadPreview`. */
  textPreview?: string | null;
}

export interface RunResearchState {
  sources: ResearchSource[];
  notes: ResearchNote[];
  recentActions: StepMemory[];
  lastError?: string | null;
  /**
   * Slice 4.27 — persistent ledger of operator answers to mid-run
   * `ask_operator` questions, serialized as `[question, answer]` tuples.
   * Optional on the wire; the FE does not read it today (the answer is
   * surfaced through the loop's decide prompts server-side).
   */
  operatorAnswers?: Array<[string, string]>;
}

export interface RouteIntentResult {
  url: string;
  rationale: string;
}

export interface StartRunArgs {
  goal: string;
  mode: PlayerRunMode;
  skillId?: string | null;
  maxStepsWithoutApproval?: number | null;
}

export interface RunHandle {
  runId: string;
  startedAt: string;
}

/**
 * Slice 2.0.23 — per-Run accumulated cost reporting. Aggregated by the
 * BE `PlayerRunCoordinator` from every `ModelResponse.input_tokens` +
 * `output_tokens` across the Run. Surfaced on
 * `PlayerRunOutcome.cost`; the FE transcript renders a "Cost: N LLM
 * calls, M input + K output tokens (~$0.0X)" line at terminal.
 *
 * Pre-2.0.23 serialized outcomes don't carry this field; treat as
 * optional on the wire (BE serializes with `default = RunCost::default()`).
 */
export interface RunCost {
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
}

export interface PlayerRunOutcome {
  summary: string;
  stepsExecuted: number;
  cost?: RunCost;
}

export type PlayerLoopError =
  | { kind: 'unexpected_error'; message: string }
  | { kind: 'llm_call_failed'; message: string }
  | { kind: 'browser_action_failed'; message: string }
  | { kind: 'terminal_goal_unreachable'; message: string };

export type PlayerLoopState =
  | {
      state: 'init';
      runId: string;
      skillId: string;
      mode: PlayerRunMode;
      goal: string;
    }
  | {
      state: 'planning';
      runId: string;
      skillId: string;
      mode: PlayerRunMode;
      goal: string;
      awaitingInitialUrl: boolean;
    }
  | {
      state: 'observing';
      runId: string;
      skillId: string;
      mode: PlayerRunMode;
      stepId: string;
      stepsCompleted: number;
      research: RunResearchState;
    }
  | {
      state: 'deciding';
      runId: string;
      skillId: string;
      mode: PlayerRunMode;
      stepId: string;
      observation: PlayerPageObservation;
      stepsCompleted: number;
      research: RunResearchState;
    }
  | {
      state: 'classifying';
      runId: string;
      skillId: string;
      mode: PlayerRunMode;
      stepId: string;
      proposedAction: PlayerActionDocument;
      stepsCompleted: number;
      research: RunResearchState;
    }
  | {
      state: 'awaiting_gate';
      runId: string;
      skillId: string;
      mode: PlayerRunMode;
      stepId: string;
      proposedAction: PlayerActionDocument;
      gateReason: PlayerGateReason;
      stepsCompleted: number;
      research: RunResearchState;
    }
  | {
      // Slice 4.27 — the model proposed `ask_operator`; the run is paused
      // on a blocking question surface awaiting the operator's answer.
      state: 'awaiting_question';
      runId: string;
      skillId: string;
      mode: PlayerRunMode;
      stepId: string;
      question: string;
      context?: string;
      stepsCompleted: number;
      research: RunResearchState;
    }
  | {
      state: 'executing';
      runId: string;
      skillId: string;
      mode: PlayerRunMode;
      stepId: string;
      action: PlayerActionDocument;
      stepsCompleted: number;
      research: RunResearchState;
    }
  | {
      state: 'recording';
      runId: string;
      skillId: string;
      mode: PlayerRunMode;
      stepId: string;
      action: PlayerActionDocument;
      attemptOutcome: PlayerAttemptOutcome;
      stepsCompleted: number;
      research: RunResearchState;
    }
  | {
      state: 'completed';
      runId: string;
      outcome: PlayerRunOutcome;
    }
  | {
      state: 'failed';
      runId: string;
      error: PlayerLoopError;
    }
  | {
      state: 'cancelled';
      runId: string;
      by: PlayerCancellationSource;
    };

export type PlayerLoopStateName = PlayerLoopState['state'];

// === Slice 1.8 — Player loop wiring (Tauri event payloads + gate IPC) ===
// Hand-mirrored from Rust source-of-truth in apps/desktop/TAURI_COMMANDS.md
// §"Slice 1.8 — Player loop wiring". Field naming uses camelCase per
// #[serde(rename_all = "camelCase")] on the wire.

export interface PlayerLoopEventPayload {
  runId: string;
  oldStateName: PlayerLoopStateName;
  newStateName: PlayerLoopStateName;
  state: PlayerLoopState;
}

// FE → BE input on submit_gate_decision. The operator's choice in the
// Approval Gate modal.
export type GateDecision =
  | { kind: 'approve' }
  | { kind: 'reject'; reason: string }
  | { kind: 'cancel' };

// BE-side outcome of an Approval Gate, recorded after the GateDecision is
// applied (or after timeout/cancellation). Distinct from GateDecision so
// downstream observers see a uniform record shape regardless of how the
// gate resolved.
export type GateOutcome =
  | { kind: 'approved' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'cancelled' };

export interface GatePendingEventPayload {
  runId: string;
  gateId: string;
  proposedAction: PlayerActionDocument;
  gateReason: PlayerGateReason;
  /**
   * Slice 2.0.14 — classifier verdict for `proposedAction`. The FE
   * Run Review surface renders the right label off this instead of
   * hardcoding (was: `external_write`). `read_only` is possible here
   * too — e.g. when the gate fires because of `max_steps_reached`,
   * not because the action is side-effecting.
   */
  sideEffectClass: PlayerSideEffectClass;
}

/**
 * Slice 4.27 — payload for `question_pending_event`. Emitted when the
 * model proposes `ask_operator` mid-run and the loop pauses on a blocking
 * question surface. Mirrors `QuestionPendingEventPayload` in
 * `tauri_question_adapter.rs` (serde camelCase). The operator's typed
 * answer is delivered back via `submit_question_answer`; aborting reuses
 * the existing `cancel_run` path.
 */
export interface QuestionPendingEventPayload {
  runId: string;
  questionId: string;
  question: string;
  context?: string;
}

// === Slice 2.0 — Sub-Skills + Composer + Dossiers ===
// Hand-mirrored from Rust source-of-truth in apps/desktop/TAURI_COMMANDS.md
// §"Commands needed for Slice 2.0". Field naming uses camelCase per
// #[serde(rename_all = "camelCase")] on the wire.
//
// O1 (oracle): `SubSkillScope` is wire-only — exists only for the Tauri
// command boundary. Internal Rust orchestrator dispatches into
// `LiveExecutionCtx` or `FixtureExecutionCtx`, neither of which crosses
// the boundary — so they are intentionally NOT mirrored here.

export type SchemaColumnType = 'text' | 'integer' | 'url' | 'email' | 'boolean' | 'timestamp';

export interface SchemaColumnSpec {
  name: string;
  sqlType: SchemaColumnType;
  sourceHint?: string | null;
  nullable: boolean;
}

export interface InferredColumn {
  name: string;
  sqlType: SchemaColumnType;
  sourceHint?: string | null;
  exampleValues: string[];
}

export type SubSkillScope =
  | { kind: 'live'; forEachParam: string }
  | { kind: 'fixture'; fixturePath: string };

export interface ComposerSessionHandle {
  sessionId: string;
  startedAt: string;
}

export interface ComposerRecording {
  sessionId: string;
  skillBundlePath?: string | null;
}

export type ComposerNarrationKind = 'url_change' | 'dom_mutation' | 'operator_paused';
export type ComposerQuestionExpectedKind = 'text' | 'selector' | 'confirm';

export interface InferredStepSummary {
  urlPattern: string;
  selectorPattern?: string | null;
  actionKind: string;
}

export interface ComposerNarrationPayload {
  sessionId: string;
  narrationText: string;
  narrationKind: ComposerNarrationKind;
  inferredStep?: InferredStepSummary | null;
}

export interface ComposerQuestionPayload {
  sessionId: string;
  questionId: string;
  prompt: string;
  expectedKind: ComposerQuestionExpectedKind;
  hints: string[];
}

export interface ComposerSchemaProposalPayload {
  sessionId: string;
  columns: InferredColumn[];
  rowKeyColumns: string[];
}

export type ComposerAnswer =
  | { kind: 'text'; value: string }
  | { kind: 'selector'; value: string }
  | { kind: 'drop_question' };

export interface SubSkillRunHandle {
  runId: string;
  startedAt: string;
}

export type SubSkillRowState = 'succeeded' | 'partial' | 'failed';

export interface SubSkillRowOutcome {
  rowKey: string;
  state: SubSkillRowState;
  errorText: string | null;
}

export interface SubSkillProgressPayload {
  runId: string;
  rowsCompleted: number;
  rowsTotal: number;
  lastRowOutcome: SubSkillRowOutcome | null;
}

export interface DossierTableSummary {
  skillId: string;
  tableName: string;
  rowCount: number;
  rowKeyColumns: string[];
  lastRunId?: string | null;
  lastRunCompletedAt?: string | null;
}

export type DossierWhereOp =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'gt_num'
  | 'lt_num'
  | 'is_null'
  | 'not_null';

export interface DossierWhereClause {
  column: string;
  op: DossierWhereOp;
  value: unknown;
}

export interface DossierQueryFilter {
  whereClauses: DossierWhereClause[];
  orderBy?: string | null;
  includeHistory?: boolean;
}

export type DossierRow = Record<string, string | number | boolean | null>;

export interface DossierRunLog {
  lastRunId?: string | null;
  lastRunStartedAt?: string | null;
  lastRunCompletedAt?: string | null;
  rowsWritten: number;
  rowsSucceeded: number;
  rowsPartial: number;
  rowsFailed: number;
}

export interface DossierQueryResult {
  columns: SchemaColumnSpec[];
  rows: DossierRow[];
  totalCount: number;
  runLog: DossierRunLog;
}

export type RunSubSkillError =
  | { kind: 'orchestrator_disabled'; message: string }
  | { kind: 'bundle_not_found'; skillId: string }
  | { kind: 'invalid_scope'; reason: string };
