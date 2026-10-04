# Local agent runtime slice

Implement an actual Mastra agent using Neon Chat Completions and the official AG-UI adapter/encoder. Scope is this package only. Inject original capability implementations, persistent Mastra storage, and an atomic thread-state store; never implement substitute business logic. Reject unknown, stale, cross-thread, repeated, or malformed approval continuations. Cancel the underlying model on HTTP disconnect. Tests run offline and must not call a paid model or mutate an external application.

Acceptance: official AG-UI lifecycle and tool result SSE; persisted state selected server-side; repeat and stale resumes rejected before execution; decline reaches Mastra; approval-gated capabilities preserve their original results; cancellation propagates. Verify with package test and TypeScript. Stop at a package the parent can wire to its sidecar. Parent owns root deps, capabilities, model credentials, durable adapters, and UI.
