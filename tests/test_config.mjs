// suite: config values (list items, trailing notes)
// Config value cells: one item per backtick span, except spans inside a trailing parenthesised note.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cellItems, configRows } from '../desk/bin/desk-env.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const items = (cell) => cellItems(cell).join(' | ');

t('a note with backticks adds no item', items('`ABC` (not `parent`)'), 'ABC');
t('a list keeps every span before the note', items('`A` `B, C` (two `items`)'), 'A | B, C');
t('a note without backticks', items('`ABC` (the main project)'), 'ABC');
t('nested parens in the note', items('`ABC` (not `x` (or `y`))'), 'ABC');
t('parens inside a span are value text', items('`P[0-9]+(-FIX)?` (planning `ids`)'), 'P[0-9]+(-FIX)?');
t('a span ending in a paren, no note', items('`foo (bar)`'), 'foo (bar)');
t('a mid-cell parenthesis is not trailing', items('`A` (x) `B`'), 'A | B');
t('a note-only cell is left whole', items('(`a`)'), 'a');
t('doubled display backticks', items('`` `A` `B` `` (see `C`)'), 'A | B');
t('no spans: the cell is the item', items('none (no tracker)'), 'none (no tracker)');
// #770: a note quoting a run of three or four backticks keeps the spans in step, as CommonMark reads them.
t('#770 a note quoting a fenced block adds no item', items('`none` (it carries a fenced ```` ```evidence ```` block, as `` `<file>.yml` ``)'), 'none');
t('#770 an unclosed run is plain text', items('`A` (a stray ``` here)'), 'A');

// #770: every template row whose value starts `TODO`, answered `none` with the template's note kept,
// reads as `none` alone, as the pass's configValues does.
{
  const tpl = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'desk-config.md'), 'utf8');
  const bad = [];
  for (const line of tpl.split('\n')) {
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    const at = cells.findIndex((c, i) => i > 0 && c.startsWith('`TODO`'));
    if (at < 0) continue;
    const got = cellItems(cells[at].replace('`TODO`', '`none`'));
    if (got.length !== 1 || got[0] !== 'none') bad.push(`${cells[0]}: ${JSON.stringify(got)}`);
  }
  t('#770 every TODO row answered none, its note kept, reads none alone', bad.join(' / '), '');
}

// End to end: `desk-env list` on a §4 row that carries a note.
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'desk-env.mjs');
const T = mkdtempSync(join(tmpdir(), 'desk-config-'));
const cfg = join(T, 'config.md');
writeFileSync(cfg, '## 4. Tracker\n\n| Field | Value |\n|---|---|\n'
  + '| Other work id patterns | `BUG-[0-9]+` `P[0-9]+-M[0-9]+(-FIX)?-[0-9]+` (not `roadmap-fw-3xx`) |\n');
const out = execFileSync('node', [BIN, 'list', 'work-id-patterns'], { encoding: 'utf8', env: { ...process.env, DESK_CONFIG: cfg, DESK_MACHINE: join(T, 'none.md'), HOME: T } }).trim();
t('desk-env list skips the note', out.split('\n').join(' | '), 'BUG-[0-9]+ | P[0-9]+-M[0-9]+(-FIX)?-[0-9]+');

// The design rows, by key: §2's value column sits before its Notes column.
const design = join(T, 'design.md');
writeFileSync(design, '## 2. Paths on your machine\n\n| Field | Value | Notes |\n|---|---|---|\n'
  + '| Design canvases directory | `docs/design/` | committed, not `~/Downloads/` |\n\n'
  + '## 5. Conventions\n\n| Field | Value |\n|---|---|\n'
  + '| Breakpoints | `375` `768` `1024` `1280` `1920` (from `scripts/audit.ts:65`) |\n'
  + '| Design system | `src/styles/tokens.css` `DESIGN.md` |\n');
const env = { ...process.env, DESK_CONFIG: design, DESK_MACHINE: join(T, 'none.md'), HOME: T };
const run = (...a) => execFileSync('node', [BIN, ...a], { encoding: 'utf8', env }).trim().split('\n').join(' | ');
t('design-dir reads the value column', run('get', 'design-dir'), 'docs/design/');
t('breakpoints lists every width', run('list', 'breakpoints'), '375 | 768 | 1024 | 1280 | 1920');
t('design-system lists every file', run('list', 'design-system'), 'src/styles/tokens.css | DESIGN.md');

// `none` stands alone: beside another item it is a note in backticks, refused rather than run.
const tool = join(T, 'tool.md');
writeFileSync(tool, '## 4. Toolchain\n\n| Field | Value |\n|---|---|\n'
  + '| Install | `none` — `./install.sh` installs to your machine |\n'
  + '| Unit tests | `none` (`./install.sh` is not a suite) |\n'
  + '| Lint | `none` |\n');
const toolEnv = { ...process.env, DESK_CONFIG: tool, DESK_MACHINE: join(T, 'none.md'), HOME: T };
const refused = (...a) => {
  try { execFileSync('node', [BIN, ...a], { encoding: 'utf8', env: toolEnv, stdio: 'pipe' }); return 'exit 0'; }
  catch (e) { return `exit ${e.status}: ${String(e.stderr).trim()}`; }
};
for (const sub of ['cmds', 'list']) {
  const r = refused(sub, 'install-cmd');
  t(`${sub} refuses a mixed none row`, /^exit 4: .*§4 "Install" mixes `none` with other items \(none \| \.\/install\.sh\).*move the note out of backticks/.test(r), true);
}
const plain = (...a) => execFileSync('node', [BIN, ...a], { encoding: 'utf8', env: toolEnv }).trim();
t('cmds prints nothing for a plain none', plain('cmds', 'lint-cmd'), '');
t('list prints a plain none', plain('list', 'lint-cmd'), 'none');
t('a backticked note in trailing parens is still one none', plain('cmds', 'test-cmd'), '');

// The worker rows: known ids, `no` when the row is missing, read by key when it is there.
const perms = join(T, 'perms.md');
writeFileSync(perms, '## 3. Permissions\n\n| Key | Capability | Recommended | Your setting |\n|---|---|---|---|\n'
  + '| `worker-screenshots` | Capture | `ask` | `yes` |\n| `worker-local-services` | Start | `ask` | `ask` |\n'
  + '| `jira-comment` | Comment | `yes` | `yes` |\n');
const perm = (id) => execFileSync('node', [BIN, 'perm', id], { encoding: 'utf8', env: { ...process.env, DESK_CONFIG: perms, DESK_MACHINE: join(T, 'none.md'), HOME: T } }).trim();
t('worker-dependency-install missing reads as no', perm('worker-dependency-install'), 'no');
t('worker-screenshots reads its row', perm('worker-screenshots'), 'yes');
t('worker-local-services reads its row', perm('worker-local-services'), 'ask');
t('AC2 jira-comment yes reads as yes', perm('jira-comment'), 'yes');
t('AC3 jira-comment missing reads as no', execFileSync('node', [BIN, 'perm', 'jira-comment'], { encoding: 'utf8', env: { ...process.env, DESK_CONFIG: tool, DESK_MACHINE: join(T, 'none.md'), HOME: T } }).trim(), 'no');

// Outside any repo there is no config: a permission is refused unread, never read as `no`.
const away = mkdtempSync(join(tmpdir(), 'desk-norepo-'));
const awayEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DESK_|GIT_)/.test(k)));
Object.assign(awayEnv, { HOME: away, DESK_CONFIG_ROOT: join(away, 'cfg'), DESK_MACHINE: join(away, 'none.md') });
const outside = (args) => {
  try { return { code: 0, out: execFileSync('node', args, { encoding: 'utf8', env: awayEnv, cwd: away, stdio: 'pipe' }).trim(), err: '' }; }
  catch (e) { return { code: e.status, out: String(e.stdout).trim(), err: String(e.stderr).trim() }; }
};
let o = outside([BIN, 'perm', 'jira-comment']);
t('AC1 perm outside a repo exits 3', o.code, 3);
t('AC1 and says no repo config was found', /no repo config found/.test(o.err), true);
t('AC1 and prints neither yes nor no', o.out, '');
o = outside(['--input-type=module', '-e', `import { permission } from ${JSON.stringify(BIN)}; console.log(permission('jira-comment'));`]);
t('AC4 permission() with no config throws', o.code !== 0 && o.out === '', true);
t('AC4 and names the missing config', /no repo config found/.test(o.err), true);
rmSync(away, { recursive: true, force: true });

// `desk-env drift`: rows the template has that a config lacks, `ask` rows an unattended batch parks
// on, and a settings file that starts sessions in dontAsk.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tpl = join(T, 'template.md');
const P3 = '## 3. Permissions\n\n### Git\n\n| Key | Capability | Recommended | Your setting |\n|---|---|---|---|\n';
const B3 = '## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n';
const P2 = '## 2. Paths\n\n| Field | Value | Notes |\n|---|---|---|\n';
const P4 = '## 4. Tracker\n\n| Field | Value |\n|---|---|\n';
const rules = '## 3c. Harness rules\n\n| Rule | List | Owning rows | Added |\n|---|---|---|---|\n| `Bash(x)` | allow | `git-push` | 2026-10-21 |\n\n';
const row3 = (k, v) => `| \`${k}\` | cap | \`yes\` | \`${v}\` |\n`;
writeFileSync(tpl, `${P3}${['autopilot-workers', 'git-push', 'pr-ready', 'pr-merge-green', 'batch-base-push'].map((k) => row3(k, 'TODO')).join('')}\n`
  + `${B3}| Worker models | \`default\` | \`TODO\` |\n| Check-in times | \`08:00, 17:00\` | \`TODO\` |\n\n${rules}`
  + `${P2}| Primary repo root | \`TODO\` | |\n\n${P4}| Branch protection | \`TODO\` |\n`);
const repoDir = join(T, 'repo');
mkdirSync(join(repoDir, '.claude'), { recursive: true });
const conf = ({ omit = [], perms = {}, protection = 'ruleset main', b3 = true } = {}) => {
  const keys = ['autopilot-workers', 'git-push', 'pr-ready', 'pr-merge-green', 'batch-base-push'].filter((k) => !omit.includes(k));
  return `${P3}${keys.map((k) => row3(k, perms[k] ?? 'yes')).join('')}\n`
    + `${B3}${b3 ? '| Worker models | `default` | `default` |\n' : ''}| Check-in times | \`08:00, 17:00\` | \`08:00\` |\n\n`
    + `${P2}| Primary repo root | \`${repoDir}\` | |\n\n${P4}| Branch protection | \`${protection}\` |\n`;
};
const driftEnv = (extra) => ({ ...process.env, DESK_CONFIG_TEMPLATE: tpl, DESK_MACHINE: join(T, 'none.md'), HOME: T, DESK_REPO_DIR: T, ...extra });
const drift = (body, ...args) => {
  const c = join(T, 'drift.md');
  writeFileSync(c, body);
  try { return { code: 0, out: execFileSync('node', [BIN, 'drift', ...args], { encoding: 'utf8', env: driftEnv({ DESK_CONFIG: c }), stdio: 'pipe' }).trim() }; }
  catch (e) { return { code: e.status, out: String(e.stdout).trim(), err: String(e.stderr).trim() }; }
};

let d = drift(conf());
t('AC6 a config with no drift says so', d.out, 'no drift');
t('AC6 and exits 0', d.code, 0);
d = drift(conf({ omit: ['batch-base-push'], b3: false }));
t('AC3 a missing §3 row is named with its section', d.out.includes('MISSING  §3 batch-base-push'), true);
t('AC3 a missing §3b row is named with its section', d.out.includes('MISSING  §3b "Worker models"'), true);
t('AC3 only the missing rows are reported', d.out.split('\n').length, 2);
t('AC3 and exits 1', d.code, 1);
d = drift(conf({ perms: { 'pr-ready': 'ask' } }));
t('AC4 pr-ready at ask stalls an unattended batch', d.out.split('\n').length === 1 && d.out.startsWith('STALLS   §3 pr-ready is ask'), true);
t('AC4 and exits 1', d.code, 1);
t('AC4 a no is a decision, not a stall', drift(conf({ perms: { 'pr-ready': 'no' } })).out, 'no drift');
t('AC4 no workers, no stall', drift(conf({ perms: { 'autopilot-workers': 'no', 'pr-ready': 'ask', 'git-push': 'ask' } })).out, 'no drift');
t('pr-merge-green at ask stalls on a protected repo', /STALLS {3}§3 pr-merge-green/.test(drift(conf({ perms: { 'pr-merge-green': 'ask' } })).out), true);
t('AC2 pr-merge-green at ask is expected on an unprotected repo', drift(conf({ perms: { 'pr-merge-green': 'ask' }, protection: 'none' })).out, 'no drift');
writeFileSync(join(repoDir, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'dontAsk' } }));
d = drift(conf());
t('AC5 a dontAsk settings file is named', d.out, `DONTASK  ${join(repoDir, '.claude', 'settings.local.json')}: defaultMode is dontAsk: the orchestrator cannot ask questions or run monitors`);
t('AC5 and exits 1', d.code, 1);
writeFileSync(join(repoDir, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }));
t('another defaultMode is not drift', drift(conf()).out, 'no drift');

// A §4 command item a worker's settings can never allow is a blocking line naming its row.
const compound = `bash -c 'bash tests/run.sh $(node tests/scope_sections.mjs --json)'`;
d = drift(`${conf()}| Related tests | \`${compound}\` |\n| Lint | \`pnpm lint\` \`rm -rf dist\` |\n`);
t('DS-395 AC4 a compound command item is named with its row', d.out.split('\n')[0],
  `UNLISTED §4 Lint item "rm -rf dist" starts with rm, which is never allow-listed: every worker is refused it`);
t('DS-395 AC4 and so is a compound one', d.out.split('\n')[1].startsWith(`UNLISTED §4 Related tests item "${compound}" is a compound or env-prefixed shell command`), true);
t('DS-395 AC4 only the items workers cannot run are reported', d.out.split('\n').length, 2);
t('DS-395 AC4 and exits 1', d.code, 1);
t('DS-395 AC4 a script run as bash <path>.sh is not drift', drift(`${conf()}| Related tests | \`bash tests/related.sh\` |\n`).out, 'no drift');

// An app directory other command rows name, with a dev script and no Dev server item, is named NODEV.
mkdirSync(join(repoDir, 'apps/portal/apps/web'), { recursive: true });
mkdirSync(join(repoDir, 'apps/api'), { recursive: true });
writeFileSync(join(repoDir, 'apps/portal/apps/web/package.json'), JSON.stringify({ scripts: { dev: 'next dev', lint: 'eslint .' } }));
writeFileSync(join(repoDir, 'apps/api/package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
const rows4 = (dev) => `| Dev server | ${dev} |\n| Lint | \`bun run lint\` \`apps/portal/apps/web: bun run lint\` |\n| Typecheck | \`apps/portal/apps/web: bun run typecheck\` |\n| Unit tests | \`apps/api: bun run test\` |\n`;
d = drift(`${conf()}${rows4('`bun run --filter studia-web dev`')}`);
t('DS-437 AC1 a second app the other rows name is named NODEV with those rows', d.out,
  'NODEV    §4 Dev server has no item for apps/portal/apps/web, which §4 Typecheck, Lint name and whose package.json has a dev script: a worker on a ticket there cannot run its dev server');
t('DS-437 AC1 and exits 1', d.code, 1);
t('DS-437 AC1 an item for that directory clears it', drift(`${conf()}${rows4('`bun run --filter studia-web dev` `apps/portal/apps/web: bun run dev`')}`).out, 'no drift');
t('DS-437 AC1 a Dev server row of none is a decision, not drift', drift(`${conf()}${rows4('`none`')}`).out, 'no drift');
writeFileSync(join(repoDir, 'apps/portal/apps/web/package.json'), JSON.stringify({ name: 'portal-web', scripts: { dev: 'next dev' } }));
t('DS-437 AC1 a root item filtering to that package by name serves it', drift(`${conf()}${rows4('`bun run --filter portal-web dev`')}`).out, 'no drift');
t('DS-437 AC1 a root item filtering to that directory by path serves it', drift(`${conf()}${rows4('`pnpm --filter=./apps/portal/apps/web dev`')}`).out, 'no drift');
writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ scripts: { dev: 'turbo dev' } }));
t('DS-437 AC1 the root is never a gap, though its package.json has a dev script', drift(`${conf()}${rows4('`apps/portal/apps/web: bun run dev`')}`).out, 'no drift');
rmSync(join(repoDir, 'package.json'), { force: true });
rmSync(join(repoDir, 'apps'), { recursive: true, force: true });

// One app's setup gaps, each §4 row it lacks with the value to add, in one call.
mkdirSync(join(repoDir, 'apps/portal'), { recursive: true });
writeFileSync(join(repoDir, 'apps/portal/package.json'), JSON.stringify({ name: 'portal', scripts: { dev: 'next dev' } }));
for (const f of ['.env.local', '.env', '.env.example']) writeFileSync(join(repoDir, 'apps/portal', f), '');
const appRows = (dev, env) => `${conf()}| Package manager | \`pnpm\` |\n| Dev server | ${dev} |\n| Env files | ${env} |\n`;
d = drift(appRows('`apps/web: pnpm dev`', '`apps/web/.env.local`'), '--app', 'apps/portal');
t('DS-571 AC1 an app missing from Dev server and Env files gets both rows, each with its value', d.out, [
  'NODEV    §4 Dev server has no item for apps/portal, whose package.json has a dev script: add `apps/portal: pnpm run dev`',
  'NOENV    §4 Env files has no item under apps/portal, whose primary checkout holds .env, .env.local: add `apps/portal/.env` `apps/portal/.env.local`',
].join('\n'));
t('DS-571 AC1 and exits 1', d.code, 1);
d = drift(appRows('`apps/web: pnpm dev` `apps/portal: pnpm dev`', '`apps/web/.env.local`'), '--app', 'apps/portal');
t('DS-571 AC2 an app missing only from Env files gets that row only', d.out,
  'NOENV    §4 Env files has no item under apps/portal, whose primary checkout holds .env, .env.local: add `apps/portal/.env` `apps/portal/.env.local`');
t('DS-571 an app with both rows has no gaps', drift(appRows('`pnpm --filter portal dev`', '`apps/portal/.env.local`'), '--app', './apps/portal/').out, 'no setup gaps for ./apps/portal/');
t('a row of none is a decision, not a gap', drift(appRows('`none`', '`none`'), '--app', 'apps/portal').out, 'no setup gaps for apps/portal');
rmSync(join(repoDir, 'apps'), { recursive: true, force: true });
t('no env files in the checkout proposes none', drift(appRows('`none`', '`apps/web/.env.local`'), '--app', 'apps/portal').out, 'no setup gaps for apps/portal');

// A §4 Pre-merge steps item keyed to a job of several steps is named JOBKEY, with the step it is for.
mkdirSync(join(repoDir, '.github/workflows'), { recursive: true });
writeFileSync(join(repoDir, '.github/workflows/ci.yml'), [
  'name: CI', 'on: [pull_request]', 'jobs:', '  fast:', '    name: Fast checks', '    runs-on: ubuntu-latest', '    steps:',
  '      - uses: actions/checkout@v4', '      - name: Lint', '        run: |', '          name: not a step', '          pnpm lint',
  '      - name: Diff Sanity Scan', '        run: bash scripts/scan.sh', '      - name: "Migration Staging Ack"', '        with:', '          name: not a step either',
  '  e2e:', '    runs-on: ubuntu-latest', '    steps:', '    - name: Playwright', '      run: pnpm e2e',
  '  types:', '    name: Typecheck', '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v4', '      - name: Typecheck', '        run: pnpm tsc', ''].join('\n'));
const pre = (items) => `${conf()}| Pre-merge steps | ${items} |\n`;
d = drift(pre('`Fast checks: apply the PR\'s migrations to the staging schema first`'));
t('DS-567 AC4 an item keyed to a job of several steps proposes the step it is for', d.out,
  'JOBKEY   §4 Pre-merge steps item "Fast checks" names a job of 4 steps, so desk guesses from its words which failed step is yours: name the step instead: "Migration Staging Ack: apply the PR\'s migrations to the staging schema first"');
t('DS-567 AC4 and exits 1', d.code, 1);
t('DS-567 AC4 with no step that fits, it lists the named ones', drift(pre('`Fast checks: ask Dana to approve it`')).out,
  'JOBKEY   §4 Pre-merge steps item "Fast checks" names a job of 4 steps, so desk guesses from its words which failed step is yours: name the step it is for instead, one of "Lint", "Diff Sanity Scan", "Migration Staging Ack"');
t('DS-567 AC4 an item keyed to the step is not drift', drift(pre('`Migration Staging Ack: apply the PR\'s migrations to staging first`')).out, 'no drift');
t('DS-567 AC4 an item keyed to a job of one step is not drift', drift(pre('`e2e: re-run it once staging is up`')).out, 'no drift');
t('DS-567 AC4 an item named after a step its job shares a name with is keyed to the step', drift(pre('`Typecheck: fix the type errors`')).out, 'no drift');
t('DS-567 AC4 a row of none is not drift', drift(pre('`none`')).out, 'no drift');
rmSync(join(repoDir, '.github'), { recursive: true, force: true });

// --all: every repo under DESK_CONFIG_ROOT, by slug.
const croot = join(T, 'cfgroot');
for (const [slug, body] of [['acme__clean', conf()], ['acme__stale', conf({ omit: ['git-push'] })]]) {
  mkdirSync(join(croot, 'repos', slug), { recursive: true });
  writeFileSync(join(croot, 'repos', slug, 'config.md'), body);
}
const all = (extra) => {
  try { return { code: 0, out: execFileSync('node', [BIN, 'drift', '--all'], { encoding: 'utf8', env: driftEnv({ DESK_CONFIG_ROOT: croot, ...extra }), stdio: 'pipe' }).trim() }; }
  catch (e) { return { code: e.status, out: String(e.stdout).trim() }; }
};
d = all();
t('AC7 each repo is reported by slug', d.out, '== acme__clean\n  no drift\n== acme__stale\n  MISSING  §3 git-push: the template has this row, the config does not');
t('AC7 any drift exits 1', d.code, 1);
rmSync(join(croot, 'repos', 'acme__stale'), { recursive: true });
t('AC7 no drift anywhere exits 0', all().code, 0);

// `desk-env add-row`: a row drift names MISSING, copied from the template with the person's answer.
const added = join(T, 'add.md');
const addRow = (body, ...args) => {
  if (body != null) writeFileSync(added, body);
  try { return { code: 0, out: execFileSync('node', [BIN, 'add-row', ...args], { encoding: 'utf8', env: driftEnv({ DESK_CONFIG: added }), stdio: 'pipe' }).trim(), file: readFileSync(added, 'utf8') }; }
  catch (e) { return { code: e.status, out: String(e.stdout).trim(), err: String(e.stderr).trim(), file: readFileSync(added, 'utf8') }; }
};
const permOf = (id) => execFileSync('node', [BIN, 'perm', id], { encoding: 'utf8', env: driftEnv({ DESK_CONFIG: added }) }).trim();
const lineOf = (file, key) => file.split('\n').findIndex((l) => l.includes(`\`${key}\``));
let a = addRow(conf({ omit: ['pr-ready', 'batch-base-push'] }), '3', 'pr-ready', 'yes', '--note', 'set 2026-11-01 by you in /desk-update');
t('DS-389 AC2 the answer is written as the template row, its note after it', a.out.split('\n')[0], 'ADDED §3 pr-ready: | `pr-ready` | cap | `yes` | `yes` (set 2026-11-01 by you in /desk-update) |');
t('DS-389 AC2 and desk-env perm reads it back', `${a.out.split('\n')[1]} | ${permOf('pr-ready')}`, 'perm pr-ready = yes | yes');
t('DS-389 AC2 it sits where the template has it, after git-push', lineOf(a.file, 'pr-ready'), lineOf(a.file, 'git-push') + 1);
a = addRow(null, '3', 'batch-base-push', 'no');
t('DS-389 AC2 the last row of its table goes after the nearest row above it', `${a.code} ${lineOf(a.file, 'batch-base-push')}`, `0 ${lineOf(a.file, 'pr-merge-green') + 1}`);
t('DS-389 AC4 with every template row, drift names none, so nothing is asked', drift(a.file).out, 'no drift');
const before = a.file;
a = addRow(null, '3', 'git-push', 'no');
t('DS-389 a row the config has is refused, never overwritten', `${a.code} ${/already has §3 git-push/.test(a.err)} ${a.file === before}`, '4 true true');
a = addRow(conf({ omit: ['pr-ready'] }), '3', 'pr-ready', 'yse');
t('DS-389 a §3 answer that is not yes, ask or no is refused', `${a.code} ${/takes yes, ask or no/.test(a.err)} ${lineOf(a.file, 'pr-ready')}`, '4 true -1');
a = addRow(null, '3', 'no-such-row', 'yes');
t('DS-389 a row the template does not have is refused', `${a.code} ${/no §3 row "no-such-row"/.test(a.err)}`, '4 true');
a = addRow(conf({ b3: false }), '3b', 'Worker models', 'default');
t('DS-389 a §3b row is added by its name, before the row below it', `${a.code} ${a.file.split('\n').findIndex((l) => l.startsWith('| Worker models'))} ${a.file.split('\n').findIndex((l) => l.startsWith('| Check-in times'))}`,
  `0 ${a.file.split('\n').findIndex((l) => l.startsWith('| Check-in times')) - 1} ${a.file.split('\n').findIndex((l) => l.startsWith('| Check-in times'))}`);
t('DS-389 and drift no longer names it', drift(a.file).out, 'no drift');

// DS-568 AC4: a config with no §4 Person-step labels row is named MISSING against the real template, so
// /desk-setup asks for it (its step 1 says to, writing none when given none), and none reads as no labels.
{
  const realEnv = (c) => driftEnv({ DESK_CONFIG: c, DESK_CONFIG_TEMPLATE: join(ROOT, 'desk-config.md') });
  const c = join(T, 'steps.md');
  writeFileSync(c, `${P4}| Labels | \`any\` |\n`);
  let out = '';
  try { out = execFileSync('node', [BIN, 'drift'], { encoding: 'utf8', env: realEnv(c), stdio: 'pipe' }); } catch (e) { out = String(e.stdout); }
  t('DS-568 AC4 a config with no Person-step labels row has it named MISSING', out.includes('MISSING  §4 "Person-step labels"'), true);
  const setup = readFileSync(join(ROOT, 'skills/desk-setup/references/step-1-detect.md'), 'utf8');
  t('DS-568 AC4 /desk-setup asks for the row, writing none when given none', /\*\*Person-step labels\.\*\* Ask [^]*?with none named, or with Tracker `none`, write `none`/.test(setup), true);
  const w = execFileSync('node', [BIN, 'add-row', '4', 'Person-step labels', 'none'], { encoding: 'utf8', env: realEnv(c), stdio: 'pipe' });
  t('DS-568 AC4 an answer of none is written as the row', `${w.startsWith('ADDED §4')} ${readFileSync(c, 'utf8').includes('| Person-step labels | `none` |')}`, 'true true');
  const read = execFileSync('node', ['--input-type=module', '-e', `import { personStepLabels } from ${JSON.stringify(BIN)}; console.log(JSON.stringify(personStepLabels()));`], { encoding: 'utf8', env: realEnv(c) }).trim();
  t('DS-568 AC3 a row of none names no labels', read, '[]');
  writeFileSync(c, `${P4}| Labels | \`any\` |\n| Person-step labels | \`ben-step\` \`Operator-Task\` |\n`);
  t('DS-568 AC1 each label is read, lowercased', execFileSync('node', ['--input-type=module', '-e', `import { personStepLabels } from ${JSON.stringify(BIN)}; console.log(JSON.stringify(personStepLabels()));`], { encoding: 'utf8', env: realEnv(c) }).trim(), '["ben-step","operator-task"]');
}

// A config with no §4 Person-input labels row has it named MISSING, an answer of none is written as
// the row, and none reads as no labels.
{
  const realEnv = (c) => driftEnv({ DESK_CONFIG: c, DESK_CONFIG_TEMPLATE: join(ROOT, 'desk-config.md') });
  const inputs = (c) => execFileSync('node', ['--input-type=module', '-e', `import { personInputLabels } from ${JSON.stringify(BIN)}; console.log(JSON.stringify(personInputLabels()));`], { encoding: 'utf8', env: realEnv(c) }).trim();
  const c = join(T, 'inputs.md');
  writeFileSync(c, `${P4}| Labels | \`any\` |\n| Person-step labels | \`ben-step\` |\n`);
  let out = '';
  try { out = execFileSync('node', [BIN, 'drift'], { encoding: 'utf8', env: realEnv(c), stdio: 'pipe' }); } catch (e) { out = String(e.stdout); }
  t('DS-682 AC10 a config with no Person-input labels row has it named MISSING', out.includes('MISSING  §4 "Person-input labels"'), true);
  t('DS-682 AC10 with the row unset, no input labels are read', inputs(c), '[]');
  const w = execFileSync('node', [BIN, 'add-row', '4', 'Person-input labels', 'none'], { encoding: 'utf8', env: realEnv(c), stdio: 'pipe' });
  t('DS-682 AC10 an answer of none is written as the row, and reads as no labels', `${w.startsWith('ADDED §4')} ${readFileSync(c, 'utf8').includes('| Person-input labels | `none` |')} ${inputs(c)}`, 'true true []');
  writeFileSync(c, `${P4}| Labels | \`any\` |\n| Person-input labels | \`Ben-Input\` |\n`);
  t('DS-682 AC2 each input label is read, lowercased', inputs(c), '["ben-input"]');
}

// DS-689 AC5: a config with no §4 Append-only paths row has it named MISSING, /desk-setup asks for it
// suggesting none, and an answer of none is written as the row.
{
  const realEnv = (c) => driftEnv({ DESK_CONFIG: c, DESK_CONFIG_TEMPLATE: join(ROOT, 'desk-config.md') });
  const c = join(T, 'append-only.md');
  writeFileSync(c, `${P4}| Incidental paths | \`none\` |\n`);
  let out = '';
  try { out = execFileSync('node', [BIN, 'drift'], { encoding: 'utf8', env: realEnv(c), stdio: 'pipe' }); } catch (e) { out = String(e.stdout); }
  t('DS-689 AC5 a config with no Append-only paths row has it named MISSING', out.includes('MISSING  §4 "Append-only paths"'), true);
  const detect = readFileSync(join(ROOT, 'skills', 'desk-setup', 'references', 'step-1-detect.md'), 'utf8');
  t('DS-689 AC5 /desk-setup asks for the row, suggesting none', /\*\*Append-only paths\.\*\* Ask [^]*?suggesting `none`/.test(detect), true);
  const w = execFileSync('node', [BIN, 'add-row', '4', 'Append-only paths', 'none'], { encoding: 'utf8', env: realEnv(c), stdio: 'pipe' });
  t('DS-689 AC5 an answer of none is written as the row', `${w.startsWith('ADDED §4')} ${readFileSync(c, 'utf8').includes('| Append-only paths | `none` |')}`, 'true true');
}

// The shipped template compared with itself: every row it declares is found, the ledger is not a row.
const self = execFileSync('node', [BIN, 'drift'], { encoding: 'utf8', env: driftEnv({ DESK_CONFIG_TEMPLATE: join(ROOT, 'desk-config.md'), DESK_CONFIG: join(ROOT, 'desk-config.md') }) }).trim();
t('the template has no drift against itself', self, 'no drift');

// The Recommended column agrees between the setup interview and the template, on every shared key.
const recommended = (path, header) => {
  const out = {};
  let inTable = false;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.startsWith('|')) { inTable = false; continue; }
    if (line.startsWith('| Key |')) { inTable = line.startsWith(header); continue; }
    const m = /^\| `([a-z0-9-]+)` \|/.exec(line);
    if (!inTable || !m) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    out[m[1]] = cells[header.split('|').length - 3]?.replace(/`/g, '').split(/[\s(]/)[0];
  }
  return out;
};
const fromRows = recommended(join(ROOT, 'skills', 'desk-setup', 'references', 'permission-rows.md'), '| Key | Recommended |');
const fromTpl = recommended(join(ROOT, 'desk-config.md'), '| Key | Capability | Recommended |');
const shared = Object.keys(fromRows).filter((k) => k in fromTpl);
t('permission-rows.md and desk-config.md share the §3 keys', shared.length > 40, true);
t('their Recommended values agree', shared.filter((k) => fromRows[k] !== fromTpl[k]).map((k) => `${k} ${fromRows[k]}/${fromTpl[k]}`).join(', '), '');
for (const k of ['git-force-with-lease', 'worktree-remove', 'pr-ready', 'pr-merge-green', 'autopilot-merge', 'jira-close']) {
  t(`AC1 ${k} is recommended yes`, `${fromRows[k]}/${fromTpl[k]}`, 'yes/yes');
}

// Rows for opening and commenting on a GitHub issue in the repo: recommended ask, offered by setup
// (permission-rows.md) with the harness rule each grants and a reach that says it is any repo, read by
// desk-env by key, and named as missing from a config that predates them.
const rowsText = readFileSync(join(ROOT, 'skills', 'desk-setup', 'references', 'permission-rows.md'), 'utf8');
const { PERMISSION_KEYS } = await import('../desk/bin/desk-env.mjs');
for (const [k, rule] of [['gh-issue-create', 'Bash(gh issue create *)'], ['gh-issue-comment', 'Bash(gh issue comment *)']]) {
  t(`#810 ${k} is recommended ask in both`, `${fromRows[k]}/${fromTpl[k]}`, 'ask/ask');
  t(`#810 ${k} grants ${rule} when set to yes`, rowsText.split('\n').some((l) => l.startsWith(`| \`${k}\` |`) && l.includes(`\`${rule}\``)), true);
  t(`#810 desk-env reads ${k} by its key`, PERMISSION_KEYS[k], k);
  t(`#810 ${k}'s reach says the rule reaches any repo`, rowsText.split('\n').some((l) => l.startsWith(`| \`${k}\` |`) && l.includes('_Reach_: the rule') && l.includes('**any**')), true);
}
{
  const c = join(T, 'drift-810.md');
  writeFileSync(c, conf());
  let out = '';
  try { out = execFileSync('node', [BIN, 'drift'], { encoding: 'utf8', env: driftEnv({ DESK_CONFIG: c, DESK_CONFIG_TEMPLATE: join(ROOT, 'desk-config.md') }), stdio: 'pipe' }); } catch (e) { out = String(e.stdout); }
  t('#810 a config without the rows has them named as missing', ['gh-issue-create', 'gh-issue-comment'].every((k) => out.includes(`MISSING  §3 ${k}`)), true);
}

// §1 Git author name / email, which spawn-worker.sh exports as GIT_AUTHOR_* and GIT_COMMITTER_*:
// `Name <email>` or `Name` / `email` prints NAME<TAB>EMAIL; unset or `none` exits 3; anything else 4.
const gitAuthor = (cell) => {
  const f = join(T, 'author.md');
  writeFileSync(f, `## 1. Who you are\n\n| Field | Value |\n|---|---|\n| Git author name / email | ${cell} |\n`);
  try { return execFileSync('node', [BIN, 'git-author'], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, DESK_CONFIG: f, DESK_MACHINE: join(T, 'none.md'), HOME: T } }).replace(/\t/g, ' | ').trim(); }
  catch (e) { return `exit ${e.status}`; }
};
t('git-author reads Name <email>, past its note', gitAuthor('`Ben Lavender <ben@example.com>` (50 of 50 recent commits)'), 'Ben Lavender | ben@example.com');
t('git-author reads Name / email as two spans', gitAuthor('`Ben Lavender` / `ben@example.com`'), 'Ben Lavender | ben@example.com');
t('git-author keeps an apostrophe in the name', gitAuthor("`Pat O'Neil <pat@example.com>`"), "Pat O'Neil | pat@example.com");
t('git-author TODO is unset', gitAuthor('`TODO` (must match what your commits in this repo already use)'), 'exit 3');
t('git-author blank is unset', gitAuthor(''), 'exit 3');
t('git-author none is unset', gitAuthor('`none`'), 'exit 3');
t('git-author with no email is refused', gitAuthor('`Ben Lavender`'), 'exit 4');
t('git-author with no name is refused', gitAuthor('`<ben@example.com>`'), 'exit 4');
// #746: a skill reads the config's rows through `desk-env show`: headings and tables, not the prose,
// and not the §3c rule ledger unless asked for by name.
{
  const text = '# Desk config\n\nIntro prose.\n\n---\n\n## Rules for the agent reading this file\n\n5. **The Recommended column is not this user\'s answer.**\n\n---\n\n## 1. You\n\nProse about you.\n\n| Field | Value |\n|---|---|\n| GitHub handle | `me` |\n\n'
    + '## 3. Permissions\n\n### Git\n\nWhy these matter.\n\n| Key | Capability | Recommended | Your setting |\n|---|---|---|---|\n| `git-push` | push | `ask` | `yes` |\n\n'
    + '```bash\n| not | a row |\n```\n\n## 3c. Harness rules written by setup\n\nLedger prose.\n\n| Rule | List | Owning rows | Added |\n|---|---|---|---|\n| `Bash(x)` | allow | `git-push` | 2026-10-21 |\n';
  const all = configRows(text);
  t('#746 show keeps the headings and table rows', ['# Desk config', '## 1. You', '| GitHub handle | `me` |', '### Git', '| `git-push` | push | `ask` | `yes` |'].every((l) => all.split('\n').includes(l)), true);
  t('#746 and leaves out the prose and a fenced block', /prose|Why these|not \| a row/i.test(all), false);
  t('#746 and the §3c ledger', /3c|Bash\(x\)/.test(all), false);
  t('#746 the rules for the agent reading it are printed whole, prose and all', all.includes("## Rules for the agent reading this file\n\n5. **The Recommended column is not this user's answer.**"), true);
  t('#746 but not when a section is named', configRows(text, ['1']).includes('Rules for the agent'), false);
  t('#746 a named section is printed alone, §3c included when named', `${configRows(text, ['1'])} / ${/Bash\(x\)/.test(configRows(text, ['§3c']))}`, '## 1. You\n| Field | Value |\n|---|---|\n| GitHub handle | `me` | / true');
  const showEnv = { ...process.env, DESK_CONFIG: join(T, 'show.md'), DESK_MACHINE: join(T, 'none.md'), HOME: T };
  writeFileSync(join(T, 'show.md'), text);
  t('#746 desk-env show prints the same', execFileSync('node', [BIN, 'show', '3'], { encoding: 'utf8', env: showEnv }).trim(), configRows(text, ['3']));
  let code = 0; try { execFileSync('node', [BIN, 'show'], { stdio: 'ignore', env: { ...showEnv, DESK_CONFIG: join(T, 'missing.md') } }); } catch (e) { code = e.status; }
  t('#746 with no config it exits 3', code, 3);
}
rmSync(T, { recursive: true, force: true });

console.log(fails ? `${fails} FAILED` : 'config: all checks passed');
process.exit(fails ? 1 : 0);
