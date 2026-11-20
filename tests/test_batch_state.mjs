// suite: batch state (every path batch-state.mjs builds under the state folder is a declared state path)
// covers: desk/bin/batch-state.mjs
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_PATHS, statePath, openQuestion, parkApprove, readTriage } from '../desk/bin/batch-state.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The state-folder paths a source builds that are not declared: a join on the state folder (a first
// argument named for it: stateDir, STATE), which bypasses STATE_PATHS, or a statePath call naming a
// path STATE_PATHS lacks.
function undeclared(src) {
  const out = [];
  for (const m of src.matchAll(/join\(\s*(\w*(?:state|STATE)\w*)\s*,([^;\n]*)/g)) if (!/^\s*STATE_PATHS\[/.test(m[2])) out.push(`join(${m[1]},${m[2].replace(/\)+[^)]*$/, '')})`);
  for (const m of src.matchAll(/statePath\(\s*\w+\s*,\s*['"]([^'"]+)['"]/g)) if (!Object.hasOwn(STATE_PATHS, m[1])) out.push(m[1]);
  return out;
}
const src = readFileSync(join(root, 'desk', 'bin', 'batch-state.mjs'), 'utf8');

// #881 AC4
t('#881 batch-state.mjs builds no state-folder path outside STATE_PATHS', undeclared(src), []);
t('#881 it builds every declared one through statePath', Object.keys(STATE_PATHS).filter((n) => !src.includes(`statePath(stateDir, '${n}'`)), []);
t('#881 a join on the state folder is named', undeclared("const f = join(stateDir, 'fixtures', `${t}.json`);"), ["join(stateDir, 'fixtures', `${t}.json`)"]);
t('#881 a statePath call naming an undeclared path is named', undeclared("statePath(stateDir, 'fixtures', t)"), ['fixtures']);
let refused = null;
try { statePath('/s', 'fixtures', 'A-1'); } catch (e) { refused = e.message; }
t('#881 statePath refuses an undeclared path', refused, 'not a declared state path: fixtures');
t('#881 statePath fills in the ticket', statePath('/s', 'parks', 'A-1'), '/s/parks/A-1.json');

// The readers still find their files.
const dir = mkdtempSync(join(tmpdir(), 'batch-state-'));
try {
  for (const d of ['parks', 'answers', 'triage']) mkdirSync(join(dir, d));
  writeFileSync(join(dir, 'parks', 'A-1.json'), JSON.stringify({ question: 'q?', approve: { kind: 'jira-comment', target: 'A-1', body: 'b' } }));
  writeFileSync(join(dir, 'triage', 'A-1.json'), JSON.stringify({ lane: 'A' }));
  t('openQuestion reads the park file', openQuestion(dir, 'A-1'), 'q?');
  t('parkApprove reads its approve', parkApprove(dir, 'A-1', 'q?')?.body, 'b');
  t('readTriage reads the triage record', readTriage(dir, 'A-1'), { lane: 'A' });
  writeFileSync(join(dir, 'answers', 'A-1.txt'), 'yes');
  t('an answer beside it closes the question', openQuestion(dir, 'A-1'), null);
} finally { rmSync(dir, { recursive: true, force: true }); }

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
