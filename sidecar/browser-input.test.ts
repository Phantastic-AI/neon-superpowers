import { describe, expect, it, vi } from "vitest";
import { handleBrowserInput } from "./browser-input.js";

describe("sidecar browser input boundary", () => {
  it.each([
    ["invalid JSON", "{"],
    ["an unknown input type", JSON.stringify({ type: "drag", nx: 0.5, ny: 0.5 })],
    ["a click outside the normalized viewport", JSON.stringify({ type: "click", nx: -0.1, ny: 1.1 })],
    ["non-finite click coordinates", JSON.stringify({ type: "click", nx: "NaN", ny: 0.5 })],
    ["an empty key", JSON.stringify({ type: "key", key: "" })],
    ["an oversized key", JSON.stringify({ type: "key", key: "k".repeat(129) })],
    ["empty text", JSON.stringify({ type: "text", text: "" })],
    ["oversized text", JSON.stringify({ type: "text", text: "x".repeat(10_001) })],
  ])("returns 400 without dispatching for %s", async (_label, raw) => {
    const dispatch = vi.fn();

    const response = await handleBrowserInput(raw, dispatch);

    expect(response).toEqual({
      status: 400,
      payload: { ok: false, note: "Invalid browser input." },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { type: "click", nx: 0, ny: 1 },
    { type: "key", key: "Enter" },
    { type: "text", text: "hello, garden" },
  ])("dispatches a valid $type input to the pane owner", async (input) => {
    const dispatch = vi.fn(async () => ({ ok: true, note: "accepted" }));

    const response = await handleBrowserInput(JSON.stringify(input), dispatch);

    expect(response).toEqual({ status: 200, payload: { ok: true, note: "accepted" } });
    expect(dispatch).toHaveBeenCalledWith(input, "pane");
  });

  it("returns a non-success response when the browser lease refuses pane input", async () => {
    const response = await handleBrowserInput(
      JSON.stringify({ type: "click", nx: 0.5, ny: 0.5 }),
      async () => ({
        ok: false,
        note: "Browser input is locked while control is foreground_hands.",
      }),
    );

    expect(response).toEqual({
      status: 409,
      payload: {
        ok: false,
        note: "Browser input is locked while control is foreground_hands.",
      },
    });
  });
});
