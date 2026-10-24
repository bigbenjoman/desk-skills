#!/usr/bin/env node
// The scripted half of desk-cleanup: the same reading every run, rather than prose re-derived by hand
// across dozens of worktrees. Two subcommands only read; `remove` acts on the paths it is given.
//
//   node cleanup-scan.mjs worktrees --repo <root> --author <§1 handle> [--default <branch>]
//        [--worktrees-dir <§2 dir>] [--key-pattern <§4 Ticket key pattern>] [--prs <file>] [--no-fetch]
//   node cleanup-scan.mjs remove --repo <root> --backups <§2 Backups directory> [--allow-untracked] <path>...
//   node cleanup-scan.mjs memory [--repo <root>] [--worktrees-dir <dir>] [--ports <3500-3600,6006>]
//   node cleanup-scan.mjs key-filter <TICKET>        gh pr list --json … on stdin, whole-key matches out
//
// `worktrees` prints one TSV row per worktree: verdict path branch ticket tip pr author reason
// untracked extras. `extras` are ignored files that are not build output (SPEC.md, a resume file):
// `git worktree remove` deletes those without a word, so `remove` copies them to the backups first.
//
// Test inputs, read instead of the live machine: --prs <gh pr list JSON>, --proc <`lsof -d cwd
// -Fpcn` output>, --ps <`ps -Ao pid=,rss=,etime=,args=` output>, --listen <`lsof -iTCP -sTCP:LISTEN
// -Fpn` output>, --watchman <`watchman watch-list` JSON>.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, readdirSync, statSync, mkdirSync, cpSync, rmSync, appendFileSync } from 'node:fs'
import { homedir, totalmem, freemem, platform } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---- pure parts (exported for tests/test_cleanup.mjs) ----------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A ticket key as a whole id: no letter or digit before it, no digit or `-<digit>` after it, so
// ABC-1 is not ABC-12 or ABC-1-2, and BUG-119 is not BUG-119-5. Case-insensitive (branches are
// lower-case), never looser.
export function keyMatches(text, key) {
  return new RegExp(`(^|[^A-Z0-9])${escapeRe(key.toUpperCase())}(?![0-9]|-[0-9])`).test(String(text).toUpperCase())
}

// The PRs from `gh pr list --json title,headRefName,…` that carry the key in their title or head branch.
export const prsForKey = (prs, key) => prs.filter((p) => keyMatches(`${p.title ?? ''} ${p.headRefName ?? ''}`, key))

// The ticket a branch is for: the first §4 Ticket key pattern match that is a whole key.
export function ticketOf(branch, pattern) {
  if (!pattern || pattern === 'none') return ''
  for (const m of String(branch).matchAll(new RegExp(pattern, 'gi'))) if (keyMatches(branch, m[0])) return m[0].toUpperCase()
  return ''
}

// `git worktree list --porcelain`, the main worktree first.
export function parseWorktrees(out) {
  return out.split(/\n\n+/).filter((b) => b.trim()).map((block) => {
    const w = { path: '', head: '', branch: '(detached)', locked: false, prunable: false }
    for (const l of block.split('\n')) {
      if (l.startsWith('worktree ')) w.path = l.slice(9)
      else if (l.startsWith('HEAD ')) w.head = l.slice(5)
      else if (l.startsWith('branch ')) w.branch = l.slice(7).replace(/^refs\/heads\//, '')
      else if (l === 'locked' || l.startsWith('locked ')) w.locked = true
      else if (l === 'prunable' || l.startsWith('prunable ')) w.prunable = true
    }
    return w
  })
}

// `git status --porcelain=v1 -z`: tracked changes counted, untracked (??) and ignored (!!) listed.
export function parseStatus(z) {
  const parts = z.split('\0'); const s = { tracked: 0, untracked: [], ignored: [] }
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]; if (e.length < 4) continue
    const xy = e.slice(0, 2), path = e.slice(3)
    if (xy === '??') s.untracked.push(path)
    else if (xy === '!!') s.ignored.push(path)
    else { s.tracked++; if (/[RC]/.test(xy)) i++ }
  }
  return s
}

// Ignored paths that something regenerates (installs, builds, caches, env files a copy-env step
// puts back). Anything else ignored is someone's work: SPEC.md, a plan, a scratch directory.
const REGEN = /(^|\/)(node_modules|\.next|\.turbo|dist|build|out|coverage|storybook-static|\.vercel|\.swc|test-results|playwright-report|cdk\.out|generated|_pagefind|__pycache__|\.pytest_cache|\.venv|venv|\.mypy_cache|\.ruff_cache|target)\/?$|(^|\/)\.env|(^|\/)\.DS_Store$|\.eslintcache$|\.tsbuildinfo$|next-env\.d\.ts$|\.pyc$|^\.claude\/agents\/?$/
export const isExtra = (p) => !REGEN.test(p)

// desk-ticket's resume file. It goes to <backups>/resume/, overwriting: the live file wins.
export const isResume = (p) => /^\.claude\/desk-ticket-[^/]+\.json$/.test(p)

// `lsof -d cwd -Fpcn` → [{pid, cmd, cwd}].
export function parseLsofCwd(out) {
  const rows = []; let pid = '', cmd = ''
  for (const l of out.split('\n')) {
    if (l[0] === 'p') pid = l.slice(1)
    else if (l[0] === 'c') cmd = l.slice(1)
    else if (l[0] === 'n' && pid) rows.push({ pid: Number(pid), cmd, cwd: l.slice(1) })
  }
  return rows
}
// Processes whose cwd is the worktree or inside it: dev servers usually sit in a package subdirectory.
export const procsInside = (cwds, wt) => cwds.filter((r) => r.cwd === wt || r.cwd.startsWith(`${wt}/`))

// The PR a branch's worktree is judged by: one at the local tip first, then any open, then merged.
export function prFor(prs, branch, tip) {
  const m = prs.filter((p) => p.headRefName === branch)
  const pick = m.find((p) => p.headRefOid === tip) ?? m.find((p) => p.state === 'OPEN') ?? m.find((p) => p.state === 'MERGED') ?? m[0]
  return { pr: pick ?? null, open: m.filter((p) => p.state === 'OPEN').length }
}

// One worktree's verdict from facts already read. `git(...)` answers ancestry questions:
// ancestor(a, b) and mergeBase(a, b) → boolean. Two signals or no SAFE: the PR (merged, the
// user's) and the content (in the default branch, or the local tip is the head, or behind the head,
// of a PR that merged into the default branch; a PR stacked on another branch proves nothing).
export function classify(f, git) {
  const { pr, open } = f
  const prCol = pr ? `#${pr.number} ${pr.state}` : ''
  const author = pr?.author?.login ?? ''
  const v = (verdict, reason) => ({ verdict, reason, pr: prCol, author })
  if (f.prunable || !f.exists) return v('PRUNE', 'directory gone; registry entry only')
  if (f.sessionInside) return v('KEEP', 'this session is inside it')
  if (f.locked) return v('KEEP', 'locked')
  if (f.procs.length) return v('KEEP', `live process: ${f.procs.map((p) => `${p.cmd}(${p.pid})`).join(',')}`)
  if (f.tracked) return v('KEEP', `${f.tracked} modified tracked files`)
  if (f.stash) return v('KEEP', 'has a stash')
  if (open) return v('KEEP', 'a PR on this branch is still open')
  if (!pr) {
    const where = String(f.ahead) === '0' ?`nothing beyond ${f.mainRef}` : `${f.ahead} commits not in ${f.mainRef} (${f.pushed ? 'pushed' : 'local only'})`
    return v('KEEP', `no PR, so no ownership or merge signal; ${where}`)
  }
  if (author !== f.author) return v('KEEP', "someone else's PR: report only")
  if (pr.state !== 'MERGED') return v('KEEP', 'PR closed unmerged: needs a decision')
  let ok = ''
  const intoDefault = pr.baseRefName === f.mainRef.replace(/^origin\//, '')
  if (git.ancestor(f.tip, f.mainRef)) ok = `PR merged; tip in ${f.mainRef}`
  else if (intoDefault && pr.headRefOid === f.tip) ok = 'PR merged; local tip is the PR head'
  else if (intoDefault && pr.headRefOid && git.ancestor(f.tip, pr.headRefOid)) ok = 'PR merged; local tip behind the PR head'
  else if (!intoDefault && git.mergeBase(f.tip, f.mainRef)) return v('CHECK', `PR merged into ${pr.baseRefName ?? 'an unknown base'}, not ${f.mainRef}: check its work reached the default branch`)
  else if (git.mergeBase(f.tip, f.mainRef)) return v('CHECK', 'PR merged; local tip differs from the PR head: run the squash check')
  else return v('KEEP', 'PR merged but no merge base: second signal unavailable')
  return f.untracked.some((u) => !isResume(u)) ? v('UNTRACKED', `${ok}; untracked files block removal`) : v('SAFE', ok)
}

// ---- memory ----------------------------------------------------------------------------------

const GiB = 1048576 // KiB
const gib = (kib) => `${(kib / GiB).toFixed(1)} GiB`
const exeOf = (args) => basename(String(args).split(/\s+/)[0] ?? '')

// `ps -Ao pid=,rss=,etime=,args=` → [{pid, rss, etime, args, exe}] (rss in KiB on both platforms).
export function parsePs(out) {
  return out.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map(([, pid, rss, etime, args]) => ({ pid: Number(pid), rss: Number(rss), etime, args, exe: exeOf(args) }))
}
// `lsof -nP -iTCP -sTCP:LISTEN -Fpn` → [{pid, port}].
export function parseListen(out) {
  const rows = []; let pid = 0
  for (const l of out.split('\n')) {
    if (l[0] === 'p') pid = Number(l.slice(1))
    else if (l[0] === 'n') { const m = /:(\d+)$/.exec(l); if (m && pid) rows.push({ pid, port: Number(m[1]) }) }
  }
  return rows.filter((r, i) => rows.findIndex((x) => x.pid === r.pid && x.port === r.port) === i)
}
// "3500-3600,6006" → a membership test.
export function portSet(spec) {
  const ranges = String(spec).split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.split('-').map(Number))
  return (p) => ranges.some(([lo, hi = lo]) => p >= lo && p <= hi)
}

const WATCHMAN_LARGE = 2 * GiB
// Leak thresholds from step 5's baselines in references/step-5-memory.md (one machine; re-measure before trusting them).
const LEAKS = [[/next/, 2.5 * GiB, 'next >2.5 GiB'], [/storybook/, 1.5 * GiB, 'storybook >1.5 GiB']]

// The worktree a cwd belongs to: the longest registered prefix, else `GONE:<dir>` when it sits in a
// worktrees directory whose entry no longer exists, else `-`.
export function ownerOf(cwd, worktrees, dirs) {
  const w = [...worktrees].sort((a, b) => b.length - a.length).find((p) => cwd === p || cwd.startsWith(`${p}/`))
  if (w) return w
  for (const d of dirs) if (cwd.startsWith(`${d}/`)) return `GONE:${d}/${cwd.slice(d.length + 1).split('/')[0]}`
  return '-'
}

// The memory report from inputs already read: every line but the RAM totals, Docker and disk.
export function memoryReport({ ps, cwds, listen, ports, worktrees = [], dirs = [], watchRoots = null, exists = existsSync }) {
  const cwdOf = new Map(cwds.map((r) => [r.pid, r.cwd]))
  const own = (pid) => (cwdOf.has(pid) ? ownerOf(cwdOf.get(pid), worktrees, dirs) : '-')
  const out = []
  out.push('== Top 15 processes by RSS')
  for (const p of [...ps].sort((a, b) => b.rss - a.rss).slice(0, 15)) out.push(`${String(p.pid).padEnd(7)} ${gib(p.rss).padEnd(10)} ${p.etime.padEnd(12)} ${p.exe.slice(0, 28).padEnd(28)} ${own(p.pid)}`)

  out.push('', `== Dev servers (ports ${ports})`)
  const inPorts = portSet(ports); const byPid = new Map(ps.map((p) => [p.pid, p]))
  const servers = listen.filter((l) => inPorts(l.port)).sort((a, b) => a.port - b.port)
  if (!servers.length) out.push('none')
  for (const s of servers) {
    const p = byPid.get(s.pid) ?? { rss: 0, etime: '?', args: '?' }; const w = own(s.pid)
    const flags = LEAKS.filter(([re, kib]) => re.test(p.args) && p.rss > kib).map(([, , f]) => `LEAK? ${f}`)
    if (w.startsWith('GONE:')) flags.push('worktree deleted')
    out.push(`:${String(s.port).padEnd(5)} pid ${String(s.pid).padEnd(7)} ${gib(p.rss).padEnd(9)} up ${p.etime}${flags.length ? `  [${flags.join('; ')}]` : ''}`, `        ${p.args.slice(0, 90)} · ${w}`)
  }

  const claude = ps.filter((p) => p.exe === 'claude')
  out.push('', '== Claude sessions', `${claude.length} sessions · ${gib(claude.reduce((s, p) => s + p.rss, 0))} (each also carries ~300 MB of MCP servers)`)
  for (const p of claude) out.push(`  pid ${String(p.pid).padEnd(7)} ${gib(p.rss).padEnd(9)} up ${p.etime.padEnd(11)} ${cwdOf.get(p.pid) ?? '?'}`)

  // On the executable, never a pgrep -f: a shell wrapper or a worker's briefing carries the words too.
  const tests = ps.filter((p) => p.exe === 'node' && /jest-worker|vitest|playwright test/.test(p.args))
  out.push('', '== Test runs in flight (transient: re-measure after they exit)')
  out.push(...(tests.length ? tests.slice(0, 10).map((p) => `  pid ${p.pid} ${gib(p.rss)} up ${p.etime}`) : ['  none']))

  // Watchman belongs to no worktree and no session, so no other check here ever reaches it.
  const wm = ps.filter((p) => p.exe === 'watchman')
  out.push('', '== Watchman')
  if (!wm.length) out.push('not running')
  for (const p of wm) out.push(`pid ${p.pid} · ${gib(p.rss)} up ${p.etime}${p.rss > WATCHMAN_LARGE ? `  [LARGE >${gib(WATCHMAN_LARGE)}: watchman shutdown-server reclaims it unless a test run is in flight${tests.length ? ' (one is)' : ''}]` : ''}`)
  if (wm.length && watchRoots === null) out.push('  roots: unknown (watchman watch-list did not answer)')
  for (const r of watchRoots ?? []) out.push(`  watching ${r}${exists(r) ? '' : '  [GONE: watchman watch-del]'}`)
  return out
}

// ---- the live machine ------------------------------------------------------------------------

function die(msg, code = 2) { console.error(`cleanup-scan: ${msg}`); process.exit(code) }
function args(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { o._.push(a); continue }
    const k = a.slice(2)
    if (['no-fetch', 'allow-untracked', 'no-disk'].includes(k)) { o[k] = true; continue }
    const val = argv[++i]
    if (val === undefined || val.startsWith('--')) die(`${a} needs a value`)
    o[k] = val
  }
  return o
}
const expand = (p) => (p ? resolve(String(p).replace(/^~(?=\/|$)/, homedir())) : p)
const real = (p) => { try { return realpathSync(p) } catch { return p } }
const read = (f) => { try { return readFileSync(f, 'utf8') } catch (e) { die(`cannot read ${f}: ${e.message}`) } }
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 })
const gitOut = (cwd, ...a) => { const r = git(cwd, ...a); return r.status === 0 ? r.stdout.trim() : null }

// lsof exits 1 when some process could not be read, with good output beside it; only a missing
// lsof is fatal, because "no process found" there would read as "nothing running".
function lsof(argv) {
  const r = spawnSync('lsof', argv, { encoding: 'utf8', maxBuffer: 1 << 28 })
  if (r.error) die(`lsof is not available (${r.error.code}); the live-process check cannot run`)
  return r.stdout
}
const cwdsFrom = (o) => parseLsofCwd(o.proc ? read(o.proc) : lsof(['-nP', '-d', 'cwd', '-Fpcn']))

function rootOf(repo) {
  const common = gitOut(expand(repo ?? '.'), 'rev-parse', '--path-format=absolute', '--git-common-dir')
  if (!common) die(`not a git repo: ${repo ?? process.cwd()}`)
  return { root: real(dirname(common)), common: real(common) }
}
function statusOf(path) {
  const r = git(path, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching')
  return r.status === 0 ? parseStatus(r.stdout) : null
}
// Resume files are found directly as well: a wholly ignored `.claude/` shows as one directory entry.
function resumeFiles(path, st) {
  const dir = join(path, '.claude'); let names = []
  try { names = readdirSync(dir) } catch { /* no .claude */ }
  const found = names.map((n) => `.claude/${n}`).filter(isResume)
  return [...new Set([...found, ...[...st.untracked, ...st.ignored].filter(isResume)])]
}

function scanWorktrees(o) {
  if (!o.author) die('worktrees needs --author <§1 GitHub handle>: the ownership test depends on it')
  const { root, common } = rootOf(o.repo)
  if (!o['no-fetch'] && git(root, 'fetch', 'origin', '--prune', '--quiet').status !== 0) console.error('warn: fetch failed: origin may be stale, and merged work can read as unmerged')
  if (gitOut(root, 'rev-parse', '--is-shallow-repository') === 'true') die(`shallow clone: run git -C ${root} fetch origin --unshallow`, 3)
  const def = o.default ?? (gitOut(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD') ?? 'origin/main').replace(/^origin\//, '')
  const mainRef = `origin/${def}`
  if (!gitOut(root, 'rev-parse', '--verify', '--quiet', mainRef)) die(`${mainRef} does not exist here`)

  let prs = []
  if (o.prs) prs = JSON.parse(read(o.prs))
  else {
    const r = spawnSync('gh', ['pr', 'list', '--state', 'all', '--limit', '2000', '--json', 'number,state,headRefName,headRefOid,baseRefName,author'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
    if (r.status !== 0) console.error('warn: gh pr list failed: no PR signal, so nothing reads SAFE')
    else prs = JSON.parse(r.stdout)
  }
  const cwds = cwdsFrom(o)
  const here = real(process.cwd())
  const stashes = gitOut(root, 'stash', 'list') ?? ''
  const ancestry = {
    ancestor: (a, b) => git(root, 'merge-base', '--is-ancestor', a, b).status === 0,
    mergeBase: (a, b) => git(root, 'merge-base', a, b).status === 0,
  }

  const list = parseWorktrees(gitOut(root, 'worktree', 'list', '--porcelain') ?? '').slice(1)
  const rows = [['verdict', 'path', 'branch', 'ticket', 'tip', 'pr', 'author', 'reason', 'untracked', 'extras']]
  const registered = new Set([root])
  for (const w of list) {
    const path = real(w.path); registered.add(path)
    const exists = existsSync(path)
    const st = exists ? statusOf(path) : null
    const { pr, open } = prFor(prs, w.branch, w.head)
    const resume = st ? resumeFiles(path, st) : []
    const untracked = st?.untracked ?? []
    const extras = st ? [...new Set([...st.ignored.filter(isExtra), ...resume.filter((r) => !untracked.includes(r))])] : []
    const ahead = gitOut(root, 'rev-list', '--count', `${mainRef}..${w.head}`) ?? '?'
    const pushed = !!(gitOut(root, 'for-each-ref', '--contains', w.head, '--count=1', '--format=x', 'refs/remotes') ?? '')
    const facts = {
      ...w, exists, mainRef, author: o.author, pr, open, tip: w.head, ahead, pushed,
      sessionInside: here === path || here.startsWith(`${path}/`),
      procs: exists ? procsInside(cwds, path) : [],
      tracked: st ? st.tracked : 0,
      stash: stashes.split('\n').some((l) => l.includes(`WIP on ${w.branch}:`) || l.includes(`On ${w.branch}:`)),
      untracked,
    }
    if (exists && !st) { rows.push(['KEEP', path, w.branch, ticketOf(w.branch, o['key-pattern']), w.head.slice(0, 10), '', '', 'git status failed', '', '']); continue }
    const c = classify(facts, ancestry)
    rows.push([c.verdict, path, w.branch, ticketOf(w.branch, o['key-pattern']), w.head.slice(0, 10), c.pr, c.author || '-', c.reason, untracked.join(','), extras.join(',')])
  }

  // Orphans: on disk in a worktrees directory, not registered. A directory whose `.git` names
  // another repo's gitdir is that repo's worktree, not an orphan of this one.
  const dirs = [join(root, '.claude', 'worktrees'), o['worktrees-dir'] && expand(o['worktrees-dir'])].filter(Boolean)
  const seen = new Set()
  for (const d of dirs) {
    let names = []; try { names = readdirSync(d) } catch { continue }
    for (const n of names.sort()) {
      const p = real(join(d, n))
      if (seen.has(p) || registered.has(p) || !statSync(p, { throwIfNoEntry: false })?.isDirectory()) continue
      seen.add(p)
      let gitdir = ''
      try { gitdir = /^gitdir: (.*)$/m.exec(readFileSync(join(p, '.git'), 'utf8'))?.[1] ?? '' } catch { /* no .git file */ }
      if (gitdir && !real(dirname(dirname(resolve(p, gitdir)))).startsWith(common)) continue
      rows.push(['ORPHAN', p, '-', ticketOf(n, o['key-pattern']), '-', '-', '-', 'on disk, not registered: inspect before rm -rf (Orphaned worktree directories)', '', ''])
    }
  }
  for (const r of rows) console.log(r.join('\t'))
}

function removeWorktrees(o) {
  if (!o.backups) die('remove needs --backups <§2 Backups directory>')
  if (!o._.length) die('remove needs the approved worktree paths')
  const { root } = rootOf(o.repo)
  const backups = expand(o.backups)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const run = join(backups, 'worktree-extras', stamp)
  const cwds = cwdsFrom(o)
  const registered = new Set(parseWorktrees(gitOut(root, 'worktree', 'list', '--porcelain') ?? '').map((w) => real(w.path)))
  const df = () => Number(execFileSync('df', ['-k', root], { encoding: 'utf8' }).trim().split('\n').pop().split(/\s+/)[3])
  const before = df(); let removed = 0
  const hasWatchman = spawnSync('watchman', ['--no-spawn', '--version'], { stdio: 'ignore' }).status === 0

  for (const given of o._) {
    const wt = real(expand(given).replace(/\/$/, ''))
    // Everything is re-read here: state moves between the scan and the approval.
    if (wt === root) { console.log(`SKIP  ${wt}: the main worktree`); continue }
    if (!registered.has(wt)) { console.log(`SKIP  ${wt}: not a registered worktree`); continue }
    const st = statusOf(wt)
    if (!st) { console.log(`SKIP  ${wt}: git status failed`); continue }
    if (st.tracked) { console.log(`SKIP  ${wt}: modified tracked files now`); continue }
    const resume = resumeFiles(wt, st)
    const others = st.untracked.filter((u) => !isResume(u))
    if (others.length && !o['allow-untracked']) { console.log(`SKIP  ${wt}: untracked files (${others.join(', ')}); approve them, then --allow-untracked`); continue }
    const procs = procsInside(cwds, wt)
    if (procs.length) { console.log(`SKIP  ${wt}: a process is running inside it now (${procs.map((p) => `${p.cmd}(${p.pid})`).join(', ')})`); continue }

    const tip = gitOut(wt, 'rev-parse', 'HEAD'); const br = gitOut(wt, 'symbolic-ref', '--short', '-q', 'HEAD') ?? 'detached'
    const copies = [...new Set([...resume, ...st.ignored.filter(isExtra), ...st.untracked])]
    const copied = []; let failed = ''
    // One directory per worktree, never shared: two worktrees can have the same basename (one under
    // .claude/worktrees, one in the worktrees directory), and the first's originals are gone by the
    // time the second copies.
    let slot = basename(wt)
    for (let n = 2; existsSync(join(run, slot)); n++) slot = `${basename(wt)}-${n}`
    for (const f of copies) {
      const src = join(wt, f.replace(/\/$/, ''))
      const dest = isResume(f) ? join(backups, 'resume', basename(f)) : join(run, slot, f.replace(/\/$/, ''))
      try { mkdirSync(dirname(dest), { recursive: true }); cpSync(src, dest, { recursive: true, force: true }); copied.push(`${f} -> ${dest}`) } catch (e) { failed = `${f}: ${e.message}`; break }
    }
    if (failed) { console.log(`SKIP  ${wt}: a backup copy failed (${failed}); nothing removed`); continue }
    for (const c of copied) console.log(`      copied ${c}`)
    // Only what git would refuse on. Ignored files are left for `git worktree remove`, now backed up.
    for (const u of st.untracked) rmSync(join(wt, u), { recursive: true, force: true })

    const r = git(root, 'worktree', 'remove', wt)
    if (r.status !== 0) { console.log(`FAIL  ${wt}: git refused (${r.stderr.trim().split('\n')[0]}); left in place`); continue }
    removed++
    mkdirSync(run, { recursive: true }); appendFileSync(join(run, 'restore.tsv'), `${wt}\t${br}\t${tip}\n`)
    // --no-spawn: a stopped watchman has no watch to drop, and must not be started to drop one.
    if (hasWatchman) spawnSync('watchman', ['--no-spawn', 'watch-del', wt], { stdio: 'ignore' })
    console.log(`DONE  ${wt}  (${br} @ ${tip.slice(0, 10)})`)
  }
  git(root, 'worktree', 'prune')
  const delta = (df() - before) / GiB
  console.log(`removed ${removed} · df free change ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} GiB`)
  if (existsSync(join(run, 'restore.tsv'))) console.log(`restore log: ${join(run, 'restore.tsv')}  (git worktree add <path> <tip>)`)
}

function scanMemory(o) {
  const r = o.repo || existsSync('.git') ? gitOut(expand(o.repo ?? '.'), 'rev-parse', '--path-format=absolute', '--git-common-dir') : null
  const root = r ? real(dirname(r)) : ''
  const worktrees = root ? parseWorktrees(gitOut(root, 'worktree', 'list', '--porcelain') ?? '').map((w) => real(w.path)) : []
  const dirs = [root && join(root, '.claude', 'worktrees'), o['worktrees-dir'] && real(expand(o['worktrees-dir']))].filter(Boolean)
  const ps = parsePs(o.ps ? read(o.ps) : execFileSync('ps', ['-Ao', 'pid=,rss=,etime=,args='], { encoding: 'utf8', maxBuffer: 1 << 28 }))
  const cwds = cwdsFrom(o)
  const listen = parseListen(o.listen ? read(o.listen) : lsof(['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']))
  let watchRoots = null
  if (o.watchman) watchRoots = JSON.parse(read(o.watchman)).roots ?? []
  else if (ps.some((p) => p.exe === 'watchman')) {
    const w = spawnSync('watchman', ['watch-list'], { encoding: 'utf8', timeout: 10000 })
    try { watchRoots = JSON.parse(w.stdout).roots ?? [] } catch { /* unknown */ }
  }

  const fixtures = o.ps || o.proc || o.listen
  if (!fixtures) {
    console.log('== RAM', `total      : ${gib(totalmem() / 1024)}`)
    if (platform() === 'darwin') {
      const mp = spawnSync('memory_pressure', [], { encoding: 'utf8' }).stdout?.trim().split('\n').pop() ?? '?'
      console.log(`free       : ${mp.replace(/.*: /, '')}`, `\nswap       : ${spawnSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }).stdout?.trim()}`)
    } else {
      const avail = /MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1]
      console.log(`available  : ${avail ? gib(Number(avail)) : gib(freemem() / 1024)}`)
    }
    console.log('')
  }
  console.log(memoryReport({ ps, cwds, listen, ports: o.ports ?? '3000-3999', worktrees, dirs, watchRoots }).join('\n'))
  if (fixtures) return

  const docker = spawnSync('docker', ['stats', '--no-stream', '--format', '  {{.Name}}\t{{.MemUsage}}'], { encoding: 'utf8', timeout: 20000 })
  if (docker.status === 0) console.log('\n== Docker\n' + (docker.stdout.trimEnd() || '  no containers'))
  if (o['no-disk']) return
  console.log('\n== Disk')
  const df = execFileSync('df', ['-h', root || homedir()], { encoding: 'utf8' }).trim().split('\n').pop().split(/\s+/)
  console.log(`volume     : ${df[3]} free of ${df[1]} (${df[4]} used)`)
  const h = homedir()
  const caches = [root && join(root, '.turbo', 'cache'), root && join(root, 'node_modules', '.cache'), join(h, '.npm', '_cacache'), join(h, 'Library', 'Caches', 'pnpm'), join(h, '.cache', 'pnpm'), join(h, '.local', 'share', 'pnpm', 'store'), join(h, '.bun', 'install', 'cache'), join(h, 'Library', 'Caches', 'ms-playwright'), join(h, '.cache', 'ms-playwright')]
  for (const d of caches.filter((c) => c && existsSync(c))) {
    const du = spawnSync('du', ['-shx', d], { encoding: 'utf8', timeout: 60000 })
    console.log(`cache      : ${du.stdout?.split('\t')[0] || '?'}  ${d}`)
  }
}

function keyFilter(o) {
  const key = o._[0]
  if (!key) die('key-filter needs a ticket key')
  console.log(JSON.stringify(prsForKey(JSON.parse(readFileSync(0, 'utf8')), key), null, 2))
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const [cmd, ...rest] = process.argv.slice(2); const o = args(rest)
  const run = { worktrees: scanWorktrees, remove: removeWorktrees, memory: scanMemory, 'key-filter': keyFilter }[cmd]
  if (!run) die('usage: cleanup-scan.mjs worktrees|remove|memory|key-filter … (see the header)')
  run(o)
}
