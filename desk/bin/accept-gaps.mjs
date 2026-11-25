// A requirement gap only the person's own comment can accept: one a review tags as the person's call
// (desk-review phase-5-requirements.md) whose recommendation is to accept it. A PR comment or review
// from the §1 GitHub handle naming its criterion and accepting it is what settles it ("A gap the person
// accepted"), so no default, decider or worker applies it for them: the person is given a ready comment
// to post themselves, and the next pass that reads one from their handle sends the PR to a worker that
// records the acceptance in the review's verdict (fix-tries.mjs gapsFix).

// The tag a review puts on a gap only the person can settle.
export const personsCall = (gap) => /PERSON['’]S CALL/.test(String(gap ?? ''));
// Words that accept a gap. "acceptance" is not one: an acceptance test is a change a worker makes.
const ACCEPTS = /\baccept(?:s|ed|ing)?\b/i;

// The option a tagged gap ends with (`Recommended: <option>`), or null where it names none. Only the
// bold around the label and the emphasis around the whole option go: the option is kept as written.
export function recommendedOf(gap) {
  const s = String(gap ?? '');
  const at = [...s.matchAll(/\bRecommended:/gi)].at(-1);
  const option = !at ? '' : s.slice(at.index + at[0].length).replace(/^(\*\*|__)/, '').trim()
    .replace(/\s*\.$/, '').replace(/^(\*\*|__|[*_`])(.+)\1$/, '$2').trim();
  return option && !/^(none|no recommendation|n\/a)\b/i.test(option) ? option : null;
}

// Whether a gap a review lists is one only the person's own comment can accept.
export const acceptOnly = (gap) => personsCall(gap) && ACCEPTS.test(recommendedOf(gap) ?? '');

// The option a question marks as its pick: its `Recommended: <option>`, else the option written just
// before "(recommended)", as a park's question puts it.
const pickOf = (text) => recommendedOf(text) ?? /([^,;:?()]+)\(recommended\)/i.exec(String(text ?? ''))?.[1].trim() ?? null;
// Talk of accepting, "acceptance" included, but not an acceptance test or the acceptance criteria.
const ACCEPT_TALK = /\baccept(?:s|ed|ing|ance)?\b(?!\s+(?:tests?|specs?|criteri))/i;
// A pick that only says yes to what the question proposes, so the question's own words say what it does.
const BARE_YES = /^(?:yes|y|ok|okay|post(?: it)?|go(?: ahead)?|approve|proceed|confirm|do it)\b/i;
// Whether a question (an ask, a park, a pass line) puts such a gap's acceptance up as its pick: it names
// a review gap (or a criterion on a PR), and `chose` (by default, the text's own pick) accepts it, or
// only says yes to a question about accepting it ("Post the acceptance of gap AC2 for the person?" yes).
export function acceptCall(text, chose = pickOf(text)) {
  const s = String(text ?? ''), c = String(chose ?? '').trim();
  const gap = personsCall(s) || /\b(?:requirement|review) gaps?\b/i.test(s) || (/\bAC\s?\d+\b/i.test(s) && /\bPR\b|pull request|#\d+/i.test(s));
  return gap && (ACCEPTS.test(c) || (ACCEPT_TALK.test(s) && BARE_YES.test(c)));
}

// A tagged gap's parts: its criterion's label (`AC2`), the criterion it quotes, and what is open.
export function gapParts(gap) {
  const s = String(gap ?? '').replace(/^[\s>*-]*/, '').replace(/^PERSON['’]S CALL\s*[·:-]?\s*/, '');
  const ac = /\bAC\s?(\d+)\b/i.exec(s);
  const criterion = /"([^"]+)"|“([^”]+)”/.exec(s);
  const rest = s.replace(/\s*Recommended:.*$/is, '');
  const dash = rest.search(/\s[—–]\s/);
  return {
    ac: ac ? `AC${ac[1]}` : null,
    criterion: criterion ? (criterion[1] ?? criterion[2]) : null,
    open: (dash < 0 ? '' : rest.slice(dash + 3)).replace(/\s+/g, ' ').trim().replace(/[.;]$/, '') || null,
  };
}

// What a comment names a gap by: its label, else its criterion.
const nameOf = (p) => p.ac ?? (p.criterion ? `"${p.criterion}"` : null);

// The comment the person posts to accept `gaps`, naming each one's criterion.
export function acceptComment(gaps) {
  const lines = gaps.map(gapParts).map((p) => `- ${[p.ac, p.criterion ? `"${p.criterion}"` : null].filter(Boolean).join(': ') || 'the gap'}`);
  return [`I accept ${gaps.length === 1 ? 'this requirement gap as it stands' : 'these requirement gaps as they stand'} on this PR:`, ...lines].join('\n');
}

// That comment as one command the person runs: `gh pr comment`, its body single-quoted for the shell.
export const acceptCommand = (pr, repo, gaps) => `gh pr comment ${pr} --repo ${repo} --body '${acceptComment(gaps).replace(/'/g, `'\\''`)}'`;

// Everything the person needs to accept `gaps` on PR `pr` of `repo`, in one place: the PR, the criteria
// to name, the evidence already on it and the ready command. The evidence is what the review found for
// each gap and, where `evidence` (needs-you.mjs prEvidence) has them, the PR body's lines naming its
// criterion; then where on the PR the rest is.
export function acceptNeed(pr, repo, gaps, evidence = {}) {
  const url = `https://github.com/${repo}/pull/${pr}`;
  const each = gaps.map(gapParts).map((p) => {
    const lines = (p.ac && evidence[p.ac]) || [];
    return `${nameOf(p) ?? 'a gap'}${p.ac && p.criterion ? ` ("${p.criterion}")` : ''}${p.open ? `, where the review found: ${p.open}` : ''}${lines.length ? `, and the PR's evidence for it: ${lines.map((l) => `"${l}"`).join(', ')}` : ''}`;
  });
  return `${each.join('; ')}. Only your own comment can accept ${gaps.length === 1 ? 'it' : 'them'}, so desk applies no default; the rest of the evidence is in the PR body's Testing and Evidence sections on ${url} and its checks on ${url}/checks. ` +
    `Post this yourself: ${acceptCommand(pr, repo, gaps)}; the next pass then sends the PR to a worker that records it.`;
}

// A line that accepts, as the ready comment opens ("I accept these requirement gaps …"): "I accept",
// "Accepted" or "Accepting" starting a line. A worker's note that a gap is "left for the person to
// accept" is not one.
const ACCEPT_LINE = /^[\s>*-]*(?:I\s+(?:hereby\s+|also\s+)?accept|I(?:['’]m| am) accepting|Accept(?:ed|ing))\b/im;
// Words that withdraw or limit an acceptance: no script reads a comment holding one, so it stays the
// person's to settle. A criterion quoted in the comment is the ticket's words, not the person's.
const unquoted = (body) => body.replace(/"[^"\n]*"|“[^”\n]*”/g, '');
const REFUSES = /\b(?:not|never|no longer|cannot)\s+(?:\w+\s+){0,2}accept|n['’]t\s+(?:\w+\s+){0,2}accept|\breject|\b(?:but|except)\s+(?:not|for)\b|\bnot\s+(?:yet\b|AC\s?\d)/i;
// The person's acceptance of any of `gaps` on the PR: the newest comment or review by `handle` posted
// after `since` (the review that listed the gaps) with a line that accepts (ACCEPT_LINE), no words that
// refuse (REFUSES), and a gap's criterion named, by its label or its quoted text. `items`: the PR's comments and reviews as `gh pr view --json comments,reviews`
// gives them. -> { by, at, url, body, gaps } (the gaps it names), or null.
export function acceptanceOn(gaps, items, { handle, since = null }) {
  const me = String(handle ?? '').toLowerCase();
  if (!me || !gaps.length) return null;
  const after = Date.parse(since ?? '');
  const named = (body) => gaps.filter((g) => {
    const p = gapParts(g);
    return (p.ac && new RegExp(`\\b${p.ac.replace(/(\d+)$/, '\\s?$1')}\\b`, 'i').test(body)) || (p.criterion && body.includes(p.criterion));
  });
  let found = null;
  for (const x of items ?? []) {
    const at = x?.createdAt ?? x?.submittedAt ?? null;
    const body = String(x?.body ?? '');
    // desk's own reviews post under the same handle, and quote each gap's recommendation.
    if (String(x?.author?.login ?? '').toLowerCase() !== me || !ACCEPT_LINE.test(body) || REFUSES.test(unquoted(body)) || /^\s*<!-- desk-review/.test(body)) continue;
    if (!Number.isNaN(after) && !(Date.parse(at ?? '') > after)) continue;
    const these = named(body);
    if (!these.length || (found && Date.parse(found.at) >= Date.parse(at))) continue;
    found = { by: x.author.login, at, url: x.url ?? null, body, gaps: these };
  }
  return found;
}

// The person's acceptance as the answer a gaps fix carries (fix-tries.mjs gapsFix): their words, and
// where they are, so the worker's `accepted` entry links them. Which gaps the words accept is the
// worker's reading, as with any gaps call: desk claims none for them.
export const acceptedAnswer = (a) => `${a.body.trim()}\n\n(Posted on the PR by ${a.by} at ${a.at}${a.url ? `: ${a.url}` : ''}. Record as accepted only the gaps these words accept.)`;
