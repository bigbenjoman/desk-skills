// What clears a park, as a script can read it: the park's `clears_when`, recorded when the ticket
// parks (a worker's `AUTOPILOT_PARK_CLEARS_WHEN:` line, or `queue.mjs clears-when`). Each pass checks
// it for every parked ticket, and a park whose condition holds is settled without a model or a person.
//
// The forms, one per park:
//   pr <n> merged          the PR merged
//   pr <n> ready           the PR is out of draft (open and not a draft, or merged)
//   ticket <KEY> done      the Jira ticket is in a done status category
//   variable <NAME> set    the repo has an Actions variable of that name
//   run <id> completed     the GitHub Actions run finished, whatever its conclusion
//   git push origin <branch> succeeds
//                          the push GitHub refused with a 5xx goes through; the check is the push
//                          itself, and `--force-with-lease=<branch>:<sha>` may come before `origin`.
//                          A lease with no SHA is not read: a pass pushes long after the worker did,
//                          so it must name what it may overwrite
//   base contains <branch> origin's batch base has every commit on origin's <branch> (with no batch
//                          base, the default branch has): "base contains main" is a park waiting for
//                          main to be merged into the base. The pass syncs a base behind the default
//                          branch first, and checks this after that sync, in the same pass
//   pr <n> reviewed by <login> at head
//                          that account has a review on the commit that is the PR's head now; one
//                          only on an older commit does not count
//   file <path> exists     the file is there: an absolute path, one relative to the ticket's worktree,
//                          or one under the state directory written $DESK_STATE/<path>. `<path> exists`
//                          with no `file` reads the same where the path cannot be anything else: an
//                          absolute or $DESK_STATE path, or one whose last part has an extension
//   ticket <KEY> in <repo> batch
//                          the ticket is in the queue of a batch of that repo on this computer (its
//                          name or owner/name), other than this one, whose orchestrator has a live beat
//   check "<name>" on pr <n> passes
//                          the latest run of that check on the PR's head commit succeeded; several names,
//                          each quoted, joined by commas or "and" (`checks "a" and "b" on pr 9 pass`)
//   commit <sha> on <branch>
//                          origin's <branch> holds that commit ("is an ancestor of origin/<branch>" too).
//                          Once a branch other than the default branch or a batch base has moved to a
//                          head the commit does not build on, it can never land there by a plain push,
//                          and the park is the person's (commitOnBranch)
//   gh pr view <n> [--repo <owner/name>] … reports MERGED
//                          the command a worker would run, read as pr <n> merged (in that repo)
//   none                   nothing a script can read; the park waits for a person
// Stored on the park as {kind, pr | ticket | name | run | branch | login | path | repo}: kind is
// pr-merged (with repo: <owner/name> for another repo's PR), pr-ready, ticket-done, variable-set,
// run-completed, push-ok (with lease: <sha> for a lease push), base-contains, pr-reviewed {pr, login},
// file-exists {path, root: abs | worktree | state, person?}, ticket-queued {ticket, repo}, checks-pass
// {pr, checks}, commit-on {sha, branch} or none. A file-exists is read against its park's question as it
// is recorded (withQuestion): it looks where the question says, and is person where the question asks
// the person to make the file, so that park is still put to them (personClears) while a pass checks it.
// A worker's line that reads as none of them is stored as unreadable {text, why, at}: the decider
// restates it once (decider.mjs; in a batch a session runs, that session), and it waits for a person
// only once the decider has seen it, or once RESTATE_MS has passed with no restate.
// The pass records one more itself, live-read {reads, head}, for a park waiting on §4 Live reads it
// runs (live-read.mjs), and settles it in its own section. And links-made {links, pr}, for a ticket that
// ended on DONE parked on issue links the pass did not make (pass.mjs parkLinks): it holds once each
// {key, type, other} is on Jira, and the ticket goes back to done on PR `pr`. Only the person's step
// makes that one hold, so its park is still put to them (personClears), not left to wait unseen.

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

// A check's name, quoted: names hold spaces.
const QUOTED = '(?:"[^"]+"|\'[^\']+\'|`[^`]+`)';
const FORMS = [
  [/^pr\s+#?(\d+)\s+merged$/i, (m) => ({ kind: 'pr-merged', pr: Number(m[1]) })],
  [/^pr\s+#?(\d+)\s+(?:ready|out of draft)$/i, (m) => ({ kind: 'pr-ready', pr: Number(m[1]) })],
  [/^ticket\s+([A-Za-z][A-Za-z0-9_]*-\d+)\s+done$/i, (m) => ({ kind: 'ticket-done', ticket: m[1].toUpperCase() })],
  [/^(?:repo\s+)?variable\s+([A-Za-z_][A-Za-z0-9_]*)\s+set$/i, (m) => ({ kind: 'variable-set', name: m[1] })],
  [/^run\s+#?(\d+)\s+completed$/i, (m) => ({ kind: 'run-completed', run: Number(m[1]) })],
  [/^git\s+push\s+(?:(?:-u|--set-upstream)\s+)?origin\s+([\w./-]+)\s+succeeds$/i, (m) => ({ kind: 'push-ok', branch: m[1] })],
  [/^git\s+push\s+--force-with-lease=([\w./-]+):([0-9a-f]{40})\s+origin\s+\1\s+succeeds$/, (m) => ({ kind: 'push-ok', branch: m[1], lease: m[2] })],
  [/^(?:the\s+)?(?:batch\s+)?base\s+contains\s+(?:origin\/)?([\w.-]+(?:\/[\w.-]+)*)$/i, (m) => ({ kind: 'base-contains', branch: m[1] })],
  [/^pr\s+#?(\d+)\s+reviewed\s+by\s+@?([A-Za-z0-9][\w-]*(?:\[bot\])?)\s+at\s+(?:its\s+|the\s+)?head$/i, (m) => ({ kind: 'pr-reviewed', pr: Number(m[1]), login: m[2] })],
  [/^file\s+(.+?)\s+exists$/i, (m) => fileCond(m[1])],
  // A bare path: only one that reads as a file, so a branch or a ticket that "exists" is not taken as one.
  [/^(\/\S+|\$(?:DESK_STATE|\{DESK_STATE\})\/\S+|\S*[^\s/]\.[A-Za-z0-9]+)\s+exists$/, (m) => fileCond(m[1])],
  [/^(?:ticket\s+)?([A-Za-z][A-Za-z0-9_]*-\d+)\s+(?:is\s+)?(?:queued\s+)?in\s+(?:an?\s+|the\s+)?([\w.-]+(?:\/[\w.-]+)?)\s+batch$/i,
    (m) => ({ kind: 'ticket-queued', ticket: m[1].toUpperCase(), repo: m[2] })],
  [new RegExp(`^checks?\\s+(${QUOTED}(?:\\s*(?:,\\s*and|,|and)\\s*${QUOTED})*)\\s+(?:on|of)\\s+pr\\s+#?(\\d+)\\s+(?:pass(?:es|ed)?|succeed(?:s|ed)?|(?:is|are)\\s+green)(?:\\s+at\\s+(?:its\\s+|the\\s+)?head)?$`, 'i'),
    (m) => ({ kind: 'checks-pass', pr: Number(m[2]), checks: [...m[1].matchAll(new RegExp(QUOTED, 'g'))].map((x) => x[0].slice(1, -1).trim()) })],
  [/^commit\s+([0-9a-f]{7,40})\s+(?:is\s+)?(?:on|in|an\s+ancestor\s+of|reachable\s+from)\s+(?:origin\/)?([\w.-]+(?:\/[\w.-]+)*)$/i,
    (m) => ({ kind: 'commit-on', sha: m[1].toLowerCase(), branch: m[2] })],
  [/^gh\s+pr\s+view\s+#?(\d+)((?:\s+\S+)*?)\s+(?:reports|returns|prints|shows|says|is|==?)\s+["'`]?merged["'`]?\.?$/i, (m, here) => {
    // gh takes [HOST/]OWNER/REPO: the repo is the last two parts.
    const repo = /(?:^|\s)(?:--repo|-R)[=\s]+["']?(?:[\w.-]+\/)?([\w.-]+\/[\w.-]+)(?=["']?(?:\s|$))/.exec(m[2])?.[1];
    return { kind: 'pr-merged', pr: Number(m[1]), ...(repo && repo.toLowerCase() !== String(here ?? '').toLowerCase() ? { repo } : {}) };
  }],
  [/^none$/i, () => ({ kind: 'none' })],
];
// Each form a pass reads, beside a line written in it: the one list of them. The table of forms in
// desk-autopilot's ask-or-take.md gives them, which tests/test_clears_when.sh keeps in step.
export const CLEARS_WHEN_EXAMPLES = [
  ['pr <n> merged', 'pr 812 merged'], ['pr <n> ready', 'pr 812 ready'], ['ticket <KEY> done', 'ticket ABC-41 done'],
  ['variable <NAME> set', 'variable DEPLOY_TOKEN set'], ['run <id> completed', 'run 18842117 completed'],
  ['git push origin <branch> succeeds', 'git push origin fix/ABC-42-totals succeeds'], ['base contains <branch>', 'base contains main'],
  ['pr <n> reviewed by <login> at head', 'pr 812 reviewed by octocat at head'], ['file <path> exists', 'file docs/exports/ABC-42.csv exists'],
  ['ticket <KEY> in <repo> batch', 'ticket ABC-43 in acme/web batch'], ['check "<name>" on pr <n> passes', 'check "e2e" on pr 812 passes'],
  ['commit <sha> on <branch>', 'commit 4f2a9c1 on main'], ['gh pr view <n> [--repo <owner/name>] reports MERGED', 'gh pr view 812 --repo acme/web reports MERGED'],
  ['none', 'none'],
];
const FORM_LIST = CLEARS_WHEN_EXAMPLES.map(([f]) => f).filter((f) => f !== 'none');
export const CLEARS_WHEN_FORMS = `${FORM_LIST.join(', ')}, or none`;
// One form a line, for a worker checking its line before it ends (queue.mjs clears-when --check).
export const CLEARS_WHEN_FORM_LINES = [...FORM_LIST, 'none'];

// A line no form reads, kept for the decider to restate (decider.mjs): a pass neither checks it nor
// asks the person until the decider has seen it.
export const UNREADABLE = 'unreadable';
export const restating = (c) => c?.kind === UNREADABLE;
// How long a pass leaves one for a restate before recording it none, so it reaches the person: several
// of the supervisor's deciders (decider.mjs DECIDER_TIMEOUT_MS), or of a session's passes.
export const RESTATE_MS = 60 * 60 * 1000;
export const restateLapsed = (c, now = Date.now()) => restating(c) && !(Date.parse(c.at ?? '') > now - RESTATE_MS);
// Whether `c` is a condition a pass checks: neither none nor one still to be restated.
export const recorded = (c) => !!c?.kind && c.kind !== 'none' && c.kind !== UNREADABLE;

const STATE_PREFIX = /^\$(?:DESK_STATE|\{DESK_STATE\})(?:\/|$)/;
// A relative path that climbs out of where it is read from (`..`) names somewhere else.
const climbs = (p) => posix.normalize(p).split('/')[0] === '..';
function fileCond(raw) {
  const p = raw.replace(/^["'`]|["'`]$/g, '');
  const refuse = { why: `"${p}" is outside the ticket's worktree and $DESK_STATE: name an absolute path, a path relative to the ticket's worktree, or $DESK_STATE/<path>` };
  if (p.startsWith('/')) return { kind: 'file-exists', path: posix.normalize(p), root: 'abs' };
  if (STATE_PREFIX.test(p)) {
    const rest = p.replace(STATE_PREFIX, '') || '.';
    return climbs(rest) ? refuse : { kind: 'file-exists', path: posix.normalize(rest), root: 'state' };
  }
  return p.startsWith('~') || p.startsWith('$') || climbs(p) ? refuse : { kind: 'file-exists', path: posix.normalize(p), root: 'worktree' };
}

// {ok: true, cond} or {ok: false, why}. Nothing given is none. `here` is this repo's owner/name: a PR
// named in it is this repo's, so no repo is stored for it.
export function parseClearsWhen(raw, { here = null } = {}) {
  const s = String(raw ?? '').trim().replace(/^["'`]|["'`]$/g, '').trim();
  if (!s) return { ok: true, cond: { kind: 'none' } };
  for (const [re, make] of FORMS) {
    const m = re.exec(s);
    if (!m) continue;
    const cond = make(m, here);
    return cond.why ? { ok: false, why: cond.why } : { ok: true, cond };
  }
  const file = /^(.+?)\s+exists$/i.exec(s)?.[1];
  const hint = file && !/^file\s/i.test(s) ? ` (for a file, write "file ${file} exists")` : '';
  return { ok: false, why: `"${s}" is not one of: ${CLEARS_WHEN_FORMS}${hint}` };
}

// The check a worker runs on its line before it ends: {ok, text}, the text naming what it reads as, or
// that it reads as no form, one form a line. `node clears-when.mjs --check "<condition>"` (a worker's,
// below) and `queue.mjs clears-when --check` print it, exiting 0 or 1.
export function checkLine(raw, { here = null } = {}) {
  const p = parseClearsWhen(raw, { here });
  if (p.ok) return { ok: true, text: `reads as: ${describeCond(p.cond)}` };
  const hint = / \(for a file, write "[^"]*"\)$/.exec(p.why)?.[0] ?? '';
  return { ok: false, text: `${p.why.replace(/ is not one of: [\s\S]*$/, ' is not a form a pass reads')}${hint}. The forms:\n${CLEARS_WHEN_FORM_LINES.map((f) => `  ${f}`).join('\n')}` };
}

// A file-exists condition's path as it is written.
const filePath = (c) => (c.root === 'state' ? `$DESK_STATE/${c.path}` : c.path);

// Where a file-exists condition looks: worktree and state are the ticket's worktree and $DESK_STATE.
export function condPath(c, { worktree, state }) {
  if (c.root === 'abs') return c.path;
  const dir = c.root === 'state' ? state : worktree;
  if (!dir) throw new Error(c.root === 'state' ? 'no state directory' : 'the ticket has no worktree recorded');
  return join(dir, c.path);
}

// Whether a GitHub login is `want`: case aside, and with or without an app's [bot] suffix.
const sameLogin = (a, want) => String(a ?? '').toLowerCase().replace(/\[bot\]$/, '') === String(want).toLowerCase().replace(/\[bot\]$/, '');
// Whether a desk slug (owner__name) is the repo a condition names, as name or owner/name. A GitHub
// owner holds no underscore, so the slug's first `__` ends the owner and the rest is the whole name:
// `web` is not the repo `foo__web`, nor `acme/web` the repo `other/acme__web`. A name with no `/` is
// the whole name, which may itself hold `__`, or the whole slug.
const sameRepo = (slug, repo) => {
  const s = String(slug).toLowerCase();
  const r = String(repo).toLowerCase().replace('/', '__');
  const at = s.indexOf('__');
  return s === r || (!String(repo).includes('/') && at > 0 && s.slice(at + 2) === r);
};
// A check on a PR's head, as gate.mjs normaliseRollup gives it: by its name, or its workflow's
// "<workflow> / <name>", case aside.
const sameCheck = (r, name) => [r?.name, r?.workflow && r?.name ? `${r.workflow} / ${r.name}` : null]
  .some((n) => n != null && String(n).toLowerCase() === String(name).toLowerCase());
// success for a passed one; otherwise its conclusion, or how far it has got.
const checkState = (r) => String((r?.status === 'completed' ? r.conclusion : r?.status) || 'unknown').toLowerCase();
const queueLabel = (o) => `${o.slug}${o.batch ? ` batch ${o.batch}` : ''}`;

// Whether `ticket` is in a running batch of `repo`. queues: otherQueues() less this batch's own;
// live(o): its orchestrator has a live beat. A queue of that repo that cannot be read throws, unless
// another of its batches already holds the ticket.
export function queuedIn(ticket, repo, queues, live) {
  const mine = queues.filter((o) => sameRepo(o.slug, repo));
  if (!mine.length) return { holds: false, note: `no ${repo} queue was found on this computer` };
  const holding = mine.filter((o) => !o.error && o.q?.tickets?.[ticket]);
  const running = holding.find(live);
  if (running) return { holds: true, note: `in ${queueLabel(running)}` };
  const bad = mine.find((o) => o.error);
  if (bad) throw new Error(`${queueLabel(bad)}'s queue cannot be read (${bad.error})`);
  return holding.length
    ? { holds: false, note: `in ${holding.map(queueLabel).join(', ')}, whose orchestrator is not running` }
    : { holds: false, note: `not in any ${repo} queue` };
}

// Whether only a step of the person's makes condition `c` hold, so a park waiting on it still asks them:
// issue links, or a file its park's question asks them to make (withQuestion marks it person). A file is
// also the person's where `question`, the park's, asks them for a step in any sentence (asksStep): no pass
// or worker makes a file for a parked ticket, so a host-side step the person is asked for (`npm install`
// writing a lockfile) is what makes it. Read here rather than only as recorded, so a park stored before
// the question was read this way is put to the person too.
export const personClears = (c, question) => c?.kind === 'links-made'
  || (c?.kind === 'file-exists' && (c.person === true || asksStep(question)));

// The words of a park's question: one in quotes or backticks runs to the closing one, spaces and all;
// any other runs to the first unescaped space (`Screen\ Recording.mov`, as a dragged-in path is written).
const QUESTION_WORD = /(?<=^|[\s(<[{])(["'`])([^\n]+?)\1(?=$|[\s.,;:!?)>\]}])|(?:\\ |\S)+/g;
// The files a park's question names, each {cond, at, placeholder}: a word holding a slash that reads as
// a path fileCond takes, ~/ read from the home directory, `at` where it starts in the question, and
// placeholder where it still holds a <name> or {name} to fill in, so it names no real place (${DESK_STATE}
// aside), and source where the word before it is "from", so it is what a copy reads, not what it makes.
const questionFiles = (question, home) => [...String(question ?? '').matchAll(QUESTION_WORD)]
  .map((m) => ({ at: m.index, w: m[2] ?? m[0].replace(/^[("'`<[]+|[)"'`>\].,;:!?]+$/g, '').replace(/\\ /g, ' ') }))
  .filter(({ w }) => w.includes('/') && !/^[a-z]+:\/\//i.test(w))
  .map(({ at, w }) => ({
    at,
    placeholder: /[<>{}]/.test(w.replace(STATE_PREFIX, '')),
    source: /\bfrom\W*$/i.test(String(question).slice(0, at)),
    cond: fileCond(w.startsWith('~/') ? posix.join(home, w.slice(2)) : w),
  }))
  .filter((f) => f.cond.kind === 'file-exists');
// An absolute path under the state directory, as one under $DESK_STATE.
const inState = (c, state) => {
  const dir = state ? posix.normalize(state).replace(/\/$/, '') : null;
  return c.root === 'abs' && dir && c.path.startsWith(`${dir}/`) ? { ...c, path: c.path.slice(dir.length + 1), root: 'state' } : c;
};
const sameFile = (a, b) => a.root === b.root && a.path === b.path;
// A request of the person to make, save or run something, not a description of a step. The verbs and
// their lead-ins read in either case; a name before "to" (needs Ben to) and a sentence's own first
// word (Save it to …) only capitalised, so "needs it to write" and "CI: run 991 writes" are not asks.
const VERBS = ['run', 'save', 'put', 'write', 'copy', 'drop', 'place', 'create', 'make', 'store', 'upload', 'attach', 'export', 'download', 'capture', 'paste'];
const ASK_VERB = `(?:${VERBS.join('|')})\\b`;
const ASKS = [
  new RegExp(`(?:\\b(?:please|kindly)\\s+|\\b(?:can|could|would|will) you\\s+(?:please\\s+)?|\\byou (?:need to|have to|must|should)\\s+|\\b(?:asks?|asking|needs?|wants?) (?:you|the (?:person|user)) to\\s+|^\\s*)${ASK_VERB}`, 'gi'),
  new RegExp(`\\b(?:asks?|asking|needs?|wants?) [A-Z][a-z]+ to\\s+${ASK_VERB}`, 'g'),
  new RegExp(`[;:]\\s+(?:${VERBS.map((v) => v[0].toUpperCase() + v.slice(1)).join('|')})\\b`, 'g'),
];
// A further step of the same request, after an ask: "… and save", "…, then save", "after it finishes, save".
const AND_VERB = new RegExp(`(?:\\band\\s+(?:then\\s+)?|\\bthen\\s+|,\\s*)${ASK_VERB}`, 'gi');
// Whether the question asks the person to make the file named at `at`: an ask earlier in that
// sentence, with no clause after it that hands the making to someone else (once the worker saves …).
function askedAt(question, at) {
  const before = question.slice(0, at);
  const from = Math.max(0, ...[...before.matchAll(/[.?!]\s+/g)].map((m) => m.index + m[0].length));
  const sentence = before.slice(from);
  const asks = ASKS.flatMap((re) => [...sentence.matchAll(re)].map((m) => [m.index, m.index + m[0].length]));
  if (!asks.length) return false;
  const first = Math.min(...asks.map(([s]) => s));
  const ends = [...asks.map(([, e]) => e), ...[...sentence.matchAll(AND_VERB)].filter((m) => m.index > first).map((m) => m.index + m[0].length)];
  return !/\b(?:once|when|after|until|while|before|if|unless|since)\b/i.test(sentence.slice(Math.max(...ends)));
}

// Whether question `q` asks the person for a step in any of its sentences, read as askedAt reads one: at
// the end of each sentence, so the whole sentence is the request.
export function asksStep(q) {
  const s = String(q ?? '');
  return [...[...s.matchAll(/[.?!](?=\s+|$)/g)].map((m) => m.index), s.length].some((at) => askedAt(s, at));
}

// A file-exists condition read against the question of the park it clears: {ok: true, cond} or
// {ok: false, why}. The question names the file by its name. Where a relative condition names it
// somewhere the question does not, it looks where the question says when that is one absolute or
// $DESK_STATE path ($DESK_STATE first, and never one a copy reads from), and is refused when it is not. An absolute or $DESK_STATE condition is kept. Where the question asks the person to
// make it, the condition is marked person (personClears). Any other condition, or a question naming no
// such file, is kept as given.
export function withQuestion(cond, question, { state = null, home = homedir() } = {}) {
  if (cond?.kind !== 'file-exists') return { ok: true, cond };
  const q = String(question ?? '');
  const name = posix.basename(cond.path);
  const named = questionFiles(q, home).map((f) => ({ ...f, cond: inState(f.cond, state) })).filter((f) => posix.basename(f.cond.path) === name);
  if (!named.length) return { ok: true, cond };
  const own = inState(cond, state);
  let at = cond;
  if (own.root === 'worktree' && !named.some((f) => sameFile(f.cond, own))) {
    const places = named.filter((f) => f.cond.root !== 'worktree' && !f.placeholder && !f.source).map((f) => f.cond)
      .filter((c, i, all) => all.findIndex((d) => sameFile(c, d)) === i);
    const inStateDir = places.filter((c) => c.root === 'state');
    const pick = inStateDir.length ? inStateDir : places;
    if (pick.length !== 1) {
      const why = pick.length ? 'it names more than one place for the file' : 'the two paths differ, so a file saved where the question says would never clear it';
      return { ok: false, why: `the question names ${named.map((f) => `"${filePath(f.cond)}"`).join(', ')} and the clears-when "${filePath(own)}": ${why}. Name the path the question gives, as an absolute path or $DESK_STATE/<path>` };
    }
    [at] = pick;
  }
  const { person, ...file } = at;
  return { ok: true, cond: named.some((f) => askedAt(q, f.at)) ? { ...file, person: true } : file };
}

// Why condition `c` can never hold while parked ticket `t` stays parked, or null. That is the ticket's
// own PR leaving draft or merging while the last recorded pr_status says it is a draft: no pass undrafts
// a parked ticket's PR, so the condition waits on the person the park would no longer ask.
export function ownDraftWhy(c, t) {
  if ((c?.kind !== 'pr-ready' && c?.kind !== 'pr-merged') || c.repo) return null;
  const s = t?.pr_status;
  if (s?.pr == null || Number(s.pr) !== Number(c.pr) || s.isDraft !== true || s.state !== 'OPEN') return null;
  return `PR #${c.pr} is ${t.key ?? 'this ticket'}'s own draft, and the park itself keeps it in draft: no pass undrafts a parked ticket's PR, so "${describeCond(c)}" holds only once a person acts, and the park waiting on it would ask nobody`;
}

// The condition as it is written, for the report.
export function describeCond(c) {
  switch (c?.kind) {
    case 'pr-merged': return `PR ${c.repo ?? ''}#${c.pr} merged`;
    case 'pr-ready': return `PR #${c.pr} out of draft`;
    case 'ticket-done': return `${c.ticket} done`;
    case 'variable-set': return `repo variable ${c.name} set`;
    case 'run-completed': return `Actions run ${c.run} completed`;
    case 'push-ok': return `git push ${c.lease ? `--force-with-lease=${c.branch}:${c.lease} ` : ''}origin ${c.branch} succeeds`;
    case 'base-contains': return `the batch base contains ${c.branch}`;
    case 'pr-reviewed': return `PR #${c.pr} reviewed by ${c.login} at its head`;
    case 'file-exists': return `file ${filePath(c)} exists`;
    case 'ticket-queued': return `${c.ticket} in a running ${c.repo} batch`;
    case 'checks-pass': return `${(c.checks ?? []).map((n) => `"${n}"`).join(' and ')} passing on PR #${c.pr}'s head`;
    case 'commit-on': return `commit ${c.sha} on origin/${c.branch}`;
    case UNREADABLE: return `"${c.text}", for the decider to restate as a form a pass reads`;
    case 'live-read': return `live read ${(c.reads ?? []).join(', ')} finished`;
    case 'links-made': return `issue links ${(c.links ?? []).map((l) => `${l.key} ${l.type} ${l.other}`).join(', ')} made`;
    default: return 'none';
  }
}

// Whether `sha` is on origin/<branch>, from a clone that has just fetched it. `git(args)` runs git there
// and returns {ok, code, out}. A commit the branch lacks can still land while the branch head is an
// ancestor of it (a push fast-forwards); once the branch has moved to a head that is not, it never can,
// and `never` says so, naming that head. Not on a branch that takes commits by merging PRs (`merges`:
// the default branch, a batch base), whose head moving on is how the commit arrives. The head is read
// once, so a fetch moving the ref between the two checks cannot read as neither.
export function commitOnBranch(git, sha, branch, { merges = false } = {}) {
  const not = { holds: false, note: `${sha} is not on origin/${branch} yet` };
  if (!git(['cat-file', '-e', `${sha}^{commit}`]).ok) return not;
  const ref = `origin/${branch}`;
  const tip = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!tip.ok) throw new Error(`git rev-parse ${ref}: ${String(tip.out).split('\n').pop() || 'no such ref'}`);
  const head = String(tip.out).trim();
  const isAncestor = (a, b) => {
    const r = git(['merge-base', '--is-ancestor', a, b]);
    if (r.ok) return true;
    if (r.code === 1) return false;
    throw new Error(`git merge-base ${a} ${b}: ${String(r.out).split('\n').pop()}`);
  };
  if (isAncestor(sha, head)) return { holds: true };
  if (merges || isAncestor(head, sha)) return not;
  return { holds: false, never: `the branch ${ref} has moved to ${head.slice(0, 9)}, which ${sha} does not build on, so ${sha} can no longer land there: the push it waits on is stale` };
}

// Does it hold now? {holds: bool, note?} or {error}. `note` is what the next worker or the report
// needs beside the answer: a finished run's conclusion, or an unfinished one's status. The readers do
// the reading and throw on any failure, so a check that could not run is never read as cleared:
//   pr(n) → {state, isDraft}   ticket(key) → the status category key   variable(name) → bool
//   run(id) → {status, conclusion}   push(c) → {holds, note?}, having tried the push
//   baseContains(branch) → {holds, note?}, the note saying how far behind the base is and why
//   link({key, type, other}) → bool, the link is on Jira
//   reviews(n) → {headRefOid, reviews: [{author: {login}, commit: {oid}}]}
//   file(c) → bool, the file condPath names is there
//   queued(ticket, repo) → {holds, note?}, queuedIn over this computer's other queues
//   checks(n) → {headRefOid, checks: [{name, workflow, status, conclusion}]}, the latest run of each
//              check on the head (gate.mjs latestPerCheck over normaliseRollup)
//   commitOn(sha, branch) → {holds, note?, never?}, having fetched origin's branch (commitOnBranch)
// A result with `never` can never hold: the pass gives the park to the person, saying why.
export function checkCond(c, read) {
  try {
    switch (c?.kind) {
      case 'pr-merged': return { holds: read.pr(c.pr, c.repo).state === 'MERGED' };
      case 'pr-ready': { const p = read.pr(c.pr); return { holds: p.state === 'MERGED' || (p.state === 'OPEN' && p.isDraft === false) }; }
      case 'ticket-done': return { holds: read.ticket(c.ticket) === 'done' };
      case 'variable-set': return { holds: read.variable(c.name) === true };
      case 'run-completed': {
        const r = read.run(c.run);
        if (!r?.status) throw new Error(`gh run view ${c.run}: no status`);
        return r.status === 'completed'
          ? { holds: true, note: `conclusion ${r.conclusion || 'none'}` }
          : { holds: false, note: `still ${r.status}` };
      }
      case 'push-ok': return read.push(c);
      case 'base-contains': return read.baseContains(c.branch);
      case 'pr-reviewed': {
        const p = read.reviews(c.pr);
        if (!p?.headRefOid) throw new Error(`gh pr view ${c.pr}: no head commit`);
        const theirs = (p.reviews ?? []).filter((r) => sameLogin(r?.author?.login, c.login));
        if (theirs.some((r) => r?.commit?.oid === p.headRefOid)) return { holds: true };
        return { holds: false, note: theirs.length ? `${c.login}'s review is on an older commit than the head ${p.headRefOid.slice(0, 9)}` : `no review by ${c.login} yet` };
      }
      case 'file-exists': return { holds: read.file(c) === true };
      case 'ticket-queued': return read.queued(c.ticket, c.repo);
      case 'checks-pass': {
        const p = read.checks(c.pr);
        if (!p?.headRefOid) throw new Error(`gh pr view ${c.pr}: no head commit`);
        const head = p.headRefOid.slice(0, 9);
        const behind = (c.checks ?? []).flatMap((name) => {
          const runs = (p.checks ?? []).filter((r) => sameCheck(r, name));
          if (!runs.length) return [`"${name}" has not run`];
          const bad = runs.find((r) => checkState(r) !== 'success');
          return bad ? [`"${name}" is ${checkState(bad)}`] : [];
        });
        return behind.length ? { holds: false, note: `${behind.join(', ')} at ${head}` } : { holds: true, note: `at ${head}` };
      }
      case 'commit-on': return read.commitOn(c.sha, c.branch);
      case 'links-made': return { holds: (c.links ?? []).length > 0 && c.links.every((l) => read.link(l) === true) };
      default: return { holds: false };
    }
  } catch (e) { return { error: String(e?.message ?? e).trim().split('\n').pop() || 'the check failed' }; }
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

// The --check command, for this file and queue.mjs clears-when --check: checkLine on `args` against
// this repo, printed, exiting 0 or 1.
export async function runCheck(args) {
  let here = null;
  try { here = (await import('./desk-env.mjs')).ghRepo(); } catch { /* outside a desk repo: no repo is this one */ }
  const r = checkLine(args.join(' '), { here });
  (r.ok ? console.log : console.error)(r.text);
  process.exit(r.ok ? 0 : 1);
}

// A worker's check: its settings allow this, and never queue.mjs.
if (isMain) {
  if (process.argv[2] !== '--check') { console.error('usage: clears-when.mjs --check "<condition>"'); process.exit(2); }
  await runCheck(process.argv.slice(3));
}
