#!/usr/bin/env node
// Finds the GitHub closing keywords in a PR body that would close an issue the PR is not meant to
// close. GitHub closes an issue at merge wherever close, fix or resolve (any form, any case) sits
// directly before a reference to it, in a sentence as much as on a line of its own. A line that is
// only keywords and references ("Closes #12", "- Fixes #3, closes #4.") says the PR closes them and
// passes; a keyword anywhere else is flagged with its line.
//   closing-keywords.mjs <body file>   exit 0 none flagged, 1 flagged (one line each), 2 usage
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
const ONLY = new RegExp(String.raw`^${KEYWORD}${JOIN}${REF}(?:\s*(?:,|&|\band\b)?\s*(?:${KEYWORD}${JOIN})?${REF})*\s*\.?$`, 'i');

// Whether `line` says only that the PR closes the issues it names.
export const closesOnly = (line) => ONLY.test(line.replace(MARKER, '').replace(/\*\*|__/g, '').trim());

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
  if (argv.length !== 1 || argv[0].startsWith('-')) {
    console.error('usage: closing-keywords.mjs <body file>');
    return 2;
  }
  let body;
  try { body = readFileSync(argv[0], 'utf8'); } catch (e) {
    console.error(`closing-keywords.mjs: cannot read ${argv[0]}: ${e.message}`);
    return 2;
  }
  const stray = strayClosings(body);
  if (!stray.length) return 0;
  for (const s of stray) console.log(`line ${s.line}: ${s.uses.join(', ')} would close ${s.uses.length > 1 ? 'those issues' : 'that issue'} at merge: ${s.text.trim()}`);
  console.log('GitHub closes an issue at merge wherever a closing keyword sits right before it. A step for later names the issue first ("#N can be closed after …"); an issue this PR closes goes on a line of its own ("Closes #N").');
  return 1;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) process.exit(main(process.argv.slice(2)));
