// suite: live-read (§4 Live reads: which parks the pass runs a read for, and how it records one)
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLiveReads, liveReadPark, readRecord, startRead, saveFixture } from '../desk/bin/live-read.mjs';
import { waitingOnRead, batchSettled } from '../desk/bin/batch-state.mjs';
import { shownState } from '../desk/bin/desk-q.mjs';
import { describeCond } from '../desk/bin/clears-when.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const row = parseLiveReads(['gateway-models: ./scripts/fetch-models.sh staging','numbers.v2: ./fetch numbers', '../x: cat /etc/passwd', 'no command']);
t('the row parses name: command items', row.reads.map((r) => r.name).join(' '), 'gateway-models numbers.v2');
t('a name that holds a path, or an item with no command, is an error', row.errors.length, 2);
const reads = row.reads;
const names = (q) => liveReadPark(q, reads)?.map((r) => r.name).join(' ') ?? null;

t('a park naming one entry and the not-reached tail asks for it',
  names('Need live read gateway-models for the recorded payload. Not reached: the PR, the Jira comment and the transition'), 'gateway-models');
t('two entries in one park ask for both', names('Need gateway-models and numbers.v2 run on the host.'), 'gateway-models numbers.v2');
t('a name matches whatever its case', names('Need GATEWAY-MODELS.'), 'gateway-models');
t('a name inside a longer word is not that entry', names('Need gateway-models-v2.'), null);
t('a park naming no entry is left as it is', names('Which price should the plan show? Not reached: the PR'), null);
t('a question beside the entry is left for the person', names('Need gateway-models. Should the fallback model be gw-2?'), null);
t('a tail clause holding an ask is not the tail', names('Need gateway-models. Not reached: the PR, so confirm the fee'), null);
t('no entries in the row asks for nothing', liveReadPark('Need gateway-models.', []), null);

const dir = mkdtempSync(join(tmpdir(), 'desk-live-read-'));
const head = 'c'.repeat(40);
const wait = async (name) => { for (let i = 0; i < 100 && readRecord(dir, 'L-1', head, name)?.state !== 'done'; i++) await new Promise((r) => setTimeout(r, 50)); return readRecord(dir, 'L-1', head, name); };
t('no read started at a head has no record', readRecord(dir, 'L-1', head, 'ok'), null);
startRead(dir, { key: 'L-1', head, name: 'ok', command: 'echo "{\\"a\\":1}"; echo noise >&2', cwd: dir });
startRead(dir, { key: 'L-1', head, name: 'bad', command: 'echo partial; echo "AccessDenied: no key" >&2; echo "at line 3" >&2; exit 2', cwd: dir });
const ok = await wait('ok');
const bad = await wait('bad');
t('a read that exits 0 records code 0', ok?.code, 0);
t('a failed read records its exit code', bad?.code, 2);
t('and its last error line, from stderr', bad?.error, 'at line 3');
const fx = join(dir, 'fixtures');
const saved = saveFixture(fx, 'L-1', 'ok', ok.out);
t('a saved fixture is <fixtures>/<KEY>/<name>.json, holding stdout only', `${saved === join(fx, 'L-1', 'ok.json')} ${readFileSync(saved, 'utf8').trim()}`, 'true {"a":1}');
t('a failed read saves nothing by itself', existsSync(join(fx, 'L-1', 'bad.json')), false);

const parked = { key: 'L-1', state: 'parked', park: { question: 'Need gateway-models.', clears_when: { kind: 'live-read', reads: ['gateway-models'], head } } };
const other = { key: 'L-2', state: 'parked', park: { question: 'Which price?', clears_when: { kind: 'none' } } };
t('a park on its live reads waits on the pass', waitingOnRead(parked), true);
t('any other park does not', waitingOnRead(other), false);
t('desk-q shows it waiting while passes run', shownState({ tickets: { 'L-1': parked } }, parked, { live: true }), 'waiting');
t('and needing the person with passes stopped, since nothing runs it', shownState({ tickets: { 'L-1': parked } }, parked, { live: false }), 'needs');
t('a batch with a park on its live reads is not settled', batchSettled({ tickets: { 'L-1': parked, 'L-2': other } }, () => null), false);
t('the condition reads as the reads it waits on', describeCond(parked.park.clears_when), 'live read gateway-models finished');

rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'live-read: all checks passed');
process.exit(fails ? 1 : 0);
