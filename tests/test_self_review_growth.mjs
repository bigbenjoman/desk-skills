// suite: self-review growth (a fix that grows is a scope call a worker takes under autopilot-judgement)
// covers: skills/desk-autopilot/references/worker-contract-stage-4.md skills/desk-autopilot/references/ask-or-take.md
// What the worker contract tells a worker whose self-review fix needs a file outside its diff: widen
// within the ticket's size, split past it, park where judgement is off or a §3 row is not granted.
// Each check is also run on the text before this rule, which must fail it.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\s+/g, ' ');
const now = {
  stage4: read('skills/desk-autopilot/references/worker-contract-stage-4.md'),
  take: read('skills/desk-autopilot/references/ask-or-take.md'),
};
const before = {
  stage4: read('tests/fixtures/worker-contract-before-split.md'),
  take: read('tests/fixtures/desk-autopilot-before-split.md'),
};

const checks = [
  ['AC1 under autopilot-judgement yes the Stage 4 rule takes the call by ask-or-take',
    (s) => s.stage4.includes('is a scope call: take it per `ask-or-take.md` where §3 `autopilot-judgement` is `yes`')],
  ['AC1 the call is logged as a scope decision',
    (s) => s.take.includes('is printed as an `AUTOPILOT_DECISION` with category `scope`, and is widened or split')],
  ['AC1 it widens when the grown diff stays within the ticket\'s size',
    (s) => s.take.includes('**Widen** when the grown diff stays within the ticket\'s size')],
  ['AC1 a small P0 or P1 in its own feature path is always widened',
    (s) => s.take.includes('needs at most one more file and about 20 lines always does')],
  ['AC2 past its size it files a follow-up and has the pass link it',
    (s) => s.take.includes('**Split** otherwise: file one follow-up ticket') && s.take.includes('`AUTOPILOT_LINK: <follow-up> relates-to <TICKET>`')],
  ['AC3 with autopilot-judgement not yes it parks as before',
    (s) => s.stage4.includes('`autopilot-judgement` is `yes`, else park naming it')],
  ['AC4 growth that needs a §3 row not granted parks naming the row',
    (s) => s.take.includes('**A §3 row the growth needs that is not `yes`**') && s.take.includes('parks naming that row, whatever `autopilot-judgement` says')],
  ['a gap a sibling ticket owns is cited, not asked',
    (s) => s.take.includes('**A gap a sibling ticket in the epic owns is not a question.** Cite the sibling\'s key')],
];
for (const [name, ok] of checks) {
  t(name, ok(now), true);
  t(`negative control: the text before this rule fails: ${name}`, ok(before), false);
}
t('the old rule is gone', now.stage4.includes('is the user\'s call to widen the PR or split it out'), false);
t('a fix needing someone else\'s decision still parks', now.stage4.includes('So does a fix needing someone else\'s decision.'), true);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
