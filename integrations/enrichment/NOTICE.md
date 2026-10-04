# Source and reuse notice

`engine.py` derives from MoltPod Hub's `skills/exa-luma-enrichment/scripts/enrich_attendee.py`, commit `ac81db6c4a13c14a279e93c5be11ff82e4c16c84`, inspected 2026-10-04. Source repository metadata: `git+https://github.com/Phantastic-AI/upgrade-phorge-design.git`. The root `package.json` declares `ISC` and `private: "true"`; no root LICENSE or author copyright notice was supplied. This records that metadata without inventing a copyright holder or relicensing upstream code.

Reuse was explicitly authorized for Neon Superpowers by the repository owner. The copied implementation retains its staged Exa request schemas, public-information restrictions, exact-profile/name identity checks, deduplication, and provider-reported receipt contract. Local changes: field-to-citation binding (T738), strict URL parsing, staged field boundaries, sanitized bounded transport, JSON sidecar entry point, private scoped cache, and synthetic offline tests. No customer data, keys, pod defaults or paid fixtures were copied.

New adapter, contract, tests and documentation follow the destination repository's license. Before public distribution, preserve any additional source copyright/license notice supplied by the owner.

Source decision references (identifiers only):
- T738: field grounding and wrong-person contamination
- T739: paid-work envelopes and pilot quality checkpoint
