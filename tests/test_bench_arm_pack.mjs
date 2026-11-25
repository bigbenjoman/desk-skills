// suite: bench pack arm (the baseline against the same model with the start-4b pack at turn 0)
// layer: L2
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { buildPack, readPack, parseArgs, PACK_ARM, PACK_HEADING, START_4B_FILES } from '../desk/bin/bench-arm-pack.mjs';
import { runClaude, runKey, promptFor, SYSTEM_FILE } from '../desk/bin/bench.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };

const dir = realpathSync(scratch('bench-arm-pack-test-'));

// The pack keeps every file under its path, in order, and drops only paragraphs an earlier one holds.
const pack = buildPack([
  { path: 'a/SKILL.md', text: '# A\n\nRead the config first.\n\nA only.\n\n```\n\n```\n' },
  { path: 'b/SKILL.md', text: '# B\n\nRead  the config\nfirst.\n\nB only.\n\n```\n\n```\n\nB only.\n' },
]);
t('the pack opens with its heading', pack.startsWith(PACK_HEADING), true);
t('each file is under its own path, in order', pack.indexOf('<skill-file path="a/SKILL.md">') < pack.indexOf('<skill-file path="b/SKILL.md">'), true);
t('a paragraph an earlier file holds is dropped, whitespace aside', pack.split('Read').length - 1, 1);
t('a paragraph repeated in its own file is dropped', pack.split('B only.').length - 1, 1);
t('a paragraph with no words is never dropped', pack.split('```').length - 1, 4);
t('the rest is kept word for word', pack.includes('# B\n\nB only.'), true);

// readPack reads the listed files from the installed skills, and refuses a missing one by name.
const skills = join(dir, 'skills');
for (const p of START_4B_FILES) {
  mkdirSync(dirname(join(skills, p)), { recursive: true });
  writeFileSync(join(skills, p), `# ${p}\n\nShared rule paragraph.\n\nOwn text of ${p}.\n`);
}
const real = readPack(skills);
t('every listed file is in the pack', START_4B_FILES.every((p) => real.includes(`Own text of ${p}.`)), true);
t('the shared paragraph appears once', real.split('Shared rule paragraph.').length - 1, 1);
t('a missing skill file refuses to start, naming it', throws(() => readPack(join(dir, 'none'))), `refusing to start: the pack lists ${START_4B_FILES[0]}, which is not in ${join(dir, 'none')}`);

// The arms: the baseline under its stored name and the pack arm, both opus at medium.
const o = parseArgs(['--tasks', 'set.json', '--max-budget-usd', '2', '--total-budget-usd', '20']);
t('two arms, the baseline first', o.arms.map((a) => `${a.name}=${a.model}:${a.effort}`).join(' '), `opus=opus:medium ${PACK_ARM}=opus:medium`);
t('ten tasks by default', o.limit, 10);
t('the baseline arm takes the earlier run\'s name', parseArgs(['--tasks', 's', '--max-budget-usd', '1', '--baseline-arm', 'filed']).arms[0].name, 'filed');
t('an --arm of its own is refused', /sets its own arms/.test(throws(() => parseArgs(['--tasks', 's', '--max-budget-usd', '1', '--arm', 'x=opus']))), true);
t('a bad --limit is refused', /--limit must be/.test(throws(() => parseArgs(['--tasks', 's', '--max-budget-usd', '1', '--limit', '0']))), true);

// The run key: an arm with no pack keys as it always did, so stored baseline runs are reused; the pack
// is part of the pack arm's key, so a changed pack is a new run.
const task = { id: 't1', base: 'a'.repeat(40), prompt: 'Ticket t1' };
const plain = { name: 'opus', model: 'opus', effort: 'medium' };
const before = createHash('sha256').update(JSON.stringify([task.base, promptFor(task, plain), 'opus', 'medium'])).digest('hex').slice(0, 12);
t('a run with no pack keeps its key', runKey(task, plain), before);
t('the pack changes the key', runKey(task, { ...plain, system: 'P1' }) !== before, true);
t('a changed pack is a new key', runKey(task, { ...plain, system: 'P1' }) !== runKey(task, { ...plain, system: 'P2' }), true);

// runClaude hands the pack to claude as a file kept in the run's folder, and nothing for an arm with none.
// An executable stub, as the other bench suites write theirs: this suite starts a process (L2).
const fake = join(dir, 'fake-claude.mjs');
writeFileSync(fake, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));\n`);
chmodSync(fake, 0o755);
const runDir = join(dir, 'run');
mkdirSync(runDir);
const opts = { budget: '1', timeout: 30 };
runClaude(task, { ...plain, system: 'THE PACK' }, dir, join(dir, 'settings.json'), opts, runDir, { command: [process.execPath, fake] });
let argv = JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8'));
const at = argv.indexOf('--append-system-prompt-file');
t('the pack goes as a system prompt file', argv[at + 1], join(runDir, SYSTEM_FILE));
t('the run keeps the pack it ran with', readFileSync(join(runDir, SYSTEM_FILE), 'utf8'), 'THE PACK');
t('the prompt is the ticket alone', argv[argv.indexOf('-p') + 1], 'Ticket t1');
const bare = join(dir, 'bare');
mkdirSync(bare);
runClaude(task, plain, dir, join(dir, 'settings.json'), opts, bare, { command: [process.execPath, fake] });
argv = JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8'));
t('an arm with no pack has no system prompt file', argv.includes('--append-system-prompt-file') || existsSync(join(bare, SYSTEM_FILE)), false);

if (fails) { console.log(`FAIL ${fails} check(s) failed`); process.exit(1); }
