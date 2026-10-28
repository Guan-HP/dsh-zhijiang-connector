/**
 * Print what a specific installed copy of the plugin actually exports.
 *
 * Used to tell "the fix was not written" apart from "the running host is stale".
 * Takes an absolute path to normalize.js so it works regardless of exports maps.
 *
 * Usage: node scripts/probe-installed.mjs <path to lib/normalize.js>
 */

import { pathToFileURL } from 'node:url';

const target = process.argv[2];
if (!target) {
  process.stdout.write('usage: node scripts/probe-installed.mjs <path>\n');
  process.exit(0);
}

const m = await import(pathToFileURL(target).href);

const factors = { currency: 'CNY', quotaPerUnit: 500000, exchangeRate: 7, quotaUnitFallback: false };
const result = m.readTokenQuota(
  { data: { unlimited_quota: true, total_granted: 10000, total_used: 2400000, total_available: -2390000 } },
  factors
);

process.stdout.write(`file         : ${target}\n`);
process.stdout.write(`has keyCap   : ${Object.prototype.hasOwnProperty.call(result, 'keyCap')}\n`);
process.stdout.write(`has balance  : ${Object.prototype.hasOwnProperty.call(result, 'balance')}\n`);
process.stdout.write(`result       : ${JSON.stringify(result)}\n`);
