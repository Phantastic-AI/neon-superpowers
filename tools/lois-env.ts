// tools/lois-env — resolve Lois's model from the repo-root .env FILE (node side).
//
// The FILE is the source of truth, ambient env is never consulted, so a stale
// shell OPENROUTER_API_KEY can never shadow the app's key (the bug this pattern
// fixed on 2026-08-28). The key stays server-side; nothing here is importable by
// the face bundle. Returns null when no key exists — the system reports a
// missing brain honestly (D-113), it never mimes one.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOpenRouterLoisModel,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  type LoisModel,
  type OpenRouterConfig,
} from "../packages/lois/model.js";

export interface ResolvedLoisRuntimeModel {
  model: LoisModel;
  modelId: string;
  baseUrl: string;
  reasoning?: OpenRouterConfig["reasoning"];
  endpointsUrl: string;
  fetchEndpoints(fetchImpl?: typeof fetch): Promise<Response>;
}

export interface LoisRuntimePricingCap {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export function openRouterModelEndpointsUrl(
  modelId: string,
  baseUrl: string = DEFAULT_BASE_URL,
): string {
  const parts = modelId.split("/");
  if (parts.length !== 2 || parts.some((part) => !part.trim())) {
    throw new Error("OpenRouter model identity must be an exact author/slug pair.");
  }
  return `${baseUrl.replace(/\/+$/, "")}/models/${parts.map(encodeURIComponent).join("/")}/endpoints`;
}

/** Resolve the adapter plus non-secret identity needed by paid-run evidence. */
export function resolveLoisRuntimeModel(
  pricingCap?: LoisRuntimePricingCap,
  providerRouting?: OpenRouterConfig["providerRouting"],
): ResolvedLoisRuntimeModel | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(resolve(here, "..", ".env"), "utf8");
    const env: Record<string, string> = {};
    for (const line of text.split("\n")) {
      if (/^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    if (!env.OPENROUTER_API_KEY) return null;
    const modelId = env.LOIS_MODEL || DEFAULT_MODEL;
    const baseUrl = env.LOIS_MODEL_BASE_URL || DEFAULT_BASE_URL;
    const endpointsUrl = openRouterModelEndpointsUrl(modelId, baseUrl);
    const reasoning = (["off", "minimal", "low", "medium", "high"] as const).find(
      (value) => value === env.LOIS_REASONING,
    );
    return {
      model: createOpenRouterLoisModel({
        apiKey: env.OPENROUTER_API_KEY,
        baseUrl,
        model: modelId,
        reasoning,
        providerRouting,
        maxPriceUsdPerMillion: pricingCap
          ? {
              prompt: pricingCap.inputUsdPerMillion,
              completion: pricingCap.outputUsdPerMillion,
            }
          : undefined,
      }),
      modelId,
      baseUrl,
      reasoning,
      endpointsUrl,
      fetchEndpoints: (fetchImpl = fetch) =>
        fetchImpl(endpointsUrl, {
          headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
          signal: AbortSignal.timeout(10_000),
        }),
    };
  } catch {
    return null;
  }
}

export function resolveLoisModel(): LoisModel | null {
  return resolveLoisRuntimeModel()?.model ?? null;
}
