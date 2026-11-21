// suite: prose check, every code reference a skill makes is one the code has, with today's drift in a baseline
// covers: tests/prose_check.mjs tests/prose_scan.mjs tests/prose_facts.mjs desk/bin/spawn-order.mjs skills/desk-review/bin/verdict.mjs tests/command_shapes.mjs tests/fixtures/prose_baseline.json tests/fixtures/prose-code/*.md desk/bin/prose-facts.mjs desk/bin/queue-commands.mjs desk/bin/markers.mjs desk/bin/queue-writer.mjs desk/bin/batch-state.mjs desk/bin/with-lock.sh skills/**/*.md agents/*.md
// covers: desk/bin/desk-env.mjs desk/bin/config-schema.mjs desk/bin/machine.mjs desk/bin/test-scope.mjs desk/bin/workflow-yaml.mjs desk/bin/dir-lock.mjs desk/bin/failure-class.mjs desk/bin/queue-store.mjs desk/bin/clears-when.mjs desk/bin/harvest.mjs desk/bin/spine-check.mjs desk/bin/scope-report.mjs desk/bin/baseline.mjs desk/bin/gate.mjs desk/bin/desk-ci.mjs desk/bin/decisions.mjs desk/templates/scripts/desk/review-gate.mjs
// The covers lines name every module the check imports, directly or through another (checked below),
// so a change to any of them runs this suite.
// Each fixture under tests/fixtures/prose-code/ adds one kind of drift beside a reference the code has;
// the check must name the bad one and pass the good one. Then the real skills and agents tree, against
// the baseline, in-process and under two seconds.
import childProcess from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// AC12 first: nothing below may start a process until the real tree has been checked in-process.
const SPAWNERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const real = Object.fromEntries(SPAWNERS.map((k) => [k, childProcess[k]]));
const started = [];
for (const k of SPAWNERS) childProcess[k] = (...a) => { started.push(`${k} ${a[0]}`); throw new Error(`prose check started a process: ${k}`); };
syncBuiltinESMExports();
const t0 = performance.now();
const { check, gate, readBaseline, report, optOuts, OPT_OUT, facts, verdict, staleReport, baselineEntries, importClosure } = await import('./prose_check.mjs');
const { markdownFiles } = await import('./command_shapes.mjs');
const { DEFAULT_PATHS } = await import('./prose_scan.mjs');
const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const tree = check(markdownFiles(DEFAULT_PATHS.map((p) => join(R, p))));
const ms = performance.now() - t0;
Object.assign(childProcess, real);
syncBuiltinESMExports();

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const F = join(R, 'tests/fixtures/prose-code');
const found = (f) => check([join(F, f)]);
const lines = (f) => found(f).map((x) => `${x.line} ${x.kind} ${x.value}`).join(', ');
const cli = (...args) => childProcess.spawnSync(process.execPath, [join(R, 'tests/prose_check.mjs'), ...args], { cwd: R, encoding: 'utf8' });

// ---- AC12: the whole tree, in-process ------------------------------------------------------------
t('AC12 the full skills and agents tree is checked in under two seconds', ms < 2000 ? 'under 2s' : `${Math.round(ms)}ms`, 'under 2s');
t('AC12 without starting another process', started.join(', '), '');

// ---- AC1: a queue subcommand the code does not have -----------------------------------------------
t('AC1 the unknown subcommand, and not the known one', lines('queue-sub.md'), '4 subcommand frobnicate');
t('AC1 the report names the file, the line, the subcommand and the queue command',
  report(found('queue-sub.md')[0]).startsWith('tests/fixtures/prose-code/queue-sub.md:4: the queue command has no subcommand frobnicate'), true);
const sub = cli(join(F, 'queue-sub.md'));
t('AC1 the CLI exits 1 and prints it', [sub.status, sub.stdout.includes('queue-sub.md:4: the queue command has no subcommand frobnicate')].join(' '), '1 true');

// ---- AC2: a script outside desk/bin and the skills' bins ------------------------------------------
t('AC2 a missing bin script and a repo script are named; desk/bin and a skill bin, installed or not, pass',
  lines('script.md'), '4 script ~/.claude/desk/bin/no-such-script.mjs, 9 script scripts/make-thing.sh');
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
t('AC8 the undeclared path; a declared one under any placeholder, and its folder, pass', lines('state-path.md'), '3 state-path no-such/<TICKET>.json');
t('AC8 the report names the path', found('state-path.md')[0].message, 'no-such/<TICKET>.json is not a declared state path');

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
const tmp = mkdtempSync(join(tmpdir(), 'prose-facts-'));
const edited = readFileSync(join(F, 'region-edited.md'), 'utf8');
writeFileSync(join(tmp, 'a.md'), edited);
const before = factsCli(join(tmp, 'a.md'));
const written = factsCli('--write', join(tmp, 'a.md'));
t('DS-886 the command names the region, then --write restores it and touches nothing around it',
  [before.status, written.status, readFileSync(join(tmp, 'a.md'), 'utf8') === edited.replace('`claude`, `codex` or `gemini`', '`claude` or `codex`')].join(' '), '1 0 true');
rmSync(tmp, { recursive: true, force: true });

// ---- AC9: main's drift is held by the baseline ----------------------------------------------------
const baseline = readBaseline();
const g = gate(tree, baseline);
for (const x of g.fresh.slice(0, 20)) console.log(`  new: ${report(x)}`);t('AC9 the real tree has no finding the baseline does not hold', g.fresh.length, 0);
t('AC9 the baseline holds drift, keyed by file, kind, value and context, never line',
  baseline.length > 0 && baseline.every((e) => Object.keys(e).join() === 'file,kind,value,context'), true);
const run = cli();
t('AC9 the CLI passes and prints how many baseline entries remain',
  [run.status, new RegExp(`^0 finding\\(s\\) the baseline does not hold; ${g.remaining} baseline entries remain`, 'm').test(run.stdout)].join(' '), '0 true');
t('a baseline entry matches its finding wherever the line moves', gate(tree.map((x) => ({ ...x, line: x.line + 7 })), baseline).fresh.length, 0);
const tj = (name, got, want) => t(name, JSON.stringify(got), JSON.stringify(want));
tj('DS-884 AC4 every baseline entry still matches a finding in the real tree', g.stale.map(staleReport), []);

// ---- DS-884 AC3 / AC4: lines inserted above a baselined reference, and the reference fixed --------
const { scratch } = await import('./scratch.mjs');
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
const graph = {
  'tests/x.mjs': "import { a } from '../desk/bin/a.mjs';\nimport fs from 'node:fs';",
  'desk/bin/a.mjs': "export { b } from './b.mjs';\n// import './commented.mjs'\nconst d = await import('./dynamic.mjs');\nconst s = \"import x from './in-a-string.mjs'\";",
  'desk/bin/b.mjs': "import {\n  c,\n} from './sub/c.mjs';",
  'desk/bin/sub/c.mjs': 'export const c = 1;',
};
tj('the closure follows static relative imports and re-exports, not node:, dynamic, commented or quoted ones',
  importClosure('tests/x.mjs', (p) => graph[p]), ['desk/bin/a.mjs', 'desk/bin/b.mjs', 'desk/bin/sub/c.mjs', 'tests/x.mjs']);
const uncovered = (closure, covers) => closure.filter((p) => !covers.includes(p));
tj('a module the covers lines do not list is named', uncovered(importClosure('tests/x.mjs', (p) => graph[p]), ['tests/x.mjs', 'desk/bin/a.mjs', 'desk/bin/b.mjs']), ['desk/bin/sub/c.mjs']);
const own = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 30)
  .filter((l) => l.startsWith('// covers: ')).flatMap((l) => l.slice('// covers: '.length).trim().split(/\s+/));
t('the real closure reaches through desk-env.mjs', importClosure('tests/prose_check.mjs').includes('desk/bin/machine.mjs'), true);
tj('DS-884 AC6 every module tests/prose_check.mjs imports, directly or through another, is on a covers line',
  uncovered(importClosure('tests/prose_check.mjs'), own), []);

process.exit(fails ? 1 : 0);
