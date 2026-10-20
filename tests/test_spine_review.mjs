// suite: spine review (the read-only review of a spine's specs, and one approval question per spec)
import { specsForReview, reviewBrief, parseReply, approvalQuestions } from '../desk/bin/spine-review.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const S = (xs) => JSON.stringify(xs);

const files = [
  { path: 'e2e/acceptance/cart.spec.ts', text: `import { test, expect } from '@playwright/test';
test.fail('AC1: a guest can add to cart', async ({ page }) => { await expect(page.getByRole('status')).toHaveText('1 item'); });
test.fail('AC2: the cart total includes tax', async ({ page }) => { await expect(page.getByTestId('total')).toHaveText('£12.00'); });
` },
  { path: 'e2e/acceptance/checkout.spec.ts', text: `import { test } from '@playwright/test';
import { price } from '../../src/lib/pricing/internal';
test.fail('AC2: tax shown at checkout', async () => { price(); });
` },
];
const criteria = [{ id: 'AC1', text: 'A guest can add an item and sees the count.' }, { id: 'AC2', text: 'Totals include tax.' }];
const specs = specsForReview(files, ['AC1', 'AC2'], criteria);
const [a1, a2, a2b] = specs.map((s) => s.key);

t('one spec to review per titled declaration, in id order', S(specs.map((s) => `${s.id} ${s.path}`)),
  S(['AC1 e2e/acceptance/cart.spec.ts', 'AC2 e2e/acceptance/cart.spec.ts', 'AC2 e2e/acceptance/checkout.spec.ts']));
t('each spec carries its criterion', specs[1].criterion, 'Totals include tax.');

// AC1: the reviewer is asked, per spec, for the four kinds of finding, and to change nothing.
const brief = reviewBrief(specs, { worktree: '/w/SP-1', command: 'npx playwright test e2e/acceptance -g "{ids}"' });
t('the brief names every spec by key', specs.every((s) => brief.includes(`key: ${s.key}`)), true);
t('the brief asks for all four kinds', ['unasserted', 'contradiction', 'coupled', 'wrong_failure'].every((k) => brief.includes(`- ${k}:`)), true);
t('the brief is read-only', /READ-ONLY: no Edit or Write/.test(brief), true);
t('the brief gives the criterion and file', brief.includes(`criterion AC2: Totals include tax.\nfile: e2e/acceptance/checkout.spec.ts`), true);

// AC2: one question per spec, with its criterion, file and findings.
const reply = `Here is the review:\n\`\`\`json\n${S({
  reviewed: [a1, a2, a2b],
  findings: [
    { spec: a1, kind: 'unasserted', detail: 'never adds an item as a guest' },
    { spec: a2, kind: 'contradiction', other: a2b, detail: 'one expects tax in the cart, the other only at checkout' },
    { spec: a2b, kind: 'coupled', detail: 'imports src/lib/pricing/internal' },
    { spec: a2b, kind: 'wrong_failure', detail: 'price() throws before any assertion' },
    { spec: 'e2e/acceptance/gone.spec.ts::AC9', kind: 'unasserted', detail: 'x' },
  ],
})}\n\`\`\``;
const { questions, unmatched } = approvalQuestions(specs, parseReply(reply));
t('one question per spec', questions.length, 3);
t('a question shows its criterion and file', questions[0].question.split('\n').slice(0, 2).join(' | '),
  'AC1: "AC1: a guest can add to cart" in e2e/acceptance/cart.spec.ts | Criterion: A guest can add an item and sees the count.');
t('a question shows its own findings', S(questions[0].findings), S(['does not assert: never adds an item as a guest']));
t('a contradiction is shown on both specs', S(questions.map((q) => q.findings.filter((f) => f.startsWith('contradicts')).length)), '[0,1,1]');
t('every kind reads plainly', S(questions[2].findings), S([`contradicts ${a2}: one expects tax in the cart, the other only at checkout`,
  'coupled to an internal module: imports src/lib/pricing/internal', 'fails for the wrong reason: price() throws before any assertion']));
t('a finding on no reviewed spec is kept as unmatched', S(unmatched), S(['e2e/acceptance/gone.spec.ts::AC9: does not assert: x']));
t('a reviewed spec with nothing found says so', approvalQuestions(specs, parseReply(S({ reviewed: [a1, a2, a2b], findings: [] }))).questions[0].question.includes('Review: reviewed: nothing found'), true);

// AC3: a reviewer that failed or returned nothing leaves every spec not reviewed.
const notReviewed = (review) => approvalQuestions(specs, review).questions.map((q) => (q.reviewed ? 'reviewed' : /Review: not reviewed/.test(q.question) ? 'not' : '?')).join(',');
t('no reviewer run', notReviewed(null), 'not,not,not');
t('an empty reply', notReviewed(parseReply('')), 'not,not,not');
t('a reply with no JSON', notReviewed(parseReply('I could not read the files.')), 'not,not,not');
t('a reply that is not valid JSON', notReviewed(parseReply('{"reviewed": [')), 'not,not,not');
t('a reply listing no reviewed specs', notReviewed(parseReply('{"findings": []}')), 'not,not,not');
t('a spec the reviewer did not read is not reviewed, and its findings are not shown', (() => {
  const q = approvalQuestions(specs, parseReply(S({ reviewed: [a2, a2b], findings: [{ spec: a1, kind: 'unasserted', detail: 'x' }] }))).questions;
  return `${notReviewed(parseReply(S({ reviewed: [a2, a2b], findings: [] })))} ${q[0].findings.length}`;
})(), 'not,reviewed,reviewed 0');

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
