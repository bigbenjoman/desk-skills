// desk-design.mjs on a fixture snapshot: write records source.json and a README with the
// ticket-to-board table; save copies canvas.json, the boards and the local files they reference into
// the Design canvases directory, once per artifact; status sees a newer version; check reports a
// Claude Design link with no saved copy. Scratch git repos only.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { save, status, checkTicket, collect, parseBoards, writeRecord, canonicalUrl } from '../desk/bin/desk-design.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const throws = (fn) => { try { fn(); return 'no error'; } catch (e) { return `${e.code}:${e.message.split('\n')[0]}`; } };
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'desk-design.mjs');
const T = mkdtempSync(join(tmpdir(), 'desk-design-'));
const put = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const read = (p) => readFileSync(p, 'utf8');
const json = (p) => JSON.parse(read(p));
const URL1 = 'https://claude.ai/design/p/abc123';

// A snapshot as the Artifact tool writes it: project/ with the canvas, two boards, the runtime,
// a stylesheet and a font it loads, plus a Google font that needs the network.
function snapshot(dir, { version = '7', font = true } = {}) {
  put(join(dir, 'project/canvas.json'), JSON.stringify({ title: 'Admin console', boards: [
    { id: 'b1', title: 'Admin 390', width: 390, file: 'admin-390.dc.html' },
    { id: 'b2', title: 'Admin 1280', width: 1280, file: 'admin-1280.dc.html' },
  ] }));
  put(join(dir, 'project/admin-390.dc.html'), `<script src="support.js"></script><link rel="stylesheet" href="./styles/fonts.css">
<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet"><img src="data:image/png;base64,AA"><a href="#top">v${version}</a>`);
  put(join(dir, 'project/admin-1280.dc.html'), '<script src="support.js"></script><dc-import src="admin-390.dc.html"></dc-import>');
  put(join(dir, 'project/support.js'), 'window.dc = {};');
  put(join(dir, 'project/styles/fonts.css'), "@font-face { src: url('../fonts/Inter.woff2?v=1') format('woff2'); }");
  if (font) put(join(dir, 'project/fonts/Inter.woff2'), 'FONT');
  put(join(dir, 'project/unrelated.txt'), 'not referenced');
  return dir;
}
const repo = (name) => {
  const r = join(T, name);
  mkdirSync(r, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', r]);
  return r;
};
const DIR = 'docs/design';

// ---- parsing ----
t('parseBoards reads names and widths', parseBoards(json(join(snapshot(join(T, 's0')), 'project/canvas.json'))).map((b) => `${b.name}@${b.width}`).join(' '), 'Admin 390@390 Admin 1280@1280');
const c0 = collect(join(T, 's0'));
t('collect: canvas, boards, runtime, stylesheet and the font it loads', c0.files.join(' '),
  'project/admin-1280.dc.html project/admin-390.dc.html project/canvas.json project/fonts/Inter.woff2 project/styles/fonts.css project/support.js');
t('collect: a remote font is reported, not copied', c0.remote.join(' '), 'https://fonts.googleapis.com/css2?family=Inter');
t('collect: nothing missing', c0.missing.length, 0);
t('canonicalUrl ignores a trailing slash, fragment and host case', canonicalUrl('https://Claude.ai/design/p/abc123/#x'), URL1);

// ---- write (source.json and README from a folder) ----
const w = snapshot(join(T, 'w'));
writeRecord(w, { url: URL1, version: '7', fetched_at: '2026-10-17T10:00:00Z', dir: 'DS-50', tickets: [{ key: 'DS-51', boards: ['Admin 1280'] }, { key: 'DS-52', boards: [] }], boards: parseBoards(json(join(w, 'project/canvas.json'))) });
const ws = json(join(w, 'source.json'));
t('write: source.json url, version, fetched-at', `${ws.url} ${ws.version} ${ws.fetched_at}`, `${URL1} 7 2026-10-17T10:00:00Z`);
t('write: source.json ticket keys', ws.tickets.map((x) => x.key).join(' '), 'DS-51 DS-52');
const wr = read(join(w, 'README.md'));
t('write: README maps a ticket to its boards', wr.includes('| DS-51 | Admin 1280 (1280px) |'), true);
t('write: README gives a ticket with no boards every board', wr.includes('| DS-52 | Admin 390 (390px), Admin 1280 (1280px) |'), true);
t('write: README names the artifact URL', wr.includes(URL1), true);
t('write: a different URL in the same folder is refused', throws(() => writeRecord(w, { url: 'https://claude.ai/design/p/other', version: '1', fetched_at: 'x', tickets: [] })).startsWith('2:this folder already holds'), true);

// ---- save ----
const r1 = repo('r1');
const s1 = snapshot(join(T, 's1'));
const a = save(s1, { root: r1, dir: DIR, tickets: [{ key: 'DS-51', boards: [] }], epic: 'DS-50', url: URL1, version: '7', now: '2026-10-17T11:00:00Z' });
t('save: under the epic', a.path, 'docs/design/DS-50/');
t('save: the font is on disk', read(join(r1, DIR, 'DS-50/project/fonts/Inter.woff2')), 'FONT');
t('save: support.js is on disk', existsSync(join(r1, DIR, 'DS-50/project/support.js')), true);
t('save: an unreferenced file is not copied', existsSync(join(r1, DIR, 'DS-50/project/unrelated.txt')), false);
t('save: source.json records the files', json(join(r1, DIR, 'DS-50/source.json')).files.length, 6);
t('save: README written', read(join(r1, DIR, 'DS-50/README.md')).includes('| DS-51 |'), true);

// One canvas, several tickets: the second is added to the folder that already holds the artifact.
const b = save(s1, { root: r1, dir: DIR, tickets: [{ key: 'DS-53', boards: ['Admin 390'] }], url: `${URL1}/`, version: '7' });
t('save: a second ticket reuses the folder', `${b.path} ${b.reused}`, 'docs/design/DS-50/ true');
t('save: both tickets recorded', json(join(r1, DIR, 'DS-50/source.json')).tickets.map((x) => x.key).join(' '), 'DS-51 DS-53');
t('save: no second folder', existsSync(join(r1, DIR, 'DS-53')), false);

// Without an epic, the first ticket's key names the folder.
const r2 = repo('r2');
t('save: without an epic, under the ticket', save(s1, { root: r2, dir: DIR, tickets: [{ key: 'DS-60', boards: [] }], url: URL1, version: '7' }).path, 'docs/design/DS-60/');

// A snapshot missing a referenced font is refused whole.
const r3 = repo('r3');
const s3 = snapshot(join(T, 's3'), { font: false });
t('save: a missing referenced font refuses the save', throws(() => save(s3, { root: r3, dir: DIR, tickets: [{ key: 'DS-61', boards: [] }], url: URL1, version: '7' })).startsWith('4:not saved'), true);
t('save: nothing written when refused', existsSync(join(r3, DIR)), false);

// A batch snapshot carries every key sharing the canvas, so two workers write identical files.
const sb = snapshot(join(T, 'sb'));
writeRecord(sb, { url: URL1, version: '7', fetched_at: '2026-10-17T09:00:00Z', dir: 'DS-50', tickets: [{ key: 'DS-51', boards: [] }, { key: 'DS-52', boards: [] }], boards: [] });
const rA = repo('rA'); const rB = repo('rB');
save(sb, { root: rA, dir: DIR, tickets: [{ key: 'DS-51', boards: [] }] });
save(sb, { root: rB, dir: DIR, tickets: [{ key: 'DS-52', boards: [] }] });
t('save: parallel workers write the same source.json', read(join(rA, DIR, 'DS-50/source.json')) === read(join(rB, DIR, 'DS-50/source.json')), true);
t('save: and the same README', read(join(rA, DIR, 'DS-50/README.md')) === read(join(rB, DIR, 'DS-50/README.md')), true);
t('save: url and version come from the snapshot', json(join(rA, DIR, 'DS-50/source.json')).version, '7');

// ---- status and a re-save ----
t('status: same version is current', status(join(r1, DIR, 'DS-50'), '7').state, 'current');
t('status: another version is newer', status(join(r1, DIR, 'DS-50'), '8').state, 'newer');
t('status: by URL', status(URL1, '8', { root: r1, dir: DIR }).state, 'newer');
const s4 = snapshot(join(T, 's4'), { version: '8' });
rmSync(join(s4, 'project/styles'), { recursive: true });
put(join(s4, 'project/admin-390.dc.html'), '<script src="support.js"></script>');
const c = save(s4, { root: r1, dir: DIR, tickets: [{ key: 'DS-51', boards: [] }], url: URL1, version: '8' });
t('re-save: reports the version it replaced', `${c.previous}->${c.source.version}`, '7->8');
t('re-save: a file the new version dropped is removed', existsSync(join(r1, DIR, 'DS-50/project/styles/fonts.css')), false);
t('re-save: other tickets kept', c.source.tickets.map((x) => x.key).join(' '), 'DS-51 DS-53');

// ---- check (the lint finding) ----
const issue = (desc, parent = { key: 'DS-50', fields: { issuetype: { name: 'Epic', hierarchyLevel: 1 } } }) => ({ key: 'DS-70', fields: { description: desc, parent } });
const r5 = repo('r5');
const unsaved = checkTicket(issue(`h2. Outcome\nx\nh2. Design\n* [Admin|${URL1}]\nh2. Out of scope\n* https://claude.ai/design/p/later`), { root: r5, dir: DIR });
t('check: an unsaved link is one blocking finding', unsaved.map((f) => f.severity).join(' '), 'blocking');
t('check: it names the URL and the epic path', unsaved[0].message.includes(URL1) && unsaved[0].message.includes('docs/design/DS-50/'), true);
t('check: only the Design section is read', unsaved.some((f) => f.message.includes('later')), false);
t('check: no parent epic, the ticket path', checkTicket(issue(`h2. Design\n${URL1}`, null), { root: r5, dir: DIR })[0].message.includes('docs/design/DS-70/'), true);
t('check: saved and named is clean', checkTicket(issue(`h2. Design\n${URL1} · docs/design/DS-50/`), { root: r1, dir: DIR }).length, 0);
t('check: saved but the path not named is advisory', checkTicket(issue(`h2. Design\n${URL1}`), { root: r1, dir: DIR }).map((f) => f.severity).join(' '), 'advisory');
t('check: No UI is clean', checkTicket(issue('h2. Design\nNo UI.'), { root: r5, dir: DIR }).length, 0);
t('check: a markdown ticket file', checkTicket({ key: 'fix-x', text: `## Design\n${URL1}\n## Out of scope` }, { root: r5, dir: DIR })[0].severity, 'blocking');

// ---- the command line, reading config §2 Design canvases directory ----
const r6 = repo('r6');
put(join(T, 'config.md'), '## 2. Paths\n| Field | Value |\n|---|---|\n| Design canvases directory | `design/canvases/` |\n');
const env = { ...process.env, DESK_CONFIG: join(T, 'config.md') };
delete env.DESK_DESIGN_DIR;
const run = (...args) => spawnSync('node', [BIN, ...args], { cwd: r6, env, encoding: 'utf8' });
const cli = run('save', s1, '--key', 'DS-80', '--url', URL1, '--version', '7');
t('cli save: exit 0', cli.status, 0);
t('cli save: into the configured directory', cli.stdout.includes('saved: design/canvases/DS-80/'), true);
t('cli save: prints the Design line', cli.stdout.includes(`design: ${URL1} · design/canvases/DS-80/`), true);
t('cli save: warns about the remote font', cli.stdout.includes('remote: https://fonts.googleapis.com'), true);
t('cli status: newer exits 3', run('status', join(r6, 'design/canvases/DS-80'), '--version', '9').status, 3);
put(join(T, 'DS-81.md'), `# DS-81\n\n## Design\n${URL1.replace('abc123', 'zzz')}\n`);
const chk = run('check', join(T, 'DS-81.md'));
t('cli check: blocking exits 1', chk.status, 1);
t('cli check: prints a blocking line', chk.stdout.startsWith('blocking: design: DS-81'), true);
t('cli save: a key with .. is refused', run('save', s1, '--key', 'a..b').status, 2);
t('cli save: --boards before --key is a usage error', run('save', s1, '--boards', 'x', '--key', 'DS-82').status, 2);

rmSync(T, { recursive: true, force: true });
if (fails) { console.log(`FAIL ${fails} check(s)`); process.exit(1); }
