// suite: desk-setup from another repo (one table to confirm, the forced rows settled unasked)
// covers: skills/desk-setup/SKILL.md skills/desk-setup/references/step-2-interview.md
// What /desk-setup says when it starts from another repo's answers: the rows this repo forces are set
// without a question, the rest are shown as one table to use, edit or ask row by row, and the red
// flags still stop a copied `yes` that was never shown.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const skill = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'desk-setup');
const flat = (s) => s.replace(/\s+/g, ' ');
const core = flat(readFileSync(join(skill, 'SKILL.md'), 'utf8'));
const step2 = flat(readFileSync(join(skill, 'references/step-2-interview.md'), 'utf8'));
const part = (() => { const i = step2.indexOf('**Starting from another repo**'); return i < 0 ? '' : step2.slice(i, step2.indexOf('**Before the autopilot round', i)); })();
const has = (text, s) => text.includes(s);

t('#827 step 2 has a section for a start from another repo', part.length > 0, true);
t('#827 the rows this repo forces are settled unasked, saying which and why', ['Settle, unasked, the rows this repo forces, and say which and why', 'the Jira rounds when §4 Tracker is `none`', '`pr-auto-merge` when §4 Repo merge settings have auto-merge off'].map((s) => has(part, s)), [true, true, true]);
t('#827 every other row is one table, with what each yes unlocks here', ['Show every other row in one table', "the start-point repo's answer", 'what it unlocks and exposes **in this repo**'].map((s) => has(part, s)), [true, true, true]);
t('#827 one question: use it, edit some rows, or ask every row', ['One `AskUserQuestion`: use the table as shown (Recommended), edit some rows', 'or ask every row'].map((s) => has(part, s)), [true, true]);
t('#827 step 0 points there instead of one question per row', [has(core, '**§3 / §3b as one table to confirm or edit**'), has(core, 'as the first option of each question')], [true, false]);
t('#827 the red flags still stop a copied yes never shown', [has(core, 'or copy one from another repo without showing it in the table they confirmed'), has(core, 'outside the start-point table, which shows every row and its value')], [true, true]);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
