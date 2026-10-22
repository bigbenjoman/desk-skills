// suite: worker contract (a short core, and each stage's rules in its own file)
// tests/fixtures/worker-contract-before-split.md is the whole contract as one file. Every heading and
// every paragraph of it must still be in the core or a stage section, so an edit that drops a rule
// from the split files fails here.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const refs = join(root, 'skills/desk-autopilot/references');
const read = (f) => readFileSync(join(refs, f), 'utf8');
const CORE = 'autopilot-worker-contract.md';
const core = read(CORE);

// The stage sections on disk: spawn-worker.sh gives a task worker every worker-contract-stage-*.md.
const stages = readdirSync(refs).filter((f) => /^worker-contract-stage-.*\.md$/.test(f)).sort();
const sections = [...stages, 'worker-contract-task.md'];
const files = [CORE, ...sections];

// AC3: the core is at most 14KB.
const size = Buffer.byteLength(core);
t(`AC3 the core is at most 14KB (${size} bytes)`, size <= 14000, true);

// AC1: the core holds none of the stage sections.
for (const h of ['## 0. ', '## 3. ', '## 4. ', '## 5. ', '## 6. ', '### Self-review', '### Jira comments', '## Review-sweep', '**The design skills are files too.**']) {
  t(`AC1 the core does not carry "${h}"`, core.includes(h), false);
}

// AC5: every stage section the core names exists, spawn-worker knows the same set, and a missing one parks.
const named = [...core.matchAll(/^\| [^|]+ \| `(worker-contract-[\w-]+\.md)` \|/gm)].map((m) => m[1]);
t('the core names four stage sections', named.length, 4);
t('the stage sections on disk are the ones the core names', JSON.stringify(stages), JSON.stringify([...named].sort()));
for (const f of sections) t(`${f} exists beside the core`, existsSync(join(refs, f)), true);
t('the core says where the stage sections are, for spawn-worker to fill in', core.includes('`{{STAGE_DIR}}`'), true);
t('AC5 a stage section that cannot be read is a park naming it', core.includes('`AUTOPILOT_PARK: worker contract stage section missing: <its absolute path>`'), true);
t('AC5 and never a carry-on', /never a skip/.test(core), true);

// AC2: the Stage 4 section is read before any suite runs, whatever the stage.
t('AC2 the core sends the worker to the Stage 4 section before any suite', /about to run any suite, typecheck, lint or build, at any stage[^\n]*\n[^\n]*read the Stage 4 file first/.test(core), true);
t('AC2 the Stage 4 section holds verification and self-review', read('worker-contract-stage-4.md').includes('## 3. Verification must cover what CI covers') && read('worker-contract-stage-4.md').includes('### Self-review'), true);

// AC4: each heading of the contract before the split is in exactly one of the new files.
const before = readFileSync(join(root, 'tests/fixtures/worker-contract-before-split.md'), 'utf8');
const headings = before.split('\n').filter((l) => /^#{1,3} /.test(l));
t('AC4 the old contract has its 14 headings', headings.length, 14);
for (const h of headings) {
  const homes = files.filter((f) => read(f).split('\n').includes(h));
  t(`AC4 "${h}" is in exactly one file`, homes.length, 1);
}

// AC4: and no rule is dropped. Every paragraph of the old contract is in one of the new files, word
// for word (whitespace aside): the split moves text, it does not reword it.
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const after = norm(files.map(read).join('\n\n'));
// A paragraph ends at a blank line or where a list item starts, so each bullet is checked on its own.
const paras = before.split(/\n[ \t]*\n|\n(?=[ \t]*(?:[-*]|\d+\.) )/).map(norm).filter(Boolean);
const dropped = paras.filter((p) => !after.includes(p));
t(`AC4 every paragraph of the old contract survives the split (${paras.length} read)`, dropped.length, 0);
for (const p of dropped) console.log(`     dropped: ${p.slice(0, 120)}`);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
