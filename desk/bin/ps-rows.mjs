// Reading the process table: desk's one `ps` call and its parser. Node's own modules only, so
// lock-caller-watch.mjs, which every locked run starts, loads nothing else to read it. desk-env.mjs
// psRows is this with its build memo on top.
import { spawnSync } from 'node:child_process';

// Every process's command line can carry a worker's whole prompt, so the list runs to megabytes.
const PS_MAX_BUFFER = 64 * 1024 * 1024;
const PS_NUMERIC = new Set(['pid', 'ppid', 'pgid', 'rss']);
// `ps` output for `columns` (e.g. 'pid=,args=') as one object per process keyed by column name:
// every column but the last is one word, the last runs to the end of the line. pid, ppid, pgid and
// rss are numbers. A line of another shape is skipped.
export function parsePs(text, columns) {
  const names = columns.split(',').map((c) => c.replace(/=.*$/, ''));
  const re = new RegExp(`^\\s*${names.slice(0, -1).map(() => '(\\S+)\\s+').join('')}(.*?)\\s*$`);
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = re.exec(line);
    if (!m || !line.trim()) continue;
    rows.push(Object.fromEntries(names.map((n, i) => [n, PS_NUMERIC.has(n) ? Number(m[i + 1]) : m[i + 1]])));
  }
  return rows;
}

// One `ps` for `columns`, as spawnSync's result. `env` adds to ps's environment.
export const runPs = (columns, env = {}) => spawnSync('ps', ['-ww', '-axo', columns], { encoding: 'utf8', maxBuffer: PS_MAX_BUFFER, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });

// Every process, read whole from one `ps`. Throws when ps cannot be read, rather than giving a
// partial or empty list. `env` adds to ps's environment (e.g. TZ and LC_ALL for lstart); `run` gives
// ps's result for (columns, env), runPs by default.
export function psRows(columns, env = {}, run = runPs) {
  const r = run(columns, env);
  if (r.error || r.status !== 0) {
    const why = r.error?.code ?? r.error?.message ?? (`${r.stderr ?? ''}`.trim().split('\n').pop() || `exit ${r.status ?? r.signal}`);
    throw new Error(`ps could not be read (${why})`);
  }
  return parsePs(r.stdout, columns);
}
