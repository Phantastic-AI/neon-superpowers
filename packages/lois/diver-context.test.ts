import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { retainDiverMessages } from "./diver-context.js";
import { publicDiverJob, parseDiverJob } from "./diver.js";
import { createBackgroundDiver } from "../../sidecar/background-diver.js";

const exchange = (id: string, text: string): ModelMessage[] => [
  { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: {} }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "read", output: { type: "text", value: text } }] },
];

describe("private diver context", () => {
  it("evicts whole old tool exchanges with an explicit notice, without clipping retained results", () => {
    const latest = exchange("latest", "artifact-new: complete header/sample");
    const retained = retainDiverMessages([...exchange("old", "x".repeat(2000)), ...latest], 1000);
    expect(retained.slice(1)).toEqual(latest);
    expect(JSON.stringify(retained[0])).toContain("Older diver working context was omitted");
    expect(JSON.stringify(retained).length).toBeLessThan(1000);
    expect(retainDiverMessages(latest)).toEqual(latest);
  });

  it("omits an oversized exchange rather than retaining an orphan call or fake clipped evidence", () => {
    const retained = retainDiverMessages(exchange("large", "x".repeat(2000)), 1000);
    expect(retained).toHaveLength(1);
    expect(retained[0].role).toBe("system");
  });

  it("keeps private context out of all background status and launch receipts", async () => {
    const job = parseDiverJob({ version: 1, id: "294a3ece-dd73-411f-ba4b-46152032d688", intent: "Read",
      status: "partial", createdAt: 1, updatedAt: 1, workingMessages: exchange("private", "private@example.test") })!;
    expect(job).not.toBeNull();
    expect(publicDiverJob(job)).not.toHaveProperty("workingMessages");
    const background = createBackgroundDiver({ store: { load: () => job, save: () => {} },
      run: async (_input, context) => { context?.onStarted?.(job); return "partial"; }, onDeliveryError: () => {} });
    expect(JSON.stringify(background.status())).not.toContain("private@example.test");
    expect(await background.start({ intent: "Continue" })).not.toContain("private@example.test");
    await background.idle();
    expect(parseDiverJob({ ...publicDiverJob(job) })).not.toBeNull();
  });
});
