// suite: worker cost (tokens, cost and wall time per worker in the batch report)
// worker-cost.mjs on stub stream-json logs in a scratch state directory: a finished worker, one woken
// again after its turn ended, a requeued one whose rounds add up, one with no result event, a round
// left by an earlier batch, and a ticket no worker ran. The idle pass that prints the table runs in
// test_pass.sh.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logUsage, ticketCost, batchCost, costTable, wallTime } from '../desk/bin/worker-cost.mjs';
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

t('rounds add up', JSON.stringify(ticketCost(S, tk('T-2'))), '{"key":"T-2","runs":2,"unknown":0,"usage":{"input":15,"output":27,"cost":1,"ms":3660000}}');
t('a log with no result event is unknown', JSON.stringify(ticketCost(S, tk('T-3'))), '{"key":"T-3","runs":1,"unknown":1,"usage":null}');
t('a ticket no worker ran has no row', ticketCost(S, tk('T-9')), null);
t('a ticket whose only log was moved aside still has its round', ticketCost(S, tk('T-4'))?.usage?.cost, 9);
t('a round an earlier batch left is not counted', JSON.stringify(ticketCost(S, tk('T-6', joined))), '{"key":"T-6","runs":1,"unknown":0,"usage":{"input":1,"output":1,"cost":1,"ms":1000}}');
t('with no added_at every round counts', ticketCost(S, tk('T-6'))?.runs, 2);
t('wall time under an hour', wallTime(125000), '2m 05s');
t('wall time over an hour', wallTime(3660000), '1h 01m');

const rows = batchCost(S, ['T-1', 'T-2', 'T-3', 'T-9'].map((k) => tk(k)));
t('the batch rows are the workers that ran, in queue order', rows.map((r) => r.key).join(' '), 'T-1 T-2 T-3');
const table = costTable(rows).split('\n');
console.log(table.join('\n'));
const cols = (line) => line.trim().split(/\s{2,}/);
t('AC3 a header names each figure', cols(table[1]).join('|'), 'worker|runs|input tokens|output tokens|cost|wall time');
t('AC3 a worker row', cols(table[2]).join('|'), 'T-1|1|41,300|2,000|$1.50|2m 05s');
t('AC3 a requeued worker row sums its rounds', cols(table[3]).join('|'), 'T-2|2|15|27|$1.00|1h 01m');
t('AC4 a worker with no result event reads unknown, not zero', cols(table[4]).join('|'), 'T-3|1|unknown|unknown|unknown|unknown|(1 of 1 run(s) with no result event in the log)');
t('AC3 the total row adds the known workers and names what it left out', cols(table[5]).join('|'), 'total|4|41,315|2,027|$2.50|1h 03m|(1 unknown worker(s) not counted)');
t('a table of known workers has no left-out note', costTable(batchCost(S, [tk('T-1')])).split('\n').at(-1).includes('not counted'), false);

const loc = (v) => { try { return parseWorkerLocation(v); } catch (e) { return `refused: ${/Worker location/.test(e.message) ? 'names the row' : e.message}`; } };
t('local reads as local', loc('local'), 'local');
t('cloud reads as cloud, in any case', loc('Cloud'), 'cloud');
t('anything else is refused', loc('remote'), 'refused: names the row');

rmSync(S, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'worker cost: all checks passed');
process.exit(fails ? 1 : 0);
