// suite: upload-log (every screenshot upload and stall is a line in the machine's upload log)
// upload-log.mjs on its own: a fake upload's line, and a fake stall's counting the uploads in the
// minute and the hour before it. Then upload-images.mjs against a fake Playwright and a stub gh: each
// file uploaded is logged, and a stall is logged as throttled for the file it was waiting on.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logUpload, readUploadLog, uploadsBefore } from '../desk/bin/upload-log.mjs';

let fails = 0;
const t = (name, got, want) => {
  const g = typeof got === 'string' ? got : JSON.stringify(got); const w = typeof want === 'string' ? want : JSON.stringify(want);
  const ok = g === w; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${g}${ok ? '' : ` (want ${w})`}`);
};
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-upload-log-'));

// ---- the module: a fake upload, then a fake stall ---------------------------------------------
const log = join(T, 'unit', 'upload-log.jsonl');
const at = (s) => new Date(Date.parse('2026-11-15T12:00:00Z') + s * 1000);
const up = logUpload({ repo: 'acme/widgets', pr: '7', file: 'after-desktop.png', result: 'uploaded', at: at(0) }, log);
t('AC1: an upload is one line with time, repo, PR, file and result', readFileSync(log, 'utf8'),
  '{"at":"2026-11-15T12:00:00.000Z","repo":"acme/widgets","pr":7,"file":"after-desktop.png","result":"uploaded"}\n');
t('AC1: logUpload returns the line it wrote', up.result, 'uploaded');
// Uploads at 0s, 3000s and 3590s; the stall at 3600s: the one at 0s is an hour old, outside the hour.
logUpload({ repo: 'acme/widgets', pr: 7, file: 'b.png', result: 'uploaded', at: at(3000) }, log);
logUpload({ repo: 'acme/other', pr: 9, file: 'c.png', result: 'uploaded', at: at(3590) }, log);
const stall = logUpload({ repo: 'acme/widgets', pr: 7, file: 'd.png', result: 'throttled', at: at(3600) }, log);
t('AC2: a stall says throttled, with the uploads in the minute and the hour before, from every repo', stall,
  { at: '2026-11-15T13:00:00.000Z', repo: 'acme/widgets', pr: 7, file: 'd.png', result: 'throttled', uploads_last_minute: 1, uploads_last_hour: 2 });
t('AC2: a throttled line is not counted as an upload', uploadsBefore(readUploadLog(log), at(3601)), { uploads_last_minute: 1, uploads_last_hour: 2 });
writeFileSync(log, `${readFileSync(log, 'utf8')}{"at":"torn\n`);
t('a torn line is skipped, the rest still read', readUploadLog(log).length, 4);
t('no log yet reads as none', readUploadLog(join(T, 'nowhere.jsonl')).length, 0);

// ---- upload-images: a fake Playwright, a stub gh, the log under DESK_HOME ---------------------
mkdirSync(join(T, 'images')); mkdirSync(join(T, 'fakes')); mkdirSync(join(T, 'home'));
for (const f of ['after-desktop.png', 'after-mobile.png']) writeFileSync(join(T, 'images', f), f);
writeFileSync(join(T, 'profile.github-session.json'),
  '{"user":"me","cookies":[{"name":"user_session","value":"v","domain":"github.com","path":"/"}],"origins":[]}\n');
// GitHub writes an <img> tag into the textarea's value for each file; FAKE_STALL names one it never
// finishes, and while it waits each read of the box moves the clock on past the stall limit.
writeFileSync(join(T, 'pw.mjs'), `
const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
let value = '';
const loc = { first: () => loc, last: () => loc, or: () => loc, locator: () => loc, count: async () => 1,
  waitFor: async () => {}, scrollIntoViewIfNeeded: async () => {}, click: async () => {},
  setInputFiles: async (paths) => {
    for (const p of paths) {
      const f = p.split('/').pop(); const base = f.replace(/\\.[^.]+$/, '');
      if (f !== process.env.FAKE_STALL) value += '<img alt="' + base + '" src="https://github.com/user-attachments/assets/' + base + '">';
    }
  },
  inputValue: async () => { if (process.env.FAKE_STALL) skew += 200000; return value; }, fill: async (v) => { value = v; } };
const page = { goto: async () => {}, evaluate: async () => 'me', locator: () => loc, getByRole: () => loc };
const ctx = { addCookies: async () => {}, pages: () => [page], newPage: async () => page, cookies: async () => [], close: async () => {} };
export const chromium = { launchPersistentContext: async () => ctx };
`);
const body = join(T, 'body.md');
writeFileSync(join(T, 'fakes', 'gh'), `#!/usr/bin/env node
const fs = require('fs');
if (process.argv[3] === 'edit') fs.writeFileSync(${JSON.stringify(body)}, fs.readFileSync(0, 'utf8'));
else process.stdout.write(fs.readFileSync(${JSON.stringify(body)}, 'utf8'));
`);
chmodSync(join(T, 'fakes', 'gh'), 0o755);
const deskHome = join(T, 'desk');
const upload = (stall = '') => {
  rmSync(join(T, 'images.tags.json'), { force: true });   // each run uploads afresh, not from the last run's links
  writeFileSync(body, '| _drag after-desktop.png_ | _drag after-mobile.png_ |\n');
  const env = { ...process.env, HOME: join(T, 'home'), PATH: `${join(T, 'fakes')}:${process.env.PATH}`, DESK_HOME: deskHome,
    DESK_UPLOAD_APPROVED: '1', DESK_BROWSER_PROFILE: join(T, 'profile'), DESK_PLAYWRIGHT: join(T, 'pw.mjs'),
    DESK_GH_REPO: 'acme/widgets', DESK_REPO_OVERRIDE: 'acme/widgets', DESK_CONFIG_ROOT: join(T, 'cfg'), FAKE_STALL: stall };
  return spawnSync('node', [join(BIN, 'upload-images.mjs'), '7', join(T, 'images')], { cwd: T, env, encoding: 'utf8' });
};
mkdirSync(join(T, 'cfg', 'repos', 'acme__widgets'), { recursive: true });
writeFileSync(join(T, 'cfg', 'repos', 'acme__widgets', 'config.md'), '## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/widgets` |\n');

const machineLog = join(deskHome, 'upload-log.jsonl');
const shape = (e) => `${e.repo} #${e.pr} ${e.file} ${e.result}${'uploads_last_minute' in e ? ` minute=${e.uploads_last_minute} hour=${e.uploads_last_hour}` : ''}`;
let r = upload();
t('AC1: a clean upload exits 0', `${r.status}`, '0');
t('AC1: each file uploaded is a line in <DESK_HOME>/upload-log.jsonl', readUploadLog(machineLog).map(shape),
  ['acme/widgets #7 after-desktop.png uploaded', 'acme/widgets #7 after-mobile.png uploaded']);
t('AC1: each line has the time it finished', readUploadLog(machineLog).every((e) => Math.abs(Date.now() - Date.parse(e.at)) < 60_000), true);

r = upload('after-mobile.png');
t('AC2: a stall stops the upload as throttled', `${r.status}`, '7');
t('AC2: the stall says where it was logged', r.stderr.includes(`stalled on after-mobile.png, logged as throttled in ${machineLog}`), true);
// The fake clock fills after-desktop 200s into the run and stalls 201s later, so only the hour counts it.
t('AC2: the stalled file is logged throttled, counting the uploads by when each finished', readUploadLog(machineLog).slice(2).map(shape),
  ['acme/widgets #7 after-desktop.png uploaded', 'acme/widgets #7 after-mobile.png throttled minute=0 hour=3']);
t('AC2: a stalled run leaves the stalled file\'s cell for the next run', readFileSync(body, 'utf8').includes('_drag after-mobile.png_'), true);

rmSync(T, { recursive: true, force: true });
console.log(`${fails ? 'FAIL ' : ''}${fails} failed`);
process.exit(fails ? 1 : 0);
