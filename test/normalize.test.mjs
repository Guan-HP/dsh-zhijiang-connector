/**
 * Offline tests for the pure conversion layer.
 *
 * The `/api/status` fixture is the real body captured from
 * https://ai.zhijianginc.com/api/status during implementation, trimmed to the
 * fields this plugin reads. The token and account fixtures follow the New API
 * response shapes; they are marked below where they are reconstructed rather
 * than captured.
 */

import assert from 'node:assert/strict';
import {
  LEGACY_QUOTA_PER_UNIT,
  buildSnapshot,
  dailyAverage,
  forecastRunway,
  pick,
  quotaToAmount,
  readAccountQuota,
  readQuotaStatus,
  readTokenQuota,
  round,
  toNumber,
  unknownBalance
} from '../lib/normalize.js';

let passed = 0;

/**
 * Run one named assertion block.
 * @param {string} name - case name.
 * @param {() => void} body - assertions.
 */
function test(name, body) {
  body();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

/** Captured verbatim from the live site (field subset). */
const REAL_STATUS = {
  data: {
    quota_display_type: 'CNY',
    quota_per_unit: 500000,
    usd_exchange_rate: 7,
    system_name: '开物云',
    version: '1.0.0'
  },
  success: true
};

process.stdout.write('normalize\n');

test('reads the real CNY conversion factors', () => {
  const factors = readQuotaStatus(REAL_STATUS);
  assert.equal(factors.currency, 'CNY');
  assert.equal(factors.quotaPerUnit, 500000);
  assert.equal(factors.exchangeRate, 7);
  assert.equal(factors.quotaUnitFallback, false);
});

test('converts raw quota to CNY the way the dashboard does', () => {
  const factors = readQuotaStatus(REAL_STATUS);
  // 16.8 CNY of balance is 16.8 / 7 * 500000 = 1200000 raw quota.
  assert.equal(quotaToAmount(1200000, factors), 16.8);
  // A used total of 2400000 raw quota is 33.6 CNY.
  assert.equal(quotaToAmount(2400000, factors), 33.6);
});

test('treats a missing quota_per_unit as the legacy unit', () => {
  const factors = readQuotaStatus({ data: { quota_display_type: 'USD' } });
  assert.equal(factors.quotaPerUnit, LEGACY_QUOTA_PER_UNIT);
  assert.equal(factors.quotaUnitFallback, true);
  assert.equal(factors.currency, 'USD');
  assert.equal(factors.exchangeRate, 1);
});

test('refuses CNY when the exchange rate is missing', () => {
  assert.throws(
    () => readQuotaStatus({ data: { quota_display_type: 'CNY', quota_per_unit: 500000 } }),
    (error) => error.reason === 'missing-exchange-rate'
  );
});

test('refuses an unsupported display currency instead of guessing', () => {
  assert.throws(
    () => readQuotaStatus({ data: { quota_display_type: 'EUR', quota_per_unit: 500000 } }),
    (error) => error.reason === 'unsupported-currency'
  );
});

test('token channel reports the key cap and spend, never a balance', () => {
  const factors = readQuotaStatus(REAL_STATUS);
  const { label, used, keyCap } = readTokenQuota({
    code: true,
    data: {
      name: 'example-key',
      total_granted: 2400000,
      total_used: 2100000,
      total_available: 300000,
      unlimited_quota: false,
      expires_at: 0
    }
  }, factors);

  assert.equal(label, 'example-key');
  assert.equal(used, 29.4);
  assert.equal(keyCap.unlimited, false);
  assert.equal(keyCap.available, 4.2);
  assert.equal(keyCap.expiresAt, null);
  // The token channel must not hand back anything balance-shaped.
  assert.equal(Object.prototype.hasOwnProperty.call(readTokenQuota({ data: {} }, factors), 'balance'), false);
});

// Regression: the on-site bug. A key with `unlimited_quota: true` was rendered
// as "无限额" while the account actually held ¥3.80. The flag describes the key's
// own ceiling, so it must land in `keyCap` and never in `balance`.
test('an uncapped key is a key fact, not an unlimited balance', () => {
  const factors = readQuotaStatus(REAL_STATUS);
  const { keyCap, used } = readTokenQuota({
    data: {
      name: 'example-key',
      unlimited_quota: true,
      total_granted: 10000,
      total_used: 2400000,
      total_available: -2390000
    }
  }, factors);

  assert.equal(keyCap.unlimited, true);
  assert.equal(used, 33.6);
  // A negative remainder is not a ceiling.
  assert.equal(keyCap.available, null);
});

test('a negative remainder on a capped key is discarded', () => {
  const factors = readQuotaStatus(REAL_STATUS);
  const { keyCap } = readTokenQuota({
    data: { unlimited_quota: false, total_granted: 1, total_used: 100, total_available: -99 }
  }, factors);
  assert.equal(keyCap.available, null);
});

test('an unknown balance is explicit and never claims unlimited', () => {
  const balance = unknownBalance('CNY');
  assert.equal(balance.known, false);
  assert.equal(balance.remaining, null);
  assert.equal(balance.unlimited, false);
});

test('reports a zero key remainder as a real value, not an error', () => {
  const factors = readQuotaStatus(REAL_STATUS);
  const { keyCap } = readTokenQuota({ data: { total_available: 0, total_used: 1 } }, factors);
  assert.equal(keyCap.available, 0);
});

test('normalises an account response and derives the total', () => {
  const factors = readQuotaStatus(REAL_STATUS);
  const { balance, group } = readAccountQuota({
    success: true,
    data: { quota: 1200000, used_quota: 2400000, group: 'default' }
  }, factors);

  assert.equal(balance.remaining, 16.8);
  assert.equal(balance.used, 33.6);
  assert.equal(balance.total, 50.4);
  assert.equal(group, 'default');
});

test('surfaces an account-level rejection', () => {
  assert.throws(
    () => readAccountQuota({ success: false, message: 'nope' }, readQuotaStatus(REAL_STATUS)),
    (error) => error.reason === 'account-rejected'
  );
});

test('reads camelCase variants from other New API forks', () => {
  assert.equal(pick({ totalAvailable: 7 }, 'total_available'), 7);
  assert.equal(pick({ 'total-available': 9 }, 'total_available'), 9);
  assert.equal(pick({}, 'total_available'), undefined);
});

test('coerces numeric strings and rejects junk', () => {
  assert.equal(toNumber(' 42 '), 42);
  assert.equal(toNumber('abc'), null);
  assert.equal(toNumber(Infinity), null);
  assert.equal(toNumber(null), null);
  assert.equal(round(1.005, 2), 1.01);
});

test('computes a daily average only from a usable window', () => {
  assert.equal(dailyAverage(7.2, 7), 1.0286);
  assert.equal(dailyAverage(7.2, 0), null);
  assert.equal(dailyAverage(null, 7), null);
});

test('grades the runway against the configured thresholds', () => {
  const thresholds = { warningDays: 3, criticalDays: 1 };
  assert.equal(forecastRunway({ remaining: 100 }, 1, thresholds).level, 'normal');
  assert.equal(forecastRunway({ remaining: 2 }, 1, thresholds).level, 'warning');
  assert.equal(forecastRunway({ remaining: 0.5 }, 1, thresholds).level, 'critical');
  assert.equal(forecastRunway({ remaining: 0 }, 1, thresholds).daysLeft, 0);
});

test('says unknown rather than zero when there is no spend history', () => {
  const forecast = forecastRunway({ remaining: 16.8 }, null, { warningDays: 3, criticalDays: 1 });
  assert.equal(forecast.daysLeft, null);
  assert.equal(forecast.level, 'unknown');
});

test('never forecasts a runway for an unlimited key', () => {
  const forecast = forecastRunway({ remaining: null, unlimited: true }, 5, { warningDays: 3, criticalDays: 1 });
  assert.equal(forecast.daysLeft, null);
  assert.equal(forecast.level, 'normal');
});

test('builds a snapshot with a stable shape', () => {
  const snapshot = buildSnapshot({
    source: 'token',
    fetchedAt: '2026-10-26T08:42:03.000Z',
    site: {
      name: '开物云',
      baseURL: 'https://ai.zhijianginc.com',
      currency: 'CNY',
      quotaPerUnit: 500000,
      exchangeRate: 7
    },
    balance: { remaining: 16.8, used: 33.6, total: 50.4, currency: 'CNY', unlimited: false, expiresAt: null },
    label: 'example-key',
    usage: { last24h: 7.2, total: 33.6, requests: 120 },
    forecast: { dailyAvg: 1.05, daysLeft: 16, level: 'normal' },
    warnings: ['sample']
  });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.source, 'token');
  assert.equal(snapshot.site.currency, 'CNY');
  assert.equal(snapshot.balance.remaining, 16.8);
  assert.equal(snapshot.forecast.level, 'normal');
  assert.deepEqual(snapshot.warnings, ['sample']);
});

test('coerces an unrecognised level to unknown', () => {
  const snapshot = buildSnapshot({
    source: 'token',
    site: { baseURL: 'x', currency: 'CNY', quotaPerUnit: 500000, exchangeRate: 7 },
    balance: { remaining: 1, currency: 'CNY' },
    forecast: { dailyAvg: null, daysLeft: null, level: 'bogus' }
  });
  assert.equal(snapshot.forecast.level, 'unknown');
});

process.stdout.write(`normalize: ${passed} passed\n`);
