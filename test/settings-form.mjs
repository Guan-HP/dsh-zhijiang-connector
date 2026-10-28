/**
 * Settings-form and credential-route tests.
 *
 * Covers the two write paths the editable settings page introduces: ordinary
 * fields through the shared config form, and the API key through the host's
 * credential route. The key path is the sensitive one — it must never return the
 * secret, and must reject malformed input before storing anything.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRoutes } from '../lib/routes.js';
import { resolveConfig } from '../lib/config.js';

let passed = 0;
const failures = [];

/**
 * Run one named check.
 * @param {string} name - case name.
 * @param {() => Promise<void> | void} body - assertions.
 * @returns {Promise<void>} resolves when done.
 */
async function check(name, body) {
  try {
    await body();
    passed += 1;
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL  ${name}\n         ${error.message}\n`);
  }
}

/**
 * Build a routes table over a stub service and credential store.
 * @param {object} [options] - overrides.
 * @returns {{routes: Array, store: object}} routes and the recording store.
 */
function harness(options = {}) {
  const store = {
    value: options.initial ?? '',
    written: [],
    cleared: 0,
    writable: options.writable !== false
  };

  const credentials = {
    status: async () => ({
      configured: store.value !== '',
      writable: store.writable,
      source: store.value !== '' ? 'file' : null
    }),
    store: async (ref, value) => {
      if (!store.writable) {
        const error = new Error('read only');
        error.reason = 'credential-unwritable';
        throw error;
      }
      store.written.push({ ref, value });
      store.value = value;
    },
    clear: async () => {
      store.cleared += 1;
      store.value = '';
    }
  };

  const service = {
    getSnapshot: async () => ({ ok: true }),
    refresh: async () => {
      if (options.refreshFails) throw new Error('refresh exploded');
      return { ok: true };
    },
    lastError: () => null
  };

  return {
    routes: createRoutes({ service, getConfig: () => resolveConfig({}), credentials }),
    store
  };
}

/**
 * Invoke one route with a synthetic request/response pair.
 * @param {Array} routes - route table.
 * @param {string} path - target path.
 * @param {{method?: string, body?: string, remoteAddress?: string}} [init] - request details.
 * @returns {Promise<{status: number, body: any}>} the response.
 */
async function invoke(routes, path, init = {}) {
  const route = routes.find((r) => r.path === path);
  if (!route) throw new Error(`no route for ${path}`);

  const bodyText = init.body ?? '';
  const req = {
    method: init.method ?? 'GET',
    socket: { remoteAddress: init.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (bodyText !== '') yield Buffer.from(bodyText, 'utf8');
    }
  };

  let status = 0;
  let payload = '';
  const res = {
    writeHead: (code) => { status = code; },
    end: (text) => { payload = text ?? ''; }
  };

  await route.handler(req, res);
  return { status, body: payload === '' ? null : JSON.parse(payload) };
}

process.stdout.write('settings & credential routes\n');

await check('S1 GET 只报告密钥是否存在，绝不回传密钥值', async () => {
  const { routes } = harness({ initial: 'sk-secret-value-should-not-leak' });
  const { status, body } = await invoke(routes, '/api/zhijiang/credential');
  assert.equal(status, 200);
  assert.equal(body.configured, true);
  assert.equal(body.ref, 'zhijiangApiKey');
  assert.ok(!JSON.stringify(body).includes('sk-secret'), 'response must not contain the secret');
});

await check('S2 未配置时 configured=false', async () => {
  const { routes } = harness({ initial: '' });
  const { body } = await invoke(routes, '/api/zhijiang/credential');
  assert.equal(body.configured, false);
});

await check('S3 POST 合法密钥会写入凭据库', async () => {
  const { routes, store } = harness();
  const { status, body } = await invoke(routes, '/api/zhijiang/credential', {
    method: 'POST',
    body: JSON.stringify({ value: 'sk-FAKEfixtureNotARealKey00000000' })
  });
  assert.equal(status, 200);
  assert.equal(body.configured, true);
  assert.equal(body.cleared, false);
  assert.equal(store.written.length, 1);
  assert.equal(store.written[0].value, 'sk-FAKEfixtureNotARealKey00000000');
});

await check('S4 POST 非法密钥被拒绝且不写入', async () => {
  const { routes, store } = harness();
  const { status, body } = await invoke(routes, '/api/zhijiang/credential', {
    method: 'POST',
    body: JSON.stringify({ value: 'not-a-key' })
  });
  assert.equal(status, 400);
  assert.equal(body.error.reason, 'invalid-credential');
  assert.equal(store.written.length, 0);
});

await check('S5 POST 空值表示清除密钥', async () => {
  const { routes, store } = harness({ initial: 'sk-existing-key-1234' });
  const { status, body } = await invoke(routes, '/api/zhijiang/credential', {
    method: 'POST',
    body: JSON.stringify({ value: '' })
  });
  assert.equal(status, 200);
  assert.equal(body.cleared, true);
  assert.equal(body.configured, false);
  assert.equal(store.cleared, 1);
});

await check('S6 保存密钥后即使刷新失败也算保存成功', async () => {
  const { routes, store } = harness({ refreshFails: true });
  const { status, body } = await invoke(routes, '/api/zhijiang/credential', {
    method: 'POST',
    body: JSON.stringify({ value: 'sk-FAKEfixtureNotARealKey00000000' })
  });
  assert.equal(status, 200);
  assert.equal(body.configured, true);
  assert.equal(store.written.length, 1);
});

await check('S7 超大请求体被拒绝', async () => {
  const { routes } = harness();
  const { status, body } = await invoke(routes, '/api/zhijiang/credential', {
    method: 'POST',
    body: JSON.stringify({ value: 'sk-' + 'x'.repeat(20000) })
  });
  assert.equal(status, 502);
  assert.equal(body.error.reason, 'payload-too-large');
});

await check('S8 非法 JSON 被拒绝', async () => {
  const { routes } = harness();
  const { status, body } = await invoke(routes, '/api/zhijiang/credential', {
    method: 'POST',
    body: '{ broken'
  });
  assert.equal(status, 502);
  assert.equal(body.error.reason, 'invalid-body');
});

await check('S9 非回环对端不能写密钥', async () => {
  const { routes, store } = harness();
  const { status } = await invoke(routes, '/api/zhijiang/credential', {
    method: 'POST',
    body: JSON.stringify({ value: 'sk-FAKEfixtureNotARealKey00000000' }),
    remoteAddress: '192.168.0.7'
  });
  assert.equal(status, 403);
  assert.equal(store.written.length, 0);
});

await check('S10 不支持的 HTTP 方法被拒绝', async () => {
  const { routes } = harness();
  const { status, body } = await invoke(routes, '/api/zhijiang/credential', { method: 'DELETE' });
  assert.equal(status, 405);
  assert.equal(body.error.reason, 'method-not-allowed');
});

await check('S11 凭据库只读时保存失败有明确原因', async () => {
  const { routes } = harness({ writable: false });
  const { status, body } = await invoke(routes, '/api/zhijiang/credential', {
    method: 'POST',
    body: JSON.stringify({ value: 'sk-FAKEfixtureNotARealKey00000000' })
  });
  assert.equal(status, 502);
  assert.equal(body.error.reason, 'credential-unwritable');
});

process.stdout.write('\nclient settings form\n');

await check('S12 首屏只暴露两个凭据输入框，高级项默认收起', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

  let definition = null;
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
    createPortal: (node) => node
  };
  new Function('window', `${source}\nreturn window;`)({
    __ModuleLoader__: { load: (v) => { definition = v; } }
  });
  const mod = definition.factory((id) => (id === 'react' ? reactStub : null));

  const tree = mod.SettingsSection({ entryId: 'zhijiang-connector' });
  assert.ok(tree, 'settings section must render');

  // The page composes helper components (`Field`, `TextInput`), so inputs live
  // inside function-typed elements. Expand those, and pass through the third
  // createElement argument as well as props.children, since helpers may use
  // either form.
  const inputs = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 60) return;
    if (typeof node.type === 'function') {
      let rendered;
      try {
        rendered = node.type({
          ...(node.props ?? {}),
          children: (node.children && node.children.length > 0)
            ? (node.children.length === 1 ? node.children[0] : node.children)
            : node.props?.children
        });
      } catch {
        rendered = null;
      }
      walk(rendered, depth + 1);
      return;
    }
    if (node.type === 'input') inputs.push(node);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(tree, 0);

  // The whole point of the redesign: a new user sees one box per credential.
  // Site address, refresh interval and thresholds sit behind "高级设置".
  assert.equal(inputs.length, 2, `first screen must show exactly 2 inputs, got ${inputs.length}`);
  assert.ok(
    inputs.every((input) => input.props && input.props.type === 'text'),
    'both credential inputs must be text inputs'
  );
  const placeholders = inputs.map((input) => String(input.props.placeholder ?? ''));
  assert.ok(placeholders.some((p) => p.startsWith('sk-')), 'the API-key box must hint the sk- prefix');
  assert.ok(placeholders.some((p) => p.startsWith('nap_')), 'the token box must hint the nap_ prefix');
});

await check('S12b 首屏只有一个保存按钮，清除是独立动作', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

  let definition = null;
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    createPortal: (node) => node
  };
  new Function('window', `${source}\nreturn window;`)({
    __ModuleLoader__: { load: (v) => { definition = v; } }
  });
  const mod = definition.factory((id) => (id === 'react' ? reactStub : null));
  const tree = mod.SettingsSection({});

  const buttons = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 60) return;
    if (typeof node.type === 'function') {
      let rendered;
      try {
        rendered = node.type({
          ...(node.props ?? {}),
          children: (node.children && node.children.length > 0)
            ? (node.children.length === 1 ? node.children[0] : node.children)
            : node.props?.children
        });
      } catch {
        rendered = null;
      }
      walk(rendered, depth + 1);
      return;
    }
    if (node.type === 'button') buttons.push(node);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(tree, 0);

  const labels = buttons.map((b) => String((b.children ?? [])[0] ?? ''));
  const saves = labels.filter((l) => l === '保存');
  const clears = labels.filter((l) => l === '清除');

  // Three save buttons (key, token, settings) was the reported friction: one
  // gesture must be enough. Clearing is a different intent and keeps its own
  // button, one per credential.
  assert.equal(saves.length, 1, `expected exactly one save button, got ${saves.length}`);
  assert.equal(clears.length, 2, `expected one clear per credential, got ${clears.length}`);
  assert.ok(labels.some((l) => l.includes('高级设置')), 'advanced settings must be collapsible, not gone');
});


await check('S13 设置页在缺少 configForms 时仍可渲染（不白屏）', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let definition = null;
  const reactStub = {
    createElement: (t, p, ...c) => ({ t, p, c }),
    useState: (i) => [i, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    createPortal: (node) => node
  };
  new Function('window', `${source}\nreturn window;`)({
    __ModuleLoader__: { load: (v) => { definition = v; } }
  });
  const mod = definition.factory((id) => (id === 'react' ? reactStub : null));
  const tree = mod.SettingsSection({});
  assert.ok(tree);
});

await check('S14 设置分区可注册，且不依赖宿主 configForms', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let definition = null;
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (i) => [i, () => {}],
    useEffect: () => {}
  };
  new Function('window', `${source}\nreturn window;`)({
    __ModuleLoader__: { load: (v) => { definition = v; } }
  });
  const mod = definition.factory((id) => (id === 'react' ? reactStub : null));

  const registrations = [];
  mod.apply({
    // Deliberately no configForms service: the page must not need it.
    get: () => undefined,
    slots: {
      inject: (n, fn) => fn(),
      register: (options, component) => { registrations.push({ options, component }); return () => {}; }
    }
  });

  const section = registrations.find((r) => r.options.name === 'settings.section');
  assert.ok(section, 'settings.section must be registered');
  assert.equal(section.options.label(), '开物云');

  const element = section.component({ someSlotProp: 1 });
  assert.ok(element && element.props, 'wrapper must produce an element with props');

  const bare = section.component();
  assert.ok(bare && bare.props, 'wrapper must survive being called without props');
});

process.stdout.write('\nsettings route & store\n');

const { createSettingsStore, validatePatch } = await import('../lib/settings-store.js');
const { tmpdir } = await import('node:os');
const { join: joinPath } = await import('node:path');

/**
 * Wire a routes table around a real settings store in a temp file.
 * @returns {object} routes, store, and live state probes.
 */
function settingsHarness() {
  const file = joinPath(tmpdir(), `zj-settings-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const store = createSettingsStore(file);
  const state = { refreshCount: 0 };
  let liveConfig = resolveConfig({ baseURL: 'https://relay.test', credentialRef: 'ZHIJIANG_API_KEY' });

  const routes = createRoutes({
    service: {
      getSnapshot: async () => ({}),
      refresh: async () => { state.refreshCount += 1; return {}; },
      lastError: () => null
    },
    getConfig: () => liveConfig,
    credentials: { status: async () => ({ configured: false }), store: async () => {}, clear: async () => {} },
    settings: store,
    onSettingsChanged: async () => {
      liveConfig = resolveConfig({ ...liveConfig, ...store.values() });
      state.refreshCount += 1;
    }
  });

  return { routes, store, state, file };
}

await check('SS1 GET 返回解析后的真实配置，而非 schema 默认值', async () => {
  const { routes } = settingsHarness();
  const { status, body } = await invoke(routes, '/api/zhijiang/settings');
  assert.equal(status, 200);
  assert.equal(body.values.baseURL, 'https://relay.test');
  assert.equal(body.values.credentialRef, 'ZHIJIANG_API_KEY');
  assert.equal(body.values.accountCredentialRef, '');
});

await check('SS2 POST 合法配置被接受并写入文件', async () => {
  const { routes, store, state, file } = settingsHarness();
  const { status, body } = await invoke(routes, '/api/zhijiang/settings', {
    method: 'POST',
    body: JSON.stringify({ accountCredentialRef: 'ZHIJIANG_ACCESS_TOKEN', refreshSeconds: 120 })
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.values.accountCredentialRef, 'ZHIJIANG_ACCESS_TOKEN');
  assert.equal(body.values.refreshSeconds, 120);
  // The echo must be the merged config: the page replaces its whole draft with
  // it, so an untouched field like baseURL has to come back too.
  assert.equal(body.values.baseURL, 'https://relay.test');
  assert.equal(body.values.credentialRef, 'ZHIJIANG_API_KEY');
  assert.equal(store.values().accountCredentialRef, 'ZHIJIANG_ACCESS_TOKEN');
  const { readFile } = await import('node:fs/promises');
  assert.ok((await readFile(file, 'utf8')).includes('ZHIJIANG_ACCESS_TOKEN'));
  assert.equal(state.refreshCount, 1, 'a successful save triggers a refresh');
});

await check('SS3 POST 账户令牌引用名后配置立即生效', async () => {
  const { routes } = settingsHarness();
  await invoke(routes, '/api/zhijiang/settings', {
    method: 'POST',
    body: JSON.stringify({ accountCredentialRef: 'ZHIJIANG_ACCESS_TOKEN' })
  });
  const { body } = await invoke(routes, '/api/zhijiang/settings');
  assert.equal(body.values.accountCredentialRef, 'ZHIJIANG_ACCESS_TOKEN');
});

await check('SS4 非法刷新间隔返回 400 与字段级错误', async () => {
  const { routes, state } = settingsHarness();
  const { status, body } = await invoke(routes, '/api/zhijiang/settings', {
    method: 'POST',
    body: JSON.stringify({ refreshSeconds: 5 })
  });
  assert.equal(status, 400);
  assert.match(body.errors.refreshSeconds, /60/);
  assert.equal(state.refreshCount, 0, 'a rejected save must not refresh');
});

await check('SS5 非法凭据名被拒绝', async () => {
  const { routes } = settingsHarness();
  const { status, body } = await invoke(routes, '/api/zhijiang/settings', {
    method: 'POST',
    body: JSON.stringify({ accountCredentialRef: 'has space' })
  });
  assert.equal(status, 400);
  assert.ok(body.errors.accountCredentialRef);
});

await check('SS6 非法站点地址被拒绝', async () => {
  const { routes } = settingsHarness();
  const { status, body } = await invoke(routes, '/api/zhijiang/settings', {
    method: 'POST',
    body: JSON.stringify({ baseURL: 'relay.test' })
  });
  assert.equal(status, 400);
  assert.ok(body.errors.baseURL);
});

await check('SS7 转黄阈值低于转红阈值被拒绝', async () => {
  const { routes } = settingsHarness();
  const { status, body } = await invoke(routes, '/api/zhijiang/settings', {
    method: 'POST',
    body: JSON.stringify({ warningDays: 1, criticalDays: 3 })
  });
  assert.equal(status, 400);
  assert.ok(body.errors.warningDays);
});

await check('SS8 未知字段被拒绝而不是静默忽略', async () => {
  const { errors } = validatePatch({ totallyUnknown: 1 });
  assert.ok(errors.totallyUnknown);
});

await check('SS9 GET/POST 之外的方法被拒绝', async () => {
  const { routes } = settingsHarness();
  const { status } = await invoke(routes, '/api/zhijiang/settings', { method: 'DELETE' });
  assert.equal(status, 405);
});

await check('SS10 非回环对端不能改配置', async () => {
  const { routes } = settingsHarness();
  const { status } = await invoke(routes, '/api/zhijiang/settings', {
    method: 'POST',
    body: JSON.stringify({ refreshSeconds: 120 }),
    remoteAddress: '10.1.2.3'
  });
  assert.equal(status, 403);
});

await check('SS11 损坏的设置文件不会阻塞启动', async () => {
  const { writeFile } = await import('node:fs/promises');
  const file = joinPath(tmpdir(), `zj-bad-${Date.now()}.json`);
  await writeFile(file, '{ not json', 'utf8');
  const store = createSettingsStore(file);
  assert.deepEqual(store.values(), {});
});

process.stdout.write('\naccount token handling\n');

const { looksLikeSecret, validateField: validateOne } = await import('../lib/settings-store.js');

/**
 * Harness with a real in-memory credential map.
 * @returns {object} routes plus the credential map and live config.
 */
function credentialHarness() {
  const file = joinPath(tmpdir(), `zj-cred-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const store = createSettingsStore(file);
  const secrets = new Map();
  let liveConfig = resolveConfig({ baseURL: 'https://relay.test', credentialRef: 'ZHIJIANG_API_KEY' });

  const credentials = {
    status: async (ref) => ({ configured: secrets.has(ref), writable: true, source: secrets.has(ref) ? 'file' : null }),
    store: async (ref, value) => { secrets.set(ref, value); },
    clear: async (ref) => { secrets.delete(ref); }
  };

  const routes = createRoutes({
    service: { getSnapshot: async () => ({}), refresh: async () => ({}), lastError: () => null },
    getConfig: () => liveConfig,
    credentials,
    settings: store,
    onSettingsChanged: async () => { liveConfig = resolveConfig({ ...liveConfig, ...store.values() }); }
  });

  return { routes, store, secrets, config: () => liveConfig };
}

await check('T1 能识别被误填的密钥/令牌值', async () => {
  assert.equal(looksLikeSecret('nap_FAKEfixtureNotARealToken000000'), true);
  assert.equal(looksLikeSecret('sk-FAKEfixtureNotARealKey00000000'), true);
  assert.equal(looksLikeSecret('ZHIJIANG_ACCESS_TOKEN'), false);
  assert.equal(looksLikeSecret(''), false);
});

await check('T2 引用名字段拒绝粘贴的令牌（本次故障的直接原因）', async () => {
  const outcome = validateOne('accountCredentialRef', 'nap_FAKEfixtureNotARealToken000000');
  assert.ok(outcome.error, 'a pasted token must not be accepted as a name');
  assert.match(outcome.error, /名称/);
});

await check('T3 POST kind=accessToken 存入默认引用名并改写配置', async () => {
  const { routes, store, secrets, config } = credentialHarness();
  const { status, body } = await invoke(routes, '/api/zhijiang/credential', {
    method: 'POST',
    body: JSON.stringify({ kind: 'accessToken', value: 'nap_FAKEfixtureNotARealToken000000' })
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.ref, 'ZHIJIANG_ACCESS_TOKEN');
  assert.equal(secrets.get('ZHIJIANG_ACCESS_TOKEN'), 'nap_FAKEfixtureNotARealToken000000');
  // The config must now point at the ref that holds the token.
  assert.equal(store.values().accountCredentialRef, 'ZHIJIANG_ACCESS_TOKEN');
  assert.equal(config().accountCredentialRef, 'ZHIJIANG_ACCESS_TOKEN');
});

await check('T4 kind=accessToken 拒绝 sk- 密钥', async () => {
  const { routes, secrets } = credentialHarness();
  const { status, body } = await invoke(routes, '/api/zhijiang/credential', {
    method: 'POST',
    body: JSON.stringify({ kind: 'accessToken', value: 'sk-FAKEfixtureNotARealKey00000000' })
  });
  assert.equal(status, 400);
  assert.match(body.error.message, /nap_/);
  assert.equal(secrets.size, 0);
});

await check('T5 GET 同时报告密钥与令牌的存在性，且不含值', async () => {
  const { routes } = credentialHarness();
  await invoke(routes, '/api/zhijiang/credential', {
    method: 'POST',
    body: JSON.stringify({ value: 'sk-FAKEfixtureNotARealKey00000000' })
  });
  await invoke(routes, '/api/zhijiang/credential', {
    method: 'POST',
    body: JSON.stringify({ kind: 'accessToken', value: 'nap_FAKEfixtureNotARealToken000000' })
  });
  const { body } = await invoke(routes, '/api/zhijiang/credential');
  assert.equal(body.apiKey.configured, true);
  assert.equal(body.accessToken.configured, true);
  assert.ok(!JSON.stringify(body).includes('nap_FAKE'), 'response must not leak the token');
});

process.stdout.write('\nsidebar layout coexistence\n');

/**
 * Load the client bundle with a React stub that records portals.
 * @returns {Promise<{mod: object, portals: Array}>} module and recorded portals.
 */
async function loadClient() {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const portals = [];
  let definition = null;
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
    createPortal: (node, host) => {
      portals.push({ node, host });
      return node;
    }
  };
  new Function('window', `${source}\nreturn window;`)({
    __ModuleLoader__: { load: (v) => { definition = v; } }
  });
  return { mod: definition.factory((id) => (id === 'react' ? reactStub : null)), portals };
}

/**
 * Collect every style object in a rendered tree.
 * @param {object} tree - rendered element.
 * @returns {Array<object>} style objects.
 */
function collectStyles(tree) {
  const styles = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 30) return;
    if (node.props && node.props.style) styles.push(node.props.style);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(tree, 0);
  return styles;
}

await check('L1 徽标不占满整行（与用量插件共享 footer 行）', async () => {
  const { mod } = await loadClient();
  const tree = mod.ConnectorBadge({ wide: true });
  const styles = collectStyles(tree);

  // A `width: 100%` child would starve the sibling entry in the shared flex row.
  const fullWidth = styles.some((style) => style.width === '100%');
  assert.equal(fullWidth, false, 'badge must not claim 100% width');

  const root = tree.props.style;
  // `0 0 auto`: the badge must not shrink. The sibling usage entry is a
  // `width: 100%` button with the default `flex-shrink: 1`; when the badge was
  // shrinkable both competed and this one collapsed to zero width, which looked
  // exactly like a missing plugin. Opting out of shrinking lets the full-width
  // sibling absorb the deficit so both entries stay visible and clickable.
  assert.equal(root.flex, '0 0 auto');
  assert.equal(root.flexShrink, 0);
  assert.equal(root.minWidth, 0);
});

await check('L2 面板不内嵌在页脚（改用 portal 脱离 overflow 裁剪）', async () => {
  const { mod } = await loadClient();
  const closed = mod.ConnectorBadge({ wide: true });
  const closedStyles = collectStyles(closed);
  assert.equal(
    closedStyles.some((style) => style.position === 'absolute'),
    false,
    'the badge must not position a child absolutely inside the footer row'
  );
});

await check('L3 收窄态只显示状态点，不挤压相邻项', async () => {
  const { mod } = await loadClient();
  const tree = mod.ConnectorBadge({ wide: false });
  const texts = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 20) return;
    for (const child of node.children ?? []) {
      if (typeof child === 'string') texts.push(child);
      else walk(child, depth + 1);
    }
  };
  walk(tree, 0);
  assert.equal(texts.some((text) => text.includes('开物云')), false, 'collapsed badge shows no label');
});

await check('L4 徽标与用量插件使用不同的 order，排序稳定', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(source, /name: 'sidebar\.footer\.action'/);
  assert.match(source, /order: 20/);
});

process.stdout.write('\nbalance display (regression)\n');

/**
 * Collect every string rendered in a tree, expanding function components.
 * @param {object} tree - rendered element.
 * @returns {Array<string>} rendered text.
 */
function collectText(tree) {
  const texts = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 40) return;
    if (typeof node.type === 'function') {
      let rendered;
      try {
        rendered = node.type({ ...(node.props ?? {}), children: node.children });
      } catch {
        rendered = null;
      }
      walk(rendered, depth + 1);
      return;
    }
    for (const child of node.children ?? []) {
      if (typeof child === 'string') texts.push(child);
      else walk(child, depth + 1);
    }
  };
  walk(tree, 0);
  return texts;
}

/** The exact snapshot shape the live relay produced for this defect. */
const UNLIMITED_KEY_SNAPSHOT = {
  ok: true,
  source: 'token',
  site: { name: '开物云', baseURL: 'https://ai.zhijianginc.com', currency: 'CNY' },
  balance: { known: false, remaining: null, used: null, total: null, currency: 'CNY', unlimited: false, expiresAt: null },
  keyCap: { unlimited: true, granted: 0.2, available: null, currency: 'CNY', expiresAt: null },
  label: 'example-key',
  usage: { last24h: null, total: 33.6, requests: null, windowDays: null },
  forecast: { dailyAvg: null, daysLeft: null, level: 'unknown' },
  warnings: ['account-channel-not-configured']
};

await check('B1 徽标不再显示「无限额」', async () => {
  const { mod } = await loadClient();
  const text = mod.badgeText(UNLIMITED_KEY_SNAPSHOT);
  assert.equal(text.includes('无限额'), false, `badge must not claim unlimited, got: ${text}`);
  assert.ok(text.includes('已用'), `badge should fall back to spend, got: ${text}`);
});

await check('B2 面板把未知余额显示为破折号而非「无限额」', async () => {
  const { mod } = await loadClient();
  const texts = collectText(mod.Panel({
    snapshot: UNLIMITED_KEY_SNAPSHOT,
    error: null,
    busy: false,
    onRefresh: () => {},
    onClose: () => {}
  }));
  assert.equal(texts.includes('无限额'), false, 'panel must not render 无限额 anywhere');
  assert.ok(texts.includes('账户余额'), 'panel labels the wallet row as 账户余额');
  assert.ok(texts.includes('—'), 'unknown balance renders as a dash');
});

await check('B3 密钥额度单独成行，无上限如实标注', async () => {
  const { mod } = await loadClient();
  const texts = collectText(mod.Panel({
    snapshot: UNLIMITED_KEY_SNAPSHOT,
    error: null,
    busy: false,
    onRefresh: () => {},
    onClose: () => {}
  }));
  assert.ok(texts.includes('密钥额度'), 'the key ceiling gets its own row');
  assert.ok(texts.includes('无上限'), 'an uncapped key reads as 无上限');
});

await check('B4 未知余额时给出补齐访问令牌的提示', async () => {
  const { mod } = await loadClient();
  const texts = collectText(mod.Panel({
    snapshot: UNLIMITED_KEY_SNAPSHOT,
    error: null,
    busy: false,
    onRefresh: () => {},
    onClose: () => {}
  }));
  const hint = texts.join(' ');
  assert.ok(hint.includes('访问令牌'), `expected a hint about the access token, got: ${hint}`);
});

await check('B5 账户通道可用时余额正常显示', async () => {
  const { mod } = await loadClient();
  const snapshot = {
    ...UNLIMITED_KEY_SNAPSHOT,
    source: 'account',
    balance: { known: true, remaining: 16.8, used: 33.6, total: 50.4, currency: 'CNY', unlimited: false, expiresAt: null },
    keyCap: null
  };
  const text = mod.badgeText(snapshot);
  assert.ok(text.includes('16.80'), `expected the balance in the badge, got: ${text}`);
  const texts = collectText(mod.Panel({ snapshot, error: null, busy: false, onRefresh: () => {}, onClose: () => {} }));
  assert.ok(texts.includes('¥16.80'), 'panel shows the account balance');
});

process.stdout.write('\nredesign regressions\n');

await check('R1 令牌可显式指定引用名，不会覆盖已配置的槽位', async () => {
  const { routes, secrets } = credentialHarness();
  const { status, body } = await invoke(routes, '/api/zhijiang/credential', {
    method: 'POST',
    body: JSON.stringify({ kind: 'accessToken', value: 'nap_FAKEfixtureNotARealToken000000', ref: 'SITE_B_TOKEN' })
  });
  assert.equal(status, 200);
  assert.equal(body.ref, 'SITE_B_TOKEN');
  assert.equal(secrets.get('SITE_B_TOKEN'), 'nap_FAKEfixtureNotARealToken000000');
});

await check('R2 非法的显式引用名被拒绝，且不写入任何凭据', async () => {
  const { routes, secrets } = credentialHarness();
  const { status, body } = await invoke(routes, '/api/zhijiang/credential', {
    method: 'POST',
    body: JSON.stringify({ kind: 'accessToken', value: 'nap_FAKEfixtureNotARealToken000000', ref: '9bad-name' })
  });
  assert.equal(status, 400);
  assert.equal(body.error.reason, 'invalid-ref');
  assert.equal(secrets.size, 0);
});

await check('R3 未指定引用名时仍落到默认名（老行为不变）', async () => {
  const { routes, secrets } = credentialHarness();
  const { status, body } = await invoke(routes, '/api/zhijiang/credential', {
    method: 'POST',
    body: JSON.stringify({ kind: 'accessToken', value: 'nap_FAKEfixtureNotARealToken000000' })
  });
  assert.equal(status, 200);
  assert.equal(body.ref, 'ZHIJIANG_ACCESS_TOKEN');
  assert.equal(secrets.get('ZHIJIANG_ACCESS_TOKEN'), 'nap_FAKEfixtureNotARealToken000000');
});

await check('R4 清除令牌后引用名一并清理，不再残留指向空槽位的名字', async () => {
  const written = [];
  const cleared = [];
  const config = {
    baseURL: 'https://ai.zhijianginc.com',
    credentialRef: 'zhijiangApiKey',
    accountCredentialRef: 'ZHIJIANG_ACCESS_TOKEN',
    refreshSeconds: 300,
    warningDays: 3,
    criticalDays: 1,
    walletURL: 'https://ai.zhijianginc.com/console/wallet'
  };
  const routes = createRoutes({
    service: { getSnapshot: async () => ({}), refresh: async () => ({}), lastError: () => null },
    getConfig: () => config,
    credentials: {
      status: async () => ({ configured: true, writable: true, source: null }),
      store: async (ref, value) => { written.push({ ref, value }); },
      clear: async (ref) => { cleared.push(ref); }
    },
    settings: { write: () => ({ ok: true }), clear: (field) => { cleared.push('field:' + field); return { ok: true }; } },
    onSettingsChanged: async () => {}
  });

  const { status, body } = await invoke(routes, '/api/zhijiang/credential', {
    method: 'POST',
    body: JSON.stringify({ kind: 'accessToken', value: '' })
  });
  assert.equal(status, 200);
  assert.equal(body.cleared, true);
  assert.deepEqual(cleared, ['ZHIJIANG_ACCESS_TOKEN', 'field:accountCredentialRef']);
});

await check('R5 设置文件写入是原子的：中途失败不会破坏原文件', async () => {
  const { mkdtemp, writeFile, readFile } = await import('node:fs/promises');
  const dir = await mkdtemp(joinPath(tmpdir(), 'zj-store-'));
  const file = joinPath(dir, 'settings.json');
  await writeFile(file, JSON.stringify({ version: 1, values: { refreshSeconds: 120 } }), 'utf8');

  const store = createSettingsStore(file);
  assert.equal(store.values().refreshSeconds, 120);

  // A rejected patch must leave the file untouched.
  const rejected = store.write({ refreshSeconds: 5 });
  assert.equal(rejected.ok, false);
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(after.values.refreshSeconds, 120);

  // A cleared field must be gone from disk, not just from memory.
  store.clear('refreshSeconds');
  const cleared = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(!('refreshSeconds' in cleared.values), 'cleared field must not survive on disk');
});

await check('R6 凭据名校验规则只有一处，且被导出复用', async () => {
  const { CREDENTIAL_REF_PATTERN } = await import('../lib/settings-store.js');
  assert.ok(CREDENTIAL_REF_PATTERN instanceof RegExp);
  assert.ok(CREDENTIAL_REF_PATTERN.test('zhijiangApiKey'));
  assert.ok(CREDENTIAL_REF_PATTERN.test('SITE_B_TOKEN'));
  assert.ok(!CREDENTIAL_REF_PATTERN.test('9leading'));
  assert.ok(!CREDENTIAL_REF_PATTERN.test('has-dash'));
});

await check('R7 密钥格式错误信息为中文，与令牌报错风格一致', async () => {
  const { routes } = harness();
  const { status, body } = await invoke(routes, '/api/zhijiang/credential', {
    method: 'POST',
    body: JSON.stringify({ value: 'not-a-key' })
  });
  assert.equal(status, 400);
  assert.ok(/sk-/.test(body.error.message), 'message must mention the sk- prefix');
  assert.ok(/[\u4e00-\u9fa5]/.test(body.error.message), `expected Chinese text, got: ${body.error.message}`);
});

process.stdout.write(`\n${'='.repeat(52)}\n`);
process.stdout.write(`PASSED: ${passed}   FAILED: ${failures.length}\n`);
if (failures.length > 0) {
  process.stdout.write('\n失败详情:\n');
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error.message}\n`);
  process.exitCode = 1;
}
