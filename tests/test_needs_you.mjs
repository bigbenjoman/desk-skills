// suite: needs-you (every item desk-q counts as needing the person, and recording each answer)
// budget: 115 DS-943 (831 checks over a dozen fixture worlds, each with git repos; 49-88 s on CI)
// covers: desk/bin/needs-you.mjs desk/bin/asks.mjs desk/bin/decider.mjs skills/desk-needs-you/**
// Fixture repos, queues, heartbeats, triage records and decision logs under a throwaway HOME,
// DESK_HOME and DESK_CONFIG_ROOT. DESK_HOME/bin links the real scripts, except answer.mjs: a fake
// that logs each call and then runs the real one. Nothing touches your real ~/.claude or state.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, existsSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { scratch } from './scratch.mjs';
const require = createRequire(import.meta.url);
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_BIN = join(ROOT, 'desk', 'bin');
const NOW = Date.now();
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();

const T = scratch('desk-needs-you-');
mkdirSync(join(T, 'bin'));
// A fake's rule, as a script's body: the fake in bin/ runs it as its own process, and the suite's in-process
// reads (launchctl's and STUB's, below) call the same function. Self-contained: it takes its paths as arguments.
const fakeScript = (fn, ...args) => `#!${process.execPath}\nconst r = (${fn})(${args.join(', ')});\nif (r.err) process.stderr.write(r.err + '\\n');\nprocess.stdout.write(r.out ?? '');\nprocess.exit(r.code);\n`;
// macOS, with a fake launchctl that has each label in bin/loaded loaded.
const LOADED = join(T, 'bin', 'loaded');
const launchctlPrint = (loaded, target) => {
  const { readFileSync } = require('node:fs');
  let labels = [];
  try { labels = readFileSync(loaded, 'utf8').split('\n'); } catch { /* none loaded */ }
  return { code: labels.includes(String(target ?? '').split('/').pop()) ? 0 : 1 };
};
writeFileSync(join(T, 'bin', 'launchctl'), fakeScript(launchctlPrint, JSON.stringify(LOADED), 'process.argv[3]'), { mode: 0o755 });
writeFileSync(LOADED, 'com.desk-skills.supervisor.acme__alpha\n');
// A fake gh that logs its arguments, and answers `pr view <n>` with prs/<n>.json, failing with none, and
// `pr list --repo <r> --state <s>` with prs/list-<s>.json, or nothing.
const GH_LOG = join(T, 'gh.log');
const GH_PRS = join(T, 'prs');
mkdirSync(GH_PRS);
const prView = (dir, pr) => {
  const { readFileSync, existsSync } = require('node:fs');
  const f = `${dir}/${pr}.json`;
  return existsSync(f) ? { code: 0, out: readFileSync(f, 'utf8') } : { code: 1, err: `GraphQL: Could not resolve to a PullRequest (${pr})` };
};
writeFileSync(join(T, 'bin', 'gh-pr-view'), fakeScript(prView, JSON.stringify(GH_PRS), 'process.argv[2]'), { mode: 0o755 });
writeFileSync(join(T, 'bin', 'gh'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(GH_LOG)}\n` +
  `if [ "$1 $2" = "pr view" ]; then exec "$(dirname "$0")/gh-pr-view" "$3"; fi\n` +
  `if [ "$1 $2 $5" = "pr list --state" ]; then f=${JSON.stringify(GH_PRS)}/list-"$6".json; [ -f "$f" ] && cat "$f"; fi\n` +
  `if [ "$1 $2" = "pr create" ]; then echo "https://github.com/$4/pull/931"; fi\nexit 0\n`, { mode: 0o755 });
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
// The fake answer.mjs logs its call, then runs the real one in its own process (one node, not two). Its
// launchctl prints are answered in that process by bin/launchctl's own rule, as the suite's are below:
// every repo load asks once per supervised batch, so a fake launchctl process per ask cost about 23
// node starts per answer once the fixture holds that many batches (DS-929 AC3).
writeFileSync(join(BIN, 'answer.mjs'), `import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
appendFileSync(${JSON.stringify(ANSWERS)}, JSON.stringify({ args: process.argv.slice(2), queue: process.env.DESK_QUEUE }) + '\\n');
const launchctlPrint = ${launchctlPrint};
const cp = require('node:child_process');
const spawnSync = cp.spawnSync;
cp.spawnSync = function (cmd, args, ...rest) {
  if (String(cmd).split('/').pop() !== 'launchctl' || args?.[0] !== 'print') return spawnSync.call(this, cmd, args, ...rest);
  const { code } = launchctlPrint(${JSON.stringify(LOADED)}, args[1]);
  return { pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: code, signal: null };
};
syncBuiltinESMExports();
process.argv[1] = ${JSON.stringify(join(REAL_BIN, 'answer.mjs'))};
await import(process.argv[1]);
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
    (r.handle ? `## 1. Who you are\n\n| Field | Value |\n|---|---|\n| GitHub handle | \`${r.handle}\` |\n\n` : '') +
    `## 2. Paths\n\n| Field | Value |\n|---|---|\n| Primary repo root | \`${root}\` |\n\n` +
    `## 3. Permissions\n\n| Key | Action | Recommended | Your setting |\n|---|---|---|---|\n| \`pr-ready\` | Undraft | \`ask\` | \`${r.prReady ?? 'no'}\` |\n` +
    `| \`autopilot-merge\` | The merge driver merges | \`ask\` | \`${r.merge ?? 'no'}\` |\n| \`pr-merge-green\` | Merge a green PR | \`ask\` | \`${r.merge ?? 'no'}\` |\n\n` +
    `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`${r.port}\` |\n| Autopilot worker concurrency | \`2 / 3\` | \`2 / 3\` |\n` +
    `| Batches run by | \`supervisor\` | \`${r.supervised ? 'supervisor' : 'session'}\` |\n` +
    (r.required ? `\n## 4. Repo\n\n| Field | Value |\n|---|---|\n| Required checks | ${r.required.map((c) => `\`${c}\``).join(', ')} |\n` : '') +
    (r.gateReviewers ? `\n## 4. Repo\n\n| Field | Value |\n|---|---|\n| Gate reviewers | \`${r.gateReviewers}\` |\n` : '') +
    (r.evidence ? `\n## 4. Repo\n\n| Field | Value |\n|---|---|\n| Evidence workflow | \`${r.evidence}\` |\n` : '') +
    (r.pattern ? `\n## 4. Repo\n\n| Field | Value |\n|---|---|\n| Tracker | \`jira\` |\n| Ticket key pattern | \`${r.pattern}\` |\n` : '') +
    (r.site ? `\n## 4. Repo\n\n| Field | Value |\n|---|---|\n| Tracker | \`jira\` |\n| Jira site | \`${r.site}\` |\n` : '') +
    (r.project ? `\n## 4. Repo\n\n| Field | Value |\n|---|---|\n| Jira project | \`${r.project}\` |\n` : '') +
    (r.owner ? `\n## 1. Who you are\n\n| Field | Value |\n|---|---|\n| Jira display name | \`${r.owner}\` |\n` : '') +
    (r.promotionRef ? `\n## 4. Repo\n\n| Field | Value |\n|---|---|\n| Promotion ref | \`${r.promotionRef}\` |\n` : '') +
    (r.inputLabels ? `\n## 4. Repo\n\n| Field | Value |\n|---|---|\n| Person-input labels | \`${r.inputLabels}\` |\n` : '') +
    (r.stepLabels ? `\n## 4. Repo\n\n| Field | Value |\n|---|---|\n| Person-step labels | \`${r.stepLabels}\` |\n` : '') +
    (r.people ? `\n## 4. Repo\n\n### People, by role\n\n| Role | Currently | Confirmed |\n|---|---|---|\n${Object.entries(r.people).map(([k, v]) => `| ${k} | \`${v}\` | \`yes\` |`).join('\n')}\n` : ''));
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

// ---- DS-929: an in-process collect or refresh starts no process. Every child process this suite's own
// process starts goes through these wrappers (syncBuiltinESMExports carries them into the modules' named
// imports). launchctl, which loadRepos asks once per supervised batch, is answered here by bin/launchctl's
// own rule (launchctlPrint). A gh, git, desk-jira or launchctl process started while a collect or refresh
// runs on the suite's stubs (onStubs, below) is recorded, and the last check reads that none was.
// The cli() runs still start needs-you.mjs and the fakes in bin/, end to end.
const cpCjs = require('node:child_process');
const FAKED = new Set(['gh', 'git', 'desk-jira', 'launchctl']);
let onStubDepth = 0;
const startedOnStubs = [];
const launchctlHere = (args) => {
  const { code } = launchctlPrint(LOADED, args[1]);
  return { pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: code, signal: null };
};
for (const f of ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'exec']) {
  const real = cpCjs[f];
  cpCjs[f] = function (cmd, ...rest) {
    const bin = String(cmd).trim().split(/\s+/)[0].split('/').pop();
    const args = Array.isArray(rest[0]) ? rest[0] : [];
    if (f === 'spawnSync' && bin === 'launchctl' && args[0] === 'print') return launchctlHere(args);
    if (onStubDepth > 0 && FAKED.has(bin)) startedOnStubs.push(`${bin} ${args.join(' ')}`.trim());
    return real.call(this, cmd, ...rest);
  };
}
syncBuiltinESMExports();

const NY = await import('../desk/bin/needs-you.mjs');
const { dayAndTime } = await import('../desk/bin/desk-q-eta.mjs');
const { loadRepos, repoScreen } = await import('../desk/bin/desk-q.mjs');
// The reads every in-process collect and refresh is given unless a case passes its own: GitHub's PRs from
// the fixtures the fake gh serves (onGitHub), and no ticket status, worktree, fetch, merged PR elsewhere or
// red-main issue, which is what the real reads find under this suite's fakes. A case that means to test a
// real read passes it (DS-546 AC3's git, the follow gates' git, DS-925's ciRed), and its starts are not counted.
const STUB = {
  pr: (_r, pr) => {
    const { code, out, err } = prView(GH_PRS, pr);
    return code === 0 ? { v: JSON.parse(out), err: '' } : { v: null, err };
  },
  ticket: () => null,
  git: () => null,
  fetch: () => false,
  merged: () => null,
  ciRed: () => [],
};
// collect and refresh as the suite calls them: on that batch's repos, loaded here as the CLI loads them, and
// on STUB, unless the case passes its own reads (null too).
const realReads = new Set(Object.values(NY.READS));
const onStubs = (fn) => (o = {}) => {
  const reads = 'reads' in o ? o.reads : STUB;
  const counted = !Object.values(reads ?? {}).some((r) => realReads.has(r));
  if (counted) onStubDepth++;
  try { return fn({ ...o, repos: o.repos ?? loadRepos(o.now ?? Date.now(), o.word ?? null), reads }); } finally { if (counted) onStubDepth--; }
};
const N = { ...NY, collect: onStubs(NY.collect), refresh: onStubs(NY.refresh) };
const queueOf = (name) => JSON.parse(readFileSync(join(env.DESK_HOME, 'repos', `acme__${name}`, 'queue.json'), 'utf8'));
const cliRan = new Set();
const cli = (...args) => { cliRan.add(args[0]); const r = spawnSync(process.execPath, [join(REAL_BIN, 'needs-you.mjs'), ...args], { encoding: 'utf8', env: process.env, cwd: T }); return { code: r.status, out: r.stdout, err: r.stderr }; };
// A CLI command run in this process through needs-you.mjs's own run(), which its entry prints, for a check
// that tests what the command decides rather than the script. list runs on STUB, as collect and refresh do
// here; record, left and ask on their own reads, as before. Each command keeps cli() runs too, end to end,
// and the last checks read that it did (DS-929 AC2).
const here = (cmd, ...rest) => {
  if (cmd !== 'list') return NY.run([cmd, ...rest]);
  onStubDepth++;
  try { return NY.run([cmd, ...rest], { reads: STUB }); } finally { onStubDepth--; }
};

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
t('AC4 the answer went through answer.mjs for that repo', JSON.stringify(answers().at(-1)), JSON.stringify({ args: ['A-1', '--all', 'the short one'], queue: join(env.DESK_HOME, 'repos', 'acme__alpha', 'queue.json') }));
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
t('DS-297 AC3 a lane C park offers open, done, drop and not-now, never resume', itemLines.find((l) => l.startsWith('alpha A-2 session'))?.split(' | ').slice(2).join(' | ').replace(/ \([^)]*\)/g, ''), '1. open | 2. done | 3. drop | 4. not-now');
const ca2 = N.record({ word: 'alpha', ticket: 'A-2', action: 'answer', text: 'go' });
t('DS-297 AC3 answer on a lane C park is refused', `${ca2.ok} ${/answer is not an action for a session item/.test(ca2.line)}`, 'false true');

// ---- AC8: "not now" goes in the not-now register
const n6 = N.record({ word: 'alpha', ticket: 'A-6', action: 'not-now' });
const reg = readFileSync(join(env.HOME, '.desk-autopilot', 'acme__alpha', 'not-now.jsonl'), 'utf8');
t('AC8 a parked item put off is in the register, through answer.mjs', `${n6.ok} ${reg.includes('PRODUCTION BROKEN: checkout returns 500')} ${answers().at(-1).args.join(' ')}`, 'true true A-6 --all not now');
const n4 = N.record({ word: 'alpha', ticket: 'A-4', action: 'not-now' });
t('AC8 a hold put off is in the register too, and stays held', `${n4.ok} ${readFileSync(join(env.HOME, '.desk-autopilot', 'acme__alpha', 'not-now.jsonl'), 'utf8').includes('"ticket":"A-4"')} ${queueOf('alpha').tickets['A-4'].held_by}`, 'true true A-9');
// DS-324 AC1, AC3: a put-off item is not listed again, on this run or a later one, and the count leaves it out.
const offList = here('list', 'alpha');
t('DS-324 AC1 a put-off park and hold are not listed', `${N.collect({ word: 'alpha' }).items.some((i) => ['A-4', 'A-6'].includes(i.t.key))} ${/^alpha A-[46] /m.test(offList.out)}`, 'false false');
t('DS-324 AC1 the count line leaves them out and says so', offList.out.trim().split('\n').at(-1), `${offList.out.split('\n').filter((l) => / \| /.test(l)).length} items in 1 repo. 2 put off with not-now, left out until they change.`);
t('DS-324 AC3 a later run with nothing changed still leaves them out', N.collect({ word: 'alpha', repos: loadRepos(NOW + 86400000) }).items.some((i) => ['A-4', 'A-6'].includes(i.t.key)), false);

// ---- A spine approval runs as its own repo, and what is left for the person is shown, not refused
const s7 = N.record({ word: 'alpha', ticket: 'A-7', action: 'approve' });
// The listings above read each repo's red-main issues (`issue list`); the approve's own call is the rest.
const gh = (existsSync(GH_LOG) ? readFileSync(GH_LOG, 'utf8') : '').split('\n').filter((l) => !l.startsWith('issue list ')).join('\n');
t('approve undrafts the PR in the spine\'s repo, under its config, not this checkout\'s', gh.trim(), 'pr ready 41 --repo acme/alpha');
t('approve that leaves the merge to the person is recorded, and says so', `${s7.ok} ${queueOf('alpha').tickets['A-7'].state} ${/merge PR #41 yourself/.test(s7.line)}`, 'true done true');

// ---- AC9: a named repo asks only about its own items
t('AC9 one repo', N.collect({ word: 'beta' }).items.map((i) => `${i.r.name} ${i.t.key}`).join(), 'beta B-1');

// ---- AC10: nothing needing the person is one line
t('AC10 nothing in a named repo', here('list', 'delta').out.trim(), 'Nothing needs you in delta.');
const quiet = loadRepos().filter((r) => ['delta', 'epsilon'].includes(r.name));
t('AC10 nothing anywhere', N.listText(N.collect({ repos: quiet })), 'Nothing needs you.');

// ---- AC15: a live session's batch is not requeued; the session is named to message
const b1 = cli('record', 'beta', 'B-1', 'resume', 'the v2 one');
t('AC15 answered, not requeued', `${b1.code} ${queueOf('beta').tickets['B-1'].state} ${answers().at(-1).args.join(' ')}`, '0 parked B-1 --all the v2 one');
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
// A-1, A-3, A-7, B-1 and G-1 are settled; A-4 and A-6 are put off; A-2 and A-8 still need you, and so do
// gamma's stopped passes (#911): G-1 requeued waits on a pass its session no longer runs.
t('AC11 (DS-324 AC4) the count left is what list prints', left[0], 'desk-q counts 3 items needing you. 2 put off with not-now, left out until they change.');
t('DS-324 AC4 left matches list', N.collect().items.map((i) => i.t.key).sort().join(), 'A-2,A-8,stalled');

// ---- desk-q's NEEDS YOU and left's count are one number, the put-off items said beside it
const { overview } = await import('../desk/bin/desk-q.mjs');
const home = () => overview(loadRepos(), { now: NOW, avail: 30 }).split('\n');
// The cell ends where its right-aligned header does.
const needsCell = () => {
  const h = home(), end = h.find((l) => l.includes('NEEDS YOU')).indexOf('NEEDS YOU') + 'NEEDS YOU'.length;
  return h.find((l) => l.startsWith('  alpha '))?.slice(0, end).match(/(\d+(?: \(\+\d+ put off\))?)$/)?.[1];
};
t('DS-376 AC1 the NEEDS YOU cell shows what needs you, then how many are put off', needsCell(), '2 (+2 put off)');
t('DS-376 AC1 the header counts what needs you, as the cell does', home()[0].startsWith('◆ 3 tickets need you'), true);
t('DS-376 AC2 left attributes to desk-q the count its table shows', `${left[0].match(/^desk-q counts (\d+) /)?.[1]} ${N.needsCount(loadRepos().find((r) => r.name === 'alpha'))?.shown}`, '3 2');

// ---- DS-324 AC2: a put-off item comes back once its blocker or its inputs change
const aq = queueOf('alpha');
aq.tickets['A-9'] = { key: 'A-9', state: 'done', lane: 'A', added_at: minsAgo(600) };
aq.tickets['A-6'].park.inputs = { 'pr-head': 'bbb' };
writeFileSync(join(env.DESK_HOME, 'repos', 'acme__alpha', 'queue.json'), JSON.stringify(aq));
const back = N.collect({ word: 'alpha' }).items;
t('DS-324 AC2 a hold whose blocker went done is listed again, saying what changed', /^A-9 finished with no PR: let it start \(Changed since it was put off on \d{4}-\d\d-\d\d: blockers A-9:none → A-9:done; need .*\.\)$/.test(back.find((i) => i.t.key === 'A-4')?.need ?? ''), true);
t('DS-324 AC2 a park whose inputs changed is listed again, saying what changed', /^PRODUCTION BROKEN: checkout returns 500 \(Changed since it was put off on \d{4}-\d\d-\d\d: pr-head \(new\) → bbb\.\)$/.test(back.find((i) => i.t.key === 'A-6')?.need ?? ''), true);
t('DS-376 AC3, AC4 both count the changed ones as needing you, and the cell is the count alone with none put off',
  `${needsCell()} ${N.needsCount(loadRepos().find((r) => r.name === 'alpha')).shown} ${back.length} ${here('left', 'alpha').out.split('\n')[0]}`, '4 4 4 desk-q counts 4 items needing you in alpha.');
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
const xList = here('list', 'alpha');
t('DS-310 AC3 the item names the named batch, as record takes it', xList.out.split('\n').some((l) => l.startsWith('alpha:X-1 X-2 parked') && l.includes('| Which banner? |')), true);
t('DS-310 AC3 the repo\'s name lists its standing batch\'s items and the named batch\'s', `${xList.out.includes('\nalpha A-2 ')} ${/^@ alpha · X-1 \(feat\/x\): run by the supervisor/m.test(xList.out)}`, 'true true');
t('DS-310 AC3 the named batch on its own lists only its items', cli('list', 'alpha:X-1').out.split('\n').filter((l) => / \| /.test(l)).map((l) => l.split(' ')[1]).join(), 'X-2,X-3');
const x2 = cli('record', 'alpha:X-1', 'X-2', 'resume', 'the red one');
const xQueue = () => JSON.parse(readFileSync(xq, 'utf8'));
t('DS-310 AC3 the answer went through answer.mjs for the named batch', JSON.stringify(answers().at(-1)), JSON.stringify({ args: ['X-2', '--all', 'the red one'], queue: xq }));
t('DS-310 AC3 the ticket is requeued in the named batch', `${x2.code} ${xQueue().tickets['X-2'].state}`, '0 triaged');
const x3 = N.record({ word: 'alpha', ticket: 'X-3', action: 'resume', text: 'the plain one' });
t('DS-310 AC3 a repo\'s name finds the batch that holds the ticket', `${x3.ok} ${answers().at(-1).queue === xq} ${xQueue().tickets['X-3'].state} ${queueOf('alpha').tickets['X-3']}`, 'true true triaged undefined');

// ---- DS-279: every row desk-q puts in Needs you is asked about: a worker that gave up, and a PR only you move.
put('eta', { port: 3700, beat: 1, supervised: true, tickets: {
  'E-1': { state: 'failed', lane: 'A', park: { question: 'tests red', since: minsAgo(15) } },
  'E-2': { state: 'done', lane: 'A', result: { pr: 61 }, pr_status: { pr: 61, state: 'OPEN', url: null, isDraft: false, mergeable: 'MERGEABLE', checks: [{ name: 'build', status: 'completed', conclusion: 'success' }], at: minsAgo(1) } },
} });
put('theta', { port: 3800, beat: 1, supervised: true, project: 'X', tickets: {
  'H-1': { state: 'running', lane: 'A' },
  'H-2': { state: 'parked', lane: 'A', held_by: 'H-1', open_questions: 1, outside_blockers: [{ key: 'X-9', assignee: null }], park: { question: 'held by orchestrator: blocked by H-1 — starts once their PRs merge' } },
} });
const NN = await import('../desk/bin/not-now.mjs');
const thetaState = join(env.HOME, '.desk-autopilot', 'acme__theta');
// A put-off under the outside question's triage key, with its start-anyway need and no blocker input.
NN.addPutOff(NN.putOffEntry({ question: 'H-2 triage', ticket: 'H-2', inputs: { ticket: 'H-2', need: 'held by X-9, outside this batch: start anyway?' } }), thetaState);
// A blocker another batch of the repo holds: something works it, so there is nothing to admit.
const yq = join(env.DESK_HOME, 'repos', 'acme__theta', 'batches', 'Y-B', 'queue.json');
mkdirSync(dirname(yq), { recursive: true });
writeFileSync(yq, JSON.stringify({ version: 1, batch: 'yb-batch', base: 'feat/y', concurrency: 1, supervised: true, tickets: { 'Y-1': { key: 'Y-1', state: 'running', lane: 'A', added_at: minsAgo(60) } } }));
const thq = queueOf('theta');
thq.tickets['H-3'] = { key: 'H-3', state: 'triaged', lane: 'A', open_questions: 1, added_at: minsAgo(50), outside_blockers: [{ key: 'Y-1', category: 'indeterminate' }] };
writeFileSync(join(env.DESK_HOME, 'repos', 'acme__theta', 'queue.json'), JSON.stringify(thq));
const theta = () => Object.fromEntries(N.collect({ word: 'theta' }).items.map((i) => [i.t.key, i]));
const h2 = theta()['H-2'];
t('DS-401 AC3 (DS-279) a ticket held by an open ticket in no batch is a held row naming its state, recommending admitting it',
  `${h2?.kind} | ${h2?.need} | ${h2?.actions.map((a) => a[0]).join()} | ${h2?.actions[0][1]}`,
  'held | held by X-9 (to do, in no batch), outside this batch | admit,answer,not-now | X-9 is in no batch, so nothing works it: admitting queues it for a worker');
t('DS-401 its put-off as the old outside question no longer hides it (KAN-609)', h2 != null, true);
t('DS-401 AC3 a blocker another batch holds is named there, and offers no admit', `${theta()['H-3']?.kind} | ${theta()['H-3']?.need} | ${theta()['H-3']?.actions.map((a) => a[0]).join()}`,
  'held | held by Y-1 (in progress, in batch Y-B), outside this batch | answer,not-now');
const ad2 = N.record({ word: 'theta', ticket: 'H-2', action: 'admit' });
t('DS-401 AC3 admit records nothing and names the /desk-admit to run', `${ad2.ok} ${/nothing recorded\. Run \/desk-admit X-9 in .*; H-2 stays held until it is Done/.test(ad2.line)} ${queueOf('theta').tickets['H-2'].state}`, 'true true parked');
t('DS-401 admit is refused where no blocker is in no batch', N.record({ word: 'theta', ticket: 'H-3', action: 'admit' }).ok, false);
N.record({ word: 'theta', ticket: 'H-2', action: 'not-now' });
t('DS-401 AC4 put off as a held row, with nothing changed, it stays put off', theta()['H-2'], undefined);
const moveBlocker = (category) => { const q = queueOf('theta'); q.tickets['H-2'].outside_blockers = [{ key: 'X-9', category }]; writeFileSync(join(env.DESK_HOME, 'repos', 'acme__theta', 'queue.json'), JSON.stringify(q)); };
moveBlocker('indeterminate');
t('DS-401 AC2 once its outside blocker\'s state changes it is listed again, saying what changed',
  /\(Changed since it was put off on \d{4}-\d\d-\d\d: blockers H-1:running,X-9:new@none\+yours → H-1:running,X-9:indeterminate@none; need .*\)$/.test(theta()['H-2']?.need ?? ''), true);
// Admit is recommended only for a blocker in no batch that is the person's to queue: in To Do, in this
// repo's Jira project, and unassigned or theirs. Otherwise not-now is, naming why, and admit is offered.
const outsideOne = (b) => ({ state: 'triaged', lane: 'A', open_questions: 1, outside_blockers: [b] });
put('admit599', { port: 3860, beat: 1, supervised: true, project: 'P', owner: 'Ben Example', tickets: {
  'A-1': outsideOne({ key: 'P-1', category: 'new', assignee: 'Sam Other' }),
  'A-2': outsideOne({ key: 'P-2', category: 'new', assignee: 'Ben Example' }),
  'A-3': outsideOne({ key: 'P-3', category: 'indeterminate', assignee: 'Ben Example' }),
  'A-4': outsideOne({ key: 'Q-4', category: 'new', assignee: null }),
  'A-5': outsideOne({ key: 'P-5', category: 'new' }),
} });
const a599 = Object.fromEntries(N.collect({ word: 'admit599' }).items.map((i) => [i.t.key, i]));
const lead599 = (k) => `${a599[k]?.actions.map((a) => a[0]).join()} | ${a599[k]?.actions[0][1]}`;
const admit599 = (k) => { const a = a599[k]?.actions.find(([n]) => n === 'admit'); return a ? `${a[1]} | ${a[2] != null}` : 'none'; };
t('DS-599 AC1 a blocker in no batch assigned to someone else recommends not-now, naming the assignee', lead599('A-1'),
  'not-now,admit,answer | P-1: it is assigned to Sam Other. So it is not yours to queue here; not-now puts this off until a blocker moves');
t('DS-599 AC1 admit is still offered, without a recommendation', admit599('A-1'), 'null | true');
t('DS-599 AC2 a blocker in no batch in To Do assigned to the person recommends admit', lead599('A-2'),
  'admit,answer,not-now | P-2 is in no batch, so nothing works it: admitting queues it for a worker');
t('DS-599 AC3 a blocker in progress does not recommend admit', lead599('A-3'), 'not-now,admit,answer | P-3: it is in progress. So it is not yours to queue here; not-now puts this off until a blocker moves');
t('DS-599 AC4 a blocker in another Jira project does not recommend admit', lead599('A-4'), 'not-now,admit,answer | Q-4: it is in Jira project Q, not P. So it is not yours to queue here; not-now puts this off until a blocker moves');
t('DS-599 AC5 a blocker whose assignee was not read does not recommend admit', lead599('A-5'), 'not-now,admit,answer | P-5: its assignee could not be read. So it is not yours to queue here; not-now puts this off until a blocker moves');
t('DS-599 admit, offered unrecommended, still names the /desk-admit to run', /Run \/desk-admit P-1 in /.test(N.record({ word: 'admit599', ticket: 'A-1', action: 'admit' }).line ?? ''), true);
const a599now = () => Object.fromEntries(N.collect({ word: 'admit599' }).items.map((i) => [i.t.key, i]));
const reassign599 = (assignee) => { const q = queueOf('admit599'); q.tickets['A-1'].outside_blockers = [{ key: 'P-1', category: 'new', assignee }]; writeFileSync(join(env.DESK_HOME, 'repos', 'acme__admit599', 'queue.json'), JSON.stringify(q)); };
N.record({ word: 'admit599', ticket: 'A-1', action: 'not-now' });
t('DS-599 put off as someone else\'s, it stays put off while the blocker is still theirs', a599now()['A-1'], undefined);
reassign599('Alex Else');
t('DS-599 a blocker passed to another person who is not you does not bring it back', a599now()['A-1'], undefined);
reassign599(null);
t('DS-599 once that blocker is unassigned it is listed again, recommending admit and saying what changed',
  `${a599now()['A-1']?.actions[0][0]} | ${/\(Changed since it was put off on \d{4}-\d\d-\d\d: blockers P-1:new@none → P-1:new@none\+yours\.\)$/.test(a599now()['A-1']?.need ?? '')}`, 'admit | true');
// DS-669: a ticket held inside its batch with a triage question of its own is asked that question.
put('zeta', { port: 3850, beat: 1, supervised: true, tickets: {
  'Z-1': { state: 'running', lane: 'A' },
  'Z-2': { state: 'parked', lane: 'A', held_by: 'Z-1', open_questions: 1, park: { question: 'held by orchestrator: blocked by Z-1 — starts once their PRs merge' } },
  'Z-3': { state: 'parked', lane: 'A', held_by: 'Z-1', open_questions: 1, park: { question: 'held by orchestrator: blocked by Z-1 — starts once their PRs merge' } },
}, triage: { 'Z-2': { summary: 'Audit runs', unknowns: ['What is the cost of one blind audit run?'] } } });
const zeta = () => Object.fromEntries(N.collect({ word: 'zeta' }).items.map((i) => [i.t.key, i]));
t('DS-669 AC1 a held, parked ticket\'s item is its triage question word for word', `${zeta()['Z-2']?.kind} | ${zeta()['Z-2']?.need}`, 'triage | What is the cost of one blind audit run?');
t('DS-669 AC3 with no triage record it still reads as a count', zeta()['Z-3']?.need, '1 triage question(s) open');
N.record({ word: 'zeta', ticket: 'Z-2', action: 'not-now' });
t('DS-669 put off, it stays put off while nothing changes', zeta()['Z-2'], undefined);
const zq = queueOf('zeta');
zq.tickets['Z-1'].state = 'parked';
writeFileSync(join(env.DESK_HOME, 'repos', 'acme__zeta', 'queue.json'), JSON.stringify(zq));
const { openQuestions: digestQuestions } = await import('../desk/bin/digest.mjs');
const zetaRepo = { slug: 'acme__zeta', state: join(env.HOME, '.desk-autopilot', 'acme__zeta'), queue: join(env.DESK_HOME, 'repos', 'acme__zeta', 'queue.json') };
const zDigest = digestQuestions(zetaRepo).find((q) => q.ticket === 'Z-2');
const zEntry = [...NN.readRegister(zetaRepo.state).entries.values()].find((x) => x.ticket === 'Z-2');
t('DS-669 AC4 once a blocker\'s status changes it comes back quoting the question', /^What is the cost of one blind audit run\? \(Changed since it was put off/.test(zeta()['Z-2']?.need ?? ''), true);
t('DS-669 AC4 its not-now entry is keyed to the digest\'s text for the same question', `${zDigest?.kind} | ${zEntry?.inputs?.need === zDigest?.text}`, 'triage | true');

const e = N.collect({ word: 'eta' });
const { needsRows } = await import('../desk/bin/desk-q.mjs');
t('DS-279 a stopped worker and a PR to merge are items, as many as desk-q counts', `${e.items.map((i) => `${i.t.key} ${i.kind} ${i.need}`).join(' | ')} | ${needsRows(e.named).length}`,
  'E-2 pr PR #61 has its check green, and desk may not merge in this repo. Merge it on GitHub; the ticket is then done. | E-1 stopped worker stopped: tests red · requeue it | 2');
const rq1 = N.record({ word: 'eta', ticket: 'E-1', action: 'requeue' });
t('DS-279 requeue sends a stopped worker\'s ticket back, under the supervisor', `${rq1.ok} ${queueOf('eta').tickets['E-1'].state !== 'failed'} ${N.collect({ word: 'eta' }).items.some((i) => i.t.key === 'E-1')}`, 'true true false');
// DS-554: a failed ticket's item quotes the reason the pass recorded on it, and one with none says so.
put('failwhy554', { port: 5554, beat: 1, supervised: true, tickets: {
  'F-1': { state: 'failed', lane: 'A', failed: { why: 'killed before it finished (its process died while the computer stayed up), with no marker and no open PR on fix/F-1 (ended after its preflight with no output, exit code 1). Resuming is off', exit: 1 } },
  'F-2': { state: 'failed', lane: 'A' },
} });
const fw = Object.fromEntries(N.collect({ word: 'failwhy554' }).items.map((i) => [i.t.key, `${i.kind} ${i.need}`]));
t('DS-554 AC1 a failed ticket\'s item gives its recorded reason and exit code', /^stopped worker stopped: .*ended after its preflight with no output, exit code 1\)\. Resuming is off · requeue it$/.test(fw['F-1'] ?? ''), true);
t('DS-554 AC3 a failed ticket with no reason recorded says so, never an empty one', fw['F-2'], 'stopped worker stopped: no reason was recorded: read its worker log, logs/F-2.log · requeue it');
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
t('DS-323 AC1 a draft with review gaps offers answer first, then done and not-now', `${i1?.need} | ${i1?.actions.map((a) => a[0]).join()}`, 'PR #71 is a draft, and its code review left 2 requirement gaps. Desk could not read the review to quote the gaps, so read them on the PR. Say how to settle them; a worker on the PR carries out your call. | answer,done,resume,not-now');
t('DS-323 AC1 its listed line recommends the answer', here('list', 'iota').out.split('\n').some((l) => l.startsWith('iota I-1 pr') && l.includes('| 1. answer (recommended:')), true);
const i2 = iota.find((i) => i.t.key === 'I-2');
t('DS-323 AC3 a draft an older pass recorded as not green, whose only red checks were skipped, says CI does not run on a draft, and to undraft it', i2?.need, 'PR #72 is a draft, and CI does not run on drafts, so its checks were skipped. Undraft it so they run; then merge it on GitHub once its checks are green.');
t('DS-323 AC1 a PR with no review gaps takes no answer', `${i2?.actions.map((a) => a[0]).join()} ${N.record({ word: 'iota', ticket: 'I-2', action: 'answer', text: 'x' }).ok}`, 'done,resume,not-now false');
const call323 = 'Split gap 1 into its own ticket; fix gap 2 in this PR';
const gr = here('record', 'iota', 'I-1', 'answer', call323);
const i1q = queueOf('iota').tickets['I-1'];
const ghLog = readFileSync(GH_LOG, 'utf8');
t('DS-323 AC2 the answer is posted on the PR', `${gr.code} ${ghLog.includes('pr comment 71 --repo acme/iota --body') && ghLog.includes(`> ${call323}`)}`, '0 true');
t('DS-323 AC2 it is kept in the briefing for the next worker', `${JSON.stringify(answers().at(-1).args)} ${readFileSync(join(env.HOME, '.desk-autopilot', 'acme__iota', 'briefings', 'I-1.md'), 'utf8').includes(call323)}`, `${JSON.stringify(['I-1', '--all', call323])} true`);
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

// ---- KAN-629: a draft whose held screenshots the pass is uploading (undraft.mjs cellCall `upload`) is not the person's.
put('shots', { port: 4779, beat: 1, supervised: true, tickets: {
  'SH-1': draftPr(86, passed, { call: 'upload', why: '1 screenshot cell(s) left: a.png, whose files desk holds in /s/images/SH-1, and the pass uploads them' }),
  'SH-2': draftPr(87, passed, { call: 'person', why: '1 screenshot cell(s) left: a.png, whose files desk holds but could not put in the body', action: 'edit the body of #87 so no `_drag <file>_` cell is left' }),
} });
const shotKeys = N.collect({ word: 'shots' }).items.map((i) => i.t.key).join();
t('KAN-629 a draft whose screenshots the pass is uploading is not listed', shotKeys.includes('SH-1'), false);
t('KAN-629 negative control: one whose cells nothing fills still is', shotKeys.includes('SH-2'), true);

// ---- DS-498: a draft whose check the runner ended (undraft.mjs rerunCall's person calls, as test_undraft.mjs pins them).
const oomRed = [{ name: 'Type-check', status: 'completed', conclusion: 'failure' }, ...passed];
put('runner', { port: 4778, beat: 1, supervised: true, tickets: {
  'RN-1': draftPr(91, oomRed, { call: 'person', why: 'its "Type-check" check was ended by the runner after desk re-ran it at this head: "Type-check" (exit code 137: the runner ran out of memory and killed it)', action: 'give that job a bigger runner, or cap the memory it uses (fewer test workers, a lower heap limit), then re-run it on #91' }),
  'RN-4': draftPr(94, oomRed, { call: 'person', why: 'its "Type-check" check was ended by the runner, and GitHub refused desk\'s 2 reruns of it at this head: "Type-check" (exit code 137: the runner ran out of memory and killed it)', action: 're-run it on #94, and if it fails the same way, give that job a bigger runner, or cap the memory it uses (fewer test workers, a lower heap limit)' }),
  'RN-2': draftPr(92, oomRed, { call: 'person', why: 'its "Type-check" check was ended by the runner, not its code: "Type-check" (the runner was lost: steps were left unfinished with no error line); config §3 ci-rerun is "no", so desk is not granted a rerun', action: 're-run it on #92, and if it fails the same way, give that job a bigger runner, or cap the memory it uses (fewer test workers, a lower heap limit)' }),
  'RN-3': draftPr(93, oomRed, { call: 'rerun', why: 'its checks were ended by the runner, not their code, so they are re-run once: "Type-check" exit code 137: the runner ran out of memory and killed it' }),
} });
const runner = Object.fromEntries(N.collect({ word: 'runner' }).items.map((i) => [i.t.key, i]));
t('DS-498 AC3 killed again after its rerun: says the runner ran out of memory and names the infrastructure fix', runner['RN-1']?.need,
  'PR #91 is a draft, and its "Type-check" check was ended by the runner, not by its code: "Type-check" (exit code 137: the runner ran out of memory and killed it), after desk re-ran it once. Nothing on its branch fixes that: give that job a bigger runner, or cap the memory it uses (fewer test workers, a lower heap limit), then re-run it; the next pass then picks it up.');
t('DS-498 AC3 every rerun refused: says so, and names the infrastructure fix', runner['RN-4']?.need,
  'PR #94 is a draft, and its "Type-check" check was ended by the runner, not by its code: "Type-check" (exit code 137: the runner ran out of memory and killed it). GitHub refused desk\'s reruns of it, so re-run it yourself, and if it fails the same way, give that job a bigger runner, or cap the memory it uses (fewer test workers, a lower heap limit); the next pass then picks it up.');
t('DS-498 AC3 and never says to fix it on its branch', /fix (?:it|them) on its branch/i.test(`${runner['RN-1']?.need} ${runner['RN-2']?.need} ${runner['RN-4']?.need}`), false);
t('DS-498 AC4 ci-rerun not yes: says reruns are not granted', runner['RN-2']?.need,
  'PR #92 is a draft, and its "Type-check" check was ended by the runner, not by its code: "Type-check" (the runner was lost: steps were left unfinished with no error line). Desk is not granted reruns (config §3 ci-rerun is "no"), so re-run it yourself, and if it fails the same way, give that job a bigger runner, or cap the memory it uses (fewer test workers, a lower heap limit); the next pass then picks it up.');
t('DS-498 AC1 a draft whose check is being re-run is not the person\'s', 'RN-3' in runner, false);

// ---- DS-345: a draft whose gaps outlast its fix tries keeps undraft.call `findings` (DS-342's record),
// and still takes the person's call on them; one with findings and no gaps does not.
put('mu', { port: 4200, beat: 1, supervised: true, tickets: {
  'M-1': draftPr(81, passed, { call: 'findings', why: 'its review verdict at 575fa8c5c is not clean (gaps=1)', action: 'settle the findings or gaps on #81' }),
  'M-2': draftPr(82, passed, { call: 'findings', why: 'its review verdict at 575fa8c5c is not clean (p1=1)', action: 'settle the findings on #82' }),
} });
const mu = Object.fromEntries(N.collect({ word: 'mu' }).items.map((i) => [i.t.key, i]));
t('DS-345 AC1 a findings draft with gaps offers answer first', mu['M-1']?.actions.map((a) => a[0]).join(), 'answer,done,resume,not-now');
const call345 = 'Drop the 7-day row for the old subscription; keep the rest';
const mr = here('record', 'mu', 'M-1', 'answer', call345);
const m1q = queueOf('mu').tickets['M-1'];
t('DS-345 AC2 the call is posted on the PR', `${mr.code} ${readFileSync(GH_LOG, 'utf8').includes('pr comment 81 --repo acme/mu --body')}`, '0 true');
t('DS-345 AC2 and a fix worker on the branch is queued with it', `${m1q.state} ${m1q.fix?.kind} ${m1q.fix?.pr} ${m1q.fix?.head} ${m1q.fix?.answer === call345}`, 'triaged gaps 81 h81 true');
t('DS-345 AC3 a findings draft with no gaps keeps its actions', mu['M-2']?.actions.map((a) => a[0]).join(), 'done,resume,not-now');

// ---- A park on a file the person is asked to make is listed; one a script makes is not
const fileQ = 'Please run bash tests/compare_pass.sh on the host and save its output to $DESK_STATE/fixtures/F-1/compare-pass.txt';
const filePark = (question, cond) => { const p = parked('A', 30, question); return { ...p, park: { ...p.park, clears_when: { kind: 'file-exists', root: 'state', ...cond } } }; };
put('file807', { port: 4807, beat: 1, supervised: true, tickets: {
  'F-1': filePark(fileQ, { path: 'fixtures/F-1/compare-pass.txt', person: true }),
  'F-2': filePark('waiting on the recall capture to write $DESK_STATE/fixtures/F-2/meet.json', { path: 'fixtures/F-2/meet.json' }),
} });
const f807 = Object.fromEntries(N.collect({ word: 'file807' }).items.map((i) => [i.t.key, i]));
t('DS-807 AC1 a park on a file its question asks the person to make is listed with its question and resume',
  `${f807['F-1']?.need === fileQ} ${f807['F-1']?.actions.map((a) => a[0])[0]}`, 'true resume');
t('DS-807 AC3 one a script makes is still left out', 'F-2' in f807, false);

// ---- DS-586: a draft whose review left gaps quotes them from that review, as a ready PR's item does.
const SHA586 = '65ad4e75a1b2c3d4e5f60718293a4b5c6d7e8f90';
const review586 = (login, sha, lines) => ({ author: { login }, body: `<!-- desk-review:local -->\n<!-- desk-review:verdict v=1 sha=${sha} p0=0 p1=0 p2=0 deferred=0 gaps=${lines.length} unrefuted=0 partial=0 vendor=codex round=1 -->\n## desk-review: ${lines.length} requirement gaps\n\n### Requirement gaps\n${lines.map((l) => `- ${l}`).join('\n')}\n` });
const GAP1 = 'PERSON\'S CALL · AC1: "the export lists every order" — the ticket does not say whether refunded orders count.';
const GAP2 = 'PERSON\'S CALL · AC2: "totals match the invoice" — rounding differs by a cent on multi-currency orders.\n  Recommended: round per line, as the invoice does.';
put('gq', { handle: 'me', port: 4207, beat: 1, supervised: true, tickets: {
  'GQ-1': draftPr(301, passed, { call: 'person', why: `its review verdict at ${SHA586.slice(0, 9)} is not clean (gaps=2)`, action: 'settle the findings or gaps on #301' }),
  'GQ-2': draftPr(302, passed, { call: 'person', why: `its review verdict at ${SHA586.slice(0, 9)} is not clean (gaps=2)`, action: 'settle the findings or gaps on #302' }),
} });
onGitHub(301, { state: 'OPEN', mergedAt: null, isDraft: true, headRefOid: SHA586, reviews: [
  review586('me', '1111111aaaaaaa', ['PERSON\'S CALL · AC9: an older round\'s gap']),
  review586('me', SHA586, [GAP1, GAP2]),
  review586('stranger', SHA586, ['PERSON\'S CALL · AC1: a gap someone else posted']),
] });
const gq = Object.fromEntries(N.collect({ word: 'gq' }).items.map((i) => [i.t.key, i]));
t('DS-586 AC1 a draft\'s two gaps are quoted, each criterion with what is open', /AC1: "the export lists every order" — the ticket does not say whether refunded orders count; PERSON'S CALL · AC2: "totals match the invoice" — rounding differs by a cent/.test(gq['GQ-1']?.need ?? ''), true);
t('DS-586 AC1 negative: an older round\'s gaps and another login\'s review are not quoted', /AC9|someone else/.test(gq['GQ-1']?.need ?? ''), false);
t('DS-586 AC2 a gap\'s recommendation is shown beside it', gq['GQ-1']?.need,
  'PR #301 is a draft, and its code review left 2 requirement gaps: PERSON\'S CALL · AC1: "the export lists every order" — the ticket does not say whether refunded orders count; PERSON\'S CALL · AC2: "totals match the invoice" — rounding differs by a cent on multi-currency orders. Recommended: round per line, as the invoice does. Say how to settle them; a worker on the PR carries out your call.');
t('DS-586 AC3 a review that cannot be read gives the count and says so', gq['GQ-2']?.need,
  'PR #302 is a draft, and its code review left 2 requirement gaps. Desk could not read the review to quote the gaps, so read them on the PR. Say how to settle them; a worker on the PR carries out your call.');
t('DS-586 the item still offers answer first', gq['GQ-1']?.actions.map((a) => a[0]).join(), 'answer,done,resume,not-now');

// ---- An open PR takes the person's instruction for a worker on it; a merged or closed one says why not.
const readyPr = (pr, extra = {}) => { const d = draftPr(pr, passed); return { ...d, ...extra, pr_status: { ...d.pr_status, isDraft: false } }; };
// ---- DS-513: a ready PR stuck on gaps only the person can settle takes their call, as a draft does.
const PG_WHY = "review gaps only you can settle: PERSON'S CALL · AC2: only the person can accept it";
put('pg', { port: 4205, beat: 1, supervised: true, tickets: {
  'PG-1': readyPr(85, { stuck: { why: PG_WHY, pr: 85, head: 'h85' } }),
  'PG-2': readyPr(86, { stuck: { why: PG_WHY, pr: 86, head: 'older' } }),
  'PG-3': readyPr(87, { stuck: { why: "review not clean after 2 fix tries: 1 P1, 1 gap — P1: src/a.ts:1 drops a row; PERSON'S CALL · AC2: only the person can accept it", pr: 87, head: 'h87' } }),
  'PG-4': readyPr(88, { stuck: { why: "review not clean after 2 fix tries: 2 gaps — still open after the fix try that quoted it: AC3: no column; PERSON'S CALL · AC2: only the person can accept it", pr: 88, head: 'h88' } }),
} });
const pg = Object.fromEntries(N.collect({ word: 'pg' }).items.map((i) => [i.t.key, i]));
t('DS-513 AC1 a ready PR on the person\'s gaps offers answer first', `${pg['PG-1']?.need} | ${pg['PG-1']?.actions.map((a) => a[0]).join()}`, "PR #85's code review left requirement gaps only you can settle: PERSON'S CALL · AC2: only the person can accept it. Say how to settle them; a worker on the PR carries out your call. | answer,done,resume,not-now");
t('DS-513 AC1 negative: a reason from an older head offers no answer', pg['PG-2']?.actions.some((a) => a[0] === 'answer') ?? false, false);
t('DS-513 AC3 a finding that outlasted its tries beside the person\'s gap offers answer and fix, and names the gap', `${pg['PG-3']?.actions.map((a) => a[0]).join()} ${pg['PG-3']?.need.includes("only you can settle: PERSON'S CALL · AC2")}`, 'answer,fix,done,resume,not-now true');
t('DS-513 AC3 a code gap that outlasted its try beside the person\'s gap offers answer', `${pg['PG-4']?.actions.map((a) => a[0]).join()} ${pg['PG-4']?.need.includes("only you can settle: PERSON'S CALL · AC2")}`, 'answer,done,resume,not-now true');
const pgCall = 'Accept AC2 as built';
const pgr = here('record', 'pg', 'PG-1', 'answer', pgCall);
const pgq = queueOf('pg').tickets['PG-1'];
t('DS-513 AC1 the call is posted and a worker is queued on the ready PR', `${pgr.code} ${readFileSync(GH_LOG, 'utf8').includes('pr comment 85 --repo acme/pg --body')} ${pgq.state} ${pgq.fix?.kind} ${pgq.fix?.ready} ${pgq.fix?.answer === pgCall}`, '0 true triaged gaps true true');

put('instr', { port: 4210, beat: 1, supervised: true, tickets: {
  'SG-1': { ...draftPr(91, passed, { call: 'person', why: 'its review verdict at abc123456 is not clean (gaps=1)', action: 'settle the gaps on #91' }), branch: 'fix/SG-1-x' },
  'SG-2': readyPr(92, { branch: 'fix/SG-2-x' }),
  'SG-3': readyPr(93),
  'SG-4': readyPr(94),
  'SG-5': readyPr(95),
  'SG-6': { ...draftPr(96, passed), pr_status: { ...draftPr(96, passed).pr_status, state: 'CLOSED' } },
  'SG-7': { ...draftPr(97, passed), merged_at: minsAgo(5), pr_status: { ...draftPr(97, passed).pr_status, state: 'MERGED', isDraft: false } },
  'SG-8': readyPr(98),
  'SG-9': { ...readyPr(99), lane: 'C' },
} });
const instr = () => Object.fromEntries(N.collect({ word: 'instr' }).items.map((i) => [i.t.key, i]));
const sg0 = instr();
const sq = () => queueOf('instr').tickets;
t('DS-501 AC1 a PR with review gaps and a plain open PR both offer resume, with no recommendation of their own',
  `${sg0['SG-1']?.actions.map((a) => a[0]).join()} ${sg0['SG-2']?.actions.map((a) => a[0]).join()} ${sg0['SG-2']?.actions.find((a) => a[0] === 'resume')?.[1]}`,
  'answer,done,resume,not-now done,resume,not-now null');
t('DS-501 AC1 negative: a closed PR does not', sg0['SG-6']?.actions.map((a) => a[0]).join(), 'drop,requeue,not-now');
t('DS-501 AC1 its listed line says what resume does', here('list', 'instr').out.split('\n').some((l) => l.startsWith('instr SG-2 pr') && /\d\. resume \(resume "<instruction>" keeps it for the next worker/.test(l)), true);

// AC2: GitHub is read first, then the instruction is kept and the ticket goes back on its branch.
const loggedBefore = readFileSync(GH_LOG, 'utf8').length;
const told = 'Fix the issues, then send it back\nand keep the title';
onGitHub(92, { state: 'OPEN', isDraft: false, headRefOid: 'live92' });
const resumed = here('record', 'instr', 'SG-2', 'resume', told);
const sg2 = sq()['SG-2'];
const sgBrief = readFileSync(join(env.HOME, '.desk-autopilot', 'acme__instr', 'briefings', 'SG-2.md'), 'utf8');
t('DS-501 AC2 the instruction is kept in the briefing for the next worker', `${resumed.code} ${JSON.stringify(answers().at(-1).args)} ${sgBrief.includes(told)}`, `0 ${JSON.stringify(['SG-2', '--all', told])} true`);
t('DS-501 AC2 and requeued on its branch, at the head GitHub shows', `${sg2.state} ${sg2.branch} ${sg2.fix?.kind} ${sg2.fix?.pr} ${sg2.fix?.head} ${sg2.fix?.ready} ${sg2.fix?.answer === told}`, 'triaged fix/SG-2-x instruction 92 live92 true true');
t('DS-501 AC2 it is not one of the pass\'s fix tries', `${(sg2.fix_tries ?? []).length} ${sg2.fix?.try} of ${sg2.fix?.of}`, '0 1 of 1');
t('DS-501 triage call: resume posts nothing on the PR (answer stays that path)', readFileSync(GH_LOG, 'utf8').slice(loggedBefore).includes('pr comment'), false);
t('DS-501 AC2 its worker\'s briefing quotes the instruction, and it stays out of draft and reviews its new head',
  `${fixBrief(sg2).includes('> and keep the title')} ${/open and out of draft/.test(fixBrief(sg2))} ${/carry out the person's instruction on PR #92/.test(fixTask(sg2))} ${/leave the PR out of draft/.test(fixTask(sg2))} ${/review the new head with desk-review/.test(fixTask(sg2))}`, 'true true true true true');
t('DS-501 AC2 desk-q no longer counts it as needing you', instr()['SG-2'], undefined);
const sgRepo = loadRepos().find((r) => r.name === 'instr');
t('DS-501 AC2 its desk-q page shows your instruction, not a numbered fix try', `${ticketScreen(sgRepo, 'SG-2', { width: 160 }).includes('Your call')} ${ticketScreen(sgRepo, 'SG-2', { width: 160 }).includes('Fix try')}`, 'true false');

// A draft goes back as a draft, and a review-gaps PR's resume is kept without being posted.
onGitHub(91, { state: 'OPEN', isDraft: true, headRefOid: 'h91' });
const sg1r = N.record({ word: 'instr', ticket: 'SG-1', action: 'resume', text: 'keep the gap as it is' });
t('DS-501 AC2 a draft stays in draft, and a gaps PR\'s resume is not posted', `${sg1r.ok} ${sq()['SG-1'].fix?.kind} ${/a draft/.test(fixBrief(sq()['SG-1']))} ${/leave the PR in draft/.test(fixTask(sq()['SG-1']))} ${readFileSync(GH_LOG, 'utf8').includes('pr comment 91')}`, 'true instruction true true false');

// A live session runs the batch: requeued all the same, with nothing left for the session to do.
onGitHub(98, { state: 'OPEN', isDraft: false, headRefOid: 'h98' });
const sg8 = N.record({ word: 'instr', ticket: 'SG-8', action: 'resume', text: 'go', repos: loadRepos().map((r) => (r.name === 'instr' ? { ...r, live: true, run: { by: 'session' } } : r)) });
t('DS-501 triage call: requeued whoever runs the batch, with no message to send', `${sg8.ok} ${sg8.message} ${sq()['SG-8'].state}`, 'true null triaged');

// AC3: the queue still says open, GitHub says otherwise.
const untouched = (k) => `${sq()[k].state} ${sq()[k].fix}`;
const answersBefore = answers().length;
onGitHub(93, { state: 'MERGED', isDraft: false, headRefOid: 'h93', mergedAt: minsAgo(1) });
const sMerged = here('record', 'instr', 'SG-3', 'resume', 'x');
t('DS-501 AC3 a PR merged since the last pass is refused, saying why', `${sMerged.code} ${/PR #93 is merged, so no worker can carry out an instruction on it/.test(sMerged.out + sMerged.err)} ${untouched('SG-3')}`, '11 true done undefined');
onGitHub(94, { state: 'CLOSED', isDraft: false, headRefOid: 'h94' });
const sClosed = N.record({ word: 'instr', ticket: 'SG-4', action: 'resume', text: 'x' });
t('DS-501 AC3 a PR closed since the last pass is refused, saying why', `${sClosed.ok} ${/PR #94 was closed without merging.*Drop the ticket, or requeue it/.test(sClosed.line)} ${untouched('SG-4')}`, 'false true done undefined');
const sUnread = N.record({ word: 'instr', ticket: 'SG-5', action: 'resume', text: 'x' });
t('DS-501 AC3 a PR GitHub cannot read is refused and stays listed', `${sUnread.ok} ${/could not read PR #95's state from GitHub .*nothing was recorded/.test(sUnread.line)} ${untouched('SG-5')} ${!!instr()['SG-5']}`, 'false true done undefined true');
// The queue already has it shut: it says why, not that the verb or the item is unknown.
const sShut = N.record({ word: 'instr', ticket: 'SG-6', action: 'resume', text: 'x' });
t('DS-501 AC3 a PR the queue has closed is refused, saying why', `${sShut.ok} ${/PR #96 was closed without merging/.test(sShut.line)} ${/is not an action/.test(sShut.line)}`, 'false true false');
const sDone = N.record({ word: 'instr', ticket: 'SG-7', action: 'resume', text: 'x' });
t('DS-501 AC3 a PR the queue has merged is refused, saying why', `${sDone.ok} ${/PR #97 is merged/.test(sDone.line)} ${/does not count it/.test(sDone.line)}`, 'false true false');
t('DS-501 AC3 no refused resume recorded an answer', answers().length, answersBefore);
// A requeue the queue refuses takes its fix back and says so.
onGitHub(99, { state: 'OPEN', isDraft: false, headRefOid: 'h99' });
const sLane = N.record({ word: 'instr', ticket: 'SG-9', action: 'resume', text: 'x' });
t('DS-501 a refused requeue leaves no fix behind, and says so', `${sLane.ok} ${/kept in its briefing, but the requeue was refused/.test(sLane.line)} ${sq()['SG-9'].state} ${sq()['SG-9'].fix}`, 'false true done null');

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
  'K-9': { state: 'failed', lane: 'A' },
}, triage: { 'K-5': { lane: 'B' } } });
mkdirSync(join(env.HOME, '.desk-autopilot', 'acme__kappa', 'parks'), { recursive: true });
writeFileSync(join(env.HOME, '.desk-autopilot', 'acme__kappa', 'parks', 'K-4.json'), JSON.stringify({ question: 'Please take it out of the autopilot queue: lane C' }));
writeFileSync(join(env.HOME, '.desk-autopilot', 'acme__kappa', 'parks', 'K-9.json'), JSON.stringify({ question: 'Ben runs this step: there is no worker work left' }));
const kappa = Object.fromEntries(N.collect({ word: 'kappa' }).items.map((i) => [i.t.key, i]));
const firstOf = (k) => `${kappa[k]?.actions[0][0]} (${kappa[k]?.actions[0][1]})`;
const offers = (k) => kappa[k]?.actions.map((a) => a[0]).join();
t('DS-322 AC1 a park naming lane C offers open, not resume', `${firstOf('K-1')} ${offers('K-1')}`, 'open (lane C/D: a worker would only park on it) open,done,drop,not-now');
t('DS-322 AC1 a lane D park without a saved canvas offers open, not resume', `${firstOf('K-2')} ${offers('K-2')}`, 'open (lane C/D: a worker would only park on it) open,done,drop,not-now');
t('DS-322 AC1 a park opening "lane C" on a lane A ticket gives the lane C/D reason', firstOf('K-8'), 'open (lane C/D: a worker would only park on it)');
const { presort } = await import('../desk/bin/decider.mjs');
t('DS-322 AC1 the decider hands the same park to a session, never a requeue', presort([{ kind: 'parked', lane: 'A', text: 'Demoted to lane C, build it in an interactive desk-ticket session' }]).hand.length, 1);
t('DS-322 AC2 a stopped worker whose park names lane C offers open, not requeue (DS-556: asking to leave the queue, it recommends drop)', `${kappa['K-4']?.kind} ${offers('K-4')} ${kappa['K-4']?.actions[1][2]}`, 'stopped drop,open,not-now lane C/D: a worker would only park on it');
t('DS-556 AC3 a stopped worker whose park says it has no worker work, in no lane C, recommends drop over requeue', `${kappa['K-9']?.kind} ${firstOf('K-9')} ${offers('K-9')} ${kappa['K-9']?.actions[1][2]}`,
  `stopped drop (its park says it has no worker work, so a requeue would only park it again: drop takes it out of the batch and removes its clean worktree, and leaves Jira as it is) drop,requeue,not-now its worker gave up; a requeue lets the next pass start it again`);
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
// A repo pinned to a subscription since set off: its queued work starts nowhere, and that is one item.
put('studia', { port: 4110, beat: 1, supervised: true, batch: { subscription_off: { since: minsAgo(5), email: 'ops@studia.example', login: 'work-2' } }, tickets: { 'S-1': { state: 'triaged', lane: 'A' } } });
const studia = N.collect({ word: 'studia' }).items;
t('a repo pinned to an off subscription is one item, and its queued ticket is none', studia.map((i) => `${i.t.key} ${i.kind}`).join(), 'subscription-off subscription-off');
t('its need names the repo, the email and the command that moves it', studia[0]?.need,
  'acme__studia is pinned to ops@studia.example, which is off (claude work-2), so no new work starts for it: move it to another subscription (desk-env subscription set acme__studia <default|email>), or set work-2 unused (desk-env logins set claude work-2 unused)');
t('and desk-q\'s NEEDS YOU count, and left, count it', `${N.needsCount(loadRepos().find((r) => r.name === 'studia')).shown} ${here('left', 'studia').out.split('\n')[0]}`, '1 desk-q counts 1 item needing you in studia.');
t('it offers done and not-now, and done is recorded', `${studia[0]?.actions.map((a) => a[0]).join()} ${N.record({ word: 'studia', ticket: 'subscription-off', action: 'done' }).ok}`, 'done,not-now true');
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

// ---- DS-347 AC3: a green PR the merge driver has held on two loops for an unresolved thread, with no
// fix try left (DS-419), is the person's, naming the thread; a green PR it merges is not, and nor is
// one held for a thread a fix try is still left for.
const greenPr = (pr, more = {}) => ({ state: 'done', lane: 'A', result: { pr }, ...more,
  pr_status: { pr, state: 'OPEN', url: null, isDraft: false, mergeable: 'MERGEABLE', head: `h${pr}`, checks: passed, at: minsAgo(1) } });
const held347 = 'review feedback: 1 unresolved thread on a green PR, first desk/bin/pass.mjs:970 "Why does this hold not show in desk-q?"';
const spentTries = [{ try: 1, head: 'h0', kind: 'feedback' }, { try: 2, head: 'h1', kind: 'feedback' }];
put('xi', { port: 4300, beat: 1, supervised: true, merge: 'yes', tickets: {
  'X-1': greenPr(91),
  'X-2': greenPr(92, { merge_blocked: held347, fix_tries: spentTries }),
  'X-3': greenPr(93, { merge_blocked: held347 }),
  'X-4': greenPr(94, { merge_blocked: 'approval: an approving review is required at a71111111: a person approves it before desk merges it' }),
  'X-5': greenPr(95, { fix_tries: spentTries, stuck: { why: 'review feedback still open after 2 fix tries: 1 unresolved thread — src/auth.ts:9 "P0 a hung DOB probe"', pr: 95, head: 'h95' } }),
} });
const xi = N.collect({ word: 'xi' }).items;
t('DS-419 AC7 a PR out of fix tries for its feedback is the person\'s, naming the thread', xi.find((i) => i.t.key === 'X-5')?.need, 'PR #95 still has review feedback open desk\'s own repairs did not fix: 1 unresolved thread — src/auth.ts:9 "P0 a hung DOB probe". Answer and resolve it, or fix it on its branch; desk then merges it once its checks are green.');
t('DS-347 AC3 a green PR the driver merges is not an item, and one it holds for a thread with no try left is', xi.filter((i) => !['X-4', 'X-5'].includes(i.t.key)).map((i) => `${i.t.key} ${i.kind}`).join(), 'X-2 pr');
t('DS-347 AC3 its need names the PR, the thread\'s path and its first line', xi.find((i) => i.t.key === 'X-2')?.need, 'PR #92 is held for review: 1 unresolved thread on a green PR, first desk/bin/pass.mjs:970 "Why does this hold not show in desk-q?". Resolve or answer it; desk then merges it.');
t('DS-419 AC1 a held thread with a fix try left is not the person\'s: a worker takes it', xi.some((i) => i.t.key === 'X-3'), false);
t('DS-433 AC3 a green PR GitHub requires an approving review on asks the person for one', xi.find((i) => i.t.key === 'X-4')?.need, 'PR #94 waits on a person\'s approval: an approving review is required. Review and approve it on GitHub; desk then merges it.');
t('DS-433 AC1 a green PR with no merge note, the driver\'s to merge, lists nothing', xi.some((i) => i.t.key === 'X-1'), false);

// #752: a PR the merge driver found with no mergeability answer for past its limit is the person's.
put('wr', { port: 4301, beat: 1, supervised: true, merge: 'yes', tickets: {
  'W-1': greenPr(97, { merge_blocked: 'merge ref: GitHub has not worked out whether #97 conflicts with its base at d97777777 for 75 minutes, and starts no run for that head: push a new commit (an empty one will do) for a fresh merge ref, or open a new PR from its branch' }),
} });
t('#752 a wedged merge ref is the person\'s, saying how to give it a fresh one', N.collect({ word: 'wr' }).items.find((i) => i.t.key === 'W-1')?.need,
  'PR #97 looks stuck on GitHub: GitHub has not worked out whether #97 conflicts with its base for 75 minutes, and starts no run for that head. Push a new commit to its branch (an empty one will do) for a fresh merge ref, or open a new PR from it; desk then merges it once it is green.');

// ---- DS-420: a red PR the merge driver declined is the person's as its reason says, never called green.
const redPr = (pr, more = {}) => { const g = greenPr(pr, more); return { ...g, pr_status: { ...g.pr_status, checks: [{ name: 'build', status: 'completed', conclusion: 'failure' }] } }; };
put('xi420', { port: 4301, beat: 1, supervised: true, merge: 'yes', tickets: {
  'Y-1': redPr(96, { merge_blocked: 'approval: an approving review is required at b96666666: a person approves it before desk merges it' }),
  'Y-2': redPr(97, { merge_blocked: 'review feedback: 1 unresolved thread on a red PR, first src/a.ts:3 "P0 drops the row"', fix_tries: spentTries }),
} });
const xi420 = N.collect({ word: 'xi420' }).items;
t('DS-420 AC2 a red fix PR that needs an approving review asks for the approval, not calling it a green feature', xi420.find((i) => i.t.key === 'Y-1')?.need,
  'PR #96 waits on a person\'s approval: an approving review is required. Review and approve it on GitHub; desk then merges it.');
t('DS-420 AC1 a red PR held for a thread with no try left names the thread, not calling it green', xi420.find((i) => i.t.key === 'Y-2')?.need,
  'PR #97 is held for review: 1 unresolved thread on a red PR, first src/a.ts:3 "P0 drops the row". Resolve or answer it; desk then merges it.');

// ---- DS-351 AC2: an epic admitted with no session waits on its drafted plan as one item, and its
// children held behind it are not items of their own.
const planQ = 'feature plan awaiting your answer: the spine and owner table for P-1 are drafted, with 2 children held behind it: read /s/plan.md, then start, edit or discard it';
const behindP = { state: 'parked', lane: 'A', held_by: 'P-1', park: { question: 'held by orchestrator: blocked by P-1 — starts once their PRs merge' } };
put('omicron', { port: 4555, beat: 1, supervised: true, tickets: { 'P-1': { ...parked('epic', 5, planQ), type: 'Epic' }, 'P-2': behindP, 'P-3': behindP } });
const om = N.collect({ word: 'omicron' }).items;
t('DS-351 AC2 the plan is one needs-you item, of kind plan, its children waiting', om.map((i) => `${i.t.key} ${i.kind}`).join(), 'P-1 plan');
t('DS-351 AC2 its need is the plan park, and its recommendation is to answer it', `${om[0]?.need === `${planQ} (2 tickets wait behind this)`} ${om[0]?.actions.map(([a]) => a).join()}`, 'true answer,not-now');
t('DS-351 AC2 an answer to it is recorded on the epic', `${N.record({ word: 'omicron', ticket: 'P-1', action: 'answer', text: 'start' }).ok} ${answers().at(-1)?.args.join(' ')}`, 'true P-1 --all start');

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
put('ds494', { port: 4610, beat: 1, supervised: true, merge: 'yes', tickets: {
  'E-1': stuckPr(201, [lintRed, ...passed], why375([{ name: LINT, error: 'ReferenceError: React is not defined' }])),
  'E-2': stuckPr(202, [lintRed, ...passed], why375([{ name: LINT }])),
} });
const e494 = Object.fromEntries(N.collect({ word: 'ds494' }).items.map((i) => [i.t.key, i]));
// A PR held for the person is aged from when it became theirs (undraft.at), not from its admit.
put('ds897', { port: 4612, beat: 1, supervised: true, merge: 'yes', tickets: {
  'G-1': { ...stuckPr(301, [lintRed, ...passed], why375([{ name: LINT }])), undraft: { call: 'person', why: 'w', at: minsAgo(5) } },
} });
const g897 = N.collect({ word: 'ds897' }).items.find((i) => i.t.key === 'G-1');
t('#897 a PR item is aged from when it became the person\'s, not from its admit', Math.round((NOW - g897?.since) / 60000), 5);

t('DS-494 AC2 the item quotes the error line', e494['E-1']?.need, `PR #201: "${LINT}" is failing, and desk's own repairs did not fix it. "${LINT}" says: "ReferenceError: React is not defined". Fix it on its branch; desk then merges it once its checks are green.`);
t('DS-494 AC2 and is not worded as a step only the person can do', /only you can/.test(e494['E-1']?.actions[0][1] ?? 'only you can'), false);
t('DS-494 AC3 with no error line it is as today', `${e494['E-2']?.need} | ${e494['E-2']?.actions[0][1]}`, `PR #202: "${LINT}" is failing, and desk's own repairs did not fix it. Fix it on its branch; desk then merges it once its checks are green. | only you can do this step; say done once you have, and the PR is checked on GitHub there and then`);
t('DS-375 AC1 a check gone green on the same head is no longer named', sg['S-1']?.need, `PR #101: "${LINT}" (failed at "Run eslint") is failing, and desk's own repairs did not fix it. Fix it on its branch; desk then merges it once its checks are green.`);
t('DS-375 AC2 the item names the step the run failed at', sg['S-1']?.need.includes('(failed at "Run eslint")'), true);
t('DS-375 AC1 a step on GitHub left: done is still recommended', `${sg['S-1']?.actions[0][0]} ${recommends(sg['S-1'])}`, 'done true');
t('DS-375 AC1 once every check it named is green it is not stuck: a PR the driver merges is no item', 'S-4' in sg, false);
t('DS-375 AC3 a §4 Check builds check names its command as what unblocks it', sg['S-2']?.need, 'PR #102: "Flows image" needs a step outside GitHub: ./scripts/ensure-flows-image.sh. Do that step; desk then merges it once its checks are green.');
t('DS-375 AC4 a step outside GitHub: done is offered but not recommended, and says what the step is',
  `${sg['S-2']?.actions.map(([a]) => a).join()} ${recommends(sg['S-2'])} ${sg['S-2']?.actions[0][2]}`,
  'done,resume,not-now false the step is outside GitHub (./scripts/ensure-flows-image.sh); it drops off once "Flows image" is green');
t('DS-375 AC4 its listed line carries no recommendation', here('list', 'sigma').out.split('\n').some((l) => l.startsWith('sigma S-2 pr') && !l.includes('recommended')), true);
t('DS-375 AC5 a §4 Pre-merge steps step is named from the config, with no done recommended',
  `${sg['S-3']?.need} | ${recommends(sg['S-3'])}`, `PR #103: "${LINT}" (failed at "Check portal schema mirror") needs a step outside GitHub: apply the PR's migrations to staging first. Do that step; desk then merges it once its checks are green. | false`);
t('DS-375 AC4 beside a check on GitHub, it drops off only once every check it is stuck on is green',
  sg['S-6']?.actions[0][2], `the step is outside GitHub (./scripts/ensure-flows-image.sh); it drops off once "${LINT}", "Flows image" are green`);
t('DS-375 a reason recorded before the pass kept its checks still names them', sg['S-5']?.need, 'PR #105 has failing checks desk\'s own repairs did not fix: Lint. Fix them on its branch; desk then merges it once its checks are green.');
// DS-548: a ready PR whose check build desk ran failed (fix-tries.mjs buildStep) goes to a worker.
const flowsBuilt = { name: 'Flows image', build: './scripts/ensure-flows-image.sh', error: 'ECR denied the push' };
const premergeStep = { name: LINT, step: 'Check portal schema mirror', command: 'apply the PR\'s migrations to staging first' };
put('ds548', { port: 4615, beat: 1, supervised: true, merge: 'yes', tickets: {
  'B-1': stuckPr(301, [flowsRed[0], ...passed], { lead: 'its check build `./scripts/ensure-flows-image.sh` exited 1', checks: [flowsBuilt], why: 'as the pass wrote it' }),
  'B-2': stuckPr(302, [flowsRed[0], lintRed, ...passed], { lead: 'its check build `./scripts/ensure-flows-image.sh` exited 1', checks: [flowsBuilt, premergeStep], why: 'as the pass wrote it' }),
  'B-3': stuckPr(303, [lintRed, ...passed], why375([premergeStep])),
} });
const b548 = Object.fromEntries(N.collect({ word: 'ds548' }).items.map((i) => [i.t.key, i]));
t('DS-548 AC4 a failed check build quotes its last line and asks for a worker, not a step outside GitHub', b548['B-1']?.need,
  'PR #301: "Flows image"\'s check build `./scripts/ensure-flows-image.sh` failed, and its last line says: "ECR denied the push". Send it back to a worker on the PR with what to fix, or fix it on its branch; desk then merges it once its checks are green.');
t('DS-548 AC4 a worker on the PR is recommended, not done', `${b548['B-1']?.actions.map(([a]) => a).join()} ${b548['B-1']?.actions[0][0]} ${recommends(b548['B-1'])}`, 'resume,done,not-now resume true');
t('DS-548 AC4 beside a pre-merge step it names both, the step still the person\'s', b548['B-2']?.need,
  `PR #302: "Flows image"'s check build \`./scripts/ensure-flows-image.sh\` failed, and its last line says: "ECR denied the push"; "${LINT}" (failed at "Check portal schema mirror") needs a step outside GitHub: apply the PR's migrations to staging first. Send it back to a worker on the PR with what to fix, or fix it on its branch, and do that step; desk then merges it once its checks are green.`);
t('DS-548 AC5 negative control: a pre-merge step alone is the person\'s with nothing recommended, as today', `${b548['B-3']?.actions[0][0]} ${recommends(b548['B-3'])}`, 'done false');
// ---- A review gate that wants a person's approval, from error lines recorded on studia-web PRs
// #2555 and #2546, and the lines desk's own review-gate.mjs writes.
const { failureLines } = await import('../desk/bin/gate.mjs');
const failureLine = (notes) => failureLines(notes)[0] ?? null;
const { checkApproval } = await import('../desk/templates/scripts/desk/review-gate.mjs');
const GATE_NOTES = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'review-gate-annotations.json'), 'utf8'));
const GATE = '🔐 Review gate', GATE_STEP = 'Require an approval unless a small fix, docs or chore change';
const gateRed = (error) => ({ name: GATE, status: 'completed', conclusion: 'failure', error });
const gateStuck = (pr, error, more = {}) => stuckPr(pr, [gateRed(error), ...passed], why375([{ name: GATE, step: GATE_STEP }, ...(more.checks ?? [])]));
const protectedLine = failureLine(GATE_NOTES.protected), limitLine = failureLine(GATE_NOTES['file-limit']);
t('DS-499 the error line is the gate\'s, not GitHub\'s exit code line', protectedLine.startsWith('Approval required — 2 protected file(s)'), true);
const staleLine = 'Approval required — 1 protected file(s): `apps/web/package.json` — and mousedown\'s approval predates 9354a90.';
// Six protected paths as long as a real migration's, so the line is the longest shape the gate writes.
const longPath = (i) => `packages/db/prisma/migrations/2026110712000${i}_update_customer_preferences_and_settings/migration.sql`;
const gateFiles = Array.from({ length: 31 }, (_, i) => ({ filename: i < 6 ? longPath(i) : `src/${i}.ts`, additions: 1, deletions: 0 }));
const deskGate = checkApproval({ title: 'feat: preferences', head: 'new', author: 'me' }, gateFiles, [{ user: { login: 'mousedown' }, state: 'APPROVED', commit_id: 'old' }], new Set(['mousedown']),
  { protected: 'migrations/', generated: '^$', fileLimit: 30, exemptTypes: 'fix|docs|chore' });
const deskLine = failureLine([{ annotation_level: 'failure', message: deskGate.message }]);
const otherLine = 'Approval required — a `feat(messaging):` title, and only fix, docs, chore merge without an approval.';
const approved499 = { name: GATE, status: 'completed', conclusion: 'success' };
const gateTickets = {
  'V-1': gateStuck(121, protectedLine),
  'V-2': gateStuck(122, limitLine),
  'V-3': gateStuck(123, staleLine),
  'V-4': gateStuck(124, deskLine),
  'V-5': gateStuck(125, otherLine),
  'V-6': stuckPr(126, [lintRed, gateRed(protectedLine), ...passed], why375([{ name: LINT, step: 'Run eslint' }, { name: GATE, step: GATE_STEP }])),
  'V-7': { ...greenPr(127), merge_blocked: `approval: "${GATE}" needs approval from a human reviewer at abc123456: a person approves it before desk merges it`, pr_status: { ...greenPr(127).pr_status, head: 'h127', checks: [gateRed(protectedLine), ...passed] } },
  'V-8': gateStuck(128, protectedLine),
};
put('phi', { port: 4620, beat: 1, supervised: true, merge: 'yes', people: { 'Code reviewer': 'Chris Anthony (@mousedown)', 'Product owner': 'Sam' }, tickets: gateTickets });
const vi = () => Object.fromEntries(N.collect({ word: 'phi' }).items.map((i) => [i.t.key, i]));
const v1 = vi();
// DS-701: items held by the same thing share a `cause`, so one answer can settle them together.
const phi701 = Object.fromEntries(N.listItems({ word: 'phi', reads: null }).items.map((i) => [i.key, i.cause]));
t('DS-701 two PRs held by the same approval share a cause', `${phi701['V-1'] != null} ${phi701['V-1'] === phi701['V-8']}`, 'true true');
t('DS-701 a different approval is another cause', phi701['V-2'] !== phi701['V-1'] && phi701['V-2'] != null, true);
t('DS-701 a PR held by a failing check beside the approval has no shared cause', phi701['V-6'], null);
t('DS-701 the cause is keyed to its repo', phi701['V-1']?.startsWith('acme__phi:approval:'), true);
const TAIL = 'No code change clears it, only an approving review on GitHub at its latest commit; desk then merges it once its checks are green.';
t('DS-499 AC1 protected files: the reason in plain words and the approver, not "fix it on its branch"', v1['V-1']?.need, `PR #121 needs Chris Anthony's approval: it changes a database migration and the database schema. ${TAIL}`);
t('DS-499 AC1 the file limit', v1['V-2']?.need, `PR #122 needs Chris Anthony's approval: it has 37 changed files, over the 30-file limit. ${TAIL}`);
t('DS-499 AC1 another protected file is named, and an approval of an older commit is said', v1['V-3']?.need, `PR #123 needs Chris Anthony's approval: it changes \`apps/web/package.json\`. mousedown approved an earlier commit, so it needs approving again. ${TAIL}`);
t('DS-499 AC1 desk\'s own gate line reads the same', v1['V-4']?.need, `PR #124 needs Chris Anthony's approval: it changes a database migration and 1 more protected file, and it has 31 changed files, over the 30-file limit. mousedown approved an earlier commit, so it needs approving again. ${TAIL}`);
t('DS-499 AC3 a line naming neither cause is as today', `${v1['V-5']?.need} | ${v1['V-5']?.actions.map(([a]) => a).join()}`, `PR #125: "${GATE}" (failed at "${GATE_STEP}") is failing, and desk's own repairs did not fix it. Fix it on its branch; desk then merges it once its checks are green. | done,resume,not-now`);
t('DS-499 AC1 beside a check a person fixes, that check is asked for and the approval said after it', v1['V-6']?.need, `PR #126: "${LINT}" (failed at "Run eslint") is failing, and desk's own repairs did not fix it. Fix it on its branch; desk then merges it once its checks are green. It also needs Chris Anthony's approval: it changes a database migration and the database schema.`);
t('DS-499 AC2 beside another red check there is no waiting to do', v1['V-6']?.actions.map(([a]) => a).join(), 'done,resume,not-now');
t('DS-499 AC1 a §4 State check the driver noted reads the same', v1['V-7']?.need, `PR #127 needs Chris Anthony's approval: it changes a database migration and the database schema. ${TAIL}`);
t('DS-499 AC2 the item offers waiting first', `${v1['V-1']?.kind} ${v1['V-1']?.actions.map(([a]) => a).join()}`, 'pr waiting,done,resume,not-now');
t('DS-499 AC2 waiting is not an action on any other PR', N.record({ word: 'phi', ticket: 'V-5', action: 'waiting' }).ok, false);
t('DS-499 AC2 waiting is recorded', N.record({ word: 'phi', ticket: 'V-1', action: 'waiting' }).ok, true);
N.record({ word: 'phi', ticket: 'V-8', action: 'waiting' });
t('DS-499 AC2 it is not listed again, and desk-q counts it put off', `${'V-1' in vi()} ${N.collect({ word: 'phi' }).putOff}`, 'false 2');
const again = (key, change) => { const q = queueOf('phi').tickets; put('phi', { port: 4620, beat: 1, supervised: true, merge: 'yes', people: { 'Code reviewer': 'Chris Anthony (@mousedown)' }, tickets: { ...q, [key]: change(q[key]) } }); };
again('V-1', (x) => ({ ...x, pr_status: { ...x.pr_status, approvals: ['mousedown'] } }));
t('DS-499 AC2 an approval brings it back, saying so', vi()['V-1']?.need.endsWith('approvals none → mousedown.)'), true);
again('V-8', (x) => ({ ...x, stuck: { ...x.stuck, head: 'h128b' }, pr_status: { ...x.pr_status, head: 'h128b' } }));
t('DS-499 AC2 a new head brings it back', vi()['V-8']?.need.includes('pr-head h128 → h128b'), true);
again('V-2', (x) => ({ ...x, pr_status: { ...x.pr_status, checks: [approved499, ...passed] } }));
t('DS-499 AC2 a gate gone green leaves nothing to ask', 'V-2' in vi(), false);
put('chi', { port: 4630, beat: 1, supervised: true, merge: 'yes', people: { 'Code reviewer': 'none', 'Product owner': 'Sam, @sam' }, tickets: { 'W-1': gateStuck(131, limitLine) } });
put('psi', { port: 4640, beat: 1, supervised: true, merge: 'yes', tickets: { 'W-2': gateStuck(132, limitLine) } });
put('omega499', { port: 4650, beat: 1, supervised: true, merge: 'yes', people: { 'Code reviewer': 'you' }, tickets: { 'W-3': gateStuck(133, limitLine) } });
t('DS-499 AC1 no reviewer falls back to the product owner', N.collect({ word: 'chi' }).items[0]?.need.startsWith('PR #131 needs Sam\'s approval:'), true);
t('DS-499 AC1 neither row: a person with approval rights', N.collect({ word: 'psi' }).items[0]?.need.startsWith('PR #132 needs approval from a person with approval rights:'), true);
t('DS-499 AC1 a row that is the user', N.collect({ word: 'omega499' }).items[0]?.need.startsWith('PR #133 needs your approval:'), true);
// A PR the pass sent to a protected-files try, as applyFix and queue.mjs requeue leave it (triaged, its
// stuck reason cleared), then running; and one back at done once its worker kept the file.
const pkgLine = 'Approval required — 1 protected file(s): `apps/portal/apps/web/package.json`.';
const protectedFix = (pr, more = {}) => ({ try: 1, of: 2, pr, head: `h${pr}`, kind: 'protected', ready: true, paths: ['apps/portal/apps/web/package.json'], what: 'protected files', at: minsAgo(1), ...more });
const onTry = (state) => ({ ...gateStuck(134, pkgLine), state, stuck: null, fix: protectedFix(134) });
put('psi500', { port: 4660, beat: 1, supervised: true, merge: 'yes', people: { 'Code reviewer': 'Chris Anthony (@mousedown)' },
  tickets: { 'X-1': onTry('triaged'), 'X-2': onTry('running'), 'X-3': { ...gateStuck(135, pkgLine), fix: protectedFix(135, { finished: true }) } } });
const psi500 = Object.fromEntries(N.collect({ word: 'psi500' }).items.map((i) => [i.t.key, i]));
t('DS-500 AC1 a PR on its protected-files try is no item while it waits to spawn or runs', 'X-1' in psi500 || 'X-2' in psi500, false);
t('DS-500 AC3 once its worker kept the file, the approval is the person\'s', psi500['X-3']?.need, `PR #135 needs Chris Anthony's approval: it changes \`apps/portal/apps/web/package.json\`. ${TAIL}`);

// ---- DS-410: a ready PR into a feature base held on a required check its workflow never runs there.
const why410 = 'never runs on PRs into feat/E-1 (workflow trigger: .github/workflows/ci.yml runs on pull requests into main, production)';
const ready410 = (pr, untriggered) => ({ state: 'done', lane: 'A', result: { pr },
  pr_status: { pr, state: 'OPEN', url: null, isDraft: false, mergeable: 'MERGEABLE', head: `h${pr}`, base: 'feat/E-1', checks: passed, at: minsAgo(1), ...(untriggered ? { untriggered } : {}) } });
put('tau410', { port: 4610, beat: 1, supervised: true, merge: 'yes', required: [LINT], tickets: { 'U-1': ready410(111, { [LINT]: why410 }), 'U-2': ready410(112, null) } });
const u410 = Object.fromEntries(N.collect({ word: 'tau410' }).items.map((i) => [i.t.key, i]));
t('DS-410 AC1 a ready PR whose required check never runs on its base names the trigger, not a re-run',
  `${u410['U-1']?.need} | ${/re-run (it|them)\b/i.test(u410['U-1']?.need ?? '')}`,
  `PR #111 is not green: required check "${LINT}" ${why410}. Re-running cannot help, as no run exists: add feat/E-1 (or a pattern such as feat/**) to the pull_request branches of the workflow that runs "${LINT}", a change to the repo; its next push then runs the check, and desk then merges it once its checks are green. | false`);
t('DS-410 negative control: with no untriggered record it still says the check has not reported',
  u410['U-2']?.need, `PR #112 is not green: required check "${LINT}" has not reported. Fix that check, or §4 Required checks if it should not be required; desk then merges it once its checks are green.`);
// DS-701: a check no workflow triggers on a base is settled per base, so PRs into two bases are two causes.
const onBase701 = (pr, base) => ((x) => ({ ...x, pr_status: { ...x.pr_status, base } }))(ready410(pr, { [LINT]: why410 }));
put('tau701', { port: 4710, beat: 1, supervised: true, merge: 'yes', required: [LINT], tickets: { 'U-1': onBase701(113, 'feat/E-1'), 'U-2': onBase701(114, 'feat/E-1'), 'U-3': onBase701(115, 'feat/E-2') } });
const c701 = Object.fromEntries(N.listItems({ word: 'tau701', reads: null }).items.map((i) => [i.key, i.cause]));
t('DS-701 PRs whose check never runs on the same base share a cause; another base is another cause',
  `${c701['U-1'] != null} ${c701['U-1'] === c701['U-2']} ${c701['U-3'] != null && c701['U-3'] !== c701['U-1']}`, 'true true true');
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

// ---- A parked or session ticket can be dropped: it leaves its batch and its clean worktree is removed,
// refused naming the worktree and what it holds while that has work origin lacks. Recommended first
// where the park says the ticket has no worker work.
const benStep = 'This is a Ben-step, so there is no worker work: will you take it off the autopilot queue and free its clean worktree?';
const dpRoot = join(T, 'repos', 'dropper'), dpWt = (k) => join(T, 'dropper-worktrees', k);
put('dropper', { port: 5010, beat: 1, supervised: true, tickets: {
  'P-1': { ...parked('A', 40, benStep), worktree: dpWt('P-1'), branch: 'fix/P-1' },
  'P-2': { ...parked('A', 30, 'Which copy?'), worktree: dpWt('P-2'), branch: 'fix/P-2' },
  'P-3': parked('C', 20, 'lane C: build it in an interactive desk-ticket session; no worker work is left'),
  'P-4': parked('C', 10, 'lane C: the plan needs agreeing'),
} });
const dpGit = (...a) => spawnSync('git', ['-C', dpRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
dpGit('commit', '-q', '--allow-empty', '-m', 'base'); dpGit('update-ref', 'refs/remotes/origin/main', 'HEAD');
dpGit('worktree', 'add', '-q', '-b', 'fix/P-1', dpWt('P-1')); dpGit('worktree', 'add', '-q', '-b', 'fix/P-2', dpWt('P-2'));
spawnSync('git', ['-C', dpWt('P-2'), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'half a fix']);
writeFileSync(join(dpWt('P-2'), 'notes.txt'), 'x');
const dp = Object.fromEntries(N.collect({ word: 'dropper' }).items.map((i) => [i.t.key, i]));
const dpActs = (k) => dp[k]?.actions.map(([a, why]) => `${a}${why ? '*' : ''}`).join();
t('DS-556 AC3 a park saying it has no worker work recommends drop first, and resume stays on offer', `${dp['P-1']?.kind} ${dpActs('P-1')}`, 'parked drop*,resume,not-now');
t('DS-556 AC3 the resume it displaced keeps its reason as a note', /^lane A: /.test(dp['P-1']?.actions[1][2] ?? ''), true);
t('DS-556 any other park offers drop before not-now, unrecommended', dpActs('P-2'), 'resume*,drop,not-now');
t('DS-556 AC3 a session park saying it has no worker work recommends drop first', `${dp['P-3']?.kind} ${dpActs('P-3')}`, 'session drop*,open,done,not-now');
t('DS-556 any other session park offers drop too', dpActs('P-4'), 'open*,done,drop,not-now');
const drop1 = N.record({ word: 'dropper', ticket: 'P-1', action: 'drop' });
t('DS-556 AC1 drop takes it out of its batch and removes its clean worktree and branch',
  `${drop1.ok} ${'P-1' in queueOf('dropper').tickets} ${existsSync(dpWt('P-1'))} ${dpGit('branch', '--list', 'fix/P-1').stdout.trim()}|`, 'true false false |');
t('DS-556 AC1 its line says the worktree went and Jira was left as it is', /worktree .*P-1, holding nothing origin lacks, was removed .*Jira is left as it is/.test(drop1.line), true);
const drop2 = N.record({ word: 'dropper', ticket: 'P-2', action: 'drop' });
t('DS-556 AC2 a worktree with unpushed commits and untracked files refuses the drop',
  `${drop2.ok} ${'P-2' in queueOf('dropper').tickets} ${existsSync(join(dpWt('P-2'), 'notes.txt'))}`, 'false true true');
t('DS-556 AC2 the refusal names the worktree and what is in it',
  drop2.line.includes(dpWt('P-2')) && /notes\.txt/.test(drop2.line) && /1 commit\(s\) not pushed: [0-9a-f]+ half a fix/.test(drop2.line), true);

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

// ---- A ticket with a park and unpushed commits is one item, carrying the park's reason: still parked,
// or requeued off the park and held by its worktree before any worker started.
const refused = 'git push was refused: remote rejected (Internal Server Error) after three tries';
const heldWhy = 'its branch fix/Y-1 is 1 commit(s) ahead of origin/fix/Y-1, not pushed';
const unpushed = 'its worktree /w/Y-2 has 1 commit(s) not on origin';
put('ypsilon', { port: 4950, beat: 1, supervised: true, tickets: {
  'Y-1': { state: 'triaged', lane: 'A', session_id: null, worktree_busy: { why: heldWhy, at: minsAgo(10) }, prev_park: { question: refused, since: minsAgo(40), round: 1 }, fix: { try: 1, of: 2, pr: 141, kind: 'review', what: 'a finding' } },
  'Y-2': { state: 'parked', lane: 'A', park: { question: refused, since: minsAgo(40), unpushed } },
  'Y-3': { state: 'triaged', lane: 'A', session_id: 'sess-y3', worktree_busy: { why: heldWhy, at: minsAgo(10) }, prev_park: { question: refused, since: minsAgo(40), round: 1 } },
  'Y-4': { state: 'parked', lane: 'A', park: { question: 'which plan?', since: minsAgo(40) } },
  'Y-5': { state: 'parked', lane: 'A', park: { question: 'post the comment below on ABC-9?', since: minsAgo(40), approve: { kind: 'jira-comment', target: 'ABC-9', body: 'Line one.\n"Quoted" line two.' } } },
} });
const yr = () => loadRepos().find((x) => x.slug === 'acme__ypsilon');
const yItems = () => Object.fromEntries(N.collect({ word: 'ypsilon' }).items.map((i) => [i.t.key, i]));
const yList = N.listText(N.collect({ word: 'ypsilon' })).split('\n');
const yLine = (k) => yList.find((l) => l.startsWith(`ypsilon ${k} `)) ?? '';
t('DS-497 AC1 a ticket requeued off its park and held by its worktree is one item with the park\'s reason, the worktree state as its note, and resume',
  `${yList.filter((l) => l.startsWith('ypsilon Y-1 ')).length} ${yItems()['Y-1'].need} | ${yItems()['Y-1'].note} | ${yItems()['Y-1'].actions.map(([a]) => a).join()}`,
  `1 ${refused} | Worktree in use: ${heldWhy} · commit, push or discard it. | resume,not-now`);
t('DS-497 AC1 a parked ticket with unpushed commits keeps its park\'s item, with them as its note',
  `${yList.filter((l) => l.startsWith('ypsilon Y-2 ')).length} ${yItems()['Y-2'].kind} ${yLine('Y-2').includes(`${refused} Its worktree /w/Y-2 has 1 commit(s) not on origin.`)} ${yItems()['Y-2'].actions[0][0]}`, '1 parked true resume');
t('a park with nothing unpushed has no note', yItems()['Y-4'].note, undefined);
t('#775 a park awaiting approval of a write carries its exact text, whole, under its line',
  yList.slice(yList.indexOf(yLine('Y-5')) + 2, yList.indexOf(yLine('Y-5')) + 4).join('\n'), 'Line one.\n"Quoted" line two.');
t('#775 and its one line, which the session asks from, points to that text',
  yLine('Y-5').includes('post the comment below on ABC-9? Its exact text awaiting approval follows this line: show it verbatim before you ask.'), true);
t('DS-497 AC2 a park older than the last worker to start says nothing of the worktree hold', `${yItems()['Y-3'].need} ${yItems()['Y-3'].actions.map(([a]) => a).join()}`,
  `worktree in use: ${heldWhy} · commit, push or discard it done,not-now`);
t('DS-497 AC1 desk-q leads the row and the ticket page with the reason', `${/Y-1 +◆ needs you +git push was refused/.test(strip(repoScreen(yr())))} ${strip(ticketScreen(yr(), 'Y-1')).includes('Its last worker parked: git push was refused')}`, 'true true');
const yResume = N.record({ word: 'ypsilon', ticket: 'Y-1', action: 'resume', text: 'pushed it by hand' });
const y1 = queueOf('ypsilon').tickets['Y-1'];
t('a resume on it records the note, and leaves it queued with its reason, not requeued again', `${yResume.ok} ${y1.state} ${y1.prev_park.question === refused}`, 'true triaged true');
t('not-now puts it off, and it leaves the list', `${N.record({ word: 'ypsilon', ticket: 'Y-1', action: 'not-now' }).ok} ${'Y-1' in yItems()}`, 'true false');
const yBusy = queueOf('ypsilon'); yBusy.tickets['Y-1'].worktree_busy.why = 'its worktree /w/Y-1 has uncommitted changes (a.txt)';
writeFileSync(join(env.DESK_HOME, 'repos', 'acme__ypsilon', 'queue.json'), JSON.stringify(yBusy));
t('a put-off item comes back once its worktree is held for a new reason', 'Y-1' in yItems(), true);

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
const withHead = (t) => ({ ...t, ...(t.stuck ? { stuck: { ...t.stuck, head: sha(t.result.pr) } } : {}), pr_status: { ...t.pr_status, head: sha(t.result.pr) } });
put('psi', { port: 5100, beat: 1, supervised: true, merge: 'yes', tickets: {
  'Q-1': withHead(psiPr(141)),
  'Q-2': withHead(psiPr(142)),
  'Q-3': withHead(psiPr(143)),
  'Q-4': withHead(stuckPr(144, passed, { why: `no review verdict readable at its head after 2 review tries at it: the verdict is at ${sha(1)}, not ${sha(144)}; the last try said: pr=144 jira=In Review review=NOT POSTED at ${sha(144)}` })),
  'Q-5': withHead(draftPr(145, passed, { call: 'findings', why: `its review verdict at ${sha(145)} is not clean (p1=2)`, action: 'settle the findings on #145' })),
  'Q-6': withHead({ ...stuckPr(146, passed, { why: 'still in conflict after 2 fix tries; the last try parked: which side wins?' }), fix_tries: [{ try: 1, head: 'b1', kind: 'conflict' }, { try: 2, head: 'b2', kind: 'conflict' }] }),
  'Q-7': withHead(stuckPr(147, passed, { why: 'review not clean after 3 fix tries (1 conflict, 1 rereview, 1 review): 1 P0 — P0: desk/bin/evidence.mjs:40 a code span splits the cell' })),
  'Q-8': withHead(draftPr(148, passed, { call: 'person', why: `its review verdict at ${sha(148)} is not clean (p0=0 p1=0 p2=1 deferred=1 gaps=0)`, action: 'settle the findings or gaps on #148' })),
  'Q-9': withHead(stuckPr(149, passed, { why: 'review not clean after 2 fix tries (2 review): 1 P2 — P2: src/pager.ts:1 no consumer outside its own story' })),
} });
const psi = () => Object.fromEntries(N.collect({ word: 'psi' }).items.map((i) => [i.t.key, i]));
const p0 = psi();
t('DS-378 every PR item is listed', Object.keys(p0).sort().join(), 'Q-1,Q-2,Q-3,Q-4,Q-5,Q-6,Q-7,Q-8,Q-9');
t('DS-384 AC3 a review stuck after its tries names how many repairs of which kind desk made', p0['Q-7']?.need,
  'PR #147\'s code review still has findings after desk\'s 3 repairs (1 conflict fix, 1 re-review, 1 review fix): P0 desk/bin/evidence.mjs:40 a code span splits the cell. Send it back to a worker for one more try, or fix them on its branch and post a fresh review; desk then merges it once its checks are green.');
t('DS-436 AC3 a P2 no fix try ran on does not say repairs failed', p0['Q-8']?.need,
  'PR #148 is a draft, and its code review found 1 P2 finding, which it marks deferred, so desk sends no worker to it. Fix it on its branch and post a fresh review; the next pass then takes it out of draft.');
t('DS-436 AC4 a P2 left after the review fix tries names the finding and the tries made', p0['Q-9']?.need,
  'PR #149\'s code review still has findings after desk\'s 2 repairs (2 review fixes): P2 src/pager.ts:1 no consumer outside its own story. Send it back to a worker for one more try, or fix them on its branch and post a fresh review; desk then merges it once its checks are green.');
t('DS-436 AC4 and it can go back to a worker for one more try', p0['Q-9']?.actions[0][0], 'fix');
t('DS-406 AC3 a review stuck on findings in the code recommends a fix worker, never that only the person can do it',
  `${p0['Q-7']?.actions.map(([a]) => a).join()} ${/worker/.test(p0['Q-7']?.actions[0][1] ?? '')} ${p0['Q-7']?.actions.some(([, why]) => /only you/.test(why ?? ''))}`, 'fix,done,resume,not-now true false');
t('DS-406 AC4 a step outside the code is still worded as only the person\'s', p0['Q-6']?.actions[0][1], 'only you can do this step; say done once you have, and the PR is checked on GitHub there and then');
t('DS-406 AC4 so is a review stuck reason that quotes no finding', (() => { const q = queueOf('psi'); const was = q.tickets['Q-7'].stuck.why; q.tickets['Q-7'].stuck.why = 'review not clean after 2 fix tries (2 review): 1 P0';
  writeFileSync(join(env.DESK_HOME, 'repos', 'acme__psi', 'queue.json'), JSON.stringify(q)); const a = psi()['Q-7']?.actions.map(([v]) => v).join(); q.tickets['Q-7'].stuck.why = was;
  writeFileSync(join(env.DESK_HOME, 'repos', 'acme__psi', 'queue.json'), JSON.stringify(q)); return a; })(), 'done,resume,not-now');
t('DS-375 AC4 the outside-GitHub step is unchanged by DS-406', sg['S-2']?.actions.map(([a]) => a).join(), 'done,resume,not-now');
const q7 = N.record({ word: 'psi', ticket: 'Q-7', action: 'fix' });
const q7t = queueOf('psi').tickets['Q-7'];
t('DS-406 AC3 fix sends it to a worker on the PR with its finding quoted, outside desk\'s tries',
  `${q7.ok} ${q7t.state} ${q7t.fix?.kind} ${q7t.fix?.person} ${q7t.fix?.pr} ${q7t.fix?.head === sha(147)} ${JSON.stringify(q7t.fix?.findings)}`,
  'true triaged review true 147 true [{"sev":"P0","text":"desk/bin/evidence.mjs:40 a code span splits the cell"}]');
t('DS-406 AC3 its line says what follows', q7.line, 'psi Q-7: sent back to a worker on PR #147 for one more try at its findings; the review of its new head says whether they are gone.');
t('DS-378 AC4 a merge hold says what holds it and what happens once it is merged', p0['Q-1']?.need,
  'PR #141 is under a merge hold, so desk never merges it itself: "touches billing" (src/billing/**). Do what it asks first, then merge it on GitHub; the ticket is then done.');
t('DS-378 AC4 a PR with no readable review says what to do and what follows', p0['Q-4']?.need,
  'PR #144 has no code review desk can read for its latest commit: desk\'s review ran on it twice and posted none it can read, and the last one said "pr=144 jira=In Review review=NOT POSTED". Post one (run /desk-review on it); the next pass then takes it on.');
t('DS-558 AC3 a last review try that said "conflict" is still named as a review that did not post', (() => { const q = queueOf('psi'); const was = q.tickets['Q-4'].stuck.why; q.tickets['Q-4'].stuck.why = 'no review verdict readable at its head after 2 review tries at it: x; the last try said: pr=144 review=NOT POSTED, desk-review saw a conflict with main';
  writeFileSync(join(env.DESK_HOME, 'repos', 'acme__psi', 'queue.json'), JSON.stringify(q)); const need = psi()['Q-4']?.need; q.tickets['Q-4'].stuck.why = was;
  writeFileSync(join(env.DESK_HOME, 'repos', 'acme__psi', 'queue.json'), JSON.stringify(q)); return /^PR #144 has no code review desk can read for its latest commit: desk's review ran on it twice/.test(need ?? ''); })(), true);
t('DS-583 AC7 a gate listed as approval stuck on its verdict step names that step, not a person\'s approval', (() => { const q = queueOf('psi'); const was = q.tickets['Q-4'].stuck.why;
  q.tickets['Q-4'].stuck.why = 'no review verdict readable at its head after 2 review tries at it: its "🔐 Review gate" check says: No PullBot review at f93b2f8a0 yet';
  writeFileSync(join(env.DESK_HOME, 'repos', 'acme__psi', 'queue.json'), JSON.stringify(q)); const need = psi()['Q-4']?.need; q.tickets['Q-4'].stuck.why = was;
  writeFileSync(join(env.DESK_HOME, 'repos', 'acme__psi', 'queue.json'), JSON.stringify(q)); return need; })(),
  'PR #144 has no code review desk can read for its latest commit: desk\'s review ran on it twice and posted none it can read. Its "🔐 Review gate" check failed its verdict step: "No PullBot review at f93b2f8a0 yet". Post one (run /desk-review on it); the next pass then takes it on.');
t('DS-378 AC4 a draft with findings counts them in words', p0['Q-5']?.need,
  'PR #145 is a draft, and its code review found 2 P1 findings, which it does not list with a file:line a worker can fix, so desk sends no worker to them. Fix them on its branch and post a fresh review; the next pass then takes it out of draft.');
t('DS-378 AC4 a conflict names the base', p0['Q-6']?.need,
  'PR #146 is in conflict with main, and desk\'s own repairs did not fix it. Resolve the conflict on its branch; desk then merges it once its checks are green.');
// ---- DS-435: a conflict says repairs failed only once a conflict try ran, and then what it said.
const gate435 = [{ try: 1, head: 'h1', kind: 'checks', what: 'red: 🔐 Review gate' }, { try: 2, head: 'h1', kind: 'checks', what: 'red: 🔐 Review gate' }];
const tried435 = [{ try: 1, head: 'b1', kind: 'conflict' }, { try: 2, head: 'b2', kind: 'conflict' }];
put('conflict435', { port: 5435, beat: 1, supervised: true, merge: 'yes', tickets: {
  'C-1': withHead({ ...stuckPr(171, passed, { why: 'still in conflict with main after 2 fix tries' }), fix_tries: gate435 }),
  'C-2': withHead({ ...stuckPr(172, passed, { why: 'still in conflict with main after 2 fix tries: src/class.ts; the last try said: pr=172 jira=In Progress said=src/class.ts left unresolved: both sides add a field' }), fix_tries: [...gate435, ...tried435] }),
  'C-3': { ...greenPr(173), fix_tries: tried435, fix: { try: 2, of: 2, pr: 173, kind: 'conflict', finished: '2026-11-07T10:00:00Z' }, result: { pr: 173, summary: 'pr=173 jira=In Progress said=main renamed the export both sides use' },
    pr_status: { pr: 173, state: 'OPEN', url: null, isDraft: false, mergeable: 'CONFLICTING', mergeState: 'DIRTY', head: 'h173', checks: passed, at: minsAgo(1) } },
  'C-4': withHead({ ...stuckPr(174, passed, { why: 'still in conflict with main after 5 repairs, the most one PR gets: src/a.ts, src/b.ts' }), fix_tries: tried435 }),
} });
const c435 = Object.fromEntries(N.collect({ word: 'conflict435' }).items.map((i) => [i.t.key, i]));
t('DS-435 AC3 a conflict no conflict try ran on does not say repairs failed', c435['C-1']?.need,
  'PR #171 is in conflict with main, and no repair by desk has tried it yet. Resolve the conflict on its branch; desk then merges it once its checks are green.');
t('DS-435 AC4 a failed conflict try names what it said', c435['C-2']?.need,
  'PR #172 is in conflict with main, and desk\'s own repairs did not fix it: its last repair said "src/class.ts left unresolved: both sides add a field". Resolve the conflict on its branch; desk then merges it once its checks are green.');
t('AC8 past the overall limit, the item names the conflicting files', /^PR #174 is in conflict with main in src\/a\.ts, src\/b\.ts, and /.test(c435['C-4']?.need ?? ''), true);
t('DS-435 AC4 so does one desk-q puts to the person with its tries spent', c435['C-3']?.need,
  'PR #173 is in conflict with main, and desk\'s own repairs did not fix it: its last repair said "main renamed the export both sides use". Resolve the conflict on its branch; desk then merges it once its checks are green.');

// ---- a merge hold's item quotes its reason as the step to take, never only "merge it on GitHub".
put('hold413', { port: 5413, beat: 1, supervised: true, merge: 'yes', tickets: {
  'H-1': greenPr(161, { merge_blocked: 'merge hold: legal copy sign-off — content/legal/**, 1 file(s), e.g. content/legal/terms.md' }),
  'H-2': greenPr(162, { merge_blocked: 'merge hold: CODEOWNERS path, needs your code-owner approval (code-owner approval from @alice) — src/api/**, 2 file(s), e.g. src/api/a.ts' }),
} });
const h413 = Object.fromEntries(N.collect({ word: 'hold413' }).items.map((i) => [i.t.key, i]));
t('DS-413 AC3 a hold that is not a code-owner approval quotes its reason as the step', h413['H-1']?.need,
  'PR #161 is under a merge hold, so desk never merges it itself: "legal copy sign-off" (content/legal/**, 1 file(s), e.g. content/legal/terms.md). Do what it asks first, then merge it on GitHub; the ticket is then done.');
t('DS-413 AC3 negative control: it never says only "merge it on GitHub"', /^PR #161 [^"]*\. Merge it on GitHub/.test(h413['H-1']?.need ?? ''), false);
t('DS-413 AC2 a code-owner hold another person owns names that owner\'s approval', /"CODEOWNERS path, needs your code-owner approval \(code-owner approval from @alice\)"/.test(h413['H-2']?.need ?? ''), true);

// ---- A person's merge hold whose step reads done on GitHub (the PR changes the file its
// reason names, and its checks are green) says only the merge is left; otherwise the line is unchanged.
const why657 = 'call-script sign-off: Ben signs off in docs/signoff/call-script.md';
const hold657 = (why) => `merge hold: ${why} — prompts/**, 1 file(s), e.g. prompts/call.md`;
put('hold657', { port: 5657, beat: 1, supervised: true, merge: 'yes', tickets: {
  'S-1': greenPr(181, { merge_blocked: hold657(why657) }),
  'S-2': greenPr(182, { merge_blocked: hold657(why657) }),
  'S-3': greenPr(183, { merge_blocked: hold657(why657) }),
  'S-4': greenPr(184, { merge_blocked: hold657('a person runs `scripts/verify.sh` first') }),
  'S-5': greenPr(185, { merge_blocked: hold657('a person approves every change to `prompts/**`') }),
  'S-6': greenPr(186, { merge_blocked: hold657('Ben approves prompts/call.md before merge') }),
  'S-7': greenPr(187, { merge_blocked: 'merge hold: Ben approves package.json script changes — package.json#scripts, 1 file(s), e.g. package.json' }),
  'S-8': greenPr(188, { merge_blocked: `${hold657(why657)} (and 1 more merge hold(s))` }),
} });
const green657 = [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: minsAgo(1) }];
const signed657 = [{ path: 'prompts/call.md' }, { path: 'docs/signoff/call-script.md' }];
const gh657 = {
  181: { state: 'OPEN', files: signed657, statusCheckRollup: green657 },
  182: { state: 'OPEN', files: [{ path: 'prompts/call.md' }], statusCheckRollup: green657 },
  183: { state: 'OPEN', files: signed657, statusCheckRollup: [{ ...green657[0], status: 'IN_PROGRESS', conclusion: null }] },
  184: { state: 'OPEN', files: [{ path: 'prompts/call.md' }, { path: 'scripts/verify.sh' }], statusCheckRollup: green657 },
  185: { state: 'OPEN', files: [{ path: 'prompts/call.md' }], statusCheckRollup: green657 },
  186: { state: 'OPEN', files: [{ path: 'prompts/call.md' }], statusCheckRollup: green657 },
  187: { state: 'OPEN', files: [{ path: 'package.json' }], statusCheckRollup: green657 },
  188: { state: 'OPEN', files: signed657, statusCheckRollup: green657 },
};
const h657 = Object.fromEntries(N.collect({ word: 'hold657', reads: { ...STUB, pr: (r, pr) => ({ v: gh657[pr] ?? null, err: '' }) } }).items.map((i) => [i.t.key, i]));
const step657 = (pr, why = why657) => `PR #${pr} is under a merge hold, so desk never merges it itself: "${why}" (prompts/**, 1 file(s), e.g. prompts/call.md).`;
const ask657 = ' Do what it asks first, then merge it on GitHub; the ticket is then done.';
t('DS-657 AC5 a sign-off hold whose file is changed and checks are green says its step is done and only the merge is left', h657['S-1']?.need,
  `${step657(181)} Its step is done: the PR changes \`docs/signoff/call-script.md\`, and its checks are green. Only the merge is left: merge it on GitHub; the ticket is then done.`);
t('DS-657 AC6 the sign-off file not changed: the line is unchanged', h657['S-2']?.need, `${step657(182)}${ask657}`);
t('DS-657 AC6 a check still running: the line is unchanged', h657['S-3']?.need, `${step657(183)}${ask657}`);
t('DS-657 AC6 a script the reason names is a step to run, not a file the step changes: the line is unchanged', h657['S-4']?.need, `${step657(184, 'a person runs `scripts/verify.sh` first')}${ask657}`);
t('DS-657 AC6 a hold whose reason names no file is unchanged', h413['H-1']?.need.endsWith(ask657), true);
t('DS-657 AC6 a reason naming the glob the hold guards is no sign-off file: the line is unchanged', h657['S-5']?.need, `${step657(185, 'a person approves every change to `prompts/**`')}${ask657}`);
t('DS-657 AC6 a reason naming a file the hold guards is no sign-off file: the line is unchanged', h657['S-6']?.need, `${step657(186, 'Ben approves prompts/call.md before merge')}${ask657}`);
t('DS-657 AC6 a keyed hold (path#key) whose reason names its own file is no sign-off file: the line is unchanged', h657['S-7']?.need,
  `PR #187 is under a merge hold, so desk never merges it itself: "Ben approves package.json script changes" (package.json#scripts, 1 file(s), e.g. package.json).${ask657}`);
t('DS-657 AC6 a PR under another hold with no routine never reads as only the merge left: the line is unchanged', h657['S-8']?.need, `${step657(188)}${ask657}`);

// ---- A live item says how many held tickets wait behind it, directly or through
// another, and ranks by that after PRODUCTION BROKEN, ahead of one that has waited longer.
const behind657 = (by) => ({ state: 'parked', lane: 'A', held_by: by, park: { question: `held by orchestrator: blocked by ${by} — starts once their PRs merge` } });
put('wait657', { port: 5658, beat: 1, supervised: true, tickets: {
  'W-1': parked('A', 30, 'Which copy?'), 'W-2': parked('A', 300, 'Which endpoint?'), 'W-3': parked('A', 5, 'PRODUCTION BROKEN: login returns 500'),
  'W-4': behind657('W-1'), 'W-5': behind657('W-1'), 'W-6': behind657('W-4'), 'W-7': behind657('W-3'),
} });
const w657 = N.collect({ word: 'wait657' }).items;
const need657 = (k) => w657.find((i) => i.t.key === k)?.need;
t('DS-657 AC1 a live item says how many tickets wait behind it, the one behind another counted', need657('W-1'), 'Which copy? (3 tickets wait behind this)');
t('DS-657 AC1 one with a single ticket behind it says so', need657('W-3'), 'PRODUCTION BROKEN: login returns 500 (1 ticket waits behind this)');
t('DS-657 AC1 negative control: one with none behind it says nothing', need657('W-2'), 'Which endpoint?');
t('DS-657 AC2 PRODUCTION BROKEN first, then most tickets behind, ahead of one that has waited longer', w657.map((i) => i.t.key).join(), 'W-3,W-1,W-2');

// ---- DS-701: the list as data (listItems, list --json): each item with its question as listed, its
// actions, how many tickets wait behind it and its cause.
const j701 = N.listItems({ word: 'wait657', reads: null });
const ji701 = Object.fromEntries(j701.items.map((i) => [i.key, i]));
t('DS-701 listItems lists what collect does, in its order', j701.items.map((i) => i.key).join(), w657.map((i) => i.t.key).join());
t('DS-701 the "waiting behind" count is in the item', ['W-1', 'W-3', 'W-2'].map((k) => ji701[k]?.behind).join(), '3,1,0');
t('DS-701 its question is the listed need, word for word', ji701['W-1']?.question, need657('W-1'));
t('DS-701 a PRODUCTION BROKEN park is marked so', `${ji701['W-3']?.production_broken} ${ji701['W-1']?.production_broken}`, 'true false');
t('DS-701 the item names its batch, key, kind and ticket, and its actions with the recommendation', JSON.stringify((({ id, batch, key, kind, ticket, actions }) => ({ id, batch, key, kind, ticket, first: actions[0] }))(ji701['W-1'])),
  JSON.stringify({ id: 'wait657:W-1:parked', batch: 'wait657', key: 'W-1', kind: 'parked', ticket: 'W-1', first: { action: 'resume', recommended: true, why: 'lane A: a worker finishes it once it has your answer', note: null } }));
t('DS-701 an item waiting on its own has no cause', ji701['W-1']?.cause, null);
t('DS-701 without settling, it says so and settles nothing', `${j701.settled} ${j701.settled_lines.length} ${j701.v}`, 'false 0 1');
t('DS-701 its queue carries its age', j701.inputs.queues.map((x) => `${x.batch} ${typeof x.age_s}`).join(), 'wait657 number');
// A repo-level item counts and ranks the same: an unset row's group by the tickets held behind its
// parked tickets, a person's step by the tickets waiting on it and those held behind them.
put('nu657', { port: 5659, beat: 1, supervised: true, tickets: {
  'U-1': parked('A', 5, 'CONFIG_DENIED: worker-web-read (unset): needs the published rate'), 'U-2': parked('A', 300, 'Which copy?'),
  'U-3': behind657('U-1'), 'U-4': behind657('U-3'),
} });
const u657 = N.collect({ word: 'nu657' }).items;
t('DS-657 AC1 an unset row\'s item says how many tickets wait behind its parked tickets', /\(2 tickets wait behind this\)$/.test(u657.find((i) => i.kind === 'config')?.need ?? ''), true);
t('DS-657 AC2 and ranks ahead of one that has waited longer', u657.map((i) => i.t.key).join(), 'unset:worker-web-read,U-2');
put('kappa657', { port: 5660, beat: 1, supervised: true, tickets: {
  'K-1': { state: 'done', lane: 'A', result: { pr: 76 }, pr_status: { pr: 76, state: 'OPEN', isDraft: false, checks: [] }, merge_after: 'OPS-6' },
  'K-2': parked('A', 300, 'Which endpoint?'), 'K-3': behind657('K-1'),
} });
const k657 = N.collect({ word: 'kappa657' }).items;
t('DS-657 AC1 a person\'s step says how many tickets wait behind it, those held behind its waiting tickets counted', /\(2 tickets wait behind this\)$/.test(k657.find((i) => i.kind === 'step')?.need ?? ''), true);
t('DS-657 AC2 and ranks ahead of one that has waited longer', k657.map((i) => i.t.key).join(), 'step:OPS-6,K-2');

// ---- DS-415: drafts whose evidence run failed wait on one fix ticket: no PR item each, and the fix's
// park, naming a setting only the person holds, is the one item.
const evWhy = (n) => `its evidence workflow \`pr-evidence.yml\` failed at aaaaaaaaa and left 2 screenshot cell(s): "Error: did not set a _vercel_jwt cookie"; EV-9 fixes it for the repo, then the run is started again`;
put('evfix', { port: 5150, beat: 1, supervised: true, tickets: {
  'EV-1': draftPr(151, passed, { call: 'evidence-fix', why: evWhy(151), action: null, pr: 151 }),
  'EV-2': draftPr(152, passed, { call: 'evidence-fix', why: evWhy(152), action: null, pr: 152 }),
  'EV-3': draftPr(153, passed, { call: 'evidence-fix', why: evWhy(153), action: null, pr: 153 }),
  'EV-9': parked('A', 10, 'the Vercel protection bypass secret VERCEL_AUTOMATION_BYPASS_SECRET was rotated: set the new one in the repo secrets, as only you hold it'),
} });
const evItems = N.collect({ word: 'evfix' }).items;
t('DS-415 AC1 AC2 PRs waiting on the evidence fix are not listed', evItems.filter((i) => i.kind === 'pr').length, 0);
t('DS-415 AC5 the fix\'s park is one item for the repo, naming the setting', `${evItems.length} ${evItems[0]?.t.key} ${/bypass secret/.test(evItems[0]?.need ?? '')}`, '1 EV-9 true');
const evr = loadRepos().find((x) => x.slug === 'acme__evfix');
const ev1 = [...evr.rows, ...evr.prs].find((x) => x.t.key === 'EV-1');
t('DS-415 desk-q shows each waiting PR as moving, naming the fix', `${ev1?.k} ${rowText(evr, ev1).includes('evidence workflow broken, EV-9 fixes it, then screenshots are taken again')}`, 'merging true');

// AC3 and AC4 across every PR item any fixture repo lists.
const prItems =N.collect().items.filter((i) => i.kind === 'pr' || /PR #\d+/.test(i.need));
t('DS-378 AC3 no PR item names a commit SHA, a fix try or a review verdict', prItems.filter((i) => /\b[0-9a-f]{7,40}\b|fix tr(y|ies)|verdict readable/i.test(i.need)).map((i) => `${i.t.key}: ${i.need}`).join(' | '), '');
t('DS-378 AC4 every PR item says what is wrong, then what to do and what happens next', prItems.filter((i) => i.kind === 'pr' && !/^PR #\d+[^]*\. [A-Z][^]*; [^]*?\.(?: \([^]*\))?$/.test(i.need)).map((i) => `${i.t.key}: ${i.need}`).join(' | '), '');
// AC1: done on a PR still open says so, and the item comes back with that note.
onGitHub(141, { state: 'OPEN', mergedAt: null, isDraft: false, headRefOid: sha(141) });
const q1 = N.record({ word: 'psi', ticket: 'Q-1', action: 'done' });
t('DS-378 AC1 done on a PR still open says GitHub still shows it unmerged', `${q1.ok} ${q1.line}`, 'false psi Q-1: GitHub still shows PR #141 unmerged, so it stays on your list with that note.');
t('DS-378 AC1 it is read from the repo\'s GitHub', readFileSync(GH_LOG, 'utf8').includes('pr view 141 --repo acme/psi --json state,mergedAt,isDraft,headRefOid'), true);
t('DS-378 AC1 it is listed again with that note', /^\(You said done at \d{4}-\d\d-\d\d \d\d:\d\d UTC, and GitHub still showed it unmerged\.\)$/.test(psi()['Q-1']?.note ?? ''), true);
const q1Line = here('list', 'psi').out.split('\n').find((l) => l.startsWith('psi Q-1 pr')) ?? '';
t('DS-378 AC1 the listed line keeps the need and the note whole', q1Line.includes(`| ${psi()['Q-1'].need} ${psi()['Q-1'].note} |`), true);
// AC4 on the listed line: a long recorded text a need quotes never takes the next step off it.
const longHold = withHead(psiPr(147, { merge_blocked: `merge hold: ${'needs a sign-off on a very long list of held paths, '.repeat(6)}` }));
const qhl = queueOf('psi'); qhl.tickets['Q-7'] = { key: 'Q-7', ...longHold };
writeFileSync(join(env.DESK_HOME, 'repos', 'acme__psi', 'queue.json'), JSON.stringify(qhl));
t('DS-378 AC4 a long merge hold still says what happens next on its listed line',
  (here('list', 'psi').out.split('\n').find((l) => l.includes('| PR #147 ')) ?? '').includes('Do what it asks first, then merge it on GitHub; the ticket is then done. |'), true);
delete qhl.tickets['Q-7']; writeFileSync(join(env.DESK_HOME, 'repos', 'acme__psi', 'queue.json'), JSON.stringify(qhl));
// ---- DS-411: a merge hold's item names its step, the routine desk did not run, or the step it failed at
const migr = 'merge hold: apply the migration to staging and production first — prisma/migrations/**, 1 file(s), e.g. prisma/migrations/2026_brand/migration.sql';
qhl.tickets['Q-7'] = { key: 'Q-7', ...withHead(psiPr(147, { merge_blocked: migr })) };
qhl.tickets['Q-8'] = { key: 'Q-8', ...withHead(psiPr(148, { merge_blocked: `${migr}; routine \`./scripts/apply-migrations.sh\` not run: §3 merge-hold-routine is no` })) };
qhl.tickets['Q-9'] = { key: 'Q-9', ...withHead(psiPr(149, { merge_blocked: `${migr}; routine \`./scripts/apply-migrations.sh\` failed at 575fa8c51 (exit 2): migrate deploy on public: P3009 failed migration` })) };
qhl.tickets['Q-10'] = { key: 'Q-10', ...withHead(psiPr(150, { merge_blocked: `${migr}; routine \`./scripts/apply-migrations.sh\` not run: it also touches a hold no routine clears: deploys the infrastructure on merge — infra/**, 1 file(s), e.g. infra/main.tf` })) };
writeFileSync(join(env.DESK_HOME, 'repos', 'acme__psi', 'queue.json'), JSON.stringify(qhl));
const p411 = psi();
t('DS-411 AC3 a routine hold beside a hold with no routine keeps the routine step first, and the row is not offered',
  p411['Q-10']?.need, 'PR #150 touches files under a merge hold (prisma/migrations/**, 1 file(s), e.g. prisma/migrations/2026_brand/migration.sql), and its step comes before the merge: apply the migration to staging and production first. desk can run its routine, `./scripts/apply-migrations.sh`, but it also touches a hold no routine clears: deploys the infrastructure on merge — infra/**, 1 file(s), e.g. infra/main.tf. Run it and take that step yourself, then merge it on GitHub; the ticket is then done.');
t('DS-411 AC3 a hold with no routine names the step from its reason, not only a merge',
  p411['Q-7']?.need, 'PR #147 is under a merge hold, so desk never merges it itself: "apply the migration to staging and production first" (prisma/migrations/**, 1 file(s), e.g. prisma/migrations/2026_brand/migration.sql). Do what it asks first, then merge it on GitHub; the ticket is then done.');
t('DS-411 AC3 with §3 merge-hold-routine off, it names the step, the routine and the row',
  p411['Q-8']?.need, 'PR #148 touches files under a merge hold (prisma/migrations/**, 1 file(s), e.g. prisma/migrations/2026_brand/migration.sql), and its step comes before the merge: apply the migration to staging and production first. desk can run its routine, `./scripts/apply-migrations.sh`, but §3 merge-hold-routine is no. Run it yourself, then merge it on GitHub (or set that row to yes with /desk-setup, and desk runs it and merges); the ticket is then done.');
t('DS-411 AC2 a routine that failed is named with the step it failed at',
  p411['Q-9']?.need, 'PR #149 touches files under a merge hold (prisma/migrations/**, 1 file(s), e.g. prisma/migrations/2026_brand/migration.sql), and desk ran its routine, `./scripts/apply-migrations.sh`, at 575fa8c51: it failed (exit 2) at "migrate deploy on public: P3009 failed migration". Settle that step and finish the routine by hand, then merge it on GitHub; the ticket is then done.');
t('DS-411 AC3 no hold item says only to merge it on GitHub', ['Q-7', 'Q-8', 'Q-9'].filter((k) => !/apply the migration|failed \(exit/.test(p411[k]?.need ?? '')).join(), '');
for (const k of ['Q-7', 'Q-8', 'Q-9', 'Q-10']) delete qhl.tickets[k];
// ---- DS-503: a hold with no routine whose step an agent can check is a gap in the config, not the person's step.
const dry = 'merge hold: skim the Confluence Sync dry-run comment first (AGENTS.md) — frontend/e2e/**, 1 file(s), e.g. frontend/e2e/auth.spec.ts';
qhl.tickets['Q-11'] = { key: 'Q-11', ...withHead(psiPr(151, { merge_blocked: dry })) };
writeFileSync(join(env.DESK_HOME, 'repos', 'acme__psi', 'queue.json'), JSON.stringify(qhl));
const p503 = psi();
t('DS-503 AC4 a hold an agent can check with no routine reads as a config gap',
  p503['Q-11']?.need, 'PR #151 is under a merge hold whose step an agent can check, but the hold names no routine, so desk cannot run it: "skim the Confluence Sync dry-run comment first (AGENTS.md)" (frontend/e2e/**, 1 file(s), e.g. frontend/e2e/auth.spec.ts). Give this hold a routine: /desk-update proposes one (`; desk runs: <command>` on its §4 Merge holds item, with §3 merge-hold-routine yes); desk then runs it and merges.');
t('DS-503 AC4 it never says to merge it on GitHub, nor that only you can do the step',
  `${/merge it on GitHub/.test(p503['Q-11']?.need ?? '')} ${p503['Q-11']?.actions.some(([, why]) => /only you/.test(why ?? ''))} ${p503['Q-11']?.actions[0][1]}`,
  'false false the hold needs a routine in the config; say done once it has one, and the PR is checked on GitHub there and then');
t('DS-503 AC4 negative control: a person\'s hold with no routine is still the person\'s step', /^PR #141 is under a merge hold, so desk never merges it itself: "touches billing"/.test(p503['Q-1']?.need ?? ''), true);
delete qhl.tickets['Q-11'];
writeFileSync(join(env.DESK_HOME, 'repos', 'acme__psi', 'queue.json'), JSON.stringify(qhl));
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

// ---- DS-417: the list form the skill names prints every need whole, so the session asks it with its recommendation.
const skillList = /needs-you\.mjs (list <repo>)/.exec(skill)?.[1] ?? '';
const longNeed = `${'Accept 2 and 3 segments, or trim the copy and shorten the link path, as the SMS segment count sets the cost. '.repeat(6)}Recommend shortening the link path.`;
const runUrl = 'https://github.com/acme/long417/actions/runs/18234567890/job/51234567890';
const urlPr = { ...draftPr(161, passed, { call: 'person', why: `its evidence workflow failed, see ${runUrl}`, action: 'fix the evidence run on #161' }),
  done_check: { at: minsAgo(5), head: 'h161', state: 'OPEN', draft: true } };
put('long417', { port: 5170, beat: 1, supervised: true, tickets: {
  'L-1': parked('A', 30, longNeed),
  'L-2': parked('A', 20, `Which link? The preview is at ${runUrl}?q=${'a'.repeat(260)} and the docs disagree.`),
  'L-3': urlPr,
} });
const longLines = cli(...skillList.replace('<repo>', 'long417').split(' ')).out.split('\n');
const longLine = (k) => longLines.find((l) => l.startsWith(`long417 ${k} `)) ?? '';
t('DS-417 the skill names the list form', skillList, 'list <repo>');
t('DS-417 AC1 a 600-character need is listed whole, recommendation included', `${longNeed.length >= 600} ${longLine('L-1').includes(`| ${longNeed} |`)}`, 'true true');
t('DS-417 AC2 a URL in a parked need is printed whole', longLine('L-2').includes(`${runUrl}?q=${'a'.repeat(260)} and the docs disagree. |`), true);
t('DS-417 AC2 a URL in a PR item\'s recorded reason is printed whole', longLine('L-3').includes(runUrl), true);
// ---- DS-560: a SHA set off by commas leaves no double comma; an unwrapped SHA and a URL read as before.
const shaUrl = 'https://github.com/acme/comma560/commit/57e3a9253abcdef0';
put('comma560', { port: 5171, beat: 1, supervised: true, tickets: {
  'C-1': draftPr(181, passed, { call: 'person', why: 'its latest review, at 57e3a9253, does not open a line with "x" as its outcome', action: 'settle it on #181' }),
  'C-2': draftPr(182, passed, { call: 'person', why: 'its review at 3725bcebd states "x"', action: 'settle it on #182' }),
  'C-3': draftPr(183, passed, { call: 'person', why: `its run failed, see ${shaUrl}`, action: 'settle it on #183' }),
} });
const c560 = Object.fromEntries(N.collect({ word: 'comma560' }).items.map((i) => [i.t.key, i.need]));
t('DS-560 AC1 a comma-wrapped SHA is taken out with its commas', c560['C-1'], 'PR #181 is a draft: latest review does not open a line with "x" as its outcome. Settle it on #181; the next pass then picks it up.');
t('DS-560 AC2 an unwrapped SHA is taken out as before', c560['C-2'], 'PR #182 is a draft: review states "x". Settle it on #182; the next pass then picks it up.');
t('DS-560 AC3 a URL holding a hex run is left whole', c560['C-3']?.includes(shaUrl), true);
// ---- DS-854: a refused fix ticket's body file is quoted with its id; a SHA beside it still goes.
const bodyFile = '/home/me/.desk-autopilot/acme__p854/batches/VPL-861/evidence-runs/fix-338f2164.md';
put('path854', { port: 5172, beat: 1, supervised: true, tickets: {
  'P-1': draftPr(191, passed, { call: 'person', why: `its evidence workflow failed at 57e3a9253; no fix could be started for it for the repo (desk-jira create was refused (desk-jira: refusing to send ${bodyFile}: a body must be inside $DESK_STATE))`, action: 'settle it on #191' }),
} });
const p854 = N.collect({ word: 'path854' }).items.find((i) => i.t.key === 'P-1')?.need ?? '';
t('DS-854 AC3 a path holding a hex id is quoted whole', `${p854.includes(bodyFile)} ${p854.includes('its latest commit.md')}`, 'true false');
t('DS-854 AC3 a SHA on its own in the same reason is still taken out', /failed;/.test(p854) && !p854.includes('57e3a9253'), true);

t('DS-417 AC3 a done note still follows the need whole', /\| PR #161 [^|]*\. \(You said done at [^|]*, and GitHub still showed it unmerged, still a draft\.\) \|/.test(longLine('L-3')), true);

// ---- A review stuck recorded at a head the PR has since left is gone
// before the next pass: the draft's undraft reason at its head is what the person sees.
const undraft386 = { call: 'person', why: 'its body has a `_drag` cell with no screenshot', action: 'take it or take the cell out of #348' };
const stale386 = { why: 'review not clean after 2 fix tries (2 review): 1 P0 — P0: desk/bin/evidence.mjs:40 a code span splits the cell', pr: 348, head: '597a520', at: minsAgo(60) };
const draft386 = (stuck) => { const d = draftPr(348, passed, undraft386); return { ...d, ...(stuck ? { stuck } : {}), pr_status: { ...d.pr_status, head: 'a6e2ab4' } }; };
put('stale', { port: 5150, beat: 1, supervised: true, merge: 'yes', tickets: { 'K-1': draft386(stale386), 'K-2': draft386(null), 'K-3': draft386({ ...stale386, head: 'a6e2ab4' }) } });
const kap = Object.fromEntries(N.collect({ word: 'stale' }).items.map((i) => [i.t.key, i]));
t('DS-386 AC3 a review stuck at an older head is no item: the draft shows its undraft reason, as one never stuck does',
  `${kap['K-1']?.need === kap['K-2']?.need} ${/still has findings/.test(kap['K-1']?.need ?? '')}`, 'true false');
t('DS-386 AC2 a review stuck at the PR\'s head still asks for the fix', /code review still has findings/.test(kap['K-3']?.need ?? ''), true);

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
  'PR #151 is a draft, and desk\'s capture try could not take 2 of its screenshots, so nothing desk has can fill their cells. Edit the PR body so no cell is left; the next pass then takes it out of draft.');
t('DS-379 AC3 its note names each screen and the worker\'s reason, whole', chi['C-1']?.note, `(Not taken: s-2-before.png, s-2-after.png. The capture try said: ${said379})`);
const c1Line = here('list', 'chi').out.split('\n').find((l) => l.startsWith('chi C-1 pr')) ?? '';
t('DS-379 AC3 the listed line keeps the need and the note whole', c1Line.includes(`| ${chi['C-1'].need} ${chi['C-1'].note} |`), true);
t('DS-379 AC3 one screen with nothing said still names it', `${chi['C-2']?.need} ${chi['C-2']?.note}`,
  'PR #152 is a draft, and desk\'s capture try could not take one of its screenshots, so nothing desk has can fill its cell. Edit the PR body so no cell is left; the next pass then takes it out of draft. (Not taken: a-after.png.)');

// ---- DS-492: done on a screenshot item reads the PR's body, not its draft state, and the person is
// never asked to upload.
const shotDraft = (pr, why, extra = {}) => ({ state: 'done', result: { pr }, pr_status: { pr, state: 'OPEN', isDraft: true, head: 'h'.repeat(40), checks: [] },
  undraft: { call: 'person', why, action: `edit the body of #${pr} so no \`_drag <file>_\` cell is left`, sha: 'h'.repeat(40), pr }, ...extra });
const cellWhy = '1 screenshot cell(s) left: a.png, whose files desk holds but could not put in the body';
put('sigma', { port: 5300, beat: 1, supervised: true, merge: 'yes', prReady: 'yes', tickets: {
  'H-1': shotDraft(171, cellWhy),
  'H-2': capturePr(172, ['a-after.png'], 'needs a signed-in admin'),
  'H-3': shotDraft(173, cellWhy),
  'H-4': { ...capturePr(174, ['a-after.png'], 'needs a signed-in admin'), fix_tries: [{ try: 1, head: 'h'.repeat(40), kind: 'capture' }] },
  'H-5': { ...shotDraft(175, 'its review verdict at aaaaaaaaa is not clean (p2=1)'), undraft: { call: 'person', why: 'its review verdict at aaaaaaaaa is not clean (p2=1)', action: 'settle the findings or gaps on #175', pr: 175 } },
} });
const sig = () => Object.fromEntries(N.collect({ word: 'sigma' }).items.map((i) => [i.t.key, i]));
t('DS-492 AC3 a cell desk holds but could not place is named, with why, and no upload is asked for', sig()['H-1']?.need,
  'PR #171 is a draft: 1 screenshot cell(s) left: a.png, whose files desk holds but could not put in the body. Edit the body of #171 so no `_drag <file>_` cell is left; the next pass then picks it up.');
onGitHub(171, { state: 'OPEN', mergedAt: null, isDraft: true, headRefOid: 'h'.repeat(40), body: 'Before | After\n<img alt="a" src="https://x/a.png">\n\nA cell reads `_drag <file>_`.' });
const fine = N.record({ word: 'sigma', ticket: 'H-1', action: 'done' });
t('DS-492 AC4 done with no cell in the body is accepted, though the PR is a draft', `${fine.ok} ${fine.line}`,
  'true sigma H-1: GitHub shows no screenshot cell left in PR #171\'s body, so it is off your list; the next pass takes it out of draft.');
t('DS-492 AC4 and it leaves the list, as desk\'s to undraft', `${sig()['H-1']?.kind ?? 'none'} ${queueOf('sigma').tickets['H-1'].undraft.call}`, 'none filled');
onGitHub(172, { state: 'OPEN', mergedAt: null, isDraft: true, headRefOid: 'h'.repeat(40), body: 'done' });
const fine2 = N.record({ word: 'sigma', ticket: 'H-2', action: 'done' });
t('DS-492 AC4 a stuck capture try clears the same way', `${fine2.ok} ${queueOf('sigma').tickets['H-2'].stuck ?? null} ${sig()['H-2']?.kind ?? 'none'}`, 'true null none');
const stateSigma = loadRepos().find((x) => x.slug === 'acme__sigma').stateDir;
mkdirSync(join(stateSigma, 'images', 'H-3'), { recursive: true });
writeFileSync(join(stateSigma, 'images', 'H-3', 'held.png'), '');
onGitHub(173, { state: 'OPEN', mergedAt: null, isDraft: true, headRefOid: 'h'.repeat(40), body: '_drag held.png_ | _drag gone.png_ | _drag gone.png_' });
const three = N.record({ word: 'sigma', ticket: 'H-3', action: 'done' });
t('DS-492 AC5 done with cells left is refused, naming how many and what desk does about each', `${three.ok} ${three.line}`,
  'false sigma H-3: GitHub still shows 3 screenshot cell(s) in PR #173\'s body, so it stays on your list: held.png: desk holds its file but could not put it in the body; gone.png: a capture worker takes it at the next pass.');
t('DS-492 AC5 the item notes the cells, not the draft', /GitHub still showed it with 3 screenshot cell\(s\) left\.\)$/.test(sig()['H-3']?.note ?? ''), true);
onGitHub(174, { state: 'OPEN', mergedAt: null, isDraft: true, headRefOid: 'h'.repeat(40), body: '_drag a-after.png_' });
const spent = N.record({ word: 'sigma', ticket: 'H-4', action: 'done' });
t('DS-492 AC5 a cell the capture try could not take says so', spent.line.endsWith('a-after.png: desk\'s capture try could not take it.'), true);
onGitHub(175, { state: 'OPEN', mergedAt: null, isDraft: true, headRefOid: 'h'.repeat(40), body: 'no cells' });
const review5 = N.record({ word: 'sigma', ticket: 'H-5', action: 'done' });
t('DS-492 negative control: done on a draft held for another reason is still refused', `${review5.ok} ${/still shows PR #175 unmerged, still a draft/.test(review5.line)}`, 'false true');
// A repo whose §4 Evidence workflow fills the cells, and whose §3 pr-ready leaves undrafting to the person.
const noStart = (pr) => `its evidence workflow \`pr-evidence.yml\` could not start: HTTP 502 for #${pr}`;
const EVC = '_drag e-after.png_\n\n```evidence\ne-after.png | after | /x | 1280\n```\n';
put('tau', { port: 5310, beat: 1, supervised: true, merge: 'yes', prReady: 'no', evidence: 'pr-evidence.yml', tickets: {
  'U-1': shotDraft(181, noStart(181)),
  'U-2': shotDraft(182, noStart(182)),
  'U-3': { ...shotDraft(183, '1 screenshot cell(s) left: u.png, whose files are saved, but config §3 pr-images leaves their upload to you'), images_reported: true },
} });
onGitHub(181, { state: 'OPEN', mergedAt: null, isDraft: true, headRefOid: 'h'.repeat(40), body: 'all in' });
const tau1 = N.record({ word: 'tau', ticket: 'U-1', action: 'done' });
t('DS-492 AC4 an evidence workflow that could not start is a screenshot item too, and done with no cell left is accepted', tau1.ok, true);
t('DS-492 AC4 with §3 pr-ready not yes, done says the undraft is the person\'s, not the next pass\'s', tau1.line.endsWith('so it is off your list; config §3 pr-ready is "no", so the next pass leaves undrafting #181 to you.'), true);
onGitHub(182, { state: 'OPEN', mergedAt: null, isDraft: true, headRefOid: 'h'.repeat(40), body: EVC });
t('DS-492 AC5 a cell the evidence workflow fills: done names the workflow', N.record({ word: 'tau', ticket: 'U-2', action: 'done' }).line.endsWith('e-after.png: `pr-evidence.yml` takes it at the next pass.'), true);
const stateTau = loadRepos().find((x) => x.slug === 'acme__tau').stateDir;
mkdirSync(join(stateTau, 'evidence-runs'), { recursive: true });
writeFileSync(join(stateTau, 'evidence-runs', `182-${'h'.repeat(40)}.json`), JSON.stringify({ workflow: 'pr-evidence.yml', runId: null, url: null, at: minsAgo(60), cells: 1 }));
mkdirSync(join(stateTau, 'images', 'U-2'), { recursive: true });
writeFileSync(join(stateTau, 'images', 'U-2', 'e-after.png'), '');
t('DS-492 AC5 once it ran and left the cell, done says so', N.record({ word: 'tau', ticket: 'U-2', action: 'done' }).line.endsWith('e-after.png: `pr-evidence.yml` ran and could not take it.'), true);
mkdirSync(join(stateTau, 'images', 'U-3'), { recursive: true });
writeFileSync(join(stateTau, 'images', 'U-3', 'u.png'), '');
onGitHub(183, { state: 'OPEN', mergedAt: null, isDraft: true, headRefOid: 'h'.repeat(40), body: '_drag u.png_' });
t('DS-492 AC5 a file whose upload waits for approval: done says so', N.record({ word: 'tau', ticket: 'U-3', action: 'done' }).line.endsWith('u.png: its file is saved, and config §3 pr-images leaves its upload to you.'), true);

// ---- DS-429: an upload that crashed on every try names the crash and its saved output.
// The why is the one the pass's undraft step records (undraft.mjs cellCall), not a copy of its wording.
const { cellCall } = await import('../desk/bin/undraft.mjs');
const crashLog = '/state/images/K-1.upload.log';
const k1Crash = { pr: 191, dir: '/state/images/K-1', tries: 2, log: crashLog };
const crashWhy = cellCall({ key: 'K-1', upload_crash: k1Crash }, { number: 191, body: '_drag k.png_' }, {}).why;
put('kappa429', { port: 5330, beat: 1, supervised: true, merge: 'yes', prReady: 'yes', tickets: {
  'K-1': { ...shotDraft(191, crashWhy), upload_crash: k1Crash },
} });
const stateK429 = loadRepos().find((x) => x.slug === 'acme__kappa429').stateDir;
mkdirSync(join(stateK429, 'images', 'K-1'), { recursive: true });
writeFileSync(join(stateK429, 'images', 'K-1', 'k.png'), '');
const k429 = Object.fromEntries(N.collect({ word: 'kappa429' }).items.map((i) => [i.t.key, i]));
t('DS-429 AC3 a crashed upload says it crashed and points at the saved log', /upload of them crashed on 2 tries; its output is saved in \/state\/images\/K-1\.upload\.log/.test(k429['K-1']?.need ?? ''), true);
t('DS-429 AC3 its done says desk\'s upload crashed', /^desk's upload crashed on every try it gets/.test(k429['K-1']?.actions[0][1] ?? ''), true);
t('DS-429 AC3 and it is not put as a step only the person can do', /only you can do this step/.test(k429['K-1']?.actions[0][1] ?? 'only you can do this step'), false);
onGitHub(191, { state: 'OPEN', mergedAt: null, isDraft: true, headRefOid: 'h'.repeat(40), body: '_drag k.png_' });
t('DS-429 AC3 done with the cell left names the crash and the log', N.record({ word: 'kappa429', ticket: 'K-1', action: 'done' }).line.endsWith(`k.png: desk's upload of it crashed on every try (its output is in ${crashLog}).`), true);

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
const omegaList = here('list', 'omega').out.split('\n');
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
// A feature batch whose spine is not done holds a ticket moved into it behind that spine. M-4 also
// merges only after the person's step OPS-4, which goes with it.
writeFileSync(fq, JSON.stringify({ ...fQueue(), feature: true, spine: 'F-2' }));
const omegaQ = join(env.DESK_HOME, 'repos', 'acme__omega', 'queue.json');
const oq4 = queueOf('omega'); oq4.tickets['M-4'].merge_after = 'OPS-4'; writeFileSync(omegaQ, JSON.stringify(oq4));
const m4 = N.record({ word: 'omega', ticket: 'M-4', action: 'move', text: 'F-1' });
const mv4 = fQueue().tickets['M-4'];
t('DS-380 a ticket moved into a feature batch waits behind its unfinished spine', `${m4.ok} ${mv4?.state} ${mv4?.held_by}`, 'true parked F-2');
t('DS-407 a ticket moved to another batch keeps its merge hold on the person\'s step', mv4?.merge_after, 'OPS-4');
// New files nobody committed are work too: the worktree stays, and nothing moves.
og('worktree', 'add', '-q', '-b', 'fix/M-5', wt('M-5'), 'main');
writeFileSync(join(wt('M-5'), 'new.js'), 'work\n');
const m5 = N.record({ word: 'omega', ticket: 'M-5', action: 'move', text: 'F-1' });
t('DS-380 a worktree holding untracked files is never removed, and nothing moves', `${m5.ok} ${/holds work cut from main \(uncommitted changes or untracked files\)/.test(m5.line)} ${existsSync(join(wt('M-5'), 'new.js'))} ${'M-5' in queueOf('omega').tickets} ${'M-5' in fQueue().tickets}`, 'false true true true false');

// ---- DS-425: the decider moves an answered park into the batch its answer names, through needs-you's move
{
  const D = await import('../desk/bin/decider.mjs');
  const oState = join(env.HOME, '.desk-autopilot', 'acme__omega');
  const BASE_Q = 'M-8 needs src/feature.js, which is only on the feat/f base: which base should it build on?';
  const oq = queueOf('omega');
  oq.tickets['M-8'] = { key: 'M-8', added_at: minsAgo(600), ...parked('A', 5, BASE_Q) };
  oq.tickets['M-9'] = { key: 'M-9', added_at: minsAgo(600), ...parked('A', 4, 'M-9 needs the file on the feature base too') };
  oq.tickets['M-10'] = { key: 'M-10', added_at: minsAgo(600), ...parked('A', 3, 'which fixture for tests/m10.js?') };
  writeFileSync(omegaQ, JSON.stringify(oq));
  for (const k of ['M-8', 'M-9']) writeFileSync(join(oState, 'triage', `${k}.json`), JSON.stringify({ ticket: k, epic: null, lane: 'A', size: 'S' }));
  // As the supervisor finds them, in the standing batch's environment.
  const targets = D.runningBatches(BIN, { cwd: omegaRoot, env: { ...process.env, DESK_REPO_DIR: omegaRoot, DESK_REPO_ROOT: omegaRoot, DESK_QUEUE: omegaQ, DESK_AUTOPILOT_STATE: oState } });
  t('DS-425 the decider is given the batches running beside its own', JSON.stringify(targets), JSON.stringify([{ name: 'F-1', base: 'feat/f', word: 'F-1' }]));
  const answer = (item, text) => ({ ...item, answers: [{ at: minsAgo(1), text }] });
  const its = D.deciderItems({ parked: ['M-8', 'M-9', 'M-10'].map((key) => ({ key, question: queueOf('omega').tickets[key].park.question })) }, queueOf('omega'));
  const [i8, i9, i10] = its;
  const prompt = D.deciderPrompt({ slug: 'acme__omega', report: '', items: [answer(i8, 'run it in batch F-1'), i9], rules: '', bin: BIN, targets });
  const moveCmd = `node ${join(BIN, 'needs-you.mjs')} move`;
  t('DS-425 AC1 the prompt says to move an answer naming another batch, not requeue it, and names the batches running',
    `${prompt.includes(`${moveCmd} acme__omega <TICKET> <batch>`)} ${prompt.includes('The batches running beside this one: F-1 (on feat/f)')} ${prompt.includes('move it there instead (a requeue would respawn it here, on this base)')}`, 'true true true');
  const allow = D.deciderSettings({ bin: BIN, state: oState }).permissions.allow;
  t('DS-425 AC1 the decider may run needs-you\'s move and no other needs-you action', JSON.stringify(allow.filter((a) => a.includes('needs-you.mjs'))), JSON.stringify([`Bash(${moveCmd}:*)`]));
  t('DS-514 AC4 the decider cannot record an answer, so no grant comes from it', allow.filter((a) => a.includes('answer.mjs')).length, 0);
  // What the decider runs for M-8's answer, as its allow rule lets it.
  const run = (...a) => spawnSync(process.execPath, [join(BIN, 'needs-you.mjs'), 'move', ...a], { encoding: 'utf8', env: process.env, cwd: T });
  const mv8 = run('acme__omega', 'M-8', 'F-1');
  const o8 = D.outcome({ items: [i8], targets }, { cost: 0, settled: { [i8.id]: 'moved M-8 to batch F-1' } }, queueOf('omega'));
  t('DS-425 AC1 the ticket is moved to the feature batch and not requeued in the main batch',
    `${mv8.status} ${'M-8' in queueOf('omega').tickets} ${'M-8' in fQueue().tickets} ${fQueue().tickets['M-8']?.moved_from?.base}`, '0 false true main');
  t('DS-425 AC1 the decider\'s move counts as settled', `${o8.settled.map((x) => x.item.ticket).join()} ${o8.handed.length}`, 'M-8 0');
  // M-9's answer names a batch that is not running: the move is refused, and the decider hands it on with that.
  const mv9 = run('acme__omega', 'M-9', 'G-9');
  const o9 = D.outcome({ items: [i9], targets }, { cost: 0, handed: { [i9.id]: mv9.stdout.trim() } }, queueOf('omega'));
  t('DS-425 AC2 a move naming a batch that is not running is refused, and M-9 stays parked here',
    `${mv9.status} ${queueOf('omega').tickets['M-9']?.state} ${'M-9' in fQueue().tickets}`, '11 parked false');
  t('DS-425 AC2 its hand-on lists the batches that are running', o9.handed[0]?.why, 'omega M-9: G-9 is not a batch running in omega beside this one, so nothing was moved. The batches running are F-1 (on feat/f).; move <batch> takes it out of this batch and queues it in another, its next worker on that base: F-1 (on feat/f)');
  // Unanswered and handed on: a park about the ticket's base offers the move; one about anything else does not.
  const o3 = D.outcome({ items: [i8, i10], targets }, { cost: 0, handed: { [i8.id]: 'a call on the base only the person makes', [i10.id]: 'a product call' } }, oq);
  t('DS-425 AC3 a park asking to change the base is handed on offering move <batch> with the running batches', o3.handed[0]?.why, 'a call on the base only the person makes; move <batch> takes it out of this batch and queues it in another, its next worker on that base: F-1 (on feat/f)');
  t('DS-425 AC3 a park about something else offers no move', o3.handed[1]?.why, 'a product call');
  // Taken back out, so the omega lists below read as before.
  const oqb = queueOf('omega'); delete oqb.tickets['M-9']; delete oqb.tickets['M-10']; writeFileSync(omegaQ, JSON.stringify(oqb));
}
// ---- A put-off item comes back once it offers an action it did not offer when put off.
const omegaState = join(env.HOME, '.desk-autopilot', 'acme__omega');
// M-3 put off offering resume and not-now; M-2 by answer.mjs before entries recorded actions, so with
// none; M-5 since, with none either, as an entry whose item no batch listed when it was put off.
NN.addPutOff(NN.putOffEntry({ question: 'this one too', ticket: 'M-3', inputs: {}, actions: ['resume', 'not-now'] }), omegaState);
NN.addPutOff(NN.putOffEntry({ question: 'the file is on the feature branch', ticket: 'M-2', inputs: {}, at: '2026-10-31T16:54:00.000Z' }), omegaState);
NN.addPutOff(NN.putOffEntry({ question: 'and this one', ticket: 'M-5', inputs: {} }), omegaState);
const omega = () => Object.fromEntries(N.collect({ word: 'omega' }).items.map((i) => [i.t.key, i]));
t('DS-401 AC1 an item put off offering resume and not-now is listed again once it offers move, saying so',
  /^this one too \(Changed since it was put off on \d{4}-\d\d-\d\d: actions resume, not-now → resume, drop, not-now, move\.\)$/.test(omega()['M-3']?.need ?? ''), true);
t('DS-401 AC1 a put-off from before entries recorded actions (KAN-1291) is listed again once, saying so',
  /\(Changed since it was put off on \d{4}-\d\d-\d\d: actions \(not recorded\) → resume, drop, not-now, move\.\)$/.test(omega()['M-2']?.need ?? ''), true);
t('DS-401 AC1 desk-q counts them as needing you', N.needsCount(loadRepos().find((r) => r.name === 'omega')).rows.some((x) => x.t.key === 'M-3'), true);
t('DS-401 AC4 a put-off written since with no actions stays put off in the list and in desk-q\'s count',
  `${'M-5' in omega()} ${N.needsCount(loadRepos().find((r) => r.name === 'omega')).rows.some((x) => x.t.key === 'M-5')}`, 'false false');
N.record({ word: 'omega', ticket: 'M-3', action: 'not-now' });
N.record({ word: 'omega', ticket: 'M-2', action: 'not-now' });
const m3Entry = NN.readRegister(omegaState).entries.get(NN.questionKey('this one too'));
t('DS-401 a park put off again records the actions it offers', m3Entry?.actions?.join(), 'resume,drop,not-now,move');
t('DS-401 the actions are no input: the pass and the digest read the park as put off', NN.lookup(NN.readRegister(omegaState), { question: 'this one too', inputs: {} }).status, 'put_off');
t('DS-401 AC4 with its question, inputs and actions unchanged, it stays put off, on this run and a later one',
  `${'M-3' in omega()} ${'M-2' in omega()} ${N.collect({ word: 'omega', repos: loadRepos(NOW + 86400000) }).items.some((i) => ['M-2', 'M-3'].includes(i.t.key))}`, 'false false false');
// A park put off straight through answer.mjs (the orchestrator, the digest) or not-now.mjs add records
// its item's actions too, so one it gains brings it back as M-3 came back.
const oq = queueOf('omega');
oq.tickets['M-6'] = { key: 'M-6', ...parked('A', 7, 'which copy for M-6?') };
oq.tickets['M-7'] = { key: 'M-7', ...parked('A', 6, 'which copy for M-7?') };
writeFileSync(omegaQ, JSON.stringify(oq));
const runIn = (script, ...args) => spawnSync(process.execPath, [join(REAL_BIN, script), ...args], { encoding: 'utf8', cwd: T, env: { ...process.env, DESK_AUTOPILOT_STATE: omegaState, DESK_QUEUE: omegaQ } });
const ans6 = runIn('answer.mjs', 'M-6', 'not now');
const entryOf = (q) => NN.readRegister(omegaState).entries.get(NN.questionKey(q));
t('DS-401 AC1 a park put off through answer.mjs records the actions it offers', `${ans6.status} ${entryOf('which copy for M-6?')?.actions?.join()}`, '0 resume,drop,not-now,move');
const add7 = runIn('not-now.mjs', 'add', 'M-7', 'which copy for M-7?');
t('DS-401 AC1 a park put off through not-now.mjs add records them too', `${add7.status} ${entryOf('which copy for M-7?')?.actions?.join()}`, '0 resume,drop,not-now,move');
t('DS-401 AC4 and both stay put off', `${'M-6' in omega()} ${'M-7' in omega()}`, 'false false');
NN.addPutOff(NN.putOffEntry({ question: 'this one too', ticket: 'M-3', inputs: {}, actions: ['resume', 'not-now'] }), omegaState);
runIn('not-now.mjs', 'add', 'M-3', 'some other question');
t('DS-401 a put-off of another question never stamps the item\'s own older entry, which still comes back', `${entryOf('this one too')?.actions?.join()} ${'M-3' in omega()}`, 'resume,not-now true');
// ---- DS-390: an approved force-push becomes a one-off grant on the ticket; a step no worker is ever
// allowed is a session item, never a requeue.
const grWt = join(T, 'grantee-wt');
spawnSync('git', ['init', '-q', '-b', 'main', grWt]);
spawnSync('git', ['-C', grWt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
const leaseSha = spawnSync('git', ['-C', grWt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
spawnSync('git', ['-C', grWt, 'update-ref', 'refs/remotes/origin/fix/GR-1', leaseSha]);
// KAN-636 round 6, in the shape it parked.
const KAN636 = 'Rebased onto origin/main to clear the conflict; the branch is already on origin, so it needs `git push --force-with-lease origin fix/GR-1`, which my settings deny (§3 git-force-with-lease is ask). Approve the force-push?';
const AWS = 'Reading the voicepa-ci account needs the aws CLI, which is refused by my worker settings. Can you read it?';
put('grantee', { port: 5300, beat: 1, supervised: true, tickets: {
  'GR-1': { ...parked('A', 30, KAN636), park: { ...parked('A', 30, KAN636).park, inputs: { lease: leaseSha } }, branch: 'fix/GR-1', worktree: grWt },
  'GR-2': { ...parked('A', 20, KAN636), park: { ...parked('A', 20, KAN636).park, inputs: { lease: leaseSha } }, branch: 'fix/GR-1', worktree: grWt },
  'GR-3': parked('B', 10, AWS),
} });
const BS = await import('../desk/bin/batch-state.mjs');
t('DS-390 the KAN-636 round 6 park names a force-push a grant covers', JSON.stringify(BS.refusedStep(KAN636)), '{"step":"force-push","grantable":true}');
t('DS-390 a park needing curl and aws ssm names a step no worker is allowed', BS.neverStep('needs curl + aws ssm to read the parameter'), 'aws');
t('DS-390 a park that only mentions aws in passing is not a session park', BS.neverStep('Should the copy say AWS or Amazon Web Services?'), null);
t('DS-390 approvals: a yes approves, a no, not or wait does not', ['Yes, force-push it', 'approved', 'no, merge instead', 'yes but wait for CI', 'Use the short copy'].map(BS.approves).join(), 'true,true,false,false,false');
t('DS-390 approvals: an answer that opens with a yes and asks for something else approves nothing',
  ['Sure, merge origin/main instead', 'OK, merge instead', 'Go with a merge instead.', 'Fine, use merge', 'Yes, read it yourself'].map(BS.approves).join(), 'false,false,false,false,false');
t('DS-390 approvals: a bare yes, with or without naming the push', ['ok', 'Yes.', 'Approved, go ahead!', 'yes please', 'Force-push it'].map(BS.approves).join(), 'true,true,true,true,true');
t('DS-390 a question that only says need near aws is not a session park', [BS.neverStep('Which AWS region does the new bucket need: eu-west-1 or eu-west-2?'), BS.neverStep('The env var needs reading from SSM in prod; what is the parameter name?')].join(), ',');
t('DS-390 a refused write under an absolute .claude/ path is a session park', [BS.neverStep('Writing /repo/.claude/desk-ticket-X.json was denied'), BS.neverStep('Writing ~/.claude/rules/x.md is refused')].join(), '.claude/ write,.claude/ write');
const gr1 = N.record({ word: 'grantee', ticket: 'GR-1', action: 'resume', text: 'Yes, force-push it' });
const grT1 = queueOf('grantee').tickets['GR-1'];
t('DS-390 AC1 an approving answer records a grant for that branch and lease SHA, and requeues it',
  `${gr1.ok} ${grT1.state} ${grT1.grant?.step} ${grT1.grant?.branch} ${grT1.grant?.lease === leaseSha}`, 'true triaged force-push fix/GR-1 true');
const grEnv = { ...process.env, DESK_AUTOPILOT_STATE: join(env.HOME, '.desk-autopilot', 'acme__grantee'), DESK_QUEUE: join(env.DESK_HOME, 'repos', 'acme__grantee', 'queue.json') };
const grLater = spawnSync(process.execPath, [join(REAL_BIN, 'answer.mjs'), 'GR-1', 'Sure, merge origin/main instead'], { encoding: 'utf8', env: grEnv });
t('DS-390 AC5 a later answer that approves nothing withdraws an earlier grant', `${grLater.status} ${queueOf('grantee').tickets['GR-1'].grant ?? null} ${/grant is withdrawn/.test(grLater.stdout)}`, '0 null true');
const gr2 = N.record({ word: 'grantee', ticket: 'GR-2', action: 'resume', text: 'Use the short copy instead' });
const grT2 = queueOf('grantee').tickets['GR-2'];
t('DS-390 AC5 an answer that approves nothing records no grant', `${gr2.ok} ${grT2.state} ${grT2.grant ?? null}`, 'true triaged null');
const grI3 = N.collect({ word: 'grantee' }).items.find((i) => i.t.key === 'GR-3');
t('DS-390 AC3 a park on a step no worker is allowed is a session item, offering open, done, drop and not-now, never resume',
  `${grI3?.kind} ${grI3?.actions.map((a) => a[0]).join()} ${/never allowed aws/.test(grI3?.actions[0][1] ?? '')}`, 'session open,done,drop,not-now true');
const gr3 = N.record({ word: 'grantee', ticket: 'GR-3', action: 'resume', text: 'Yes, read it yourself' });
t('DS-390 AC3 an answer approving it is not requeued to a worker', `${gr3.ok} ${queueOf('grantee').tickets['GR-3'].state} ${queueOf('grantee').tickets['GR-3'].grant ?? null}`, 'false parked null');
t('DS-390 AC3 open names the session and says why', /not requeued \(a step no worker is allowed\).*\/desk-ticket GR-3/.test(N.record({ word: 'grantee', ticket: 'GR-3', action: 'open' }).line), true);
const BSg = BS.grantFor({ t: { state: 'parked', branch: 'fix/GR-9', park: { question: KAN636, inputs: { lease: 'a'.repeat(40) } } }, text: 'ok' });
t('DS-390 a lease the park names wins over the worktree read', BSg.grant?.lease, 'a'.repeat(40));
t('DS-390 --approve grants with an answer that does not open with a yes', BS.grantFor({ t: { state: 'parked', branch: 'b', park: { question: KAN636, inputs: { lease: 'b'.repeat(40) } } }, text: 'Push it over abc', approve: true }).grant?.lease, 'b'.repeat(40));
t('DS-390 no lease named: no grant, saying why', /no lease SHA/.test(BS.grantFor({ t: { state: 'parked', branch: 'b', park: { question: KAN636 } }, text: 'yes' }).why), true);
// DS-496 AC2: only a grant whose park named the SHA lets a pass make the lease push unattended.
const a40 = 'a'.repeat(40), b40 = 'b'.repeat(40);
t('DS-496 a park naming the lease in its inputs gives a pinned grant', BSg.grant?.pinned, true);
t('DS-496 and one naming the exact push in its question',
  BS.grantFor({ t: { state: 'parked', branch: 'b', park: { question: `GitHub refused git push --force-with-lease=b:${b40} origin b, force-push refused` } }, text: 'yes' }).grant?.pinned, true);
t('DS-514 AC1 a yes to a park naming no SHA grants nothing, whatever origin holds', BS.grantFor({ t: { state: 'parked', branch: 'b', park: { question: KAN636 } }, text: 'yes' }).grant ?? null, null);
t('DS-514 a lease in the question for another branch is not named for this one', BS.namedLease({ question: `needs git push --force-with-lease=c:${b40} origin c` }, 'b'), null);
t('DS-514 AC3 asking for a force-push, from a refusal, a command or an approval',
  [KAN636, 'GitHub refused the force-push of feat/x with a 5xx', 'Needs `git push --force-with-lease origin b`.', 'May I force-push this branch?', 'Rebasing would also need a force-with-lease push, which config §3 git-force-with-lease does not grant', 'Should I force-push this branch?', 'Force-push feat/x?', 'Force-push of feat/x. Please approve.', 'Can I force-push without losing the remote changes?', 'Rebased instead of merging, so the branch needs a force-push. Approve?'].map(BS.asksForcePush).join(), Array(10).fill('true').join());
t('DS-514 AC3 a park that only mentions a force-push is not asking for one',
  ['should I merge rather than force-push?', 'Should I force-push or merge?', 'I merged instead of a force-push, since §3 git-force-with-lease is ask.', 'Needs a product call; git-force-with-lease is not yes.', 'Which copy?', 'force-push is not allowed, so I merged instead.', 'No force-push needed; which copy should the banner use?', 'My force-push was refused, so I merged the base in. Which copy?', 'The force-push was denied, so I merged origin/main. Which copy should the banner use?', 'Is a force-push needed or merge?'].map(BS.asksForcePush).join(), Array(10).fill('false').join());
t('DS-514 AC3 a yes to a park that only mentions a force-push grants nothing, even naming a SHA', BS.grantFor({ t: { state: 'parked', branch: 'b', park: { question: 'should I merge rather than force-push?', inputs: { lease: a40 } } }, text: 'yes' }).grant ?? null, null);
t('DS-514 a lease in the inputs that differs from the one the question names is no lease', BS.namedLease({ question: `needs git push --force-with-lease=b:${b40} origin b`, inputs: { lease: a40 } }, 'b'), null);
t('DS-514 a question naming two different leases for its branch is no lease; the same one twice is', [BS.namedLease({ question: `was --force-with-lease=b:${a40} now --force-with-lease=b:${b40}` }, 'b'), BS.namedLease({ question: `--force-with-lease=b:${a40} and --force-with-lease=b:${a40}` }, 'b')].join(), `,${a40}`);
t('DS-514 AC1 the refused worker is told why, the round after and no later',
  [BS.leaseRefusedBrief({ branch: 'b', lease_refused: { question: 'q1' }, prev_park: { question: 'q1' } })?.includes('--force-with-lease=b:<sha> origin b'), BS.leaseRefusedBrief({ branch: 'b', lease_refused: { question: 'q1' }, prev_park: { question: 'q2' } })].join(), 'true,');
t('DS-514 AC1 unnamedForcePush: asked with no SHA; not with one in inputs or question; not a mention',
  [BS.unnamedForcePush({ question: KAN636 }, 'b'), BS.unnamedForcePush({ question: KAN636, inputs: { lease: a40 } }, 'b'), BS.unnamedForcePush({ question: `${KAN636} --force-with-lease=b:${b40}` }, 'b'), BS.unnamedForcePush({ question: 'should I merge rather than force-push?' }, 'b')].join(), 'true,false,false,false');
const RA = await import('../desk/bin/recoveries.mjs');
t('DS-514 AC4 a pass answering with a recommended option approves nothing, even one that says yes', BS.grantFor({ t: { state: 'parked', branch: 'b', park: { question: KAN636, inputs: { lease: a40 } } }, text: RA.recommendedAnswer({ chose: 'yes', category: 'engineering' }) }).why, 'the answer approves nothing');
const unpinned = { step: 'force-push', branch: 'b', lease: b40 };
// DS-496 AC2: a lease park's clears-when names its SHA, which the pass keeps on its inputs, so its grant is pinned.
const leased = BS.withLeaseInput({ step: 'push' }, { kind: 'push-ok', branch: 'b', lease: a40 });
t('DS-496 withLeaseInput: a lease push condition adds its SHA to inputs naming none', JSON.stringify(leased), JSON.stringify({ step: 'push', lease: a40 }));
t('DS-496 withLeaseInput: the inputs\' own lease, a plain push, a short SHA and none are left as they are',
  [BS.withLeaseInput({ lease: b40 }, { kind: 'push-ok', branch: 'b', lease: a40 }).lease, JSON.stringify(BS.withLeaseInput({}, { kind: 'push-ok', branch: 'b' })),
    JSON.stringify(BS.withLeaseInput({}, { kind: 'push-ok', branch: 'b', lease: 'abc' })), JSON.stringify(BS.withLeaseInput(undefined, { kind: 'none' }))].join(' '), `${b40} {} {} {}`);
const leasedGrant = BS.grantFor({ t: { state: 'parked', branch: 'b', park: { question: KAN636, inputs: leased, clears_when: { kind: 'none' } } }, text: 'yes' }).grant;
t('DS-496 AC2 a yes to that park, its condition since cleared, is a pinned grant the pass may push',
  `${leasedGrant?.lease === a40} ${leasedGrant?.pinned} ${BS.passLeaseGrant(leasedGrant, { kind: 'push-ok', branch: 'b', lease: a40 })}`, 'true true true');
t('DS-496 passLeaseGrant: a pinned grant for that branch and SHA', BS.passLeaseGrant({ step: 'force-push', branch: 'b', lease: a40, pinned: true }, { kind: 'push-ok', branch: 'b', lease: a40 }), true);
t('DS-496 passLeaseGrant: not unpinned, another SHA or another branch',
  [BS.passLeaseGrant(unpinned, { branch: 'b', lease: b40 }), BS.passLeaseGrant({ step: 'force-push', branch: 'b', lease: a40, pinned: true }, { branch: 'b', lease: b40 }),
    BS.passLeaseGrant({ step: 'force-push', branch: 'b', lease: a40, pinned: true }, { branch: 'c', lease: a40 }), BS.passLeaseGrant(null, { branch: 'b', lease: a40 })].join(' '), 'false false false false');

// ---- DS-389 AC3: tickets parked on one §3 row the config lacks are one repo item; done requeues them once it is set
put('nu', { port: 5300, beat: 1, supervised: true, tickets: {
  'N-1': parked('A', 40, 'CONFIG_DENIED: worker-web-read (unset): the ticket needs the published rate; look it up for me'),
  'N-2': parked('A', 30, 'needs worker-web-read to read the vendor terms page'),
  'N-3': parked('A', 20, 'Which copy?'),
  'N-4': parked('A', 10, 'pr-ready is set, so this is an ordinary park'),
  'N-5': parked('A', 5, 'CONFIG_DENIED: ci-rerun (no): the row is TODO, which /desk-update cannot ask'),
} });
{ const c = join(env.DESK_CONFIG_ROOT, 'repos', 'acme__nu', 'config.md'); writeFileSync(c, readFileSync(c, 'utf8').replace(/(\| `pr-merge-green` [^\n]*\n)/, '$1| `ci-rerun` | Re-run CI | `yes` | TODO |\n')); }
const nu = () => N.collect({ word: 'nu' }).items;
t('DS-389 AC3 two parks on one unset row are one item for the repo; the others stay their own', nu().map((i) => `${i.t.key} ${i.kind}`).sort().join(), 'N-3 parked,N-4 parked,N-5 parked,unset:worker-web-read config');
const nuRow = nu().find((i) => i.kind === 'config');
t('DS-389 AC3 its need names the row and both tickets, and recommends done', `${nuRow?.need.startsWith("§3 worker-web-read is not set in nu's config, so desk reads it as no, and 2 tickets parked on it (N-1 and N-2). Answer it once with /desk-update in ")} ${nuRow?.actions.map((x) => x[0]).join()}`, 'true done,not-now');
t('DS-389 AC3 the list shows it as one line', here('list', 'nu').out.split('\n').filter((l) => l.startsWith('nu unset:worker-web-read config')).length, 1);
const stillUnset = N.record({ word: 'nu', ticket: 'unset:worker-web-read', action: 'done' });
t('DS-389 AC3 done while the row is still unset requeues nothing', `${stillUnset.ok} ${queueOf('nu').tickets['N-1'].state} ${/still not set/.test(stillUnset.line)}`, 'false parked true');
const nuConfig = join(env.DESK_CONFIG_ROOT, 'repos', 'acme__nu', 'config.md');
writeFileSync(nuConfig, readFileSync(nuConfig, 'utf8').replace(/(\| `pr-merge-green` [^\n]*\n)/, '$1| `worker-web-read` | Read the web | `ask` | `yes` |\n'));
const setNow = N.record({ word: 'nu', ticket: 'unset:worker-web-read', action: 'done' });
t('DS-389 AC3 once it is set, done requeues every ticket parked on it, and only those', `${setNow.ok} ${['N-1', 'N-2', 'N-3'].map((k) => queueOf('nu').tickets[k].state).join()}`, 'true triaged,triaged,parked');
t('DS-389 AC3 and the item leaves the list', nu().some((i) => i.kind === 'config'), false);

// ---- DS-389 AC7: committed copies of desk's templates the supervisor found behind are one repo item
const nuTemplates = join(env.HOME, '.desk-autopilot', 'acme__nu', 'templates.json');
writeFileSync(nuTemplates, JSON.stringify({ at: minsAgo(5), installed: null, ref: 'origin/main', root: join(T, 'repos', 'nu'), files: [
  { path: '.githooks/pre-push', status: 'CURRENT' },
  { path: 'scripts/desk/pre-push.sh', status: 'BEHIND', base: '4050984aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', base_date: '2026-10-17T10:00:00Z', since: minsAgo(50) },
  { path: '.github/workflows/desk-gate.yml', status: 'EDITED' },
] }));
const nuT = nu().filter((i) => i.kind === 'templates');
t('DS-389 AC7 one item for the repo, naming the behind file and the PR desk-update opens', `${nuT.length} ${nuT[0]?.t.key} ${nuT[0]?.need.startsWith("nu's committed scripts/desk/pre-push.sh is behind desk's template")} ${/opens one PR, off main, that applies the template's changes and keeps this repo's own edits/.test(nuT[0]?.need)}`, '1 templates true true');
t('DS-389 AC7 it has waited since the copy was first found behind', Math.round((NOW - nuT[0]?.since) / 60000), 50);
// done checks again, here with no committed copy left behind (the fixture repo has none): off the list.
const tDone = N.record({ word: 'nu', ticket: 'templates', action: 'done' });
t('DS-389 AC7 done checks the copies again, and clears once none is behind', `${tDone.ok} ${tDone.line} ${nu().some((i) => i.kind === 'templates')}`, 'true nu templates: no copy is behind on origin/main now, so it is off your list. false');

// ---- DS-577 AC8: the repo's failing reviewer check is one item, naming every PR the pass holds on it
const rvWhy = 'the review gate counts agent-pullbot; desk posts verdicts as bigbenjoman';
const gated = (pr) => redPr(pr, { gate_hold: { item: 'health:acme__rv:reviewer', head: `h${pr}`, why: rvWhy, at: minsAgo(30 + pr - 300) } });
put('rv', { port: 4302, beat: 1, supervised: true, gateReviewers: 'agent-pullbot', tickets: {
  'RV-1': gated(301), 'RV-2': gated(302), 'RV-3': gated(303), 'RV-4': gated(304), 'RV-5': gated(305),
  'RV-6': redPr(306),
  'RV-7': { ...gated(307), pr_status: { ...gated(307).pr_status, head: 'h307-moved' } },
} });
writeFileSync(join(env.HOME, '.desk-autopilot', 'acme__rv', 'health.json'), JSON.stringify({ at: minsAgo(2), results: {}, failing: [], streak: {},
  reviewer: { ok: false, kind: 'mismatch', gate: ['agent-pullbot'], login: 'bigbenjoman', why: rvWhy, fix: 'set §4 Review account to agent-pullbot with its gh config directory, or add bigbenjoman to the gate\'s reviewer list and to §4 Gate reviewers', told: true } }));
const rv = () => N.collect({ word: 'rv' }).items;
const rvItem = rv().find((i) => i.kind === 'reviewer');
t('DS-577 AC8 one item for the repo, and no per-PR item for the PRs it holds', rv().map((i) => `${i.t.key} ${i.kind}`).sort().join(), 'RV-6 pr,RV-7 pr,reviewer reviewer');
t('DS-577 AC8 its note names the five PRs it holds', rvItem?.note, 'Held on it: PR #301 (RV-1), PR #302 (RV-2), PR #303 (RV-3), PR #304 (RV-4) and PR #305 (RV-5).');
t('DS-577 AC8 its need names both logins and what it holds', `${rvItem?.need.includes(rvWhy)} ${/no PR red only on that gate gets a review or fix try; build workers still start$/.test(rvItem?.need)} ${rvItem?.actions.map((a) => a[0]).join()}`, 'true true done,not-now');
t('DS-577 AC8 desk-q counts it once, beside the PRs it does not hold', N.needsCount(N.collect({ word: 'rv' }).scope[0]).shown, 3);
t('DS-577 AC8 the list shows it as one line', here('list', 'rv').out.split('\n').filter((l) => l.startsWith('rv reviewer reviewer')).length, 1);
const rvDone = N.record({ word: 'rv', ticket: 'reviewer', action: 'done' });
t('DS-577 AC8 done records nothing and says the next pass checks again', `${rvDone.ok} ${/next pass checks the account again/.test(rvDone.line)}`, 'true true');
{
  const c = join(env.DESK_CONFIG_ROOT, 'repos', 'acme__rv', 'config.md');
  const was = readFileSync(c, 'utf8');
  writeFileSync(c, was.replace('| Gate reviewers | `agent-pullbot` |', '| Gate reviewers | `any` |'));
  t('DS-577 a failure recorded before Gate reviewers became any lists no item', rv().some((i) => i.kind === 'reviewer'), false);
  writeFileSync(c, was);
}
writeFileSync(join(env.HOME, '.desk-autopilot', 'acme__rv', 'health.json'), JSON.stringify({ at: minsAgo(2), results: {}, failing: [], streak: {}, reviewer: { ok: true, gate: ['agent-pullbot'], login: 'agent-pullbot' } }));
t('DS-577 AC4 a passing reviewer check lists no item', rv().some((i) => i.kind === 'reviewer'), false);

// ---- DS-675: the browser profile's login failing is one item for the machine, whatever waits on it
{
  const rvState = join(env.HOME, '.desk-autopilot', 'acme__rv');
  const { signinId } = await import('../desk/bin/health.mjs');
  const signinDir = join(env.HOME, '.desk-autopilot', 'health-browser-signin');
  const signinFile = join(signinDir, `${signinId('/p.github-session.json')}.json`);
  mkdirSync(signinDir, { recursive: true });
  const uq = join(env.DESK_HOME, 'upload-queue.json');
  const why = 'the GitHub login in /p.github-session.json expired at 2026-11-16T08:00:00.000Z';
  const stall = `health: browser profile failed: ${why} — fix: node ~/.claude/desk/bin/github-signin.mjs, in a terminal on this machine's screen; every repo's screenshot uploads with that login wait in the machine's upload queue until it passes, and new workers still start`;
  const { openQuestions } = await import('../desk/bin/digest.mjs');
  const rvBatch = () => N.collect({ word: 'rv' }).scope[0];
  const alphaBatch = () => N.collect({ word: 'alpha' }).scope[0];
  const [rvBefore, alphaBefore] = [N.needsCount(rvBatch()).shown, N.needsCount(alphaBatch()).shown];
  writeFileSync(signinFile, JSON.stringify({ at: minsAgo(20), why, state: rvState, slug: 'acme__rv', file: '/p.github-session.json' }));
  writeFileSync(uq, JSON.stringify({ jobs: [{ repo: 'acme/rv', pr: 301, key: 'RV-1', profile: '/p' }, { repo: 'acme/rv', pr: 302, key: 'RV-2' }, { repo: 'acme/alpha', pr: 9, key: 'A-9', profile: '/p' }, { repo: 'acme/beta', pr: 4, key: 'B-4', profile: '/own' }] }));
  writeFileSync(join(rvState, 'handed.json'), JSON.stringify({ 'wait-x': { id: 'wait-x', ticket: 'health', kind: 'batch', text: stall, why: 'a sign-in', at: minsAgo(20) } }));
  const items = N.collect().items.filter((i) => i.kind === 'browser-signin');
  t('DS-675 AC1 one sign-in item for every repo that waits on it', `${items.length} ${items[0]?.r.slug}`, '1 acme__rv');
  t('DS-675 AC1 it names the sign-in command and every upload waiting', `${items[0]?.need.endsWith('Sign it in, in a terminal on this machine\'s screen: node ~/.claude/desk/bin/github-signin.mjs')} ${items[0]?.note}`, 'true Waiting in the upload queue: acme/rv #301, acme/rv #302 and acme/alpha #9.');
  t('DS-675 AC1 desk-q counts it once, in the repo whose pass tells it', `${N.needsCount(rvBatch()).shown - rvBefore} ${N.needsCount(alphaBatch()).shown - alphaBefore}`, '1 0');
  t('DS-675 AC1 a repo named that does not tell it lists no sign-in item', N.collect({ word: 'alpha' }).items.some((i) => i.kind === 'browser-signin'), false);
  t('DS-675 AC1 the digest lists the handed sign-in item while it fails', openQuestions({ slug: 'acme__rv', state: rvState, queue: join(env.DESK_HOME, 'repos', 'acme__rv', 'queue.json') }).some((q) => q.text.startsWith(stall)), true);
  t('DS-675 an upload with another login is not named as waiting on it', items[0]?.note.includes('acme/beta'), false);
  t('DS-675 the item is keyed by its login', items[0]?.t.key, `browser-signin:${signinId('/p.github-session.json')}`);
  const done = N.record({ word: 'rv', ticket: items[0]?.t.key, action: 'done' });
  t('DS-675 done records nothing and says the next pass checks again', `${done.ok} ${/next pass checks the login again/.test(done.line)}`, 'true true');
  rmSync(signinFile);
  t('DS-675 AC2 signed in again, the item is gone from needs-you', `${N.collect().items.some((i) => i.kind === 'browser-signin')} ${N.needsCount(rvBatch()).shown - rvBefore}`, 'false 0');
  t('DS-675 AC2 and from the digest, though the slot that handed it has run no pass since', openQuestions({ slug: 'acme__rv', state: rvState, queue: join(env.DESK_HOME, 'repos', 'acme__rv', 'queue.json') }).some((q) => q.text.startsWith(stall)), false);
  rmSync(uq); rmSync(join(rvState, 'handed.json')); rmSync(signinDir, { recursive: true });
}

// ---- DS-790: GitHub's PR page changing pauses the upload queue: one desk item, not one per PR -------
{
  const uq = join(env.DESK_HOME, 'upload-queue.json');
  const rvBatch = () => N.collect({ word: 'rv' }).scope[0];
  const alphaBatch = () => N.collect({ word: 'alpha' }).scope[0];
  const [rvBefore, alphaBefore] = [N.needsCount(rvBatch()).shown, N.needsCount(alphaBatch()).shown];
  const why = "GitHub's PR page changed: no comment composer found by role, placeholder or legacy id";
  writeFileSync(uq, JSON.stringify({ jobs: [{ repo: 'acme/rv', pr: 301, key: 'RV-1' }, { repo: 'acme/alpha', pr: 9, key: 'A-9' }],
    page: { at: minsAgo(20), why, repo: 'acme/rv', pr: 301, install: '/desk/releases/aaa/bin' } }));
  const pageOf = (word) => N.collect({ word }).items.filter((i) => i.kind === 'upload-page');
  for (const word of ['rv', 'alpha']) {
    const items = pageOf(word);
    t(`DS-790 AC2 listing ${word}: one item saying the uploader is broken by a GitHub page change, naming how many PRs wait`,
      `${items.length} ${items[0]?.need.startsWith(`desk's screenshot uploader is broken by a GitHub page change (${why}), so no repo's screenshot upload runs and 2 PR(s) wait in draft`)}`, '1 true');  }
  const all = N.collect().items.filter((i) => i.kind === 'upload-page');
  t('DS-790 AC2 one item for the machine, in the repo whose upload found it, naming every upload waiting', `${all.length} ${all[0]?.r.slug} ${all[0]?.note}`, '1 acme__rv Waiting in the upload queue: acme/rv #301 and acme/alpha #9.');
  t('DS-790 AC2 desk-q counts it once, in that repo', `${N.needsCount(rvBatch()).shown - rvBefore} ${N.needsCount(alphaBatch()).shown - alphaBefore}`, '1 0');
  const done = N.record({ word: 'rv', ticket: 'upload-page', action: 'done' });
  t('DS-790 done records nothing and says an upload after desk is installed again clears it', `${done.ok} ${/once desk is installed again/.test(done.line)}`, 'true true');
  // Put off from the other repo, where it is listed in alpha's batch, it is put off for the machine.
  const off = N.record({ word: 'alpha', ticket: 'upload-page', action: 'not-now' });
  const offFile = join(env.DESK_HOME, 'not-now.jsonl');
  t('DS-790 put off from alpha, it is in the machine\'s register, and off both lists and rv\'s count', `${off.ok} ${off.line.endsWith(`put off (${offFile}).`)} ${pageOf('alpha').length} ${pageOf('rv').length} ${N.needsCount(rvBatch()).shown - rvBefore}`, 'true true 0 0 0');
  rmSync(offFile, { force: true });
  t('DS-790 its put-off cleared, it is listed again', pageOf('alpha').length, 1);
  // The queue holds the repo as the pass's origin spells it, which GitHub does not care about.
  writeFileSync(uq, JSON.stringify({ jobs: [{ repo: 'Acme/RV', pr: 301, key: 'RV-1' }],
    page: { at: minsAgo(20), why, repo: 'Acme/RV', pr: 301, install: '/desk/releases/aaa/bin' } }));
  const cased = N.collect().items.filter((i) => i.kind === 'upload-page');
  t('DS-790 a repo spelled in other case is still its repo: listed and counted there', `${cased.length} ${cased[0]?.r.slug} ${N.needsCount(rvBatch()).shown - rvBefore}`, '1 acme__rv 1');
  writeFileSync(uq, JSON.stringify({ jobs: [], page: null }));
  t('DS-790 AC4 the pause cleared, the item is gone', `${N.collect().items.some((i) => i.kind === 'upload-page')} ${N.needsCount(rvBatch()).shown - rvBefore}`, 'false 0');
  rmSync(uq);
}

// ---- DS-396: an idle batch the loaded supervisor runs is not stopped; one with no agent is
// Each last passed 20 minutes ago. omicron's supervisor has ticked idle since, refreshing its heartbeat as
// supervisor.mjs idleBeat does (test_supervisor.sh proves the tick writes it); pi's agent is not loaded.
put('omicron', { port: 3810, beat: 20, supervised: true, tickets: {
  'O-1': parked('A', 30, 'Which copy?'),
  'O-2': { ...parked('A', 30, 'Which colour?'), park: { question: 'Which colour?', since: minsAgo(30), answered: minsAgo(5) } },
} });
put('pi', { port: 3820, beat: 20, supervised: true, tickets: { 'P-1': parked('A', 30, 'Which size?') } });
writeFileSync(join(T, 'bin', 'loaded'), 'com.desk-skills.supervisor.acme__alpha\ncom.desk-skills.supervisor.acme__omicron\n');
writeFileSync(join(env.HOME, '.desk-autopilot', 'acme__omicron', 'orchestrators', 'q.json'), JSON.stringify({ queue: join(env.DESK_HOME, 'repos', 'acme__omicron', 'queue.json'),
  batch: 'omicron-batch', pid: 2, at: minsAgo(1), pass: minsAgo(20), next: new Date(NOW + 2 * 60000).toISOString() }));
const runOf = (word) => N.listText(N.collect({ word })).split('\n').find((l) => l.startsWith('@ '));
t('DS-396 AC1 an idle supervised batch says the supervisor runs it and an answer wakes it, not passes stopped',
  `${runOf('omicron')} ${/passes stopped/i.test(here('left', 'omicron').out)}`, '@ omicron: run by the supervisor; an answer wakes it, and its next pass picks the answer up false');
t('DS-396 AC3 a batch with no supervisor agent loaded and no pass for 20 minutes still says passes stopped',
  /^@ pi: passes stopped; answers wait until they resume\. To resume: /.test(runOf('pi') ?? ''), true);
t('DS-396 AC4 desk-q counts the idle supervised batch live, so its answered park waits rather than needing you',
  loadRepos().find((r) => r.name === 'omicron').rows.find((x) => x.t.key === 'O-2').k, 'waiting');
t('DS-396 desk-q dates the idle supervised batch by its last pass, not by the idle tick that refreshed its beat',
  `${(r => [r.live, r.last])(loadRepos().find((x) => x.name === 'omicron')).join(' ')}`, `true ${Date.parse(minsAgo(20))}`);

// ---- DS-399: a lane C or D session item whose step the person has done is handed back to a worker
// that starts at self-review. KAN-1280's shape: a lane D park with its worktree kept, ten held behind it.
const sgWt = join(T, 'sigma-wt');
spawnSync('git', ['init', '-q', '-b', 'fix/S-1', sgWt]);
spawnSync('git', ['-C', sgWt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
const LANE_D_PARK = 'lane D: the canvas-vs-build screenshots for PR #911 need an interactive session';
put('sigma', { port: 5400, beat: 1, supervised: true, tickets: {
  'S-1': { ...parked('D', 60, LANE_D_PARK), branch: 'fix/S-1', worktree: sgWt },
  'S-2': parked('C', 50, 'lane C: the plan needs agreeing'),
  'S-3': { state: 'parked', lane: 'A', held_by: 'S-1', added_at: minsAgo(40), park: { question: 'held by orchestrator: blocked by S-1 — starts once their PRs merge', since: minsAgo(40) } },
  'S-4': { ...parked('B', 30, AWS), branch: 'fix/S-1', worktree: sgWt },
  'S-5': { ...parked('C', 20, 'lane C: the plan needs agreeing'), branch: 'fix/S-1', worktree: sgWt },
} });
const sigmaState = join(env.HOME, '.desk-autopilot', 'acme__sigma');
const sigmaQ = () => readFileSync(join(env.DESK_HOME, 'repos', 'acme__sigma', 'queue.json'), 'utf8');
const sgItems = () => N.collect({ word: 'sigma' }).items;
const verbs = (k) => sgItems().find((i) => i.t.key === k)?.actions.map((a) => a[0]).join();
t('DS-399 AC1 a lane D session item with its worktree offers resume beside open and not-now', `${sgItems().find((i) => i.t.key === 'S-1')?.kind} ${verbs('S-1')}`, 'session open,resume,done,drop,not-now');
t('DS-399 AC1 the list line says what resume does', here('list', 'sigma').out.split('\n').some((l) => l.startsWith('sigma S-1 session') && l.includes('2. resume (once its step is done, resume "<what you did>" hands it back to a worker that starts at self-review)')), true);
t('DS-399 a lane C park no worker ever worked has no worktree to start in, so no resume', verbs('S-2'), 'open,done,drop,not-now');
t('DS-399 a park on a step no worker is allowed is not offered resume, worktree or not', verbs('S-4'), 'open,done,drop,not-now');
const sgBefore = sigmaQ();
const sgOpen = N.record({ word: 'sigma', ticket: 'S-1', action: 'open' });
t('DS-399 AC4 open still only names the session, and the queue is unchanged', `${sgOpen.ok} ${/\/desk-ticket S-1/.test(sgOpen.line)} ${sigmaQ() === sgBefore}`, 'true true true');
t('DS-399 resume with no note is refused', N.record({ word: 'sigma', ticket: 'S-1', action: 'resume' }).ok, false);
t('DS-399 resume on a session item with no worktree is refused, and it stays parked', `${N.record({ word: 'sigma', ticket: 'S-2', action: 'resume', text: 'done' }).ok} ${queueOf('sigma').tickets['S-2'].state}`, 'false parked');
const BSs = await import('../desk/bin/batch-state.mjs');
t('DS-399 AC3 before: the ticket held behind it waits on a park', JSON.stringify(BSs.waitingOnPark(queueOf('sigma'), queueOf('sigma').tickets['S-3'])), '["S-1"]');
const NOTE = 'screenshots captured and uploaded to PR #911, and 9 of the 11 diffs fixed';
const sgRes = N.record({ word: 'sigma', ticket: 'S-1', action: 'resume', text: NOTE });
const s1 = queueOf('sigma').tickets['S-1'];
t('DS-399 AC2 resume hands it back: requeued to start at Stage 4b in its worktree', `${sgRes.ok} ${s1.state} ${s1.handoff} ${s1.handoff_stage} ${s1.park} ${s1.worktree === sgWt}`, 'true triaged pending 4b null true');
t('DS-399 AC2 the line says it starts at self-review', /handed back to a worker that starts at self-review/.test(sgRes.line), true);
const H = await import('../desk/bin/handoff.mjs');
const sgHand = H.readHandoff(sigmaState, 'S-1');
t('DS-399 AC2 its handoff briefing reads, carrying the note', `${sgHand.ok} ${sgHand.data?.handedBack?.note === NOTE}`, 'true true');
const sgRendered = H.renderHandoff({ key: 'S-1', stage: '4b', data: sgHand.data, branch: 'fix/S-1', worktree: sgWt, base: 'origin/main', commits: [] });
t('DS-399 AC2 the session briefing starts at Stage 4b with what the person did', `${sgRendered.includes('starts at Stage 4b')} ${sgRendered.includes(`> ${NOTE}`)} ${sgRendered.includes('Self-review the branch as it stands')}`, 'true true true');
t('DS-399 AC2 the note is a binding answer in its briefing too', readFileSync(join(sigmaState, 'briefings', 'S-1.md'), 'utf8').includes(NOTE), true);
t('DS-399 AC3 after: the ticket held behind it no longer waits on a park, but on S-1 going on to merge', `${BSs.waitingOnPark(queueOf('sigma'), queueOf('sigma').tickets['S-3'])} ${BSs.waitingOnMerge(queueOf('sigma'), queueOf('sigma').tickets['S-3'])}`, 'null true');
t('DS-399 and it is off the list', sgItems().some((i) => i.t.key === 'S-1'), false);
const sgNever = spawnSync(process.execPath, [join(REAL_BIN, 'queue.mjs'), 'handback', 'S-4', 'done'], { env: { ...process.env, DESK_QUEUE: join(env.DESK_HOME, 'repos', 'acme__sigma', 'queue.json'), DESK_AUTOPILOT_STATE: sigmaState }, encoding: 'utf8' });
t('DS-399 queue.mjs handback itself refuses a park on a step no worker is allowed, and it stays parked', `${sgNever.status !== 0} ${/no worker is allowed/.test(sgNever.stderr)} ${queueOf('sigma').tickets['S-4'].state} ${queueOf('sigma').tickets['S-4'].handoff_stage ?? null}`, 'true true parked null');
const sgC = N.record({ word: 'sigma', ticket: 'S-5', action: 'resume', text: 'plan agreed with Ben' });
const s5 = queueOf('sigma').tickets['S-5'];
t('DS-399 a lane C ticket handed back goes on as lane B, so a later requeue or park treats it as a worker\'s', `${sgC.ok} ${s5.state} ${s5.lane} ${BSs.needsSession(s5)}`, 'true triaged B false');
t('DS-399 its handoff briefing still names the lane it was', H.readHandoff(sigmaState, 'S-5').data?.lane.startsWith('C, handed back'), true);

// ---- DS-566: approving a step a park says no worker can run makes a session item naming it, never a
// requeue; done on it sends the ticket back to a worker with the step recorded done. VPL-759's shape.
const VPL = 'Ben approved building the Grader image, but `ensure-grader-image.sh` is refused to this worker, and so are the staging deletes. Can you run it?';
const PROD = 'Ben approved the provisioning, but this worker cannot run it: it needs staging credentials no worker is given. Can you do it?';
put('stepper', { port: 5500, beat: 1, supervised: true, tickets: {
  'V-1': parked('A', 30, VPL),
  'V-2': parked('A', 30, 'Which copy for the banner?'),
  'V-3': parked('A', 30, PROD),
  'V-4': parked('A', 30, VPL),
} });
const D = await import('../desk/bin/decider.mjs');
const stQ = () => queueOf('stepper').tickets;
const stItem = (k) => N.collect({ word: 'stepper' }).items.find((i) => i.t.key === k);
t('DS-566 a park saying a named script is refused to its worker names that step', BS.workerRefusedStep(VPL), 'ensure-grader-image.sh');
t('DS-566 one with no code span names the refusing sentence', BS.workerRefusedStep(PROD), 'Ben approved the provisioning, but this worker cannot run it: it needs staging credentials no worker is given.');
t('DS-566 not one: a grantable force-push, a refused push or draft PR, a step no worker is ever allowed, a plain question',
  [KAN636, 'git push origin fix/x was refused (§3 git-push is ask); the PR body is above', 'Opening the draft PR was denied: `gh pr create --draft` is refused', AWS, 'Which copy?'].map(BS.workerRefusedStep).join('|'), '||||');
t('DS-566 approving a step: a yes, or a yes that holds nothing back',
  ['yes', 'Approved, go ahead and build it and delete the rows', 'ok do it', 'Yes, but only the image', 'No, skip the deletes', 'Sure, merge instead', 'Use the short copy'].map(BS.approvesStep).join(), 'true,true,true,false,false,false,false');
const st1 = N.record({ word: 'stepper', ticket: 'V-1', action: 'resume', text: 'Approved, go ahead and build it' });
const stV1 = stQ()['V-1'];
t('DS-566 AC1 approving the refused step is not requeued: it stays parked with the step recorded', `${st1.ok} ${stV1.state} ${stV1.park.session_step?.step}`, 'true parked ensure-grader-image.sh');
t('DS-566 AC1 the line says why and what comes next', /not requeued, because no worker can run the step you approved \(ensure-grader-image\.sh\).*say done/.test(st1.line), true);
const stI1 = stItem('V-1');
t('DS-566 AC1 it is a session item naming the approved step, offering open, done, answer, drop and not-now', `${stI1?.kind} | ${stI1?.need} | ${stI1?.actions.map((a) => a[0]).join()}`, 'session | you approved a step no worker can run: ensure-grader-image.sh | open,done,answer,drop,not-now');
t('DS-566 AC1 no worker is spawned: the pass and the decider take it for a session', `${BS.needsSession(stV1)} ${D.presort(D.deciderItems({ parked: [{ key: 'V-1', question: VPL }] }, queueOf('stepper'))).hand.length}`, 'true 1');
const stRq = spawnSync(process.execPath, [join(REAL_BIN, 'queue.mjs'), 'requeue', 'V-1'], { env: { ...process.env, DESK_QUEUE: join(env.DESK_HOME, 'repos', 'acme__stepper', 'queue.json'), DESK_AUTOPILOT_STATE: join(env.HOME, '.desk-autopilot', 'acme__stepper') }, encoding: 'utf8' });
t('DS-566 AC1 queue.mjs requeue itself refuses it, naming step-done', `${stRq.status !== 0} ${/queue\.mjs step-done V-1/.test(stRq.stderr)} ${stQ()['V-1'].state}`, 'true true parked');
t('DS-566 open names the session and says why', /not requeued \(a step you approved that no worker can run\).*\/desk-ticket V-1/.test(N.record({ word: 'stepper', ticket: 'V-1', action: 'open' }).line), true);
const st3 = N.record({ word: 'stepper', ticket: 'V-3', action: 'resume', text: 'yes' });
t('DS-566 AC1 a refused credential, approved, is a session item too', `${st3.ok} ${stQ()['V-3'].state} ${stItem('V-3')?.kind}`, 'true parked session');
const st3b = N.record({ word: 'stepper', ticket: 'V-3', action: 'answer', text: 'No, leave the provisioning to the next ticket' });
t('DS-566 answering such an item again with no approval makes it an ordinary park again', `${st3b.ok} ${stQ()['V-3'].state} ${stQ()['V-3'].park?.session_step ?? null} ${stItem('V-3')?.kind}`, 'true parked null parked');
const SEED = 'The worker was refused `scripts/seed-staging.sh`, a staging write. Shall I leave the seed out of this PR?';
t('DS-566 not one: a park offering to go on without the refused step', BS.workerRefusedStep(SEED), null);
t('DS-566 still one: a park that says "without" but offers no way round the step',
  BS.workerRefusedStep('`ensure-grader-image.sh` is refused to this worker, and the specs cannot pass without the image. Can you run it?'), 'ensure-grader-image.sh');
t('DS-566 still one: a park asking to continue once the person has run the step',
  ['Once you have built it, shall I continue?', 'Can we continue after you run it?', 'Shall I carry on when it is done?'].map((s) => BS.workerRefusedStep(`\`ensure-grader-image.sh\` is refused to this worker. ${s}`)).join(), 'ensure-grader-image.sh,ensure-grader-image.sh,ensure-grader-image.sh');
t('DS-566 not one: a park offering to carry on without the step', BS.workerRefusedStep('`ensure-grader-image.sh` is refused to this worker. Shall I carry on without it?'), null);
put('stepper2', { port: 5510, beat: 1, supervised: true, tickets: { 'V-5': parked('A', 30, SEED) } });
const st5 = N.record({ word: 'stepper2', ticket: 'V-5', action: 'resume', text: 'ok, leave it out' });
t('DS-566 AC2 a yes to leaving the refused step out is requeued as today', `${st5.ok} ${queueOf('stepper2').tickets['V-5'].state}`, 'true triaged');
const st2 = N.record({ word: 'stepper', ticket: 'V-2', action: 'resume', text: 'Use the short copy' });
t('DS-566 AC2 an ordinary park answered is requeued as today', `${st2.ok} ${stQ()['V-2'].state} ${stQ()['V-2'].park ?? null}`, 'true triaged null');
const st4 = N.record({ word: 'stepper', ticket: 'V-4', action: 'resume', text: 'No, skip the image and leave staging alone' });
t('DS-566 AC2 an answer that approves nothing on such a park is requeued as today', `${st4.ok} ${stQ()['V-4'].state}`, 'true triaged');
const stDone = N.record({ word: 'stepper', ticket: 'V-1', action: 'done' });
const stV1d = stQ()['V-1'];
t('DS-566 AC3 done sends it back to a worker', `${stDone.ok} ${stV1d.state} ${stV1d.park ?? null} ${stV1d.prev_park?.question === VPL}`, 'true triaged null true');
t('DS-566 AC3 with the step recorded done in its briefing', /The person ran the step you approved and no worker can run, and it is done: ensure-grader-image\.sh/.test(readFileSync(join(env.HOME, '.desk-autopilot', 'acme__stepper', 'briefings', 'V-1.md'), 'utf8')), true);
t('DS-566 AC3 and it is off the list', stItem('V-1') === undefined, true);

// ---- A supervised batch whose base sync waits on §3 batch-base-push `ask` is one item for the
// batch, and its approve records the approval on the queue the supervisor passes to each later pass.
put('rho2', { port: 3830, beat: 1, supervised: true, batch: { base: 'feat/x', base_push_ask: { since: minsAgo(40), base: 'feat/x', source: 'main' } },
  tickets: { 'R-1': { state: 'triaged', lane: 'A' } } });
const rho2 = () => N.collect({ word: 'rho2' }).items;
const bp = rho2();
t('DS-403 AC1 one base-push item for the batch, and no ticket is one', bp.map((i) => `${i.t.key} ${i.kind}`).join(), 'base-push base-push');
t('DS-403 AC1 its need names the base, the source and the row, and approve is recommended',
  `${bp[0]?.need} | ${bp[0]?.actions.map((a) => a[0]).join()} ${!!bp[0]?.actions[0][1]}`,
  'feat/x is behind main, and config §3 batch-base-push is "ask", so no pass merges main into it: approve it once for this batch | approve,not-now true');
put('rho964', { port: 3964, beat: 1, supervised: true, batch: { base: 'feat/x', base_push_ask: { since: minsAgo(40), base: 'feat/x', source: 'main', recreate: true } },
  tickets: { 'R-1': { state: 'triaged', lane: 'A' } } });
const bpGone = N.collect({ word: 'rho964' }).items[0];
t('a base-push item for a merged, deleted base asks to recreate it',
  `${bpGone?.need} | ${bpGone?.actions[0][1]}`,
  'feat/x is missing on origin (merged into main, then deleted), and config §3 batch-base-push is "ask", so no pass recreates it: approve it once for this batch | it is only code: the next pass pushes main\'s head back as feat/x, and every later sync in this batch runs without asking');
t('DS-403 AC1 it has waited since the pass first asked',Math.round((NOW - bp[0]?.since) / 60000), 40);
const rho2Count = () => N.needsCount(loadRepos().find((r) => r.name === 'rho2')).shown;
t('DS-403 AC1 desk-q counts it as needing you, since it never lifts by itself', rho2Count(), 1);
const bpOk = N.record({ word: 'rho2', ticket: 'base-push', action: 'approve' });
t('DS-403 AC2 approve records approved.base_push on the batch queue', `${bpOk.ok} ${queueOf('rho2').approved?.base_push}`, 'true true');
t('DS-403 AC3 with the approval recorded there is no item, and desk-q counts none', `${rho2().length} ${rho2Count()}`, '0 0');
put('rho2', { port: 3830, beat: 1, supervised: true, tickets: { 'R-1': { state: 'triaged', lane: 'A' } } });
t('DS-403 AC4 with no ask recorded there is no item', `${rho2().length} ${N.record({ word: 'rho2', ticket: 'base-push', action: 'approve' }).ok}`, '0 false');
// ---- DS-808: a base sync that merged but could not push, while the base lags too far for anything to
// spawn, is one item for the batch, listed first, naming the base, how many tickets it freezes and the command.
const CMD808 = 'git -C /wt/base-feat-x fetch -q origin && git -C /wt/base-feat-x merge --no-edit origin/main && git -C /wt/base-feat-x push origin HEAD:refs/heads/feat/x || git -C /wt/base-feat-x reset -q --hard origin/feat/x';
const stuck808 = { since: minsAgo(20), base: 'feat/x', source: 'main', behind: 61, frozen: 3, why: 'the push to feat/x was refused: ! [remote rejected] feat/x -> feat/x (protected branch hook declined)', path: '/wt/base-feat-x', cmd: CMD808 };
put('rho808', { port: 3832, beat: 1, supervised: true, batch: { base: 'feat/x', base_sync_stuck: stuck808 },
  tickets: { 'R-1': { state: 'triaged', lane: 'A' }, 'R-2': { state: 'parked', lane: 'A', park: { question: 'which plan?', since: minsAgo(90) } } } });
const bs = N.collect({ word: 'rho808' }).items;
t('DS-808 AC4 the base-sync item is first, ahead of an older park', bs.map((i) => `${i.t.key} ${i.kind}`).join(), 'base-sync base-sync,R-2 parked');
t('DS-808 AC4 it names the base, the tickets frozen and the one command that fixes it', bs[0]?.need,
  `the base sync of feat/x could not push, so 3 tickets ready to spawn are frozen until feat/x takes main: the push to feat/x was refused: ! [remote rejected] feat/x -> feat/x (protected branch hook declined). Run it by hand to see the hook's full output and push it: ${CMD808}`);
t('DS-808 AC4 its age is the freeze\'s', Math.round((NOW - bs[0]?.since) / 60000), 20);
t('DS-808 AC4 desk-q counts it', N.needsCount(loadRepos().find((r) => r.name === 'rho808')).shown, 2);
t('DS-808 done records nothing, and says the next pass reads the base again', N.record({ word: 'rho808', ticket: 'base-sync', action: 'done' }).line.includes('the next pass reads the base again'), true);
put('rho808', { port: 3832, beat: 1, supervised: true, batch: { base: 'feat/x' }, tickets: { 'R-1': { state: 'triaged', lane: 'A' } } });
t('DS-808 with no stuck sync recorded there is no item', N.collect({ word: 'rho808' }).items.length, 0);

// ---- DS-416: a child PR whose required check only the default branch's workflow runs on the base is
// no item of its own under ask: the base-push item says syncing the base starts its CI.
const behind416 = { [LINT]: 'has not reported because feat/x is behind main, whose copy of its workflow runs it on PRs into feat/x: syncing feat/x with main and reopening the PR starts it' };
const child416 = (pr) => ({ ...ready410(pr, null), pr_status: { ...ready410(pr, null).pr_status, base: 'feat/x', behind: behind416 } });
put('rho416', { port: 3831, beat: 1, supervised: true, required: [LINT], batch: { base: 'feat/x', base_push_ask: { since: minsAgo(40), base: 'feat/x', source: 'main' } },
  tickets: { 'V-1': child416(121), 'V-2': child416(122) } });
const bp416 = N.collect({ word: 'rho416' }).items;
t('DS-416 AC3 one base-push item and no pr item for the child PRs', bp416.map((i) => `${i.t.key} ${i.kind}`).join(), 'base-push base-push');
t('DS-416 AC3 its text says syncing the base starts CI on its child PRs', bp416[0]?.need,
  'feat/x is behind main, and config §3 batch-base-push is "ask", so no pass merges main into it: approve it once for this batch. Syncing feat/x starts CI on its child PRs PR #121 and PR #122, whose required checks only main\'s workflow runs on feat/x; the pass then reopens them.');

// ---- DS-407: the person's step is one item, naming every PR and ticket waiting to merge on it
const waitsOn = (pr) => ({ state: 'done', lane: 'A', result: { pr }, pr_status: { pr, state: 'OPEN', isDraft: false, checks: [] }, merge_after: 'OPS-9' });
put('kappa407', { port: 5407, beat: 1, supervised: true, tickets: { 'K-1': waitsOn(71), 'K-2': waitsOn(72), 'K-3': { state: 'running', lane: 'A', merge_after: 'OPS-9' } },
  triage: { 'K-1': { blockers: [{ key: 'OPS-9', category: 'new', type: 'Task', summary: 'Apply the billing migration' }] } } });
const kp = () => N.collect({ word: 'kappa407' }).items;
t('DS-407 AC2 one item for the step, and none for each PR waiting on it', kp().map((i) => `${i.t.key} ${i.kind}`).join(), 'step:OPS-9 step');
t('DS-407 AC2 it names the step and every PR and ticket waiting on it', kp()[0].need.startsWith('OPS-9 ("Apply the billing migration") is a step only you can take, and 3 tickets wait to merge on it: PR #71 (K-1), PR #72 (K-2) and K-3 (being built). Do it and move OPS-9 to Done in Jira'), true);
t('DS-407 its actions are done and not-now', kp()[0].actions.map((a) => a[0]).join(), 'done,not-now');
t('DS-407 the list prints it as a line of its batch', here('list', 'kappa407').out.split('\n').some((l) => l.startsWith('kappa407 step:OPS-9 step')), true);
const kpCount = () => N.needsCount(loadRepos().find((r) => r.name === 'kappa407'));
t('DS-407 desk-q counts the step as needing you, as the list shows it', `${kpCount().shown} ${kpCount().putOff}`, '1 0');
const kpDone = N.record({ word: 'kappa407', ticket: 'step:OPS-9', action: 'done' });
t('DS-407 done records nothing: the pass reads the step from Jira', `${kpDone.ok} ${/next pass that reads OPS-9 from Jira lifts the hold/.test(kpDone.line)}`, 'true true');
const kpOff = N.record({ word: 'kappa407', ticket: 'step:OPS-9', action: 'not-now' });
t('DS-407 not-now puts it off, in the list and in desk-q\'s count', `${kpOff.ok} ${kp().length} ${kpCount().shown} ${kpCount().putOff}`, 'true 0 0 1');
// DS-687: a blocker triage called needed only to merge is another ticket's code, not the person's step, so
// it is no item; a step triage also called merge still is one.
const gate687 = (k, b, needs = 'merge') => ({ blockers: [b], blocker_needs: { [b.key]: { needs, why: 'lands the flag it ships behind' } } });
put('kappa687', { port: 5687, beat: 1, supervised: true, tickets: { 'K-7': { ...waitsOn(77), merge_after: 'OUT-7' }, 'K-8': { ...waitsOn(78), merge_after: 'OPS-8' }, 'K-9': { ...waitsOn(79), merge_after: 'OPS-9' } },
  triage: { 'K-7': gate687('K-7', { key: 'OUT-7', category: 'new', type: 'Story', summary: 'Add the export endpoint' }),
    'K-8': gate687('K-8', { key: 'OPS-8', category: 'new', type: 'Task', summary: 'Apply the billing migration' }),
    'K-9': gate687('K-9', { key: 'OPS-9', category: 'new', type: 'Task', summary: 'Apply the search migration' }, 'build') } });
t('DS-687 a merge-only gate triage called is no step item; a step called merge or build still is', N.collect({ word: 'kappa687' }).items.filter((i) => i.kind === 'step').map((i) => i.t.key).sort().join(), 'step:OPS-8,step:OPS-9');
// A step two of the repo's batches wait on is still one item, naming the PRs in both.
const kfq = join(env.DESK_HOME, 'repos', 'acme__kappa407', 'batches', 'KF', 'queue.json');
const kfs = join(env.HOME, '.desk-autopilot', 'acme__kappa407', 'batches', 'KF');
mkdirSync(dirname(kfq), { recursive: true });
mkdirSync(join(kfs, 'orchestrators'), { recursive: true });
writeFileSync(kfq, JSON.stringify({ version: 1, batch: 'kf-batch', base: 'feat/k', concurrency: 1, supervised: true, tickets: { 'K-4': { key: 'K-4', added_at: minsAgo(600), ...waitsOn(74) } } }));
writeFileSync(join(kfs, 'orchestrators', 'q.json'), JSON.stringify({ queue: kfq, batch: 'kf-batch', pid: 1, at: minsAgo(1) }));
const { repoRow } = await import('../desk/bin/desk-q.mjs');
const kRow = () => repoRow(loadRepos().filter((r) => r.slug === 'acme__kappa407'));
const kAll = kp().filter((i) => i.kind === 'step');
t('DS-407 AC2 a step two batches wait on is one item, listing the PRs in both', `${kAll.length} ${kAll[0]?.t.key} ${/4 tickets wait to merge on it: PR #71 \(K-1\), PR #72 \(K-2\), K-3 \(being built\) and PR #74 \(K-4\)/.test(kAll[0]?.need)}`, '1 step:OPS-9 true');
t('DS-407 AC2 it is keyed in the standing batch', kAll[0]?.r.batch ?? null, null);
t('DS-407 AC2 desk-q counts it once for the repo, with its tickets now changed since the not-now', `${kRow().batches.length} ${N.needsCount(kRow()).shown}`, '2 1');
t('DS-407 AC2 the feature batch on its own lists the same one item', N.collect({ word: 'kappa407:KF' }).items.filter((i) => i.kind === 'step').map((i) => i.t.key).join(), 'step:OPS-9');
const kfOff = N.record({ word: 'kappa407:KF', ticket: 'step:OPS-9', action: 'not-now' });
const kfBatch = () => loadRepos().find((r) => r.slug === 'acme__kappa407' && r.batch != null);
const kfOnly = () => N.needsCount(repoRow([kfBatch()]));
t('DS-407 AC2 put off from the feature batch, it is put off in the standing batch\'s register', `${kfOff.ok} ${kfOff.line.includes(join('.desk-autopilot', 'acme__kappa407', 'not-now'))}`, 'true true');
t('DS-407 AC2 and every count reads it put off: the repo, the feature batch alone, and the list', `${N.needsCount(kRow()).shown} ${N.needsCount(kfBatch()).putOff} ${kfOnly().shown} ${kp().filter((i) => i.kind === 'step').length}`, '0 1 0 0');

// ---- DS-685: a step only the person takes that holds a ticket's build (held_outside) is a step item too
{
  const held = (by) => ({ state: 'parked', lane: 'A', held_by: by, held_outside: by, park: { question: `held by orchestrator: blocked by ${by}` } });
  const input = { key: 'OPS-7', category: 'new', type: 'Task', summary: 'Record the webhook payload', labels: ['ben-input'] };
  const code = { key: 'CODE-1', category: 'indeterminate', type: 'Story', summary: 'Build the gateway' };
  put('lambda685', { port: 5685, beat: 1, supervised: true, inputLabels: 'ben-input', tickets: { 'H-1': held('OPS-7'), 'H-3': held('CODE-1') },
    triage: { 'H-1': { blockers: [input] }, 'H-3': { blockers: [code] } } });
  const la = () => N.collect({ word: 'lambda685' }).items;
  t('DS-685 AC1 one step item for the input step holding a ticket\'s build, and none for the ticket itself', la().map((i) => `${i.t.key} ${i.kind}`).join(), 'step:OPS-7 step');
  t('DS-685 AC1 it names the ticket as waiting to start on it', la()[0]?.need,
    'OPS-7 ("Record the webhook payload") is a step only you can take, and one ticket waits to start on it: H-1. Do it and move OPS-7 to Done in Jira; the next pass that reads it lifts the hold, and H-1 can start');
  t('DS-685 AC3 a ticket held behind a code ticket in no batch gets no step item (nor any item: it waits on that ticket)', la().some((i) => /CODE-1|H-3/.test(`${i.t.key} ${i.need}`)), false);
  const laCount = () => N.needsCount(loadRepos().find((r) => r.name === 'lambda685'));
  t('DS-685 AC5 desk-q counts the step once, as needing you, and not the ticket waiting on it as a second', `${laCount().shown} ${laCount().rows.length}`, '1 0');
  // AC4: the triage record now reads the step Done, so it holds nothing as a step and leaves the list.
  writeFileSync(join(env.HOME, '.desk-autopilot', 'acme__lambda685', 'triage', 'H-1.json'), JSON.stringify({ ticket: 'H-1', epic: null, blockers: [{ ...input, category: 'done' }] }));
  t('DS-685 AC4 once the triage record reads the step Done, its item leaves needs-you', `${la().filter((i) => i.kind === 'step').length} ${laCount().shown}`, '0 0');
  // AC2: the same step also holds a second ticket's merge.
  put('nu685', { port: 5686, beat: 1, supervised: true, inputLabels: 'ben-input', tickets: { 'H-1': held('OPS-7'),
    'H-2': { state: 'done', lane: 'A', result: { pr: 91 }, pr_status: { pr: 91, state: 'OPEN', isDraft: false, checks: [] }, merge_after: 'OPS-7' } },
    triage: { 'H-1': { blockers: [input] }, 'H-2': { blockers: [input] } } });
  const nu = N.collect({ word: 'nu685' }).items;
  t('DS-685 AC2 one item for a step holding one ticket\'s build and another\'s merge', nu.map((i) => `${i.t.key} ${i.kind}`).join(), 'step:OPS-7 step');
  t('DS-685 AC2 it names one ticket waiting to start and the other waiting to merge', nu[0]?.need,
    'OPS-7 ("Record the webhook payload") is a step only you can take, and one ticket waits to start on it: H-1, and one waits to merge on it: PR #91 (H-2). Do it and move OPS-7 to Done in Jira; the next pass that reads it lifts the hold, and H-1 can start, and you merge them on GitHub');
  t('DS-685 AC2 its put-off inputs name both tickets waiting on it', nu[0]?.waiting.join(), 'H-1,H-2');
  // Held behind the step and behind a blocker that needs its own action, the ticket keeps its own item
  // for that blocker; released from the step by hand (held_outside left behind) and held again, the
  // step no longer holds it.
  put('mu685', { port: 5687, beat: 1, supervised: true, inputLabels: 'ben-input', tickets: {
    'B-9': { state: 'done', lane: 'A', result: {} },
    'H-4': { ...held('OPS-7'), held_by: 'OPS-7|B-9' },
    'H-5': { ...held('OPS-7'), held_by: 'B-9', park: { question: 'held by orchestrator: blocked by B-9' } } },
    triage: { 'H-4': { blockers: [input] }, 'H-5': { blockers: [input] } } });
  const mu = N.collect({ word: 'mu685' }).items;
  t('DS-685 a step never hides another blocker that needs you: the ticket keeps its own item for it', mu.some((i) => i.t.key === 'H-4' && /B-9 finished with no PR: let it start/.test(i.need)), true);
  t('DS-685 the step item names only the ticket its held_by still holds behind it', mu.find((i) => i.kind === 'step')?.waiting.join(), 'H-4');
  // The ticket the step holds is drawn with the step: under Needs you while the step needs the
  // person, and under Put off once the step is put off with not-now.
  put('xi685', { port: 5688, beat: 1, supervised: true, inputLabels: 'ben-input', tickets: { 'H-6': held('OPS-7') }, triage: { 'H-6': { blockers: [input] } } });
  const xi = () => loadRepos().find((r) => r.name === 'xi685');
  const xiGroup = () => { let g = null; for (const l of strip(repoScreen(xi())).split('\n')) { const h = l.match(/^ {2}(Needs you|Put off|Waiting|Ready|Running|Merging) · \d+$/); if (h) g = h[1]; else if (/^ +\S+ {2}H-6 /.test(l)) return g; } return null; };
  t('DS-685 AC5 the held ticket is a step row, drawn under Needs you', `${N.needsCount(xi()).stepRows.map((x) => x.t.key).join()} ${xiGroup()}`, 'H-6 Needs you');
  const xiOff = N.record({ word: 'xi685', ticket: 'step:OPS-7', action: 'not-now' });
  t('DS-685 AC5 the step put off, the ticket it holds is drawn under Put off and counted nowhere', `${xiOff.ok} ${N.needsCount(xi()).stepRows.length} ${N.needsCount(xi()).shown} ${N.needsCount(xi()).putOff} ${xiGroup()}`, 'true 0 0 1 Put off');
}

// The pass undrafted a PR on the desk-review a worker posted, so nothing is left for the person.
put('tau', { port: 4300, beat: 1, supervised: true, tickets: {
  'V-1': { ...landed(61), undraft: { call: 'ready', sha: 'a', pr: 61 } },
  'V-2': { ...landed(62), undraft: { call: 'person', why: 'no review stating "no findings" is posted on it', action: 'review #62', sha: 'a', pr: 62 } },
} });
t('DS-439 AC3 needs-you lists nothing for a PR the pass undrafted; negative control: one the pass left to the person is listed',
  N.collect({ word: 'tau' }).items.map((i) => i.t.key).join(), 'V-2');

// DS-509 AC5: a merged ticket's follow-on steps are the person's, listed once its PR has merged.
{
  const merged = (pr, more = {}) => ({ state: 'done', lane: 'A', result: { pr }, merged_at: minsAgo(5), pr_status: { pr, state: 'MERGED', merged_at: minsAgo(5) }, ...more });
  const STEP509 = { step: 'run provision-telnyx-assistant.ts --env staging', row: 'staging-write' };
  put('upsilon509', { port: 4400, beat: 1, supervised: true, merge: 'yes', tickets: {
    'F-1': merged(81, { follow_on: [STEP509] }),
    'F-2': merged(82, { follow_on: [STEP509], follow_on_done: minsAgo(1) }),
    'F-3': { state: 'done', lane: 'A', result: { pr: 83 }, follow_on: [STEP509] },
    'F-4': merged(84),
  } });
  const fi = () => N.collect({ word: 'upsilon509' }).items.filter((i) => i.kind === 'follow');
  const f1 = fi();
  t('DS-509 AC5 only the merged ticket with steps not yet run is listed', f1.map((i) => i.t.key).join(), 'follow:F-1');
  t('DS-509 AC5 DS-788 AC2 AC4 AC6 it says the code is on the default branch since the merge, and names the step and its §3 row and value once',
    `${/^F-1 is on main since \d{4}-\d\d-\d\d\. Check: run provision-telnyx-assistant\.ts --env staging \(§3 staging-write is "[a-z]+"\)\. Then say done\.$/.test(f1[0]?.need ?? '')} ${(f1[0]?.need ?? '').split('§3').length - 1}`, 'true 1');
  t('DS-509 AC5 desk-q counts it', N.needsCount(loadRepos().find((r) => r.slug === 'acme__upsilon509')).shown, 1);
  const done509 = N.record({ word: 'upsilon509', ticket: 'follow:F-1', action: 'done' });
  t('DS-509 AC5 done records it run and takes it off the list', `${done509.ok} ${typeof queueOf('upsilon509').tickets['F-1'].follow_on_done} ${fi().length}`, 'true string 0');
}

// Every item desk-q counts has a Queue row, even when every ticket is done.
{
  const merged = (pr, more = {}) => ({ state: 'done', lane: 'A', result: { pr }, merged_at: minsAgo(5), pr_status: { pr, state: 'MERGED', merged_at: minsAgo(5) }, ...more });
  put('phi934', { port: 4410, beat: 1, supervised: true, merge: 'yes', tickets: {
    'P-1': merged(71, { follow_on: [{ step: 'check the invoice totals look right', row: null }] }),
  } });
  const scr = () => strip(repoScreen(loadRepos().find((r) => r.slug === 'acme__phi934')));
  t('DS-934 every ticket done: the follow item is a Needs you row, the count matches it, and the Queue does not say there is nothing',
    `${N.needsCount(loadRepos().find((r) => r.slug === 'acme__phi934')).shown} ${/Needs you · 1\b/.test(scr())} ${/P-1 +◆ needs you +Check: check the invoice totals look right/.test(scr())} ${scr().includes('No unfinished tickets')}`, '1 true true false');
  N.record({ word: 'phi934', ticket: 'follow:P-1', action: 'not-now' });
  t('DS-934 put off, it is a grey Put off row, and the Queue still does not say there is nothing',
    `${/Put off · 1\b/.test(scr())} ${/P-1 +◇ put off/.test(scr())} ${/Needs you ·/.test(scr())} ${scr().includes('No unfinished tickets')}`, 'true true false false');
  // A batch's base-push item is the repo's, not a ticket's, and is a Needs you row all the same.
  put('chi934', { port: 4411, beat: 1, supervised: true, batch: { base: 'feat/x', base_push_ask: { since: minsAgo(40), base: 'feat/x', source: 'main' } },
    tickets: { 'C-1': { state: 'triaged', lane: 'A' } } });
  const bpScr = () => strip(repoScreen(loadRepos().find((r) => r.slug === 'acme__chi934')));
  t('DS-934 a base-push item is a Needs you row, matching the count',
    `${N.needsCount(loadRepos().find((r) => r.slug === 'acme__chi934')).shown} ${/Needs you · 1\b/.test(bpScr())} ${/base-push +◆ needs you +feat\/x is behind main/.test(bpScr())}`, '1 true true');
  N.record({ word: 'chi934', ticket: 'base-push', action: 'not-now' });
  t('DS-934 put off, the base-push item is a Put off row', `${/Put off · 1\b/.test(bpScr())} ${/base-push +◇ put off/.test(bpScr())} ${/Needs you ·/.test(bpScr())}`, 'true true false');
}

// DS-798: a follow step that only reads CI, desk's logs or desk's state is a follow-step checker's.
{
  const merged = (pr, mins, more = {}) => ({ state: 'done', lane: 'A', result: { pr }, merged_at: minsAgo(mins), pr_status: { pr, state: 'MERGED', merged_at: minsAgo(mins) }, ...more });
  const CI = { step: "on the merge commit's tests run on main, check the slowest shard takes about 300 s or less", row: null };
  const LOG = { step: 'read audit.jsonl for the worker cost', row: null };
  const failed = (pr, more = {}) => ({ ...CI, pr, result: 'fail', found: 'the slowest shard took 412 s', evidence: 'https://github.com/acme/x/actions/runs/9', at: minsAgo(1), ...more });
  const run = (mins) => ({ id: 'K-x', pid: 1, started: minsAgo(mins), out: '/x', steps: [CI] });
  put('follow798', { port: 4798, beat: 1, supervised: true, merge: 'yes', stepLabels: 'needs-ben', tickets: {
    'K-1': merged(91, 5, { follow_on: [CI] }),
    'K-2': merged(92, 5, { follow_on: [CI], follow_checks: [failed(92)] }),
    'K-3': merged(93, 5, { follow_on: [{ step: 'needs-ben: read audit.jsonl for the worker cost', row: null }] }),
    'K-4': merged(94, 5, { follow_on: [{ step: 'check the invoice totals look right', row: null }] }),
    'K-5': merged(95, 5, { follow_on: [CI], follow_checks: [failed(95, { result: 'pass' })] }),
    'K-6': merged(96, 300, { follow_on: [CI] }),
    'K-7': merged(97, 300, { follow_on: [CI], follow_run: run(1) }),
    'K-8': merged(98, 300, { follow_on: [CI], follow_run: run(60) }),
    'K-9': merged(99, 5, { follow_on: [CI], follow_checks: [failed(90, { result: 'pass' })] }),
    'K-10': merged(100, 5, { follow_on: [CI], follow_checks: [failed(100, { result: 'pending' })] }),
    'K-11': merged(101, 300, { follow_on: [CI], follow_checks: [failed(101, { result: 'pending', found: 'run 9 in progress' })] }),
    'K-12': merged(102, 5, { follow_on: [CI, { step: 'check the invoice totals look right', row: null }] }),
    'K-13': merged(103, 5, { follow_on: [CI, LOG], follow_checks: [failed(103), { ...LOG, pr: 103, result: 'pending', found: 'run 9 in progress', at: minsAgo(1) }] }),
    // A label added after the checker failed the step: it is the checker's still.
    'K-14': merged(104, 5, { follow_on: [{ step: 'needs-ben: read audit.jsonl for the worker cost', row: null }, { step: 'check the invoice totals look right', row: null }],
      follow_checks: [{ step: 'needs-ben: read audit.jsonl for the worker cost', row: null, pr: 104, result: 'fail', found: 'no cost line', evidence: '/x/audit.jsonl', at: minsAgo(1) }] }),
  } });
  const byKey = () => Object.fromEntries(N.collect({ word: 'follow798' }).items.filter((i) => i.kind === 'follow').map((i) => [i.t.key, i]));
  // A checker's step is an item of its own, keyed by the ticket and the step.
  const checked = (g, k) => Object.entries(g).filter(([key]) => key.startsWith(`follow:${k}:checked:`)).map(([, i]) => i);
  const g = byKey();
  t('DS-798 AC1 a step that only reads CI is not listed while a checker is still to run it, nor once one passed it, nor while one runs, nor while one found it pending',
    ['K-1', 'K-5', 'K-7', 'K-9', 'K-10'].filter((k) => `follow:${k}` in g || checked(g, k).length).join(), '');
  t('DS-798 once the wait is over, a run past its time or a step still pending is listed for the person',
    ['K-8', 'K-11'].map((k) => /No follow-step checker has passed or failed it yet\. Check: on the merge commit/.test(checked(g, k)[0]?.need ?? '')).join(), 'true,true');
  t('DS-798 AC2 a step a checker failed is one item naming the step, what it found and the run URL',
    `${checked(g, 'K-2').length} ${/Check: on the merge commit's tests run on main, check the slowest shard takes about 300 s or less\. A follow-step checker ran it and it failed: the slowest shard took 412 s \(evidence: https:\/\/github\.com\/acme\/x\/actions\/runs\/9\)\./.test(checked(g, 'K-2')[0]?.need ?? '')}`, '1 true');
  t('DS-798 AC2 a failed step is listed at once beside a step of the same ticket still pending',
    `${checked(g, 'K-13').map((i) => i.steps.map((s) => s.step).join()).join('|')} ${'follow:K-13' in g}`, `${CI.step} false`);
  t('DS-798 a step a checker failed stays its own item though a person-step label now names it',
    `${checked(g, 'K-14').length} ${JSON.stringify(g['follow:K-14']?.steps.map((s) => s.step))}`, '1 ["check the invoice totals look right"]');
  t('DS-798 AC3 a step carrying a person-step label is listed as today', /Check: needs-ben: read audit\.jsonl/.test(g['follow:K-3']?.need ?? ''), true);
  t('DS-798 AC4 a step the classifier cannot tell is runnable is listed as today', /Check: check the invoice totals look right\. Then say done\.$/.test(g['follow:K-4']?.need ?? ''), true);
  t('DS-798 a runnable step no checker ran once the wait is over is listed, saying so',
    /No follow-step checker has passed or failed it yet\. Check: on the merge commit/.test(checked(g, 'K-6')[0]?.need ?? ''), true);
  t('DS-798 a person\'s step is listed at once beside a checker\'s step still to run, which its item does not hold',
    `${checked(g, 'K-12').length} ${/Check: check the invoice totals look right\. Then say done\.$/.test(g['follow:K-12']?.need ?? '')} ${JSON.stringify(g['follow:K-12']?.steps.map((s) => s.step))}`,
    '0 true ["check the invoice totals look right"]');
  // The checker fails the step once the person was shown the item: done on it settles only the step it showed.
  const q798 = queueOf('follow798');
  q798.tickets['K-12'].follow_checks = [failed(102)];
  writeFileSync(join(env.DESK_HOME, 'repos', 'acme__follow798', 'queue.json'), JSON.stringify(q798));
  const g12 = byKey();
  t('DS-798 a step a checker failed after the person\'s item was shown is an item of its own',
    `${JSON.stringify(g12['follow:K-12']?.steps.map((s) => s.step))} ${/it failed: the slowest shard took 412 s/.test(checked(g12, 'K-12')[0]?.need ?? '')}`, '["check the invoice totals look right"] true');
  const done12 = N.record({ word: 'follow798', ticket: 'follow:K-12', action: 'done' });
  t('DS-798 so done on the person\'s item leaves the failed step listed',
    `${done12.ok} ${JSON.stringify(queueOf('follow798').tickets['K-12'].follow_on.map((s) => s.step))} ${'follow:K-12' in byKey()} ${checked(byKey(), 'K-12').length}`,
    `true ${JSON.stringify([CI.step])} false 1`);
  const k2 = Object.keys(g).find((k) => k.startsWith('follow:K-2:checked:'));
  const done = N.record({ word: 'follow798', ticket: k2, action: 'done' });
  t('DS-798 AC2 done on the failed step settles it', `${done.ok} ${typeof queueOf('follow798').tickets['K-2'].follow_on_done} ${k2 in byKey()}`, 'true string false');
}

// A follow step's gate: `main` waits on the merge commit reaching origin/<default>, `production` on it
// reaching config §4 Promotion ref. Each repo root holds a real origin/main and origin/production.
{
  const git = (root, ...a) => spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).stdout.trim();
  // The repo root with a deployed commit and, on top, PR #95's merge commit: origin/main at the merge,
  // origin/production at the deployed commit, and a merge commit no remote ref reaches.
  const commits = (name) => {
    const root = join(T, 'repos', name);
    git(root, 'commit', '-q', '--allow-empty', '-m', 'deployed');
    const deployed = git(root, 'rev-parse', 'HEAD');
    git(root, 'commit', '-q', '--allow-empty', '-m', 'Merge pull request #95 from acme/x');
    const merge = git(root, 'rev-parse', 'HEAD');
    git(root, 'commit', '-q', '--allow-empty', '-m', 'Merge pull request #96 from acme/y');
    const unpushed = git(root, 'rev-parse', 'HEAD');
    git(root, 'update-ref', 'refs/remotes/origin/main', merge);
    git(root, 'update-ref', 'refs/remotes/origin/production', deployed);
    return { root, merge, unpushed };
  };
  const merged = (pr, sha, follow_on) => ({ state: 'done', lane: 'A', result: { pr }, merged_at: minsAgo(5), pr_status: { pr, state: 'MERGED', merged_at: minsAgo(5), merge_commit: sha }, follow_on });
  const PROD = { step: 'open Osteopaths in the production portal', row: null, after: 'production' };
  const STAGING = { step: 'place a test call on staging', row: null, after: 'main' };
  const PLAIN = { step: 'start the staging crons', row: null };
  const cfg = { port: 4785, beat: 1, supervised: true, merge: 'yes', promotionRef: 'origin/production' };
  put('prod785', { ...cfg, tickets: {} });
  const c = commits('prod785');
  put('prod785', { ...cfg, tickets: {
    'G-1': merged(95, c.merge, [PROD, STAGING, PLAIN]),
    'G-2': merged(95, c.merge, [PROD]),
    'G-3': merged(96, c.unpushed, [STAGING]),
  } });
  // The gates are read from those refs with real git, the one real read these collects are given.
  const fi = (word) => N.collect({ word, reads: { ...STUB, git: N.READS.git } }).items.filter((i) => i.kind === 'follow');
  const byKey = (word) => Object.fromEntries(fi(word).map((i) => [i.t.key, i]));
  let g = byKey('prod785');
  t('DS-785 AC3 a production step whose merge is on main but not on the production ref is not listed; the merge and main steps are, one item per gate',
    Object.keys(g).join(), 'follow:G-1,follow:G-1:main');
  t('DS-785 AC3 the merge item names its merge step, and the main item its main step, neither the production one',
    / Check: start the staging crons\./.test(g['follow:G-1']?.need ?? '') && /^G-1 is on main since \d{4}-\d\d-\d\d\. Check: place a test call on staging\. Then say done\.$/.test(g['follow:G-1:main']?.need ?? '') && !/Osteopaths/.test(`${g['follow:G-1']?.need}${g['follow:G-1:main']?.need}`), true);
  t('DS-785 AC3 it says the production step waits until production runs the merge',
    (g['follow:G-1']?.need ?? '').endsWith('Check: start the staging crons. Another step waits until production runs its merge, and is listed then. Then say done.'), true);
  t('#808 the done action names the merged PR, whose checks a session reads before asking (references/follow.md)',
    g['follow:G-1']?.actions.find(([a]) => a === 'done')?.[1].includes("PR #95's own checks"), true);
  t('DS-788 AC3 a step with no §3 row says nothing about a §3 row', /§3/.test(`${g['follow:G-1']?.need}${g['follow:G-1:main']?.need}`), false);
  t('DS-785 negative: a main step whose merge commit origin/main does not reach is not listed', 'follow:G-3:main' in g, false);
  const gateDirs = new Set();
  N.collect({ word: 'prod785', reads: { ...STUB, git: (dir) => { gateDirs.add(dir); return null; } } });
  t('DS-929 AC1 a collect reads the gates through the git read it is given, in the repo root', [...gateDirs].join(), c.root);
  t('DS-785 desk-q counts only the listed items', N.needsCount(loadRepos().find((r) => r.slug === 'acme__prod785')).shown, 2);
  const done785 = N.record({ word: 'prod785', ticket: 'follow:G-1', action: 'done' });
  const g1 = queueOf('prod785').tickets['G-1'];
  t('DS-785 done on the merge item records its step run and keeps the main and production ones',
    `${done785.ok} ${g1.follow_on_done ?? 'unset'} ${JSON.stringify(g1.follow_on)} ${Object.keys(byKey('prod785')).join()}`, `true unset ${JSON.stringify([PROD, STAGING])} follow:G-1:main`);
  // Production moves after the main item was listed: done on that item records only the step it showed.
  git(c.root, 'update-ref', 'refs/remotes/origin/production', c.merge);
  const doneMain = N.record({ word: 'prod785', ticket: 'follow:G-1:main', action: 'done' });
  t('DS-785 done on the main item, once production has moved, keeps the production step it never showed',
    `${doneMain.ok} ${queueOf('prod785').tickets['G-1'].follow_on_done ?? 'unset'} ${JSON.stringify(queueOf('prod785').tickets['G-1'].follow_on)}`, `true unset ${JSON.stringify([PROD])}`);
  g = byKey('prod785');
  t('DS-785 AC4 once the production ref reaches the merge commit, the production steps are listed', Object.keys(g).sort().join(), 'follow:G-1:production,follow:G-2:production');
  t('DS-785 AC4 DS-788 the listed production step says nothing about an unchecked gate, nor a date production fast-forwarded on, which git does not keep',
    /^G-2 is on production\. Check: open Osteopaths in the production portal\. Then say done\.$/.test(g['follow:G-2:production']?.need ?? ''), true);
  const doneProd = N.record({ word: 'prod785', ticket: 'follow:G-1:production', action: 'done' });
  t('DS-785 done on the last step records the ticket\'s follow-on run', `${doneProd.ok} ${typeof queueOf('prod785').tickets['G-1'].follow_on_done}`, 'true string');

  // AC5: no Promotion ref, so production is judged by the default branch and says it was not checked.
  const unset = { port: 4786, beat: 1, supervised: true, merge: 'yes' };
  put('noprod785', { ...unset, tickets: {} });
  const u = commits('noprod785');
  put('noprod785', { ...unset, tickets: { 'H-1': merged(95, u.merge, [PROD]), 'H-2': merged(96, u.unpushed, [PROD]) } });
  const h = byKey('noprod785');
  t('DS-785 AC5 with the Promotion ref row unset, a production step on the default branch is listed, and one not on it is not', Object.keys(h).join(), 'follow:H-1:production');
  t('DS-785 AC5 the item says production could not be checked because the row is unset, and claims only the default branch',
    /^H-1 is on main since \d{4}-\d\d-\d\d\. Production could not be checked: config §4 "Promotion ref" is unset\. Check: open Osteopaths in the production portal\. Then say done\.$/.test(h['follow:H-1:production']?.need ?? ''), true);

  // A merge commit not read yet waits, never listed early: none recorded (the pass reads the PR again for
  // it), or one the repo root has not fetched (the pass fetches origin while a gated step waits).
  put('nosha785', { ...cfg, port: 4787, tickets: {} });
  commits('nosha785');
  put('nosha785', { ...cfg, port: 4787, tickets: { 'J-1': merged(97, null, [PROD, STAGING]), 'J-2': merged(98, 'f'.repeat(40), [PROD, STAGING]) } });
  t('DS-785 a gated step whose merge commit is not recorded, or not fetched, waits', Object.keys(byKey('nosha785')).join(), '');

  // A feature batch child promoted by a squash: its own merge commit is on no remote ref, so its main
  // gate is the promotion and production is judged by the default branch's commit from the promotion.
  const feat = { ...cfg, port: 4788 };
  put('feat785', { ...feat, tickets: {} });
  const f = commits('feat785');
  const promoted = { batch: { base: 'feat/VPL-842', feature: true, epic: 'VPL-842', promotion: { pr: 1002, merged_at: new Date().toISOString() } } };
  // origin/production already has origin/main's head, but not the promotion, which origin/main lacks too.
  git(f.root, 'update-ref', 'refs/remotes/origin/production', f.merge);
  put('feat785', { ...feat, tickets: { 'K-1': merged(97, f.unpushed, [PROD, STAGING]) }, ...promoted });
  t('DS-785 a squash-promoted child lists its main step and holds its production step while the promotion is not on the default branch it read',
    Object.keys(byKey('feat785')).join(), 'follow:K-1:main');
  // The promotion squashed: its commit sits on origin/main's head, without the child's own merge commit.
  const promo = git(f.root, 'commit-tree', `${f.merge}^{tree}`, '-p', f.merge, '-m', 'Merge pull request #1002 from acme/feat/VPL-842');
  git(f.root, 'update-ref', 'refs/remotes/origin/main', promo);
  t('DS-785 and while production does not have the promotion', Object.keys(byKey('feat785')).join(), 'follow:K-1:main');
  git(f.root, 'update-ref', 'refs/remotes/origin/production', promo);
  t('DS-785 and lists its production step once production has the promotion PR\'s commit, saying nothing unchecked',
    `${Object.keys(byKey('feat785')).join()} ${/^K-1 is on production\. Check: open Osteopaths in the production portal\. Then say done\.$/.test(byKey('feat785')['follow:K-1:production']?.need ?? '')}`, 'follow:K-1:main,follow:K-1:production true');

  // A promotion rebase-merged: its commit names no PR, and the child's own merge commit is rewritten, so
  // production is judged by the promotion's merge commit as recorded, which list's refresh reads.
  const reb = { ...cfg, port: 4792 };
  put('reb785', { ...reb, tickets: {} });
  const rb = commits('reb785');
  const rebased = git(rb.root, 'commit-tree', `${rb.merge}^{tree}`, '-p', rb.merge, '-m', 'VPL-842: add the portal page');
  git(rb.root, 'update-ref', 'refs/remotes/origin/main', rebased);
  git(rb.root, 'update-ref', 'refs/remotes/origin/production', rebased);
  const rebBatch = (merge_commit) => ({ batch: { base: 'feat/VPL-842', feature: true, epic: 'VPL-842', promotion: { pr: 1003, merged_at: new Date(Date.now() + 1000).toISOString(), ...(merge_commit ? { merge_commit } : {}) } } });
  put('reb785', { ...reb, tickets: { 'R-1': merged(97, rb.unpushed, [PROD]) }, ...rebBatch(null) });
  t('DS-785 fix try: a rebase-promoted child with no promotion merge commit recorded waits', Object.keys(byKey('reb785')).join(), '');
  const promoReads = [];
  N.refresh({ word: 'reb785', reads: { ...STUB, fetch: () => true, pr: (r, pr, more) => { promoReads.push(`${pr}${more}`); return { v: pr === 1003 && more === ',mergeCommit' ? { mergeCommit: { oid: rebased } } : null, err: '' }; } } });
  t('DS-785 fix try: list\'s refresh reads the promotion PR\'s merge commit and records it, and the production step is listed unqualified',
    `${promoReads.includes('1003,mergeCommit')} ${queueOf('reb785').promotion_commits?.['1003'] === rebased} ${Object.keys(byKey('reb785')).join()} ${/^R-1 is on production\. Check: open Osteopaths in the production portal\. Then say done\.$/.test(byKey('reb785')['follow:R-1:production']?.need ?? '')}`,
    'true true follow:R-1:production true');
  git(rb.root, 'update-ref', 'refs/remotes/origin/production', rb.merge);
  put('reb785', { ...reb, tickets: { 'R-1': merged(97, rb.unpushed, [PROD]) }, ...rebBatch(rebased) });
  t('DS-785 fix try negative: with the recorded promotion commit not on production, the step waits', Object.keys(byKey('reb785')).join(), '');

  // The same words under two gates are two steps: done on one keeps the other.
  put('dup785', { ...cfg, port: 4789, tickets: {} });
  const d = commits('dup785');
  const twice = [{ step: 'check the portal', row: null, after: 'main' }, { step: 'check the portal', row: null, after: 'production' }];
  put('dup785', { ...cfg, port: 4789, tickets: { 'L-1': merged(95, d.merge, twice) } });
  const doneDup = N.record({ word: 'dup785', ticket: 'follow:L-1:main', action: 'done' });
  t('DS-785 done on a main step keeps a production step worded the same', `${doneDup.ok} ${JSON.stringify(queueOf('dup785').tickets['L-1'].follow_on)}`, `true ${JSON.stringify([twice[1]])}`);

  // Criteria its review left for after the merge that the pass has not made steps yet hold the item
  // off the list, so they never join it after the person saw it.
  const owed = (read) => ({ ...merged(95, d.merge, [PLAIN]), pr_status: { pr: 95, state: 'MERGED', merged_at: minsAgo(5), merge_commit: d.merge, post_merge: [{ step: 'x', needs: 'device' }] }, ...(read ? { post_merge_read: 95 } : {}) });
  put('owe785', { ...cfg, port: 4790, tickets: { 'M-1': owed(false), 'M-2': owed(true) } });
  t('DS-785 a merged PR still owed its review\'s post-merge steps is not listed until the pass adds them', Object.keys(byKey('owe785')).join(), 'follow:M-2');

  // list's refresh fetches origin once in the repo root and reads a merge commit no record has, so an
  // idle batch, which runs no pass, still moves its gated steps on.
  put('idle785', { ...cfg, port: 4791, tickets: {} });
  const i7 = commits('idle785');
  put('idle785', { ...cfg, port: 4791, tickets: { 'N-1': merged(97, null, [STAGING]), 'N-2': merged(98, i7.merge, [PROD]) } });
  const fetches = [];
  N.refresh({ word: 'idle785', reads: { ...STUB, fetch: (dir) => { fetches.push(dir); return true; }, pr: (r, pr, more) => ({ v: pr === 97 && more === ',mergeCommit' ? { mergeCommit: { oid: i7.merge } } : null, err: '' }) } });
  t('DS-785 list\'s refresh fetches the repo root once and records the merge commit no record had',
    `${fetches.length} ${queueOf('idle785').tickets['N-1'].pr_status?.merge_commit === i7.merge} ${Object.keys(byKey('idle785')).join()}`, '1 true follow:N-1:main');

  // The date a follow item gives is when production first had the merge: the production line's merge of
  // it, dated 2026-11-03, not the PR's merge on main two days before.
  put('dated788', { ...cfg, port: 4793, tickets: {} });
  const root788 = join(T, 'repos', 'dated788');
  const dated = (when, ...a) => spawnSync('git', ['-C', root788, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a],
    { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } }).stdout.trim();
  dated('2026-10-30T12:00:00Z', 'commit', '-q', '--allow-empty', '-m', 'deployed');
  const base788 = git(root788, 'rev-parse', 'HEAD');
  dated('2026-11-01T12:00:00Z', 'commit', '-q', '--allow-empty', '-m', 'Merge pull request #95 from acme/x');
  const merge788 = git(root788, 'rev-parse', 'HEAD');
  const prod788 = dated('2026-11-03T12:00:00Z', 'commit-tree', `${merge788}^{tree}`, '-p', base788, '-p', merge788, '-m', 'release');
  git(root788, 'update-ref', 'refs/remotes/origin/main', merge788);
  git(root788, 'update-ref', 'refs/remotes/origin/production', prod788);
  const LEGACY = { step: 'Check after the merge: Verification: manual production run (needs production): open the relay log', row: null, after: 'production' };
  put('dated788', { ...cfg, port: 4793, tickets: { 'Q-1': merged(95, merge788, [PROD, LEGACY]) } });
  t('DS-788 AC1 a production item opens with the day production first had the merge, one Check per step, an older review prefix dropped',
    byKey('dated788')['follow:Q-1:production']?.need,
    'Q-1 is on production since 2026-11-03. Check: open Osteopaths in the production portal. Check: open the relay log. Then say done.');
  // A step's own closing period gives way to the line's, but a command's last `.` is kept.
  const DOTS = [{ step: 'open the relay log.', row: null }, { step: 'run git add .', row: null }];
  put('dated788', { ...cfg, port: 4793, tickets: { 'Q-2': merged(95, merge788, DOTS) } });
  t('DS-788 a step ending a sentence gets one period, and one ending in a command keeps its dot',
    byKey('dated788')['follow:Q-2']?.need?.replace(/^.*?\. Check/, 'Check'), 'Check: open the relay log. Check: run git add . Then say done.');
}

// A feature batch's promotion PR still red once its check tries are spent (pass.mjs
// promotion.red) is one pr item naming the children whose follow items wait on it. DS-784 holds those
// follow items off the list until the promotion merges, so nothing waiting on it is listed above it.
{
  const merged = (pr, more = {}) => ({ state: 'done', lane: 'A', result: { pr }, merged_at: minsAgo(900), pr_status: { pr, state: 'MERGED', merged_at: minsAgo(900) }, ...more });
  const STEP786 = { step: 'build the Flows image', row: 'staging-write' };
  const red = { pr: 1001, head: 'e'.repeat(40), checks: ['flows-image', 'portal (1/3)'], tried: 2, since: minsAgo(30),
    why: `still failing flows-image, portal (1/3) at ${'e'.repeat(12)} after 2 check tries; the last try parked: the Flows image is missing` };
  const batch = (promotion) => ({ batch: { base: 'feat/VPL-842', feature: true, epic: 'VPL-842', promotion } });
  const kids = { 'P-1': merged(91, { follow_on: [STEP786] }), 'P-2': merged(92, { follow_on: [STEP786] }) };
  put('chi786', { port: 4796, beat: 1, supervised: true, tickets: kids, ...batch({ pr: 1001, red }) });
  const items = () => N.collect({ word: 'chi786' }).items;
  const ci = items();
  const pi = ci.find((i) => i.t.key === 'promotion:1001');
  t('DS-786 AC2 a promotion PR red once its tries are spent is listed as a pr item', pi?.kind, 'pr');
  t('DS-786 AC2 it names the failing checks and what desk tried',
    /^promotion PR #1001 \(feat\/VPL-842 into the default branch\) is red, failing flows-image and portal \(1\/3\); it is still failing flows-image, portal \(1\/3\) after 2 check tries; the last try parked: the Flows image is missing, so no more workers go to it\. /.test(pi?.need ?? ''), true);
  t('DS-786 AC3 it names the follow items waiting on it', (pi?.need ?? '').endsWith('The follow steps of P-1 and P-2 wait on it reaching the default branch'), true);
  t('DS-786 AC3 the follow items waiting on it stay held, so nothing waiting on it is listed above it', ci.map((i) => i.t.key).join(), 'promotion:1001');
  t('DS-786 AC2 desk-q counts it', N.needsCount(loadRepos().find((r) => r.slug === 'acme__chi786')).shown, 1);
  const done786 = N.record({ word: 'chi786', ticket: 'promotion:1001', action: 'done' });
  t('DS-786 done records nothing: the next pass reads its checks again', `${done786.ok} ${queueOf('chi786').promotion.red.pr} ${items().length}`, 'true 1001 1');
  const off786 = N.record({ word: 'chi786', ticket: 'promotion:1001', action: 'not-now' });
  t('DS-786 not-now puts it off', `${off786.ok} ${items().some((i) => i.t.key === 'promotion:1001')}`, 'true false');
  put('chi786', { port: 4796, beat: 1, supervised: true, tickets: kids, ...batch({ pr: 1001, red: { ...red, head: 'f'.repeat(40) } }) });
  t('DS-786 a new head brings it back', items().some((i) => i.t.key === 'promotion:1001'), true);
  // AC4 and AC5: the pass records no red while the PR is draft waiting on children, or green; nor once it merged.
  put('chi786', { port: 4796, beat: 1, supervised: true, tickets: kids, ...batch({ pr: 1001 }) });
  t('DS-786 AC4 AC5 negative: no red recorded, no item', items().map((i) => i.t.key).join(), '');
  // A child promoted by an earlier slice is out: its follow item is listed, and it does not wait on this PR.
  // Its own repo, so the not-now above does not reach it.
  put('omega786', { port: 4797, beat: 1, supervised: true, ...batch({ pr: 1001, red, since: minsAgo(600) }),
    tickets: { 'P-1': kids['P-1'], 'P-2': merged(92, { follow_on: [STEP786], merged_at: minsAgo(60) }) } });
  const split = N.collect({ word: 'omega786' }).items;
  t('DS-786 AC3 only the child merged since the last promotion is named as waiting, and it ranks above a listed follow item',
    `${split.map((i) => i.t.key).join()} ${split[0]?.need.endsWith('The follow steps of P-2 wait on it reaching the default branch')}`, 'promotion:1001,follow:P-1 true');
  // A head the not-now above never saw, so only each guard can keep the item off the list.
  const redD = { ...red, head: 'd'.repeat(40) };
  put('chi786', { port: 4796, beat: 1, supervised: true, tickets: kids, ...batch({ pr: 1001, red: redD }) });
  t('DS-786 control: that red record on the open promotion PR is listed', items().some((i) => i.t.key === 'promotion:1001'), true);
  put('chi786', { port: 4796, beat: 1, supervised: true, tickets: kids, ...batch({ pr: 1001, red: redD, merged_at: minsAgo(1) }) });
  t('DS-786 negative: a merged promotion PR is not listed', items().some((i) => i.t.key === 'promotion:1001'), false);
  put('chi786', { port: 4796, beat: 1, supervised: true, tickets: kids, ...batch({ pr: 1002, red: redD }) });
  t('DS-786 negative: a red record for an earlier promotion PR is not listed', items().some((i) => i.t.key.startsWith('promotion:')), false);
}

// DS-784: a child of a feature batch merged into the batch base is out only once a promotion PR that
// merged after it has taken it to the default branch, and its follow item is held until then.
{
  const STEP = { step: 'check delete-and-Undo on staging', row: 'staging-write' };
  const child = (pr, m) => ({ state: 'done', lane: 'A', result: { pr }, merged_at: minsAgo(m), pr_status: { pr, state: 'MERGED', merged_at: minsAgo(m) }, follow_on: [STEP] });
  const feature = (word, port, promotion, tickets) => put(word, { port, beat: 1, supervised: true,
    batch: { base: 'feat/P-1-portal', feature: true, epic: 'P-1', promotion }, tickets });
  const follows = (word) => N.collect({ word }).items.filter((i) => i.kind === 'follow');
  const count = (word) => N.needsCount(loadRepos().find((r) => r.slug === `acme__${word}`)).shown;

  feature('psi784', 4784, { pr: 101, slice: 1, at: minsAgo(1300) }, { 'P-2': child(97, 1200), 'P-3': child(100, 1000) });
  t('DS-784 AC1 no follow item while the promotion PR is open', follows('psi784').length, 0);
  t('DS-784 AC5 a held follow item counts towards nothing', count('psi784'), 0);

  feature('psi784b', 4785, { pr: 101, slice: 1, at: minsAgo(1300), merged: [{ pr: 101, slice: 1, merged_at: minsAgo(60) }] },
    { 'P-2': child(97, 1200), 'P-3': child(100, 1000) });
  const out = follows('psi784b');
  t('DS-784 AC2 each child is listed once the promotion PR holding its merge has merged', out.map((i) => i.t.key).sort().join(), 'follow:P-2,follow:P-3');
  t('DS-784 AC2 aged from the promotion merge, not the child\'s', out.map((i) => i.since).join(), `${Date.parse(minsAgo(60))},${Date.parse(minsAgo(60))}`);
  t('DS-784 AC5 once listed, it counts', count('psi784b'), 2);

  feature('psi784c', 4786, { pr: 102, slice: 2, since: minsAgo(500), at: minsAgo(500), merged: [{ pr: 101, slice: 1, merged_at: minsAgo(500) }] },
    { 'P-2': child(97, 1200), 'P-4': child(103, 300) });
  t('DS-784 AC3 a child merged after the first promotion stays held until a later one merges',
    follows('psi784c').map((i) => i.t.key).join(), 'follow:P-2');

  // A base desk opens no promotion PR for (set-batch base= with neither feature mode nor an epic) holds
  // nothing: the person lands that branch, and nothing would ever release the hold.
  put('psi784e', { port: 4788, beat: 1, supervised: true, batch: { base: 'feat/plain' }, tickets: { 'P-6': child(106, 40) } });
  const plain = follows('psi784e');
  t('DS-784 a plain base batch lists the item, aged from its own merge', `${plain.map((i) => i.t.key).join()} ${plain[0]?.since === Date.parse(minsAgo(40))}`, 'follow:P-6 true');
  // An epic batch: the epic PR's merge releases it, and a reopen that failed keeps it released.
  const epic = (word, port, promotion) => put(word, { port, beat: 1, supervised: true,
    batch: { base: 'feat/E-1', epic: 'E-1', promotion }, tickets: { 'P-7': child(107, 1200) } });
  epic('psi784f', 4789, { pr: 108, merged_at: minsAgo(90) });
  t('DS-784 an epic batch lists it once the epic PR merged, aged from that merge', follows('psi784f').map((i) => `${i.t.key} ${i.since === Date.parse(minsAgo(90))}`).join(), 'follow:P-7 true');
  epic('psi784g', 4790, { pr: null, why: 'refused', since: minsAgo(90), merged: [{ pr: 108, merged_at: minsAgo(90) }] });
  t('DS-784 and still after a reopen of the next epic PR failed', follows('psi784g').map((i) => i.t.key).join(), 'follow:P-7');
  epic('psi784h', 4791, { pr: 108, at: minsAgo(1300) });
  t('DS-784 an epic batch holds it while the epic PR is open', follows('psi784h').length, 0);
  // The archive check stamps a child promoted before it archives the batch (batch.mjs), and the stamp wins.
  feature('psi784i', 4792, { pr: 101, slice: 1, at: minsAgo(1300) }, { 'P-8': { ...child(109, 1200), promoted_at: minsAgo(20) } });
  t('DS-784 a child stamped promoted is listed, aged from the stamp', follows('psi784i').map((i) => `${i.t.key} ${i.since === Date.parse(minsAgo(20))}`).join(), 'follow:P-8 true');

  put('psi784d', { port: 4787, beat: 1, supervised: true, tickets: { 'P-5': child(105, 30) } });
  const own = follows('psi784d');
  t('DS-784 AC4 a ticket merged into the default branch is listed, aged from its own merge',
    `${own.map((i) => i.t.key).join()} ${own[0]?.since === Date.parse(minsAgo(30))}`, 'follow:P-5 true');
}

// A link to a blocker in no batch closed as Won't Do (pass.mjs wont_do_link) is one triage
// item naming both tickets, beside the ticket's own hold or park, until the pass clears the marker.
{
  const held = { state: 'parked', lane: 'A', held_by: 'X-1', held_outside: 'X-1', wont_do_link: 'X-1', park: { question: 'held by orchestrator: blocked by X-1 — starts once X-1 is Done and on the base', since: minsAgo(30) } };
  put('phi717', { port: 4717, beat: 1, supervised: true, pattern: 'W-[0-9]+', tickets: {
    'W-1': held,
    'W-2': { ...parked('C', 20, 'lane C: the plan needs agreeing'), wont_do_link: 'X-2' },
  }, triage: {
    'W-1': { blockers: [{ key: 'X-1', category: 'done', status: "Won't Do", resolution: "Won't Do", summary: 'Ship the old flag' }] },
    'W-2': { blockers: [{ key: 'X-2', category: 'done', status: 'Closed', resolution: 'Duplicate' }] },
  } });
  const li = () => N.collect({ word: 'phi717' }).items.filter((i) => i.blocker);
  const l1 = li();
  t('DS-717 AC1/AC5 each link is one triage item, the held ticket and the lane C park alike', l1.map((i) => `${i.t.key} ${i.kind}`).join(), 'link:W-1:X-1 triage,link:W-2:X-2 triage');
  t('DS-717 AC1 the item names both tickets, the resolution, and asks whether the link is still right',
    /^W-1 is blocked by X-1 \("Ship the old flag"\), which is in no batch and was closed as Won't Do without landing, so W-1 is held behind it.*Is the link still right\?/.test(l1[0]?.need ?? ''), true);
  t('DS-717 AC5 the lane C park is still listed as its own item', N.collect({ word: 'phi717' }).items.some((i) => i.t.key === 'W-2' && i.kind === 'session'), true);
  const rec717 = N.record({ word: 'phi717', ticket: 'link:W-1:X-1', action: 'done' });
  t('DS-717 done records nothing: the pass clears it once the link goes', `${rec717.ok} ${li().length}`, 'true 2');
  const q717 = queueOf('phi717'); delete q717.tickets['W-1'].wont_do_link;
  writeFileSync(join(env.DESK_HOME, 'repos', 'acme__phi717', 'queue.json'), JSON.stringify(q717));
  t('DS-717 AC3 once the pass clears the marker the item leaves the list', li().map((i) => i.t.key).join(), 'link:W-2:X-2');
  // The pass reads a done ticket waiting on no step no more, so it would never clear the marker.
  const q2 = queueOf('phi717'); q2.tickets['W-2'] = { ...q2.tickets['W-2'], state: 'done', park: null, result: {} };
  writeFileSync(join(env.DESK_HOME, 'repos', 'acme__phi717', 'queue.json'), JSON.stringify(q2));
  t('DS-717 a ticket finished with no PR lists no link item, since nothing waits on the link', li().length, 0);
  q2.tickets['W-2'].merge_after = 'X-2'; writeFileSync(join(env.DESK_HOME, 'repos', 'acme__phi717', 'queue.json'), JSON.stringify(q2));
  t('DS-717 a done ticket whose merge waits on the link still lists it', li().map((i) => i.t.key).join(), 'link:W-2:X-2');
}

// DS-811: a DS-705-shaped hold. The blocker is Done, and its PR merged into a feature base with no
// promotion PR, recorded by the pass (unpromoted). Once it has been Done a day it is one held item,
// offering promote or start.
{
  const BASE = 'feat/DS-631-levers-auto-trial-adopt';
  const heldOn = (b, hours, more = {}) => ({ state: 'parked', lane: 'A', held_by: b, held_outside: b, park: { question: `held by orchestrator: blocked by ${b} — starts once ${b} is Done and on the base`, since: minsAgo(3000) },
    unpromoted: { [b]: { branch: BASE, pr: null, state: 'none', since: minsAgo(hours * 60), ...more } } });
  put('ds811', { port: 4811, beat: 1, supervised: true, pattern: 'DS-[0-9]+', tickets: {
    'DS-705': heldOn('DS-692', 48), 'DS-706': heldOn('DS-693', 23), 'DS-707': heldOn('DS-694', 48), 'DS-708': heldOn('DS-695', 48),
  }, triage: { 'DS-705': { blockers: [{ key: 'DS-692', category: 'done', resolution: 'Done', summary: 'Adopt the lever' }] } } });
  const items = () => N.collect({ word: 'ds811' }).items;
  const keys = () => items().map((i) => i.t.key).sort().join();
  const i705 = items().find((i) => i.t.key === 'unpromoted:DS-705:DS-692');
  t('DS-811 AC1 one held item for the hold, naming the base and its promotion PR, offering promote first then start',
    `${i705?.kind} ${/^DS-705 is held behind DS-692 \("Adopt the lever"\), Done since \d{4}-\d\d-\d\d, whose code merged into feat\/DS-631-levers-auto-trial-adopt, not main\. No PR promotes feat\/DS-631-levers-auto-trial-adopt into main, so nothing lands it\. Promote feat\/DS-631-levers-auto-trial-adopt, or start DS-705 without DS-692/.test(i705?.need ?? '')} ${i705?.actions.map(([a]) => a).join()}`,
    'held true promote,start,not-now');
  t('DS-811 AC2 a blocker Done under a day lists nothing, and no held ticket is listed on its own', keys(), 'unpromoted:DS-705:DS-692,unpromoted:DS-707:DS-694,unpromoted:DS-708:DS-695');
  t('DS-811 AC5 listed again with nothing answered, it is still one item', items().filter((i) => i.t.key === 'unpromoted:DS-705:DS-692').length, 1);
  const before = readFileSync(GH_LOG, 'utf8');
  const p = N.record({ word: 'ds811', ticket: 'unpromoted:DS-705:DS-692', action: 'promote' });
  const made = readFileSync(GH_LOG, 'utf8').slice(before.length);
  const q705 = queueOf('ds811').tickets['DS-705'];
  t('DS-811 AC3 promote with none open opens one from the base into main, ready for review',
    `${p.ok} ${made.includes(`pr create --repo acme/ds811 --base main --head ${BASE} --title DS-631: promote ${BASE} to main`)} ${made.includes('--draft')}`, 'true true false');
  t('DS-811 AC3 the dependant stays held, with the PR recorded as asked for', `${q705.state} ${q705.held_by} ${q705.unpromoted['DS-692'].pr} ${q705.unpromoted['DS-692'].promote}`, 'parked DS-692 931 931');
  t('DS-811 AC3 and its item leaves the list while that PR is open', keys(), 'unpromoted:DS-707:DS-694,unpromoted:DS-708:DS-695');
  const q2 = queueOf('ds811'); q2.tickets['DS-705'].unpromoted['DS-692'].state = 'red';
  writeFileSync(join(env.DESK_HOME, 'repos', 'acme__ds811', 'queue.json'), JSON.stringify(q2));
  t('DS-811 it comes back once that PR goes red', /Promotion PR #931, feat\/DS-631-levers-auto-trial-adopt into main, is red, and DS-705 waits until it merges\./.test(items().find((i) => i.t.key === 'unpromoted:DS-705:DS-692')?.need ?? ''), true);
  writeFileSync(join(GH_PRS, 'list-open.json'), JSON.stringify([{ number: 640, isDraft: true }]));
  const mark = readFileSync(GH_LOG, 'utf8').length;
  const named = N.record({ word: 'ds811', ticket: 'unpromoted:DS-707:DS-694', action: 'promote' });
  rmSync(join(GH_PRS, 'list-open.json'));
  t('DS-811 AC3 promote with one open names it and opens none',
    `${named.ok} ${/promotion PR #640 \(.*\) is already open, as a draft; DS-707 stays held/.test(named.line)} ${readFileSync(GH_LOG, 'utf8').slice(mark).includes('pr create')}`, 'true true false');
  const s = N.record({ word: 'ds811', ticket: 'unpromoted:DS-708:DS-695', action: 'start' });
  const q708 = queueOf('ds811').tickets['DS-708'];
  t('DS-811 AC4 start lifts that hold and queues it', `${s.ok} ${q708.state} ${q708.held_by ?? null} ${q708.held_outside ?? null} ${q708.unpromoted ?? null} ${q708.freed_from}`, 'true triaged null null null DS-695');
  t('DS-811 AC4 and its item leaves the list', items().some((i) => i.t.key === 'unpromoted:DS-708:DS-695'), false);
}

// A hold on a ticket dropped from the batch (dropped_link), a blocker in this batch closed as
// Won't Do with its PR unmerged (wont_do_link) and two tickets linked as blocking each other (cycle_link)
// are each one triage item, and the ticket held behind the dropped one is not listed again.
{
  const heldOn = (k) => ({ state: 'parked', lane: 'A', held_by: k, park: { question: `held by orchestrator: blocked by ${k} — starts once their PRs merge`, since: minsAgo(30) } });
  put('psi718', { port: 4718, beat: 1, supervised: true, pattern: 'V-[0-9]+', tickets: {
    'V-1': { ...heldOn('V-9'), dropped_link: 'V-9' },
    'V-2': { ...heldOn('V-3'), wont_do_link: 'V-3' },
    'V-3': { state: 'triaged', lane: 'A' },
    'V-4': { state: 'triaged', lane: 'A', cycle_link: 'V-5' },
    'V-5': heldOn('V-4'),
  }, triage: {
    'V-2': { blockers: [{ key: 'V-3', category: 'done', resolution: "Won't Do" }] },
    'V-4': { blockers: [{ key: 'V-5', category: 'new' }] },
  } });
  const items = N.collect({ word: 'psi718' }).items;
  const link = (k) => items.find((i) => i.t.key === k);
  t('DS-718 AC3/AC5/AC6 each link is one triage item', items.filter((i) => i.blocker).map((i) => `${i.t.key} ${i.kind}`).sort().join(), 'link:V-1:V-9 triage,link:V-2:V-3 triage,link:V-4:V-5 triage');
  t('DS-718 AC3 the dropped one asks whether the link is still right',
    /^V-1 is held behind V-9, which is no longer in this batch, so nothing releases it\. Is the link still right\?/.test(link('link:V-1:V-9')?.need ?? ''), true);
  t('DS-718 AC5 the one in this batch says so',
    /^V-2 is blocked by V-3, which is in this batch with its PR unmerged and was closed as Won't Do without landing, so V-2 is held behind it/.test(link('link:V-2:V-3')?.need ?? ''), true);
  t('DS-718 AC5 the one in this batch says its hold outlives the link, so the ticket is released by hand',
    /nothing releases it\. Is the link still right\? If not, remove it in Jira, then release V-2 from it \(queue\.mjs set V-2 state=triaged park=null held_by=null, then queue\.mjs front V-2\), as its hold outlives the link;/.test(link('link:V-2:V-3')?.need ?? ''), true);
  t('DS-718 AC6 the cycle names both tickets', /^V-4 and V-5 are linked in Jira as blocking each other/.test(link('link:V-4:V-5')?.need ?? ''), true);
  t('DS-718 AC6 the cycle says how to settle it either way, the held one by release and hold, as its hold outlives its link',
    /If V-4, remove its "is blocked by V-5" link in Jira; .* If V-5, removing V-5's link leaves its hold, so release V-5 \(queue\.mjs set V-5 state=triaged park=null held_by=null, then queue\.mjs front V-5\), then hold V-4 behind it \(queue\.mjs hold V-4 V-5\), and this clears \(1 ticket waits behind this\)$/.test(link('link:V-4:V-5')?.need ?? ''), true);
  t('DS-718 AC3 the ticket held behind the dropped one is not listed a second time', items.some((i) => i.t.key === 'V-1'), false);
}

// DS-657 AC1/AC2: a link item counts the ticket on the link and every ticket held behind that one, and
// ranks by it, as the link is the only item the held chain is listed under.
{
  const heldOn = (k) => ({ state: 'parked', lane: 'A', held_by: k, park: { question: `held by orchestrator: blocked by ${k} — starts once their PRs merge`, since: minsAgo(30) } });
  put('link657', { port: 4757, beat: 1, supervised: true, pattern: 'V-[0-9]+', tickets: {
    'V-1': { ...heldOn('V-9'), dropped_link: 'V-9' }, 'V-2': heldOn('V-1'), 'V-3': heldOn('V-2'),
    'V-4': parked('A', 300, 'Which endpoint?'),
    // Held behind V-4, so it waits on V-4, not on its Won't Do link to X-9.
    'V-5': { ...heldOn('V-4'), wont_do_link: 'X-9' },
  }, triage: { 'V-5': { blockers: [{ key: 'X-9', category: 'done', resolution: "Won't Do" }] } } });
  const items = N.collect({ word: 'link657' }).items;
  t('DS-657 AC1 a dropped link counts the ticket on it and those held behind that one',
    /\(3 tickets wait behind this\)$/.test(items.find((i) => i.t.key === 'link:V-1:V-9')?.need ?? ''), true);
  t('DS-657 AC1 a link on a ticket held on another blocker counts nothing: nothing waits on that link',
    /wait(s)? behind this/.test(items.find((i) => i.t.key === 'link:V-5:X-9')?.need ?? 'missing wait behind this'), false);
  t('DS-657 AC2 and ranks ahead of one that has waited longer', items.map((i) => i.t.key).join(), 'link:V-1:V-9,V-4,link:V-5:X-9');
}

// A lane C park held behind a dropped ticket is freed from that hold alone: a release would drop its park
// and send it to a worker.
{
  put('psi718c', { port: 4719, beat: 1, supervised: true, pattern: 'V-[0-9]+', tickets: {
    'V-6': { state: 'parked', lane: 'C', held_by: 'V-8', dropped_link: 'V-8', park: { question: 'lane C — needs the person', since: minsAgo(30) } },
  } });
  const need = N.collect({ word: 'psi718c' }).items.find((i) => i.t.key === 'link:V-6:V-8')?.need ?? '';
  t('DS-718 AC3 a lane C park held behind a dropped ticket is freed from that hold and keeps its park',
    need.includes('release V-6 from it (queue.mjs set V-6 held_by=null freed_from=V-8)') && !need.includes('park=null'), true);
}

// A ticket held behind several blockers, freed from a dropped one: the rest of held_by is quoted, as a
// shell reads `|` as a pipe, and freed_from names the dropped one so the merge driver's --deps skip it.
{
  put('psi718m', { port: 4720, beat: 1, supervised: true, pattern: 'V-[0-9]+', tickets: {
    'V-10': { state: 'parked', lane: 'A', held_by: 'V-9|V-11|V-12', dropped_link: 'V-9', park: { question: 'held by orchestrator: blocked by V-9, V-11, V-12 — starts once their PRs merge', since: minsAgo(30) } },
    'V-11': { state: 'triaged', lane: 'A' }, 'V-12': { state: 'triaged', lane: 'A' },
  } });
  const need = N.collect({ word: 'psi718m' }).items.find((i) => i.t.key === 'link:V-10:V-9')?.need ?? '';
  t('DS-718 AC3 freeing one of several holds quotes the rest and records the freed one',
    need.includes("release V-10 from it (queue.mjs set V-10 'held_by=V-11|V-12' freed_from=V-9)"), true);
}

// DS-800: one ticket queued in two repos on the same Jira site. The copy held behind a ticket the other
// repo's batch has is the extra one, listed as a duplicate with drop recommended in place of its dropped
// link; the other copy lists nothing, and dropping the extra one leaves it as it is.
{
  const heldOn = (k) => ({ state: 'parked', lane: 'A', held_by: k, park: { question: `held by orchestrator: blocked by ${k} — starts once their PRs merge`, since: minsAgo(30) } });
  const site = 'acme.atlassian.net';
  put('zen800', { port: 4800, beat: 1, supervised: true, site, tickets: { 'SV-84': { state: 'running', lane: 'A' }, 'SV-91': heldOn('SV-84') } });
  put('web800', { port: 4810, beat: 1, supervised: true, site, tickets: { 'SV-91': { ...heldOn('SV-84'), dropped_link: 'SV-84' }, 'SV-70': { state: 'triaged', lane: 'A' } } });
  const web = N.collect({ word: 'web800' }).items;
  const dup = web.find((i) => i.t.key === 'SV-91');
  t('DS-800 AC2 the copy whose blocker is in the other repo is listed as a duplicate', dup?.kind, 'duplicate');
  t('DS-800 AC2 drop is recommended for it', `${dup?.actions.map(([a]) => a).join()} ${!!dup?.actions[0][1]}`, 'drop,not-now true');
  t('DS-800 AC2 its need names the other repo\'s copy and the blocker there',
    /^SV-91 is queued here and in acme\/zen800's standing batch \(parked\), .* held behind SV-84, which is in that batch and not this one/.test(dup?.need ?? ''), true);
  t('DS-800 AC2 the dropped link item is not listed beside it', web.some((i) => i.t.key === 'link:SV-91:SV-84'), false);
  t('DS-800 AC2 the other copy is not listed as a duplicate', N.collect({ word: 'zen800' }).items.some((i) => i.kind === 'duplicate'), false);
  const zenBefore = JSON.stringify(queueOf('zen800'));
  const rec = N.record({ word: 'web800', ticket: 'SV-91', action: 'drop' });
  t('DS-800 AC3 drop on the duplicate is recorded', rec.ok, true);
  t('DS-800 AC3 the copy in repo B is removed, and the rest of its batch stays', `${'SV-91' in queueOf('web800').tickets} ${'SV-70' in queueOf('web800').tickets}`, 'false true');
  t('DS-800 AC3 the copy in repo A is unchanged', JSON.stringify(queueOf('zen800')), zenBefore);
  t('DS-800 AC3 and nothing is listed for it any more', N.collect({ word: 'zen800' }).items.concat(N.collect({ word: 'web800' }).items).some((i) => i.ticket === 'SV-91'), false);

  // Neither copy waits on the other's batch: each lists the other, with drop offered but not recommended.
  put('zen800b', { port: 4820, beat: 1, supervised: true, site, tickets: { 'SV-95': { state: 'triaged', lane: 'A' } } });
  put('web800b', { port: 4830, beat: 1, supervised: true, site, tickets: { 'SV-95': { state: 'triaged', lane: 'A' } } });
  for (const w of ['zen800b', 'web800b']) {
    const it = N.collect({ word: w }).items.find((i) => i.t.key === 'SV-95');
    t(`DS-800 neither copy held on the other: ${w} lists it, drop not recommended`, `${it?.kind} ${it?.actions.map(([a]) => a).join()} ${it?.actions[0][1]}`, 'duplicate drop,not-now null');
  }
  // A copy parked on its own question lists that park beside its duplicate item; not-now puts off both.
  put('zen800n', { port: 4870, beat: 1, supervised: true, site, tickets: { 'SV-97': { state: 'triaged', lane: 'A' } } });
  put('web800n', { port: 4880, beat: 1, supervised: true, site, tickets: { 'SV-97': { state: 'parked', lane: 'A', park: { question: 'Which colour is the button?', since: minsAgo(30) } } } });
  const kinds = () => N.collect({ word: 'web800n' }).items.filter((i) => i.t.key === 'SV-97').map((i) => i.kind).sort().join();
  t('a parked copy lists its park and its duplicate item', kinds(), 'duplicate,parked');
  const nn = N.record({ word: 'web800n', ticket: 'SV-97', action: 'not-now' });
  t('not-now on it puts off its park and its duplicate item', `${nn.ok} ${kinds()}`, 'true ');
  // The same key on another Jira site, or a repo with no tracker, is another ticket.

  put('other800', { port: 4840, beat: 1, supervised: true, site: 'other.atlassian.net', tickets: { 'SV-96': { state: 'triaged', lane: 'A' } } });
  put('none800', { port: 4850, beat: 1, supervised: true, tickets: { 'SV-96': { state: 'triaged', lane: 'A' } } });
  put('zen800c', { port: 4860, beat: 1, supervised: true, site, tickets: { 'SV-96': { state: 'triaged', lane: 'A' } } });
  t('DS-800 a key on another Jira site or in a repo with no tracker is no duplicate',
    ['other800', 'none800', 'zen800c'].some((w) => N.collect({ word: w }).items.some((i) => i.kind === 'duplicate')), false);
  // Their items are these checks' alone: later ones list every repo.
  for (const w of ['zen800', 'web800', 'zen800b', 'web800b', 'zen800n', 'web800n', 'other800', 'none800', 'zen800c']) {
    for (const d of [join(env.DESK_CONFIG_ROOT, 'repos', `acme__${w}`), join(env.DESK_HOME, 'repos', `acme__${w}`)]) rmSync(d, { recursive: true, force: true });
  }
}

// A lane C park whose hold the pass lifted once its sibling merged is listed as its own session item.
{
  put('chi715', { port: 4715, beat: 1, supervised: true, tickets: {
    'L-1': { ...parked('C', 20, 'lane C — spans layers'), held_by: null, held_outside: null },
    'L-0': { state: 'done', lane: 'A', result: { pr: 70 }, merged_at: minsAgo(30), pr_status: { pr: 70, state: 'MERGED' } },
  } });
  const it = N.collect({ word: 'chi715' }).items.find((i) => i.t.key === 'L-1');
  t('DS-715 AC2 a lane C park whose hold lifted is a session item recommending open', `${it?.kind} ${it?.actions[0][0]}`, 'session open');
}

// ---- DS-546: list settles what finished outside desk, reading GitHub, Jira and git again (stubbed here),
// and done on a session item reads its PR and ticket.
{
  const CURL = 'Posting the fixture needs curl, which is denied to every worker. Can you post it?';
  put('mu546', { port: 5546, beat: 1, supervised: true, pattern: 'M-[0-9]+', tickets: {
    // Done once with its PR open, then requeued: the last pass's PR status still reads it open.
    'M-1': { ...parked('B', 60, CURL), draft_pr: 911, pr_status: { pr: 911, state: 'OPEN', isDraft: true } },
    'M-2': { ...parked('C', 50, 'lane C: the plan needs agreeing'), draft_pr: 912 },
    'M-3': { ...parked('A', 40, 'Which endpoint?'), draft_pr: 913 },
    'M-4': parked('C', 30, 'lane C: the plan needs agreeing'),
    'M-5': { ...parked('B', 20, CURL), draft_pr: 915 },
    'M-6': { ...parked('A', 10, 'Retry or fail?'), draft_pr: 916 },
    // Its PR merged, then it was requeued for more work and parked again with no new PR.
    'M-7': { ...parked('B', 5, CURL), merged_at: '2026-11-01T10:00:00Z', result: { pr: 917 } },
  } });
  const prs = { 911: 'MERGED', 912: 'MERGED', 913: 'OPEN', 915: 'OPEN', 916: 'MERGED', 917: 'MERGED' };
  const jira = { 'M-1': 'done', 'M-2': 'indeterminate', 'M-4': 'indeterminate', 'M-6': 'done', 'M-7': 'done' };
  const reads = { pr: (_r, n) => ({ v: prs[n] ? { state: prs[n], mergedAt: '2026-11-09T19:40:54Z', isDraft: prs[n] === 'OPEN' } : null, err: prs[n] ? '' : 'no such PR' }),
    ticket: (_r, k) => jira[k] ?? null, git: () => null };
  const mu = () => Object.fromEntries(N.collect({ word: 'mu546' }).items.map((i) => [i.t.key, i]));
  t('DS-546 AC4 a session item on a step no worker is allowed offers done, and never resume', mu()['M-1']?.actions.map((a) => a[0]).join(), 'open,done,drop,not-now');
  const settled = N.refresh({ word: 'mu546', reads });
  t('DS-546 AC1 list closes a session item and a parked item whose PR merged and whose ticket is done, and says so',
    settled.join(' | '), 'mu546 M-1: PR #911 merged at 2026-11-09 19:40 UTC, and M-1 is done in Jira, so it is recorded done and off your list. | mu546 M-6: PR #916 merged at 2026-11-09 19:40 UTC, and M-6 is done in Jira, so it is recorded done and off your list.');
  const m1 = queueOf('mu546').tickets['M-1'];
  t('DS-546 AC1 it is recorded done as the pass records a ticket shipped elsewhere', `${m1.state} ${m1.park} ${m1.result?.pr} ${/^shipped outside its worker: PR #911 merged/.test(m1.result?.summary)}`, 'done null 911 true');
  t('DS-546 AC1 its PR status is marked merged too, so it is not listed as an open PR', `${m1.pr_status?.state} ${m1.pr_status?.merged_at}`, 'MERGED 2026-11-09T19:40:54Z');
  t('DS-546 AC1 neither is listed; a merged PR on a ticket not done, an open PR, no PR and a PR merged before a requeue stay',
    Object.keys(mu()).sort().join(), 'M-2,M-3,M-4,M-5,M-7');
  t('DS-546 AC1 a ticket requeued after its PR merged is not closed on that PR', queueOf('mu546').tickets['M-7'].state, 'parked');
  t('DS-546 AC1 a second list closes nothing more', N.refresh({ word: 'mu546', reads }).length, 0);
  const d5 = N.record({ word: 'mu546', ticket: 'M-5', action: 'done', reads });
  t('DS-546 AC2 done on a session item whose PR is unmerged refuses, saying so, and it stays parked',
    `${d5.ok} ${d5.line} ${queueOf('mu546').tickets['M-5'].state}`, 'false mu546 M-5: GitHub shows PR #915 unmerged, still a draft, so it is not recorded done and stays on your list. Say done once it has merged. parked');
  const d2 = N.record({ word: 'mu546', ticket: 'M-2', action: 'done', reads });
  t('DS-546 AC2 done on a session item whose PR merged records it done with the reason, and it leaves the list',
    `${d2.ok} ${d2.line} ${queueOf('mu546').tickets['M-2'].state} ${'M-2' in mu()}`,
    'true mu546 M-2: recorded done (you said done; PR #912 merged at 2026-11-09 19:40 UTC; M-2 is not done in Jira yet), so it is off your list. done false');
  const d4 = N.record({ word: 'mu546', ticket: 'M-4', action: 'done', reads });
  t('DS-546 AC2 done on a session item with no PR records it done', `${d4.ok} ${queueOf('mu546').tickets['M-4'].state} ${queueOf('mu546').tickets['M-4'].result?.pr ?? null}`, 'true done null');
  t('DS-546 AC2 done on a parked item is still not an action', N.record({ word: 'mu546', ticket: 'M-3', action: 'done', reads }).ok, false);
  const unread = { ...reads, pr: () => ({ v: null, err: 'HTTP 502' }) };
  put('mu546b', { port: 5549, beat: 1, supervised: true, tickets: { 'MB-1': { ...parked('B', 60, CURL), draft_pr: 931 } } });
  const db1 = N.record({ word: 'mu546b', ticket: 'MB-1', action: 'done', reads: unread });
  t('DS-546 AC2 done on a session item whose PR cannot be read refuses, naming why', `${db1.ok} ${db1.line} ${queueOf('mu546b').tickets['MB-1'].state}`,
    "false mu546b MB-1: could not read PR #931's state from GitHub (HTTP 502), so it is not recorded done and stays on your list. parked");

  // Done on a session item reads its PR from pr_status, then from GitHub by its key, before recording it
  // done with no PR.
  put('mu817', { port: 5817, beat: 1, supervised: true, pattern: 'AA-[0-9]+', tickets: {
    // AA-88's shape: its open PR is known only from the last pass's pr_status.
    'AA-88': { ...parked('B', 60, CURL), pr_status: { pr: 192, state: 'OPEN', isDraft: true } },
    'AA-89': parked('B', 50, CURL),
    'AA-90': parked('B', 40, CURL),
    'AA-91': parked('B', 30, CURL),
    // Its PR merged, then it was requeued and parked again: that merged PR is not its PR now.
    'AA-92': { ...parked('B', 20, CURL), merged_at: '2026-11-01T10:00:00Z', result: { pr: 180 }, pr_status: { pr: 180, state: 'MERGED' } },
    // An earlier round's PR closed unmerged, and a respawn cleared result and draft_pr but not pr_status.
    'AA-93': { ...parked('B', 15, CURL), pr_status: { pr: 181, state: 'CLOSED' } },
    'AA-94': { ...parked('B', 10, CURL), pr_status: { pr: 182, state: 'CLOSED' } },
  } });
  const gh817 = { 192: 'OPEN', 193: 'OPEN', 194: 'OPEN', 180: 'MERGED', 181: 'CLOSED', 182: 'CLOSED' };
  const searched = [];
  const reads817 = { ...reads, ticket: () => 'indeterminate',
    pr: (_r, n) => ({ v: gh817[n] ? { state: gh817[n], mergedAt: gh817[n] === 'MERGED' ? '2026-11-01T10:00:00Z' : null, isDraft: gh817[n] === 'OPEN' } : null, err: gh817[n] ? '' : 'no such PR' }),
    open: (_r, key) => { searched.push(key); return key === 'AA-91' ? { pr: null, err: 'HTTP 502' } : { pr: key === 'AA-89' ? 193 : key === 'AA-94' ? 194 : null, err: '' }; } };
  const q817 = () => queueOf('mu817').tickets;
  const a1 = N.record({ word: 'mu817', ticket: 'AA-88', action: 'done', reads: reads817 });
  t('DS-817 AC1 done on a ticket whose open PR is only in pr_status refuses, naming it, and it stays on the list',
    `${a1.ok} ${a1.line} ${q817()['AA-88'].state} ${q817()['AA-88'].result?.pr ?? null}`,
    'false mu817 AA-88: GitHub shows PR #192 unmerged, still a draft, so it is not recorded done and stays on your list. Say done once it has merged. parked null');
  t('DS-817 AC1 a PR in pr_status is read, not searched for', searched.includes('AA-88'), false);
  const a2 = N.record({ word: 'mu817', ticket: 'AA-89', action: 'done', reads: reads817 });
  t('DS-817 AC2 done on a ticket with no PR recorded and an open PR naming its key refuses, naming that PR',
    `${a2.ok} ${a2.line} ${q817()['AA-89'].state}`,
    'false mu817 AA-89: GitHub shows PR #193 unmerged, still a draft, so it is not recorded done and stays on your list. Say done once it has merged. parked');
  const a3 = N.record({ word: 'mu817', ticket: 'AA-90', action: 'done', reads: reads817 });
  t('DS-817 AC3 done on a ticket with no PR anywhere and none naming its key records it done with no PR',
    `${a3.ok} ${a3.line} ${q817()['AA-90'].state} ${q817()['AA-90'].result?.pr ?? null}`,
    'true mu817 AA-90: recorded done (you said done; it has no PR; AA-90 is not done in Jira yet), so it is off your list. done null');
  const a4 = N.record({ word: 'mu817', ticket: 'AA-91', action: 'done', reads: reads817 });
  t('DS-817 done when GitHub cannot be searched for its key refuses, naming why',
    `${a4.ok} ${a4.line} ${q817()['AA-91'].state}`,
    'false mu817 AA-91: could not look on GitHub for an open PR naming AA-91 (HTTP 502), so it is not recorded done and stays on your list. parked');
  const a5 = N.record({ word: 'mu817', ticket: 'AA-92', action: 'done', reads: reads817 });
  t('DS-817 a PR merged before a requeue is not taken from pr_status: it searches, and records no PR',
    `${a5.ok} ${searched.includes('AA-92')} ${q817()['AA-92'].state} ${/it has no PR/.test(q817()['AA-92'].result?.summary)}`, 'true true done true');
  const a6 = N.record({ word: 'mu817', ticket: 'AA-93', action: 'done', reads: reads817 });
  t('DS-817 a PR in pr_status that GitHub shows closed unmerged is passed over: it searches, and records no PR',
    `${a6.ok} ${searched.includes('AA-93')} ${q817()['AA-93'].state} ${/it has no PR/.test(q817()['AA-93'].result?.summary)}`, 'true true done true');
  const a7 = N.record({ word: 'mu817', ticket: 'AA-94', action: 'done', reads: reads817 });
  t('DS-817 AC2 a closed PR in pr_status does not hide the open one naming its key',
    `${a7.ok} ${a7.line} ${q817()['AA-94'].state}`,
    'false mu817 AA-94: GitHub shows PR #194 unmerged, still a draft, so it is not recorded done and stays on your list. Say done once it has merged. parked');
  // Every open PR is read, not a text search, which never reads a branch; only a PR whose title or
  // branch names the key itself counts.
  const ghLogAt = existsSync(GH_LOG) ? readFileSync(GH_LOG, 'utf8').length : 0;
  writeFileSync(join(GH_PRS, 'list-open.json'), JSON.stringify([
    { number: 201, title: 'AA-890 something else', headRefName: 'fix/AA-890-other' },
    { number: 202, title: 'Fix the widget (AA-89)', headRefName: 'fix/widget' },
    { number: 200, title: 'Unrelated', headRefName: 'fix/AA-89-widget' },
  ]));
  t('DS-817 AC2 the open PR found by key is the newest whose title or branch names the key', JSON.stringify(N.READS.open({ slug: 'acme__mu817' }, 'AA-89')), '{"pr":202,"err":""}');
  t('DS-817 AC2 the open PRs are listed whole, not searched by text', /pr list .*--state open/.test(readFileSync(GH_LOG, 'utf8').slice(ghLogAt)) && !/--search/.test(readFileSync(GH_LOG, 'utf8').slice(ghLogAt)), true);
  t('DS-817 AC2 a PR whose title and branch name another key is not taken', N.READS.open({ slug: 'acme__mu817' }, 'AA-88').pr, null);
  writeFileSync(join(GH_PRS, 'list-open.json'), JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ number: i + 1, title: 'x', headRefName: `b${i}` }))));
  t('DS-817 an open-PR list that may be cut short is a failure, not no PR', /cut short/.test(N.READS.open({ slug: 'acme__mu817' }, 'AA-89').err), true);
  writeFileSync(join(GH_PRS, 'list-open.json'), JSON.stringify([{ number: 200, title: 'Unrelated', headRefName: 'fix/AA-89-widget' }]));
  t('DS-817 AC2 a PR whose branch alone names the key is found', N.READS.open({ slug: 'acme__mu817' }, 'AA-89').pr, 200);
  rmSync(join(GH_PRS, 'list-open.json'));
  t('DS-817 AC3 none open on GitHub reads as no PR, not a failure', JSON.stringify(N.READS.open({ slug: 'acme__mu817' }, 'AA-89')), '{"pr":null,"err":""}');

  // A park waiting on issue links only the person makes keeps them in clears_when alone: its PR merging
  // and its ticket going done close neither it nor its links, which the pass reads on Jira.
  const linked = (lane, m, question, pr) => { const p = parked(lane, m, question);
    return { ...p, result: { pr }, park: { ...p.park, clears_when: { kind: 'links-made', links: [{ key: `ML-${pr - 940}`, type: 'Relates', other: 'ML-9' }], pr } } }; };
  put('mu546c', { port: 5550, beat: 1, supervised: true, pattern: 'ML-[0-9]+', tickets: {
    'ML-1': linked('A', 60, 'Issue links not made: ML-1 Relates ML-9', 941),
    'ML-2': linked('B', 50, CURL, 942),
  } });
  const mergedDone = { pr: () => ({ v: { state: 'MERGED', mergedAt: '2026-11-09T19:40:54Z', isDraft: false }, err: '' }), ticket: () => 'done', git: () => null };
  t('DS-546 AC1 list leaves a park waiting on issue links open, its PR merged and its ticket done',
    `${N.refresh({ word: 'mu546c', reads: mergedDone }).length} ${queueOf('mu546c').tickets['ML-1'].park?.clears_when?.links?.length}`, '0 1');
  const dl2 = N.record({ word: 'mu546c', ticket: 'ML-2', action: 'done', reads: mergedDone });
  t('DS-546 AC2 done on a session item waiting on issue links refuses, naming them, and keeps them',
    `${dl2.ok} ${dl2.line} ${queueOf('mu546c').tickets['ML-2'].park?.clears_when?.links?.length}`,
    'false mu546c ML-2: it waits on issue links ML-2 Relates ML-9 made, so it is not recorded done and stays on your list: the next pass records it done once each is on Jira. 1');

  // A repo with no tracker: a merged PR is enough, and the CLI list reads it from GitHub (the fake gh).
  put('nu546', { port: 5547, beat: 1, supervised: true, tickets: { 'NU-1': { ...parked('B', 60, CURL), draft_pr: 921 }, 'NU-2': { ...parked('B', 50, CURL), draft_pr: 922 } } });
  onGitHub(921, { state: 'MERGED', mergedAt: '2026-11-09T19:40:54Z', isDraft: false });
  onGitHub(922, { state: 'OPEN', mergedAt: null, isDraft: true });
  // DS-701 AC2: list --json --no-settle writes nothing, though a settling list would close NU-1.
  const stamps = () => {
    const dirs = [join(env.DESK_HOME, 'repos', 'acme__nu546'), join(env.HOME, '.desk-autopilot', 'acme__nu546')];
    const walk = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [`${join(d, e.name)} ${statSync(join(d, e.name)).mtimeMs}`])) : []);
    return [...dirs.flatMap(walk), existsSync(ANSWERS) ? `answers ${statSync(ANSWERS).mtimeMs}` : 'answers none'].sort().join('\n');
  };
  const before701 = stamps();
  const ns701 = cli('list', '--json', '--no-settle', 'nu546');
  const nj701 = JSON.parse(ns701.out || '{}');
  t('DS-701 AC2 list --json --no-settle changes no queue, state or answer file (by mtime)', `${ns701.code} ${stamps() === before701} ${before701.includes('queue.json')}`, '0 true true');
  t('DS-701 AC2 and lists the item a settle would have closed', `${nj701.settled} ${nj701.items?.map((i) => i.key).join()} ${queueOf('nu546').tickets['NU-1'].state}`, 'false NU-1,NU-2 parked');
  t('DS-701 list --no-settle without --json prints the list unsettled', cli('list', '--no-settle', 'nu546').out.split('\n').filter((l) => / \| /.test(l)).map((l) => l.split(' ')[1]).join(), 'NU-1,NU-2');
  t('DS-701 an unknown flag still refuses', cli('list', '--nope').code, 11);
  const nuList = cli('list', 'nu546');
  t('DS-546 AC1 the CLI list closes it with no tracker, says so first, and lists only what is left',
    `${nuList.code} ${nuList.out.split('\n')[0]} ${nuList.out.split('\n').filter((l) => / \| /.test(l)).map((l) => l.split(' ')[1]).join()} ${queueOf('nu546').tickets['NU-1'].state}`,
    '0 nu546 NU-1: PR #921 merged at 2026-11-09 19:40 UTC, so it is recorded done and off your list. NU-2 done');
  // DS-701: list --json settles first, as list does, and carries the lines that say what it settled.
  put('nu701', { port: 5701, beat: 1, supervised: true, tickets: { 'NV-1': { ...parked('B', 60, CURL), draft_pr: 925 }, 'NV-2': { ...parked('B', 50, CURL), draft_pr: 926 } } });
  onGitHub(925, { state: 'MERGED', mergedAt: '2026-11-09T19:40:54Z', isDraft: false });
  onGitHub(926, { state: 'OPEN', mergedAt: null, isDraft: true });
  const sj701 = JSON.parse(cli('list', '--json', 'nu701').out || '{}');
  t('DS-701 list --json settles first and says what it settled', `${sj701.settled} ${sj701.settled_lines?.join(' | ')} | ${sj701.items?.map((i) => i.key).join()} ${queueOf('nu701').tickets['NV-1'].state}`,
    'true nu701 NV-1: PR #925 merged at 2026-11-09 19:40 UTC, so it is recorded done and off your list. | NV-2 done');

  // DS-573: a parked item whose PR merged with its ticket not done in Jira goes back to a worker for its
  // after-merge steps, and leaves the list; one whose PR is open stays as it was.
  put('mt573', { port: 5573, beat: 1, supervised: true, pattern: 'MT-[0-9]+', tickets: {
    'MT-1': { ...parked('A', 60, 'Which fixture should win?'), draft_pr: 961, handoff_stage: 7 },
    'MT-2': { ...parked('A', 50, 'Which copy?'), draft_pr: 962 },
  } });
  const mtPrs = { 961: 'MERGED', 962: 'OPEN' };
  const mtReads = { pr: (_r, n) => ({ v: { state: mtPrs[n], mergedAt: mtPrs[n] === 'MERGED' ? '2026-11-12T09:01:00Z' : null, isDraft: false }, err: '' }), ticket: () => 'indeterminate', git: () => null };
  const mtList = () => N.collect({ word: 'mt573' }).items.map((i) => i.t.key).sort().join();
  t('DS-573 both are listed before list reads GitHub', mtList(), 'MT-1,MT-2');
  t('DS-573 AC1 list requeues the merged one for its after-merge steps and says so',
    N.refresh({ word: 'mt573', reads: mtReads }).join(' | '), 'mt573 MT-1: PR #961 merged at 2026-11-12 09:01 UTC, and MT-1 is not done in Jira yet, so it is back with a worker for its after-merge steps only, and off your list.');
  const mt1 = queueOf('mt573').tickets['MT-1'];
  t('DS-573 AC1 it is requeued with its briefing told the PR merged, from Stage 0, and is not listed',
    `${mt1.state} ${mt1.park} ${mt1.merged_tail} ${mt1.cleared?.tail?.pr} ${mt1.handoff_stage ?? null} ${mtList()}`, 'triaged null 961 961 null MT-2');
  t('DS-573 AC3 the one whose PR is open stays parked, its question unchanged', `${queueOf('mt573').tickets['MT-2'].state} ${queueOf('mt573').tickets['MT-2'].park?.question}`, 'parked Which copy?');
  t('DS-573 a second list requeues nothing more', N.refresh({ word: 'mt573', reads: mtReads }).length, 0);

  // AC3: a worktree held for uncommitted changes is read again, and released once committed and pushed.
  const origin = join(T, 'xi546-origin.git'), wt = join(T, 'xi546-wt');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'fix/X-1', origin]);
  spawnSync('git', ['clone', '-q', origin, wt]);
  const g = (...a) => spawnSync('git', ['-C', wt, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  g('checkout', '-q', '-b', 'fix/X-1');
  writeFileSync(join(wt, 'a.txt'), 'one\n');
  g('add', 'a.txt'); g('commit', '-q', '-m', 'one'); g('push', '-q', 'origin', 'fix/X-1');
  writeFileSync(join(wt, 'a.txt'), 'two\n');
  const procWhy = `its worktree ${wt} is the working directory of pid 4242 (claude), which the pass did not start`;
  put('xi546', { port: 5548, beat: 1, supervised: true, tickets: {
    'X-1': { state: 'triaged', lane: 'A', worktree: wt, worktree_busy: { why: `its worktree ${wt} has uncommitted changes (a.txt)`, at: minsAgo(30) } },
    'X-2': { state: 'triaged', lane: 'A', worktree: wt, worktree_busy: { why: procWhy, at: minsAgo(30) } },
  } });
  const xi = () => N.collect({ word: 'xi546' }).items.map((i) => i.t.key).join();
  const live = { ...reads, git: N.READS.git };
  t('DS-546 AC3 a worktree still dirty stays held and listed', `${N.refresh({ word: 'xi546', reads: live }).length} ${xi()}`, '0 X-1,X-2');
  g('commit', '-q', '-am', 'two');
  t('DS-546 AC3 committed but not pushed: still held', `${N.refresh({ word: 'xi546', reads: live }).length} ${xi()}`, '0 X-1,X-2');
  g('push', '-q', 'origin', 'fix/X-1');
  const xs = N.refresh({ word: 'xi546', reads: live });
  t('DS-546 AC3 clean and matching origin: its hold is dropped, it says so, and it is not listed',
    `${xs.join()} ${queueOf('xi546').tickets['X-1'].worktree_busy ?? null} ${xi()}`,
    'xi546 X-1: its worktree is clean and its branch matches origin, so it is off your list; the next pass can start it. null X-2');
  t('DS-546 a worktree held by another process is left to the pass', queueOf('xi546').tickets['X-2'].worktree_busy?.why, procWhy);
}

// ---- A ticket held on its blocked-until label is not listed; one whose label's date cannot be read is, once.
{
  const until = (label) => ({ state: 'parked', lane: 'A', held_label: label, park: { question: `held by orchestrator: ${label}` } });
  put('ds555', { port: 4640, beat: 1, supervised: true, tickets: { 'U-1': until('blocked-until-2026-11-14'), 'U-2': until('blocked-until-soon'), 'U-3': { state: 'parked', lane: 'A', held_by: 'U-1', park: { question: 'held by orchestrator: blocked by U-1 — starts once their PRs merge' } } } });
  const items = N.collect({ word: 'ds555' }).items;
  t('DS-555 AC4 a ticket held until a date is not listed, nor one held behind it', items.filter((i) => ['U-1', 'U-3'].includes(i.t.key)).length, 0);
  const bad = items.filter((i) => i.t.key === 'U-2');
  t('DS-555 AC3 a label whose date cannot be read is one held item naming the label, offering start',
    `${bad.length} ${bad[0]?.kind} ${/blocked-until-soon/.test(bad[0]?.need ?? '')} ${bad[0]?.actions.map((a) => a[0]).join()}`, '1 held true start,not-now');
}

// ---- A park a script settles waits on it, not on the person; one only the person settles is still listed.
{
  const waits = (question, cw) => ({ ...parked('A', 30, question), park: { question, since: minsAgo(30), clears_when: cw } });
  const claimed = (t, claim) => ({ ...t, park: { ...t.park, claim } });
  put('ds562', { port: 4650, beat: 1, supervised: true, tickets: {
    'W-1': waits('Should W-1 be held until PR #991 merges, then requeued?', { kind: 'pr-merged', pr: 991 }),
    'W-2': waits('Which price?', { kind: 'none' }),
    'W-3': waits('Make the issue links', { kind: 'links-made', links: [{ key: 'W-3', type: 'Relates', other: 'W-9' }], pr: 12 }),
    // A claimed park keeps its clears-when, but no pass settles it: it stays the session's, clean or dirty.
    'W-4': claimed(waits('Should W-4 wait for PR #992?', { kind: 'pr-merged', pr: 992 }), { session: 'sess-562', at: minsAgo(30) }),
    'W-5': claimed(waits('its worktree has uncommitted changes (a.txt)', { kind: 'pr-merged', pr: 993 }), { session: 'sess-562', at: minsAgo(60), dirty_at: minsAgo(30) }),
    'W-7': waits('Wait for the Actions run', { kind: 'run-completed', run: 44719886024 }),
  } });
  const keys = N.collect({ word: 'ds562' }).items.map((i) => i.t.key).sort().join();
  t('DS-562 AC1, AC3, AC4 a park waiting on a PR merging is not listed; one on none, on links only the person makes, or claimed by a session is', keys, 'W-2,W-3,W-4,W-5');
  const r562 = () => loadRepos().find((r) => r.name === 'ds562');
  t('DS-562 AC2 desk-q shows it waiting, not needing you', r562().rows.find((x) => x.t.key === 'W-1').k, 'waiting');
  t('DS-852 AC1 desk-q shows a park on an Actions run waiting, not needing you', r562().rows.find((x) => x.t.key === 'W-7').k, 'waiting');
  t('DS-562 AC2 its row says it waits on PR #991', repoScreen(r562(), { width: 200 }).includes('waiting on PR #991 merged'), true);
  t('DS-562 AC2 its page says it moves without you, on PR #991', ticketScreen(r562(), 'W-1', { width: 200 }).includes('Moves without you: Waiting on PR #991 merged: a pass requeues it then.'), true);
  t('DS-562 AC2 desk-q counts only the ones the person settles', N.needsCount(r562()).shown, 4);
  t('DS-562 a claimed park with a clears-when still needs its session, clean or dirty', ['W-4', 'W-5'].map((k) => r562().rows.find((x) => x.t.key === k).k).join(), 'needs,needs');
  t('DS-562 a claimed park reads as claimed, not as moving without you', ticketScreen(r562(), 'W-4', { width: 200 }).includes('Claimed by session sess-562'), true);
  // With passes stopped nothing settles it: its page says so and gives the resume step.
  put('ds562off', { port: 4651, beat: 120, tickets: { 'W-6': waits('Hold W-6 for PR #994?', { kind: 'pr-merged', pr: 994 }) } });
  const off = ticketScreen(loadRepos().find((r) => r.name === 'ds562off'), 'W-6', { width: 200 });
  t('DS-562 passes stopped: its page says it will not move until they resume, waiting on PR #994', off.includes('Will not move until passes resume: waiting on PR #994 merged: a pass requeues it then.'), true);
}

// #925: a park waiting on an outside reviewer's review of the PR names no step of the person's, so it
// waits and needs-you does not count it.
{
  const rv = { ...parked('A', 30, 'Wait for agent-pullbot to review PR #3468 at the head'), park: { question: 'Wait for agent-pullbot to review PR #3468 at the head', since: minsAgo(30), clears_when: { kind: 'pr-reviewed', pr: 3468, login: 'agent-pullbot' } } };
  put('i925', { port: 4652, beat: 1, supervised: true, tickets: { 'R-1': rv, 'R-2': { ...parked('A', 30, 'Which price?'), park: { question: 'Which price?', since: minsAgo(30), clears_when: { kind: 'none' } } } } });
  const r925 = loadRepos().find((r) => r.name === 'i925');
  t('#925 a park cleared by a PR review is not listed by needs-you', N.collect({ word: 'i925' }).items.map((i) => i.t.key).join(), 'R-2');
  t('#925 desk-q shows it waiting, and counts only the one the person settles', `${r925.rows.find((x) => x.t.key === 'R-1').k} ${N.needsCount(r925).shown}`, 'waiting 1');
}

// A ticket held behind `by`, and the keys needs-you lists for batch `name`, for the blocks below.
const behind = (k, by) => ({ state: 'parked', lane: 'A', held_by: by, park: { question: `held by orchestrator: blocked by ${by} — starts once their PRs merge (${k})` } });
const keysIn = (name) => N.collect({ word: name }).items.map((i) => i.t.key);

// ---- A put-off item with 3 or more held tickets behind it, directly or through another, is listed first.
{
  put('ds600a', { port: 4650, beat: 1, supervised: true, tickets: { 'O-1': parked('A', 300, 'Older question?'), 'P-1': parked('A', 60, 'Which price?'),
    'H-1': behind('H-1', 'P-1'), 'H-2': behind('H-2', 'P-1'), 'H-3': behind('H-3', 'P-1') } });
  const off1 = N.record({ word: 'ds600a', ticket: 'P-1', action: 'not-now' });
  t('DS-600 AC4 not-now on it says it stays listed while 3 or more wait behind it', `${off1.ok} ${off1.line.includes('It is still listed while 3 or more tickets wait behind it (3 do now).')}`, 'true true');
  const a = N.collect({ word: 'ds600a' });
  t('DS-600 AC1 a put-off park with 3 held behind it is listed first, saying so',
    `${a.items[0]?.t.key} ${a.items[0]?.need} ${a.putOff}`, 'P-1 Which price? (3 tickets wait behind it, so it is listed though you put it off) 0');
  t('DS-600 AC1 desk-q counts it as needing you', N.needsCount(loadRepos().find((r) => r.slug === 'acme__ds600a')).putOff, 0);
  const off2 = N.record({ word: 'ds600a', ticket: 'P-1', action: 'not-now' });
  t('DS-600 AC4 put off again, it is still listed on the next run, and the answer says so', `${off2.ok} ${/still listed/.test(off2.line)} ${keysIn('ds600a')[0]}`, 'true true P-1');

  put('ds600b', { port: 4651, beat: 1, supervised: true, tickets: { 'P-1': parked('A', 60, 'Which price?'), 'H-1': behind('H-1', 'P-1'), 'H-2': behind('H-2', 'P-1') } });
  const off3 = N.record({ word: 'ds600b', ticket: 'P-1', action: 'not-now' });
  const b = N.collect({ word: 'ds600b' });
  t('DS-600 AC2 with 2 held behind it, it stays left out and counted put off, as today',
    `${off3.line.includes('still listed')} ${b.items.some((i) => i.t.key === 'P-1')} ${b.putOff}`, 'false false 1');

  put('ds600c', { port: 4652, beat: 1, supervised: true, tickets: { 'P-1': parked('A', 60, 'Which price?'), 'H-1': behind('H-1', 'P-1'), 'H-2': behind('H-2', 'H-1'), 'H-3': behind('H-3', 'H-1') } });
  N.record({ word: 'ds600c', ticket: 'P-1', action: 'not-now' });
  const c = N.collect({ word: 'ds600c' }).items.find((i) => i.t.key === 'P-1');
  t('DS-600 AC3 one held ticket holding 2 more counts 3 behind it, and it is listed', `${c?.behind} ${/3 tickets wait behind it/.test(c?.need ?? '')}`, '3 true');

  put('ds600d', { port: 4653, beat: 1, supervised: true, merge: 'yes', people: { 'Code reviewer': 'Chris Anthony (@mousedown)' },
    tickets: { 'V-1': gateStuck(121, protectedLine), 'H-1': behind('H-1', 'V-1'), 'H-2': behind('H-2', 'V-1'), 'H-3': behind('H-3', 'V-1') } });
  const wait = N.record({ word: 'ds600d', ticket: 'V-1', action: 'waiting' });
  t('DS-600 AC4 waiting on a PR with 3 held behind it says it stays listed, and it is', `${wait.ok} ${wait.line.includes('It is still listed while 3 or more tickets wait behind it (3 do now).')} ${keysIn('ds600d')[0]}`, 'true true V-1');
}

// ---- A park whose own blockers are open is not listed, put off or not; the put-off override
// moves to the ticket first in its chain, and a count behind a ticket counts each ticket once.
{
  const nine = (by) => Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`H-${i + 1}`, behind(`H-${i + 1}`, by)]));
  const laneC = (by) => ({ ...parked('C', 90, 'lane C — spans layers'), held_by: by });
  const qPath = (name) => join(env.DESK_HOME, 'repos', `acme__${name}`, 'queue.json');
  const edit = (name, f) => { const q = queueOf(name); f(q.tickets); writeFileSync(qPath(name), JSON.stringify(q)); };

  // AC6 first: with no open blockers, put off with nine behind it, it is listed with the count, as today.
  put('ds716a', { port: 4716, beat: 1, supervised: true, tickets: { 'S-1': { state: 'running', lane: 'A' }, 'C-1': laneC(null), ...nine('C-1') } });
  const off = N.record({ word: 'ds716a', ticket: 'C-1', action: 'not-now' });
  const c1 = N.collect({ word: 'ds716a' }).items.find((i) => i.t.key === 'C-1');
  t('DS-716 AC6 a lane C park with no open blockers, put off with 9 behind it, is listed with the count',
    `${off.ok} ${c1?.kind} ${c1?.behind} ${/9 tickets wait behind it/.test(c1?.need ?? '')}`, 'true session 9 true');
  // AC1 and AC2: held behind its unmerged sibling, it is not listed, and desk-q shows it waiting behind it.
  edit('ds716a', (ts) => { ts['C-1'].held_by = 'S-1'; });
  const a = N.collect({ word: 'ds716a' });
  t('DS-716 AC1/AC2 put off with 9 behind it and held behind an unmerged sibling, it is not listed', a.items.some((i) => i.t.key === 'C-1'), false);
  const ra = loadRepos().find((r) => r.name === 'ds716a');
  t('DS-716 AC1 desk-q shows it waiting, not needing you', ra.rows.find((x) => x.t.key === 'C-1')?.k, 'waiting');
  t('DS-716 AC1 its page says it moves without you, behind the sibling', ticketScreen(ra, 'C-1', { width: 200 }).includes('Moves without you: behind S-1 (running, stage'), true);
  t('DS-716 AC1 desk-q counts nothing for it', N.needsCount(ra).shown, 0);
  // Never put off, it is not listed either.
  put('ds716b', { port: 4726, beat: 1, supervised: true, tickets: { 'S-1': { state: 'triaged', lane: 'A' }, 'C-1': laneC('S-1') } });
  t('DS-716 AC1 a lane C park behind a sibling waiting to spawn is not listed', keysIn('ds716b').join(), '');

  // AC3: the ticket first in its chain parks on a question only the person answers: it is listed, and put off it is
  // still listed, with every ticket waiting behind it counted (the put-off park and its nine).
  put('ds716c', { port: 4718, beat: 1, supervised: true, tickets: { 'S-1': parked('A', 60, 'Which price?'), 'C-1': laneC('S-1'), ...nine('C-1') } });
  N.record({ word: 'ds716c', ticket: 'C-1', action: 'not-now' });
  t('DS-716 AC3 the chain head is listed in place of the put-off park', keysIn('ds716c').join(), 'S-1');
  N.record({ word: 'ds716c', ticket: 'S-1', action: 'not-now' });
  const s1 = N.collect({ word: 'ds716c' }).items;
  t('DS-716 AC3 put off too, the head is still listed with the count of tickets waiting behind it',
    `${s1.map((i) => i.t.key).join()} ${s1[0]?.behind} ${/10 tickets wait behind it/.test(s1[0]?.need ?? '')}`, 'S-1 10 true');

  // AC4: the head is a PR running its checks, which merges without the person: nothing is listed for the chain.
  put('ds716d', { port: 4719, beat: 1, supervised: true, merge: 'yes', tickets: {
    'S-1': { state: 'done', lane: 'A', result: { pr: 716 }, pr_status: { pr: 716, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', checks: [{ name: 'build', status: 'in_progress', conclusion: null, startedAt: minsAgo(5) }] } },
    'C-1': laneC('S-1'), ...nine('C-1') } });
  N.record({ word: 'ds716d', ticket: 'C-1', action: 'not-now' });
  t('DS-716 AC4 a chain whose head is a PR running CI lists nothing', keysIn('ds716d').join(), '');

  // AC5: a fork to two heads that both need the person, both put off: both are listed, in build order
  // (S-2 is queued first, so not key order), the same every run.
  put('ds716e', { port: 4720, beat: 1, supervised: true, tickets: { 'S-2': parked('A', 60, 'Which copy?'), 'S-1': parked('A', 60, 'Which price?'), 'C-1': laneC('S-2|S-1'), ...nine('C-1') } });
  for (const k of ['C-1', 'S-1', 'S-2']) N.record({ word: 'ds716e', ticket: k, action: 'not-now' });
  const runs = [keysIn('ds716e').join(), keysIn('ds716e').join()];
  t('DS-716 AC5 both heads are listed in build order, and the put-off park is not', runs[0], 'S-2,S-1');
  t('DS-716 AC5 in the same order every run', runs[1], runs[0]);

  // A lane C park held only behind a step only the person takes, in no batch: the step is listed, with
  // the park waiting on it, and the park is not listed as well, put off or not.
  const input = { key: 'OPS-7', category: 'new', type: 'Task', summary: 'Record the webhook payload', labels: ['ben-input'] };
  put('ds716g', { port: 4722, beat: 1, supervised: true, inputLabels: 'ben-input', tickets: { 'C-1': { ...laneC('OPS-7'), held_outside: 'OPS-7' }, ...nine('C-1') },
    triage: { 'C-1': { blockers: [input] } } });
  N.record({ word: 'ds716g', ticket: 'C-1', action: 'not-now' });
  const g = N.collect({ word: 'ds716g' }).items;
  t('DS-716 a lane C park behind a person\'s step is listed once, as the step, which names it waiting',
    `${g.map((i) => i.t.key).join()} ${g[0]?.waiting.join()}`, 'step:OPS-7 C-1');
  t('DS-716 desk-q counts the step once and not the park behind it', N.needsCount(loadRepos().find((r) => r.name === 'ds716g')).shown, 1);

  // Two lane C parks held behind each other: a cycle nothing releases, so both are listed for their questions.
  put('ds716h', { port: 4723, beat: 1, supervised: true, tickets: { 'C-1': laneC('C-2'), 'C-2': laneC('C-1') } });
  t('DS-716 two lane C parks held behind each other are both listed, not both waiting', keysIn('ds716h').join(), 'C-1,C-2');

  // AC7: lane C parks held in a chain, and a held ticket behind two of them: each is counted once.
  put('ds716f', { port: 4721, beat: 1, supervised: true, tickets: { 'S-1': parked('A', 60, 'Which price?'), 'C-1': laneC('S-1'), 'C-2': laneC('S-1|C-1'),
    'H-1': behind('H-1', 'C-1|C-2'), 'H-2': behind('H-2', 'C-2') } });
  N.record({ word: 'ds716f', ticket: 'S-1', action: 'not-now' });
  const f = N.collect({ word: 'ds716f' }).items;
  t('DS-716 AC7 the count behind the head counts each ticket once, and neither lane C park is listed',
    `${f.map((i) => i.t.key).join()} ${f[0]?.behind} ${/4 tickets wait behind it/.test(f[0]?.need ?? '')}`, 'S-1 4 true');
}

// ---- DS-580: a park on a step only a person or another account takes recommends nothing, and its resume
// reads the PR on GitHub (stubbed here) and requeues only once it changed since the park.
{
  const PO = 'There is no review from agent-pullbot at all. No worker can run it: only a person with Mac mini or org access can do this.';
  const STEP = 'No worker can run it: only a person with Mac mini or org access can do this.';
  const HEAD = 'a'.repeat(40);
  // As a worker leaves it: a draft PR and a park, and no PR state recorded (pass.mjs records that only once done).
  const po = (m, pr) => ({ ...parked('B', m, PO), draft_pr: pr });
  const DECIDE = 'Only you can decide between A and B. Which should I use? I recommend A.';
  put('ds580', { port: 4580, beat: 1, supervised: true, tickets: {
    'PO-1': po(60, 951), 'PO-2': po(50, 952), 'PO-3': po(40, 953), 'PO-4': po(30, 954),
    'Q-1': parked('B', 20, 'Retry or fail? I recommend retry.'), 'Q-2': { ...parked('B', 15, DECIDE), draft_pr: 955 },
  } });
  const before = minsAgo(600);
  const later = new Date(NOW).toISOString();
  const red = (at) => [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: at }];
  const green = (at) => [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: at }];
  const old = { commits: [{ oid: HEAD, committedDate: before }], reviews: [{ state: 'COMMENTED', submittedAt: before }] };
  const gh = {
    951: { state: 'OPEN', isDraft: true, headRefOid: HEAD, ...old, statusCheckRollup: red(before) },
    952: { state: 'OPEN', isDraft: true, headRefOid: HEAD, ...old, reviews: [{ state: 'COMMENTED', author: { login: 'agent-pullbot' }, submittedAt: later }], statusCheckRollup: red(before) },
    954: { state: 'OPEN', isDraft: true, headRefOid: 'b'.repeat(40), commits: [{ oid: 'b'.repeat(40), committedDate: later }], reviews: [], statusCheckRollup: [] },
    955: { state: 'OPEN', isDraft: true, headRefOid: HEAD, ...old, statusCheckRollup: [] },
  };
  const reads = { pr: (_r, n, more) => (gh[n] ? { v: more.includes('commits') ? gh[n] : { state: gh[n].state }, err: '' } : { v: null, err: 'HTTP 502' }), ticket: () => null, git: () => null };
  const items = () => Object.fromEntries(N.collect({ word: 'ds580' }).items.map((i) => [i.t.key, i]));
  const p1 = items()['PO-1'];
  t('DS-580 AC3 a person-only park marks no action recommended', `${p1?.kind} ${p1?.actions.map((a) => a[0]).join()} ${p1?.actions.some((a) => a[1])}`, 'parked resume,drop,not-now false');
  t('DS-580 AC3 its need names the step only a person or another account takes', p1?.need, `a step only you or another account takes: ${STEP} (${PO})`);
  t('DS-580 AC7 a park asking the worker a question still recommends resume', `${items()['Q-1']?.actions[0][0]} ${!!items()['Q-1']?.actions[0][1]}`, 'resume true');
  t('DS-580 AC7 a call only the person makes ("only you can decide") still recommends resume', `${items()['Q-2']?.actions[0][0]} ${!!items()['Q-2']?.actions[0][1]}`, 'resume true');
  const rq = N.record({ word: 'ds580', ticket: 'Q-2', action: 'resume', text: 'use A', reads });
  t('DS-580 AC7 its answer requeues it with its PR unchanged', `${rq.ok} ${queueOf('ds580').tickets['Q-2'].state}`, 'true triaged');

  const r1 = N.record({ word: 'ds580', ticket: 'PO-1', action: 'resume', text: 'agent-pullbot has run /pullbot', reads });
  t('DS-580 AC4 resume on a PR unchanged since the park requeues nothing, and names what GitHub shows',
    `${r1.ok} ${r1.line} ${queueOf('ds580').tickets['PO-1'].state}`,
    'false ds580 PO-1: GitHub shows PR #951 unchanged since the park (head aaaaaaa, no commit, review or passing check since it parked, and a failing check, "ci"), so nothing was recorded or requeued: a worker would park again. Resume once the step shows on the PR. parked');
  const r2 = N.record({ word: 'ds580', ticket: 'PO-2', action: 'resume', text: 'agent-pullbot has run /pullbot', reads });
  t('DS-580 AC5 resume on a PR with a review since the park requeues it as today', `${r2.ok} ${queueOf('ds580').tickets['PO-2'].state}`, 'true triaged');
  const r3 = N.record({ word: 'ds580', ticket: 'PO-3', action: 'resume', text: 'done', reads });
  t('DS-580 AC6 resume on a PR GitHub cannot read requeues nothing, saying so', `${r3.ok} ${r3.line} ${queueOf('ds580').tickets['PO-3'].state}`,
    'false ds580 PO-3: could not read PR #953 from GitHub (HTTP 502), so nothing was recorded or requeued, and it stays on your list. parked');
  const r4 = N.record({ word: 'ds580', ticket: 'PO-4', action: 'resume', text: 'pushed the fix', reads });
  t('DS-580 a draft PR with no recorded state and a commit since the park is requeued', `${r4.ok} ${queueOf('ds580').tickets['PO-4'].state}`, 'true triaged');
  const since = (rollup) => N.prSincePark(po(10, 9), { headRefOid: HEAD, ...old, statusCheckRollup: rollup }).changed;
  t('DS-580 a red check gone green since the park counts as a change', since(green(later)), true);
  t('DS-580 a check rerun since the park and still red does not', since(red(later)), false);
  t('DS-580 a park with no time to compare against resumes as before', N.prSincePark({ park: {} }, gh[951]).changed, true);
  const { personOnlyStep } = await import('../desk/bin/batch-state.mjs');
  t('DS-580 each branch alone reads as person-only', [personOnlyStep('No worker can run it.'), personOnlyStep('Only agent-pullbot can post its review.')].join('|'),
    'No worker can run it.|Only agent-pullbot can post its review.');
  t('DS-580 a call, a product role or a passing "only" is not person-only',
    [DECIDE, 'The diff touches only user-facing copy, so could I skip the E2E run?', 'Only admins can delete invoices today. Should managers also be able to?',
      'It touches only the bot config, which could break CI. Proceed?', 'The only user-facing option I could find is a toggle. Toggle or modal?', 'Only you can decide whether I can push this change. Should I proceed?'].map(personOnlyStep).join(), ',,,,,');
}

// DS-601: an answer for a ticket a pass moved on since it was listed is kept for its next worker.
{
  // A running worker with a session, and a queued ticket requeued with a one-off grant: answer.mjs
  // would write the mailbox and take the grant back.
  const grant = { branch: 'fix/m-2', lease: 'abc123', at: minsAgo(10) };
  put('moved', { port: 3601, beat: 1, supervised: true, tickets: {
    'M-1': { state: 'running', lane: 'A', stage: '3/9', session_id: 'sess-m1' },
    'M-2': { state: 'queued', lane: 'A', grant },
    'M-3': { state: 'done', lane: 'A', merged_at: minsAgo(5), result: { pr: 70 }, pr_status: { pr: 70, state: 'MERGED' } },
  } });
  const dir = join(env.HOME, '.desk-autopilot', 'acme__moved');
  const brief = (k) => { const f = join(dir, 'briefings', `${k}.md`); return existsSync(f) ? readFileSync(f, 'utf8') : ''; };
  const queueText = () => JSON.stringify(queueOf('moved'));
  const q0 = queueText(), before = answers().length;
  const m1 = N.record({ word: 'moved', ticket: 'M-1', action: 'answer', text: 'keep the gap as it is' });
  t('DS-601 AC1 an answer for a ticket no longer listed is saved in its briefing, and the reply says so',
    `${m1.ok} ${m1.line} ${brief('M-1').includes('## Answer from the user') && brief('M-1').includes('keep the gap as it is')}`,
    'true moved M-1: no longer waiting on you; your answer is saved in its briefing for its next worker. true');
  t('DS-601 AC1 a running worker gets no mailbox answer for a park it has not made', existsSync(join(dir, 'answers', 'M-1.txt')), false);
  const m2 = N.record({ word: 'moved', ticket: 'M-2', action: 'resume', text: 'use the short copy' });
  t('DS-601 AC2 a resume with text is saved the same way, and its queue entry is unchanged, grant included',
    `${m2.ok} ${brief('M-2').includes('## Answer from the user') && brief('M-2').includes('use the short copy')} ${queueText() === q0} ${answers().length - before}`, 'true true true 0');
  const b1 = brief('M-1');
  const m3 = N.record({ word: 'moved', ticket: 'M-1', action: 'requeue', text: 'try again' });
  t('DS-601 AC3 requeue is refused as today and writes nothing',
    `${m3.ok} ${m3.line} ${brief('M-1') === b1} ${queueText() === q0}`, 'false moved M-1: desk-q does not count it as needing you, so nothing was recorded. true true');
  const m4 = N.record({ word: 'moved', ticket: 'M-9', action: 'answer', text: 'x' });
  t('DS-601 AC4 a ticket in no queue of the repo is refused as today and writes nothing', `${m4.ok} ${brief('M-9')} ${queueText() === q0}`, 'false  true');
  const m5 = N.record({ word: 'moved', ticket: 'M-3', action: 'answer', text: 'x' });
  t('DS-601 a ticket whose PR merged can spawn no worker, so it is refused and writes nothing', `${m5.ok} ${brief('M-3')} ${queueText() === q0}`, 'false  true');
  t('DS-601 an answer with no text is refused', `${N.record({ word: 'moved', ticket: 'M-1', action: 'answer', text: ' ' }).ok} ${brief('M-1') === b1}`, 'false true');
}

// DS-609: a file an answer names is copied into the ticket's fixtures before the requeue.
{
  const { openSync, ftruncateSync, closeSync } = await import('node:fs');
  put('ds609', { port: 3609, beat: 1, supervised: true, tickets: Object.fromEntries(['F-1', 'F-2', 'F-3', 'F-4', 'F-5'].map((k) => [k, parked('A', 30, 'I need a real capture from a test Meet')])) });
  const fx = (k) => join(env.HOME, '.desk-autopilot', 'acme__ds609', 'fixtures', k);
  const ls = (d) => (existsSync(d) ? readdirSync(d).sort().join() : '-');
  const cap = join(T, 'AA-48-recall-capture');
  mkdirSync(join(cap, 'sub'), { recursive: true });
  writeFileSync(join(cap, 'capture.json'), '{"a":1}');
  writeFileSync(join(cap, 'notes.txt'), 'meet');
  writeFileSync(join(cap, '.DS_Store'), 'x');
  const f1 = N.record({ word: 'ds609', ticket: 'F-1', action: 'resume', text: `Saved the capture in ${cap}/.` });
  t('DS-609 AC1 the named folder\'s files are in fixtures/<TICKET>/ and the ticket is requeued', `${f1.ok} ${ls(fx('F-1'))} ${queueOf('ds609').tickets['F-1'].state}`, 'true capture.json,notes.txt triaged');
  t('DS-609 AC1 the reply names what was copied', f1.line.includes(`Copied ${cap} into ${fx('F-1')}/ for its next worker: capture.json, notes.txt.`), true);
  t('DS-609 the answer is recorded as written', answers().at(-1).args.join('|'), `F-1|--all|Saved the capture in ${cap}/.`);

  const gone = join(T, 'no-such-capture');
  const f2 = N.record({ word: 'ds609', ticket: 'F-2', action: 'resume', text: `It is in ${gone}` });
  t('DS-609 AC2 a path not found copies nothing, records the answer, and says so', `${f2.ok} ${ls(fx('F-2'))} ${answers().at(-1).args[0]} ${f2.line.includes(`${gone} was not found, so nothing was copied from it.`)}`, 'true - F-2 true');

  mkdirSync(fx('F-3'), { recursive: true });
  writeFileSync(join(fx('F-3'), 'capture.json'), '{}');
  const f3 = N.record({ word: 'ds609', ticket: 'F-3', action: 'resume', text: `Saved it at ${join(fx('F-3'), 'capture.json')}` });
  t('DS-609 AC3 a path already under fixtures/<TICKET>/ copies nothing', `${f3.ok} ${ls(fx('F-3'))} ${/Copied|not copied|not found/.test(f3.line)}`, 'true capture.json false');

  const big = join(T, 'big-capture');
  mkdirSync(big);
  const fd = openSync(join(big, 'recording.bin'), 'w');
  ftruncateSync(fd, 51 * 1024 * 1024);
  closeSync(fd);
  const f4 = N.record({ word: 'ds609', ticket: 'F-4', action: 'resume', text: `see ${big}` });
  t('DS-609 AC4 a folder over 50 MB copies nothing, records the answer, and says it is too large', `${f4.ok} ${ls(fx('F-4'))} ${answers().at(-1).args[0]} ${f4.line.includes(`${big} is too large to copy (51 MB, over 50 MB), so nothing was copied from it.`)}`, 'true - F-4 true');

  const hidden = join(T, '.ssh');
  mkdirSync(hidden);
  writeFileSync(join(hidden, 'id_rsa'), 'secret');
  const f5 = N.record({ word: 'ds609', ticket: 'F-5', action: 'resume', text: `the key is ${join(hidden, 'id_rsa')}, and ~/ is home` });
  const { pathsIn } = await import('../desk/bin/live-read.mjs');
  t('DS-609 a slash command or URL in an answer is not a path', pathsIn('ran /pullbot and /desk-ticket A-1, see https://x.io/a/b or (/tmp/cap/a.json).', '/h').join(), '/tmp/cap/a.json');
  t('DS-609 a file in a hidden folder, or home itself, is never copied', `${f5.ok} ${ls(fx('F-5'))} ${f5.line.includes('was not copied: it is in a hidden folder.')} ${f5.line.includes('was not copied: it is your home folder or above it.')}`, 'true - true true');
  t('DS-609 a quoted or escaped path keeps its spaces', JSON.stringify(pathsIn('In "/tmp/Meet capture" and `/tmp/b c/d.json`, /tmp/Screen\\ Recording.mov, and it\'s at \'/tmp/x y\'.', '/h')), JSON.stringify(['/tmp/Meet capture', '/tmp/b c/d.json', '/tmp/Screen Recording.mov', '/tmp/x y']));

  const spaced = join(T, 'Meet capture');
  mkdirSync(spaced);
  writeFileSync(join(spaced, 'meet.json'), '{}');
  const lib = join(env.HOME, 'Library', 'Cookies');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, 'Cookies.binarycookies'), 'secret');
  put('ds609b', { port: 3610, beat: 1, supervised: true, tickets: Object.fromEntries(['F-6', 'F-7', 'F-9'].map((k) => [k, parked('A', 30, 'I need a real capture from a test Meet')])) });
  const fxb = (k) => join(env.HOME, '.desk-autopilot', 'acme__ds609b', 'fixtures', k);
  const f7 = N.record({ word: 'ds609b', ticket: 'F-7', action: 'resume', text: `It is in "${spaced}", not ~/Library/Cookies` });
  t('DS-609 a quoted folder with a space is copied, and ~/Library never is', `${f7.ok} ${ls(fxb('F-7'))} ${f7.line.includes('/Library/Cookies was not copied: it is in ~/Library')}`, 'true meet.json true');
  if (['darwin', 'win32'].includes(process.platform)) {
    const { saveNamedFixtures } = await import('../desk/bin/live-read.mjs');
    const odd = saveNamedFixtures({ state: join(T, 'ds609-case-state'), key: 'F-8', text: `~/library/cookies and ${join(env.HOME, 'Library', 'Cookies').toUpperCase()}`, home: env.HOME });
    t('DS-609 ~/Library spelled in another case is never copied either', `${odd.copied.length} ${odd.refused.filter((x) => x.why.startsWith('it is in ~/Library')).length}`, '0 2');
  }

  const [ca, cb] = [join(T, 'cap-a'), join(T, 'cap-b')];
  for (const d of [ca, cb]) { mkdirSync(d); writeFileSync(join(d, 'data.csv'), d); }
  writeFileSync(join(ca, 'notes.txt'), 'new');
  mkdirSync(fxb('F-6'), { recursive: true });
  writeFileSync(join(fxb('F-6'), 'notes.txt'), 'old');
  const f6 = N.record({ word: 'ds609b', ticket: 'F-6', action: 'resume', text: `old is ${ca} and new is ${cb}` });
  t('DS-609 a second file of the same name is not copied over the first, and says so', `${readFileSync(join(fxb('F-6'), 'data.csv'), 'utf8') === ca} ${f6.line.includes(`${join(cb, 'data.csv')} was not copied: a file named data.csv was already copied from ${ca}`)} ${f6.line.includes(`Copied ${cb}`)}`, 'true true false');
  t('DS-609 a file already in the fixtures folder that a copy replaces is named', `${readFileSync(join(fxb('F-6'), 'notes.txt'), 'utf8')} ${f6.line.includes('That replaced the copies already there of notes.txt.')}`, 'new true');

  const cc = join(T, 'cap-c');
  mkdirSync(cc); writeFileSync(join(cc, 'kept'), 'incoming');
  mkdirSync(join(fxb('F-9'), 'kept'), { recursive: true });
  writeFileSync(join(fxb('F-9'), 'kept', 'mine.txt'), 'person');
  const f9 = N.record({ word: 'ds609b', ticket: 'F-9', action: 'resume', text: `see ${cc}` });
  t('DS-609 a folder in the fixtures folder is never removed for a same-named file', `${f9.ok} ${readFileSync(join(fxb('F-9'), 'kept', 'mine.txt'), 'utf8')} ${f9.line.includes(`${join(cc, 'kept')} was not copied: ${join(fxb('F-9'), 'kept')} is a folder, which is never replaced.`)}`, 'true person true');
}

// With the row reading failure-class, the park of a ticket pinned without it is listed as
// with the lever off: the same line, word for word, as the same park under a row of none.
{
  const pinOff = { ...parked('A', 45, 'Which reviewer handle goes in the PR body?'), levers: { set: [], at: minsAgo(60) } };
  put('pinoff', { port: 3910, beat: 1, tickets: { 'P-1': pinOff } });
  put('pinon', { port: 3911, beat: 1, tickets: { 'P-1': pinOff } });
  const cfg = join(env.DESK_CONFIG_ROOT, 'repos', 'acme__pinon', 'config.md');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('| Batches run by |', '| Phase 0 levers | `none` | `failure-class` |\n| Batches run by |'));
  // One clock for both reads, so a slow run cannot put a minute between the two ages.
  const now = Date.now();
  const lineOf = (word) => N.listText(N.collect({ word, now }), now).split('\n').find((l) => l.startsWith(`${word} P-1 `))?.split(word).join('<repo>');
  t('DS-639 AC6 the park is listed', !!lineOf('pinon'), true);
  t('DS-639 AC6 a row reading failure-class lists a ticket pinned without it as with the lever off', lineOf('pinon'), lineOf('pinoff'));
}

// ---- DS-742: a ticket queue.mjs stop held is listed held, and start lets the next pass start it.
put('ds742', { port: 5742, beat: 1, tickets: {
  'P-1': { state: 'parked', lane: 'A', held_by: null, branch: 'fix/P-1', last_round: { stage: '5/9', question: 'stopped', at: minsAgo(5) },
    park: { question: 'held by orchestrator: stopped by queue.mjs stop at 2026-11-17T10:00:00.000Z; its work so far is committed as 0123456789ab on fix/P-1. Starts again only once you let it', since: minsAgo(5) } },
} });
{
  const it = N.collect({ word: 'ds742' }).items.find((i) => i.t.key === 'P-1');
  t('DS-742 AC2 a stopped ticket is listed held, with start recommended', `${it?.kind} ${it?.need} ${it?.actions.map((a) => a[0]).join()}`, 'held its worker was stopped: let it start start,not-now');
  const st = N.record({ word: 'ds742', ticket: 'P-1', action: 'start' });
  const p1 = queueOf('ds742').tickets['P-1'];
  t('DS-742 AC3 start makes it triaged with its branch and stage kept, so the next pass starts it there', `${st.ok} ${p1.state} ${p1.park} ${p1.branch} ${p1.last_round?.stage}`, 'true triaged null fix/P-1 5/9');
}

// A batch held as a chain of 30, each ticket behind every one before it as plan-batch holds tickets
// sharing a file, lists in under a second more than the same 30 tickets unheld. What `needs-you list` runs, in
// this process, timed against the unheld batch so the many fixture repos above are not counted.
{
  const listMs = (tickets) => {
    put('ds793', { port: 4793, beat: 1, supervised: true, tickets });
    const start = Date.now();
    const repos = loadRepos();
    N.refresh({ word: 'ds793', repos });
    N.listText(N.collect({ word: 'ds793', repos }));
    return Date.now() - start;
  };
  const flat = { 'H-0': { state: 'running', lane: 'A' } };
  const chain = { ...flat };
  for (let i = 1; i <= 30; i++) {
    flat[`H-${i}`] = { state: 'triaged', lane: 'A' };
    chain[`H-${i}`] = behind(`H-${i}`, Array.from({ length: i }, (_, j) => `H-${j}`).join('|'));
  }
  const unheld = listMs(flat);
  const held = listMs(chain);
  t('DS-793 AC3 needs-you list on a batch held as a chain of 30 takes under a second more than unheld', held - unheld < 1000, true);
}

// Refusals.
t('an item desk-q does not count records nothing', N.record({ word: 'alpha', ticket: 'A-5', action: 'requeue', text: 'try again' }).ok, false);
t('an unknown repo exits 11', cli('record', 'nosuchrepo', 'Z-1', 'done').code, 11);

// ---- DS-795 AC1: one needs-you listing reads each triage record from disk once, however many step items
// scan the held tickets and however many triage questions ask for their text.
{
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const fsCjs = createRequire(import.meta.url)('node:fs');
  const realReadFileSync = fsCjs.readFileSync;
  const reads = new Map();
  const dir = join('acme__omicron795', 'triage');
  const tickets = {}, triage = {};
  for (let i = 1; i <= 4; i++) {
    tickets[`H-${i}`] = { state: 'parked', lane: 'A', held_by: `OPS-${i}`, held_outside: `OPS-${i}`, park: { question: `held by orchestrator: blocked by OPS-${i}` } };
    triage[`H-${i}`] = { blockers: [{ key: `OPS-${i}`, category: 'new', type: 'Task', summary: `Step ${i}`, labels: ['ben-input'] }] };
    tickets[`Q-${i}`] = { state: 'triaged', lane: 'A', open_questions: 1, added_at: minsAgo(60) };
    triage[`Q-${i}`] = { unknowns: [`Which way for Q-${i}?`] };
  }
  put('omicron795', { port: 5795, beat: 1, supervised: true, inputLabels: 'ben-input', tickets, triage });
  fsCjs.readFileSync = function (p, ...rest) {
    const s = String(p);
    if (s.includes(dir)) reads.set(s, (reads.get(s) ?? 0) + 1);
    return realReadFileSync.call(this, p, ...rest);
  };
  syncBuiltinESMExports();
  let items;
  try { items = N.collect({ word: 'omicron795' }).items; } finally { fsCjs.readFileSync = realReadFileSync; syncBuiltinESMExports(); }
  t('DS-795 AC1 the listing has the four step items and the four triage questions',
    items.map((i) => `${i.t.key} ${i.kind}`).sort().join(), 'Q-1 triage,Q-2 triage,Q-3 triage,Q-4 triage,step:OPS-1 step,step:OPS-2 step,step:OPS-3 step,step:OPS-4 step');
  t('DS-795 AC1 a triage question still reads its text from the record', items.find((i) => i.t.key === 'Q-2')?.need, 'Which way for Q-2?');
  t('DS-795 AC1 one needs-you listing reads every triage record', reads.size, 8);
  t('DS-795 AC1 and reads each from disk once', Math.max(...reads.values()), 1);
}

// ---- DS-799: a ticket stopped or held outside its batch in repo A whose own PR merged in repo B is done.
{
  const { prStatusOf } = await import('../desk/bin/batch-state.mjs');
  const held = (by) => ({ state: 'parked', lane: 'A', held_by: by, park: { question: `held by orchestrator: blocked by ${by} — starts once their PRs merge` } });
  put('web799', { port: 5801, beat: 1, supervised: true, pattern: 'S-[0-9]+', tickets: {
    'S-1': { state: 'done', lane: 'A', result: { pr: 3324 }, merged_at: minsAgo(90) },
    'S-2': { state: 'done', lane: 'A', result: { pr: 12 }, pr_status: { pr: 12, state: 'OPEN' } },
    'S-3': { state: 'done', lane: 'A', result: { pr: 3117 }, pr_status: { pr: 3117, state: 'MERGED', merged_at: minsAgo(80) } },
    'S-6': { state: 'done', lane: 'A', result: { pr: 3330 }, merged_at: minsAgo(90) },
  } });
  // issue-<n> keys name a different ticket in each repo, so neither repo's issue-3 is the other's.
  put('own799', { port: 5802, beat: 1, supervised: true, tickets: { 'issue-3': { state: 'done', lane: 'A', result: { pr: 20 }, merged_at: minsAgo(60) } } });
  put('mine799', { port: 5803, beat: 1, supervised: true, tickets: { 'issue-3': { state: 'failed', lane: 'A' } } });
  put('zen799', { port: 5800, beat: 1, supervised: true, project: 'S', pattern: 'S-[0-9]+', tickets: {
    'S-1': { state: 'failed', lane: 'A' },
    'S-2': { state: 'failed', lane: 'A' },
    'S-3': { ...held('S-9'), held_outside: 'S-9', open_questions: 1, outside_blockers: [{ key: 'S-9', category: 'new', assignee: null }] },
    'S-4': { state: 'failed', lane: 'A' },
    'S-5': held('S-1'),
    // Requeued for more work after it merged here, then stopped: repo B's earlier merge is not this round's.
    'S-6': { state: 'failed', lane: 'A', merged_at: minsAgo(20) },
  } });
  // GitHub knows S-4's merged PR in web799 only; no repo's queue records it.
  const reads = { ...STUB, merged: (slug, key) => (slug === 'acme__web799' && key === 'S-4' ? { pr: 77, mergedAt: minsAgo(30) } : null) };
  const zen = () => Object.fromEntries(N.collect({ word: 'zen799', reads }).items.map((i) => [i.t.key, i]));
  const items = zen();
  const first = (i) => `${i?.kind} | ${i?.actions[0][0]} | ${i?.actions[0][1]}`;
  t('DS-799 AC1 a stopped ticket whose PR merged in another repo recommends done, naming that PR', first(items['S-1']),
    'stopped | done | its PR #3324 merged in acme/web799: done records it done here from that PR, and the tickets held behind it can start');
  t('DS-799 AC1 its other actions stay on offer, none of them recommended', items['S-1']?.actions.slice(1).map((a) => `${a[0]}:${a[1] ?? ''}`).join(), 'requeue:,not-now:');
  t('DS-799 AC1 a PR found only on GitHub is named the same way', first(items['S-4']),
    'stopped | done | its PR #77 merged in acme/web799: done records it done here from that PR, and the tickets held behind it can start');
  t('DS-799 AC3 a ticket held outside its batch whose PR merged in another repo recommends done', `${first(items['S-3'])} | ${items['S-3']?.actions.map((a) => a[0]).join()}`,
    'held | done | its PR #3117 merged in acme/web799: done records it done here from that PR, and the tickets held behind it can start | done,admit,answer,not-now');
  t('DS-799 AC4 a stopped ticket whose PR in another repo is unmerged offers no done', items['S-2']?.actions.map((a) => a[0]).includes('done'), false);
  t('DS-799 AC4 a merge in another repo before this ticket\'s own merge here offers no done', items['S-6']?.actions.map((a) => a[0]).includes('done'), false);
  const issueReads ={ ...STUB, merged: () => ({ pr: 21, mergedAt: minsAgo(30) }) };
  const mine = N.collect({ word: 'mine799', reads: issueReads }).items.find((i) => i.t.key === 'issue-3');
  t('DS-799 AC4 an issue key merged in another repo is that repo\'s own issue, so offers no done', `${mine?.kind} ${mine?.actions.map((a) => a[0]).includes('done')}`, 'stopped false');

  const zq = () => queueOf('zen799').tickets;
  const d1 = N.record({ word: 'zen799', ticket: 'S-1', action: 'done', reads });
  const s1 = zq()['S-1'];
  t('DS-799 AC2 done records it done in repo A with repo B\'s PR', `${d1.ok} ${s1.state} ${s1.result.pr} ${/PR #3324 merged in acme\/web799/.test(s1.result.summary)}`, 'true done 3324 true');
  t('DS-799 AC2 its PR reads merged, as the pass reads it, so no pass reads #3324 as one of repo A\'s PRs',
    `${prStatusOf(s1)?.state} ${s1.pr_status.pr === s1.result.pr} ${Date.parse(s1.merged_at) === Date.parse(queueOf('web799').tickets['S-1'].merged_at)}`, 'MERGED true true');
  t('DS-799 AC2 it is off the list', zen()['S-1'], undefined);
  const d3 = N.record({ word: 'zen799', ticket: 'S-3', action: 'done', reads });
  t('DS-799 AC3 done on the held item records it as in AC2', `${d3.ok} ${zq()['S-3'].state} ${zq()['S-3'].result.pr} ${prStatusOf(zq()['S-3'])?.state} ${!!zq()['S-3'].merged_at}`, 'true done 3117 MERGED true');
  const d4 = N.record({ word: 'zen799', ticket: 'S-4', action: 'done', reads });
  t('DS-799 AC2 a PR found on GitHub is recorded the same way', `${d4.ok} ${zq()['S-4'].result.pr} ${prStatusOf(zq()['S-4'])?.state}`, 'true 77 MERGED');
  const d2 = N.record({ word: 'zen799', ticket: 'S-2', action: 'done', reads });
  t('DS-799 AC4 done on a stopped ticket with no merged PR anywhere is refused, naming its actions', `${d2.ok} ${/done is not an action for a stopped item \(requeue, not-now/.test(d2.line)} ${zq()['S-2'].state}`, 'false true failed');
}

// ---- an action a session hands the person is recorded with `ask`, and listed until done
{
  put('ask811', { port: 4811 });
  const asks = () => N.collect({ word: 'ask811' }).items.filter((i) => i.kind === 'ask');
  const a1 = cli('ask', 'ask811', 'File the follow-up issue drafted in the handoff');
  t('#811 ask records it and says so', `${a1.code} ${a1.out.trim()}`, '0 ask811 ask:1: recorded; /desk-needs-you and desk-q list it until you say done.');
  here('ask', 'ask811', 'File the follow-up issue drafted in the handoff');
  here('ask', 'ask811', 'Merge PR #12 once its checks are green');
  const items = asks();
  t('#811 a repo with no batch lists each ask once, as its own item', items.map((i) => `${i.t.key}|${i.need}|${i.actions.map((a) => a[0]).join()}`).join(' ; '),
    'ask:1|File the follow-up issue drafted in the handoff|done,not-now ; ask:2|Merge PR #12 once its checks are green|done,not-now');
  t('#811 the list shows it', here('list', 'ask811').out.split('\n').filter((l) => l.startsWith('ask811 ask:')).length, 2);
  const standing = loadRepos(Date.now(), 'ask811').find((r) => r.slug === 'acme__ask811' && r.batch == null);
  t('#811 desk-q counts both', N.needsCount(standing).shown, 2);
  const askScreen = strip(repoScreen(standing));
  t('DS-934 with no batch, the repo Queue has a row for each ask, not "Nothing to show"',
    `${/Needs you · 2\b/.test(askScreen)} ${/ask:1 +◆ needs you +File the follow-up issue/.test(askScreen)} ${/ask:2 +◆ needs you +Merge PR #12/.test(askScreen)} ${askScreen.includes('Nothing to show')}`, 'true true true false');
  const { shownRepos } = await import('../desk/bin/desk-q.mjs');
  t('#811 desk-q shows a repo whose only items are asks', shownRepos(loadRepos(Date.now()), false).some((r) => r.slug === 'acme__ask811'), true);
  t('#811 left counts them', here('left', 'ask811').out.split('\n')[0], 'desk-q counts 2 items needing you in ask811.');
  const off = N.record({ word: 'ask811', ticket: 'ask:2', action: 'not-now' });
  t('#811 not-now puts one off', `${off.ok} ${asks().map((i) => i.t.key).join()}`, 'true ask:1');
  const done = N.record({ word: 'ask811', ticket: 'ask:1', action: 'done' });
  t('#811 done takes it off the list', `${done.ok} ${done.line} ${asks().length}`, 'true ask811 ask:1: done, so it is off your list. 0');
  t('#811 an empty ask is refused', cli('ask', 'ask811', '  ').code, 11);
}

// ---- #911: a session-run batch whose passes stopped, with work autopilot could move, is one item
{
  put('stall911', { port: 4911, beat: 90, tickets: { 'S-1': { state: 'triaged', lane: 'A' }, 'S-2': { state: 'running', lane: 'A', stage: '3/9' } } });
  put('stallsup911', { port: 4912, beat: 90, supervised: true, tickets: { 'U-1': { state: 'triaged', lane: 'A' } } });
  put('stallpark911', { port: 4913, beat: 90, tickets: { 'P-1': parked('A', 60, 'Which one?') } });
  put('stalllive911', { port: 4914, beat: 1, tickets: { 'L-1': { state: 'triaged', lane: 'A' } } });
  const beatAt = (name, m) => writeFileSync(join(env.HOME, '.desk-autopilot', `acme__${name}`, 'orchestrators', 'q.json'),
    JSON.stringify({ queue: join(env.DESK_HOME, 'repos', `acme__${name}`, 'queue.json'), batch: `${name}-batch`, pid: 1, at: minsAgo(m) }));
  const stalled = (w) => N.collect({ word: w }).items.filter((i) => i.kind === 'stalled');
  const s = stalled('stall911');
  t('#911 one item for the batch, naming its last pass and how to resume it', s.length === 1 && s[0].t.key === 'stalled'
    && /^passes stopped in stall911, a batch a session runs, so nothing new starts or merges there: its last pass ran at \d{4}-\d\d-\d\d \d\d:\d\d UTC\. The session running it looks stalled: resume it, or run \/desk-autopilot in stall911$/.test(s[0].need), true);
  t('#911 its note says how long, and that its running worker carries on', s[0]?.note, 'Passes stopped 1h ago. Running workers carry on.');
  t('#911 it offers done and not-now', s[0]?.actions.map((a) => a[0]).join(), 'done,not-now');
  const standing = () => loadRepos(Date.now(), 'stall911').find((r) => r.slug === 'acme__stall911' && r.batch == null);
  t('#911 desk-q counts it', N.needsCount(standing()).shown, N.collect({ word: 'stall911' }).items.length);
  t('#911 a supervised batch is not one: its supervisor starts passes', stalled('stallsup911').length, 0);
  t('#911 nor a batch whose tickets all wait on the person', stalled('stallpark911').length, 0);
  t('#911 nor a live one', stalled('stalllive911').length, 0);
  const done = N.record({ word: 'stall911', ticket: 'stalled', action: 'done' });
  t('#911 done records nothing and says what clears it', `${done.ok} ${done.line} ${stalled('stall911').length}`, 'true stall911 stalled: noted: this item goes once a pass runs again; done records nothing. 1');
  const off = N.record({ word: 'stall911', ticket: 'stalled', action: 'not-now' });
  t('#911 not-now puts it off', `${off.ok} ${stalled('stall911').length}`, 'true 0');
  t('#911 put off where it is listed, it is put off in every scope: the whole list and desk-q\'s count', `${N.collect().items.some((i) => i.kind === 'stalled' && i.r.slug === 'acme__stall911')} ${N.needsCount(standing()).putOff}`, 'false 1');
  beatAt('stall911', 30);
  t('#911 a later stall, after a pass that ran, brings it back', stalled('stall911').length, 1);
  beatAt('stall911', 0);
  t('#911 the next pass drops it', stalled('stall911').length, 0);
}

// ---- DS-839: a park on a write awaiting approval shows its exact text under the question.
{
  const body = 'Fixed in PR #12: the park file carries the text.\n\n* AC1 met\n(AP-1/desk-ticket)';
  const question = 'JIRA COMMENT on AP-1 awaiting approval. Not reached: the Jira comment';
  put('approve839', { port: 4839, beat: 1, supervised: true, tickets: {
    'AP-1': { state: 'parked', lane: 'A', park: { question, since: minsAgo(5), approve: { kind: 'jira-comment', target: 'AP-1', body } } },
    'AP-2': { state: 'parked', lane: 'A', park: { question: 'which colour?', since: minsAgo(5) } },
  } });
  const list = N.listText(N.collect({ word: 'approve839' })).split('\n');
  const at = list.findIndex((l) => l.startsWith('approve839 AP-1 '));
  t('DS-839 AC2 the question comes first, then the kind and target', list[at + 1], '--- AP-1 awaiting approval: jira-comment on AP-1, the exact text ---');
  t('DS-839 AC2 then the body, verbatim', list.slice(at + 2, at + 2 + body.split('\n').length).join('\n'), body);
  t('DS-839 AC2 and an end line', list[at + 2 + body.split('\n').length], '--- end of AP-1\'s text awaiting approval ---');
  const other = list.findIndex((l) => l.startsWith('approve839 AP-2 '));
  t('DS-839 a park with nothing to approve has no block under it', /awaiting approval/.test(list[other + 1] ?? ''), false);
}

// ---- DS-925: an open ci-main-red issue assigned to the person is one item, read through gh on listing
{
  put('red925', { port: 4925, beat: 1, tickets: { 'R-1': { state: 'triaged', lane: 'A' } } });
  const issue = { number: 12, title: 'main is red: a CI lane on main is failing, cancelled or stale', url: 'https://github.com/acme/red925/issues/12', createdAt: minsAgo(30) };
  const reads = { ...STUB, ciRed: (r) => (r.slug === 'acme__red925' ? [issue] : []) };
  const reds = () => N.collect({ word: 'red925', reads }).items.filter((i) => i.kind === 'ci-red');
  const s = reds();
  t('DS-925 one item an issue, on the standing batch', s.map((i) => `${i.t.key} ${i.r.batch ?? 'standing'}`).join(), 'ci-red:12 standing');
  t('DS-925 its need names the issue and what to do', s[0]?.need, 'main is red in acme/red925: issue #12 (main is red: a CI lane on main is failing, cancelled or stale, https://github.com/acme/red925/issues/12) says which CI lane on main failed, was cancelled or went stale. Fix it on main, or rerun a lane that only flaked');
  t('DS-925 it offers done and not-now', s[0]?.actions.map((a) => a[0]).join(), 'done,not-now');
  writeFileSync(GH_LOG, '');
  N.needsCount(loadRepos(Date.now(), 'red925').find((r) => r.slug === 'acme__red925' && r.batch == null));
  t('DS-925 desk-q\'s count reads no gh', readFileSync(GH_LOG, 'utf8').includes('issue list'), false);
  writeFileSync(GH_LOG, '');
  N.collect({ word: 'red925', reads: { ...STUB, ciRed: N.READS.ciRed } });
  t('DS-925 listing asks gh for the open issues assigned to the person', readFileSync(GH_LOG, 'utf8').includes('issue list --repo acme/red925 --label ci-main-red --state open --assignee @me'), true);
  put('quiet925', { port: 4926 });
  const quiet = { ...STUB, ciRed: (r) => (r.slug === 'acme__quiet925' ? [{ ...issue, url: 'https://github.com/acme/quiet925/issues/12' }] : []) };
  t('DS-925 the whole list reads a quiet repo the home screen does not show', N.collect({ reads: quiet }).items.filter((i) => i.kind === 'ci-red').map((i) => `${i.r.slug} ${i.t.key}`).join(), 'acme__quiet925 ci-red:12');
  t('DS-925 no read, no item', N.collect({ word: 'red925', reads: null }).items.filter((i) => i.kind === 'ci-red').length, 0);
  const done = N.record({ word: 'red925', ticket: 'ci-red:12', action: 'done', reads });
  t('DS-925 done records nothing and says what clears it', `${done.ok} ${done.line} ${reds().length}`, 'true red925 ci-red:12: noted: this item goes once the alarm closes the issue, when every CI lane on main is green and fresh; done records nothing. 1');
  const off = N.record({ word: 'red925', ticket: 'ci-red:12', action: 'not-now', reads });
  t('DS-925 not-now puts it off', `${off.ok} ${reds().length}`, 'true 0');
}

// ---- #756: a base red under the batch's PRs is one item, naming the checks, the PRs held and the last merges
{
  const hold = (checks, since, held = true) => ({ class: 'base red', head: 'h', merge_base: 'm', checks, cleared: [], since, held });
  const st = (pr, red, o = {}) => ({ pr, state: 'OPEN', head: 'h', checks: red.map((name) => ({ name, status: 'completed', conclusion: 'failure' })), ...o });
  const ticket = (pr, base_red, o = {}) => ({ state: 'done', result: { pr }, base_red, pr_status: st(pr, base_red?.checks ?? []), ...o });
  put('red756', { port: 4756, beat: 1, tickets: {
    'B-1': ticket(31, hold(['tests'], minsAgo(40))),
    'B-2': ticket(32, hold(['lint', 'tests'], minsAgo(20))),
    // Held on two checks, one of them green since: only the red one is named.
    'B-3': ticket(37, hold(['tests', 'typecheck'], minsAgo(10)), { pr_status: st(37, ['tests']) }),
    // Two workflows' checks of one name, the later run green: the other is still red, so it is still held.
    'B-4': ticket(38, hold(['e2e'], minsAgo(10)), { pr_status: st(38, [], { checks: [{ name: 'e2e', status: 'completed', conclusion: 'failure', runId: '5' }, { name: 'e2e', status: 'completed', conclusion: 'success', runId: '9' }] }) }),
    'M-1': { state: 'done', result: { pr: 29 }, merged_at: '2026-11-20T17:58:00.000Z' },
    'M-2': { state: 'done', result: { pr: 30 }, merged_at: '2026-11-20T18:10:00.000Z', base_red: hold(['tests'], minsAgo(90)) },
    // Records that are not holds now: a PR closed unmerged, one green at the head the hold read, one at
    // a new head, and one taking a fix try beside its base red check.
    'X-1': ticket(33, hold(['tests'], minsAgo(120)), { pr_status: st(33, ['tests'], { state: 'CLOSED' }) }),
    'X-2': ticket(34, hold(['tests'], minsAgo(120)), { pr_status: st(34, []) }),
    'X-3': ticket(35, hold(['tests'], minsAgo(120)), { pr_status: st(35, ['tests'], { head: 'h2' }) }),
    'X-4': ticket(36, hold(['tests'], minsAgo(120), false)),
  } });
  const reds = () => N.collect({ word: 'red756' }).items.filter((i) => i.kind === 'base-red');
  const s = reds();
  t('#756 one item for the base, on the standing batch', s.map((i) => `${i.t.key} ${i.r.batch ?? 'standing'}`).join(), 'base-red:default standing');
  t('#756 its need names the checks, the open PRs held and the last merges desk made, newest first', s[0]?.need,
    `the default branch is red on "e2e", "lint" and "tests", so #31 (B-1), #32 (B-2), #37 (B-3) and #38 (B-4) hold with no fix try and no worker repairs the default branch. The last merges desk made: #30 (M-2) on ${dayAndTime('2026-11-20T18:10:00.000Z')} and #29 (M-1) on ${dayAndTime('2026-11-20T17:58:00.000Z')}. Fix it on the default branch, or revert the merge that turned it red, then say done`);
  t('#756 it is aged from the earliest open hold', s[0]?.since, Date.parse(minsAgo(40)));
  t('#756 desk-q\'s count lists it', N.needsCount(loadRepos(Date.now(), 'red756').find((r) => r.slug === 'acme__red756' && r.batch == null)).items.some((i) => i.item.kind === 'base-red'), true);
  const done = N.record({ word: 'red756', ticket: 'base-red:default', action: 'done' });
  t('#756 done records nothing and says what clears it', `${done.ok} ${reds().length}`, 'true 1');
  const off = N.record({ word: 'red756', ticket: 'base-red:default', action: 'not-now' });
  t('#756 not-now puts it off', `${off.ok} ${reds().length}`, 'true 0');
  put('green756', { port: 4757, beat: 1, tickets: { 'G-1': { state: 'done', result: { pr: 40 } }, 'G-2': { state: 'done', result: { pr: 41 }, merged_at: '2026-11-20T18:00:00.000Z', base_red: hold(['tests'], minsAgo(5)) },
    'G-3': ticket(42, hold(['tests'], minsAgo(5)), { pr_status: st(42, []) }) } });
  t('#756 no PR held now, no item: a merged one, or one green at the head its hold read', N.collect({ word: 'green756' }).items.filter((i) => i.kind === 'base-red').length, 0);
}

// ---- DS-929 AC1: every in-process collect and refresh above ran on injected repos and reads, and started
// no gh, git, desk-jira or launchctl process.
t('DS-929 AC1 no collect or refresh on the stubs started a gh, git, desk-jira or launchctl process', startedOnStubs.join(' | '), '');
t('DS-929 AC2 every CLI command still has a run end to end', [...cliRan].sort().join(), 'ask,left,list,record');

console.log(fails ? `\n${fails} check(s) did not pass` : '\nall passed');
process.exit(fails ? 1 : 0);
