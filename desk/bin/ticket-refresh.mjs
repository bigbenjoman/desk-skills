// A GitHub issue's ticket file ($DESK_STATE/tickets/issue-<n>.md) brought up to date with the issue
// before its worker spawns or resumes, so a criterion added to the issue after admission, in a body
// edit or a comment, reaches the worker. Pure: pass.mjs reads the issue and writes the file.
import { sections } from './desk-design.mjs';
import { ticketDecisions } from './decisions-change.mjs';

// Whether the issue changed since its text was last read: its `updatedAt` after the time recorded
// for the last read (the queue's `issue_read`), else after the ticket file was written.
export function issueChanged({ updatedAt, readAt, fileAt }) {
  const u = Date.parse(updatedAt ?? '');
  if (Number.isNaN(u)) return false;
  const seen = [readAt, fileAt].map((x) => Date.parse(x ?? '')).filter((x) => !Number.isNaN(x));
  return !seen.length || u > Math.max(...seen);
}

// The issue as a ticket file, in the layout desk-autopilot's batch-arguments gives it: key, source,
// title, body, then every comment in order with its author and date. `extra` are Decisions entries
// to keep, added to the body's own Decisions section, or under a new one at the body's end. The
// section is found as ticketDecisions reads it (desk-design.mjs `sections`), so the entries land
// where the restart looks for them.
export function issueText({ key, repo, n, issue, extra = [] }) {
  const text = String(issue.body ?? '').replace(/\r\n/g, '\n').trimEnd();
  const body = text.split('\n');
  if (extra.length) {
    const secs = sections(text);
    const at = secs.findIndex((s) => /^decisions$/i.test(s.name));
    // A body in Jira wiki headings is read in that form alone (`sections`), so the new heading matches it.
    if (at < 0) body.push('', body.some((l) => /^\s*h[1-6]\.\s+/i.test(l)) ? 'h2. Decisions' : '## Decisions', ...extra);
    else {
      // Each section after the first opens with its heading line, so the Decisions heading's index is
      // the lines of every section before it plus their headings.
      const heading = secs.slice(0, at).reduce((sum, s) => sum + s.lines.length, 0) + at - 1;
      const filled = secs[at].lines.filter((l) => l.text.trim()).pop();
      body.splice(filled ? filled.n : heading + 1, 0, ...extra);
    }
  }
  const comments = (issue.comments ?? []).map((c) => `**${c.author?.login ?? 'unknown'}**, ${c.createdAt ?? 'undated'}:\n\n${String(c.body ?? '').replace(/\r\n/g, '\n').trim()}`);
  return [`# ${key}`, '', `Source: GitHub issue ${repo}#${n}`, '', String(issue.title ?? '').trim(), '', body.join('\n').trim(),
    ...(comments.length ? ['', '## Comments', '', comments.join('\n\n')] : []), ''].join('\n');
}

// The trimmed, non-empty lines of a text's Acceptance criteria section.
export function criteria(text) {
  const s = sections(text).find((x) => /^acceptance criteria\b/i.test(x.name));
  return (s?.lines ?? []).map((l) => l.text.trim()).filter(Boolean);
}

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Who a refresh's own Decisions entry names, which tells it apart from the issue's entries.
const ENTRY_BY = 'desk pass:';

// The briefing section for a session that starts past Stage 0 after a refresh changed what its
// ticket asks, with no Decisions restart to carry it (no PR open yet).
export function refreshBrief({ key, n, file, what }) {
  return [
    `## ${key}'s ticket file was refreshed from issue #${n} since you last read it`,
    '',
    `${file} now holds the issue as it is: ${what}.`,
    'Re-read it before you go on, and build what it adds or changes before the PR.',
    '',
  ].join('\n');
}

// The ticket file `old` refreshed from `issue`: { text, added, removed, comments, entry }. `added` and
// `removed` are the Acceptance criteria lines the refresh adds or drops (a changed line is both), and
// `comments` the issue's comments whose text the old file does not hold. Where any of them is set and
// `pr` names an open PR, `entry` is a Decisions entry dated `today` naming them, which the file gains,
// so the requeue restarts the worker at Stage 3 for it (decisions-change.mjs). The entries an earlier
// refresh wrote are kept; every other Decisions entry follows the issue as it is now, so one edited or
// deleted on the issue is edited or gone here too.
export function refreshTicket({ old, key, repo, n, issue, today, pr = null }) {
  const plain = issueText({ key, repo, n, issue });
  const before = criteria(old), after = criteria(plain);
  const added = after.filter((l) => !before.includes(l));
  const removed = before.filter((l) => !after.includes(l));
  const flatOld = squash(old);
  const comments = (issue.comments ?? []).filter((c) => squash(c.body) && !flatOld.includes(squash(c.body)));
  const freshDecisions = new Set(ticketDecisions(plain).map((d) => d.line));
  const ours = new RegExp(`^\\d{4}-\\d{2}-\\d{2} ${ENTRY_BY} issue #${n} changed after PR #`);
  const kept = ticketDecisions(old).filter((d) => ours.test(d.line) && !freshDecisions.has(d.line)).map((d) => `* ${d.line}`);
  const changed = added.length || removed.length || comments.length;
  const what = [
    added.length ? `acceptance criteria added or changed: ${added.map((l) => `"${l}"`).join('; ')}` : '',
    removed.length ? `acceptance criteria removed or replaced: ${removed.map((l) => `"${l}"`).join('; ')}` : '',
    comments.length ? `new or edited comments: ${comments.map((c) => `${c.author?.login ?? 'unknown'} at ${c.createdAt ?? 'undated'}`).join(', ')} (under Comments: a comment can add or rule out a criterion)` : '',
  ].filter(Boolean).join('; ');
  const entry = changed && pr != null ? `* ${today} ${ENTRY_BY} issue #${n} changed after PR #${pr} was opened, and this file was refreshed from it: ${what}. Build and re-review it before taking the PR as done` : null;
  const text = issueText({ key, repo, n, issue, extra: [...kept, ...(entry ? [entry] : [])] });
  return { text, added, removed, comments, what, entry };
}
