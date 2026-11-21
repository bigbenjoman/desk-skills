// suite: prose scanner, the inventory of code references in skills
// covers: tests/fixtures/prose-scan/*.md skills/**/*.md agents/*.md
// Each fixture under tests/fixtures/prose-scan/ holds one kind of reference; the scanner must report
// it with its file and line, and read nothing outside code spans, shell blocks and tagged regions.
// Then the CLI's JSON inventory of the real tree.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFiles } from './prose_scan.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const F = join(R, 'tests/fixtures/prose-scan');
const refs = (f) => scanFiles([join(F, f)], R);
const show = (rs) => rs.map((r) => `${r.line} ${r.kind} ${r.value}${r.of ? ` of ${r.of}` : ''}${r.kind === 'lock' ? ` row ${r.row}` : ''}`).join(', ');
const only = (f, ...kinds) => show(refs(f).filter((r) => kinds.includes(r.kind)));

// ---- AC1: a queue park call in a shell block ---------------------------------------------------
const park = refs('queue-park.md');
t('AC1 one command, one subcommand and one flag, each at the call\'s line',
  show(park), '4 command queue.mjs, 4 subcommand park of queue.mjs, 4 flag --clears-when of queue.mjs park');
t('AC1 each carries the fixture\'s file', park.every((r) => r.file === 'tests/fixtures/prose-scan/queue-park.md'), true);
t('AC1 the context is the command, without its comment',
  park[0].context, 'node ~/.claude/desk/bin/queue.mjs park ABC-123 "<question>" --clears-when "run 12 completed"');

// ---- AC2: plain prose is never read -------------------------------------------------------------
t('AC2 a queue command, a flag, a marker and a state in plain prose report nothing', show(refs('prose-only.md')), '');

// ---- AC3: a lock paired with its § command row ---------------------------------------------------
t('AC3 browser beside the § E2E tests row, written either way; a lock with no command pairs with none',
  only('lock.md', 'lock'), '4 lock browser row e2e-cmd, 5 lock browser row e2e-cmd, 8 lock test row null');
t('a <§N Row name> placeholder and a desk-env cmds id are row references', only('lock.md', 'row'), '4 row §4 E2E tests, 8 row test-cmd');

// ---- AC4: a state-folder path keeps its placeholders ---------------------------------------------
t('AC4 the park file and a placeholder with spaces, as written', only('state-path.md', 'state-path'),
  '3 state-path parks/<TICKET>.json, 4 state-path designs/<EPIC or KEY>/');

// ---- AC5: an untagged JSON block is not read; a tagged one is ------------------------------------
const json = refs('json.md');
t('AC5 nothing from the untagged block', json.filter((r) => r.line < 10).length, 0);
t('a tagged block reports its contract, and the names inside it', show(json), '12 contract park-file, 14 autopilot AUTOPILOT_PARK, 15 state parked');

// ---- the other reading rules ---------------------------------------------------------------------
const mixed = refs('mixed.md');
t('a span that wraps reports at its first line; a span after "§3" in prose is not a row',
  show(mixed.filter((r) => r.line <= 5)),
  '3 command desk-env, 3 subcommand get of desk-env, 3 row default-branch, 4 script ~/.claude/desk/bin/pass.mjs, 5 row §4 Merge method, 5 row §3 pr-merge-green');
t('a facts region is named, and the spans inside it are read as facts',
  show(mixed.filter((r) => r.line >= 7 && r.line <= 9)) + ' | ' + mixed.filter((r) => r.line === 8).every((r) => r.in === 'facts'),
  '7 facts refuter-vendors, 8 state triaged, 8 command queue.mjs, 8 subcommand set of queue.mjs, 8 state triaged | true');
t('desk-env skips --batch <name>; a shell comment is prose',
  show(mixed.filter((r) => r.line >= 12)), '12 command desk-env, 12 subcommand list of desk-env, 12 row required-checks, 13 autopilot AUTOPILOT_STAGE');

// ---- AC6: the CLI's JSON inventory of the real tree -----------------------------------------------
const cli = spawnSync(process.execPath, [join(R, 'tests/prose_scan.mjs'), '--json'], { cwd: R, encoding: 'utf8' });
t('AC6 the CLI exits 0', cli.status, 0);
let records = [];
try { records = JSON.parse(cli.stdout); } catch (e) { console.log(`FAIL not JSON: ${e.message}`); fails++; }
t('AC6 one record per reference, from the skills and the agents', records.length > 0 && records.every((r) => /^(skills|agents)\//.test(r.file)), true);
const fields = ['kind', 'value', 'context', 'file', 'line'];
const bad = records.filter((r) => fields.some((k) => r[k] === undefined || r[k] === '') || !Number.isInteger(r.line) || r.line < 1);
for (const r of bad.slice(0, 5)) console.log(`FAIL incomplete record: ${JSON.stringify(r)}`);
t('AC6 every record has kind, value, context, file and line', bad.length, 0);
t('AC6 every file named exists', records.every((r) => existsSync(join(R, r.file))), true);
t('AC6 the worker contract\'s markers are in the inventory',
  records.some((r) => r.kind === 'autopilot' && r.file.startsWith('skills/desk-autopilot/')), true);
t('AC6 one record per line of output', cli.stdout.trim().split('\n').length, records.length + 2);

process.exit(fails ? 1 : 0);
