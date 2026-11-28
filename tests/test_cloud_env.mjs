// suite: cloud environment (desk-setup's Cloud environment step: setup script, hosts, smoke)
// layer: L2
// covers: desk/bin/cloud-env.mjs desk/bin/cloud-smoke.mjs skills/desk-setup/references/step-1-cloud-env.md
// cloud-env.mjs on scratch checkouts: the setup script for a repo with each marker and with none, the
// script running (a failing step, no checkout found, and a no-op block), the hosts and variable names
// from env files, the smoke checks from §4 rows, the smoke verdict, and cloud-smoke.mjs running the
// smoke. Scratch directories only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { detect, stepsOf, setupScript, repoBlock, guardOpen, guardClose, envHosts, envFilesOf, clerkHost, smokeChecks, smokePrompt, smokeVerdict, versionOf, REGISTRY_MIRROR, SMOKE_FILE, SHARED_VARS_NOTE, cloudEnvVars } from '../desk/bin/cloud-env.mjs';
import { CLOUD_ENV_VAR } from '../desk/bin/cloud-worker.mjs';
import { parseCloudEnv } from '../desk/bin/config-schema.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(ok ? `ok   ${name}` : `FAIL ${name}: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`); };
const S = scratch('desk-cloud-env-');
let n = 0;
const repo = (files) => {
  const root = join(S, `r${n++}`);
  mkdirSync(root, { recursive: true });
  for (const [f, body] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), typeof body === 'string' ? body : JSON.stringify(body)); }
  return root;
};
const whats = (root) => stepsOf(detect(root)).map((s) => s.what);

// ---- no markers: a no-op script -------------------------------------------------------------------
const bare = repo({ 'README.md': '# hi\n' });
t('AC6 a repo with no markers has no steps', whats(bare), []);
const bareScript = setupScript(bare, 'acme/bare');
t('AC6 its script is a no-op block between its guards', bareScript.includes(`${guardOpen('acme/bare')}\n`) && bareScript.includes(guardClose('acme/bare')) && !bareScript.includes('desk_find_checkout'), true);
let r = spawnSync('bash', ['-c', bareScript], { encoding: 'utf8' });
t('AC6 the no-op script runs clean and prints nothing', [r.status, r.stdout, r.stderr], [0, '', '']);
t('AC2 the script header says every variable reaches every repo sharing the environment', bareScript.split('\n').slice(0, 3).includes(`# ${SHARED_VARS_NOTE}`) && /every desk repo's sessions/.test(SHARED_VARS_NOTE), true);

// ---- toolchain pins ------------------------------------------------------------------------------
t('versionOf reads a range and a v-prefix', [versionOf('>=20.10 <22'), versionOf('v18.19.0\n'), versionOf('lts/iron')], ['20.10', '18.19.0', null]);
const tv = detect(repo({ '.tool-versions': 'nodejs 20.11.0\nbun 1.1.8\npython 3.12.1\nterraform 1.6.0\n' }));
t('AC1 .tool-versions pins node, bun and python', tv.toolchain,
  [{ tool: 'node', version: '20.11.0', from: '.tool-versions' }, { tool: 'bun', version: '1.1.8', from: '.tool-versions' }, { tool: 'python', version: '3.12.1', from: '.tool-versions' }]);
t('AC1 any other .tool-versions pin is kept, not dropped', tv.other, [{ tool: 'terraform', version: '1.6.0', from: '.tool-versions' }]);
const tfStep = stepsOf(tv).find((s) => s.what.startsWith('terraform'));
r = spawnSync('bash', ['-c', tfStep.cmd], { encoding: 'utf8' });
t('AC1 its step says it is not installed and why', [tfStep.what, r.status, r.stderr.includes('terraform 1.6.0 is pinned in .tool-versions but not installed: desk installs node, bun and python pins only')],
  ['terraform 1.6.0 (.tool-versions): not installed', 0, true]);
t('AC5 the smoke checks the other pin too', smokeChecks({}, [...tv.toolchain, ...tv.other])[1].how.includes('terraform 1.6.0'), true);
t('AC1 .nvmrc pins node', detect(repo({ '.nvmrc': 'v22\n' })).toolchain, [{ tool: 'node', version: '22', from: '.nvmrc' }]);
t('AC1 package.json engines pins node when no file does', detect(repo({ 'package.json': { engines: { node: '>=20.10' } } })).toolchain, [{ tool: 'node', version: '20.10', from: 'package.json engines' }]);
t('AC1 .tool-versions wins over .nvmrc', detect(repo({ '.tool-versions': 'nodejs 20.1.0\n', '.nvmrc': '18' })).toolchain[0].version, '20.1.0');
const nodeStep = stepsOf(detect(repo({ '.nvmrc': '20' })))[0].cmd;
t('AC1 node is installed directly with n, not through mise', nodeStep.includes('n \'20\'') && !nodeStep.includes('mise'), true);

// ---- package manager ------------------------------------------------------------------------------
t('AC1 pnpm-lock.yaml installs with pnpm, frozen', whats(repo({ 'package.json': { packageManager: 'pnpm@9.1.0' }, 'pnpm-lock.yaml': '' })), ['pnpm install (pnpm-lock.yaml)']);
t('AC1 pnpm activates the pinned packageManager', stepsOf(detect(repo({ 'package.json': { packageManager: 'pnpm@9.1.0' }, 'pnpm-lock.yaml': '' })))[0].cmd,
  'corepack enable && corepack prepare pnpm@9.1.0 --activate && pnpm install --frozen-lockfile');
t('AC1 package-lock.json installs with npm ci', stepsOf(detect(repo({ 'package.json': {}, 'package-lock.json': '{}' })))[0].cmd, 'npm ci');
t('AC1 yarn berry installs --immutable', stepsOf(detect(repo({ 'package.json': { packageManager: 'yarn@4.1.0' }, 'yarn.lock': '' })))[0].cmd.endsWith('yarn install --immutable'), true);
t('AC1 yarn.lock beside bun.lock is yarn, as test-scope.mjs reads it', detect(repo({ 'package.json': {}, 'yarn.lock': '', 'bun.lock': '' })).pm.name, 'yarn');
t('AC1 bun.lock installs bun first, then bun install', whats(repo({ 'package.json': {}, 'bun.lock': '' })), ['bun latest (bun.lock)', 'bun install (bun.lock)']);
t('AC1 a uv.lock in a subfolder installs there, after uv', whats(repo({ 'apps/api/uv.lock': '', 'apps/api/pyproject.toml': '' })), ['uv', 'python install (apps/api/uv.lock)']);

// ---- ORM, Playwright, compose -------------------------------------------------------------------
const mono = repo({
  'package.json': { packageManager: 'pnpm@9.1.0' }, 'pnpm-lock.yaml': '',
  'packages/db/package.json': { dependencies: { '@prisma/client': '5' }, devDependencies: { prisma: '5' } },
  'apps/web/package.json': { devDependencies: { '@playwright/test': '1.48' } },
  'docker-compose.yml': 'services: {}\n',
  'node_modules/x/package.json': { dependencies: { prisma: '1' } },
});
t('AC1 a monorepo gets install, prisma generate where prisma is, Playwright where it is, and compose', whats(mono), [
  'pnpm install (pnpm-lock.yaml)', 'prisma generate in packages/db', 'Playwright browsers for apps/web',
  `Docker registry mirror ${REGISTRY_MIRROR}`, 'docker compose pull (docker-compose.yml)']);
const monoSteps = stepsOf(detect(mono));
t('AC1 prisma generate runs through the package manager in its folder', monoSteps[1].cmd, "cd 'packages/db' && pnpm exec prisma generate");
t('AC1 the Playwright step installs chromium with its deps', monoSteps[2].cmd, "cd 'apps/web' && pnpm exec playwright install --with-deps chromium");
t('AC1 the registry mirror is mirror.gcr.io in daemon.json', monoSteps[3].cmd.includes('mirror.gcr.io') && monoSteps[3].cmd.includes('/etc/docker/daemon.json'), true);

// ---- the script runs ------------------------------------------------------------------------------
const monoScript = setupScript(mono, 'acme/mono');
r = spawnSync('bash', ['-n', '-c', monoScript], { encoding: 'utf8' });
t('AC1 the generated script is valid bash', [r.status, r.stderr], [0, '']);
t('AC1 the checkout is found by searching for its origin, not assumed', monoScript.includes('desk_find_checkout') && monoScript.includes('remote get-url origin') && !monoScript.includes('CLAUDE_PROJECT_DIR'), true);
const joined = `${monoScript}\n${repoBlock('acme/other', [{ what: 'say hi', cmd: 'echo hi' }])}\n`;
r = spawnSync('bash', ['-n', '-c', joined], { encoding: 'utf8' });
t('AC2 two repos\' blocks joined under their guards are valid bash', [r.status, joined.split('# ---- desk: ').length - 1], [0, 2]);
// The checkout search is stubbed: once to find a folder, where a failing step does not stop the
// script, and once to find nothing, where the block skips without running a step.
const fake = repoBlock('nobody-owns/this-repo-xyz', [{ what: 'never', cmd: 'exit 1' }]);
const stub = (body) => fake.replace(/desk_find_checkout\(\) \{[\s\S]*?\n\}/, `desk_find_checkout() { ${body} }`);
const failing = stub('echo /tmp;').replace("desk_step 'never' 'exit 1'", "desk_step 'never' 'exit 1'\n  desk_step 'after' 'echo went-on'");
r = spawnSync('bash', ['-c', failing], { encoding: 'utf8' });
t('AC1 a failing step is named and the script goes on', [r.status, r.stderr.includes('FAILED: never'), r.stdout.includes('went-on')], [0, true, true]);
r = spawnSync('bash', ['-c', stub('true;')], { encoding: 'utf8' });
t('AC1 a block with no checkout of its repo skips, says so, and exits 0',
  [r.status, r.stdout.trim(), r.stderr], [0, 'desk setup: no checkout of nobody-owns/this-repo-xyz in this container, skipped', '']);

// ---- hosts and variable names ----------------------------------------------------------------------
const pk = `pk_test_${Buffer.from('noted-ox-12.clerk.accounts.dev$').toString('base64')}`;
t('AC3 a Clerk publishable key names its frontend host', clerkHost(pk), 'noted-ox-12.clerk.accounts.dev');
const eh = envHosts({
  '.env.example': `DATABASE_URL=postgres://u:p@localhost:5432/db\nNEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${pk}\nCLERK_SECRET_KEY=sk_test_abc\nexport SENTRY_DSN="https://key@o1.ingest.sentry.io/2"\n# COMMENTED=https://nope.example\n`,
  'apps/web/.env.local': 'API_URL=https://api.acme.dev/v1 # prod\nEMPTY=\n',
});
t('AC3 the hosts env values point at, local ones left out', eh.hosts.map((h) => h.host), ['api.acme.dev', 'api.clerk.com', 'noted-ox-12.clerk.accounts.dev', 'o1.ingest.sentry.io']);
const look = envHosts({ '.env': 'A=https://localhost.example.com\nB=http://127.example.com/x\nC=http://127.0.0.1:3000\nD=http://0.0.0.0:80\nE=http://api.local\nF=http://host.docker.internal:5432\nG=http://localhost:3000\n' });
t('AC3 a lookalike of a local name is a real host; true local names are left out', look.hosts.map((h) => h.host), ['127.example.com', 'localhost.example.com']);
t('AC3 each host names the variables that point there', eh.hosts.find((h) => h.host === 'api.clerk.com').vars, ['CLERK_SECRET_KEY']);
t('AC3 every variable name, and no value', [eh.names, JSON.stringify(eh).includes('sk_test_abc'), JSON.stringify(eh).includes('u:p')],
  [['API_URL', 'CLERK_SECRET_KEY', 'DATABASE_URL', 'EMPTY', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'SENTRY_DSN'], false, false]);
const envRepo = repo({ '.env.example': 'A=1\n', 'apps/web/package.json': {}, 'apps/web/.env.local': 'B=2\n', 'docs/.env': 'C=3\n', 'custom/vars.env': 'D=4\n' });
t('AC3 env files: the row\'s, then the usual names at root and beside a package.json', envFilesOf(envRepo, ['custom/vars.env', 'missing.env']), ['custom/vars.env', '.env.example', 'apps/web/.env.local']);

// ---- the smoke session -----------------------------------------------------------------------------
const checks = smokeChecks({ services: ['postgres :5432'], migrate: ['pnpm db:migrate'], seed: ['none'], dev: ['apps/web: pnpm dev'], unit: ['pnpm test'], e2e: ['pnpm e2e'], signin: ['apps/web: dev@example.test'] },
  [{ tool: 'node', version: '20', from: '.nvmrc' }]);
t('AC5 the smoke checks follow the §4 rows, an unset or none row not asked', checks.map((c) => c.name), ['environment', 'toolchain', 'services', 'migrate', 'dev-server', 'unit-test', 'browser-test']);
t('AC5 the browser test signs in as the §4 Test sign-in user', checks.at(-1).how.includes('dev@example.test'), true);
const prompt = smokePrompt({ repo: 'acme/mono', base: 'main', branch: 'desk/cloud-smoke-1', checks });
t('AC5 the prompt sends the results to the scratch branch, and only that file', prompt.includes('`desk/cloud-smoke-1`') && prompt.includes(SMOKE_FILE) && prompt.includes('open no pull request'), true);
const asked = checks.map((c) => c.name);
const all = (status) => JSON.stringify({ checks: asked.map((name) => ({ name, status, detail: 'd' })) });
t('AC5 every check passing passes', smokeVerdict(all('pass'), asked).ok, true);
t('AC5 a fail fails, and is named', (() => { const o = JSON.parse(all('pass')); o.checks[3].status = 'fail'; const v = smokeVerdict(JSON.stringify(o), asked); return [v.ok, v.lines[3]]; })(), [false, 'FAIL migrate (fail) — d']);
t('AC5 any status but pass fails (skip, missing)', [smokeVerdict(all('skip'), asked).ok, smokeVerdict(JSON.stringify({ checks: [{ name: 'environment' }] }), asked).ok], [false, false]);
t('AC5 a check the file lacks fails', smokeVerdict(JSON.stringify({ checks: [] }), ['environment']).lines, ['FAIL environment: the session did not report it']);
t('AC5 a file that is not JSON fails', smokeVerdict('nope', asked).ok, false);
// cloud-smoke.mjs is the smoke's own entry point: in a checkout with no GitHub origin it stops at the
// repo lookup, before any login or cloud start, with runSmoke's message and exit 1.
const noOrigin = repo({ 'README.md': '' });
spawnSync('git', ['init', '-q'], { cwd: noOrigin });
const env = { ...process.env, HOME: noOrigin };
for (const k of Object.keys(env)) if (k.startsWith('DESK_')) delete env[k];
r = spawnSync(process.execPath, [join(dirname(new URL(import.meta.url).pathname), '../desk/bin/cloud-smoke.mjs')], { cwd: noOrigin, encoding: 'utf8', env });
t('AC5 cloud-smoke.mjs runs the smoke (no origin: it says so and exits 1)', [r.status, r.stderr.trim()], [1, 'cloud-env: run this inside the repo (no GitHub origin here)']);

// ---- issue-1550: config §3b "Cloud environment" in `hosts` (AC5) ----------------------------------
const fileNames = envHosts({ '.env': '# c\nDATABASE_URL=postgres://secret@db.example.com/x\nexport CLERK_SECRET_KEY="sk_live_x"\nNOT A VAR\n' }).names;
const proposed = cloudEnvVars({ names: fileNames, env: parseCloudEnv('widgets: db browser'), dbVars: ['DATABASE_URL', 'DIRECT_URL'] });
t('issue-1550 AC5 the environment\'s name is the one value desk writes', proposed.set, `${CLOUD_ENV_VAR}=widgets`);
t('issue-1550 AC5 the names are the env files\' with §4 Database URL variable\'s added, sorted', proposed.names, ['CLERK_SECRET_KEY', 'DATABASE_URL', 'DIRECT_URL']);
t('issue-1550 AC5 no value from an env file is ever proposed', /secret|sk_live/.test(JSON.stringify(proposed)), false);
t('issue-1550 AC5 without db, the database variables are not added', cloudEnvVars({ names: [], env: parseCloudEnv('w: browser'), dbVars: ['DATABASE_URL'] }), { names: [], set: `${CLOUD_ENV_VAR}=w` });
t('issue-1550 AC3 with the row unset, hosts lists the env files\' names as before', cloudEnvVars({ names: ['B', 'A', CLOUD_ENV_VAR], env: null, dbVars: ['DATABASE_URL'] }), { names: ['A', 'B'], set: null });

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
