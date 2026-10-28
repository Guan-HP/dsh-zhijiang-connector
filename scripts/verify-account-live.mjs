/**
 * Live account-channel verification, isolated from the host's credential seam.
 *
 * Reads the credential references straight out of the harness store so the test
 * exercises `service.js` + `normalize.js` + `upstream.js` with real secrets, and
 * prints only derived figures. If this produces a balance but the running host
 * does not, the fault is in credential resolution rather than in the logic.
 *
 * Usage: node scripts/verify-account-live.mjs
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { createService } from '../lib/service.js';

const credFile = join(homedir(), '.dsh', '.credentials.yaml');

/**
 * Pull the `refs` flow mapping out of the credentials file.
 * @returns {Promise<Record<string, string>>} reference name to secret.
 */
async function readRefs() {
  const text = await readFile(credFile, 'utf8');
  const refs = {};
  const block = /^refs:\s*\n\s*\{([\s\S]*?)^\s*\}/m.exec(text);
  if (!block) return refs;
  for (const line of block[1].split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\S+?)\s*,?\s*$/.exec(line);
    if (match) refs[match[1]] = match[2];
  }
  return refs;
}

const refs = await readRefs();
const accountRef = 'ZHIJIANG_ACCESS_TOKEN';
const keyRef = 'ZHIJIANG_API_KEY';

process.stdout.write(`refs found       : ${Object.keys(refs).join(', ')}\n`);
process.stdout.write(`account ref set  : ${Boolean(refs[accountRef])}\n`);
process.stdout.write(`key ref set      : ${Boolean(refs[keyRef])}\n\n`);

const service = createService({
  getConfig: () => resolveConfig({
    baseURL: 'https://ai.zhijianginc.com',
    credentialRef: keyRef,
    accountCredentialRef: accountRef
  }),
  resolveCredential: async (ref) => refs[ref] ?? '',
  cacheFile: join(process.env.TEMP ?? '.', `zj-account-${Date.now()}.json`),
  now: () => Date.now()
});

const snapshot = await service.getSnapshot({ force: true });

process.stdout.write('snapshot\n');
process.stdout.write(`  source       : ${snapshot.source}\n`);
process.stdout.write(`  balance.known: ${snapshot.balance.known}\n`);
process.stdout.write(`  remaining    : ${snapshot.balance.remaining}\n`);
process.stdout.write(`  used         : ${snapshot.balance.used}\n`);
process.stdout.write(`  group        : ${snapshot.group}\n`);
process.stdout.write(`  keyCap       : ${JSON.stringify(snapshot.keyCap)}\n`);
process.stdout.write(`  forecast     : ${JSON.stringify(snapshot.forecast)}\n`);
process.stdout.write(`  warnings     : ${JSON.stringify(snapshot.warnings)}\n`);

const ok = snapshot.source === 'account' && snapshot.balance.known === true;
process.stdout.write(`\n${ok ? 'ACCOUNT: channel works' : 'ACCOUNT: channel did not activate'}\n`);
if (!ok) process.exitCode = 1;
