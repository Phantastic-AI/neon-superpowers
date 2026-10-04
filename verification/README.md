# Neon acceptance checks

This is a small acceptance layer over the imported app, using Node's built-in
test runner. Its core adds no dependencies and includes no sibling evalkit source.
It carries the existing Lois distinction between capability and comprehension,
and its stateless whole-page PNG + tiny job brief reader shape.

Current status: deterministic component/HTTP/process checks and a bounded Neon
vision provider are runnable. The full rendered app journey adapter remains
unwired. Deterministic provider tests use a loopback HTTP server and canned
responses; they prove request/response handling, not actual model comprehension.
The explicit Goldfish CLI below can contact the configured provider after the
operator readiness marker is set; tests do not make live calls.

```sh
node --test verification/acceptance.test.mjs verification/goldfish.test.mjs verification/run.test.mjs
node verification/run.mjs
```

The second command deliberately reports `unverified` and exits 2. After wiring:

```sh
node verification/run.mjs --scenario verification/dinner.example.json --adapter ./path/to/app-adapter.mjs
```

The real approval-ledger process checks use the imported app's existing `tsx`
dependency and isolated local fixture dispatches:

```sh
node --test verification/ledger.integration.test.mjs
```

They prove cross-process duplicate reservation refusal, retention of successful
concurrent writes, and refusal to automatically retry a dispatch interrupted by
process death. They do not contact a provider or prove the full app journey.

The bounded component fixture uses the actual `ApprovalLedger`, `LaunchState`
and `createConnectors`, with an invented `.invalid` recipient and a local-only
AgentMail transport. It proves five approval cases against persisted component
records and records a hash of the actual sources tested:

```sh
node --test verification/*.test.mjs
node verification/run.mjs --scenario verification/dinner.example.json --adapter ./verification/approval-fixture.mjs
```

That CLI exits 2: the five gate cases pass, while the full journey, sponsors and
comprehension remain unverified. Component reopening checks storage persistence;
the separate child-process tests check process death and concurrency. This
fixture does not exercise HTTP/UI routes, run Mastra, research a shortlist, fetch
a provider reply, or assert live delivery. Its goal state and receipt counts are
normalized from actual local records; it cannot satisfy the full journey by
seeding a success report.

`service.integration.test.mjs` additionally exercises the actual loopback
`createNeonService`, actual local people capability tools, the imported people
vault and public HTTP routes, with only the delivery transport replaced. It
checks exact edited payload dispatch, invalid/stale approvals, receipt replay
and unknown outcomes through service reconstruction. A separate case reorders
people, saves a Post-it, submits its immutable pending wave, edits the current
note and verifies both versions after service restart. It does not simulate a
successful conversation reply or claim a rendered browser journey.

```sh
pnpm test:verification
```

Use the repository's pinned Node version. `pnpm test` includes workspace tests,
Vitest app/service tests and this Node acceptance suite as separate runners;
`pnpm typecheck` also checks the service entry point. Local HTTP tests listen
only on loopback and remove their disposable storage afterward. Startup tests
also seed a fresh disposable default vault and a custom path with spaces, then
exercise both real HTTP services against the same people workspace. They verify
Node env-file/preload ordering without using operator credentials.

For a wired full-journey adapter, use the concrete provider explicitly:

```sh
node --env-file-if-exists=.env.local verification/run.mjs --scenario verification/dinner.example.json --adapter ./path/to/app-adapter.mjs --provider ./verification/neon-goldfish-provider.mjs
```

`run.mjs` imports the adapter's `createAdapter({scenario})` and provider's
`createProvider()` exports. The included approval fixture does not capture PNGs;
adding a provider cannot promote that fixture into a rendered journey proof.
An independently captured actual whole-page PNG can be read on its own:

```sh
node --env-file-if-exists=.env.local verification/goldfish-page.mjs --png /absolute/path/review.png --brief "Organize a small dinner; review the selected guests and invitation."
```

The page CLI defaults to `neon-goldfish-provider.mjs`; `--provider` can select an
explicit trusted module exporting `createProvider()`. Its JSON report contains
only the comprehension verdict, capture path/hash and sanitized provider
metadata. Exit 0 is a passing page read; exit 1 is a failed read or missing
configuration. It does not assert capability acceptance or authorize a send.

The provider requires `NEON_AI_GATEWAY_TOKEN` (or its API-key alias), a bare
HTTPS `NEON_AI_GATEWAY_BASE_URL`, explicit `NEON_GOLDFISH_MODEL`, and the local
`.local/keys-ready` marker. It never falls back to `NEON_MODEL`; choose an
independent vision evaluator from the actual gateway catalog. Each read posts
one fresh system message and one user message containing only the tiny brief
and PNG data URL to `/v1/chat/completions`. No writer context, history, hidden
trace or tools are sent. Construction does not make requests.

Defaults: 30-second timeout, 2 calls per provider instance, 1,024 maximum output
tokens, no retries and no redirects. Trusted callers may configure these via
`createProvider({config:{apiKey,baseURL,model},timeoutMs,maxCalls,maxOutputTokens})`;
limits remain bounded at 60 seconds, 8 calls and 4,096 output tokens. The call
cap is per invocation; it is not an account-wide spend limit.

Sanitized requested/completed/failed records append to ignored
`.local/verification/goldfish-calls.jsonl`, with local operation/request IDs,
PNG/request hashes, selected/returned model identity, provider response IDs,
token usage and cost provenance. Tokens, image bytes, brief text and upstream
error bodies are not logged. Cost is credited only when the gateway returns
an actual numeric `usage.cost_usd`; missing cost and failed calls remain
`costUsd:null,costSource:"unknown"`. Tokens alone never imply zero cost or a
sponsor acceptance pass. Failure/truncation/refusal/malformed JSON cannot pass.

The request shape follows [OpenAI image-input documentation](https://developers.openai.com/api/docs/guides/images-vision#analyze-images)
and [JSON response guidance](https://developers.openai.com/api/docs/guides/structured-outputs#json-mode).
Gateway compatibility and the configured model's vision support still require
actual provider verification; mocked HTTP success does not establish them.

Exit 0 means every capability case and both comprehension reads passed. Exit 1
means a check failed; exit 2 means evidence or an integration is missing. There
is no average or combined numerical score. `accepted` belongs to the labeled
proof environment. Fixture success cannot become live proof; `liveAccepted`
stays false for fixture reports. The fault-injection case intentionally refuses
a live environment, so a live canary report by itself cannot claim the entire
fixture acceptance suite passed.

## Scope and acceptance cases

This acceptance layer does not publish evalkit, add an evaluation framework or
run paid/live browser calls during deterministic verification.
Full app wiring remains a separate integration boundary from the component
fixture.

Each case resets its **isolated disposable app** through the adapter. Never point
`reset` at the operator's existing vault, mailbox, or browser profile. The adapter
must use ordinary visible app actions (normal composer/UI or the same public
HTTP/AGUI path used by that UI), then inspect durable host-backed records. It
must not seed a success manifest, hardcode product replies, mutate private app
storage to create the expected outcome, or call a transport behind the app.

| Case | Observed acceptance |
| --- | --- |
| `full-journey` | Expected known people/prospects appear in a sourced shortlist; organizer steering is saved; exact reviewed draft reaches only the controlled demo recipient; reply source links to the send receipt; goal/proposal/selection/receipt/reply persist across restart. |
| `approval-no-send` | Pending proposal survives restart with zero delivery receipts. |
| `approval-edited` | Editing changes the version and payload digest; only the edited payload can produce the receipt. |
| `approval-stale` | Old approval after editing and restart leaves the current proposal pending and produces zero receipts. |
| `restart-idempotence` | Repeated approval after restart preserves one completed send and its original receipt. |
| `unknown-send-outcome` | Fixture transport loses the receipt after one attempted send; status stays unknown and restart/repeated approval cannot blindly dispatch again. |
| `sponsor-evidence` | Required sponsor IDs each have an observed operation ID, resolvable evidence ID, and measured/provider cost, including an explicit measured zero. Model operations also require model identity and provider token usage. |

Fixture IDs and expected outcomes live in the scenario, not in product prompts.
The example contains invented IDs and a non-deliverable recipient. A controlled
integration must resolve `scenario.recipient` from `NEON_DEMO_RECIPIENT`; never
substitute a real guest. The harness checks exact receipt recipient equality.
The scenario declares expected shortlist IDs and selected IDs independently of
the app's answers.

## App adapter contract

The module exports `createAdapter({scenario})`, returning
`{adapter, environment: {kind: 'fixture'|'live', revision: '<actual app revision>'}}`.
The adapter must independently check revision, disposable ownership and exact
recipient scope before starting. Only declare `live` for actual live integrations;
a real browser or real model against a platform/transport mock is still fixture
proof for that mocked boundary.

```js
const adapter = {
  reset: async ({caseId}) => {},
  startGoal: async goal => {},
  waitFor: async state => {}, // bounded wait for review or complete; fail on timeout
  steerSelection: async personIds => {},
  editProposal: async (proposalId, text) => {},
  approve: async ({proposalId, version, digest}) => {},
  restart: async () => {}, // actual host shutdown/start with the same isolated storage
  fetchReply: async receiptId => {},
  inspect: async () => state, // independently normalize actual host records; never expected scenario values
  readEvidence: async evidenceId => witness, // resolve actual source/receipt/usage artifacts
  capturePage: async ({id}) => ({png, evidenceId}), // actual rendered full-page PNG, saved by adapter
  induceUnknownSendOutcome: async approvalBinding => {}, // fixture-only controlled receipt-loss fault
  close: async () => {}, // drain jobs, close only owned resources
};
```

Expected rejection from stale/replayed approval should return normally after the
app reports its refusal; unexpected errors/timeouts fail the case. Throw the
exported `Unverified` error for unsupported capabilities; these never count pass.
Missing methods are automatically unverified.

`inspect()` returns observed normalized fields:

```js
{
  goal: {id, status: 'review'|'complete'},
  proposal: {id, version, digest, body, status: 'pending'|'approved'},
  shortlist: [{personId, rationale, evidenceIds: []}],
  selectedPersonIds: [],
  receipts: [{id, proposalId, proposalVersion, payloadDigest, recipient}],
  replies: [{id, inReplyToReceiptId, evidenceId}],
  outcome: /* adapter-normalized actual task outcome */,
  delivery: {status: 'unknown', dispatchAttempts: 1}, // receipt-loss case only
  sponsorEvidence: [{id, sponsorId, operationId, evidenceId, kind, costUsd, costSource: 'provider'}],
}
```

Sponsor witnesses must match `operationId`, `sponsorId` and `costUsd`. Model
witnesses also include `model`, `inputTokens`, and `outputTokens`. Unknown cost
is unverified; a projected estimate is not actual provider usage/cost evidence.
An unresolved evidence ID is unverified. IDs/cost metadata are suitable for a
scrubbed report; keep private source bytes and recipient data in local artifacts.

## Goldfish adapter reuse

`evaluatePage({provider, screenshot, brief})` calls only
`provider.complete({system, user, images, json:true})`. It passes no transcript,
expected state, hidden trace, or previous model messages. Every landed page gets
a new call. The provider must honor that fresh context contract and must support
PNG vision; no text-only fallback is allowed. The driver captures the full
rendered page at review and completion during the actual full journey. Evidence
IDs and structured verdicts remain beside capability results.

Goldfish checks the visible purpose, state, next action and confusion. A
contradictory `swims` label with failed clarity or any confusion is downgraded to
`sinks`. Structured responses from a fake provider only validate this interface;
they do not count as a real comprehension read. PNG signature validation is
basic format admission, not image decoding or proof that a capture is complete.
