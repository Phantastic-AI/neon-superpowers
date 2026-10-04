// hg/lois-flow — Lois, wired: one real conversation over the bound world.
//
// This is the "wire Lois" step: the storyboard showed the skeleton, Convo 0
// in research/ooux/lois-golden-convos.md pins how she talks, and this walks
// those beats as a chat-left / stage-right console (D-077) — the rail on the
// left is the conversation, the stage on the right surfaces whatever the beat
// is about (the browser reading your Luma, your people, the world, the plan).
//
// Every figure and every guest is REAL: aggregateReturning / deriveQueue over
// the vault. There is no authored chip walkthrough in front of her. The
// organizer speaks; Lois reasons; her tools and proposals surface on the stage.
// Nothing sends without the operator's yes; the send is dry-run.
// No em or en dashes in customer strings (T1); numerals in the mono wire
// register (fmt); one word per state. COPY-PENDING.

import type { Entry, World } from "../../../../tools/projections/types.js";
import { deriveQueue } from "../../../../tools/projections/queue.js";
import { upcomingGathering } from "../world";
import {
  aggregateReturning,
  planWaves,
  type PastGuest,
} from "./plan";
import { proposedEntries, lifecycleEntries, type SessionDraft } from "./draft-entries";
import { selectSender, type RecordedMessage } from "./send";
import { installCommentMode, type WaveNote, type WaveReply } from "./comment-mode";
import { tellLois, type TellResponse } from "../lois/tell-client";
import type { MindOutput } from "../../../../packages/lois/mind.js";
import { createPeopleApi, type PeopleScope } from "../lois/people-client.js";
import { mountPeopleWorkspace } from "./people-workspace.js";
import type { PeopleView } from "../../../../tools/projections/people.js";

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const fmt = (n: number) => n.toLocaleString("en-US");

interface BrowserStatus {
  open?: boolean;
  url?: string;
  mode?: string;
  inputOwner?: string | null;
}

interface TraceUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  textTokens?: number;
}

interface TraceTurnProjection {
  seq: number;
  at: string;
  latencyMs?: number;
  steps?: number;
  toolCalls?: number;
  usage?: TraceUsage;
  label: string;
}

interface TraceLine {
  seq: number;
  at: string;
  actor: string;
  kind: string;
  label: string;
}

interface TraceProjection {
  ok: true;
  turns: TraceTurnProjection[];
  timeline: TraceLine[];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderHgLoisFlow(root: HTMLElement, world: World): void {
  const gathering = upcomingGathering(world);
  const ranked = gathering ? aggregateReturning(world, gathering.id) : [];
  const whenLong = gathering ? new Date(gathering.date).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "America/Los_Angeles",
  }) : "";

  // The remaining send preview is transient. People and organizer edits use
  // the durable workspace below, independently of this gathering snapshot.
  let session: Entry[] = [];
  let drafts: SessionDraft[] = [];
  let recorded: RecordedMessage[] = [];
  const choice = selectSender();

  const kept = (): PastGuest[] => ranked;
  const stagedWorld = (): World => ({ ...world, entries: [...world.entries, ...session] });

  // ---- the console shell: rail (conversation) + stage (the surfaced pane) ----
  const console_ = el("div", "console");
  const rail = el("section", "rail");
  const railHead = el("header", "rail__head");
  railHead.appendChild(el("span", "rail__mark", "superpowers"));
  railHead.appendChild(el("span", "rail__who", "LOIS · CONCIERGE"));
  rail.appendChild(railHead);
  const thread = el("div", "thread");
  rail.appendChild(thread);
  const stage = el("aside", "stage");
  console_.appendChild(rail);
  console_.appendChild(stage);
  const deskframe = el("div", "deskframe bloom");
  deskframe.appendChild(console_);
  root.appendChild(deskframe);

  const peopleApi = createPeopleApi();
  let peopleViews: PeopleView[] = [];
  let peopleScope: PeopleScope | undefined;
  let peopleMount: ReturnType<typeof mountPeopleWorkspace> | undefined;
  let peopleHost: HTMLElement | undefined;
  let peopleRead = 0;
  let stageRevision = 0;
  let stageKind: "ready" | "people" | "other" = "ready";
  let lastWorkStage: { build: (s: HTMLElement) => void; label: string } | undefined;
  const tabs = el("nav", "desk-tabs");
  tabs.setAttribute("aria-label", "Desk panes");
  const loisTab = el("button", "desk-tabs__lois", "Lois");
  const stageTab = el("button", "desk-tabs__stage", "People");
  const alternateTab = el("button", "desk-tabs__alternate", "People");
  loisTab.type = stageTab.type = alternateTab.type = "button";
  loisTab.dataset.deskTab = "lois";
  stageTab.dataset.deskTab = "stage";
  stageTab.hidden = true;
  alternateTab.dataset.deskTab = "alternate";
  alternateTab.hidden = true;
  const paneScroll = { lois: 0, stage: 0 };
  let pane: "lois" | "stage" = "lois";
  function selectPane(next: "lois" | "stage"): void {
    if (next === pane) return;
    paneScroll[pane] = window.scrollY;
    pane = next;
    deskframe.dataset.pane = pane;
    loisTab.setAttribute("aria-pressed", String(pane === "lois"));
    stageTab.setAttribute("aria-pressed", String(pane === "stage"));
    if (window.matchMedia("(max-width: 51.25rem)").matches) window.scrollTo({ top: paneScroll[pane], behavior: "instant" });
  }
  deskframe.dataset.pane = pane;
  loisTab.setAttribute("aria-pressed", "true");
  stageTab.setAttribute("aria-pressed", "false");
  loisTab.addEventListener("click", () => selectPane("lois"));
  stageTab.addEventListener("click", () => {
    selectPane("stage");
  });
  alternateTab.addEventListener("click", () => {
    if (stageKind === "people" && lastWorkStage) setStage(lastWorkStage.build);
    else renderPeopleStage();
    selectPane("stage");
  });
  function syncStageTabs(): void {
    stageTab.textContent = stageKind === "people" ? "People" : browserStageVisible ? "Browser" : "Workspace";
    alternateTab.hidden = stageKind === "people" ? !lastWorkStage : !peopleViews.length;
    alternateTab.textContent = stageKind === "people" ? lastWorkStage?.label ?? "Workspace" : "People";
  }
  tabs.append(loisTab, stageTab, alternateTab);
  deskframe.prepend(tabs);

  function sameScope(a: PeopleScope | undefined, b: PeopleScope | undefined): boolean {
    return !!a && !!b && a.contextId === b.contextId && a.viewId === b.viewId;
  }

  async function refreshPeople(show = false): Promise<void> {
    const request = ++peopleRead;
    const expectedStage = stageRevision;
    try {
      const views = await peopleApi.list();
      if (request !== peopleRead || !root.isConnected) return;
      peopleViews = views;
      if (!views.some((v) => sameScope(v, peopleScope))) {
        peopleMount?.destroy(); peopleMount = undefined; peopleHost = undefined;
        peopleScope = views.length === 1 ? { contextId: views[0]!.contextId, viewId: views[0]!.viewId } : undefined;
      }
      stageTab.hidden = !views.length && stageKind === "ready";
      syncStageTabs();
      if (views.length && (show || stageKind === "ready") && stageRevision === expectedStage && (stageKind !== "people" || !peopleHost)) renderPeopleStage();
      else await peopleMount?.refresh();
    } catch (error) {
      if (request !== peopleRead || !root.isConnected || stageRevision !== expectedStage || (!show && stageKind !== "ready")) return;
      setStage((s) => {
        s.appendChild(el("p", "stage__quiet", `Saved lists could not load. ${error instanceof Error ? error.message : String(error)}`));
        const retry = el("button", "desk-retry", "Retry lists");
        retry.type = "button";
        retry.addEventListener("click", () => void refreshPeople(true));
        s.appendChild(retry);
      });
    }
  }

  // Comment mode (D-081): comment on anything, in waves, back to the ONE brain
  // (D-111/D-113: the wave is a `tell` like everything else — the mind answers
  // each note in her turn's `replies`, and her say lands in the rail). Symmetric
  // (D-114): the returned api lets Lois drop her own stickies on the page.
  const cm = installCommentMode({
    frame: deskframe,
    echo: (line, who) => (who === "you" ? you(line) : lois(line)),
    onWave: async (notes: WaveNote[]): Promise<WaveReply[]> => {
      const message =
        `I left ${notes.length} ${notes.length === 1 ? "note" : "notes"} on the page: ` +
        notes.map((n) => `on ${n.anchor}: "${n.text}"`).join("; ");
      const stream = loisStream();
      const r = await tellLois(message, {
        onSay: (delta) => stream.append(delta),
      });
      if (!r.ok || !r.output) {
        lois(r.why ?? "I could not read the notes; my brain is not answering.");
        return [];
      }
      stream.done(r.output.say);
      landTurn(r, { skipUi: true, sayShown: stream.started() });
      const byAnchor = new Map(r.output.replies.map((x) => [x.on.trim().toLowerCase(), x.reply]));
      return notes
        .map((n) => ({ anchor: n.anchor, reply: byAnchor.get(n.anchor.trim().toLowerCase()) ?? "" }))
        .filter((x) => x.reply.length > 0);
    },
  });

  // append a Lois turn (one or more lines) to the thread, scroll into view
  function lois(...lines: string[]): void {
    const turn = el("div", "msg msg--lois");
    turn.appendChild(el("span", "msg__who", "LOIS"));
    for (const line of lines) turn.appendChild(el("p", "msg__say", line));
    thread.appendChild(turn);
    turn.scrollIntoView({ block: "nearest" });
  }

  // echo the operator's choice as a "you" line
  function you(text: string): void {
    const turn = el("div", "msg msg--you");
    turn.appendChild(el("p", "msg__say", text));
    thread.appendChild(turn);
    turn.scrollIntoView({ block: "nearest" });
  }

  // a group of chip choices; picking one echoes `echo` and runs `then`
  interface Choice { label: string; sub?: string; echo: string; then: () => void; hot?: boolean }
  function chips(...choices: Choice[]): void {
    const wrap = el("div", "chips");
    for (const c of choices) {
      const b = el("button", "chip" + (c.hot ? " chip--hot" : ""));
      b.type = "button";
      b.appendChild(el("span", "chip__label", c.label));
      if (c.sub) b.appendChild(el("span", "chip__sub", c.sub));
      b.addEventListener("click", () => {
        wrap.remove();
        you(c.echo);
        c.then();
      });
      wrap.appendChild(b);
    }
    thread.appendChild(wrap);
    wrap.scrollIntoView({ block: "nearest" });
    const first = wrap.querySelector("button");
    if (first instanceof HTMLElement) first.focus();
  }

  function setStage(build: (s: HTMLElement) => void, kind: "people" | "other" = "other"): void {
    stageRevision++;
    stageKind = kind;
    stage.classList.remove("stage--people");
    stage.innerHTML = "";
    browserStageVisible = false;
    build(stage);
    stageTab.hidden = false;
    if (kind === "other") lastWorkStage = { build, label: browserStageVisible ? "Browser" : "Workspace" };
    syncStageTabs();
    // Lois stickies whose target just appeared re-attach to the new stage.
    cm.reattach();
    cm.refreshAvailability();
  }

  // ---- the one brain, in the console (D-111/D-113) -------------------------
  // Everything the organizer says (typed or waved) goes to tellLois; everything
  // that comes back lands here: her say in the rail, her questions as stickies
  // on the things they concern (D-114), her drafts visible before they become
  // stageable into the real queue. Worker verdicts remain trace evidence. The surrounding chip walkthrough
  // is authored UI, but composer turns never substitute canned model output: a
  // dead brain is reported as itself.
  let herDrafts: MindOutput["proposals"] = [];
  let herPlan: string[] | null = null; // her authored plan steps (D-113: never the template's)
  let browserStageVisible = false;

  function busy(): () => void {
    const turn = el("div", "msg msg--lois msg--busy");
    turn.appendChild(el("span", "msg__who", "LOIS"));
    const row = el("p", "msg__say", "thinking…");
    const stop = el("button", "msg__stop", "✕ stop");
    stop.type = "button";
    stop.title = "cancel this turn";
    stop.addEventListener("click", () => {
      void fetch("/api/lois/cancel", { method: "POST" });
    });
    row.appendChild(stop);
    turn.appendChild(row);
    thread.appendChild(turn);
    turn.scrollIntoView({ block: "nearest" });
    return () => turn.remove();
  }

  /** A Lois message that fills as she writes (the streaming say, D-113). */
  function loisStream(): { append: (delta: string) => void; started: () => boolean; done: (finalText?: string) => void } {
    let turn: HTMLElement | null = null;
    let say: HTMLElement | null = null;
    return {
      started: () => turn !== null,
      append: (delta) => {
        if (!turn) {
          turn = el("div", "msg msg--lois");
          turn.appendChild(el("span", "msg__who", "LOIS"));
          say = el("p", "msg__say");
          turn.appendChild(say);
          thread.appendChild(turn);
        }
        say!.textContent = (say!.textContent ?? "") + delta;
        turn.scrollIntoView({ block: "nearest" });
      },
      done: (finalText) => {
        // Native-tool runs can stream an early-step `say` before the final
        // post-tool answer lands. The final typed turn is authority: keep the
        // latency win, then reconcile the visible sentence exactly once.
        if (say && finalText && say.textContent !== finalText) say.textContent = finalText;
        turn?.scrollIntoView({ block: "nearest" });
      },
    };
  }

  function landTurn(r: TellResponse, opts2: { skipUi?: boolean; sayShown?: boolean } = {}): void {
    const o = r.output;
    if (!r.ok || !o) {
      lois(r.why ?? "My brain is not answering.");
      // Tools can save useful work even when the final model turn fails.
      void refreshPeople();
      return;
    }
    if (o.say && !opts2.sayShown) lois(o.say);
    if (o.say) notify(o.say.slice(0, 120));

    // The mouth is the one customer utterance. Gate holds and structured
    // questions remain in the trace/output for evidence; echoing either here
    // makes one turn look like several competing instructions.

    // Her plan: authored steps replace the template on the plan pane.
    const planOut = o.proposals.find((p) => p.kind === "plan" && Array.isArray(p.steps));
    if (planOut) herPlan = (planOut.steps as unknown[]).filter((s): s is string => typeof s === "string");

    // Her drafts: stageable into the real queue, in HER words.
    const draftsOut = o.proposals.filter((p) => p.kind === "draft" && typeof p.body === "string");
    if (draftsOut.length > 0 && gathering) {
      herDrafts = draftsOut;
      chips({
        label: `STAGE HER ${fmt(draftsOut.length)} ${draftsOut.length === 1 ? "DRAFT" : "DRAFTS"}`,
        sub: "into the queue, nothing sends till you say",
        echo: "stage them",
        hot: true,
        then: stageHerDrafts,
      });
    }

    if (!opts2.skipUi) {
      const browserStarted = r.traceTail.some(
        (t) => t.kind === "tool.call" && (
          (t.actor === "diver" && t.label === "browser_start") ||
          (t.actor === "lois" && t.label === "dive_start")
        ),
      );
      const browserClosed = r.traceTail.some(
        (t) => t.kind === "tool.call" && (
          (t.actor === "diver" && t.label === "browser_close") ||
          (t.actor === "lois" && t.label === "dive_close")
        ),
      );
      let stageLanded = false;
      if (draftsOut.length > 0) {
        renderDraftPreview(draftsOut);
        stageLanded = true;
      }
      else if (browserStarted) {
        setStage(renderLiveBrowser);
        stageLanded = true;
      }
      else if (browserClosed) {
        setStage((s) => {
          s.appendChild(stageCaption("THE BROWSER"));
          s.appendChild(el("p", "stage__quiet", "Closed. Its isolated session is no longer running."));
        });
        stageLanded = true;
      }
      for (const u of o.ui) {
        const show = typeof u.show === "string" ? u.show : "";
        if (!stageLanded && !browserStarted && !browserClosed && show === "keep") { stageLanded = true; }
        else if (!stageLanded && !browserStarted && !browserClosed && show === "browser") { setStage(renderLiveBrowser); stageLanded = true; }
        else if (!stageLanded && !browserStarted && !browserClosed && show === "room") { renderPeopleStage(); stageLanded = true; }
        else if (!stageLanded && !browserStarted && !browserClosed && gathering && show === "plan") { renderStagePlan(); stageLanded = true; }
        else if (!stageLanded && !browserStarted && !browserClosed && gathering && show === "queue") { renderStageQueue(); stageLanded = true; }
      }
      const readPeople = r.traceTail.some(
        (t) => t.actor === "lois" && t.kind === "tool.call" && (t.label === "history" || t.label === "roster"),
      );
      if (!stageLanded && peopleViews.length && readPeople) renderPeopleStage();
      else if (!stageLanded && gathering && planOut) renderStagePlan();
    }
    void refreshPeople(!opts2.skipUi && o.ui.some((u) => u.show === "room") && stageKind === "people");
  }

  async function readBrowserStatus(): Promise<BrowserStatus | null> {
    try {
      const response = await fetch("/api/lois/browser/status");
      return (await response.json()) as BrowserStatus;
    } catch {
      return null;
    }
  }

  function fmtInt(n?: number): string {
    if (typeof n !== "number") return "—";
    return n.toLocaleString("en-US");
  }

  function formatTokenMetrics(usage?: TraceUsage): string {
    if (!usage) return "";
    const lines: string[] = [];
    if (typeof usage.totalTokens === "number") lines.push(`${fmtInt(usage.totalTokens)} total`);
    if (typeof usage.inputTokens === "number") lines.push(`${fmtInt(usage.inputTokens)} in`);
    if (typeof usage.outputTokens === "number") lines.push(`${fmtInt(usage.outputTokens)} out`);
    if (typeof usage.cacheReadTokens === "number") lines.push(`${fmtInt(usage.cacheReadTokens)} cache-r`);
    if (typeof usage.cacheWriteTokens === "number") lines.push(`${fmtInt(usage.cacheWriteTokens)} cache-w`);
    return lines.join(" · ");
  }

  async function readTraceProjection(): Promise<TraceProjection | null> {
    try {
      const response = await fetch("/api/lois/trace");
      if (!response.ok) return null;
      return (await response.json()) as TraceProjection;
    } catch {
      return null;
    }
  }

  function renderTracePanel(): HTMLElement {
    const panel = el("details", "trace-studio");
    const summary = el("summary", "trace-studio__summary", "TRACE/STUDIO");
    const meter = el("span", "trace-studio__summary-state", "loading…");
    summary.appendChild(meter);
    panel.appendChild(summary);

    const body = el("div", "trace-studio__body");
    const turns = el("div", "trace-studio__turns");
    const timeline = el("details", "trace-studio__timeline");
    const timelineSummary = el("summary", undefined, "TIMELINE");
    const timelineBody = el("ol", "trace-studio__timeline-list");
    timeline.appendChild(timelineSummary);
    timeline.appendChild(timelineBody);
    body.appendChild(turns);
    body.appendChild(timeline);
    panel.appendChild(body);

    const refresh = async (): Promise<void> => {
      const projection = await readTraceProjection();
      if (!projection) {
        meter.textContent = "trace unavailable";
        turns.textContent = "trace unavailable";
        return;
      }
      meter.textContent = `${projection.turns.length} turns`;
      turns.innerHTML = "";
      if (projection.turns.length === 0) {
        turns.textContent = "no turns yet";
      } else {
        for (const t of projection.turns.slice(-3).reverse()) {
          const row = el("div", "trace-studio__turn");
          const headline = el(
            "div",
            "trace-studio__turn-head",
            `${new Date(t.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })} · ${t.label}`,
          );
          const metrics = fmtInt(t.latencyMs);
          const detailBits = [`${metrics}ms`];
          if (typeof t.steps === "number") detailBits.push(`${fmtInt(t.steps)} step${t.steps === 1 ? "" : "s"}`);
          if (typeof t.toolCalls === "number") detailBits.push(`${fmtInt(t.toolCalls)} tool call${t.toolCalls === 1 ? "" : "s"}`);
          const usageBits = formatTokenMetrics(t.usage);
          if (usageBits) detailBits.push(usageBits);
          row.appendChild(headline);
          row.appendChild(el("div", "trace-studio__turn-metrics", detailBits.join(" · ")));
          row.appendChild(el("div", "trace-studio__turn-id", `seq ${t.seq}`));
          turns.appendChild(row);
        }
      }

      timelineBody.innerHTML = "";
      if (projection.timeline.length === 0) {
        timelineBody.appendChild(el("li", "trace-studio__timeline-empty", "no events yet"));
        return;
      }
      for (const event of projection.timeline.slice(-16).reverse()) {
        const line = el(
          "li",
          "trace-studio__timeline-line",
          `${event.seq} ${event.actor}/${event.kind}: ${event.label}`,
        );
        timelineBody.appendChild(line);
      }
    };

    void refresh();
    setInterval(refresh, 4000);
    return panel;
  }

  function startTurnBrowserWatch(): () => void {
    let live = true;
    const tick = async (): Promise<void> => {
      if (!live || browserStageVisible) return;
      const status = await readBrowserStatus();
      if (live && status?.open) setStage(renderLiveBrowser);
    };
    void tick();
    const id = setInterval(() => void tick(), 750);
    return () => {
      live = false;
      clearInterval(id);
    };
  }

  function sessionDraftsFrom(proposals: MindOutput["proposals"]): SessionDraft[] {
    const byFirst = new Map(ranked.map((g) => [g.firstName.toLowerCase(), g]));
    return proposals.flatMap((proposal) => {
      const guest = typeof proposal.to === "string" ? byFirst.get(proposal.to.toLowerCase()) : undefined;
      if (!guest || typeof proposal.body !== "string") return [];
      return [{
        person: guest.person,
        name: guest.name,
        email: guest.email,
        subject: typeof proposal.subject === "string" ? proposal.subject : "",
        body: proposal.body,
      }];
    });
  }

  interface DraftPreview {
    to: string;
    email?: string;
    subject: string;
    body: string;
  }

  function draftPreviewsFrom(proposals: MindOutput["proposals"]): DraftPreview[] {
    const byFirst = new Map(ranked.map((g) => [g.firstName.toLowerCase(), g]));
    return proposals.flatMap((proposal) => {
      if (typeof proposal.body !== "string") return [];
      const requestedTo = typeof proposal.to === "string" ? proposal.to.trim() : "";
      const guest = requestedTo ? byFirst.get(requestedTo.toLowerCase()) : undefined;
      return [{
        to: (guest?.name ?? requestedTo) || "Recipient not named",
        ...(guest?.email ? { email: guest.email } : {}),
        subject: typeof proposal.subject === "string" ? proposal.subject : "",
        body: proposal.body,
      }];
    });
  }

  function renderDraftPreview(proposals: MindOutput["proposals"]): void {
    const preview = draftPreviewsFrom(proposals);
    setStage((s) => {
      s.appendChild(stageCaption("HER DRAFTS", `${fmt(preview.length)} ready to read`));
      s.appendChild(el("p", "dryseal", "NOT IN THE QUEUE · NOTHING GOES TO ANYONE"));
      const stack = el("div", "qstack");
      for (const draft of preview) {
        const card = el("article", "qpaper");
        card.setAttribute("data-commentable", "");
        card.setAttribute("data-anchor", `the draft to ${draft.to}`);
        const to = el("div", "mailrow");
        to.appendChild(el("span", "k", "TO"));
        to.appendChild(el("span", "v", draft.email ? `${draft.to} <${draft.email}>` : draft.to));
        card.appendChild(to);
        const subject = el("div", "mailrow");
        subject.appendChild(el("span", "k", "SUBJECT"));
        subject.appendChild(el("span", "v v--subject", draft.subject));
        card.appendChild(subject);
        card.appendChild(el("p", "mailbody", draft.body));
        card.appendChild(el("p", "qaccount", "DRAFT · HELD HERE"));
        stack.appendChild(card);
      }
      s.appendChild(stack);
    });
  }

  function stageHerDrafts(): void {
    if (!gathering) return;
    const staged = sessionDraftsFrom(herDrafts);
    if (staged.length === 0) {
      lois("None of those drafts named someone on the list, so nothing was staged.");
      return;
    }
    drafts = staged;
    const base = world.entries.length + session.length;
    session = [...session, ...proposedEntries(drafts, gathering.context, gathering.id, base, new Date().toISOString())];
    renderStageQueue();
  }

  async function tellAndRender(text: string, echoOrganizer = true, options: { preserveStage?: boolean; focusComposer?: boolean } = {}): Promise<TellResponse> {
    const input = rail.querySelector<HTMLInputElement>(".composer__input");
    const send = rail.querySelector<HTMLButtonElement>(".composer__send");
    const composer = rail.querySelector<HTMLElement>(".composer");
    if (input) input.disabled = true;
    if (send) { send.disabled = true; send.textContent = "WORKING"; }
    composer?.setAttribute("aria-busy", "true");
    if (echoOrganizer) you(text);
    const stream = loisStream();
    const stopBusy = busy();
    const stopBrowserWatch = options.preserveStage ? () => {} : startTurnBrowserWatch();
    let busyUp = true;
    const clearBusy = () => { if (busyUp) { stopBusy(); busyUp = false; } };
    try {
      const r = await tellLois(text, {
        onSay: (delta) => { clearBusy(); stream.append(delta); },
      });
      clearBusy();
      stream.done(r.output?.say);
      landTurn(r, { sayShown: stream.started(), skipUi: options.preserveStage });
      return r;
    } catch (err) {
      clearBusy();
      lois(`The line to my brain dropped: ${err instanceof Error ? err.message : String(err)}.`);
      void refreshPeople();
      return { ok: false, why: err instanceof Error ? err.message : String(err), traceTail: [] };
    } finally {
      stopBrowserWatch();
      if (input) input.disabled = false;
      if (send) { send.disabled = false; send.textContent = "TELL HER"; }
      composer?.removeAttribute("aria-busy");
      if (options.focusComposer !== false) input?.focus({ preventScroll: true });
    }
  }

  // The jobs strip (D-119): a plain list under the rail head — what's running,
  // since when, ✕ to close. Polled; quiet when nothing runs.
  function mountJobsStrip(): void {
    if (rail.querySelector(".jobs")) return;
    const strip = el("div", "jobs");
    railHead.insertAdjacentElement("afterend", strip);
    const tick = async (): Promise<void> => {
      try {
        const r = await fetch("/api/lois/jobs");
        const { jobs } = (await r.json()) as { jobs: Array<{
          id: string;
          label: string;
          since?: number;
          state?: "working" | "waiting" | "open";
          phase?: "researching" | "waiting" | "partial" | "finishing" | "done" | "blocked" | "open";
          blocker?: string | null;
          artifactCount?: number;
          waitingOnHuman?: boolean;
          terminalSpeechReady?: boolean;
          leaseMode?: string;
          leaseOwner?: string | null;
        }> };
        strip.innerHTML = "";
        strip.classList.toggle("jobs--on", jobs.length > 0);
        for (const j of jobs) {
          const row = el("div", "jobs__row");
          const mins = j.since ? Math.max(1, Math.round((Date.now() - j.since) / 60000)) : null;
          const phase = j.phase ?? (j.state === "working" ? "researching" : j.state === "waiting" ? "waiting" : "open");
          const artifacts = typeof j.artifactCount === "number" && j.artifactCount > 0
            ? ` · ${fmt(j.artifactCount)} ${j.artifactCount === 1 ? "artifact" : "artifacts"}`
            : "";
          const ready = j.terminalSpeechReady ? " · answer below" : "";
          const copy = el("span", "jobs__copy");
          copy.appendChild(el("span", "jobs__label", `${phase}: ${j.label}${artifacts}${ready}${mins ? ` · ${mins}m` : ""}`));
          if (j.blocker) copy.appendChild(el("span", "jobs__blocker", j.blocker));
          row.appendChild(copy);
          if (j.leaseMode && j.leaseMode !== "closed") {
            const x = el("button", "jobs__x", "✕");
            x.type = "button";
            x.title = "close browser";
            x.addEventListener("click", () => {
              void fetch(`/api/lois/jobs/${j.id}/close`, { method: "POST" }).then(() => tick());
            });
            row.appendChild(x);
          }
          strip.appendChild(row);
        }
      } catch {
        // sidecar away; strip stays quiet
      }
    };
    void tick();
    setInterval(() => void tick(), 1500);
  }

  function mountBackgroundTranscript(): void {
    if (!("EventSource" in window) || root.dataset.backgroundTranscript === "on") return;
    root.dataset.backgroundTranscript = "on";
    const source = new EventSource("/api/lois/tell");
    source.addEventListener("turn", (event) => {
      try {
        const turn = JSON.parse((event as MessageEvent<string>).data) as TellResponse;
        landTurn(turn);
      } catch {
        // A malformed background event is trace evidence, never replacement copy.
      }
    });
  }

  function mountTraceStudio(): void {
    if (rail.querySelector(".trace-studio")) return;
    railHead.insertAdjacentElement("afterend", renderTracePanel());
  }

  // OS notification when something lands while the app is unfocused (D-119:
  // the job goes on and it will take a while).
  function notify(text: string): void {
    if (document.hasFocus() || !("Notification" in window)) return;
    if (Notification.permission === "granted") new Notification("Lois", { body: text });
  }

  // The composer: freeform words to Lois, in the rail, once the world is open.
  function mountComposer(): void {
    if (rail.querySelector(".composer")) return;
    mountJobsStrip();
    mountTraceStudio();
    mountBackgroundTranscript();
    const bar = el("div", "composer");
    const input = el("input", "composer__input");
    input.type = "text";
    input.placeholder = "say it to Lois, in your words…";
    const send = el("button", "composer__send", "TELL HER");
    send.type = "button";
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      input.value = "";
      void tellAndRender(v);
    };
    send.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    bar.appendChild(input);
    bar.appendChild(send);
    rail.appendChild(bar);
    input.focus();
  }

  function stageCaption(over: string, title?: string): HTMLElement {
    const h = el("div", "stage__head");
    h.appendChild(el("span", "stage__over", over));
    if (title) h.appendChild(el("span", "stage__title", title));
    return h;
  }

  /** The live viewport: her browser inside the System 7 frame. */
  function renderLiveBrowser(s: HTMLElement): void {
    browserStageVisible = true;
    s.appendChild(stageCaption("THE BROWSER", "her window, live"));
    const win = el("div", "macwin");
    const title = el("div", "macwin__title");
    title.appendChild(el("span", "macwin__close"));
    title.appendChild(el("span", "macwin__name", "Luma"));
    win.appendChild(title);
    const tool = el("div", "macwin__tool");
    tool.appendChild(el("span", "macwin__lbl", "Location:"));
    const urlEl = el("span", "macwin__url", "opening…");
    tool.appendChild(urlEl);
    const takeover = el("button", "macwin__handoff", "TAKE OVER");
    takeover.type = "button";
    const handback = el("button", "macwin__handoff", "BACK TO PANE");
    handback.type = "button";
    handback.hidden = true;
    tool.appendChild(takeover);
    tool.appendChild(handback);
    win.appendChild(tool);
    const pane = el("div", "macwin__pane");
    const body = el("div", "macwin__body macwin__body--live");
    const img = el("img", "macwin__live") as HTMLImageElement;
    img.alt = "her browser, live";
    body.appendChild(img);
    const wait = el("p", "stage__quiet", "Waiting for her window's first frame…");
    body.appendChild(wait);
    pane.appendChild(body);
    win.appendChild(pane);
    s.appendChild(win);
    const controlNote = el("p", "stage__hint", "The pane has control. Take over for sign-in or any real-human step; Lois is locked out until you hand it back.");
    s.appendChild(controlNote);

    let lastFrame: { url: string; data: string } | null = null;
    let momentAdded = false;
    const addBrowserMoment = (): void => {
      if (momentAdded || !lastFrame) return;
      momentAdded = true;
      const details = el("details", "browser-moment");
      const url = lastFrame.url.replace(/^https?:\/\//, "");
      const time = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      details.appendChild(el("summary", "browser-moment__summary", `Browser snapshot · ${time} · ${url}`));
      const snap = el("img", "browser-moment__img") as HTMLImageElement;
      snap.alt = `browser snapshot at ${url}`;
      snap.src = `data:image/jpeg;base64,${lastFrame.data}`;
      details.appendChild(snap);
      thread.appendChild(details);
    };
    const setControl = (state: BrowserStatus, note?: string) => {
      const open = state.open !== false;
      const foreground = state.mode === "foreground_hands";
      takeover.hidden = !open || foreground;
      handback.hidden = !open || !foreground;
      body.classList.toggle("macwin__body--locked", foreground || !open || state.inputOwner === "automation");
      if (state.url) urlEl.textContent = state.url.replace(/^https?:\/\//, "");
      else if (!open) urlEl.textContent = "closed";
      if (note) controlNote.textContent = note;
      else if (!open) controlNote.textContent = "Closed. Lois will reopen her saved profile when she needs the browser.";
      else if (foreground) controlNote.textContent = "You have control in the foreground window. Use BACK TO PANE when you are done.";
      else if (state.inputOwner === "automation") controlNote.textContent = "Lois has control. The pane is live for watching; input opens when she hands it back.";
      else controlNote.textContent = "The pane has control. Take over for sign-in or any real-human step.";
      if (!open) wait.textContent = "Her browser is closed.";
      else if (foreground) wait.textContent = "Waiting for your hands in the foreground window.";
      else if (state.inputOwner === "automation") wait.textContent = "Lois is using the browser.";
    };
    const refreshControl = async (note?: string): Promise<void> => {
      try {
        const state = await readBrowserStatus();
        if (state) setControl(state, note);
      } catch {
        // sidecar away; keep current visible state
      }
    };
    const handoff = async (action: "summon" | "dismiss") => {
      takeover.disabled = true;
      handback.disabled = true;
      try {
        const response = await fetch(`/api/lois/browser/${action}`, { method: "POST" });
        const result = await response.json() as { ok?: boolean; note?: string };
        await refreshControl(result.note);
      } catch {
        controlNote.textContent = "The handoff did not complete. Browser input remains locked to its current owner.";
      } finally {
        takeover.disabled = false;
        handback.disabled = false;
      }
    };
    takeover.addEventListener("click", () => void handoff("summon"));
    handback.addEventListener("click", () => void handoff("dismiss"));
    void refreshControl();
    const statusTimer = setInterval(() => void refreshControl(), 2500);

    const src = new EventSource("/api/lois/browser/stream");
    src.addEventListener("frame", (ev) => {
      try {
        const f = JSON.parse((ev as MessageEvent).data) as { url: string; data: string };
        lastFrame = f;
        img.src = `data:image/jpeg;base64,${f.data}`;
        img.classList.add("macwin__live--on");
        wait.remove();
        urlEl.textContent = f.url.replace(/^https?:\/\//, "");
        addBrowserMoment();
      } catch {
        // skip malformed frame
      }
    });

    // Input forwarding (embed phase 2): your clicks and keys go to her REAL
    // browser and nowhere else — the model never sees a keystroke.
    const post = (ev: unknown) => void fetch("/api/lois/browser/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ev),
    });
    body.tabIndex = 0;
    img.addEventListener("click", (e) => {
      const r = img.getBoundingClientRect();
      post({ type: "click", nx: (e.clientX - r.left) / r.width, ny: (e.clientY - r.top) / r.height });
      body.focus();
    });
    body.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey) return; // browser shortcuts stay yours
      e.preventDefault();
      if (e.key.length === 1) post({ type: "text", text: e.key });
      else post({ type: "key", key: e.key });
    });
    body.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text");
      if (text) { e.preventDefault(); post({ type: "text", text }); }
    });
    // Stop streaming when the pane leaves the stage.
    const watch = new MutationObserver(() => {
      if (!document.contains(win)) {
        src.close();
        clearInterval(statusTimer);
        watch.disconnect();
      }
    });
    watch.observe(stage, { childList: true });
  }

  function renderPeopleStage(): void {
    setStage((s) => {
      stageKind = "people";
      s.classList.add("stage--people");
      stageTab.hidden = false;
      if (!peopleViews.length) {
        s.appendChild(stageCaption("YOUR PEOPLE"));
        s.appendChild(el("p", "stage__quiet", "No saved list yet. Tell Lois which past event lists to read."));
        return;
      }
      if (peopleViews.length > 1) {
        const label = el("label", "people-view-label", "Saved list");
        const select = el("select", "people-view-select");
        select.appendChild(new Option("Choose a list", ""));
        peopleViews.forEach((view, index) => select.appendChild(new Option(`${view.contextName} · ${view.name}`, String(index))));
        const current = peopleViews.findIndex((view) => sameScope(view, peopleScope));
        select.value = current < 0 ? "" : String(current);
        select.addEventListener("change", () => {
          const view = select.value === "" ? undefined : peopleViews[Number(select.value)];
          peopleMount?.destroy(); peopleMount = undefined; peopleHost = undefined;
          peopleScope = view ? { contextId: view.contextId, viewId: view.viewId } : undefined;
          renderPeopleStage();
        });
        label.appendChild(select); s.appendChild(label);
      }
      if (!peopleScope) return;
      if (!peopleHost) {
        peopleHost = el("div", "people-workspace-host");
        s.appendChild(peopleHost);
        peopleMount = mountPeopleWorkspace(peopleHost, {
          api: peopleApi, scope: peopleScope,
          onWave: async (scope, wave) => {
            you(`I left ${wave.notes.length} ${wave.notes.length === 1 ? "note" : "notes"} on the people list.`);
            const result = await tellAndRender(
              `Read and act on the saved people note wave ${JSON.stringify({ ...scope, waveId: wave.waveId })}. Use people_read for the immutable wave and current order. Save any requested changes, reply to each note using its stable IDs, then finish this wave. Do not treat a reply as proof that a requested action was done.`,
              false, { preserveStage: true, focusComposer: false },
            );
            await refreshPeople();
            if (!result.ok) throw new Error(result.why ?? "Lois did not finish reading the notes.");
          },
        });
      } else {
        s.appendChild(peopleHost);
        void peopleMount?.refresh();
      }
    }, "people");
  }

  function planArc(): HTMLElement {
    const arc = el("div", "planarc");
    for (const [d, w] of [["TODAY", "invite all"], ["SAT", "nudge quiet"], ["SUN", "remind"], [whenLong.split(",")[0].slice(0, 3).toUpperCase(), "dinner"]]) {
      const step = el("span", "planarc__step");
      step.appendChild(el("span", "planarc__d", d));
      step.appendChild(el("b", undefined, w));
      arc.appendChild(step);
    }
    return arc;
  }

  function renderStagePlan(): void {
    if (!gathering) return;
    setStage((s) => {
      s.appendChild(stageCaption("THE PLAN", gathering.name));
      s.appendChild(planArc());
      const waves = el("ul", "wavelist");
      for (const w of herPlan ?? planWaves(kept().length)) waves.appendChild(el("li", undefined, w));
      s.appendChild(waves);
      const cards = el("div", "cardrow");
      const c1 = el("div", "icard icard--go");
      c1.appendChild(el("div", "icard__t", "Re-invite the regulars"));
      c1.appendChild(el("div", "icard__s", `${fmt(kept().length)} KEPT · EMAIL · DRAFTED`));
      cards.appendChild(c1);
      const c2 = el("div", "icard");
      c2.appendChild(el("div", "icard__t", "Invite new people"));
      c2.appendChild(el("div", "icard__s", "EMAIL · WHEN YOU'RE READY"));
      cards.appendChild(c2);
      s.appendChild(cards);
    });
  }

  function renderStageQueue(): void {
    if (!gathering) return;
    const view = deriveQueue(stagedWorld(), gathering.id);
    const c = view.counts;
    const phase: "drafts" | "approved" | "sent" =
      session.some((e) => e.type === "released") ? "sent" : session.some((e) => e.type === "approved") ? "approved" : "drafts";
    setStage((s) => {
      s.appendChild(stageCaption("THE QUEUE", `${fmt(c.queued.count + c.approved.count + c.released.count + c.landed.count)} drafted`));
      const counts = el("div", "qcounts");
      const mk = (label: string, n: number) => { const sp = el("span"); sp.appendChild(document.createTextNode(label + " ")); sp.appendChild(el("b", undefined, String(n))); counts.appendChild(sp); };
      mk("WRITTEN", c.queued.count); mk("APPROVED", c.approved.count); mk("SENT", c.released.count + c.landed.count);
      s.appendChild(counts);
      s.appendChild(el("p", "dryseal", "SAFE PREVIEW · NOTHING GOES TO ANYONE"));
      const byPerson = new Map(drafts.map((d) => [d.person, d]));
      const stack = el("div", "qstack");
      for (const row of view.rows.slice(0, 6)) {
        const d = row.person ? byPerson.get(row.person) : undefined;
        const card = el("article", "qpaper");
        card.setAttribute("data-commentable", "");
        card.setAttribute("data-anchor", `the draft to ${d?.name ?? row.addressee ?? "this guest"}`);
        const to = el("div", "mailrow"); to.appendChild(el("span", "k", "TO")); to.appendChild(el("span", "v", row.addressee ? `${row.addressee} <${d?.email ?? ""}>` : (d?.email ?? ""))); card.appendChild(to);
        const su = el("div", "mailrow"); su.appendChild(el("span", "k", "SUBJECT")); su.appendChild(el("span", "v v--subject", d?.subject ?? "")); card.appendChild(su);
        card.appendChild(el("p", "mailbody", row.text ?? d?.body ?? ""));
        card.appendChild(el("p", "qaccount", `FROM YOUR GMAIL · EMAIL · ${row.status.toUpperCase()}`));
        stack.appendChild(card);
      }
      if (view.rows.length > 6) stack.appendChild(el("p", "stage__quiet", `and ${fmt(view.rows.length - 6)} more like these`));
      s.appendChild(stack);
    });

    if (phase === "drafts") {
      chips({ label: `APPROVE ALL ${fmt(view.rows.length)}`, sub: "you have read them", echo: "approve them", hot: true, then: approveAll });
    } else if (phase === "approved") {
      chips({ label: "PREVIEW THE SEND", sub: "shows the run, sends nothing", echo: "run the preview", hot: true, then: sendAll });
    }
  }

  function approveAll(): void {
    if (!gathering) return;
    const base = world.entries.length + session.length;
    session = [...session, ...lifecycleEntries(drafts, gathering.context, gathering.id, "approved", base, new Date().toISOString())];
    lois(`Approved. ${fmt(drafts.length)} are ready. Run the preview and I show you exactly how it would go, without sending anything to anyone.`);
    renderStageQueue();
  }

  async function sendAll(): Promise<void> {
    if (!gathering) return;
    const results: RecordedMessage[] = [];
    for (const d of drafts) {
      if (!d.email) continue; // held, not dropped
      const res = await choice.sender.send({ to: d.email, toName: d.name, subject: d.subject, body: d.body });
      if (res.ok) {
        const rec = (choice.sender as { sent?: RecordedMessage[] }).sent?.find((m) => m.id === res.id);
        if (rec) results.push(rec);
      }
    }
    recorded = results;
    const at = new Date().toISOString();
    let base = world.entries.length + session.length;
    session = [...session, ...lifecycleEntries(drafts, gathering.context, gathering.id, "released", base, at)];
    base = world.entries.length + session.length;
    session = [...session, ...lifecycleEntries(drafts, gathering.context, gathering.id, "landed", base, at)];
    lois(
      `That is the whole run, as a preview. ${fmt(recorded.length)} written, nothing sent to anyone. In the real app these send from your own Gmail, a few at a time so they land properly.`,
      "When you are ready to add new people, paste me the names and I tell you who you can already reach.",
    );
    renderStageQueue();
    const done = el("div", "chips");
    const b = el("button", "chip chip--hot");
    b.type = "button";
    b.appendChild(el("span", "chip__label", "SEE THE SUMMARY"));
    b.addEventListener("click", () => {
      b.parentElement?.remove();
      you("show me the summary");
      lois(`In this preview I wrote ${fmt(recorded.length)} invites and sent none. When you connect your Gmail, this same run goes out for real.`);
    });
    done.appendChild(b);
    thread.appendChild(done);
    b.scrollIntoView({ block: "nearest" });
  }

  // Curtain up. A truly new vault gets one small orientation fork; either
  // answer enters the same model-backed conversation as freeform text.
  mountComposer();
  setStage((s) => {
    s.appendChild(stageCaption("READY"));
    s.appendChild(el("p", "stage__quiet", "What Lois is working on will appear here."));
  });
  stageKind = "ready";
  lastWorkStage = undefined;
  stageTab.hidden = true;
  void refreshPeople();
  const newVault = world.entries.length === 0
    && world.persons.length === 0
    && world.contexts.length === 0
    && world.gatherings.length === 0;
  if (newVault) {
    lois("I am Lois, the AI concierge in Superpowers. What kind of event are you throwing?");
    chips(
      {
        label: "TOPICAL",
        sub: "talks, demos, panels, themed dinners",
        echo: "I'm throwing a topical event.",
        then: () => void tellAndRender("I'm throwing a topical event.", false),
      },
      {
        label: "SOCIAL",
        sub: "birthdays, housewarmings, parties",
        echo: "I'm throwing a social event.",
        then: () => void tellAndRender("I'm throwing a social event.", false),
      },
    );
  } else {
    lois("Tell me what you're trying to get done.");
  }
}
