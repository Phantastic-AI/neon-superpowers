import { expect, it } from "vitest";
import { createSenses } from "./senses.js";
import { Trace } from "./trace.js";
import type { Entry, World } from "../../tools/projections/types.js";

const at = "2026-09-06T00:00:00Z";

function emptyWorld(): World {
  return { entries: [], persons: [], gatherings: [], contexts: [] };
}

function append(
  world: World,
  value: Omit<Entry, "id" | "cursor" | "at" | "context" | "actor"> & Partial<Pick<Entry, "context">>,
): Entry {
  const entry = {
    id: `e-${world.entries.length}`,
    cursor: world.entries.length,
    at,
    context: value.context ?? "c-dinners",
    actor: { kind: "app" as const, ref: "test" },
    ...value,
  };
  world.entries.push(entry);
  return entry;
}

function selectPeopleSource(world: World, viewId: string, eventId: string, selected = true): Entry {
  return append(world, {
    type: "listing",
    subtype: "people-source",
    about: eventId,
    payload: {
      platform: "luma",
      accountId: "owner",
      eventId,
      name: `Dinner ${eventId}`,
      date: "2026-08-01",
      url: `https://luma.test/${eventId}`,
      evidence: [`artifact:${eventId}`],
      gathering: eventId,
      viewId,
      viewName: "Historical dinner people",
      selected,
      discoveryComplete: false,
      operation: "selection",
      readState: "unread",
      rowCount: 0,
      rowEntryIds: [],
    },
  });
}

async function executeSense(tools: ReturnType<typeof createSenses>["tools"], name: string): Promise<string> {
  return await (tools[name] as unknown as { execute: (input: Record<string, never>, ...rest: unknown[]) => Promise<string> }).execute({});
}

it("supplies stable World IDs without requiring or inventing a future gathering", async () => {
  const world: World = { entries: [], persons: [], gatherings: [], contexts: [
    { id: "c-dinners", name: "Our dinners", kind: "social", anchor: "email", created_at: "2026-09-01T00:00:00Z" },
    { id: "c-private-system", name: "Private system", kind: "system", anchor: "email", apps_never_read: true, created_at: "2026-09-01T00:00:00Z" },
  ] };
  world.gatherings.push(
    { id: "g-dinner", context: "c-dinners", name: "Visible Dinner", date: "2026-09-10T00:00:00Z", upcoming: true },
    { id: "g-private", context: "c-private-system", name: "Private System Gathering", date: "2026-09-11T00:00:00Z", upcoming: true },
  );
  const warm = await createSenses(world, null, new Trace()).warm();
  expect(warm.look).toContain("c-dinners");
  expect(warm.look).toContain("Our dinners");
  expect(warm.look).toContain("Visible Dinner");
  expect(warm.look).not.toContain("c-private-system");
  expect(warm.look).not.toContain("Private System Gathering");
  expect(warm.look).not.toContain("Sep 11");
});

it("refreshes explicit Worlds reads after a warm empty snapshot in the same turn", async () => {
  const world = emptyWorld();
  const trace = new Trace();
  const senses = createSenses(world, null, trace);

  const warm = await senses.warm();
  expect(warm.look).toContain("No event worlds or gatherings are in the vault yet");

  world.contexts.push({
    id: "c-dinners",
    name: "Our dinners",
    kind: "social",
    anchor: "email",
    created_at: at,
  });
  world.contexts.push({
    id: "c-system",
    name: "System",
    kind: "system",
    anchor: "email",
    apps_never_read: true,
    created_at: at,
  });
  world.gatherings.push({
    id: "dinner-a",
    context: "c-dinners",
    name: "Dinner A",
    date: "2026-08-01T00:00:00Z",
    upcoming: false,
  });
  selectPeopleSource(world, "history", "dinner-a");

  const first = await executeSense(senses.tools, "worlds");
  expect(first).toContain("Our dinners [contextId=c-dinners]");
  expect(first).toContain("Historical dinner people [contextId=c-dinners, viewId=history]");
  expect(first).toContain("0 people; 0/1 selected lists read");
  expect(first).not.toContain("c-system");
  expect(first).not.toContain("already read this turn");

  selectPeopleSource(world, "second-history", "dinner-a");

  const second = await executeSense(senses.tools, "worlds");
  expect(second).toContain("viewId=second-history");
  expect(second).not.toContain("already read this turn");
  expect(trace.all().filter((event) => event.label === "worlds" && event.kind === "tool.call")).toHaveLength(2);
  expect(trace.all().filter((event) => event.kind === "tool.return" && String(event.label).includes("Saved people views"))).toHaveLength(2);
});

it("keeps look and rank as turn-cached senses", async () => {
  const world: World = {
    entries: [],
    persons: [],
    gatherings: [{ id: "g-1", context: "c-dinners", name: "Original dinner", date: at, upcoming: true }],
    contexts: [{ id: "c-dinners", name: "Our dinners", kind: "social", anchor: "email", created_at: at }],
  };
  const trace = new Trace();
  const senses = createSenses(world, world.gatherings[0], trace);
  const warm = await senses.warm();
  expect(warm.look).toContain('Room "Original dinner"');

  world.gatherings[0].name = "Mutated dinner";

  const look = await executeSense(senses.tools, "look");
  const rank = await executeSense(senses.tools, "rank");
  expect(look).toContain("(already read this turn)");
  expect(look).toContain('Room "Original dinner"');
  expect(look).not.toContain("Mutated dinner");
  expect(rank).toContain("(already read this turn)");
  expect(trace.all().filter((event) => event.label === "look" || event.label === "rank")).toHaveLength(0);
});
