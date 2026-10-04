// The World, loaded once from Lois's sidecar. The face never selects or
// bundles a vault of its own: the running sidecar already owns that decision,
// including a run-owned smoke vault.
//
// D-042 boundary: components NEVER touch these files. Everything a surface
// shows goes World -> deriveRoom/deriveQueue -> render.
//
import type { Gathering, World } from "../../../tools/projections/types.js";

type WorldFetcher = (
  input: string,
  init: { headers: { Accept: string } },
) => Promise<Pick<Response, "ok" | "status" | "json">>;

function isWorld(value: unknown): value is World {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<World>;
  return (
    Array.isArray(candidate.entries) &&
    Array.isArray(candidate.persons) &&
    Array.isArray(candidate.contexts) &&
    Array.isArray(candidate.gatherings)
  );
}

export async function loadWorld(fetchWorld: WorldFetcher = fetch): Promise<World> {
  const response = await fetchWorld("/api/lois/world", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`world: Lois sidecar returned ${response.status}`);
  const payload = (await response.json()) as { world?: unknown };
  if (!isWorld(payload.world)) throw new Error("world: Lois sidecar returned an invalid world");
  return payload.world;
}

/**
 * The sole obvious upcoming gathering in the world. Zero or several means the
 * conversation stays world-level; event-specific panes never guess a focus.
 */
export function upcomingGathering(world: World): Gathering | null {
  const upcoming = world.gatherings.filter((g) => g.upcoming);
  return upcoming.length === 1 ? upcoming[0] : null;
}
