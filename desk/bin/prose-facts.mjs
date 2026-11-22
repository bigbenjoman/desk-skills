// The facts a skill's prose may name, each read from the list the running code uses, so a test can
// hold the skills to the code. Importing it prints nothing and runs no script's command.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { QUEUE_COMMANDS } from './queue-commands.mjs';
import { DESK_ENV_COMMANDS, WORKER_COMMAND_IDS, lockFor, PATH_VARS, MACHINE_PATHS } from './desk-env.mjs';
import { MARKERS, ENV } from './markers.mjs';
import { STATES } from './queue-writer.mjs';
import { STATE_PATHS, validatePark } from './batch-state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Each skill's folder name; none when there is no skills folder.
const skillDirs = (root) => (existsSync(join(root, 'skills')) ? readdirSync(join(root, 'skills')) : []);

// Every file directly under desk/bin and each skill's bin, repo-relative: the scripts a skill may name.
function binScripts(root) {
  const filesIn = (dir) => (existsSync(join(root, dir))
    ? readdirSync(join(root, dir)).filter((f) => statSync(join(root, dir, f)).isFile()).map((f) => `${dir}/${f}`) : []);
  return [...filesIn('desk/bin'), ...skillDirs(root).flatMap((s) => filesIn(`skills/${s}/bin`))].sort();
}

// Every file under `dir`, at any depth, repo-relative; none when it is missing.
function walk(root, dir) {
  if (!existsSync(join(root, dir))) return [];
  return readdirSync(join(root, dir)).flatMap((f) => {
    const rel = `${dir}/${f}`;
    return statSync(join(root, rel)).isDirectory() ? walk(root, rel) : [rel];
  });
}

// Every file under desk/bin and each skill's bin, at any depth, repo-relative and sorted.
const binTree = (root) => [...walk(root, 'desk/bin'), ...skillDirs(root).flatMap((s) => walk(root, `skills/${s}/bin`))].sort();

// The other files desk ships, repo-relative: install.sh, the hooks it installs, each skill's scripts
// folder, and the templates it copies into a repo (desk/templates/scripts/desk/pre-push.sh is the
// repo's scripts/desk/pre-push.sh).
function shippedFiles(root) {
  const skills = skillDirs(root);
  return [...(existsSync(join(root, 'install.sh')) ? ['install.sh'] : []), ...walk(root, 'hooks'),
    ...skills.flatMap((s) => walk(root, `skills/${s}/scripts`)), ...walk(root, 'desk/templates')].sort();
}

// queue: each queue.mjs command and the flags it reads; deskEnv: each desk-env subcommand; scripts:
// the bin files above; shipped: the other files desk ships.
export function commands(root = ROOT) {
  return {
    queue: Object.fromEntries(Object.entries(QUEUE_COMMANDS).map(([c, flags]) => [c, [...flags]])),
    deskEnv: [...DESK_ENV_COMMANDS],
    scripts: binScripts(root),
    shipped: shippedFiles(root),
  };
}

// The AUTOPILOT_ names: markers a worker prints, and variables set in the environment.
export const autopilot = () => ({ markers: [...MARKERS], variables: [...ENV] });

// Every state a ticket in a batch queue can be in.
export const states = () => [...STATES];

// What a skill may name of where things live: the variables `desk-env paths` prints (machine: the
// ones shared by every repo), the files batch-state.mjs reads under a batch's state folder
// (STATE_PATHS), `<KEY>` for the ticket, and `code`, each name the code builds directly under it.
export const statePaths = (root = ROOT) => ({ vars: [...PATH_VARS], machine: [...MACHINE_PATHS], state: { ...STATE_PATHS }, code: stateNames(root) });

// A path built on the state folder: `join(<a value naming state>, '<name>'` in a module (STATE,
// stateDir(), r.stateDir, batchPaths(slug, batch).state), `$<…STATE…>/<name>` in a shell script.
const JOINED = /\bjoin\(\s*([\w$.]+(?:\((?:[^()]|\([^()]*\))*\))?(?:\.[\w$]+)*)\s*,\s*(['"`])([^'"`]+)\2/g;
const SHELL_JOINED = /\$\{?([A-Z_]*STATE[A-Z_]*)\}?\/([\w.-]+)/g;
// The repo's own folder, which a named batch's state folder sits inside: repoStateOf(state), and
// batchPaths(slug).state with no batch (the standing batch's). A name built there is not one under
// $DESK_STATE.
const REPO_STATE = /^(?:[\w$.]*\.)?(?:repoStateOf\(|batchPaths\((?:[^,()]|\([^()]*\))*\))/;

// Each name the code under desk/bin (at any depth) and each skill's bin builds directly under a batch's
// state folder, a `${…}` in it written `<>`: 'briefings', 'intake.json'.
export function stateNames(root = ROOT) {
  const names = new Set();
  for (const rel of binTree(root)) {
    if (!/\.(mjs|js|sh)$/.test(rel)) continue;
    const text = readFileSync(join(root, rel), 'utf8');
    for (const m of text.matchAll(JOINED)) if (/state/i.test(m[1]) && !REPO_STATE.test(m[1])) names.add(m[3].split('/')[0].replace(/\$\{[^}]*\}/g, '<>'));
    if (rel.endsWith('.sh')) for (const m of text.matchAll(SHELL_JOINED)) names.add(m[2]);
  }
  return [...names].filter((n) => n && !n.startsWith('<>')).sort();
}

// The validator the running code checks each file a skill shows an example of with, each returning why
// it refuses (results) or what it logs (park), else null: results, the review results file
// desk-review's verdict reads; park, a worker's park file as the pass takes it in. The verdict sits in
// the desk-review skill's bin, so it is read from `root` when asked for.
export async function contracts(root = ROOT) {
  const { validateResults } = await import(pathToFileURL(join(root, 'skills', 'desk-review', 'bin', 'verdict.mjs')).href);
  return { results: validateResults, park: validatePark };
}

// The lock classes with-lock.sh's usage line lists: `usage: with-lock.sh <test|tsc|…>`.
export function usageLocks(text) {
  const m = /usage: with-lock\.sh <([a-z|]+)>/.exec(text);
  return m ? m[1].split('|') : [];
}
// classes: the lock wrapper's; commands: each § command id a worker runs, with the class desk-env runs
// it under (lockFor: `nolock` where it takes none).
export const locks = (root = ROOT) => ({
  classes: usageLocks(readFileSync(join(root, 'desk', 'bin', 'with-lock.sh'), 'utf8')),
  commands: Object.fromEntries(WORKER_COMMAND_IDS.map((id) => [id, lockFor(id)])),
});

// An AUTOPILOT_ name, bounded on the left, so the tail of a longer name (DESK_AUTOPILOT_WORKER) is not
// read as one. Named in lower case so autopilotNames, reading this file, never reads its own name.
export const autopilotNameRe =/(?<![A-Za-z0-9_])AUTOPILOT_[A-Z0-9_]*[A-Z0-9]/g;

// Each AUTOPILOT_ name a file under desk/bin (at any depth) or a skill's bin uses, with the files using
// it: { name: [repo-relative path, …] }.
export function autopilotNames(root = ROOT) {
  const found = {};
  for (const rel of binTree(root)) {
    for (const m of readFileSync(join(root, rel), 'utf8').matchAll(autopilotNameRe)) {
      (found[m[0]] ??= new Set()).add(rel);
    }
  }
  return Object.fromEntries(Object.keys(found).sort().map((k) => [k, [...found[k]]]));
}
