// suite: decision log (calls taken on the recommendation, one entry each)
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDecision, decisionEntry, appendDecisions, decisionsPath, ASK_CATEGORIES, prLink } from '../desk/bin/decisions.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const good = { question: 'Badge colour?', options: ['brand', 'neutral'], chose: 'brand', category: 'design' };
const raw = (o) => JSON.stringify({ ...good, ...o });

t('a well-formed call parses', parseDecision(raw()).ok, true);
t('not JSON is refused', parseDecision('{"question":').why, 'not JSON');
t('a call with one option is refused', parseDecision(raw({ options: ['brand'], chose: 'brand' })).ok, false);
t('a choice outside the options is refused', parseDecision(raw({ chose: 'red' })).why, 'chose is not one of the options');
t('an unknown category is refused', parseDecision(raw({ category: 'vibes' })).ok, false);
for (const c of ASK_CATEGORIES) t(`AC3 the ask category ${c} is never logged as taken`, parseDecision(raw({ category: c })).why, `${c} is an ask category: ask, never take it`);
t('a PR number becomes its link', prLink(7, 'acme/widgets'), 'https://github.com/acme/widgets/pull/7');
t('no PR is null', prLink(null, 'acme/widgets'), null);

const dir = mkdtempSync(join(tmpdir(), 'desk-decisions-'));
const e = decisionEntry({ decision: parseDecision(raw()).decision, ticket: 'D-1', run: 'run-1', repo: 'acme/widgets', pr: 7, source: 'worker' });
t('an entry has every field', ['id', 'at', 'repo', 'ticket', 'question', 'options', 'chose', 'category', 'pr'].every((k) => e[k] != null), true);
t('the first append writes it', appendDecisions([e], dir).length, 1);
t('AC8 the same run and call again adds nothing', appendDecisions([{ ...e, at: 'later' }], dir).length, 0);
const other = decisionEntry({ decision: parseDecision(raw()).decision, ticket: 'D-1', run: 'run-2', repo: 'acme/widgets', pr: 8, source: 'worker' });
t('another run taking the same call is its own entry', appendDecisions([other], dir).length, 1);
t('the log holds two lines', readFileSync(decisionsPath(dir), 'utf8').trim().split('\n').length, 2);

// AC5: an interactive session logs through the CLI.
const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'decisions.mjs');
const sdir = join(dir, 'session');
const env = { ...process.env, DESK_AUTOPILOT_STATE: sdir, DESK_GH_REPO: 'acme/widgets', CLAUDE_CODE_SESSION_ID: 's-1', DESK_CONFIG: join(dir, 'none.md') };
// The repo comes from DESK_GH_REPO alone: an inherited repo dir or override would outrank it.
for (const k of ['DESK_REPO_DIR', 'DESK_REPO_OVERRIDE', 'DESK_SLUG']) delete env[k];
const run = (args) => { try { return { code: 0, out: execFileSync('node', [cli, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: dir }) }; } catch (x) { return { code: x.status, out: `${x.stdout}${x.stderr}` }; } };
const call = raw({ question: 'Accept the reviewer wording?', options: ['take it', 'keep ours'], chose: 'take it', category: 'review' });
t('AC5 a session call is logged', /^logged: /.test(run(['log', 'S-1', call, '--pr', '9']).out), true);
const line = JSON.parse(readFileSync(decisionsPath(sdir), 'utf8').trim());
t('AC5 with its PR link and source', `${line.pr} ${line.source} ${line.ticket}`, 'https://github.com/acme/widgets/pull/9 session S-1');
t('AC5 the same call twice is one entry', /^already logged: /.test(run(['log', 'S-1', call]).out) && readFileSync(decisionsPath(sdir), 'utf8').trim().split('\n').length === 1, true);
const refused = run(['log', 'S-1', raw({ category: 'money' })]);
t('an ask-category call is refused with exit 11', refused.code, 11);
t('a bad ticket id is refused with exit 11', run(['log', '../x', call]).code, 11);
t('nothing else reached the log', readFileSync(decisionsPath(sdir), 'utf8').trim().split('\n').length, 1);

rmSync(dir, { recursive: true, force: true });
t('cleaned up', existsSync(dir), false);
if (fails) { console.log(`${fails} failed`); process.exit(1); }
