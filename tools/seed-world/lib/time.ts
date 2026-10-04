// Epoch arithmetic — every timestamp is E + an offset. No wall-clock reads.
// Epoch-slide (rebuild contract point 3): change WORLD_EPOCH, every
// timestamp moves by the same delta, nothing else changes.

export const DEFAULT_WORLD_SEED = 20260915;
export const DEFAULT_WORLD_EPOCH = "2026-09-15T09:00:00-07:00";

export interface Clock {
  epochMs: number;
  /** E + offsetDays (fractional allowed) + offsetMinutes, as ISO 8601. */
  at(offsetDays: number, offsetMinutes?: number): string;
}

export function makeClock(epochIso: string): Clock {
  const epochMs = Date.parse(epochIso);
  if (Number.isNaN(epochMs)) {
    throw new Error(`WORLD_EPOCH is not a parseable timestamp: ${epochIso}`);
  }
  return {
    epochMs,
    at(offsetDays: number, offsetMinutes = 0): string {
      const ms = epochMs + offsetDays * 86_400_000 + offsetMinutes * 60_000;
      return new Date(ms).toISOString();
    },
  };
}

export function resolveSeed(env: NodeJS.ProcessEnv): number {
  const raw = env.WORLD_SEED;
  if (raw === undefined || raw === "") return DEFAULT_WORLD_SEED;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`WORLD_SEED must be an integer, got: ${raw}`);
  }
  return n | 0;
}

export function resolveEpoch(env: NodeJS.ProcessEnv): string {
  const raw = env.WORLD_EPOCH;
  if (raw === undefined || raw === "") return DEFAULT_WORLD_EPOCH;
  return raw;
}
