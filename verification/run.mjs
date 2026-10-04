#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAcceptance } from './acceptance.mjs';

export async function runCli(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!['--adapter', '--scenario', '--provider'].includes(name) || !argv[i + 1] || argv[i + 1].startsWith('--') || options[name]) {
      throw new Error('Usage: node verification/run.mjs --scenario <json> [--adapter <mjs>] [--provider <mjs>]');
    }
    options[name] = argv[i + 1];
  }
  const scenario = options['--scenario'] ? JSON.parse(readFileSync(resolve(options['--scenario']), 'utf8')) : {};
  let adapter, environment, provider;
  try {
    if (options['--adapter']) {
      const mod = await import(pathToFileURL(resolve(options['--adapter'])).href);
      if (typeof mod.createAdapter !== 'function') throw new Error('Adapter module must export createAdapter({scenario}).');
      ({ adapter, environment } = await mod.createAdapter({ scenario }));
    }
    if (options['--provider']) {
      const mod = await import(pathToFileURL(resolve(options['--provider'])).href);
      if (typeof mod.createProvider !== 'function') throw new Error('Provider module must export createProvider().');
      provider = await mod.createProvider();
    }
    const report = await runAcceptance({ adapter, environment, scenario, provider });
    return { report, exitCode: report.accepted ? 0 : report.capability.status === 'fail' || report.comprehension.status === 'fail' ? 1 : 2 };
  } finally {
    try { await provider?.close?.(); } finally { await adapter?.close?.(); }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2)).then(({ report, exitCode }) => {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = exitCode;
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
