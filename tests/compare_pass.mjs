// The two halves of tests/compare_pass.sh, which runs one shell suite against two trees and lists
// every difference in what pass.mjs did.
//
//   node compare_pass.mjs record <node args...>
//     What the `node` shim runs in place of the real node when its argv names pass.mjs: runs the real
//     node ($PASS_CMP_NODE) with the same arguments, passing its stdin, stdout, stderr and exit status
//     through unchanged, then saves run <n>.json in $PASS_CMP_OUT: the exit status, stdout and stderr
//     as they arrived, the queue at $DESK_QUEUE and the archive beside it, and how many lines the
//     suite had printed to $PASS_CMP_SUITE_LOG when the run started.
//
//   node compare_pass.mjs diff <base records> <head records> <base tree> <head tree>
//     Lists, per suite and run, every queue field and output line that differs once times, ids and
//     paths that change between runs are normalized; and every run that only one tree recorded, or
//     that crashed on only one, as not compared. Exit 0 when nothing differs, 1 on a difference, 2
//     when anything was not compared.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [mode, ...args] = process.argv.slice(2);

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const lineCount = (f) => { try { return readFileSync(f, 'utf8').split('\n').length - 1; } catch { return 0; } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Run numbers are taken under a directory lock, so two passes a suite starts together get one each.
function nextRun(dir) {
  const lock = join(dir, '.lock');
  for (let i = 0; ; i++) {
    try { mkdirSync(lock); break; } catch (e) { if (e.code !== 'EEXIST' || i > 2000) throw e; sleep(5); }
  }
  try {
    const f = join(dir, '.next');
    const n = Number(existsSync(f) ? readFileSync(f, 'utf8') : 0) + 1;
    writeFileSync(f, String(n));
    return n;
  } finally { rmdirSync(lock); }
}

function record(argv) {
  const dir = process.env.PASS_CMP_OUT;
  mkdirSync(dir, { recursive: true });
  const run = nextRun(dir);
  const atLine = lineCount(process.env.PASS_CMP_SUITE_LOG);
  const chunks = [];
  const child = spawn(process.env.PASS_CMP_NODE, argv, { stdio: ['inherit', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { chunks.push(d); process.stdout.write(d); });
  child.stderr.on('data', (d) => { chunks.push(d); process.stderr.write(d); });
  child.on('error', (e) => { chunks.push(Buffer.from(`compare_pass: could not start node: ${e.message}\n`)); });
  child.on('close', (code, signal) => {
    const q = process.env.DESK_QUEUE;
    writeFileSync(join(dir, `${run}.json`), JSON.stringify({
      run, at_line: atLine, exit: code, signal, out: Buffer.concat(chunks).toString('utf8'),
      queue: q ? readJson(q) : null, archive: q ? readJson(q.replace(/\.json$/, '') + '.archive.json') : null,
    }));
    if (signal) process.kill(process.pid, signal);
    process.exitCode = code ?? 1;
  });
}

// --- diff ---

const ISO = /\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?/g;
const EPOCH = /\b1\d{9}(?:\d{3})?\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TMP = /(?:\/private)?(?:\/var\/folders\/[^/\s"']+\/[^/\s"']+\/T|\/tmp)\/(?:tmp\.)?[A-Za-z0-9._-]*[A-Za-z0-9]{6,}/g;
// The machine's memory as the pass read it, a process id, and a repo slug hashed from its scratch path.
const MEM = /\b((?:vmmem|avail|rss)=)[0-9.]+[KMGT]?i?B?|\b[0-9.]+[KMGT]i?B?(?= available\b)/g;
const PID = /\b(pid:? |"pid":\s*)\d+/g;
const SLUG = /\b(local__[\w.-]*?)-[0-9a-f]{8}\b/g;
const DAY =2 * 24 * 3600 * 1000;

// Two runs of the same tree differ in their scratch paths and in the times and ids they make up, so
// each is replaced by a placeholder. A time is replaced only near now: one a fixture wrote is kept.
function normalizer(roots) {
  const now = Date.now();
  const near = (ms) => Math.abs(ms - now) < DAY;
  const reps = [...new Set(roots.flatMap((r) => { try { return [r, realpathSync(r)]; } catch { return [r]; } }))]
    .sort((a, b) => b.length - a.length);
  return (s) => {
    for (const r of reps) s = s.split(r).join('<TREE>');
    return s
      .replace(ISO, (t) => (near(Date.parse(t)) ? '<TIME>' : t))
      .replace(EPOCH, (t) => (near(t.length === 10 ? Number(t) * 1000 : Number(t)) ? '<TIME>' : t))
      .replace(UUID, '<UUID>')
      .replace(TMP, '<TMP>')
      .replace(MEM, (_, key) => `${key || ''}<MEM>`)
      .replace(PID, '$1<PID>')
      .replace(SLUG, '$1-<HASH>');
  };
}

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
function lineDiff(a, b) {
  const L = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const base = [], head = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) base.push(a[i++]); else head.push(b[j++]);
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
      const lines = [];
      if (rb.exit !== rh.exit || rb.signal !== rh.signal) lines.push(`  exit: base ${rb.signal || rb.exit}, head ${rh.signal || rh.exit}`);
      const qb = flatten(rb, norm), qh = flatten(rh, norm);
      for (const k of [...new Set([...qb.keys(), ...qh.keys()])].sort()) {
        const vb = qb.get(k), vh = qh.get(k);
        if (vb !== vh) lines.push(`  queue ${k}: base ${vb ?? '(absent)'}, head ${vh ?? '(absent)'}`);
      }
      const ob = norm(rb.out).split('\n'), oh = norm(rh.out).split('\n');
      const d = lineDiff(ob, oh);
      for (const l of d.base) lines.push(`  output base: ${l}`);
      for (const l of d.head) lines.push(`  output head: ${l}`);
      if (lines.length) { differ++; say(`${where}:`); lines.forEach((l) => say(l)); }
    }
  }
  say(`compare_pass: ${compared} pass run(s) compared, ${differ} differ, ${notCompared} not compared`);
  process.exitCode = notCompared ? 2 : differ ? 1 : 0;
}

if (mode === 'record') record(args);
else if (mode === 'diff') diff(args);
else { console.error('usage: compare_pass.mjs record <node args...> | diff <base records> <head records> <base tree> <head tree>'); process.exitCode = 2; }
