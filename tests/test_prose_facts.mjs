// suite: prose facts registry (commands: queue commands and flags, desk-env subcommands, bin scripts)
// covers: desk/bin/prose-facts.mjs desk/bin/queue-commands.mjs desk/bin/desk-env.mjs
// Reads this checkout only.
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commands } from '../desk/bin/prose-facts.mjs';
import { QUEUE_COMMANDS } from '../desk/bin/queue-commands.mjs';
import { DESK_ENV_COMMANDS } from '../desk/bin/desk-env.mjs';

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

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
