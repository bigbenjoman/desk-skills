// suite: promotion window (one question a day at the last check-in, staging-check page, go, production-broken)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkin, promote, DEFAULT_TIMES } from '../desk/bin/digest.mjs';
import { promotionRef, promotionFor, mergedPrs, personSteps, urgentPromotion, promotionSlot } from '../desk/bin/promotion.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const at = (d, hm) => new Date(`${d}T${hm}:00`);

const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);
const body = (testing) => `<!-- desk-pr: body -->\nWhat it does.\n\n### Changes\n- a\n\n### Testing\n${testing}\n<!-- desk-pr: end -->`;
const PRS = {
  11: { number: 11, title: 'feat: export button', url: 'https://github.com/acme/a/pull/11', body: body('- unit specs pass\n- [ ] Open /settings on staging and export a CSV\n- [x] already checked') },
  12: { number: 12, title: 'chore: bump deps', url: 'https://github.com/acme/a/pull/12', body: body('- CI green') },
  13: { number: 13, title: 'fix: checkout 500', url: 'https://github.com/acme/a/pull/13', body: '<!-- desk-pr: body -->\nPRODUCTION BROKEN: checkout returns 500.\n\n### Testing\n- [ ] Buy one item on staging' },
};
// A fake git and gh: the range holds a merge commit and a squash, oldest last as git prints them.
const fakeExec = ({ log = `${'c'.repeat(40)}\tfix: tidy (#12)\n${'d'.repeat(40)}\tMerge pull request #11 from acme/feat`, prs = PRS, calls = [] } = {}) => (cmd, args) => {
  calls.push(`${cmd} ${args.join(' ')}`);
  if (cmd === 'git') {
    const sub = args[2];
    if (sub === 'fetch') return '';
    if (sub === 'rev-parse') return args.at(-1).startsWith('origin/production') ? FROM : TO;
    if (sub === 'log') return log;
  }
  if (cmd === 'gh') return JSON.stringify(prs[Number(args[2])]);
  throw new Error(`unexpected ${cmd}`);
};
const inputs = (extra = {}) => ({ slug: 'acme__a', root: '/repo', ghRepo: 'acme/a', def: 'main', ref: 'origin/production', staging: ['web: https://staging.acme.test'], ...extra });

t('a merge commit and a squash both read, oldest first', mergedPrs(`x\tfix: y (#12)\nz\tMerge pull request #11 from a/b`).join(','), '11,12');
t('only unchecked Testing items are steps', personSteps(PRS[11].body).join('|'), 'Open /settings on staging and export a CSV');
t('a body with no Testing section has no steps', personSteps('### Changes\n- [ ] not testing').length, 0);
t('the promotion slot is the day\'s last', `${promotionSlot(DEFAULT_TIMES, '2026-10-22T08:00')} ${promotionSlot(DEFAULT_TIMES, '2026-10-22T17:00')}`, 'false true');

// AC2 and AC3: the page.
const p = promotionFor({ ...inputs(), exec: fakeExec() });
t('AC2 the range runs from the Promotion ref to the default branch', `${p.range.from} ${p.range.to}`, `${FROM} ${TO}`);
t('AC2 each PR is listed with its title and link', p.page.includes('[#11 feat: export button](https://github.com/acme/a/pull/11)'), true);
t('AC2 the steps its Testing leaves to a person are listed', p.page.includes('- [ ] Open /settings on staging and export a CSV'), true);
t('AC2 the page names the staging URL', p.page.includes('`web: https://staging.acme.test`'), true);
t('AC3 a PR with no steps is under Nothing to look at', /## Nothing to look at[\s\S]*#12 chore: bump deps/.test(p.page), true);
t('AC3 and not under To look at', /## To look at[\s\S]*#12[\s\S]*## Nothing/.test(p.page), false);

// AC5: no ref.
t('AC5 a none row asks nothing and says why', promotionRef('none').why, 'config §4 "Promotion ref" is none');
t('AC5 an unset row asks nothing and says why', promotionFor({ ...inputs({ ref: null }), exec: fakeExec() }).why, 'config §4 "Promotion ref" is unset');
t('AC4 nothing merged since the ref is empty', promotionFor({ ...inputs(), exec: fakeExec({ log: '' }) }).empty, true);

// The digest: two repos, one with a range, one with no Promotion ref, one with nothing merged.
const root = mkdtempSync(join(tmpdir(), 'desk-promotion-'));
const repo = (slug) => {
  const state = join(root, 'state', slug);
  mkdirSync(state, { recursive: true });
  const queue = join(root, 'q', slug, 'queue.json');
  mkdirSync(dirname(queue), { recursive: true });
  writeFileSync(queue, JSON.stringify({ batch: 'b', tickets: {} }));
  return { slug, state, queue };
};
const A = repo('acme__a');
const B = repo('acme__b');
const C = repo('acme__c');
const list = [A, B, C];
const dir = join(root, 'digest');
const promoteFake = (r) => (r.slug === 'acme__a' ? promotionFor({ ...inputs(), exec: fakeExec() })
  : r.slug === 'acme__b' ? promotionFor({ ...inputs({ slug: 'acme__b', ref: 'none' }), exec: fakeExec() })
    : promotionFor({ ...inputs({ slug: 'acme__c' }), exec: fakeExec({ log: '' }) }));

const morning = await checkin({ times: DEFAULT_TIMES, now: at('2026-10-22', '08:01'), dir, list, bin: BIN, self: 'acme__a', promote: promoteFake });
t('AC1 the 08:00 check-in asks no promotion question', `${morning.promotions} ${readFileSync(morning.page, 'utf8').includes('Promote')}`, '0 false');
const evening = await checkin({ times: DEFAULT_TIMES, now: at('2026-10-22', '17:01'), dir, list, bin: BIN, self: 'acme__a', promote: promoteFake });
const page = readFileSync(evening.page, 'utf8');
t('AC1 the 17:00 check-in holds one promotion question', page.match(/- \[ \] Promote /g)?.length, 1);
t('AC1 it covers every PR merged since the ref', page.includes(`Promote \`${FROM.slice(0, 12)}..${TO.slice(0, 12)}\` (2 PR(s)`), true);
t('AC1 the push counts it', /1 promotion question\(s\)/.test(evening.push?.text), true);
t('AC2 the page links its staging-check page', existsSync(join(dir, '2026-10-22T1700-acme__a-staging.md')), true);
t('AC5 a repo with Promotion ref none is told why', page.includes('No promotion question for acme__b: config §4 "Promotion ref" is none.'), true);
t('AC5 and gets no question', page.includes('## acme__b'), false);
t('AC4 a repo with nothing merged gets no question', page.includes('## acme__c'), false);
t('AC4 and no staging page', readdirSync(dir).some((f) => f.includes('acme__c')), false);

// AC6: go.
const range = `${FROM.slice(0, 12)}..${TO.slice(0, 12)}`;
t('anything but go is refused', promote({ slug: 'acme__a', range, text: 'maybe', dir, list, by: 'Ben' }).ok, false);
const go = promote({ slug: 'acme__a', range, text: 'go', dir, list, by: 'Ben', now: at('2026-10-22', '17:30') });
t('AC6 go is recorded', go.ok, true);
const notes = readFileSync(join(A.state, 'batch-notes.md'), 'utf8');
t('AC6 the batch notes record the full approved range', notes.includes(`approved promoting acme__a \`${FROM}..${TO}\` to production`), true);
t('AC6 and leave promoting to the repo\'s own steps', notes.includes("Run this repo's own promotion steps"), true);
t('AC6 the page marks it', /- \[x\] Promote .* go from Ben/.test(readFileSync(evening.page, 'utf8')), true);
const next = await checkin({ times: DEFAULT_TIMES, now: at('2026-10-23', '17:01'), dir, list, bin: BIN, self: 'acme__a', promote: promoteFake });
t('an approved range not yet promoted is not asked again', `${next.promotions} ${readFileSync(next.page, 'utf8').includes('was approved by Ben')}`, '0 true');

// AC7: a production-broken fix merged between check-ins.
const U = repo('acme__u');
const brokenLog = `${'e'.repeat(40)}\tfix: checkout 500 (#13)\n${'d'.repeat(40)}\tMerge pull request #11 from acme/feat`;
const calls = [];
const u = urgentPromotion({ inputs: inputs({ slug: 'acme__u' }), state: U.state, dir, merged: [13], exec: fakeExec({ log: brokenLog, calls }), now: at('2026-10-22', '11:00') });
t('AC7 a merged production-broken fix is pushed at once', /acme__u: production-broken fix #13 merged; promote .* \(2 PR\(s\)\) now\?/.test(u?.push.text), true);
t('AC7 its page is written', existsSync(u.page), true);
t('AC7 it is pushed once', urgentPromotion({ inputs: inputs({ slug: 'acme__u' }), state: U.state, dir, merged: [13, 14], exec: fakeExec({ log: brokenLog }) }), null);
const before = calls.length;
urgentPromotion({ inputs: inputs({ slug: 'acme__u' }), state: U.state, dir, merged: [13], exec: fakeExec({ log: brokenLog, calls }) });
t('a pass with no newly merged PR reads nothing', calls.length, before);
t('an ordinary merge is not pushed', urgentPromotion({ inputs: inputs({ slug: 'acme__v' }), state: repo('acme__v').state, dir, merged: [11], exec: fakeExec() }), null);

process.exit(fails ? 1 : 0);
