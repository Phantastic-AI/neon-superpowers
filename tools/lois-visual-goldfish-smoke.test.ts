import { describe, expect, it } from "vitest";
import {
  isDirectVisualGoldfishSmoke,
  runVisualGoldfishSmoke,
  VISUAL_BROWSER_INSPECTION_PROMPT,
} from "./lois-visual-goldfish-smoke.js";

describe("whole-page organizer goldfish entry boundary", () => {
  it("does not ignite merely because another module imports it", () => {
    const cli = "file:///repo/tools/lois-visual-goldfish-smoke.ts";
    expect(isDirectVisualGoldfishSmoke(cli, ["node", "/repo/tools/lois-visual-goldfish-smoke.test.ts"]))
      .toBe(false);
    expect(isDirectVisualGoldfishSmoke(cli, ["node", "/repo/tools/lois-visual-goldfish-smoke.ts"]))
      .toBe(true);
  });

  it("stays cold without the shared paid gate", async () => {
    await expect(runVisualGoldfishSmoke([])).rejects.toThrow(/explicit --approve-paid authorization/i);
  });

  it("asks the visual swim to report the page the fixture actually provides", () => {
    expect(VISUAL_BROWSER_INSPECTION_PROMPT).toContain("what is actually on that page");
    expect(VISUAL_BROWSER_INSPECTION_PROMPT).toContain("Nothing sends");
  });
});
