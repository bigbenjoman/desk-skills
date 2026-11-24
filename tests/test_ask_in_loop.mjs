// suite: asking in the pass loop (a question that comes up while passes run goes to needs-you, never a prompt that waits)
// layer: L1
// covers: skills/desk-autopilot/SKILL.md skills/desk-autopilot/references/ask-or-take.md
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\s+/g, ' ');
const core = read('skills/desk-autopilot/SKILL.md');
const take = read('skills/desk-autopilot/references/ask-or-take.md');

t('the core sends no carousel in the pass loop, and says why', core.includes('**except in the pass loop**: a carousel there waits for the user and runs no pass until they answer, so one arising there is parked or reported and the loop goes on (`ask-or-take.md` *In the pass loop*)'), true);
t('ask-or-take has the section the core names', take.includes('## In the pass loop'), true);
t('a question there never goes to a prompt that waits', take.includes('never goes to an `AskUserQuestion` carousel or any other prompt that waits'), true);
t('a §3 ask the pass reports is one of them', take.includes('a §3 `ask` the pass reports, such as a conflict under `pr-conflict-reviewed`'), true);
t('a ticket\'s question parks the ticket with its options', take.includes('park that ticket on it (`queue.mjs park <TICKET> "<question, with each option and your recommendation>"`)'), true);
t('the park reaches the person through needs-you and the digest, never pushed on its own', take.includes('desk-needs-you lists it, and the next check-in digest carries it; a park is never pushed on its own (*Notify*)'), true);
t('the answer is only recorded: the orchestrator requeues', take.includes('is only recorded: requeue the ticket yourself once it is in (Stage 5)'), true);
t('a batch-wide call no ticket waits on stays in the report, and the loop runs without it', take.includes('put it in your report and the status table, with each option and your recommendation, and run the loop without it'), true);
t('never a needs-you ask, which has no answer to read', take.includes('Never `needs-you.mjs ask`: that records a step for the person to take, with no answer for the loop to read'), true);
t('the loop keeps running passes for every other ticket', take.includes('Keep running passes for every other ticket'), true);
t('a carousel stays for Stage 3 and a user in the conversation', take.includes("A carousel stays right where nothing waits on it: Stage 3's round, before the loop, and a question the user asks you, or answers, while they are in the conversation with you."), true);
t('the paragraph on questions with no recommendation moved whole', take.includes('## Questions with no recommendation Two have no recommendation to give') && !core.includes('Two have no recommendation to give'), true);

t('#1341 a step only the person takes is recorded as an ask with a recommended default', take.includes('**A step only the person takes** (file, sign in, merge by hand): record it at once with `needs-you.mjs ask <repo> "<the step, and your recommended default>"`'), true);
t('#1341 a wait on tickets is recorded with --until, never a step still owed after they merge', take.includes('One that waits on tickets happening (`--until <TICKET>[,<TICKET>...]`) is dropped by the pass once they are all merged or done') && take.includes('never for a step the person still owes once they merge'), true);
t('#1341 a wait on the person lives only as a needs-you item, never in the loop prompt', take.includes('**A wait on the person lives only as a needs-you item, never as a line in your `/loop` prompt.**') && take.includes('Your loop prompt, a pending note, a handoff or a summary is read by no one but you'), true);
t('#1341 an admit is the desk\'s own step, never held for the person to say admit', take.includes('**An admit is the desk\'s own step, never a wait on the person.**') && take.includes('Never hold one for the person to say "admit"'), true);

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
