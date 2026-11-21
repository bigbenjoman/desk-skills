// Every reference to code the skills, the agents and the worker contracts make, with its file and
// line: scripts, the queue and desk-env commands and their subcommands, queue flags, AUTOPILOT names,
// lock classes, ticket states, state-folder paths and § rows. It reports; it judges nothing.
//
//   node tests/prose_scan.mjs [--json] [<file or dir> ...]   # default: skills/ and agents/; exit 0
//
// What is read, and nothing else:
//   - inline code spans in prose (one may wrap onto the next line of its paragraph);
//   - fenced shell blocks, each logical command as command_shapes reads it (comments and heredoc
//     bodies are not code);
//   - a JSON block tagged with `<!-- contract: <name> -->` on the line before its fence;
//   - the opening marker of a generated facts region, `<!-- facts: <name> -->`.
// Free prose outside code spans, and untagged JSON or other blocks, are never read.
//
// One record per reference: {kind, value, context, file, line, in}. `in` is span, shell, json or
// facts (a span inside a facts region); `context` is the code it was read from. A subcommand and a
// flag carry `of`, the command they belong to; a lock carries `row`, the § command row id it is
// paired with on that command, or null. Kinds:
//   script      a .mjs/.js/.sh/.py file run or named as a program, as written
//   command     queue.mjs or desk-env;  subcommand  the word after it;  flag  a queue.mjs flag
//   autopilot   an AUTOPILOT_ name      lock   a with-lock.sh class     state  state=<v>, "state": "<v>"
//   state-path  the path under the state folder ($DESK_STATE, <state>, ~/.desk-autopilot/<slug>),
//               placeholders kept as written
//   row         a § row: the id desk-env get, list, cmds or perm reads, a <§N Row name> placeholder,
//               or a §N kebab-key
//   contract    a tagged JSON block's contract name     facts  a generated region's name
import { readFileSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { split, shellCommands, markdownFiles, PLACEHOLDER, FENCE, closesFence } from './command_shapes.mjs';
import { CONFIG_ROWS, CODE_SPAN } from '../desk/bin/desk-env.mjs';
import { autopilotNameRe as AUTOPILOT } from '../desk/bin/prose-facts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PATHS = ['skills', 'agents'];

// desk-env's CODE_SPAN read across a paragraph's lines, where a span may wrap onto the next one.
const SPAN = new RegExp(CODE_SPAN.source.replace('[^\\n]', '[\\s\\S]'), 'g');
if (SPAN.source === CODE_SPAN.source) throw new Error('prose_scan: CODE_SPAN no longer keeps a span to one line with [^\\n]; update SPAN');
const CONTRACT = /^\s*<!--\s*contract:\s*([\w.-]+)\s*-->\s*$/;
const FACTS_OPEN = /<!--\s*facts:\s*([\w.-]+)\s*-->/;
const FACTS_CLOSE = /<!--\s*\/facts(?::\s*[\w.-]+)?\s*-->/;
const STATE_ROOT = /(\$\{?DESK_STATE\}?|<state>|<DESK_STATE>|(?:~|\$HOME|\$\{HOME\})\/\.desk-autopilot\/<slug>)\/([^\s`'"),;|&]+)/g;
const STATE = /(?<![\w.-])state=([A-Za-z][\w-]*)|"state":\s*"([^"]*)"/g;
const SECTION_KEY = /(?<![\w<])§(\d+[a-z]?)\s+([a-z][a-z0-9]*(?:-[a-z0-9]+)+)/g;
const INTERPRETERS = new Set(['node', 'bash', 'sh', 'zsh', 'python', 'python3', 'exec', 'nohup']);
const SCRIPT = /\.(mjs|cjs|js|sh|py)$/;
const ROW_READS = new Set(['get', 'list', 'cmds', 'perm', 'perm-or-unset']);
const ROW_BY_NAME = new Map(Object.entries(CONFIG_ROWS).map(([id, r]) => [`§${r.section} ${r.row}`.toLowerCase(), id]));

// A placeholder's spaces held as \u0001 while a regex reads up to whitespace, so `<EPIC or KEY>` stays
// one word.
const holdSpaces = (s) => s.replace(PLACEHOLDER, (m) => m.replace(/ /g, '\u0001'));
const freeSpaces = (s) => s.replace(/\u0001/g, ' ');
const unquote = (w) => w.replace(/^(['"])(.*)\1$/, '$2');

// The simple commands in a piece of code, each as its words: split at ; & | ( ) and backticks outside
// quotes, a comment dropped, a placeholder kept whole as one word.
function simpleCommands(code) {
  const phs = [];
  const masked = code.replace(PLACEHOLDER, (m) => `@PH${phs.push(m) - 1}@`);
  const { code: c, mask } = split(masked);
  const restore = (w) => w.replace(/@PH(\d+)@/g, (_, i) => phs[+i]);
  const out = [];
  let start = 0;
  for (let i = 0; i <= mask.length; i++) {
    if (i < mask.length && !/[;&|()`\n]/.test(mask[i])) continue;
    const words = [];
    for (const m of mask.slice(start, i).matchAll(/\S+/g)) words.push(unquote(restore(c.slice(start + m.index, start + m.index + m[0].length))));
    if (words.length) out.push(words);
    start = i + 1;
  }
  return out;
}

// The § command row a with-lock.sh run is paired with: the placeholder after `--` (`<§4 E2E tests>`,
// `<e2e CMD>`), else a `desk-env cmds <id>` in the same code; null when neither names one.
function pairedRow(inner, context) {
  for (const w of inner) {
    const ph = /^<(.+)>$/.exec(w);
    if (!ph) continue;
    const byName = ROW_BY_NAME.get(ph[1].toLowerCase());
    if (byName) return byName;
    const cmd = /^([\w-]+) (?:CMD|command)$/i.exec(ph[1]);
    if (cmd && CONFIG_ROWS[`${cmd[1].toLowerCase()}-cmd`]) return `${cmd[1].toLowerCase()}-cmd`;
  }
  const cmds = /desk-env(?:\.sh|\.mjs)?\s+cmds\s+([\w-]+)/.exec(context);
  return cmds ? cmds[1] : null;
}

function command(words, context, push) {
  let i = 0;
  while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++;
  if (INTERPRETERS.has(words[i])) { i++; if (!words[i] || words[i].startsWith('-')) return; }
  const prog = words[i];
  if (!prog) return;
  const base = prog.split('/').pop();
  const rest = words.slice(i + 1);
  if (base === 'queue.mjs') {
    push({ kind: 'command', value: 'queue.mjs' });
    const sub = rest.find((w) => !w.startsWith('-'));
    if (sub) push({ kind: 'subcommand', value: sub, of: 'queue.mjs' });
    for (const w of rest) if (/^--?[A-Za-z]/.test(w)) push({ kind: 'flag', value: w.split('=')[0], of: sub ? `queue.mjs ${sub}` : 'queue.mjs' });
  } else if (/^desk-env(\.sh|\.mjs)?$/.test(base)) {
    push({ kind: 'command', value: 'desk-env' });
    let j = 0;
    while (j < rest.length && rest[j].startsWith('-')) j += rest[j] === '--batch' ? 2 : 1;
    const sub = rest[j];
    if (!sub) return;
    push({ kind: 'subcommand', value: sub, of: 'desk-env' });
    const id = rest[j + 1];
    if (ROW_READS.has(sub) && id && !id.startsWith('<') && !id.startsWith('-')) push({ kind: 'row', value: id });
  } else if (base === 'with-lock.sh') {
    push({ kind: 'script', value: prog });
    const dash = rest.indexOf('--');
    const inner = dash < 0 ? [] : rest.slice(dash + 1);
    if (rest[0] && !rest[0].startsWith('-')) push({ kind: 'lock', value: rest[0], row: pairedRow(inner, context) });
    if (inner.length) command(inner, context, push);
  } else if (SCRIPT.test(prog)) {
    push({ kind: 'script', value: prog });
  }
}

// Every reference in one piece of code. `shell` code has its comments dropped first.
export function refs(code) {
  const out = [];
  const text = split(holdSpaces(code)).code;
  const context = freeSpaces(text).replace(/\s+/g, ' ').trim();
  const push = (r) => out.push({ kind: r.kind, value: r.value, context, ...r });
  for (const words of simpleCommands(code)) command(words, context, push);
  for (const m of text.matchAll(AUTOPILOT)) push({ kind: 'autopilot', value: m[0] });
  for (const m of text.matchAll(STATE)) push({ kind: 'state', value: m[1] ?? m[2] });
  for (const m of text.matchAll(STATE_ROOT)) push({ kind: 'state-path', value: freeSpaces(m[2]).replace(/[.:]+$/, '') });
  for (const m of text.matchAll(PLACEHOLDER)) if (m[0].startsWith('<§')) push({ kind: 'row', value: freeSpaces(m[0].slice(1, -1)) });
  for (const m of text.matchAll(SECTION_KEY)) push({ kind: 'row', value: `§${m[1]} ${m[2]}` });
  return out;
}

// Every reference in one markdown file's text, each {kind, value, context, line, in, …}.
export function scan(text) {
  const lines = text.split('\n'), out = [];
  const add = (line, where, rs) => { for (const r of rs) out.push({ ...r, line, in: where }); };

  for (const cmd of shellCommands(text)) if (!cmd.unterminated) add(cmd.line, 'shell', refs(cmd.text));

  let fence = null, json = null, facts = null, para = [];
  const flushPara = () => {
    const joined = para.map((p) => p.text).join('\n');
    for (const m of joined.matchAll(SPAN)) {
      const at = joined.slice(0, m.index).split('\n').length - 1;
      const inner = m[0].slice(m[1].length, -m[1].length);
      add(para[at].n, para[at].facts ? 'facts' : 'span', refs(inner.replace(/\n/g, ' ')));
    }
    para = [];
  };
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    if (fence) {
      if (closesFence(raw, fence)) { fence = null; json = null; continue; }
      if (json) add(n + 1, 'json', refs(raw).filter((r) => r.kind === 'autopilot' || r.kind === 'state' || r.kind === 'state-path'));
      continue;
    }
    const open = raw.match(FENCE);
    if (open) {
      flushPara();
      fence = open[1];
      const tag = n > 0 && CONTRACT.exec(lines[n - 1]);
      if (tag && open[2].toLowerCase() === 'json') {
        json = tag[1];
        out.push({ kind: 'contract', value: tag[1], context: lines[n - 1].trim(), line: n + 1, in: 'json' });
      }
      continue;
    }
    if (!raw.trim()) { flushPara(); continue; }
    const f = FACTS_OPEN.exec(raw);
    if (f) { facts = f[1]; out.push({ kind: 'facts', value: f[1], context: raw.trim(), line: n + 1, in: 'facts' }); }
    para.push({ n: n + 1, text: raw, facts: !!facts });
    if (FACTS_CLOSE.test(raw)) facts = null;
  }
  flushPara();
  return out.sort((a, b) => a.line - b.line);
}

// References across files, each with its repo-relative file.
export function scanFiles(files, root = ROOT) {
  return files.flatMap((f) => scan(readFileSync(f, 'utf8')).map((r) => ({ ...r, file: relative(root, f) || f })));
}

const show = (r) => `${r.file}:${r.line}: ${r.kind} ${r.value}${r.of ? ` (${r.of})` : ''}${r.kind === 'lock' ? ` row=${r.row}` : ''}`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const paths = args.filter((a) => a !== '--json');
  const files = markdownFiles((paths.length ? paths : DEFAULT_PATHS).map((p) => (isAbsolute(p) ? p : join(paths.length ? process.cwd() : ROOT, p))));
  const records = scanFiles(files).map(({ kind, value, context, file, line, ...rest }) => ({ kind, value, context, file, line, ...rest }));
  if (asJson) {
    console.log(records.length ? `[\n${records.map((r) => JSON.stringify(r)).join(',\n')}\n]` : '[]');
  } else {
    for (const r of records) console.log(show(r));
    const counts = {};
    for (const r of records) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    console.log(`\n${records.length} reference(s) in ${files.length} file(s): ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
}
