// suite: desk-ci (classify placement, ci-lint secret safety)
// desk-ci.mjs on fixture workflows: each hosted trigger places its job hosted and cites its line,
// a job with none is placed self-hosted, and ci-lint fails a self-hostable job that receives a
// secret, an environment or id-token, or whose runs-on has no Dependabot branch.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, lint } from '../desk/bin/desk-ci.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const placed = (yml) => classify(yml).map((r) => `${r.job}=${r.placement}@${r.line}`).join(' ');
const linted = (yml) => lint(yml).map((r) => `${r.job}@${r.line}`).join(' ');

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

// This repo's own workflow: a hosted-only matrix and a hosted label, so nothing to lint.
const own = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../.github/workflows/tests.yml'), 'utf8');
t('own workflow classifies', placed(own), 'suite=self-hosted@18 tests=self-hosted@70');
t('own workflow lints clean', linted(own), '');

// The CLI over a directory: classify lines and summary, ci-lint exit status.
const dir = mkdtempSync(join(tmpdir(), 'desk-ci-'));
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
