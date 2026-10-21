// suite: worker cost (tokens, cost and wall time per worker in the batch report)
// worker-cost.mjs on stub stream-json logs in a scratch state directory: a finished worker, a requeued
// one whose rounds add up, one with no result event, and a ticket no worker ran. The idle pass that
// prints the table runs in test_pass.sh.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logUsage, ticketCost, batchCost, costTable, wallTime } from '../desk/bin/worker-cost.mjs';
import { parseWorkerLocation } from '../desk/bin/desk-env.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const S = mkdtempSync(join(tmpdir(), 'desk-cost-'));
mkdirSync(join(S, 'logs'));
const say = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const result = (cost, ms, input, output, cacheW = 0, cacheR = 0) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, duration_ms: ms, num_turns: 3, total_cost_usd: cost,
  usage: { input_tokens: input, cache_creation_input_tokens: cacheW, cache_read_input_tokens: cacheR, output_tokens: output },
});
const log = (name, ...lines) => writeFileSync(join(S, 'logs', name), `${lines.join('\n')}\n`);

log('T-1.log', say('AUTOPILOT_STAGE: 4/9 verify'), result(1.5, 125000, 1000, 2000, 300, 40000));
log('T-2.log', say('AUTOPILOT_DONE: pr=2 jira=none'), result(0.25, 3600000, 10, 20));
log('T-2.log.round1', say('AUTOPILOT_PARK: which?'), result(0.75, 60000, 5, 7));
log('T-3.log', say('AUTOPILOT_STAGE: 3/9 implement'));
log('T-4.log.round1', result(9, 1000, 1, 1));   // T-4's current log is missing: still counted from its round
log('T-30.log', result(100, 1, 1, 1));          // another ticket whose key starts with T-3

t('a result event: input counts cache reads and writes', JSON.stringify(logUsage(`${result(1.5, 125000, 1000, 2000, 300, 40000)}\n`)),
  '{"input":41300,"output":2000,"cost":1.5,"ms":125000}');
t('no result event is null, not zeros', logUsage(`${say('hi')}\nnot json\n`), null);
t('a result event with no usage counts no tokens', JSON.stringify(logUsage('{"type":"result","total_cost_usd":0.1,"duration_ms":5}')),
  '{"input":0,"output":0,"cost":0.1,"ms":5}');

t('rounds add up', JSON.stringify(ticketCost(S, 'T-2')), '{"key":"T-2","runs":2,"unknown":0,"usage":{"input":15,"output":27,"cost":1,"ms":3660000}}');
t('a log with no result event is unknown', JSON.stringify(ticketCost(S, 'T-3')), '{"key":"T-3","runs":1,"unknown":1,"usage":null}');
t('a ticket no worker ran has no row', ticketCost(S, 'T-9'), null);
t('a ticket whose only log was moved aside still has its round', ticketCost(S, 'T-4')?.usage?.cost, 9);
t('wall time under an hour', wallTime(125000), '2m 05s');
t('wall time over an hour', wallTime(3660000), '1h 01m');

const rows = batchCost(S, ['T-1', 'T-2', 'T-3', 'T-9']);
t('the batch rows are the workers that ran, in queue order', rows.map((r) => r.key).join(' '), 'T-1 T-2 T-3');
const table = costTable(rows).split('\n');
console.log(table.join('\n'));
const cols = (line) => line.trim().split(/\s{2,}/);
t('AC3 a header names each figure', cols(table[1]).join('|'), 'worker|runs|input tokens|output tokens|cost|wall time');
t('AC3 a worker row', cols(table[2]).join('|'), 'T-1|1|41,300|2,000|$1.50|2m 05s');
t('AC3 a requeued worker row sums its rounds', cols(table[3]).join('|'), 'T-2|2|15|27|$1.00|1h 01m');
t('AC4 a worker with no result event reads unknown, not zero', cols(table[4]).join('|'), 'T-3|1|unknown|unknown|unknown|unknown|(1 of 1 run(s) with no result event in the log)');
t('AC3 the total row adds the known workers and names what it left out', cols(table[5]).join('|'), 'total|4|41,315|2,027|$2.50|1h 03m|(1 unknown worker(s) not counted)');
t('a table of known workers has no left-out note', costTable(batchCost(S, ['T-1'])).split('\n').at(-1).includes('not counted'), false);

const loc = (v) => { try { return JSON.stringify(parseWorkerLocation(v)); } catch (e) { return `refused: ${/Worker location/.test(e.message) ? 'names the row' : e.message}`; } };
t('local runs locally', loc('local'), '{"asked":"local","runs":"local"}');
t('cloud is kept as asked and still runs locally', loc('Cloud'), '{"asked":"cloud","runs":"local"}');
t('anything else is refused', loc('remote'), 'refused: names the row');

rmSync(S, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'worker cost: all checks passed');
process.exit(fails ? 1 : 0);
