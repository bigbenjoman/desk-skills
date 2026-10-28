// A ready batch PR the merge driver cannot merge goes back to a worker on its own branch, at most
// FIX_TRIES_MAX times: one still red after the driver's two reruns, or one in conflict with its base.
// So does a draft whose posted review at its head found a P0 or a P1 (reviewFix), within the same tries.
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

// t: the queue ticket. s: its pr_status. ctx: { repo, base, required, advisory, operator (parsed),
// reruns(name) -> reruns tried at s.head, cooledDown (the last rerun has had its gap to report),
// waived(names) -> the driver merges past these as known flaky checks, conflictFiles() -> [file] | null }.
export function fixCall(t, s, ctx) {
  if (s?.state !== 'OPEN' || s.isDraft !== false || !s.head) return null;
  const done = t.fix_tries ?? [];
  const conflict = s.mergeable === 'CONFLICTING' || s.mergeState === 'DIRTY';
  let fix;
  if (conflict) {
    fix = { kind: 'conflict', what: `conflicts with ${ctx.base}`, base: ctx.base, files: ctx.conflictFiles?.() ?? null };
  } else {
    const gate = evaluateGate(s.checks ?? [], { required: ctx.required ?? [], advisory: ctx.advisory ?? [] });
    if (gate.state !== 'fail' || gate.pending.length) return null;
    const failing = [...new Map(gate.failing.map((f) => [f.name, f])).values()];
    const op = new Map((ctx.operator ?? []).map((o) => [o.name, o.command]));
    const notMine = failing.filter((f) => op.has(f.name)).map((f) => ({ name: f.name, command: op.get(f.name) }));
    const mine = failing.filter((f) => !op.has(f.name));
    if (!mine.length) return notMine.length ? { call: 'stuck', why: notMine.map((o) => `${o.name} · ${o.command}`).join('; ') } : null;
    if (ctx.waived?.(mine.map((f) => f.name))) return null;
    if (!ctx.cooledDown || mine.some((f) => (ctx.reruns?.(f.name) ?? 0) < RERUNS_MAX)) return null;
    fix = { kind: 'checks', what: `red: ${mine.map((f) => f.name).join(', ')}`, checks: mine.map((f) => ({ name: f.name, url: runUrl(ctx.repo, f.runId) })), not_mine: notMine };
  }
  // A try already made for this head is one whose worker finished without moving it.
  if (done.length >= FIX_TRIES_MAX || done.some((x) => x.head === s.head)) {
    return { call: 'stuck', why: conflict ? `still in conflict with ${ctx.base} after ${tries(done.length)}` : `still red after ${tries(done.length)}: ${fix.checks.map((c) => c.name).join(', ')}` };
  }
  return { call: 'requeue', fix: { try: done.length + 1, of: FIX_TRIES_MAX, pr: s.pr, head: s.head, ...fix } };
}

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
    else if (/^#{1,6}\s/.test(text) || /^[A-Z][A-Z ]{3,}(\(|$)/.test(text)) sev = null;
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

// A finding's text names `path:line` as its own: the same path and line, not a longer one.
const names = (text, at) => new RegExp(`(^|[^\\w./-])${at.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`).test(text);

// A draft PR whose posted review at its head is not clean goes back to a fix worker when the review
// found a P0 or a P1, under the same tries as fixCall (one per head, FIX_TRIES_MAX per PR). Only P2s
// and gaps are left as they are (null), and so is a review that lists no P0 or P1 with its file:line
// in its body or its inline comments: the person settles those. An inline finding the body also
// lists at the same file:line is quoted once, from the body.
// review: { pr, head, verdict, body, comments } (comments as inlineFindings reads them, or a function
// returning them, called only once a try is left; null when they could not be read, so only the body
// counts).
export function reviewFix(t, review) {
  const counts = reviewCounts(review.verdict);
  if (!counts || !review.head) return null;
  const done = t.fix_tries ?? [];
  if (done.length >= FIX_TRIES_MAX || done.some((x) => x.head === review.head)) {
    return { call: 'stuck', why: `review not clean after ${tries(done.length)}: ${counts}` };
  }
  const listed = reviewFindings(review.body);
  const comments = typeof review.comments === 'function' ? review.comments() : review.comments;
  const inline = inlineFindings(comments).filter((x) => !listed.some((b) => names(b.text, x.at)));
  const findings = [...listed, ...inline.map(({ sev, text }) => ({ sev, text }))];
  if (!findings.length) return null;
  const verdict = Object.entries(review.verdict).map(([k, x]) => `${k}=${x}`).join(' ');
  return { call: 'requeue', fix: { try: done.length + 1, of: FIX_TRIES_MAX, pr: review.pr, head: review.head, kind: 'review', what: `review not clean: ${counts}`, verdict, findings } };
}

// The fix worker's briefing section, while its try is open.
export function fixBrief(t) {
  const f = t.fix;
  if (!f || f.finished) return '';
  const lines = [`## Fix try ${f.try} of ${f.of}: PR #${f.pr}`, ''];
  if (f.kind === 'conflict') {
    lines.push(`Your PR #${f.pr} is open and out of draft on this branch, and it conflicts with ${f.base}, so the merge driver cannot merge it.`);
    lines.push(f.files?.length ? `Conflicting files: ${f.files.join(', ')}.` : `The conflicting files were not listed: \`git merge-tree --write-tree --name-only origin/${f.base} HEAD\` names them.`);
  } else if (f.kind === 'review') {
    lines.push(`Your PR #${f.pr} is a draft on this branch, and the desk-review posted on its head ${String(f.head).slice(0, 12)} is not clean (\`${f.verdict}\`). Fix each P0 and P1 finding it lists:`, '');
    for (const x of f.findings ?? []) lines.push(`- ${x.sev}: ${x.text}`);
    lines.push('', 'Its P2 findings are not part of this try.');
  } else {
    lines.push(`Your PR #${f.pr} is open and out of draft on this branch, and these checks are still red at ${String(f.head).slice(0, 12)} after the merge driver's two reruns:`, '');
    for (const c of f.checks) lines.push(`- ${c.name}: ${c.url ?? 'no run URL reported'}`);
    for (const c of f.not_mine ?? []) lines.push(`- ${c.name} is red too, and it is not yours to fix: ${c.command}. A person runs that; leave it red.`);
  }
  lines.push('', `This is try ${f.try} of ${f.of}. A PR still ${f.kind === 'review' ? 'with a P0 or P1 in its review' : 'red or in conflict'} after try ${f.of} goes to the person.`, '');
  return lines.join('\n');
}

// The prompt a fix worker starts with (spawn-worker.sh's AUTOPILOT_TASK).
export function fixTask(t) {
  const f = t.fix;
  const review = f.kind === 'review';
  const how = f.kind === 'conflict'
    ? `merge origin/${f.base} into your branch (git merge, never a rebase or a force push) and resolve the conflicts: this task is your authority to resolve them`
    : review ? 'fix each P0 and P1 finding it quotes, and nothing else'
      : 'read each failing run (gh run view <run id> --log-failed) and fix the cause, never the check';
  // A review fix is reviewed again on its new head, so the pass reads a verdict there before it undrafts.
  const after = review ? ', then review the new head with desk-review and post that review on the PR (desk-review Phase 7)' : '';
  return `Follow the autopilot worker contract in your system prompt exactly. Your ticket is $TICKET. Your worktree is $WT. Your dev-server port is $PORT. ` +
    `Your task is fix try ${f.try} of ${f.of} on PR #${f.pr}, already open on your branch: the "Fix try" section of your briefing says what is wrong. ` +
    `Fix only that: ${how}. Then verify what you changed (desk-ticket Stage 4) and self-review it (Stage 4b), and push to the same branch with git push origin <your branch>${after}. ` +
    `Open no new PR, leave the PR ${review ? 'in' : 'out of'} draft, and leave the ticket's Jira as it is. End with AUTOPILOT_DONE: pr=${f.pr} jira=<its status>.`;
}
