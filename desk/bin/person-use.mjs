// The person is using this computer: while processes that are not desk's hold more memory or CPU than
// the machine profile says this computer holds with nobody at it, the pass drops the local cap to a
// floor (for local-only tickets) and sends cloud-able tickets only to the cloud. Running workers are
// never stopped. The cap comes back once the person's use has stayed under the threshold for a set time.
//
// What counts as desk's: a worker's process tree (spawn-worker.sh runs each session under a shell named
// `desk-worker`), with its dev servers and test runs; any process whose command names desk's own bin
// directory or a worktrees directory; and the process asking, with its ancestors and descendants.
// Everything else is the person's, or the computer's own: the baseline rows are what that second part
// holds with nobody at it.
//
// The rows (machine profile Sizing, set with `desk-env machine set`; machine.mjs checks each):
//   person-use           on | off                          off when unset: a machine opts in
//   person-baseline-gb   GB others hold at rest            15% of memory-gb (2 where unknown)
//   person-baseline-cpu  cores others keep busy at rest    5% of cpu-cores, at least 0.5
//   person-use-gb        GB over the baseline that is use  10% of memory-gb, at least 2
//   person-use-cpu       cores over the baseline that is use  25% of cpu-cores, at least 1
//   person-use-floor     the local cap while in use        1
//   person-use-calm-min  minutes under it before the cap returns  10
import { readFileSync } from 'node:fs';
import { parsePs as parsePsRows, psRows } from './ps-rows.mjs';

const num = (v) => (v == null || String(v).trim() === '' ? NaN : Number(String(v).trim()));
const round1 = (n) => Math.round(n * 10) / 10;

// The rows through `get(key)` (a profile value or null), each with its default where unset:
// -> { on, baselineGb, baselineCpu, overGb, overCpu, floor, calmMin, problems }. A row set but
// unreadable reads as its default and is a problem naming it. The mode is on only where `person-use`
// is exactly `on`; while it is off the other rows are not read, so only that row can be a problem.
export function personUseRows(get) {
  const raw = get('person-use');
  const mode = raw == null ? 'off' : String(raw).trim();
  const modeProblems = ['on', 'off', ''].includes(mode) ? [] : [`\`person-use\` is "${mode}": want on or off; read as off`];
  const problems = [...modeProblems];
  const memGb = num(get('memory-gb'));
  const cores = num(get('cpu-cores'));
  const defaults = {
    'person-baseline-gb': Number.isFinite(memGb) ? round1(memGb * 0.15) : 2,
    'person-baseline-cpu': Number.isFinite(cores) ? Math.max(0.5, round1(cores * 0.05)) : 0.5,
    'person-use-gb': Number.isFinite(memGb) ? Math.max(2, round1(memGb * 0.1)) : 2,
    'person-use-cpu': Number.isFinite(cores) ? Math.max(1, round1(cores * 0.25)) : 1,
    'person-use-floor': 1,
    'person-use-calm-min': 10,
  };
  const ok = { 'person-use-floor': (n) => Number.isInteger(n) && n >= 0, 'person-use-gb': (n) => n > 0, 'person-use-cpu': (n) => n > 0 };
  const v = {};
  for (const [k, d] of Object.entries(defaults)) {
    const raw = get(k);
    if (raw == null || String(raw).trim() === '') { v[k] = d; continue; }
    const n = num(raw);
    if (Number.isFinite(n) && n >= 0 && (ok[k] ?? (() => true))(n)) v[k] = n;
    else { v[k] = d; problems.push(`\`${k}\` is "${raw}": read as ${d}`); }
  }
  const on = mode === 'on';
  return {
    on, baselineGb: v['person-baseline-gb'], baselineCpu: v['person-baseline-cpu'], overGb: v['person-use-gb'],
    overCpu: v['person-use-cpu'], floor: v['person-use-floor'], calmMin: v['person-use-calm-min'], problems: on ? problems : modeProblems,
  };
}

// The `ps` columns read, through ps-rows.mjs (desk's one ps call).
const COLUMNS = 'pid=,ppid=,rss=,pcpu=,args=';
const procsOf = (rows) => rows.map((r) => ({ pid: r.pid, ppid: r.ppid, kb: r.rss, cpu: Number(r.pcpu) || 0, cmd: r.args }));
// `ps -ww -axo pid=,ppid=,rss=,pcpu=,args=` output (or its fixture) -> [{ pid, ppid, kb, cpu, cmd }].
export const parsePs = (text) => procsOf(parsePsRows(String(text ?? ''), COLUMNS));

// What processes other than desk's hold: -> { gb, cpu, procs } (cpu in cores, procs counted).
// `marks` are substrings that make a process desk's (desk's bin directory, the worktrees directories);
// `self` the pid asking, whose ancestors and descendants are desk's too.
export function othersHold(procs, { marks = [], self = null } = {}) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const kids = new Map();
  for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p.pid); }
  const desk = new Set();
  const mark = (pid) => {
    const stack = [pid];
    while (stack.length) {
      const q = stack.pop();
      if (desk.has(q)) continue;
      desk.add(q);
      stack.push(...(kids.get(q) ?? []));
    }
  };
  const marked = marks.filter(Boolean);
  for (const p of procs) if (/(^|[\s/])desk-worker(\s|$)/.test(p.cmd) || marked.some((m) => p.cmd.includes(m))) mark(p.pid);
  if (self != null) {
    mark(self);
    for (let p = byPid.get(self), n = 0; p && n < 64; p = byPid.get(p.ppid), n += 1) desk.add(p.pid);
  }
  let kb = 0; let cpu = 0; let n = 0;
  for (const p of procs) {
    if (desk.has(p.pid) || p.pid <= 1) continue;
    kb += p.kb; cpu += p.cpu; n += 1;
  }
  return { gb: round1(kb / 1024 / 1024), cpu: round1(cpu / 100), procs: n };
}

// This computer's processes, from `ps`, or from the file AUTOPILOT_PERSON_USE_PS names (a fixture).
// -> procs, or null where ps could not be run.
export function readProcs(env = process.env) {
  try {
    return env.AUTOPILOT_PERSON_USE_PS ? parsePs(readFileSync(env.AUTOPILOT_PERSON_USE_PS, 'utf8')) : procsOf(psRows(COLUMNS));
  } catch { return null; }
}

// Whether a reading is over the threshold: -> { over, why }.
export function overThreshold(held, rows) {
  const gbOver = held.gb - rows.baselineGb;
  const cpuOver = held.cpu - rows.baselineCpu;
  const why = [];
  if (gbOver > rows.overGb) why.push(`other processes hold ${held.gb} GB, ${round1(gbOver)} over the ${rows.baselineGb} GB baseline (person-use-gb ${rows.overGb})`);
  if (cpuOver > rows.overCpu) why.push(`other processes keep ${held.cpu} cores busy, ${round1(cpuOver)} over the ${rows.baselineCpu} baseline (person-use-cpu ${rows.overCpu})`);
  return { over: why.length > 0, why: why.join('; ') };
}

// The mode after this reading. `prev` is the batch's stored person_use ({ on, since, calm_since } or
// null), `held` the reading (null where none could be taken: the mode stays as it was), `now` an ISO
// string. On at once while over; off only once under since calm_since for calmMin minutes.
// -> { on, since, calm_since, gb, cpu, why }
export function nextMode(prev, held, rows, now) {
  const was = prev?.on === true;
  if (!rows.on) return { on: false, since: null, calm_since: null, gb: held?.gb ?? null, cpu: held?.cpu ?? null, why: 'person-use is off' };
  if (!held) return { ...(prev ?? { on: false, since: null, calm_since: null }), why: 'no reading of this computer\'s processes' };
  const { over, why } = overThreshold(held, rows);
  const base = { gb: held.gb, cpu: held.cpu };
  if (over) return { on: true, since: was ? prev.since : now, calm_since: null, ...base, why };
  if (!was) return { on: false, since: null, calm_since: null, ...base, why: 'under the threshold' };
  const calm = prev.calm_since ?? now;
  if (Date.parse(now) - Date.parse(calm) >= rows.calmMin * 60_000) return { on: false, since: null, calm_since: null, ...base, why: `under the threshold for ${rows.calmMin} min` };
  return { on: true, since: prev.since, calm_since: calm, ...base, why: `under the threshold since ${calm}; the cap returns after ${rows.calmMin} min of that` };
}

// The line desk-q and the pass show while the mode is on.
export const modeLine = (floor) => `you're using this computer: local cap ${floor}, cloud first`;
