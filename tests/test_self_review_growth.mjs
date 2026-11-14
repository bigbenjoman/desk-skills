// suite: self-review growth (a fix that grows is a scope call a worker takes under autopilot-judgement)
// covers: skills/desk-autopilot/references/worker-contract-stage-4.md skills/desk-autopilot/references/ask-or-take.md
// What the worker contract tells a worker whose self-review fix needs a file outside its diff: widen
// within the ticket's size, split past it, park where judgement is off or a §3 row is not granted.
// Each check is also run on the contract before this rule, which must fail it.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\s+/g, ' ');
const stage4 = read('skills/desk-autopilot/references/worker-contract-stage-4.md');
const before = read('tests/fixtures/worker-contract-before-split.md');
const askOrTake = read('skills/desk-autopilot/references/ask-or-take.md');

// The growth rule, from its bold lead to the line on equivalent call sites.
const rule = (s) => { const i = s.indexOf('**A fix that grows'); return i < 0 ? '' : s.slice(i, s.indexOf('Moving equivalent sites', i)); };
const now = rule(stage4);
const old = rule(before);

const checks = [
  ['AC1 under autopilot-judgement yes it is taken as a scope decision, not parked',
    (s) => s.includes('`autopilot-judgement` is not `yes`, park naming it. Where it is `yes`, take it, print it as an `AUTOPILOT_DECISION` with category `scope`, and do not park')],
  ['AC1 it widens when the grown diff stays within the ticket\'s size',
    (s) => s.includes('**Widen** when the grown diff stays within the ticket\'s size')],
  ['AC1 a small P0 or P1 in its own feature path is always widened',
    (s) => s.includes('needs at most one more file and about 20 lines always does')],
  ['AC2 past its size it files a follow-up and has the pass link it',
    (s) => s.includes('**Split** otherwise: file one follow-up ticket') && s.includes('`AUTOPILOT_LINK: <follow-up> relates-to <TICKET>`')],
  ['AC3 with autopilot-judgement not yes it parks as before',
    (s) => s.includes('`autopilot-judgement` is not `yes`, park naming it')],
  ['AC4 growth that needs a §3 row not granted parks naming the row',
    (s) => s.includes('**A §3 row the growth needs that is not `yes`**') && s.includes('parks naming that row, whatever `autopilot-judgement` says')],
];
for (const [name, ok] of checks) {
  t(name, ok(now), true);
  t(`negative control: the contract before this rule fails: ${name}`, ok(old), false);
}
t('the old rule is gone', stage4.includes('is the user\'s call to widen the PR or split it out'), false);
t('a fix needing someone else\'s decision still parks', stage4.includes('A fix that needs someone else\'s decision parks.'), true);

// Ask or take names both scope calls a worker always takes.
t('ask-or-take: a gap a sibling ticket owns is cited, not asked',
  askOrTake.includes('**A gap a sibling ticket in the epic owns is not a question.** Cite the sibling\'s key'), true);
t('ask-or-take: a small P0 or P1 fix that grows is widened and logged',
  askOrTake.includes('needs at most one more file and about 20 lines, under no §4 Merge holds glob, is widened and logged'), true);
t('ask-or-take points at the Stage 4 rule', askOrTake.includes('(`worker-contract-stage-4.md`, *A fix that grows*)'), true);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
