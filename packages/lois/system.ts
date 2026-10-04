// lois/system — the whole evented metasystem, assembled (D-111, D-113).
//
// This file is deliberately the WHOLE picture:
//
//   senses  — tell() lands whatever a sense heard (chat, a comment wave, later
//             email/RSVP organs) as ONE `heard` event on the bus.
//   bus     — the run trace: append-only, observable, the coordination fabric.
//   agents  — the mouth (model, thinks + speaks + proposes), the critic (model
//             over the deslop floor, judges drafts), the gate (deterministic,
//             holds every proposal at the proposal -> commit line, D-086).
//   pump    — walks the bus, wakes whoever each event concerns, until quiet.
//
// That's the entire system. More senses land as more tell()-shaped entry
// points; more workers (plan-updater, fact-resolver, UX-drawer) register the
// same way the critic does. Nothing is hand-wired to anything.

import { Trace, type TraceEvent } from "./trace.js";
import { Registry } from "./registry.js";
import { loisMouth, type MouthOptions, type TurnResult } from "./mind.js";
import { theGate } from "./gate.js";
import { voiceCritic } from "./guardian.js";
import { goldfishSchool, type GoldfishSchoolOptions } from "./goldfish.js";
import type { LoisModel } from "./model.js";
import type { CalibrationPair } from "./voice.js";
import type { World } from "../../tools/projections/types.js";

export interface LoisSystemOptions {
  world: World;
  model: LoisModel | null;
  /** Role-specific adapters may share one provider budget while retaining actor evidence. */
  models?: {
    mouth?: LoisModel;
    critic?: LoisModel;
    goldfish?: LoisModel;
  };
  gatheringId?: string;
  channel?: string;
  purpose?: string;
  calibration?: CalibrationPair[];
  voiceNotes?: string;
  /** Live sink for every bus event (a face pane streams from this). */
  sink?: (e: TraceEvent) => void;
  /** A pre-built trace (e.g. the persistent one from tools/lois-persist) — wins over sink. */
  trace?: Trace;
  /** Streams the mouth's say as she writes it (first words ~1s, D-113 latency law). */
  onSay?: (delta: string) => void;
  /** Explicit stop also stops owned background research, not just the mouth. */
  onCancel?: () => void;
  /** Her hands (D-117), server-injected: named consented actions (the dive). */
  hands?: MouthOptions["hands"];
  /** Bound model dispatches per mouth turn. The paid smoke sets this to its call ceiling. */
  maxSteps?: number;
  /** Product default is the full school; the smoke may select exactly one recipient read. */
  goldfish?: GoldfishSchoolOptions;
}

export interface LoisSystem {
  /** A sense heard the organizer: land it on the bus and pump until quiet. */
  tell(message: string): Promise<TurnResult>;
  /** A bounded worker landed new evidence: wake the same mouth without impersonating the organizer. */
  continueFromWorker(message: string, detail?: Record<string, unknown>, signal?: AbortSignal): Promise<TurnResult>;
  /** Cancel the in-flight turn (D-119): aborts the model call, stops the cascade. */
  cancel(options?: { background?: boolean }): void;
  /** Wait until the detached critic/goldfish/gate cascade is quiet. */
  idle(): Promise<void>;
  trace: Trace;
  /** Who's in the brain — the registry's introspection. */
  roster(): { name: string; role: string; purpose: string }[];
}

export function createLois(opts: LoisSystemOptions): LoisSystem {
  const trace = opts.trace ?? new Trace(opts.sink);
  let last: TurnResult | null = null;
  let controller: AbortController | null = null;
  let turnLanded: ((r: TurnResult) => void) | null = null;
  const activePumps = new Set<Promise<void>>();
  let internalTurnsPending = 0;
  let internalTurns: Promise<void> = Promise.resolve();
  const mouthModel = opts.models?.mouth ?? opts.model;
  const criticModel = opts.models?.critic ?? opts.model;
  const goldfishModel = opts.models?.goldfish ?? opts.model;

  const mouthOpts: MouthOptions = {
    gatheringId: opts.gatheringId,
    channel: opts.channel,
    purpose: opts.purpose,
    calibration: opts.calibration,
    voiceNotes: opts.voiceNotes,
    onTurn: (r) => {
      last = r;
      turnLanded?.(r);
    },
    onSay: opts.onSay,
    hands: opts.hands,
    maxSteps: opts.maxSteps,
  };

  const registry = new Registry()
    .register(loisMouth(mouthModel, mouthOpts))
    .register(voiceCritic(criticModel, { calibration: opts.calibration, voiceNotes: opts.voiceNotes }))
    .register(goldfishSchool(goldfishModel, opts.goldfish))
    .register(theGate());

  async function pumpHeard(
    actor: "organizer" | "diver",
    message: string,
    detail: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<TurnResult> {
    signal?.throwIfAborted();
    controller = new AbortController();
    const turnSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    last = null;
    const from = trace.cursor;
    const turn = new Promise<TurnResult>((resolve) => {
      turnLanded = resolve;
    });
    trace.append({ actor, kind: "heard", label: message, detail: { ...detail, text: message } });
    const pumping = registry
      .pump({ world: opts.world, trace, signal: turnSignal }, from)
      .finally(() => {
        controller = null;
        turnLanded = null;
      });
    activePumps.add(pumping);
    void pumping.then(
      () => activePumps.delete(pumping),
      () => activePumps.delete(pumping),
    );
    return Promise.race([
      turn,
      pumping.then(() => last ?? { ok: false, why: "Lois's turn ended before she answered." }),
    ]);
  }

  return {
    trace,
    roster: () => registry.roster(),
    cancel: ({ background = true } = {}) => { controller?.abort(); if (background) opts.onCancel?.(); },
    async idle(): Promise<void> {
      // Snapshot-and-repeat: a caller waits for every pump already running,
      // then rechecks in case another turn began while that snapshot settled.
      while (activePumps.size > 0) {
        await Promise.all([...activePumps]);
      }
    },
    async tell(message: string): Promise<TurnResult> {
      if (activePumps.size > 0 || internalTurnsPending > 0) {
        return { ok: false, why: "Lois is already answering. Let that turn land first." };
      }
      // The chat budget (D-119): resolve the moment the MOUTH lands her turn;
      // the worker cascade (critic, goldfish, gate over many proposals) keeps
      // pumping detached, off the critical path, still landing on the trace.
      return pumpHeard("organizer", message);
    },
    async continueFromWorker(message: string, detail: Record<string, unknown> = {}, signal?: AbortSignal): Promise<TurnResult> {
      signal?.throwIfAborted();
      internalTurnsPending += 1;
      let resolveResult!: (result: TurnResult) => void;
      let rejectResult!: (error: unknown) => void;
      const result = new Promise<TurnResult>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      const scheduled = internalTurns.catch(() => undefined).then(async () => {
        try {
          while (activePumps.size > 0) await Promise.all([...activePumps]);
          signal?.throwIfAborted();
          resolveResult(await pumpHeard("diver", message, detail, signal));
        } catch (error) {
          rejectResult(error);
        } finally {
          internalTurnsPending -= 1;
        }
      });
      internalTurns = scheduled.then(() => undefined, () => undefined);
      return result;
    },
  };
}
