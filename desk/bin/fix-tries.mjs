// A ready batch PR the merge driver cannot merge goes back to a worker on its own branch, at most
// FIX_TRIES_MAX times: one still red after the driver's two reruns, or one in conflict with its base.
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

// The fix worker's briefing section, while its try is open.
export function fixBrief(t) {
  const f = t.fix;
  if (!f || f.finished) return '';
  const lines = [`## Fix try ${f.try} of ${f.of}: PR #${f.pr}`, ''];
  if (f.kind === 'conflict') {
    lines.push(`Your PR #${f.pr} is open and out of draft on this branch, and it conflicts with ${f.base}, so the merge driver cannot merge it.`);
    lines.push(f.files?.length ? `Conflicting files: ${f.files.join(', ')}.` : `The conflicting files were not listed: \`git merge-tree --write-tree --name-only origin/${f.base} HEAD\` names them.`);
  } else {
    lines.push(`Your PR #${f.pr} is open and out of draft on this branch, and these checks are still red at ${String(f.head).slice(0, 12)} after the merge driver's two reruns:`, '');
    for (const c of f.checks) lines.push(`- ${c.name}: ${c.url ?? 'no run URL reported'}`);
    for (const c of f.not_mine ?? []) lines.push(`- ${c.name} is red too, and it is not yours to fix: ${c.command}. A person runs that; leave it red.`);
  }
  lines.push('', `This is try ${f.try} of ${f.of}. A PR still red or in conflict after try ${f.of} goes to the person.`, '');
  return lines.join('\n');
}

// The prompt a fix worker starts with (spawn-worker.sh's AUTOPILOT_TASK).
export function fixTask(t) {
  const f = t.fix;
  const how = f.kind === 'conflict'
    ? `merge origin/${f.base} into your branch (git merge, never a rebase or a force push) and resolve the conflicts: this task is your authority to resolve them`
    : 'read each failing run (gh run view <run id> --log-failed) and fix the cause, never the check';
  return `Follow the autopilot worker contract in your system prompt exactly. Your ticket is $TICKET. Your worktree is $WT. Your dev-server port is $PORT. ` +
    `Your task is fix try ${f.try} of ${f.of} on PR #${f.pr}, already open on your branch: the "Fix try" section of your briefing says what is wrong. ` +
    `Fix only that: ${how}. Then verify what you changed (desk-ticket Stage 4) and self-review it (Stage 4b), and push to the same branch with git push origin <your branch>. ` +
    `Open no new PR, leave the PR out of draft, and leave the ticket's Jira as it is. End with AUTOPILOT_DONE: pr=${f.pr} jira=<its status>.`;
}
