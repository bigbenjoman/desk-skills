// The two halves of tests/compare_pass.sh, which runs one shell suite against two trees and lists
// every difference in what pass.mjs did.
//
//   node compare_pass.mjs record <node args...>
//     What the `node` shim runs in place of the real node when its argv names pass.mjs: runs the real
//     node ($PASS_CMP_NODE) with the same arguments, passing its stdin, stdout, stderr and exit status
//     through unchanged, then saves run <n>.json in $PASS_CMP_OUT: when the run started, the exit
//     status, stdout and stderr as they arrived, the queue at $DESK_QUEUE and the archive beside it,
//     and how many lines the suite had printed to $PASS_CMP_SUITE_LOG when the run started.
//
//   node compare_pass.mjs diff <base records> <head records> <base tree> <head tree>
//     Lists, per suite and run, every queue field and output line that differs once ids and paths
//     that change between runs are normalized and times are matched across the trees; and every run
//     that only one tree recorded, or that crashed on only one, as not compared. Exit 0 when nothing
//     differs, 1 on a difference, 2 when anything was not compared.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { lock, unlock } from '../desk/bin/dir-lock.mjs';

const [mode, ...args] = process.argv.slice(2);

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const lineCount = (f) => { try { return readFileSync(f, 'utf8').split('\n').length - 1; } catch { return 0; } };

// Run numbers are taken under a directory lock, so two passes a suite starts together get one each.
function nextRun(dir) {
  const held = join(dir, '.lock');
  lock(held);
  try {
    const f = join(dir, '.next');
    const n = Number(existsSync(f) ? readFileSync(f, 'utf8') : 0) + 1;
    writeFileSync(f, String(n));
    return n;
  } finally { unlock(held); }
}

function record(argv) {
  const dir = process.env.PASS_CMP_OUT;
  mkdirSync(dir, { recursive: true });
  const run = nextRun(dir);
  const started = Date.now();
  const atLine = lineCount(process.env.PASS_CMP_SUITE_LOG);
  const chunks = [];
  const child = spawn(process.env.PASS_CMP_NODE, argv, { stdio: ['inherit', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { chunks.push(d); process.stdout.write(d); });
  child.stderr.on('data', (d) => { chunks.push(d); process.stderr.write(d); });
  child.on('error', (e) => { chunks.push(Buffer.from(`compare_pass: could not start node: ${e.message}\n`)); });
  // A suite that stops its pass stops the pass, not just this wrapper.
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => child.kill(s));
  child.on('close', (code, signal) => {
    const q = process.env.DESK_QUEUE;
    writeFileSync(join(dir, `${run}.json`), JSON.stringify({
      run, started, at_line: atLine, exit: code, signal, out: Buffer.concat(chunks).toString('utf8'),
      queue: q ? readJson(q) : null, archive: q ? readJson(q.replace(/\.json$/, '') + '.archive.json') : null,
    }));
    // The pass died by a signal: die by it too, so the suite sees the status it would without the shim.
    // A signal node ignores still ends it with the shell's status for that signal.
    process.exitCode = signal ? 128 + (constants.signals[signal] || 0) : code ?? 1;
    if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
  });
}

// --- diff ---

// An ISO time, a time to the minute in UTC as the pass prints one, or epoch seconds or milliseconds.
const TIME = /\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?|\b\d{4}-\d\d-\d\d \d\d:\d\d UTC\b|\b1\d{9}(?:\d{3})?\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TMP = /(?:\/private)?(?:\/var\/folders\/[^/\s"']+\/[^/\s"']+\/T|\/tmp)\/(?:tmp\.)?[A-Za-z0-9._-]*[A-Za-z0-9]{6,}/g;
// The machine's memory as the pass read it, a process id, and a repo slug hashed from its scratch path.
const MEM = /\b((?:vmmem|avail|rss)=)[0-9.]+[KMGT]?i?B?|\b[0-9.]+[KMGT]i?B?(?= available\b)/g;
const PID = /\b(pid:? |"pid":\s*)\d+/g;
const SLUG = /\b(local__[\w.-]*?)-[0-9a-f]{8}\b/g;

// Two runs of the same tree differ in their scratch paths and in the ids they make up, so each is
// replaced by a placeholder. Times are matched across the trees instead (sameTime).
function normalizer(roots) {
  const reps = [...new Set(roots.flatMap((r) => { try { return [r, realpathSync(r)]; } catch { return [r]; } }))]
    .sort((a, b) => b.length - a.length);
  return (s) => {
    for (const r of reps) s = s.split(r).join('<TREE>');
    return s
      .replace(UUID, '<UUID>')
      .replace(TMP, '<TMP>')
      .replace(MEM, (_, key) => `${key || ''}<MEM>`)
      .replace(PID, '$1<PID>')
      .replace(SLUG, '$1-<HASH>');
  };
}

// Each tree makes its own commits, whose SHAs differ with the second they were made in, so each SHA,
// whole or abbreviated, is named by the order it first appears in within one run: the same commit at
// the same step reads alike. Per run, not per suite: two commits a tree made in the same second can
// share a SHA there and not on the other tree, which would shift every later run's names.
const SHA = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g;
function renamer() {
  const seen = new Map();
  return (s) => s.replace(SHA, (x) => { if (!seen.has(x)) seen.set(x, `<SHA${seen.size + 1}>`); return seen.get(x); });
}

// A normalized string split into its shape, each time in it as <TIME>, and those times.
const SLACK = 15_000;
const ms = (t) => (/^\d+$/.test(t) ? Number(t) * (t.length === 10 ? 1000 : 1) : Date.parse(t.replace(/ (\d\d:\d\d) UTC$/, 'T$1Z')));
// A time printed to the minute is up to a minute short of the time it stands for.
const slack = (t) => (/ UTC$/.test(t) ? SLACK + 60_000 : SLACK);
function timed(text) {
  const times = [];
  return { text, times, shape: text.replace(TIME, (t) => { times.push(t); return '<TIME>'; }) };
}

// When a tree's runs of one suite started, to find the run a time was made in or worked out for.
function clock(recs) {
  const starts = [...recs.values()].filter((r) => Number.isFinite(r.started)).map((r) => [r.started, r.run])
    .sort((a, b) => a[0] - b[0]);
  return {
    start: (n) => recs.get(n)?.started,
    // The runs that started around t: the last to start before it, and its neighbours.
    around(t) {
      let lo = 0, hi = starts.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid][0] <= t + SLACK) lo = mid + 1; else hi = mid; }
      return starts.slice(Math.max(0, lo - 3), lo + 1).map(([, n]) => n);
    },
  };
}

// Two times match when they are the same, a few seconds apart, or the same offset from the start of
// one run on each tree: a time a run made, or one its suite worked out just before it, sits there
// however far apart the two trees ran. A time worked out differently (an hour on, not two) does not.
function sameTime(a, b, run, cb, ch) {
  if (a === b) return true;
  const ta = ms(a), tb = ms(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  const within = Math.max(slack(a), slack(b));
  if (Math.abs(ta - tb) <= within) return true;
  for (const j of new Set([run, ...cb.around(ta), ...ch.around(tb)])) {
    if (j > run) continue;
    const sb = cb.start(j), sh = ch.start(j);
    if (sb != null && sh != null && Math.abs((ta - sb) - (tb - sh)) <= within) return true;
  }
  return false;
}
const same = (x, y, run, cb, ch) => x.shape === y.shape && x.times.every((t, i) => sameTime(t, y.times[i], run, cb, ch));
// A value or line is shown by its shape, unless only its times differ from the other side's: then
// with its times, so both values show.
const show = (x, others) => (others.some((y) => y.shape === x.shape) ? x.text : x.shape);

// "T-1 state" for a ticket's field, "archive T-1 state" in the archive, "queue <path>" otherwise.
function flatten(rec, norm) {
  const out = new Map();
  const walk = (v, path) => {
    if (v && typeof v === 'object' && Object.keys(v).length) {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    } else out.set(path, norm(JSON.stringify(v)));
  };
  const top = (doc, prefix) => {
    if (!doc) return;
    for (const [k, v] of Object.entries(doc)) {
      if (k === 'tickets' && v && typeof v === 'object') {
        for (const [t, x] of Object.entries(v)) {
          if (x && typeof x === 'object') for (const [f, y] of Object.entries(x)) walk(y, `${prefix}${t} ${f}`);
          else out.set(`${prefix}${t}`, norm(JSON.stringify(x)));
        }
      } else walk(v, `${prefix || 'queue '}${k}`);
    }
  };
  top(rec.queue, '');
  top(rec.archive, 'archive ');
  return out;
}

const crashed = (r) => r.signal || (r.exit !== 0 && /^Node\.js v\d+/m.test(r.out));
const firstError = (r) => (r.signal ? `killed by ${r.signal}`
  : (r.out.split('\n').find((l) => /^\w*Error\b/.test(l)) || `exit ${r.exit}`).trim());

// The suite's own log names the check that follows each run, so a difference says where it is.
function labeller(log) {
  let lines = [];
  try { lines = readFileSync(log, 'utf8').split('\n'); } catch { /* no log: no label */ }
  return (at) => {
    const l = lines.slice(at).find((x) => /^(ok|FAIL) /.test(x));
    return l ? ` (before: ${l.replace(/^(ok|FAIL) +/, '')})` : '';
  };
}

function runs(dir) {
  const m = new Map();
  if (!existsSync(dir)) return m;
  for (const f of readdirSync(dir)) if (/^\d+\.json$/.test(f)) { const r = readJson(join(dir, f)); if (r) m.set(r.run, r); }
  return m;
}

// The lines outside a longest common subsequence: what only the base printed, and only the head.
function lineDiff(a, b, eq = (x, y) => x === y) {
  const L = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) L[i][j] = eq(a[i], b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const base = [], head = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (eq(a[i], b[j])) { i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) base.push(a[i++]); else head.push(b[j++]);
  }
  return { base: base.concat(a.slice(i)), head: head.concat(b.slice(j)) };
}

function diff([baseDir, headDir, baseRoot, headRoot]) {
  const norm = normalizer([baseRoot, headRoot]);
  const suites = [...new Set([...readdirSync(baseDir), ...readdirSync(headDir)])]
    .filter((s) => !s.endsWith('.log')).sort();
  let differ = 0, notCompared = 0, compared = 0;
  const say = (s) => console.log(s);
  for (const suite of suites) {
    const b = runs(join(baseDir, suite)), h = runs(join(headDir, suite));
    const cb = clock(b), ch = clock(h);
    const label = labeller(join(baseDir, `${suite}.log`));
    // A check of the base's that fails on one tree only: the suite's own verdict on the difference.
    const fails = (d) => { try { return readFileSync(join(d, `${suite}.log`), 'utf8').split('\n').filter((l) => /^FAIL /.test(l)).map((l) => l.replace(/^FAIL +/, '')); } catch { return []; } };
    const fd = lineDiff(fails(baseDir).map(norm), fails(headDir).map(norm));
    for (const [side, names] of [['base', fd.base], ['head', fd.head]]) {
      for (const n of names) { differ++; say(`${suite}: a check fails on the ${side} only: ${n}`); }
    }
    if (!b.size && !h.size) { notCompared++; say(`${suite}: not compared: no pass ran on either tree`); continue; }
    const all = [...new Set([...b.keys(), ...h.keys()])].sort((x, y) => x - y);
    for (const n of all) {
      const rb = b.get(n), rh = h.get(n);
      const where = `${suite} run ${n}${label((rb || rh).at_line)}`;
      if (!rb || !rh) { notCompared++; say(`${where}: not compared: the pass ran only on the ${rb ? 'base' : 'head'}`); continue; }
      if (crashed(rb) !== crashed(rh)) {
        notCompared++;
        const bad = crashed(rb) ? rb : rh;
        say(`${where}: not compared: the pass failed to run on the ${bad === rb ? 'base' : 'head'}: ${norm(firstError(bad))}`);
        continue;
      }
      compared++;
      const lines = [], nb = renamer(), nh = renamer();
      if (rb.exit !== rh.exit || rb.signal !== rh.signal) lines.push(`  exit: base ${rb.signal || rb.exit}, head ${rh.signal || rh.exit}`);
      const qb = flatten(rb, norm), qh = flatten(rh, norm);
      const eq = (x, y) => same(x, y, n, cb, ch);
      for (const k of [...new Set([...qb.keys(), ...qh.keys()])].sort()) {
        const vb = qb.has(k) ? timed(nb(qb.get(k))) : null, vh = qh.has(k) ? timed(nh(qh.get(k))) : null;
        if (vb && vh && eq(vb, vh)) continue;
        const sb = vb ? show(vb, vh ? [vh] : []) : '(absent)', sh = vh ? show(vh, vb ? [vb] : []) : '(absent)';
        lines.push(`  queue ${k}: base ${sb}, head ${sh}`);
      }
      const ob = nb(norm(rb.out)).split('\n').map(timed), oh = nh(norm(rh.out)).split('\n').map(timed);
      const d = lineDiff(ob, oh, eq);
      for (const l of d.base) lines.push(`  output base: ${show(l, d.head)}`);
      for (const l of d.head) lines.push(`  output head: ${show(l, d.base)}`);
      if (lines.length) { differ++; say(`${where}:`); lines.forEach((l) => say(l)); }
    }
  }
  say(`compare_pass: ${compared} pass run(s) compared, ${differ} differ, ${notCompared} not compared`);
  process.exitCode = notCompared ? 2 : differ ? 1 : 0;
}

if (mode === 'record') record(args);
else if (mode === 'diff') diff(args);
else { console.error('usage: compare_pass.mjs record <node args...> | diff <base records> <head records> <base tree> <head tree>'); process.exitCode = 2; }
