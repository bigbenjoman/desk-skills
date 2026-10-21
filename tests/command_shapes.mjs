// The Bash shapes Claude Code prompts on whatever the allow rules say, found in the shell code blocks
// of skill and reference files. A skill that teaches one of these makes every run of it prompt, so
// tests/test_command_shapes.mjs fails on any it finds under skills/.
//
//   node tests/command_shapes.mjs [<file or dir> ...]   # default: skills/; exit 1 on any hit
//
// What is scanned: fenced blocks tagged bash, sh, shell or zsh, every line; and console blocks, only
// the lines that start with `$ `. Untagged, text and other blocks are output or data, not commands.
// Heredoc bodies are data too and are skipped. Prose outside code blocks is never read.
//
// A line that must keep its shape carries the exemption marker as a shell comment with a reason:
//   some command   # shape-ok: <why this one has to be this shape>
// A marker with no reason is itself a hit.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const MARKER = 'shape-ok:';
const SHELL = new Set(['bash', 'sh', 'shell', 'zsh']);

// A <placeholder> the reader fills in. Masked first, so its `>` never reads as a redirect.
const PLACEHOLDER = /(?<!<)<[A-Za-z§.~][^<>\n]*?[^\s<>]>|(?<!<)<[A-Za-z]>/g;
const PH = '@PH@';

// Splits a command line into its code and its trailing comment, and returns the code masked: every
// character inside quotes becomes `_` (the quotes themselves stay), so a brace, `>` or `#` in a string
// is never read as shell syntax. Same length as the code, so an index into one is an index into both.
export function split(line) {
  let code = '', mask = '', q = null, i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (q === "'") { if (c === "'") { q = null; mask += c; } else mask += '_'; code += c; continue; }
    if (q === '"') {
      if (c === '\\' && i + 1 < line.length) { code += c + line[i + 1]; mask += '__'; i++; continue; }
      if (c === '"') { q = null; mask += c; } else mask += '_';
      code += c; continue;
    }
    if (c === '\\' && i + 1 < line.length) { code += c + line[i + 1]; mask += '__'; i++; continue; }
    if (c === "'" || c === '"') { q = c; code += c; mask += c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    code += c; mask += c;
  }
  return { code, mask, comment: line.slice(i) };
}

const FUNCTION = /(?:^\s*|[;&|(]\s*)(?:function\s+[\w.:-]+\s*(?:\(\s*\))?|[A-Za-z_][\w.:-]*\s*\(\s*\))\s*(?:\{|\(|$)/;
const GROUP = /(?:^|[;&|(]|&&|\|\|)\s*\{(?:\s|$)/;
// Claude Code's own check: an unquoted `{` with a quote before the next `}` (quoted braces blanked).
const BRACE_QUOTE = /\{[^}]*['"]/;
const HEREDOC = /(?<!<)<<(?!<)(-?)/g;
const CD = /^\s*\(?\s*cd\s+\S+\s*(?:&&|;)/;
// A write: `>`, `>>`, `>|`, `&>`, `n>`; not `>&n` (a dup), `>(` (process substitution), `->` or `=>`.
const REDIRECT = /(?<![<>=\-|])(?:&|\d)?(>>?|>\|)(?![&(>])\s*/g;

// Is a redirect target outside the working directory? Absolute, home, a variable, `..`, or a
// <placeholder> standing for a directory. /dev/null and the std streams are not writes to a file.
export function outside(target) {
  const t = target.replace(/^['"]|['"]$/g, '');
  if (!t) return false;
  if (/^\/dev\/(null|stdout|stderr|fd\/\d+|tty)$/.test(t)) return false;
  return /^(\/|~|\$|\.\.(\/|$))/.test(t) || t.startsWith(`${PH}/`);
}

// The shapes one logical command line has, each a short name the test prints.
export function shapes(line) {
  const { code, mask, comment } = split(line.replace(PLACEHOLDER, PH));
  const exempt = comment.match(/shape-ok:(.*)$/);
  if (exempt) return exempt[1].trim() ? [] : ['exemption with no reason'];
  const found = [];
  const fn = FUNCTION.test(mask);
  if (fn) found.push('function definition');
  else if (GROUP.test(mask)) found.push('brace group');
  else if (BRACE_QUOTE.test(mask)) found.push('brace with quote');
  if (CD.test(mask)) found.push('cd into another directory');
  const writes = [];
  for (const m of mask.matchAll(REDIRECT)) {
    const at = m.index + m[0].length;
    const end = mask.slice(at).search(/[\s;&|()<>]|$/);
    writes.push(code.slice(at, at + end));
  }
  const files = writes.filter((w) => w && !/^\/dev\//.test(w.replace(/^['"]/, '')));
  if (/(?<!<)<<(?!<)/.test(mask) && files.length) found.push('heredoc to file');
  if (writes.some(outside)) found.push('write outside cwd');
  return found;
}

// Heredoc delimiters a line opens, in order, so their bodies can be skipped. The `<<` is found in
// the mask (never inside a string); the word after it is read from the code, where a quoted
// delimiter (`<<'EOF'`) is still legible.
const delimiters = (line) => {
  const { code, mask } = split(line.replace(PLACEHOLDER, PH));
  return [...mask.matchAll(HEREDOC)].map((m) => {
    const w = code.slice(m.index + m[0].length).match(/^\s*(['"]?)\\?([\w.-]+)\1/);
    return w && { word: w[2], strip: m[1] === '-' };
  }).filter(Boolean);
};

// Every hit in one markdown file's text, {line, shape, text} with line 1-based, and the lines an
// exemption marker with a reason let through.
export function scan(text) {
  const lines = text.split('\n'), hits = [], exempt = [];
  let fence = null, lang = '', pending = [], cmd = null;
  const flush = () => {
    if (!cmd) return;
    for (const shape of shapes(cmd.text)) hits.push({ line: cmd.line, shape, text: cmd.first });
    if (/shape-ok:\s*\S/.test(split(cmd.text.replace(PLACEHOLDER, PH)).comment)) exempt.push({ line: cmd.line, text: cmd.first });
    pending.push(...delimiters(cmd.text));
    cmd = null;
  };
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const open = raw.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)/);
    if (!fence) {
      if (open) { fence = open[1]; lang = open[2].toLowerCase(); pending = []; cmd = null; }
      continue;
    }
    if (raw.trim().startsWith(fence[0].repeat(fence.length)) && raw.trim().replace(/[`~]/g, '') === '') {
      flush(); fence = null; continue;
    }
    if (!SHELL.has(lang) && lang !== 'console') continue;
    if (pending.length) {
      const d = pending[0];
      if ((d.strip ? raw.replace(/^\t+/, '') : raw) === d.word || raw.trim() === d.word) pending.shift();
      continue;
    }
    let line = raw;
    if (!cmd && lang === 'console') {
      if (!/^\s*\$ /.test(raw)) continue;
      line = raw.replace(/^\s*\$ /, '');
    }
    if (cmd) { cmd.text += ' ' + line.trim(); }
    else cmd = { line: n + 1, text: line, first: raw.trim() };
    // A trailing backslash continues the command on the next line.
    if (/\\$/.test(split(line).code)) { cmd.text = cmd.text.replace(/\\$/, ''); continue; }
    flush();
  }
  return { hits, exempt };
}

// Every .md file under the paths given, in name order.
export function markdownFiles(paths) {
  const out = [];
  const walk = (p) => {
    if (statSync(p).isDirectory()) {
      for (const e of readdirSync(p).sort()) if (!e.startsWith('.') && e !== 'node_modules') walk(join(p, e));
    } else if (p.endsWith('.md')) out.push(p);
  };
  for (const p of paths) walk(p);
  return out;
}

// Hits across files, each `{file, line, shape, text}`, plus every exempted line (for AC8's count).
export function scanFiles(files, root = process.cwd()) {
  const hits = [], exempt = [];
  for (const f of files) {
    const r = scan(readFileSync(f, 'utf8')), file = relative(root, f) || f;
    hits.push(...r.hits.map((h) => ({ file, ...h })));
    exempt.push(...r.exempt.map((h) => ({ file, ...h })));
  }
  return { hits, exempt };
}

export const report = (h) => `${h.file}:${h.line}: ${h.shape}: ${h.text}`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const { hits } = scanFiles(markdownFiles(args.length ? args : ['skills']));
  for (const h of hits) console.log(report(h));
  if (hits.length) console.log(`\n${hits.length} command shape(s) Claude Code prompts on; rewrite them or mark one "# ${MARKER} <reason>"`);
  process.exit(hits.length ? 1 : 0);
}
