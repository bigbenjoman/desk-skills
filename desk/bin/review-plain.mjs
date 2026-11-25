// How a review written as plain text, with no verdict marker, is read: the line that states its outcome
// as the §4 Clean review verdict phrase, and the lines that leave an item open, deferred or carried.
// undraft.mjs reads a desk review this way for the undraft and the merge driver, and fix-tries.mjs an
// outside reviewer's review body, so the two read the same text the same way.
const LEFT = '(?:defer(?:s|red|ring|rals?)?|carr(?:y|ies|ied|ying))';
const LEFT_OVER = new RegExp(`\\b${LEFT}\\b`, 'i');
// "nothing deferred or carried", "no items carried", "nothing to defer", "deferred: none", "carried 0",
// but not "deferred: no timeout on retries", which defers an item whose name starts with "no".
const NOTHING_LEFT = new RegExp(`\\b(?:no|nothing|none|zero|0)\\s+(?:(?:items?|findings?|issues?|is|are|was|were|has|have|been|to)\\s+){0,2}${LEFT}(?:\\s+(?:or|and|nor)\\s+${LEFT})?\\b|\\b${LEFT}\\s*(?:items?|findings?)?\\s*[:=]?\\s*(?:none|nothing|no|0)(?=\\s*(?:[.;,)]|$))`, 'gi');
// "1 finding", "2 P1s", "3 open issues": a count of items the review still holds open.
const OPEN = /\b[1-9]\d*\s+(?:(?:blocking|open|new|unresolved)\s+)?(?:p[0-3]s?|findings?|issues?|blockers?|problems?)\b/i;
export const plainLines = (body) => String(body ?? '').split(/\r?\n/).map((l) => l.replace(/^[\s>*#_-]+/, '').replace(/[*_`]/g, '').trim());

// The lines of a plain review that defer, carry or count an open item, cut to a readable length.
export function leftOver(body) {
  return plainLines(body).filter((l) => LEFT_OVER.test(l.replace(NOTHING_LEFT, '')) || OPEN.test(l))
    .map((l) => (l.length > 80 ? `${l.slice(0, 79)}…` : l));
}

// The line of `body` that opens with `phrase` as its outcome (the phrase, then `.`, `!` or the line's
// end), or undefined.
export function statesPhrase(body, phrase) {
  const c = String(phrase ?? '').trim().toLowerCase();
  return c ? plainLines(body).find((l) => l.toLowerCase().startsWith(c) && /^(?:[.!]|$)/.test(l.slice(c.length))) : undefined;
}

// Whether a line of `body` states that nothing is deferred or carried.
export const saysNothingLeft = (body) => plainLines(body).some((l) => l.replace(NOTHING_LEFT, '') !== l);
