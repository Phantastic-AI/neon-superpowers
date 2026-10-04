#!/usr/bin/env -S npx tsx
// App-backed source discovery proof. Only the visible composer initiates model
// work; HTTP/vault reads below are an oracle, never a source of model answers.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright-core";
import { parsePaidSmokeCli } from "./lois-paid-smoke.js";
import { runPaidSmokeApp } from "./lois-paid-app.js";
import { assertPeopleImportSmokeOutcome, assertPeopleImportProposalScope, createEmptyPeopleImportSeedVault } from "./lois-people-import-smoke.js";
import { openVault } from "../packages/vault/store.js";
import { readPeopleWorkspace, type PeopleWorkspace } from "../packages/vault/people-edits.js";
import type { PeopleView } from "./projections/people.js";

const PORTS = { sidecarPort: 5185, facePort: 5209 };
const TURN_TIMEOUT_MS = 360_000;
const WORLD_NAME = "3Cs";

/** Source entrances and user intent only. No expected people, counts or tool plan. */
export function peopleAppRequests(mockUrl: string): [string, string] {
  return [
    `Use my browser to combine my old dinner guestlists into a saved list in the ${WORLD_NAME} World. The historical Luma history is ${new URL("/account/3cs/history", mockUrl)}. Do not create a new event, publish anything, or contact guests.`,
    `Now use my professional network at ${new URL("/network", mockUrl)} to find investors, founders, or people with relationships that could help raise startup investment for Superpowers, our AI agent company. Add useful prospects to the same saved list alongside the past guests, with what you observed and why each could fit. Keep useful names even when contact details are missing, and do not guess those details. Do not create an event or send anything.`,
  ];
}

// Expected outcomes are deliberately isolated from both organizer prompts and
// mock page text. These names are synthetic source data, never production rules.
const EXPECTED = [
  { name: "Nina Patel", path: "/network/in/nina-patel", email: "nina.patel@example.test", recurring: true },
  { name: "Amara Chen", path: "/network/in/amara-chen", email: "amara.chen@example.test", recurring: false },
  { name: "Devon Brooks", path: "/network/people/fundraising", email: null, recurring: false },
] as const;

export function assertPeopleAppProspects(view: PeopleView, origin: string) {
  for (const expected of EXPECTED) {
    const people = view.people.filter(person => person.name === expected.name);
    if (people.length !== 1) throw new Error(`Missing or duplicated ${expected.recurring ? "recurring " : ""}prospect: ${expected.name}.`);
    const person = people[0];
    if (expected.recurring) {
      if (person.sourceCount !== 2 || person.memberships.length !== 2 || person.identity !== "verified") throw new Error("Recurring prospect lost its historical identity.");
    } else if (person.sourceCount !== 0 || person.memberships.length !== 0) throw new Error("New prospect has fabricated historical membership.");
    if (expected.email) {
      if (!person.anchors.some(anchor => anchor.kind === "email" && anchor.value === expected.email && anchor.verified)) throw new Error(`Missing observed verified contact for ${expected.name}.`);
    } else if (person.anchors.length !== 0 || person.identity !== "unresolved") throw new Error("List-only suggestion has an invented contact or verified identity.");
    const sourceUrl = `${origin}${expected.path}`;
    const findings = person.prospects.filter(finding => finding.evidence.includes(`url:${sourceUrl}`));
    if (findings.length !== 1) throw new Error(`Missing source evidence or duplicated finding for ${expected.name}.`);
    const finding = findings[0];
    const retained = (evidence: string[]) => evidence.includes(`url:${sourceUrl}`) && evidence.some(pointer => /^(observation:|artifact:)/.test(pointer));
    if (finding.accountId !== "mock-network-organizer" || !finding.url?.startsWith(`${origin}/network/`) || !retained(finding.evidence) || !finding.observationEntryId || !finding.reasonEntryId) throw new Error(`Missing retained source evidence for ${expected.name}.`);
    if (!finding.reason.text.trim() || finding.reason.epistemics !== "inferred" || !retained(finding.reason.evidence)) throw new Error(`Missing inferred, source-backed reason for ${expected.name}.`);
  }
  const prospects = view.people.reduce((count, person) => count + person.prospects.length, 0);
  if (prospects !== EXPECTED.length) throw new Error(`Unexpected prospect findings: ${prospects}.`);
  return {
    prospects, newPeople: 2,
    recurringPersonId: view.people.find(person => person.name === EXPECTED[0].name)!.personId,
    missingContactPersonId: view.people.find(person => person.name === EXPECTED[2].name)!.personId,
  };
}

export function assertPeopleAppTrace(trace: readonly Record<string, unknown>[]) {
  assertPeopleImportProposalScope(trace);
  for (const tool of ["browser_follow", "people_import_csv", "people_save_prospect", "people_read"]) {
    if (!trace.some(event => {
      if (event.kind !== "tool.return" || /"ok"\s*:\s*false/.test(String(event.label ?? ""))) return false;
      const call = trace.find(candidate => candidate.kind === "tool.call" && (event.refs as unknown[] | undefined)?.includes(candidate.seq));
      return ((event.detail ?? call?.detail) as { tool?: string } | undefined)?.tool === tool;
    })) throw new Error(`App proof has no successful ${tool} return.`);
  }
}

export function assertPeopleAppTurn(body: string): void {
  const events = body.replaceAll("\r\n", "\n").split("\n\n");
  const turn = events.find(event => event.split("\n").includes("event: turn"));
  if (!turn || !events.some(event => event.split("\n").includes("event: done"))) throw new Error("App turn SSE did not finish.");
  const data = JSON.parse(turn.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n"));
  if (data.ok !== true) throw new Error(`App turn failed: ${data.why ?? "no successful result"}`);
}

export function assertPeopleAppSession(session: {
  receipts: unknown[]; cleanAfterSession: boolean; chromeProcessResidue: number;
  cascadeClose: string; browserClose: string;
}): void {
  // These are the existing host's close receipts, never model-authored prose.
  const browserClosed = [
    "Closed the window. The session stays saved in the profile.",
    "No browser window is open.",
  ].includes(session.browserClose);
  if (session.receipts.length || !session.cleanAfterSession || session.chromeProcessResidue || session.cascadeClose !== "quiet" || !browserClosed) {
    throw new Error("App proof failed receipt, clean-HEAD or owned-runtime cleanup checks.");
  }
}

/** Mirror the app's worker-to-mouth landing evidence, scoped to this request. */
export function hasSettledPeopleAppResearch(trace: readonly Record<string, unknown>[], afterSeq: number): boolean {
  const reply = [...trace].reverse().find(event => Number(event.seq) > afterSeq && event.actor === "diver" && event.kind === "model.reply");
  if (!reply) return false;
  const heard = trace.find(event => Number(event.seq) > Number(reply.seq) && event.actor === "diver" && event.kind === "heard" && (event.detail as { jobId?: string } | undefined)?.jobId === (reply.detail as { jobId?: string } | undefined)?.jobId);
  return Boolean(heard && trace.some(event => Number(event.seq) > Number(heard.seq) && event.actor === "lois" && event.kind === "model.reply"));
}

async function getJson<T>(appUrl: string, path: string): Promise<T> {
  const response = await fetch(new URL(path, appUrl), { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`App read ${path.split("?")[0]} returned HTTP ${response.status}.`);
  return response.json() as Promise<T>;
}

export async function tell(page: Page, words: string): Promise<string> {
  const response = page.waitForResponse(value => value.request().method() === "POST" && new URL(value.url()).pathname === "/api/lois/tell", { timeout: 10_000 });
  await page.getByRole("textbox", { name: "say it to Lois, in your words…" }).fill(words);
  await page.getByRole("button", { name: "TELL HER", exact: true }).click();
  const stream = await response;
  if (!stream.ok() || !stream.headers()["content-type"]?.includes("text/event-stream")) throw new Error("Visible composer did not reach the app SSE endpoint.");
  // Let the ordinary client finish consuming SSE before asking CDP for its
  // completed body. An open event stream need not have a retrievable body yet.
  await page.waitForFunction(() => {
    const composer = document.querySelector(".composer");
    return composer !== null && !composer.hasAttribute("aria-busy");
  }, undefined, { timeout: TURN_TIMEOUT_MS });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const body = await Promise.race([stream.text(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("App turn SSE timed out.")), TURN_TIMEOUT_MS); })]).finally(() => clearTimeout(timeout));
  assertPeopleAppTurn(body);
  return body;
}

export function assertPeopleAppResearchActive(jobs: Array<{ phase?: string }>, mouthSettled: boolean): void {
  if (mouthSettled && jobs.some(job => job.phase === "partial")) {
    throw new Error("The worker stopped unfinished and Lois answered without resuming it.");
  }
}

/** A terminal worker and landed mouth response matter, not just early saved rows. */
export async function waitForSavedView(appUrl: string, check: (view: PeopleView) => unknown, settled: () => boolean, traceCursor: () => number): Promise<PeopleView> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let last = "No completed saved view";
  while (Date.now() < deadline) {
    const observedCursor = traceCursor();
    const [{ views }, { jobs }] = await Promise.all([
      getJson<{ views: PeopleView[] }>(appUrl, "/api/lois/people"),
      getJson<{ jobs: Array<{ phase?: string; blocker?: string }> }>(appUrl, "/api/lois/jobs"),
    ]);
    const mouthSettled = settled();
    // Never combine an old HTTP job state with a newly landed mouth/resume.
    if (observedCursor !== traceCursor()) {
      await new Promise(done => setTimeout(done, 750));
      continue;
    }
    try {
      if (views.length !== 1 || views[0].contextName !== WORLD_NAME) throw new Error("Expected one explicitly requested World/view.");
      check(views[0]);
      if (jobs.some(job => job.phase === "done") && mouthSettled) return views[0];
      last = `Saved data arrived; worker/mouth phase is ${jobs.map(job => job.phase).join(", ") || "absent"}.`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (jobs.some(job => job.phase === "done") && mouthSettled) throw error;
    }
    if (jobs.some(job => job.phase === "blocked" || job.phase === "waiting")) throw new Error(`App research needs attention: ${jobs.map(job => job.blocker ?? job.phase).join("; ")}`);
    assertPeopleAppResearchActive(jobs, mouthSettled);
    await new Promise(done => setTimeout(done, 750));
  }
  throw new Error(`App source proof timed out: ${last}`);
}

const jsonFile = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
const jsonLines = (path: string): Record<string, unknown>[] => readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));

export async function runPeopleAppSmoke(argv: string[]) {
  const paid = parsePaidSmokeCli(argv); // Cold gate before even allocating a scratch seed.
  const options = { ...paid, seedVaultDir: createEmptyPeopleImportSeedVault(paid.baseDir) };
  let evidenceDir: string | undefined;
  let result: Record<string, unknown> | undefined;
  await runPaidSmokeApp(options, async ({ appUrl, mockUrl, run }) => {
    evidenceDir = run.evidenceDir;
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" }).catch(async error => { await browser.close(); throw error; });
    page.setDefaultTimeout(15_000);
    const pageErrors: string[] = [], sse: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    const abort = new AbortController();
    let backgroundSse = "";
    const background = fetch(new URL("/api/lois/tell", appUrl), { signal: abort.signal }).then(async response => {
      if (!response.ok || !response.body) throw new Error("Background app SSE could not connect.");
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          backgroundSse += decoder.decode(value, { stream: true });
        }
      } finally { reader.releaseLock(); }
    }).catch(error => { if (!abort.signal.aborted) pageErrors.push(`Background SSE: ${String(error)}`); });
    try {
      const health = await getJson<{ mode: string; inference: { mode: string; model: string } }>(appUrl, "/api/lois/health");
      if (health.mode !== "smoke" || health.inference.mode !== "metered-smoke" || health.inference.model !== paid.inference.model) throw new Error("App is not the approved metered smoke runtime.");
      await page.goto(appUrl, { waitUntil: "domcontentloaded" });
      const requests = peopleAppRequests(mockUrl);
      let afterSeq = Number(jsonLines(run.tracePath).at(-1)?.seq ?? 0);
      const settled = () => hasSettledPeopleAppResearch(jsonLines(run.tracePath), afterSeq);
      const traceCursor = () => Number(jsonLines(run.tracePath).at(-1)?.seq ?? 0);
      sse.push(await tell(page, requests[0]));
      const imported = await waitForSavedView(appUrl, assertPeopleImportSmokeOutcome, settled, traceCursor);
      await page.screenshot({ path: resolve(run.evidenceDir, "people-imported.png"), fullPage: true });
      afterSeq = Number(jsonLines(run.tracePath).at(-1)?.seq ?? 0);
      sse.push(await tell(page, requests[1]));
      const origin = new URL(mockUrl).origin;
      const combined = await waitForSavedView(appUrl, view => {
        assertPeopleImportSmokeOutcome({ ...view, people: view.people.filter(person => person.memberships.length > 0) });
        assertPeopleAppProspects(view, origin);
      }, settled, traceCursor);
      const summary = assertPeopleAppProspects(combined, origin);
      if (combined.contextId !== imported.contextId || combined.viewId !== imported.viewId || summary.recurringPersonId !== imported.people.find(person => person.name === EXPECTED[0].name)?.personId) throw new Error("Discovery replaced the existing view or recurring identity.");
      const scope = new URLSearchParams({ contextId: combined.contextId, viewId: combined.viewId });
      const read = () => getJson<{ workspace: PeopleWorkspace }>(appUrl, `/api/lois/people?${scope}`).then(body => body.workspace);
      await page.getByRole("heading", { name: combined.name, exact: true }).waitFor();
      for (const expected of EXPECTED) await page.locator(".people-workspace__name").filter({ hasText: expected.name }).waitFor();
      await page.screenshot({ path: resolve(run.evidenceDir, "people-combined.png"), fullPage: true });
      const before = await read();
      await page.getByRole("button", { name: "Your order", exact: true }).click();
      const direction = before.order.indexOf(summary.missingContactPersonId) > 0 ? "up" : "down";
      await page.getByRole("button", { name: `Move ${EXPECTED[2].name} ${direction}`, exact: true }).click();
      await page.getByRole("button", { name: "Undo move", exact: true }).waitFor();
      await page.getByRole("button", { name: `Note on ${EXPECTED[2].name}`, exact: true }).click();
      const note = "Keep this suggestion on the list; contact details still need research.";
      await page.getByRole("textbox", { name: `On ${EXPECTED[2].name}`, exact: true }).fill(note);
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("textbox", { name: `On ${EXPECTED[2].name}`, exact: true }).waitFor({ state: "hidden" });
      const saved = await read();
      if (saved.orderRevision <= before.orderRevision || !saved.notes.some(value => value.personId === summary.missingContactPersonId && value.text === note && value.state === "draft")) throw new Error("Organizer edits did not reach the combined saved view.");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: combined.name, exact: true }).waitFor();
      const reloaded = await read();
      if (JSON.stringify(reloaded.order) !== JSON.stringify(saved.order) || JSON.stringify(reloaded.notes) !== JSON.stringify(saved.notes)) throw new Error("Reload lost organizer order or note.");
      const visibleIds = await page.locator(".people-workspace__row").evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.personId));
      if (JSON.stringify(visibleIds) !== JSON.stringify(saved.order)) throw new Error("Reload did not render the saved people order.");
      await page.screenshot({ path: resolve(run.evidenceDir, "people-reloaded.png"), fullPage: true });
      await page.setViewportSize({ width: 414, height: 900 });
      await page.locator('[data-desk-tab="stage"]').click();
      await page.screenshot({ path: resolve(run.evidenceDir, "people-phone.png"), fullPage: true });
      const vault = openVault(run.vaultDir);
      const reopened = readPeopleWorkspace(vault, combined.contextId, combined.viewId);
      if (!reopened || JSON.stringify(reopened.order) !== JSON.stringify(saved.order) || JSON.stringify(reopened.notes) !== JSON.stringify(saved.notes)) throw new Error("Reopening the vault lost saved organizer work.");
      if (vault.gatherings.some(gathering => gathering.upcoming) || vault.entries.some(entry => ["released", "landed"].includes(entry.type))) throw new Error("Read-only discovery created an upcoming event or outbound record.");
      assertPeopleAppTrace(jsonLines(run.tracePath));
      if (pageErrors.length) throw new Error(`App page errors: ${pageErrors.join("; ")}`);
      jsonFile(resolve(run.evidenceDir, "people-app-workspace.json"), reloaded);
      result = { proof: "app-backed-mock-storage", comprehension: "not-evaluated", runId: paid.runId, runRoot: run.root, appUrl, model: paid.inference.model, contextId: combined.contextId, viewId: combined.viewId, people: combined.people.length, ...summary, organizerEditsReloaded: true, tracePath: run.tracePath };
    } catch (error) {
      await page.screenshot({ path: resolve(run.evidenceDir, "people-app-failure.png"), fullPage: true }).catch(() => undefined);
      jsonFile(resolve(run.evidenceDir, "people-app-failure.json"), { error: error instanceof Error ? error.message : String(error), pageErrors });
      throw error;
    } finally {
      abort.abort(); await background;
      jsonFile(resolve(run.evidenceDir, "people-app-sse.json"), { foreground: sse, background: backgroundSse });
      await browser.close();
    }
  }, PORTS);
  if (!result || !evidenceDir) throw new Error("Combined app session ended without evidence.");
  const session = JSON.parse(readFileSync(resolve(evidenceDir, "manual-app-session.json"), "utf8"));
  assertPeopleAppSession(session);
  const complete = { ...result, green: true, head: session.head, usage: session.usage, receipts: 0 };
  jsonFile(resolve(evidenceDir, "people-app-smoke-result.json"), complete);
  return complete;
}

export function isDirectPeopleAppSmoke(metaUrl = import.meta.url, argv = process.argv): boolean {
  return Boolean(argv[1]) && pathToFileURL(resolve(argv[1])).href === metaUrl;
}
if (isDirectPeopleAppSmoke()) void runPeopleAppSmoke(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
