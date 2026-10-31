// Pure helpers for a ticket's briefing ($DESK_STATE/briefings/<TICKET>.md), shared by pass.mjs and
// its tests. Reads nothing.

export const ANSWER_HEAD = '## Answer from the user';
export const SIBLING_HEAD = '## What sibling workers';

// Hard cap regardless of cause: the system prompt is contract + briefing and must stay well under
// MAX_ARG_STRLEN (128KB). Truncating costs a worker some context; exceeding the cap costs it its
// entire existence. A handoff session's briefing is cut the same way.
export const MAX_BRIEF = 60000;
export const BRIEF_CUT = '[briefing truncated to stay under the argv limit]';
export const capBriefing = (brief, max = MAX_BRIEF) => (brief.length > max ? `${brief.slice(0, max)}\n\n${BRIEF_CUT}` : brief);

// The sibling-notes block rides on every call a worker makes, so it is capped well under the
// briefing: the mandatory header (about 7.6KB) plus about 8KB of the newest entries.
export const MAX_NOTES = 16000;
const ENTRY = /^- \[/;

// Batch notes cut to `max`: every line that is not an entry (`- [<who>] …`, one per line) is the
// header and stays where it is; the oldest entries go first, and a last line names the full file.
export function capNotes(txt, path, max = MAX_NOTES) {
  if (txt.length <= max) return txt;
  const lines = txt.replace(/\n+$/, '').split('\n');
  const note = `\n[older notes cut to fit the briefing; every note is in ${path}: grep it]\n`;
  let size = lines.reduce((n, l) => n + l.length + 1, 0);
  const drop = new Set();
  for (const [i, l] of lines.entries()) {
    if (size + note.length <= max) break;
    if (ENTRY.test(l)) { drop.add(i); size -= l.length + 1; }
  }
  const kept = lines.filter((_, i) => !drop.has(i)).join('\n');
  return `${kept.slice(0, max - note.length - 1)}\n${note}`;
}

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
