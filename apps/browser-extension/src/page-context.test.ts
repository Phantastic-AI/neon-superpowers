import { describe, expect, it } from "vitest";
import {
  chooseVisibleText,
  normalizeVisibleText,
  serializePageContext,
  stringifyPageContext,
  truncateVisibleText
} from "./page-context";

describe("page context serialization", () => {
  it("normalizes whitespace without flattening paragraph boundaries", () => {
    expect(normalizeVisibleText("  One\t\tline\n\n\n  Two\u00a0words  ")).toBe("One line\n\nTwo words");
  });

  it("prefers a non-empty selection over body text", () => {
    expect(
      chooseVisibleText({
        selectionText: " selected text ",
        bodyText: "body text"
      })
    ).toBe("selected text");
  });

  it("falls back to body text when selection is blank", () => {
    expect(
      chooseVisibleText({
        selectionText: "  \n ",
        bodyText: " body text "
      })
    ).toBe("body text");
  });

  it("serializes the active page snapshot into stable import JSON fields", () => {
    const context = serializePageContext(
      {
        url: " https://example.invalid/path ",
        title: " Example   Page ",
        selectionText: "",
        bodyText: " Visible\ttext ",
        screenshotDataUrl: "data:image/png;base64,abc"
      },
      new Date("2026-05-14T07:08:09.000Z")
    );

    expect(context).toEqual({
      url: "https://example.invalid/path",
      title: "Example Page",
      visibleText: "Visible text",
      screenshotDataUrl: "data:image/png;base64,abc",
      capturedAt: "2026-05-14T07:08:09.000Z"
    });
    expect(JSON.parse(stringifyPageContext(context))).toEqual(context);
  });

  it("truncates long visible text with an ellipsis", () => {
    expect(truncateVisibleText("abcdef", 3)).toBe("abc…");
  });
});
