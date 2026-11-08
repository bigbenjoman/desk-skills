// suite: migration renames (a base that renumbers a migration sends the child naming it to a worker)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { childRenames, renumberings } from '../desk/bin/migration-renames.mjs';
import { renamesFix, fixBrief, fixTask, triesMade, FIX_TRIES_MAX } from '../desk/bin/fix-tries.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

// What counts as a renumbering.
const V = 'backend/migrations/versions';
t('a renumbered migration is found', renumberings(`R100\t${V}/128_a.py\t${V}/129_a.py`).map((r) => [r.old, r.new]), [['128_a.py', '129_a.py']]);
t('a migration directory renamed in place is found', renumberings('R100\tprisma/migrations/2026_a/migration.sql\tprisma/migrations/2027_a/migration.sql').map((r) => r.old), ['2026_a']);
t('a rename outside the migrations directory is not', renumberings('R100\tsrc/128_a.py\tsrc/129_a.py'), []);
t('a migration moved to another directory is not', renumberings(`R100\t${V}/128_a.py\tother/migrations/128_a.py`), []);
t('a new or changed file is not', renumberings(`A\t${V}/128_a.py\nM\t${V}/129_a.py`), []);

// A real repo: main renumbers a migration after each child left it.
const dir = mkdtempSync(join(tmpdir(), 'renames-'));
const git = (args) => { try { return { ok: true, out: execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; } catch { return { ok: false, out: '' }; } };
const run = (...args) => { const r = git(args); if (!r.ok) throw new Error(`git ${args.join(' ')} failed`); return r.out; };
const put = (path, text, msg) => { mkdirSync(join(dir, dirname(path)), { recursive: true }); writeFileSync(join(dir, path), text); run('add', '-A'); run('commit', '-q', '-m', msg); return run('rev-parse', 'HEAD'); };
execFileSync('git', ['init', '-q', '-b', 'main', dir]);
run('config', 'user.email', 'x@example.com'); run('config', 'user.name', 'x');
const OLD = `${V}/128_add_model.py`, NEW = `${V}/129_add_model.py`;
put(OLD, 'revision = "128"\nbody = "kept"\n', 'migration');
put('tests/test_base.py', 'open("128_add_model.py")\n', 'a test of the base, which names the migration');
run('checkout', '-q', '-b', 'names');
const names = put('tests/test_child.py', 'open("backend/migrations/versions/128_add_model.py")\n', 'a child naming it');
run('checkout', '-q', '-b', 'clean', 'main');
const clean = put('tests/test_other.py', 'print(1)\n', 'a child naming nothing');
run('checkout', '-q', 'main');
run('mv', OLD, NEW);
writeFileSync(join(dir, 'tests/test_base.py'), 'open("129_add_model.py")\n');
run('add', '-A'); run('commit', '-q', '-m', 'renumber');

const found = childRenames({ head: names, base: 'main', git });
t('AC1 a child naming the old filename is found', found.map((r) => [r.old, r.new, r.files]), [['128_add_model.py', '129_add_model.py', ['tests/test_child.py']]]);
t('AC2 a child naming none of them is not', childRenames({ head: clean, base: 'main', git }), []);

// The child has since merged the base: its merge base is past the rename, but its files still name it.
run('checkout', '-q', 'names');
run('merge', '-q', '--no-edit', 'main');
const merged = run('rev-parse', 'HEAD');
t('AC1 still found once the base is merged in', childRenames({ head: merged, base: 'main', git }).map((r) => r.files), [['tests/test_child.py']]);
const fixed = put('tests/test_child.py', 'open("backend/migrations/versions/129_add_model.py")\n', 'names the new file');
t('AC3 nothing once the child names the new file', childRenames({ head: fixed, base: 'main', git }), []);

// The base renames it again after the child followed the first rename: the child names the middle name.
run('merge', '-q', '--no-edit', 'main');
const onMiddle = run('rev-parse', 'HEAD');
run('checkout', '-q', 'main');
run('mv', NEW, `${V}/130_add_model.py`);
run('commit', '-q', '-m', 'renumber again');
t('AC1 a second rename of a name the child followed is found', childRenames({ head: onMiddle, base: 'main', git }).map((r) => [r.old, r.new, r.files]), [['129_add_model.py', '130_add_model.py', ['tests/test_child.py']]]);
run('checkout', '-q', 'main');
rmSync(dir, { recursive: true, force: true });

// The try.
const opts = { pr: 861, head: 'a'.repeat(40), base: 'feat/base', renames: found };
const c = renamesFix({ key: 'T-1' }, opts);
t('AC1 the worker is sent with the old and new names', [c.call, c.fix.kind, c.fix.renames[0].old, c.fix.renames[0].new], ['requeue', 'renames', '128_add_model.py', '129_add_model.py']);
t('it is outside the fix tries', [c.fix.extra, triesMade([{ kind: 'renames', extra: true }]), c.fix.of], [true, 0, FIX_TRIES_MAX]);
t('a child whose tries are spent is still sent', renamesFix({ fix_tries: [{ kind: 'checks' }, { kind: 'checks' }] }, opts)?.call, 'requeue');
t('AC2 no rename, no try', renamesFix({}, { ...opts, renames: [] }), null);
t('a rename already tried is not sent again', renamesFix({ fix_tries: [{ kind: 'renames', extra: true, renames: found }] }, opts), null);
t('a later rename is', renamesFix({ fix_tries: [{ kind: 'renames', extra: true, renames: found }] }, { ...opts, renames: [{ ...found[0], to: `${V}/130_add_model.py`, new: '130_add_model.py' }] })?.call, 'requeue');

const brief = fixBrief({ fix: c.fix });
t('the brief names each old and new name and its files', ['128_add_model.py is now 129_add_model.py', 'tests/test_child.py', 'origin/feat/base'].every((x) => brief.includes(x)), true);
t('a ready PR is not reviewed by the try', fixTask({ fix: c.fix }).includes('desk-review'), false);
t('a draft is', fixTask({ fix: renamesFix({}, { ...opts, draft: true }).fix }).includes('desk-review'), true);

console.log(`migration renames: ${fails ? `${fails} failed` : 'ok'}`);
process.exit(fails ? 1 : 0);
