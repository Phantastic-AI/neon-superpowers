// Browser facts become durable people through the ordinary vault. The model
// chooses sources and column meanings; the host handles bytes and bookkeeping.
import { createHash } from "node:crypto";
import { EmptyHandInputSchema } from "../packages/lois/hand-schemas.js";
import { SelectPeopleInputSchema as selectInput, ImportPeopleCsvInputSchema as importInput, SavePeopleProspectInputSchema as prospectInput, CreatePeopleWorldInputSchema as worldInput, type PeopleEvidenceInput } from "../packages/lois/people-schemas.js";
import type { DiveHands } from "../tools/lois-dive.js";
import type { World } from "../tools/projections/types.js";
import { peopleProspectPayload, projectPeopleView, projectPeopleViews, type PeopleView, type PeopleSourceRow } from "../tools/projections/people.js";
import { parseCsv } from "../packages/organs/csv.js";
import { importPeopleSource, savePeopleProspect, selectPeopleSources } from "../packages/organs/people.js";
import { appendEntry } from "../packages/vault/append.js";
import { openVault, registerContext, type Vault } from "../packages/vault/store.js";
import type { DiverCapabilities } from "../packages/lois/diver.js";
import { digest } from "../packages/lois/trace.js";
import { createPeopleHands } from "./people-hands.js";

interface PeopleRuntime {
  vaultDir: string;
  dive: Pick<DiveHands, "dive_read_artifact_text" | "dive_read_observation">;
}

export function refreshPeopleWorld(world: World, vault: Vault): void {
  world.entries = vault.entries;
  world.persons = vault.persons;
  world.contexts = vault.contexts;
  world.gatherings = vault.gatherings;
}

function receipt(view: PeopleView) {
  return { contextId: view.contextId, viewId: view.viewId, name: view.name, people: view.people.length,
    unresolved: view.people.filter(p => p.identity !== "verified").length, coverage: view.coverage,
    sources: view.sources.map(s => ({ eventId: s.eventId, name: s.name, readState: s.readState, rows: s.rowCount })) };
}

/** No fake next dinner is necessary to establish the organizer's private World. */
export function createPeopleWorldHand(vaultDir: string, world: World) {
  return {
    description: "Create a local private World when the organizer wants one and no suitable World exists. A World can hold historical people with no next event. Read worlds first; reuse the right existing World. This does not create an event or contact anyone. Reuse requestId to retry the same creation.",
    inputSchema: worldInput,
    traceInput: (input: unknown) => ({ requestDigest: digest(worldInput.parse(input).requestId) }),
    run: async (input: unknown) => {
      const parsed = worldInput.parse(input);
      const contextId = `c-people-${digest(parsed.requestId).slice(0, 24)}`;
      const vault = openVault(vaultDir);
      const existing = vault.contextById.get(contextId);
      if (existing) {
        const prior = vault.entries.find(e => e.type === "context" && e.context === contextId && e.payload.peopleWorldRequest === parsed.requestId);
        if (!prior || existing.name !== parsed.name || existing.kind !== (parsed.lane === "topical" ? "professional" : "social") || existing.anchor !== parsed.anchor) throw new Error("World request id already belongs to a different creation");
      } else {
        const at = new Date().toISOString();
        registerContext(vault, { id: contextId, name: parsed.name, kind: parsed.lane === "topical" ? "professional" : "social", anchor: parsed.anchor, created_at: at });
        appendEntry(vault, { at, context: contextId, type: "context", subtype: "created", actor: { kind: "lois", ref: "lois" }, payload: { name: parsed.name, lane: parsed.lane, peopleWorldRequest: parsed.requestId } });
      }
      refreshPeopleWorld(world, vault);
      return JSON.stringify({ ok: true, contextId, name: parsed.name, replayed: Boolean(existing), createdEvent: false });
    },
  };
}

export function createPeopleCapabilities(runtime: PeopleRuntime, world: World): DiverCapabilities {
  const changedPeopleEvidence = (_input: unknown, output: string) => {
    try { return JSON.parse(output).ok === true ? ["guestlist_saved"] : []; } catch { return []; }
  };
  const createWorld = createPeopleWorldHand(runtime.vaultDir, world);
  async function retainedEvidence(input: PeopleEvidenceInput): Promise<string[]> {
    if ("artifactId" in input) {
      const read = await runtime.dive.dive_read_artifact_text(input);
      if (read.ok === false) throw new Error(read.note);
      return [`artifact:${read.artifact.artifactId}`, `sha256:${read.artifact.sha256}`, `url:${read.artifact.sourceUrl}`];
    }
    const read = await runtime.dive.dive_read_observation(input.observationId);
    if (!read.ok) throw new Error(read.note);
    return [
      `observation:${input.observationId}`,
      `artifact:${read.artifact.artifactId}`,
      `sha256:${read.artifact.sha256}`,
      `url:${read.artifact.sourceUrl}`,
    ];
  }
  return {
    // Same fresh, paginated evidence read as the mouth; no organizer edit hands.
    people_read: createPeopleHands(runtime.vaultDir, world).people_read,
    worlds: {
      description: "Read available local Worlds before selecting or creating a people workspace. Returns only app-readable contextId, name, kind and anchor from the current vault; no people, gatherings, notes, or hidden system contexts.",
      inputSchema: EmptyHandInputSchema,
      run: async input => {
        EmptyHandInputSchema.parse(input);
        const vault = openVault(runtime.vaultDir);
        refreshPeopleWorld(world, vault);
        return JSON.stringify(vault.contexts
          .filter(context => !context.apps_never_read)
          .map(context => ({
            contextId: context.id,
            name: context.name,
            kind: context.kind,
            anchor: context.anchor,
          })));
      },
    },
    remember_world: createWorld,
    people_select_sources: {
      description: "Save the exact historical event lists to combine in a selected World. Choose the series membership from the organizer's request and observed pages, never from a URL rule. Include every selected source on each call, using its platform/account/event identity and job-owned artifact or retained same-job observation. DiscoveryComplete means you have established the requested source scope, not merely found one file. This only changes the local people workspace.",
      inputSchema: selectInput,
      invalidatesEvidenceCategories: changedPeopleEvidence,
      traceInput: input => { const p = selectInput.parse(input); return { contextId: p.contextId, viewId: p.viewId, sources: p.sources.length }; },
      run: async input => {
        const parsed = selectInput.parse(input);
        const sources = await Promise.all(parsed.sources.map(async s => ({ ...s, evidence: await retainedEvidence(s.evidence) })));
        // Reads may yield while another local edit lands. Open the writer only now.
        const vault = openVault(runtime.vaultDir);
        const result = selectPeopleSources(vault, { ...parsed, sources, actor: { kind: "lois", ref: "diver" } });
        refreshPeopleWorld(world, vault);
        return JSON.stringify({ ok: true, ...receipt(result) });
      },
    },
    people_import_csv: {
      description: "Import every row from one exact job-owned CSV into a previously selected source list. Read only the header/sample first, then map exact header names once; name can join several columns. Do not transcribe a CSV into tool arguments. Prefer the source's stable event-local row ID column. With no row ID, content keys keep provisional source rows; these are not proof of person identity. When observed source evidence establishes the mapped email/phone/profile as guest identity, supply identity with its kind, your rationale and job-owned artifact or retained same-job observation references. This applies your judgment to that column in this source, combines corroborated recurring people and preserves earlier ranks/notes. A column label alone or a guessed address is not verification; omit identity when unsure. Competing established identities remain conflicts. Map attendance only if the source explicitly records attendance, never RSVP. Mark partial when this export covers only part of the requested source. Returns a saved receipt and counts, not raw contacts.",
      inputSchema: importInput,
      invalidatesEvidenceCategories: changedPeopleEvidence,
      traceInput: input => { const p = importInput.parse(input); return { contextId: p.contextId, viewId: p.viewId, artifactDigest: digest(p.artifactId), eventDigest: digest(JSON.stringify(p.source)) }; },
      run: async input => {
        const parsed = importInput.parse(input);
        const read = await runtime.dive.dive_read_artifact_text({ artifactId: parsed.artifactId });
        if (!read.ok) return JSON.stringify(read);
        const csv = parseCsv(read.text);
        const columns = parsed.columns;
        if (parsed.identity && !columns[parsed.identity.kind]) throw new Error("Identity decision must name a mapped anchor column");
        const names = [...columns.name, ...Object.entries(columns).filter(([key]) => key !== "name").map(([, value]) => value as string)];
        for (const name of names) if (!csv.headers.includes(name)) throw new Error(`CSV column ${JSON.stringify(name)} is missing`);
        const indexes = new Map(csv.headers.map((name, i) => [name, i]));
        const pointers = [`artifact:${read.artifact.artifactId}`, `sha256:${read.artifact.sha256}`, `url:${read.artifact.sourceUrl}`];
        const adjudication = parsed.identity && {
          rationale: parsed.identity.rationale,
          evidence: [...new Set((await Promise.all(parsed.identity.evidence.map(item =>
            "artifactId" in item && item.artifactId === parsed.artifactId ? pointers : retainedEvidence(item)
          ))).flat())],
        };
        const retained = [...new Set([...pointers, ...(adjudication?.evidence ?? [])])];
        const occurrences = new Map<string, number>();
        const rows: PeopleSourceRow[] = csv.rows.map((cells, index) => {
          const value = (column?: string) => column === undefined ? "" : cells[indexes.get(column)!].trim();
          const name = columns.name.map(c => value(c)).filter(Boolean).join(" ");
          if (!name) throw new Error(`CSV data row ${index + 1} has no name in the mapped columns`);
          const anchors = (["email", "phone", "linkedin"] as const).flatMap(kind => value(columns[kind]) ? [{ kind, value: value(columns[kind]), verified: false }] : []);
          let rowId = columns.rowId ? value(columns.rowId) : "";
          if (columns.rowId && !rowId) throw new Error(`CSV data row ${index + 1} has no source row ID`);
          if (!columns.rowId) {
            // Exclude mutable RSVP/attendance. Identical unidentified rows remain
            // separate provisional sightings; no name-based cross-event merge.
            const key = createHash("sha256").update(JSON.stringify([name, anchors])).digest("hex");
            const occurrence = (occurrences.get(key) ?? 0) + 1; occurrences.set(key, occurrence);
            rowId = `content:${key}:${occurrence}`;
          }
          // Identity decisions do not participate in the source row key above.
          const resolved = anchors.map(anchor => parsed.identity?.kind === anchor.kind && adjudication
            ? { ...anchor, verified: true, evidence: adjudication.evidence[0], adjudication }
            : anchor);
          return { rowId, name, anchors: resolved, evidence: [...retained, `csv-data-row:${index + 1}`],
            ...(value(columns.rsvp) ? { rsvp: value(columns.rsvp) } : {}),
            ...(value(columns.attendance) ? { attendance: value(columns.attendance) } : {}) };
        });
        const vault = openVault(runtime.vaultDir);
        const result = importPeopleSource(vault, { ...parsed, rows, evidence: retained, actor: { kind: "lois", ref: "diver" } });
        refreshPeopleWorld(world, vault);
        return JSON.stringify({ ok: true, ...receipt(result), importedRows: rows.length,
          rowKeys: columns.rowId ? "source" : "provisional", ...(result.coverage.complete ? { evidenceCategory: "guestlist_saved" } : {}) });
      },
      evidenceCategories: (_input, output) => {
        try { const result = JSON.parse(output); return result.ok && result.coverage?.complete && result.evidenceCategory === "guestlist_saved" ? ["guestlist_saved"] : []; } catch { return []; }
      },
    },
    people_save_prospect: {
      description: "Save an observed candidate into an existing People view alongside past guests, with source evidence and your inferred reason for inviting them. Save useful findings as you go. Reuse the same source/row identity for later observations and the same requestId only for an exact retry. Read worlds and people_sources to find the existing workspace. Supply only observed contact anchors; attach identity rationale and evidence when the source establishes who owns an anchor. Otherwise leave identity absent. Names alone do not establish identity. No past attendance, event creation, or sending is implied. This saves one finding, not proof that prospecting is complete.",
      inputSchema: prospectInput,
      traceInput: input => { const p = prospectInput.parse(input); return { contextId: p.contextId, viewId: p.viewId, requestDigest: digest(p.requestId) }; },
      run: async input => {
        const parsed = prospectInput.parse(input);
        const requestDigest = createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
        const current = openVault(runtime.vaultDir);
        const view = projectPeopleView(current, parsed.contextId, parsed.viewId);
        if (!view) throw new Error("Prospect needs an existing accessible People view");
        const prior = current.entries.find(entry => {
          const finding = peopleProspectPayload(entry);
          return entry.context === parsed.contextId && finding?.viewId === parsed.viewId && finding.requestId === parsed.requestId;
        });
        if (prior) {
          if (prior.payload.peopleProspectRequestDigest !== requestDigest || prior.actor.kind !== "lois" || prior.actor.ref !== "diver") throw new Error("Request id already names a different prospect finding");
          refreshPeopleWorld(world, current);
          return JSON.stringify({ ok: true, ...receipt(view), savedRequestId: parsed.requestId, replayed: true, evidenceCategory: "prospect_saved" });
        }
        const cache = new Map<string, Promise<string[]>>();
        const retain = async (refs: PeopleEvidenceInput[]) => [...new Set((await Promise.all(refs.map(ref => {
          const key = JSON.stringify(ref);
          if (!cache.has(key)) cache.set(key, retainedEvidence(ref));
          return cache.get(key)!;
        }))).flat())];
        const observed = await retain(parsed.evidence);
        const reason = { ...parsed.reason, epistemics: "inferred" as const, evidence: await retain(parsed.reason.evidence) };
        const anchors = await Promise.all(parsed.anchors.map(async ({ kind, value, identity }) => {
          if (!identity) return { kind, value, verified: false };
          const evidence = await retain(identity.evidence);
          return { kind, value, verified: true, evidence: evidence[0], adjudication: { rationale: identity.rationale, evidence } };
        }));
        const evidence = [...new Set([...observed, ...reason.evidence, ...anchors.flatMap(anchor => anchor.adjudication?.evidence ?? [])])];
        const vault = openVault(runtime.vaultDir);
        const result = savePeopleProspect(vault, { ...parsed, requestDigest, anchors, evidence, reason, actor: { kind: "lois", ref: "diver" } });
        refreshPeopleWorld(world, vault);
        return JSON.stringify({ ok: true, ...receipt(result), savedRequestId: parsed.requestId, evidenceCategory: "prospect_saved" });
      },
      evidenceCategories: (_input, output) => {
        try { const result = JSON.parse(output); return result.ok === true && result.evidenceCategory === "prospect_saved" ? ["prospect_saved"] : []; } catch { return []; }
      },
    },
    people_sources: {
      description: "Read saved people-view IDs, actual selected sources and import coverage in the local vault. These are historical list memberships, not attendance. No upcoming event is required.",
      inputSchema: EmptyHandInputSchema,
      run: async () => JSON.stringify(projectPeopleViews(world).map(receipt)),
    },
  };
}
