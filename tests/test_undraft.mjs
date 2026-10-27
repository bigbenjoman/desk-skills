// suite: undraft (which §4 Clean review verdict values the pass can read a review against)
import { undraftCall, undraftComment, leftOver, DESK_REVIEW_CLEAN } from '../desk/bin/undraft.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const green = [{ name: 'tests', status: 'completed', conclusion: 'success' }];
const tk = { key: 'T-1' };
const marker = (counts, sha = HEAD) => `<!-- desk-review:local -->\n<!-- desk-review:verdict v=1 sha=${sha} ${counts} -->\nclean`;
const review = (body, oid = HEAD, login = 'ben') => ({ author: { login }, body, commit: { oid } });
const call = (clean, reviews) => undraftCall(tk, { number: 701, head: HEAD, mergeable: 'MERGEABLE', mergeState: 'DRAFT', body: '', reviews, checks: green },
  { perm: 'yes', localReview: '/code-review', clean, handle: 'ben', required: ['tests'] });

// AC1: a plain-text row, and a desk-review verdict marker with every count desk-review writes at 0.
const zero = call('no findings', [review(marker(DESK_REVIEW_CLEAN))]);
t('AC1 a clean marker under "no findings" is undrafted', zero?.call, 'ready');
t('AC1 it carries the marker it read', zero?.verdict?.sha, HEAD);
t('AC1 a marker with a P2 open is not', call('no findings', [review(marker('p0=0 p1=0 p2=1 deferred=0 gaps=0 unrefuted=0 partial=0'))])?.why.includes('p2=1'), true);
t('AC1 a marker missing a count is not', call('no findings', [review(marker('p0=0 p1=0 deferred=0 gaps=0'))])?.call, 'person');
t('AC1 a marker for an older head is not', call('no findings', [review(marker(DESK_REVIEW_CLEAN, OLD), OLD)])?.why.includes('not the head'), true);

// AC2: no marker, and the review states the value at the head.
const plain = call('no findings', [review('## Code review\n\nNo findings. Nothing deferred or carried.')]);
t('AC2 a review stating the value at the head, nothing left over, is undrafted', plain?.call, 'ready');
t('AC2 its verdict is the line stating the value', plain?.verdict, 'No findings. Nothing deferred or carried.');
t('AC2 the comment quotes that line', undraftComment(plain.verdict, HEAD, 'no findings'),
  `Out of draft: the review posted on this head (\`${HEAD.slice(0, 12)}\`) is clean under §4 Clean review verdict (\`no findings\`).\n\n> \`No findings. Nothing deferred or carried.\``);
const carried = call('no findings', [review('No findings.\n\n- Deferred: rename the helper (follow-up DS-300)\n- Carried from round 2: the retry cap')]);
t('AC2 deferred or carried items keep it draft', carried?.call, 'person');
t('AC2 and the reason names each one', carried?.why.includes('"Deferred: rename the helper (follow-up DS-300)"') && carried?.why.includes('"Carried from round 2: the retry cap"'), true);
t('AC2 and the action is to settle them', carried?.action, 'settle the findings or gaps on #701');
t('AC2 "no findings, one deferred" is still left over', leftOver('No blocking findings, one deferred to DS-300').length, 1);
t('AC2 "deferred: none" is not left over', leftOver('Deferred: none\nCarried: 0\nnothing to defer').length, 0);
t('AC2 a review stating it at an older commit is not read', call('no findings', [review('No findings.', OLD)])?.why.includes(`is for ${OLD.slice(0, 9)}, not the head`), true);
t('AC2 nor one with no commit recorded', call('no findings', [review('No findings.', '')])?.call, 'person');
t('AC2 a review that does not state it is no verdict', call('no findings', [review('Two issues, see inline.')])?.why, 'no review stating "no findings" is posted on it');
t('AC2 only the handle\'s own review counts', call('no findings', [review('No findings.', HEAD, 'someone')])?.call, 'person');
t('AC2 a later chat review does not hide the verdict', call('no findings', [review('No findings.'), review('Thanks!')])?.call, 'ready');
t('AC2 the latest verdict wins over an earlier clean one', call('no findings', [review('No findings.'), review(marker('p0=1 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0'))])?.call, 'person');

// AC3: key=value counts read as before; a review with no marker is no verdict.
t('AC3 key=value counts still undraft a clean marker', call('p0=0 p1=0 gaps=0', [review(marker('p0=0 p1=0 deferred=0 gaps=0'))])?.call, 'ready');
t('AC3 and still ignore a plain review', call('p0=0 p1=0 gaps=0', [review('No findings.')])?.why, 'no desk-review verdict is posted on it');

// AC4: unset or not filled in.
for (const clean of [null, '', 'TODO (how the local review says clean)', 'none']) {
  const c = call(clean, [review(marker(DESK_REVIEW_CLEAN))]);
  t(`AC4 ${JSON.stringify(clean)} is the person's, set with /desk-setup`, `${c?.call} ${c?.action}`, 'person set it with /desk-setup');
}

process.exit(fails ? 1 : 0);
