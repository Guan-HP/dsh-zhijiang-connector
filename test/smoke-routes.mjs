/**
 * Route smoke test: real HTTP against a minimal server, no harness needed.
 *
 * Verifies the three routes, the method guard, the loopback fence, and that a
 * configuration failure surfaces as a specific status rather than a 500.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { HEALTH_PATH, REFRESH_PATH, SNAPSHOT_PATH, createRoutes, isLoopback } from '../lib/routes.js';
import { createService } from '../lib/service.js';

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

const STATUS_BODY = {
  data: { quota_display_type: 'CNY', quota_per_unit: 500000, usd_exchange_rate: 7, system_name: '开物云' },
  success: true
};
const TOKEN_BODY = {
  code: true,
  data: { name: 'example-key', total_granted: 2400000, total_used: 2100000, total_available: 300000, unlimited_quota: false }
};

/**
 * Start a server mounting the plugin's routes.
 * @param {object} options - service wiring.
 * @returns {Promise<{base: string, close: () => Promise<void>}>} the running server.
 */
async function startServer(options) {
  const service = createService(options);
  const routes = createRoutes({ service, getConfig: options.getConfig });
  const server = createServer((req, res) => {
    const match = routes.find((route) => route.path === req.url.split('?')[0]);
    if (!match) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"ok":false}');
      return;
    }
    void match.handler(req, res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/**
 * Fetch a route and return status plus parsed body.
 * @param {string} url - absolute URL.
 * @param {RequestInit} [init] - request options.
 * @returns {Promise<{status: number, body: any}>} the response.
 */
async function call(url, init) {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

const root = await mkdtemp(join(tmpdir(), 'zhijiang-routes-'));

process.stdout.write('routes\n');

const wired = {
  getConfig: () => resolveConfig({ baseURL: 'https://relay.test' }),
  resolveCredential: async () => 'sk-test',
  cacheFile: join(root, 'ok.json'),
  fetchImpl: async (url) => {
    const path = new URL(url).pathname;
    const body = path === '/api/status' ? STATUS_BODY : TOKEN_BODY;
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }
};

const server = await startServer(wired);

await test('serves a snapshot over HTTP', async () => {
  const { status, body } = await call(`${server.base}${SNAPSHOT_PATH}`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.balance.known, false);
  assert.equal(body.balance.unlimited, false);
  assert.equal(body.keyCap.available, 4.2);
  assert.equal(body.forecast.level, 'unknown');
});

await test('rejects GET on the refresh route', async () => {
  const { status, body } = await call(`${server.base}${REFRESH_PATH}`);
  assert.equal(status, 405);
  assert.equal(body.error.reason, 'method-not-allowed');
});

await test('accepts POST on the refresh route', async () => {
  const { status, body } = await call(`${server.base}${REFRESH_PATH}`, { method: 'POST' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

await test('reports health with the configured site', async () => {
  const { status, body } = await call(`${server.base}${HEALTH_PATH}`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.baseURL, 'https://relay.test');
});

await test('answers 404 for an unknown path', async () => {
  const { status } = await call(`${server.base}/api/zhijiang/nope`);
  assert.equal(status, 404);
});

await server.close();

await test('maps an unconfigured credential to 409', async () => {
  const unconfigured = await startServer({
    ...wired,
    resolveCredential: async () => '',
    cacheFile: join(root, 'empty.json')
  });
  const { status, body } = await call(`${unconfigured.base}${SNAPSHOT_PATH}`);
  assert.equal(status, 409);
  assert.equal(body.error.reason, 'not-configured');
  await unconfigured.close();
});

await test('maps a rejected credential to 401', async () => {
  const rejected = await startServer({
    ...wired,
    cacheFile: join(root, 'rejected.json'),
    fetchImpl: async (url) => {
      if (new URL(url).pathname === '/api/status') {
        return new Response(JSON.stringify(STATUS_BODY), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('', { status: 401 });
    }
  });
  const { status, body } = await call(`${rejected.base}${SNAPSHOT_PATH}`);
  assert.equal(status, 401);
  assert.equal(body.error.reason, 'unauthorized');
  await rejected.close();
});

await test('treats loopback peers as local and others as remote', () => {
  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '::1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '192.168.1.5' } }), false);
  assert.equal(isLoopback({ socket: {} }), true);
});

await rm(root, { recursive: true, force: true });

process.stdout.write(`routes: ${passed} passed\n`);
