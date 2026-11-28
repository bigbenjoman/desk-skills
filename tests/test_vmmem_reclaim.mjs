// suite: WSL page-cache reclaim (the gap and interval decision, the run log, reclaim before VMMEM-HIGH holds)
// layer: L1
// covers: desk/bin/vmmem-reclaim.mjs desk/bin/machine.mjs
// Stubbed vmmem readings and a stubbed drop; nothing reads or reclaims this computer's memory.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { reclaimSettings, reclaimDue, reclaimStep, reclaimBeforeHold, reclaimStatusLine, dropCaches, lastReclaim, readReclaims,
  wslconfigReclaim, withDropCache, RECLAIM_SCRIPT } from '../desk/bin/vmmem-reclaim.mjs';
import { benchSettingError, profileProblems } from '../desk/bin/machine.mjs';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const MIN = 60_000;

// ---- the settings: off unless `on`, the gap 3G and the interval 5m unless set to a number above 0
const rows = (o) => (k) => o[k] ?? null;
t('unset: off, 3G, 5m', JSON.stringify(reclaimSettings(rows({}))), JSON.stringify({ on: false, gapGiB: 3, intervalMs: 5 * MIN }));
t('on with its own gap and interval', JSON.stringify(reclaimSettings(rows({ 'vmmem-reclaim': 'on', 'vmmem-reclaim-gap-gb': '2.5', 'vmmem-reclaim-interval-min': '10' }))),
  JSON.stringify({ on: true, gapGiB: 2.5, intervalMs: 10 * MIN }));
t('anything but on is off, and a gap or interval that does not read keeps its default', JSON.stringify(reclaimSettings(rows({ 'vmmem-reclaim': 'yes', 'vmmem-reclaim-gap-gb': '0', 'vmmem-reclaim-interval-min': 'TODO' }))),
  JSON.stringify({ on: false, gapGiB: 3, intervalMs: 5 * MIN }));
t('the profile row takes on or off', benchSettingError('vmmem-reclaim', 'on'), null);
t('and refuses anything else', benchSettingError('vmmem-reclaim', 'yes'), '`vmmem-reclaim` is "yes": want on or off');
t('the gap row takes a number over 0', benchSettingError('vmmem-reclaim-gap-gb', '3'), null);
t('the interval row refuses 0', benchSettingError('vmmem-reclaim-interval-min', '0'), '`vmmem-reclaim-interval-min` is "0": want a number of minutes over 0');
t('a hand-edited row that does not read is named, the reclaim staying off', profileProblems({ sizing: { 'vmmem-reclaim': { value: 'maybe' } } })[0], '`vmmem-reclaim` is "maybe": want on or off; the WSL reclaim stays off');

// ---- the decision: gap at or above, at most once per interval
const s = { gapGiB: 3, intervalMs: 5 * MIN };
t('gap under 3G: not due', reclaimDue({ now: 0, usedGiB: 7.9, rssGiB: 5 }, s).due, false);
t('gap of exactly 3G: due', reclaimDue({ now: 0, usedGiB: 8, rssGiB: 5 }, s).due, true);
t('the 26 Nov host, 10.4G against 4.9G RSS: due', reclaimDue({ now: 0, usedGiB: 10.4, rssGiB: 4.9 }, s).due, true);
t('a run 4m ago: not due, naming the interval', reclaimDue({ now: 10 * MIN, usedGiB: 10.4, rssGiB: 4.9, lastAt: 6 * MIN }, s).why, 'the last reclaim was 4m ago, within the 5m interval');
t('a run 5m ago: due again', reclaimDue({ now: 11 * MIN, usedGiB: 10.4, rssGiB: 4.9, lastAt: 6 * MIN }, s).due, true);
t('RSS unread: not due', reclaimDue({ now: 0, usedGiB: 10.4, rssGiB: NaN }, s).due, false);
t('vmmem unread: not due, even forced', reclaimDue({ now: 0, usedGiB: NaN, rssGiB: 1 }, s, { force: true }).due, false);
t('forced: the gap aside', reclaimDue({ now: 0, usedGiB: 6, rssGiB: 5 }, s, { force: true }).due, true);
t('forced: the interval kept', reclaimDue({ now: 2 * MIN, usedGiB: 6, rssGiB: 5, lastAt: 0 }, s, { force: true }).due, false);

// ---- one step: runs when due, logs before and after, and the next step inside the interval does not
const dir = scratch('vmmem-reclaim-');
const file = join(dir, 'vmmem-reclaim.jsonl');
let vm = 10.4;
let drops = 0;
const drop = () => { drops++; vm = 5.8; return { ok: true, error: null }; };
const read = () => ({ usedGiB: vm, grantGiB: 12, rssGiB: 4.9 });
const on = { on: true, ...s };
const r1 = reclaimStep({ now: 100 * MIN, settings: on, read, file, drop });
t('due: it runs, and says vmmem before and after', r1.line, 'VMMEM-RECLAIM: dropped caches and compacted memory (watch): vmmem 10.4G -> 5.8G, RSS 4.9G');
t('the run is logged with its figures', JSON.stringify(lastReclaim(file)), JSON.stringify({ at: 100 * MIN, by: 'watch', beforeGiB: 10.4, afterGiB: 5.8, rssGiB: 4.9, ok: true, error: null }));
vm = 10.4;
const r2 = reclaimStep({ now: 102 * MIN, settings: on, read, file, drop });
t('2m later, gap back: not run, within the interval', `${r2.ran} ${drops}`, 'false 1');
const r3 = reclaimStep({ now: 105 * MIN, settings: on, read, file, drop });
t('5m later: runs again', `${r3.ran} ${drops} ${readReclaims(file).length}`, 'true 2 2');
const failed = reclaimStep({ now: 200 * MIN, settings: on, read: () => ({ usedGiB: 10, rssGiB: 4 }), file, drop: () => ({ ok: false, error: 'wsl.exe exited 1' }) });
t('a failed drop is said and logged as failed', `${failed.line} | ${lastReclaim(file).ok}`, 'VMMEM-RECLAIM: failed (watch): wsl.exe exited 1; vmmem 10.0G -> 10.0G, RSS 4.0G | false');

// ---- the drop: root runs the script itself, anyone else through wsl.exe -u root, the stub where set
const calls = [];
const spy = (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { status: 0, stderr: '' }; };
dropCaches({ run: spy, uid: 0, env: {} });
dropCaches({ run: spy, uid: 1000, env: {} });
dropCaches({ run: spy, uid: 1000, env: { DESK_VMMEM_RECLAIM_CMD: 'true' } });
t('as root: sh -c the script', calls[0], `sh -c ${RECLAIM_SCRIPT}`);
t('not root: through wsl.exe as root', calls[1], `wsl.exe -u root -e sh -c ${RECLAIM_SCRIPT}`);
t('DESK_VMMEM_RECLAIM_CMD stands in', calls[2], 'sh -c true');
t('a non-zero exit is a failure naming stderr', dropCaches({ run: () => ({ status: 1, stderr: 'permission denied\n' }), uid: 1000, env: {} }).error, 'wsl.exe exited 1: permission denied');

// ---- before VMMEM-HIGH holds: one reclaim, then vmmem read again against the line
const holdFile = join(dir, 'hold.jsonl');
vm = 11.4; drops = 0;
const freed = reclaimBeforeHold({ settings: on, vmmemShare: 0.9, read, file: holdFile, now: 300 * MIN, drop });
t('the reclaim frees enough: the hold is released', freed.over, false);
t('it ran once, the gap aside (11.4G vs 4.9G RSS is over it anyway)', drops, 1);
t('and says so, then the reading after', JSON.stringify(freed.lines), JSON.stringify([
  'VMMEM-RECLAIM: dropped caches and compacted memory (pass, before VMMEM-HIGH holds spawns): vmmem 11.4G -> 5.8G, RSS 4.9G',
  'VMMEM-HIGH: the WSL VM holds 5.8G of its 12.0G grant now (48%), under its 90% line, so it no longer holds spawns']));
vm = 11.4;
const stuck = reclaimBeforeHold({ settings: on, vmmemShare: 0.9, read, file: holdFile, now: 301 * MIN, drop: () => { drops++; return { ok: true, error: null }; } });
t('within the interval of the last run: no second run, vmmem still read again', `${drops} ${stuck.over}`, '1 true');
t('and the hold stands, saying why', JSON.stringify(stuck.lines), JSON.stringify([
  'VMMEM-RECLAIM: not run before VMMEM-HIGH holds spawns: the last reclaim was 1m ago, within the 5m interval',
  'VMMEM-HIGH: the WSL VM still holds 11.4G of its 12.0G grant (95%), at or over its 90% line: hold new spawns']));
const small = reclaimBeforeHold({ settings: on, vmmemShare: 0.9, read: () => ({ usedGiB: 11, grantGiB: 12, rssGiB: 10.5 }), file: join(dir, 'small.jsonl'), now: 0, drop: () => { drops++; return { ok: true, error: null }; } });
t('a gap under the watch\'s 3G still gets the one reclaim', `${drops} ${small.over}`, '2 true');
t('with the reclaim off: nothing runs, the hold stands', JSON.stringify(reclaimBeforeHold({ settings: { ...on, on: false }, vmmemShare: 0.9, read, file: holdFile, drop })), JSON.stringify({ lines: [], over: true }));
t('a dry run reads again but drops nothing', `${reclaimBeforeHold({ settings: on, vmmemShare: 0.9, read: () => ({ usedGiB: 5, grantGiB: 12, rssGiB: 4 }), file: join(dir, 'dry.jsonl'), dry: true, drop: () => { throw new Error('dropped'); } }).over}`, 'false');
t('vmmem unreadable after: the hold stands', reclaimBeforeHold({ settings: on, vmmemShare: 0.9, read: () => ({ usedGiB: NaN, grantGiB: NaN, rssGiB: NaN }), file: join(dir, 'nan.jsonl'), drop }).over, true);

// ---- mem status
t('status off, never run', reclaimStatusLine({ on: false, gapGiB: 3, intervalMs: 5 * MIN }, null), 'reclaim: off (desk-env machine set vmmem-reclaim=on turns it on); last run: never');
t('status on, with its last run', reclaimStatusLine(on, { at: Date.UTC(2026, 10, 26, 14, 2), by: 'watch', beforeGiB: 10.4, afterGiB: 5.8, rssGiB: 4.9, ok: true }, Date.UTC(2026, 10, 26, 14, 14)),
  'reclaim: on, at vmmem 3G or more over RSS, at most every 5m; last run 2026-11-26 14:02 UTC (12m ago, watch): vmmem 10.4G -> 5.8G, RSS 4.9G');

// ---- .wslconfig: read autoMemoryReclaim, and set dropCache
t('no file: unset', wslconfigReclaim(''), null);
t('set under [experimental]', wslconfigReclaim('[wsl2]\r\nmemory=12GB\r\n[experimental]\r\nautoMemoryReclaim=gradual\r\n'), 'gradual');
t('a commented line or another section does not count', wslconfigReclaim('[wsl2]\nautoMemoryReclaim=dropCache\n[experimental]\n# autoMemoryReclaim=dropCache\n'), null);
t('empty file: the section is added', withDropCache(''), '[experimental]\nautoMemoryReclaim=dropCache\n');
t('no section: added at the end, CRLF kept', withDropCache('[wsl2]\r\nmemory=12GB\r\n'), '[wsl2]\r\nmemory=12GB\r\n\r\n[experimental]\r\nautoMemoryReclaim=dropCache\r\n');
t('the section without the key: added under its header', withDropCache('[experimental]\nsparseVhd=true\n'), '[experimental]\nautoMemoryReclaim=dropCache\nsparseVhd=true\n');
t('an existing value: replaced', withDropCache('[experimental]\nautoMemoryReclaim=gradual\n'), '[experimental]\nautoMemoryReclaim=dropCache\n');
t('what it writes reads back as dropCache', wslconfigReclaim(withDropCache('[wsl2]\nmemory=12GB')), 'dropCache');

writeFileSync(join(dir, 'garbled.jsonl'), 'not json\n{"at":1,"ok":true}\n');
t('a garbled log line is skipped', readReclaims(join(dir, 'garbled.jsonl')).length, 1);

// ---- the CLI on a config that says WSL: mem status's reclaim line, and machine wslconfig
const home = scratch('vmmem-reclaim-cli-');
writeFileSync(join(home, 'cfg.md'), '# cfg\n\n## 2. Paths on your machine\n\n| Field | Value | Notes |\n|---|---|---|\n| Running on WSL? | `yes` | |\n');
writeFileSync(join(home, 'machine.md'), '# Machine\n\n## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| vmmem-reclaim | on | test |\n');
const cli = (...args) => spawnSync(process.execPath, [new URL('../desk/bin/desk-env.mjs', import.meta.url).pathname, ...args], { cwd: home, encoding: 'utf8',
  env: { ...process.env, HOME: home, DESK_CONFIG: join(home, 'cfg.md'), DESK_MACHINE: join(home, 'machine.md'), DESK_WSLCONFIG: join(home, '.wslconfig') } });
t('mem status names the reclaim on WSL', cli('mem', 'status').stdout.split('\n')[1], 'reclaim: on, at vmmem 3G or more over RSS, at most every 5m; last run: never');
t('wslconfig reads unset', cli('machine', 'wslconfig').stdout.split('\n')[1], 'AUTO_MEMORY_RECLAIM=unset');
t('wslconfig set says it applies after the next WSL restart', /applies after the next WSL restart/.test(cli('machine', 'wslconfig', 'set').stdout), true);
t('and wrote it', readFileSync(join(home, '.wslconfig'), 'utf8'), '[experimental]\nautoMemoryReclaim=dropCache\n');

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
