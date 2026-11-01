// suite: desk-q plain output (overview, one repo, one ticket)
// desk-q against fixture repo configs, queues, heartbeats and triage records under a throwaway HOME,
// DESK_HOME and DESK_CONFIG_ROOT. Nothing touches your real ~/.claude, ~/.config/desk or state.
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { xterm256, rgbOfSgr } from './sgr_rgb.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'desk-q.mjs');
const NOW = Date.now();
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();

// One fixture world: seven repos by default, or `repos` to override, each { port, conc, queue, beat, triage }.
function world(overrides = {}) {
  const T = mkdtempSync(join(tmpdir(), 'desk-q-'));
  // macOS, with a fake launchctl: `print gui/<uid>/<label>` exits 0 for each label in bin/loaded,
  // printing bin/print-<label> where there is one.
  mkdirSync(join(T, 'bin'));
  writeFileSync(join(T, 'bin', 'launchctl'), '#!/bin/sh\ngrep -qxF "${2##*/}" "$(dirname "$0")/loaded" 2>/dev/null || exit 1\ncat "$(dirname "$0")/print-${2##*/}" 2>/dev/null\nexit 0\n', { mode: 0o755 });
  const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
    DESK_PLATFORM: 'darwin', DESK_SKILLS_DIR: join(T, 'skills'), PATH: `${join(T, 'bin')}:${process.env.PATH}` };
  writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
  const held = (by) => ({ state: 'parked', held_by: by, park: { question: `held by orchestrator: blocked by ${by.split('|').join(', ')} — starts once their PRs merge` } });
  const repos = {
    voicepa: { port: 3100, conc: '3 / 5', beat: 4, queue: { batch: 'vp-batch', concurrency: 3, tickets: {
      'VPL-1': { state: 'running', stage: '4/9' },
      'VPL-2': { state: 'running', stage: '2/9' },
      'VPL-3': { ...held('VPL-1|VPL-0'), lane: 'A', type: 'Task', branch: 'feat/VPL-3-gaps' },
      'VPL-0': { state: 'done', result: { pr: 10 } },
      'VPL-8': { state: 'done', result: { pr: 11 } },
      'VPL-9': { state: 'done', result: { pr: 12 } },
    } }, triage: {
      'VPL-1': { summary: 'Running-late sheet', lane: 'A' },
      'VPL-2': { summary: 'Check-in text', lane: 'A' },
      'VPL-3': { summary: 'Long gaps between bookings', lane: 'A', size: 'M', lane_reason: 'mechanical once the gap rule is read', files_in_scope: ['src/gaps.ts', 'src/gaps.test.ts'] },
    } },
    'desk-skills': { port: 3500, conc: '2 / 3', beat: 1, queue: { batch: 'ds', concurrency: 2, tickets: { 'DS-1': { state: 'triaged', open_questions: 0 } } } },
    'pr-ninja': { port: 3200, conc: '2 / 3', beat: 120, otherQueueBeat: 1, queue: { batch: 'pn', concurrency: 2, tickets: { 'PN-1': { state: 'parked', park: { question: 'which copy?' } } } } },
    pranicuk: { port: 3502, conc: '1 / 2', beat: 60, queue: { batch: 'pk', concurrency: 2, tickets: {
      'KAN-1': { state: 'done', result: { pr: 5 } }, 'KAN-2': held('KAN-1'),
    } } },
    forewatt: { port: 3300, conc: '2 / 3' },
    'yield-index': { port: 3400, conc: '2 / 3' },
    'gygg-platform': { port: 3600, conc: '2 / 3' },
    ...overrides,
  };
  for (const [name, r] of Object.entries(repos)) if (r) put(T, env, name, r);
  const run = (...args) => { const r = spawnSync('node', [BIN, ...args], { encoding: 'utf8', env, cwd: T }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  // The supervisor agents launchd has loaded, by repo name.
  const loaded = (...names) => writeFileSync(join(T, 'bin', 'loaded'), names.map((n) => `com.desk-skills.supervisor.acme__${n}\n`).join(''));
  return { T, env, run, loaded };
}

// One repo's config, queue, heartbeats and triage records, written over whatever was there.
function put(T, env, name, r) {
  const slug = `acme__${name}`;
  mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
    `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`${r.port}\` |\n| Autopilot worker concurrency | \`2 / 3\` | \`${r.conc}\` |\n` +
    (r.runBy ? `| Batches run by | \`supervisor\` | \`${r.runBy}\` |\n` : '') +
    (r.jira ? `\n## 4. Tracker\n\n| Field | Value |\n|---|---|\n| Jira site | \`${r.jira}\` |\n` : '') +
    (r.perms ? `\n## 3. Permissions\n\n| Key | Your setting |\n|---|---|\n${Object.entries(r.perms).map(([k, v]) => `| \`${k}\` | \`${v}\` |\n`).join('')}` : ''));
  const state = join(env.HOME, '.desk-autopilot', slug);
  if (r.queue) {
    const q = join(env.DESK_HOME, 'repos', slug, 'queue.json');
    mkdirSync(dirname(q), { recursive: true });
    const tickets = Object.fromEntries(Object.entries(r.queue.tickets).map(([k, v]) => [k, { key: k, ...v }]));
    writeFileSync(q, JSON.stringify({ version: 1, ...r.queue, tickets }));
    if (r.beat != null) {
      mkdirSync(join(state, 'orchestrators'), { recursive: true });
      writeFileSync(join(state, 'orchestrators', 'q.json'), JSON.stringify({ queue: q, batch: r.queue.batch, pid: 1, at: minsAgo(r.beat) }));
    }
    if (r.otherQueueBeat != null) {
      mkdirSync(join(state, 'orchestrators'), { recursive: true });
      writeFileSync(join(state, 'orchestrators', 'other.json'), JSON.stringify({ queue: join(T, 'other-queue.json'), batch: 'other', pid: 2, at: minsAgo(r.otherQueueBeat) }));
    }
  }
  for (const [k, v] of Object.entries(r.triage ?? {})) {
    mkdirSync(join(state, 'triage'), { recursive: true });
    writeFileSync(join(state, 'triage', `${k}.json`), JSON.stringify({ ticket: k, epic: null, ...v }));
  }
}

const W = world();
const lines = (s) => s.split('\n');
const rowOf = (out, name) => lines(out).find((l) => l.startsWith(`  ${name} `));

// ---- AC1: live batches first, then the quiet one that needs you, then the no-batch line
const ov = W.run('--plain');
const order = lines(ov.out).filter((l) => /^ {2}[a-z]/.test(l)).map((l) => l.trim().split(/\s+/)[0]);
t('AC1 live batches, then the quiet batch that needs you', order.join(), 'desk-skills,voicepa,pr-ninja');
t('AC1 one line names the three repos with no batch', lines(ov.out).some((l) => l.startsWith('  3 more set up with no batch: forewatt, gygg-platform, yield-index')), true);
t('a fresh heartbeat for another queue file leaves a quiet batch quiet', /^\s+pr-ninja\s+■ stopped · 2h 0m /.test(rowOf(ov.out, 'pr-ninja') ?? ''), true);
// ---- AC2: a quiet batch whose unfinished tickets all wait is not listed
t('AC2 quiet batch with only waiting tickets is hidden', rowOf(ov.out, 'pranicuk'), undefined);
// ---- AC3: --all lists every set-up repo, no-batch ones marked
const all = W.run('--plain', '--all');
t('AC3 every set-up repo listed', ['voicepa', 'desk-skills', 'pr-ninja', 'pranicuk', 'forewatt', 'yield-index', 'gygg-platform'].every((n) => rowOf(all.out, n)), true);
t('AC3 no-batch repos marked', /no batch/.test(rowOf(all.out, 'forewatt') ?? ''), true);
// ---- AC4: header gives running workers, live batches' allowance against the machine cap, free memory
// The line under what needs you.
const head = lines(ov.out)[1];
t('AC4 (DS-188 AC5, DS-215 AC12) header', /^● 2 workers running │ machine cap 10 · room for \d+ more │ \d+\.\d GiB free$/.test(head), true);
// ---- AC5: overlapping worker port blocks named with the shared range
t('AC5 port overlap note', lines(ov.out).some((l) => /^(note| {4}) {2}▲ ports +desk-skills \+ pranicuk share 3502–3503\./.test(l)), true);
// ---- AC15: voicepa's counts, last pass and workers (and ALL DONE BY, with no history)
const vp = (rowOf(ov.out, 'voicepa') ?? '').trim().split(/\s+/);
t('AC15 (DS-279 AC14) voicepa row: a session 4m ago, run 2, ready 0, merging 0, wait 1, needs 0, done 3, workers 3', vp.slice(1, 15).join(' '), '● session · 4m ago 2 0 0 1 0 3 no history 3');

// ---- AC7: a held ticket whose only unmerged blocker runs is waiting, behind that blocker only
const repo = W.run('--plain', 'voicepa');
const vpl3 = lines(repo.out).find((l) => /VPL-3/.test(l)) ?? '';
t('AC7 waiting, behind the running blocker, not the merged one', /waiting\s+behind VPL-1\s/.test(vpl3) && !/VPL-0/.test(vpl3), true);
// ---- AC8: prefix, spawn order, position, state, detail, title, done count
const pre = W.run('--plain', 'vo');
t('AC8 a prefix resolves', pre.code === 0 && pre.out === repo.out, true);
const tickets = lines(pre.out).filter((l) => /^\s+\*?\d+\s{2}/.test(l));
t('AC8 unfinished tickets in spawn order with positions', tickets.map((l) => l.trim().split(/\s+/).slice(0, 2).join(' ')).join(), '1 VPL-1,2 VPL-2,3 VPL-3');
t('AC8 state, detail and triage title', /running\s+stage 4\/9 as of \d\d:\d\d\s+—\s+—\s+Running-late sheet$/.test(tickets[0]), true);
t('AC8 done count', /✓ 3 done, not shown/.test(pre.out), true);
t('DS-194 AC5 (DS-215) with no PR merging, the counts line leaves the merging part out', lines(pre.out)[1], '◆ nothing needs you  ● 2 running  · 1 waiting │ ✓ 3 done, not shown');
// ---- AC9: an ambiguous prefix refuses, naming both, with no table
const amb = W.run('--plain', 'pr');
t('AC9 ambiguous prefix exits non-zero', amb.code !== 0, true);
t('AC9 names both repos, prints no table', /pr-ninja/.test(amb.err) && /pranicuk/.test(amb.err) && amb.out === '', true);
// ---- AC10: no match refuses, listing what is set up
const zz = W.run('--plain', 'zz');
t('AC10 no match exits non-zero listing the repos', zz.code !== 0 && /forewatt/.test(zz.err) && /voicepa/.test(zz.err), true);
// ---- AC11: show on a held ticket
const show = W.run('--plain', 'voicepa', 'show', 'VPL-3');
const want = ['Long gaps between bookings', 'waiting', '▌ Moves without you: behind VPL-1 (running, stage 4/9).', 'Blockers  2, all in this batch\n  ✓ 1 merged', '  ● VPL-1     running    Running-late sheet', 'lane A', 'Why lane A', 'mechanical once the gap rule is read', 'Files in scope · 2', 'src/gaps.ts', 'Branch    feat/VPL-3-gaps', `Open      log ${join(W.env.HOME, '.desk-autopilot', 'acme__voicepa', 'logs', 'VPL-3.log')}`];
t('AC11 show prints every field', want.filter((w) => !show.out.includes(w)).join(' | '), '');
t('AC11 show lists the merged blocker under its count, as a does on screen', lines(show.out).some((l) => /^ {2}✓ VPL-0\b/.test(l)), true);
t('show of a key not in the queue refuses', W.run('--plain', 'voicepa', 'show', 'VPL-77').code !== 0, true);
// ---- AC12: no arguments, output not a terminal: the overview, exit 0
const bare = W.run();
t('AC12 piped with no arguments prints the overview', bare.code === 0 && /^◆ .*\n● \d+ workers? running │ /.test(bare.out) && rowOf(bare.out, 'voicepa') != null, true);

// ---- AC6 (DS-217 AC5): a held ticket whose blocker is parked for its own reason waits on that blocker,
// which is counted as needing you; open Jira blockers outside the batch are what blocks a ticket.
const S = world({ voicepa: { port: 3100, conc: '3 / 5', beat: 4, queue: { batch: 'vp', concurrency: 3, tickets: {
  'VPL-5': { state: 'parked', park: { question: 'out of scope' } },
  'VPL-6': { state: 'parked', held_by: 'VPL-5', park: { question: 'held by orchestrator: blocked by VPL-5' } },
  'VPL-7': { state: 'triaged', open_questions: 1, outside_blockers: [{ key: 'EXT-1', category: 'new' }, { key: 'EXT-2', category: 'indeterminate' }] },
} } } });
t('AC6 (DS-217 AC5) held behind a ticket parked for its own reason reads waiting, which needs you', /VPL-6\s+· waiting\s+behind VPL-5, which needs you\s/.test(S.run('--plain', 'voicepa').out), true);
const blockedViews = { overview: S.run('--plain').out, queue: S.run('--plain', 'voicepa').out, ticket: S.run('--plain', 'voicepa', 'show', 'VPL-7').out };
t('DS-279 AC6 a ticket held outside the batch needs you on every screen, and no screen says blocked or stuck',
  JSON.stringify([...Object.values(blockedViews).map((s) => /stuck|blocked/i.test(s)), /^◆ 3 tickets need you .*│ voicepa 2 · pr-ninja 1$/.test(lines(blockedViews.overview)[0]),
    /VPL-7\s+◆ needs you\s+held by 2 Jira tickets outside: start anyway\?/.test(blockedViews.queue),
    lines(blockedViews.ticket)[0].startsWith('VPL-7  ◆ needs you'), lines(blockedViews.ticket).some((l) => /^ {2}◌ EXT-2 +In Progress$/.test(l))]),
  '[false,false,false,true,true,true,true]');

// ---- AC13: nothing set up
const E = mkdtempSync(join(tmpdir(), 'desk-q-empty-'));
const none = spawnSync('node', [BIN, '--plain'], { encoding: 'utf8', env: { HOME: E, DESK_HOME: join(E, 'd'), DESK_CONFIG_ROOT: join(E, 'c'), DESK_MACHINE: join(E, 'm.md'), PATH: process.env.PATH } });
t('AC13 no repo set up: says so, names /desk-setup, exits non-zero', none.status !== 0 && /no repo is set up/i.test(none.stderr) && /\/desk-setup/.test(none.stderr), true);

// ---- AC14: no command writes anything under the desk home, the config root or the state directory
const snap = (dir) => {
  const out = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else out.push(`${p} ${s.mtimeMs} ${readFileSync(p, 'utf8')}`); } };
  walk(dir);
  return out.sort().join('\n');
};
const before = snap(W.T);
for (const args of [[], ['--plain'], ['--plain', '--all'], ['--plain', 'voicepa'], ['--plain', 'voicepa', 'show', 'VPL-3'], ['--plain', 'pr'], ['--plain', 'zz']]) W.run(...args);
t('AC14 nothing changed on disk', snap(W.T) === before, true);

// ---- DS-116: moves and workers as one-shot commands. Every change goes through queue.mjs.
const readQ = (p) => JSON.parse(readFileSync(p, 'utf8'));
const qPath = (w, name) => join(w.env.DESK_HOME, 'repos', `acme__${name}`, 'queue.json');
const unfinishedKeys = (q) => Object.keys(q.tickets).filter((k) => !['done', 'failed'].includes(q.tickets[k].state));
const twelve = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`VPL-${i + 1}`, { state: 'triaged', open_questions: 0 }]));
const M = world({ voicepa: { port: 3100, conc: '3 / 5', beat: 4, queue: { batch: 'vp', concurrency: 3, tickets: { 'VPL-0': { state: 'done', result: { pr: 1 } }, ...twelve } } } });
const mq = qPath(M, 'voicepa');
const topped = M.run('voicepa', 'top', 'VPL-6');
const toppedLines = lines(topped.out);
t('DS-116 AC8 top prints one confirmation line, then the updated table', topped.code === 0 && /^VPL-6 → position 1 of 12\b/.test(toppedLines[0])
  && toppedLines[1] === '' && /^desk-q › voicepa · \d\d:\d\d$/.test(toppedLines[2]) && toppedLines.slice(1).some((l) => /^\s+\*1\s+VPL-6\s/.test(l)), true);
t('DS-116 AC8 the queue has VPL-6 first, marked placed', `${unfinishedKeys(readQ(mq))[0]} ${readQ(mq).tickets['VPL-6'].placed}`, 'VPL-6 true');
const mqBefore = readFileSync(mq, 'utf8');
const far = M.run('voicepa', 'move', 'VPL-6', '99');
t('DS-116 AC9 move to position 99 exits non-zero naming 1 to 12', far.code !== 0 && /give 1 to 12/.test(far.err) && far.out === '', true);
t('DS-116 AC9 the queue file is unchanged', readFileSync(mq, 'utf8') === mqBefore, true);

// A failed ticket keeps its slot in queue.mjs and has no place, so a move steps past it.
const F = world({ voicepa: { port: 3100, conc: '3 / 5', beat: 4, queue: { batch: 'vp', concurrency: 3, tickets: {
  'VPL-1': { state: 'triaged', open_questions: 0 }, 'VPL-2': { state: 'failed' }, 'VPL-3': { state: 'triaged', open_questions: 0 } } } } });
const past = F.run('voicepa', 'up', 'VPL-3');
t('up past a failed ticket reaches the place above it', `${lines(past.out)[0]} | ${unfinishedKeys(readQ(qPath(F, 'voicepa'))).join()}`, 'VPL-3 → position 1 of 2, placed by you. | VPL-3,VPL-1');
t('a ticket whose worker stopped shows no position, and needs you', /^\s+-\s+VPL-2\s+◆ needs you\s+worker stopped · requeue it/.test(lines(past.out).find((l) => /VPL-2/.test(l)) ?? ''), true);

// AC5 from the shell, where the new block meets another repo's: pranicuk's cap of 2 is 3502–3504,
// and a cap of 3 would reach desk-skills' 3500–3503. Live batches: desk-skills 2 and voicepa 3.
const pq = qPath(W, 'pranicuk');
const pqBefore = readFileSync(pq, 'utf8');
const over = W.run('pranicuk', 'workers', '3');
t('DS-116 AC5 above the cap is refused, naming the block it would overlap and the new total', over.code !== 0 && /pranicuk's cap is 2/.test(over.err)
  && /ports 3502 to 3505, overlapping desk-skills \(3500–3503\)/.test(over.err) && /live batches would then allow 8 against this machine's 10/.test(over.err), true);
t('DS-116 AC5 the queue file is unchanged', readFileSync(pq, 'utf8') === pqBefore, true);

// AC10: run from a checkout whose origin is desk-skills, where queue.mjs left to itself would pick
// desk-skills' queue.
const checkout = join(W.T, 'desk-skills-checkout');
spawnSync('git', ['init', '-q', checkout]);
spawnSync('git', ['-C', checkout, 'remote', 'add', 'origin', 'https://github.com/acme/desk-skills.git']);
const dsBefore = readFileSync(qPath(W, 'desk-skills'), 'utf8');
const inside = spawnSync('node', [BIN, 'voicepa', 'workers', '4'], { encoding: 'utf8', env: W.env, cwd: checkout });
const vq = readQ(qPath(W, 'voicepa'));
t('DS-116 AC10 workers changes the named repo\'s queue, as set by the user', `${inside.status} ${vq.concurrency} ${vq.concurrency_by}`, '0 4 user');
t('DS-116 AC10 the queue of the repo it ran in is unchanged', readFileSync(qPath(W, 'desk-skills'), 'utf8') === dsBefore, true);

// AC7: live batches at 4 + 3 + 3 = 10 on a machine of 10; one more is made, with a warning.
const triaged = (k) => ({ [k]: { state: 'triaged', open_questions: 0 } });
const X = world({
  voicepa: { port: 3100, conc: '3 / 5', beat: 4, queue: { batch: 'vp', concurrency: 4, tickets: triaged('VPL-1') } },
  'desk-skills': { port: 3500, conc: '2 / 3', beat: 1, queue: { batch: 'ds', concurrency: 3, tickets: triaged('DS-1') } },
  'pr-ninja': { port: 3200, conc: '2 / 4', beat: 1, queue: { batch: 'pn', concurrency: 3, tickets: triaged('PN-1') } },
  pranicuk: null,
});
const raised = X.run('voicepa', 'workers', '5');
t('DS-116 AC7 a raise past the machine total is made', `${raised.code} ${readQ(qPath(X, 'voicepa')).concurrency}`, '0 5');
t('DS-116 AC7 and warns that live batches now allow 11', /Live batches now allow 11, over this machine's 10/.test(lines(raised.out)[0]), true);
t('a workers count that is not a whole number is refused', X.run('voicepa', 'workers', 'two').code !== 0 && readQ(qPath(X, 'voicepa')).concurrency === 5, true);

// ---- the interactive screen, driven in-process through an injected key stream and an 80-column
// output. desk-env reads HOME when it is first imported, so the module loads after the env is set.
const LONG = 'Rebook the client automatically when the gap between two bookings is longer than the salon allows';
const vpQueue = (first = {}) => ({ batch: 'vp', concurrency: 3, tickets: {
  ...first,
  'VPL-1': { state: 'running', stage: '4/9' },
  'VPL-2': { state: 'running', stage: '2/9' },
  'VPL-3': { state: 'parked', held_by: 'VPL-1', park: { question: 'held by orchestrator: blocked by VPL-1' } },
  'VPL-4': { state: 'triaged', open_questions: 0 },
  'VPL-0': { state: 'done', result: { pr: 10 } },
} });
const I = world({ voicepa: { port: 3100, conc: '3 / 5', beat: 4, jira: 'acme.atlassian.net', queue: vpQueue(), triage: {
  'VPL-1': { summary: 'Running-late sheet' }, 'VPL-4': { summary: LONG },
  'VPL-3': { summary: 'Long gaps', files_in_scope: Array.from({ length: 30 }, (_, i) => `src/gap-${i}.ts`) },
} } });
Object.assign(process.env, I.env);
// A dark terminal theme without truecolor: COLORFGBG or COLORTERM from the shell running the suite
// would pick the light greys or the 24-bit colours.
delete process.env.COLORFGBG;
delete process.env.COLORTERM;
const Q = await import(BIN);
// The label grey on a dark theme, and a string made safe for a RegExp.
const G = '\x1b[38;5;247m';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const { PassThrough } = await import('node:stream');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function screen(start, columns = 80, clock = Date.now, M = Q) {
  const input = new PassThrough();
  const modes = [];
  Object.assign(input, { isTTY: true, setRawMode: (b) => modes.push(b) });
  // `resize` holds the screen's resize listener, so a test can change `columns` and call it.
  const output = { buf: '', columns, rows: 24, write(s) { this.buf += s; }, on(e, f) { if (e === 'resize') this.resize = f; }, removeListener() {} };
  const codes = [], opened = [];
  const ui = M.interactive({ input, output, start, exit: (c) => codes.push(c), opener: (u) => opened.push(u), refreshMs: start?.refreshMs ?? 600000, clock, probeWith: async () => ({ ran: false }) });
  const frame = () => output.buf.split('\x1b[H').at(-1).replace(ANSI, '').split('\r\n');
  return {
    input, output, modes, codes, opened, ui, frame,
    // A lone Esc is only told apart from an escape sequence after readline's 500ms wait.
    press: async (s) => { input.write(s); await sleep(s === '\x1b' ? 600 : 20); },
    // The crumbs, less the time and the parked note that follow them.
    crumbs: () => frame()[0].split('    ')[0].replace(/ · \d\d:\d\d$/, ''),
    selected: () => frame().find((l) => l.startsWith('›')) ?? '',
    // The tab drawn in reverse video on the tab line, the view shown.
    tabOn: () => /\x1b\[7m([^\x1b]+)\x1b\[27m/.exec(output.buf.split('\x1b[H').at(-1).split('\r\n')[1] ?? '')?.[1] ?? null,
    // A left click at a 1-based column and row: the SGR press and release a terminal sends.
    click: async (x, y) => { input.write(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`); await sleep(20); },
  };
}
const DOWN = '\x1b[B';
// The last frame's lines as drawn, less the erase-to-end-of-line each ends in.
const lastFrame = (s) => s.output.buf.split('\x1b[H').at(-1).split('\r\n').map((l) => l.replace(/\x1b\[K$/, ''));
// Each coloured run, as "<SGR>:<text>"; `dim` takes dim and the 256-colour greys (232 and up) too.
const coloured = (l, dim = false) => [...l.matchAll(dim ? /\x1b\[(3[0-7]|2|38;[25];[\d;]+)m([^\x1b]*)\x1b\[(?:39|22)m/g : /\x1b\[(3[0-7]|38;2;[\d;]+|38;5;(?:\d\d?|1\d\d|2[0-2]\d|23[01]))m([^\x1b]*)\x1b\[39m/g)].map((m) => `${m[1]}:${m[2].trim()}`);

const A = screen();
await sleep(20);
t('AC1 no arguments: the all-repos screen, first row selected', A.crumbs() === 'desk-q' && /^› desk-skills\s/.test(A.selected()), true);
await A.press(DOWN);
await A.press('\r');
t('AC2 Enter on voicepa opens its queue', A.crumbs(), 'desk-q › voicepa');
t('AC12 no row on an 80-column repo screen is wider than 80', A.frame().filter((l) => l.length > 80).length, 0);
t('AC13 a title that does not fit ends in an ellipsis', /VPL-4 .*…$/.test(A.frame().find((l) => /VPL-4/.test(l)) ?? ''), true);
// Grouped: Running VPL-1 and VPL-2, Ready VPL-4, Waiting VPL-3.
await A.press(DOWN); await A.press(DOWN); await A.press(DOWN); await A.press('\r');
t('AC3 down to the Waiting ticket and Enter opens it', A.crumbs(), 'desk-q › voicepa › VPL-3');
t('AC4 the blocker is a selectable row', /^›\s+● VPL-1\s+running/.test(A.selected()), true);
await A.press('\r');
t('AC4 Enter on the blocker opens its ticket screen', A.crumbs(), 'desk-q › voicepa › VPL-1');
await A.press('\x1b'); await A.press('\x1b');
await A.press('\x1b[A'); await A.press('\r');
t('the fourth ticket opens', A.crumbs(), 'desk-q › voicepa › VPL-4');
await A.press('l');
t('AC14 l with no log says so', A.frame().some((l) => l === 'VPL-4 has no log yet.'), true);
await A.press('\x1b');
t('AC5 Esc returns to the repo screen with the fourth row still selected', A.crumbs() === 'desk-q › voicepa' && /^›\s+4\s+VPL-4\s/.test(A.selected()), true);
mkdirSync(join(I.env.HOME, '.desk-autopilot', 'acme__voicepa', 'logs'), { recursive: true });
writeFileSync(join(I.env.HOME, '.desk-autopilot', 'acme__voicepa', 'logs', 'VPL-3.log'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
for (const c of ':voicepa show vpl-3') await A.press(c);
t('the : prompt echoes what is typed', A.frame().at(-1), ':voicepa show vpl-3');
await A.press('\r');
t('AC9 :voicepa show <KEY> opens that ticket', A.crumbs(), 'desk-q › voicepa › VPL-3');
const logLine = () => A.frame().some((l) => l === '  src/gap-29.ts');
// f shows every file in scope, so the page is taller than the terminal.
await A.press('f');
t('a ticket taller than the terminal hides its last lines at first', logLine(), false);
for (let i = 0; i < 40; i++) await A.press(DOWN);
t('↓ on the last blocker reads on to the bottom of the ticket', logLine(), true);
for (let i = 0; i < 40; i++) await A.press('\x1b[A');
t('↑ scrolls back to the blocker, still selected', /^›\s+● VPL-1\s/.test(A.selected()), true);
await A.press('l');
const logLines = () => A.frame().filter((l) => /^line \d+$/.test(l));
const seen = new Set(logLines());
t('AC14 a log taller than the terminal opens at its last line', logLines().at(-1), 'line 50');
for (let i = 0; i < 30; i++) await A.press('\x1b[A');
for (const l of logLines()) seen.add(l);
const nums = [...seen].map((l) => Number(l.slice(5))).sort((a, b) => a - b);
t('AC14 l shows the last 40 lines of the log, ↑ scrolling to the first', `${nums.length} ${nums[0]} ${nums.at(-1)}`, '40 11 50');
await A.press('\x1b');
await A.press('o');
t('AC15 o passes the Jira browse URL to the opener', A.opened.join(), 'https://acme.atlassian.net/browse/VPL-3');
await A.press('q');
t('AC10 q exits 0', A.codes.join(), '0');
t('AC10 q shows the cursor and leaves the alternate screen', A.output.buf.endsWith(Q.LEAVE_SCREEN) && Q.LEAVE_SCREEN.includes('\x1b[?25h') && Q.LEAVE_SCREEN.includes('\x1b[?1049l'), true);
t('AC10 q restores normal input mode', A.modes.join(), 'true,false');

const B = screen();
await sleep(20);
const hasRow = (s, n) => s.frame().some((l) => l.replace(/^›/, ' ').startsWith(`  ${n} `));
t('AC7 repos with no batch start hidden', hasRow(B, 'forewatt'), false);
await B.press('a');
t('AC7 a lists them', hasRow(B, 'forewatt') && /no batch/.test(B.frame().find((l) => /forewatt/.test(l)) ?? ''), true);
await B.press('a');
t('AC8 a again hides them', hasRow(B, 'forewatt'), false);
await B.press('\x03');
t('AC11 Ctrl-C exits 130', B.codes.join(), '130');
t('AC11 Ctrl-C restores the terminal as q does', B.output.buf.endsWith(Q.LEAVE_SCREEN) && B.modes.join() === 'true,false', true);

t('AC6 the screen rereads every 2 seconds', Q.REFRESH_MS, 2000);
const C = screen({ kind: 'repo', slug: 'acme__voicepa', refreshMs: Q.REFRESH_MS });
await sleep(20);
await C.press(DOWN); await C.press(DOWN);
const qfile = join(I.env.DESK_HOME, 'repos', 'acme__voicepa', 'queue.json');
const rewritten = vpQueue({ 'VPL-7': { state: 'triaged', open_questions: 0 } });
writeFileSync(qfile, JSON.stringify({ version: 1, ...rewritten, tickets: Object.fromEntries(Object.entries(rewritten.tickets).map(([k, v]) => [k, { key: k, ...v }])) }));
await sleep(Q.REFRESH_MS);
t('AC6 within 2 seconds the change shows, selection still on the same key', C.frame().some((l) => /^\s+1\s+VPL-7\s/.test(l)) && /^›\s+5\s+VPL-4\s/.test(C.selected()), true);
C.ui.finish(0);

// ---- DS-116 on the screen: shift+arrows, t, b, + and -, each a queue.mjs command on voicepa's queue.
const writeQueue = (q) => writeFileSync(qfile, JSON.stringify({ version: 1, ...q, tickets: Object.fromEntries(Object.entries(q.tickets).map(([k, v]) => [k, { key: k, ...v }])) }));
const sixQueue = (concurrency) => ({ batch: 'vp', concurrency, tickets: {
  'VPL-1': { state: 'running', stage: '4/9' },
  'VPL-2': { state: 'parked', held_by: 'VPL-1', park: { question: 'held by orchestrator: blocked by VPL-1' } },
  ...Object.fromEntries(['VPL-3', 'VPL-4', 'VPL-5', 'VPL-6'].map((k) => [k, { state: 'triaged', open_questions: 0 }])),
  'VPL-0': { state: 'done', result: { pr: 10 } },
} });
const nowQ = () => JSON.parse(readFileSync(qfile, 'utf8'));
const status = (s) => s.frame().join(' ');
const SHIFT_UP = '\x1b[1;2A';
writeQueue(sixQueue(3));
const D = screen({ kind: 'repo', slug: 'acme__voicepa' }, 160);
await sleep(20);
// Grouped: Running VPL-1, Ready VPL-3 to VPL-6, Waiting VPL-2.
for (let i = 0; i < 3; i++) await D.press(DOWN);
await D.press(SHIFT_UP);
t('DS-116 AC1 shift+↑ on position 5 moves it to 4, marked placed', /^›\s+\*4\s+VPL-5\s/.test(D.selected()) && unfinishedKeys(nowQ()).indexOf('VPL-5') === 3 && nowQ().tickets['VPL-5'].placed === true, true);
t('DS-116 AC1 the status line confirms the move', D.frame().some((l) => l.startsWith('VPL-5 → position 4 of 6, placed by you.')), true);
// Down past VPL-4 and VPL-6 to the Waiting group's VPL-2.
for (let i = 0; i < 3; i++) await D.press(DOWN);
await D.press('t');
t('DS-116 AC2 t puts the waiting ticket first', unfinishedKeys(nowQ())[0], 'VPL-2');
t('DS-116 AC2 and says it still waits on its blockers', D.frame().some((l) => /^VPL-2 → position 1 of 6\b.*still waits on VPL-1\b/.test(l)), true);
// Up to the top row, the Running group's VPL-1.
for (let i = 0; i < 6; i++) await D.press('\x1b[A');
const beforeRunning = readFileSync(qfile, 'utf8');
await D.press(SHIFT_UP);
t('DS-116 AC3 shift+↑ on a running ticket says it is running', D.frame().some((l) => l.startsWith('VPL-1 is running')), true);
t('DS-116 AC3 and leaves the queue file unchanged', readFileSync(qfile, 'utf8') === beforeRunning, true);
await D.press('+');
t('DS-116 AC4 + takes the batch from 3 to 4, set by the user', `${nowQ().concurrency} ${nowQ().concurrency_by}`, '4 user');
t('DS-116 AC4 and says the next pass uses it', /voicepa: workers 3 → 4 \(cap 5\), set by you\. The next pass uses it\./.test(status(D)), true);
await D.press('+');
const atCap = readFileSync(qfile, 'utf8');
await D.press('+');
const cfg = join(I.env.DESK_CONFIG_ROOT, 'repos', 'acme__voicepa', 'config.md');
t('DS-116 AC5 + at the cap leaves the queue file unchanged', readFileSync(qfile, 'utf8') === atCap && nowQ().concurrency === 5, true);
t('DS-116 AC5 and names the cap, the config row, the port block and the total', [`voicepa's cap is 5`, `§3b "Autopilot worker concurrency" in ${cfg}`,
  'ports 3100 to 3106, clear of every other repo', "live batches would then allow 8 against this machine's 10"].filter((w) => !status(D).includes(w)).join(' | '), '');
D.ui.finish(0);

writeQueue(sixQueue(1));
const E1 = screen({ kind: 'repo', slug: 'acme__voicepa' }, 160);
await sleep(20);
await E1.press('-');
t('DS-116 AC6 - from 1 worker sets 0', nowQ().concurrency, 0);
t('DS-116 AC6 and says no new workers start and running ones finish', status(E1).includes('No new workers start, and running ones finish.'), true);
await E1.press(DOWN); await E1.press('\r');
await E1.press('b');
t('b on a ticket screen moves that ticket to the bottom', `${E1.crumbs()} ${unfinishedKeys(nowQ()).at(-1)}`, 'desk-q › voicepa › VPL-3 VPL-3');
t('the ticket screen says its position was placed by you', E1.frame()[2].includes('position 6 of 6 (placed by you)'), true);
E1.ui.finish(0);

// ---- DS-116 AC11 and AC12: the overview's headroom and its ready-with-no-slot note. Live batches
// allow 5 + 2 + 2 = 9 with 4 running; the machine is 10, the gate 8 GiB and a worker 3 GB.
put(I.T, I.env, 'voicepa', { port: 3100, conc: '3 / 5', beat: 4, queue: { batch: 'vp', concurrency: 5, tickets: {
  'VPL-1': { state: 'triaged', open_questions: 0 }, 'VPL-2': { state: 'parked', park: { question: 'which copy?' } } } } });
put(I.T, I.env, 'desk-skills', { port: 3500, conc: '2 / 3', beat: 1, queue: { batch: 'ds', concurrency: 2, tickets: {
  'DS-1': { state: 'running', stage: '4/9' }, 'DS-2': { state: 'running', stage: '6/9' } } } });
put(I.T, I.env, 'pr-ninja', { port: 3200, conc: '2 / 4', beat: 1, queue: { batch: 'pn', concurrency: 2, tickets: {
  'PN-1': { state: 'running', stage: '4/9' }, 'PN-2': { state: 'running', stage: '2/9' }, 'PN-3': { state: 'triaged', open_questions: 0 } } } });
const room = Q.overview(Q.loadRepos(), { avail: 36.6 });
t('DS-116 AC11 (DS-188 AC5) the header gives running, the machine cap, the room left and free memory',
  lines(room)[1], '● 4 workers running │ machine cap 10 · room for 6 more │ 36.6 GiB free');
t('DS-116 AC11 the room is the smaller of the machine cap and free memory', Q.headroom({ running: 4, cap: 10, avail: 18, gate: 8, perWorker: 3 }), 3);
t('DS-116 AC12 a batch with more ready than free slots says so', rowOf(room, 'pr-ninja')?.endsWith('2 (cap 4) · 1 ready with no free slot'), true);
t('DS-116 AC12 a batch whose ready tickets fit says nothing extra', rowOf(room, 'voicepa')?.endsWith('5 (cap 5)'), true);

// ---- DS-163: the Timeline and By day views, on a fixed clock: Mon 19 Oct 2026 18:51, local time.
const FIXED = new Date(2026, 9, 19, 18, 51).getTime();
const HOUR = 3_600_000, DAY = 24 * HOUR;
// A repo with a ship history: `hours` per merged size M ticket, each merged an hour before the last.
// Its pass was a minute before the real clock, so it is live at FIXED too: a quiet batch is paused.
function dated(name, port, { workers = 2, tickets, hours, at = FIXED, perms = null, supervised = false }) {
  const triage = Object.fromEntries(Object.keys(tickets).map((k) => [k, { summary: `${k} title`, size: 'M' }]));
  put(I.T, I.env, name, { port, conc: '2 / 3', beat: 1, perms, queue: { batch: name, concurrency: workers, ...(supervised ? { supervised } : {}), tickets }, triage });
  writeFileSync(join(I.env.HOME, '.desk-autopilot', `acme__${name}`, 'eta-history.jsonl'), hours.map((h, i) => {
    const merged = at - (i + 1) * HOUR;
    return `${JSON.stringify({ key: `H-${i}`, size: 'M', spawned_at: new Date(merged - h * HOUR).toISOString(), merged_at: new Date(merged).toISOString(), hours: h })}\n`;
  }).join(''));
}
const ready = { state: 'triaged', open_questions: 0 };
dated('tidy', 3700, { hours: [4, 5, 6, 7, 8, 9, 10, 4, 5, 6, 7, 8], tickets: {
  'T-1': { state: 'running', stage: '4/9' }, 'T-2': ready, 'T-3': ready, 'T-4': { state: 'parked', park: { question: 'which copy?' } },
  'T-5': { state: 'parked', held_by: 'T-4', park: { question: 'held by orchestrator: blocked by T-4' }, open_questions: 1, outside_blockers: [{ key: 'EXT-5', category: 'new' }] }, 'T-6': ready, 'T-7': ready } });
dated('slow', 3800, { hours: [30, 40, 50, 60, 30, 40, 50, 60, 30, 40, 50, 60], tickets: { 'S-1': ready, 'S-2': ready, 'S-3': ready, 'S-4': ready } });
dated('zero', 3900, { workers: 0, hours: [2, 3, 4, 5, 2, 3, 4, 5, 2, 3, 4, 5], tickets: { 'Z-1': ready } });
dated('piped', 4000, { hours: [2, 3, 4, 5, 2, 3, 4, 5, 2, 3, 4, 5], at: Date.now(), tickets: { 'P-1': ready, 'P-2': { state: 'parked', park: { question: 'which copy?' } } } });
const tl = (slug, opts = {}) => lines(Q.timelineScreen(Q.loadRepos(FIXED), slug, { now: FIXED, ...opts }));
const tidyF = Q.forecastOf(Q.loadRepos(FIXED).find((r) => r.name === 'tidy'), { now: FIXED });
const tidyTl = tl('acme__tidy');
const barRow = (rows, key) => rows.find((l) => l.startsWith(`  ${pad10(key)}`)) ?? '';
function pad10(s) { return s + ' '.repeat(10 - s.length); }
const datedKeys = Object.keys(tidyF.T).filter((k) => tidyF.T[k]).sort((a, b) => tidyF.T[a].likely - tidyF.T[b].likely);
const shownDated = tidyTl.filter((l) => /^ {2}T-\d+ .*█/.test(l)).map((l) => l.trim().split(/\s+/)[0]);
t('DS-163 AC1 one bar row per dated ticket, sorted by ship time', shownDated.join(), datedKeys.join());
const { when: whenAt } = await import('../desk/bin/desk-q-eta.mjs');
const t3 = barRow(tidyTl, 'T-3');
t('DS-163 AC1 a row is its key, its state, a solid bar shaded on, then STARTS, SHIPS and its title (DS-167)',
  /^ {2}T-3 {7}○ ready {6} [ ┆]*█+░*[ ┆]*[ ▸] \S/.test(t3) && t3.endsWith(`${whenAt(tidyF.T['T-3'].likely, FIXED)}`.padEnd(12) + '  T-3 title'), true);
t('DS-163 AC1 the header ends in STARTS and SHIPS, then TITLE (DS-167)', tidyTl.some((l) => /^ +now .*  STARTS {7}SHIPS {9}TITLE$/.test(l)), true);

t('DS-163 AC2 under 2 days the scale is hours', Q.scaleFor(1.9 * DAY, FIXED).id, 'hours');
t('DS-163 AC2 under 21 days it is days, and beyond that weeks', `${Q.scaleFor(20 * DAY, FIXED).id} ${Q.scaleFor(22 * DAY, FIXED).id}`, 'days weeks');
t('DS-163 AC2 a slow queue reads in days', tl('acme__slow').includes('Scale: days (auto)'), true);

const Gs = screen({ kind: 'timeline', slug: 'acme__tidy' }, 120, () => FIXED);
await sleep(20);
const scaleLine = (s) => s.frame().find((l) => l.startsWith('Scale: ')) ?? '';
t('DS-163 AC2 the header says the scale, that it is auto, and z', scaleLine(Gs), 'Scale: hours (auto) · z to change');
t('DS-163 AC1 the state shows in colour', /\x1b\[38;5;108m● running/.test(Gs.output.buf) && /\x1b\[38;5;75m○ ready/.test(Gs.output.buf), true);
const zs = [];
for (let i = 0; i < 4; i++) { await Gs.press('z'); zs.push(scaleLine(Gs).split(' · ')[0]); }
t('DS-163 AC3 z cycles hours, days, weeks, auto', zs.join(', '), 'Scale: hours, Scale: days, Scale: weeks, Scale: hours (auto)');
Gs.ui.finish(0);

const hrs = tl('acme__tidy');
const tickLine = hrs.find((l) => /^ +├/.test(l)) ?? '';
const railCols = [...tickLine].map((c, i) => (c === '▾' ? i : -1)).filter((i) => i >= 0);
t('DS-163 AC4 an hours scale marks the check-ins on the axis', railCols.length >= 2, true);
const barRows = hrs.filter((l) => /^ {2}T-\d .*█/.test(l));
t('DS-163 AC4 and a dotted rail runs down each bar row wherever no bar covers it', barRows.length > 0
  && barRows.every((l) => railCols.every((c) => ['┆', '█', '░'].includes([...l][c]))) && barRows.some((l) => [...l][railCols[0]] === '┆'), true);

const zoomed = tl('acme__slow', { zoom: 'hours' });
t('DS-163 AC5 a bar running past the right edge ends in ▸', zoomed.filter((l) => /^ {2}S-\d .*▸ /.test(l)).length > 0, true);
t('DS-163 AC5 one that ends inside does not', tidyTl.filter((l) => /^ {2}T-\d .*▸/.test(l)).length, 0);

const everyTl = lines(Q.timelineScreen(Q.loadRepos(FIXED), null, { now: FIXED }));
t('DS-163 AC6 every repo groups tickets under a row per repo', everyTl.includes('  tidy · 7 tickets') && everyTl.includes('  slow · 4 tickets'), true);
t('DS-163 AC6 a repo with too little history says so under the rows', everyTl.some((l) => l.startsWith('voicepa · No ship estimate')), true);
const undatable = Q.loadRepos(FIXED).filter((r) => ['voicepa', 'pr-ninja'].includes(r.name));
t('every repo with too little history: each says so, and none claims to have nothing unfinished',
  [Q.timelineScreen(undatable, null, { now: FIXED }), Q.daysScreen(undatable, null, { now: FIXED })].map((s) => `${s.includes('voicepa · No ship estimate')} ${s.includes('pr-ninja · No ship estimate')} ${s.includes('Nothing unfinished')}`).join(', '),
  'true true false, true true false');
const Hc = screen({ kind: 'timeline', slug: null }, 120, () => FIXED);
await sleep(20);
await Hc.press('z');
for (let i = 0; i < 20 && !/tidy · 7 tickets/.test(Hc.selected()); i++) await Hc.press(DOWN);
await Hc.press('\r');
t('DS-163 AC6 Enter on the repo row opens its Timeline', `${Hc.crumbs()} | ${Hc.tabOn()}`, 'desk-q › tidy | 2 Timeline');
t('DS-163 AC3 and changing repo puts the scale back to auto', scaleLine(Hc), 'Scale: hours (auto) · z to change');
Hc.ui.finish(0);

const days = lines(Q.daysScreen(Q.loadRepos(FIXED), 'acme__tidy', { now: FIXED }));
const groupsOf = (ls) => ls.filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim().replace(/ · \d+ tickets?$/, ''));
const tidyGroups = groupsOf(days);
t('DS-163 AC7 By day opens with Today, then Tomorrow, undated last', `${tidyGroups[0]} | ${tidyGroups.includes('Tomorrow · Tue 20 Oct')} | ${tidyGroups.at(-1)}`, 'Today · Mon 19 Oct | true | No date yet');
t('DS-163 AC7 each dated row has STARTS, SHIPS and its title', days.some((l) => new RegExp(`^ {4}T-3 +○ ready +\\S.* {2}T-3 title$`).test(l) && l.includes(whenAt(tidyF.T['T-3'].likely, FIXED))), true);
const at = (...a) => new Date(...a).getTime();
t('DS-163 AC7 then each day to 6 days out, then the week by its Monday', [at(2026, 9, 21, 10), at(2026, 9, 25, 23), at(2026, 9, 26, 9), at(2026, 10, 4, 9)].map((x) => Q.shipDay(x, FIXED)).join(' | '),
  'Wed 21 Oct | Sun 25 Oct | Week of Mon 26 Oct | Week of Mon 2 Nov');
t('DS-163 AC7 desk-q <repo> days is the By day view', Q.run(['tidy', 'days'], { now: FIXED }), Q.daysScreen(Q.loadRepos(FIXED), 'acme__tidy', { now: FIXED }));

// The median of tidy's 12 size M durations, 4 to 10 h: the 7th of them sorted.
const typicalM = '7.0';
t('DS-163 AC8 (DS-279 AC16) a ticket that needs your answer says so, and how long once answered', [barRow(tidyTl, 'T-4'), days.find((l) => /^ {4}T-4 /.test(l)) ?? ''].every((l) => l.includes(`Needs your answer · ~${typicalM} h once answered`)), true);
t('DS-163 AC8 (DS-217 AC8) a ticket held outside the batch names what holds it', [barRow(tidyTl, 'T-5'), days.find((l) => /^ {4}T-5 /.test(l)) ?? ''].every((l) => l.includes('Held by EXT-5, outside this batch')), true);
t('DS-163 AC8 workers set to 0 says nothing starts', /Workers set to 0: nothing starts +Z-1 title$/.test(barRow(tl('acme__zero'), 'Z-1')), true);

const Ks = screen({ kind: 'timeline', slug: 'acme__tidy' }, 120, () => FIXED);
await sleep(20);
// The worker count is in the header the Timeline shares with the Queue.
const head1 = () => Ks.frame().find((l) => /^● session {2}last pass /.test(l)) ?? '';
const t7 = () => (Ks.frame().find((l) => /^[ ›] T-7 /.test(l)) ?? '').slice(1);
const before7 = t7();
await Ks.press('1');
await Ks.press('-');
await Ks.press('2');
t('DS-163 AC9 back on the Timeline after a workers change on the queue screen', `${Ks.crumbs()} | ${Ks.tabOn()} | ${/ │ workers \d+ of 1 · cap /.test(head1())}`, 'desk-q › tidy | 2 Timeline | true');
t('DS-163 AC9 the dates reflect it', t7() !== before7 && t7() !== '', true);
Ks.ui.finish(0);

const pipedTl = I.run('ships', 'piped'), pipedDays = I.run('piped', 'days');
t('DS-163 AC10 the Timeline piped is plain text, and exits 0', pipedTl.code === 0 && !pipedTl.out.includes('\x1b') && /^ {2}P-1 .*█/m.test(pipedTl.out), true);
t('DS-163 AC10 By day piped is plain text, and exits 0', pipedDays.code === 0 && !pipedDays.out.includes('\x1b') && /^ {4}P-1 /m.test(pipedDays.out), true);
t('DS-163 ships --plain keeps the one-line-per-ticket list', /^ {2}TICKET\s+STATE\s+STARTS\s+SHIPS$/m.test(I.run('ships', 'piped', '--plain').out), true);

// ---- DS-167: titles drop a tag most of the list shares, and run to the right edge.
const readyAll = (keys) => Object.fromEntries(keys.map((k) => [k, ready]));
const titled = (prefix, titles) => Object.fromEntries(titles.map((s, i) => [`${prefix}-${i + 1}`, { summary: s }]));
const LONG_Q = 'which of the two onboarding emails goes out first, and from which address?';
const skills8 = ['autopilot: one', 'autopilot: two', 'autopilot: three', 'autopilot: four', 'autopilot: five', 'autopilot: six', 'autopilot: seven', 'desk-q: other'];
put(I.T, I.env, 'skills8', { port: 4200, conc: '2 / 3', beat: 1, queue: { batch: 's8', concurrency: 2, tickets: {
  ...readyAll(['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7']), 'A-8': { state: 'parked', park: { question: LONG_Q } } } }, triage: titled('A', skills8) });
const voice12 = [1, 2, 3, 4, 5, 6, 7].map((d) => `Your day ${d}/14: step ${d}`).concat(['Gaps between bookings', 'Running-late sheet', 'Check-in text', 'Reminders', 'Calendar sync']);
put(I.T, I.env, 'voice12', { port: 4300, conc: '2 / 3', beat: 1, queue: { batch: 'v12', concurrency: 2, tickets: readyAll(voice12.map((_, i) => `V-${i + 1}`)) }, triage: titled('V', voice12) });
const ninja6 = ['Beats: list', 'Beats: detail', 'Outlets: list', 'Outlets: detail', 'Onboarding copy', 'Settings page'];
put(I.T, I.env, 'ninja6', { port: 4400, conc: '2 / 3', beat: 1, queue: { batch: 'n6', concurrency: 2, tickets: readyAll(ninja6.map((_, i) => `N-${i + 1}`)) }, triage: titled('N', ninja6) });
const repoOf = (name) => Q.loadRepos().find((r) => r.name === name);
const titleCol = (out) => lines(out).find((l) => /^ +# /.test(l)).indexOf('TITLE');
const titlesOf = (name) => { const out = Q.repoScreen(repoOf(name), { width: 160 }), c = titleCol(out); return lines(out).filter((l) => /^ {2} *\*?\d+ {2}/.test(l)).map((l) => l.slice(c)); };
t('DS-167 AC1 7 of 8 titles start "autopilot:": those rows start at the words after it', titlesOf('skills8').join(), 'one,two,three,four,five,six,seven,desk-q: other');
t('DS-167 AC2 7 of 12 titles start "Your day <n>/14:": the tag is dropped from those rows', titlesOf('voice12').slice(0, 7).join(), 'step 1,step 2,step 3,step 4,step 5,step 6,step 7');
t('DS-167 AC3 no tag starts half the titles: every tag stays', titlesOf('ninja6').join(), ninja6.join());
t('DS-167 AC3 a tag on one title alone stays', Q.titler(['desk-q: a'])('desk-q: a'), 'desk-q: a');
t('DS-167 AC4 the ticket screen shows the full title with its tag', lines(Q.ticketScreen(repoOf('skills8'), 'A-1', { width: 160 }))[1], 'autopilot: one');

const head8 = lines(Q.repoScreen(repoOf('skills8'), { width: 160 })).find((l) => /^ +# /.test(l));
// WHAT IT NEEDS takes 52 columns where the terminal has them.
t('DS-167 AC7 (DS-187) the WHAT IT NEEDS column is 52 columns wide', head8.indexOf('STARTS') - head8.indexOf('WHAT IT NEEDS'), 52);
const a8 = lines(Q.repoScreen(repoOf('skills8'), { width: 160 })).find((l) => /A-8 /.test(l));
t('DS-167 AC7 a longer detail is cut to fit it', a8.slice(head8.indexOf('WHAT IT NEEDS'), head8.indexOf('STARTS')), `${LONG_Q.slice(0, 49)}…  `);
t('DS-167 AC7 (DS-218 AC12) the ticket screen still shows the question in full, on its rail', lines(Q.ticketScreen(repoOf('skills8'), 'A-8', { width: 160 }))
  .filter((l) => l.startsWith('▌ ')).map((l) => l.slice(2)).join(' ').startsWith(`Needs your answer: ${LONG_Q}`), true);

// ---- DS-244: a ticket an interactive session claimed says which session, on its row and its page.
const claimSid = '0b6c2e1a-claim';
put(I.T, I.env, 'claimed', { port: 4250, conc: '2 / 3', beat: 1, queue: { batch: 'cl', concurrency: 2, tickets: {
  'CL-1': { state: 'parked', lane: 'A', park: { question: 'worked in another session', since: '2026-10-24T09:00:00Z', claim: { session: claimSid, at: '2026-10-24T09:00:00Z' } } },
  'CL-2': { state: 'parked', lane: 'A', park: { question: 'its worktree has uncommitted changes (a.txt)', since: '2026-10-25T09:00:00Z', claim: { session: claimSid, at: '2026-10-24T09:00:00Z', dirty_at: '2026-10-25T09:00:00Z' } } },
  'CL-3': { state: 'parked', lane: 'D', park: { question: 'lane D — its canvas is not on main', since: '2026-10-24T09:00:00Z', claim: { session: claimSid, at: '2026-10-24T09:00:00Z' } } } } } });
const cl1 = lines(Q.repoScreen(repoOf('claimed'), { width: 160 })).find((l) => /CL-1 /.test(l));
t('DS-244 AC1 desk-q shows a claimed ticket as claimed by its session', cl1.includes(`claimed by session ${claimSid}`), true);
t('DS-244 AC1 its page names the session and how it goes back to the workers', lines(Q.ticketScreen(repoOf('claimed'), 'CL-1', { width: 160 }))
  .filter((l) => l.startsWith('▌ ')).map((l) => l.slice(2)).join(' ').startsWith(`Claimed by session ${claimSid}, which works it.`), true);
t('DS-244 a claimed lane D parked on its design never promises a worker', lines(Q.ticketScreen(repoOf('claimed'), 'CL-3', { width: 160 }))
  .filter((l) => l.startsWith('▌ ')).map((l) => l.slice(2)).join(' ').includes('stays with a person however long that session is idle'), true);
t('DS-244 AC3 once its worktree is found dirty, the row shows the park instead', lines(Q.repoScreen(repoOf('claimed'), { width: 160 })).find((l) => /CL-2 /.test(l)).includes('uncommitted changes'), true);
// Gone again, so the overviews below count the repos they were written for.
for (const d of [join(I.env.DESK_CONFIG_ROOT, 'repos'), join(I.env.DESK_HOME, 'repos'), join(I.env.HOME, '.desk-autopilot')]) rmSync(join(d, 'acme__claimed'), { recursive: true, force: true });

// A dated repo whose W-1 title is longer than any row has room for, and W-2's is short.
dated('wide', 4500, { hours: [4, 5, 6, 7, 8, 9, 10, 4, 5, 6, 7, 8], tickets: { 'W-1': ready, 'W-2': ready, 'W-3': { state: 'parked', park: { question: 'which copy?' } } } });
const LONG_T = `the title that goes on ${'and on '.repeat(30)}to the end`;
for (const [k, summary] of [['W-1', LONG_T], ['W-2', 'short title'], ['W-3', 'parked title']]) writeFileSync(join(I.env.HOME, '.desk-autopilot', 'acme__wide', 'triage', `${k}.json`), JSON.stringify({ ticket: k, summary, size: 'M' }));
const wide = Q.loadRepos(FIXED);
const at160 = { queue: Q.repoScreen(wide.find((r) => r.name === 'wide'), { width: 160, now: FIXED }), 'By day': Q.daysScreen(wide, 'acme__wide', { now: FIXED, width: 160 }), Timeline: Q.timelineScreen(wide, 'acme__wide', { now: FIXED, width: 160 }) };
const rowFor = (out, key) => lines(out).find((l) => new RegExp(`^ +(\\d+ {2})?${key} `).test(l)) ?? '';
t('DS-167 AC5 at 160 columns a longer title runs to the right edge and ends in …', Object.entries(at160).filter(([, out]) => !(rowFor(out, 'W-1').length === 160 && rowFor(out, 'W-1').endsWith('…'))).map(([v]) => v).join(), '');
t('DS-167 AC5 and a title that fits shows whole, with no …', Object.entries(at160).filter(([, out]) => !rowFor(out, 'W-2').endsWith('  short title')).map(([v]) => v).join(), '');
t('DS-167 AC5 an undated Timeline row puts its title in the same column', rowFor(at160.Timeline, 'W-3').indexOf('parked title'), rowFor(at160.Timeline, 'W-2').indexOf('short title'));
t('DS-167 AC5 the Timeline header names TITLE over the titles', lines(at160.Timeline).find((l) => / {2}STARTS +SHIPS +TITLE$/.test(l))?.indexOf('TITLE'), rowFor(at160.Timeline, 'W-2').indexOf('short title'));

// ---- DS-179: a ticket stuck behind 10 blockers keeps its row to the width.
const ten = Array.from({ length: 10 }, (_, n) => `BLK-${101 + n}`);
dated('stuck10', 4600, { hours: [4, 5, 6, 7, 8, 9, 10, 4, 5, 6, 7, 8], tickets: {
  ...Object.fromEntries(ten.map((k) => [k, { state: 'parked', park: { question: 'which copy?' } }])),
  'STK-1': { state: 'parked', held_by: ten.join('|'), park: { question: `held by orchestrator: blocked by ${ten.join(', ')}` } } } });
const stuck10 = Q.loadRepos(FIXED);
const stk = (w) => ({ 'By day': rowFor(Q.daysScreen(stuck10, 'acme__stuck10', { now: FIXED, width: w }), 'STK-1'), Timeline: rowFor(Q.timelineScreen(stuck10, 'acme__stuck10', { now: FIXED, width: w }), 'STK-1') });
t('DS-179 AC1 at 120 and 80 columns, the stuck row is no wider than the terminal', [120, 80].flatMap((w) => Object.entries(stk(w)).filter(([, l]) => !l || l.length > w).map(([v, l]) => `${v}@${w}: ${l.length}`)).join(), '');
t('DS-179 AC1 it says what it waits on, cut with …, and keeps its title', Object.entries(stk(120)).filter(([, l]) => !/After BLK-101, BLK-102, .*… +STK-1 title$/.test(l)).map(([v, l]) => `${v}: ${l}`).join(), '');
t('DS-179 a reason that fits is written whole', rowFor(Q.daysScreen(stuck10, 'acme__stuck10', { now: FIXED, width: 120 }), 'BLK-101').includes('Needs your answer · ~'), true);

const Rz = screen({ kind: 'repo', slug: 'acme__wide' }, 100, () => FIXED);
await sleep(20);
const w1 = () => Rz.frame().find((l) => /^[ ›] +\d+ {2}W-1 /.test(l)) ?? '';
const w1Before = w1().length;
Rz.output.columns = 160;
Rz.output.resize();
t('DS-167 AC6 resized from 100 to 160 columns, the redraw fits titles to the new width', `${w1Before} ${w1().length} ${w1().endsWith('…')}`, '100 160 true');
Rz.ui.finish(0);

// ---- DS-164: a place (every repo, a repo, a ticket) and a view of it. The ACs' voicepa is tidy here,
// the repo with a ship history, so its Timeline and By day have rows to tell apart.
const TABS = '1 Queue  2 Timeline  3 By day';
const tidyQ = { kind: 'repo', slug: 'acme__tidy' };
const nav = (start) => screen(start, 120, () => FIXED);
// Which view the body shows, from what only that view draws.
const shows = (s) => {
  const f = s.frame();
  return f.some((l) => /^ +# {2}TICKET/.test(l) || /^ {2}REPO {2,}LAST PASS/.test(l)) ? 'queue' : f.some((l) => l.startsWith('Scale: ')) ? 'timeline'
    : f.some((l) => /^ {4}( {12})?TICKET +STATE +STARTS +SHIPS +TITLE$/.test(l)) ? 'days' : f.some((l) => /^ {2}(REPO {8})?EPIC +TITLE +CHILDREN +SHIPS$/.test(l) || l === 'No queued ticket here belongs to an epic.') ? 'epics'
      : f.some((l) => l.startsWith('No cost sources for ') || /^ {2}SUPPLIER +FOR +CHARGED$/.test(l)) ? 'costs' : 'none';
};
// Wide enough that every keys line is one line.
const keysLine = (s) => s.frame().at(-1);
const where = (s) => `${s.crumbs()} | ${s.tabOn()} | ${shows(s)}`;

const N1 = nav(tidyQ);
await sleep(20);
t('DS-164 the Queue shows first, its tab line under the breadcrumb', `${where(N1)} | ${N1.frame()[1].startsWith(TABS)}`, 'desk-q › tidy | 1 Queue | queue | true');
await N1.press('\t');
t('DS-164 AC1 Tab on a repo\'s Queue shows its Timeline, Timeline highlighted', `${where(N1)} | ${N1.frame()[1].startsWith(TABS)}`, 'desk-q › tidy | 2 Timeline | timeline | true');
await N1.press('\t'); await N1.press('\t'); await N1.press('\t'); await N1.press('\t');
t('DS-164 Tab from Costs wraps round to the Queue', where(N1), 'desk-q › tidy | 1 Queue | queue');
await N1.press('\x1b[Z');
t('DS-164 shift+Tab steps back', where(N1), 'desk-q › costs › tidy | 5 Costs | costs');
N1.ui.finish(0);

// DS-182: ← and → step along the tab bar and stop at its ends, in both arrow encodings.
const RIGHT = '\x1b[C', LEFT = '\x1b[D', SS3_RIGHT = '\x1bOC', SS3_LEFT = '\x1bOD';
const Ar = nav(tidyQ);
await sleep(20);
const topRow = Ar.selected();
await Ar.press(LEFT);
t('DS-182 AC4 ← on the Queue stays on the Queue', where(Ar), 'desk-q › tidy | 1 Queue | queue');
await Ar.press(RIGHT);
t('DS-182 AC1 → (CSI) on the Queue shows the Timeline', where(Ar), 'desk-q › tidy | 2 Timeline | timeline');
await Ar.press(SS3_RIGHT);
t('DS-182 AC1 → (SS3) on the Timeline shows By day', where(Ar), 'desk-q › tidy | 3 By day | days');
await Ar.press(RIGHT); await Ar.press(RIGHT); await Ar.press(RIGHT);
t('DS-182 → on the rightmost tab stays there', where(Ar), 'desk-q › costs › tidy | 5 Costs | costs');
await Ar.press('\t');
t('DS-182 AC5 Tab on the rightmost tab still wraps to the Queue', where(Ar), 'desk-q › tidy | 1 Queue | queue');
await Ar.press('4');
await Ar.press(LEFT);
t('DS-182 AC2 ← (CSI) on Epics shows By day', where(Ar), 'desk-q › tidy | 3 By day | days');
await Ar.press(SS3_LEFT); await Ar.press(SS3_LEFT);
t('DS-182 AC2 ← (SS3) steps back to the Queue', where(Ar), 'desk-q › tidy | 1 Queue | queue');
await Ar.press(DOWN); await Ar.press(DOWN);
const selBefore = Ar.selected();
await Ar.press(RIGHT); await Ar.press(LEFT);
t('DS-182 AC6 an arrow switch keeps the place and resets the selection', `${where(Ar)} | ${selBefore !== topRow} | ${Ar.selected() === topRow}`, 'desk-q › tidy | 1 Queue | queue | true | true');
await Ar.press(':'); await Ar.press(RIGHT); await Ar.press(SS3_LEFT);
t('DS-182 AC8 the arrows leave the view alone while a : command is typed', `${where(Ar)} | ${Ar.frame().at(-1).startsWith(':')}`, 'desk-q › tidy | 1 Queue | queue | true');
Ar.ui.finish(0);

const threes = [];
for (const start of [{ kind: 'overview', all: false }, tidyQ, { kind: 'timeline', slug: 'acme__tidy' }]) {
  const s = nav(start);
  await sleep(20);
  await s.press('3');
  threes.push(where(s));
  s.ui.finish(0);
}
t('DS-164 AC2 3 shows By day for that place', threes.join(' / '), 'desk-q | 3 By day | days / desk-q › tidy | 3 By day | days / desk-q › tidy | 3 By day | days');

const N3 = nav({ kind: 'timeline', slug: 'acme__tidy' });
await sleep(20);
await N3.press('\x1b');
t('DS-164 AC3 Esc on a repo\'s Timeline shows every repo\'s Timeline', where(N3), 'desk-q | 2 Timeline | timeline');
N3.ui.finish(0);

const N4 = nav({ kind: 'days', slug: 'acme__tidy' });
await sleep(20);
t('DS-164 AC4 (DS-215) the breadcrumb reads desk-q › tidy, then the time', /^desk-q › tidy · \d\d:\d\d$/.test(N4.frame()[0]), true);
await N4.click(3, 1);
t('DS-164 AC4 a click on desk-q in the breadcrumb shows every repo\'s By day', where(N4), 'desk-q | 3 By day | days');
N4.ui.finish(0);

const N5 = nav(tidyQ);
await sleep(20);
await N5.click(N5.frame()[1].indexOf('2 Timeline') + 3, 2);
t('DS-164 AC5 a click on "2 Timeline" in the tab line shows that repo\'s Timeline', where(N5), 'desk-q › tidy | 2 Timeline | timeline');
await N5.click(N5.frame()[1].indexOf('1 Queue') + 1, 2);
t('DS-164 AC5 and a click on "1 Queue" its Queue again', where(N5), 'desk-q › tidy | 1 Queue | queue');
N5.ui.finish(0);

const N6 = nav({ kind: 'timeline', slug: 'acme__tidy' });
await sleep(20);
await N6.press(DOWN); await N6.press(DOWN);
const picked = N6.selected().slice(1).trim().split(/\s+/)[0];
await N6.press('\r');
const opened6 = N6.crumbs();
await N6.press('\x1b');
t('DS-164 AC6 a ticket opened from the Timeline, then Esc: the Timeline again, the same ticket selected',
  `${opened6} | ${where(N6)} | ${N6.selected().slice(1).trim().split(/\s+/)[0]}`, `desk-q › tidy › ${picked} | desk-q › tidy | 2 Timeline | timeline | ${picked}`);
N6.ui.finish(0);

const tidyFile = join(I.env.DESK_HOME, 'repos', 'acme__tidy', 'queue.json');
const N7 = nav({ kind: 'timeline', slug: 'acme__tidy' });
await sleep(20);
await N7.press(DOWN); await N7.press(DOWN);
const sel7 = N7.selected(), file7 = readFileSync(tidyFile, 'utf8');
await N7.press(SHIFT_UP);
t('DS-164 AC7 shift+↑ on the Timeline moves nothing', `${readFileSync(tidyFile, 'utf8') === file7} ${N7.selected() === sel7}`, 'true true');
t('DS-164 AC7 and the status line says where to reorder', N7.frame().at(-2), Q.REORDER_HERE);
t('DS-164 AC7 in the words of the criterion', Q.REORDER_HERE, 'Reorder on the Queue view (press 1). The dates follow.');
await N7.press('t');
t('DS-164 AC7 t on the Timeline moves nothing either', readFileSync(tidyFile, 'utf8') === file7, true);
N7.ui.finish(0);

const ws = [];
for (const start of [tidyQ, { kind: 'days', slug: 'acme__tidy' }, { kind: 'overview', all: false }]) {
  const s = nav(start);
  await sleep(20);
  await s.press('w');
  ws.push(`${s.tabOn()} ${shows(s)}`);
  s.ui.finish(0);
}
t('DS-164 AC8 w shows the Timeline from a Queue, a By day and every repo\'s Queue', ws.join(', '), '2 Timeline timeline, 2 Timeline timeline, 2 Timeline timeline');

const N9 = nav({ kind: 'ticket', slug: 'acme__tidy', key: 'T-3' });
await sleep(20);
const tabsShown = () => N9.frame().some((l) => l.includes(TABS));
t('DS-164 AC9 a ticket screen has no tab line', `${N9.crumbs()} | ${N9.frame()[1]} | ${tabsShown()}`, 'desk-q › tidy › T-3 |  | false');
await N9.press('\t'); await N9.press('2'); await N9.press('w');
t('DS-164 AC9 and Tab, 2 and w leave it on the ticket', `${N9.crumbs()} | ${tabsShown()}`, 'desk-q › tidy › T-3 | false');
const ticketFrame = N9.frame().join('\n');
await N9.press(RIGHT); await N9.press(LEFT); await N9.press(SS3_RIGHT); await N9.press(SS3_LEFT);
// An odd count, so a tab changed out of sight would not step back to where it started.
await N9.press(RIGHT);
const ticketAfter = N9.frame().join('\n');
await N9.press('\x1b');
t('DS-182 AC7 ← and → on a ticket change nothing, not even the view Esc goes back to', `${ticketAfter === ticketFrame} | ${where(N9)}`, 'true | desk-q › tidy | 1 Queue | queue');
await N9.click(4, 1);
t('DS-164 a click on desk-q from a ticket goes to every repo', N9.crumbs(), 'desk-q');
N9.ui.finish(0);

// AC10: each view's keys, against what each view's handler takes.
const views10 = {};
const N10 = screen({ kind: 'overview', all: false }, 300, () => FIXED);
await sleep(20);
for (const [id] of Q.VIEWS) { await N10.press(String(Q.VIEWS.findIndex(([v]) => v === id) + 1)); views10[`every ${id}`] = keysLine(N10); }
N10.ui.finish(0);
const N10r = screen(tidyQ, 300, () => FIXED);
await sleep(20);
for (const [id] of Q.VIEWS) { await N10r.press(String(Q.VIEWS.findIndex(([v]) => v === id) + 1)); views10[`repo ${id}`] = keysLine(N10r); }
await N10r.press('1'); await N10r.press(DOWN); await N10r.press('\r');
views10.ticket = keysLine(N10r);
N10r.ui.finish(0);
const has = (line, k) => line.includes(k);
const want10 = {
  'every queue': { yes: ['←→ or 1–5 view', 'a all repos', 'c parked dates'], no: ['esc back', 'shift+↑↓', 'z scale', '+ −'] },
  'every timeline': { yes: ['←→ or 1–5 view', 'z scale', 'c parked dates'], no: ['esc back', 'shift+↑↓', 'a all repos', '+ −'] },
  'every days': { yes: ['←→ or 1–5 view', 'c parked dates'], no: ['esc back', 'shift+↑↓', 'z scale', 'a all repos'] },
  'every epics': { yes: ['←→ or 1–5 view', 'c parked dates'], no: ['esc back', 'shift+↑↓', 'z scale', 'a all repos'] },
  'every costs': { yes: ['←→ or 1–5 view', '↑↓ select', 'enter open'], no: ['esc back', 'shift+↑↓', 'z scale', 'a all repos', 'c parked dates'] },
  'repo costs': { yes: ['←→ or 1–5 view', '↑↓ select', 'o open the bill', 'esc back'], no: ['enter open', 'shift+↑↓', 'z scale', 'a all repos', 'c parked dates'] },
  'repo queue': { yes: ['←→ or 1–5 view', 'shift+↑↓ move', 't top', '+ − workers', 'esc back'], no: ['z scale', 'a all repos'] },
  'repo timeline': { yes: ['←→ or 1–5 view', 'z scale', 'esc back'], no: ['shift+↑↓', 't top', '+ −', 'a all repos'] },
  'repo days': { yes: ['←→ or 1–5 view', 'esc back'], no: ['shift+↑↓', 'z scale', '+ −', 'a all repos'] },
  'repo epics': { yes: ['←→ or 1–5 view', 'esc back'], no: ['shift+↑↓', 'z scale', '+ −', 'a all repos'] },
  ticket: { yes: ['shift+↑↓ move', 'l log', 'esc back'], no: ['←→ or 1–5 view', 'z scale', 'a all repos'] },
};
t('DS-164 AC10 each view lists only the keys it accepts', Object.entries(want10).flatMap(([v, { yes, no }]) => [
  ...yes.filter((k) => !has(views10[v] ?? '', k)).map((k) => `${v} lacks ${k}`), ...no.filter((k) => has(views10[v] ?? '', k)).map((k) => `${v} lists ${k}`)]).join(' | '), '');

const N80 = screen(tidyQ, 80, () => FIXED);
await sleep(20);
// DS-186 AC10: a keys line too wide goes on two, "move" then "act", each key bold.
// The act line is itself wider than 80, so it carries on, indented, under its label.
const k80 = N80.frame().slice(N80.frame().findIndex((l) => l.startsWith('move  ')));
t('DS-164 AC10 (DS-186 AC10) at 80 columns the Queue\'s keys go on a move line and an act line, none lost',
  `${k80[0] === 'move  ↑↓ select · enter open · ←→ or 1–5 view · esc back'} ${k80[1].startsWith('act   shift+↑↓ move · ')} ${k80.slice(2).every((l) => l.startsWith('      '))} ${k80.at(-1).endsWith('q quit')} ${k80.every((l) => l.length <= 80)}`,
  'true true true true true');
t('DS-186 AC10 each key is bold, its words plain', ['↑↓', 'enter', '←→ or 1–5', 'esc', 'shift+↑↓', 'q'].every((k) => lastFrame(N80).join('').includes(`\x1b[1m${k}\x1b[22m `)), true);
N80.ui.finish(0);

// A row clicked is selected and opened; a click report cut across two reads is still one click.
const Nc = nav({ kind: 'overview', all: false });
await sleep(20);
const tidyRow = Nc.frame().findIndex((l) => /^[ ›] {1,2}tidy /.test(l));
Nc.input.write('\x1b['); await sleep(5);
Nc.input.write(`<0;5;${tidyRow + 1}`); await sleep(5);
Nc.input.write('M'); await sleep(20);
t('DS-164 a click on a repo row opens it, even when the report comes in three reads', `${Nc.crumbs()} | ${Nc.tabOn()}`, 'desk-q › tidy | 1 Queue');
t('DS-164 a click leaves no stray keys behind', Nc.frame().at(-1).startsWith(':'), false);
Nc.ui.finish(0);
t('DS-164 leaving the screen turns mouse reporting off', Q.LEAVE_SCREEN.includes('\x1b[?1000l') && Q.LEAVE_SCREEN.includes('\x1b[?1006l'), true);

// ---- DS-166: a repo's Timeline by epic, the epic as a place, and the Epics view. The ACs' voicepa
// is feat here: three epics (one under way, one provisional, one with no date) and two tickets in none.
const EP1 = { key: 'E-1', summary: 'Smart scheduling, your day: plan the day ahead', children: [{ key: 'F-1', done: false }, { key: 'F-2', done: false }, { key: 'F-3', done: true }] };
const EP2 = { key: 'E-2', summary: 'Beats - list and detail', children: [{ key: 'F-4', done: false }, { key: 'F-9', done: false }] };
const EP3 = { key: 'E-3', summary: 'Outlets — sync', children: [{ key: 'F-5', done: false }] };
dated('feat', 4600, { hours: [4, 5, 6, 7, 8, 9, 10, 4, 5, 6, 7, 8], tickets: {
  'F-1': { state: 'running', stage: '4/9' }, 'F-2': ready, 'F-3': { state: 'done', result: { pr: 3 }, merged_at: new Date(FIXED - 2 * HOUR).toISOString() },
  'F-4': ready, 'F-5': { state: 'parked', park: { question: 'which copy?' } }, 'F-6': ready, 'F-7': ready } });
for (const [k, epic] of Object.entries({ 'F-1': EP1, 'F-2': EP1, 'F-3': EP1, 'F-4': EP2, 'F-5': EP3 })) {
  writeFileSync(join(I.env.HOME, '.desk-autopilot', 'acme__feat', 'triage', `${k}.json`), JSON.stringify({ ticket: k, summary: `${k} title`, size: 'M', epic }));
}
const featRepos = Q.loadRepos(FIXED);
const featF = Q.forecastOf(featRepos.find((r) => r.name === 'feat'), { now: FIXED });
const featTl = lines(Q.timelineScreen(featRepos, 'acme__feat', { now: FIXED }));
const epicRowOf = (name) => featTl.find((l) => l.startsWith(`  ${name} `)) ?? '';
const e1 = epicRowOf('Smart scheduling, your day'), e2 = epicRowOf('Beats'), e3 = epicRowOf('Outlets');
t('DS-166 AC1 an epic is one row named by its summary up to the colon, with children done of total and a bar',
  /^ {2}Smart scheduling, your day +1\/3 [ ┆]*█+░*[ ┆]*[ ▸] /.test(e1), true);
t('DS-166 AC1 then its STARTS and SHIPS, the header naming both', `${e1.endsWith(`started${' '.repeat(6)}${whenAt(featF.E['E-1'].likely, FIXED)}`)} ${featTl.some((l) => /^ +now .* {2}STARTS {7}SHIPS$/.test(l))}`, 'true true');
const datedEpics = ['E-1', 'E-2'].sort((a, b) => featF.E[a].likely - featF.E[b].likely).map((k) => ({ 'E-1': e1, 'E-2': e2 })[k]);
t('DS-166 AC1 sorted by SHIPS, the undated one last', featTl.filter((l) => [e1, e2, e3].includes(l)).join('\n'), [...datedEpics, e3].join('\n'));
t('DS-166 AC2 an epic under way reads "started"', /\sstarted\s/.test(e1), true);
t('DS-166 AC3 a provisional epic\'s row ends "provisional"', /^ {2}Beats +0\/2 .*█.* {2}provisional$/.test(e2), true);
t('DS-166 AC4 an epic with no date gives the reason instead of a bar', `${e3.includes('No date: 1 needs you')} ${e3.includes('█')}`, 'true false');
const other = featTl.findIndex((l) => l === '  Other work · 2 tickets with no epic');
t('DS-166 AC5 the tickets in no epic follow under "Other work", each by title and state with its own bar',
  other > featTl.indexOf(e3) && featTl.slice(other + 1, other + 3).map((l) => /^ {4}(F-\d) title +○ ready +[ ┆]*█/.exec(l)?.[1]).sort().join(), 'F-6,F-7');
t('DS-166 AC5 none of an epic\'s tickets is a row of its own', featTl.some((l) => /F-[1-5]/.test(l)), false);

const Fa = nav({ kind: 'timeline', slug: 'acme__feat' });
await sleep(20);
const rawLine = (s, text) => s.output.buf.split('\x1b[H').at(-1).split('\r\n').find((l) => l.replace(ANSI, '').includes(text)) ?? '';
t('DS-166 AC3 a provisional epic\'s bar is amber', rawLine(Fa, 'Beats').includes('\x1b[38;5;180m█'), true);
for (let i = 0; i < 10 && !Fa.selected().includes('Smart scheduling'); i++) await Fa.press(DOWN);
await Fa.press('\r');
const kidRows = Fa.frame().filter((l) => /^[ ›] F-\d /.test(l)).map((l) => l.slice(2, 5));
t('DS-166 AC6 Enter on an epic: its Timeline, one bar per child, under its breadcrumb', `${where(Fa)} | ${kidRows.sort().join()}`, 'desk-q › feat › Smart scheduling, your day | 2 Timeline | timeline | F-1,F-2');
t('DS-166 AC6 the header names the epic\'s key and children done', Fa.frame().some((l) => l.startsWith('forecast  from ') && l.endsWith(' · E-1: 1 of 3 children done')), true);
await Fa.press('\x1b');
t('DS-166 AC7 Esc on the epic\'s Timeline: the repo\'s Timeline, the epic still selected', `${where(Fa)} | ${Fa.selected().includes('Smart scheduling')}`, 'desk-q › feat | 2 Timeline | timeline | true');
await Fa.press('4');
const epicsRows = Fa.frame().filter((l) => /^[ ›] {1,2}E-\d /.test(l));
const epicsRow = (k) => epicsRows.find((l) => l.slice(2).startsWith(k)) ?? '';
t('DS-166 AC8 4 shows the Epics view, one row per epic', `${where(Fa)} | ${epicsRows.length}`, 'desk-q › feat | 4 Epics | epics | 3');
// On screen the bar is solid, its not-yet-queued part grey (DS-218); plain output keeps □ for it.
t('DS-166 AC8 each with a bar of done, queued and not-yet-queued children', `${epicsRow('E-1').includes(`${'■'.repeat(16)}    1/3`)} ${epicsRow('E-2').includes(`${'■'.repeat(16)}    0/2`)} ${rawLine(Fa, 'E-2').includes(`${G}${'■'.repeat(8)}\x1b[39m`)}`, 'true true true');
t('DS-166 AC8 its SHIPS and the child that sets the date', epicsRow('E-1').endsWith(`${whenAt(featF.E['E-1'].likely, FIXED).padEnd(14)}set by ${featF.E['E-1'].setBy}`), true);
t('DS-166 AC8 a provisional or undated epic says so there', `${epicsRow('E-2').endsWith('provisional: 1 not queued')} ${epicsRow('E-3').includes('No date: 1 needs you')}`, 'true true');
await Fa.press('\r');
t('DS-166 AC8 Enter on an epic there opens its Timeline', where(Fa), 'desk-q › feat › Smart scheduling, your day | 2 Timeline | timeline');
await Fa.press('4');
t('DS-166 AC9 4 in an epic leaves the view as it is', where(Fa), 'desk-q › feat › Smart scheduling, your day | 2 Timeline | timeline');
t('DS-166 AC9 and the status line says why', Fa.frame().includes("An epic has no Epics view: you're already in one."), true);
await Fa.press('1');
t('the epic\'s Queue lists its children only', Fa.frame().filter((l) => /^[ ›] +\d+ {2}F-\d /.test(l)).map((l) => l.trim().replace(/^›\s*/, '').split(/\s+/)[1]).sort().join(), 'F-1,F-2');
const featFile = join(I.env.DESK_HOME, 'repos', 'acme__feat', 'queue.json'), featBefore = readFileSync(featFile, 'utf8');
await Fa.press(DOWN); await Fa.press(SHIFT_UP); await Fa.press('t');
t('the epic\'s Queue moves nothing, and says to reorder on the repo\'s', `${readFileSync(featFile, 'utf8') === featBefore} ${Fa.frame().includes(Q.REORDER_IN_REPO)}`, 'true true');
await Fa.press('\t'); await Fa.press('\t'); await Fa.press('\t');
t('Tab in an epic skips the Epics view', where(Fa), 'desk-q › feat › Smart scheduling, your day | 1 Queue | queue');
await Fa.press('3'); await Fa.press(RIGHT); await Fa.press(SS3_RIGHT);
t('DS-182 AC3 → on By day in an epic stays on By day', `${where(Fa)} | ${Fa.frame().includes(Q.NO_EPICS_HERE)}`, 'desk-q › feat › Smart scheduling, your day | 3 By day | days | false');
// DS-290 AC4-AC6: Costs are home's only.
const ALL_TABS = '1 Queue  2 Timeline  3 By day  4 Epics  5 Costs';
const tabLine = (s) => s.output.buf.split('\x1b[H').at(-1).split('\r\n')[1] ?? '';
t('DS-290 AC4 an epic\'s tab line dims 5 Costs', `${Fa.frame()[1].startsWith(ALL_TABS)} | ${tabLine(Fa).includes(`${G}5 Costs\x1b[39m`)}`, 'true | true');
await Fa.press('5');
t('DS-290 AC5 5 in an epic leaves the view as it is, and says why', `${where(Fa)} | ${Fa.frame().includes(Q.NO_COSTS_HERE)}`, 'desk-q › feat › Smart scheduling, your day | 3 By day | days | true');
await Fa.press('\t');
const tabbed = where(Fa);
await Fa.press('\x1b[Z');
t('DS-290 AC6 Tab and shift+Tab in an epic skip Costs', `${tabbed} || ${where(Fa)}`, 'desk-q › feat › Smart scheduling, your day | 1 Queue | queue || desk-q › feat › Smart scheduling, your day | 3 By day | days');
Fa.ui.finish(0);

// DS-292 AC7: a repo's tab line has 5 Costs, and 5 or → from Epics shows the repo's costs.
const Rc = nav(tidyQ);
await sleep(20);
const repoTabs = `${Rc.frame()[1].startsWith(ALL_TABS)} | ${tabLine(Rc).includes(`${G}5 Costs\x1b[39m`)}`;
await Rc.press('4'); await Rc.press('5');
const after5 = `${where(Rc)} | ${Rc.frame().includes(Q.noCostSourcesFor('tidy'))}`;
await Rc.press('4'); await Rc.press(RIGHT);
t('DS-292 AC7 a repo\'s tab line has 5 Costs, and 5 or → from Epics show its costs',
  `${repoTabs} || ${after5} || ${where(Rc)}`, 'true | false || desk-q › costs › tidy | 5 Costs | costs | true || desk-q › costs › tidy | 5 Costs | costs');
Rc.ui.finish(0);
// With five tabs the parked note no longer fits after them at 104 columns, so it takes its own line.
const Rn = screen(tidyQ, 104, () => FIXED);
await sleep(20);
await Rn.press('c');
t('a repo\'s parked note too long for the tab line at 104 columns goes on its own line, key and all',
  `${Rn.frame()[1].trimEnd()} | ${Rn.frame()[2].trimEnd()}`, `${ALL_TABS} | Tickets that need your answer dated at the next check-in · c to undo`);
Rn.ui.finish(0);

const everyFeat = lines(Q.timelineScreen(featRepos, null, { now: FIXED }));
t('DS-166 AC10 every repo\'s Timeline stays one bar per ticket, grouped by repo', `${everyFeat.includes('  feat · 6 tickets')} ${['F-1', 'F-2', 'F-4', 'F-6'].every((k) => everyFeat.some((l) => l.startsWith(`  ${pad10(k)}`)))} ${everyFeat.some((l) => /Other work|Smart scheduling/.test(l))}`,
  'true true false');

// ---- DS-181: the Queue views' state counts and state cells in their state's colour
const HUE = {
  'H-1': { state: 'running', stage: '4/9' }, 'H-2': ready, 'H-3': { state: 'parked', held_by: 'H-1', park: { question: 'held by orchestrator: blocked by H-1' } },
  'H-4': { state: 'parked', park: { question: 'which copy?' } }, 'H-5': { state: 'parked', held_by: 'H-4', park: { question: 'held by orchestrator: blocked by H-4' }, open_questions: 1, outside_blockers: [{ key: 'EXT-5', category: 'new' }] },
  'H-6': { state: 'failed', park: { question: 'tests red' } } };
dated('hue', 4100, { hours: [2, 3, 4, 5, 2, 3, 4, 5, 2, 3, 4, 5], tickets: HUE });
const ovRow = (s, name) => lastFrame(s).find((l) => l.replace(ANSI, '').replace(/^›/, ' ').startsWith(`  ${name} `)) ?? '';
const Ov = nav({ kind: 'overview', all: false });
await sleep(20);
// After LAST PASS, each count; a ticket held outside the batch or whose worker stopped counts as needs you.
t('DS-181 AC1 (DS-279 AC14) each non-zero count in its state\'s colour: running, ready, waiting, needs you', coloured(ovRow(Ov, 'hue')).slice(1).join(' '), '38;5;108:1 38;5;75:1 38;5;180:1 38;5;176:3');
t('DS-181 AC1 (DS-186 AC4, DS-215 AC13) zero counts are grey, the one non-zero count coloured',
  coloured(ovRow(Ov, 'slow'), true).slice(1, 7).join(' '), '38;5;247:0 38;5;75:4 38;5;247:0 38;5;247:0 38;5;247:0 38;5;247:0');
Ov.ui.finish(0);

const Hq = nav({ kind: 'repo', slug: 'acme__hue' });
await sleep(20);
const stateCell = (s, key) => coloured(lastFrame(s).find((l) => l.replace(ANSI, '').slice(1).includes(` ${key} `)) ?? '', true)[0] ?? '';
const keys = ['H-1', 'H-2', 'H-3', 'H-4', 'H-5', 'H-6'];
const queueCells = keys.map((k) => stateCell(Hq, k));
// DS-186 AC2: each state with its glyph, in its colour; held outside the batch and a stopped worker need you (DS-279 AC6).
t('DS-181 AC2 (DS-186 AC2) one repo\'s Queue shows each state cell with its glyph in its colour', queueCells.join(' '),
  '38;5;108:● running 38;5;75:○ ready 38;5;180:· waiting 38;5;176:◆ needs you 38;5;176:◆ needs you 38;5;176:◆ needs you');
await Hq.press('2');
t('DS-181 AC2 (DS-186 AC2) the same on the Timeline', keys.slice(0, 5).map((k) => stateCell(Hq, k)).join(' '), queueCells.slice(0, 5).join(' '));
await Hq.press('3');
t('DS-186 AC2 and on By day', keys.slice(0, 5).map((k) => stateCell(Hq, k)).join(' '), queueCells.slice(0, 5).join(' '));
await Hq.press('1');
await Hq.press(DOWN);
const selRaw = lastFrame(Hq).find((l) => l.replace(ANSI, '').startsWith('›')) ?? '';
// DS-186 AC5: a 256-colour 236 background opens before the first cell and closes after an erase to
// the end of the line, which the terminal fills with it; no reverse video, and the state keeps its colour.
t('DS-186 AC5 the selected row is tinted across its full width, keeping each cell\'s colour',
  `${selRaw.startsWith('\x1b[48;5;236m›')} ${selRaw.endsWith('\x1b[K\x1b[49m')} ${/\x1b\[(7|27|0)m/.test(selRaw)} ${coloured(selRaw).join()}`, 'true true false 38;5;75:○ ready');
t('DS-186 AC5 the tint is not erased again after it', Hq.output.buf.split('\x1b[H').at(-1).includes('\x1b[K\x1b[49m\x1b[K'), false);
Hq.ui.finish(0);

// DS-186 AC5 on the other views: Timeline, By day and Epics keep each cell's colour under the tint.
const Ht = nav({ kind: 'timeline', slug: 'acme__hue' });
await sleep(20);
const tintedRow = (s) => lastFrame(s).find((l) => l.startsWith('\x1b[48;5;236m')) ?? '';
const tintSeen = [];
// By day's first row is its day heading, so the selection steps down onto a ticket.
for (const v of ['2', '3']) { await Ht.press(v); if (v === '3') await Ht.press(DOWN); tintSeen.push(`${coloured(tintedRow(Ht)).length > 0} ${/\x1b\[7m/.test(tintedRow(Ht))}`); }
Ht.ui.finish(0);
const Fe = nav({ kind: 'repo', slug: 'acme__feat' });
await sleep(20);
await Fe.press('4');
tintSeen.push(`${coloured(tintedRow(Fe)).length > 0} ${/\x1b\[7m/.test(tintedRow(Fe))}`);
Fe.ui.finish(0);
t('DS-186 AC5 Timeline, By day and Epics: a coloured selected row, no reverse video', tintSeen.join(', '), 'true false, true false, true false');

const Hn = screen({ kind: 'repo', slug: 'acme__hue' }, 24, () => FIXED);
// Tall enough for every row and its group heading.
Hn.output.rows = 80; Hn.output.resize();
await sleep(20);
const narrow = lastFrame(Hn).filter((l) => /H-\d/.test(l));
t('DS-181 AC4 a truncated row ends in … at the width, every colour closed before it', `${narrow.length} ${JSON.stringify(narrow.filter((l) => {
  const p = l.replace(ANSI, '');
  return !(p.length === 24 && p.endsWith('…') && (l.match(/\x1b\[(3[0-8]|38;5;\d+)m/g) ?? []).length === (l.match(/\x1b\[39m/g) ?? []).length);
}))}`, '6 []');
Hn.ui.finish(0);

process.env.NO_COLOR = '1';
const Hp = nav({ kind: 'repo', slug: 'acme__hue' });
await sleep(20);
const hpFrame = lastFrame(Hp).join('\n');
t('DS-181 AC5 (DS-186 AC6) with NO_COLOR, no colour codes, no tint, and the selected row still in reverse video', `${/\x1b\[(?:1;)?(3\d|38;[25];[\d;]+|4\d|48;5;\d+)m/.test(hpFrame)} ${/\x1b\[7m›/.test(hpFrame)}`, 'false true');
await Hp.press('\x1b');
t('DS-181 AC5 nor on every repo\'s Queue', `${Hp.crumbs()} ${/\x1b\[(?:1;)?(3[0-7]|38;[25];[\d;]+)m/.test(lastFrame(Hp).join('\n'))}`, 'desk-q false');
await Hp.press('2');
t('DS-181 AC5 nor on the Timeline, which is coloured without NO_COLOR', `${Hp.tabOn()} ${/\x1b\[(?:1;)?(3[0-7]|38;[25];[\d;]+)m/.test(lastFrame(Hp).join('\n'))}`, '2 Timeline false');
Hp.ui.finish(0);
delete process.env.NO_COLOR;

// ---- DS-186: one colour and weight system on every screen.
// AC1 and AC7: hue's H-2, dated, with a lane reason, files, a branch and a Jira site.
put(I.T, I.env, 'hue', { port: 4100, conc: '2 / 3', beat: 1, jira: 'acme.atlassian.net', queue: { batch: 'hue', concurrency: 2, tickets: HUE },
  triage: { ...Object.fromEntries(Object.keys(HUE).map((k) => [k, { summary: `${k} title`, size: 'M' }])),
    'H-2': { summary: 'H-2 title', size: 'M', lane: 'A', lane_reason: 'mechanical once read', files_in_scope: ['src/a.ts'], branch: 'feat/H-2-x' } } });
const Tp = nav({ kind: 'ticket', slug: 'acme__hue', key: 'H-2' });
await sleep(20);
const tp = lastFrame(Tp);
const tpLine = (text) => tp.find((l) => l.replace(ANSI, '').startsWith(text)) ?? '';
t('DS-186 AC1 on a ticket\'s page the state after the key is in its colour, with its glyph', tpLine('H-2  ').includes('\x1b[38;5;75m○ ready\x1b[39m'), true);
t('DS-186 AC1 the Ships date is bold', /Ships {5}\x1b\[39m\x1b\[1m[^\x1b]+\x1b\[22m\x1b\[38;5;247m {2}could run to/.test(tpLine('Ships ')), true);
t('DS-186 AC1 (DS-215 AC13) the branch, the Jira link and the file paths are grey',
  [tpLine('Branch ').includes(`${G}feat/H-2-x`), tpLine('Open ').includes(`${G}acme.atlassian.net/browse/H-2`), tpLine('  src/a.ts').startsWith(G)].join(), 'true,true,true');
t('DS-186 AC7 the ticket page\'s headings are bold', ['Why lane A', 'Files in scope'].map((p) => tpLine(p).startsWith('\x1b[1m')).join(), 'true,true');
t('DS-186 AC7 (DS-215 AC13) the breadcrumb\'s last part is bold, the parts before it grey, then the time',
  new RegExp(`^${esc(`${G}desk-q\x1b[39m${G} › \x1b[39m${G}hue\x1b[39m${G} › \x1b[39m\x1b[1mH-2\x1b[22m${G} · \x1b[39m`)}\\d\\d:\\d\\d`).test(tp[0]), true);
Tp.ui.finish(0);
const Hb = nav({ kind: 'repo', slug: 'acme__hue' });
await sleep(20);
t('DS-186 AC7 the Queue\'s column header row is bold', lastFrame(Hb).some((l) => /^\x1b\[1m +# {2}TICKET/.test(l)), true);
Hb.ui.finish(0);

// AC3: a batch passing on time, one stopped for under a day and one for over a day, each with a
// ticket that needs the user so the overview lists it. The one stopped for hours has a history and a
// ready ticket, so its QUEUE DONE reads passes stopped.
const needsOne = (b) => ({ batch: b, concurrency: 1, tickets: { [`${b.toUpperCase()}-1`]: { state: 'parked', park: { question: 'which copy?' } } } });
put(I.T, I.env, 'ontime', { port: 4800, conc: '1 / 2', beat: 1, queue: needsOne('ontime') });
dated('hours', 4810, { hours: [2, 3, 4, 5, 2, 3, 4, 5, 2, 3, 4, 5], tickets: { ...needsOne('hours').tickets, 'HOURS-2': ready } });
put(I.T, I.env, 'hours', { port: 4810, conc: '1 / 2', beat: 200, queue: { batch: 'hours', concurrency: 1, tickets: { ...needsOne('hours').tickets, 'HOURS-2': ready } } });
put(I.T, I.env, 'longgone', { port: 4820, conc: '1 / 2', beat: 3000, queue: needsOne('longgone') });
const Lp = screen({ kind: 'overview', all: false }, 200);
Lp.output.rows = 80; Lp.output.resize();
await sleep(20);
const passCell = (name) => coloured(ovRow(Lp, name))[0] ?? '';
t('DS-186 AC3 LAST PASS: live in green, stopped under a day in yellow, over a day in red',
  `${/^38;5;108:● session · \d+m ago$/.test(passCell('ontime'))} ${/^38;5;180:■ stopped · 3h 2\dm$/.test(passCell('hours'))} ${/^38;5;210:■ stopped · 2d 2h$/.test(passCell('longgone'))}`, 'true true true');
// AC8: each ports overlap note's ▲ is yellow; "N tickets need you" is bold magenta.
const lpRaw = lastFrame(Lp);
const overlaps = lpRaw.filter((l) => / {2}▲ ports +\S+ \+ /.test(l.replace(ANSI, '')));
t('DS-186 AC8 each ports overlap note starts ▲, in yellow', `${overlaps.length > 0} ${overlaps.every((l) => l.includes('\x1b[38;5;180m▲ ports'))}`, 'true true');
t('DS-186 AC8 (DS-215 AC12) "N tickets need you" is bold magenta', lpRaw.some((l) => /^\x1b\[1;38;5;176m◆ \d+ tickets need you\x1b\[22;39m/.test(l)), true);
// AC4: the ALL DONE BY notes "passes stopped" and "no history" are grey.
t('DS-186 AC4 the ALL DONE BY notes passes stopped and no history are grey', `${ovRow(Lp, 'hours').includes(`${G}passes stopped`)} ${ovRow(Lp, 'ontime').includes(`${G}no history`)}`, 'true true');
Lp.ui.finish(0);

// AC9: the Timeline's legend names a swatch per state shown, each in its colour; Epics' swatches too.
const Lg = screen({ kind: 'timeline', slug: 'acme__tidy' }, 160, () => FIXED);
Lg.output.rows = 80; Lg.output.resize();
await sleep(20);
// DS-218 AC8: one key line, its bar swatches first, then each state shown with its glyph.
const legendRaw = lastFrame(Lg).find((l) => l.replace(ANSI, '').startsWith('key ')) ?? '';
t('DS-186 AC9 (DS-218 AC8) the Timeline key line: the bar, the check-ins, then each state shown', legendRaw.replace(ANSI, '').trim(),
  'key   █ starts to ships  █ could run to (1 run in 5 is later) │ ┆ check-ins 08:00 and 17:00 │ ● running  ○ ready  ◆ needs you');
t('DS-186 AC9 each state in its colour, and no "colour shows state"',
  `${['\x1b[38;5;108m● running\x1b[39m', '\x1b[38;5;75m○ ready\x1b[39m', '\x1b[38;5;176m◆ needs you\x1b[39m'].every((s) => legendRaw.includes(s))} ${Lg.output.buf.includes('colour shows state')}`, 'true false');
Lg.ui.finish(0);
const Le = screen({ kind: 'repo', slug: 'acme__feat' }, 160, () => FIXED);
Le.output.rows = 80; Le.output.resize();
await sleep(20);
await Le.press('4');
t('DS-186 AC9 the Epics legend\'s swatches are coloured as the bars are', lastFrame(Le).some((l) => l.startsWith('\x1b[38;5;247mkey \x1b[39m  \x1b[38;5;108m■\x1b[39m done  \x1b[38;5;180m■\x1b[39m in the queue  \x1b[38;5;247m■\x1b[39m not queued yet')), true);
Le.ui.finish(0);

// AC11: --plain and piped output carry no escape codes, and the glyphs still show.
const plainOuts = [W.run('--plain'), W.run('--plain', 'voicepa'), W.run('--plain', 'voicepa', 'show', 'VPL-3'), I.run('ships', 'piped'), I.run('piped', 'days'), W.run()];
t('DS-186 AC11 --plain and piped output: no escape codes', plainOuts.filter((o) => o.out.includes('\x1b')).length, 0);
t('DS-186 AC11 and the glyphs still show', `${plainOuts[0].out.includes('● session · ')} ${plainOuts[1].out.includes('● running')} ${plainOuts[2].out.includes('· waiting')} ${plainOuts[3].out.includes('○ ready')} ${plainOuts[4].out.includes('◆ needs you')}`,
  'true true true true true');

// DS-190 AC1 and AC3: from the shell, a running ticket reads its worker's last stage marker; one with
// no log keeps the queue's stage as of the last pass.
const SL = world({ voicepa: { port: 3100, conc: '3 / 5', beat: 4, queue: { batch: 'vp', concurrency: 3, tickets: {
  'VPL-1': { state: 'running', stage: '0/9' }, 'VPL-2': { state: 'running', stage: '0/9' } } } } });
const slLogs = join(SL.env.HOME, '.desk-autopilot', 'acme__voicepa', 'logs');
mkdirSync(slLogs, { recursive: true });
const saidAt = new Date(NOW - 2 * 60000);
writeFileSync(join(slLogs, 'VPL-1.log'), `${JSON.stringify({ type: 'assistant', timestamp: saidAt.toISOString(), message: { content: [{ type: 'text', text: 'AUTOPILOT_STAGE: 4/9 verify' }] } })}\n`);
const slOut = SL.run('--plain', 'voicepa').out;
t('DS-190 AC1 the CLI shows the worker\'s stage since its marker', (lines(slOut).find((l) => /VPL-1/.test(l)) ?? '').includes(`stage 4/9 verify since ${saidAt.toTimeString().slice(0, 5)}`), true);
t('DS-190 AC3 a running ticket with no log keeps the last pass\'s stage', /VPL-2\s+● running\s+stage 0\/9 as of \d\d:\d\d\s/.test(lines(slOut).find((l) => /VPL-2/.test(l)) ?? ''), true);

// ---- Lead with what needs you, a repo's Queue grouped by state, a ticket's status first.
// AC1: voicepa has two tickets parked on the user and one blocked behind them; pr-ninja has one.
const NY = world({ voicepa: { port: 3100, conc: '3 / 5', beat: 4, queue: { batch: 'vp', concurrency: 3, tickets: {
  'VPL-1': { state: 'parked', park: { question: 'which copy?' } }, 'VPL-2': { state: 'parked', park: { question: 'which price?' } },
  'VPL-3': { state: 'parked', held_by: 'VPL-1', park: { question: 'held by orchestrator: blocked by VPL-1' }, open_questions: 1, outside_blockers: [{ key: 'EXT-3', category: 'new' }] } } } } });
t('DS-187 AC1 (DS-279 AC6) the overview opens with how many need you, each repo\'s count, most first, a ticket held outside the batch among them',
  lines(NY.run('--plain').out)[0], '◆ 4 tickets need you │ voicepa 3 · pr-ninja 1');
const NYs = screen({ kind: 'overview', all: false }, 400);
await sleep(20);
t('DS-187 AC1 on the screen it is the first line under the tabs', `${NYs.frame()[1].startsWith('1 Queue')} ${NYs.frame()[3].startsWith('◆ ')} ${NYs.frame()[3] === lines(Q.overview(Q.loadRepos(), { avail: 30 }))[0]}`, 'true true true');
NYs.ui.finish(0);

// mixed's queue order is not its group order: needs you, ready, blocked, running, ready, waiting.
dated('mixed', 4830, { hours: [2, 3, 4, 5, 2, 3, 4, 5, 2, 3, 4, 5], tickets: {
  'M-1': { state: 'parked', park: { question: 'which copy?' } }, 'M-2': { ...ready, branch: 'feat/M-2-x', collides_with: 'M-5' },
  'M-3': { state: 'parked', held_by: 'M-1', park: { question: 'held by orchestrator: blocked by M-1' }, open_questions: 1, outside_blockers: [{ key: 'EXT-3', category: 'new' }] }, 'M-4': { state: 'running', stage: '4/9' },
  'M-5': ready, 'M-6': { state: 'parked', held_by: 'M-2', park: { question: 'held by orchestrator: blocked by M-2' } } } });
const mixedTriage = join(I.env.HOME, '.desk-autopilot', 'acme__mixed', 'triage');
writeFileSync(join(mixedTriage, 'M-2.json'), JSON.stringify({ ticket: 'M-2', epic: null, summary: 'M-2 title', size: 'M', lane: 'A', lane_reason: 'mechanical once read', files_in_scope: ['src/m.ts'] }));
writeFileSync(join(mixedTriage, 'M-5.json'), JSON.stringify({ ticket: 'M-5', epic: null, summary: LONG_T, size: 'M' }));
const mixed = () => Q.loadRepos(FIXED).find((r) => r.name === 'mixed');
const GROUP_LINE = /^ {2}([A-Z][a-z]+(?: you)?) · (\d+)$/;
const groupsAndKeys = (out) => lines(out).map((l) => GROUP_LINE.exec(l)?.slice(1).join(' · ') ?? /^ +\d+ {2}(M-\d)\s/.exec(l)?.[1]).filter(Boolean).join(' | ');
const mixedQ = Q.repoScreen(mixed(), { width: 140, now: FIXED });
t('DS-187 AC2 (DS-279 AC1) the Queue is grouped Running, Ready, Waiting, Needs you, each group in queue order', groupsAndKeys(mixedQ),
  'Running · 1 | M-4 | Ready · 2 | M-2 | M-5 | Waiting · 1 | M-6 | Needs you · 2 | M-1 | M-3');
const mixedHead = lines(mixedQ).find((l) => /^ +# /.test(l));
t('DS-187 AC3 at 140 columns WHAT IT NEEDS follows STATE and is at least 50 wide',
  `${mixedHead.indexOf('WHAT IT NEEDS') === mixedHead.indexOf('STATE') + 13} ${mixedHead.indexOf('STARTS') - mixedHead.indexOf('WHAT IT NEEDS') >= 50}`, 'true true');
const m5 = lines(mixedQ).find((l) => /^ +\d+ {2}M-5 /.test(l)) ?? '';
t('DS-187 AC3 and TITLE takes the rest of the width', `${m5.length} ${m5.endsWith('…')}`, '140 true');
const mixedPlain = I.run('--plain', 'mixed').out;
t('DS-187 AC9 --plain keeps the group headings and the WHAT IT NEEDS column',
  `${/^ {2}Needs you · 2$/m.test(mixedPlain)} ${/^ +# {2}TICKET +STATE +WHAT IT NEEDS +STARTS/m.test(mixedPlain)}`, 'true true');

const m2Page = lines(Q.ticketScreen(mixed(), 'M-2', { width: 120, now: FIXED, jiraUrl: 'https://acme.atlassian.net/browse/M-2' }));
const fieldsOf = (ls) => ls.map((l) => /^(Starts|Ships|Based on|Holding up|Branch|Open) {2,}\S/.exec(l)?.[1]).filter(Boolean).join();
const at2 = (p) => m2Page.findIndex((l) => l.startsWith(p));
t('DS-187 AC6 (DS-218) a ticket\'s page: the ticket line, the title, the rail, then Holding up, Starts, Ships, Based on, Branch and Open',
  `${m2Page[0].startsWith('M-2  ○ ready │ ')} ${m2Page[1]} ${fieldsOf(m2Page)} ${at2('▌ ') === 3}`, 'true M-2 title Holding up,Starts,Ships,Based on,Branch,Open true');
t('DS-187 AC6 (DS-218 AC6) Holding up names the ticket waiting on this one with its state, and Open the keys', `${m2Page[at2('Holding up')]} | ${m2Page[at2('Open')]}`,
  'Holding up  · M-6 (waiting) waits on this ticket | Open      l log  ·  o Jira  acme.atlassian.net/browse/M-2');
t('DS-187 AC6 (DS-218) the lane rationale, the files in scope and never-runs-with, in that order, then Open',
  `${at2('Why lane A') < at2('Files in scope · 1')} ${at2('Files in scope · 1') < at2('Never runs with M-5')} ${at2('Never runs with M-5') < at2('Open')}`, 'true true true');
t('DS-187 AC7 a ticket nothing waits on has no Holding up line', fieldsOf(lines(Q.ticketScreen(mixed(), 'M-5', { width: 120, now: FIXED }))).includes('Holding up'), false);

const Gm = screen({ kind: 'repo', slug: 'acme__mixed' }, 140, () => FIXED);
await sleep(20);
const selKey = () => /^›\s+\d+\s+(\S+)/.exec(Gm.selected())?.[1] ?? Gm.selected();
const walk = [selKey()];
for (const k of [DOWN, DOWN, DOWN, '\x1b[A']) { await Gm.press(k); walk.push(selKey()); }
t('DS-187 AC8 the selection starts on the first ticket, and ↓ and ↑ step over the group headings', walk.join(), 'M-4,M-2,M-5,M-6,M-5');
const readyHeading = Gm.frame().findIndex((l) => l.trim() === 'Ready · 2');
await Gm.click(5, readyHeading + 1);
t('DS-187 a click on a group heading selects nothing and opens nothing', `${Gm.crumbs()} ${selKey()}`, 'desk-q › mixed M-5');
Gm.ui.finish(0);

// AC5: passes stopped for five hours; at 60 columns the resume instruction wraps rather than being cut.
put(I.T, I.env, 'halted', { port: 4840, conc: '1 / 2', beat: 300, queue: { batch: 'halted', concurrency: 1, tickets: { 'HL-1': ready } } });
const Hs = screen({ kind: 'repo', slug: 'acme__halted' }, 60);
await sleep(20);
const hsFrame = Hs.frame();
const hsHead = hsFrame.slice(2, hsFrame.findIndex((l) => /^ +# {2}TICKET/.test(l)));
t('DS-187 AC5 on a narrow terminal the stopped batch\'s resume instruction wraps, never cut with …',
  `${hsHead.some((l) => l.endsWith('…'))} ${hsHead.every((l) => l.length <= 60)} ${hsHead.includes('To resume: run /desk-autopilot in halted.')}`, 'false true true');
Hs.ui.finish(0);

// ---- DS-194: a done ticket whose PR is still in CI shows as landing, from the pass's pr_status.
const ago194 = (m) => new Date(NOW - m * 60000).toISOString();
const ubuntu = { name: 'tests (ubuntu-latest)', status: 'completed', conclusion: 'success', started: ago194(30), completed: new Date(NOW - 30 * 60000 + 455000).toISOString(), runner: true };
const macos = { name: 'tests (macos-latest)', status: 'queued', conclusion: null, started: ago194(14), completed: null, runner: false };
const prOpen = (checks) => ({ pr: 164, state: 'OPEN', url: 'https://github.com/acme/land/pull/164', checks, at: ago194(1) });
const heldBy = (by) => ({ state: 'parked', held_by: by, park: { question: `held by orchestrator: blocked by ${by}` } });
// LD-1 landing; LD-2 held by it alone; LD-3 by it and the running LD-4; LD-0 merged, LD-9 done unread.
// Its supervisor runs the passes and config §3 lets green PRs merge, so a landing PR merges by itself.
function landRepo(checks, { beat = 1, ps = prOpen(checks) } = {}) {
  put(I.T, I.env, 'land', { port: 4900, conc: '2 / 3', beat, perms: { 'autopilot-merge': 'yes', 'pr-merge-green': 'yes' }, queue: { batch: 'land', concurrency: 2, supervised: true, tickets: {
    'LD-1': { state: 'done', result: { pr: 164 }, pr_status: ps },
    'LD-2': heldBy('LD-1'), 'LD-3': heldBy('LD-1|LD-4'), 'LD-4': { state: 'running', stage: '3/9' },
    'LD-0': { state: 'done', result: { pr: 160 }, pr_status: { pr: 160, state: 'MERGED', url: null, checks: [], at: ago194(30) } },
    'LD-9': { state: 'done', result: { pr: 161 } },
  } }, triage: { 'LD-1': { summary: 'resume from the last round' }, 'LD-2': { summary: 'separate models' } } });
  return Q.loadRepos(NOW).find((r) => r.name === 'land');
}
const landQueue = (r) => lines(Q.repoScreen(r, { now: NOW }));
const landRow = (ls, key) => ls.find((l) => new RegExp(`^ +(-|\\d+) {2}${key} `).test(l)) ?? '';
const lq = landQueue(landRepo([ubuntu, macos]));
t('DS-194 AC3 (DS-279 AC4) the PR in CI is in a Merging group above Waiting', lq.indexOf('  Merging · 1') >= 0 && lq.indexOf('  Merging · 1') < lq.indexOf('  Waiting · 2'), true);
t('DS-194 AC3 (DS-279 AC8) its state reads ▸ merging, and WHAT IT NEEDS its PR, the check holding it, then how many are done', landRow(lq, 'LD-1'),
  `     -  LD-1      ▸ merging    ${'#164 · macOS: no runner, 14m · 1 of 2 done'.padEnd(52)}${'started'.padEnd(13)}${'—'.padEnd(14)}resume from the last round`);
// AC4 and the colours, on the screen.
async function landingRaw(checks, key = 'LD-1', opts) {
  landRepo(checks, opts);
  const s = screen({ kind: 'repo', slug: 'acme__land' }, 140, () => NOW);
  await sleep(20);
  const l = lastFrame(s).find((x) => new RegExp(`^.\\s+(-|\\d+) {2}${key} `).test(x.replace(ANSI, ''))) ?? '';
  const head = lastFrame(s).find((x) => x.replace(ANSI, '').startsWith('◆ ')) ?? '';
  s.ui.finish(0);
  return { l, head };
}
const build = { name: 'build', status: 'completed', conclusion: 'success', started: ago194(20), completed: ago194(12), runner: true };
const raw194 = await landingRaw([ubuntu, macos]);
t('DS-194 AC3 the state is cyan, and AC4 a check queued 10 minutes with no runner is yellow', coloured(raw194.l).filter((c) => /merging|#164|runner/.test(c)).join(), '38;5;73:▸ merging,38;5;73:#164,38;5;180:macOS: no runner, 14m');
const e2eRunning = { name: 'e2e', status: 'in_progress', conclusion: null, started: ago194(5), runner: true };
t('DS-194 AC4 a running check reads its name and age', landRow(landQueue(landRepo([build, e2eRunning])), 'LD-1').includes('#164 · e2e running, 5m · 1 of 2 done '), true);
const red194 = await landingRaw([build, { name: 'e2e', status: 'completed', conclusion: 'failure', started: ago194(5), completed: ago194(2), runner: true }]);
t('DS-194 AC4 (DS-279 AC9) a failed check leads the row, in red, with no pass count', `${coloured(red194.l).includes('38;5;210:1 check failed')} ${/passed/.test(red194.l.replace(ANSI, ''))}`, 'true false');
t('DS-194 AC4 (DS-279 AC7) every check passed reads merges at the next pass, the count in green', `${coloured((await landingRaw([build])).l).includes('38;5;108:1 check passed')} ${landRow(landQueue(landRepo([build])), 'LD-1').includes('#164 · 1 check passed · merges at the next pass')}`, 'true true');
// AC5: the header counts the merging PR, in cyan.
t('DS-194 AC5 (DS-215, DS-279) the counts line counts the PRs merging and the merged tickets', lq[1], '◆ nothing needs you  ● 1 running  ▸ 1 merging  · 2 waiting │ ✓ 2 done, not shown');
t('DS-194 AC5 the merging count is cyan', coloured(raw194.head).includes('38;5;73:▸ 1 merging'), true);
// AC6: a held ticket names its merging blocker by its PR.
t('DS-194 AC6 (DS-217 AC2) the only blocker left is merging: behind its PR and the check holding it, starting after it', /· waiting {4}behind #164: tests \(macos-latest\) queued +after #164 /.test(landRow(lq, 'LD-2')), true);
t('DS-194 AC6 with another blocker left, both are listed and STARTS is not after the PR', `${/· waiting {4}behind #164, LD-4 /.test(landRow(lq, 'LD-3'))} ${/after #/.test(landRow(lq, 'LD-3'))}`, 'true false');
t('DS-194 AC6 the PR is cyan in the row', coloured((await landingRaw([ubuntu, macos], 'LD-2')).l).includes('38;5;73:#164'), true);
// AC7: the held ticket's page lists the landing blocker's checks, then when they were read.
const p2 = lines(Q.ticketScreen(landRepo([ubuntu, macos]), 'LD-2', { now: NOW }));
const i7 = p2.findIndex((l) => l.startsWith('Blockers  '));
const lead194 = ' '.repeat(14);
t('DS-194 AC7 the merging blocker, one line per check, then when the last pass read them', p2.slice(i7 + 1, i7 + 5).join('\n'), [
  '  ▸ LD-1      merging    #164 · macOS: no runner, 14m · 1 of 2 done',
  `${lead194}✓  ${'tests (ubuntu-latest)'.padEnd(26)}passed in 7m 35s`,
  `${lead194}◌  ${'tests (macos-latest)'.padEnd(26)}queued 14m, no runner yet`,
  `${lead194}checked by the last pass, 1m ago · https://github.com/acme/land/pull/164`].join('\n'));
const p2f = lines(Q.ticketScreen(landRepo([build, e2eRunning, { name: 'lint', status: 'completed', conclusion: 'failure', started: ago194(9), completed: ago194(8), runner: true }]), 'LD-2', { now: NOW }));
t('DS-194 AC7 a running check with its age, and a failed one', [`${'e2e'.padEnd(26)}running 5m`, `${'lint'.padEnd(26)}failed`].every((s) => p2f.some((l) => l.endsWith(s))), true);
// DS-278 AC8: a ticket's fix try and what it is fixing, and a PR no worker can fix, read from the queue alone.
put(I.T, I.env, 'land', { port: 4900, conc: '2 / 3', beat: 1, perms: { 'autopilot-merge': 'yes', 'pr-merge-green': 'yes' }, queue: { batch: 'land', concurrency: 2, supervised: true, tickets: {
  'LD-1': { state: 'triaged', lane: 'A', result: { pr: 164 }, fix: { try: 1, of: 2, pr: 164, what: 'red: Backend tests, Lint' } },
  'LD-5': { state: 'done', result: { pr: 165 }, fix: { try: 2, of: 2, pr: 165, what: 'conflicts with main', finished: ago194(5) }, stuck: { why: 'still in conflict with main after 2 fix tries', pr: 165 } },
} }, triage: {} });
const r278 = Q.loadRepos(NOW).find((r) => r.name === 'land');
t('DS-278 AC8 the ticket shows its try number and what the try is fixing', lines(Q.ticketScreen(r278, 'LD-1', { width: 120, now: NOW })).includes('Fix try   1 of 2 · red: Backend tests, Lint'), true);
const p278 = lines(Q.ticketScreen(r278, 'LD-5', { width: 120, now: NOW }));
t('DS-278 AC8 a PR no worker can fix shows its last try and why it is left to you', p278.includes('Fix try   2 of 2 · conflicts with main') && p278.includes('For you   still in conflict with main after 2 fix tries'), true);
landRepo([ubuntu, macos]);
const G7 = screen({ kind: 'ticket', slug: 'acme__land', key: 'LD-2' }, 140, () => NOW);
await sleep(20);
const g7line = G7.frame().find((l) => l.includes('checked by the last pass')) ?? '';
await G7.press('g');
t('DS-194 AC7 on the screen the line offers g, and g opens the PR', `${g7line.trim()} | ${G7.opened.join()}`, 'checked by the last pass, 1m ago · g open #164 on GitHub | https://github.com/acme/land/pull/164');
G7.ui.finish(0);
// AC8: with passes stopped, the merging row says when its checks were read, dimmed.
const stoppedRow = landRow(landQueue(landRepo([ubuntu, macos], { beat: 300 })), 'LD-1');
const hhmm = new Date(NOW - 60000).toTimeString().slice(0, 5);
t('DS-194 AC8 passes stopped: as of the last read, what holds it', new RegExp(`▸ merging {4}#164 · as of ${hhmm}: tests \\(macos-latest\\) queued`).test(stoppedRow), true);
t('DS-194 AC8 and it is grey', coloured((await landingRaw([ubuntu, macos], 'LD-1', { beat: 300 })).l, true).some((c) => c.startsWith(`38;5;247:as of ${hhmm}: tests (macos-latest) queued`)), true);
// AC9: once the pass records the PR merged, the ticket leaves Merging and counts as merged.
const mergedQ = landQueue(landRepo([ubuntu], { ps: { ...prOpen([ubuntu]), state: 'MERGED' } }));
t('DS-194 AC9 a merged PR leaves Merging and is counted merged', `${mergedQ.some((l) => /Merging|LD-1 |merging/.test(l))} ${mergedQ[1].endsWith(' │ ✓ 3 done, not shown')}`, 'false true');
// AC10: desk-q reads only what the pass recorded: a gh on its PATH is never called.
landRepo([ubuntu, macos]);
mkdirSync(join(I.T, 'stub-gh'), { recursive: true });
writeFileSync(join(I.T, 'stub-gh', 'gh'), `#!/bin/sh\necho "$@" >> "${join(I.T, 'gh-calls')}"\n`, { mode: 0o755 });
const ghEnv = { ...I.env, PATH: `${join(I.T, 'stub-gh')}:${process.env.PATH}` };
// Each run must render its landing data, or "no gh call" would also pass on a crash.
const runs194 = [[['--plain', 'land'], '▸ merging'], [['--plain', 'land', 'show', 'LD-2'], 'checked by the last pass'], [['--plain', 'land', 'show', 'LD-1'], 'Checks on #164:'], [['--plain'], 'land']]
  .map(([args, want]) => { const p = spawnSync('node', [BIN, ...args], { encoding: 'utf8', env: ghEnv }); return p.status === 0 && p.stdout.includes(want); });
t('DS-194 AC10 every run renders the landing data', runs194.join(), 'true,true,true,true');
t('DS-194 AC10 desk-q makes no gh call', readdirSync(I.T).includes('gh-calls'), false);

// ---- DS-217: a held ticket says what it waits on; one nothing will release reads as needs you or blocked.
// hold has no merge driver, no supervisor and no merge grant; holdsup's supervisor merges green PRs;
// holdask's supervisor runs, but merging is ask with no batch approval, so it starts no merge driver.
const check217 = (name, status) => ({ name, status, conclusion: status === 'completed' ? 'success' : null, started: ago194(5), completed: null, runner: true });
const prAt = (pr, more = {}) => ({ state: 'done', result: { pr }, pr_status: { pr, state: 'OPEN', url: null, isDraft: false, reviewDecision: null, mergeable: 'MERGEABLE', checks: [check217('tests', 'in_progress')], at: ago194(1), ...more } });
const mergedAt = (pr) => ({ state: 'done', result: { pr }, pr_status: { pr, state: 'MERGED', url: null, checks: [], at: ago194(1) } });
const outside = (n, category = 'new') => Array.from({ length: n }, (_, i) => ({ key: `OUT-${i + 1}`, category }));
const twelveHours = [4, 5, 6, 7, 8, 9, 10, 4, 5, 6, 7, 8];
dated('hold', 5000, { hours: twelveHours, tickets: {
  'B-RUN': { state: 'running', stage: '4/9' }, 'W-1': heldBy('B-RUN'),
  'B-DRAFT': prAt(175, { isDraft: true }), 'W-3': heldBy('B-DRAFT'),
  'B-READY': prAt(176), 'W-4': heldBy('B-READY'),
  'B-PARK': { state: 'parked', park: { question: 'which copy?' } }, 'W-5P': heldBy('B-PARK'),
  'B-RED': { state: 'failed', park: { question: 'tests red' } }, 'W-5F': heldBy('B-RED'), 'W-5N': heldBy('W-3'),
  'B-MERGED': mergedAt(170), 'W-7': heldBy('B-MERGED'),
  'W-8': { ...heldBy('B-RUN'), open_questions: 1, outside_blockers: outside(27) },
  'W-9': { ...heldBy('B-MERGED'), open_questions: 1, outside_blockers: outside(1, 'indeterminate') },
  'W-10': { ...heldBy('B-RUN'), open_questions: 0, outside_blockers: outside(2) } } });
dated('holdsup', 5010, { hours: twelveHours, supervised: true, perms: { 'autopilot-merge': 'yes', 'pr-merge-green': 'yes' }, tickets: {
  'B-GREEN': prAt(177), 'W-2': heldBy('B-GREEN'), 'B-MERGED': mergedAt(171), 'W-6': heldBy('B-MERGED'),
  'B-CONF': prAt(178, { mergeable: 'CONFLICTING' }), 'W-2C': heldBy('B-CONF'),
  'B-HOLD': { ...prAt(180), merge_blocked: 'merge hold: build and push the Lambda images first — backend/**, 1 file(s), e.g. backend/handler.ts' }, 'W-2H': heldBy('B-HOLD'),
  'W-0': { ...heldBy(''), park: { question: 'held by orchestrator' } } } });
dated('holdask', 5020, { hours: twelveHours, supervised: true, perms: { 'autopilot-merge': 'ask', 'pr-merge-green': 'ask' }, tickets: {
  'B-ASK': prAt(179), 'W-4A': heldBy('B-ASK'), 'B-MERGED': mergedAt(172), 'W-6A': heldBy('B-MERGED'),
  'C-1': heldBy('C-2'), 'C-2': heldBy('C-1'), 'C-3': heldBy('C-1') } });
// Two tickets behind one draft, a third behind one of them, and one with 27 open Jira blockers outside
// the batch still asked about. Merging is ask, with no supervisor.
dated('skills24', 5030, { hours: twelveHours, perms: { 'autopilot-merge': 'ask', 'pr-merge-green': 'ask' }, tickets: {
  'DS-150': prAt(175, { isDraft: true }), 'DS-168': { ...heldBy('DS-150'), open_questions: 1, outside_blockers: outside(27) },
  'DS-175': heldBy('DS-150'), 'DS-180': heldBy('DS-175') } });
const repos217 = Q.loadRepos(FIXED);
const repo217 = (name) => repos217.find((r) => r.name === name);
const queue217 = (name) => lines(Q.repoScreen(repo217(name), { now: FIXED }));
// STATE, WHAT IT NEEDS, STARTS and SHIPS of a plain row, each trimmed.
const cells217 = (name, key, n = 2) => {
  const l = queue217(name).find((x) => new RegExp(`^ +\\d+ {2}${key} `).test(x)) ?? '';
  return [l.slice(18, 31), l.slice(31, 83), l.slice(83, 96), l.slice(96, 110)].slice(0, n).map((s) => s.trim()).join(' | ');
};
t('DS-217 AC1 behind a running blocker: waiting, with its stage', cells217('hold', 'W-1'), '· waiting | behind B-RUN (running, stage 4/9)');
t('DS-217 AC2 behind a PR a supervisor merges: waiting, naming the check, and STARTS after it merges', cells217('holdsup', 'W-2', 3), '· waiting | behind #177: tests running | after #177');
t('DS-217 (DS-279) behind a PR in conflict that a fix try takes on: waiting', cells217('holdsup', 'W-2C'), '· waiting | behind #178: merge conflict with main');
t('DS-217 (DS-280 AC9) behind a PR the merge driver leaves under a merge hold: waiting on the PR, which needs you', cells217('holdsup', 'W-2H'), '· waiting | behind #180, which needs you');
t('DS-217 (DS-279 AC16) a hold that names no blocker: needs you, since nothing lets it start', cells217('holdsup', 'W-0'), '◆ needs you | held behind no recorded blocker: let it start');
// The page's rail, its wrapped lines joined.
const railText = (page) => lines(page).filter((l) => l.startsWith('▌ ')).map((l) => l.slice(2)).join(' ');
const w0 = Q.ticketScreen(repo217('holdsup'), 'W-0', { now: FIXED });
t('DS-217 (DS-218 AC1) its page says so on the rail and gives the release command, each on a line of its own',
  `${railText(w0)} | ${lines(w0).includes('node ~/.claude/desk/bin/queue.mjs set W-0 state=triaged park=null held_by=null')}`, 'Needs you. Held behind no recorded blocker: let it start. Run, in holdsup: | true');
t('DS-217 AC3 (DS-280 AC9) behind a draft: waiting on the draft, which needs you', cells217('hold', 'W-3'), '· waiting | behind #175, which needs you');
// hold's: W-7 by its hold, B-PARK's question, B-RED's stopped worker, W-8 and W-9 held outside the
// batch, and the PRs of B-DRAFT and B-READY; W-3 and W-4 wait on those PRs, so count once.
t('DS-217 AC3 (DS-279 AC14, DS-280 AC9) the PR it is behind is counted in what needs you, and it is not', lines(Q.overview(repos217, { now: FIXED, avail: 30 })).find((l) => l.startsWith('◆ '))?.includes(' hold 7'), true);
t('DS-217 AC4 (DS-280 AC9) behind a ready PR nothing runs to merge: waiting on it', cells217('hold', 'W-4'), '· waiting | behind #176, which needs you');
t('DS-217 AC4 or merging is ask with no batch approval', cells217('holdask', 'W-4A'), '· waiting | behind #179, which needs you');
const rail217 = (name, key) => railText(Q.ticketScreen(repo217(name), key, { now: FIXED }));
t('DS-218 AC1 (DS-279) a PR\'s own page says whether it needs you: a draft, one nothing merges, a conflict a fix try takes on, a merge hold',
  ['hold B-DRAFT', 'hold B-READY', 'holdsup B-CONF', 'holdsup B-HOLD'].map((s) => rail217(...s.split(' '))).join(' / '),
  'Needs you: PR #175, draft · undraft it once it is reviewed. / Needs you: PR #176, tests running, 0m · 0 of 1 done · merge it once green. / '
  + 'Moves without you: PR #178, merge conflict with main · the next pass sends it to a worker, try 1 of 2. / Needs you: PR #180, only a person merges it: build and push the Lambda images first · merge it.');
t('DS-218 AC1 a PR that merges by itself moves without you', rail217('holdsup', 'B-GREEN').startsWith('Moves without you: PR #177, tests running'), true);
const halted218 = Q.loadRepos(NOW).find((r) => r.name === 'halted');
t('DS-218 AC1 with passes stopped a ready ticket will not move until they resume, and says how',
  railText(Q.ticketScreen(halted218, 'HL-1', { now: NOW })), 'Will not move until passes resume. Run /desk-autopilot in halted.');
put(I.T, I.env, 'halted', { port: 4840, conc: '1 / 2', beat: 300, queue: { batch: 'halted', concurrency: 1, tickets: {
  'HL-1': { state: 'running', stage: '3/9' }, 'HL-2': { ...heldBy('HL-1'), open_questions: 1, outside_blockers: outside(2) } } } });
t('DS-218 AC1 with passes stopped a ticket blocked outside the batch still says what blocks it, not that passes would move it',
  railText(Q.ticketScreen(Q.loadRepos(NOW).find((r) => r.name === 'halted'), 'HL-2', { now: NOW })).startsWith('Will not start on its own. 2 Jira tickets outside this batch'), true);
put(I.T, I.env, 'halted', { port: 4840, conc: '1 / 2', beat: 300, queue: { batch: 'halted', concurrency: 1, tickets: { 'HL-1': ready } } });
t('DS-217 AC5 (DS-279 AC16) behind a blocker that needs you, whose worker stopped or is parked: waiting, which needs you',
  ['W-5N', 'W-5F', 'W-5P'].map((k) => cells217('hold', k)).join(' / '),
  '· waiting | behind W-3 / · waiting | behind B-RED, which needs you / · waiting | behind B-PARK, which needs you');
t('DS-217 AC6 every blocker merged, with a supervisor: waiting to start', cells217('holdsup', 'W-6'), '· waiting | starts at the next pass');
t('DS-217 AC7 every blocker merged, with no merge driver or supervisor: needs you, let it start', cells217('hold', 'W-7'), '◆ needs you | every blocker merged: let it start');
t('DS-217 AC7 its page gives the release command the pass prints', Q.ticketScreen(repo217('hold'), 'W-7', { now: FIXED }).includes(
  'Run, in hold:\n\nnode ~/.claude/desk/bin/queue.mjs set W-7 state=triaged park=null held_by=null\nnode ~/.claude/desk/bin/queue.mjs front W-7\n'), true);
t('DS-217 AC8 (DS-279 AC6) open Jira blockers outside the batch: needs you, no start and no date, whatever its blocker does', cells217('hold', 'W-8', 4), '◆ needs you | held by 27 Jira tickets outside: start anyway? | — | no date');
t('DS-217 AC8 once the user confirms it can start without them, outside blockers no longer block it', cells217('hold', 'W-10'), '· waiting | behind B-RUN (running, stage 4/9)');
t('DS-217 AC6 every blocker merged, a supervisor but no merge grant: nothing lets it start, so it needs you', cells217('holdask', 'W-6A'), '◆ needs you | every blocker merged: let it start');
t('DS-217 two tickets held behind each other both need you, and one behind them waits saying so',
  ['C-1', 'C-2', 'C-3'].map((k) => cells217('holdask', k)).join(' / '),
  '◆ needs you | C-2 is held behind this one: let one of them start / ◆ needs you | C-1 is held behind this one: let one of them start / · waiting | behind C-1, which needs you');
const w9 = Q.ticketScreen(repo217('hold'), 'W-9', { now: FIXED });
t('DS-217 AC9 with its batch blockers merged and one outside open, the page never says every blocker is done',
  `${/Every blocker is done/.test(w9)} ${railText(w9).startsWith('Will not start on its own. 1 Jira ticket outside this batch must be done first, and nothing in this batch moves it.')}`, 'false true');
t('DS-217 AC9 no ticket page says every blocker is done', Object.keys(repo217('hold').q.tickets).filter((k) => /Every blocker is done/.test(Q.ticketScreen(repo217('hold'), k, { now: FIXED }))).join(), '');
t('DS-217 the 2026-10-24 desk-skills queue', ['DS-168', 'DS-175', 'DS-180'].map((k) => cells217('skills24', k)).join(' / '),
  '◆ needs you | held by 27 Jira tickets outside: start anyway? / · waiting | behind #175, which needs you / · waiting | behind DS-175');
t('DS-217 AC10 (DS-279 AC15) one key line under the table names each state shown, with its meaning', queue217('hold').filter((l) => l.startsWith('key ')).join('\n'),
  'key   ● running: holds a worker │ · waiting: moves by itself │ ◆ needs you: nothing moves until you act');
const key80 = lines(Q.repoScreen(repo217('hold'), { now: FIXED, width: 80 }));
const k80i = key80.findIndex((l) => l.startsWith('key '));
t('DS-217 AC10 at 80 columns the key line breaks between states, never past the width',
  `${k80i > 0} ${key80.slice(k80i).filter((l) => l.length > 80).length} ${key80[k80i + 1]?.startsWith('      ')}`, 'true 0 true');
// AC10 and AC11 on the screen: each state in its colour, its meaning grey; every colour in the rows and
// the key line at least 4.5:1 on the window and on the selected row, in the One Dark palette the
// approved design measured, docs/design/DS-227/index.html (256-colour greys are fixed: 8 + 10 * (n - 232)).
const Hk = screen({ kind: 'repo', slug: 'acme__hold' }, 220, () => FIXED);
Hk.output.rows = 80; Hk.output.resize();
await sleep(20);
const hkFrame = lastFrame(Hk);
Hk.ui.finish(0);
const hkKey = hkFrame.find((l) => l.replace(ANSI, '').startsWith('key ')) ?? '';
t('DS-217 AC10 the key line: each state in its colour, its meaning grey',
  ['\x1b[38;5;247mkey \x1b[39m', '\x1b[38;5;180m· waiting\x1b[39m\x1b[38;5;247m: moves by itself\x1b[39m',
    '\x1b[38;5;176m◆ needs you\x1b[39m\x1b[38;5;247m: nothing moves until you act\x1b[39m'].filter((s) => !hkKey.includes(s)).join(' | '), '');
// The default text, plain and bold; every other colour is a 256-colour or 24-bit code, read as drawn.
const ONE_DARK = { 1: '#e6e9ef', 39: '#abb2bf' };
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const grey256 = xterm256;
const lum = (c) => c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const fgOf = (code) => rgbOfSgr(code) ?? (ONE_DARK[code] ? rgb(ONE_DARK[code]) : null);
const hkStart = hkFrame.findIndex((l) => /^\s+# {2}TICKET/.test(l.replace(ANSI, '')));
const hkLines = hkFrame.slice(hkStart, hkFrame.indexOf(hkKey) + 1);
const selBg = grey256(Number(/\x1b\[48;5;(\d+)m/.exec(hkLines.join(''))?.[1]));
const codes = new Set(['39', ...hkLines.flatMap((l) => [...l.matchAll(/\x1b\[([0-9;]+)m/g)].map((m) => m[1])).filter((c) => !['22', '39', '49', '27'].includes(c) && !c.startsWith('48;'))]);
const window217 = rgb('#282c34');
t('DS-217 AC11 every text colour in the rows and key line is at least 4.5:1 on the window and the selected row',
  `${selBg != null && codes.has('38;5;247')} ${[...codes].filter((c) => { const f = fgOf(c); return !f || contrast(f, window217) < 4.5 || contrast(f, selBg) < 4.5; }).join()}`, 'true ');

// ---- Who runs each batch, in LAST PASS and the repo header, and the band and notes that warn
// when that disagrees with the repo's "Batches run by" row or the supervisor has stopped. On macOS,
// with the fake launchctl loading sup's and halt's agents only.
const run215 = { state: 'running', stage: '4/9' }, parked215 = { state: 'parked', park: { question: 'which copy?' } };
const put215 = (name, port, beat, runBy, supervised, tickets) => put(I.T, I.env, name, { port, conc: '2 / 3', beat, runBy,
  queue: { batch: name, concurrency: 2, ...(supervised ? { supervised: true } : {}), tickets } });
put215('sup', 5200, 2, 'supervisor', true, { 'SU-1': run215, 'SU-2': ready });
put215('sess', 5210, 1, 'session', false, { 'SE-1': ready, 'SE-2': parked215 });
put215('over', 5220, 3, 'supervisor', false, { 'OV-1': ready });
put215('off', 5230, 3, 'supervisor', true, { 'OF-1': ready });
put215('halt', 5240, 40, 'supervisor', true, { 'HA-1': ready, 'HA-2': parked215 });
put215('gone', 5250, 30, 'supervisor', false, { 'GO-1': ready, 'GO-2': parked215 });
I.loaded('sup', 'halt');
writeFileSync(join(I.env.HOME, '.desk-autopilot', 'acme__halt', 'supervisor.log'), 'tick: pass ran\nlast tick: skipped, a pass still holds the orchestrator lock\n\n');
const at215 = (name) => Q.loadRepos(NOW).find((r) => r.name === name);
const ov215 = Q.overview(Q.loadRepos(NOW), { now: NOW, avail: 30 });
const notes215 = lines(ov215).filter((l) => /^(note| {4}) {2}\S/.test(l));
const S215 = screen({ kind: 'overview', all: true }, 240, () => NOW);
S215.output.rows = 120; S215.output.resize();
await sleep(20);
const cell215 = (name) => coloured(ovRow(S215, name))[0] ?? '';
t('DS-215 AC1 a handed-over batch with its agent loaded, on time: ● supervisor in green', `${cell215('sup')} ${/^ {2}sup +● supervisor · 2m ago {2}/.test(rowOf(ov215, 'sup') ?? '')}`, '38;5;108:● supervisor · 2m ago true');
t('DS-215 AC2 a session-run batch set to session or unset: ● session in green, and no note names it',
  `${cell215('sess')} ${notes215.some((l) => /▲ sess\b/.test(l))}`, '38;5;108:● session · 1m ago false');
t('DS-215 AC3 a session-run batch set to the supervisor: ▲ session in amber, and one amber note', `${cell215('over')} ${notes215.filter((l) => l.includes('▲ over')).join('|')}`,
  `38;5;180:▲ session · 3m ago ${notes215.find((l) => l.includes('▲ over'))?.startsWith('note') ? 'note' : '    '}  ▲ over          set to the supervisor, but a session runs this batch. Its next batch hands over.`);
const bandAt = lines(ov215).indexOf(' ✕ off: the supervisor is off, so no passes run. Run: desk-q off supervisor on');
const needsAt = lines(ov215).findIndex((l) => l.startsWith('◆ '));
t('DS-215 AC4 a handed-over batch whose agent is not loaded: ✕ supervisor off in red at once, and the red band above the header names the fix',
  `${cell215('off')} ${bandAt >= 0 && bandAt < needsAt} ${lastFrame(S215).some((l) => l.includes('\x1b[1;7;38;5;210m ✕ off: the supervisor is off, so no passes run. Run: desk-q off supervisor on\x1b[22;27;39m'))}`, '38;5;210:✕ supervisor off · 3m true true');
t('DS-215 AC15 home keeps the tab line under the breadcrumb, the Queue in reverse video, and the red band follows it after a blank line',
  `${S215.frame()[1].startsWith('1 Queue  2 Timeline  3 By day  4 Epics')} ${S215.tabOn()} ${S215.frame()[2] === '' && S215.frame()[3].startsWith(' ✕ ')}`, 'true 1 Queue true');
// DS-215 AC16-19: home fits the terminal. mixed has one ready ticket with no free slot.
const fit215 = (width) => lines(Q.overview(Q.loadRepos(NOW).filter((r) => ['hold', 'hue', 'mixed'].includes(r.name)), { now: NOW, avail: 30, width }));
const cols215 = (ls) => ls.find((l) => l.startsWith('  REPO ')).trim().split(/ {2,}/).join('|');
const wider = (ls, w) => ls.filter((l) => [...l].length > w).length;
const f104 = fit215(104), f120 = fit215(120), f160 = fit215(160);
t('DS-215 AC16 (DS-279 AC14) at 104 columns home drops DONE, no line is wider, and the no-free-slot count moves into the notes',
  `${cols215(f104)} ${wider(f104, 104)} | ${f104.some((l) => /^(note| {4}) {4}mixed +1 ready with no free slot: it starts as its running workers finish\.$/.test(l))}`,
  'REPO|LAST PASS|RUN|READY|MERGING|WAIT|NEEDS YOU|ALL DONE BY|WORKERS 0 | true');
t('DS-215 AC16 (DS-279 AC14) at 120 columns the done column comes back, no line wider; at 160 the row says it has a ready ticket with no free slot',
  `${cols215(f120)} ${wider(f120, 120)} | ${f160.find((l) => l.startsWith('  mixed '))?.endsWith('2 (cap 3) · 1 ready with no free slot')}`,
  'REPO|LAST PASS|RUN|READY|MERGING|WAIT|NEEDS YOU|DONE|ALL DONE BY|WORKERS 0 | true');
const setup104 = f104.findIndex((l) => /^(note| {4}) {4}setup /.test(l));
t('DS-215 AC17 a note wider than the terminal wraps between words, the rest indented under its text',
  `${setup104 >= 0} ${/^ {21}\S/.test(f104[setup104 + 1] ?? '')} ${wider(f104, 104)}`, 'true true 0');
const S104 = screen({ kind: 'overview', all: false }, 104, () => NOW);
S104.output.rows = 120; S104.output.resize();
await sleep(20);
const f104s = S104.frame();
t('DS-215 AC18 home\'s tab line carries no parked note; the note is in home\'s notes',
  `${f104s[1] === '1 Queue  2 Timeline  3 By day  4 Epics  5 Costs'} ${f104s.some((l) => /^(note| {4}) {4}dates +Tickets that need your answer have no date/.test(l))}`, 'true true');
const more215 = lines(Q.overview(Q.loadRepos(NOW), { now: NOW, avail: 30 }));
const moreAt = more215.findIndex((l) => /^ {2}\d+ more set up with no batch: /.test(l));
const more104 = lines(Q.overview(Q.loadRepos(NOW), { now: NOW, avail: 30, width: 60 }));
const more104At = more104.findIndex((l) => /^ {2}\d+ more set up with no batch: /.test(l));
t('DS-215 AC19 "N more set up with no batch" is indented 2 with a blank line above it, and wraps at the width, indented the same',
  `${moreAt > 0} ${more215[moreAt - 1]}| ${wider(more104.slice(more104At, more104At + 2), 60)} ${/^ {2}\S/.test(more104[more104At + 1] ?? '')}`, 'true | 0 true');
const halt215 = lines(Q.repoScreen(at215('halt'), { now: NOW }));
t('DS-215 AC5 a loaded supervisor whose passes stopped: the header reads ■ stopped, then its last log line',
  `${/^■ stopped · 40m {2}last pass \d\d:\d\d │ /.test(halt215[2])} ${halt215.includes("Supervisor's last log line: last tick: skipped, a pass still holds the orchestrator lock")}`, 'true true');
t('DS-215 AC6 a stopped session-run batch set to the supervisor: the resume hint says it hands over at Stage 4, on home and its own screen',
  `${notes215.some((l) => l.endsWith('▲ gone          passes stopped. To resume: run /desk-autopilot in gone; it hands the batch to the supervisor at Stage 4.'))} ${lines(Q.repoScreen(at215('gone'), { now: NOW })).includes('To resume: run /desk-autopilot in gone; it hands the batch to the supervisor at Stage 4.')}`, 'true true');
const youOf = (s) => Number(/^◆ (\d+) tickets? needs? you/m.exec(s)?.[1] ?? 0);
const withoutSkill = notes215.some((l) => l.includes('/desk-needs-you'));
mkdirSync(join(I.env.DESK_SKILLS_DIR, 'desk-needs-you'), { recursive: true });
writeFileSync(join(I.env.DESK_SKILLS_DIR, 'desk-needs-you', 'SKILL.md'), '# desk-needs-you\n');
const ov215y = Q.overview(Q.loadRepos(NOW), { now: NOW, avail: 30 });
t('DS-215 AC7 with the desk-needs-you skill installed, one note says /desk-needs-you asks about all of them, with the count',
  `${withoutSkill} ${lines(ov215y).filter((l) => / {2}◆ needs you +\/desk-needs-you, in a Claude session, asks you about all (\d+)\.$/.exec(l)?.[1] === String(youOf(ov215y))).length} ${youOf(ov215y) > 1}`, 'false 1 true');
const Sy = screen({ kind: 'overview', all: false }, 240, () => NOW);
Sy.output.rows = 120; Sy.output.resize();
await sleep(20);
t('DS-215 AC7 the note is magenta, its command bold', lastFrame(Sy).some((l) => l.includes('\x1b[38;5;176m◆ needs you    ') && l.includes('\x1b[1m/desk-needs-you\x1b[22m')), true);
Sy.ui.finish(0);
const unsetNote = '4 repos have no "Batches run by" setting, so they run in a session. /desk-setup sets it.';
t('DS-215 AC8 4 repos with a batch and no row: one grey note on home, none on a repo screen',
  `${lines(ov.out).filter((l) => l.endsWith(`  setup         ${unsetNote}`)).length} ${W.run('--plain', 'voicepa').out.includes('Batches run by')}`, '1 false');
process.env.DESK_PLATFORM = 'linux';
const ov215l = Q.overview(Q.loadRepos(NOW), { now: NOW, avail: 30 });
const halt215l = Q.repoScreen(at215('halt'), { now: NOW });
process.env.DESK_PLATFORM = 'darwin';
t('DS-215 AC9 not macOS: every repo reads session, with no supervisor state, band or note',
  `${/^ {2}sup +● session · 2m ago /.test(rowOf(ov215l, 'sup') ?? '')} ${/^ {2}off +● session · 3m ago /.test(rowOf(ov215l, 'off') ?? '')} ${/supervisor|Batches run by/.test(ov215l)} ${/✕/.test(ov215l)}`, 'true true false false');
t('DS-215 AC9 and a repo screen offers no supervisor fix', /Supervisor's last log line|supervisor on/.test(halt215l), false);
const plain215 = I.run('--plain').out;
t('DS-215 AC10 --plain: the same words and glyphs, no colour, the band and notes as plain lines',
  `${plain215.includes('\x1b')} ${lines(plain215).includes(' ✕ off: the supervisor is off, so no passes run. Run: desk-q off supervisor on')} ${lines(plain215).some((l) => /^(note| {4}) {2}▲ over {10}set to the supervisor/.test(l))} ${/ ✕ supervisor off · \d+m /.test(rowOf(plain215, 'off') ?? '')}`, 'false true true true');
t('DS-215 AC11 a repo screen\'s second header line: who runs it, the last pass, workers and cap, the batch',
  [lines(Q.repoScreen(at215('sup'), { now: NOW }))[2], lines(Q.repoScreen(at215('sess'), { now: NOW }))[2]].join(' | '),
  '● supervisor  last pass 2m ago │ workers 1 of 2 · cap 3 │ batch sup | ● session  last pass 1m ago │ workers 0 of 2 · cap 3 │ batch sess');
const Rs = screen({ kind: 'repo', slug: 'acme__sup' }, 160, () => NOW);
await sleep(20);
const rsHead = lastFrame(Rs).find((l) => l.replace(ANSI, '').startsWith('● supervisor')) ?? '';
t('DS-215 AC11 its label is grey, its figures bright and its segments split by a grey │',
  [`\x1b[38;5;108m● supervisor\x1b[39m  ${G}last pass \x1b[39m2m ago`, `${G} │ \x1b[39m${G}workers \x1b[39m\x1b[1m1 of 2\x1b[22m${G} · cap \x1b[39m\x1b[1m3\x1b[22m`].filter((s) => !rsHead.includes(s)).join(' | '), '');
const s215 = lastFrame(S215);
t('DS-215 AC12 home: the band, then the needs-you count with each repo\'s, then workers, machine cap, room and free memory',
  `${needsAt === lines(ov215).filter((l) => l.startsWith(' ✕ ')).length} ${/^◆ \d+ tickets need you │ \S+ \d+( · \S+ \d+)*( │ ◌ \d+ blocked)?$/.test(lines(ov215)[needsAt])} ${/^● \d+ workers? running │ machine cap 10 · room for \d+ more │ 30\.0 GiB free$/.test(lines(ov215)[needsAt + 1])}`, 'true true true');
t('DS-215 AC12 labels grey, values bright, segments split by a grey │',
  `${s215.some((l) => l.startsWith('\x1b[1;38;5;176m◆ ') && /\x1b\[38;5;247m │ \x1b\[39m\x1b\[38;5;247m\S+ \x1b\[39m\x1b\[1m\d+\x1b\[22m/.test(l))} ${s215.some((l) => l.includes(`${G}machine cap \x1b[39m\x1b[1m10\x1b[22m${G} · \x1b[39m${G}room for \x1b[39m\x1b[1m`) && /\x1b\[1m\d+\.\d GiB\x1b\[22m\x1b\[38;5;247m free\x1b\[39m$/.test(l))}`, 'true true');
S215.ui.finish(0);
Rs.ui.finish(0);
// AC13: no label is drawn dim, and every text colour the home and repo screens draw is 4.5:1 or more
// on the One Dark window, the selected row and black. The band's text is the window's colour on red.
const sgrOf = (bufs) => new Set(bufs.flatMap((b) => [...b.matchAll(/\x1b\[([0-9;]+)m/g)].map((m) => m[1])));
const RESETS = ['0', '22', '23', '24', '27', '39', '49', '22;39', '22;27;39'];
// The foreground each code draws text in, bold alone in the default colour; reverse video and
// backgrounds are not text colours.
const textCodes = (codes) => [...codes].filter((c) => !RESETS.includes(c) && !c.startsWith('48;') && c !== '7' && !c.startsWith('1;7;'));
const textFg = (c) => fgOf(c === '1' ? '39' : c.replace(/^1;/, ''));
const drawn215 = sgrOf([S215, Rs, Sy].map((s) => s.output.buf));
const sel215 = grey256(Number([...drawn215].find((c) => c.startsWith('48;5;'))?.split(';')[2]));
const bands215 = [...drawn215].filter((c) => c.startsWith('1;7;'));
t('DS-215 AC13 no screen draws dim (SGR 2)', [S215, Rs, Sy].some((s) => s.output.buf.includes('\x1b[2m')), false);
t('DS-215 AC13 every text colour drawn is 4.5:1 or more on the window, the selected row and black, the band\'s text on red too',
  `${sel215 != null} ${drawn215.has('38;5;247')} ${textCodes(drawn215).filter((c) => { const f = textFg(c); return !f || [window217, sel215, [0, 0, 0]].some((b) => contrast(f, b) < 4.5); }).join()}|${bands215.join()} ${bands215.every((c) => contrast(window217, fgOf(c.slice(4))) >= 4.5)}`,
  'true true |1;7;38;5;210 true');
process.env.COLORFGBG = '0;15';
const QL = await import(`${pathToFileURL(BIN).href}?light`);
delete process.env.COLORFGBG;
const white = [255, 255, 255];
const L215 = screen({ kind: 'overview', all: true }, 240, () => NOW, QL);
L215.output.rows = 120; L215.output.resize();
await sleep(20);
L215.ui.finish(0);
const drawnL = sgrOf([L215.output.buf]);
const greysL = [...drawnL].filter((c) => /^38;5;\d+$/.test(c));
const selL = grey256(Number([...drawnL].find((c) => c.startsWith('48;5;'))?.split(';')[2]));
t('DS-215 AC14 a light theme draws labels a darker grey, 4.5:1 or more on its background and its selected row',
  `${greysL.join()} ${selL != null && greysL.every((c) => contrast(fgOf(c), white) >= 4.5 && contrast(fgOf(c), selL) >= 4.5)} ${QL.lightTheme('15;0')} ${QL.lightTheme(undefined)}`,
  '38;5;240 true false false');
// DS-277: a truecolor terminal draws each state in One Dark's 24-bit colour (AC1), each 4.5:1 or more on
// the window, the selected row and black, the band's text on red too (AC3). NO_COLOR still drops every
// colour (AC4), and a light theme keeps the terminal's 16 (AC5).
const ONE_DARK_24 = ['38;2;152;195;121', '38;2;86;182;194', '38;2;97;175;239', '38;2;229;192;123', '38;2;208;139;227', '38;2;240;124;132'];
process.env.COLORTERM = 'truecolor';
const QT = await import(`${pathToFileURL(BIN).href}?truecolor`);
delete process.env.COLORTERM;
const tc277 = [screen({ kind: 'overview', all: true }, 240, () => NOW, QT), screen({ kind: 'repo', slug: 'acme__hue' }, 220, () => FIXED, QT)];
for (const s of tc277) { s.output.rows = 120; s.output.resize(); }
await sleep(20);
tc277.forEach((s) => s.ui.finish(0));
const drawn277 = sgrOf(tc277.map((s) => s.output.buf));
const hues277 = new Set([...drawn277].map((c) => c.replace(/^(1;7;|1;|2;)/, '')).filter((c) => c.startsWith('38;2;')));
const legacy277 = [...drawn277].map((c) => c.replace(/^(1;7;|1;|2;)/, '')).filter((c) => /^3[1-6]$/.test(c) || /^38;5;(\d\d?|1\d\d|2[0-2]\d|23[01])$/.test(c));
t('DS-277 AC1 with truecolor every state is drawn in its One Dark 24-bit colour, and no 16 or 256-colour state code',
  `${[...hues277].every((c) => ONE_DARK_24.includes(c))} ${hues277.size >= 5} ${legacy277.join()}`, 'true true ');
const bands277 = [...drawn277].filter((c) => c.startsWith('1;7;'));
t('DS-277 AC3 with truecolor every text colour is 4.5:1 or more on the window, the selected row and black, the band\'s text on red too',
  `${textCodes(drawn277).filter((c) => { const f = textFg(c); return !f || [window217, sel215, [0, 0, 0]].some((b) => contrast(f, b) < 4.5); }).join()}|${bands277.join()} ${bands277.every((c) => contrast(window217, fgOf(c.slice(4))) >= 4.5)}`,
  '|1;7;38;2;240;124;132 true');
process.env.NO_COLOR = '1';
const Tn277 = screen({ kind: 'repo', slug: 'acme__hue' }, 220, () => FIXED, QT);
await sleep(20);
Tn277.ui.finish(0);
delete process.env.NO_COLOR;
t('DS-277 AC4 with truecolor and NO_COLOR, no colour codes, the selected row still in reverse video',
  `${/\x1b\[(?:1;)?(3\d|38;[25];[\d;]+|4\d|48;5;\d+)m/.test(Tn277.output.buf)} ${/\x1b\[7m›/.test(Tn277.output.buf)}`, 'false true');
t('DS-277 AC5 a light theme keeps the terminal\'s own state colours, never 24-bit or 256-colour ones',
  `${[...drawnL].some((c) => /^(1;)?3[1-6]$/.test(c))} ${[...drawnL].some((c) => c.includes('38;2;') || /^38;5;(\d\d?|1\d\d|2[0-2]\d|23[01])$/.test(c))}`, 'true false');
// AC4 holds for a handed-over batch whose open tickets all wait on the user, and once its passes have
// stopped the batch stays on home, band and all, rather than dropping off with the quiet ones.
put215('stall', 5260, 50, 'supervisor', true, { 'ST-1': parked215 });
put215('idle', 5270, 50, 'supervisor', true, { 'ID-1': ready });
const ovStall = Q.overview(Q.loadRepos(NOW).filter((r) => ['stall', 'idle'].includes(r.name)), { now: NOW, avail: 30 });
const band = (name) => ` ✕ ${name}: the supervisor is off, so no passes run. Run: desk-q ${name} supervisor on`;
t('DS-215 AC4 a stopped handed-over batch with only tickets that need you: still ✕ supervisor off, with its band',
  `${/^ {2}stall +✕ supervisor off · 50m /.test(rowOf(ovStall, 'stall') ?? '')} ${lines(ovStall).includes(band('stall'))}`, 'true true');
t('DS-215 AC4 a stopped handed-over batch with nothing for the user stays on home while its supervisor is off',
  `${/^ {2}idle +✕ supervisor off · 50m /.test(rowOf(ovStall, 'idle') ?? '')} ${lines(ovStall).includes(band('idle'))}`, 'true true');
put215('ask', 5280, 50, 'supervisor', false, { 'AS-1': parked215 });
t('DS-215 AC6 a stopped session-run batch set to the supervisor whose only ticket needs you still gets the hand-over hint on home',
  /▲ ask +passes stopped\. To resume: run \/desk-autopilot in ask; it hands the batch to the supervisor at Stage 4\.$/m.test(Q.overview(Q.loadRepos(NOW).filter((r) => r.name === 'ask'), { now: NOW, avail: 30 })), true);
put215('closed', 5290, 50, 'supervisor', false, { 'CL-1': ready });
const ovClosed = Q.overview(Q.loadRepos(NOW).filter((r) => r.name === 'closed'), { now: NOW, avail: 30 });
t('DS-215 AC6 a stopped session-run batch set to the supervisor with only ready tickets stays on home, with the hand-over hint',
  `${/^ {2}closed +■ stopped · 50m /.test(rowOf(ovClosed, 'closed') ?? '')} ${/▲ closed +passes stopped\. To resume: run \/desk-autopilot in closed; it hands the batch to the supervisor at Stage 4\.$/m.test(ovClosed)}`, 'true true');
t('DS-215 AC7 with one ticket that needs you, the note still gives the count',
  lines(ovStall).some((l) => / {2}◆ needs you +\/desk-needs-you, in a Claude session, asks you about the 1 ticket\.$/.test(l)), true);

// ---- DS-218: the ticket screen leads with whether it moves without you; the tabs match the Queue.
// The 2026-10-24 desk-skills queue: DS-168 behind three merged blockers, DS-150's draft PR and 27 open
// Jira blockers outside the batch; DS-175 behind the draft; DS-180 behind DS-175. Merging is ask.
const LONG218 = 'the README describes features that are not on main yet: should the rewrite wait until every backlog feature has shipped, or go ahead now and be revised as each one lands, and if so, who signs off the wording?';
dated('s218', 5050, { hours: twelveHours, perms: { 'autopilot-merge': 'ask', 'pr-merge-green': 'ask' }, tickets: {
  'DS-150': prAt(175, { isDraft: true }), 'DS-101': mergedAt(161), 'DS-102': mergedAt(162), 'DS-103': mergedAt(163),
  'DS-168': { ...heldBy('DS-101|DS-102|DS-103|DS-150'), open_questions: 1, outside_blockers: outside(27) },
  'DS-175': heldBy('DS-101|DS-150'), 'DS-180': heldBy('DS-175'), 'DS-190': { state: 'parked', park: { question: LONG218 } },
  'DS-195': { ...ready, out_of_scope: ['README.md', 'docs/guide.md'] } } });
const REASON218 = 'No product or design decision is left open; the work is mechanical: shorten README.md, move the detail into docs/, and check every link. '.repeat(4);
writeFileSync(join(I.env.HOME, '.desk-autopilot', 'acme__s218', 'triage', 'DS-168.json'), JSON.stringify({ ticket: 'DS-168', epic: null, type: 'Task', size: 'M', lane: 'A',
  summary: 'README: rewrite it as the guide to desk, once every backlog feature has shipped', lane_reason: REASON218,
  files_in_scope: ['README.md', ...Array.from({ length: 8 }, (_, i) => `docs/part-${i + 1}.md`)],
  lint: [{ severity: 'blocking', rule: 'dependency', message: 'names DS-127 with no Blocks link' }, { severity: 'advisory', rule: 'design', message: 'no saved design copy' }],
  unknowns: ['Should the rewrite wait until the backlog has shipped?'] }));
const r218 = () => Q.loadRepos(FIXED).find((r) => r.name === 's218');
const page218 = (key, opts = {}) => Q.ticketScreen(r218(), key, { now: FIXED, width: 120, ...opts });
const at218 = (key, prefix) => lines(page218(key)).find((l) => l.startsWith(prefix)) ?? '';
// A ticket's screen, tall enough to show all of it.
async function ticket218(key, columns = 160) {
  const s = screen({ kind: 'ticket', slug: 'acme__s218', key }, columns, () => FIXED);
  s.output.rows = 120; s.output.resize();
  await sleep(20);
  return s;
}
t('DS-218 AC1 the first line under the title, on the rail, says whether it moves without you and what would move it',
  ['DS-168', 'DS-175', 'DS-180'].map((k) => `${lines(page218(k))[3].startsWith('▌ ')} ${railText(page218(k))}`).join(' / '),
  'true Will not start on its own. 27 Jira tickets outside this batch must be done first, and nothing in this batch moves it. If it can start without them, say so, in s218:'
  + ' / true Moves without you: behind #175, which needs you. / true Moves without you: behind DS-175.');
const S175 = await ticket218('DS-175'), S168 = await ticket218('DS-168'), S180 = await ticket218('DS-180');
t('DS-218 AC1 (DS-279 AC6, DS-280 AC9) the rail is in the state\'s colour: held outside the batch needs you, magenta; waiting amber, behind a draft that needs you too',
  [lastFrame(S175).some((l) => l.startsWith('\x1b[38;5;180m▌ \x1b[39m')), lastFrame(S168).some((l) => l.startsWith('\x1b[38;5;176m▌ \x1b[39m')), lastFrame(S180).some((l) => l.startsWith('\x1b[38;5;180m▌ \x1b[39m'))].join(), 'true,true,true');
const p168 = lines(page218('DS-168'));
t('DS-218 AC2 the blockers: merged as one green count, the one needing you with its action, those outside with their Jira status',
  ['Blockers  31 · 4 in this batch, 27 open outside it', '  ✓ 3 in this batch merged', '  ◆ DS-150    #175: draft · undraft it once it is reviewed', '  ◌ OUT-1     To Do'].filter((s) => !p168.includes(s)).join(' | '), '');
dated('s391', 5391, { hours: twelveHours, tickets: { 'DS-150': prAt(175, { isDraft: true }),
  'DS-391': { ...heldBy('DS-150|OUT-1|OUT-2'), held_outside: 'OUT-1|OUT-2', outside_blockers: [{ key: 'OUT-1', category: 'new' }] } } });
writeFileSync(join(I.env.HOME, '.desk-autopilot', 'acme__s391', 'triage', 'DS-391.json'), JSON.stringify({ ticket: 'DS-391', summary: 'held outside', size: 'M',
  blockers: [{ key: 'DS-150', category: 'indeterminate' }, { key: 'OUT-1', category: 'new' }, { key: 'OUT-2', category: 'done' }] }));
const p391 = lines(Q.ticketScreen(Q.loadRepos(FIXED).find((r) => r.name === 's391'), 'DS-391', { now: FIXED, width: 120 }));
t('DS-391 AC1 a blocker the ticket is held behind outside the batch is listed once, outside, with its Jira status, and never as one to let start',
  `${['Blockers  3 · 1 in this batch, 2 open outside it', '  ◌ OUT-1     To Do', '  ◌ OUT-2     Done, not yet on main'].filter((s) => !p391.includes(s)).join(' | ')}|${p391.filter((l) => /^ {2}\S OUT-\d/.test(l)).length}|${p391.some((l) => l.includes('not in this queue'))}`, '|2|false');
const f168 = lastFrame(S168);
t('DS-218 AC2 on screen: the count green, the one needing you magenta with the action bold, the outside ones grey',
  [f168.some((l) => l.includes('\x1b[38;5;108m  ✓ 3\x1b[39m')), f168.some((l) => l.includes('◆ DS-150    \x1b[22;39m#175: \x1b[1mdraft · undraft it once it is reviewed\x1b[22m')), f168.some((l) => l.startsWith(`${G}  ◌ OUT-1     To Do\x1b[39m`))].join(), 'true,true,true');
const outsideShown = (s) => s.frame().filter((l) => /^ {2}◌ OUT-\d+ /.test(l)).length;
const before3 = [outsideShown(S168), S168.frame().includes('    … 22 more outside this batch  · a shows all'), S168.frame().some((l) => /✓ DS-101 /.test(l)), keysLine(S168).includes('a blockers')];
await S168.press('a');
t('DS-218 AC3 more blockers than fit: a short list and how many more; a lists every one, merged ones too',
  `${before3.join()} | ${[outsideShown(S168), S168.frame().some((l) => l.includes('more outside this batch')), S168.frame().filter((l) => /✓ DS-10\d /.test(l)).length].join()}`, '5,true,false,true | 27,false,3');
await S168.press('a');
t('DS-218 AC4 a Warnings block shows each flag triage or the pass raised, an advisory one left out',
  ['Warnings', "  ▲ Triage's ticket check: names DS-127 with no Blocks link", '  ▲ Open from triage: Should the rewrite wait until the backlog has shipped?'].filter((s) => !p168.includes(s)).join(' | ')
  + ` ${p168.some((l) => l.includes('no saved design copy'))} ${at218('DS-195', '  ▲ ')}`, ' false   ▲ Its branch changes 2 files outside its triaged scope: README.md, docs/guide.md.');
t('DS-218 AC4 each flag is amber', f168.some((l) => l.startsWith('\x1b[38;5;180m  ▲ \x1b[39m')), true);
t('DS-218 AC5 a held ticket: Starts says what it waits for, and Ships says no date',
  ['DS-168', 'DS-175', 'DS-180'].map((k) => `${at218(k, 'Starts')} | ${at218(k, 'Ships')}`).join(' / '),
  'Starts    not until its outside blockers are done | Ships     no date / Starts    once #175 merges and you let it start | Ships     no date / Starts    after DS-175 merges | Ships     no date');
t('DS-218 AC5 behind a PR that needs you, where a supervisor releases holds: Starts at the next pass after it merges',
  lines(Q.ticketScreen(repo217('holdsup'), 'W-2H', { now: FIXED, width: 120 })).find((l) => l.startsWith('Starts')) ?? '', 'Starts    at the next pass after #180 merges');
// Behind a PR whose status no pass has read yet, with too little history to date it and nothing to release it.
dated('s218u', 5060, { hours: [4], tickets: { 'U-1': { state: 'done', result: { pr: 181 } }, 'U-2': heldBy('U-1') } });
t('DS-218 AC5 behind an unread PR, where nothing releases holds: Starts does not promise the next pass',
  lines(Q.ticketScreen(Q.loadRepos(FIXED).find((r) => r.name === 's218u'), 'U-2', { now: FIXED, width: 120 })).find((l) => l.startsWith('Starts')) ?? '',
  'Starts    once the next pass reads its PRs merged and you let it start');
t('DS-218 AC6 a ticket others wait on lists them with their states', `${at218('DS-150', 'Holding up')} | ${at218('DS-175', 'Holding up')}`,
  'Holding up  ◆ DS-168 (needs you), · DS-175 (waiting) wait on this ticket | Holding up  · DS-180 (waiting) waits on this ticket');
const why168 = (s) => { const f = s.frame(), i = f.indexOf('Why lane A'); return f.slice(i + 1, f.indexOf('', i)); };
const files168 = (s) => { const f = s.frame(), i = f.indexOf('Files in scope · 9'); return f.slice(i + 1, f.indexOf('', i)); };
const folded7 = [why168(S168).length, /… \d+ more lines · y shows all$/.test(why168(S168).at(-1)), files168(S168).length, files168(S168).at(-1).endsWith('  … 7 more · f shows all')];
await S168.press('y'); await S168.press('f');
t('DS-218 AC7 Why lane and the file list show two lines each, and y and f show them in full',
  `${folded7.join()} | ${why168(S168).length > 2} ${why168(S168).join(' ').replace(/\s+/g, ' ').trim() === REASON218.trim()} ${files168(S168).length}`, '2,true,2,true | true true 9');
t('DS-218 AC7 plain output shows them in full', `${p168.filter((l) => l.startsWith('  docs/part-')).length} ${p168.some((l) => l.includes('shows all'))}`, '8 false');
[S175, S168, S180].forEach((s) => s.ui.finish(0));
// AC8: each tab's header is the Queue's two lines, and its legend one key line.
const T218 = screen({ kind: 'repo', slug: 'acme__s218' }, 200, () => FIXED);
T218.output.rows = 80; T218.output.resize();
await sleep(20);
const headOf = (f) => f.filter((l) => /^(◆ |● session|■ )/.test(l)).join(' | ');
const queueHead = headOf(T218.frame());
const tabs218 = [];
for (const k of ['2', '3', '4']) { await T218.press(k); tabs218.push({ head: headOf(T218.frame()), keys: T218.frame().filter((l) => l.startsWith('key ')).length, f: T218.frame(), raw: lastFrame(T218) }); }
T218.ui.finish(0);
t('DS-218 AC8 Timeline, By day and Epics each have the Queue\'s header: state counts, who runs the batch, the batch',
  `${/^◆ 3 tickets need you .* \| ● session {2}last pass .* │ batch s218$/.test(queueHead)} ${tabs218.map((x) => x.head === queueHead).join()}`, 'true true,true,true');
t('DS-218 AC8 the Timeline and By day legends are one key line each, the Timeline\'s with its note under it',
  `${tabs218[0].keys} ${tabs218[1].keys} ${tabs218[0].f[tabs218[0].f.findIndex((l) => l.startsWith('key ')) + 1]}`, '1 1       within a week: day and time; beyond a week, the date');
t('DS-218 AC9 a Timeline bar on screen: the likely span solid in the state\'s colour, the could-run-to part a dimmer shade of it, no ░',
  `${tabs218[0].raw.some((l) => /\x1b\[(38;5;\d+)m█+\x1b\[39m\x1b\[2;\1m█+\x1b\[22;39m/.test(l))} ${tabs218[0].f.some((l) => /^[ ›] +DS-\d+ .*░/.test(l))}`, 'true false');
// AC11: every text colour on these screens is 4.5:1 or more on the window and the selected row; a bar's
// dimmed part is a graphic, not text. Every coloured line on a ticket's page leads with a glyph.
const drawn218 = sgrOf([S175, S168, S180, T218].map((s) => s.output.buf));
const sel218 = grey256(Number([...drawn218].find((c) => c.startsWith('48;5;'))?.split(';')[2]));
t('DS-218 AC11 every text colour drawn is 4.5:1 or more on the window and the selected row',
  `${sel218 != null} ${textCodes(drawn218).filter((c) => !/^2(;|$)/.test(c)).filter((c) => { const f = textFg(c); return !f || [window217, sel218].some((b) => contrast(f, b) < 4.5); }).join()}`, 'true ');
const glyphLines = (page) => lines(page).filter((l) => /^(▌| {2}[✓◆◌▲●○◐✕·])/.test(l)).length;
t('DS-218 AC11 under --plain, the rail, blockers and warnings each start with a glyph',
  `${glyphLines(I.run('--plain', 's218', 'show', 'DS-168').out) >= 3 + 1 + 1 + 27 + 2} ${I.run('--plain', 's218', 'show', 'DS-168').out.includes('\x1b')}`, 'true false');
// AC12: a parked question wraps in full under the title at any width; its answer command sits alone on
// its own line, and wider than the window it runs on rather than being cut.
const CMD218 = 'node ~/.claude/desk/bin/answer.mjs DS-190 "…"';
const ac12 = [];
for (const w of [40, 80, 160]) {
  const s = await ticket218('DS-190', w);
  const f = s.frame(), title = f.findIndex((l) => l.startsWith('DS-190 title')), rail = f.filter((l) => l.startsWith('▌ '));
  ac12.push(`${f[title + 2]?.startsWith('▌ Needs your answer: the README')} ${rail.every((l) => l.length <= w)} ${rail.map((l) => l.slice(2)).join(' ').startsWith(`Needs your answer: ${LONG218} Answer, in s218`)} ${f.includes(CMD218)}`);
  s.ui.finish(0);
}
t('DS-218 AC12 at 40, 80 and 160 columns the question wraps in full under the title, and the answer command is whole on its own line', ac12.join(' / '),
  'true true true true / true true true true / true true true true');

// ---- DS-219: a batch that has stopped moving, from the pass record, the supervisor's files and launchd.
const put219 = (name, port, { supervised = true, beat = 1, pass = null, tickets }) => put(I.T, I.env, name, { port, conc: '2 / 3', beat, runBy: supervised ? 'supervisor' : 'session',
  queue: { batch: name, concurrency: 2, ...(supervised ? { supervised: true } : {}), ...(pass ? { pass } : {}), tickets } });
const state219 = (name, file, text) => writeFileSync(join(I.env.HOME, '.desk-autopilot', `acme__${name}`, file), text);
const held219 = '7-day usage ahead of pace holds every spawn';
put219('np', 5300, { supervised: false, pass: { at: minsAgo(1), by: 'session', held: held219, errors: 0, progress_at: minsAgo(185) }, tickets: { 'NP-1': ready } });
put219('moved', 5310, { supervised: false, pass: { at: minsAgo(1), by: 'session', held: held219, errors: 0, progress_at: minsAgo(30) }, tickets: { 'MV-1': ready } });
put219('err', 5320, { supervised: false, pass: { at: minsAgo(1), by: 'session', errors: 2, error: 'no repo config found for acme/err' }, tickets: { 'ER-1': ready } });
put219('err1', 5330, { supervised: false, pass: { at: minsAgo(1), by: 'session', errors: 1, error: 'a one-off' }, tickets: { 'EO-1': ready } });
put219('both', 5340, { pass: { at: minsAgo(1), by: 'supervisor', session_at: minsAgo(3) }, tickets: { 'BO-1': run215 } });
put219('alone', 5350, { pass: { at: minsAgo(1), by: 'supervisor', session_at: minsAgo(40) }, tickets: { 'AL-1': run215 } });
put219('drv', 5360, { tickets: { 'DR-1': run215 } });
state219('drv', 'supervisor.json', JSON.stringify({ driver: { pid: null, started: minsAgo(20), from: 0, failures: 1, notified: false, code: 1, reason: 'FAIL: gh is signed out' } }));
state219('drv', 'merge-driver.log', 'FAIL: gh is signed out\nmerge driver exited 1\n');
put219('drv2', 5370, { tickets: { 'DT-1': run215 } });
state219('drv2', 'supervisor.json', '{}');
state219('drv2', 'supervisor.log', '== tick\nmerge driver: could not start: spawn EACCES\n');
// A crash loop: the retry the supervisor started after the first failure died too, its pid still recorded.
put219('drv3', 5420, { tickets: { 'DL-1': run215 } });
state219('drv3', 'supervisor.json', JSON.stringify({ driver: { pid: 2147483646, started: minsAgo(2), from: 0, failures: 1, notified: false, code: 1, reason: 'FAIL: no PR for DL-1' } }));
put219('old', 5380, { tickets: { 'OL-1': run215 } });
state219('old', 'supervisor.json', JSON.stringify({ code: { installed: 'new1', supervisor: { version: 'old1', old_code: true }, driver: null } }));
put219('cant', 5390, { beat: 40, tickets: { 'CA-1': ready } });
state219('cant', 'supervisor.agent.log', 'tick\nsupervisor: no repo config found for acme/cant\n');
writeFileSync(join(I.T, 'bin', 'print-com.desk-skills.supervisor.acme__cant'), '\tstate = not running\n\truns = 12\n\tlast exit code = 1\n');
put219('land', 5400, { pass: { at: minsAgo(1), by: 'supervisor', held: null, errors: 0, progress_at: minsAgo(300) }, tickets: {
  'LD-1': { state: 'done', result: { pr: 50 }, pr_status: { pr: 50, state: 'OPEN', checks: [] } }, 'LD-2': { state: 'done', result: { pr: 51 }, pr_status: { pr: 51, state: 'MERGED' } } } });
put219('wait', 5410, { supervised: false, tickets: { 'WA-1': { state: 'parked', park: { question: 'which copy?', since: minsAgo(130) } }, 'WA-2': { state: 'parked', park: { question: 'which price?', since: minsAgo(20) } } } });
I.loaded('sup', 'halt', 'both', 'alone', 'drv', 'drv2', 'drv3', 'old', 'cant', 'land');
const names219 = ['np', 'moved', 'err', 'err1', 'both', 'alone', 'drv', 'drv2', 'drv3', 'old', 'cant', 'land', 'wait'];
const ov219 = Q.overview(Q.loadRepos(NOW).filter((r) => names219.includes(r.name)), { now: NOW, avail: 30 });
const notesOf = (name) => lines(ov219).filter((l) => new RegExp(`^(note| {4}) {2}▲ ${name} +`).test(l)).map((l) => l.replace(new RegExp(`^(note| {4}) {2}▲ ${name} +`), ''));
const cell219 = (name) => (rowOf(ov219, name) ?? '').slice(2).replace(/^\S+ +/, '').split(/ {2,}/)[0];
const needs219 = lines(ov219).findIndex((l) => l.startsWith('◆ '));
const bandAt219 = (text) => lines(ov219).indexOf(` ✕ ${text}`);
t('DS-219 AC1 passes that held everything for an hour: ▲ no progress, and one note naming what held them',
  `${cell219('np')} | ${notesOf('np').join(' / ')} | ${cell219('moved')} ${notesOf('moved').length}`,
  `▲ no progress 3h 5m | nothing started or merged for 3h 5m. Last pass: ${held219}. | ● session · 1m ago 0`);
t('DS-219 AC2 two errored passes in a row: the red band above the header names the repo and the error\'s first line; one does not',
  `${bandAt219('err: the last 2 passes errored: no repo config found for acme/err')} ${needs219} ${/err1:/.test(ov219)}`, `0 ${needs219} false`);
t('DS-219 AC3 a session running passes beside the loaded supervisor: ▲ supervisor + session, and one note with both fixes',
  `${cell219('both')} | ${notesOf('both').join(' / ')} | ${cell219('alone')} ${notesOf('alone').length}`,
  '▲ supervisor + session | a session is also running this supervised batch. Close the session, or run: desk-q both supervisor off | ● supervisor · 1m ago 0');
t('DS-219 AC4 a merge driver that died, never started, or whose retry died too: one note with the reason from its log',
  `${notesOf('drv').join(' / ').replace(/\d\d:\d\d/, 'HH:MM')} | ${notesOf('drv2').join(' / ')} | ${notesOf('drv3').join(' / ')}`,
  'the merge driver stopped at HH:MM: gh is signed out. Run gh auth login. | the merge driver could not start: spawn EACCES. | the merge driver stopped: no PR for DL-1.');
t('DS-219 AC5 a supervisor on old desk code: one note to run ./install.sh in desk-skills',
  notesOf('old').join(' / '), 'the supervisor runs old desk code. Run ./install.sh in desk-skills.');
t('DS-219 AC6 a loaded agent whose last run failed: the red band names the repo and the reason from its log',
  `${bandAt219('cant: the supervisor cannot start (exit 1): supervisor: no repo config found for acme/cant') >= 0} ${bandAt219('cant: the supervisor cannot start (exit 1): supervisor: no repo config found for acme/cant') < needs219}`, 'true true');
// land's open PR needs you too: nothing there may merge it.
t('DS-219 AC7 the needs-you count is followed by how long the oldest has waited', /^◆ 3 tickets need you {2}oldest 2h 10m │ wait 2 · land 1$/.test(lines(ov219)[needs219]), true);
t('DS-219 AC8 a supervised batch with every ticket done and a PR still open: live, not stopped, its rows read by their tickets',
  `${cell219('land')} ${notesOf('land').length} ${/LD-1 +◆ needs you +#50 · no checks reported yet · merge it once green/.test(Q.repoScreen(Q.loadRepos(NOW).find((r) => r.name === 'land'), { now: NOW }))}`, '● supervisor · 1m ago 0 true');
const S219 = screen({ kind: 'overview', all: true }, 240, () => NOW);
S219.output.rows = 160; S219.output.resize();
await sleep(20);
S219.ui.finish(0);
const drawn219 = sgrOf([S219.output.buf]);
const bands219 = [...drawn219].filter((c) => c.startsWith('1;7;'));
const f219 = lastFrame(S219);
t('DS-219 AC9 the bands and notes are drawn, and every text colour is 4.5:1 or more on the window, the selected row and black, the band\'s text on red too',
  `${f219.some((l) => l.includes('\x1b[1;7;38;5;210m ✕ err: ')) && f219.some((l) => l.includes('\x1b[38;5;180m▲ np')) && f219.some((l) => l.includes('\x1b[1mRun ./install.sh in desk-skills.\x1b[22m'))} `
  + `${textCodes(drawn219).filter((c) => { const f = textFg(c); return !f || [window217, sel215, [0, 0, 0]].some((b) => contrast(f, b) < 4.5); }).join()}|${bands219.join()} ${bands219.every((c) => contrast(window217, fgOf(c.slice(4))) >= 4.5)}`,
  'true |1;7;38;5;210 true');

// ---- DS-310: a named batch beside the standing one; DS-357: home and the repo's place add them up
const W310 = world({ voicepa: null, 'pr-ninja': null, pranicuk: null, forewatt: null, 'yield-index': null, 'gygg-platform': null });
const ov310a = W310.run('--plain').out;
const named310 = (dir) => join(dir, 'acme__desk-skills', 'batches', 'X-1');
const q310 = join(named310(join(W310.env.DESK_HOME, 'repos')), 'queue.json');
const s310 = named310(join(W310.env.HOME, '.desk-autopilot'));
mkdirSync(dirname(q310), { recursive: true });
mkdirSync(join(s310, 'orchestrators'), { recursive: true });
writeFileSync(q310, JSON.stringify({ version: 1, batch: 'x1', base: 'feat/x', concurrency: 2, tickets: { 'X-2': { key: 'X-2', state: 'running', stage: '3/9' }, 'X-3': { key: 'X-3', state: 'parked', park: { question: 'which copy?' } } } }));
writeFileSync(join(s310, 'orchestrators', 'q.json'), JSON.stringify({ queue: q310, batch: 'x1', pid: 1, at: minsAgo(3) }));
const ov310 = W310.run('--plain').out;
t('DS-310 AC4 with only a standing batch, its row shows its cap as its own', /\s2 \(cap 3\)$/.test(rowOf(ov310a, 'desk-skills') ?? ''), true);
t('DS-357 AC1 AC2 one desk-skills row, named with the repo only, its counts added up, the latest pass and the workers within the cap',
  `${lines(ov310).filter((l) => /^ {2}desk-skills/.test(l)).length} ${ov310.includes('X-1')} ${/^ {2}desk-skills +● session · 1m ago +1 +1 +0 +0 +1 +0 +no date yet +3 \(cap 3\)$/.test(rowOf(ov310, 'desk-skills') ?? '')}`, '1 false true');
t('DS-357 AC4 the needs-you line names the repo once', lines(ov310)[0].endsWith('│ desk-skills 1'), true);
const x310 = W310.run('--plain', 'desk-skills:X-1');
t('DS-310 AC1 desk-q <repo>:<name> opens the named batch, and only its tickets', `${x310.code} ${/X-2/.test(x310.out)} ${/X-3/.test(x310.out)} ${/DS-1/.test(x310.out)}`, '0 true true false');
t('DS-357 AC2b the repo\'s name opens all its batches\' tickets', ['X-2', 'X-3', 'DS-1'].every((k) => new RegExp(`  ${k} `).test(W310.run('--plain', 'desk-skills').out)), true);
t('DS-310 a ticket in the named batch is shown from it', /which copy\?/.test(W310.run('--plain', 'desk-skills:X-1', 'show', 'X-3').out), true);
const over310 = W310.run('desk-skills:X-1', 'workers', '4');
t('DS-310 a named batch\'s workers past the cap counts its sibling batch in the machine total', `${over310.code !== 0} ${/live batches would then allow 6 /.test(over310.out + over310.err)}`, 'true true');

// ---- DS-279: five states named by who moves a ticket next, and a row with a failure leads with it.
// The 27 Oct voicepa board: #693 in CI, #701 green, #705's fix try running, #704's and #697's queued,
// #696 red on a check only an operator fixes, #698 red after both tries, #700 and #702 drafts.
const okCheck = (name) => ({ name, status: 'completed', conclusion: 'success', started: ago194(30), completed: ago194(20), runner: true });
const okChecks = (n) => Array.from({ length: n }, (_, i) => okCheck(`check ${i + 1}`));
const prOn = (pr, checks, more = {}) => ({ state: 'done', result: { pr }, pr_status: { pr, state: 'OPEN', url: null, isDraft: false, mergeable: 'MERGEABLE', checks, at: ago194(1), ...more } });
const eleven = Array.from({ length: 11 }, (_, i) => ({ name: i ? `check ${i}` : 'Lint', url: null }));
const red = { name: 'Flows image missing', status: 'completed', conclusion: 'failure', started: ago194(9), completed: ago194(8), runner: true };
const board = {
  'V-366': { state: 'queued' },
  'V-705': { state: 'running', stage: '3/9', result: { pr: 705 }, fix: { try: 1, of: 2, pr: 705, kind: 'checks', what: 'red: Lint', checks: eleven, not_mine: [] } },
  'V-704': { ...ready, result: { pr: 704 }, fix: { try: 1, of: 2, pr: 704, kind: 'conflict', what: 'conflicts with main', base: 'main' } },
  'V-697': { ...ready, result: { pr: 697 }, fix: { try: 1, of: 2, pr: 697, kind: 'checks', what: 'red: Lint', checks: eleven, not_mine: [] } },
  'V-693': prOn(693, [...okChecks(18), { name: 'Backend tests', status: 'in_progress', conclusion: null, started: new Date(NOW - 4 * 60000).toISOString(), runner: true },
    { name: 'e2e', status: 'queued', conclusion: null, started: null, runner: false }, { name: 'e2e (2)', status: 'queued', conclusion: null, started: null, runner: false }]),
  'V-701': prOn(701, okChecks(23)),
  'V-508': heldBy('V-693'),
  'V-500': { state: 'parked', park: { question: 'which copy?' } },
  'V-501': { state: 'failed', park: { question: 'tests red' } },
  'V-696': { ...prOn(696, [...okChecks(3), red]), stuck: { why: 'Flows image missing · build it: ensure-flows-image.sh', pr: 696 } },
  'V-698': { ...prOn(698, [...okChecks(3), { ...red, name: 'Lint' }]), stuck: { why: 'still red after 2 fix tries: Lint', pr: 698 } },
  'V-700': { ...prOn(700, okChecks(3), { isDraft: true }), undraft: { call: 'person', why: 'its review verdict at abcdef123 is not clean (p1=1)', action: 'settle the findings or gaps on #700' } },
  'V-702': { ...prOn(702, okChecks(3), { isDraft: true }), undraft: { call: 'person', why: '§4 Clean review verdict is not set as key=value counts, so no verdict can be read as clean', action: 'set it with /desk-setup' } },
  'V-690': mergedAt(690),
};
put(I.T, I.env, 'board', { port: 5600, conc: '3 / 5', beat: 1, perms: { 'autopilot-merge': 'yes', 'pr-merge-green': 'yes' }, queue: { batch: 'board', concurrency: 3, supervised: true, tickets: board } });
put(I.T, I.env, 'boardask', { port: 5610, conc: '3 / 5', beat: 1, queue: { batch: 'boardask', concurrency: 3, supervised: true, tickets: { 'V-701': prOn(701, okChecks(23)) } } });
const repos279 = Q.loadRepos(NOW).filter((r) => ['board', 'boardask'].includes(r.name));
const r279 = repos279.find((r) => r.name === 'board');
const q279 = lines(Q.repoScreen(r279, { now: NOW }));
const row279 = (key) => q279.find((l) => new RegExp(`^ +(-|\\*?\\d+) {2}${key} `).test(l)) ?? '';
const rail279 = (key, r = r279) => railText(Q.ticketScreen(r, key, { now: NOW }));
t('DS-279 AC1 the groups are exactly Running, Ready, Merging, Waiting, Needs you, in that order, each ticket in one',
  q279.map((l) => GROUP_LINE.exec(l)?.slice(1).join(' · ') ?? /^ +(?:-|\*?\d+) {2}(V-\d+)\s/.exec(l)?.[1]).filter(Boolean).join(' | '),
  'Running · 1 | V-705 | Ready · 3 | V-366 | V-704 | V-697 | Merging · 2 | V-693 | V-701 | Waiting · 1 | V-508 | Needs you · 6 | V-500 | V-501 | V-696 | V-698 | V-700 | V-702');
t('DS-279 AC2 a fix worker on its red PR holds a worker: Running', `${/V-705 +● running +#705 · 11 checks failed/.test(row279('V-705'))} ${rail279('V-705').includes('#705 · 11 checks failed · a worker repairs it, try 1 of 2')}`, 'true true');
t('DS-279 AC3 an untriaged ticket and a queued fix try wait only for a worker: Ready', `${/V-366 +○ ready +triaging/.test(row279('V-366'))} ${/V-697 +○ ready /.test(row279('V-697'))}`, 'true true');
t('DS-279 AC4 a PR in CI that merges without you: Merging', /V-693 +▸ merging /.test(row279('V-693')), true);
t('DS-279 AC5 a ticket behind one that moves by itself: Waiting', /V-508 +· waiting +behind #693: Backend tests running/.test(row279('V-508')), true);
t('DS-279 AC6 a question, a stopped worker, an operator check, red after both tries and drafts: Needs you, each with its reason',
  ['V-500', 'V-501', 'V-696', 'V-698', 'V-700', 'V-702'].filter((k) => !/ ◆ needs you +\S/.test(row279(k))).join(), '');
t('DS-279 AC7 all 23 checks passed: merges at the next pass, or needs you to merge it where pr-merge-green is not yes',
  `${row279('V-701').includes('#701 · all 23 checks passed · merges at the next')} ${rail279('V-701')} | ${rail279('V-701', repos279.find((r) => r.name === 'boardask'))}`,
  'true Moves without you: PR #701, all 23 checks passed · merges at the next pass. | Needs you: PR #701, all 23 checks passed · merge it.');
t('DS-279 AC8 the check holding it, how long, and how many are done', row279('V-693').includes('#693 · Backend tests running, 4m · 18 of 21 done'), true);
t('DS-279 AC9 11 failed checks on try 1: a worker repairs it while running, the next free worker while queued',
  `${rail279('V-705').includes('11 checks failed · a worker repairs it, try 1 of 2')} ${rail279('V-697').includes('#697 · 11 checks failed · next free worker repairs it, try 1 of 2')}`, 'true true');
t('DS-279 AC9 no row with a failed check leads with a pass count', q279.filter((l) => /failed/.test(l) && /passed|\d+ of \d+ done/.test(l)).join(' | '), '');
t('DS-279 AC10 a DIRTY PR on its first try names the base branch', rail279('V-704'), 'Moves without you: #704 · merge conflict with main · next free worker repairs it, try 1 of 2.');
t('DS-279 AC11 red only on a check workers can\'t fix: its reason and command', rail279('V-696'), 'Needs you: PR #696, Flows image missing · build it: ensure-flows-image.sh.');
t('DS-279 AC12 a draft whose review has a P1, and one whose clean verdict is unreadable',
  `${row279('V-700').includes('#700 · draft · review not clean: 1 P1')} ${rail279('V-702')}`, 'true Needs you: PR #702, draft · review verdict unreadable: set §4 Clean review verdict.');
t('DS-279 AC13 still red after both fix tries', row279('V-698').includes('#698 · still red after 2 fix tries: Lint'), true);
const ov279 = lines(Q.overview(repos279, { now: NOW, avail: 30 }));
t('DS-279 AC14 home counts RUN, READY, MERGING, WAIT, NEEDS YOU and DONE, the merged ticket in DONE and no open PR, and the header counts the Needs you rows',
  `${cols215(ov279)} | ${(rowOf(ov279.join('\n'), 'board') ?? '').trim().split(/\s+/).slice(6, 12).join(' ')} | ${q279[1].startsWith('◆ 6 tickets need you  ● 1 running  ○ 3 ready  ▸ 2 merging  · 1 waiting │ ✓ 1 done')} ${ov279.find((l) => l.startsWith('◆ '))?.startsWith('◆ 7 tickets need you')}`,
  'REPO|LAST PASS|RUN|READY|MERGING|WAIT|NEEDS YOU|DONE|ALL DONE BY|WORKERS | 1 3 2 1 6 1 | true true');
t('DS-279 AC15 the key line names each state on screen, in order, with what moves it', q279.find((l) => l.startsWith('key ')),
  'key   ● running: holds a worker │ ○ ready: next free worker takes it │ ▸ merging: merges by itself once green │ · waiting: moves by itself │ ◆ needs you: nothing moves until you act');
const drawn279 = [ov279.join('\n'), q279.join('\n'), Q.timelineScreen(repos279, 'acme__board', { now: NOW }), Q.daysScreen(repos279, 'acme__board', { now: NOW }),
  ...Object.keys(board).map((k) => Q.ticketScreen(r279, k, { now: NOW }))].join('\n');
t('DS-279 AC16 no screen draws a retired word: fixing, stuck, blocked, landing, release, waiting on you, QUEUE DONE',
  (drawn279.match(/\b(fixing|stuck|blocked|landing|releas\w*)\b|waiting on you|queue done/gi) ?? []).join(), '');
t('DS-279 AC16 "failed" is said only of checks', [ov279.join('\n'), q279.join('\n')].join('\n').split('\n').filter((l) => /failed/.test(l) && !/\d+ checks? failed/.test(l)).join(' | '), '');

// A red PR moves by itself only where the merge driver reruns it, both fix tries end with the person,
// a fix worker that parked needs you on its page as on its row, and a batch base names the conflict.
const fx = {
  'F-1': prOn(801, [...okChecks(2), { ...red, name: 'e2e' }]),
  'F-2': { ...prOn(802, [...okChecks(2), { ...red, name: 'Lint' }]), fix_tries: [{ try: 1 }, { try: 2 }] },
  'F-3': { ...prOn(803, okChecks(2), { mergeable: 'CONFLICTING' }), fix_tries: [{ try: 1 }, { try: 2 }] },
  'F-4': prOn(804, okChecks(2), { mergeable: 'CONFLICTING' }),
  'F-5': { state: 'parked', park: { question: 'which copy?' }, result: { pr: 805 }, fix: { try: 1, of: 2, pr: 805, kind: 'checks', what: 'red: Lint', checks: eleven, not_mine: [] } },
};
const grant = { 'autopilot-merge': 'yes', 'pr-merge-green': 'yes' };
put(I.T, I.env, 'fixgo', { port: 5620, conc: '3 / 5', beat: 1, perms: { ...grant, 'ci-rerun': 'yes' }, queue: { batch: 'fixgo', concurrency: 3, supervised: true, base: 'develop', tickets: fx } });
put(I.T, I.env, 'fixno', { port: 5630, conc: '3 / 5', beat: 1, queue: { batch: 'fixno', concurrency: 3, supervised: true, tickets: { 'F-1': fx['F-1'] } } });
put(I.T, I.env, 'fixrr', { port: 5640, conc: '3 / 5', beat: 1, perms: grant, queue: { batch: 'fixrr', concurrency: 3, supervised: true, tickets: { 'F-1': fx['F-1'] } } });
const reposFx = Q.loadRepos(NOW), rGo = reposFx.find((r) => r.name === 'fixgo'), rNo = reposFx.find((r) => r.name === 'fixno'), rRr = reposFx.find((r) => r.name === 'fixrr');
const qGo = lines(Q.repoScreen(rGo, { now: NOW })), qNo = lines(Q.repoScreen(rNo, { now: NOW })), qRr = lines(Q.repoScreen(rRr, { now: NOW }));
const fxRow = (ls, key) => ls.find((l) => new RegExp(`^ +(-|\\*?\\d+) {2}${key} `).test(l)) ?? '';
t('DS-279 (DS-280 AC2) a red PR the merge driver reruns is merging, and names the check and the rerun next',
  `${/F-1 +▸ merging/.test(fxRow(qGo, 'F-1'))} ${rail279('F-1', rGo)}`, 'true Moves without you: PR #801, e2e failed · rerun 1 of 2 next.');
t('DS-279 a red PR nothing reruns needs you: fix or re-run it, with no merge grant or with §3 ci-rerun not yes',
  `${/F-1 +◆ needs you/.test(fxRow(qNo, 'F-1'))} ${rail279('F-1', rNo)} | ${/F-1 +◆ needs you/.test(fxRow(qRr, 'F-1'))} ${rail279('F-1', rRr)}`,
  'true Needs you: PR #801, 1 check failed · fix or re-run it. | true Needs you: PR #801, 1 check failed · fix or re-run it.');
t('DS-279 a red PR after both fix tries is re-run on its new head before the pass records it stuck, never try 3 of 2; a conflict needs you at once',
  `${rail279('F-2', rGo)} | ${rail279('F-3', rGo)}`, 'Moves without you: PR #802, Lint failed · rerun 1 of 2 next; no fix tries left. | Needs you: PR #803, still in conflict with develop after 2 fix tries.');
t('DS-279 AC9 no row with a failed check leads with a pass count, on PRs red on the plain PR-status path',
  `${/#801 · e2e failed/.test(fxRow(qGo, 'F-1'))} ${[fxRow(qNo, 'F-1'), fxRow(qRr, 'F-1')].every((l) => /#801 · 1 check failed/.test(l))} ${[...qGo, ...qNo, ...qRr].filter((l) => /failed/.test(l) && /passed|\d+ of \d+ done/.test(l)).join(' | ')}`, 'true true ');
t('DS-279 a conflict names the batch\'s base, as its fix try will', rail279('F-4', rGo), 'Moves without you: PR #804, merge conflict with develop · the next pass sends it to a worker, try 1 of 2.');
t('DS-279 a fix worker that parked needs your answer on its page, as its row says', `${/F-5 +◆ needs you/.test(fxRow(qGo, 'F-5'))} ${rail279('F-5', rGo).startsWith('Needs your answer: which copy?')}`, 'true true');
const advQ = { tickets: { 'A-1': { key: 'A-1', ...prOn(810, [okCheck('build'), { ...red, name: 'lint' }]) }, 'A-2': { key: 'A-2', ...heldBy('A-1') } } };
const advCtx = (advisory, required = []) => ({ releases: true, merges: true, reruns: true, stage: () => null, base: 'main', required, advisory });
t('DS-279 a failed advisory check is no repair: the PR merges past it, as the fix tries read it',
  `${Q.holdOf(advQ, advQ.tickets['A-2'], advCtx(['lint'])).text} | ${Q.holdOf(advQ, advQ.tickets['A-2'], advCtx([])).text}`, 'behind #810: 1 check failed, advisory only | behind #810: lint failed');
// A §4 Required check that never reported, or finished neutral, is not green: the merge driver never
// merges it and nothing reruns or repairs it, so it needs you rather than "merges at the next pass".
const reqQ = { tickets: { 'R-1': { key: 'R-1', ...prOn(811, [okCheck('build')]) }, 'R-2': { key: 'R-2', ...prOn(812, [okCheck('build'), { ...okCheck('e2e'), conclusion: 'neutral' }]) } } };
const reqNeed = (k) => `${Q.shownState(reqQ, reqQ.tickets[k], advCtx([], ['e2e']))} ${Q.holdOf({ tickets: { ...reqQ.tickets, H: { key: 'H', ...heldBy(k) } } }, { key: 'H', ...heldBy(k) }, advCtx([], ['e2e'])).text}`;
t('DS-279 a required check that never reported or ended neutral needs you, naming it',
  `${reqNeed('R-1')} | ${reqNeed('R-2')}`,
  'needs behind #811, which needs you | needs behind #812, which needs you');
t('DS-279 and its row names the check and what to do',
  ['R-1', 'R-2'].map((k) => Q.needText({ q: reqQ, ctx: advCtx([], ['e2e']), live: true }, { t: reqQ.tickets[k], k: 'needs', pr: true })).join(' | '),
  '#811 · required check "e2e" has not reported · fix the check or §4 Required checks | #812 · required check "e2e" is neutral · fix the check or §4 Required checks');

// ---- DS-280: a PR inside its reruns stays in Merging naming the red check, each Merging and Needs you
// row says how long it has sat there, and a ticket behind a PR that needs you counts once.
const at280 = (m) => ({ g: 'merging', at: ago194(m) });
const lint = { ...red, name: 'Lint' }, backend = { ...red, name: 'Backend tests' };
const due280 = NOW + 10 * 60000;
const fresh = { changed_at: ago194(30) };
const ds280 = {
  // AC1: one of two reruns had, the next due 10 minutes from now; AC2: two red, none tried; AC3: both spent.
  'M-1': { ...prOn(901, [...okChecks(2), lint], { reruns: { Lint: 1 }, rerun_at: new Date(due280 - 720000).toISOString(), ...fresh }), group: at280(5) },
  'M-2': { ...prOn(902, [...okChecks(2), backend, lint], { reruns: {}, rerun_at: null, ...fresh }), group: at280(5) },
  'M-3': { ...prOn(903, [...okChecks(2), lint], { reruns: { Lint: 2 }, rerun_at: ago194(20), ...fresh }), group: at280(5) },
  // AC4: in Merging for 2h 5m; AC6: no change for exactly 2h; AC7: a check changed 30 minutes ago.
  'M-4': { ...prOn(904, okChecks(3).map((c, i) => (i ? c : { ...c, status: 'in_progress', conclusion: null })), fresh), group: at280(125) },
  'M-6': { ...prOn(906, okChecks(3).map((c, i) => (i ? c : { ...c, status: 'in_progress', conclusion: null, started: ago194(150) })), { changed_at: ago194(120) }), group: at280(180) },
  // AC5: in Needs you since 25 hours ago.
  'N-5': { state: 'parked', park: { question: 'which copy?' }, group: { g: 'needs', at: ago194(25 * 60) } },
  // AC9: the 27 Oct board's VPL-504, held only behind #698, which needs you; AC10: one also asking its own question.
  'V-698': { ...board['V-698'], group: { g: 'needs', at: ago194(60) } },
  'V-504': heldBy('V-698'),
  'V-510': { ...heldBy('V-698'), open_questions: 1 },
};
put(I.T, I.env, 'ds280', { port: 5650, conc: '3 / 5', beat: 1, perms: { ...grant, 'ci-rerun': 'yes' }, queue: { batch: 'ds280', concurrency: 3, supervised: true, tickets: ds280 } });
const r280 = Q.loadRepos(NOW).find((r) => r.name === 'ds280');
const q280 = lines(Q.repoScreen(r280, { now: NOW, width: 200 }));
const row280 = (key) => fxRow(q280, key);
// WHAT IT NEEDS and STARTS of a row, each trimmed, at 200 columns (NEED_W 52).
const cells280 = (key) => { const l = row280(key); return [l.slice(31, 83).trim(), l.slice(83, 96).trim()]; };
// WHAT IT NEEDS is 52 columns on a row, so a longer reason is cut there and read whole on the ticket page.
// The row names the rerun to come, so one rerun had reads "rerun 2 of 2" until the driver runs it.
t('DS-280 AC1 a red PR with one rerun had: Merging, the check, and when the next is due',
  `${/M-1 +▸ merging/.test(row280('M-1'))} ${cells280('M-1')[0]}`, `true #901 · Lint failed · rerun 2 of 2 at ${new Date(due280).toTimeString().slice(0, 5)}`);
t('DS-280 AC1 once its cooldown passes, the same rerun is next, not a different count',
  fxRow(lines(Q.repoScreen(r280, { now: due280 + 60000, width: 200 })), 'M-1').slice(31, 83).trim(), '#901 · Lint failed · rerun 2 of 2 next');
t('DS-280 AC2 two red before any rerun: Merging, leading with the checks, never a pass count',
  `${/M-2 +▸ merging +#902 · Backend tests, Lint failed · rerun/.test(row280('M-2'))} ${rail279('M-2', r280)}`, 'true Moves without you: PR #902, Backend tests, Lint failed · rerun 1 of 2 next.');
t('DS-280 AC3 both reruns spent and no fix try yet: Merging, a worker repairs it next',
  `${/M-3 +▸ merging +#903 · Lint failed · reruns spent/.test(row280('M-3'))} ${rail279('M-3', r280)}`, 'true Moves without you: PR #903, Lint failed · reruns spent, a worker repairs it next.');
t('DS-280 more than two red checks lead with the count and the first', Q.needText(r280, { t: { ...ds280['M-2'], pr_status: { ...ds280['M-2'].pr_status, checks: [lint, backend, { ...red, name: 'e2e' }] } }, k: 'merging', pr: true }),
  '#902 · 3 checks failed: Lint +2 · rerun 1 of 2 next');
t('DS-280 AC4 STARTS says how long a PR has been in Merging', cells280('M-4')[1], 'for 2h 5m');
t('DS-280 AC5 STARTS says how long a ticket has been in Needs you', `${/N-5 +◆ needs you/.test(row280('N-5'))} ${cells280('N-5')[1]}`, 'true for 1d 1h');
t('DS-280 AC6 no change for 2 hours: WHAT IT NEEDS ends saying so', cells280('M-6')[0], '#906 · check 1 running, 2h 30m · no change for 2h');
t('DS-280 AC7 a check that changed 30 minutes ago: no note', `${cells280('M-4')[0]} | ${q280.filter((l) => /no change/.test(l)).length}`, '#904 · check 1 running, 30m · 2 of 3 done | 1');
t('DS-280 a stamp of another group, before the next pass, shows no age', (() => {
  put(I.T, I.env, 'ds280b', { port: 5660, conc: '3 / 5', beat: 1, perms: { ...grant, 'ci-rerun': 'yes' }, queue: { batch: 'ds280b', concurrency: 3, supervised: true, tickets: { 'M-9': { ...ds280['M-4'], group: { g: 'running', at: ago194(300) } } } } });
  return fxRow(lines(Q.repoScreen(Q.loadRepos(NOW).find((r) => r.name === 'ds280b'), { now: NOW, width: 200 })), 'M-9').slice(83, 96).trim();
})(), 'started');
const raw280 = async (key) => {
  const s = screen({ kind: 'repo', slug: 'acme__ds280' }, 200, () => NOW);
  await sleep(20);
  const l = lastFrame(s).find((x) => new RegExp(`^.\\s+(-|\\d+) {2}${key} `).test(x.replace(ANSI, ''))) ?? '';
  s.ui.finish(0);
  return coloured(l).filter((c) => /^for /.test(c.split(':')[1] ?? '')).join();
};
t('DS-280 AC6 and AC7 the age is amber with no change for 2 hours, and uncoloured after a change 30 minutes ago', `${await raw280('M-6')} | ${await raw280('M-4')}`, '38;5;180:for 3h | ');
t('DS-280 AC9 behind only a PR that needs you: Waiting, saying so, and starting after it', `${/V-504 +· waiting/.test(row280('V-504'))} ${cells280('V-504').join(' | ')}`,
  'true behind #698, which needs you | after #698');
t('DS-280 AC10 held behind it and asking its own question: Needs you, for its question, on its row and its page', `${/V-510 +◆ needs you/.test(row280('V-510'))} ${cells280('V-510')[0]} | ${rail279('V-510', r280)}`,
  'true 1 triage question(s) open: answer them | Needs you: triage left 1 question open. Answer, in ds280, and the orchestrator decides whether to requeue it:');
t('DS-280 AC9 and AC10 the header counts #698 and V-510 once each, and V-504 not at all',
  `${q280[1].startsWith('◆ 3 tickets need you')} ${Q.needsRows(r280).map((x) => x.t.key ?? '').sort().join(',')}`, 'true N-5,V-510,V-698');
t('DS-280 the pass\'s groups match what desk-q draws', JSON.stringify(Q.groupsNow({ slug: 'acme__ds280', stateDir: r280.stateDir, queuePath: r280.queuePath, q: r280.q, now: NOW })),
  JSON.stringify(Object.fromEntries(Object.keys(ds280).map((k) => [k, { 'N-5': 'needs', 'V-698': 'needs', 'V-510': 'needs', 'V-504': 'waiting' }[k] ?? 'merging']))));

// ---- DS-357: a repo with its standing batch and a batch in a slot named after a long branch is one
// row on home, and one Queue in its place, whose moves act within each ticket's own batch.
const SLOT357 = 'feat-epics-coverage-to-podcasts';
const ready357 = { state: 'triaged', open_questions: 0 };
put(I.T, I.env, 'twob', { port: 5700, conc: '2 / 3', beat: 1, queue: { batch: 'tb', concurrency: 2, tickets: {
  'TB-1': { state: 'running', stage: '2/9' }, 'TB-2': ready357, 'TB-3': { state: 'parked', park: { question: 'which copy?' } } } } });
const q357 = join(I.env.DESK_HOME, 'repos', 'acme__twob', 'batches', SLOT357, 'queue.json');
const s357 = join(I.env.HOME, '.desk-autopilot', 'acme__twob', 'batches', SLOT357);
mkdirSync(dirname(q357), { recursive: true });
mkdirSync(join(s357, 'orchestrators'), { recursive: true });
writeFileSync(q357, JSON.stringify({ version: 1, batch: 'feat', base: 'feat/epics-coverage-to-podcasts', concurrency: 2, tickets: {
  'TB-7': { key: 'TB-7', ...ready357 }, 'TB-8': { key: 'TB-8', ...ready357 }, 'TB-9': { key: 'TB-9', state: 'parked', park: { question: 'which word?' } } } }));
writeFileSync(join(s357, 'orchestrators', 'q.json'), JSON.stringify({ queue: q357, batch: 'feat', pid: 1, at: minsAgo(5) }));
const twob = () => Q.loadRepos(NOW).filter((r) => r.slug === 'acme__twob');
const badge357 = 'Tickets that need your answer have no date · c: date them as if answered at the next check-in';
const ov357 = lines(Q.overview(twob(), { now: NOW, avail: 30, width: 120, badge: badge357 }));
t('DS-357 AC1 one row for the repo, named with the repo only, and no batch or branch on home',
  `${ov357.filter((l) => /^ {2}twob/.test(l)).length} ${ov357.some((l) => /feat-epics|feat\/epics/.test(l))}`, '1 false');
t('DS-357 AC2 its counts are the sums, the last pass the latest, the workers the total within the cap, and a batch with no date makes ALL DONE BY no date yet',
  /^ {2}twob +● session · 1m ago +1 +3 +0 +0 +2 +0 +no date yet +3 \(cap 3\)$/.test(ov357.find((l) => l.startsWith('  twob')) ?? ''), true);
t('DS-357 AC3 at 120 columns every column shows, and a note\'s text starts after a tag column the repo name sizes',
  `${['RUN', 'READY', 'MERGING', 'WAIT', 'NEEDS YOU', 'DONE', 'ALL DONE BY', 'WORKERS'].every((h) => ov357.find((l) => l.includes('LAST PASS'))?.includes(h))} ${ov357.find((l) => l.includes('  dates'))?.indexOf('Tickets')} ${ov357.every((l) => l.length <= 120)}`,
  'true 21 true');
t('DS-357 AC4 the needs-you line names the repo once, its batches added', ov357[0].endsWith('│ twob 2'), true);
const p357 = lines(Q.run(['--plain', 'twob'], { now: NOW }));
t('DS-357 AC2b the repo\'s header adds up its batches, with no batch named',
  `${p357[1]} | ${p357[2].includes('workers 1 of 3 · cap 3')} ${p357.some((l) => /batch|feat/.test(l))}`, '◆ 2 tickets need you  ● 1 running  ○ 3 ready │ ✓ 0 done, not shown | true false');
t('DS-357 AC2b one list grouped by state, every batch\'s tickets in it',
  p357.filter((l) => /^ {2}[A-Z][a-z]/.test(l)).map((l) => l.trim()).join(' | ') + ' | ' + ['TB-1', 'TB-2', 'TB-3', 'TB-7', 'TB-8', 'TB-9'].every((k) => p357.some((l) => l.includes(`  ${k} `))),
  'Running · 1 | Ready · 3 | Needs you · 2 | true');
const M357 = screen({ kind: 'repo', slug: 'acme__twob' }, 120, () => NOW);
await sleep(20);
await M357.press(DOWN); await M357.press(DOWN);
const sel357 = M357.selected();
await M357.press('b');
t('DS-357 AC2b a move on the repo\'s Queue acts within the ticket\'s own batch',
  `${/TB-7/.test(sel357)} ${M357.frame().some((l) => l.startsWith('TB-7 → position 3 of 3, placed by you.'))} ${Object.keys(JSON.parse(readFileSync(q357, 'utf8')).tickets).join()}`,
  'true true TB-8,TB-9,TB-7');
M357.ui.finish(0);
// AC5 and AC6: home with cost sources set, with and without a cost reading, draws no Charged line, and
// its bottom is a blank line, the Claude usage line, then the keys.
const FIX357 = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'costs-october');
const cost357 = { DESK_COSTS: process.env.DESK_COSTS, DESK_COST_DIR: process.env.DESK_COST_DIR };
const home357 = async (reading) => {
  const d = mkdtempSync(join(tmpdir(), 'desk-q-357-'));
  writeFileSync(join(d, 'costs.md'), readFileSync(join(FIX357, 'costs.md'), 'utf8'));
  if (reading) writeFileSync(join(d, 'cache.json'), readFileSync(join(FIX357, 'cache.json'), 'utf8'));
  Object.assign(process.env, { DESK_COSTS: join(d, 'costs.md'), DESK_COST_DIR: d });
  const S = screen({ kind: 'overview', all: false }, 120, () => NOW);
  await sleep(20);
  S.ui.finish(0);
  return S.frame();
};
const h357 = [await home357(true), await home357(false)];
for (const [k, v] of Object.entries(cost357)) if (v == null) delete process.env[k]; else process.env[k] = v;
const keys357 = (f) => f.findIndex((l) => /^(move  |↑↓ )/.test(l));
t('DS-357 AC5 home has no Charged line, with a cost reading or without one',
  h357.map((f) => f.some((l) => l.startsWith('Charged '))).join(), 'false,false');
t('DS-357 AC6 home ends in one blank line, the Claude usage line, then the keys',
  h357.map((f) => `${f[keys357(f) - 3] !== ''}|${f[keys357(f) - 2]}|${f[keys357(f) - 1]?.startsWith('Claude usage  ')}`).join(), 'true||true,true||true');
// A batch whose queue cannot be read leaves the repo's other batch counted and listed, and says so.
writeFileSync(q357, '{ not json');
const ov357u = lines(Q.overview(twob(), { now: NOW, avail: 30, width: 120 }));
const p357u = lines(Q.run(['--plain', 'twob'], { now: NOW }));
const said357 = `Batch ${SLOT357}'s queue is unreadable, so its tickets are not counted`;
t('DS-357 AC2 one unreadable batch: home counts the readable one, names the repo in the needs-you line, and notes the unreadable one',
  `${/^ {2}twob +● session · 1m ago +1 +1 +0 +0 +1 +0 /.test(ov357u.find((l) => l.startsWith('  twob')) ?? '')} ${ov357u[0].endsWith('│ twob 1')} ${ov357u.some((l) => l.includes(said357))}`,
  'true true true');
t('DS-357 AC2b one unreadable batch: the repo\'s place lists the readable batch\'s tickets and says which queue it could not read',
  `${['TB-1', 'TB-2', 'TB-3'].every((k) => p357u.some((l) => l.includes(`  ${k} `)))} ${p357u.some((l) => l.includes(said357))}`, 'true true');

// DS-386: a stuck that names no checks holds only at the PR head it was recorded at (DS-379's, on PR #348).
const why386 = 'review not clean after 2 fix tries (2 review): 1 P0 — P0: desk/bin/evidence.mjs:40 a code span splits the cell';
const t386 = (stuckHead, prHead) => ({ state: 'done', result: { pr: 348 }, stuck: { why: why386, pr: 348, ...(stuckHead ? { head: stuckHead } : {}) },
  pr_status: { pr: 348, state: 'OPEN', isDraft: true, head: prHead, checks: [] } });
t('DS-386 AC3 a review stuck whose head is not the PR\'s recorded head is gone', Q.stuckOf(t386('597a520', 'a6e2ab4')), null);
t('DS-386 AC2 at the PR\'s head it holds as written', Q.stuckOf(t386('a6e2ab4', 'a6e2ab4'))?.why, why386);
t('DS-386 a stuck recorded with no head holds as written', Q.stuckOf(t386(null, 'a6e2ab4'))?.why, why386);

console.log(fails ? `${fails} FAILED` : 'all desk-q checks passed');
process.exit(fails ? 1 : 0);
