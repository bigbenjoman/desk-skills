// suite: desk-q plain output (overview, one repo, one ticket)
// desk-q against fixture repo configs, queues, heartbeats and triage records under a throwaway HOME,
// DESK_HOME and DESK_CONFIG_ROOT. Nothing touches your real ~/.claude, ~/.config/desk or state.
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'desk-q.mjs');
const NOW = Date.now();
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();

// One fixture world: seven repos by default, or `repos` to override, each { port, conc, queue, beat, triage }.
function world(overrides = {}) {
  const T = mkdtempSync(join(tmpdir(), 'desk-q-'));
  const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'), PATH: process.env.PATH };
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
  return { T, env, run };
}

// One repo's config, queue, heartbeats and triage records, written over whatever was there.
function put(T, env, name, r) {
  const slug = `acme__${name}`;
  mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
    `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`${r.port}\` |\n| Autopilot worker concurrency | \`2 / 3\` | \`${r.conc}\` |\n` +
    (r.jira ? `\n## 4. Tracker\n\n| Field | Value |\n|---|---|\n| Jira site | \`${r.jira}\` |\n` : ''));
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
    writeFileSync(join(state, 'triage', `${k}.json`), JSON.stringify({ ticket: k, ...v }));
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
t('a fresh heartbeat for another queue file leaves a quiet batch quiet', /^\s+pr-ninja\s+2h 0m ago/.test(rowOf(ov.out, 'pr-ninja') ?? ''), true);
// ---- AC2: a quiet batch whose unfinished tickets all wait is not listed
t('AC2 quiet batch with only waiting tickets is hidden', rowOf(ov.out, 'pranicuk'), undefined);
// ---- AC3: --all lists every set-up repo, no-batch ones marked
const all = W.run('--plain', '--all');
t('AC3 every set-up repo listed', ['voicepa', 'desk-skills', 'pr-ninja', 'pranicuk', 'forewatt', 'yield-index', 'gygg-platform'].every((n) => rowOf(all.out, n)), true);
t('AC3 no-batch repos marked', /no batch/.test(rowOf(all.out, 'forewatt') ?? ''), true);
// ---- AC4: header gives running workers, live batches' allowance against the machine cap, free memory
const head = lines(ov.out)[0];
t('AC4 header', /workers 2 running · 5 allowed by live batches · machine 10 · \d+\.\d GiB free · room for \d+$/.test(head), true);
// ---- AC5: overlapping worker port blocks named with the shared range
t('AC5 port overlap line', lines(ov.out).some((l) => l.startsWith('ports overlap: desk-skills + pranicuk share 3502–3503')), true);
// ---- AC15: voicepa's counts, last pass and workers (and QUEUE DONE, with no history)
const vp = (rowOf(ov.out, 'voicepa') ?? '').trim().split(/\s+/);
t('AC15 voicepa row: live 4m, run 2, ready 0, wait 1, stuck 0, needs 0, failed 0, done 3, workers 3', vp.slice(1, 13).join(' '), 'live 4m 2 0 1 0 0 0 3 no history 3');

// ---- AC7: a held ticket whose only unmerged blocker runs is waiting, behind that blocker only
const repo = W.run('--plain', 'voicepa');
const vpl3 = lines(repo.out).find((l) => /VPL-3/.test(l)) ?? '';
t('AC7 waiting, behind the running blocker, not the merged one', /waiting\s+behind VPL-1\s/.test(vpl3) && !/VPL-0/.test(vpl3), true);
// ---- AC8: prefix, spawn order, position, state, detail, title, done count
const pre = W.run('--plain', 'vo');
t('AC8 a prefix resolves', pre.code === 0 && pre.out === repo.out, true);
const tickets = lines(pre.out).filter((l) => /^\s+\*?\d+\s{2}/.test(l));
t('AC8 unfinished tickets in spawn order with positions', tickets.map((l) => l.trim().split(/\s+/).slice(0, 2).join(' ')).join(), '1 VPL-1,2 VPL-2,3 VPL-3');
t('AC8 state, detail and triage title', /running\s+stage 4\/9\s+—\s+—\s+Running-late sheet$/.test(tickets[0]), true);
t('AC8 done count', /3 done, not shown/.test(pre.out), true);
// ---- AC9: an ambiguous prefix refuses, naming both, with no table
const amb = W.run('--plain', 'pr');
t('AC9 ambiguous prefix exits non-zero', amb.code !== 0, true);
t('AC9 names both repos, prints no table', /pr-ninja/.test(amb.err) && /pranicuk/.test(amb.err) && amb.out === '', true);
// ---- AC10: no match refuses, listing what is set up
const zz = W.run('--plain', 'zz');
t('AC10 no match exits non-zero listing the repos', zz.code !== 0 && /forewatt/.test(zz.err) && /voicepa/.test(zz.err), true);
// ---- AC11: show on a held ticket
const show = W.run('--plain', 'voicepa', 'show', 'VPL-3');
const want = ['Long gaps between bookings', 'waiting', 'Starts when the last of these merges:\n  VPL-1     running', 'Parked: held by orchestrator', 'lane A', 'Why lane A:', 'mechanical once the gap rule is read', 'Files in scope (2):', 'src/gaps.ts', 'Branch: feat/VPL-3-gaps', `Log: ${join(W.env.HOME, '.desk-autopilot', 'acme__voicepa', 'logs', 'VPL-3.log')}`];
t('AC11 show prints every field', want.filter((w) => !show.out.includes(w)).join(' | '), '');
t('AC11 show leaves out the merged blocker', lines(show.out).some((l) => /^\s+VPL-0\b/.test(l)), false);
t('show of a key not in the queue refuses', W.run('--plain', 'voicepa', 'show', 'VPL-77').code !== 0, true);
// ---- AC12: no arguments, output not a terminal: the overview, exit 0
const bare = W.run();
t('AC12 piped with no arguments prints the overview', bare.code === 0 && /^desk-q · /.test(bare.out) && rowOf(bare.out, 'voicepa') != null, true);

// ---- AC6: a held ticket whose blocker is parked for its own reason is stuck
const S = world({ voicepa: { port: 3100, conc: '3 / 5', beat: 4, queue: { batch: 'vp', concurrency: 3, tickets: {
  'VPL-5': { state: 'parked', park: { question: 'out of scope' } },
  'VPL-6': { state: 'parked', held_by: 'VPL-5', park: { question: 'held by orchestrator: blocked by VPL-5' } },
} } } });
t('AC6 held behind a ticket parked for its own reason reads stuck', /VPL-6\s+stuck\s+behind VPL-5/.test(S.run('--plain', 'voicepa').out), true);

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
  && toppedLines[1] === '' && /^voicepa · batch vp/.test(toppedLines[2]) && toppedLines.slice(1).some((l) => /^\s+\*1\s+VPL-6\s/.test(l)), true);
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
t('a failed ticket shows no position', /^\s+-\s+VPL-2\s+failed/.test(lines(past.out).find((l) => /VPL-2/.test(l)) ?? ''), true);

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
const Q = await import(BIN);
const { PassThrough } = await import('node:stream');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function screen(start, columns = 80) {
  const input = new PassThrough();
  const modes = [];
  Object.assign(input, { isTTY: true, setRawMode: (b) => modes.push(b) });
  const output = { buf: '', columns, rows: 24, write(s) { this.buf += s; }, on() {}, removeListener() {} };
  const codes = [], opened = [];
  const ui = Q.interactive({ input, output, start, exit: (c) => codes.push(c), opener: (u) => opened.push(u), refreshMs: start?.refreshMs ?? 600000 });
  const frame = () => output.buf.split('\x1b[H').at(-1).replace(ANSI, '').split('\r\n');
  return {
    input, output, modes, codes, opened, ui, frame,
    // A lone Esc is only told apart from an escape sequence after readline's 500ms wait.
    press: async (s) => { input.write(s); await sleep(s === '\x1b' ? 600 : 20); },
    // The crumbs, less the parked note that follows them.
    crumbs: () => frame()[0].split('    ')[0],
    selected: () => frame().find((l) => l.startsWith('›')) ?? '',
  };
}
const DOWN = '\x1b[B';

const A = screen();
await sleep(20);
t('AC1 no arguments: the all-repos screen, first row selected', A.crumbs() === 'desk-q' && /^› desk-skills\s/.test(A.selected()), true);
await A.press(DOWN);
await A.press('\r');
t('AC2 Enter on voicepa opens its queue', A.crumbs(), 'desk-q › voicepa');
t('AC12 no row on an 80-column repo screen is wider than 80', A.frame().filter((l) => l.length > 80).length, 0);
t('AC13 a title that does not fit ends in an ellipsis', /VPL-4 .*…$/.test(A.frame().find((l) => /VPL-4/.test(l)) ?? ''), true);
await A.press(DOWN); await A.press(DOWN); await A.press('\r');
t('AC3 down twice and Enter opens the third ticket', A.crumbs(), 'desk-q › voicepa › VPL-3');
t('AC4 the blocker is a selectable row', /^›\s+VPL-1\s+running/.test(A.selected()), true);
await A.press('\r');
t('AC4 Enter on the blocker opens its ticket screen', A.crumbs(), 'desk-q › voicepa › VPL-1');
await A.press('\x1b'); await A.press('\x1b');
await A.press(DOWN); await A.press('\r');
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
const logLine = () => A.frame().some((l) => l.startsWith('Log: '));
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
t('AC6 within 2 seconds the change shows, selection still on the same key', C.frame().some((l) => /^\s+1\s+VPL-7\s/.test(l)) && /^›\s+4\s+VPL-3\s/.test(C.selected()), true);
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
for (let i = 0; i < 4; i++) await D.press(DOWN);
await D.press(SHIFT_UP);
t('DS-116 AC1 shift+↑ on position 5 moves it to 4, marked placed', /^›\s+\*4\s+VPL-5\s/.test(D.selected()) && unfinishedKeys(nowQ()).indexOf('VPL-5') === 3 && nowQ().tickets['VPL-5'].placed === true, true);
t('DS-116 AC1 the status line confirms the move', D.frame().some((l) => l.startsWith('VPL-5 → position 4 of 6, placed by you.')), true);
await D.press('\x1b[A'); await D.press('\x1b[A');
await D.press('t');
t('DS-116 AC2 t puts the waiting ticket first', unfinishedKeys(nowQ())[0], 'VPL-2');
t('DS-116 AC2 and says it still waits on its blockers', D.frame().some((l) => /^VPL-2 → position 1 of 6\b.*still waits on VPL-1\b/.test(l)), true);
await D.press(DOWN);
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
await E1.press(DOWN); await E1.press(DOWN); await E1.press('\r');
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
t('DS-116 AC11 the header gives running, allowed, machine, free memory and the room left',
  lines(room)[0].endsWith(' · workers 4 running · 9 allowed by live batches · machine 10 · 36.6 GiB free · room for 6'), true);
t('DS-116 AC11 the room is the smaller of the machine cap and free memory', Q.headroom({ running: 4, cap: 10, avail: 18, gate: 8, perWorker: 3 }), 3);
t('DS-116 AC12 a batch with more ready than free slots says so', rowOf(room, 'pr-ninja')?.endsWith('2 (cap 4) · 1 ready with no free slot'), true);
t('DS-116 AC12 a batch whose ready tickets fit says nothing extra', rowOf(room, 'voicepa')?.endsWith('5 (cap 5)'), true);

console.log(fails ? `${fails} FAILED` : 'all desk-q checks passed');
process.exit(fails ? 1 : 0);
