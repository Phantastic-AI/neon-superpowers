import type { MouthOptions } from "../packages/lois/mind.js";
import { FinishPeopleNotesInputSchema, OrderPeopleInputSchema, ReadPeopleInputSchema, ReplyPeopleInputSchema } from "../packages/lois/people-edit-schemas.js";
import { finishPeopleNotes, PeopleEditError, readPeopleWorkspace, savePeopleNote, savePeopleOrder, type PeopleNotesWave, type PeopleWorkspace } from "../packages/vault/people-edits.js";
import { openVault, type Vault } from "../packages/vault/store.js";
import { loadWorld } from "../packages/vault/world.js";
import type { World } from "../tools/projections/types.js";
import { peopleAliases, projectPeopleViews, resolvePeopleId } from "../tools/projections/people.js";

type Scope = { contextId: string; viewId: string };
type Schema<T> = { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { message: string } } };
const actor = { kind: "lois" as const, ref: "lois" };
function waveIn(view: PeopleWorkspace, waveId: string): PeopleNotesWave {
  const wave = view.waves.find((wave) => wave.waveId === waveId);
  if (!wave) throw new PeopleEditError("not_found", "Submitted notes not found in this people view");
  return wave;
}

/** Four local hands. They store the model's decisions; they never interpret text. */
export function createPeopleHands(vaultDir: string, world: World): NonNullable<MouthOptions["hands"]> {
  function run<T extends Scope>(schema: Schema<T>, action: (vault: Vault, view: PeopleWorkspace, input: T) => Record<string, unknown>) {
    return async (raw: unknown): Promise<string> => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return JSON.stringify({ ok: false, code: "invalid", error: parsed.error.message });
      let vault: Vault | undefined;
      let view: PeopleWorkspace | undefined;
      try {
        // No retained writer handle: imports and direct organizer edits can land
        // between model steps. Each command reads the current append cursor.
        vault = openVault(vaultDir);
        const current = loadWorld(vault);
        view = readPeopleWorkspace(current, parsed.data.contextId, parsed.data.viewId);
        if (!view) return JSON.stringify({
          ok: false, code: "not_found", error: "People view not found in this World",
          availableViews: projectPeopleViews(current).map(({ contextId, contextName, viewId, name }) => ({ contextId, contextName, viewId, name })),
        });
        return JSON.stringify({ ok: true, ...action(vault, view, parsed.data) });
      } catch (error) {
        return JSON.stringify({ ok: false, code: error instanceof PeopleEditError ? error.code : "error", error: error instanceof Error ? error.message : String(error), ...(view ? { orderRevision: view.orderRevision, notesRevision: view.notesRevision } : {}) });
      } finally {
        if (vault) Object.assign(world, loadWorld(vault));
      }
    };
  }
  return {
    people_read: {
      description: "Read a page of the saved people list and its current order revision. Use current contextId/viewId from worlds; rediscover after a diver creates a World or view. A missing scoped view is not evidence that nothing was saved: inspect availableViews before deciding. With waveId, read that submission's immutable note snapshots and current note versions. Use includeEvidence true for small roster pages when identity reasoning needs the stored anchors, memberships and provenance; read further when the decision needs more evidence. Use nextOffset to continue. List frequency is source membership, not loyalty or attendance. Read the submitted notes before deciding any edits.",
      inputSchema: ReadPeopleInputSchema,
      run: run(ReadPeopleInputSchema, (vault, view, input) => {
        const common = { contextId: view.contextId, viewId: view.viewId, name: view.name, orderRevision: view.orderRevision, notesRevision: view.notesRevision, coverage: view.coverage, offset: input.offset };
        if (input.waveId) {
          const wave = waveIn(view, input.waveId);
          const notes = wave.notes.slice(input.offset, input.offset + input.limit);
          const names = new Map(view.people.map((person) => [person.personId, person.name]));
          const aliases = peopleAliases(vault, input.contextId);
          return { ...common, total: wave.notes.length, nextOffset: input.offset + notes.length < wave.notes.length ? input.offset + notes.length : null, wave: { ...wave, noteIds: notes.map((note) => note.noteId), notes: notes.map((note) => ({ ...note, personName: names.get(resolvePeopleId(aliases, note.personId)) ?? null })) }, currentNotes: notes.map((note) => view.notes.find((current) => current.noteId === note.noteId)) };
        }
        const byId = new Map(view.people.map((person) => [person.personId, person]));
        const people = view.order.slice(input.offset, input.offset + input.limit).map((personId, index) => {
          const person = byId.get(personId)!;
          return {
            personId,
            name: person.name,
            position: input.offset + index + 1,
            sourceCount: person.sourceCount,
            identity: person.identity,
            ...(input.includeEvidence ? {
              anchors: person.anchors,
              memberships: person.memberships,
              prospects: person.prospects,
            } : {}),
          };
        });
        return { ...common, total: view.order.length, nextOffset: input.offset + people.length < view.order.length ? input.offset + people.length : null, people, totalWaves: view.waves.length, waves: view.waves.slice(-10).reverse().map((wave) => ({ waveId: wave.waveId, status: wave.status, noteCount: wave.notes.length, orderRevision: wave.orderRevision })) };
      }),
    },
    people_order: {
      description: "Save the organizer's requested order using stable person IDs, the orderRevision you read, and a stable requestId. When responding to notes, name the waveId and start from its orderRevision. A conflict means the organizer edited meanwhile: read the new order, reconcile the intent, and submit a new request against that revision. No messages or invitations are sent.",
      inputSchema: OrderPeopleInputSchema,
      run: run(OrderPeopleInputSchema, (vault, view, input) => {
        if (input.waveId) waveIn(view, input.waveId);
        const saved = savePeopleOrder(vault, { ...input, actor });
        return { ...saved, order: readPeopleWorkspace(loadWorld(vault), input.contextId, input.viewId)!.order };
      }),
    },
    people_reply: {
      description: "Save your actual reply to one submitted organizer note. Use its exact waveId, parent noteId as replyTo, and personId; choose a stable new noteId/requestId and baseRevision 0 for a new reply. Record what you did or the question that remains, not a claim unsupported by a tool result. Saving a reply does not itself perform a requested reorder or change source facts.",
      inputSchema: ReplyPeopleInputSchema,
      run: run(ReplyPeopleInputSchema, (vault, view, input) => {
        const wave = waveIn(view, input.waveId);
        const aliases = peopleAliases(vault, input.contextId);
        if (!wave.notes.some((note) => note.noteId === input.replyTo && resolvePeopleId(aliases, note.personId) === resolvePeopleId(aliases, input.personId))) throw new PeopleEditError("invalid", "Reply must address a note and person in this submitted wave");
        return { ...savePeopleNote(vault, { ...input, state: "resolved", actor }) };
      }),
    },
    people_finish_notes: {
      description: "Finish a submitted note wave after saving a reply to every note. Completed means the responses are recorded; it never means invitations were sent. Use failed if the interpretation could not finish; all drafts and submission evidence remain available for recovery.",
      inputSchema: FinishPeopleNotesInputSchema,
      run: run(FinishPeopleNotesInputSchema, (vault, view, input) => {
        const wave = waveIn(view, input.waveId);
        if (input.status === "completed") {
          const submissionCursor = vault.entryById.get(wave.entryId)!.cursor;
          const aliases = peopleAliases(vault, input.contextId);
          const unansweredNoteIds = wave.notes.filter((note) => !vault.entries.some((entry) => entry.context === input.contextId && entry.type === "interaction" && entry.subtype === "people-note" && entry.actor.kind === "lois" && entry.actor.ref === "lois" && entry.cursor > submissionCursor && entry.payload.viewId === input.viewId && entry.payload.waveId === wave.waveId && entry.payload.replyTo === note.noteId && resolvePeopleId(aliases, entry.payload.personId as string) === resolvePeopleId(aliases, note.personId) && entry.payload.state !== "draft")).map((note) => note.noteId);
          if (unansweredNoteIds.length) return { ok: false, code: "conflict", error: "Save a reply to every submitted note before marking this wave completed", unansweredNoteIds };
        }
        return { ...finishPeopleNotes(vault, { ...input, actor }) };
      }),
    },
  };
}
