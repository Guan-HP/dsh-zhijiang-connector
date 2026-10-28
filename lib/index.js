/**
 * dsh-zhijiang-connector — host half.
 *
 * Connects the dsh web GUI to a New API relay (written against Kaiwu Cloud at
 * https://ai.zhijianginc.com) and exposes the wallet as three read-only,
 * loopback-only endpoints plus one explicit refresh action:
 *
 *   GET  /api/zhijiang/snapshot  — the panel's single read
 *   POST /api/zhijiang/refresh   — forced refresh
 *   GET  /api/zhijiang/status    — health and last error
 *
 * The plugin stores no secrets of its own: it holds *references* to credential
 * names, and resolves the values through the harness credential seam at request
 * time. The only thing it persists is a cache of the last good snapshot and a
 * bounded spend history, used to keep the panel populated during an outage and
 * to compute a burn rate.
 *
 * Everything below `apply` is split by responsibility: `normalize` is pure,
 * `upstream` is the only module doing network I/O, `cache` is the only module
 * touching disk, `service` orchestrates, and `routes` serialises.
 *
 * @module dsh-zhijiang-connector
 */

import { cachePath, resolveDshHome } from './cache.js';
import { Config, resolveConfig } from './config.js';
import { DEFAULT_ACCOUNT_REF, createRoutes } from './routes.js';
import { createService } from './service.js';
import { createSettingsStore, looksLikeSecret, settingsPath } from './settings-store.js';

/** Stable Cordis plugin name. */
export const name = 'zhijiang-connector';

/** Services that must exist before this plugin activates. */
export const inject = ['webServer', 'credentials', 'settings'];

export { Config };

/**
 * Report a non-fatal problem without ever throwing.
 *
 * `apply` runs inside the harness's plugin activation. Anything thrown there
 * marks the whole entry `failed`, and a failed entry is fatal to the desktop
 * boot ("web boot: N entries did not activate"). A degraded panel is always
 * preferable to a boot that refuses to start, so every optional step below
 * reports through here instead of propagating.
 *
 * @param {object} ctx - plugin context.
 * @param {string} format - printf-style message.
 * @param {...unknown} args - format arguments.
 * @returns {void}
 */
function warn(ctx, format, ...args) {
  try {
    ctx?.logger?.warn?.(`zhijiang-connector: ${format}`, ...args);
  } catch {
    // Logging is best-effort; it must never be the thing that fails a boot.
  }
}

/**
 * Read one credential through the harness seam.
 *
 * The seam's exact shape differs across harness minor versions, so both the
 * single-argument and the `{ ref }` call styles are attempted before giving up.
 *
 * @param {object} ctx - plugin context.
 * @param {string} ref - credential reference name.
 * @returns {Promise<string>} the secret, or an empty string.
 */
async function resolveCredential(ctx, ref) {
  const credentials = ctx.credentials;
  if (!credentials) return '';

  const attempts = [
    () => credentials.get(ref),
    () => credentials.get({ ref }),
    () => credentials.resolve(ref),
    () => credentials.read(ref)
  ];

  for (const attempt of attempts) {
    try {
      const value = await attempt();
      if (typeof value === 'string') return value;
      if (value && typeof value.value === 'string') return value.value;
      if (value && typeof value.secret === 'string') return value.secret;
    } catch {
      // Try the next call shape; an absent method is not a failure worth surfacing.
    }
  }
  return '';
}

/**
 * Build the credential access object the routes use.
 *
 * Writing a secret is a Host-side capability only: the browser half can read
 * whether a key exists, never the value, and cannot store one directly. Keeping
 * the write here means the secret is handled in exactly one place, and the
 * browser bundle never gains the ability to exfiltrate a key it did not own.
 *
 * @param {object} ctx - plugin context.
 * @returns {{status: (ref: string) => Promise<object>,
 *   store: (ref: string, value: string) => Promise<void>,
 *   clear: (ref: string) => Promise<void>}} credential accessors.
 */
function createCredentialAccess(ctx) {
  /**
   * Report whether a credential is present, without revealing it.
   * @param {string} ref - reference name.
   * @returns {Promise<{configured: boolean, writable: boolean, source: string | null}>} presence.
   */
  async function status(ref) {
    const credentials = ctx.credentials;
    if (!credentials) return { configured: false, writable: false, source: null };

    if (typeof credentials.describe === 'function') {
      try {
        const info = await credentials.describe(ref);
        if (info && typeof info === 'object') {
          return {
            configured: info.configured === true,
            writable: info.writable === true,
            source: typeof info.source === 'string' ? info.source : null
          };
        }
      } catch {
        // Fall through to the resolve-based probe.
      }
    }

    const value = await resolveCredential(ctx, ref);
    return { configured: value !== '', writable: true, source: null };
  }

  /**
   * Store one credential.
   * @param {string} ref - reference name.
   * @param {string} value - the secret.
   * @returns {Promise<void>} resolves once stored.
   */
  async function store(ref, value) {
    const credentials = ctx.credentials;
    if (!credentials || typeof credentials.set !== 'function') {
      const error = new Error('the harness credential store cannot be written from this plugin');
      error.reason = 'credential-unwritable';
      throw error;
    }
    await credentials.set(ref, value);
  }

  /**
   * Remove one credential.
   * @param {string} ref - reference name.
   * @returns {Promise<void>} resolves once removed.
   */
  async function clear(ref) {
    const credentials = ctx.credentials;
    if (!credentials || typeof credentials.unset !== 'function') {
      const error = new Error('the harness credential store cannot be modified from this plugin');
      error.reason = 'credential-unwritable';
      throw error;
    }
    await credentials.unset(ref);
  }

  return { status, store, clear };
}

/**
 * Mount the plugin.
 *
 * @param {object} ctx - Cordis context with `webServer`, `credentials`, `settings`.
 * @param {object} [rawConfig] - configuration supplied by the profile.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  // Settings the user saved through the plugin's own page take precedence over
  // the profile's config, so a form edit is never silently overridden.
  const store = createSettingsStore(settingsPath(resolveDshHome()));

  /**
   * Merge layers into the effective configuration.
   *
   * A secret pasted into a *reference name* field is not a name, so it is
   * dropped here. The default then applies, and `migrateMisplacedSecrets` moves
   * the value into the credential store where it belongs. Without this, that
   * one user mistake would make the balance silently unavailable forever.
   *
   * @returns {object} the resolved config.
   */
  function compose() {
    const profile = { ...(rawConfig ?? {}) };
    const stored = store.values();

    for (const layer of [profile, stored]) {
      if (looksLikeSecret(layer.credentialRef)) delete layer.credentialRef;
      if (looksLikeSecret(layer.accountCredentialRef)) delete layer.accountCredentialRef;
    }

    return resolveConfig({ ...profile, ...stored });
  }

  let config = compose();

  // Register the page presentation with the harness settings service. The
  // signature is `configure(presentation, owner)`; passing a callback where the
  // owner fiber belongs leaves the presentation unregistered, which is harmless
  // here because the page no longer depends on the host's config form.
  try {
    if (ctx.settings && typeof ctx.settings.configure === 'function') {
      ctx.effect(() => {
        try {
          const dispose = ctx.settings.configure({ auto: false }, ctx.fiber);
          return typeof dispose === 'function' ? dispose : () => {};
        } catch (error) {
          // A second registration for the same fiber throws; the page still works.
          warn(ctx, 'settings presentation not registered: %s', error?.message ?? error);
          return () => {};
        }
      }, 'zhijiang-connector: settings');
    }
  } catch (error) {
    warn(ctx, 'settings effect skipped: %s', error?.message ?? error);
  }

  const service = createService({
    getConfig: () => config,
    resolveCredential: (ref) => resolveCredential(ctx, ref),
    cacheFile: cachePath(resolveDshHome())
  });

  const credentials = createCredentialAccess(ctx);

  /**
   * Adopt freshly saved settings and refresh the snapshot.
   * @returns {Promise<void>} resolves once the new values are live.
   */
  async function onSettingsChanged() {
    config = compose();
    await service.refresh({ force: true });
  }

  /**
   * Move secrets that were pasted into reference-name fields into the store.
   *
   * Users reasonably read "账户令牌引用名" as "put the token here". Rather than
   * only rejecting that on the next save, an install that already contains the
   * mistake repairs itself: the value is stored under the canonical credential
   * name and the field is rewritten to point at it.
   *
   * @returns {Promise<void>} resolves once the repair has been attempted.
   */
  async function migrateMisplacedSecrets() {
    // The raw view, not the sanitised one: validation drops a pasted secret,
    // so `values()` would hide exactly what needs moving.
    const stored = store.raw();
    let changed = false;

    if (looksLikeSecret(stored.accountCredentialRef)) {
      try {
        await credentials.store(DEFAULT_ACCOUNT_REF, stored.accountCredentialRef);
        store.write({ accountCredentialRef: DEFAULT_ACCOUNT_REF });
        changed = true;
      } catch {
        // Leave it alone; the panel already says the wallet is unreadable.
      }
    }

    if (looksLikeSecret(stored.credentialRef)) {
      try {
        const ref = resolveConfig({}).credentialRef;
        await credentials.store(ref, stored.credentialRef);
        store.write({ credentialRef: ref });
        changed = true;
      } catch {
        // Same reasoning as above.
      }
    }

    if (changed) {
      config = compose();
      await service.refresh({ force: true }).catch(() => {});
    }
  }

  // Repair on boot, off the apply path so mounting never waits on disk.
  void migrateMisplacedSecrets().catch(() => {});

  for (const route of createRoutes({
    service,
    getConfig: () => config,
    credentials,
    settings: store,
    onSettingsChanged,
    migrate: migrateMisplacedSecrets
  })) {
    ctx.effect(() => {
      try {
        return ctx.webServer.register(route);
      } catch (error) {
        // `register` throws on a duplicate (kind, path) — another mount of this
        // plugin, or a stale fiber from a live reload, already owns the route.
        // Losing one panel endpoint is survivable; failing activation is not.
        warn(ctx, 'route %s not registered: %s', route.path, error?.message ?? error);
        return () => {};
      }
    }, `zhijiang-connector: ${route.path}`);
  }
}
