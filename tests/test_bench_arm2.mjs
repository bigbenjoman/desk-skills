// suite: bench arm 2 (a shadow Codex review seat against the current seat on seeded defects)
// covers: desk/bin/bench-arm2.mjs desk/bin/bench-arm3.mjs desk/bin/bench.mjs
// A scratch repo whose PR has two acted-on findings, one revertible and one overwritten by a later
// commit. Stub claude and codex binaries on PATH log what each seat could see, then answer from the
// brief's ticket text.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findingPlace, hunkAt, namedPath, parseArgs, parseCsv, parseFindings, renderReport, rowsFor, scoreFindings, splitHunks } from '../desk/bin/bench-arm2.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'desk', 'bin', 'bench-arm2.mjs');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bench-arm2-test-')));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const home = join(dir, 'home');
mkdirSync(home);
const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
for (const k of Object.keys(gitEnv)) if (/^(DESK_|JIRA_|GIT_DIR$|GIT_WORK_TREE$|AUTOPILOT_|CODEX_HOME$|CLAUDE_CONFIG_DIR$)/.test(k)) delete gitEnv[k];
writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n');

const repo = join(dir, 'repo');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { env: gitEnv, encoding: 'utf8' }).trim();
const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1));
const write = (file, body) => writeFileSync(join(repo, file), body);
const commit = (m) => { git('add', '-A'); git('commit', '-q', '-m', m); return git('rev-parse', 'HEAD'); };
mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv });
const srcBase = lines(30, (i) => `line ${i}`);
write('src.txt', `${srcBase.join('\n')}\n`);
write('other.txt', `${lines(10, (i) => `other ${i}`).join('\n')}\n`);
write('run-tests.sh', '#!/bin/sh\nexit 0\n');
const base = commit('base');
// The PR: a defect at src.txt:5, its fix, then a fix in other.txt that a later commit overwrites.
const bad = [...srcBase]; bad[4] = 'unguarded call';
write('src.txt', `${bad.join('\n')}\n`);
commit('add the call');
const good = [...bad]; good[4] = 'guarded call';
write('src.txt', `${good.join('\n')}\n`);
const fixSrc = commit('guard the call');
const untouched = [...good]; untouched[19] = 'guarded twenty';
write('src.txt', `${untouched.join('\n')}\n`);
const fixUntouched = commit('guard a line the PR left alone');
const oth = lines(10, (i) => `other ${i}`); oth[2] = 'fixed three';
write('other.txt', `${oth.join('\n')}\n`);
const fixOther = commit('fix other');
oth[2] = 'rewritten three';
write('other.txt', `${oth.join('\n')}\n`);
const merge = commit('rewrite other');
git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git');

const configRoot = join(dir, 'config');
const CODEX_YES = '| `codex-review` | Send diffs to codex | `yes` | `yes` |', CODEX_NO = '| `codex-review` | Send diffs to codex | `yes` | `no` |';
mkdirSync(join(configRoot, 'repos', 'acme__widgets'), { recursive: true });
writeFileSync(join(configRoot, 'repos', 'acme__widgets', 'config.md'), `## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`${repo}\` |
| Worktrees directory | \`${join(dir, 'wt')}\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
${CODEX_YES}

## 3b. Caps
| Field | Value |
|---|---|
| Codex review | \`finder=gpt-6.1-sol:high\` |

## 4. Toolchain
| Field | Value |
|---|---|
| Tracker | \`jira\` |
| Command prefix | \`none\` |
| Install | \`none\` |
| Project subagents sync | \`none\` |
| Env files | \`none\` |
| Local database | \`none\` |
| Database URL variable | \`none\` |
| Database migrate | \`none\` |
| Unit tests | \`sh run-tests.sh\` |

### What review here consistently asks for

| Ask | Detail |
|---|---|
| house ask | a detail |
`);

const setDir = join(dir, 'set');
mkdirSync(join(setDir, 'hidden', 'tests'), { recursive: true });
writeFileSync(join(setDir, 'hidden', 'tests', 'hidden.sh'), 'exit 0\n');
const task = (id, pr, prompt) => ({ id, repo: 'acme/widgets', pr, base, merge, prompt, hidden_tests: { dir: 'hidden', files: ['tests/hidden.sh'] } });
const setFile = join(setDir, 'tasks.json');
writeFileSync(setFile, JSON.stringify({ tasks: [task('one', 7, 'ticket one'), task('hang', 8, 'ticket HANG')] }));
const csv = join(dir, 'findings.csv');
writeFileSync(csv, [
  'repo,key,pr,vendor,file,line,acted_commit,note',
  `acme/widgets,AB-1,7,claude,src.txt,5,${fixSrc},"the call, unguarded"`,
  `widgets,AB-1,7,codex,other.txt,3,${fixOther},overwritten later`,
  `acme/widgets,AB-1,7,codex,src.txt,20,${fixUntouched},restores the base`,
  'acme/widgets,AB-1,7,codex,src.txt,9,,not acted on',
  `acme/widgets,AB-2,8,claude,src.txt,5,${fixSrc},same fix on the second task`,
  `acme/widgets,AB-9,99,claude,src.txt,5,${fixSrc},another PR`,
].join('\n') + '\n');

const bin = join(dir, 'bin');
mkdirSync(bin);
const stubCommon = `const fs = require('fs'), path = require('path'), cp = require('child_process');
const a = process.argv.slice(2);
const val = (f) => { const i = a.indexOf(f); return i < 0 ? null : a[i + 1]; };
const look = (cwd) => ({ brief: fs.readFileSync(path.join(cwd, 'desk-review-brief.txt'), 'utf8'), src: fs.readFileSync(path.join(cwd, 'src.txt'), 'utf8'), log: cp.execFileSync('git', ['-C', cwd, 'log', '--format=%s'], { encoding: 'utf8' }), cwd });
const finding = (place, title) => 'FINDING\\nseverity: P1\\nfile: ' + place + '\\ntitle: ' + title + '\\ndetail: d\\nevidence: e\\nsuggested_fix: none\\n';
`;
writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
${stubCommon}
const prompt = val('-p');
const u = JSON.parse(fs.readFileSync(process.env.STUB_USAGE, 'utf8'));
const say = (o) => console.log(JSON.stringify(o));
if (prompt === 'Reply with: ok') {
  say({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.01, resetsAt: u.reset }, seven_day: { utilization: u.used, resetsAt: u.reset } } } });
  say({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
  return;
}
u.used += 0.001; fs.writeFileSync(process.env.STUB_USAGE, JSON.stringify(u));
const seen = look(process.cwd());
const settings = JSON.parse(fs.readFileSync(val('--settings'), 'utf8'));
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ tool: 'claude', prompt, args: a, ...seen, permissions: settings.permissions }) + '\\n');
say({ type: 'system', subtype: 'init', model: 'claude-opus-stub' });
say({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, modelUsage: { m: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
  result: 'FINDING\\nseverity: P1\\nfile: src.txt:5\\ntitle: unguarded\\ndetail: d\\nevidence: e\\nsuggested_fix: none\\n\\nFINDING\\nseverity: P2\\nfile: src.txt:28\\ntitle: unrelated worry\\ndetail: d\\nevidence: e\\nsuggested_fix: none\\n\\nFILES READ: src.txt\\n' });
`);
writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
${stubCommon}
const configs = a.filter((x, i) => a[i - 1] === '-c');
const cd = val('--cd'), prompt = a[a.indexOf('--') + 1];
const seen = look(cd);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ tool: 'codex', prompt, args: a, configs, ...seen }) + '\\n');
if (seen.brief.includes('HANG')) { fs.writeFileSync(val('--output-last-message'), finding('src.txt:5', 'written before the hang')); setInterval(() => {}, 1000); return; }
const u = JSON.parse(fs.readFileSync(process.env.STUB_CODEX_USAGE, 'utf8'));
u.used += 2; fs.writeFileSync(process.env.STUB_CODEX_USAGE, JSON.stringify(u));
const effort = /^model_reasoning_effort="(\\w+)"$/.exec(configs.find((c) => c.startsWith('model_reasoning_effort')))[1];
const ev = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload });
const logLines = [ev('session_meta', { id: 's', cwd: cd }), ev('turn_context', { cwd: cd, model: val('-m'), effort }),
  ...(process.env.STUB_CODEX_READS ? [ev('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['cat', process.env.STUB_CODEX_READS] }), call_id: 'c1' })] : []),
  ev('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 5, reasoning_output_tokens: 2 } },
    rate_limits: { primary: { used_percent: 1, window_minutes: 300, resets_at: u.reset }, secondary: { used_percent: u.used, window_minutes: 10080, resets_at: u.reset }, plan_type: 'pro' } })];
const day = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '08');
fs.mkdirSync(day, { recursive: true });
if (!process.env.STUB_CODEX_NO_LOG) fs.writeFileSync(path.join(day, 'rollout-2026-11-08T00-00-00-' + Math.random().toString(36).slice(2) + '.jsonl'), logLines.join('\\n') + '\\n');
fs.writeFileSync(val('--output-last-message'), process.env.STUB_CODEX_ANSWER || 'NO FINDINGS\\nFILES READ: src.txt\\n');
console.log('progress line that holds FINDING and NO FINDINGS');
`);
for (const b of ['claude', 'codex']) chmodSync(join(bin, b), 0o755);

const codexHome = join(dir, 'codex-home');
const reset = Math.floor(Date.now() / 1000) + 3 * 24 * 3600;
mkdirSync(join(codexHome, 'sessions', '2026', '11', '07'), { recursive: true });
writeFileSync(join(codexHome, 'sessions', '2026', '11', '07', 'rollout-seed.jsonl'), [
  JSON.stringify({ timestamp: new Date(Date.now() - 60000).toISOString(), type: 'session_meta', payload: { id: 'seed', cwd: '/elsewhere' } }),
  JSON.stringify({ timestamp: new Date(Date.now() - 60000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: null,
    rate_limits: { primary: { used_percent: 1, window_minutes: 300, resets_at: reset }, secondary: { used_percent: 10, window_minutes: 10080, resets_at: reset }, plan_type: 'pro' } } }),
].join('\n') + '\n');

const log = join(dir, 'calls.jsonl');
const calls = (tool) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.tool === tool) : []);
const usageFile = join(dir, 'usage.json'), codexUsage = join(dir, 'codex-usage.json');
writeFileSync(usageFile, JSON.stringify({ used: 0.1, reset }));
writeFileSync(codexUsage, JSON.stringify({ used: 10, reset }));
mkdirSync(join(dir, 'locks'));
const run = (args, env = {}) => {
  rmSync(log, { force: true });
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: {
    ...gitEnv, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, DESK_CONFIG_ROOT: configRoot, DESK_LOCK_DIR: join(dir, 'locks'), DESK_SKILLS_DIR: join(HERE, '..', 'skills'),
    STUB_USAGE: usageFile, STUB_CODEX_USAGE: codexUsage, CODEX_HOME: codexHome, DESK_USAGE_DIR: join(dir, 'usage'), DESK_SUBSCRIPTIONS: join(dir, 'subscriptions.md'), ...env,
  } });
};
const results = (out) => Object.fromEntries(readdirSync(join(out, 'runs')).filter((d) => existsSync(join(out, 'runs', d, 'result.json')))
  .map((d) => { const r = JSON.parse(readFileSync(join(out, 'runs', d, 'result.json'), 'utf8')); return [`${r.task}.${r.arm}`, { ...r, dir: join(out, 'runs', d) }]; }));

// The pure pieces.
t('CSV keeps quoted commas', parseCsv('repo,pr,file,line,acted_commit,note\na,1,f,2,abc,"x, ""y"""\n')[0].note, 'x, "y"');
t('a CSV with a missing column is refused', /no acted_commit/.test(throws(() => parseCsv('repo,pr,file,line\n'))), true);
t('a row needs the PR and an acting commit', rowsFor({ repo: 'o/n', pr: 3 }, parseCsv('repo,pr,file,line,acted_commit\no/n,3,a,1,abc\nn,3,b,1,abc\no/n,3,c,1,\no/n,4,d,1,abc\n')).map((r) => r.file).join(), 'a,b');
const h = splitHunks('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -5,3 +5,4 @@\n a\n-b\n+c\n+d\n e\n@@ -20 +21 @@\n-x\n+y\n');
t('hunks are split with their ranges', JSON.stringify(h.hunks.map((x) => [x.oldStart, x.oldLen, x.newStart, x.newLen])), '[[5,3,5,4],[20,1,21,1]]');
t('a line finds its hunk', `${hunkAt(h.hunks, 7)?.oldStart} ${hunkAt(h.hunks, 8)?.oldStart} ${hunkAt(h.hunks, 20)?.oldStart}`, '5 undefined 20');
const parsed = parseFindings('intro\nFINDING\nseverity: P1\nfile: `/wt/a.js:10-12`\ntitle: t\ndetail: line one\nline two\nevidence: e\nsuggested_fix: none\n\nFILES READ: a.js\nnot part of it', '/wt').findings;
t('a finding is read from its block, the path made repo-relative', JSON.stringify([parsed[0].file, parsed[0].line, parsed[0].end, parsed[0].detail]), '["a.js",10,12,"line one\\nline two"]');
t('NO FINDINGS is clean', JSON.stringify(parseFindings('NO FINDINGS\nFILES READ: a')), '{"findings":[]}');
t('neither form is no answer', parseFindings('I looked at it and it seems fine'), null);
t('a place with no line has none', findingPlace('a.js').line, null);
const seeds = [{ id: 's1', file: 'a', line: 10, end: 16 }, { id: 's2', file: 'b', line: 1, end: 7 }];
const fnd = (file, line, end = line) => ({ file, line, end });
t('inside a seeded hunk is a hit', scoreFindings(seeds, [fnd('a', 16)]).found.join(), 's1');
t('just outside is unmatched', scoreFindings(seeds, [fnd('a', 17)]).unmatched.length, 1);
t('another file is no hit', scoreFindings(seeds, [fnd('c', 12)]).found.length, 0);
t('a range overlapping the hunk is a hit', scoreFindings(seeds, [fnd('a', 5, 11)]).found.join(), 's1');
t('a finding with no line is unmatched', scoreFindings(seeds, [{ file: 'a', line: null, end: null }]).unmatched.length, 1);
t('a tool call naming a path is seen', namedPath(JSON.stringify({ payload: { type: 'function_call', arguments: 'cat /secret/x' } }), ['/secret']), '/secret');
t('the same path outside a tool call is not', namedPath(JSON.stringify({ payload: { type: 'message', content: '/secret' } }), ['/secret']), null);
t('an --arm of its own is refused', /sets its own seats/.test(throws(() => parseArgs(['--tasks', 'x', '--arm', 'a', '--max-budget-usd', '1']))), true);

// AC1, AC6: the seeder.
let r = run(['seed', '--tasks', setFile, '--findings', csv]);
if (r.status !== 0) console.log(r.stderr);
t('the seeder runs', r.status, 0);
const seedFile = join(setDir, 'seeds', 'one', 'seeds.json');
const rec = JSON.parse(readFileSync(seedFile, 'utf8'));
t('AC1 the revertible finding is planted', rec.seeds.length, 1);
t('AC1 its file and line in the seeded tree', `${rec.seeds[0].file} ${rec.seeds[0].line} ${rec.seeds[0].end}`, 'src.txt 2 8');
t('AC1 with the original finding', `${rec.seeds[0].finding.note} ${rec.seeds[0].finding.vendor}`, 'the call, unguarded claude');
t('AC1 the patch reverts the fix onto the merged diff', /^\+unguarded call$/m.test(readFileSync(join(setDir, 'seeds', 'one', 'seeded.patch'), 'utf8')) && !/guarded call$/m.test(readFileSync(join(setDir, 'seeds', 'one', 'seeded.patch'), 'utf8').replace(/unguarded call/g, '')), true);
t('AC1 and keeps the rest of the merged diff', /^\+rewritten three$/m.test(readFileSync(join(setDir, 'seeds', 'one', 'seeded.patch'), 'utf8')), true);
t('AC6 the unrevertible finding is skipped', `${rec.skipped.length} ${rec.skipped[0].finding.file}`, '2 other.txt');
t('a revert that restores the base is skipped, not planted', /restores the base/.test(rec.skipped[1].why), true);
t('and leaves the merged change in the patch', /^\+guarded twenty$/m.test(readFileSync(join(setDir, 'seeds', 'one', 'seeded.patch'), 'utf8')), true);
t('AC6 with the reason', /does not revert cleanly onto the merged diff/.test(rec.skipped[0].why), true);
t('AC6 and printed', /skipped other\.txt:3: its acting commit does not revert cleanly/.test(r.stdout), true);
t('a row that was not acted on is ignored', rec.skipped.concat(rec.seeds).some((x) => (x.finding ?? {}).line === '9'), false);
t('the repo is untouched', git('status', '--porcelain'), '');
writeFileSync(seedFile, JSON.stringify({ ...rec, marker: 'x' }));
r = run(['seed', '--tasks', setFile, '--findings', csv]);
t('a seeded task stays frozen', JSON.parse(readFileSync(seedFile, 'utf8')).marker, 'x');
r = run(['seed', '--tasks', setFile, '--findings', csv, '--rewrite']);
t('--rewrite seeds again', JSON.parse(readFileSync(seedFile, 'utf8')).marker, undefined);

// A run: the current seat hits the seed and raises an unmatched finding; Codex misses on one task and hangs on the other.
const out = join(dir, 'out');
r = run(['--tasks', setFile, '--max-budget-usd', '1', '--out', out, '--seed', '3', '--timeout', '3']);
if (r.status !== 0) console.log(r.stderr);
t('runs to completion', r.status, 0);
const res = results(out);
const cl = calls('claude'), cx = calls('codex');
t('each seat reviews each task', `${cl.length} ${cx.length}`, '2 2');
const of = (list, word) => list.find((c) => (word ? c.brief.includes(word) : !c.brief.includes('HANG')));
t('AC2 the same brief to both seats', of(cl).brief === of(cx).brief, true);
t('AC2 the same prompt to both seats', of(cl).prompt === of(cx).prompt, true);
t('AC2 the brief carries the bar, the house ask, the format and the cold instruction', ['## The review bar', 'house ask', 'suggested_fix:', 'Argue that this change should not ship'].every((s) => of(cl).brief.includes(s)), true);
t('AC2 the brief names no seed', /seed|acted|unguarded|fixSrc/i.test(of(cl).brief.replace(/^## The review bar[\s\S]*?## Changed files/m, '')), false);
t('AC2 each seat reads the seeded code', `${of(cl).src.includes('unguarded call')} ${of(cx).src.includes('unguarded call')}`, 'true true');
t('AC2 the change is one neutral commit, no merged history', of(cx).log.trim().split('\n').join('|'), 'Change under review|base');
t('AC2 each seat has its own checkout', of(cl).cwd !== of(cx).cwd, true);
t('AC2 the Claude seat is refused the seeds and the results by name', [join(setDir, 'seeds'), out, setFile].every((p) => of(cl).permissions.deny.some((d) => d.includes(p))), true);
t('the Claude seat cannot write', of(cl).permissions.allow.some((a) => a.startsWith('Edit(')) || !of(cl).permissions.deny.includes('Edit'), false);
t('the current seat runs Opus with the finder prompt', `${of(cl).args[of(cl).args.indexOf('--model') + 1]} ${/You are Lena/.test(of(cl).args[of(cl).args.indexOf('--append-system-prompt') + 1])}`, 'opus true');
t('the Codex seat is read-only', of(cx).args[of(cx).args.indexOf('--sandbox') + 1], 'read-only');
const one = res['one.codex'], oneC = res['one.current'], hang = res['hang.codex'];
t('AC3 the current seat found the seed', JSON.stringify(scoreFindings(oneC.seeds, oneC.findings).found), '["seed-1"]');
t('AC3 the Codex seat missed it', JSON.stringify(scoreFindings(one.seeds, one.findings).found), '[]');
t('AC5 the verdict is read from the captured last message, not the progress', `${one.verdict} ${one.verdict_from}`, 'clean last-message.txt');
t('AC5 the effort it ran at is recorded', `${one.effort} ${one.ran_at.effort}`, 'high high');
t('AC5 the model too', one.ran_at.model, 'gpt-6.1-sol');
t('AC7 a timed-out seat is failed, not clean', `${hang.status} ${hang.verdict} ${hang.why}`, 'failed null timed out after 3s');
t('AC7 none of its findings are scored', hang.findings.length, 0);

r = run(['report', '--tasks', setFile, '--out', out]);
if (r.status !== 0) console.log(r.stderr);
const reportText = r.stdout;
const row = (text, label) => text.split('\n').find((l) => l.startsWith(`| ${label} |`))?.split(' | ').slice(1).map((c) => c.replace(/ \|$/, '')).join(' / ');
t('AC3 seeds found out of planted, per seat', row(reportText, 'Seeds found, of seeds planted'), '2 of 2 / 0 of 1');
t('AC7 the timed-out run is not in the Codex count', row(reportText, 'Runs failed (not scored)'), '0 / 1');
t('the seats differ in what they reviewed, and it says so', reportText.includes('did not review the same seeds'), true);
t('AC4 unmatched findings are listed', (reportText.match(/unrelated worry/g) ?? []).length, 2);
t('AC4 not counted before a mark', `${row(reportText, 'Marked real defects')} ${row(reportText, 'Marked false alarms')} ${row(reportText, 'Waiting for a mark')}`, '0 / 0 0 / 0 2 / 0');
const ids = reportText.split('\n').filter((l) => l.includes('unrelated worry')).map((l) => l.split(' | ')[0].replace('| ', ''));
r = run(['mark', '--tasks', setFile, '--out', out, ids[0], 'real']);
t('AC4 a finding is marked', r.status, 0);
r = run(['mark', '--tasks', setFile, '--out', out, ids[1], 'false-alarm']);
r = run(['report', '--tasks', setFile, '--out', out]);
t('AC4 counted once marked', `${row(r.stdout, 'Marked real defects')} ${row(r.stdout, 'Marked false alarms')} ${row(r.stdout, 'Waiting for a mark')}`, '1 / 0 1 / 0 0 / 0');
t('AC4 a bad mark is refused', run(['mark', '--tasks', setFile, '--out', out, ids[0], 'maybe']).status, 2);
t('AC4 an unknown id is refused', run(['mark', '--tasks', setFile, '--out', out, 'nope', 'real']).status, 2);

r = run(['--tasks', setFile, '--max-budget-usd', '1', '--out', out, '--seed', '3', '--timeout', '3']);
t('a reviewed seat is reused, a failed one runs again', `${calls('claude').length} ${calls('codex').length}`, '0 1');

// A Codex run whose tool calls reach for the seeds fails, and an answer in neither form fails.
writeFileSync(join(setDir, 'one.json'), JSON.stringify({ tasks: [task('one', 7, 'ticket one')] }));
const set1 = join(setDir, 'one.json');
const leak = join(dir, 'out-leak');
r = run(['--tasks', set1, '--seeds-dir', join(setDir, 'seeds'), '--max-budget-usd', '1', '--out', leak, '--seed', '1', '--timeout', '5'], { STUB_CODEX_READS: join(setDir, 'seeds', 'one', 'seeds.json') });
const leaked = results(leak)['one.codex'];
t('AC2 a Codex seat reading the seeds is failed', `${leaked.status} ${/which no seat may read/.test(leaked.why)}`, 'failed true');
const garbled = join(dir, 'out-garbled');
r = run(['--tasks', set1, '--max-budget-usd', '1', '--out', garbled, '--seed', '1', '--timeout', '5'], { STUB_CODEX_ANSWER: 'It looks fine to me.\n' });
t('an answer in neither form is a failed seat', results(garbled)['one.codex'].why, 'the seat answered with neither FINDING blocks nor NO FINDINGS');

const noLog = join(dir, 'out-no-log');
r = run(['--tasks', set1, '--max-budget-usd', '1', '--out', noLog, '--seed', '1', '--timeout', '5'], { STUB_CODEX_NO_LOG: '1', DESK_USAGE_DIR: join(dir, 'usage-no-log') });
if (!results(noLog)['one.codex']) console.log(r.stderr);
t('AC2 a Codex seat that left no session log is failed', `${results(noLog)['one.codex'].status} ${/no session log/.test(results(noLog)['one.codex'].why)}`, 'failed true');

const seatRun = (arm, status) => ({ arm, status, result: status === 'reviewed' ? { seeds: [{ id: 's', file: 'a', line: 1, end: 2 }], findings: [], effort: 'high' } : null });
const crossed = renderReport({ out: 'x', marks: {}, run: { leftOut: [], tasks: [{ task: 'a', runs: [seatRun('current', 'failed'), seatRun('codex', 'reviewed')] }, { task: 'b', runs: [seatRun('current', 'reviewed'), seatRun('codex', 'failed')] }] } });
t('equal seed counts over different tasks still say so', crossed.includes('did not review the same seeds'), true);

// With config §3 codex-review no, nothing goes to Codex.
const refusedRoot = join(dir, 'config-refused');
mkdirSync(join(refusedRoot, 'repos', 'acme__widgets'), { recursive: true });
writeFileSync(join(refusedRoot, 'repos', 'acme__widgets', 'config.md'), readFileSync(join(configRoot, 'repos', 'acme__widgets', 'config.md'), 'utf8').replace(CODEX_YES, CODEX_NO));
r = run(['--tasks', set1, '--max-budget-usd', '1', '--out', join(dir, 'out-refused'), '--seed', '1', '--timeout', '5'], { DESK_CONFIG_ROOT: refusedRoot });
t('codex-review no refuses the run before any seat', `${r.status} ${calls('claude').length} ${calls('codex').length} ${/codex-review is no/.test(r.stderr)}`, '2 0 0 true');

// A task with no seeds is left out and named; with none at all nothing is spent.
writeFileSync(join(setDir, 'no-seeds.json'), JSON.stringify({ tasks: [task('unseeded', 7, 'x')] }));
r = run(['--tasks', join(setDir, 'no-seeds.json'), '--max-budget-usd', '1', '--out', join(dir, 'out-none')]);
t('no seeded task refuses the run', `${r.status} ${calls('claude').length} ${/no task has a seed/.test(r.stderr)}`, '2 0 true');

if (fails) { console.log(`FAIL ${fails} check(s) failed`); process.exit(1); }
console.log('all bench arm 2 checks passed');
