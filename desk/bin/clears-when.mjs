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
//   none                   nothing a script can read; the park waits for a person
// Stored on the park as {kind, pr | ticket | name | run}: kind is pr-merged, pr-ready, ticket-done,
// variable-set, run-completed or none.

const FORMS = [
  [/^pr\s+#?(\d+)\s+merged$/i, (m) => ({ kind: 'pr-merged', pr: Number(m[1]) })],
  [/^pr\s+#?(\d+)\s+(?:ready|out of draft)$/i, (m) => ({ kind: 'pr-ready', pr: Number(m[1]) })],
  [/^ticket\s+([A-Za-z][A-Za-z0-9_]*-\d+)\s+done$/i, (m) => ({ kind: 'ticket-done', ticket: m[1].toUpperCase() })],
  [/^(?:repo\s+)?variable\s+([A-Za-z_][A-Za-z0-9_]*)\s+set$/i, (m) => ({ kind: 'variable-set', name: m[1] })],
  [/^run\s+#?(\d+)\s+completed$/i, (m) => ({ kind: 'run-completed', run: Number(m[1]) })],
  [/^none$/i, () => ({ kind: 'none' })],
];
export const CLEARS_WHEN_FORMS = 'pr <n> merged, pr <n> ready, ticket <KEY> done, variable <NAME> set, run <id> completed, or none';

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
    default: return 'none';
  }
}

// Does it hold now? {holds: bool, note?} or {error}. `note` is what the next worker or the report
// needs beside the answer: a finished run's conclusion, or an unfinished one's status. The readers do
// the reading and throw on any failure, so a check that could not run is never read as cleared:
//   pr(n) → {state, isDraft}   ticket(key) → the status category key   variable(name) → bool
//   run(id) → {status, conclusion}
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
      default: return { holds: false };
    }
  } catch (e) { return { error: String(e?.message ?? e).trim().split('\n').pop() || 'the check failed' }; }
}
