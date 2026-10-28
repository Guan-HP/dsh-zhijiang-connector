/**
 * Live verification of the balance-source fix.
 *
 * Runs the real service against the real relay with the stored key and prints
 * the resulting snapshot's key facts. Asserts the exact defect is gone: an
 * uncapped key must not produce an unlimited balance.
 *
 * Usage: node scripts/verify-balance-fix.mjs
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { createService } from '../lib/service.js';

const credFile = join(homedir(), '.dsh', '.credentials.yaml');

/**
 * Read a credential reference without logging it.
 * @param {string} name - reference name.
 * @returns {Promise<string>} the secret.
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
  process.stdout.write('skip: no ZHIJIANG_API_KEY\n');
  process.exit(0);
}

const service = createService({
  getConfig: () => resolveConfig({ baseURL: 'https://ai.zhijianginc.com', credentialRef: 'ZHIJIANG_API_KEY' }),
  resolveCredential: async (ref) => (ref === 'ZHIJIANG_API_KEY' ? key : ''),
  cacheFile: join(process.env.TEMP ?? '.', `zj-verify-${Date.now()}.json`),
  now: () => Date.now()
});

const snapshot = await service.getSnapshot({ force: true });

process.stdout.write('live snapshot\n');
process.stdout.write(`  source        : ${snapshot.source}\n`);
process.stdout.write(`  balance.known : ${snapshot.balance.known}\n`);
process.stdout.write(`  remaining     : ${snapshot.balance.remaining}\n`);
process.stdout.write(`  unlimited     : ${snapshot.balance.unlimited}\n`);
process.stdout.write(`  keyCap        : ${JSON.stringify(snapshot.keyCap)}\n`);
process.stdout.write(`  usage.total   : ${snapshot.usage?.total}\n`);
process.stdout.write(`  forecast.level: ${snapshot.forecast.level}\n`);
process.stdout.write(`  warnings      : ${JSON.stringify(snapshot.warnings)}\n`);

let failed = 0;

/**
 * Assert one property of the live snapshot.
 * @param {string} name - check name.
 * @param {boolean} condition - expected truth.
 * @returns {void}
 */
function verify(name, condition) {
  if (condition) process.stdout.write(`  PASS  ${name}\n`);
  else { failed += 1; process.stdout.write(`  FAIL  ${name}\n`); }
}

verify('不再声称余额无限', snapshot.balance.unlimited === false);
verify('余额标记为不可知（sk- 密钥读不到钱包）', snapshot.balance.known === false);
verify('余额为 null 而非伪造数字', snapshot.balance.remaining === null);
verify('密钥无上限作为独立事实保留', snapshot.keyCap?.unlimited === true);
verify('已用金额仍然可用', typeof snapshot.usage?.total === 'number' && snapshot.usage.total > 0);
verify('可用时长不下结论', snapshot.forecast.daysLeft === null && snapshot.forecast.level === 'unknown');
verify('给出缺失账户通道的警告', snapshot.warnings.includes('account-channel-not-configured'));

process.stdout.write(`\n${failed === 0 ? 'VERIFY: all checks passed' : `VERIFY: ${failed} failed`}\n`);
if (failed > 0) process.exitCode = 1;
