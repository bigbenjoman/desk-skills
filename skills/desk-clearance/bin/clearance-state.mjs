#!/usr/bin/env node
// Derives the full state of every open studia-web PR authored by the user in one GraphQL call,
// classifies each into a lane, and writes ~/.desk-clearance/state.json. The traps live here,
// not in prose.
//
//   node clearance-state.mjs derive [--no-git] [--author <h>] [--repo <path>] [--merge-bar approved|gate]
//   node clearance-state.mjs render              re-render from disk
//   node clearance-state.mjs diff                what moved since the previous derive
//   node clearance-state.mjs capacity            how wide this box can fan out right now
//   node clearance-state.mjs corpus              every open human review comment, for theme mining
//   node clearance-state.mjs json                the raw state file path
//
// Every failure is loud. Nothing here ever defaults to a clean state, or to someone's identity.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { homedir, cpus, freemem, totalmem, loadavg, platform } from 'node:os'
import { join } from 'node:path'

const exec = promisify(execFile)
const OWNER = 'Sophos-Education'
const NAME = 'studia-web'
const DIR = join(homedir(), '.desk-clearance')
const STATE = join(DIR, 'state.json')
const PREV = join(DIR, 'state.prev.json')
const CONFIG = process.env.DESK_CONFIG || join(homedir(), '.claude', 'desk-config.md')

function die(msg) {
  console.error(`clearance-state: ${msg}`)
  process.exit(1)
}

const argOf = (flag) => {
  const i = process.argv.indexOf(flag)
  if (i === -1) return null
  const v = process.argv[i + 1]
  if (!v || v.startsWith('--')) die(`${flag} needs a value`)
  return v
}

// ---- config ---------------------------------------------------------------------------------
// Reads one row of a markdown table in desk-config.md by its first cell. `col` is the cell
// index to return; -1 means the last cell (section 3's "Your setting"). TODO reads as unset.
let configText = null
function configRow(label, col = 1) {
  if (configText === null) {
    try { configText = readFileSync(CONFIG, 'utf8') } catch { configText = '' }
  }
  // Section 3 rows are keyed (`pr-merge-green`); other sections by field name. An exact key wins over
  // a prefix, so `jira-close` never reads `jira-close-own-merged`.
  const want = label.toLowerCase()
  const cellValue = (cells) => {
    const raw = cells[col < 0 ? cells.length + col : col] ?? ''
    const value = raw.replace(/`/g, '').trim().split(/\s+[—-]\s+/)[0].trim()
    return !value || /^todo\b/i.test(value) ? null : value
  }
  let prefix
  for (const line of configText.split('\n')) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 2) continue
    const first = cells[0].replace(/\*\*/g, '').replace(/`/g, '').toLowerCase()
    if (first === want) return cellValue(cells)
    if (prefix === undefined && first.startsWith(want)) prefix = cellValue(cells)
  }
  return prefix ?? null
}
const expandHome = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

// ---- identity -------------------------------------------------------------------------------
// --author -> DESK_GH_HANDLE -> config section 1 "GitHub handle" -> `gh api user`. Never a
// default: an empty or wrong handle turns "my PRs" into everyone's, and this script's whole
// ownership boundary rests on it.
async function resolveAuthor() {
  const sources = [
    ['--author', argOf('--author')],
    ['DESK_GH_HANDLE', process.env.DESK_GH_HANDLE],
    [`${CONFIG} section 1 "GitHub handle"`, configRow('GitHub handle')],
  ]
  for (const [src, v] of sources) {
    if (v && v.trim()) return validHandle(v.trim(), src)
  }
  try {
    const { stdout } = await exec('gh', ['api', 'user', '--jq', '.login'])
    return validHandle(stdout.trim(), 'gh api user')
  } catch (e) {
    die(`cannot resolve the PR author: no --author, no DESK_GH_HANDLE, no GitHub handle in ${CONFIG}, and gh api user failed (${(e.stderr || e.message).slice(0, 200)}). Run /desk-setup.`)
  }
}
function validHandle(h, src) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(h)) die(`GitHub handle from ${src} is not a valid login: "${h}"`)
  return h
}

// git behind-counts and ancestry need a checkout: --repo -> config section 2 "Primary repo root".
function resolveRepo() {
  const v = argOf('--repo') || configRow('Primary repo root')
  const p = expandHome(v)
  if (!p) die(`no repo path: pass --repo <studia-web checkout>, set "Primary repo root" in ${CONFIG}, or use --no-git`)
  if (!existsSync(join(p, '.git'))) die(`${p} is not a git checkout (from --repo or config section 2)`)
  return p
}

// Which bar a merge must clear, beyond the ruleset. Config section 3 `pr-merge-green`: `yes` or
// `ask` means the green required checks are the bar; anything else, TODO included, means a formal
// APPROVED review is required too and nothing is merged. The ruleset itself is never loosened.
function resolveMergeBar() {
  const flag = argOf('--merge-bar')
  if (flag) {
    if (!['approved', 'gate'].includes(flag)) die('--merge-bar must be approved or gate')
    return { bar: flag, source: '--merge-bar' }
  }
  const row = configRow('pr-merge-green', -1)?.toLowerCase()
  return /^(yes|ask)\b/.test(row || '')
    ? { bar: 'gate', source: 'config section 3 pr-merge-green' }
    : { bar: 'approved', source: row ? 'config section 3 pr-merge-green' : 'config section 3 pr-merge-green unset - strict default' }
}
function mergePermission() {
  const row = (configRow('pr-merge-green', -1) || '').toLowerCase()
  return /^(yes|ask)\b/.exec(row)?.[1] ?? 'no'
}
// Config section 3 `merge-feedback-first`: only an explicit `no` lets a PR merge with feedback
// outstanding. TODO or missing is the strict default.
function feedbackFirst() {
  const row = (configRow('merge-feedback-first', -1) || '').toLowerCase()
  return { required: !/^no\b/.test(row), source: row ? 'config section 3 merge-feedback-first' : 'config section 3 merge-feedback-first unset - strict default' }
}

const BOT_LOGINS = new Set(['github-actions', 'vercel', 'chromatic', 'codecov', 'pullbot', 'dependabot'])
const isBot = (a) =>
  !a || a.__typename === 'Bot' || /\[bot\]$/.test(a.login || '') || BOT_LOGINS.has(a.login || '')

async function gh(args, { json = true } = {}) {
  try {
    const { stdout } = await exec('gh', args, { maxBuffer: 64 * 1024 * 1024 })
    return json ? JSON.parse(stdout) : stdout
  } catch (e) {
    die(`gh ${args.slice(0, 2).join(' ')} failed: ${(e.stderr || e.message).slice(0, 400)}`)
  }
}

// The required contexts come from the ruleset, never from a name remembered here. Check names
// change, and a stale name reads as "never green".
async function requiredChecks() {
  const rules = await gh(['api', `repos/${OWNER}/${NAME}/rules/branches/main`])
  if (!Array.isArray(rules)) die('rules/branches/main did not return a list')
  const names = rules
    .filter((r) => r.type === 'required_status_checks')
    .flatMap((r) => r.parameters?.required_status_checks || [])
    .map((c) => c.context)
    .filter(Boolean)
  if (!names.length) die('the main ruleset lists no required status check - verify by hand before trusting any "green"')
  return names
}

const QUERY = `query($q:String!){
  search(query:$q, type:ISSUE, first:60){
    issueCount
    nodes{ ... on PullRequest{
      number title url state isDraft baseRefName headRefName
      mergeable mergeStateStatus reviewDecision
      autoMergeRequest{ enabledAt mergeMethod }
      author{login}
      assignees(first:10){nodes{login}}
      commits(last:1){nodes{commit{ oid committedDate
        statusCheckRollup{ state contexts(first:100){ pageInfo{hasNextPage} nodes{
          ... on CheckRun{name conclusion status}
          ... on StatusContext{context state}
        }}}
      }}}
      reviews(last:30){nodes{author{login __typename} state submittedAt body}}
      reviewThreads(first:100){ totalCount nodes{isResolved isOutdated
        comments(first:1){nodes{author{login __typename} path line body}}}}
      comments(last:40){nodes{author{login __typename} createdAt body}}
      reviewRequests(first:10){nodes{requestedReviewer{... on User{login}}}}
    }}
  }
}`

async function derive({ withGit }) {
  const AUTHOR = await resolveAuthor()
  const REPO = withGit ? resolveRepo() : null
  const mergeBar = resolveMergeBar()
  const required = await requiredChecks()

  const data = await gh([
    'api', 'graphql',
    '-F', `q=repo:${OWNER}/${NAME} is:pr is:open author:${AUTHOR}`,
    '-f', `query=${QUERY}`,
  ])
  if (data.errors?.length) die(`GraphQL errors: ${JSON.stringify(data.errors).slice(0, 400)}`)
  const nodes = data?.data?.search?.nodes
  if (!Array.isArray(nodes)) die('no search.nodes in response - treat as failure, not as "no PRs"')
  if (nodes.length === 0) die(`0 open PRs returned for ${AUTHOR}. Verify by hand before believing it.`)
  if (data.data.search.issueCount > nodes.length) {
    die(`search returned ${nodes.length} of ${data.data.search.issueCount} PRs - raise the search page size rather than work a partial set`)
  }

  // Open PRs by anyone, so a stacked base can be identified as someone else's PR.
  const allOpen = await gh([
    'pr', 'list', '--repo', `${OWNER}/${NAME}`, '--state', 'open', '--limit', '500',
    '--json', 'number,headRefName,author',
  ])
  const byHead = new Map(allOpen.map((p) => [p.headRefName, p]))

  const prs = nodes.map((p) => classify(p, byHead, { AUTHOR, required, mergeBar }))

  if (withGit) await annotateGit(prs, REPO)
  await annotateRest(prs)
  overlaps(prs)
  await order(prs, withGit, REPO)

  mkdirSync(DIR, { recursive: true })
  // Keep the last derive so a loop can ask what actually changed rather than re-reading a table.
  if (existsSync(STATE)) writeFileSync(PREV, readFileSync(STATE, 'utf8'))
  const out = {
    derivedAt: new Date().toISOString(), repo: `${OWNER}/${NAME}`, author: AUTHOR,
    required, mergeBar, mergePermission: mergePermission(), feedbackFirst: feedbackFirst(), prs,
  }
  writeFileSync(STATE, JSON.stringify(out, null, 2))
  return out
}

// A review body or issue comment is outstanding until the author answers it: it counts only if newer
// than the author's last review, thread reply, comment or head commit. A missing timestamp counts.
// Unresolved threads are counted separately and block until resolved.
function outstandingFeedback(p, AUTHOR, isHuman) {
  const t = (s) => (s ? Date.parse(s) : NaN)
  const mine = (a) => a?.login === AUTHOR
  const reviews = p.reviews?.nodes || []
  const comments = p.comments?.nodes || []
  const answered = [
    t(p.commits?.nodes?.[0]?.commit?.committedDate),
    ...reviews.filter((r) => mine(r.author)).map((r) => t(r.submittedAt)),
    ...comments.filter((c) => mine(c.author)).map((c) => t(c.createdAt)),
  ].filter(Number.isFinite)
  const lastAnswer = answered.length ? Math.max(...answered) : -Infinity
  const open = (when) => !(Number.isFinite(t(when)) && t(when) < lastAnswer)
  return {
    reviewBodies: reviews.filter((r) => isHuman(r.author) && (r.body || '').trim() && open(r.submittedAt)),
    issueComments: comments.filter((c) => isHuman(c.author) && (c.body || '').trim() && open(c.createdAt)),
  }
}

function checkState(ctx, name) {
  const hits = ctx.filter((c) => (c.name || c.context) === name)
  if (!hits.length) return 'ABSENT'
  const norm = hits.map((c) => (c.status && c.status !== 'COMPLETED' ? 'PENDING' : c.conclusion || c.state || 'PENDING'))
  if (norm.includes('PENDING') || norm.includes('EXPECTED')) return 'PENDING'
  if (norm.every((s) => s === 'SUCCESS')) return 'SUCCESS'
  return norm.find((s) => s !== 'SUCCESS')
}

function classify(p, byHead, { AUTHOR, required, mergeBar }) {
  const isHuman = (a) => a && !isBot(a) && a.login !== AUTHOR
  const head = p.commits?.nodes?.[0]?.commit
  if (!head) die(`#${p.number}: no head commit in response`)

  // Verdict: last APPROVED/CHANGES_REQUESTED, ignoring every COMMENTED.
  const decisive = (p.reviews?.nodes || []).filter(
    (r) => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED',
  )
  const last = decisive[decisive.length - 1]
  const verdict = last?.state || 'NONE'
  const verdictBy = last?.author?.login || null

  // reviewDecision is a positive signal for CHANGES_REQUESTED only. Empty proves nothing:
  // required_approving_review_count is 0, so GitHub never computes APPROVED here.
  const rd = p.reviewDecision || ''
  const rdConflict = rd === 'CHANGES_REQUESTED' && verdict !== 'CHANGES_REQUESTED'

  const approvalCoversHead =
    verdict === 'APPROVED' && last?.submittedAt
      ? new Date(last.submittedAt) >= new Date(head.committedDate)
      : null

  const threadNodes = p.reviewThreads?.nodes || []
  const threadsTruncated = (p.reviewThreads?.totalCount ?? 0) > threadNodes.length
  const threads = threadNodes.filter((t) => !t.isResolved)
  const humanThreads = threads.filter((t) => isHuman(t.comments?.nodes?.[0]?.author))
  const { reviewBodies, issueComments } = outstandingFeedback(p, AUTHOR, isHuman)

  // Required checks, asserted positively per name - never inferred green from absence.
  const rollup = head.statusCheckRollup
  const ctx = rollup?.contexts?.nodes || []
  const contextsTruncated = !!rollup?.contexts?.pageInfo?.hasNextPage
  const gates = Object.fromEntries(required.map((n) => [n, checkState(ctx, n)]))
  const states = Object.values(gates)
  const gate = states.every((s) => s === 'SUCCESS') ? 'SUCCESS'
    : states.includes('ABSENT') ? 'ABSENT'
    : states.includes('PENDING') ? 'PENDING'
    : states.find((s) => s !== 'SUCCESS')
  const advisoryFailing = ctx
    .filter((c) => !required.includes(c.name || c.context))
    .filter((c) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(c.conclusion || c.state))
    .map((c) => `${c.name || c.context}:${c.conclusion || c.state}`)

  const baseIsMain = p.baseRefName === 'main'
  const basePR = byHead.get(p.baseRefName) || null
  const baseForeign = basePR && basePR.author?.login !== AUTHOR ? basePR.author.login : null

  const pr = {
    number: p.number, title: p.title, url: p.url,
    head: head.oid, headAt: head.committedDate,
    isDraft: p.isDraft, base: p.baseRefName, headRef: p.headRefName,
    baseIsMain, basePR: basePR?.number || null, baseForeignAuthor: baseForeign,
    mergeable: p.mergeable, mergeState: p.mergeStateStatus,
    autoMerge: !!p.autoMergeRequest,
    verdict, verdictBy, verdictAt: last?.submittedAt || null,
    reviewDecisionRaw: rd, rdConflict,
    approvalCoversHead,
    threads: humanThreads.length, threadsTruncated,
    threadFiles: [...new Set(humanThreads.map((t) => t.comments?.nodes?.[0]?.path).filter(Boolean))],
    reviewBodies: reviewBodies.length,
    issueComments: issueComments.length,
    reviewers: [...new Set(decisive.map((r) => r.author?.login).filter(Boolean))],
    pendingReviewers: (p.reviewRequests?.nodes || []).map((r) => r.requestedReviewer?.login).filter(Boolean),
    assignees: (p.assignees?.nodes || []).map((a) => a.login),
    gate, gates, contextsTruncated, advisoryFailing,
    stacked: null, behind: null, files: [], overlaps: [],
  }
  pr.feedback = pr.threads + pr.reviewBodies + pr.issueComments
  // Already in someone else's queue: assigned away from the author, or a re-review outstanding.
  pr.handedBack =
    (pr.assignees.length > 0 && !pr.assignees.includes(AUTHOR)) || pr.pendingReviewers.length > 0
  pr.waitingOn = pr.handedBack
    ? [...new Set([...pr.assignees.filter((a) => a !== AUTHOR), ...pr.pendingReviewers])].join(', ')
    : null
  Object.assign(pr, lane(pr, mergeBar.bar))
  return pr
}

function lane(pr, bar) {
  const park = []
  if (pr.isDraft) park.push('draft')
  if (!pr.baseIsMain) {
    park.push(
      pr.baseForeignAuthor
        ? `base is ${pr.baseForeignAuthor}'s PR #${pr.basePR} - not ours to land`
        : `base ${pr.base} is not main (no ruleset, no required check, ships nothing)`,
    )
  }
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') park.push('conflict')
  if (pr.gate === 'ABSENT') park.push('a required check never reported on head - check refs/pull/N/merge exists')
  if (!['SUCCESS', 'PENDING', 'ABSENT'].includes(pr.gate)) park.push(`required check ${pr.gate} - read it before any rerun`)
  if (pr.rdConflict) park.push('reviewDecision says CHANGES_REQUESTED but /reviews disagrees')
  if (pr.threadsTruncated) park.push('review thread list truncated - count by hand')
  if (pr.contextsTruncated) park.push('check list truncated - read required checks by hand')

  // A standing CHANGES_REQUESTED is refused by the ruleset whatever the bar: only the reviewer
  // clears it, by approving or dismissing.
  if (pr.verdict === 'CHANGES_REQUESTED') {
    park.push('CHANGES_REQUESTED standing - the ruleset refuses this, only the reviewer can clear it')
  } else if (bar === 'approved' && pr.verdict !== 'APPROVED') {
    // Strict bar. A COMMENTED review counts as a changes-request however warmly it reads: PRs
    // merged on that reading have had to be reverted, and nothing on the platform refuses it.
    park.push('no APPROVED review - a COMMENTED review is not an approval, work it and hand it back')
  }
  // Deliberately NOT a park reason: an approval that predates the current head. The ruleset has
  // dismiss_stale_reviews_on_push: false, and fixing that reviewer's own comments does not
  // invalidate their approval - merge rather than re-request review.

  const feedback = pr.feedback > 0
  const approved = pr.verdict === 'APPROVED'
  const lane = approved && feedback ? '3A' : !approved && feedback ? '3B' : approved ? '3C' : '3D'

  // Parking blocks the MERGE. It never blocks working the comments.
  return { lane, mergeBlocked: park.length > 0, parkReasons: park, worksComments: feedback }
}

async function annotateGit(prs, REPO) {
  try {
    await exec('git', ['fetch', '--prune', 'origin'], { cwd: REPO })
  } catch {
    console.error(`clearance-state: WARNING git fetch failed in ${REPO} - behind counts omitted`)
    return
  }
  await Promise.all(prs.map(async (pr) => {
    try {
      const { stdout } = await exec('git', [
        'rev-list', '--count', `origin/${pr.headRef}..origin/main`,
      ], { cwd: REPO })
      pr.behind = Number(stdout.trim())
    } catch { pr.behind = null }
  }))
}

// Files (paginated - gh api stops at 30 per page without saying so) and the stack field, which
// only REST exposes. A stacked PR refuses gh pr merge and --auto; it merges via merge-async.
async function annotateRest(prs) {
  await Promise.all(prs.map(async (pr) => {
    try {
      const { stdout } = await exec('gh', [
        'api', '--paginate', `repos/${OWNER}/${NAME}/pulls/${pr.number}/files?per_page=100`,
        '--jq', '.[].filename',
      ], { maxBuffer: 16 * 1024 * 1024 })
      pr.files = stdout.trim().split('\n').filter(Boolean)
    } catch { pr.files = null }
    try {
      const { stdout } = await exec('gh', [
        'api', `repos/${OWNER}/${NAME}/pulls/${pr.number}`, '--jq', '.stack // null',
      ])
      const s = stdout.trim()
      pr.stacked = s && s !== 'null' ? JSON.parse(s) : false
    } catch { pr.stacked = null }
    if (pr.files === null) { pr.files = []; pr.parkReasons.push('file list unreadable - overlap unknown'); pr.mergeBlocked = true }
  }))
}

// Pairwise file overlap. Transitive clustering is wrong here: A-B and B-C sharing files does
// not make A and C conflict, and chaining through registry files (i18n messages, barrel index,
// .env.example) merges the whole batch into one useless blob. Only the pair matters: before
// merging X, anything in overlaps[X] that landed since X's checks ran means update and re-run.
function overlaps(prs) {
  const skip = (f) =>
    f.startsWith('apps/studia-docs/content/') || f.endsWith('.mdx') || f === 'bun.lock'
  const src = new Map(prs.map((p) => [p.number, new Set(p.files.filter((f) => !skip(f)))]))
  for (const p of prs) {
    p.overlaps = prs
      .filter((q) => q.number !== p.number)
      .map((q) => ({ n: q.number, files: [...src.get(p.number)].filter((f) => src.get(q.number).has(f)) }))
      .filter((o) => o.files.length > 0)
      .sort((a, b) => b.files.length - a.files.length)
      .map((o) => ({ pr: o.n, shared: o.files.length, first: o.files[0] }))
  }
}

// Merge order. A base relationship is NOT the only way one PR swallows another: a branch can
// contain another PR's commits while being based on a third. Merging the container squashes the contained PR into main and GitHub auto-closes it,
// orphaning its unresolved threads on a closed PR. Detect by ancestry, not by base alone.
async function order(prs, withGit, REPO) {
  for (const p of prs) p.contains = []
  if (withGit) {
    await Promise.all(prs.flatMap((p) => prs.map(async (q) => {
      if (p.number === q.number) return
      try {
        await exec('git', ['merge-base', '--is-ancestor',
          `origin/${q.headRef}`, `origin/${p.headRef}`], { cwd: REPO })
        p.contains.push(q.number)
      } catch { /* not an ancestor, or a ref is missing */ }
    })))
  }
  for (const p of prs) {
    const base = p.basePR && prs.some((q) => q.number === p.basePR) ? [p.basePR] : []
    p.blockedBy = [...new Set([...base, ...p.contains])]
    p.wouldOrphan = p.contains
      .map((n) => prs.find((q) => q.number === n))
      .filter((q) => q && q.threads > 0)
      .map((q) => ({ pr: q.number, threads: q.threads }))
  }
}

function render(state) {
  const prs = [...state.prs].sort((a, b) => a.number - b.number)
  const pad = (v, n) => String(v ?? '').slice(0, n).padEnd(n)
  const barText = state.mergeBar.bar === 'gate'
    ? 'required checks green at head, no standing changes-request'
    : 'formal APPROVED review + required checks green at head'
  console.log(`# desk-clearance  ${state.derivedAt}  ${prs.length} open PRs by ${state.author}`)
  console.log(`  required checks (from the ruleset): ${state.required.join(', ')}`)
  console.log(`  merge bar: ${barText}  [${state.mergeBar.source}]`)
  const ff = state.feedbackFirst ?? { required: true, source: 'state predates the row - strict default' }
  console.log(`  merging permitted: ${state.mergePermission}  [config section 3 pr-merge-green]`)
  console.log(`  feedback before merging: ${ff.required ? 'required' : 'not required'}  [${ff.source}]\n`)
  console.log(`  ${pad('PR', 6)}${pad('LANE', 5)}${pad('VERDICT', 24)}${pad('T/RB/IC', 9)}${pad('GATE', 9)}${pad('BHND', 5)}${pad('MERGE', 10)}NOTE`)
  console.log('  ' + '-'.repeat(112))
  for (const p of prs) {
    const flags = [p.stacked ? 'STACKED(merge-async)' : '', p.autoMerge ? 'AUTO-MERGE ARMED' : ''].filter(Boolean).join(' ')
    const note = p.wouldOrphan.length
      ? `STOP: merging swallows ${p.wouldOrphan.map((o) => `#${o.pr} (${o.threads} open threads)`).join(', ')}`
      : p.mergeBlocked ? `PARK-MERGE: ${p.parkReasons.join('; ')}`
      : p.blockedBy.length ? `merges after #${p.blockedBy.join(', #')}`
      : p.handedBack && !p.worksComments ? `waiting on ${p.waitingOn}`
      : p.overlaps.length ? `overlaps #${p.overlaps.slice(0, 3).map((o) => o.pr).join(', #')}`
      : ''
    console.log('  ' +
      pad('#' + p.number, 6) + pad(p.lane, 5) +
      pad(p.verdict === 'NONE' ? '-' : `${p.verdict === 'APPROVED' ? 'APPROVED' : 'CHG-REQ'}:${p.verdictBy}`, 24) +
      pad(`${p.threads}/${p.reviewBodies}/${p.issueComments}`, 9) +
      pad(p.gate, 9) + pad(p.behind ?? '?', 5) + pad(p.mergeState, 10) + [flags, note].filter(Boolean).join('  '))
  }
  const by = (l) => prs.filter((p) => p.lane === l).map((p) => p.number)
  const list = (a) => (a.length ? a.map((n) => '#' + n).join(' ') : '(none)')
  console.log('')
  console.log('  3A approved + feedback outstanding  ' + list(by('3A')))
  console.log('  3B feedback outstanding, no approval ' + list(by('3B')))
  console.log('  3C approved, nothing outstanding     ' + list(by('3C')))
  console.log('  3D nothing outstanding, no approval  ' + list(by('3D')))
  const hb = prs.filter((p) => p.handedBack && !p.worksComments)
  console.log('     of which already handed back      ' + list(hb.map((p) => p.number)) +
              (hb.length ? '  - leave them alone' : ''))
  console.log('')
  // The merge list: nothing parked, no feedback left to work, required checks green at head,
  // and not waiting on another PR in the set.
  const ready = prs.filter((p) => !p.mergeBlocked && (!p.worksComments || state.feedbackFirst?.required === false) && p.gate === 'SUCCESS' && !p.blockedBy.length && !p.wouldOrphan.length)
  const mergeLabel = ['yes', 'ask'].includes(state.mergePermission)
    ? `MERGE NOW (serial lane${state.mergePermission === 'ask' ? ', ask first' : ''})`
    : 'READY - merging not permitted by config, report only'
  console.log('  WORK COMMENTS (fan out)  ' + list(prs.filter((p) => p.worksComments).map((p) => p.number)))
  console.log(`  ${mergeLabel.padEnd(24)} ` + list(ready.map((p) => p.number)))
  console.log('  PARK MERGE ONLY          ' + list(prs.filter((p) => p.mergeBlocked).map((p) => p.number)))
  const armed = prs.filter((p) => p.autoMerge && p.mergeState !== 'DIRTY')
  if (armed.length) console.log('  AUTO-MERGE ARMED, not DIRTY - going green merges these: ' + list(armed.map((p) => p.number)))
  const orph = prs.filter((p) => p.wouldOrphan.length)
  if (orph.length) {
    console.log('\n  DO NOT MERGE - would close another PR with open threads:')
    for (const p of orph) {
      for (const o of p.wouldOrphan) {
        console.log(`    #${p.number} contains #${o.pr}, which has ${o.threads} unresolved thread${o.threads > 1 ? 's' : ''}`)
      }
    }
  }
  const cont = prs.filter((p) => p.contains.length && !p.wouldOrphan.length)
  if (cont.length) {
    console.log('\n  merge order (one branch contains another):')
    for (const p of cont) console.log(`    #${p.contains.join(', #')} before #${p.number}`)
  }
  const ov = prs.filter((p) => p.overlaps.length)
  if (ov.length) {
    console.log('\n  file overlap - update + fresh required checks between merging any of these pairs:')
    const seen = new Set()
    for (const p of ov) for (const o of p.overlaps) {
      const k = [p.number, o.pr].sort().join('-')
      if (seen.has(k)) continue
      seen.add(k)
      console.log(`    #${p.number} <-> #${o.pr}  ${o.shared} file${o.shared > 1 ? 's' : ''}  ${o.first}`)
    }
  }
  console.log(`\n  state: ${STATE}`)
}

// What changed since the previous derive. This is the loop's wake-up test: act on a moved verdict
// or new feedback, never on `mergeable`, which flaps to UNKNOWN every time main moves.
function diff() {
  if (!existsSync(PREV)) die('no previous state - run derive twice before diffing')
  const prev = JSON.parse(readFileSync(PREV, 'utf8'))
  const a = new Map(prev.prs.map((p) => [p.number, p]))
  const b = JSON.parse(readFileSync(STATE, 'utf8'))
  const changes = []
  for (const p of b.prs) {
    const o = a.get(p.number)
    if (!o) { changes.push(`#${p.number} NEW  ${p.lane}  ${p.title.slice(0, 60)}`); continue }
    const d = []
    if (o.verdict !== p.verdict) d.push(`verdict ${o.verdict} -> ${p.verdict}`)
    if (o.feedback !== p.feedback) d.push(`feedback ${o.feedback} -> ${p.feedback}`)
    if (o.threads !== p.threads) d.push(`threads ${o.threads} -> ${p.threads}`)
    if ((o.gate ?? o.build) !== p.gate) d.push(`gate ${o.gate ?? o.build} -> ${p.gate}`)
    if (o.head !== p.head) d.push('head moved')
    if (o.lane !== p.lane) d.push(`lane ${o.lane} -> ${p.lane}`)
    if (d.length) changes.push(`#${p.number} ${d.join(', ')}`)
  }
  for (const [n, o] of a) {
    if (!b.prs.some((p) => p.number === n)) changes.push(`#${n} GONE (merged or closed) - was ${o.lane}`)
  }
  console.log(`# changes since ${prev.derivedAt}\n`)
  if (!changes.length) {
    console.log('  nothing actionable changed.')
    console.log('  A loop should go back to sleep here. Do not invent work.')
    return
  }
  for (const c of changes) console.log('  ' + c)
  console.log(`\n  ${changes.length} change${changes.length > 1 ? 's' : ''}. Anything touching verdict,`)
  console.log('  feedback or threads is worth a pass; a lone gate or head change usually is not.')
}

// What one subagent of each kind actually costs. Measured on this monorepo: BUILD is tsc + lint +
// specs, BROWSER a Chromium upload/screenshot profile, LIGHT an agent told to skip the build.
const AGENT_GB = { build: 3, browser: 1, light: 0.3 }

// Memory a new process can actually get. Linux: MemAvailable (MemFree ignores reclaimable page
// cache and understates headroom). macOS: free + inactive + speculative + purgeable pages from
// vm_stat. Anything else: os.freemem().
async function availableGB() {
  if (platform() === 'linux') {
    try {
      const kb = /MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))
      if (kb) return Number(kb[1]) / 1024 ** 2
    } catch {}
  }
  if (platform() === 'darwin') {
    try {
      const { stdout } = await exec('vm_stat')
      const size = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] || 4096)
      const pages = (k) => Number(new RegExp(`Pages ${k}:\\s+(\\d+)`).exec(stdout)?.[1] || 0)
      const free = pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')
      if (free > 0) return (free * size) / 1024 ** 3
    } catch {}
  }
  return freemem() / 1024 ** 3
}

// On WSL2 the guest advertises whatever .wslconfig granted, but VmmemWSL cannot grow past what the
// Windows host will give it, and the guest cannot see that limit. Sizing against the guest total
// has OOMed the whole VM and killed five running agents. The ceiling is declared on
// every platform: DESK_CLEARANCE_MEM_GB -> config section 3b "Memory ceiling for parallel work
// (GB)" -> 16 on WSL, physical RAM minus 8 elsewhere.
function isWsl() {
  const row = configRow('Running on WSL?')
  if (row) return row.toLowerCase() === 'yes'
  if (platform() !== 'linux') return false
  try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')) } catch { return false }
}
const WSL_DEFAULT_CEILING_GB = 16
function ceilingGB() {
  const declared = Number(process.env.DESK_CLEARANCE_MEM_GB)
  if (Number.isFinite(declared) && declared > 0) return { gb: declared, source: 'DESK_CLEARANCE_MEM_GB' }
  const cfg = Number((configRow('Memory ceiling for parallel work', -1) || '').match(/\d+(\.\d+)?/)?.[0])
  if (Number.isFinite(cfg) && cfg > 0) return { gb: cfg, source: 'config section 3b memory ceiling for parallel work' }
  if (isWsl()) return { gb: WSL_DEFAULT_CEILING_GB, source: 'WSL default ceiling - set it in config section 3b' }
  return { gb: Math.max(2, totalmem() / 1024 ** 3 - 8), source: 'physical RAM minus 8G - set it in config section 3b' }
}

// Recommend fan-out from what the box can do right now. ASSESS holds nothing local and scales
// with the queue; IMPLEMENT is bounded by tsc + lint + specs per worktree.
async function capacity(prs) {
  const cores = cpus().length
  const cap = ceilingGB()
  const avail = await availableGB()
  const usedGB = Math.max(0, Math.min(cap.gb, totalmem() / 1024 ** 3) - avail)
  const RESERVE_GB = 2
  const budgetGB = Math.max(0, cap.gb - usedGB - RESERVE_GB)
  const load = loadavg()[0]
  const byMem = Math.floor(budgetGB / AGENT_GB.build)
  const byCpu = Math.floor((cores - Math.ceil(load) - 2) / 2)
  const implement = Math.max(1, Math.min(byMem, byCpu, 12))
  const servers = Math.max(1, Math.min(Math.floor(budgetGB / 4), 4))
  const configured = configRow('Subagents that may run without asking', -1)

  const assess = prs ? prs.filter((p) => p.worksComments).length : 0
  console.log(`# capacity  ${cores} cores, ${usedGB.toFixed(1)}G used of ${cap.gb.toFixed(0)}G ceiling (${cap.source}), ${budgetGB.toFixed(1)}G to spend after a ${RESERVE_GB}G reserve, load ${load.toFixed(2)}\n`)
  console.log(`  ASSESS      ${assess || 'all of them'}   read-only, holds nothing local`)
  console.log(`  IMPLEMENT   ${implement}   min(mem ${byMem}, cpu ${byCpu}) - each runs tsc + lint + specs in its own worktree`)
  console.log(`  DEV SERVERS ${servers}   for screenshots; skip any port already bound`)
  console.log(`  UPLOADS     1   one shared Chromium profile`)
  console.log(`  MERGES      1   each fires a staging deploy and a db:migrate`)
  console.log(`\n  config section 3b "Subagents that may run without asking": ${configured || 'unset'} - launching more than that needs the user's yes`)
  console.log(`\n  peak cost per agent   build ${AGENT_GB.build}G · browser ${AGENT_GB.browser}G · light ${AGENT_GB.light}G`)
  console.log(`  An agent that only replies, resolves or reports is LIGHT - say "do not run typecheck,`)
  console.log(`  lint or the spec suite" in its brief. Count what is ALREADY running before launching more:`)
  console.log(`  this figure is a snapshot and cannot see agents started seconds ago.`)
  if (implement < 3) console.log(`\n  NOTE box is busy - if that is another clearance or autopilot run, do not start a second.`)
}

// Dump every human review comment across the open set, one per line, for theme mining.
// Deliberately not automated further: grouping these is a judgement call.
async function corpus() {
  const AUTHOR = await resolveAuthor()
  const isHuman = (a) => a && !isBot(a) && a.login !== AUTHOR
  const data = await gh(['api', 'graphql',
    '-F', `q=repo:${OWNER}/${NAME} is:pr is:open author:${AUTHOR}`,
    '-f', `query=${QUERY}`])
  const nodes = data?.data?.search?.nodes
  if (!Array.isArray(nodes) || !nodes.length) die('empty corpus - treat as failure')
  const flat = (t) => (t || '').replace(/\s+/g, ' ').trim()
  let n = 0
  for (const p of nodes) {
    for (const t of p.reviewThreads?.nodes || []) {
      if (t.isResolved) continue
      const c = t.comments?.nodes?.[0]
      if (!c || !isHuman(c.author)) continue
      n++
      console.log(`THREAD\t#${p.number}\t${c.path || '-'}\t${flat(c.body).slice(0, 400)}`)
    }
    for (const r of p.reviews?.nodes || []) {
      if (!isHuman(r.author) || !flat(r.body)) continue
      n++
      console.log(`REVIEW\t#${p.number}\t-\t${flat(r.body).slice(0, 400)}`)
    }
  }
  console.error(`\n${n} human comments across ${nodes.length} PRs`)
}

const cmd = process.argv[2] || 'derive'
if (cmd === 'derive') {
  const st = await derive({ withGit: !process.argv.includes('--no-git') })
  render(st)
  console.log('')
  await capacity(st.prs)
} else if (cmd === 'render') {
  if (!existsSync(STATE)) die('no state file - run derive first')
  render(JSON.parse(readFileSync(STATE, 'utf8')))
} else if (cmd === 'diff') {
  diff()
} else if (cmd === 'capacity') {
  await capacity(existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')).prs : null)
} else if (cmd === 'corpus') {
  await corpus()
} else if (cmd === 'json') {
  console.log(STATE)
} else die(`unknown command ${cmd}`)
