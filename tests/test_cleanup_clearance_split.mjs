// suite: desk-cleanup and desk-clearance split (a core of 20 KB or less, each step's rules in its own file)
// tests/fixtures/desk-<skill>-before-split.md is each SKILL.md as one file. Every heading, table row
// and paragraph of it must still be in the core or exactly one reference file, the core must name
// the file to read at each step, and every citation of a section of either skill must still find it.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSplit, norm, walk } from './split_check.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAP = 20480;

// Each skill: the word for its steps, their numbers, how many headings the old file had, and the
// reference files it already had, which the split left alone.
const SKILLS = {
  'desk-cleanup': { unit: 'step', steps: ['1', '2', '3', '4', '5', '6'], headings: 19, kept: ['portable-checks.md'] },
  'desk-clearance': { unit: 'phase', steps: ['1', '2', '3', '4', '5', '6', '7', '8'], headings: 30, kept: ['hazards.md', 'repo-facts.md', 'reviewer-patterns.md', 'subagent-briefs.md'] },
};

const loaded = {};
for (const [name, { unit, steps, headings: headingCount, kept }] of Object.entries(SKILLS)) {
  const dir = join(root, 'skills', name);
  const refs = join(dir, 'references');
  const core = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const before = readFileSync(join(root, `tests/fixtures/${name}-before-split.md`), 'utf8');

  // AC1: the core is within the cap, which the file before the split was not.
  const within = (s) => Buffer.byteLength(s) <= CAP;
  t(`AC1 ${name} core is at most 20,480 bytes (${Buffer.byteLength(core)})`, within(core), true);
  t(`AC1 ${name} before the split would have failed it`, within(before), false);

  // AC3: the core's table names a file for every step, each exists, and each opens by saying it is
  // read at that step alone. Rows numbered "—" are situations, read when they come up.
  const table = [...core.matchAll(/^\| (\d+|—) \| [^|]+ \| `references\/([\w-]+\.md)` \|$/gm)].map((m) => [m[1], m[2]]);
  const numbered = new Map(table.filter(([n]) => n !== '—'));
  const named = table.map(([, f]) => f);
  t(`AC3 ${name} core table lists every ${unit}`, [...numbered.keys()], steps);
  t(`AC3 ${name} core table names no file twice`, new Set(named).size, named.length);
  for (const f of named) t(`AC3 ${name} names references/${f}, which exists`, existsSync(join(refs, f)), true);
  for (const [n, f] of numbered) {
    const text = readFileSync(join(refs, f), 'utf8');
    t(`AC3 ${name} ${f} says it is read at ${unit} ${n}`, text.includes(`Read at the start of ${unit} ${n}`), true);
    t(`AC3 ${name} ${f} holds the old ${unit} ${n} heading`, before.split('\n').filter((l) => new RegExp(`^#{2,3} ${n}\\. `).test(l)).every((h) => text.split('\n').includes(h)), true);
    const others = [...text.matchAll(new RegExp(`${unit}-\\d[\\w-]*\\.md`, 'g'))].map((m) => m[0]).filter((x) => x !== f);
    t(`AC3 ${name} ${f} names no other ${unit}'s file`, others, []);
  }
  t(`AC3 ${name} a ${unit} file that cannot be read stops the run`, new RegExp(`\\*\\*A ${unit} file you cannot read stops the (run|pass)\\.\\*\\*`).test(core), true);

  // AC2: every heading, table row and paragraph of the old file is in exactly one file of the split.
  // A reference file the table does not name is one that was there before the split; any other is a
  // copy hiding from the count.
  const onDisk = readdirSync(refs).filter((f) => f.endsWith('.md'));
  t(`AC2 ${name} every reference file is named by the table or predates the split`, onDisk.filter((f) => !named.includes(f) && !kept.includes(f)), []);
  const files = ['SKILL.md', ...named];
  const read = (f) => (f === 'SKILL.md' ? core : readFileSync(join(refs, f), 'utf8'));
  checkSplit({ t, label: `AC2 ${name}`, before, files, read, headings: headingCount, minRows: 15 });

  // A name is at home where it is a heading, or a bold or italic lead at the start of a line or item.
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const home = (cited) => files.filter((f) => read(f).split('\n').some((l) => (/^#+ /.test(l) && l.replace(/^#+ (\d+\. )?/, '').startsWith(cited)) || new RegExp(`^\\s*(?:[-*] |\\d+\\. )?\\*{1,2}${esc(cited)}`).test(l)));
  loaded[name] = { unit, numbered, home, read, core };
}

// AC4: every citation of a section of either skill still finds it. From another skill: a step or
// phase by number is one the core's table lists, and a quoted name is a heading or lead in exactly one
// file of the skill. Scripts are read as well as skills: a comment citing a section is a citation.
const sources = [...walk(join(root, 'skills'), ['.md', '.mjs', '.sh']), ...walk(join(root, 'desk'), ['.mjs', '.sh']), join(root, 'README.md')];
let byNumber = 0, byName = 0;
for (const p of sources) {
  const text = norm(readFileSync(p, 'utf8'));
  const label = `${basename(dirname(p))}/${basename(p)}`;
  for (const m of text.matchAll(/(desk-cleanup|desk-clearance)`?(?:'s)?[^.()]{0,40}\((?:its )?(step|phase) (\d+)\)|(desk-cleanup|desk-clearance)`?(?:'s)? (step|phase) (\d+)/g)) {
    const [skill, unit, n] = m[1] ? [m[1], m[2], m[3]] : [m[4], m[5], m[6]];
    byNumber++;
    t(`AC4 ${label} cites ${skill} ${unit} ${n}: the core lists it`, loaded[skill].unit === unit && loaded[skill].numbered.has(n), true);
  }
  for (const m of text.matchAll(/(desk-cleanup|desk-clearance)`?(?:'s)? "([A-Z][^"]{2,79})"/g)) {
    byName++;
    t(`AC4 ${label} cites ${m[1]} "${m[2]}": found in exactly one file`, loaded[m[1]].home(m[2]).length, 1);
  }
}
t(`AC4 the citations by number were read (${byNumber})`, byNumber >= 1, true);

// A skill's own script that cites "SKILL.md step N" sends the reader to the core, which no longer
// holds any step's rules: it must name the step's reference file instead.
for (const [name, { unit }] of Object.entries(SKILLS)) {
  const bin = join(root, 'skills', name, 'bin');
  for (const p of existsSync(bin) ? walk(bin, ['.mjs', '.sh']) : []) {
    const stale = [...norm(readFileSync(p, 'utf8')).matchAll(new RegExp(`SKILL\\.md'?s? ${unit} \\d+`, 'g'))].map((m) => m[0]);
    t(`AC4 ${name}/bin/${basename(p)} cites no ${unit} as being in SKILL.md`, stale, []);
  }
}
t('AC4 desk-jira still cites desk-cleanup\'s Jira sweep as its step 1', /`desk-cleanup`'s Jira sweep\*\* \(its step 1\)/.test(readFileSync(join(root, 'skills/desk-jira/SKILL.md'), 'utf8')), true);
console.log(`     citations by name read: ${byName}`);

// Within each skill, a section cited by name from one file is where the citation sends the reader:
// the core, or the step file the core's table names.
const INSIDE = [
  ['desk-cleanup', 'SKILL.md', 'see Ownership', 'Ownership', 'SKILL.md'],
  ['desk-cleanup', 'SKILL.md', '(step 2, "Check for live processes")', 'Check for live processes', 'step-2-worktrees.md'],
  ['desk-cleanup', 'step-2-worktrees.md', 'see Orphaned worktree directories', 'Orphaned worktree directories', 'step-2-worktrees.md'],
  ['desk-cleanup', 'step-3-branches.md', 'See Red flags.', 'Red flags', 'SKILL.md'],
  ['desk-clearance', 'SKILL.md', '(*Parking blocks the merge, never the comments*)', 'Parking blocks the merge, never the comments', 'SKILL.md'],
  ['desk-clearance', 'phase-7-hand-back.md', 'see **Parking is not a hand-back**', 'Parking is not a hand-back', 'SKILL.md'],
  ['desk-clearance', 'repo-facts.md', 'see the merge bar in SKILL.md', 'The merge bar', 'SKILL.md'],
];
for (const [skill, from, cite, target, want] of INSIDE) {
  t(`AC4 ${skill} ${from} still cites "${target}"`, norm(loaded[skill].read(from)).includes(cite), true);
  t(`AC4 and "${target}" is in ${want} alone`, loaded[skill].home(target), [want]);
}
const step2 = loaded['desk-cleanup'].numbered.get('2');
t('AC4 desk-cleanup\'s table sends step 2 to the file holding "Check for live processes"', step2, 'step-2-worktrees.md');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
