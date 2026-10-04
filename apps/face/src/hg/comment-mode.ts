// hg/comment-mode — the workshop affordance (D-081): freeform comment-on-
// anything, modeled on the Claude artifact comment UX, submitted to Lois in
// waves.
//
// The pattern (research/design/comment-mode-workshop.md):
//   - a TOGGLE enters comment mode (comment cursor + hover outline on any
//     [data-commentable] element);
//   - clicking one drops a YELLOW STICKY that snaps OUT of the newsprint
//     (tilted, off-paper) with a freeform composer;
//   - stickies collect in a batch TRAY; you SEND THE WAVE to Lois; while she
//     ingests, the page LOCKS (read-only);
//   - she replies inside each sticky's THREAD (call-and-response) and posts a
//     summary to the conversation;
//   - it goes back and forth in WAVES.
//
// The TWO FACES: a comment is a sticky on the page AND a thread in the
// sidebar. Clearing a sticky off the page does NOT delete it; the thread
// survives in the "all comments" sidebar (append-only: nothing is lost, the
// page just gets quieter). On mobile the sidebar takes over the whole page and
// the stickies stay floating.
//
// Lois's real interpretation of a wave is the engine step (D-082, GLM-5.3-fast
// via OpenRouter); here `onWave` supplies her replies. No em or en dashes in
// customer strings (T1).

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface WaveNote { anchor: string; text: string; }
export interface WaveReply { anchor: string; reply: string; }

export interface CommentModeOptions {
  frame: HTMLElement;
  onWave: (notes: WaveNote[]) => Promise<WaveReply[]>;
  echo: (line: string, who: "you" | "lois") => void;
}

interface Comment {
  id: number;
  anchor: string;
  target: HTMLElement | null;
  text: string;
  sent: boolean;
  onPage: boolean;
  replies: string[];
  node: HTMLElement | null; // the on-page sticky, null once cleared
  /** Who authored the sticky: the organizer, or Lois herself (D-114 symmetric). */
  who: "you" | "lois";
}

/** The API the console gets back: Lois can leave stickies too (D-114). */
export interface CommentModeApi {
  /**
   * Lois drops a sticky on the thing named by `anchor` (matched against
   * [data-anchor], exact then contains). No match YET: the note lands in the
   * All-comments sidebar and re-attaches when its target appears (reattach).
   */
  loisSticky: (anchor: string, text: string) => void;
  /** Call after the stage re-renders: off-page Lois stickies retry their target. */
  reattach: () => void;
  /** Show the comment affordance only when the stage has something to mark up. */
  refreshAvailability: () => void;
}

export function installCommentMode(opts: CommentModeOptions): CommentModeApi {
  const { frame } = opts;
  let on = false;
  let sidebarOpen = false;
  let counter = 0;
  const comments: Comment[] = [];

  // ---- toggle (top-right) ---------------------------------------------------
  const toggle = el("button", "cm-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-pressed", "false");
  toggle.title = "leave notes on anything, in your own words";
  toggle.innerHTML = '<span class="cm-toggle__ico">＋</span><span class="cm-toggle__label">Comment</span>';
  document.body.appendChild(toggle);
  toggle.hidden = true;

  // ---- batch tray (bottom-right, only while notes are pending) --------------
  const tray = el("div", "cm-tray");
  const trayCount = el("span", "cm-tray__count", "0 notes");
  const traySend = el("button", "cm-tray__send", "SEND TO LOIS");
  traySend.type = "button";
  tray.appendChild(trayCount);
  tray.appendChild(traySend);
  document.body.appendChild(tray);

  // ---- the all-comments handle (bottom-right pill) + sidebar (second face) --
  const handle = el("button", "cm-handle");
  handle.type = "button";
  handle.innerHTML = '<span class="cm-handle__ico">\u{1F5E8}</span><span class="cm-handle__count">0</span>';
  document.body.appendChild(handle);

  const sidebar = el("aside", "cm-sidebar");
  sidebar.hidden = true;
  const sbHead = el("div", "cm-sidebar__head");
  sbHead.appendChild(el("span", "cm-sidebar__title", "All comments"));
  const sbClose = el("button", "cm-sidebar__close", "×");
  sbClose.type = "button";
  sbHead.appendChild(sbClose);
  sidebar.appendChild(sbHead);
  const sbList = el("div", "cm-sidebar__list");
  sidebar.appendChild(sbList);
  document.body.appendChild(sidebar);

  // ---- lock veil ------------------------------------------------------------
  const veil = el("div", "cm-veil");
  veil.appendChild(el("p", "cm-veil__say", "Lois is reading your notes ..."));
  document.body.appendChild(veil);

  // ---- helpers --------------------------------------------------------------
  const pending = (): Comment[] => comments.filter((c) => !c.sent && c.text.trim().length > 0);
  const known = (): Comment[] => comments.filter((c) => c.text.trim().length > 0);

  function refreshUI(): void {
    const p = pending().length;
    trayCount.textContent = `${p} ${p === 1 ? "note" : "notes"}`;
    tray.classList.toggle("cm-tray--show", on && p > 0);
    traySend.disabled = p === 0;

    const total = known().length;
    handle.querySelector<HTMLElement>(".cm-handle__count")!.textContent = String(total);
    handle.classList.toggle("cm-handle--show", total > 0 && !sidebarOpen);

    if (sidebarOpen) renderSidebar();
  }

  function setMode(next: boolean): void {
    on = next;
    frame.classList.toggle("commenting", on);
    toggle.setAttribute("aria-pressed", on ? "true" : "false");
    toggle.classList.toggle("cm-toggle--on", on);
    const lbl = toggle.querySelector<HTMLElement>(".cm-toggle__label");
    if (lbl) lbl.textContent = on ? "Click anyone" : "Comment";
    refreshUI();
  }
  toggle.addEventListener("click", () => setMode(!on));

  // ---- sidebar (all threads, incl. those cleared off the page) --------------
  function openSidebar(): void { sidebarOpen = true; sidebar.hidden = false; document.body.classList.add("cm-sidebar-open"); renderSidebar(); refreshUI(); }
  function closeSidebar(): void { sidebarOpen = false; sidebar.hidden = true; document.body.classList.remove("cm-sidebar-open"); refreshUI(); }
  handle.addEventListener("click", openSidebar);
  sbClose.addEventListener("click", closeSidebar);

  function renderSidebar(): void {
    sbList.innerHTML = "";
    const items = known();
    if (items.length === 0) { sbList.appendChild(el("p", "cm-sidebar__empty", "No comments yet.")); return; }
    for (const c of items) {
      const card = el("div", "cm-card" + (c.who === "lois" ? " cm-card--lois" : ""));
      const h = el("div", "cm-card__anchor", `on ${c.anchor}`);
      if (!c.onPage) h.appendChild(el("span", "cm-card__flag", "off page"));
      card.appendChild(h);
      if (c.who === "lois") {
        const said = el("p", "cm-card__lois");
        said.appendChild(el("span", "cm-card__who", "LOIS"));
        said.appendChild(document.createTextNode(c.text));
        card.appendChild(said);
      } else {
        card.appendChild(el("p", "cm-card__you", c.text));
      }
      for (const r of c.replies) {
        const rep = el("p", "cm-card__lois");
        rep.appendChild(el("span", "cm-card__who", "LOIS"));
        rep.appendChild(document.createTextNode(r));
        card.appendChild(rep);
      }
      if (!c.sent) card.appendChild(el("p", "cm-card__wait", "waiting to send"));
      sbList.appendChild(card);
    }
  }

  // ---- placing a sticky -----------------------------------------------------
  frame.addEventListener(
    "click",
    (e) => {
      if (!on) return;
      const t = e.target as HTMLElement;
      if (t.closest(".cm-sticky") || t.closest(".cm-toggle") || t.closest(".cm-tray") || t.closest(".cm-handle") || t.closest(".cm-sidebar")) return;
      const target = t.closest<HTMLElement>("[data-commentable]");
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      const existing = comments.find((c) => c.target === target && c.onPage && !c.sent);
      if (existing) { existing.node?.querySelector("textarea")?.focus(); return; }
      addSticky(target);
    },
    true,
  );

  function addSticky(target: HTMLElement): void {
    const anchor = target.getAttribute("data-anchor") || "this";
    const id = ++counter;
    if (getComputedStyle(target).position === "static") target.style.position = "relative";
    const c: Comment = { id, anchor, target, text: "", sent: false, onPage: true, replies: [], node: null, who: "you" };
    comments.push(c);
    mountSticky(c);
    refreshUI();
  }

  // ---- Lois's own stickies (D-114: the symmetric face) ----------------------
  function findAnchorTarget(anchor: string): HTMLElement | null {
    const all = Array.from(frame.querySelectorAll<HTMLElement>("[data-anchor]"));
    const needle = anchor.trim().toLowerCase();
    return (
      all.find((n) => (n.getAttribute("data-anchor") || "").toLowerCase() === needle) ??
      all.find((n) => (n.getAttribute("data-anchor") || "").toLowerCase().includes(needle)) ??
      all.find((n) => needle.includes((n.getAttribute("data-anchor") || "").toLowerCase())) ??
      null
    );
  }

  function loisSticky(anchor: string, text: string): void {
    const body = text.trim();
    if (!body) return;
    const target = findAnchorTarget(anchor);
    if (target && getComputedStyle(target).position === "static") target.style.position = "relative";
    const c: Comment = {
      id: ++counter,
      anchor: target?.getAttribute("data-anchor") || anchor,
      target,
      text: body,
      sent: true,
      onPage: target !== null,
      replies: [],
      node: null,
      who: "lois",
    };
    comments.push(c);
    if (target) mountSticky(c);
    refreshUI();
  }

  /** Off-page Lois stickies retry their target after a stage re-render. */
  function reattach(): void {
    for (const c of comments) {
      if (c.who !== "lois" || c.onPage || c.node) continue;
      const target = findAnchorTarget(c.anchor);
      if (!target) continue;
      if (getComputedStyle(target).position === "static") target.style.position = "relative";
      c.target = target;
      c.onPage = true;
      mountSticky(c);
    }
    refreshUI();
  }

  function refreshAvailability(): void {
    const available = frame.querySelector("[data-commentable]") !== null;
    toggle.hidden = !available;
    if (!available && on) setMode(false);
  }

  function mountSticky(c: Comment): void {
    if (!c.target) return;
    const node = el("div", "cm-sticky" + (c.sent ? " cm-sticky--answered" : "") + (c.who === "lois" ? " cm-sticky--lois" : ""));
    node.style.setProperty("--tilt", `${(c.id % 2 === 0 ? 1 : -1) * (1 + (c.id % 3))}deg`);
    const head = el("div", "cm-sticky__head", c.who === "lois" ? `LOIS · on ${c.anchor}` : `on ${c.anchor}`);
    const close = el("button", "cm-sticky__x", "×");
    close.type = "button";
    close.title = c.sent ? "clear from page (kept in All comments)" : "discard";
    head.appendChild(close);
    node.appendChild(head);

    if (!c.sent) {
      const ta = el("textarea", "cm-sticky__input");
      ta.placeholder = "in your own words ...";
      ta.value = c.text;
      node.appendChild(ta);
      const foot = el("div", "cm-sticky__foot");
      const done = el("button", "cm-sticky__done", "DONE");
      done.type = "button";
      foot.appendChild(done);
      node.appendChild(foot);
      setTimeout(() => ta.focus(), 0);
      ta.addEventListener("input", () => { c.text = ta.value; refreshUI(); });
      ta.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); commit(); } });
      done.addEventListener("click", commit);
      function commit(): void {
        c.text = ta.value.trim();
        if (!c.text) { discard(c); return; }
        ta.setAttribute("readonly", "true");
        done.remove();
        node.classList.add("cm-sticky--ready");
        refreshUI();
      }
    } else {
      node.appendChild(el("p", "cm-sticky__said", c.text));
    }

    const thread = el("div", "cm-sticky__thread");
    for (const r of c.replies) thread.appendChild(replyEl(r));
    node.appendChild(thread);

    close.addEventListener("click", () => { if (c.sent) clearFromPage(c); else discard(c); });
    c.node = node;
    c.target.appendChild(node);
  }

  function replyEl(text: string): HTMLElement {
    const msg = el("div", "cm-sticky__reply");
    msg.appendChild(el("span", "cm-sticky__who", "LOIS"));
    msg.appendChild(document.createTextNode(text));
    return msg;
  }

  function discard(c: Comment): void {
    c.node?.remove();
    const i = comments.indexOf(c);
    if (i >= 0) comments.splice(i, 1);
    refreshUI();
  }

  function clearFromPage(c: Comment): void {
    c.node?.remove();
    c.node = null;
    c.onPage = false;
    refreshUI();
  }

  // ---- sending the wave -----------------------------------------------------
  traySend.addEventListener("click", async () => {
    const wave = pending();
    if (wave.length === 0) return;
    for (const c of wave) {
      const ta = c.node?.querySelector<HTMLTextAreaElement>(".cm-sticky__input");
      if (ta && !ta.hasAttribute("readonly")) {
        c.text = ta.value.trim();
        ta.setAttribute("readonly", "true");
        c.node?.querySelector(".cm-sticky__done")?.remove();
        c.node?.classList.add("cm-sticky--ready");
      }
    }
    const notes = wave.filter((c) => c.text).map((c) => ({ anchor: c.anchor, text: c.text }));
    if (notes.length === 0) return;
    for (const n of notes) opts.echo(`on ${n.anchor}: ${n.text}`, "you");

    document.body.classList.add("cm-locked");
    let replies: WaveReply[] = [];
    try {
      replies = await opts.onWave(notes);
    } finally {
      document.body.classList.remove("cm-locked");
    }
    for (const c of wave) {
      if (!c.text) continue;
      c.sent = true;
      const r = replies.find((x) => x.anchor === c.anchor);
      const line = r ? r.reply : "Got it, noted.";
      c.replies.push(line);
      if (c.node) {
        c.node.classList.add("cm-sticky--answered");
        c.node.querySelector(".cm-sticky__x")?.setAttribute("title", "clear from page (kept in All comments)");
        c.node.querySelector(".cm-sticky__thread")?.appendChild(replyEl(line));
      }
    }
    refreshUI();
  });

  return { loisSticky, reattach, refreshAvailability };
}
