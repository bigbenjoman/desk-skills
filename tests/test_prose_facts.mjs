// suite: prose facts registry (commands, flags, bin scripts, lock classes, states and state paths)
// covers: desk/bin/prose-facts.mjs desk/bin/queue-commands.mjs desk/bin/desk-env.mjs desk/bin/queue-writer.mjs desk/bin/batch-state.mjs skills/desk-review/bin/verdict.mjs
// Reads this checkout only.
import { readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { commands, locks, states, statePaths, contracts } from '../desk/bin/prose-facts.mjs';
import { validateResults } from '../skills/desk-review/bin/verdict.mjs';
import { scratch } from './scratch.mjs';
import { QUEUE_COMMANDS } from '../desk/bin/queue-commands.mjs';
import { DESK_ENV_COMMANDS, LOCK_OF, WORKER_COMMAND_IDS, lockFor } from '../desk/bin/desk-env.mjs';
import { STATES } from '../desk/bin/queue-writer.mjs';
import { STATE_PATHS, validatePark, parkFileFault } from '../desk/bin/batch-state.mjs';

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
const usageOut = spawnSync('bash', [join(root, 'desk', 'bin', 'with-lock.sh')], { encoding: 'utf8' }).stderr;
t('#881 lock classes are the ones the usage line with-lock.sh prints lists', [l.classes.length > 0, usageOut.includes(`usage: with-lock.sh <${l.classes.join('|')}>`)], [true, true]);
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

// DS-882 AC5: the contracts are the validators the running code calls, each giving its message.
{
  const k = await contracts();
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const results = { sha: SHA, round: 1, gaps: 0, skipped_files: 0, seats: [{ role: 'correctness', vendor: 'claude', status: 'ran' }, { role: 'codex', vendor: 'codex', status: 'ran' }],
    findings: [{ id: 'F1', seat: 'correctness', severity: 'P1', where: 'src/a.ts:12', result: 'CONFIRMED', refuted_by: 'ada-devils-advocate' }] };
  const dir = scratch('ds882-facts-');
  writeFileSync(join(dir, 'results.json'), JSON.stringify(results));
  const verdict = spawnSync(process.execPath, [join(root, 'skills', 'desk-review', 'bin', 'verdict.mjs'), join(dir, 'results.json')], { encoding: 'utf8' });
  t('DS-882 AC5 the results validator is the one the verdict calls', [k.results === validateResults, k.results(results), verdict.status], [true, verdict.stderr.replace(/^verdict\.mjs: /, '').trimEnd(), 2]);
  t('DS-882 AC5 the park file validator is the one the pass calls', [k.park === validatePark, k.park({ question: 'q?', colour: 'red' }), k.park({ question: 'q?', approve: { kind: 'jira-comment', target: 'A-1', body: 'x' } })],
    [true, 'its park file holds a field the park file does not declare: colour', null]);
  mkdirSync(join(dir, 'parks'));
  writeFileSync(join(dir, 'parks', 'A-1.json'), JSON.stringify({ question: 'q?', colour: 'red' }));
  t('DS-882 AC5 and gives the message the pass logs', parkFileFault(dir, 'A-1', 'q?'), k.park({ question: 'q?', colour: 'red' }));
}

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
