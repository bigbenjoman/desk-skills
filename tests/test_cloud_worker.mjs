// suite: cloud worker (placement, start, PR lookup and report rows)
// layer: L2
// cloud-worker.mjs against the outputs recorded in tests/fixtures/cloud/: placement from triage
// records, the start parsed from `claude --cloud`, a real start through `script` with no terminal of
// its own (a fake claude that prints the recording, and one that refuses the way --print does), the
// PR a session opened, the batch report's cloud row, the session's name, and the finished sessions
// needs-you asks the person to archive.
import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { placement, cloudPrompt, deskReviewEnabled, CLOUD_REVIEW_PLUGIN, CLOUD_REVIEW_ROUNDS, parseCloudStart, startCloud, firstRunPrompt, findCloudPr, cloudWall, cloudName, finishedCloud, readArchived, recordArchived, cloudStall, cloudEta, parseCloudSend, sendCloud, CLOUD_RETRY_MSG, CLOUD_NO_EFFORT, attributionFound, authorMismatches, stripAttribution, rewriteCommits, ATTRIBUTION_MARKS, unfinishedMark, cloudIdle, cloudFollowUpMsg, CLOUD_IDLE_FOLLOWUPS, cloudFixMsg, cloudFixPrompt, cloudNeeds, cloudSetup, envFileNames, shotsRef, CLOUD_ENV_VAR } from '../desk/bin/cloud-worker.mjs';
import { cloudFixRoute, runsInCloud, fixInCloud, cloudArchiveWait } from '../desk/bin/pass/shared.mjs';
import { parseCloudEnv } from '../desk/bin/config-schema.mjs';
import { cloudIdleText } from '../desk/bin/desk-q.mjs';
import { execFileSync } from 'node:child_process';
import { attributionForbidden } from '../desk/bin/desk-env.mjs';
import { costTable, ticketCost, preflightLine } from '../desk/bin/worker-cost.mjs';
import { runningHere } from '../desk/bin/maintenance.mjs';
import { cloudStartCommand, cloudStartPark, loginEnv, firstRunGaps, firstRunPark, externalImports, tilde } from '../desk/bin/logins.mjs';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cloud');
const fixture = (f) => readFileSync(join(FIX, f), 'utf8');
const S = scratch('desk-cloud-');

// ---- placement (AC3) --------------------------------------------------------
const rec = (o) => ({ ticket: 'K-1', lane: 'A', renders: false, needs_db: false, needs_local: null, ...o });
const at = (o, loc = 'cloud') => { const p = placement(o, loc); return `${p.where}${p.why ? `: ${p.why}` : ''}`; };
t('AC3 at local every ticket runs locally, with no reason to give', at(rec({}), 'local'), 'local');
t('AC3 a ticket that needs nothing local runs in the cloud', at(rec({})), 'cloud');
t('AC3 one that renders runs locally: the browser lock and a dev server', at(rec({ renders: true })), 'local: it renders: its screenshots need the browser lock and a local dev server');
t('AC3 a lane D build runs locally', at(rec({ lane: 'D' })).startsWith('local: it renders'), true);
t('AC3 one that needs a database runs locally', at(rec({ needs_db: true })), 'local: it needs a local database');
t('AC3 triage\'s own reason (stub binaries) is the plan\'s reason', at(rec({ needs_local: 'its checks run the stub gh and claude binaries in tests/' })),
  'local: its checks run the stub gh and claude binaries in tests/');
t('AC3 every reason is given', at(rec({ renders: true, needs_db: true })).split('; ').length, 2);
t('AC3 a record that never answered needs_local stays local, and says so', at({ ticket: 'K-1', lane: 'A' }).includes('re-run triage.sh'), true);
const spine = placement(rec({}), 'cloud', { feature: 'it is the feature spine' });
t('AC3 a feature spine or spec owner runs locally, and says so', `${spine.where}: ${spine.why}`, 'local: it is the feature spine');
const leverOnAt = (loc) => { const p = placement(rec({}), loc, { effort: true }); return `${p.where}: ${p.why}`; };
t('DS-450 AC1 with the effort lever on, a ticket that could run in the cloud runs locally, and says why', leverOnAt('cloud'), `local: ${CLOUD_NO_EFFORT}`);
t('DS-450 AC5 at local the lever gives no reason to state', leverOnAt('local'), 'local: null');

// ---- issue-1550: config §3b "Cloud environment" -------------------------------
const envOf = (raw) => { try { return JSON.stringify(parseCloudEnv(raw)); } catch (e) { return `refused: ${/is "/.test(e.message)}`; } };
t('issue-1550 AC1 the row reads as the environment and what it provides', envOf('widgets: db browser services:redis,mailpit'),
  JSON.stringify({ name: 'widgets', db: true, browser: true, services: ['redis', 'mailpit'] }));
t('issue-1550 AC1 a name alone provides nothing', envOf('widgets'), JSON.stringify({ name: 'widgets', db: false, browser: false, services: [] }));
t('issue-1550 AC3 unset, none and TODO are no environment', [envOf(''), envOf('none'), envOf('TODO'), envOf(null)].join(), 'null,null,null,null');
t('issue-1550 a word it does not know refuses the row', envOf('widgets: db gpu'), 'refused: true');
const dbAndBrowser = rec({ renders: true, needs_db: true });
const atEnv = (o, raw) => { const p = placement(o, 'cloud', { env: parseCloudEnv(raw) }); return `${p.where}${p.why ? `: ${p.why}` : ''}`; };
t('issue-1550 AC1 a ticket that renders and needs a database runs in the cloud where the row provides both', atEnv(dbAndBrowser, 'widgets: db browser'), 'cloud');
t('issue-1550 AC3 with the row unset it stays local, as before', atEnv(dbAndBrowser, 'none'), at(dbAndBrowser));
t('issue-1550 AC1 where the environment lacks one, it stays local naming the row', atEnv(dbAndBrowser, 'widgets: db'),
  'local: it renders, and cloud environment widgets provides no browser (config §3b "Cloud environment")');
t('issue-1550 AC1 a service the row names runs in the cloud', atEnv(rec({ needs_services: ['redis'] }), 'widgets: services:redis'), 'cloud');
t('issue-1550 AC1 a service it does not name stays local', atEnv(rec({ needs_services: ['redis', 'typesense'] }), 'widgets: services:redis'),
  'local: it needs the local service typesense, which cloud environment widgets does not provide (config §3b "Cloud environment")');
t('issue-1550 AC1 needs_local still keeps it local', atEnv(rec({ renders: true, needs_local: 'stub binaries' }), 'widgets: browser'), 'local: stub binaries');
t('issue-1550 a lane D ticket needs the browser', cloudNeeds(rec({ lane: 'D' })).browser, true);

// ---- the maintenance window counts only workers on this computer --------------
t('a cloud session is not running here', runningHere({ state: 'running', location: 'cloud' }), false);
t('a local worker is', runningHere({ state: 'running', location: null }), true);
t('a review try on a cloud ticket\'s PR is', runningHere({ state: 'running', location: 'cloud', result: { pr: 9 }, fix: { kind: 'rereview' } }), true);
t('a fix try on a cloud ticket\'s PR is', runningHere({ state: 'running', location: 'cloud', result: { pr: 9 }, fix: { kind: 'review', try: 1, of: 2 } }), true);
t('and so is that worker as its spawn leaves it, its result cleared', runningHere({ state: 'running', location: 'cloud', cloud: { started: 'a', pr_at: 'b' }, result: null, fix: { kind: 'rereview', finished: 'x' } }), true);

// ---- the prompt carries the ticket (AC2) ------------------------------------
const prompt = cloudPrompt({ key: 'K-1', repo: 'acme/widgets', base: 'main', branch: 'feat/K-1-x', text: 'Fix the widget.\n\nAC1: it works', tests: ['bash tests/run.sh'] });
t('AC2 the prompt carries the ticket text', prompt.includes('AC1: it works'), true);
t('AC2 and the branch to push and the PR to open', prompt.includes('branch named exactly `feat/K-1-x`, cut from `main`') && prompt.includes('with K-1 in its title'), true);
t('AC2 and the repo\'s test command', prompt.includes('Run `bash tests/run.sh` before you push'), true);
t('before it pushes, it reads where each server-set value its change branches on is set, and names a source it cannot read as a premise',
  ['read where that value is set', 'every value it can set', 'as a premise'].every((x) => prompt.includes(x)) && prompt.indexOf('read where that value is set') < prompt.indexOf('and push it to origin'), true);

// ---- issue-1555: a session with desk-review reviews its own head and posts the verdict ----
const base1555 = { key: 'K-1', repo: 'acme/widgets', base: 'main', branch: 'feat/K-1-x', text: 'Fix the widget.\n\nAC1: it works', tests: ['bash tests/run.sh'] };
const reviewed = cloudPrompt({ ...base1555, review: { config: { 'review-bar': 'default', 'required-checks': ['Tests', 'Lint'] }, post: true } });
const unposted = cloudPrompt({ ...base1555, review: { config: { 'review-bar': 'default' }, post: false } });
t('issue-1555 fix try 1: with §3 pr-self-review-comment yes, the brief grants the post DESK_CONFIG_FILE cannot carry',
  reviewed.includes('§3 `pr-self-review-comment` to `yes`, which that file cannot carry: so desk-review\'s post step is to post on your own PR'), true);
t('issue-1555 fix try 1: without it, the brief posts nothing and puts the report in the PR body',
  [unposted.includes('post no review on the PR'), unposted.includes('Put the final report in the PR body'), unposted.includes('Post the final verdict'), unposted.includes('put that round\'s report in the PR body')].join(), 'true,true,false,true');
t('issue-1555 fix try 1: a review with no post given reads as no', cloudPrompt({ ...base1555, review: { config: {} } }).includes('post no review on the PR'), true);
const pluginRef = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'desk-review', 'references', 'plugin.md'), 'utf8');
t('issue-1555 fix try 1: desk-review\'s plugin.md takes the brief\'s word for pr-self-review-comment',
  ['carries no §3 permission', 'stands in for §3 `pr-self-review-comment`', 'reads as `no`: report only'].every((x) => pluginRef.includes(x)), true);
t('issue-1555 AC1 with desk-review available, the brief runs it at the pushed head, from the plugin',
  ['/desk:desk-review', CLOUD_REVIEW_PLUGIN, 'at your pushed head'].every((x) => reviewed.includes(x)), true);
t('issue-1555 AC1 it fixes P0 and P1 findings within the session and reviews the new head',
  reviewed.includes('Fix every P0 and P1 it confirms in this session, push, and review the new head again'), true);
t('issue-1555 AC1 it posts the final verdict on the PR in desk\'s format, with the head SHA',
  ['Post the final verdict on the PR in desk\'s format', 'full SHA of the head it reviewed'].every((x) => reviewed.includes(x)), true);
t('issue-1555 AC1 it carries the review rows as DESK_CONFIG_FILE takes them',
  reviewed.includes('set DESK_CONFIG_FILE') && reviewed.includes('`{"review-bar":"default","required-checks":["Tests","Lint"]}`'), true);
t('issue-1555 AC1 the review comes after the draft PR, before the rules and the ticket',
  reviewed.indexOf('4. Open a draft pull request') < reviewed.indexOf('7. Once your draft PR is open') && reviewed.indexOf('7. Once your draft PR is open') < reviewed.indexOf('## The ticket'), true);
t('issue-1555 AC3 it limits its rounds to desk\'s three, then stops and posts',
  CLOUD_REVIEW_ROUNDS === 3 && reviewed.includes('at most 3 review rounds') && reviewed.includes('when round 3 still finds a P0 or P1, stop fixing, post that round\'s verdict'), true);
t('issue-1555 AC2 without desk-review, the brief is as today (main\'s brief, recorded before this change)', cloudPrompt({ ...base1555, review: null }), fixture('prompt-no-review.txt'));
t('issue-1555 AC2 and as the brief with no review given', cloudPrompt(base1555).includes('desk-review'), false);
t('issue-1555 AC2 the brief with the review is today\'s with one step added',
  reviewed.split('\n').filter((l) => !l.startsWith('7. ')).join('\n'), prompt);
const settings = (o) => JSON.stringify({ enabledPlugins: o });
t('issue-1555 the repo\'s settings enabling the desk plugin make desk-review available', deskReviewEnabled(settings({ [CLOUD_REVIEW_PLUGIN]: true })), true);
t('issue-1555 disabled, missing, another value, another plugin, no file or bad JSON: not available',
  [settings({ [CLOUD_REVIEW_PLUGIN]: false }), settings({}), settings({ [CLOUD_REVIEW_PLUGIN]: 'true' }), settings({ 'other@x': true }), '{}', '', '{nope', null, '[]'].map(deskReviewEnabled).some(Boolean), false);

// ---- issue-1550: a cloud ticket that needs the database or a browser (AC2, AC6) --
const widgets = parseCloudEnv('widgets: db browser services:redis');
const setup = { services: ['redis :6379', 'typesense :8108'], migrate: ['pnpm db:migrate'], seed: ['apps/api: pnpm db:seed'], dev: ['pnpm dev'], dbVars: ['DATABASE_URL'] };
const served = cloudPrompt({ key: 'K-1', repo: 'acme/widgets', base: 'main', branch: 'feat/K-1-x', text: 'T', tests: [], env: widgets, needs: cloudNeeds(rec({ renders: true, needs_db: true, needs_services: ['redis'] })), setup });
t('issue-1550 AC2 the prompt starts the database, points its variable at it, then migrates and seeds',
  ['service postgresql start', '`DATABASE_URL`', 'then run `pnpm db:migrate` and then `pnpm db:seed` in `apps/api`'].every((x) => served.includes(x)), true);
t('issue-1550 AC2 it starts the services the ticket needs, and only those', served.includes('docker compose up -d redis') && !served.includes('typesense'), true);
t('issue-1550 AC2 it takes its screenshots with the environment\'s Chrome, from the dev server', ['`pnpm dev`', 'Chrome for Testing', 'before-<view>.png', 'after-<view>.png'].every((x) => served.includes(x)), true);
t('issue-1550 AC4 it pushes them to the side ref and leaves _drag cells naming them', served.includes(`push it to origin as \`${shotsRef('feat/K-1-x')}\``) && served.includes('`_drag before-<view>.png_`'), true);
t('issue-1550 AC6 its first step checks the environment, and stops naming the wrong one',
  served.indexOf(`printenv ${CLOUD_ENV_VAR}`) > -1 && served.indexOf(`printenv ${CLOUD_ENV_VAR}`) < served.indexOf('1. Do the smallest change') && served.includes('`wrong cloud environment: <what it printed, or none>`'), true);
const plain = cloudPrompt({ key: 'K-1', repo: 'r', base: 'main', branch: 'b', text: 'T', tests: [], env: widgets, needs: cloudNeeds(rec({})), setup });
t('issue-1550 AC2 a ticket that needs none of them gets the check but no services section', plain.includes(CLOUD_ENV_VAR) && !plain.includes('What this ticket needs in your environment'), true);
t('issue-1550 AC3 with no environment the prompt is as before', prompt.includes(CLOUD_ENV_VAR) || prompt.includes('desk-shots/'), false);

// ---- issue-1550: what /desk-setup proposes (AC5) --------------------------------
const proposed = cloudSetup({ env: widgets, install: ['pnpm install --frozen-lockfile', 'apps/api: uv sync'], dbVars: ['DATABASE_URL'], envNames: envFileNames('# c\nDATABASE_URL=postgres://secret\nexport CLERK_SECRET_KEY="sk_live_x"\nNOT A VAR\n') });
t('issue-1550 AC5 the setup script runs §4 Install, each item in its directory', proposed.script.includes('pnpm install --frozen-lockfile || true') && proposed.script.includes('(cd apps/api && uv sync) || true'), true);
t('issue-1550 AC5 the variables are the environment\'s name, then names with no value', proposed.vars.join(' '), `${CLOUD_ENV_VAR}=widgets DATABASE_URL= CLERK_SECRET_KEY=`);
t('issue-1550 AC5 no value from an env file is ever proposed', JSON.stringify(proposed).includes('secret') || JSON.stringify(proposed).includes('sk_live'), false);
t('issue-1550 AC5 without db, the database variable is not proposed', cloudSetup({ env: parseCloudEnv('w: browser'), dbVars: ['DATABASE_URL'] }).vars.join(' '), `${CLOUD_ENV_VAR}=w`);

// ---- issue-1569: the repo's commit and PR rules, and AI attribution ----------
const rules = { author: { name: 'Ada Lovelace', email: 'ada@example.com' }, prTitle: 'type(scope): <TICKET> description', prBody: 'intro · ### Changes · ### Testing', mergeMethod: 'squash', noAttribution: true };
const ruled = cloudPrompt({ key: 'K-1', repo: 'acme/widgets', base: 'main', branch: 'b', text: 'T', tests: [], rules });
t('issue-1569 AC1 the prompt has a section of the repo\'s rules', ruled.includes("## This repo's rules"), true);
t('issue-1569 AC1 it names the git author, PR title and body shapes and merge method',
  ['Author every commit as `Ada Lovelace <ada@example.com>`', 'PR title: `type(scope): <TICKET> description`', 'PR body: intro · ### Changes · ### Testing', 'merge by squash'].every((x) => ruled.includes(x)), true);
t('issue-1569 AC5 it names the author as git user.name and user.email, and says another author\'s commits are rewritten',
  ['git config user.name "Ada Lovelace"', 'git config user.email "ada@example.com"', 'authored as anyone else has its commits rewritten before it merges'].every((x) => ruled.includes(x)), true);
t('issue-1569 the no-attribution rule names every mark the check looks for', ATTRIBUTION_MARKS.every(([, what]) => ruled.includes(what)), true);
// The hook is installed on its own (install.sh), so it keeps its own BANNED: run both on one table of
// samples, each a mark or a near miss, and they must flag the same marks, in the same order, on each.
const samples = [
  'Co-Authored-By: Claude <x@y.z>', 'co-authored-by = Anthropic bot', 'Co-Authored-By: Jane <jane@example.com>',
  'Claude-Session: abc', 'claude-session=1', 'Claude session notes',
  '🤖 Generated with [Claude Code](https://claude.ai/code)', 'generated with claude code', 'Generated with Claude',
  'NOREPLY@anthropic.com', 'noreply@anthropic.org', 'https://claude.ai/code/session_01X', 'https://claude.ai/code', '🤖', 'a plain commit message',
];
const hookPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'deny-ai-attribution.py');
const hookHits = JSON.parse(execFileSync('python3', ['-c',
  'import importlib.util, json, sys\ns = importlib.util.spec_from_file_location("h", sys.argv[1]); h = importlib.util.module_from_spec(s); s.loader.exec_module(h)\n' +
  'print(json.dumps([[i for i, b in enumerate(h.BANNED) if b.search(x)] for x in json.load(sys.stdin)]))', hookPath],
  { input: JSON.stringify(samples), encoding: 'utf8' }));
const jsHits = samples.map((x) => ATTRIBUTION_MARKS.flatMap(([re], i) => (re.test(x) ? [i] : [])));
t('issue-1569 the check\'s marks flag what the attribution hook\'s BANNED flags, mark for mark, on every sample', JSON.stringify(hookHits), JSON.stringify(jsHits));
t('issue-1569 and every mark is flagged by some sample, and some sample by none', ATTRIBUTION_MARKS.every((_, i) => jsHits.some((h) => h.includes(i))) && jsHits.some((h) => !h.length), true);
t('issue-1569 AC1 where §5 forbids attribution, it rules out the trailer, session link and footer in commits, PR body and comments',
  ['No AI attribution', 'Co-Authored-By', 'Claude-Session', 'claude.ai/code/session_', 'Generated with Claude Code', 'noreply@anthropic.com', 'commit messages', 'PR title and body', 'PR comments'].every((x) => ruled.includes(x)), true);
t('issue-1569 AC1 the rules come before the ticket text', ruled.indexOf("## This repo's rules") < ruled.indexOf('## The ticket'), true);
const allowed = cloudPrompt({ key: 'K-1', repo: 'r', base: 'main', branch: 'b', text: 'T', tests: [], rules: { ...rules, noAttribution: false } });
t('issue-1569 AC1 where attribution is allowed, nothing rules it out', allowed.includes('No AI attribution') || allowed.includes('Co-Authored-By'), false);
t('issue-1569 AC1 and the other rules stay', allowed.includes('Author every commit as'), true);
t('issue-1569 AC1 with no rules set, there is no rules section', prompt.includes("This repo's rules"), false);
t('issue-1569 §5 read as the hook reads it: forbidden', [attributionForbidden('forbidden'), attributionForbidden('`forbidden` (hook)'), attributionForbidden('allowed'), attributionForbidden(null)].join(), 'true,true,false,false');

const clean = { body: 'What changed.', commits: [{ oid: 'abcdef1234', messageHeadline: 'fix: K-1 x', messageBody: '', authors: [{ name: 'Ada', email: 'ada@example.com' }] }], comments: [{ author: { login: 'ada' }, body: 'LGTM' }] };
t('issue-1569 AC2 a PR with no attribution has none found', attributionFound(clean).length, 0);
const marked = {
  body: 'Done.\n\n🤖 Generated with [Claude Code](https://claude.ai/code)',
  commits: [
    { oid: 'abcdef1234', messageHeadline: 'fix: K-1 x', messageBody: 'Co-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01X', authors: [{ name: 'Ada', email: 'ada@example.com' }] },
    { oid: '9876543210', messageHeadline: 'chore', messageBody: '', authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }] },
  ],
  comments: [{ author: { login: 'ada' }, body: 'see https://claude.ai/code/session_02Y' }],
};
const found = attributionFound(marked);
t('issue-1569 AC2 a co-author trailer in a commit is found, naming the commit', found.includes("a Co-Authored-By trailer naming Claude or Anthropic in commit abcdef1's message"), true);
t('issue-1569 AC2 so is a session trailer and its link', found.includes("a Claude-Session trailer in commit abcdef1's message") && found.includes("a claude.ai/code/session_ link in commit abcdef1's message"), true);
t('issue-1569 AC2 an Anthropic author email is found', found.includes("noreply@anthropic.com in commit 9876543's authors"), true);
t('issue-1569 AC2 the footer and robot emoji in the PR body are found', found.includes('a "Generated with Claude Code" footer in the PR body') && found.includes('the robot emoji in the PR body'), true);
t('issue-1569 AC2 a session link in a comment is found, naming it', found.includes('a claude.ai/code/session_ link in comment 1 by ada'), true);
t('issue-1569 AC2 an empty view finds nothing', attributionFound({}).length, 0);

const ada = { name: 'Ada Lovelace', email: 'ada@example.com' };
t('issue-1569 AC5 commits authored as the expected email pass, case aside', authorMismatches({ commits: [{ oid: 'a1', authors: [{ name: 'Ada', email: 'ADA@example.com' }] }] }, ada).length, 0);
t('issue-1569 AC5 a co-authored commit with the expected author among its authors passes', authorMismatches({ commits: [{ oid: 'a1', authors: [{ name: 'Bot', email: 'bot@x' }, { name: 'Ada', email: 'ada@example.com' }] }] }, ada).length, 0);
t('issue-1569 AC5 a commit authored as anyone else is named, with who it was authored as',
  authorMismatches(marked, ada).join('|'), 'commit 9876543 authored as Claude <noreply@anthropic.com>, not Ada Lovelace <ada@example.com>');
t('issue-1569 AC5 with no author known, nothing is checked', authorMismatches(marked, null).length, 0);

// ---- removing attribution (issue-1569 AC2) -----------------------------------
t('issue-1569 AC2 stripAttribution drops each marked line and the blank lines that leaves at the end',
  JSON.stringify(stripAttribution('Done.\n\nKeep this.\n\n🤖 Generated with [Claude Code](https://claude.ai/code)\n')), JSON.stringify('Done.\n\nKeep this.'));
t('issue-1569 AC2 stripAttribution leaves a clean text as it was', stripAttribution('a\n\nb'), 'a\n\nb');
t('issue-1569 AC2 stripAttribution of nothing but attribution is empty', stripAttribution('Co-Authored-By: Claude <noreply@anthropic.com>'), '');
{
  // A real repo: a base commit, then two cloud commits authored as Claude with its trailers.
  const repo = join(S, 'rewrite');
  mkdirSync(repo, { recursive: true });
  const env = (who) => ({ ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email });
  const claude = { name: 'Claude', email: 'noreply@anthropic.com' };
  const run = (args, o = {}) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: env(ada), ...o });
  run(['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'a.txt'), 'a\n'); run(['add', '.']); run(['commit', '-q', '-m', 'base']);
  run(['checkout', '-q', '-b', 'cloud']);
  writeFileSync(join(repo, 'b.txt'), 'b\n'); run(['add', '.']);
  run(['commit', '-q', '-m', 'feat: one\n\nWhy it is.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01X'], { env: env(claude) });
  writeFileSync(join(repo, 'c.txt'), 'c\n'); run(['add', '.']);
  run(['commit', '-q', '-m', 'feat: two'], { env: env(claude) });
  const git = (args, { env: e, input } = {}) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...(e ?? process.env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, input: input ?? '' });
  const old = run(['rev-parse', 'cloud']).trim();
  const r = rewriteCommits(git, { head: old, base: 'main', author: ada });
  t('issue-1569 AC2 rewriteCommits rewrites each commit the base lacks', r.n, 2);
  t('issue-1569 AC2 the rewritten head has the old head\'s tree', r.head && run(['rev-parse', `${r.head}^{tree}`]).trim(), run(['rev-parse', `${old}^{tree}`]).trim());
  t('issue-1569 AC2 the rewritten commits sit on the same base', r.head && run(['rev-parse', `${r.head}~2`]).trim(), run(['rev-parse', 'main']).trim());
  const log = r.head ? run(['log', '--format=%an <%ae>|%cn <%ce>|%B', 'main..' + r.head]) : '';
  t('issue-1569 AC2 every rewritten commit is authored and committed as the repo identity', log.split('\n').filter((l) => l.includes('|')).every((l) => l.startsWith('Ada Lovelace <ada@example.com>|Ada Lovelace <ada@example.com>|')), true);
  t('issue-1569 AC2 the trailers are gone, and the rest of the message stays', /Co-Authored-By|Claude-Session/.test(log) || !log.includes('Why it is.') || !log.includes('feat: two'), false);
  t('issue-1569 AC2 the author dates are kept', r.head && run(['log', '-1', '--format=%aI', r.head]).trim(), run(['log', '-1', '--format=%aI', old]).trim());
  t('issue-1569 AC2 the original branch is left alone', run(['rev-parse', 'cloud']).trim(), old);
  // A git whose diff finds the trees differ: the rewrite is refused, never pushed.
  const differs = (args, o) => { if (args[0] === 'diff') throw new Error('trees differ'); return git(args, o); };
  t('issue-1569 AC2 a rewrite whose tree differs is refused', rewriteCommits(differs, { head: old, base: 'main', author: ada }).error, `the rewrite of ${old.slice(0, 7)} would change its tree`);
  const kept = rewriteCommits(git, { head: old, base: 'main', author: ada, strip: false });
  const keptLog = kept.head ? run(['log', '--format=%an <%ae>|%B', 'main..' + kept.head]) : '';
  t('issue-1569 AC5 where §5 allows attribution, a rewrite for the author alone keeps the trailers', keptLog.includes('Co-Authored-By: Claude') && keptLog.includes('Claude-Session:') && keptLog.includes('Ada Lovelace <ada@example.com>|'), true);
  t('issue-1569 AC2 a head with nothing the base lacks is refused', /has no commits that main lacks/.test(rewriteCommits(git, { head: run(['rev-parse', 'main']).trim(), base: 'main', author: ada }).error ?? ''), true);
}

// ---- the start (AC2, AC4) ---------------------------------------------------
const started = parseCloudStart(fixture('created.txt'));
t('AC2 the recorded start gives the session id', started.session, 'session_01Vy49H7Z4T3CSgAhSxsuhqj');
t('AC2 and its URL', started.url, 'https://claude.ai/code/session_01Vy49H7Z4T3CSgAhSxsuhqj?from=cli&m=0');
t('AC2 terminal noise around it is ignored', parseCloudStart(`\x1b[?25l${fixture('created.txt').replace(/\n/g, '\r\n')}\x1b[0m`).session, 'session_01Vy49H7Z4T3CSgAhSxsuhqj');
t('AC2 so is the ^D and backspaces BSD script echoes when its input ends', parseCloudStart(`^D\b\b${fixture('created.txt')}`).session, 'session_01Vy49H7Z4T3CSgAhSxsuhqj');
// A real start made as startCloud makes it on macOS, with no terminal of its own (2.1.314): its noise
// includes ESC 7/ESC 8, ESC ( B and SI, and its title is the CLI's summary, not the description.
const noTty = parseCloudStart(fixture('created-no-tty.txt'));
t('AC4 the recorded no-TTY start gives the session id', noTty.session ?? JSON.stringify(noTty), 'session_01Vy49H8UHjQ9wbruRKguWDD');
t('AC4 and its URL', noTty.url, 'https://claude.ai/code/session_01Vy49H8UHjQ9wbruRKguWDD?from=cli&m=0');
t('AC4 and the title the CLI chose, free of terminal noise', noTty.title, 'No-TTY recording');
t('AC4 print mode\'s refusal is an error, word for word', parseCloudStart(fixture('print-refused.txt')).error, 'Error: --cloud cannot be combined with --print.');
t('AC4 stream-json\'s refusal is an error, word for word', parseCloudStart(fixture('stream-json-refused.txt')).error, 'Error: --cloud <session_id> does not support --output-format stream-json');
t('AC4 a message queued to a session is not a start', !!parseCloudStart(fixture('send-json.json')).error, true);
t('AC4 no output at all is an error', parseCloudStart('').error, 'it printed nothing');

// A real start through `script`, this process having no terminal: a fake claude prints the recording.
const fake = (name, body) => { const p = join(S, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p; };
const ok = fake('claude-ok', `[ "$1" = --cloud ] || exit 9\nprintf '%s\\n' "$2" > "${join(S, 'prompt.txt')}"\ncat "${join(FIX, 'created.txt')}"`);
const real = startCloud(prompt, { claude: ok, timeout: 30_000 });
t('AC2 spawned without a terminal, the session is read through script', real.session ?? JSON.stringify(real), 'session_01Vy49H7Z4T3CSgAhSxsuhqj');
let sent = '';
try { sent = readFileSync(join(S, 'prompt.txt'), 'utf8'); } catch { /* not run */ }
t('AC2 and the whole prompt reached claude --cloud as one argument', sent.includes('AC1: it works') && sent.includes('Work ticket K-1'), true);
const okNoTty = fake('claude-ok-no-tty', `[ "$1" = --cloud ] || exit 9\ncat "${join(FIX, 'created-no-tty.txt')}"`);
const realNoTty = startCloud(prompt, { claude: okNoTty, timeout: 30_000 });
t('AC4 the no-TTY recording read back through script gives its session', realNoTty.session ?? JSON.stringify(realNoTty), 'session_01Vy49H8UHjQ9wbruRKguWDD');
const named = fake('claude-named', `[ "$1" = --cloud ] || exit 9\nprintf '%s|%s' "$3" "$4" > "${join(S, 'name.txt')}"\ncat "${join(FIX, 'created.txt')}"`);
startCloud(prompt, { claude: named, name: 'widgets-ticket-K-1', timeout: 30_000 });
let gave = '';
try { gave = readFileSync(join(S, 'name.txt'), 'utf8'); } catch { /* not run */ }
t('a session started with a name gets --name <name> after its prompt', gave, '--name|widgets-ticket-K-1');
t('the name is <repo>-ticket-<KEY>, from the repo part of owner/name', cloudName('acme/widgets', 'K-1'), 'widgets-ticket-K-1');
const refuses = fake('claude-no', `cat "${join(FIX, 'print-refused.txt')}" >&2\nexit 1`);
t('AC4 a start the CLI refuses returns its error', startCloud(prompt, { claude: refuses, timeout: 30_000 }).error?.startsWith('Error: --cloud cannot be combined with --print.'), true);
t('AC4 a claude that is not there is an error, not a session', !!startCloud(prompt, { claude: join(S, 'missing'), timeout: 30_000 }).error, true);
// #1581: the session starts under the login whose env it is given, the repo's subscription's folder.
const whose = fake('claude-whose', `printf '%s' "\${CLAUDE_CONFIG_DIR-unset}" > "${join(S, 'login.txt')}"\ncat "${join(FIX, 'created.txt')}"`);
const loginOf = (env) => { rmSync(join(S, 'login.txt'), { force: true }); startCloud(prompt, { claude: whose, timeout: 30_000, env }); try { return readFileSync(join(S, 'login.txt'), 'utf8'); } catch { return 'not run'; } };
const studia = { tool: 'claude', name: 'studia', folder: '~/.claude-logins/studia', configDir: '/home/u/.claude-logins/studia' };
t('#1581 AC1 a login\'s env starts claude --cloud with its folder as CLAUDE_CONFIG_DIR', loginOf(loginEnv(studia, { ...process.env, CLAUDE_CONFIG_DIR: '/home/u/.claude' })), studia.configDir);
t('#1581 AC1 the default login\'s env starts it with none', loginOf(loginEnv({ tool: 'claude', name: 'default', folder: '~/.claude', configDir: null }, { ...process.env, CLAUDE_CONFIG_DIR: studia.configDir })), 'unset');
const hangs = fake('claude-hangs', 'sleep 5');
const hung = startCloud(prompt, { claude: hangs, timeout: 1_000 });
t('#1581 AC3 a start with no answer in its timeout says so, marked timed out', `${hung.error} ${hung.timedOut}`, 'no answer in 1s true');
t('#1581 AC3 a refused start is not marked timed out', startCloud(prompt, { claude: refuses, timeout: 30_000 }).timedOut, undefined);
t('#1581 AC3 the one-time command for a login is its cloud start, run in its folder', cloudStartCommand(studia), 'CLAUDE_CONFIG_DIR=~/.claude-logins/studia claude --cloud "<any prompt>"');
t('#1581 AC3 and for the default login, with no prefix', cloudStartCommand({ tool: 'claude', name: 'default', folder: '~/.claude', configDir: null }), 'claude --cloud "<any prompt>"');

// ---- issue-1642: first-run prompts ------------------------------------------
// A start that times out on a first-run prompt names it, and the fix is run from the checkout.
t('issue-1642 AC1 captured output ending at the trust dialog is the trust dialog', firstRunPrompt(fixture('trust-dialog.txt')), 'trust');
t('issue-1642 AC1 the external imports prompt after it is that prompt', firstRunPrompt(`${fixture('trust-dialog.txt')}\n${fixture('external-imports.txt')}`), 'imports');
t('issue-1642 AC1 the environment-variables prompt is named', firstRunPrompt('Allow this session to use the environment variables set for this environment? (y/n)'), 'env');
t('issue-1642 AC1 a recorded start shows no prompt', firstRunPrompt(fixture('created.txt')), null);
const atTrust = fake('claude-trust', `cat "${join(FIX, 'trust-dialog.txt')}"\nsleep 5`);
const waited = startCloud(prompt, { claude: atTrust, timeout: 1_500 });
t('issue-1642 AC1 a start that times out at the trust dialog says it waits on it', `${waited.timedOut} ${waited.waits}`, 'true trust');
t('issue-1642 AC1 one that times out with nothing to show names no prompt', hung.waits, undefined);
const ck = join(S, 'code', 'desk-skills');
mkdirSync(ck, { recursive: true });
const lg = { tool: 'claude', name: 'studia', folder: join(S, 'login'), configDir: join(S, 'login') };
mkdirSync(lg.configDir, { recursive: true });
const parkLine = firstRunPark(['trust'], { who: 'login studia', login: lg, checkout: ck, gave: 'no answer in 120s' });
t('issue-1642 AC1 its park names the trust dialog', parkLine.includes('it is waiting on the folder-trust dialog ("Is this a project you created or one you trust?")'), true);
t('issue-1642 AC1 and the exact fix, from the checkout under the login', parkLine.endsWith(`from the checkout: cd ${tilde(ck)} && CLAUDE_CONFIG_DIR=${lg.folder} claude, then choose "Yes, I trust this folder", and exit`), true);
// The pass's step between them (spawnCloud): the captured trust-dialog start becomes the park.
const startPark = cloudStartPark(waited, { who: 'login studia', login: lg, checkout: ck });
t('issue-1642 AC4 a captured trust-dialog start parks naming trust', startPark.includes('gave no answer in 1.5s: it is waiting on the folder-trust dialog'), true);
t('issue-1642 AC4 and the checkout the fix runs from', startPark.includes(`from the checkout: cd ${tilde(ck)} && `), true);
t('issue-1642 AC4 a timeout showing no prompt parks on the one-time cloud start', cloudStartPark(hung, { who: 'w', login: lg, checkout: ck }).endsWith(`answer it: ${cloudStartCommand(lg)}`), true);
t('issue-1642 AC4 a refused start parks on what it said', cloudStartPark({ error: 'refused: x' }, { who: 'w', login: lg, checkout: ck }), 'refused: x');
t('issue-1642 AC1 the environment-variables prompt is answered from a cloud start', firstRunPark(['env'], { who: 'w', login: lg, checkout: ck }).endsWith(`cd ${tilde(ck)} && CLAUDE_CONFIG_DIR=${lg.folder} claude --cloud "<any prompt>", then answer it, and exit`), true);
{
  const was = process.env.HOME;
  process.env.HOME = S;
  const spaced = firstRunPark(['trust'], { who: 'w', login: lg, checkout: join(S, 'my code', 'x') });
  const plain = firstRunPark(['trust'], { who: 'w', login: lg, checkout: ck });
  process.env.HOME = was;
  t('issue-1642 a checkout under home with a space is cd-ed to by its quoted absolute path, never a quoted ~', spaced.includes(`cd '${join(S, 'my code', 'x')}' && `), true);
  t('issue-1642 one with no space keeps its ~ form', plain.includes('cd ~/code/desk-skills && '), true);
}
const cj = join(lg.configDir, '.claude.json');
const gapsWith = (projects) => { if (projects === undefined) rmSync(cj, { force: true }); else writeFileSync(cj, JSON.stringify({ projects })); return firstRunGaps(lg, ck).gaps.join(',') || 'none'; };
t('issue-1642 AC2 a login with no .claude.json would wait on trust', gapsWith(undefined), 'trust');
t('issue-1642 AC2 one that trusts another folder only would wait on trust', gapsWith({ '/home/avr/code/studia-web': { hasTrustDialogAccepted: true } }), 'trust');
t('issue-1642 AC2 a trust recorded false is not trust', gapsWith({ [ck]: { hasTrustDialogAccepted: false } }), 'trust');
t('issue-1642 AC2 a trusted checkout proceeds', gapsWith({ [ck]: { hasTrustDialogAccepted: true } }), 'none');
t('issue-1642 AC2 so does one under a trusted folder', gapsWith({ [join(S, 'code')]: { hasTrustDialogAccepted: true } }), 'none');
writeFileSync(cj, '{not json');
t('issue-1642 AC2 a .claude.json that does not parse holds nothing up, and says so', `${firstRunGaps(lg, ck).gaps.length} ${!!firstRunGaps(lg, ck).unread}`, '0 true');
// The external imports prompt is pre-checked only when the CLAUDE.md chain imports a file outside the checkout.
writeFileSync(join(S, 'code', 'notes.md'), 'notes');
writeFileSync(join(ck, 'inside.md'), 'inside');
writeFileSync(join(ck, 'CLAUDE.md'), '# rules\nSee @inside.md and `@../notes.md` in code, and mail a@b.c.\n```\n@../notes.md\n```\n');
t('issue-1642 imports inside the checkout, or in code, are not external', externalImports(lg, ck).length, 0);
t('issue-1642 so a trusted checkout with them proceeds', gapsWith({ [ck]: { hasTrustDialogAccepted: true } }), 'none');
writeFileSync(join(ck, 'inside.md'), 'more in @../notes.md');
t('issue-1642 an import the chain follows outside the checkout is external', externalImports(lg, ck).join(','), join(S, 'code', 'notes.md'));
t('issue-1642 and the start would wait on the imports prompt', gapsWith({ [ck]: { hasTrustDialogAccepted: true } }), 'imports');
t('issue-1642 untrusted, it would wait on both, trust first', gapsWith({}), 'trust,imports');
t('issue-1642 approved, it proceeds', gapsWith({ [ck]: { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: true } }), 'none');
writeFileSync(join(ck, 'inside.md'), 'inside');
writeFileSync(join(lg.configDir, 'CLAUDE.md'), '@~/never-there.md\n@' + join(S, 'code', 'notes.md') + '\n');
t('issue-1642 the login\'s own CLAUDE.md importing a file outside the checkout counts', gapsWith({ [ck]: { hasTrustDialogAccepted: true } }), 'imports');
const before = readFileSync(cj, 'utf8');
firstRunGaps(lg, ck);
t('issue-1642 AC2 the check writes nothing', readFileSync(cj, 'utf8'), before);
t('issue-1642 both prompts are named in one park, answered in one start', firstRunPark(['trust', 'imports'], { who: 'w', login: lg, checkout: ck }).includes('would wait on the folder-trust dialog ("Is this a project you created or one you trust?"), then the external imports prompt ("Allow external CLAUDE.md file imports?")'), true);

// ---- the PR it opened (AC2) -------------------------------------------------
const since = '2026-10-28T10:00:00Z';
const prs = [
  { number: 7, title: 'feat(x): K-1 earlier attempt', headRefName: 'feat/K-1-x', createdAt: '2026-10-27T09:00:00Z' },
  { number: 9, title: 'feat(x): K-1 do it', headRefName: 'claude/k-1-abc', createdAt: '2026-10-28T10:40:00Z' },
  { number: 8, title: 'feat(x): K-10 other', headRefName: 'claude/k-10', createdAt: '2026-10-28T10:20:00Z' },
];
t('AC2 a PR opened from the branch it was told to use is its result', findCloudPr([...prs, { number: 11, title: 'no key', headRefName: 'feat/K-1-x', createdAt: '2026-10-28T11:00:00Z' }], { key: 'K-1', branch: 'feat/K-1-x', since })?.number, 11);
t('AC2 else one with the key in its title, opened since it started', findCloudPr(prs, { key: 'K-1', branch: 'feat/K-1-x', since })?.number, 9);
t('AC2 a longer key is not the key', findCloudPr(prs.slice(2), { key: 'K-1', branch: 'feat/K-1-x', since }), null);
t('AC2 no PR yet is null', findCloudPr([], { key: 'K-1', branch: 'b', since }), null);
t('AC2 wall time runs from session start to PR', cloudWall({ started: since, pr_at: '2026-10-28T10:40:00Z' }), 2400000);
t('AC2 with no PR there is no wall time', cloudWall({ started: since }), null);

// ---- the batch report (AC2) -------------------------------------------------
const cloudTicket = { key: 'K-1', location: 'cloud', cloud: { session: started.session, url: started.url, started: since, pr_at: '2026-10-28T10:40:00Z' } };
const row = ticketCost(S, cloudTicket);
t('AC2 a cloud ticket has a report row with no log', row?.cloud?.url, started.url);
const table = costTable([row, ticketCost(S, { key: 'K-2', location: 'cloud', cloud: { started: since, url: 'u2' } })]).split('\n');
const k1 = table.find((l) => l.startsWith('  K-1 ')) ?? '';
t('AC2 its tokens read "unknown (cloud)", never $0', (k1.match(/unknown \(cloud\)/g) ?? []).length >= 3 && !/\$0\.00/.test(k1), true);
t('issue-1553 AC1 its cost reads "cost unknown (cloud)", its session URL under it', k1.includes('cost unknown (cloud)'), true);
t('AC2 its wall time is session start to PR', k1.includes('40m 00s'), true);
t('AC2 its session URL is under its row', table.some((l) => l.trim() === `cloud session: ${started.url}`), true);
t('DS-450 AC3 its session line shows start, model and effort, with no cost invented', table.some((l) => l.trim() === 'session: start 0, model default, effort default: cost unknown (cloud)'), true);
t('AC2 one with no PR yet has no wall time', (table.find((l) => l.startsWith('  K-2 ')) ?? '').includes('no PR yet'), true);
t('AC2 the total leaves cloud workers out and says so', table.at(-2).includes('2 cloud worker(s) not counted') || table.at(-1).includes('2 cloud worker(s) not counted'), true);

// A review try on a cloud ticket's PR runs here and logs here: its run is added under the cloud row.
mkdirSync(join(S, 'logs'), { recursive: true });
writeFileSync(join(S, 'logs', 'K-3.log'), `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 60000, num_turns: 1, total_cost_usd: 2.5,
  usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }, modelUsage: { m: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 2.5 } } })}\n`);
const both = ticketCost(S, { key: 'K-3', location: 'cloud', cloud: { started: since, url: 'u3', pr_at: '2026-10-28T10:40:00Z' } });
t('a cloud ticket with a local review run counts both runs, its usage the local one\'s', `${both?.runs} ${both?.usage?.cost} ${both?.cloud?.url}`, '2 2.5 u3');
const bothTable = costTable([both]).split('\n');
t('its row shows the local cost and its cloud session stays under it, with no cost', (bothTable.find((l) => l.startsWith('  K-3 ')) ?? '').includes('$2.50')
  && bothTable.some((l) => l.trim() === 'cloud session: u3') && bothTable.some((l) => l.trim() === 'session: start 0, model default, effort default: cost unknown (cloud)'), true);
t('the total counts its local run and says the cloud session is left out', bothTable.at(-1).includes('1 cloud worker(s) counted for their local review runs only'), true);
writeFileSync(join(S, 'logs', 'K-4.log'), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'killed' }] } })}\n`);
const cut = costTable([ticketCost(S, { key: 'K-4', location: 'cloud', cloud: { started: since, url: 'u4' } })]).split('\n');
const k4 = cut.find((l) => l.startsWith('  K-4 ')) ?? '';
t('a cloud row whose local review run has no result event reads unknown, counted as unknown', `${k4.includes('unknown')} ${k4.includes('(cloud)')} ${cut.at(-1).includes('1 unknown worker(s) not counted')}`, 'true false true');
writeFileSync(join(S, 'logs', 'K-5.log'), preflightLine({ usd: 0.4, turns: 2 }));
const pre = costTable([ticketCost(S, { key: 'K-5', location: 'cloud', cloud: { started: since, url: 'u5' } })]).split('\n');
t('a cloud row with only a local preflight shows that cost, and the notes count it once', `${(pre.find((l) => l.startsWith('  K-5 ')) ?? '').includes('$0.40')} ${/-\d/.test(pre.at(-1))} ${pre.at(-1).includes('1 cloud worker(s) counted for their local review runs only')}`, 'true false true');

rmSync(S, { recursive: true, force: true });

// ---- a stalled cloud session (issue-1553 AC2) --------------------------------
const H = 3_600_000, st0 = Date.parse('2026-11-01T00:00:00Z'), iso = (ms) => new Date(ms).toISOString();
// The estimate was made a day before the session started: its 4h span counts from the session's start.
const estimate = { starts: iso(st0 - 24 * H), ships: iso(st0 - 20 * H) };
const eta = cloudEta({ estimate, typicalH: 9 });
t('issue-1553 AC2 the ETA is the saved estimate\'s span, ahead of the typical slot time', JSON.stringify(eta), JSON.stringify({ ms: 4 * H, from: 'estimate' }));
t('issue-1553 AC2 with no estimate it is the typical slot time for its size', JSON.stringify(cloudEta({ estimate: null, typicalH: 9 })), JSON.stringify({ ms: 9 * H, from: 'typical' }));
t('issue-1553 AC2 an estimate with no span falls back to it too', cloudEta({ estimate: { starts: iso(st0), ships: iso(st0) }, typicalH: 9 })?.from, 'typical');
t('issue-1553 AC2 with neither there is no ETA', cloudEta({ estimate: null, typicalH: null }), null);
t('issue-1553 AC2 a session that started after its estimate\'s ship time is not due at once', cloudStall({ started: iso(st0), eta, now: st0 + H }), null);
t('issue-1553 AC2 before its start plus ETA it is sent nothing', cloudStall({ started: iso(st0), eta, now: st0 + 4 * H }), null);
// issue-1553 comment 1: an errored session looks the same as a quiet one, so past its ETA with no push it
// is sent one retry follow-up first, and flagged only once that retry brought no push either.
const r1 = cloudStall({ started: iso(st0), eta, now: st0 + 4 * H + 1 });
t('issue-1553 errored or quiet: no push past its start plus ETA: one retry follow-up first, not flagged', `${r1?.retry} ${r1?.margin === 2 * H} ${r1?.last === st0}`, 'true true true');
t('issue-1553 with no retry sent it is never flagged, however late', cloudStall({ started: iso(st0), eta, now: st0 + 100 * H })?.retry, true);
t('issue-1553 a retry sent before its last push is not one for this quiet stretch', cloudStall({ started: iso(st0), eta, lastPush: iso(st0 + 2 * H), retried: iso(st0 + H), now: st0 + 7 * H })?.retry, true);
const retriedAt = iso(st0 + 4.5 * H);
t('issue-1553 AC2 after the retry, before its start plus ETA plus half that it is not stuck', cloudStall({ started: iso(st0), eta, retried: retriedAt, now: st0 + 6 * H }), null);
t('issue-1553 AC2 after the retry, within the margin of it it is not stuck', cloudStall({ started: iso(st0), eta, retried: retriedAt, now: st0 + 6.5 * H }), null);
const s1 = cloudStall({ started: iso(st0), eta, retried: retriedAt, now: st0 + 6.5 * H + 1 });
t('issue-1553 AC2 no push past ETA plus half that, nor in the margin since the retry: possibly stuck', `${s1?.retry} ${s1?.due === st0 + 6 * H} ${s1?.margin === 2 * H} ${s1?.last === st0 + 4.5 * H}`, 'false true true true');
t('issue-1553 a push after the retry starts it over', cloudStall({ started: iso(st0), eta, retried: retriedAt, lastPush: iso(st0 + 5 * H), now: st0 + 6.5 * H + 1 }), null);
t('issue-1553 AC2 a push inside the margin keeps it from stuck', cloudStall({ started: iso(st0), eta, lastPush: iso(st0 + 5 * H), now: st0 + 7 * H }), null);
t('issue-1553 AC2 a push older than the margin does not', cloudStall({ started: iso(st0), eta, lastPush: iso(st0 + 3 * H), now: st0 + 7 * H })?.last, st0 + 3 * H);
t('issue-1553 AC2 a commit from before the session started is not its push', cloudStall({ started: iso(st0), eta, lastPush: iso(st0 - H), now: st0 + 7 * H })?.last, st0);
t('issue-1553 AC2 the margin is half the typical slot time when that is the ETA', cloudStall({ started: iso(st0), eta: cloudEta({ typicalH: 10 }), now: st0 + 16 * H })?.margin, 5 * H);
t('issue-1553 AC2 with no ETA a session is never called stuck', cloudStall({ started: iso(st0), eta: null, now: st0 + 1000 * H }), null);
t('issue-1553 AC2 a session with no start recorded is never called stuck', cloudStall({ started: null, eta, now: st0 }), null);
// The follow-up as `claude -p <msg> --cloud <session> --output-format json` answers it (tests/fixtures/cloud/).
t('issue-1553 a follow-up the CLI queued to the session is sent', JSON.stringify(parseCloudSend(fixture('send-json.json'), 'session_01Vy49H7Z4T3CSgAhSxsuhqj')), '{"ok":true}');
t('issue-1553 one queued to another session is not', !!parseCloudSend(fixture('send-json.json'), 'session_other').error, true);
t('issue-1553 a refusal is an error, word for word', parseCloudSend(fixture('stream-json-refused.txt'), 'session_01Vy49H7Z4T3CSgAhSxsuhqj').error, 'Error: --cloud <session_id> does not support --output-format stream-json');
t('issue-1553 no follow-up is sent with no session id recorded', sendCloud(null, 'x').error, 'its session id was not recorded');
{
  const d = scratch('cloud-send');
  const fake = join(d, 'claude');
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${d}/args"\ncat "${join(FIX, 'send-json.json')}"\n`);
  chmodSync(fake, 0o755);
  const got = sendCloud('session_01Vy49H7Z4T3CSgAhSxsuhqj', CLOUD_RETRY_MSG, { claude: fake });
  t('issue-1553 the retry follow-up goes as claude -p <msg> --cloud <session> --output-format json', `${JSON.stringify(got)} ${readFileSync(join(d, 'args'), 'utf8').split('\n').slice(2).join(' ').trim()}`, '{"ok":true} --cloud session_01Vy49H7Z4T3CSgAhSxsuhqj --output-format json');
  rmSync(d, { recursive: true, force: true });
}

// ---- an unfinished cloud PR (issue-1570) -------------------------------------
t('issue-1570 AC1 a finished PR has no unfinished mark', unfinishedMark({ title: 'feat(w): K-1 save', body: 'Saves the widget.\n\n### Testing\nbash tests/run.sh' }), null);
t('issue-1570 AC1 WIP in its title marks it unfinished', unfinishedMark({ title: 'WIP: feat(w): K-1 save', body: '' }), 'WIP');
t('issue-1570 AC1 so does [WIP] in its body', unfinishedMark({ title: 'feat: K-1', body: '[WIP] placeholder selectors' }), 'WIP');
t('issue-1570 AC1 and a "what is left" section', unfinishedMark({ title: 'feat: K-1', body: '## What\'s left\n- real selectors' }), 'what is left');
t('issue-1570 AC1 and the prompt\'s step 5 wording', unfinishedMark({ title: 'feat: K-1', body: 'I could not finish the a11y run.' }), 'could not finish');
t('issue-1570 a word holding the letters WIP is not the mark', unfinishedMark({ title: 'feat: K-1 swipe and wipe', body: 'SWIPED' }), null);
t('issue-1570 the prompt asks a session that cannot finish for WIP and what is left, and to take both out when it does', ['with WIP in its title and what is left in its body', 'take both out'].every((x) => prompt.includes(x)), true);
{
  const M = 60_000, p0 = Date.parse('2026-11-26T22:00:00Z'), pushed = iso(p0);
  const ok = (name) => ({ name, status: 'completed', conclusion: 'success' });
  const idle = (o) => cloudIdle({ pr: 31, head: 'aaa', pushedAt: pushed, ...o });
  t('issue-1570 AC2 while CI runs on its head the session is sent nothing', idle({ checks: [ok('Lint'), { name: 'Tests', status: 'in_progress', conclusion: null }], now: p0 + 10 * M }).act, 'wait');
  const first = idle({ checks: [ok('Lint'), { name: 'Tests', status: 'completed', conclusion: 'failure' }], now: p0 + 20 * M });
  t('issue-1570 AC2 once CI on its head finishes it is sent a follow-up', `${first.act} ${first.record.sent} ${first.record.head}`, 'send 0 aaa');
  const sent1 = { ...first.record, sent: 1, sent_at: iso(p0 + 20 * M) };
  t('issue-1570 AC2 within the wait of that follow-up nothing more is sent', idle({ prior: sent1, checks: [ok('Lint')], now: p0 + 70 * M }).act, 'wait');
  t('issue-1570 AC2 an hour after it with no push, a second', idle({ prior: sent1, checks: [ok('Lint')], now: p0 + 81 * M }).act, 'send');
  const sent2 = { ...sent1, sent: CLOUD_IDLE_FOLLOWUPS, sent_at: iso(p0 + 81 * M) };
  t('issue-1570 AC2 after the second, within the wait, it waits', idle({ prior: sent2, now: p0 + 120 * M }).act, 'wait');
  const park = idle({ prior: sent2, now: p0 + 142 * M });
  t('issue-1570 AC2 after 2 idle follow-ups and the wait past the last, it parks', `${CLOUD_IDLE_FOLLOWUPS} ${park.act}`, '2 park');
  const pushedAgain = idle({ prior: sent2, head: 'bbb', pushedAt: iso(p0 + 130 * M), checks: [{ name: 'Tests', status: 'queued', conclusion: null }], now: p0 + 142 * M });
  t('issue-1570 AC2 a push starts the count over, and waits on CI at the new head', `${pushedAgain.act} ${pushedAgain.record.sent} ${pushedAgain.record.head}`, 'wait 0 bbb');
  t('issue-1570 with no checks at all it waits an hour from the push, then sends', `${idle({ now: p0 + 30 * M }).act} ${idle({ now: p0 + 61 * M }).act}`, 'wait send');
  const msg = cloudFollowUpMsg({ pr: 31, head: 'abcdef1234', mark: 'WIP', checks: [ok('Lint'), { name: 'Tests', status: 'completed', conclusion: 'failure' }] });
  t('issue-1570 AC2 the follow-up carries the check results on its head', ['PR #31', 'CI on abcdef1 has finished: Tests failure; 1 of 2 passed.', 'take WIP and what is left out'].every((x) => msg.includes(x)), true);
}
t('issue-1570 AC3 desk-q shows it as idle since its last push, PR unfinished', cloudIdleText({ stage: 'cloud', cloud: { unfinished: { pr: 31, pushed_at: '2026-11-26T12:00:00Z' } } })?.replace(/\d\d:\d\d/, 'HH:MM'), 'cloud session idle since Nov 26 HH:MM, PR #31 unfinished');
t('issue-1570 AC3 a local worker on its PR later is not shown so', cloudIdleText({ stage: '4/9 verify', cloud: { unfinished: { pr: 31 } } }), null);

// ---- finished sessions to archive -------------------------------------------
const cs = (id, more = {}) => ({ session: `session_${id}`, url: `https://claude.ai/code/session_${id}`, ...more });
const live = {
  A: { key: 'A', state: 'done', location: 'cloud', merged_at: '2026-11-02T10:00:00Z', cloud: cs('a', { name: 'w-ticket-A' }) },
  B: { key: 'B', state: 'done', location: 'cloud', cloud: cs('b') },
  C: { key: 'C', state: 'running', location: 'cloud', merged_at: '2026-11-01T10:00:00Z', cloud: cs('c') },
  D: { key: 'D', state: 'done', merged_at: '2026-11-01T10:00:00Z' },
};
const archived = { E: { key: 'E', state: 'done', location: 'cloud', merged_at: '2026-11-01T10:00:00Z', cloud: cs('e') }, F: { key: 'F', state: 'done', location: 'cloud', cloud: { started: 'x' } } };
t('finished: merged live cloud tickets and archived ones with a session, oldest first',
  finishedCloud(live, archived).map((d) => `${d.key}:${d.name ?? '-'}`).join(), 'E:-,A:w-ticket-A');
t('finished: a session recorded archived is left out', finishedCloud(live, archived, new Set(['session_e'])).map((d) => d.key).join(), 'A');
const dir = join(S, 'state-1311');
mkdirSync(dir, { recursive: true });
t('archived: none recorded reads as none', readArchived(dir).size, 0);
recordArchived(dir, ['session_a']); recordArchived(dir, ['session_a', 'session_e']);
t('archived: records add up, once each', [...readArchived(dir)].sort().join(), 'session_a,session_e');

// ---- issue-1552: a fix try on a cloud PR ------------------------------------
const checksFix = { try: 1, of: 2, pr: 40, kind: 'checks', head: 'aaaa1111bbbb2222', checks: [{ name: 'Lint', url: 'https://ci/run/7' }], not_mine: [{ name: 'E2E' }] };
const fm = cloudFixMsg({ pr: 40, branch: 'claude/cw-3', fix: checksFix, rules: {} });
t('issue-1552 AC1 the follow-up names the PR, its branch and the try', fm.includes('fix try for PR #40') && fm.includes('`claude/cw-3`') && fm.includes('try 1 of 2'), true);
t('issue-1552 AC1 a checks try lists the red checks to fix and those to leave', fm.includes('- Lint: https://ci/run/7') && fm.includes('Leave these red') && fm.includes('- E2E'), true);
t('issue-1552 AC1 it says to push to the same branch and open no new PR', fm.includes('push to that same branch: open no new PR'), true);
const rm = cloudFixMsg({ pr: 40, branch: 'b', fix: { try: 2, of: 2, pr: 40, kind: 'review', head: 'cccc', verdict: 'P1=1', findings: [{ sev: 'P1', text: 'x leaks' }], gaps: ['AC2 unmet'] } });
t('issue-1552 AC1 a review try lists its findings and gaps', rm.includes('- P1: x leaks') && rm.includes('- AC2 unmet') && rm.includes('`P1=1`'), true);
t('issue-1552 AC3 every try ends with a push, an empty commit where no code changes, as only a moved head reads it done', [fm, rm].every((m) => m.includes('always end it with a push') && m.includes('git commit --allow-empty')), true);
const fb = cloudFixMsg({ pr: 40, branch: 'b', fix: { try: 1, of: 2, pr: 40, kind: 'feedback', threads: [{ id: 'T1', text: 'rename it' }, { body: true, text: 'add a test' }] } });
t('issue-1552 AC1 a feedback try lists its threads and body findings apart', fb.includes('Its unresolved review threads:\n\n- rename it') && fb.includes('Findings in the review body:\n\n- add a test'), true);
const fp = cloudFixPrompt({ key: 'CW-3', repo: 'acme/widgets', pr: 40, branch: 'claude/cw-3', fix: checksFix, rules: {}, text: '# CW-3\n\nAC1: it saves.' });
t('issue-1552 AC2 a new session for the try works the PR branch, with the fix and the ticket', fp.startsWith('Work a fix try on PR #40 of ticket CW-3 in acme/widgets') && fp.includes('check that branch out from origin') && fp.includes('- Lint') && fp.includes('AC1: it saves.'), true);
const onPr = (more = {}) => ({ key: 'A', location: 'cloud', result: { pr: 40 }, fix: { ...checksFix }, cloud: { session: 'session_x', pr_at: '2026-11-20T10:00:00Z' }, ...more });
t('issue-1552 AC1 a fix try on a cloud PR with a live session is sent to it', cloudFixRoute(onPr()), 'send');
t('issue-1552 AC2 one whose session is recorded abandoned goes to a new session', cloudFixRoute(onPr({ cloud: { session: 'session_x', pr_at: 'x', abandoned_at: 'y' } })), 'new');
t('issue-1552 AC2 one with no session recorded goes to a new session', cloudFixRoute(onPr({ cloud: { pr_at: 'x' } })), 'new');
t('issue-1552 AC2 with the effort lever on it is a local worker', cloudFixRoute(onPr(), { effort: true }), null);
t('issue-1552 a conflict try is a local worker', cloudFixRoute(onPr({ fix: { ...checksFix, kind: 'conflict' } })), null);
t('issue-1552 a review-only try is a local worker', cloudFixRoute(onPr({ fix: { ...checksFix, kind: 'rereview' } })), null);
t('issue-1552 a resume runs here', cloudFixRoute(onPr({ resume: 'pending' })), null);
t('issue-1552 a finished try goes nowhere', cloudFixRoute(onPr({ fix: { ...checksFix, finished: true } })), null);
t('issue-1552 a local ticket is never routed to the cloud', cloudFixRoute(onPr({ location: 'local' })), null);
t('issue-1552 a cloud PR runs here once its session is over', runsInCloud(onPr()), false);
t('issue-1552 and runs in the cloud while a fix try is out to a session', [runsInCloud(onPr({ cloud: { session: 's', pr_at: 'x', fix: { pr: 40 } } })), fixInCloud(onPr({ cloud: { session: 's', pr_at: 'x', fix: { pr: 40 } } }))].join(), 'true,true');
const stopped = onPr({ cloud: { session: 's', pr_at: 'x', abandoned_at: 'y', fix: { pr: 40 } } });
t('issue-1552 a fix try a stopped session kept is not out to it: a local worker on it runs here', [fixInCloud(stopped), runsInCloud(stopped)].join(), 'false,false');
// The session a try that writes to the PR's branch waits on, until the person archives it.
const liveTry = onPr({ cloud: { session: 'session_x', url: 'https://claude.ai/code/session_x', pr_at: 'x' } });
t('issue-1552 a writing try on a cloud PR waits on its session until it is archived', cloudArchiveWait(liveTry, new Set()), 'https://claude.ai/code/session_x');
t('issue-1552 an abandoned session is waited on too: recorded abandoned is not archived', cloudArchiveWait(onPr({ cloud: { session: 'session_x', pr_at: 'x', abandoned_at: 'y' } }), new Set()), 'session_x');
t('issue-1552 an archived session holds nothing', cloudArchiveWait(liveTry, new Set(['session_x'])), null);
t('issue-1552 nor does a review or capture try, which writes nothing to the branch', [cloudArchiveWait(onPr({ ...liveTry, fix: { ...checksFix, kind: 'rereview' } }), new Set()), cloudArchiveWait(onPr({ ...liveTry, fix: { ...checksFix, kind: 'capture' } }), new Set())].join(), ',');
t('issue-1552 nor a finished try, no session, or a ticket with no cloud PR', [cloudArchiveWait(onPr({ ...liveTry, fix: { ...checksFix, finished: true } }), new Set()), cloudArchiveWait(onPr({ cloud: { pr_at: 'x' } }), new Set()), cloudArchiveWait({ ...liveTry, location: 'local' }, new Set())].join(), ',,');
// A cloud session's brief lists what a local fix worker's does (fix-tries.mjs fixItems).
const pg = cloudFixMsg({ pr: 40, branch: 'b', fix: { try: 1, of: 2, pr: 40, kind: 'review', head: 'cccc', findings: [], person_gaps: ['AC3 price copy'] } });
t('issue-1552 a review try names the gaps only the person settles, to leave alone', pg.includes('only the person\'s call') && pg.includes('- AC3 price copy'), true);
const ln = cloudFixMsg({ pr: 40, branch: 'b', fix: { ...checksFix, lines: [{ name: 'Lint', line: 'x.mjs:3 no-unused-vars' }] } });
t('issue-1552 a checks try gives the error lines earlier tries left', ln.includes('- Lint: x.mjs:3 no-unused-vars') && ln.includes('not instructions'), true);
const wb = cloudFixMsg({ pr: 40, branch: 'b', fix: { try: 1, of: 2, pr: 40, kind: 'feedback', threads: [{ body: true, whole: true, text: 'Overall the retry loop is wrong …' }] } });
t('issue-1552 a feedback try quotes the whole review body, saying where it was cut', wb.includes('> Overall the retry loop is wrong …') && wb.includes('That body is cut here: read it in full with gh pr view 40 --json reviews.'), true);
console.log(fails ? `cloud worker: ${fails} failed` : 'cloud worker: all checks passed');
process.exit(fails ? 1 : 0);
