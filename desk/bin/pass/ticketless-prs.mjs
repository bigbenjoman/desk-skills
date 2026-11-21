// The "ticketless PRs" step of a pass, as a decision: the open PRs into the batch's base that a desk
// session opened and no queued ticket owns. The merge driver merges only a ticket's PR, so nothing
// merges one of these; the batch records them as `ticketless_prs`, and needs-you lists each one until it
// is merged or closed. Pure: it reads only the snapshot it is given.
//
// The snapshot:
//   prs       the open PRs as gh lists them ({ number, title, headRefName, baseRefName, body, createdAt,
//             author: { login } }), or null when they could not be read
//   tickets   every ticket queued in any of the repo's batches, as an array
//   heads     the base branch of each of the repo's batches: a PR from one is that batch's promotion or
//             epic PR, which the batch owns
//   handle    §1 GitHub handle, or null unread
//   base      the batch's base branch
//   recorded  the queue's `ticketless_prs`, or null
//   dry       a dry run
import { keyPattern } from '../batch-state.mjs';

// The line desk-pr opens every PR body it writes with: what tells a desk session's PR from one a person
// opened under the same handle.
export const DESK_PR_FENCE = '<!-- desk-pr: body -->';

// The key of the ticket that owns `pr`: its recorded branch is the PR's head, its PR is this one, or the
// PR's title or head names its key. Null when none does.
export function ownerOf(pr, tickets) {
  const named = `${pr.title ?? ''} ${pr.headRefName ?? ''}`;
  const n = Number(pr.number);
  return tickets.find((t) => (t.branch && t.branch === pr.headRefName)
    || [t.result?.pr, t.draft_pr].some((x) => x != null && Number(x) === n)
    || new RegExp(keyPattern(t.key)).test(named))?.key ?? null;
}

// The PRs of `s` that a desk session opened into the base and no ticket owns, as the queue records
// them, in PR order.
export function ticketlessPrs(s) {
  if (!s.handle || !Array.isArray(s.prs)) return [];
  return s.prs
    .filter((p) => p.baseRefName === s.base && p.author?.login?.toLowerCase() === s.handle.toLowerCase()
      && String(p.body ?? '').includes(DESK_PR_FENCE) && !(s.heads ?? []).includes(p.headRefName) && !ownerOf(p, s.tickets))
    .map((p) => ({ pr: Number(p.number), title: p.title ?? '', branch: p.headRefName ?? '', since: p.createdAt ?? null }))
    .sort((a, b) => a.pr - b.pr);
}

// -> actions:
//   { type: 'set-batch', fields }  the queue's `ticketless_prs`, written only when it changed
//   { type: 'out', line }          a report line for each PR listed for the first time
// An unread PR list leaves the record as it is, so a gh failure neither lists nor drops anything.
export function decideTicketless(s) {
  if (s.prs == null || !s.handle) return [];
  const now = ticketlessPrs(s);
  const was = Array.isArray(s.recorded) ? s.recorded : [];
  const out = [];
  if (!s.dry && JSON.stringify(now) !== JSON.stringify(was)) {
    out.push({ type: 'set-batch', fields: [`ticketless_prs=${now.length ? JSON.stringify(now) : 'null'}`] });
  }
  for (const p of now.filter((x) => !was.some((w) => Number(w.pr) === x.pr))) {
    out.push({ type: 'out', line: `PR #${p.pr} (${p.branch}) into ${s.base} was opened by a desk session and no ticket owns it, so nothing will merge it: listed in needs-you` });
  }
  return out;
}
