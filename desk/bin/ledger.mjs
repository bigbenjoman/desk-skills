// The promotion PR's ledger: one row per child of a feature-mode batch, kept in ONE comment on the
// promotion PR that only the autopilot writes, between two HTML comment markers, so the feature can be
// followed from GitHub. The PR body is never read or written for it: a body rewrite could overwrite an
// edit the person saved at the same moment, and GitHub has no conditional write.
import { createHash } from 'node:crypto';
import { isHeld } from './batch-state.mjs';

export const LEDGER_BEGIN = '<!-- desk-autopilot:ledger -->';
export const LEDGER_END = '<!-- desk-autopilot:ledger-end -->';

const cell = (v) => String(v).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

// A child's state as the ledger shows it. `prState(n)` is GitHub's state for PR n (OPEN, MERGED,
// CLOSED), or null when it could not be read, which reads as plain "done" rather than a guess.
export function ledgerState(t, prState = () => null) {
  if (isHeld(t)) return `held until ${String(t.held_by ?? '?').split('|').filter(Boolean).join(', ')} merge`;
  if (t.state !== 'done') return t.state;
  const s = t.result?.pr != null ? prState(t.result.pr) : null;
  return s === 'MERGED' ? 'merged' : s === 'CLOSED' ? 'closed without merging' : s === 'OPEN' ? 'in review' : 'done';
}

// The ledger comment's whole body, markers included: the queue's children in queue order, each with
// its key, state, PR link (`#n`, which GitHub links within the repo) and the model its worker ran on.
export function renderLedger(q, prState = () => null) {
  const rows = Object.values(q?.tickets ?? {}).map((t) =>
    `| ${cell(t.key)} | ${cell(ledgerState(t, prState))} | ${t.result?.pr != null ? `#${t.result.pr}` : '—'} | ${cell(t.model ?? '—')} |`);
  return [
    LEDGER_BEGIN,
    '### Children',
    '',
    '| Ticket | State | PR | Model |',
    '|---|---|---|---|',
    ...rows,
    '',
    '_Kept by the autopilot as children merge; edits to this comment are overwritten._',
    LEDGER_END,
  ].join('\n');
}

// The ledger comment among a PR's comments (`gh pr view --json comments`), or null. Only one the
// viewer wrote that opens with the begin marker counts, so a person quoting the ledger in a reply
// (`> <!-- …`), or anyone else's comment, is never taken for it. The oldest wins.
export function findLedgerComment(comments) {
  for (const c of comments ?? []) {
    if (!c?.viewerDidAuthor || typeof c.body !== 'string' || !c.body.trimStart().startsWith(LEDGER_BEGIN)) continue;
    const id = /#issuecomment-(\d+)$/.exec(c.url ?? '')?.[1];
    if (id) return { id, body: c.body };
  }
  return null;
}

// Brings PR n's ledger comment up to `ledger`: edited in place when it exists, created once when it
// does not, left alone when it already reads the same. `gh(args, input)` runs gh and returns
// {ok, out}. Returns {ok: true, action: 'created' | 'edited' | 'unchanged'} or {ok: false, why}.
export function syncLedger({ n, repo, ledger, gh }) {
  const lastLine = (s) => String(s ?? '').split('\n').filter(Boolean).pop() ?? 'no output';
  const read = gh(['pr', 'view', String(n), '--repo', repo, '--json', 'comments']);
  let comments = null;
  try { comments = read.ok ? JSON.parse(read.out).comments : null; } catch { /* reported below */ }
  if (!Array.isArray(comments)) return { ok: false, why: `its comments could not be read (${lastLine(read.out)})` };
  const found = findLedgerComment(comments);
  if (found && found.body.trim() === ledger.trim()) return { ok: true, action: 'unchanged' };
  if (found) {
    const wrote = gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${found.id}`, '--input', '-'], JSON.stringify({ body: ledger }));
    return wrote.ok ? { ok: true, action: 'edited' } : { ok: false, why: `its ledger comment could not be edited (${lastLine(wrote.out)})` };
  }
  const made = gh(['pr', 'comment', String(n), '--repo', repo, '--body-file', '-'], ledger);
  return made.ok ? { ok: true, action: 'created' } : { ok: false, why: `its ledger comment could not be created (${lastLine(made.out)})` };
}

// What the queue records of the last ledger written, so an unchanged one is not written again. The
// prefix keeps queue.mjs from reading an all-digit hash as a number.
export const ledgerHash = (ledger) => `sha256:${createHash('sha256').update(ledger).digest('hex').slice(0, 16)}`;
