// Reads a repo's GitHub Actions workflows: a line scanner for workflow YAML (desk-ci.mjs builds its
// rules on it), each job's check name and steps, and the §4 Pre-merge steps items keyed to a job.
// No config read here, so desk-env.mjs can import it without importing itself back.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ---- a line scanner for workflow YAML ---------------------------------------------------------
// Workflows are block YAML, and every rule here needs the line it fired on, which a YAML parser
// discards. Comments are stripped outside block scalars only: GitHub expands `${{ }}` inside a
// `run: |` body even on a line the shell treats as a comment.

function stripComment(s) {
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ''; continue; }
    if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:]/.test(s[i - 1]))) q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function scan(text) {
  const out = [];
  let blockIndent = -1;
  text.split(/\r?\n/).forEach((raw, i) => {
    const indent = raw.length - raw.trimStart().length;
    const blank = raw.trim() === '';
    if (blockIndent >= 0 && (blank || indent > blockIndent)) {
      out.push({ n: i + 1, indent, text: raw.trim(), blank, scalar: true });
      return;
    }
    blockIndent = -1;
    const t = stripComment(raw).trimEnd().trim();
    const line = { n: i + 1, indent, text: t, blank: t === '', scalar: false };
    out.push(line);
    if (/:\s*[|>][-+0-9]*$/.test(t)) blockIndent = indent + (t.startsWith('- ') ? 2 : 0);
  });
  return out;
}

const KEY = /^(?:-\s+)?("[^"]*"|'[^']*'|[^\s:#'"][^:#]*?)\s*:(?:\s+(.*))?$/;
export const keyOf = (l) => {
  if (l.scalar || l.blank) return null;
  const m = KEY.exec(l.text);
  return m ? { key: m[1].replace(/^["']|["']$/g, ''), value: (m[2] ?? '').trim() } : null;
};

// The lines under lines[i]: everything indented deeper, plus a sequence written at the key's own
// indent (`steps:` followed by `- uses:` in the same column).
export function blockAfter(lines, i) {
  const k = lines[i].indent;
  const seq = keyOf(lines[i])?.value === '';
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j];
    if (l.blank || l.scalar || l.indent > k || (seq && l.indent === k && /^-(\s|$)/.test(l.text))) j++;
    else break;
  }
  while (j > i + 1 && lines[j - 1].blank) j--;
  return lines.slice(i + 1, j);
}

// The direct keys of a mapping block: { key: { line, value, block } }.
export function mapping(block) {
  const out = {};
  const first = block.find((l) => !l.blank && !l.scalar);
  if (!first) return out;
  block.forEach((l, idx) => {
    if (l.indent !== first.indent || /^-(\s|$)/.test(l.text)) return;
    const kv = keyOf(l);
    if (kv && !(kv.key in out)) out[kv.key] = { line: l, value: kv.value, block: blockAfter(block, idx) };
  });
  return out;
}

export function parseWorkflow(text) {
  const lines = scan(text);
  const top = {};
  lines.forEach((l, idx) => {
    if (l.indent !== 0) return;
    const kv = keyOf(l);
    if (kv && !(kv.key in top)) top[kv.key] = { line: l, value: kv.value, block: blockAfter(lines, idx) };
  });
  const jobs = Object.entries(top.jobs ? mapping(top.jobs.block) : {}).map(([id, j]) => ({
    id, line: j.line, lines: [j.line, ...j.block], keys: mapping(j.block),
  }));
  return { lines, name: top.name, on: top.on, env: top.env, permissions: top.permissions, jobs };
}

export const unquote = (s) => s.replace(/^(["'])([\s\S]*)\1$/, '$2');
// The check name a job reports under: its `name:`, else its id.
export const checkNameOf = (job) => (job.keys.name?.value ? unquote(job.keys.name.value) : job.id);

// ---- §4 Pre-merge steps and the steps of a job ---------------------------------------------------
// §4 Checks workers can't fix, Check builds and Pre-merge steps items: `<check>: <what fixes it>`,
// split on the first `: `, so the command may hold one. An item with no check or no command is an
// error, never a guess.
export function parseOperatorChecks(items) {
  const checks = [];
  const errors = [];
  for (const x of items || []) {
    if (!x || /^none$/i.test(x.trim())) continue;
    const i = x.indexOf(': ');
    const name = i < 0 ? '' : x.slice(0, i).trim();
    const command = i < 0 ? '' : x.slice(i + 2).trim();
    if (!name || !command) errors.push(`\`${x}\``);
    else checks.push({ name, command });
  }
  return { checks, errors };
}

// The words that say what a step does: four letters or more, singular, none any CI step could use.
const STEP_STOPWORDS = new Set(['apply', 'applied', 'first', 'then', 'before', 'after', 'with', 'from', 'into', 'onto', 'this', 'that',
  'them', 'each', 'every', 'check', 'step', 'make', 'sure', 'have', 'been', 'will', 'your', 'must', 'only', 'also', 'when', 'where']);
const stepWords = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).map((w) => w.replace(/([^s])s$/, '$1'))
  .filter((w) => w.length >= 4 && !STEP_STOPWORDS.has(w));
// Whether a step is the one a §4 Pre-merge steps item ({ name, command }) is for: named as the item
// is, or sharing a word with what the item says to do (`Migration Staging Ack` for `apply the PR's
// migrations to staging first`).
export function stepFits(step, item) {
  if (step === item.name) return true;
  const want = new Set(stepWords(item.command));
  return stepWords(step).some((w) => want.has(w));
}

// A job's steps in order, each by its `name:`, or null for a step with none.
function stepNames(job) {
  const block = job.keys.steps?.block ?? [];
  const at = block.find((l) => !l.scalar && !l.blank && /^-(\s|$)/.test(l.text))?.indent;
  const names = [];
  for (const l of block) {
    if (l.scalar || l.blank || at === undefined) continue;
    const item = l.indent === at && /^-(\s|$)/.test(l.text);
    if (item) names.push(null);
    if (!item && l.indent !== at + 2) continue;
    const kv = keyOf(l);
    if (kv?.key === 'name' && names.length && kv.value) names[names.length - 1] = unquote(kv.value);
  }
  return names;
}

// Each job in a repo's workflows, by the check name it reports under, with its steps (stepNames).
export function workflowJobs(root) {
  const dir = join(root, '.github', 'workflows');
  let files;
  try { files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort(); } catch { return []; }
  return files.flatMap((f) => {
    try { return parseWorkflow(readFileSync(join(dir, f), 'utf8')).jobs.map((job) => ({ name: checkNameOf(job), steps: stepNames(job) })); } catch { return []; }
  });
}

// §4 Pre-merge steps items (`<check or step>: <the step>`) named after a job of the repo's workflows
// that runs more than one step, where a failure at any step would be put to the person as that item's.
// Each with the job's named steps and those that fit the item (stepFits).
// An item that is also one of its job's step names is keyed to that step already.
export function jobKeyedPremerge(items, root) {
  const jobs = workflowJobs(root);
  return parseOperatorChecks(items).checks.flatMap((item) => {
    const job = jobs.find((j) => j.name === item.name && j.steps.length > 1);
    if (!job || job.steps.includes(item.name)) return [];
    const named = job.steps.filter(Boolean);
    return [{ ...item, steps: job.steps.length, named, fits: named.filter((s) => stepFits(s, item)) }];
  });
}
