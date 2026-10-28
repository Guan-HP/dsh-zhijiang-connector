/**
 * HTTP surface: three exact routes under `/api/zhijiang/`.
 *
 * Exact routes bypass the harness's RPC trust fence, so every handler applies
 * its own loopback peer fence. That fence is the only thing standing between a
 * page in any other browser tab and this user's balance, which is why it lives
 * here rather than being assumed from the mount point.
 *
 * Handlers serialise and set status codes. They contain no business logic:
 * everything they need is already normalised by the time it reaches them.
 *
 * @module dsh-zhijiang-connector/routes
 */

import { CREDENTIAL_REF_PATTERN } from './settings-store.js';

/** Snapshot route: the panel's single read. */
export const SNAPSHOT_PATH = '/api/zhijiang/snapshot';

/** Forced refresh route: the panel's explicit reload button. */
export const REFRESH_PATH = '/api/zhijiang/refresh';

/** Health route: answers "did the browser reach the host at all". */
export const HEALTH_PATH = '/api/zhijiang/status';

/** Credential route: reads presence, and stores a key the user typed. */
export const CREDENTIAL_PATH = '/api/zhijiang/credential';

/** Settings route: the editable configuration, validated and persisted here. */
export const SETTINGS_PATH = '/api/zhijiang/settings';

/**
 * Credential name used when the user pastes an access token without one.
 *
 * Fixed so the token lands somewhere predictable, and so the URL-free lookup in
 * `config.accountCredentialRef` has a stable default to point at.
 */
export const DEFAULT_ACCOUNT_REF = 'ZHIJIANG_ACCESS_TOKEN';

/**
 * Read a JSON request body with a hard size cap.
 *
 * The settings page sends one short secret here, so anything larger is either a
 * mistake or an attempt to exhaust memory; both are refused rather than read.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {number} [limit] - maximum bytes.
 * @returns {Promise<object>} the parsed body.
 */
async function readJSONBody(req, limit = 8192) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('request body is too large');
      error.reason = 'payload-too-large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('request body is not valid JSON');
    error.reason = 'invalid-body';
    throw error;
  }
}

/**
 * Decide whether a request arrived over the loopback interface.
 *
 * A Unix socket peer has no `remoteAddress` and is accepted, because reaching it
 * already requires local access. Anything else must be a loopback literal.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} whether the peer is local.
 */
export function isLoopback(req) {
  const address = req?.socket?.remoteAddress;
  if (typeof address !== 'string' || address === '') return true;
  return address === '::1'
    || address === '127.0.0.1'
    || address.startsWith('127.')
    || address === '::ffff:127.0.0.1'
    || address.startsWith('::ffff:127.');
}

/**
 * Send a JSON response.
 *
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - serialisable payload.
 * @returns {void}
 */
export function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

/**
 * Translate a thrown error into a status code and a body.
 *
 * The body always carries a machine-readable `reason`, so the panel can say
 * something specific ("this key is rejected") instead of a generic failure.
 *
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {Error & {reason?: string, status?: number}} error - the failure.
 * @returns {void}
 */
export function sendError(res, error) {
  const reason = error?.reason ?? 'unknown';
  const message = error?.message ?? 'unknown error';

  let status = 502;
  if (reason === 'not-configured' || reason === 'missing-credential') status = 409;
  else if (reason === 'unauthorized') status = 401;
  else if (reason === 'rate-limited') status = 429;
  else if (reason === 'timeout' || reason === 'network') status = 504;

  sendJSON(res, status, {
    ok: false,
    error: { reason, message, upstreamStatus: error?.status ?? null }
  });
}

/**
 * Wrap a handler with the loopback fence and a JSON error boundary.
 *
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler - inner handler.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} guarded handler.
 */
function guard(handler) {
  return async (req, res) => {
    if (!isLoopback(req)) {
      sendJSON(res, 403, { ok: false, error: { reason: 'forbidden', message: 'this endpoint is loopback-only' } });
      return;
    }
    try {
      await handler(req, res);
    } catch (error) {
      sendError(res, error);
    }
  };
}

/**
 * Build the route table.
 *
 * @param {{service: object, getConfig: () => object}} deps - collaborators.
 * @returns {Array<{kind: string, path: string, handler: Function}>} route registrations.
 */
export function createRoutes(deps) {
  return [
    {
      kind: 'exact',
      path: SNAPSHOT_PATH,
      handler: guard(async (req, res) => {
        const snapshot = await deps.service.getSnapshot();
        sendJSON(res, 200, snapshot);
      })
    },
    {
      kind: 'exact',
      path: REFRESH_PATH,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') {
          sendJSON(res, 405, { ok: false, error: { reason: 'method-not-allowed', message: 'use POST' } });
          return;
        }
        const snapshot = await deps.service.refresh({ force: true });
        sendJSON(res, 200, snapshot);
      })
    },
    {
      kind: 'exact',
      path: HEALTH_PATH,
      handler: guard(async (req, res) => {
        const config = deps.getConfig();
        sendJSON(res, 200, {
          ok: true,
          version: '0.1.0',
          baseURL: config.baseURL,
          configured: true,
          lastError: deps.service.lastError()
        });
      })
    },
    {
      kind: 'exact',
      path: CREDENTIAL_PATH,
      handler: guard(async (req, res) => {
        // GET reports presence only. The values never travel to the browser, so
        // a screenshot or a devtools capture cannot leak them.
        if (req.method === 'GET') {
          // Repair a secret pasted into a name field before reporting state, so
          // the page reflects the fixed configuration immediately.
          await deps.migrate?.();
          const config = deps.getConfig();
          const apiKey = await deps.credentials.status(config.credentialRef);
          const accessTokenRef = config.accountCredentialRef || DEFAULT_ACCOUNT_REF;
          const accessToken = config.accountCredentialRef
            ? await deps.credentials.status(config.accountCredentialRef)
            : { configured: false, writable: true, source: null };
          sendJSON(res, 200, {
            ok: true,
            // Legacy flat fields kept for the API-key row.
            ref: config.credentialRef,
            ...apiKey,
            apiKey,
            accessToken: { ...accessToken, ref: accessTokenRef }
          });
          return;
        }

        if (req.method !== 'POST') {
          sendJSON(res, 405, { ok: false, error: { reason: 'method-not-allowed', message: 'use GET or POST' } });
          return;
        }

        await deps.migrate?.();
        const config = deps.getConfig();

        const body = await readJSONBody(req);
        const value = typeof body.value === 'string' ? body.value.trim() : '';
        const kind = body.kind === 'accessToken' ? 'accessToken' : 'apiKey';

        // An empty value is an explicit clear.
        //
        // Clearing also drops the reference name the page no longer needs: a
        // leftover name would keep pointing at an empty slot, and the next save
        // would write it back as if the user had chosen it.
        if (value === '') {
          const ref = kind === 'accessToken'
            ? (config.accountCredentialRef || DEFAULT_ACCOUNT_REF)
            : config.credentialRef;
          await deps.credentials.clear(ref);
          if (kind === 'accessToken' && config.accountCredentialRef) {
            deps.settings.clear('accountCredentialRef');
          }
          try {
            await deps.onSettingsChanged();
          } catch {
            // The credential is gone either way; a failed refresh is the panel's to report.
          }
          sendJSON(res, 200, { ok: true, kind, ref, configured: false, cleared: true });
          return;
        }

        if (kind === 'accessToken') {
          // A dashboard access token, not an API key. Rejecting an `sk-` value
          // here is the guard against pasting the wrong secret.
          if (!/^nap_[A-Za-z0-9_-]{12,}$/.test(value)) {
            sendJSON(res, 400, {
              ok: false,
              error: {
                reason: 'invalid-credential',
                message: '访问令牌以 nap_ 开头；这是站点「安全与访问 → 访问令牌」里创建的那种，不是 sk- 密钥'
              }
            });
            return;
          }

          // Which name the token is stored under, decided in one place.
          //
          // The caller may name a slot explicitly (`ref`), which is what lets a
          // second site or a second account keep its own token instead of
          // overwriting the first. Otherwise the configured name wins, and only
          // a missing or unusable name falls back to the canonical default.
          const requested = typeof body.ref === 'string' ? body.ref.trim() : '';
          if (requested !== '' && !CREDENTIAL_REF_PATTERN.test(requested)) {
            sendJSON(res, 400, {
              ok: false,
              error: { reason: 'invalid-ref', message: '凭据名只能包含字母、数字和下划线，且不能以数字开头' }
            });
            return;
          }

          const configured = typeof config.accountCredentialRef === 'string'
            ? config.accountCredentialRef.trim()
            : '';
          const ref = requested !== ''
            ? requested
            : (configured !== '' && CREDENTIAL_REF_PATTERN.test(configured) ? configured : DEFAULT_ACCOUNT_REF);

          await deps.credentials.store(ref, value);

          // Point the configuration at the ref we just wrote. Without this the
          // token would sit in the store and nothing would ever read it.
          if (config.accountCredentialRef !== ref) {
            const stored = deps.settings.write({ accountCredentialRef: ref });
            if (!stored.ok) {
              sendJSON(res, 500, { ok: false, error: { reason: 'settings-write-failed', message: '令牌已保存，但引用名写入失败' } });
              return;
            }
          }

          try {
            await deps.onSettingsChanged();
          } catch {
            // Stored is stored; the panel reports a refresh failure itself.
          }
          sendJSON(res, 200, { ok: true, kind, ref, configured: true, cleared: false });
          return;
        }

        if (!/^sk-[A-Za-z0-9_-]{8,}$/.test(value)) {
          sendJSON(res, 400, {
            ok: false,
            error: { reason: 'invalid-credential', message: 'API 密钥以 sk- 开头，且至少 11 个字符' }
          });
          return;
        }

        await deps.credentials.store(config.credentialRef, value);
        // A new key invalidates the cached snapshot: refresh so the panel shows
        // the new balance instead of the old key's.
        try {
          await deps.service.refresh({ force: true });
        } catch {
          // A stored key with a failing refresh is still a successful save; the
          // panel reports the refresh failure on its own.
        }
        sendJSON(res, 200, { ok: true, kind, ref: config.credentialRef, configured: true, cleared: false });
      })
    },
    {
      kind: 'exact',
      path: SETTINGS_PATH,
      handler: guard(async (req, res) => {
        if (req.method === 'GET') {
          // Same repair as the credential route: the page reads settings first,
          // so a pasted secret must be relocated before it is echoed back.
          await deps.migrate?.();
          const config = deps.getConfig();
          // Only the fields the page may edit; the resolved values, so the form
          // shows reality rather than the schema defaults.
          sendJSON(res, 200, {
            ok: true,
            values: {
              baseURL: config.baseURL,
              credentialRef: config.credentialRef,
              accountCredentialRef: config.accountCredentialRef,
              refreshSeconds: config.refreshSeconds,
              warningDays: config.warningDays,
              criticalDays: config.criticalDays,
              walletURL: config.walletURL
            }
          });
          return;
        }

        if (req.method !== 'POST') {
          sendJSON(res, 405, { ok: false, error: { reason: 'method-not-allowed', message: 'use GET or POST' } });
          return;
        }

        const body = await readJSONBody(req);
        const result = deps.settings.write(body);
        if (!result.ok) {
          // 400 with per-field messages: the page can mark the offending input
          // instead of showing one opaque "save rejected".
          sendJSON(res, 400, { ok: false, errors: result.errors, values: result.values });
          return;
        }

        // Apply immediately: recompute the live config, then refresh so the
        // panel reflects a changed site or credential without a restart.
        try {
          await deps.onSettingsChanged();
        } catch {
          // The values are persisted; a failed refresh is reported by the panel.
        }

        // Echo the *merged* configuration, not just the fields in this patch:
        // the page replaces its whole draft with this, so a partial echo would
        // blank every input the user did not touch.
        const next = deps.getConfig();
        sendJSON(res, 200, {
          ok: true,
          persisted: result.persisted,
          values: {
            baseURL: next.baseURL,
            credentialRef: next.credentialRef,
            accountCredentialRef: next.accountCredentialRef,
            refreshSeconds: next.refreshSeconds,
            warningDays: next.warningDays,
            criticalDays: next.criticalDays,
            walletURL: next.walletURL
          }
        });
      })
    }
  ];
}
