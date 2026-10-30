// suite: cloud worker (placement, start, PR lookup and report rows)
// cloud-worker.mjs against the outputs recorded in tests/fixtures/cloud/: placement from triage
// records, the start parsed from `claude --cloud`, a real start through `script` with no terminal of
// its own (a fake claude that prints the recording, and one that refuses the way --print does), the
// PR a session opened, and the batch report's cloud row.
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { placement, cloudPrompt, parseCloudStart, startCloud, findCloudPr, cloudWall } from '../desk/bin/cloud-worker.mjs';
import { costTable, ticketCost } from '../desk/bin/worker-cost.mjs';
import { runningHere } from '../desk/bin/maintenance.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cloud');
const fixture = (f) => readFileSync(join(FIX, f), 'utf8');
const S = mkdtempSync(join(tmpdir(), 'desk-cloud-'));

// ---- placement (AC3) --------------------------------------------------------
const rec = (o) => ({ ticket: 'K-1', lane: 'A', renders: false, needs_db: false, needs_local: null, ...o });
const at = (o, loc = 'cloud') => { const p = placement(o, loc); return `${p.where}${p.why ? `: ${p.why}` : ''}`; };
t('AC3 at local every ticket runs locally, with no reason to give', at(rec({}), 'local'), 'local');
t('AC3 a ticket that needs nothing local runs in the cloud', at(rec({})), 'cloud');
t('AC3 one that renders runs locally: the browser lock and a dev server', at(rec({ renders: true })), 'local: it renders: its screenshots need the browser lock and a local dev server');
t('AC3 a lane D build runs locally', at(rec({ lane: 'D' })).startsWith('local: it renders'), true);
t('AC3 one that needs a database runs locally', at(rec({ needs_db: true })), 'local: it needs a local database');
t('AC3 triage\'s own reason (stub binaries) is the plan\'s reason', at(rec({ needs_local: 'its checks run the stub gh and claude binaries in tests/' })),
  'local: its checks run the stub gh and claude binaries in tests/');
t('AC3 every reason is given', at(rec({ renders: true, needs_db: true })).split('; ').length, 2);
t('AC3 a record that never answered needs_local stays local, and says so', at({ ticket: 'K-1', lane: 'A' }).includes('re-run triage.sh'), true);
const spine = placement(rec({}), 'cloud', { feature: 'it is the feature spine' });
t('AC3 a feature spine or spec owner runs locally, and says so', `${spine.where}: ${spine.why}`, 'local: it is the feature spine');

// ---- the maintenance window counts only workers on this computer --------------
t('a cloud session is not running here', runningHere({ state: 'running', location: 'cloud' }), false);
t('a local worker is', runningHere({ state: 'running', location: null }), true);

// ---- the prompt carries the ticket (AC2) ------------------------------------
const prompt = cloudPrompt({ key: 'K-1', repo: 'acme/widgets', base: 'main', branch: 'feat/K-1-x', text: 'Fix the widget.\n\nAC1: it works', tests: ['bash tests/run.sh'] });
t('AC2 the prompt carries the ticket text', prompt.includes('AC1: it works'), true);
t('AC2 and the branch to push and the PR to open', prompt.includes('branch named exactly `feat/K-1-x`, cut from `main`') && prompt.includes('with K-1 in its title'), true);
t('AC2 and the repo\'s test command', prompt.includes('Run `bash tests/run.sh` before you push'), true);

// ---- the start (AC2, AC4) ---------------------------------------------------
const started = parseCloudStart(fixture('created.txt'));
t('AC2 the recorded start gives the session id', started.session, 'session_01Vy49H7Z4T3CSgAhSxsuhqj');
t('AC2 and its URL', started.url, 'https://claude.ai/code/session_01Vy49H7Z4T3CSgAhSxsuhqj?from=cli&m=0');
t('AC2 terminal noise around it is ignored', parseCloudStart(`\x1b[?25l${fixture('created.txt').replace(/\n/g, '\r\n')}\x1b[0m`).session, 'session_01Vy49H7Z4T3CSgAhSxsuhqj');
t('AC2 so is the ^D and backspaces BSD script echoes when its input ends', parseCloudStart(`^D\b\b${fixture('created.txt')}`).session, 'session_01Vy49H7Z4T3CSgAhSxsuhqj');
// A real start made as startCloud makes it on macOS, with no terminal of its own (2.1.314): its noise
// includes ESC 7/ESC 8, ESC ( B and SI, and its title is the CLI's summary, not the description.
const noTty = parseCloudStart(fixture('created-no-tty.txt'));
t('AC4 the recorded no-TTY start gives the session id', noTty.session ?? JSON.stringify(noTty), 'session_01Vy49H8UHjQ9wbruRKguWDD');
t('AC4 and its URL', noTty.url, 'https://claude.ai/code/session_01Vy49H8UHjQ9wbruRKguWDD?from=cli&m=0');
t('AC4 and the title the CLI chose, free of terminal noise', noTty.title, 'No-TTY recording');
t('AC4 print mode\'s refusal is an error, word for word', parseCloudStart(fixture('print-refused.txt')).error, 'Error: --cloud cannot be combined with --print.');
t('AC4 stream-json\'s refusal is an error, word for word', parseCloudStart(fixture('stream-json-refused.txt')).error, 'Error: --cloud <session_id> does not support --output-format stream-json');
t('AC4 a message queued to a session is not a start', !!parseCloudStart(fixture('send-json.json')).error, true);
t('AC4 no output at all is an error', parseCloudStart('').error, 'it printed nothing');

// A real start through `script`, this process having no terminal: a fake claude prints the recording.
const fake = (name, body) => { const p = join(S, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p; };
const ok = fake('claude-ok', `[ "$1" = --cloud ] || exit 9\nprintf '%s\\n' "$2" > "${join(S, 'prompt.txt')}"\ncat "${join(FIX, 'created.txt')}"`);
const real = startCloud(prompt, { claude: ok, timeout: 30_000 });
t('AC2 spawned without a terminal, the session is read through script', real.session ?? JSON.stringify(real), 'session_01Vy49H7Z4T3CSgAhSxsuhqj');
let sent = '';
try { sent = readFileSync(join(S, 'prompt.txt'), 'utf8'); } catch { /* not run */ }
t('AC2 and the whole prompt reached claude --cloud as one argument', sent.includes('AC1: it works') && sent.includes('Work ticket K-1'), true);
const okNoTty = fake('claude-ok-no-tty', `[ "$1" = --cloud ] || exit 9\ncat "${join(FIX, 'created-no-tty.txt')}"`);
const realNoTty = startCloud(prompt, { claude: okNoTty, timeout: 30_000 });
t('AC4 the no-TTY recording read back through script gives its session', realNoTty.session ?? JSON.stringify(realNoTty), 'session_01Vy49H8UHjQ9wbruRKguWDD');
const refuses = fake('claude-no', `cat "${join(FIX, 'print-refused.txt')}" >&2\nexit 1`);
t('AC4 a start the CLI refuses returns its error', startCloud(prompt, { claude: refuses, timeout: 30_000 }).error?.startsWith('Error: --cloud cannot be combined with --print.'), true);
t('AC4 a claude that is not there is an error, not a session', !!startCloud(prompt, { claude: join(S, 'missing'), timeout: 30_000 }).error, true);

// ---- the PR it opened (AC2) -------------------------------------------------
const since = '2026-10-28T10:00:00Z';
const prs = [
  { number: 7, title: 'feat(x): K-1 earlier attempt', headRefName: 'feat/K-1-x', createdAt: '2026-10-27T09:00:00Z' },
  { number: 9, title: 'feat(x): K-1 do it', headRefName: 'claude/k-1-abc', createdAt: '2026-10-28T10:40:00Z' },
  { number: 8, title: 'feat(x): K-10 other', headRefName: 'claude/k-10', createdAt: '2026-10-28T10:20:00Z' },
];
t('AC2 a PR opened from the branch it was told to use is its result', findCloudPr([...prs, { number: 11, title: 'no key', headRefName: 'feat/K-1-x', createdAt: '2026-10-28T11:00:00Z' }], { key: 'K-1', branch: 'feat/K-1-x', since })?.number, 11);
t('AC2 else one with the key in its title, opened since it started', findCloudPr(prs, { key: 'K-1', branch: 'feat/K-1-x', since })?.number, 9);
t('AC2 a longer key is not the key', findCloudPr(prs.slice(2), { key: 'K-1', branch: 'feat/K-1-x', since }), null);
t('AC2 no PR yet is null', findCloudPr([], { key: 'K-1', branch: 'b', since }), null);
t('AC2 wall time runs from session start to PR', cloudWall({ started: since, pr_at: '2026-10-28T10:40:00Z' }), 2400000);
t('AC2 with no PR there is no wall time', cloudWall({ started: since }), null);

// ---- the batch report (AC2) -------------------------------------------------
const cloudTicket = { key: 'K-1', location: 'cloud', cloud: { session: started.session, url: started.url, started: since, pr_at: '2026-10-28T10:40:00Z' } };
const row = ticketCost(S, cloudTicket);
t('AC2 a cloud ticket has a report row with no log', row?.cloud?.url, started.url);
const table = costTable([row, ticketCost(S, { key: 'K-2', location: 'cloud', cloud: { started: since, url: 'u2' } })]).split('\n');
const k1 = table.find((l) => l.startsWith('  K-1 ')) ?? '';
t('AC2 its tokens and cost read "not reported for cloud", never $0', (k1.match(/not reported for cloud/g) ?? []).length >= 3 && !/\$0\.00/.test(k1), true);
t('AC2 its wall time is session start to PR', k1.includes('40m 00s'), true);
t('AC2 its session URL is under its row', table.some((l) => l.trim() === `cloud session: ${started.url}`), true);
t('AC2 one with no PR yet has no wall time', (table.find((l) => l.startsWith('  K-2 ')) ?? '').includes('no PR yet'), true);
t('AC2 the total leaves cloud workers out and says so', table.at(-2).includes('2 cloud worker(s) not counted') || table.at(-1).includes('2 cloud worker(s) not counted'), true);

rmSync(S, { recursive: true, force: true });
console.log(fails ? `cloud worker: ${fails} failed` : 'cloud worker: all checks passed');
process.exit(fails ? 1 : 0);
