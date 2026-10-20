#!/usr/bin/env node
// The read-only review of a feature spine's specs before the person approves them, and the approval
// questions built from it: one per spec, with its criterion, its file and what the reviewer found.
// The orchestrator runs the reviewer itself (its own Agent call), between these two commands:
//
//   spine-review.mjs brief <SPINE>                  the reviewer's prompt, naming every spec to review
//   spine-review.mjs questions <SPINE> [<reply>]    the approval questions as JSON; <reply> is the
//                                                   reviewer's final text, saved to a file
//
// With no reply, or one that does not parse, every question says its spec was not reviewed.
// Exits 0, or 11 (show the person) on a refusal: EXIT in batch-state.mjs.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { EXIT, Refusal, crashShowsPerson, describeCrash, readQueue, readJsonOrRefuse } from './batch-state.mjs';
import { ownedSpecs, spineSpecFiles, specsCommand } from './spine-check.mjs';

// What the reviewer looks for, by the `kind` it reports.
export const KINDS = {
  unasserted: 'a clause of its criterion the spec does not assert',
  contradiction: 'it contradicts another spec (name it in `other`)',
  coupled: 'it imports or reaches into an internal module path rather than the public surface',
  wrong_failure: 'its expected failure would come from something other than its assertion (an import error, a typo, a missing fixture)',
};
const SHOWN = {
  unasserted: (f) => `does not assert: ${f.detail}`,
  contradiction: (f) => `contradicts ${f.other ?? 'another spec'}: ${f.detail}`,
  coupled: (f) => `coupled to an internal module: ${f.detail}`,
  wrong_failure: (f) => `fails for the wrong reason: ${f.detail}`,
};

export const specKey = (s) => `${s.path}::${s.title}`;

// Pure: one entry per spec declaration titled with an owed id, in id order, with its criterion text
// (null where the epic's criteria were not read).
export function specsForReview(files, ids, criteria = []) {
  const text = Object.fromEntries((criteria ?? []).map((c) => [c.id, c.text]));
  return ownedSpecs(files, ids).flatMap(({ id, specs }) => specs.map((s) => ({
    key: specKey(s), id, criterion: text[id] ?? null, path: s.path, title: s.title,
  })));
}

// Pure: the reviewer's prompt. It reports and changes nothing.
export function reviewBrief(specs, { worktree, command } = {}) {
  const lines = [
    'Review these acceptance specs against their criteria before a person approves them. READ-ONLY: no Edit or Write, no git',
    'state changes, no gh writes. Describe problems in prose; never fix them.',
    '',
    `The specs are on the spine's branch${worktree ? ` in ${worktree}` : ''}. Each is meant to be a strict expected-fail test that`,
    'passes once a child ticket builds its criterion. Read each spec in full, and every file it imports.',
    'A run reports an expected failure as expected and usually hides its error, so judge wrong_failure by reading: find the first',
    'statement that would throw before the assertion (an import that does not resolve, a misspelt name, a fixture nobody defines).',
    command && worktree ? `To see the error, run one criterion's specs under the test lock with the runner's option that shows expected-failure errors: ~/.claude/desk/bin/with-lock.sh test sh -c 'cd ${worktree} && ${specsCommand(command, '<ID>')}'` : null,
    '',
    'Report, per spec, each of these you find:',
    ...Object.entries(KINDS).map(([k, v]) => `- ${k}: ${v}`),
    '',
    'Reply with JSON only, in this shape. `reviewed` lists the key of every spec you actually read; a spec missing from it is',
    'shown to the person as not reviewed. A spec you read and found nothing in goes in `reviewed` with no finding.',
    '{"reviewed": ["<key>", ...], "findings": [{"spec": "<key>", "kind": "<kind>", "detail": "<one line>", "other": "<key, for a contradiction>"}]}',
    '',
    'The specs:',
  ];
  for (const s of specs) {
    lines.push('', `key: ${s.key}`, `criterion ${s.id}: ${s.criterion ?? '(its text was not recorded: judge it from the title)'}`, `file: ${s.path}`);
  }
  return lines.filter((l) => l != null).join('\n');
}

// Pure: the reviewer's final text -> { reviewed: Set, findings } or { error }. The JSON may sit inside
// prose or a code fence.
export function parseReply(text) {
  const s = String(text ?? '');
  const from = s.indexOf('{');
  const to = s.lastIndexOf('}');
  if (from < 0 || to < from) return { error: s.trim() ? 'its reply held no JSON' : 'it returned nothing' };
  let j;
  try { j = JSON.parse(s.slice(from, to + 1)); } catch { return { error: 'its reply was not valid JSON' }; }
  if (!Array.isArray(j?.reviewed)) return { error: 'its reply listed no reviewed specs' };
  return { reviewed: new Set(j.reviewed.map(String)), findings: Array.isArray(j.findings) ? j.findings.filter((f) => f && typeof f === 'object') : [] };
}

// Pure: one approval question per spec. `review` is parseReply's result, or null when the reviewer
// failed. A contradiction is shown on both specs. Findings naming no spec under review are returned
// as `unmatched`, so none is dropped unseen.
export function approvalQuestions(specs, review) {
  const keys = new Set(specs.map((s) => s.key));
  const per = Object.fromEntries(specs.map((s) => [s.key, []]));
  const unmatched = [];
  for (const f of review?.findings ?? []) {
    const line = (SHOWN[f.kind] ?? ((x) => `${x.kind ?? 'finding'}: ${x.detail}`))(f);
    if (!keys.has(f.spec)) { unmatched.push(`${f.spec ?? '(no spec named)'}: ${line}`); continue; }
    per[f.spec].push(line);
    if (f.kind === 'contradiction' && keys.has(f.other) && f.other !== f.spec) per[f.other].push(`contradicts ${f.spec}: ${f.detail}`);
  }
  const questions = specs.map((s) => {
    const notReviewed = !review || review.error ? `not reviewed: the reviewer failed (${review?.error ?? 'it did not run'})`
      : !review.reviewed.has(s.key) ? 'not reviewed: the reviewer did not list it as read' : null;
    const findings = notReviewed ? [] : per[s.key];
    const verdict = notReviewed ?? (findings.length ? findings.map((x) => `- ${x}`).join('\n') : 'reviewed: nothing found');
    return {
      id: s.id, criterion: s.criterion, path: s.path, title: s.title, reviewed: !notReviewed, findings,
      question: [`${s.id}: "${s.title}" in ${s.path}`, `Criterion: ${s.criterion ?? '(not recorded)'}`, `Review: ${verdict}`,
        'Does this spec test what its criterion says?'].join('\n'),
    };
  });
  return { questions, unmatched };
}

// ---- the CLI: reads the queue, the spine's worktree, config §4 Acceptance specs and expansion.json --

function spineSpecs(key) {
  const q = readQueue(E.queueFile());
  if (q.feature !== true || q.spine !== key) throw new Refusal(`${key} is not this batch's feature spine (the queue's spine is ${q.spine ?? 'none'})`);
  const t = q.tickets?.[key];
  let acc = null;
  try { acc = E.configValues('acceptance-specs'); } catch { /* spineSpecFiles names the missing directory */ }
  const specDir = acc && !E.isNone(acc) ? acc[0] : null;
  const command = acc?.find?.((x) => x.includes('{ids}')) ?? null;
  const { files, problem } = spineSpecFiles({ worktree: t?.worktree, base: E.defaultBranch(), specDir });
  if (problem) throw new Refusal(`${key}: ${problem}`);
  const exp = join(E.stateDir(), 'expansion.json');
  // Only this batch's own epic's criteria: a file left by another epic would put its wording on these specs.
  const expansion = existsSync(exp) ? readJsonOrRefuse(exp, `re-run expand-parent.mjs ${q.epic ?? '<epic>'}`) : null;
  const criteria = q.epic && expansion?.parent === q.epic ? (expansion.criteria ?? []) : [];
  const specs = specsForReview(files, q.spine_ids ?? [], criteria);
  if (!specs.length) throw new Refusal(`${key}: none of its specs is titled with a criterion id (${(q.spine_ids ?? []).join(', ')})`);
  return { specs, worktree: t.worktree, command };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  crashShowsPerson((e) => console.error(`spine-review: ${describeCrash(e)}`));
  const [cmd, key, replyFile] = process.argv.slice(2);
  if (!['brief', 'questions'].includes(cmd) || !key) {
    console.error('usage: spine-review.mjs brief <SPINE> | spine-review.mjs questions <SPINE> [<reviewer reply file>]');
    process.exit(EXIT.SHOW_PERSON);
  }
  E.applyBatchBase();
  const { specs, worktree, command } = spineSpecs(key);
  if (cmd === 'brief') console.log(reviewBrief(specs, { worktree, command }));
  else {
    let reply = null;
    if (replyFile) { try { reply = readFileSync(replyFile, 'utf8'); } catch { reply = null; } }
    console.log(JSON.stringify(approvalQuestions(specs, reply == null ? null : parseReply(reply)), null, 2));
  }
}
