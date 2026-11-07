// §4 Check builds: a host-side build that clears a named check, run by the pass for a draft PR whose
// only red checks are named in the row (undraft.mjs buildCall decides when). It runs on the host,
// never inside a worker: it needs what the person's shell has (a Docker context, cloud credentials).
// So what runs is never code the worker wrote: the command runs from the pass's clean checkout of
// origin's default branch (live-read.mjs prepareCheckout, the one Live reads run from), never the
// ticket's worktree, and gets the PR's head only as data: DESK_CHECK_HEAD, its SHA, and
// DESK_CHECK_TREE, a clean detached checkout of it the pass owns (prepareTree), one per PR. Once per
// PR head:
//
//   <dir>/<n>-<head>.json   { command, checks, base, head, tree, cwd, pid, started }, written as it starts
//   <dir>/<n>-<head>.log    everything it printed
//   <dir>/<n>-<head>.code   its exit code, written once it ends
//   <dir>/<n>-<head>.reran  { ok, out, at }: the re-run of its checks with --failed, once it succeeded
//
// The build runs detached, so a pass that ends (or is killed at its timeout) leaves it running; the
// next pass reads its code. startDetached and detachedRecord are that mechanism, which live-read.mjs
// runs its reads with too.
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
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
// its exit code to .code once it ends. `label` is the process's name, and `env` is added to the
// pass's environment. Returns the pid.
export function startDetached(dir, stem, { command, cwd, streams, label, record = {}, env = {} }) {
  mkdirSync(dir, { recursive: true });
  const fds = streams.map((ext) => openSync(join(dir, `${stem}.${ext}`), 'w'));
  const child = spawn('sh', ['-c', '(eval "$1"); c=$?; echo "$c" > "$2.tmp" && mv "$2.tmp" "$2"', label, command, join(dir, `${stem}.code`)],
    { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', fds[0], fds[1] ?? fds[0]] });
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

// Whether any command recorded in dir (those whose stem starts with `prefix`, where one is given) is
// still running.
export function anyRunning(dir, prefix = '') {
  let names = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith('.json') && f.startsWith(prefix)); } catch { return false; }
  return names.some((f) => detachedRecord(dir, f.slice(0, -5))?.state === 'running');
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

// Starts `command` with sh in cwd (the pass's checkout of the default branch, at commit `base`),
// detached, its output to the log and its exit code to the code file, with DESK_CHECK_HEAD=head and
// DESK_CHECK_TREE=tree (prepareTree's checkout of head). Returns the pid.
export function startBuild(dir, { n, head, command, checks, cwd, tree, base }) {
  return startDetached(dir, `${n}-${head}`, { command, cwd, streams: ['log'], label: 'check-build', record: { checks, base, head, tree },
    env: { DESK_CHECK_HEAD: head, DESK_CHECK_TREE: tree } });
}

// Brings the pass's own checkout of PR head `head` at `dir` there, cloning it first (from `seed`, a
// local clone of origin, where given) if it is not yet a checkout: the PR's `branch` and the default
// `base` fetched from `origin`, then the head itself where the branch did not bring it, detached at the
// head, and every other file removed, ignored ones included. The checkout is desk's, one per PR, so
// unlike prepareCheckout it is reset rather than refused: nothing a build left there reaches the next.
// { ok: true } or { ok: false, why }.
export function prepareTree(dir, { origin, seed, head, branch, base }) {
  const git = (...a) => spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...a], { encoding: 'utf8', timeout: 300000 });
  const tail = (r) => String(r.stderr || r.stdout || r.error?.message || '').trim().split('\n').pop() || `exit ${r.status}`;
  if (!origin) return { ok: false, why: 'the primary checkout has no origin remote to fetch the head from' };
  if (!/^[0-9a-f]{40}$/.test(String(head))) return { ok: false, why: `the head ${head} is not a commit SHA` };
  if (!existsSync(join(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true });
    const c = git('clone', '--quiet', '--no-checkout', '--', seed && existsSync(join(seed, '.git')) ? seed : origin, dir);
    if (c.status !== 0) return { ok: false, why: `cloning a checkout for the head into ${dir} failed: ${tail(c)}` };
  }
  const refs = [base, branch].filter(Boolean).map((b) => `+refs/heads/${b}:refs/remotes/origin/${b}`);
  if (refs.length) git('-C', dir, 'fetch', '--quiet', '--', origin, ...refs);
  const has = () => git('-C', dir, 'cat-file', '-e', `${head}^{commit}`).status === 0;
  if (!has()) {
    const f = git('-C', dir, 'fetch', '--quiet', '--', origin, head);
    if (f.status !== 0 || !has()) return { ok: false, why: `fetching the head ${head.slice(0, 9)} from origin into ${dir} failed: ${f.status !== 0 ? tail(f) : 'it is not there'}` };
  }
  const co = git('-C', dir, 'checkout', '--quiet', '--force', '--detach', head);
  if (co.status !== 0) return { ok: false, why: `checking out the head ${head.slice(0, 9)} in ${dir} failed: ${tail(co)}` };
  const cl = git('-C', dir, 'clean', '-ffdxq');
  if (cl.status !== 0) return { ok: false, why: `cleaning ${dir} failed: ${tail(cl)}` };
  const s = git('-C', dir, 'status', '--porcelain', '--ignored', '--untracked-files=all');
  if (s.status !== 0 || s.stdout.trim()) return { ok: false, why: `${dir} is not clean at the head ${head.slice(0, 9)}${s.stdout.trim() ? ` (${s.stdout.trim().split('\n').slice(0, 5).map((l) => l.slice(3)).join(', ')})` : ''}` };
  const at = git('-C', dir, 'rev-parse', 'HEAD').stdout.trim();
  if (at !== head) return { ok: false, why: `${dir} is at ${at.slice(0, 9) || 'no commit'}, not the head ${head.slice(0, 9)}` };
  return { ok: true };
}

// Removes each PR's checkout under dir (prepareTree's, named by PR number) that `keep(n)` does not
// keep and no build of that PR still runs in, as recorded in builds. Returns [{ n, why }] for each
// that could not be removed.
export function pruneTrees(dir, builds, keep) {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const failed = [];
  for (const n of names) {
    if (keep(n) || anyRunning(builds, `${n}-`)) continue;
    try { rmSync(join(dir, n), { recursive: true, force: true }); } catch (e) { failed.push({ n, why: e.message }); }
  }
  return failed;
}

// Records the re-run of a build's checks, so it is tried once per head.
export function markReran(dir, n, head, { ok, out }) {
  writeFileSync(file(dir, n, head, 'reran'), `${JSON.stringify({ ok, out: out ?? '', at: new Date().toISOString() })}\n`);
}
