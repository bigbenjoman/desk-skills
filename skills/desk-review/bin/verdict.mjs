#!/usr/bin/env node
// The first three lines of every posted desk-review: the review marker, the verdict marker and the
// heading, and from round 3 a fourth: the carried marker. They are computed from the run's finder
// and refuter results, never written by hand, because a required check reads the verdict marker and
// a hand count is how a review reads clean when it is not. The marker is a contract with every gate
// that reads it: it changes only with a version bump. The carried count is a line of its own, after
// the heading, because a gate copy committed before it existed matches the verdict line exactly and
// would read any extra field there as no verdict at all.
//
//   node verdict.mjs <results.json>            prints the lines; exit 2 refuses the results
//   node verdict.mjs --carried <results.json>  prints the PR body's carried-findings section, if any
//
// results.json, written by the reviewer once every finder and refuter has answered:
//
//   { "sha": "<full reviewed SHA>", "round": 1, "gaps": 0, "skipped_files": 0,
//     "seats": [ { "role": "correctness", "vendor": "claude", "status": "ran" },
//                { "role": "codex", "vendor": "codex", "status": "ran" } ],
//     "findings": [ { "id": "F1", "seat": "correctness", "severity": "P1", "where": "src/a.ts:12",
//                     "result": "CONFIRMED", "refuted_by": "codex", "deferred": false } ] }
//
// From round 3 the finders read only the fix range, the commits since the previous round, so the
// results carry "since": the full SHA that round reviewed. Only then may a P2 be "carried": true,
// left for the PR body or a follow-up ticket instead of blocking. P0 and P1 always block.
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
//   - a carried finding is an outstanding P2 on round 3 or later, never deferred, with a file:line;
//     it counts in `carried`, not in p2, and an unrefuted one still counts in unrefuted.
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const CLEAN = 'p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0'
// The round from which the finders read only the fix range and a P2 may be carried.
export const FIX_RANGE_ROUND = 3
const TOP = ['sha', 'round', 'since', 'gaps', 'skipped_files', 'seats', 'findings']
const SEAT = ['role', 'agent', 'vendor', 'status', 'note']
const FINDING = ['id', 'seat', 'severity', 'where', 'title', 'result', 'refuted_by', 'duplicate_of', 'deferred', 'carried']
const SEVERITIES = ['P0', 'P1', 'P2', 'PREMISE']
const RESULTS = ['CONFIRMED', 'REJECTED', 'DUPLICATE', 'UNREFUTED']
const VENDORS = ['claude', 'codex']

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

  if (!Array.isArray(r.seats) || !r.seats.length) no('seats must list every seat dispatched')
  const seats = new Map()
  r.seats.forEach((s, i) => {
    keysOf(s, SEAT, `seats[${i}]`)
    if (!s.role || typeof s.role !== 'string') no(`seats[${i}].role is required`)
    if (seats.has(s.role)) no(`seat ${s.role} is listed twice`)
    if (!VENDORS.includes(s.vendor)) no(`seat ${s.role}: vendor must be claude or codex`)
    if (s.status !== 'ran' && s.status !== 'died') no(`seat ${s.role}: status must be ran or died`)
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
  const died = [...seats.values()].filter((s) => s.status === 'died').map((s) => s.role)
  n.partial += died.length
  return { sha, round: r.round, since: fixRange ? r.since : null, n, carried,
    vendor: cross ? 'codex-cross' : 'same-vendor', died, skipped,
    codexRead: [...seats.values()].some((s) => s.vendor === 'codex' && s.status === 'ran') }
}

export const isClean = (n) => Object.values(n).every((v) => v === 0)

const plural = (c, one, many = `${one}s`) => `${c} ${c === 1 ? one : many}`

// The three lines, in the exact form a gate reads.
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
  const verdict = isClean(n)
    ? (carried ? `No P0 or P1 findings; ${carried}` : 'No P0, P1 or P2 findings')
    : `not clean: ${[...parts, ...(carried ? [carried] : [])].join(', ')}`
  const how = t.vendor === 'codex-cross'
    ? 'codex read the diff cold · refuted cross-vendor'
    : `same-vendor${t.codexRead ? '' : ' · codex did not read the diff'}`
  const range = t.since ? `, fix range ${t.since.slice(0, 7)}..${t.sha.slice(0, 7)}` : ''
  const heading = `**desk-review, round ${t.round}${range}: ${verdict} at \`${t.sha.slice(0, 7)}\`** · ${how}`
  const lines = ['<!-- desk-review:local -->', marker, heading]
  if (t.since) lines.push(`<!-- desk-review:carried v=1 p2=${t.carried.length} since=${t.since} -->`)
  return lines.join('\n')
}

// The PR body's section for the carried findings, file:line each, or '' when none are carried.
export function carriedSection(r) {
  const t = tally(r)
  if (!t.carried.length) return ''
  const rows = t.carried.map((f) => `- \`${f.where}\`${f.title ? ` ${f.title}` : ''}${f.id ? ` (${f.id})` : ''}`)
  return [
    '### Carried review findings',
    `desk-review round ${t.round} read the fix range ${t.since.slice(0, 7)}..${t.sha.slice(0, 7)}. ` +
      'These P2 findings are left for later: from round 3 only P0 and P1 block.',
    ...rows,
  ].join('\n')
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (isMain) {
  try {
    const args = process.argv.slice(2)
    const section = args[0] === '--carried'
    const [file, ...rest] = section ? args.slice(1) : args
    if (!file || rest.length) no('usage: verdict.mjs [--carried] <results.json>')
    let r
    try { r = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { no(`cannot read ${file}: ${e.message}`) }
    const out = section ? carriedSection(r) : render(r)
    if (out) process.stdout.write(`${out}\n`)
  } catch (e) {
    process.stderr.write(`verdict.mjs: ${e.message}\n`)
    process.exit(2)
  }
}
