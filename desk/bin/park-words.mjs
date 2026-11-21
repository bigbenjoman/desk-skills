// A worker's park question as needs-you shows it to the person: in plain words, without the list of
// steps the worker did not reach. The raw question stays on the queue's park.question, since the
// classifiers in batch-state.mjs (sessionPark, neverStep, personOnlyStep, noWorkerWork) match on desk's
// own terms there, and the worker log keeps the whole AUTOPILOT_PARK line, not-reached list and all.
//
//   parkWords(question) -> the question in plain words, its not-reached list left out
//   plainTerms(text)    -> the text with desk's internal terms in plain words
//   tailSteps(clause)   -> what a not-reached clause lists after its marker, or null (undraft.mjs reads it too)
//
// Desk's terms are lane letters, config §3 grant ids, stage numbers, AC numbers, requeue, the spine
// check and § row references. Text in backticks is a command or a path, and is never reworded.
import { PERMISSION_KEYS } from './config-schema.mjs';

// ---- the not-reached tail
// A park's clauses: each ends at . ? ! ; followed by a space, or at a line break, so a command's own dots
// stay whole, and each keeps its own end mark, so a tail clause can tell a question from a list.
export const parkClauses = (question) => String(question ?? '').split(/(?<=[.?!;])(?:\s+|$)|\n+/).map((s) => s.trim()).filter(Boolean);

const MARKER = String.raw`(?:the )?(?:steps? )?(?:not (?:yet )?reached|remaining steps?|steps? remaining)`;
const TAIL_START = new RegExp(String.raw`^\(?${MARKER}\b`, 'i');
// What a clause opening with the tail's marker lists after it, or null where it does not open with one
// or asks something (a "?"). undraft.mjs then checks every word is a step's; needs-you checks no item
// is a request (listTail).
export function tailSteps(clause) {
  const s = String(clause ?? '').trim();
  if (s.includes('?')) return null;
  const m = TAIL_START.exec(s);
  return m ? s.slice(m[0].length).replace(/[.!;)]*$/, '') : null;
}

// A tail item is a step only when it names one (STEP) and opens with no request (ASK): "Not reached:
// the PR, so confirm the fee" and "…, provide the fee to use" still ask for the fee, so they stay.
const STEP = /\b(?:prs?|draft|reviews?|self-review|desk-review|comments?|post|jira|tracker|ticket|transitions?|state|status|done|screenshots?|images?|upload|evidence|push|commit|merge|rebase|branch|tests?|verify|verification|typecheck|lint|build|implement\w*|tools?|stages?|hygiene|cleanup|handoff|deploy\w*|preview|qa|changelog|docs?|codex|specs?)\b/i;
const ASK = /^(?:so|but|please|confirm|choose|pick|decide|approve|answer|tell|say|send|add|set|give|provide|run|check|which|what|should|can|could|would)\b/i;
// Whether a clause is only the list of steps its worker did not reach: the marker, a colon or dash,
// then steps, every one of them a step.
function listTail(clause) {
  const steps = tailSteps(clause);
  if (steps === null || !/^\s*(?:[:—–]|-\s)/.test(steps)) return false;
  return steps.replace(/^\s*[:—–-]\s*/, '').split(/[,;]|\band\b|\bthen\b/i).map((s) => s.trim()).filter(Boolean)
    .every((s) => STEP.test(s) && !ASK.test(s));
}
// A tail inside a clause: a bracketed aside, "(not reached: the PR, the Jira comment)", or one after a
// comma or dash, "Please add the row — not reached: the PR".
const ASIDE = new RegExp(String.raw`\s*\((${MARKER}\s*(?:[:—–]|-\s)[^()]*)\)`, 'gi');
const AFTER = new RegExp(String.raw`(?:[,;—–]|\s-)\s+(?=${MARKER}\s*(?:[:—–]|-\s))`, 'i');
function cutInner(clause) {
  let c = clause.replace(ASIDE, (m, inner) => (listTail(inner) ? '' : m));
  const at = AFTER.exec(c);
  if (at && listTail(c.slice(at.index + at[0].length))) {
    const end = /[.?!;]$/.exec(c)?.[0] ?? '';
    c = c.slice(0, at.index) + end;
  }
  return c;
}

// ---- desk's terms in plain words
// What each config §3 grant lets a worker do (test_park_words.mjs holds every config grant to a
// line here). needs-you words a row the config lacks with it too.
export const GRANT_WORDS = {
  'read-own-work': 'read your tickets and PRs',
  'read-local-git': 'read local git history',
  'read-others': "read other people's work",
  'read-slack-public': 'read public Slack channels',
  'read-figma': 'read Figma designs',
  'read-vercel': 'read Vercel',
  'read-confluence': 'read Confluence',
  'read-transcripts': 'read meeting transcripts',
  'read-calendar': 'read your calendar',
  'read-slack-own': 'read your Slack messages',
  'jira-close-own-merged': 'close tickets whose PR merged',
  'jira-close': 'close tickets',
  'jira-route': 'route tickets',
  'jira-others': "change other people's tickets",
  'pr-review-others': "review other people's PRs",
  'pr-request-review': 'request reviews',
  'merge-feedback-first': 'merge before review feedback is answered',
  'pr-conflict-unreviewed': 'resolve conflicts on unreviewed PRs',
  'pr-conflict-reviewed': 'resolve conflicts on reviewed PRs',
  'ci-protection': 'change CI protection',
  'gh-close-linked-issue': 'close linked GitHub issues',
  'gh-issue-create': 'create GitHub issues',
  'gh-issue-comment': 'comment on GitHub issues',
  'autopilot-workers': 'run at all',
  'autopilot-worker-mode': 'run in that permission mode',
  'autopilot-merge': 'merge PRs',
  'merge-hold-routine': 'merge routine changes under a merge hold',
  'autopilot-reclaim': 'reclaim stuck work',
  'worktree-remove': 'remove worktrees',
  'branch-delete': 'delete branches',
  'server-stop': 'stop servers',
  'skills-edit': 'edit skills',
  'slack-draft': 'draft Slack messages',
  'slack-send': 'send Slack messages',
  'merge-bypass': 'bypass merge rules',
  'others-prs': "change other people's PRs",
  'product-calls': 'make product calls',
  'legal-content': 'write legal content',
  'worker-dependency-install': 'install packages',
  'worker-local-services': 'start local services',
  'worker-screenshots': 'take screenshots',
  'worker-web-read': 'read web pages',
  'worker-workflow-dispatch': 'start GitHub workflows',
  'git-commit': 'commit',
  'git-push': 'push',
  'git-force-with-lease': 'force-push',
  'pr-open': 'open a PR',
  'pr-edit': 'edit a PR',
  'pr-images': 'add screenshots to a PR',
  'pr-self-review-comment': 'post their review on a PR',
  'pr-reply': 'reply on a PR',
  'pr-ready': 'mark a PR ready',
  'pr-auto-merge': 'turn on auto-merge',
  'pr-merge-green': 'merge a green PR',
  'pr-update-branch': 'update a PR branch',
  'ci-rerun': 'rerun CI',
  'codex-review': 'run a Codex review',
  'jira-comment': 'comment on the ticket',
  'jira-transition': 'move the ticket',
  'jira-edit': 'edit the ticket',
  'jira-create': 'create tickets',
  'jira-assign-self': 'assign the ticket',
  'staging-write': 'write to staging',
  'local-reindex': 'rebuild a shared index',
  'tests-shared-db': 'run tests on a shared database',
  'db-per-ticket': 'make a database',
  'db-clone-staging': 'copy the staging database',
  'vercel-env': 'change Vercel settings',
  'machine-reboot': 'reboot the machine',
  'batch-base-push': 'push the batch base',
  'autopilot-judgement': 'make product, design and wording calls',
};

// Edges a grant id or a desk word must not touch, so one inside a path, a branch or a package name
// ("fix/DS-604-requeue-parked", "@acme/worker-screenshots") is left alone.
const OPEN = String.raw`(?<![\w/.@-])`;
const CLOSE = String.raw`(?![\w/-])`;
// A grant id as the worker writes it: optionally "config §3", optionally in quotes.
const grantRe = (key) => String.raw`(?:(?:the )?(?:config )?§3 )?["']?${key.replace(/[-]/g, '\\-')}["']?`;
// "… is not granted", "… is "no"", "… is "ask"", "… is not yes", "… is off".
const NOT_GRANTED = String.raw`\s+(?:is|was)\s+(?:not\s+granted|not\s+["']?yes["']?|["']?(?:no|ask|off|unset)["']?(?:\s+for\s+workers)?)(?:\s+in\s+(?:the|this repo's|your)\s+config)?`;
// Any §3-style grant id the config does not define either.
const ANY_GRANT = /(?:(?:the )?(?:config )?§3 )["']?([a-z][a-z0-9]*(?:-[a-z0-9]+)+)["']?/g;

function grantsPlain(s) {
  let out = s;
  for (const key of Object.keys(PERMISSION_KEYS)) {
    const words = GRANT_WORDS[key];
    out = out.replace(new RegExp(OPEN + grantRe(key) + NOT_GRANTED, 'gi'), words ? `workers can't ${words}` : 'your desk config does not allow it');
    out = out.replace(new RegExp(OPEN + grantRe(key) + CLOSE, 'gi'), words ? `the setting that lets workers ${words}` : 'a setting in your desk config');
  }
  return out.replace(new RegExp(ANY_GRANT.source + NOT_GRANTED, 'gi'), 'your desk config does not allow it')
    .replace(ANY_GRANT, 'a setting in your desk config');
}

// The stages of desk-ticket, as the step each one is. "Stage 2" is desk's; a lower-case "stage 2" is
// only when its name or "/9" follows, so "stage 2 of the migration" is the ticket's own.
const STAGES = { 0: 'triage', 1: 'branching', 2: 'investigation', 3: 'the build', 4: 'testing', '4b': 'self-review',
  5: 'screenshots', 6: 'tidy-up', 7: 'the PR', 8: 'the Jira update', 9: 'cleanup' };
const STAGE_NAMES = 'triage|branch|understand|implement|verify|self-review|evidence|hygiene|PR|Jira|jira|cleanup';
const stageWords = (m, n, b) => STAGES[`${n}${b}`] ?? 'a later step';

// Each internal term and its plain words, applied in order. Lane letters, stages and ACs are matched
// in desk's own case, so "lanes a driver sees" is a product's.
const TERMS = [
  [new RegExp(String.raw`\bStage\s+(\d)(b?)(?:\/9)?(?:\s+(?:${STAGE_NAMES})\b)?`, 'g'), stageWords],
  [new RegExp(String.raw`\bstage\s+(\d)(b?)(?:\/9(?:\s+(?:${STAGE_NAMES})\b)?|\s+(?:${STAGE_NAMES})\b)`, 'g'), stageWords],
  [/\b4b\s+self-review\b/g, 'self-review'],
  // AC numbers: a bracketed list says nothing the person needs, so it goes; otherwise the requirement.
  [/\s*\((?:AC\s?\d+(?:\s*(?:[–—-]|to|,|and|&)\s*(?:AC\s?)?\d+)*)\)/g, ''],
  [/\bACs?\s?\d+\s*(?:[–—-]|to)\s*(?:AC\s?)?\d+\b/g, "the ticket's requirements"],
  [/\bAC\s?\d+(?:\s*(?:,|and|&)\s*(?:AC\s?)?\d+)+\b/g, "the ticket's requirements"],
  [/\bAC\s?\d+\b/g, "one of the ticket's requirements"],
  [/\b[Ll]anes?\s+(?:C\s*\/\s*D|C or D|D or C)\b/g, 'plan- or design-first work'],
  [/\b[Ll]ane\s+C\b/g, 'plan-first work'],
  [/\b[Ll]ane\s+D\b/g, 'design-first work'],
  [/\b[Ll]anes?\s+(?:A\s*\/\s*B|A or B|[AB])\b/g, 'routine work'],
  [new RegExp(String.raw`${OPEN}a requeue${CLOSE}`, 'gi'), 'sending it back to a worker'],
  [new RegExp(String.raw`${OPEN}requeu(?:e|ing)\s+(it|this|them)\b`, 'gi'), (m, o) => `${/^requeuing/i.test(m) ? 'sending' : 'send'} ${o} back to a worker`],
  [new RegExp(String.raw`${OPEN}requeued${CLOSE}`, 'gi'), 'sent back to a worker'],
  [new RegExp(String.raw`${OPEN}requeu(?:e|ing)${CLOSE}`, 'gi'), (m) => (/^requeuing/i.test(m) ? 'sending it back to a worker' : 'send it back to a worker')],
  [new RegExp(String.raw`${OPEN}the spine(?: check)?${CLOSE}`, 'gi'), 'the acceptance-spec check'],
  [new RegExp(String.raw`${OPEN}spine(?= (?:check|review|park))`, 'gi'), 'acceptance-spec'],
  // Any other config row: "§4 Package manager" is the config's Package manager.
  [/(?:\bconfig\s+)?§\s?\d+b?\s+/g, "the desk config's "],
  [/(?:\bconfig\s+)?§\s?\d+b?\b/g, 'the desk config'],
];

function proseTerms(s) {
  let out = grantsPlain(s);
  for (const [re, to] of TERMS) out = out.replace(re, to);
  return out.replace(/[ \t]+([,.;:?!])/g, '$1').replace(/\s{2,}/g, ' ');
}

// A code span holding only a grant id or a grant's value ("`staging-write` is `no`") is desk's term, not
// a command, so it is quoted instead and reworded with the prose.
const termSpan = (m, w) => (Object.hasOwn(PERMISSION_KEYS, w) || /^(?:yes|no|ask|off|unset)$/.test(w) ? `"${w}"` : m);

// The text in plain words, or the empty string for none. Other code spans pass through as written.
export function plainTerms(text) {
  return String(text ?? '').replace(/`([a-z0-9-]+)`/g, termSpan).split(/(`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : proseTerms(part))).join('').trim();
}

// Code spans are set aside while the tail is cut, so a command's own ". " or "(remaining steps: …)"
// is never taken for the park's.
export function parkWords(question) {
  const spans = [];
  const masked = String(question ?? '').replace(/\s+/g, ' ').trim().replace(/`[^`]*`/g, (m) => `\u0000${spans.push(m) - 1}\u0000`);
  const kept = parkClauses(masked).filter((c) => !listTail(c)).map(cutInner).join(' ');
  return plainTerms(kept.replace(/\u0000(\d+)\u0000/g, (m, i) => spans[Number(i)]));
}
