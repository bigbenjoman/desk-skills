// What clears a park, as a script can read it: the park's `clears_when`, recorded when the ticket
// parks (a worker's `AUTOPILOT_PARK_CLEARS_WHEN:` line, or `queue.mjs clears-when`). Each pass checks
// it for every parked ticket, and a park whose condition holds is settled without a model or a person.
//
// The forms, one per park:
//   pr <n> merged          the PR merged
//   pr <n> ready           the PR is out of draft (open and not a draft, or merged)
//   ticket <KEY> done      the Jira ticket is in a done status category
//   variable <NAME> set    the repo has an Actions variable of that name
//   run <id> completed     the GitHub Actions run finished, whatever its conclusion
//   git push origin <branch> succeeds
//                          the push GitHub refused with a 5xx goes through; the check is the push
//                          itself, and `--force-with-lease=<branch>:<sha>` may come before `origin`.
//                          A lease with no SHA is not read: a pass pushes long after the worker did,
//                          so it must name what it may overwrite
//   none                   nothing a script can read; the park waits for a person
// Stored on the park as {kind, pr | ticket | name | run | branch}: kind is pr-merged, pr-ready,
// ticket-done, variable-set, run-completed, push-ok (with lease: <sha> for a lease push) or none.
// The pass records one more itself, live-read {reads, head}, for a park waiting on §4 Live reads it
// runs (live-read.mjs), and settles it in its own section.

const FORMS = [
  [/^pr\s+#?(\d+)\s+merged$/i, (m) => ({ kind: 'pr-merged', pr: Number(m[1]) })],
  [/^pr\s+#?(\d+)\s+(?:ready|out of draft)$/i, (m) => ({ kind: 'pr-ready', pr: Number(m[1]) })],
  [/^ticket\s+([A-Za-z][A-Za-z0-9_]*-\d+)\s+done$/i, (m) => ({ kind: 'ticket-done', ticket: m[1].toUpperCase() })],
  [/^(?:repo\s+)?variable\s+([A-Za-z_][A-Za-z0-9_]*)\s+set$/i, (m) => ({ kind: 'variable-set', name: m[1] })],
  [/^run\s+#?(\d+)\s+completed$/i, (m) => ({ kind: 'run-completed', run: Number(m[1]) })],
  [/^git\s+push\s+(?:(?:-u|--set-upstream)\s+)?origin\s+([\w./-]+)\s+succeeds$/i, (m) => ({ kind: 'push-ok', branch: m[1] })],
  [/^git\s+push\s+--force-with-lease=([\w./-]+):([0-9a-f]{40})\s+origin\s+\1\s+succeeds$/, (m) => ({ kind: 'push-ok', branch: m[1], lease: m[2] })],
  [/^none$/i, () => ({ kind: 'none' })],
];
export const CLEARS_WHEN_FORMS = 'pr <n> merged, pr <n> ready, ticket <KEY> done, variable <NAME> set, run <id> completed, git push origin <branch> succeeds, or none';

// {ok: true, cond} or {ok: false, why}. Nothing given is none.
export function parseClearsWhen(raw) {
  const s = String(raw ?? '').trim().replace(/^["'`]|["'`]$/g, '').trim();
  if (!s) return { ok: true, cond: { kind: 'none' } };
  for (const [re, make] of FORMS) {
    const m = re.exec(s);
    if (m) return { ok: true, cond: make(m) };
  }
  return { ok: false, why: `"${s}" is not one of: ${CLEARS_WHEN_FORMS}` };
}

// The condition as it is written, for the report.
export function describeCond(c) {
  switch (c?.kind) {
    case 'pr-merged': return `PR #${c.pr} merged`;
    case 'pr-ready': return `PR #${c.pr} out of draft`;
    case 'ticket-done': return `${c.ticket} done`;
    case 'variable-set': return `repo variable ${c.name} set`;
    case 'run-completed': return `Actions run ${c.run} completed`;
    case 'push-ok': return `git push ${c.lease ? `--force-with-lease=${c.branch}:${c.lease} ` : ''}origin ${c.branch} succeeds`;
    case 'live-read': return `live read ${(c.reads ?? []).join(', ')} finished`;
    default: return 'none';
  }
}

// Does it hold now? {holds: bool, note?} or {error}. `note` is what the next worker or the report
// needs beside the answer: a finished run's conclusion, or an unfinished one's status. The readers do
// the reading and throw on any failure, so a check that could not run is never read as cleared:
//   pr(n) → {state, isDraft}   ticket(key) → the status category key   variable(name) → bool
//   run(id) → {status, conclusion}   push(c) → {holds, note?}, having tried the push
export function checkCond(c, read) {
  try {
    switch (c?.kind) {
      case 'pr-merged': return { holds: read.pr(c.pr).state === 'MERGED' };
      case 'pr-ready': { const p = read.pr(c.pr); return { holds: p.state === 'MERGED' || (p.state === 'OPEN' && p.isDraft === false) }; }
      case 'ticket-done': return { holds: read.ticket(c.ticket) === 'done' };
      case 'variable-set': return { holds: read.variable(c.name) === true };
      case 'run-completed': {
        const r = read.run(c.run);
        if (!r?.status) throw new Error(`gh run view ${c.run}: no status`);
        return r.status === 'completed'
          ? { holds: true, note: `conclusion ${r.conclusion || 'none'}` }
          : { holds: false, note: `still ${r.status}` };
      }
      case 'push-ok': return read.push(c);
      default: return { holds: false };
    }
  } catch (e) { return { error: String(e?.message ?? e).trim().split('\n').pop() || 'the check failed' }; }
}
