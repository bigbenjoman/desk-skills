// suite: park words (a worker's park question in plain words for needs-you, its not-reached list cut off)
// covers: desk/bin/park-words.mjs desk/bin/config-schema.mjs desk/bin/batch-state.mjs desk/bin/undraft.mjs
// park-words.mjs on park questions as workers wrote them, the SV-4017 one from 2026-11-19 among them, and
// on the classifiers in batch-state.mjs still reading the raw question. One check or more per criterion
// of DS-806; needs-you's own wording of these items is in test_needs_you.mjs.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const { parkWords, plainTerms } = await import(join(BIN, 'park-words.mjs'));
const { sessionPark, neverStep } = await import(join(BIN, 'batch-state.mjs'));
const { parkOnlyNames } = await import(join(BIN, 'undraft.mjs'));

// What AC1 rules out of a need: lane letters, §3 grant ids, stage numbers, AC numbers and desk's queue words.
const JARGON = /\blanes? [A-D]\b|\b[a-z]+(?:-[a-z]+)+ is not granted\b|§\s?\d|\bstage \d|\b4b\b|\bAC\s?\d|\brequeu|\bspine\b|\bnot reached\b/i;

// The SV-4017 park from 2026-11-19, as the ticket quotes it.
const SV4017 = 'SV-4017 needs two new Merl dependencies and worker-dependency-install is not granted. Please run `bun add --cwd apps/merl @aws-sdk/client-s3 @aws-sdk/lib-storage` and requeue. Not reached: Merl\'s pipeline tools and tests (AC1–AC4), Stage 4 verify, 4b self-review, push, draft PR, review post, Jira comment, Jira transition to Review/QA.';
const sv = parkWords(SV4017);
t('AC1 SV-4017 says what is blocked and what to do in plain words', sv,
  "SV-4017 needs two new Merl dependencies and workers can't install packages. Please run `bun add --cwd apps/merl @aws-sdk/client-s3 @aws-sdk/lib-storage` and send it back to a worker.");
t('AC1 SV-4017 leaves no internal term', JARGON.test(sv), false);
t('AC1 SV-4017 is two sentences at most', sv.split(/(?<=[.?!])\s+/).length <= 2, true);
t('AC3 SV-4017\'s raw question keeps its not-reached list for the worker log', /Not reached: Merl's pipeline/.test(SV4017), true);
t('AC2 SV-4017 is no aws park: its "@aws-sdk" packages are no aws command', `${neverStep(SV4017)} ${sessionPark(SV4017)}`, 'null false');

// A lane C demotion on a refused grant and an AC, with a "Steps not reached" tail.
t('AC4 a lane, a grant id with its value and an AC are put in plain words',
  parkWords('Demoted to lane C: config §3 `staging-write` is `no` and AC3 needs a staging row. Steps not reached: Stage 7 PR, Stage 8 Jira'),
  "Demoted to plan-first work: workers can't write to staging and one of the ticket's requirements needs a staging row.");

// A spine park on a lane C/D ticket with an AC list and another config row.
const SPINE = parkWords('lane C/D: the spine check failed on AC2 and AC5; §4 Staging is none, so approve the specs as they are?');
t('AC4 the spine, an AC list and a § row are put in plain words', SPINE,
  "plan- or design-first work: the acceptance-spec check failed on the ticket's requirements; the desk config's Staging is none, so approve the specs as they are?");
t('AC4 no internal term is left', JARGON.test(SPINE), false);

// Grants: one with no words of its own, one written bare, and every config grant.
t('AC4 an unnamed grant is the desk config', plainTerms('config §3 `pr-review-others` is "ask", so the review waits for Stage 4b self-review and Stage 3 implement.'),
  'your desk config does not allow it, so the review waits for self-review and the build.');
t('AC4 a bare grant id the config defines is put in plain words', plainTerms('read-figma is not granted. Can you export the frame?'),
  'your desk config does not allow it. Can you export the frame?');
t('AC4 a requeued park reads as sent back', plainTerms('It was requeued once; requeuing it again would only park.'),
  'It was sent back to a worker once; sending it back to a worker again would only park.');

// Commands, paths and a product's own words are left as written.
t('AC4 a command in backticks is never reworded', plainTerms('Run `git push --force-with-lease=fix/DS-604-requeue-parked:abc origin fix/DS-604-requeue-parked` and `node desk/bin/spine-check.mjs`'),
  'Run `git push --force-with-lease=fix/DS-604-requeue-parked:abc origin fix/DS-604-requeue-parked` and `node desk/bin/spine-check.mjs`');
t('AC4 a branch or package name outside backticks is left whole', plainTerms('Branch fix/DS-604-requeue-parked needs @acme/worker-screenshots'),
  'Branch fix/DS-604-requeue-parked needs @acme/worker-screenshots');
t('AC4 a product\'s own stage and lanes keep their words', plainTerms('Should stage 2 of the billing migration change which lanes a driver sees?'),
  'Should stage 2 of the billing migration change which lanes a driver sees?');

// The not-reached list goes; a request with it, or after it, stays.
t('AC3 "not reached" in prose is no list', parkWords('The cron has not reached this row yet. Should I keep it?'), 'The cron has not reached this row yet. Should I keep it?');
t('AC3 a question that is only a not-reached list keeps an empty need', parkWords('Not reached: the PR'), '');
t('AC3 a question with none is unchanged', parkWords('Which colour should the badge be?'), 'Which colour should the badge be?');
t('AC3 a "(not reached: …)" aside is cut, bracket and all', parkWords('Need the fee table from finance (not reached: the PR, the Jira comment).'), 'Need the fee table from finance.');
t('AC3 a tail holding a request is kept', parkWords('Need gateway-models. Not reached: the PR, so confirm the fee.'), 'Need gateway-models. Not reached: the PR, so confirm the fee.');
t('AC3 a question after the tail is kept', parkWords('Need the logo. Not reached: the PR. Which colour?'), 'Need the logo. Which colour?');
t('AC3 a "Remaining steps" tail is cut too', parkWords('Need the logo. Remaining steps: the PR, the Jira comment.'), 'Need the logo.');

// The raw question stays the classifiers': only needs-you's copy is reworded.
t('the raw lane C question is still a session park', sessionPark('Demoted to lane C: the plan needs agreeing'), true);
t('the raw aws question still names its never step', neverStep('aws is refused to workers, so the upload cannot run'), 'aws');
// undraft.mjs reads the same tail: a tail of steps only passes, one holding a request does not.
const namesGate = (s) => /\bgate\b/.test(s);
t('undraft still reads a tail of steps as the tail', parkOnlyNames('Re-run the gate. Not reached: the PR, the Jira comment.', namesGate), true);
t('undraft still refuses a tail holding a request', parkOnlyNames('Re-run the gate. Not reached: the Jira comment, so confirm the fee.', namesGate), false);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
