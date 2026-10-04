import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  optionLabel,
  refOnLine,
  resolveCapabilitySmokeConfig,
} from "./lois-capability-smoke.js";

const OBSERVATION = `Observation obs-1
Page: 3Cs
URL: http://127.0.0.1:4321/event/3cs
- textbox "Invitation note" [ref=e21]
- listbox "People" [ref=e10]:
  - option "Maya Chen — Joined the last two gatherings" [ref=e11]`;

describe("3Cs capability smoke runner", () => {
  it("uses committed contracts and run-owned temporary state", () => {
    const repo = resolve("/workspace/superpowers-app");

    expect(resolveCapabilitySmokeConfig(repo)).toEqual({
      repo,
      baseDir: resolve(tmpdir(), "superpowers-capability-runs"),
      seedVaultDir: resolve(repo, "tools/seed-world/out"),
      artifactPaths: {
        contract: resolve(repo, "docs/browser-experience-contract.md"),
        prd: resolve(repo, "docs/3cs-browser-goldfish-smoke.md"),
        testSpec: resolve(repo, "docs/3cs-browser-goldfish-test-spec.md"),
      },
    });
  });

  it("derives controls from the semantic observation instead of fixture selectors", () => {
    expect(refOnLine(OBSERVATION, "Invitation note")).toBe("e21");
    expect(refOnLine(OBSERVATION, "People")).toBe("e10");
    expect(optionLabel(OBSERVATION, "Maya Chen")).toBe("Maya Chen — Joined the last two gatherings");
  });

  it("fails honestly when the requested semantic control is absent", () => {
    expect(() => refOnLine(OBSERVATION, "Send invitations")).toThrow("No semantic ref found");
    expect(() => optionLabel(OBSERVATION, "Idris Bello")).toThrow("No visible option label found");
  });
});
