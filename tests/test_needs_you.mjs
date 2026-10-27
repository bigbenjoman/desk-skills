// suite: needs-you (every item desk-q counts as needing the person, and recording each answer)
// covers: desk/bin/needs-you.mjs skills/desk-needs-you/**
// Fixture repos, queues, heartbeats, triage records and decision logs under a throwaway HOME,
// DESK_HOME and DESK_CONFIG_ROOT. DESK_HOME/bin links the real scripts, except answer.mjs: a fake
// that logs each call and then runs the real one. Nothing touches your real ~/.claude or state.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_BIN = join(ROOT, 'desk', 'bin');
const NOW = Date.now();
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();

const T = mkdtempSync(join(tmpdir(), 'desk-needs-you-'));
mkdirSync(join(T, 'bin'));
// macOS, with a fake launchctl that has each label in bin/loaded loaded.
writeFileSync(join(T, 'bin', 'launchctl'), '#!/bin/sh\ngrep -qxF "${2##*/}" "$(dirname "$0")/loaded" 2>/dev/null || exit 1\nexit 0\n', { mode: 0o755 });
writeFileSync(join(T, 'bin', 'loaded'), 'com.desk-skills.supervisor.acme__alpha\n');
// A fake gh that logs its arguments.
const GH_LOG = join(T, 'gh.log');
writeFileSync(join(T, 'bin', 'gh'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(GH_LOG)}\n`, { mode: 0o755 });
const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_PLATFORM: 'darwin', DESK_SKILLS_DIR: join(T, 'skills'), DESK_LOCK_DIR: join(T, 'locks'), PATH: `${join(T, 'bin')}:${process.env.PATH}` };
for (const k of Object.keys(process.env)) if (k.startsWith('DESK_') || k.startsWith('AUTOPILOT_')) delete process.env[k];
Object.assign(process.env, env);
mkdirSync(env.DESK_LOCK_DIR, { recursive: true });
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');

const BIN = join(env.DESK_HOME, 'bin');
mkdirSync(BIN, { recursive: true });
for (const f of readdirSync(REAL_BIN)) if (f !== 'answer.mjs') symlinkSync(join(REAL_BIN, f), join(BIN, f));
const ANSWERS = join(T, 'answers.log');
writeFileSync(join(BIN, 'answer.mjs'), `import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
appendFileSync(${JSON.stringify(ANSWERS)}, JSON.stringify({ args: process.argv.slice(2), queue: process.env.DESK_QUEUE }) + '\\n');
const r = spawnSync(process.execPath, [${JSON.stringify(join(REAL_BIN, 'answer.mjs'))}, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
`);
const answers = () => (existsSync(ANSWERS) ? readFileSync(ANSWERS, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

// One repo's checkout, config, queue, heartbeat, triage records and decision log.
function put(name, r) {
  const slug = `acme__${name}`;
  const root = join(T, 'repos', name);
  mkdirSync(root, { recursive: true });
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['-C', root, 'remote', 'add', 'origin', `https://github.com/acme/${name}.git`]);
  mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
    `## 2. Paths\n\n| Field | Value |\n|---|---|\n| Primary repo root | \`${root}\` |\n\n` +
    `## 3. Permissions\n\n| Key | Action | Recommended | Your setting |\n|---|---|---|---|\n| \`pr-ready\` | Undraft | \`ask\` | \`${r.prReady ?? 'no'}\` |\n` +
    '| `autopilot-merge` | The merge driver merges | `ask` | `no` |\n| `pr-merge-green` | Merge a green PR | `ask` | `no` |\n\n' +
    `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`${r.port}\` |\n| Autopilot worker concurrency | \`2 / 3\` | \`2 / 3\` |\n` +
    `| Batches run by | \`supervisor\` | \`${r.supervised ? 'supervisor' : 'session'}\` |\n`);
  const state = join(env.HOME, '.desk-autopilot', slug);
  if (!r.tickets) return;
  const q = join(env.DESK_HOME, 'repos', slug, 'queue.json');
  mkdirSync(dirname(q), { recursive: true });
  const tickets = Object.fromEntries(Object.entries(r.tickets).map(([k, v]) => [k, { key: k, added_at: minsAgo(600), ...v }]));
  writeFileSync(q, JSON.stringify({ version: 1, batch: `${name}-batch`, concurrency: 2, supervised: !!r.supervised, tickets }));
  mkdirSync(join(state, 'orchestrators'), { recursive: true });
  writeFileSync(join(state, 'orchestrators', 'q.json'), JSON.stringify({ queue: q, batch: `${name}-batch`, pid: 1, at: minsAgo(r.beat) }));
  for (const [k, v] of Object.entries(r.triage ?? {})) {
    mkdirSync(join(state, 'triage'), { recursive: true });
    writeFileSync(join(state, 'triage', `${k}.json`), JSON.stringify({ ticket: k, epic: null, ...v }));
  }
  if (r.decisions) writeFileSync(join(state, 'decisions.jsonl'), r.decisions.map((d) => JSON.stringify(d)).join('\n') + '\n');
}
const parked = (lane, m, question) => ({ state: 'parked', lane, park: { question, since: minsAgo(m) } });
put('alpha', { port: 3100, beat: 1, supervised: true, prReady: 'yes', tickets: {
  'A-1': parked('A', 180, 'Use the long copy or the short one?'),
  'A-2': parked('C', 120, 'lane C: the plan needs agreeing'),
  'A-3': { state: 'triaged', lane: 'A', open_questions: 2, added_at: minsAgo(60) },
  'A-4': { state: 'parked', lane: 'A', held_by: 'A-9', added_at: minsAgo(30), park: { question: 'held by orchestrator: blocked by A-9 — starts once their PRs merge' } },
  'A-5': { state: 'running', lane: 'A', stage: '3/9' },
  'A-6': parked('B', 10, 'PRODUCTION BROKEN: checkout returns 500'),
  'A-7': { ...parked('A', 20, 'spine awaiting approval: its acceptance specs passed'), result: { pr: 41 }, spine_check: { ok: true } },
  'A-8': parked('A', 50, 'size XL: split it before it is worked'),
}, triage: { 'A-3': { summary: 'Cap the list', unknowns: ['What is the cap?', 'Which page?'] } },
decisions: [{ id: 'd1', at: minsAgo(200), repo: 'acme/alpha', ticket: 'A-1', question: 'Which heading level?', options: ['h2', 'h3'], chose: 'h2', category: 'design' }] });
put('beta', { port: 3200, beat: 2, tickets: { 'B-1': parked('A', 300, 'Which endpoint?') } });
put('gamma', { port: 3300, beat: 120, tickets: { 'G-1': parked('A', 240, 'Retry or fail?') } });
put('delta', { port: 3400, beat: 3, tickets: { 'D-1': { state: 'running', lane: 'A' } } });
put('epsilon', { port: 3600 });

const N = await import('../desk/bin/needs-you.mjs');
const { loadRepos } = await import('../desk/bin/desk-q.mjs');
const queueOf = (name) => JSON.parse(readFileSync(join(env.DESK_HOME, 'repos', `acme__${name}`, 'queue.json'), 'utf8'));
const cli = (...args) => { const r = spawnSync(process.execPath, [join(REAL_BIN, 'needs-you.mjs'), ...args], { encoding: 'utf8', env: process.env, cwd: T }); return { code: r.status, out: r.stdout, err: r.stderr }; };

// ---- AC1: every item desk-q counts, in every repo, and nothing it does not
const c = N.collect();
t('AC1 across both repos with items, and not the running ticket', `${c.items.map((i) => i.t.key).sort().join()}`, 'A-1,A-2,A-3,A-4,A-6,A-7,A-8,B-1,G-1');

// ---- AC2: a PRODUCTION BROKEN park first, then the oldest first
t('AC2 order', c.items.map((i) => i.t.key).join(), 'A-6,B-1,G-1,A-1,A-2,A-3,A-8,A-4,A-7');
const skill = readFileSync(join(ROOT, 'skills', 'desk-needs-you', 'SKILL.md'), 'utf8');

// ---- AC3, AC12: one compact line per item, naming repo, ticket, kind, need and options, recommendation first
const list = cli('list');
const itemLines = list.out.split('\n').filter((l) => / \| /.test(l));
t('AC12 the list is one script call that exits 0', list.code, 0);
t('AC12 one line per item', itemLines.length, c.items.length);
t('AC3 each line names its repo and ticket, then what is needed, then the recommendation first',
  itemLines.every((l) => /^[a-z]+ [A-Z]-\d+ (parked|session|triage|held|spine)\b[^|]* \| .+ \| 1\. [a-z-]+ \(recommended: [^)]+\)/.test(l)), true);
t('AC3 a triage item asks its unknowns', itemLines.some((l) => l.startsWith('alpha A-3 triage') && l.includes('| What is the cap? · Which page? |')), true);
t('AC3 a hold nothing releases recommends release', itemLines.some((l) => l.startsWith('alpha A-4 held') && l.includes('A-9 is not in this queue') && l.includes('1. release (recommended:')), true);
t('AC12 each repo with items says who runs it', ['@ alpha: run by the supervisor', '@ beta: run by a live session (beta-batch)', '@ gamma: passes stopped'].every((s) => list.out.includes(s)), true);
t('AC5 a parked item offers to override its worker\'s decision', itemLines.some((l) => l.startsWith('alpha A-1 parked') && l.includes('override d1 (took "h2" on "Which heading level?")')), true);

t('AC6 a park triage made recommends opening it, not a resume a requeue would refuse', itemLines.some((l) => l.startsWith('alpha A-8 session') && l.includes('1. open (recommended:') && !l.includes('resume')), true);

// ---- AC13: a small skill
t('AC13 the skill is at most 6 KB', Buffer.byteLength(skill) <= 6144, true);

// ---- AC5: an override goes through digest.mjs override
const ov = N.record({ word: 'alpha', ticket: 'A-1', action: 'override d1', text: 'h3' });
const log = readFileSync(join(env.HOME, '.desk-autopilot', 'acme__alpha', 'decisions.jsonl'), 'utf8');
t('AC5 the override is in the decision log', `${ov.ok} ${log.includes('"override_of":"d1"') && log.includes('"chose":"h3"')}`, 'true true');

// ---- AC4: a parked lane A, B or E item offers no bare answer, which would leave it parked and counted
t('AC4 a parked item offers resume, not answer', itemLines.some((l) => l.startsWith('alpha A-1 parked') && l.includes('1. resume (recommended:') && !/\d\. answer\b/.test(l)), true);
const an1 = N.record({ word: 'alpha', ticket: 'A-1', action: 'answer', text: 'the short one' });
t('AC4 answer on a parked item is refused and records nothing', `${an1.ok} ${answers().length} ${N.collect().items.some((i) => i.t.key === 'A-1')}`, 'false 0 true');

// ---- AC4, AC6, AC14: an answer goes through digest.mjs answer; a resume requeues; a supervised repo needs nothing more
const res = N.record({ word: 'alpha', ticket: 'A-1', action: 'resume', text: 'the short one' });
const a1 = queueOf('alpha').tickets['A-1'];
t('AC4 the answer went through answer.mjs for that repo', JSON.stringify(answers().at(-1)), JSON.stringify({ args: ['A-1', 'the short one'], queue: join(env.DESK_HOME, 'repos', 'acme__alpha', 'queue.json') }));
t('AC6 the resumed ticket is requeued, ready for the next pass', `${res.ok} ${a1.state} ${a1.open_questions} ${a1.park}`, 'true triaged 0 null');
t('AC14 under the supervisor nothing more is asked of the session', `${res.message} ${/requeued; the next pass can spawn it/.test(res.line)}`, 'null true');
t('AC4 desk-q no longer counts it', N.collect().items.some((i) => i.t.key === 'A-1'), false);
const a3 = N.record({ word: 'alpha', ticket: 'A-3', action: 'answer', text: '20, the search page' });
t('AC4 an answered triage item drops off desk-q', `${a3.ok} ${N.collect().items.some((i) => i.t.key === 'A-3')}`, 'true false');

// ---- AC7: a lane C or D park is never requeued, and is offered to desk-ticket
const c2 = N.record({ word: 'alpha', ticket: 'A-2', action: 'resume', text: 'go' });
const o2 = N.record({ word: 'alpha', ticket: 'A-2', action: 'open' });
t('AC7 resume is refused for a lane C park', `${c2.ok} ${queueOf('alpha').tickets['A-2'].state}`, 'false parked');
t('AC7 open names the desk-ticket session', /\/desk-ticket A-2/.test(o2.line), true);
t('AC7 its recommendation is to open it', itemLines.some((l) => l.startsWith('alpha A-2 session') && l.includes('1. open (recommended:')), true);
// DS-297 AC3: a lane C or D park offers open and not-now only; a bare answer would leave it counted.
t('DS-297 AC3 a lane C park offers open and not-now only', itemLines.find((l) => l.startsWith('alpha A-2 session'))?.split(' | ').slice(2).join(' | ').replace(/ \([^)]*\)/g, ''), '1. open | 2. not-now');
const ca2 = N.record({ word: 'alpha', ticket: 'A-2', action: 'answer', text: 'go' });
t('DS-297 AC3 answer on a lane C park is refused', `${ca2.ok} ${/answer is not an action for a session item/.test(ca2.line)}`, 'false true');

// ---- AC8: "not now" goes in the not-now register
const n6 = N.record({ word: 'alpha', ticket: 'A-6', action: 'not-now' });
const reg = readFileSync(join(env.HOME, '.desk-autopilot', 'acme__alpha', 'not-now.jsonl'), 'utf8');
t('AC8 a parked item put off is in the register, through answer.mjs', `${n6.ok} ${reg.includes('PRODUCTION BROKEN: checkout returns 500')} ${answers().at(-1).args.join(' ')}`, 'true true A-6 not now');
const n4 = N.record({ word: 'alpha', ticket: 'A-4', action: 'not-now' });
t('AC8 a hold put off is in the register too, and stays held', `${n4.ok} ${readFileSync(join(env.HOME, '.desk-autopilot', 'acme__alpha', 'not-now.jsonl'), 'utf8').includes('"ticket":"A-4"')} ${queueOf('alpha').tickets['A-4'].held_by}`, 'true true A-9');

// ---- A spine approval runs as its own repo, and what is left for the person is shown, not refused
const s7 = N.record({ word: 'alpha', ticket: 'A-7', action: 'approve' });
const gh = existsSync(GH_LOG) ? readFileSync(GH_LOG, 'utf8') : '';
t('approve undrafts the PR in the spine\'s repo, under its config, not this checkout\'s', gh.trim(), 'pr ready 41 --repo acme/alpha');
t('approve that leaves the merge to the person is recorded, and says so', `${s7.ok} ${queueOf('alpha').tickets['A-7'].state} ${/merge PR #41 yourself/.test(s7.line)}`, 'true done true');

// ---- AC9: a named repo asks only about its own items
t('AC9 one repo', N.collect({ word: 'beta' }).items.map((i) => `${i.r.name} ${i.t.key}`).join(), 'beta B-1');

// ---- AC10: nothing needing the person is one line
t('AC10 nothing in a named repo', cli('list', 'delta').out.trim(), 'Nothing needs you in delta.');
const quiet = loadRepos().filter((r) => ['delta', 'epsilon'].includes(r.name));
t('AC10 nothing anywhere', N.listText(N.collect({ repos: quiet })), 'Nothing needs you.');

// ---- AC15: a live session's batch is not requeued; the session is named to message
const b1 = cli('record', 'beta', 'B-1', 'resume', 'the v2 one');
t('AC15 answered, not requeued', `${b1.code} ${queueOf('beta').tickets['B-1'].state} ${answers().at(-1).args.join(' ')}`, '0 parked B-1 the v2 one');
t('AC15 the session to message is named, with the requeue', /^MESSAGE beta-batch: B-1 was answered .*queue\.mjs requeue B-1/m.test(b1.out), true);
// DS-297 AC1: marked answered, so desk-q shows it waiting on the session, and it is not asked again.
const betaRow = () => loadRepos().find((r) => r.name === 'beta').rows.find((x) => x.t.key === 'B-1');
t('DS-297 AC1 the park is marked answered', typeof queueOf('beta').tickets['B-1'].park?.answered, 'string');
t('DS-297 AC1 desk-q shows it waiting, not needing you', betaRow().k, 'waiting');
t('DS-297 AC1 desk-needs-you does not ask about it again', N.collect().items.some((i) => i.t.key === 'B-1'), false);
const { ticketScreen, shownState } = await import('../desk/bin/desk-q.mjs');
t('DS-297 AC1 with passes stopped, nothing will requeue it, so it needs you again', shownState(queueOf('beta'), queueOf('beta').tickets['B-1'], { live: false }), 'needs');
t('DS-297 AC1 its desk-q page says which session it waits on', ticketScreen(loadRepos().find((r) => r.name === 'beta'), 'B-1', { width: 160 }).includes('Moves without you: answered: waiting for session beta-batch to requeue it'), true);

// ---- AC16, AC6: passes stopped: the answer is recorded, requeued, and the end says how to resume
const g1 = N.record({ word: 'gamma', ticket: 'G-1', action: 'resume', text: 'retry' });
t('AC6 requeued in a stopped repo', `${g1.ok} ${queueOf('gamma').tickets['G-1'].state}`, 'true triaged');
t('AC16 the record line says passes are stopped', /Passes are stopped in gamma/.test(g1.line), true);

// ---- AC11: the end prints the desk-q count left, then each stopped repo and how to resume it
const left = cli('left').out.trim().split('\n');
// A-1, A-3, A-7, B-1 and G-1 are settled; A-2, A-4, A-6 and A-8 still need you.
t('AC11 the count left is desk-q\'s', left[0], 'desk-q counts 4 items needing you.');
t('AC16 the last line says passes are stopped in gamma and how to resume', /^Passes are stopped in gamma, .* To resume: run \/desk-autopilot in gamma\.$/.test(left.at(-1)), true);

// ---- DS-297 AC2: once the session requeues the answered ticket, it moves on as any requeued ticket does
const rq = spawnSync(process.execPath, [join(REAL_BIN, 'queue.mjs'), 'requeue', 'B-1'], { encoding: 'utf8',
  env: { ...process.env, DESK_QUEUE: join(env.DESK_HOME, 'repos', 'acme__beta', 'queue.json'), DESK_AUTOPILOT_STATE: join(env.HOME, '.desk-autopilot', 'acme__beta') } });
const b1q = queueOf('beta').tickets['B-1'];
t('DS-297 AC2 the session\'s requeue clears the answered park', `${rq.status} ${b1q.state} ${b1q.park}`, '0 triaged null');
t('DS-297 AC2 desk-q shows it ready', betaRow().k, 'ready');

// Refusals.
t('an item desk-q does not count records nothing', N.record({ word: 'alpha', ticket: 'A-5', action: 'answer', text: 'x' }).ok, false);
t('an unknown repo exits 11', cli('record', 'zeta', 'Z-1', 'done').code, 11);

console.log(fails ? `\n${fails} check(s) did not pass` : '\nall passed');
process.exit(fails ? 1 : 0);
