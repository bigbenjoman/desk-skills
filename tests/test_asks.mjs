// suite: asks (what a session handed the person; an ask whose tickets are all finished waits on nothing)
// layer: L1
// covers: desk/bin/asks.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAsk, readAsks, pruneAsks } from '../desk/bin/asks.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const dir = mkdtempSync(join(tmpdir(), 'asks-'));
try {
  addAsk(dir, 'admit DS-1 DS-2 once the person says admit', Date.now(), { until: ['DS-1', 'DS-2'] });
  addAsk(dir, 'admit DS-1 and DS-3 once the person says admit', Date.now(), { until: ['DS-1', 'DS-3'] });
  addAsk(dir, 'admit DS-1 and X-9 once the person says admit', Date.now(), { until: ['DS-1', 'X-9'] });
  addAsk(dir, 'run the backfill once DS-1 merges');
  const tickets = { 'DS-1': 'merged', 'DS-2': 'done', 'DS-3': 'running' };
  const opts = { known: (k) => k in tickets, finished: (k) => ['merged', 'done'].includes(tickets[k]) };
  const gone = pruneAsks(dir, opts);
  t('#1341 an ask recorded as a wait on tickets, every one merged or done, is dropped, naming them', JSON.stringify(gone), JSON.stringify([{ id: 1, text: 'admit DS-1 DS-2 once the person says admit', keys: ['DS-1', 'DS-2'] }]));
  t('#1341 a wait on a ticket still open, or one the queue does not know, stays', JSON.stringify(readAsks(dir).filter((a) => a.until).map((a) => a.id)), '[2,3]');
  t('#1341 a step the person owes that only names a finished ticket (no --until) is never dropped', readAsks(dir).some((a) => a.text === 'run the backfill once DS-1 merges'), true);
  t('#1341 with nothing stale, nothing is dropped', pruneAsks(dir, opts).length, 0);
  const again = addAsk(dir, 'run the backfill once DS-1 merges', Date.now(), { until: ['DS-3'] });
  t('#1341 asked again with --until, the ask keeps the new list and says so', `${again.added} ${again.until?.join()} ${readAsks(dir).find((a) => a.id === again.id)?.until?.join()}`, 'false DS-3 DS-3');
  const bare = addAsk(dir, 'run the backfill once DS-1 merges');
  t('#1341 asked again with no --until, the kept list stands', `${bare.until?.join()} ${readAsks(dir).find((a) => a.id === bare.id)?.until?.join()}`, 'DS-3 DS-3');
} finally { rmSync(dir, { recursive: true, force: true }); }

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
