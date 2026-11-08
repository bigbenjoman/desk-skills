// Arm 4: each frozen task's PR description written three ways from the same inputs: on Opus, on Haiku,
// and filled from the repo's PR template with no model call.
//
//   node bench-pr-text.mjs --tasks <file.json> --max-budget-usd <usd> [--total-budget-usd <usd>]
//                          [--out <dir>] [--timeout <seconds>] [--seed <n>]
//   node bench-pr-text.mjs report --tasks <file.json> [--out <dir>] [--blind <dir>]
//
// The inputs are the ticket text, the commit subjects and changed files from the task's base to its
// merge, the merged diff (Opus and Haiku only, cut to fit one command line) and the repo's PR template
// at the base. A repo with no template gets desk-pr's sections. A task with no merge commit is left out.
//
// <out> defaults to bench-pr-text-out beside the task set, apart from the code arms' results. Each side
// leaves <out>/runs/<task>.<side>.<key>/description.md and result.json. A model side has no tools and
// runs in an empty folder. A model side's account goes through the bench's quota guard, and its USD
// through --total-budget-usd; the no-model side spends neither and still runs once they stop.
//
// Each description goes through the repo's §4 PR-description checks, each given the description's path
// in a checkout at the base, as desk-pr runs them. The result is passed, failed, "did not finish", or
// "no checks configured", which is not a pass.
//
// Blind scoring is bench-blind.mjs with --out <out>; run.json tells it to show descriptions and which
// rubric to use. `report` writes <out>/report.md; bench-report.mjs is for the code arms.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { armEnv, armOrder, cmdItems, loadBenchTasks, makeCheckout, parseArgs as benchArgs, printBench, readRepo, runClaude, shq, spendGuard } from './bench.mjs';
import { mergedDiff, noMerge } from './bench-arm1.mjs';
import { testFiles } from './bench-build.mjs';
import { allInput, loadRun, meanScore, num, parseArgs as reportArgs, readJoined, NOT_SCORED } from './bench-report.mjs';
import { runItem } from './baseline.mjs';
import { quantile } from './desk-ci.mjs';
import * as Q from './bench-quota.mjs';

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
export const NO_MODEL = 'no-model';
export const SIDES = Object.freeze([
  { name: 'opus', model: 'opus', effort: 'medium' },
  { name: 'haiku', model: 'haiku', effort: null },
  { name: NO_MODEL, model: null, effort: null },
]);
export const NO_CHECKS = 'no checks configured';
export const BLIND = Object.freeze({ file: 'description.md', noun: 'description', lang: 'markdown', rubric: 'bench-pr-text-rubric.md' });
export const DESK_TEMPLATE = '### Summary\n\n### Changes\n\n### Testing\n';
// One command-line argument must stay under Linux's 128 KiB limit on a single string.
export const MAX_PROMPT = 120000;
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const NO_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit'];
const OUT_DIR = 'bench-pr-text-out';

// argv -> bench.mjs's options with the two model sides for its checks, and all three sides to run.
export function parseArgs(argv) {
  if (argv.includes('--arm')) throw new Error('bench-pr-text.mjs sets its own sides: opus, haiku and no-model');
  const o = benchArgs([...argv, '--arm', 'opus=opus:medium', '--arm', 'haiku=haiku']);
  return { ...o, arms: SIDES.map((s) => ({ ...s })) };
}

export const outDir = (o) => resolve(o.out || join(dirname(resolve(o.tasks)), OUT_DIR));

const gitOut = (root, ...args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: armEnv() });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed in ${root}: ${(r.stderr || '').trim()}`);
  return r.stdout;
};

// The repo's PR template in GitHub's order of precedence. -> { source, text }
export function findTemplate(root, base) {
  const paths = gitOut(root, 'ls-tree', '-r', '--name-only', base).split('\n');
  for (const dir of ['.github/', '', 'docs/']) {
    const hit = paths.find((p) => p.toLowerCase() === `${dir}pull_request_template.md`);
    if (hit) return { source: hit, text: gitOut(root, 'show', `${base}:${hit}`) };
  }
  return { source: 'desk-pr sections', text: DESK_TEMPLATE };
}

// Everything a side writes from. -> { ticket, commits: [subject], files: ['M\tpath'], diff, template }
export function taskInputs(root, task) {
  const range = `${task.base}..${task.merge}`;
  const lines = (s) => s.split('\n').filter(Boolean);
  return { ticket: task.prompt.trim(), commits: lines(gitOut(root, 'log', '--no-merges', '--format=%s', range)),
    files: lines(gitOut(root, 'diff', '--name-status', task.base, task.merge)), diff: mergedDiff(root, task), template: findTemplate(root, task.base) };
}

// The model sides' prompt, the same for both. -> { prompt, truncated }
export function promptFrom({ ticket, commits, files, diff, template }) {
  const parts = (d) => ['Write the pull request description for this merged change. Reply with the description alone, in markdown: no title, no preamble. Fill every section of the template below, and say only what these inputs support.',
    '## Template', template.text.trim(), '## Ticket', ticket, '## Commits', commits.join('\n') || '(none)', '## Changed files', files.join('\n') || '(none)', '## Diff', d].join('\n\n');
  const room = Math.max(0, MAX_PROMPT - Buffer.byteLength(parts('')));
  const bytes = Buffer.from(diff);
  if (bytes.length <= room) return { prompt: parts(diff), truncated: false };
  return { prompt: parts(`${bytes.subarray(0, room).toString().replace(/�+$/, '')}\n[diff cut here to fit]`), truncated: true };
}

const bullets = (list) => list.map((x) => `- ${x}`).join('\n');
const paths = (files) => files.map((f) => f.split('\t').pop());

// What goes under one template heading, by what the heading asks for.
function fillFor(heading, { ticket, commits, files }) {
  const h = heading.toLowerCase();
  if (/\bfiles?\b/.test(h)) return bullets(paths(files)) || 'No files changed.';
  if (/\b(commits?|changes?|changelog)\b/.test(h)) return bullets(commits) || 'No commits recorded.';
  if (/\b(tests?|testing|verif\w*|evidence|qa)\b/.test(h)) {
    const tests = testFiles(paths(files)).files;
    return tests.length ? `Test files changed:\n${bullets(tests)}` : 'No test files changed.';
  }
  if (/\b(tickets?|issues?|jira|links?|refs?|references?|related)\b/.test(h)) return ticket.split('\n').find((l) => l.trim()) ?? 'Not recorded.';
  if (/\b(summary|what|why|description|overview|context|motivation|background|purpose)\b/.test(h)) return ticket;
  return 'Not recorded.';
}

// The template filled from the ticket, the commits and the changed files, with no model. Comments go,
// headings and checklist lines stay, and any other guidance text under a heading is replaced.
export function fillTemplate(inputs) {
  const text = inputs.template.text.replace(/<!--[\s\S]*?-->/g, '');
  const sections = [{ heading: null, body: [] }];
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s/.test(line)) sections.push({ heading: line.trim(), body: [] });
    else sections.at(-1).body.push(line);
  }
  const lead = sections[0].body.join('\n').trim();
  if (sections.length === 1) return fillTemplate({ ...inputs, template: { text: `${lead}\n\n${DESK_TEMPLATE}` } });
  const out = lead ? [lead] : [];
  for (const s of sections.slice(1)) {
    const checks = s.body.filter((l) => /^\s*[-*] \[[ xX]\]/.test(l));
    out.push(s.heading, fillFor(s.heading, inputs), ...(checks.length ? [checks.join('\n')] : []));
  }
  return `${out.join('\n\n')}\n`;
}

// Runs each check item on one description in `wt`, writing check-output.log in `dir`.
//   -> { status: 'passed' | 'failed' | 'did not finish', runs: [{ cmd, code }] }
export function checkDescription(repo, items, wt, file, dir) {
  const runs = [], log = [];
  let status = 'passed';
  for (const { dir: d, cmd } of items) {
    const r = runItem({ bin: HERE, root: wt, dir: d, cmd: `${cmd} ${shq(file)}`, lock: 'nolock', prefix: repo.prefix, env: armEnv(), timeout: CHECK_TIMEOUT_MS });
    log.push(`$ ${cmd} <description>\n${r.out}\nexit ${r.code}\n`);
    runs.push({ cmd, code: r.stopped ? null : r.code });
    if (r.stopped) { status = 'did not finish'; break; }
    if (r.code !== 0) status = 'failed';
  }
  writeFileSync(join(dir, 'check-output.log'), log.join('\n'));
  return { status, runs };
}

// One model side, with no tools, in an empty folder. -> runClaude's verdict
function runModel(task, side, prompt, opts, dir, env) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'desk-bench-text-'));
  try {
    const cwd = join(parent, 'empty');
    mkdirSync(cwd);
    const settings = join(parent, 'settings.json');
    writeFileSync(settings, JSON.stringify({ permissions: { allow: [], deny: NO_TOOLS }, autoMemoryEnabled: false }));
    return runClaude({ ...task, prompt }, side, cwd, settings, opts, dir, { env });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

const key = (task, side, prompt, items) => createHash('sha256').update(JSON.stringify([task.base, task.merge, prompt, side.model, side.effort, items])).digest('hex').slice(0, 12);

function stored(file) {
  try { const r = JSON.parse(readFileSync(file, 'utf8')); return r.status === 'written' ? r : null; } catch { return null; }
}

// A row absent or unset (desk-env's exit 3) reads as `none` does: no checks configured.
function prChecks(repo) {
  try { return cmdItems(repo, 'pr-description-checks'); } catch (e) { if (e.exitCode === 3) return []; throw e; }
}

// Writes every side of every task and run.json. -> printBench's shape
export function runPrText(opts, log = () => {}) {
  const settings = Q.quotaSettings();
  log(Q.settingsLine(settings));
  const all = loadBenchTasks(opts.tasks);
  const leftOut = all.filter(noMerge).map((t) => ({ task: t.id, why: 'the task records no merge commit' }));
  const tasks = all.filter((t) => !noMerge(t));
  // Every repo is read first, so a bad one refuses the run before anything is spent.
  const repos = new Map();
  for (const t of tasks) if (!repos.has(t.repo)) { const repo = readRepo(t.repo); repo.checks = prChecks(repo); repos.set(t.repo, repo); }
  const out = outDir(opts);
  mkdirSync(join(out, 'runs'), { recursive: true });
  const guard = spendGuard({ settings, ledger: Q.ledgerPath(), budget: Number(opts.budget), total: Number(opts.total), log });
  const report = [];
  for (const task of tasks) {
    const repo = repos.get(task.repo);
    let inputs;
    try { inputs = taskInputs(repo.root, task); } catch (e) {
      leftOut.push({ task: task.id, why: `its inputs could not be read: ${e.message}` });
      log(`left out ${task.id}: ${e.message}`);
      continue;
    }
    const { prompt, truncated } = promptFrom(inputs);
    const order = armOrder(opts.arms, opts.seed, task.id);
    let wt = null, parent = null, checkoutWhy = null;
    const checkout = () => {
      if (wt || checkoutWhy) return wt;
      try {
        parent = mkdtempSync(join(realpathSync(tmpdir()), 'desk-bench-text-'));
        makeCheckout(repo, task, join(parent, 'checkout'));
        wt = join(parent, 'checkout');
      } catch (e) { checkoutWhy = e.message; }
      return wt;
    };
    const check = (file, dir) => {
      if (!repo.checks.length) return { status: NO_CHECKS, runs: [] };
      if (!checkout()) return { status: 'did not finish', runs: [], why: `no checkout to run the checks in: ${checkoutWhy}` };
      return checkDescription(repo, repo.checks, wt, file, dir);
    };
    try {
      const runs = order.map((side) => {
        const dir = join(out, 'runs', `${task.id}.${side.name}.${key(task, side, prompt, repo.checks)}`);
        const prior = stored(join(dir, 'result.json'));
        if (prior?.check?.status === 'did not finish') {
          log(`check again ${task.id} (${side.name})`);
          try {
            prior.check = check(join(dir, BLIND.file), dir);
            writeFileSync(join(dir, 'result.json'), `${JSON.stringify(prior, null, 2)}\n`);
          } catch (e) { log(`  the check could not run: ${e.message}`); }
        }
        if (prior) { log(`reuse ${task.id} (${side.name})`); return { arm: side.name, status: prior.status, reused: true, quota_points: prior.quota?.points ?? null, dir }; }
        const result = { task: task.id, arm: side.name, repo: task.repo, base: task.base, merge: task.merge, model: side.model, effort: side.effort, status: 'failed', why: null,
          cost: null, tokens: null, ran_at: null, template: inputs.template.source, diff_truncated: side.model ? truncated : false, check: null, at: new Date().toISOString() };
        let body = null, paid = null, cost;
        if (side.model) {
          paid = guard.begin({ vendor: 'claude', env: armEnv(), id: `${dir}@${result.at}`, label: `${task.id} (${side.name})`, fields: { task: task.id, arm: side.name } });
          if (paid.notRun) return { arm: side.name, ...paid.notRun };
        }
        mkdirSync(dir, { recursive: true });
        log(`write ${task.id} (${side.name})`);
        try {
          if (side.model) {
            const run = runModel(task, side, prompt, opts, dir, paid.env);
            cost = run.cost;
            Object.assign(result, { cost: run.cost, tokens: run.tokens, ran_at: run.ranAt, why: run.why ?? null });
            if (run.ok && !String(run.reply ?? '').trim()) result.why = 'the model wrote no description';
            else if (run.ok) body = `${run.reply.trim()}\n`;
          } else body = fillTemplate(inputs);
          if (body) {
            const file = join(dir, BLIND.file);
            writeFileSync(file, body);
            result.status = 'written';
            result.check = check(file, dir);
          }
        } catch (e) { result.why = e.message; result.status = 'failed'; }
        if (paid) result.quota = guard.end(paid, cost);
        writeFileSync(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
        log(`  ${result.status}${result.why ? `: ${result.why}` : ''}${result.check ? `, checks ${result.check.status}` : ''}`);
        if (paid) guard.logStop(paid);
        return { arm: side.name, status: result.status, why: result.why, quota_points: result.quota?.points ?? null, dir };
      });
      report.push({ task: task.id, order: order.map((a) => a.name), runs });
    } finally {
      if (parent) rmSync(parent, { recursive: true, force: true });
    }
  }
  const quota = guard.quota();
  const path = join(out, 'run.json');
  writeFileSync(path, `${JSON.stringify({ seed: opts.seed, spent: guard.spent, quota, tasks: report, blind: BLIND, ...(leftOut.length ? { left_out: leftOut } : {}) }, null, 2)}\n`);
  return { path, report, quota, leftOut, armStops: [] };
}

// One side's figures. `scores` is joined.json's entry for the side, or null.
export function sideFigures(tasks, side, scores) {
  const runs = tasks.map((t) => ({ task: t.task, ...t.runs.find((r) => r.arm === side) })).filter((r) => r.status);
  const written = runs.filter((r) => r.status === 'written');
  const checks = written.map((r) => r.result?.check?.status);
  const median = (list) => quantile(list, 0.5);
  const tokens = written.map((r) => r.result?.tokens).filter(Boolean);
  const list = scores?.scores ?? [];
  return {
    side, ran: runs.filter((r) => r.status !== 'not run').map((r) => r.task), written: written.length,
    failed: runs.filter((r) => r.status === 'failed').length, notRun: runs.filter((r) => r.status === 'not run').length,
    passed: checks.filter((c) => c === 'passed').length, checked: checks.filter((c) => c === 'passed' || c === 'failed').length,
    noChecks: checks.filter((c) => c === NO_CHECKS).length, unfinished: checks.filter((c) => c === 'did not finish').length,
    score: meanScore(list),
    input: median(tokens.map(allInput)),
    output: median(tokens.map((t) => Number(t.output) || 0)),
    points: median(written.map((r) => r.result?.quota?.points).filter((p) => typeof p === 'number')),
  };
}

// The check cell. "no checks configured" is never a pass or a fail.
export function checkCell(f) {
  if (!f.written) return 'no description written';
  if (!f.checked && !f.unfinished) return NO_CHECKS;
  if (!f.checked) return `${f.unfinished} did not finish${f.noChecks ? ` (${f.noChecks} ${NO_CHECKS})` : ''}`;
  const more = [f.noChecks && `${f.noChecks} ${NO_CHECKS}`, f.unfinished && `${f.unfinished} did not finish`].filter(Boolean);
  return `${f.passed} of ${f.checked} passed${more.length ? ` (${more.join(', ')})` : ''}`;
}

// The markdown report. -> { text, figures }
export function renderPrTextReport({ out, run, joined }) {
  const figures = SIDES.map((s) => sideFigures(run.tasks, s.name, joined?.arms && Object.hasOwn(joined.arms, s.name) ? joined.arms[s.name] : null));
  const model = (f, v) => (f.side === NO_MODEL ? 'no model call' : v);
  const orNone = (v, show) => (v == null ? 'not recorded' : show(v));
  const rows = [
    ['Descriptions written, of tasks run', (f) => `${f.written} of ${f.ran.length}`],
    ['Runs failed', (f) => String(f.failed)],
    ['PR-description checks', checkCell],
    ['Mean blind score (1 to 5)', (f) => (f.score ? `${f.score.mean.toFixed(2)} (${f.score.n} scored)` : NOT_SCORED)],
    ['Median input tokens per description (all kinds)', (f) => model(f, orNone(f.input, num))],
    ['Median output tokens per description', (f) => model(f, orNone(f.output, num))],
    ['Median quota points per description', (f) => model(f, orNone(f.points, String))],
  ];
  const text = [`# PR text report: ${out}`, '', `${run.tasks.length} task(s) · sides ${SIDES.map((s) => s.name).join(', ')}${run.seed ? ` · seed ${run.seed}` : ''}`, ''];
  if (!joined) text.push(`Blind scores: ${NOT_SCORED}. Score the sheets \`bench-blind.mjs export --out ${out}\` wrote, then run \`bench-blind.mjs join\`.`, '');
  else if (joined.left_out?.length) text.push(`Blind scores: ${joined.left_out.length} sheet(s) left out, none of their scores counted: ${joined.left_out.map((l) => `${l.task} (${l.why})`).join('; ')}.`, '');
  if (run.leftOut?.length) text.push('## Left out', '', ...run.leftOut.map((l) => `- ${l.task}: ${l.why}`), '');
  if (figures.some((f) => f.ran.join('\n') !== figures[0].ran.join('\n'))) text.push(`The sides did not run the same tasks (${figures.map((f) => `${f.side} ran ${f.ran.length}`).join(', ')}), so read each column on its own.`, '');
  text.push(`| Figure | ${figures.map((f) => f.side).join(' | ')} |`, `|---|${figures.map(() => '---|').join('')}`);
  for (const [label, cell] of rows) text.push(`| ${label} | ${figures.map((f) => cell(f).replace(/\|/g, '\\|')).join(' | ')} |`);
  text.push('', 'Quota points are the rise in the account\'s weekly use during a run, other work on that account included.');
  return { text: `${text.join('\n')}\n`, figures };
}

// Reads the run and the scores, and writes <out>/report.md. -> { path, text }
export function writePrTextReport(o) {
  const run = loadRun(o.out);
  const { text } = renderPrTextReport({ out: o.out, run, joined: readJoined(o.blind) });
  const path = join(o.out, 'report.md');
  writeFileSync(path, text);
  return { path, text };
}

// `report`'s arguments, with this arm's output folder as the default.
export function parseReportArgs(argv) {
  const i = argv.indexOf('--tasks');
  return reportArgs(i < 0 || i + 1 >= argv.length ? argv : ['--out', outDir({ tasks: argv[i + 1] }), ...argv]);
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === 'report') {
      const { path, text } = writePrTextReport(parseReportArgs(argv.slice(1)));
      process.stdout.write(text);
      console.log(`report: ${path}`);
    } else printBench(runPrText(parseArgs(argv), (m) => console.error(m)));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
