import type { PeopleNote, PeopleNotesWave, PeopleWorkspace, SavePeopleNoteInput, SavePeopleOrderInput, SubmitPeopleNotesInput } from "../../../../packages/vault/people-edits.js";
import { PeopleApiError, type PeopleApi, type PeopleScope } from "../lois/people-client.js";
import "./people-workspace.css";

type Person = PeopleWorkspace["people"][number];
type Move = { personId: string; beforeId?: string; afterId?: string };
type OrderJob = { move: Move; undo: Move; request?: SavePeopleOrderInput };
type Draft = {
  noteId: string; personId: string; text: string; dirty: boolean;
  editor: HTMLElement; input: HTMLTextAreaElement; status: HTMLElement;
  timer?: ReturnType<typeof setTimeout>; saving?: Promise<boolean>; error?: string;
  request?: SavePeopleNoteInput;
};
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] => {
  const result = document.createElement(tag); result.className = cls;
  if (text !== undefined) result.textContent = text;
  return result;
};
function action(text: string, run: () => void, label?: string): HTMLButtonElement {
  const button = node("button", "people-workspace__action", text); button.type = "button";
  if (label) button.setAttribute("aria-label", label);
  button.addEventListener("click", run); return button;
}
function link(text: string, url: string): HTMLElement {
  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol)) return node("span", "", text);
    const a = node("a", "", text); a.href = parsed.href; a.target = "_blank"; a.rel = "noopener noreferrer"; return a;
  } catch { return node("span", "", text); }
}
const requestId = () => crypto.randomUUID();
const message = (error: unknown) => error instanceof Error ? error.message : "The request did not finish.";
function moved(order: string[], move: Move): string[] {
  if (!order.includes(move.personId)) return order;
  const rest = order.filter(id => id !== move.personId);
  const anchor = move.beforeId ?? move.afterId;
  if (anchor && !rest.includes(anchor)) return order;
  const position = move.beforeId ? rest.indexOf(move.beforeId) : move.afterId ? rest.indexOf(move.afterId) + 1 : 0;
  rest.splice(position, 0, move.personId); return rest;
}
function nameGroups(people: Person[]): Map<string, Person[]> {
  const groups = new Map<string, Person[]>();
  for (const person of people) {
    const name = person.name.trim().toLocaleLowerCase();
    const group = groups.get(name) ?? []; group.push(person); groups.set(name, group);
  }
  return groups;
}
function distinctContact(person: Person, namesakes: Person[]) {
  const others = namesakes.filter(other => other.personId !== person.personId);
  return person.anchors.find(candidate => candidate.verified && !others.some(other => other.anchors.some(value => value.kind === candidate.kind && value.value === candidate.value)));
}
function identityDetail(person: Person, namesakes: Person[]): string {
  if (namesakes.length < 2) return "";
  const others = namesakes.filter(other => other.personId !== person.personId);
  const anchor = distinctContact(person, namesakes);
  if (anchor) return `${({ email: "Email", phone: "Phone", linkedin: "LinkedIn" })[anchor.kind]}: ${anchor.value}`;
  // A source label identifies this imported row; it does not assert that two
  // equal names are either one person or different people.
  const source = person.memberships.find(candidate => !others.some(other => other.memberships.some(value => value.sourceId === candidate.sourceId))) ?? person.memberships[0];
  return source ? `From ${source.name} · ${source.date.slice(0, 10)}` : "Same name on this list; add context in a note to Lois.";
}

/** Local presentation state is disposable. Every saved choice comes back from
 * the vault. A failed move retains an intent, not a stale full-list overwrite. */
export function mountPeopleWorkspace(host: HTMLElement, options: {
  api: PeopleApi; scope: PeopleScope; onWave: (scope: PeopleScope, wave: PeopleNotesWave) => Promise<void>;
}): { refresh: () => Promise<void>; destroy: () => void } {
  const { api, onWave } = options;
  const scope = { ...options.scope };
  let workspace: PeopleWorkspace | undefined, destroyed = false, readNumber = 0;
  let frequency = false, query = "", loadError = "", orderError = "", waveError = "";
  let processingOrder = false, orderPaused = false, submitting = false, continuing = false;
  let lastUndo: Move | undefined, dragged: string | undefined, retryWave: PeopleNotesWave | undefined, announcement = "";
  let submission: SubmitPeopleNotesInput | undefined;
  const moves: OrderJob[] = [], rows = new Map<string, HTMLElement>(), drafts = new Map<string, Draft>();
  const rowAnimations = new Map<HTMLElement, Animation>();
  const openNotes = new Set<string>();
  const root = node("section", "people-workspace"); root.setAttribute("aria-label", "People workspace");
  const heading = node("h2", "people-workspace__title", "Your people");
  const context = node("p", "people-workspace__context");
  const coverage = node("div", "people-workspace__coverage");
  const toolbar = node("div", "people-workspace__toolbar");
  const sorts = node("div", "people-workspace__sorts"); sorts.setAttribute("aria-label", "List order");
  const ownSort = action("Your order", () => { frequency = false; render(); });
  const sourceSort = action("Source frequency", () => { frequency = true; render(); });
  sorts.append(ownSort, sourceSort);
  const searchLabel = node("label", "people-workspace__search", "Find someone");
  const search = node("input"); search.type = "search"; search.placeholder = "Name";
  search.addEventListener("input", () => { query = search.value.trim().toLocaleLowerCase(); renderRows(); renderStatus(); });
  searchLabel.append(search); toolbar.append(sorts, searchLabel);
  const status = node("div", "people-workspace__status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const list = node("ol", "people-workspace__list"); list.setAttribute("aria-label", "Guestlist");
  const footer = node("div", "people-workspace__notes-tray");
  const allComments = node("details", "people-workspace__all-comments");
  root.append(context, heading, coverage, toolbar, status, list, footer, allComments); host.replaceChildren(root);

  function accept(next: PeopleWorkspace): void {
    if (next.contextId !== scope.contextId || next.viewId !== scope.viewId) throw new Error("This list belongs to a different World or view. Reload this list.");
    if (!workspace) frequency = next.orderRevision === 0;
    if (!workspace || next.cursor >= workspace.cursor) workspace = next;
    // The stream may fail after Lois has already saved every reply and finished
    // the wave. Durable completion wins over a local transport error.
    if (retryWave && workspace.waves.some(wave => wave.waveId === retryWave!.waveId && wave.status === "completed")) {
      retryWave = undefined; waveError = "";
    }
  }
  function effectiveOrder(): string[] {
    const order = workspace?.order ?? [];
    return orderPaused ? order : moves.reduce((value, job) => moved(value, job.move), order);
  }
  function restoreFocus(work: () => void): void {
    const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
    const selection = focused instanceof HTMLTextAreaElement ? [focused.selectionStart, focused.selectionEnd] : undefined;
    work();
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
    if (focused instanceof HTMLTextAreaElement && selection && focused.isConnected) focused.setSelectionRange(selection[0]!, selection[1]!);
  }
  function render(): void {
    if (destroyed) return;
    restoreFocus(() => {
      if (workspace) { heading.textContent = workspace.name; context.textContent = workspace.contextName; }
      ownSort.setAttribute("aria-pressed", String(!frequency)); sourceSort.setAttribute("aria-pressed", String(frequency));
      renderCoverage(); renderRows(); renderStatus(); renderFooter(); renderAllComments();
    });
  }
  function renderCoverage(): void {
    if (!workspace) return;
    const c = workspace.coverage;
    const details = node("details", "people-workspace__sources");
    details.open = coverage.querySelector("details")?.open ?? false;
    details.append(node("summary", "", `${c.read} of ${c.selected} selected lists read`));
    const state = node("p", "people-workspace__source-state");
    if (!c.discoveryComplete) state.append(node("span", "people-workspace__source-line", "Past-list search unfinished."));
    for (const [readState, label] of [["unread", "Not read yet"], ["partial", "Partly read"], ["failed", "Could not read"]] as const) {
      const unfinished = workspace.sources.filter(source => source.readState === readState);
      if (!unfinished.length) continue;
      const line = node("span", "people-workspace__source-line", `${label}: `);
      for (const [index, source] of unfinished.entries()) {
        if (index) line.append(document.createTextNode(", "));
        line.append(link(source.name, source.url));
      }
      state.append(line);
    }
    const sources = node("ul");
    for (const source of workspace.sources) {
      const item = node("li"); item.append(link(source.name, source.url), node("span", "people-workspace__source-meta", ` ${source.date.slice(0, 10)} · ${source.readState} · ${source.rowCount} source rows`)); sources.append(item);
    }
    details.append(sources);
    const contacts = node("p", "people-workspace__contact-state");
    for (const group of nameGroups(workspace.people).values()) {
      if (group.length > 1 && group.every(person => person.identity === "verified" && distinctContact(person, group))) {
        contacts.append(node("span", "people-workspace__source-line", `${group[0]!.name}: Same name, different saved contacts; kept separate.`));
      }
    }
    coverage.replaceChildren(node("p", "people-workspace__count", `${workspace.people.length} people`), details, state,
      contacts, node("p", "people-workspace__explanation", "From past guestlists, not confirmed attendance. Your order is yours to change."));
  }
  function renderStatus(): void {
    status.replaceChildren();
    if (loadError) status.append(node("span", "", loadError), action("Reload list", () => { void refresh(); }));
    else if (!workspace) status.append(node("span", "", "Reading your saved list…"));
    if (orderError) status.append(node("span", "", orderError), action("Retry move", () => { orderPaused = false; orderError = ""; render(); void processMoves(); }));
    else if (moves.length) status.append(node("span", "", "Saving your order…"));
    else if (lastUndo) status.append(action("Undo move", () => { if (lastUndo) queueMove(lastUndo); }));
    if (announcement) status.append(node("span", "people-workspace__sr-only", announcement));
    if (frequency || query) status.append(node("span", "", "Use Your order with search cleared to move people."));
  }
  function makeRow(person: Person): HTMLElement {
    const row = node("li", "people-workspace__row"); row.dataset.personId = person.personId;
    const main = node("div", "people-workspace__row-main");
    const grip = action("⠿", () => {}, `Reorder ${person.name}`); grip.classList.add("people-workspace__grip"); grip.draggable = true;
    grip.title = "Drag to move, or use the up and down arrow keys";
    grip.addEventListener("keydown", event => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault(); step(person.personId, event.key === "ArrowUp" ? -1 : 1);
    });
    grip.addEventListener("dragstart", event => {
      if (frequency || query || orderPaused) { event.preventDefault(); return; }
      dragged = person.personId; row.classList.add("people-workspace__row--dragging");
      event.dataTransfer?.setData("text/plain", person.personId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    grip.addEventListener("dragend", clearDrag);
    row.addEventListener("dragover", event => {
      if (!dragged || dragged === person.personId) return;
      event.preventDefault(); row.classList.add("people-workspace__row--drop");
    });
    row.addEventListener("dragleave", () => row.classList.remove("people-workspace__row--drop"));
    row.addEventListener("drop", event => {
      if (!dragged) return;
      event.preventDefault();
      if (dragged !== person.personId) queueMove({ personId: dragged, beforeId: person.personId });
      clearDrag();
    });
    const rank = node("span", "people-workspace__rank");
    const identity = node("div", "people-workspace__identity");
    identity.append(node("span", "people-workspace__name", person.name), node("span", "people-workspace__identity-detail"), node("span", "people-workspace__identity-status"));
    const source = node("details", "people-workspace__membership");
    source.append(node("summary"), node("ul"));
    const controls = node("div", "people-workspace__row-controls");
    const up = action("↑", () => step(person.personId, -1), `Move ${person.name} up`); up.dataset.direction = "up";
    const down = action("↓", () => step(person.personId, 1), `Move ${person.name} down`); down.dataset.direction = "down";
    const note = action("+ Note", () => toggleNote(person.personId), `Note on ${person.name}`); note.classList.add("people-workspace__note-toggle");
    controls.append(up, down, note); main.append(grip, rank, identity, source, controls);
    row.append(main, node("div", "people-workspace__notes")); return row;
  }
  function clearDrag(): void { dragged = undefined; for (const row of rows.values()) row.classList.remove("people-workspace__row--dragging", "people-workspace__row--drop"); }
  function renderRows(): void {
    if (!workspace || destroyed) return;
    restoreFocus(() => {
      const ids = effectiveOrder(), byId = new Map(workspace!.people.map(person => [person.personId, person]));
      const byName = nameGroups(workspace!.people);
      let people = ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
      if (frequency) people.sort((a, b) => b.sourceCount - a.sourceCount || ids.indexOf(a.personId) - ids.indexOf(b.personId));
      people = people.filter(person => person.name.toLocaleLowerCase().includes(query));
      const visible = new Set(people.map(person => person.personId));
      const previous = [...list.children].filter((row): row is HTMLElement => row instanceof HTMLElement && Boolean(row.dataset.personId));
      const previousIds = new Set(previous.map(row => row.dataset.personId!));
      const sharedBefore = previous.filter(row => visible.has(row.dataset.personId!));
      const sharedAfter = people.filter(person => previousIds.has(person.personId));
      const reordered = sharedBefore.some((row, index) => row.dataset.personId !== sharedAfter[index]?.personId);
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const first = new Map<HTMLElement, { x: number; y: number }>();
      if (reordered && !reducedMotion) {
        const origin = list.getBoundingClientRect();
        for (const row of sharedBefore) { const rect = row.getBoundingClientRect(); first.set(row, { x: rect.left - origin.left, y: rect.top - origin.top }); }
      }
      // Capture the current visual position before cancelling an interrupted
      // move, so a quick second move continues from where the object is now.
      if (reordered || reducedMotion) { for (const animation of rowAnimations.values()) animation.cancel(); rowAnimations.clear(); }
      for (const [id, row] of rows) if (!visible.has(id)) row.remove();
      list.querySelector(".people-workspace__empty")?.remove();
      for (const [position, person] of people.entries()) {
        let row = rows.get(person.personId);
        if (!row) { row = makeRow(person); rows.set(person.personId, row); }
        row.querySelector(".people-workspace__name")!.textContent = person.name;
        row.querySelector(".people-workspace__rank")!.textContent = String(ids.indexOf(person.personId) + 1);
        row.querySelector(".people-workspace__identity-detail")!.textContent = identityDetail(person, byName.get(person.name.trim().toLocaleLowerCase())!);
        row.querySelector(".people-workspace__identity-status")!.textContent = person.identity === "verified" ? "" : `${person.identity === "conflict" ? "Identity needs a look" : "Identity not yet verified"}. Add what you know in a note to Lois.`;
        row.querySelector("summary")!.textContent = `On ${person.sourceCount} ${person.sourceCount === 1 ? "list" : "lists"}`;
        const memberships = row.querySelector(".people-workspace__membership ul")!; memberships.replaceChildren();
        for (const source of person.memberships) { const item = node("li"); item.append(link(source.name, source.url), node("span", "people-workspace__source-meta", ` · ${source.date.slice(0, 10)}`)); memberships.append(item); }
        const disabled = frequency || Boolean(query) || orderPaused;
        const grip = row.querySelector<HTMLButtonElement>(".people-workspace__grip")!; grip.disabled = disabled; grip.draggable = !disabled;
        row.querySelector<HTMLButtonElement>('[data-direction="up"]')!.disabled = disabled || ids.indexOf(person.personId) === 0;
        row.querySelector<HTMLButtonElement>('[data-direction="down"]')!.disabled = disabled || ids.indexOf(person.personId) === ids.length - 1;
        const notes = workspace!.notes.filter(note => note.personId === person.personId && note.state !== "hidden");
        const toggle = row.querySelector<HTMLButtonElement>(".people-workspace__note-toggle")!;
        toggle.textContent = notes.length ? `Notes ${notes.length}` : "+ Note"; toggle.setAttribute("aria-expanded", String(openNotes.has(person.personId)));
        renderNotes(row, person);
        if (list.children[position] !== row) list.insertBefore(row, list.children[position] ?? null);
      }
      if (!people.length) list.append(node("li", "people-workspace__empty", query ? "Nobody matches that name. Try another name or clear the search." : "No people imported yet. Ask Lois to read your past guestlists."));
      if (first.size) {
        const style = getComputedStyle(root), easing = style.getPropertyValue("--ease-out").trim();
        const durationToken = style.getPropertyValue("--dur-micro").trim();
        const duration = Number.parseFloat(durationToken) * (durationToken.endsWith("ms") ? 1 : 1000);
        const origin = list.getBoundingClientRect();
        for (const [row, before] of first) {
          const after = row.getBoundingClientRect(), x = before.x - (after.left - origin.left), y = before.y - (after.top - origin.top);
          if ((!x && !y) || !row.animate || !easing || !Number.isFinite(duration) || duration <= 0) continue;
          const animation = row.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0px, 0px)" }], { duration, easing });
          rowAnimations.set(row, animation);
          const clear = () => { if (rowAnimations.get(row) === animation) rowAnimations.delete(row); };
          animation.addEventListener("finish", clear, { once: true }); animation.addEventListener("cancel", clear, { once: true });
        }
      }
    });
  }
  function step(personId: string, direction: number): void {
    if (frequency || query || orderPaused) return;
    const ids = effectiveOrder(), index = ids.indexOf(personId), target = ids[index + direction];
    if (target) queueMove(direction < 0 ? { personId, beforeId: target } : { personId, afterId: target });
  }
  function queueMove(move: Move): void {
    if (!workspace || orderPaused) return;
    const ids = effectiveOrder(), index = ids.indexOf(move.personId);
    if (index < 0) return;
    const undo: Move = index > 0 ? { personId: move.personId, afterId: ids[index - 1] } : { personId: move.personId, beforeId: ids[1] };
    moves.push({ move, undo }); lastUndo = undefined; render();
    announcement = `${workspace.people.find(person => person.personId === move.personId)?.name ?? "Person"} moved to position ${effectiveOrder().indexOf(move.personId) + 1}.`;
    renderStatus();
    void processMoves();
  }
  async function processMoves(): Promise<void> {
    if (processingOrder || destroyed || !workspace) return;
    processingOrder = true;
    try {
      while (moves.length && !orderPaused && !destroyed) {
        const job = moves[0]!;
        job.request ??= { ...scope, personIds: moved(workspace!.order, job.move), baseRevision: workspace!.orderRevision, requestId: requestId() };
        try { accept(await api.order(job.request)); moves.shift(); lastUndo = job.undo; }
        catch (error) {
          if (error instanceof PeopleApiError && error.code === "conflict") {
            if (error.workspace) accept(error.workspace); else { try { accept(await api.read(scope)); } catch { /* Keep the last confirmed view. */ } }
            job.request = undefined;
            orderError = "Order changed elsewhere. Latest order loaded. Retry your move against it.";
          } else orderError = "Could not confirm your move. Showing the last saved order.";
          orderPaused = true;
        }
        render();
      }
    } finally { processingOrder = false; }
  }
  function latestNote(noteId: string): PeopleNote | undefined { return workspace?.notes.find(note => note.noteId === noteId); }
  function createDraft(person: Person): Draft {
    const prior = workspace?.notes.find(note => note.personId === person.personId && note.state === "draft" && !note.replyTo && note.actor.kind !== "lois");
    const editor = node("div", "people-workspace__sticky");
    const label = node("label", "people-workspace__note-label", `On ${person.name}`);
    const input = node("textarea"); input.rows = 3; label.append(input);
    const draft: Draft = { personId: person.personId, noteId: prior?.noteId ?? requestId(), text: prior?.text ?? "", dirty: false, editor, input, status: node("p", "people-workspace__note-status") };
    input.value = draft.text;
    input.addEventListener("input", () => {
      draft.text = input.value; draft.dirty = true;
      if (draft.timer) clearTimeout(draft.timer);
      draft.timer = setTimeout(() => { if (!draft.error) void saveDraft(draft); }, 500);
      updateDraft(draft); renderFooter();
    });
    input.addEventListener("blur", () => { if (!draft.error) void saveDraft(draft); });
    const controls = node("div", "people-workspace__note-controls");
    const done = action("Done", () => { void saveDraft(draft).then(saved => { if (saved && !destroyed) { openNotes.delete(person.personId); render(); } }); });
    done.classList.add("people-workspace__note-done");
    const remove = action("Remove draft", () => { void saveDraft(draft).then(saved => {
        if (!saved || destroyed) return;
        draft.text = ""; draft.input.value = ""; draft.dirty = true;
        void saveDraft(draft).then(hidden => { if (hidden && !destroyed) { openNotes.delete(person.personId); render(); } });
      }); });
    remove.classList.add("people-workspace__note-remove");
    controls.append(remove, done);
    editor.append(label, draft.status, controls); return draft;
  }
  function toggleNote(personId: string): void {
    const person = workspace?.people.find(item => item.personId === personId); if (!person) return;
    if (openNotes.has(personId)) {
      const draft = drafts.get(personId);
      if (draft) void saveDraft(draft).then(saved => { if (saved && !destroyed) { openNotes.delete(personId); render(); } });
      return;
    }
    else {
      openNotes.add(personId);
      if (!drafts.has(personId)) drafts.set(personId, createDraft(person));
    }
    render(); if (openNotes.has(personId)) drafts.get(personId)?.input.focus({ preventScroll: true });
  }
  function updateDraft(draft: Draft): void {
    const saved = latestNote(draft.noteId);
    const sent = saved?.state === "submitted" || saved?.state === "resolved";
    draft.status.replaceChildren();
    if (draft.error) draft.status.append(node("span", "", draft.error), action("Retry note", () => { draft.error = undefined; void saveDraft(draft); }));
    else draft.status.textContent = draft.saving ? "Saving note…" : draft.dirty ? "Not saved yet" : sent ? "Sent to Lois. You can keep editing." : saved?.state === "hidden" ? "Hidden from the list. Kept in All comments." : saved ? "Saved · not sent to Lois" : "Only you and Lois will see this note.";
    draft.editor.querySelector(".people-workspace__note-remove")!.textContent = sent && !draft.dirty ? "Hide from list" : "Remove draft";
    draft.input.setAttribute("aria-invalid", String(Boolean(draft.error)));
  }
  function renderNotes(row: HTMLElement, person: Person): void {
    const container = row.querySelector(".people-workspace__notes")!;
    if (!openNotes.has(person.personId)) { container.replaceChildren(); return; }
    const draft = drafts.get(person.personId)!;
    const saved = latestNote(draft.noteId);
    if (!draft.dirty && !draft.saving && !draft.error && saved) { draft.text = saved.state === "hidden" ? "" : saved.text; if (draft.input.value !== draft.text) draft.input.value = draft.text; }
    const history = container.querySelector<HTMLElement>(".people-workspace__note-history") ?? node("div", "people-workspace__note-history");
    history.replaceChildren();
    for (const note of workspace!.notes.filter(note => note.personId === person.personId && note.state !== "hidden" && note.noteId !== draft.noteId)) {
      const reply = node("div", note.actor.kind === "lois" ? "people-workspace__reply" : "people-workspace__past-note");
      reply.append(node("span", "people-workspace__note-by", note.actor.kind === "lois" ? "Lois" : note.state === "submitted" ? "Sent to Lois" : "Your note"), node("p", "", note.text)); history.append(reply);
    }
    for (const wave of workspace!.waves) {
      const snapshot = wave.notes.find(note => note.noteId === draft.noteId);
      if (snapshot) {
        const sent = node("div", "people-workspace__past-note"); sent.append(node("span", "people-workspace__note-by", `Sent to Lois · ${wave.status}`), node("p", "", snapshot.text)); history.append(sent);
      }
    }
    updateDraft(draft);
    if (!history.isConnected) container.append(history);
    if (draft.editor.parentElement !== container) container.append(draft.editor);
  }
  async function saveDraft(draft: Draft): Promise<boolean> {
    if (draft.timer) clearTimeout(draft.timer);
    if (draft.saving) return draft.saving;
    if (!draft.dirty || destroyed) return !draft.dirty;
    if (!draft.text.trim() && !latestNote(draft.noteId) && !draft.request) { draft.dirty = false; updateDraft(draft); return true; }
    draft.saving = (async () => {
      try {
        do {
          const hide = !draft.text.trim();
          draft.request ??= { ...scope, noteId: draft.noteId, personId: draft.personId, text: hide ? latestNote(draft.noteId)!.text : draft.text, state: hide ? "hidden" : "draft", baseRevision: latestNote(draft.noteId)?.revision ?? 0, requestId: requestId() };
          const sent = draft.request;
          accept(await api.note(sent)); draft.request = undefined;
          draft.dirty = sent.state === "hidden" ? Boolean(draft.text.trim()) : draft.text !== sent.text; draft.error = undefined;
        } while (draft.dirty && !destroyed);
        return true;
      } catch (error) {
        if (error instanceof PeopleApiError && error.code === "conflict") {
          if (error.workspace) accept(error.workspace);
          draft.request = undefined; draft.error = "This note changed elsewhere. Your text is kept here; retry to save it over the latest version.";
        } else draft.error = "Could not confirm this save. Your text is still here.";
        return false;
      } finally { draft.saving = undefined; render(); }
    })();
    updateDraft(draft); renderFooter(); return draft.saving;
  }
  function pendingWave(): PeopleNotesWave | undefined { return workspace?.waves.find(wave => wave.status === "pending"); }
  function renderAllComments(): void {
    allComments.replaceChildren();
    allComments.hidden = !workspace?.notes.length;
    if (!workspace) return;
    allComments.append(node("summary", "", `All comments (${workspace.notes.length})`));
    for (const note of workspace.notes.filter(note => !note.replyTo)) {
      const person = workspace.people.find(person => person.personId === note.personId);
      const thread = node("div", "people-workspace__comment-thread");
      thread.append(node("p", "people-workspace__note-by", `${person?.name ?? note.personId} · ${note.state}`), node("p", "", note.text));
      for (const reply of workspace.notes.filter(reply => reply.replyTo === note.noteId)) thread.append(node("p", "people-workspace__note-by", reply.actor.kind === "lois" ? "Lois" : "You"), node("p", "", reply.text));
      allComments.append(thread);
    }
  }
  function renderFooter(): void {
    footer.replaceChildren(); if (!workspace) return;
    const draftsCount = workspace.notes.filter(note => note.state === "draft" && !note.replyTo && note.actor.kind !== "lois").length;
    const dirty = [...drafts.values()].some(draft => draft.dirty && draft.text.trim());
    const pending = pendingWave();
    const label = node("p", "people-workspace__wave-status"); label.setAttribute("role", "status");
    if (waveError) label.textContent = waveError;
    else if (submitting) label.textContent = "Saving your notes for Lois…";
    else if (pending) label.textContent = "Notes are with Lois. Keep arranging people or writing new notes.";
    else if (workspace.waves.at(-1)?.status === "failed") label.textContent = "Lois could not finish the last notes. Saved replies are in each person’s notes.";
    else if (workspace.waves.at(-1)?.status === "completed") label.textContent = "Lois’s replies are in each person’s notes.";
    else label.textContent = `${draftsCount} saved ${draftsCount === 1 ? "note" : "notes"}${dirty ? " · unsaved edits" : ""}`;
    const send = action("Send notes to Lois", () => { void submit(); });
    send.disabled = Boolean(pending || submitting || (!draftsCount && !dirty));
    footer.append(label, send);
    if (waveError && submission) footer.append(action("Retry sending notes", () => { void submit(); }));
    if ((retryWave || pending) && !continuing) footer.append(action("Ask Lois to continue", () => { const wave = retryWave ?? pending; if (wave) void continueWave(wave); }));
  }
  async function continueWave(wave: PeopleNotesWave): Promise<void> {
    if (continuing || destroyed) return;
    if (workspace?.waves.some(saved => saved.waveId === wave.waveId && saved.status === "completed")) {
      retryWave = undefined; waveError = ""; renderFooter(); return;
    }
    continuing = true; waveError = ""; retryWave = undefined; renderFooter();
    try { await onWave(scope, wave); }
    catch (error) { waveError = `Notes saved. Lois could not finish: ${message(error)}`; retryWave = wave; }
    finally { continuing = false; await refresh(); }
  }
  async function submit(): Promise<void> {
    if (submitting || destroyed || !workspace || (pendingWave() && !submission)) return;
    submitting = true; waveError = ""; renderFooter();
    let wave: PeopleNotesWave | undefined;
    try {
      // A transport retry repeats its exact immutable submission. A new wave
      // first saves every open draft; no model roundtrip is needed for a draft.
      if (!submission) {
        const saved = await Promise.all([...drafts.values()].map(saveDraft));
        if (saved.some(result => !result)) { waveError = "Some notes are not saved. Retry those notes before sending."; return; }
        const noteIds = workspace.notes.filter(note => note.state === "draft" && !note.replyTo && note.actor.kind !== "lois").map(note => note.noteId);
        if (!noteIds.length) return;
        submission = { ...scope, noteIds, baseRevision: workspace.notesRevision, requestId: requestId() };
      }
      const result = await api.submit(submission); accept(result.workspace); submission = undefined; wave = result.wave;
    } catch (error) {
      if (error instanceof PeopleApiError && error.code === "conflict") { if (error.workspace) accept(error.workspace); submission = undefined; }
      waveError = `Could not confirm sending these notes. ${message(error)}`;
    } finally { submitting = false; render(); }
    if (wave) await continueWave(wave);
  }
  async function refresh(): Promise<void> {
    const read = ++readNumber;
    try { const next = await api.read(scope); if (!destroyed && read === readNumber) { accept(next); loadError = ""; render(); } }
    catch (error) { if (!destroyed && read === readNumber) { loadError = message(error); render(); } }
  }
  render(); void refresh();
  return {
    refresh,
    destroy() {
      destroyed = true; readNumber++;
      for (const draft of drafts.values()) if (draft.timer) clearTimeout(draft.timer);
      for (const animation of rowAnimations.values()) animation.cancel(); rowAnimations.clear();
      root.remove();
    },
  };
}
