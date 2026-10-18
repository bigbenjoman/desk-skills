#!/usr/bin/env node
// Checks one ticket against skills/desk-jira/references/ticket-template.md and reports what would
// make triage ask or a worker park, so it is fixed before the ticket reaches a batch. desk-jira lint
// and create gather the ticket and pipe it here; ticket-facts.mjs records the result for plan-batch.
//   node ticket-lint.mjs [--json] < ticket.json
// ticket.json: {key, type, text, wiki, size, blocks, parent, siblings, facts}
//   text      the description: Jira wiki markup when wiki is true (render checks run), else markdown
//   size      the Size field's value, '' or null when unset (a first line `Size: M` also counts);
//             leave it out where a ticket has no size at all
//   blocks    the keys this ticket has a Blocks link with, either direction
//   parent    the parent as desk-jira get --json gives it, or null
//   siblings  [{key, summary}]: the parent's children
//   facts     [{line, text}]: the status, priority and size lines desk-jira refuses in a body
// Prints one `blocking: …` or `advisory: …` line per finding (or a JSON array with --json) and exits
// 1 when any is blocking, 0 otherwise, 2 on unreadable input.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalUrl, checkTicket, designDir, sections } from './desk-design.mjs';
import { configValue, isNone, stateDir } from './desk-env.mjs';

// The text with every line inside a {code}/{noformat} block or a ``` fence blanked, so nothing in
// code reads as prose and line numbers still match the source.
function blankCode(text) {
  let fence = null; let macro = false;
  return String(text ?? '').split(/\r?\n/).map((l) => {
    if (macro) { if (/\{(?:code|noformat)\}/i.test(l)) macro = false; return ''; }
    if (fence) { if (l.trim().startsWith(fence)) fence = null; return ''; }
    const f = /^\s*(`{3,}|~{3,})/.exec(l);
    if (f) { fence = f[1]; return ''; }
    const m = /\{(?:code|noformat)(?::[^}]*)?\}/i.exec(l);
    if (m) { if (!/\{(?:code|noformat)\}/i.test(l.slice(m.index + m[0].length))) macro = true; return ''; }
    return l;
  });
}

// Prose only: monospace, code spans and URLs say nothing about the ticket's own state.
const prose = (s) => s.replace(/\{\{.*?\}\}/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/\b(?:https?|mailto):[^\s|\]]+/gi, ' ');
const quote = (s) => { const t = s.trim(); return t.length > 90 ? `${t.slice(0, 87)}...` : t; };

// "for the user to confirm" is behaviour; "(to confirm)" and "to be confirmed" leave a fact open.
const OPEN = [/\bTBD\b/, /\bTBC\b/, /\bTODO\b/, /\bto be (?:decided|confirmed)\b/i, /\bdecide\b/i, /\bneeds? a decision\b/i,
  /\bproposals? for\b/i, /\(to confirm\)/i, /\bpending sign-?off\b/i];
const SCOPE = /^(?:outcome|acceptance criteria|definition of done|out of scope)\b/i;
const CRITERIA = /^(?:acceptance criteria|definition of done)\b/i;
const WRITE = String.raw`(?:link(?:s|ed)?|block(?:s|ed)?|transition(?:s|ed)?|move[sd]?|assign(?:s|ed)?|label(?:s|l?ed)?|comment(?:s|ed)?|close[sd]?|reopen(?:s|ed)?|re-?parent(?:s|ed)?)`;
const JIRA_VERB = new RegExp(`\\b(?:create|set|update|edit|write|add)\\b|\\b${WRITE}\\b`, 'i');
const PRODUCTION =/\b(?:in|on|against) (?:production|prod)\b|\bproduction (?:data|database|traffic|run|users|site)\b|\blive (?:site|traffic|users|customers|data|measurement|environment)\b/i;
const OPERATOR = /\boperator\b|\bby hand\b|\bmanually\b|\bsigns? off\b|\bsign-off\b/i;
// The Size fallback, a first line `Size: M`, for a project with no Size field.
export const SIZE_LINE = /^\s*[*_]*size[*_]*\s*:\s*[*_]*\s*([a-z]+)/i;

// An artifact autopilot snapshotted into <state>/designs/ before triage: the worker saves it on its
// branch, so its missing repo copy is not a park.
function snapshotted(url) {
  const base = join(stateDir(), 'designs');
  if (!existsSync(base)) return false;
  return readdirSync(base).some((d) => {
    try { return canonicalUrl(JSON.parse(readFileSync(join(base, d, 'source.json'), 'utf8')).url) === canonicalUrl(url); } catch { return false; }
  });
}

// §4 Ticket key pattern, else <§4 Jira project>-<n>; null when neither is set.
function keyRegex() {
  const read = (id) => { try { return String(configValue(id) ?? '').trim(); } catch { return ''; } };
  const p = read('ticket-pattern');
  if (p && !isNone(p)) { try { new RegExp(p); return p; } catch { return null; } }
  const project = /^[`"]?([A-Z][A-Z0-9]*)\b/.exec(read('jira-project'))?.[1];
  return project ? `${project}-[0-9]+` : null;
}

export function lintTicket(t, { root, dir } = {}) {
  const findings = [];
  const add = (severity, rule, message) => findings.push({ severity, rule, message });
  const lines = blankCode(t.text);
  const secs = sections(lines.join('\n'));
  const keyPattern = keyRegex();
  const sec = (re) => secs.find((s) => re.test(s.name));
  const filled = (s) => !!s && s.lines.some((l) => l.text.trim());
  const all = secs.flatMap((s) => s.lines);

  // ---- blocking ----
  const criteria = sec(CRITERIA);
  if (!filled(criteria)) add('blocking', 'criteria', 'no acceptance criteria: add an "Acceptance criteria" section (an Epic\'s "Definition of done") of AC1: Given …, when …, then … items');

  for (const l of all) {
    const p = prose(l.text);
    const hit = OPEN.map((re) => re.exec(p)).find(Boolean);
    if (hit) add('blocking', 'open-decision', `line ${l.n} leaves a decision open ("${hit[0]}"): "${quote(l.text)}": settle it with whoever owns it, then write the dated decision under Decisions`);
  }
  for (const s of secs.filter((x) => SCOPE.test(x.name))) {
    for (const l of s.lines) {
      if (prose(l.text).includes('?')) add('blocking', 'open-decision', `line ${l.n} asks a question in ${s.name}: "${quote(l.text)}": answer it before the ticket is filed`);
    }
  }

  const design = sec(/^design\b/i);
  const noUi = all.some((l) => /^\W*no ui\b/i.test(prose(l.text)));
  if (!noUi && !(design && design.lines.some((l) => /https?:\/\//i.test(l.text)))) {
    add('blocking', 'design', 'no design link and no "No UI." line: put the Figma or Claude Design URL in a Design section, or write "No UI." there');
  }

  if ('size' in t && !/sub-?task/i.test(t.type ?? '')) {
    const first = lines.find((l) => l.trim()) ?? '';
    if (!String(t.size ?? '').trim() && !SIZE_LINE.test(first)) add('blocking', 'size', 'Size is unset: set the Size field (XS, S, M, L or XL)');
  }

  const key = keyPattern ? `(?:${keyPattern})` : null;
  const nearKey = key && new RegExp(`${key}\\W+(?:\\w+\\W+){0,4}?${WRITE}\\b|\\b${WRITE}\\W+(?:\\w+\\W+){0,4}?${key}`, 'i');
  for (const l of criteria?.lines ?? []) {
    const p = prose(l.text);
    if (!p.trim()) continue;
    const why = (nearKey && nearKey.test(p)) || (/\b(?:in|on|to) Jira\b/i.test(p) && JIRA_VERB.test(p))
      ? 'a Jira write (the filer makes links and field changes when filing)'
      : PRODUCTION.test(p) ? 'a live production run'
        : OPERATOR.test(p) ? 'an operator or human step (it belongs under Verification, with who does it)' : null;
    if (why) add('blocking', 'criterion', `line ${l.n} is a criterion the worker cannot do in its branch, ${why}: "${quote(l.text)}"`);
  }

  // ---- advisory ----
  if (!sec(/^out of scope\b/i)) add('advisory', 'section', 'no "Out of scope" section ("None." is an answer)');
  if (!sec(/^verification\b/i)) add('advisory', 'section', 'no "Verification" section');

  const blocks = new Set(t.blocks ?? []);
  const skip = new Set([t.key, t.parent?.key, ...blocks].filter(Boolean));
  if (key) {
    const named = [];
    for (const s of secs.filter((x) => !/^children\b/i.test(x.name))) {
      for (const l of s.lines) for (const m of prose(l.text).matchAll(new RegExp(`\\b${key}\\b`, 'g'))) {
        if (!skip.has(m[0]) && !named.includes(m[0])) named.push(m[0]);
      }
    }
    if (named.length) add('advisory', 'dependency', `names ${named.join(', ')} with no Blocks link: link each one that is a dependency (desk-jira link)`);
  }
  const text = all.map((l) => prose(l.text)).join('\n').toLowerCase();
  for (const sib of t.siblings ?? []) {
    const title = String(sib.summary ?? '').trim();
    if (skip.has(sib.key) || title.length < 12) continue;
    if (text.includes(title.toLowerCase())) add('advisory', 'dependency', `names its sibling ${sib.key} ("${quote(title)}") with no Blocks link: link it if it is a dependency`);
  }

  for (const f of t.facts ?? []) add('advisory', 'fact', `line ${f.line}, "${quote(f.text)}": status, priority and size live in their fields, not the body`);

  if (t.wiki) {
    const render = [];
    lines.forEach((l, i) => {
      const plain = l.replace(/\{\{.*?\}\}/g, ' ');
      const prev = i > 0 ? lines[i - 1] : '';
      if (/^\s*#{2,6}\s+\S/.test(l) && !/^\s*#/.test(prev)) render.push(`line ${i + 1} has a markdown heading, which shows as a numbered list`);
      if (/\*\*[^*\s][^*\n]*?\*\*/.test(plain)) render.push(`line ${i + 1} has **bold**, which shows the asterisks`);
      if (/`[^`\n]+`/.test(plain)) render.push(`line ${i + 1} has a backtick span, which shows the backticks`);
      for (const m of l.matchAll(/\{\{(.*?)\}\}/g)) {
        if (/(?<!\\)--/.test(m[1])) { render.push(`line ${i + 1} has an unescaped -- inside {{ }}, which renders as strikethrough`); break; }
      }
    });
    if (render.length) add('advisory', 'render', `markdown that will not render: ${render.join('; ')}: write the body as a .md file and desk-jira converts it`);
  }

  if (root && dir) {
    const issue = { key: t.key, text: t.text, fields: { parent: t.parent ?? undefined } };
    for (const f of checkTicket(issue, { root, dir })) {
      const url = /artifact (\S+), but no copy is saved/.exec(f.message)?.[1];
      if (f.severity === 'blocking' && url && snapshotted(url)) add('advisory', 'design', `${f.message}; autopilot has snapshotted it, so the worker saves it`);
      else add(f.severity, 'design', f.message);
    }
  }
  return findings;
}

// Where saved design canvases live, for checkTicket: none when the repo saves none.
export function designRoot() {
  let dir = null;
  try { dir = designDir(); } catch { return {}; }
  let root;
  try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { root = process.cwd(); }
  return { root, dir };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  let t;
  try { t = JSON.parse(readFileSync(0, 'utf8')); } catch (e) { console.error(`ticket-lint: unreadable ticket JSON on stdin: ${e.message}`); process.exit(2); }
  const findings = lintTicket(t, designRoot());
  if (process.argv.includes('--json')) console.log(JSON.stringify(findings));
  else if (!findings.length) console.log('ok: no findings');
  else for (const f of findings) console.log(`${f.severity}: ${f.message}`);
  process.exit(findings.some((f) => f.severity === 'blocking') ? 1 : 0);
}
