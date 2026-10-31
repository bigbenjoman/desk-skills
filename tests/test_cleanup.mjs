// suite: desk-cleanup scans (verdicts, whole keys, backups, watchman, instruction files)
// desk-cleanup's scripted scans against fixture worktrees, a fixture PR list and a fake process
// table: verdicts, whole-key matching, the ignored-file backup on removal, watchman, and the audit of
// the instruction files a fixture repo and home load at launch. Nothing reads this computer's
// processes, worktrees, home or GitHub.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keyMatches, prsForKey, ticketOf, parseStatus, isExtra, parsePs, memoryReport, ownerOf } from '../skills/desk-cleanup/bin/cleanup-scan.mjs'
import { launchFiles, auditReport, sections, linesOf, targetFor } from '../skills/desk-cleanup/bin/instruction-audit.mjs'

const SCAN = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'desk-cleanup', 'bin', 'cleanup-scan.mjs')
let fails = 0
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`) }

const T = realpathSync(mkdtempSync(join(tmpdir(), 'desk-cleanup-')))
process.on('exit', () => rmSync(T, { recursive: true, force: true }))
writeFileSync(join(T, 'gitconfig'), '[user]\n\temail = t@example.com\n\tname = t\n[init]\n\tdefaultBranch = main\n')
// A stub watchman on PATH records its arguments, so the host's watchman is never touched.
mkdirSync(join(T, 'bin')); writeFileSync(join(T, 'bin', 'watchman'), `#!/bin/sh\necho "$@" >> "${T}/watchman.log"\n`, { mode: 0o755 })
const env = { ...process.env, PATH: `${join(T, 'bin')}:${process.env.PATH}`, HOME: join(T, 'home'), GIT_CONFIG_GLOBAL: join(T, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
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
t('a regex character in the key is literal', keyMatches('feat/AXB-1', 'A.B-1'), false)
t('a key with a regex character still matches itself', keyMatches('feat/A.B-1', 'A.B-1'), true)
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
const pr = (number, state, headRefName, headRefOid, author = me, baseRefName = 'main') => ({ number, state, headRefName, headRefOid, baseRefName, author, title: headRefName })

// merged: a merge-commit merge into main, with ignored SPEC.md, node_modules and a resume file
const merged = add('merged', 'feat/DS-1-merged'); const mergedTip = commit(merged, 'm1')
git(R, 'merge', '-q', '--no-ff', '-m', 'Merge DS-1', 'feat/DS-1-merged'); git(R, 'push', '-q', 'origin', 'main')
writeFileSync(join(merged, 'SPEC.md'), 'the spec'); mkdirSync(join(merged, 'node_modules', 'x'), { recursive: true }); writeFileSync(join(merged, 'node_modules', 'x', 'i.js'), '')
mkdirSync(join(merged, '.claude')); writeFileSync(join(merged, '.claude', 'desk-ticket-DS-1.json'), '{"live":true}')
// squashed: never in main, but the PR merged at this exact head. Its branch ignores all of
// `.claude/`, so the resume file shows only as the collapsed directory.
const squashed = add('squashed', 'feat/DS-12-squashed')
writeFileSync(join(squashed, '.gitignore'), 'SPEC.md\nnode_modules/\n.ralph/\n.claude/\n'); const squashedTip = commit(squashed, 's1')
mkdirSync(join(squashed, '.claude')); writeFileSync(join(squashed, '.claude', 'desk-ticket-DS-12.json'), '{}')
// stacked: the PR merged at this head, but into another branch, not main
const stacked = add('stacked', 'feat/DS-22-stacked'); const stackedTip = commit(stacked, 'k1')
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
  pr(10, 'MERGED', 'feat/DS-22-stacked', stackedTip, me, 'feat/DS-21-parent'),
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
t('merged: SPEC.md in extras, node_modules not', rows[merged]?.[9], 'SPEC.md')
t('merged: the untracked resume file listed', rows[merged]?.[8], '.claude/desk-ticket-DS-1.json')
t('squash at the PR head: SAFE', `${v(squashed)} ${reason(squashed)}`, 'SAFE PR merged; local tip is the PR head')
t('a resume file inside an ignored .claude/ is still named in extras', rows[squashed]?.[9]?.split(',').includes('.claude/desk-ticket-DS-12.json'), true)
t('PR merged into another branch at this head: CHECK, never SAFE', `${v(stacked)} ${/not origin\/main/.test(reason(stacked))}`, 'CHECK true')
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
// two worktrees with the same basename, removed in one call: neither backup overwrites the other
const dupA = join(W, 'dup'), dupB = join(R, '.claude', 'worktrees', 'dup')
git(R, 'worktree', 'add', '-q', '-b', 'feat/DS-23-a', dupA); git(R, 'worktree', 'add', '-q', '-b', 'feat/DS-24-b', dupB)
writeFileSync(join(dupA, 'SPEC.md'), 'spec A'); writeFileSync(join(dupB, 'SPEC.md'), 'spec B')
const r3 = rmv(dupA, dupB)
const specs = readdirSync(join(B, 'worktree-extras')).flatMap((d) => readdirSync(join(B, 'worktree-extras', d)).map((s) => join(B, 'worktree-extras', d, s, 'SPEC.md'))).filter((p) => p.includes('/dup') && existsSync(p)).map((p) => readFileSync(p, 'utf8')).sort().join(',')
t('remove: same-named worktrees keep separate backups', `${(r3.stdout.match(/^DONE/gm) ?? []).length} ${specs}`, '2 spec A,spec B')
const wlog = existsSync(join(T, 'watchman.log')) ? readFileSync(join(T, 'watchman.log'), 'utf8') : ''
t('remove: watchman dropped for removed trees only, never spawned', wlog.includes(`--no-spawn watch-del ${merged}\n`) && wlog.includes(`--no-spawn watch-del ${untracked}\n`) && !/watch-del .*(dirty|live)/.test(wlog) && !/^watch-del/m.test(wlog), true)

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

// ---- memory-index: the repo's auto-memory MEMORY.md against the cap
const memDir = join(env.HOME, '.claude', 'projects', R.replace(/[^A-Za-z0-9]/g, '-'), 'memory')
const mi = () => scan('memory-index', '--repo', R)
let r4 = mi()
t('memory-index: no memory directory prints nothing and exits 0', `${r4.status} ${JSON.stringify(r4.stdout)}`, '0 ""')
mkdirSync(memDir, { recursive: true })
writeFileSync(join(memDir, 'MEMORY.md'), Array.from({ length: 20 }, (_, i) => `- [Note ${i}](n${i}.md) — one line`).join('\n') + '\n')
r4 = mi()
t('memory-index: within the cap prints nothing', `${r4.status} ${JSON.stringify(r4.stdout)}`, '0 ""')
const big = ['# Memory', '', ...Array.from({ length: 70 }, (_, i) => `- [Note ${i}](n${i}.md) — one line`), '- Deploys go through the release train', '  and staging must be green first', '  (Ben, 2026-09)', '', 'A loose paragraph that', 'runs on.', '']
writeFileSync(join(memDir, 'MEMORY.md'), big.join('\n'))
r4 = mi()
const [l1, l2] = r4.stdout.split('\n')
const bytes = Buffer.byteLength(big.join('\n'))
t('memory-index: over the cap prints the report line', l1, `memory-index : ${join(memDir, 'MEMORY.md')} · ${bytes} B · ${big.length - 1} lines · cap 6144 B or 60 lines   [report only]`)
t('memory-index: the line below names the multi-line entries only', l2.trim(), 'move into their own memory files: "Deploys go through the release train" (3 lines), "A loose paragraph that" (2 lines)')
writeFileSync(join(memDir, 'MEMORY.md'), `- ${'x'.repeat(7000)}\n`)
r4 = mi()
t('memory-index: over the byte cap alone is reported', /^memory-index : .* · 7003 B · 1 lines .*\n +every entry is one line/.test(r4.stdout), true)

// ---- instructions: what loads at launch, and the moves proposed for what is over its cap
const put = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text) }
const fill = (n, what) => Array.from({ length: n }, (_, i) => `- ${what} rule ${i}`)
mkdirSync(join(R, 'apps', 'api', 'src'), { recursive: true }); mkdirSync(join(R, 'apps', 'api', 'lib'), { recursive: true }); mkdirSync(join(R, 'packages', 'db'), { recursive: true })
const claudeMd = ['# Project', '', 'See @docs/guide.md for more, and mail ben@example.com.', ...fill(107, 'general'), '',
  '## API conventions', 'Handlers live in `apps/api/src/` and `apps/api/lib/`.', ...fill(101, 'api'), '',
  '## Data layer', 'Touches `apps/api/` and `packages/db/` together.', ...fill(100, 'data'), '',
  '## Writing style', 'Plain sentences.', ...fill(99, 'style'), '']
put(join(R, 'CLAUDE.md'), claudeMd.join('\n'))
put(join(R, 'docs', 'guide.md'), 'one\ntwo\nthree\nfour\nfive\n')
put(join(R, 'AGENTS.md'), '# Agents\n\nShort.\n')
put(join(R, 'CLAUDE.local.md'), 'local\n')
put(join(R, '.claude', 'rules', 'style.md'), '# Style\n\nAlways.\n')
put(join(R, '.claude', 'rules', 'api.md'), '---\npaths:\n  - "apps/api/**"\n---\n\nOnly for the API.\n')
put(join(env.HOME, '.claude', 'CLAUDE.md'), 'user rules\n')
put(join(env.HOME, '.claude', 'skills', 'big', 'SKILL.md'), `---\nname: big\ndescription: >-\n  Use when testing the audit. ${'More words here. '.repeat(70).trim()}\n---\n\n# big\n`)
put(join(env.HOME, '.claude', 'agents', 'helper.md'), '---\nname: helper\ndescription: "A small helper."\n---\n\nBody.\n')
writeFileSync(join(memDir, 'MEMORY.md'), big.join('\n'))
const tree = (d) => readdirSync(d, { withFileTypes: true }).filter((e) => e.name !== '.git').flatMap((e) => (e.isDirectory() ? tree(join(d, e.name)) : [`${join(d, e.name)}\n${readFileSync(join(d, e.name), 'utf8')}`])).sort().join('\n')
const snapshot = () => tree(R) + tree(env.HOME)
const beforeAudit = snapshot()
const ia = scan('instructions', '--repo', R, '--policy', 'none')
const out = ia.stdout.split('\n')
const launch = out.filter((l) => l.startsWith('launch : '))
t('instructions: exits 0', `${ia.status} ${ia.stderr}`, '0 ')

// AC1: every file read at launch, with its size; a rule with paths: is not one of them.
t('AC1 lists the CLAUDE.md and AGENTS.md chain, unscoped rules, MEMORY.md, skills and agents',
  launch.map((l) => l.split(' · ').slice(0, 2).join(' · ').replace(/ +/g, ' ')).join('\n'),
  ['launch : CLAUDE.md · ~/.claude/CLAUDE.md', 'launch : CLAUDE.md · CLAUDE.md', 'launch : import · docs/guide.md', 'launch : AGENTS.md · AGENTS.md', 'launch : CLAUDE.local.md · CLAUDE.local.md',
    'launch : rule · .claude/rules/style.md', `launch : MEMORY.md · ${join(memDir, 'MEMORY.md').replace(env.HOME, '~')}`, 'launch : skill · big (~/.claude/skills/big/SKILL.md)',
    'launch : agent · helper (~/.claude/agents/helper.md)', 'launch : total · 9 files'].join('\n'))
t('AC1 a file row carries its bytes and lines, and says when it is over the cap with its imports', launch[1].endsWith(`· ${Buffer.byteLength(claudeMd.join('\n'))} B · ${claudeMd.length - 1} lines · over cap 200 lines with its imports (${claudeMd.length - 1 + 5})`), true)
t('AC1 a skill row carries its description length', /· big .* · \d{4} chars of description · over cap 1024 chars$/.test(launch[7]), true)
t('AC1 a description within the cap is not flagged', launch[8].endsWith('· helper (~/.claude/agents/helper.md) · 15 chars of description'), true)

// AC3: an @ import is listed with the file that names it, and said not to reduce what loads.
t('AC3 an import loads with its parent and does not reduce what loads', launch[2].endsWith('· 5 lines · loads with CLAUDE.md: an @ import does not reduce what loads'), true)

// AC2: each oversized file gets moves to a lazily loaded place, and every change as a diff.
const propose = out.filter((l) => l.startsWith('propose : '))
t('AC2 the largest sections move until the file is under the cap, each to where it loads lazily', propose.join('\n'), [
  'propose : CLAUDE.md · "API conventions" (104 lines) → subdirectory CLAUDE.md apps/api/CLAUDE.md',
  'propose : CLAUDE.md · "Data layer" (103 lines) → path-scoped rule .claude/rules/data-layer.md',
  'propose : CLAUDE.md · "Writing style" (101 lines) → skill reference .claude/skills/writing-style/SKILL.md',
  `propose : ${join(memDir, 'MEMORY.md').replace(env.HOME, '~')} · "Deploys go through the release train" (3 lines) → memory topic file ${join(memDir, 'deploys-go-through-the-release-train.md').replace(env.HOME, '~')}`,
  `propose : ${join(memDir, 'MEMORY.md').replace(env.HOME, '~')} · "A loose paragraph that" (2 lines) → memory topic file ${join(memDir, 'a-loose-paragraph-that.md').replace(env.HOME, '~')}`,
  `propose : ~/.claude/skills/big/SKILL.md · "description" (${'More words here. '.repeat(70).trim().length} chars) → the skill body, which loads only when it runs`,
].join('\n'))
const diff = out.slice(out.indexOf('diff :') + 1)
const blocks = diff.join('\n').split(/\n(?=--- )/)
const inRepo = blocks.filter((b) => /^\+\+\+ b\//m.test(b))
t('AC2 the repo-side diffs name the source and each new file', inRepo.map((b) => b.split('\n').slice(0, 2).join(' ')).join('\n'),
  ['--- a/CLAUDE.md +++ b/CLAUDE.md', '--- /dev/null +++ b/apps/api/CLAUDE.md', '--- /dev/null +++ b/.claude/rules/data-layer.md', '--- /dev/null +++ b/.claude/skills/writing-style/SKILL.md'].join('\n'))
t('AC2 the scoped rule names each directory the section does', /\n\+paths:\n\+ {2}- "apps\/api\/\*\*"\n\+ {2}- "packages\/db\/\*\*"\n/.test(inRepo[2]), true)
writeFileSync(join(T, 'audit.patch'), `${inRepo.join('\n')}\n`)
const applies = spawnSync('git', ['apply', '--check', join(T, 'audit.patch')], { cwd: R, env, encoding: 'utf8' })
t('AC2 the diffs apply cleanly to the repo as shown', `${applies.status} ${applies.stderr.trim()}`, '0 ')
t('AC2 the memory index keeps one pointer line per moved entry', diff.includes('+- [Deploys go through the release train](deploys-go-through-the-release-train.md)'), true)
t('AC2 the skill keeps its first sentence as the description', diff.includes('+  Use when testing the audit.') && diff.includes('+## When to use'), true)

// AC4: the audit writes nothing; the proposals are only printed.
t('AC4 running the audit changes no file in the repo or home', snapshot() === beforeAudit, true)
t('AC4 no proposed target exists after the audit', ['apps/api/CLAUDE.md', '.claude/rules/data-layer.md', '.claude/skills/writing-style/SKILL.md'].some((p) => existsSync(join(R, p))), false)

// AC5: skill-doctor's and prompt-audit's findings are included verbatim, and the audit then judges no
// description itself.
writeFileSync(join(T, 'sd.txt'), 'big: description too long\nhelper: ok\n'); writeFileSync(join(T, 'pa.txt'), 'CLAUDE.md: repeats itself\n')
const withDoctor = scan('instructions', '--repo', R, '--policy', 'none', '--skill-doctor', join(T, 'sd.txt'), '--prompt-audit', join(T, 'pa.txt')).stdout
t('AC5 skill-doctor\'s output is included verbatim', withDoctor.includes('skill-doctor : big: description too long\n             : helper: ok\n'), true)
t('AC5 prompt-audit\'s output is included verbatim', withDoctor.includes('prompt-audit : CLAUDE.md: repeats itself\n'), true)
t('AC5 with skill-doctor, the audit neither flags nor moves a description', /chars of description · over cap|"description" \(/.test(withDoctor), false)
t('AC5 and still measures the instruction files', withDoctor.includes('propose : CLAUDE.md · "API conventions"'), true)

// AC6, and the skill text the scan answers to.
const skillsDir = join(dirname(SCAN), '..', '..')
const audit = readFileSync(join(skillsDir, 'desk-cleanup', 'references', 'instruction-audit.md'), 'utf8')
t('AC4 the audit reference writes nothing before the user approves', /\*\*Nothing is written until the user approves it\.\*\*/.test(audit), true)
t('AC5 the audit reference runs /skill-doctor and /doctor prompt-audit rather than copying them', audit.includes('/skill-doctor') && audit.includes('/doctor prompt-audit'), true)
t('AC6 /desk-setup offers the audit when it finishes', readFileSync(join(skillsDir, 'desk-setup', 'references', 'step-5-write.md'), 'utf8').includes('/desk-cleanup instructions'), true)

// The skill listing follows Claude Code's rules: off, user-invocable-only and
// disable-model-invocation are not listed, name-only lists the name alone, when_to_use is counted.
const RL = join(T, 'rl'); const HL = join(T, 'hl')
const skill = (n, extra = '') => put(join(HL, '.claude', 'skills', n, 'SKILL.md'), `---\nname: ${n}\ndescription: Does ${n}.\n${extra}---\n\nBody.\n`)
skill('named'); skill('hidden'); skill('quiet'); skill('manual', 'disable-model-invocation: true\n'); skill('timed', 'when_to_use: When timing.\n'); skill('plain')
put(join(HL, '.claude', 'settings.json'), JSON.stringify({ skillOverrides: { named: 'name-only', hidden: 'off', quiet: 'on' } }))
put(join(RL, '.claude', 'settings.local.json'), JSON.stringify({ skillOverrides: { quiet: 'user-invocable-only' } }))
const listed = launchFiles({ root: RL, home: HL }).filter((x) => x.kind === 'skill')
t('listing: off, user-invocable-only (local settings win) and disable-model-invocation are left out', listed.map((x) => x.name).join(','), 'named,plain,timed')
t('listing: a name-only skill carries no description', auditReport(listed, { root: RL, home: HL }).find((l) => l.includes('· named ')).endsWith('· listed by name only'), true)
t('listing: when_to_use counts towards what is listed', listed.find((x) => x.name === 'timed').chars, 'Does timed. When timing.'.length)

// A CRLF file's headings are still found.
t('sections: CRLF headings are found', sections(linesOf('## One\r\nx\r\n## Two\r\ny\r\n')).map((s) => s.heading).join(','), 'One,Two')

// A move never lands on an existing rule or skill, nor on .claude/CLAUDE.md, which loads at launch.
for (const d of ['a', 'b', '.claude/rules', '.claude/skills/testing']) mkdirSync(join(RL, d), { recursive: true })
put(join(RL, '.claude', 'rules', 'data-layer.md'), '# Existing\n')
const rowL = { path: join(RL, 'CLAUDE.md') }; const used = new Set()
t('targetFor: an existing rule is not appended to', targetFor({ heading: 'Data layer' }, 'Touches `a/` and `b/`.', rowL, RL, HL, used).path, join(RL, '.claude', 'rules', 'data-layer-2.md'))
t('targetFor: nor is a rule another move already took', targetFor({ heading: 'Data layer' }, 'Touches `a/` and `b/`.', rowL, RL, HL, used).path, join(RL, '.claude', 'rules', 'data-layer-2-2.md'))
t('targetFor: an existing skill is not appended to', targetFor({ heading: 'Testing' }, 'No paths here.', rowL, RL, HL, used).path, join(RL, '.claude', 'skills', 'testing-2', 'SKILL.md'))
const dotClaude = targetFor({ heading: 'Tooling' }, 'Edit `.claude/rules/` and `.claude/skills/`.', rowL, RL, HL, used)
t('targetFor: text naming only .claude/ goes to a scoped rule, not .claude/CLAUDE.md', `${dotClaude.kind} ${dotClaude.body.slice(1, 4).join(' ')}`, 'path-scoped rule paths:   - ".claude/rules/**"   - ".claude/skills/**"')
mkdirSync(join(RL, '.claude', 'rules', 'web'), { recursive: true })
const inRules = targetFor({ heading: 'Web rules' }, 'Edit `.claude/rules/web/`.', rowL, RL, HL, used)
t('targetFor: text naming only a folder under .claude/rules goes to a scoped rule, not a CLAUDE.md there', `${inRules.kind} ${inRules.body[2]}`, 'path-scoped rule   - ".claude/rules/web/**"')

// when_to_use is listed with the description, so it moves into the body with the rest of it.
const RW = join(T, 'rw'); const HW = join(T, 'hw')
put(join(HW, '.claude', 'skills', 'wordy', 'SKILL.md'), `---\nname: wordy\ndescription: Does wordy things.\nwhen_to_use: ${'Often. '.repeat(160).trim()}\n---\n\n# wordy\n`)
const wordy = auditReport(launchFiles({ root: RW, home: HW }).filter((x) => x.kind === 'skill'), { root: RW, home: HW })
t('when_to_use: a skill over the cap only by its when_to_use moves it into the body', wordy.filter((l) => l.startsWith('propose : ')).join('\n'), `propose : ~/.claude/skills/wordy/SKILL.md · "when_to_use" (${'Often. '.repeat(160).trim().length} chars) → the skill body, which loads only when it runs`)
t('when_to_use: the diff drops the field and adds it under ## When to use', wordy.includes(`-when_to_use: ${'Often. '.repeat(160).trim()}`) && wordy.includes('+## When to use') && wordy.includes(`+${'Often. '.repeat(160).trim()}`), true)

// An @ import loads with its parent, so its lines count towards the parent's cap.
const RI = join(T, 'ri')
put(join(RI, 'CLAUDE.md'), ['## Kept', ...fill(149, 'kept'), '', '@more.md', ''].join('\n'))
put(join(RI, 'more.md'), `${fill(100, 'more').join('\n')}\n`)
const withImport = auditReport(launchFiles({ root: RI, home: join(T, 'hi') }), { root: RI, home: join(T, 'hi') })
t('imports: a file under the cap alone is over it with its imports', withImport.some((l) => /^launch : CLAUDE\.md +· CLAUDE\.md · .* · 152 lines · over cap 200 lines with its imports \(252\)$/.test(l)), true)
t('imports: the import itself is not flagged on its own lines', withImport.some((l) => /^launch : import +· more\.md · .* · 100 lines · loads with CLAUDE\.md/.test(l)), true)

if (fails) { console.log(`FAIL: ${fails} checks failed`); process.exit(1) }
