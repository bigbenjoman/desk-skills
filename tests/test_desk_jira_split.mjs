// suite: desk-jira split (a core of 20 KB or less, and the rest in reference files read at their step)
// covers: skills/** agents/** docs/** README.md
// tests/fixtures/desk-jira-before-split.md is desk-jira's SKILL.md as one file. Every heading, table
// row and paragraph of it must still be in the core or one reference file, the core must name the
// file to read at each step whose rules moved, and every citation of a desk-jira section must still
// find it.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = join(root, 'skills/desk-jira');
const refs = join(skill, 'references');
const core = readFileSync(join(skill, 'SKILL.md'), 'utf8');
const refFiles = readdirSync(refs).filter((f) => f.endsWith('.md')).sort();
const files = ['SKILL.md', ...refFiles];
const read = (f) => (f === 'SKILL.md' ? core : readFileSync(join(refs, f), 'utf8'));
const lines = (f) => read(f).split('\n');
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const before = readFileSync(join(root, 'tests/fixtures/desk-jira-before-split.md'), 'utf8');

// AC1: the core is at most 20,480 bytes, the bound is a real one, and desk-jira is off the size
// check's allow-list.
const CAP = 20480;
const within = (s) => Buffer.byteLength(s) <= CAP;
t(`AC1 the core is at most 20,480 bytes (${Buffer.byteLength(core)} bytes)`, within(core), true);
t('AC1 the size check fails one byte over', within('x'.repeat(CAP + 1)), false);
t('AC1 and the file before the split would have failed it', within(before), false);
const unsplit = readFileSync(join(root, 'tests/test_skill_size.mjs'), 'utf8').match(/^const UNSPLIT = \[([^\]]*)\]/m);
t('AC1 the size check\'s UNSPLIT list is read', Boolean(unsplit), true);
t('AC1 desk-jira is off UNSPLIT', /'desk-jira'/.test(unsplit?.[1] ?? "'desk-jira'"), false);

// AC3: the core's step table names, for each step, the sections it moved and the one file to read.
const table = [...core.matchAll(/^\| ([^|]+) \| ([^|]+) \| `references\/([\w.-]+\.md)` \|$/gm)]
  .map((m) => ({ step: m[1], sections: [...m[2].matchAll(/\*([^*]+)\*/g)].map((x) => x[1]), file: m[3] }));
t(`AC3 the core's step table is read (${table.length} rows)`, table.length >= 2, true);
for (const { file } of table) t(`AC3 the table's ${file} exists and is not empty`, existsSync(join(refs, file)) && read(file).trim().length > 0, true);
t('AC3 every reference file is named by the step table', refFiles.filter((f) => !table.some((r) => r.file === f)), []);
t('AC3 no step names two files', table.map((r) => r.step).filter((s, i, a) => a.indexOf(s) !== i), []);
t('AC3 the core says to read the file a step names, and only that one', /At each step below, read the\s+file the table names for it\*\*, and only that one/.test(core), true);
t('AC3 a reference file that cannot be read stops the write', core.includes('**A reference file you cannot read stops the write.**'), true);
t('AC3 and is named rather than worked from memory', /stop and name it by its full path; never write from memory/.test(core), true);

// The files holding text moved out of the old file: each opens saying when it is read, and every
// old heading in it is a section its row of the table names.
const oldHeadings = before.split('\n').filter((l) => /^#{1,3} /.test(l));
const paras = before.split(/\n[ \t]*\n|\n(?=[ \t]*(?:[-*]|\d+\.) )/).filter((p) => !/^\|/.test(p.trimStart())).map(norm).filter(Boolean);
const moved = refFiles.filter((f) => oldHeadings.some((h) => lines(f).includes(h)) || paras.some((p) => p.length > 80 && norm(read(f)).includes(p)));
t(`AC3 the reference files with moved text are found (${moved.join(', ')})`, moved.length >= 2, true);
for (const f of moved) {
  t(`AC3 ${f} opens saying when it is read`, /^# [^\n]+\n\nRead before /.test(read(f)), true);
  const row = table.find((r) => r.file === f);
  for (const h of oldHeadings.filter((x) => lines(f).includes(x))) {
    const name = h.replace(/^#+ /, '');
    t(`AC3 the step table names "${name}" beside ${f}`, Boolean(row?.sections.includes(name)), true);
  }
}

// AC2: each heading of the old file is in exactly one file.
t('AC2 the old file has its 12 headings', oldHeadings.length, 12);
for (const h of oldHeadings) t(`AC2 "${h}" is in exactly one file`, files.filter((f) => lines(f).includes(h)).length, 1);

// AC2: each table row is in one file. A header or separator row may repeat, so only body rows must
// be in exactly one.
const rows = before.split('\n').filter((l) => /^\|/.test(l));
const header = new Set(before.split('\n').flatMap((l, i, a) => (/^\|/.test(l) && /^\|[-| ]+\|$/.test(a[i + 1] || '') ? [l] : [])));
const body = rows.filter((r) => !header.has(r) && !/^\|[-| ]+\|$/.test(r));
t(`AC2 the old file's table rows are read (${body.length} body rows)`, body.length > 40, true);
for (const r of rows) {
  const n = files.filter((f) => lines(f).includes(r)).length;
  if (body.includes(r)) t(`AC2 row "${r.slice(0, 60)}" is in exactly one file`, n, 1);
  else t(`AC2 header "${r.slice(0, 40)}" is in a file`, n >= 1, true);
}

// AC2: and no rule is dropped. Every paragraph and list item of the old file is in one of the new
// files word for word (whitespace aside): the split moves text, it does not reword it.
const after = norm(files.map(read).join('\n\n'));
const dropped = paras.filter((p) => !after.includes(p));
t(`AC2 every paragraph of the old file survives the split (${paras.length} read)`, dropped.length, 0);
for (const p of dropped) console.log(`     dropped: ${p.slice(0, 120)}`);

// AC4: a citation of a desk-jira section by name still finds it. The name is a heading or a bold
// lead in exactly one desk-jira file, and a section outside the core is one the core's step table
// names beside that file (or the citation names the file), so a reader opening SKILL.md gets there.
const home = (name) => files.filter((f) => lines(f).some((l) => /^#+ /.test(l) && l.replace(/^#+ /, '').startsWith(name)) || read(f).includes(`**${name}`) || read(f).includes(`**"${name}"`));
t('AC4 a section name no file holds is found nowhere', home('No such section'), []);
const walk = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : /\.(md|mjs|sh|py)$/.test(e.name) ? [join(d, e.name)] : [])) : []);
// The fixtures are frozen copies of files as they were, and this file quotes the forms it looks for.
const sources = [...['skills', 'agents', 'docs', 'desk/bin', 'bin', 'tests'].flatMap((d) => walk(join(root, d))), join(root, 'README.md')]
  .filter((p) => existsSync(p) && p !== join(skill, 'SKILL.md') && !p.startsWith(join(root, 'tests/fixtures')) && p !== fileURLToPath(import.meta.url));
const resolves = (label, cite, name, file) => {
  const found = home(name);
  t(`AC4 ${label} cites ${cite}: found in exactly one desk-jira file`, found.length, 1);
  if (file) t(`AC4 and it is in ${file}, the file the citation names`, found, [file]);
  else if (found.length === 1 && found[0] !== 'SKILL.md') {
    const row = table.find((r) => r.file === found[0]);
    t(`AC4 and the core's step table leads to it in ${found[0]}`, Boolean(row?.sections.includes(name)) || cite.includes(found[0]), true);
  }
};
// Citations that name no section of their own: what each one means.
const ALIAS = { scale: 'Size every ticket', gate: 'Gate' };
const count = { name: 0, bare: 0, skillMd: 0, alias: 0, bold: 0, path: 0 };
for (const p of sources) {
  const raw = readFileSync(p, 'utf8');
  const text = norm(raw);
  const label = relative(root, p);
  // desk-jira's *Epics*, desk-jira *Fields*, desk-jira's *"Already fixed"*
  for (const m of text.matchAll(/desk-jira`?(?:'s)? \*"?([A-Z][^*"]{2,60}?)"?\*/g)) { count.name++; resolves(label, m[0], m[1]); }
  // (desk-jira Epics)
  for (const m of text.matchAll(/(?<![\w`/-])desk-jira (?!SKILL\.md)([A-Z][\w-]+)/g)) { count.bare++; resolves(label, m[0], m[1]); }
  // desk-jira SKILL.md: an "Epics" section. Naming the file is not enough: it must name the section.
  for (const m of text.matchAll(/desk-jira`?(?:'s)? SKILL\.md(?:[,:]? (?:an? |its )?[*"]([A-Z][^*"]{2,60}?)[*"])?/g)) {
    count.skillMd++;
    t(`AC4 ${label} cites "${m[0]}": it names a section`, Boolean(m[1]), true);
    if (m[1]) resolves(label, m[0], m[1], 'SKILL.md');
  }
  // desk-jira's scale, `desk-jira`'s gate
  for (const m of text.matchAll(/desk-jira`?'s (scale|gate)\b/g)) { count.alias++; resolves(label, m[0], ALIAS[m[1]]); }
  // Code that reads a section by its bold lead from a named desk-jira file, as tests/test_jira.sh
  // reads **Writing an epic** from SKILL.md. In prose a bold beside a path is the citer's own label.
  if (/\.(mjs|sh|py)$/.test(p)) {
    for (const l of raw.split('\n')) {
      const f = l.match(/desk-jira\/(SKILL\.md|references\/([\w.-]+\.md))/);
      if (!f) continue;
      for (const m of l.matchAll(/(?:\\?\*){2}([A-Z][^*\\]{2,60}?)(?:\\?\*){2}/g)) { count.bold++; resolves(label, `**${m[1]}** in desk-jira/${f[1]}`, m[1], f[2] ?? 'SKILL.md'); }
    }
  }
  for (const m of text.matchAll(/desk-jira(?:\/|'s `)references\/([\w.-]+\.md)/g)) {
    count.path++;
    t(`AC4 ${label} names desk-jira's references/${m[1]}: it exists`, existsSync(join(refs, m[1])), true);
  }
}
t(`AC4 the citations by name were read (${count.name})`, count.name >= 8, true);
t(`AC4 the citations by an unstarred name were read (${count.bare})`, count.bare >= 1, true);
t(`AC4 the citations of desk-jira SKILL.md were read (${count.skillMd})`, count.skillMd >= 2, true);
t(`AC4 the citations of desk-jira's scale and gate were read (${count.alias})`, count.alias >= 6, true);
t(`AC4 the sections code reads by their bold lead were read (${count.bold})`, count.bold >= 1, true);
t(`AC4 the citations by path were read (${count.path})`, count.path >= 3, true);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
