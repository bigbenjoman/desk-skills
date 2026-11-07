// suite: review rows (the review a worker runs and posts, under §4 Local review command and Clean review verdict)
// covers: desk/bin/desk-env.mjs desk/bin/undraft.mjs desk/bin/fix-tries.mjs skills/desk-autopilot/references/worker-contract-stage-3.md skills/desk-autopilot/references/worker-contract-stage-4.md skills/desk-autopilot/references/worker-contract-task.md skills/desk-ticket/references/stage-4b-self-review.md skills/desk-review-response/SKILL.md skills/desk-setup/references/step-1-detect.md
// reviewPlan on each pair of rows, and `desk-env review-cmd` reading them from a config; what the
// worker contract, Stage 4b, a fix try's task and /desk-setup say about them, each against the text
// before this rule; and what the pass makes of the verdict a worker then posts.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reviewPlan, postsVerdict } from '../desk/bin/desk-env.mjs';
import { undraftCall, DESK_REVIEW_CLEAN } from '../desk/bin/undraft.mjs';
import { fixTask } from '../desk/bin/fix-tries.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_BIN = join(ROOT, 'desk', 'bin', 'desk-env.mjs');
const T = mkdtempSync(join(tmpdir(), 'desk-review-rows-'));
const read = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\s+/g, ' ');
const COUNTS = 'p0=0 p1=0 gaps=0';

// A repo that ships one review skill naming the marker, and one that does not.
const repo = join(T, 'repo');
const skill = (dir, name, text) => { mkdirSync(join(repo, dir, 'skills', name), { recursive: true }); writeFileSync(join(repo, dir, 'skills', name, 'SKILL.md'), text); };
skill('.agents', 'house-review', 'Open the body with <!-- desk-review:local --> then <!-- desk-review:verdict v=1 ... -->.');
skill('.claude', 'plain-review', 'Post what you found.');

// AC1, AC2: a counts-form row reads only a verdict marker, so the review run is one that posts it.
const clash = reviewPlan(['/code-review'], COUNTS, repo);
t('AC1 /code-review beside a counts-form verdict runs /desk-review', clash.run, '/desk-review');
t('AC5 and the rows are said to contradict each other, naming both', clash.clash.includes('§4 Local review command (`/code-review`)') && clash.clash.includes(`§4 Clean review verdict (\`${COUNTS}\`)`), true);
t('negative control: /desk-review beside it runs itself, with no contradiction', JSON.stringify(reviewPlan(['/desk-review'], COUNTS, repo)), '{"run":"/desk-review","clash":null}');
t('negative control: /code-review beside a plain-text verdict runs itself', JSON.stringify(reviewPlan(['/code-review'], 'no findings', repo)), '{"run":"/code-review","clash":null}');
t('a repo skill naming the marker runs itself', JSON.stringify(reviewPlan(['/house-review'], COUNTS, repo)), '{"run":"/house-review","clash":null}');
t('a repo skill that does not is replaced', reviewPlan(['/plain-review'], COUNTS, repo).run, '/desk-review');
t('of several items, the one that posts the marker is run', JSON.stringify(reviewPlan(['/code-review', '/desk-review'], COUNTS, repo)), '{"run":"/desk-review","clash":null}');
t('a flag after the command still names it', postsVerdict('/desk-review --deep', repo), true);
t('neither a script nor a plugin skill is read as posting one', [postsVerdict('bash scripts/review.sh', repo), postsVerdict('/acme:review', repo)].join(), 'false,false');
t('with no repo root to read, a skill posts none', postsVerdict('/house-review', null), false);
t('an unset row names no review, whatever the verdict', JSON.stringify(reviewPlan(null, COUNTS, repo)), '{"run":null,"clash":null}');
t('an unset verdict row leaves the command as it is', JSON.stringify(reviewPlan(['/code-review'], null, repo)), '{"run":"/code-review","clash":null}');

// AC6: `none` is no review, so it stays the person's and contradicts nothing.
t('AC6 §4 Local review command none stays none, with no contradiction', JSON.stringify(reviewPlan(['none'], COUNTS, repo)), '{"run":"none","clash":null}');

// `desk-env review-cmd` is what a worker reads.
const cmd = (local, clean) => {
  const cfg = join(T, `cfg-${Math.random().toString(36).slice(2)}.md`);
  const rows = [local && `| Local review command | ${local} |`, clean && `| Clean review verdict | \`${clean}\` |`].filter(Boolean).join('\n');
  writeFileSync(cfg, `## 2. Paths\n\n| Field | Value |\n|---|---|\n| Primary repo root | \`${repo}\` |\n\n## 4. Checks\n\n| Field | Value |\n|---|---|\n${rows}\n`);
  const r = spawnSync('node', [ENV_BIN, 'review-cmd'], { encoding: 'utf8', env: { ...process.env, DESK_REPO_ROOT: repo, DESK_CONFIG: cfg, DESK_MACHINE: join(T, 'none.md'), HOME: T } });
  return `${r.status} ${r.stdout.trim()}`;
};
t('AC1 review-cmd prints /desk-review for voicepa\'s rows', cmd('`/code-review`', COUNTS), '0 /desk-review');
t('review-cmd prints the row where it can read clean', cmd('`/code-review`', 'no findings'), '0 /code-review');
t('review-cmd reads a repo skill from the primary root', cmd('`/house-review`', COUNTS), '0 /house-review');
t('review-cmd prints none for none', cmd('`none`', COUNTS), '0 none');
t('review-cmd exits 3 with the row unset, as get does', cmd(null, COUNTS), '3 ');

// AC1: the contract and Stage 4b send every worker to that command, not to the row.
const contract = read('skills/desk-autopilot/references/worker-contract-stage-4.md');
const tools = read('skills/desk-autopilot/references/worker-contract-stage-3.md');
const stage4b = read('skills/desk-ticket/references/stage-4b-self-review.md');
const runsReviewCmd = (s) => s.includes('Run the review `desk-env review-cmd` prints');
t('AC1 the worker contract runs what review-cmd prints', runsReviewCmd(contract), true);
t('AC1 Stage 4b does too', runsReviewCmd(stage4b), true);
t('AC1 and neither still reads the row for what to run', [contract, stage4b].some((s) => s.includes('`desk-env get local-review`')), false);
t('negative control: the contract before this rule fails the check', runsReviewCmd(read('tests/fixtures/worker-contract-before-split.md')), false);
t('AC1 the row\'s own command stays an extra review', tools.includes('The row\'s own command stays an extra review you may also run') && stage4b.includes('The row\'s own command stays an extra review you may also run'), true);
t('AC1 the review fix path and a review sweep run it too', read('skills/desk-review-response/SKILL.md').includes('the review `desk-env review-cmd` prints') && read('skills/desk-autopilot/references/worker-contract-task.md').includes('the command `desk-env review-cmd` prints'), true);

// AC2: a fix try reviews its new head through Stage 4b, and the contract holds there too.
const task = fixTask({ key: 'T-1', fix: { try: 1, of: 2, pr: 850, kind: 'review', findings: [{ sev: 'P1', text: 'x' }] } });
t('AC2 a fix try goes through Stage 4b and reviews the new head with desk-review', task.includes('self-review it (Stage 4b)') && task.includes('review the new head with desk-review and post that review on the PR'), true);
t('AC2 and the contract it loads says the same of a fix try', tools.includes('that is what you run and post, on a fix try too'), true);

// AC3: the verdict such a worker posts clears the PR under voicepa's rows.
const HEAD = 'a'.repeat(40);
const marker = (counts) => `<!-- desk-review:local -->\n<!-- desk-review:verdict v=1 sha=${HEAD} ${counts} vendor=codex-cross round=1 -->\nclean`;
const review = (body) => ({ author: { login: 'ben' }, body, commit: { oid: HEAD } });
const draft = (reviews, localReview) => undraftCall({ key: 'T-1' }, { number: 850, head: HEAD, mergeable: 'MERGEABLE', mergeState: 'DRAFT', body: '', reviews, checks: [{ name: 'tests', status: 'completed', conclusion: 'success' }] },
  { perm: 'yes', localReview, clean: COUNTS, handle: 'ben', required: ['tests'] });
t('AC3 a clean desk-review at a green head is undrafted with /code-review in the row', draft([review(marker(DESK_REVIEW_CLEAN))], '/code-review')?.call, 'ready');
t('negative control: a /code-review report with no marker goes to a review worker', draft([review('Local self-review: /code-review (high)\n\nNo issues found.')], '/code-review')?.call, 'review');
t('AC6 with the row none the person is asked to review it, as today', `${draft([review(marker(DESK_REVIEW_CLEAN))], 'none')?.call} | ${draft([], 'none')?.action}`, 'person | review #850, then undraft it');

// AC4: /desk-setup says so at that row.
const says = (s) => s.includes('say that the pair can never read clean') && s.includes('offer `/desk-review` for §4 Local review command');
t('AC4 /desk-setup says the pair can never read clean and offers /desk-review', says(read('skills/desk-setup/references/step-1-detect.md')), true);
t('negative control: the setup text before this rule fails the check', says(read('tests/fixtures/desk-setup-before-split.md')), false);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
