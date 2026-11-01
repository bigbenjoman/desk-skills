// suite: recoveries (what a pass settles for a parked ticket by script)
import { parkRecommends, takeable, pushPark, prTitleIn, mergedNaming } from '../desk/bin/recoveries.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const Q = 'Widen this PR to cover the export (recommended), or split it?';
const rec = (o) => JSON.stringify({ options: ['widen', 'split'], chose: 'widen', category: 'scope', ...o });
t('AC3 a recommendation takes the park\'s question', parkRecommends(rec(), Q).decision?.question, Q);
t('AC3 an ask category is refused', parkRecommends(rec({ category: 'money' }), Q).ok, false);
t('AC3 a choice outside the options is refused', parkRecommends(rec({ chose: 'both' }), Q).ok, false);
t('AC3 not JSON is refused', parkRecommends('{"options":', Q).why, 'not JSON');
const take = (category, judgement) => takeable(parkRecommends(rec({ category }), Q).decision, judgement);
for (const c of ['engineering', 'scope', 'review', 'tracker']) t(`AC3 a ${c} call is taken whatever autopilot-judgement says`, take(c, 'no'), true);
for (const c of ['product', 'design', 'wording']) {
  t(`AC3 a ${c} call is taken where autopilot-judgement is yes`, take(c, 'yes'), true);
  t(`AC3 a ${c} call is not taken where it is not`, take(c, 'ask'), false);
}

t('AC5 a refused push is a push park', pushPark('git push origin fix/A-1 was refused: push it and open the draft'), true);
t('AC5 a PR that could not be opened is one', pushPark('gh pr create failed (HTTP 422): open the draft PR from the body above'), true);
t('AC5 a force-push is not: a plain push cannot finish it', pushPark('the force-push to fix/A-1 was refused: approve it once'), false);
t('AC5 a never-allowed step is not', pushPark('gh api was denied, so the PR could not be opened'), false);
t('AC5 a park about something else is not', pushPark('which helper should the spec use?'), false);
t('AC5 the title is the last --title the worker wrote', prTitleIn('gh pr create --title "first" …\nthen gh pr create --title "fix(a): A-1 \\"quoted\\"" --body-file b.md'), 'fix(a): A-1 "quoted"');
t('AC5 no --title is null', prTitleIn('gh pr create --draft'), null);

const prs = [{ number: 1, title: 'fix: DS-3970 other', headRefName: 'fix/DS-3970' }, { number: 2, title: 'chore: tidy', headRefName: 'fix/DS-397-again' }];
t('AC6 a merged PR names the key by its head branch', mergedNaming('DS-397', prs)?.number, 2);
t('AC6 a longer key is not the key', mergedNaming('DS-39', [{ number: 3, title: 'fix: DS-397 x', headRefName: 'fix/DS-397' }]), null);
t('AC6 a longer id after the key is not the key', mergedNaming('DS-397', [{ number: 4, title: 'fix: DS-397-5 x', headRefName: 'fix/DS-397-5-x' }]), null);
t('AC6 an issue key matches its #N', mergedNaming('issue-12', [{ number: 5, title: 'fix: closes #12', headRefName: 'fix/thing' }])?.number, 5);
t('AC6 nothing listed is null', mergedNaming('DS-397', null), null);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
