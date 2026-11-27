// suite: handoff briefing write command and lenient readers (raw control characters in strings)
// layer: L2
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHandoff, resumeCheck, escapeRawControls, parseJsonLenient, replaceUnreadable, handoffPath, renderHandoff, handoffStage } from '../desk/bin/handoff.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const HANDOFF = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'handoff.mjs');
const T = scratch('handoff-write-');
const state = join(T, 'state');
mkdirSync(state, { recursive: true });
const write = (...args) => spawnSync('node', [HANDOFF, 'write', ...args], { encoding: 'utf8', env: { ...process.env, DESK_AUTOPILOT_STATE: state, DESK_LEVER_VALUES: '' } });
const writeOn = (values, ...args) => spawnSync('node', [HANDOFF, 'write', ...args], { encoding: 'utf8', env: { ...process.env, DESK_AUTOPILOT_STATE: state, DESK_LEVER_VALUES: values } });

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
t('a stage no session starts at is refused', write('W-3', '--stage', '2', '--criterion', 'x').status !== 0 && !existsSync(handoffPath(state, 'W-3')), true);
t('every stage a resume starts at is a handoff stage', ['3', '4', '4b', '5', '6', '7', '8', '9', '5/9'].map(handoffStage).join(' '), '3 4 4b 5 6 7 8 9 5');
t('an unknown flag is refused', write('W-3', '--stage', '7', '--criterion', 'x', '--scratch', 'y').status !== 0, true);
t('a ticket id with .. is refused', write('../W-3', '--stage', '7', '--criterion', 'x').status !== 0, true);

// DS-1037 AC2: a worker drawn 30 hands off partway through Stage 5: the briefing records what is left of
// the stage, the context it fired at and the lever value, and the next session's briefing words it.
const mid = writeOn('question-handling=batched handoff-threshold=30', 'M-1', '--stage', '5', '--criterion', 'AC1: saves', '--lane', 'A',
  '--left', 'capture the after screenshot', '--left', 'then Stage 6', '--context', '31');
let md = null;
try { md = JSON.parse(readFileSync(handoffPath(state, 'M-1'), 'utf8')); } catch { /* left null */ }
t('AC2 a mid-stage write exits 0 and says the stage and lever value', JSON.stringify([mid.status, /for Stage 5, mid-stage at 31% \(handoff-threshold 30\)/.test(mid.stdout)]), '[0,true]');
t('AC2 the handoff record names the lever value, the context and what is left', JSON.stringify([md?.stage, md?.threshold, md?.context, md?.left]), JSON.stringify(['5', '30', 31, ['capture the after screenshot', 'then Stage 6']]));
const off = write('M-2', '--stage', '4', '--criterion', 'AC1: saves', '--left', 'wire the hook', '--context', '46%');
t('AC4 with no lever value the record says config', `${off.status} ${JSON.parse(readFileSync(handoffPath(state, 'M-2'), 'utf8')).threshold}`, '0 config');
t('a mid-stage write needs the context it fired at', write('M-3', '--stage', '5', '--criterion', 'x', '--left', 'y').status !== 0 && !existsSync(handoffPath(state, 'M-3')), true);
t('and --context alone is refused', write('M-3', '--stage', '5', '--criterion', 'x', '--context', '30').status !== 0, true);
t('a stage-boundary write records no mid-stage fields', ['left', 'context', 'threshold'].some((k) => k in parsed), false);
const rm = readHandoff(state, 'M-1');
t('AC3 the pass reads it as a mid-stage briefing', JSON.stringify(rm.data?.midStage), JSON.stringify({ left: ['capture the after screenshot', 'then Stage 6'], context: 31, threshold: '30' }));
const brief = renderHandoff({ key: 'M-1', stage: '5', data: rm.data, branch: 'feat/M-1', worktree: '/wt/M-1', base: 'origin/main', commits: ['abc1234 wip: M-1 evidence'] });
t('AC3 the fresh session starts at the same stage', brief.startsWith('## Handoff: this session starts at Stage 5'), true);
t('AC3 its briefing says it was handed off partway through on context', /finished Stages 0 to 4b and handed off partway through Stage 5, as its context passed the handoff threshold \(31% used; handoff-threshold 30\)/.test(brief), true);
t('AC3 and lists what is left of the stage', brief.includes('### Left of Stage 5\n\n- capture the after screenshot\n- then Stage 6\n'), true);
t('a stage-boundary briefing has no Left of Stage section', renderHandoff({ key: 'W-1', stage: '7', data: readHandoff(state, 'W-1').data, branch: 'b', worktree: '/w', base: 'origin/main', commits: [] }).includes('### Left of Stage'), false);

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
