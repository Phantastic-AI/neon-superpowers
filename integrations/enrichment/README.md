# Local anchored Exa enrichment

Portable standard-library Python module derived from the existing MoltPod engine. No Exa SDK, customer dataset, pod runtime or Hub server is required. See [NOTICE.md](NOTICE.md) for source provenance.

## Sidecar contract

Spawn `python3 integrations/enrichment/enrich.py --stdin`, optionally with `--cache-dir <private-local-directory>`. Write exactly one JSON object to stdin and close stdin. Read one JSON object from stdout. Set `EXA_API_KEY` in the process environment only; never put it in argv or JSON. Call directly in Python as `enrich.enrich_one(input, api_key=key, cache_dir=directory)`.

Input: `{ "name": "Jane Example", "linkedin_url": "https://www.linkedin.com/in/jane-example", "context": "Optional public event context" }`. `name` is required. `linkedin_url` may be absent/null: this returns a free skip. `context` defaults to empty. Only these properties are accepted; email/name fallback and email discovery are intentionally absent. Input is limited to 8 KiB, name to 200 characters and context to 4,000 characters. Names need at least one substantive token corroborating the returned profile. URLs must be HTTPS LinkedIn `/in/` or `/pub/` person URLs; lookalikes, credentials, company URLs and arbitrary ports are rejected.

[`contract.ts`](contract.ts) provides the TypeScript wire types. `status` is `ok`, `skipped` or `error`; `ok` includes `matched`, `ambiguous` and `not_found` identity decisions. A `matched` identity is an automated exact-profile/name check, not human verification. The parent should render withheld/unknown fields and offer review rather than treating a match as proof of every attribute.

Output retains the canonical `identity_match`, `person`, `field_evidence`, `sources`, `unresolved_fields`, and `meta` receipts. `field_quality` explains supported and withheld fields. Unknown scalars are null; unknown arrays are empty. Grounding carries the producing stage. The supplied profile remains the identity anchor. Other attributes require a usable public HTTP(S) citation for that field from the stage producing it. Any citation to another LinkedIn person rejects the whole affected field, including mixed correct/wrong citations and location components; conflicting LinkedIn profile values are also withheld. Unsupported role classifications remain unknown. Raw withheld evidence is retained for review, but generated identity narratives are not promoted as facts. Do not feed raw withheld evidence back into profile summaries without the same gate.

Citation checks bind the provider's evidence metadata to the anchor; they do not independently fetch the source or establish that a non-LinkedIn biography belongs to the person. A cited claim is still a sourced automated claim. Location coordinates are prompted as public city centroids; they must not be described as precise personal location.

## Cost, errors and lifetime

An uncached anchored person uses two Exa Deep `/search` requests: identity, then signals. Each request has a 30-second network timeout, up to three attempts, and only HTTP 429 triggers retries. Retry-After delay is capped at 10 seconds. Serialize calls unless the parent owns a shared request-rate limiter. Use a 240-second process deadline; the transport envelope is roughly 220 seconds. A killed process can leave unknown provider spend.

The parent owns permission and pre-dispatch dollar/record/concurrency reservations. This module has no authority to spend from a shared pod key and does not enforce a whole-job budget. Current provider pricing must be confirmed before reserving costs; historical $0.024/person receipts are not a live price guarantee.

Errors are structured (`error.code`), without raw provider response bodies. Typical codes: `invalid_json`, `invalid_input`, `invalid_name`, `invalid_context`, `invalid_linkedin_url`, `key_not_configured`, `provider_failed`. CLI JSON results exit 0, including structured errors; CLI usage errors exit nonzero. Always inspect result status. `provider_failed` retains every completed provider receipt and sets `billing_unknown: true`; never treat it as a refund or rerun blindly. `cost_complete: false` means at least one receipt lacked a valid reported cost. Costs are provider-reported receipts, not account billing reconciliation.

Caching is opt-in, expires after 30 days, and keys canonical profile + name + public context + schema version. Only matched results are cached; reads re-screen evidence. Private cache files are mode 0600, atomically replaced, with new directories mode 0700. Pick a private existing directory if supplying one. Cache failures preserve paid output and receipts. A hit records `cost_dollars: 0`, no new request IDs, and `original_cost_dollars` / `original_request_ids`. Keep cache local to the user; do not share it across tenants. Never reuse an earlier weaker schema.

## Offline verification

`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s integrations/enrichment/tests`

Synthetic fixtures only; provider transport is mocked. Coverage includes T738, mixed-profile and missing citations, stage isolation, lookalike URLs, partial paid receipts, retry limits, private/expired/scoped caches and unknown costs. No paid provider smoke has been performed. Credentialed smoke requires a parent-authorized bounded call.
