/**
 * Upstream I/O: the only module that talks to the relay.
 *
 * Three functions, one per channel. Each returns the parsed JSON body or throws
 * a tagged error; none of them converts money or decides what a value means.
 * Keeping the network boundary this narrow is what lets `normalize.js` stay a
 * pure module and what makes adding a fourth channel (a usage-log reconciliation
 * endpoint, say) a matter of one more function rather than a refactor.
 *
 * @module dsh-zhijiang-connector/upstream
 */

import { readQuotaStatus } from './normalize.js';

/** Upper bound on any single upstream request. */
export const REQUEST_TIMEOUT_MS = 15000;

/**
 * A structured transport failure.
 *
 * `retryable` separates "the site is busy, try later" from "the key is wrong,
 * stop trying" — the service uses it to decide whether a stale cache may stand.
 *
 * @param {string} reason - stable machine-readable code.
 * @param {string} message - human-readable detail.
 * @param {{status?: number, retryable?: boolean}} [extra] - transport facts.
 * @returns {Error & {code: string, reason: string, status: number, retryable: boolean}} the error.
 */
export function upstreamError(reason, message, extra = {}) {
  const error = new Error(message);
  error.name = 'UpstreamError';
  error.code = 'upstream';
  error.reason = reason;
  error.status = extra.status ?? 0;
  error.retryable = extra.retryable === true;
  return error;
}

/**
 * Join a configured base URL with an API path.
 *
 * The setting accepts a trailing slash, a bare host, or the full dashboard URL
 * a user copied from their browser, so normalisation happens here rather than
 * being demanded of the user.
 *
 * @param {string} baseURL - configured site address.
 * @param {string} path - absolute API path beginning with `/`.
 * @returns {string} the absolute request URL.
 */
export function joinURL(baseURL, path) {
  const trimmed = String(baseURL ?? '').trim().replace(/\/+$/, '');
  if (trimmed === '') throw upstreamError('missing-base-url', 'site address is not configured');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw upstreamError('invalid-base-url', `site address must start with http(s)://, got: ${trimmed}`);
  }
  return `${trimmed}${path}`;
}

/**
 * Perform one GET and parse JSON.
 *
 * @param {string} url - absolute URL.
 * @param {{headers?: Record<string, string>, fetchImpl?: typeof fetch, timeoutMs?: number}} options - request options.
 * @returns {Promise<unknown>} the parsed body.
 */
async function getJSON(url, options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw upstreamError('no-fetch', 'this runtime has no global fetch');
  }

  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'dsh-zhijiang-connector/0.1',
        ...options.headers
      },
      signal: controller.signal,
      redirect: 'follow'
    });
  } catch (cause) {
    const aborted = controller.signal.aborted;
    throw upstreamError(
      aborted ? 'timeout' : 'network',
      aborted ? `request timed out after ${timeoutMs}ms` : `network error: ${cause?.message ?? cause}`,
      { retryable: true }
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw upstreamError('unauthorized', `upstream rejected the credential (HTTP ${response.status})`, {
      status: response.status,
      retryable: false
    });
  }
  if (response.status === 429) {
    throw upstreamError('rate-limited', 'upstream is rate limiting requests', {
      status: response.status,
      retryable: true
    });
  }
  if (!response.ok) {
    throw upstreamError('http-error', `upstream answered HTTP ${response.status}`, {
      status: response.status,
      retryable: response.status >= 500
    });
  }

  const text = await response.text();
  if (text.trim() === '') {
    throw upstreamError('empty-body', 'upstream returned an empty body', { retryable: true });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw upstreamError('invalid-json', 'upstream returned a body that is not JSON', { retryable: true });
  }
}

/**
 * Read the site's public conversion factors and identity.
 *
 * No credential is sent: `/api/status` is deliberately public on New API, and
 * this call must keep working before the user has configured anything.
 *
 * @param {{baseURL: string, fetchImpl?: typeof fetch, timeoutMs?: number}} options - request options.
 * @returns {Promise<{siteName: string | null, factors: object}>} site facts.
 */
export async function fetchSiteMeta(options) {
  const body = await getJSON(joinURL(options.baseURL, '/api/status'), options);
  const data = body?.data;
  const siteName = typeof data?.system_name === 'string' && data.system_name.trim() !== ''
    ? data.system_name.trim()
    : null;
  return { siteName, factors: readQuotaStatus(body) };
}

/**
 * Read the quota attached to one API key.
 *
 * @param {{baseURL: string, apiKey: string, fetchImpl?: typeof fetch, timeoutMs?: number}} options - request options.
 * @returns {Promise<unknown>} the parsed body.
 */
export async function fetchTokenQuota(options) {
  const apiKey = String(options.apiKey ?? '').trim();
  if (apiKey === '') throw upstreamError('missing-credential', 'no API key is configured');
  return getJSON(joinURL(options.baseURL, '/api/usage/token/'), {
    ...options,
    headers: { authorization: `Bearer ${apiKey}` }
  });
}

/**
 * Read the account-level balance.
 *
 * The `new-api-user` header carries the numeric user id that New API expects
 * alongside a dashboard access token; it is optional because some builds infer
 * the account from the token alone.
 *
 * @param {{baseURL: string, accessToken: string, userId?: string,
 *   fetchImpl?: typeof fetch, timeoutMs?: number}} options - request options.
 * @returns {Promise<unknown>} the parsed body.
 */
export async function fetchAccountQuota(options) {
  const token = String(options.accessToken ?? '').trim();
  if (token === '') throw upstreamError('missing-credential', 'no access token is configured');

  const headers = { authorization: `Bearer ${token}` };
  const userId = String(options.userId ?? '').trim();
  if (userId !== '') headers['new-api-user'] = userId;

  return getJSON(joinURL(options.baseURL, '/api/user/self'), { ...options, headers });
}
