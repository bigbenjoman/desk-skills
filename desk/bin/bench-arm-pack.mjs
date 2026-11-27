// The start-4b pack arm: frozen tasks run twice on the same model and effort, once as the baseline and
// once with the start-4b pack appended to the system prompt, so the pack, in context from turn 0, is
// the only difference between the two sides.
//
//   node bench-arm-pack.mjs --tasks <file.json> --max-budget-usd <usd> [--total-budget-usd <usd>]
//                           [--out <dir>] [--timeout <seconds>] [--seed <n>] [--limit 10]
//                           [--baseline-arm opus] [--model opus] [--skills <dir>]
//
// Both arms run one model (--model, default opus) at medium effort. The baseline arm keeps the name
// and model an earlier bench run gave it (--baseline-arm, --model), so its stored results are reused
// rather than paid for again: the model is part of the run key, so `opus` never reuses a run stored
// as `claude-opus-5-5`. --limit runs the
// first n tasks of the set. The pack is START_4B_FILES, the skill files a worker starting at Stage 4b
// reads, read from the installed skills (--skills, default desk-env's skillsDir) and joined in that
// order with every paragraph an earlier file already holds dropped; nothing else is cut. Each pack
// run keeps the pack it ran with as system.md, and its run key hashes it, so a changed skill file is a
// new run.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBenchTasks, parseArgs as benchArgs, printBench, runBench } from './bench.mjs';
import { skillsDir } from './desk-env.mjs';

export const MODEL = 'opus';
export const EFFORT = 'medium';
export const PACK_ARM = 'pack-4b';

// Read by most start-4b worker sessions in their logs (skill-ride.mjs --files 4b), in reading order.
export const START_4B_FILES = Object.freeze([
  'desk-autopilot/references/worker-contract-stage-4.md',
  'desk-autopilot/references/worker-contract-stage-3.md',
  'desk-review/SKILL.md',
  'desk-review/references/phase-0-preflight.md',
  'desk-review/references/phase-1-target.md',
  'desk-review/references/phase-2-route.md',
  'desk-review/references/phase-3-find.md',
  'desk-review/references/phase-4-refute.md',
  'desk-review/references/phase-5-requirements.md',
  'desk-kiss/SKILL.md',
  'desk-ticket/references/stage-4b-self-review.md',
  'desk-review/references/phase-6-report.md',
  'desk-review/references/phase-7-post.md',
  'desk-autopilot/references/worker-contract-stage-5.md',
  'desk-ticket/references/stage-5-evidence.md',
  'desk-ticket/references/stage-7-pr.md',
  'desk-pr/SKILL.md',
  'desk-pr/references/the-body.md',
  'desk-pr/references/opening.md',
  'desk-autopilot/references/worker-contract-stage-8.md',
  'desk-ticket/references/stage-8-jira.md',
]);

export const PACK_HEADING = 'The desk skill files a session starting at Stage 4b reads are below, loaded up front. Where a skill says to read one of them, it is already here: use this copy rather than reading the file again.';

const squash = (s) => s.replace(/\s+/g, ' ').trim();

// [{ path, text }] -> the pack: each file under its path, less every paragraph (a run of lines between
// blank lines) that an earlier file or an earlier paragraph of its own already holds word for word.
// A paragraph with no letter or digit (a fence, a rule) is never dropped.
export function buildPack(files) {
  const seen = new Set();
  const parts = [PACK_HEADING];
  for (const { path, text } of files) {
    const kept = [];
    for (const para of String(text).split(/\n[ \t]*\n/)) {
      const key = squash(para);
      if (/[A-Za-z0-9]/.test(key)) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      kept.push(para.replace(/^\n+|\n+$/g, ''));
    }
    parts.push(`<skill-file path="${path}">\n${kept.join('\n\n')}\n</skill-file>`);
  }
  return `${parts.join('\n\n')}\n`;
}

// The pack from the skills in `dir`. Throws naming a file the pack lists that is missing.
export function readPack(dir) {
  return buildPack(START_4B_FILES.map((p) => {
    const f = join(dir, p);
    if (!existsSync(f)) throw new Error(`refusing to start: the pack lists ${p}, which is not in ${dir}`);
    return { path: p, text: readFileSync(f, 'utf8') };
  }));
}

// argv -> bench.mjs's options with the two arms, plus { limit, skills }. An --arm of its own is refused.
export function parseArgs(argv) {
  if (argv.includes('--arm')) throw new Error(`bench-arm-pack.mjs sets its own arms: the baseline and ${PACK_ARM}, both on --model at ${EFFORT}`);
  const own = { '--limit': 'limit', '--baseline-arm': 'baseline', '--model': 'model', '--skills': 'skills' };
  const o = { limit: '10', baseline: 'opus', model: MODEL, skills: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (!own[argv[i]]) { rest.push(argv[i]); continue; }
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
    o[own[argv[i]]] = argv[++i];
  }
  if (!/^\d+$/.test(o.limit) || !(Number(o.limit) > 0)) throw new Error(`--limit must be a positive whole number, not ${o.limit}`);
  if (o.baseline === PACK_ARM) throw new Error(`--baseline-arm cannot be ${PACK_ARM}, the pack arm's own name`);
  if (!/^[\w.-]+$/.test(o.model)) throw new Error(`--model must be a model name, not ${o.model}`);
  const b = benchArgs([...rest, '--arm', `${o.baseline}=${o.model}:${EFFORT}`, '--arm', `${PACK_ARM}=${o.model}:${EFFORT}`]);
  return { ...b, limit: Number(o.limit), skills: o.skills ?? skillsDir() };
}

export function runPackArm(opts, log = () => {}) {
  const system = readPack(opts.skills);
  log(`pack: ${START_4B_FILES.length} skill files, ${Buffer.byteLength(system)} bytes`);
  const tasks = loadBenchTasks(opts.tasks).slice(0, opts.limit);
  const arms = opts.arms.map((a) => (a.name === PACK_ARM ? { ...a, system } : a));
  return runBench({ ...opts, arms, taskList: tasks, secrets: [opts.skills] }, log);
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  try {
    printBench(runPackArm(parseArgs(process.argv.slice(2)), (m) => console.error(m)));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
