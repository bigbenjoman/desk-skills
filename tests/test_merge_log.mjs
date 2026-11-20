// suite: merge log (who merged what, at which head)
// merge-log.mjs claim refuses a merge another merger has claimed recently, merged or armed, and lets the
// same merger through; record and show keep and print every event; the CLI exits 11 on a refusal.
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const T = mkdtempSync(join(tmpdir(), 'merge-log-'));
process.env.DESK_MERGE_LOG = join(T, 'merges.jsonl');
const M = await import('../desk/bin/merge-log.mjs');
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'merge-log.mjs');
let fails = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};
const path = process.env.DESK_MERGE_LOG;
const NOW = Date.parse('2026-11-20T10:00:00Z');
const R = 'acme/widgets';
const D = 'merge-driver acme__widgets';
const S = 'session s-1';

t('#809 a first claim is recorded', M.claim({ repo: R, pr: 7, sha: 'abc1234', by: D, now: NOW, path }), { ok: true });
t('#809 the same merger claims again (a retry)', M.claim({ repo: R, pr: 7, sha: 'abc1234', by: D, now: NOW + 1000, path }).ok, true);
const r = M.claim({ repo: R, pr: 7, sha: 'abc1234', by: S, now: NOW + 2000, path });
t('#809 another merger within the claim window is refused, naming the claim', [r.ok, r.why], [false, `${R}#7 is already claimed by ${D} (2026-11-20T10:00:01.000Z, at abc1234): not merging`]);
t('#809 a claim older than CLAIM_MS no longer holds the PR', M.claim({ repo: R, pr: 7, sha: 'abc1234', by: S, now: NOW + M.CLAIM_MS + 5000, path }).ok, true);
t('#809 a claim on another repo or PR does not hold this one', [M.claim({ repo: 'acme/other', pr: 7, sha: 'abc1234', by: D, now: NOW, path }).ok, M.claim({ repo: R, pr: 8, sha: 'abc1234', by: S, now: NOW, path }).ok], [true, true]);

M.record({ repo: R, pr: 9, sha: 'def5678', by: D, event: 'merged', now: NOW, path });
const m = M.claim({ repo: R, pr: 9, sha: 'def5678', by: S, now: NOW + 3 * M.CLAIM_MS, path });
t('#809 a PR another merger recorded merged is refused at any age', [m.ok, m.why], [false, `${R}#9 is already merged by ${D} (2026-11-20T10:00:00.000Z, at def5678): not merging`]);
M.record({ repo: R, pr: 10, sha: 'aaa1111', by: S, event: 'armed', now: NOW, path });
t('#809 auto-merge armed by another merger holds the PR too', M.claim({ repo: R, pr: 10, sha: 'aaa1111', by: D, now: NOW + 3 * M.CLAIM_MS, armedNow: () => true, path }).ok, false);
M.record({ repo: R, pr: 10, sha: 'aaa1111', by: D, event: 'disarmed', now: NOW + 1000, path });
t('#809 once anyone disarms it, the armed hold is gone', M.claim({ repo: R, pr: 10, sha: 'aaa1111', by: D, now: NOW + 3 * M.CLAIM_MS, path }).ok, true);
M.record({ repo: R, pr: 12, sha: 'ccc3333', by: S, event: 'armed', now: NOW, path });
M.record({ repo: R, pr: 12, sha: 'ccc3333', by: S, event: 'failed', why: 'auto-merge cancelled', now: NOW + 1000, path });
t('#809 an armer whose last event is a failure no longer holds it', M.claim({ repo: R, pr: 12, sha: 'ccc3333', by: D, now: NOW + 2000, path }).ok, true);
M.record({ repo: R, pr: 13, sha: 'ddd4444', by: S, event: 'disarmed', now: NOW, path });
M.record({ repo: R, pr: 13, sha: 'ddd4444', by: S, event: 'armed', now: NOW + 1000, path });
M.record({ repo: R, pr: 14, sha: 'eee5555', by: S, event: 'armed', now: NOW, path });
const on = () => true, off = () => false, unread = () => null;
t('#809 with GitHub showing auto-merge on, the armed record holds', M.claim({ repo: R, pr: 14, sha: 'eee5555', by: D, now: NOW + 1000, armedNow: on, path }).ok, false);
const u = M.claim({ repo: R, pr: 14, sha: 'eee5555', by: D, now: NOW + 1500, armedNow: unread, path });
t('#809 with GitHub unreadable, the armed record still holds, saying why', [u.ok, /GitHub could not be read/.test(u.why)], [false, true]);
t('#809 with GitHub showing it off (turned off outside desk), it does not', M.claim({ repo: R, pr: 14, sha: 'eee5555', by: D, now: NOW + 2000, armedNow: off, path }).ok, true);
t('#809 and the stale armed record is closed in the log, saying why', M.readLog(path).filter((e) => e.pr === '14').map((e) => `${e.event}${e.why ? ` (${e.why})` : ''}`).join(', '), 'armed, disarmed (GitHub shows auto-merge off), claim');
t('#809 armed again after a disarm holds it again', M.claim({ repo: R, pr: 13, sha: 'ddd4444', by: D, now: NOW + 2000, armedNow: () => true, path }).ok, false);
M.claim({ repo: R, pr: 11, sha: 'bbb2222', by: S, now: NOW, path });
M.record({ repo: R, pr: 11, sha: 'bbb2222', by: S, event: 'failed', why: 'not mergeable', now: NOW + 1000, path });
t('#809 a merger whose last event is a failure no longer holds the PR', M.claim({ repo: R, pr: 11, sha: 'bbb2222', by: D, now: NOW + 2000, path }).ok, true);
t('#809 a torn line is skipped, never fatal', (() => { appendFileSync(path, '{"at": "torn\n'); const n = readFileSync(path, 'utf8').split('\n').filter(Boolean).length; const l = M.readLog(path); return [l.length === n - 1, l.every((e) => e.repo)]; })(), [true, true]);

// The CLI: exit 11 naming the other on a refusal, 0 and one line each otherwise.
const cli = (...a) => spawnSync('node', [BIN, ...a, '--repo', R], { encoding: 'utf8', env: { ...process.env } });
const c1 = cli('claim', '20', 'cafe123', '--by', S);
t('#809 the CLI claims, exit 0', [c1.status, c1.stdout.trim()], [0, `claimed ${R}#20 at cafe123 for ${S}`]);
const c2 = cli('claim', '20', 'cafe123', '--by', D);
t('#809 and refuses another merger, exit 11', [c2.status, c2.stderr.trim().startsWith(`merge-log: ${R}#20 is already claimed by ${S}`)], [11, true]);
const c3 = cli('record', '20', 'cafe123', '--by', S, '--event', 'merged');
t('#809 record says what it wrote', [c3.status, c3.stdout.trim()], [0, `recorded ${R}#20 merged at cafe123 by ${S}`]);
const c4 = cli('show', '--pr', '20');
t('#809 show prints the PR\'s events, oldest first', c4.stdout.trim().split('\n').map((l) => l.split(/\s+/).slice(1, 3).join(' ')), [`${R}#20 claim`, `${R}#20 merged`]);
// Two mergers claiming at once, ten times over: the lock lets exactly one through each time.
const claimAt = (pr, by) => new Promise((res) => {
  const c = spawn('node', [BIN, 'claim', String(pr), 'feed123', '--by', by, '--repo', R], { env: { ...process.env } });
  c.on('close', (code) => res(code));
});
const races = await Promise.all(Array.from({ length: 10 }, (_, i) => Promise.all([claimAt(30 + i, S), claimAt(30 + i, D)])));
t('#809 two claims at once: exactly one gets the PR, every time', races.filter((r) => r.sort().join() !== '0,11').length, 0);
t('#809 a bad event is refused with the usage', cli('record', '20', 'cafe123', '--by', S, '--event', 'closed').status, 11);
t('#809 a claim with no --by is refused', cli('claim', '20', 'cafe123').status, 11);
// The CLI reads GitHub with gh: a stub answers for PR 40, armed then not.
const GH = mkdtempSync(join(tmpdir(), 'merge-log-gh-'));
writeFileSync(join(GH, 'gh'), '#!/bin/sh\ncat "$GH_ANSWER"\n', { mode: 0o755 });
const answer = join(GH, 'answer.json');
const cliGh = (...a) => spawnSync('node', [BIN, ...a, '--repo', R], { encoding: 'utf8', env: { ...process.env, PATH: `${GH}:${process.env.PATH}`, GH_ANSWER: answer } });
cli('record', '40', 'beef123', '--by', S, '--event', 'armed');
writeFileSync(answer, '{"autoMergeRequest":{"enabledAt":"x"}}');
const armedCli = cliGh('claim', '40', 'beef123', '--by', D).status;
writeFileSync(answer, '{"autoMergeRequest":null}');
t('#809 the CLI checks GitHub: armed there holds, off there releases', [armedCli, cliGh('claim', '40', 'beef123', '--by', D).status], [11, 0]);

console.log(fails ? `${fails} FAILED` : 'all merge log checks passed');
process.exit(fails ? 1 : 0);
