// The desk app's PR & CI tab, read by desk-ui.mjs: a ticket's PR as GitHub has it now, fetched with
// this computer's own gh sign-in, its checks sorted failed first, and the one sentence that says what
// holds its merge. Only the fields named here reach the window, so nothing gh prints beyond them (its
// stderr, its environment, any field it adds) is ever sent.
//   makePrReader({ gh, now, ttl }) -> { pr(ticket, kinds), log(ticket, job) }
// `ticket` is desk-q-model.mjs ticketPageJson's; `kinds` the repo's §4 Required, Advisory and Known
// flaky checks. A PR read less than `ttl` ago at the head the last pass recorded is answered from the
// cache without running gh. gh not answering gives the copy the last pass recorded, said as such.
import { execFile } from 'node:child_process';
import { otherRepoEnv } from './desk-env.mjs';
import { FAILED, evaluateGate, latestPerCheck, normaliseRollup, requiredPasses } from './gate.mjs';

export const PR_TTL_MS = 60 * 1000;
export const LOG_LINES = 40;
const GH_TIMEOUT_MS = 30 * 1000;
const FIELDS = 'number,title,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,latestReviews,headRefOid,headRefName,baseRefName,mergedAt,statusCheckRollup';
export const NO_PR = 'No PR yet. The worker opens one at stage 7/9 (PR).';

// gh with no shell, in an environment without the calling repo's own variables: { exit, stdout, stderr }.
export const runGh = (args) => new Promise((resolve) => {
  execFile('gh', args, { env: otherRepoEnv(), shell: false, timeout: GH_TIMEOUT_MS, maxBuffer: 32 << 20, encoding: 'utf8' },
    (err, stdout, stderr) => resolve({ exit: err ? (Number.isInteger(err.code) ? err.code : null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
});

const clock = (iso) => new Date(iso).toTimeString().slice(0, 5);
const listed = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
// A link the window may open: GitHub's own pages only.
const githubUrl = (u) => (typeof u === 'string' && /^https:\/\/github\.com\//.test(u) ? u : null);
const secs = (a, b) => { const s = Date.parse(a ?? ''), e = Date.parse(b ?? ''); return Number.isFinite(s) && Number.isFinite(e) ? Math.max(0, Math.round((e - s) / 1000)) : null; };

// A check as the table draws it. `kinds` names the repo's required, advisory and known flaky checks.
function row(c, kinds) {
  const kind = kinds.required.includes(c.name) ? 'required' : kinds.flaky.includes(c.name) ? 'known flaky' : kinds.advisory.includes(c.name) ? 'advisory' : null;
  const status = c.status !== 'completed' ? (c.status === 'queued' ? 'queued' : 'running')
    : c.conclusion === 'success' ? 'passed' : FAILED.has(c.conclusion) ? 'failed' : c.conclusion ?? 'done';
  return { name: c.name, kind, status, started_at: c.startedAt ?? null, duration_s: c.status === 'completed' ? secs(c.startedAt, c.completedAt) : null,
    runner: c.runner ?? null, run_id: c.runId ?? null, job_id: c.jobId ?? null, url: c.url ?? null };
}
const ORDER = { failed: 0, running: 1, queued: 2 };
const sorted = (rows) => rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) => (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3) || i - j).map(([r]) => r);

// What holds the merge, as one sentence: { tone, text }. `checks` are gate.mjs's normalised checks.
export function verdictOf(ticket, pr, checks, kinds) {
  const t = ticket, p = t.passes ?? {};
  if (pr.state === 'MERGED') return { tone: 'done', text: `Merged ${clock(pr.merged_at ?? t.merged_at)}${t.merged_by ? ` by ${t.merged_by}` : ''}.` };
  if (pr.state === 'CLOSED') return { tone: 'err', text: 'Closed without merging.' };
  if (t.stuck) return { tone: 'err', text: `Stuck: ${t.stuck.why}` };
  if (t.pr?.hold) return { tone: 'person', text: `Only a person merges it: ${t.pr.hold}.` };
  if (pr.draft) return { tone: 'info', text: 'Draft. Comes out of draft at the next pass.' };
  const gate = evaluateGate(checks, { required: kinds.required, advisory: [...kinds.advisory, ...kinds.flaky] });
  const red = [...new Set(gate.failing.map((f) => f.name))];
  if (red.length) {
    const fix = t.fix?.try != null ? ` Fix try ${t.fix.try} of ${t.fix.of} ${t.state === 'running' ? 'is running' : 'starts when a worker is free'}.` : '';
    return { tone: 'warn', text: `Blocked: ${listed(red)} ${red.length === 1 ? 'is' : 'are'} red.${fix}` };
  }
  if (gate.state !== 'pass') {
    const n = new Set(gate.pending).size;
    return { tone: 'info', text: n ? `Waiting: ${n} check${n === 1 ? ' is' : 's are'} still running.` : 'Waiting: no checks have reported yet.' };
  }
  const n = kinds.required.length ? checks.filter((c) => kinds.required.includes(c.name) && requiredPasses(c)).length : checks.filter(requiredPasses).length;
  const which = `${n === 1 ? 'the 1' : `all ${n}`} ${kinds.required.length ? 'required ' : ''}check${n === 1 ? '' : 's'} green`;
  if (pr.review === 'REVIEW_REQUIRED' || pr.review === 'CHANGES_REQUESTED') return { tone: 'warn', text: `Waiting for review: ${which}, and it needs an approving review.` };
  const when = !p.merges ? ' It waits for you to merge it.' : p.live && p.next ? ` The merge driver merges it at the next pass (${clock(p.next)}).` : ' The merge driver merges it once passes resume.';
  return { tone: 'ok', text: `Ready to merge: ${which}${pr.review === 'APPROVED' ? ' and approved' : ''}.${when}` };
}

// gh pr view's answer, as the tab shows it: only the fields named here.
function fromGh(d) {
  const nodes = (Array.isArray(d.statusCheckRollup) ? d.statusCheckRollup : []).filter((n) => n && (n.name || n.context));
  const checks = latestPerCheck(normaliseRollup(nodes).map((c, i) => ({ ...c, url: githubUrl(nodes[i].detailsUrl ?? nodes[i].targetUrl) })));
  const approvals = (Array.isArray(d.latestReviews) ? d.latestReviews : []).filter((r) => r?.state === 'APPROVED').length;
  return { pr: { number: d.number, title: String(d.title ?? ''), url: String(d.url ?? ''), state: d.state ?? null, draft: d.isDraft === true,
    mergeable: d.mergeable ?? null, merge_state: d.mergeStateStatus ?? null, review: d.reviewDecision || null, approvals,
    head: d.headRefOid ?? null, branch: d.headRefName ?? null, base: d.baseRefName ?? null, merged_at: d.mergedAt ?? null }, checks };
}
// The last pass's copy (pr_status), in the same shape.
function fromPass(t, recorded) {
  const ps = recorded ?? {};
  const checks = (ps.checks ?? []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion ?? null, startedAt: c.started ?? null, completedAt: c.completed ?? null,
    runner: c.runner ?? null, runId: c.run_id ?? null, jobId: c.job_id ?? null, url: githubUrl(c.url) }));
  return { pr: { number: t.pr.number, title: null, url: t.pr.url, state: ps.state ?? t.pr.state, draft: ps.isDraft === true, mergeable: ps.mergeable ?? null,
    merge_state: ps.mergeState ?? null, review: ps.reviewDecision ?? null, approvals: null, head: ps.head ?? null, branch: null, base: ps.base ?? null,
    merged_at: ps.merged_at ?? null }, checks };
}

export function makePrReader({ gh = runGh, now = Date.now, ttl = PR_TTL_MS } = {}) {
  const cache = new Map(); // `<owner/name>#<n>` -> { at, head, body }

  // { status, body }. `recorded` is the ticket's pr_status, for the copy shown when GitHub is not answering.
  async function pr(t, kinds, recorded = null) {
    if (!t.pr) return { status: 200, body: { pr: null, text: NO_PR } };
    const id = `${t.gh_repo}#${t.pr.number}`;
    const hit = cache.get(id);
    if (hit && now() - hit.at < ttl && hit.head && hit.head === t.pr.head) return { status: 200, body: hit.body };
    const ran = await gh(['pr', 'view', String(t.pr.number), '--repo', t.gh_repo, '--json', FIELDS]);
    let read = null;
    if (ran.exit === 0) { try { read = fromGh(JSON.parse(ran.stdout)); } catch { read = null; } }
    if (!read) {
      console.error(`desk-ui: gh pr view ${id} exited ${ran.exit}`);
      const copy = fromPass(t, recorded);
      const at = t.pr.at;
      return { status: 200, body: { ...shape(t, copy, kinds), source: 'pass', as_of: at,
        note: at ? `Showing the copy from the last pass (${clock(at)}). GitHub isn't answering.` : "GitHub isn't answering, and no pass has recorded this PR yet." } };
    }
    const body = { ...shape(t, read, kinds), source: 'github', as_of: new Date(now()).toISOString(), note: null };
    cache.set(id, { at: now(), head: read.pr.head, body });
    return { status: 200, body };
  }

  // The last LOG_LINES lines of one of the PR's jobs: { status, body }.
  async function log(t, job) {
    if (!t.pr) return { status: 404, body: { error: { code: 'pr', message: 'This ticket has no PR yet.' } } };
    const ran = await gh(['run', 'view', '--job', String(job), '--log', '--repo', t.gh_repo]);
    if (ran.exit !== 0) {
      console.error(`desk-ui: gh run view --job ${job} --repo ${t.gh_repo} exited ${ran.exit}`);
      return { status: 502, body: { error: { code: 'github', message: "GitHub isn't answering, so the job log can't be read." } } };
    }
    // Each line is `<job>\t<step>\t<time> <text>`, the time at times after a byte-order mark: the time
    // and text are kept.
    const lines = ran.stdout.split('\n').filter((l) => l.trim()).slice(-LOG_LINES).map((l) => (l.split('\t').slice(2).join('\t') || l).replace(/^﻿/, ''));
    return { status: 200, body: { job: String(job), lines, as_of: new Date(now()).toISOString() } };
  }

  return { pr, log };
}

function shape(t, { pr, checks }, kinds) {
  return { pr, checks: sorted(checks.map((c) => row(c, kinds))), verdict: verdictOf(t, pr, checks, kinds) };
}
