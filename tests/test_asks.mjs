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
  addAsk(dir, 'admit DS-1 DS-2 once the person says admit');
  addAsk(dir, 'admit DS-1 and DS-3 once the person says admit');
  addAsk(dir, 'admit DS-1 and X-9 once the person says admit');
  addAsk(dir, 'file the follow-up for the e2e config');
  const tickets = { 'DS-1': 'merged', 'DS-2': 'done', 'DS-3': 'running' };
  const gone = pruneAsks(dir, { known: (k) => k in tickets, finished: (k) => ['merged', 'done'].includes(tickets[k]) });
  t('#1341 an ask whose every ticket is merged or done is dropped, naming its tickets', JSON.stringify(gone), JSON.stringify([{ id: 1, text: 'admit DS-1 DS-2 once the person says admit', keys: ['DS-1', 'DS-2'] }]));
  t('#1341 one naming a ticket still open, one naming a ticket the queue does not know, and one naming none stay', JSON.stringify(readAsks(dir).map((a) => a.id)), '[2,3,4]');
  t('#1341 with nothing stale, nothing is dropped', pruneAsks(dir, { known: (k) => k in tickets, finished: (k) => ['merged', 'done'].includes(tickets[k]) }).length, 0);
} finally { rmSync(dir, { recursive: true, force: true }); }

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
