// How far through a worker session its skill-file Reads land, per start stage: the bytes each start
// stage reads from skill files and the share of the session's turns each read then rides. A Read at
// turn i of a session of n turns rides the n - 1 - i turns after it, so its remaining-turn fraction
// is (n - 1 - i) / n; a pack loaded at turn 0 would ride all n, a fraction of 1.
//
//   node skill-ride.mjs [--days 14] [--logs <dir>] [--skills <dir>]… [--files <stage>]
//
// A session is one spawn in a worker log: from a desk_spawn event (spawn-worker.sh's, which names the
// stage it starts at) to the next. Its turns are the main thread's model calls, each message counted
// once; a subagent's Reads ride the subagent's turns, not the worker's, so they are left out. A
// session with no desk_spawn before it is stage `unknown`. A session counts when its spawn is no older
// than --days, or for `unknown`, when its log was last written then. Skill files are those under
// each --skills directory (default: the installed skills, desk-env's skillsDir, and ~/.claude/skills).
// --files <stage> lists that stage's skill files instead: how many of its sessions read each, and the
// bytes.
import { readdirSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLogFile } from './harvest.mjs';
import { HOME, repoStateOf, skillsDir, stateDir } from './desk-env.mjs';

const USAGE = 'usage: skill-ride.mjs [--days 14] [--logs <dir>] [--skills <dir>]… [--files <stage>]';
export const UNKNOWN = 'unknown';

export function parseArgs(argv) {
  const o = { days: 14, logs: null, skills: [], files: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!['--days', '--logs', '--skills', '--files'].includes(a)) throw new Error(`unknown argument ${a}\n${USAGE}`);
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    const v = argv[++i];
    if (a === '--days') {
      if (!/^\d+$/.test(v) || !(Number(v) > 0)) throw new Error(`--days must be a positive whole number, not ${v}`);
      o.days = Number(v);
    } else if (a === '--skills') o.skills.push(v);
    else o[a.slice(2)] = v;
  }
  if (!o.skills.length) o.skills = [skillsDir(), join(HOME, '.claude', 'skills')];
  o.logs ??= join(repoStateOf(stateDir()), 'logs');
  return o;
}

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text ?? '').join('\n') : '');

// One log's sessions. -> [{ stage, at, turns, reads: [{ file, turn, bytes }] }], each read a Read of a
// file under one of `roots` that came back with a result.
export function logSessions(text, roots) {
  const under = (p) => typeof p === 'string' && roots.some((r) => p.startsWith(`${r.replace(/\/$/, '')}/`));
  const sessions = [];
  let s = null;
  const open = (stage, at) => {
    s = { stage, at, turns: 0, ids: new Set(), calls: new Map(), reads: [] };
    sessions.push(s);
  };
  for (const line of text.split('\n')) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.type === 'desk_spawn') { open(String(d.stage ?? UNKNOWN), d.at ?? null); continue; }
    if (d?.parent_tool_use_id) continue;
    if (d?.type === 'assistant') {
      if (!s) open(UNKNOWN, null);
      const id = d.message?.id ?? `line-${s.turns}`;
      if (!s.ids.has(id)) { s.ids.add(id); s.turns += 1; }
      for (const c of d.message?.content ?? []) {
        if (c?.type === 'tool_use' && c.name === 'Read' && under(c.input?.file_path)) s.calls.set(c.id, { file: c.input.file_path, turn: s.turns - 1 });
      }
    } else if (d?.type === 'user' && s) {
      for (const c of Array.isArray(d.message?.content) ? d.message.content : []) {
        const call = c?.type === 'tool_result' ? s.calls.get(c.tool_use_id) : null;
        if (!call) continue;
        s.calls.delete(c.tool_use_id);
        s.reads.push({ ...call, bytes: Buffer.byteLength(textOf(c.content)) });
      }
    }
  }
  return sessions.filter((x) => x.turns > 0).map(({ stage, at, turns, reads }) => ({ stage, at, turns, reads }));
}

export const rideOf = (read, turns) => (turns - 1 - read.turn) / turns;

// Sessions -> one row per start stage: { stage, sessions, reading, reads, bytes, meanRide, byteRide },
// meanRide the plain mean of each read's remaining-turn fraction and byteRide the mean weighted by
// bytes (the share of the read bytes that rides the rest of the session), null with no reads.
export function stageRows(sessions) {
  const by = new Map();
  for (const s of sessions) {
    const r = by.get(s.stage) ?? { stage: s.stage, sessions: 0, reading: 0, reads: 0, bytes: 0, rideSum: 0, rideBytes: 0 };
    r.sessions += 1;
    if (s.reads.length) r.reading += 1;
    for (const x of s.reads) {
      const f = rideOf(x, s.turns);
      r.reads += 1;
      r.bytes += x.bytes;
      r.rideSum += f;
      r.rideBytes += f * x.bytes;
    }
    by.set(s.stage, r);
  }
  return [...by.values()].sort((a, b) => b.bytes - a.bytes)
    .map(({ rideSum, rideBytes, ...r }) => ({ ...r, meanRide: r.reads ? rideSum / r.reads : null, byteRide: r.bytes ? rideBytes / r.bytes : null }));
}

// One stage's skill files: how many of its sessions read each, the reads and bytes, most bytes first.
export function stageFiles(sessions, stage) {
  const by = new Map();
  const of = sessions.filter((s) => s.stage === stage);
  of.forEach((s, n) => {
    for (const x of s.reads) {
      const f = by.get(x.file) ?? { file: x.file, sessions: new Set(), reads: 0, bytes: 0 };
      f.sessions.add(n);
      f.reads += 1;
      f.bytes += x.bytes;
      by.set(x.file, f);
    }
  });
  return { sessions: of.length, files: [...by.values()].map((f) => ({ ...f, sessions: f.sessions.size })).sort((a, b) => b.bytes - a.bytes) };
}

// Every session in `dir`'s worker logs that falls inside the window.
export function collect(dir, roots, since) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!/\.log(\.round\d+(\.gz)?)?$/.test(name)) continue;
    const file = join(dir, name);
    let mtime;
    try { mtime = statSync(file).mtimeMs; } catch { continue; }
    if (mtime < since) continue;
    for (const s of logSessions(readLogFile(file), roots)) {
      const at = Date.parse(s.at ?? '');
      if (Number.isNaN(at) ? s.stage === UNKNOWN : at >= since) out.push(s);
    }
  }
  return out;
}

const pct = (f) => (f == null ? '—' : `${(100 * f).toFixed(1)}%`);
const kb = (b) => `${(b / 1024).toFixed(1)} KiB`;

export function render(rows, { days, logs }) {
  const head = ['start stage', 'sessions', 'sessions reading', 'skill Reads', 'bytes read', 'per session', 'mean remaining-turn fraction', 'byte-weighted'];
  const lines = [`SKILL READS BY START STAGE — worker logs in ${logs}, sessions spawned in the last ${days} day(s); main-thread Reads only`,
    `| ${head.join(' | ')} |`, `|${head.map(() => '---|').join('')}`];
  for (const r of rows) lines.push(`| ${r.stage} | ${r.sessions} | ${r.reading} | ${r.reads} | ${kb(r.bytes)} | ${kb(r.bytes / r.sessions)} | ${pct(r.meanRide)} | ${pct(r.byteRide)} |`);
  return lines.join('\n');
}

export function renderFiles({ sessions, files }, stage) {
  const lines = [`SKILL FILES READ BY START STAGE ${stage} — ${sessions} session(s)`, '| file | sessions reading | reads | bytes |', '|---|---|---|---|'];
  for (const f of files) lines.push(`| ${f.file} | ${f.sessions} | ${f.reads} | ${kb(f.bytes)} |`);
  return lines.join('\n');
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const sessions = collect(o.logs, o.skills, Date.now() - o.days * 86400000);
    console.log(o.files ? renderFiles(stageFiles(sessions, o.files), o.files) : render(stageRows(sessions), o));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
