/**
 * Mount test: load both halves the way the harness does.
 *
 * The host half is imported and `apply` is called against a stub context, then
 * the registered routes are exercised. The browser half is evaluated inside a
 * fake `__ModuleLoader__` with a minimal `react`, which proves the bundle parses,
 * exports the two required symbols, and registers the expected slots.
 *
 * This is the closest check available without a booted harness: it catches the
 * failure modes that actually happen in practice — a missing export, a slot name
 * typo, a route that never registers.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

const root = await mkdtemp(join(tmpdir(), 'zhijiang-mount-'));
// Keep the plugin's cache out of the real home directory during the test.
process.env.DSH_HOME = root;

process.stdout.write('mount\n');

const hostURL = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'index.js')).href;
const host = await import(hostURL);

await test('host half exports the plugin contract', () => {
  assert.equal(typeof host.apply, 'function');
  assert.equal(typeof host.name, 'string');
  assert.equal(host.name, 'zhijiang-connector');
  assert.ok(Array.isArray(host.inject));
  assert.deepEqual([...host.inject].sort(), ['credentials', 'settings', 'webServer']);
  assert.ok(host.Config, 'Config schema must be exported');
  assert.equal(typeof host.Config.toJSON, 'function');
});

await test('host half registers every route through webServer', () => {
  const registered = [];
  const ctx = {
    webServer: {
      register: (route) => {
        registered.push(route);
        return () => {};
      }
    },
    credentials: { get: async () => '' },
    settings: { configure: () => () => {} },
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    fiber: {},
    on: () => () => {}
  };

  host.apply(ctx, { baseURL: 'https://relay.test' });

  const paths = registered.map((route) => route.path).sort();
  assert.deepEqual(paths, [
    '/api/zhijiang/credential',
    '/api/zhijiang/refresh',
    '/api/zhijiang/settings',
    '/api/zhijiang/snapshot',
    '/api/zhijiang/status'
  ]);
  assert.ok(registered.every((route) => route.kind === 'exact'), 'every route must be exact');
  assert.ok(registered.every((route) => typeof route.handler === 'function'));
});

await test('a duplicate route degrades one endpoint instead of failing activation', () => {
  // The harness treats a throw from `apply` as a failed entry, and a failed
  // entry aborts the whole desktop boot ("web boot: N entries did not
  // activate"). A duplicate (kind, path) is the realistic trigger: a live
  // profile reload can re-run `apply` before the previous fiber's disposers
  // have released the route. Registration must therefore swallow it.
  const seen = new Set();
  const registered = [];
  const warnings = [];

  const ctx = {
    webServer: {
      register: (route) => {
        if (seen.has(route.path)) {
          throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
        }
        seen.add(route.path);
        registered.push(route);
        return () => seen.delete(route.path);
      }
    },
    credentials: { get: async () => '' },
    settings: { configure: () => () => {} },
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    fiber: {},
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    on: () => () => {}
  };

  assert.doesNotThrow(() => host.apply(ctx, {}), 'apply must never throw on a duplicate route');
  assert.equal(registered.length, 5, 'the first pass still registers every route');
  assert.equal(warnings.length, 0, 'a clean first mount reports nothing');

  // Second mount over the same webServer: every route now collides.
  assert.doesNotThrow(() => host.apply(ctx, {}), 'a remount must not throw either');
  assert.equal(registered.length, 5, 'the remount adds nothing');
  assert.equal(warnings.length, 5, 'each duplicate is reported once');
  assert.ok(warnings.every((line) => line.includes('not registered')), 'the report names the failure');
});

await test('a settings registration failure does not fail activation', () => {
  const ctx = {
    webServer: { register: () => () => {} },
    credentials: { get: async () => '' },
    settings: {
      configure: () => {
        throw new Error('Settings presentation is already configured for this plugin instance');
      }
    },
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    fiber: {},
    logger: { warn: () => {} },
    on: () => () => {}
  };

  assert.doesNotThrow(() => host.apply(ctx, {}));
});

await test('the Config schema describes every field the service reads', () => {
  const described = host.Config.toJSON();
  assert.equal(described.type, 'object');
  const fields = Object.keys(described.dict);
  for (const field of [
    'baseURL', 'credentialRef', 'accountCredentialRef', 'accountUserId',
    'refreshSeconds', 'warningDays', 'criticalDays', 'showBadge', 'walletURL'
  ]) {
    assert.ok(fields.includes(field), `missing config field: ${field}`);
  }
  assert.equal(described.dict.baseURL.meta.volatile, true);
  assert.equal(described.dict.baseURL.meta.default, 'https://ai.zhijianginc.com');
});

await test('the Config schema implements the Standard Schema interface', () => {
  // The Cordis runtime validates a plugin through Config['~standard'].validate
  // and throws a TypeError when it is missing. This is the exact defect a real
  // boot surfaced, so it gets a permanent regression test.
  const standard = host.Config['~standard'];
  assert.ok(standard, 'Config must expose ~standard');
  assert.equal(standard.version, 1);

  const result = standard.validate({ baseURL: 'https://x.test', refreshSeconds: '120' });
  assert.equal(typeof result, 'object');
  assert.ok('value' in result, 'validation must return { value }');
  assert.equal(result.issues, undefined, 'validation must not report issues');
  assert.equal(result.value.baseURL, 'https://x.test');
  assert.equal(result.value.refreshSeconds, 120);

  // An absent or malformed config still validates; defaults apply downstream.
  assert.deepEqual(standard.validate(undefined).value, {});
  assert.deepEqual(standard.validate('nonsense').value, {});
});

await test('the Config schema round-trips and rejects wrong types', () => {
  const parsed = host.Config({ baseURL: 'https://x.test', refreshSeconds: '120', showBadge: true });
  assert.equal(parsed.baseURL, 'https://x.test');
  assert.equal(parsed.refreshSeconds, 120);
  assert.equal(host.Config({ refreshSeconds: 'abc' }).refreshSeconds, undefined);
  assert.equal(host.Config({ baseURL: 42 }).baseURL, undefined);
});

await test('client bundle loads, exports apply/inject, and registers both slots', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');

  const loaded = [];
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value })
  };

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (definition) => loaded.push(definition)
      }
    }
  };

  const factory = new Function('window', `${source}\nreturn window;`);
  factory(sandbox.window);

  assert.equal(loaded.length, 1, 'bundle must call __ModuleLoader__.load exactly once');
  assert.equal(loaded[0].id, 'dsh-zhijiang-connector');

  const clientModule = loaded[0].factory((id) => {
    if (id === 'react') return reactStub;
    throw new Error(`unexpected require: ${id}`);
  });

  assert.equal(typeof clientModule.apply, 'function');
  assert.ok(Array.isArray(clientModule.inject));
  // `locale` is a hard requirement, not an optional nicety: the Cordis context
  // proxy throws on any undeclared service read, and that throw inside `apply`
  // is what the harness reports as a failed client entry.
  assert.deepEqual([...clientModule.inject].sort(), ['locale', 'slots']);
  assert.equal(typeof clientModule.ConnectorBadge, 'function');
  assert.equal(typeof clientModule.SettingsSection, 'function');

  const slots = [];
  const ctx = {
    slots: {
      inject: (name, fn) => fn(),
      register: (options, component) => {
        slots.push({ options, component });
        return () => {};
      }
    }
  };

  clientModule.apply(ctx);

  const names = slots.map((slot) => slot.options.name);
  assert.ok(names.includes('sidebar.footer.action'), 'must register the sidebar badge');
  assert.ok(names.includes('settings.section'), 'must register the settings section');
  assert.ok(slots.every((slot) => typeof slot.component === 'function'));
});

await test('client badge renders without a snapshot and without throwing', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');

  let definition = null;
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    createPortal: (node) => node
  };
  const factory = new Function('window', `${source}\nreturn window;`);
  factory({ __ModuleLoader__: { load: (value) => { definition = value; } } });

  const clientModule = definition.factory((id) => {
    if (id === 'react') return reactStub;
    throw new Error(`unexpected require: ${id}`);
  });

  // Rendering is just calling the component; the stub hooks return their
  // initial state, which is exactly the "nothing loaded yet" branch.
  const tree = clientModule.ConnectorBadge({});
  assert.ok(tree, 'badge must render a tree');
  assert.equal(tree.type, 'div');
});

await rm(root, { recursive: true, force: true });

process.stdout.write(`mount: ${passed} passed\n`);
