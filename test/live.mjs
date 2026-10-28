/**
 * Live end-to-end test with a real credential.
 *
 * Reads the key from the environment (never from a file this script writes) and
 * drives the real service against the real site. Prints only derived figures —
 * never the key itself.
 *
 * Usage: set ZJ_KEY, then node test/live.mjs
 */

import { createService } from '../lib/service.js';
import { resolveConfig } from '../lib/config.js';

const key = process.env.ZJ_KEY ?? '';
if (key === '') {
  process.stdout.write('skip: ZJ_KEY not set\n');
  process.exit(0);
}

const service = createService({
  getConfig: () => resolveConfig({ baseURL: 'https://ai.zhijianginc.com' }),
  resolveCredential: async (ref) => (ref === 'zhijiangApiKey' ? key : ''),
  cacheFile: `${process.env.TEMP ?? '.'}/zj-live-${Date.now()}.json`,
  now: () => Date.now()
});

process.stdout.write('live end-to-end\n');

const started = Date.now();
let snapshot;
try {
  snapshot = await service.getSnapshot({ force: true });
} catch (error) {
  process.stdout.write(`  FAIL  ${error.reason ?? error.message}\n`);
  process.exitCode = 1;
  process.exit();
}

const elapsed = Date.now() - started;

process.stdout.write(`  source      : ${snapshot.source}\n`);
process.stdout.write(`  site        : ${snapshot.site.name} (${snapshot.site.currency})\n`);
process.stdout.write(`  quota unit  : ${snapshot.site.quotaPerUnit}  rate ${snapshot.site.exchangeRate}\n`);
process.stdout.write(`  balance     : ${snapshot.balance.remaining}\n`);
process.stdout.write(`  used        : ${snapshot.balance.used}\n`);
process.stdout.write(`  total       : ${snapshot.balance.total}\n`);
process.stdout.write(`  unlimited   : ${snapshot.balance.unlimited}\n`);
process.stdout.write(`  expires     : ${snapshot.balance.expiresAt}\n`);
process.stdout.write(`  level       : ${snapshot.forecast.level}\n`);
process.stdout.write(`  elapsed     : ${elapsed}ms\n`);

let failures = 0;

/**
 * Assert one property of the live result.
 * @param {string} name - check name.
 * @param {boolean} condition - expected truth.
 * @returns {void}
 */
function verify(name, condition) {
  if (condition) {
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  FAIL  ${name}\n`);
  }
}

verify('站点识别为开物云', snapshot.site.name === '开物云');
verify('计价单位为 CNY', snapshot.site.currency === 'CNY');
verify('换算单位为 500000', snapshot.site.quotaPerUnit === 500000);
verify('汇率为 7', snapshot.site.exchangeRate === 7);
verify('余额为有限数值', Number.isFinite(snapshot.balance.remaining));
verify('已用为有限数值', Number.isFinite(snapshot.balance.used));
verify('快照未过期', snapshot.stale === false);
verify('响应时间 < 20s', elapsed < 20000);

process.stdout.write(`\n${failures === 0 ? 'LIVE: all checks passed' : `LIVE: ${failures} failed`}\n`);
if (failures > 0) process.exitCode = 1;
