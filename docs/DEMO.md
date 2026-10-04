# Two-minute demo rehearsal

This is a script for the implemented app, not a record of a completed live demonstration. Use synthetic people and event data. Connect only an explicitly chosen demo account; send only to the configured controlled recipient. Never use customer data or copy personal screenshots into the public repository.

## Before recording

1. Follow the root quickstart with Node >=26.10.0. Verify ports 5299, 5275 and 5276 are available.
2. Run `pnpm seed:neon` and launch with `NEON_VAULT_DIRECTORY=.local/demo-vault pnpm app:neon` to use two isolated synthetic saved World people views. Open `/neon` and confirm the Worlds selector contains it. If it says “No saved people views yet”, verify the configured demo vault; generic `pnpm seed` success is insufficient. Do not substitute a private vault.
3. Follow [Credentials](CREDENTIALS.md) for grouped server keys, exact resource scopes and the `.local/keys-ready` gate. Configure the actual Neon gateway model from its catalog. Empty credentials must leave live actions unavailable.
4. Model inference is remote. Conversation, selected local records and tool results can enter Neon gateway/model context; mail/calendar read results do not receive a separate native approval prompt. Use only synthetic local records and explicitly permitted demo-account content. If demonstrating calendar/mail, connect the selected account through OAuth. Set the controlled demo recipient and an existing agent-owned inbox. A calendar read must use a concrete RFC3339 interval with timezone. The current page has a Connect Gmail button; calendar connection configuration is separate.
5. Rehearse a harmless bounded calendar read and confirm real output. Prepare an invitation without sending. Check the complete account, recipient, subject and body are visible. Run a controlled send/reply only after its exact review and approval.
6. Record a genuine reply in the agent-owned inbox in advance if the two-minute timing requires it. Label it as previously received. Human email delivery has no two-minute guarantee.

## Recording sequence

| Time | Action | Evidence to show |
| --- | --- | --- |
| 0:00–0:25 | Open the saved synthetic World. Expand its source disclosure and move one person with drag or the ordering controls. | Actual source labels and saved order. |
| 0:25–0:50 | Add a yellow Post-it: “Move this person ahead of the next person and explain why.” Save it, then use **Send notes to Lois**. | The submitted immutable note wave enters the same conversation. Use **All comments** to inspect saved replies. |
| 0:50–1:10 | Ask Lois to shortlist people for a dinner about building useful AI, explain each pick from saved evidence, then steer the selection. | Sourced rationale and actual selected people. If evidence is insufficient, show that limitation. |
| 1:10–1:25 | Ask for a calendar read within the preselected demo interval. | Real bounded calendar results, or an explicit configuration/error state. |
| 1:25–1:45 | Ask for an invitation to the configured controlled recipient. Edit the draft if needed; **Save revised draft** before approving. | Exact saved account, recipient, subject and body. **Approve this message & send** dispatches only this proposal. |
| 1:45–2:00 | Show the actual provider send receipt; ask to read the agent-owned inbox for the actual reply. Refresh to inspect saved order, note and conversation. | A real receipt and reply, or an honest pending-delivery state. |

A saved note reply does not prove that an order change was performed. Check the list. A draft does not prove a send. A successful send does not prove delivery or a reply. Restart persistence and model comprehension need separate acceptance evidence, beyond this short recording.

## Optional sponsor evidence run

Keep these actions separate from the two-minute story unless they naturally help the dinner task. Review each native tool approval before continuing.

- Kernel: read one public event page on an explicitly allowed hostname; retain returned page evidence and its receipt.
- Exa: enrich one synthetic/explicitly permitted anchored public profile. A missing profile anchor returns a skip; never present it as an Exa call.
- Sprites: normalize a small synthetic guest CSV in a dedicated pre-provisioned guest; inspect duplicates removed.
- Executor: discover available public research tools in the selected organization. Review an exact read-only path, configure its allowlist, then invoke that selected tool. Discovery is a genuine call but does not establish completion of a research task.
- Neon Postgres: explicitly provision the dedicated snapshot table, then share only selected event fields after approval. The current agent exposes sharing; table setup is an explicit adapter/provisioning step, not an automatic UI action.

Capture receipts with resource scope and known/unknown cost. Redact credentials and account identifiers from public evidence. No fabricated success cards, cached fixture output presented as live output, or automated retry after an uncertain send.

## Release gate

Before publishing a demo claim, retain an actual browser recording, controlled provider receipts, persistence/restart results and the final independent source review. A genuine CodeRabbit review requires repository app access and a real review run. This guide does not authorize a push, PR, app installation or portal submission.
