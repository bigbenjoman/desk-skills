// suite: ask defaults (a choice's recommendation applies by itself at its deadline, unless it must never default)
// layer: L1
// covers: desk/bin/ask-defaults.mjs
import * as D from '../desk/bin/ask-defaults.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const local = (d, h, m) => new Date(2026, 10, d, h, m);
const hm = (x) => (x ? `${x.getDate()} ${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}` : null);

t('#1366 the next check-in is the first slot after now, today', hm(D.nextCheckin(['08:00', '17:00'], local(24, 10, 0))), '24 17:00');
t('#1366 past the last slot, it is tomorrow\'s first', hm(D.nextCheckin(['08:00', '17:00'], local(24, 18, 0))), '25 08:00');
t('#1366 --apply-by takes a local HH:MM, the next one', hm(D.applyByOf('09:15', local(24, 10, 0))), '25 09:15');
t('#1366 or an ISO time', D.applyByOf('2026-11-24T12:00:00Z').toISOString(), '2026-11-24T12:00:00.000Z');
t('#1366 and nothing else', D.applyByOf('tomorrow'), null);
t('#1366 an option is one word', `${D.OPTION.test('merge')} ${D.OPTION.test('hold-it')} ${D.OPTION.test('two words')}`, 'true true false');

t('#1366 the session\'s own --never-default reason wins', D.neverDefault('Rename the column', 'rename', 'it drops data, which cannot be undone'), 'it drops data, which cannot be undone');
t('#1366 a recommendation that spends money never applies by itself', D.neverDefault('Upgrade the plan to the paid tier?', 'upgrade'), 'it is a money call, which desk never takes for you');
t('#1366 nor one about production credentials', D.neverDefault('Rotate the production API key now?', 'rotate'), 'it is a production call, which desk never takes for you');
t('#1366 an ordinary call may', D.neverDefault('Merge PR #12 now, or hold it for the release?', 'merge'), null);

const now = local(24, 10, 0);
t('#1366 the deadline as the person reads it: today', D.deadlineText({ recommended: 'merge', apply_by: local(24, 17, 0).toISOString() }, now), 'applies merge at 17:00 unless you choose');
t('#1366 another day names it', D.deadlineText({ recommended: 'merge', apply_by: local(25, 8, 0).toISOString() }, now), 'applies merge at Wed Nov 25 08:00 unless you choose');
t('#1366 one that never defaults says so, and why', D.deadlineText({ recommended: 'upgrade', never_default: 'it is a money call, which desk never takes for you' }, now), 'never applies by itself: it is a money call, which desk never takes for you');
t('#1366 one with no recommendation has no deadline', D.deadlineText({ options: ['a', 'b'] }, now), null);

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
