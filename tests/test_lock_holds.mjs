// suite: lock holds (each finished test-lock hold, and each holder's usual run time from them)
// layer: L1
// covers: desk/bin/lock-holds.mjs desk/bin/dir-lock.mjs desk/bin/quantile.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './scratch.mjs';
import { expectedOf, holdStep } from '../desk/bin/lock-holds.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = JSON.stringify;
const holds = (S) => { try { return readFileSync(join(S, 'lock-holds.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const run = (pid, heldS, repo = 'web', cmd = 'bash tests/run.sh') => ({ pid, repo, cmd, heldS });

{
  const S = scratch('lock-holds-');
  t('AC5 with no history a holder has no usual time', expectedOf(S)('web', 'bash tests/run.sh'), null);
  t('a first pass records nothing finished', j(holdStep(S, [run(1, 60), run(2, 30, 'desk')], { now: 'p1' })), '[]');
  t('so nothing is on file yet', holds(S).length, 0);
  // Pass 2: pid 1 still holds, longer; pid 2 has gone.
  holdStep(S, [run(1, 300)], { now: 'p2' });
  t('a holder gone has finished, at the hold the last pass saw', j(holds(S)), j([{ repo: 'desk', cmd: 'bash tests/run.sh', seconds: 30, end: 'p1' }]));
  // Pass 3: pid 1 is back with a shorter hold, so its run ended and another took its pid.
  holdStep(S, [run(1, 20)], { now: 'p3' });
  t('a shorter hold under the same pid is a new run, and the last one finished', j(holds(S).at(-1)), j({ repo: 'web', cmd: 'bash tests/run.sh', seconds: 300, end: 'p2' }));
  holdStep(S, [], { now: 'p4' });
  holdStep(S, [run(5, 100)], { now: 'p5' });
  holdStep(S, [], { now: 'p6' });
  const usual = expectedOf(S);
  t('AC5 a holder with history has its usual time, the median of its repo and command', usual('web', 'bash tests/run.sh'), 100);
  t('another repo\'s runs of the command are its own', usual('desk', 'bash tests/run.sh'), 30);
  t('a command with no history has none', usual('web', 'pnpm test'), null);
}
{
  const S = scratch('lock-holds-unknown-');
  holdStep(S, [run(1, 60)], { now: 'p1' });
  holdStep(S, [run(1, null)], { now: 'p2' });
  t('a holder still there whose hold is unread has not finished', holds(S).length, 0);
}
{
  const S = scratch('lock-holds-cwd-');
  holdStep(S, [run(1, 60)], { now: 'p1' });
  holdStep(S, [run(1, 120, null)], { now: 'p2' });
  t('a holder whose directory was not read this pass is the same hold, not one finished', holds(S).length, 0);
  holdStep(S, [], { now: 'p3' });
  t('and when it finishes it is under the repo an earlier pass read', j(holds(S)), j([{ repo: 'web', cmd: 'bash tests/run.sh', seconds: 120, end: 'p2' }]));
}

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
