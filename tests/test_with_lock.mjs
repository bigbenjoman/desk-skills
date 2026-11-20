// suite: with-lock (the lock classes its usage line lists are exactly the ones it accepts)
// covers: desk/bin/with-lock.sh desk/bin/prose-facts.mjs
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { usageLocks } from '../desk/bin/prose-facts.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'desk', 'bin', 'with-lock.sh');

// The classes the `case "$name" in` that picks the lock file accepts: each arm's labels but `*`.
function acceptedLocks(text) {
  const body = /case "\$name" in\n([\s\S]*?)\n\s*esac/.exec(text)?.[1] ?? '';
  return [...body.matchAll(/^\s*([a-z][a-z|]*)\)/gm)].flatMap((m) => m[1].split('|'));
}
// Each class one side has and the other lacks, named with the side it is missing from.
const mismatched = (text) => {
  const usage = usageLocks(text), accepted = acceptedLocks(text);
  return [...usage.filter((c) => !accepted.includes(c)).map((c) => `${c}: in the usage line, not accepted`),
    ...accepted.filter((c) => !usage.includes(c)).map((c) => `${c}: accepted, not in the usage line`)];
};
const text = readFileSync(script, 'utf8');

// #881 AC5
t('#881 the usage line lists every class the script accepts, and only those', mismatched(text), []);
t('#881 the usage line is read', usageLocks(text).length > 0, true);
const usage = usageLocks(text);
const added = text.replace(`<${usage.join('|')}>`, `<${[...usage, 'gpu'].join('|')}>`);
t('#881 a class added to the usage line alone is named', added === text ? 'usage line not found' : mismatched(added), ['gpu: in the usage line, not accepted']);
const accepted = text.replace(/(\n\s*)browser\)/, '$1browser|gpu)');
t('#881 a class added to the case alone is named', accepted === text ? 'case arm not found' : mismatched(accepted), ['gpu: accepted, not in the usage line']);

// The real script runs a command under each listed class, and refuses one it does not list.
const lockDir = mkdtempSync(join(tmpdir(), 'with-lock-'));
try {
  const env = { ...process.env, DESK_LOCK_DIR: lockDir, DESK_TEST_LOCK_SLOTS: '1' };
  const run = (cls) => spawnSync('bash', [script, cls, '--', 'true'], { env, encoding: 'utf8' });
  t('#881 every class in the usage line runs a command', usageLocks(text).filter((c) => run(c).status !== 0), []);
  const bad = run('gpu');
  t('#881 a class not in the usage line is refused', [bad.status, bad.stderr.trim()], [2, "with-lock.sh: unknown lock 'gpu'"]);
} finally { rmSync(lockDir, { recursive: true, force: true }); }

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
