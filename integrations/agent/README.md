# Local Neon Mastra runtime

This package creates an actual `@mastra/core` Agent with persistent Mastra memory and workflow snapshots. The model uses Mastra's built-in OpenAI-compatible provider, `api: "chat"`, and the Neon bare branch host plus `/v1`. It streams through the official `@ag-ui/mastra` adapter and `@ag-ui/encoder`, which Assistant UI can consume using its AG-UI runtime.

## Sidecar wiring

```ts
import { z } from "zod";
import { createLocalNeonAgentRuntime, readNeonAgentConfig } from "./integrations/agent/index.ts";

const runtime = await createLocalNeonAgentRuntime({
  config: readNeonAgentConfig(process.env),
  dataDirectory: ".local/agent",
  resourceId: "local-owner", // trusted server scope, never supplied by browser
  instructions: originalSystemInstructions,
  tools: [{
    id: "inspectGoal",
    description: "Inspect a goal through the original capability",
    inputSchema: z.object({ goalId: z.string() }),
    requiresApproval: false,
    execute: (input, context) => originalInspectGoal(input, context),
  }],
});
// After sidecar authentication/origin checks:
const response = await runtime.handleRun(request);
const review = await runtime.pending(threadId); // native Interrupt metadata.mastra has toolName/args
const snapshot = await runtime.snapshot(threadId); // GET returns {messages,pending,state,status,runIds}
runtime.cancel(threadId);
```

The example names denote the parent's original implementations; this package does not invent those capabilities. Every side effect must use `requiresApproval: true`; the parent's domain authorization and durable approved-send ledger remain necessary inside the injected function.

POST a standard `RunAgentInput`. Use `resume: [{ interruptId, status: "resolved", payload: { approved: true | false } }]` or `status: "cancelled"`. Approval is persisted before its interrupt reaches the browser. The official frontend can submit all open decisions in one `resume` array; every entry is validated first, then the single-entry native adapter is called sequentially under one HTTP lifecycle. Native Mastra currently reveals two tool approvals one at a time; the native regression explicitly approves the first and declines the second. Unknown, stale, cross-thread, repeated, malformed, or bypassed approvals fail before the adapter runs. Client executable tools and forwarded commands are disabled. Caller system/assistant/tool history and caller shared state do not override authoritative server memory/state. The handler runs in a fixed resource scope. Cancellation aborts the official adapter's underlying generation and propagates its signal to capabilities.

`createNeonAgentRuntime` accepts a `MastraCompositeStore` and atomic `ThreadStateStore` for alternate persistence. `createLocalNeonAgentRuntime` supplies LibSQL `file:` storage and an atomic per-thread JSON store using filesystem locks. Do not share a live data directory with any other agent implementation. Abandoned file locks and running records fail closed after abrupt process death: stop all sidecar processes before explicit recovery. Clean approval interruption/reconstruction is covered by tests. Transcript/state snapshots use the official AG-UI reducer and are restored by the parent UI through its standard message repository; expose `snapshot(threadId)` on the authenticated thread GET route.

## Verification

`pnpm --filter @neon-superpowers/agent test` and `typecheck` are offline. A fake gateway replaces global fetch in the native Mastra tests; no API key or model request is made. Sixteen tests cover original injected output, gateway dialect, native approval, rejection, durable resume after runtime reconstruction, two sequential native approvals, stale/cross-thread replay, cancellation, file-store concurrency, batch prevalidation, transcript restoration, and SSE lifecycle. Batch sequencing is additionally covered by a transport fixture; native Mastra produces one current approval per step. This is SDK and local protocol proof, not paid/live/provider or browser end-to-end proof.

`ag-ui-compat.ts` normalizes two new native Mastra chunks for the pinned adapter: denial becomes a tool result with the actual approval decision, and the internal resume marker is ignored. Mastra retains execution/snapshot ownership. Remove it only when the denial regression passes against an adapter with native support.

## Official references checked 2026-10-04

- [Neon Chat Completions](https://neon.com/docs/ai-gateway/chat-completions) — `/v1` and canonical `NEON_AI_GATEWAY_TOKEN` (`NEON_AI_GATEWAY_API_KEY` is an accepted local alias).
- [AG-UI Mastra integration source and docs](https://github.com/ag-ui-protocol/ag-ui/tree/main/integrations/mastra/typescript) — local adapter, approval interrupts, persistent snapshots, standard resume.
- [Mastra agent docs](https://mastra.ai/docs/agents/overview) and the pinned published SDK declarations — actual Agent/tool/model/storage interfaces.

No live model ID fallback is chosen. The parent must validate `NEON_MODEL` against its actual gateway catalog and supply credentials.
