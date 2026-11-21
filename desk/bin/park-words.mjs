// A worker's park question as needs-you shows it to the person: in plain words, without the list of
// steps the worker did not reach. The raw question stays on the queue's park.question, since the
// classifiers in batch-state.mjs (sessionPark, neverStep, personOnlyStep, noWorkerWork) match on desk's
// own terms there, and the worker log keeps the whole AUTOPILOT_PARK line, not-reached list and all.
//
//   parkWords(question) -> { text, notReached }
//
// `text` is the question with desk's internal terms (lane letters, config §3 grant ids, stage numbers,
// AC numbers, requeue, spine, § row references) put in plain words; `notReached` is the not-reached
// list cut off its end, or '' where it names none.

// The trailing list of steps a park did not reach: "Not reached: …", "Steps not reached: …", "Not yet
// reached — …", to the end of the question. A colon or dash must follow, so prose saying something was
// "not reached" by a step is left alone.
const NOT_REACHED = /(?:^|[\s.;,])(\(?(?:(?:the )?steps? (?:i )?(?:did |have |had )?)?not (?:yet )?reached\s*(?:[:—–]|-\s))/i;

export function splitNotReached(question) {
  const q = String(question ?? '');
  const m = NOT_REACHED.exec(q);
  if (!m) return { text: q, notReached: '' };
  const at = m.index + m[0].length - m[1].length;
  const head = q.slice(0, at).replace(/[\s,;:(—–-]+$/, '');
  const notReached = q.slice(at + m[1].length).trim().replace(/[\s).]+$/, '');
  return { text: head && !/[.?!]$/.test(head) ? `${head}.` : head, notReached };
}

// What a config §3 grant lets a worker do, in plain words, for the grants a worker's park names. A
// grant missing here is called "a setting in your desk config".
export const GRANT_WORDS = {
  'worker-dependency-install': 'install packages',
  'worker-local-services': 'start local services',
  'worker-screenshots': 'take screenshots',
  'worker-web-read': 'read web pages',
  'worker-workflow-dispatch': 'start GitHub workflows',
  'git-push': 'push',
  'git-force-with-lease': 'force-push',
  'pr-open': 'open a PR',
  'pr-edit': 'edit a PR',
  'pr-images': 'add screenshots to a PR',
  'pr-self-review-comment': 'post their review on a PR',
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

// A grant id as the worker writes it: optionally "config §3", optionally in backticks or quotes.
const grantRe = (key) => String.raw`(?:(?:the )?(?:config )?§3 )?[\`"']?${key.replace(/[-]/g, '\\-')}[\`"']?`;
// "… is not granted", "… is `no`", "… is \"ask\"", "… is not yes", "… is not `yes`", "… is off".
const NOT_GRANTED = String.raw`\s+(?:is|was)\s+(?:not\s+granted|not\s+[\`"']?yes[\`"']?|[\`"']?(?:no|ask|off|unset)[\`"']?(?:\s+for\s+workers)?)(?:\s+in\s+(?:the|this repo's|your)\s+config)?`;
// Any §3-style grant id, for a grant GRANT_WORDS does not name.
const ANY_GRANT = /(?:(?:the )?(?:config )?§3 )[`"']?([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[`"']?/g;

function grantsPlain(s) {
  let out = s;
  for (const [key, words] of Object.entries(GRANT_WORDS)) {
    out = out.replace(new RegExp(grantRe(key) + NOT_GRANTED, 'gi'), `workers can't ${words}`);
    out = out.replace(new RegExp(String.raw`(?<![\w-])${grantRe(key)}(?![\w-])`, 'gi'), `the setting that lets workers ${words}`);
  }
  return out.replace(new RegExp(ANY_GRANT.source + NOT_GRANTED, 'gi'), 'your desk config does not allow it')
    .replace(ANY_GRANT, 'a setting in your desk config');
}

// The stages of desk-ticket, as the step each one is.
const STAGES = { 0: 'triage', 1: 'branching', 2: 'investigation', 3: 'the build', 4: 'testing', '4b': 'self-review',
  5: 'screenshots', 6: 'tidy-up', 7: 'the PR', 8: 'the Jira update', 9: 'cleanup' };
const STAGE_NAMES = 'triage|branch|understand|implement|verify|self-review|evidence|hygiene|PR|Jira|cleanup';
const STAGE = new RegExp(String.raw`\bstage\s+(\d)(b?)(?:\/9)?(?:\s+(?:${STAGE_NAMES})\b)?`, 'gi');

// Each internal term and its plain words, applied in order.
const TERMS = [
  // Stage numbers, and a "4b self-review" written without the word Stage.
  [STAGE, (m, n, b) => STAGES[`${n}${b.toLowerCase()}`] ?? 'a later step'],
  [/\b4b\s+self-review\b/gi, 'self-review'],
  // AC numbers: a bracketed list says nothing the person needs, so it goes; otherwise the requirement.
  [/\s*\((?:AC\s?\d+(?:\s*(?:[–—-]|to|,|and|&)\s*(?:AC\s?)?\d+)*)\)/gi, ''],
  [/\bACs?\s?\d+\s*(?:[–—-]|to)\s*(?:AC\s?)?\d+\b/gi, "the ticket's requirements"],
  [/\bAC\s?\d+(?:\s*(?:,|and|&)\s*(?:AC\s?)?\d+)+\b/gi, "the ticket's requirements"],
  [/\bAC\s?\d+\b/gi, "one of the ticket's requirements"],
  // Lane letters.
  [/\blanes?\s+(?:C\s*\/\s*D|C or D|D or C)\b/gi, 'plan- or design-first work'],
  [/\blane\s+C\b/gi, 'plan-first work'],
  [/\blane\s+D\b/gi, 'design-first work'],
  [/\blanes?\s+(?:A\s*\/\s*B|A or B|[AB])\b/gi, 'routine work'],
  // Queue and check terms.
  [/\ba requeue\b/gi, 'sending it back to a worker'],
  [/\brequeu(?:e|ing)\s+(it|this|them)\b/gi, (m, o) => `${/^requeuing/i.test(m) ? 'sending' : 'send'} ${o} back to a worker`],
  [/\brequeued\b/gi, 'sent back to a worker'],
  [/\brequeu(?:e|ing)\b/gi, (m) => (/^requeuing/i.test(m) ? 'sending it back to a worker' : 'send it back to a worker')],
  [/\bthe spine(?: check)?\b/gi, 'the acceptance-spec check'],
  [/\bspine\b/gi, 'acceptance-spec'],
  // Any other config row: "§4 Package manager" is the config's Package manager.
  [/(?:\bconfig\s+)?§\s?\d+b?\s+/g, "the desk config's "],
  [/(?:\bconfig\s+)?§\s?\d+b?\b/g, 'the desk config'],
];

// The question in plain words, or the empty string for none.
export function plainTerms(text) {
  let s = grantsPlain(String(text ?? ''));
  for (const [re, to] of TERMS) s = s.replace(re, to);
  return s.replace(/\s+([,.;:?!])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

export function parkWords(question) {
  const { text, notReached } = splitNotReached(String(question ?? '').replace(/\s+/g, ' ').trim());
  return { text: plainTerms(text), notReached };
}
