// suite: prose facts registry (commands, flags, bin scripts, lock classes, states and state paths)
// covers: desk/bin/prose-facts.mjs desk/bin/queue-commands.mjs desk/bin/desk-env.mjs desk/bin/queue-writer.mjs desk/bin/batch-state.mjs
// Reads this checkout only.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commands, locks, states, statePaths } from '../desk/bin/prose-facts.mjs';
import { QUEUE_COMMANDS } from '../desk/bin/queue-commands.mjs';
import { DESK_ENV_COMMANDS, LOCK_OF, WORKER_COMMAND_IDS, lockFor } from '../desk/bin/desk-env.mjs';
import { STATES } from '../desk/bin/queue-writer.mjs';
import { STATE_PATHS } from '../desk/bin/batch-state.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const c = commands();

t('queue: every command with its flags', c.queue, JSON.parse(JSON.stringify(QUEUE_COMMANDS)));
t('queue: admit reads its hold flags', c.queue.admit, ['--by', '--hold', '--hold-outside', '--hold-merge', '--hold-spine']);
t('desk-env: every subcommand', c.deskEnv, [...DESK_ENV_COMMANDS]);

const files = (dir) => readdirSync(join(root, dir)).filter((f) => statSync(join(root, dir, f)).isFile()).map((f) => `${dir}/${f}`);
t('scripts: every file directly under desk/bin', files('desk/bin').filter((f) => !c.scripts.includes(f)), []);
t('scripts: every file under each skill\'s bin', ['skills/desk-disk/bin/disk-scan.sh', 'skills/desk-setup/bin/harness-rules.py'].filter((f) => !c.scripts.includes(f)), []);
t('scripts: no directory, and nothing outside a bin folder', c.scripts.filter((f) => !/^(desk|skills\/[^/]+)\/bin\/[^/]+$/.test(f) || !statSync(join(root, f)).isFile()), []);

// #881 AC6: lock classes come from with-lock.sh's usage line; each § command id runs under desk-env's class.
const l = locks();
t('#881 lock classes are the usage line\'s', l.classes, /usage: with-lock\.sh <([a-z|]+)>/.exec(readFileSync(join(root, 'desk', 'bin', 'with-lock.sh'), 'utf8'))[1].split('|'));
t('#881 every § command id a worker runs is there', Object.keys(l.commands), [...WORKER_COMMAND_IDS]);
t('#881 each § command id maps to desk-env\'s class for it', WORKER_COMMAND_IDS.filter((id) => l.commands[id] !== lockFor(id)), []);
t('#881 every id desk-env gives a lock is a § command id here', Object.keys(LOCK_OF).filter((id) => !(id in l.commands)), []);
t('#881 a heavy row takes its lock and a light one none', ['test-cmd', 'typecheck-cmd', 'e2e-cmd', 'dev-cmd'].map((id) => l.commands[id]), ['test', 'tsc', 'browser', 'nolock']);
t('#881 every class a § command id runs under is a lock class', [...new Set(Object.values(l.commands))].filter((c) => !l.classes.includes(c)), []);

// #881 AC7: states are read from the queue writer's list, so a state added there is here with no edit.
t('#881 states are the queue writer\'s', states(), [...STATES]);
STATES.push('ds881-probe');
t('#881 a state added to the queue writer is read with no edit to the registry', states().includes('ds881-probe'), true);
STATES.pop();
t('#881 state paths include batch-state\'s STATE_PATHS and DESK_STATE', [statePaths().state, statePaths().vars.includes('DESK_STATE')], [{ ...STATE_PATHS }, true]);

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
