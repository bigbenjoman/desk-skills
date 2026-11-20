// suite: merge log (who merged what, at which head)
// merge-log.mjs claim refuses a merge another merger has claimed recently, merged or armed, and lets the
// same merger through; record and show keep and print every event; the CLI exits 11 on a refusal.
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
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
t('#809 auto-merge armed by another merger holds the PR too', M.claim({ repo: R, pr: 10, sha: 'aaa1111', by: D, now: NOW + 3 * M.CLAIM_MS, path }).ok, false);
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
t('#809 a bad event is refused with the usage', cli('record', '20', 'cafe123', '--by', S, '--event', 'closed').status, 11);
t('#809 a claim with no --by is refused', cli('claim', '20', 'cafe123').status, 11);

console.log(fails ? `${fails} FAILED` : 'all merge log checks passed');
process.exit(fails ? 1 : 0);
