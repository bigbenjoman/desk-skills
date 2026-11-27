// suite: desk-ui Inbox read (GET /api/inbox: needs-you's list as data, settled at most once a minute)
// layer: L1
// covers: desk/bin/desk-ui.mjs desk/bin/needs-you.mjs
// The server on a throwaway HOME, DESK_HOME and DESK_CONFIG_ROOT and a free port, over fixture parks in
// two repos, with a stub in place of the GitHub check, so nothing reads your real queues or GitHub.
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './scratch.mjs';
import { call as callPort, freePort } from './local-http.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const T = scratch('desk-ui-inbox-');
const HOME = join(T, 'home');
Object.assign(process.env, { HOME, DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md') });
mkdirSync(HOME, { recursive: true });
writeFileSync(process.env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
const TOKEN = ['tok', 'e5'.repeat(30)].join('');
mkdirSync(process.env.DESK_CONFIG_ROOT, { recursive: true });
writeFileSync(join(process.env.DESK_CONFIG_ROOT, 'ui-token'), `${TOKEN}\n`, { mode: 0o600 });

const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const repo = (slug, port, tickets) => {
  const root = join(T, 'checkouts', slug);
  mkdirSync(root, { recursive: true });
  mkdirSync(join(process.env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(process.env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
    `## 2. Paths\n\n| Field | Value |\n|---|---|\n| Primary repo root | \`${root}\` |\n\n` +
    `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`${port}\` |\n| Autopilot worker concurrency | \`2 / 3\` | \`2 / 3\` |\n| Check-in times | \`08:00, 17:00\` | \`03:07, 21:43\` |\n`);
  mkdirSync(join(process.env.DESK_HOME, 'repos', slug), { recursive: true });
  writeFileSync(join(process.env.DESK_HOME, 'repos', slug, 'queue.json'), JSON.stringify({ version: 1, batch: 'w', concurrency: 2, tickets }));
};
const Q3844 = "SV-3844 PR #2699 is an external-shape change with no live check possible from a worker (curl denied, no Sentry token): can someone with a Sentry token run the checks in the PR's Testing list, or accept merging with them as post-merge checks?";
const parked = (key, question, h, more = {}) => ({ key, state: 'parked', park: { question, since: ago(h), ...more } });
repo('acme__studia-web', 3700, {
  'SV-3844': { ...parked('SV-3844', Q3844, 8 * 24 + 19), result: { pr: 2699 } },
  'SV-3845': parked('SV-3845', 'awaiting approval: post this comment?', 4 * 24, { approve: { kind: 'jira-comment', target: 'SV-3845', body: 'Root cause: the cache key.\nThe fix is in PR #12.' } }),
  'SV-3846': { ...parked('SV-3846', 'Keep the old route or redirect it?', 2), draft_pr: 2701 },
  'SV-4021': parked('SV-4021', 'PRODUCTION BROKEN: course player 500s for every SCORM 1.2 package', 0.25),
});
repo('acme__desk-skills', 3800, { 'DS-1': parked('DS-1', 'Use the cached embeddings or rebuild them?', 7) });

// Every file under desk's state, with its last write.
const STATE = [process.env.DESK_HOME, join(HOME, '.desk-autopilot')];
const files = () => STATE.flatMap(function walk(d) {
  let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return []; }
  return es.flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [[join(d, e.name), statSync(join(d, e.name)).mtimeMs]]));
}).sort();

let probes = 0;
let gh = { ok: true };
let now = Date.now();
const { makeServer, githubState } = await import('../desk/bin/desk-ui.mjs');
const { listItems } = await import('../desk/bin/needs-you.mjs');
const PORT = await freePort();
const server = makeServer({ p: PORT, log: () => {}, events: { now: () => now }, github: async () => { probes++; return gh; } });
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const ORIGIN = `http://127.0.0.1:${PORT}`;
const call = (method, path, opts) => callPort(PORT, method, path, opts);
const ex = await call('POST', '/api/auth/exchange', { headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
const signed = { Cookie: String(ex.headers['set-cookie']).split(';')[0], 'X-Desk-Load': JSON.parse(ex.text).loadToken };
const inbox = async (q = '') => { const r = await call('GET', `/api/inbox${q}`, { headers: signed }); return r.status === 200 ? JSON.parse(r.text) : r.status; };

t('the Inbox needs the window signed in', (await call('GET', '/api/inbox')).status, 401);

// ---- AC1, AC2: the same items in needs-you's order, and nothing written
const before = files();
const first = await inbox();
const after = files();
const want = listItems({ settle: false, reads: null });
t('AC1 the Inbox lists needs-you\'s items, in its order', first.items?.map((i) => i.id), want.items.map((i) => i.id));
t('AC1 each item carries its key, kind, repo and waited time', first.items?.map((i) => [i.key, i.kind, i.repo, i.waited_s > 0]),
  want.items.map((i) => [i.key, i.kind, i.repo, true]));
t('AC2 opening the Inbox writes no queue, park or answer file', after, before);
t('AC2 opening the Inbox does not settle, and checks no GitHub', [first.settled, first.settled_at, probes], [false, null, 0]);

// ---- AC3, AC4, AC8: what the detail shows
const item = (key) => first.items.find((i) => i.key === key);
t('AC8 a production-broken park is first, and says so', [first.items[0].key, first.items[0].production_broken], ['SV-4021', true]);
t('AC3 SV-3844\'s question is needs-you\'s, whole', item('SV-3844').question, want.items.find((i) => i.key === 'SV-3844').question);
t('AC3 SV-3844 carries its PR', item('SV-3844').pr, 2699);
t('AC4 a park awaiting approval carries the exact text, line for line', item('SV-3845').approve,
  { kind: 'jira-comment', target: 'SV-3845', body: 'Root cause: the cache key.\nThe fix is in PR #12.' });
t('AC4 a park with nothing to approve carries none', item('DS-1').approve, null);
t('AC9 the next check-in is given', typeof first.next_checkin_at === 'string' && Date.parse(first.next_checkin_at) > Date.now(), true);
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
t('AC9 the next check-in is one of the repos\' own Check-in times', ['03:07', '21:43'].includes(hhmm(first.next_checkin_at)), true);
t('AC3 a park with only a draft PR carries the draft', item('SV-3846').pr, 2701);

// ---- AC14: settling runs at most once a minute, and a request while one runs shares it
const s1 = await inbox('?settle=1');
t('AC14 the first press checks GitHub and settles', [probes, s1.settled, s1.settled_at === s1.generated_at, s1.github], [1, true, true, { ok: true }]);
const s2 = await inbox('?settle=1');
t('AC14 a second press within the minute settles nothing more', [probes, s2.settled, s2.settled_at], [1, false, s1.settled_at]);
now += 61_000;
const [a, b] = await Promise.all([inbox('?settle=1'), inbox('?settle=1')]);
t('AC14 two presses at once, a minute on, share one settling list', [probes, a.settled, b.settled, a.generated_at === b.generated_at], [2, true, true, true]);

// ---- AC10, AC11: GitHub not answering, or signed out
now += 61_000;
gh = { ok: false, reason: 'down', detail: 'gh: HTTP 502' };
const down = await inbox('?settle=1');
t('AC10 GitHub not answering: the list still comes, unsettled, with what GitHub said', [down.settled, down.github, down.settled_at, down.items.length], [false, gh, b.settled_at, want.items.length]);
t('AC10 the next plain read still says GitHub did not answer', (await inbox()).github, gh);
await inbox('?settle=1');
t('AC10 Try again checks GitHub again at once, as nothing settled', probes, 4);
gh = { ok: true };
t('AC10 once GitHub answers, it settles', (await inbox('?settle=1')).settled, true);
t('AC10 a 502 from gh reads as GitHub down', githubState('HTTP 502: Bad Gateway (https://api.github.com/rate_limit)'), { ok: false, reason: 'down', detail: 'gh: HTTP 502' });
t('AC11 a 401 from gh reads as signed out', githubState('gh: Bad credentials (HTTP 401)').reason, 'signin');
t('AC11 no gh login reads as signed out', githubState('To get started with GitHub CLI, please run:  gh auth login').reason, 'signin');
t('a reply that names no status says what gh said', githubState('error connecting to api.github.com\n').detail, 'gh: error connecting to api.github.com');

server.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
