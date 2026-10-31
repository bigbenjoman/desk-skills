// suite: desk-design (save a canvas, source.json, README, check, render)
// desk-design.mjs on a fixture snapshot: write records source.json and a README with the
// ticket-to-board table; save copies canvas.json, the boards and the local files they reference into
// the Design canvases directory, once per artifact; status sees a newer version; check reports a
// Claude Design link with no saved copy. Scratch git repos only.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { save, status, checkTicket, collect, parseBoards, references, blobIds, writeRecord, canonicalUrl, mergeSource, readme, renderPlan, screenNames, render } from '../desk/bin/desk-design.mjs';
import { findPlaywright, importPlaywright } from '../desk/bin/find-playwright.mjs';

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

// ---- a canvas.json v3 snapshot ----
// Boards keyed by file name and sized w/h, {{…}} bindings in src, images as /_blob/<id> in an
// attribute and in a script string, and the runtime as artifact-type/dc-runtime.js, not support.js.
const B1 = '0123456789abcdef0123456789abcdef';
const B2 = 'fedcba9876543210fedcba9876543210';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function snapshotV3(dir, { second = true } = {}) {
  put(join(dir, 'project/canvas.json'), JSON.stringify({ version: 3, boards: {
    'A-Home.dc.html': { x: 0, y: 1400, w: 1440, h: 3400, title: 'Home' },
    'Landscape.dc.html': { x: 1500, y: 0, w: 390, h: 844 },
  }, notes: [{ x: 0, y: 0, w: 300, h: 120, title: 'A sticky note, not a board' }] }));
  put(join(dir, 'project/A-Home.dc.html'), `<script src="./support.js"></script><img src="{{janeSrc}}" alt=""><img src="/_blob/${B1}">`);
  put(join(dir, 'project/Landscape.dc.html'), `<script src="./support.js"></script><img src='{{s.src}}'><script>const items = [{ src: '/_blob/${B2}' }];</script>`);
  put(join(dir, 'artifact-type/dc-runtime.js'), 'window.dc = { runtime: true };');
  put(join(dir, `assets/${B1}`), PNG);
  if (second) put(join(dir, `_blob/${B2}.jpg`), 'JPEG');
  return dir;
}
const v3 = snapshotV3(join(T, 'v3'));
t('v3 parseBoards: boards keyed by file, sized by w', parseBoards(json(join(v3, 'project/canvas.json'))).map((x) => `${x.name}@${x.width}:${x.file}`).join(' '), 'Home@1440:A-Home.dc.html Landscape@390:Landscape.dc.html');
t('references: a {{…}} binding names no file', references(`<img src="{{janeSrc}}"><img src='{{ s.src }}'><a href="x.html">`).join(' '), 'x.html');
t('blobIds: an id in a script string', blobIds(`const items = [{ src: '/_blob/${B2}' }]`).join(' '), B2);
const cv3 = collect(v3);
t('v3 collect: no binding reported missing', cv3.missing.join(' | '), '');
t('v3 collect: assets and support.js saved beside the boards', cv3.files.join(' '),
  `project/A-Home.dc.html project/Landscape.dc.html project/assets/${B1}.png project/assets/${B2}.jpg project/canvas.json project/support.js`);
t('v3 collect: support.js comes from dc-runtime.js', cv3.copyFrom['project/support.js'], 'artifact-type/dc-runtime.js');
t('v3 collect: a /_blob/ path is not a remote or repo-root file', cv3.remote.length, 0);
const rv3 = repo('rv3');
const sv3 = save(v3, { root: rv3, dir: DIR, tickets: [{ key: 'PM-3', boards: [] }], epic: 'PM-2', url: URL1, version: '1' });
const dv3 = join(rv3, DIR, 'PM-2/project');
t('v3 save: the attribute points at the saved asset', read(join(dv3, 'A-Home.dc.html')).includes(`<img src="assets/${B1}.png">`), true);
t('v3 save: the script string points at the saved asset', read(join(dv3, 'Landscape.dc.html')).includes(`src: 'assets/${B2}.jpg'`), true);
t('v3 save: no /_blob/ reference is left', [read(join(dv3, 'A-Home.dc.html')), read(join(dv3, 'Landscape.dc.html'))].some((s) => s.includes('/_blob/')), false);
t('v3 save: the assets are on disk', readFileSync(join(dv3, `assets/${B1}.png`)).equals(PNG) && read(join(dv3, `assets/${B2}.jpg`)) === 'JPEG', true);
t('v3 save: support.js is the runtime', read(join(dv3, 'support.js')), 'window.dc = { runtime: true };');
t('v3 save: bindings are kept as written', read(join(dv3, 'A-Home.dc.html')).includes('src="{{janeSrc}}"'), true);
t('v3 save: README lists every board', read(join(rv3, DIR, 'PM-2/README.md')).includes('| Landscape | 390px | Landscape.dc.html |'), true);
t('v3 save: source.json records the saved paths', JSON.stringify(sv3.files), JSON.stringify(cv3.files));
t('v3 save: the saved folder reads back with nothing missing', collect(join(rv3, DIR, 'PM-2')).missing.length, 0);
const rv3m = repo('rv3m');
const noB2 = (() => { try { save(snapshotV3(join(T, 'v3m'), { second: false }), { root: rv3m, dir: DIR, tickets: [{ key: 'PM-3', boards: [] }], url: URL1, version: '1' }); return 'no error'; } catch (e) { return `${e.code}:${e.message}`; } })();
t('v3 save: a missing asset exits 4', noB2.startsWith('4:not saved'), true);
t('v3 save: and names the asset id', noB2.includes(`missing: asset ${B2} (from project/Landscape.dc.html`), true);
t('v3 save: nothing written when an asset is missing', existsSync(join(rv3m, DIR)), false);

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
// desk-jira's .md conversion escapes - and _ inside a code span, so Jira holds {{docs/design/DS\-50/}}.
t('check: wiki-escaped code spans read as written', checkTicket(issue(`h2. Design\n{{${URL1}}} · {{docs/design/DS\\-50/}}`), { root: r1, dir: DIR }).length, 0);
// In wiki markup `# item` is a numbered item (desk-jira writes markdown's `1. item` so), not a heading.
t('check: a wiki numbered item stays in the Design section', checkTicket(issue(`h2. Design\n# Canvas: ${URL1}\nh2. Out of scope`), { root: r5, dir: DIR }).map((f) => f.severity).join(' '), 'blocking');
const esc = checkTicket(issue('h2. Design\n{{https://claude.ai/design/p/ab\\-c\\_d}}'), { root: r5, dir: DIR });
t('check: an escaped link names the unescaped URL', esc.length === 1 && esc[0].message.includes('https://claude.ai/design/p/ab-c_d,'), true);
// A snapshot under the state directory (/desk-admit's, or autopilot's) is what a worker saves from.
const st = join(T, 'state');
put(join(st, 'designs/DS-70/source.json'), JSON.stringify({ url: `${URL1}#board`, version: '7' }));
const snapped = checkTicket(issue(`h2. Design\n${URL1}`), { root: r5, dir: DIR, state: st });
t('check: a snapshotted link is advisory, naming the snapshot', `${snapped.map((f) => f.severity).join(' ')} ${snapped[0]?.message.includes(`snapshotted at ${join(st, 'designs/DS-70')}`)}`, 'advisory true');
t('check: a feature batch reads the repo state\'s snapshot', checkTicket(issue(`h2. Design\n${URL1}`), { root: r5, dir: DIR, state: join(st, 'batches/DS-50') })[0].severity, 'advisory');
t('check: another artifact is still blocking', checkTicket(issue('h2. Design\nhttps://claude.ai/design/p/other'), { root: r5, dir: DIR, state: st })[0].severity, 'blocking');

// ---- a single-page artifact: no canvas.json, one page and the files it loads ----
const page = join(T, 'page');
put(join(page, 'source.json'), JSON.stringify({ url: 'https://claude.ai/artifact/PAGE1', version: '3', dir: 'DS-90', tickets: [{ key: 'DS-91', boards: [] }] }));
put(join(page, 'project/index.html'), '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><link rel="stylesheet" href="page.css"><h1>after</h1>');
put(join(page, 'project/page.css'), 'h1 { color: red }');
t('collect: a page with no canvas.json is the page and what it loads', `${collect(page).canvas} ${collect(page).files.join(' ')}`, 'null project/index.html project/page.css');
const rP = repo('rP');
const sp = save(page, { root: rP, dir: DIR, tickets: [{ key: 'DS-91', boards: [] }] });
t('save: a single page is saved with no canvas.json asked for', `${sp.path} ${existsSync(join(rP, DIR, 'DS-90/project/index.html'))} ${existsSync(join(rP, DIR, 'DS-90/project/page.css'))}`, 'docs/design/DS-90/ true true');
t('save: a single page has no boards', sp.source.boards.length, 0);
t('render plan: a page with no width renders at the breakpoints only', renderPlan([{ name: 'index', width: null }], [390, 1280]).shots.map((s) => s.width).join(' '), '390 1280');
t('collect: neither a canvas nor a page is refused', throws(() => collect(join(T, 'state/designs'))).startsWith('2:no canvas.json or page'), true);

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
// With Tracker none a slug's text is its ticket file under the state directory, never desk-jira.
put(join(T, 'none.md'), '## 4. Tracker\n| Field | Value |\n|---|---|\n| Tracker | `none` |\n');
put(join(T, 'state', 'tickets', 'fix-login.md'), `# fix-login\n\n## Design\n${URL1.replace('abc123', 'yyy')}\n`);
const runNone = (...args) => spawnSync('node', [BIN, ...args], { cwd: r6, env: { ...env, DESK_CONFIG: join(T, 'none.md'), DESK_AUTOPILOT_STATE: join(T, 'state') }, encoding: 'utf8' });
const slug = runNone('check', 'fix-login');
t('cli check: a slug reads its ticket file', slug.status === 1 && slug.stdout.startsWith('blocking: design: fix-login'), true);
const nofile = runNone('check', 'no-such-ticket');
t('cli check: a slug with no ticket file says so', nofile.status === 2 && nofile.stderr.includes('no ticket file'), true);
t('cli save: a key with .. is refused', run('save', s1, '--key', 'a..b').status, 2);
t('cli save: --boards before --key is a usage error', run('save', s1, '--boards', 'x', '--key', 'DS-82').status, 2);

// ---- render: the plan, the README and config §5 Breakpoints ----
const BPS = [390, 768, 1024, 1280, 1440];
const drawn = [{ name: 'Test 390', width: 390 }, { name: 'Test 960', width: 960 }];
const plan = renderPlan(drawn, BPS);
t('plan: each board at every breakpoint', plan.shots.filter((s) => s.board === 'Test 390').map((s) => s.width).join(' '), '390 768 1024 1280 1440');
t('plan: a board off the breakpoints also at its own width', plan.shots.filter((s) => s.board === 'Test 960').map((s) => s.width).join(' '), '390 768 960 1024 1280 1440');
t('plan: screens/<board>@<width>.png', plan.shots[0].file, 'screens/test-390@390.png');
t('plan: drawn and interpolated widths', plan.widths.map((w) => `${w.width}:${w.label}${w.breakpoint ? '' : '*'}`).join(' '), '390:drawn 768:interpolated 960:drawn* 1024:interpolated 1280:interpolated 1440:interpolated');
t('screenNames: a clash is numbered', screenNames([{ name: 'Home' }, { name: 'home' }, { name: '!!' }]).join(' '), 'home home-2 board');
t('screenNames: a number never reuses another board\'s name', screenNames([{ name: 'Home' }, { name: 'home' }, { name: 'Home 2' }]).join(' '), 'home home-2 home-2-2');
const scr = { version: '7', rendered_at: '2026-10-18T10:00:00Z', breakpoints: BPS, widths: plan.widths, images: plan.shots.map(({ png, ...s }) => s) };
const rs = readme({ url: URL1, version: '7', fetched_at: 'x', tickets: [], boards: drawn, screens: scr });
t('README: a breakpoint with no board is interpolated', rs.includes('| 1024px | interpolated | - |'), true);
t('README: a board at its own width is drawn, not a breakpoint', rs.includes('| 960px | drawn (not a breakpoint) | Test 960 |'), true);
t('README: links every image', rs.includes('| Test 960 | [image](screens/test-960@390.png) | [image](screens/test-960@768.png) | [drawn](screens/test-960@960.png) |'), true);
t('merge: screens kept at the same version', mergeSource({ url: URL1, screens: scr }, { url: URL1, version: '7', tickets: [] }).screens?.version, '7');
t('merge: screens dropped at a new version', mergeSource({ url: URL1, screens: scr }, { url: URL1, version: '8', tickets: [] }).screens, undefined);
const bp = (row) => {
  const f = join(T, `bp-${row.length}.md`);
  put(f, `## 5. Conventions\n| Field | Value |\n|---|---|\n${row ? `| Breakpoints | ${row} |\n` : ''}`);
  const r = spawnSync('node', ['--input-type=module', '-e', `import { breakpoints } from ${JSON.stringify(BIN)}; console.log(breakpoints().join(' '))`], { env: { ...process.env, DESK_CONFIG: f }, encoding: 'utf8' });
  return (r.stdout || r.stderr).trim();
};
t('breakpoints: unset is the default', bp(''), '390 768 1024 1280 1440');
t('breakpoints: the row, ascending', bp('`1280` `390` `768`'), '390 768 1280');
t('breakpoints: none is no breakpoints', bp('`none`'), '');

// A re-save at a new version removes the old version's screens.
const r7 = repo('r7');
save(s1, { root: r7, dir: DIR, tickets: [{ key: 'DS-52', boards: [] }], url: URL1, version: '7' });
const d7 = join(r7, DIR, 'DS-52');
put(join(d7, 'screens/admin-390@390.png'), 'PNG');
writeRecord(d7, { ...json(join(d7, 'source.json')), screens: { ...scr, images: [{ board: 'Admin 390', screen: 'admin-390', width: 390, file: 'screens/admin-390@390.png', drawn: true }] } });
save(s1, { root: r7, dir: DIR, tickets: [{ key: 'DS-52', boards: [] }], url: URL1, version: '7' });
t('re-save, same version: screens kept', existsSync(join(d7, 'screens/admin-390@390.png')) && read(join(d7, 'README.md')).includes('## Screens'), true);
save(s4, { root: r7, dir: DIR, tickets: [{ key: 'DS-52', boards: [] }], url: URL1, version: '8' });
t('re-save, new version: old screens removed', existsSync(join(d7, 'screens/admin-390@390.png')), false);
t('re-save, new version: README drops them', read(join(d7, 'README.md')).includes('## Screens'), false);

// ---- render in a real browser: desk's own Playwright, skipped where it is not installed ----
const pw = findPlaywright();
if (!pw.entry) {
  console.log(`SKIP render in a browser: no desk Playwright (tried ${pw.tried.join(', ')})`);
} else {
  const { chromium } = await importPlaywright(pw);
  // Boards that paint from a local stylesheet and font, as a saved canvas does, with no network.
  // Only the 960 board loads img/b960.svg, so its failure comes after the 390 board's shots.
  const canvasAt = (name) => {
    const s = join(T, name);
    put(join(s, 'project/canvas.json'), JSON.stringify({ boards: [
      { title: 'Test 390', width: 390, file: 'test-390.dc.html' }, { title: 'Test 960', width: 960, file: 'test-960.dc.html' }] }));
    for (const w of [390, 960]) put(join(s, `project/test-${w}.dc.html`), `<!doctype html><link rel="stylesheet" href="styles/app.css"><main>Board ${w}${w === 960 ? '<img src="img/b960.svg">' : ''}</main>`);
    put(join(s, 'project/styles/app.css'), "@font-face { font-family: T; src: url('../fonts/T.woff2'); } main { font-family: T; height: 600px; background: #234; color: #fff; }");
    put(join(s, 'project/fonts/T.woff2'), 'FONT');
    put(join(s, 'project/img/b960.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
    const r = repo(`${name}-repo`);
    return join(r, save(s, { root: r, dir: DIR, tickets: [{ key: 'DS-52', boards: [] }], url: URL1, version: '3' }).path);
  };
  const good = canvasAt('rg');
  const out = await render(good, { chromium, bps: BPS, now: '2026-10-18T10:00:00Z' });
  t('render: every board at every breakpoint and its own width', out.screens.images.length, 11);
  const png = readFileSync(join(good, 'screens/test-960@960.png'));
  t('render: a PNG on disk', png.subarray(1, 4).toString(), 'PNG');
  t('render: at the width', png.readUInt32BE(16), 960);
  t('render: README labels 1440 interpolated', read(join(good, 'README.md')).includes('| 1440px | interpolated | - |'), true);

  // AC3: a missing asset fails the render naming board and file, and writes nothing: the earlier
  // board's shots succeed first, and the previous render's screens and README stay as they were.
  const broken = canvasAt('rb');
  await render(broken, { chromium, bps: BPS, now: '2026-10-18T09:00:00Z' });
  // A re-render writes the same bytes, so the file's mtime is what shows whether it was written.
  const before = { readme: read(join(broken, 'README.md')), png: statSync(join(broken, 'screens/test-390@390.png')).mtimeMs };
  rmSync(join(broken, 'project/img/b960.svg'));
  const err = await render(broken, { chromium, bps: BPS }).then(() => 'no error', (e) => `${e.code}:${e.message}`);
  t('render: a missing asset fails with exit 4', err.startsWith('4:not rendered: board "Test 960"'), true);
  t('render: the asset is named', err.includes('project/img/b960.svg (HTTP 404)'), true);
  t('render: no image written', statSync(join(broken, 'screens/test-390@390.png')).mtimeMs === before.png && read(join(broken, 'README.md')) === before.readme, true);
  const fresh = canvasAt('rf');
  rmSync(join(fresh, 'project/img/b960.svg'));
  await render(fresh, { chromium, bps: BPS }).catch(() => null);
  t('render: a first render that fails leaves no screens', existsSync(join(fresh, 'screens')), false);
  const cliR = run('render', good);
  t('cli render: exit 0, labels each width', cliR.status === 0 && cliR.stdout.includes('1024px interpolated'), true);
  t('cli render: a missing asset exits 4', run('render', broken).status, 4);
  const blank = canvasAt('rx');
  put(join(blank, 'project/test-390.dc.html'), '<!doctype html><body></body>');
  t('render: a blank board fails', await render(blank, { chromium, bps: [390] }).then(() => 'no error', (e) => e.message.includes('painted nothing')), true);

  // A v3 canvas: keyed boards sized w/h, the runtime saved as support.js, an image the board's script
  // sets from a /_blob/ id, and a binding the runtime fills in (in a <template>, as nothing fetches it).
  const sr = join(T, 'v3r');
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
  put(join(sr, 'project/canvas.json'), JSON.stringify({ version: 3, boards: {
    'Home.dc.html': { x: 0, y: 0, w: 1440, h: 900, title: 'Home' }, 'Phone.dc.html': { x: 1500, y: 0, w: 390, h: 844 } } }));
  for (const f of ['Home', 'Phone']) {
    put(join(sr, `project/${f}.dc.html`), `<!doctype html><script src="./support.js"></script><template><img src="{{janeSrc}}"></template>
<main style="height:600px;background:#234;color:#fff">${f}</main><script>const items = [{ src: '/_blob/${B1}' }];
for (const it of items) { const i = document.createElement('img'); i.src = it.src; document.querySelector('main').append(i); }</script>`);
  }
  put(join(sr, 'artifact-type/dc-runtime.js'), 'window.dc = { runtime: true };');
  put(join(sr, `assets/${B1}`), SVG);
  const rr = repo('v3r-repo');
  const v3dir = join(rr, save(sr, { root: rr, dir: DIR, tickets: [{ key: 'PM-3', boards: [] }], epic: 'PM-2', url: URL1, version: '1' }).path);
  const v3out = await render(v3dir, { chromium, bps: BPS, now: '2026-10-24T10:00:00Z' }).then((s) => s, (e) => e);
  t('v3 render: a PNG for every board at every breakpoint', v3out.screens?.images.length ?? v3out.message, 10);
  t('v3 render: README lists them', read(join(v3dir, 'README.md')).includes('| Phone | [drawn](screens/phone@390.png) |'), true);
  // From file://, with nothing but the saved folder: every request stays on disk and succeeds.
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const off = [];
  page.on('request', (r) => { if (!r.url().startsWith('file:')) off.push(r.url()); });
  page.on('requestfailed', (r) => off.push(`${r.url()} failed`));
  await page.goto(pathToFileURL(join(v3dir, 'project/Home.dc.html')).href, { waitUntil: 'load' });
  const shown = await page.evaluate(() => [window.dc?.runtime === true, [...document.images].every((i) => i.complete && i.naturalWidth > 0)].join(' '));
  await browser.close();
  t('v3 file://: support.js and the asset load from disk', shown, 'true true');
  t('v3 file://: no request leaves the folder', off.join(' '), '');
}

rmSync(T, { recursive: true, force: true });
if (fails) { console.log(`FAIL ${fails} check(s)`); process.exit(1); }
