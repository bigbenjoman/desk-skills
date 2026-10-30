// A ready batch PR the merge driver cannot merge goes back to a worker on its own branch, at most
// FIX_TRIES_MAX times: one still red after the driver's two reruns, or one in conflict with its base.
// So does a draft whose posted review at its head found a P0 or a P1, or under §3 autopilot-judgement
// yes a requirement gap (reviewFix), within the same tries, and one whose review gaps the person
// ruled on through desk-needs-you (gapsFix), outside them. A draft whose required check is red
// (draftChecksFix) goes to a fix worker, and one with no review verdict readable at its head
// (reviewTry) to a review worker, both within the same tries, and so does a draft in conflict with
// its base that §3 lets a worker resolve (conflictFix).
// pass.mjs reads each done ticket's PR (pr_status) and asks fixCall what to do with it:
//
//   requeue  send the ticket back for a fix worker; `fix` is the try (its number, the head it is for,
//            and what it is fixing), kept on the ticket as `fix` and appended to `fix_tries`
//   stuck    no worker can fix it, so it goes to the person; `why` says what is left
//   null     nothing to do: green, still running, reruns still to come, or waived as a known flaky check
//
// A check §4 Checks workers can't fix names is never sent to a worker: on its own it is stuck with
// the command that fixes it, and beside a check a worker can fix it is named in the brief as not theirs.
import { evaluateGate } from './gate.mjs';

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
const tries = (n) => `${n} fix ${n === 1 ? 'try' : 'tries'}`;
// A fix try already made for this head: one whose worker finished without moving it. A review try
// (kind `rereview`) moves no head by design, so it does not count here.
const fixedAt = (done, head) => done.some((x) => x.head === head && x.kind !== 'rereview');

// A gate's failing checks, one per name, split into those a worker fixes and those §4 Checks workers
// can't fix names ({ name, command }).
function splitFailing(failing, operator) {
  const all = [...new Map(failing.map((f) => [f.name, f])).values()];
  const op = new Map((operator ?? []).map((o) => [o.name, o.command]));
  return { mine: all.filter((f) => !op.has(f.name)), notMine: all.filter((f) => op.has(f.name)).map((f) => ({ name: f.name, command: op.get(f.name) })) };
}
const operatorStuck = (notMine) => ({ call: 'stuck', why: notMine.map((o) => `${o.name} · ${o.command}`).join('; ') });
// A red-checks fix: each check a worker fixes with its run, and those it leaves to a person.
const checksFix = (mine, notMine, repo) => ({ kind: 'checks', what: `red: ${mine.map((f) => f.name).join(', ')}`, checks: mine.map((f) => ({ name: f.name, url: runUrl(repo, f.runId) })), not_mine: notMine });
const stillRed = (done, fix) => `still red after ${tries(done.length)}: ${fix.checks.map((c) => c.name).join(', ')}`;
// No try is left: FIX_TRIES_MAX made, or one already made at this head (triedHere).
const spent = (done, triedHere) => done.length >= FIX_TRIES_MAX || triedHere;
const nextTry = (done, pr, head, fix) => ({ call: 'requeue', fix: { try: done.length + 1, of: FIX_TRIES_MAX, pr, head, ...fix } });

// A conflict with the base, out of draft (fixCall) or in it (conflictFix), and its stuck reason. The
// reason ends with what the last try reported (its AUTOPILOT_DONE line, kept by pass.mjs as
// result.summary) when that try was a conflict try whose worker has finished.
const conflictTry = (base, files, draft) => ({ kind: 'conflict', ...(draft ? { draft: true } : {}), what: `${draft ? 'draft ' : ''}conflicts with ${base}`, base, files: files ?? null });
const lastSaid = (t) => (t.fix?.kind === 'conflict' && t.fix.finished && t.result?.summary ? `; the last try said: ${t.result.summary}` : '');
const stillInConflict = (t, done, base, files) => `still in conflict with ${base} after ${tries(done.length)}${files?.length ? `: ${files.join(', ')}` : ''}${lastSaid(t)}`;

// t: the queue ticket. s: its pr_status. ctx: { repo, base, required, advisory, operator (parsed),
// reruns(name) -> reruns tried at s.head, cooledDown (the last rerun has had its gap to report),
// waived(names) -> the driver merges past these as known flaky checks, conflictFiles() -> [file] | null }.
export function fixCall(t, s, ctx) {
  if (s?.state !== 'OPEN' || s.isDraft !== false || !s.head) return null;
  const done = t.fix_tries ?? [];
  const conflict = s.mergeable === 'CONFLICTING' || s.mergeState === 'DIRTY';
  let fix;
  if (conflict) {
    fix = conflictTry(ctx.base, ctx.conflictFiles?.(), false);
  } else {
    const gate = evaluateGate(s.checks ?? [], { required: ctx.required ?? [], advisory: ctx.advisory ?? [] });
    if (gate.state !== 'fail' || gate.pending.length) return null;
    const { mine, notMine } = splitFailing(gate.failing, ctx.operator);
    if (!mine.length) return notMine.length ? operatorStuck(notMine) : null;
    if (ctx.waived?.(mine.map((f) => f.name))) return null;
    if (!ctx.cooledDown || mine.some((f) => (ctx.reruns?.(f.name) ?? 0) < RERUNS_MAX)) return null;
    fix = checksFix(mine, notMine, ctx.repo);
  }
  if (spent(done, fixedAt(done, s.head))) {
    return { call: 'stuck', why: conflict ? stillInConflict(t, done, ctx.base) : stillRed(done, fix) };
  }
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

// The P0 and P1 findings a posted desk-review body lists, one line each with its file:line, as
// { sev, text }. A finding sits under a `P0 (n)` or `P1 (n)` heading, or opens with its own
// severity; a heading of anything else (P2, REQUIREMENT GAPS, a `###` section) ends that run, and a
// line opening with an em dash continues the finding above it.
export function reviewFindings(body) {
  const found = [];
  let sev = null;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const text = line.trim();
    const own = /^[#>*_\s-]*(P[0-3])\b/.exec(line);
    if (own) sev = own[1];
    else if (isHeading(text)) sev = null;
    if (sev !== 'P0' && sev !== 'P1') continue;
    if (text.startsWith('—') && found.length) { found[found.length - 1].text += ` ${text}`; continue; }
    if (/[\w./-]+:\d+/.test(text)) found.push({ sev, text });
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
// found a P0 or a P1, under the same tries as fixCall (one per head, FIX_TRIES_MAX per PR). Where
// config §3 autopilot-judgement is yes (opts.judgement), so do its requirement gaps: closing one is a
// call the worker may make and record, or park when it needs a product or another person's ruling.
// P2s are left as they are (null), and so is a review that counts a P0 or P1 but lists none with its
// file:line in its body or its inline comments, or counts only gaps and lists none under its gaps
// heading: the person settles those.
// An inline finding the body also lists at the same file:line is quoted once, from the body.
// review: { pr, head, verdict, body, comments } (comments as inlineFindings reads them, or a function
// returning them, called only once a try is left; null when they could not be read, so only the body
// counts).
export function reviewFix(t, review, opts = {}) {
  const counts = reviewCounts(review.verdict);
  const gapsOpen = opts.judgement === 'yes' ? Number(review.verdict?.gaps) || 0 : 0;
  const what = [counts, gapsOpen ? gapCount(gapsOpen) : ''].filter(Boolean).join(', ');
  if (!what || !review.head) return null;
  const done = t.fix_tries ?? [];
  if (spent(done, fixedAt(done, review.head))) {
    // The review at this head is the last try's own, so its gaps say why each is still open.
    const left = gapsOpen ? reviewGaps(review.body) : [];
    return { call: 'stuck', why: `review not clean after ${tries(done.length)}: ${what}${left.length ? ` — ${left.join('; ')}` : ''}` };
  }
  const listed = counts ? reviewFindings(review.body) : [];
  const comments = !counts ? null : typeof review.comments === 'function' ? review.comments() : review.comments;
  const inline = inlineFindings(comments).filter((x) => !listed.some((b) => owns(b.text, x.at)));
  const findings = [...listed, ...inline.map(({ sev, text }) => ({ sev, text }))];
  const gaps = gapsOpen ? reviewGaps(review.body) : [];
  if (counts ? !findings.length : !gaps.length) return null;
  const verdict = Object.entries(review.verdict).map(([k, x]) => `${k}=${x}`).join(' ');
  return nextTry(done, review.pr, review.head, { kind: 'review', what: `review not clean: ${what}`, verdict, findings, ...(gaps.length ? { gaps } : {}) });
}

// The person's call on a draft's review gaps (desk-needs-you), as the fix it sends back: not one of
// the FIX_TRIES_MAX tries, which are the pass's own.
export const gapsFix = ({ pr, head, answer }) => ({ kind: 'gaps', pr, head: head ?? null, what: 'review gaps: your call', answer });

// A draft with no review verdict the pass can read at its head (undraft.mjs `review`: none posted, one
// it cannot read, or one for an older head) goes to a review worker, which reviews the head and posts
// it. Its try is one of the FIX_TRIES_MAX, once per head: still unread after one, it is the person's,
// with `why` saying what the pass read last.
export function reviewTry(t, { pr, head, why }) {
  if (!head) return null;
  const done = t.fix_tries ?? [];
  if (spent(done, done.some((x) => x.head === head && x.kind === 'rereview'))) {
    return { call: 'stuck', why: `no review verdict readable at its head after ${tries(done.length)}: ${why}` };
  }
  return nextTry(done, pr, head, { kind: 'rereview', what: `review its head: ${why}` });
}

// A draft whose required checks are red (undraft.mjs `checks`) goes to a fix worker, with each failing
// check's name and run, under the same tries as fixCall. There are no driver reruns to wait for: the
// merge driver reruns only a PR out of draft. ctx: { repo, operator (parsed) }.
export function draftChecksFix(t, { pr, head, failing }, ctx) {
  if (!head) return null;
  const { mine, notMine } = splitFailing(failing ?? [], ctx.operator);
  if (!mine.length) return notMine.length ? operatorStuck(notMine) : null;
  const done = t.fix_tries ?? [];
  const fix = { ...checksFix(mine, notMine, ctx.repo), draft: true };
  return spent(done, fixedAt(done, head)) ? { call: 'stuck', why: stillRed(done, fix) } : nextTry(done, pr, head, fix);
}

// A draft PR in conflict with its base, which undraft.mjs sends on (`conflict`) under §3
// pr-conflict-unreviewed or -reviewed, goes back to a fix worker under the same tries as fixCall (one
// per head, FIX_TRIES_MAX per PR). draft: { pr, head, base, files } (files: [file] | null).
export function conflictFix(t, { pr, head, base, files }) {
  if (!head) return null;
  const done = t.fix_tries ?? [];
  return spent(done, fixedAt(done, head)) ? { call: 'stuck', why: stillInConflict(t, done, base, files) } : nextTry(done, pr, head, conflictTry(base, files, true));
}

// The fix worker's briefing section, while its try is open.
export function fixBrief(t) {
  const f = t.fix;
  if (!f || f.finished) return '';
  if (f.kind === 'gaps') {
    return [`## Your call on PR #${f.pr}'s review gaps`, '',
      `Your PR #${f.pr} is a draft on this branch, and the desk-review posted on its head${f.head ? ` ${String(f.head).slice(0, 12)}` : ''} left requirement gaps. The person has ruled on them (also posted on the PR):`, '',
      ...String(f.answer ?? '').split('\n').map((l) => `> ${l}`), '', 'Carry out that call on each gap, and nothing else.', ''].join('\n');
  }
  if (f.kind === 'rereview') {
    return [`## Review try ${f.try} of ${f.of}: PR #${f.pr}`, '',
      `Your PR #${f.pr} is a draft on this branch, and the pass reads no review verdict at its head ${String(f.head).slice(0, 12)}: ${f.what.replace(/^review its head: /, '')}.`,
      'Review that head with desk-review and post the review on the PR (desk-review Phase 7), so its verdict marker is on the head. Change no code in this try: a P0, a P1 or a gap the review finds goes to a fix worker at the next pass.', '',
      `This is try ${f.try} of ${f.of}. A PR with no verdict readable at its head after this try goes to the person.`, ''].join('\n');
  }
  const lines = [`## Fix try ${f.try} of ${f.of}: PR #${f.pr}`, ''];
  if (f.kind === 'conflict') {
    lines.push(f.draft
      ? `Your PR #${f.pr} is a draft on this branch, and it conflicts with ${f.base}, so the pass cannot take it out of draft. Its review was for the old head, so the new head needs one of its own.`
      : `Your PR #${f.pr} is open and out of draft on this branch, and it conflicts with ${f.base}, so the merge driver cannot merge it.`);
    lines.push(f.files?.length ? `Conflicting files: ${f.files.join(', ')}.` : `The conflicting files were not listed: \`git merge-tree --write-tree --name-only origin/${f.base} HEAD\` names them.`);
  } else if (f.kind === 'review') {
    lines.push(`Your PR #${f.pr} is a draft on this branch, and the desk-review posted on its head ${String(f.head).slice(0, 12)} is not clean (\`${f.verdict}\`).`);
    if (f.findings?.length) {
      lines.push('Fix each P0 and P1 finding it lists:', '');
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
    lines.push('Its P2 findings are not part of this try.');
  } else {
    lines.push(f.draft
      ? `Your PR #${f.pr} is a draft on this branch, and these required checks are red at ${String(f.head).slice(0, 12)}, so it cannot leave draft:`
      : `Your PR #${f.pr} is open and out of draft on this branch, and these checks are still red at ${String(f.head).slice(0, 12)} after the merge driver's two reruns:`, '');
    for (const c of f.checks) lines.push(`- ${c.name}: ${c.url ?? 'no run URL reported'}`);
    for (const c of f.not_mine ?? []) lines.push(`- ${c.name} is red too, and it is not yours to fix: ${c.command}. A person runs that; leave it red.`);
    if (f.draft) lines.push('', 'Read each failing run\'s log with gh run view <run id> --log-failed (the id is the number in its URL).');
  }
  const left = f.kind === 'review' ? `with a P0 or P1${f.gaps?.length ? ' or a gap' : ''} in its review`
    : f.kind === 'conflict' && f.draft ? 'in conflict' : f.draft ? 'red' : 'red or in conflict';
  lines.push('', `This is try ${f.try} of ${f.of}. A PR still ${left} after try ${f.of} goes to the person.`, '');
  return lines.join('\n');
}

// The prompt a fix worker starts with (spawn-worker.sh's AUTOPILOT_TASK).
export function fixTask(t) {
  const f = t.fix;
  if (f.kind === 'rereview') {
    return `Follow the autopilot worker contract in your system prompt exactly. Your ticket is $TICKET. Your worktree is $WT. Your dev-server port is $PORT. ` +
      `Your task is review try ${f.try} of ${f.of} on PR #${f.pr}, already open on your branch: the "Review try" section of your briefing says why. ` +
      'Review its head with desk-review and post that review on the PR (desk-review Phase 7), and change no code. ' +
      `Open no new PR, leave the PR in draft, and leave the ticket's Jira as it is. End with AUTOPILOT_DONE: pr=${f.pr} jira=<its status>.`;
  }
  const gaps = f.kind === 'gaps';
  // A draft's red checks or conflict are fixed in draft and reviewed again, as a review fix is.
  const review = f.kind === 'review' || gaps || f.draft === true;
  const how = f.kind === 'conflict'
    ? `merge origin/${f.base} into your branch (git merge, never a rebase or a force push) and resolve the conflicts: this task is your authority to resolve them`
    : gaps ? 'do what the call says about each gap, and nothing else'
      : f.kind === 'review' ? (f.gaps?.length
        ? `${f.findings?.length ? 'fix each P0 and P1 finding it quotes and ' : ''}close each requirement gap it quotes by the call it needs, recorded as the briefing says, or park on a gap that needs a product or another person's ruling, and nothing else`
        : 'fix each P0 and P1 finding it quotes, and nothing else')
        : 'read each failing run (gh run view <run id> --log-failed) and fix the cause, never the check';
  // A review fix is reviewed again on its new head, so the pass reads a verdict there before it undrafts.
  const after = review ? ', then review the new head with desk-review and post that review on the PR (desk-review Phase 7)' : '';
  // A conflict try's DONE line is the reason a PR stuck after its last try gives (stillInConflict).
  const said = f.kind === 'conflict' ? ' said=<one line: what you resolved, or what is still in conflict and why>' : '';
  const task = gaps
    ? `Your task is to carry out the person's call on the review gaps of PR #${f.pr}, already open on your branch: the "Your call" section of your briefing quotes it. `
    : `Your task is fix try ${f.try} of ${f.of} on PR #${f.pr}, already open on your branch: the "Fix try" section of your briefing says what is wrong. `;
  return `Follow the autopilot worker contract in your system prompt exactly. Your ticket is $TICKET. Your worktree is $WT. Your dev-server port is $PORT. ` +
    task +
    `Fix only that: ${how}. Then verify what you changed (desk-ticket Stage 4) and self-review it (Stage 4b), and push to the same branch with git push origin <your branch>${after}. ` +
    `Open no new PR, leave the PR ${review ? 'in' : 'out of'} draft, and leave the ticket's Jira ${f.gaps?.length ? 'status as it is, apart from the comments recording your calls' : 'as it is'}. End with AUTOPILOT_DONE: pr=${f.pr} jira=<its status>${said}.`;
}
