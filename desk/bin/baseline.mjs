// Baseline checks: the typecheck and lint errors a batch base already has, so a worker's check fails
// only on errors its branch adds.
//
// With config §4 "Baseline checks" on and a batch base, pass.mjs records the base's §4 Typecheck and
// Lint output in the base worktree before a pass spawns, whenever the base has moved since the last
// record. A worker runs `desk-env baseline typecheck|lint`, which runs the same commands in its own
// worktree and compares. Errors are counted per file, rule and message, never by line number, so an
// edit that moves a recorded error is not a new one, and a second identical error in one file is.
// Output the comparison cannot read, on either side, falls back to the full check and says so. CI and
// the pre-push hook keep running the full checks.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

// Each check and the §4 row it runs; the lock each takes is desk-env's lockFor(row).
export const CHECKS = { typecheck: 'typecheck-cmd', lint: 'lint-cmd' };

// ---- parsers -------------------------------------------------------------------------------------
// Each takes a run's combined output and returns { problems: [{ file, line, rule, message }], total }
// (`total` is the count the tool's own summary states, or null), or null when the output is not that
// tool's.

// tsc, plain (`src/a.ts(3,5): error TS2322: …`) and --pretty (`src/a.ts:3:5 - error TS2322: …`). An
// error with no file (`error TS5058: …`) is a config error, kept with an empty file. The indented
// lines straight after an error elaborate it, and are part of its message.
export function parseTsc(out) {
  const problems = [];
  let total = null;
  let last = null;
  const plain = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/;
  const pretty = /^(.+?):(\d+):\d+ - error (TS\d+): (.*)$/;
  const bare = /^error (TS\d+): (.*)$/;
  for (const raw of String(out).split('\n')) {
    const l = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
    const m = plain.exec(l) ?? pretty.exec(l);
    if (m) { last = { file: m[1], line: Number(m[2]), rule: m[3], message: m[4].trim() }; problems.push(last); continue; }
    const b = bare.exec(l);
    if (b) { last = { file: '', line: 0, rule: b[1], message: b[2].trim() }; problems.push(last); continue; }
    if (last && /^ {2,}\S/.test(l)) { last.message += ` ${l.trim()}`; continue; }
    last = null;
    const f = /^Found (\d+) errors?\b/.exec(l);
    if (f) total = Number(f[1]);
  }
  return problems.length || total != null ? { problems, total } : null;
}

// ESLint's default (stylish) format: a file path line, then `  3:5  error  <message>  <rule>` lines,
// then `✖ 4 problems (3 errors, 1 warning)`. Warnings count too: a lint run that fails on
// --max-warnings fails on them. A parsing error has no rule.
export function parseEslint(out) {
  const problems = [];
  let total = null;
  let file = null;
  const row = /^\s+(\d+):\d+\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/;
  for (const raw of String(out).split('\n')) {
    const l = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
    const s = /^\S+\s+(\d+) problems? \(\d+ errors?, \d+ warnings?\)/.exec(l);
    if (s) { total = Number(s[1]); file = null; continue; }
    const m = row.exec(l);
    if (m && file != null) { problems.push({ file, line: Number(m[1]), rule: m[4] ?? '', message: m[3].trim() }); continue; }
    if (l && !/^\s/.test(l)) file = l;
  }
  return problems.length || total != null ? { problems, total } : null;
}

// mypy: `src/a.py:3: error: <message>  [code]`, with or without a column. Notes are not errors.
export function parseMypy(out) {
  const problems = [];
  let total = null;
  for (const raw of String(out).split('\n')) {
    const l = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
    const m = /^(.+?):(\d+):(?:\d+:)? error: (.*?)(?:\s+\[([a-z0-9-]+)\])?$/.exec(l);
    if (m) { problems.push({ file: m[1], line: Number(m[2]), rule: m[4] ?? '', message: m[3].trim() }); continue; }
    const f = /^Found (\d+) errors? in \d+ files?/.exec(l);
    if (f) total = Number(f[1]);
    if (/^Success: no issues found/.test(l)) total = 0;
  }
  return problems.length || total != null ? { problems, total } : null;
}

const PARSERS = { tsc: parseTsc, eslint: parseEslint, mypy: parseMypy };

// A run's problems, or why they cannot be read. A clean exit is read as no problems when nothing
// parses. A failing run must exit as a check does when it finds errors (1 or 2), must parse, and where
// the tool states a count, the parse must match it. Lines carrying a task runner's prefix
// (`web:typecheck: src/a.ts(3,5): …`) are refused: a runner that stops at its first failing package
// never prints the rest, so a new error there would read as nothing new. Anything else is output this
// file does not understand, and the caller runs the full check.
//   -> { ok: true, tool, problems } | { ok: false, why }
export function readRun({ out, code }) {
  if (code !== 0 && code !== 1 && code !== 2) return { ok: false, why: `it exited ${code}, which is not how a check reports the errors it found` };
  const found = Object.entries(PARSERS).map(([tool, p]) => ({ tool, r: p(out) })).filter((x) => x.r);
  const best = found.sort((a, b) => b.r.problems.length - a.r.problems.length)[0];
  if (!best) return code === 0 ? { ok: true, tool: null, problems: [] } : { ok: false, why: `it exited ${code} and printed nothing read as tsc, ESLint or mypy output` };
  const { problems, total } = best.r;
  if (total != null && total !== problems.length) return { ok: false, why: `${best.tool} reported ${total} problem(s) but ${problems.length} could be read` };
  if (code !== 0 && !problems.length) return { ok: false, why: `it exited ${code} with no problem listed` };
  if (problems.some((p) => /:\s/.test(p.file))) return { ok: false, why: 'its lines carry a task runner\'s prefix, and a runner that stops at its first failing package hides the rest' };
  return { ok: true, tool: best.tool, problems };
}

// ---- record and compare --------------------------------------------------------------------------
// Paths are made relative to the worktree root, and the root inside a message becomes `<root>`, so
// the base worktree and a worker's compare equal.
export function normalise(problems, { root, dir }) {
  const roots = [root];
  try { roots.push(realpathSync(root)); } catch { /* the root as given */ }
  const longest = [...new Set(roots)].sort((a, b) => b.length - a.length);
  return problems.map((p) => {
    const message = longest.reduce((m, r) => m.split(r).join('<root>'), p.message);
    if (!p.file) return { ...p, message };
    const abs = isAbsolute(p.file) ? p.file : resolve(root, dir, p.file);
    const under = roots.map((r) => relative(r, abs)).find((x) => !x.startsWith('..') && !isAbsolute(x));
    return { ...p, file: under ?? abs, message };
  });
}

export const keyOf = (p) => `${p.file}\t${p.rule}\t${p.message}`;
export function counts(problems) {
  const c = {};
  for (const p of problems) c[keyOf(p)] = (c[keyOf(p)] ?? 0) + 1;
  return c;
}

// The problems in `problems` beyond what `recorded` (a counts() map) allows: for each file, rule and
// message, every occurrence past the recorded number is new.
export function newProblems(problems, recorded) {
  const left = { ...recorded };
  const extra = [];
  for (const p of problems) {
    const k = keyOf(p);
    if ((left[k] ?? 0) > 0) left[k] -= 1;
    else extra.push(p);
  }
  return extra;
}

// One command item, in `root`, under its lock. -> { out, code }
export function runItem({ bin, root, dir, cmd, lock, prefix = '' }) {
  const full = prefix ? `${prefix} ${cmd}` : cmd;
  const r = spawnSync(join(bin, 'with-lock.sh'), [lock, '--cwd', dir, '--', 'sh', '-c', full], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status ?? 1 };
}

export const baselineFile = (stateDir) => join(stateDir, 'baseline.json');
export function readBaseline(stateDir) {
  try { return JSON.parse(readFileSync(baselineFile(stateDir), 'utf8')); } catch { return null; }
}

// Runs every Typecheck and Lint item in the base worktree and writes the baseline. `items` is
// { typecheck: [{dir, cmd}], lint: [...] }; `run({ name, dir, cmd })` runs one and returns { out, code }.
//   -> the baseline written: { base, sha, at, checks: { typecheck: [entry], lint: [entry] } }, where an
//      entry is { dir, cmd, ok, tool, count, errors } or { dir, cmd, ok: false, why }
export function recordBaseline({ stateDir, root, base, sha, items, run }) {
  const checks = {};
  for (const name of Object.keys(CHECKS)) {
    checks[name] = (items[name] ?? []).map(({ dir, cmd }) => {
      const r = readRun(run({ name, dir, cmd }));
      if (!r.ok) return { dir, cmd, ok: false, why: r.why };
      const problems = normalise(r.problems, { root, dir });
      return { dir, cmd, ok: true, tool: r.tool, count: problems.length, errors: counts(problems) };
    });
  }
  const b = { base, sha, at: new Date().toISOString(), checks };
  mkdirSync(stateDir, { recursive: true });
  const f = baselineFile(stateDir);
  writeFileSync(`${f}.tmp`, `${JSON.stringify(b, null, 2)}\n`);
  renameSync(`${f}.tmp`, f);
  return b;
}

// One line per check for the pass report: `typecheck 12 error(s)` or why workers run it in full.
export function summary(b) {
  return Object.entries(b.checks).filter(([, es]) => es.length).map(([name, es]) => {
    const bad = es.filter((e) => !e.ok);
    if (bad.length) return `${name} unreadable (${bad.map((e) => `${e.cmd}: ${e.why}`).join('; ')}), so workers run it in full`;
    return `${name} ${es.reduce((n, e) => n + e.count, 0)} error(s)`;
  }).join(' · ') || 'no Typecheck or Lint command to record';
}

// Compares one fresh run against its recorded entry. -> { pass, lines, full }
//   full: true when the comparison could not be made and the run's own exit decides, as it does today.
export function compareRun({ entry, run, root, dir, cmd }) {
  const head = `${dir === '.' ? '' : `${dir}: `}${cmd}`;
  const fullCheck = (why) => ({
    pass: run.code === 0, full: true,
    lines: [`FULL ${head}: ${why}, so this is the full check (exit ${run.code})`, ...(run.code === 0 ? [] : [run.out.trimEnd()])],
  });
  if (run.code === 0) return { pass: true, full: false, lines: [`PASS ${head}: no errors`] };
  if (!entry) return fullCheck('the baseline has no record of this command');
  if (!entry.ok) return fullCheck(`the base's output could not be read (${entry.why})`);
  const r = readRun(run);
  if (!r.ok) return fullCheck(`this run's output could not be read (${r.why})`);
  const extra = newProblems(normalise(r.problems, { root, dir }), entry.errors);
  if (!extra.length) return { pass: true, full: false, lines: [`PASS ${head}: only the ${r.problems.length} error(s) the base already has`] };
  return {
    pass: false, full: false,
    lines: [`FAIL ${head}: ${extra.length} new error(s) beyond the base's ${entry.count}`,
      ...extra.map((p) => `  ${p.file || '(no file)'}${p.line ? `:${p.line}` : ''}  ${p.rule ? `${p.rule}  ` : ''}${p.message}`)],
  };
}

// Whether a worker's check compares, and against what. -> { on: true, b } | { on: false, why }
export function activeBaseline({ setting, base, stateDir }) {
  if (!/^on$/i.test(String(setting ?? '').trim())) return { on: false, why: `config §4 Baseline checks is ${setting ? `"${setting}"` : 'unset'}, not on` };
  if (!base) return { on: false, why: 'this batch has no base' };
  const b = readBaseline(stateDir);
  if (!b) return { on: false, why: 'no baseline has been recorded yet' };
  if (b.base !== base) return { on: false, why: `the baseline was recorded on ${b.base}, not ${base}` };
  return { on: true, b };
}
