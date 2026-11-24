// What /desk-admit writes into a ticket triage would refuse only for sections desk can write from the
// ticket itself: acceptance criteria triage drafted from its goal and proposal (its
// `drafted_criteria`), "No UI." where triage found nothing renders, and, with either, "None." under a
// missing Out of scope and the repo's test command under a missing Verification. intake.mjs admit
// writes them (a GitHub issue under config §3 gh-issue-edit, a ticket file always), lints the ticket
// again and admits it on that.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sections } from './desk-design.mjs';
import * as E from './desk-env.mjs';
import { designRoot, lintTicket } from './ticket-lint.mjs';

export const DRAFTED_NOTE = 'Drafted by desk from the proposal: reviewed like any other criteria.';
const NO_DESIGN = /^no design link and no "No UI\." line/;

const blocking = (rec, rule, re = null) => (rec.lint ?? []).some((f) => f.severity === 'blocking' && f.rule === rule && (!re || re.test(f.message)));
// Triage's drafted criteria: null where it drafted none (the ticket had criteria, or an older record),
// [] where the ticket's text states no testable outcome.
export const draftedCriteria = (rec) => (Array.isArray(rec?.drafted_criteria)
  ? rec.drafted_criteria.map((c) => String(c ?? '').replace(/^\W*(?:AC\d+\W*)?/i, '').trim()).filter(Boolean) : null);
// Whether the ticket has no criteria and triage found no testable outcome in its text to draft them from.
export const noTestableOutcome = (rec) => blocking(rec, 'criteria') && draftedCriteria(rec)?.length === 0;

// The files a ticket triage found renders nothing changes, as its reason says them (`: it changes a, b,
// c and 2 more`), or '' with none: the refusal line (intake.mjs) and the Design section written here.
export function changesClause(rec) {
  const files = (Array.isArray(rec.files_in_scope) ? rec.files_in_scope : []).filter((f) => typeof f === 'string');
  return files.length ? `: it changes ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}` : '';
}
// The Design section's reason where triage found nothing renders.
export const noUiReason = (rec) => `No UI. Triage found nothing renders${changesClause(rec)}.`;

// The repo's test command, as Verification says it: §4 Unit tests' items, each in backticks; '' unset.
export function testCommand(read = (id) => E.configValues(id)) {
  let v;
  try { v = read('test-cmd'); } catch { return ''; }
  const items = [].concat(v ?? []).map((x) => String(x).trim()).filter((x) => x && !E.isNone(x));
  return items.map((x) => `\`${x}\``).join(' and ');
}

// The sections to write into `text` for triage record `rec`: [{name, body}], empty when the record's
// blocking findings hold neither a missing criteria section triage drafted, nor a missing design on a
// ticket that renders nothing.
export function fillSections(rec, text, { test = testCommand() } = {}) {
  const have = new Set(sections(text).filter((s) => s.lines.some((l) => l.text.trim())).map((s) => s.name.toLowerCase()));
  const has = (re) => [...have].some((n) => re.test(n));
  const out = [];
  const drafted = draftedCriteria(rec);
  if (blocking(rec, 'criteria') && drafted?.length) {
    out.push({ name: 'Acceptance criteria', body: [`_${DRAFTED_NOTE}_`, ...drafted.map((c, i) => `- AC${i + 1}: ${c}`)].join('\n') });
  }
  if (rec.renders === false && blocking(rec, 'design', NO_DESIGN)) out.push({ name: 'Design', body: noUiReason(rec) });
  if (!out.length) return out;
  if (!has(/^out of scope\b/)) out.push({ name: 'Out of scope', body: 'None.' });
  if (!has(/^verification\b/) && test) out.push({ name: 'Verification', body: `${test}.` });
  return out;
}

// `text` with each section written: under its heading where the ticket has it empty, else appended.
export function withSections(text, secs) {
  const lines = String(text ?? '').replace(/\s+$/, '').split('\n');
  const tail = [];
  for (const s of secs) {
    const at = lines.findIndex((l) => /^\s*#{1,6}\s+/.test(l) && l.replace(/^\s*#{1,6}\s+/, '').replace(/[*_:]/g, '').trim().toLowerCase() === s.name.toLowerCase());
    if (at >= 0) lines.splice(at + 1, 0, s.body);
    else tail.push('', `## ${s.name}`, s.body);
  }
  return `${[...lines, ...tail].join('\n')}\n`;
}

// The printed record of the write, as gate 2's block is: what was written, where, verbatim.
const block = (kind, key, target, said, secs) => [`${kind} ${key} — ${said}`, `target : ${target}`, '---',
  ...secs.flatMap((s) => [`## ${s.name}`, s.body])].join('\n');

const lastLine = (r) => `${r.stderr ?? ''}${r.stdout ?? ''}${r.error?.message ?? ''}`.trim().split('\n').pop() || `exited ${r.status}`;
// A GitHub issue's body, the text triage lints (ticket-facts.mjs) and admit fills: {text}, or {why}.
export const issueBody = (n, repo) => {
  const r = spawnSync('gh', ['issue', 'view', n, '--repo', repo, '--json', 'body', '--jq', '.body'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0 ? { text: r.stdout } : { why: lastLine(r) };
};

// Writes what fillSections drafts for `key` and lints it again: -> {rec, lines}. `rec` is the triage
// record, its lint replaced by the written ticket's where something was written; otherwise it carries
// `fill`, {path, why}: the whole new text left in `path` and why it was not written. `lines` is what
// to say: the write's block, or why it waits.
// A Jira ticket is left to the session: its record holds no description, and desk-admit writes it with
// desk-jira from the refusal line (intake.mjs intakeReasons).
export function fillTicket(key, rec, { state, perm = (id) => E.permission(id) } = {}) {
  const kind = E.ticketKind(key);
  if (!kind.ok || !['issue', 'work-id', 'slug'].includes(kind.kind)) return { rec, lines: [] };
  const file = join(state, 'tickets', `${key}.md`);
  const n = key.replace(/^issue-/, '');
  let text = null;
  let repo = null;
  if (kind.kind === 'issue') {
    repo = E.ghRepo();
    const b = issueBody(n, repo);
    if (b.why) return { rec, lines: [`fill: ${key}'s issue body could not be read (${b.why}), so nothing was written`] };
    text = b.text;
  } else if (existsSync(file)) text = readFileSync(file, 'utf8');
  else return { rec, lines: [] };
  const secs = fillSections(rec, text);
  if (!secs.length) return { rec, lines: [] };
  const next = withSections(text, secs);
  const names = secs.map((s) => s.name).join(', ');
  let written;
  if (kind.kind === 'issue') {
    const target = `${repo}#${n}`;
    const draft = join(state, 'fills', `${key}.md`);
    mkdirSync(join(state, 'fills'), { recursive: true });
    writeFileSync(draft, next);
    const wait = (why) => ({ rec: { ...rec, fill: { path: draft, why, names, issue: n, repo } }, lines: [block('ISSUE EDIT', key, target, 'awaiting approval', secs)] });
    const p = perm('gh-issue-edit');
    if (p !== 'yes') return wait(`config §3 gh-issue-edit is "${p}"`);
    const w = spawnSync('gh', ['issue', 'edit', n, '--repo', repo, '--body-file', draft], { encoding: 'utf8' });
    if (w.status !== 0) return wait(`gh issue edit failed (${lastLine(w)})`);
    const back = issueBody(n, repo);
    if (back.why) return { rec, lines: [`fill: ${key}'s issue was edited but could not be read back (${back.why}): run /desk-admit ${key} again`] };
    written = { text: back.text, target };
  } else {
    writeFileSync(file, next);
    written = { text: next, target: file };
  }
  const lint = lintTicket({ key, text: written.text, wiki: false }, designRoot());
  const out = { ...rec, lint };
  delete out.fill;
  const path = join(state, 'triage', `${key}.json`);
  try { if (existsSync(path)) writeFileSync(path, `${JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), lint }, null, 2)}\n`); } catch { /* the record in hand is what this admit places */ }
  return { rec: out, lines: [block(kind.kind === 'issue' ? 'ISSUE EDIT' : 'TICKET FILE EDIT', key, written.target, 'posted', secs), `fill: wrote ${names} into ${key} and linted it again`] };
}
