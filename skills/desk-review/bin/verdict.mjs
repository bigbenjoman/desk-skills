#!/usr/bin/env node
// The opening lines of every posted desk-review: the review marker, the verdict marker, the heading,
// from round 2 the carried marker, the accepted marker when a gap is accepted, and then the method
// marker. They are computed from the run's finder and refuter results, never written by hand, because
// a required check reads the verdict
// marker and a hand count is how a review reads clean when it is not. The marker is a contract with
// every gate that reads it: it changes only with a version bump. The carried count and the method
// are lines of their own, after the heading, because a gate copy committed before them matches the
// verdict line exactly and would read any extra field there as no verdict at all.
//
//   node verdict.mjs <results.json>            prints the lines; exit 2 refuses the results
//   node verdict.mjs --carried <results.json>  prints the PR body's carried-findings section, if any
//   node verdict.mjs --method <results.json>   prints the PR body's line on how the review ran
//   node verdict.mjs --accepted <results.json> prints the review body's accepted-gaps section, if any
//   node verdict.mjs --check <body.md> <head>  exit 0 when the repo's review gate (its own
//                                              scripts/desk/review-gate.mjs, else desk's) reads the
//                                              body's verdict at that full head SHA; 1 naming why not
//
// results.json, written by the reviewer once every finder and refuter has answered:
//
//   { "sha": "<full reviewed SHA>", "round": 1, "gaps": 0, "skipped_files": 0,
//     "seats": [ { "role": "correctness", "vendor": "claude", "status": "ran" },
//                { "role": "codex", "vendor": "codex", "status": "ran" } ],
//     "findings": [ { "id": "F1", "seat": "correctness", "severity": "P1", "where": "src/a.ts:12",
//                     "result": "CONFIRMED", "refuted_by": "codex", "deferred": false } ] }
//
// A seat whose named agent was not available, and whose brief a general-purpose agent ran instead,
// is "fallback": true; so is a named seat (NAMED_SEATS) whose "agent" is general-purpose, flag or
// not. The heading and the method marker count them. A seat routed to general-purpose by design
// (simplicity, domain) is not a fallback, so naming that agent alone never counts.
//
// From round 2 the finders read only the fix range, the commits since the previous round, so the
// results carry "since": the full SHA that round reviewed. Only then may a P2 be "carried": true,
// left for the PR body or a follow-up ticket instead of blocking. P0 and P1 always block.
//
// A requirement gap the person accepted is not open: it leaves "gaps" and is listed in "accepted",
// each with who accepted it, when, and the PR comment or review that records it:
//
//   "accepted": [ { "gap": "AC3", "by": "<GitHub login>", "at": "2026-10-29",
//                   "url": "https://github.com/<owner>/<repo>/pull/<n>#issuecomment-<id>" } ]
//
// Only a requirement gap can be accepted; a P0 or P1 is never. The count goes on a line of its own
// after the heading, as the carried count does, so every gate reads gaps=0 and nothing new.
//
// "rests_on", when given, lists the repo-relative paths the seats read and the changed files, and from
// round 2 the previous round's list too, since a fix-range round reads only part of what its verdict
// attests. A list that cannot be whole is left out. It goes on a line of its own after the method
// marker, for the autopilot pass to carry the verdict past a rebase or a base merge only while none of
// them changed (desk/bin/undraft.mjs restsOnCarries). It never decides clean.
//
// The rules, each a false clean otherwise:
//   - every count is computed here; a count the caller leaves out is refused, never read as zero;
//   - a CONFIRMED or UNREFUTED finding is outstanding, and counts in its p field;
//   - a DUPLICATE names the finding it merged into, and still counts unless that one is counted at
//     the same severity or higher;
//   - a seat that was dispatched and died (no usable answer after a retry) is partial coverage, so
//     it counts in `partial` beside the files the oversized cap skipped;
//   - vendor=codex-cross only when codex read the diff cold on this run and every finding was
//     refuted by the other vendor: codex's by Claude, Claude's by codex;
//   - a carried finding is an outstanding P2 on round 2 or later, never deferred, with a file:line;
//     it counts in `carried`, not in p2, and an unrefuted one still counts in unrefuted;
//   - an accepted gap names its criterion, who accepted it, when, and the PR comment or review that
//     records it, once each: one without all four is refused, never counted out of gaps.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CLEAN = 'p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0'
// The round from which the finders read only the fix range and a P2 may be carried.
const FIX_RANGE_ROUND = 2
const TOP = ['sha', 'round', 'since', 'gaps', 'accepted', 'skipped_files', 'seats', 'findings', 'rests_on']
const ACCEPTED = ['gap', 'by', 'at', 'url']
// The record of an acceptance: a comment or a review on a pull request, linked by its anchor.
const ACCEPT_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+#(?:issuecomment-\d+|pullrequestreview-\d+|discussion_r\d+)$/
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
const SEAT = ['role', 'agent', 'vendor', 'status', 'note', 'fallback']
const FINDING = ['id', 'seat', 'severity', 'where', 'title', 'result', 'refuted_by', 'duplicate_of', 'deferred', 'carried']
const SEVERITIES = ['P0', 'P1', 'P2', 'PREMISE']
const RESULTS = ['CONFIRMED', 'REJECTED', 'DUPLICATE', 'UNREFUTED']
const VENDORS = ['claude', 'codex']

// The seats that have a named agent. One that ran as general-purpose is a fallback even without the
// flag, and the heading names it, so a fleet that became one model checking itself never reads as a full run.
const NAMED_SEATS = ['correctness', 'security', 'api', 'tests', 'infra', 'frontend', 'requirements']

export class VerdictError extends Error {}
const no = (m) => { throw new VerdictError(m) }

const keysOf = (o, known, what) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) no(`${what} must be an object`)
  for (const k of Object.keys(o)) if (!known.includes(k)) no(`unknown field ${what}.${k}`)
}
const count = (v, name) => {
  if (v == null) no(`${name} is required (0 when there are none)`)
  if (!Number.isInteger(v) || v < 0) no(`${name} must be a whole number`)
  return v
}

// The counts, the vendor and the seats that died, from the run's results. Throws VerdictError.
export function tally(r) {
  keysOf(r, TOP, 'results')
  const sha = String(r.sha ?? '')
  if (!/^[0-9a-f]{40}$/.test(sha)) no('sha must be the full 40-character reviewed SHA')
  if (!Number.isInteger(r.round) || r.round < 1) no('round must be a whole number from 1')
  const fixRange = r.round >= FIX_RANGE_ROUND
  if (fixRange) {
    if (!/^[0-9a-f]{40}$/.test(String(r.since ?? ''))) no(`round ${r.round} reads only the fix range: since must be the full SHA the previous round reviewed`)
    if (r.since === sha) no('since is the reviewed SHA itself, so the fix range is empty')
  } else if (r.since != null) no(`since is for round ${FIX_RANGE_ROUND} on; round ${r.round} reads the whole branch`)
  const gaps = count(r.gaps, 'gaps')
  const skipped = count(r.skipped_files, 'skipped_files')
  const accepted = r.accepted ?? []
  if (!Array.isArray(accepted)) no('accepted must list each accepted gap ([] or left out when there are none)')
  const named = new Set()
  accepted.forEach((a, i) => {
    keysOf(a, ACCEPTED, `accepted[${i}]`)
    if (typeof a.gap !== 'string' || !a.gap.trim()) no(`accepted[${i}].gap names the criterion it accepts, as AC3`)
    const name = `accepted gap ${a.gap}`
    if (named.has(a.gap)) no(`${name} is listed twice`)
    named.add(a.gap)
    if (!LOGIN.test(String(a.by ?? ''))) no(`${name}: by is the GitHub login of the person who accepted it`)
    if (!/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(String(a.at ?? ''))) no(`${name}: at is the date it was recorded, as YYYY-MM-DD`)
    if (!ACCEPT_URL.test(String(a.url ?? ''))) no(`${name}: url links the PR comment or review that records it`)
  })

  if (!Array.isArray(r.seats) || !r.seats.length) no('seats must list every seat dispatched')
  const seats = new Map()
  r.seats.forEach((s, i) => {
    keysOf(s, SEAT, `seats[${i}]`)
    if (!s.role || typeof s.role !== 'string') no(`seats[${i}].role is required`)
    if (seats.has(s.role)) no(`seat ${s.role} is listed twice`)
    if (!VENDORS.includes(s.vendor)) no(`seat ${s.role}: vendor must be claude or codex`)
    if (s.status !== 'ran' && s.status !== 'died') no(`seat ${s.role}: status must be ran or died`)
    if (s.fallback != null && typeof s.fallback !== 'boolean') no(`seat ${s.role}: fallback must be true or false`)
    seats.set(s.role, s)
  })
  // Correctness fires on every review, so a results file without it is a run that never finished.
  if (!seats.has('correctness')) no('seats must include correctness, which runs on every review')

  if (!Array.isArray(r.findings)) no('findings is required ([] when there are none)')
  const ids = new Set()
  const n = { p0: 0, p1: 0, p2: 0, deferred: 0, gaps, unrefuted: 0, partial: skipped }
  let cross = [...seats.values()].some((s) => s.vendor === 'codex' && s.status === 'ran')
  r.findings.forEach((f, i) => {
    keysOf(f, FINDING, `findings[${i}]`)
    const name = f.id ? `finding ${f.id}` : `findings[${i}]`
    if (f.id != null && ids.has(f.id)) no(`${name} is listed twice`)
    ids.add(f.id)
    const seat = seats.get(f.seat)
    if (!seat) no(`${name}: seat ${f.seat} is not in seats`)
    if (seat.status === 'died') no(`${name}: seat ${f.seat} died, so it raised nothing`)
    if (!SEVERITIES.includes(f.severity)) no(`${name}: severity must be one of ${SEVERITIES.join(', ')}`)
    if (f.deferred != null && typeof f.deferred !== 'boolean') no(`${name}: deferred must be true or false`)
    if (f.carried != null && typeof f.carried !== 'boolean') no(`${name}: carried must be true or false`)
    if (f.carried) {
      const at = f.where ? ` at ${f.where}` : ''
      if (f.severity !== 'P2') no(`${name}${at} is ${f.severity}: only a P2 can be carried, and a P0 or P1 blocks`)
      if (!fixRange) no(`${name}${at}: a P2 is carried only from round ${FIX_RANGE_ROUND}; on round ${r.round} it is fixed`)
      if (f.deferred) no(`${name}${at}: a finding is carried or deferred, not both`)
      if (!/^[^\s:]+:\d+/.test(String(f.where ?? ''))) no(`${name}: a carried finding needs where as file:line, for the PR body`)
      if (f.result === 'REJECTED') no(`${name}${at}: a REJECTED finding is not outstanding, so there is nothing to carry`)
    }
    // An unproven premise is reported, never refuted and never counted.
    if (f.severity === 'PREMISE') return
    if (!RESULTS.includes(f.result)) no(`${name}: result must be one of ${RESULTS.join(', ')}`)
    if (f.result === 'UNREFUTED') {
      if (f.refuted_by != null) no(`${name}: an UNREFUTED finding has no refuted_by`)
      cross = false
    } else {
      if (!VENDORS.includes(f.refuted_by)) no(`${name}: refuted_by must be claude or codex`)
      if (f.refuted_by === seat.vendor) cross = false
    }
    if (f.result === 'DUPLICATE' && (f.duplicate_of == null || f.duplicate_of === f.id)) no(`${name}: a DUPLICATE names the finding it duplicates in duplicate_of`)
    if (f.result !== 'DUPLICATE' && f.duplicate_of != null) no(`${name}: only a DUPLICATE has duplicate_of`)
  })
  const byId = new Map(r.findings.map((f) => [f.id, f]))
  const RANK = { P0: 0, P1: 1, P2: 2 }
  const counted = (f) => f.result === 'CONFIRMED' || f.result === 'UNREFUTED'
  const carried = []
  for (const f of r.findings) {
    if (f.severity === 'PREMISE' || f.result === 'REJECTED') continue
    if (f.result === 'DUPLICATE') {
      const target = byId.get(f.duplicate_of)
      if (!target) no(`finding ${f.id}: duplicate_of ${f.duplicate_of} is not in findings`)
      if (target.result === 'DUPLICATE') no(`finding ${f.id}: duplicate_of ${f.duplicate_of} is itself a DUPLICATE; name the finding that stands`)
      // Dropped only when the finding it duplicates is counted at the same severity or higher; a
      // duplicate of a rejected finding, or of a milder one, still stands.
      if (counted(target) && RANK[target.severity] <= RANK[f.severity]) continue
    }
    // A carried P2 leaves the blocking counts, so a verdict whose only outstanding findings are
    // carried reads clean to every gate, including one committed before carrying existed.
    if (f.carried) carried.push(f)
    else n[f.severity.toLowerCase()]++
    if (f.result === 'UNREFUTED') n.unrefuted++
    if (f.deferred) n.deferred++
  }
  let restsOn = null
  if (r.rests_on != null) {
    if (!Array.isArray(r.rests_on)) no('rests_on must list the repo-relative paths the seats read')
    r.rests_on.forEach((p, i) => {
      if (typeof p !== 'string' || !p || /[\r\n]/.test(p) || p.startsWith('/')) no(`rests_on[${i}] must be a repo-relative path on one line`)
    })
    restsOn = [...new Set(r.rests_on)].sort()
  }
  const died = [...seats.values()].filter((s) => s.status === 'died').map((s) => s.role)
  n.partial += died.length
  const fallback = [...seats.values()]
    .filter((s) => s.fallback === true || (NAMED_SEATS.includes(s.role) && s.agent === 'general-purpose'))
    .map((s) => s.role)
  return { sha, round: r.round, since: fixRange ? r.since : null, n, carried, accepted, restsOn,
    vendor: cross ? 'codex-cross' : 'same-vendor', died, skipped, fallback,
    codexRead: [...seats.values()].some((s) => s.vendor === 'codex' && s.status === 'ran') }
}

export const isClean = (n) => Object.values(n).every((v) => v === 0)

const plural = (c, one, many = `${one}s`) => `${c} ${c === 1 ? one : many}`

// The opening lines, in the exact form a gate reads.
export function render(r) {
  const t = tally(r)
  const { n } = t
  const marker = `<!-- desk-review:verdict v=1 sha=${t.sha} p0=${n.p0} p1=${n.p1} p2=${n.p2} deferred=${n.deferred} gaps=${n.gaps} unrefuted=${n.unrefuted} partial=${n.partial} vendor=${t.vendor} round=${t.round} -->`
  const parts = []
  const listed = [['P0', n.p0], ['P1', n.p1], ['P2', n.p2]].filter(([, c]) => c).map(([s, c]) => `${c} ${s}`)
  if (listed.length) parts.push(`${listed.join(', ')} outstanding`)
  if (n.deferred) parts.push(`${n.deferred} deferred`)
  if (n.unrefuted) parts.push(`${n.unrefuted} unrefuted`)
  if (t.skipped) parts.push(`${plural(t.skipped, 'file')} not reviewed`)
  if (t.died.length) parts.push(`${t.died.join(', ')} ${t.died.length === 1 ? 'seat' : 'seats'} died`)
  if (n.gaps) parts.push(`${plural(n.gaps, 'requirement gap')} open`)
  // Worded so no count sits before "P2": a gate reads "<n> P2" in a heading as an open finding.
  const carried = t.carried.length ? `P2 findings carried: ${t.carried.length}` : ''
  const accepted = t.accepted.length ? `requirement gaps accepted: ${t.accepted.length}` : ''
  const kept = [carried, accepted].filter(Boolean)
  const verdict = isClean(n)
    ? `${carried ? 'No P0 or P1 findings' : 'No P0, P1 or P2 findings'}${kept.map((k) => `; ${k}`).join('')}`
    : `not clean: ${[...parts, ...kept].join(', ')}`
  const range = t.since ? `, fix range ${t.since.slice(0, 7)}..${t.sha.slice(0, 7)}` : ''
  const fell = t.fallback.length ? ` · ${plural(t.fallback.length, 'fallback seat')} (${t.fallback.join(', ')})` : ''
  const heading = `**desk-review, round ${t.round}${range}: ${verdict} at \`${t.sha.slice(0, 7)}\`** · ${how(t)}${fell}`
  const lines = ['<!-- desk-review:local -->', marker, heading]
  if (t.since) lines.push(`<!-- desk-review:carried v=1 p2=${t.carried.length} since=${t.since} -->`)
  if (t.accepted.length) lines.push(`<!-- desk-review:accepted v=1 gaps=${t.accepted.length} -->`)
  lines.push(`<!-- desk-review:method v=1 fallback=${t.fallback.length} -->`)
  // JSON with every ">" escaped, so no path can close the comment.
  if (t.restsOn) lines.push(`<!-- desk-review:rests-on v=1 files=${JSON.stringify(t.restsOn).replace(/>/g, '\\u003e')} -->`)
  return lines.join('\n')
}

const how = (t) => (t.vendor === 'codex-cross'
  ? 'codex read the diff cold · refuted cross-vendor'
  : `same-vendor${t.codexRead ? '' : ' · codex did not read the diff'}`)

// The PR body's line on how the review ran: its rounds, its vendor and its fallback seats.
export function methodLine(r) {
  const t = tally(r)
  const roles = t.fallback.length ? ` (${t.fallback.join(', ')})` : ''
  return `desk-review: ${plural(t.round, 'round')}, last at \`${t.sha.slice(0, 7)}\` · ${how(t)} · fallback seats: ${t.fallback.length}${roles}`
}

// The PR body's section for the carried findings, file:line each, or '' when none are carried.
export function carriedSection(r) {
  const t = tally(r)
  if (!t.carried.length) return ''
  const rows = t.carried.map((f) => `- \`${f.where}\`${f.title ? ` ${f.title}` : ''}${f.id ? ` (${f.id})` : ''}`)
  return [
    '### Carried review findings',
    `desk-review round ${t.round} read the fix range ${t.since.slice(0, 7)}..${t.sha.slice(0, 7)}. ` +
      `These P2 findings are left for later: from round ${FIX_RANGE_ROUND} only P0 and P1 block.`,
    ...rows,
  ].join('\n')
}

// The review body's section for the accepted gaps: who accepted each, when, and the link to the
// record; '' when none is accepted. Its heading never names requirement gaps, which a reader of the
// body (fix-tries.mjs reviewGaps) takes for the open ones.
export function acceptedSection(r) {
  const t = tally(r)
  if (!t.accepted.length) return ''
  return [
    '### Accepted gaps',
    'The person accepted these requirement gaps, so the verdict does not count them in `gaps`:',
    ...t.accepted.map((a) => `- ${a.gap}: accepted by \`${a.by}\` on ${a.at.slice(0, 10)}, ${a.url}`),
  ].join('\n')
}

// Why the review gate would reject a review body posted at `head`, or null: no verdict marker it reads,
// a marker for another commit, a vendor other than the one the gate requires, or a heading that
// contradicts a clean marker. gate: the review-gate.mjs module (parseVerdict, headingMismatch, COUNTS).
// Counts that are not clean are no format fault: a review may hand its findings on.
export function gateRejects(body, head, gate, vendor = '') {
  const v = gate.parseVerdict(body)
  if (!v) return 'the gate reads no verdict in it: its first line must be the local-review marker and its second the v=1 verdict marker'
  if (v.sha !== head) return `its verdict marker attests ${v.sha.slice(0, 9)}, not the head ${String(head).slice(0, 9)}`
  if (vendor && v.vendor !== vendor) return `its verdict marker says vendor=${v.vendor}, and the gate requires ${vendor}`
  const clean = Array.isArray(gate.COUNTS) && gate.COUNTS.every((k) => v[k] === 0)
  if (clean) return gate.headingMismatch?.(v) ?? null
  return v.heading ? null : 'the review has no visible heading under its markers'
}

// The review gate a repo runs: its own copy, else desk's template beside this install or this source tree.
function gatePath() {
  const home = process.env.DESK_HOME || `${process.env.HOME}/.claude/desk`
  const here = fileURLToPath(new URL('../../../desk/templates/scripts/desk/review-gate.mjs', import.meta.url))
  return ['scripts/desk/review-gate.mjs', `${home}/templates/scripts/desk/review-gate.mjs`, here].find((p) => existsSync(p))
}
// The vendor the repo's desk-gate.yml requires (REQUIRE_VENDOR), or ''.
function gateVendor() {
  try { return /REQUIRE_VENDOR:\s*['"]?([a-z-]*)/.exec(readFileSync('.github/workflows/desk-gate.yml', 'utf8'))?.[1] ?? '' } catch { return '' }
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (isMain && process.argv[2] === '--check') {
  // node verdict.mjs --check <review body> <head sha>: exit 0 when the gate reads it, 1 naming why not.
  const [file, head, ...rest] = process.argv.slice(3)
  const path = gatePath()
  let body
  try { body = readFileSync(file ?? '', 'utf8') } catch (e) { body = e }
  const fail = !file || !/^[0-9a-f]{40}$/.test(head ?? '') || rest.length ? 'usage: verdict.mjs --check <review body file> <full head sha>'
    : !path ? "no review-gate.mjs found: neither scripts/desk/review-gate.mjs here nor desk's template"
    : body instanceof Error ? `cannot read ${file}: ${body.message}` : null
  if (fail) { process.stderr.write(`verdict.mjs: ${fail}\n`); process.exit(2) }
  const gate = await import(pathToFileURL(resolve(path)).href)
  if (typeof gate.parseVerdict !== 'function') { process.stderr.write(`verdict.mjs: ${path} exports no parseVerdict, so its verdict format cannot be checked\n`); process.exit(2) }
  const why = gateRejects(body, head, gate, gateVendor())
  process.stdout.write(why ? `REJECTED by ${path}: ${why}\n` : `ok: ${path} reads its verdict at ${head.slice(0, 9)}\n`)
  process.exit(why ? 1 : 0)
} else if (isMain) {
  try {
    const args = process.argv.slice(2)
    const modes = { '--carried': carriedSection, '--method': methodLine, '--accepted': acceptedSection }
    const mode = Object.hasOwn(modes, args[0] ?? '') ? args[0] : null
    const [file, ...rest] = mode ? args.slice(1) : args
    if (!file || rest.length) no('usage: verdict.mjs [--carried | --method | --accepted] <results.json>')
    let r
    try { r = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { no(`cannot read ${file}: ${e.message}`) }
    const out = mode ? modes[mode](r) : render(r)
    if (out) process.stdout.write(`${out}\n`)
  } catch (e) {
    process.stderr.write(`verdict.mjs: ${e.message}\n`)
    process.exit(2)
  }
}
