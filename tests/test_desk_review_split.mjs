// suite: desk-review split (a core of 20 KB or less, and each phase's rules in its own file)
// tests/fixtures/desk-review-before-split.md is desk-review's SKILL.md as one file. Every heading,
// table row and paragraph of it must still be in the core or one reference file, the core must name
// the file for each phase, and every citation of a desk-review section must still find it.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { norm, walk } from './split_check.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = join(root, 'skills/desk-review');
const refs = join(skill, 'references');
const core = readFileSync(join(skill, 'SKILL.md'), 'utf8');
const read = (f) => (f === 'SKILL.md' ? core : readFileSync(join(refs, f), 'utf8'));
const phaseFiles = readdirSync(refs).filter((f) => /^phase-.*\.md$/.test(f)).sort();
const files = ['SKILL.md', ...phaseFiles];
const before = readFileSync(join(root, 'tests/fixtures/desk-review-before-split.md'), 'utf8');

// AC1: the core is within the size check's cap (tests/test_skill_size.mjs), and the file before
// the split was not.
const CAP = 20480;
const within = (s) => Buffer.byteLength(s) <= CAP;
t(`AC1 the core is at most 20,480 bytes (${Buffer.byteLength(core)})`, within(core), true);
t('AC1 the size check fails one byte over', within('x'.repeat(CAP + 1)), false);
t('AC1 and the file before the split would have failed it', within(before), false);

// AC3: the core's table names a file for every phase, each exists and holds that phase's heading,
// and no phase file on disk goes unnamed.
const PHASES = ['0', '1', '2', '3', '4', '5', '6', '7'];
const table = new Map([...core.matchAll(/^\| (\d) \| [^|]+ \| `references\/(phase-[\w-]+\.md)`/gm)].map((m) => [m[1], m[2]]));
t('AC3 the core table lists every phase', JSON.stringify([...table.keys()]), JSON.stringify(PHASES));
t('AC3 the phase files on disk are the ones the core names', JSON.stringify(phaseFiles), JSON.stringify([...table.values()].sort()));
for (const [n, f] of table) {
  t(`AC3 phase ${n}'s file ${f} exists`, existsSync(join(refs, f)), true);
  if (existsSync(join(refs, f))) t(`AC3 ${f} holds the "## Phase ${n}:" heading`, new RegExp(`^## Phase ${n}: `, 'm').test(read(f)), true);
}
const named = [...core.matchAll(/`references\/([\w.-]+\.md)`/g)].map((m) => m[1]);
t(`AC3 the core names reference files (${new Set(named).size})`, new Set(named).size >= 10, true);
t('AC3 every reference file the core names exists', JSON.stringify(named.filter((f) => !existsSync(join(refs, f)))), '[]');
t('AC3 a phase file that cannot be read stops the review', core.includes('**A phase file you cannot read stops the review.**'), true);

// AC2: each heading of the old file is in exactly one new file.
const lines = (f) => read(f).split('\n');
const headings = before.split('\n').filter((l) => /^#{1,3} /.test(l));
t('AC2 the old file has its 22 headings', headings.length, 22);
for (const h of headings) t(`AC2 "${h}" is in exactly one file`, files.filter((f) => lines(f).includes(h)).length, 1);

// AC2: each table body row is in exactly one file; a header or separator row in at least one.
const rows = before.split('\n').filter((l) => /^\|/.test(l));
const header = new Set(before.split('\n').flatMap((l, i, a) => (/^\|/.test(l) && /^\|[-| ]+\|$/.test(a[i + 1] || '') ? [l] : [])));
const body = rows.filter((r) => !header.has(r) && !/^\|[-| ]+\|$/.test(r));
t(`AC2 the old file's table rows are read (${body.length} body rows)`, body.length > 50, true);
for (const r of rows) {
  const n = files.filter((f) => lines(f).includes(r)).length;
  if (body.includes(r)) t(`AC2 row "${r.slice(0, 60)}" is in exactly one file`, n, 1);
  else t(`AC2 header "${r.slice(0, 40)}" is in a file`, n >= 1, true);
}

// AC2: every paragraph of the old file is in a new file word for word (whitespace aside). Tables
// are checked row by row above. Not split_check.mjs's checkSplit: it counts a paragraph by
// substring, so the old file's bare "Then:" reads as in two files (the core's, and the end of a
// Phase 7 paragraph).
const after = norm(files.map(read).join('\n\n'));
const paras = before.split(/\n[ \t]*\n|\n(?=[ \t]*(?:[-*]|\d+\.) )/).filter((p) => !/^\|/.test(p.trimStart())).map(norm).filter(Boolean);
const dropped = paras.filter((p) => !after.includes(p));
t(`AC2 every paragraph of the old file survives the split (${paras.length} read)`, dropped.length, 0);
for (const p of dropped) console.log(`     dropped: ${p.slice(0, 120)}`);

// AC4: a citation of a desk-review section still finds it.
const sources = [...walk(join(root, 'skills')), ...walk(join(root, 'docs')), join(root, 'README.md')];
const label = (p) => `${basename(dirname(p))}/${basename(p)}`;
// Another skill or doc citing a desk-review phase by number: the core's table lists it.
let byPhase = 0;
for (const p of sources.filter((p) => !p.startsWith(skill + '/'))) {
  for (const m of norm(readFileSync(p, 'utf8')).matchAll(/desk-review`?(?:'s)? Phases? (\d)/g)) { byPhase++; t(`AC4 ${label(p)} cites desk-review Phase ${m[1]}: the core lists it`, table.has(m[1]), true); }
}
t(`AC4 the citations by phase were read (${byPhase})`, byPhase >= 3, true);
// Inside desk-review: a moved section is cited by its file, never as "SKILL.md Phase N".
const own = walk(skill);
for (const p of own) t(`AC4 ${label(p)} cites no phase as "SKILL.md Phase N"`, /SKILL\.md Phase \d/.test(norm(readFileSync(p, 'utf8'))), false);
// Every phase file another desk-review file names exists.
let byFile = 0;
for (const p of own) for (const m of readFileSync(p, 'utf8').matchAll(/(phase-\d-[\w-]+\.md)/g)) { byFile++; t(`AC4 ${label(p)} names ${m[1]}: it exists`, existsSync(join(refs, m[1])), true); }
t(`AC4 the citations by phase file were read (${byFile})`, byFile >= 15, true);
// A gotchas.md#anchor resolves to a heading of gotchas.md.
const slug = (h) => h.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
const anchors = new Set(readFileSync(join(refs, 'gotchas.md'), 'utf8').split('\n').filter((l) => /^#+ /.test(l)).map((l) => slug(l.replace(/^#+ /, ''))));
let byAnchor = 0;
for (const p of [...own, ...sources]) for (const m of readFileSync(p, 'utf8').matchAll(/gotchas\.md#([\w-]+)/g)) { byAnchor++; t(`AC4 ${label(p)} cites gotchas.md#${m[1]}: the heading exists`, anchors.has(m[1]), true); }
t(`AC4 the gotchas.md anchors were read (${byAnchor})`, byAnchor >= 5, true);
// A section named in italics inside desk-review (*Which review bar*, *The verdict*…) that names one
// of its own headings is in exactly one file.
const allHeadings = files.flatMap((f) => lines(f).filter((l) => /^#{2,3} /.test(l)).map((l) => l.replace(/^#+ /, '')));
const SECTIONS = ['Which review bar', 'Round 3 and above', 'Every seat\'s prompt', 'The verdict', 'Phases'];
for (const s of SECTIONS) {
  const cites = own.filter((p) => readFileSync(p, 'utf8').includes(`*${s}*`)).length;
  t(`AC4 *${s}* is cited inside desk-review (${cites})`, cites >= 1, true);
  t(`AC4 *${s}* is the start of exactly one heading`, allHeadings.filter((h) => h.startsWith(s)).length, 1);
}
// The old file's "(Phase 7)" and "(Phase 3, item 1)" pointers stay word for word (AC2), so they
// reach their section through the forwarding line of the phase file they name.
const FORWARDS = [
  ['phase-7-post.md', 'The verdict', /\(Phase 7\)/],
  ['phase-3-find.md', 'Every seat\'s prompt', /\(Phase 3, item 1\)/],
];
for (const [f, s, ptr] of FORWARDS) {
  const ptrs = phaseFiles.filter((p) => ptr.test(norm(read(p)))).length;
  t(`AC4 the old ${ptr.source.replace(/\\/g, '')} pointers are read (${ptrs})`, ptrs >= 1, true);
  t(`AC4 ${f} forwards to the core's *${s}*`, norm(read(f)).includes(`the core's *${s}*`), true);
}

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
