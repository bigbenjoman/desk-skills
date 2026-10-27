// suite: desk-setup split (a core of 20 KB or less, and each step's rules in a reference file)
// covers: skills/** agents/** docs/** README.md
// tests/fixtures/desk-setup-before-split.md is desk-setup's SKILL.md as one file. Every heading,
// table row and paragraph of it must still be in the core or one reference file, the core must name
// the file to read at each step whose rules moved, and every citation of a desk-setup section must
// still find it.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSplit, checkSize, stepTable, paragraphs, norm, walk } from './split_check.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = join(root, 'skills/desk-setup');
const refs = join(skill, 'references');
const core = readFileSync(join(skill, 'SKILL.md'), 'utf8');
// permission-rows.md is the interview's row reference, not moved text; it is checked by its own suites.
// mode-costs.md is a mode written after the split, so it holds no moved text either.
const NOT_MOVED = ['permission-rows.md', 'mode-costs.md'];
const refFiles = readdirSync(refs).filter((f) => f.endsWith('.md') && !NOT_MOVED.includes(f)).sort();
const files = ['SKILL.md', ...refFiles];
const read = (f) => (f === 'SKILL.md' ? core : readFileSync(join(refs, f), 'utf8'));
const lines = (f) => read(f).split('\n');
const before = readFileSync(join(root, 'tests/fixtures/desk-setup-before-split.md'), 'utf8');

// AC1: the core is at most 20,480 bytes, the bound is a real one, and desk-setup is off the size
// check's allow-list.
checkSize({ t, root, name: 'desk-setup', core, before });

// AC2: each heading, table row and paragraph of the old file is in exactly one file, word for word.
// The headings counted include the `# §0 this repo` comments of step 1's detection block.
checkSplit({ t, label: 'AC2', before, files, read, headings: 33, minRows: 40 });

// AC3: the core's step table names, for each step, the sections it moved and the one file to read.
const table = stepTable(core);
t(`AC3 the core's step table is read (${table.length} rows)`, table.length >= 8, true);
for (const { file } of table) t(`AC3 the table's ${file} exists and is not empty`, existsSync(join(refs, file)) && read(file).trim().length > 0, true);
t('AC3 no step names two files', table.map((r) => r.step).filter((s, i, a) => a.indexOf(s) !== i), []);
t('AC3 no file is named for two steps', table.map((r) => r.file).filter((s, i, a) => a.indexOf(s) !== i), []);
t('AC3 the core says to read the file a step names, and only that one', norm(core).includes('**At each step, read the file the table names for it**, and only that one'), true);
t('AC3 a reference file that cannot be read stops setup', norm(core).includes('**A reference file you cannot read stops setup.**'), true);
t('AC3 and is named rather than worked from memory', norm(core).includes('stop and name it by its full path; never work the step from memory'), true);

// The old file's headings outside code fences: the detection block's `# §0 this repo` and the rest
// are comments in a command block, not sections.
const fenced = (text) => { let inside = false; return text.split('\n').filter((l) => { if (/^```/.test(l)) { inside = !inside; return false; } return !inside; }); };
const oldHeadings = fenced(before).filter((l) => /^#{1,3} /.test(l));
t(`AC3 the old file's sections are read (${oldHeadings.length})`, oldHeadings.length, 16);
const paras = paragraphs(before);
const moved = refFiles.filter((f) => oldHeadings.some((h) => lines(f).includes(h)) || paras.some((p) => p.length > 80 && norm(read(f)).includes(p)));
t(`AC3 the reference files with moved text are found (${moved.join(', ')})`, moved.length, refFiles.length);
t('AC3 every file with moved text is named by the step table', moved.filter((f) => !table.some((r) => r.file === f)), []);
for (const f of moved) {
  t(`AC3 ${f} opens saying when it is read`, /^# [^\n]+\n\nRead /.test(read(f)), true);
  const row = table.find((r) => r.file === f);
  for (const h of oldHeadings.filter((x) => lines(f).includes(x))) {
    const name = h.replace(/^#+ /, '');
    t(`AC3 the step table names "${name.slice(0, 50)}" beside ${f}`, Boolean(row?.sections.some((s) => name.startsWith(s))), true);
  }
}
// The sections left in the core: every old section a reference file does not hold is in the core.
const kept = oldHeadings.filter((h) => !refFiles.some((f) => lines(f).includes(h)));
t('AC3 the sections no reference file holds are in the core', kept.filter((h) => !lines('SKILL.md').includes(h)), []);

// AC4: a citation of a desk-setup section still finds it. A section by number is the `## N.`
// heading (`## §3b` for the autonomy rows) in exactly one file; a section by name is a heading or
// bold lead in exactly one file. A section outside the core is one the core's step table names
// beside its file, so a reader opening SKILL.md gets there.
const heading = (f, name) => lines(f).some((l) => /^#+ /.test(l) && l.replace(/^#+ /, '').startsWith(name));
const home = (name) => files.filter((f) => heading(f, name) || norm(read(f)).includes(`**${name}`));
t('AC4 a section name no file holds is found nowhere', home('No such section'), []);
// A bold lead (step 1's *Jira credentials*) is inside a section of its file, so the file being in the
// table is enough; a heading must be one of the sections the table names beside it.
const reachable = (name, f) => {
  const row = table.find((r) => r.file === f);
  return f === 'SKILL.md' || Boolean(row && (!heading(f, name) || row.sections.some((s) => name.startsWith(s) || s.startsWith(name))));
};
const resolves = (label, cite, name) => {
  const found = home(name);
  t(`AC4 ${label} cites ${cite}: found in exactly one desk-setup file`, found.length, 1);
  if (found.length === 1) t(`AC4 and the core leads to it in ${found[0]}`, reachable(name, found[0]), true);
  return found;
};
// By number, only a heading counts: step 1's offers are bold `**1. ` and `**2. ` leads.
const section = (label, cite, n, item) => {
  const name = files.some((f) => heading(f, `${n}. `)) ? `${n}. ` : `§${n}`;
  const found = files.filter((f) => heading(f, name));
  t(`AC4 ${label} cites ${cite}: its heading is in exactly one desk-setup file`, found.length, 1);
  if (found.length === 1) t(`AC4 and the core leads to section ${n} in ${found[0]}`, reachable(lines(found[0]).find((l) => /^#+ /.test(l) && l.replace(/^#+ /, '').startsWith(name)).replace(/^#+ /, ''), found[0]), true);
  // `desk-setup §4 step 5`: the step is the numbered item `5. ` in that section's file.
  if (item && found.length === 1) t(`AC4 and ${found[0]} holds item ${item}`, lines(found[0]).some((l) => l.startsWith(`${item}. `)), true);
};
const sources = [...['skills', 'agents', 'docs', 'desk/bin', 'bin', 'hooks', 'tests'].flatMap((d) => (existsSync(join(root, d)) ? walk(join(root, d), ['']) : [])), join(root, 'README.md'), join(root, 'install.sh'), join(root, 'desk-config.md')]
  .filter((p) => existsSync(p) && !/\.(png|jpe?g|gif|webp|pdf|gz|zip|html|jsonl)$/.test(p) &&!p.startsWith(join(root, 'tests/fixtures')) && p !== fileURLToPath(import.meta.url));
// Sections desk-setup's own files cite by name: each is a heading or bold lead in one file.
const INNER = ['0. Which repo, and where to start from', '1. Detect, then confirm', 'This computer', 'The pre-push hook', 'The desk gate workflow', '§3b: the autonomy rows', 'Re-running and revoking', 'Jira credentials', 'Memory ceiling'];
const count = { number: 0, step: 0, path: 0, inner: 0 };
const ownText = files.map(read).concat(readFileSync(join(refs, 'permission-rows.md'), 'utf8')).map(norm).join('\n');
for (const name of INNER) {
  t(`AC4 desk-setup's own files cite "${name}"`, ownText.includes(`*${name}*`) || ownText.includes(`"${name}"`) || ownText.includes(`*${name.split(' ')[0]}`), true);
  count.inner++; resolves('desk-setup', `"${name}"`, name);
}
for (const p of sources) {
  if (p.startsWith(skill) && !p.endsWith('permission-rows.md')) continue;
  const text = norm(readFileSync(p, 'utf8'));
  const label = relative(root, p);
  // desk-setup §2, `/desk-setup` §4b, desk-setup §4 step 5, /desk-setup §3b
  for (const m of text.matchAll(/desk-setup`?(?:'s)? §(\d+b?)\b(?: step (\d+))?/g)) { count.number++; section(label, m[0], m[1], m[2]); }
  // `/desk-setup` step 4b
  for (const m of text.matchAll(/desk-setup`? step (\d+b?)\b/g)) { count.step++; section(label, m[0], m[1]); }
  // desk-setup/references/permission-rows.md, desk-setup's `references/…`
  for (const m of text.matchAll(/desk-setup(?:\/|'s `)references\/([\w.-]+\.(?:md|json))/g)) {
    count.path++;
    const ok = existsSync(join(refs, m[1])) || (m[1] === 'desk-config.template.md' && existsSync(join(root, 'desk-config.md')));
    t(`AC4 ${label} names desk-setup's references/${m[1]}: it exists`, ok, true);
  }
}
// The core's own `references/` paths, and each reference file's.
for (const f of files) for (const m of norm(read(f)).matchAll(/(?<![\w-]'s )`references\/([\w.-]+\.md)`/g)) {
  if (m[1] === 'desk-config.template.md') continue;
  count.path++;
  t(`AC4 ${f} names references/${m[1]}: it exists`, existsSync(join(refs, m[1])), true);
}
t(`AC4 the citations by section number were read (${count.number})`, count.number >= 4, true);
t(`AC4 the citations by step were read (${count.step})`, count.step >= 2, true);
t(`AC4 the citations by path were read (${count.path})`, count.path >= 15, true);
t(`AC4 desk-setup's own citations of its sections were read (${count.inner})`, count.inner, INNER.length);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
