// suite: priority proposal (a pending proposal on a ticket's priority found at triage, listed once, answered on the ticket)
// layer: L2
// budget: 20 GH-1222
// covers: desk/bin/priority-proposal.mjs desk/bin/needs-you.mjs desk/bin/ticket-facts.mjs
// priorityProposal on labels and descriptions; then one fixture repo under a throwaway HOME, DESK_HOME
// and DESK_CONFIG_ROOT whose admitted ticket's triage record carries a proposal: needs-you lists it as
// one item that holds no work, and an answer writes the priority, the label and a comment through a
// recording desk-jira read, and keeps the answer, so the item goes. Nothing touches your real state.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scratch } from './scratch.mjs';
import { priorityProposal } from '../desk/bin/priority-proposal.mjs';

let fails = 0;
const t = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want), ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${g}${ok ? '' : ` (want ${w})`}`);
};

// ---- finding a proposal ----------------------------------------------------------------------------
const PAT = ['lp-proposed-(p[0-9])'];
const ASK = 'Proposed by the priority bot: promote to P1 if the contract date holds, or reject within one working day.';
t('a label the pattern matches is a proposal, its value from the label', priorityProposal({ labels: ['backend', 'lp-proposed-p1'], description: 'Do the thing.' }, PAT),
  { label: 'lp-proposed-p1', to: 'P1', line: null });
t('the description line asking for it is kept beside the label', priorityProposal({ labels: ['LP-Proposed-P2'], description: `Intro.\n${ASK}` }, PAT),
  { label: 'LP-Proposed-P2', to: 'P2', line: ASK });
t('a description line alone is a proposal, its value from the line', priorityProposal({ labels: [], description: `Intro.\n\n${ASK}` }, []), { label: null, to: 'P1', line: ASK });
t('a pattern with no group takes the value from the description line', priorityProposal({ labels: ['priority-proposal'], description: ASK }, ['priority-proposal']),
  { label: 'priority-proposal', to: 'P1', line: ASK });
t('a label only part of which matches is no proposal', priorityProposal({ labels: ['not-lp-proposed-p1'], description: '' }, PAT), null);
t('a description that promotes nothing is no proposal', priorityProposal({ labels: [], description: 'Promote the banner on the home page.' }, []), null);
t('a pattern that is no regular expression is skipped', priorityProposal({ labels: ['lp-proposed-p1'] }, ['lp-proposed-(p[0-9]', ...PAT]), { label: 'lp-proposed-p1', to: 'P1', line: null });

// ---- the item and its answer -----------------------------------------------------------------------
const T = scratch('desk-proposal-');
const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_LOCK_DIR: join(T, 'locks'), DESK_SKILLS_DIR: join(T, 'skills') };
for (const k of Object.keys(process.env)) if (k.startsWith('DESK_') || k.startsWith('AUTOPILOT_')) delete process.env[k];
Object.assign(process.env, env);
mkdirSync(env.DESK_LOCK_DIR, { recursive: true });
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
const slug = 'acme__prop';
const root = join(T, 'repos', 'prop');
mkdirSync(root, { recursive: true });
spawnSync('git', ['init', '-q', root]);
spawnSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/acme/prop.git']);
mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
  `## 2. Paths\n\n| Field | Value |\n|---|---|\n| Primary repo root | \`${root}\` |\n\n` +
  '## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Batches run by | `supervisor` | `session` |\n\n' +
  '## 4. Repo\n\n| Field | Value |\n|---|---|\n| Tracker | `jira` |\n| Ticket key pattern | `P-[0-9]+` |\n| Priority | `customfield_10300` `P0` `P1` `P2` |\n' +
  '| Priorities only you set | `P0` `P1` |\n| Priority proposal labels | `lp-proposed-(p[0-9])` |\n');
const qf = join(env.DESK_HOME, 'repos', slug, 'queue.json');
mkdirSync(join(env.DESK_HOME, 'repos', slug), { recursive: true });
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
writeFileSync(qf, JSON.stringify({ version: 1, batch: 'prop-batch', concurrency: 2, supervised: false, tickets: {
  'P-1': { key: 'P-1', state: 'running', lane: 'A', added_at: ago(120) },
  'P-2': { key: 'P-2', state: 'running', lane: 'A', added_at: ago(60) },
  'P-3': { key: 'P-3', state: 'running', lane: 'A', added_at: ago(30) },
} }));
const state = join(env.HOME, '.desk-autopilot', slug);
mkdirSync(join(state, 'orchestrators'), { recursive: true });
writeFileSync(join(state, 'orchestrators', 'q.json'), JSON.stringify({ queue: qf, batch: 'prop-batch', pid: 1, at: ago(1) }));
mkdirSync(join(state, 'triage'), { recursive: true });
const triage = (k, v) => writeFileSync(join(state, 'triage', `${k}.json`), JSON.stringify({ ticket: k, epic: null, lane: 'A', size: 'S', ...v }));
triage('P-1', { labels: ['backend', 'lp-proposed-p1'], priority_proposal: { label: 'lp-proposed-p1', to: 'P1', line: ASK } });
triage('P-2', { labels: [], priority_proposal: null });
triage('P-3', { labels: [], priority_proposal: { label: null, to: 'P2', line: 'Raise to P2, or reject it.' } });

const NY = await import('../desk/bin/needs-you.mjs');
const proposals = () => NY.collect({ reads: null }).items.filter((i) => i.kind === 'proposal');
const listed = proposals();
t('one item a ticket with a pending proposal, none for one without', listed.map((i) => i.t.key), ['proposal:P-1', 'proposal:P-3']);
const p1 = listed.find((i) => i.ticket === 'P-1');
t('it names the value, the label and the line asking for it', [/P-1 carries a pending proposal to make its priority P1, from the label lp-proposed-p1 \("Proposed by the priority bot/.test(p1.need), /built either way/.test(p1.need)], [true, true]);
t('promote is the recommended answer, reject and not-now beside it', p1.actions.map(([a, why]) => [a, !!why]), [['promote', true], ['reject', false], ['not-now', false]]);
t('it holds no work: the ticket is still running', JSON.parse(readFileSync(qf, 'utf8')).tickets['P-1'].state, 'running');

// A desk-jira read that records each call.
const calls = [];
const jira = (fail = null) => ({ jira: (r, args) => {
  calls.push(args);
  if (fail && args[0] === fail) throw Object.assign(new Error('desk-jira failed'), { stderr: 'desk-jira: HTTP 400' });
  return 'ok';
} });
const ans = NY.record({ word: 'prop', ticket: 'proposal:P-1', action: 'promote', reads: jira() });
t('promote is recorded', ans.ok, true);
t('it sets the priority field, with --approved for a value only the person sets', calls[0], ['edit', 'P-1', 'customfield_10300=P1', '--approved', 'promoted to P1 through desk-needs-you, answering the pending priority proposal']);
t('it takes the label off with Jira\'s own remove, which leaves every other label as it is', calls[1], ['labels', 'P-1', 'remove', 'lp-proposed-p1']);
t('it comments on the ticket', [calls[2]?.[0], calls[2]?.[1], /promoted: customfield_10300 set to P1, and the label lp-proposed-p1 taken off/.test(calls[2]?.[2] ?? '')], ['comment', 'P-1', true]);
t('the answer is kept on the queue ticket', JSON.parse(readFileSync(qf, 'utf8')).tickets['P-1'].priority_proposal_answer?.answer, 'promote');
t('so it is off the list', proposals().map((i) => i.t.key), ['proposal:P-3']);

calls.length = 0;
const rej = NY.record({ word: 'prop', ticket: 'proposal:P-3', action: 'reject', reads: jira() });
t('reject on a proposal its description makes writes only the comment', [rej.ok, calls.map((c) => c[0])], [true, ['comment']]);
t('and leaves the priority as it was', /rejected: the priority stays as it was\./.test(calls[0]?.[2] ?? ''), true);

// A write that fails keeps the item, saying what was written before it.
triage('P-2', { labels: ['lp-proposed-p2'], priority_proposal: { label: 'lp-proposed-p2', to: 'P2', line: null } });
calls.length = 0;
const failed = NY.record({ word: 'prop', ticket: 'proposal:P-2', action: 'promote', reads: jira('comment') });
t('a comment that fails is said, after the writes made before it, and the item stays', [failed.ok, /the comment failed \(desk-jira: HTTP 400\), after setting customfield_10300 to P2/.test(failed.line), proposals().map((i) => i.t.key)],
  [false, true, ['proposal:P-2']]);
t('a value not only the person sets is written with no --approved', calls[0], ['edit', 'P-2', 'customfield_10300=P2']);

if (fails) { console.log(`${fails} failed`); process.exit(1); }
