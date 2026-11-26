// The desk app's PR & CI tab, read by desk-ui.mjs: a ticket's PR as GitHub has it now, fetched with
// this computer's own gh sign-in, its checks sorted failed first, and the one sentence that says what
// holds its merge. Only the fields named here reach the window, so nothing gh prints beyond them (its
// stderr, its environment, any field it adds) is ever sent.
//   makePrReader({ gh, now }) -> { pr(ticket, kinds, recorded, verdict), log(ticket, job, recorded) }
// `ticket` is desk-q-model.mjs ticketPageJson's; `kinds` the repo's §4 Required, Advisory and Known
// flaky checks, which label the rows; `recorded` its pr_status, the last pass's copy; `verdict(ps)` the
// sentence for a read shaped as that copy (desk-q-model.mjs prVerdictJson). A PR read less than 60 s ago
// is answered from the cache without running gh, unless the last pass has recorded another head since.
// gh not answering gives the last pass's copy, said as such. A job log is read only for one of the PR's
// own checks.
import { execFile } from 'node:child_process';
import { otherRepoEnv } from './desk-env.mjs';
import { FAILED, latestPerCheck, normaliseRollup, statusChecks } from './gate.mjs';

const PR_TTL_MS = 60 * 1000;
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

// gh pr view's answer, as the tab shows it: only the fields named here.
function fromGh(d) {
  const nodes = (Array.isArray(d.statusCheckRollup) ? d.statusCheckRollup : []).filter((n) => n && (n.name || n.context));
  const checks = latestPerCheck(normaliseRollup(nodes).map((c, i) => ({ ...c, url: githubUrl(nodes[i].detailsUrl ?? nodes[i].targetUrl) })));
  const approvals = (Array.isArray(d.latestReviews) ? d.latestReviews : []).filter((r) => r?.state === 'APPROVED').length;
  return { pr: { number: d.number, title: String(d.title ?? ''), url: String(d.url ?? ''), state: d.state ?? null, draft: d.isDraft === true,
    mergeable: d.mergeable ?? null, merge_state: d.mergeStateStatus ?? null, review: d.reviewDecision || null, approvals,
    head: d.headRefOid ?? null, branch: d.headRefName ?? null, base: d.baseRefName ?? null, merged_at: d.mergedAt ?? null }, checks, rollup: nodes };
}
// The last pass's copy (pass.mjs readPrStatus's pr_status), in the same shape.
function fromPass(t, ps) {
  const job = (c) => (c.runId != null && c.jobId != null ? `https://github.com/${t.gh_repo}/actions/runs/${c.runId}/job/${c.jobId}` : null);
  const checks = (ps.checks ?? []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion ?? null, startedAt: c.started ?? null, completedAt: c.completed ?? null,
    runner: null, runId: c.runId ?? null, jobId: c.jobId ?? null, url: job(c) }));
  return { pr: { number: t.pr.number, title: null, url: t.pr.url, state: ps.state ?? t.pr.state, draft: ps.isDraft === true, mergeable: ps.mergeable ?? null,
    merge_state: ps.mergeState ?? null, review: ps.reviewDecision ?? null, approvals: null, head: ps.head ?? null, branch: null, base: ps.base ?? null,
    merged_at: ps.merged_at ?? null }, checks };
}
// A read from GitHub as a pr_status: the last pass's copy where it was at this head (its reruns, reopen
// and behind readings are of that head), with what GitHub says now over it.
const statusOf = ({ pr, rollup }, recorded) => ({ ...(recorded?.head && recorded.head === pr.head ? recorded : {}),
  state: pr.state, isDraft: pr.draft, mergeable: pr.mergeable, mergeState: pr.merge_state, reviewDecision: pr.review, head: pr.head, base: pr.base, merged_at: pr.merged_at, url: pr.url,
  checks: statusChecks(rollup) });

export function makePrReader({ gh = runGh, now = Date.now } = {}) {
  // `<owner/name>#<n>` -> { at, recorded, read }: the GitHub read, and the head the last pass had recorded
  // then. The verdict is worked out on each request, so a hold recorded since reads at once.
  const cache = new Map();
  const idOf = (t) => `${t.gh_repo}#${t.pr.number}`;

  // { status, body }.
  async function pr(t, kinds, recorded, verdict) {
    if (!t.pr) return { status: 200, body: { pr: null, text: NO_PR } };
    const id = idOf(t);
    const hit = cache.get(id);
    // The head the last pass recorded, read even where the ticket's PR has none (a fix try).
    const seen = recorded?.head ?? t.pr.head ?? null;
    if (hit && now() - hit.at < PR_TTL_MS && hit.recorded === seen) return { status: 200, body: fromRead(hit) };
    const ran = await gh(['pr', 'view', String(t.pr.number), '--repo', t.gh_repo, '--json', FIELDS]);
    let read = null;
    if (ran.exit === 0) { try { read = fromGh(JSON.parse(ran.stdout)); } catch { read = null; } }
    if (!read) {
      console.error(`desk-ui: gh pr view ${id} exited ${ran.exit}`);
      const at = recorded?.at ?? t.pr.at;
      return { status: 200, body: { ...shape(fromPass(t, recorded ?? {}), kinds, verdict(recorded ?? {})), source: 'pass', as_of: at ?? null,
        note: at ? `Showing the copy from the last pass (${clock(at)}). GitHub isn't answering.` : "GitHub isn't answering, and no pass has recorded this PR yet." } };
    }
    const entry = { at: now(), recorded: seen, read };
    cache.set(id, entry);
    return { status: 200, body: fromRead(entry) };

    function fromRead({ at, read: r }) {
      return { ...shape(r, kinds, verdict(statusOf(r, recorded))), source: 'github', as_of: new Date(at).toISOString(), note: null };
    }
  }

  // The last LOG_LINES lines of one of the PR's jobs, one its last read or the last pass names: { status, body }.
  async function log(t, job, recorded) {
    if (!t.pr) return { status: 404, body: { error: { code: 'pr', message: 'This ticket has no PR yet.' } } };
    const own = (cache.get(idOf(t))?.read.checks ?? []).some((c) => String(c.jobId) === job) || (recorded?.checks ?? []).some((c) => String(c.jobId) === job);
    if (!own) return { status: 404, body: { error: { code: 'job', message: 'That job is not one of this PR\'s checks.' } } };
    const ran = await gh(['run', 'view', '--job', job, '--log', '--repo', t.gh_repo]);
    if (ran.exit !== 0) {
      console.error(`desk-ui: gh run view --job ${job} --repo ${t.gh_repo} exited ${ran.exit}`);
      return { status: 502, body: { error: { code: 'github', message: "GitHub isn't answering, so the job log can't be read." } } };
    }
    // Each line is `<job>\t<step>\t<time> <text>`, the time at times after a byte-order mark: the time
    // and text are kept.
    const lines = ran.stdout.split('\n').filter((l) => l.trim()).slice(-LOG_LINES).map((l) => (l.split('\t').slice(2).join('\t') || l).replace(/^﻿/, ''));
    return { status: 200, body: { job, lines, as_of: new Date(now()).toISOString() } };
  }

  return { pr, log };
}

const shape = ({ pr, checks }, kinds, verdict) => ({ pr, checks: sorted(checks.map((c) => row(c, kinds))), verdict });
