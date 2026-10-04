// Seed-world types — the Entry / Person / Context / Grant shapes.
//
// Source of truth: superpowers/docs/seed-world.md (the acceptance spec) and
// superpowers/research/ooux/10-attributes-delta.md §1-4 (the attributes
// pass this shape is drawn from), extended by the D-026 typed-stream ruling
// (`supersedes`) and the D-041 confidence/epistemics ruling on fact entries.
//
// D-024 law: one word per state, identical in DB enums, UI, and prompts.
// Every enum below is one word; no hyphenated or multi-word state values.

// ---------------------------------------------------------------------------
// Entry — the vault file format (Ex-10/11 §1)
// ---------------------------------------------------------------------------

/**
 * The canonical Entry `type` values. Sealed set per 10-attributes-delta.md
 * §1.1, plus `context`, `anchor`, `consented`, `merged`, and `session` —
 * one-word additions this seed world needs and the canonical set doesn't
 * yet name (the registry "stays open for additions," D-022/D-026).
 */
export const ENTRY_TYPES = [
  "context", // context-created
  "anchor", // anchor-declared
  "consented", // consented-public
  "granted", // grant-issued (subtype carries the Grant kind)
  "imported", // guest-imported
  "fact", // Fact (subtype: attendance | lookup | sighting)
  "interaction", // Interaction
  "merged", // merge-confirmed
  "proposed", // draft-proposed
  "approved", // draft-approved (subtype: draft | plan)
  "released", // draft-released
  "landed", // verified-landed
  "healed", // session-healed
  "listing", // Listing
  "follow", // Follow (RSVP-intent is the same shape, GMA)
  "session", // Supervised Session lifecycle (subtype: joined | ended)
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/** Who appended the entry — honest actor for every append (Ex-2 SIP). */
export type ActorKind = "app" | "lois" | "human";

export interface Actor {
  kind: ActorKind;
  /** App id | "lois" | person-identity (operator/teammate). */
  ref: string;
}

/** open|chatham|confided (D-037/D-041). Fact entries only. */
export type Confidence = "open" | "chatham" | "confided";
/** stated|inferred (D-041). Fact entries only. */
export type Epistemics = "stated" | "inferred";

export interface Entry {
  /** Unique, stable id — what Follows/revocations/corrections reference. */
  id: string;
  /** Append cursor position — the Stream's total order (integer, 0-based). */
  cursor: number;
  /** When appended; orders the Stream, ISO 8601. */
  at: string;
  /** The knowledge boundary this is filed under — exactly one, ever. */
  context: string;
  /** What kind of entry this is; drives payload shape. */
  type: EntryType;
  /** Finer-grained shape within `type`, where the type alone is ambiguous. */
  subtype?: string;
  actor: Actor;
  /** The people this entry is about (0..N; interactions need >=2). */
  persons?: string[];
  /** Which nested gathering (dinner #N, or the Fogline gathering) this concerns. */
  about?: string;
  /** Prior entries this answers/corrects/retracts/revokes. */
  refs?: string[];
  /** The explicit replaced-by chain (D-026), distinct from `refs`. */
  supersedes?: string;
  /** For grant-subtype entries: the Grant this issuance/revocation documents. */
  grant?: string;
  /** Sealed-spine provenance for a runtime-echo entry (mechanism unruled, O-2). */
  provenance?: string;
  /** Import provenance: which Data Source / Row landed this guest. */
  source?: string;
  /** Citation for enriched facts. */
  evidence?: string;
  /** Confidence — fact entries only (D-041). */
  confidence?: Confidence;
  /** Epistemics — fact entries only (D-041). */
  epistemics?: Epistemics;
  /** The content itself; shape is subtype-owned. */
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Person — the ego-graph node (Ex-10/11 §2)
// ---------------------------------------------------------------------------

export type AnchorKind = "linkedin" | "phone" | "email";

export interface Anchor {
  kind: AnchorKind;
  value: string;
  verified: boolean;
  /** The Context that declared/observed this anchor. */
  context: string;
}

export interface MergeRecord {
  /** A pre-merge, context-local sighting identifier (not a standalone Person). */
  person: string;
  at: string;
  how: "anchor" | "operator";
}

/** active|merged (ASSUMED, one word per state). */
export type PersonState = "active" | "merged";

export interface Person {
  id: string;
  name: string;
  anchors: Anchor[];
  merged: MergeRecord[];
  /** First sighting, across all Contexts this Person is sighted in. */
  sighted_at: string;
  state: PersonState;
}

// ---------------------------------------------------------------------------
// Context — the named knowledge boundary (Ex-10/11 §3)
// ---------------------------------------------------------------------------

export type ContextKind = "professional" | "social" | "public" | "system";

export interface Context {
  id: string;
  name: string;
  kind: ContextKind;
  anchor: AnchorKind;
  /** The declared browser profile ("rides named profiles", D-018). */
  profile?: string;
  /** Consent making the boundary public by design. */
  public?: boolean;
  /** Every vault's built-in system context: apps can never read it (D-030). */
  apps_never_read?: boolean;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Grant — the explicit, logged, standing authorization (Ex-10/11 §4)
// ---------------------------------------------------------------------------

export type GrantKind = "disclosure" | "appscope" | "supervision";

export interface Grant {
  id: string;
  kind: GrantKind;
  /** required iff disclosure */
  person?: string;
  /** required iff disclosure (source->destination pair, O-16 narrow reading) */
  context?: string;
  destinationContext?: string;
  /** required iff appscope */
  app?: string;
  /** required iff supervision — the teammate, out-of-model identity */
  grantee?: string;
  /** required iff supervision — the onboarding window this stands for */
  window?: { from: string; to: string };
  granted_by: string;
  granted_at: string;
  revoked_at?: string;
}

// ---------------------------------------------------------------------------
// Gathering — the nested Event a series Context's dinners are (about-ref target)
// ---------------------------------------------------------------------------

export interface Gathering {
  id: string;
  context: string;
  name: string;
  date: string;
  upcoming: boolean;
}

// ---------------------------------------------------------------------------
// Layer A — platform-shaped fixtures (Luma / Partiful), for the C17 cross-check
// ---------------------------------------------------------------------------

export interface PlatformRosterRow {
  gathering: string;
  personName: string;
  personId: string;
  rsvp: string;
}

export interface PlatformFixture {
  platform: "luma" | "partiful";
  context: string;
  rosterRows: PlatformRosterRow[];
  /** invites the App released, as seen landed on this platform fixture. */
  releasedInvites: { personId: string; gathering: string }[];
}
