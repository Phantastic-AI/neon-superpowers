#!/usr/bin/env node
// Evaluate one already captured full-page PNG. This is comprehension evidence,
// not a capability or whole-journey acceptance claim.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluatePage } from './goldfish.mjs';
import { createProvider } from './neon-goldfish-provider.mjs';

export async function runPageCli(argv, { providerFactory = createProvider } = {}) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!['--png', '--brief', '--provider'].includes(name) || !argv[i + 1] || argv[i + 1].startsWith('--') || options[name]) {
      throw new Error('Usage: node verification/goldfish-page.mjs --png <full-page.png> --brief <tiny job brief> [--provider <mjs>]');
    }
    options[name] = argv[i + 1];
  }
  if (!options['--png'] || !options['--brief']) throw new Error('A captured whole-page PNG and tiny job brief are required.');
  const path = resolve(options['--png']), screenshot = readFileSync(path);
  const capture = { path, sha256: createHash('sha256').update(screenshot).digest('hex') };
  let provider;
  try {
    if (options['--provider']) {
      const mod = await import(pathToFileURL(resolve(options['--provider'])).href);
      if (typeof mod.createProvider !== 'function') throw new Error('Provider module must export createProvider().');
      providerFactory = mod.createProvider;
    }
    provider = await providerFactory();
    const verdict = await evaluatePage({ provider, screenshot, brief: options['--brief'] });
    const status = verdict.verdict === 'swims' ? 'pass' : 'fail';
    return { report: { kind: 'whole-page-comprehension', status, capture, verdict, providerEvidence: provider.latestEvidence?.() ?? null }, exitCode: status === 'pass' ? 0 : 1 };
  } catch (error) {
    return { report: { kind: 'whole-page-comprehension', status: 'fail', capture, reason: error.message, providerEvidence: provider?.latestEvidence?.() ?? null }, exitCode: 1 };
  } finally { await provider?.close?.(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runPageCli(process.argv.slice(2)).then(({ report, exitCode }) => { console.log(JSON.stringify(report, null, 2)); process.exitCode = exitCode; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
