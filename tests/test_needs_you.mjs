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
// A fake gh that logs its arguments, and answers `pr view <n>` with prs/<n>.json, failing with none.
const GH_LOG = join(T, 'gh.log');
const GH_PRS = join(T, 'prs');
mkdirSync(GH_PRS);
writeFileSync(join(T, 'bin', 'gh'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(GH_LOG)}\n` +
  `if [ "$1 $2" = "pr view" ]; then f=${JSON.stringify(GH_PRS)}/"$3".json; [ -f "$f" ] || { echo "GraphQL: Could not resolve to a PullRequest ($3)" >&2; exit 1; }; cat "$f"; fi\n`, { mode: 0o755 });
const onGitHub = (pr, v) => writeFileSync(join(GH_PRS, `${pr}.json`), JSON.stringify(v));
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
    `| \`autopilot-merge\` | The merge driver merges | \`ask\` | \`${r.merge ?? 'no'}\` |\n| \`pr-merge-green\` | Merge a green PR | \`ask\` | \`${r.merge ?? 'no'}\` |\n\n` +
    `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`${r.port}\` |\n| Autopilot worker concurrency | \`2 / 3\` | \`2 / 3\` |\n` +
    `| Batches run by | \`supervisor\` | \`${r.supervised ? 'supervisor' : 'session'}\` |\n`);
  const state = join(env.HOME, '.desk-autopilot', slug);
  if (!r.tickets) return;
  const q = join(env.DESK_HOME, 'repos', slug, 'queue.json');
  mkdirSync(dirname(q), { recursive: true });
  const tickets = Object.fromEntries(Object.entries(r.tickets).map(([k, v]) => [k, { key: k, added_at: minsAgo(600), ...v }]));
  writeFileSync(q, JSON.stringify({ version: 1, batch: `${name}-batch`, concurrency: 2, supervised: !!r.supervised, ...r.batch, tickets }));
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
const { loadRepos, repoScreen } = await import('../desk/bin/desk-q.mjs');
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

// ---- desk-q's NEEDS YOU and left's count are one number, the put-off items said beside it
const { overview } = await import('../desk/bin/desk-q.mjs');
const home = () => overview(loadRepos(), { now: NOW, avail: 30 }).split('\n');
// The cell ends where its right-aligned header does.
const needsCell = () => {
  const h = home(), end = h.find((l) => l.includes('NEEDS YOU')).indexOf('NEEDS YOU') + 'NEEDS YOU'.length;
  return h.find((l) => l.startsWith('  alpha '))?.slice(0, end).match(/(\d+(?: \(\+\d+ put off\))?)$/)?.[1];
};
t('DS-376 AC1 the NEEDS YOU cell shows what needs you, then how many are put off', needsCell(), '2 (+2 put off)');
t('DS-376 AC1 the header counts what needs you, as the cell does', home()[0].startsWith('◆ 2 tickets need you'), true);
t('DS-376 AC2 left attributes to desk-q the count its table shows', `${left[0].match(/^desk-q counts (\d+) /)?.[1]} ${N.needsCount(loadRepos().find((r) => r.name === 'alpha'))?.shown}`, '2 2');

// ---- DS-324 AC2: a put-off item comes back once its blocker or its inputs change
const aq = queueOf('alpha');
aq.tickets['A-9'] = { key: 'A-9', state: 'done', lane: 'A', added_at: minsAgo(600) };
aq.tickets['A-6'].park.inputs = { 'pr-head': 'bbb' };
writeFileSync(join(env.DESK_HOME, 'repos', 'acme__alpha', 'queue.json'), JSON.stringify(aq));
const back = N.collect({ word: 'alpha' }).items;
t('DS-324 AC2 a hold whose blocker went done is listed again, saying what changed', /^A-9 finished with no PR: let it start \(Changed since it was put off on \d{4}-\d\d-\d\d: blockers A-9:none → A-9:done; need .*\.\)$/.test(back.find((i) => i.t.key === 'A-4')?.need ?? ''), true);
t('DS-324 AC2 a park whose inputs changed is listed again, saying what changed', /^PRODUCTION BROKEN: checkout returns 500 \(Changed since it was put off on \d{4}-\d\d-\d\d: pr-head \(new\) → bbb\.\)$/.test(back.find((i) => i.t.key === 'A-6')?.need ?? ''), true);
t('DS-376 AC3, AC4 both count the changed ones as needing you, and the cell is the count alone with none put off',
  `${needsCell()} ${N.needsCount(loadRepos().find((r) => r.name === 'alpha')).shown} ${back.length} ${cli('left', 'alpha').out.split('\n')[0]}`, '4 4 4 desk-q counts 4 items needing you in alpha.');
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
  'E-2 pr PR #61 has its check green, and desk may not merge in this repo. Merge it on GitHub; the ticket is then done. | E-1 stopped worker stopped: tests red · requeue it | 2');
const rq1 = N.record({ word: 'eta', ticket: 'E-1', action: 'requeue' });
t('DS-279 requeue sends a stopped worker\'s ticket back, under the supervisor', `${rq1.ok} ${queueOf('eta').tickets['E-1'].state !== 'failed'} ${N.collect({ word: 'eta' }).items.some((i) => i.t.key === 'E-1')}`, 'true true false');
onGitHub(61, { state: 'OPEN', mergedAt: null, isDraft: false, headRefOid: null });
const d61 = N.record({ word: 'eta', ticket: 'E-2', action: 'done' });
t('DS-279 (DS-378 AC1) done on a PR only you move reads it on GitHub and says it is still unmerged', `${d61.ok} ${/GitHub still shows PR #61 unmerged, so it stays on your list/.test(d61.line)}`, 'false true');
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
t('DS-323 AC1 a draft with review gaps offers answer first, then done and not-now', `${i1?.need} | ${i1?.actions.map((a) => a[0]).join()}`, 'PR #71 is a draft, and its code review left 2 requirement gaps. Say how to settle them; a worker on the PR carries out your call. | answer,done,not-now');
t('DS-323 AC1 its listed line recommends the answer', cli('list', 'iota').out.split('\n').some((l) => l.startsWith('iota I-1 pr') && l.includes('| 1. answer (recommended:')), true);
const i2 = iota.find((i) => i.t.key === 'I-2');
t('DS-323 AC3 a draft an older pass recorded as not green, whose only red checks were skipped, says CI does not run on a draft, and to undraft it', i2?.need, 'PR #72 is a draft, and CI does not run on drafts, so its checks were skipped. Undraft it so they run; then merge it on GitHub once its checks are green.');
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

// ---- DS-327: a draft whose §4 Check builds build is running, or whose check was re-run after it, is not the person's.
const flowsRed = [{ name: 'Flows image', status: 'completed', conclusion: 'failure' }, ...passed];
put('flows', { port: 4777, beat: 1, supervised: true, tickets: {
  'FL-1': draftPr(81, flowsRed, { call: 'build', why: '"Flows image" red at h81, which §4 Check builds clears: `./scripts/ensure-flows-image.sh` runs at the head, then the check is re-run' }),
  'FL-2': draftPr(82, flowsRed, { call: 'wait', why: 'its check build `./scripts/ensure-flows-image.sh` is running at h82, then "Flows image" is re-run' }),
  'FL-3': draftPr(83, flowsRed, { call: 'rebuilt', why: 'its check build `./scripts/ensure-flows-image.sh` ran at h83, so "Flows image" is re-run' }),
  'FL-4': draftPr(84, flowsRed, { call: 'person', why: 'its check build `./scripts/ensure-flows-image.sh` exited 1 at 9f3c2a1b7: no Docker context', action: 'fix the build, run it at the head of #84, then re-run "Flows image"' }),
} });
const flows = N.collect({ word: 'flows' }).items.map((i) => i.t.key).join();
t('DS-327 AC1 a draft whose check build runs, or whose check was re-run after it, is not listed', flows.includes('FL-1') || flows.includes('FL-2') || flows.includes('FL-3'), false);
t('DS-327 AC2 one whose build failed is, with the command, its exit code and its output', N.collect({ word: 'flows' }).items.find((i) => i.t.key === 'FL-4')?.need,
  'PR #84 is a draft: check build `./scripts/ensure-flows-image.sh` exited 1: no Docker context. Fix the build, run it at the head of #84, then re-run "Flows image"; the next pass then picks it up.');

// ---- DS-345: a draft whose gaps outlast its fix tries keeps undraft.call `findings` (DS-342's record),
// and still takes the person's call on them; one with findings and no gaps does not.
put('mu', { port: 4200, beat: 1, supervised: true, tickets: {
  'M-1': draftPr(81, passed, { call: 'findings', why: 'its review verdict at 575fa8c5c is not clean (gaps=1)', action: 'settle the findings or gaps on #81' }),
  'M-2': draftPr(82, passed, { call: 'findings', why: 'its review verdict at 575fa8c5c is not clean (p1=1)', action: 'settle the findings on #82' }),
} });
const mu = Object.fromEntries(N.collect({ word: 'mu' }).items.map((i) => [i.t.key, i]));
t('DS-345 AC1 a findings draft with gaps offers answer first', mu['M-1']?.actions.map((a) => a[0]).join(), 'answer,done,not-now');
const call345 = 'Drop the 7-day row for the old subscription; keep the rest';
const mr = cli('record', 'mu', 'M-1', 'answer', call345);
const m1q = queueOf('mu').tickets['M-1'];
t('DS-345 AC2 the call is posted on the PR', `${mr.code} ${readFileSync(GH_LOG, 'utf8').includes('pr comment 81 --repo acme/mu --body')}`, '0 true');
t('DS-345 AC2 and a fix worker on the branch is queued with it', `${m1q.state} ${m1q.fix?.kind} ${m1q.fix?.pr} ${m1q.fix?.head} ${m1q.fix?.answer === call345}`, 'triaged gaps 81 h81 true');
t('DS-345 AC3 a findings draft with no gaps keeps its actions', mu['M-2']?.actions.map((a) => a[0]).join(), 'done,not-now');

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

// ---- DS-344: a batch held on a usage limit. Its paused workers and held ticket are none of them
// stopped: needs-you lists one item for the hold, and desk-q shows each paused worker with the reset.
const wreset = Math.floor(NOW / 1000) + 3 * 86400;
const paused = { state: 'running', lane: 'A', stage: '4/9', usage_paused: { type: 'seven_day', resets_at: wreset } };
put('lambda', { port: 4100, beat: 1, supervised: true, batch: { usage_hold: { since: minsAgo(20), type: 'seven_day', resets_at: wreset, preflight: 'L-3', paused: ['L-1', 'L-2'] } }, tickets: {
  'L-1': paused, 'L-2': paused, 'L-3': { state: 'triaged', lane: 'A' },
} });
const lambda = N.collect({ word: 'lambda' }).items;
t('DS-344 AC5 a batch held on the usage limit is one item, and no ticket is one', lambda.map((i) => `${i.t.key} ${i.kind}`).join(), 'usage-limit usage');
t('DS-344 AC5 its need names the limit and how many workers wait', /^held on the weekly usage limit until .+: nothing new starts, and 2 paused workers wait\. It carries on by itself once the limit lifts$/.test(lambda[0]?.need ?? ''), true);
t('DS-344 AC5 it offers done and not-now, and done is recorded', `${lambda[0]?.actions.map((a) => a[0]).join()} ${N.record({ word: 'lambda', ticket: 'usage-limit', action: 'done' }).ok}`, 'done,not-now true');
const { needText: rowText } = await import('../desk/bin/desk-q.mjs');
const lr = loadRepos().find((r) => r.name === 'lambda');
const l1 = rowText(lr, lr.rows.find((x) => x.t.key === 'L-1'));
t(`DS-344 AC1 desk-q shows a paused worker on the weekly limit with its reset day and time (${l1})`, /^paused on the weekly usage limit until \S+ \d+ \S+ \d\d:\d\d, then resumes by itself$/.test(l1), true);
put('lambda', { port: 4100, beat: 1, supervised: true, tickets: { 'L-1': { state: 'running', lane: 'A', stage: '4/9' } } });
t('DS-344 AC5 with no hold there is no usage item', N.collect({ word: 'lambda' }).items.length, 0);

// ---- DS-314 AC2: a PR the person put back to draft (the pass recorded `undraft` held) needs them
const landed = (n, more = {}) => ({ state: 'done', lane: 'A', result: { pr: n }, pr_status: { pr: n, state: 'OPEN', isDraft: true, mergeable: 'MERGEABLE', checks: [], at: minsAgo(1), ...more } });
put('iota', { port: 3900, beat: 1, supervised: true, tickets: {
  'E-1': { ...landed(51), undraft: { call: 'held', why: 'it was put back to draft by ben', action: 'undraft #51 to release it', sha: 'a', pr: 51 } },
  'E-2': { ...landed(52), undraft: { call: 'wait', why: 'checks running', sha: 'a', pr: 52 } },
  'E-3': { ...landed(53, { isDraft: false }), undraft: { call: 'held', why: 'it was put back to draft', action: 'undraft #53 to release it', sha: 'a', pr: 53 } },
} });
const ce = N.collect({ word: 'iota' });
const e1 = ce.items.find((i) => i.t.key === 'E-1');
t('DS-314 AC2 only the PR the person put back to draft is held; one out of draft is an ordinary PR item, one being undrafted is none',
  ce.items.map((i) => `${i.t.key}:${i.kind}`).sort().join(), 'E-1:held,E-3:pr');
t('DS-314 AC2 it is held by them on its PR, undrafting it the release',
  `${e1?.kind} | ${e1?.need} | ${e1?.actions.map(([a]) => a).join()}`,
  'held | you put PR #51 back to draft, so nothing undrafts or merges it: undraft it to release it (gh pr ready 51 --repo acme/iota) | done,not-now');
const er = loadRepos().find((x) => x.slug === 'acme__iota');
t('DS-314 AC2 desk-q counts it as needing you, and the one being undrafted as merging', [...er.rows, ...er.prs].map((x) => `${x.t.key}:${x.k}`).join(), 'E-1:needs,E-2:merging,E-3:needs');
const eScreen = repoScreen(er);
t('DS-314 AC2 desk-q\'s Queue lists it under Needs you, held by them on its PR',
  /Needs you · 2/.test(eScreen) && /E-1 +◆ needs you +#51 · held by you in draft · undraft it to release/.test(eScreen), true);
t('DS-314 AC2 its ticket page says how to release it',
  /Held by you: you put its PR #51 back to draft/.test(ticketScreen(er, 'E-1')) && ticketScreen(er, 'E-1').includes('gh pr ready 51 --repo acme/iota'), true);
onGitHub(51, { state: 'OPEN', mergedAt: null, isDraft: true, headRefOid: null });
const d51 = N.record({ word: 'iota', ticket: 'E-1', action: 'done' });
t('DS-314 AC2 (DS-378) done reads it on GitHub, and says it is still a draft', `${d51.ok} ${/GitHub still shows PR #51 unmerged, still a draft/.test(d51.line)}`, 'false true');
onGitHub(51, { state: 'OPEN', mergedAt: null, isDraft: false, headRefOid: null });
const u51 = N.record({ word: 'iota', ticket: 'E-1', action: 'done' });
t('DS-378 done on a held draft once undrafted says it is released, and records it',
  `${u51.ok} ${u51.line} ${queueOf('iota').tickets['E-1'].pr_status.isDraft}`, 'true iota E-1: GitHub shows PR #51 out of draft, so it is released; the next pass takes it on from there. false');
t('DS-378 it is no longer held', N.collect({ word: 'iota' }).items.find((i) => i.t.key === 'E-1')?.kind ?? 'none', 'pr');

// ---- DS-347 AC3: a green PR the merge driver has held on two loops for an unresolved thread is the
// person's, naming the thread; a green PR it merges is not.
const greenPr = (pr, more = {}) => ({ state: 'done', lane: 'A', result: { pr }, ...more,
  pr_status: { pr, state: 'OPEN', url: null, isDraft: false, mergeable: 'MERGEABLE', head: `h${pr}`, checks: passed, at: minsAgo(1) } });
put('xi', { port: 4300, beat: 1, supervised: true, merge: 'yes', tickets: {
  'X-1': greenPr(91),
  'X-2': greenPr(92, { merge_blocked: 'review feedback: 1 unresolved thread on a green PR, first desk/bin/pass.mjs:970 "Why does this hold not show in desk-q?"' }),
} });
const xi = N.collect({ word: 'xi' }).items;
t('DS-347 AC3 a green PR the driver merges is not an item, and one it holds for a thread is', xi.map((i) => `${i.t.key} ${i.kind}`).join(), 'X-2 pr');
t('DS-347 AC3 its need names the PR, the thread\'s path and its first line', xi[0]?.need, 'PR #92 is green, but held for review: 1 unresolved thread on a green PR, first desk/bin/pass.mjs:970 "Why does this hold not show in desk-q?". Resolve or answer it; desk then merges it.');

// ---- DS-351 AC2: an epic admitted with no session waits on its drafted plan as one item, and its
// children held behind it are not items of their own.
const planQ = 'feature plan awaiting your answer: the spine and owner table for P-1 are drafted, with 2 children held behind it: read /s/plan.md, then start, edit or discard it';
const behindP = { state: 'parked', lane: 'A', held_by: 'P-1', park: { question: 'held by orchestrator: blocked by P-1 — starts once their PRs merge' } };
put('omicron', { port: 4555, beat: 1, supervised: true, tickets: { 'P-1': { ...parked('epic', 5, planQ), type: 'Epic' }, 'P-2': behindP, 'P-3': behindP } });
const om = N.collect({ word: 'omicron' }).items;
t('DS-351 AC2 the plan is one needs-you item, of kind plan, its children waiting', om.map((i) => `${i.t.key} ${i.kind}`).join(), 'P-1 plan');
t('DS-351 AC2 its need is the plan park, and its recommendation is to answer it', `${om[0]?.need === planQ} ${om[0]?.actions.map(([a]) => a).join()}`, 'true answer,not-now');
t('DS-351 AC2 an answer to it is recorded on the epic', `${N.record({ word: 'omicron', ticket: 'P-1', action: 'answer', text: 'start' }).ok} ${answers().at(-1)?.args.join(' ')}`, 'true P-1 start');

// ---- DS-375: a PR stuck after its fix tries is read against its checks now, names the step its run
// failed at, and recommends done only when the step is on GitHub.
const LINT = 'Lint, Type Check & Build';
const stuckPr = (pr, checks, stuck) => ({ state: 'done', lane: 'A', result: { pr }, stuck: { pr, head: `h${pr}`, at: minsAgo(30), ...stuck },
  pr_status: { pr, state: 'OPEN', url: null, isDraft: false, mergeable: 'MERGEABLE', head: `h${pr}`, checks, at: minsAgo(1) } });
const lintRed = { name: LINT, status: 'completed', conclusion: 'failure' };
const flowsGreen = { name: 'Flows image', status: 'completed', conclusion: 'success' };
const flowsCmd = { name: 'Flows image', command: './scripts/ensure-flows-image.sh' };
const lead375 = 'still red after 1 fix try';
const why375 = (checks) => ({ lead: lead375, checks, why: 'as the pass wrote it' });
put('sigma', { port: 4600, beat: 1, supervised: true, merge: 'yes', tickets: {
  'S-1': stuckPr(101, [lintRed, flowsGreen, ...passed], why375([{ name: LINT, step: 'Run eslint' }, flowsCmd])),
  'S-2': stuckPr(102, [flowsRed[0], ...passed], why375([flowsCmd])),
  'S-3': stuckPr(103, [lintRed, ...passed], why375([{ name: LINT, step: 'Check portal schema mirror', command: 'apply the PR\'s migrations to staging first' }])),
  'S-4': stuckPr(104, [flowsGreen, ...passed], why375([flowsCmd])),
  'S-5': stuckPr(105, [lintRed, ...passed], { why: 'still red after 2 fix tries: Lint' }),
  'S-6': stuckPr(106, [lintRed, flowsRed[0], ...passed], why375([{ name: LINT, step: 'Run eslint' }, flowsCmd])),
} });
const sg = Object.fromEntries(N.collect({ word: 'sigma' }).items.map((i) => [i.t.key, i]));
const recommends = (i) => i?.actions[0]?.[1] != null;
t('DS-375 AC1 a check gone green on the same head is no longer named', sg['S-1']?.need, `PR #101: "${LINT}" (failed at "Run eslint") is failing, and desk's own repairs did not fix it. Fix it on its branch; desk then merges it once its checks are green.`);
t('DS-375 AC2 the item names the step the run failed at', sg['S-1']?.need.includes('(failed at "Run eslint")'), true);
t('DS-375 AC1 a step on GitHub left: done is still recommended', `${sg['S-1']?.actions[0][0]} ${recommends(sg['S-1'])}`, 'done true');
t('DS-375 AC1 once every check it named is green it is not stuck: a PR the driver merges is no item', 'S-4' in sg, false);
t('DS-375 AC3 a §4 Check builds check names its command as what unblocks it', sg['S-2']?.need, 'PR #102: "Flows image" needs a step outside GitHub: ./scripts/ensure-flows-image.sh. Do that step; desk then merges it once its checks are green.');
t('DS-375 AC4 a step outside GitHub: done is offered but not recommended, and says what the step is',
  `${sg['S-2']?.actions.map(([a]) => a).join()} ${recommends(sg['S-2'])} ${sg['S-2']?.actions[0][2]}`,
  'done,not-now false the step is outside GitHub (./scripts/ensure-flows-image.sh); it drops off once "Flows image" is green');
t('DS-375 AC4 its listed line carries no recommendation', cli('list', 'sigma').out.split('\n').some((l) => l.startsWith('sigma S-2 pr') && !l.includes('recommended')), true);
t('DS-375 AC5 a §4 Pre-merge steps step is named from the config, with no done recommended',
  `${sg['S-3']?.need} | ${recommends(sg['S-3'])}`, `PR #103: "${LINT}" (failed at "Check portal schema mirror") needs a step outside GitHub: apply the PR's migrations to staging first. Do that step; desk then merges it once its checks are green. | false`);
t('DS-375 AC4 beside a check on GitHub, it drops off only once every check it is stuck on is green',
  sg['S-6']?.actions[0][2], `the step is outside GitHub (./scripts/ensure-flows-image.sh); it drops off once "${LINT}", "Flows image" are green`);
t('DS-375 a reason recorded before the pass kept its checks still names them', sg['S-5']?.need, 'PR #105 has failing checks desk\'s own repairs did not fix: Lint. Fix them on its branch; desk then merges it once its checks are green.');
const sr = loadRepos().find((x) => x.slug === 'acme__sigma');
t('DS-375 AC1 the ticket page reads it the same way', /For you +still red after 1 fix try: Lint, Type Check & Build \(failed step: Run eslint\)$/m.test(ticketScreen(sr, 'S-1')), true);

// ---- desk-q's Queue lists under Needs you only what needsCount counts: a row put off with not-now is
// under Put off, grey, until its inputs change.
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
put('rho', { port: 4700, beat: 1, supervised: true, tickets: { 'R-1': parked('A', 30, 'Which copy?'), 'R-2': parked('A', 20, 'Which colour?') } });
N.record({ word: 'rho', ticket: 'R-2', action: 'not-now' });
const rhoScreen = () => strip(repoScreen(loadRepos().find((x) => x.slug === 'acme__rho')));
t('a put-off row is not under Needs you, which counts what needsCount does', `${/Needs you · 1\b/.test(rhoScreen())} ${/Put off · 1\b/.test(rhoScreen())}`, 'true true');
t('a put-off row reads put off, the one asked about needs you',
  `${/R-1 +◆ needs you +Which copy\?/.test(rhoScreen())} ${/R-2 +◇ put off +Which colour\?/.test(rhoScreen())}`, 'true true');
t('Put off comes after Needs you, and the key says what it means',
  `${rhoScreen().indexOf('Needs you · 1') < rhoScreen().indexOf('Put off · 1')} ${rhoScreen().includes('◇ put off: you put it off with not-now; back in Needs you once it changes')}`, 'true true');
put('rho', { port: 4700, beat: 1, supervised: true, tickets: { 'R-1': parked('A', 30, 'Which copy?'), 'R-2': parked('A', 20, 'Which colour, red or blue?') } });
t('once its inputs change it is back under Needs you, and Put off is gone', `${/Needs you · 2\b/.test(rhoScreen())} ${rhoScreen().includes('Put off')}`, 'true false');

// ---- A PR closed unmerged: drop is recommended (desk-q says "requeue or drop it"), requeue offered.
const closedPr = (pr) => ({ state: 'done', lane: 'A', result: { pr }, pr_status: { pr, state: 'CLOSED', url: null, isDraft: false, head: `h${pr}`, checks: [], at: minsAgo(1) } });
put('tau', { port: 4800, beat: 1, supervised: true, tickets: { 'T-1': closedPr(111), 'T-2': closedPr(112) } });
const tau = Object.fromEntries(N.collect({ word: 'tau' }).items.map((i) => [i.t.key, i]));
t('a closed PR recommends drop, then requeue and not-now', `${tau['T-1']?.kind} ${tau['T-1']?.need} | ${tau['T-1']?.actions.map(([a]) => a).join()} ${tau['T-1']?.actions[0][1] != null}`,
  'pr PR #111 was closed without merging, so nothing will merge it. Drop the ticket, or requeue it; a requeued ticket gets a worker that opens a new PR. | drop,requeue,not-now true');
const dr = N.record({ word: 'tau', ticket: 'T-1', action: 'drop' });
t('drop takes the ticket out of its batch, through queue.mjs, and it is no longer listed',
  `${dr.ok} ${'T-1' in queueOf('tau').tickets} ${'T-2' in queueOf('tau').tickets} ${N.collect({ word: 'tau' }).items.map((i) => i.t.key).join()}`, 'true false true T-2');
t('an open PR offers no drop', N.record({ word: 'eta', ticket: 'E-2', action: 'drop' }).ok, false);

// ---- A ticket the pass would not spawn because its worktree is in use (worktree_busy) needs you, in
// desk-q and here alike, until a pass finds it clean and drops the record.
const busyWhy = 'its worktree /w/U-1 has uncommitted changes (a.txt)';
const aheadWhy = 'its branch fix/U-3 is 2 commit(s) ahead of origin/fix/U-3, not pushed';
put('upsilon', { port: 4900, beat: 1, supervised: true, tickets: {
  'U-1': { state: 'triaged', lane: 'A', worktree_busy: { why: busyWhy, at: minsAgo(30) }, fix: { try: 1, of: 2, pr: 121, kind: 'rereview', what: 'review its head' } },
  'U-2': { state: 'running', lane: 'A', worktree_busy: { why: busyWhy, at: minsAgo(30) } },
  'U-3': { state: 'triaged', lane: 'A', worktree_busy: { why: aheadWhy, at: minsAgo(20) } },
} });
const ur = () => loadRepos().find((x) => x.slug === 'acme__upsilon');
const ups = N.collect({ word: 'upsilon' }).items;
t('uncommitted changes and unpushed commits are each an item naming the cause, offering done and not-now', ups.map((i) => `${i.t.key} ${i.kind} ${i.need} ${i.actions.map(([a]) => a).join()}`).join(' | '),
  `U-1 worktree worktree in use: ${busyWhy} · commit, push or discard it done,not-now | U-3 worktree worktree in use: ${aheadWhy} · commit, push or discard it done,not-now`);
t('desk-q groups both under Needs you with their reason, not Ready, and counts them', `${/Needs you · 2\b/.test(strip(repoScreen(ur())))} ${/U-1 +◆ needs you +worktree in use: its worktree/.test(strip(repoScreen(ur())))} ${/U-3 +◆ needs you +worktree in use: its branch/.test(strip(repoScreen(ur())))} ${strip(repoScreen(ur())).includes('Ready')} ${N.needsCount(ur()).shown}`,
  'true true true false 2');
t('its ticket page says what to do', /Needs you\. No worker starts on it: its worktree \/w\/U-1 has uncommitted changes/.test(ticketScreen(ur(), 'U-1')), true);
t('done records nothing', N.record({ word: 'upsilon', ticket: 'U-1', action: 'done' }).ok, true);
const uq = queueOf('upsilon'); delete uq.tickets['U-1'].worktree_busy; delete uq.tickets['U-3'].worktree_busy;
writeFileSync(join(env.DESK_HOME, 'repos', 'acme__upsilon', 'queue.json'), JSON.stringify(uq));
t('once the pass drops the record it is ready again, and needs nobody', `${shownState(ur().q, ur().q.tickets['U-1'])} ${N.collect({ word: 'upsilon' }).items.length}`, 'ready 0');

// ---- A ready ticket held back by a collision with a running one says so, fix try or not.
put('phi', { port: 5000, beat: 1, supervised: true, tickets: {
  'F-1': { state: 'running', lane: 'A', stage: '4/9', collides_with: 'F-2|F-3' },
  'F-2': { state: 'triaged', lane: 'A', collides_with: 'F-1', fix: { try: 1, of: 2, pr: 131, kind: 'checks', what: 'red: Lint', checks: [{ name: 'Lint' }], not_mine: [] } },
  'F-3': { state: 'triaged', lane: 'A', collides_with: 'F-1' },
  'F-4': { state: 'triaged', lane: 'A', fix: { try: 1, of: 2, pr: 132, kind: 'checks', what: 'red: Lint', checks: [{ name: 'Lint' }], not_mine: [] } },
} });
const phr = loadRepos().find((x) => x.slug === 'acme__phi');
const phiText = (k) => rowText(phr, phr.rows.find((x) => x.t.key === k));
const phi = strip(repoScreen(phr));
t('a fix try held back by a collision waits for the running ticket, not the next free worker, in Ready',
  `${phiText('F-2')} ${/F-2 +○ ready +#131/.test(phi)}`, '#131 · 1 check failed · waits for F-1 (collides), then a worker repairs it, try 1 of 2 true');
t('a ticket held back by a collision says it collides', /F-3 +○ ready +waits for F-1 \(collides\)/.test(phi), true);
t('a fix try with nothing holding it back still goes to the next free worker', phiText('F-4'), '#132 · 1 check failed · next free worker repairs it, try 1 of 2');
t('its ticket page says the same', strip(ticketScreen(phr, 'F-2')).includes('waits for F-1 (collides), then a worker repairs it'), true);

// ---- DS-378: a PR item says in plain words what is wrong and what happens once the person acts, and
// done reads the PR on GitHub there and then.
const held378 = 'merge hold: touches billing — src/billing/**';
const psiPr = (pr, more = {}) => greenPr(pr, { merge_blocked: held378, ...more });
const sha = (pr) => `575fa8c5c${pr}aa`;
const withHead = (t) => ({ ...t, pr_status: { ...t.pr_status, head: sha(t.result.pr) } });
put('psi', { port: 5100, beat: 1, supervised: true, merge: 'yes', tickets: {
  'Q-1': withHead(psiPr(141)),
  'Q-2': withHead(psiPr(142)),
  'Q-3': withHead(psiPr(143)),
  'Q-4': withHead(stuckPr(144, passed, { why: `no review verdict readable at its head after 2 fix tries: the verdict is at ${sha(1)}, not ${sha(144)}` })),
  'Q-5': withHead(draftPr(145, passed, { call: 'findings', why: `its review verdict at ${sha(145)} is not clean (p1=2)`, action: 'settle the findings on #145' })),
  'Q-6': withHead(stuckPr(146, passed, { why: 'still in conflict after 2 fix tries; the last try parked: which side wins?' })),
} });
const psi = () => Object.fromEntries(N.collect({ word: 'psi' }).items.map((i) => [i.t.key, i]));
const p0 = psi();
t('DS-378 every PR item is listed', Object.keys(p0).sort().join(), 'Q-1,Q-2,Q-3,Q-4,Q-5,Q-6');
t('DS-378 AC4 a merge hold says what holds it and what happens once it is merged', p0['Q-1']?.need,
  'PR #141 touches files under a merge hold (touches billing — src/billing/**), so desk never merges it itself. Merge it on GitHub when you are ready; the ticket is then done.');
t('DS-378 AC4 a PR with no readable review says what to do and what follows', p0['Q-4']?.need,
  'PR #144 has no code review desk can read for its latest commit. Post one (run /desk-review on it); the next pass then takes it on.');
t('DS-378 AC4 a draft with findings counts them in words', p0['Q-5']?.need,
  'PR #145 is a draft, and its code review found 2 P1 findings that desk\'s own repairs did not fix. Fix them on its branch and post a fresh review; the next pass then takes it out of draft.');
t('DS-378 AC4 a conflict names the base', p0['Q-6']?.need,
  'PR #146 is in conflict with main, and desk\'s own repairs did not fix it. Resolve the conflict on its branch; desk then merges it once its checks are green.');
// AC3 and AC4 across every PR item any fixture repo lists.
const prItems = N.collect().items.filter((i) => i.kind === 'pr' || /PR #\d+/.test(i.need));
t('DS-378 AC3 no PR item names a commit SHA, a fix try or a review verdict', prItems.filter((i) => /\b[0-9a-f]{7,40}\b|fix tr(y|ies)|verdict readable/i.test(i.need)).map((i) => `${i.t.key}: ${i.need}`).join(' | '), '');
t('DS-378 AC4 every PR item says what is wrong, then what to do and what happens next', prItems.filter((i) => i.kind === 'pr' && !/^PR #\d+[^]*\. [A-Z][^]*; [^]*?\.(?: \([^]*\))?$/.test(i.need)).map((i) => `${i.t.key}: ${i.need}`).join(' | '), '');
// AC1: done on a PR still open says so, and the item comes back with that note.
onGitHub(141, { state: 'OPEN', mergedAt: null, isDraft: false, headRefOid: sha(141) });
const q1 = N.record({ word: 'psi', ticket: 'Q-1', action: 'done' });
t('DS-378 AC1 done on a PR still open says GitHub still shows it unmerged', `${q1.ok} ${q1.line}`, 'false psi Q-1: GitHub still shows PR #141 unmerged, so it stays on your list with that note.');
t('DS-378 AC1 it is read from the repo\'s GitHub', readFileSync(GH_LOG, 'utf8').includes('pr view 141 --repo acme/psi --json state,mergedAt,isDraft,headRefOid'), true);
t('DS-378 AC1 it is listed again with that note', /^\(You said done at \d{4}-\d\d-\d\d \d\d:\d\d UTC, and GitHub still showed it unmerged\.\)$/.test(psi()['Q-1']?.note ?? ''), true);
const q1Line = cli('list', 'psi').out.split('\n').find((l) => l.startsWith('psi Q-1 pr')) ?? '';
t('DS-378 AC1 the listed line keeps the need and the note whole', q1Line.includes(`| ${psi()['Q-1'].need} ${psi()['Q-1'].note} |`), true);
// AC4 on the listed line: recorded text a need quotes is cut short, so the line's cut never takes the next step.
const longHold = withHead(psiPr(147, { merge_blocked: `merge hold: ${'touches a very long list of held paths, '.repeat(6)}` }));
const qhl = queueOf('psi'); qhl.tickets['Q-7'] = { key: 'Q-7', ...longHold };
writeFileSync(join(env.DESK_HOME, 'repos', 'acme__psi', 'queue.json'), JSON.stringify(qhl));
t('DS-378 AC4 a long merge hold still says what happens next on its listed line',
  (cli('list', 'psi').out.split('\n').find((l) => l.includes('| PR #147 ')) ?? '').includes('Merge it on GitHub when you are ready; the ticket is then done. |'), true);
delete qhl.tickets['Q-7']; writeFileSync(join(env.DESK_HOME, 'repos', 'acme__psi', 'queue.json'), JSON.stringify(qhl));
t('DS-378 AC1 the CLI shows it to the person', cli('record', 'psi', 'Q-1', 'done').code, 11);
const qh = queueOf('psi'); qh.tickets['Q-1'].pr_status.head = sha(999);
writeFileSync(join(env.DESK_HOME, 'repos', 'acme__psi', 'queue.json'), JSON.stringify(qh));
t('DS-378 AC1 once its head moves, the note goes', psi()['Q-1']?.note, '');
// AC2: done after merging it: said, recorded, and not listed again.
onGitHub(142, { state: 'MERGED', mergedAt: '2026-10-31T09:00:00Z', isDraft: false, headRefOid: sha(142) });
const q2 = N.record({ word: 'psi', ticket: 'Q-2', action: 'done' });
const q2t = queueOf('psi').tickets['Q-2'];
t('DS-378 AC2 done after merging says it merged', `${q2.ok} ${q2.line}`, 'true psi Q-2: GitHub shows PR #142 merged, so it is off your list.');
t('DS-378 AC2 the merge is recorded for the next pass', `${q2t.pr_status.state} ${q2t.pr_status.merged_at}`, 'MERGED 2026-10-31T09:00:00Z');
t('DS-378 AC2 it is not listed again, nor counted', `${'Q-2' in psi()} ${N.needsCount(loadRepos().find((x) => x.slug === 'acme__psi')).rows.some((x) => x.t.key === 'Q-2')}`, 'false false');
// AC5: GitHub cannot be read: said, and nothing claims the step done.
const q3 = N.record({ word: 'psi', ticket: 'Q-3', action: 'done' });
t('DS-378 AC5 an unreadable PR says its state could not be read, and is not marked done',
  `${q3.ok} ${/could not read PR #143's state from GitHub \(GraphQL: Could not resolve to a PullRequest \(143\)\), so it is not marked done and stays on your list\./.test(q3.line)} ${queueOf('psi').tickets['Q-3'].done_check} ${'Q-3' in psi()}`, 'false true undefined true');

// ---- DS-379 AC3: a draft whose capture try could not take its screenshots names each screen and what
// its worker said, whole, however long, and says what to do.
const said379 = '[s-2-before.png: the settings route needs a signed-in admin and the seed has none; s-2-after.png: same, and the page 500s without one]';
const capturePr = (pr, files, said) => { const s = stuckPr(pr, passed, { why: `${files.length} screenshot(s) still not taken after a capture try: ${files.join(', ')}${said ? `; the capture try said: ${said}` : ''}` }); return { ...s, pr_status: { ...s.pr_status, isDraft: true } }; };
put('chi', { port: 5200, beat: 1, supervised: true, merge: 'yes', tickets: {
  'C-1': capturePr(151, ['s-2-before.png', 's-2-after.png'], said379),
  'C-2': capturePr(152, ['a-after.png'], null),
} });
const chi = Object.fromEntries(N.collect({ word: 'chi' }).items.map((i) => [i.t.key, i]));
t('DS-379 AC3 a stuck capture try says what to do', chi['C-1']?.need,
  'PR #151 is a draft, and desk\'s capture try could not take 2 of its screenshots. Take them and upload them to the PR; the next pass then takes it out of draft.');
t('DS-379 AC3 its note names each screen and the worker\'s reason, whole', chi['C-1']?.note, `(Not taken: s-2-before.png, s-2-after.png. The capture try said: ${said379})`);
const c1Line = cli('list', 'chi').out.split('\n').find((l) => l.startsWith('chi C-1 pr')) ?? '';
t('DS-379 AC3 the listed line keeps the need and the note whole', c1Line.includes(`| ${chi['C-1'].need} ${chi['C-1'].note} |`), true);
t('DS-379 AC3 one screen with nothing said still names it', `${chi['C-2']?.need} ${chi['C-2']?.note}`,
  'PR #152 is a draft, and desk\'s capture try could not take one of its screenshots. Take it and upload it to the PR; the next pass then takes it out of draft. (Not taken: a-after.png.)');

// ---- DS-380: a parked ticket moved into the repo's other running batch, on that batch's base
put('omega', { port: 3900, beat: 1, supervised: true, tickets: {
  'M-1': parked('A', 30, 'a worker cannot change its own base: please move it to batch F-1'),
  'M-2': parked('A', 20, 'the file is on the feature branch'),
  'M-3': parked('A', 10, 'this one too'),
  'M-4': parked('A', 9, 'and this one'),
  'M-5': parked('A', 8, 'and this one'),
}, triage: { 'M-1': { lane: 'A', size: 'S', files_in_scope: ['src/m1.js'] }, 'M-2': { lane: 'A', size: 'S', files_in_scope: ['src/m2.js'] }, 'M-3': { lane: 'A', size: 'S' }, 'M-4': { lane: 'A', size: 'S' }, 'M-5': { lane: 'A', size: 'S' } } });
const omegaRoot = join(T, 'repos', 'omega');
const og = (...a) => spawnSync('git', ['-C', omegaRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
og('commit', '-q', '--allow-empty', '-m', 'init'); og('branch', '-M', 'main'); og('update-ref', 'refs/remotes/origin/main', 'HEAD');
// M-1's last worker left a worktree cut from main with no work of its own; M-2's committed to its own.
const wt = (k) => join(`${omegaRoot}-worktrees`, k);
og('worktree', 'add', '-q', '-b', 'fix/M-1', wt('M-1'), 'main');
og('worktree', 'add', '-q', '-b', 'fix/M-2', wt('M-2'), 'main');
spawnSync('git', ['-C', wt('M-2'), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'work']);
const fq = join(env.DESK_HOME, 'repos', 'acme__omega', 'batches', 'F-1', 'queue.json');
const fs = join(env.HOME, '.desk-autopilot', 'acme__omega', 'batches', 'F-1');
mkdirSync(dirname(fq), { recursive: true });
writeFileSync(fq, JSON.stringify({ version: 1, batch: 'f1-batch', base: 'feat/f', concurrency: 1, supervised: true, tickets: { 'F-2': { key: 'F-2', state: 'running', lane: 'A', added_at: minsAgo(60) } } }));
const fQueue = () => JSON.parse(readFileSync(fq, 'utf8'));
const omegaList = cli('list', 'omega').out.split('\n');
t('DS-380 a parked ticket offers move, naming the running batch and its base', omegaList.some((l) => l.startsWith('omega M-1 parked') && l.includes('move (move <batch> takes it out of this batch and queues it in another, its next worker on that base: F-1 (on feat/f))')), true);
const m1 = N.record({ word: 'omega', ticket: 'M-1', action: 'move', text: 'F-1' });
const mv1 = fQueue().tickets['M-1'];
t('DS-380 AC1 the ticket is out of the first queue and queued in the feature batch', `${m1.ok} ${'M-1' in queueOf('omega').tickets} ${mv1?.state} ${mv1?.moved_from?.base}`, 'true false triaged main');
t('DS-380 AC1 its triage record goes with it, so the feature batch admits it', existsSync(join(fs, 'triage', 'M-1.json')), true);
t('DS-380 AC1 its next worker starts on the feature branch: the stale worktree and branch cut from main are gone', `${/its next worker starts on feat\/f\. Its worktree .*M-1, cut from main with no work of its own, was removed/.test(m1.line)} ${existsSync(wt('M-1'))} ${og('show-ref', '--verify', '--quiet', 'refs/heads/fix/M-1').status}`, 'true false 1');
const m2 = N.record({ word: 'omega', ticket: 'M-2', action: 'move', text: 'omega:F-1' });
t('DS-380 a worktree holding its own commits is never removed, and nothing moves', `${m2.ok} ${/holds work cut from main \(1 commit\(s\) not on origin\/main\)/.test(m2.line)} ${existsSync(wt('M-2'))} ${'M-2' in queueOf('omega').tickets} ${'M-2' in fQueue().tickets}`, 'false true true true false');
const m3 = N.record({ word: 'omega', ticket: 'M-3', action: 'move', text: 'G-9' });
t('DS-380 AC2 a move naming a batch that is not running is refused, naming those that are', `${m3.ok} ${m3.line}`, 'false omega M-3: G-9 is not a batch running in omega beside this one, so nothing was moved. The batches running are F-1 (on feat/f).');
t('DS-380 AC2 and nothing moved', `${'M-3' in queueOf('omega').tickets} ${'M-3' in fQueue().tickets}`, 'true false');
// A feature batch whose spine is not done holds a ticket moved into it behind that spine.
writeFileSync(fq, JSON.stringify({ ...fQueue(), feature: true, spine: 'F-2' }));
const m4 = N.record({ word: 'omega', ticket: 'M-4', action: 'move', text: 'F-1' });
const mv4 = fQueue().tickets['M-4'];
t('DS-380 a ticket moved into a feature batch waits behind its unfinished spine', `${m4.ok} ${mv4?.state} ${mv4?.held_by}`, 'true parked F-2');
// New files nobody committed are work too: the worktree stays, and nothing moves.
og('worktree', 'add', '-q', '-b', 'fix/M-5', wt('M-5'), 'main');
writeFileSync(join(wt('M-5'), 'new.js'), 'work\n');
const m5 = N.record({ word: 'omega', ticket: 'M-5', action: 'move', text: 'F-1' });
t('DS-380 a worktree holding untracked files is never removed, and nothing moves', `${m5.ok} ${/holds work cut from main \(uncommitted changes or untracked files\)/.test(m5.line)} ${existsSync(join(wt('M-5'), 'new.js'))} ${'M-5' in queueOf('omega').tickets} ${'M-5' in fQueue().tickets}`, 'false true true true false');
// Refusals.
t('an item desk-q does not count records nothing', N.record({ word: 'alpha', ticket: 'A-5', action: 'answer', text: 'x' }).ok, false);
t('an unknown repo exits 11', cli('record', 'zeta', 'Z-1', 'done').code, 11);

console.log(fails ? `\n${fails} check(s) did not pass` : '\nall passed');
process.exit(fails ? 1 : 0);
