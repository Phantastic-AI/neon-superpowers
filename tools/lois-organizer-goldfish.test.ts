import { describe, expect, it } from "vitest";
import {
  evaluateOrganizerConversation,
  evaluateOrganizerPage,
} from "../packages/lois/organizer-goldfish.js";
import type { LoisModel } from "../packages/lois/model.js";

function fakeModel(reply: string): LoisModel {
  return {
    model: "test/model",
    complete: async () => reply,
    respondToWave: async () => [],
  };
}

describe("organizer conversation goldfish", () => {
  it("accepts one strict fresh-reader verdict", async () => {
    const verdict = await evaluateOrganizerConversation(
      fakeModel(JSON.stringify({
        job: "Invite Maya to 3Cs in a local rehearsal",
        lois_was_sane: true,
        browser_consent_respected: true,
        no_real_send: true,
        one_thing_at_a_time: true,
        instruction_fidelity: true,
        corrections_clear: true,
        missing: [],
        verdict: "swims",
      })),
      "organizer: please rehearse locally\nLois: I will wait for consent",
    );
    expect(verdict).toMatchObject({ verdict: "swims", missing: [] });
  });

  it("refuses an unstructured or incomplete opinion", async () => {
    await expect(
      evaluateOrganizerConversation(fakeModel('{"verdict":"swims"}'), "a transcript"),
    ).rejects.toThrow(/invalid evidence/i);
  });

  it("gives a fresh page fish the screenshot rather than a transcript substitute", async () => {
    let seenImages: { data: Uint8Array; mediaType: string }[] | undefined;
    const visualModel: LoisModel = {
      model: "test/model",
      complete: async (input) => {
        seenImages = input.images;
        return JSON.stringify({
          job: "Inspect 3Cs in the embedded browser",
          visible_state: "Lois reported the guest list and the browser is visible.",
          next_step: "Answer Lois's one question.",
          lois_was_sane: true,
          browser_state_clear: true,
          choices_visible: 1,
          confusing: [],
          verdict: "swims",
        });
      },
      respondToWave: async () => [],
    };
    const pixels = new Uint8Array([137, 80, 78, 71]);
    const verdict = await evaluateOrganizerPage(visualModel, pixels, "inspect without sending");

    expect(verdict).toMatchObject({ verdict: "swims", choices_visible: 1 });
    expect(seenImages).toEqual([{ data: pixels, mediaType: "image/png" }]);
  });
});
