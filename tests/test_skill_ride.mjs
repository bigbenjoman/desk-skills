// suite: skill-ride (skill-file Reads per start stage and the share of turns they ride)
// layer: L2
import { mkdirSync, writeFileSync, utimesSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logSessions, stageRows, stageFiles, collect, rideOf, UNKNOWN } from '../desk/bin/skill-ride.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'skill-ride.mjs');
const dir = realpathSync(scratch('skill-ride-test-'));
const skills = join(dir, 'skills');
const logs = join(dir, 'logs');
mkdirSync(logs, { recursive: true });

const NOW = new Date();
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
const spawn = (stage, at = NOW.toISOString()) => ({ type: 'desk_spawn', session: 's', stage, model: 'opus', effort: 'medium', at });
let n = 0;
// One model call; `reads` are the Read calls it makes.
const turn = (reads = [], extra = {}) => {
  n += 1;
  return { type: 'assistant', message: { id: `msg_${n}`, content: [{ type: 'text', text: 'working' }, ...reads.map(([id, file]) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: file } }))] }, ...extra };
};
const result = (id, text) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const lines = (...events) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;

// A start-4b session of four turns: a skill Read at turn 0 rides 3 of 4, one at turn 2 rides 1 of 4.
// A repo file, a subagent's skill Read and a second content block of the same message count for nothing.
const a = `${skills}/desk-review/SKILL.md`, b = `${skills}/desk-pr/SKILL.md`;
const session4b = [
  spawn('4b'),
  turn([['r1', a]]),
  result('r1', 'x'.repeat(1000)),
  turn([['r2', `${dir}/repo/src.js`]]),
  result('r2', 'y'.repeat(5000)),
  turn([['r3', b]]),
  { type: 'assistant', message: { id: `msg_${n}`, content: [{ type: 'text', text: 'same message, another block' }] } },
  result('r3', [{ type: 'text', text: 'z'.repeat(3000) }]),
  turn([['r4', a]], { parent_tool_use_id: 'task_1' }),
  result('r4', 'w'.repeat(9000)),
  turn(),
];
const s = logSessions(lines(...session4b), [skills]);
t('one session', s.length, 1);
t('its stage is the spawn\'s', s[0].stage, '4b');
t('a subagent\'s call and a repeated message id are not turns', s[0].turns, 4);
t('only main-thread skill Reads count', s[0].reads.map((r) => `${r.turn}:${r.bytes}`).join(' '), '0:1000 2:3000');
t('a Read at turn 0 of 4 rides three quarters', rideOf(s[0].reads[0], 4), 0.75);

// A second spawn in the same log is a new session, and a log with no spawn is stage unknown.
const twoSpawns = logSessions(lines(...session4b, spawn('7'), turn([['r9', a]]), result('r9', 'v'.repeat(10)), turn()), [skills]);
t('each spawn opens its own session', twoSpawns.map((x) => `${x.stage}/${x.turns}/${x.reads.length}`).join(' '), '4b/4/2 7/2/1');
t('a log with no spawn is stage unknown', logSessions(lines(turn([['u1', a]]), result('u1', 'q')), [skills])[0].stage, UNKNOWN);

const rows = stageRows(twoSpawns);
const r4b = rows.find((r) => r.stage === '4b');
t('bytes per stage', r4b.bytes, 4000);
t('the mean remaining-turn fraction', r4b.meanRide, (0.75 + 0.25) / 2);
t('the byte-weighted fraction', r4b.byteRide, (0.75 * 1000 + 0.25 * 3000) / 4000);
t('a stage read most is listed first', rows[0].stage, '4b');
const files = stageFiles(twoSpawns, '4b');
t('the files a stage read, most bytes first', files.files.map((f) => `${f.file.slice(skills.length + 1)}:${f.sessions}:${f.bytes}`).join(' '), 'desk-pr/SKILL.md:1:3000 desk-review/SKILL.md:1:1000');

// AC1: the CLI over a logs folder prints the per-stage table, leaving out sessions spawned before the
// window and reading a gzipped round.
writeFileSync(join(logs, 'DS-1.log'), lines(...session4b));
writeFileSync(join(logs, 'DS-2.log.round1.gz'), gzipSync(lines(spawn('7'), turn([['g1', b]]), result('g1', 'g'.repeat(2048)), turn())));
writeFileSync(join(logs, 'DS-3.log'), lines(spawn('4b', ago(20)), turn([['o1', a]]), result('o1', 'o'.repeat(777)), turn()));
writeFileSync(join(logs, 'DS-4.log'), lines(spawn('0'), turn([['x1', a]]), result('x1', 'x')));
const old = (Date.now() - 30 * 86400000) / 1000;
utimesSync(join(logs, 'DS-4.log'), old, old);
writeFileSync(join(logs, 'notes.txt'), 'not a log');

const got = collect(logs, [skills], Date.now() - 14 * 86400000);
t('the window keeps recent spawns only', got.map((x) => x.stage).sort().join(' '), '4b 7');

const run = spawnSync(process.execPath, [SCRIPT, '--logs', logs, '--skills', skills], { encoding: 'utf8' });
t('AC1 the script runs', run.status, 0);
if (run.status !== 0) console.log(run.stderr);
t('AC1 a 4b row with its bytes and fractions', run.stdout.includes('| 4b | 1 | 1 | 2 | 3.9 KiB | 3.9 KiB | 50.0% | 37.5% |'), true);
t('AC1 a 7 row from the gzipped round', run.stdout.includes('| 7 | 1 | 1 | 1 | 2.0 KiB | 2.0 KiB | 50.0% | 50.0% |'), true);
t('AC1 no row for the session before the window', /\| 0 \|/.test(run.stdout), false);
const listed = spawnSync(process.execPath, [SCRIPT, '--logs', logs, '--skills', skills, '--files', '4b'], { encoding: 'utf8' });
t('--files lists one stage\'s files', listed.stdout.includes(`| ${b} | 1 | 1 | 2.9 KiB |`), true);
t('a bad --days is refused', spawnSync(process.execPath, [SCRIPT, '--days', '0'], { encoding: 'utf8' }).status, 2);

if (fails) { console.log(`FAIL ${fails} check(s) failed`); process.exit(1); }
