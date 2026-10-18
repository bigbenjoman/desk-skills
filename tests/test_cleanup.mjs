// desk-cleanup's scripted scans against fixture worktrees, a fixture PR list and a fake process
// table: verdicts, whole-key matching, the ignored-file backup on removal, and watchman. Nothing
// reads this computer's processes, worktrees or GitHub.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keyMatches, prsForKey, ticketOf, parseStatus, isExtra, parsePs, memoryReport, ownerOf } from '../skills/desk-cleanup/bin/cleanup-scan.mjs'

const SCAN = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'desk-cleanup', 'bin', 'cleanup-scan.mjs')
let fails = 0
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`) }

const T = realpathSync(mkdtempSync(join(tmpdir(), 'desk-cleanup-')))
process.on('exit', () => rmSync(T, { recursive: true, force: true }))
writeFileSync(join(T, 'gitconfig'), '[user]\n\temail = t@example.com\n\tname = t\n[init]\n\tdefaultBranch = main\n')
const env = { ...process.env, HOME: join(T, 'home'), GIT_CONFIG_GLOBAL: join(T, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
mkdirSync(env.HOME)
const sh = (cwd, cmd, ...a) => { const r = spawnSync(cmd, a, { cwd, env, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`${cmd} ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim() }
const git = (cwd, ...a) => sh(cwd, 'git', ...a)
const scan = (...a) => spawnSync('node', [SCAN, ...a], { cwd: T, env, encoding: 'utf8', input: '' })

// ---- whole-key matching (AC4)
t('ABC-1 matches ABC-1', keyMatches('feat/ABC-1-fix', 'ABC-1'), true)
t('ABC-1 does not match ABC-12', keyMatches('feat/ABC-12-fix', 'ABC-1'), false)
t('ABC-1 does not match ABC-1-2', keyMatches('feat/abc-1-2', 'ABC-1'), false)
t('BUG-119 does not match BUG-119-5', keyMatches('fix BUG-119-5 crash', 'BUG-119'), false)
t('BUG-119-5 matches itself', keyMatches('fix BUG-119-5 crash', 'BUG-119-5'), true)
t('a letter before the key is not a boundary', keyMatches('XABC-1', 'ABC-1'), false)
t('case-insensitive on a lower-case branch', keyMatches('fix/abc-1-login', 'ABC-1'), true)
t('a regex character in the key is literal', keyMatches('feat/A.B-1', 'A+B-1'), false)
const prs = [{ number: 1, title: 'fix(x): ABC-12 thing', headRefName: 'fix/ABC-12-thing' }, { number: 2, title: 'ABC-1 the real one', headRefName: 'x' }, { number: 3, title: 'unrelated', headRefName: 'feat/abc-1-more' }]
t('prsForKey keeps title and branch matches only', prsForKey(prs, 'ABC-1').map((p) => p.number).join(','), '2,3')
const kf = spawnSync('node', [SCAN, 'key-filter', 'ABC-1'], { input: JSON.stringify(prs), encoding: 'utf8' })
t('key-filter reads gh JSON on stdin', JSON.parse(kf.stdout).map((p) => p.number).join(','), '2,3')
t('ticketOf takes a whole key from the branch', ticketOf('feat/ds-12-cleanup', 'DS-[0-9]+'), 'DS-12')
t('ticketOf with no pattern is empty', ticketOf('feat/DS-12', 'none'), '')

// ---- pure helpers
const st = parseStatus(' M a\0R  new\0old\0?? s.txt\0!! SPEC.md\0!! node_modules/\0')
t('status counts a rename once and skips its old path', `${st.tracked} ${st.untracked} ${st.ignored}`, '2 s.txt SPEC.md,node_modules/')
t('SPEC.md is an extra', isExtra('SPEC.md'), true)
t('a plan directory is an extra', isExtra('.ralph/'), true)
t('node_modules is not an extra', isExtra('node_modules/'), false)
t('nested build output is not an extra', isExtra('apps/web/.next/'), false)
t('an env file is not an extra', isExtra('apps/api/.env.local'), false)
t('owner is the longest registered prefix', ownerOf('/w/a/pkg/web', ['/w', '/w/a'], []), '/w/a')
t('a cwd in a removed worktree reads GONE', ownerOf('/wt/gone/apps/x', ['/repo'], ['/wt']), 'GONE:/wt/gone')

// ---- fixture repo: origin, main, and one worktree per verdict
const O = join(T, 'origin.git'), R = join(T, 'repo'), W = join(T, 'wt')
git(T, 'init', '-q', '--bare', O); git(T, 'init', '-q', R)
writeFileSync(join(R, '.gitignore'), 'SPEC.md\nnode_modules/\n.ralph/\n'); writeFileSync(join(R, 'f'), 'a\n')
git(R, 'add', '.'); git(R, 'commit', '-q', '-m', 'init'); git(R, 'remote', 'add', 'origin', O); git(R, 'push', '-q', 'origin', 'main')
const add = (name, branch) => { const p = join(W, name); git(R, 'worktree', 'add', '-q', '-b', branch, p); return p }
const commit = (p, msg) => { writeFileSync(join(p, `${msg}.txt`), msg); git(p, 'add', '.'); git(p, 'commit', '-q', '-m', msg); return git(p, 'rev-parse', 'HEAD') }
const me = { login: 'me' }, them = { login: 'them' }
const pr = (number, state, headRefName, headRefOid, author = me) => ({ number, state, headRefName, headRefOid, author, title: headRefName })

// merged: a merge-commit merge into main, with ignored SPEC.md, node_modules and a resume file
const merged = add('merged', 'feat/DS-1-merged'); const mergedTip = commit(merged, 'm1')
git(R, 'merge', '-q', '--no-ff', '-m', 'Merge DS-1', 'feat/DS-1-merged'); git(R, 'push', '-q', 'origin', 'main')
writeFileSync(join(merged, 'SPEC.md'), 'the spec'); mkdirSync(join(merged, 'node_modules', 'x'), { recursive: true }); writeFileSync(join(merged, 'node_modules', 'x', 'i.js'), '')
mkdirSync(join(merged, '.claude')); writeFileSync(join(merged, '.claude', 'desk-ticket-DS-1.json'), '{"live":true}')
// squashed: never in main, but the PR merged at this exact head
const squashed = add('squashed', 'feat/DS-12-squashed'); const squashedTip = commit(squashed, 's1')
// check: the PR merged at a head that is not this tip
const check = add('check', 'feat/DS-13-check'); commit(check, 'c1')
const elsewhere = add('elsewhere', 'tmp/elsewhere'); const otherHead = commit(elsewhere, 'e1')
git(R, 'worktree', 'remove', elsewhere)
// untracked: merged, with a scratch file
const untracked = add('untracked', 'feat/DS-14-untracked'); writeFileSync(join(untracked, 'scratch.txt'), 'x')
const theirs = add('theirs', 'feat/DS-15-theirs')
const open = add('open', 'feat/DS-16-open'); const openTip = commit(open, 'o1')
const nopr = add('nopr', 'feat/DS-17-nopr'); commit(nopr, 'n1')
const dirty = add('dirty', 'feat/DS-18-dirty'); writeFileSync(join(dirty, 'f'), 'changed\n')
const live = add('live', 'feat/DS-19-live'); mkdirSync(join(live, 'apps', 'web'), { recursive: true })
const gone = add('gone', 'feat/DS-20-gone'); rmSync(gone, { recursive: true })
const mainTip = git(R, 'rev-parse', 'HEAD')
// an orphan, and a worktree of another repo sitting in the same directory
mkdirSync(join(W, 'orphan-DS-21'))
const R2 = join(T, 'other'); git(T, 'init', '-q', R2); git(R2, 'commit', '-q', '--allow-empty', '-m', 'x'); git(R2, 'worktree', 'add', '-q', '-b', 'b', join(W, 'other-repo-wt'))

writeFileSync(join(T, 'prs.json'), JSON.stringify([
  pr(1, 'MERGED', 'feat/DS-1-merged', mergedTip), pr(2, 'MERGED', 'feat/DS-12-squashed', squashedTip),
  pr(3, 'MERGED', 'feat/DS-13-check', otherHead), pr(4, 'MERGED', 'feat/DS-14-untracked', mainTip),
  pr(5, 'MERGED', 'feat/DS-15-theirs', mainTip, them), pr(6, 'OPEN', 'feat/DS-16-open', openTip),
  pr(8, 'MERGED', 'feat/DS-18-dirty', mainTip), pr(9, 'MERGED', 'feat/DS-19-live', mainTip),
]))
// the fake process table: a dev server whose cwd is a package subdirectory of `live`
writeFileSync(join(T, 'cwds.txt'), `p4242\ncnode\nn${live}/apps/web\np77\nczsh\nn${T}\n`)

const base = ['--repo', R, '--author', 'me', '--default', 'main', '--no-fetch', '--prs', join(T, 'prs.json'), '--proc', join(T, 'cwds.txt'), '--key-pattern', 'DS-[0-9]+', '--worktrees-dir', W]
const ws = scan('worktrees', ...base)
t('worktrees exits 0', ws.status, 0)
const rows = Object.fromEntries(ws.stdout.trim().split('\n').slice(1).map((l) => l.split('\t')).map((c) => [c[1], c]))
const v = (p) => rows[p]?.[0]
const reason = (p) => rows[p]?.[7] ?? ''
t('header row', ws.stdout.split('\n')[0], 'verdict\tpath\tbranch\tticket\ttip\tpr\tauthor\treason\tuntracked\textras')
t('merged into main: SAFE (a resume file alone does not block)', v(merged), 'SAFE')
t('merged: ticket column', rows[merged]?.[3], 'DS-1')
t('merged: SPEC.md and the resume file in extras, node_modules not', rows[merged]?.[9], 'SPEC.md')
t('merged: the untracked resume file listed', rows[merged]?.[8], '.claude/desk-ticket-DS-1.json')
t('squash at the PR head: SAFE', `${v(squashed)} ${reason(squashed)}`, 'SAFE PR merged; local tip is the PR head')
t('PR merged at another head: CHECK', v(check), 'CHECK')
t('merged with a scratch file: UNTRACKED', `${v(untracked)} ${rows[untracked]?.[8]}`, 'UNTRACKED scratch.txt')
t("someone else's PR: KEEP", `${v(theirs)} ${reason(theirs)}`, "KEEP someone else's PR: report only")
t('open PR: KEEP', v(open), 'KEEP')
t('no PR: KEEP, never SAFE', `${v(nopr)} ${/^no PR/.test(reason(nopr))}`, 'KEEP true')
t('modified tracked file: KEEP', reason(dirty), '1 modified tracked files')
t('process cwd in a subdirectory: KEEP', reason(live), 'live process: node(4242)')
t('directory gone: PRUNE', v(gone), 'PRUNE')
t('unregistered directory: ORPHAN', v(join(W, 'orphan-DS-21')), 'ORPHAN')
t("another repo's worktree is not an orphan here", rows[join(W, 'other-repo-wt')], undefined)
t('the main worktree is not a row', rows[R], undefined)
t('a missing --author is refused', scan('worktrees', '--repo', R, '--no-fetch').status, 2)

// a shallow clone is refused before any history signal is read
git(T, 'clone', '-q', '--depth', '1', `file://${O}`, join(T, 'shallow'))
t('shallow clone exits 3', scan('worktrees', '--repo', join(T, 'shallow'), '--author', 'me', '--no-fetch', '--prs', join(T, 'prs.json'), '--proc', join(T, 'cwds.txt')).status, 3)

// ---- removal backs up ignored and untracked files first (AC3)
const B = join(T, 'backups'); mkdirSync(join(B, 'resume'), { recursive: true }); writeFileSync(join(B, 'resume', 'desk-ticket-DS-1.json'), '{"stale":true}')
const rmv = (...p) => scan('remove', '--repo', R, '--backups', B, '--proc', join(T, 'cwds.txt'), ...p)
const r1 = rmv(merged)
t('remove: DONE', /^DONE {2}\S*merged {2}\(feat\/DS-1-merged @ /m.test(r1.stdout), true)
t('remove: the worktree is gone', existsSync(merged), false)
const extrasDir = readdirSync(join(B, 'worktree-extras'))[0] ?? ''
t('remove: SPEC.md copied to the backups', readFileSync(join(B, 'worktree-extras', extrasDir, 'merged', 'SPEC.md'), 'utf8'), 'the spec')
t('remove: the copy is listed', r1.stdout.includes(`copied SPEC.md -> ${join(B, 'worktree-extras', extrasDir, 'merged', 'SPEC.md')}`), true)
t('remove: node_modules not copied', existsSync(join(B, 'worktree-extras', extrasDir, 'merged', 'node_modules')), false)
t('remove: the live resume file overwrites the stale backup', readFileSync(join(B, 'resume', 'desk-ticket-DS-1.json'), 'utf8'), '{"live":true}')
t('remove: restore.tsv carries path, branch and tip', readFileSync(join(B, 'worktree-extras', extrasDir, 'restore.tsv'), 'utf8'), `${merged}\tfeat/DS-1-merged\t${mergedTip}\n`)
t('remove: untracked file without the flag is SKIP', /^SKIP {2}\S*untracked: untracked files \(scratch\.txt\)/m.test(rmv(untracked).stdout) && existsSync(join(untracked, 'scratch.txt')), true)
const r2 = rmv('--allow-untracked', untracked)
// each run backs up into its own timestamped directory
const runs = readdirSync(join(B, 'worktree-extras'))
t('remove --allow-untracked: copied out, then removed', /^DONE/m.test(r2.stdout) && !existsSync(untracked) && runs.some((d) => existsSync(join(B, 'worktree-extras', d, 'untracked', 'scratch.txt'))), true)
t('remove: modified tracked file is SKIP', /^SKIP .*modified tracked files now/m.test(rmv(dirty).stdout) && existsSync(dirty), true)
t('remove: a live process is SKIP', /^SKIP .*a process is running inside it now \(node\(4242\)\)/m.test(rmv(live).stdout) && existsSync(live), true)
t('remove: an unregistered path is SKIP', /^SKIP .*not a registered worktree/m.test(rmv(join(W, 'orphan-DS-21')).stdout), true)
t('remove: the main worktree is SKIP', /^SKIP .*the main worktree/m.test(rmv(R).stdout), true)

// ---- memory: a fake process table (AC2)
const ps = parsePs([
  '  101  6920601  02:13:00 /opt/homebrew/bin/watchman --foreground --logfile=/x/log',
  '  202  3145728  01:00:00 node /w/repo/node_modules/.bin/next dev -p 3501',
  '  303   409600  03:00:00 claude',
  '  404  1048576     00:20 /usr/local/bin/node /w/repo/node_modules/vitest/vitest.mjs run',
  '  505     2048     00:20 /bin/zsh -c vitest run',
].join('\n'))
const mem = memoryReport({
  ps, cwds: [{ pid: 202, cwd: '/wt/gone-DS-9/apps/web' }, { pid: 303, cwd: '/w/repo' }],
  listen: [{ pid: 202, port: 3501 }, { pid: 202, port: 9229 }], ports: '3500-3600',
  worktrees: ['/w/repo'], dirs: ['/wt'], watchRoots: ['/w/repo', '/wt/gone-DS-9'], exists: (p) => p === '/w/repo',
}).join('\n')
t('watchman reported with its size', /^pid 101 · 6\.6 GiB up 02:13:00 {2}\[LARGE >2\.0 GiB/m.test(mem), true)
t('watchman: a test run in flight is named', mem.includes('unless a test run is in flight (one is)'), true)
t('watchman: a root whose directory is gone', mem.includes('watching /wt/gone-DS-9  [GONE: watchman watch-del]'), true)
t('watchman: a live root unflagged', /watching \/w\/repo$/m.test(mem), true)
t('dev server on a configured port, leak flagged, worktree deleted', /^:3501 .*\[LEAK\? next >2\.5 GiB; worktree deleted\]/m.test(mem), true)
t('a port outside the range is not a dev server', mem.includes(':9229'), false)
t('one claude session counted', mem.includes('1 sessions · 0.4 GiB'), true)
t('the node vitest is a test run, the shell wrapper is not', /pid 404 1\.0 GiB/.test(mem) && !/pid 505/.test(mem), true)
t('no watchman: says so', memoryReport({ ps: ps.filter((p) => p.pid !== 101), cwds: [], listen: [], ports: '3500' }).includes('not running'), true)
writeFileSync(join(T, 'ps.txt'), '  101  6920601  02:13:00 /opt/homebrew/bin/watchman --foreground\n')
writeFileSync(join(T, 'listen.txt'), ''); writeFileSync(join(T, 'wm.json'), JSON.stringify({ roots: [] }))
const mc = scan('memory', '--repo', R, '--ps', join(T, 'ps.txt'), '--proc', join(T, 'cwds.txt'), '--listen', join(T, 'listen.txt'), '--watchman', join(T, 'wm.json'))
t('memory CLI on fixtures: watchman line', /^pid 101 · 6\.6 GiB/m.test(mc.stdout) && mc.status === 0, true)

if (fails) { console.log(`FAIL: ${fails} checks failed`); process.exit(1) }
