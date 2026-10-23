// suite: worker cost (tokens, cost and wall time per worker in the batch report)
// worker-cost.mjs on stub stream-json logs in a scratch state directory: a finished worker, one woken
// again after its turn ended, a requeued one whose rounds add up, one with no result event, a round
// left by an earlier batch, and a ticket no worker ran; and per-stage tokens from logs with
// stage markers, tokens before the first marker, two rounds and no usage; and preflights beside the
// runs, with a round moved aside compressed. The idle pass that prints the table runs in test_pass.sh.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { logUsage, ticketCost, batchCost, costTable, wallTime, preflightLine } from '../desk/bin/worker-cost.mjs';
import { parseWorkerLocation } from '../desk/bin/desk-env.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const S = mkdtempSync(join(tmpdir(), 'desk-cost-'));
mkdirSync(join(S, 'logs'));
const say = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
// A result event as claude -p writes it: cost and modelUsage are the session's running totals,
// duration_ms and usage are this turn's.
const result = ({ cost, ms, input = 0, output = 0, cacheW = 0, cacheR = 0, models = true, turnOut = 1 }) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, duration_ms: ms, num_turns: 3, total_cost_usd: cost,
  usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: turnOut },
  ...(models ? { modelUsage: { 'claude-opus-5-5': { inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheR, cacheCreationInputTokens: cacheW, costUSD: cost } } } : {}),
});
const log = (name, ...lines) => writeFileSync(join(S, 'logs', name), `${lines.join('\n')}\n`);
const tk = (key, added_at) => ({ key, added_at });

log('T-1.log', say('AUTOPILOT_STAGE: 4/9 verify'), result({ cost: 1.5, ms: 125000, input: 1000, output: 2000, cacheW: 300, cacheR: 40000 }));
log('T-2.log', say('AUTOPILOT_DONE: pr=2 jira=none'), result({ cost: 0.25, ms: 3600000, input: 10, output: 20 }));
log('T-2.log.round1', say('AUTOPILOT_PARK: which?'), result({ cost: 0.75, ms: 60000, input: 5, output: 7 }));
log('T-3.log', say('AUTOPILOT_STAGE: 3/9 implement'));
log('T-4.log.round1', result({ cost: 9, ms: 1000, input: 1, output: 1 }));  // T-4's current log is missing
log('T-30.log', result({ cost: 100, ms: 1, input: 1, output: 1 }));       // a key that starts with T-3
// T-5: one process woken twice after its turn ended, so three result events with running totals.
log('T-5.log', result({ cost: 2, ms: 60000, input: 100, output: 10 }), say('woken'),
  result({ cost: 3, ms: 30000, input: 150, output: 15 }), result({ cost: 4, ms: 30000, input: 200, output: 20 }));
// T-6: this batch's round, and a round an earlier batch left behind, last written before T-6 joined.
log('T-6.log', result({ cost: 1, ms: 1000, input: 1, output: 1 }));
log('T-6.log.round1', say('killed'));
utimesSync(join(S, 'logs', 'T-6.log.round1'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
const joined = '2026-06-01T00:00:00Z';

t('a result event: tokens from modelUsage, input counting cache reads and writes',
  JSON.stringify(logUsage(`${result({ cost: 1.5, ms: 125000, input: 1000, output: 2000, cacheW: 300, cacheR: 40000 })}\n`)),
  '{"input":41300,"output":2000,"cost":1.5,"ms":125000}');
t('no modelUsage falls back to usage', JSON.stringify(logUsage(`${result({ cost: 0.1, ms: 5, models: false, turnOut: 7 })}\n`)),
  '{"input":1,"output":7,"cost":0.1,"ms":5}');
t('no result event is null, not zeros', logUsage(`${say('hi')}\nnot json\n`), null);
t('several result events in one process: cost and tokens are the last running total, time adds up',
  JSON.stringify(ticketCost(S, tk('T-5')).usage), '{"input":200,"output":20,"cost":4,"ms":120000}');

const costOf = (k, since) => { const c = ticketCost(S, tk(k, since)); return c && JSON.stringify({ key: c.key, runs: c.runs, unknown: c.unknown, usage: c.usage }); };
t('rounds add up', costOf('T-2'), '{"key":"T-2","runs":2,"unknown":0,"usage":{"input":15,"output":27,"cost":1,"ms":3660000}}');
t('a log with no result event is unknown', costOf('T-3'), '{"key":"T-3","runs":1,"unknown":1,"usage":null}');
t('a ticket no worker ran has no row', ticketCost(S, tk('T-9')), null);
t('a ticket whose only log was moved aside still has its round', ticketCost(S, tk('T-4'))?.usage?.cost, 9);
t('a round an earlier batch left is not counted', costOf('T-6', joined), '{"key":"T-6","runs":1,"unknown":0,"usage":{"input":1,"output":1,"cost":1,"ms":1000}}');
t('with no added_at every round counts', ticketCost(S, tk('T-6'))?.runs, 2);
t('wall time under an hour', wallTime(125000), '2m 05s');
t('wall time over an hour', wallTime(3660000), '1h 01m');

const rows = batchCost(S, ['T-1', 'T-2', 'T-3', 'T-9'].map((k) => tk(k)));
t('the batch rows are the workers that ran, in queue order', rows.map((r) => r.key).join(' '), 'T-1 T-2 T-3');
const table = costTable(rows).split('\n');
console.log(table.join('\n'));
const cols = (line) => line.trim().split(/\s{2,}/);
const row = (lines, key) => cols(lines.find((l) => l.startsWith(`  ${key} `)) ?? '').join('|');
t('AC3 a header names each figure', cols(table[1]).join('|'), 'worker|runs|input tokens|output tokens|cost|preflight|wall time|first-turn input');
t('AC3 a worker row', row(table, 'T-1'), 'T-1|1|41,300|2,000|$1.50|none|2m 05s|unknown');
t('AC3 a requeued worker row sums its rounds', row(table, 'T-2'), 'T-2|2|15|27|$1.00|none|1h 01m|unknown');
t('AC4 a worker with no result event reads unknown, not zero', row(table, 'T-3'), 'T-3|1|unknown|unknown|unknown|none|unknown|unknown|(1 of 1 run(s) with no result event in the log)');
t('AC3 the total row adds the known workers and names what it left out', row(table, 'total'), 'total|4|41,315|2,027|$2.50|none|1h 03m|unknown|(first-turn input leaves out 3 worker(s) with no usage; 1 unknown worker(s) not counted)');
t('a table of known workers has no left-out note', costTable(batchCost(S, [tk('T-1')])).split('\n').at(-1).includes('not counted'), false);

// DS-158: preflights, written into the log of the run they came before, and rounds moved aside
// gzipped. P-1's earlier round is compressed and its preflight reported no result; P-2's earlier
// round holds only a preflight, whose spawn was refused, so no worker ran in it.
log('P-1.log', preflightLine({ usd: 0.3, turns: 5 }).trim(), say('AUTOPILOT_DONE: pr=3 jira=none'), result({ cost: 1, ms: 1000, input: 10, output: 1 }));
writeFileSync(join(S, 'logs', 'P-1.log.round1.gz'), gzipSync(`${preflightLine({ usd: null, turns: null })}${result({ cost: 2, ms: 2000, input: 20, output: 2 })}\n`));
log('P-2.log.round1', preflightLine({ usd: 0.1, turns: 2 }).trim());
log('P-2.log', preflightLine({ usd: 0.2, turns: 4 }).trim(), result({ cost: 1, ms: 1000, input: 1, output: 1 }));
const preOf = (k) => { const c = ticketCost(S, tk(k)); return JSON.stringify({ runs: c.runs, unknown: c.unknown, cost: c.usage?.cost, preflight: c.preflight }); };
t('DS-158 AC6 a compressed round is read like any other', preOf('P-1'), '{"runs":2,"unknown":0,"cost":3,"preflight":{"n":2,"cost":0.3,"unknown":1}}');
t('DS-158 a round holding only a preflight is not a run, but its cost counts', preOf('P-2'), '{"runs":1,"unknown":0,"cost":1,"preflight":{"n":2,"cost":0.30000000000000004,"unknown":0}}');
const pTable = costTable(batchCost(S, [tk('P-1'), tk('P-2')])).split('\n');
console.log(pTable.join('\n'));
t('DS-158 AC2 a worker\'s cost includes its preflights, shown apart, an unknown one named', row(pTable, 'P-1'), 'P-1|2|30|3|$3.30|$0.30 + 1 unknown|0m 03s|unknown');
t('DS-158 AC2 a worker whose preflights all reported', row(pTable, 'P-2'), 'P-2|1|1|1|$1.30|$0.30|0m 01s|unknown');
t('DS-158 AC2 the total adds them', row(pTable, 'total').split('|').slice(0, 6).join('|'), 'total|3|31|4|$4.60|$0.60 + 1 unknown');
t('DS-158 AC3 a preflight with no result is unknown, not zero', costTable([{ key: 'X', runs: 1, unknown: 0, usage: { input: 0, output: 0, cost: 0, ms: 0 }, preflight: { n: 1, cost: 0, unknown: 1 }, first: null, stages: null }]).split('\n').find((l) => l.startsWith('  X ')).includes(' unknown '), true);

// Tokens per stage. One model call as a worker's log holds it: an assistant event per content
// block, each repeating the message's id and usage, whose output_tokens is an early snapshot; then,
// for the worker's own calls, a message_delta stream event carrying the final output. Subagents'
// calls have no message_delta.
let seq = 0;
const blockOf = (b) => (b === 'think' ? { type: 'thinking', thinking: '…' }
  : b.startsWith('$ ') ? { type: 'tool_use', name: 'Bash', input: { command: b.slice(2) } } : { type: 'text', text: b });
const call = ({ id = `m${++seq}`, blocks = ['$ ls'], input = 0, cacheW = 0, cacheR = 0, snap = 1, final = null, parent = null, usage = true }) => {
  const u = { input_tokens: input, cache_creation_input_tokens: cacheW, cache_read_input_tokens: cacheR };
  const lines = blocks.map((b) => JSON.stringify({
    type: 'assistant', parent_tool_use_id: parent,
    message: { id, content: [blockOf(b)], ...(usage ? { usage: { ...u, output_tokens: snap } } : {}) },
  }));
  if (final != null) lines.push(JSON.stringify({ type: 'stream_event', api_message_id: id, parent_tool_use_id: parent, event: { type: 'message_delta', usage: { ...u, output_tokens: final } } }));
  return lines.join('\n');
};
const done = result({ cost: 1, ms: 1000, input: 1, output: 1 });
// S-1: start-up work, then two stages, one printed and one echoed, and a subagent's call in the second.
log('S-1.log',
  call({ blocks: ['think', '$ desk-env where'], input: 2, cacheW: 30000, cacheR: 20000, snap: 6, final: 127 }),
  call({ blocks: ['AUTOPILOT_STAGE: 0/9 intake'], input: 1, cacheR: 50000, snap: 3, final: 10 }),
  call({ blocks: ['$ git log'], input: 1, cacheR: 51000, snap: 3, final: 5 }),
  call({ blocks: ['$ echo "AUTOPILOT_STAGE: 4/9 verify"; bash tests/run.sh'], input: 1, cacheW: 1000, cacheR: 52000, snap: 4, final: 20 }),
  call({ blocks: ['reading'], parent: 'toolu_1', input: 7000, snap: 300 }),
  done);
// S-2: two rounds. The earlier round reached 2/9 and 3/9; the current one starts again, picks up
// at 3/9 and goes on, so only the earlier round puts 2/9 before 3/9.
log('S-2.log.round1', call({ input: 100, final: 1 }), call({ blocks: ['- `AUTOPILOT_STAGE: 2/9 plan`'], input: 150, final: 1 }),
  call({ blocks: ['AUTOPILOT_STAGE: 3/9 implement'], input: 200, final: 2 }), done);
log('S-2.log', call({ input: 400, final: 4 }), call({ blocks: ['AUTOPILOT_STAGE: 3/9 implement'], input: 800, final: 8 }),
  call({ blocks: ['AUTOPILOT_STAGE: 4/9 verify'], input: 1600, final: 16 }), done);
// S-3: a finished run whose assistant events carry no usage.
log('S-3.log', call({ blocks: ['AUTOPILOT_STAGE: 0/9 intake'], usage: false }), done);
const stages = (k) => ticketCost(S, tk(k)).stages?.map((s) => `${s.name}=${s.input}/${s.output}`).join(' ');

t('DS-152 AC1 the first turn is the first call\'s input: fresh, cache writes and cache reads', ticketCost(S, tk('S-1')).first, 50002);
t('DS-152 AC2 each stage holds the tokens from its marker to the next, a call counted once, output from its message_delta (a subagent\'s from its snapshot)',
  stages('S-1'), 'start-up=50002/127 0/9 intake=101002/15 4/9 verify=60001/320');
t('DS-152 AC3 tokens before the first marker are a start-up stage', ticketCost(S, tk('S-1')).stages[0].name, 'start-up');
t('DS-152 AC4 two rounds add up, a stage both reached once, in the order the rounds ran',
  stages('S-2'), 'start-up=500/5 2/9 plan=150/1 3/9 implement=1000/10 4/9 verify=1600/16');
t('DS-152 AC4 two rounds: first-turn input adds each round\'s start', ticketCost(S, tk('S-2')).first, 500);
t('DS-152 AC5 a log with no usage figures is unknown, not zero', JSON.stringify([ticketCost(S, tk('S-3')).first, ticketCost(S, tk('S-3')).stages]), '[null,null]');

const sTable = costTable(batchCost(S, ['S-1', 'S-2', 'S-3'].map((k) => tk(k)))).split('\n');
console.log(sTable.join('\n'));
const under = (key) => { const i = sTable.findIndex((l) => l.startsWith(`  ${key} `)); const out = []; for (let j = i + 1; sTable[j]?.startsWith('      '); j++) out.push(sTable[j].trim().replace(/\s+/g, ' ')); return out.join(' | '); };
t('DS-152 AC1 a worker row shows its first-turn input', row(sTable, 'S-1').split('|').at(-1), '50,002');
t('DS-152 AC2 a per-stage line for each stage, under the worker\'s row', under('S-1'), 'start-up 50,002 in 127 out | 0/9 intake 101,002 in 15 out | 4/9 verify 60,001 in 320 out');
t('DS-152 AC4 a two-round worker says its rounds', row(sTable, 'S-2').split('|')[1], '2');
t('DS-152 AC5 a worker with no usage reads unknown in its first-turn cell and its stages', `${row(sTable, 'S-3').split('|').at(-1)} / ${under('S-3')}`, 'unknown / stages: unknown (no usage in the log)');
t('DS-152 the total first-turn input adds the known workers and names what it left out', row(sTable, 'total'), 'total|4|4|4|$4.00|none|0m 04s|50,502|(first-turn input leaves out 1 worker(s) with no usage)');

const loc = (v) => { try { return parseWorkerLocation(v); } catch (e) { return `refused: ${/Worker location/.test(e.message) ? 'names the row' : e.message}`; } };
t('local reads as local', loc('local'), 'local');
t('cloud reads as cloud, in any case', loc('Cloud'), 'cloud');
t('anything else is refused', loc('remote'), 'refused: names the row');

rmSync(S, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'worker cost: all checks passed');
process.exit(fails ? 1 : 0);
