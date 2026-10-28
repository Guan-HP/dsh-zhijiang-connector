/**
 * Verify the plugin against the site's real rejection response.
 *
 * The stored credential is rejected by the live site, so a happy-path live test
 * is impossible. This drives the real service against the real site and asserts
 * the plugin surfaces the rejection correctly — which is itself a requirement:
 * an invalid key must read as "your key is rejected", not as a crash or a
 * misleading "not configured".
 */

import { createService } from '../lib/service.js';
import { resolveConfig } from '../lib/config.js';

const key = process.env.ZJ_KEY ?? '';
if (key === '') {
  process.stdout.write('skip: ZJ_KEY not set\n');
  process.exit(0);
}

let failures = 0;

/**
 * Assert one property.
 * @param {string} name - check name.
 * @param {boolean} condition - expected truth.
 * @returns {void}
 */
function verify(name, condition) {
  if (condition) process.stdout.write(`  PASS  ${name}\n`);
  else { failures += 1; process.stdout.write(`  FAIL  ${name}\n`); }
}

/**
 * Build a service against the live site.
 * @param {string} credential - the key to use.
 * @returns {object} the service.
 */
function live(credential) {
  return createService({
    getConfig: () => resolveConfig({ baseURL: 'https://ai.zhijianginc.com' }),
    resolveCredential: async (ref) => (ref === 'zhijiangApiKey' ? credential : ''),
    cacheFile: `${process.env.TEMP ?? '.'}/zj-live2-${Date.now()}.json`,
    now: () => Date.now()
  });
}

process.stdout.write('live: real site, rejected credential\n');

// 1. The site itself is reachable and parses correctly.
const healthy = live(key);
try {
  const snapshot = await healthy.getSnapshot({ force: true });
  process.stdout.write(`  unexpected success: remaining=${snapshot.balance.remaining}\n`);
} catch (error) {
  verify('站点可达（错误来自鉴权而非网络）', error.reason !== 'network' && error.reason !== 'timeout');
  verify('错误归类为 unauthorized', error.reason === 'unauthorized');
  verify('标记为不可重试', error.retryable === false);
  process.stdout.write(`  reason=${error.reason} status=${error.status}\n`);
}

// 2. An unconfigured install must say "not configured", not blame the site.
const empty = live('');
try {
  await empty.getSnapshot({ force: true });
  verify('未配置时应抛出错误', false);
} catch (error) {
  verify('未配置时归类为 not-configured（而非 unauthorized）', error.reason === 'not-configured');
}

// 3. A garbage key must not be mistaken for a network failure.
const garbage = live('sk-definitely-not-a-real-key-000000');
try {
  await garbage.getSnapshot({ force: true });
  verify('无效密钥应抛出错误', false);
} catch (error) {
  verify('无效密钥归类为 unauthorized', error.reason === 'unauthorized');
}

process.stdout.write(`\n${failures === 0 ? 'LIVE-REJECTION: all checks passed' : `LIVE-REJECTION: ${failures} failed`}\n`);
if (failures > 0) process.exitCode = 1;
