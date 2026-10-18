// suite: memory watch (avail band, heavy processes)
// The sustained-high watch and what counts as heavy: fixture `ps` output and stubbed memory
// figures only; nothing reads this computer.
import { heavyFromPs, sustainedBandGiB, sustainedStep } from '../desk/bin/desk-env.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

// ---- heavy: a playwright-mcp server is idle tooling, a playwright test run is a suite
const ps = [
  ' 2624 npm exec @playwright/mcp@latest',
  ' 2769 node /Users/me/.npm/_npx/9833c18b2d85bc59/node_modules/.bin/playwright-mcp',
  ' 4100 node /Users/me/app/node_modules/.bin/playwright test --workers=2',
  ' 4200 node /Users/me/app/node_modules/.bin/vitest run',
  ' 4300 /bin/zsh -c playwright test',
].join('\n');
const heavy = heavyFromPs(ps, 1).map((r) => r.pid).join(',');
t('playwright-mcp server not heavy, npm exec wrapper not heavy', heavy.includes('2769') || heavy.includes('2624'), false);
t('playwright test is heavy', heavy.includes('4100'), true);
t('vitest still heavy', heavy.includes('4200'), true);
t('shell wrapper carrying the name not heavy', heavy.includes('4300'), false);
t('own pid skipped', heavyFromPs(' 4100 node /x/.bin/playwright test', 4100).length, 0);

// ---- the band: 2 GiB unless the §3b row names a lower one; the drop-to worker count is not a band
t('row unset -> 2', sustainedBandGiB(''), 2);
t('template row -> 2', sustainedBandGiB('start > 8 GiB · hold 4–8 · drop to 1 below 4'), 2);
t('row naming a lower band -> it', sustainedBandGiB('start > 8 GiB · hold 4–8 · drop to 1 below 4 · reclaim below 1.5'), 1.5);
t('"1 below 4" count is not a band', sustainedBandGiB('start 8 · hold 4–8 · 1 below 4'), 2);

// ---- the watch: avail decides, held for the window, nothing heavy
const cfg = { band: 2, windowMs: 300_000 };
const run = (samples) => { let s = null; const lines = []; for (const x of samples) { const r = sustainedStep(s, x, cfg); s = r.state; if (r.line) lines.push(r.line); } return lines; };
const at = (min, avail, heavy = 0) => ({ now: min * 60_000, avail, heavy });

t('avail above the band: silent whatever vmmem reads', run([0, 1, 2, 3, 4, 5, 6, 10].map((m) => at(m, 28.8))).length, 0);
const fired = run([0, 1, 2, 3, 4, 5, 6].map((m) => at(m, 1.4)));
t('below the band for 5 minutes, nothing heavy: fires once', fired.length, 1);
t('the line carries SUSTAINED-HIGH and the avail figure', /^SUSTAINED-HIGH: avail=1\.4G below 2G for 5m/.test(fired[0] ?? ''), true);
t('below the band for 4 minutes: silent', run([0, 1, 2, 3, 4].map((m) => at(m, 1.4))).length, 0);
t('below the band with a suite running: silent', run([0, 1, 2, 3, 4, 5, 6].map((m) => at(m, 1.4, 1))).length, 0);
t('a recovery mid-window restarts the clock', run([at(0, 1.4), at(3, 5), at(4, 1.4), at(8, 1.4)]).length, 0);
t('a new episode after recovery fires again', run([at(0, 1.4), at(5, 1.4), at(6, 9), at(7, 1.4), at(12, 1.4)]).length, 2);

if (fails) { console.log(`FAIL: ${fails} checks failed`); process.exit(1); }
