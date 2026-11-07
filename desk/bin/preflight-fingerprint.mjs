#!/usr/bin/env node
// A hash of everything a preflight's result depends on, for spawn-worker.sh. With the `preflight` lever
// on (config §3b Phase 0 levers), a preflight that passed is recorded with this hash, and a later one
// with the same hash is skipped.
//
//   node preflight-fingerprint.mjs [--file <name>=<path>]... [--part <name>=<value>]...
//
// The caller names what it holds, and this adds the installed claude CLI's version, its signed-in
// account, the installed desk commit and every start's effort. An input it cannot read prints no hash
// and exits 1, naming it: with no hash nothing is matched or recorded, so the preflight runs.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as E from './desk-env.mjs';
import { readInstalled } from './installed.mjs';

const CLAUDE_TIMEOUT_MS = 20 * 1000;

const parts = {};
const unread = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const [flag, pair = ''] = args.slice(i, i + 2);
  const at = pair.indexOf('=');
  if (!['--file', '--part'].includes(flag) || at < 1) {
    console.error('usage: preflight-fingerprint.mjs [--file <name>=<path>]... [--part <name>=<value>]...');
    process.exit(2);
  }
  const [name, value] = [pair.slice(0, at), pair.slice(at + 1)];
  if (flag === '--part') parts[name] = value;
  else {
    try { parts[name] = readFileSync(value, 'utf8'); } catch { unread.push(`the ${name} file`); }
  }
}

const claude = (name, ...cmd) => {
  const r = spawnSync('claude', cmd, { encoding: 'utf8', timeout: CLAUDE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status === 0 && r.stdout.trim()) parts[name] = r.stdout.trim();
  else unread.push(`claude ${cmd.join(' ')}`);
};
claude('cli', '--version');
claude('account', 'auth', 'status');

// A dirty install's commit does not say what was installed, so its time stands in for the difference.
const installed = readInstalled();
if (installed) parts.desk = installed.dirty ? `${installed.commit} ${installed.at}` : installed.commit;
else unread.push('the installed desk commit');

// Every start's, because a preflight is not told which start it comes before.
parts.effort = E.EFFORT_STARTS.map((s) => `${s}=${E.workerEffort(s)}`).join(' ');

if (unread.length) {
  console.error(`[preflight] no fingerprint, so it runs: could not read ${unread.join(', ')}`);
  process.exit(1);
}
console.log(createHash('sha256').update(JSON.stringify(Object.entries(parts).sort(([a], [b]) => a.localeCompare(b)))).digest('hex'));
