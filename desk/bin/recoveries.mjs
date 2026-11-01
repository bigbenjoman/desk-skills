// Routine recoveries: what a pass settles for a parked ticket by script, with no model and no person.
// pass.mjs runs them after the clears-when check and does the reading and writing; these are the rules.
//   - a park carrying a recommended option on a call the worker could have taken
//     (`AUTOPILOT_PARK_RECOMMENDS:`) is answered with that option and requeued, and the call logged;
//   - a park on a refused push or draft PR, whose worker printed its PR body, is finished: the branch
//     pushed as it stands and the draft opened from that body;
//   - a park whose branch adds nothing to the base while a merged PR names the ticket is recorded done
//     on that PR, and its worktree and branch are dropped.
import { parseDecision } from './decisions.mjs';
import { refusedStep, keyPattern } from './batch-state.mjs';

export const RECOMMENDS_MARK = 'AUTOPILOT_PARK_RECOMMENDS';

// Taken for a worker only where config §3 autopilot-judgement is `yes`, as the worker would.
const JUDGEMENT = ['product', 'design', 'wording'];

// The call a park recommends, from the marker's JSON (`{"options", "chose", "category"}`, its question
// the park's unless it names one): {ok, decision} as parseDecision gives it, or {ok: false, why}. An ask
// category is refused there, so it is never taken.
export function parkRecommends(raw, question) {
  let d;
  try { d = JSON.parse(String(raw ?? '').trim()); } catch { return { ok: false, why: 'not JSON' }; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, why: 'not a JSON object' };
  return parseDecision(JSON.stringify({ ...d, question: d.question ?? question }));
}

// May the pass take this call for the worker?
export const takeable = (decision, judgement) => !!decision && (!JUDGEMENT.includes(decision.category) || judgement === 'yes');

// The answer the next worker reads in its briefing.
export const recommendedAnswer = (d) => `${d.chose}. This was the option the last worker recommended when it parked on this ${d.category} call, `
  + 'which is a worker\'s to take (worker contract, Ask or take): the pass took it, not the person. Build it and carry on rather than park on it again.';

// A park saying its push or draft PR did not happen. A force-push, or a step no worker is ever
// allowed, is not one: a plain push cannot finish it.
const PUSH_OR_PR = /\b(?:git push|push(?:ed|ing|es)?|gh pr create|(?:open|creat)\w* (?:the |a |its )?(?:draft )?PR|(?:draft )?PR (?:was |is )?not (?:open|creat)\w*)\b/i;
const NOT_DONE = /\b(?:refus\w*|denied|den(?:y|ies)|not (?:allowed|granted|permitted|opened|created)|blocked|fail\w*|could(?:n't| not)|can(?:not|'t)|unable)\b/i;
export function pushPark(question) {
  const s = String(question ?? '');
  return PUSH_OR_PR.test(s) && NOT_DONE.test(s) && !refusedStep(s);
}

// The last `--title "<title>"` a worker wrote (the gh pr create it could not run), or null.
export function prTitleIn(text) {
  let title = null;
  for (const m of String(text ?? '').matchAll(/--title[= ](?:"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)')/g)) title = (m[1] ?? m[2]).replace(/\\(["\\])/g, '$1');
  return title?.trim() || null;
}

// The merged PR whose title or head branch names `key` exactly (`DS-39` is not `DS-397`), or null.
export function mergedNaming(key, prs) {
  const re = new RegExp(keyPattern(String(key)));
  return (Array.isArray(prs) ? prs : []).find((p) => re.test(String(p?.title ?? '')) || re.test(String(p?.headRefName ?? ''))) ?? null;
}
