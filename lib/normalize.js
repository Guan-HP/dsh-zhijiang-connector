/**
 * Pure data layer: raw New API responses in, one normalised snapshot out.
 *
 * Nothing here performs I/O or reads the clock implicitly. Every function takes
 * its inputs explicitly and returns a plain object, so the whole module is
 * testable offline and reusable by a future dashboard or CLI without dragging
 * the host along.
 *
 * The money rule this module exists to enforce:
 *
 *     amount = rawQuota / quotaPerUnit * exchangeRate
 *
 * New API stores quota as an integer in units of `quota_per_unit` per display
 * currency unit. On a CNY site `quota_display_type` is `CNY` and the USD rate is
 * the CNY-per-USD figure. A site may change either number at any time, so both
 * are read from `/api/status` at runtime. Hard-coding them is how balance
 * plugins silently start reporting the wrong amount after an admin edit.
 *
 * @module dsh-zhijiang-connector/normalize
 */

/** Legacy New API builds that predate `/api/status` used this fixed unit. */
export const LEGACY_QUOTA_PER_UNIT = 500000;

/** Display currencies this plugin can convert. Anything else is unsupported. */
export const SUPPORTED_CURRENCIES = ['USD', 'CNY'];

/** Forecast severity levels, ordered from calm to alarming. */
export const LEVELS = ['unknown', 'normal', 'warning', 'critical'];

/**
 * A structured, serialisable failure.
 *
 * Routes translate `reason` into a status and the panel into a sentence; the
 * message is a developer-facing fallback, never the only thing a user sees.
 *
 * @param {string} code - stable machine-readable reason.
 * @param {string} message - human-readable detail.
 * @returns {Error & { code: string, reason: string }} the tagged error.
 */
export function normalizeError(code, message) {
  const error = new Error(message);
  error.name = 'NormalizeError';
  error.code = 'normalize';
  error.reason = code;
  return error;
}

/**
 * Coerce a value to a finite number, or `null`.
 *
 * New API is inconsistent about number-versus-string across versions and across
 * endpoints, so every numeric read funnels through here.
 *
 * @param {unknown} value - raw value from a response.
 * @returns {number | null} the finite number, else null.
 */
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Coerce a value to a non-empty trimmed string, or `null`.
 *
 * @param {unknown} value - raw value from a response.
 * @returns {string | null} the string, else null.
 */
export function toText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Read the first present property among `keys`, tolerating snake/camel drift.
 *
 * Exact matches win. Failing that, keys are compared after stripping `_`, `-`
 * and whitespace and lower-casing, which absorbs the `total_granted` versus
 * `totalGranted` difference between New API forks. Only own properties are
 * consulted, so a polluted prototype cannot leak a value in.
 *
 * @param {unknown} source - object to read.
 * @param {...string} keys - candidate property names, most preferred first.
 * @returns {unknown} the first present value, else undefined.
 */
export function pick(source, ...keys) {
  if (source === null || typeof source !== 'object') return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  const squash = (value) => String(value).toLowerCase().replace(/[_\s-]/g, '');
  const ownKeys = Object.keys(source);
  for (const key of keys) {
    const target = squash(key);
    for (const ownKey of ownKeys) {
      if (squash(ownKey) === target) return source[ownKey];
    }
  }
  return undefined;
}

/**
 * Round to a fixed number of decimals without float noise.
 *
 * @param {number | null} value - value to round.
 * @param {number} [decimals] - digits to keep.
 * @returns {number | null} the rounded value, or null when input was null.
 */
export function round(value, decimals = 2) {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Describe how this site converts raw quota into money.
 *
 * `quota_per_unit` missing or non-positive falls back to the legacy constant and
 * is flagged, because a site that answers `/api/status` without the field is an
 * old build rather than a misconfigured one. An unknown display currency is a
 * hard failure: guessing would misreport every amount on the panel.
 *
 * @param {unknown} statusBody - parsed `/api/status` response.
 * @returns {{currency: string, quotaPerUnit: number, exchangeRate: number,
 *   quotaUnitFallback: boolean}} conversion factors.
 */
export function readQuotaStatus(statusBody) {
  const data = pick(statusBody, 'data');
  if (data === null || typeof data !== 'object') {
    throw normalizeError('invalid-status', '/api/status did not return a data object');
  }

  const rawUnit = toNumber(pick(data, 'quota_per_unit'));
  const quotaUnitFallback = rawUnit === null || rawUnit <= 0;
  const quotaPerUnit = quotaUnitFallback ? LEGACY_QUOTA_PER_UNIT : rawUnit;

  const rawCurrency = pick(data, 'quota_display_type');
  const currency = rawCurrency === undefined || rawCurrency === null || rawCurrency === ''
    ? 'USD'
    : (toText(rawCurrency) ?? '').toUpperCase();

  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw normalizeError('unsupported-currency', `unsupported quota display currency: ${currency}`);
  }

  let exchangeRate = 1;
  if (currency === 'CNY') {
    const rate = toNumber(pick(data, 'usd_exchange_rate'));
    if (rate === null || rate <= 0) {
      throw normalizeError('missing-exchange-rate', 'CNY display requires a positive usd_exchange_rate');
    }
    exchangeRate = rate;
  }

  return { currency, quotaPerUnit, exchangeRate, quotaUnitFallback };
}

/**
 * Convert a raw quota integer into a display-currency amount.
 *
 * @param {unknown} rawQuota - integer quota from the API.
 * @param {ReturnType<typeof readQuotaStatus>} factors - conversion factors.
 * @returns {number | null} the amount, or null when the input was not numeric.
 */
export function quotaToAmount(rawQuota, factors) {
  const quota = toNumber(rawQuota);
  if (quota === null) return null;
  return round((quota / factors.quotaPerUnit) * factors.exchangeRate, 4);
}

/**
 * Normalise the token-scoped response (`/api/usage/token/`).
 *
 * This endpoint describes **one API key**, not the wallet. Its
 * `unlimited_quota` flag means "this key has no per-key spending cap" — the
 * spend is still billed to a finite account balance. Reporting that flag as an
 * unlimited balance is wrong, and on the relay this connector was built for it
 * is actively misleading: the key is uncapped while the account held ¥3.80.
 *
 * So the token channel yields only facts it can actually support:
 *   - `keyCap` — the key's own ceiling (or that it has none)
 *   - `used`   — spend attributed to this key, which is a real money figure
 *
 * It deliberately returns **no balance**. Only the account channel can state
 * how much money is left.
 *
 * @param {unknown} body - parsed response.
 * @param {ReturnType<typeof readQuotaStatus>} factors - conversion factors.
 * @returns {{label: string | null, used: number | null, keyCap: object}} key facts.
 */
export function readTokenQuota(body, factors) {
  const data = pick(body, 'data');
  if (data === null || typeof data !== 'object') {
    throw normalizeError('invalid-token-usage', '/api/usage/token/ did not return a data object');
  }

  const capUnlimited = pick(data, 'unlimited_quota') === true;
  const granted = quotaToAmount(pick(data, 'total_granted'), factors);
  const used = quotaToAmount(pick(data, 'total_used'), factors);
  const rawAvailable = quotaToAmount(pick(data, 'total_available'), factors);

  // An uncapped key routinely reports a negative remainder once it has spent
  // past its tiny grant (observed: granted 0.25 CNY, used 91.20, available
  // -90.95). A negative number is not a balance, so it is discarded rather than
  // rendered as a negative ceiling.
  const available = capUnlimited || rawAvailable === null || rawAvailable < 0 ? null : rawAvailable;

  const expiresAt = toNumber(pick(data, 'expires_at'));

  return {
    label: toText(pick(data, 'name')),
    used,
    keyCap: {
      unlimited: capUnlimited,
      granted,
      available,
      currency: factors.currency,
      expiresAt: expiresAt !== null && expiresAt > 0 ? new Date(expiresAt * 1000).toISOString() : null
    }
  };
}

/**
 * A balance the current channel cannot state.
 *
 * Kept explicit instead of `null` so the panel can distinguish "we asked and the
 * answer is zero" from "we were not allowed to ask". The latter is the normal
 * case when only an `sk-` key is configured: `/api/user/self` rejects it with
 * 401, because reading the wallet needs a dashboard access token.
 *
 * @param {string} currency - display currency.
 * @returns {object} an unknown balance.
 */
export function unknownBalance(currency) {
  return {
    known: false,
    remaining: null,
    used: null,
    total: null,
    currency,
    unlimited: false,
    expiresAt: null
  };
}

/**
 * Normalise the account-scoped response (`/api/user/self`).
 *
 * Requires a dashboard access token rather than an `sk-` key, so it is the
 * optional channel that yields account-level balance instead of one key's cap.
 *
 * @param {unknown} body - parsed response.
 * @param {ReturnType<typeof readQuotaStatus>} factors - conversion factors.
 * @returns {{balance: object, group: string | null}} normalised balance.
 */
export function readAccountQuota(body, factors) {
  if (pick(body, 'success') === false) {
    throw normalizeError('account-rejected', '/api/user/self reported failure');
  }
  const data = pick(body, 'data');
  if (data === null || typeof data !== 'object') {
    throw normalizeError('invalid-account', '/api/user/self did not return a data object');
  }

  const remaining = quotaToAmount(pick(data, 'quota'), factors);
  const used = quotaToAmount(pick(data, 'used_quota'), factors);
  if (remaining === null) {
    throw normalizeError('missing-quota', '/api/user/self is missing quota');
  }

  const rawRemaining = toNumber(pick(data, 'quota'));
  const rawUsed = toNumber(pick(data, 'used_quota'));
  const total = rawRemaining !== null && rawUsed !== null
    ? quotaToAmount(rawRemaining + rawUsed, factors)
    : null;

  return {
    group: toText(pick(data, 'group')),
    balance: {
      known: true,
      remaining,
      used,
      total,
      currency: factors.currency,
      unlimited: false,
      expiresAt: null
    }
  };
}

/**
 * Average daily spend over the sample window, or null when it cannot be known.
 *
 * @param {number | null} spent - amount spent during the window.
 * @param {number} windowDays - length of the window in days.
 * @returns {number | null} average per day, rounded to 4 decimals.
 */
export function dailyAverage(spent, windowDays) {
  if (spent === null || !Number.isFinite(spent) || !Number.isFinite(windowDays) || windowDays <= 0) {
    return null;
  }
  return round(spent / windowDays, 4);
}

/**
 * Turn a remaining balance and a burn rate into a runway and a severity level.
 *
 * `unknown` is a first-class outcome: a fresh install has no spend history, and
 * claiming "0 days left" there would be a lie. Unlimited keys never produce a
 * runway either.
 *
 * @param {object} balance - normalised balance.
 * @param {number | null} dailyAvg - average spend per day.
 * @param {{warningDays: number, criticalDays: number}} thresholds - cut-offs.
 * @returns {{dailyAvg: number | null, daysLeft: number | null, level: string}} forecast.
 */
export function forecastRunway(balance, dailyAvg, thresholds) {
  if (!balance || balance.unlimited === true) {
    return { dailyAvg, daysLeft: null, level: 'normal' };
  }
  const remaining = toNumber(balance.remaining);
  if (remaining === null) {
    return { dailyAvg, daysLeft: null, level: 'unknown' };
  }
  if (remaining <= 0) {
    return { dailyAvg, daysLeft: 0, level: 'critical' };
  }
  if (dailyAvg === null || dailyAvg <= 0) {
    return { dailyAvg, daysLeft: null, level: 'unknown' };
  }

  const daysLeft = round(remaining / dailyAvg, 2);
  let level = 'normal';
  if (daysLeft < thresholds.criticalDays) level = 'critical';
  else if (daysLeft < thresholds.warningDays) level = 'warning';

  return { dailyAvg, daysLeft, level };
}

/**
 * Assemble the snapshot the panel consumes.
 *
 * @param {object} input - already-normalised parts.
 * @returns {object} the snapshot described in the README's API section.
 */
export function buildSnapshot(input) {
  const { source, site, balance, keyCap, usage, forecast, label, group, fetchedAt, stale, warnings } = input;
  const known = balance.known !== false;
  return {
    ok: true,
    fetchedAt: fetchedAt ?? null,
    stale: stale === true,
    source,
    site: {
      name: site.name ?? null,
      baseURL: site.baseURL,
      currency: site.currency,
      quotaPerUnit: site.quotaPerUnit,
      exchangeRate: site.exchangeRate,
      quotaUnitFallback: site.quotaUnitFallback === true
    },
    balance: {
      // `known: false` means the configured channel cannot see the wallet — not
      // that the wallet is empty, and never that it is unlimited.
      known,
      remaining: known ? balance.remaining : null,
      used: balance.used,
      total: balance.total,
      currency: balance.currency,
      unlimited: balance.unlimited === true,
      expiresAt: balance.expiresAt ?? null
    },
    keyCap: keyCap
      ? {
        unlimited: keyCap.unlimited === true,
        granted: keyCap.granted ?? null,
        available: keyCap.available ?? null,
        currency: keyCap.currency ?? site.currency,
        expiresAt: keyCap.expiresAt ?? null
      }
      : null,
    label: label ?? null,
    group: group ?? null,
    usage: usage ?? null,
    forecast: {
      dailyAvg: forecast.dailyAvg,
      daysLeft: forecast.daysLeft,
      level: LEVELS.includes(forecast.level) ? forecast.level : 'unknown'
    },
    warnings: Array.isArray(warnings) ? warnings : []
  };
}
