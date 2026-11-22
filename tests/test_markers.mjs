// suite: markers (every AUTOPILOT_ name the code uses is exactly one of a marker or a variable)
// layer: L1
// covers: desk/bin/markers.mjs desk/bin/prose-facts.mjs desk/bin/harvest.mjs
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { autopilot, autopilotNames } from '../desk/bin/prose-facts.mjs';
import { MARKERS, ENV } from '../desk/bin/markers.mjs';
import { MARKER } from '../desk/bin/harvest.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

// Each name the code uses that neither list holds, with the files using it.
const unlisted = (used, { markers, variables }) => Object.entries(used).filter(([n]) => !markers.includes(n) && !variables.includes(n)).map(([n, files]) => `${n} in ${files.join(', ')}`);
const doubled = ({ markers, variables }) => markers.filter((n) => variables.includes(n));

const a = autopilot();
const used = autopilotNames();

// #881 AC1: a name the code uses is in one of the lists.
t('#881 every AUTOPILOT_ name under desk/bin and the skills\' bins is a marker or a variable', unlisted(used, a), []);
// #881 AC2: no name is in both.
t('#881 no AUTOPILOT_ name is both a marker and a variable', doubled(a), []);
// #881 AC3
t('#881 AUTOPILOT_PARK is a marker', [a.markers.includes('AUTOPILOT_PARK'), a.variables.includes('AUTOPILOT_PARK')], [true, false]);
t('#881 AUTOPILOT_BUDGET_USD is a variable', [a.variables.includes('AUTOPILOT_BUDGET_USD'), a.markers.includes('AUTOPILOT_BUDGET_USD')], [true, false]);
t('#881 the registry reads markers.mjs', [a.markers, a.variables], [[...MARKERS], [...ENV]]);
t('#881 every listed name is one the code uses outside markers.mjs', [...a.markers, ...a.variables].filter((n) => !(used[n] ?? []).some((f) => f !== 'desk/bin/markers.mjs')), []);
t('#881 harvest reads every marker', MARKERS.filter((n) => ![...`${n}: x`.matchAll(MARKER)].some((m) => m[1] === n)), []);

// The checks above, on a tree that breaks them: they name the name and the file.
const root = scratch('markers-');
try {
  mkdirSync(join(root, 'desk', 'bin', 'pass'), { recursive: true });
  mkdirSync(join(root, 'skills', 'desk-x', 'bin'), { recursive: true });
  writeFileSync(join(root, 'desk', 'bin', 'pass', 'x.mjs'), "process.env.AUTOPILOT_NEW_KNOB; env.DESK_AUTOPILOT_WORKER; 'AUTOPILOT_PARK:'\n");
  writeFileSync(join(root, 'skills', 'desk-x', 'bin', 'y.sh'), 'echo "AUTOPILOT_NEW_KNOB=$AUTOPILOT_BUDGET_USD"\n');
  writeFileSync(join(root, 'README.md'), 'AUTOPILOT_OUTSIDE_BIN\n');
  const planted = autopilotNames(root);
  t('#881 AC1 a planted name in neither list fails, naming it and each module', unlisted(planted, a),
    ['AUTOPILOT_NEW_KNOB in desk/bin/pass/x.mjs, skills/desk-x/bin/y.sh']);
  t('#881 a name inside a longer one (DESK_AUTOPILOT_WORKER) is not read as AUTOPILOT_WORKER', 'AUTOPILOT_WORKER' in planted, false);
  t('#881 AC2 a name in both lists fails, naming it', doubled({ markers: [...MARKERS, 'AUTOPILOT_PORT'], variables: [...ENV] }), ['AUTOPILOT_PORT']);
} finally { rmSync(root, { recursive: true, force: true }); }

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
