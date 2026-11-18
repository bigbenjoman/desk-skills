// suite: notify: which notifier the supervisor uses on each computer
// notify.mjs's notifier() with a fake platform and a fake PATH lookup: osascript on macOS, notify-send on
// Linux where it is there, else a Windows toast through powershell.exe (WSL), else none. Runs nothing.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const { notifier } = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'notify.mjs'));
const has = (...cmds) => (c) => cmds.includes(c);
const TITLE = "desk: acme__widgets";
const BODY = "Check-in 09:00: it's 1 question; $(rm -rf ~) `x`";

let n = notifier(TITLE, BODY, { plat: 'darwin', has: has() });
t('macOS uses osascript, title and body as arguments', `${n[0]} ${n[1].slice(-2).join('|')}`, `osascript ${TITLE}|${BODY}`);
n = notifier(TITLE, BODY, { plat: 'linux', has: has('notify-send', 'powershell.exe') });
t('Linux with notify-send uses it, title and body as arguments', `${n[0]} ${n[1].slice(-2).join('|')}`, `notify-send ${TITLE}|${BODY}`);
n = notifier(TITLE, BODY, { plat: 'linux', has: has('powershell.exe') });
t('WSL without notify-send uses powershell.exe with an encoded command', `${n[0]} ${n[1][2]}`, 'powershell.exe -EncodedCommand');
const script = Buffer.from(n[1][3], 'base64').toString('utf16le');
t('the toast carries the title as a PowerShell string', script.includes(`CreateTextNode('${TITLE}')`), true);
t('the body is one PowerShell string, its quote doubled and nothing else read', script.includes("CreateTextNode('Check-in 09:00: it''s 1 question; $(rm -rf ~) `x`')"), true);
t('Linux with neither has no notifier', notifier(TITLE, BODY, { plat: 'linux', has: has() }), null);
t('Windows itself has no notifier', notifier(TITLE, BODY, { plat: 'win32', has: has('powershell.exe') }), null);

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
