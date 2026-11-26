// A ticket file's Decisions entries added since its PR's last review (#1465). A requeued ticket whose
// ticket file gained one restarts at Stage 3 for it, not at the PR stage, where the worker would see
// the open PR and its review and take the ticket as done. Pure: pass.mjs reads the file and the PR.

// The entries under a ticket's `## Decisions` heading, as desk-jira's ticket template writes them
// (`* <yyyy-mm-dd> <who>: <what>`, or a `-` bullet), each { date, line }. A line with no date is left out.
export function ticketDecisions(text) {
  const out = [];
  let inside = false;
  for (const raw of String(text ?? '').split('\n')) {
    const heading = raw.match(/^#{1,6}\s+(.*?)\s*$/);
    if (heading) { inside = /^decisions$/i.test(heading[1]); continue; }
    if (!inside) continue;
    const m = raw.match(/^\s*[-*]\s+(\d{4}-\d{2}-\d{2})\b/);
    if (m) out.push({ date: m[1], line: raw.trim().replace(/^[-*]\s+/, '') });
  }
  return out;
}

// When the PR was last reviewed: the latest of the person's desk reviews (a review whose body carries a
// verdict, `isVerdict`, posted by one of `logins`, as GitHub reports it), falling back to the PR's open
// time. `pr` is `gh pr view --json createdAt,reviews`. Null when neither is known.
export function lastReviewAt(pr, { isVerdict, ownLogin }) {
  const own = (pr?.reviews ?? []).filter((r) => r?.submittedAt && ownLogin(r.author?.login) && isVerdict(r.body));
  const at = own.map((r) => r.submittedAt).sort((a, b) => Date.parse(a) - Date.parse(b)).pop();
  return at ?? pr?.createdAt ?? null;
}

// The entries dated after the last review. An entry carries a day, not a time, so one dated the
// review's own (UTC) day counts as new only when the ticket file was written after the review
// (`changedAt`, its mtime). A file untouched since the review has nothing new, whatever its dates.
export function newDecisions(text, { since, changedAt }) {
  const at = Date.parse(since ?? '');
  if (Number.isNaN(at)) return [];
  const changed = Date.parse(changedAt ?? '');
  if (!Number.isNaN(changed) && changed <= at) return [];
  const day = new Date(at).toISOString().slice(0, 10);
  return ticketDecisions(text).filter((d) => d.date >= day);
}

// The briefing section for a ticket restarting at Stage 3 for new Decisions entries.
export function decisionsBrief({ key, pr, since, entries, file }) {
  return [
    `## New decisions since PR #${pr}'s last review: this session starts at Stage 3`,
    '',
    `${key}'s ticket file (${file}) gained ${entries.length === 1 ? 'a Decisions entry' : `${entries.length} Decisions entries`} dated after PR #${pr}'s last review (${since}):`,
    ...entries.map((d) => `- ${d.line}`),
    '',
    'An open PR and its review are not the ticket done: they predate these decisions. Start at Stage 3 (implement), whatever stage any resume file, handoff or last round above names, and build what each decision adds or changes, then carry on through Stages 4 to 9 on the same PR.',
    'First check the branch for each one. Where a commit on it already meets a decision, say so, naming that commit and the decision, and only then treat that decision as done. Where every one is met that way, take the PR as done with no new commit, saying which commit meets each.',
    '',
  ].join('\n');
}
