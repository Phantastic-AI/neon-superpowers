// lois/senses — her read-only senses, as native SDK tools (D-113: senses are
// projections rendered to compact, PII-light strings; no sense can change the
// world). One definition, used by the mind; each call is traced. Room senses
// stay turn-cached because they project a focused gathering snapshot; explicit
// Worlds reads are fresh discovery so same-turn diver saves can be found.

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { look, rank } from "./tools.js";
import { deriveQueue } from "../../tools/projections/queue.js";
import { deriveRoom } from "../../tools/projections/room.js";
import { projectPeopleViews } from "../../tools/projections/people.js";
import type { Trace } from "./trace.js";
import type { Gathering, World } from "../../tools/projections/types.js";

/** PT date rendering — the vault stores UTC; the organizer lives in PT. */
export function pt(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Los_Angeles",
  });
}

export interface Senses {
  /** The SDK tool set the mind hands to streamText. */
  tools: ToolSet;
  /** Pre-read the warm pair (room + audience) into the turn cache. */
  warm(): Promise<{ look: string; rank: string }>;
}

export function createSenses(world: World, gathering: Gathering | null, trace: Trace): Senses {
  const ran = new Map<string, string>();

  const sense = (name: string, description: string, read: () => Promise<string>, options: { fresh?: boolean } = {}) =>
    tool({
      description,
      inputSchema: z.object({}),
      execute: async () => {
        const prior = options.fresh ? undefined : ran.get(name);
        if (prior !== undefined) return `(already read this turn) ${prior}`;
        const tc = trace.append({ actor: "lois", kind: "tool.call", label: name, detail: { tool: name } });
        const obs = await read();
        if (!options.fresh) ran.set(name, obs);
        trace.append({ actor: "lois", kind: "tool.return", label: obs, refs: [tc.seq] });
        return obs;
      },
    });

  const readWorlds = async (): Promise<string> => {
    const contexts = world.contexts.filter((context) => !context.apps_never_read);
    const readableContextIds = new Set(contexts.map((context) => context.id));
    const gatherings = world.gatherings.filter((event) => event.upcoming && readableContextIds.has(event.context));
    if (contexts.length === 0 && gatherings.length === 0) {
      return "No event worlds or gatherings are in the vault yet.";
    }
    const worlds = contexts.length > 0
      ? `Worlds on file: ${contexts.map((context) => `${context.name} [contextId=${context.id}]`).join(", ")}.`
      : "No event worlds are on file.";
    const events = gatherings.length > 0
      ? `Upcoming gatherings: ${gatherings.map((event) => `${event.name} (${pt(event.date)})`).join(", ")}.`
      : "No upcoming gatherings are on file.";
    const people = projectPeopleViews(world).map(view => `${view.name} [contextId=${view.contextId}, viewId=${view.viewId}]: ${view.people.length} people; ${view.coverage.read}/${view.coverage.selected} selected lists read; discovery ${view.coverage.discoveryComplete ? "complete" : "incomplete"}`);
    return `${worlds} ${events}${people.length ? ` Saved people views: ${people.join("; ")}.` : ""}`;
  };
  const worlds = sense(
    "worlds",
    "Fresh read of existing local Worlds, saved people views and upcoming gatherings. A World may hold people with no upcoming gathering. Use this before choosing or creating a World, and read it again after a diver may have saved people work.",
    readWorlds,
    { fresh: true },
  );

  if (!gathering) {
    return {
      tools: { worlds },
      async warm() {
        const summary = await readWorlds();
        return {
          look: summary,
          rank: "No gathering is focused, so no room or guest ranking has been assumed.",
        };
      },
    };
  }

  const readLook = async (): Promise<string> => {
    const s = await look(world, gathering.id);
    return `Room "${s.gatheringName}" (${pt(s.gatheringDate)}): ${s.totalGuests} on the list, ${s.returning} returning, ${s.awaiting} awaiting a yes, ${s.landed} confirmed.`;
  };
  const readRank = async (): Promise<string> => {
    const r = await rank(world, gathering.id);
    return `Returning regulars by loyalty: ${r.map((g) => `${g.firstName} (${g.loyalty}${g.hasEmail ? "" : ", no email"})`).join(", ")}.`;
  };

  return {
    tools: {
      worlds,
      look: sense("look", "Room counts: on the list, returning, awaiting a yes, confirmed.", readLook),
      rank: sense("rank", "Returning regulars ranked by loyalty (past dinners attended).", readRank),
      queue: sense("queue", "The draft queue: proposed, awaiting a yes, approved, landed.", async () => {
        const q = deriveQueue(world, gathering.id);
        return `Draft queue: ${q.counts.proposed.count} proposed, ${q.counts.queued.count} awaiting a yes, ${q.counts.approved.count} approved, ${q.counts.landed.count} landed.`;
      }),
      roster: sense("roster", "Every guest row: name, rsvp state, returning or not.", async () => {
        const r = deriveRoom(world, gathering.id);
        const rows = r.guests.map((g) => {
          const first = g.name.replace(/\s*\([^)]*\)\s*$/, "").trim().split(/\s+/)[0] || g.name;
          return `${first} (${g.rsvp}${g.returning ? ", returning" : ", NOT returning"})`;
        });
        return `Roster, all ${rows.length}: ${rows.join(", ")}.`;
      }),
      history: sense(
        "history",
        "Per-person attendance: which past gatherings each guest came to, by name and date.",
        async () => {
          const byId = new Map(world.gatherings.map((g) => [g.id, g]));
          const attended = new Map<string, string[]>();
          for (const e of world.entries) {
            if (e.context !== gathering.context || e.type !== "fact" || e.subtype !== "attendance") continue;
            const g = e.about !== undefined ? byId.get(e.about) : undefined;
            if (!g) continue;
            for (const p of e.persons ?? []) {
              const rec = world.persons.find((x) => x.id === p);
              const first = (rec?.name ?? p).replace(/\s*\([^)]*\)\s*$/, "").trim().split(/\s+/)[0];
              const list = attended.get(first) ?? [];
              list.push(`${g.name} (${pt(g.date)})`);
              attended.set(first, list);
            }
          }
          const lines = [...attended.entries()].map(([first, evs]) => `${first}: ${evs.join(", ")}`);
          return `Attendance history, per person: ${lines.join("; ")}.`;
        },
      ),
    },
    async warm() {
      const [l, r] = [await readLook(), await readRank()];
      ran.set("look", l);
      ran.set("rank", r);
      return { look: l, rank: r };
    },
  };
}
