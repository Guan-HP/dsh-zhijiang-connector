/**
 * Plugin-owned settings store.
 *
 * The harness has a settings service, and this plugin still participates in it
 * through its exported `Config`. But the settings *form* surface proved
 * unreliable for this package: the page rendered schema defaults instead of the
 * profile's values, and `mutate` came back rejected, so a user had no way to
 * change anything from the UI.
 *
 * Rather than fight that seam, user edits are persisted here — a small JSON file
 * under the harness home — and merged **above** the profile configuration at
 * resolve time:
 *
 *     defaults  <  profile config  <  settings form
 *
 * That ordering means the file is optional (delete it and the profile config
 * applies again), auditable, and independent of whether the host's config-form
 * plumbing happens to be working.
 *
 * @module dsh-zhijiang-connector/settings-store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Bumped when the stored shape changes. */
export const STORE_VERSION = 1;

/**
 * The credential-reference pattern, shared by validation and the routes.
 *
 * The harness credential store accepts exactly this shape, so the settings page
 * must reject anything else *before* it reaches the store: a name that passes
 * here but fails there would look saved and then silently never resolve.
 */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Fields the settings page may edit, with their validation rules. */
export const EDITABLE_FIELDS = [
  'baseURL',
  'credentialRef',
  'accountCredentialRef',
  'refreshSeconds',
  'warningDays',
  'criticalDays',
  'walletURL'
];

/**
 * Resolve the settings file path.
 * @param {string} dshHome - resolved `$DSH_HOME`.
 * @returns {string} absolute path.
 */
export function settingsPath(dshHome) {
  return join(dshHome, 'storages', 'zhijiang-connector-settings.json');
}

/**
 * Decide whether a string is secret material rather than a credential name.
 *
 * This is the guard for the mistake users actually make: pasting the API key or
 * access token into a field that asks for the *name* it is stored under. Both
 * `sk-…` and `nap_…` are made of identifier characters, so a plain
 * identifier-pattern check accepts them and the lookup then fails silently.
 *
 * @param {unknown} value - candidate reference name.
 * @returns {boolean} true when the value looks like a secret.
 */
export function looksLikeSecret(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  // Note the prefix punctuation: `sk-` uses a hyphen, `nap_` uses an underscore.
  return /^(sk-|nap_)[A-Za-z0-9_-]{12,}$/.test(text);
}

/**
 * Validate one candidate value for a field.
 *
 * Returns either `{ value }` (normalised) or `{ error }`. Kept as one table so
 * the HTTP route and the tests agree about what is acceptable.
 *
 * @param {string} field - field name.
 * @param {unknown} raw - proposed value.
 * @returns {{value?: unknown, error?: string}} outcome.
 */
export function validateField(field, raw) {
  const asText = typeof raw === 'string' ? raw.trim() : raw;

  switch (field) {
    case 'baseURL': {
      const text = String(asText ?? '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^\s]+$/i.test(text)) return { error: '站点地址必须以 http:// 或 https:// 开头' };
      return { value: text };
    }
    case 'walletURL': {
      const text = String(asText ?? '').trim();
      if (text === '') return { value: '' };
      if (!/^https?:\/\/[^\s]+$/i.test(text)) return { error: '充值页地址必须是完整 URL，或留空' };
      return { value: text };
    }
    case 'credentialRef':
    case 'accountCredentialRef': {
      const text = String(asText ?? '').trim();
      if (text === '') return { value: '' };
      // Catch the mistake this field keeps inviting: a pasted secret.
      if (looksLikeSecret(text)) {
        return { error: '这里填的是凭据「名称」，不是令牌本身。请改用上方的「账户令牌」框粘贴令牌。' };
      }
      // Mirrors the harness credential store's own reference pattern.
      if (!CREDENTIAL_REF_PATTERN.test(text)) {
        return { error: '凭据名只能包含字母、数字和下划线，且不能以数字开头' };
      }
      return { value: text };
    }
    case 'refreshSeconds': {
      const number = Number(asText);
      if (!Number.isFinite(number)) return { error: '刷新间隔必须是数字' };
      if (number < 60 || number > 86400) return { error: '刷新间隔需在 60 ~ 86400 秒之间' };
      return { value: Math.round(number) };
    }
    case 'warningDays':
    case 'criticalDays': {
      const number = Number(asText);
      if (!Number.isFinite(number)) return { error: '阈值必须是数字' };
      if (number < 0 || number > 365) return { error: '阈值需在 0 ~ 365 天之间' };
      return { value: Math.round(number) };
    }
    default:
      return { error: `未知字段：${field}` };
  }
}

/**
 * Validate a whole patch.
 *
 * Undefined fields are skipped rather than stored, so a partial save never
 * erases a value the user did not touch.
 *
 * @param {object} patch - proposed field values.
 * @returns {{values: object, errors: Record<string, string>}} accepted values and per-field errors.
 */
export function validatePatch(patch) {
  const values = {};
  const errors = {};

  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { values, errors: { _: '请求体必须是对象' } };
  }

  for (const [field, raw] of Object.entries(patch)) {
    if (!EDITABLE_FIELDS.includes(field)) {
      errors[field] = '该字段不可通过设置页修改';
      continue;
    }
    if (raw === undefined) continue;
    const outcome = validateField(field, raw);
    if (outcome.error) errors[field] = outcome.error;
    else values[field] = outcome.value;
  }

  // Cross-field rule: the amber threshold must not sit below the red one.
  const warning = values.warningDays;
  const critical = values.criticalDays;
  if (typeof warning === 'number' && typeof critical === 'number' && warning < critical) {
    errors.warningDays = '“转黄”阈值不能小于“转红”阈值';
  }

  return { values, errors };
}

/**
 * Create the store.
 *
 * Reads synchronously once at construction: `apply` is synchronous, and the file
 * is a handful of bytes. Writes are synchronous too, because the route only
 * commits after the write succeeds — an async write would report success before
 * knowing whether it landed.
 *
 * @param {string} file - absolute path to the settings file.
 * @returns {object} the store handle.
 */
export function createSettingsStore(file) {
  let current = {};
  let rawCurrent = {};

  /**
   * Read the file without validating it.
   *
   * Kept separate from `load` because validation *drops* rejected values — and
   * a secret pasted into a name field is exactly one of those. Migration needs
   * to see the raw file to find it and move it; a sanitised view would hide the
   * very thing that needs repairing.
   *
   * @returns {object} whatever the file holds.
   */
  function loadRaw() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed?.version !== STORE_VERSION) return {};
      const raw = parsed.values;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return raw;
    } catch {
      return {};
    }
  }

  /**
   * Load the file, tolerating absence and damage.
   * @returns {object} the stored values.
   */
  function load() {
    // Re-validate on read: the file is user-editable.
    return validatePatch(loadRaw()).values;
  }

  current = load();
  rawCurrent = loadRaw();

  /**
   * Current stored values.
   * @returns {object} a copy, safe to hand to a consumer.
   */
  function values() {
    return { ...current };
  }

  /**
   * The file's values exactly as written, including anything validation drops.
   * Used only to find misplaced secrets; never fed into configuration.
   * @returns {object} a copy of the raw values.
   */
  function raw() {
    return { ...rawCurrent };
  }

  /**
   * Persist one values object atomically.
   *
   * Written to a sibling temp file and renamed over the target, so a crash or a
   * full disk leaves the previous file intact instead of a half-written one.
   * Both `write` and `clear` go through here: they used to differ, and the
   * non-atomic path could truncate the file the settings page depends on.
   *
   * @param {object} values - the complete value set to persist.
   * @returns {string | null} an error message, or null when the write landed.
   */
  function persistValues(values) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: STORE_VERSION, values }, null, 2), 'utf8');
      renameSync(temp, file);
      return null;
    } catch (error) {
      return error?.message ?? String(error);
    }
  }

  /**
   * Merge and persist a patch.
   * @param {object} patch - proposed values.
   * @returns {{ok: boolean, values: object, errors: object, persisted: boolean}} result.
   */
  function write(patch) {
    const { values: accepted, errors } = validatePatch(patch);
    if (Object.keys(errors).length > 0) {
      return { ok: false, values: { ...current }, errors, persisted: false };
    }

    const next = { ...current, ...accepted };
    const failure = persistValues(next);
    if (failure !== null) {
      return {
        ok: false,
        values: { ...current },
        errors: { _: `写入失败：${failure}` },
        persisted: false
      };
    }

    current = next;
    // The file now equals the sanitised set, so the raw view follows it — that
    // is what makes a repair permanent rather than re-detected on every read.
    rawCurrent = { ...next };
    return { ok: true, values: { ...current }, errors: {}, persisted: true };
  }

  /**
   * Drop one stored field, falling back to the profile value.
   * @param {string} field - field name.
   * @returns {{ok: boolean, values: object}} result.
   */
  function clear(field) {
    if (!(field in current)) return { ok: true, values: { ...current } };
    const next = { ...current };
    delete next[field];
    if (persistValues(next) !== null) return { ok: false, values: { ...current } };
    current = next;
    // The raw view mirrors the file, exactly as `write` keeps it.
    rawCurrent = { ...next };
    return { ok: true, values: { ...current } };
  }

  return {
    file,
    values,
    raw,
    write,
    clear,
    reload: () => { current = load(); rawCurrent = loadRaw(); return { ...current }; }
  };
}
