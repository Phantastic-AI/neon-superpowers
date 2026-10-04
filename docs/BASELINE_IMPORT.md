# Baseline import

This local baseline derives from the current Superpowers app working tree at checkpoint `805bac2af3e8d7409dc28760cc6fb2d164423887`. It imports regular source files only, including required uncommitted implementation changes; it imports no Git history. The per-file source hashes are in [the source manifest](baseline-source-manifest.json).

## Included

- The web face and browser extension.
- Core, agent, browser-organ, sender and vault packages.
- The HTTP sidecar, supporting tools and deterministic synthetic fixtures.
- Workspace manifests, configuration and the existing dependency lockfile.

## Excluded

The legacy desktop/Rust app, research and operational documents, experimental prospecting tools, private contact builders, existing eval recipes, real vaults, downloaded data, traces, browser profiles, environment files and local dependencies.

## Narrow import repairs

- The root package is named `neon-superpowers`.
- Browser, cold-archive and rehearsal defaults use Neon-specific application storage.
- Local-path and operator-name test examples are generic.
- Missing-vault errors point to the included synthetic seed generator.
- Two HTTP test fixtures now provide the cancellation method used by server shutdown.
- Prospect completion recognizes the existing save receipt; worker return prompts carry same-job saved-state reconciliation. The tests check host status and native prompt delivery.
- The required pure secretary claim validator is included because the current vault append path imports it; the prospecting experiment is excluded.

## Run and verify

Install with `pnpm install --frozen-lockfile`, then `pnpm seed` and `pnpm seed:check`. `pnpm app` starts the sidecar and web face. The web face is served on loopback port 5199 and the sidecar on 5175. Use alternate ports or verify those ports are free before starting another app.

Model-backed conversation requires a server-side model credential. No credential is imported. Synthetic seed generation, typechecks, builds and model-free unit tests do not require one.

The inherited paid browser smoke runners refer to excluded historical acceptance documents. They remain a separate integration/review task and must not be treated as a passing Neon launch proof.

This import is local and unpublished pending review.

## Local verification evidence

- Locked existing dependencies installed successfully with scripts disabled.
- Synthetic seed: 29 checks passed; vault replay/write invariants: 26 checks passed.
- Initial imported web face built successfully.
- Production agent and sidecar passed strict source typechecking.
- Agent package typecheck passed after repairing the inherited settlement tests.
- Scoped Vitest command `pnpm exec vitest run apps packages sidecar tools`: 55 suites and 586 test cases passed, including the contemporaneous local integration tests it selected.
- Imported source scan: 197 regular files; no credential literals, personal/local/internal reference flags or source symlinks.

The whole workspace typecheck must be rerun after the concurrent launch UI is complete. Its intermediate run found the launch module not yet written. Native Node test suites in integration and verification directories require their own runner; unscoped Vitest does not recognize those suites.
