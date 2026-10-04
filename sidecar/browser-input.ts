import {
  diveInput,
  type BrowserInput,
  type BrowserInputResult,
} from "../tools/lois-dive.js";

type PaneInput = (input: BrowserInput, owner: "pane") => Promise<BrowserInputResult>;

const MAX_KEY_LENGTH = 128;
const MAX_TEXT_LENGTH = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

export function parseBrowserInput(raw: string): BrowserInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return null;

  if (parsed.type === "click") {
    if (!hasOnlyKeys(parsed, ["type", "nx", "ny"])) return null;
    if (typeof parsed.nx !== "number" || typeof parsed.ny !== "number") return null;
    if (!Number.isFinite(parsed.nx) || !Number.isFinite(parsed.ny)) return null;
    if (parsed.nx < 0 || parsed.nx > 1 || parsed.ny < 0 || parsed.ny > 1) return null;
    return { type: "click", nx: parsed.nx, ny: parsed.ny };
  }

  if (parsed.type === "key") {
    if (!hasOnlyKeys(parsed, ["type", "key"])) return null;
    if (typeof parsed.key !== "string" || parsed.key.length < 1 || parsed.key.length > MAX_KEY_LENGTH) {
      return null;
    }
    return { type: "key", key: parsed.key };
  }

  if (parsed.type === "text") {
    if (!hasOnlyKeys(parsed, ["type", "text"])) return null;
    if (
      typeof parsed.text !== "string" ||
      parsed.text.length < 1 ||
      parsed.text.length > MAX_TEXT_LENGTH
    ) {
      return null;
    }
    return { type: "text", text: parsed.text };
  }

  return null;
}

export interface BrowserInputHttpResponse {
  status: number;
  payload: BrowserInputResult;
}

export async function handleBrowserInput(
  raw: string,
  dispatch: PaneInput = diveInput,
): Promise<BrowserInputHttpResponse> {
  const input = parseBrowserInput(raw);
  if (!input) {
    return { status: 400, payload: { ok: false, note: "Invalid browser input." } };
  }

  try {
    const result = await dispatch(input, "pane");
    return { status: result.ok ? 200 : 409, payload: result };
  } catch {
    return { status: 502, payload: { ok: false, note: "Browser input failed." } };
  }
}
