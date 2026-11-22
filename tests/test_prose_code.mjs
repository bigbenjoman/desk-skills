// suite: prose check, every code reference a skill makes is one the code has, and every tagged JSON example passes its contract's validator, and the baseline is empty
// layer: L2
// covers: tests/prose_check.mjs tests/prose_scan.mjs tests/prose_facts.mjs desk/bin/spawn-order.mjs desk/bin/fix-tries.mjs skills/desk-review/bin/verdict.mjs tests/command_shapes.mjs tests/fixtures/prose_baseline.json tests/fixtures/prose-code/*.md desk/bin/prose-facts.mjs desk/bin/queue-commands.mjs desk/bin/markers.mjs desk/bin/queue-writer.mjs desk/bin/batch-state.mjs desk/bin/with-lock.sh skills/**/*.md agents/*.md
// covers: desk/bin/desk-env.mjs desk/bin/config-schema.mjs desk/bin/machine.mjs desk/bin/test-scope.mjs desk/bin/workflow-yaml.mjs desk/bin/dir-lock.mjs desk/bin/failure-class.mjs desk/bin/queue-store.mjs desk/bin/clears-when.mjs desk/bin/harvest.mjs desk/bin/spine-check.mjs desk/bin/scope-report.mjs desk/bin/baseline.mjs desk/bin/gate.mjs desk/bin/desk-ci.mjs desk/bin/aws-fallback.mjs desk/bin/decisions.mjs desk/templates/scripts/desk/review-gate.mjs
// covers: desk/bin/base-red.mjs desk/bin/costs.mjs desk/bin/desk-lines.mjs desk/bin/leases.mjs desk/bin/logins.mjs desk/bin/quantile.mjs desk/bin/queue-fields.mjs desk/bin/queue-ledger.mjs desk/bin/queue-states.mjs desk/bin/ticket-ledger.mjs desk/bin/build-memo.mjs desk/bin/read-cache.mjs
// covers: desk/bin/asks.mjs desk/bin/base-fix.mjs desk/bin/batches.mjs desk/bin/bench-checks.mjs desk/bin/bench-quota.mjs desk/bin/bench-report.mjs desk/bin/borrow.mjs desk/bin/briefing.mjs desk/bin/call-login.mjs desk/bin/check-build.mjs desk/bin/claude-logins.mjs desk/bin/cloud-worker.mjs desk/bin/codex-login.mjs
// covers: desk/bin/codex-usage.mjs desk/bin/cost-cache.mjs desk/bin/decider.mjs desk/bin/desk-design.mjs desk/bin/desk-q-eta.mjs desk/bin/desk-q.mjs desk/bin/digest.mjs desk/bin/epic-plan.mjs desk/bin/evidence.mjs desk/bin/find-playwright.mjs desk/bin/findings.mjs desk/bin/follow-steps.mjs
// covers: desk/bin/handoff.mjs desk/bin/health.mjs desk/bin/installed.mjs desk/bin/intake.mjs desk/bin/jira-search.mjs desk/bin/ledger.mjs desk/bin/lever-changes.mjs desk/bin/lever-log.mjs desk/bin/lever-pin.mjs desk/bin/lever-registry.mjs desk/bin/lever-stats.mjs desk/bin/levers-auto.mjs
// covers: desk/bin/levers-evaluate.mjs desk/bin/levers-page.mjs desk/bin/levers-refresh.mjs desk/bin/levers-view.mjs desk/bin/live-read.mjs desk/bin/log-tool-calls.mjs desk/bin/maintenance.mjs desk/bin/merge-log.mjs desk/bin/needs-you.mjs desk/bin/not-now.mjs desk/bin/park-words.mjs desk/bin/pass-metrics.mjs desk/bin/pass/promotion-pr.mjs
// covers: desk/bin/pass/shared.mjs desk/bin/phase0-report.mjs desk/bin/post-merge.mjs desk/bin/promotion.mjs desk/bin/read-repos.mjs desk/bin/recoveries.mjs desk/bin/remote-git.mjs desk/bin/repo-templates.mjs desk/bin/review-post.mjs desk/bin/rework.mjs desk/bin/run-by.mjs desk/bin/seeded-random.mjs
// covers: desk/bin/stitch-boards.mjs desk/bin/undraft.mjs desk/bin/upload-batches.mjs desk/bin/upload-log.mjs desk/bin/upload-queue.mjs desk/bin/usage-limit.mjs desk/bin/usage-pace.mjs desk/bin/usage-probe.mjs desk/bin/worker-cost.mjs
// covers: desk/bin/preview-db.mjs desk/bin/own-pr.mjs desk/bin/migration-renames.mjs
// The covers lines name every module the check imports, directly or through another (checked below),
// so a change to any of them runs this suite.
// Each fixture under tests/fixtures/prose-code/ adds one kind of drift beside a reference the code has;
// the check must name the bad one and pass the good one. Then the real skills and agents tree, against
// the empty baseline, in-process and under two seconds.
import childProcess from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

// AC12 first: nothing below may start a process until the real tree has been checked in-process.
const SPAWNERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const real = Object.fromEntries(SPAWNERS.map((k) => [k, childProcess[k]]));
const started = [];
for (const k of SPAWNERS) childProcess[k] = (...a) => { started.push(`${k} ${a[0]}`); throw new Error(`prose check started a process: ${k}`); };
syncBuiltinESMExports();
const t0 = performance.now();
const { check, gate, readBaseline, report, optOuts, OPT_OUT, facts, verdict, staleReport, baselineEntries } = await import('./prose_check.mjs');
const { markdownFiles } = await import('./command_shapes.mjs');
const { DEFAULT_PATHS } = await import('./prose_scan.mjs');
const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const tree = check(markdownFiles(DEFAULT_PATHS.map((p) => join(R, p))));
const ms = performance.now() - t0;
Object.assign(childProcess, real);
syncBuiltinESMExports();

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const tj = (name, got, want) => t(name, JSON.stringify(got), JSON.stringify(want));
const F = join(R, 'tests/fixtures/prose-code');
const found = (f) => check([join(F, f)]);
const lines = (f) => found(f).map((x) => `${x.line} ${x.kind} ${x.value}`).join(', ');
const cli = (...args) => childProcess.spawnSync(process.execPath, [join(R, 'tests/prose_check.mjs'), ...args], { cwd: R, encoding: 'utf8' });

// ---- AC12: the whole tree, in-process ------------------------------------------------------------
t('AC12 / DS-890 AC2 the full skills and agents tree, with every kind of check, is checked in under two seconds', ms < 2000 ? 'under 2s' : `${Math.round(ms)}ms`, 'under 2s');
t('AC12 / DS-890 AC2 without starting another process', started.join(', '), '');

// ---- AC1: a queue subcommand the code does not have -----------------------------------------------
t('AC1 the unknown subcommand, and not the known one', lines('queue-sub.md'), '4 subcommand frobnicate');
t('AC1 the report names the file, the line, the subcommand and the queue command',
  report(found('queue-sub.md')[0]).startsWith('tests/fixtures/prose-code/queue-sub.md:4: the queue command has no subcommand frobnicate'), true);
const sub = cli(join(F, 'queue-sub.md'));
t('AC1 the CLI exits 1 and prints it', [sub.status, sub.stdout.includes('queue-sub.md:4: the queue command has no subcommand frobnicate')].join(' '), '1 true');

// ---- AC2: a script outside desk/bin and the skills' bins ------------------------------------------
t('AC2 a missing bin script and a repo script are named; desk/bin and a skill bin, installed or not, pass',
  lines('script.md').split(', ').slice(0, 2).join(', '), '4 script ~/.claude/desk/bin/no-such-script.mjs, 9 script scripts/make-thing.sh');
t('DS-890 install.sh, an installed hook, a template, a skill script, an elided path and a file in this repo pass; an absolute path is not read as one in this repo',
  found('script.md').filter((x) => x.line > 9).map((x) => `${x.line} ${x.value}`).join(', '), '13 /tests/run.sh');
t('AC2 the report names the file, the line and the script', report(found('script.md')[0]).startsWith(
  'tests/fixtures/prose-code/script.md:4: the script ~/.claude/desk/bin/no-such-script.mjs is not under desk/bin or a skill\'s bin folder'), true);

// ---- AC3: a flag the queue park command does not read ---------------------------------------------
t('AC3 the unread flag, and not --claimed-by or the --batch every desk script reads', lines('park-flag.md'), '4 flag --snooze');
t('AC3 the report names the command and the flag', found('park-flag.md')[0].message, 'queue.mjs park does not read the flag --snooze');

// ---- AC4: a § row config does not declare ---------------------------------------------------------
t('AC4 an undeclared id, kebab key and row name; a declared id, permission key and row name pass',
  lines('row.md'), '3 row no-such-row, 5 row §3 pr-teleport, 5 row §4 Coffee machine');
t('AC4 the report names the file, the line and the row id',
  report(found('row.md')[0]).startsWith('tests/fixtures/prose-code/row.md:3: config declares no row no-such-row'), true);

// ---- AC5: the § lint command under another lock class ---------------------------------------------
t('AC5 lint under test, and a class with-lock.sh lacks; lint under tsc passes', lines('lock.md'), '4 lock test, 6 lock heavy');
t('AC5 the report names both lock classes', found('lock.md')[0].message, 'the lint-cmd command runs under the lock class tsc, not test');
t('a lock class with-lock.sh does not have is named', found('lock.md')[1].message, 'with-lock.sh has no lock class heavy');

// ---- AC6: an AUTOPILOT name the code does not use -------------------------------------------------
t('AC6 the unknown name; a marker and a variable pass', lines('autopilot.md'), '3 autopilot AUTOPILOT_FROBNICATE');
t('AC6 the report names the name', found('autopilot.md')[0].message, 'AUTOPILOT_FROBNICATE is neither a marker nor a variable the code uses');

// ---- AC7: a state the queue writer does not have --------------------------------------------------
t('AC7 the unknown state, and not parked', lines('state.md'), '4 state snoozed');
t('AC7 the report names the state', found('state.md')[0].message, 'the queue writer has no state snoozed');

// ---- AC8: a path under the state folder that is not declared --------------------------------------
t('AC8 the undeclared path; a declared one under any placeholder, and its folder, pass; DS-890 so does a name the code builds under the state folder, but not an undeclared file in a STATE_PATHS folder, nor a path under a file the code builds there',
  lines('state-path.md'), '3 state-path no-such/<TICKET>.json, 6 state-path parks/<TICKET>.txt, 7 state-path not-now.jsonl/missing.md');
t('AC8 the report names the path', found('state-path.md')[0].message, 'no-such/<TICKET>.json is not a declared state path');

// ---- DS-885: a tagged JSON example is checked by its contract's validator -------------------------
const { scan } = await import('./prose_scan.mjs');
const tagged = found('contract.md');
t('DS-885 the refused, unknown and unreadable examples are named; the ones their validators take, and an untagged one, pass',
  lines('contract.md'), '6 contract results, 24 contract park, 36 contract invoice, 41 contract park');
t('DS-885 AC1 the report names the file, the line and the validator\'s message that the refuter is claude or codex', report(tagged[0]).startsWith(
  'tests/fixtures/prose-code/contract.md:6: the results example fails its validator: finding F1: refuted_by must be the refuter\'s vendor, claude or codex, not its agent ("lena-code-reviewer")'), true);
t('DS-885 AC2 a park file field it does not declare is named', tagged[1].message, 'the park example fails its validator: its park file holds a field the park file does not declare: colour');
t('DS-885 AC3 a contract no validator has is named', tagged[2].message, 'no contract is named invoice: tag the example with one of results, park (desk/bin/prose-facts.mjs contracts)');
t('DS-885 a tagged block that is not JSON is named', tagged[3].message.startsWith('the park example is not JSON: '), true);
t('DS-885 a refused example is never held by the baseline', gate(tagged, baselineEntries(tagged)).fresh.length + baselineEntries(tagged).length, 4);
const REVIEW_SKILL = 'skills/desk-review/SKILL.md', WORKER = 'skills/desk-autopilot/references/autopilot-worker-contract.md';
tj('DS-885 AC4 the desk-review results example and the worker contract\'s park file example are tagged with their contracts',
  [REVIEW_SKILL, WORKER].map((p) => scan(readFileSync(join(R, p), 'utf8')).filter((x) => x.kind === 'contract').map((x) => `${p} ${x.value}`)).flat(),
  [`${REVIEW_SKILL} results`, `${WORKER} park`]);
tj('DS-885 AC4 and both pass their validators', check([join(R, REVIEW_SKILL), join(R, WORKER)]).filter((x) => x.kind === 'contract').map(report), []);
tj('DS-885 AC4 the baseline holds nothing for a tagged example', readBaseline().filter((e) => e.kind === 'contract'), []);

// ---- AC10 / AC11: the opt-out ---------------------------------------------------------------------
t('AC10 an opt-out with no reason is named, in prose and in shell, and opts nothing out; AC11 one with a reason opts its line out',
  lines('opt-out.md'), `3 opt-out ${OPT_OUT}, 3 subcommand frobnicate, 5 subcommand vanish, 8 opt-out ${OPT_OUT}, 8 subcommand evaporate, 12 subcommand melt`);
t('AC10 the report names the line', found('opt-out.md')[0].message, 'the opt-out on line 3 gives no reason');
t('AC11 the reasoned lines are the ones opted out', [...optOuts('a `x` <!-- prose-ok: why -->\n\n```bash\nnode q.mjs   # prose-ok: why\n```\n').optedOut].sort().join(' '), '1 4');

// ---- DS-886: generated regions --------------------------------------------------------------------
const { regions, regenerate, REGIONS, WRITE } = await import('./prose_facts.mjs');
const { VENDORS } = await import('../skills/desk-review/bin/verdict.mjs');
const { SPAWN_ORDER_RULE, KEEP_ORDER_RULE } = await import('../desk/bin/spawn-order.mjs');
const regionIn = (text, name) => { const r = regions(text).found.find((x) => x.name === name); return r && text.slice(r.from, r.to).trim(); };
const review = readFileSync(join(R, 'skills/desk-review/SKILL.md'), 'utf8');
const vendorsText = regionIn(review, 'refuted-by') ?? '';
t('DS-886 AC1 the results file\'s refuted_by is a generated region naming every vendor verdict.mjs accepts',
  [VENDORS.join(' '), VENDORS.every((v) => vendorsText.includes(`\`${v}\``)), vendorsText.includes('absent when `UNREFUTED`')].join(' '), 'claude codex true true');
const holds = readFileSync(join(R, 'skills/desk-autopilot/references/order-and-holds.md'), 'utf8');
t('DS-886 AC3 the order-and-holds ordering rule is a region equal to plan-batch\'s sentences', regionIn(holds, 'spawn-order'), `${SPAWN_ORDER_RULE}\n${KEEP_ORDER_RULE}`);
const outside = regions(holds).found.reduceRight((s, r) => s.slice(0, r.from) + s.slice(r.to), holds);
t('DS-886 AC3 and holds no other ordering rule', ['blockers first', 'gate the most', 'fewest planned', 'keep-order'].filter((p) => outside.includes(p)).join(', '), '');
t('DS-886 regions that are what the code says pass, and a marker in a fenced block is no region', lines('regions.md'), '');
const gemini = { 'refuted-by': { vendors: [...VENDORS, 'gemini'] } };
const stale = check([join(F, 'regions.md')], { values: gemini });
t('DS-886 AC4 a vendor added to the verdict code fails the unregenerated region, naming it and the regenerate command',
  stale.map((x) => `${x.line} ${x.kind} ${x.value}`).join(', ') + ` ${stale[0]?.message.includes(WRITE)}`, '3 region refuted-by true');
t('DS-886 AC4 the command is node tests/prose_facts.mjs --write', WRITE, 'node tests/prose_facts.mjs --write');
const reworded = check([join(F, 'regions.md')], { values: { 'spawn-order': { rule: 'Smallest first.', keep: KEEP_ORDER_RULE } } });
t('DS-886 AC5 a changed spawn-order rule fails the order-and-holds region, naming it and the command',
  reworded.map((x) => `${x.line} ${x.value}`).join(', ') + ` ${reworded[0]?.message.includes(WRITE)}`, '7 spawn-order true');
t('DS-886 AC6 a region edited by hand fails, naming it', lines('region-edited.md'), '3 region refuted-by');
t('DS-886 AC6 the report names the file, the line and the region', report(found('region-edited.md')[0]).startsWith(
  'tests/fixtures/prose-code/region-edited.md:3: the generated region refuted-by is not what the code says'), true);
t('DS-886 AC7 a region the registry does not know fails naming it; so does one never closed', lines('region-unknown.md'), '3 region no-such-region, 5 region refuted-by');
t('DS-886 AC7 the report names the unknown region', found('region-unknown.md')[0].message, 'the generated region no-such-region is not one tests/prose_facts.mjs knows: add it to REGIONS or remove its markers');
t('DS-886 region findings are never held by the baseline', gate(found('region-edited.md'), found('region-edited.md').map(({ file, kind, value, context }) => ({ file, kind, value, context }))).fresh.length, 1);
const treeFiles = markdownFiles(DEFAULT_PATHS.map((p) => join(R, p)));
t('DS-886 AC8 regenerating every region in the skills and agents changes no file',
  treeFiles.filter((p) => regenerate(readFileSync(p, 'utf8')).text !== readFileSync(p, 'utf8')).map((p) => p.slice(R.length + 1)).join(', '), '');
t('DS-886 AC8 each registered region is used in the tree', Object.keys(REGIONS).filter((n) => !treeFiles.some((p) => regions(readFileSync(p, 'utf8')).found.some((r) => r.name === n))).join(', '), '');
const factsCli = (...args) => childProcess.spawnSync(process.execPath, [join(R, 'tests/prose_facts.mjs'), ...args], { cwd: R, encoding: 'utf8' });
t('DS-886 AC8 the regenerate command in check mode passes the real tree', factsCli().status, 0);
const tmp = scratch('prose-facts-');
const edited = readFileSync(join(F, 'region-edited.md'), 'utf8');
writeFileSync(join(tmp, 'a.md'), edited);
const before = factsCli(join(tmp, 'a.md'));
const written = factsCli('--write', join(tmp, 'a.md'));
t('DS-886 the command names the region, then --write restores it and touches nothing around it',
  [before.status, written.status, readFileSync(join(tmp, 'a.md'), 'utf8') === edited.replace('`claude`, `codex` or `gemini`', '`claude` or `codex`')].join(' '), '1 0 true');

// ---- DS-889: the push-nothing rule is fix-tries' text ----------------------------------------------
const { pushNothing } = await import('../desk/bin/fix-tries.mjs');
const POST = 'skills/desk-review/references/phase-7-post.md', STAGE4 = 'skills/desk-autopilot/references/worker-contract-stage-4.md';
for (const [file, what] of [[POST, "desk-review's post phase"], [STAGE4, 'the Stage 4 worker contract']]) {
  t(`DS-889 AC4 ${what} holds the push-nothing rule and its accepted-gap exception as fix-tries renders them`, regionIn(readFileSync(join(R, file), 'utf8'), 'push-nothing'), pushNothing(true));
}
const ruleChanged = check([join(R, POST), join(R, STAGE4)], { values: { 'push-nothing': { text: 'If you pushed nothing, post a review anyway.' } } }).filter((x) => x.kind === 'region');
t('DS-889 AC3 a push-nothing rule changed in fix-tries fails both unregenerated regions, naming each and the regenerate command',
  `${ruleChanged.map((x) => `${x.file} ${x.value}`).sort().join(', ')} ${ruleChanged.every((x) => x.message.includes(WRITE))}`, `${STAGE4} push-nothing, ${POST} push-nothing true`);

// ---- DS-888: Phase 0 shows desk-env's known-untracked list -----------------------------------------
const { KNOWN_UNTRACKED } = await import('../desk/bin/desk-env.mjs');
const PHASE0 = 'skills/desk-review/references/phase-0-preflight.md', PHASE3 = 'skills/desk-review/references/phase-3-find.md';
const phase0 = readFileSync(join(R, PHASE0), 'utf8');
t('DS-888 Phase 0 shows every file desk-env leaves out as known-untracked, in a generated region',
  KNOWN_UNTRACKED.every((k) => (regionIn(phase0, 'known-untracked') ?? '').includes(`\`${k.path}\``)), true);
t('DS-888 Phase 0 runs desk-env tree-status and the round-end check runs it with the run id',
  `${phase0.includes('`desk-env tree-status` must print nothing')} ${readFileSync(join(R, PHASE3), 'utf8').includes('`desk-env tree-status --run <run>`')}`, 'true true');
const added = check([join(R, PHASE0)], { values: { 'known-untracked': { files: [...KNOWN_UNTRACKED, { path: '.desk-extra/<TICKET>.json', by: 'desk-x', what: 'notes' }] } } }).filter((x) => x.kind === 'region');
t('DS-888 AC4 a file added to the known-untracked list fails Phase 0\'s unregenerated region, naming it and the regenerate command',
  `${added.map((x) => `${x.file} ${x.value}`).join(', ')} ${added.every((x) => x.message.includes(WRITE))}`, `${PHASE0} known-untracked true`);

// ---- AC9 / DS-890 AC1: the real tree has no finding, and the baseline is empty ---------------------
const baseline = readBaseline();
const g = gate(tree, baseline);
for (const x of g.fresh.slice(0, 20)) console.log(`  new: ${report(x)}`);
t('AC9 the real tree has no finding the baseline does not hold', g.fresh.length, 0);
tj('DS-890 AC1 the baseline is empty', baseline, []);
const run = cli();
t('DS-890 AC1 the CLI passes and reports zero baseline entries',
  [run.status, /^0 finding\(s\) the baseline does not hold; 0 baseline entries remain$/m.test(run.stdout)].join(' '), '0 true');
tj('DS-884 AC4 every baseline entry still matches a finding in the real tree', g.stale.map(staleReport), []);
const heldTree = baselineEntries(found('queue-sub.md'));
t('a baseline entry matches its finding wherever the line moves', gate(found('queue-sub.md').map((x) => ({ ...x, line: x.line + 7 })), heldTree).fresh.length, 0);
t('a baseline entry is keyed by file, kind, value and context, never line', heldTree.every((e) => Object.keys(e).join() === 'file,kind,value,context'), true);

// ---- DS-884 AC3 / AC4: lines inserted above a baselined reference, and the reference fixed --------
const T = scratch('desk-prose-check-');
const doc = join(T, 'skills/desk-x/SKILL.md');
mkdirSync(dirname(doc), { recursive: true });
const text = readFileSync(join(F, 'queue-sub.md'), 'utf8');
const f0 = facts();
const at = (body) => { writeFileSync(doc, body); return check([doc], { root: T, f: f0 }); };
const held = baselineEntries(at(text));
tj('the fixture has one baselined reference', held.map((e) => `${e.file} ${e.kind} ${e.value}`), ['skills/desk-x/SKILL.md subcommand frobnicate']);
const moved = verdict(at(`# Inserted\n\nA paragraph above the reference.\n\n${text}`), held, ['skills/desk-x/SKILL.md']);
tj('DS-884 AC3 lines inserted above it pass with the same baseline', [moved.code, moved.out.at(-1)], [0, '0 finding(s) the baseline does not hold; 1 baseline entries remain']);
const fixed = verdict(at(text.replace('frobnicate', 'requeue')), held, ['skills/desk-x/SKILL.md']);
tj('DS-884 AC4 the reference fixed with its entry left fails, telling the author to delete it', [fixed.code, fixed.out[0]],
  [1, 'tests/fixtures/prose_baseline.json: skills/desk-x/SKILL.md no longer has the subcommand frobnicate (in: node ~/.claude/desk/bin/queue.mjs frobnicate ABC-123); delete this entry']);
t('DS-884 AC4 the summary says to delete it', fixed.out.some((l) => /^Delete each entry that no longer matches from tests\/fixtures\/prose_baseline\.json/.test(l)), true);
t('an entry for a file the run did not check is not stale', verdict([], held, ['skills/desk-y/SKILL.md']).code, 0);

// ---- DS-884 AC6: the covers lines hold every module the check imports ------------------------------
const { importClosure, suiteHeader } = await import('./scope_sections.mjs');
const graph = {
  'tests/x.mjs': "import { a } from '../desk/bin/a.mjs';\nimport fs from 'node:fs';",
  'desk/bin/a.mjs': "export { b } from './b.mjs';\n// import './commented.mjs'\nconst d = await import('./dynamic.mjs');\nconst s = \"import x from './in-a-string.mjs'\";",
  'desk/bin/b.mjs': "import {\n  c,\n} from './sub/c.mjs';",
  'desk/bin/sub/c.mjs': "// reads skills/*/SKILL.md\nconst g = '/*';\nimport { e } from './e.mjs';\n/* a real block comment */\nimport { f } from './f.mjs';",
  'desk/bin/dynamic.mjs': '', 'desk/bin/sub/e.mjs': '', 'desk/bin/sub/f.mjs': '',
};
tj('the closure follows static and dynamic relative imports and re-exports, not node:, commented or quoted ones, and a /* in a line comment or a string hides none',
  importClosure('tests/x.mjs', (p) => graph[p]),
  ['desk/bin/a.mjs', 'desk/bin/b.mjs', 'desk/bin/dynamic.mjs', 'desk/bin/sub/c.mjs', 'desk/bin/sub/e.mjs', 'desk/bin/sub/f.mjs', 'tests/x.mjs']);
const uncovered = (closure, covers) => closure.filter((p) => !covers.includes(p));
tj('a module the covers lines do not list is named', uncovered(importClosure('desk/bin/b.mjs', (p) => graph[p]), ['desk/bin/b.mjs', 'desk/bin/sub/c.mjs', 'desk/bin/sub/e.mjs']), ['desk/bin/sub/f.mjs']);
const own = suiteHeader(readFileSync(fileURLToPath(import.meta.url), 'utf8')).covers;
const closure = importClosure('tests/prose_check.mjs', (p) => readFileSync(join(R, p), 'utf8'));
t('the real closure reaches through desk-env.mjs', closure.includes('desk/bin/machine.mjs'), true);
tj('DS-884 AC6 every module tests/prose_check.mjs imports, directly or through another, is on a covers line',
  uncovered(closure, own), []);

process.exit(fails ? 1 : 0);
