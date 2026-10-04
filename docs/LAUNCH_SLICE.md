# Neon launch integration slice

## Goal
Use the existing local people vault and app to complete a dinner organizing task with an actual Mastra agent, Neon inference, Assistant UI / AG-UI, and recorded sponsor tool contributions.

## Boundaries
Private state stays in `.local/`. Integrations are optional until configured. No production data is seeded. A selected snapshot can be shared only with explicit approval. Provider availability and credential presence are distinct from a successful live call.

## Acceptance
- Model-driven conversation can read local people, shortlist with evidence, accept steering and prepare an editable invitation.
- Approval is server-side, bound to the exact account and payload. Changed, missing, stale or replayed approvals never dispatch another send.
- Reserve an operation durably before dispatch; ambiguous outcomes remain blocked across restart.
- Completed receipt and conversation survive restart. Sponsor contribution evidence records actual calls, never invented success.
- Existing frontend remains available; add Assistant UI using the official AG-UI runtime adapter.
- Offline tests first, then controlled live run after keys are ready, then independent whole-page Goldfish and acceptance checks.

## Current limits
Imported baseline includes unfinished source test drafts. These must be resolved before release claims. All live provider and browser checks remain unverified until actually run.

## Existing product continuity — explicit user correction

Neon extends the complete Superpowers app, not only a new conversation shell. Preserve and reuse the existing World-level people workspace: source disclosures, saved drag/keyboard/touch ordering, yellow Post-its, immutable note waves, All comments, Send notes to Lois, and meaningful object motion. Assistant UI/AG-UI supplies the conversation transport within that product. A link to a legacy view does not satisfy continuity.

Verified source references: `apps/face/src/hg/people-workspace.ts`, `people-workspace.css`, `comment-mode.ts`, shared `styles.css`, original `superpowers-app/docs/people-workspace.md`, and the current product direction in `superpowers/docs/lois-direction.md`. The public site source includes `public/room-shot.jpg`, showing the conversation beside the working list and yellow notes. Do not replace this product with a generic chat/sponsor dashboard.

Acceptance adds a literal app test: open a saved World people view, reorder a person, save a Post-it, submit its immutable note wave into the same Mastra conversation, and verify saved order/note/reply after refresh and server restart. Keep model-comprehension proof separate from storage mechanics.
