// suite: desk-autopilot split (a core of 40 KB or less, and the rest in reference files read when needed)
// covers: skills/** agents/** docs/** README.md
// tests/fixtures/desk-autopilot-before-split.md is desk-autopilot's SKILL.md as one file. Every
// heading, table row and paragraph of it must still be in the core or one reference file, the core's
// reference table must name the file and the sections it holds, and every citation of a moved
// section must still find it.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSplit, paragraphs, norm, walk } from './split_check.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = join(root, 'skills/desk-autopilot');
const refs = join(skill, 'references');
const core = readFileSync(join(skill, 'SKILL.md'), 'utf8');
const refFiles = readdirSync(refs).filter((f) => f.endsWith('.md')).sort();
const files = ['SKILL.md', ...refFiles];
const read = (f) => (f === 'SKILL.md' ? core : readFileSync(join(refs, f), 'utf8'));
const lines = (f) => read(f).split('\n');
const before = readFileSync(join(root, 'tests/fixtures/desk-autopilot-before-split.md'), 'utf8');

// AC1: the core is at most 40 KB. It stays on test_skill_size.mjs's UNSPLIT list at that size; the
// step down to that check's 20 KB is a follow-up.
const CAP = 40960;
const within = (s) => Buffer.byteLength(s) <= CAP;
t(`AC1 the core is at most 40,960 bytes (${Buffer.byteLength(core)} bytes)`, within(core), true);
t('AC1 the size check fails one byte over', within('x'.repeat(CAP + 1)), false);
t('AC1 and the file before the split would have failed it', within(before), false);
const unsplit = readFileSync(join(root, 'tests/test_skill_size.mjs'), 'utf8').match(/^const UNSPLIT = \[([^\]]*)\]/m);
t('AC1 the 20 KB check\'s UNSPLIT list is read', Boolean(unsplit), true);
t('AC1 desk-autopilot is still on UNSPLIT while its core is over 20 KB', unsplit?.[1].includes("'desk-autopilot'") ?? false, Buffer.byteLength(core) > 20480);

// AC4: each heading, table row and paragraph of the old file is in exactly one file, word for word.
const REWRITTEN = [
  ['DS-361', 'the handoff briefing in its system prompt in place of the sibling notes', 1], // the briefing moved to the first message
  ['DS-397', '(under `waiting` too when no merge driver is running)', 1], // the pass releases a due hold itself
  ['DS-397', '(no merge grants), you release it:', 1],
  ['DS-385', 'and ask the user to share it with this subscription or give its files', 1], // an export is imported
  ['DS-419', 'naming the first), which `queue.mjs render` shows', 1], // held threads go to a fix worker first
  ['DS-419', 'marks the done row `merged`, so both wake you.', 1], // a done row with an open PR reads PR OPEN
  ['DS-411', 'a person merges: the driver and you never merge them', 1], // a hold's named routine is the driver's
  ['DS-433', 'pinned, the moment it is green (never a PR under a §4 Merge holds glob)', 1], // it also needs a clean review at its head
  ['DS-466', 'reports it as paused, holds every spawn and resume, and', 1], // with more than one login, only its login is benched
  ['DS-109', 'freeing its slot, unless its last marker is', 1], // a worker running its suite under the test lock, or waiting for it, is not stalled
  ['DS-435', 'and a head gets one try at most. After two tries', 1], // a conflict counts only conflict tries
  ['DS-429', 'Only none matched is reported under `WAITING ON YOU`. Only the body\'s', 1], // a crashed upload is tried again
  ['DS-542', 'and pushes it before a pass that spawns;', 1], // a base behind syncs on every pass
  ['DS-542', 'Before a pass that will spawn, and only then, it merges', 1],
  ['DS-542', 'Actions run to finish, or `none`), or', 1], // base contains <branch> is a clears-when form
  ['DS-565', 'needs more agent work) and hands the rest', 1], // under autopilot-judgement yes the decider takes a recommended call
  ['DS-598', 'outside the batch and not done; in the batch but parked', 1], // a blocker triage judged is held or started on
  ['DS-589', 'and the disk on the first', 1], // the local database is a health check
  // the rule as it stands, not against an earlier behaviour
  ...[
    'deltas: where one and a skill disagree, the skill wins.', 'unset or `off`: workers check as before |',
    'and nothing else does. Never treat a triage', 'itself, as it always has.', 'runs on its lane as before.',
    'A clean check is done as today.', 'that owns nothing runs as before.', 'A parked or failed child no longer stops a slice',
    'the pre-push hook are unchanged.', 'red, as it always was.', 'reply in one line at most', 'Workers now run related tests',
    'the D6 baseline', 'a worker parks as before.', 'an alias such as `haiku`', 'start at Stage 0 as before.',
    'A worker quiet for 6+ passes: park it, do not wait',
  ].map((s) => ['DS-458', s, 1]),
];
checkSplit({ t, label: 'AC4', before, files, read, headings: 46, minRows: 100, rewritten: REWRITTEN });
const deep = before.split('\n').filter((l) => /^#### /.test(l));
for (const h of deep) t(`AC4 "${h}" is in exactly one file`, files.filter((f) => lines(f).includes(h)).length, 1);

// The core's reference table: when to read, the sections in *italics*, and the one file.
const table = [...core.matchAll(/^\| ([^|]+) \| ([^|]+) \| `references\/([\w.-]+\.md)` \|$/gm)]
  .map((m) => ({ when: m[1], sections: [...m[2].matchAll(/\*([^*]+)\*/g)].map((x) => x[1]), file: m[3] }));
t(`AC4 the core's reference table is read (${table.length} rows)`, table.length >= 15, true);
for (const { file } of table) t(`AC4 the table's ${file} exists and is not empty`, existsSync(join(refs, file)) && read(file).trim().length > 0, true);
t('AC4 no file is named by two rows', table.map((r) => r.file).filter((f, i, a) => a.indexOf(f) !== i), []);
t('AC4 the core says to read the file a row names when its condition holds', norm(core).includes('**When you reach a row\'s point, and its condition holds, read the file the table names for it**'), true);
t('AC4 a reference file that cannot be read stops the batch', norm(core).includes('**A reference file you cannot read stops the batch.**'), true);
t('AC4 and is named rather than worked from memory', norm(core).includes('stop and name it by its full path; never run that part of the batch from memory'), true);

// The old file's headings outside code fences: the ticket file template's and the command block's
// comment lines are lines of an example, not sections.
const fenced = (text) => { let inside = false; return text.split('\n').filter((l) => { if (/^```/.test(l)) { inside = !inside; return false; } return !inside; }); };
const oldHeadings = fenced(before).filter((l) => /^#{1,4} /.test(l));
const paras = paragraphs(before);
const moved = refFiles.filter((f) => oldHeadings.some((h) => lines(f).includes(h)) || paras.some((p) => p.length > 80 && norm(read(f)).includes(p)));
t(`AC4 the reference files with moved text are found (${moved.length})`, moved.length >= 15, true);
t('AC4 every file with moved text is named by the table', moved.filter((f) => !table.some((r) => r.file === f)), []);
for (const f of moved) {
  t(`AC4 ${f} opens saying when it is read`, /^# [^\n]+\n\nPart of desk-autopilot, read /.test(read(f)), true);
  const row = table.find((r) => r.file === f);
  for (const h of oldHeadings.filter((x) => lines(f).includes(x))) {
    const name = h.replace(/^#+ /, '');
    t(`AC4 the table names "${name.slice(0, 50)}" beside ${f}`, Boolean(row?.sections.some((s) => name.startsWith(s))), true);
  }
}

// AC2: a batch with no epic never needs the feature-mode file. The core sends you there only for an
// epic's batch, and the only other file naming it is the epic file, itself read only for an epic.
const fm = table.find((r) => r.file === 'feature-mode.md');
t('AC2 the core names feature-mode.md', Boolean(fm), true);
t('AC2 its row is for an epic only, once plan-batch turns feature mode on', Boolean(fm && /only for an epic/.test(fm.when) && fm.when.includes('FEATURE MODE — on')), true);
t('AC2 the core says a batch with no epic never needs it', norm(core).includes('**A batch with no epic never needs `references/feature-mode.md`**'), true);
const naming = files.filter((f) => f !== 'feature-mode.md' && read(f).includes('feature-mode.md'));
t('AC2 only the core and the epic file name it', naming, ['SKILL.md', 'epic-batch.md']);
const ep = table.find((r) => r.file === 'epic-batch.md');
t('AC2 and the epic file is read only when an argument is an epic', Boolean(ep && /only when an argument is an epic/.test(ep.when)), true);
t('AC2 the feature-mode heading is in feature-mode.md', lines('feature-mode.md').includes('### Feature mode'), true);

// AC3: on WSL, the core names the reference to read at the memory watch.
const wsl = table.find((r) => r.file === 'wsl-memory.md');
t('AC3 the core names wsl-memory.md', Boolean(wsl), true);
t('AC3 its row is the memory watch, where config §2 "Running on WSL?" is yes', Boolean(wsl && wsl.when.includes('memory watch') && wsl.when.includes('"Running on WSL?" is `yes`')), true);
t('AC3 and the WSL section is in it', lines('wsl-memory.md').includes('### On WSL (config §2 "Running on WSL?" = yes)'), true);

// AC4: a section cited in *italics* still finds it: an old heading in exactly one file, which is
// the core or one the table names beside that section.
const names = oldHeadings.map((h) => h.replace(/^#+ /, ''));
const home = (name) => files.filter((f) => lines(f).some((l) => /^#+ /.test(l) && l.replace(/^#+ /, '').startsWith(name)) || read(f).includes(`**${name}`));
t('AC4 a section name no file holds is found nowhere', home('No such section'), []);
const reachable = (name, f) => f === 'SKILL.md' || Boolean(table.find((r) => r.file === f)?.sections.some((s) => name.startsWith(s) || s.startsWith(name)));
const resolves = (label, name) => {
  const found = home(name);
  t(`AC4 ${label} cites *${name}*: found in exactly one desk-autopilot file`, found.length, 1);
  if (found.length === 1) t(`AC4 and the core leads to it in ${found[0]}`, reachable(name, found[0]), true);
};
let inner = 0;
for (const f of files) {
  // Italics only: a **bold** lead is not a citation.
  for (const m of norm(read(f)).matchAll(/(?<!\*)\*([A-Z][^*]{2,70})\*(?!\*)/g)) {
    if (!names.some((n) => n.startsWith(m[1]))) continue;
    inner++; resolves(f, m[1]);
  }
}
t(`AC4 desk-autopilot's own italic citations of its sections were read (${inner})`, inner >= 25, true);
const sources = [...['skills', 'agents', 'docs', 'desk/bin', 'hooks'].flatMap((d) => (existsSync(join(root, d)) ? walk(join(root, d), ['.md', '.mjs', '.sh', '.py']) : [])), join(root, 'README.md')]
  .filter((p) => existsSync(p) && !p.startsWith(skill + '/'));
let outer = 0;
for (const p of sources) {
  for (const m of norm(readFileSync(p, 'utf8')).matchAll(/desk-autopilot`?(?:'s)? \*([A-Z][^*]{2,70})\*/g)) { outer++; resolves(relative(root, p), m[1]); }
}
t(`AC4 other skills' citations of desk-autopilot sections were read (${outer})`, outer >= 2, true);
// A reference file a desk-autopilot file names by path exists.
let byPath = 0;
for (const f of files) for (const m of norm(read(f)).matchAll(/(?<![\w-]`?'s )`references\/([\w.-]+\.md)`/g)) { byPath++; t(`AC4 ${f} names references/${m[1]}: it exists`, existsSync(join(refs, m[1])), true); }
t(`AC4 the citations by path were read (${byPath})`, byPath >= 25, true);

// DS-596: a worker's call may pick a reading of a criterion but never leave one unmet.
const contract = norm(read('autopilot-worker-contract.md'));
const section1 = contract.split('## 1. ')[1]?.split(' ## 2. ')[0] ?? '';
t('DS-596 the rule is in the contract\'s section 1', section1.includes('**A call never leaves an acceptance criterion unmet.**'), true);
t('DS-596 AC2 a call picks a reading, and builds the option that meets the criterion as worded', section1.includes('It may pick a reading of one, or keep a later-merged ticket\'s behaviour as review directs; where one option meets it as worded, build and log that one.'), true);
t('DS-596 AC1 every option breaking a criterion parks before the PR, quoting it', section1.includes('Where every option breaks one, park before the PR, quoting it.'), true);

// A worker in a repo with no committed pre-push script runs the row's items itself; the script stays first.
const stage4 = norm(read('worker-contract-stage-4.md'));
t('DS-611 AC3 the pre-push script is still the first choice', stage4.includes('"Before every push": `bash scripts/desk/pre-push.sh --head`, or if absent'), true);
t('DS-611 AC1 with no script, each item desk-env cmds pre-push-checks prints runs under its lock before the push', stage4.includes('or if absent each `desk-env cmds pre-push-checks` item, locked, all passed.'), true);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
