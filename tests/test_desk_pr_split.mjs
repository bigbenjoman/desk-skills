// suite: desk-pr split (a core of 20 KB or less, and the rest in reference files read at their step)
// covers: skills/** agents/** docs/** README.md
// tests/fixtures/desk-pr-before-split.md is desk-pr's SKILL.md as one file. Every heading, table row
// and paragraph of it must still be in the core or one reference file, the core must name the file
// to read at each step whose rules moved, and every citation of a desk-pr section must still find it.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSplit, checkSize, stepTable, paragraphs, norm, walk } from './split_check.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = join(root, 'skills/desk-pr');
const refs = join(skill, 'references');
const core = readFileSync(join(skill, 'SKILL.md'), 'utf8');
const refFiles = readdirSync(refs).filter((f) => f.endsWith('.md')).sort();
const files = ['SKILL.md', ...refFiles];
const read = (f) => (f === 'SKILL.md' ? core : readFileSync(join(refs, f), 'utf8'));
const lines = (f) => read(f).split('\n');
const before = readFileSync(join(root, 'tests/fixtures/desk-pr-before-split.md'), 'utf8');

// AC1: the core is at most 20,480 bytes, the bound is a real one, and desk-pr is off the size
// check's allow-list.
checkSize({ t, root, name: 'desk-pr', core, before });

// AC2: each heading, table row and paragraph of the old file is in exactly one file, word for word.
const REWRITTEN = [
  ['DS-368', 'only when round 3 of the self-review carried P2s', 1], // round 2 carries P2s too
  ['DS-368', 'the P2s a third self-review round carried', 1],
  // each §4 row a worker reads is named with its desk-env call
  ['DS-405', 'below is the key matched by §4 Ticket key pattern', 1],
  ['DS-405', 'DIFF REVIEW — <recorded', 1],
  ['DS-405', '**§4 What review here consistently asks for.**', 1],
  ['DS-405', 'Files that feed a docs generator', 1],
  ['DS-405', '**Self-review has run.**', 1],
  ['DS-405', '**Capturing.** Playwright at the chosen widths', 1],
  ['DS-405', 'letting CI judge the body', 1],
  ['DS-405', "Merging with `--squash` because it's the usual", 1],
];
checkSplit({ t, label: 'AC2', before, files, read, headings: 23, minRows: 35, rewritten: REWRITTEN });

// AC3: the core's step table names, for each step, the sections it moved and the one file to read.
const table = stepTable(core);
t(`AC3 the core's step table is read (${table.length} rows)`, table.length >= 2, true);
for (const { file } of table) t(`AC3 the table's ${file} exists and is not empty`, existsSync(join(refs, file)) && read(file).trim().length > 0, true);
t('AC3 no step names two files', table.map((r) => r.step).filter((s, i, a) => a.indexOf(s) !== i), []);
t('AC3 the core says to read the file a step names, and only that one', norm(core).includes('**At each step below, read the file the table names for it**, and only that one'), true);
t('AC3 a reference file that cannot be read stops the PR', norm(core).includes('**A reference file you cannot read stops the PR.**'), true);
t('AC3 and is named rather than worked from memory', norm(core).includes('stop and name it by its full path; never write the body or open the PR from memory'), true);

// The old file's headings outside code fences: the body template's `### Changes` and the rest are
// lines of an example, not sections.
const fenced = (text) => { let inside = false; return text.split('\n').filter((l) => { if (/^```/.test(l)) { inside = !inside; return false; } return !inside; }); };
const oldHeadings = fenced(before).filter((l) => /^#{1,3} /.test(l));
const paras = paragraphs(before);
const moved = refFiles.filter((f) => oldHeadings.some((h) => lines(f).includes(h)) || paras.some((p) => p.length > 80 && norm(read(f)).includes(p)));
t(`AC3 the reference files with moved text are found (${moved.join(', ')})`, moved.length >= 2, true);
t('AC3 every file with moved text is named by the step table', moved.filter((f) => !table.some((r) => r.file === f)), []);
// A reference file the table does not name is one a named file hands on to, by name.
const handedOn = refFiles.filter((f) => !table.some((r) => r.file === f));
for (const f of handedOn) t(`AC3 ${f} is named by a file the step table names`, table.some((r) => read(r.file).includes(f)), true);
for (const f of moved) {
  t(`AC3 ${f} opens saying when it is read`, /^# [^\n]+\n\nRead before /.test(read(f)), true);
  const row = table.find((r) => r.file === f);
  for (const h of oldHeadings.filter((x) => lines(f).includes(x))) {
    const name = h.replace(/^#+ /, '');
    t(`AC3 the step table names "${name.slice(0, 50)}" beside ${f}`, Boolean(row?.sections.some((s) => name.startsWith(s))), true);
  }
}

// AC4: a citation of a desk-pr section still finds it. A section by number is the `## N.` heading
// in exactly one file; a section by name is a heading or bold lead in exactly one file. A section
// outside the core is one the core's step table names beside its file, so a reader opening SKILL.md
// gets there.
const home = (name) => files.filter((f) => lines(f).some((l) => /^#+ /.test(l) && l.replace(/^#+ /, '').startsWith(name)) || read(f).includes(`**${name}`));
t('AC4 a section name no file holds is found nowhere', home('No such section'), []);
const reachable = (name, f) => f === 'SKILL.md' || Boolean(table.find((r) => r.file === f)?.sections.some((s) => name.startsWith(s) || s.startsWith(name)));
const resolves = (label, cite, name) => {
  const found = home(name);
  t(`AC4 ${label} cites ${cite}: found in exactly one desk-pr file`, found.length, 1);
  if (found.length === 1) t(`AC4 and the core leads to it in ${found[0]}`, reachable(name, found[0]), true);
};
const sources = [...['skills', 'agents', 'docs', 'desk/bin', 'bin', 'tests'].flatMap((d) => (existsSync(join(root, d)) ? walk(join(root, d), ['.md', '.mjs', '.sh', '.py']) : [])), join(root, 'README.md')]
  .filter((p) => existsSync(p) && !p.startsWith(join(root, 'tests/fixtures')) && p !== fileURLToPath(import.meta.url));
// Citations that name no section of their own: what each one means.
const ALIAS = { 'canvas table': 'A ticket with a saved canvas' };
const count = { number: 0, name: 0, backtick: 0, alias: 0, path: 0, inner: 0 };
for (const p of sources) {
  const text = norm(readFileSync(p, 'utf8'));
  const label = relative(root, p);
  const own = p.startsWith(skill);
  if (!own) {
    // `desk-pr` §4 "Before every push", `desk-pr` §1
    for (const m of text.matchAll(/desk-pr`?(?:'s)? §(\d)\b(?: "([^"]+)")?/g)) {
      count.number++;
      const heads = files.filter((f) => lines(f).some((l) => l.startsWith(`## ${m[1]}. `)));
      t(`AC4 ${label} cites ${m[0]}: section ${m[1]} is in exactly one desk-pr file`, heads.length, 1);
      if (heads.length === 1) {
        const name = lines(heads[0]).find((l) => l.startsWith(`## ${m[1]}. `)).slice(3);
        t(`AC4 and the core leads to section ${m[1]} in ${heads[0]}`, reachable(name, heads[0]), true);
      }
      if (m[2]) { count.name++; resolves(label, m[0], m[2]); }
    }
    // `desk-pr`'s "Before every push"
    for (const m of text.matchAll(/desk-pr`?'s`? "([A-Z][^"]{2,60})"/g)) { count.name++; resolves(label, m[0], m[1]); }
    // `Decisions taken` (`desk-pr`)
    for (const m of text.matchAll(/`([A-Z][^`]{2,60})` \(`desk-pr`\)/g)) { count.backtick++; resolves(label, m[0], m[1]); }
    // desk-pr's canvas table
    for (const m of text.matchAll(/desk-pr`?'s (canvas table)\b/g)) { count.alias++; resolves(label, m[0], ALIAS[m[1]]); }
    // desk-pr/references/screenshot-surfaces.md
    for (const m of text.matchAll(/desk-pr(?:\/|'s `)references\/([\w.-]+\.md)/g)) {
      count.path++;
      t(`AC4 ${label} names desk-pr's references/${m[1]}: it exists`, existsSync(join(refs, m[1])), true);
    }
  } else {
    // Inside desk-pr: see "Editing the body later" in §4
    for (const m of text.matchAll(/"([A-Z][^"]{2,60})" in §(\d)/g)) { count.inner++; resolves(label, m[0], m[1]); }
    // desk-jira's `references/ticket-template.md` is another skill's.
    for (const m of text.matchAll(/(?<![\w-]'s )`references\/([\w.-]+\.md)`/g)) {
      count.path++;
      t(`AC4 ${label} names references/${m[1]}: it exists`, existsSync(join(refs, m[1])), true);
    }
  }
}
t(`AC4 the citations by section number were read (${count.number})`, count.number >= 3, true);
t(`AC4 the citations by section name were read (${count.name})`, count.name >= 2, true);
t(`AC4 the citations by a section name in backticks were read (${count.backtick})`, count.backtick >= 3, true);
t(`AC4 the citations of desk-pr's canvas table were read (${count.alias})`, count.alias >= 2, true);
t(`AC4 the citations by path were read (${count.path})`, count.path >= 5, true);
t(`AC4 desk-pr's own citations of its sections were read (${count.inner})`, count.inner >= 1, true);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
