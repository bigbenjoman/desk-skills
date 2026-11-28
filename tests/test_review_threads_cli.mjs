// suite: review-threads CLI (the merge driver's verdict and thread reads count a cloud PR's opener, issue-1556)
// layer: L2
// covers: desk/bin/review-threads.mjs
// review-threads.mjs run as a real process per case, against a scratch queue.json, as merge-driver.sh runs it.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const CLEAN = 'p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0';
const CLOUD = 'd'.repeat(40);
const marked = (sha, counts = CLEAN, login = 'ben') => ({ id: `R${sha[0]}`, author: { login }, commit: { oid: sha }, body: ['<!-- desk-review:local -->', `<!-- desk-review:verdict v=1 sha=${sha} ${counts} vendor=codex round=1 -->`, '**desk-review**'].join('\n') });
const pl = (head, ...reviews) => ({ data: { repository: { pullRequest: { headRefOid: head, reviews: { nodes: reviews } } } } });
const openerT = { key: 'T-1', location: 'cloud', cloud: { head: CLOUD, pr: 701, opener: 'cloudbot' } };

// The merge driver's reads (review-threads.mjs read and verdict, with --pr and --ticket) count the opener as the pass does.
const dir = scratch('rt-cli-');
writeFileSync(join(dir, 'queue.json'), JSON.stringify({ tickets: { 'T-1': openerT } }));
const cli = (args) => {
  const r = spawnSync('node', [new URL('../desk/bin/review-threads.mjs', import.meta.url).pathname, ...args], { input: JSON.stringify(pl(CLOUD, marked(CLOUD, CLEAN, 'cloudbot'))), encoding: 'utf8', env: { ...process.env, DESK_QUEUE: join(dir, 'queue.json') } });
  try { return JSON.parse(r.stdout); } catch { return { error: r.stderr }; }
};
t('issue-1556 AC1 the driver\'s verdict read counts the opener on its cloud ticket\'s PR', cli(['verdict', '--handle', 'ben', '--clean', CLEAN, '--base', 'main', '--pr', '701', '--ticket', 'T-1']).clean, true);
t('issue-1556 AC1 and not on another PR', cli(['verdict', '--handle', 'ben', '--clean', CLEAN, '--base', 'main', '--pr', '702', '--ticket', 'T-1']).clean, false);
t('issue-1556 AC1 the driver\'s thread read takes the opener\'s clean verdict', cli(['read', '--handle', 'ben', '--clean', CLEAN, '--pr', '701', '--ticket', 'T-1']).verdict, CLOUD);
t('issue-1556 AC1 with no ticket it reads the handle alone', cli(['read', '--handle', 'ben', '--clean', CLEAN]).verdict ?? null, null);

console.log(fails ? `${fails} failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
