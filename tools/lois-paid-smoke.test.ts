import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { __modelTest } from "../packages/lois/model.js";
import { rank } from "../packages/lois/tools.js";
import { loadVaultWorld } from "../sidecar/vault.js";
import {
  __paidSmokeEvidenceTest,
  assertPaidSmokeAuthorization,
  isDirectPaidSmoke,
  parsePaidSmokeCli,
  verifyPaidSmokePricing,
} from "./lois-paid-smoke.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-08-29T12:00:00.000Z");
const PRICING = [
  "--model", "z-ai/glm-5.3-flash",
  "--input-usd-per-million", "0.075",
  "--output-usd-per-million", "0.25",
  "--pricing-source", "https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints",
  "--pricing-checked-at", "2026-08-29T11:30:00.000Z",
];

describe("paid 3Cs smoke cold gate", () => {
  it("shows the fresh organizer reader the complete visible draft card", () => {
    const transcript = __paidSmokeEvidenceTest.conversationForFreshReader([{
      id: "turn-3",
      organizer: "Draft one note for Maya and omit the signature.",
      lois: "The draft is ready.",
      tools: [],
      visibleProposals: [JSON.stringify({
        kind: "draft",
        to: "Maya",
        subject: "Dinner",
        body: "Can you come?\n\nSigned anyway",
      })],
    }], "no receipt yet");

    expect(transcript).toContain("organizer-visible proposal");
    expect(transcript).toContain('"to":"Maya"');
    expect(transcript).toContain("Signed anyway");
  });

  it("refuses before any runner path can arm without explicit paid approval", () => {
    expect(() => parsePaidSmokeCli(PRICING, NOW)).toThrow(/cold.*approve-paid/i);
  });

  it("requires a fresh exact pricing plan and records the approved shape", () => {
    const options = parsePaidSmokeCli(["--approve-paid", "--run-id", "proof-1", ...PRICING], NOW);
    expect(options).toMatchObject({
      approved: true,
      runId: "proof-1",
      variant: "v2",
      inference: {
        model: "z-ai/glm-5.3-flash",
        defaultMaxOutputTokens: 1_200,
        pricing: {
          inputUsdPerMillion: 0.075,
          outputUsdPerMillion: 0.25,
          checkedAt: "2026-08-29T11:30:00.000Z",
        },
      },
    });
    expect(() => assertPaidSmokeAuthorization(options, NOW)).not.toThrow();
    expect(parsePaidSmokeCli(["--", "--approve-paid", "--run-id", "proof-2", ...PRICING], NOW).runId).toBe("proof-2");
    expect(() =>
      assertPaidSmokeAuthorization({
        ...options,
        inference: {
          ...options.inference,
          pricing: { ...options.inference.pricing, checkedAt: "2026-08-27T11:30:00.000Z" },
        },
      }, NOW),
    ).toThrow(/last 24 hours/i);
    expect(() =>
      parsePaidSmokeCli([
        "--approve-paid",
        ...PRICING.slice(0, -1),
        "2026-08-27T11:30:00.000Z",
      ], NOW),
    ).toThrow(/last 24 hours/i);
  });

  it("does not execute when imported by a test or the app", () => {
    const cli = "file:///repo/tools/lois-paid-smoke.ts";
    expect(isDirectPaidSmoke(cli, ["node", "/repo/tools/lois-paid-smoke.test.ts"])).toBe(false);
    expect(isDirectPaidSmoke(cli, ["node", "/repo/tools/lois-paid-smoke.ts"])).toBe(true);
  });

  it("requires the official endpoint catalog for the exact approved model", () => {
    expect(() => parsePaidSmokeCli([
      "--approve-paid",
      ...PRICING.slice(0, 7),
      "https://example.test/pricing",
      ...PRICING.slice(8),
    ], NOW)).toThrow(/official endpoint catalog/i);
  });

  it("requires a live catalog endpoint inside the enforced approved ceiling", async () => {
    const options = parsePaidSmokeCli(["--approve-paid", "--run-id", "proof-1", ...PRICING], NOW);
    const source = options.inference.pricing.source;
    const fetchEndpoints = (fetchImpl: typeof fetch = fetch) => fetchImpl(source);
    const preflight = {
      repo: "/repo",
      head: "abc",
      resolvedModel: {
        model: {} as never,
        modelId: options.inference.model,
        baseUrl: "https://openrouter.ai/api/v1",
        endpointsUrl: source,
        fetchEndpoints,
      },
      artifactHashes: { contract: "a", prd: "b", testSpec: "c" },
    };
    const catalog = (
      prompt: string,
      completion: string,
      extraPricing: Record<string, unknown> = {},
    ) => new Response(JSON.stringify({
      data: {
        id: options.inference.model,
        endpoints: [{ pricing: { prompt, completion, request: "0", ...extraPricing } }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });

    await expect(verifyPaidSmokePricing(
      options,
      preflight,
      async () => catalog("0.000000075", "0.00000025"),
      NOW,
    )).resolves.toMatchObject({ eligibleEndpoints: 1, source });
    await expect(verifyPaidSmokePricing(
      options,
      preflight,
      async () => catalog("0.000000075", "0.00000025", {
        input_cache_read: "0.000000015",
        discount: 0.5,
      }),
      NOW,
    )).resolves.toMatchObject({ eligibleEndpoints: 1, source });
    await expect(verifyPaidSmokePricing(
      options,
      preflight,
      async () => catalog("0.000000075", "0.00000025", { input_cache_read: "0.0000001" }),
      NOW,
    )).rejects.toThrow(/no current OpenRouter endpoint fits/i);
    await expect(verifyPaidSmokePricing(
      options,
      preflight,
      async () => catalog("0.00000015", "0.0000005"),
      NOW,
    )).rejects.toThrow(/no current OpenRouter endpoint fits/i);
    await expect(verifyPaidSmokePricing(
      options,
      preflight,
      async () => catalog("0.000000075", "0.00000025", { internal_reasoning: "0.0000001" }),
      NOW,
    )).rejects.toThrow(/no current OpenRouter endpoint fits/i);
    await expect(verifyPaidSmokePricing(
      options,
      preflight,
      async () => catalog("0.000000075", "0.00000025", { overrides: [{ min_context: 4_000 }] }),
      NOW,
    )).rejects.toThrow(/no current OpenRouter endpoint fits/i);
  });

  it("sends the approved ceiling to OpenRouter as a hard per-request routing filter", () => {
    expect(__modelTest.openRouterExtraBody({
      apiKey: "not-a-real-key",
      model: "z-ai/glm-5.3-flash",
      reasoning: "minimal",
      maxPriceUsdPerMillion: { prompt: 0.075, completion: 0.25 },
    })).toEqual({
      reasoning: { effort: "minimal" },
      provider: {
        max_price: { prompt: 0.075, completion: 0.25, request: 0, image: 0 },
      },
    });
  });
});

describe("committed 3Cs smoke vault", () => {
  it("carries Maya twice, Idris once, and Samira as a first-timer", async () => {
    const world = loadVaultWorld(resolve(HERE, "fixtures", "3cs-smoke-vault"));
    expect(await rank(world, "3cs-next")).toEqual([
      expect.objectContaining({ firstName: "Maya", loyalty: 2 }),
      expect.objectContaining({ firstName: "Idris", loyalty: 1 }),
    ]);
    expect(world.persons.find((person) => person.id === "samira")?.name).toBe("Samira Noor");
  });
});
