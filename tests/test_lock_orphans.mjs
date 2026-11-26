// suite: lock-orphans (a test-lock holder whose worker has ended is named and ended; a run never outlives its with-lock.sh caller)
// layer: L2
// covers: desk/bin/lock-orphans.mjs desk/bin/lock-watch.mjs desk/bin/worker-stop.mjs desk/bin/with-lock.sh
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { orphanOf, orphanHolders, orphanLine, endOrphan, logOrphan, orphanLog, orphanGraceS, isDeskOwner } from '../desk/bin/lock-orphans.mjs';
import { belowOf, insideOf } from '../desk/bin/suite-wait.mjs';
import { procStats, startTimes } from '../desk/bin/leases.mjs';
import { psRows } from '../desk/bin/desk-env.mjs';
import { verdict } from '../desk/bin/lock-watch.mjs';
import { runProcs, workerProcs } from '../desk/bin/worker-stop.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const S = scratch('lock-orphans-');
const WT = join(S, 'wt');
mkdirSync(join(WT, 'T-1'), { recursive: true });

// ---- AC1, AC3: which holders are orphaned, and why ----------------------------------------------
const CLAUDE = { pid: 100, ppid: 1, args: '/usr/bin/claude -p --session-id s1' };
// The worker's Bash-tool shell, as ps shows it: the with-lock.sh call is inside its command string.
const SHELL = { pid: 200, ppid: 100, args: "/bin/bash -c source /home/u/.claude/shell-snapshots/s.sh 2>/dev/null || true && eval '~/.claude/desk/bin/with-lock.sh light -- bash tests/test_related.sh' < /dev/null && pwd -P >| /tmp/claude-x-cwd" };
const RUN = { pid: 300, ppid: 200, args: 'bash tests/test_related.sh' };
const tickets = { 'T-1': { state: 'parked' }, 'T-2': { state: 'running' } };
const at = (cwd) => ({ pid: 300, cwd, args: RUN.args, seconds: 4000 });
const why = (procs, cwd = join(WT, 'T-1')) => orphanOf(at(cwd), { procs, worktrees: WT, tickets });

t('#1459 AC3 a holder with its Claude session above it is left alone, its ticket not running and held over an hour',
  why([CLAUDE, SHELL, RUN]), null);
t('#1459 AC1 a holder re-parented to pid 1 is orphaned: its parent is gone',
  why([{ ...RUN, ppid: 1 }], '/elsewhere'), 'its parent is gone (re-parented to pid 1)');
t('#1459 AC1 so is one adopted by a per-user service manager',
  why([{ pid: 50, ppid: 1, args: '/lib/systemd/systemd --user' }, { ...RUN, ppid: 50 }], '/elsewhere'), 'its parent is gone (re-parented to pid 50)');
t('#1459 AC1 a holder whose shell outlived its Claude session, in a worktree whose ticket is not running, is orphaned',
  why([{ ...SHELL, ppid: 1 }, RUN]), "its worktree's ticket T-1 is no longer running (parked)");
t('#1459 AC3 the same holder in a running ticket\'s worktree is left alone',
  why([{ ...SHELL, ppid: 1 }, RUN], join(WT, 'T-2', 'apps')), null);
t('#1459 AC3 a holder under a desk entry point (the base gate the pass started) is left alone',
  why([{ pid: 150, ppid: 1, args: 'node /home/u/.claude/desk/releases/abc123/bin/base-gate.mjs' }, { ...SHELL, ppid: 150 }, RUN]), null);
t('#1459 AC1 a worker\'s baseline typecheck (desk-env.mjs, then with-lock.sh tsc), its ticket not running, is orphaned',
  why([{ ...SHELL, ppid: 1 }, { pid: 240, ppid: 200, args: 'node /home/u/.claude/desk/bin/desk-env.mjs baseline typecheck' },
    { pid: 250, ppid: 240, args: 'bash /home/u/.claude/desk/bin/with-lock.sh tsc -- sh -c pnpm typecheck' }, { ...RUN, ppid: 250, args: 'sh -c pnpm typecheck' }]),
  "its worktree's ticket T-1 is no longer running (parked)");
t('#1459 AC1 a holder under a with-lock.sh wrapper (the child-run path), in a worktree whose ticket is not running, is orphaned',
  why([{ ...SHELL, ppid: 1 }, { pid: 250, ppid: 200, args: 'bash /home/u/.claude/desk/bin/with-lock.sh light -- bash tests/test_related.sh' }, { ...RUN, ppid: 250 }]), "its worktree's ticket T-1 is no longer running (parked)");
t('#1459 only a desk entry point owns a run, and only as the program itself',
  ['node /home/u/.claude/desk/bin/pass.mjs', 'node /x/desk/releases/abc/bin/supervisor.mjs tick --foreground', '/usr/bin/node /x/desk/bin/maintenance.mjs step',
    SHELL.args, 'bash /home/u/.claude/desk/bin/with-lock.sh test -- true', 'node /home/u/.claude/desk/bin/desk-env.mjs baseline lint', 'vim desk/bin/pass.mjs'].map(isDeskOwner),
  [true, true, true, false, false, false, false]);
t('#1459 a holder outside the worktrees directory, its parent alive, is not judged by any ticket',
  why([{ ...SHELL, ppid: 1 }, RUN], '/home/u/code/other'), null);
t('#1459 a holder of a ticket the queue does not hold is not judged by it',
  why([{ ...SHELL, ppid: 1 }, RUN], join(WT, 'X-9')), null);

t('#1459 belowOf gives a path\'s place below a directory, and insideOf still reads it',
  [belowOf(WT)(WT), belowOf(WT)(join(WT, 'T-1', 'a')), belowOf(WT)(`${WT}x/T-1`), insideOf(WT)(join(WT, 'T-1')), insideOf(WT)(`${WT}x`)],
  ['', 'T-1/a', null, true, false]);
const mine = procStats([process.pid], psRows).get(process.pid);
t('#1459 procStats reads a live pid\'s parent and start, and startTimes its start alone',
  [mine?.ppid === process.ppid, startTimes([process.pid], psRows).get(process.pid) === mine?.start, procStats([2 ** 22 + 7], psRows).get(2 ** 22 + 7)],
  [true, true, null]);

// ---- AC2: due past the grace, and what the pass says --------------------------------------------
const procs = [{ ...RUN, ppid: 1 }, { pid: 301, ppid: 1, args: 'node jest' }, { pid: 302, ppid: 1, args: 'node vitest' }];
const held = [{ ...at('/x'), seconds: 700 }, { pid: 301, cwd: '/x', args: 'node jest', seconds: 30 }, { pid: 302, cwd: '/x', args: 'node vitest', seconds: null }];
const found = orphanHolders(held, { procs, worktrees: WT, tickets, graceS: 600 });
t('#1459 AC2 an orphan is due once held past the grace; one under it, or of unknown age, is not',
  found.map((o) => [o.pid, o.due]), [[300, true], [301, false], [302, false]]);
t('#1459 the grace is ten minutes, or AUTOPILOT_ORPHAN_GRACE_S', [orphanGraceS({}), orphanGraceS({ AUTOPILOT_ORPHAN_GRACE_S: '30' })], [600, 30]);
t('#1459 AC1 the line names the holder, its age and why, and when it will be ended',
  orphanLine(found[1], { graceS: 600 }), 'orphaned lock holder /x: node jest, held 0m (pid 301), its parent is gone (re-parented to pid 1): ended once it has held the lock 10 minutes');
t('#1459 AC2 and once ended, how many processes went',
  orphanLine(found[0], { graceS: 600, ended: { ended: [300, 310], left: [] } }), 'orphaned lock holder /x: bash tests/test_related.sh, held 11m (pid 300), its parent is gone (re-parented to pid 1): ended its process group (2 process(es)), freeing the lock');
t('#1459 a dry run only says it would',
  orphanLine(found[0], { graceS: 600, dry: true }).endsWith('(dry run): would end its process group'), true);

// endOrphan reads the process table afresh and signals nothing unless the pid still runs the holder.
const rows = [{ pid: 300, ppid: 1, pgid: 300, args: RUN.args }, { pid: 310, ppid: 300, pgid: 300, args: 'sleep 9' }];
let target = null;
const end = (tg) => { target = tg; return { ended: [300, 310], left: [] }; };
t('#1459 AC2 the holder\'s process group is ended whole', [endOrphan(found[0], { rows, self: 1, end }), target], [{ ended: [300, 310], left: [] }, { groups: [300], pids: [] }]);
target = null;
t('#1459 a pid running something else now is never signalled',
  [endOrphan(found[0], { rows: [{ ...rows[0], args: 'vim' }], self: 1, end }), target], [{ ended: [], left: [], gone: true }, null]);
t('#1459 nor one a Claude session has adopted since',
  endOrphan(found[0], { rows: [{ pid: 100, ppid: 1, pgid: 100, args: CLAUDE.args }, { ...rows[0], ppid: 100 }], self: 1, end }).gone, true);
logOrphan(S, found[0], { ended: [300], left: [] }, '2026-11-25T00:00:00.000Z');
t('#1459 AC2 an ended orphan is logged', JSON.parse(readFileSync(orphanLog(S), 'utf8')),
  { at: '2026-11-25T00:00:00.000Z', pid: 300, cwd: '/x', args: RUN.args, seconds: 700, why: 'its parent is gone (re-parented to pid 1)', ended: [300], left: [] });

// ---- runProcs: the group a run does not lead is ended whole only once its leader has gone --------
const grp = [{ pid: 400, ppid: 1, pgid: 399, args: 'bash run.sh' }, { pid: 401, ppid: 400, pgid: 399, args: 'node a' }, { pid: 402, ppid: 1, pgid: 399, args: 'node b' }];
t('#1459 a dead caller\'s group, holding only the run\'s processes, is ended whole', runProcs(400, grp, { self: 1 }), { groups: [399], pids: [] });
t('#1459 a group whose leader lives is not: only the run\'s own tree',
  runProcs(400, [...grp, { pid: 399, ppid: 1, pgid: 399, args: 'bash' }], { self: 1 }), { groups: [], pids: [400, 401] });
t('#1459 nor one a Claude session is in',
  runProcs(400, [...grp, { pid: 405, ppid: 1, pgid: 399, args: 'claude -p' }], { self: 1, isSession: (a) => a.startsWith('claude') }), { groups: [], pids: [400, 401] });
t('#1459 workerProcs still reads a session as before',
  workerProcs('s1', [{ pid: 500, ppid: 1, pgid: 500, args: 'claude --session-id s1' }, { pid: 501, ppid: 500, pgid: 500, args: 'bash' }], 1), { groups: [500], pids: [] });

// ---- AC4: lock-watch's verdict, and the real wrapper ------------------------------------------------
t('#1459 AC4 the watch ends the run once its parent is not the caller', verdict({ ppid: 1, start: '9' }, 77, '9'), 'orphaned');
t('#1459 AC4 and leaves it while it is', verdict({ ppid: 77, start: '9' }, 77, '9'), null);
t('#1459 a pid gone, or reused (another start time), is gone', [verdict(null, 77, '9'), verdict({ ppid: 1, start: '10' }, 77, '9')], ['gone', 'gone']);

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = (fn, ms) => { for (const until = Date.now() + ms; Date.now() < until;) { if (fn()) return true; spawnSync('sleep', ['0.2']); } return fn(); };
const lockDir = join(S, 'locks');
mkdirSync(lockDir);
const env = { ...process.env, DESK_LOCK_DIR: lockDir, DESK_LEASE_DIR: lockDir, DESK_LOCK_WATCH_S: '1' };
const script = join(root, 'desk', 'bin', 'with-lock.sh');
// A caller that stays the wrapper's parent (`; :` keeps bash from exec'ing into it), running a command
// that leaves a background child, which writes its pid where the test can read it.
const kid = join(S, 'kid.pid');
const startCaller = () => spawn('bash', ['-c', `bash ${script} browser -- sh -c 'sleep 300 & echo $! > ${kid}; wait'; :`], { env, detached: true, stdio: 'ignore' });
// The run is the command with-lock.sh exec'd into: the child's parent.
const parentOf = (pid) => Number(spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());

const caller = startCaller();
const up = waitFor(() => existsSync(kid) && readFileSync(kid, 'utf8').trim() !== '', 10_000);
const child = up ? Number(readFileSync(kid, 'utf8').trim()) : 0, run = up ? parentOf(child) : 0;
spawnSync('sleep', ['2.5']);
t('#1459 AC4 a run whose caller lives keeps running', up && alive(run) && alive(child), true);
process.kill(caller.pid, 'SIGKILL');
t('#1459 AC4 once its caller is killed, the run and the child it started are ended', waitFor(() => !alive(run) && !alive(child), 15_000), true);
const next = spawnSync('bash', [script, 'browser', '--timeout', '0', '--', 'true'], { env, encoding: 'utf8' });
t('#1459 AC4 and the lock is free', next.status, 0);

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('all passed');
