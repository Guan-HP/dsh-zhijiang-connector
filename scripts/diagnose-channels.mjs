/**
 * Diagnostic: compare the two upstream channels against the live site.
 *
 * Prints only derived facts (no key, no full payloads) so the output is safe to
 * paste into a report. Purpose: prove whether `unlimited_quota` refers to the
 * token's cap or the account's balance.
 *
 * Usage: node scripts/diagnose-channels.mjs
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const credFile = join(homedir(), '.dsh', '.credentials.yaml');

/**
 * Read one reference out of the credential store without logging it.
 * @param {string} name - reference name.
 * @returns {Promise<string>} the secret, or an empty string.
 */
async function readRef(name) {
  try {
    const text = await readFile(credFile, 'utf8');
    const match = new RegExp(`${name}:\\s*([^,\\s}]+)`).exec(text);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

const key = await readRef('ZHIJIANG_API_KEY');
if (key === '') {
  process.stdout.write('no key found\n');
  process.exit(0);
}

const base = 'https://ai.zhijianginc.com';

/**
 * Fetch JSON with a bearer token.
 * @param {string} path - API path.
 * @returns {Promise<object>} parsed body.
 */
async function get(path) {
  const response = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' }
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

process.stdout.write('== GET /api/usage/token/ (token channel) ==\n');
const token = await get('/api/usage/token/');
process.stdout.write(`  http        : ${token.status}\n`);
if (token.body && token.body.data) {
  const d = token.body.data;
  process.stdout.write(`  name        : ${d.name}\n`);
  process.stdout.write(`  unlimited   : ${d.unlimited_quota}\n`);
  process.stdout.write(`  granted     : ${d.total_granted}\n`);
  process.stdout.write(`  used        : ${d.total_used}\n`);
  process.stdout.write(`  available   : ${d.total_available}\n`);
  process.stdout.write(`  expires_at  : ${d.expires_at}\n`);
} else {
  process.stdout.write(`  body        : ${JSON.stringify(token.body)}\n`);
}

process.stdout.write('\n== GET /api/user/self (account channel, sk- key) ==\n');
const self = await get('/api/user/self');
process.stdout.write(`  http        : ${self.status}\n`);
process.stdout.write(`  success     : ${self.body?.success}\n`);
if (self.body?.data) {
  const d = self.body.data;
  process.stdout.write(`  quota       : ${d.quota}\n`);
  process.stdout.write(`  used_quota  : ${d.used_quota}\n`);
  process.stdout.write(`  group       : ${d.group}\n`);
} else {
  process.stdout.write(`  message     : ${self.body?.message}\n`);
}

process.stdout.write('\n== /api/status conversion factors ==\n');
const status = await get('/api/status');
const qpu = Number(status.body?.data?.quota_per_unit);
const rate = Number(status.body?.data?.usd_exchange_rate);
process.stdout.write(`  quota_per_unit : ${qpu}\n`);
process.stdout.write(`  exchange_rate  : ${rate}\n`);

if (self.body?.data && Number.isFinite(qpu) && qpu > 0) {
  const remaining = Number(self.body.data.quota) / qpu * (Number.isFinite(rate) ? rate : 1);
  const used = Number(self.body.data.used_quota) / qpu * (Number.isFinite(rate) ? rate : 1);
  process.stdout.write(`\n  => account remaining ≈ ${remaining.toFixed(2)}\n`);
  process.stdout.write(`  => account used      ≈ ${used.toFixed(2)}\n`);
}
