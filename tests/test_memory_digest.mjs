// suite: memory digest (memory-digest.mjs: the worker's brief digest of the memory index)
// covers: desk/bin/memory-digest.mjs
// A fixture memory folder: an index over the 6 KB cap is cut at a whole entry and says how many were
// cut; one within it is whole and says nothing was cut; no folder, no index or an empty index is no
// digest. The CLI prints the digest and appends its size to a log. Scratch directories only.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { memoryDigest, indexEntries, digestLine, DIGEST_CAP } from '../desk/bin/memory-digest.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'memory-digest.mjs');
const T = mkdtempSync(join(tmpdir(), 'desk-memdigest-'));
const folder = (name, index) => {
  const d = join(T, name);
  mkdirSync(d, { recursive: true });
  if (index != null) writeFileSync(join(d, 'MEMORY.md'), index);
  return d;
};
// An entry of exactly `n` bytes with its newline.
const entry = (i, n) => { const head = `- [Rule ${i}](rule-${i}.md) — `; return head + 'x'.repeat(n - 1 - Buffer.byteLength(head)); };

t('the cap is 6 KB', DIGEST_CAP, 6144);

// AC2: 70 entries of 100 bytes is 7,000 bytes: 61 fit (6,100), 9 are cut.
const big = Array.from({ length: 70 }, (_, i) => entry(i, 100));
const over = memoryDigest(folder('over', `${big.join('\n')}\n`));
t('AC2 an index over the cap keeps whole entries up to 6 KB', [over.entries, over.kept, over.cut, over.bytes], [70, 61, 9, 6100]);
t('AC2 its digest holds the first entries in order', over.text.includes(`${big[0]}\n${big[1]}`) && over.text.includes(big[60]), true);
t('AC2 and none past the cap', over.text.includes(big[61]), false);
t('AC2 it says how many were cut', over.text.includes('61 of its 70 entries, cut at 6144 bytes: 9 entries were cut.'), true);
t('AC2 its size is recorded as an event line', JSON.parse(digestLine(over, new Date(0))),
  { type: 'desk_memory_digest', bytes: 6100, entries: 70, kept: 61, cut: 9, at: '1970-01-01T00:00:00.000Z' });
t('AC2 an index exactly at the cap is not cut', memoryDigest(folder('exact', Array.from({ length: 64 }, (_, i) => entry(i, 96)).join('\n'))).cut, 0);

// AC3: within the cap, the whole index, headings and blank lines dropped.
const small = `# Memory index\n\n- [One](one.md) — first rule\n- [Two](two.md) — second rule\n`;
const under = memoryDigest(folder('under', small));
t('AC3 an index within the cap is whole', [under.entries, under.kept, under.cut], [2, 2, 0]);
t('AC3 it says nothing was cut', under.text.includes('all 2 of its entries: nothing was cut.'), true);
t('AC3 its entries end the digest', under.text.endsWith('- [One](one.md) — first rule\n- [Two](two.md) — second rule'), true);
t('the digest says auto-memory is off', under.text.startsWith('# Memory digest\n\nAuto-memory is off for this session'), true);
t('headings and blank lines are not entries', indexEntries(small), ['- [One](one.md) — first rule', '- [Two](two.md) — second rule']);

// AC4: no folder, no index, or an index with no entries: no digest.
t('AC4 no memory folder is no digest', memoryDigest(join(T, 'missing')), null);
t('AC4 a folder with no index is no digest', memoryDigest(folder('noindex')), null);
t('an index with no entries is no digest', memoryDigest(folder('empty', '# Memory index\n\n')), null);

// The CLI spawn-worker.sh runs.
const cli = (...a) => spawnSync('node', [BIN, ...a], { encoding: 'utf8' });
const log = join(T, 'worker.log');
writeFileSync(log, '{"type":"desk_preflight","total_cost_usd":0.1,"num_turns":3}\n');
let r = cli(join(T, 'over'), '--log', log);
t('CLI prints the digest', [r.status, r.stdout], [0, over.text]);
const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
t('CLI appends the size after the cost line', [lines.length, lines[0].type, lines[1].type, lines[1].bytes, lines[1].cut], [2, 'desk_preflight', 'desk_memory_digest', 6100, 9]);
const quiet = join(T, 'quiet.log');
r = cli(join(T, 'missing'), '--log', quiet);
t('AC4 CLI with no folder: no output, no error, no log line', [r.status, r.stdout, r.stderr, existsSync(quiet)], [0, '', '', false]);
t('CLI with no folder named exits 2', cli().status, 2);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
