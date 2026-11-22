// suite: config row references (review-asks reads §4's house bar; worker skills name §3b/§4 rows with their desk-env call; no skill but setup and update reads the config whole)
// covers: desk/bin/desk-env.mjs desk-config.md skills/**/*.md
// `desk-env get review-asks` prints §4 "What review here consistently asks for", one ask per line,
// and exits 3 while it is TODO or still says "Not mined". Every file a worker reads names each §3b
// and §4 row it mentions with the `desk-env get|list|cmds <id>` call that reads it, at or before the
// paragraph of its first mention, because a worker cannot read config.md and guesses ids from labels.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_ROWS } from '../desk/bin/desk-env.mjs';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'desk', 'bin', 'desk-env.mjs');
const T = scratch('desk-rowrefs-');

// ---- AC1 / AC3: desk-env get review-asks ----------------------------------------------------
const ASKS_HEAD = '## 4. Tracker, tools and team\n\n| Field | Value |\n|---|---|\n| Tracker | `jira` |\n\n'
  + '### What review here consistently asks for\n\nThe house bar for this repo.\n\n| Ask | Detail |\n|---|---|\n';
const TAIL = '\n## 5. Conventions\n\n| Field | Value |\n|---|---|\n| PR body | `intro` |\n';
const get = (body, sub = 'get') => {
  const cfg = join(T, `c${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(cfg, ASKS_HEAD + body + TAIL);
  try {
    const out = execFileSync('node', [BIN, sub, 'review-asks'], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, DESK_CONFIG: cfg, DESK_MACHINE: join(T, 'none.md'), HOME: T } });
    return out.trim().split('\n').join(' | ');
  } catch (e) { return `exit ${e.status}${String(e.stderr).trim() ? `: ${String(e.stderr).trim()}` : ''}`; }
};
t('AC1: each ask, with its detail', get('| Server actions validate input | with zod, at the boundary |\n| `None` of `any` | ban it in new code |\n'),
  'Server actions validate input: with zod, at the boundary | `None` of `any`: ban it in new code');
t('AC1: list prints the same lines', get('| One | first |\n| Two | — |\n', 'list'), 'One: first | Two');
t('AC1: the asks do not shadow a §4 row of the same name', (() => {
  const cfg = join(T, 'shadow.md');
  writeFileSync(cfg, ASKS_HEAD + '| Tracker | always link it |\n' + TAIL);
  return execFileSync('node', [BIN, 'get', 'tracker'], { encoding: 'utf8', env: { ...process.env, DESK_CONFIG: cfg, DESK_MACHINE: join(T, 'none.md'), HOME: T } }).trim();
})(), 'jira');
t('AC3: the template TODO is unset', get('| `TODO` | `TODO` |\n'), 'exit 3');
t('AC3: "Not mined" in the ask is unset', get('| Not mined: review history not read at setup | |\n'), 'exit 3');
t('AC3: "Not mined" in backticks or the detail is unset', get('| `Not mined` | `review history not read at setup` |\n| `TODO` | Not mined |\n'), 'exit 3');
t('AC3: a paragraph in place of the table is unset', get('').replace(/\s+/g, ' '), 'exit 3');
t('AC3: a real ask beside a placeholder row prints only the ask', get('| `TODO` | `TODO` |\n| Keep diffs small | |\n'), 'Keep diffs small');

// ---- AC2: worker-read files name §3b and §4 rows with their id ------------------------------
// The files a worker loads: the skills desk-ticket routes it through (desk-dev at Stage 4, desk-jira
// at Stage 8), the one desk-review's simplicity finder reads (desk-kiss), and the worker contract.
const WORKER_FILES = ['skills/desk-ticket', 'skills/desk-review', 'skills/desk-pr', 'skills/desk-review-response',
  'skills/desk-dev', 'skills/desk-jira', 'skills/desk-kiss']
  .flatMap((d) => walk(join(ROOT, d)))
  .concat(readdirSync(join(ROOT, 'skills/desk-autopilot/references'))
    .filter((f) => /^(autopilot-)?worker-contract.*\.md$/.test(f)).map((f) => join(ROOT, 'skills/desk-autopilot/references', f)));
function walk(d) {
  return readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : []; });
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Longest label first, so `§4 Staging bypass token location` is that row and not `Staging`.
const ROWS = Object.entries(CONFIG_ROWS).filter(([, r]) => r.section === '4' || r.section === '3b')
  .sort((a, b) => b[1].row.length - a[1].row.length);
// The ids of rows a text names as `§<n> <label>` (quotes and bold allowed) with no
// `desk-env get|list|cmds <id>` at or before the paragraph of the first mention.
// Rows a dedicated desk-env command reads, which names them as well as `get` does.
const READ_BY = { 'worker-models': 'desk-env\\s+model\\b', 'local-review': 'desk-env\\s+review-cmd\\b' };
// A skill's frontmatter description says what the skill is, not what to read, so it is left out.
function bareRows(text) {
  const paras = text.replace(/^---\n[\s\S]*?\n---\n/, '').split(/\n\s*\n/);
  const first = new Map();
  paras.forEach((p, i) => {
    for (const m of p.matchAll(/§(3b|4)\s+["*]{0,2}/g)) {
      const rest = p.slice(m.index + m[0].length);
      const hit = ROWS.find(([, r]) => r.section === m[1] && new RegExp(`^${esc(r.row).replace(/ /g, '\\s+')}(?![\\w-])`).test(rest));
      if (hit && !first.has(hit[0])) first.set(hit[0], i);
    }
  });
  return [...first].filter(([id, i]) => !new RegExp(READ_BY[id] ?? `desk-env\\s+(get|list|cmds)\\s+${esc(id)}(?![\\w-])`).test(paras.slice(0, i + 1).join('\n\n'))).map(([id]) => id);
}
t('AC2 can fail: a label with no id', bareRows('Run §4 Typecheck first.').join(','), 'typecheck-cmd');
t('AC2 can fail: the longest label wins', bareRows('See §4 "Staging bypass token location".').join(','), 'staging-bypass');
t('AC2 passes: the id beside the label', bareRows('Run §4 Typecheck (`desk-env cmds typecheck-cmd`).\n\nThen §4 Typecheck again.').join(','), '');
t('AC2 passes: review-asks by its heading', bareRows('§4 What review here consistently asks for (`desk-env get review-asks`)').join(','), '');
t('AC2 can fail: a later mention does not cover the first', bareRows('§3b Test worker cap under the test lock.\n\n`desk-env get test-cap`').join(','), 'test-cap');
let bare = 0;
for (const f of WORKER_FILES) {
  const ids = bareRows(readFileSync(f, 'utf8'));
  bare += ids.length;
  if (ids.length) t(`AC2: ${relative(ROOT, f)} names every row with its id`, ids.join(' '), '');
}
t(`AC2: ${WORKER_FILES.length} worker files checked, rows named without an id`, bare, 0);

// ---- DS-875: skills read the config by section or row, never the file whole -------------------
// Only desk-setup and desk-update, which write the file, open it whole. A whole read is a Read of
// the `CONFIG` file, a `cat` of it, a Read of what `desk-env where` resolved, a brief handing on the
// file's path, or `desk-env show` with no section named (every section). §3c is not a section here:
// show refuses it.
const WRITERS = new Set(['desk-setup', 'desk-update']);
const NOT = String.raw`(?<!(?:not|never|cannot) )`;
const WHOLE = [
  new RegExp(String.raw`${NOT}\bread (?:the |this repo's )?(?:repo )?(?:\`CONFIG\`|config) file\b`, 'i'),
  new RegExp(String.raw`${NOT}\bread (?:the |this repo's )?(?:repo )?(?:\`CONFIG\`|config)(?=[.,;)*]|$| at\b)`, 'im'),
  /\bdesk-env where`?,?\s+then\s+read it\b(?!\s+with\b)/i,
  /<CONFIG path>/,
  /\bcat\s+"?\$\{?CONFIG\b/,
  /\bdesk-env show(?![ \t]+(?:§?\d[ab]?|rules)\b)/,
];
const SECTION_READ = /\bdesk-env show(?:[ \t]+(?:§?\d[ab]?|rules)\b)+|\bdesk-env get --json(?: --where)? --section\b/;
const wholeReads = (text) => text.replace(/^---\n[\s\S]*?\n---\n/, '').split(/\n\s*\n/)
  .filter((p) => WHOLE.some((re) => re.test(p))).map((p) => p.trim().split('\n')[0].slice(0, 80));
t('DS-875 can fail: Read the CONFIG file', wholeReads('Read the `CONFIG` file. `EXISTS=no` means stop.').length, 1);
t('DS-875 can fail: Read the config, in a parenthesis', wholeReads('(resolve it with `desk-env where`, then Read the config)').length, 1);
t('DS-875 can fail: desk-env show with no section', wholeReads('Read `desk-env show` (rules and rows, no §3c).').length, 1);
t('DS-875 can fail: desk-env where, then Read it', wholeReads('§-references are to this config (`desk-env where`, then Read it).').length, 1);
t('DS-875 can fail: a brief reading the repo config at its path', wholeReads('> Read the repo config at `<CONFIG path>`: §4 and §5.').length, 1);
t('DS-875 can fail: a brief handed the path', wholeReads('> The repo config is at\n> `<CONFIG path>`.').length, 1);
t('DS-875 can fail: §3c is no section', wholeReads('Read `desk-env show 3c`.').length, 1);
t('DS-875 passes: desk-env where, then read it by section', wholeReads('(resolve it with `desk-env where`, then read it with `desk-env show 5`)').length, 0);
t('DS-875 a §3c read is not a section read', SECTION_READ.test('Read `desk-env show 3c`.'), false);
t('DS-875 passes: a section read',wholeReads('Read `desk-env show rules 0 3 5` (never the `CONFIG` file whole).').length, 0);
t('DS-875 passes: a row of a section', wholeReads('**Read the config §4 People table** for who reviews.').length, 0);
t('DS-875 passes: saying a worker cannot read it', wholeReads('Read rows with `desk-env` (a worker cannot read `CONFIG`).').length, 0);
t('DS-875 passes: a §3b section first', wholeReads('Read `desk-env show 3b 4`.').length, 0);
const SKILLS = join(ROOT, 'skills');
const skillDirs = readdirSync(SKILLS).filter((d) => statSync(join(SKILLS, d)).isDirectory());
let whole = 0;
for (const d of skillDirs.filter((x) => !WRITERS.has(x))) {
  for (const f of walk(join(SKILLS, d))) {
    const hits = wholeReads(readFileSync(f, 'utf8'));
    whole += hits.length;
    if (hits.length) t(`DS-875 AC3: ${relative(ROOT, f)} reads the config whole`, hits.join(' | '), '');
  }
}
t(`DS-875 AC3: ${skillDirs.length - WRITERS.size} skills checked, whole-file config reads`, whole, 0);
// AC1, AC2, AC6: the two entry points name a section read, and still stop on EXISTS=no.
for (const s of ['desk-ticket', 'desk-autopilot']) {
  const core = readFileSync(join(SKILLS, s, 'SKILL.md'), 'utf8');
  t(`DS-875 ${s === 'desk-ticket' ? 'AC1' : 'AC2'}: ${s} reads the config by section`, SECTION_READ.test(core), true);
  t(`DS-875 AC6: ${s} still stops and offers /desk-setup on EXISTS=no`, /`EXISTS=no` means stop[^]{0,120}\/desk-setup/.test(core), true);
}

// ---- desk-setup asks every §3b row of the template -------------------------------------------
// The §3b step reads its rows from the template, or, if it lists them by hand, names every one by
// its label, so a row added to the template is never left to fall back to its Recommended value.
const TEMPLATE = readFileSync(join(ROOT, 'desk-config.md'), 'utf8');
const rows3b = (TEMPLATE.split(/^## 3b\. /m)[1] ?? '').split(/^## /m)[0]
  .split('\n').filter((l) => /^\| [^-|]/.test(l)).map((l) => l.split('|')[1].trim()).filter((r) => r !== 'Field');
t(`3b: the template's §3b rows are read (${rows3b.length})`, rows3b.length >= 25, true);
const stepOf = (text) => text.split(/\n\s*\n/).find((p) => p.startsWith('**Then §3b**')) ?? '';
const unasked = (step) => {
  if (/desk-config\.template\.md/.test(step) && /every row/.test(step)) return [];
  const flat = step.replace(/\s+/g, ' ').toLowerCase();
  return rows3b.filter((r) => !flat.includes(r.toLowerCase()));
};
const OLD_STEP = '**Then §3b** (five rounds): subagents without asking, autopilot worker concurrency, memory ceiling,\nspawn gate; batches run by.';
t('3b can fail: a hand list that misses a row', unasked(OLD_STEP).includes('Usage pacing headroom (points)'), true);
t('3b passes: a hand list naming every row', unasked(`**Then §3b**: ${rows3b.join(', ')}.`).length, 0);
const SETUP_STEP = stepOf(readFileSync(join(ROOT, 'skills/desk-setup/SKILL.md'), 'utf8'));
t('3b: desk-setup has a §3b step', SETUP_STEP.length > 0, true);
t('3b: desk-setup asks every row of the template\'s §3b table', unasked(SETUP_STEP).join(' | '), '');

console.log(fails ? `${fails} FAIL` : 'all checks passed');
process.exit(fails ? 1 : 0);
