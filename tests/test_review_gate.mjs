// suite: desk-gate template (verdict marker, CLAUDE.md size, protected-path approval)
// The desk-gate template's checks on fixture reviews and files: the desk-review verdict (clean,
// missing, stale SHA, each non-zero count, heading mismatch), CLAUDE.md size, and the protected-path
// approval with its small fix/docs/chore exemption.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVerdict, checkClaudeMd, checkApproval, titleType, exemptType, COUNTS } from '../desk/templates/scripts/desk/review-gate.mjs';
import * as oldGate from './fixtures/review-gate-v1.mjs';
import { render } from '../skills/desk-review/bin/verdict.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const has = (name, text, part) => t(name, text.includes(part) ? part : text, part);

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const zero = Object.fromEntries(COUNTS.map((k) => [k, 0]));
const body = (o = {}) => {
  const v = { sha: HEAD, ...zero, vendor: 'codex-cross', round: 1, ...o };
  const heading = o.heading ?? `**No P0, P1 or P2 findings at \`${v.sha.slice(0, 7)}\`.** 3 files.`;
  return '<!-- desk-review:local -->\n' +
    `<!-- desk-review:verdict v=1 sha=${v.sha} ${COUNTS.map((k) => `${k}=${v[k]}`).join(' ')} vendor=${v.vendor} round=${v.round} -->\n\n` +
    `${heading}\n\nreview prose`;
};
// The logins the permission endpoint said can push; `reader` is an org member with read access.
const WRITERS = new Set(['me', 'rev']);
const review = (b, o = {}) => ({ body: b, state: 'COMMENTED', user: { login: 'me' }, ...o });
const verdict = (reviews, opts) => checkVerdict(reviews, HEAD, WRITERS, opts);

// The verdict marker.
t('clean at head passes', verdict([review(body())]).ok, true);
t('no review fails', verdict([]).ok, false);
t('a reply-marker body is not a verdict', verdict([review(body().replace('desk-review:local', 'desk-review:reply'))]).ok, false);
t('a verdict on line 1 alone is not a review', verdict([review(body().split('\n').slice(1).join('\n'))]).ok, false);
const stale = verdict([review(body({ sha: OTHER }))]);
t('stale sha fails', stale.ok, false);
has('stale sha names both commits', stale.message, `at ${OTHER.slice(0, 9)}, not the head ${HEAD.slice(0, 9)}`);
t('a short sha that prefixes the head is still not the head', verdict([review(body({ sha: HEAD.slice(0, 9), heading: 'No P0, P1 or P2 findings.' }))]).ok, false);
for (const k of COUNTS) {
  const r = verdict([review(body({ [k]: 1, heading: 'Findings below.' }))]);
  t(`${k}=1 fails`, r.ok, false);
  has(`${k}=1 is named`, r.message, `${k}=1`);
}
t('the latest verdict wins over an older clean one', verdict([review(body()), review(body({ p1: 1, heading: '1 P1' }))]).ok, false);
t('a newer clean verdict clears an older dirty one', verdict([review(body({ p0: 1, heading: '1 P0' })), review(body())]).ok, true);
t('a newer clean verdict at an old sha does not pass', verdict([review(body()), review(body({ sha: OTHER }))]).ok, false);
t('a verdict from someone without write access is ignored', verdict([review(body(), { user: { login: 'reader' } })]).ok, false);
t('nor can it override the latest real verdict', verdict([review(body({ p0: 1, heading: '1 P0' })), review(body(), { user: { login: 'reader' } })]).ok, false);
t('same-vendor passes by default', verdict([review(body({ vendor: 'same-vendor' }))]).ok, true);
t('same-vendor fails when codex-cross is required', verdict([review(body({ vendor: 'same-vendor' }))], { vendor: 'codex-cross' }).ok, false);

// The visible heading against a clean marker.
const heading = (h, o = {}) => verdict([review(body({ heading: h, ...o }))]);
for (const h of ['1 P0 outstanding at `aaaaaaa`', 'No P0 or P1; 2 P2 left', '1 deferred, otherwise clean']) {
  const r = heading(h);
  t(`heading "${h}" over a clean marker fails`, r.ok, false);
  has(`heading "${h}" says why`, r.message, 'while the marker reads clean');
}
has('heading naming another sha fails', heading(`**No P0, P1 or P2 findings at \`${OTHER.slice(0, 7)}\`.**`).message, `names ${OTHER.slice(0, 7)}`);
has('heading with another round fails', heading('desk-review · round 1 · 3 files', { round: 2 }).message, 'says round 1 but the marker says 2');
has('markers alone fail', verdict([review(body().split('\n').slice(0, 2).join('\n'))]).message, 'no visible heading');
t('a full-sha heading passes', heading(`**No P0, P1 or P2 findings** at \`${HEAD}\`, across 4 files.`).ok, true);
t('a header-line heading passes', heading('**desk-review** · branch `feat/x` → `main` at `aaaaaaa` · round 1 · 4 files').ok, true);
t('"3 rounds" is not a round number', heading('**No P0, P1 or P2 findings at `aaaaaaa`.** reviewed over 3 rounds', { round: 3 }).ok, true);
t('an open gap may be listed in a clean heading', heading('No P0, P1 or P2 findings; 1 requirement gap open').ok, true);

// Round 3's carried P2 findings, as verdict.mjs prints them, read by this gate and by a repo's
// committed copy from before carrying existed: both give the result the blocking counts give.
const SINCE = 'c'.repeat(40);
const seats = [{ role: 'correctness', vendor: 'claude', status: 'ran' }, { role: 'codex', vendor: 'codex', status: 'ran' }];
const fnd = (o = {}) => ({ id: 'F1', seat: 'correctness', severity: 'P2', where: 'src/a.ts:12', result: 'CONFIRMED', refuted_by: 'codex', carried: true, ...o });
const printed = (findings, o = {}) => render({ sha: HEAD, round: 3, since: SINCE, gaps: 0, skipped_files: 0, seats, findings, ...o }) + '\n\nreview prose';
const CASES = [
  ['only carried P2s', [fnd(), fnd({ id: 'F2', where: 'src/b.ts:3' })], true],
  ['nothing found on round 3', [], true],
  ['a carried P2 beside an open P1', [fnd(), fnd({ id: 'F2', severity: 'P1', carried: false })], false],
  ['an uncarried P2 on round 3', [fnd({ carried: false })], false],
  ['a carried P2 left unrefuted', [fnd({ result: 'UNREFUTED', refuted_by: undefined })], false],
];
for (const [name, findings, clean] of CASES) {
  const b = printed(findings);
  t(`new gate, ${name}: ${clean ? 'clean' : 'not clean'}`, checkVerdict([review(b)], HEAD, WRITERS).ok, clean);
  t(`gate copy before carrying, ${name}: ${clean ? 'clean' : 'not clean'}`, oldGate.checkVerdict([review(b)], HEAD, WRITERS).ok, clean);
  t(`gate copy before carrying, ${name}: still parses the verdict`, oldGate.parseVerdict(b) !== null, true);
}
t('the old copy reads the round-3 heading without a mismatch', oldGate.headingMismatch(oldGate.parseVerdict(printed([fnd()]))), null);

// CLAUDE.md size: characters, not bytes.
t('20,000 characters passes', checkClaudeMd([{ path: 'CLAUDE.md', text: 'x'.repeat(20000) }]).ok, true);
const big = checkClaudeMd([{ path: 'CLAUDE.md', text: 'x' }, { path: 'apps/api/CLAUDE.md', text: 'x'.repeat(20001) }]);
t('20,001 characters fails', big.ok, false);
has('it names the file and size', big.message, 'apps/api/CLAUDE.md is 20001 characters');
has('it points at splitting', big.message, 'Split it');
t('multibyte text is counted in characters', checkClaudeMd([{ path: 'CLAUDE.md', text: 'é'.repeat(15000) }]).ok, true);

// The CLI, against a throwaway repo: only tracked CLAUDE.md files are read.
const repo = mkdtempSync(join(tmpdir(), 'desk-gate-'));
const script = join(dirname(fileURLToPath(import.meta.url)), '../desk/templates/scripts/desk/review-gate.mjs');
const git = (...a) => execFileSync('git', a, { cwd: repo });
git('init', '-q');
mkdirSync(join(repo, 'docs'));
writeFileSync(join(repo, 'CLAUDE.md'), 'short');
writeFileSync(join(repo, 'docs/CLAUDE.md'), 'y'.repeat(20001));
writeFileSync(join(repo, 'notes.md'), 'z'.repeat(30000));
const cli = () => { try { return `0 ${execFileSync('node', [script, 'claude-md'], { cwd: repo, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } })}`; } catch (e) { return `${e.status} ${e.stdout}`; } };
t('untracked CLAUDE.md files are not read', cli().startsWith('0 ::notice::0 CLAUDE.md'), true);
git('add', 'CLAUDE.md', 'docs/CLAUDE.md', 'notes.md');
const out = cli();
t('a tracked nested CLAUDE.md over the limit exits 1', out.slice(0, 1), '1');
has('the CLI names it', out, '::error::docs/CLAUDE.md is 20001 characters');
rmSync(repo, { recursive: true, force: true });

// Title types: the exemption rule, verbatim from the workflow.
const wf = readFileSync(join(dirname(script), '../../.github/workflows/desk-gate.yml'), 'utf8');
const env = (k) => wf.match(new RegExp(`^ +${k}: '(.*)'$`, 'm'))[1];
const EXEMPT = env('EXEMPT_TYPES');
t('the workflow exempts fix, docs and chore', EXEMPT, 'fix|docs|chore');
t('the workflow file limit is 30', env('FILE_LIMIT'), '30');
t('the workflow ships no protected paths', env('PROTECTED'), '');
const needsApproval = (title) => !exemptType(titleType(title), EXEMPT);
for (const title of ['fix: ABC-1 guard the null', 'fix(booking): ABC-742 make child creation atomic', 'docs: ABC-2 document the gate', 'chore(deps): bump next']) {
  t(`"${title}" is exempt`, needsApproval(title), false);
}
for (const title of ['feat(live): ABC-610 add the broadcast', 'refactor(booking): ABC-742 make child creation atomic', 'ci: ABC-1079 enforce a conventional title', 'fix(web)!: ABC-887 drop the old route', 'fixup: not a type', 'ABC-1107: fix the rate limit']) {
  t(`"${title}" needs an approval`, needsApproval(title), true);
}

// The protected-path approval.
const ENV = { protected: '^(\\.github|scripts/desk)/', generated: env('GENERATED'),fileLimit: 30, exemptTypes: EXEMPT };
const file = (filename, n = 1) => ({ filename, additions: n, deletions: 0 });
const many = (n) => Array.from({ length: n }, (_, i) => file(`src/f${i}.ts`));
const pr = (title) => ({ title, author: 'me', head: HEAD });
const approve = (o = {}) => ({ state: 'APPROVED', commit_id: HEAD, user: { login: 'rev' }, ...o });
const gate = (title, files, reviews = [], e = ENV) => checkApproval(pr(title), files, reviews, WRITERS, e);
const GATE = [file('.github/workflows/desk-gate.yml')];
t('empty PROTECTED passes', gate('feat: x', GATE, [], { ...ENV, protected: '' }).ok, true);
t('no protected path touched passes, whatever the type', gate('feat: x', many(40)).ok, true);
t('a small fix on a protected path passes', gate('fix(ci): x', [...GATE, ...many(29)]).ok, true);
t('a small docs change on a protected path passes', gate('docs: x', GATE).ok, true);
const feat = gate('feat: x', GATE);
t('a feat on a protected path needs an approval', feat.ok, false);
has('it names the path and the type', feat.message, 'It touches `.github/workflows/desk-gate.yml` with a `feat:` title');
t('a breaking fix on a protected path needs an approval', gate('fix!: x', GATE).ok, false);
const bigFix = gate('fix: x', [...GATE, ...many(30)]);
t('a fix over 30 files on a protected path needs an approval', bigFix.ok, false);
has('it names the count', bigFix.message, '**31** changed files, over the 30-file limit');
t('generated files do not count toward the limit', gate('fix: x', [...GATE, ...many(29), file('package-lock.json', 900), file('dist/a.js'), file('a.png')]).ok, true);
t('an approval at the head clears it', gate('feat: x', GATE, [approve()]).ok, true);
const old = gate('feat: x', GATE, [approve({ commit_id: OTHER })]);
t('an approval at an earlier commit does not', old.ok, false);
has('it says to approve again', old.message, 'rev approved an earlier commit');
t("the author's own approval does not count", gate('feat: x', GATE, [approve({ user: { login: 'me' } })]).ok, false);
t('an approval without write access does not count', gate('feat: x', GATE, [approve({ user: { login: 'reader' } })]).ok, false);
const moved = gate('feat: x', [{ filename: 'docs/old-gate.yml', previous_filename: '.github/workflows/desk-gate.yml', additions: 0, deletions: 0 }]);
t('renaming a file out of a protected path needs an approval', moved.ok, false);
has('it names the old path', moved.message, '`.github/workflows/desk-gate.yml`');
t('changes requested after an approval voids it', gate('feat: x', GATE, [approve(), approve({ state: 'CHANGES_REQUESTED' })]).ok, false);
t('a dismissed approval does not count', gate('feat: x', GATE, [approve({ state: 'DISMISSED' })]).ok, false);
t('a comment after an approval keeps it', gate('feat: x', GATE, [approve(), approve({ state: 'COMMENTED' })]).ok, true);

console.log(fails ? `${fails} FAILED` : 'all review-gate checks passed');
process.exit(fails ? 1 : 0);
