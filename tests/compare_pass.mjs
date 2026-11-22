// The two halves of tests/compare_pass.sh, which runs one shell suite against two trees and lists
// every difference in what pass.mjs did.
//
//   node compare_pass.mjs record <node args...>
//     What the `node` shim runs in place of the real node when its argv names pass.mjs: runs the real
//     node ($PASS_CMP_NODE) with the same arguments, passing its stdin, stdout, stderr and exit status
//     through unchanged, then saves run <n>.json in $PASS_CMP_OUT: when the run started and ended, the exit
//     status, stdout and stderr as they arrived, the queue at $DESK_QUEUE and the archive beside it,
//     and how many lines the suite had printed to $PASS_CMP_SUITE_LOG when the run started. Before the
//     run, it holds each usage probe start stamp under the age a pass probes again at (holdProbeStamps).
//
//   node compare_pass.mjs diff <base records> <head records> <base tree> <head tree>
//     Lists, per suite and run, every queue field and output line that differs once ids and paths
//     that change between runs are normalized and times are matched across the trees; and every run
//     that only one tree recorded, or that crashed on only one, as not compared. Exit 0 when nothing
//     differs, 1 on a difference, 2 when anything was not compared.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join, resolve } from 'node:path';
import { lock, unlock } from '../desk/bin/dir-lock.mjs';
import { flattenQueue } from '../desk/bin/queue-fields.mjs';

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

// A pass with no usage reading probes for one only when its login's last probe started over
// PROBE_EVERY_MS ago (usage-probe.mjs noReadingProbeDue), so which of a suite's passes probe depends on
// how fast the machine runs the suite, and the two trees, run side by side, cross that line at
// different runs. Each pass starts with every probe start stamp held under that age, past the minute a
// pass joins another's probe for, so no run's probe depends on the machine's speed. Only a suite's own
// usage dir is held: one that is the machine's ($PASS_CMP_LIVE_USAGE, or unnamed) is left as it is. A
// tree without usage-probe.mjs has no probe to hold.
async function holdProbeStamps() {
  const live = process.env.PASS_CMP_LIVE_USAGE;
  const probeMod = new URL('../desk/bin/usage-probe.mjs', import.meta.url);
  if (!live || !existsSync(probeMod)) return;
  const m = await import(probeMod.href);
  const { PROBE_EVERY_MS, PROBE_GAP_MS, usageDir } = m, dir = usageDir();
  if (resolve(dir) === resolve(live)) return;
  const held = Date.now() - (PROBE_EVERY_MS - PROBE_GAP_MS);
  let names = [];
  try { names = readdirSync(dir).filter((f) => /^probe.*\.at$/.test(f)); } catch { return; }
  for (const f of names) {
    try { const at = Number(readFileSync(join(dir, f), 'utf8')); if (at > 0 && at < held) writeFileSync(join(dir, f), String(held)); } catch { /* left as it is */ }
  }
}

async function record(argv) {
  await holdProbeStamps();
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
      run, started, ended: Date.now(), at_line: atLine, exit: code, signal, out: Buffer.concat(chunks).toString('utf8'),
      queue: q ? readJson(q) : null, archive: q ? readJson(q.replace(/\.json$/, '') + '.archive.json') : null,
    }));
    // The pass died by a signal: die by it too, so the suite sees the status it would without the shim.
    // A signal node ignores still ends it with the shell's status for that signal.
    process.exitCode = signal ? 128 + (constants.signals[signal] || 0) : code ?? 1;
    if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
  });
}

// --- diff ---

// An ISO time, a time to the minute in UTC as the pass prints one, or epoch seconds or milliseconds;
// or an elapsed time as worker-cost.mjs wallTime ("0m 01s", "2h 05m") or gate.mjs prints one
// ("2h 5m", "15d 12h"), which two runs a second apart print differently.
const TIME = /\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?|\b\d{4}-\d\d-\d\d \d\d:\d\d UTC\b|\b1\d{9}(?:\d{3})?\b|\b\d+d \d\d?h\b|\b\d+h \d\d?m\b|\b\d+m \d\ds\b/g;
const SPAN = /^(\d+)([dhm]) (\d\d?)([hms])$/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TMP = /(?:\/private)?(?:\/var\/folders\/[^/\s"']+\/[^/\s"']+\/T|\/tmp)\/(?:tmp\.)?[A-Za-z0-9._-]*[A-Za-z0-9]{6,}/g;
// The machine's memory as the pass read it, a process id, and a repo slug hashed from its scratch path.
const MEM = /\b((?:vmmem|avail|rss)=)[0-9.]+[KMGT]?i?B?|\b[0-9.]+[KMGT]i?B?(?= available\b)/g;
const PID = /\b(pid:? |"pid":\s*)\d+/g;
const SLUG = /\b(local__[\w.-]*?)-[0-9a-f]{8}\b/g;
// A port the pass took from what was free on the machine when it ran ("port=47704", "port 47704"),
// named per run as a SHA is (renamer), cut short by the pass or not.
const PORT = /\b(port[= ]|localhost:|127\.0\.0\.1:)(\d{2,5}\b(?!…)|\d{1,5}(?=…))/g;
// git words one refused fetch differently, depending on which side of the connection reports it first.
const UPLOAD_PACK = /\bfatal: (?:remote error: |git )?upload-pack: /g;

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
      .replace(SLUG, '$1-<HASH>')
      .replace(UPLOAD_PACK, 'fatal: upload-pack: ');
  };
}

// Each tree makes its own commits, whose SHAs differ with the second they were made in, so a SHA,
// whole or abbreviated, is not compared by its value: text matches with each SHA in it as <SHA>
// (tokens), and the SHAs of matched text must then stand one for one across the run (pairer): the
// same commit at the same step reads alike, and one commit where the other tree has two differs.
// Per run, not per suite: two commits a tree made in the same second can share a SHA there and not on
// the other tree, which would put every later run out of step.
// A SHA needs a letter and a digit, as a number or a word has not both, except at the lengths the
// pass abbreviates to (9 and 12) and a whole one: one in about 70 nine-character abbreviations is all
// digits, and no time the pass prints has 9, 12 or 40 digits.
// The id the pass hashes from its own start time into an evidence fix's key (`evidence-fix-<id>`,
// `fix-<id>.md`) is treated the same way, digits or not: each tree's pass started at a different time.
// Ports are treated the same way: two runs take different free ports, but two tickets given one port
// on one tree and two on the other still differ.
// Text the pass cut short ("…") is cut at a different place on each tree, so a SHA or port in it can be
// whole on one and cut, or gone, on the other. Only the SHAs and ports before the word the cut falls
// in and after the "…" are paired (sameCut): one cut short, or past the cut on one tree only, pairs
// with nothing, so the values after it stay in step whichever tree cut.
// What is shown of a difference names each tree's SHAs and ports by the order they first appear in
// (renamer), and within text the pass cut short, by that text alone (<SHA?1>).
const SHA = /\b(?:(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}|[0-9a-f]{40}|[0-9a-f]{12}|[0-9a-f]{9}|(?<=\bfix-)[0-9a-f]{8})\b(?!…)|\b[0-9a-f]{1,40}(?=…)/g;
function namer(tag) {
  const seen = new Map();
  return {
    seen,
    name: (x) => { if (!seen.has(x)) seen.set(x, `<${tag}${seen.size + 1}>`); return seen.get(x); },
    find(x, isCut) {
      if (seen.has(x) || !isCut) return seen.get(x);
      const starts = [...seen.keys()].filter((k) => k.startsWith(x));
      return starts.length === 1 ? seen.get(starts[0]) : undefined;
    },
  };
}
function renamer() {
  const sha = namer('SHA'), port = namer('PORT');
  const rename = (s) => {
    // Ports first, so a port cut short is not taken for a SHA.
    if (!s.includes('…')) return s.replace(PORT, (_, pre, p) => pre + port.name(p)).replace(SHA, (x) => sha.name(x));
    const own = (tag) => { const m = new Map(); return (x) => { if (!m.has(x)) m.set(x, `<${tag}?${m.size + 1}>`); return m.get(x); }; };
    const ownSha = own('SHA'), ownPort = own('PORT');
    const isCut = (all, at, x) => all[at + x.length] === '…';
    return s.replace(PORT, (m, pre, p, at, all) => pre + (port.find(p, isCut(all, at, m)) ?? ownPort(p)))
      .replace(SHA, (x, at, all) => sha.find(x, isCut(all, at, x)) ?? ownSha(x));
  };
  rename.seen = { SHA: sha.seen, PORT: port.seen };
  return rename;
}

// A normalized string with each port and SHA in it as <PORT> or <SHA>, and those values in order,
// each marked when the pass cut it short. Ports first, so a port cut short is not taken for a SHA.
function tokens(s) {
  const found = [];
  const mark = (tag, v, cut) => { found.push({ tag, v, cut }); return `\u0001${found.length - 1}\u0002`; };
  const marked = s.replace(PORT, (m, pre, p, at, all) => pre + mark('PORT', p, all[at + m.length] === '…'))
    .replace(SHA, (x, at, all) => mark('SHA', x, all[at + x.length] === '…'));
  const vals = [];
  const key = marked.replace(/\u0001(\d+)\u0002/g, (_, i) => { vals.push(found[i]); return `<${found[i].tag}>`; });
  return { key, vals };
}

// The SHAs and ports of matched text, paired base to head across one run: each value stands for one
// value on the other tree, both ways. A pair of texts whose values break that differs.
function pairer() {
  let fwd = new Map(), back = new Map();
  const id = (v) => `${v.tag} ${v.v}`;
  return {
    seed(tag, a, b) { fwd.set(`${tag} ${a}`, `${tag} ${b}`); back.set(`${tag} ${b}`, `${tag} ${a}`); },
    // x and y match, and pairs says which of x's values stands where each of y's does.
    check(x, y, pairs) {
      const f = new Map(fwd), bk = new Map(back);
      for (const [i, j] of pairs) {
        const a = x.vals[i], b = y.vals[j];
        if (a.cut || b.cut) continue;
        const ka = id(a), kb = id(b);
        if ((f.get(ka) ?? kb) !== kb || (bk.get(kb) ?? ka) !== ka) return false;
        f.set(ka, kb); bk.set(kb, ka);
      }
      fwd = f; back = bk;
      return true;
    },
  };
}

// A normalized string split into its shape, each time in it as <TIME>, and those times.
const SLACK = 15_000;
// An elapsed wall time reads as its length in ms, which is matched as a time is, within the slack.
const UNIT = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
const spanMs = (m) => Number(m[1]) * UNIT[m[2]] + Number(m[3]) * UNIT[m[4]];
const ms = (t) => { const m = SPAN.exec(t); return m ? spanMs(m) : /^\d+$/.test(t) ? Number(t) * (t.length === 10 ? 1000 : 1) : Date.parse(t.replace(/ (\d\d:\d\d) UTC$/, 'T$1Z')); };
// A time printed to the minute is up to a minute short of the time it stands for, as an elapsed time
// is up to one of its smaller unit short: a minute for "2h 05m", an hour for "15d 12h".
const slack = (t) => { const m = SPAN.exec(t); return SLACK + (/ UTC$/.test(t) ? 60_000 : m ? UNIT[m[4]] : 0); };
function timed(text) {
  const times = [];
  return { text, times, shape: text.replace(TIME, (t) => { times.push(t); return '<TIME>'; }) };
}
// A normalized queue value or output line: as shown (text, and shape with its times as <TIME>, its
// SHAs and ports named by rn), and as matched (cmp, with its times, SHAs and ports as tags, and times
// and vals, those taken out).
function item(s, rn) {
  const t = tokens(s), shown = timed(rn(s)), k = timed(t.key);
  return { text: shown.text, shape: shown.shape, cmp: k.shape, times: k.times, vals: t.vals };
}

// When a tree's runs of one suite started and ended, to find the run a time was made in or worked out for.
function clock(recs) {
  const starts = [...recs.values()].filter((r) => Number.isFinite(r.started)).map((r) => [r.started, r.run])
    .sort((a, b) => a[0] - b[0]);
  const end = (n) => recs.get(n)?.ended;
  return {
    start: (n) => recs.get(n)?.started,
    // Where t falls among the runs: `in n` while run n ran, `before n` after run n - 1 ended and before
    // run n started, the time the suite spends between two passes.
    slots(t) {
      const out = new Set();
      for (const [s, n] of starts) {
        const e = end(n), pe = end(n - 1);
        if (Number.isFinite(e) && s <= t && t <= e) out.add(`in ${n}`);
        if (Number.isFinite(pe) && pe < t && t < s) out.add(`before ${n}`);
      }
      return out;
    },
    // The runs that started around t: the last to start before it, and its neighbours.
    around(t) {
      let lo = 0, hi = starts.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid][0] <= t + SLACK) lo = mid + 1; else hi = mid; }
      return starts.slice(Math.max(0, lo - 3), lo + 1).map(([, n]) => n);
    },
  };
}

// Two times match when they are the same, a few seconds apart, made in the same run or the same gap
// between two runs on each tree, or the same offset from the start of one run on each tree: a time a
// run made, or one its suite worked out just before it, sits there however far apart the two trees ran
// and however much longer one tree's run took to reach it. A time worked out differently (an hour on,
// not two) does not.
function sameTime(a, b, run, cb, ch) {
  if (a === b) return true;
  const ta = ms(a), tb = ms(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  const within = Math.max(slack(a), slack(b));
  if (Math.abs(ta - tb) <= within) return true;
  const slotsH = ch.slots(tb);
  for (const s of cb.slots(ta)) if (slotsH.has(s) && Number(s.split(' ')[1]) <= run) return true;
  for (const j of new Set([run, ...cb.around(ta), ...ch.around(tb)])) {
    if (j > run) continue;
    const sb = cb.start(j), sh = ch.start(j);
    if (sb != null && sh != null && Math.abs((ta - sb) - (tb - sh)) <= within) return true;
  }
  return false;
}
const count = (s) => s.split('<TIME>').length - 1;
const valCount = (s) => (s.match(/<(?:SHA|PORT)>/g) || []).length;
// Text the pass cuts at a length ends there with "…", perhaps with more after it. As a path, port or
// SHA before the cut is longer on one tree than the other, the two cut at different places: they match
// when the shorter head starts the other side and both end alike. The word the cut fell in is checked
// up to the first digit, path or placeholder in it, or a run of hex letters it ends in, which may be a
// SHA, port or path the cut left part of: that part must start the other side's word there.
// Two that match give the pairs of their SHAs and ports to hold one for one (pairer): those before the
// word the cut falls in, and those after the "…". Two that do not give null.
const cutWord = (w) => w.replace(/[\d/<].*$/, '').replace(/[a-f]*$/i, '');
function sameCut(x, y, eqTime) {
  const parts = (v) => {
    const i = v.cmp.indexOf('…');
    if (i < 0) return null;
    const before = v.cmp.slice(0, i), word = /\S*$/.exec(before)[0];
    return { head: before.slice(0, before.length - word.length), word, tail: v.cmp.slice(i + 1) };
  };
  let px = parts(x), py = parts(y), swapped = false;
  if (!px && !py) return null;
  if (!px || (py && py.head.length < px.head.length)) { [x, y] = [y, x]; [px, py] = [py, px]; swapped = true; }
  const { head, tail } = px;
  // A cut in the first word leaves nothing to compare, which would match anything.
  if (!/\w/.test(head)) return null;
  const ok = py ? py.head.startsWith(head) && py.tail === tail
    : y.cmp.length >= head.length + tail.length && y.cmp.startsWith(head) && y.cmp.endsWith(tail);
  if (!ok) return null;
  const fx = cutWord(px.word);
  if (py && py.head.length === head.length) {
    const fy = cutWord(py.word);
    if (!fx.startsWith(fy) && !fy.startsWith(fx)) return null;
  } else if (!/^\S*/.exec(y.cmp.slice(head.length))[0].startsWith(fx)) return null;
  const nh = count(head), nt = count(tail);
  const timesOk = x.times.slice(0, nh).every((t, i) => eqTime(t, y.times[i]))
    && x.times.slice(x.times.length - nt).every((t, i) => eqTime(t, y.times[y.times.length - nt + i]));
  if (!timesOk) return null;
  const pairs = [];
  for (let i = 0; i < valCount(head); i++) pairs.push([i, i]);
  for (let i = 1; i <= valCount(tail); i++) pairs.push([x.vals.length - i, y.vals.length - i]);
  return swapped ? pairs.map(([a, b]) => [b, a]) : pairs;
}
// Whether x and y match: null if not, else the pairs of their SHAs and ports to hold one for one.
const same = (x, y, run, cb, ch) => {
  const eqTime = (a, b) => sameTime(a, b, run, cb, ch);
  if (x.cmp === y.cmp) return x.times.every((t, i) => eqTime(t, y.times[i])) ? x.vals.map((_, i) => [i, i]) : null;
  return sameCut(x, y, eqTime);
};
// A value or line is shown by its shape, unless only its times differ from the other side's: then
// with its times, so both values show.
const show = (x, others) => (others.some((y) => y.shape === x.shape) ? x.text : x.shape);

// "T-1 state" for a ticket's field, "archive T-1 state" in the archive, "queue <path>" otherwise.
// Each key is normalized and its SHAs named (rn) in the order the queue holds them, so a ticket keyed
// by an id one tree made up is the same ticket on both, and sorting the paths later cannot reorder
// the names. A process id a record keeps (a `pid` field) differs between runs as a printed one does,
// and a port (a `port` field) is compared as a printed one is (tokens, pairer). A queue stamp, which says when
// the pass last wrote a ticket or started its worker, lands wherever the load of the machine put that
// write in its run, so it is compared as set or not, and by its type: <STAMP:string> when it holds a
// string.
const STAMP = /(?:^|[ .])(?:updated_at|spawned_at|last_start|cloud\.started)$/;
const flatten = (rec, norm, rn) => flattenQueue(rec, {
  key: (k) => rn(norm(k)),
  leaf: (v, path) => (Number.isInteger(v) && /(?:^|\.)pid$/.test(path) ? '<PID>'
    : Number.isInteger(v) && /(?:^|[ .])port$/.test(path) ? `port ${v}`
      : v != null && STAMP.test(path) ? `<STAMP:${typeof v}>` : norm(JSON.stringify(v))),
});

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

// The lines outside a longest common subsequence: what only the base printed, and only the head; and
// the lines it matched, in order, as [base, head].
function lineDiff(a, b, eq = (x, y) => x === y) {
  const L = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) L[i][j] = eq(a[i], b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const base = [], head = [], matched = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (eq(a[i], b[j])) matched.push([a[i++], b[j++]]); else if (L[i + 1][j] >= L[i][j + 1]) base.push(a[i++]); else head.push(b[j++]);
  }
  return { base: base.concat(a.slice(i)), head: head.concat(b.slice(j)), matched };
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
      const qb = flatten(rb, norm, nb), qh = flatten(rh, norm, nh);
      const match = (x, y) => same(x, y, n, cb, ch), pair = pairer();
      // A ticket keyed by an id each tree made up is one ticket on both by its name in the key, so the
      // values behind one name are a pair from the start.
      for (const tag of ['SHA', 'PORT']) {
        const byName = new Map([...nh.seen[tag]].map(([v, name]) => [name, v]));
        for (const [v, name] of nb.seen[tag]) if (byName.has(name)) pair.seed(tag, v, byName.get(name));
      }
      const held = (x, y) => { const p = match(x, y); return p != null && pair.check(x, y, p); };
      for (const k of [...new Set([...qb.keys(), ...qh.keys()])].sort()) {
        const vb = qb.has(k) ? item(qb.get(k), nb) : null, vh = qh.has(k) ? item(qh.get(k), nh) : null;
        if (vb && vh && held(vb, vh)) continue;
        const sb = vb ? show(vb, vh ? [vh] : []) : '(absent)', sh = vh ? show(vh, vb ? [vb] : []) : '(absent)';
        lines.push(`  queue ${k}: base ${sb}, head ${sh}`);
      }
      const ob = norm(rb.out).split('\n').map((l) => item(l, nb)), oh = norm(rh.out).split('\n').map((l) => item(l, nh));
      const d = lineDiff(ob, oh, (x, y) => match(x, y) != null);
      // Matched lines whose SHAs or ports do not stand one for one differ too, where they were printed.
      const differs = new Set([...d.base, ...d.head]);
      for (const [x, y] of d.matched) if (!pair.check(x, y, match(x, y))) { differs.add(x); differs.add(y); }
      const db = ob.filter((l) => differs.has(l)), dh = oh.filter((l) => differs.has(l));
      for (const l of db) lines.push(`  output base: ${show(l, dh)}`);
      for (const l of dh) lines.push(`  output head: ${show(l, db)}`);
      if (lines.length) { differ++; say(`${where}:`); lines.forEach((l) => say(l)); }
    }
  }
  say(`compare_pass: ${compared} pass run(s) compared, ${differ} differ, ${notCompared} not compared`);
  process.exitCode = notCompared ? 2 : differ ? 1 : 0;
}

if (mode === 'record') record(args);
else if (mode === 'diff') diff(args);
else { console.error('usage: compare_pass.mjs record <node args...> | diff <base records> <head records> <base tree> <head tree>'); process.exitCode = 2; }
