#!/usr/bin/env node
// Checks one ticket against skills/desk-jira/references/ticket-template.md and reports what would
// make triage ask or a worker park, so it is fixed before the ticket reaches a batch. desk-jira lint
// and create gather the ticket and pipe it here; ticket-facts.mjs records the result for plan-batch.
//   node ticket-lint.mjs [--json] < ticket.json
// ticket.json: {key, type, text, wiki, size, blocks, blocked_by, parent, siblings, facts}
//   text      the description: Jira wiki markup when wiki is true (render checks run), else markdown
//   size      the Size field's value, '' or null when unset (a first line `Size: M` also counts);
//             leave it out where a ticket has no size at all
//   blocks    the keys this ticket has a Blocks link with, either direction
//   blocked_by  the keys of those it is "blocked by"
//   parent    the parent as desk-jira get --json gives it, or null
//   siblings  [{key, summary}]: the parent's children
//   facts     [{line, text}]: the status, priority and size lines desk-jira refuses in a body
// Prints one `blocking: …` or `advisory: …` line per finding (or a JSON array with --json) and exits
// 1 when any is blocking, 0 otherwise, 2 on unreadable input.
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FIGMA_URL, baseRef, checkTicket, designDir, sections } from './desk-design.mjs';
import { configValue, isNone, stateDir } from './desk-env.mjs';
import { isEpic } from './desk-q-eta.mjs';

// The text with every line inside a {code}/{noformat} block or a ``` fence blanked, so nothing in
// code reads as prose and line numbers still match the source. Each block's line numbers are pushed
// onto `blocks`, one array per block. A tag inside a whole {{monospace}} span (a code span holding
// the word code or noformat) is text, not a macro: read as one, it opened a block nothing closed.
// Only whole spans are masked, so a tag touching a lone brace of code ({code}}{code}) still counts.
const MONOSPACE = /\{\{[^{}\n]*\}\}/g;
const MACRO_OPEN = /\{(?:code|noformat)(?::[^}]*)?\}/i;
const MACRO_CLOSE = /\{(?:code|noformat)\}/i;
function blankCode(text, blocks = []) {
  let fence = null; let macro = false;
  return String(text ?? '').split(/\r?\n/).map((l, i) => {
    const t = l.replace(MONOSPACE, (s) => ' '.repeat(s.length));
    if (macro) { blocks.at(-1).push(i + 1); if (MACRO_CLOSE.test(t)) macro = false; return ''; }
    if (fence) { blocks.at(-1).push(i + 1); if (l.trim().startsWith(fence)) fence = null; return ''; }
    const f = /^\s*(`{3,}|~{3,})/.exec(l);
    if (f) { fence = f[1]; blocks.push([i + 1]); return ''; }
    const m = MACRO_OPEN.exec(t);
    if (m) { blocks.push([i + 1]); if (!MACRO_CLOSE.test(t.slice(m.index + m[0].length))) macro = true; return ''; }
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
export const CRITERIA = /^(?:acceptance criteria|definition of done)\b/i;
// A Given/When/Then criterion: a line opening with Given (after a list mark, a list number or an AC1:
// label), or a one-line "given …, when …, then …". When and Then alone are left out: both open code
// lines too (a shell `then`, Kotlin's `when`).
const GWT = /^\W*(?:\d+\W+)?(?:AC\d+\W*)?given\b|\bgiven\b.*\bwhen\b.*\bthen\b/i;
const LABELLED = /^\W*(?:\d+\W+)?AC\d+\b/i;
const GIVEN = /^\W*(?:\d+\W+)?given\b/i;
const MORE = /^\W*(?:when|then|and|but)\b/i;
const NOT_CRITERIA = /^(?:out of scope|verification)\b/i;
const itemText = (l) => l.replace(/^\s*(?:[-*+#•]+|\d+[.)])?\s*/, '').trim();

// Given/When/Then criteria written with no ACn labels: [{text, lines}], one per criterion, in order: a
// line opening with Given and the When/Then/And/But lines straight under it, joined as one line, with
// the source line numbers. Read anywhere but code blocks holding no Given line and the Out of scope and
// Verification sections. [] where any line already carries an ACn label, or none reads as one.
export function unlabelledCriteria(text) {
  const code = [];
  const blanked = blankCode(text, code);
  const raw = String(text ?? '').split(/\r?\n/);
  if (raw.some((l) => LABELLED.test(l))) return [];
  const skip = new Set(code.filter((b) => !b.some((n) => GIVEN.test(raw[n - 1] ?? ''))).flat());
  for (const s of sections(blanked.join('\n')).filter((x) => NOT_CRITERIA.test(x.name))) for (const l of s.lines) skip.add(l.n);
  const out = [];
  let cur = null;
  raw.forEach((l, i) => {
    if (skip.has(i + 1)) cur = null;
    else if (GIVEN.test(l)) out.push(cur = { lines: [i + 1], parts: [itemText(l)] });
    else if (cur && MORE.test(l)) { cur.lines.push(i + 1); cur.parts.push(itemText(l)); }
    else cur = null;
  });
  return out.map((c) => ({ text: c.parts.join(' '), lines: c.lines })).filter((c) => /\bthen\b/i.test(c.text));
}

// `text` without the given source lines, and without any code block they leave holding nothing.
export function withoutLines(text, drop) {
  const code = [];
  blankCode(text, code);
  const raw = String(text ?? '').split(/\r?\n/);
  const gone = new Set(drop);
  for (const b of code) {
    if (!b.some((n) => gone.has(n))) continue;
    const empty = (l) => !l.trim() || /^\s*(?:`{3,}|~{3,}|\{(?:code|noformat)\})\s*$/i.test(l);
    if (b.slice(1).every((n) => gone.has(n) || empty(raw[n - 1] ?? ''))) b.forEach((n) => gone.add(n));
  }
  return raw.filter((_, i) => !gone.has(i + 1)).join('\n');
}
const WRITE = String.raw`(?:link(?:s|ed)?|block(?:s|ed)?|transition(?:s|ed)?|move[sd]?|assign(?:s|ed)?|label(?:s|l?ed)?|comment(?:s|ed)?|close[sd]?|reopen(?:s|ed)?|re-?parent(?:s|ed)?)`;
const JIRA_VERB = new RegExp(`\\b(?:create|set|update|edit|write|add)\\b|\\b${WRITE}\\b`, 'i');
const PRODUCTION =/\b(?:in|on|against) (?:production|prod)\b|\bproduction (?:data|database|traffic|run|users|site)\b|\blive (?:site|traffic|users|customers|data|database|measurement|environment)\b/i;
// A sentence that names production is a production run when it does something there, or when it is
// the criterion's then-clause ("then p95 in production is under 300 ms" can only be met there);
// "on production this is what every subscriber sees" only describes it.
const ACT = /\b(?:run|runs|ran|running|execute[sd]?|measure[sd]?|measuring|quer(?:y|ies|ied)|check(?:s|ed)?|verif(?:y|ies|ied)|confirm(?:s|ed)?|test(?:s|ed)?|deploy(?:s|ed)?|backfill(?:s|ed)?|migrate[sd]?|apply|applie[sd]|reproduce[sd]?|trigger(?:s|ed)?|monitor(?:s|ed)?|observe[sd]?|compare[sd]?|benchmark(?:s|ed)?|then)\b/i;
const runsOnProduction = (p) => p.split(/(?<=[.!?;])\s+/).some((s) => PRODUCTION.test(s) && ACT.test(s));
// A question, an open-decision word or a person step inside a quoted phrase is quoted copy, not the
// ticket's own. A parenthetical that is all one quote goes first, so a quote nested in another
// ("leaves a decision open ("decide")") does not pair its marks with the outer one's.
// Single quotes pair only at word edges, so an apostrophe ("it's", "users'", "'90s") never opens one.
const QUOTED = /"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<!\w)'(?!\d)[^'\n]*'(?!\w)/g;
const QUOTED_ASIDE = new RegExp(String.raw`\(\s*(?:${QUOTED.source})\s*\)`, 'g');
const unquoted = (s) => s.replace(QUOTED_ASIDE, ' ').replace(QUOTED, ' ');
const asides = (s, drop) => s.replace(/\(([^()\n]*)\)/g, (m, inner) => (drop(inner) ? ' ' : m));
// A parenthetical listing examples leaves nothing open: one opened by "e.g.", "for example" or
// "such as" with no second clause after a semicolon, or three or more short comma-separated items.
// An item opening with a joining word ("then notify X", "by Friday", "and ask Finance to approve")
// makes it a run of steps, not a list; a last item of "and" or "or" and two words at most still
// ends a list ("draft, TBD, and archived").
const EXAMPLE_LEAD = /^\s*(?:e\.g\.|(?:for (?:example|instance)|such as)\b)/i;
const JOINER = /^(?:and|or|then|with|at|by|before|after|until|once|if|when|while|unless|so|but|to)\b/i;
const exampleList = (inner) => {
  if (EXAMPLE_LEAD.test(inner)) return !inner.includes(';');
  const items = inner.split(',').map((x) => x.trim());
  const last = items.length - 1;
  const item = (x, i) => (i === last ? x.replace(/^(?:and|or)\s+(?=\S+(?:\s+\S+)?$)/i, '') : x);
  return items.length >= 3 && items.map(item).every((x) => x && x.split(/\s+/).length <= 5 && !JOINER.test(x));
};
// A parenthetical naming where a value comes from ("entered by hand in /desk-setup costs",
// "from subscriptions.md", "in the operator console") asks nobody to act, unless it names who does
// ("entered by the operator", "after the reviewer signs off").
const SOURCE = /^\s*(?:(?:entered|recorded|set|read|taken|kept|stored|written|typed|filled in|supplied|configured|defined|chosen|pasted)\s+(?:(?:by hand|manually)\s+)?(?:in|by|from|at|on|via|under|through)\b|(?:comes? |read |taken )?from\b)/i;
const ACTOR = /\bby (?:the |an? )?(?:operator|reviewer|person|user|someone)\b|\boperator (?:enters|runs|sets|types|checks|confirms|approves)\b|\bsigns? off\b|\bsign-off\b/i;
const valueSource = (inner) => SOURCE.test(inner) && !ACTOR.test(inner);
// "Neither leaves anything for anyone to decide" says nothing is left open. The words between are
// held to a few that keep it a denial, and the span never crosses another "decide".
const SETTLED = /\b(?:nothing|(?:neither|not|never|no)\b(?:(?!\bdecide\b)[^.;:!?])*?\banything)(?:\s+(?:is|was|are|left|else|more|open|remaining|here|for|anyone|anybody|someone|somebody|us|you|them))*\s+to decide\b/gi;
const OPERATOR = /\boperator\b|\bby hand\b|\bmanually\b|\bsigns? off\b|\bsign-off\b/i;
// The Size fallback, a first line `Size: M`, for a project with no Size field.
export const SIZE_LINE = /^\s*[*_]*size[*_]*\s*:\s*[*_]*\s*([a-z]+)/i;

// §4 Ticket key pattern, else <§4 Jira project>-<n>; null when neither is set. `value` reads one
// config row (this repo's by default; bench-build passes another repo's).
export function keyRegex(value = configValue) {
  const read = (id) => { try { return String(value(id) ?? '').trim(); } catch { return ''; } };
  const p = read('ticket-pattern');
  if (p && !isNone(p)) { try { new RegExp(p); return p; } catch { return null; } }
  const project = /^[`"]?([A-Z][A-Z0-9]*)\b/.exec(read('jira-project'))?.[1];
  return project ? `${project}-[0-9]+` : null;
}

export function lintTicket(t, { root, dir, ref } = {}) {
  const findings = [];
  const add = (severity, rule, message) => findings.push({ severity, rule, message });
  const code = [];
  const lines = blankCode(t.text, code);
  const secs = sections(lines.join('\n'));
  const keyPattern = keyRegex();
  const sec = (re) => secs.find((s) => re.test(s.name));
  const filled = (s) => !!s && s.lines.some((l) => l.text.trim());

  // ---- blocking ----
  // Criteria written as Given/When/Then inside a {code}/{noformat} block or fence count, so blankCode
  // emptied them: each block under the criteria heading holding a Given/When/Then line is read again
  // from the source, and every check below reads it as it reads prose criteria. Other blocks there
  // (a shell example, sample output) stay blank.
  const criteria = sec(CRITERIA);
  if (criteria) {
    const raw = String(t.text ?? '').split(/\r?\n/);
    const own = new Set(criteria.lines.map((l) => l.n));
    const back = new Set(code.filter((b) => own.has(b[0]) && b.some((n) => GWT.test(raw[n - 1] ?? ''))).flat());
    if (back.size) criteria.lines = criteria.lines.map((l) => (back.has(l.n) ? { n: l.n, text: raw[l.n - 1] ?? '' } : l));
  }
  const all = secs.flatMap((s) => s.lines);
  // Unlabelled Given/When/Then lines outside that heading are its criteria, unnumbered: the finding
  // carries them numbered, for admit to write under the heading (ticket-fill.mjs).
  const own = filled(criteria) ? [] : unlabelledCriteria(t.text);
  if (own.length) {
    findings.push({ severity: 'blocking', rule: 'criteria', numbered: own.map((c) => c.text),
      message: `no acceptance criteria section, but ${own.length} Given/When/Then criteria with no AC labels (line ${own.map((c) => c.lines[0]).join(', ')}): move them under an "Acceptance criteria" heading as AC1: … items` });
  } else if (!filled(criteria)) add('blocking', 'criteria', 'no acceptance criteria: add an "Acceptance criteria" section (an Epic\'s "Definition of done") of AC1: Given …, when …, then … items');

  for (const l of all) {
    const p = asides(unquoted(prose(l.text)), exampleList).replace(SETTLED, ' ');
    const hit = OPEN.map((re) => re.exec(p)).find(Boolean);
    if (hit) add('blocking', 'open-decision', `line ${l.n} leaves a decision open ("${hit[0]}"): "${quote(l.text)}": settle it with whoever owns it, then write the dated decision under Decisions`);
  }
  for (const s of secs.filter((x) => SCOPE.test(x.name))) {
    for (const l of s.lines) {
      if (unquoted(prose(l.text)).includes('?')) add('blocking', 'open-decision', `line ${l.n} asks a question in ${s.name}: "${quote(l.text)}": answer it before the ticket is filed`);
    }
  }

  const design = sec(/^design\b/i);
  const noUi = all.some((l) => /^\W*no ui\b/i.test(prose(l.text)));
  // A Figma URL counts wherever the description has it. A Claude Design link counts only in the
  // Design section, where the saved-copy check and triage look for it.
  if (!noUi && !FIGMA_URL.test(t.text ?? '') && !(design && design.lines.some((l) => /https?:\/\//i.test(l.text)))) {
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
      : runsOnProduction(p) ? 'a live production run'
        : OPERATOR.test(asides(unquoted(p), valueSource)) ? 'an operator or human step (it belongs under Verification, with who does it)' : null;
    if (why) add('blocking', 'criterion', `line ${l.n} is a criterion the worker cannot do in its branch, ${why}: "${quote(l.text)}"`);
  }

  // ---- advisory ----
  if (!sec(/^out of scope\b/i)) add('advisory', 'section', 'no "Out of scope" section ("None." is an answer)');
  if (!sec(/^verification\b/i)) add('advisory', 'section', 'no "Verification" section');

  const parent = t.parent?.key;
  if (parent && isEpic(t.parent?.fields?.issuetype) && (t.blocked_by ?? []).includes(parent)) {
    add('advisory', 'dependency', `linked as blocked by its own epic ${parent}, which is Done only once its children are, so the link can never clear: autopilot ignores it; remove it (desk-jira unlink)`);
  }

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
    for (const f of checkTicket(issue, { root, dir, ref, state: stateDir() })) add(f.severity, 'design', f.message);
  }
  return findings;
}

// Where saved design canvases live, for checkTicket: the repo, its design dir and the base ref they
// are read on; none when the repo saves none.
export function designRoot() {
  let dir = null;
  try { dir = designDir(); } catch { return {}; }
  let root;
  try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { root = process.cwd(); }
  return { root, dir, ref: baseRef(root) };
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
