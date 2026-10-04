import { describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import { createLoisModel } from "./model.js";

describe("Lois model adapter", () => {
  it("turns the structured-call flag into a provider JSON response format", async () => {
    const doGenerate = vi.fn(async (_options: unknown) => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
      warnings: [],
    }));
    const raw = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "structured-test",
      supportedUrls: {},
      doGenerate,
      doStream: vi.fn(),
    } as unknown as LanguageModel;

    const reply = await createLoisModel(raw).complete({
      system: "Return JSON.",
      user: "Say ok.",
      json: true,
    });

    expect(reply).toBe('{"ok":true}');
    expect(doGenerate.mock.calls[0]?.[0]).toMatchObject({ responseFormat: { type: "json" } });
  });
});
