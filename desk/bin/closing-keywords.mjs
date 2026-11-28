#!/usr/bin/env node
// Finds the GitHub closing keywords in a PR body that would close an issue the PR is not meant to
// close. GitHub closes an issue at merge wherever close, fix or resolve (any form, any case) sits
// directly before a reference to it, in a sentence as much as on a line of its own. A line that is
// only keywords and references ("Closes #12", "- Fixes #3, closes #4.") says the PR closes them and
// passes; a keyword anywhere else is flagged with its line.
// With --ticket and a GitHub-issue ticket (`issue-<n>`, §4 Tracker none), a body with no `Closes #<n>`
// for that issue is flagged too: nothing else closes it at merge.
//   closing-keywords.mjs <body file> [--ticket <KEY>]   exit 0 none flagged, 1 flagged (one line each), 2 usage
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const KEYWORD = String.raw`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)`;
const REF = String.raw`(?:https?://github\.com/[\w.-]+/[\w.-]+/issues/\d+|(?:[\w.-]+/[\w.-]+)?#\d+|gh-\d+)`;
const JOIN = String.raw`(?::\s*|\s+)`;
// A keyword directly before a reference, as GitHub reads it.
const USE = new RegExp(String.raw`(?<![\w/#-])${KEYWORD}${JOIN}${REF}(?![\w-])`, 'gi');
// A line that says only which issues the PR closes, after any list or quote marker and bold. A task
// item ("- [ ] Close #12") is a step for later, never that line, so its box is not stripped.
const MARKER = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?/;
// The gap between references can be read only one way: a comma or ampersand with any spaces round
// it, "and" with spaces on both sides, or spaces alone. Never two optional runs of spaces side by
// side, and never an "and" a reference could also start with ("and-co/web#2"): either lets V8 try
// every reading of a long line of references that ends in prose, which doubles with each one.
const GAP = String.raw`(?:\s*[,&]\s*|\s+and\s+|\s+)`;
const ONLY = new RegExp(String.raw`^${KEYWORD}${JOIN}${REF}(?:${GAP}(?:${KEYWORD}${JOIN})?${REF})*\s*\.?$`, 'i');

// Whether `line` says only that the PR closes the issues it names.
export const closesOnly = (line) => ONLY.test(line.replace(MARKER, '').replace(/\*\*|__/g, '').trim());

// The issues `body` closes, as GitHub reads its closing keywords, each with the repo its reference
// names (`owner/repo#12`, an issue URL), or null for one in the PR's own repo (`#12`, `gh-12`).
// -> [{ repo, number }]
export const closedBy = (body) => [...String(body ?? '').matchAll(USE)].map((m) => {
  const r = /(?:github\.com\/([\w.-]+\/[\w.-]+)\/issues\/|([\w.-]+\/[\w.-]+)#)\d+$/i.exec(m[0]);
  return { repo: r ? r[1] ?? r[2] : null, number: Number(/(\d+)$/.exec(m[0])[1]) };
});

// The issue a GitHub-issue ticket key (`issue-<n>`) names, or null for any other key.
export const ticketIssue = (key) => { const m = /^issue-([0-9]+)$/.exec(String(key ?? '')); return m ? Number(m[1]) : null; };
// Whether `body` closes issue <n> of the PR's own repo at merge.
export const closesIssue = (body, n) => closedBy(body).some((c) => c.repo == null && c.number === n);
// `body` with a `Closes #<n>` line of its own at the end for the ticket's issue where it lacks one, so
// GitHub closes the issue at merge; unchanged for any other ticket.
export function withCloses(body, key) {
  const n = ticketIssue(key);
  if (n == null || closesIssue(body, n)) return body;
  return `${String(body ?? '').replace(/\s+$/, '')}\n\nCloses #${n}`;
}

// Every line of `body` with a closing keyword outside a line that says the PR closes it.
// -> [{ line, text, uses }], `line` counted from 1 and `uses` the keyword and reference as written.
export function strayClosings(body) {
  const out = [];
  String(body ?? '').split(/\r?\n/).forEach((text, i) => {
    const uses = [...text.matchAll(USE)].map((m) => m[0]);
    if (uses.length && !closesOnly(text)) out.push({ line: i + 1, text, uses });
  });
  return out;
}

function main(argv) {
  const at = argv.indexOf('--ticket');
  const ticket = at < 0 ? null : argv.splice(at, 2)[1];
  if (argv.length !== 1 || argv[0].startsWith('-') || (at >= 0 && !ticket)) {
    console.error('usage: closing-keywords.mjs <body file> [--ticket <KEY>]');
    return 2;
  }
  let body;
  try { body = readFileSync(argv[0], 'utf8'); } catch (e) {
    console.error(`closing-keywords.mjs: cannot read ${argv[0]}: ${e.message}`);
    return 2;
  }
  const stray = strayClosings(body);
  const n = ticketIssue(ticket);
  const missing = n != null && !closesIssue(body, n);
  if (missing) console.log(`no line closes #${n}, the issue ${ticket} works from: add "Closes #${n}" on a line of its own, so GitHub closes it at merge`);
  if (!stray.length) return missing ? 1 : 0;
  for (const s of stray) console.log(`line ${s.line}: ${s.uses.join(', ')} would close ${s.uses.length > 1 ? 'those issues' : 'that issue'} at merge: ${s.text.trim()}`);
  console.log('GitHub closes an issue at merge wherever a closing keyword sits right before it. A step for later names the issue first ("#N can be closed after …"); an issue this PR closes goes on a line of its own ("Closes #N").');
  return 1;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) process.exit(main(process.argv.slice(2)));
