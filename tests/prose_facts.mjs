// Regions of skill text generated from the code. Where a skill shows a value or rule the code decides,
// the text sits between markers and only this command writes it, so the prose stays hand-written
// around it:
//
//   … the refuter's vendor (<!-- facts: refuted-by -->`refuted_by`: … <!-- /facts -->) …
//
// A region may span lines; the closing marker may repeat the name (`<!-- /facts: <name> -->`). REGIONS
// holds every name, each reading its values from the module that decides them. Markers inside a fenced
// block are not regions.
//
//   node tests/prose_facts.mjs [--write] [<file or dir> ...]   # default: skills/ and agents/
//
// Without --write it names every region that is unknown, unclosed or not what the code says, and exits
// 1 on any; --write rewrites each known region to what the code says and changes nothing else.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownFiles, FENCE, closesFence } from './command_shapes.mjs';
import { DEFAULT_PATHS, FACTS_OPEN, FACTS_CLOSE } from './prose_scan.mjs';
import { VENDORS } from '../skills/desk-review/bin/verdict.mjs';
import { SPAWN_ORDER_RULE, KEEP_ORDER_RULE } from '../desk/bin/spawn-order.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WRITE = 'node tests/prose_facts.mjs --write';

const code = (v) => `\`${v}\``;
const either = (vs) => (vs.length < 2 ? vs.map(code).join('') : `${vs.slice(0, -1).map(code).join(', ')} or ${code(vs.at(-1))}`);

// name: { from: () => the values, read from the code; render: (values) => the region's text }.
export const REGIONS = {
  'refuted-by': {
    from: () => ({ vendors: VENDORS }),
    render: ({ vendors }) => `\`refuted_by\`: ${either(vendors)}, not an agent; absent when \`UNREFUTED\``,
  },
  'spawn-order': {
    from: () => ({ rule: SPAWN_ORDER_RULE, keep: KEEP_ORDER_RULE }),
    render: ({ rule, keep }) => `${rule}\n${keep}`,
  },
};

// The scanner's own two markers, so the two never disagree on what a region is: [, open name, close name].
const MARKER = new RegExp(`${FACTS_OPEN.source}|${FACTS_CLOSE.source}`, 'g');

// The regions in one file's text: { found: [{ name, line, from, to }], problems: [{ line, name, message }] }
// where text.slice(from, to) is the region's body between its markers.
export function regions(text) {
  const fenced = new Set();
  let fence = null;
  text.split('\n').forEach((raw, n) => {
    if (fence) { fenced.add(n + 1); if (closesFence(raw, fence)) fence = null; return; }
    const open = raw.match(FENCE);
    if (open) { fenced.add(n + 1); fence = open[1]; }
  });
  const lineAt = (i) => text.slice(0, i).split('\n').length;
  const found = [], problems = [];
  let open = null;
  for (const m of text.matchAll(MARKER)) {
    const line = lineAt(m.index);
    if (fenced.has(line)) continue;
    const [, opens, closes] = m;
    const name = opens ?? closes;
    if (opens) {
      if (open) problems.push({ line: open.line, name: open.name, message: `the generated region ${open.name} has no closing <!-- /facts --> before the next region opens` });
      open = { name, line, from: m.index + m[0].length };
    } else if (!open) {
      problems.push({ line, name: name ?? '', message: 'a closing <!-- /facts --> marker with no region open' });
    } else {
      if (name && name !== open.name) problems.push({ line, name: open.name, message: `the generated region ${open.name} is closed as ${name}` });
      found.push({ name: open.name, line: open.line, from: open.from, to: m.index });
      open = null;
    }
  }
  if (open) problems.push({ line: open.line, name: open.name, message: `the generated region ${open.name} has no closing <!-- /facts -->` });
  return { found, problems };
}

// The text a known region should hold; `values` overrides a region's values, as the prose check's
// test of a changed source does.
const rendered = (name, values = {}) => REGIONS[name].render(values[name] ?? REGIONS[name].from());
const bodyOf = (text, r) => text.slice(r.from, r.to).trim();

// Every problem with one file's regions: unknown, unclosed, or not what the code says.
export function regionProblems(text, { values } = {}) {
  const { found, problems } = regions(text);
  const out = [...problems];
  for (const r of found) {
    if (!Object.hasOwn(REGIONS, r.name)) {
      out.push({ line: r.line, name: r.name, message: `the generated region ${r.name} is not one tests/prose_facts.mjs knows: add it to REGIONS or remove its markers` });
    } else if (bodyOf(text, r) !== rendered(r.name, values)) {
      out.push({ line: r.line, name: r.name, message: `the generated region ${r.name} is not what the code says (edited by hand, or its source changed): run ${WRITE}` });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

// The text with every known region rewritten to what the code says, its surrounding whitespace kept,
// and the names of the regions that changed.
export function regenerate(text) {
  let out = '', at = 0;
  const changed = [];
  for (const r of regions(text).found) {
    if (!Object.hasOwn(REGIONS, r.name)) continue;
    const body = text.slice(r.from, r.to), want = rendered(r.name);
    if (body.trim() === want) continue;
    const [lead] = body.match(/^\s*/), [trail] = body.match(/\s*$/);
    out += text.slice(at, r.from) + (body.trim() ? lead : '') + want + (body.trim() ? trail : '');
    at = r.to;
    changed.push(r.name);
  }
  return { text: out + text.slice(at), changed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const paths = args.filter((a) => a !== '--write');
  const files = markdownFiles((paths.length ? paths : DEFAULT_PATHS).map((p) => (isAbsolute(p) ? p : join(paths.length ? process.cwd() : ROOT, p))));
  let bad = 0;
  for (const path of files) {
    const text = readFileSync(path, 'utf8'), file = relative(ROOT, path) || path;
    if (write) {
      const { text: next, changed } = regenerate(text);
      if (changed.length) { writeFileSync(path, next); console.log(`${file}: rewrote ${changed.join(', ')}`); }
    }
    for (const p of regionProblems(readFileSync(path, 'utf8'))) { bad++; console.log(`${file}:${p.line}: ${p.message}`); }
  }
  process.exit(bad ? 1 : 0);
}
