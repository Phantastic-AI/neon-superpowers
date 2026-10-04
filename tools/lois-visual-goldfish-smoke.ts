#!/usr/bin/env -S npx tsx
// Whole-page organizer goldfish: a fresh visual reader judges each landed
// conversation turn from the same pixels the organizer sees in the real face.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright-core";
import {
  evaluateOrganizerPage,
  type OrganizerPageGoldfishVerdict,
} from "../packages/lois/organizer-goldfish.js";
import { parsePaidSmokeCli } from "./lois-paid-smoke.js";
import { runPaidSmokeApp } from "./lois-paid-app.js";

const TURN_TIMEOUT_MS = 90_000;

export const VISUAL_BROWSER_INSPECTION_PROMPT =
  "Open the 3Cs Luma event workspace in the browser inside Superpowers. Tell me what is actually on that page and stop. Nothing sends.";

interface PageSwim {
  turn: string;
  artifact: string;
  screenshot: string;
  verdict: OrganizerPageGoldfishVerdict;
}

interface VisualGoldfishResult {
  green: boolean;
  runId: string;
  head: string;
  swims: PageSwim[];
  usage?: { admittedCalls: number; completedCalls: number; runUsd: number; reservedUsd: number; dailyUsd: number };
}

async function tell(page: Page, words: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "say it to Lois, in your words…" });
  await composer.fill(words);
  await page.getByRole("button", { name: "TELL HER" }).click();
  await page.locator(".composer[aria-busy='true']").waitFor({ timeout: 10_000 });
  await page.waitForFunction(
    () => !document.querySelector(".composer")?.hasAttribute("aria-busy"),
    undefined,
    { timeout: TURN_TIMEOUT_MS },
  );
}

async function waitForLiveBrowser(page: Page): Promise<void> {
  await page.getByText("THE BROWSER", { exact: true }).waitFor({ timeout: TURN_TIMEOUT_MS });
  await page.waitForFunction(
    () => document.querySelector<HTMLImageElement>("img.macwin__live")?.src.startsWith("data:image/jpeg") === true,
    undefined,
    { timeout: TURN_TIMEOUT_MS },
  );
}

export async function runVisualGoldfishSmoke(argv: string[]): Promise<VisualGoldfishResult> {
  const options = parsePaidSmokeCli(argv);
  let result: VisualGoldfishResult | undefined;

  await runPaidSmokeApp(options, async ({ appUrl, run, built }) => {
    const fish = built.inference?.bindRole(
      "goldfish-organizer-page",
      "fresh whole-page organizer read",
    );
    if (!fish || !built.inference) throw new Error("Visual goldfish requires the approved metered app brain.");

    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const swims: PageSwim[] = [];
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
      await page.goto(appUrl, { waitUntil: "domcontentloaded" });
      await page.getByText("Tell me what you're trying to get done.", { exact: true }).waitFor();

      await tell(
        page,
        VISUAL_BROWSER_INSPECTION_PROMPT,
      );
      await waitForLiveBrowser(page);
      const firstImage = await page.screenshot({ fullPage: true, type: "png" });
      const firstPath = resolve(run.evidenceDir, "organizer-page-turn-1.png");
      writeFileSync(firstPath, firstImage);
      const firstVerdict = await built.inference.runTurn("goldfish-page-1", () =>
        evaluateOrganizerPage(
          fish,
          firstImage,
          "From a clean 3Cs seed, the organizer asked Lois to inspect what is actually on the local Luma rehearsal page in the embedded browser, then stop and send nothing.",
        ),
      );
      swims.push({
        turn: "browser inspection landed",
        artifact: "organizer-page-turn-1",
        screenshot: firstPath,
        verdict: firstVerdict,
      });

      await tell(page, "Good. Keep the browser where it is. What is the one useful next step?");
      await waitForLiveBrowser(page);
      const secondImage = await page.screenshot({ fullPage: true, type: "png" });
      const secondPath = resolve(run.evidenceDir, "organizer-page-turn-2.png");
      writeFileSync(secondPath, secondImage);
      const secondVerdict = await built.inference.runTurn("goldfish-page-2", () =>
        evaluateOrganizerPage(
          fish,
          secondImage,
          "In the same short swim, the organizer asked Lois to keep the already-open embedded browser on stage and name one useful next step.",
        ),
      );
      swims.push({
        turn: "browser kept on stage",
        artifact: "organizer-page-turn-2",
        screenshot: secondPath,
        verdict: secondVerdict,
      });

      for (const swim of swims) {
        writeFileSync(
          resolve(run.evidenceDir, `${swim.artifact}-goldfish.json`),
          `${JSON.stringify(swim.verdict, null, 2)}\n`,
          "utf8",
        );
      }
      result = {
        green: swims.every((swim) => swim.verdict.verdict === "swims"),
        runId: options.runId,
        head: (JSON.parse(readFileSync(run.manifestPath, "utf8")) as { product: { head: string } }).product.head,
        swims,
        usage: built.inference.budget?.summary(),
      };
    } finally {
      await browser.close();
    }
  });

  if (!result) throw new Error("Visual goldfish app session ended without evidence.");
  if (!result.green) throw new Error(`Organizer page goldfish sank: ${JSON.stringify(result.swims)}`);
  return result;
}

export function isDirectVisualGoldfishSmoke(
  metaUrl: string = import.meta.url,
  argv: string[] = process.argv,
): boolean {
  const entry = argv[1];
  return Boolean(entry) && pathToFileURL(resolve(entry)).href === metaUrl;
}

if (isDirectVisualGoldfishSmoke()) {
  void runVisualGoldfishSmoke(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
}
