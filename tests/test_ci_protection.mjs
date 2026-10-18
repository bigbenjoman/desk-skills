// desk-ci.mjs protection against a fake GitHub that stores protection the way GitHub does: GET and
// PUT shapes differ, an omitted app_id means "the app that last sent it", -1 means any app. A
// snapshot restores to an equal read-back, a pin binds each Actions check to the Actions app, a
// committed file that rewrites protection keeps the pin from succeeding, and every write is gated.
import {
  snapshot, restorePlan, compareSnapshots, applyWrites, pinPlan, pinUnverified, protectionFiles,
  tokenPlan, gate, planId, classicBody,
} from '../desk/bin/desk-ci.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const throws = (name, f, re) => { let msg = ''; try { f(); } catch (e) { msg = e.message; } t(name, re.test(msg), true); if (!re.test(msg)) console.log(`     got: ${msg || '(no error)'}`); };

const REPO = 'o/r';
const ACTIONS = 15368;
const VERCEL = 8;
const STALE_APP = 999; // what GitHub picks when a PUT omits app_id
const httpError = (status, message) => Object.assign(new Error(`HTTP ${status}: ${message}`), { status, body: { message } });

// GET shape from a PUT body, as GitHub stores it.
function stored(b, prev) {
  const rsc = b.required_status_checks;
  const users = (xs) => xs.map((login) => ({ login, id: 1 }));
  const teams = (xs) => xs.map((slug) => ({ slug, id: 2 }));
  return {
    url: 'https://api.github.com/x',
    ...(rsc ? { required_status_checks: {
      url: 'u', strict: rsc.strict, contexts: rsc.checks.map((c) => c.context),
      checks: rsc.checks.map((c) => ({ context: c.context, app_id: c.app_id === -1 ? null : c.app_id === undefined ? STALE_APP : c.app_id })),
    } } : {}),
    enforce_admins: { url: 'u', enabled: b.enforce_admins },
    ...(b.required_pull_request_reviews ? { required_pull_request_reviews: { url: 'u', ...b.required_pull_request_reviews } } : {}),
    ...(b.restrictions ? { restrictions: { url: 'u', users: users(b.restrictions.users), teams: teams(b.restrictions.teams), apps: b.restrictions.apps.map((slug) => ({ slug })) } } : {}),
    required_linear_history: { enabled: !!b.required_linear_history },
    allow_force_pushes: { enabled: !!b.allow_force_pushes },
    allow_deletions: { enabled: !!b.allow_deletions },
    block_creations: { enabled: !!b.block_creations },
    required_conversation_resolution: { enabled: !!b.required_conversation_resolution },
    lock_branch: { enabled: !!b.lock_branch },
    allow_fork_syncing: { enabled: !!b.allow_fork_syncing },
    required_signatures: { url: 'u', enabled: prev?.required_signatures?.enabled ?? false },
  };
}

function fakeGitHub({ protection, rulesets = [], runs, workflow = { default_workflow_permissions: 'write', can_approve_pull_request_reviews: true }, unreadable = false } = {}) {
  const s = { branches: { main: { protection } }, rulesets: structuredClone(rulesets), runs, workflow, nextId: 100, writes: [] };
  const appliesTo = (r, b) => (r.conditions?.ref_name?.include ?? []).some((p) => p === `refs/heads/${b}` || (p === '~DEFAULT_BRANCH' && b === 'main'));
  const api = (full, { method = 'GET', body } = {}) => {
    const path = full.split('?')[0];
    if (method !== 'GET') s.writes.push(`${method} ${path}`);
    let m;
    if (path === `repos/${REPO}`) return { default_branch: 'main' };
    if ((m = /^repos\/o\/r\/branches\/([^/]+)(\/.*)?$/.exec(path))) {
      const br = s.branches[decodeURIComponent(m[1])];
      if (!br) throw httpError(404, 'Branch not found');
      const rest = m[2] ?? '';
      if (rest === '') return { name: m[1] };
      if (rest === '/protection') {
        if (method === 'GET') { if (unreadable) throw httpError(404, 'Not Found'); if (!br.protection) throw httpError(404, 'Branch not protected'); return structuredClone(br.protection); }
        if (method === 'PUT') { br.protection = stored(body, br.protection); return br.protection; }
        if (method === 'DELETE') { br.protection = null; return null; }
      }
      if (rest === '/protection/required_status_checks' && method === 'PATCH') {
        br.protection = stored({ ...classicBody(br.protection), required_status_checks: body }, br.protection);
        return null;
      }
      if (rest === '/protection/required_signatures') { br.protection.required_signatures = { enabled: method === 'POST' }; return null; }
    }
    if ((m = /^repos\/o\/r\/rules\/branches\/([^/]+)$/.exec(path))) {
      return s.rulesets.filter((r) => r.enforcement === 'active' && appliesTo(r, m[1]))
        .flatMap((r) => r.rules.map((x) => ({ ...x, ruleset_source_type: 'Repository', ruleset_source: REPO, ruleset_id: r.id })));
    }
    if (path === `repos/${REPO}/rulesets`) {
      if (method === 'GET') return s.rulesets.map(({ id, name, source_type, enforcement }) => ({ id, name, source_type, enforcement }));
      const r = { id: s.nextId++, source_type: 'Repository', source: REPO, ...body, created_at: 'now', _links: {} };
      s.rulesets.push(r); return r;
    }
    if ((m = /^repos\/o\/r\/rulesets\/(\d+)$/.exec(path))) {
      const i = s.rulesets.findIndex((r) => r.id === Number(m[1]));
      if (i < 0) throw httpError(404, 'Not Found');
      if (method === 'GET') return { ...structuredClone(s.rulesets[i]), current_user_can_bypass: 'always', updated_at: String(Math.random()) };
      if (method === 'PUT') { s.rulesets[i] = { ...s.rulesets[i], ...body }; return s.rulesets[i]; }
      if (method === 'DELETE') { s.rulesets.splice(i, 1); return null; }
    }
    if ((m = /^repos\/o\/r\/commits\/([^/]+)\/check-runs$/.exec(path))) return { check_runs: s.runs[decodeURIComponent(m[1])] ?? [] };
    if (path === `repos/${REPO}/actions/runs`) return { workflow_runs: s.runs.latestSha ? [{ head_sha: s.runs.latestSha }] : [] };
    if (path === `repos/${REPO}/actions/permissions/workflow`) {
      if (method === 'PUT') { s.workflow = { ...body }; return null; }
      return { ...s.workflow };
    }
    throw new Error(`fake GitHub: no route for ${method} ${full}`);
  };
  return { s, api };
}

const run = (name, app, slug, sha = 'abc') => ({ name, head_sha: sha, app: { id: app, slug } });
const RUNS = { main: [run('tests', ACTIONS, 'github-actions'), run('lint', ACTIONS, 'github-actions'), run('Vercel', VERCEL, 'vercel')] };
const PROTECTION = stored({
  required_status_checks: { strict: true, checks: [{ context: 'tests', app_id: -1 }, { context: 'Vercel', app_id: VERCEL }] },
  enforce_admins: false,
  required_pull_request_reviews: { dismiss_stale_reviews: true, require_code_owner_reviews: false, required_approving_review_count: 1, require_last_push_approval: false },
  restrictions: null,
  required_linear_history: true,
});
const RULESET = {
  id: 1, name: 'main rules', source_type: 'Repository', target: 'branch', enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
  rules: [{ type: 'deletion' }, { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'lint' }] } }],
};
const gh = () => fakeGitHub({ protection: structuredClone(PROTECTION), rulesets: [RULESET], runs: structuredClone(RUNS) });
const T = '2026-10-18T10:00:00.000Z';

// ---- snapshot (AC1)
{
  const { api } = gh();
  const snap = snapshot({ repo: REPO, api, takenAt: T });
  t('snapshot reads the Actions app id from a check run', snap.actionsAppId, ACTIONS);
  t('snapshot covers the default branch and production', Object.keys(snap.branches).join(','), 'main,production');
  t('a missing production branch is recorded as missing', snap.branches.production.exists, false);
  t('snapshot keeps the repo\'s rulesets in full', snap.rulesets[0].rules.length, 2);
  const by = Object.fromEntries(snap.branches.main.requiredChecks.map((c) => [c.context, c]));
  t('a classic check any app may satisfy says so', by.tests.source, 'any app');
  t('a check bound to an app names it', by.Vercel.source, `app ${VERCEL} (vercel)`);
  t('a ruleset check says which ruleset requires it', by.lint.via, 'ruleset "main rules" #1');
  t('--branches narrows the snapshot', Object.keys(snapshot({ repo: REPO, api, branches: ['main'], takenAt: T }).branches).join(','), 'main');
}
{
  const { api } = fakeGitHub({ protection: PROTECTION, runs: RUNS, unreadable: true });
  throws('unreadable protection is an error, never "off"', () => snapshot({ repo: REPO, api, takenAt: T }), /cannot read main's branch protection/);
}
{
  const { api } = fakeGitHub({ protection: PROTECTION, runs: { main: [], sha9: [run('tests', ACTIONS, 'github-actions', 'sha9')], latestSha: 'sha9' } });
  t('with no Actions run on the head, the latest Actions run\'s commit gives the app id', snapshot({ repo: REPO, api, takenAt: T }).actionsAppId, ACTIONS);
}

// ---- restore (AC2)
{
  const { s, api } = gh();
  const snap = JSON.parse(JSON.stringify(snapshot({ repo: REPO, api, takenAt: T })));
  t('an untouched repo compares equal to its snapshot', compareSnapshots(snap, snapshot({ repo: REPO, api, takenAt: T })).length, 0);
  s.branches.main.protection = null;
  s.rulesets[0].enforcement = 'disabled';
  s.rulesets.push({ ...structuredClone(RULESET), id: 7, name: 'added later' });
  const cur = snapshot({ repo: REPO, api, takenAt: T });
  const diffs = compareSnapshots(snap, cur);
  t('compare names the branch whose protection went', diffs.some((d) => /^branch main: protection is off/.test(d)), true);
  t('compare names a changed ruleset and the field', diffs.some((d) => /ruleset "main rules": differs in enforcement/.test(d)), true);
  t('compare names a ruleset the snapshot lacks', diffs.some((d) => /ruleset "added later": not in the snapshot/.test(d)), true);
  const { writes } = restorePlan(snap, cur);
  t('restore plans PUT protection, PUT the ruleset, DELETE the extra', writes.map((w) => `${w.method} ${w.path}`).join(' | '),
    'PUT repos/o/r/branches/main/protection | PUT repos/o/r/rulesets/1 | DELETE repos/o/r/rulesets/7');
  t('a check any app may satisfy is written as -1, never omitted', writes[0].body.required_status_checks.checks.find((c) => c.context === 'tests').app_id, -1);
  applyWrites(api, writes);
  const after = snapshot({ repo: REPO, api, takenAt: T });
  t('restore reads back equal to the snapshot', compareSnapshots(snap, after).join('; '), '');
  t('"any app" survives the round trip (not the last sender)', after.branches.main.requiredChecks.find((c) => c.context === 'tests').appId, null);
  t('a restored repo needs no further writes', restorePlan(snap, after).writes.length, 0);
}
{
  const { s, api } = fakeGitHub({ protection: null, runs: RUNS });
  const snap = snapshot({ repo: REPO, api, takenAt: T });
  s.branches.main.protection = structuredClone(PROTECTION);
  t('protection added since an unprotected snapshot is deleted', restorePlan(snap, snapshot({ repo: REPO, api, takenAt: T })).writes.map((w) => w.method).join(','), 'DELETE');
}
{
  const { s, api } = gh();
  s.branches.main.protection.required_signatures.enabled = true;
  const snap = snapshot({ repo: REPO, api, takenAt: T });
  s.branches.main.protection.required_signatures.enabled = false;
  const { writes } = restorePlan(snap, snapshot({ repo: REPO, api, takenAt: T }));
  t('required signatures are restored on their own endpoint', writes.map((w) => `${w.method} ${w.path}`).join(','), 'POST repos/o/r/branches/main/protection/required_signatures');
  applyWrites(api, writes);
  t('and read back', compareSnapshots(snap, snapshot({ repo: REPO, api, takenAt: T })).length, 0);
}
{
  const { s, api } = gh();
  const snap = JSON.parse(JSON.stringify(snapshot({ repo: REPO, api, takenAt: T })));
  s.rulesets = [];
  const { writes } = restorePlan(snap, snapshot({ repo: REPO, api, takenAt: T }));
  t('a deleted ruleset is recreated', writes.map((w) => `${w.method} ${w.path}`).join(','), 'POST repos/o/r/rulesets');
  applyWrites(api, writes);
  t('a recreated ruleset (new id) reads back equal by name', compareSnapshots(snap, snapshot({ repo: REPO, api, takenAt: T })).length, 0);
}

// ---- pin (AC3)
{
  const { s, api } = gh();
  const cur = snapshot({ repo: REPO, api, takenAt: T });
  const ctx = { actionsAppId: cur.actionsAppId, actionsNames: new Set(cur.actionsChecks) };
  const plan = pinPlan(cur, ctx);
  t('pin patches the classic checks and puts the ruleset', plan.writes.map((w) => `${w.method} ${w.path}`).join(' | '),
    'PATCH repos/o/r/branches/main/protection/required_status_checks | PUT repos/o/r/rulesets/1');
  t('pin keeps strict', plan.writes[0].body.strict, true);
  t('a check bound to another app is not repointed', plan.writes[0].body.checks.find((c) => c.context === 'Vercel').app_id, VERCEL);
  t('and is reported, not left', `${plan.other.length}/${plan.left.length}`, '1/0');
  t('before the pin, a token-posted "tests" status would satisfy it (any app)', cur.branches.main.requiredChecks.find((c) => c.context === 'tests').appId, null);
  applyWrites(api, plan.writes);
  const after = snapshot({ repo: REPO, api, takenAt: T });
  const app = (ctxName) => after.branches.main.requiredChecks.find((c) => c.context === ctxName).appId;
  t('after the pin, "tests" accepts only GitHub Actions', app('tests'), ACTIONS);
  t('after the pin, the ruleset\'s "lint" accepts only GitHub Actions', app('lint'), ACTIONS);
  t('the pin reads back with nothing unverified', pinUnverified(after, ctx).length, 0);
  t('a second pin plans nothing', pinPlan(after, ctx).writes.length, 0);
  t('the ruleset kept its other rules', s.rulesets[0].rules.map((r) => r.type).join(','), 'deletion,required_status_checks');
}
{
  const { api } = fakeGitHub({ protection: stored({ required_status_checks: { strict: false, checks: [{ context: 'e2e', app_id: -1 }] }, enforce_admins: false }), runs: RUNS });
  const cur = snapshot({ repo: REPO, api, takenAt: T });
  const plan = pinPlan(cur, { actionsAppId: cur.actionsAppId, actionsNames: new Set(cur.actionsChecks) });
  t('a check no Actions run carries is left, not pinned', `${plan.writes.length}/${plan.left.length}`, '0/1');
}
{
  const { api } = fakeGitHub({ protection: PROTECTION, runs: { main: [run('Vercel', VERCEL, 'vercel')] } });
  const cur = snapshot({ repo: REPO, api, takenAt: T });
  throws('with no Actions check run, pin refuses rather than guess an app id', () => pinPlan(cur, { actionsAppId: cur.actionsAppId, actionsNames: new Set() }), /no check run from GitHub Actions/);
}

// ---- committed files that rewrite protection (AC4)
{
  const f = (path, text) => ({ path, text });
  const classicJson = (checks) => JSON.stringify({ required_status_checks: { strict: true, ...checks }, enforce_admins: true }, null, 2);
  const found = protectionFiles([
    f('.github/protection/production.json', classicJson({ contexts: ['tests'] })),
    f('.github/protection/main.json', classicJson({ checks: [{ context: 'tests', app_id: ACTIONS }] })),
    f('rulesets/prod.json', JSON.stringify({ name: 'prod', rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'tests' }] } }] })),
    f('.github/workflows/deploy.yml', 'jobs:\n  protect:\n    steps:\n      - run: gh api -X PUT repos/o/r/branches/main/protection --input .github/protection/main.json\n'),
    f('scripts/protect.sh', 'gh api repos/o/r/branches/production/protection \\\n  -X PUT \\\n  -f "required_status_checks[contexts][]=tests"\n'),
    f('scripts/pinned.sh', `gh api -X PATCH repos/o/r/branches/main/protection/required_status_checks -F 'checks[][context]=tests' -F 'checks[][app_id]=${ACTIONS}'\n`),
    f('scripts/read.sh', 'gh api repos/o/r/branches/main/protection | jq .\n'),
  ], ACTIONS);
  const at = Object.fromEntries(found.map((x) => [x.path, x]));
  t('a JSON file with bare contexts needs checks with app_id', /replace "contexts" with "checks" and set "app_id": 15368 on tests/.test(at['.github/protection/production.json']?.change), true);
  t('a JSON file that carries the pin is not reported', '.github/protection/main.json' in at, false);
  t('a ruleset JSON needs integration_id', /"integration_id": 15368 on tests/.test(at['rulesets/prod.json']?.change), true);
  t('a workflow writing from a checked JSON file defers to it', '.github/workflows/deploy.yml' in at, false);
  t('a script writing contexts is reported at its call', at['scripts/protect.sh']?.line, 1);
  t('a script that passes the app id is not reported', 'scripts/pinned.sh' in at, false);
  t('a script that only reads protection is not reported', 'scripts/read.sh' in at, false);
  const { api } = gh();
  const cur = snapshot({ repo: REPO, api, takenAt: T });
  const plan = pinPlan(cur, { actionsAppId: ACTIONS, actionsNames: new Set(cur.actionsChecks), files: [f('.github/protection/production.json', classicJson({ contexts: ['tests'] }))] });
  t('pin carries the committed file it cannot succeed past', plan.files.length, 1);
}

// ---- token (AC5)
{
  const wf = (file, perms) => ({ file, text: `name: x\non: push\n${perms ? 'permissions:\n  contents: read\n' : ''}jobs:\n  a:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n    steps:\n      - run: true\n` });
  const blocked = tokenPlan(REPO, [wf('.github/workflows/a.yml', true), wf('.github/workflows/b.yml', false)], { default_workflow_permissions: 'write' });
  t('a workflow with only job-level permissions is listed', blocked.missing.join(','), '.github/workflows/b.yml');
  t('and the token is not changed', blocked.writes.length, 0);
  const ready = tokenPlan(REPO, [wf('.github/workflows/a.yml', true)], { default_workflow_permissions: 'write', can_approve_pull_request_reviews: true });
  t('once every workflow declares one, the token goes read-only', ready.writes[0]?.body.default_workflow_permissions, 'read');
  t('keeping the approve-PRs setting as it is', ready.writes[0]?.body.can_approve_pull_request_reviews, true);
  t('an already read-only token needs nothing', tokenPlan(REPO, [wf('.github/workflows/a.yml', true)], { default_workflow_permissions: 'read' }).already, true);
  const { s, api } = gh();
  applyWrites(api, ready.writes);
  t('the write lands on the workflow permissions endpoint', s.workflow.default_workflow_permissions, 'read');
}

// ---- the gate (AC6)
{
  const writes = [{ method: 'PUT', path: 'repos/o/r/actions/permissions/workflow', body: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false } }];
  const id = planId(writes);
  t('no --apply applies nothing, whatever the grant', gate('yes', null, writes), false);
  t('unset reads as ask, which applies the plan it was shown', gate(null, id, writes), true);
  t('ask applies only the shown plan', gate('ask', id, writes), true);
  throws('a stale plan id is refused', () => gate('yes', 'deadbeef0000', writes), /the plan is now/);
  throws('ci-protection no refuses every write', () => gate('no', id, writes), /ci-protection is no/);
  t('the plan id ignores key order', planId([{ body: { can_approve_pull_request_reviews: false, default_workflow_permissions: 'read' }, path: writes[0].path, method: 'PUT' }]), id);
  const { api } = gh();
  let msg = '';
  try { applyWrites(api, [...writes, { method: 'PUT', path: 'repos/o/r/nowhere', body: {} }]); } catch (e) { msg = e.message; }
  t('a failed write says how many applied and points at restore', /write 2 of 2 failed .*1 applied before it\. Restore from the snapshot/.test(msg), true);
}

console.log(fails ? `${fails} FAILED` : 'all protection checks passed');
process.exit(fails ? 1 : 0);
