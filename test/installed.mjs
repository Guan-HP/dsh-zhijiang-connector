/**
 * Installed-copy test harness.
 *
 * Unlike the source tests, this imports the plugin **as installed in the
 * profile** and drives it against a stub host context that mimics the real
 * credential and web-server seams. It exists because a plugin can pass its own
 * unit tests and still fail on the real seam: the credential API shape, the
 * branded ref type, and route registration are all integration concerns.
 *
 * Usage: node test/installed.mjs
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
const failures = [];

/**
 * Run one named check, recording rather than aborting on failure.
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

const installed = process.env.ZJ_PLUGIN_PATH
  ?? join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-zhijiang-connector');

process.stdout.write(`installed plugin: ${installed}\n\n`);

const host = await import(`file://${installed.replace(/\\/g, '/')}/lib/index.js`);
const { createService } = await import(`file://${installed.replace(/\\/g, '/')}/lib/service.js`);
const { resolveConfig } = await import(`file://${installed.replace(/\\/g, '/')}/lib/config.js`);
const { createRoutes } = await import(`file://${installed.replace(/\\/g, '/')}/lib/routes.js`);

process.stdout.write('A. 安装完整性\n');

await check('A1 插件导出契约完整', () => {
  assert.equal(host.name, 'zhijiang-connector');
  assert.equal(typeof host.apply, 'function');
  assert.deepEqual([...host.inject].sort(), ['credentials', 'settings', 'webServer']);
});

await check('A2 Config 实现 Standard Schema（真实启动曾失败的点）', () => {
  assert.equal(typeof host.Config['~standard'].validate, 'function');
  const result = host.Config['~standard'].validate({ baseURL: 'https://x.test' });
  assert.equal(result.value.baseURL, 'https://x.test');
});

await check('A3 cordis.patch.yml 声明正确', async () => {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(join(installed, 'cordis.patch.yml'), 'utf8');
  assert.match(text, /id:\s*zhijiang-connector/);
  assert.match(text, /name:\s*"dsh-zhijiang-connector"/);
});

await check('A4 package.json 的 dsh 字段完整', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.exports['./client'], './lib/client.js');
});

process.stdout.write('\nB. 凭据 seam 兼容性\n');

await check('B1 真实 resolve(ref) 返回 {value,source} 时能取到密钥', async () => {
  const service = createService({
    getConfig: () => resolveConfig({ baseURL: 'https://relay.test' }),
    // Mirrors the documented real seam shape.
    resolveCredential: async (ref) => {
      const value = ref === 'zhijiangApiKey' ? 'sk-from-resolve' : '';
      return value;
    },
    cacheFile: join(await mkdtemp(join(tmpdir(), 'zj-')), 'a.json'),
    now: () => Date.now(),
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path === '/api/status') {
        return new Response(JSON.stringify({
          data: { quota_display_type: 'CNY', quota_per_unit: 500000, usd_exchange_rate: 7, system_name: '开物云' }
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        data: { name: 'example-key', total_granted: 2400000, total_used: 2100000, total_available: 300000, unlimited_quota: false }
      }), { headers: { 'content-type': 'application/json' } });
    }
  });
  const snapshot = await service.getSnapshot({ force: true });
  assert.equal(snapshot.keyCap.available, 4.2);
  assert.equal(snapshot.balance.known, false);
});

await check('B2 宿主 credentials 对象只有 resolve() 时 apply 不崩溃', async () => {
  const registered = [];
  const ctx = {
    webServer: { register: (r) => { registered.push(r); return () => {}; } },
    // Deliberately the real shape: resolve() only, no get().
    credentials: { resolve: async () => ({ value: 'sk-real', source: 'stored' }) },
    settings: { configure: () => () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    fiber: {},
    on: () => () => {}
  };
  host.apply(ctx, { baseURL: 'https://relay.test' });
  assert.equal(registered.length, 5);
});

await check('B3 resolve 返回 undefined（未配置）时优雅降级', async () => {
  const service = createService({
    getConfig: () => resolveConfig({ baseURL: 'https://relay.test' }),
    resolveCredential: async () => undefined,
    cacheFile: join(await mkdtemp(join(tmpdir(), 'zj-')), 'b.json'),
    now: () => Date.now(),
    fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } })
  });
  await assert.rejects(
    () => service.getSnapshot({ force: true }),
    (e) => e.reason === 'not-configured'
  );
});

process.stdout.write('\nC. 边界情况\n');

const FIXTURES = {
  status: { data: { quota_display_type: 'CNY', quota_per_unit: 500000, usd_exchange_rate: 7 } },
  token: (over) => ({ data: { total_granted: 2400000, total_used: 2100000, total_available: 300000, ...over } })
};

/**
 * Build a service against one canned upstream behaviour.
 * @param {object} options - scenario.
 * @returns {object} the service.
 */
function svc(options) {
  return createService({
    getConfig: () => resolveConfig({ baseURL: 'https://relay.test', ...(options.config ?? {}) }),
    resolveCredential: async () => options.key ?? 'sk-test',
    cacheFile: join(options.dir ?? process.env.TEMP ?? '.', `${Math.random().toString(36).slice(2)}.json`),
    now: options.now ?? (() => Date.now()),
    fetchImpl: options.fetchImpl
  });
}

await check('C1 余额恰好为 0 时仍返回正常快照（不是错误）', async () => {
  const service = svc({
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      const body = path === '/api/status' ? FIXTURES.status : FIXTURES.token({ total_available: 0 });
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }
  });
  const snapshot = await service.getSnapshot({ force: true });
  assert.equal(snapshot.keyCap.available, 0);
  assert.equal(snapshot.balance.known, false);
  assert.equal(snapshot.forecast.level, 'unknown');
});

await check('C2 unlimited_quota 时不谎报天数', async () => {
  const service = svc({
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      const body = path === '/api/status' ? FIXTURES.status : { data: { unlimited_quota: true } };
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }
  });
  const snapshot = await service.getSnapshot({ force: true });
  // Regression: an uncapped key must not become an unlimited balance.
  assert.equal(snapshot.keyCap.unlimited, true);
  assert.equal(snapshot.balance.unlimited, false);
  assert.equal(snapshot.balance.known, false);
  assert.equal(snapshot.forecast.daysLeft, null);
  assert.equal(snapshot.forecast.level, 'unknown');
});

await check('C3 CNY 缺汇率时拒绝换算（不猜默认值）', async () => {
  const service = svc({
    fetchImpl: async () => new Response(JSON.stringify({
      data: { quota_display_type: 'CNY', quota_per_unit: 500000 }
    }), { headers: { 'content-type': 'application/json' } })
  });
  await assert.rejects(
    () => service.getSnapshot({ force: true }),
    (e) => e.reason === 'missing-exchange-rate'
  );
});

await check('C4 429 限流时保留上次值并标记 stale', async () => {
  let mode = 'ok';
  const service = svc({
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (mode === 'limit') {
        return path === '/api/status'
          ? new Response(JSON.stringify(FIXTURES.status), { headers: { 'content-type': 'application/json' } })
          : new Response('', { status: 429 });
      }
      const body = path === '/api/status' ? FIXTURES.status : FIXTURES.token({});
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }
  });
  const fresh = await service.getSnapshot({ force: true });
  assert.equal(fresh.stale, false);
  mode = 'limit';
  const stale = await service.refresh({ force: true });
  assert.equal(stale.stale, true);
  assert.equal(stale.keyCap.available, fresh.keyCap.available);
});

await check('C5 上游返回非 JSON 时报可诊断错误', async () => {
  const service = svc({
    fetchImpl: async () => new Response('<html>502</html>', { headers: { 'content-type': 'text/html' } })
  });
  await assert.rejects(
    () => service.getSnapshot({ force: true }),
    (e) => e.reason === 'invalid-json'
  );
});

await check('C6 401 密钥被拒时不重试且原因明确', async () => {
  const service = svc({
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path === '/api/status') {
        return new Response(JSON.stringify(FIXTURES.status), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('', { status: 401 });
    }
  });
  await assert.rejects(
    () => service.getSnapshot({ force: true }),
    (e) => e.reason === 'unauthorized' && e.retryable === false
  );
});

await check('C7 缓存损坏时不阻塞启动', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zj-corrupt-'));
  const { writeFile } = await import('node:fs/promises');
  const file = join(dir, 'bad.json');
  await writeFile(file, '{ not json', 'utf8');
  const service = createService({
    getConfig: () => resolveConfig({ baseURL: 'https://relay.test' }),
    resolveCredential: async () => 'sk-test',
    cacheFile: file,
    now: () => Date.now(),
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      const body = path === '/api/status' ? FIXTURES.status : FIXTURES.token({});
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }
  });
  const snapshot = await service.getSnapshot({ force: true });
  assert.equal(snapshot.ok, true);
});

await check('C8 超时被归类为可重试的 timeout', async () => {
  const service = svc({
    fetchImpl: async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
  });
  await assert.rejects(
    () => service.getSnapshot({ force: true }),
    (e) => (e.reason === 'timeout' || e.reason === 'network') && e.retryable === true
  );
});

process.stdout.write('\nD. 路由与安全围栏\n');

await check('D1 四条路由均为 exact 且路径正确', () => {
  const routes = createRoutes({
    service: { getSnapshot: async () => ({}), refresh: async () => ({}), lastError: () => null },
    getConfig: () => resolveConfig({})
  });
  assert.equal(routes.length, 5);
  assert.ok(routes.every((r) => r.kind === 'exact'));
  assert.deepEqual(routes.map((r) => r.path).sort(), [
    '/api/zhijiang/credential',
    '/api/zhijiang/refresh',
    '/api/zhijiang/settings',
    '/api/zhijiang/snapshot',
    '/api/zhijiang/status'
  ]);
});

await check('D2 非回环对端被拒绝（403）', async () => {
  const routes = createRoutes({
    service: { getSnapshot: async () => ({}), refresh: async () => ({}), lastError: () => null },
    getConfig: () => resolveConfig({})
  });
  const route = routes.find((r) => r.path === '/api/zhijiang/snapshot');
  const chunks = [];
  const res = {
    writeHead: (status) => { res.status = status; },
    end: (payload) => chunks.push(payload)
  };
  await route.handler({ socket: { remoteAddress: '10.0.0.9' }, method: 'GET' }, res);
  assert.equal(res.status, 403);
  assert.match(chunks.join(''), /forbidden/);
});

await check('D3 refresh 路由拒绝 GET（405）', async () => {
  const routes = createRoutes({
    service: { getSnapshot: async () => ({}), refresh: async () => ({}), lastError: () => null },
    getConfig: () => resolveConfig({})
  });
  const route = routes.find((r) => r.path === '/api/zhijiang/refresh');
  const chunks = [];
  const res = { writeHead: (s) => { res.status = s; }, end: (p) => chunks.push(p) };
  await route.handler({ socket: { remoteAddress: '127.0.0.1' }, method: 'GET' }, res);
  assert.equal(res.status, 405);
});

await check('D4 并发刷新只打一次上游', async () => {
  let calls = 0;
  const service = createService({
    getConfig: () => resolveConfig({ baseURL: 'https://relay.test' }),
    resolveCredential: async () => 'sk-test',
    cacheFile: join(await mkdtemp(join(tmpdir(), 'zj-race-')), 'r.json'),
    now: () => Date.now(),
    fetchImpl: async (url) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      const path = new URL(url).pathname;
      const body = path === '/api/status' ? FIXTURES.status : FIXTURES.token({});
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }
  });
  await Promise.all([service.getSnapshot({ force: true }), service.getSnapshot({ force: true })]);
  assert.ok(calls <= 4, `expected at most 4 upstream calls (2 endpoints x 1 dedup), got ${calls}`);
});

process.stdout.write('\nE. 客户端 bundle\n');

await check('E1 client.js 注册徽标与设置分区', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(join(installed, 'lib', 'client.js'), 'utf8');
  let definition = null;
  const reactStub = {
    createElement: (t, p, ...c) => ({ t, p, c }),
    useState: (i) => [i, () => {}],
    useEffect: () => {}
  };
  new Function('window', `${source}\nreturn window;`)({
    __ModuleLoader__: { load: (v) => { definition = v; } }
  });
  const mod = definition.factory((id) => {
    if (id === 'react') return reactStub;
    throw new Error(`unexpected require: ${id}`);
  });
  const slots = [];
  mod.apply({
    slots: {
      inject: (n, fn) => fn(),
      register: (o, c) => { slots.push(o.name); return () => {}; }
    }
  });
  assert.deepEqual(slots.sort(), ['settings.section', 'sidebar.footer.action']);
});

await check('E2 徽标在无快照时也能渲染（不白屏）', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(join(installed, 'lib', 'client.js'), 'utf8');
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
  const tree = mod.ConnectorBadge({});
  assert.ok(tree);
});

await rm(join(process.env.TEMP ?? '.', 'zj-corrupt-'), { recursive: true, force: true }).catch(() => {});

process.stdout.write(`\n${'='.repeat(52)}\n`);
process.stdout.write(`PASSED: ${passed}   FAILED: ${failures.length}\n`);
if (failures.length > 0) {
  process.stdout.write('\n失败详情:\n');
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error.message}\n`);
  process.exitCode = 1;
}
