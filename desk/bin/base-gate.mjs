#!/usr/bin/env node
// The base gate: the check a feature-mode batch's base passes before its promotion PR leaves draft.
//
// pass.mjs starts it in the background once every child has merged into the base, because the base's
// full suites can outlast the Bash tool's 10-minute limit, and reads its result from the queue on
// later passes. In the base worktree it merges the default branch in (as every sync does), then runs
// every acceptance spec and the repo's Typecheck, Lint and Unit tests. It passes only when each one
// passes and no spec under the acceptance directory is still marked expected-fail or skipped; then the
// promotion PR is marked ready (config §3 pr-ready). Merging the promotion PR stays the person's.
//
// The result is the queue's `gate`: { state: 'passed' | 'failed', sha, started, finished, failures,
// close_out, pr, ready, note }. `close_out` is the epic's criteria no spec covers, which the close-out
// checks one by one; null when the criteria could not be read.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import * as E from './desk-env.mjs';
import { readQueue, crashShowsPerson, describeCrash } from './batch-state.mjs';
import { ensureBaseWorktree, syncBase } from './base-sync.mjs';
import { declarations, ownedSpecs, specFilesAt, specsCommand } from './spine-check.mjs';
import { runItem } from './baseline.mjs';
import { takesFiles } from './test-scope.mjs';

const BIN = E.binDir();
const started = new Date().toISOString();
const failures = [];
// The base's head as pass.mjs read it when it started this run, until a sync succeeds here. pass.mjs
// runs the gate again only once origin's base differs from the recorded sha, so a run that could not
// sync must record that head, never a stale local one, or every pass would start it again.
let sha = null;
try { sha = readQueue(E.queueFile()).gate?.sha ?? null; } catch { /* read again below */ }
// The base worktree, once this run has synced it clean: whatever the checks then write there is put
// back, however the run ends. Before that, anything in it is the person's.
let ours = null;
const git = (cwd, args) => { try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

// Whatever happens, the queue gets a result: a gate that dies silently would hold the batch for ever.
function finish(extra = {}) {
  // An install or a lint fixer can write to the base worktree, and the next sync refuses a dirty one.
  if (ours && git(ours, ['status', '--porcelain'])) {
    git(ours, ['checkout', '-q', '--', '.']);
    git(ours, ['clean', '-fdq']);
  }
  const Q = readQueue(E.queueFile());
  const pr = Q.promotion?.pr ?? null;
  let ready = false;
  let note = null;
  if (!failures.length && pr != null) {
    const repo = E.ghRepo();
    if (E.permission('pr-ready') === 'yes') {
      try {
        execFileSync('gh', ['pr', 'ready', String(pr), '--repo', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
        ready = true;
      } catch (e) {
        note = `PR #${pr} could not leave draft (${String(e.stderr ?? e.message).trim().split('\n').pop()}): gh pr ready ${pr} --repo ${repo}`;
      }
    } else {
      note = `config §3 ${E.permissionKey('pr-ready')} is "${E.permission('pr-ready')}": undraft PR #${pr} yourself (gh pr ready ${pr} --repo ${repo})`;
    }
  }
  const gate = {
    state: failures.length ? 'failed' : 'passed', sha, started, finished: new Date().toISOString(), pid: process.pid,
    failures, close_out: null, pr, ready, note, ...extra,
  };
  execFileSync('node', [join(BIN, 'queue.mjs'), 'set-batch', `gate=${JSON.stringify(gate)}`], { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(`base gate ${gate.state} at ${sha ?? '?'}${failures.length ? `:\n  ${failures.join('\n  ')}` : ''}${note ? `\n${note}` : ''}`);
}
crashShowsPerson((e) => {
  failures.push(`the gate crashed: ${describeCrash(e).split('\n')[0]}`);
  try { finish(); } catch (err) { console.error(describeCrash(err)); }
});

E.applyBatchBase();
const BASE = E.batchBase();
const SOURCE = E.configValue('default-branch');
const STATE = E.stateDir();
const Q = readQueue(E.queueFile());

const tail =(out) => String(out ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
const items = (id) => { const v = E.configValues(id); return v && !E.isNone(v) ? v.map(E.parseCommandItem) : []; };

// The epic's criteria no spec covers: every criterion the spine was not asked to write a spec for.
function closeOut() {
  try {
    const x = JSON.parse(readFileSync(join(STATE, 'expansion.json'), 'utf8'));
    if (!Q.epic || x.parent !== Q.epic || !Array.isArray(x.criteria)) return null;
    const specced = new Set(Q.spine_ids ?? []);
    return x.criteria.map((c) => c.id).filter((id) => !specced.has(id));
  } catch { return null; }
}

function gate() {
  if (!BASE || !SOURCE || BASE === SOURCE) { failures.push('the batch has no base'); return; }
  const wt = ensureBaseWorktree({ main: E.repoRoot(), worktrees: E.worktreesDir(), base: BASE });
  if (!wt.ok) { failures.push(`base worktree: ${wt.why}`); return; }
  const path = wt.path;

  // The same grant every sync needs: one approval per batch where it is `ask`.
  const perm = E.permissionOrUnset('batch-base-push') ?? 'ask';
  const push = perm === 'yes' || (perm === 'ask' && !!process.env.AUTOPILOT_BASE_PUSH_APPROVED);
  const s = syncBase({ path, base: BASE, branch: SOURCE, push });
  if (!s.ok) {
    failures.push(s.reason === 'conflict' ? `merging ${SOURCE} into ${BASE} conflicts (${s.files.join(', ')}): resolve it in ${path} and push`
      : s.reason === 'permission' ? `${BASE} is ${s.merged} commit(s) behind ${SOURCE} and config §3 ${E.permissionKey('batch-base-push')} is "${perm}", so it was not synced${perm === 'ask' ? ': run passes with AUTOPILOT_BASE_PUSH_APPROVED=1' : ''}`
        : `syncing ${BASE}: ${s.why}`);
    return;
  }
  sha = git(path, ['rev-parse', 'HEAD']);
  ours = path;
  const pre = E.configValue('command-prefix');
  const prefix = pre && !E.isNone(pre) ? pre.trim() : '';
  const run = (lock, { dir, cmd }) => runItem({ bin: BIN, root: path, dir, cmd, lock, prefix });

  for (const it of items('install-cmd')) {
    const r = run('nolock', it);
    if (r.code !== 0) { failures.push(`§4 Install (${it.cmd}) failed with exit ${r.code}: ${tail(r.out)}`); return; }
  }

  // Every acceptance spec: none still held, and the specs of every criterion id passing when run: the
  // ids this epic's spine was asked for, and any other id a spec there is titled with (an earlier
  // epic's), since the command runs specs by id.
  let specDir = null;
  let cmd = null;
  try {
    const v = E.configValues('acceptance-specs');
    if (v && !E.isNone(v)) { specDir = v[0]; cmd = v.find((x) => x.includes('{ids}')) ?? null; }
  } catch (e) { failures.push(e.message); }
  if (!specDir || !cmd) failures.push('config §4 Acceptance specs names no spec directory and command taking {ids}');
  else {
    const files = specFilesAt(path, 'HEAD', specDir);
    for (const f of files) {
      for (const d of declarations(f.path, f.text).filter((x) => x.held)) failures.push(`"${d.title}" in ${f.path} is still ${d.held}`);
    }
    // Bounded the way ownedSpecs matches a title, so a Python name (`test_dod4_…`) yields its id too.
    const titled = files.flatMap((f) => declarations(f.path, f.text))
      .flatMap((d) => [...d.title.matchAll(/(?:^|[^A-Za-z0-9])(AC|DoD)(\d+)(?![A-Za-z0-9])/gi)].map((m) => `${/^ac$/i.test(m[1]) ? 'AC' : 'DoD'}${m[2]}`));
    const ids = [...new Set([...(Q.spine_ids ?? []), ...titled])];
    for (const { id, specs } of ownedSpecs(files, ids)) {
      if (!specs.length) { failures.push(`${id}: no spec titled with it on ${BASE}`); continue; }
      const command = specsCommand(cmd, id);
      const r = runItem({ bin: BIN, root: path, dir: '.', cmd: command, lock: 'test', prefix: '' });
      if (r.code !== 0) failures.push(`${id}: ${specs.map((x) => `"${x.title}" in ${x.path}`).join(', ')} fails when run (${command}): ${tail(r.out)}`);
    }
  }

  // The repo's own checks, each under its lock, the test runner capped as a worker's is.
  const capRaw = E.configValue('test-cap');
  const cap = /^\d+$/.test(String(capRaw ?? '').trim()) ? String(capRaw).trim() : null;
  for (const [id, label] of [['typecheck-cmd', 'Typecheck'], ['lint-cmd', 'Lint'], ['test-cmd', 'Unit tests']]) {
    for (const it of items(id)) {
      const c = id === 'test-cmd' && cap && takesFiles(it.cmd) ? `${it.cmd} --maxWorkers=${cap}` : it.cmd;
      const r = run(E.lockFor(id), { dir: it.dir, cmd: c });
      if (r.code !== 0) failures.push(`§4 ${label} (${it.dir === '.' ? '' : `${it.dir}: `}${c}) failed with exit ${r.code}: ${tail(r.out)}`);
    }
  }
}

gate();
finish({ close_out: closeOut() });
