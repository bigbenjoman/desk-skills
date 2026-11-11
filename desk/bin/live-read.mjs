// §4 Live reads: a command the person wrote in config that fetches one real response from a live API
// (a staging endpoint behind a secret), each as `<name>: <command>`. A worker is refused the secret,
// so where it needs that response it parks naming the entry, and the pass runs the command on the
// host, never inside a worker, and never in the ticket's worktree or the person's own checkout: in a
// clean, detached checkout of origin's default branch the pass owns (prepareCheckout), fetched and
// brought to that branch before each run, so what runs is code that has been merged, not code the
// worker wrote. The park supplies only the entry's name; the command is the config's, with no
// argument added. Once per ticket, head (the ticket's, so a worker parking on it again after its
// requeue is the person's) and entry, detached as check-build.mjs runs a build, so the next pass
// reads how it ended:
//
//   <dir>/<KEY>-<head>-<name>.json   { name, base, command, cwd, pid, started }, written as it starts
//   <dir>/<KEY>-<head>-<name>.out    what it printed on stdout: the response
//   <dir>/<KEY>-<head>-<name>.err    what it printed on stderr
//   <dir>/<KEY>-<head>-<name>.code   its exit code, written once it ends
//
// A read that exits 0 having printed at most MAX_BYTES has its stdout saved, mode 0644, to
// <fixtures>/<KEY>/<name>.json, where the requeued worker reads it as an untrusted API response.
import { readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, chmodSync, statSync, lstatSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BATCHES_DIR } from './desk-env.mjs';
import { startDetached, detachedRecord, anyRunning, hooklessGit, gitError, dirtyPaths } from './check-build.mjs';
import { parseOperatorChecks } from './fix-tries.mjs';
import { parkOnlyNames } from './undraft.mjs';

// An entry's name is a file name too, so it holds no path.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The row's items as { reads: [{ name, command }], errors: [item] }.
export function parseLiveReads(items) {
  const { checks, errors } = parseOperatorChecks(items);
  const bad = checks.filter((c) => !NAME.test(c.name));
  return { reads: checks.filter((c) => NAME.test(c.name)), errors: [...errors, ...bad.map((c) => `\`${c.name}: ${c.command}\` (a name holds only letters, digits, . _ and -)`)] };
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A name stands alone: a dot ends it only where no name character follows, so `gateway` is not named
// by `gateway.models`, and a sentence's full stop still ends it.
const names = (s, name) => new RegExp(`(?<![\\w-]|[\\w-]\\.)${escape(name.toLowerCase())}(?![\\w-]|\\.[\\w-])`).test(s);

// The entries a park asks for and nothing else: every clause names one of them or is the not-reached
// tail (undraft.mjs parkOnlyNames). [{ name, command }] in row order, or null, which leaves the park
// as it is.
export function liveReadPark(question, reads) {
  if (!reads?.length) return null;
  const q = String(question ?? '');
  if (!parkOnlyNames(q, (s) => reads.some((r) => names(s, r.name)))) return null;
  return reads.filter((r) => names(q.toLowerCase(), r.name));
}

const stem = (key, head, name) => `${key}-${head}-${name}`;
const file = (dir, key, head, name, ext) => join(dir, `${stem(key, head, name)}.${ext}`);
const lastLine = (p) => { try { return readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''; } catch { return ''; } };

// The most a read may print on stdout to be saved: over it nothing is saved and the park is the person's.
export const MAX_BYTES = 1024 * 1024;

// The read of entry `name` recorded for ticket `key` at `head`, or null when none was started there:
// { state: 'running', command } or { state: 'done', command, code (a number, or null when it stopped
// without writing one), error (its last line on stderr, else on stdout), out (its stdout's path),
// bytes (its stdout's size) }.
export function readRecord(dir, key, head, name) {
  if (!head) return null;
  const r = detachedRecord(dir, stem(key, head, name));
  if (!r) return null;
  if (r.state === 'running') return { state: 'running', command: r.rec.command };
  const out = file(dir, key, head, name, 'out');
  const error = (lastLine(file(dir, key, head, name, 'err')) || lastLine(out)).slice(0, 300);
  let bytes = 0;
  try { bytes = statSync(out).size; } catch { bytes = 0; }
  return { state: 'done', command: r.rec.command, code: r.code, error, out, bytes };
}

// Whether any read recorded in dir is still running: the checkout it runs in is not to be moved.
export const readsRunning = (dir) => anyRunning(dir);

// Starts `command` with sh in cwd (the checkout prepareCheckout made, at commit `base`), detached
// (check-build.mjs startDetached): stdout and stderr to their files, its exit code to the code file.
// Returns the pid.
export function startRead(dir, { key, head, name, command, cwd, base }) {
  return startDetached(dir, stem(key, head, name), { command, cwd, streams: ['out', 'err'], label: 'live-read', record: { name, base } });
}

// Brings the pass's own checkout at `dir` to origin's `branch`, cloning `origin` there first if it is
// not yet a checkout: fetched, detached at the fetched commit, and clean, ignored files included.
// Nothing is cleaned or reset away: a checkout something wrote into is reported, not wiped, so the
// person sees what did. { ok: true, sha } or { ok: false, why }.
export function prepareCheckout(dir, { origin, branch }) {
  const git = hooklessGit(120000);
  const tail = gitError;
  if (!origin) return { ok: false, why: 'the primary checkout has no origin remote to clone it from' };
  if (!existsSync(join(dir, '.git'))) {
    if (existsSync(dir) && readdirSync(dir).length) return { ok: false, why: `${dir} is not a git checkout, and is not empty` };
    const c = git('clone', '--quiet', '--', origin, dir);
    if (c.status !== 0) return { ok: false, why: `cloning ${origin} into ${dir} failed: ${tail(c)}` };
  }
  const ref = `refs/remotes/origin/${branch}`;
  // From `origin` as given, not the remote the clone recorded, so a moved origin is followed.
  const f = git('-C', dir, 'fetch', '--quiet', '--', origin, `+refs/heads/${branch}:${ref}`);
  if (f.status !== 0) return { ok: false, why: `fetching origin's ${branch} into ${dir} failed: ${tail(f)}` };
  const s = git('-C', dir, 'status', '--porcelain', '--ignored', '--untracked-files=all');
  if (s.status !== 0) return { ok: false, why: `reading ${dir}'s status failed: ${tail(s)}` };
  if (s.stdout.trim()) return { ok: false, why: `${dir} is not clean (${dirtyPaths(s.stdout)})` };
  const co = git('-C', dir, 'checkout', '--quiet', '--detach', ref);
  if (co.status !== 0) return { ok: false, why: `checking out origin's ${branch} in ${dir} failed: ${tail(co)}` };
  const head = git('-C', dir, 'rev-parse', 'HEAD').stdout.trim();
  const want = git('-C', dir, 'rev-parse', ref).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(head) || head !== want) return { ok: false, why: `${dir} is at ${head.slice(0, 9) || 'no commit'}, not origin's ${branch} ${want.slice(0, 9)}` };
  return { ok: true, sha: head };
}

// Saves a finished read's stdout as the ticket's fixture, <fixtures>/<key>/<name>.json, mode 0644.
// Returns its path.
export function saveFixture(fixtures, key, name, out) {
  const dir = join(fixtures, key);
  mkdirSync(dir, { recursive: true });
  const to = join(dir, `${name}.json`);
  copyFileSync(out, to);
  chmodSync(to, 0o644);
  return to;
}

// Where a ticket's fixtures are copied in its worktree, relative to the root: untracked, and kept out
// of git status by the worktree's info/exclude.
export const WORKTREE_FIXTURES = '.desk-fixtures';

// The repo's own state folder for a state folder that may be a named batch's (<repo state>/batches/<name>).
export const repoStateOf = (state) => state.replace(new RegExp(`[/\\\\]${BATCHES_DIR}[/\\\\][^/\\\\]+[/\\\\]?$`), '');

// Copies ticket `key`'s fixtures into `worktree`/WORKTREE_FIXTURES/<key>/, from <state>/fixtures/<key>/
// and, for a named batch, the repo state's, where a person saves them and which a worker cannot read.
// Only regular files of at most `max` bytes are copied; a name in both folders is copied from the
// batch's. A file over the limit, a name holding a path separator, or anything that is not a regular
// file (a symlink, a folder) is left, with why. Returns null when neither folder exists, otherwise
// { dir, copied: [name], refused: [{ name, why }] }.
export function copyFixtures({ state, key, worktree, max = MAX_BYTES }) {
  const from = [...new Set([state, repoStateOf(state)])].map((s) => join(s, 'fixtures', key)).filter((d) => existsSync(d));
  if (!from.length) return null;
  const dir = join(worktree, WORKTREE_FIXTURES, key);
  const copied = [];
  const refused = [];
  for (const src of from) {
    for (const name of readdirSync(src).sort()) {
      if (copied.includes(name)) continue;
      if (/[/\\]/.test(name)) { refused.push({ name, why: 'its name holds a path separator' }); continue; }
      const st = lstatSync(join(src, name));
      if (!st.isFile()) { refused.push({ name, why: `it is ${st.isSymbolicLink() ? 'a symlink' : 'not a file'}` }); continue; }
      if (st.size > max) { refused.push({ name, why: `it is ${st.size} bytes, over the ${max}-byte copy limit` }); continue; }
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(src, name), join(dir, name));
      chmodSync(join(dir, name), 0o644);
      copied.push(name);
    }
  }
  if (copied.length) excludeFromGit(worktree, `/${WORKTREE_FIXTURES}/`);
  return { dir, copied, refused };
}

// Adds `pattern` to the worktree's info/exclude, once, so it stays out of git status without touching
// the repo's .gitignore (setup-worktree.sh exclude_from_git).
function excludeFromGit(worktree, pattern) {
  const r = spawnSync('git', ['-C', worktree, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' });
  if (r.status !== 0) return;
  const excl = resolve(worktree, r.stdout.trim());
  const now = existsSync(excl) ? readFileSync(excl, 'utf8') : '';
  if (now.split('\n').includes(pattern)) return;
  mkdirSync(dirname(excl), { recursive: true });
  appendFileSync(excl, `${now && !now.endsWith('\n') ? '\n' : ''}${pattern}\n`);
}
