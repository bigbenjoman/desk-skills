// The facts a skill's prose may name, each read from the list the running code uses, so a test can
// hold the skills to the code. Importing it prints nothing and runs no script's command.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUEUE_COMMANDS } from './queue-commands.mjs';
import { DESK_ENV_COMMANDS, WORKER_COMMAND_IDS, lockFor, PATH_VARS, MACHINE_PATHS } from './desk-env.mjs';
import { MARKERS, ENV } from './markers.mjs';
import { STATES } from './queue-writer.mjs';
import { STATE_PATHS } from './batch-state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Every file directly under desk/bin and each skill's bin, repo-relative: the scripts a skill may name.
function binScripts(root) {
  const filesIn = (dir) => (existsSync(join(root, dir))
    ? readdirSync(join(root, dir)).filter((f) => statSync(join(root, dir, f)).isFile()).map((f) => `${dir}/${f}`) : []);
  const skills = existsSync(join(root, 'skills')) ? readdirSync(join(root, 'skills')) : [];
  return [...filesIn('desk/bin'), ...skills.flatMap((s) => filesIn(`skills/${s}/bin`))].sort();
}

// queue: each queue.mjs command and the flags it reads; deskEnv: each desk-env subcommand; scripts:
// the bin files above.
export function commands(root = ROOT) {
  return {
    queue: Object.fromEntries(Object.entries(QUEUE_COMMANDS).map(([c, flags]) => [c, [...flags]])),
    deskEnv: [...DESK_ENV_COMMANDS],
    scripts: binScripts(root),
  };
}

// The AUTOPILOT_ names: markers a worker prints, and variables set in the environment.
export const autopilot = () => ({ markers: [...MARKERS], variables: [...ENV] });

// Every state a ticket in a batch queue can be in.
export const states = () => [...STATES];

// What a skill may name of where things live: the variables `desk-env paths` prints (machine: the
// ones shared by every repo), and the files batch-state.mjs reads under a batch's state folder
// (STATE_PATHS), `<KEY>` for the ticket.
export const statePaths = () => ({ vars: [...PATH_VARS], machine: [...MACHINE_PATHS], state: { ...STATE_PATHS } });

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
// read as one.
export const AUTOPILOT_NAME = /(?<![A-Za-z0-9_])AUTOPILOT_[A-Z0-9_]*[A-Z0-9]/g;

// Each AUTOPILOT_ name a file under desk/bin (at any depth) or a skill's bin uses, with the files using
// it: { name: [repo-relative path, …] }.
export function autopilotNames(root = ROOT) {
  const walk = (dir) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).flatMap((f) => {
    const rel = `${dir}/${f}`;
    return statSync(join(root, rel)).isDirectory() ? walk(rel) : [rel];
  }) : []);
  const skills = existsSync(join(root, 'skills')) ? readdirSync(join(root, 'skills')) : [];
  const found = {};
  for (const rel of [...walk('desk/bin'), ...skills.flatMap((s) => walk(`skills/${s}/bin`))].sort()) {
    for (const m of readFileSync(join(root, rel), 'utf8').matchAll(AUTOPILOT_NAME)) {
      (found[m[0]] ??= new Set()).add(rel);
    }
  }
  return Object.fromEntries(Object.keys(found).sort().map((k) => [k, [...found[k]]]));
}
