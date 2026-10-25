#!/usr/bin/env node
// Who runs this repo's batches once Stage 3 has asked: config §3b "Batches run by", `supervisor`
// (launchd runs the passes and the merge driver, supervisor.mjs) or `session` (this session, through
// /loop). Unset is `session`, so a repo set up before the row keeps running batches in the session.
// Run it from inside the repo, as supervisor.mjs is. Each command prints one JSON object.
//   node run-by.mjs offer     /desk-setup §3b: on macOS {ask: true, recommended, options}; elsewhere
//                             {ask: false, value: 'session', line}, the value to record and why
//   node run-by.mjs ensure    the supervisor installed and loaded for this repo, installing it if not:
//                             {ok, installed, error, retry}. Exit 0 when ok, 11 otherwise
//   node run-by.mjs stage4    Stage 4: {by: 'supervisor' | 'session', note, installed, error, retry}.
//                             At `supervisor`, a missing or unloaded supervisor is installed without
//                             asking (the row is the consent); an install that fails runs the batch in
//                             the session and exits 11 with the error and the command to retry
// The supervisor runner, its status reader and turnOn are desk-q's too (`desk-q <repo> supervisor`).
// DESK_SUPERVISOR_MJS and DESK_PLATFORM stand in for the script and the platform in tests.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const supervisorMjs = () => process.env.DESK_SUPERVISOR_MJS || join(HERE, 'supervisor.mjs');
export const platform = () => process.env.DESK_PLATFORM || process.platform;
const ROW = () => E.CONFIG_ROWS['batches-run-by'].row;
export const VALUES = ['supervisor', 'session'];
export const NO_LAUNCHD = 'the supervisor needs macOS launchd, so batches run in the session on this computer';
const RETRY = 'node ~/.claude/desk/bin/supervisor.mjs install';

// The row's value: `supervisor` or `session`, with a note when it was unset or unreadable.
//   -> { value, note }
export function runBySetting(raw = E.configValue('batches-run-by')) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (VALUES.includes(v)) return { value: v, note: null };
  if (v === '') return { value: 'session', note: `config §3b "${ROW()}" is not set, so this batch runs in this session; /desk-setup can set it` };
  return { value: 'session', note: `config §3b "${ROW()}" is "${raw}" — want \`supervisor\` or \`session\`; read as session` };
}

// supervisor.mjs <sub> <args>, in `cwd` with `env` (this process's when unset): its lines, without
// their `supervisor: ` prefix.  -> { code, out: [line], err }
export function supervisorRun(sub, args = [], { cwd, env } = {}) {
  const p = spawnSync(process.execPath, [supervisorMjs(), sub, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const said = (s) => String(s ?? '').trim().split('\n').filter(Boolean).map((l) => l.replace(/^supervisor: /, ''));
  return { code: p.status, out: said(p.stdout), err: said(p.stderr).join(' ') || p.error?.message || `exited ${p.status ?? p.signal}` };
}

// The agent's state from `supervisor.mjs status`: 'loaded', 'installed' (not loaded) or 'none', its
// interval, and the log's last line. null, with the error, when status printed no agent line.
//   -> { state, every, last } | { state: null, err }
export function supervisorState(run = supervisorRun) {
  const s = run('status');
  const agent = s.out.find((l) => l.startsWith('agent: '));
  if (!agent) return { state: null, err: s.err };
  const m = /installed \(every (\S+?)s\), (loaded|not loaded)/.exec(agent);
  const at = s.out.findIndex((l) => l.startsWith('log: '));
  return { state: !m ? 'none' : m[2] === 'loaded' ? 'loaded' : 'installed', every: m?.[1] ?? null, last: at < 0 || at === s.out.length - 1 ? null : s.out.at(-1).trim() };
}

// Install an agent that is not loaded. One already installed keeps its interval: install writes the
// default otherwise. A failed load can leave a new agent file behind; with none before, it goes again.
//   -> install's { code, out, err }
export function turnOn(was, run = supervisorRun) {
  const s = run('install', /^\d+$/.test(was.every ?? '') ? ['--interval', was.every] : []);
  if (s.code !== 0 && was.state !== 'installed') run('uninstall');
  return s;
}

const retryIn = () => { try { return `${RETRY} (run in ${E.repoRoot()})`; } catch { return `${RETRY} (run inside the repo)`; } };

export function ensure() {
  if (platform() !== 'darwin') return { ok: false, installed: false, error: NO_LAUNCHD, retry: null };
  const was = supervisorState();
  if (was.state === 'loaded') return { ok: true, installed: false, error: null, retry: null };
  const i = turnOn(was);
  if (i.code !== 0) return { ok: false, installed: false, error: i.err, retry: retryIn() };
  if (supervisorState().state !== 'loaded') return { ok: false, installed: false, error: `installed, but launchd has not loaded it: ${i.out.join(' ')}`, retry: retryIn() };
  return { ok: true, installed: true, error: null, retry: null };
}

export function stage4() {
  const { value, note } = runBySetting();
  if (value === 'session') return { by: 'session', note, installed: false, error: null, retry: null };
  if (platform() !== 'darwin') return { by: 'session', note: `config §3b "${ROW()}" is supervisor, but ${NO_LAUNCHD}`, installed: false, error: null, retry: null };
  const r = ensure();
  if (!r.ok) return { by: 'session', note: null, installed: false, error: r.error, retry: r.retry };
  return { by: 'supervisor', note: r.installed ? 'the supervisor was not installed and loaded for this repo, so it was installed' : null, installed: r.installed, error: null, retry: null };
}

export function offer() {
  if (platform() !== 'darwin') return { ask: false, value: 'session', line: `${ROW()}: session, because ${NO_LAUNCHD}.` };
  return { ask: true, recommended: 'supervisor', options: VALUES };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd] = process.argv.slice(2);
  const out = { offer, ensure, stage4 }[cmd];
  if (!out) { console.error('usage: run-by.mjs offer | ensure | stage4'); process.exit(2); }
  try {
    const r = out();
    console.log(JSON.stringify(r));
    process.exitCode = r.ok === false || r.error ? 11 : 0;
  } catch (e) { console.error(`run-by: ${e.message}`); process.exit(11); }
}
