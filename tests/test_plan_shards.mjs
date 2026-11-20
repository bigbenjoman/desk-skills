// suite: CI shards (tests/plan_shards.mjs balances the suites over parallel jobs by recorded duration)
// tests/plan_shards.mjs on fixture durations, then on this repo's suites and tests/suite_durations.json.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan, matrix, describe, durationsFromLog, median, readDurations, SHARDS } from './plan_shards.mjs';
import { repoMap } from './scope_sections.mjs';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const g = JSON.stringify(got); const w = JSON.stringify(want); const ok = g === w; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${g}${ok ? '' : ` (want ${w})`}`); };
const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const every = (p) => p.shards.flatMap((x) => x.suites).sort();
const slowest = (p) => Math.max(...p.shards.map((x) => x.seconds));
const bound = (p) => p.total / p.shards.length + p.longest;

// ---- fixture durations -------------------------------------------------------------------------
const secs = { 'test_a.sh': 370, 'test_b.sh': 310, 'test_c.sh': 200, 'test_d.mjs': 90, 'test_e.mjs': 85, 'test_f.sh': 70, 'test_g.mjs': 45, 'test_h.sh': 30, 'test_i.mjs': 5, 'test_j.mjs': 1 };
const names = Object.keys(secs);
const p = plan(names, secs, 3);
t('AC2 every suite is in exactly one shard', every(p), [...names].sort());
t('AC2 three shards', p.shards.map((x) => x.shard), [1, 2, 3]);
t('AC2 each shard predicts the sum of its suites', p.shards.map((x) => x.seconds === x.suites.reduce((s, n) => s + secs[n], 0)), [true, true, true]);
t('AC2 the slowest shard is within the even split plus the longest suite', [p.total, p.longest, slowest(p) <= bound(p)], [1206, 370, true]);
t('AC2 longest first into the least-loaded shard', p.shards.map((x) => x.suites), [['test_a.sh', 'test_g.mjs'], ['test_b.sh', 'test_f.sh', 'test_i.mjs', 'test_j.mjs'], ['test_c.sh', 'test_d.mjs', 'test_e.mjs', 'test_h.sh']]);
const lines = describe(p).split('\n');
t('AC2 the log names each shard, its predicted minutes and its suites', lines.slice(1), ['shard 1/3: 6.9 min predicted: test_a.sh test_g.mjs', 'shard 2/3: 6.4 min predicted: test_b.sh test_f.sh test_i.mjs test_j.mjs', 'shard 3/3: 6.8 min predicted: test_c.sh test_d.mjs test_e.mjs test_h.sh']);
t('AC2 and the totals it was planned against', lines[0], '3 shard(s), 20.1 min in all, even split 6.7 min, longest suite 6.2 min');
// A skewed set where one suite is most of the run: the bound still holds.
const skew = { 'test_big.sh': 1000, ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`test_s${i}.sh`, i + 1])) };
for (const n of [2, 6, 8]) { const q = plan(Object.keys(skew), skew, n); t(`AC2 bound holds at ${n} shards on a skewed set`, slowest(q) <= bound(q), true); }

// ---- AC3: a suite with no recorded duration ------------------------------------------------------
const q = plan([...names, 'test_new.sh'], secs, 3);
t('AC3 a suite with no duration is still planned', every(q).includes('test_new.sh'), true);
t('AC3 at the median recorded duration, and named', [q.guess, q.unknown], [median(Object.values(secs)), ['test_new.sh']]);
t('AC3 the log says which suites had no duration', describe(q).split('\n').at(-1), 'no recorded duration, planned at 1.3 min each: test_new.sh');
const none = plan(['test_x.sh', 'test_y.sh'], {}, 6);
t('AC3 with no durations at all, every suite still runs', [none.shards.length, every(none)], [2, ['test_x.sh', 'test_y.sh']]);

// ---- AC4: a few suites ---------------------------------------------------------------------------
const few = plan(['test_c.sh', 'test_j.mjs'], secs, 6);
t('AC4 fewer suites than shards gives one shard per suite', few.shards.map((x) => x.suites), [['test_c.sh'], ['test_j.mjs']]);
t('a suite named twice runs once', every(plan(['test_c.sh', 'test_c.sh'], secs, 6)), ['test_c.sh']);
t('no suites gives no shards', plan([], secs, 6).shards.length, 0);
t('the matrix: shard, of, suites and the one shard that runs the hook self-test', matrix(few), { include: [{ shard: 1, of: 2, suites: 'test_c.sh', hook: true }, { shard: 2, of: 2, suites: 'test_j.mjs', hook: false }] });

// ---- a run's log -> durations --------------------------------------------------------------------
const log = [
  'shard 1/2\tRun tests\t2026-11-16T05:11:22.9670553Z == attribution hook self-test',
  'shard 1/2\tRun tests\t2026-11-16T05:11:24.2809089Z == alpha (first)',
  'shard 2/2\tRun tests\t2026-11-16T05:11:25.0000000Z == gamma',
  'shard 1/2\tRun tests\t2026-11-16T05:11:30.0000000Z ok  something == not a start',
  'shard 1/2\tRun tests\t2026-11-16T05:12:46.8834522Z == beta',
  'shard 2/2\tRun tests\t2026-11-16T05:13:05.4000000Z FAILURES above (3 checks passed)',
  'shard 1/2\tRun tests\t2026-11-16T05:12:56.5134509Z all passed: 9 checks',
].join('\n');
const labels = new Map([['alpha (first)', 'test_alpha.sh'], ['beta', 'test_beta.mjs'], ['gamma', 'test_gamma.sh']]);
const got = durationsFromLog(log, (l) => labels.get(l));
t('a log gives each suite its seconds, job by job', got.seconds, { 'test_alpha.sh': 83, 'test_gamma.sh': 100, 'test_beta.mjs': 10 });
t('a label no suite has is reported', got.unmatched, ['attribution hook self-test']);
const par = [
  'shard 1/1\tRun tests\t2026-11-16T05:15:00.0000000Z == alpha (first)',
  'shard 1/1\tRun tests\t2026-11-16T05:15:00.0000000Z ok: 4',
  'shard 1/1\tRun tests\t2026-11-16T05:15:00.0000000Z took: 140 s',
  'shard 1/1\tRun tests\t2026-11-16T05:15:01.0000000Z == beta',
  'shard 1/1\tRun tests\t2026-11-16T05:15:01.0000000Z took: 0 s',
  'shard 1/1\tRun tests\t2026-11-16T05:15:01.0000000Z all passed: 9 checks',
].join('\n');
t('a run.sh -j log gives each suite its own took: seconds, not the gap between reports', durationsFromLog(par, (l) => labels.get(l)).seconds, { 'test_alpha.sh': 140, 'test_beta.mjs': 1 });
t('one job\'s raw log reads too',durationsFromLog('2026-11-16T05:11:24Z == beta\n2026-11-16T05:11:24.2Z all passed: 1 checks', (l) => labels.get(l)).seconds, { 'test_beta.mjs': 1 });

// ---- this repo -----------------------------------------------------------------------------------
const suites = repoMap(R).suites.map((s) => s.file);
const rec = readDurations();
t('the recorded durations name only suites that exist', Object.keys(rec).filter((k) => !suites.includes(k)), []);
const real = plan(suites, rec, SHARDS);
t('AC1 every suite, once, in 6 to 8 shards', [SHARDS >= 6 && SHARDS <= 8, real.shards.length, every(real).length, new Set(every(real)).size], [true, SHARDS, suites.length, suites.length]);
t('AC2 the repo plan is within the bound', slowest(real) <= bound(real), true);
const cli = (...a) => spawnSync(process.execPath, [join(R, 'tests/plan_shards.mjs'), ...a], { encoding: 'utf8' });
const T = scratch('desk-shards-');
try {
  const out = join(T, 'out');
  writeFileSync(out, '');
  const gh = spawnSync(process.execPath, [join(R, 'tests/plan_shards.mjs'), '--suites', 'test_lint.sh tests/test_batch_e2e.sh', '--github-output'], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out } });
  const m = JSON.parse(readFileSync(out, 'utf8').replace(/^matrix=/, ''));
  t('cli --github-output prints the plan and writes the matrix', [gh.status, /^shard 1\/2: .* predicted: test_batch_e2e\.sh$/m.test(gh.stdout), m.include.map((x) => x.suites)], [0, true, ['test_batch_e2e.sh', 'test_lint.sh']]);
  const whole = JSON.parse(cli('--json').stdout);
  t('cli with no flags plans every suite into SHARDS shards', [whole.shards.length, whole.shards.flatMap((x) => x.suites).length], [SHARDS, suites.length]);
  t('cli --shards overrides the count', JSON.parse(cli('--shards', '2', '--json').stdout).shards.length, 2);
  t('cli refuses a name that is no suite, no suites, or a bad count', [cli('--suites', 'test_nope.sh').status, cli('--suites', '').status, cli('--shards', '0', '--suites', 'test_lint.sh').status], [2, 2, 2]);

  // ---- tests/run.sh's flag for every shard but the first ------------------------------------------
  const run = spawnSync('bash', [join(R, 'tests/run.sh'), '--no-hook-test', 'test_review_verdict.mjs'], { encoding: 'utf8' });
  t('run.sh --no-hook-test runs the named suite without the hook self-test', [run.status, (run.stdout.match(/^== /gm) ?? []).length, /attribution hook/.test(run.stdout)], [0, 1, false]);

  // ---- tests/run.sh -j: suites at once -----------------------------------------------------------
  // A copy of run.sh with three suites that log their start and end. With MEET set, test_a.sh passes
  // only if test_c.sh starts while it is still running; test_b.sh fails.
  const S = join(T, 'repo', 'tests'); mkdirSync(S, { recursive: true });
  for (const f of ['run.sh', 'suite_env.sh']) writeFileSync(join(S, f), readFileSync(join(R, 'tests', f)));
  const log = (x, body) => writeFileSync(join(S, `test_${x}.sh`), `echo "start ${x}" >> "$LOG"\n${body}\necho "end ${x}" >> "$LOG"\n`);
  log('a', 'echo "ok a1"\nif [ -n "${MEET:-}" ]; then i=0; while [ ! -f "$MEET/c" ] && [ $i -lt 150 ]; do sleep 0.1; i=$((i + 1)); done\n  if [ -f "$MEET/c" ]; then echo "ok a met c"; else echo "FAIL a ran alone"; fi; fi\necho "ok a2"');
  log('b', 'echo "ok b1"; echo "FAIL b broke"; echo "b says why"');
  log('c', '[ -z "${MEET:-}" ] || : > "$MEET/c"; echo "ok c1"');
  const runJ = (args, meet) => {
    const L = join(T, `log-${args.join('')}`); writeFileSync(L, '');
    const env = { ...process.env, LOG: L, ...(meet ? { MEET: mkdtempSync(join(T, 'meet-')) } : {}) };
    const r = spawnSync('bash', [join(S, 'run.sh'), '--no-hook-test', ...args], { encoding: 'utf8', env });
    const blocks = Object.fromEntries(r.stdout.split(/\n(?=== )/).slice(1).map((b) => [b.split('\n')[0].slice(3), b]));
    return { ...r, blocks, log: readFileSync(L, 'utf8').trim().split('\n') };
  };
  const j3 = runJ(['-j', '3'], true);
  t('AC1 run.sh -j 3 runs the suites at once', [/ok: 3\n/.test(j3.blocks['test_a.sh'] ?? ''), j3.log.indexOf('start c') < j3.log.indexOf('end a')], [true, true]);
  t('AC1 and reports each in one piece, in name order', [Object.keys(j3.blocks), /FAIL b broke\nb says why/.test(j3.blocks['test_b.sh'] ?? ''), /b says why/.test(j3.blocks['test_a.sh'] + j3.blocks['test_c.sh'])], [['test_a.sh', 'test_b.sh', 'test_c.sh'], true, false]);
  t('AC1 a failure still fails the run and names its suite', [j3.status, /^failed suites: test_b\.sh$/m.test(j3.stdout), /^FAILURES above \(5 checks passed\)$/m.test(j3.stdout)], [1, true, true]);
  const j1 = runJ(['-j', '1'], false);
  t('AC2 run.sh -j 1 runs them one after another, in the same order', [j1.log, Object.keys(j1.blocks), j1.status, /^failed suites: test_b\.sh$/m.test(j1.stdout)], [['start a', 'end a', 'start b', 'end b', 'start c', 'end c'], ['test_a.sh', 'test_b.sh', 'test_c.sh'], 1, true]);
  t('-j takes -jN too, and refuses a count that is not a whole number from 1', [runJ(['-j2', 'test_c.sh'], false).status, ...['0', 'x', ''].map((n) => spawnSync('bash', [join(S, 'run.sh'), '-j', n], { encoding: 'utf8' }).status)], [0, 2, 2, 2]);
  // A TERM to run.sh -j stops the running suites before run.sh exits: a lock held around it is never
  // released while a suite still runs. test_slow.sh writes its pid, then runs for up to 10 s.
  const S2 = join(T, 'stop', 'tests'); mkdirSync(S2, { recursive: true });
  for (const f of ['run.sh', 'suite_env.sh']) writeFileSync(join(S2, f), readFileSync(join(R, 'tests', f)));
  writeFileSync(join(S2, 'test_slow.sh'), 'echo $$ > "$PIDF"; i=0; while [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done; echo "ok slow"\n');
  const pidf = join(T, 'slow.pid');
  const stop = spawnSync('bash', ['-c', 'bash "$1" --no-hook-test -j 2 test_slow.sh >/dev/null & r=$!; i=0; while [ ! -s "$PIDF" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done; kill -TERM $r; wait $r; echo "rc $?"; if kill -0 "$(cat "$PIDF")" 2>/dev/null; then echo "suite alive"; else echo "suite gone"; fi', 'stop', join(S2, 'run.sh')], { encoding: 'utf8', env: { ...process.env, PIDF: pidf } });
  t('a TERM to run.sh -j stops its running suite before run.sh exits', stop.stdout.trim().split('\n'), ['rc 143', 'suite gone']);
} finally { rmSync(T, { recursive: true, force: true }); }

console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
