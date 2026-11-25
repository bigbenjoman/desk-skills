// suite: ask tokens (what each step of an ask cost: the parked round, the decider's share or the person's session, and the round that acted)
// layer: L2
// covers: desk/bin/ask-ledger.mjs desk/bin/ticket-ledger.mjs desk/bin/worker-cost.mjs desk/bin/cache-report.mjs
// measure in process against fixture batches: worker logs (gzipped rounds, a resumed round, a killed
// worker), decider records, and session transcripts under two logins' projects folders, each beside a
// fixture queue whose ledger names its batch. Scratch state only.
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { scratch } from './scratch.mjs';

const T = scratch('desk-asktokens-');
for (const k of Object.keys(process.env)) if (/^(DESK_|AUTOPILOT_)/.test(k) || k === 'CLAUDE_CODE_SESSION_ID') delete process.env[k];
Object.assign(process.env, { HOME: join(T, 'home'), DESK_HOME: join(T, 'desk'), DESK_CONFIG_ROOT: join(T, 'cfg') });
mkdirSync(join(T, 'home'), { recursive: true });

const A = await import('../desk/bin/ask-ledger.mjs');
// measure as each check calls it: one that is missing measures nothing, so every check below fails on
// its own rather than the suite stopping at the first.
const measure = A.measure ?? (() => []);
const { fold, ledgerPaths } = await import('../desk/bin/ticket-ledger.mjs');
const { queueDifference } = await import('../desk/bin/queue-ledger.mjs');

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = JSON.stringify;
const write = (f, text) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };
const jsonl = (events) => events.map((e) => `${JSON.stringify(e)}\n`).join('');
const at = (hm) => `2026-11-20T${hm}:00.000Z`;
const setTime = (f, iso) => utimesSync(f, new Date(iso), new Date(iso));

// A stream-json assistant message: its id, what it says or calls, and its usage.
const msg = (id, { text = null, tool = null, input = 0, write: w = 0, read = 0, output = 0, sub = false, model = 'claude-opus-5-5' } = {}) => ({
  type: 'assistant', ...(sub ? { parent_tool_use_id: 'toolu_x' } : {}),
  message: { id, model, content: [...(text ? [{ type: 'text', text }] : []), ...(tool ? [tool] : [])],
    usage: { input_tokens: input, cache_creation_input_tokens: w, cache_read_input_tokens: read, output_tokens: output } },
});
const spawnLine = (iso, stage = '0') => ({ type: 'desk_spawn', session: 's', stage, model: 'default', effort: 'default', at: iso });
const result = { type: 'result', subtype: 'success', total_cost_usd: 1, modelUsage: {} };
const parkWrite = (key) => ({ type: 'tool_use', name: 'Write', input: { file_path: `/x/state/parks/${key}.json`, content: '{"question":"which?"}' } });
// Opus at list price per million: input 4, 1-hour write 8, 5-minute write 5, read 0.2, output 20.
const usd = ({ input = 0, w1h = 0, w5m = 0, read = 0, output = 0 }) => Math.round(((input * 4 + w1h * 8 + w5m * 5 + read * 0.2 + output * 20) / 1e6) * 1e6) / 1e6;

// A batch: its queue (ledger beside it, the batch named as its first queue write would), its state folder.
let n = 0;
const batch = (tickets) => {
  const dir = join(T, `b${++n}`);
  const queue = join(dir, 'q', 'queue.json');
  write(queue, JSON.stringify({ version: 1, batch: 'b', tickets }));
  queueDifference(queue, { seed: true });
  return { queue, state: join(dir, 'state'), ledger: dirname(queue) };
};
const parked = (key, since) => ({ key, lane: 'A', state: 'parked', park: { kind: 'question', question: 'which?', since } });
const asks = (b) => Object.fromEntries(A.readAsks(fold(b.ledger)).map((a) => [a.key, a.tokens]));
const tokensLines = (b) => readFileSync(ledgerPaths(b.ledger).events, 'utf8').split('\n').filter((l) => l.includes('"ask_tokens"')).length;
// Ask steps written as the call sites write them, with the ledger lever on.
const rec = (queue, steps, o = {}) => A.recordAsks(queue, steps, { on: true, ...o });
const fig = (x) => (x ? [x.input, x.output, x.cache_read, x.cache_write, x.usd, x.complete] : [null]);

// ---- raise: the parked round from its park write to its end, main session only, gzipped or not -----
{
  const since = at('10:30');
  const b = batch({ 'R-1': parked('R-1', since), 'K-1': parked('K-1', since) });
  // R-1's first round parked on an earlier ask; its second, gzipped, parked on this one; a third, later
  // than this park, is not its round.
  const r1 = join(b.state, 'logs', 'R-1.log.round1.gz');
  write(r1, gzipSync(jsonl([spawnLine(at('08:00')), msg('a1', { tool: parkWrite('R-1'), input: 9, output: 9 }), result])));
  setTime(r1, at('08:30'));
  const r2 = join(b.state, 'logs', 'R-1.log.round2.gz');
  write(r2, gzipSync(jsonl([spawnLine(at('09:00')),
    msg('b1', { text: 'working', input: 500, write: 500, read: 5000, output: 50 }),
    msg('b2', { tool: parkWrite('R-1'), input: 100, write: 200, read: 3000, output: 40 }),
    msg('b2', { tool: parkWrite('R-1'), input: 100, write: 200, read: 3000, output: 60 }),
    msg('b3', { text: 'AUTOPILOT_PARK: which?', input: 10, read: 1000, output: 20 }),
    msg('b4', { text: 'a subagent', input: 7777, output: 7777, sub: true }),
    result])));
  setTime(r2, at('10:20'));
  const r3 = join(b.state, 'logs', 'R-1.log');
  write(r3, jsonl([spawnLine(at('11:00')), msg('c1', { tool: parkWrite('R-1'), input: 1, output: 1 })]));
  setTime(r3, at('11:30'));
  // K-1's worker was killed after writing its park: no result event.
  const k = join(b.state, 'logs', 'K-1.log.round1.gz');
  write(k, gzipSync(jsonl([spawnLine(at('09:00')), msg('k1', { text: 'AUTOPILOT_PARK: which?', input: 30, write: 40, read: 50, output: 60 })])));
  setTime(k, at('10:00'));
  rec(b.queue, [{ step: 'raised', key: 'R-1', since, kind: 'question' }, { step: 'raised', key: 'K-1', since, kind: 'question' }]);
  const lines = measure(b.state, { queue: b.queue, on: true, dirs: [] });
  const got = asks(b);
  t('the parked round is the gzipped one written by the park\'s since, from its park write to its end, each message once with its largest output, no subagent; nothing to report',
    j([...fig(got['R-1']?.['raise:log']), lines]), j([110, 80, 4000, 200, usd({ input: 110, w1h: 200, read: 4000, output: 80 }), true, []]));
  t('a killed worker\'s raise is what it read, complete false, never 0', j(fig(got['K-1']?.['raise:log'])), j([30, 60, 50, 40, usd({ input: 30, w1h: 40, read: 50, output: 60 }), false]));
  const b2 = batch({ 'N-1': parked('N-1', since) });
  rec(b2.queue, [{ step: 'raised', key: 'N-1', since, kind: 'question' }]);
  measure(b2.state, { queue: b2.queue, on: true, dirs: [] });
  t('a park no worker log wrote (the pass\'s own) is complete false with no figures, never 0', j(fig(asks(b2)['N-1']?.['raise:log'])), j([null, null, null, null, null, false]));
  t('with the lever off, measure writes nothing', (() => { const b3 = batch({ 'O-1': parked('O-1', since) }); rec(b3.queue, [{ step: 'raised', key: 'O-1', since, kind: 'question' }]);
    return `${j(measure(b3.state, { queue: b3.queue, on: false, dirs: [] }))} ${j(asks(b3)['O-1'])} ${tokensLines(b) > 0}`; })(), '[] {} true');
}

// ---- act: the round the acting spawn started, to its first stage marker; fresh against resumed -------
{
  const b = batch({ 'F-1': parked('F-1', at('08:00')), 'S-1': parked('S-1', at('08:00')), 'X-1': parked('X-1', at('08:00')), 'W-1': parked('W-1', at('08:00')) });
  // F-1 starts fresh: its prompt is written to the cache. S-1 resumes at its stage: read from a warm cache.
  write(join(b.state, 'logs', 'F-1.log'), jsonl([spawnLine(at('12:00')),
    msg('f1', { text: 'reading the ticket', input: 100, write: 30000, output: 200 }),
    msg('f2', { text: 'AUTOPILOT_STAGE: 1/9 plan', input: 5, read: 30000, output: 10 }), msg('f3', { input: 1, read: 1, output: 1 })]));
  write(join(b.state, 'logs', 'S-1.log'), jsonl([spawnLine(at('12:00'), '4'),
    msg('s1', { text: 'resuming', input: 50, write: 500, read: 29500, output: 100 }),
    { type: 'assistant', message: { id: 's2', model: 'claude-opus-5-5', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo "AUTOPILOT_STAGE: 4/9 verify"; npm test' } }], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 1, output_tokens: 1 } } }]));
  // X-1 was killed before any marker, and its round moved aside by the next spawn.
  const x = join(b.state, 'logs', 'X-1.log.round1.gz');
  write(x, gzipSync(jsonl([spawnLine(at('12:00')), msg('x1', { text: 'starting', input: 70, write: 80, output: 90 })])));
  write(join(b.state, 'logs', 'X-1.log'), jsonl([spawnLine(at('13:00'))]));
  // W-1 is still before its first marker: nothing to write yet.
  write(join(b.state, 'logs', 'W-1.log'), jsonl([spawnLine(at('12:00')), msg('w1', { text: 'starting', input: 1, output: 1 })]));
  for (const key of ['F-1', 'S-1', 'X-1', 'W-1']) rec(b.queue, [{ step: 'acted', key, since: at('08:00'), round: 1 }], { now: new Date(at('12:01')) });
  measure(b.state, { queue: b.queue, on: true, dirs: [] });
  const got = asks(b);
  t('a fresh round\'s act: its start to its first marker, the cache write apart from the read', j(fig(got['F-1']?.['act:log'])), j([100, 200, 0, 30000, usd({ input: 100, w1h: 30000, output: 200 }), true]));
  t('a resumed round\'s act reads a warm cache, to a stage echoed by a command', j(fig(got['S-1']?.['act:log'])), j([50, 100, 29500, 500, usd({ input: 50, w1h: 500, read: 29500, output: 100 }), true]));
  t('a round killed before its first marker is what it read, complete false, never 0', j(fig(got['X-1']?.['act:log'])), j([70, 90, 0, 80, usd({ input: 70, w1h: 80, output: 90 }), false]));
  t('a round before its first marker is not written yet, where one past it is', `${!!got['F-1']?.['act:log']} ${got['W-1']?.['act:log']}`, 'true undefined');
  // The next pass: W-1 has reached its marker, and nothing measured already is written again.
  const before = tokensLines(b);
  write(join(b.state, 'logs', 'W-1.log'), jsonl([spawnLine(at('12:00')), msg('w1', { text: 'starting', input: 1, output: 1 }), msg('w2', { text: 'AUTOPILOT_STAGE: 1/9', input: 1, output: 1 })]));
  measure(b.state, { queue: b.queue, on: true, dirs: [] });
  measure(b.state, { queue: b.queue, on: true, dirs: [] });
  t('across passes each step is written once: W-1 once it can be read, the rest not again', `${before} ${tokensLines(b)} ${j(fig(asks(b)['W-1']?.['act:log']))}`, `3 4 ${j([1, 1, 0, 0, usd({ input: 1, output: 1 }), true])}`);
}

// ---- present: the decider's share, the person's session, a shell ---------------------------------
{
  const b = batch({ 'D-1': parked('D-1', at('08:00')), 'D-2': parked('D-2', at('08:00')), 'P-1': parked('P-1', at('08:00')), 'P-2': parked('P-2', at('09:00')), 'H-1': parked('H-1', at('08:00')), 'D-3': parked('D-3', at('08:00')) });
  // One decider session listed D-1, D-2 and a waiting line: three items, so each park's share is a third.
  write(join(b.state, 'decider', 'run-1.prompt.md'), 'Items:\n- id `park-1` · D-1 · parked: a?\n- id `park-2` · D-2 · parked: b?\n- id `wait-3` · BASE GATE · batch: c\n');
  write(join(b.state, 'decider', 'run-1.json'), `${JSON.stringify({ type: 'result', total_cost_usd: 0.5, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 300, outputTokens: 600, cacheReadInputTokens: 9000, cacheCreationInputTokens: 3000 } } })}\n`);
  // D-3's decider is still running: its output has no result yet.
  write(join(b.state, 'decider', 'run-2.prompt.md'), '- id `park-9` · D-3 · parked: d?\n');
  write(join(b.state, 'decider', 'run-2.json'), '');
  // The person's session sess-a answered P-1 at 10:00 and P-2 at 11:00; its transcript is under the
  // second login. Its requests before 10:00 are P-1's, those after it to 11:00 P-2's, the one after 11:00 neither's.
  const login1 = join(T, 'login1', 'projects'), login2 = join(T, 'login2', 'projects');
  write(join(login1, '-home-x-other', 'sess-z.jsonl'), jsonl([{ ...msg('z1', { input: 99999 }), timestamp: at('10:30') }]));
  const req = (id, hm, u) => ({ ...msg(id, u), requestId: `req-${id}`, timestamp: at(hm) });
  write(join(login2, '-home-x-repo', 'sess-a.jsonl'), jsonl([
    req('p1', '09:50', { input: 10, write: 1000, read: 0, output: 20 }),
    req('p2', '10:20', { input: 3, read: 1000, output: 5 }), req('p2', '10:20', { input: 3, read: 1000, output: 9 }),
    req('p3', '10:59', { input: 2, read: 1500, output: 4 }),
    req('p4', '11:30', { input: 50000, output: 50000 }),
  ]));
  write(join(login2, '-home-x-repo', 'sess-a', 'subagents', 'agent-1.jsonl'), jsonl([{ ...req('q1', '10:40', { input: 1, read: 100, output: 1 }), isSidechain: true }]));
  rec(b.queue, [
    { step: 'presented', key: 'D-1', since: at('08:00'), via: 'decider', ref: 'run-1' },
    { step: 'presented', key: 'D-2', since: at('08:00'), via: 'decider', ref: 'run-1' },
    { step: 'presented', key: 'D-3', since: at('08:00'), via: 'decider', ref: 'run-2' },
    { step: 'presented', key: 'P-1', since: at('08:00'), via: 'digest', ref: '/page.md' },
    { step: 'answered', key: 'P-1', since: at('08:00'), by: 'person', session: 'sess-a', at: at('10:00') },
    { step: 'answered', key: 'P-2', since: at('09:00'), by: 'person', session: 'sess-a', at: at('11:00') },
    { step: 'answered', key: 'H-1', since: at('08:00'), by: 'person', session: null, at: at('10:00') },
  ]);
  measure(b.state, { queue: b.queue, on: true, dirs: [login1, login2], now: new Date(at('11:05')) });
  const got = asks(b);
  const share = [100, 200, 3000, 1000];
  t('the decider\'s session over the items its prompt listed: a third each, in list-price dollars', j(fig(got['D-1']?.['present:decider'])),
    j([...share, Math.round(((300 * 2 + 3000 * 2.5 + 9000 * 0.1 + 600 * 10) / 1e6 / 3) * 1e6) / 1e6, true]));
  t('the same share for the other park it listed', `${!!got['D-2']?.['present:decider']} ${j(fig(got['D-2']?.['present:decider'])) === j(fig(got['D-1']?.['present:decider']))}`, 'true true');
  t('a decider still running is not measured yet, where one that ended is', `${!!got['D-1']?.['present:decider']} ${got['D-3']?.['present:decider']}`, 'true undefined');
  t('the person\'s session, found under the second login, up to the first answer it gave', j([...fig(got['P-1']?.['present:session']), got['P-1']?.['present:session']?.approx]),
    j([10, 20, 0, 1000, usd({ input: 10, w1h: 1000, output: 20 }), true, true]));
  t('the next answer in it takes the requests between the two answers, its subagents\' too, each once', j([...fig(got['P-2']?.['present:session']), got['P-2']?.['present:session']?.approx]),
    j([6, 14, 2600, 0, usd({ input: 6, read: 2600, output: 14 }), true, true]));
  t('a digest presentation costs no tokens, so nothing is written for it', Object.keys(got['P-1'] ?? {}).sort().join(), 'present:session');
  t('an answer with no session is a shell\'s: 0 tokens, complete', j(fig(got['H-1']?.['present:shell'])), j([0, 0, 0, 0, 0, true]));
  const gone = batch({ 'G-1': parked('G-1', at('08:00')) });
  rec(gone.queue, [{ step: 'answered', key: 'G-1', since: at('08:00'), by: 'person', session: 'sess-gone', at: at('10:00') }]);
  measure(gone.state, { queue: gone.queue, on: true, dirs: [login1, login2] });
  t('a session whose transcript is under no login is complete false with no figures', j(fig(asks(gone)['G-1']?.['present:session'])), j([null, null, null, null, null, false]));
  // Past the decider's time, a session that left no result is complete false.
  measure(b.state, { queue: b.queue, on: true, dirs: [login1, login2], now: new Date(Date.now() + 16 * 60 * 1000) });
  t('a decider past its time with no result is complete false, never 0', j(fig(asks(b)['D-3']?.['present:decider'])), j([null, null, null, null, null, false]));
}

// ---- a park the pass made, in a round that wrote none, takes no earlier round's park ------------------
{
  const since = at('10:05');
  const b = batch({ 'M-1': parked('M-1', since) });
  const old = join(b.state, 'logs', 'M-1.log.round1.gz');
  write(old, gzipSync(jsonl([spawnLine(at('07:00')), msg('o1', { tool: parkWrite('M-1'), input: 5, output: 5 }), result])));
  setTime(old, at('08:00'));
  const cur = join(b.state, 'logs', 'M-1.log');
  write(cur, jsonl([spawnLine(at('09:00')), msg('m1', { text: 'working', input: 40, output: 40 })]));
  setTime(cur, at('10:00'));
  rec(b.queue, [{ step: 'raised', key: 'M-1', since, kind: 'stopped' }]);
  measure(b.state, { queue: b.queue, on: true, dirs: [] });
  t('a park the pass made, its round writing none, is complete false with no figures, not an earlier round\'s park', j(fig(asks(b)['M-1']?.['raise:log'])), j([null, null, null, null, null, false]));
}

// ---- a round started after the park (a requeue's respawn in the same pass) is not the parked round ----
{
  const since = at('10:05');
  const b = batch({ 'Q-1': parked('Q-1', since) });
  const r1 = join(b.state, 'logs', 'Q-1.log.round1.gz');
  write(r1, gzipSync(jsonl([spawnLine(at('09:00')), msg('q1', { tool: parkWrite('Q-1'), input: 5, output: 5 }), result])));
  setTime(r1, at('10:00'));
  const cur = join(b.state, 'logs', 'Q-1.log');
  write(cur, jsonl([spawnLine(at('10:08')), msg('q2', { text: 'starting again', input: 40, output: 40 })]));
  setTime(cur, at('10:09'));
  rec(b.queue, [{ step: 'raised', key: 'Q-1', since, kind: 'question' }]);
  measure(b.state, { queue: b.queue, on: true, dirs: [], now: new Date(at('10:09')) });
  t('a respawn started after the park is passed over for the round that parked', j(fig(asks(b)['Q-1']?.['raise:log'])), j([5, 5, 0, 0, usd({ input: 5, output: 5 }), true]));
}

// ---- an act with no start to read: a cloud session at once, a local one once it is past finding -----
{
  const b = batch({ 'C-1': { ...parked('C-1', at('08:00')), location: 'cloud' }, 'L-1': parked('L-1', at('08:00')), 'Y-1': parked('Y-1', at('08:00')) });
  const now = new Date(at('12:05'));
  rec(b.queue, [{ step: 'acted', key: 'C-1', since: at('08:00'), round: 1 }, { step: 'acted', key: 'L-1', since: at('08:00'), round: 1 }], { now: new Date(at('11:00')) });
  rec(b.queue, [{ step: 'acted', key: 'Y-1', since: at('08:00'), round: 1 }], { now: new Date(at('12:00')) });
  measure(b.state, { queue: b.queue, on: true, dirs: [], now });
  const got = asks(b);
  t('a cloud act, which writes no log here, is settled at once as complete false with no figures', j(fig(got['C-1']?.['act:log'])), j([null, null, null, null, null, false]));
  t('a local act with no start within the slack, past it, is settled so too; one still within it waits', `${j(fig(got['L-1']?.['act:log']))} ${got['Y-1']?.['act:log']}`, `${j([null, null, null, null, null, false])} undefined`);
  // Settled, the cloud act is not read again: a log written for it since changes nothing.
  const before = tokensLines(b);
  write(join(b.state, 'logs', 'C-1.log'), jsonl([spawnLine(at('11:00')), msg('c9', { text: 'AUTOPILOT_STAGE: 1/9', input: 9, output: 9 })]));
  measure(b.state, { queue: b.queue, on: true, dirs: [], now });
  t('a settled act is not measured again', `${before} ${tokensLines(b)} ${j(fig(asks(b)['C-1']?.['act:log']))}`, `2 2 ${j([null, null, null, null, null, false])}`);
}

// ---- a session's previous answer may be in another batch of the repo --------------------------------
{
  const repo = join(T, 'repo-two');
  const standing = join(repo, 'queue.json'), named = join(repo, 'batches', 'B-2', 'queue.json');
  write(standing, JSON.stringify({ version: 1, batch: 's', tickets: { 'A-1': parked('A-1', at('08:00')) } }));
  write(named, JSON.stringify({ version: 1, batch: 'B-2', tickets: { 'B-1': parked('B-1', at('08:00')) } }));
  for (const q of [standing, named]) queueDifference(q, { seed: true });
  const login = join(T, 'login3', 'projects');
  write(join(login, '-home-x-repo', 'sess-b.jsonl'), jsonl([
    { ...msg('r1', { input: 100, output: 100 }), requestId: 'req-r1', timestamp: at('09:50') },
    { ...msg('r2', { input: 7, output: 3 }), requestId: 'req-r2', timestamp: at('10:30') },
  ]));
  rec(standing, [{ step: 'answered', key: 'A-1', since: at('08:00'), by: 'person', session: 'sess-b', at: at('10:00') }]);
  rec(named, [{ step: 'answered', key: 'B-1', since: at('08:00'), by: 'person', session: 'sess-b', at: at('11:00') }]);
  measure(join(repo, 'batches', 'B-2', 'state'), { queue: named, on: true, dirs: [login] });
  const b1 = A.readAsks(fold(repo)).find((a) => a.key === 'B-1')?.tokens?.['present:session'];
  t('a batch\'s answer in a session takes the requests after that session\'s answer in another batch, not before it', j(fig(b1)), j([7, 3, 0, 0, usd({ input: 7, output: 3 }), true]));
}

// ---- measure never throws: a queue it cannot place is a line ---------------------------------------
{
  let threw = null, out;
  try { out = measure(join(T, 'state-none'), { queue: null, on: true, dirs: [] }); } catch (e) { threw = e.message; }
  t('a measure that cannot place its ledger says so and does not throw', `${threw} ${out?.length === 1 && out[0].startsWith('ask ledger: tokens not measured (')}`, 'null true');
}

console.log(fails ? `${fails} failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
