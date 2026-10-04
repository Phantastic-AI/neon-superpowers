// Deterministic PRNG — mulberry32. No Math.random, no Date.now, no network.
// Same WORLD_SEED -> same sequence, forever (rebuild contract point 2).

export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A named sub-stream, so unrelated draws don't perturb each other when the
 * generator is edited (deriving a new seed per label keeps ordering stable
 * for label X even if label Y's draw count changes). */
export function subRng(rootSeed: number, label: string): Rng {
  let h = 2166136261 ^ rootSeed;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 16777619);
  }
  return makeRng(h >>> 0);
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

export function int(rng: Rng, minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

/** Deterministic Fisher-Yates shuffle (does not mutate input). */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
