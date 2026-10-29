// suite: undraft (which §4 Clean review verdict values the pass can read a review against)
import { undraftCall, undraftComment, leftOver, DESK_REVIEW_CLEAN } from '../desk/bin/undraft.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const ALL_ZERO = 'p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0';
const CLEAN_TEXT = 'No findings. Nothing deferred or carried.';
const green = [{ name: 'tests', status: 'completed', conclusion: 'success' }];
const tk = { key: 'T-1' };
const marker = (counts, sha = HEAD) => `<!-- desk-review:local -->\n<!-- desk-review:verdict v=1 sha=${sha} ${counts} vendor=codex-cross round=1 -->\nclean`;
const review = (body, oid = HEAD, login = 'ben') => ({ author: { login }, body, commit: { oid } });
const call = (clean, reviews) => undraftCall(tk, { number: 701, head: HEAD, mergeable: 'MERGEABLE', mergeState: 'DRAFT', body: '', reviews, checks: green },
  { perm: 'yes', localReview: '/code-review', clean, handle: 'ben', required: ['tests'] });

// AC1: a plain-text row, and a desk-review verdict marker with every count desk-review writes at 0.
t('AC1 the counts read are every count desk-review writes', DESK_REVIEW_CLEAN, ALL_ZERO);
const zero = call('no findings', [review(marker(ALL_ZERO))]);
t('AC1 a clean marker under "no findings" is undrafted', zero?.call, 'ready');
t('AC1 it carries the marker it read', zero?.verdict?.sha, HEAD);
for (const k of ['p2', 'deferred', 'gaps', 'unrefuted', 'partial']) {
  t(`AC1 a marker with ${k}=1 alone is not`, call('no findings', [review(marker(ALL_ZERO.replace(`${k}=0`, `${k}=1`)))])?.why.includes(`${k}=1`), true);
}
t('AC1 a marker missing a count is not', call('no findings', [review(marker('p0=0 p1=0 deferred=0 gaps=0'))])?.call, 'person');
const unread = marker('p0=0 p1=0 gaps=0').replace(/\nclean$/, `\n${CLEAN_TEXT}`);
t('AC1 nor read as a plain review under a heading stating the value', call('no findings', [review(unread)])?.why, 'its desk-review verdict marker is not one the review gate reads');
t('AC1 a marker for an older head is not', call('no findings', [review(marker(ALL_ZERO, OLD), OLD)])?.why.includes('not the head'), true);

// AC2: no marker, and the latest review at the head states the value.
const plain = call('no findings', [review(`## Code review\n\n**${CLEAN_TEXT}**`)]);
t('AC2 a review stating the value at the head, nothing left over, is undrafted', plain?.call, 'ready');
t('AC2 its verdict is the line stating the value', plain?.verdict, CLEAN_TEXT);
t('AC2 the comment quotes that line', undraftComment(plain.verdict, HEAD, 'no findings'),
  `Out of draft: the review posted on this head (\`${HEAD.slice(0, 12)}\`) is clean under §4 Clean review verdict (\`no findings\`).\n\n> \`${CLEAN_TEXT}\``);
const carried = call('no findings', [review('No findings.\n\n- Deferred: rename the helper (follow-up DS-300)\n- Carried from round 2: the retry cap')]);
t('AC2 deferred or carried items keep it draft', carried?.call, 'person');
t('AC2 and the reason names each one', carried?.why.includes('"Deferred: rename the helper (follow-up DS-300)"') && carried?.why.includes('"Carried from round 2: the retry cap"'), true);
t('AC2 and the action is to settle them', carried?.action, 'settle the findings or gaps on #701');
t('AC2 "no findings, one deferred" is still left over', leftOver('No blocking findings, one deferred to DS-300').length, 1);
t('AC2 "deferred: none" is not left over', leftOver('Deferred: none\nCarried: 0\nnothing to defer').length, 0);
t('AC2 "deferred: no timeout…" defers an item', leftOver('Deferred: no timeout on outbound requests\nCarried: 0 retries for transient failures').length, 2);
t('AC2 a deferral named "no …" keeps it draft', call('no findings', [review(`${CLEAN_TEXT}\nDeferred: no timeout on outbound requests`)])?.call, 'person');
t('AC2 a review stating it at an older commit is not read', call('no findings', [review(CLEAN_TEXT, OLD)])?.why.includes(`is for ${OLD.slice(0, 9)}, not the head`), true);
t('AC2 nor one with no commit recorded', call('no findings', [review(CLEAN_TEXT, '')])?.call, 'person');
t('AC2 a review that does not state it is not clean', call('no findings', [review('Two issues, see inline.')])?.why.includes('does not open a line with "no findings"'), true);
t('AC2 nor one that only mentions it beside a finding', call('no findings', [review('Correctness: 1 finding, null deref at x.js:10\nSecurity: no findings. Nothing deferred or carried.')])?.call, 'person');
t('AC2 nor one that goes on to name a finding', call('no findings', [review(`${CLEAN_TEXT}\n\nCorrectness: 1 finding at x.js:10`)])?.why.includes('"Correctness: 1 finding at x.js:10"'), true);
t('AC2 nor "no findings in the docs"', call('no findings', [review('No findings in the docs; nothing deferred.')])?.call, 'person');
t('AC2 nor one silent on what is deferred or carried', call('no findings', [review('No findings.')])?.why.includes('not that nothing is deferred or carried'), true);
t('AC2 under "clean", "not clean" is not clean', call('clean', [review('Not clean. Nothing deferred.')])?.call, 'person');
t('AC2 only the handle\'s own review counts', call('no findings', [review(CLEAN_TEXT, HEAD, 'someone')])?.call, 'person');
t('AC2 an empty review (a reply to an inline comment) does not hide the verdict', call('no findings', [review(CLEAN_TEXT), review('')])?.call, 'ready');
t('AC2 a later review at the head that reports findings wins', call('no findings', [review(CLEAN_TEXT), review('2 findings, see inline.')])?.call, 'person');
// DS-281: and its P0 is a findings call for a fix worker, as under key=value counts.
t('AC2 the latest verdict wins over an earlier clean one', call('no findings', [review(CLEAN_TEXT), review(marker('p0=1 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0'))])?.call, 'findings');
t('AC2 a marker with only a P2 under "no findings" is the person\'s', call('no findings', [review(marker(ALL_ZERO.replace('p2=0', 'p2=1')))])?.call, 'person');

// AC3: key=value counts read as before; a review with no marker is no verdict.
t('AC3 key=value counts still undraft a clean marker', call('p0=0 p1=0 gaps=0', [review(marker(ALL_ZERO))])?.call, 'ready');
t('AC3 but not a marker the review gate rejects', call('p0=0 p1=0 gaps=0', [review(marker('p0=0 p1=0 deferred=0 gaps=0'))])?.call, 'person');
t('AC3 and still ignore a plain review', call('p0=0 p1=0 gaps=0', [review(CLEAN_TEXT)])?.why, 'no desk-review verdict is posted on it');

// AC4: unset or not filled in.
for (const clean of [null, '', 'TODO (how the local review says clean)', 'none']) {
  const c = call(clean, [review(marker(ALL_ZERO))]);
  t(`AC4 ${JSON.stringify(clean)} is the person's, set with /desk-setup`, `${c?.call} ${c?.action}`, 'person set it with /desk-setup');
}

// DS-323 AC3: checks a workflow skips on a draft are not "not green": once the rest holds, the person undrafts it.
const withChecks = (checks, reviews) => undraftCall(tk, { number: 701, head: HEAD, mergeable: 'MERGEABLE', mergeState: 'DRAFT', body: '', reviews, checks },
  { perm: 'yes', localReview: '/code-review', clean: 'no findings', handle: 'ben', required: ['tests'] });
const skippedTests = [{ name: 'tests', status: 'completed', conclusion: 'skipped' }, { name: 'lint', status: 'completed', conclusion: 'success' }];
const sk = withChecks(skippedTests, [review(marker(ALL_ZERO))]);
t('DS-323 AC3 a clean draft whose only red checks were skipped is the person\'s to undraft', `${sk?.call} | ${sk?.why} | ${sk?.action}`, 'person | CI does not run on a draft, so its checks were skipped | undraft #701');
t('DS-323 AC3 one whose review is not clean says that instead', withChecks(skippedTests, [review(marker(ALL_ZERO.replace('gaps=0', 'gaps=2')))])?.why.includes('gaps=2'), true);
t('DS-323 AC3 a failed check beside a skipped one is still not green', withChecks([...skippedTests, { name: 'build', status: 'completed', conclusion: 'failure' }], [review(marker(ALL_ZERO))])?.why.startsWith('its checks are not green'), true);

process.exit(fails ? 1 : 0);
