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
  for (const [name, r] of Object.entries(repos)) {
    if (!r) continue;
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
  const run = (...args) => { const r = spawnSync('node', [BIN, ...args], { encoding: 'utf8', env, cwd: T }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  return { T, env, run };
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
t('AC4 header', /workers 2 running · 5 allowed by live batches, of 10 for this machine/.test(head) && /\d+\.\d GiB free/.test(head), true);
// ---- AC5: overlapping worker port blocks named with the shared range
t('AC5 port overlap line', lines(ov.out).some((l) => l.startsWith('ports overlap: desk-skills + pranicuk share 3502–3503')), true);
// ---- AC15: voicepa's counts, last pass and workers
const vp = (rowOf(ov.out, 'voicepa') ?? '').trim().split(/\s+/);
t('AC15 voicepa row: live 4m, run 2, ready 0, wait 1, stuck 0, needs 0, failed 0, done 3, workers 3', vp.slice(1, 11).join(' '), 'live 4m 2 0 1 0 0 0 3 3');

// ---- AC7: a held ticket whose only unmerged blocker runs is waiting, behind that blocker only
const repo = W.run('--plain', 'voicepa');
const vpl3 = lines(repo.out).find((l) => /VPL-3/.test(l)) ?? '';
t('AC7 waiting, behind the running blocker, not the merged one', /waiting\s+behind VPL-1\s/.test(vpl3) && !/VPL-0/.test(vpl3), true);
// ---- AC8: prefix, spawn order, position, state, detail, title, done count
const pre = W.run('--plain', 'vo');
t('AC8 a prefix resolves', pre.code === 0 && pre.out === repo.out, true);
const tickets = lines(pre.out).filter((l) => /^\s+\*?\d+\s{2}/.test(l));
t('AC8 unfinished tickets in spawn order with positions', tickets.map((l) => l.trim().split(/\s+/).slice(0, 2).join(' ')).join(), '1 VPL-1,2 VPL-2,3 VPL-3');
t('AC8 state, detail and triage title', /running\s+stage 4\/9\s+Running-late sheet$/.test(tickets[0]), true);
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
  'VPL-1': { summary: 'Running-late sheet' }, 'VPL-3': { summary: 'Long gaps' }, 'VPL-4': { summary: LONG },
} } });
Object.assign(process.env, I.env);
const Q = await import(BIN);
const { PassThrough } = await import('node:stream');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function screen(start) {
  const input = new PassThrough();
  const modes = [];
  Object.assign(input, { isTTY: true, setRawMode: (b) => modes.push(b) });
  const output = { buf: '', columns: 80, rows: 50, write(s) { this.buf += s; }, on() {}, removeListener() {} };
  const codes = [], opened = [];
  const ui = Q.interactive({ input, output, start, exit: (c) => codes.push(c), opener: (u) => opened.push(u), refreshMs: start?.refreshMs ?? 600000 });
  const frame = () => output.buf.split('\x1b[H').at(-1).replace(ANSI, '').split('\r\n');
  return {
    input, output, modes, codes, opened, ui, frame,
    // A lone Esc is only told apart from an escape sequence after readline's 500ms wait.
    press: async (s) => { input.write(s); await sleep(s === '\x1b' ? 600 : 20); },
    crumbs: () => frame()[0],
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
await A.press('l');
const logged = A.frame().filter((l) => /^line \d+$/.test(l));
t('AC14 l shows the last 40 lines of the log', `${logged.length} ${logged[0]} ${logged.at(-1)}`, '40 line 11 line 50');
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

console.log(fails ? `${fails} FAILED` : 'all desk-q checks passed');
process.exit(fails ? 1 : 0);
