#!/usr/bin/env node
// A red base: the branch the merge driver merges into, whose latest completed run of a §4 Required
// check failed. The driver reads it once per loop (`check`) and merges nothing into a red base but its
// repair ticket's PR; the pass reads the record the driver keeps and reports it once for the batch, and
// starts the repair ticket where config allows (pass.mjs).
//
//   base-red.mjs check --branch <name> [--repo <owner/name>] [--state <dir>] [--by <merger>]
//       one JSON line, { state: red | green | unknown | none, checks?, why?, line? }, exit 0. It keeps
//       <state>/base-red.json while the base is red, removes it once it is green or nothing is required,
//       and leaves it as it was when the base could not be read.
//
// The record, <state>/base-red.json:
//   { branch, sha, checks: [{ name, sha, url }], merges: [{ pr, ticket, sha, at }], repair_key, since, at }
// `merges` are the last MERGES_SHOWN merges the merge log holds for the repo by `--by`, newest first, and `since`
// when this red spell was first read. `repair_key` is this spell's own repair ticket (desk-env baseRedKey),
// so no two spells share one.
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as E from './desk-env.mjs';
import { runsState, FAILED } from './failure-class.mjs';
import { readLog } from './merge-log.mjs';

export const FILE = 'base-red.json';
// How many of the base's newest first-parent commits are read for a check's latest completed run.
export const WALK = 5;
export const MERGES_SHOWN = 3;
export const baseRedPath = (state) => join(state, FILE);
const short = (sha) => String(sha ?? '?').slice(0, 12);

export function readBaseRed(state) {
  try { const r = JSON.parse(readFileSync(baseRedPath(state), 'utf8')); return r && typeof r === 'object' && Array.isArray(r.checks) ? r : null; } catch { return null; }
}
// A running driver rewrites the record every loop it reads the base red, so one older than this was
// left by a driver that has stopped, and says nothing about the base now.
export const STALE_MS = 30 * 60 * 1000;
// The record while it is current: written within STALE_MS of `now`, and for `branch` where one is given
// (the base this batch merges into now). Else null, as for no record.
export function liveBaseRed(state, { branch = null, now = Date.now() } = {}) {
  const r = readBaseRed(state);
  if (!r || (branch != null && r.branch !== branch)) return null;
  const at = Date.parse(r.at);
  return Number.isFinite(at) && now - at <= STALE_MS ? r : null;
}

// Where a required check stands on `branch`: each one's newest completed run, read commit by commit down
// the branch's first-parent line from its tip, at most WALK commits. `read` gives
//   tip(branch) / commit(sha) -> { sha, parent } | null, runs(sha) -> [{ name, status, conclusion, url }] | null
// null meaning the read failed. -> { state: 'none' } with nothing required, { state: 'red', sha, checks }
// when any check's newest completed run failed (whatever a later read gives), { state: 'unknown', why } when a read failed or a check
// has no completed run in the walk, else { state: 'green' }.
export function baseState({ required, branch, read }) {
  if (!required.length) return { state: 'none' };
  const unknown = (why) => ({ state: 'unknown', why });
  let c = read.tip(branch);
  if (!c) return unknown(`the tip of ${branch} could not be read`);
  const tip = c.sha, left = new Set(required), red = [];
  for (let i = 0; i < WALK && c && left.size; i++) {
    const runs = read.runs(c.sha);
    // A read that fails after a check was found red leaves the base red: that failure stands.
    if (runs == null) { if (red.length) break; return unknown(`the check runs on ${branch} at ${short(c.sha)} could not be read`); }
    for (const name of [...left]) {
      const mine = runs.filter((r) => r?.name === name);
      const st = runsState(mine);
      if (!st) continue;
      left.delete(name);
      if (st === 'fail') red.push({ name, sha: c.sha, url: mine.find((r) => FAILED.has(String(r.conclusion ?? '').toLowerCase()))?.url ?? null });
    }
    if (!left.size || !c.parent || i === WALK - 1) break;
    c = read.commit(c.parent);
    if (!c) { if (red.length) break; return unknown(`a commit on ${branch} could not be read`); }
  }
  if (red.length) return { state: 'red', sha: tip, checks: red };
  if (left.size) return unknown(`no completed run of ${[...left].join(', ')} on the newest ${WALK} commits of ${branch}`);
  return { state: 'green' };
}

// The last merges the merge log holds for `repo` by merger `by`, newest first. The log names no target
// branch, so `by` (the driver merging into this base, merge-driver.sh MERGER) is what keeps out merges
// other batches made into other branches; with no `by`, every merger's.
export function lastMerges(events, repo, by = null, n = MERGES_SHOWN) {
  const lc = String(repo).toLowerCase();
  return events.filter((e) => e.event === 'merged' && String(e.repo).toLowerCase() === lc && (by == null || e.by === by)).slice(-n).reverse()
    .map((e) => ({ pr: Number(e.pr), ticket: e.ticket ?? null, sha: e.sha ?? null, at: e.at ?? null }));
}

const checkWords = (r) => r.checks.map((c) => `"${c.name}"${c.url ? ` (run ${c.url})` : ` at ${short(c.sha)}`}`).join(', ');
const mergeWords = (r) => (r.merges?.length
  ? r.merges.map((m) => `#${m.pr}${m.ticket ? ` (${m.ticket})` : ''}`).join(', ')
  : 'none in the merge log');
// The driver's log line for a red base.
export const holdLine = (r) => `HOLDING on red ${r.branch}: required check ${checkWords(r)} failed on its latest run there, so no PR merges into it but its repair ${r.repair_key}'s; the last merges desk made: ${mergeWords(r)}`;

// The pass's one line for the batch. `held` the PRs it holds on it ("#12 (ABC-1)"), `repair` what became
// of the repair: { key, state } of its ticket, or { off: why no worker starts }.
export function batchLine(r, { held = [], repair }) {
  const fix = repair?.off
    ? `The repair is a change on ${r.branch} that no ticket in the batch owns, so it is not one of your own steps: ${repair.off}`
    : `Repair ticket ${repair.key} is ${repair.state}: its PR is the one merge the driver lets into ${r.branch} until the check passes`;
  return `${r.branch} is red: ${checkWords(r)} failed on its latest run there, since ${r.since}. The merge driver merges nothing into it until that passes. ` +
    `The last merges desk made: ${mergeWords(r)}.${held.length ? ` It holds ${held.join(', ')}.` : ''} ${fix}`;
}

// The repair ticket's file ($DESK_STATE/tickets/<key>.md), which its worker reads as its ticket.
export function repairTicket(r) {
  return [
    `# ${r.repair_key}`, '',
    `Source: the autopilot pass, which read ${r.branch} red on a §4 Required check after desk's merges`, '',
    `The latest run on ${r.branch} of each check below failed, so the merge driver merges no other PR into ${r.branch} until it passes there.`, '',
    ...r.checks.map((c) => `- ${c.name}: failed at ${short(c.sha)}${c.url ? `, run ${c.url}` : ''}`), '',
    `The last merges desk made into ${r.branch}, newest first, the likeliest cause:`, '',
    ...(r.merges?.length ? r.merges.map((m) => `- PR #${m.pr}${m.ticket ? ` (${m.ticket})` : ''}${m.sha ? ` at ${short(m.sha)}` : ''}${m.at ? `, merged ${m.at}` : ''}`) : ['- none in the merge log']), '',
    'Read the failing run\'s log (gh run view), find the change that broke it, and fix it on a branch of your own with a PR into ' +
      `${r.branch}. Never revert a merge unless the fix is the revert, and never push to ${r.branch} itself.`, '',
    'Acceptance criteria:',
    ...r.checks.map((c) => `- ${c.name} passes on your PR's head, and on ${r.branch} once it merges.`),
    `- The batch's tests pass on your branch.`, '',
  ].join('\n');
}

// The triage record the repair ticket is admitted from (queue.mjs admit): a small fix with nothing to ask.
export const repairTriage = (r) => ({
  ticket: r.repair_key, type: 'Bug', status: 'To Do', summary: `${r.branch} is red on ${r.checks.map((c) => c.name).join(', ')}`,
  lane: 'A', lane_reason: `a red ${r.branch} the merge driver holds on; the failing run and the last merges are in the ticket file`,
  size: 'S', branch: `fix/${r.repair_key}`, files_in_scope: [], unknowns: [], already_met: [], links: 'n/a',
});

// The record to keep for state `s` read now, carrying `since` from the one before while it is red.
export function nextRecord(was, s, { branch, merges, at }) {
  if (s.state !== 'red') return null;
  const since = was?.branch === branch ? was.since ?? at : at;
  return { branch, sha: s.sha, checks: s.checks, merges, repair_key: E.baseRedKey(branch, since), since, at };
}

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}
const json = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
export function ghRead(repo) {
  const commit = (ref) => {
    const c = json(gh(['api', `repos/${repo}/commits/${encodeURIComponent(ref)}`, '--jq', '{sha: .sha, parent: .parents[0].sha}']));
    return /^[0-9a-f]{40}$/.test(c?.sha ?? '') ? { sha: c.sha, parent: c.parent ?? null } : null;
  };
  return {
    tip: commit, commit,
    runs: (sha) => {
      const r = json(gh(['api', `repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`, '--jq', '[.check_runs[] | {name, status, conclusion, url: (.details_url // .html_url)}]']));
      return Array.isArray(r) ? r : null;
    },
  };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] ?? ''; };
  if (args[0] !== 'check' || !flag('--branch')) {
    console.error('usage: base-red.mjs check --branch <name> [--repo <owner/name>] [--state <dir>] [--by <merger>]');
    process.exit(2);
  }
  const branch = flag('--branch');
  const repo = flag('--repo') ?? E.ghRepo();
  const state = flag('--state') ?? E.stateDir();
  const required = [].concat(E.configValues('required-checks') ?? []).filter((c) => c && !E.isNone(c));
  const s = baseState({ required, branch, read: ghRead(repo) });
  const path = baseRedPath(state);
  if (s.state === 'red') {
    const rec = nextRecord(readBaseRed(state), s, { branch, merges: lastMerges(readLog(), repo, flag('--by')), at: new Date().toISOString() });
    mkdirSync(state, { recursive: true });
    writeFileSync(path, `${JSON.stringify(rec, null, 2)}\n`);
    console.log(JSON.stringify({ ...s, repair_key: rec.repair_key, line: holdLine(rec) }));
  } else {
    if (s.state !== 'unknown' && existsSync(path)) rmSync(path, { force: true });
    console.log(JSON.stringify(s));
  }
}
