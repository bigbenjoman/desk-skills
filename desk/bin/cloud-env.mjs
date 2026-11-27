#!/usr/bin/env node
// The cloud environment a repo at Worker location `cloud` runs in, set up and smoke-tested before the
// row turns to `cloud` (desk-setup's *Cloud environment* step). claude.ai has no API to create or edit
// an environment, so this writes and prints what the person pastes, and checks what they made:
//   cloud-env.mjs script [--write]   the repo's setup script, from what the checkout holds; --write also
//                                    writes it to cloud-setup.sh in the repo config's folder
//   cloud-env.mjs hosts              the hosts the repo's env files point at, and the variable names
//                                    (never values) the dev server and tests read
//   cloud-env.mjs first-start        the first `claude --cloud` start, under the repo's Subscription login
//   cloud-env.mjs smoke [--timeout <minutes>]
//                                    `desk cloud-smoke`: a smoke session under that login, its results read
//                                    from a scratch branch that is then deleted; exit 0 only when every
//                                    check passed
//
// The script is repo-agnostic: one environment serves every desk repo (`claude --cloud` reuses the
// last-used environment, not one matched to the repo), so each repo's part is a block between guard
// lines, self-contained, and several repos' blocks are joined one after another. A block finds its
// checkout by searching for a clone whose origin names the repo: the setup script does not run in the
// checkout, and CLAUDE_PROJECT_DIR does not point at it. Toolchains are installed directly (n, the bun
// installer, uv), not through mise, which did not install the pins in the container. Each step is
// written only where its marker is in the repo, so a repo with none gets a no-op block. A step that
// fails says so and the script goes on: a failing setup script stops the session from starting at all,
// and the smoke session names what is missing.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REGISTRY_MIRROR = 'https://mirror.gcr.io';
export const SMOKE_FILE = '.desk-cloud-smoke.json';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'vendor', '.venv', 'venv', 'coverage']);
const COMPOSE = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const ENV_FILES = ['.env.example', '.env.sample', '.env.template', '.env.local.example', '.env', '.env.local', '.env.development', '.env.development.local', '.env.test'];

const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const readJson = (p) => { const s = readText(p); if (s == null) return null; try { return JSON.parse(s); } catch { return null; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// The directories under `root` to `depth` levels, root first, skipping dependency and build folders.
function dirsOf(root, depth = 3) {
  const out = ['.'];
  const walk = (rel, d) => {
    if (d >= depth) return;
    let names = [];
    try { names = readdirSync(join(root, rel)).sort(); } catch { return; }
    for (const n of names) {
      if (SKIP_DIRS.has(n) || n.startsWith('.')) continue;
      const r = rel === '.' ? n : `${rel}/${n}`;
      if (isDir(join(root, r))) { out.push(r); walk(r, d + 1); }
    }
  };
  walk('.', 0);
  return out;
}

// A version out of a pin: `v20.11.0` -> 20.11.0, `>=20.10 <22` -> 20.10, `lts/iron` -> null.
export function versionOf(s) {
  const m = /(\d+(?:\.\d+){0,2})/.exec(String(s ?? ''));
  return m ? m[1] : null;
}

// What the setup script installs for the checkout at `root`:
//   { toolchain: [{ tool, version, from }], pm: { name, lock, install, exec } | null,
//     python: [{ dir, lock, install }], prisma: [dir], playwright: [dir], compose: [file] }
export function detect(root) {
  const dirs = dirsOf(root);
  const pkgs = dirs.map((d) => ({ dir: d, pkg: readJson(join(root, d, 'package.json')) })).filter((p) => p.pkg);
  const rootPkg = readJson(join(root, 'package.json'));
  const toolchain = [];
  const pin = (tool, version, from) => { if (version && !toolchain.some((t) => t.tool === tool)) toolchain.push({ tool, version, from }); };

  // .tool-versions first, then the single-tool files, then package.json.
  for (const line of (readText(join(root, '.tool-versions')) ?? '').split('\n')) {
    const [name, ver] = line.replace(/#.*/, '').trim().split(/\s+/);
    const tool = { nodejs: 'node', node: 'node', bun: 'bun', python: 'python' }[name];
    if (tool) pin(tool, versionOf(ver), '.tool-versions');
  }
  for (const f of ['.nvmrc', '.node-version']) pin('node', versionOf(readText(join(root, f))), f);
  pin('python', versionOf(readText(join(root, '.python-version'))), '.python-version');
  pin('node', versionOf(rootPkg?.engines?.node), 'package.json engines');
  pin('bun', versionOf(rootPkg?.engines?.bun), 'package.json engines');
  const [pmName, pmVer] = String(rootPkg?.packageManager ?? '').split('@');
  if (pmName === 'bun') pin('bun', versionOf(pmVer), 'package.json packageManager');

  // The package manager, from the root lockfile.
  let pm = null;
  const has = (f) => existsSync(join(root, f));
  const corepack = rootPkg?.packageManager ? `corepack enable && corepack prepare ${rootPkg.packageManager} --activate && ` : 'corepack enable && ';
  if (has('pnpm-lock.yaml')) pm = { name: 'pnpm', lock: 'pnpm-lock.yaml', install: `${corepack}pnpm install --frozen-lockfile`, exec: 'pnpm exec' };
  else if (has('bun.lock') || has('bun.lockb')) pm = { name: 'bun', lock: has('bun.lock') ? 'bun.lock' : 'bun.lockb', install: 'bun install --frozen-lockfile', exec: 'bunx' };
  else if (has('yarn.lock')) {
    const classic = !pmVer || pmName !== 'yarn' || /^1\./.test(pmVer);
    pm = { name: 'yarn', lock: 'yarn.lock', install: `${corepack}yarn install ${classic ? '--frozen-lockfile' : '--immutable'}`, exec: 'yarn' };
  } else if (has('package-lock.json')) pm = { name: 'npm', lock: 'package-lock.json', install: 'npm ci', exec: 'npx' };
  if (pm?.name === 'bun' && !toolchain.some((t) => t.tool === 'bun')) pin('bun', 'latest', pm.lock);

  // Python projects, wherever their lockfile is.
  const python = [];
  for (const d of dirs) {
    const at = (f) => existsSync(join(root, d, f));
    if (at('uv.lock')) python.push({ dir: d, lock: 'uv.lock', install: 'uv sync --frozen' });
    else if (at('poetry.lock')) python.push({ dir: d, lock: 'poetry.lock', install: 'pip install --quiet poetry && poetry install --no-interaction' });
    else if (at('Pipfile.lock')) python.push({ dir: d, lock: 'Pipfile.lock', install: 'pip install --quiet pipenv && pipenv sync --dev' });
  }

  const deps = (p) => ({ ...p.dependencies, ...p.devDependencies });
  const prisma = pkgs.filter((p) => 'prisma' in deps(p.pkg) || '@prisma/client' in deps(p.pkg)).map((p) => p.dir);
  const playwright = pkgs.filter((p) => '@playwright/test' in deps(p.pkg) || 'playwright' in deps(p.pkg)).map((p) => p.dir);
  const compose = dirs.filter((d) => d.split('/').length <= 2 || d === '.')
    .flatMap((d) => COMPOSE.filter((f) => existsSync(join(root, d, f))).map((f) => (d === '.' ? f : `${d}/${f}`)));
  return { toolchain, pm, python, prisma, playwright, compose };
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const inDir = (dir, cmd) => (dir === '.' ? cmd : `cd ${q(dir)} && ${cmd}`);

// The install commands for one pin, each a shell string.
function installOf({ tool, version }) {
  if (tool === 'node') {
    return `case "$(node -v 2>/dev/null)" in v${version}|v${version}.*) echo "node $(node -v) already here" ;; *) npm install -g n >/dev/null && n ${q(version)} && hash -r ;; esac`;
  }
  if (tool === 'bun') {
    const tag = version === 'latest' ? '' : ` -s ${q(`bun-v${version}`)}`;
    return `curl -fsSL https://bun.sh/install | bash${tag} && ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun && ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bunx`;
  }
  return `{ command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh; } && uv python install ${q(version)} && ln -sf "$(uv python find ${q(version)})" /usr/local/bin/python3`;
}

// The steps for what detect() found, in the order they run: [{ what, cmd }].
export function stepsOf(d) {
  const steps = d.toolchain.map((t) => ({ what: `${t.tool} ${t.version} (${t.from})`, cmd: installOf(t) }));
  if (d.python.length && !d.toolchain.some((t) => t.tool === 'python')) {
    steps.push({ what: 'uv', cmd: 'command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh' });
  }
  if (d.pm) steps.push({ what: `${d.pm.name} install (${d.pm.lock})`, cmd: d.pm.install });
  for (const p of d.python) steps.push({ what: `python install (${p.dir === '.' ? '' : `${p.dir}/`}${p.lock})`, cmd: inDir(p.dir, p.install) });
  const exec = d.pm?.exec ?? 'npx';
  for (const dir of d.prisma) steps.push({ what: `prisma generate${dir === '.' ? '' : ` in ${dir}`}`, cmd: inDir(dir, `${exec} prisma generate`) });
  for (const dir of d.playwright) steps.push({ what: `Playwright browsers${dir === '.' ? '' : ` for ${dir}`}`, cmd: inDir(dir, `${exec} playwright install --with-deps chromium`) });
  if (d.compose.length) {
    steps.push({ what: `Docker registry mirror ${REGISTRY_MIRROR}`, cmd: dockerMirror() });
    for (const f of d.compose) steps.push({ what: `docker compose pull (${f})`, cmd: `docker compose -f ${q(f)} pull` });
  }
  return steps;
}

// Points dockerd at the registry mirror, so pulls from the shared egress are not refused with 429 by
// Docker Hub's anonymous limit, and restarts it once the mirror is new.
function dockerMirror() {
  return [
    'command -v docker >/dev/null || { echo "docker is not installed in this container"; exit 1; }',
    'mkdir -p /etc/docker',
    `if ! grep -qs ${q(REGISTRY_MIRROR)} /etc/docker/daemon.json; then`,
    `  if [ -s /etc/docker/daemon.json ]; then python3 -c 'import json,sys; p="/etc/docker/daemon.json"; d=json.load(open(p)); d.setdefault("registry-mirrors",[]).append(sys.argv[1]); json.dump(d,open(p,"w"),indent=2)' ${q(REGISTRY_MIRROR)}`,
    `  else printf '{"registry-mirrors": ["%s"]}\\n' ${q(REGISTRY_MIRROR)} > /etc/docker/daemon.json; fi`,
    '  service docker restart 2>/dev/null || systemctl restart docker 2>/dev/null || { pkill dockerd; (dockerd >/var/log/dockerd.log 2>&1 &); }',
    'fi',
    'for _ in 1 2 3 4 5 6 7 8 9 10; do docker info >/dev/null 2>&1 && break; sleep 2; done; docker info >/dev/null',
  ].join('\n');
}

const fnName = (ghRepo) => `desk_setup_${String(ghRepo).replace(/[^A-Za-z0-9]/g, '_')}`;
export const guardOpen = (ghRepo) => `# ---- desk: ${ghRepo} ----`;
export const guardClose = (ghRepo) => `# ---- end desk: ${ghRepo} ----`;

// One repo's block of the setup script, between its guard lines. With no steps it is a no-op: it does
// not even search for the checkout.
export function repoBlock(ghRepo, steps) {
  const fn = fnName(ghRepo);
  if (!steps.length) return [guardOpen(ghRepo), `# Nothing in ${ghRepo} needs setting up: no toolchain pin, lockfile, ORM client, Playwright or compose file.`, ':', guardClose(ghRepo)].join('\n');
  return [
    guardOpen(ghRepo),
    '# Generated by desk-setup (cloud-env.mjs script). Re-run it after the repo changes; edit nothing between the guards.',
    '# The checkout is found by search: the setup script does not run in it.',
    'desk_find_checkout() {',
    "  find / -maxdepth 5 \\( -path /proc -o -path /sys -o -path /dev -o -path /usr -o -name node_modules \\) -prune -o -type d -name .git -print 2>/dev/null |",
    '    while IFS= read -r g; do',
    '      case "$(git -C "${g%/.git}" remote get-url origin 2>/dev/null)" in *"$1"|*"$1.git"|*"$1/") echo "${g%/.git}"; break ;; esac',
    '    done',
    '}',
    'desk_step() { echo "desk setup: $1"; ( eval "$2" ) || echo "desk setup: FAILED: $1 (exit $?)" >&2; }',
    `${fn}() {`,
    `  local dir; dir="$(desk_find_checkout ${q(ghRepo)})"`,
    `  [ -n "$dir" ] || { echo "desk setup: no checkout of ${ghRepo} in this container, skipped"; return 0; }`,
    `  cd "$dir" || return 0`,
    `  echo "desk setup: ${ghRepo} in $dir"`,
    ...steps.map((s) => `  desk_step ${q(s.what)} ${q(s.cmd)}`),
    '}',
    `( ${fn} )`,
    guardClose(ghRepo),
  ].join('\n');
}

// The whole script for the checkout at `root` of `ghRepo`.
export function setupScript(root, ghRepo) {
  return `#!/bin/bash\n# desk cloud environment setup. One environment serves every desk repo: paste each repo's block, guards and all, one after another.\n${repoBlock(ghRepo, stepsOf(detect(root)))}\n`;
}

// ---- hosts and variable names ----------------------------------------------------------------------
const LOCAL = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal$|.*\.local$|.*\.localhost$)/;

// The env files to read: §4 Env files' items, then the usual names beside each package.json and at root.
export function envFilesOf(root, rowItems = []) {
  const files = new Set(rowItems.map((f) => String(f).trim()).filter((f) => f && f !== 'none'));
  for (const d of dirsOf(root)) {
    if (d !== '.' && !existsSync(join(root, d, 'package.json')) && !existsSync(join(root, d, 'pyproject.toml'))) continue;
    for (const f of ENV_FILES) if (existsSync(join(root, d, f))) files.add(d === '.' ? f : `${d}/${f}`);
  }
  return [...files].filter((f) => existsSync(join(root, f)));
}

// A Clerk publishable key names its frontend API host: pk_test_<base64 of "<host>$">.
export function clerkHost(value) {
  const m = /^pk_(?:test|live)_([A-Za-z0-9+/=_-]+)$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const host = Buffer.from(m[1], 'base64').toString('utf8').replace(/\$$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? host : null;
}

// From env file texts ({ file: text }): every variable name, and every non-local host a value points
// at with the names that point there. Values are read only to find hosts and are never returned.
//   -> { names: [name], hosts: [{ host, vars: [name] }] }
export function envHosts(texts) {
  const names = new Set();
  const hosts = new Map();
  const add = (host, name) => { host = host.toLowerCase(); if (LOCAL.test(host)) return; if (!hosts.has(host)) hosts.set(host, new Set()); hosts.get(host).add(name); };
  for (const text of Object.values(texts)) {
    for (const line of String(text ?? '').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, name, raw] = m;
      names.add(name);
      const value = raw.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
      for (const u of value.matchAll(/[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([A-Za-z0-9.-]+)/gi)) add(u[1], name);
      const ch = clerkHost(value);
      if (ch) add(ch, name);
      if (/^CLERK_SECRET_KEY$/.test(name) && value) add('api.clerk.com', name);
    }
  }
  return {
    names: [...names].sort(),
    hosts: [...hosts].map(([host, vars]) => ({ host, vars: [...vars].sort() })).sort((a, b) => a.host.localeCompare(b.host)),
  };
}

// ---- the smoke session --------------------------------------------------------------------------
export const SMOKE_CHECKS = ['environment', 'toolchain', 'services', 'migrate', 'seed', 'dev-server', 'unit-test', 'browser-test'];

// The checks to ask for, each with what the session is to do, from the config rows (null or [] where a
// row is unset or `none`) and the detected toolchain. A check whose row is unset is not asked.
//   rows: { services, migrate, seed, dev, unit, e2e, signin } -> [{ name, how }]
export function smokeChecks(rows, toolchain = []) {
  const list = (v) => [].concat(v ?? []).filter((x) => x && String(x).trim() && String(x).trim() !== 'none');
  const code = (xs) => xs.map((x) => `\`${x}\``).join(', then ');
  const out = [{ name: 'environment', how: 'Say which directory the checkout is in, and confirm the setup script ran: its "desk setup:" lines, or that it printed none. Name any variable the dev server needs that is unset.' }];
  out.push({ name: 'toolchain', how: toolchain.length ? `Check these versions answer: ${toolchain.map((t) => `${t.tool} ${t.version}`).join(', ')}.` : 'Report node, python and bun versions present; nothing is pinned.' });
  const r = Object.fromEntries(Object.entries(rows ?? {}).map(([k, v]) => [k, list(v)]));
  if (r.services?.length) out.push({ name: 'services', how: `Start these compose services and check each answers on its port: ${code(r.services)}.` });
  if (r.migrate?.length) out.push({ name: 'migrate', how: `Run ${code(r.migrate)}.` });
  if (r.seed?.length) out.push({ name: 'seed', how: `Run ${code(r.seed)}.` });
  if (r.dev?.length) out.push({ name: 'dev-server', how: `Start ${code(r.dev)} (an item \`dir: cmd\` runs cmd in dir), and check it answers an HTTP request; stop it after the browser test.` });
  if (r.unit?.length) out.push({ name: 'unit-test', how: `Run one test file, not the suite, with the runner ${code(r.unit)} uses.` });
  if (r.e2e?.length || r.signin?.length) {
    out.push({ name: 'browser-test', how: `Run one browser test that signs in${r.signin?.length ? ` as ${code(r.signin)}` : ''}${r.e2e?.length ? `, with the runner ${code(r.e2e)} uses` : ''}, against the dev server.` });
  }
  return out;
}

// The smoke session's whole brief: it reads nothing from this computer.
export function smokePrompt({ repo, base, branch, checks }) {
  return [
    `Smoke-test this cloud environment for ${repo}. Change no code and open no pull request. Nobody reads this session.`,
    '',
    'Run each check below in order, going on after one fails. For each, record a status: `pass` if it worked, otherwise `fail` with the error in a line.',
    '',
    ...checks.map((c, i) => `${i + 1}. \`${c.name}\`: ${c.how}`),
    '',
    `Then write the results to \`${SMOKE_FILE}\` at the checkout's root, as JSON: {"checks": [{"name": "<check>", "status": "pass" | "fail", "detail": "<one line>"}]}, one entry per check above.`,
    `Commit only that file on a new branch named exactly \`${branch}\`, cut from \`${base}\`, and push it to origin. Push nothing else.`,
  ].join('\n');
}

// What the smoke session wrote, against the checks asked. Only `pass` passes: `fail`, any other status
// and a check the file lacks all fail it. -> { ok, lines: [string] }
export function smokeVerdict(text, asked) {
  let got;
  try { got = JSON.parse(text); } catch (e) { return { ok: false, lines: [`${SMOKE_FILE} is not JSON (${e.message})`] }; }
  const rows = Array.isArray(got?.checks) ? got.checks : [];
  const lines = asked.map((name) => {
    const r = rows.find((c) => c?.name === name);
    if (!r) return `FAIL ${name}: the session did not report it`;
    const detail = r.detail ? ` — ${String(r.detail).split('\n')[0]}` : '';
    return r.status === 'pass' ? `ok   ${name}${detail}` : `FAIL ${name} (${r.status ?? 'no status'})${detail}`;
  });
  return { ok: lines.every((l) => l.startsWith('ok')), lines };
}

// ---- the commands ---------------------------------------------------------------------------------
async function repoContext() {
  const E = await import('./desk-env.mjs');
  const r = E.currentRepo();
  if (!r.ownerRepo) throw new Error('cloud-env: run this inside the repo (no GitHub origin here)');
  const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim() || process.cwd();
  return { E, ghRepo: r.ownerRepo, root, folder: E.repoConfigDir() };
}

// The environment `claude` runs under for this repo: its Subscription login's (desk-env subscription).
async function loginEnv(E) {
  const L = await import('./logins.mjs');
  const r = E.thisRepoSubscription(L, L.readSubscriptions(E.subscriptionsPath()));
  if (!r.login) throw new Error(`cloud-env: ${r.from} names ${r.email}, which no login on this computer is signed in to; sign it in first`);
  return { env: L.loginEnv(r.login), who: r.email ?? 'the default login', configDir: r.login.configDir ?? null };
}

const rowValues = (E, id) => { try { return E.configValues(id) ?? []; } catch { return []; } };

async function main(cmd, args) {
  if (cmd === 'script') {
    const { ghRepo, root, folder } = await repoContext();
    const text = setupScript(root, ghRepo);
    if (args.includes('--write')) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'cloud-setup.sh'), text);
      console.error(`wrote ${join(folder, 'cloud-setup.sh')}`);
    }
    process.stdout.write(text);
    return 0;
  }
  if (cmd === 'hosts') {
    const { E, root } = await repoContext();
    const files = envFilesOf(root, rowValues(E, 'env-files'));
    const { names, hosts } = envHosts(Object.fromEntries(files.map((f) => [f, readText(join(root, f))])));
    console.log(`FILES ${files.length ? files.join(' ') : '(none found)'}`);
    for (const h of hosts) console.log(`HOST ${h.host}\t${h.vars.join(' ')}`);
    console.log(`VARS ${names.length ? names.join(' ') : '(none)'}`);
    return 0;
  }
  if (cmd === 'first-start' || cmd === 'smoke') {
    const { E, ghRepo, root } = await repoContext();
    const { env, who, configDir } = await loginEnv(E);
    const W = await import('./cloud-worker.mjs');
    if (cmd === 'first-start') {
      const prompt = `desk-setup's first cloud start for ${ghRepo}: reply "ok" and stop. Change nothing.`;
      const name = `${ghRepo.split('/').pop()}-desk-first-start`;
      console.log(`starting claude --cloud as ${who}`);
      if (process.stdin.isTTY) return spawnSync('claude', ['--cloud', prompt, '--name', name], { stdio: 'inherit', env }).status ?? 1;
      const got = W.startCloud(prompt, { env, name });
      if (got.error) {
        console.log(`the start did not finish: ${got.error}`);
        console.log(`run it in your own terminal and answer what it asks:\n  ${configDir ? `CLAUDE_CONFIG_DIR=${q(configDir)} ` : ''}claude --cloud ${q(prompt)}`);
        return 1;
      }
      console.log(`started: ${got.url}`);
      return 0;
    }
    const at = args.indexOf('--timeout');
    const minutes = at >= 0 ? Number(args[at + 1]) : 45;
    const base = (() => { try { return E.configValue('default-branch'); } catch { return null; } })() ?? 'main';
    const branch = `desk/cloud-smoke-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}`;
    const checks = smokeChecks({
      services: rowValues(E, 'local-services'), migrate: rowValues(E, 'db-migrate-cmd'), seed: rowValues(E, 'seed-cmd'),
      dev: rowValues(E, 'dev-cmd'), unit: rowValues(E, 'test-cmd'), e2e: rowValues(E, 'e2e-cmd'), signin: rowValues(E, 'test-signin'),
    }, detect(root).toolchain);
    const got = W.startCloud(smokePrompt({ repo: ghRepo, base, branch, checks }), { env, name: `${ghRepo.split('/').pop()}-desk-cloud-smoke` });
    if (got.error) { console.log(`FAIL the smoke session did not start: ${got.error}`); return 1; }
    console.log(`smoke session ${got.url}, as ${who}; waiting up to ${minutes} min for ${branch}`);
    const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    const until = Date.now() + minutes * 60_000;
    while (!git('ls-remote', '--heads', 'origin', branch).stdout.trim()) {
      if (Date.now() > until) { console.log(`FAIL no ${branch} on origin after ${minutes} min: see ${got.url}`); return 1; }
      spawnSync('sleep', ['20']);
    }
    const fetched = git('fetch', '--quiet', 'origin', branch);
    const text = fetched.status === 0 ? git('show', `FETCH_HEAD:${SMOKE_FILE}`).stdout : '';
    const del = git('push', '--quiet', 'origin', '--delete', branch);
    if (del.status !== 0) console.log(`could not delete ${branch} on origin: ${del.stderr.trim()}`);
    const v = smokeVerdict(text || 'null', checks.map((c) => c.name));
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? 'cloud smoke passed' : `cloud smoke failed: see ${got.url}`);
    return v.ok ? 0 : 1;
  }
  console.error('usage: cloud-env.mjs script [--write] | hosts | first-start | smoke [--timeout <minutes>]');
  return 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv[2], process.argv.slice(3)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
}
