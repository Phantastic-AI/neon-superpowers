# Neon Superpowers

A local-first personal agent built on the existing Superpowers people workspace. Lois works beside saved Worlds, source records, ordered people lists and yellow Post-its. This hackathon edition adds a Mastra conversation through AG-UI and Assistant UI, plus bounded sponsor integrations.

The app source is present. Offline adapter and integration tests exist; live provider calls and the complete browser demo still need verified evidence. Credential presence alone does not establish a working integration.

## Run locally

Use Node **26.10.0 or newer**, pnpm, and Python 3 for anchored enrichment and CSV computation. Keep this checkout separate from any personal or production vault.

```sh
pnpm install --frozen-lockfile
pnpm seed:neon
NEON_VAULT_DIRECTORY=.local/demo-vault pnpm app:neon
```

Open [the local app](http://localhost:5299/neon). The Neon sidecar listens on loopback port 5275; the inherited Lois sidecar uses 5276. The face uses strict port 5299. Stop an existing instance before starting another.

Without credentials, you can inspect synthetic local records and run offline checks. Model conversation, OAuth and sponsor actions require server configuration and the explicit keys-ready gate described in [Credentials](docs/CREDENTIALS.md). Keep keys in ignored `.env.local`; never put them in browser variables. Read [the demo guide](docs/DEMO.md) before enabling live calls. `seed:neon` creates two saved synthetic World people views in the ignored `.local/demo-vault`; the generic `seed` command remains available for inherited fixture checks.

```sh
pnpm typecheck
pnpm test:neon
pnpm --filter @neon-superpowers/agent test
pnpm --filter @neon-superpowers/remote-tools test
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s integrations/enrichment/tests
pnpm build
```

The connector package has its own native Node tests; see [connector verification](integrations/connectors/README.md). Full-workspace results and live acceptance must be reported from actual runs.

## What is implemented

- Saved World people views use the inherited ordering, source disclosures, Post-its, immutable note waves and All comments workflow.
- The same conversation can inspect a saved note wave, save order changes and reply to stable note IDs.
- Calendar and mail reads are scoped to a configured personal account. Invitations are prepared for one controlled demo recipient, edited in the app and dispatched through an exact-payload approval ledger.
- AgentMail can read an agent-owned inbox and actual received replies.
- Optional research, guest CSV computation and selected event sharing use bounded adapters with sponsor receipts. See [sponsor status](docs/SPONSORS.md) for verification limits.

Vault records and persisted agent state live locally, including `.local/`. Model inference runs remotely through the configured Neon AI Gateway. Conversation messages and tool results used by Lois—including local people records, Post-it notes, and connected mail/calendar results—can be sent through that gateway to the selected model. Read tools do not require a separate native approval for each result, and the app does not offer manual review of every item of model context.

Sponsor actions such as paid research, remote execution and snapshot sharing have scoped approval prompts. Sending an invitation requires review of its exact account and message. These approvals govern those actions; they do not make inference on-device or prevent read results from entering remote model context. Connect only accounts and use only records you intend to expose to the configured gateway/model. The app is a single-user local showcase.

## Contributor tooling

Optional official Neon guidance can be installed locally with `neon skills -s neon -y` and `neon skills -s neon-postgres -y` using the Neon CLI. Installed skill files and their lock are ignored contributor tooling; they are not vendored application code.

## Provenance and license

Derived from Superpowers with a source-only import, without personal vaults, credentials or browser profiles. [Import record](docs/BASELINE_IMPORT.md) and [source manifest](docs/baseline-source-manifest.json).

[MIT](LICENSE), copyright 2026 Phantastic AI. Publication and hackathon submission remain separate release steps.
