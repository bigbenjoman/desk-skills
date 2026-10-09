// Pure helpers for a ticket's briefing ($DESK_STATE/briefings/<TICKET>.md), shared by pass.mjs and
// its tests. Reads nothing.

export const ANSWER_HEAD = '## Answer from the user';
export const SIBLING_HEAD = '## What sibling workers';

// Every "## Answer from the user" section in a briefing, wherever it sits, joined in order.
//
// answer.mjs APPENDS each answer to the end of the briefing, and after a spawn the briefing ends with
// the sibling-notes block. Slicing from the first answer heading up to the sibling-notes heading
// therefore kept only the answers given before the first spawn and silently dropped every answer
// recorded after it, so a requeued worker started without the binding instruction it was requeued
// for. Each section runs to the next answer heading or the next sibling-notes heading, never to
// end-of-file through the notes (that folded a copy of the notes in on every respawn and once grew a
// briefing past the 128KB argv cap).
export function collectAnswers(txt) {
  if (!txt || !txt.includes(ANSWER_HEAD)) return '';
  const sections = [];
  let i = txt.indexOf(ANSWER_HEAD);
  while (i >= 0) {
    const next = txt.indexOf(ANSWER_HEAD, i + ANSWER_HEAD.length);
    const notes = txt.indexOf(SIBLING_HEAD, i);
    const ends = [next, notes].filter((x) => x > i);
    const end = ends.length ? Math.min(...ends) : txt.length;
    const s = txt.slice(i, end).trimEnd();
    if (!sections.includes(s)) sections.push(s);
    i = next;
  }
  return sections.join('\n\n');
}
