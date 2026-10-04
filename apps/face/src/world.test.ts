import { describe, expect, it, vi } from "vitest";
import type { World } from "../../../tools/projections/types.js";
import { loadWorld, upcomingGathering } from "./world.js";

function worldWithUpcoming(count: number): World {
  return {
    entries: [],
    persons: [],
    contexts: [],
    gatherings: Array.from({ length: count }, (_, index) => ({
      id: `g-${index}`,
      context: "3cs",
      name: `Gathering ${index}`,
      date: "2026-09-18T01:30:00.000Z",
      upcoming: true,
    })),
  };
}

describe("face world source", () => {
  it("loads the same world the sidecar has already bound", async () => {
    const world = worldWithUpcoming(1);
    const fetchWorld = vi.fn(async () => new Response(JSON.stringify({ world }), { status: 200 }));

    await expect(loadWorld(fetchWorld)).resolves.toEqual(world);
    expect(fetchWorld).toHaveBeenCalledWith("/api/lois/world", { headers: { Accept: "application/json" } });
  });

  it("focuses only when one upcoming gathering is obvious", () => {
    expect(upcomingGathering(worldWithUpcoming(0))).toBeNull();
    expect(upcomingGathering(worldWithUpcoming(1))?.id).toBe("g-0");
    expect(upcomingGathering(worldWithUpcoming(2))).toBeNull();
  });
});
