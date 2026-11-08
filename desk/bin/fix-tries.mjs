// A ready batch PR the merge driver cannot merge goes back to a worker on its own branch, at most
// FIX_TRIES_MAX times: one still red after the driver's two reruns, one in conflict with its base, or
// one held for review feedback (feedbackFix); a ready PR whose review at its head is not clean goes to
// a review fix, as a draft's does. So does a draft whose posted review at its head found a P0 or a P1, or under §3 autopilot-judgement
// yes a requirement gap (reviewFix), FIX_TRIES_MAX review fix tries of its own within FIX_TRIES_TOTAL
// tries in all (a try that cleared what it quoted not counted, up to REVIEW_TRIES_CEILING), and one
// whose review gaps the person
// ruled on through desk-needs-you (gapsFix), or that the person sent back with an instruction
// (instructionFix), outside them. A draft whose required check is red
// (draftChecksFix) goes to a fix worker, and one with no review verdict readable at its head
// (reviewTry), or a ready PR whose §4 State check reading its verdict is red, or that the merge driver
// holds for want of a clean verdict at its head (verdictTry), to a review
// worker, both within the same tries, and so does a draft in conflict with
// its base that §3 lets a worker resolve (conflictFix), or whose §4 Check builds build failed at a
// head behind its base (syncFix). A draft whose screenshots were never taken goes
// to a capture worker, once (captureTry). A ready PR whose red check asks an approval for protected files,
// or reads no verdict it accepts at the head, goes to a worker that may clear it first (gateTry).
// pass.mjs reads each done ticket's PR (pr_status) and asks fixCall what to do with it:
//
//   requeue  send the ticket back for a fix worker; `fix` is the try (its number, the head it is for,
//            and what it is fixing), kept on the ticket as `fix` and appended to `fix_tries`
//   stuck    no worker can fix it, so it goes to the person; `why` says what is left
//   null     nothing to do: green, still running, reruns still to come, or waived as a known flaky check
//
// A check §4 Checks workers can't fix or §4 Check builds names, or one failing at a step §4 Pre-merge
// steps names, is never sent to a worker: on its own it is stuck with what clears it, and beside a
// check a worker can fix it is named in the brief as not theirs.
import { evaluateGate, stateFailing, approvalFiles, staleVerdict, stepFailed } from './gate.mjs';

export const FIX_TRIES_MAX = 2;
// merge-driver.sh's own cap and gap: reruns per check per head, and the seconds between them.
export const RERUNS_MAX = 2;
export const RERUN_COOLDOWN_S = 720;

// §4 Checks workers can't fix items: `<check>: <what fixes it>`, split on the first `: `, so the
// command may hold one. An item with no check or no command is an error, never a guess.
export function parseOperatorChecks(items) {
  const checks = [];
  const errors = [];
  for (const x of items || []) {
    if (!x || /^none$/i.test(x.trim())) continue;
    const i = x.indexOf(': ');
    const name = i < 0 ? '' : x.slice(0, i).trim();
    const command = i < 0 ? '' : x.slice(i + 2).trim();
    if (!name || !command) errors.push(`\`${x}\``);
    else checks.push({ name, command });
  }
  return { checks, errors };
}

export const runUrl = (repo, id) => (id ? `https://github.com/${repo}/actions/runs/${id}` : null);
export const tries = (n) => `${n} fix ${n === 1 ? 'try' : 'tries'}`;
// A fix try already made for this head: one whose worker finished without moving it. A review try
// (kind `rereview`), a capture try (`capture`) and a protected-files try (`protected`, which moves it only
// when a change is not needed) move no head by design, so they do not count here.
const OWN_HEAD = new Set(['rereview', 'capture', 'protected']);
const fixedAt = (done, head) => done.some((x) => x.head === head && !OWN_HEAD.has(x.kind));

// The steps the job for `check` failed at, by name and in order, read from `gh run view <run> --json
// jobs`. A payload of any other shape names none.
export function failedSteps(view, check) {
  const job = (Array.isArray(view?.jobs) ? view.jobs : []).find((j) => j?.name === check);
  if (!Array.isArray(job?.steps)) return [];
  return job.steps.filter((s) => typeof s?.name === 'string' && stepFailed(s)).map((s) => s.name);
}
// A failing check's failed steps, by ctx.steps(check) where the pass reads them from its run.
const stepsOf = (f, ctx) => (f.runId && ctx.steps ? ctx.steps(f) ?? [] : []);

// A gate's failing checks, one per name, split into those a worker fixes and those a person clears
// ({ name, command }): one §4 Checks workers can't fix or ctx.builds (§4 Check builds) names, or one
// that is, or failed at a step that is, a §4 Pre-merge steps item.
function splitFailing(failing, ctx) {
  const all = [...new Map(failing.map((f) => [f.name, f])).values()];
  const op = new Map([...(ctx.builds ?? []), ...(ctx.operator ?? [])].map((o) => [o.name, o.command]));
  const pre = ctx.premerge ?? [];
  const mine = [], notMine = [];
  for (const f of all) {
    if (op.has(f.name)) { notMine.push({ name: f.name, runId: f.runId, command: op.get(f.name) }); continue; }
    const steps = pre.length && !pre.some((p) => p.name === f.name) ? stepsOf(f, ctx) : [];
    const p = pre.find((x) => x.name === f.name || steps.includes(x.name));
    if (p) notMine.push({ name: f.name, runId: f.runId, ...(p.name !== f.name ? { step: p.name } : {}), command: p.command });
    else mine.push(f);
  }
  return { mine, notMine };
}

// A stuck reason's text: `lead` and the checks a worker could not fix, each with the step it failed at
// where its run reports one, then each check a person clears with what clears it.
export function stuckWhy({ lead = null, checks }) {
  const label = (c) => `${c.name}${c.step ? ` (failed step: ${c.step})` : ''}`;
  const mine = checks.filter((c) => !c.command), theirs = checks.filter((c) => c.command);
  return [mine.length ? `${lead ?? 'red'}: ${mine.map(label).join(', ')}` : '', ...theirs.map((c) => `${label(c)} · ${c.command}`)].filter(Boolean).join('; ');
}
// A PR stuck on red checks, keeping each check by name so desk-q can drop one that has since gone green.
function checksStuck(lead, mine, notMine, ctx) {
  const checks = [...mine, ...notMine].map((f) => {
    const step = f.step ?? stepsOf(f, ctx)[0];
    return { name: f.name, ...(step ? { step } : {}), ...(f.command ? { command: f.command } : {}) };
  });
  return { call: 'stuck', why: stuckWhy({ lead, checks }), lead, checks };
}
const operatorStuck = (notMine, ctx) => checksStuck(null, [], notMine, ctx);
// A red-checks fix: each check a worker fixes with its run, and those it leaves to a person.
const checksFix = (mine, notMine, repo) => ({ kind: 'checks', what: `red: ${mine.map((f) => f.name).join(', ')}`, checks: mine.map((f) => ({ name: f.name, url: runUrl(repo, f.runId) })), not_mine: notMine.map(({ name, command }) => ({ name, command })) });
const stillRed = (done, mine, notMine, ctx) => checksStuck(`still red after ${tries(done.length)}`, mine, notMine, ctx);
// The tries that count against FIX_TRIES_MAX: all but the review tries a merge from the base earned,
// the capture try (captureTry), which is the PR's own one, and the protected-files tries (gateTry), which
// have their own.
const ownCount = (x) => x.extra || x.kind === 'capture' || x.kind === 'protected';
export const triesMade = (done) => (done ?? []).filter((x) => !ownCount(x)).length;
// No try is left: FIX_TRIES_MAX made, or one already made at this head (triedHere).
const spent = (done, triedHere) => triesMade(done) >= FIX_TRIES_MAX || triedHere;
const nextTry = (done, pr, head, fix) => ({ call: 'requeue', fix: { try: triesMade(done) + 1, of: FIX_TRIES_MAX, pr, head, ...fix } });
// No try is left at this head: FIX_TRIES_MAX made, or a fix try made at it whose worker finished
// without moving it. Base conflict fix tries (base-fix.mjs) count the same way.
export const triesSpent = (done, head) => spent(done, fixedAt(done, head));
// A review fix has FIX_TRIES_MAX of its own, counted over review fix tries only, so the conflict,
// red-check and re-review tries before it leave it its own, within FIX_TRIES_TOTAL tries of every kind
// that count but conflict. Every other kind stops at FIX_TRIES_MAX tries in all, so a review fix always
// has one; a conflict has its own FIX_TRIES_MAX on top (conflictTriesMade), so its tries are not counted.
// A review fix try that recorded what it quoted (`findings`, `gaps`) and whose findings all cleared,
// none of them still in the review at the head, counts against neither: it moved the PR forward. Only
// REVIEW_TRIES_CEILING bounds those, so a loop where every fix makes a new finding still ends.
const FIX_TRIES_TOTAL = FIX_TRIES_MAX + 1;
export const REVIEW_TRIES_CEILING = 4;
const isReviewTry = (x) => !x.extra && x.kind === 'review';
const quoted = (x) => Boolean(x.findings?.length || x.gaps?.length);
const reviewTriesMade = (done) => (done ?? []).filter(isReviewTry).length;
// The review fix tries left: below the ceiling, and, over the tries not known to have cleared what
// they quoted, its own and no more than the overall cap leaves.
function reviewTriesLeft(done) {
  const counted = (done ?? []).filter((x) => !(isReviewTry(x) && quoted(x)));
  return Math.min(REVIEW_TRIES_CEILING - reviewTriesMade(done), FIX_TRIES_MAX - reviewTriesMade(counted),
    FIX_TRIES_TOTAL - triesMade(counted.filter((x) => x.kind !== 'conflict')));
}
// A finding or gap as compared across heads: its first file:line, the path whole, so one holding
// `[id]` or `(shop)` is not another file's, and its text with the markup, `F1 ·` label, severity,
// that file:line, the seat in brackets after it and spacing taken out, so a finding that moved lines
// still matches.
const AT = /[\w./\-[\]()]+:\d+/;
const firstAt = (text) => AT.exec(text)?.[0].replace(/^\((?![^)]*\))/, '') ?? null;
const plain = (text) => String(text).replace(/[`*]/g, '').replace(AT, '').replace(/^[\s>-]*(F\d+\s*·\s*)?(P[0-3]\b[:\s·—-]*)?(\([^)]*\)\s*)?/, '').replace(/\s+/g, ' ').trim().toLowerCase();
// The findings and gaps at the head that an earlier review fix try quoted, so survived the try aimed
// at them: the same file:line as the last try that quoted any (an older try's lines have since moved),
// or the same text as any try's.
function survivors(done, findings, gaps) {
  const before = (done ?? []).filter(isReviewTry);
  const atBefore = new Set((before.filter(quoted).at(-1)?.findings ?? []).map((f) => firstAt(f.text)).filter(Boolean));
  const textBefore = new Set(before.flatMap((x) => [...(x.findings ?? []).map((f) => f.text), ...(x.gaps ?? [])].map(plain).filter(Boolean)));
  return [...findings.filter((f) => atBefore.has(firstAt(f.text)) || textBefore.has(plain(f.text))).map((f) => `${f.sev}: ${f.text}`),
    ...gaps.filter((g) => textBefore.has(plain(g)))];
}
// The tries that count, by kind in the order first made, as `1 conflict, 1 rereview, 1 review`.
function triesByKind(done) {
  const n = new Map();
  for (const x of done ?? []) if (!ownCount(x)) n.set(x.kind ?? 'fix', (n.get(x.kind ?? 'fix') ?? 0) + 1);
  return [...n].map(([k, c]) => `${c} ${k}`).join(', ');
}

// A conflict with the base, out of draft (fixCall) or in it (conflictFix), and its stuck reason. A
// conflict has FIX_TRIES_MAX tries of its own, counted over conflict tries only and one per head, so
// tries of other kinds (a check no worker can clear, a review) never leave it none. The reason ends
// with what the last try reported (its AUTOPILOT_DONE line, kept by pass.mjs as result.summary) when
// that try was a conflict try whose worker has finished.
const conflictTry = (base, files, draft) => ({ kind: 'conflict', ...(draft ? { draft: true } : {}), what: `${draft ? 'draft ' : ''}conflicts with ${base}`, base, files: files ?? null });
const conflictTries = (done) => (done ?? []).filter((x) => !x.extra && x.kind === 'conflict');
export const conflictTriesMade = (done) => conflictTries(done).length;
const conflictSpent = (done, head) => conflictTriesMade(done) >= FIX_TRIES_MAX || conflictTries(done).some((x) => x.head === head);
const nextConflictTry = (done, pr, head, fix) => ({ call: 'requeue', fix: { try: conflictTriesMade(done) + 1, of: FIX_TRIES_MAX, pr, head, ...fix } });
// What the ticket's last try of that kind reported, once its worker has finished; else null.
export const lastTrySaid = (t, kind = 'conflict') => (t?.fix?.kind === kind && t.fix.finished && t.result?.summary) || null;
const lastSaid = (t, kind = 'conflict') => (lastTrySaid(t, kind) ? `; the last try said: ${lastTrySaid(t, kind)}` : '');
const stillInConflict = (t, done, base, files) => `still in conflict with ${base} after ${tries(conflictTriesMade(done))}${files?.length ? `: ${files.join(', ')}` : ''}${lastSaid(t)}`;

// t: the queue ticket. s: its pr_status. ctx: { repo, base, required, advisory, stateChecks (§4 State
// checks, parsed: never sent to a fix worker nor waited on for reruns), operator, builds and
// premerge (§4 Checks workers can't fix, Check builds and Pre-merge steps, parsed), steps(check) ->
// the step names its run failed at, reruns(name) -> reruns tried at s.head, cooledDown (the last rerun
// has had its gap to report), waived(names) -> the driver merges past these as known flaky checks,
// conflictFiles() -> [file] | null }.
export function fixCall(t, s, ctx) {
  if (s?.state !== 'OPEN' || s.isDraft !== false || !s.head) return null;
  const done = t.fix_tries ?? [];
  const conflict = s.mergeable === 'CONFLICTING' || s.mergeState === 'DIRTY';
  let fix, split;
  if (conflict) {
    fix = conflictTry(ctx.base, ctx.conflictFiles?.(), false);
  } else {
    const gate = evaluateGate(s.checks ?? [], { required: ctx.required ?? [], advisory: ctx.advisory ?? [] });
    if (gate.state !== 'fail' || gate.pending.length) return null;
    // A §4 State check is no worker's code to fix and the driver never reruns it: verdictTry and the
    // driver's approval note take it.
    const state = stateFailing(gate.failing, ctx.stateChecks);
    split = splitFailing(gate.failing.filter((f) => !state.some((x) => x.name === f.name)), ctx);
    const { mine, notMine } = split;
    if (!mine.length && notMine.length) return operatorStuck(notMine, ctx);
    if (!mine.length) {
      // Red only on state checks. One reading the verdict or an approval has its route; one reading other
      // state (a title) nothing reruns or fixes, so it is the person's, unless one of those may be its cause.
      const bare = [...new Set(state.filter((x) => !x.kind).map((x) => `"${x.name}"`))];
      return bare.length && !state.some((x) => x.kind)
        ? { call: 'stuck', why: `red on ${bare.join(', ')}, a §4 State check: it reads the PR's state, not its code, so no rerun or fix try turns it green; a person clears what it reads` }
        : null;
    }
    if (ctx.waived?.(mine.map((f) => f.name))) return null;
    if (!ctx.cooledDown || mine.some((f) => (ctx.reruns?.(f.name) ?? 0) < RERUNS_MAX)) return null;
    fix = checksFix(mine, notMine, ctx.repo);
  }
  if (conflict) return conflictSpent(done, s.head) ? { call: 'stuck', why: stillInConflict(t, done, ctx.base) } : nextConflictTry(done, s.pr, s.head, fix);
  if (spent(done, fixedAt(done, s.head))) return stillRed(done, split.mine, split.notMine, ctx);
  return nextTry(done, s.pr, s.head, fix);
}

// A line of a posted desk-review body that opens a section: a `###` heading, an all-caps one as the
// terminal report writes it (`REQUIREMENT GAPS (2)`), or a bold-only line that cites no file:line.
const isHeading = (text) => /^#{1,6}\s/.test(text) || /^[A-Z][A-Z ]{3,}(\(|$)/.test(text) ||
  (/^\*\*[^*]+\*\*$/.test(text) && !/[\w./-]+:\d+/.test(text));

// A verdict's P0 and P1 counts, as `1 P0, 2 P1`; '' when it has neither.
export function reviewCounts(v) {
  return ['p0', 'p1'].filter((k) => Number(v?.[k]) > 0).map((k) => `${Number(v[k])} ${k.toUpperCase()}`).join(', ');
}

// The findings of these severities (P0 and P1 unless `sevs` says) a posted desk-review body lists, one
// line each with its file:line, as { sev, text }. A finding sits under a `P0 (n)` or `P1 (n)` heading, or
// opens with its own severity; a heading of anything else (REQUIREMENT GAPS, a `###` section) ends that run. A line
// opening with an em dash, or a bullet indented deeper than the finding's own line, continues the
// finding above it, and a line saying `None` (`None.`, `P1: None`) is no finding.
export function reviewFindings(body, sevs = ['P0', 'P1']) {
  const found = [];
  // open: the indent of the finding a deeper bullet continues, null when none is open.
  let sev = null, open = null;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const text = line.trim();
    const own = /^[#>*_\s-]*(?:F\d+\s*·\s*)?(P[0-3])\b/.exec(line);
    if (own) { sev = own[1]; open = null; } else if (isHeading(text)) { sev = null; open = null; }
    if (!sevs.includes(sev)) continue;
    if (text.startsWith('—') && found.length) { found[found.length - 1].text += ` ${text}`; continue; }
    const indent = /^\s*/.exec(line)[0].length;
    if (open != null && indent > open && /^[-*]\s/.test(text)) { found[found.length - 1].text += ` ${text}`; continue; }
    if (/^[#>*_\s-]*(?:F\d+\s*·\s*)?(?:P[0-3]\b[^A-Za-z]*)?none\b(?=[\s*_]*(?:[.:;,)—-]|$))/i.test(text)) continue;
    if (/[\w./-]+:\d+/.test(text)) { found.push({ sev, text }); open = indent; }
  }
  return found;
}

// The P0 and P1 findings among a review's inline comments ({ path, line, body }), as { sev, text, at }
// with the text opening `at`, its `path:line`, as a body finding does. A comment's severity opens its
// body (`**P1** …`); one with none, or a P2, is not a finding here.
export function inlineFindings(comments) {
  return (comments ?? []).flatMap((c) => {
    const [first = '', ...rest] = String(c?.body ?? '').trim().split(/\r?\n/);
    const own = /^[#>*_\s-]*(P[0-3])\b[*_:\s—-]*/.exec(first);
    if (!own || (own[1] !== 'P0' && own[1] !== 'P1') || !c.path) return [];
    const said = [first.slice(own[0].length), ...rest].map((l) => l.trim()).filter(Boolean).join(' ');
    const at = c.line != null ? `${c.path}:${c.line}` : c.path;
    return [{ sev: own[1], text: `${at} ${said}`.trim(), at }];
  });
}

// A body finding's text names `path:line` as its own: the same path and line, not a longer one, and
// no `path:line` before it. A later one is evidence it cites (the original it duplicates), which may
// be another finding's own. The path is matched whole, so one holding `[id]` or `(shop)` still is.
const owns = (text, at) => {
  const m = new RegExp(`(^|[^\\w./-])${at.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`).exec(text);
  return m != null && m.index + m[1].length <= (/[\w./-]+:\d+/.exec(text)?.index ?? Infinity);
};

// The requirement gaps a posted desk-review body lists, one string each: the items under a heading
// naming requirement gaps (`### Requirement gaps`, or `REQUIREMENT GAPS (n)` as the terminal report
// writes it), up to the next heading. A line indented deeper than the item above continues it, and an
// `UNVERIFIED CODE CLAIM` or a `None` is no gap.
export function reviewGaps(body) {
  const gaps = [];
  let inGaps = false;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    if (isHeading(text)) { inGaps = /requirement gaps?\b/i.test(text); continue; }
    if (!inGaps) continue;
    const item = text.replace(/^[-*]\s+/, '');
    if (/^\s{2,}/.test(line) && gaps.length) gaps[gaps.length - 1] += ` ${item}`;
    else gaps.push(item);
  }
  return gaps.filter((g) => !/UNVERIFIED CODE CLAIM/.test(g) && !/^none\b/i.test(g));
}

const gapCount = (n) => `${n} ${n === 1 ? 'gap' : 'gaps'}`;

// A draft PR whose posted review at its head is not clean goes back to a fix worker when the review
// found a P0 or a P1: one try per head, FIX_TRIES_MAX review fix tries per PR, and none once the PR
// has made FIX_TRIES_TOTAL tries of every kind, counting no try that cleared what it quoted
// (reviewTriesLeft), and never more than REVIEW_TRIES_CEILING. A finding or gap an earlier try quoted
// that is still at the head survived its fix, and goes to the person, named. Stuck, its reason names
// the tries made by kind. Where
// config §3 autopilot-judgement is yes (opts.judgement), so do its requirement gaps: closing one is a
// call the worker may make and record, or park when it needs a product or another person's ruling.
// A P2 blocks a merge unless carried, so a review with nothing worse sends its P2s the same way, and the
// fix's next round carries one where fixing it would mean another. One deferred on purpose is the
// person's. So is a review that counts a finding but lists none with its file:line in its body or its
// inline comments, or counts only gaps and lists none under its gaps heading (null).
// An inline finding the body also lists at the same file:line is quoted once, from the body.
// review: { pr, head, verdict, body, comments } (comments as inlineFindings reads them, or a function
// returning them, called only once a try is left; null when they could not be read, so only the body
// counts).
export function reviewFix(t, review, opts = {}) {
  const v = review.verdict;
  const p2s = !reviewCounts(v) && Number(v?.p2) > 0 && !(Number(v?.deferred) > 0) ? Number(v.p2) : 0;
  const counts = reviewCounts(v) || (p2s ? `${p2s} P2` : '');
  const sevs = p2s ? ['P2'] : undefined;
  const gapsOpen = opts.judgement === 'yes' ? Number(review.verdict?.gaps) || 0 : 0;
  const what = [counts, gapsOpen ? gapCount(gapsOpen) : ''].filter(Boolean).join(', ');
  if (!what || !review.head) return null;
  const done = t.fix_tries ?? [];
  const made = reviewTriesMade(done);
  const room = reviewTriesLeft(done);
  const byKind = triesByKind(done);
  const after = `review not clean after ${tries(triesMade(done))}${byKind ? ` (${byKind})` : ''}: ${what}`;
  if (room <= 0 || fixedAt(done, review.head)) {
    // The review at this head is the last try's own, so its findings and gaps say what is still open.
    // Only the body's: its inline comments are not read once no try is left.
    const left = [...(counts ? reviewFindings(review.body, sevs).map((x) => `${x.sev}: ${x.text}`) : []), ...(gapsOpen ? reviewGaps(review.body) : [])];
    const lead = made >= REVIEW_TRIES_CEILING && !fixedAt(done, review.head)
      ? after.replace(/: /, ', the most review fix tries a PR may make: ') : after;
    return { call: 'stuck', why: `${lead}${left.length ? ` — ${left.join('; ')}` : ''}` };
  }
  const listed = counts ? reviewFindings(review.body, sevs) : [];
  // A P2 is never posted inline.
  const comments = !counts || p2s ? null : typeof review.comments === 'function' ? review.comments() : review.comments;
  const inline = inlineFindings(comments).filter((x) => !listed.some((b) => owns(b.text, x.at)));
  const findings = [...listed, ...inline.map(({ sev, text }) => ({ sev, text }))];
  const gaps = gapsOpen ? reviewGaps(review.body) : [];
  if (counts ? !findings.length : !gaps.length) return null;
  const survived = survivors(done, findings, gaps);
  if (survived.length) return { call: 'stuck', why: `${after} — still open after the fix try that quoted it: ${survived.join('; ')}` };
  const verdict = Object.entries(review.verdict).map(([k, x]) => `${k}=${x}`).join(' ');
  return { call: 'requeue', fix: { try: made + 1, of: made + room, pr: review.pr, head: review.head, kind: 'review', what: `review not clean: ${what}`, verdict, findings, ...(gaps.length ? { gaps } : {}) } };
}

// The person's call on a draft's review gaps (desk-needs-you), as the fix it sends back: not one of
// the FIX_TRIES_MAX tries, which are the pass's own.
export const gapsFix = ({ pr, head, answer }) => ({ kind: 'gaps', pr, head: head ?? null, what: 'review gaps: your call', answer });

// The person's instruction on an open PR (desk-needs-you `resume`), as the fix it sends back: like a
// gaps call, not one of the pass's tries; numbered as the last of the tries made, for the views that
// show a try's number. `ready` is a PR out of draft, which its worker leaves out of draft and the merge
// driver holds (merge-driver.sh instruction_held) until this fix is finished.
export function instructionFix(t, { pr, head, ready, answer }) {
  const n = triesMade(t.fix_tries) + 1;
  return { try: n, of: n, kind: 'instruction', pr, head: head ?? null, ready: ready === true, what: 'your instruction', answer };
}
// A fix that carries out what the person said, rather than repairing what the pass found.
export const personCall = (f) => f?.kind === 'gaps' || f?.kind === 'instruction';

// The findings a review stuck reason quotes (reviewFix's `stuck` why, `P0: <text>; P2: <text>`), as
// { sev, text }; [] for a reason that is not a review's, or quotes none.
export function stuckFindings(why) {
  const m = /^review not clean\b.*? — (?:still open after the fix try that quoted it: )?(.+)$/.exec(String(why ?? ''));
  return (m?.[1].split(/; (?=P[0-2]: )/) ?? []).map((x) => /^(P[0-2]): (.+)$/.exec(x)).filter(Boolean).map(([, sev, text]) => ({ sev, text }));
}
// A review stuck reason's findings as the review fix the person sends back for one more try
// (desk-needs-you `fix`), marked `person`: not one of the pass's tries, so the review of its new head
// that still lists one goes back to the person; numbered as the last of the tries made, for the views
// that show a try's number. null for a reason that is not a review's, or quotes no finding.
export function personReviewFix(t, { pr, head, why }) {
  const findings = stuckFindings(why);
  const n = triesMade(t.fix_tries) + 1;
  return findings.length ? { try: n, of: n, kind: 'review', person: true, pr, head: head ?? null, what: 'review not clean: sent back by the person for one more try', findings } : null;
}

// A ready PR the merge driver holds for review feedback under §3 merge-feedback-first (threads left
// unresolved that no clean desk-review verdict settles, or changes requested) goes back to a fix
// worker under the same tries as fixCall: one per head, FIX_TRIES_MAX per PR. The try quotes each
// thread, so the pass can reply on and resolve each one once the worker has pushed past this head
// (resolvable). Out of tries, or tried at this head already, it is the person's, naming each thread.
// threads: [{ id, text }], text as review-threads.mjs threadLine names it.
const threadCount = (n) => `${n} unresolved thread${n === 1 ? '' : 's'}`;
export function feedbackFix(t, { pr, head, decision, threads }) {
  const left = threads ?? [];
  const changes = decision === 'CHANGES_REQUESTED';
  if (!head || (!left.length && !changes)) return null;
  const what = [left.length ? threadCount(left.length) : '', changes ? 'changes requested' : ''].filter(Boolean).join(', ');
  const done = t.fix_tries ?? [];
  // Changes requested with every thread resolved is the reviewer's to clear: no worker can.
  if (!left.length && done.some((x) => x.kind === 'feedback')) {
    return { call: 'stuck', why: `review feedback still open after ${tries(triesMade(done))}: changes requested, which only the reviewer clears, by reviewing it again` };
  }
  if (spent(done, fixedAt(done, head))) {
    const named = left.map((x) => x.text).join('; ');
    return { call: 'stuck', why: `review feedback still open after ${tries(triesMade(done))}: ${what}${named ? ` — ${named}` : ''}` };
  }
  return nextTry(done, pr, head, { kind: 'feedback', what: `review feedback: ${what}`, decision: decision ?? null, threads: left.map(({ id, text }) => ({ id, text })) });
}
// The threads a finished feedback try quoted that the pass replies on and resolves: its worker
// finished, did not park, and pushed past the try's head. [] otherwise.
export function resolvable(t, head) {
  const f = t.fix;
  if (f?.kind !== 'feedback' || !f.finished || t.state !== 'done' || !head || head === f.head) return [];
  return (f.threads ?? []).filter((x) => x.id && !(f.resolved ?? []).includes(x.id));
}
// The reply the pass posts on a thread a feedback try worked, before resolving it.
export const feedbackReply = (f, head) => `Worked by desk's fix try ${f.try} of ${f.of} at ${String(head).slice(0, 12)}: the worker's reply, naming this thread, is on the PR's conversation, and a fresh desk-review is posted on that head. Reopen this thread if it still stands.`;

// A draft with no review verdict the pass can read at its head (undraft.mjs `review`: none posted, one
// it cannot read, or one for an older head) goes to a review worker, which reviews the head and posts
// it. Its try is one of the FIX_TRIES_MAX, once per head: still unread after one, it is the person's,
// with `why` saying what the pass read last. A head a merge from the base last moved, since the last
// try's head (baseMerge(lastHead), asked only when no review try was made at this head), changed with
// no worker behind it, so its try is an extra one (`extra`), outside FIX_TRIES_MAX. `targeted`
// (undraft.mjs reviewScope) narrows the try to what an older clean review that did not carry still
// needs read at the head; the review posted says what it carried from that one.
export function reviewTry(t, { pr, head, why, base = null, baseMerge = null, targeted = null }) {
  if (!head) return null;
  const done = t.fix_tries ?? [];
  const triedHere = done.some((x) => x.head === head && x.kind === 'rereview');
  const last = done.at(-1)?.head;
  const narrow = targeted ? { targeted } : {};
  if (!triedHere && last && last !== head && baseMerge?.(last)) {
    return { call: 'requeue', fix: { try: triesMade(done), of: FIX_TRIES_MAX, extra: true, pr, head, kind: 'rereview', what: `review its head, moved by a merge from ${base ?? 'its base'}: ${why}`, ...narrow } };
  }
  if (spent(done, triedHere)) {
    return { call: 'stuck', why: `no review verdict readable at its head after ${tries(done.length)}: ${why}` };
  }
  return nextTry(done, pr, head, { kind: 'rereview', what: `review its head: ${why}`, ...narrow });
}

// A ready PR whose §4 State check of kind `verdict` is red, with no review at its head that reads as
// not clean (that is reviewFix's), has a verdict the check rejects: none, one for an older head, or one
// in a form the gate does not accept. The driver never reruns it, so it goes to a review worker under
// reviewTry's tries, out of draft. Where no such check runs, the merge driver holds a green PR the same
// way, on what ctx.atHead() reads (review-threads.mjs readVerdict, null where nothing waits on a verdict):
// no verdict or a stale one is a review worker's too, with `held` for its brief, and a review at the
// head that is not clean and that no fix worker took (reviewFix: a deferred item, findings it does not
// list) the person's.
// s: its pr_status; ctx: { required, advisory, stateChecks, settled (a review at the head reads as not
// clean), atHead, waived(names) (the driver waives these red checks), base, baseMerge }.
export function verdictTry(t, s, ctx) {
  if (s?.state !== 'OPEN' || s.isDraft !== false || !s.head) return null;
  const gate = evaluateGate(s.checks ?? [], { required: ctx.required ?? [], advisory: ctx.advisory ?? [] });
  if (gate.pending.length) return null;
  const red = stateFailing(gate.failing, ctx.stateChecks).filter((f) => f.kind === 'verdict');
  const asReady = (c) => (c?.call === 'requeue' ? { ...c, fix: { ...c.fix, ready: true } } : c);
  if (red.length) {
    if (ctx.settled) return null;
    const names = [...new Set(red.map((f) => `"${f.name}"`))].join(', ');
    return asReady(reviewTry(t, { pr: s.pr, head: s.head, why: `its ${names} check is red, and a rerun reads the same verdict` }));
  }
  // The driver reaches its hold only on a head it would otherwise merge: green, or red only on a waiver.
  const failing = [...new Set(gate.failing.map((f) => f.name))];
  if (gate.state !== 'pass' && !(failing.length && ctx.waived?.(failing))) return null;
  const at = ctx.atHead?.();
  if (!at || at.clean) return null;
  if (at.settle || at.person) return { call: 'stuck', why: at.why };
  const c = asReady(reviewTry(t, { pr: s.pr, head: s.head, why: at.why, base: ctx.base, baseMerge: ctx.baseMerge, targeted: at.targeted }));
  return c?.call === 'requeue' ? { ...c, fix: { ...c.fix, held: true } } : c;
}

// A ready PR held by a red check whose error lines (pr_status checks[].errors, which the pass reads)
// name what a change on its branch can clear goes to a worker before it goes to the person. Protected
// files the check asks an approval for go to a protected-files try: its worker drops each change the
// ticket's criteria do not need, or reports it needed, which leaves the approval to the person. One goes
// per head, only for a file no earlier one judged, and at most FIX_TRIES_MAX per PR, outside the fix
// tries' count. A review verdict the check cannot read at the head (none, a stale one, an old format)
// goes to a review try under reviewTry's tries, unless a §4 State check of kind verdict is the one red
// (verdictTry takes that) or another red check a worker can fix is (fixCall takes that). null where
// neither applies, so fixCall decides as before.
// s: its pr_status; ctx: fixCall's, with base and baseMerge.
export function gateTry(t, s, ctx) {
  if (s?.state !== 'OPEN' || s.isDraft !== false || !s.head) return null;
  if (s.mergeable === 'CONFLICTING' || s.mergeState === 'DIRTY') return null;
  const gate = evaluateGate(s.checks ?? [], { required: ctx.required ?? [], advisory: ctx.advisory ?? [] });
  if (gate.state !== 'fail' || gate.pending.length) return null;
  const failing = new Set(gate.failing.map((f) => f.name));
  const lines = (s.checks ?? []).filter((c) => failing.has(c.name))
    .flatMap((c) => (c.errors ?? []).map((line) => ({ name: c.name, line })));
  const done = t.fix_tries ?? [];
  const before = done.filter((x) => x.kind === 'protected');
  const judged = new Set(before.flatMap((x) => x.paths ?? []));
  const asks = lines.map((x) => ({ ...x, prot: approvalFiles(x.line) })).filter((x) => x.prot?.files.length);
  const paths = [...new Set(asks.flatMap((x) => x.prot.files))];
  if (paths.some((p) => !judged.has(p)) && before.length < FIX_TRIES_MAX && !before.some((x) => x.head === s.head)) {
    const more = Math.max(0, ...asks.map((x) => x.prot.more));
    const checks = [...new Set(asks.map((x) => x.name))];
    return { call: 'requeue', fix: { try: before.length + 1, of: FIX_TRIES_MAX, pr: s.pr, head: s.head, kind: 'protected', ready: true,
      what: `${checks.map((c) => `"${c}"`).join(', ')} asks an approval for protected files: ${paths.join(', ')}${more ? ` and ${more} more` : ''}`, checks, paths, more } };
  }
  const verdictChecks = new Set((ctx.stateChecks ?? []).filter((x) => x.kind === 'verdict').map((x) => x.name));
  const stale = lines.filter((x) => !verdictChecks.has(x.name) && staleVerdict(x.line));
  if (!stale.length) return null;
  // Another red check a worker can fix is fixCall's: its fix worker reviews the head it pushes, so a
  // review try first would only spend one of that fix's tries.
  const staleNames = new Set(stale.map((x) => x.name));
  const state = stateFailing(gate.failing, ctx.stateChecks);
  const rest = gate.failing.filter((f) => !staleNames.has(f.name) && !state.some((x) => x.name === f.name));
  if (splitFailing(rest, ctx).mine.length) return null;
  const c = reviewTry(t, { pr: s.pr, head: s.head, why: `its "${stale[0].name}" check says: ${stale[0].line}`, base: ctx.base, baseMerge: ctx.baseMerge });
  return c?.call === 'requeue' ? { ...c, fix: { ...c.fix, ready: true } } : null;
}

// A draft whose required checks are red (undraft.mjs `checks`) goes to a fix worker, with each failing
// check's name and run, under the same tries as fixCall. There are no driver reruns to wait for: the
// merge driver reruns only a PR out of draft. ctx: { repo, operator, premerge (parsed), steps }, as
// fixCall's.
export function draftChecksFix(t, { pr, head, failing }, ctx) {
  if (!head) return null;
  const { mine, notMine } = splitFailing(failing ?? [], ctx);
  if (!mine.length) return notMine.length ? operatorStuck(notMine, ctx) : null;
  const done = t.fix_tries ?? [];
  const fix = { ...checksFix(mine, notMine, ctx.repo), draft: true };
  return spent(done, fixedAt(done, head)) ? stillRed(done, mine, notMine, ctx) : nextTry(done, pr, head, fix);
}

// A draft PR in conflict with its base, which undraft.mjs sends on (`conflict`) under §3
// pr-conflict-unreviewed or -reviewed, goes back to a fix worker under the same conflict tries as
// fixCall's (one per head, FIX_TRIES_MAX per PR). draft: { pr, head, base, files } (files: [file] | null).
export function conflictFix(t, { pr, head, base, files }) {
  if (!head) return null;
  const done = t.fix_tries ?? [];
  return conflictSpent(done, head) ? { call: 'stuck', why: stillInConflict(t, done, base, files) } : nextConflictTry(done, pr, head, conflictTry(base, files, true));
}

// A draft whose §4 Check builds build failed at a head behind its base (undraft.mjs `sync`) goes to a
// fix worker that merges the base, fixes what the merge breaks and pushes, under the same tries as
// conflictFix; the pass then builds the new head. `why` is the build's failure as undraft.mjs gave it.
// Stuck, the reason names what the last sync try said.
export function syncFix(t, { pr, head, base, why }) {
  if (!head) return null;
  const done = t.fix_tries ?? [];
  if (spent(done, fixedAt(done, head))) return { call: 'stuck', why: `still behind ${base} with its check build failing after ${tries(done.length)}: ${why}${lastSaid(t, 'sync')}` };
  return nextTry(done, pr, head, { kind: 'sync', draft: true, what: `draft behind ${base}, its check build failed`, base, build: why });
}
// What the last sync try said, once its worker finished: for a check build that still fails at the
// head it left.
export const syncSaid = (t) => (t.fix?.kind === 'sync' && t.fix.finished
  ? `, after sync try ${t.fix.try} of ${t.fix.of} merged ${t.fix.base}${t.result?.summary ? `, which said: ${t.result.summary}` : ''}` : '');

// A draft whose body has `_drag <file>_` cells for screenshots nobody took (undraft.mjs `capture`) goes
// to a capture worker, which takes them on the PR's branch for the pass to upload. One capture try per
// PR, outside FIX_TRIES_MAX: cells still missing after it are the person's, with the screens and what
// its worker said about them (its AUTOPILOT_DONE `said=`, kept whole by pass.mjs as result.done.said).
// draft: { pr, head, files } (files: the cells' file names with no screenshot).
export function captureTry(t, { pr, head, files }) {
  if (!files?.length) return null;
  const done = t.fix_tries ?? [];
  if (done.some((x) => x.kind === 'capture')) {
    const summary = String(t.result?.summary ?? '');
    const last = t.fix?.kind === 'capture' && t.fix.finished ? String(t.result?.done?.said ||/\bsaid=(.*)$/.exec(summary)?.[1]?.trim() || summary) : '';
    const said = last ? `; the capture try said: ${last}` : '';
    return { call: 'stuck', why: `${files.length} screenshot(s) still not taken after a capture try: ${files.join(', ')}${said}` };
  }
  return { call: 'requeue', fix: { try: 1, of: 1, pr, head: head ?? null, kind: 'capture', what: `take ${files.length} screenshot(s) never taken: ${files.join(', ')}`, files } };
}

// The fix worker's briefing section, while its try is open.
export function fixBrief(t) {
  const f = t.fix;
  if (!f || f.finished) return '';
  if (f.kind === 'capture') {
    return [`## Capture try: PR #${f.pr}`, '',
      `Your PR #${f.pr} is a draft on this branch, and its body still has \`_drag <file>_\` cells for screenshots nobody took${f.head ? ` (head ${String(f.head).slice(0, 12)})` : ''}, so it cannot leave draft:`, '',
      ...f.files.map((x) => `- ${x}`), '',
      'Take each one of the screen its row in the PR body describes, as desk-ticket Stage 5 says, and save it under exactly that file name in your screenshot directory. ' +
      'Then print AUTOPILOT_IMAGES with that directory: the pass uploads them and swaps them into the body. Change no code and do not edit the PR body.', '',
      'A screen you cannot take is named in your AUTOPILOT_DONE line with why (its said= field). This is the PR\'s one capture try: a screenshot still missing after it goes to the person with what you said.', ''].join('\n');
  }
  if (f.kind === 'gaps') {
    return [`## Your call on PR #${f.pr}'s review gaps`, '',
      `Your PR #${f.pr} is a draft on this branch, and the desk-review posted on its head${f.head ? ` ${String(f.head).slice(0, 12)}` : ''} left requirement gaps. The person has ruled on them (also posted on the PR):`, '',
      ...String(f.answer ?? '').split('\n').map((l) => `> ${l}`), '', 'Carry out that call on each gap, and nothing else.', ''].join('\n');
  }
  if (f.kind === 'instruction') {
    return [`## The person's instruction on PR #${f.pr}`, '',
      `Your PR #${f.pr} is ${f.ready ? 'open and out of draft' : 'a draft'} on this branch${f.head ? ` (head ${String(f.head).slice(0, 12)})` : ''}, and the person sent it back to you with this instruction:`, '',
      ...String(f.answer ?? '').split('\n').map((l) => `> ${l}`), '', 'Carry out that instruction, and nothing else.', ''].join('\n');
  }
  if (f.kind === 'protected') {
    return [`## Protected files try ${f.try} of ${f.of}: PR #${f.pr}`, '',
      `Your PR #${f.pr} is open and out of draft on this branch, and its ${f.checks.map((c) => `"${c}"`).join(', ')} check asks a person's approval at its head ${String(f.head).slice(0, 12)} because the PR changes protected files:`, '',
      ...f.paths.map((p) => `- ${p}`), ...(f.more ? [`- and ${f.more} more the check counts but does not name: its run log (gh run view --log-failed) or the gate's protected-path rule names them`] : []), '',
      "Read the ticket's acceptance criteria (desk-jira get, or its ticket file) against your diff to each one. A change to it the criteria do not need (a convenience script, a stray edit, a tidy-up) comes out: restore the file, or the lines, to the base's version. " +
      'A change the criteria need stays as it is: never move it to another path, rename it or reword it to get past the rule.', '',
      'If you dropped nothing, change nothing and push nothing: the approval goes to the person, with your reasons. Each file is judged once: one still in the diff after this try is the person\'s to approve.', ''].join('\n');
  }
  if (f.kind === 'rereview') {
    return [f.extra ? `## Review try for a merge from the base: PR #${f.pr}` : `## Review try ${f.try} of ${f.of}: PR #${f.pr}`, '',
      f.held
        ? `Your PR #${f.pr} is open and out of draft on this branch, and the merge driver will not merge it without a clean review at its head ${String(f.head).slice(0, 12)}: ${f.what.replace(/^review its head[^:]*: /, '')}.`
        : f.ready
        ? `Your PR #${f.pr} is open and out of draft on this branch, and the merge driver will not rerun the check that reads its review at its head ${String(f.head).slice(0, 12)}: ${f.what.replace(/^review its head[^:]*: /, '')}.`
        : `Your PR #${f.pr} is a draft on this branch, and the pass reads no review verdict at its head ${String(f.head).slice(0, 12)}: ${f.what.replace(/^review its head[^:]*: /, '')}.`,
      'Review that head with desk-review and post the review on the PR (desk-review Phase 7), so its verdict marker is on the head. Change no code in this try: a P0, a P1, a listed P2 or a gap the review finds goes to a fix worker at the next pass.', '',
      ...targetedBrief(f.targeted),
      f.extra ? `A merge from the base moved this head, so this try is not one of the ${f.of} fix tries. A PR with no verdict readable at its head after it goes to the person.`
        : `This is try ${f.try} of ${f.of}. A PR with no verdict readable at its head after this try goes to the person.`, ''].join('\n');
  }
  const lines = [f.person ? `## Fix try the person sent: PR #${f.pr}` : `## Fix try ${f.try} of ${f.of}: PR #${f.pr}`, ''];
  if (f.kind === 'conflict') {
    lines.push(f.draft
      ? `Your PR #${f.pr} is a draft on this branch, and it conflicts with ${f.base}, so the pass cannot take it out of draft. Its review was for the old head, so the new head needs one of its own.`
      : `Your PR #${f.pr} is open and out of draft on this branch, and it conflicts with ${f.base}, so the merge driver cannot merge it.`);
    lines.push(f.files?.length ? `Conflicting files: ${f.files.join(', ')}.` : `The conflicting files were not listed: \`git merge-tree --write-tree --name-only origin/${f.base} HEAD\` names them.`);
    lines.push(`A conflicting file a generator writes is not resolved by hand where §4 Codegen is set: take ${f.base}'s version of it (\`git checkout --theirs <file>\` during the merge), run §4 Codegen (\`desk-env cmds codegen-cmd\`) once the other conflicts are resolved, and commit what it regenerates with the merge.`,
      `Where the branch is far behind ${f.base} and one merge leaves too much in conflict, merge ${f.base} in steps (an older commit of it first, then the next), pushing once the last merge is done.`);
  } else if (f.kind === 'sync') {
    lines.push(`Your PR #${f.pr} is a draft on this branch, and its head ${String(f.head).slice(0, 12)} is behind ${f.base}. Its check build failed there: ${f.build}`, '',
      `Merge origin/${f.base} into your branch (git merge, never a rebase or a force push). A merge git reports clean can still break the branch: two migrations with the same parent, a renamed symbol, a changed signature or fixture. ` +
      'Run the repo\'s checks on the merged head (desk-ticket Stage 4), and fix each break the merge brought in, in a commit of its own after the merge commit, before you push.',
      'Do not run the check build yourself: once you push, the pass runs it at your new head and re-runs the check.');
  } else if (f.kind === 'feedback') {
    lines.push(`Your PR #${f.pr} is open and out of draft on this branch, and the merge driver will not merge it while its review feedback is open (§3 merge-feedback-first)${f.decision === 'CHANGES_REQUESTED' ? ': a reviewer has requested changes' : ''}.`);
    if (f.threads?.length) {
      lines.push('Its unresolved review threads:', '');
      for (const x of f.threads) lines.push(`- ${x.text}`);
      lines.push('');
    }
    lines.push('Read each thread in full (gh pr view --json reviews,comments, or desk-gh read for the thread), and validate it with desk-review-response before changing any code: fix what is right, and for what is not, say why.',
      'Answer every thread with gh pr comment, naming it by its file:line and quoting its first line, saying what you changed in which commit or why the code stands. Do not resolve threads yourself: once you have pushed past this head and finished, the pass replies on each thread quoted here and resolves it.',
      'A thread you cannot fix, or one that needs a product call or another person\'s ruling, is not yours: park (AUTOPILOT_PARK) naming the thread and exactly what blocks it.');
  } else if (f.kind === 'review') {
    lines.push(`Your PR #${f.pr} is ${f.ready ? 'open and out of draft' : 'a draft'} on this branch, and the desk-review posted on its head ${String(f.head).slice(0, 12)} is not clean${f.verdict ? ` (\`${f.verdict}\`)` : ''}.`);
    if (f.findings?.length) {
      lines.push(`Fix each ${findingKinds(f.findings)} finding it lists${f.findings.some((x) => x.sev === 'P2') ? ', or carry one in your next review where fixing it would mean another round (worker contract Stage 4)' : ''}:`, '');
      for (const x of f.findings) lines.push(`- ${x.sev}: ${x.text}`);
      lines.push('');
    }
    if (f.gaps?.length) {
      lines.push('Close each requirement gap it lists. Config §3 autopilot-judgement is yes, so an engineering call a gap needs is yours to make: change the code so the criterion holds, or, where the code should stand as it is, say why. ' +
        'Log each call with an AUTOPILOT_DECISION line, list it under Decisions taken in the PR body (desk-pr), and comment it on the ticket (worker contract Stage 8). ' +
        'A call that leaves the code as it is still needs a new head for the fresh review to read it: commit it on its own with git commit --allow-empty, the call and its reason as the message. ' +
        'A gap that needs a product ruling or another person\'s, as the worker contract\'s Ask or take sorts it (an ask category such as a fact only the person holds, a call you have no recommendation for, or one a person has already ruled on the ticket), is not yours: park with that question (AUTOPILOT_PARK).', '');
      for (const g of f.gaps) lines.push(`- Gap: ${g}`);
      lines.push('');
    }
    if (!f.findings?.some((x) => x.sev === 'P2')) lines.push('Its P2 findings are not part of this try.');
  } else {
    lines.push(f.draft
      ? `Your PR #${f.pr} is a draft on this branch, and these required checks are red at ${String(f.head).slice(0, 12)}, so it cannot leave draft:`
      : `Your PR #${f.pr} is open and out of draft on this branch, and these checks are still red at ${String(f.head).slice(0, 12)} after the merge driver's two reruns:`, '');
    for (const c of f.checks) lines.push(`- ${c.name}: ${c.url ?? 'no run URL reported'}`);
    for (const c of f.not_mine ?? []) lines.push(`- ${c.name} is red too, and it is not yours to fix: ${c.command}. A person runs that; leave it red.`);
    if (f.draft) lines.push('', 'Read each failing run\'s log with gh run view <run id> --log-failed (the id is the number in its URL).');
  }
  if (f.kind === 'review') {
    lines.push('', `${f.person ? "desk's own fix tries were spent, and the person sent this one more." : `This is try ${f.try} of ${f.of}.`} A finding${f.gaps?.length ? ' or gap' : ''} quoted here that the review of your new head still lists goes to the person.`, '');
    return lines.join('\n');
  }
  const left = f.kind === 'feedback' ? 'holding unresolved review feedback' : f.kind === 'conflict' && f.draft ? 'in conflict'
    : f.kind === 'sync' ? `behind ${f.base} with its check build failing` : f.draft ? 'red' : 'red or in conflict';
  lines.push('', `This is try ${f.try} of ${f.of}. A PR still ${left} after try ${f.of} goes to the person.`, '');
  return lines.join('\n');
}

// A review try's narrowing (reviewTry `targeted`): the files the base moved and the PR's code that uses
// them, read as desk-review's targeted round; nothing for a whole review.
function targetedBrief(x) {
  if (!x) return [];
  return ['### Targeted: review only what the base changed under the review', '',
    `The desk-review posted on ${String(x.from).slice(0, 12)} was clean, and the PR's own diff is unchanged since. The base range \`${x.range}\` changed files that review rests on, and no lockfile, manifest or configuration file. ` +
      "So run desk-review's targeted round (its references/targeted.md) on these and nothing else, and carry the rest of that review:", '',
    `- Changed by the base: ${x.files.join(', ')}`,
    `- The PR's code that uses them: ${x.users?.length ? x.users.join(', ') : 'none of its changed files names one'}`, ''];
}

const findingKinds = (findings) => (findings?.some((x) => x.sev === 'P2') ? 'P2' : 'P0 and P1');

// The prompt a fix worker starts with (spawn-worker.sh's AUTOPILOT_TASK).
export function fixTask(t) {
  const f = t.fix;
  if (f.kind === 'rereview') {
    return `Follow the autopilot worker contract in your system prompt exactly. Your ticket is $TICKET. Your worktree is $WT. Your dev-server port is $PORT. ` +
      `Your task is ${f.extra ? 'a review try after a merge from the base' : `review try ${f.try} of ${f.of}`} on PR #${f.pr}, already open on your branch: the "Review try" section of your briefing says why. ` +
      `Review its head with desk-review${f.targeted ? ', in its targeted round on only what the briefing\'s "Targeted" section names,' : ''} and post that review on the PR (desk-review Phase 7), and change no code. ` +
      `Open no new PR, leave the PR ${f.ready ? 'out of' : 'in'} draft, and leave the ticket's Jira as it is. End with AUTOPILOT_DONE: pr=${f.pr} jira=<its status>.`;
  }
  if (f.kind === 'protected') {
    return `Follow the autopilot worker contract in your system prompt exactly. Your ticket is $TICKET. Your worktree is $WT. Your dev-server port is $PORT. ` +
      `Your task is protected files try ${f.try} of ${f.of} on PR #${f.pr}, already open on your branch: the "Protected files try" section of your briefing lists the protected files its check wants an approval for. ` +
      "Drop each change to them that the ticket's acceptance criteria do not need, and nothing else. If you dropped any, verify what you changed (desk-ticket Stage 4) and self-review it (Stage 4b), push to the same branch with git push origin <your branch>, then review the new head with desk-review and post that review on the PR (desk-review Phase 7). If every change is needed, change nothing and push nothing. " +
      `Open no new PR, leave the PR out of draft, and leave the ticket's Jira as it is. End with AUTOPILOT_DONE: pr=${f.pr} jira=<its status> said=<for each file, dropped, or needed and the criterion that needs it>.`;
  }
  if (f.kind === 'capture') {
    return `Follow the autopilot worker contract in your system prompt exactly. Your ticket is $TICKET. Your worktree is $WT. Your dev-server port is $PORT. ` +
      `Your task is the capture try on PR #${f.pr}, already open on your branch: the "Capture try" section of your briefing lists the screenshots its body is missing. ` +
      'Take each one (desk-ticket Stage 5), save it under exactly the file name its cell names in your screenshot directory, and print AUTOPILOT_IMAGES with that directory. ' +
      'Change no code and do not edit the PR body: the pass uploads them and fills its cells. ' +
      `Open no new PR, leave the PR in draft, and leave the ticket's Jira as it is. End with AUTOPILOT_DONE: pr=${f.pr} jira=<its status> said=<all taken, or for each screen you could not take, <file>: <why>>.`;
  }
  const gaps = f.kind === 'gaps', instruction = f.kind === 'instruction';
  // A draft's red checks or conflict are fixed in draft and reviewed again, as a review fix is, and so
  // is a ready PR's review feedback or review, and whatever the person sent back.
  const review = f.kind === 'review' || f.kind === 'feedback' || personCall(f) || f.draft === true;
  const inDraft = review && !f.ready && f.kind !== 'feedback';
  const how = f.kind === 'conflict'
    ? `merge origin/${f.base} into your branch (git merge, never a rebase or a force push) and resolve the conflicts: this task is your authority to resolve them`
    : f.kind === 'sync' ? `merge origin/${f.base} into your branch (git merge, never a rebase or a force push), run the repo's checks on the merged head, and fix each break the merge brought in, in a commit of its own after the merge: this task is your authority to merge it`
    : f.kind === 'feedback' ? 'validate each review thread it quotes (desk-review-response), fix what is right, answer every thread with gh pr comment naming it, and park on one you cannot fix, naming it and what blocks it'
    : gaps ? 'do what the call says about each gap, and nothing else'
    : instruction ? 'do what the instruction says, and nothing else'
      : f.kind === 'review' ? (f.gaps?.length
        ? `${f.findings?.length ? `fix each ${findingKinds(f.findings)} finding it quotes and ` : ''}close each requirement gap it quotes by the call it needs, recorded as the briefing says, or park on a gap that needs a product or another person's ruling, and nothing else`
        : `fix each ${findingKinds(f.findings)} finding it quotes${f.findings?.some((x) => x.sev === 'P2') ? ', or carry one in your review of the new head where fixing it would mean another round' : ''}, and nothing else`)
        : 'read each failing run (gh run view <run id> --log-failed) and fix the cause, never the check';
  // A review fix is reviewed again on its new head, so the pass reads a verdict there before it undrafts.
  const after = review ? ', then review the new head with desk-review and post that review on the PR (desk-review Phase 7)' : '';
  // A conflict try's DONE line is the reason a PR stuck after its last try gives (stillInConflict).
  const said = f.kind === 'conflict' ? ' said=<one line: what you resolved, or what is still in conflict and why>'
    : f.kind === 'sync' ? ' said=<one line: what the merge broke and how you fixed it, or what still fails and why>' : '';
  const task = gaps
    ? `Your task is to carry out the person's call on the review gaps of PR #${f.pr}, already open on your branch: the "Your call" section of your briefing quotes it. `
    : instruction ? `Your task is to carry out the person's instruction on PR #${f.pr}, already open on your branch: the "The person's instruction" section of your briefing quotes it. `
    : `Your task is ${f.person ? 'the fix try the person sent' : `fix try ${f.try} of ${f.of}`} on PR #${f.pr}, already open on your branch: the "Fix try" section of your briefing says what is wrong. `;
  return `Follow the autopilot worker contract in your system prompt exactly. Your ticket is $TICKET. Your worktree is $WT. Your dev-server port is $PORT. ` +
    task +
    `Fix only that: ${how}. Then verify what you changed (desk-ticket Stage 4) and self-review it (Stage 4b), and push to the same branch with git push origin <your branch>${after}. ` +
    `Open no new PR, leave the PR ${inDraft ? 'in' : 'out of'} draft, and leave the ticket's Jira ${f.gaps?.length ? 'status as it is, apart from the comments recording your calls' : 'as it is'}. End with AUTOPILOT_DONE: pr=${f.pr} jira=<its status>${said}.`;
}
