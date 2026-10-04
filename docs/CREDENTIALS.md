# Local configuration

Use the ignored `.env.local` file at the repository root. Its existing contents
are yours: do not replace it with the example, paste values into chat, or put keys
in frontend variables. `.env.example` lists names only. Save the local file and
tell the coordinator **“keys ready”** before provider verification. Key presence
alone does not authorize calls: the service also checks its local
`.local/keys-ready` readiness marker.

Use the Node version in `.node-version` (26.10.0) and run `pnpm install` once.
Run `pnpm seed:neon` then `pnpm app:neon` for the synthetic local demo.
Both sidecars share the exact `NEON_VAULT_DIRECTORY`, defaulting to the repository's
`.local/demo-vault`. The launcher loads `.env.local`, resolves this path once and
exports the same absolute `LOIS_VAULT_DIR` to the inherited browser pane. An old
legacy vault override cannot divert that pane. A custom existing vault may be
selected with `NEON_VAULT_DIRECTORY` (relative paths resolve from the repository);
missing/incomplete vaults fail before child processes start. The launcher does
not seed or overwrite a custom vault. Unconfigured integrations remain disabled.
Changing a credential, user/account ID or scope requires restarting the sidecar
so an already initialized connector does not retain the earlier configuration.
Do not share `.local/` with another live sidecar process.

## Model conversation

| Name | Type | Requirement |
| --- | --- | --- |
| `NEON_AI_GATEWAY_TOKEN` | Secret | Required for actual Neon inference. The local adapter also accepts `NEON_AI_GATEWAY_API_KEY` as an alias. |
| `NEON_AI_GATEWAY_BASE_URL` | Identifier | Required bare HTTPS branch host, with no `/v1`, query, fragment or URL credentials. The adapter adds `/v1`. |
| `NEON_MODEL` | Identifier | Required model ID available in that gateway. There is no inferred fallback model. |
| `NEON_GOLDFISH_MODEL` | Identifier | Required for live whole-page Goldfish evaluation. Select an independent PNG vision model from the actual gateway catalog. There is no fallback to `NEON_MODEL`. |

Mastra, Assistant UI and the AG-UI adapter need no separate runtime key for
local use. Provider credentials and a valid model are still required for live
inference. CodeRabbit uses its GitHub App installation rather than an environment
variable here.

## Mail and calendar

| Name | Type | Requirement |
| --- | --- | --- |
| `COMPOSIO_API_KEY` | Secret | Enables the Composio project used for personal Gmail and Google Calendar. |
| `COMPOSIO_USER_ID` | Identifier | Stable owner scope for those connections; local default is `neon-local`. Set an explicit value for your configured owner. |
| `COMPOSIO_GMAIL_AUTH_CONFIG_ID`, `COMPOSIO_CALENDAR_AUTH_CONFIG_ID` | Identifiers | Optional existing OAuth configuration IDs, when required by your project. |
| `COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID`, `COMPOSIO_GOOGLECALENDAR_CONNECTED_ACCOUNT_ID` | Identifiers | Optional explicit connections. If several eligible private accounts exist, selecting one is required; the connector refuses to guess. |
| `AGENTMAIL_API_KEY` | Secret | Enables the separate agent-owned inbox. |
| `AGENTMAIL_INBOX_ID` | Identifier | Existing agent-owned inbox for reads and sends. Otherwise create an inbox through its separate exact approval. |
| `NEON_DEMO_RECIPIENT` | Local destination | One controlled recipient you own for the approved demonstration. It is required for invitation preparation and dispatch; guest addresses are not substituted. |

Connecting an account, provisioning an inbox, and sending an invitation are
distinct actions. Saving these fields does not perform any of them. Invitation
approval binds the exact account, recipient, subject and body. An edit revokes
the old approval. If a provider accepts a send but its receipt is lost, the ledger
blocks retry across restart until the outcome is reconciled; restarting is not
a retry mechanism.

## Optional sponsor operations

Each integration is independently enabled. A key alone is insufficient when an
operation needs an exact resource scope. These additional non-secret fields can
be added to `.env.local` even if the initial example omits them.

| Operation | Secret | Required identifiers or scope |
| --- | --- | --- |
| Exa enrichment | `EXA_API_KEY` | The selected actual local person must already have a LinkedIn identity anchor. Native approval is required for paid research. |
| Kernel public-page research | `KERNEL_API_KEY` | `NEON_RESEARCH_HOSTS`: comma-separated host allowlist for the public HTTPS pages to read. |
| Sprites CSV normalization | `SPRITES_TOKEN` | `NEON_SPRITE_NAME`: the dedicated sprite approved for this operation. |
| Executor public research | `EXECUTOR_API_KEY` | `EXECUTOR_MCP_URL`: exact Connections-page URL; `NEON_EXECUTOR_ORGANIZATION`: selected organization; `NEON_EXECUTOR_RESEARCH_TOOLS`: comma-separated exact tool-path allowlist for execution. |
| Neon selected snapshot | `NEON_DATABASE_URL` | `NEON_DATABASE_SCOPE`: exact `hostname/database` matching that Postgres connection URL. Share only the selected event fields through native approval. |

These sponsor actions use separate native tool approval. Secrets remain in the
sidecar; the browser does not receive them. A displayed configured flag is not
evidence of a completed operation, sponsor contribution, provider cost or model
quality.

## Evidence before launch claims

`pnpm test`, `pnpm typecheck` and `pnpm build` use local fixtures and do not
establish live integration success. The verification component adapter uses an
invented `.invalid` recipient and a local delivery transport. Its full journey,
sponsor and comprehension results deliberately remain unverified. Actual live
acceptance needs the controlled send/receipt/reply, persisted conversation and
people workspace, sponsor operation IDs with usage/cost evidence, and independent
whole-page PNG reads. No live checks have been run by this slice.

After an actual whole-page capture and explicit readiness, run:

```sh
node --env-file-if-exists=.env.local verification/goldfish-page.mjs --png /absolute/path/review.png --brief "Organize a small dinner; review the selected guests and invitation."
```

This sends only the PNG and tiny brief to the configured evaluator, with a
30-second timeout, at most two requests per provider instance and no retry.
Sanitized request/usage evidence remains in ignored
`.local/verification/goldfish-calls.jsonl`. Unknown provider cost stays unknown;
a passing page read does not assert a successful full journey or approve email.
The full adapter contract and limits are in [verification/README.md](../verification/README.md).
