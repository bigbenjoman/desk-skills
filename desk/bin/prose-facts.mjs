// The facts a skill's prose may name, each read from the list the running code uses, so a test can
// hold the skills to the code. Importing it prints nothing and runs no script's command.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUEUE_COMMANDS } from './queue-commands.mjs';
import { DESK_ENV_COMMANDS } from './desk-env.mjs';

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
