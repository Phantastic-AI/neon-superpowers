// Fresh whole-page reads of the actual people smoke screenshots. This judges
// comprehension only; it does not replace a model-led source import canary.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parsePaidSmokeCli, preflightPaidSmoke, verifyPaidSmokePricing } from "./lois-paid-smoke.js";
import { assertCleanHead } from "./lois-capability-smoke.js";
import { SMOKE_BUDGET, assertSmokeRunRootAvailable } from "./lois-smoke-run.js";
import { createInferenceBudget } from "../packages/lois/inference-budget.js";
import { bindBudgetedRoleModel } from "../sidecar/inference.js";
import { evaluateOrganizerPage } from "../packages/lois/organizer-goldfish.js";

export async function runPeopleGoldfish(resultPath: string, argv: string[]) {
  const options = parsePaidSmokeCli(argv);
  const preflight = preflightPaidSmoke(options);
  const smoke = JSON.parse(readFileSync(resultPath, "utf8"));
  if (smoke.product?.head !== preflight.head || smoke.product?.clean !== true) throw new Error("Use screenshots from this committed, clean product HEAD.");
  const pricing = await verifyPaidSmokePricing(options, preflight);
  if (assertCleanHead(preflight.repo) !== preflight.head) throw new Error("Product changed before the fish read.");
  // Share the ordinary smoke namespace: its call IDs and daily budget use
  // runId too. Exclusive creation prevents two runners claiming the same ID.
  const out = assertSmokeRunRootAvailable(options.baseDir, options.runId);
  mkdirSync(resolve(options.baseDir), { recursive: true });
  mkdirSync(out);
  const budget = createInferenceBudget({ runId: options.runId, model: options.inference.model,
    ledgerPath: join(out, "model-usage.jsonl"), dailyLedgerPath: resolve(options.baseDir, "daily-model-usage.jsonl"),
    pricing: options.inference.pricing, limits: SMOKE_BUDGET });
  const swims = [];
  for (const width of [1440, 375]) {
    const path = (smoke.screens as string[]).find(path => path.endsWith(`people-${width}.png`));
    if (!path) throw new Error(`Missing ${width}px whole-page screenshot`);
    const fish = bindBudgetedRoleModel(preflight.resolvedModel.model, budget, "goldfish-organizer-page", "fresh people workspace read", () => `people-${width}`, options.inference.defaultMaxOutputTokens);
    const verdict = await evaluateOrganizerPage(fish, readFileSync(path), "I asked Lois to combine my old dinner guestlists. I want to understand what is saved and unfinished, choose whom to bring back, arrange their order, and leave notes for Lois. Nothing should be sent to guests.");
    swims.push({ width, screenshot: path, verdict });
    writeFileSync(join(out, `people-${width}-goldfish.json`), JSON.stringify(verdict, null, 2));
  }
  const result = { head: preflight.head, model: options.inference.model, pricing, comprehensionOnly: true, green: swims.every(s => s.verdict.verdict === "swims"), swims, usage: budget.summary(), evidenceDir: out };
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [path, ...args] = process.argv.slice(2);
  if (!path) throw new Error("Provide the people smoke result.json, then the ordinary paid-smoke flags.");
  const result = await runPeopleGoldfish(path, args);
  console.log(JSON.stringify(result, null, 2));
  if (!result.green) process.exitCode = 1;
}
