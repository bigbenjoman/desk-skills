// suite: desk-setup subscription (each repo asked once which subscription runs it, and no rotation question)
// covers: skills/desk-setup/SKILL.md skills/desk-setup/references/step-1-this-computer.md
// What /desk-setup says about this computer's subscriptions and this repo's Subscription row: the
// question, its options and descriptions in order, the row each answer saves, the cases that ask
// nothing, and that no file of the skill still speaks of rotation.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = join(root, 'skills/desk-setup');
const flat = (s) => s.replace(/\s+/g, ' ');
const core = flat(readFileSync(join(skill, 'SKILL.md'), 'utf8'));
const step1 = readFileSync(join(skill, 'references/step-1-this-computer.md'), 'utf8');
// A `### ` section of step 1, whitespace collapsed so a wrapped line reads as one.
const section = (name) => { const m = step1.match(new RegExp(`^### ${name}\\n([\\s\\S]*?)(?=^### |(?![\\s\\S]))`, 'm')); return m ? flat(m[1]) : ''; };
const computer = section('Subscriptions on this computer');
const repo = section("This repo's subscription");
const bullet = (text, lead) => { const i = text.indexOf(`**${lead}`); return i < 0 ? '' : text.slice(i, text.indexOf(' - **', i + 1) < 0 ? undefined : text.indexOf(' - **', i + 1)); };
const inOrder = (text, parts) => { let at = -1; for (const p of parts) { const i = text.indexOf(p, at + 1); if (i < 0) return `missing or out of order: ${p}`; at = i; } return true; };

t('both sections are found', [computer.length > 0, repo.length > 0], [true, true]);

// AC1 and AC2: the question, the text above the options, then the options and descriptions in order.
const ask = bullet(repo, 'Two or more subscriptions, no row');
t('AC1 the question is asked with the repo name and ends in a question mark', ask.includes('"Which subscription runs <repo name>?"'), true);
t('AC2 the text above the options', ask.includes('with "Workers, triage and the decider for this repo all use it. Change it later in desk-q, view 6." as the text above the options'), true);
t('AC1 the default first, marked Recommended, then one pin per subscription, each with its description', inOrder(ask, [
  "1. `Use this computer's default` (Recommended), described as `<the default's email> · follows changes`",
  '2. `Pin to <email>`, one per subscription', 'described as `<plan> · 7d <n>%`',
]), true);
t('AC1 the default\'s email is what desk-env subscription prints while the row is unset', ask.includes('`SUBSCRIPTION` `desk-env subscription` prints while the row is unset'), true);
t('AC1 the plan and the 7-day use have a source', [ask.includes("the check's `PLAN` column"), ask.includes('usage-probe.mjs readings')], [true, true]);
t('the board\'s guidance and its "Saves one row to" line are said around the question', inOrder(ask, [
  "Pin a repo when its work belongs to that account: Studia repos on the Studia seat, client repos on the client's account. Leave the rest on the default.",
  'Saves one row to `<CONFIG>`', '`| Subscription | default |`',
]), true);

// AC3 and AC4: the row each answer saves, now on a re-run and with the config otherwise.
const save = bullet(repo, 'Saving');
t('AC3 the default saves default', save.includes("`Use this computer's default` saves `default`") && save.includes('`| Subscription | default |`'), true);
t('AC4 a pin saves its email', save.includes('`Pin to <email>` saves that email') && save.includes('`| Subscription | <email> |`'), true);
t('AC3 and AC4 a written config is saved through desk-env subscription set', save.includes('`desk-env subscription set <SLUG> <default|email>`'), true);
t('AC3 and AC4 otherwise step 5 writes it as the §3b row', save.includes('§3b `Subscription` row\'s value when step 5 writes the config'), true);

// AC5: a set row asks nothing, says what the repo runs on and where it changes.
const set = bullet(repo, 'The row is already set');
t('AC5 a set row asks nothing', set.includes('ask nothing'), true);
t('AC5 it says which subscription the repo runs on', set.includes('Run `desk-env subscription` and say which subscription this repo runs on'), true);
t('AC5 and that desk-q view 6 changes it', set.includes('desk-q view 6 changes it'), true);

// AC6: one signed-in Claude login asks nothing and saves default.
const one = bullet(repo, 'One subscription, no row');
t('AC6 one subscription asks nothing and saves default', [one.includes('ask nothing'), one.includes('save `default`')], [true, true]);

// AC7: more choices than the question shows are listed numbered, and a typed number or email is read.
const many = bullet(repo, 'More than three subscriptions');
t('AC7 the reply lists every choice numbered', many.includes('every choice numbered from 1 in the order above'), true);
t('AC7 a typed number or email is that choice', [many.includes('A number typed as the answer is that choice'), many.includes('an email typed (any case) is the pin to it')], [true, true]);

// AC8: with no subscriptions file, no rotation question: the default named, the rest unused.
const nofile = bullet(computer, 'No file, two or more signed-in logins of a tool');
t('AC8 no question is asked', nofile.includes('Ask nothing'), true);
t('AC8 the default is the account ~/.claude is signed in to', nofile.includes('the account `~/.claude` is signed in to'), true);
t('AC8 every other signed-in login is unused', nofile.includes('other signed-in login as `unused`'), true);
t('AC8 and desk-q view 6 changes the default', nofile.includes('desk-q view 6 changes the default'), true);
t('the computer step asks nothing at all', computer.includes('this step asks nothing'), true);

// The §3b rounds leave the row to step 1, and the step table leads there.
t('§3b leaves the Subscription row to step 1', core.includes("The Subscription row is never in these calls: step 1 asks it once per repo (*This repo's subscription*)"), true);
t("the step table names This repo's subscription beside step 1's file", /\*This repo's subscription\* \| `references\/step-1-this-computer\.md` \|/.test(core), true);

// AC9: no file of the skill speaks of rotation.
const files = ['SKILL.md', ...readdirSync(join(skill, 'references')).map((f) => `references/${f}`)];
const hits = files.flatMap((f) => ['in rotation', 'standby', 'rotate between']
  .filter((w) => readFileSync(join(skill, f), 'utf8').toLowerCase().includes(w)).map((w) => `${f}: ${w}`));
t(`AC9 no desk-setup file says in rotation, standby or rotate between (${files.length} files)`, hits, []);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
