// Organizer intent lives beside source facts, never in place of them.
// Each synchronous command validates against the latest vault handle supplied
// by the host, then makes one append. Model interpretation is a separate caller.
import { isDeepStrictEqual } from "node:util";
import { peopleAliases, resolvePeopleId, projectPeopleView, type PeopleView } from "../../tools/projections/people.js";
import type { World } from "../../tools/projections/types.js";
import type { Actor, Entry } from "../../tools/seed-world/types.js";
import { appendEntry } from "./append.js";
import type { Vault } from "./store.js";
import { loadWorld } from "./world.js";

export type PeopleNoteState = "draft" | "submitted" | "resolved" | "hidden";
export interface PeopleNote {
  noteId: string;
  personId: string;
  text: string;
  state: PeopleNoteState;
  revision: number;
  entryId: string;
  actor: Actor;
  at: string;
  replyTo?: string;
  waveId?: string;
}
export interface PeopleNotesWave {
  waveId: string;
  entryId: string;
  noteIds: string[];
  /** The original drafts, not references to mutable latest-note objects. */
  notes: PeopleNote[];
  orderRevision: number;
  revision: number;
  status: "pending" | "completed" | "failed";
  actor: Actor;
  at: string;
}
export interface PeopleWorkspace extends PeopleView {
  order: string[];
  orderRevision: number;
  notes: PeopleNote[];
  notesRevision: number;
  waves: PeopleNotesWave[];
}
export interface PeopleEditReceipt { entryId: string; revision: number; replayed: boolean }
interface EditScope {
  contextId: string;
  viewId: string;
  requestId: string;
  actor?: Actor;
  at?: string;
}
export interface SavePeopleOrderInput extends EditScope { personIds: string[]; baseRevision: number }
export interface SavePeopleNoteInput extends EditScope {
  noteId: string;
  personId: string;
  text: string;
  state: PeopleNoteState;
  /** Latest revision of this note, not of the whole notes ledger. */
  baseRevision: number;
  replyTo?: string;
  /** Attribution of a reply to one immutable submission. */
  waveId?: string;
}
export interface SubmitPeopleNotesInput extends EditScope {
  noteIds: string[];
  /** Optional optimistic check against the workspace's notesRevision. */
  baseRevision?: number;
}
export interface FinishPeopleNotesInput extends EditScope {
  waveId: string;
  status: "completed" | "failed";
}
export class PeopleEditError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "not_found", message: string) { super(message); this.name = "PeopleEditError"; }
}
const subtypes = new Set(["people-order", "people-note", "people-notes-submitted", "people-notes-finished"]);
const organizer: Actor = { kind: "human", ref: "organizer" };
function fail(message: string, code: PeopleEditError["code"] = "invalid"): never { throw new PeopleEditError(code, message); }
const string = (value: unknown, label: string): void => { if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`); };
const revision = (value: unknown): void => { if (!Number.isSafeInteger(value) || (value as number) < 0) fail("revision must be a non-negative integer"); };
function distinct(values: unknown, label: string): asserts values is string[] {
  if (!Array.isArray(values) || !values.length) fail(`${label} cannot be empty`);
  for (const value of values) string(value, label);
  if (new Set(values).size !== values.length) fail(`${label} must be unique`);
}
function scopedEntries(world: World, contextId: string, viewId: string): Entry[] {
  return world.entries.filter((entry) => entry.context === contextId && entry.type === "interaction" && subtypes.has(entry.subtype ?? "") && entry.payload.viewId === viewId);
}

/** Everything, including the latest local drafts, rebuilds from append order. */
export function readPeopleWorkspace(world: World, contextId: string, viewId: string): PeopleWorkspace | undefined {
  const view = projectPeopleView(world, contextId, viewId);
  if (!view) return undefined;
  let savedOrder: string[] = [], orderRevision = 0, notesRevision = 0;
  const notes = new Map<string, PeopleNote>();
  const waves = new Map<string, PeopleNotesWave>();
  for (const entry of scopedEntries(world, contextId, viewId)) {
    const p = entry.payload;
    if (entry.subtype === "people-order") {
      savedOrder = p.personIds as string[];
      orderRevision = p.revision as number;
    } else if (entry.subtype === "people-note") {
      notesRevision++;
      notes.set(p.noteId as string, {
        noteId: p.noteId as string, personId: p.personId as string, text: p.text as string,
        state: p.state as PeopleNoteState, revision: p.revision as number,
        entryId: entry.id, actor: { ...entry.actor }, at: entry.at,
        ...(p.replyTo === undefined ? {} : { replyTo: p.replyTo as string }),
        ...(p.waveId === undefined ? {} : { waveId: p.waveId as string }),
      });
    } else if (entry.subtype === "people-notes-submitted") {
      notesRevision++;
      const snapshots = structuredClone(p.notes as PeopleNote[]);
      waves.set(entry.id, { waveId: entry.id, entryId: entry.id, noteIds: [...p.noteIds as string[]], notes: snapshots, orderRevision: p.orderRevision as number, revision: 1, status: "pending", actor: { ...entry.actor }, at: entry.at });
      for (const snapshot of snapshots) notes.set(snapshot.noteId, { ...snapshot, state: "submitted", revision: snapshot.revision + 1, entryId: entry.id, at: entry.at });
    } else if (entry.subtype === "people-notes-finished") {
      const wave = waves.get(p.waveId as string);
      if (wave) { wave.status = p.status as "completed" | "failed"; wave.revision = p.revision as number; }
    }
  }
  const currentIds = view.people.map((person) => person.personId);
  const aliases = peopleAliases(world, contextId);
  const membership = new Set(currentIds);
  const order = [...new Set(savedOrder.map(id => resolvePeopleId(aliases, id)).filter(id => membership.has(id)))];
  const ordered = new Set(order);
  for (const id of currentIds) if (!ordered.has(id)) order.push(id);
  // Wave snapshots retain the identity IDs seen at submission. Only the live
  // note projection follows later aliases; immutable history stays inspectable.
  return { ...view, order, orderRevision, notes: [...notes.values()].map(note => ({ ...note, personId: resolvePeopleId(aliases, note.personId) })), notesRevision, waves: [...waves.values()] };
}

function current(vault: Vault, input: EditScope): PeopleWorkspace {
  string(input.contextId, "contextId"); string(input.viewId, "viewId"); string(input.requestId, "requestId");
  return readPeopleWorkspace(loadWorld(vault), input.contextId, input.viewId) ?? fail("People view not found in this World", "not_found");
}
function checkRevision(base: number, latest: number): void {
  revision(base);
  if (base !== latest) fail(`revision conflict: expected ${base}, current ${latest}`, "conflict");
}
function checkMembers(view: PeopleWorkspace, ids: string[], aliases: ReadonlyMap<string, string>): void {
  const members = new Set(view.people.map((person) => person.personId));
  for (const id of ids) if (!members.has(resolvePeopleId(aliases, id))) fail(`Person ${id} is not a member of this people view`);
}
/** A retry is an operation identity, not permission to overwrite newer work. */
function prior(vault: Vault, input: EditScope, subtype: string, fields: Record<string, unknown>): Entry | undefined {
  const entry = scopedEntries(loadWorld(vault), input.contextId, input.viewId).find((item) => item.payload.requestId === input.requestId);
  if (!entry) return undefined;
  if (entry.subtype !== subtype || !isDeepStrictEqual(entry.actor, input.actor ?? organizer) || Object.entries(fields).some(([key, value]) => !isDeepStrictEqual(entry.payload[key], value))) fail("request ID was already used for a different operation", "conflict");
  return entry;
}
function commit(vault: Vault, input: EditScope, subtype: string, persons: string[], payload: Record<string, unknown>, refs: string[] = [], supersedes?: string): Entry {
  return appendEntry(vault, {
    context: input.contextId, type: "interaction", subtype, persons,
    actor: { ...input.actor ?? organizer }, at: input.at ?? new Date().toISOString(),
    payload: { ...payload, viewId: input.viewId, requestId: input.requestId },
    ...(refs.length ? { refs } : {}), ...(supersedes ? { supersedes } : {}),
  });
}
const receipt = (entry: Entry, replayed = false): PeopleEditReceipt => ({ entryId: entry.id, revision: entry.payload.revision as number, replayed });

export function savePeopleOrder(vault: Vault, input: SavePeopleOrderInput): PeopleEditReceipt {
  const view = current(vault, input);
  distinct(input.personIds, "order"); revision(input.baseRevision);
  const fields = { personIds: [...input.personIds], baseRevision: input.baseRevision };
  const old = prior(vault, input, "people-order", fields);
  if (old) return receipt(old, true);
  checkMembers(view, input.personIds, peopleAliases(vault, input.contextId)); checkRevision(input.baseRevision, view.orderRevision);
  const previous = scopedEntries(loadWorld(vault), input.contextId, input.viewId).filter((entry) => entry.subtype === "people-order").at(-1);
  return receipt(commit(vault, input, "people-order", fields.personIds, { ...fields, revision: view.orderRevision + 1 }, [], previous?.id));
}

export function savePeopleNote(vault: Vault, input: SavePeopleNoteInput): PeopleEditReceipt {
  const view = current(vault, input);
  string(input.noteId, "noteId"); string(input.personId, "personId"); string(input.text, "note text"); revision(input.baseRevision);
  if (!["draft", "submitted", "resolved", "hidden"].includes(input.state)) fail("Unknown note state");
  if (input.replyTo !== undefined) string(input.replyTo, "replyTo");
  if (input.waveId !== undefined) string(input.waveId, "waveId");
  const fields = { noteId: input.noteId, personId: input.personId, text: input.text, state: input.state, baseRevision: input.baseRevision, replyTo: input.replyTo, waveId: input.waveId };
  const old = prior(vault, input, "people-note", fields);
  if (old) return receipt(old, true);
  const aliases = peopleAliases(vault, input.contextId);
  const personId = resolvePeopleId(aliases, input.personId);
  checkMembers(view, [input.personId], aliases);
  const existing = view.notes.find((item) => item.noteId === input.noteId);
  checkRevision(input.baseRevision, existing?.revision ?? 0);
  if (existing && (existing.personId !== personId || existing.replyTo !== input.replyTo || existing.waveId !== input.waveId)) fail("A note's person anchor, reply thread and wave cannot change");
  const parent = input.replyTo === undefined ? undefined : view.notes.find((item) => item.noteId === input.replyTo);
  if (input.replyTo && (!parent || parent.personId !== personId || parent.noteId === input.noteId)) fail("Reply must keep its parent note's person anchor");
  const wave = input.waveId === undefined ? undefined : view.waves.find((item) => item.waveId === input.waveId);
  if (input.waveId && !wave?.notes.some((item) => item.noteId === input.replyTo && resolvePeopleId(aliases, item.personId) === personId)) fail("Reply wave must contain the parent note and person anchor");
  // A wave can contain several people: editing one sticky must not supersede
  // that shared submission. Reference it while replacing only note entries.
  const previous = existing && vault.entryById.get(existing.entryId);
  const supersedes = previous?.subtype === "people-note" ? previous.id : undefined;
  const refs = [...new Set([parent?.entryId, wave?.entryId, previous && !supersedes ? previous.id : undefined].filter((id): id is string => id !== undefined))];
  return receipt(commit(vault, input, "people-note", [input.personId], { ...fields, revision: input.baseRevision + 1 }, refs, supersedes));
}

export function submitPeopleNotes(vault: Vault, input: SubmitPeopleNotesInput): PeopleNotesWave & { replayed: boolean } {
  const view = current(vault, input);
  distinct(input.noteIds, "note selection");
  if (input.baseRevision !== undefined) revision(input.baseRevision);
  const fields = { noteIds: [...input.noteIds], baseRevision: input.baseRevision };
  const old = prior(vault, input, "people-notes-submitted", fields);
  if (old) return { ...view.waves.find((wave) => wave.waveId === old.id)!, replayed: true };
  if (view.waves.some((wave) => wave.status === "pending")) fail("A notes wave is already pending", "conflict");
  if (input.baseRevision !== undefined) checkRevision(input.baseRevision, view.notesRevision);
  const notes = input.noteIds.map((id) => view.notes.find((note) => note.noteId === id) ?? fail(`Note ${id} not found`, "not_found"));
  if (notes.some((note) => note.state !== "draft")) fail("Only draft notes can enter a new wave");
  const persons = [...new Set(notes.map((note) => note.personId))];
  checkMembers(view, persons, peopleAliases(vault, input.contextId));
  const entry = commit(vault, input, "people-notes-submitted", persons, { ...fields, notes: structuredClone(notes), orderRevision: view.orderRevision }, notes.map((note) => note.entryId));
  return { ...readPeopleWorkspace(loadWorld(vault), input.contextId, input.viewId)!.waves.find((wave) => wave.waveId === entry.id)!, replayed: false };
}

export function finishPeopleNotes(vault: Vault, input: FinishPeopleNotesInput): PeopleEditReceipt {
  const view = current(vault, input);
  string(input.waveId, "waveId");
  if (input.status !== "completed" && input.status !== "failed") fail("Wave must finish as completed or failed");
  const fields = { waveId: input.waveId, status: input.status };
  const old = prior(vault, input, "people-notes-finished", fields);
  if (old) return receipt(old, true);
  const wave = view.waves.find((item) => item.waveId === input.waveId) ?? fail("Note wave not found", "not_found");
  if (wave.status === "completed") fail("The note wave is already completed", "conflict");
  return receipt(commit(vault, input, "people-notes-finished", [...new Set(wave.notes.map((note) => note.personId))], { ...fields, revision: wave.revision + 1 }, [wave.entryId]));
}
