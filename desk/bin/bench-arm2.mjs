// Arm 2: a shadow Codex review seat against the current Opus finder seat, each reviewing the same frozen
// diffs into which real, acted-on review findings have been put back. Nothing here touches a live review.
//
//   node bench-arm2.mjs seed --tasks <file.json> --findings <file.csv> [--seeds-dir <dir>] [--rewrite]
//   node bench-arm2.mjs --tasks <file.json> --max-budget-usd <usd> [--total-budget-usd <usd>] [--seeds-dir <dir>]
//                       [--out <dir>] [--timeout <seconds>] [--seed <n>]
//   node bench-arm2.mjs report --tasks <file.json> [--out <dir>]
//   node bench-arm2.mjs mark --tasks <file.json> [--out <dir>] <finding id> real|false-alarm
//
// `seed` reads a CSV with the columns repo, pr, file, line and acted_commit (others are kept with the
// finding; a row with no acted_commit was not acted on). For each frozen task it reverts, onto the task's
// merged tree, the hunk of the acting commit at the finding's file and line (the old side of the commit's
// default diff). <seeds-dir>/<task id>/ then holds seeded.patch (base to seeded tree) and seeds.json, with
// each seed's file, the line and end of its hunk in the seeded tree and the original finding, and each
// finding skipped with why. <seeds-dir> defaults to seeds beside the task set. A task already seeded is
// left as it is unless --rewrite is given.
//
// A run gives each seat its own throwaway checkout at the task's base with the seeded patch as one
// commit, and the same brief, written from desk-review's own files: the bar, the FINDING format and the
// cold finder's instruction. `current` is Opus with the Lena finder's prompt as system prompt. `codex`
// runs through codex-exec.mjs, as desk-codex's calls do, read-only, at the model and effort the task
// repo's config §3b Codex review gives the finder and at this command's --timeout. Its verdict is its
// captured last message. Neither seat is told about the seeds. Claude's settings refuse by name the task
// set, the seeds, the results and the primary checkout. Codex's read-only sandbox cannot refuse a read, so
// a Codex run whose tool calls name one of those paths is failed instead.
//
// A seat that times out, errors, or answers with neither FINDING blocks nor NO FINDINGS is failed: none of
// its findings are scored, and its task's seeds are not in its count. A finding inside a seeded hunk is
// a hit on that seed. Any other finding is listed in <out>/report.md with an id, for `mark`. It is counted
// as a real defect or a false alarm only once marked, in <out>/marks.json. <out> defaults to
// bench-arm2-out beside the task set, apart from the code arms' results.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { armEnv, armOrder, both, deskEnv, loadBenchTasks, makeCheckout, parseArgs as benchArgs, printBench, readRepo, runClaude, spendGuard, writeSettings } from './bench.mjs';
import { noMerge } from './bench-arm1.mjs';
import { runCodex } from './bench-arm3.mjs';
import { haveCommit } from './bench-build.mjs';
import { loadRun } from './bench-report.mjs';
import { parseCodexReview, skillsDir } from './desk-env.mjs';
import * as Q from './bench-quota.mjs';

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
export const CURRENT = 'current', CODEX = 'codex';
export const BRIEF_FILE = 'desk-review-brief.txt';
export const SEAT_PROMPT = `Read the review brief in ${BRIEF_FILE} and do exactly what it says. Answer only with FINDING blocks or NO FINDINGS, then its FILES READ line.`;
export const MARKS = Object.freeze(['real', 'false-alarm']);
const DIFF_COMMAND = 'git diff HEAD~1 HEAD';
const OUT_DIR = 'bench-arm2-out';
const CSV_COLUMNS = ['repo', 'pr', 'file', 'line', 'acted_commit'];
const BUFFER = 256 * 1024 * 1024;

export const outDir = (o) => resolve(o.out || join(dirname(resolve(o.tasks)), OUT_DIR));
export const seedsDir = (o) => resolve(o.seedsDir || join(dirname(resolve(o.tasks)), 'seeds'));

// The named flags of `argv`, the rest kept in order. -> { flags, rest }
function takeFlags(argv, names) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (!names.includes(argv[i])) { rest.push(argv[i]); continue; }
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
    flags[argv[i]] = argv[++i];
  }
  return { flags, rest };
}

const needTasks = (o) => { if (!o.tasks) throw new Error('--tasks is required'); return o; };
function noneLeft(rest) { if (rest.length) throw new Error(`unknown argument ${rest[0]}`); }

export function parseSeedArgs(argv) {
  const { flags, rest } = takeFlags(argv.filter((a) => a !== '--rewrite'), ['--tasks', '--findings', '--seeds-dir']);
  noneLeft(rest);
  if (!flags['--findings']) throw new Error('--findings is required');
  return needTasks({ tasks: flags['--tasks'], findings: flags['--findings'], seedsDir: flags['--seeds-dir'], rewrite: argv.includes('--rewrite') });
}

// argv -> bench.mjs's options, whose flag checks need arms to read. This arm's seats are its own.
export function parseArgs(argv) {
  if (argv.includes('--arm')) throw new Error(`bench-arm2.mjs sets its own seats: ${CURRENT} and ${CODEX}`);
  const { flags, rest } = takeFlags(argv, ['--seeds-dir']);
  return { ...benchArgs([...rest, '--arm', `${CURRENT}=opus`, '--arm', `${CODEX}=gpt-placeholder`]), seedsDir: flags['--seeds-dir'] };
}

export function parseReportArgs(argv) {
  const { flags, rest } = takeFlags(argv, ['--tasks', '--out']);
  if (!flags['--tasks'] && !flags['--out']) throw new Error('--tasks or --out is required');
  return { out: outDir({ tasks: flags['--tasks'], out: flags['--out'] }), rest };
}

// CSV text -> [{ column: value }], with quoted cells, doubled quotes and newlines inside quotes.
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const s = String(text).replace(/^﻿/, '');
  const endRow = () => { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') endRow(); else cell += c;
  }
  if (cell || row.length) endRow();
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  const names = (head ?? []).map((n) => n.trim());
  const missing = CSV_COLUMNS.filter((c) => !names.includes(c));
  if (missing.length) throw new Error(`the findings file has no ${missing.join(', ')} column`);
  return body.map((r) => Object.fromEntries(names.map((n, i) => [n, (r[i] ?? '').trim()])));
}

// The acted-on findings of one task's PR. A row's repo may be owner/name or the name alone.
export function rowsFor(task, rows) {
  const full = task.repo.toLowerCase(), name = full.split('/')[1];
  return rows.filter((r) => [full, name].includes(r.repo.toLowerCase()) && Number(r.pr) === task.pr && r.acted_commit);
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// One file's unified diff. -> { header, hunks: [{ text, oldStart, oldLen, newStart, newLen }] }
export function splitHunks(diff) {
  const header = [], hunks = [];
  for (const l of String(diff).replace(/\n$/, '').split('\n')) {
    const m = HUNK.exec(l);
    if (m) hunks.push({ text: l, oldStart: Number(m[1]), oldLen: Number(m[2] ?? 1), newStart: Number(m[3]), newLen: Number(m[4] ?? 1) });
    else if (hunks.length) hunks.at(-1).text += `\n${l}`;
    else header.push(l);
  }
  return { header: header.join('\n'), hunks };
}

export const hunkAt = (hunks, line) => hunks.find((h) => line >= h.oldStart && line < h.oldStart + Math.max(h.oldLen, 1));

// Reverts each row's hunk onto the task's merged tree, in a scratch index so no checkout is touched.
// `task.base` and `task.merge` must be in `root`. -> { seeds, skipped, patch }
export function seedTask(root, task, rows, { env = armEnv() } = {}) {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'desk-bench-seed-'));
  const gitEnv = { ...env, GIT_INDEX_FILE: join(scratch, 'index') };
  const run = (args, input) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: gitEnv, input, maxBuffer: BUFFER });
  const ok = (args) => { const r = run(args); if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || '').trim()}`); return r.stdout.trim(); };
  const seeds = [], skipped = [], planted = new Map();
  try {
    ok(['read-tree', task.merge]);
    let tree = ok(['write-tree']);
    for (const row of rows) {
      try {
        const line = Number(row.line);
        if (!row.file) throw new Error('it names no file');
        if (!Number.isInteger(line) || line < 1) throw new Error(`its line ${JSON.stringify(row.line)} is not a line number`);
        if (!/^[0-9a-f]{7,40}$/i.test(row.acted_commit)) throw new Error(`its acting commit ${JSON.stringify(row.acted_commit)} is not a commit SHA`);
        haveCommit(root, row.acted_commit);
        const commit = ok(['rev-parse', `${row.acted_commit}^{commit}`]);
        const d = run(['diff', '--no-color', '--no-ext-diff', '-U3', `${commit}^`, commit, '--', row.file]);
        if (d.status !== 0) throw new Error('its acting commit has no parent to revert against');
        const { header, hunks } = splitHunks(d.stdout);
        const hunk = hunkAt(hunks, line);
        if (!hunk) throw new Error(`its acting commit changes nothing at ${row.file}:${line}`);
        const key = `${commit}\0${row.file}\0${hunk.oldStart}`;
        if (planted.has(key)) throw new Error(`it is the same hunk as ${planted.get(key)}`);
        const applied = run(['apply', '--cached', '-R', '--whitespace=nowarn', '-'], `${header}\n${hunk.text}\n`);
        if (applied.status !== 0) throw new Error(`its acting commit does not revert cleanly onto the merged diff: ${(applied.stderr || '').trim().split('\n')[0]}`);
        const next = ok(['write-tree']);
        const changed = splitHunks(ok(['diff', '--no-color', '--no-ext-diff', '-U3', tree, next, '--', row.file])).hunks;
        const first = changed[0], last = changed.at(-1);
        const delta = changed.reduce((n, h) => n + h.newLen - h.oldLen, 0);
        for (const s of seeds) if (s.file === row.file && s.line >= last.oldStart + last.oldLen) { s.line += delta; s.end += delta; }
        tree = next;
        const id = `seed-${seeds.length + 1}`;
        planted.set(key, id);
        seeds.push({ id, file: row.file, line: first.newStart, end: last.newStart + Math.max(last.newLen, 1) - 1, commit, finding: row });
      } catch (e) { skipped.push({ finding: row, why: e.message }); }
    }
    const patch = seeds.length ? run(['diff', '--binary', '--no-color', '--no-ext-diff', task.base, tree]).stdout : '';
    return { seeds, skipped, patch };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Seeds every task the findings file covers. -> [{ task, planted, skipped, kept? }]
export function writeSeeds(o, log = () => {}) {
  const rows = parseCsv(readFileSync(o.findings, 'utf8'));
  const dir = seedsDir(o);
  const repos = new Map();
  const out = [];
  for (const task of loadBenchTasks(o.tasks)) {
    const file = join(dir, task.id, 'seeds.json');
    if (!o.rewrite && existsSync(file)) {
      const prior = JSON.parse(readFileSync(file, 'utf8'));
      log(`kept ${task.id}: already seeded`);
      out.push({ task: task.id, planted: prior.seeds.length, skipped: prior.skipped, kept: true });
      continue;
    }
    const own = rowsFor(task, rows);
    if (noMerge(task) || !own.length) { log(`${task.id}: ${noMerge(task) ? 'the task records no merge commit' : 'no acted-on finding'}, not seeded`); continue; }
    if (!repos.has(task.repo)) repos.set(task.repo, readRepo(task.repo));
    const { root } = repos.get(task.repo);
    for (const sha of [task.base, task.merge]) haveCommit(root, sha);
    const { seeds, skipped, patch } = seedTask(root, task, own);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(join(dirname(file), 'seeded.patch'), patch);
    writeFileSync(file, `${JSON.stringify({ task: task.id, merge: task.merge, findings_file: resolve(o.findings), seeds, skipped }, null, 2)}\n`);
    log(`${task.id}: ${seeds.length} planted, ${skipped.length} skipped`);
    out.push({ task: task.id, planted: seeds.length, skipped });
  }
  return out;
}

// What every seat's brief is built from, read from desk-review's own files. Throws when one has changed
// shape, before anything is spent.
export function reviewParts(dir = join(skillsDir(), 'desk-review')) {
  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const find = readFileSync(join(dir, 'references', 'phase-3-find.md'), 'utf8');
  const format = /```\n(FINDING\n[\s\S]*?)```/.exec(skill)?.[1];
  const argue = /((?:^> .*\n)*^> Argue[\s\S]*?)(?=^[^>])/m.exec(find)?.[1];
  if (!format) throw new Error(`no FINDING format in ${join(dir, 'SKILL.md')}`);
  if (!argue) throw new Error(`no cold finder instruction in ${join(dir, 'references', 'phase-3-find.md')}`);
  return { format: format.trim(), argue: argue.split('\n').map((l) => l.replace(/^> ?/, '')).join(' ').replace(/\s+/g, ' ').trim(), defaultBar: join(dir, 'references', 'review-bar.md') };
}

// The Lena finder's prompt, without its frontmatter: as installed, else as shipped beside this script.
export function lenaPrompt() {
  const file = [join(homedir(), '.claude', 'agents', 'lena-code-reviewer.md'), join(HERE, '..', '..', 'agents', 'lena-code-reviewer.md')].find(existsSync);
  if (!file) throw new Error('the Lena finder\'s prompt is not installed');
  return readFileSync(file, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

const optional = (repo, ...args) => { try { return deskEnv(repo, ...args); } catch { return ''; } };

// The bar a review of this checkout reads: the repo's §4 Review bar, else its own copy of the default, else
// the installed default.
export function reviewBar(repo, wt, parts) {
  const row = optional(repo, 'get', 'review-bar').trim();
  const file = [row && !/^(default|none)\b/i.test(row) ? join(wt, row) : null, join(wt, 'skills', 'desk-review', 'references', 'review-bar.md'), parts.defaultBar].find((f) => f && existsSync(f));
  if (!file) throw new Error(`no review bar: looked for ${parts.defaultBar}`);
  return readFileSync(file, 'utf8').trim();
}

// The one brief both seats read.
export function seatBrief({ bar, asks, files, instructions, intent, parts }) {
  return [
    'Read-only. No Edit, no Write, no git state changes, no `gh pr review`, no `gh run rerun`; fixes described in prose only.',
    '## The review bar', bar,
    ...(asks ? ['## What review here consistently asks for', asks] : []),
    'The bar\'s definitions win, and the FINDING block below is the output format. Never use P3.',
    '## The diff', `Run \`${DIFF_COMMAND}\` to read the change. Never paste it or ask for it elsewhere.`,
    '## Changed files', files.join('\n'),
    '## Repo instructions', instructions || 'None named.',
    '## Intent', intent.trim(),
    '## Round', 'Round 1.',
    '## Your task', parts.argue,
    'Every behavioural claim needs a file:line in real code. An inference from a name is not evidence. NO FINDINGS is the expected result for most changes and is not a failure.',
    '## Format', 'Answer with one block per finding, or NO FINDINGS:', parts.format,
    'End your answer, after the blocks or NO FINDINGS, with one line `FILES READ: <path>, <path>, …`: every repo-relative file you opened, the diff\'s included.',
  ].join('\n\n') + '\n';
}

const FIELDS = ['severity', 'file', 'title', 'detail', 'evidence', 'suggested_fix'];

// "<path>:<line>" or "<path>:<start>-<end>", repo-relative. -> { file, line, end }, line null when it names none
export function findingPlace(text, wt = null) {
  const s = String(text ?? '').replace(/`/g, '').trim();
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(s);
  const relative = (p) => (wt && p.startsWith(`${wt}/`) ? p.slice(wt.length + 1) : p).replace(/^\.\//, '');
  if (!m) return { file: relative(s), line: null, end: null };
  return { file: relative(m[1]), line: Number(m[2]), end: Number(m[3] ?? m[2]) };
}

// A seat's answer. -> { findings } ([] for NO FINDINGS), or null when it holds neither form.
export function parseFindings(text, wt = null) {
  const lines = String(text).split('\n');
  const blocks = [];
  let cur = null, field = null;
  for (const raw of lines) {
    const l = raw.trim();
    if (/^[`*#\s]*FINDING[`*:\s]*$/.test(l)) { cur = {}; blocks.push(cur); field = null; continue; }
    if (/^FILES READ:/i.test(l)) { cur = null; continue; }
    if (!cur) continue;
    const m = /^([a-z_]+):\s*(.*)$/.exec(l);
    if (m && FIELDS.includes(m[1])) { field = m[1]; cur[field] = m[2]; } else if (field && l && !/^`+$/.test(l)) cur[field] += `\n${l}`;
  }
  if (!blocks.length) return lines.some((l) => /^[`*\s]*NO FINDINGS[`*.\s]*$/.test(l)) ? { findings: [] } : null;
  return { findings: blocks.map((b) => ({ severity: b.severity ?? null, ...findingPlace(b.file, wt), title: b.title ?? null, detail: b.detail ?? null, evidence: b.evidence ?? null, suggested_fix: b.suggested_fix ?? null })) };
}

// Which seeds the findings hit, and the findings that hit none. -> { found: [seed id], unmatched: [finding] }
export function scoreFindings(seeds, findings) {
  const inside = (f, s) => f.line != null && f.file === s.file && f.line <= s.end && f.end >= s.line;
  return { found: seeds.filter((s) => findings.some((f) => inside(f, s))).map((s) => s.id), unmatched: findings.filter((f) => !seeds.some((s) => inside(f, s))) };
}

export const findingId = (task, seat, f) => createHash('sha256').update(JSON.stringify([task, seat, f.file, f.line, f.title])).digest('hex').slice(0, 10);

const CALL = /call$/;
// The first of `paths` named by a tool call in a Codex session log, or null.
export function namedPath(text, paths) {
  for (const l of String(text).split('\n')) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const p = e?.payload;
    if (!p || typeof p.type !== 'string' || !CALL.test(p.type)) continue;
    const call = `${p.arguments ?? ''} ${p.input ?? ''}`;
    const hit = paths.find((x) => call.includes(x));
    if (hit) return hit;
  }
  return null;
}

// The seat's copy of the arm's settings: the bench's, with no way to write.
function readOnlySettings(file) {
  const s = JSON.parse(readFileSync(file, 'utf8'));
  s.permissions.allow = s.permissions.allow.filter((r) => !r.startsWith('Edit(') && !r.startsWith('Write('));
  s.permissions.deny.push('Edit', 'Write', 'NotebookEdit');
  writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
}

function readSeeds(task, dir) {
  const file = join(dir, task.id, 'seeds.json');
  if (!existsSync(file)) return null;
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  if (rec.merge !== task.merge) throw new Error(`task ${task.id}: ${file} was seeded from another merge commit`);
  return { ...rec, dir: dirname(file), patch: readFileSync(join(dirname(file), 'seeded.patch'), 'utf8') };
}

// The checkout at the base, with the seeded change as its one new commit.
function plantChange(wt, patch, env) {
  const git = (args, input) => {
    const r = spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8', env, input, maxBuffer: BUFFER });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || '').trim()}`);
    return r.stdout;
  };
  git(['apply', '--index', '--whitespace=nowarn', '-'], patch);
  git(['-c', 'user.name=bench', '-c', 'user.email=bench@localhost', 'commit', '-q', '--no-verify', '-m', 'Change under review']);
  return git(['diff', '--name-only', 'HEAD~1', 'HEAD']).split('\n').filter(Boolean);
}

// One seat on one seeded task. Whatever goes wrong is this seat's failure, with the reason.
function runSeat(repo, task, seat, rec, parts, opts, dir, secrets, env) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const result = { task: task.id, arm: seat.name, repo: task.repo, base: task.base, merge: task.merge, model: seat.model, effort: seat.effort, status: 'failed', why: null,
    verdict: null, verdict_from: null, findings: [], seeds: rec.seeds, cost: null, tokens: null, ran_at: null, at: new Date().toISOString() };
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'desk-bench-seat-'));
  const wt = join(parent, 'checkout');
  try {
    makeCheckout(repo, task, wt);
    const files = plantChange(wt, rec.patch, env);
    const brief = seatBrief({ bar: reviewBar(repo, wt, parts), asks: optional(repo, 'get', 'review-asks').trim(), files, instructions: optional(repo, 'get', 'repo-instructions').trim(), intent: task.prompt, parts });
    writeFileSync(join(wt, BRIEF_FILE), brief);
    writeFileSync(join(dir, 'brief.txt'), brief);
    const seated = { ...task, prompt: SEAT_PROMPT };
    let run, answer;
    if (seat.name === CODEX) {
      run = runCodex(seated, seat, wt, null, opts, dir, { env });
      answer = run.ok ? readFileSync(join(dir, 'last-message.txt'), 'utf8') : '';
      const log = join(dir, 'codex-session.jsonl');
      const named = existsSync(log) ? namedPath(readFileSync(log, 'utf8'), secrets) : null;
      if (named) run = { ...run, ok: false, why: `its tool calls name ${named}, which no seat may read` };
    } else {
      const settings = join(parent, 'settings.json');
      writeSettings(repo, task, wt, settings, secrets);
      readOnlySettings(settings);
      run = runClaude(seated, seat, wt, settings, opts, dir, { env, extraArgs: ['--append-system-prompt', parts.lena] });
      answer = run.ok ? String(run.reply ?? '') : '';
    }
    Object.assign(result, { cost: run.cost ?? null, tokens: run.tokens ?? null, ran_at: run.ranAt ?? null, why: run.why ?? null, ...run.extra });
    if (run.ok) {
      writeFileSync(join(dir, 'answer.txt'), answer);
      const parsed = parseFindings(answer, wt);
      if (!parsed) result.why = 'the seat answered with neither FINDING blocks nor NO FINDINGS';
      else Object.assign(result, { status: 'reviewed', verdict: parsed.findings.length ? 'findings' : 'clean', verdict_from: seat.name === CODEX ? 'last-message.txt' : 'the session result', findings: parsed.findings });
    }
  } catch (e) {
    result.status = 'failed';
    result.why = e.message;
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
  return result;
}

// The two seats on one repo: the Codex seat at that repo's finder model and effort.
export function seatsFor(repo) {
  let items = [];
  try { items = deskEnv(repo, 'list', 'codex-models').split('\n').filter(Boolean); } catch (e) { if (e.exitCode !== 3) throw e; }
  const { finder } = parseCodexReview(items);
  return [{ name: CURRENT, model: 'opus', effort: null }, { name: CODEX, model: finder.model, effort: finder.effort, sandbox: 'read-only', config: [] }];
}

const stored = (file) => { try { const r = JSON.parse(readFileSync(file, 'utf8')); return r.status === 'reviewed' ? r : null; } catch { return null; } };

// Runs both seats over every seeded task and writes run.json. -> printBench's shape
export function runArm2(opts, log = () => {}) {
  const settings = Q.quotaSettings();
  log(Q.settingsLine(settings));
  const parts = { ...reviewParts(), lena: lenaPrompt() };
  const seedRoot = seedsDir(opts);
  const leftOut = [], planted = [];
  for (const task of loadBenchTasks(opts.tasks)) {
    const rec = noMerge(task) ? null : readSeeds(task, seedRoot);
    const why = noMerge(task) ? 'the task records no merge commit' : !rec ? `no seeds (looked in ${join(seedRoot, task.id)}: run seed first)` : !rec.seeds.length ? 'none of its findings could be seeded' : null;
    if (why) { leftOut.push({ task: task.id, why }); log(`left out ${task.id}: ${why}`); } else planted.push({ task, rec });
  }
  if (!planted.length) throw new Error('refusing to start: no task has a seed to review');
  // Every repo is read first, so a bad one refuses the run before anything is spent.
  const repos = new Map();
  for (const { task } of planted) if (!repos.has(task.repo)) { const repo = readRepo(task.repo); repo.seats = seatsFor(repo); repos.set(task.repo, repo); }
  const out = outDir(opts);
  mkdirSync(join(out, 'runs'), { recursive: true });
  const guard = spendGuard({ settings, ledger: Q.ledgerPath(), budget: Number(opts.budget), total: Number(opts.total), log });
  const report = planted.map(({ task, rec }) => {
    const repo = repos.get(task.repo);
    const order = armOrder(repo.seats, opts.seed, task.id);
    const secrets = [repo.root, resolve(opts.tasks), task.hidden_tests.dir, out, seedRoot, rec.findings_file].filter(existsSync).flatMap(both);
    const runs = order.map((seat) => {
      const key = createHash('sha256').update(JSON.stringify([task.base, rec.patch, task.prompt, parts, seat.model, seat.effort])).digest('hex').slice(0, 12);
      const dir = join(out, 'runs', `${task.id}.${seat.name}.${key}`);
      const prior = stored(join(dir, 'result.json'));
      if (prior) { log(`reuse ${task.id} (${seat.name})`); return { arm: seat.name, status: prior.status, reused: true, quota_points: prior.quota?.points ?? null, dir }; }
      const env = armEnv();
      const paid = guard.begin({ vendor: Q.armVendor(seat), env, id: `${dir}@${new Date().toISOString()}`, label: `${task.id} (${seat.name})`, fields: { task: task.id, arm: seat.name } });
      if (paid.notRun) return { arm: seat.name, ...paid.notRun };
      log(`review ${task.id} (${seat.name})`);
      const result = runSeat(repo, task, seat, rec, parts, opts, dir, secrets, paid.env);
      result.quota = guard.end(paid, result.cost);
      writeFileSync(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
      log(`  ${result.status}${result.why ? `: ${result.why}` : ''}`);
      guard.logStop(paid);
      return { arm: seat.name, status: result.status, why: result.why, quota_points: result.quota?.points ?? null, dir };
    });
    return { task: task.id, order: order.map((s) => s.name), runs };
  });
  const quota = guard.quota();
  const path = join(out, 'run.json');
  writeFileSync(path, `${JSON.stringify({ seed: opts.seed, spent: guard.spent, quota, tasks: report, ...(leftOut.length ? { left_out: leftOut } : {}) }, null, 2)}\n`);
  return { path, report, quota, leftOut, armStops: [] };
}

const marksFile = (out) => join(out, 'marks.json');
const readMarks = (out) => { try { return JSON.parse(readFileSync(marksFile(out), 'utf8')); } catch { return {}; } };

// Every finding no seed covers, across the run's reviewed seats. -> [{ id, task, seat, finding }]
export function unmatchedFindings(run) {
  return run.tasks.flatMap((t) => t.runs.filter((r) => r.status === 'reviewed' && r.result)
    .flatMap((r) => scoreFindings(r.result.seeds, r.result.findings).unmatched.map((f) => ({ id: findingId(t.task, r.arm, f), task: t.task, seat: r.arm, finding: f }))));
}

// One seat's figures.
export function seatFigures(run, seat, marks) {
  const runs = run.tasks.map((t) => ({ task: t.task, ...t.runs.find((r) => r.arm === seat) })).filter((r) => r.status);
  const reviewed = runs.filter((r) => r.status === 'reviewed' && r.result);
  const unmatched = unmatchedFindings(run).filter((u) => u.seat === seat);
  const efforts = [...new Set(reviewed.map((r) => r.result.ran_at?.effort ?? r.result.effort ?? 'CLI default'))];
  return {
    seat, reviewed: reviewed.length, failed: runs.filter((r) => r.status === 'failed').length, notRun: runs.filter((r) => r.status === 'not run').length,
    planted: reviewed.reduce((n, r) => n + r.result.seeds.length, 0),
    found: reviewed.reduce((n, r) => n + scoreFindings(r.result.seeds, r.result.findings).found.length, 0),
    unmatched: unmatched.length, real: unmatched.filter((u) => marks[u.id] === 'real').length, falseAlarms: unmatched.filter((u) => marks[u.id] === 'false-alarm').length,
    unmarked: unmatched.filter((u) => !marks[u.id]).length, efforts,
  };
}

// The markdown report. -> { text, figures }
export function renderReport({ out, run, marks }) {
  const figures = [CURRENT, CODEX].map((s) => seatFigures(run, s, marks));
  const rows = [
    ['Seeds found, of seeds planted', (f) => `${f.found} of ${f.planted}`],
    ['Tasks reviewed', (f) => String(f.reviewed)],
    ['Runs failed (not scored)', (f) => String(f.failed)],
    ['Runs not run', (f) => String(f.notRun)],
    ['Findings matching no seed', (f) => String(f.unmatched)],
    ['Marked real defects', (f) => String(f.real)],
    ['Marked false alarms', (f) => String(f.falseAlarms)],
    ['Waiting for a mark', (f) => String(f.unmarked)],
    ['Review effort', (f) => f.efforts.join(', ') || 'none recorded'],
  ];
  const text = [`# Arm 2 report: ${out}`, '', `${run.tasks.length} task(s) · seats ${CURRENT}, ${CODEX}${run.seed ? ` · seed ${run.seed}` : ''}`, ''];
  if (run.leftOut.length) text.push('## Left out', '', ...run.leftOut.map((l) => `- ${l.task}: ${l.why}`), '');
  if (figures[0].planted !== figures[1].planted) text.push('The seats did not review the same seeds, so read each column on its own.', '');
  text.push(`| Figure | ${figures.map((f) => f.seat).join(' | ')} |`, `|---|${figures.map(() => '---|').join('')}`);
  for (const [label, cell] of rows) text.push(`| ${label} | ${figures.map((f) => cell(f)).join(' | ')} |`);
  const failed = run.tasks.flatMap((t) => t.runs.filter((r) => r.status === 'failed').map((r) => `- ${t.task} (${r.arm}): ${r.why ?? 'no reason recorded'}`));
  if (failed.length) text.push('', '## Failed runs', '', ...failed);
  const list = unmatchedFindings(run);
  if (list.length) {
    text.push('', '## Findings matching no seed', '', 'Mark each one with `bench-arm2.mjs mark --out <out> <id> real|false-alarm`. It counts only once marked.', '',
      '| Id | Task | Seat | Severity | Where | Title | Mark |', '|---|---|---|---|---|---|---|');
    const cell = (v) => String(v ?? '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');
    for (const u of list) text.push(`| ${u.id} | ${u.task} | ${u.seat} | ${cell(u.finding.severity)} | ${cell(u.finding.file)}${u.finding.line == null ? '' : `:${u.finding.line}`} | ${cell(u.finding.title)} | ${marks[u.id] ?? 'unmarked'} |`);
  }
  return { text: `${text.join('\n')}\n`, figures };
}

export function writeReport(out) {
  const { text } = renderReport({ out, run: loadRun(out), marks: readMarks(out) });
  const path = join(out, 'report.md');
  writeFileSync(path, text);
  return { path, text };
}

// Records one mark. -> the finding marked
export function markFinding(out, id, mark) {
  if (!MARKS.includes(mark)) throw new Error(`a mark is ${MARKS.join(' or ')}, not ${mark}`);
  const hit = unmatchedFindings(loadRun(out)).find((u) => u.id === id);
  if (!hit) throw new Error(`no finding ${id} matching no seed in ${out}`);
  writeFileSync(marksFile(out), `${JSON.stringify({ ...readMarks(out), [id]: mark }, null, 2)}\n`);
  return hit;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  try {
    const [cmd, ...argv] = process.argv.slice(2);
    if (cmd === 'seed') {
      for (const s of writeSeeds(parseSeedArgs(argv), (m) => console.error(m))) {
        console.log(`${s.task}: ${s.planted} seed(s) planted${s.kept ? ' (kept)' : ''}`);
        for (const k of s.skipped) console.log(`  skipped ${k.finding.file}:${k.finding.line}: ${k.why}`);
      }
    } else if (cmd === 'report') {
      const { out, rest } = parseReportArgs(argv);
      noneLeft(rest);
      const { path, text } = writeReport(out);
      process.stdout.write(text);
      console.log(`report: ${path}`);
    } else if (cmd === 'mark') {
      const { out, rest } = parseReportArgs(argv);
      if (rest.length !== 2) throw new Error('usage: bench-arm2.mjs mark --tasks <file.json> [--out <dir>] <finding id> real|false-alarm');
      const { finding } = markFinding(out, rest[0], rest[1]);
      console.log(`${rest[0]} marked ${rest[1]}: ${finding.title}`);
    } else printBench(runArm2(parseArgs(process.argv.slice(2)), (m) => console.error(m)));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
