// suite: bench blind (diffs exported under random letters, scores joined back to arms)
// covers: desk/bin/bench-rubric.md
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scrub, joinScores, PLACEHOLDER } from '../desk/bin/bench-blind.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const SCRIPT = join(BIN, 'bench-blind.mjs');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bench-blind-test-')));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });

const ARMS = [
  { name: 'alpha', model: 'claude-opus-5-5', effort: 'high' },
  { name: 'bravo', model: 'model-b', effort: 'medium' },
  { name: 'c', model: 'model-c', effort: 'low' },
];
const plainDiff = (arm) => `diff --git a/src.txt b/src.txt\n--- a/src.txt\n+++ b/src.txt\n@@ -1 +1 @@\n-old\n+new from ${arm.name === 'c' ? 'someone' : 'a run'}\n`;

// A bench output folder as bench.mjs leaves it: run.json plus each run's result.json and diff.patch.
function benchOut(name, tasks) {
  const out = join(dir, name, 'bench-out');
  const set = join(dir, name, 'tasks.json');
  mkdirSync(join(out, 'runs'), { recursive: true });
  writeFileSync(set, JSON.stringify({ tasks: tasks.map((x) => ({ id: x.id, prompt: `Ticket text for ${x.id}` })) }));
  const report = tasks.map((x) => ({ task: x.id, order: ARMS.map((a) => a.name), runs: ARMS.map((a) => {
    const d = join(out, 'runs', `${x.id}.${a.name}.k`);
    mkdirSync(d, { recursive: true });
    const status = x.failed === a.name ? 'failed' : 'accepted';
    writeFileSync(join(d, 'result.json'), JSON.stringify({ task: x.id, arm: a.name, model: a.model, effort: a.effort, status }));
    writeFileSync(join(d, 'diff.patch'), x.diffs?.[a.name] ?? (x.only && x.only !== a.name ? '' : plainDiff(a)));
    return { arm: a.name, status, dir: d };
  }) }));
  writeFileSync(join(out, 'run.json'), JSON.stringify({ seed: '7', tasks: report }));
  return { set, out, blind: join(out, 'blind') };
}
const sheetOf = (b, id) => readFileSync(join(b.blind, 'sheets', `${id}.md`), 'utf8');
const keyOf = (b) => JSON.parse(readFileSync(join(b.blind, 'key.json'), 'utf8'));

// AC1, AC3, AC4: one sheet per task, every arm under a letter, the key apart from the sheets.
const tagged = [
  'diff --git a/x.mjs b/x.mjs',
  '+++ b/x.mjs',
  '+// written by claude-opus-5-5 at high effort on arm alpha',
  '+const branch = "feat/DS-1-bravo-fix"; // model-b, --effort medium',
  '+// Sonnet 5.5 and Opus wrote this, arm c too',
  ' Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
  '+a high bar, a medium cup, the low road',
  '+```inner fence```',
  '',
].join('\n');
const tasks = Array.from({ length: 24 }, (_, i) => ({ id: `t${i}` }));
tasks[0].diffs = { alpha: tagged };
tasks[1].only = 'bravo';
tasks[3].failed = 'alpha';
const b = benchOut('main', tasks);
let r = run('export', '--tasks', b.set);
if (r.status !== 0) console.log(r.stderr);
t('export runs', r.status, 0);
t('AC1 one sheet per task', readdirSync(join(b.blind, 'sheets')).length, 24);
const s2 = sheetOf(b, 't2');
t('AC1 the sheet holds the ticket text', s2.includes('Ticket text for t2'), true);
t('AC1 every arm under a letter', ['A', 'B', 'C'].every((l) => s2.includes(`## Change ${l}\n`)) && !s2.includes('## Change D'), true);
t('AC1 every arm\'s diff is there', (s2.match(/```diff/g) ?? []).length, 3);
const key = keyOf(b);
t('AC1 the key maps each letter to one arm', Object.values(key.tasks).every((k) => Object.values(k).map((e) => e.arm).sort().join() === 'alpha,bravo,c'), true);
t('AC1 the letters are drawn per task', new Set(Object.values(key.tasks).map((k) => k.A.arm)).size, 3);
t('AC1 the order on the sheet is the letters\'', /## Change A[\s\S]*## Change B[\s\S]*## Change C/.test(s2), true);
const sheets = readdirSync(join(b.blind, 'sheets')).map((f) => readFileSync(join(b.blind, 'sheets', f), 'utf8'));
t('AC3 the key is its own file', existsSync(join(b.blind, 'key.json')) && !existsSync(join(b.blind, 'sheets', 'key.json')), true);
t('AC3 no sheet points at the key', sheets.some((s) => /key/i.test(s)), false);
t('AC3 no sheet names an arm', sheets.some((s) => /alpha|bravo|model-[bc]/i.test(s)), false);
const rubric = readFileSync(join(BIN, 'bench-rubric.md'), 'utf8').trim();
t('AC4 every sheet carries the rubric', sheets.every((s) => s.includes(rubric)), true);
t('AC4 the rubric covers good, disqualifying and each point', ['A mergeable change', 'disqualifies', '**5**', '**1**'].every((x) => rubric.includes(x)), true);
t('scores.csv is a template to fill in', readFileSync(join(b.blind, 'scores.csv'), 'utf8').split('\n').slice(0, 2).join('|'), `task,letter,score|t0,A,`);

// AC2: names in a diff are replaced; the rest of it stays.
const s0 = sheetOf(b, 't0');
t('AC2 the co-author trailer is neutral', s0.includes(` Co-Authored-By: ${PLACEHOLDER}`) && !/noreply@anthropic/.test(s0), true);
t('AC2 the model id goes', /claude-opus/i.test(s0), false);
t('AC2 model family names go', /\b(opus|sonnet)\b/i.test(s0), false);
t('AC2 the arm and branch names go', /alpha|bravo/.test(s0), false);
t('AC2 a short arm name goes after "arm"', s0.includes(`arm ${PLACEHOLDER} too`), true);
t('AC2 the effort goes', s0.includes(`[redacted] effort on arm`) && s0.includes(`--effort ${PLACEHOLDER}`), true);
t('AC2 ordinary words stay', s0.includes('+a high bar, a medium cup, the low road') && s0.includes('+++ b/x.mjs'), true);
t('a fence in a diff does not close the block', /````diff[\s\S]*```inner fence```[\s\S]*````/.test(s0), true);
t('scrub with no names leaves text alone', scrub('+plain line\n', []), '+plain line\n');
t('AC2 an arm name holding a model family goes whole', scrub('+// arm opus-high\n', [{ name: 'opus-high', model: 'opus', effort: 'high' }]), `+// arm ${PLACEHOLDER}\n`);

// AC6: one arm made a diff; the others show without a name and take no score.
const s1 = sheetOf(b, 't1');
const k1 = key.tasks.t1;
const madeIt = Object.keys(k1).find((l) => k1[l].change);
t('AC6 the one diff is under a letter', k1[madeIt].arm, 'bravo');
t('AC6 the others are "no change produced"', (s1.match(/No change produced\./g) ?? []).length, 2);
t('AC6 and named by letter only', /alpha|bravo|\bc\b.*no change/i.test(s1), false);
const csv = readFileSync(join(b.blind, 'scores.csv'), 'utf8');
t('AC6 only the diff takes a score', csv.split('\n').filter((l) => l.startsWith('t1,')).join(), `t1,${madeIt},`);
const k3 = key.tasks.t3;
const failedAt = Object.keys(k3).find((l) => k3[l].arm === 'alpha');
t('AC6 a failed run\'s diff is "no change produced"', k3[failedAt].change === false && sheetOf(b, 't3').includes(`## Change ${failedAt}\n\nNo change produced.`), true);
t('AC6 and takes no score', csv.split('\n').some((l) => l === `t3,${failedAt},`), false);

// A second export into the same place would orphan the scores.
r = run('export', '--tasks', b.set);
t('a second export into the same place refuses', r.status === 2 && /already/.test(r.stderr), true);

// AC4: another rubric file reaches every sheet.
const own = benchOut('rubric', [{ id: 'r1' }]);
writeFileSync(join(dir, 'rubric.md'), 'OWN RUBRIC TEXT\n');
r = run('export', '--tasks', own.set, '--rubric', join(dir, 'rubric.md'));
t('AC4 --rubric is used', r.status === 0 && sheetOf(own, 'r1').includes('OWN RUBRIC TEXT'), true);
writeFileSync(join(dir, 'empty.md'), '\n');
t('an empty rubric refuses', /empty/.test(run('export', '--tasks', own.set, '--rubric', join(dir, 'empty.md'), '--dest', join(dir, 'x')).stderr), true);

// AC5: scores join back through the key; a sheet missing or out of range is listed and left out.
const small = benchOut('join', [{ id: 'ok' }, { id: 'gap' }, { id: 'big' }, { id: 'one', only: 'alpha' }]);
run('export', '--tasks', small.set);
const sk = keyOf(small);
const letterOf = (task, arm) => Object.keys(sk.tasks[task]).find((l) => sk.tasks[task][l].arm === arm);
const want = { alpha: 5, bravo: 3, c: 1 };
const rows = ['task,letter,score'];
for (const task of ['ok', 'gap', 'big']) for (const arm of ['alpha', 'bravo', 'c']) {
  if (task === 'gap' && arm === 'c') continue;
  rows.push(`${task},${letterOf(task, arm)},${task === 'big' && arm === 'bravo' ? 7 : want[arm]}`);
}
rows.push(`one,${letterOf('one', 'alpha')},4`);
writeFileSync(join(small.blind, 'scores.csv'), `${rows.join('\n')}\n`);
r = run('join', '--tasks', small.set);
if (r.status !== 0) console.log(r.stderr);
t('join runs', r.status, 0);
const joined = JSON.parse(readFileSync(join(small.blind, 'joined.json'), 'utf8'));
t('AC5 each score reaches its arm', JSON.stringify(joined.arms.alpha.scores), '[{"task":"ok","score":5},{"task":"one","score":4}]');
t('AC5 a missing score is listed', joined.left_out.find((x) => x.task === 'gap')?.why, `letter ${letterOf('gap', 'c')} has no score`);
t('AC5 an out-of-range score is listed', /score 7 is not a whole number from 1 to 5/.test(joined.left_out.find((x) => x.task === 'big')?.why), true);
t('AC5 a left-out sheet counts for no arm', Object.values(joined.arms).some((a) => a.scores.some((x) => x.task === 'gap' || x.task === 'big')), false);
t('AC5 and the join says so', /left out gap: letter . has no score/.test(r.stdout) && /alpha: 2 score\(s\)/.test(r.stdout), true);
t('AC6 an arm with no change is recorded as such', JSON.stringify(joined.no_change.filter((x) => x.task === 'one').map((x) => x.arm).sort()), '["bravo","c"]');

// The join's own checks on the scores file.
const k = { tasks: { x: { A: { arm: 'p', change: true }, B: { arm: 'q', change: false } } } };
t('a score for a letter with no change is listed', joinScores(k, 'x,A,3\nx,B,2\n').left_out[0].why, 'letter B has no change to score');
t('a letter scored twice is listed', joinScores(k, 'x,A,3\nx,A,4\n').left_out[0].why, 'letter A is scored twice');
t('a task not in the export is listed', joinScores(k, 'x,A,3\ny,A,4\n').left_out[0].why, 'task y is not in the export');
t('a score of 3.5 is out of range', /3\.5 is not/.test(joinScores(k, 'x,A,3.5\n').left_out[0].why), true);
t('a clean sheet counts', JSON.stringify(joinScores(k, 'task,letter,score\r\nx,A, 4 \r\n').arms.p), '{"scores":[{"task":"x","score":4}]}');
const proto = { tasks: { x: { A: { arm: 'constructor', change: true } } } };
t('an arm named like an object property joins', JSON.stringify(joinScores(proto, 'x,A,4\n').arms.constructor), '{"scores":[{"task":"x","score":4}]}');
t('a task named like an object property is not in the export', joinScores(proto, 'toString,A,4\n').left_out[0].why, 'task toString is not in the export');

t('no --tasks refuses', /--tasks is required/.test(run('export').stderr), true);
t('an unknown command refuses', run('score', '--tasks', 'x').status, 2);

if (fails) { console.log(`FAIL ${fails} check(s) failed`); process.exit(1); }
console.log('all bench blind checks passed');
