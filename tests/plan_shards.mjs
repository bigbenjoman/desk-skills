// Splits tests/run.sh's suites into the tests workflow's parallel shards, balanced by each suite's
// recorded duration. This is the one place the shard layout comes from, its shard count (SHARDS)
// included, so a later workflow that reads it gets the layout tests ran.
//
// The durations are those main's latest push run recorded (its suite-durations artifact), or, where
// none can be fetched, the committed tests/suite_durations.json. A shard that runs j suites at once
// is j lanes: longest suite first, each into the lane with the least predicted time so far, and lane
// i into shard i mod n, so the n longest suites land in different shards. A shard predicts its
// slowest lane, which is no more than the even split over every lane plus the longest single suite.
// A suite with no recorded duration (one added since) is planned at the 75th percentile of the
// recorded ones.
//
// CLI (from anywhere in the repo):
//   node tests/plan_shards.mjs [--shards <n>] [--jobs <j>] [--durations <file>] [--suites '<test_a.sh ...>'] [--json | --github-output]
//     plans the named suites (every suite without --suites) into at most n shards (SHARDS without
//     --shards) of j lanes each (1 without --jobs), from the durations in <file> where it can be read
//     (else the committed file, saying so), and prints each shard's suites and predicted minutes;
//     --github-output appends matrix= to $GITHUB_OUTPUT, one entry per shard: { shard, of, suites,
//     hook }, where hook is the shard that also runs run.sh's attribution hook self-test.
//   node tests/plan_shards.mjs --order <suite>...
//     prints the named suites one per line in the order shards are planned in (longestFirst), which
//     tests/run.sh starts them in.
//   node tests/plan_shards.mjs --fetch <dir>
//     saves the suite-durations artifact of the newest push run on main that has one into <dir>
//     (gh, with GH_REPO set); says so, and still exits 0, when none of the last FETCH_RUNS runs has one.
//   node tests/plan_shards.mjs --merge <dir> --of <n> --out <file>
//     merges the durations-<k>.json files run.sh wrote (DESK_SUITE_DURATIONS) for shards 1 to n
//     in <dir> into <file>, as { seconds, cpu }; writes nothing when a shard has none.
//   gh run view <run id> --log | node tests/plan_shards.mjs --record
//     refreshes tests/suite_durations.json from a tests run's log: a suite's seconds are its
//     `took: <s> s` line, or, in a log without one, run from its `== <label>` line to the next line
//     of that job that starts a suite or ends the run.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repoMap } from './scope_sections.mjs';
import { quantile } from '../desk/bin/quantile.mjs';

// The number of CI runners the suites are spread over; tests/test_plan_shards.mjs holds it to 6 to 8.
export const SHARDS = 6;
export const DURATIONS = join(dirname(fileURLToPath(import.meta.url)), 'suite_durations.json');
// The artifact a push run on main uploads its suites' durations in, and how many runs back to look.
export const ARTIFACT = 'suite-durations';
export const FETCH_RUNS = 10;

// The suites longest recorded first, name order between equals, a suite with no recorded duration
// at the 75th percentile of the recorded ones. Shards are planned in this order, and tests/run.sh
// starts its suites in it by the committed durations (--order), which may differ from the ones a CI
// plan read. -> { order, cost, guess, known }
export function longestFirst(suites, seconds) {
  const names = [...new Set(suites)];
  const valid = (v) => Number.isFinite(v) && v >= 0;
  const known = (s) => valid(seconds[s]);
  const guess = quantile(Object.values(seconds).filter(valid), 0.75) || 60;
  const cost = (s) => (known(s) ? seconds[s] : guess);
  return { order: names.sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0)), cost, guess, known };
}

// -> { shards: [{ shard, suites, seconds }], lanes, total, longest, guess, unknown }
export function plan(suites, seconds, n, jobs = 1) {
  const { order, cost, guess, known } = longestFirst(suites, seconds);
  const count = Math.max(0, Math.min(Math.floor(n) || 1, order.length));
  const lanes = Array.from({ length: count * Math.max(1, Math.floor(jobs) || 1) }, () => ({ suites: [], seconds: 0 }));
  for (const s of order) {
    // Between equal times the lane with fewer suites, so suites recorded at 0 s still fill every shard.
    const least = lanes.reduce((m, x) => (x.seconds < m.seconds || (x.seconds === m.seconds && x.suites.length < m.suites.length) ? x : m));
    least.suites.push(s);
    least.seconds += cost(s);
  }
  const shards = Array.from({ length: count }, (_, i) => {
    const mine = lanes.filter((_, l) => l % count === i);
    return { shard: i + 1, suites: mine.flatMap((x) => x.suites).sort(), seconds: Math.max(...mine.map((x) => x.seconds)) };
  });
  const total = order.reduce((sum, s) => sum + cost(s), 0);
  return { shards, lanes: lanes.length, total, longest: order.length ? cost(order[0]) : 0, guess, unknown: order.filter((s) => !known(s)).sort() };
}

export const matrix = (p) => ({ include: p.shards.map((x) => ({ shard: x.shard, of: p.shards.length, suites: x.suites.join(' '), hook: x.shard === 1 })) });

const min = (s) => (s / 60).toFixed(1);
export function describe(p) {
  const per = p.lanes > p.shards.length ? ` of ${p.lanes / p.shards.length} lanes each` : '';
  const lines = [`${p.shards.length} shard(s)${per}, ${min(p.total)} min in all, even split ${min(p.total / (p.lanes || 1))} min, longest suite ${min(p.longest)} min`];
  for (const x of p.shards) lines.push(`shard ${x.shard}/${p.shards.length}: ${min(x.seconds)} min predicted: ${x.suites.join(' ')}`);
  if (p.unknown.length) lines.push(`no recorded duration, planned at ${min(p.guess)} min each: ${p.unknown.join(' ')}`);
  return lines.join('\n');
}

// The durations a plan reads: <file>'s where it holds any, else the committed file's. -> { seconds, from }
export function chooseDurations(file, committed = DURATIONS) {
  if (file) {
    try {
      const seconds = JSON.parse(readFileSync(file, 'utf8')).seconds;
      if (seconds && typeof seconds === 'object' && Object.keys(seconds).length) return { seconds, from: `main's ${ARTIFACT} artifact (${Object.keys(seconds).length} suites)` };
    } catch { /* not fetched, or unreadable */ }
  }
  return { seconds: readDurations(committed), from: `the committed tests/suite_durations.json${file ? `: no ${ARTIFACT} artifact from main could be fetched` : ''}` };
}

// Shards 1 to n's durations files in <dir> -> { seconds, cpu }, or { missing: [k] } when any shard has none.
export function mergeDurations(dir, n) {
  const seconds = {}; const cpu = {}; const missing = [];
  for (let k = 1; k <= n; k++) {
    let d;
    try { d = JSON.parse(readFileSync(join(dir, `durations-${k}.json`), 'utf8')); } catch { missing.push(k); continue; }
    Object.assign(seconds, d.seconds); Object.assign(cpu, d.cpu);
  }
  if (missing.length) return { missing };
  const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  return { seconds: sorted(seconds), cpu: sorted(cpu) };
}

// Saves the artifact of the newest push run on main that has one into dir. -> the run id, or null.
export function fetchDurations(dir, gh) {
  const runs = JSON.parse(gh(['run', 'list', '--workflow', 'tests.yml', '--branch', 'main', '--event', 'push', '--status', 'completed', '--limit', String(FETCH_RUNS), '--json', 'databaseId']));
  for (const r of runs) {
    try { gh(['run', 'download', String(r.databaseId), '--name', ARTIFACT, '--dir', dir]); return r.databaseId; } catch { /* that run has none */ }
  }
  return null;
}

// A run's log, as `gh run view --log` prints it (`<job>\t<step>\t<timestamp> <text>`) or as one job's
// raw log (`<timestamp> <text>`) -> { seconds: { file: s }, unmatched: [label] }.
export function durationsFromLog(text, fileOf) {
  const open = new Map();
  const seconds = {};
  const unmatched = new Set();
  for (const line of String(text).split('\n')) {
    const f = line.split('\t');
    const m = f.at(-1).match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z (.*)$/);
    if (!m) continue;
    const job = f.length > 1 ? f[0] : '';
    const at = Date.parse(`${m[1]}${(m[2] ?? '').slice(0, 4)}Z`);
    const start = m[3].match(/^== (.+)$/);
    const took = m[3].match(/^took: (\d+) s$/);
    if (took) { const cur = open.get(job); if (cur) cur.took = Number(took[1]); continue; }
    if (!start && !/^(all passed: |FAILURES above)/.test(m[3])) continue;
    const cur = open.get(job);
    if (cur) {
      const file = fileOf(cur.label);
      if (file) seconds[file] = Math.max(1, cur.took ?? Math.round((at - cur.at) / 1000));
      else unmatched.add(cur.label);
    }
    if (start) open.set(job, { label: start[1].trim(), at });
    else open.delete(job);
  }
  return { seconds, unmatched: [...unmatched] };
}

export const readDurations = (path = DURATIONS) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).seconds ?? {} : {});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args[0] === '--order') { console.log(longestFirst(args.slice(1), readDurations()).order.join('\n')); process.exit(0); }
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  if (args[0] === '--fetch') {
    const dir = opt('--fetch');
    if (!dir) { console.error('usage: plan_shards.mjs --fetch <dir>'); process.exit(2); }
    mkdirSync(dir, { recursive: true });
    const gh = (a) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    let id = null;
    try { id = fetchDurations(dir, gh); } catch (e) { console.log(`could not list main's runs: ${String(e.stderr || e.message).trim().split('\n')[0]}`); }
    // None is not a failure: the plan then reads the committed file and says so.
    console.log(id ? `fetched the ${ARTIFACT} artifact of run ${id} on main` : `no ${ARTIFACT} artifact in the last ${FETCH_RUNS} push runs on main`);
    process.exit(0);
  }
  if (args[0] === '--merge') {
    const dir = opt('--merge'); const n = Number(opt('--of')); const out = opt('--out');
    if (!dir || !out || !Number.isInteger(n) || n < 1) { console.error('usage: plan_shards.mjs --merge <dir> --of <n> --out <file>'); process.exit(2); }
    const m = mergeDurations(dir, n);
    if (m.missing) { console.log(`no durations from shard(s) ${m.missing.join(' ')} of ${n}: nothing recorded`); process.exit(0); }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(m, null, 2)}\n`);
    console.log(`recorded ${Object.keys(m.seconds).length} suite(s) from ${n} shard(s) in ${out}`);
    process.exit(0);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const all = repoMap(root).suites;
  if (args.includes('--record')) {
    const byLabel = new Map(all.map((s) => [s.label, s.file]));
    const got = durationsFromLog(readFileSync(0, 'utf8'), (l) => byLabel.get(l));
    for (const l of got.unmatched) if (l !== 'attribution hook self-test') console.error(`no suite is labelled: ${l}`);
    const files = new Set(all.map((s) => s.file));
    const merged = { ...readDurations(), ...got.seconds };
    const seconds = Object.fromEntries(Object.keys(merged).filter((k) => files.has(k)).sort().map((k) => [k, merged[k]]));
    writeFileSync(DURATIONS, `${JSON.stringify({ seconds }, null, 2)}\n`);
    console.log(`recorded ${Object.keys(got.seconds).length} suite(s); ${Object.keys(seconds).length} in ${DURATIONS}`);
    process.exit(0);
  }
  const n = args.includes('--shards') ? Number(opt('--shards')) : SHARDS;
  const j = args.includes('--jobs') ? Number(opt('--jobs')) : 1;
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(j) || j < 1) { console.error('usage: plan_shards.mjs [--shards <n>] [--jobs <j>] [--durations <file>] [--suites \'<suite> ...\'] [--json | --github-output] | --order <suite>... | --fetch <dir> | --merge <dir> --of <n> --out <file> | --record < log'); process.exit(2); }
  const names = args.includes('--suites') ? (opt('--suites') ?? '').split(/\s+/).filter(Boolean).map((s) => s.replace(/^.*\//, '')) : all.map((s) => s.file);
  const bad = names.filter((s) => !all.some((x) => x.file === s));
  if (bad.length) { console.error(`not a suite: ${bad.join(' ')}`); process.exit(2); }
  if (!names.length) { console.error('no suites to plan'); process.exit(2); }
  const d = chooseDurations(args.includes('--durations') ? opt('--durations') : null);
  const p = plan(names, d.seconds, n, j);
  if (args.includes('--json')) console.log(JSON.stringify({ ...p, from: d.from, matrix: matrix(p) }, null, 2));
  else console.log(`planned from ${d.from}\n${describe(p)}`);
  if (args.includes('--github-output')) {
    const out = process.env.GITHUB_OUTPUT;
    if (!out || !existsSync(dirname(out))) { console.error('GITHUB_OUTPUT is not set'); process.exit(2); }
    appendFileSync(out, `matrix=${JSON.stringify(matrix(p))}\n`);
  }
}
