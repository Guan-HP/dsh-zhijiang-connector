/**
 * Small durable cache for the last good snapshot and the spend history.
 *
 * Two things are persisted, for two different reasons:
 *
 *  - the **last snapshot**, so a relay outage shows the user their most recent
 *    known balance (clearly marked stale) instead of an empty panel;
 *  - the **spend samples**, because a runway needs a burn rate, and a burn rate
 *    needs history that outlives one process.
 *
 * Writes are atomic (temp file + rename) and reads tolerate every kind of
 * damage: a corrupt cache must never stop the plugin from starting.
 *
 * @module dsh-zhijiang-connector/cache
 */

import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Bumped when the on-disk shape changes incompatibly.
 *
 * v2: the snapshot gained `balance.known` and `keyCap`, and `balance.unlimited`
 * stopped meaning "the key has no cap". A v1 cache would keep serving the old,
 * wrong shape ("无限额") until it aged out, so it is discarded on upgrade.
 */
export const CACHE_VERSION = 2;

/** How many spend samples to keep; one per refresh, bounded. */
export const MAX_SAMPLES = 500;

/**
 * Resolve the harness home directory the same way the host does.
 *
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string} absolute `$DSH_HOME` path.
 */
export function resolveDshHome(env = process.env) {
  const explicit = env.DSH_HOME;
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
  const home = env.USERPROFILE || env.HOME || '';
  return join(home, '.dsh');
}

/**
 * Build the cache file path for one storage root.
 *
 * @param {string} dshHome - resolved `$DSH_HOME`.
 * @returns {string} absolute cache path.
 */
export function cachePath(dshHome) {
  return join(dshHome, 'storages', 'zhijiang-connector.json');
}

/**
 * Read the cache, returning an empty shell for any failure.
 *
 * @param {string} file - absolute cache path.
 * @returns {Promise<{snapshot: object | null, samples: Array<object>}>} cache contents.
 */
export async function readCache(file) {
  try {
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed?.version !== CACHE_VERSION) return { snapshot: null, samples: [] };
    return {
      snapshot: parsed.snapshot && typeof parsed.snapshot === 'object' ? parsed.snapshot : null,
      samples: Array.isArray(parsed.samples) ? parsed.samples : []
    };
  } catch {
    return { snapshot: null, samples: [] };
  }
}

/**
 * Write the cache atomically.
 *
 * A failure is swallowed: the plugin works from memory, and a read-only home
 * directory is not a reason to break the panel.
 *
 * @param {string} file - absolute cache path.
 * @param {{snapshot: object | null, samples: Array<object>}} contents - data to store.
 * @returns {Promise<boolean>} whether the write succeeded.
 */
export async function writeCache(file, contents) {
  const payload = JSON.stringify({
    version: CACHE_VERSION,
    snapshot: contents.snapshot ?? null,
    samples: Array.isArray(contents.samples) ? contents.samples.slice(-MAX_SAMPLES) : []
  });

  const temp = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(temp, payload, 'utf8');
    await rename(temp, file);
    return true;
  } catch {
    try {
      await unlink(temp);
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    return false;
  }
}

/**
 * Append a spend sample, keeping the list bounded.
 *
 * @param {Array<object>} samples - existing samples, oldest first.
 * @param {{at: string, remaining: number | null, used: number | null}} sample - new sample.
 * @returns {Array<object>} the bounded list.
 */
export function appendSample(samples, sample) {
  const next = Array.isArray(samples) ? samples.slice() : [];
  next.push(sample);
  return next.length > MAX_SAMPLES ? next.slice(-MAX_SAMPLES) : next;
}

/**
 * Compute spend over a trailing window from the sample history.
 *
 * The figure is a delta of `used` across the window rather than a sum of
 * per-refresh increments, so missed refreshes and duplicate samples both wash
 * out. Returns null until the history actually spans the window, which is what
 * keeps the runway honest on a fresh install.
 *
 * @param {Array<{at: string, used: number | null}>} samples - oldest first.
 * @param {number} windowDays - trailing window length.
 * @param {number} nowMs - current epoch milliseconds.
 * @returns {{spent: number | null, windowDays: number} | null} spend, or null.
 */
export function spendOverWindow(samples, windowDays, nowMs) {
  if (!Array.isArray(samples) || samples.length === 0) return null;

  const windowMs = windowDays * 86400000;
  const cutoff = nowMs - windowMs;

  const usable = samples
    .map((sample) => ({ at: Date.parse(sample.at), used: sample.used }))
    .filter((sample) => Number.isFinite(sample.at) && typeof sample.used === 'number' && Number.isFinite(sample.used));

  if (usable.length < 2) return null;

  const oldest = usable[0];
  const newest = usable[usable.length - 1];
  const spanned = newest.at - oldest.at;

  // Not enough history to speak for the whole window yet.
  if (oldest.at > cutoff || spanned <= 0) return null;

  const spent = newest.used - oldest.used;
  // A counter reset (key replaced, quota topped up) is not negative spend.
  if (spent < 0) return null;

  return { spent, windowDays: spanned / 86400000 };
}
