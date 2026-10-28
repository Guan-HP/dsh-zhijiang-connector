/**
 * Service tests: channel preference, degradation, staleness, burn rate.
 *
 * Everything is injected �?clock, fetch, credential reader, cache path �?so the
 * whole suite runs offline against a temporary directory.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendSample, readCache, spendOverWindow, writeCache } from '../lib/cache.js';
import { resolveConfig } from '../lib/config.js';
import { createService } from '../lib/service.js';

let passed = 0;

/**
 * Run one named assertion block.
 * @param {string} name - case name.
 * @param {() => Promise<void> | void} body - assertions.
 * @returns {Promise<void>} resolves when done.
 */
async function test(name, body) {
  await body();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

const STATUS_BODY = {
  data: { quota_display_type: 'CNY', quota_per_unit: 500000, usd_exchange_rate: 7, system_name: '开物云' },
  success: true
};

const TOKEN_BODY = {
  code: true,
  data: { name: 'example-key', total_granted: 2400000, total_used: 2100000, total_available: 300000, unlimited_quota: false }
};

const ACCOUNT_BODY = { success: true, data: { quota: 1200000, used_quota: 2400000, group: 'default' } };

/**
 * Build a fetch stub that answers per path.
 * @param {Record<string, {status?: number, body?: unknown}>} table - path to response.
 * @returns {typeof fetch} the stub.
 */
function stubFetch(table) {
  return async (url) => {
    const path = new URL(url).pathname;
    const entry = table[path];
    if (!entry) return new Response('', { status: 404 });
    const status = entry.status ?? 200;
    return new Response(JSON.stringify(entry.body ?? {}), { status, headers: { 'content-type': 'application/json' } });
  };
}

const root = await mkdtemp(join(tmpdir(), 'zhijiang-'));

process.stdout.write('service\n');

await test('key-only setup reports spend but admits the balance is unknown', async () => {
  const service = createService({
    getConfig: () => resolveConfig({ baseURL: 'https://relay.test' }),
    resolveCredential: async (ref) => (ref === 'zhijiangApiKey' ? 'sk-test' : ''),
    cacheFile: join(root, 'a.json'),
    now: () => Date.parse('2026-10-26T08:00:00.000Z'),
    fetchImpl: stubFetch({ '/api/status': { body: STATUS_BODY }, '/api/usage/token/': { body: TOKEN_BODY } })
  });

  const snapshot = await service.getSnapshot({ force: true });
  assert.equal(snapshot.source, 'token');
  // The wallet is not reachable with an sk- key, so it must not be guessed.
  assert.equal(snapshot.balance.known, false);
  assert.equal(snapshot.balance.remaining, null);
  assert.equal(snapshot.balance.unlimited, false);
  // Spend and the key's own ceiling are still real facts.
  assert.equal(snapshot.usage.total, 29.4);
  assert.equal(snapshot.keyCap.unlimited, false);
  assert.equal(snapshot.keyCap.available, 4.2);
  assert.equal(snapshot.site.currency, 'CNY');
  assert.equal(snapshot.stale, false);
  assert.ok(snapshot.warnings.includes('account-channel-not-configured'));
});

await test('prefers the account channel when a token is configured', async () => {
  const service = createService({
    getConfig: () => resolveConfig({
      baseURL: 'https://relay.test',
      accountCredentialRef: 'zhijiangAccessToken'
    }),
    resolveCredential: async (ref) => {
      if (ref === 'zhijiangAccessToken') return 'pat-test';
      if (ref === 'zhijiangApiKey') return 'sk-test';
      return '';
    },
    cacheFile: join(root, 'b.json'),
    now: () => Date.parse('2026-10-26T08:00:00.000Z'),
    fetchImpl: stubFetch({ '/api/status': { body: STATUS_BODY }, '/api/user/self': { body: ACCOUNT_BODY } })
  });

  const snapshot = await service.getSnapshot({ force: true });
  assert.equal(snapshot.source, 'account');
  assert.equal(snapshot.balance.remaining, 16.8);
  assert.equal(snapshot.group, 'default');
});

await test('falls back to the key channel when the account token is rejected', async () => {
  const service = createService({
    getConfig: () => resolveConfig({
      baseURL: 'https://relay.test',
      accountCredentialRef: 'zhijiangAccessToken'
    }),
    resolveCredential: async () => 'whatever',
    cacheFile: join(root, 'c.json'),
    now: () => Date.parse('2026-10-26T08:00:00.000Z'),
    fetchImpl: stubFetch({
      '/api/status': { body: STATUS_BODY },
      '/api/user/self': { status: 401 },
      '/api/usage/token/': { body: TOKEN_BODY }
    })
  });

  const snapshot = await service.getSnapshot({ force: true });
  assert.equal(snapshot.source, 'token');
  assert.equal(snapshot.warnings.length, 1);
  assert.match(snapshot.warnings[0], /account channel failed/);
});

await test('reports not-configured when no credential is set at all', async () => {
  const service = createService({
    getConfig: () => resolveConfig({ baseURL: 'https://relay.test' }),
    resolveCredential: async () => '',
    cacheFile: join(root, 'd.json'),
    now: () => Date.parse('2026-10-26T08:00:00.000Z'),
    fetchImpl: stubFetch({ '/api/status': { body: STATUS_BODY } })
  });

  await assert.rejects(
    () => service.getSnapshot({ force: true }),
    (error) => error.reason === 'not-configured'
  );
});

await test('serves the previous snapshot marked stale when a refresh fails', async () => {
  let mode = 'ok';
  const service = createService({
    getConfig: () => resolveConfig({ baseURL: 'https://relay.test' }),
    resolveCredential: async () => 'sk-test',
    cacheFile: join(root, 'e.json'),
    now: () => Date.parse('2026-10-26T08:00:00.000Z'),
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (mode === 'fail' && path === '/api/usage/token/') return new Response('', { status: 500 });
      if (path === '/api/status') {
        return new Response(JSON.stringify(STATUS_BODY), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(TOKEN_BODY), { headers: { 'content-type': 'application/json' } });
    }
  });

  const fresh = await service.getSnapshot({ force: true });
  assert.equal(fresh.stale, false);

  mode = 'fail';
  const stale = await service.refresh({ force: true });
  assert.equal(stale.stale, true);
  assert.equal(stale.balance.known, false);
  assert.equal(stale.keyCap.available, 4.2);
  assert.match(stale.warnings.join(' '), /refresh failed/);
  assert.equal(service.lastError().reason, 'http-error');
});

await test('persists and reloads the snapshot across instances', async () => {
  const cacheFile = join(root, 'f.json');
  const first = createService({
    getConfig: () => resolveConfig({ baseURL: 'https://relay.test' }),
    resolveCredential: async () => 'sk-test',
    cacheFile,
    now: () => Date.parse('2026-10-26T08:00:00.000Z'),
    fetchImpl: stubFetch({ '/api/status': { body: STATUS_BODY }, '/api/usage/token/': { body: TOKEN_BODY } })
  });
  await first.getSnapshot({ force: true });

  const second = createService({
    getConfig: () => resolveConfig({ baseURL: 'https://relay.test' }),
    resolveCredential: async () => 'sk-test',
    cacheFile,
    now: () => Date.parse('2026-10-26T08:00:30.000Z'),
    fetchImpl: async () => {
      throw new Error('must not be called');
    }
  });

  const restored = await second.getSnapshot();
  assert.equal(restored.keyCap.available, 4.2);
  assert.equal(restored.balance.known, false);
});

await test('computes a burn rate only once history spans the window', async () => {
  const nowMs = Date.parse('2026-10-26T08:00:00.000Z');
  const samples = [];
  samples.push({ at: new Date(nowMs - 8 * 86400000).toISOString(), used: 80 });
  samples.push({ at: new Date(nowMs - 1 * 86400000).toISOString(), used: 94 });
  samples.push({ at: new Date(nowMs).toISOString(), used: 101 });

  const window = spendOverWindow(samples, 7, nowMs);
  assert.ok(window, 'expected a window');
  assert.equal(Math.round(window.spent), 21);

  const shallow = [{ at: new Date(nowMs - 3600000).toISOString(), used: 100 }];
  assert.equal(spendOverWindow(shallow, 7, nowMs), null);
});

await test('ignores a counter reset rather than reporting negative spend', async () => {
  const nowMs = Date.parse('2026-10-26T08:00:00.000Z');
  const samples = [
    { at: new Date(nowMs - 8 * 86400000).toISOString(), used: 90 },
    { at: new Date(nowMs).toISOString(), used: 5 }
  ];
  assert.equal(spendOverWindow(samples, 7, nowMs), null);
});

await test('caps the sample history', async () => {
  let samples = [];
  for (let i = 0; i < 520; i += 1) samples = appendSample(samples, { at: new Date(i * 1000).toISOString(), used: i });
  assert.equal(samples.length, 500);
});

await test('survives a corrupt cache file', async () => {
  const file = join(root, 'g.json');
  await writeCache(file, { snapshot: null, samples: [] });
  const cached = await readCache(file);
  assert.equal(cached.snapshot, null);
  assert.deepEqual(cached.samples, []);
  assert.deepEqual(await readCache(join(root, 'does-not-exist.json')), { snapshot: null, samples: [] });
});

// Regression: the panel showed �?24 小时 ¥0.00 while the site dashboard said
// ¥18.02. With no day-long history the honest answer is "unknown", not zero.
await test('does not report a 24h figure until the history spans a day', async () => {
  let clock = Date.parse('2026-10-26T00:00:00.000Z');
  let used = 80;
  const service = createService({
    getConfig: () => resolveConfig({ baseURL: 'https://relay.test' }),
    resolveCredential: async () => 'sk-test',
    cacheFile: join(root, 'h.json'),
    now: () => clock,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      const body = path === '/api/status' ? STATUS_BODY : { data: { total_used: used * 71428.57, unlimited_quota: true } };
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }
  });

  await service.getSnapshot({ force: true });

  // A minute later: two samples exist, but they do not cover a day.
  clock += 60000;
  used = 81;
  const soon = await service.refresh({ force: true });
  assert.equal(soon.usage.last24h, null, 'must not claim 0 spent from a one-minute window');

  // A day later the window is real.
  clock += 86400000 - 60000;
  used = 101;
  const nextDay = await service.refresh({ force: true });
  assert.ok(typeof nextDay.usage.last24h === 'number', 'a day of history yields a figure');
});

process.stdout.write('config\n');

await test('clamps a too-short refresh interval', () => {
  assert.equal(resolveConfig({ refreshSeconds: 5 }).refreshSeconds, 60);
});

await test('orders a reversed threshold pair', () => {
  const config = resolveConfig({ warningDays: 1, criticalDays: 5 });
  assert.ok(config.warningDays >= config.criticalDays);
});

await test('derives the wallet URL from a custom site', () => {
  const config = resolveConfig({ baseURL: 'https://other.test/', walletURL: '' });
  assert.equal(config.baseURL, 'https://other.test');
  assert.equal(config.walletURL, 'https://other.test/console/wallet');
});

await test('keeps the badge on unless explicitly disabled', () => {
  assert.equal(resolveConfig({}).showBadge, true);
  assert.equal(resolveConfig({ showBadge: false }).showBadge, false);
});

await rm(root, { recursive: true, force: true });

process.stdout.write(`service: ${passed} passed\n`);
