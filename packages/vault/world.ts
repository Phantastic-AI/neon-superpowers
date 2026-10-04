// loadWorld — the vault serving the sealed read boundary (D-042).
//
// Produces EXACTLY the projections' World shape (tools/projections/types.ts)
// so the real deriveRoom/deriveQueue run over a vault unchanged: same World
// in, same views out — the engine sliding in behind the same contracts.
//
// Time is a cursor (memory-design): visibility is append order, occurrence
// time is data. `cursor` scopes the entries strictly at-or-before it; a
// retroactively imported entry is visible only from its append cursor
// forward. Default is the full stream.
//
// The three registries are NOT cursor-scoped: they are primary records in
// v0 (store.ts honesty note), and the contracts read them the same way —
// room.ts's own words: "anchors carry no append position".

import type { World } from "../../tools/projections/types.js";
import type { Vault } from "./store.js";

export function loadWorld(vault: Vault, cursor?: number): World {
  const atCursor = cursor ?? vault.entries.length - 1;
  return {
    // entries[i].cursor === i (enforced at open and append), so slice is the
    // exact "cursor <= atCursor" filter, in line order.
    entries: vault.entries.slice(0, atCursor + 1),
    persons: vault.persons,
    contexts: vault.contexts,
    gatherings: vault.gatherings,
  };
}
