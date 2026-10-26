// suite: desk-q plain output (overview, one repo, one ticket)
// desk-q against fixture repo configs, queues, heartbeats and triage records under a throwaway HOME,
// DESK_HOME and DESK_CONFIG_ROOT. Nothing touches your real ~/.claude, ~/.config/desk or state.
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'desk-q.mjs');
const NOW = Date.now();
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();

// One fixture world: seven repos by default, or `repos` to override, each { port, conc, queue, beat, triage }.
function world(overrides = {}) {
  const T = mkdtempSync(join(tmpdir(), 'desk-q-'));
  // macOS, with a fake launchctl: `print gui/<uid>/<label>` exits 0 for each label in bin/loaded.
  mkdirSync(join(T, 'bin'));
  writeFileSync(join(T, 'bin', 'launchctl'), '#!/bin/sh\ngrep -qxF "${2##*/}" "$(dirname "$0")/loaded" 2>/dev/null\n', { mode: 0o755 });
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
t('AC1 one line names the three repos with no batch', lines(ov.out).some((l) => l.startsWith('3 more set up with no batch: forewatt, gygg-platform, yield-index')), true);
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
// ---- AC15: voicepa's counts, last pass and workers (and QUEUE DONE, with no history)
const vp = (rowOf(ov.out, 'voicepa') ?? '').trim().split(/\s+/);
t('AC15 voicepa row: a session 4m ago, run 2, ready 0, wait 1, blocked 0, needs 0, failed 0, done 3, workers 3', vp.slice(1, 16).join(' '), '● session · 4m ago 2 0 1 0 0 0 3 no history 3');

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
t('DS-194 AC5 (DS-215) with no PR landing, the counts line leaves the landing part out', lines(pre.out)[1], '◆ nothing needs you  ● 2 running  · 1 waiting │ ✓ 3 done, not shown');
// ---- AC9: an ambiguous prefix refuses, naming both, with no table
const amb = W.run('--plain', 'pr');
t('AC9 ambiguous prefix exits non-zero', amb.code !== 0, true);
t('AC9 names both repos, prints no table', /pr-ninja/.test(amb.err) && /pranicuk/.test(amb.err) && amb.out === '', true);
// ---- AC10: no match refuses, listing what is set up
const zz = W.run('--plain', 'zz');
t('AC10 no match exits non-zero listing the repos', zz.code !== 0 && /forewatt/.test(zz.err) && /voicepa/.test(zz.err), true);
// ---- AC11: show on a held ticket
const show = W.run('--plain', 'voicepa', 'show', 'VPL-3');
const want = ['Long gaps between bookings', 'waiting', 'Starts when the last of these merges:\n  VPL-1     ● running', 'Parked: held by orchestrator', 'lane A', 'Why lane A', 'mechanical once the gap rule is read', 'Files in scope · 2', 'src/gaps.ts', 'Branch    feat/VPL-3-gaps', `Open      log ${join(W.env.HOME, '.desk-autopilot', 'acme__voicepa', 'logs', 'VPL-3.log')}`];
t('AC11 show prints every field', want.filter((w) => !show.out.includes(w)).join(' | '), '');
t('AC11 show leaves out the merged blocker', lines(show.out).some((l) => /^\s+VPL-0\b/.test(l)), false);
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
t('AC6 (DS-217 AC5) held behind a ticket parked for its own reason reads waiting, which is parked', /VPL-6\s+· waiting\s+behind VPL-5, which is parked\s/.test(S.run('--plain', 'voicepa').out), true);
const blockedViews = { overview: S.run('--plain').out, queue: S.run('--plain', 'voicepa').out, ticket: S.run('--plain', 'voicepa', 'show', 'VPL-7').out };
t('DS-188 AC2 every screen calls the held ticket blocked, never stuck, and the overview heads its column BLOCKED',
  JSON.stringify([...Object.values(blockedViews).map((s) => /stuck/i.test(s)), lines(blockedViews.overview)[0].endsWith(' │ ◌ 1 blocked'),
    lines(blockedViews.overview).some((l) => /^ +REPO .* BLOCKED /.test(l)), /VPL-7\s+◌ blocked\s/.test(blockedViews.queue),
    lines(blockedViews.ticket)[0].startsWith('VPL-7  ◌ blocked'), lines(blockedViews.ticket).some((l) => /^Now +Blocked, held: 2 Jira blockers outside the batch$/.test(l))]),
  '[false,false,false,true,true,true,true,true]');

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
t('a failed ticket shows no position', /^\s+-\s+VPL-2\s+✕ failed/.test(lines(past.out).find((l) => /VPL-2/.test(l)) ?? ''), true);

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
// A dark terminal theme: COLORFGBG from the shell running the suite would pick the light greys.
delete process.env.COLORFGBG;
const Q = await import(BIN);
// The label grey on a dark theme, and a string made safe for a RegExp.
const G = '\x1b[38;5;247m';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const { PassThrough } = await import('node:stream');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function screen(start, columns = 80, clock = Date.now) {
  const input = new PassThrough();
  const modes = [];
  Object.assign(input, { isTTY: true, setRawMode: (b) => modes.push(b) });
  // `resize` holds the screen's resize listener, so a test can change `columns` and call it.
  const output = { buf: '', columns, rows: 24, write(s) { this.buf += s; }, on(e, f) { if (e === 'resize') this.resize = f; }, removeListener() {} };
  const codes = [], opened = [];
  const ui = Q.interactive({ input, output, start, exit: (c) => codes.push(c), opener: (u) => opened.push(u), refreshMs: start?.refreshMs ?? 600000, clock });
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
// Each coloured run, as "<SGR>:<text>"; `dim` takes dim and grey (256-colour) runs too.
const coloured = (l, dim = false) => [...l.matchAll(dim ? /\x1b\[(3[0-8]|2|38;5;\d+)m([^\x1b]*)\x1b\[(?:39|22)m/g : /\x1b\[(3[0-8])m([^\x1b]*)\x1b\[39m/g)].map((m) => `${m[1]}:${m[2].trim()}`);

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
t('AC4 the blocker is a selectable row', /^›\s+VPL-1\s+● running/.test(A.selected()), true);
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
t('a ticket taller than the terminal hides its last lines at first', logLine(), false);
for (let i = 0; i < 40; i++) await A.press(DOWN);
t('↓ on the last blocker reads on to the bottom of the ticket', logLine(), true);
for (let i = 0; i < 40; i++) await A.press('\x1b[A');
t('↑ scrolls back to the blocker, still selected', /^›\s+VPL-1\s/.test(A.selected()), true);
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
t('DS-163 AC1 the state shows in colour', /\x1b\[32m● running/.test(Gs.output.buf) && /\x1b\[34m○ ready/.test(Gs.output.buf), true);
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
t('DS-163 AC8 a ticket waiting on you says so, and how long once answered', [barRow(tidyTl, 'T-4'), days.find((l) => /^ {4}T-4 /.test(l)) ?? ''].every((l) => l.includes(`Waiting on you · ~${typicalM} h once answered`)), true);
t('DS-163 AC8 (DS-217 AC8) a blocked ticket names what holds it', [barRow(tidyTl, 'T-5'), days.find((l) => /^ {4}T-5 /.test(l)) ?? ''].every((l) => l.includes('Held: 1 Jira blocker outside the batch')), true);
t('DS-163 AC8 workers set to 0 says nothing starts', /Workers set to 0: nothing starts +Z-1 title$/.test(barRow(tl('acme__zero'), 'Z-1')), true);

const Ks = screen({ kind: 'timeline', slug: 'acme__tidy' }, 120, () => FIXED);
await sleep(20);
const head1 = () => Ks.frame().find((l) => l.startsWith('tidy · forecast')) ?? '';
const t7 = () => (Ks.frame().find((l) => /^[ ›] T-7 /.test(l)) ?? '').slice(1);
const before7 = t7();
await Ks.press('1');
await Ks.press('-');
await Ks.press('2');
t('DS-163 AC9 back on the Timeline after a workers change on the queue screen', `${Ks.crumbs()} | ${Ks.tabOn()} | ${/ · 1 workers$/.test(head1())}`, 'desk-q › tidy | 2 Timeline | true');
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
t('DS-167 AC7 the ticket screen still shows the detail in full', lines(Q.ticketScreen(repoOf('skills8'), 'A-8', { width: 160 })).includes(`Parked: ${LONG_Q}`), true);

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
t('DS-179 a reason that fits is written whole', rowFor(Q.daysScreen(stuck10, 'acme__stuck10', { now: FIXED, width: 120 }), 'BLK-101').includes('Waiting on you · ~'), true);

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
    : f.some((l) => /^ {4}( {12})?TICKET +STATE +STARTS +SHIPS +TITLE$/.test(l)) ? 'days' : f.some((l) => /^ {2}(REPO {8})?EPIC +TITLE +CHILDREN +SHIPS$/.test(l) || l === 'No queued ticket here belongs to an epic.') ? 'epics' : 'none';
};
// Wide enough that every keys line is one line.
const keysLine = (s) => s.frame().at(-1);
const where = (s) => `${s.crumbs()} | ${s.tabOn()} | ${shows(s)}`;

const N1 = nav(tidyQ);
await sleep(20);
t('DS-164 the Queue shows first, its tab line under the breadcrumb', `${where(N1)} | ${N1.frame()[1].startsWith(TABS)}`, 'desk-q › tidy | 1 Queue | queue | true');
await N1.press('\t');
t('DS-164 AC1 Tab on a repo\'s Queue shows its Timeline, Timeline highlighted', `${where(N1)} | ${N1.frame()[1].startsWith(TABS)}`, 'desk-q › tidy | 2 Timeline | timeline | true');
await N1.press('\t'); await N1.press('\t'); await N1.press('\t');
t('DS-164 Tab from Epics wraps round to the Queue', where(N1), 'desk-q › tidy | 1 Queue | queue');
await N1.press('\x1b[Z');
t('DS-164 shift+Tab steps back', where(N1), 'desk-q › tidy | 4 Epics | epics');
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
await Ar.press(RIGHT); await Ar.press(RIGHT);
t('DS-182 → on the rightmost tab stays there', where(Ar), 'desk-q › tidy | 4 Epics | epics');
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
t('DS-164 AC4 the breadcrumb reads desk-q › tidy', N4.frame()[0], 'desk-q › tidy');
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
  'every queue': { yes: ['←→ or 1–4 view', 'a all repos', 'c parked dates'], no: ['esc back', 'shift+↑↓', 'z scale', '+ −'] },
  'every timeline': { yes: ['←→ or 1–4 view', 'z scale', 'c parked dates'], no: ['esc back', 'shift+↑↓', 'a all repos', '+ −'] },
  'every days': { yes: ['←→ or 1–4 view', 'c parked dates'], no: ['esc back', 'shift+↑↓', 'z scale', 'a all repos'] },
  'every epics': { yes: ['←→ or 1–4 view', 'c parked dates'], no: ['esc back', 'shift+↑↓', 'z scale', 'a all repos'] },
  'repo queue': { yes: ['←→ or 1–4 view', 'shift+↑↓ move', 't top', '+ − workers', 'esc back'], no: ['z scale', 'a all repos'] },
  'repo timeline': { yes: ['←→ or 1–4 view', 'z scale', 'esc back'], no: ['shift+↑↓', 't top', '+ −', 'a all repos'] },
  'repo days': { yes: ['←→ or 1–4 view', 'esc back'], no: ['shift+↑↓', 'z scale', '+ −', 'a all repos'] },
  'repo epics': { yes: ['←→ or 1–4 view', 'esc back'], no: ['shift+↑↓', 'z scale', '+ −', 'a all repos'] },
  ticket: { yes: ['shift+↑↓ move', 'l log', 'esc back'], no: ['←→ or 1–4 view', 'z scale', 'a all repos'] },
};
t('DS-164 AC10 each view lists only the keys it accepts', Object.entries(want10).flatMap(([v, { yes, no }]) => [
  ...yes.filter((k) => !has(views10[v] ?? '', k)).map((k) => `${v} lacks ${k}`), ...no.filter((k) => has(views10[v] ?? '', k)).map((k) => `${v} lists ${k}`)]).join(' | '), '');

const N80 = screen(tidyQ, 80, () => FIXED);
await sleep(20);
// DS-186 AC10: a keys line too wide goes on two, "move" then "act", each key bold.
// The act line is itself wider than 80, so it carries on, indented, under its label.
const k80 = N80.frame().slice(N80.frame().findIndex((l) => l.startsWith('move  ')));
t('DS-164 AC10 (DS-186 AC10) at 80 columns the Queue\'s keys go on a move line and an act line, none lost',
  `${k80[0] === 'move  ↑↓ select · enter open · ←→ or 1–4 view · esc back'} ${k80[1].startsWith('act   shift+↑↓ move · ')} ${k80.slice(2).every((l) => l.startsWith('      '))} ${k80.at(-1).endsWith('q quit')} ${k80.every((l) => l.length <= 80)}`,
  'true true true true true');
t('DS-186 AC10 each key is bold, its words plain', ['↑↓', 'enter', '←→ or 1–4', 'esc', 'shift+↑↓', 'q'].every((k) => lastFrame(N80).join('').includes(`\x1b[1m${k}\x1b[22m `)), true);
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
t('DS-166 AC4 an epic with no date gives the reason instead of a bar', `${e3.includes('No date: 1 waiting on you')} ${e3.includes('█')}`, 'true false');
const other = featTl.findIndex((l) => l === '  Other work · 2 tickets with no epic');
t('DS-166 AC5 the tickets in no epic follow under "Other work", each by title and state with its own bar',
  other > featTl.indexOf(e3) && featTl.slice(other + 1, other + 3).map((l) => /^ {4}(F-\d) title +○ ready +[ ┆]*█/.exec(l)?.[1]).sort().join(), 'F-6,F-7');
t('DS-166 AC5 none of an epic\'s tickets is a row of its own', featTl.some((l) => /F-[1-5]/.test(l)), false);

const Fa = nav({ kind: 'timeline', slug: 'acme__feat' });
await sleep(20);
const rawLine = (s, text) => s.output.buf.split('\x1b[H').at(-1).split('\r\n').find((l) => l.replace(ANSI, '').includes(text)) ?? '';
t('DS-166 AC3 a provisional epic\'s bar is amber', rawLine(Fa, 'Beats').includes('\x1b[33m█'), true);
for (let i = 0; i < 10 && !Fa.selected().includes('Smart scheduling'); i++) await Fa.press(DOWN);
await Fa.press('\r');
const kidRows = Fa.frame().filter((l) => /^[ ›] F-\d /.test(l)).map((l) => l.slice(2, 5));
t('DS-166 AC6 Enter on an epic: its Timeline, one bar per child, under its breadcrumb', `${where(Fa)} | ${kidRows.sort().join()}`, 'desk-q › feat › Smart scheduling, your day | 2 Timeline | timeline | F-1,F-2');
t('DS-166 AC6 the header names the epic\'s key and children done', Fa.frame().some((l) => l.startsWith('feat · forecast') && l.endsWith(' · E-1: 1 of 3 children done')), true);
await Fa.press('\x1b');
t('DS-166 AC7 Esc on the epic\'s Timeline: the repo\'s Timeline, the epic still selected', `${where(Fa)} | ${Fa.selected().includes('Smart scheduling')}`, 'desk-q › feat | 2 Timeline | timeline | true');
await Fa.press('4');
const epicsRows = Fa.frame().filter((l) => /^[ ›] {1,2}E-\d /.test(l));
const epicsRow = (k) => epicsRows.find((l) => l.slice(2).startsWith(k)) ?? '';
t('DS-166 AC8 4 shows the Epics view, one row per epic', `${where(Fa)} | ${epicsRows.length}`, 'desk-q › feat | 4 Epics | epics | 3');
t('DS-166 AC8 each with a bar of done, queued and not-yet-queued children', `${epicsRow('E-1').includes(`${'■'.repeat(16)}    1/3`)} ${epicsRow('E-2').includes(`${'■'.repeat(8)}${'□'.repeat(8)}    0/2`)}`, 'true true');
t('DS-166 AC8 its SHIPS and the child that sets the date', epicsRow('E-1').endsWith(`${whenAt(featF.E['E-1'].likely, FIXED).padEnd(14)}set by ${featF.E['E-1'].setBy}`), true);
t('DS-166 AC8 a provisional or undated epic says so there', `${epicsRow('E-2').endsWith('provisional: 1 not queued')} ${epicsRow('E-3').includes('No date: 1 waiting on you')}`, 'true true');
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
Fa.ui.finish(0);

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
// After LAST PASS, each count; a blocked count is dim (DS-186), so red is failed only.
t('DS-181 AC1 each non-zero count in its state\'s colour: running, ready, waiting, needs you, failed', coloured(ovRow(Ov, 'hue')).slice(1).join(' '), '32:1 34:1 33:1 35:1 31:1');
t('DS-181 AC1 (DS-186 AC4) zero counts are dim, the one non-zero count coloured',
  coloured(ovRow(Ov, 'slow'), true).slice(1, 7).join(' '), '2:0 34:4 2:0 2:0 2:0 2:0');
Ov.ui.finish(0);

const Hq = nav({ kind: 'repo', slug: 'acme__hue' });
await sleep(20);
const stateCell = (s, key) => coloured(lastFrame(s).find((l) => l.replace(ANSI, '').slice(1).includes(` ${key} `)) ?? '', true)[0] ?? '';
const keys = ['H-1', 'H-2', 'H-3', 'H-4', 'H-5', 'H-6'];
const queueCells = keys.map((k) => stateCell(Hq, k));
// DS-186 AC2: each state with its glyph, in its colour; blocked grey (DS-217 AC11), failed red.
t('DS-181 AC2 (DS-186 AC2) one repo\'s Queue shows each state cell with its glyph in its colour', queueCells.join(' '),
  '32:● running 34:○ ready 33:· waiting 35:◆ needs you 38;5;247:◌ blocked 31:✕ failed');
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
  `${selRaw.startsWith('\x1b[48;5;236m›')} ${selRaw.endsWith('\x1b[K\x1b[49m')} ${/\x1b\[(7|27|0)m/.test(selRaw)} ${coloured(selRaw).join()}`, 'true true false 34:○ ready');
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
t('DS-181 AC5 (DS-186 AC6) with NO_COLOR, no colour codes, no tint, and the selected row still in reverse video', `${/\x1b\[(3\d|4\d|48;5;\d+)m/.test(hpFrame)} ${/\x1b\[7m›/.test(hpFrame)}`, 'false true');
await Hp.press('\x1b');
t('DS-181 AC5 nor on every repo\'s Queue', `${Hp.crumbs()} ${/\x1b\[3\dm/.test(lastFrame(Hp).join('\n'))}`, 'desk-q false');
await Hp.press('2');
t('DS-181 AC5 nor on the Timeline, which is coloured without NO_COLOR', `${Hp.tabOn()} ${/\x1b\[3\dm/.test(lastFrame(Hp).join('\n'))}`, '2 Timeline false');
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
t('DS-186 AC1 on a ticket\'s page the state after the key is in its colour, with its glyph', tpLine('H-2  ').includes('\x1b[34m○ ready\x1b[39m'), true);
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
  `${/^32:● session · \d+m ago$/.test(passCell('ontime'))} ${/^33:■ stopped · 3h 2\dm$/.test(passCell('hours'))} ${/^31:■ stopped · 2d 2h$/.test(passCell('longgone'))}`, 'true true true');
// AC8: each ports overlap note's ▲ is yellow; "N tickets need you" is bold magenta.
const lpRaw = lastFrame(Lp);
const overlaps = lpRaw.filter((l) => / {2}▲ ports +\S+ \+ /.test(l.replace(ANSI, '')));
t('DS-186 AC8 each ports overlap note starts ▲, in yellow', `${overlaps.length > 0} ${overlaps.every((l) => l.includes('\x1b[33m▲ ports'))}`, 'true true');
t('DS-186 AC8 (DS-215 AC12) "N tickets need you" is bold magenta', lpRaw.some((l) => /^\x1b\[1;35m◆ \d+ tickets need you\x1b\[22;39m/.test(l)), true);
// AC4: the QUEUE DONE notes "passes stopped" and "no history" are grey.
t('DS-186 AC4 the QUEUE DONE notes passes stopped and no history are grey', `${ovRow(Lp, 'hours').includes(`${G}passes stopped`)} ${ovRow(Lp, 'ontime').includes(`${G}no history`)}`, 'true true');
Lp.ui.finish(0);

// AC9: the Timeline's legend names a swatch per state shown, each in its colour; Epics' swatches too.
const Lg = screen({ kind: 'timeline', slug: 'acme__tidy' }, 160, () => FIXED);
Lg.output.rows = 80; Lg.output.resize();
await sleep(20);
const legendRaw = lastFrame(Lg).find((l) => l.replace(ANSI, '').startsWith('█ running')) ?? '';
t('DS-186 AC9 the Timeline legend: one named swatch per state shown', legendRaw.replace(ANSI, '').trim(), '█ running   █ ready   █ blocked   █ needs you');
t('DS-186 AC9 each swatch in its state\'s colour, and no "colour shows state"',
  `${['\x1b[32m█\x1b[39m running', '\x1b[34m█\x1b[39m ready', '\x1b[38;5;247m█\x1b[39m blocked', '\x1b[35m█\x1b[39m needs you'].every((s) => legendRaw.includes(s))} ${Lg.output.buf.includes('colour shows state')}`, 'true false');
Lg.ui.finish(0);
const Le = screen({ kind: 'repo', slug: 'acme__feat' }, 160, () => FIXED);
Le.output.rows = 80; Le.output.resize();
await sleep(20);
await Le.press('4');
t('DS-186 AC9 the Epics legend\'s swatches are coloured as the bars are', lastFrame(Le).some((l) => l.startsWith('\x1b[32m■\x1b[39m done  \x1b[33m■\x1b[39m in the queue  \x1b[38;5;247m□\x1b[39m not queued yet')), true);
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
t('DS-187 AC1 the overview opens with how many need you, each repo\'s count, most first, then the blocked count',
  lines(NY.run('--plain').out)[0], '◆ 3 tickets need you │ voicepa 2 · pr-ninja 1 │ ◌ 1 blocked');
const NYs = screen({ kind: 'overview', all: false }, 400);
await sleep(20);
t('DS-187 AC1 on the screen it is the first line under the tabs', `${NYs.frame()[1].startsWith('1 Queue')} ${NYs.frame()[3].startsWith('● ')} ${NYs.frame()[3] === lines(Q.overview(Q.loadRepos(), { avail: 30 }))[0]}`, 'true true true');
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
t('DS-187 AC2 the Queue is grouped Running, Ready, Waiting, Needs you, Blocked, each group in queue order', groupsAndKeys(mixedQ),
  'Running · 1 | M-4 | Ready · 2 | M-2 | M-5 | Waiting · 1 | M-6 | Needs you · 1 | M-1 | Blocked · 1 | M-3');
const mixedHead = lines(mixedQ).find((l) => /^ +# /.test(l));
t('DS-187 AC3 at 140 columns WHAT IT NEEDS follows STATE and is at least 50 wide',
  `${mixedHead.indexOf('WHAT IT NEEDS') === mixedHead.indexOf('STATE') + 13} ${mixedHead.indexOf('STARTS') - mixedHead.indexOf('WHAT IT NEEDS') >= 50}`, 'true true');
const m5 = lines(mixedQ).find((l) => /^ +\d+ {2}M-5 /.test(l)) ?? '';
t('DS-187 AC3 and TITLE takes the rest of the width', `${m5.length} ${m5.endsWith('…')}`, '140 true');
const mixedPlain = I.run('--plain', 'mixed').out;
t('DS-187 AC9 --plain keeps the group headings and the WHAT IT NEEDS column',
  `${/^ {2}Needs you · 1$/m.test(mixedPlain)} ${/^ +# {2}TICKET +STATE +WHAT IT NEEDS +STARTS/m.test(mixedPlain)}`, 'true true');

const m2Page = lines(Q.ticketScreen(mixed(), 'M-2', { width: 120, now: FIXED, jiraUrl: 'https://acme.atlassian.net/browse/M-2' }));
const fieldsOf = (ls) => ls.map((l) => /^(Now|Ships|Based on|Holds up|Branch|Open) {2,}\S/.exec(l)?.[1]).filter(Boolean).join();
const at2 = (p) => m2Page.findIndex((l) => l.startsWith(p));
t('DS-187 AC6 a ticket\'s page: the ticket line, the title, then Now, Ships, Based on, Holds up, Branch and Open',
  `${m2Page[0].startsWith('M-2  ○ ready')} ${m2Page[1]} ${fieldsOf(m2Page)} ${at2('Now') === 3}`, 'true M-2 title Now,Ships,Based on,Holds up,Branch,Open true');
t('DS-187 AC6 Holds up names the ticket waiting on this one, and Open the keys', `${m2Page[at2('Holds up')]} | ${m2Page[at2('Open')]}`,
  'Holds up  M-6 waits for this to merge | Open      l log  ·  o Jira  acme.atlassian.net/browse/M-2');
t('DS-187 AC6 then the lane rationale, the files in scope and never-runs-with, in that order',
  `${at2('Open') < at2('Why lane A')} ${at2('Why lane A') < at2('Files in scope · 1')} ${at2('Files in scope · 1') < at2('Never runs with M-5')}`, 'true true true');
t('DS-187 AC7 a ticket nothing waits on has no Holds up line', fieldsOf(lines(Q.ticketScreen(mixed(), 'M-5', { width: 120, now: FIXED }))).includes('Holds up'), false);

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
t('DS-194 AC3 the landing ticket is in a Landing group above Waiting', lq.indexOf('  Landing · 1') >= 0 && lq.indexOf('  Landing · 1') < lq.indexOf('  Waiting · 2'), true);
t('DS-194 AC3 its state reads ◐ landing, and WHAT IT NEEDS its PR, how many checks passed and the one holding it', landRow(lq, 'LD-1'),
  `     -  LD-1      ◐ landing    ${'#164 · 1 of 2 checks passed · macOS: no runner, 14m'.padEnd(52)}${'started'.padEnd(13)}${'—'.padEnd(14)}resume from the last round`);
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
t('DS-194 AC3 the state is cyan, and AC4 a check queued 10 minutes with no runner is yellow', coloured(raw194.l).filter((c) => /landing|#164|runner/.test(c)).join(), '36:◐ landing,36:#164,33:macOS: no runner, 14m');
const e2eRunning = { name: 'e2e', status: 'in_progress', conclusion: null, started: ago194(5), runner: true };
t('DS-194 AC4 a running check reads its name and age', landRow(landQueue(landRepo([build, e2eRunning])), 'LD-1').includes('#164 · 1 of 2 checks passed · e2e running, 5m '), true);
t('DS-194 AC4 a failed check reads failed, in red', coloured((await landingRaw([build, { name: 'e2e', status: 'completed', conclusion: 'failure', started: ago194(5), completed: ago194(2), runner: true }])).l).includes('31:e2e failed'), true);
t('DS-194 AC4 every check passed reads merging, in green', coloured((await landingRaw([build])).l).includes('32:all checks passed · merging'), true);
// AC5: the header counts the landing PR, in cyan.
t('DS-194 AC5 (DS-215) the counts line counts the PRs landing and the merged tickets', lq[1], '◆ nothing needs you  ● 1 running  ◐ 1 landing  · 2 waiting │ ✓ 2 done, not shown');
t('DS-194 AC5 the landing count is cyan', coloured(raw194.head).includes('36:◐ 1 landing'), true);
// AC6: a held ticket names its landing blocker by its PR.
t('DS-194 AC6 (DS-217 AC2) the only blocker left is landing: behind its PR, merging when green, starting after it', /· waiting {4}behind #164: checks running, merges when green +after #164 /.test(landRow(lq, 'LD-2')), true);
t('DS-194 AC6 with another blocker left, both are listed and STARTS is not after the PR', `${/· waiting {4}behind #164, LD-4 /.test(landRow(lq, 'LD-3'))} ${/after #/.test(landRow(lq, 'LD-3'))}`, 'true false');
t('DS-194 AC6 the PR is cyan in the row', coloured((await landingRaw([ubuntu, macos], 'LD-2')).l).includes('36:#164'), true);
// AC7: the held ticket's page lists the landing blocker's checks, then when they were read.
const p2 = lines(Q.ticketScreen(landRepo([ubuntu, macos]), 'LD-2', { now: NOW }));
const i7 = p2.indexOf('Starts when the last of these merges:');
const lead194 = ' '.repeat(14);
t('DS-194 AC7 the landing blocker, one line per check, then when the last pass read them', p2.slice(i7 + 1, i7 + 5).join('\n'), [
  '  LD-1      ◐ landing    #164 · 1 of 2 checks passed · macOS: no runner, 14m',
  `${lead194}✓  ${'tests (ubuntu-latest)'.padEnd(26)}passed in 7m 35s`,
  `${lead194}◌  ${'tests (macos-latest)'.padEnd(26)}queued 14m, no runner yet`,
  `${lead194}checked by the last pass, 1m ago · https://github.com/acme/land/pull/164`].join('\n'));
const p2f = lines(Q.ticketScreen(landRepo([build, e2eRunning, { name: 'lint', status: 'completed', conclusion: 'failure', started: ago194(9), completed: ago194(8), runner: true }]), 'LD-2', { now: NOW }));
t('DS-194 AC7 a running check with its age, and a failed one', [`${'e2e'.padEnd(26)}running 5m`, `${'lint'.padEnd(26)}failed`].every((s) => p2f.some((l) => l.endsWith(s))), true);
landRepo([ubuntu, macos]);
const G7 = screen({ kind: 'ticket', slug: 'acme__land', key: 'LD-2' }, 140, () => NOW);
await sleep(20);
const g7line = G7.frame().find((l) => l.includes('checked by the last pass')) ?? '';
await G7.press('g');
t('DS-194 AC7 on the screen the line offers g, and g opens the PR', `${g7line.trim()} | ${G7.opened.join()}`, 'checked by the last pass, 1m ago · g open #164 on GitHub | https://github.com/acme/land/pull/164');
G7.ui.finish(0);
// AC8: with passes stopped, the landing row says when its checks were read, dimmed.
const stoppedRow = landRow(landQueue(landRepo([ubuntu, macos], { beat: 300 })), 'LD-1');
const hhmm = new Date(NOW - 60000).toTimeString().slice(0, 5);
t('DS-194 AC8 passes stopped: as of the last read, n of m checks passed', new RegExp(`◐ landing {4}as of ${hhmm}: 1 of 2 checks passed +started`).test(stoppedRow), true);
t('DS-194 AC8 and it is grey', coloured((await landingRaw([ubuntu, macos], 'LD-1', { beat: 300 })).l, true).includes(`38;5;247:as of ${hhmm}: 1 of 2 checks passed`), true);
// AC9: once the pass records the PR merged, the ticket leaves Landing and counts as merged.
const mergedQ = landQueue(landRepo([ubuntu], { ps: { ...prOpen([ubuntu]), state: 'MERGED' } }));
t('DS-194 AC9 a merged PR leaves Landing and is counted merged', `${mergedQ.some((l) => /Landing|LD-1 |landing/.test(l))} ${mergedQ[1].endsWith(' │ ✓ 3 done, not shown')}`, 'false true');
// AC10: desk-q reads only what the pass recorded: a gh on its PATH is never called.
landRepo([ubuntu, macos]);
mkdirSync(join(I.T, 'stub-gh'), { recursive: true });
writeFileSync(join(I.T, 'stub-gh', 'gh'), `#!/bin/sh\necho "$@" >> "${join(I.T, 'gh-calls')}"\n`, { mode: 0o755 });
const ghEnv = { ...I.env, PATH: `${join(I.T, 'stub-gh')}:${process.env.PATH}` };
// Each run must render its landing data, or "no gh call" would also pass on a crash.
const runs194 = [[['--plain', 'land'], '◐ landing'], [['--plain', 'land', 'show', 'LD-2'], 'checked by the last pass'], [['--plain', 'land', 'show', 'LD-1'], 'Checks on #164:'], [['--plain'], 'land']]
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
  'B-HOLD': { ...prAt(180), merge_blocked: 'merge hold: desk/bin/** (a person merges it; 1 file(s), e.g. desk/bin/pass.mjs)' }, 'W-2H': heldBy('B-HOLD'),
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
t('DS-217 AC2 behind a PR a supervisor merges: waiting until green, and STARTS after it merges', cells217('holdsup', 'W-2', 3), '· waiting | behind #177: checks running, merges when green | after #177');
t('DS-217 behind a PR that conflicts with its base: needs you, even where a supervisor merges', cells217('holdsup', 'W-2C'), '◆ needs you | #178 conflicts with its base: resolve it');
t('DS-217 behind a PR the merge driver leaves under a merge hold: needs you, even where a supervisor merges', cells217('holdsup', 'W-2H'), '◆ needs you | #180 is under a merge hold: merge it');
t('DS-217 a hold that names no blocker: needs you, since nothing releases it', cells217('holdsup', 'W-0'), '◆ needs you | held behind no recorded blocker: release it');
t('DS-217 its page says so and gives the release command', ['Held behind no recorded blocker, which nothing releases.', 'Release it, in holdsup: node ~/.claude/desk/bin/queue.mjs set W-0 state=triaged']
  .map((s) => Q.ticketScreen(repo217('holdsup'), 'W-0', { now: FIXED }).includes(s)).join(), 'true,true');
t('DS-217 AC3 behind a draft: needs you, naming the action', cells217('hold', 'W-3'), '◆ needs you | #175 is a draft: undraft and merge it');
t('DS-217 AC3 and it is counted in what needs you', lines(Q.overview(repos217, { now: FIXED, avail: 30 }))[0].includes('4 in hold'), true);
t('DS-217 AC4 behind a ready PR nothing runs to merge: needs you', cells217('hold', 'W-4'), '◆ needs you | #176 will not merge on its own: merge it');
t('DS-217 AC4 or merging is ask with no batch approval', cells217('holdask', 'W-4A'), '◆ needs you | #179 will not merge on its own: merge it');
t('DS-217 AC5 behind a blocker that needs you, failed or is parked: waiting, saying which',
  ['W-5N', 'W-5F', 'W-5P'].map((k) => cells217('hold', k)).join(' / '),
  '· waiting | behind W-3, which needs you / · waiting | behind B-RED, which failed / · waiting | behind B-PARK, which is parked');
t('DS-217 AC6 every blocker merged, with a supervisor: waiting to be released', cells217('holdsup', 'W-6'), '· waiting | released at the next pass');
t('DS-217 AC7 every blocker merged, with no merge driver or supervisor: needs you, release it', cells217('hold', 'W-7'), '◆ needs you | every blocker merged: release it');
t('DS-217 AC7 its page gives the release command the pass prints', Q.ticketScreen(repo217('hold'), 'W-7', { now: FIXED }).includes(
  'Release it, in hold: node ~/.claude/desk/bin/queue.mjs set W-7 state=triaged park=null held_by=null, then node ~/.claude/desk/bin/queue.mjs front W-7.'), true);
t('DS-217 AC8 open Jira blockers outside the batch: blocked, no start and no date, whatever its blocker does', cells217('hold', 'W-8', 4), '◌ blocked | held: 27 Jira blockers outside the batch | — | no date');
t('DS-217 AC8 once the user confirms it can start without them, outside blockers no longer block it', cells217('hold', 'W-10'), '· waiting | behind B-RUN (running, stage 4/9)');
t('DS-217 AC6 every blocker merged, a supervisor but no merge grant: nothing releases it, so it needs you', cells217('holdask', 'W-6A'), '◆ needs you | every blocker merged: release it');
t('DS-217 two tickets held behind each other both need you, and one behind them waits saying so',
  ['C-1', 'C-2', 'C-3'].map((k) => cells217('holdask', k)).join(' / '),
  '◆ needs you | C-2 is held behind this one: release one of them / ◆ needs you | C-1 is held behind this one: release one of them / · waiting | behind C-1, which needs you');
const w9 = Q.ticketScreen(repo217('hold'), 'W-9', { now: FIXED });
t('DS-217 AC9 with its batch blockers merged and one outside open, the page never says every blocker is done',
  `${/Every blocker is done/.test(w9)} ${w9.includes('Held by 1 Jira blocker outside this batch, which nothing in it releases.')}`, 'false true');
t('DS-217 AC9 no ticket page says every blocker is done', Object.keys(repo217('hold').q.tickets).filter((k) => /Every blocker is done/.test(Q.ticketScreen(repo217('hold'), k, { now: FIXED }))).join(), '');
t('DS-217 the 2026-10-24 desk-skills queue', ['DS-168', 'DS-175', 'DS-180'].map((k) => cells217('skills24', k)).join(' / '),
  '◌ blocked | held: 27 Jira blockers outside the batch / ◆ needs you | #175 is a draft: undraft and merge it / · waiting | behind DS-175, which needs you');
t('DS-217 AC10 one key line under the table names each state shown, with its meaning', queue217('hold').filter((l) => l.startsWith('key ')).join('\n'),
  'key   ● running │ ◐ landing: a PR open and merging │ · waiting: moves by itself │ ◌ blocked: held outside this batch │ ◆ needs you: nothing moves until you act │ ✕ failed: requeue or drop it');
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
  ['\x1b[38;5;247mkey \x1b[39m', '\x1b[33m· waiting\x1b[39m\x1b[38;5;247m: moves by itself\x1b[39m', '\x1b[38;5;247m◌ blocked\x1b[39m\x1b[38;5;247m: held outside this batch\x1b[39m',
    '\x1b[35m◆ needs you\x1b[39m\x1b[38;5;247m: nothing moves until you act\x1b[39m'].filter((s) => !hkKey.includes(s)).join(' | '), '');
const ONE_DARK = { 1: '#e6e9ef', 31: '#f07c84', 32: '#98c379', 33: '#e5c07b', 34: '#61afef', 35: '#d08be3', 36: '#56b6c2', 39: '#abb2bf' };
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const grey256 = (n) => (n >= 232 && n <= 255 ? [0, 0, 0].map(() => 8 + 10 * (n - 232)) : null);
const lum = (c) => c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const fgOf = (code) => (/^38;5;\d+$/.test(code) ? grey256(Number(code.split(';')[2])) : ONE_DARK[code] ? rgb(ONE_DARK[code]) : null);
const hkStart = hkFrame.findIndex((l) => /^\s+# {2}TICKET/.test(l.replace(ANSI, '')));
const hkLines = hkFrame.slice(hkStart, hkFrame.indexOf(hkKey) + 1);
const selBg = grey256(Number(/\x1b\[48;5;(\d+)m/.exec(hkLines.join(''))?.[1]));
const codes = new Set(['39', ...hkLines.flatMap((l) => [...l.matchAll(/\x1b\[([0-9;]+)m/g)].map((m) => m[1])).filter((c) => !['22', '39', '49', '27'].includes(c) && !c.startsWith('48;'))]);
const window217 = rgb('#282c34');
t('DS-217 AC11 every text colour in the rows and key line is at least 4.5:1 on the window and the selected row',
  `${selBg != null && codes.has('38;5;247')} ${[...codes].filter((c) => { const f = fgOf(c); return !f || contrast(f, window217) < 4.5 || contrast(f, selBg) < 4.5; }).join()}`, 'true ');

// ---- DS-215: who runs each batch, in LAST PASS and the repo header, and the band and notes that warn
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
t('DS-215 AC1 a handed-over batch with its agent loaded, on time: ● supervisor in green', `${cell215('sup')} ${/^ {2}sup +● supervisor · 2m ago {2}/.test(rowOf(ov215, 'sup') ?? '')}`, '32:● supervisor · 2m ago true');
t('DS-215 AC2 a session-run batch set to session or unset: ● session in green, and no note names it',
  `${cell215('sess')} ${notes215.some((l) => /▲ sess\b/.test(l))}`, '32:● session · 1m ago false');
t('DS-215 AC3 a session-run batch set to the supervisor: ▲ session in amber, and one amber note', `${cell215('over')} ${notes215.filter((l) => l.includes('▲ over')).join('|')}`,
  `33:▲ session · 3m ago ${notes215.find((l) => l.includes('▲ over'))?.startsWith('note') ? 'note' : '    '}  ▲ over          set to the supervisor, but a session runs this batch. Its next batch hands over.`);
const bandAt = lines(ov215).indexOf(' ✕ off: the supervisor is off, so no passes run. Run: desk-q off supervisor on');
const needsAt = lines(ov215).findIndex((l) => l.startsWith('◆ '));
t('DS-215 AC4 a handed-over batch whose agent is not loaded: ✕ supervisor off in red at once, and the red band above the header names the fix',
  `${cell215('off')} ${bandAt >= 0 && bandAt < needsAt} ${lastFrame(S215).some((l) => l.includes('\x1b[1;7;31m ✕ off: the supervisor is off, so no passes run. Run: desk-q off supervisor on \x1b[22;27;39m'))}`, '31:✕ supervisor off · 3m true true');
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
t('DS-215 AC7 the note is magenta, its command bold', lastFrame(Sy).some((l) => l.includes('\x1b[35m◆ needs you    ') && l.includes('\x1b[1m/desk-needs-you\x1b[22m')), true);
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
  [`\x1b[32m● supervisor\x1b[39m  ${G}last pass \x1b[39m2m ago`, `${G} │ \x1b[39m${G}workers \x1b[39m\x1b[1m1 of 2\x1b[22m${G} · cap \x1b[39m\x1b[1m3\x1b[22m`].filter((s) => !rsHead.includes(s)).join(' | '), '');
const s215 = lastFrame(S215);
t('DS-215 AC12 home: the band, then the needs-you count with each repo\'s, then workers, machine cap, room and free memory',
  `${needsAt === lines(ov215).filter((l) => l.startsWith(' ✕ ')).length} ${/^◆ \d+ tickets need you │ \S+ \d+( · \S+ \d+)*( │ ◌ \d+ blocked)?$/.test(lines(ov215)[needsAt])} ${/^● \d+ workers? running │ machine cap 10 · room for \d+ more │ 30\.0 GiB free$/.test(lines(ov215)[needsAt + 1])}`, 'true true true');
t('DS-215 AC12 labels grey, values bright, segments split by a grey │',
  `${s215.some((l) => l.startsWith('\x1b[1;35m◆ ') && /\x1b\[38;5;247m │ \x1b\[39m\x1b\[38;5;247m\S+ \x1b\[39m\x1b\[1m\d+\x1b\[22m/.test(l))} ${s215.some((l) => l.includes(`${G}machine cap \x1b[39m\x1b[1m10\x1b[22m${G} · \x1b[39m${G}room for \x1b[39m\x1b[1m`) && /\x1b\[1m\d+\.\d GiB\x1b\[22m\x1b\[38;5;247m free\x1b\[39m$/.test(l))}`, 'true true');
S215.ui.finish(0);
Rs.ui.finish(0);
// AC13: no label is drawn dim, and every text colour desk-q draws is 4.5:1 or more on the One Dark
// window, the selected row and black. The band's text is the window's colour on red.
const sgrFg = (code) => (code === Q.TEXT_SGR.band ? null : fgOf(code.replace(/^1;/, '')));
const dark215 = Object.entries(Q.TEXT_SGR).filter(([k]) => !['select', 'band'].includes(k));
const sel215 = grey256(Number(Q.TEXT_SGR.select.split(';')[2]));
t('DS-215 AC13 no screen draws dim (SGR 2)', [S215, Rs].some((s) => s.output.buf.includes('\x1b[2m')), false);
t('DS-215 AC13 every text colour is 4.5:1 or more on the window, the selected row and black, the band\'s text on red too',
  `${dark215.filter(([, c]) => { const f = sgrFg(c); return !f || [window217, sel215, [0, 0, 0]].some((b) => contrast(f, b) < 4.5); }).map(([k]) => k).join()}|${contrast(window217, rgb(ONE_DARK[31])) >= 4.5}`, '|true');
process.env.COLORFGBG = '0;15';
const QL = await import(`${pathToFileURL(BIN).href}?light`);
delete process.env.COLORFGBG;
const white = [255, 255, 255];
t('DS-215 AC14 a light theme draws labels a darker grey, 4.5:1 or more on its background and its selected row',
  `${QL.TEXT_SGR.grey} ${contrast(fgOf(QL.TEXT_SGR.grey), white) >= 4.5} ${contrast(fgOf(QL.TEXT_SGR.grey), grey256(Number(QL.TEXT_SGR.select.split(';')[2]))) >= 4.5} ${QL.lightTheme('15;0')} ${QL.lightTheme(undefined)}`,
  '38;5;240 true true false false');

console.log(fails ? `${fails} FAILED` : 'all desk-q checks passed');
process.exit(fails ? 1 : 0);
