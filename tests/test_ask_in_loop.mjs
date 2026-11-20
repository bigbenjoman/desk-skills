// suite: asking in the pass loop (a question that comes up while passes run goes to needs-you, never a prompt that waits)
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

t('the core sends no carousel in the pass loop, and says why', core.includes('**except in the pass loop**: a carousel there waits for the user and runs no pass until they answer, so one arising there goes to needs-you and the loop goes on (`ask-or-take.md` *In the pass loop*)'), true);
t('ask-or-take has the section the core names', take.includes('## In the pass loop'), true);
t('a question there never goes to a prompt that waits', take.includes('never goes to an `AskUserQuestion` carousel or any other prompt that waits'), true);
t('a §3 ask the pass reports is one of them', take.includes('a §3 `ask` the pass reports, such as a conflict under `pr-conflict-reviewed`'), true);
t('a ticket\'s question parks the ticket with its options', take.includes('park the ticket on it (`queue.mjs park <TICKET> "<question, with each option and your recommendation>"`)'), true);
t('anything else is a needs-you ask, pushed', take.includes('`node ~/.claude/desk/bin/needs-you.mjs ask <repo> "<question, with each option and your recommendation>"`, and send it in this pass\'s `PushNotification`'), true);
t('the loop keeps running passes for every other ticket', take.includes('keep running passes for every other ticket'), true);
t('a carousel stays for Stage 3 and a user in the conversation', take.includes("A carousel stays right where nothing waits on it: Stage 3's round, before the loop, and a question the user asks you, or answers, while they are in the conversation with you."), true);
t('the paragraph on questions with no recommendation moved whole', take.includes('## Questions with no recommendation Two have no recommendation to give') && !core.includes('Two have no recommendation to give'), true);

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
