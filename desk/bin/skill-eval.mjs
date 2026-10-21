// Runs a task set twice per task, once with a skill loaded and once without it, scores each run
// against the task's pass/fail checks, and writes a side-by-side report ending in one verdict:
// keep (the skill arm passed more checks), trim (the same number) or drop (fewer).
//
//   node skill-eval.mjs --skill <name|dir> --tasks <file.json> --max-budget-usd <usd>
//                       [--skills-dir <dir>] [--out <dir>] [--timeout <seconds>] [--model <model>]
//
// The task set is JSON: {"tasks": [{"id", "prompt", "checks": [{"name", <one of contains | absent |
// matches>: "<text or regex>"}]}]}. Checks read the run's final reply. Both arms run `claude -p` with
// no setting sources, so the user's installed skills reach neither; the skill arm alone gets the
// skill's SKILL.md appended to its system prompt and its directory readable. --max-budget-usd is
// each run's ceiling, handed to claude. A run that errors, exceeds its budget or times out is failed
// for that arm and counts neither as a pass nor as a fail.
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARMS = Object.freeze(['skill', 'base']);
const CHECK_KINDS = Object.freeze(['contains', 'absent', 'matches']);
const USAGE = 'usage: skill-eval.mjs --skill <name|dir> --tasks <file.json> --max-budget-usd <usd> [--skills-dir <dir>] [--out <dir>] [--timeout <seconds>] [--model <model>]';

// argv -> options. Throws, naming the flag, on anything missing or malformed; the budget is checked
// first so no run can start without one.
export function parseArgs(argv) {
  const o = { skillsDir: 'skills', timeout: 600 };
  const names = { '--skill': 'skill', '--tasks': 'tasks', '--max-budget-usd': 'budget', '--skills-dir': 'skillsDir', '--out': 'out', '--timeout': 'timeout', '--model': 'model' };
  for (let i = 0; i < argv.length; i++) {
    const key = names[argv[i]];
    if (!key) throw new Error(`unknown argument ${argv[i]}\n${USAGE}`);
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
    o[key] = argv[++i];
  }
  if (o.budget == null) throw new Error('refusing to start: --max-budget-usd <usd> is required (the spend ceiling for each claude run)');
  if (!/^\d+(\.\d+)?$/.test(o.budget) || !(Number(o.budget) > 0)) throw new Error(`--max-budget-usd must be a positive number of USD, not ${o.budget}`);
  if (!o.skill) throw new Error(`--skill is required\n${USAGE}`);
  if (!o.tasks) throw new Error(`--tasks is required\n${USAGE}`);
  if (!/^\d+$/.test(String(o.timeout)) || !(Number(o.timeout) > 0)) throw new Error(`--timeout must be a positive number of seconds, not ${o.timeout}`);
  o.timeout = Number(o.timeout);
  return o;
}

// A skill directory (one holding SKILL.md) given directly, or <skillsDir>/<name>.
export function resolveSkill(skill, skillsDir) {
  const dir = existsSync(join(skill, 'SKILL.md')) ? skill : join(skillsDir, skill);
  if (!existsSync(join(dir, 'SKILL.md'))) throw new Error(`no SKILL.md for skill ${skill} (looked in ${skill} and ${dir})`);
  return { name: basename(resolve(dir)), dir: resolve(dir) };
}

// The task set, validated: unique file-safe ids, a prompt, and at least one check of a known kind.
export function loadTasks(file) {
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`cannot read task set ${file}: ${e.message}`); }
  const tasks = data?.tasks;
  if (!Array.isArray(tasks) || !tasks.length) throw new Error(`task set ${file} has no "tasks" array`);
  const seen = new Set();
  for (const t of tasks) {
    if (typeof t?.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t.id)) throw new Error(`task id ${JSON.stringify(t?.id)} must be letters, digits, ., _ or -`);
    if (seen.has(t.id)) throw new Error(`task id ${t.id} appears twice`);
    seen.add(t.id);
    if (typeof t.prompt !== 'string' || !t.prompt.trim()) throw new Error(`task ${t.id} has no prompt`);
    if (!Array.isArray(t.checks) || !t.checks.length) throw new Error(`task ${t.id} has no checks`);
    for (const c of t.checks) {
      const kinds = CHECK_KINDS.filter((k) => typeof c?.[k] === 'string');
      if (typeof c?.name !== 'string' || kinds.length !== 1) throw new Error(`task ${t.id}: each check needs a name and exactly one of ${CHECK_KINDS.join(', ')}`);
      if (kinds[0] === 'matches') {
        try { new RegExp(c.matches); } catch (e) { throw new Error(`task ${t.id} check ${c.name}: ${e.message}`); }
      }
    }
  }
  return tasks;
}

// Whether one check passes against a reply.
export function checkPasses(check, reply) {
  if (typeof check.contains === 'string') return reply.includes(check.contains);
  if (typeof check.absent === 'string') return !reply.includes(check.absent);
  return new RegExp(check.matches).test(reply);
}

// One finished claude process -> {ok, reply, why}. Anything other than a successful JSON
// result is failed, with the reason.
export function readRun({ status, signal, error, stdout }, timeout) {
  if (error?.code === 'ETIMEDOUT') return { ok: false, why: `timed out after ${timeout}s` };
  if (error) return { ok: false, why: `could not run claude: ${error.message}` };
  if (signal) return { ok: false, why: `killed by ${signal}` };
  let r;
  try { r = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { r = null; }
  if (status !== 0) return { ok: false, why: `claude exited ${status}${r?.subtype ? ` (${r.subtype})` : ''}` };
  if (!r || typeof r.result !== 'string') return { ok: false, why: 'claude printed no result' };
  if (r.is_error || (r.subtype && r.subtype !== 'success')) return { ok: false, why: `claude reported ${r.subtype || 'an error'}` };
  return { ok: true, reply: r.result };
}

// The claude arguments for one arm. The base arm differs only by not having the skill.
export function claudeArgs({ prompt, arm, skill, budget, model }) {
  const args = ['-p', prompt, '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config',
    '--permission-mode', 'dontAsk', '--max-budget-usd', String(budget)];
  if (model) args.push('--model', model);
  if (arm === 'skill') {
    const body = readFileSync(join(skill.dir, 'SKILL.md'), 'utf8');
    args.push('--add-dir', skill.dir, '--append-system-prompt',
      `The ${skill.name} skill is loaded. Its SKILL.md follows; files it refers to are under ${skill.dir}.\n\n${body}`);
  }
  return args;
}

// Per arm: checks passed and failed over the runs that finished, and the runs that failed.
export function totals(results) {
  const t = Object.fromEntries(ARMS.map((a) => [a, { passed: 0, failed: 0, runsFailed: 0 }]));
  for (const r of results) {
    for (const a of ARMS) {
      const run = r[a];
      if (!run.ok) { t[a].runsFailed++; continue; }
      for (const pass of run.checks) pass ? t[a].passed++ : t[a].failed++;
    }
  }
  return t;
}

export function verdict(t) {
  if (t.skill.passed > t.base.passed) return 'keep';
  if (t.skill.passed < t.base.passed) return 'drop';
  return 'trim';
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

// The markdown report. Transcript links are relative to the report's directory.
export function renderReport({ skill, tasksFile, tasks, results, budget, timeout }) {
  const t = totals(results);
  const v = verdict(t);
  const head = (a) => (a === 'skill' ? `With ${skill.name}` : 'Without');
  const out = [`# Skill eval: ${skill.name}`, '',
    `Task set \`${tasksFile}\` · ${tasks.length} task${tasks.length === 1 ? '' : 's'} · $${budget} ceiling per run · ${timeout}s timeout per run`, ''];
  tasks.forEach((task, i) => {
    const r = results[i];
    out.push(`## ${task.id}`, '', `| Check | ${head('skill')} | ${head('base')} |`, '|---|---|---|');
    task.checks.forEach((c, j) => {
      const res = ARMS.map((a) => (r[a].ok ? (r[a].checks[j] ? 'pass' : 'fail') : '—'));
      out.push(`| ${cell(c.name)} | ${res.join(' | ')} |`);
    });
    const runCell = (a) => (r[a].ok ? `ok ([transcript](${r[a].transcript}))` : `failed: ${cell(r[a].why)} ([transcript](${r[a].transcript}))`);
    out.push(`| run | ${runCell('skill')} | ${runCell('base')} |`, '');
  });
  out.push('## Totals', '', `| | ${head('skill')} | ${head('base')} |`, '|---|---|---|',
    `| Checks passed | ${t.skill.passed} | ${t.base.passed} |`,
    `| Checks failed | ${t.skill.failed} | ${t.base.failed} |`,
    `| Runs failed (not counted) | ${t.skill.runsFailed} | ${t.base.runsFailed} |`, '');
  out.push('## Verdict', '');
  if (t.skill.runsFailed || t.base.runsFailed) {
    out.push(`${t.skill.runsFailed + t.base.runsFailed} run(s) failed and are not counted, so this verdict rests on the runs that finished.`, '');
  }
  if (v === 'trim') {
    out.push('Both arms passed the same number of checks. Read the transcripts for prose the model follows without the skill:', '');
    tasks.forEach((task, i) => out.push(`- ${task.id}: [with](${results[i].skill.transcript}) · [without](${results[i].base.transcript})`));
    out.push('');
  }
  const why = { keep: 'the skill arm passed more checks', trim: 'both arms passed the same number of checks', drop: 'the skill arm passed fewer checks' }[v];
  out.push(`Verdict: ${skill.name}: **${v}** (${why}: ${t.skill.passed} with, ${t.base.passed} without)`);
  return { text: `${out.join('\n')}\n`, verdict: v, totals: t };
}

// Runs every task in both arms, writes transcripts and report.md under opts.out, returns the report.
export function runEval(opts, log = () => {}) {
  const skill = resolveSkill(opts.skill, opts.skillsDir);
  const tasks = loadTasks(opts.tasks);
  const out = resolve(opts.out || `skill-eval-${skill.name}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}`);
  mkdirSync(join(out, 'transcripts'), { recursive: true });
  const results = tasks.map((task) => {
    const r = {};
    for (const arm of ARMS) {
      // A fresh empty directory per run, so neither arm reads this repo or the other arm's output.
      const cwd = join(out, 'work', `${task.id}.${arm}`);
      mkdirSync(cwd, { recursive: true });
      log(`run ${task.id} (${arm})`);
      const proc = spawnSync('claude', claudeArgs({ prompt: task.prompt, arm, skill, budget: opts.budget, model: opts.model }), {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeout * 1000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
      });
      const transcript = join('transcripts', `${task.id}.${arm}.json`);
      writeFileSync(join(out, transcript), `${proc.stdout || ''}${proc.stderr ? `\n--- stderr ---\n${proc.stderr}` : ''}`);
      const run = readRun(proc, opts.timeout);
      r[arm] = { ...run, transcript, checks: run.ok ? task.checks.map((c) => checkPasses(c, run.reply)) : [] };
    }
    return r;
  });
  const report = renderReport({ skill, tasksFile: opts.tasks, tasks, results, budget: opts.budget, timeout: opts.timeout });
  writeFileSync(join(out, 'report.md'), report.text);
  return { ...report, path: join(out, 'report.md') };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const r = runEval(opts, (m) => console.error(m));
    console.log(`report: ${r.path}`);
    console.log(`verdict: ${r.verdict}`);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
