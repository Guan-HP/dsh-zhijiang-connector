/**
 * Orchestration: pick a channel, degrade safely, keep the cache honest.
 *
 * The service owns three pieces of state that no other module is allowed to
 * touch: the in-memory snapshot, the in-flight refresh, and the spend history.
 * Everything it returns is a complete snapshot; callers never see a half-built
 * one, because a panel that flickers between "3.8" and "error" is worse than a
 * panel that admits it is showing yesterday's number.
 *
 * Channel preference is account first, then key. The account channel reports the
 * whole wallet; the key channel reports one key's cap, which is usually a
 * superset of what the user cares about but can be `unlimited` and therefore
 * say nothing about money. When the account channel is configured it wins.
 *
 * @module dsh-zhijiang-connector/service
 */

import { appendSample, readCache, spendOverWindow, writeCache } from './cache.js';
import { buildSnapshot, dailyAverage, forecastRunway, readAccountQuota, readTokenQuota, unknownBalance } from './normalize.js';
import { fetchAccountQuota, fetchSiteMeta, fetchTokenQuota } from './upstream.js';

/** How long a snapshot stays authoritative before a refresh is due. */
export const DEFAULT_REFRESH_MS = 300000;

/** The trailing window used to compute the burn rate. */
export const SPEND_WINDOW_DAYS = 7;

/** Milliseconds in one day. */
const DAY_MS = 86400000;

/** Tolerance when deciding whether the sample history covers a full day. */
const DAY_SLACK_MS = 3600000;

/**
 * Create the service.
 *
 * @param {object} deps - injected collaborators.
 * @param {() => object} deps.getConfig - read the live configuration.
 * @param {(ref: string) => Promise<string>} deps.resolveCredential - read one stored secret.
 * @param {string} deps.cacheFile - absolute cache path.
 * @param {() => number} [deps.now] - clock, injectable for tests.
 * @param {typeof fetch} [deps.fetchImpl] - fetch, injectable for tests.
 * @returns {object} the service handle.
 */
export function createService(deps) {
  const now = deps.now ?? (() => Date.now());
  const state = {
    snapshot: null,
    samples: [],
    loaded: false,
    inFlight: null,
    lastError: null
  };

  /**
   * Load the cache once, lazily, so construction never touches disk.
   * @returns {Promise<void>} resolves once loaded.
   */
  async function ensureLoaded() {
    if (state.loaded) return;
    const cached = await readCache(deps.cacheFile);
    state.snapshot = cached.snapshot;
    state.samples = cached.samples;
    state.loaded = true;
  }

  /**
   * Persist the current state, tolerating a read-only home directory.
   * @returns {Promise<void>} resolves whether or not the write landed.
   */
  async function persist() {
    await writeCache(deps.cacheFile, { snapshot: state.snapshot, samples: state.samples });
  }

  /**
   * Read one credential, treating an unset reference as "not configured".
   * @param {string} ref - credential reference name.
   * @returns {Promise<string>} the secret, or an empty string.
   */
  async function readCredential(ref) {
    const name = String(ref ?? '').trim();
    if (name === '') return '';
    try {
      const value = await deps.resolveCredential(name);
      return typeof value === 'string' ? value.trim() : '';
    } catch {
      return '';
    }
  }

  /**
   * Fetch the balance through the best configured channel.
   *
   * Credentials are resolved *before* any network call. Otherwise an
   * unconfigured install reports whatever the site happens to answer first — a
   * DNS failure or a proxy error — instead of the one thing the user can act
   * on: "no credential is configured yet".
   *
   * @param {object} config - live configuration.
   * @returns {Promise<{source: string, balance: object, label: string|null,
   *   group: string|null, siteName: string|null, factors: object, warnings: string[]}>} the result.
   */
  async function fetchBalance(config) {
    const warnings = [];

    const accountToken = await readCredential(config.accountCredentialRef);
    const apiKey = await readCredential(config.credentialRef);

    if (accountToken === '' && apiKey === '') {
      const error = new Error('no credential is configured');
      error.reason = 'not-configured';
      error.code = 'config';
      throw error;
    }

    const site = await fetchSiteMeta({
      baseURL: config.baseURL,
      fetchImpl: deps.fetchImpl,
      timeoutMs: config.timeoutMs
    });

    if (accountToken !== '') {
      try {
        const body = await fetchAccountQuota({
          baseURL: config.baseURL,
          accessToken: accountToken,
          userId: config.accountUserId,
          fetchImpl: deps.fetchImpl,
          timeoutMs: config.timeoutMs
        });
        const { balance, group } = readAccountQuota(body, site.factors);
        return {
          source: 'account',
          balance,
          keyCap: null,
          label: null,
          used: balance.used,
          group,
          siteName: site.siteName,
          factors: site.factors,
          warnings
        };
      } catch (error) {
        // A configured-but-broken account token must not hide a working key.
        warnings.push(`account channel failed: ${error.reason ?? error.message}`);
      }
    }

    const apiKeyBody = await fetchTokenQuota({
      baseURL: config.baseURL,
      apiKey,
      fetchImpl: deps.fetchImpl,
      timeoutMs: config.timeoutMs
    }).catch((error) => {
      // Older builds have no /api/usage/token/; fall back to the account route
      // only when the account credential exists, otherwise report the failure.
      if (error.reason === 'http-error' && (error.status === 404 || error.status === 405) && accountToken === '') {
        error.reason = 'channel-unavailable';
        error.message = 'this site has no token-quota endpoint; configure an access token instead';
      }
      throw error;
    });

    const { balance, label, used, keyCap } = readTokenQuota(apiKeyBody, site.factors);

    // The token channel knows this key's cap and its spend, but not the wallet.
    // Returning an "unknown" balance here is the correct answer: on this relay a
    // key is routinely uncapped while the account balance is a small finite
    // number, and only `/api/user/self` (a dashboard access token) can read it.
    if (accountToken === '') {
      warnings.push('account-channel-not-configured');
    }

    return {
      source: 'token',
      balance: unknownBalance(site.factors.currency),
      keyCap,
      label,
      used,
      group: null,
      siteName: site.siteName,
      factors: site.factors,
      warnings
    };
  }

  /**
   * Compute the forecast from history plus the current balance.
   *
   * Spend is passed separately from the balance because the two come from
   * different places when only a key is configured: the key channel reports how
   * much was spent, while the wallet itself stays unknown.
   *
   * @param {object} config - live configuration.
   * @param {object} balance - normalised balance (may be unknown).
   * @param {number | null} used - spend attributable to the active channel.
   * @param {number} at - current epoch milliseconds.
   * @returns {{forecast: object, usage: object | null}} forecast and usage figures.
   */
  function computeForecast(config, balance, used, at) {
    const window = spendOverWindow(state.samples, SPEND_WINDOW_DAYS, at);
    const dailyAvg = window ? dailyAverage(window.spent, window.windowDays) : null;
    const forecast = forecastRunway(balance, dailyAvg, {
      warningDays: config.warningDays,
      criticalDays: config.criticalDays
    });

    const recent = state.samples.filter((sample) => {
      const stamp = Date.parse(sample.at);
      return Number.isFinite(stamp) && at - stamp <= DAY_MS;
    });
    const usedNow = typeof used === 'number' ? used : null;

    // A 24-hour figure is only honest once the samples actually span a day.
    // Without this guard a fresh install compares "now" against itself, reports
    // 0.00, and contradicts the site's own dashboard (which showed ¥18.02).
    const oldest = recent[0];
    const oldestAt = oldest ? Date.parse(oldest.at) : NaN;
    const spansDay = Number.isFinite(oldestAt) && at - oldestAt >= DAY_MS - DAY_SLACK_MS;
    const last24h = spansDay && usedNow !== null && typeof oldest.used === 'number' && usedNow >= oldest.used
      ? Math.round((usedNow - oldest.used) * 100) / 100
      : null;

    return {
      forecast,
      usage: usedNow === null && last24h === null
        ? null
        : { last24h, total: usedNow, requests: null, windowDays: window?.windowDays ?? null }
    };
  }

  /**
   * Record the spend so future forecasts have a burn rate to work from.
   *
   * @param {number | null} used - cumulative spend reported by the channel.
   * @param {number} at - current epoch milliseconds.
   * @returns {void}
   */
  function recordSample(used, at) {
    if (typeof used !== 'number') return;
    const iso = new Date(at).toISOString();
    const last = state.samples[state.samples.length - 1];
    // One sample per minute is plenty; a burst of manual refreshes must not
    // crowd out the week of history the forecast depends on.
    if (last && Number.isFinite(Date.parse(last.at)) && at - Date.parse(last.at) < 60000) {
      state.samples[state.samples.length - 1] = { at: iso, used };
      return;
    }
    state.samples = appendSample(state.samples, { at: iso, used });
  }

  /**
   * Refresh the snapshot from upstream.
   *
   * Concurrent callers share one in-flight request. On failure the previous
   * snapshot is returned marked stale, so a transient outage degrades the panel
   * rather than emptying it.
   *
   * @param {{force?: boolean}} [options] - refresh options.
   * @returns {Promise<object>} a complete snapshot.
   */
  async function refresh(options = {}) {
    await ensureLoaded();
    if (state.inFlight && !options.force) return state.inFlight;

    const run = (async () => {
      const config = deps.getConfig();
      const at = now();
      try {
        const result = await fetchBalance(config);
        recordSample(result.used, at);

        const { forecast, usage } = computeForecast(config, result.balance, result.used, at);
        const snapshot = buildSnapshot({
          source: result.source,
          fetchedAt: new Date(at).toISOString(),
          stale: false,
          site: {
            name: result.siteName,
            baseURL: config.baseURL,
            currency: result.factors.currency,
            quotaPerUnit: result.factors.quotaPerUnit,
            exchangeRate: result.factors.exchangeRate,
            quotaUnitFallback: result.factors.quotaUnitFallback
          },
          balance: result.balance,
          keyCap: result.keyCap,
          label: result.label,
          group: result.group,
          usage,
          forecast,
          warnings: result.warnings
        });

        state.snapshot = snapshot;
        state.lastError = null;
        await persist();
        return snapshot;
      } catch (error) {
        state.lastError = { reason: error.reason ?? 'unknown', message: error.message };
        if (state.snapshot) {
          const stale = {
            ...state.snapshot,
            stale: true,
            warnings: [...(state.snapshot.warnings ?? []), `refresh failed: ${error.reason ?? error.message}`]
          };
          state.snapshot = stale;
          return stale;
        }
        throw error;
      } finally {
        state.inFlight = null;
      }
    })();

    state.inFlight = run;
    return run;
  }

  /**
   * Return the current snapshot, refreshing when it is missing or too old.
   *
   * @param {{force?: boolean}} [options] - read options.
   * @returns {Promise<object>} a complete snapshot.
   */
  async function getSnapshot(options = {}) {
    await ensureLoaded();
    const config = deps.getConfig();
    const maxAge = (config.refreshSeconds ?? 300) * 1000;

    if (options.force) return refresh({ force: true });

    if (state.snapshot) {
      const age = now() - Date.parse(state.snapshot.fetchedAt ?? '');
      if (Number.isFinite(age) && age >= 0 && age < maxAge) return state.snapshot;
      // Serve what we have immediately, then refresh in the background, so the
      // panel never blocks on a slow relay.
      void refresh().catch(() => {});
      return state.snapshot;
    }

    return refresh();
  }

  /**
   * Report the last refresh failure, for the health endpoint.
   * @returns {object | null} the error record, or null.
   */
  function lastError() {
    return state.lastError;
  }

  return { getSnapshot, refresh, lastError };
}
