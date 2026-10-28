/**
 * Probe the account channel with a dashboard access token.
 *
 * Reads the token from `ZJ_PAT` so it never lands in a file or the output.
 * Tries the header variants New API builds disagree about, and prints only
 * status codes and derived quota figures.
 *
 * Usage: $env:ZJ_PAT='nap_...'; node scripts/probe-account.mjs
 */

const token = process.env.ZJ_PAT ?? '';
if (token === '') {
  process.stdout.write('skip: ZJ_PAT not set\n');
  process.exit(0);
}

const base = 'https://ai.zhijianginc.com';

/**
 * GET a path with the given headers.
 * @param {string} path - API path.
 * @param {Record<string,string>} headers - extra headers.
 * @returns {Promise<{status: number, body: any}>} response.
 */
async function get(path, headers) {
  const response = await fetch(`${base}${path}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...headers }
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

process.stdout.write('== /api/user/self without new-api-user ==\n');
const bare = await get('/api/user/self', {});
process.stdout.write(`  status  : ${bare.status}\n`);
process.stdout.write(`  success : ${bare.body?.success}\n`);
process.stdout.write(`  message : ${bare.body?.message ?? '-'}\n`);

if (bare.status === 200 && bare.body?.data) {
  const d = bare.body.data;
  process.stdout.write(`  id      : ${d.id}\n`);
  process.stdout.write(`  username: ${d.username}\n`);
  process.stdout.write(`  quota   : ${d.quota}\n`);
  process.stdout.write(`  used    : ${d.used_quota}\n`);
  process.stdout.write(`  group   : ${d.group}\n`);
} else {
  // New API often demands the numeric user id in a header for /api routes.
  process.stdout.write('\n== retry with new-api-user: 1 .. 3 ==\n');
  for (const id of [1, 2, 3]) {
    const attempt = await get('/api/user/self', { 'new-api-user': String(id) });
    process.stdout.write(`  id=${id} -> ${attempt.status} ${attempt.body?.message ?? ''}\n`);
    if (attempt.status === 200 && attempt.body?.data) {
      const d = attempt.body.data;
      process.stdout.write(`    username: ${d.username}\n`);
      process.stdout.write(`    quota   : ${d.quota}\n`);
      process.stdout.write(`    used    : ${d.used_quota}\n`);
      process.stdout.write(`    group   : ${d.group}\n`);
      break;
    }
  }
}

process.stdout.write('\n== /api/status conversion factors ==\n');
const status = await get('/api/status', {});
const qpu = Number(status.body?.data?.quota_per_unit);
const rate = Number(status.body?.data?.usd_exchange_rate);
process.stdout.write(`  quota_per_unit : ${qpu}\n`);
process.stdout.write(`  exchange_rate  : ${rate}\n`);
