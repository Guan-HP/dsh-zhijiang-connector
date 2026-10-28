/**
 * Configuration: the fields the settings page renders and the service reads.
 *
 * Secrets are deliberately absent. Only *references* to credentials live here;
 * the values go through the harness credential store, so they never appear in a
 * profile file, a settings export, or a support screenshot.
 *
 * Fields marked `volatile()` are projected straight into the live snapshot when
 * the settings service commits them, so editing the site address takes effect on
 * the next refresh instead of at the next restart.
 *
 * @module dsh-zhijiang-connector/config
 */

/** Default site: the relay this connector was written for. */
export const DEFAULT_BASE_URL = 'https://ai.zhijianginc.com';

/** Default credential reference names. */
export const DEFAULT_CREDENTIAL_REF = 'zhijiangApiKey';
export const DEFAULT_ACCOUNT_CREDENTIAL_REF = '';

/**
 * A schema node with the capabilities the harness actually consumes.
 *
 * The harness's Cordis runtime validates a plugin's exported `Config` through
 * the Standard Schema interface — `Config['~standard'].validate(raw)` — and the
 * settings service renders it from `.toJSON()`. A profile-installed bundle must
 * not assume `@deepseek-ai/schemastery` resolves from its own dependency graph,
 * so this builder implements both surfaces locally with no dependency.
 *
 * @param {'string'|'number'|'boolean'} type - value type.
 * @param {object} meta - schema metadata.
 * @returns {Function & object} the schema node.
 */
function node(type, meta) {
  const schema = (raw) => {
    if (raw === undefined) return undefined;
    if (type === 'string') return typeof raw === 'string' ? raw : undefined;
    if (type === 'boolean') return typeof raw === 'boolean' ? raw : undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };

  schema.meta = { ...meta };
  schema.default = (value) => {
    schema.meta.default = value;
    return schema;
  };
  schema.description = (value) => {
    schema.meta.description = value;
    return schema;
  };
  schema.role = (value) => {
    schema.meta.role = value;
    return schema;
  };
  schema.volatile = () => {
    schema.meta.volatile = true;
    return schema;
  };
  schema.min = (value) => {
    schema.meta.min = value;
    return schema;
  };
  schema.max = (value) => {
    schema.meta.max = value;
    return schema;
  };
  schema.step = (value) => {
    schema.meta.step = value;
    return schema;
  };
  schema.toJSON = () => ({ type, meta: schema.meta });
  return schema;
}

/**
 * Build the configuration schema.
 *
 * The returned object is callable (for local parsing) and exposes the Standard
 * Schema interface the Cordis runtime validates plugins through. Validation
 * never fails: every field is optional and falls back to its default later in
 * `resolveConfig`, so a partially written config file still boots the plugin.
 *
 * @param {object} fields - per-field schema nodes.
 * @returns {Function & {dict: object, '~standard': object}} the object schema.
 */
function objectSchema(fields) {
  const schema = (raw) => {
    if (raw === undefined) return undefined;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const out = {};
    for (const [key, child] of Object.entries(fields)) {
      if (!(key in raw)) continue;
      const value = child(raw[key]);
      if (value !== undefined) out[key] = value;
    }
    return out;
  };

  schema.dict = fields;
  schema.meta = { type: 'object' };
  schema.toJSON = () => ({
    type: 'object',
    meta: schema.meta,
    dict: Object.fromEntries(Object.entries(fields).map(([key, child]) => [key, child.toJSON()]))
  });

  // Standard Schema v1 interface: the Cordis runtime calls this synchronously
  // and expects `{ value }` or `{ issues }`.
  schema['~standard'] = {
    version: 1,
    vendor: 'dsh-zhijiang-connector',
    validate: (raw) => ({ value: schema(raw) ?? {} })
  };

  return schema;
}

/**
 * The plugin's configuration schema.
 */
export const Config = objectSchema({
  baseURL: node('string', { description: 'Relay site address, e.g. https://ai.zhijianginc.com' })
    .default(DEFAULT_BASE_URL)
    .volatile(),
  credentialRef: node('string', { description: 'Credential name holding the sk- API key' })
    .default(DEFAULT_CREDENTIAL_REF)
    .volatile(),
  accountCredentialRef: node('string', {
    description: 'Optional credential name holding a dashboard access token (PAT); empty disables the account channel'
  })
    .default(DEFAULT_ACCOUNT_CREDENTIAL_REF)
    .volatile(),
  // Profile-only, like `showBadge`: set it through the profile's patch when a site
  // requires the `new-api-user` header, not from the settings page.
  accountUserId: node('string', { description: 'Numeric user id sent as new-api-user with the access token (profile configuration only)' })
    .default('')
    .volatile(),
  refreshSeconds: node('number', { description: 'Seconds between refreshes (minimum 60)' })
    .default(300)
    .min(60)
    .max(86400)
    .volatile(),
  warningDays: node('number', { description: 'Turn the badge amber when fewer than this many days remain' })
    .default(3)
    .min(0)
    .max(365)
    .volatile(),
  criticalDays: node('number', { description: 'Turn the badge red when fewer than this many days remain' })
    .default(1)
    .min(0)
    .max(365)
    .volatile(),
  // Profile-only: the settings page does not render a toggle for this field, so
  // it is documented here as the one place it can be set. Marking the owner
  // explicitly is what keeps "in the schema" from reading as "editable in the UI".
  showBadge: node('boolean', { description: 'Show the sidebar badge (profile configuration only)' })
    .default(true)
    .volatile(),
  walletURL: node('string', { description: 'Top-up page opened by the panel button' })
    .default(`${DEFAULT_BASE_URL}/console/wallet`)
    .volatile()
});

/**
 * Apply defaults and clamp values that would otherwise break the service.
 *
 * Configuration arrives from a user-editable file, so nothing here trusts it:
 * a zero refresh interval would hammer the relay, and a reversed threshold pair
 * would make every balance look critical.
 *
 * @param {object} [raw] - user configuration.
 * @returns {object} a complete, safe configuration.
 */
export function resolveConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const pickText = (value, fallback) => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text === '' ? fallback : text;
  };
  const pickNumber = (value, fallback, min, max) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  };

  const criticalDays = pickNumber(source.criticalDays, 1, 0, 365);
  const warningDays = Math.max(criticalDays, pickNumber(source.warningDays, 3, 0, 365));

  const baseURL = pickText(source.baseURL, DEFAULT_BASE_URL).replace(/\/+$/, '');

  return {
    baseURL,
    credentialRef: pickText(source.credentialRef, DEFAULT_CREDENTIAL_REF),
    accountCredentialRef: typeof source.accountCredentialRef === 'string'
      ? source.accountCredentialRef.trim()
      : DEFAULT_ACCOUNT_CREDENTIAL_REF,
    accountUserId: typeof source.accountUserId === 'string' ? source.accountUserId.trim() : '',
    refreshSeconds: pickNumber(source.refreshSeconds, 300, 60, 86400),
    warningDays,
    criticalDays,
    showBadge: source.showBadge !== false,
    walletURL: pickText(source.walletURL, `${baseURL}/console/wallet`),
    timeoutMs: 15000
  };
}
