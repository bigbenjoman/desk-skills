// suite: desk-ci split (a core of 20 KB or less, and the rest in reference files read at their step)
// covers: skills/** agents/** docs/** README.md
// tests/fixtures/desk-ci-before-split.md is desk-ci's SKILL.md as one file. Every heading, table row
// and paragraph of it must still be in the core or one reference file, the core must name the file
// to read at each step whose rules moved, and every citation of a desk-ci section must still find it.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSplit, checkSize, stepTable, paragraphs, norm, walk } from './split_check.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = join(root, 'skills/desk-ci');
const refs = join(skill, 'references');
const core = readFileSync(join(skill, 'SKILL.md'), 'utf8');
const refFiles = readdirSync(refs).filter((f) => f.endsWith('.md')).sort();
const files = ['SKILL.md', ...refFiles];
const read = (f) => (f === 'SKILL.md' ? core : readFileSync(join(refs, f), 'utf8'));
const lines = (f) => read(f).split('\n');
const before = readFileSync(join(root, 'tests/fixtures/desk-ci-before-split.md'), 'utf8');

// AC1: the core is at most 20,480 bytes, the bound is a real one, and desk-ci is off the size
// check's allow-list.
checkSize({ t, root, name: 'desk-ci', core, before });

// AC2: each heading, table row and paragraph of the old file is in exactly one file, word for word.
// The fixture stays frozen, so a paragraph a later ticket rewrote is named by text only it holds
// (`split_check.mjs`'s `rewritten`).
const REWRITTEN = [
  ['DS-259', '"Can resolve" means any value other than a GitHub-hosted image label', 1], // a repo's declared AWS runner labels resolve to its own cloud runner
  ['DS-261', 'and the protection writes below, each shown first', 1], // `aws-fallback off` is a write too
];
checkSplit({ t, label: 'AC2', before, files, read, headings: 10, minRows: 26, rewritten: REWRITTEN });

// AC3: the core's step table names, for each step, the sections it moved and the one file to read.
const table = stepTable(core);
t(`AC3 the core's step table is read (${table.length} rows)`, table.length >= 2, true);
for (const { file } of table) t(`AC3 the table's ${file} exists and is not empty`, existsSync(join(refs, file)) && read(file).trim().length > 0, true);
t('AC3 every reference file is named by the step table', refFiles.filter((f) => !table.some((r) => r.file === f)), []);
t('AC3 no step names two files', table.map((r) => r.step).filter((s, i, a) => a.indexOf(s) !== i), []);
t('AC3 no file is named by two steps', table.map((r) => r.file).filter((s, i, a) => a.indexOf(s) !== i), []);
t('AC3 the core says to read the file a step names, and only that one', norm(core).includes('**At each step below, read the file the table names for it**, and only that one'), true);
t('AC3 a reference file that cannot be read stops the command', norm(core).includes('**A reference file you cannot read stops the command.**'), true);
t('AC3 and is named rather than worked from memory', norm(core).includes('stop and name it by its full path; never run the command from memory'), true);

const oldHeadings = before.split('\n').filter((l) => /^#{1,3} /.test(l));
const paras = paragraphs(before);
const moved = refFiles.filter((f) => oldHeadings.some((h) => lines(f).includes(h)) || paras.some((p) => p.length > 80 && norm(read(f)).includes(p)));
t(`AC3 the reference files with moved text are found (${moved.join(', ')})`, moved.length >= 2, true);
for (const f of moved) {
  t(`AC3 ${f} opens saying when it is read`, /^# [^\n]+\n\nRead before /.test(read(f)), true);
  const row = table.find((r) => r.file === f);
  for (const h of oldHeadings.filter((x) => lines(f).includes(x))) {
    const name = h.replace(/^#+ /, '');
    t(`AC3 the step table names "${name.slice(0, 50)}" beside ${f}`, Boolean(row?.sections.some((s) => name.startsWith(s))), true);
  }
}

// AC4: a citation of a desk-ci section still finds it. A section is a heading in exactly one file;
// one outside the core is one the core's step table names beside its file, so a reader opening
// SKILL.md gets there. Other files cite a section by its command (`/desk-ci measure`, `desk-ci
// measure`, `desk-ci.mjs measure`); the commands are the ones the core's argument-hint lists.
const home = (name) => files.filter((f) => lines(f).some((l) => /^#+ /.test(l) && l.replace(/^#+ /, '').startsWith(name)));
t('AC4 a section name no file holds is found nowhere', home('No such section'), []);
const reachable = (name, f) => f === 'SKILL.md' || Boolean(table.find((r) => r.file === f)?.sections.some((s) => name.startsWith(s) || s.startsWith(name)));
const resolves = (label, cite, name) => {
  const found = home(name);
  t(`AC4 ${label} cites ${cite}: found in exactly one desk-ci file`, found.length, 1);
  if (found.length === 1) t(`AC4 and the core leads to it in ${found[0]}`, reachable(name, found[0]), true);
};
const hint = core.match(/^argument-hint: "([^"]+)"/m)?.[1] ?? '';
const COMMANDS = [...new Set([...hint.matchAll(/(?:^|\| )([a-z][a-z-]+)/g)].map((m) => m[1]))];
t('AC4 the commands are read from the argument-hint', COMMANDS, ['classify', 'ci-lint', 'profile', 'measure', 'batch-red', 'protection', 'aws-fallback']);
// Commands whose rules sit under a section of another name.
const ALIAS = { classify: 'The placement rule' };
for (const c of COMMANDS) resolves('the argument-hint', c, ALIAS[c] ?? c);
const sources = [...['skills', 'agents', 'docs', 'desk/bin', 'bin'].flatMap((d) => (existsSync(join(root, d)) ? walk(join(root, d), ['.md', '.mjs', '.sh', '.py']) : [])), join(root, 'README.md')]
  .filter((p) => existsSync(p) && !p.startsWith(skill));
const count = { command: 0, inner: 0, path: 0 };
for (const p of sources) {
  const text = norm(readFileSync(p, 'utf8'));
  const label = relative(root, p);
  // /desk-ci measure, `desk-ci measure`, desk-ci.mjs batch-red
  for (const m of text.matchAll(/(?<![\w-])\/?desk-ci(?:\.mjs)?`? ([a-z][a-z-]+)/g)) {
    if (!COMMANDS.includes(m[1])) continue;
    count.command++;
    resolves(label, m[0], ALIAS[m[1]] ?? m[1]);
  }
  // desk-ci/references/measure.md
  for (const m of text.matchAll(/desk-ci(?:\/|'s `)references\/([\w.-]+\.md)/g)) {
    count.path++;
    t(`AC4 ${label} names desk-ci's references/${m[1]}: it exists`, existsSync(join(refs, m[1])), true);
  }
}
// Inside desk-ci: a reference file citing a section of the core by name, as profile's table does
// with "the placement rule".
for (const f of refFiles) {
  for (const m of norm(read(f)).matchAll(/the (placement rule)\b/g)) {
    count.inner++;
    t(`AC4 references/${f} cites "${m[0]}": it is the core's`, home(`The ${m[1]}`), ['SKILL.md']);
  }
}
t(`AC4 the citations by command were read (${count.command})`, count.command >= 8, true);
t(`AC4 desk-ci's own citations of its core were read (${count.inner})`, count.inner >= 1, true);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
