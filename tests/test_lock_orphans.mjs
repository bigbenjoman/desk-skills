// suite: lock orphans (a test lock holder whose caller is gone is named, reclaimed past its grace, and ended by with-lock.sh's caller watch)
// layer: L2
// covers: desk/bin/lock-orphans.mjs desk/bin/lock-caller-watch.mjs desk/bin/with-lock.sh
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { callersOf, endTarget, orphanActs, orphanReason, readRows, reclaimOrphans, worktreeKey } from '../desk/bin/lock-orphans.mjs';
import { endProcs } from '../desk/bin/worker-stop.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'desk', 'bin', 'with-lock.sh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const until = async (fn, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { const v = fn(); if (v) return v; } return fn(); };

// ---- the ruling, on a fixture process table -----------------------------------------------------
const WT = '/w/trees';
const row = (pid, ppid, args, pgid = pid) => ({ pid, ppid, pgid, args });
const INIT = row(1, 0, '/sbin/launchd');
const CLAUDE = row(400, 1, 'claude -p go --session-id abc');
const tickets = new Map([['DS-1', 'parked'], ['DS-2', 'running'], ['DS-3', 'done']]);
const claudeAbove = (rows) => (pid) => {
  const by = new Map(rows.map((r) => [r.pid, r]));
  for (let p = by.get(pid)?.ppid; p > 1; p = by.get(p)?.ppid) if (/^claude\b/.test(by.get(p)?.args ?? '')) return true;
  return false;
};
const reason = (rows, cwd, pid = 600) => orphanReason({ pid, cwd }, { rows, tickets, worktrees: WT, claudeAbove: claudeAbove(rows) });

// AC1: its caller exited, the tool shell above it was re-parented to init.
const dead = [INIT, row(500, 1, '/bin/zsh -c -l source x && eval bash tests/run.sh'), row(600, 500, 'bash tests/run.sh', 500)];
t('AC1 a holder whose caller exited is orphaned, and why says so with its ticket', reason(dead, `${WT}/DS-1`), "its caller exited and it was re-parented to init; its worktree's ticket DS-1 is parked, not running");
t('AC1 a holder re-parented straight to init is orphaned', reason([INIT, row(600, 1, 'bash tests/run.sh')], '/elsewhere'), 'its caller exited and it was re-parented to init');
// AC3: a live worker's holder is left, however long.
const live = [INIT, CLAUDE, row(500, 400, '/bin/zsh -c eval x'), row(600, 500, 'bash tests/run.sh', 500)];
t('AC3 a holder under a live worker session is not orphaned', reason(live, `${WT}/DS-1`), null);
t('AC3 a holder in a running ticket\'s worktree is never orphaned, even re-parented', reason(dead, `${WT}/DS-2`), null);
// The ticket ended and nothing that waits for the run is above it.
const timeoutOwner = [INIT, row(450, 1, 'timeout 9000 bash -c x'), row(600, 450, 'bash tests/run.sh')];
t('AC1 a holder in an ended ticket\'s worktree with no worker above it is orphaned', reason(timeoutOwner, `${WT}/DS-3/sub`), "its worktree's ticket DS-3 is done, not running, and no worker session is above it");
t('the same holder outside any ticket worktree is not orphaned', reason(timeoutOwner, '/elsewhere'), null);
// A person's run from a terminal in an ended ticket's worktree: it has a controlling terminal.
const terminal = [INIT, row(440, 1, 'login -pf ben'), row(450, 440, '-zsh'), { ...row(600, 450, 'bash tests/run.sh'), tty: 'ttys003' }];
t('AC3 a run from a live terminal in an ended ticket\'s worktree is not orphaned', reason(terminal, `${WT}/DS-3`), null);
t('readRows reads a controlling terminal, and none for a detached process', (() => { const me = (readRows() ?? []).find((r) => r.pid === process.pid); return me != null && 'tty' in me; })(), true);
// Drivers that start a run on purpose and wait for it.
t('a run the pass started is not orphaned', reason([INIT, row(450, 1, 'node /h/.claude/desk/bin/pass.mjs'), row(600, 450, 'bash tests/run.sh')], `${WT}/DS-3`), null);
t('a run a detached desk script started is not orphaned', reason([INIT, row(450, 1, 'bash /h/.claude/desk/bin/merge-driver.sh --all-batches'), row(600, 450, 'bash tests/run.sh')], `${WT}/DS-3`), null);
t('a holder whose parent is missing from ps is not judged', reason([INIT, row(600, 777, 'bash tests/run.sh')], `${WT}/DS-1`), null);
t('callersOf walks the tool shell to its session', callersOf(600, live), { callers: [500, 400], owner: CLAUDE });
t('worktreeKey reads the key under the worktrees directory', [worktreeKey(`${WT}/DS-9/a/b`, WT), worktreeKey('/w/treesX/DS-9', WT), worktreeKey(WT, WT)], ['DS-9', null, null]);

// What ending a run ends: its group where nothing else is in it, else its tree by pid; never the ender.
const tree = [INIT, row(600, 1, 'bash tests/run.sh', 500), row(601, 600, 'node a', 500), row(602, 601, 'chrome', 602)];
t('endTarget takes the emptied group and a detached child\'s own group', endTarget(600, tree, 999), { groups: [602, 500], pids: [] });
t('endTarget takes the tree by pid where the group holds another process', endTarget(600, [...tree, row(700, 1, 'other', 500)], 999), { groups: [602], pids: [600, 601] });
t('endTarget never takes the pass that ends it, or its group', endTarget(600, [...tree, row(999, 1, 'node pass.mjs', 500)], 999), { groups: [602], pids: [600, 601] });
t('endTarget from the run\'s own watch takes the run\'s group, not the watch', endTarget(600, [...tree, row(999, 600, 'node lock-caller-watch.mjs 600', 500)], 999), { groups: [602, 500], pids: [] });

// AC2: the grace and the grant.
const run = { pid: 600, args: 'bash tests/run.sh', cwd: `${WT}/DS-1` };
const k = `600 bash tests/run.sh`;
const acts = (o) => orphanActs({ orphans: [{ run, reason: 'r', ours: true }], graceMs: 300000, now: 1_000_000, reclaim: 'yes', ...o });
t('AC2 an orphan first seen now waits out the grace', [acts({}).acts[0].act, acts({}).seen], ['grace', { [k]: 1_000_000 }]);
t('AC2 an orphan seen 5 minutes ago is ended', acts({ seen: { [k]: 700_000 } }).acts[0].act, 'end');
t('an orphan where §3 autopilot-reclaim is not yes is only named', acts({ seen: { [k]: 0 }, reclaim: 'no' }).acts[0].act, 'not-granted');
t('another repo\'s orphan is only named', orphanActs({ orphans: [{ run, reason: 'r', ours: false }], graceMs: 1, now: 9, reclaim: 'yes', seen: { [k]: 0 } }).acts[0].act, 'not-ours');

// ---- AC2 and AC3 on real processes: the pass's reclaim ------------------------------------------
const S = scratch('lock-orphans-');
try {
  const wt = join(S, 'trees');
  mkdirSync(join(wt, 'DS-1'), { recursive: true });
  mkdirSync(join(wt, 'DS-2'), { recursive: true });
  // An orphan: a shell that starts a sleep and exits, leaving it re-parented to init.
  const o = spawnSync('sh', ['-c', 'sleep 300 >/dev/null 2>&1 & echo $!'], { cwd: join(wt, 'DS-1'), encoding: 'utf8' });
  const orphan = Number(o.stdout.trim());
  // A live worker's holder: a child of this process, in a running ticket's worktree.
  const kept = spawn('sleep', ['300'], { cwd: join(wt, 'DS-2'), stdio: 'ignore' });
  await until(() => (readRows() ?? []).find((r) => r.pid === orphan && r.ppid !== process.pid && r.ppid !== 0));
  const pass = (seen) => {
    const rows = readRows();
    const held = [{ pid: orphan, cwd: join(wt, 'DS-1'), args: 'sleep 300', seconds: 600 }, { pid: kept.pid, cwd: join(wt, 'DS-2'), args: 'sleep 300', seconds: 600 }];
    return reclaimOrphans({ held, rows, tickets: new Map([['DS-1', 'parked'], ['DS-2', 'running']]), main: join(S, 'main'), worktrees: wt, reclaim: 'yes', seen, graceMs: 300000,
      claudeAbove: () => false, text: (r) => `${r.cwd}: ${r.args}`, end: (target) => endProcs(target, { graceMs: 3000 }) });
  };
  const first = pass({});
  t('AC1 the pass names the orphan, where it runs, and why', first.lines.length === 1 && first.lines[0].includes(`pid ${orphan}`) && first.lines[0].includes('re-parented to init'), true);
  t('AC2 within the grace the orphan is left running', alive(orphan), true);
  const k2 = Object.keys(first.seen)[0];
  const second = pass({ [k2]: Date.now() - 301000 });
  t('AC2 past the grace the pass ends the orphan and logs it', [/ended it and its process group/.test(second.lines[0] ?? ''), await until(() => !alive(orphan), 5000)], [true, true]);
  t('AC2 an orphan it ended is no longer tracked', second.seen, {});
  t('AC3 the live worker\'s holder is left, however long it has run', alive(kept.pid), true);
  kept.kill('SIGKILL');
} finally { rmSync(S, { recursive: true, force: true }); }

// ---- AC4: with-lock.sh ends the run once its caller exits ---------------------------------------
const L = scratch('lock-caller-');
try {
  const env = { ...process.env, DESK_LOCK_DIR: L, DESK_LEASE_DIR: L, DESK_TEST_LOCK_SLOTS: '1', DESK_CALLER_WATCH_MS: '200' };
  delete env.DESK_LOCK_HELD;
  // The caller: a shell that keeps running after with-lock.sh (the trailing `:` stops it exec'ing), in a
  // group of its own, as a tool call's shell is.
  const caller = spawn('sh', ['-c', `bash '${script}' test -- sh -c 'sleep 300; :'; :`], { env, detached: true, stdio: 'ignore' });
  const holderPids = () => {
    for (const f of ['desk-test.lock.pid', join('desk-test.lock.d', 'pid')]) {
      try { const p = readFileSync(join(L, f), 'utf8').split(/\s+/).filter(Boolean).map(Number); if (p.length && p.every(alive)) return p; } catch { /* not yet */ }
    }
    return null;
  };
  const pids = await until(holderPids);
  t('AC4 the run holds the lock while its caller lives', !!pids, true);
  await sleep(600);
  t('AC4 the run is still running while its caller lives', !!pids && pids.every(alive), true);
  process.kill(caller.pid, 'SIGKILL');
  const group = () => (readRows() ?? []).filter((r) => r.pgid === caller.pid);
  const gone = await until(() => group().length === 0);
  t('AC4 once its caller exits, no process is left in the run\'s group', gone ? [] : group().map((r) => r.args), []);
  const again = spawnSync('bash', [script, 'test', '--timeout', '5', '--', 'true'], { env, encoding: 'utf8' });
  t('AC4 the lock is free again', again.status, 0);
  // A caller that stays: the run ends on its own and the watch with it.
  const ok = spawnSync('bash', [script, 'test', '--', 'sh', '-c', 'echo ran'], { env, encoding: 'utf8' });
  t('a run whose caller stays runs to its end', [ok.status, ok.stdout.trim()], [0, 'ran']);
  // This test's own watches only, by the run pid each watches: other suites' runs have watches too.
  const runs = new Set([...(pids ?? []).slice(0, 1), ok.pid].map(String));
  const ours = (r) => { const w = r.args.split(/\s+/); const i = w.findIndex((x) => x.endsWith('/lock-caller-watch.mjs')); return i >= 0 && runs.has(w[i + 1]); };
  t('no caller watch of this test\'s runs is left once they end', await until(() => !(readRows() ?? []).some(ours), 5000), true);
  if (existsSync(L)) rmSync(L, { recursive: true, force: true });
} finally { rmSync(L, { recursive: true, force: true }); }

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
