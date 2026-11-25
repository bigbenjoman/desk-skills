// suite: config values (list items, trailing notes)
// layer: L2
// Config value cells: one item per backtick span, except spans inside a trailing parenthesised note.
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cellItems, configRows, declaredRows, CONFIG_ROWS, PATH_VARS } from '../desk/bin/desk-env.mjs';
import { ROWS, coverage, TYPES, parseRow, norm, MACHINE_FALLBACK, requiredFieldsIn, requiredFieldsByType } from '../desk/bin/config-schema.mjs';
import { scratch } from './scratch.mjs';
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
t('DS-844 AC3 a note holding a fenced example in runs of three backticks adds no item', items('`a` `b` (write ```evidence``` as ```` ```evidence ```` then `c`)'), 'a | b');
t('DS-844 AC3 an unclosed run in the note is text, not a span', items('`a` (one ``` here, `c`)'), 'a');
t('DS-844 a note inside the doubled display form adds no item', items('`` `ABC` (not `parent`) ``'), 'ABC');
t('DS-844 a none row copied in the doubled display form with its note is none alone', items('`` `none` (not `pr-evidence.yml`) ``'), 'none');
t('DS-844 only the one trailing note is stripped: a parenthesis before it keeps its items', items('`Lint` (CI build: `Build`) (names from GitHub)'), 'Lint | Build');
t('DS-844 a note after the doubled display form is the one note: a parenthesis inside keeps its items', items('`` `Lint` (CI build: `Build`) `` (names from GitHub)'), 'Lint | Build');
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
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'desk', 'bin', 'desk-env.mjs');
const T = scratch('desk-config-');
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

// The shipped template with every TODO answered none: each row reads as none alone through `list`,
// as it does through `get`, though a note may hold backtick runs of any length.
const answered = join(T, 'answered-none.md');
writeFileSync(answered, readFileSync(join(ROOT, 'desk-config.md'), 'utf8').replaceAll('`TODO`', '`none`'));
const answeredEnv = { ...process.env, DESK_CONFIG: answered, DESK_MACHINE: join(T, 'none.md'), HOME: T };
const evidence = (() => {
  try { return `exit 0: ${execFileSync('node', [BIN, 'list', 'evidence-workflow'], { encoding: 'utf8', env: answeredEnv, stdio: 'pipe' }).trim()}`; }
  catch (e) { return `exit ${e.status}: ${String(e.stderr).trim()}`; }
})();
t('DS-844 AC1 the template Evidence workflow cell answered none lists none alone', evidence, 'exit 0: none');
// Which rows the template leaves TODO is read from a copy answered with a marker no reader treats as
// none or unset, so a row `get` misreads as anything but none is checked too, not skipped.
const marked = join(T, 'answered-marker.md');
writeFileSync(marked, readFileSync(join(ROOT, 'desk-config.md'), 'utf8').replaceAll('`TODO`', '`DS844ANSWER`'));
const readRows = (file, script) => execFileSync('node', ['--input-type=module', '-e', `
  import { CONFIG_ROWS, configValue, configValues } from ${JSON.stringify(BIN)};
  ${script}`], { encoding: 'utf8', env: { ...process.env, DESK_CONFIG: file, DESK_MACHINE: join(T, 'none.md'), HOME: T } }).trim();
const todoRows = readRows(marked, `console.log(Object.keys(CONFIG_ROWS).filter((id) => !CONFIG_ROWS[id].table && configValue(id) === 'DS844ANSWER').join(' '));`).split(' ').filter(Boolean);
const todoCells = readFileSync(join(ROOT, 'desk-config.md'), 'utf8').split('\n').filter((l) => /^\|.*`TODO`/.test(l)).length;
t('DS-844 AC2 the template rows left TODO are found (at least half its TODO cells)', todoRows.length >= Math.ceil(todoCells / 2) && todoRows.length > 0, true);
const misread = readRows(answered, `
  const bad = [];
  for (const id of ${JSON.stringify(todoRows)}) {
    let got; try { got = [configValue(id), configValues(id)]; } catch (e) { got = e.message; }
    if (JSON.stringify(got) !== '["none",["none"]]') bad.push(id + ' = ' + JSON.stringify(got));
  }
  console.log(bad.join('; '));`);
t(`DS-844 AC2 every template row answered none (${todoRows.length} rows) reads none alone through get and list`, misread, '');

// A `none` beside another item, with no note, is still refused; `ids` names such a row as not readable.
const mixed = join(T, 'mixed.md');
writeFileSync(mixed, '## 4. Tracker\n\n| Field | Value |\n|---|---|\n| Evidence workflow | `none` `pr-evidence.yml` |\n');
const mixedEnv = { ...process.env, DESK_CONFIG: mixed, DESK_MACHINE: join(T, 'none.md'), HOME: T };
const mixedList = (() => {
  try { execFileSync('node', [BIN, 'list', 'evidence-workflow'], { encoding: 'utf8', env: mixedEnv, stdio: 'pipe' }); return 'exit 0'; }
  catch (e) { return `exit ${e.status}: ${/mixes `none` with other items \(none \| pr-evidence\.yml\)/.test(String(e.stderr))}`; }
})();
t('DS-844 AC4 none beside pr-evidence.yml is still refused', mixedList, 'exit 4: true');
const idsLine = execFileSync('node', [BIN, 'ids'], { encoding: 'utf8', env: mixedEnv }).split('\n').find((l) => l.startsWith('get  evidence-workflow '));
t('DS-844 AC5 ids names a row get and list read differently as not readable', /= \(not readable: .*mixes `none`/.test(idsLine ?? ''), true);

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
const away = scratch('desk-norepo-');
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
const conf = ({ omit = [], perms = {}, protection = 'ruleset main', b3 = true, b3rows = '' } = {}) => {
  const base = ['autopilot-workers', 'git-push', 'pr-ready', 'pr-merge-green', 'batch-base-push'];
  const keys = [...base, ...Object.keys(perms).filter((k) => !base.includes(k))].filter((k) => !omit.includes(k));
  return `${P3}${keys.map((k) => row3(k, perms[k] ?? 'yes')).join('')}\n`
    + `${B3}${b3 ? '| Worker models | `default` | `default` |\n' : ''}| Check-in times | \`08:00, 17:00\` | \`08:00\` |\n${b3rows}\n`
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

// §4 Suite weight comes from the repo's committed settings (env.DESK_SUITE_WEIGHT in
// .claude/settings.json) over the config's row, and drift names a row that disagrees.
const settings = join(repoDir, '.claude', 'settings.json');
const weight = (body) => {
  const c = join(T, 'weight.md');
  writeFileSync(c, body);
  try { return execFileSync('node', [BIN, 'get', 'suite-weight'], { encoding: 'utf8', env: driftEnv({ DESK_CONFIG: c }), stdio: 'pipe' }).trim(); }
  catch (e) { return `exit ${e.status}`; }
};
const wrow = (v) => `${conf()}| Suite weight | \`${v}\` |\n`;
writeFileSync(settings, JSON.stringify({ env: { DESK_SUITE_WEIGHT: 'light' } }));
t('DS-939 AC1 the committed value reads where the config has no row', weight(conf()), 'light');
t('DS-939 AC1 and wins over a row that disagrees', weight(wrow('heavy')), 'light');
d = drift(wrow('heavy'));
t('DS-939 AC2 a row that disagrees is one drift line naming both values', d.out,
  `WEIGHT   §4 Suite weight is heavy in the config but light in the repo's committed settings (env.DESK_SUITE_WEIGHT in ${settings}), which win: set the row to light or remove it`);
t('DS-939 AC2 and exits 1', d.code, 1);
t('DS-939 AC3 a row that agrees is not drift', drift(wrow('light')).out, 'no drift');
t('DS-939 AC3 and no row is not drift', drift(conf()).out, 'no drift');
writeFileSync(settings, JSON.stringify({ env: { OTHER: 'x' } }));
t('DS-939 AC4 settings without the key read the row', weight(wrow('light')), 'light');
rmSync(settings);
t('DS-939 AC4 with nothing committed the row reads', weight(wrow('light')), 'light');
t('DS-939 AC4 and with no row either, heavy', weight(conf()), 'heavy');
t('DS-939 AC4 nothing committed is not drift', drift(wrow('heavy')).out, 'no drift');

// A §4 command item a worker's settings can never allow is a blocking line naming its row.
const compound = `bash -c 'bash tests/run.sh $(node tests/scope_sections.mjs --json)'`;
d = drift(`${conf()}| Related tests | \`${compound}\` |\n| Lint | \`pnpm lint\` \`rm -rf dist\` |\n`);
t('DS-395 AC4 a compound command item is named with its row', d.out.split('\n')[0],
  `UNLISTED §4 Lint item "rm -rf dist" starts with rm, which is never allow-listed: every worker is refused it`);
t('DS-395 AC4 and so is a compound one', d.out.split('\n')[1].startsWith(`UNLISTED §4 Related tests item "${compound}" is a compound or env-prefixed shell command`), true);
t('DS-395 AC4 only the items workers cannot run are reported', d.out.split('\n').length, 2);
t('DS-395 AC4 and exits 1', d.code, 1);

// A §4 Local services item the service-port type cannot read is named, where workers may start them.
const badService = 'INVALID  §4 Local services: "Typesense on port 8108" is not `<service> [:<port>]`';
d = drift(`${conf({ perms: { 'worker-local-services': 'yes' } })}| Local services | \`search: 8108\` \`mailpit\` \`Typesense on port 8108\` |\n`);
t('a Local services item with no service name is named, where workers start services', d.out, [badService,
  'UNLISTED §4 Local services item "Typesense on port 8108" is not `<service> [:<port>]`: every worker is refused it'].join('\n'));
// An item worker-settings refuses for what follows the name, not the name itself, is named UNLISTED too.
d = drift(`${conf({ perms: { 'worker-local-services': 'yes' } })}| Local services | \`search 8108\` |\n`);
t('DS-873 an item worker-settings refuses for its tail is UNLISTED, as worker-settings reads it', d.out.split('\n').includes(
  'UNLISTED §4 Local services item "search 8108" is not `<service> [:<port>]`: every worker is refused it'), true);
t('and `name: port` reads as its name', d.code, 1);
t('DS-395 AC4 a script run as bash <path>.sh is not drift', drift(`${conf()}| Related tests | \`bash tests/related.sh\` |\n`).out, 'no drift');

// DS-877: rows another row settles are schema data; drift names a set row that contradicts its rule,
// and `desk-env forced` lists the values setup writes unasked.
const JIRA_PERMS = ROWS.filter((e) => e.kind === 'perm' && e.id.startsWith('jira-')).map((e) => e.id);
d = drift(`${conf({ perms: { 'jira-create': 'yes' } })}| Tracker | \`none\` |\n`);
t('DS-877 AC1 a Jira permission set yes with Tracker none is one CONFLICT line naming the row, its value and the rule', d.out,
  'CONFLICT §3 jira-create is yes, but §4 Tracker is none, which settles it no: there is no Jira to act on');
t('DS-877 AC1 and exits 1', d.code, 1);
d = drift(`${conf({ perms: Object.fromEntries(JIRA_PERMS.map((k) => [k, 'no'])) })}| Tracker | \`none\` |\n`);
t(`DS-877 AC2 every Jira permission no with Tracker none is no conflict (${JIRA_PERMS.length} rows)`, d.out, 'no drift');
t('DS-877 an ask contradicts a rule that settles the row no', /^CONFLICT §3 jira-comment is ask,/.test(drift(`${conf({ perms: { 'jira-comment': 'ask' } })}| Tracker | \`none\` |\n`).out), true);
t('DS-877 Tracker jira settles nothing', drift(`${conf({ perms: { 'jira-create': 'yes' } })}| Tracker | \`jira\` |\n`).out, 'no drift');
const forced = (rows) => {
  const c = join(T, 'forced.md');
  writeFileSync(c, `${conf()}${rows}`);
  try { return { code: 0, out: execFileSync('node', [BIN, 'forced', '--json'], { encoding: 'utf8', env: driftEnv({ DESK_CONFIG: c }), stdio: 'pipe' }).trim() }; }
  catch (e) { return { code: e.status, out: String(e.stdout).trim() }; }
};
const forcedOf = (rows) => JSON.parse(forced(rows).out).map((f) => `${f.id}=${f.value} (${f.reason})`).join(' | ');
const noDb = '(there is no local database to act on)';
t('DS-877 AC3 Local database none forces each database row no with the reason, and nothing else',
  forcedOf('| Local database | `none` |\n'), `db-per-ticket=no ${noDb} | db-clone-staging=no ${noDb} | tests-shared-db=no ${noDb}`);
t('DS-877 AC4 Repo merge settings with auto-merge off force pr-auto-merge no with the reason',
  forcedOf('| Repo merge settings | `auto-merge off; delete_branch_on_merge on` |\n'), 'pr-auto-merge=no (gh pr merge --auto cannot arm where the repo has auto-merge off)');
t('DS-877 auto-merge allowed forces nothing, whatever else is off', forcedOf('| Repo merge settings | `auto-merge allowed; delete_branch_on_merge off` |\n'), '');
for (const text of ['auto-merge allowed and delete_branch_on_merge off', 'auto-merge on. delete_branch_on_merge off', 'auto-merge allowed']) {
  t(`DS-877 "${text}" forces nothing: another setting's off is not auto-merge's`, forcedOf(`| Repo merge settings | \`${text}\` |\n`), '');
}
for (const text of ['auto-merge allowed: no', 'allow_auto_merge: false', 'no auto-merge', 'Auto-merge is disabled, delete_branch_on_merge on']) {
  t(`DS-877 "${text}" forces pr-auto-merge no`, forcedOf(`| Repo merge settings | \`${text}\` |\n`), 'pr-auto-merge=no (gh pr merge --auto cannot arm where the repo has auto-merge off)');
}
t('DS-877 auto-merge off in its own item of several forces pr-auto-merge no',
  forcedOf('| Repo merge settings | `auto-merge off` `delete_branch_on_merge on` |\n'), 'pr-auto-merge=no (gh pr merge --auto cannot arm where the repo has auto-merge off)');
t('DS-877 Staging none with a local database forces the staging rows no, each with its own reason',
  forcedOf('| Local database | `postgres container x-postgres-1` |\n| Staging | `none` |\n'),
  'db-clone-staging=no (there is no staging to clone) | staging-write=no (there is no staging to write to)');
t('DS-877 a row two rules settle is listed once, by the first',
  forcedOf('| Local database | `none` |\n| Staging | `none` |\n').split(' | ').filter((f) => f.startsWith('db-clone-staging=')).join(' | '), `db-clone-staging=no ${noDb}`);
d = drift(`${conf({ perms: { 'db-clone-staging': 'yes' } })}| Local database | \`postgres container x-postgres-1\` |\n| Staging | \`none\` |\n`);
t('DS-877 db-clone-staging yes with Staging none is a CONFLICT', d.out,
  'CONFLICT §3 db-clone-staging is yes, but §4 Staging is none, which settles it no: there is no staging to clone');
const none = forced('| Local database | `postgres container x-postgres-1` |\n| Tracker | `jira` |\n');
t('DS-877 AC5 no forcing row set prints an empty list', none.out, '[]');
t('DS-877 AC5 and exits 0', none.code, 0);
const badRule = ROWS.filter((e) => e.forced && (!e.forced.length || e.forced.some((f) => !(ROWS.some((x) => x.id === f.row && x.kind !== 'perm') && (e.kind !== 'perm' || ['yes', 'ask', 'no'].includes(f.value)) && f.reason))));
t('DS-877 every forced rule names a declared §0-§5 row, a value its row takes and a reason', badRule.map((e) => e.id).join(' '), '');

// A set row whose value does not fit the type the schema declares for it is named INVALID, report-only.
d = drift(`${conf({ perms: { 'worker-local-services': 'no' } })}| Local services | \`Typesense on port 8108\` |\n`);
t('DS-871 AC1 a Local services item that is no `<service> [:<port>]` is INVALID, naming the row, the item and the form', d.out, badService);
t('DS-871 AC1 and exits 1', d.code, 1);
t('DS-871 AC2 `search: 8108` fits, so says nothing about Local services', drift(`${conf()}| Local services | \`search: 8108\` |\n`).out, 'no drift');
d = drift(conf({ b3rows: '| Worker effort | `none` | `0=medium bogus=high` |\n' }));
t('DS-871 AC3 a Worker effort start desk does not know is INVALID, naming the row and that item',
  `${d.code} ${d.out.split('\n').length} ${d.out.startsWith('INVALID  §3b Worker effort is "0=medium bogus=high" — unknown start `bogus`;')}`, '1 1 true');
d = drift(`${conf()}| Evidence workflow | \`none\` \`pr-evidence.yml\` |\n`);
t('DS-871 AC4 an Evidence workflow cell mixing none with another item is INVALID', d.out,
  'INVALID  §4 Evidence workflow: `none` must stand alone, not beside other items (none | pr-evidence.yml)');
t('DS-871 AC4 and exits 1', d.code, 1);
t('DS-871 a single span holding none beside a lever is INVALID, as `desk-env levers` reads it',
  drift(conf({ b3rows: '| Phase 0 levers | `none` | `none, codex` |\n' })).out.startsWith('INVALID  §3b Phase 0 levers: `none` cannot sit beside another name'), true);
t('DS-871 none beside a lever across spans is INVALID, as the whole cell is read',
  drift(conf({ b3rows: '| Phase 0 levers | `none` | `none,` `effort` |\n' })).out.startsWith('INVALID  §3b Phase 0 levers: `none` cannot sit beside another name'), true);
d = drift(`${conf({ perms: { 'worker-local-services': 'yes' } })}| Local services | \`none\` \`search: 8108\` |\n| Pre-merge steps | \`none\` \`Migrate: run migration\` |\n`);
t('DS-871 a row its reader refuses for none beside other items is INVALID, not an abort', `${d.code}\n${d.out}`,
  '1\nINVALID  §4 Pre-merge steps: `none` must stand alone, not beside other items (none | Migrate: run migration)\nINVALID  §4 Local services: `none` must stand alone, not beside other items (none | search: 8108)');
d = drift(`${conf()}| Dev server | \`pnpm dev\` |\n| Lint | \`none\` \`pnpm lint\` |\n`);
t('DS-871 a worker command row with none beside a command is INVALID, not an abort, with a Dev server set', `${d.code} ${d.out}`,
  '1 INVALID  §4 Lint: `none` must stand alone, not beside other items (none | pnpm lint)');
t('DS-871 a §3 value that is no permission is INVALID', drift(conf({ perms: { 'git-push': 'maybe' } })).out.startsWith('INVALID  §3 git-push: "maybe" is not'), true);
t('DS-871 AC5 every row unset or fitting its type is no drift', drift(`${conf({ b3rows: '| Worker effort | `none` | `0=medium 4b=high` |\n| Phase 0 levers | `none` | `codex` `effort` |\n| Promotion slice size (children) | `8` | `TODO` |\n' })}| Local services | \`search: 8108\` \`mailpit :8025\` |\n| Evidence workflow | \`pr-evidence.yml\` |\n| Merge method | \`squash\` |\n`).out, 'no drift');

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
const appRows = (dev, env, signin = '`apps/portal: portal-dev@example.test`') => `${conf()}| Package manager | \`pnpm\` |\n| Dev server | ${dev} |\n| Env files | ${env} |\n${signin == null ? '' : `| Test sign-in | ${signin} |\n`}`;
const NOSIGNIN = (dir, value) => `NOSIGNIN §4 Test sign-in has no item for ${dir}, which a worker runs for screenshots: add \`${value}<email of an existing development user who holds the app's grant>\`, never a password (\`none\` where no app needs signing in to)`;
d = drift(appRows('`apps/web: pnpm dev`', '`apps/web/.env.local`', null), '--app', 'apps/portal');
t('DS-571 AC1 an app missing from Dev server, Env files and Test sign-in gets every row, each with its value', d.out, [
  'NODEV    §4 Dev server has no item for apps/portal, whose package.json has a dev script: add `apps/portal: pnpm run dev`',
  'NOENV    §4 Env files has no item under apps/portal, whose primary checkout holds .env, .env.local: add `apps/portal/.env` `apps/portal/.env.local`',
  NOSIGNIN('apps/portal', 'apps/portal: '),
].join('\n'));
t('DS-571 AC1 and exits 1', d.code, 1);
d = drift(appRows('`apps/web: pnpm dev` `apps/portal: pnpm dev`', '`apps/web/.env.local`'), '--app', 'apps/portal');
t('DS-571 AC2 an app missing only from Env files gets that row only', d.out,
  'NOENV    §4 Env files has no item under apps/portal, whose primary checkout holds .env, .env.local: add `apps/portal/.env` `apps/portal/.env.local`');
t('DS-571 an app with every row has no gaps', drift(appRows('`pnpm --filter portal dev`', '`apps/portal/.env.local`'), '--app', './apps/portal/').out, 'no setup gaps for ./apps/portal/');
t('a row of none is a decision, not a gap', drift(appRows('`none`', '`none`'), '--app', 'apps/portal').out, 'no setup gaps for apps/portal');
// DS-804: an app with a Dev server item needs a Test sign-in item for it.
const both = ['`apps/web: pnpm dev` `apps/portal: pnpm dev`', '`apps/web/.env.local` `apps/portal/.env.local`'];
d = drift(appRows(...both, null), '--app', 'apps/portal');
t('DS-804 AC3 an app with a Dev server item and the Test sign-in row unset is named NOSIGNIN, and nothing else', d.out, NOSIGNIN('apps/portal', 'apps/portal: '));
t('DS-804 AC3 and exits 1', d.code, 1);
t('DS-804 AC3 an item for another app only still names this one', drift(appRows(...both, '`apps/web: web-dev@example.test`'), '--app', 'apps/portal').out, NOSIGNIN('apps/portal', 'apps/portal: '));
t('DS-804 AC3 a Test sign-in row of none is a decision, not a gap', drift(appRows(...both, '`none`'), '--app', 'apps/portal').out, 'no setup gaps for apps/portal');
t('DS-804 AC2 an app whose items sit second in each row is not named missing from them', drift(appRows(...both, '`apps/web: web-dev@example.test` `apps/portal: portal-dev@example.test`'), '--app', 'apps/portal').out, 'no setup gaps for apps/portal');
t('DS-804 AC3 the root app\'s item is a bare email', drift(appRows('`pnpm dev`', '`.env.local`', '`apps/web: web-dev@example.test`'), '--app', '.').out, NOSIGNIN('.', ''));
t('DS-804 AC3 an app with no Dev server item is no sign-in gap', drift(appRows('`apps/web: pnpm dev`', '`apps/portal/.env.local`', null), '--app', 'apps/api').out, 'no setup gaps for apps/api');
rmSync(join(repoDir, 'apps'), { recursive: true, force: true });
t('no env files in the checkout proposes none', drift(appRows('`none`', '`apps/web/.env.local`'), '--app', 'apps/portal').out, 'no setup gaps for apps/portal');
t('DS-804 a Test sign-in item that is not an email is INVALID', drift(`${conf()}| Test sign-in | \`apps/portal: hunter2\` |\n`).out,
  'INVALID  §4 Test sign-in: "apps/portal: hunter2" is not `[<app dir>: ]<email>`');

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
mkdirSync(join(croot, 'repos', 'acme__typo'), { recursive: true });
writeFileSync(join(croot, 'repos', 'acme__typo', 'config.md'), `${conf()}| Local services | \`Typesense on port 8108\` |\n`);
d = all();
t('DS-871 AC6 the INVALID line is under the slug of the repo with the invalid row only', `${d.code}\n${d.out}`, `1\n== acme__clean\n  no drift\n== acme__typo\n  ${badService}`);
rmSync(join(croot, 'repos', 'acme__typo'), { recursive: true });

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
// #750: outside a configured repo `paths` prints the machine paths, reports the per-repo ones unset
// and still exits 4; `paths --machine` prints only the machine paths.
{
  const none = { ...process.env, DESK_CONFIG: '', DESK_REPO_DIR: T, DESK_REPO_ROOT: '', DESK_MACHINE: join(T, 'none.md'), HOME: T };
  delete none.DESK_CONFIG; delete none.DESK_REPO_ROOT; delete none.DESK_SKILLS_DIR;
  const r = spawnSync('node', [BIN, 'paths'], { encoding: 'utf8', env: none });
  const machine = ['DESK_HOME', 'DESK_BIN', 'DESK_RUN_BIN', 'DESK_SKILLS_DIR', 'DESK_LOCK_DIR', 'DESK_IS_WSL'];
  t('DS-858 AC5 paths outside a configured repo still exits 4', r.status, 4);
  t('DS-858 AC4 paths there prints every machine path with its value', machine.every((k) => new RegExp(`^${k}='[^']+'$`, 'm').test(r.stdout)), true);
  t('DS-858 AC4 DESK_SKILLS_DIR is the default under HOME', r.stdout.includes(`DESK_SKILLS_DIR='${join(T, '.agents', 'skills')}'`), true);
  const perRepo = ['DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_SLUG', 'DESK_DEFAULT_BRANCH', 'DESK_STATE', 'DESK_DEV_PORT'];
  t('DS-858 AC5 each per-repo path is reported unset, none given a value', perRepo.every((k) => r.stdout.includes(`# ${k} unset: no repo config`) && !r.stdout.includes(`${k}=`)), true);
  t('DS-858 AC5 paths there says no repo config was found', /no repo config found/.test(r.stderr), true);
  const m = execFileSync('node', [BIN, 'paths', '--machine'], { encoding: 'utf8', env: none });
  t('#750 paths --machine prints the machine paths there', ['DESK_HOME', 'DESK_BIN', 'DESK_SKILLS_DIR', 'DESK_LOCK_DIR'].every((k) => m.includes(`${k}=`)) && !m.includes('DESK_REPO_ROOT='), true);
  const c = join(T, 'paths.md');
  writeFileSync(c, `${P2}| Primary repo root | \`${repoDir}\` | |\n`);
  const inRepo = spawnSync('node', [BIN, 'paths'], { encoding: 'utf8', env: { ...none, DESK_CONFIG: c, DESK_REPO_OVERRIDE: 'acme/widgets' } });
  t('DS-858 AC6 paths inside a configured repo exits 0', inRepo.status, 0);
  t('DS-858 AC6 and prints every path with a value', PATH_VARS.every((k) => new RegExp(`^${k}='[^']+'$`, 'm').test(inRepo.stdout)) && !inRepo.stdout.includes('unset'), true);
  t('DS-858 AC6 DESK_REPO_ROOT is the configured root', inRepo.stdout.includes(`DESK_REPO_ROOT='${repoDir}'`), true);
}
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
  t('#746 a named section is printed alone', configRows(text, ['1']), '## 1. You\n| Field | Value |\n|---|---|\n| GitHub handle | `me` |');
  t('DS-875 AC4 §3c is never printed, even when named', /3c|Bash\(x\)|Ledger/.test(configRows(text, ['§3c', '3', '1', 'rules'])), false);
  t('DS-875 AC4 `rules` names the rules for the agent, prose and all', configRows(text, ['rules', '1']).startsWith("## Rules for the agent reading this file\n\n5. **The Recommended column is not this user's answer.**\n\n## 1. You"), true);
  const showEnv = { ...process.env, DESK_CONFIG: join(T, 'show.md'), DESK_MACHINE: join(T, 'none.md'), HOME: T };
  writeFileSync(join(T, 'show.md'), text);
  t('#746 desk-env show prints the same', execFileSync('node', [BIN, 'show', 'rules', '3'], { encoding: 'utf8', env: showEnv }).trim(), configRows(text, ['rules', '3']));
  const showRun = (args, env = showEnv) => spawnSync('node', [BIN, 'show', ...args], { encoding: 'utf8', env });
  t('#746 with no config it exits 3', showRun([], { ...showEnv, DESK_CONFIG: join(T, 'missing.md') }).status, 3);
  t('DS-875 AC4 desk-env show 3c exits 2 and prints no ledger', (({ status, stdout }) => `${status} ${/Bash\(x\)/.test(stdout)}`)(showRun(['3', '§3c'])), '2 false');
  t('DS-875 an unknown section exits 2, naming it', (({ status, stderr }) => `${status} ${/"9"/.test(stderr)}`)(showRun(['9'])), '2 true');
  t('DS-875 AC4 every section show prints leaves the ledger out', /Bash\(x\)|3c/.test(showRun([]).stdout), false);
}
// The schema (config-schema.mjs) against the shipped template, both ways, and the id tables desk-env
// derives from it against the literals they replaced.
{
  const tpl = readFileSync(join(ROOT, 'desk-config.md'), 'utf8');
  const named = (list) => list.map(({ section, label }) => `§${section} ${label}`).join(' / ');
  const cov = coverage(declaredRows(tpl));
  t('DS-867 AC1 every row the template declares in §0 to §5 has a schema entry with its section and label', named(cov.missing), '');
  t('DS-867 AC2 every schema entry names a row or table the template declares', named(cov.extra), '');
  const declared = declaredRows(tpl);
  t('DS-867 AC1 the §3c ledger and the review asks are not declared rows', declared.rows.some((r) => r.section === '3c' || /^(todo|rule)$/i.test(r.label)), false);
  t('DS-867 AC1 the §0 to §5 rows are all read', ['0', '1', '2', '3', '3b', '4', '5'].every((s) => declared.rows.some((r) => r.section === s)), true);
  const added = tpl.replace('| Slack channels |', '| Pager rota | `TODO` |\n| Slack channels |');
  t('DS-867 AC3 a template row the schema lacks is named by section and label', named(coverage(declaredRows(added)).missing), '§4 Pager rota');
  t('DS-867 AC3 so is a removed one, from the schema side', named(coverage(declaredRows(tpl.replace(/^\| Slack channels \|.*\n/m, ''))).extra), '§4 Slack channels');
  t('DS-867 every schema id is unique', ROWS.length - new Set(ROWS.map((e) => e.id)).size, 0);
  t('DS-867 every entry has a known kind and section', ROWS.filter((e) => !['value', 'list', 'perm', 'table'].includes(e.kind) || !['0', '1', '2', '3', '3b', '4', '5'].includes(e.section)).map((e) => e.id).join(' '), '');

  // AC4: the literals desk-env held before the schema, as `id|section|row`, `|table` marking a table id.
  const BEFORE_ROWS = [
    'gh-repo|0|GitHub repo', 'default-branch|0|Default branch', 'repo-description|0|One-line description', 'github-handle|1|GitHub handle',
    'jira-email|1|Jira email', 'jira-display-name|1|Jira display name', 'jira-account-id|1|Jira account id', 'git-author|1|Git author name / email',
    'name|1|Name', 'repo-root|2|Primary repo root', 'worktrees-dir|2|Worktrees directory', 'handoff-dir|2|Handoff directory',
    'backups-dir|2|Backups directory', 'design-dir|2|Design canvases directory', 'wsl|2|Running on WSL?', 'browser-profile|2|Signed-in browser profile',
    'handoff-pct|2|Handoff at context %', 'handoff-pct-1m|2|Handoff at context % on a 1M window', 'tracker|4|Tracker', 'jira-site|4|Jira site',
    'jira-project|4|Jira project', 'ticket-pattern|4|Ticket key pattern', 'in-progress-state|4|In-progress state', 'review-state|4|Review state',
    'done-state|4|Done state', 'jira-priority|4|Priority', 'jira-other-fields|4|Other fields', 'jira-required-fields|4|Required fields',
    'jira-size-field|4|Size field', 'jira-priority-user-only|4|Priorities only you set', 'jira-cloudid|4|Jira cloudId', 'labels|4|Labels',
    'person-step-labels|4|Person-step labels', 'person-input-labels|4|Person-input labels', 'required-checks|4|Required checks',
    'work-id-patterns|4|Other work id patterns', 'merge-holds|4|Merge holds', 'incidental-paths|4|Incidental paths',
    'append-only-paths|4|Append-only paths', 'merge-method|4|Merge method', 'local-review|4|Local review command',
    'clean-verdict|4|Clean review verdict', 'review-account|4|Review account', 'gate-reviewers|4|Gate reviewers', 'review-bar|4|Review bar',
    'review-experts|4|Review domain experts', 'agents-sync|4|Project subagents sync', 'package-manager|4|Package manager',
    'command-prefix|4|Command prefix', 'install-cmd|4|Install', 'dev-cmd|4|Dev server', 'typecheck-cmd|4|Typecheck', 'lint-cmd|4|Lint',
    'baseline-checks|4|Baseline checks', 'test-cmd|4|Unit tests', 'related-test-cmd|4|Related tests', 'suite-weight|4|Suite weight',
    'e2e-cmd|4|E2E tests', 'storybook-cmd|4|Storybook', 'build-cmd|4|Build', 'codegen-cmd|4|Codegen', 'integration-cmd|4|Integration tests',
    'acceptance-specs|4|Acceptance specs', 'pre-push-checks|4|Pre-push checks', 'merged-tree-check-cmd|4|Merged-tree check',
    'pr-description-checks|4|PR-description checks', 'seed-cmd|4|Seed', 'db-url-var|4|Database URL variable', 'db-migrate-cmd|4|Database migrate',
    'branch-protection|4|Branch protection', 'advisory-checks|4|Advisory checks', 'flaky-checks|4|Known flaky checks', 'state-checks|4|State checks',
    "operator-checks|4|Checks workers can't fix", 'check-builds|4|Check builds', 'live-reads|4|Live reads', 'pre-merge-steps|4|Pre-merge steps',
    'evidence-workflow|4|Evidence workflow', 'worker-workflows|4|Worker workflows', 'worker-read-repos|4|Worker read-only repos',
    'worker-measure-cmds|4|Worker measuring commands', 'repo-merge-settings|4|Repo merge settings', 'vercel|4|Vercel',
    'staging-bypass|4|Staging bypass token location', 'slack-channels|4|Slack channels', 'review-asks|4|What review here consistently asks for|table',
    'code-reviewer|4|Code reviewer', 'product-owner|4|Product owner', 'repo-instructions|5|Repo instructions',
    'subagents-without-asking|3b|Subagents that may run without asking', 'test-cap|3b|Test worker cap under the test lock',
    'spawn-gate|3b|Spawn gate (available memory)', 'park-after|3b|Park an unanswered question after (minutes)',
    'resume-killed|3b|Resume a killed worker (times)', 'disk-floor|3b|Free disk floor (GB)', 'promotion-slice|3b|Promotion slice size (children)',
    'claim-release|3b|Release idle claims after (hours)', 'usage-pacing|3b|Usage pacing headroom (points)', 'subscription|3b|Subscription',
    'checkin-times|3b|Check-in times', 'intake-query|3b|Intake query', 'file-budget|3b|Per-file collision budget',
    'triage-concurrency|3b|Triage concurrency', 'maintenance-window|3b|Maintenance window', 'maintenance-drain|3b|Maintenance drain limit (minutes)',
    'env-files|4|Env files', 'local-db|4|Local database', 'local-services|4|Local services', 'staging|4|Staging', 'promotion-ref|4|Promotion ref',
    'checkout-destination|4|Check-out destination', 'ai-attribution|5|AI attribution', 'branch-names|5|Branch names', 'pr-title|5|PR title',
    'breakpoints|5|Breakpoints', 'themes|5|Themes', 'design-system|5|Design system', 'dev-port|3b|Preferred dev-server port',
    'concurrency|3b|Autopilot worker concurrency', 'memory-ceiling|3b|Memory ceiling for parallel work (GB)',
    'worker-budget|3b|Autopilot per-worker budget (USD)', 'batch-budget|3b|Autopilot batch budget (USD)', 'worker-models|3b|Worker models',
    'worker-location|3b|Worker location', 'borrow-idle|3b|Borrow idle workers', 'batches-run-by|3b|Batches run by',
    'status-table|3b|Orchestrator status table', 'levers|3b|Phase 0 levers', 'worker-effort|3b|Worker effort', 'codex-models|3b|Codex review',
  ];
  const BEFORE_PERMS = ('read-own-work read-local-git read-others read-slack-public read-figma read-vercel read-confluence read-transcripts '
    + 'read-calendar read-slack-own jira-assign-self jira-comment jira-create jira-edit jira-transition jira-close-own-merged jira-close '
    + 'jira-route jira-others git-commit git-push git-force-with-lease pr-open pr-edit pr-images pr-self-review-comment pr-review-others '
    + 'pr-reply pr-request-review pr-ready pr-auto-merge pr-merge-green merge-feedback-first pr-update-branch pr-conflict-unreviewed '
    + 'pr-conflict-reviewed ci-rerun codex-review ci-protection gh-close-linked-issue gh-issue-create gh-issue-comment autopilot-workers '
    + 'autopilot-worker-mode autopilot-merge merge-hold-routine batch-base-push autopilot-judgement autopilot-reclaim machine-reboot '
    + 'worker-dependency-install worker-screenshots worker-local-services worker-web-read worker-workflow-dispatch db-per-ticket '
    + 'db-clone-staging staging-write local-reindex tests-shared-db worktree-remove branch-delete server-stop skills-edit vercel-env '
    + 'slack-draft slack-send merge-bypass others-prs product-calls legal-content').split(' ');
  // Rows the schema gained after it replaced those literals, each named with its ticket, so a row
  // lost or renamed still fails while a deliberate addition is recorded here.
  const ADDED_ROWS = [
    'test-signin|4|Test sign-in', // DS-804
    'other-names|0|Other names', // DS-805
    'harm-swap-growth|3b|Swap growth that holds spawns (GB)', // DS-848
    'harm-tmpfs|3b|tmpfs /tmp size that holds spawns (GB)', // DS-848
    'harm-vmmem|3b|WSL VM share of its grant that holds spawns (%)', // DS-848
    'jira-field-defaults|4|Field defaults',
    'proposal-labels|4|Priority proposal labels',
    'preview-db|4|Preview database', // DS-550
    'plan-first-wait|3b|Plan-first wait before needs-you (hours)', // issue-1384
    'slot-candidates|3b|Propose candidates for a free slot', // #1394
    'light-lock-slots|3b|Light lock slots',
  ];
  const ADDED_PERMS = ['worker-preview-db', 'gh-issue-edit']; // DS-550, #1383
  const sorted = (a) => [...a].sort().join('\n');
  const rowsNow = Object.entries(CONFIG_ROWS).map(([id, r]) => [id, r.section, r.row, ...(r.table ? ['table'] : [])].join('|'));
  t('DS-867 AC4 CONFIG_ROWS holds exactly the ids, sections and rows it held, and the ones added since', sorted(rowsNow), sorted([...BEFORE_ROWS, ...ADDED_ROWS]));
  t('DS-867 AC4 and nothing else on any entry', Object.values(CONFIG_ROWS).filter((r) => Object.keys(r).some((k) => !['section', 'row', 'table'].includes(k))).length, 0);
  t('DS-867 AC4 PERMISSION_KEYS holds exactly the ids and keys it held, and the ones added since', sorted(Object.entries(PERMISSION_KEYS).map(([id, k]) => `${id}=${k}`)), sorted([...BEFORE_PERMS, ...ADDED_PERMS].map((k) => `${k}=${k}`)));
  t('DS-867 AC4 both stay frozen', Object.isFrozen(CONFIG_ROWS) && Object.isFrozen(PERMISSION_KEYS), true);
}

// Every schema entry's type, example and default, and the template's Recommended column, parse by the
// row's type; each type parses a good item and refuses a bad one, fatal only where the reader throws.
{
  const errs = (pairs) => pairs.filter(([, r]) => r.error).map(([id, r]) => `${id}: ${r.error}`).join(' / ');
  t('DS-868 every entry names a known type and has an example', ROWS.filter((e) => !TYPES[e.type] || e.example == null).map((e) => e.id).join(' '), '');
  t('DS-868 AC1 every entry\'s example parses by its type', errs(ROWS.map((e) => [e.id, parseRow(e, e.example)])), '');
  t('DS-868 every default parses by its type', errs(ROWS.filter((e) => 'default' in e).map((e) => [e.id, parseRow(e, e.default)])), '');

  // The template's Recommended cells, by section and row label.
  const recs = [];
  let section = null, col = -1, inTable = false;
  for (const line of readFileSync(join(ROOT, 'desk-config.md'), 'utf8').split('\n')) {
    const h = /^##\s+(\d+[a-z]?)\.\s/.exec(line);
    if (h) section = h[1];
    if (!line.startsWith('|')) { inTable = false; continue; }
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    if (!inTable) { inTable = true; col = cells.findIndex((c) => /^recommended$/i.test(c)); continue; }
    if (col < 0 || /^-+$/.test(cells[0]) || !cells[col]) continue;
    recs.push({ section, label: cells[0], cell: cells[col] });
  }
  t('DS-868 AC2 the template\'s Recommended cells are found in §3 and §3b', ['3', '3b'].every((s) => recs.filter((r) => r.section === s).length > 20), true);
  const entryOf = (r) => ROWS.find((e) => e.section === r.section && norm(e.label) === norm(r.label));
  t('DS-868 AC2 every row with a Recommended value has a schema entry', recs.filter((r) => !entryOf(r)).map((r) => r.label).join(' / '), '');
  t('DS-868 AC2 every Recommended value parses by its row\'s type', errs(recs.filter(entryOf).map((r) => [entryOf(r).id, parseRow(entryOf(r), cellItems(r.cell))])), '');

  // One good and one bad item per type: [type, good, bad or null where nothing is refused, fatal].
  const CASES = [
    ['text', 'anything at all', null], ['perm', 'ask', 'maybe', false], ['perm-merged', 'merged', 'gone', false],
    ['whole', '4', 'four', false], ['whole-or-none', 'none', '-1', false], ['promotion-slice', '5', '11', false],
    ['number', '1.5', 'soon', false], ['number-or-off', 'off', 'on', false], ['gb', '16', '0', false], ['port', '3228', '70000', false],
    ['subagent-cap', 'no cap', 'lots', false], ['concurrency', '2 / 3', 'two', false], ['times', '08:00, 17:00', 'morning', false],
    ['yes-no', 'no', 'maybe', false], ['on-off', 'on', 'yes', false], ['tracker', 'none', 'linear', false],
    ['merge-method', 'rebase', 'squash-merge', false], ['suite-weight', 'heavy', 'medium', false], ['status-table', 'quiet', 'loud', false],
    ['batches-run-by', 'session', 'cron', false], ['ai-attribution', 'allowed', 'sometimes', false], ['regex', 'KAN-[0-9]+', 'KAN-[0-9', false],
    ['command', 'apps/api: uv run pytest', null], ['test-signin', 'apps/portal: dev@example.test', 'apps/portal: hunter2', false], ['preview-db', 'delete: neonctl branches delete {db}', 'delete: x {name}', false], ['service-port', 'search: 8108', 'Typesense on port 8108', false],
    ['required-fields', 'Bug: customfield_1', 'customfield_1', false], ['field-defaults', 'customfield_1 = from parent', 'customfield_1', false], ['lever', 'codex, effort', 'turbo', false],
    ['budget', '25', '25 USD', true], ['worker-models', 'default', 'fast', true], ['worker-effort', 'task=low', '4b=extreme', true],
    ['worker-location', 'cloud', 'remote', true], ['codex-review', 'timeout=60', 'timeout=soon', true],
    ['spawn-gate', 'start work > 8 GiB', null], ['file-budget', '2', 'two', false],
    ['git-author', 'Pat <pat@example.com>', 'Pat', true], ['review-account', 'none', 'agent pullbot', true],
    ['gate-reviewers', 'agent-pullbot', 'agent pullbot', true],
    ['flaky-check', 'e2e: e2e/** playwright.config.ts', 'e2e:', false], ['state-check', 'Review gate: approval', 'Review gate: external', false],
    ['operator-check', 'Flows image: ./build.sh', 'Flows image', false], ['live-read', 'gateway-models: ./fetch.sh', 'gateway/models: ./fetch.sh', false],
    ['merge-hold', 'package.json#scripts: changes CI; desk runs: ./ci.sh', '', false],
  ];
  t('DS-869 a merge-hold item parses to parseHolds\' hold', JSON.stringify(TYPES['merge-hold'].parse('package.json#scripts: changes CI; desk runs: ./ci.sh').value),
    JSON.stringify({ glob: 'package.json#scripts', path: 'package.json', key: 'scripts', why: 'changes CI', routine: './ci.sh' }));
  t('DS-869 the Merge holds row declares the merge-hold type', ROWS.find((e) => e.id === 'merge-holds').type, 'merge-hold');
  t('DS-868 every type has a parse case', Object.keys(TYPES).filter((n) => !CASES.some(([c]) => c === n)).join(' '), '');
  for (const [name, good, badItem, fatal] of CASES) {
    const type = TYPES[name];
    let r;
    try { r = type.parse(good); } catch (e) { r = { error: `threw ${e.message}` }; }
    t(`DS-868 ${name} parses "${good}"`, r.error ?? 'ok', 'ok');
    if (badItem == null) continue;
    try { r = type.parse(badItem); } catch (e) { r = { error: `threw ${e.message}`, threw: true }; }
    t(`DS-868 ${name} refuses "${badItem}" without throwing, ${fatal ? '' : 'not '}fatal`, `${!!r.error && !r.threw} ${r.fatal}`, `true ${fatal}`);
  }
  const paidRead = (item) => TYPES['live-read'].parse(item);
  t('DS-574 AC5 a paid Live reads entry with both caps is written', JSON.stringify(paidRead('gateway-chat [£0.10/call, £2/day]: ./chat.sh').value?.caps), '{"call":0.1,"day":2}');
  t('DS-574 AC5 one missing its daily cap is refused, saying both are needed', paidRead('gateway-chat [£0.10/call]: ./chat.sh').error?.includes('a paid call takes both caps'), true);
  t('DS-574 AC5 one missing its per-call cap is refused', !!paidRead('gateway-chat [£2/day]: ./chat.sh').error, true);
  t('DS-574 AC5 an empty bracket is refused', !!paidRead('gateway-chat []: ./chat.sh').error, true);
  const svc = TYPES['service-port'].parse('Typesense on port 8108');
  t('DS-868 AC3 the service-port error names the form <service> [:<port>]', svc.error?.includes('`<service> [:<port>]`'), true);
  t('DS-868 AC3 the decision: a service with no port parses', JSON.stringify(TYPES['service-port'].parse('mailpit').value), '{"service":"mailpit","port":null}');
  t('DS-868 AC4 Worker location "remote" is a fatal error, as its reader throws on it', TYPES['worker-location'].parse('remote').fatal, true);
  t('DS-868 AC4 the service-port error is not fatal, as its reader warns', svc.fatal, false);
  const list = ROWS.find((e) => e.id === 'evidence-workflow');
  t('DS-868 none beside another item in a list row is fatal, as configValues refuses it', parseRow(list, ['none', 'pr-evidence.yml']).fatal, true);
  t('DS-868 a lone none is a list row\'s value', JSON.stringify(parseRow(list, ['none']).value), '["none"]');

  // A row whose reader reads every span is parsed whole, as the reader reads it.
  const row = (id) => ROWS.find((e) => e.id === id);
  t('DS-868 Worker effort named twice across spans is fatal, as its reader throws', parseRow(row('worker-effort'), ['0=low', '0=high']).fatal, true);
  t('DS-868 Codex review named twice across spans is fatal, as its reader throws', parseRow(row('codex-models'), ['timeout=60', 'timeout=90']).fatal, true);
  t('DS-868 a collision budget of two spans is refused, not fatal, as its reader reads it as 1', parseRow(row('file-budget'), ['2', 'serial: x']).fatal, false);
  t('DS-868 Git author as two spans parses', JSON.stringify(parseRow(row('git-author'), ['Pat', 'pat@example.com']).value), '{"name":"Pat","email":"pat@example.com"}');
  t('DS-868 Check-in times reads as the digest does', [parseRow(row('checkin-times'), ['08:00', '17:00']).error ?? 'ok', parseRow(row('checkin-times'), '08:00 17:00').error ?? 'ok', !!parseRow(row('checkin-times'), '25:00').error].join(' '), 'ok ok true');
  t('DS-871 Phase 0 levers is checked whole, its value still one entry per span', [JSON.stringify(parseRow(row('levers'), ['codex', 'effort']).value),
    JSON.stringify(parseRow(row('levers'), ['none']).value), !!parseRow(row('levers'), ['none,', 'effort']).error].join(' '), '[["codex"],["effort"]] ["none"] true');
  t('DS-868 a default is only where the reader has one fixed value', ['memory-ceiling', 'handoff-pct-1m'].filter((id) => 'default' in row(id)).join(' '), '');

  // The machine profile fallback desk-env reads.
  t('DS-868 MACHINE_FALLBACK is the four machine rows', JSON.stringify(MACHINE_FALLBACK), '{"concurrency":"autopilot-concurrency","memory-ceiling":"memory-ceiling-gb","test-cap":"test-cap","light-lock-slots":"light-lock-slots"}');
}

// `desk-env get --json`: typed rows with where each value came from, its default and its type errors.
{
  const bare = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DESK_|GIT_)/.test(k)));
  const jenv = (cfg, extra = {}) => ({ ...bare, HOME: T, DESK_CONFIG_ROOT: join(T, 'cfg-870'), DESK_MACHINE: join(T, 'none.md'), DESK_CONFIG: cfg, ...extra });
  const node = (env, args, cwd = T) => spawnSync('node', [BIN, ...args], { encoding: 'utf8', env, cwd });
  const getJson = (env, ...a) => {
    const r = node(env, ['get', '--json', ...a]);
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
    return { code: r.status, json, out: r.stdout, err: r.stderr.trim() };
  };
  const c = join(T, 'json.md');
  writeFileSync(c, `${P4}| Tracker | \`jira\` |\n| Required checks | \`Lint\` \`Unit tests\` |\n| Local services | \`Typesense on port 8108\` |\n`
    + `| Append-only paths | \`TODO\` |\n| Production | \`https://example.com\` |\n\n${B3}| Autopilot worker concurrency | \`2 / 3\` | \`TODO\` |\n`);
  let r = getJson(jenv(c), 'tracker', 'required-checks');
  const tr = r.json?.rows?.tracker, rc = r.json?.rows?.['required-checks'];
  t('DS-870 AC1 prints one JSON object and exits 0', `${r.code} ${!!r.json}`, '0 true');
  t('DS-870 AC1 Tracker reads jira, set, from the repo', JSON.stringify([tr?.value, tr?.set, tr?.source]), '["jira",true,"repo"]');
  t('DS-870 AC1 Required checks gives both checks as items, set, from the repo', JSON.stringify([rc?.items, rc?.set, rc?.source]), '[["Lint","Unit tests"],true,"repo"]');
  r = getJson(jenv(c), 'local-services');
  const ls = r.json?.rows?.['local-services'];
  t('DS-870 AC2 a row with a type error prints the JSON and exits 4', `${r.code} ${!!r.json}`, '4 true');
  t('DS-870 AC2 the error names the item and the form the type expects', ls?.errors?.length === 1 && ls.errors[0].item === 'Typesense on port 8108' && ls.errors[0].error.includes('`<service> [:<port>]`'), true);
  writeFileSync(join(T, 'machine-870.md'), '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
  const cc = getJson(jenv(c, { DESK_MACHINE: join(T, 'machine-870.md') }), 'concurrency').json?.rows?.concurrency;
  t('DS-870 AC3 a TODO row the machine profile sets reads the profile, source machine', JSON.stringify([cc?.value, cc?.set, cc?.source]), '["5 / 10",true,"machine"]');
  r = getJson(jenv(c), '--section', '4');
  const four = ROWS.filter((e) => e.section === '4').map((e) => e.id);
  t('DS-870 AC4 --section 4 gives every §4 row the schema declares, and only those', JSON.stringify(Object.keys(r.json?.rows ?? {})), JSON.stringify(four));
  t('DS-870 AC4 the §4 rows no script reads yet are among them', ROWS.some((e) => e.section === '4' && e.unread && !CONFIG_ROWS[e.id]) && four.every((id) => r.json?.rows?.[id]), true);
  t('DS-870 AC4 and every row it gives is a §4 row', Object.values(r.json?.rows ?? {}).every((x) => x.section === '4'), true);
  const prod = r.json?.rows?.production;
  t('DS-870 AC4 an unread row reads its repo value, set, from the repo', JSON.stringify([prod?.value, prod?.items, prod?.set, prod?.source]), '["https://example.com",["https://example.com"],true,"repo"]');
  r = getJson(jenv(c), '--section', '3c');
  t('DS-870 AC5 --section 3c exits 2 and prints no rows', `${r.code} ${r.out === ''}`, '2 true');
  t('DS-870 AC5 saying the ledger is read by desk-setup alone', /§3c.*\/desk-setup alone/.test(r.err), true);
  r = getJson(jenv(c), 'tracker', 'no-such-row');
  t('DS-870 AC6 an unknown id exits 2 naming it', `${r.code} ${r.out === ''} ${r.err.includes('"no-such-row"')}`, '2 true true');
  const nowhere = scratch('desk-norepo-870-');
  r = node({ ...bare, HOME: nowhere, DESK_CONFIG_ROOT: join(nowhere, 'cfg'), DESK_MACHINE: join(nowhere, 'none.md') }, ['get', '--json', 'tracker'], nowhere);
  t('DS-870 AC7 outside any configured repo it exits 3, printing nothing', `${r.status} ${r.stdout === ''}`, '3 true');
  r = node({ ...bare, HOME: nowhere, DESK_CONFIG_ROOT: join(nowhere, 'cfg'), DESK_MACHINE: join(nowhere, 'none.md') }, ['get', '--json', '--where', 'tracker'], nowhere);
  let wj = null; try { wj = JSON.parse(r.stdout); } catch { /* not JSON */ }
  t('DS-933 --where outside any repo still prints where, with no rows, and exits 3', JSON.stringify([r.status, wj?.where?.slug, wj?.where?.exists, wj?.rows]), '[3,"",false,{}]');
  rmSync(nowhere, { recursive: true, force: true });
  {
    const env = jenv(c);
    const w = Object.fromEntries(node(env, ['where']).stdout.trim().split('\n').map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^'|'$/g, '')]; }));
    const g = getJson(env, '--where', 'tracker');
    t('DS-933 --where gives what where prints, beside the rows', JSON.stringify([g.code, g.json?.where, g.json?.rows?.tracker?.value]),
      JSON.stringify([0, { slug: w.SLUG, gh_repo: w.GH_REPO, config: w.CONFIG, creds: w.CREDS, exists: w.EXISTS === 'yes' }, 'jira']));
    t('DS-933 without --where there is no where', 'where' in (getJson(env, 'tracker').json ?? { where: 1 }), false);
    const rules = ['Story, bug : customfield_1, customfield_2', 'task:customfield_3 customfield_1,customfield_3', 'Évolution: f4', 'BUG: customfield_5', 'no rule here'];
    const by = requiredFieldsByType(rules);
    t('DS-933 requiredFieldsByType gives one key per type case-blind, as first written', JSON.stringify(Object.keys(by.need)), '["Story","bug","task","Évolution"]');
    t('DS-933 and each key holds what requiredFieldsIn gives that type', Object.entries(by.need).every(([ty, need]) => JSON.stringify(need) === JSON.stringify(requiredFieldsIn(rules, ty).need)) && JSON.stringify(by.need.bug), '["customfield_1","customfield_2","customfield_5"]');
    t('DS-933 with the malformed items requiredFieldsIn names', JSON.stringify(by.malformed), JSON.stringify(requiredFieldsIn(rules, null).malformed));
    t('DS-933 --where without jira-required-fields gives no required_fields', 'required_fields' in (getJson(env, '--where', 'tracker').json ?? { required_fields: 1 }), false);
  }
  writeFileSync(c, `${P4}| Local services | \`TODO\` |\n| Append-only paths | \`TODO\` |\n`);
  r = getJson(jenv(c), 'local-services', 'append-only-paths');
  const fields = (x) => JSON.stringify([x?.set, x?.source, x?.value, x?.items, x?.default]);
  t('DS-870 AC11 an unset row is not set, source unset, with a null value', fields(r.json?.rows?.['local-services']), '[false,"unset",null,null,null]');
  t('DS-870 AC11 the schema default is reported in its own field, never as the value', fields(r.json?.rows?.['append-only-paths']), '[false,"unset",null,null,["none"]]');

  // `desk-env unset`: the rows that still need an answer, which install.sh counts.
  {
    const u = join(T, 'unset-874.md');
    writeFileSync(u, '## 1. Who you are\n\n| Field | Value |\n|---|---|\n| GitHub handle | `TODO` |\n| Name | `Pat` |\n| Pronouns (optional) | `TODO` (a note) |\n\n'
      + '## 2. Paths\n\n| Field | Value | Notes |\n|---|---|---|\n| Worktrees directory | `~/wt` | not `TODO` |\n| Primary repo root | `~/r` (not `TODO`) | x |\n| Handoff at context % | `TODO` | |\n\n'
      + `${B3}| Autopilot worker concurrency | \`2 / 3\` | \`TODO\` |\n| Memory ceiling for parallel work (GB) | \`16\` | \`TODO\` |\n`
      + '| Test worker cap under the test lock | `4` | `TODO` |\n| Triage concurrency | `1` | `3` (left `TODO` it is 1) |\n| Intake query | `none` | `TODO` |\n| Not a schema row | `x` | `TODO` |\n\n'
      + '## 3. Permissions\n\n| Key | Capability | Recommended | Your setting |\n|---|---|---|---|\n| `pr-open` | Open a PR | `yes` | `TODO` |\n| `git-push` | Push | `yes` | `yes` |\n');
    const unsetJson = (extra) => {
      const x = node(jenv(u, extra), ['unset', '--json']);
      let j = null; try { j = JSON.parse(x.stdout); } catch { /* not JSON */ }
      return { code: x.status, j };
    };
    const listed = (x) => (x.j?.rows ?? []).map((e) => `${e.section}|${e.label}`).join(' / ');
    let u1 = unsetJson();
    t('DS-874 AC4 unset --json lists the rows with no value of their own, none from the machine profile and no default, each with section and label',
      `${u1.code} ${listed(u1)}`, '0 1|GitHub handle / 1|Pronouns (optional) / 3|pr-open / 3b|Autopilot worker concurrency / 3b|Memory ceiling for parallel work (GB) / 3b|Test worker cap under the test lock');
    t('DS-874 AC4 it names the config it read', u1.j?.config, u);
    writeFileSync(join(T, 'machine-874.md'), '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `4 / 8` | x |\n| memory-ceiling-gb | `24` | x |\n| test-cap | `3` | x |\n');
    u1 = unsetJson({ DESK_MACHINE: join(T, 'machine-874.md') });
    t('DS-874 AC4 a machine profile that sets the three machine rows answers them', listed(u1), '1|GitHub handle / 1|Pronouns (optional) / 3|pr-open');
    t('DS-874 AC4 each row carries its id', (u1.j?.rows ?? []).map((e) => e.id).join(' '), 'github-handle pronouns pr-open');
    writeFileSync(join(T, 'machine-874b.md'), '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| test-cap | `3` | x |\n');
    u1 = unsetJson({ DESK_MACHINE: join(T, 'machine-874b.md') });
    t('DS-874 AC4 a machine row the profile does not set still counts, its schema default aside', listed(u1).includes('3b|Autopilot worker concurrency') && !listed(u1).includes('Test worker cap'), true);
    const plain = node(jenv(u), ['unset']);
    t('DS-874 plain unset prints one §<section> TAB <label> line per row', plain.stdout.split('\n')[0], '§1\tGitHub handle');
    const none = node(jenv(join(T, 'absent-874.md')), ['unset', '--json']);
    t('DS-874 with no config it exits 3, printing nothing', `${none.status} ${none.stdout === ''}`, '3 true');
  }

  // Where something other than the row gives the value, its type is checked on that value, not the row.
  const label = (id) => ROWS.find((e) => e.id === id).label;
  const root = join(T, 'root-870');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ env: { DESK_SUITE_WEIGHT: 'medium' } }));
  writeFileSync(c, `## 0. Rows\n\n| Field | Value |\n|---|---|\n| ${label('default-branch')} | \`main\` |\n\n## 2. Rows\n\n| Field | Value |\n|---|---|\n| ${label('repo-root')} | \`${root}\` |\n\n`
    + `${P4}| ${label('suite-weight')} | \`light\` |\n\n${B3}| ${label('memory-ceiling')} | \`16\` | \`32\` |\n`);
  writeFileSync(join(T, 'machine-870.md'), '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| memory-ceiling-gb | `16` | x |\n');
  r = getJson(jenv(c, { DESK_MACHINE: join(T, 'machine-870.md'), DESK_DEFAULT_BRANCH: 'release' }), 'default-branch', 'memory-ceiling', 'suite-weight');
  const read = (x) => JSON.stringify([x?.value, x?.source, x?.parsed, x?.errors?.map((e) => e.item)]);
  t('DS-870 a DESK_DEFAULT_BRANCH over the row is the value parsed, source environment', read(r.json?.rows?.['default-branch']), '["release","environment","release",[]]');
  t('DS-870 a memory ceiling the machine caps is the cap parsed, source machine', read(r.json?.rows?.['memory-ceiling']), '["16","machine",16,[]]');
  t('DS-870 a committed suite weight over the row is the value checked, so a bad one errors and exits 4', `${r.code} ${read(r.json?.rows?.['suite-weight'])}`, '4 ["medium","repo",null,["medium"]]');

  // The parity sweeps: a config holding every row desk-env reads, each set to TODO, its example or none,
  // read through `get --json` and through `desk-env config`, which snapshots every get, list and perm
  // read in one process. A snapshot value is `=` and what the read printed, `!` where it exits 3, and
  // empty where it threw.
  const snapshot = (env) => {
    const out = {};
    for (const m of node(env, ['config']).stdout.matchAll(/_DESK_([GLPU])_(\w+)='((?:[^']|'\\'')*)'/g)) out[`${m[1]} ${m[2].replaceAll('_', '-')}`] = m[3].replaceAll("'\\''", "'");
    return out;
  };
  const span = (v) => [].concat(v).map((x) => `\`${x}\``).join(' ');
  const valueRows = ROWS.filter((e) => CONFIG_ROWS[e.id]);
  // The rows the schema marks unread are template rows too, but plain get and list refuse them as unknown
  // (the schema keeps them out of CONFIG_ROWS, and this ticket leaves get and list as they are), so they
  // have no printed value to match. AC8 and AC9 cover them as that: get and list refuse each one, and
  // get --json reads each through the same configValueFrom and configValuesIn as the rows get serves.
  const unreadRows = ROWS.filter((e) => e.kind !== 'perm' && e.unread);
  t('DS-870 AC8/AC9 every template row but the permissions is swept, served or unread', valueRows.length + unreadRows.length, ROWS.filter((e) => e.kind !== 'perm').length);
  const sweptRows = [...valueRows, ...unreadRows];
  const configOf = (pick) => [...new Set(sweptRows.map((e) => e.section))].map((s) => {
    const es = sweptRows.filter((e) => e.section === s);
    const rows = es.filter((e) => e.kind !== 'table').map((e) => `| ${e.label} | ${span(pick(e))} |`);
    const tables = es.filter((e) => e.kind === 'table').map((e) => `\n### ${e.label}\n\n| Ask | Detail |\n|---|---|\n`
      + [].concat(pick(e)).map((x) => { const [a, ...d] = String(x).split(': '); return `| \`${a}\` | ${d.length ? `\`${d.join(': ')}\`` : ''} |`; }).join('\n'));
    return `## ${s}. Rows\n\n| Field | Value |\n|---|---|\n${rows.join('\n')}\n${tables.join('\n')}\n`;
  }).join('\n');
  for (const [name, pick] of [['TODO', () => 'TODO'], ['its example', (e) => e.example], ['none', () => 'none']]) {
    const f = join(T, `sweep-${name.replace(/\W/g, '')}.md`);
    writeFileSync(f, configOf(pick));
    const env = jenv(f);
    const json = getJson(env, ...valueRows.map((e) => e.id)).json?.rows ?? {};
    const snap = snapshot(env);
    const db = node(env, ['get', 'default-branch']);
    snap['G default-branch'] = db.status === 3 ? '!' : `=${db.stdout}`;
    const getBad = [], listBad = [];
    for (const e of valueRows) {
      const j = json[e.id], g = snap[`G ${e.id}`], l = snap[`L ${e.id}`];
      if (!j || (g === '!' ? j.value !== null || j.set : g !== `=${j.value}\n`)) getBad.push(`${e.id}: get ${JSON.stringify(g)}, json ${JSON.stringify(j && [j.value, j.set])}`);
      const listed = l === '!' ? j?.items === null : l === '' ? j?.items === null && j.errors.some((x) => x.fatal) : l === `=${(j?.items ?? []).map((x) => `${x}\n`).join('')}` && j?.items !== null;
      if (!listed) listBad.push(`${e.id}: list ${JSON.stringify(l)}, json ${JSON.stringify(j && [j.items, j.errors])}`);
    }
    t(`DS-870 AC8 every row set to ${name} reads through get --json as through get (${valueRows.length} rows)`, getBad.join(' / '), '');
    t(`DS-870 AC9 every row set to ${name} reads through get --json as through list`, listBad.join(' / '), '');
    // An unread row: get and list refuse it, and get --json reads the cell as a served row's would read.
    const uj = getJson(env, ...unreadRows.map((e) => e.id)).json?.rows ?? {};
    const unreadBad = [];
    for (const e of unreadRows) {
      // As get and list print a path, `~` is the sweep's HOME (T).
      const cell = name === 'TODO' ? null : [].concat(pick(e)).map((x) => String(x).replace(/^~(?=\/|$)/, T));
      const want = JSON.stringify([cell?.[0] ?? null, cell, cell !== null]);
      const j = uj[e.id], got = JSON.stringify(j && [j.value, j.items, j.set]);
      const refused = ['get', 'list'].every((cmd) => { const x = node(env, [cmd, e.id]); return x.status !== 0 && x.stdout === '' && x.stderr.includes(`unknown config id "${e.id}"`); });
      if (got !== want || !refused) unreadBad.push(`${e.id}: json ${got}, want ${want}, get and list refuse it ${refused}`);
    }
    t(`DS-870 AC8/AC9 every unread row set to ${name} is refused by get and list, and read by get --json (${unreadRows.length} rows)`, unreadBad.join(' / '), '');
  }
  const permRows = ROWS.filter((e) => e.kind === 'perm');
  for (const v of ['yes', 'no', 'TODO']) {
    const f = join(T, `perms-${v}.md`);
    writeFileSync(f, `## 3. Permissions\n\n| Key | Capability | Recommended | Your setting |\n|---|---|---|---|\n${permRows.map((e) => `| \`${e.id}\` | c | \`yes\` | \`${v}\` |`).join('\n')}\n`);
    const env = jenv(f);
    const json = getJson(env, '--section', '3').json?.rows ?? {};
    const snap = snapshot(env);
    const bad = permRows.filter((e) => {
      const j = json[e.id];
      return !j || snap[`P ${e.id}`] !== `=${j.value}\n` || (snap[`U ${e.id}`] === '!') === j.set;
    }).map((e) => `${e.id}: perm ${JSON.stringify(snap[`P ${e.id}`])} unset ${snap[`U ${e.id}`] === '!'}, json ${JSON.stringify(json[e.id] && [json[e.id].value, json[e.id].set])}`);
    t(`DS-870 AC10 every permission set to ${v} reads through get --json as through perm (${permRows.length} keys)`, bad.join(' / '), '');
  }
}

rmSync(T, { recursive: true, force: true });

console.log(fails ? `${fails} FAILED` : 'config: all checks passed');
process.exit(fails ? 1 : 0);
