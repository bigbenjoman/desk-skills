// The promotion PR's ledger: one row per child of a feature-mode batch, kept in the PR body between two
// HTML comment markers so the feature can be followed from GitHub. pass.mjs rewrites the region when
// it changes; everything the person wrote outside the markers is left exactly as it was.
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

// The region, markers included: the queue's children in queue order, each with its key, state, PR
// link (`#n`, which GitHub links within the repo) and the model its worker ran on.
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
    '_Rewritten by the autopilot as children merge; text outside this block is left alone._',
    LEDGER_END,
  ].join('\n');
}

// The body with its ledger region replaced by `ledger`, or the ledger appended after a blank line when
// the body has no complete region. The last begin marker is the one used, so a stray marker the person
// left above an appended region never swallows the text between them.
export function replaceLedger(body, ledger) {
  const text = body ?? '';
  const start = text.lastIndexOf(LEDGER_BEGIN);
  const end = start < 0 ? -1 : text.indexOf(LEDGER_END, start);
  if (end < 0) return text.trim() ? `${text.replace(/\s+$/, '')}\n\n${ledger}\n` : `${ledger}\n`;
  return `${text.slice(0, start)}${ledger}${text.slice(end + LEDGER_END.length)}`;
}

// What the queue records of the last ledger written, so an unchanged one is not written again. The
// prefix keeps queue.mjs from reading an all-digit hash as a number.
export const ledgerHash = (ledger) => `sha256:${createHash('sha256').update(ledger).digest('hex').slice(0, 16)}`;
