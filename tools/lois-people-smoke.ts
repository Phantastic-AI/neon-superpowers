// A clean, deterministic people-editing rehearsal over the actual face route
// and people HTTP handler. It proves storage and UI mechanics, not the model's
// ability to discover/import a live source. It owns no authenticated browser.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer as httpServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createServer as viteServer } from "vite";
import { chromium, type Browser, type Page } from "playwright-core";
import { openVault, registerContext } from "../packages/vault/store.js";
import { loadWorld } from "../packages/vault/world.js";
import { readPeopleWorkspace } from "../packages/vault/people-edits.js";
import { selectPeopleSources, importPeopleSource } from "../packages/organs/people.js";
import { handlePeopleApi } from "../sidecar/people-api.js";
import type { PeopleSourceRow } from "./projections/people.js";

export function seedPeopleSmoke(vaultDir: string) {
  const vault = openVault(vaultDir);
  const contextId = "smoke-dinners", viewId = "past-dinners";
  registerContext(vault, { id: contextId, name: "3Cs dinners", kind: "social", anchor: "email", created_at: "2026-09-05T12:00:00Z" });
  const sources = ["A", "B", "C"].map((id, i) => ({ platform: "mock-luma", accountId: "smoke-organizer", eventId: id, name: `3Cs Dinner ${id}`, date: `2026-08-${10 + i * 7}T19:00:00-07:00`, url: `https://example.test/dinners/${id}`, evidence: [`fixture:${id}`] }));
  selectPeopleSources(vault, { contextId, viewId, viewName: "The past dinner lists", sources, discoveryComplete: true });
  const row = (rowId: string, name: string, email?: string): PeopleSourceRow => ({ rowId, name, evidence: ["fixture:known-identity"], anchors: email ? [{ kind: "email", value: email, verified: true, evidence: "fixture:known-identity" }] : [] });
  for (const [i, rows] of [
    [0, [row("a1", "Avery Okafor", "avery@example.test"), row("s1", "Sam Rivera", "sam1@example.test"), row("t1", "Taylor Shah")]],
    [1, [row("a2", "Avery Okafor", "avery@example.test"), row("s2", "Sam Rivera", "sam2@example.test"), row("r1", "Riley Chen", "riley@example.test")]],
  ] as const) importPeopleSource(vault, { contextId, viewId, source: sources[i], rows: [...rows], readState: "read", evidence: [`fixture:${i}`] });
  return { vaultDir, world: loadWorld(vault), contextId, viewId };
}

export async function startPeopleSmoke() {
  const root = mkdtempSync(join(tmpdir(), "lois-people-smoke-"));
  const host = seedPeopleSmoke(join(root, "vault"));
  const server = httpServer((req, res) => {
    if (handlePeopleApi(req, res, host)) return;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/lois/world") res.end(JSON.stringify({ world: host.world }));
    else if (req.url === "/api/lois/jobs") res.end(JSON.stringify({ jobs: [] }));
    else if (req.url === "/api/lois/trace") res.end(JSON.stringify({ ok: true, turns: [], timeline: [] }));
    else { res.statusCode = 503; res.end(JSON.stringify({ error: "This editing rehearsal has no model or authenticated browser." })); }
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No smoke API address");
  let face;
  try {
    face = await viteServer({ configFile: false, root: resolve("apps/face"), server: { host: "127.0.0.1", port: 0, proxy: { "/api/lois": { target: `http://127.0.0.1:${address.port}`, changeOrigin: false } } } });
    await face.listen();
  } catch (error) { server.closeAllConnections(); server.close(); throw error; }
  const faceAddress = face.httpServer!.address();
  if (!faceAddress || typeof faceAddress === "string") throw new Error("No smoke face address");
  return { ...host, root, appUrl: `http://127.0.0.1:${faceAddress.port}/pane/lois`, async close() { await face.close(); server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); } };
}

async function checkPeopleContrast(page: Page) {
  // A literal browser script avoids tsx's function-name helper crossing the
  // serialization boundary; it reads computed page styles only.
  const pairs = await page.evaluate(`(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
    const luminance = rgb => rgb.slice(0, 3).map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((total, c, i) => total + c * [.2126, .7152, .0722][i], 0);
    return [".people-workspace__title", ".people-workspace__context", ".people-workspace__explanation", ".people-workspace__name", ".people-workspace__action:not(:disabled)", ".people-workspace__note-label", ".people-workspace__note-label textarea"].flatMap(selector => {
      const element = document.querySelector(selector);
      if (!element) return [];
      const style = getComputedStyle(element);
      let parent = element, background = [0, 0, 0, 0];
      while (parent && background[3] === 0) { background = rgba(getComputedStyle(parent).backgroundColor); parent = parent.parentElement; }
      const a = luminance(rgba(style.color)), b = luminance(background);
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      const large = Number.parseFloat(style.fontSize) >= 24 || (Number.parseFloat(style.fontSize) >= 18.66 && Number.parseInt(style.fontWeight) >= 700);
      return [{ selector, ratio, threshold: large ? 3 : 4.5 }];
    });
  })()` ) as Array<{ selector: string; ratio: number; threshold: number }>;
  if (pairs.length !== 7 || pairs.some(pair => pair.ratio < pair.threshold)) throw new Error(`People text contrast failed: ${JSON.stringify(pairs)}`);
  return pairs;
}

const productState = () => ({ head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), clean: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() === "" });
export function qualifyPeopleEvidence(start: ReturnType<typeof productState>, finish: ReturnType<typeof productState>) {
  return { ...start, clean: start.clean && finish.clean && start.head === finish.head };
}

export async function runPeopleSmoke() {
  const startedProduct = productState();
  const app = await startPeopleSmoke();
  const evidenceDir = join(app.root, "evidence"); mkdirSync(evidenceDir);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(app.appUrl, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "The past dinner lists" }).waitFor();
    const read = () => readPeopleWorkspace(loadWorld(openVault(app.vaultDir)), app.contextId, app.viewId)!;
    const before = read();
    if (before.people.length !== 5 || before.coverage.read !== 2 || before.coverage.selected !== 3) throw new Error("Fixture/source count mismatch");
    await page.getByRole("button", { name: "Your order", exact: true }).click();
    await page.evaluate(`document.addEventListener("click", () => {
      const start = performance.now();
      const before = [...document.querySelectorAll(".people-workspace__row")].map(row => row.dataset.personId).join();
      requestAnimationFrame(() => {
        const after = [...document.querySelectorAll(".people-workspace__row")].map(row => row.dataset.personId).join();
        window.peopleSmokeFeedback = { milliseconds: performance.now() - start, changed: before !== after };
      });
    }, { once: true, capture: true })`);
    await page.getByRole("button", { name: "Move Riley Chen up" }).click();
    await page.waitForFunction("window.peopleSmokeFeedback !== undefined");
    const localFeedback = await page.evaluate("window.peopleSmokeFeedback") as { milliseconds: number; changed: boolean };
    if (!localFeedback.changed || localFeedback.milliseconds > 100) throw new Error(`Reorder feedback missed its local target: ${JSON.stringify(localFeedback)}`);
    await page.getByRole("button", { name: "Undo move", exact: true }).waitFor();
    // Keyboard uses the same saved ordering, not a separate accessibility path.
    const beforeKeyboard = read();
    const keyboardOrder = [...beforeKeyboard.order];
    const averyId = beforeKeyboard.people.find(person => person.name === "Avery Okafor")!.personId;
    const averyIndex = keyboardOrder.indexOf(averyId);
    if (averyIndex < 0 || averyIndex === keyboardOrder.length - 1) throw new Error("Keyboard fixture has no downward move");
    [keyboardOrder[averyIndex], keyboardOrder[averyIndex + 1]] = [keyboardOrder[averyIndex + 1]!, keyboardOrder[averyIndex]!];
    await page.getByRole("button", { name: "Reorder Avery Okafor", exact: true }).press("ArrowDown");
    await page.waitForFunction(expected => JSON.stringify(Array.from(document.querySelectorAll<HTMLElement>(".people-workspace__row"), row => row.dataset.personId)) === JSON.stringify(expected), keyboardOrder);
    await page.getByRole("button", { name: "Undo move", exact: true }).waitFor();
    if (JSON.stringify(read().order) !== JSON.stringify(keyboardOrder) || read().orderRevision <= beforeKeyboard.orderRevision) throw new Error("Keyboard move did not save its expected order");
    await page.getByRole("button", { name: "Note on Avery Okafor" }).click();
    await page.getByRole("textbox", { name: "On Avery Okafor" }).fill("Put Avery near the top for the next dinner.");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("textbox", { name: "On Avery Okafor" }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Note on Avery Okafor" }).click();
    await page.getByText("Saved · not sent to Lois", { exact: true }).waitFor();
    const saved = read();
    if (JSON.stringify(saved.order) === JSON.stringify(before.order) || saved.notes.length !== 1) throw new Error("Edits did not reach the vault");
    await page.screenshot({ path: join(evidenceDir, "desktop-note.png"), fullPage: true });
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "The past dinner lists" }).waitFor();
    const reloaded = read();
    if (JSON.stringify(reloaded.order) !== JSON.stringify(saved.order) || reloaded.notes[0]?.text !== saved.notes[0]?.text) throw new Error("Reload lost saved edits");
    const visibleOrder = await page.locator(".people-workspace__row").evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.personId));
    if (JSON.stringify(visibleOrder) !== JSON.stringify(saved.order)) throw new Error("Reload did not render the saved order");
    await page.getByRole("button", { name: "Note on Avery Okafor" }).click();
    if (await page.getByRole("textbox", { name: "On Avery Okafor" }).inputValue() !== saved.notes[0]?.text) throw new Error("Reload did not render the saved note");
    const screens: string[] = [];
    for (const width of [1440, 768, 414, 375, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      if (width <= 820) await page.locator('[data-desk-tab="stage"]').click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) throw new Error(`Horizontal overflow at ${width}px`);
      const path = join(evidenceDir, `people-${width}.png`); screens.push(path);
      await page.screenshot({ path, fullPage: true });
    }
    const contrast = await checkPeopleContrast(page);
    // Real touch input and normal-motion mode get a separate context, sharing
    // only this rehearsal's vault. Neither context has a signed-in profile.
    const touch = await browser.newContext({ viewport: { width: 375, height: 900 }, hasTouch: true, reducedMotion: "no-preference" });
    const phone = await touch.newPage(); phone.on("pageerror", error => errors.push(error.message));
    await phone.goto(app.appUrl, { waitUntil: "networkidle" });
    await phone.locator('[data-desk-tab="stage"]').tap();
    await phone.getByRole("button", { name: "Move Avery Okafor up" }).tap();
    await phone.getByRole("button", { name: "Undo move", exact: true }).waitFor();
    if (read().orderRevision === saved.orderRevision) throw new Error("Touch reorder did not save");
    await phone.getByRole("button", { name: "Undo move", exact: true }).tap();
    await phone.waitForFunction(() => !document.querySelector(".people-workspace__status")?.textContent?.includes("Saving"));
    if (JSON.stringify(read().order) !== JSON.stringify(saved.order)) throw new Error("Touch undo did not restore order");
    await touch.close();
    // A late, longer source must append behind the organizer's order rather
    // than re-sort it. Names deliberately stress wrapping on a narrow pane.
    const vault = openVault(app.vaultDir);
    importPeopleSource(vault, { contextId: app.contextId, viewId: app.viewId,
      source: { platform: "mock-luma", accountId: "smoke-organizer", eventId: "C" }, readState: "read", evidence: ["fixture:C"],
      rows: Array.from({ length: 100 }, (_, i) => ({ rowId: `c-${i}`, name: `Guest ${i + 1} with a deliberately long hyphenated-name-for-the-narrow-screen`, evidence: ["fixture:C"] })) });
    // Production refreshes its host projection after an import; this direct
    // fixture import must do the same before asking the face to read it.
    Object.assign(app.world, loadWorld(vault));
    await page.reload({ waitUntil: "networkidle" });
    await page.locator('[data-desk-tab="stage"]').click();
    await page.locator(".people-workspace__row").nth(104).waitFor();
    const afterImport = await page.locator(".people-workspace__row").evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.personId));
    if (JSON.stringify(afterImport.slice(0, 5)) !== JSON.stringify(saved.order) || !read().coverage.complete) throw new Error("Late source reset the saved order or left stale coverage");
    await page.locator(".people-workspace__row").last().scrollIntoViewIfNeeded();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Long roster overflowed the narrow screen");
    await page.screenshot({ path: join(evidenceDir, "people-long-roster-320.png") });
    if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
    const result = { root: app.root, product: qualifyPeopleEvidence(startedProduct, productState()), screens, savedOrder: saved.order, people: saved.people.length, coverage: saved.coverage, notes: saved.notes.length, visibleReload: true, keyboardAndTouch: true, localFeedback, lateImportPeople: afterImport.length, contrast, motionModes: ["reduce", "no-preference"], noModelOrExternalEffects: true };
    writeFileSync(join(evidenceDir, "result.json"), JSON.stringify(result, null, 2));
    return result;
  } finally { await browser?.close(); await app.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes("--serve")) {
    const app = await startPeopleSmoke(); console.log(JSON.stringify({ appUrl: app.appUrl, root: app.root }));
    const stop = async () => { await app.close(); process.exit(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  } else console.log(JSON.stringify(await runPeopleSmoke()));
}
