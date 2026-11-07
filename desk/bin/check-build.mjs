// §4 Check builds: a host-side build that clears a named check, run by the pass for a draft PR whose
// only red checks are named in the row (undraft.mjs buildCall decides when). It runs on the host, in
// the ticket's worktree at the PR's head, never inside a worker: it needs what the person's shell has
// (a Docker context, cloud credentials). Once per PR head:
//
//   <dir>/<n>-<head>.json   { command, checks, cwd, pid, started }, written as it starts
//   <dir>/<n>-<head>.log    everything it printed
//   <dir>/<n>-<head>.code   its exit code, written once it ends
//   <dir>/<n>-<head>.reran  { ok, out, at }: the re-run of its checks with --failed, once it succeeded
//
// The build runs detached, so a pass that ends (or is killed at its timeout) leaves it running; the
// next pass reads its code. startDetached and detachedRecord are that mechanism, which live-read.mjs
// runs its reads with too.
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

// The last lines of a build's output that its record quotes.
export const TAIL_LINES = 5;

const file = (dir, n, head, ext) => join(dir, `${n}-${head}.${ext}`);
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// Starts `command` with sh in cwd, detached, as <dir>/<stem>: its record { ...record, command, cwd,
// pid, started } to .json, stdout and stderr to the one file `streams` names, or to each of two, and
// its exit code to .code once it ends. `label` is the process's name. Returns the pid.
export function startDetached(dir, stem, { command, cwd, streams, label, record = {} }) {
  mkdirSync(dir, { recursive: true });
  const fds = streams.map((ext) => openSync(join(dir, `${stem}.${ext}`), 'w'));
  const child = spawn('sh', ['-c', '(eval "$1"); c=$?; echo "$c" > "$2.tmp" && mv "$2.tmp" "$2"', label, command, join(dir, `${stem}.code`)],
    { cwd, detached: true, stdio: ['ignore', fds[0], fds[1] ?? fds[0]] });
  fds.forEach((fd) => closeSync(fd));
  child.unref();
  writeFileSync(join(dir, `${stem}.json`), `${JSON.stringify({ ...record, command, cwd, pid: child.pid, started: new Date().toISOString() })}\n`);
  return child.pid;
}

// The command startDetached recorded as <dir>/<stem>, or null when none was: { state: 'running', rec }
// or { state: 'done', rec, code (a number, or null when it stopped without writing one) }.
export function detachedRecord(dir, stem) {
  const rec = readJson(join(dir, `${stem}.json`));
  if (!rec) return null;
  let code = null;
  try { code = readFileSync(join(dir, `${stem}.code`), 'utf8').trim(); } catch { code = null; }
  if (code === null && alive(rec.pid)) return { state: 'running', rec };
  return { state: 'done', rec, code: code !== null && /^-?\d+$/.test(code) ? Number(code) : null };
}

// The build recorded for PR n at head, or null when none was started there:
// { state: 'running' | 'done', command, checks, code (a number, or null when it stopped without
// writing one), tail, reran }.
export function buildRecord(dir, n, head) {
  if (!head) return null;
  const r = detachedRecord(dir, `${n}-${head}`);
  if (!r) return null;
  const { rec } = r;
  if (r.state === 'running') return { state: 'running', command: rec.command, checks: rec.checks ?? [] };
  let out = '';
  try { out = readFileSync(file(dir, n, head, 'log'), 'utf8'); } catch { out = ''; }
  const tail = out.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-TAIL_LINES).join(' / ');
  return { state: 'done', command: rec.command, checks: rec.checks ?? [], code: r.code, tail, reran: readJson(file(dir, n, head, 'reran')) };
}

// Starts `command` with sh in cwd, detached, its output to the log and its exit code to the code file.
// Returns the pid.
export function startBuild(dir, { n, head, command, checks, cwd }) {
  return startDetached(dir, `${n}-${head}`, { command, cwd, streams: ['log'], label: 'check-build', record: { checks } });
}

// Records the re-run of a build's checks, so it is tried once per head.
export function markReran(dir, n, head, { ok, out }) {
  writeFileSync(file(dir, n, head, 'reran'), `${JSON.stringify({ ok, out: out ?? '', at: new Date().toISOString() })}\n`);
}
