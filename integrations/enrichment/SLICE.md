# Anchored local enrichment slice

Scope: portable Exa client, field grounding repair, bounded retry/cache, stdin contract and synthetic offline tests. Parent owns app wiring, credentials, job-level spend authorization. No paid calls, customer data, deployment or git publishing.

Acceptance: correct identity with wrong-person stage-two citations cannot promote attributes; unsupported fields stay unknown; partial failures retain receipts; retry delays/counts and cache lifetime are bounded; stdout is one JSON result without secrets.

Verification: unittest discovery, bytecode compilation, stdin smoke without a key, independent parent review. Stop after offline checks pass and contract is documented.

Source: canonical D2 Hub ac81db6c4a13c14a279e93c5be11ff82e4c16c84. Root package.json declares ISC; no root LICENSE file found. Source authorization is explicit in this task. Preserve provenance/notice in NOTICE.md.

## Verified result

22/22 synthetic offline tests pass, including a red-first T738 reproduction, stage boundaries, conflicting field URLs, unknown costs, partial receipts, retry limits and cache lifecycle. All Python sources compile without writing bytecode. Actual stdin process smoke with EXA_API_KEY removed returned structured key_not_configured and zero requests/cost. No system tsc is available; parent owns destination TypeScript validation and independent review of the wire contract/gates. No live calls, commits, deployment or changes outside this lane.
