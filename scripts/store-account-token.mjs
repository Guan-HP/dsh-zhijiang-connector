/**
 * Store the dashboard access token in the harness credential store.
 *
 * Reads the secret from `ZJ_PAT` so it is never passed on a command line, never
 * echoed, and never written to a script. The credentials file is a small YAML
 * document whose `refs` block is a flow mapping; this inserts one line into it
 * after taking a backup, and is idempotent (an existing ref is replaced).
 *
 * Usage: $env:ZJ_PAT='nap_...'; node scripts/store-account-token.mjs <REF_NAME>
 */

import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const refName = process.argv[2] ?? 'ZHIJIANG_ACCESS_TOKEN';
const token = process.env.ZJ_PAT ?? '';

if (token === '') {
  process.stdout.write('skip: ZJ_PAT not set\n');
  process.exit(0);
}
if (!/^nap_[A-Za-z0-9_-]+$/.test(token)) {
  process.stdout.write('refused: the value does not look like a New API access token (nap_...)\n');
  process.exit(1);
}
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(refName)) {
  process.stdout.write(`refused: "${refName}" is not a valid credential reference name\n`);
  process.exit(1);
}

const file = join(homedir(), '.dsh', '.credentials.yaml');
const original = await readFile(file, 'utf8');
const backup = `${file}.bak-${Date.now()}`;
await copyFile(file, backup);

const lines = original.split(/\r?\n/);

// Locate the `refs:` block and its opening brace.
const refsAt = lines.findIndex((line) => /^refs:\s*$/.test(line));
if (refsAt < 0) {
  process.stdout.write('refused: no top-level "refs:" block found; not touching the file\n');
  process.exit(1);
}
let openAt = -1;
for (let i = refsAt + 1; i < lines.length; i += 1) {
  if (/^\s*\{\s*$/.test(lines[i])) {
    openAt = i;
    break;
  }
  if (/^[A-Za-z_]/.test(lines[i])) break;
}
if (openAt < 0) {
  process.stdout.write('refused: the "refs:" block is not in the expected form; not touching the file\n');
  process.exit(1);
}

// Drop any previous line for this ref so re-running replaces it.
const kept = lines.filter((line) => !new RegExp(`^\\s*${refName}\\s*:`).test(line));
const reopenAt = kept.findIndex((line) => /^refs:\s*$/.test(line)) + 1;
let braceAt = -1;
for (let i = reopenAt; i < kept.length; i += 1) {
  if (/^\s*\{\s*$/.test(kept[i])) {
    braceAt = i;
    break;
  }
}
if (braceAt < 0) {
  process.stdout.write('refused: lost the refs brace while rewriting; aborting\n');
  process.exit(1);
}

kept.splice(braceAt + 1, 0, `    ${refName}: ${token},`);

await writeFile(file, kept.join('\n'), 'utf8');

// Verify without revealing the secret.
const check = await readFile(file, 'utf8');
const present = new RegExp(`^\\s*${refName}\\s*:\\s*nap_`, 'm').test(check);
process.stdout.write(`backup   : ${backup}\n`);
process.stdout.write(`ref      : ${refName}\n`);
process.stdout.write(`stored   : ${present}\n`);
process.stdout.write(`file ok  : ${check.includes('version: 1') && check.includes('records:')}\n`);
