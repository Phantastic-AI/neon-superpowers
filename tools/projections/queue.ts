// deriveQueue — the approval queue as a pure read over the Stream.
//
// A queue row IS a draft-proposed Entry, projected: nothing here is stored,
// counted, or remembered outside the entries (GMA #1/#5; rebuild contract
// #6 — Projections derive, they are never seeded). The Room's "awaiting
// your yes" figure is served by calling this same function scoped to the
// Room's gathering, so the two surfaces can never disagree (SOCIAL-1 /
// LOOP-1 crossTruths: same fact, read twice, agreeing to the digit).

import type { DraftStatus, Entry, Figure, QueueRow, QueueView, World } from "./types.js";

/**
 * A draft's identity across its lifecycle Entries (proposed -> approved ->
 * released -> landed). The seed world links the stages two ways and carries
 * no refs chain on lifecycle Entries, so the honest join is:
 *
 *   - LinkedIn drafts repeat a payload.draft number on every stage
 *     -> key on (context, payload.draft);
 *   - event drafts (invite / nudge) repeat (person, gathering, payload.kind)
 *     on every stage -> key on (context, persons[0], about, payload.kind).
 *
 * Every row's `lifecycle` field names the joined Entry ids, so the join is
 * auditable per row (the introspection law).
 */
function draftKey(e: Entry): string {
  const draftNo = (e.payload as Record<string, unknown> | undefined)?.draft;
  if (draftNo !== undefined) return `${e.context}|draft:${draftNo}`;
  const person = (e.persons ?? [])[0] ?? "";
  const kind = (e.payload as Record<string, unknown> | undefined)?.kind ?? "";
  return `${e.context}|${person}|${e.about ?? ""}|${kind}`;
}

export function deriveQueue(world: World, scope: string, cursor?: number): QueueView {
  // Time is a cursor: read strictly at-or-before it; default = full stream.
  const atCursor = cursor ?? (world.entries.length > 0 ? world.entries[world.entries.length - 1].cursor : -1);
  const entries = world.entries.filter((e) => e.cursor <= atCursor);

  // Scope: "all" | context id | gathering id.
  let inScope: (e: Entry) => boolean;
  let scopeDesc: string;
  if (scope === "all") {
    inScope = () => true;
    scopeDesc = "all contexts";
  } else if (world.contexts.some((c) => c.id === scope)) {
    inScope = (e) => e.context === scope;
    scopeDesc = `context=${scope}`;
  } else {
    const gathering = world.gatherings.find((g) => g.id === scope);
    if (!gathering) throw new Error(`deriveQueue: scope "${scope}" is neither "all", a context id, nor a gathering id`);
    inScope = (e) => e.context === gathering.context && e.about === gathering.id;
    scopeDesc = `context=${gathering.context}, about=${gathering.id}`;
  }

  // Index the later lifecycle stages by draft key. Matching runs over the
  // full at-cursor stream, not the scope filter — a draft's whole lifecycle
  // lives in its own context anyway (D-013: one context per Entry).
  const approvedByKey = new Map<string, Entry>();
  const releasedByKey = new Map<string, Entry>();
  const landedByKey = new Map<string, Entry>();
  for (const e of entries) {
    // subtype guard: "approved" covers both draft-approved and plan-approved
    // (§10.2); only subtype "draft" decides a draft's fate.
    if (e.type === "approved" && e.subtype === "draft") approvedByKey.set(draftKey(e), e);
    else if (e.type === "released") releasedByKey.set(draftKey(e), e);
    else if (e.type === "landed") landedByKey.set(draftKey(e), e);
  }

  const personName = new Map(world.persons.map((p) => [p.id, p.name]));

  const rows: QueueRow[] = [];
  for (const e of entries) {
    if (e.type !== "proposed" || !inScope(e)) continue;
    const key = draftKey(e);
    const approved = approvedByKey.get(key);
    const released = releasedByKey.get(key);
    const landed = landedByKey.get(key);
    // Current state = furthest stage reached. `queued` is §10.1's derived
    // word for proposed-and-undecided — the word "pending" never appears.
    const status: DraftStatus = landed ? "landed" : released ? "released" : approved ? "approved" : "queued";
    const payload = e.payload as Record<string, unknown> | undefined;
    const person = (e.persons ?? [])[0];
    rows.push({
      id: e.id,
      context: e.context,
      about: e.about,
      person,
      addressee: person !== undefined ? personName.get(person) : undefined,
      kind: typeof payload?.kind === "string" ? payload.kind : undefined,
      channel: typeof payload?.channel === "string" ? payload.channel : undefined,
      // Verbatim outbound text where the Entry carries it. This seed world's
      // draft Entries carry none, so this stays honestly absent (README gap)
      // — no fixture is invented here.
      text: typeof payload?.text === "string" ? payload.text : undefined,
      status,
      proposedAt: e.at,
      lifecycle: { proposed: e.id, approved: approved?.id, released: released?.id, landed: landed?.id },
    });
  }

  const foldRule =
    `type=proposed entries with ${scopeDesc}, cursor<=${atCursor}; status = furthest of ` +
    `approved(subtype=draft)/released/landed joined on payload.draft where present, else (persons[0], about, payload.kind)`;
  const statusFigure = (status: DraftStatus): Figure => ({
    count: rows.filter((r) => r.status === status).length,
    source: "entries",
    entryTypes: ["proposed", "approved", "released", "landed"],
    filter: `${foldRule}; status=${status}`,
  });

  return {
    scope,
    cursor: atCursor,
    rows,
    counts: {
      proposed: { count: rows.length, source: "entries", entryTypes: ["proposed"], filter: `type=proposed entries with ${scopeDesc}, cursor<=${atCursor}` },
      queued: statusFigure("queued"),
      approved: statusFigure("approved"),
      released: statusFigure("released"),
      landed: statusFigure("landed"),
    },
  };
}
