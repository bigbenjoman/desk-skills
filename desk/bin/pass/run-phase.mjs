// How pass.mjs runs a phase: it reads the phase's snapshot when the phase starts, so the snapshot
// shows every change the phases before it made, asks the phase's pure decision for its actions, and
// carries them out in order through `handlers`, keyed by action type.
//
// An action is `{ type, key?, ... }`. One whose type has no handler is not carried out: the report's
// failed line names it, and the rest still run. `skip(action, snapshot)` true leaves an action out
// without a line, for state that changed under the phase after its snapshot was read.
export function runPhase({ name, snapshot, decide, handlers, report, skip = () => false }) {
  const snap = snapshot();
  const actions = decide(snap);
  for (const a of actions) {
    if (skip(a, snap)) continue;
    const handle = Object.hasOwn(handlers, a.type) ? handlers[a.type] : null;
    if (typeof handle !== 'function') {
      report.failed.push(`${a.key ? `${a.key}: ` : ''}the ${name} step has no handler for its "${a.type}" action, so that action was not carried out`);
      continue;
    }
    handle(a, snap);
  }
  return actions;
}
