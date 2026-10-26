// suite: desk-ci profile (light and full jobs, the batch-base plan, the saving)
// desk-ci.mjs profile on fixture workflows: a job that needs a database, preview or browser is full
// and cites its line, a job that needs a full one is full too, the plan gates each full job on PRs
// into the default branch and writes nothing, a required check only a full job reports is flagged,
// and the saving is estimated from a measure report or left out with how to measure.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileJobs, profile, profileReport, fullIf, checkIsJob, parseWorkflow } from '../desk/bin/desk-ci.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const placed = (yml) => profileJobs(yml).jobs.map((r) => `${r.job}=${r.profile}@${r.line}`).join(' ');

const ci = `name: ci
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
  api:
    runs-on: ubuntu-latest
    services:
      db:
        image: postgres:16
    steps:
      - run: npm test
  e2e:
    name: e2e (\${{ matrix.browser }})
    if: github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - run: npx playwright install --with-deps
  preview:
    runs-on: ubuntu-latest
    steps:
      - run: curl https://preview.example.com/health
  report:
    needs: [lint, api]
    runs-on: ubuntu-latest
    steps:
      - run: echo done
  shared:
    uses: ./.github/workflows/shared.yml
  outside:
    uses: org/repo/.github/workflows/x.yml@v1
`;
const nightly = `name: nightly
on:
  schedule:
    - cron: '0 3 * * *'
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - run: npx cypress run
`;
const lightOnly = `name: light
on: [push, pull_request]
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;

// ---- AC1: each job light or full, at the line that decided it
t('jobs placed light or full at the deciding line', placed(ci), 'lint=light@8 api=full@16 e2e=full@24 preview=full@28 report=full@30 shared=light@35 outside=full@37');
const why = Object.fromEntries(profileJobs(ci).jobs.map((r) => [r.job, r.why]));
t('database reason', why.api, 'database service postgres:16');
t('browser reason', why.e2e, 'browser playwright');
t('preview reason', why.preview, 'staging or preview URL https://preview.example.com/health');
t('a job needing a full job is full', why.report, 'needs api, which is full');
t('a light job says so', why.lint, 'no database, preview or browser');
t('an outside reusable workflow is full', why.outside, 'calls org/repo/.github/workflows/x.yml@v1, a workflow outside this repo that cannot be read here');
t('a database URL is full', placed(`on: pull_request\njobs:\n  it:\n    runs-on: ubuntu-latest\n    env:\n      DATABASE_URL: postgres://localhost/test\n    steps: [{ run: 'true' }]\n`), 'it=full@6');
t('a prisma migrate is full', placed(`on: pull_request\njobs:\n  m:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          npx prisma migrate deploy\n`), 'm=full@7');
t('a container job on a database image is full', placed(`on: pull_request\njobs:\n  c:\n    runs-on: ubuntu-latest\n    container: mysql:8\n    steps: [{ run: 'true' }]\n`), 'c=full@5');
t('a vercel deploy is full', placed(`on: pull_request\njobs:\n  v:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx vercel deploy --prebuilt\n`), 'v=full@6');
t('needs on a chain of jobs propagates', placed(`on: pull_request\njobs:\n  a:\n    needs: b\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n  b:\n    needs:\n      - c\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n  c:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx cypress run\n`), 'a=full@4 b=full@8 c=full@15');

const own = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../.github/workflows/tests.yml'), 'utf8');
t('own workflow is all light', placed(own), 'suite=light@18 tests=light@70');

// ---- AC2: the plan gates every full job on PRs into the default branch
const files = [{ file: 'ci.yml', text: ci }, { file: 'nightly.yml', text: nightly }, { file: 'light.yml', text: lightOnly }];
const p = profile(files, { defaultBranch: 'main', required: ['lint', 'e2e (chromium)', 'report', 'outside / deploy', 'missing'] });
t('one change per full job of a PR workflow', p.changes.map((c) => `${c.job}:${c.action}@${c.line ?? c.at}`).join(' '), 'api:add@12 e2e:replace@21 preview:add@25 report:add@29 outside:add@36');
t('the added if', p.changes[0].text, "if: ${{ !github.base_ref || github.base_ref == 'main' }}");
t('an existing if is kept and combined', p.changes[1].text, "if: ${{ (github.actor != 'dependabot[bot]') && (!github.base_ref || github.base_ref == 'main') }}");
const ifOf = (yml) => fullIf(parseWorkflow(yml).jobs[0].keys.if, 'trunk').text;
t('a ${{ }} if is unwrapped before combining', ifOf("on: pull_request\njobs:\n  a:\n    if: ${{ always() }}\n    runs-on: x\n"), "if: ${{ (always()) && (!github.base_ref || github.base_ref == 'trunk') }}");
t('a quoted if is unquoted', ifOf("on: pull_request\njobs:\n  a:\n    if: \"github.event_name == 'push'\"\n    runs-on: x\n"), "if: ${{ (github.event_name == 'push') && (!github.base_ref || github.base_ref == 'trunk') }}");
t('a workflow not run on PRs needs no change', p.notes.includes('nightly.yml  does not run on pull requests: no change'), true);
t('a PR trigger limited to the default branch is named', p.notes.some((n) => n.startsWith("ci.yml:4  pull_request runs only on PRs into main: add the batch base branches")), true);
t('a light-only workflow has no change', p.changes.some((c) => c.file === 'light.yml'), false);
t('a light-only workflow limited to the default branch is named', profile([{ file: 'l.yml', text: lightOnly.replace('on: [push, pull_request]', 'on:\n  pull_request:\n    branches: [main]') }], { defaultBranch: 'main' }).notes.join(), "l.yml:4  pull_request runs only on PRs into main: add the batch base branches (for example 'feat/**') so the light jobs run on PRs into them");
t('a wildcard PR branch filter is left alone', profile([{ file: 'w.yml', text: ci.replace('branches: [main]', "branches: ['**']") }], { defaultBranch: 'main' }).notes.length, 0);

// ---- AC3: a required check only a full job reports
t('required checks only in full', p.requiredFull.map((r) => `${r.check}->${r.job}`).join(' '), 'e2e (chromium)->e2e report->report outside / deploy->outside');
t('a matrix leg is the job', checkIsJob('e2e (chromium)', 'e2e (${{ matrix.browser }})'), true);
t('a called job is the caller', checkIsJob('outside / deploy', 'outside'), true);
t('another name is not', checkIsJob('lint-extra', 'lint'), false);
const text = profileReport(p);
t('report flags the required check', text.includes('REQUIRED CHECK ONLY IN FULL: "report" comes from report (ci.yml:29)'), true);

// A reusable workflow in this repo runs on its caller's PRs, so its full jobs are gated, counted
// for required checks and saved as the caller reports them (`caller / job`).
const shared = `name: shared
on:
  workflow_call:
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - run: npx playwright test
`;
const pc = profile([{ file: 'ci.yml', text: ci }, { file: 'shared.yml', text: shared }], {
  defaultBranch: 'main', required: ['shared / e2e'],
  measure: { coveredSince: '2026-09-01', until: '2026-09-28', runs: { read: 1, completed: 1 }, prs: { withCi: 2 }, jobs: [{ workflow: 'ci', job: 'shared / e2e', runs: 2, billed: 20, self: 0 }, { workflow: 'ci', job: 'outside / e2e', runs: 2, billed: 50, self: 0 }] },
});
t('a called workflow\'s full job is gated', pc.changes.filter((c) => c.file === 'shared.yml').map((c) => `${c.job}:${c.action}@${c.at}`).join(' '), 'e2e:add@5');
t('a called workflow\'s required check is flagged', pc.requiredFull.map((r) => `${r.file} ${r.job}`).join(' '), 'shared.yml e2e');
t('a called workflow\'s minutes come from its own caller\'s rows, each row once', `${pc.saving.billed} ${pc.saving.unmatched.includes('shared.yml e2e')}`, '70 false');

// A block-scalar if is replaced whole, its body lines with it.
const blockIf = "on: pull_request\njobs:\n  a:\n    if: >-\n      github.event_name == 'push' ||\n      github.actor == 'me'\n    runs-on: x\n    steps:\n      - run: npx cypress run\n";
const pb = profile([{ file: 'b.yml', text: blockIf }], { defaultBranch: 'main' });
t('a block-scalar if is combined from its body', pb.changes[0].text, "if: ${{ (github.event_name == 'push' || github.actor == 'me') && (!github.base_ref || github.base_ref == 'main') }}");
t('a block-scalar if is replaced with its body lines', profileReport(pb).includes("  b.yml:4-6  a  replace `if: >-` and the 2 lines under it with:  if: ${{"), true);

// A name that is all expression cannot be matched, so a required check no job claims may be its.
const opaque = "on: pull_request\njobs:\n  suite:\n    name: ${{ matrix.suite }}\n    runs-on: x\n    steps:\n      - run: npx cypress run\n  lint:\n    runs-on: x\n    steps: [{ run: 'true' }]\n";
const po = profile([{ file: 'o.yml', text: opaque }], { defaultBranch: 'main', required: ['integration', 'lint'] });
t('an unclaimed required check may be an expression-named full job\'s', po.requiredFull.map((r) => `${r.check}->${r.job}${r.maybe ? ' maybe' : ''}`).join(' '), 'integration->suite maybe');
t('report says it may be', profileReport(po).includes('REQUIRED CHECK MAY BE ONLY IN FULL: "integration" matches no job by name, and suite (o.yml:3)'), true);

// ---- AC4 and AC5: the saving, from a measure report or not at all
t('no measure: says not estimated and how to measure', /^saving: not estimated: no measure report\. Run `node ~\/\.claude\/desk\/bin\/desk-ci\.mjs measure`/m.test(text), true);
t('no measure: summary has no saving', text.split('\n').at(-1), 'summary: jobs=9 light=3 full=6 changes=5 required_full=3 saving_per_pr=none');
const m = {
  coveredSince: '2026-07-01', until: '2026-09-28', runs: { read: 10, completed: 12 }, prs: { withCi: 10 },
  jobs: [
    { workflow: 'ci', job: 'api', runs: 20, billed: 100, self: 0 },
    { workflow: 'ci', job: 'e2e (chromium)', runs: 10, billed: 150, self: 50 },
    { workflow: 'ci', job: 'e2e (firefox)', runs: 10, billed: 100, self: 0 },
    { workflow: 'ci', job: 'lint', runs: 20, billed: 1000, self: 0 },
    { workflow: 'nightly', job: 'e2e', runs: 90, billed: 500, self: 0 },
  ],
};
const pm = profile(files, { defaultBranch: 'main', measure: m, batchPrs: 5 });
t('saving sums the skipped full jobs only', `${pm.saving.billed}+${pm.saving.self}`, '350+50');
t('saving per PR', pm.saving.perPr, 40);
t('saving per batch', pm.saving.perBatch, 200);
t('full jobs with no minutes are named', pm.saving.unmatched.join(', '), 'ci.yml preview, ci.yml report, ci.yml outside');
const tm = profileReport(pm, { measureFile: 'm.json', checksRead: false });
t('report gives the estimate per batch', tm.includes('saving (estimate): the full jobs cost ~40 CI min per PR (350 billed and 50 self-hosted min over 10 PRs with CI, 2026-07-01 to 2026-09-28, itself sampled), so ~200 min per batch of 5 child PRs.'), true);
t('report says it is an estimate', tm.includes('An estimate, not a measurement'), true);
t('without a batch size it says how to get one', profileReport(profile(files, { defaultBranch: 'main', measure: m })).includes('pass --batch-prs <n> for a total'), true);
t('measure summary', tm.split('\n').at(-1), 'summary: jobs=9 light=3 full=6 changes=5 required_full=0 saving_per_pr=40');
t('no required checks read is said', tm.includes('note: no required checks read'), true);

// ---- the CLI: prints the plan and writes nothing
const dir = mkdtempSync(join(tmpdir(), 'desk-ci-profile-'));
try {
  const wfDir = join(dir, 'workflows');
  mkdirSync(wfDir);
  writeFileSync(join(wfDir, 'ci.yml'), ci);
  writeFileSync(join(dir, 'm.json'), JSON.stringify(m));
  const before = readdirSync(dir).join(',');
  const bin = join(dirname(fileURLToPath(import.meta.url)), '../desk/bin/desk-ci.mjs');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DESK_')));
  const run = (...a) => execFileSync(process.execPath, [bin, 'profile', wfDir, '--default', 'main', '--repo', 'nobody/none', ...a], { cwd: dir, env, encoding: 'utf8' });
  const out = run('--required', 'e2e (chromium)', '--required', 'lint');
  t('cli cites file:line per job', out.split('\n')[1], `${join(wfDir, 'ci.yml')}:16  api  full  database service postgres:16`);
  t('cli with no measure names where it looked', out.includes(`no measure report for nobody/none in ${join('.', '.handoffs')}`), true);
  t('cli summary', out.trim().split('\n').at(-1), 'summary: jobs=7 light=2 full=5 changes=5 required_full=1 saving_per_pr=none');
  const withM = run('--measure', join(dir, 'm.json'), '--batch-prs', '3');
  t('cli with a measure report estimates per batch', withM.includes('~120 min per batch of 3 child PRs'), true);
  t('cli writes nothing', `${readdirSync(dir).join(',')}|${readFileSync(join(wfDir, 'ci.yml'), 'utf8') === ci}`, `${before}|true`);
  let status = 0;
  try { run('--bogus', 'x'); } catch (e) { status = e.status; }
  t('cli refuses an unknown flag', status, 2);
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
