/**
 * Live check against a real site, with no credential required.
 *
 * Confirms the only thing verifiable without the user's secret: that the site
 * answers /api/status and that the connector turns that answer into the
 * expected conversion factors. It deliberately does not attempt a balance read,
 * because that needs a credential this script does not have.
 *
 * Usage: node scripts/live-check.mjs [baseURL]
 */

import { fetchSiteMeta } from '../lib/upstream.js';

const baseURL = process.argv[2] ?? 'https://ai.zhijianginc.com';

process.stdout.write(`site: ${baseURL}\n`);

try {
  const { siteName, factors } = await fetchSiteMeta({ baseURL });
  process.stdout.write(`  site name     : ${siteName ?? '(unnamed)'}\n`);
  process.stdout.write(`  currency      : ${factors.currency}\n`);
  process.stdout.write(`  quota per unit: ${factors.quotaPerUnit}${factors.quotaUnitFallback ? ' (legacy fallback)' : ''}\n`);
  process.stdout.write(`  exchange rate : ${factors.exchangeRate}\n`);
  process.stdout.write('live-check: reachable\n');
} catch (error) {
  process.stdout.write(`live-check: failed (${error.reason ?? error.message})\n`);
  process.exitCode = 1;
}
