// Whether a command starts Jest or `turbo run` without a bound on its workers, and the command with
// one added. Pure, so desk-env (drift's UNBOUND line) and locked-run.mjs (with-lock.sh) share it.
//
// A command starts Jest or `turbo run` when its own words do, after an `env`, VAR=value words, a
// `mise exec … --` prefix or a one-off runner (npx, bunx, pnpm exec), or when it runs a package.json
// script one level deep (`bun|npm|pnpm|yarn run <script>`, `npm|pnpm|yarn test`) whose own command
// does. Jest's bound is --maxWorkers, turbo's --concurrency; a command or script that already sets it
// is left alone. A script is added to only when it is one simple command, as a script runner appends
// the flag to its end; npm takes it after a `--`.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const PMS = new Set(['bun', 'npm', 'pnpm', 'yarn']);
const RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
// A shell metacharacter: a command holding one is not one simple command, so nothing is added to it.
const COMPOUND = /[;&|<>`$()\n]/;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const FLAG = { jest: /^(?:--maxWorkers(?:=|$)|-w$)/, turbo: /^--concurrency(?:=|$)/ };

const words = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean);
const readScripts = (cwd) => { try { return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).scripts ?? {}; } catch { return {}; } };

// The command past what only sets up its environment or fetches the tool. -> the remaining words.
function past(ws) {
  let w = ws;
  if (['env', 'cross-env'].includes(basename(w[0] ?? ''))) w = w.slice(1);
  while (w.length && ASSIGN.test(w[0])) w = w.slice(1);
  if (basename(w[0] ?? '') === 'mise' && w[1] === 'exec' && w.includes('--')) w = w.slice(w.indexOf('--') + 1);
  if (RUNNERS.has(basename(w[0] ?? ''))) w = w.slice(1);
  else if (['pnpm', 'npm'].includes(basename(w[0] ?? '')) && w[1] === 'exec') w = w.slice(2);
  return w;
}

// The tool a command's own words start: { tool: 'jest' | 'turbo', args } or null.
function toolOf(ws) {
  const w = past(ws);
  const first = basename(w[0] ?? '');
  if (first === 'jest') return { tool: 'jest', args: w.slice(1) };
  if (first === 'turbo' && w[1] === 'run') return { tool: 'turbo', args: w.slice(2) };
  return null;
}

// The package.json script a command runs: { pm, script, extra } or null.
function scriptOf(ws) {
  const w = past(ws);
  const pm = basename(w[0] ?? '');
  if (!PMS.has(pm)) return null;
  if (w[1] === 'run' && w[2] && !w[2].startsWith('-')) return { pm, script: w[2], extra: w.slice(3) };
  if (w[1] === 'test' && pm !== 'bun') return { pm, script: 'test', extra: w.slice(2) };
  return null;
}

// What `ws` starts, with `scripts` (else `cwd`'s package.json) for a script it runs:
// -> { tool, via: null | script, simple, has, npm, dashed } or null where it starts neither tool.
// `simple` is false for a script that is not one simple command, `has` whether the bound is set already.
export function analyse(ws, { cwd = process.cwd(), scripts = null } = {}) {
  const own = toolOf(ws);
  if (own) return { tool: own.tool, via: null, simple: true, has: own.args.some((a) => FLAG[own.tool].test(a)), npm: false, dashed: false };
  const s = scriptOf(ws);
  if (!s) return null;
  const body = (scripts ?? readScripts(cwd))[s.script];
  if (typeof body !== 'string') return null;
  const t = toolOf(words(body));
  if (!t) return null;
  return { tool: t.tool, via: s.script, simple: !COMPOUND.test(body), has: [...t.args, ...s.extra].some((a) => FLAG[t.tool].test(a)), npm: s.pm === 'npm', dashed: s.extra.includes('--') };
}

export const flagFor = (tool, n) => (tool === 'jest' ? `--maxWorkers=${n}` : `--concurrency=${n}`);

// `ws` with its bound added, where it needs one and `limits` ({ jest, turbo }, each a whole number or
// null) gives it. A `sh -c '<string>'` whose string is one simple command is bounded inside the string.
// -> { words, added: [{ tool, flag }] }.
export function bound(ws, limits, opts = {}) {
  if (ws.length === 3 && ws[1] === '-c' && /^(?:ba|z|da)?sh$/.test(basename(ws[0]))) {
    const inner = words(ws[2]);
    if (COMPOUND.test(ws[2])) return { words: ws, added: [] };
    const r = bound(inner, limits, opts);
    return r.added.length ? { words: [ws[0], ws[1], [ws[2].trim(), ...r.words.slice(inner.length)].join(' ')], added: r.added } : { words: ws, added: [] };
  }
  const a = analyse(ws, opts);
  const n = a ? limits[a.tool] : null;
  if (!a || a.has || !a.simple || !n) return { words: ws, added: [] };
  const flag = flagFor(a.tool, n);
  return { words: [...ws, ...(a.npm && !a.dashed ? ['--'] : []), flag], added: [{ tool: a.tool, flag }] };
}

// Why a §4 command item starts an unbounded run, with its bounded form, or null: `cmd` and `dir` as
// parseCommandItem gives them, `root` the repo (null reads no package.json), `limits` as bound takes
// them, Jest's defaulting to 4 and turbo's to 1 so a profile with neither row still gets a proposal.
export function unbounded(cmd, { root, dir = '.', limits = {} }) {
  if (COMPOUND.test(cmd)) return null;
  const ws = words(cmd);
  const opts = root ? { cwd: join(root, dir) } : { scripts: {} };
  const a = analyse(ws, opts);
  if (!a || a.has || !a.simple) return null;
  const n = limits[a.tool] ?? (a.tool === 'jest' ? 4 : 1);
  const what = a.tool === 'jest' ? 'starts Jest with no worker cap' : 'starts turbo run with no --concurrency';
  return { tool: a.tool, why: a.via ? `runs the ${a.via} script, which ${what}` : what, bounded: bound(ws, { [a.tool]: n }, opts).words.join(' ') };
}
