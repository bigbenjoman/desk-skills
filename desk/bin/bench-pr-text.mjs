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
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { armEnv, armOrder, deskEnv, loadBenchTasks, makeCheckout, parseArgs as benchArgs, printBench, readRepo, runClaude, shq } from './bench.mjs';
import { mergedDiff } from './bench-arm1.mjs';
import { loadRun, parseArgs as reportArgs, NOT_SCORED } from './bench-report.mjs';
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

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_|[._-](test|spec)\.[a-z]+$/i;
const bullets = (list) => list.map((x) => `- ${x}`).join('\n');
const paths = (files) => files.map((f) => f.split('\t').pop());

// What goes under one template heading, by what the heading asks for.
function fillFor(heading, { ticket, commits, files }) {
  const h = heading.toLowerCase();
  if (/\bfiles?\b/.test(h)) return bullets(paths(files)) || 'No files changed.';
  if (/\b(commits?|changes?|changelog)\b/.test(h)) return bullets(commits) || 'No commits recorded.';
  if (/\b(tests?|testing|verif\w*|evidence|qa)\b/.test(h)) {
    const tests = paths(files).filter((p) => TEST_PATH.test(p));
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
export function checkDescription(repo, items, wt, file, dir, timeout = CHECK_TIMEOUT_MS) {
  const runs = [], log = [];
  let status = 'passed';
  for (const { dir: d, cmd } of items) {
    const r = runItem({ bin: HERE, root: wt, dir: d, cmd: `${cmd} ${shq(file)}`, lock: 'nolock', prefix: repo.prefix, env: armEnv(), timeout });
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

const noMerge = (t) => typeof t.merge !== 'string' || !/^[0-9a-f]{40}$/.test(t.merge);

// Writes every side of every task and run.json. -> printBench's shape
export function runPrText(opts, log = () => {}) {
  const settings = Q.quotaSettings();
  const ledger = Q.ledgerPath();
  log(Q.settingsLine(settings));
  const all = loadBenchTasks(opts.tasks);
  const leftOut = all.filter(noMerge).map((t) => ({ task: t.id, why: 'the task records no merge commit' }));
  const repos = new Map();
  const out = outDir(opts);
  mkdirSync(join(out, 'runs'), { recursive: true });
  const budget = Number(opts.budget), total = Number(opts.total);
  let spent = 0, stopped = null;
  const points = new Map();
  const report = [];
  for (const task of all.filter((t) => !noMerge(t))) {
    if (!repos.has(task.repo)) {
      const repo = readRepo(task.repo);
      repo.checks = deskEnv(repo, 'cmds', 'pr-description-checks').split('\n').filter(Boolean).map((l) => { const [dir, cmd] = l.split('\t'); return { dir, cmd }; });
      repos.set(task.repo, repo);
    }
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
        if (prior) { log(`reuse ${task.id} (${side.name})`); return { arm: side.name, status: prior.status, reused: true, quota_points: prior.quota?.points ?? null, dir }; }
        const result = { task: task.id, arm: side.name, repo: task.repo, base: task.base, merge: task.merge, model: side.model, effort: side.effort, status: 'failed', why: null,
          cost: null, tokens: null, ran_at: null, template: inputs.template.source, diff_truncated: side.model ? truncated : false, check: null, at: new Date().toISOString() };
        let body = null, account = null, start = null;
        const env = armEnv();
        if (side.model) {
          if (stopped) return { arm: side.name, status: 'not run', why: stopped, dir: null };
          if (spent + budget > total + 1e-9) { log(`skip ${task.id} (${side.name}): $${spent.toFixed(2)} of $${total} spent`); return { arm: side.name, status: 'not run', dir: null }; }
          account = Q.accountFor('claude', env);
          start = Q.startRun({ account, settings, ledger, env, id: `${dir}@${result.at}`, fields: { task: task.id, arm: side.name } });
          points.set(account.key, start.line);
          if (start.why) {
            stopped = `stopped: ${start.why}`;
            log(`stopped before ${task.id} (${side.name}): ${start.why}`);
            return { arm: side.name, status: 'not run', why: stopped, dir: null };
          }
        }
        mkdirSync(dir, { recursive: true });
        log(`write ${task.id} (${side.name})`);
        try {
          if (side.model) {
            const run = runModel(task, side, prompt, opts, dir, env);
            spent += run.cost ?? budget;
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
        if (side.model) {
          const end = Q.endRun({ account, settings, ledger, env, before: start.before, entry: start.entry, label: `${task.id} (${side.name})` });
          result.quota = end.quota;
          if (end.stop) stopped = `stopped: ${end.stop}`; else points.set(account.key, end.line);
        }
        writeFileSync(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
        log(`  ${result.status}${result.why ? `: ${result.why}` : ''}${result.check ? `, checks ${result.check.status}` : ''}`);
        return { arm: side.name, status: result.status, why: result.why, quota_points: result.quota?.points ?? null, dir };
      });
      report.push({ task: task.id, order: order.map((a) => a.name), runs });
    } finally {
      if (parent) rmSync(parent, { recursive: true, force: true });
    }
  }
  const quota = { cap: settings.cap, reserve: settings.reserve, defaults: settings.defaults, stopped, accounts: [...points.values()] };
  const path = join(out, 'run.json');
  writeFileSync(path, `${JSON.stringify({ seed: opts.seed, spent, quota, tasks: report, blind: BLIND, ...(leftOut.length ? { left_out: leftOut } : {}) }, null, 2)}\n`);
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
    score: list.length ? { mean: list.reduce((s, x) => s + x.score, 0) / list.length, n: list.length } : null,
    input: median(tokens.map((t) => ['uncached', 'cacheWrite', 'cacheRead'].reduce((s, k) => s + (Number(t[k]) || 0), 0))),
    output: median(tokens.map((t) => Number(t.output) || 0)),
    points: median(written.map((r) => r.result?.quota?.points).filter((p) => typeof p === 'number')),
  };
}

const num = (n) => Math.round(n).toLocaleString('en-US');

// The check cell. "no checks configured" is never a pass or a fail.
export function checkCell(f) {
  if (!f.written) return 'no description written';
  if (!f.checked) return f.noChecks ? NO_CHECKS : `${f.unfinished} did not finish`;
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
  const file = join(o.blind, 'joined.json');
  let joined = null;
  if (existsSync(file)) { try { joined = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`cannot read the joined scores ${file}: ${e.message}`); } }
  const { text } = renderPrTextReport({ out: o.out, run, joined });
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
