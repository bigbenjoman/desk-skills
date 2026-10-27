// Stage 7's undraft rule, scripted, so a batch nobody is watching undrafts exactly what a session would
// (desk-autopilot SKILL.md, Stage 7, "Undraft only once the PR is done and reviewed with no findings").
// pass.mjs reads each done ticket's open draft PR and asks undraftCall what to do with it:
//
//   ready   every fact holds and config §3 pr-ready allows it: gh pr ready, then the merge driver
//           merges it once it is green
//   wait    nothing for anyone to do yet: checks still running, or GitHub has not worked out whether
//           the head conflicts with its base (it reports UNKNOWN until it has, after every base move)
//   person  it stays draft until the person acts; `action` is what they do, `why` says why
//
// The facts, in order: the review verdict on the PR's current head reads as §4 Clean review verdict
// (none with §4 Local review command `none`, so reviewing is the person's call; a row of plain text such
// as `no findings` reads as plainVerdictAt says, and an unset row is the person's), the head has no merge
// conflict (GitHub says MERGEABLE), the checks are green (gate.mjs's one definition), the screenshots are in the body (none
// the pass could not upload, no `_drag <file>_` placeholder left), and only then the grant: §3 pr-ready `yes`, or `ask` with the
// batch's Stage 3 approval (queue approved.undraft). A feature spine is never undrafted here:
// queue.mjs approve does that once the person has approved its specs. A `ready` call carries the
// verdict it read, for the comment the PR gets on leaving draft (undraftComment).
import { evaluateGate } from './gate.mjs';

export const LOCAL_MARKER = '<!-- desk-review:local -->';
const VERDICT_LINE = /^<!--\s*desk-review:verdict\s+v=1\s+(.*?)\s*-->$/;

// key=value pairs, as a verdict marker or the §4 Clean review verdict row writes them.
export function pairs(text) {
  return Object.fromEntries([...String(text ?? '').matchAll(/([a-z0-9_]+)=(\S+)/gi)].map((m) => [m[1], m[2]]));
}

// A posted desk-review's verdict, or null: the body opens with the local marker and the verdict marker.
export function parseVerdict(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  if (lines[0]?.trim() !== LOCAL_MARKER) return null;
  const m = VERDICT_LINE.exec(lines[1]?.trim() ?? '');
  if (!m) return null;
  const v = pairs(m[1]);
  return /^[0-9a-f]{7,40}$/.test(v.sha ?? '') ? v : null;
}

// The reviews among `reviews` (gh pr view --json reviews: oldest first) that `handle` posted: on a
// public repo anyone can post a review, and only the person's own attests it.
function ownReviews(reviews, handle) {
  return (reviews ?? []).filter((r) => handle && r.author?.login?.toLowerCase() === handle.toLowerCase());
}

// The latest verdict among the reviews `handle` posted.
export function latestVerdict(reviews, handle) {
  return ownReviews(reviews, handle).map((r) => parseVerdict(r.body)).filter(Boolean).pop() ?? null;
}

// What the verdict says about this head: { clean, why, settle } (settle: the verdict is at the head,
// so what is left is its findings or gaps, not a review). Nothing deferred and no requirement gaps,
// whatever the §4 row lists.
export function verdictAt(v, head, clean) {
  if (!v) return { clean: false, why: 'no desk-review verdict is posted on it' };
  if (!head || !head.startsWith(v.sha)) return { clean: false, why: `its review verdict is for ${v.sha.slice(0, 9)}, not the head ${String(head ?? '?').slice(0, 9)}` };
  const want = { ...pairs(clean), deferred: '0', gaps: '0' };
  const off = Object.entries(want).filter(([k, x]) => v[k] !== x).map(([k]) => `${k}=${v[k] ?? '?'}`);
  if (off.length) return { clean: false, settle: true, why: `its review verdict at ${v.sha.slice(0, 9)} is not clean (${off.join(' ')})` };
  return { clean: true, why: null };
}

// A §4 Clean review verdict that is plain text (`no findings`, as the config template offers) names no
// counts. A desk-review verdict marker is then read against every count desk-review writes. A review
// with no marker is clean when it is the latest at the head, a line of it opens with the value as its
// outcome, it states that nothing is deferred or carried, and no line defers, carries or counts an item.
export const DESK_REVIEW_CLEAN = 'p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0';
const LEFT = '(?:defer(?:s|red|ring|rals?)?|carr(?:y|ies|ied|ying))';
const LEFT_OVER = new RegExp(`\\b${LEFT}\\b`, 'i');
// "nothing deferred or carried", "no items carried", "nothing to defer", "deferred: none", "carried 0",
// but not "deferred: no timeout on retries", which defers an item whose name starts with "no".
const NOTHING_LEFT = new RegExp(`\\b(?:no|nothing|none|zero|0)\\s+(?:(?:items?|findings?|issues?|is|are|was|were|has|have|been|to)\\s+){0,2}${LEFT}(?:\\s+(?:or|and|nor)\\s+${LEFT})?\\b|\\b${LEFT}\\s*(?:items?|findings?)?\\s*[:=]?\\s*(?:none|nothing|no|0)(?=\\s*(?:[.;,)]|$))`, 'gi');
// "1 finding", "2 P1s", "3 open issues": a count of items the review still holds open.
const OPEN = /\b[1-9]\d*\s+(?:(?:blocking|open|new|unresolved)\s+)?(?:p[0-3]s?|findings?|issues?|blockers?|problems?)\b/i;
const plainLines = (body) => String(body ?? '').split(/\r?\n/).map((l) => l.replace(/^[\s>*#_-]+/, '').replace(/[*_`]/g, '').trim());

// The lines of a plain review that defer, carry or count an open item, cut to a readable length.
export function leftOver(body) {
  return plainLines(body).filter((l) => LEFT_OVER.test(l.replace(NOTHING_LEFT, '')) || OPEN.test(l))
    .map((l) => (l.length > 80 ? `${l.slice(0, 79)}…` : l));
}

// What the latest of `handle`'s reviews says about this head, under a plain-text §4 row (`clean`):
// { clean, why, settle, verdict }. A review with an empty body (GitHub records one for a reply to an
// inline comment) says nothing and is passed over.
export function plainVerdictAt(reviews, handle, head, clean) {
  const r = ownReviews(reviews, handle).filter((x) => String(x.body ?? '').trim()).pop();
  if (!r) return { clean: false, why: `no review stating "${clean}" is posted on it` };
  const v = parseVerdict(r.body);
  if (v) return { ...verdictAt(v, head, DESK_REVIEW_CLEAN), verdict: v };
  const at = r.commit?.oid ?? '';
  if (!at || !head || !head.startsWith(at)) return { clean: false, why: `its latest review is for ${at ? at.slice(0, 9) : 'an unknown commit'}, not the head ${String(head ?? '?').slice(0, 9)}` };
  const c = clean.toLowerCase();
  const stated = plainLines(r.body).find((l) => l.toLowerCase().startsWith(c) && /^(?:[.!]|$)/.test(l.slice(c.length)));
  if (!stated) return { clean: false, settle: true, why: `its latest review, at ${at.slice(0, 9)}, does not open a line with "${clean}" as its outcome` };
  const left = leftOver(r.body);
  if (left.length) return { clean: false, settle: true, why: `its review at ${at.slice(0, 9)} states "${clean}" but leaves items open, deferred or carried: ${left.map((l) => `"${l}"`).join('; ')}` };
  if (!plainLines(r.body).some((l) => l.replace(NOTHING_LEFT, '') !== l)) return { clean: false, settle: true, why: `its review at ${at.slice(0, 9)} states "${clean}" but not that nothing is deferred or carried` };
  return { clean: true, why: null, verdict: stated };
}

// The comment on a PR the pass took out of draft: why, and the verdict it read, quoted (a plain
// review's line stating the §4 value, as a string).
export function undraftComment(verdict, head, clean) {
  const line = typeof verdict === 'string' ? verdict : Object.entries(verdict ?? {}).map(([k, x]) => `${k}=${x}`).join(' ');
  const what = typeof verdict === 'string' ? 'review' : 'desk-review verdict';
  return `Out of draft: the ${what} posted on this head (\`${String(head ?? '').slice(0, 12)}\`) is clean under §4 Clean review verdict (\`${clean}\`).\n\n> \`${line}\``;
}

// t: the queue ticket. pr: { number, head, mergeState, mergeable, body, reviews, checks } (checks as
// pr_status keeps them). cfg: { spine, perm, approved, localReview, clean, handle, required, advisory, permKey }.
export function undraftCall(t, pr, cfg) {
  const n = pr.number;
  if (cfg.spine) return null;
  const person = (why, action = `undraft #${n} once that is settled`) => ({ call: 'person', why, action });
  if (/^none$/i.test(String(cfg.localReview ?? '').trim())) {
    return person('§4 Local review command is none, so there is no review verdict to read', `review #${n}, then undraft it`);
  }
  const clean = String(cfg.clean ?? '').trim();
  if (!clean || /^(todo|none)\b/i.test(clean)) {
    return person('§4 Clean review verdict is not set, so no review can be read as clean', 'set it with /desk-setup');
  }
  const plain = !Object.keys(pairs(clean)).length;
  if (!cfg.handle) return person('§1 GitHub handle is not set, so no review verdict can be attested', 'set it with /desk-setup');
  if (pr.mergeState === 'DIRTY' || pr.mergeable === 'CONFLICTING') {
    return person(`it has a merge conflict with its base`, `resolve the conflict on #${n}; it then needs a fresh review`);
  }
  if (pr.mergeable !== 'MERGEABLE') return { call: 'wait', why: `GitHub has not yet worked out whether it conflicts with its base (${pr.mergeable ?? 'no answer'})` };
  const gate = evaluateGate(pr.checks ?? [], { required: cfg.required ?? [], advisory: cfg.advisory ?? [] });
  if (gate.state === 'pending') return { call: 'wait', why: `checks still running (${gate.pending.join(', ')})` };
  if (gate.state !== 'pass') return person(`its checks are not green: ${gate.reasons.join('; ')}`, `fix or re-run the checks on #${n}`);
  const verdict = plain ? null : latestVerdict(pr.reviews, cfg.handle);
  const v = plain ? plainVerdictAt(pr.reviews, cfg.handle, pr.head, clean) : verdictAt(verdict, pr.head, clean);
  if (!v.clean) return person(v.why, v.settle ? `settle the findings or gaps on #${n}` : `review #${n} at its head`);
  const unsent = t.images_uploaded === 'partial' || (t.images_reported === true && t.images_uploaded !== true);
  if (unsent || /_drag \S+_/.test(pr.body ?? '')) return person('its screenshots are not in the body yet (a `_drag <file>_` cell is left)', `upload the screenshots to #${n}`);
  const read = plain ? v.verdict : verdict;
  if (cfg.perm === 'yes') return { call: 'ready', why: null, note: null, verdict: read };
  if (cfg.perm === 'ask' && cfg.approved) {
    return { call: 'ready', why: null, verdict: read, note: `- [${t.key}] undrafted #${n} at ${pr.head}: §3 ${cfg.permKey} is ask, batch approval given at Stage 3` };
  }
  return person(`it is clean and green, and config §3 ${cfg.permKey} is "${cfg.perm}"${cfg.perm === 'ask' ? ' with no batch approval' : ''}`, `undraft #${n}`);
}
