// §4 Live reads: a command the person wrote in config that fetches one real response from a live API
// (a staging endpoint behind a secret), each as `<name>: <command>`. A worker is refused the secret,
// so where it needs that response it parks naming the entry, and the pass runs the command on the
// host, in the ticket's worktree, never inside a worker. Once per ticket, head and entry, detached as
// check-build.mjs runs a build, so the next pass reads how it ended:
//
//   <dir>/<KEY>-<head>-<name>.json   { name, command, cwd, pid, started }, written as it starts
//   <dir>/<KEY>-<head>-<name>.out    what it printed on stdout: the response
//   <dir>/<KEY>-<head>-<name>.err    what it printed on stderr
//   <dir>/<KEY>-<head>-<name>.code   its exit code, written once it ends
//
// A read that exits 0 has its stdout saved to <fixtures>/<KEY>/<name>.json, where the requeued worker
// reads it.
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDetached, detachedRecord } from './check-build.mjs';
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

// The read of entry `name` recorded for ticket `key` at `head`, or null when none was started there:
// { state: 'running', command } or { state: 'done', command, code (a number, or null when it stopped
// without writing one), error (its last line on stderr, else on stdout), out (its stdout's path) }.
export function readRecord(dir, key, head, name) {
  if (!head) return null;
  const r = detachedRecord(dir, stem(key, head, name));
  if (!r) return null;
  if (r.state === 'running') return { state: 'running', command: r.rec.command };
  const out = file(dir, key, head, name, 'out');
  const error = (lastLine(file(dir, key, head, name, 'err')) || lastLine(out)).slice(0, 300);
  return { state: 'done', command: r.rec.command, code: r.code, error, out };
}

// Starts `command` with sh in cwd, detached (check-build.mjs startDetached): stdout and stderr to their
// files, its exit code to the code file. Returns the pid.
export function startRead(dir, { key, head, name, command, cwd }) {
  return startDetached(dir, stem(key, head, name), { command, cwd, streams: ['out', 'err'], label: 'live-read', record: { name } });
}

// Saves a finished read's stdout as the ticket's fixture, <fixtures>/<key>/<name>.json. Returns its path.
export function saveFixture(fixtures, key, name, out) {
  const dir = join(fixtures, key);
  mkdirSync(dir, { recursive: true });
  const to = join(dir, `${name}.json`);
  copyFileSync(out, to);
  return to;
}
