// suite: closing keywords (desk-pr's check that a PR body closes only the issues it says it closes)
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strayClosings, closesOnly } from '../desk/bin/closing-keywords.mjs';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const lines = (body) => strayClosings(body).map((s) => s.line);

const PR1109 = 'AC1 can only be checked on main: the next main CI run\'s comment on #1090 lists none of the ten suites. Close #1090 after a week of clean main runs.';
t('AC1 the #1109 line is flagged', strayClosings(`intro\n\n${PR1109}`), [{ line: 3, text: PR1109, uses: ['Close #1090'] }]);
t('AC1 as a person step too', lines(`- [ ] ${PR1109}`), [1]);
for (const k of ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved', 'CLOSES', 'Fixed']) {
  t(`AC1 "${k}" before a reference mid-sentence is flagged`, lines(`This ${k} #12 once it lands.`), [1]);
}
t('AC1 a colon between keyword and reference is still one', lines('It fixes: #12 for now.'), [1]);
t('AC1 another repo\'s issue is a reference', lines('This resolves acme/web#7 too.'), [1]);
t('AC1 an issue URL is a reference', lines('Then close https://github.com/acme/web/issues/7 by hand.'), [1]);
for (const l of ['- [ ] Close #1090', '- [x] Fixes #12', '* [ ] Resolve acme/web#7.']) {
  t(`AC1 a task item "${l}" is a step for later and is flagged`, [closesOnly(l), lines(l)], [false, [1]]);
}
t('AC1 every flagged line is named', lines('ok\nfixes #1 later\nok\nand closes #2 then'), [2, 4]);

t('AC2 the issue named first passes', lines('- [ ] #1090 can be closed after a week of clean main runs.'), []);
t('AC2 a keyword not before a reference passes', lines('Fixes the flake; see #12. Closing it waits on #13.'), []);
t('AC2 a word ending in a keyword is not one', lines('It prefixes #12 and suffixes #13.'), []);

for (const l of ['Closes #12', 'closes #12.', '- Fixes #3, closes #4', '**Resolves** acme/web#7', '> Closes #12 and fixes #13', 'Fixes: #9', '1. Closes https://github.com/acme/web/issues/7']) {
  t(`AC3 "${l}" on a line of its own passes`, [closesOnly(l), lines(`intro\n${l}\n`)], [true, []]);
}
t('AC3 a closing line beside a flagged one flags only the other', lines('Closes #12\n\nClose #1090 after a week.'), [3]);

// A long run of references before prose is read in linear time: two optional runs of spaces side by
// side once backtracked exponentially (26 references took 21.6 s), and the pass checks worker bodies.
const refs = (n, sep, ref = (i) => `#${i}`) => Array.from({ length: n }, (_, i) => ref(i + 1)).join(sep);
const owners = { '#N': undefined, 'and-co/web#N': (i) => `and-co/web#${i}`, 'and.a/b#N': (i) => `and.a/b#${i}` };
for (const [name, ref] of Object.entries(owners)) {
  for (const sep of [' ', '  ', ', ', ' and ', ' & ']) {
    const started = Date.now();
    const got = [lines(`Closes ${refs(200, sep, ref)} once the fleet is quiet.`), lines(`Closes ${refs(200, sep, ref)}.`)];
    t(`a closing line of 200 ${name} references joined by ${JSON.stringify(sep)} is read at once`, [got, Date.now() - started < 1000], [[[1], []], true]);
  }
}
t('"and" with no space after it is not a separator', closesOnly('Closes #1 and#2'), false);

// The command: exit 0 clean, 1 flagged with the line, 2 usage.
const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'closing-keywords.mjs');
const dir = scratch('closing-kw-');
const run = (body, args) => {
  const f = join(dir, 'body.md');
  if (body != null) writeFileSync(f, body);
  try { return { code: 0, out: execFileSync('node', [bin, ...(args ?? [f])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout) }; }
};
t('AC3 the command passes a body that closes its issue', run('intro\n\nCloses #12\n').code, 0);
const bad = run(`intro\n\n${PR1109}\n`);
t('AC1 the command fails a flagged body', bad.code, 1);
t('AC1 and names the line', bad.out.split('\n')[0].startsWith('line 3: Close #1090 would close that issue at merge: AC1 can only'), true);
t('the command wants one file', run(null, []).code, 2);
t('an unreadable file is a usage error', run(null, [join(dir, 'missing.md')]).code, 2);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
