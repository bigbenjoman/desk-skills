// Arm 1: every frozen task twice on the same model and effort, once with the ticket as filed and once
// with the ticket plus its task packet, so the packet is the only difference between the two sides.
//
//   node bench-arm1.mjs --tasks <file.json> --max-budget-usd <usd> [--total-budget-usd <usd>]
//                       [--out <dir>] [--timeout <seconds>] [--seed <n>]
//
// The arms are fixed: `filed` and `packet`, both opus at medium effort. A task's packet is
// <set dir>/packets/<task id>.md, which no arm may read. A task with no packet, or an empty one, is
// skipped on both sides. A packet that quotes any line of the task's merged diff (either side) or of
// its hidden tests is refused, so no packet carries the answer. A line counts once trimmed it is at
// least 20 characters with a letter or digit in it, and runs of whitespace match as one space. Every
// task left out is named on the way in and kept in run.json's left_out, which the report lists.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBenchTasks, parseArgs as benchArgs, printBench, readRepo, runBench } from './bench.mjs';

export const ARMS = Object.freeze([
  { name: 'filed', model: 'opus', effort: 'medium' },
  { name: 'packet', model: 'opus', effort: 'medium', brief: 'packet' },
]);
export const MIN_LINE = 20;

// argv -> bench.mjs's options with arm 1's two arms. An --arm of its own is refused.
export function parseArgs(argv) {
  if (argv.includes('--arm')) throw new Error(`bench-arm1.mjs sets its own arms: ${ARMS.map((a) => `${a.name}=${a.model}:${a.effort}`).join(' and ')}`);
  const o = benchArgs([...argv, ...ARMS.flatMap((a) => ['--arm', `${a.name}=${a.model}:${a.effort}`])]);
  return { ...o, arms: ARMS.map((a) => ({ ...a })) };
}

export const packetsDir = (setFile) => join(dirname(resolve(setFile)), 'packets');

const squash = (s) => s.replace(/\s+/g, ' ').trim();

// The lines of `text` a packet may not quote, squashed.
export function answerLines(text) {
  return [...new Set(String(text).split('\n').map(squash).filter((l) => l.length >= MIN_LINE && /[A-Za-z0-9]/.test(l)))];
}

// A unified diff's added and removed lines, without their mark; file headers are not lines.
export function diffLines(patch) {
  const out = [];
  let inHunk = false;
  for (const l of String(patch).split('\n')) {
    if (l.startsWith('diff --git ')) inHunk = false;
    else if (l.startsWith('@@')) inHunk = true;
    else if (inHunk && (l[0] === '+' || l[0] === '-')) out.push(l.slice(1));
  }
  return out;
}

// The first of `sources` ([{ from, text }]) the packet quotes a line of. -> { from, line } | null
export function leak(packet, sources) {
  const p = squash(packet);
  for (const s of sources) {
    const line = answerLines(s.text).find((l) => p.includes(l));
    if (line) return { from: s.from, line };
  }
  return null;
}

export const noMerge = (task) => typeof task.merge !== 'string' || !/^[0-9a-f]{40}$/.test(task.merge);

// The task's merged diff, read in its repo's primary checkout.
export function mergedDiff(root, task) {
  if (noMerge(task)) throw new Error('the task records no merge commit to check its packet against');
  const r = spawnSync('git', ['-C', root, 'diff', '--no-color', '--no-ext-diff', task.base, task.merge], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git diff ${task.base.slice(0, 12)} ${task.merge.slice(0, 12)} failed in ${root}: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

// The tasks arm 1 runs, each carrying its packet, and the ones it leaves out.
// `diffOf(task)` gives the task's merged diff. -> { tasks, leftOut: [{ task, why }] }
export function packetTasks(file, diffOf) {
  const dir = packetsDir(file);
  const tasks = [], leftOut = [];
  for (const t of loadBenchTasks(file)) {
    const f = join(dir, `${t.id}.md`);
    const packet = existsSync(f) ? readFileSync(f, 'utf8') : '';
    if (!packet.trim()) { leftOut.push({ task: t.id, why: `no packet (looked for ${f})` }); continue; }
    let why = null;
    try {
      const sources = [...t.hidden_tests.files.map((h) => ({ from: `hidden test ${h}`, text: readFileSync(join(t.hidden_tests.dir, h), 'utf8') })),
        { from: 'the merged diff', text: diffLines(diffOf(t)).join('\n') }];
      const hit = leak(packet, sources);
      if (hit) why = `refused: its packet quotes a line of ${hit.from}: ${JSON.stringify(hit.line)}`;
    } catch (e) {
      why = `refused: its packet could not be checked: ${e.message}`;
    }
    if (why) leftOut.push({ task: t.id, why });
    else tasks.push({ ...t, packet });
  }
  return { tasks, leftOut };
}

// Loads and checks the packets, then runs both arms over the tasks that pass.
export function runArm1(opts, log = () => {}) {
  const repos = new Map();
  const diffOf = (t) => {
    if (!repos.has(t.repo)) repos.set(t.repo, (() => { try { return readRepo(t.repo); } catch (e) { return e; } })());
    const repo = repos.get(t.repo);
    if (repo instanceof Error) throw repo;
    return mergedDiff(repo.root, t);
  };
  const { tasks, leftOut } = packetTasks(opts.tasks, diffOf);
  for (const l of leftOut) log(`left out ${l.task}: ${l.why}`);
  if (!tasks.length) throw new Error('refusing to start: no task has a packet arm 1 can run');
  return runBench({ ...opts, taskList: tasks, leftOut, secrets: [packetsDir(opts.tasks)] }, log);
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  try {
    printBench(runArm1(parseArgs(process.argv.slice(2)), (m) => console.error(m)));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
