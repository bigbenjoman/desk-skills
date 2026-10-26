// suite: skill eval harness (task set with and without a skill, keep/trim/drop)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs, loadTasks, readRun, verdict, checkPasses } from '../desk/bin/skill-eval.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'skill-eval.mjs');
const dir = mkdtempSync(join(tmpdir(), 'skill-eval-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

// A stub claude: logs each call, replies with the prompt plus the skill's marker when its SKILL.md was
// appended. SLOW sleeps past the timeout; CRASH-BASE exits 1 without the skill.
const bin = join(dir, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const val = (f) => { const i = a.indexOf(f); return i < 0 ? null : a[i + 1]; };
const prompt = val('-p'), sys = val('--append-system-prompt');
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ args: a, cwd: process.cwd() }) + '\\n');
const reply = () => {
  if (prompt.includes('CRASH-BASE') && !sys) { process.stderr.write('boom'); process.exit(1); }
  const marker = sys && sys.includes('MARKER-FROM-SKILL') ? ' MARKER-FROM-SKILL uses-skill' : '';
  const cost = Number((/COST=([0-9.]+)/.exec(prompt) || [0, '0.01'])[1]);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hello ' + prompt + marker, total_cost_usd: cost }));
};
if (prompt.includes('SLOW')) setTimeout(reply, 5000); else reply();
`);
chmodSync(join(bin, 'claude'), 0o755);
mkdirSync(join(dir, 'skills', 'stub-skill'), { recursive: true });
writeFileSync(join(dir, 'skills', 'stub-skill', 'SKILL.md'), '# stub-skill\nSay MARKER-FROM-SKILL.\n');

const log = join(dir, 'calls.jsonl');
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const run = (args) => {
  rmSync(log, { force: true });
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log } });
};
const taskSet = (name, tasks) => { const f = join(dir, `${name}.json`); writeFileSync(f, JSON.stringify({ tasks })); return f; };

// AC4: no budget flag refuses to start, names the flag, and runs nothing.
const keepSet = taskSet('keep', [
  { id: 'marker', prompt: 'greet', checks: [{ name: 'has marker', contains: 'MARKER-FROM-SKILL' }, { name: 'says hello', contains: 'hello' }] },
  { id: 'slow', prompt: 'SLOW please', checks: [{ name: 'says hello', contains: 'hello' }] },
  { id: 'crash-base', prompt: 'CRASH-BASE now', checks: [{ name: 'greets', matches: '^hello\\b' }] },
]);
let r = run(['--skill', 'stub-skill', '--tasks', keepSet, '--out', join(dir, 'out-nobudget')]);
t('AC4 no budget exits 2', r.status, 2);
t('AC4 names the flag', /--max-budget-usd/.test(r.stderr), true);
t('AC4 runs nothing', calls().length, 0);
t('AC4 writes no report', existsSync(join(dir, 'out-nobudget')), false);
t('AC4 a malformed budget is refused', /positive number/.test(throws(() => parseArgs(['--max-budget-usd', 'lots', '--skill', 'x', '--tasks', 'y']))), true);

// AC1, AC3: each task runs in both arms; failed and timed-out runs count neither way.
const out = join(dir, 'out-keep');
r = run(['--skill', 'stub-skill', '--tasks', keepSet, '--max-budget-usd', '0.5', '--timeout', '1', '--out', out]);
t('runs to completion', r.status, 0);
const c = calls();
t('AC1 two runs per task', c.length, 6);
const withSkill = c.filter((x) => x.args.includes('--append-system-prompt'));
t('AC1 one run per task has the skill', withSkill.length, 3);
t('AC1 the skill arm can read the skill directory', withSkill.every((x) => x.args.includes('--add-dir')), true);
t('AC1 the base arm has neither', c.filter((x) => !x.args.includes('--append-system-prompt')).every((x) => !x.args.includes('--add-dir')), true);
t('AC1 no user skills reach either arm', c.every((x) => x.args[x.args.indexOf('--setting-sources') + 1] === ''), true);
t('AC4 every run carries the budget', c.every((x) => x.args[x.args.indexOf('--max-budget-usd') + 1] === '0.5'), true);
t('AC1 every run has its own working directory', new Set(c.map((x) => x.cwd)).size, 6);
const report = readFileSync(join(out, 'report.md'), 'utf8');
const lines = report.trim().split('\n');
t('AC1 a section per task', ['## marker', '## slow', '## crash-base'].every((h) => lines.includes(h)), true);
t('AC1 checks side by side', lines.includes('| Check | With stub-skill | Without |'), true);
t('AC1 skill-only check', lines.includes('| has marker | pass | fail |'), true);
t('AC1 shared check', lines.includes('| says hello | pass | pass |'), true);
t('AC3 timeout marked failed in both arms', lines.some((l) => /^\| run \| failed: timed out after 1s .*\| failed: timed out after 1s /.test(l)), true);
t('AC3 a failed run scores no check', lines.includes('| greets | pass | — |'), true);
t('AC3 base crash marked failed', lines.some((l) => /^\| run \| ok .*\| failed: claude exited 1 /.test(l)), true);
t('AC3 timed-out check not counted', lines.filter((l) => l === '| says hello | — | — |').length, 1);
t('AC3 totals count finished runs only', lines.includes('| Checks passed | 3 | 1 |') && lines.includes('| Checks failed | 0 | 1 |'), true);
t('AC3 failed runs listed apart', lines.includes('| Runs failed (not counted) | 1 | 2 |'), true);
t('AC2 ends with the verdict', /^Verdict: stub-skill: \*\*keep\*\* /.test(lines.at(-1)), true);
t('AC2 CLI prints the verdict', /verdict: keep/.test(r.stdout), true);
t('transcripts written', ['marker.skill', 'marker.base', 'slow.skill'].every((n) => existsSync(join(out, 'transcripts', `${n}.json`))), true);

// AC2: equal passes is trim, with both transcripts linked; fewer is drop.
const trimOut = join(dir, 'out-trim');
r = run(['--skill', join(dir, 'skills', 'stub-skill'), '--tasks', taskSet('trim', [{ id: 'hi', prompt: 'greet', checks: [{ name: 'says hello', contains: 'hello' }] }]), '--max-budget-usd', '1', '--out', trimOut]);
const trim = readFileSync(join(trimOut, 'report.md'), 'utf8').trim().split('\n');
t('AC2 trim when equal', /\*\*trim\*\*/.test(trim.at(-1)), true);
const link = trim.find((l) => l.startsWith('- hi: '));
t('AC2 trim links both transcripts', link, '- hi: [with](transcripts/hi.skill.json) · [without](transcripts/hi.base.json)');
t('AC2 linked transcripts exist', existsSync(join(trimOut, 'transcripts', 'hi.skill.json')) && existsSync(join(trimOut, 'transcripts', 'hi.base.json')), true);
r = run(['--skill', 'stub-skill', '--tasks', taskSet('drop', [{ id: 'plain', prompt: 'greet', checks: [{ name: 'no skill talk', absent: 'uses-skill' }] }]), '--max-budget-usd', '1', '--out', join(dir, 'out-drop')]);
t('AC2 drop when fewer', /\*\*drop\*\*/.test(readFileSync(join(dir, 'out-drop', 'report.md'), 'utf8').trim().split('\n').at(-1)), true);
t('AC2 keep/trim/drop by passes', [verdict({ skill: { passed: 2 }, base: { passed: 1 } }), verdict({ skill: { passed: 1 }, base: { passed: 1 } }), verdict({ skill: { passed: 0 }, base: { passed: 1 } })].join(','), 'keep,trim,drop');

// AC3: the whole-run budget. A task starts only while both runs fit at their ceiling; one
// left unstarted is named, and the report gives no verdict.
t('the whole-run budget defaults to 5', parseArgs(['--max-budget-usd', '1', '--skill', 'x', '--tasks', 'y']).total, '5');
t('a whole-run budget that fits no task is refused', /cannot fit one task/.test(throws(() => parseArgs(['--max-budget-usd', '2', '--total-budget-usd', '3', '--skill', 'x', '--tasks', 'y']))), true);
t('a malformed whole-run budget is refused', /--total-budget-usd must be/.test(throws(() => parseArgs(['--max-budget-usd', '1', '--total-budget-usd', 'all', '--skill', 'x', '--tasks', 'y']))), true);
const capOut = join(dir, 'out-cap');
r = run(['--skill', 'stub-skill', '--tasks', taskSet('cap', [
  { id: 'dear', prompt: 'greet COST=0.9', checks: [{ name: 'says hello', contains: 'hello' }] },
  { id: 'second', prompt: 'greet', checks: [{ name: 'says hello', contains: 'hello' }] },
  { id: 'third', prompt: 'greet', checks: [{ name: 'says hello', contains: 'hello' }] },
]), '--max-budget-usd', '1', '--total-budget-usd', '3', '--out', capOut]);
t('AC3 stops at the budget', calls().length, 2);
t('AC3 CLI prints no verdict', /verdict: none \(not run: second, third\)/.test(r.stdout), true);
const cap = readFileSync(join(capOut, 'report.md'), 'utf8').trim().split('\n');
t('AC3 report gives no verdict', cap.some((l) => /keep|trim|drop/.test(l) && l.startsWith('Verdict')), false);
t('AC3 report names the tasks not run', cap.slice(cap.indexOf('## Verdict')).filter((l) => l === '- second' || l === '- third').length, 2);
t('AC3 report says what was spent', cap.includes('Spent $1.80 of the $3 whole-run budget. The figure is claude\'s reported cost: on a claude.ai subscription it is plan usage, not a charge.'), true);
t('AC3 an unstarted task is marked not run', cap[cap.indexOf('## second') + 2], 'Not run: the whole-run budget could not fit both of its runs.');
r = run(['--skill', 'stub-skill', '--tasks', taskSet('nocost', [
  { id: 'crash-base', prompt: 'CRASH-BASE now', checks: [{ name: 'greets', contains: 'hello' }] },
  { id: 'after', prompt: 'greet', checks: [{ name: 'says hello', contains: 'hello' }] },
]), '--max-budget-usd', '1', '--total-budget-usd', '3', '--out', join(dir, 'out-nocost')]);
t('AC3 a run that reports no cost counts as its ceiling', /not run: after/.test(r.stdout), true);
t('AC2 a full run still gives a verdict under the budget', /verdict: keep/.test(run(['--skill', 'stub-skill', '--tasks', keepSet, '--max-budget-usd', '0.5', '--timeout', '1', '--out', join(dir, 'out-keep2')]).stdout), true);

// AC1: the committed desk-pr task set. At least 5 tasks; every task's checks pass against its
// fixture reply, and at least one fails against an empty reply.
const PR_TASKS = join(dirname(SCRIPT), '..', '..', 'evals', 'desk-pr.json');
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'eval-desk-pr');
const prTasks = loadTasks(PR_TASKS);
t('desk-pr task set has at least 5 tasks', prTasks.length >= 5, true);
for (const task of prTasks) {
  const reply = readFileSync(join(FIXTURES, `${task.id}.md`), 'utf8');
  const failing = task.checks.filter((c) => !checkPasses(c, reply)).map((c) => c.name);
  t(`desk-pr ${task.id} passes its fixture`, failing.join(', ') || 'all', 'all');
  t(`desk-pr ${task.id} fails an empty reply`, task.checks.some((c) => !checkPasses(c, '')), true);
}
// A reply that only restates the prompt's facts fails the checks that need judgement. The DIFF REVIEW
// block alone copies git log and git status, so it must flag nothing.
const blockOnly = (id) => readFileSync(join(FIXTURES, `${id}.md`), 'utf8').split('```')[1];
const passing = (id, reply, names) => prTasks.find((task) => task.id === id).checks.filter((c) => names.includes(c.name) && checkPasses(c, reply)).map((c) => c.name).join(', ') || 'none';
t('desk-pr artefacts block alone flags nothing', passing('artefacts', blockOnly('artefacts'), ['takes the one-off script out', 'flags the Playwright output', 'flags the loose screenshot']), 'none');
t('desk-pr stray-commit block alone names no stray commit', passing('stray-commit', blockOnly('stray-commit'), ['names the stray commit']), 'none');
t('desk-pr stray-commit "cannot push" is not holding off', passing('stray-commit', 'I cannot push from here; run git push.', ['does not push']), 'none');
const pushingReplies = ['Pushed both commits. Stop me if that was wrong.', 'I could not push the first time, so I retried and pushed.',
  'Pushed both commits; CI will stop on any failure.', 'Pushing now; there is no reason not to push.', 'Pushed; tell me if you would rather I hold off next time.',
  "I won't push 9b7e2f1, it is SHOP-399's; I'll push a41c0de on its own."];
t('desk-pr stray-commit a pushing reply is not holding off', pushingReplies.map((reply) => passing('stray-commit', reply, ['does not push'])).join(' / '), pushingReplies.map(() => 'none').join(' / '));
const holdReplies = ['I have not pushed: 9b7e2f1 is from a different session.', 'Stop. 9b7e2f1 belongs to SHOP-399, so I did not push.',
  '**Stop:** 9b7e2f1 (SHOP-399) was not made in this session.', 'Not pushing: 9b7e2f1 is outside SHOP-415.', "I won't push: 9b7e2f1 isn't ours.", '**Stop** — 9b7e2f1 is from another session.',
  "I'm not going to push this: 9b7e2f1 is from another session. I'll push a41c0de once it is on a clean branch.",
  'I have not pushed a41c0de or 9b7e2f1: 9b7e2f1 is from another session.', 'Not pushing `a41c0de` or `9b7e2f1`: `9b7e2f1` is from another session.',
  "Stop: 9b7e2f1 is from another session. I'll push `a41c0de` once it is on a clean branch.", "I won't push: 9b7e2f1 isn't ours. I'll push a41c0de if you approve."];
t('desk-pr stray-commit other right wordings pass', holdReplies.map((reply) => passing('stray-commit', reply, ['names the stray commit', 'does not push'])).join(' / '), holdReplies.map(() => 'names the stray commit, does not push').join(' / '));
const artefactChecks = ['takes the one-off script out', 'flags the Playwright output', 'flags the loose screenshot'];
t('desk-pr artefacts the shell commands pass', passing('artefacts', '- git rm scripts/backfill-once.mjs\n- rm -rf .playwright-mcp/ after.png', artefactChecks), artefactChecks.join(', '));
t('desk-pr artefacts keeping the script does not pass', ['scripts/backfill-once.mjs is harmless; no need to remove it.', 'No need to remove scripts/backfill-once.mjs: it is harmless.'].map((reply) => passing('artefacts', reply, ['takes the one-off script out'])).join(' / '), 'none / none');
const keepingArtefacts = ['- .playwright-mcp/ and after.png are untracked, so there is nothing to delete from the PR.',
  '- Remove scripts/backfill-once.mjs; .playwright-mcp/ and after.png are untracked and can stay.'];
t('desk-pr artefacts keeping the untracked files does not pass', keepingArtefacts.map((reply) => passing('artefacts', reply, ['flags the Playwright output', 'flags the loose screenshot'])).join(' / '), 'none / none');
t('desk-pr body-fence the count in prose passes', passing('body-fence', '/search?q=economics now returns 7 results, down from 9.', ['gives the result count']), 'gives the result count');
t('desk-pr staging-step an unchecked box for another step does not pass', passing('staging-step', '### Testing\n- [ ] typecheck passes\n- Staging is https://staging.shop.example.', ['leaves the staging check unchecked']), 'none');

// The run reader and the task-set checks.
t('an error result is failed', readRun({ status: 0, stdout: JSON.stringify({ subtype: 'error_max_budget_usd', is_error: true, result: 'partial' }) }, 1).why, 'claude reported error_max_budget_usd');
t('unparseable output is failed', readRun({ status: 0, stdout: 'not json' }, 1).why, 'claude printed no result');
t('a task needs checks', /no checks/.test(throws(() => loadTasks(taskSet('nochecks', [{ id: 'a', prompt: 'p', checks: [] }])))), true);
t('a check needs exactly one kind', /exactly one/.test(throws(() => loadTasks(taskSet('twokinds', [{ id: 'a', prompt: 'p', checks: [{ name: 'x', contains: 'a', absent: 'b' }] }])))), true);
t('ids are unique', /twice/.test(throws(() => loadTasks(taskSet('dup', [{ id: 'a', prompt: 'p', checks: [{ name: 'x', contains: 'a' }] }, { id: 'a', prompt: 'p', checks: [{ name: 'x', contains: 'a' }] }])))), true);
t('an unknown skill is refused', run(['--skill', 'nope', '--tasks', keepSet, '--max-budget-usd', '1']).status, 2);

console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);
