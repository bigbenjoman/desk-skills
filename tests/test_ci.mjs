// suite: desk-ci (classify placement, ci-lint secret safety)
// desk-ci.mjs on fixture workflows: each hosted trigger places its job hosted and cites its line,
// a job with none is placed self-hosted, and ci-lint fails a self-hostable job that receives a
// secret, an environment or id-token, or whose runs-on has no Dependabot branch.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, lint, parseCiConfig } from '../desk/bin/desk-ci.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const placed = (yml, o) => classify(yml, o).map((r) => `${r.job}=${r.placement}@${r.line}`).join(' ');
const linted = (yml, o) => lint(yml, o).map((r) => `${r.job}@${r.line}`).join(' ');

const SELF = "runs-on: ${{ github.actor == 'dependabot[bot]' && 'ubuntu-latest' || 'self-hosted' }}";
const wf = (jobs, head = '') => `name: ci\non: [push]\n${head}jobs:\n${jobs}`;

// GITHUB_TOKEN only: nothing hosted, nothing to lint.
const tokenOnly = wf(`  test:
    ${SELF}
    steps:
      - uses: actions/checkout@v4
      - run: gh pr list
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`);
t('GITHUB_TOKEN only is self-hosted at the job line', placed(tokenOnly), 'test=self-hosted@4');
t('GITHUB_TOKEN only lints clean', linted(tokenOnly), '');

// A job secret.
const jobSecret = wf(`  e2e:
    ${SELF}
    steps:
      - run: npm test
        env:
          API_KEY: \${{ secrets.API_KEY }} # a comment
`);
t('job secret is hosted at its line', placed(jobSecret), 'e2e=hosted@9');
t('job secret reason names it', classify(jobSecret)[0].why, 'secret API_KEY');
t('job secret on a self-hostable job fails lint', linted(jobSecret), 'e2e@9');

// A secret in a run body, on a line the shell reads as a comment: GitHub still expands it.
const runBody = wf(`  build:
    runs-on: self-hosted
    steps:
      - run: |
          # token: \${{ secrets.NPM_TOKEN }}
          npm ci
`);
t('secret inside a run block scalar comment is hosted', placed(runBody), 'build=hosted@8');

// A workflow-level env secret is inherited by every job.
const wfEnv = wf(`  a:
    ${SELF}
    steps: [{ run: 'true' }]
  b:
    runs-on: ubuntu-latest
    steps: [{ run: 'true' }]
`, 'env:\n  SENTRY_DSN: ${{ secrets.SENTRY_DSN }}\n');
t('workflow-level env secret places every job hosted at the env line', placed(wfEnv), 'a=hosted@4 b=hosted@4');
t('inherited reason says so', classify(wfEnv)[0].why, 'secret SENTRY_DSN (inherited workflow-level env)');
t('inherited env secret fails lint only for the self-hostable job', linted(wfEnv), 'a@4');

// An environment.
const env = wf(`  deploy:
    ${SELF}
    environment: production
    steps: [{ run: 'true' }]
`);
t('environment is hosted at its line', placed(env), 'deploy=hosted@6');
t('environment on a self-hostable job fails lint', linted(env), 'deploy@6');

// id-token, job-level and inherited, and a job permissions block that overrides the workflow's.
const idToken = wf(`  oidc:
    ${SELF}
    permissions:
      contents: read
      id-token: write
    steps: [{ run: 'true' }]
  plain:
    ${SELF}
    steps: [{ run: 'true' }]
  scoped:
    ${SELF}
    permissions: { contents: read }
    steps: [{ run: 'true' }]
`, 'permissions:\n  id-token: write\n');
t('id-token job and inherited, job permissions override', placed(idToken), 'oidc=hosted@10 plain=hosted@4 scoped=self-hosted@15');
t('id-token fails lint where it reaches a self-hostable job', linted(idToken), 'plain@4 oidc@10');

// Dependabot branch missing.
const noDependabot = wf(`  unit:
    runs-on: [self-hosted, linux, arm64]
    steps: [{ run: 'true' }]
  matrixed:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: \${{ matrix.os }}
    steps: [{ run: 'true' }]
  custom:
    strategy:
      matrix:
        include:
          - runner: [self-hosted, macOS]
    runs-on: \${{ matrix.runner }}
    steps: [{ run: 'true' }]
  dynamic:
    runs-on: \${{ vars.RUNNER }}
    steps: [{ run: 'true' }]
`);
t('runs-on with no Dependabot branch fails lint; hosted-only matrix does not', linted(noDependabot), 'unit@5 custom@18 dynamic@21');
t('a job with no hosted trigger is self-hosted whatever runs-on says today', placed(noDependabot), 'unit=self-hosted@4 matrixed=self-hosted@7 custom=self-hosted@13 dynamic=self-hosted@20');

// A postgis service image has no arm64 build.
const postgis = wf(`  integration:
    ${SELF}
    services:
      db:
        image: postgis/postgis:16-3.4
        ports: ['5432:5432']
    steps: [{ run: 'true' }]
`);
t('postgis image is hosted at the image line', placed(postgis), 'integration=hosted@8');
t('postgis reason', classify(postgis)[0].why, 'image postgis/postgis:16-3.4 has no arm64 build');
t('an image alone is not a lint finding', linted(postgis), '');

// A build parity job, by name and by vercel build.
const parity = wf(`  parity:
    name: Vercel parity build
    ${SELF}
    steps: [{ run: 'true' }]
  prod:
    ${SELF}
    steps:
      - run: npx vercel build --prod
`);
t('build parity job is hosted', placed(parity), 'parity=hosted@5 prod=hosted@11');

// A staging URL and a third-party service.
const outside = wf(`  smoke:
    ${SELF}
    steps:
      - run: npx playwright test
        env:
          BASE_URL: https://staging.example.com
  cov:
    ${SELF}
    steps:
      - uses: codecov/codecov-action@v4
  local:
    ${SELF}
    steps:
      - run: curl -fsS http://localhost:3000/health
`);
t('staging URL and service action are hosted, localhost is not', placed(outside), 'smoke=hosted@9 cov=hosted@13 local=self-hosted@14');

// A reusable workflow call: a local one with no secrets is self-hosted (its jobs are placed in its
// own file); one handing over secrets, or one from outside the repo, is hosted.
const reusable = wf(`  call:
    uses: ./.github/workflows/build.yml
  callsecrets:
    uses: ./.github/workflows/deploy.yml
    secrets: inherit
  remote:
    uses: acme/shared/.github/workflows/ci.yml@v1
`);
t('reusable calls', placed(reusable), 'call=self-hosted@5 callsecrets=hosted@8 remote=hosted@10');

// A matrix include written as a flow mapping still reaches runs-on.
const flowInclude = wf(`  legs:
    strategy:
      matrix:
        os: [ubuntu-latest]
        include:
          - { os: self-hosted, node: 20 }
    runs-on: \${{ matrix.os }}
    env:
      T: \${{ secrets.DEPLOY }}
    steps: [{ run: 'true' }]
`);
t('flow-mapping include makes runs-on self-hostable', linted(flowInclude), 'legs@10 legs@12');

// A YAML alias can carry a secret env in from another job.
const alias = wf(`  h:
    runs-on: ubuntu-latest
    env: &shared
      T: \${{ secrets.DEPLOY }}
    steps: [{ run: 'true' }]
  a:
    ${SELF}
    env: *shared
    steps: [{ run: 'true' }]
`);
t('alias job is hosted at the alias line', placed(alias), 'h=hosted@7 a=hosted@11');
t('alias on a self-hostable job fails lint', linted(alias), 'a@11');

// The Dependabot branch must pick a hosted runner, written either way round.
const dependabot = wf(`  inverted:
    runs-on: \${{ github.actor == 'dependabot[bot]' && 'self-hosted' || 'ubuntu-latest' }}
    steps: [{ run: 'true' }]
  negated:
    runs-on: \${{ github.actor != 'dependabot[bot]' && 'self-hosted' || 'ubuntu-latest' }}
    steps: [{ run: 'true' }]
  json:
    runs-on: \${{ fromJSON(github.actor == 'dependabot[bot]' && '["ubuntu-24.04"]' || '["self-hosted","linux"]') }}
    steps: [{ run: 'true' }]
`);
t('a Dependabot branch to self-hosted fails; != and fromJSON forms pass', linted(dependabot), 'inverted@5');

// This repo's own workflows: hosted labels only, so nothing to lint.
const ownWf = (f) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../.github/workflows', f), 'utf8');
const own = ownWf('tests.yml');
t('own workflow classifies', placed(own), 'plan=self-hosted@26 bash32=self-hosted@74 shard=self-hosted@90 tests=self-hosted@153 record=self-hosted@193');
t('own workflow lints clean', linted(own), '');
t('own nightly and red-main workflows lint clean', linted(ownWf('nightly-macos.yml')) + linted(ownWf('ci-main-red.yml')), '');

// A repo's declared AWS runner labels (.github/desk-ci.yml) are its cloud runners: a job that can
// land only on one of them, or on a GitHub-hosted label, may receive a secret.
const VPA = { awsLabels: ['voicepa-linux-arm64', 'voicepa-linux-arm64-8cpu'] };
const secretJob = (runsOn) => wf(`  j:
    runs-on: ${runsOn}
    steps:
      - run: npm test
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
`);
const awsList = '[self-hosted, voicepa-linux-arm64]';
t('AC1 a secret on a declared AWS label lints clean', linted(secretJob(awsList), VPA), '');
t('AC2 a choice of a declared AWS label or a hosted one lints clean',
  linted(secretJob(`\${{ github.event_name == 'pull_request' && 'ubuntu-latest' || fromJSON('["self-hosted","voicepa-linux-arm64"]') }}`), VPA), '');
t('AC3 the same job with nothing declared is reported as today', linted(secretJob(awsList)), 'j@5 j@9');
t('AC3 the finding text is unchanged', lint(secretJob(awsList))[1].problem, 'can run self-hosted but receives secret DATABASE_URL');
t('AC4 a choice that can pick bare self-hosted is reported',
  linted(secretJob(`\${{ vars.X == 'on' && 'self-hosted' || fromJSON('["self-hosted","voicepa-linux-arm64"]') }}`), VPA), 'j@5 j@9');
t('AC4 an undeclared self-hosted label is reported', linted(secretJob('[self-hosted, voicepa-linux-amd64]'), VPA), 'j@5 j@9');
t('AC5 a label from vars is reported', linted(secretJob('${{ vars.RUNNER }}'), VPA), 'j@5 j@9');
t('AC5 a label built from inputs is reported',
  linted(secretJob(`\${{ fromJSON(format('["self-hosted","{0}"]', inputs.label)) }}`), VPA), 'j@5 j@9');
t('AC6 a declared label with an undeclared one is reported', linted(secretJob('[self-hosted, voicepa-linux-arm64, gpu]'), VPA), 'j@5 j@9');
t('a runner group is reported whatever is declared', linted(secretJob('\n      group: aws\n      labels: [voicepa-linux-arm64]'), VPA), 'j@5 j@11');
t('environment and id-token on a declared AWS label lint clean', linted(wf(`  d:
    runs-on: [self-hosted, voicepa-linux-arm64]
    environment: production
    permissions:
      id-token: write
    steps: [{ run: 'true' }]
`), VPA), '');

// AC7: the bare self-hosted label and a GitHub-hosted one are not AWS runner labels.
const cfg = parseCiConfig('# AWS runners\naws-runner-labels: [voicepa-linux-arm64, self-hosted]\nhosted-workflows:\n  - .github/workflows/release.yml\n  - "nightly.yml"\n');
t('AC7 config names the bad label and its line', cfg.findings.map((f) => `${f.line} ${f.problem}`).join('; '), '2 self-hosted is the bare self-hosted label, not an AWS runner label');
t('AC7 the bad label is not declared', cfg.awsLabels.join(','), 'voicepa-linux-arm64');
t('hosted-workflows are read by file name', cfg.hostedWorkflows.join(','), 'release.yml,nightly.yml');
t('AC7 a GitHub-hosted label in a block list', parseCiConfig('aws-runner-labels:\n  - ubuntu-24.04-arm\n').findings.map((f) => `${f.line} ${f.problem}`).join(''), '2 ubuntu-24.04-arm is a GitHub-hosted label, not an AWS runner label');

// AC8: classify names the declared AWS label a job runs on today.
t('AC8 hosted by its secret, on an AWS label today', classify(secretJob(awsList), VPA)[0].why, 'secret DATABASE_URL (runs-on today: AWS runner voicepa-linux-arm64)');
const noSecret = wf(`  unit:
    runs-on: [self-hosted, voicepa-linux-arm64]
    steps: [{ run: 'true' }]
`);
t('AC8 self-hosted, on an AWS label today', classify(noSecret, VPA)[0].why, 'no hosted trigger (runs-on today: AWS runner voicepa-linux-arm64)');
t('AC9 with nothing declared, classify reads as today', classify(noSecret)[0].why, 'no hosted trigger (runs-on today: [self-hosted, voicepa-linux-arm64])');

// AC10: the runs-on forms Voice PA, PR Ninja and Forewatt use, each with its labels declared.
const fallback = (label) => `\${{ fromJSON(((github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository) || vars.DESK_AWS_FALLBACK == 'on') && '"ubuntu-latest"' || format('["self-hosted","${label}{0}"]', fromJSON(github.run_attempt) >= 3 && '-on-demand' || '')) }}`;
t('AC10 Voice PA ci.yml:141', linted(secretJob(fallback('voicepa-linux-arm64')), VPA), '');
t('AC10 Voice PA 8cpu', linted(secretJob(fallback('voicepa-linux-arm64-8cpu')), VPA), '');
t('AC10 Voice PA names both labels it runs on today', classify(secretJob(fallback('voicepa-linux-arm64')), VPA)[0].why,
  'secret DATABASE_URL (runs-on today: AWS runner voicepa-linux-arm64, voicepa-linux-arm64-on-demand)');
t('AC10 Voice PA with nothing declared is reported', linted(secretJob(fallback('voicepa-linux-arm64'))), 'j@5 j@9');
const PRN = { awsLabels: ['prninja-linux-arm64'] };
t('AC10 PR Ninja validate-prs.yml:62', linted(secretJob(`\${{ vars.DESK_AWS_FALLBACK == 'on' && 'ubuntu-latest' || fromJSON(format('["self-hosted","prninja-linux-arm64{0}"]', fromJSON(github.run_attempt) >= 3 && '-on-demand' || '')) }}`), PRN), '');
t('AC10 PR Ninja on its on-demand label', linted(secretJob(`\${{ vars.DESK_AWS_FALLBACK == 'on' && 'ubuntu-latest' || fromJSON('["self-hosted","prninja-linux-arm64-on-demand"]') }}`), PRN), '');
const FW = { awsLabels: ['forewatt-linux-arm64', 'forewatt-linux-arm64-8cpu', 'forewatt-linux-arm64-on-demand'] };
t('Forewatt api-ci.yml:20', linted(secretJob(fallback('forewatt-linux-arm64')), FW), '');
const smoke = (label) => wf(`  smoke:
    strategy:
      matrix:
        label: [forewatt-linux-arm64, ${label}]
    runs-on: [self-hosted, "\${{ matrix.label }}\${{ fromJSON(github.run_attempt) >= 3 && '-on-demand' || '' }}"]
    environment: ci-runners
    steps: [{ run: 'true' }]
`);
t('Forewatt ci-runners-smoke.yml:78, matrix label plus suffix', linted(smoke('forewatt-linux-arm64-8cpu'), FW), '');
t('a matrix label the repo has not declared is reported', linted(smoke('forewatt-linux-x64'), FW), 'smoke@8 smoke@9');
t('a vars value in the label itself is still a label source',
  linted(secretJob(`\${{ fromJSON(format('["self-hosted","voicepa-linux-arm64{0}"]', vars.SUFFIX)) }}`), VPA), 'j@5 j@9');
const inlineMatrix = (matrix) => wf(`  m:
    strategy:
      matrix: ${matrix}
    runs-on: \${{ matrix.label }}
    steps:
      - run: npm test
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
`);
t('an inline matrix axis is one leg per value, so its bare self-hosted leg is reported',
  linted(inlineMatrix('{ label: [self-hosted, voicepa-linux-arm64] }'), VPA), 'm@7 m@11');
t('a quoted bracket in a sibling axis does not hide the runner axis',
  linted(inlineMatrix(`{ note: ['a[b'], label: [self-hosted, voicepa-linux-arm64] }`), VPA), 'm@7 m@11');
t('an inline include entry is one label set', linted(inlineMatrix('{ include: [{ label: [self-hosted, voicepa-linux-arm64] }] }'), VPA), '');
// A computed include can add any label, so a static axis beside it does not settle where the job runs.
const computedInc = (include) => wf(`  m:
    strategy:
      matrix:
        label: [voicepa-linux-arm64]
        include: ${include}
    runs-on: \${{ matrix.label }}
    steps:
      - run: npm test
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
`);
const fromNeeds = '${{ fromJSON(needs.prepare.outputs.extra) }}';
t('a computed include beside a declared axis is reported', linted(computedInc(fromNeeds), VPA), 'm@9 m@13');
t('a computed include finding names the secret', lint(computedInc(fromNeeds), VPA).at(-1).problem, 'can run self-hosted but receives secret DATABASE_URL');
t('a computed include item in a flow list is reported', linted(computedInc(`[${fromNeeds}]`), VPA), 'm@9 m@13');
t('a computed include item in a block list is reported', linted(computedInc(`\n          - ${fromNeeds}`), VPA), 'm@10 m@14');
t('a quoted computed include is reported', linted(computedInc(`'${fromNeeds}'`), VPA), 'm@9 m@13');
t('a quoted computed include item in a flow list is reported', linted(computedInc(`["${fromNeeds}"]`), VPA), 'm@9 m@13');
t('a quoted computed include item in a block list is reported', linted(computedInc(`\n          - "${fromNeeds}"`), VPA), 'm@10 m@14');
t('a computed include on the line after its key is reported', linted(computedInc(`\n          ${fromNeeds}`), VPA), 'm@10 m@14');
t('a computed include in an inline matrix is reported',
  linted(inlineMatrix(`{ label: [voicepa-linux-arm64], include: "${fromNeeds}" }`), VPA), 'm@7 m@11');
t('an include field inside an inline axis value is not the matrix\'s',
  linted(inlineMatrix(`{ label: [ubuntu-latest], cfg: [{ include: "${fromNeeds}" }] }`)), '');
t('an include field inside a block axis value is not the matrix\'s', linted(wf(`  m:
    strategy:
      matrix:
        os: [ubuntu-latest]
        cfg:
          - include: ${fromNeeds}
    runs-on: \${{ matrix.os }}
    steps:
      - run: npm test
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
`)), '');
t('a static include beside a declared axis lints clean', linted(computedInc('[{ label: voicepa-linux-arm64-8cpu }]'), VPA), '');
t('a computed exclude only removes, so it lints clean', linted(computedInc('[]').replace('include: []', `exclude: ${fromNeeds}`), VPA), '');

// A flow list may run on over several lines, its closing bracket at the key's own indent.
const multiline = (labels) => secretJob(`[\n${labels.map((l) => `      ${l}`).join(',\n')}\n    ]`);
t('a runs-on list over several lines on a hosted label lints clean', linted(multiline(['ubuntu-latest'])) + linted(multiline(['ubuntu-latest']), VPA), '');
t('a runs-on list over several lines on a declared label lints clean', linted(multiline(['self-hosted', 'voicepa-linux-arm64']), VPA), '');
const multiCfg = parseCiConfig('aws-runner-labels: [\n  voicepa-linux-arm64,\n  self-hosted\n]\nhosted-workflows: [\n  release.yml\n]\n');
t('a config list over several lines is read whole', `${multiCfg.awsLabels} ${multiCfg.hostedWorkflows} ${multiCfg.findings.length}`, 'voicepa-linux-arm64 release.yml 1');
t('a config list continued at the key\'s own indent is read whole', parseCiConfig('hosted-workflows: [release.yml,\nnightly.yml]\n').hostedWorkflows.join(','), 'release.yml,nightly.yml');

// AC9: with no AWS labels declared, an expression reads as it always has: a quoted literal counts.
const tagged = secretJob(`\${{ startsWith(github.ref, 'refs/tags') && 'macos-latest' || 'ubuntu-latest' }}`);
t('AC9 a quoted literal in an expression is a label when nothing is declared', linted(tagged), 'j@5 j@9');
t('the same expression with labels declared picks only hosted labels', linted(tagged, VPA), '');

// AC13: the Dependabot branch is needed only where runs-on can pick an undeclared self-hosted label.
t('AC13 no Dependabot branch on a declared AWS label', linted(noSecret, VPA), '');
t('AC13 still needed on an undeclared label', linted(noSecret), 'unit@5');
t('a Dependabot branch to a declared AWS label passes',
  linted(wf(`  u:\n    runs-on: \${{ github.actor == 'dependabot[bot]' && 'voicepa-linux-arm64' || 'self-hosted' }}\n    steps: [{ run: 'true' }]\n`), VPA), '');

// AC11 and AC12: a workflow kept on GitHub-hosted runners.
const keptHosted = wf(`  ok:
    runs-on: ubuntu-latest
    steps: [{ run: 'true' }]
  aws:
    runs-on: [self-hosted, voicepa-linux-arm64]
    steps: [{ run: 'true' }]
  call:
    uses: ./.github/workflows/build.yml
`);
const HOSTED = { ...VPA, hostedWorkflow: true };
t('AC11 a hosted workflow job that can leave GitHub-hosted runners is a finding', linted(keptHosted, HOSTED), 'aws@8');
t('AC11 the finding names the config', lint(keptHosted, HOSTED)[0].problem, 'is in a workflow listed under hosted-workflows in .github/desk-ci.yml but runs-on can pick a runner that is not GitHub-hosted');
t('AC12 every job of a hosted workflow is placed hosted', placed(keptHosted, HOSTED), 'ok=hosted@4 aws=hosted@7 call=hosted@10');
t('AC12 the reason is hosted-workflows', classify(keptHosted, HOSTED)[0].why, 'hosted-workflows (.github/desk-ci.yml)');

// The CLI reads .github/desk-ci.yml from the repo holding the workflows.
const repo = scratch('desk-ci-repo-');
try {
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(repo, '.github/workflows/ci.yml'), secretJob(awsList));
  writeFileSync(join(repo, '.github/workflows/release.yml'), keptHosted);
  const bin = join(dirname(fileURLToPath(import.meta.url)), '../desk/bin/desk-ci.mjs');
  const run = (cmd) => { try { return { status: 0, out: execFileSync(process.execPath, [bin, cmd], { cwd: repo, encoding: 'utf8' }) }; } catch (e) { return { status: e.status, out: String(e.stdout) }; } };
  const before = run('ci-lint');
  t('AC9 with no desk-ci.yml the CLI reports as today', before.out.split('\n').filter((l) => / {2}j {2}/.test(l)).length, 2);
  writeFileSync(join(repo, '.github/desk-ci.yml'), 'aws-runner-labels: [voicepa-linux-arm64, ubuntu-latest]\nhosted-workflows: [release.yml]\n');
  const after = run('ci-lint');
  t('cli ci-lint names the config label and the hosted-workflows job, nothing for the AWS job', after.out.trim().split('\n').join(' | '),
    '.github/desk-ci.yml:1  aws-runner-labels  ubuntu-latest is a GitHub-hosted label, not an AWS runner label | .github/workflows/release.yml:8  aws  is in a workflow listed under hosted-workflows in .github/desk-ci.yml but runs-on can pick a runner that is not GitHub-hosted | summary: findings=2');
  t('cli ci-lint fails on those', after.status, 1);
  const cls = run('classify').out.trim().split('\n');
  t('cli classify names the AWS label', cls[0], '.github/workflows/ci.yml:9  j  hosted  secret DATABASE_URL (runs-on today: AWS runner voicepa-linux-arm64)');
  t('cli classify places the hosted workflow', cls[2], '.github/workflows/release.yml:7  aws  hosted  hosted-workflows (.github/desk-ci.yml) (runs-on today: AWS runner voicepa-linux-arm64)');
} finally { rmSync(repo, { recursive: true, force: true }); }

// The CLI over a directory: classify lines and summary, ci-lint exit status.
const dir = scratch('desk-ci-');
try {
  writeFileSync(join(dir, 'a.yml'), jobSecret);
  writeFileSync(join(dir, 'b.yaml'), tokenOnly);
  writeFileSync(join(dir, 'notes.txt'), 'not a workflow');
  const bin = join(dirname(fileURLToPath(import.meta.url)), '../desk/bin/desk-ci.mjs');
  const out = execFileSync(process.execPath, [bin, 'classify', dir], { encoding: 'utf8' }).trim().split('\n');
  t('cli classify cites file:line', out[0], `${join(dir, 'a.yml')}:9  e2e  hosted  secret API_KEY`);
  t('cli classify summary', out.at(-1), 'summary: jobs=2 hosted=1 self-hosted=1');
  let status = 0; let lintOut = '';
  try { lintOut = execFileSync(process.execPath, [bin, 'ci-lint', dir], { encoding: 'utf8' }); }
  catch (e) { status = e.status; lintOut = String(e.stdout); }
  t('cli ci-lint fails on a finding', status, 1);
  t('cli ci-lint names job and line', lintOut.split('\n')[0].startsWith(`${join(dir, 'a.yml')}:9  e2e  can run self-hosted but receives secret API_KEY`), true);
  let clean = 0;
  try { execFileSync(process.execPath, [bin, 'ci-lint', join(dir, 'b.yaml')], { encoding: 'utf8' }); } catch (e) { clean = e.status; }
  t('cli ci-lint passes a clean workflow', clean, 0);
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
