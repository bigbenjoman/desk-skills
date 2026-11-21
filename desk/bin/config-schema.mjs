// The repo config's schema: one entry per row the template (desk-config.md) declares in §0 to §5, in
// template order. It reads no file. CONFIG_ROWS and PERMISSION_KEYS below are derived from it (desk-env
// re-exports both), and the config suite holds it equal to the template both ways (coverage), so
// neither can drift unnoticed.
//
// An entry is { id, section, label, kind }:
//   id       the logical id scripts name (`desk-env get <id>`, `perm <id>`); a §3 row's id is its Key
//   section  '0', '1', '2', '3', '3b', '4' or '5'
//   label    the row's first cell as the template writes it, backticks aside (a §3 row's Key)
//   kind     'value' (one item), 'list' (one backtick span per item), 'perm' (a §3 permission) or
//            'table' (a `###` table of the person's own rows, matched by its heading)
//   unread   true for a row no script reads through desk-env yet: it stays out of CONFIG_ROWS, so
//            `desk-env ids`, `get` and `config` print only the rows scripts read
// The §3c rule ledger and the rows inside a 'table' entry's table are the person's own, so they have
// no entries.

const v = (id, section, label, extra) => ({ id, section, label, kind: 'value', ...extra });
const l = (id, section, label, extra) => ({ id, section, label, kind: 'list', ...extra });
const p = (key) => ({ id: key, section: '3', label: key, kind: 'perm' });
const unread = { unread: true };

export const ROWS = Object.freeze([
  // §0 This repo
  v('gh-repo', '0', 'GitHub repo'),
  v('slug', '0', 'Slug', unread),
  v('default-branch', '0', 'Default branch'),
  v('repo-description', '0', 'One-line description'),
  // §1 Who you are in this repo
  v('name', '1', 'Name'),
  v('short-name', '1', 'Short form colleagues use', unread),
  v('github-handle', '1', 'GitHub handle'),
  v('jira-email', '1', 'Jira email'),
  v('jira-display-name', '1', 'Jira display name'),
  v('jira-account-id', '1', 'Jira account id'),
  v('git-author', '1', 'Git author name / email'),
  v('pronouns', '1', 'Pronouns (optional)', unread),
  // §2 Paths on your machine
  v('repo-root', '2', 'Primary repo root'),
  v('worktrees-dir', '2', 'Worktrees directory'),
  v('handoff-dir', '2', 'Handoff directory'),
  v('backups-dir', '2', 'Backups directory'),
  v('design-dir', '2', 'Design canvases directory'),
  v('wsl', '2', 'Running on WSL?'),
  v('browser-profile', '2', 'Signed-in browser profile'),
  v('handoff-pct', '2', 'Handoff at context %'),
  v('handoff-pct-1m', '2', 'Handoff at context % on a 1M window'),
  l('autopilot-state', '2', 'Autopilot state', unread),
  // §3 Permissions: Reading
  p('read-own-work'), p('read-local-git'), p('read-others'), p('read-slack-public'), p('read-figma'),
  p('read-vercel'), p('read-confluence'), p('read-transcripts'), p('read-calendar'), p('read-slack-own'),
  // §3 Jira
  p('jira-assign-self'), p('jira-comment'), p('jira-create'), p('jira-edit'), p('jira-transition'),
  p('jira-close-own-merged'), p('jira-close'), p('jira-route'), p('jira-others'),
  // §3 Git and pull requests
  p('git-commit'), p('git-push'), p('git-force-with-lease'), p('pr-open'), p('pr-edit'), p('pr-images'),
  p('pr-self-review-comment'), p('pr-review-others'), p('pr-reply'), p('pr-request-review'), p('pr-ready'),
  p('pr-auto-merge'), p('pr-merge-green'), p('merge-feedback-first'), p('pr-update-branch'),
  p('pr-conflict-unreviewed'), p('pr-conflict-reviewed'), p('ci-rerun'), p('codex-review'), p('ci-protection'),
  p('gh-close-linked-issue'), p('gh-issue-create'), p('gh-issue-comment'),
  // §3 Autopilot
  p('autopilot-workers'), p('autopilot-worker-mode'), p('autopilot-merge'), p('merge-hold-routine'),
  p('batch-base-push'), p('autopilot-judgement'), p('autopilot-reclaim'), p('machine-reboot'),
  p('worker-dependency-install'), p('worker-screenshots'), p('worker-local-services'), p('worker-web-read'),
  p('worker-workflow-dispatch'),
  // §3 Local and shared state
  p('db-per-ticket'), p('db-clone-staging'), p('staging-write'), p('local-reindex'), p('tests-shared-db'),
  p('worktree-remove'), p('branch-delete'), p('server-stop'), p('skills-edit'), p('vercel-env'), p('slack-draft'),
  // §3 Not configurable
  p('slack-send'), p('merge-bypass'), p('others-prs'), p('product-calls'), p('legal-content'),
  // §3b Cost and autonomy
  v('subagents-without-asking', '3b', 'Subagents that may run without asking'),
  v('dev-port', '3b', 'Preferred dev-server port'),
  v('concurrency', '3b', 'Autopilot worker concurrency'),
  v('memory-ceiling', '3b', 'Memory ceiling for parallel work (GB)'),
  v('spawn-gate', '3b', 'Spawn gate (available memory)'),
  v('file-budget', '3b', 'Per-file collision budget'),
  v('test-cap', '3b', 'Test worker cap under the test lock'),
  v('worker-budget', '3b', 'Autopilot per-worker budget (USD)'),
  v('batch-budget', '3b', 'Autopilot batch budget (USD)'),
  v('worker-models', '3b', 'Worker models'),
  v('worker-effort', '3b', 'Worker effort'),
  v('worker-location', '3b', 'Worker location'),
  v('batches-run-by', '3b', 'Batches run by'),
  v('borrow-idle', '3b', 'Borrow idle workers'),
  v('park-after', '3b', 'Park an unanswered question after (minutes)'),
  v('resume-killed', '3b', 'Resume a killed worker (times)'),
  v('disk-floor', '3b', 'Free disk floor (GB)'),
  v('promotion-slice', '3b', 'Promotion slice size (children)'),
  v('claim-release', '3b', 'Release idle claims after (hours)'),
  v('usage-pacing', '3b', 'Usage pacing headroom (points)'),
  v('subscription', '3b', 'Subscription'),
  v('maintenance-window', '3b', 'Maintenance window'),
  v('maintenance-drain', '3b', 'Maintenance drain limit (minutes)'),
  v('stage-reports', '3b', 'Report every stage transition on long runs', unread),
  v('status-table', '3b', 'Orchestrator status table'),
  v('push-notify', '3b', 'Push notification when a batch needs you', unread),
  v('checkin-times', '3b', 'Check-in times'),
  l('levers', '3b', 'Phase 0 levers'),
  v('codex-models', '3b', 'Codex review'),
  v('intake-query', '3b', 'Intake query'),
  v('triage-concurrency', '3b', 'Triage concurrency'),
  // §4 Tracker
  v('tracker', '4', 'Tracker'),
  v('jira-site', '4', 'Jira site'),
  v('jira-cloudid', '4', 'Jira cloudId'),
  l('jira-project', '4', 'Jira project'),
  v('ticket-pattern', '4', 'Ticket key pattern'),
  l('work-id-patterns', '4', 'Other work id patterns'),
  v('jira-workflow', '4', 'Workflow', unread),
  v('in-progress-state', '4', 'In-progress state'),
  v('review-state', '4', 'Review state'),
  v('done-state', '4', 'Done state'),
  l('jira-priority', '4', 'Priority'),
  l('jira-other-fields', '4', 'Other fields'),
  l('jira-required-fields', '4', 'Required fields'),
  v('jira-size-field', '4', 'Size field'),
  l('jira-priority-user-only', '4', 'Priorities only you set'),
  l('labels', '4', 'Labels'),
  l('person-step-labels', '4', 'Person-step labels'),
  l('person-input-labels', '4', 'Person-input labels'),
  v('desk-jira-setup', '4', 'desk-jira set up?', unread),
  // §4 GitHub and CI
  v('branch-protection', '4', 'Branch protection'),
  l('required-checks', '4', 'Required checks'),
  l('advisory-checks', '4', 'Advisory checks'),
  l('flaky-checks', '4', 'Known flaky checks'),
  l('state-checks', '4', 'State checks'),
  l('operator-checks', '4', "Checks workers can't fix"),
  l('check-builds', '4', 'Check builds'),
  l('live-reads', '4', 'Live reads'),
  l('pre-merge-steps', '4', 'Pre-merge steps'),
  l('evidence-workflow', '4', 'Evidence workflow'),
  l('worker-workflows', '4', 'Worker workflows'),
  l('worker-read-repos', '4', 'Worker read-only repos'),
  l('worker-measure-cmds', '4', 'Worker measuring commands'),
  l('merge-holds', '4', 'Merge holds'),
  l('incidental-paths', '4', 'Incidental paths'),
  l('append-only-paths', '4', 'Append-only paths'),
  v('merge-method', '4', 'Merge method'),
  v('repo-merge-settings', '4', 'Repo merge settings'),
  v('gh-token-scopes', '4', 'gh token scopes', unread),
  v('codex-answers', '4', 'Codex answers a real call?', unread),
  v('local-review', '4', 'Local review command'),
  v('clean-verdict', '4', 'Clean review verdict'),
  v('review-account', '4', 'Review account'),
  l('gate-reviewers', '4', 'Gate reviewers'),
  v('review-bar', '4', 'Review bar'),
  l('review-experts', '4', 'Review domain experts'),
  l('agents-sync', '4', 'Project subagents sync'),
  // §4 Toolchain
  v('package-manager', '4', 'Package manager'),
  v('command-prefix', '4', 'Command prefix'),
  l('install-cmd', '4', 'Install'),
  l('dev-cmd', '4', 'Dev server'),
  l('typecheck-cmd', '4', 'Typecheck'),
  l('lint-cmd', '4', 'Lint'),
  v('baseline-checks', '4', 'Baseline checks'),
  l('test-cmd', '4', 'Unit tests'),
  l('related-test-cmd', '4', 'Related tests'),
  v('suite-weight', '4', 'Suite weight'),
  l('e2e-cmd', '4', 'E2E tests'),
  l('storybook-cmd', '4', 'Storybook'),
  l('integration-cmd', '4', 'Integration tests'),
  l('acceptance-specs', '4', 'Acceptance specs'),
  l('build-cmd', '4', 'Build'),
  l('codegen-cmd', '4', 'Codegen'),
  l('pre-push-checks', '4', 'Pre-push checks'),
  l('merged-tree-check-cmd', '4', 'Merged-tree check'),
  l('pr-description-checks', '4', 'PR-description checks'),
  l('env-files', '4', 'Env files'),
  // §4 Environments and services
  v('local-db', '4', 'Local database'),
  l('db-url-var', '4', 'Database URL variable'),
  l('db-migrate-cmd', '4', 'Database migrate'),
  l('seed-cmd', '4', 'Seed'),
  l('local-services', '4', 'Local services'),
  l('staging', '4', 'Staging'),
  v('staging-bypass', '4', 'Staging bypass token location'),
  v('production', '4', 'Production', unread),
  v('promotion-ref', '4', 'Promotion ref'),
  l('vercel', '4', 'Vercel'),
  l('slack-channels', '4', 'Slack channels'),
  v('checkout-destination', '4', 'Check-out destination'),
  // §4 People, by role
  v('code-reviewer', '4', 'Code reviewer'),
  v('infra-owner', '4', 'Infra and security owner', unread),
  v('product-owner', '4', 'Product owner'),
  v('designer', '4', 'Designer', unread),
  v('qa-filers', '4', 'QA filers', unread),
  v('ticket-deleters', '4', 'Deletes tickets', unread),
  v('former-members', '4', 'No longer on the team', unread),
  { id: 'review-asks', section: '4', label: 'What review here consistently asks for', kind: 'table' },
  // §5 Conventions
  v('branch-names', '5', 'Branch names'),
  v('pr-title', '5', 'PR title'),
  v('ai-attribution', '5', 'AI attribution'),
  v('pr-body', '5', 'PR body', unread),
  v('pr-lifecycle', '5', 'PR lifecycle', unread),
  v('batches', '5', 'Batches', unread),
  v('ticket-format', '5', 'Ticket format', unread),
  v('ticket-comment', '5', 'Ticket comment', unread),
  v('code-comments', '5', 'Code comments', unread),
  v('user-copy', '5', 'User-facing copy you write', unread),
  l('breakpoints', '5', 'Breakpoints'),
  l('themes', '5', 'Themes'),
  l('design-system', '5', 'Design system'),
  v('colleague-messages', '5', 'Messages to colleagues', unread),
  v('decisions-put', '5', 'Decisions put to you', unread),
  v('vercel-env-vars', '5', 'Vercel env vars', unread),
  l('repo-instructions', '5', 'Repo instructions'),
].map((e) => Object.freeze(e)));

// desk-env's id tables, which it re-exports: the §3 key of each permission id, and the section and row
// of every other id scripts read.
export const PERMISSION_KEYS = Object.freeze(Object.fromEntries(ROWS.filter((e) => e.kind === 'perm').map((e) => [e.id, e.label])));
export const CONFIG_ROWS = Object.freeze(Object.fromEntries(ROWS.filter((e) => e.kind !== 'perm' && !e.unread)
  .map((e) => [e.id, e.kind === 'table' ? { section: e.section, row: e.label, table: true } : { section: e.section, row: e.label }])));

// How a label, heading or table header is compared: markdown emphasis and backticks dropped, spacing
// collapsed, case folded. desk-env's config parser normalises with this too.
export const norm = (s) => String(s).replace(/[*`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const where = (section, label) => `${section}\t${norm(label)}`;

// The template's declared rows ([{ section, label }]) and the `###` headings of its tables of the
// person's own rows ([{ section, heading }]) against the schema. -> { missing: the declared rows with
// no entry, extra: the entries naming no declared row or table }, each as { section, label }. Both
// empty means the two agree.
export function coverage({ rows = [], tables = [] }) {
  const byRow = new Set(ROWS.filter((e) => e.kind !== 'table').map((e) => where(e.section, e.label)));
  const haveRows = new Set(rows.map((r) => where(r.section, r.label)));
  const haveTables = new Set(tables.map((t) => where(t.section, t.heading)));
  const missing = rows.filter((r) => !byRow.has(where(r.section, r.label))).map(({ section, label }) => ({ section, label }));
  const extra = ROWS.filter((e) => !(e.kind === 'table' ? haveTables : haveRows).has(where(e.section, e.label)))
    .map(({ section, label }) => ({ section, label }));
  return { missing, extra };
}
