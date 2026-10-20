// suite: promotion PR ledger (one row per child, in one PR comment only the autopilot writes)
import { LEDGER_BEGIN, LEDGER_END, ledgerState, renderLedger, findLedgerComment, syncLedger, ledgerHash } from '../desk/bin/ledger.mjs';
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
t('AC1 the comment opens and closes with the markers', ledger.startsWith(LEDGER_BEGIN) && ledger.endsWith(LEDGER_END), true);
t('AC1 an unreadable PR state reads as done, not a guess', ledgerState(q.tickets['E-2'], () => null), 'done');
t('AC1 a parked child (not held)', ledgerState({ state: 'parked', park: { question: 'which helper?' } }), 'parked');
t('AC1 a pipe in a cell cannot break the table', renderLedger({ tickets: { a: { key: 'A-1', state: 'done', result: { pr: 1 }, model: 'x|y' } } }).includes('| x\\|y |'), true);

// AC1: a merge changes the ledger, and so its hash; the same queue gives the same hash.
const merged = renderLedger(q, (n) => (n === 13 ? 'MERGED' : prState(n)));
t('AC1 a child merging changes the ledger', ledgerHash(merged) !== ledgerHash(ledger), true);
t('AC1 the same rows hash the same', ledgerHash(renderLedger(q, prState)), ledgerHash(ledger));
t('AC1 the hash never reads as a number on the queue', /^sha256:[0-9a-f]{16}$/.test(ledgerHash(ledger)), true);

// AC1: the ledger comment is found by its marker, and only the autopilot's own counts.
const url = (id) => `https://github.com/acme/widgets/pull/200#issuecomment-${id}`;
const mine = { viewerDidAuthor: true, body: ledger, url: url(7) };
t('AC1 the ledger comment is found by its marker', findLedgerComment([{ viewerDidAuthor: true, body: 'Looks good', url: url(5) }, mine])?.id, '7');
t('AC1 someone else\'s comment carrying the marker is not it', findLedgerComment([{ viewerDidAuthor: false, body: ledger, url: url(6) }]), null);
t('AC1 a reply quoting the ledger is not it', findLedgerComment([{ viewerDidAuthor: true, body: `> ${ledger}`, url: url(8) }]), null);
t('AC1 the oldest of two is the one used', findLedgerComment([mine, { ...mine, url: url(9) }])?.id, '7');
t('AC1 no comments, no ledger comment', findLedgerComment([]), null);

// A fake gh: the PR's body and comments, with every call recorded.
function fakeGh({ comments = [], body = 'Promotion PR for E-1.\n\nNotes from Ben.\n', fail = {} } = {}) {
  const pr = { body, comments: comments.map((c) => ({ ...c })) };
  const calls = [];
  const gh = (args, input) => {
    calls.push(args.join(' '));
    const op = args[0] === 'api' ? 'patch' : `${args[0]} ${args[1]}`;
    if (fail[op]) return { ok: false, out: fail[op] };
    if (op === 'pr view') return { ok: true, out: JSON.stringify({ comments: pr.comments }) };
    if (op === 'pr comment') { const id = 100 + pr.comments.length; pr.comments.push({ viewerDidAuthor: true, body: input, url: url(id) }); return { ok: true, out: url(id) }; }
    if (op === 'patch') { const id = /comments\/(\d+)$/.exec(args[3])[1]; pr.comments.find((c) => c.url === url(id)).body = JSON.parse(input).body; return { ok: true, out: '{}' }; }
    return { ok: false, out: `unexpected gh ${args.join(' ')}` };
  };
  return { pr, calls, gh };
}

// AC1: created once when missing, then edited in place; an unchanged one is left alone.
const f = fakeGh({ comments: [{ viewerDidAuthor: false, body: 'A reviewer note', url: url(1) }] });
const body0 = f.pr.body;
t('AC1 a missing ledger comment is created', syncLedger({ n: 200, repo: 'acme/widgets', ledger, gh: f.gh }).action, 'created');
t('AC1 created with the ledger as its body', f.pr.comments[1].body, ledger);
t('AC1 the next change edits that comment in place', syncLedger({ n: 200, repo: 'acme/widgets', ledger: merged, gh: f.gh }).action, 'edited');
t('AC1 still one ledger comment, now the new rows', `${f.pr.comments.length} ${f.pr.comments[1].body === merged}`, '2 true');
t('AC1 the edit targets that comment by id', f.calls.includes('api -X PATCH repos/acme/widgets/issues/comments/101 --input -'), true);
t('AC1 an unchanged ledger is not written', syncLedger({ n: 200, repo: 'acme/widgets', ledger: merged, gh: f.gh }).action, 'unchanged');
t('AC1 the other comment is untouched', f.pr.comments[0].body, 'A reviewer note');

// AC2: the PR body is never read or written for the ledger.
t('AC2 the PR body is untouched', f.pr.body, body0);
t('AC2 no call edits the PR', f.calls.some((c) => c.startsWith('pr edit')), false);
t('AC2 no call reads the PR body', f.calls.some((c) => /--json\s+\S*body/.test(c)), false);

// AC3: a comment that cannot be read or written is a reason, not a throw.
const r1 = syncLedger({ n: 200, repo: 'acme/widgets', ledger, gh: fakeGh({ fail: { 'pr view': 'HTTP 502: Bad Gateway' } }).gh });
t('AC3 unreadable comments are reported', `${r1.ok} ${r1.why}`, 'false its comments could not be read (HTTP 502: Bad Gateway)');
const r2 = syncLedger({ n: 200, repo: 'acme/widgets', ledger, gh: fakeGh({ fail: { 'pr comment': 'GraphQL: Resource not accessible' } }).gh });
t('AC3 a refused create is reported', `${r2.ok} ${r2.why}`, 'false its ledger comment could not be created (GraphQL: Resource not accessible)');
const r3 = syncLedger({ n: 200, repo: 'acme/widgets', ledger: merged, gh: fakeGh({ comments: [mine], fail: { patch: 'HTTP 404' } }).gh });
t('AC3 a refused edit is reported', `${r3.ok} ${r3.why}`, 'false its ledger comment could not be edited (HTTP 404)');
const r4 = syncLedger({ n: 200, repo: 'acme/widgets', ledger, gh: () => ({ ok: true, out: 'not json' }) });
t('AC3 output that is not JSON is reported', r4.ok, false);

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
