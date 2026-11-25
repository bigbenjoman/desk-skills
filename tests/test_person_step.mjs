// suite: person step (how a step only the person takes holds the ticket it blocks: merge, build or neither)
// layer: L1
import { personStep, labelPark, blockerCall, blockerHold, uncalledBlockers } from '../desk/bin/batch-state.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const STEP = ['ben-step'];
const INPUT = ['ben-input'];
const b = (o = {}) => ({ key: 'OPS-2', category: 'new', type: 'Story', summary: 'Run the cdk deploy for the queue stack', ...o });
const rec = (...steps) => ({ ben_steps: steps.map(([step, blocker]) => ({ step, blocker })) });

t('a Person-step label holds the merge', personStep(b({ labels: ['ben-step'] }), null, STEP, INPUT), 'merge');
t('a Person-input label holds the build', personStep(b({ labels: ['Ben-Input'] }), null, STEP, INPUT), 'build');
t('labelled both, the input wins', personStep(b({ labels: ['ben-step', 'ben-input'] }), null, STEP, INPUT), 'build');
t('an input label wins over a ben_steps match and a step word', personStep(b({ type: 'Task', summary: 'Apply the key', labels: ['ben-input'] }), rec(['x', 'OPS-2']), STEP, INPUT), 'build');
t('a ben_steps entry naming the blocker key holds the merge', personStep(b({ summary: 'Queue stack' }), rec(['a cdk deploy', 'OPS-2, unblocking P-2']), STEP, INPUT), 'merge');
t('a key match is on the whole key, not a longer one', personStep(b({ summary: 'Queue stack' }), rec(['a cdk deploy', 'OPS-20, unblocking P-2'])), null);
t('a ben_steps entry holding the whole summary holds the merge', personStep(b(), rec(['cdk deploy', 'Run the  cdk deploy for the queue stack, unblocking P-2'])), 'merge');
t('the old inverted match, a step inside the summary, is no longer one', personStep(b({ summary: 'Deploy the search page' }), rec(['deploy', 'deploy'])), null);
t('a one-word summary inside a longer word of the step is not one', personStep(b({ summary: 'Log' }), rec(['upload the catalog', 'catalog upload'])), null);
t('with no labels, a Task whose summary says apply holds the merge', personStep(b({ type: 'Task', summary: 'Apply the billing migration to production' })), 'merge');
t('a Story whose summary says apply is not one by its words', personStep(b({ type: 'Story', summary: 'Apply the billing migration' })), null);
t('an ordinary dev blocker is none', personStep(b({ type: 'Task', summary: 'Add the export endpoint' }), rec(['a cdk deploy', 'deploy the stack']), STEP, INPUT), null);
t('nothing given is none', personStep({}), null);
t('labels with no labels rows are not read', personStep(b({ summary: 'Queue stack', labels: ['ben-step', 'ben-input'] })), null);

t('a ticket carrying an input label parks as the person\'s step, naming the row',
  labelPark({ labels: ['ben-input'] }, STEP, INPUT), "the person's step: labelled ben-input (config §4 Person-input labels), so no worker can do it. Take the step, mark it Done in Jira, then drop it from the batch");
t('a ticket carrying a step label parks as before', String(labelPark({ labels: ['ben-step'] }, STEP, INPUT)).startsWith("the person's step: labelled ben-step (config §4 Person-step labels)"), true);
t('with the input row unset, a step label still parks', String(labelPark({ labels: ['ben-step'] }, STEP)).startsWith("the person's step: labelled ben-step"), true);
t('an unlabelled ticket does not park', labelPark({ labels: ['frontend'] }, STEP, INPUT), null);

// DS-687: triage's call on each open blocker, read once for plan-batch and intake, and how it meets a step.
const called = (needs, o = {}) => ({ ...o, blocker_needs: { 'OPS-2': { needs, why: 'w' } } });
const hold = (r, blocker = b()) => { const h = blockerHold(blocker, r, STEP, INPUT); return h ? `${h.needs}/${h.by}` : null; };
for (const v of ['build', 'merge', 'none']) t(`the call ${v} reads as ${v}`, blockerCall(called(v), 'OPS-2')?.needs, v);
t('AC7: a record from before the calls reads true as build', blockerCall(called(true), 'OPS-2')?.needs, 'build');
t('AC7: and false as none', blockerCall(called(false), 'OPS-2')?.needs, 'none');
t('a value not among the calls is no call', blockerCall(called('later'), 'OPS-2'), null);
t('no entry is no call', blockerCall({}, 'OPS-2'), null);
t('an empty why reads as no reason given', blockerCall({ blocker_needs: { 'OPS-2': { needs: 'none' } } }, 'OPS-2')?.why, 'no reason given');
t('with no step, the call decides', hold(called('merge')), 'merge/triage');
t('with neither a step nor a call, nothing decides', hold({}), null);
t('AC6: a step label (merge) called build is a full hold', hold(called('build'), b({ labels: ['ben-step'] })), 'build/triage');
t('AC6: a step label (merge) called none is still a merge-only gate', hold(called('none'), b({ labels: ['ben-step'] })), 'merge/step');
t('AC6: an input label (build) called none or merge is still a full hold', [hold(called('none'), b({ labels: ['ben-input'] })), hold(called('merge'), b({ labels: ['ben-input'] }))].join(' '), 'build/step build/step');
t('AC6: a step label and a merge call agree, read as the step', hold(called('merge'), b({ labels: ['ben-step'] })), 'merge/step');
const facts = { blockers: [{ key: 'X-1', category: 'new' }, { key: 'X-2', category: 'indeterminate' }, { key: 'X-3', category: 'done' }] };
t('AC1: an open blocker with no call is named', uncalledBlockers({ ...facts, blocker_needs: { 'X-1': { needs: 'build' } } }).join(','), 'X-2');
t('AC1: a Done blocker needs no call', uncalledBlockers({ ...facts, blocker_needs: { 'X-1': { needs: 'build' }, 'X-2': { needs: 'none' } } }).join(','), '');
t('AC1: a record with no blockers listed names none', uncalledBlockers({}).join(','), '');

process.exit(fails ? 1 : 0);
