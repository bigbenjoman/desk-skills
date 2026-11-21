// The prose check: every reference tests/prose_scan.mjs finds in the skills and agents is held to the
// code's own lists (desk/bin/prose-facts.mjs), and one the code lacks fails, unless the baseline
// already holds it. The baseline is the drift there was the day the check landed, keyed by file, kind,
// value and context, never by line, so moving text does not unbaseline it and new drift is refused.
//
//   node tests/prose_check.mjs [--write-baseline] [<file or dir> ...]   # default: skills/ and agents/
//
// Exit 1 on any finding the baseline does not hold, or any baseline entry for a checked file that no
// longer matches a finding (the reference was fixed: delete the entry), 0 otherwise. --write-baseline replaces
// tests/fixtures/prose_baseline.json with every finding there is now.
//
// A line whose references must stay as written carries the opt-out with a reason:
//   prose     some `queue.mjs frobnicate` text <!-- prose-ok: <why> -->
//   shell     node ~/.claude/desk/bin/old.mjs   # prose-ok: <why>
// An opt-out with no reason is itself a finding.
//
// A generated region (tests/prose_facts.mjs) that is unknown, unclosed or not what the code says is a
// finding too, and one no opt-out or baseline holds: `node tests/prose_facts.mjs --write` fixes it.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, DEFAULT_PATHS } from './prose_scan.mjs';
import { regionProblems } from './prose_facts.mjs';
import { split, shellCommands, markdownFiles, PLACEHOLDER, FENCE, closesFence } from './command_shapes.mjs';
import { commands, autopilot, states, statePaths, locks } from '../desk/bin/prose-facts.mjs';
import { CONFIG_ROWS, PERMISSION_KEYS } from '../desk/bin/desk-env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE = join(ROOT, 'tests', 'fixtures', 'prose_baseline.json');
export const OPT_OUT = 'prose-ok:';
const PROSE_OPT_OUT = /<!--\s*prose-ok:(.*?)-->/;
const SHELL_OPT_OUT = /prose-ok:(.*)$/;
// Read by every desk script, queue.mjs included, before its command (desk-env.mjs takeBatchArg).
const EVERY_COMMAND_FLAGS = ['--batch'];

// Everything the check holds a reference to, read once from the code.
export function facts(root = ROOT) {
  const c = commands(root), a = autopilot(), l = locks(root), sp = statePaths();
  const holes = (p) => p.replace(PLACEHOLDER, '<>');
  const declared = new Set();
  for (const p of Object.values(sp.state)) {
    declared.add(holes(p));
    for (let d = p.split('/').slice(0, -1); d.length; d.pop()) { declared.add(d.join('/')); declared.add(`${d.join('/')}/`); }
  }
  return {
    queue: c.queue,
    deskEnv: new Set(c.deskEnv),
    scripts: c.scripts,
    autopilot: new Set([...a.markers, ...a.variables]),
    lockClasses: new Set(l.classes),
    lockOf: l.commands,
    states: new Set(states()),
    statePaths: declared,
    holes,
    rowIds: new Set([...Object.keys(CONFIG_ROWS), ...Object.keys(PERMISSION_KEYS)]),
    rowNames: new Set(Object.values(CONFIG_ROWS).map((r) => `§${r.section} ${r.row}`.toLowerCase())),
  };
}

// Where a script is installed, read back to its place in the repo: ~/.claude/desk/bin and $DESK_BIN are
// desk/bin, and the skills folder (~/.claude/skills, ~/.agents/skills, $DESK_SKILLS_DIR) is skills/.
const INSTALLED = [
  [/^(?:~|\$HOME|\$\{HOME\})\/\.claude\/desk\/bin\//, 'desk/bin/'],
  [/^\$\{?DESK_(?:RUN_)?BIN\}?\//, 'desk/bin/'],
  [/^(?:~|\$HOME|\$\{HOME\})\/\.(?:claude|agents)\/skills\//, 'skills/'],
  [/^\$\{?DESK_SKILLS_DIR\}?\//, 'skills/'],
];
// A script is known when it is a bin file, or the tail of one's path: `pass.mjs`, `desk/bin/pass.mjs`.
// One whose path still holds a placeholder or a variable (`<script>.py`, `$WT/run.sh`) is not judged.
function scriptKnown(value, scripts) {
  let p = value.replace(/^\.\//, '');
  for (const [re, to] of INSTALLED) p = p.replace(re, to);
  if (/<[^<>]*>|\$/.test(p)) return true;
  return scripts.some((s) => s === p || s.endsWith(`/${p}`));
}

// What is wrong with one reference, or null when the code has it.
export function problem(r, f) {
  const v = r.value;
  switch (r.kind) {
    case 'subcommand':
      if (v.startsWith('<') || v.startsWith('$') || v === '*' || v === '…') return null;
      if (r.of === 'queue.mjs') return Object.hasOwn(f.queue, v) ? null : `the queue command has no subcommand ${v}`;
      if (r.of === 'desk-env') return f.deskEnv.has(v) ? null : `desk-env has no subcommand ${v}`;
      return null;
    case 'flag': {
      if (EVERY_COMMAND_FLAGS.includes(v)) return null;
      const sub = r.of.split(' ')[1];
      if (!sub || !Object.hasOwn(f.queue, sub)) return null;
      return f.queue[sub].includes(v) ? null : `${r.of} does not read the flag ${v}`;
    }
    case 'script':
      return scriptKnown(v, f.scripts) ? null : `the script ${v} is not under desk/bin or a skill's bin folder`;
    case 'row':
      if (v.startsWith('§')) {
        const key = /^§\d+[a-z]?\s+([a-z][a-z0-9]*(?:-[a-z0-9]+)+)$/.exec(v);
        if (key && f.rowIds.has(key[1])) return null;
        if (!key && f.rowNames.has(v.replace(/\s+/g, ' ').toLowerCase())) return null;
        return `config declares no row ${v}`;
      }
      return f.rowIds.has(v) ? null : `config declares no row ${v}`;
    case 'lock':
      if (v.startsWith('<')) return null;
      if (!f.lockClasses.has(v)) return `with-lock.sh has no lock class ${v}`;
      if (r.row && Object.hasOwn(f.lockOf, r.row) && f.lockOf[r.row] !== v) {
        return `the ${r.row} command runs under the lock class ${f.lockOf[r.row]}, not ${v}`;
      }
      return null;
    case 'autopilot':
      return f.autopilot.has(v) ? null : `${v} is neither a marker nor a variable the code uses`;
    case 'state':
      return f.states.has(v) ? null : `the queue writer has no state ${v}`;
    case 'state-path': {
      const p = f.holes(v);
      if (/^<>\/?$/.test(p)) return null;
      return f.statePaths.has(p) ? null : `${v} is not a declared state path`;
    }
    default:
      return null;
  }
}

// The lines of one markdown file that carry the opt-out: { optedOut: Set of line numbers, bare: [line] }
// where `bare` is each opt-out written with no reason. Prose takes it as an HTML comment, a shell block
// as a shell comment; a code span or any other block never opts out.
export function optOuts(text) {
  const optedOut = new Set(), bare = [];
  const mark = (line, reason) => { if (reason.trim()) optedOut.add(line); else bare.push(line); };
  for (const cmd of shellCommands(text)) {
    const m = SHELL_OPT_OUT.exec(split(cmd.text.replace(PLACEHOLDER, (p) => p.replace(/#/g, '_'))).comment);
    if (m) mark(cmd.line, m[1]);
  }
  const lines = text.split('\n');
  let fence = null;
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    if (fence) { if (closesFence(raw, fence)) fence = null; continue; }
    const open = raw.match(FENCE);
    if (open) { fence = open[1]; continue; }
    const m = PROSE_OPT_OUT.exec(raw.replace(/(`+)[^`]*?\1/g, ''));
    if (m) mark(n + 1, m[1]);
  }
  return { optedOut, bare };
}

// Every finding in the files given: { file, line, kind, value, context, message }. `values` overrides a
// generated region's values (prose_facts.mjs regenerate).
export function check(files, { root = ROOT, f = facts(root), values } = {}) {
  const out = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8'), file = relative(root, path) || path;
    for (const p of regionProblems(text, { values })) out.push({ file, line: p.line, kind: 'region', value: p.name, context: text.split('\n')[p.line - 1].trim(), message: p.message });
    const { optedOut, bare } = optOuts(text);
    for (const line of bare) out.push({ file, line, kind: 'opt-out', value: OPT_OUT, context: text.split('\n')[line - 1].trim(), message: `the opt-out on line ${line} gives no reason` });
    for (const r of scan(text)) {
      if (optedOut.has(r.line)) continue;
      const message = problem(r, f);
      if (message) out.push({ file, line: r.line, kind: r.kind, value: r.value, context: r.context, message });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// A finding's baseline key: file, kind, value and context, never the line.
export const keyOf = (x) => JSON.stringify([x.file, x.kind, x.value, x.context]);
export const readBaseline = (path = BASELINE) => JSON.parse(readFileSync(path, 'utf8'));
export const baselineEntries = (findings) => {
  const seen = new Map();
  for (const { file, kind, value, context } of findings.filter((x) => x.kind !== 'region')) seen.set(keyOf({ file, kind, value, context }), { file, kind, value, context });
  return [...seen.values()];
};

// The findings the baseline does not hold, how many of its entries still match a finding, and the
// entries that match none (`stale`): the reference was fixed, so the entry must go. Given `files` (the
// repo paths checked), only entries for those files can be stale.
export function gate(findings, baseline, files) {
  const held = new Set(baseline.map(keyOf));
  const fresh = findings.filter((x) => x.kind === 'region' || !held.has(keyOf(x)));
  const live = new Set(findings.map(keyOf));
  const checked = files && new Set(files);
  const stale = baseline.filter((e) => !live.has(keyOf(e)) && (!checked || checked.has(e.file)));
  return { fresh, remaining: baseline.filter((e) => live.has(keyOf(e))).length, stale };
}

export const report = (x) => `${x.file}:${x.line}: ${x.message} (${x.kind} ${x.value} in: ${x.context})`;
export const staleReport = (e) => `${relative(ROOT, BASELINE)}: ${e.file} no longer has the ${e.kind} ${e.value} (in: ${e.context}); delete this entry`;

// The check's verdict on findings against a baseline: the lines to print and the exit code.
export function verdict(findings, baseline, files) {
  const { fresh, remaining, stale } = gate(findings, baseline, files);
  const out = [...fresh.map(report), ...stale.map(staleReport)];
  out.push(`${fresh.length} finding(s) the baseline does not hold; ${remaining} baseline entries remain${stale.length ? `, ${stale.length} no longer match` : ''}`);
  if (fresh.length) out.push(`Fix the reference, or keep it with "<!-- ${OPT_OUT} <reason> -->" (prose) or "# ${OPT_OUT} <reason>" (shell).`);
  if (stale.length) out.push(`Delete each entry that no longer matches from ${relative(ROOT, BASELINE)}: the baseline only shrinks.`);
  return { out, code: fresh.length || stale.length ? 1 : 0 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const write = args.includes('--write-baseline');
  const paths = args.filter((a) => a !== '--write-baseline');
  const files = markdownFiles((paths.length ? paths : DEFAULT_PATHS).map((p) => (isAbsolute(p) ? p : join(paths.length ? process.cwd() : ROOT, p))));
  const findings = check(files);
  if (write) {
    const entries = baselineEntries(findings);
    writeFileSync(BASELINE, `[\n${entries.map((e) => JSON.stringify(e)).join(',\n')}\n]\n`);
    console.log(`wrote ${entries.length} baseline entries to ${relative(ROOT, BASELINE)}`);
    process.exit(0);
  }
  const { out, code } = verdict(findings, readBaseline(), paths.length ? files.map((f) => relative(ROOT, f)) : undefined);
  for (const l of out) console.log(l);
  process.exit(code);
}
