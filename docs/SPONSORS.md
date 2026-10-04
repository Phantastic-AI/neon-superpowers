# Sponsor implementation and evidence

Status at October 4, 2026: implementations and offline verification are present. **No live sponsor contribution is claimed by this document.** Live readiness and a successful useful call are separate facts. Record actual invocation output, resource scope and receipt before changing a row to live verified.

| Sponsor / component | Implemented contribution | Offline evidence | Live status / remaining prerequisite |
| --- | --- | --- | --- |
| Neon inference | OpenAI-compatible gateway model in the actual Mastra agent; server-side model selection | Fake-gateway native agent and SSE/runtime tests | Unverified; exact branch host, gateway token and real catalog model required |
| Neon Postgres | Parameterized insert of 1–20 explicitly selected events; separate approved dedicated-table preparation | Remote adapter approval/selected-payload tests; exact SDK typecheck | Unverified; dedicated URL must match configured hostname/database scope; table must be prepared |
| Mastra | Actual Agent, tools, memory and persistent workflow/snapshot ownership | Native runtime approval, denial, resume, cancellation and storage tests | Real model-backed behavior and browser end-to-end unverified |
| AG-UI | Official Mastra adapter and streamed run/resume protocol | SDK transport, interrupt and SSE tests | Integrated in app; live conversation/browser acceptance unverified |
| Assistant UI | Conversation within the original World/Post-it workspace; native interrupt review | Source integration and face test coverage | Literal browser continuity and complete visual review still required |
| Composio | Selected-account Gmail read/send and bounded personal-calendar reads through authenticated proxy | Mocked pinned SDK wire formats, account scope, approval and retry tests | Unverified; narrowly scoped OAuth account connection required |
| AgentMail | Agent-owned inbox provisioning/read, exact approved send and actual reply reads | Mocked SDK wire formats, inbox scope and approval tests | Unverified; verified account, configured inbox and controlled recipient required |
| Exa | Anchored identity/signal enrichment with citations and withheld unknown fields | Synthetic Python transport/evidence/cache/retry tests | Unverified; one bounded approved anchored public profile call required |
| Kernel | Disposable cloud browser reads one allowed public HTTPS host, returns bounded text, deletes session | Injected browser tests and exact SDK declaration check | Unverified; key plus explicit host allowlist required |
| Sprites | Python guest CSV normalization/deduplication via explicit executable and argv | Actual offline Python computation, literal argument regression, SDK check | Unverified; token, dedicated pre-provisioned guest and Node >=24 required |
| Executor | Organization-scoped MCP research discovery; only exact reviewed allowlisted tool paths can execute | Mocked MCP calls, immutable approval snapshot regression, SDK check | Unverified; exact MCP URL, scoped token/org and actual tool discovery required; no invented default tool |
| CodeRabbit | Intended independent source review on the public repository | Read-only GitHub inspection only | Availability unknown; no genuine CodeRabbit review obtained yet |

## Source locations

The server capabilities are in `sidecar/neon/capabilities.ts`, conversation runtime in `integrations/agent/`, account connectors in `integrations/connectors/`, Exa module in `integrations/enrichment/`, remote sponsors in `integrations/remote-tools/`, and the preserved app integration in `apps/face/src/neon/launch.ts` and `apps/face/src/hg/people-workspace.ts`.

Local-first describes local vault and persisted state ownership; inference runs through the remote Neon AI Gateway and selected model. Conversation and tool results can include local people/notes and connected mail/calendar content. Read results can enter model context without a separate native approval, and context is not individually reviewed before each model request. Scoped remote-action and send approvals do not change this inference boundary.

Receipts must report real provider outcomes. Remote adapter cost is explicitly unknown unless the provider supplies reconciled cost information. Exa retains provider-reported costs and uncertain billing on partial failures. Model and tool availability must not be displayed as successful sponsor usage.

## CodeRabbit availability check

Read-only GitHub API inspection confirmed `Phantastic-AI/neon-superpowers` is public with default branch `main`. Visible HEAD check runs and issue comments contained no CodeRabbit evidence. Listing visible user installations returned HTTP 403 because the token is not GitHub-App-authorized. These observations **do not prove that CodeRabbit is absent**.

A repository administrator must inspect installed GitHub Apps and repository access if the next authorized PR cannot request a review. If access is absent, a separately approved CodeRabbit GitHub App installation/selected-repository grant is needed. No app permissions were installed or granted here; no PR or push was performed. A local review, a config file or a sponsor logo is not a genuine CodeRabbit review. After source review is green and publication is authorized, preserve the actual CodeRabbit review URL and addressed findings as submission evidence.

## Submission evidence to collect

Public MIT repository URL; reproducible Node >=26.10.0 quickstart; synthetic demo recording preserving Worlds, source disclosures, ordering and Post-its; actual useful sponsor receipts; controlled invitation/reply evidence; final test/build results; genuine CodeRabbit review link. Keep credentials, private vaults, raw personal mail and provider account identifiers out of the public packet. Portal submission remains a separate authorized action.
