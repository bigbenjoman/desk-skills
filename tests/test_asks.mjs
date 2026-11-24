// suite: asks (what a session handed the person; an ask whose tickets are all finished waits on nothing)
// layer: L1
// covers: desk/bin/asks.mjs
import { addAsk, readAsks, pruneAsks, settleAdmitted } from '../desk/bin/asks.mjs';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const dir = scratch('asks-');
{
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
}

const raced = scratch('asks-');
{
  addAsk(raced, 'say whether to admit DS-1', Date.now(), { until: ['DS-1'] });
  const status = { 'DS-1': 'merged', 'DS-3': 'running' };
  let asked = false;
  // The ask is asked again, now on an open ticket, after the pass read it as spent but before it locks.
  const finished = (k) => { if (!asked) { asked = true; addAsk(raced, 'say whether to admit DS-1', Date.now(), { until: ['DS-3'] }); } return status[k] === 'merged'; };
  const gone = pruneAsks(raced, { known: (k) => k in status, finished });
  t('#1341 an ask asked again on an open ticket while a pass prunes is kept', `${gone.length} ${readAsks(raced).map((a) => a.until.join()).join()}`, '0 DS-3');
}

const adm = scratch('asks-');
{
  addAsk(adm, 'start /desk-autopilot DS-1 in a session', Date.now(), { until: ['DS-1'], settles: 'admit' });
  addAsk(adm, 'start /desk-autopilot DS-1 DS-2 in a session', Date.now(), { until: ['DS-1', 'DS-2'], settles: 'admit' });
  addAsk(adm, 'merge DS-1 once it is green', Date.now(), { until: ['DS-1'] });
  const gone = settleAdmitted(adm, (k) => k === 'DS-1');
  t('#1359 an ask its admission settles is dropped once every ticket it waits on is admitted', JSON.stringify(gone), JSON.stringify([{ id: 1, text: 'start /desk-autopilot DS-1 in a session', keys: ['DS-1'] }]));
  t('#1359 one with a ticket not yet admitted, or a wait on its merge, stays', readAsks(adm).map((a) => a.id).join(), '2,3');
}

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
