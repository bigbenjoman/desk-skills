// suite: the change log of worker-facing merges, config row edits and claude version bumps (desk-changes.mjs)
// layer: L2
// covers: desk/bin/desk-changes.mjs
// A fixture git history of merge and squash commits, config backups with set modification times, spawn
// records, per-ticket rows and audit rows; the log built from them and its before/after figures.
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { changeLog, isWorkerFacing, prOf, ticketOf, configEntries, claudeEntries, sideOf, median, logLines } from '../desk/bin/desk-changes.mjs';
import { configRowValues } from '../desk/bin/desk-env.mjs';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const T = scratch('desk-changes-');
const DAY = 86_400_000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
// git dates are whole seconds.
const gitIso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

// ---- paths ------------------------------------------------------------------------------------------
t('a skill is worker-facing', isWorkerFacing('skills/desk-ticket/SKILL.md'), true);
t('an agent is worker-facing', isWorkerFacing('agents/lena.md'), true);
t('a hook is worker-facing', isWorkerFacing('hooks/desk-handoff.py'), true);
t('spawn-worker.sh is worker-facing', isWorkerFacing('desk/bin/spawn-worker.sh'), true);
t('an orchestrator module is not', isWorkerFacing('desk/bin/pass.mjs'), false);
t('a module in a desk/bin subdirectory is not', isWorkerFacing('desk/bin/pass/desk-env.mjs'), false);
t('a test under skills/ is not', isWorkerFacing('skills/desk-pr/tests/test_x.mjs'), false);
t('a suite is not', isWorkerFacing('tests/test_desk_changes.mjs'), false);
t('docs are not', isWorkerFacing('docs/levers.md'), false);

// ---- PR subjects and keys ---------------------------------------------------------------------------
t('a merge commit names its PR and branch', JSON.stringify(prOf('Merge pull request #12 from o/feat/DS-7-x', 'feat: a title\n\nmore')), '{"pr":12,"branch":"feat/DS-7-x","title":"feat: a title"}');
t('a squash commit names its PR', JSON.stringify(prOf('fix: hooks (#15)', '')), '{"pr":15,"branch":null,"title":"fix: hooks"}');
t('a plain commit names none', prOf('chore: tidy', ''), null);
t('the key comes from the branch first', ticketOf('DS-[0-9]+', 'feat/DS-7-x', 'DS-9 title'), 'DS-7');
t('a longer number is not a shorter key', ticketOf('DS-1', 'feat/DS-12-x'), null);
t('no pattern: no key', ticketOf(null, 'feat/DS-7-x'), null);

// ---- a fixture history ------------------------------------------------------------------------------
const REPO = join(T, 'repo');
mkdirSync(REPO);
const git = (args, at = NOW) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
  cwd: REPO, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(T, 'none'), GIT_AUTHOR_DATE: gitIso(at), GIT_COMMITTER_DATE: gitIso(at) },
});
const write = (p, s) => { mkdirSync(dirname(join(REPO, p)), { recursive: true }); writeFileSync(join(REPO, p), s); };
git(['init', '-q', '-b', 'main']);
write('README.md', 'x\n');
git(['add', '-A']); git(['commit', '-qm', 'init'], NOW - 40 * DAY);
// git log --since stops at the first commit older than the cutoff, so the history runs in merge order.
const pr =(n, branch, title, files, at) => {
  git(['checkout', '-qb', branch]);
  for (const f of files) write(f, `${branch}\n`);
  git(['add', '-A']); git(['commit', '-qm', title], at - 1000);
  git(['checkout', '-q', 'main']);
  git(['merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${n} from o/${branch}`, '-m', title], at);
};
pr(16, 'feat/DS-12-old', 'feat: before the window', ['agents/a.md'], NOW - 35 * DAY);
pr(11, 'feat/DS-7-skill', 'feat: a skill change', ['skills/desk-ticket/SKILL.md'], NOW - 10 * DAY);
pr(12, 'chore/DS-8-tests', 'test: only tests and docs', ['tests/test_x.mjs', 'docs/a.md', 'skills/desk-pr/tests/test_y.mjs'], NOW - 9 * DAY);
pr(13, 'feat/DS-9-bin', 'feat: spawn and pass', ['desk/bin/spawn-worker.sh', 'desk/bin/pass.mjs'], NOW - 8 * DAY);
pr(14, 'fix/DS-10-pass', 'fix: pass only', ['desk/bin/pass.mjs'], NOW - 7 * DAY);
write('hooks/h.py', 'y\n'); git(['add', '-A']); git(['commit', '-qm', 'fix: DS-11 a hook (#15)'], NOW - 6 * DAY);
write('skills/desk-pr/SKILL.md', 'z\n'); git(['add', '-A']); git(['commit', '-qm', 'chore: pushed with no PR'], NOW - 5 * DAY);

// ---- config backups ---------------------------------------------------------------------------------
const CFG = join(T, 'cfg');
mkdirSync(CFG);
const cfg = (push, port, note = '') => `# Config\n\n## 3. Permissions\n| Key | Capability | Recommended | Your setting |\n|---|---|---|---|\n| \`git-push\` | Push | \`yes\` | \`${push}\`${note} |\n\n## 3b. Cost\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`${port}\` |\n`;
const copy = (name, text, at) => { const p = join(CFG, name); writeFileSync(p, text); utimesSync(p, at / 1000, at / 1000); };
copy('config.md.bak', cfg('ask', 3100), NOW - 4 * DAY);
copy('config.md.bak-2026-11-20', cfg('yes', 3100), NOW - 3 * DAY);
copy('config.md', cfg('yes', 3200, ' (a note added)'), NOW - 2 * DAY);
copy('costs.md.bak', cfg('no', 1), NOW - 1 * DAY);

t('configRowValues reads each declared row, its note left out', JSON.stringify(configRowValues(cfg('yes', 3200, ' (a note `x`)'))),
  '[{"section":"3","label":"git-push","value":"yes"},{"section":"3b","label":"Preferred dev-server port","value":"3200"}]');
const ce = configEntries({ dir: CFG });
t('AC3: one entry per changed row between consecutive copies', ce.length, 2);
t('AC3: the entry names the row and its old and new value', `${ce[0].row} ${ce[0].from} ${ce[0].to}`, '§3 git-push ask yes');
t('AC3: dated by the later copy', ce[0].at, iso(NOW - 3 * DAY));
t('AC3: a note alone is no change; the live file is compared too', `${ce[1].row} ${ce[1].from} ${ce[1].to} ${ce[1].at === iso(NOW - 2 * DAY)}`, '§3b Preferred dev-server port 3100 3200 true');
t('AC3: a copy before the window gives no entry', configEntries({ dir: CFG, since: NOW - 2.5 * DAY }).length, 1);
t('AC3: no config directory, no entries', configEntries({ dir: join(T, 'nope') }).length, 0);

// ---- claude versions --------------------------------------------------------------------------------
const rec = (d, v, ticket) => ({ at: iso(NOW - d * DAY), ticket, session: `s-${d}`, claude_version: v });
const records = [rec(20, null, 'A'), rec(19, '2.0.1 (Claude Code)', 'A'), rec(15, '2.0.1 (Claude Code)', 'B'), rec(12, '2.0.2 (Claude Code)', 'C'),
  rec(11.5, null, 'C'), rec(11, '2.0.2 (Claude Code)', 'D'), rec(1, '2.0.3 (Claude Code)', 'E')];
const cl = claudeEntries({ records });
t('AC4: one entry per version change, none for the first version', cl.length, 2);
t('AC4: at the first start on the new version', `${cl[0].at === iso(NOW - 12 * DAY)} ${cl[0].from} -> ${cl[0].to} ${cl[0].ticket}`, 'true 2.0.1 (Claude Code) -> 2.0.2 (Claude Code) C');
t('AC4: a start with no version is passed over', `${cl[1].from} ${cl[1].ticket}`, '2.0.2 (Claude Code) E');

// ---- before and after -------------------------------------------------------------------------------
t('median of an even count', median([4, 1, 3, 2]), 2.5);
t('median of none', median([]), null);
const AT = NOW - 10 * DAY;
const row = (key, d, cost, complete = true) => ({ key, merged_at: iso(AT + d * DAY), cost, cost_complete: complete });
const tickets = [row('B1', -3, 1), row('B2', -2, 3), row('B3', -1, 10), row('B4', -1, 99, false), row('OLD', -8, 50),
  row('A1', 1, 2), row('A2', 2, 4), { key: 'X', merged_at: null, cost: 5, cost_complete: true }];
const audits = [{ ticket: 'B1', p0: 0, p1: 2, p2: 1 }, { ticket: 'B2', p0: 1, p1: 0, p2: 1 }, { ticket: 'A1', findings_missing: true, p0: null, p1: null, p2: null }];
const before = sideOf({ tickets, audits, from: AT - 7 * DAY, to: AT });
t('AC5: before: median $ per accepted ticket over the costed ones, with counts', `${before.median_usd} ${before.costed} ${before.accepted}`, '3 3 4');
t('AC5: before: blind audit findings per audited PR, with the count', `${before.p0} ${before.p1} ${before.p2} ${before.audited}`, '0.5 1 1 2');
const after = sideOf({ tickets, audits, from: AT, to: AT + 7 * DAY });
t('AC5: after: an even count takes the middle two', `${after.median_usd} ${after.costed}`, '3 2');
t('AC5: after: an audit with no findings line is not counted', `${after.audited} ${after.p0}`, '0 null');

// ---- the whole log ----------------------------------------------------------------------------------
const log = changeLog({
  slug: 'o__r', now: NOW, days: 30, windowDays: 7, root: REPO, ref: 'main', pattern: 'DS-[0-9]+', configDir: CFG,
  batches: [], records, tickets, audits,
});
const prs = log.entries.filter((e) => e.kind === 'pr');
t('AC1: worker-facing merges and squashes have entries, oldest first', prs.map((e) => e.pr).join(','), '11,13,15');
t('AC1: with merge time, PR, ticket and title', `${prs[0].at === iso(Date.parse(gitIso(NOW - 10 * DAY)))} ${prs[0].pr} ${prs[0].ticket} ${prs[0].title}`, 'true 11 DS-7 feat: a skill change');
t('AC1: a squash commit\'s key comes from its title', prs[2].ticket, 'DS-11');
t('AC1: only the worker-facing paths are listed', prs[1].paths.join(','), 'desk/bin/spawn-worker.sh');
t('AC2: a PR of only tests and docs has no entry', prs.some((e) => e.pr === 12), false);
t('an orchestrator-only PR has no entry', prs.some((e) => e.pr === 14), false);
t('a PR merged before the window has no entry', prs.some((e) => e.pr === 16), false);
t('every kind is in the log', [...new Set(log.entries.map((e) => e.kind))].sort().join(','), 'claude,config,pr');
t('AC5: every entry carries its figures', log.entries.every((e) => e.before && e.after), true);
t('AC5: PR #11 has the figures either side of it', `${prs[0].before.median_usd} ${prs[0].after.median_usd}`, '3 3');
const lines = logLines(log);
t('the text names the PR', lines.some((l) => l.includes('PR #11 DS-7: feat: a skill change')), true);
t('the text gives the counts', lines.some((l) => /before: median \$3\.00 per accepted ticket over 3 of 4 merged · blind audit P0 0\.5 · P1 1 · P2 1 per PR over 2 audited/.test(l)), true);
t('a config entry reads old -> new', lines.some((l) => l.includes('config §3 git-push: `ask` -> `yes`')), true);
t('an empty log says so', logLines({ ...log, entries: [] }).at(-1), 'no worker-facing change in the window');

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
