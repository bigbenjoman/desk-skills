// Routine recoveries: what a pass settles for a parked ticket by script, with no model and no person.
// pass.mjs runs them after the clears-when check and does the reading and writing; these are the rules.
//   - a park carrying a recommended option on a call the worker could have taken
//     (`AUTOPILOT_PARK_RECOMMENDS:`) is answered with that option and requeued, and the call logged;
//   - a park on a refused push or draft PR, whose worker printed its PR body, is finished: the branch
//     pushed as it stands and the draft opened from that body;
//   - a park whose branch adds nothing to the base while a merged PR names the ticket is recorded done
//     on that PR, and its worktree and branch are dropped.
import { execFileSync } from 'node:child_process';
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

// The answer the next worker reads in its briefing; `by` is who took it (the pass, or the decider).
export const recommendedAnswer = (d, by = 'the pass') => `${d.chose}. This was the option the last worker recommended when it parked on this ${d.category} call, `
  + `which is a worker's to take (worker contract, Ask or take): ${by} took it, not the person. Build it and carry on rather than park on it again.`;

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

// Whether a PR's title or head branch names `key` exactly (`DS-39` is not `DS-397`), as a predicate.
export function prNames(key) {
  const re = new RegExp(keyPattern(String(key)));
  return (p) => re.test(String(p?.title ?? '')) || re.test(String(p?.headRefName ?? ''));
}

// The merged PR whose title or head branch names `key`, or null.
export function mergedNaming(key, prs) {
  return (Array.isArray(prs) ? prs : []).find(prNames(key)) ?? null;
}

// The PRs in `state` on `repo` (owner/name; gh's own repo for `cwd` when null) whose branch names `key`,
// or with `inTitle` its title too. `search` narrows the list by GitHub's text search first, which reads
// titles and bodies but never a branch; without it every PR in that state is read, and a list `limit`
// long may be cut short, so it throws.
export function prsNaming(repo, state, key, { fields, inTitle = false, search = true, limit = 30, cwd } = {}) {
  const prs = JSON.parse(execFileSync('gh', ['pr', 'list', ...(repo ? ['--repo', repo] : []), '--state', state, ...(search ? ['--search', key] : []), '--limit', String(limit), '--json', `number,headRefName,${fields}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) }) || '[]');
  const list = Array.isArray(prs) ? prs : [];
  if (!search && list.length >= limit) throw new Error(`GitHub lists ${limit} or more ${state} PRs, so the list may be cut short`);
  const names = prNames(key);
  return list.filter((x) => Number.isFinite(Number(x?.number)) && names(inTitle ? x : { headRefName: x?.headRefName }));
}
