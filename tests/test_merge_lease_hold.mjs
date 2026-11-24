// suite: merge lease hold (a session's merge and arming under the merge lease: the stacked hold until GitHub reports the merge, and the skill steps)
// layer: L2
// covers: desk/bin/merge-lease-hold.mjs desk/bin/merge-lease.mjs skills/desk-ticket/references/stage-7-pr.md skills/desk-pr/references/opening.md skills/desk-clearance/references/phase-6-merge-lane.md
// merge-lease-hold.mjs's hold() against a scratch lease directory and merge log, with a stubbed gh, a
// stubbed ledger record and a fake clock; merge-lease.mjs's CLI finding the ledger with no DESK_QUEUE;
// and the skill text that sends Stage 7, arming and the clearance merge lane through the lease.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';
import { acquire, storeFile } from '../desk/bin/leases.mjs';
import { hold } from '../desk/bin/merge-lease-hold.mjs';
import { psRows, repoSlug } from '../desk/bin/desk-env.mjs';
import { readLog } from '../desk/bin/merge-log.mjs';
import { append } from '../desk/bin/ticket-ledger.mjs';

let fails = 0;
const t = (name, got, want) => {
  const g = typeof got === 'string' ? got : JSON.stringify(got); const w = typeof want === 'string' ? want : JSON.stringify(want);
  const ok = g === w; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${g}${ok ? '' : ` (want ${w})`}`);
};
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const S = scratch('merge-lease-hold-');
const SHA = '1111111111111111111111111111111111111111';
const R = 'acme/widgets';
const BY = 'session s-1';
const envOf = (mode) => ({ machineValue: (k) => (k === 'lease-kinds' ? `merge=${mode}` : null), testLockSlots: () => 1, psRows });
let n = 0;
const leaseLog = (dir) => { try { return readFileSync(join(dir, 'leases.log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const noLedger = () => ({ tickets: {} });

// One hold, on a fresh lease directory and merge log. `merges` is the poll on which gh reports the PR
// merged (0: never), `head` the head it reports. -> { code, lines, calls, ledger, dir, log, clock }.
function run({ mode = 'on', merges = 1, head = SHA, enqueue = 0, readLedger = noLedger, settle = 120, poll = 5, ticket = 'T-1', wait = 0, dir, pre } = {}) {
  dir ??= join(S, `d${n++}`);
  mkdirSync(dir, { recursive: true });
  const logPath = join(S, `merges-${n}.jsonl`);
  pre?.(dir);
  let clock = Date.parse('2026-11-24T10:00:00Z');
  const lines = [], calls = [], ledger = [];
  let polls = 0;
  const gh = (args) => {
    calls.push(args.join(' '));
    if (args.includes('PUT')) return { status: enqueue, stdout: '', stderr: enqueue ? 'Pull Request is not mergeable' : '' };
    polls++;
    return { status: 0, stdout: `${merges && polls >= merges ? 'true' : 'false'} ${head}\n`, stderr: '' };
  };
  const recordLedger = (a) => {
    const held = JSON.parse(readFileSync(storeFile(dir), 'utf8')).leases.filter((l) => l.kind === 'merge').length;
    ledger.push({ ...a, held });
    return { ok: true, text: `${a.ticket} merged at 2026-11-24T10:00:10.000Z` };
  };
  const code = hold({ pr: 501, sha: SHA, repo: R, base: 'main', by: BY, method: 'squash', ticket, head: ticket ? 'feat/T-1' : null, settle, poll, wait,
    env: envOf(mode), dir, ledger: true, readLedger, gh, recordLedger, logPath, now: () => clock, sleep: (ms) => { clock += ms; }, say: (l) => lines.push(l) });
  return { code, lines, calls, ledger, dir, log: readLog(logPath), clock: (clock - Date.parse('2026-11-24T10:00:00Z')) / 1000, polls };
}
const events = (d) => leaseLog(d).filter((e) => e.kind === 'merge').map((e) => e.event).join(' ');
// A live process holding the merge lease on acme/widgets@main as `label`, in lease directory `dir`.
const holders = [];
function holdLease(dir, mode, label) {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  holders.push(c);
  spawnSync('sleep', ['0.2']);
  acquire({ kind: 'merge', key: `${R}@main`, units: 1, ttl: 60, label, pid: c.pid, wait: 0 }, { env: envOf(mode), dir });
}

// AC5: the stacked merge holds the lease until GitHub reports the PR merged.
{
  const r = run({ merges: 3 });
  t('AC5 enqueued once through the enqueue-only call, then polled .merged until it reported merged', [r.code, r.calls.filter((c) => c.includes('merge-async')).length, r.polls, r.clock], [0, 1, 3, 10]);
  t('AC5 the hold is one lease: granted, then released after the merge', events(r.dir), 'grant release');
  t('AC5 the lease TTL outlasts the settle time it covers', leaseLog(r.dir).find((e) => e.event === 'grant')?.ttl, 180);
  t('AC5 the merge log has the claim and the merged record', r.log.map((e) => `${e.event} ${e.by} ${e.ticket ?? ''}`.trim()), [`claim ${BY}`, `merged ${BY} T-1`]);
  t('AC5 the enqueue names the method', r.calls[0], `api -X PUT repos/${R}/pulls/501/merge-async -f merge_method=squash`);
}
{
  const r = run({ merges: 0 });
  t('AC5 never reported merged: it waits 120 seconds, then gives up and releases', [r.code, r.clock, events(r.dir)], [1, 120, 'grant release']);
  t('AC5 not merged in time records no merge and no ledger entry', [r.log.map((e) => e.event), r.ledger.length], [['claim'], 0]);
  t('AC5 it says the PR was not reported merged and to read it before the next PR', r.lines.some((l) => l.includes('not reported merged within 120s') && l.includes('before the next PR in the stack')), true);
}
{
  const r = run({ merges: 0, settle: 7, poll: 5 });
  t('AC5 the settle time bounds the hold, the last read at the bound', [r.clock, r.polls], [7, 3]);
}

// AC4: the ledger records the PR, the head, the base and the session before the lease is released.
{
  const r = run({ merges: 1 });
  t('AC4 the ledger record names the PR, head, base and session, with the lease still held', r.ledger, [{ ticket: 'T-1', pr: 501, head: 'feat/T-1', sha: SHA, base: 'main', by: BY, held: 1 }]);
  t('AC4 it says the ledger recorded it', r.lines.some((l) => l.startsWith('#501 ledger: T-1 merged')), true);
  const none = run({ merges: 1, ticket: null });
  t('AC4 a PR with no ticket records no ledger entry, only the merge log line', [none.code, none.ledger.length, none.log.map((e) => e.event)], [0, 0, ['claim', 'merged']]);
}

// AC2: a merge or arming another desk path made at this head stops the hold before anything is called.
{
  const state = (merge, automerge) => () => ({ tickets: { 'T-1': { key: 'T-1', merge, automerge } } });
  const m = run({ readLedger: state({ pr: 501, head_sha: SHA, by: 'merge-driver acme__widgets' }) });
  t('AC2 a merge the ledger records at this head is not merged again, naming the path', [m.code, m.calls.length, m.lines.some((l) => l.includes('NOT merged: the ticket ledger records it merged by merge-driver acme__widgets at 111111111'))], [3, 0, true]);
  const a = run({ readLedger: state(null, { pr: 501, head_sha: SHA, by: 'session other' }) });
  t('AC2 an armed auto-merge the ledger records is not merged, naming who armed it', [a.code, a.lines.some((l) => l.includes('armed for auto-merge by session other'))], [3, true]);
  t('AC2 the refused hold took the lease and gave it back', events(a.dir), 'grant release');
}

// AC1: on, another holder keeps the lease: the hold waits, and gives up naming who holds it.
{
  const dir = join(S, 'busy-on');
  const r = run({ dir, wait: 0, pre: (d) => { mkdirSync(d, { recursive: true }); holdLease(d, 'on', 'merge-driver acme__widgets #500'); } });
  t('AC1 with the driver holding the lease, it does not merge and names the driver', [r.code, r.calls.length, r.lines.some((l) => l.includes('is held by merge-driver acme__widgets #500'))], [75, 0, true]);
}

// AC6: shadow, the same holder: no wait, and a would-refuse naming both.
{
  const dir = join(S, 'busy-shadow');
  const r = run({ mode: 'shadow', dir, wait: 30, pre: (d) => { mkdirSync(d, { recursive: true }); holdLease(d, 'shadow', 'merge-driver acme__widgets #500'); } });
  const w = leaseLog(dir).find((e) => e.event === 'would-refuse');
  t('AC6 in shadow it merges without waiting', [r.code, r.clock], [0, 0]);
  t('AC6 the lease log records a would-refuse naming the session and the driver', `${w?.label} | ${w?.holders?.map((h) => h.label).join(', ')}`, `${BY} #501 | merge-driver acme__widgets #500`);
}

// AC7: off takes no lease, reads no ledger and writes no ledger record; it merges as before.
{
  const r = run({ mode: 'off', readLedger: () => { throw new Error('read'); } });
  t('AC7 with the kind off nothing is leased or read, and the merge goes as before', [r.code, events(r.dir), r.ledger.length, r.calls.length, r.log.map((e) => e.event)], [0, '', 0, 2, ['claim', 'merged']]);
}

// AC8: on, the lease store unreadable: nothing is merged, and it names the reset command.
{
  const r = run({ pre: (d) => writeFileSync(storeFile(d), 'not json') });
  t('AC8 with the store unreadable it does not merge, and says merges wait for the store and the reset command', [r.code, r.calls.length, r.lines.some((l) => l.includes('merges wait for the lease store') && l.includes('desk-env lease reset --reason'))], [4, 0, true]);
}

// The merge log's claim, a refused enqueue and a merge at another head.
{
  const dir = join(S, 'claimed');
  const r = run({ dir, pre: () => {} });
  const again = hold({ pr: 501, sha: SHA, repo: R, base: 'main', by: 'session s-2', method: 'squash', settle: 1, env: envOf('on'), dir, ledger: false, gh: () => ({ status: 0, stdout: 'true', stderr: '' }),
    logPath: join(S, `merges-${n}.jsonl`), say: () => {} });
  t('a PR another merger recorded in the merge log is refused there, after the ledger check', [r.code, again], [0, 11]);
  const q = run({ enqueue: 1 });
  t('a refused enqueue is recorded failed and is not merged', [q.code, q.log.map((e) => e.event), events(q.dir)], [1, ['claim', 'failed'], 'grant release']);
  const other = run({ head: '2222222222222222222222222222222222222222' });
  t('a merge at another head says stop: something merged unchecked', [other.code, other.lines.some((l) => l.includes('STOP: GitHub merged it at 222222222, not the head checked'))], [1, true]);
}

// merge-lease.mjs take: with no DESK_QUEUE it reads this repo's ledger as desk-env finds it.
{
  const home = join(S, 'desk-home');
  const repoDir = join(home, 'repos', repoSlug());
  mkdirSync(repoDir, { recursive: true });
  append(repoDir, [{ type: 'merged', batch: 'standing', key: 'T-1', data: { by: 'merge-driver x', pr: 501, head_sha: SHA, base: 'main' } }]);
  const machine = join(S, 'machine.md');
  writeFileSync(machine, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `lease-kinds` | `merge=on` | test |\n');
  const env = { ...process.env, DESK_HOME: home, DESK_MACHINE: machine, DESK_LEASE_DIR: join(S, 'cli-leases'), DESK_LEVERS: 'ledger' };
  delete env.DESK_QUEUE; delete env.DESK_BATCH;
  const take = (extra) => spawnSync(process.execPath, [join(root, 'desk/bin/merge-lease.mjs'), 'take', '501', SHA, '--repo', R, '--base', 'main', '--by', BY, ...extra], { encoding: 'utf8', env, cwd: root });
  const r = take(['--pid', String(process.pid), '--wait', '0']);
  let out = {}; try { out = JSON.parse(r.stdout); } catch { /* checked below */ }
  t('AC2 a session (no DESK_QUEUE) is refused a PR this repo\'s ledger records merged, naming the path', [r.status, out.owner, out.lines?.some((l) => l.includes('NOT merged: the ticket ledger records it merged by merge-driver x'))], [3, process.pid, true]);
  t('--pid and --owner together is a usage error', take(['--pid', String(process.pid), '--owner', 'claude']).status, 2);
  t('--owner takes only claude', take(['--owner', 'me']).status, 2);
}

// AC1 to AC8: the skill steps name the lease, the ledger check and the record inside one hold, by mode.
{
  const s7 = readFileSync(join(root, 'skills/desk-ticket/references/stage-7-pr.md'), 'utf8');
  const sec = s7.slice(s7.indexOf('**Every merge and every arming is one hold of the merge lease**'), s7.indexOf('Where the repo does not allow auto-merge,'));
  const has = (s) => sec.includes(s);
  t('Stage 7 has the merge lease step', sec.length > 200, true);
  t('AC7 Stage 7: off merges as before, with no lease and no ledger check', has('**`off`**: merge or arm as before, with no lease and no ledger check.'), true);
  t('AC1 Stage 7: the take comes before the claim, as the session, and on waits naming the merge driver', has('before the claim, take the lease and the ledger check') && has('merge-lease.mjs take <n> <headRefOid> --repo <repo> --base <the PR\'s base> --by "session <your session name>" --owner claude') && has('say you are waiting\n  on that holder (the merge driver'), true);
  t('AC6 Stage 7: shadow never waits and logs a would-refuse naming both', has('In shadow it never waits') && has('would-refuse naming you and the holder'), true);
  t('AC2 Stage 7: exit 3 does not merge and reports the path', has('**Exit 3**') && has('Do not merge or arm it; report the line, which names that path.'), true);
  t('AC3 Stage 7: arming releases once the arming call returns', has('Arming releases it once the arming call\n    returns and `armed` is recorded'), true);
  t('AC8 Stage 7: an unreadable store does not merge and names the reset command', has('**Exit 4**') && has('merges wait for the lease store') && has('desk-env lease reset --reason <why>'), true);
  t('Stage 7: the release names the owner the take printed', has('leases.mjs release <lease> --pid <owner>'), true);
  const open = readFileSync(join(root, 'skills/desk-pr/references/opening.md'), 'utf8');
  t('AC3 desk-pr: arming takes the lease and the ledger check, released once the arming call returns', open.includes('merge-lease.mjs take … --owner claude') && open.includes('released once the\narming call returns') && open.includes('With it `off`, arm or merge as before.'), true);
  const lane = readFileSync(join(root, 'skills/desk-clearance/references/phase-6-merge-lane.md'), 'utf8');
  t('AC4 clearance: the lane records its merge in the ledger before releasing', lane.includes('record the merge in the ledger before releasing the lease') && lane.includes('queue.mjs merged <TICKET> --pr <n> --head <branch> --head-sha <head>\n   --base <base> --by "session <your session name>"'), true);
  t('AC5 clearance: a stacked merge goes through the hold, until merged or 120 seconds', lane.includes('merge-lease-hold.mjs <n> <head> --repo <§0 GitHub repo> --base <the PR\'s base> --method <method>') && lane.includes('until GitHub reports\n   the PR merged or 120 seconds pass, whichever is first'), true);
  t('AC5 clearance: the raw enqueue call is gone from the lane', lane.includes('gh api -X PUT'), false);
  t('AC6 AC7 AC8 clearance: off, shadow and on, and the unreadable store', lane.includes('`off`\n   merges as before, with no lease and no ledger check') && lane.includes('`shadow` takes the lease without waiting') && lane.includes('desk-env lease reset --reason <why>'), true);
}

for (const c of holders) c.kill();
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
