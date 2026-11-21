// suite: conflict record (merge-time conflicts per file, and the per-file budget they lower)
import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { conflictsPath, readConflicts, recordConflicts, conflictTimes, loweredBy, recentCount, CONFLICT_WINDOW_MS } from '../desk/bin/conflict-record.mjs';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (days) => NOW - days * DAY;
const k = (times, configured) => configured - loweredBy(times, configured, NOW);

t('the window is 7 days', CONFLICT_WINDOW_MS, 7 * DAY);
t('the record is the repo\'s, shared by its batches', conflictsPath('/s/acme__w/batches/DS-1'), '/s/acme__w/conflicts.jsonl');
t('the standing batch\'s state is the repo\'s', conflictsPath('/s/acme__w'), '/s/acme__w/conflicts.jsonl');

// AC2: three conflicts in the last 7 days lower k by one.
t('AC2 no conflicts: configured k', k([], 3), 3);
t('AC2 two conflicts in 7 days: configured k', k([ago(1), ago(2)], 3), 3);
t('AC2 three conflicts in 7 days: one lower', k([ago(1), ago(2), ago(3)], 3), 2);
t('AC2 three conflicts spread over more than 7 days: configured k', k([ago(20), ago(12), ago(3)], 3), 3);
t('AC2 six in 7 days: one lower per three', k([ago(6), ago(5), ago(4), ago(3), ago(2), ago(1)], 3), 1);
t('AC2 conflicts on one PR at three heads count three times', k([ago(1), ago(1), ago(1)], 2), 1);
t('a conflict dated after now is not read', k([ago(1), ago(2), NOW + DAY], 3), 3);

// AC3: 7 days with none raises it by one, never above configured.
t('AC3 lowered, 6 days quiet: still lower', k([ago(9), ago(8), ago(6)], 3), 2);
t('AC3 lowered, 7 days quiet: back to configured', k([ago(10), ago(9), ago(7)], 3), 3);
t('AC3 lowered twice, 7 days quiet: up by one only', k([ago(12), ago(11), ago(10), ago(9), ago(8), ago(7)], 3), 2);
t('AC3 lowered twice, 14 days quiet: up by two', k([ago(19), ago(18), ago(17), ago(16), ago(15), ago(14)], 3), 3);
t('AC3 never above configured, however long quiet', k([ago(100), ago(99), ago(98)], 3), 3);
t('AC3 a conflict after the lowering restarts the quiet days', k([ago(12), ago(11), ago(10), ago(5)], 3), 2);

// AC4: a file whose configured k is 1 stays 1.
t('AC4 configured 1, three conflicts: stays 1', k([ago(1), ago(2), ago(3)], 1), 1);
t('AC4 configured 2, nine conflicts: never below 1', k([1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => ago(d / 2)), 2), 1);
t('AC4 a cap at 1 then 7 days quiet: back up one', k([ago(10), ago(9.9), ago(9.8), ago(9.7), ago(9.6), ago(9.5), ago(9)], 2), 2);

t('recentCount counts the last 7 days', recentCount([ago(1), ago(6.9), ago(7), ago(30)], NOW), 2);

// The record on disk.
const dir = scratch('conflict-record-');
const file = join(dir, 'state', 'conflicts.jsonl');
t('a missing record reads as empty', JSON.stringify(readConflicts(file)), '{"entries":[],"bad":null}');
const at = '2026-11-17T12:00:00.000Z';
const r1 = recordConflicts(file, { files: ['src/a.ts', 'src/b.ts', 'src/a.ts'], ticket: 'DS-1', pr: 701, head: 'h1', at });
t('AC1 one entry per conflicting file', r1.recorded.join(','), 'src/a.ts,src/b.ts');
const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
t('AC1 naming the file, ticket, PR and time', JSON.stringify(lines[0]), JSON.stringify({ file: 'src/a.ts', ticket: 'DS-1', pr: 701, head: 'h1', at }));
t('AC1 the same conflict at the same head is not recorded twice', recordConflicts(file, { files: ['src/a.ts'], ticket: 'DS-1', pr: 701, head: 'h1', at }).recorded.length, 0);
t('AC1 a new head in conflict again is recorded', recordConflicts(file, { files: ['src/a.ts'], ticket: 'DS-1', pr: 701, head: 'h2', at }).recorded.join(','), 'src/a.ts');
t('AC6 a base sync records with no PR, by its commits', recordConflicts(file, { files: ['src/a.ts'], ticket: 'base-feat-x', head: 'b1', source: 'm1', at }).recorded.join(','), 'src/a.ts');
t('AC6 and the same sync again is not recorded twice', recordConflicts(file, { files: ['src/a.ts'], ticket: 'base-feat-x', head: 'b1', source: 'm1', at }).recorded.length, 0);
t('AC6 the default branch moving on is a new conflict', recordConflicts(file, { files: ['src/a.ts'], ticket: 'base-feat-x', head: 'b1', source: 'm2', at }).recorded.length, 1);
const read = readConflicts(file);
t('the record reads back', `${read.entries.length} ${read.bad}`, '5 null');
t('by file, ticket PRs only', JSON.stringify([...conflictTimes(read.entries)].map(([f, ts]) => [f, ts.length])), '[["src/a.ts",2],["src/b.ts",1]]');

// DS-940: base syncs (ticket base-<branch>, no PR) lower no file's places; ticket PRs still do.
const mixed = join(dir, 'mixed.jsonl');
const iso = (ms) => new Date(ms).toISOString();
const places = (entries, f, configured) => k(conflictTimes(entries).get(f) ?? [], configured);
[1, 2, 3, 4, 5].forEach((d) => recordConflicts(mixed, { files: ['src/big.ts'], ticket: 'base-feat-x', head: 'b1', source: `m${d}`, at: iso(ago(d)) }));
const onlyBase = readConflicts(mixed).entries;
t('DS-940 AC1 a file with only base-sync entries keeps its configured places', places(onlyBase, 'src/big.ts', 3), 3);
t('DS-940 AC1 and has no ticket conflicts to count', conflictTimes(onlyBase).has('src/big.ts'), false);
[1, 2, 3].forEach((d) => recordConflicts(mixed, { files: ['src/big.ts'], ticket: `DS-${d}`, pr: 800 + d, head: `h${d}`, at: iso(ago(d)) }));
t('DS-940 AC2 three ticket-PR conflicts in the window still lower it by one', places(readConflicts(mixed).entries, 'src/big.ts', 3), 2);
t('DS-940 AC2 counting the ticket PRs and not the base syncs', conflictTimes(readConflicts(mixed).entries).get('src/big.ts').length, 3);
const stuck = Array.from({ length: 50 }, (_, i) => ({ file: 'src/pass.mjs', ticket: 'base-feat-usage', pr: null, head: 'stuck', source: `m${i}`, at: iso(ago(i / 10)) }));
t('DS-940 AC3 a base stuck at one head over 50 default-branch commits lowers nothing', places(stuck, 'src/pass.mjs', 3), 3);
const legacy = join(dir, 'legacy.jsonl');
writeFileSync(legacy, stuck.map((e) => `${JSON.stringify(e)}\n`).join(''));
const legacyRead = readConflicts(legacy);
t('DS-940 AC4 an existing record of base-sync entries reads, unedited', `${legacyRead.entries.length} ${legacyRead.bad}`, '50 null');
t('DS-940 AC4 and lowers no file', conflictTimes(legacyRead.entries).size, 0);
t('DS-940 a ticket PR whose key starts base- still counts', conflictTimes([{ file: 'f', ticket: 'base-x', pr: 9, at }]).size, 1);

// AC5: a record that does not read.
writeFileSync(file, `${readFileSync(file, 'utf8')}{"file": "src/c.ts", "at": "not a time"}\nnot json\n`);
const broken = readConflicts(file);
t('AC5 a line that is not an entry: the record is bad, naming the line', broken.bad, `${file} line 6 is not a conflict entry`);
t('AC5 the lines that read are still kept, so a write does not repeat them', broken.entries.length, 5);
t('AC5 a write to a bad record still skips what it holds', recordConflicts(file, { files: ['src/b.ts'], ticket: 'DS-1', pr: 701, head: 'h1', at }).recorded.length, 0);
const unreadable = join(dir, 'locked.jsonl');
writeFileSync(unreadable, '');
chmodSync(unreadable, 0o000);
const locked = readConflicts(unreadable);
if (locked.bad) t('AC5 a record that cannot be read is bad', /could not be read/.test(locked.bad), true);
else console.log('SKIP an unreadable file reads here (running as root)');
chmodSync(unreadable, 0o600);
mkdirSync(join(dir, 'ro'));
chmodSync(join(dir, 'ro'), 0o500);
const w = recordConflicts(join(dir, 'ro', 'conflicts.jsonl'), { files: ['x'], ticket: 'DS-1', pr: 1, head: 'h', at });
if (w.error) t('a write that fails says so and records nothing', `${w.recorded.length} ${/could not be written/.test(w.error)}`, '0 true');
else console.log('SKIP a read-only folder is writable here (running as root)');
chmodSync(join(dir, 'ro'), 0o700);
rmSync(dir, { recursive: true, force: true });

console.log(fails ? `${fails} failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
