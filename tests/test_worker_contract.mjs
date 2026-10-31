// suite: worker contract (a short core, and each stage's rules in its own file)
// covers: skills/desk-autopilot/references/**
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

// A lane D ticket admitted with its canvas saved builds without stopping, and only one with no saved
// canvas is a demotion that parks.
const stage3 = read('worker-contract-stage-3.md');
t('lane D: the Stage 3 section builds from the saved canvas and does not stop for agreement',
  stage3.includes('**A lane D ticket builds from its saved canvas, and does not stop for agreement.**') && stage3.includes('as a repo\nwith no design-build agent does'), true);
t('lane D: the PR holds each board beside the build, with every difference accepted', /board's render and the built screen\nat that board's width, with every difference you accepted/.test(stage3), true);
t('lane D: the core parks only a demotion to D with no saved canvas', core.includes('**A lane demotion to C, or to D with no saved canvas.**'), true);
const routing = readFileSync(join(root, 'skills/desk-ticket/references/desk-ticket-routing.md'), 'utf8');
t('lane D: the routing exempts an autopilot worker from stopping for agreement', routing.includes('**An autopilot worker does not stop**'), true);

// DS-328: a worker resolves its own rebase conflict, and parks only on one a product or design call settles.
const stage5 = read('worker-contract-stage-5.md');
const n5 = stage5.replace(/\s+/g, ' ');
t('DS-328 no file parks on any conflict unconditionally', files.some((f) => /Any conflict → park|Any\. Never resolve one/.test(read(f))), false);
t('DS-328 AC1 the Stage 5 section makes a conflict the worker\'s to resolve, keeping both sides', n5.includes('**A conflict is yours to resolve, not a park.** Resolve each conflicted file keeping both sides\' intent'), true);
t('DS-328 AC1 typecheck and specs re-run after the rebase', n5.includes('**Re-run typecheck and your specs**, under the lock'), true);
t('DS-328 AC2 a hand-written resolution gets a fresh desk-review before the push', n5.includes('**A fresh `desk-review` at the new head, before you push**'), true);
t('DS-328 AC3 it parks only when both sides cannot stand, naming the files and the decision', n5.includes('**Park only when the two sides cannot both stand**') && n5.includes('Park naming the files and the decision needed'), true);
t('DS-328 AC3 the core keeps only that park', core.includes('- **A merge conflict only a product or design call settles** (Stage 5 file, §4).'), true);
t('DS-328 AC4 without git-force-with-lease a pushed branch merges the default branch in', n5.includes('with `git-force-with-lease` not `yes` takes `git merge origin/<default>` instead: no rebase, no force push.'), true);

// Every stage file holding command forms is read early at any stage, so a worker resumed past it still
// reads the forms it may run. test_batch_e2e.sh checks the resumed worker's prompt names it.
const early = core.split(/read early when:\s*\n/)[1].split('\n\n')[0].split(/\n(?=- )/).map((b) => b.replace(/\s+/g, ' '));
const formFiles = stages.filter((f) => /^## \d+\. Command forms/m.test(read(f)));
t('DS-338 some stage file holds the command forms', formFiles.length > 0, true);
for (const f of formFiles) {
  const name = `the Stage ${f.match(/stage-(\w+)\.md$/)[1]} file`;
  const to = early.filter((b) => b.includes(`read ${name} first`));
  t(`DS-338 AC3 the core routes to ${f} early`, to.length > 0, true);
  t(`DS-338 AC3 ${f} is read early at any stage, not only before it`, to.some((b) => b.includes('at any stage') && !/before Stage/.test(b)), true);
}
t('DS-338 AC1 the command forms hold the dev server\'s allowed form', formFiles.some((f) => /`nolock` for everything else \(lint, build, codegen, dev server\)/.test(read(f).replace(/\s+/g, ' ')) && read(f).includes('pass the port as an argument')), true);
t('DS-338 AC1 the core\'s table says the Stage 3 file holds the dev server\'s form', core.includes('§6 the command forms you may run, a dev server\'s too'), true);

// DS-335: a round-3 P0 or P1 goes to a fix try where autopilot-judgement is yes, and parks otherwise.
const stage4 = read('worker-contract-stage-4.md').replace(/\s+/g, ' ');
t('DS-335 AC3 a round-3 P0 or P1 still parks by default', stage4.includes('**Round 3, a P0 or P1**: park, naming each finding and its `file:line`. No fourth round.'), true);
t('DS-335 AC1 under autopilot-judgement yes it opens the draft and posts the review for a fix try instead',
  stage4.includes('**Where config §3 `autopilot-judgement` is `yes`, do not park: it goes to a fix try.**') && stage4.includes('`AUTOPILOT_DONE: pr=<n> jira=<status> review=round 3 left <counts> for a fix try`'), true);
t('DS-368 AC1 from round 2 a round reads only the fix range since the previous round',
  stage4.includes('from round 2 a round reads **only the fix range**, the commits since the previous round\'s reviewed SHA') && stage4.includes('from round 2, the previous round\'s reviewed SHA'), true);
t('DS-368 AC1 only round 1 fixes a P2', stage4.includes('- **P0, P1 or P2 on round 1**: fix it'), true);
t('DS-368 AC2 round 2 carries its P2s as round 3 does', stage4.includes('- **Round 2 or 3, only P2s**: **carry them, do not park.**') && stage4.includes('it exists only from round 2, only for a P2'), true);
t('DS-368 AC3 a round-2 P0 or P1 is fixed and round 3 runs on the fix range', stage4.includes('- **Round 2, a P0 or P1**: fix it, then run round 3 on the fix range since round 2\'s reviewed SHA.'), true);
t('DS-335 AC1 and parks when no review is posted for the pass to read', stage4.includes('Where §3 `pr-self-review-comment` is not `yes` there is no posted review for the pass to read, so it parks as above.'), true);

// A CI or end-to-end run a worker asks for is the narrowest that covers its change, with its reason.
t('DS-356 AC1 a requested run names its tag, spec or project and why it covers the change',
  stage4.includes('**A CI or end-to-end run you ask for is the narrowest one that covers your change.** Whether you park asking for a run or run one of the §4 Worker workflows commands your settings allow, the request names the tag, spec or project to run') && stage4.includes('gives one line on why that covers the change'), true);
t('DS-356 AC2 a request for every test says why nothing narrower covers it',
  stage4.includes('**Every test is the exception.** A request for everything (`all`, or no filter) states why nothing narrower covers the change'), true);
t('DS-356 AC3 a tag the workflow does not offer is named in the park, not widened to everything',
  stage4.includes('**A tag the workflow does not offer is said, not widened.**') && stage4.includes('never fall back to everything: say in the park that the workflow does not offer it, name the tag that would cover the change'), true);
t('DS-356 AC1 a started run chooses among the listed entries, and its why goes in the park on its run id',
  stage4.includes('narrowest means choosing among the §4 Worker workflows entries as listed, and the line on why goes in the park on its run id'), true);
t('DS-356 AC1 the Stage 5 file sends a Stage 7 session asking for a run to the Stage 4 rule',
  stage5.replace(/\s+/g, ' ').includes('a session that started at Stage 7 has not read it, so read it before you write that park.'), true);
t('DS-356 AC1 the Stage 3 workflow-dispatch rule points at the Stage 4 rule',
  stage3.replace(/\s+/g, ' ').includes('follow the Stage 4 file\'s "A CI or end-to-end run you ask for is the narrowest one that covers your change": read it first.'), true);

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
// The fixture stays frozen, so a paragraph a later ticket rewrote is named here, by text only it holds.
const REWRITTEN = [
  ['DS-368', 'P0, P1 or P2 on rounds 1 and 2', 1], // round 2 reads the fix range and carries P2s
  ['DS-368', 'round 3 reads **only the fix range**', 1],
  ['DS-368', '**Round 3, only P2s**', 1],
  ['DS-368', 'it exists only from round 3', 1],
];
for (const [key, s, n] of REWRITTEN) t(`AC4 ${key} rewrote ${n} paragraph of the old contract: ${s}`, paras.filter((p) => p.includes(s)).length, n);
const dropped = paras.filter((p) => !after.includes(p) && !REWRITTEN.some(([, s]) => p.includes(s)));
t(`AC4 every paragraph of the old contract survives the split (${paras.length} read)`, dropped.length, 0);
for (const p of dropped) console.log(`     dropped: ${p.slice(0, 120)}`);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
