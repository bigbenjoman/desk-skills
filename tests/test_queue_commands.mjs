// suite: queue.mjs command list (its switch and the flags each command reads equal QUEUE_COMMANDS; usage from it)
// covers: desk/bin/queue.mjs desk/bin/queue-commands.mjs
// Scratch directories only.
import { readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { QUEUE_COMMANDS } from '../desk/bin/queue-commands.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'desk/bin/queue.mjs'), 'utf8');

const FLAG = /(['"`])(--[a-z][a-z0-9-]*)\1/g;
// A comment, or a flag passed on to another program, is not one queue.mjs reads.
const flagsIn = (line) => (/^\s*\/\/|\b(execFileSync|spawnSync|execSync)\(/.test(line) ? [] : [...line.matchAll(FLAG)].map((m) => m[2]));

// What queue.mjs's dispatch switch handles, and the flags each command reads: those in its case body,
// and those on a line outside the switch that tests for it by name (`=== '<cmd>'`).
function handled(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('switch (cmd) {');
  const end = lines.findIndex((l, i) => i > start && /^ {2}default:/.test(l));
  if (start < 0 || end < 0) throw new Error('queue.mjs: dispatch switch not found');
  const reads = new Map();
  // Labels on consecutive lines share the body after them.
  let group = [];
  let afterLabel = false;
  for (const l of lines.slice(start + 1, end)) {
    const c = l.match(/^ {2}case '([^']+)':/);
    if (c) {
      if (!afterLabel) group = [];
      group.push(c[1]);
      reads.set(c[1], new Set());
      afterLabel = true;
      continue;
    }
    if (l.trim()) afterLabel = false;
    for (const f of flagsIn(l)) for (const g of group) reads.get(g).add(f);
  }
  lines.forEach((l, i) => {
    if (i >= start && i <= end) return;
    for (const [cmd, set] of reads) if (l.includes(`=== '${cmd}'`)) for (const f of flagsIn(l)) set.add(f);
  });
  return reads;
}

// Every disagreement between the switch and the list, each naming the command (and flag).
function parity(text, list) {
  const reads = handled(text);
  const out = [];
  for (const cmd of reads.keys()) if (!Object.hasOwn(list, cmd)) out.push(`queue.mjs handles "${cmd}", which QUEUE_COMMANDS lacks`);
  for (const cmd of Object.keys(list)) if (!reads.has(cmd)) out.push(`QUEUE_COMMANDS lists "${cmd}", which queue.mjs does not handle`);
  for (const [cmd, set] of reads) {
    if (!Object.hasOwn(list, cmd)) continue;
    for (const f of set) if (!list[cmd].includes(f)) out.push(`queue.mjs ${cmd} reads ${f}, which its flag list lacks`);
    for (const f of list[cmd]) if (!set.has(f)) out.push(`QUEUE_COMMANDS gives ${cmd} the flag ${f}, which it does not read`);
  }
  return out;
}

t('the switch handles every listed command (30)', Object.keys(QUEUE_COMMANDS).length, 30);
t('the switch and its flags equal QUEUE_COMMANDS', parity(source, QUEUE_COMMANDS), []);

// A branch that adds a command, or a flag read, without the list fails naming it.
const added = source.replace("  case 'running': {", "  case 'frob': {\n    break;\n  }\n\n  case 'running': {");
t('a command the list lacks fails, named', parity(added, QUEUE_COMMANDS), ['queue.mjs handles "frob", which QUEUE_COMMANDS lacks']);
const flagged = source.replace("const [key, to] = args;\n    if (!key || !to) throw new Error('usage: queue.mjs move",
  "const [key, to] = args;\n    const quiet = args.includes('--quiet');\n    if (!key || !to) throw new Error('usage: queue.mjs move");
t('a flag the list lacks fails, naming command and flag', parity(flagged, QUEUE_COMMANDS), ['queue.mjs move reads --quiet, which its flag list lacks']);

// An unknown command is refused with exit 11, as before, and its usage names every command.
const S = scratch('queue-cmds-');
const run = (args) => spawnSync(process.execPath, [join(root, 'desk/bin/queue.mjs'), ...args], {
  encoding: 'utf8', cwd: S, env: { ...process.env, HOME: S, DESK_QUEUE: join(S, 'queue.json'), DESK_AUTOPILOT_STATE: join(S, 'state'), DESK_CONFIG: join(S, 'none.md') },
});
for (const [label, args] of [['an unknown command', ['frobnicate']], ['no command', []]]) {
  const r = run(args);
  t(`${label} exits 11`, r.status, 11);
  t(`${label}'s usage names every command`, Object.keys(QUEUE_COMMANDS).filter((c) => !r.stderr.includes(c)), []);
}
t('an unknown command is named', /unknown command "frobnicate"/.test(run(['frobnicate']).stderr), true);
t('watch lists its flags in the usage', /watch \[--interval\] \[--stages\]/.test(run(['frobnicate']).stderr), true);

rmSync(S, { recursive: true, force: true });
if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
