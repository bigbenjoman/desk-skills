// `desk-env lines <file> <A>[,<B>|,$]`: one file's line range, as `sed -n A,Bp <file>` prints it, as a
// single command a worker can chain nothing onto. It reads only what the worker's own reading tools
// may: never this repo's desk credentials directory, and in a worker only its worktree and the
// directories its settings grant, which worker-settings.mjs writes beside them (wrappersFile).
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

// '12,40' | '12' | '12,$' -> { from, to } (to null: to the end of the file), or null.
export function parseRange(spec) {
  const m = /^([1-9][0-9]*)(?:,([1-9][0-9]*|\$))?$/.exec(String(spec ?? ''));
  if (!m) return null;
  const from = Number(m[1]);
  return { from, to: m[2] === undefined ? from : m[2] === '$' ? null : Number(m[2]) };
}

// Lines from..to with their line endings, as `sed -n` prints them: a start past the end prints
// nothing, and an end before the start prints the start line alone.
export function sliceLines(text, { from, to }) {
  const lines = text.split(/(?<=\n)/).filter((l) => l !== '');
  return lines.slice(from - 1, to == null ? lines.length : Math.max(to, from)).join('');
}

// The sidecar worker-settings.mjs writes beside a worker's settings file.
export const wrappersFile = (settings) => `${settings.replace(/\.json$/, '')}.wrappers.json`;

// In a worker (DESK_AUTOPILOT_WORKER=1), what its settings let it read: { dirs, creds }. Outside one,
// null. A worker whose sidecar cannot be read throws, so the read is refused rather than unchecked.
export function workerReads(env = process.env) {
  if (env.DESK_AUTOPILOT_WORKER !== '1') return null;
  if (!env.DESK_WORKER_SETTINGS) throw new Error('DESK_WORKER_SETTINGS is not set, so the directories this worker may read are unknown');
  const file = wrappersFile(env.DESK_WORKER_SETTINGS);
  let w;
  try { w = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`cannot read ${file}, so the directories this worker may read are unknown`); }
  if (!Array.isArray(w.dirs) || !w.dirs.length) throw new Error(`${file} names no directory this worker may read`);
  return { dirs: w.dirs, creds: w.creds ?? null };
}

const real = (p) => { try { return realpathSync(p); } catch { return null; } };
const within = (p, dir) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
const forms = (p) => [...new Set([resolve(p), real(p)].filter(Boolean))];

// Why a worker's reading tools would refuse this path, or null. `creds`: this repo's credentials
// directory (cat and every other reading tool are denied any argument naming it). `dirs`: null
// outside a worker, else every directory it may read. The path and its real path are both checked.
export function readRefusal(path, { creds = null, dirs = null } = {}) {
  const at = forms(path);
  if (creds && forms(creds).some((c) => at.some((p) => within(p, c)))) {
    return `${path} is in this repo's desk credentials directory, which no worker's reading tools may read`;
  }
  if (dirs && !at.every((p) => dirs.flatMap(forms).some((d) => within(p, d)))) {
    return `${path} is outside your worktree and the directories your settings let you read`;
  }
  return null;
}
