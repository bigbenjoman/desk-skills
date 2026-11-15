// suite: person step (how a step only the person takes holds the ticket it blocks: merge, build or neither)
import { personStep, labelPark } from '../desk/bin/batch-state.mjs';
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

process.exit(fails ? 1 : 0);
