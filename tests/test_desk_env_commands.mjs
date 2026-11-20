// suite: desk-env.mjs subcommand list (its switch equals DESK_ENV_COMMANDS; usage from it)
// covers: desk/bin/desk-env.mjs
// Scratch directories only.
import { readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DESK_ENV_COMMANDS } from '../desk/bin/desk-env.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'desk/bin/desk-env.mjs'), 'utf8');

// The case labels of the CLI's switch, the one inside `if (isMain)`.
function handled(text) {
  const lines = text.split('\n');
  const main = lines.indexOf('if (isMain) {');
  const start = lines.findIndex((l, i) => i > main && l === '    switch (cmd) {');
  const end = lines.findIndex((l, i) => i > start && /^ {6}default:/.test(l));
  if (main < 0 || start < 0 || end < 0) throw new Error('desk-env.mjs: CLI switch not found');
  return lines.slice(start + 1, end).map((l) => l.match(/^ {6}case '([^']+)':/)?.[1]).filter(Boolean);
}

function parity(text, list) {
  const cases = handled(text);
  return [
    ...cases.filter((c) => !list.includes(c)).map((c) => `desk-env.mjs handles "${c}", which DESK_ENV_COMMANDS lacks`),
    ...list.filter((c) => !cases.includes(c)).map((c) => `DESK_ENV_COMMANDS lists "${c}", which desk-env.mjs does not handle`),
  ];
}

t('the switch handles every listed subcommand (43)', DESK_ENV_COMMANDS.length, 43);
t('the switch equals DESK_ENV_COMMANDS', parity(source, DESK_ENV_COMMANDS), []);
const added = source.replace("      case 'uuid':", "      case 'frob':\n        break;\n      case 'uuid':");
t('a subcommand the list lacks fails, named', parity(added, DESK_ENV_COMMANDS), ['desk-env.mjs handles "frob", which DESK_ENV_COMMANDS lacks']);

// An unknown subcommand exits 2, its usage naming every subcommand handled.
const S = scratch('desk-env-cmds-');
const run = (args) => spawnSync(process.execPath, [join(root, 'desk/bin/desk-env.mjs'), ...args], {
  encoding: 'utf8', cwd: S, env: { ...process.env, HOME: S, DESK_CONFIG: join(S, 'none.md') },
});
for (const [label, args] of [['an unknown subcommand', ['frobnicate']], ['no subcommand', []]]) {
  const r = run(args);
  t(`${label} exits 2`, r.status, 2);
  const named = (r.stderr.match(/^usage: desk-env\.mjs (\S+)/m)?.[1] ?? '').split('|');
  t(`${label}'s usage names every subcommand`, DESK_ENV_COMMANDS.filter((c) => !named.includes(c)), []);
}
const named = (run(['frobnicate']).stderr.match(/^usage: desk-env\.mjs (\S+)/m)?.[1] ?? '').split('|');
t('the usage names ticket-kind, branch-check, config and merge-grant', ['ticket-kind', 'branch-check', 'config', 'merge-grant'].filter((c) => !named.includes(c)), []);

rmSync(S, { recursive: true, force: true });
if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
