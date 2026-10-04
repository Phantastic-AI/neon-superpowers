import { describe, expect, it, vi } from "vitest";
import { goldfishSchool } from "../packages/lois/goldfish.js";
import type { LoisModel } from "../packages/lois/model.js";
import { Trace } from "../packages/lois/trace.js";
import type { World } from "./projections/types.js";

const world: World = {
  contexts: [
    { id: "3cs", name: "3Cs", kind: "social", anchor: "email", profile: "luma", created_at: "2026-08-01T00:00:00Z" },
  ],
  gatherings: [
    { id: "3cs-1", context: "3cs", name: "3Cs #1", date: "2026-07-01T18:30:00Z", upcoming: false },
    { id: "3cs-next", context: "3cs", name: "3Cs Dinner", date: "2026-09-17T18:30:00Z", upcoming: true },
  ],
  persons: [
    {
      id: "maya",
      name: "Maya Chen",
      anchors: [{ kind: "email", value: "maya@example.test", verified: true, context: "3cs" }],
      merged: [],
      sighted_at: "2026-07-01T00:00:00Z",
      state: "active",
    },
  ],
  entries: [
    {
      id: "attendance-maya",
      cursor: 0,
      at: "2026-07-02T00:00:00Z",
      context: "3cs",
      type: "fact",
      subtype: "attendance",
      actor: { kind: "app", ref: "luma" },
      persons: ["maya"],
      about: "3cs-1",
      payload: { attended: true },
    },
  ],
};

function model(complete: LoisModel["complete"]): LoisModel {
  return { model: {} as never, complete, respondToWave: async () => [] };
}

describe("goldfish smoke selection", () => {
  it("keeps the product default of recipient plus stranger", async () => {
    const complete = vi.fn<LoisModel["complete"]>().mockResolvedValue('{"verdict":"swims","assumed":[]}');
    const agent = goldfishSchool(model(complete));
    const trace = new Trace();
    const event = trace.append({
      actor: "lois",
      kind: "proposed",
      label: "draft for Maya",
      detail: { kind: "draft", to: "Maya", body: "Dinner is Thursday at 6:30. Reply yes for a seat.", digest: "draft-1" },
    });

    await agent.run({ world, trace }, event);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("allows the smoke to spend exactly one fresh read on its selected recipient", async () => {
    const complete = vi.fn<LoisModel["complete"]>().mockResolvedValue('{"verdict":"swims","assumed":[]}');
    const agent = goldfishSchool(model(complete), {
      readers: "recipient-only",
      recipient: "Maya",
      maxReads: 1,
    });
    const trace = new Trace();
    const maya = trace.append({
      actor: "lois",
      kind: "proposed",
      label: "draft for Maya",
      detail: { kind: "draft", to: "Maya", body: "Dinner is Thursday at 6:30. Reply yes for a seat.", digest: "draft-1" },
    });
    const other = trace.append({
      actor: "lois",
      kind: "proposed",
      label: "draft for Idris",
      detail: { kind: "draft", to: "Idris", body: "Another draft.", digest: "draft-2" },
    });

    expect(agent.triggersOn(maya)).toBe(true);
    expect(agent.triggersOn(other)).toBe(false);
    await agent.run({ world, trace }, maya);
    await agent.run({ world, trace }, maya);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(trace.all().filter((event) => event.actor === "goldfish" && /recipient/.test(event.label))).toHaveLength(1);
  });
});
