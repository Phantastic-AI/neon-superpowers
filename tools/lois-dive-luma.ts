#!/usr/bin/env -S npx tsx
// lois-dive-luma — the first DIVER (D-117): Superpowers' own Chrome, live Luma.
//
//   npx tsx tools/lois-dive-luma.ts [event-url]
//
// What happens (supervised smoke, CP2):
//   1. Launches Superpowers' OWN persistent Chrome profile (never the
//      operator's browser, D-052) — real Chrome channel, visible window.
//      The profile lives in ~/Library/Application Support/Neon Superpowers, so a
//      sign-in done once in this window is kept for every future dive.
//   2. Opens Luma (the event URL if given, else lu.ma). The operator signs in
//      the normal way, in that window, and navigates to their event's guest
//      list. Lois never sees the password; the profile keeps the session.
//   3. Press ENTER here to CAPTURE the open page: full DOM + a screenshot land
//      in the capture dir. That capture is what the real Luma PAGE_CONTRACTS
//      selectors get authored from — after which extractGuests() reads the
//      live page through the same organ core as the fixtures, unchanged.
//
// Captures carry real PII: they go to a local capture dir beside the profile,
// never the repo, never committed, never published.

import { mkdirSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";

const APP_DIR = resolve(homedir(), "Library", "Application Support", "Neon Superpowers");
const PROFILE_DIR = resolve(APP_DIR, "profiles", "hacker-garage");
const CAPTURE_DIR = resolve(APP_DIR, "captures");

const url = process.argv[2] ?? "https://lu.ma";

async function main(): Promise<void> {
  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(CAPTURE_DIR, { recursive: true });

  console.log("Superpowers' Chrome (her profile, not your browser) is opening…");
  console.log(`  profile: ${PROFILE_DIR}`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    viewport: null,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {
    /* slow loads are fine; the window is the point */
  });

  console.log("");
  console.log("Sign in to Luma IN THAT WINDOW (once — the profile keeps the session),");
  console.log("then navigate to your event's GUEST LIST and come back here.");
  console.log("");
  console.log("  ENTER  = capture the open page (DOM + screenshot, local only)");
  console.log("  q      = close the window and quit");
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let n = 0;
  await new Promise<void>((done) => {
    rl.on("line", async (line) => {
      if (line.trim().toLowerCase() === "q") {
        rl.close();
        done();
        return;
      }
      try {
        n += 1;
        const current = page.url();
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const htmlPath = resolve(CAPTURE_DIR, `luma-${stamp}.html`);
        const pngPath = resolve(CAPTURE_DIR, `luma-${stamp}.png`);
        writeFileSync(htmlPath, await page.content(), "utf8");
        await page.screenshot({ path: pngPath, fullPage: true });
        console.log(`capture ${n}: ${current}`);
        console.log(`  dom:        ${htmlPath}`);
        console.log(`  screenshot: ${pngPath}`);
        console.log("ENTER to capture again (e.g. after scrolling the list), q to quit.");
      } catch (err) {
        console.log(`capture failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });

  await context.close();
  console.log("Window closed. The session is saved in the profile for next time.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
