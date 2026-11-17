// suite: handoff briefing write command and lenient readers (raw control characters in strings)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readHandoff, resumeCheck, escapeRawControls, parseJsonLenient, replaceUnreadable, handoffPath } from '../desk/bin/handoff.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const HANDOFF = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'handoff.mjs');
const T = mkdtempSync(join(tmpdir(), 'handoff-write-'));
process.on('exit', () => rmSync(T, { recursive: true, force: true }));
const state = join(T, 'state');
mkdirSync(state, { recursive: true });
const write = (...args) => spawnSync('node', [HANDOFF, 'write', ...args], { encoding: 'utf8', env: { ...process.env, DESK_AUTOPILOT_STATE: state } });

// AC3: a criterion holding a tab and a double quote is written as JSON and read back unchanged.
const crit = 'AC1: the "widget"\tsaves';
const w = write('W-1', '--stage', '7', '--criterion', crit, '--criterion', '- AC2: a leading dash', '--lane', 'A', '--verification', 'tests/run.sh\tpass',
  '--verification', 'git diff origin/main...HEAD: shows "Loading..."');
const path = handoffPath(state, 'W-1');
t('AC3 the write command exits 0', w.status, 0);
let parsed = null;
try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { /* left null */ }
t('AC3 the file it writes parses as JSON', parsed !== null, true);
t('AC3 and holds the criterion unchanged', parsed?.criteria?.[0], crit);
t('AC3 a value starting with a dash is taken as the value', parsed?.criteria?.[1], '- AC2: a leading dash');
t('AC3 the stage, lane and verification are recorded', `${parsed?.stage} ${parsed?.lane} ${parsed?.verification?.[0]}`, '7 A tests/run.sh\tpass');
t('AC3 a value holding .. is kept as written', parsed?.verification?.[1], 'git diff origin/main...HEAD: shows "Loading..."');
t('AC3 the pass reads it as a handoff briefing', readHandoff(state, 'W-1').data?.criteria?.[0], crit);

// AC4: no criterion exits non-zero, writes no file and says a criterion is required.
const none = write('W-2', '--stage', '4b', '--lane', 'A');
t('AC4 no criterion exits non-zero', none.status !== 0, true);
t('AC4 and writes no file', existsSync(handoffPath(state, 'W-2')), false);
t('AC4 and says a criterion is required', /a criterion is required/.test(none.stderr), true);
t('a stage no session starts at is refused', write('W-3', '--stage', '5', '--criterion', 'x').status !== 0 && !existsSync(handoffPath(state, 'W-3')), true);
t('an unknown flag is refused', write('W-3', '--stage', '7', '--criterion', 'x', '--scratch', 'y').status !== 0, true);
t('a ticket id with .. is refused', write('../W-3', '--stage', '7', '--criterion', 'x').status !== 0, true);

// The readers: a raw TAB or newline inside a string is escaped and parsed; outside a string it is kept.
t('a raw tab in a string is escaped', escapeRawControls('{"a":\t"x\ty"}'), '{"a":\t"x\\u0009y"}');
t('an escaped quote does not end the string', parseJsonLenient('{"a":"say \\"hi\\"\tnow"}').a, 'say "hi"\tnow');
let threw = false;
try { parseJsonLenient('{"a": oops}'); } catch { threw = true; }
t('text that is still not JSON throws', threw, true);
writeFileSync(handoffPath(state, 'W-4'), '{"ticket":"W-4","criteria":["AC1: saves"],"verification":["typecheck:\tpass"]}');
const r4 = readHandoff(state, 'W-4');
t('AC1 a hand-written briefing with a raw tab reads, its verification line kept', `${r4.ok} ${r4.data?.verification?.[0]}`, 'true typecheck:\tpass');
writeFileSync(handoffPath(state, 'W-5'), '{"ticket": "W-5", criteria: [');
const r5 = readHandoff(state, 'W-5');
t('AC2 one that is still not JSON is unreadable', `${r5.ok} ${r5.unreadable}`, 'false true');
const kept = replaceUnreadable(state, { key: 'W-5', stage: '7' });
const r5b = readHandoff(state, 'W-5');
t('AC2 replaced, it is kept aside as it was', readFileSync(kept, 'utf8'), '{"ticket": "W-5", criteria: [');
t('AC2 and the replacement tells the session to read the criteria from the ticket', r5b.ok && /read them from W-5 at the start of Stage 7/.test(r5b.data.criteria[0]) && r5b.data.criteria[0].includes(kept), true);

// AC5: a resume file holding a raw newline in a string still gives its branch, so the round resumes.
const repo = join(T, 'repo');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
mkdirSync(repo);
git('init', '-q', '-b', 'fix/W-6');
git('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');
mkdirSync(join(state, 'resume'), { recursive: true });
writeFileSync(join(state, 'resume', 'W-6.json'), '{"ticket":"W-6","branch":"fix/W-6","note":"line one\nline two"}');
const rc = resumeCheck({ worktree: repo, key: 'W-6', branch: 'fix/W-6', stateDir: state });
t('AC5 a resume file with a raw newline reads its branch and resumes', rc.ok, true);
writeFileSync(join(state, 'resume', 'W-6.json'), '{"ticket":"W-6","branch":"fix/W-6-old","note":"a\tb"}');
t('and a lenient read still refuses another branch', resumeCheck({ worktree: repo, key: 'W-6', branch: 'fix/W-6', stateDir: state }).why, "its resume file is for branch fix/W-6-old, not the queue's fix/W-6");

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
