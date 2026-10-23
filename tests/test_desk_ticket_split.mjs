// suite: desk-ticket split (a short core, and each stage's rules in its own file)
// tests/fixtures/desk-ticket-before-split.md is desk-ticket's SKILL.md as one file. Every heading,
// table row and paragraph of it must still be in the core or one stage file, the core must stay
// small, and every other skill's citation of a desk-ticket section must still find it.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = join(root, 'skills/desk-ticket');
const refs = join(skill, 'references');
const core = readFileSync(join(skill, 'SKILL.md'), 'utf8');
const read = (f) => (f === 'SKILL.md' ? core : readFileSync(join(refs, f), 'utf8'));
const stageFiles = readdirSync(refs).filter((f) => /^stage-.*\.md$/.test(f)).sort();
const files = ['SKILL.md', ...stageFiles, 'design-canvas.md'];
const before = readFileSync(join(root, 'tests/fixtures/desk-ticket-before-split.md'), 'utf8');

// AC4: the core is at most 18KB, and the check is a real bound, not one that always passes.
const CAP = 18000;
const within = (s) => Buffer.byteLength(s) <= CAP;
t(`AC4 the core is at most 18KB (${Buffer.byteLength(core)} bytes)`, within(core), true);
t('AC4 the size check fails one byte over 18KB', within('x'.repeat(CAP + 1)), false);
t('AC4 and the file before the split would have failed it', within(before), false);

// AC1: the core lists every stage with the file to read for it, and each file exists.
const STAGES = ['0', '1', '2', '3', '4', '4b', '5', '6', '7', '8', '9'];
const table = new Map([...core.matchAll(/^\| (\w+) \| [^|]+ \| `references\/(stage-[\w-]+\.md)`/gm)].map((m) => [m[1], m[2]]));
t('AC1 the core table lists every stage', JSON.stringify([...table.keys()]), JSON.stringify(STAGES));
t('AC1 the stage files on disk are the ones the core names', JSON.stringify(stageFiles), JSON.stringify([...table.values()].sort()));
for (const [n, f] of table) {
  t(`AC1 stage ${n}'s file ${f} exists`, existsSync(join(refs, f)), true);
  t(`AC1 ${f} opens with stage ${n}'s row`, new RegExp(`^\\| ${n} \\| `, 'm').test(read(f)), true);
}

// AC2: each stage file is read at its stage and names no other stage's file, so reaching a stage
// never sends the session into another's.
t('AC2 the core says to read only the starting stage\'s file', /At the start of each\s+stage, read that stage's file, and only that one/.test(core), true);
for (const [n, f] of table) {
  const text = read(f);
  t(`AC2 ${f} says it is read at Stage ${n} alone`, text.includes(`Read at the start of Stage ${n}, and no other stage's file with it.`), true);
  const others = [...text.matchAll(/stage-[\w-]+\.md/g)].map((m) => m[0]).filter((x) => x !== f);
  t(`AC2 ${f} names no other stage's file`, JSON.stringify(others), '[]');
}

// AC5: a missing stage file stops the session and names it.
t('AC5 a stage file that cannot be read stops the ticket', core.includes('**A stage file you cannot read stops the ticket.**'), true);
t('AC5 and names it rather than working from memory', /stop and name it by its full path; never work the stage from memory/.test(core), true);

// AC3: each heading of the old file is in exactly one new file.
const lines = (f) => read(f).split('\n');
const headings = before.split('\n').filter((l) => /^#{1,3} /.test(l));
t('AC3 the old file has its 15 headings', headings.length, 15);
for (const h of headings) t(`AC3 "${h}" is in exactly one file`, files.filter((f) => lines(f).includes(h)).length, 1);

// AC3: each table row is in one file. A header or separator row repeats in every stage file that
// holds part of that table, so only body rows must be in exactly one.
const rows = before.split('\n').filter((l) => /^\|/.test(l));
const header = new Set(before.split('\n').flatMap((l, i, a) => (/^\|/.test(l) && /^\|[-| ]+\|$/.test(a[i + 1] || '') ? [l] : [])));
const body = rows.filter((r) => !header.has(r) && !/^\|[-| ]+\|$/.test(r));
t(`AC3 the old file's table rows are read (${body.length} body rows)`, body.length > 40, true);
for (const r of rows) {
  const n = files.filter((f) => lines(f).includes(r)).length;
  if (body.includes(r)) t(`AC3 row "${r.slice(0, 60)}" is in exactly one file`, n, 1);
  else t(`AC3 header "${r.slice(0, 40)}" is in a file`, n >= 1, true);
}

// AC3: and no rule is dropped. Every paragraph of the old file is in one of the new files, word for
// word (whitespace aside): the split moves text, it does not reword it. A table is checked row by
// row above, since its rows now sit in the files of the stages they belong to.
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const after = norm(files.map(read).join('\n\n'));
const paras = before.split(/\n[ \t]*\n|\n(?=[ \t]*(?:[-*]|\d+\.) )/).filter((p) => !/^\|/.test(p.trimStart())).map(norm).filter(Boolean);
const dropped = paras.filter((p) => !after.includes(p));
t(`AC3 every paragraph of the old file survives the split (${paras.length} read)`, dropped.length, 0);
for (const p of dropped) console.log(`     dropped: ${p.slice(0, 120)}`);

// AC6: a citation of a desk-ticket section by name still leads to it. The name is a heading or a
// bold lead in exactly one desk-ticket file, and a citation of anything outside the core names the
// file or its stage, so a reader opening SKILL.md knows where to go.
const stageOf = (f) => [...table].find(([, v]) => v === f)?.[0];
const home = (name) => files.filter((f) => read(f).split('\n').some((l) => l.startsWith(`**${name}`) || /^#+ /.test(l) && l.replace(/^#+ /, '').startsWith(name)) || read(f).includes(`**${name}`));
const leads = (f, at, name) => {
  const cite = at.trim();
  if (f === 'SKILL.md') return true;
  return cite.includes(f) || (stageOf(f) && new RegExp(`Stage ${stageOf(f)}\\b`).test(cite));
};
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.md') ? [join(d, e.name)] : []));
const sources = [...walk(join(root, 'skills')), join(root, 'README.md')].filter((p) => !p.startsWith(refs + '/stage-') && p !== join(skill, 'SKILL.md') && p !== join(refs, 'design-canvas.md'));
let cited = 0, byStage = 0;
for (const p of sources) {
  const text = norm(readFileSync(p, 'utf8'));
  const inTicket = p.startsWith(skill + '/');
  const label = `${basename(dirname(p))}/${basename(p)}`;
  // Another skill: `desk-ticket` [Stage N | `file.md`] "Name". desk-ticket's own references: (`file.md`, "Name").
  const re = inTicket
    ? /\(`?((?:SKILL|[\w-]+)\.md)`?, "([A-Z][^"]{2,79})"/g
    : /(?<!\/)desk-ticket`?(?:'s)?((?:,? Stage \w+,?)|(?: `[\w.-]+\.md`,?)|,)? "([A-Z][^"]{2,79})"/g;
  for (const m of text.matchAll(re)) {
    const [, where = '', name] = m;
    const found = home(name);
    cited++;
    t(`AC6 ${label} cites "${name}": found in exactly one desk-ticket file`, found.length, 1);
    if (found.length === 1) t(`AC6 and the citation leads to ${found[0]}`, leads(found[0], where, name), true);
  }
  // A stage cited by number is a stage the core's table lists, and a stage file cited with its stage
  // is that stage's file.
  if (!inTicket) for (const m of text.matchAll(/desk-ticket`?(?:'s)? Stage (\w+)/g)) { byStage++; t(`AC6 ${label} cites desk-ticket Stage ${m[1]}: the core lists it`, table.has(m[1]), true); }
  else for (const m of text.matchAll(/`(stage-[\w-]+\.md)`, Stage (\w+)/g)) { byStage++; t(`AC6 ${label} cites ${m[1]} as Stage ${m[2]}`, table.get(m[2]), m[1]); }
}
t(`AC6 the citations by name were read (${cited})`, cited >= 6, true);
t(`AC6 the citations by stage were read (${byStage})`, byStage >= 8, true);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
