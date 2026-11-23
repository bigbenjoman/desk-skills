// A pending proposal on a ticket's priority, which a person promotes or rejects: a label one of §4
// Priority proposal labels matches (a pattern whose first group, when it has one, is the value
// proposed, e.g. `lp-proposed-(p[0-9])`), or a description line asking a person to promote it to a
// value or reject it ("promote to P1 … or reject within one working day"). ticket-facts.mjs records it on
// the triage record as `priority_proposal`; needs-you lists it as one item that holds no work.

// A description line asking a person to promote the ticket to a priority value, or reject that.
export const PROPOSAL_LINE = /\b(?:promote|raise|bump)\b[^\n]*?\b(P[0-9])\b[^\n]*?\breject/i;

const lineOf = (text) => String(text ?? '').split('\n').map((l) => l.trim()).find((l) => PROPOSAL_LINE.test(l)) ?? null;
const valueOf = (line) => (line ? PROPOSAL_LINE.exec(line)[1].toUpperCase() : null);

// The proposal on a ticket with `labels` and `description`, by `patterns` (§4 Priority proposal labels):
// { label, to, line }, `label` the label that carries it (null for one only its description asks),
// `to` the value proposed (null when neither the label nor a description line names one), and `line`
// the description line asking for it (null when there is none). null when there is no proposal.
export function priorityProposal({ labels = [], description = '' } = {}, patterns = []) {
  const line = lineOf(description);
  for (const p of patterns) {
    let re;
    try { re = new RegExp(`^(?:${p})$`, 'i'); } catch { continue; }
    for (const l of Array.isArray(labels) ? labels : []) {
      const m = re.exec(String(l).trim());
      if (m) return { label: String(l), to: m[1] ? m[1].toUpperCase() : valueOf(line), line };
    }
  }
  return line ? { label: null, to: valueOf(line), line } : null;
}
