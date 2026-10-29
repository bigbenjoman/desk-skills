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
t('AC3 (DS-279 AC16) a hold only you can let start recommends start, never release', itemLines.some((l) => l.startsWith('alpha A-4 held') && l.includes('A-9 is not in this queue') && l.includes('1. start (recommended:') && !/releas/.test(l)), true);
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
// DS-324 AC1, AC3: a put-off item is not listed again, on this run or a later one, and the count leaves it out.
const offList = cli('list', 'alpha');
t('DS-324 AC1 a put-off park and hold are not listed', `${N.collect({ word: 'alpha' }).items.some((i) => ['A-4', 'A-6'].includes(i.t.key))} ${/^alpha A-[46] /m.test(offList.out)}`, 'false false');
t('DS-324 AC1 the count line leaves them out and says so', offList.out.trim().split('\n').at(-1), `${offList.out.split('\n').filter((l) => / \| /.test(l)).length} items in 1 repo. 2 put off with not-now, left out until they change.`);
t('DS-324 AC3 a later run with nothing changed still leaves them out', N.collect({ word: 'alpha', repos: loadRepos(NOW + 86400000) }).items.some((i) => ['A-4', 'A-6'].includes(i.t.key)), false);

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
// A-1, A-3, A-7, B-1 and G-1 are settled; A-4 and A-6 are put off; A-2 and A-8 still need you.
t('AC11 (DS-324 AC4) the count left is what list prints', left[0], 'desk-q counts 2 items needing you. 2 put off with not-now, left out until they change.');
t('DS-324 AC4 left matches list', N.collect().items.length, 2);

// ---- DS-324 AC2: a put-off item comes back once its blocker or its inputs change
const aq = queueOf('alpha');
aq.tickets['A-9'] = { key: 'A-9', state: 'done', lane: 'A', added_at: minsAgo(600) };
aq.tickets['A-6'].park.inputs = { 'pr-head': 'bbb' };
writeFileSync(join(env.DESK_HOME, 'repos', 'acme__alpha', 'queue.json'), JSON.stringify(aq));
const back = N.collect({ word: 'alpha' }).items;
t('DS-324 AC2 a hold whose blocker went done is listed again, saying what changed', /^A-9 finished with no PR: let it start \(Changed since it was put off on \d{4}-\d\d-\d\d: blockers A-9:none → A-9:done; need .*\.\)$/.test(back.find((i) => i.t.key === 'A-4')?.need ?? ''), true);
t('DS-324 AC2 a park whose inputs changed is listed again, saying what changed', /^PRODUCTION BROKEN: checkout returns 500 \(Changed since it was put off on \d{4}-\d\d-\d\d: pr-head \(new\) → bbb\.\)$/.test(back.find((i) => i.t.key === 'A-6')?.need ?? ''), true);
// DS-324 AC1, AC3: two holds with the same words are put off each on its own; the second does not bring the first back.
const held = (k) => ({ key: k, state: 'parked', lane: 'A', held_by: 'A-9', added_at: minsAgo(25), park: { question: `held by orchestrator: blocked by A-9 — starts once their PRs merge (${k})` } });
const tq = queueOf('alpha');
tq.tickets['A-10'] = held('A-10');
tq.tickets['A-11'] = held('A-11');
writeFileSync(join(env.DESK_HOME, 'repos', 'acme__alpha', 'queue.json'), JSON.stringify(tq));
const twins = () => N.collect({ word: 'alpha' }).items.filter((i) => ['A-10', 'A-11'].includes(i.t.key));
t('DS-324 two holds share a need', twins().map((i) => i.need).join(' | '), 'A-9 finished with no PR: let it start | A-9 finished with no PR: let it start');
N.record({ word: 'alpha', ticket: 'A-10', action: 'not-now' });
N.record({ word: 'alpha', ticket: 'A-11', action: 'not-now' });
t('DS-324 AC1 both are left out once both are put off', twins().length, 0);
delete tq.tickets['A-10'];
delete tq.tickets['A-11'];
writeFileSync(join(env.DESK_HOME, 'repos', 'acme__alpha', 'queue.json'), JSON.stringify(tq));
t('AC16 the last line says passes are stopped in gamma and how to resume', /^Passes are stopped in gamma, .* To resume: run \/desk-autopilot in gamma\.$/.test(left.at(-1)), true);

// ---- DS-297 AC2: once the session requeues the answered ticket, it moves on as any requeued ticket does
const rq = spawnSync(process.execPath, [join(REAL_BIN, 'queue.mjs'), 'requeue', 'B-1'], { encoding: 'utf8',
  env: { ...process.env, DESK_QUEUE: join(env.DESK_HOME, 'repos', 'acme__beta', 'queue.json'), DESK_AUTOPILOT_STATE: join(env.HOME, '.desk-autopilot', 'acme__beta') } });
const b1q = queueOf('beta').tickets['B-1'];
t('DS-297 AC2 the session\'s requeue clears the answered park', `${rq.status} ${b1q.state} ${b1q.park}`, '0 triaged null');
t('DS-297 AC2 desk-q shows it ready', betaRow().k, 'ready');

// ---- DS-310 AC3: a park in a named batch names that batch, and its answer is recorded there
const xq = join(env.DESK_HOME, 'repos', 'acme__alpha', 'batches', 'X-1', 'queue.json');
const xs = join(env.HOME, '.desk-autopilot', 'acme__alpha', 'batches', 'X-1');
mkdirSync(dirname(xq), { recursive: true });
mkdirSync(join(xs, 'orchestrators'), { recursive: true });
writeFileSync(xq, JSON.stringify({ version: 1, batch: 'x1-batch', base: 'feat/x', concurrency: 1, supervised: true, tickets: {
  'X-2': { key: 'X-2', added_at: minsAgo(600), ...parked('A', 400, 'Which banner?') },
  'X-3': { key: 'X-3', added_at: minsAgo(600), ...parked('A', 5, 'Which footer?') } } }));
writeFileSync(join(xs, 'orchestrators', 'q.json'), JSON.stringify({ queue: xq, batch: 'x1-batch', pid: 1, at: minsAgo(1) }));
const xList = cli('list', 'alpha');
t('DS-310 AC3 the item names the named batch, as record takes it', xList.out.split('\n').some((l) => l.startsWith('alpha:X-1 X-2 parked') && l.includes('| Which banner? |')), true);
t('DS-310 AC3 the repo\'s name lists its standing batch\'s items and the named batch\'s', `${xList.out.includes('\nalpha A-2 ')} ${/^@ alpha · X-1 \(feat\/x\): run by the supervisor/m.test(xList.out)}`, 'true true');
t('DS-310 AC3 the named batch on its own lists only its items', cli('list', 'alpha:X-1').out.split('\n').filter((l) => / \| /.test(l)).map((l) => l.split(' ')[1]).join(), 'X-2,X-3');
const x2 = cli('record', 'alpha:X-1', 'X-2', 'resume', 'the red one');
const xQueue = () => JSON.parse(readFileSync(xq, 'utf8'));
t('DS-310 AC3 the answer went through answer.mjs for the named batch', JSON.stringify(answers().at(-1)), JSON.stringify({ args: ['X-2', 'the red one'], queue: xq }));
t('DS-310 AC3 the ticket is requeued in the named batch', `${x2.code} ${xQueue().tickets['X-2'].state}`, '0 triaged');
const x3 = N.record({ word: 'alpha', ticket: 'X-3', action: 'resume', text: 'the plain one' });
t('DS-310 AC3 a repo\'s name finds the batch that holds the ticket', `${x3.ok} ${answers().at(-1).queue === xq} ${xQueue().tickets['X-3'].state} ${queueOf('alpha').tickets['X-3']}`, 'true true triaged undefined');

// ---- DS-279: every row desk-q puts in Needs you is asked about: a worker that gave up, and a PR only you move.
put('eta', { port: 3700, beat: 1, supervised: true, tickets: {
  'E-1': { state: 'failed', lane: 'A', park: { question: 'tests red', since: minsAgo(15) } },
  'E-2': { state: 'done', lane: 'A', result: { pr: 61 }, pr_status: { pr: 61, state: 'OPEN', url: null, isDraft: false, mergeable: 'MERGEABLE', checks: [{ name: 'build', status: 'completed', conclusion: 'success' }], at: minsAgo(1) } },
} });
put('theta', { port: 3800, beat: 1, supervised: true, tickets: {
  'H-1': { state: 'running', lane: 'A' },
  'H-2': { state: 'parked', lane: 'A', held_by: 'H-1', open_questions: 1, outside_blockers: [{ key: 'X-9' }], park: { question: 'held by orchestrator: blocked by H-1 — starts once their PRs merge' } },
} });
const h2 = N.collect({ word: 'theta' }).items.find((i) => i.t.key === 'H-2');
t('DS-279 a held ticket also held outside the batch asks the outside question, and answers it', `${h2?.kind} ${h2?.need} ${h2?.actions[0][0]}`, 'triage held by X-9, outside this batch: start anyway? answer');
const e = N.collect({ word: 'eta' });
const { needsRows } = await import('../desk/bin/desk-q.mjs');
t('DS-279 a stopped worker and a PR to merge are items, as many as desk-q counts', `${e.items.map((i) => `${i.t.key} ${i.kind} ${i.need}`).join(' | ')} | ${needsRows(e.named).length}`,
  'E-2 pr PR #61: 1 check passed · merge it | E-1 stopped worker stopped: tests red · requeue it | 2');
const rq1 = N.record({ word: 'eta', ticket: 'E-1', action: 'requeue' });
t('DS-279 requeue sends a stopped worker\'s ticket back, under the supervisor', `${rq1.ok} ${queueOf('eta').tickets['E-1'].state !== 'failed'} ${N.collect({ word: 'eta' }).items.some((i) => i.t.key === 'E-1')}`, 'true true false');
t('DS-279 a PR only you move is recorded as done', N.record({ word: 'eta', ticket: 'E-2', action: 'done' }).ok, true);
// DS-324 AC1, AC2: a PR put off is left out until its head moves.
const eq = () => join(env.DESK_HOME, 'repos', 'acme__eta', 'queue.json');
const moveHead = (h) => { const q = queueOf('eta'); q.tickets['E-2'].pr_status.head = h; writeFileSync(eq(), JSON.stringify(q)); };
moveHead('aaa');
const pe2 = N.record({ word: 'eta', ticket: 'E-2', action: 'not-now' });
t('DS-324 AC1 a PR put off is not listed', `${pe2.ok} ${N.collect({ word: 'eta' }).items.some((i) => i.t.key === 'E-2')}`, 'true false');
// Its need's words change with its checks (a running check's age among them); its head has not moved.
const ckq = queueOf('eta');
ckq.tickets['E-2'].pr_status.checks = [{ name: 'build', status: 'in_progress', conclusion: null, startedAt: minsAgo(5) }];
writeFileSync(eq(), JSON.stringify(ckq));
t('DS-324 AC3 a PR whose checks moved but head did not stays left out', N.collect({ word: 'eta' }).items.some((i) => i.t.key === 'E-2'), false);
moveHead('bbb');
t('DS-324 AC2 a PR whose head moved is listed again, saying so', /pr-head aaa → bbb/.test(N.collect({ word: 'eta' }).items.find((i) => i.t.key === 'E-2')?.need ?? ''), true);

// ---- DS-323: a draft whose review left gaps takes the person's call on them; skipped checks on a draft read as CI not running there.
const draftPr = (pr, checks, undraft) => ({ state: 'done', lane: 'A', result: { pr }, undraft,
  pr_status: { pr, state: 'OPEN', url: null, isDraft: true, mergeable: 'MERGEABLE', head: `h${pr}`, checks, at: minsAgo(1) } });
const passed = [{ name: 'build', status: 'completed', conclusion: 'success' }];
put('iota', { port: 3900, beat: 1, supervised: true, tickets: {
  'I-1': draftPr(71, passed, { call: 'person', why: 'its review verdict at abc123456 is not clean (gaps=2)', action: 'settle the findings or gaps on #71' }),
  'I-2': draftPr(72, [{ name: 'test', status: 'completed', conclusion: 'skipped' }, ...passed],
    { call: 'person', why: 'its checks are not green: required check "test" is skipped (skipped does not count)', action: 'fix or re-run the checks on #72' }),
} });
const iota = N.collect({ word: 'iota' }).items;
const i1 = iota.find((i) => i.t.key === 'I-1');
t('DS-323 AC1 a draft with review gaps offers answer first, then done and not-now', `${i1?.need} | ${i1?.actions.map((a) => a[0]).join()}`, 'PR #71: draft · review not clean: 2 gaps | answer,done,not-now');
t('DS-323 AC1 its listed line recommends the answer', cli('list', 'iota').out.split('\n').some((l) => l.startsWith('iota I-1 pr') && l.includes('| 1. answer (recommended:')), true);
const i2 = iota.find((i) => i.t.key === 'I-2');
t('DS-323 AC3 a draft whose only red checks were skipped says CI does not run on a draft, and to undraft it', i2?.need, 'PR #72: draft · CI does not run on a draft, so its checks were skipped: undraft #72');
t('DS-323 AC1 a PR with no review gaps takes no answer', `${i2?.actions.map((a) => a[0]).join()} ${N.record({ word: 'iota', ticket: 'I-2', action: 'answer', text: 'x' }).ok}`, 'done,not-now false');
const call323 = 'Split gap 1 into its own ticket; fix gap 2 in this PR';
const gr = cli('record', 'iota', 'I-1', 'answer', call323);
const i1q = queueOf('iota').tickets['I-1'];
const ghLog = readFileSync(GH_LOG, 'utf8');
t('DS-323 AC2 the answer is posted on the PR', `${gr.code} ${ghLog.includes('pr comment 71 --repo acme/iota --body') && ghLog.includes(`> ${call323}`)}`, '0 true');
t('DS-323 AC2 it is kept in the briefing for the next worker', `${JSON.stringify(answers().at(-1).args)} ${readFileSync(join(env.HOME, '.desk-autopilot', 'acme__iota', 'briefings', 'I-1.md'), 'utf8').includes(call323)}`, `${JSON.stringify(['I-1', call323])} true`);
t('DS-323 AC2 and requeued for a worker on the PR, carrying the call', `${i1q.state} ${i1q.fix?.kind} ${i1q.fix?.pr} ${i1q.fix?.head} ${i1q.fix?.answer === call323}`, 'triaged gaps 71 h71 true');
const { fixBrief, fixTask } = await import('../desk/bin/fix-tries.mjs');
t('DS-323 AC2 the fix worker\'s briefing quotes the call, and its task is to carry it out', `${fixBrief(i1q).includes(`> ${call323}`)} ${/carry out the person's call on the review gaps of PR #71/.test(fixTask(i1q))} ${/leave the PR in draft/.test(fixTask(i1q))}`, 'true true true');
t('DS-323 AC2 desk-q no longer counts it as needing you', N.collect({ word: 'iota' }).items.some((i) => i.t.key === 'I-1'), false);

// ---- DS-322: a worker's park that names lane C, or lane D with no saved canvas, is offered open, never
// resume or requeue; any other park's resume names the ticket's own lane.
put('kappa', { port: 4000, beat: 1, supervised: true, tickets: {
  'K-1': parked('A', 50, 'Demoted to lane C, build it in an interactive desk-ticket session'),
  'K-2': parked('A', 40, 'demoted to lane D: its canvas is not saved on main'),
  'K-3': parked('D', 30, 'Which board is the empty state?'),
  // Stopped with no marker, so the queue holds no park: the question is in its park file.
  'K-4': { state: 'failed', lane: 'A' },
  'K-5': parked('?', 10, 'Which copy?'),
  'K-6': parked('A', 25, 'This is not lane C on its own: which endpoint should the export use?'),
  'K-7': parked('D', 15, 'Lane D, its canvas is saved on main, but the empty state is not on it: which board?'),
  'K-8': parked('A', 5, 'lane C, build it in an interactive desk-ticket session'),
}, triage: { 'K-5': { lane: 'B' } } });
mkdirSync(join(env.HOME, '.desk-autopilot', 'acme__kappa', 'parks'), { recursive: true });
writeFileSync(join(env.HOME, '.desk-autopilot', 'acme__kappa', 'parks', 'K-4.json'), JSON.stringify({ question: 'Please take it out of the autopilot queue: lane C' }));
const kappa = Object.fromEntries(N.collect({ word: 'kappa' }).items.map((i) => [i.t.key, i]));
const firstOf = (k) => `${kappa[k]?.actions[0][0]} (${kappa[k]?.actions[0][1]})`;
const offers = (k) => kappa[k]?.actions.map((a) => a[0]).join();
t('DS-322 AC1 a park naming lane C offers open, not resume', `${firstOf('K-1')} ${offers('K-1')}`, 'open (lane C/D: a worker would only park on it) open,not-now');
t('DS-322 AC1 a lane D park without a saved canvas offers open, not resume', `${firstOf('K-2')} ${offers('K-2')}`, 'open (lane C/D: a worker would only park on it) open,not-now');
t('DS-322 AC1 a park opening "lane C" on a lane A ticket gives the lane C/D reason', firstOf('K-8'), 'open (lane C/D: a worker would only park on it)');
const { presort } = await import('../desk/bin/decider.mjs');
t('DS-322 AC1 the decider hands the same park to a session, never a requeue', presort([{ kind: 'parked', lane: 'A', text: 'Demoted to lane C, build it in an interactive desk-ticket session' }]).hand.length, 1);
t('DS-322 AC2 a stopped worker whose park names lane C offers open, not requeue', `${kappa['K-4']?.kind} ${firstOf('K-4')} ${offers('K-4')}`, 'stopped open (lane C/D: a worker would only park on it) open,not-now');
t('DS-322 AC2 its need shows the park, not "requeue it"', kappa['K-4']?.need, 'worker stopped: Please take it out of the autopilot queue: lane C');
t('DS-322 AC2 requeue is refused for it', N.record({ word: 'kappa', ticket: 'K-4', action: 'requeue' }).ok, false);
t('DS-322 AC3 a lane D park resumes, naming the queue\'s lane', firstOf('K-3'), 'resume (lane D: a worker finishes it once it has your answer)');
t('DS-322 AC3 a lane D park with its canvas saved resumes, naming lane D', firstOf('K-7'), 'resume (lane D: a worker finishes it once it has your answer)');
t('DS-322 AC3 a park that rules lane C out resumes', firstOf('K-6'), 'resume (lane A: a worker finishes it once it has your answer)');
t('DS-322 AC3 a resume names the triage record\'s lane when the queue has none', firstOf('K-5'), 'resume (lane B: a worker finishes it once it has your answer)');

// Refusals.
t('an item desk-q does not count records nothing', N.record({ word: 'alpha', ticket: 'A-5', action: 'answer', text: 'x' }).ok, false);
t('an unknown repo exits 11', cli('record', 'zeta', 'Z-1', 'done').code, 11);

console.log(fails ? `\n${fails} check(s) did not pass` : '\nall passed');
process.exit(fails ? 1 : 0);
