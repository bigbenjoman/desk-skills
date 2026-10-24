// Stage 7's undraft rule, scripted, so a batch nobody is watching undrafts exactly what a session would
// (desk-autopilot SKILL.md, Stage 7, "Undraft only once the PR is done and reviewed with no findings").
// pass.mjs reads each done ticket's open draft PR and asks undraftCall what to do with it:
//
//   ready   every fact holds and config §3 pr-ready allows it: gh pr ready, then the merge driver
//           merges it once it is green
//   wait    nothing for anyone to do yet: checks still running
//   person  it stays draft until the person acts; `action` is what they do, `why` says why
//
// The facts, in order: the review verdict on the PR's current head reads as §4 Clean review verdict
// (none with §4 Local review command `none`, so reviewing is the person's call), the head has no merge
// conflict, the checks are green (gate.mjs's one definition), the screenshots are in the body (none
// the pass could not upload, no `_drag <file>_` placeholder left), and only then the grant: §3 pr-ready `yes`, or `ask` with the
// batch's Stage 3 approval (queue approved.undraft). A feature spine is never undrafted here:
// queue.mjs approve does that once the person has approved its specs.
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

// The latest verdict among `reviews` (gh pr view --json reviews: oldest first) that `handle` posted:
// on a public repo anyone can post a review, and only the person's own attests it.
export function latestVerdict(reviews, handle) {
  const own = (reviews ?? []).filter((r) => handle && r.author?.login?.toLowerCase() === handle.toLowerCase());
  return own.map((r) => parseVerdict(r.body)).filter(Boolean).pop() ?? null;
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

// t: the queue ticket. pr: { number, head, mergeState, mergeable, body, reviews, checks } (checks as
// pr_status keeps them). cfg: { spine, perm, approved, localReview, clean, handle, required, advisory, permKey }.
export function undraftCall(t, pr, cfg) {
  const n = pr.number;
  if (cfg.spine) return null;
  const person = (why, action = `undraft #${n} once that is settled`) => ({ call: 'person', why, action });
  if (/^none$/i.test(String(cfg.localReview ?? '').trim())) {
    return person('§4 Local review command is none, so there is no review verdict to read', `review #${n}, then undraft it`);
  }
  if (!Object.keys(pairs(cfg.clean)).length) {
    return person('§4 Clean review verdict is not set as key=value counts, so no verdict can be read as clean', 'set it with /desk-setup');
  }
  if (!cfg.handle) return person('§1 GitHub handle is not set, so no review verdict can be attested', 'set it with /desk-setup');
  if (pr.mergeState === 'DIRTY' || pr.mergeable === 'CONFLICTING') {
    return person(`it has a merge conflict with its base`, `resolve the conflict on #${n}; it then needs a fresh review`);
  }
  const gate = evaluateGate(pr.checks ?? [], { required: cfg.required ?? [], advisory: cfg.advisory ?? [] });
  if (gate.state === 'pending') return { call: 'wait', why: `checks still running (${gate.pending.join(', ')})` };
  if (gate.state !== 'pass') return person(`its checks are not green: ${gate.reasons.join('; ')}`, `fix or re-run the checks on #${n}`);
  const v = verdictAt(latestVerdict(pr.reviews, cfg.handle), pr.head, cfg.clean);
  if (!v.clean) return person(v.why, v.settle ? `settle the findings or gaps on #${n}` : `review #${n} at its head`);
  const unsent = t.images_uploaded === 'partial' || (t.images_reported === true && t.images_uploaded !== true);
  if (unsent || /_drag \S+_/.test(pr.body ?? '')) return person('its screenshots are not in the body yet (a `_drag <file>_` cell is left)', `upload the screenshots to #${n}`);
  if (cfg.perm === 'yes') return { call: 'ready', why: null, note: null };
  if (cfg.perm === 'ask' && cfg.approved) {
    return { call: 'ready', why: null, note: `- [${t.key}] undrafted #${n} at ${pr.head}: §3 ${cfg.permKey} is ask, batch approval given at Stage 3` };
  }
  return person(`it is clean and green, and config §3 ${cfg.permKey} is "${cfg.perm}"${cfg.perm === 'ask' ? ' with no batch approval' : ''}`, `undraft #${n}`);
}
