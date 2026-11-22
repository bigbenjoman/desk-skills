#!/usr/bin/env node
// A hash of everything a preflight's result depends on, for spawn-worker.sh. With the `preflight` lever
// on (config §3b Phase 0 levers), a preflight that passed is recorded with this hash, and a later one
// with the same hash is skipped: the same ticket's on its own record, any ticket's in the repo on the
// repo's record for a day after the pass.
//
//   node preflight-fingerprint.mjs [--file <name>=<path>]... [--part <name>=<value>]... [--mask <NAME>=<value>]...
//   node preflight-fingerprint.mjs passed <state dir> <fingerprint> <ticket>
//   node preflight-fingerprint.mjs forget <state dir> <fingerprint>
//   node preflight-fingerprint.mjs cross <state dir> <fingerprint> <ticket>
//
// The caller names what it holds, and this adds the installed claude CLI's version, its signed-in
// account, the installed desk commit and every start's effort. Each --mask value (and its real path,
// where it is one) is replaced by <NAME> in every input before hashing, longest value first and only as
// a whole word, so two tickets whose inputs differ only in their worktree, key, branch or database hash
// the same. A file that is a settings file then has each permission rule list read as the set it is. An
// input it cannot read prints no hash and exits 1, naming it: with no hash nothing is matched or
// recorded, so the preflight runs.
//
// `passed` records a pass in the repo's record, `forget` removes one, and `cross` prints the ticket and
// the pass time of another ticket's pass on that fingerprint within the last day, or nothing.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, realpathSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { readInstalled } from './installed.mjs';

const CLAUDE_TIMEOUT_MS = 20 * 1000;
// How long a pass on one ticket stands for another ticket in the repo.
export const CROSS_TICKET_MS = 24 * 60 * 60 * 1000;

const USAGE = 'usage: preflight-fingerprint.mjs [--file <name>=<path>]... [--part <name>=<value>]... [--mask <NAME>=<value>]...\n'
  + '       preflight-fingerprint.mjs passed <state dir> <fingerprint> <ticket> | forget <state dir> <fingerprint> | cross <state dir> <fingerprint> <ticket>';

// The repo's record of passed preflights: { <fingerprint>: { ticket, at } }.
export const passesFile = (state) => join(state, 'workers', 'preflight-passes.json');
const readPasses = (state) => {
  try { const d = JSON.parse(readFileSync(passesFile(state), 'utf8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; } catch { return {}; }
};
// Written whole through a rename, so a reader never sees half a file; entries past the day are dropped.
const writePasses = (state, passes, now) => {
  const kept = Object.fromEntries(Object.entries(passes).filter(([, v]) => now - Date.parse(v?.at) < CROSS_TICKET_MS));
  mkdirSync(join(state, 'workers'), { recursive: true });
  const tmp = `${passesFile(state)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`);
  renameSync(tmp, passesFile(state));
};
// Another ticket's pass on `fp` within the last day, or null. A ticket's own pass is its own record's,
// which a failure clears, so it never stands for the ticket here.
export function crossPass(state, fp, ticket, now = Date.now()) {
  const p = readPasses(state)[fp];
  const age = now - Date.parse(p?.at);
  return p && typeof p.ticket === 'string' && p.ticket !== ticket && age >= 0 && age < CROSS_TICKET_MS ? p : null;
}

// Each value replaced by its placeholder, longest first so a value inside another (a key inside its
// branch or worktree) never splits it, and only where no letter or digit adjoins it.
export function maskText(text, masks) {
  let out = text;
  for (const [name, value] of [...masks].sort(([, a], [, b]) => b.length - a.length)) {
    const re = new RegExp(`(?<![A-Za-z0-9])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'g');
    out = out.replace(re, () => `<${name}>`);
  }
  return out;
}
// A settings file's allow, deny and ask lists, each without repeats once masked: one rule per other
// worktree becomes the same rule however many other worktrees there are.
export function ruleSets(text) {
  let d;
  try { d = JSON.parse(text); } catch { return text; }
  const perms = d?.permissions;
  if (!perms || typeof perms !== 'object') return text;
  for (const k of ['allow', 'deny', 'ask']) if (Array.isArray(perms[k])) perms[k] = [...new Set(perms[k])];
  return JSON.stringify(d);
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) main(process.argv.slice(2));

function main(args) {
  const [cmd] = args;
  if (['passed', 'forget', 'cross'].includes(cmd)) {
    const [, state, fp, ticket] = args;
    if (!state || !/^[0-9a-f]{64}$/.test(fp ?? '') || (cmd !== 'forget' && !ticket)) { console.error(USAGE); process.exit(2); }
    const now = Date.now();
    if (cmd === 'cross') {
      const p = crossPass(state, fp, ticket, now);
      if (p) console.log(`${p.ticket} ${p.at}`);
      return;
    }
    const passes = readPasses(state);
    if (cmd === 'passed') passes[fp] = { ticket, at: new Date(now).toISOString() };
    else delete passes[fp];
    writePasses(state, passes, now);
    return;
  }

  const parts = {};
  const files = new Set();
  const masks = [];
  const unread = [];
  for (let i = 0; i < args.length; i += 2) {
    const [flag, pair = ''] = args.slice(i, i + 2);
    const at = pair.indexOf('=');
    if (!['--file', '--part', '--mask'].includes(flag) || at < 1) { console.error(USAGE); process.exit(2); }
    const [name, value] = [pair.slice(0, at), pair.slice(at + 1)];
    if (flag === '--mask') {
      if (!value) continue;
      masks.push([name, value]);
      try { const real = realpathSync(value); if (real !== value) masks.push([name, real]); } catch { /* not a path */ }
    } else if (flag === '--part') parts[name] = value;
    else {
      files.add(name);
      try { parts[name] = readFileSync(value, 'utf8'); } catch { unread.push(`the ${name} file`); }
    }
  }
  for (const name of Object.keys(parts)) {
    parts[name] = maskText(parts[name], masks);
    if (files.has(name)) parts[name] = ruleSets(parts[name]);
  }

  const claude = (name, pick, ...cmdArgs) => {
    const r = spawnSync('claude', cmdArgs, { encoding: 'utf8', timeout: CLAUDE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status === 0 && r.stdout.trim()) parts[name] = pick(r.stdout.trim());
    else unread.push(`claude ${cmdArgs.join(' ')}`);
  };
  // Only who is signed in, where the status is JSON: a field such as a token's expiry would change the
  // hash on every spawn without changing what the preflight proves.
  const identity = (s) => {
    let d;
    try { d = JSON.parse(s); } catch { return s; }
    if (!d || typeof d !== 'object') return s;
    return JSON.stringify(Object.entries(d).filter(([k]) => /email|org|account|uuid|auth|subscription|loggedIn/i.test(k)).sort(([a], [b]) => a.localeCompare(b)));
  };
  claude('cli', (s) => s, '--version');
  claude('account', identity, 'auth', 'status');

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
}
