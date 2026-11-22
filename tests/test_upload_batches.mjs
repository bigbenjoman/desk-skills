// suite: upload batches (the uploader's file list, batches, tags file, resume, stall stop and sha256 reuse)
// layer: L1
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { runUpload, tagsPath, fileSha, altOf, batchesOf, linkIn, BATCH_SIZE, EXIT_THROTTLED, EXIT_PACED, THROTTLE_MS } from '../desk/bin/upload-batches.mjs';
import { swapCells, dragFiles } from '../desk/bin/evidence.mjs';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const ROOT = scratch('upload-batches-');
let n = 0;
// A screenshot folder holding `files` (relative paths), each with its own content unless `same` says.
function folder(files, same = {}) {
  const dir = join(ROOT, `shots-${n++}`);
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), same[f] ?? `png ${f}`);
  }
  return dir;
}
const body = (cells) => `## Evidence\n| shot |\n|---|\n${cells.map((c) => `| _drag ${c}_ |`).join('\n')}\n`;
const url = (path) => `https://github.com/user-attachments/assets/${fileSha(path).slice(0, 12)}`;

// A fake comment box: each file it is given shows its <img> tag after `delay` polls, unless the batch
// is one `stallAt` names (1-based), when only `partial` of its files ever do. `crashAt` throws on that
// batch's setFiles, as a killed run would stop.
function fakePage({ delay = 1, stallAt = 0, partial = 0, crashAt = 0 } = {}) {
  const page = { batches: [], opened: 0, cur: [], polls: 0 };
  page.io = {
    setFiles: async (paths) => {
      page.batches.push(paths);
      if (page.batches.length === crashAt) throw new Error('killed');
      page.cur = paths; page.polls = 0;
    },
    value: async () => {
      page.polls += 1;
      const stall = page.batches.length === stallAt;
      return page.cur.map((p, i) => (stall && i >= partial) || page.polls <= delay
        ? `![Uploading ${basename(p)}…]()`
        : `<img width="800" alt="${altOf(p)}" src="${url(p)}" />`).join('\n');
    },
    clear: async () => { page.cur = []; },
  };
  page.open = async () => { page.opened += 1; return page.io; };
  return page;
}
const clock = { t: Date.parse('2026-11-15T10:00:00Z') };
const now = () => clock.t;
const sleep = async (ms) => { clock.t += ms; };
function run(dir, pr, page) {
  return runUpload({ dir, readBody: () => pr.body, writeBody: (b) => { pr.body = b; pr.edits += 1; }, openPage: page.open, now, sleep, pollMs: 1000, stallMs: 180000 });
}
const uploaded = (page) => page.batches.flat().map((p) => basename(p));

// ---- AC1: only the files the cells name, in batches of at most 15 --------------------------------
{
  const named = Array.from({ length: 97 }, (_, i) => `shot-${String(i).padStart(3, '0')}.png`);
  const others = Array.from({ length: 90 }, (_, i) => `other-${i}.png`);
  const dir = folder([...named, ...others]);
  const pr = { body: body(named), edits: 0 };
  const page = fakePage();
  const r = await run(dir, pr, page);
  t('AC1 exit 0', r.code, 0);
  t('AC1 only the 97 named files are uploaded', uploaded(page).sort().join(','), [...named].sort().join(','));
  t('AC1 no batch holds more than 15', Math.max(...page.batches.map((b) => b.length)), BATCH_SIZE);
  t('AC1 in 7 batches', page.batches.length, 7);
  t('AC1 no cell left', dragFiles(pr.body).length, 0);
  t('AC1 each cell is markdown', pr.body.includes(`![shot-000](${url(join(dir, 'shot-000.png'))})`), true);
  t('AC1 the done line', r.lines[0], 'done: 97 image(s) in the body, 0 placeholder(s) left');
  const tags = JSON.parse(readFileSync(tagsPath(dir), 'utf8'));
  t('AC1 the tags file keeps each sha256 with its link', tags.files['shot-005.png'].sha256 === fileSha(join(dir, 'shot-005.png')) && tags.files['shot-005.png'].url === url(join(dir, 'shot-005.png')), true);
  t('AC1 the tags file sits beside the folder', tagsPath(`${dir}/`), `${dir}.tags.json`);
}

// ---- AC2: a file in a subfolder is found -------------------------------------------------------
{
  const dir = folder(['top.png', 'boards/board-1.png', 'deep/er/x.png']);
  const pr = { body: body(['top.png', 'board-1.png', 'boards/board-1.png', 'x.png']), edits: 0 };
  const page = fakePage();
  const r = await run(dir, pr, page);
  t('AC2 exit 0', r.code, 0);
  t('AC2 the subfolder cells are filled', pr.body.includes(`| ![board-1](${url(join(dir, 'boards/board-1.png'))}) |`) && pr.body.includes(`![x](${url(join(dir, 'deep/er/x.png'))})`), true);
  t('AC2 a name and its path upload once', uploaded(page).filter((f) => f === 'board-1.png').length, 1);
}

// ---- AC3: a run stopped after its second batch keeps them, and the rerun does not upload them again
{
  const named = Array.from({ length: 40 }, (_, i) => `r-${String(i).padStart(2, '0')}.png`);
  const dir = folder(named);
  const pr = { body: body(named), edits: 0 };
  const first = fakePage({ crashAt: 3 });
  let threw = '';
  try { await run(dir, pr, first); } catch (e) { threw = e.message; }
  t('AC3 the first run stops in its third batch', threw, 'killed');
  t('AC3 30 cells were filled before the stop', 40 - dragFiles(pr.body).length, 30);
  t('AC3 30 links are in the tags file', Object.keys(JSON.parse(readFileSync(tagsPath(dir), 'utf8')).files).length, 30);
  const filledBefore = named.slice(0, 30).map((f) => `![${altOf(f)}](${url(join(dir, f))})`);
  const second = fakePage();
  const r = await run(dir, pr, second);
  t('AC3 the rerun exits 0', r.code, 0);
  t('AC3 the rerun uploads only the 10 left', uploaded(second).sort().join(','), named.slice(30).join(','));
  t('AC3 the 30 cells stay filled', filledBefore.every((m) => pr.body.includes(m)), true);
  // Killed after the upload but before the cells were written: the tags file still has them.
  const pr2 = { body: body(named.slice(0, 5)), edits: 0 };
  const third = fakePage();
  const r2 = await run(dir, pr2, third);
  t('AC3 cells whose links are recorded are filled without the browser', r2.code === 0 && third.opened === 0 && dragFiles(pr2.body).length === 0, true);
}

// ---- AC4: a stall stops without retrying, records it, and keeps what was filled ------------------
{
  const named = Array.from({ length: 40 }, (_, i) => `s-${String(i).padStart(2, '0')}.png`);
  const dir = folder(named);
  const pr = { body: body(named), edits: 0 };
  const page = fakePage({ stallAt: 2, partial: 4 });
  const start = clock.t;
  const r = await run(dir, pr, page);
  t('AC4 exits throttled', r.code, EXIT_THROTTLED);
  t('AC4 no batch after the stall, and none sent again', page.batches.length, 2);
  t('AC4 the first batch and the four that landed are filled', 40 - dragFiles(pr.body).length, 19);
  const tags = JSON.parse(readFileSync(tagsPath(dir), 'utf8'));
  t('AC4 the tags file keeps the 19 links', Object.keys(tags.files).length, 19);
  t('AC4 the stall time is recorded', Date.parse(tags.throttle.at) >= start + 180000, true);
  t('AC4 it waits at least 15 minutes', Date.parse(tags.throttle.retry_after) - Date.parse(tags.throttle.at), THROTTLE_MS);
  t('AC4 the message says it was throttled and when it may go on', /^throttled: batch 2 filled no image for 180s/.test(r.lines[0]) && r.lines[1].includes(tags.throttle.retry_after), true);

  const early = fakePage();
  clock.t = Date.parse(tags.throttle.retry_after) - 1000;
  const r2 = await run(dir, pr, early);
  t('AC4 a run before retry_after uploads nothing', r2.code === EXIT_THROTTLED && early.opened === 0 && early.batches.length === 0, true);

  clock.t = Date.parse(tags.throttle.retry_after) + 1000;
  const again = fakePage({ stallAt: 1 });
  const r3 = await run(dir, pr, again);
  const t3 = JSON.parse(readFileSync(tagsPath(dir), 'utf8')).throttle;
  t('AC4 a second stall in a row backs off twice as long', r3.code === EXIT_THROTTLED && Date.parse(t3.retry_after) - Date.parse(t3.at) === 2 * THROTTLE_MS && t3.stalls === 2, true);

  clock.t = Date.parse(t3.retry_after) + 1000;
  const last = fakePage();
  const r4 = await run(dir, pr, last);
  t('AC4 after the wait the rest upload and the stall is cleared', r4.code === 0 && dragFiles(pr.body).length === 0 && JSON.parse(readFileSync(tagsPath(dir), 'utf8')).throttle === null, true);
}

// ---- AC5: a file in no folder is named, and the rest go up ---------------------------------------
{
  const dir = folder(['a.png', 'sub/b.png']);
  const pr = { body: body(['a.png', 'gone.png', 'b.png']), edits: 0 };
  const page = fakePage();
  const r = await run(dir, pr, page);
  t('AC5 exits with cells left', r.code, 4);
  t('AC5 the rest are uploaded', uploaded(page).sort().join(','), 'a.png,b.png');
  t('AC5 the missing cell is left as it is', pr.body.includes('| _drag gone.png_ |'), true);
  t('AC5 the exit message names it', r.lines.join('\n').includes(`not in ${dir} or a folder under it, so their cells are left: gone.png`), true);
}

// ---- AC6: an image uploaded in an earlier round gets its link, and nothing is uploaded -----------
{
  const dir = folder(['round-2-home.png', 'dup-a.png', 'dup-b.png'], { 'round-2-home.png': 'same pixels', 'dup-a.png': 'twin', 'dup-b.png': 'twin' });
  const old = 'https://github.com/user-attachments/assets/earlier-round';
  writeFileSync(tagsPath(dir), JSON.stringify({ files: { 'round-1-home.png': { sha256: fileSha(join(dir, 'round-2-home.png')), url: old, at: '2026-11-14T10:00:00Z' } }, throttle: null }));
  const pr = { body: body(['round-2-home.png']), edits: 0 };
  const page = fakePage();
  const r = await run(dir, pr, page);
  t('AC6 the cell gets the recorded link', r.code === 0 && pr.body.includes(`![round-2-home](${old})`), true);
  t('AC6 nothing is uploaded', page.opened === 0 && page.batches.length === 0, true);
  const pr2 = { body: body(['dup-a.png', 'dup-b.png']), edits: 0 };
  const page2 = fakePage();
  await run(dir, pr2, page2);
  t('AC6 two files of one image upload once and both cells fill', page2.batches.flat().length === 1 && dragFiles(pr2.body).length === 0, true);
}
{
  // One file name whose pixels go A, then B, then back to A: A's link is kept and A is not sent again.
  const dir = folder(['home.png'], { 'home.png': 'pixels A' });
  const shot = join(dir, 'home.png');
  const urlA = url(shot);
  const rounds = [];
  for (const pixels of ['pixels A', 'pixels B', 'pixels A']) {
    writeFileSync(shot, pixels);
    const pr = { body: body(['home.png']), edits: 0 };
    const page = fakePage();
    await run(dir, pr, page);
    rounds.push({ sent: page.batches.flat().length, body: pr.body });
  }
  t('AC6 a file changed A, B, A uploads A once', rounds.map((r) => r.sent).join(','), '1,1,0');
  t('AC6 the third round gets A\'s first link', rounds[2].body.includes(`![home](${urlA})`), true);
}

// ---- record: what upload-images.mjs writes to the upload log -----------------------------------
{
  const seen = [];
  const record = (file, result, at) => seen.push({ file, result, at: at.getTime() });
  const go = (dir, pr, page) => runUpload({ dir, readBody: () => pr.body, writeBody: (b) => { pr.body = b; }, openPage: page.open, record, now, sleep, pollMs: 1000, stallMs: 180000 });
  const start = clock.t;
  await go(folder(['a.png', 'b.png']), { body: body(['a.png', 'b.png']) }, fakePage({ stallAt: 1, partial: 1 }));
  t('record: the upload then the stalled file', seen.map((s) => `${s.file} ${s.result}`).join(', '), 'a.png uploaded, b.png throttled');
  t('record: an upload is timed when its link appeared, not at the stall', seen[0].at - start, 1000);
  t('record: the stall is timed when it was seen', seen[1].at - seen[0].at >= 180000, true);
  seen.length = 0;
  let threw = '';
  try { await go(folder(['c.png', 'd.png']), { body: body(['c.png', 'd.png']) }, fakePage({ crashAt: 1 })); } catch (e) { threw = e.message; }
  t('record: an upload error is logged throttled on the first file it was waiting on, and still thrown', `${threw}: ${seen.map((s) => `${s.file} ${s.result}`).join(', ')}`, 'killed: c.png throttled');
}

// ---- the pieces --------------------------------------------------------------------------------
{
  const pr = { body: 'intro\n![a](https://github.com/user-attachments/assets/abc)\n', edits: 0 };
  const noCells = fakePage();
  const r = await run(folder(['a.png']), pr, noCells);
  t('a body with no cells left uploads nothing and exits 0', r.code === 0 && noCells.opened === 0, true);
  t('a body with no cells left prints the done line pass.mjs reads', r.lines[0], 'done: 1 image(s) in the body, 0 placeholder(s) left');
  const swapped = swapCells('| _drag a.png_ | `_drag a.png_` |\n```\n_drag a.png_\n```\n| _drag b.png_ |', { 'a.png': '![a](u)' });
  t('swapCells fills only the cells outside code', swapped, '| ![a](u) | `_drag a.png_` |\n```\n_drag a.png_\n```\n| _drag b.png_ |');
  const b = batchesOf([{ path: '/x/a.png' }, { path: '/y/a.png' }, { path: '/x/b.png' }], 15);
  t('batchesOf never puts two of one alt in a batch', b.map((x) => x.length).join(','), '1,2');
  t('linkIn reads GitHub\'s markdown too', linkIn('![a](https://github.com/user-attachments/assets/abc)', '/d/a.png'), 'https://github.com/user-attachments/assets/abc');
  t('linkIn waits while a file is still uploading', linkIn('![Uploading a.png…]()', '/d/a.png'), null);
  const bad = folder(['a.png']);
  writeFileSync(tagsPath(bad), '{not json');
  let msg = '';
  try { await run(bad, { body: body(['a.png']), edits: 0 }, fakePage()); } catch (e) { msg = `${e.code} ${e.message}`; }
  t('an unreadable tags file stops the run rather than uploading again', msg.startsWith(`1 ${tagsPath(bad)} is not JSON`), true);
  t('nothing is left behind but the tags files', existsSync(`${tagsPath(bad)}.tmp`), false);
}

// ---- --max: a run uploads at most that many, and the next run carries on ------------------------
{
  const named = Array.from({ length: 10 }, (_, i) => `m-${i}.png`);
  const dir = folder(named);
  const pr = { body: body(named), edits: 0 };
  const capped = (page, max) => runUpload({ dir, readBody: () => pr.body, writeBody: (b) => { pr.body = b; }, openPage: page.open, now, sleep, pollMs: 1000, stallMs: 180000, max });
  const p1 = fakePage();
  const r1 = await capped(p1, 6);
  t('max: a run uploads only that many', uploaded(p1).length, 6);
  t('max: images left over end it paced (exit 8)', r1.code, EXIT_PACED);
  t('max: the paced line says how many wait', r1.lines[0], 'paced: 6 image(s) uploaded, the most this run may upload; 4 more wait for the next run, and their cells are left');
  t('max: the cells of what it uploaded are filled', dragFiles(pr.body).length, 4);
  const p2 = fakePage();
  const r2 = await capped(p2, 6);
  t('max: the next run uploads only the rest', uploaded(p2).sort().join(','), named.slice(6).join(','));
  t('max: with nothing left over it ends as before', `${r2.code} ${r2.lines[0]}`, '0 done: 10 image(s) in the body, 0 placeholder(s) left');
}

// ---- DS-550 AC2: a preview-database PR's run posts only the bytes its error-page check passed --------
{
  const dir = folder(['ok.png', 'changed.png', 'nested/deep.png', 'error-pages/bad.png']);
  const passed = new Set([fileSha(join(dir, 'ok.png')), fileSha(join(dir, 'changed.png'))]);
  writeFileSync(join(dir, 'changed.png'), 'png changed.png, taken again after its check');
  const pr = { body: body(['ok.png', 'changed.png', 'deep.png', 'bad.png']), edits: 0 };
  const page = fakePage();
  const r = await runUpload({ dir, readBody: () => pr.body, writeBody: (b) => { pr.body = b; }, openPage: page.open, now, sleep, pollMs: 1000, stallMs: 180000, passed });
  t('DS-550 AC2 only the file its check read, unchanged, is uploaded', uploaded(page).join(','), 'ok.png');
  t('DS-550 AC2 a changed file, an unchecked nested one and a set-aside error page keep their cells', dragFiles(pr.body).sort().join(','), 'bad.png,changed.png,deep.png');
  t('DS-550 AC2 the run ends with cells left (exit 4), naming the unchecked ones', [r.code, /changed\.png \(there, but not as its last passing/.test(r.lines.join('\n'))].join(), '4,true');
  const free = folder(['a.png']);
  const pr2 = { body: body(['a.png']), edits: 0 };
  const p2 = fakePage();
  await runUpload({ dir: free, readBody: () => pr2.body, writeBody: (b) => { pr2.body = b; }, openPage: p2.open, now, sleep, pollMs: 1000, stallMs: 180000, passed: null });
  t('DS-550 AC5 a PR with no preview database uploads as before (negative control)', uploaded(p2).join(','), 'a.png');
  const p3 = fakePage();
  const pr3 = { body: body(['a.png']), edits: 0 };
  await runUpload({ dir: free, readBody: () => pr3.body, writeBody: (b) => { pr3.body = b; }, openPage: p3.open, now, sleep, pollMs: 1000, stallMs: 180000, passed: new Set() });
  t('DS-550 AC2 before any check passed, nothing is uploaded, nor a link already uploaded reused', [uploaded(p3).length, dragFiles(pr3.body).join(',')].join(), '0,a.png');
}

rmSync(ROOT, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
