// Splits tests/run.sh's suites into the tests workflow's parallel shards, balanced by each suite's
// recorded duration in tests/suite_durations.json. This is the one place the shard layout comes from,
// its shard count (SHARDS) included, so a later workflow that reads it gets the layout tests ran.
//
// Longest suite first, each into the shard with the least predicted time so far, so the slowest shard
// predicts no more than the even split plus the longest single suite. A suite with no recorded
// duration (one added since the last refresh) is planned at the median recorded duration.
//
// CLI (from anywhere in the repo):
//   node tests/plan_shards.mjs [--shards <n>] [--suites '<test_a.sh test_b.mjs ...>'] [--json | --github-output]
//     plans the named suites (every suite without --suites) into at most n shards (SHARDS without
//     --shards) and prints each
//     shard's suites and predicted minutes; --github-output appends matrix= to $GITHUB_OUTPUT, one
//     entry per shard: { shard, of, suites, hook }, where hook is the shard that also runs run.sh's
//     attribution hook self-test.
//   node tests/plan_shards.mjs --order <suite>...
//     prints the named suites one per line in the order shards are planned in (longestFirst), which
//     tests/run.sh starts them in.
//   gh run view <run id> --log | node tests/plan_shards.mjs --record
//     refreshes tests/suite_durations.json from a tests run's log: a suite's seconds are its
//     `took: <s> s` line, or, in a log without one, run from its `== <label>` line to the next line
//     of that job that starts a suite or ends the run.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoMap } from './scope_sections.mjs';

// The number of CI runners the suites are spread over; tests/test_plan_shards.mjs holds it to 6 to 8.
export const SHARDS = 6;
export const DURATIONS = join(dirname(fileURLToPath(import.meta.url)), 'suite_durations.json');

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// The suites longest recorded first, name order between equals, a suite with no recorded duration
// at the median. Shards are planned in this order, and tests/run.sh starts its suites in it.
// -> { order, cost, guess, known }
export function longestFirst(suites, seconds) {
  const names = [...new Set(suites)];
  const known = (s) => Number.isFinite(seconds[s]) && seconds[s] >= 0;
  const guess = median(names.filter(known).map((s) => seconds[s])) || median(Object.values(seconds).filter(Number.isFinite)) || 60;
  const cost = (s) => (known(s) ? seconds[s] : guess);
  return { order: names.sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0)), cost, guess, known };
}

// -> { shards: [{ shard, suites, seconds }], total, longest, guess, unknown }
export function plan(suites, seconds, n) {
  const { order, cost, guess, known } = longestFirst(suites, seconds);
  const count = Math.max(0, Math.min(Math.floor(n) || 1, order.length));
  const shards = Array.from({ length: count }, (_, i) => ({ shard: i + 1, suites: [], seconds: 0 }));
  for (const s of order) {
    const least = shards.reduce((m, x) => (x.seconds < m.seconds ? x : m));
    least.suites.push(s);
    least.seconds += cost(s);
  }
  for (const x of shards) x.suites.sort();
  const total = order.reduce((sum, s) => sum + cost(s), 0);
  return { shards, total, longest: order.length ? cost(order[0]) : 0, guess, unknown: order.filter((s) => !known(s)).sort() };
}

export const matrix = (p) => ({ include: p.shards.map((x) => ({ shard: x.shard, of: p.shards.length, suites: x.suites.join(' '), hook: x.shard === 1 })) });

const min = (s) => (s / 60).toFixed(1);
export function describe(p) {
  const lines = [`${p.shards.length} shard(s), ${min(p.total)} min in all, even split ${min(p.total / (p.shards.length || 1))} min, longest suite ${min(p.longest)} min`];
  for (const x of p.shards) lines.push(`shard ${x.shard}/${p.shards.length}: ${min(x.seconds)} min predicted: ${x.suites.join(' ')}`);
  if (p.unknown.length) lines.push(`no recorded duration, planned at ${min(p.guess)} min each: ${p.unknown.join(' ')}`);
  return lines.join('\n');
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
  if (!Number.isInteger(n) || n < 1) { console.error('usage: plan_shards.mjs [--shards <n>] [--suites \'<suite> ...\'] [--json | --github-output] | --record < log'); process.exit(2); }
  const names = args.includes('--suites') ? (opt('--suites') ?? '').split(/\s+/).filter(Boolean).map((s) => s.replace(/^.*\//, '')) : all.map((s) => s.file);
  const bad = names.filter((s) => !all.some((x) => x.file === s));
  if (bad.length) { console.error(`not a suite: ${bad.join(' ')}`); process.exit(2); }
  if (!names.length) { console.error('no suites to plan'); process.exit(2); }
  const p = plan(names, readDurations(), n);
  if (args.includes('--json')) console.log(JSON.stringify({ ...p, matrix: matrix(p) }, null, 2));
  else console.log(describe(p));
  if (args.includes('--github-output')) {
    const out = process.env.GITHUB_OUTPUT;
    if (!out || !existsSync(dirname(out))) { console.error('GITHUB_OUTPUT is not set'); process.exit(2); }
    appendFileSync(out, `matrix=${JSON.stringify(matrix(p))}\n`);
  }
}
