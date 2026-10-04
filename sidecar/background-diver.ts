import type { DiveIntent, DiverJob, DiverJobStore, DiverRunContext } from "../packages/lois/diver.js";
import { publicDiverJob } from "../packages/lois/diver.js";

export interface WorkerSettlement { jobId: string; report: string; signal: AbortSignal; detail?: Record<string, unknown> }

interface Flight { controller: AbortController; work: Promise<string>; launch: { job?: DiverJob } }

/** One owned research flight; its lifetime is independent of a mouth response. */
export function createBackgroundDiver(options: {
  store: DiverJobStore;
  run: (input: DiveIntent, context: DiverRunContext) => Promise<string>;
  onSettled?: (result: WorkerSettlement) => void | Promise<void>;
  onDeliveryError: (error: unknown, jobId: string) => void;
}) {
  let active: Flight | null = null;
  const deliveries = new Map<Promise<void>, AbortController>();
  let onSettled = options.onSettled;

  const status = () => {
    const job = options.store.load();
    return job ? { ...publicDiverJob(job), jobId: job.id, active: Boolean(active) } : null;
  };

  function begin(input: DiveIntent, context: DiverRunContext = {}, detail?: Record<string, unknown>): Flight & { alreadyRunning: boolean } {
    if (active) return { ...active, alreadyRunning: true };
    const controller = new AbortController();
    const launch: Flight["launch"] = {};
    const work = options.run(input, {
      signal: controller.signal,
      onProgress: context.onProgress,
      onStarted: job => { launch.job = job; context.onStarted?.(job); },
    });
    const flight = { controller, work, launch };
    active = flight;
    const delivered = work.then(async report => {
      if (active === flight) active = null;
      if (controller.signal.aborted) return;
      if (launch.job) await onSettled?.({ jobId: launch.job.id, report, signal: controller.signal, ...(detail ? { detail } : {}) });
    }, error => {
      if (active === flight) active = null;
      if (!controller.signal.aborted) options.onDeliveryError(error, launch.job?.id ?? "unknown");
    }).catch(error => {
      if (!controller.signal.aborted) options.onDeliveryError(error, launch.job?.id ?? "unknown");
    });
    deliveries.set(delivered, controller);
    void delivered.then(() => deliveries.delete(delivered), () => deliveries.delete(delivered));
    return { ...flight, alreadyRunning: false };
  }

  return {
    status,
    hasPendingWork: () => Boolean(active || deliveries.size),
    setOnSettled(callback: typeof onSettled) { onSettled = callback; },
    async start(input: DiveIntent, signal?: AbortSignal): Promise<string> {
      signal?.throwIfAborted();
      const flight = begin(input);
      const job = status();
      // A persistence failure must be returned, never acknowledged as launched.
      if (!flight.launch.job || job?.id !== flight.launch.job.id) {
        await flight.work;
        throw new Error("Research did not persist a job.");
      }
      return JSON.stringify({ ...job, accepted: !flight.alreadyRunning, alreadyRunning: flight.alreadyRunning,
        requestApplied: !flight.alreadyRunning,
        ...(flight.alreadyRunning ? { note: "The existing job is still running. This new intent was not applied. Use research_cancel to stop it before starting changed work." } : {}),
      });
    },
    async runAndWait(input: DiveIntent, context?: DiverRunContext, detail?: Record<string, unknown>): Promise<string> {
      if (active) await active.work;
      return begin(input, context, detail).work;
    },
    cancel({ preserveWaiting = false }: { preserveWaiting?: boolean } = {}) {
      const job = options.store.load();
      const resumable = job?.status === "running" || (!preserveWaiting && (job?.status === "partial" || job?.status === "awaiting_human"));
      const cancelled = Boolean(active || deliveries.size || resumable);
      active?.controller.abort();
      for (const controller of deliveries.values()) controller.abort();
      if (job && resumable) {
        options.store.save({ ...job, status: "blocked", summary: "The dive was cancelled.", next: undefined, updatedAt: Date.now() });
      }
      return cancelled;
    },
    async idle() {
      while (active || deliveries.size) {
        await Promise.allSettled([...(active ? [active.work] : []), ...deliveries.keys()]);
      }
    },
  };
}

export type BackgroundDiver = ReturnType<typeof createBackgroundDiver>;
