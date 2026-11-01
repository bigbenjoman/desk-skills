// suite: config row references (review-asks reads §4's house bar; worker skills name §3b/§4 rows with their desk-env call)
// covers: desk/bin/desk-env.mjs skills/desk-ticket/** skills/desk-review/** skills/desk-pr/** skills/desk-review-response/** skills/desk-autopilot/references/**
// `desk-env get review-asks` prints §4 "What review here consistently asks for", one ask per line,
// and exits 3 while it is TODO or still says "Not mined". Every file a worker reads names each §3b
// and §4 row it mentions with the `desk-env get|list|cmds <id>` call that reads it, at or before the
// paragraph of its first mention, because a worker cannot read config.md and guesses ids from labels.
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_ROWS } from '../desk/bin/desk-env.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'desk', 'bin', 'desk-env.mjs');
const T = mkdtempSync(join(tmpdir(), 'desk-rowrefs-'));

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
// The files a worker loads: the skills desk-ticket routes it through, and the worker contract.
const WORKER_FILES = ['skills/desk-ticket', 'skills/desk-review', 'skills/desk-pr', 'skills/desk-review-response']
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
const READ_BY = { 'worker-models': 'desk-env\\s+model\\b' };
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

console.log(fails ? `${fails} FAIL` : 'all checks passed');
process.exit(fails ? 1 : 0);
