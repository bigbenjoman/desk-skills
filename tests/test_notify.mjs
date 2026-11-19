// suite: notify: which notifier the supervisor uses on each computer
// notify.mjs's notifiers() with a fake platform and a fake PATH lookup: osascript on macOS; on Linux
// notify-send where it is there, then a Windows toast through powershell.exe (WSL); else none. Runs nothing.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const { notifiers } = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'notify.mjs'));
const has = (...cmds) => (c) => cmds.includes(c);
const TITLE = "desk: acme__widgets";
const BODY = "Check-in 09:00: it's 1 question; $(rm -rf ~) `x`";

let n = notifiers(TITLE, BODY, { plat: 'darwin', has: has() })[0];
t('macOS uses osascript, title and body as arguments', `${n[0]} ${n[1].slice(-2).join('|')}`, `osascript ${TITLE}|${BODY}`);
const both = notifiers(TITLE, BODY, { plat: 'linux', has: has('notify-send', 'powershell.exe') });
t('Linux tries notify-send first, then the WSL toast', both.map((x) => x[0]).join(' '), 'notify-send powershell.exe');
n = both[0];
t('notify-send gets title and body as arguments', `${n[0]} ${n[1].slice(-2).join('|')}`, `notify-send ${TITLE}|${BODY}`);
n = notifiers(TITLE, BODY, { plat: 'linux', has: has('powershell.exe') })[0];
t('WSL without notify-send uses powershell.exe with an encoded command', `${n[0]} ${n[1][2]}`, 'powershell.exe -EncodedCommand');
const script = Buffer.from(n[1][3], 'base64').toString('utf16le');
t('the toast carries the title as a PowerShell string', script.includes(`CreateTextNode('${TITLE}')`), true);
t('the body is one PowerShell string, its quote doubled and nothing else read', script.includes("CreateTextNode('Check-in 09:00: it''s 1 question; $(rm -rf ~) `x`')"), true);
t('Linux with neither has no notifier', notifiers(TITLE, BODY, { plat: 'linux', has: has() }).length, 0);
t('Windows itself has no notifier', notifiers(TITLE, BODY, { plat: 'win32', has: has('powershell.exe') }).length, 0);

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
