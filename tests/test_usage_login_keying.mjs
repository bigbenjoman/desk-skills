// suite: usage reading keyed per login (a login named in the subscriptions file, whatever its rule, keeps its own probe log and reading)
// layer: L2
// issue-1588: a subscriptions file listing `studia` (rule default, ~/.claude-logins/studia) and `gmail`
// (rule unused, ~/.claude-logins/gmail), each with its own probe reading and resets, under a scratch HOME
// and a fake claude that records the folder it runs in. Nothing reads this computer's logins.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = scratch('desk-usage-login-keying-');
const H = join(T, 'home');
const STUDIA = join(H, '.claude-logins', 'studia');
const GMAIL = join(H, '.claude-logins', 'gmail');
for (const d of [join(H, '.claude'), STUDIA, GMAIL]) mkdirSync(d, { recursive: true });
for (const k of ['CLAUDE_CONFIG_DIR', 'DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_CONFIG', 'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'NO_COLOR']) delete process.env[k];
Object.assign(process.env, { HOME: H, DESK_CONFIG_ROOT: join(H, '.config', 'desk'), DESK_SUBSCRIPTIONS: join(T, 'subscriptions.md'),
  DESK_USAGE_DIR: join(T, 'usage'), DESK_LOCK_DIR: join(T, 'locks'), TZ: 'UTC' });
mkdirSync(process.env.DESK_USAGE_DIR);
mkdirSync(process.env.DESK_LOCK_DIR);
writeFileSync(process.env.DESK_SUBSCRIPTIONS, `| Tool | Name | Folder | Rule |\n|---|---|---|---|
| \`claude\` | \`studia\` | \`~/.claude-logins/studia\` | \`default\` |
| \`claude\` | \`gmail\` | \`~/.claude-logins/gmail\` | \`unused\` |
| \`claude\` | \`spare\` | \`~/.claude-logins/spare\` | \`off\` |\n`);

// The fake claude: a probe records the folder it ran in and answers with that folder's reading.
const FB = join(T, 'bin');
const CALLS = join(T, 'calls');
mkdirSync(FB);
writeFileSync(join(FB, 'claude'), `#!/bin/sh
printf '%s\\n' "\${CLAUDE_CONFIG_DIR-unset}" >> "${CALLS}"
cat "\${CLAUDE_CONFIG_DIR}/reading" 2>/dev/null
echo '{"type":"result","is_error":false}'
`);
chmodSync(join(FB, 'claude'), 0o755);

const P = await import(join(BIN, 'usage-probe.mjs'));
const L = await import(join(BIN, 'claude-logins.mjs'));
const Q = await import(join(BIN, 'desk-q.mjs'));

const now = Date.now();
const at = (h) => Math.round(now / 1000) + h * 3600;
const reading = (five, fiveAt, seven, sevenAt) => `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
  five_hour: { utilization: five, resetsAt: fiveAt }, seven_day: { utilization: seven, resetsAt: sevenAt } } } })}\n`;
const D = process.env.DESK_USAGE_DIR;
const byName = (n) => L.claudeLogins().find((l) => l.name === n);

// ---- AC1: each login named in the file keys its own probe log, whatever its rule
t('AC1 gmail (rule unused) has a probe log of its own, not the default\'s', P.loginProbeLog(D, 'gmail') !== P.probeLog(D), true);
t('AC1 named or given, gmail is one log', P.loginProbeLog(D, 'gmail'), P.loginProbeLog(D, byName('gmail')));
t('AC1 studia (rule default) and gmail keep apart', P.loginProbeLog(D, 'studia') !== P.loginProbeLog(D, 'gmail'), true);
t('AC1 a login the file names with no folder yet is keyed on its name', P.loginProbeLog(D, 'spare'), join(D, 'probe.spare.log'));
t('AC1 the default named is ~/.claude\'s probe log', P.loginProbeLog(D, 'default'), P.probeLog(D));
let thrown = null;
try { P.loginProbeLog(D, 'nobody'); } catch (e) { thrown = e.message; }
t('AC1 a name no login has is an error, never the default\'s log', thrown, 'no Claude login named nobody');

// Two readings with different figures and different resets.
const sFive = at(3), sSeven = at(30), gFive = at(4.5), gSeven = at(100);
writeFileSync(P.loginProbeLog(D, 'studia'), reading(0.05, sFive, 0.18, sSeven));
writeFileSync(P.loginProbeLog(D, 'gmail'), reading(0.12, gFive, 0.36, gSeven));
const sR = P.readUsage({ login: 'studia', now }), gR = P.readUsage({ login: 'gmail', now });
t('AC1 readUsage reads studia\'s figures as studia\'s', `${sR.seven_day.utilization} ${sR.seven_day.resetsAt === sSeven} ${sR.five_hour.resetsAt === sFive}`, '0.18 true true');
t('AC1 readUsage reads gmail\'s figures as gmail\'s, with its own resets', `${gR.seven_day.utilization} ${gR.seven_day.resetsAt === gSeven} ${gR.five_hour.resetsAt === gFive}`, '0.36 true true');
t('AC1 named or given, gmail reads the same', P.readUsage({ login: byName('gmail'), now }).seven_day.utilization, 0.36);
t('AC1 the default login with no reading of its own reads none', P.readUsage({ now }).at, null);
t('AC1 the printed readings give each login its own figure', /^default +no reading\nstudia +5h 5%.* · 7d 18%.*\ngmail +5h 12%.* · 7d 36%/.test(P.readingsText(P.usageByLogin({ now }), now)), true);

// ---- AC1: a probe for a login runs in that login's folder, and its output is that login's
t('AC1 the probe environment for gmail is gmail\'s folder', P.probeEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: STUDIA }, 'gmail').CLAUDE_CONFIG_DIR, GMAIL);
writeFileSync(join(GMAIL, 'reading'), reading(0.2, gFive, 0.4, gSeven));
const answer = P.probeNow({ dir: D, claude: join(FB, 'claude'), login: 'gmail' });
t('AC1 probeNow on gmail answers', answer.ok, true);
t('AC1 and ran in gmail\'s folder', readFileSync(CALLS, 'utf8').trim(), GMAIL);
t('AC1 and its reading is gmail\'s alone', `${P.readUsage({ login: 'gmail', now: Date.now() }).seven_day.utilization} ${P.readUsage({ login: 'studia', now: Date.now() }).seven_day.utilization}`, '0.4 0.18');
t('AC1 its start stamp is gmail\'s', `${existsSync(join(D, 'probe.gmail.at'))} ${existsSync(join(D, 'probe.at'))}`, 'true false');
writeFileSync(P.loginProbeLog(D, 'gmail'), reading(0.12, gFive, 0.36, gSeven));

// ---- AC2: desk-q shows one usage line per Claude login with a reading, each its own figures and reset
const text = (line) => line.segs.map((s) => s[0]).join('');
const lines = Q.usageLines(Q.usageOf([], now), { now }).map(text);
const day = (s) => new Date(s * 1000).toLocaleDateString('en-GB', { weekday: 'short' });
t('AC2 two Claude lines: studia, the default, then gmail; ~/.claude has no reading and no line', lines.length, 2);
t('AC2 studia\'s line has its own figures', /studia {2}5h .* 5% .*7d .* 18% /.test(lines[0]) && lines[0].includes('│ default'), true);
t('AC2 and its own 7-day reset', lines[0].includes(day(sSeven)), true);
t('AC2 gmail\'s line has its own figures, not studia\'s', /gmail {3}5h .* 12% .*7d .* 36% /.test(lines[1]) && !lines[1].includes('18%'), true);
t('AC2 and its own 7-day reset, not studia\'s', lines[1].includes(day(gSeven)) && !lines[1].includes(day(sSeven)), true);
t('AC2 gmail\'s line is not marked the default', lines[1].includes('default'), false);
t('AC2 the names line up', lines[0].indexOf('5h'), lines[1].indexOf('5h'));

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
