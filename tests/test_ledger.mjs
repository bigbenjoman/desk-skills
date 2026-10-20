// suite: promotion PR ledger (one row per child, between two markers in the PR body)
import { LEDGER_BEGIN, LEDGER_END, ledgerState, renderLedger, replaceLedger, ledgerHash } from '../desk/bin/ledger.mjs';
import { HELD_PREFIX } from '../desk/bin/batch-state.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const q = { tickets: {
  'E-2': { key: 'E-2', state: 'done', result: { pr: 12 }, model: 'opus' },
  'E-3': { key: 'E-3', state: 'done', result: { pr: 13 }, model: 'sonnet' },
  'E-4': { key: 'E-4', state: 'running', model: 'default' },
  'E-5': { key: 'E-5', state: 'parked', park: { question: `${HELD_PREFIX}: blocked by E-2 (Jira link)` }, held_by: 'E-2|E-3' },
  'E-6': { key: 'E-6', state: 'triaged' },
  'E-7': { key: 'E-7', state: 'done', result: { pr: 17 }, model: 'opus' },
} };
const prs = { 12: 'MERGED', 13: 'OPEN', 17: 'CLOSED' };
const prState = (n) => prs[n] ?? null;

// AC1: one row per child, in queue order, with its key, state, PR link and model.
const ledger = renderLedger(q, prState);
const rows = ledger.split('\n').filter((l) => /^\| E-/.test(l));
t('AC1 one row per child', rows.length, 6);
t('AC1 a merged child', rows[0], '| E-2 | merged | #12 | opus |');
t('AC1 a child in review', rows[1], '| E-3 | in review | #13 | sonnet |');
t('AC1 a running child shows its model', rows[2], '| E-4 | running | — | default |');
t('AC1 a held child names what it waits on', rows[3], '| E-5 | held until E-2, E-3 merge | — | — |');
t('AC1 a child not yet run', rows[4], '| E-6 | triaged | — | — |');
t('AC1 a PR closed unmerged', rows[5], '| E-7 | closed without merging | #17 | opus |');
t('AC1 the region opens and closes with the markers', ledger.startsWith(LEDGER_BEGIN) && ledger.endsWith(LEDGER_END), true);
t('AC1 an unreadable PR state reads as done, not a guess', ledgerState(q.tickets['E-2'], () => null), 'done');
t('AC1 a parked child (not held)', ledgerState({ state: 'parked', park: { question: 'which helper?' } }), 'parked');
t('AC1 a pipe in a cell cannot break the table', renderLedger({ tickets: { a: { key: 'A-1', state: 'done', result: { pr: 1 }, model: 'x|y' } } }).includes('| x\\|y |'), true);

// AC1: a merge changes the ledger, and so its hash; the same queue gives the same hash.
const merged = renderLedger(q, (n) => (n === 13 ? 'MERGED' : prState(n)));
t('AC1 a child merging changes the ledger', ledgerHash(merged) !== ledgerHash(ledger), true);
t('AC1 the same rows hash the same', ledgerHash(renderLedger(q, prState)), ledgerHash(ledger));
t('AC1 the hash never reads as a number on the queue', /^sha256:[0-9a-f]{16}$/.test(ledgerHash(ledger)), true);

// AC2: the person's text outside the markers is unchanged.
const above = 'Promotion PR for E-1.\n\nNotes from Ben: check the copy on the summary screen.\n\n';
const below = '\n\n## After merge\n- tell support\n';
const body = `${above}${renderLedger(q, prState)}${below}`;
const next = replaceLedger(body, merged);
t('AC2 text above the ledger is unchanged', next.startsWith(above), true);
t('AC2 text below the ledger is unchanged', next.endsWith(below), true);
t('AC2 the region is replaced, not added to', next, `${above}${merged}${below}`);
t('AC2 replacing with the same ledger is a no-op', replaceLedger(body, ledger), body);
t('AC2 a body with no ledger gets one appended after a blank line', replaceLedger('Promotion PR.\n', ledger), `Promotion PR.\n\n${ledger}\n`);
t('AC2 an empty body is just the ledger', replaceLedger('', ledger), `${ledger}\n`);
t('AC2 a null body is just the ledger', replaceLedger(null, ledger), `${ledger}\n`);
t('AC2 the appended ledger is then replaced in place', replaceLedger(replaceLedger('Hi.', ledger), merged), `Hi.\n\n${merged}\n`);
// A begin marker the person left with no end: the text after it is theirs, so a ledger is appended.
const stray = `Mine ${LEDGER_BEGIN} keep this.`;
const once = replaceLedger(stray, ledger);
t('AC2 a stray begin marker keeps the text after it', once, `${stray}\n\n${ledger}\n`);
t('AC2 and the next rewrite replaces only the appended region', replaceLedger(once, merged), `${stray}\n\n${merged}\n`);
const strayEnd = `Mine ${LEDGER_END} keep this.`;
t('AC2 a stray end marker is left alone', replaceLedger(replaceLedger(strayEnd, ledger), merged), `${strayEnd}\n\n${merged}\n`);
// GitHub can hand the body back with CRLF line endings: the text outside is still kept as it was.
const crlf = `Line one.\r\nLine two.\r\n\r\n${ledger}\r\n\r\nAfter.\r\n`;
t('AC2 CRLF text outside the region is unchanged', replaceLedger(crlf, merged), `Line one.\r\nLine two.\r\n\r\n${merged}\r\n\r\nAfter.\r\n`);

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
