// Blind scoring for a bench run: each task's diffs exported under random letters for a 1 to 5 score,
// and the scores joined back to the arms only once they are all in.
//
//   node bench-blind.mjs export --tasks <file.json> [--out <dir>] [--dest <dir>] [--rubric <file>]
//   node bench-blind.mjs join   --tasks <file.json> [--out <dir>] [--dest <dir>]
//
// <out> is bench.mjs's output folder (bench-out beside the task set by default), and its run.json
// says which runs to export. <dest> defaults to <out>/blind. export writes there:
//   sheets/<task>.md  the ticket text, the rubric and every arm's diff under a letter, letters drawn
//                     at random per task; an arm with no diff, or a failed run, shows as "no change produced"
//   scores.csv        task,letter,score with the score blank, one row per diff to score
//   key.json          letter -> arm per task. No sheet names it; open it only to join
// Names of models, arms and efforts in a diff are replaced with [redacted]. An arm name shorter than
// three characters is replaced only after "arm", since it would otherwise hit ordinary words.
// join reads scores.csv through key.json, writes joined.json (each arm's scores) and lists
// each sheet left out for a missing, out-of-range or unknown score; none of a left-out sheet's
// scores count.
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTasks } from './skill-eval.mjs';

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
const USAGE = 'usage: bench-blind.mjs export|join --tasks <file.json> [--out <dir>] [--dest <dir>] [--rubric <file>]';
export const PLACEHOLDER = '[redacted]';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LEVELS = 'low|medium|high|xhigh|max';
const FAMILY = /(?<![A-Za-z0-9])(?:claude[-_ ]?)?(?:opus|sonnet|haiku|fable)(?:[-_ ]?\d+(?:[.-]\d+)*)?(?![A-Za-z0-9])/gi;

// argv -> { cmd, tasks, out, dest, rubric }. Throws, naming the flag, on anything missing.
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'export' && cmd !== 'join') throw new Error(USAGE);
  const names = { '--tasks': 'tasks', '--out': 'out', '--dest': 'dest', ...(cmd === 'export' ? { '--rubric': 'rubric' } : {}) };
  const o = { cmd };
  for (let i = 0; i < rest.length; i++) {
    const key = names[rest[i]];
    if (!key) throw new Error(`unknown argument ${rest[i]}\n${USAGE}`);
    if (i + 1 >= rest.length) throw new Error(`${rest[i]} needs a value`);
    o[key] = rest[++i];
  }
  if (!o.tasks) throw new Error(`--tasks is required\n${USAGE}`);
  o.out = resolve(o.out || join(dirname(resolve(o.tasks)), 'bench-out'));
  o.dest = resolve(o.dest || join(o.out, 'blind'));
  o.rubric = resolve(o.rubric || join(HERE, 'bench-rubric.md'));
  return o;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (s) => `(?<![A-Za-z0-9])${esc(s)}(?![A-Za-z0-9])`;

// A diff with every name that could tell its arm replaced: co-author trailers, model family names,
// and each arm's own name, model and effort. The arms' names go before the model families, so a
// family inside one (opus-high) cannot leave the rest of it showing.
export function scrub(text, arms) {
  let s = text.replace(/(co-authored-by:)[^\n]*/gi, `$1 ${PLACEHOLDER}`);
  const names = [...new Set(arms.flatMap((a) => [a.name, a.model]).filter((n) => n && n.length >= 3))]
    .sort((a, b) => b.length - a.length);
  for (const n of names) s = s.replace(new RegExp(word(n), 'gi'), PLACEHOLDER);
  for (const n of new Set(arms.map((a) => a.name).filter(Boolean))) s = s.replace(new RegExp(`(\\barm[-_ :]*)${esc(n)}(?![A-Za-z0-9])`, 'gi'), `$1${PLACEHOLDER}`);
  s = s.replace(FAMILY, PLACEHOLDER);
  const levels = [...new Set([...LEVELS.split('|'), ...arms.map((a) => a.effort).filter(Boolean)])].map(esc).join('|');
  return s.replace(new RegExp(`(\\beffort["']?\\s*[:=]?\\s*["']?)(?:${levels})(?![A-Za-z0-9])`, 'gi'), `$1${PLACEHOLDER}`)
    .replace(new RegExp(`(?<![A-Za-z0-9])(?:${levels})([-_ ]effort\\b)`, 'gi'), `${PLACEHOLDER}$1`);
}

// A fence longer than any run of backticks in the text, so a diff holding one cannot close it early.
const fence = (text) => '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((m) => m.length + 1)));
const block = (text, lang) => { const f = fence(text); return `${f}${lang}\n${text.replace(/\n?$/, '\n')}${f}`; };

function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const readJson = (file, what) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`cannot read ${what} ${file}: ${e.message}`); }
};

// Each run run.json lists, with its arm's settings from result.json and its diff, if it made one. A
// failed run (out of budget, timed out, never scored) keeps the diff it got to, but made no change.
function loadRuns(out) {
  const run = readJson(join(out, 'run.json'), 'the bench run');
  return (run.tasks ?? []).map((t) => ({
    task: t.task,
    runs: t.runs.map((r) => {
      const result = r.dir && existsSync(join(r.dir, 'result.json')) ? readJson(join(r.dir, 'result.json'), 'a run result') : {};
      const failed = (result.status ?? r.status) === 'failed';
      const patch = !failed && r.dir && existsSync(join(r.dir, 'diff.patch')) ? readFileSync(join(r.dir, 'diff.patch'), 'utf8') : '';
      return { arm: r.arm, model: result.model ?? null, effort: result.effort ?? null, diff: patch.trim() ? patch : null };
    }),
  }));
}

function sheet(id, prompt, rubric, entries) {
  const parts = [`# ${id}`, '',
    'Score each change from 1 to 5 against the rubric, in its row of scores.csv. A change marked "no change produced" takes no score.', '',
    '## Ticket', '', block(prompt, 'text'), '', '## Rubric', '', rubric.trim(), ''];
  for (const e of entries) parts.push(`## Change ${e.letter}`, '', e.diff ? block(e.diff, 'diff') : 'No change produced.', '');
  return parts.join('\n');
}

// Writes the sheets, the scores template and the key. -> { dest, sheets, rows }
export function exportBlind(o) {
  const tasks = new Map(readTasks(o.tasks, () => {}).map((t) => [t.id, t]));
  if (existsSync(join(o.dest, 'key.json'))) throw new Error(`an export is already at ${o.dest}: its scores would no longer match. Use another --dest`);
  let rubric;
  try { rubric = readFileSync(o.rubric, 'utf8'); } catch (e) { throw new Error(`cannot read the rubric ${o.rubric}: ${e.message}`); }
  if (!rubric.trim()) throw new Error(`the rubric ${o.rubric} is empty`);
  const runs = loadRuns(o.out);
  const arms = runs.flatMap((t) => t.runs.map((r) => ({ name: r.arm, model: r.model, effort: r.effort })));
  mkdirSync(join(o.dest, 'sheets'), { recursive: true });
  const key = { tasks: {} };
  const rows = ['task,letter,score'];
  for (const t of runs) {
    const task = tasks.get(t.task);
    if (!task) throw new Error(`run.json has task ${t.task}, which ${o.tasks} does not`);
    if (t.runs.length > LETTERS.length) throw new Error(`task ${t.task} has more than ${LETTERS.length} arms`);
    const entries = shuffle(t.runs).map((r, i) => ({ ...r, letter: LETTERS[i], diff: r.diff && scrub(r.diff, arms) }));
    writeFileSync(join(o.dest, 'sheets', `${t.task}.md`), sheet(t.task, task.prompt, rubric, entries));
    key.tasks[t.task] = Object.fromEntries(entries.map((e) => [e.letter, { arm: e.arm, model: e.model, effort: e.effort, change: !!e.diff }]));
    for (const e of entries) if (e.diff) rows.push(`${t.task},${e.letter},`);
  }
  writeFileSync(join(o.dest, 'scores.csv'), `${rows.join('\n')}\n`);
  writeFileSync(join(o.dest, 'key.json'), `${JSON.stringify(key, null, 2)}\n`);
  return { dest: o.dest, sheets: runs.length, rows: rows.length - 1 };
}

// key + the scores.csv text -> { arms: {name: {scores: [{task, score}]}}, left_out: [{task, why}], no_change: [{task, arm}] }
export function joinScores(key, csv) {
  const given = new Map();
  const problems = new Map();
  const note = (task, why) => problems.set(task, [...(problems.get(task) ?? []), why]);
  for (const [n, line] of csv.split(/\r?\n/).entries()) {
    if (!line.trim() || (n === 0 && /^\s*task\s*,/i.test(line))) continue;
    const [task, letter, score, ...extra] = line.split(',').map((x) => x.trim());
    if (letter == null || extra.length) { note(task || `line ${n + 1}`, `line ${n + 1} is not task,letter,score`); continue; }
    const sheetKey = Object.hasOwn(key.tasks, task) ? key.tasks[task] : null;
    if (!sheetKey) { note(task, `task ${task} is not in the export`); continue; }
    if (!(Object.hasOwn(sheetKey, letter) && sheetKey[letter].change)) { note(task, `letter ${letter} has no change to score`); continue; }
    const scores = given.get(task) ?? new Map();
    if (scores.has(letter)) note(task, `letter ${letter} is scored twice`);
    scores.set(letter, score ?? '');
    given.set(task, scores);
  }
  const arms = Object.create(null);
  const noChange = [];
  for (const sheetKey of Object.values(key.tasks)) for (const e of Object.values(sheetKey)) arms[e.arm] ??= { scores: [] };
  for (const [task, sheetKey] of Object.entries(key.tasks)) {
    for (const [letter, e] of Object.entries(sheetKey)) {
      if (!e.change) { noChange.push({ task, arm: e.arm }); continue; }
      const s = given.get(task)?.get(letter);
      if (!s) note(task, `letter ${letter} has no score`);
      else if (!/^[1-5]$/.test(s)) note(task, `letter ${letter}'s score ${s} is not a whole number from 1 to 5`);
    }
    if (problems.has(task)) continue;
    for (const [letter, e] of Object.entries(sheetKey)) if (e.change) arms[e.arm].scores.push({ task, score: Number(given.get(task).get(letter)) });
  }
  return { arms, left_out: [...problems].map(([task, why]) => ({ task, why: why.join('; ') })), no_change: noChange };
}

export function joinBlind(o) {
  const key = readJson(join(o.dest, 'key.json'), 'the key');
  let csv;
  try { csv = readFileSync(join(o.dest, 'scores.csv'), 'utf8'); } catch (e) { throw new Error(`cannot read the scores ${join(o.dest, 'scores.csv')}: ${e.message}`); }
  const joined = joinScores(key, csv);
  const path = join(o.dest, 'joined.json');
  writeFileSync(path, `${JSON.stringify(joined, null, 2)}\n`);
  return { path, joined };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.cmd === 'export') {
      const r = exportBlind(o);
      console.log(`${r.sheets} sheet(s) in ${join(r.dest, 'sheets')}; score the ${r.rows} row(s) of ${join(r.dest, 'scores.csv')}`);
      console.log(`key: ${join(r.dest, 'key.json')} (do not open it until every score is in)`);
    } else {
      const { path, joined } = joinBlind(o);
      for (const [arm, a] of Object.entries(joined.arms)) console.log(`${arm}: ${a.scores.length} score(s)`);
      for (const l of joined.left_out) console.log(`left out ${l.task}: ${l.why}`);
      console.log(`joined: ${path}`);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
