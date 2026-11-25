// suite: release watch (a self-merged release weighed against the one before it, rolled back on a hard trip, and by hand)
// layer: L2
// covers: desk/bin/release-watch.mjs desk/bin/maintenance.mjs desk/bin/installed.mjs desk/bin/desk-q.mjs desk/bin/lever-registry.mjs
// Scratch git repos, a scratch desk home and a stand-in gh only.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';
import { compare, windowOf, figures, watchRelease, pinBlocks, recordRelease, readWatch, fyiState, WINDOW_TICKETS, MIN_TICKETS } from '../desk/bin/release-watch.mjs';
import { readAsks } from '../desk/bin/asks.mjs';
import { heldCommits, pruneReleases } from '../desk/bin/installed.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const H = 3_600_000;
const T0 = Date.parse('2026-11-20T09:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const S = scratch('release-watch-');

// A ticket row as machineRows gives one: its outcome in, its last start on `commit`.
let seq = 0;
const row = (commit, over = {}) => {
  seq += 1;
  return { slug: 'o__app', key: `T-${seq}`, state: 'done', merged_at: iso(T0 + seq * 60_000), fix_tries: 1, parked_hours: 2, parks_by_class: {}, reverts: 0,
    start_records: [{ at: iso(T0 + seq * 30_000), desk_commit: commit }], ...over };
};
const many = (n, commit, over = {}) => Array.from({ length: n }, () => row(commit, over));

// ---- AC1: when the window ends, the four metrics are compared with the previous release's ----------------
const P = 'a'.repeat(40);
const R = 'b'.repeat(40);
const rel = { at: iso(T0), from: P, to: R, merges: 2 };
const before = many(10, P);

let w = windowOf(rel, [...before, ...many(5, R)], T0 + H);
t('AC1 window: 5 tickets on the release an hour in is still open', [w.closed, w.tickets.length], [false, 5]);
w = windowOf(rel, [...before, ...many(5, R)], T0 + 72 * H);
t('AC1 window: 72 hours closes it whatever the count', w.closed, true);
w = windowOf(rel, [...before, ...many(12, R)], T0 + H);
t(`AC1 window: ${WINDOW_TICKETS} tickets close it early, and only the first ${WINDOW_TICKETS} count`, [w.closed, w.tickets.length], [true, WINDOW_TICKETS]);
t('AC1 window: a ticket still running is not finished', windowOf(rel, [...many(10, R, { state: 'running', merged_at: null })], T0 + H).closed, false);
t('AC1 window: a ticket whose last start ran on another release is not this one\'s',
  windowOf(rel, many(10, R, { start_records: [{ at: iso(T0), desk_commit: R }, { at: iso(T0 + H), desk_commit: 'c'.repeat(40) }] }), T0 + H).closed, false);

let c = compare(rel, [...before, ...many(10, R)]);
t('AC1 compare: each metric is measured on both releases', Object.keys(c.now), ['tickets', 'fix_tries', 'parked_hours', 'reverts', 'error_parks']);
t('AC1 compare: the same figures trip nothing', [c.now.fix_tries, c.before.fix_tries, c.now.parked_hours, c.trips], [1, 1, 2, []]);
c = compare(rel, [...before, ...many(10, R, { fix_tries: 2 })]);
t('AC1 compare: fix tries doubled trip past the fix-tries margin', c.trips.map((x) => x.metric), ['fix-tries']);
c = compare(rel, [...before, ...many(10, R, { parked_hours: 5 })]);
t('AC1 compare: parked hours up 2.5x trip past the parked-hours margin', c.trips.map((x) => x.metric), ['parked-hours']);
c = compare(rel, [...many(10, P, { parks_by_class: { 'application defect': 1 } }), ...many(10, R, { parks_by_class: { 'agent mistake': 1, 'application defect': 1, quota: 3 } })]);
t('AC1 compare: a park in an error class the release before never had trips; quota is no error', [c.trips.map((x) => x.metric), c.now.error_parks], [['new-error-class-parks'], { 'agent mistake': 10, 'application defect': 10 }]);
c = compare(rel, [...before, ...many(MIN_TICKETS - 1, R, { fix_tries: 5 })]);
t(`AC1 compare: under ${MIN_TICKETS} tickets the guardrails are not weighed, and it says so`, [c.trips, /not weighed/.test(c.note)], [[], true]);
c = compare(rel, [...before, row(R, { reverts: 1 }), ...many(2, R)]);
t('AC1 compare: a post-merge revert is a hard trip on any sample', [c.trips.map((x) => x.metric), c.now.reverts.length], [['post-merge-revert'], 1]);
t('AC1 figures: an empty release has no means', figures([]), { tickets: 0, fix_tries: null, parked_hours: null, reverts: [], error_parks: {} });

// The pass's step: judged once its window closes, never before, and only once.
const d1 = join(S, 'maint1');
const h1 = join(S, 'home1');
recordRelease(d1, { at: T0, from: P, to: R, merges: 2 }, h1);
t('AC1 hold: the release before an unjudged one is held from pruning', [...heldCommits(h1)], [P]);
let reads = 0;
const clean = () => { reads += 1; return [...before, ...many(10, R)]; };
let out = watchRelease({ dir: d1, src: S, home: h1, at: new Date(T0 + H), rowsFor: () => { reads += 1; return [...before, ...many(4, R)]; } });
t('AC1 step: an open window judges nothing', [out.lines, readWatch(d1).judged?.[R] ?? null, reads], [[], null, 1]);
out = watchRelease({ dir: d1, src: S, home: h1, at: new Date(T0 + H + 60_000), rowsFor: clean });
t('AC1 step: the rows are read at most once an hour', reads, 1);
mkdirSync(join(d1, 'release.lock.d'));
writeFileSync(join(d1, 'release.lock.d', 'pid'), String(process.pid));
out = watchRelease({ dir: d1, src: S, home: h1, at: new Date(T0 + 3 * H), rowsFor: clean });
t('AC1 step: while the auto-release holds its lock, nothing is judged', [out.lines, reads], [[], 1]);
rmSync(join(d1, 'release.lock.d'), { recursive: true });
let since = null;
out = watchRelease({ dir: d1, src: S, home: h1, at: new Date(T0 + 3 * H), rowsFor: (o) => { since = o.since; return clean(); } });
t('AC1 step: a closed window is judged and said', [readWatch(d1).judged[R].verdict, out.lines.length, /clean: 10 ticket\(s\), fix tries 1\.00, parked hours 2\.0/.test(out.lines[0])], ['clean', 1, true]);
t('AC1 step: the rows reach back as far as the lever evaluation reads, for tickets that queued long before', (T0 + 3 * H - since) / (24 * H), 180);
t('AC1 hold: a judged release holds nothing', [...heldCommits(h1)], []);
out = watchRelease({ dir: d1, src: S, home: h1, at: new Date(T0 + 5 * H), rowsFor: clean });
t('AC1 step: a judged release is not read again', [out.lines, reads], [[], 2]);

// ---- a desk-skills checkout whose main went P -> two merges -> R, and a desk home keeping both releases ----
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const ghBin = join(S, 'bin');
mkdirSync(ghBin);
writeFileSync(join(ghBin, 'gh'), '#!/bin/sh\necho "$*" >> "$GH_LOG"\ncase "$1 $2" in\n  "pr create") echo "https://github.com/o/desk-skills/pull/77" ;;\n  "pr view") cat "$GH_VIEW" ;;\nesac\n');
chmodSync(join(ghBin, 'gh'), 0o755);
process.env.PATH = `${ghBin}:${process.env.PATH}`;

function fixture(name) {
  const base = join(S, name);
  const origin = join(base, 'origin.git');
  const src = join(base, 'src');
  const g = (...a) => sh('git', ['-C', src, ...a]);
  sh('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  sh('git', ['init', '-q', '-b', 'main', src]);
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false'], ['remote.origin.url', 'https://github.com/o/desk-skills'],
    ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], [`url.${origin}.insteadOf`, 'https://github.com/o/desk-skills']]) g('config', k, v);
  const put = (f, body, msg) => { writeFileSync(join(src, f), body); g('add', f); g('commit', '-q', '-m', msg); };
  put('a.txt', 'one\n', 'chore: start');
  const p = g('rev-parse', 'HEAD');
  g('switch', '-q', '-c', 'feat/x');
  put('x.txt', 'x\n', 'feat: x');
  g('switch', '-q', 'main');
  g('merge', '-q', '--no-ff', '-m', 'Merge pull request #5 from o/feat-x', 'feat/x');
  put('y.txt', 'y\n', 'feat: y (#6)');
  const r = g('rev-parse', 'HEAD');
  g('push', '-q', 'origin', 'main');
  g('fetch', '-q', 'origin');
  const home = join(base, 'desk');
  for (const [n, commit, at] of [['p1', p, T0 - 24 * H], ['r1', r, T0]]) {
    mkdirSync(join(home, 'releases', n, 'bin'), { recursive: true });
    writeFileSync(join(home, 'releases', n, 'release.json'), JSON.stringify({ commit, at: iso(at), release: n }));
  }
  symlinkSync(join('releases', 'r1'), join(home, 'current'));
  return { base, origin, src, g, p, r, home, dir: join(base, 'maint'), state: join(base, 'state') };
}

// ---- AC2: a hard trip pins the previous release, opens the revert PR and raises one needs-you item --------
const f = fixture('ac2');
process.env.GH_LOG = join(f.base, 'gh.log');
recordRelease(f.dir, { at: T0, from: f.p, to: f.r, merges: 2 }, f.home);
t('AC2 hold: install.sh\'s prune keeps the release a rollback may need', [pruneReleases(1, f.home), existsSync(join(f.home, 'releases', 'p1'))], [[], true]);
let restarts = 0;
const tripRows = () => [...many(10, f.p), row(f.r, { key: 'T-REV', reverts: 1 }), ...many(9, f.r)];
out = watchRelease({ dir: f.dir, src: f.src, at: new Date(T0 + 2 * H), rowsFor: tripRows, home: f.home, state: f.state, restart: () => { restarts += 1; return ['merge driver restarted']; } });
const installed = JSON.parse(readFileSync(join(f.home, 'installed.json'), 'utf8'));
t('AC2 pin: the previous release is current and recorded as installed', [readlinkSync(join(f.home, 'current')), installed.commit, installed.release], ['releases/p1', f.p, 'p1']);
t('AC2 pin: what runs is moved onto it', restarts, 1);
const branch = `revert/desk-release-${f.r.slice(0, 12)}`;
const reverted = sh('git', ['-C', f.origin, 'log', '--format=%s', `main..${branch}`]).split('\n');
// git log lists the last revert first: the newest merge was reverted first.
t('AC2 revert PR: one branch reverts every merge between the releases, newest first', reverted, ['Revert "Merge pull request #5 from o/feat-x"', 'Revert "feat: y (#6)"']);
t('AC2 revert PR: the branch undoes the release exactly', sh('git', ['-C', f.origin, 'diff', '--stat', f.p, branch]), '');
const gh = readFileSync(process.env.GH_LOG, 'utf8');
t('AC2 revert PR: opened against main from that branch', [/^pr create --base main --head revert\/desk-release-/m.test(gh), /title revert: roll back desk release/.test(gh)], [true, true]);
const asks = readAsks(f.state);
t('AC2 needs-you: exactly one item', asks.length, 1);
t('AC2 needs-you: it names the merges, the metric and the evidence',
  ['Merge pull request #5 from o/feat-x', 'feat: y (#6)', 'post-merge-revert', 'o__app T-REV was reverted after merging', 'revert PR #77', f.p.slice(0, 12)].filter((s) => !asks[0].text.includes(s)), []);
t('AC2 state: the trip and the pin are kept', [readWatch(f.dir).judged[f.r].verdict, readWatch(f.dir).pinned?.pr, readWatch(f.dir).pinned?.commit], ['tripped', 77, f.p]);
t('AC2 lines: the pass says what it did', ['tripped', 'pinned the previous release', 'opened revert PR #77', 'raised a needs-you item'].filter((s) => !out.lines.some((l) => l.includes(s))), []);
out = watchRelease({ dir: f.dir, src: f.src, at: new Date(T0 + 4 * H), rowsFor: tripRows, home: f.home, state: f.state, restart: () => [] });
t('AC2 once: a later pass raises nothing more', [out.lines, readAsks(f.state).length], [[], 1]);

// The pin holds the auto-release until main carries the revert, and lifts on a PR closed unmerged.
process.env.GH_VIEW = join(f.base, 'view.json');
writeFileSync(process.env.GH_VIEW, JSON.stringify({ state: 'OPEN', mergeCommit: null }));
t('AC2 pin holds: while the revert PR is open', /until revert PR #77 merges/.test(pinBlocks({ dir: f.dir, src: f.src, to: f.r }) ?? ''), true);
f.g('merge', '-q', '--ff-only', `refs/remotes/origin/${branch}`);
const fixed = f.g('rev-parse', 'HEAD');
writeFileSync(process.env.GH_VIEW, JSON.stringify({ state: 'MERGED', mergeCommit: { oid: fixed } }));
t('AC2 pin holds: a commit without the revert stays out', /does not carry it yet/.test(pinBlocks({ dir: f.dir, src: f.src, to: f.r }) ?? ''), true);
t('AC2 pin lifts: once the commit carries the revert', [pinBlocks({ dir: f.dir, src: f.src, to: fixed }), readWatch(f.dir).pinned ?? null], [null, null]);

// The auto-release honours the pin: it records why it installed nothing.
const m = fixture('pin');
const pinState = { pinned: { commit: m.p, tripped: m.r, pr: 78, at: iso(T0) } };
mkdirSync(m.dir, { recursive: true });
writeFileSync(join(m.dir, 'release-watch.json'), JSON.stringify(pinState));
writeFileSync(join(m.home, 'installed.json'), JSON.stringify({ commit: m.p }));
writeFileSync(process.env.GH_VIEW, JSON.stringify({ state: 'OPEN', mergeCommit: null }));
m.g('reset', '-q', '--hard', m.p);
const step = spawnSync(process.execPath, ['--input-type=module', '-e', `const { autoRelease } = await import(${JSON.stringify(join(ROOT, 'desk/bin/maintenance.mjs'))}); console.log(JSON.stringify(await autoRelease({ dir: ${JSON.stringify(m.dir)}, src: ${JSON.stringify(m.src)} })));`],
  { encoding: 'utf8', env: { ...process.env, DESK_HOME: m.home, DESK_RELEASE_CHECK_CMD: 'echo success #', HOME: m.base } });
const said = (() => { try { return JSON.parse(step.stdout).lines.join('\n'); } catch { return step.stderr; } })();
t('AC2 auto-release: a pinned desk installs nothing while the revert PR is open', [/not installed: desk is pinned to/.test(said), m.g('rev-parse', 'HEAD') === m.p], [true, true]);

// So does the maintenance window's update, which otherwise pulls main: it still runs its reboot check.
writeFileSync(join(m.dir, 'maintenance.json'), JSON.stringify({ week: iso(T0 - 2 * H), phase: 'updating', since: iso(T0 - 2 * H), window: 'Mon 06:30 UTC' }));
const win = spawnSync(process.execPath, ['--input-type=module', '-e', `const { maintenance } = await import(${JSON.stringify(join(ROOT, 'desk/bin/maintenance.mjs'))}); console.log(JSON.stringify(await maintenance({ dir: ${JSON.stringify(m.dir)} })));`],
  { encoding: 'utf8', env: { ...process.env, DESK_HOME: m.home, DESK_SOURCE_CHECKOUT: m.src, DESK_RELEASE_CHECK_CMD: 'echo success #', HOME: m.base, XDG_CONFIG_HOME: join(m.base, 'config'),
    DESK_REBOOT_CHECK_CMD: 'echo summary: dirty=0 unpushed=0 heavy=0 filevault=off', DESK_RESTART_CMD: 'true' } });
const winSaid = (() => { try { return JSON.parse(win.stdout).lines.join('\n'); } catch { return win.stderr; } })();
t('AC2 window: a pinned desk is not updated by the maintenance window', [/maintenance: desk-skills not updated: desk is pinned to/.test(winSaid), m.g('rev-parse', 'HEAD') === m.p, /reboot check/.test(readFileSync(join(m.dir, 'maintenance.log'), 'utf8'))], [true, true, true]);

// ---- AC3: desk-q rollback <commit> does the same on demand ------------------------------------------------
const q = fixture('ac3');
process.env.GH_LOG = join(q.base, 'gh.log');
const env = { ...process.env, HOME: q.base, XDG_CONFIG_HOME: join(q.base, 'config'), DESK_HOME: q.home, DESK_SOURCE_CHECKOUT: q.src, DESK_MAINT_DIR: q.dir };
const cli = (...a) => spawnSync(process.execPath, [join(ROOT, 'desk/bin/desk-q.mjs'), 'rollback', ...a], { encoding: 'utf8', cwd: q.base, env });
let r = cli();
t('AC3: with no commit it prints its usage', [r.status, /usage: desk-q rollback <commit>/.test(r.stderr)], [2, true]);
r = cli('1234567');
t('AC3: a commit that is no kept release rolls nothing back', [r.status, /is not a release with one before it/.test(r.stdout)], [1, true]);
r = cli(q.r.slice(0, 1));
t('AC3: a commit shorter than 7 hex digits is refused, never matched', [r.status, /7 to 40 hex digits/.test(r.stderr), existsSync(join(q.dir, 'release-watch.json'))], [2, true, false]);
mkdirSync(join(q.dir, 'release.lock.d'), { recursive: true });
writeFileSync(join(q.dir, 'release.lock.d', 'pid'), String(process.pid));
r = cli(q.r.slice(0, 10));
t('AC3: while the auto-release holds its lock it rolls nothing back', [r.status, /a pass is checking or installing desk-skills/.test(r.stdout), readlinkSync(join(q.home, 'current'))], [1, true, 'releases/r1']);
rmSync(join(q.dir, 'release.lock.d'), { recursive: true });
r = cli(q.r.slice(0, 10));
t('AC3: it exits 0 and says what it did', [r.status, ['pinned the previous release', 'opened revert PR #77', 'raised a needs-you item'].filter((s) => !r.stdout.includes(s))], [0, []]);
t('AC3: the previous release is pinned', [readlinkSync(join(q.home, 'current')), JSON.parse(readFileSync(join(q.home, 'installed.json'), 'utf8')).commit], ['releases/p1', q.p]);
t('AC3: the revert branch reverts both merges', sh('git', ['-C', q.origin, 'log', '--format=%s', `main..revert/desk-release-${q.r.slice(0, 12)}`]).split('\n').length, 2);
const qAsks = readAsks(join(q.base, '.desk-autopilot', 'o__desk-skills'));
t('AC3: one needs-you item in the desk-skills repo, naming the merges and why', [qAsks.length, ['asked by hand', `desk-q rollback ${q.r.slice(0, 10)}`, 'feat: y (#6)', 'Merge pull request #5'].filter((s) => !qAsks[0]?.text.includes(s))], [1, []]);
t('AC3: the release is marked rolled back, so the watch leaves it', readWatch(q.dir).judged?.[q.r]?.verdict, 'rolled back by hand');
r = cli(q.r.slice(0, 10));
t('AC3: rolling the same release back again changes nothing', [r.status, /already rolled back/.test(r.stdout), readWatch(q.dir).pinned?.pr, readAsks(join(q.base, '.desk-autopilot', 'o__desk-skills')).length], [1, true, 77, 1]);
r = cli('--unpin');
t('AC3: --unpin lifts the pin', [r.status, /unpinned/.test(r.stdout), readWatch(q.dir).pinned ?? null], [0, true, null]);
t('AC3: the help names it', /desk-q rollback <commit>/.test(spawnSync(process.execPath, [join(ROOT, 'desk/bin/desk-q.mjs'), '--help'], { encoding: 'utf8', env }).stdout), true);
t('the scratch checkout\'s main was never moved by a revert', existsSync(join(q.src, 'y.txt')), true);

// The needs-you item goes to the desk-skills repo however its origin is spelled (an ssh host alias here).
const aliased = join(S, 'aliased');
sh('git', ['init', '-q', aliased]);
sh('git', ['-C', aliased, 'config', 'remote.origin.url', 'git@github-work:o/desk-skills.git']);
t('fyiState: an ssh host alias still names the desk-skills repo', /o__desk-skills$/.test(fyiState(aliased, null) ?? ''), true);

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
