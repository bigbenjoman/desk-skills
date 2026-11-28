#!/usr/bin/env node
// The opening lines of every posted desk-review: the review marker, the verdict marker, the heading,
// from round 2 (and on a round 1 that carries) the carried marker, the accepted marker when a gap is
// accepted, and then the method marker. They are computed from the run's finder and refuter results,
// never written by hand, because a required check reads the verdict
// marker and a hand count is how a review reads clean when it is not. The marker is a contract with
// every gate that reads it: it changes only with a version bump. The carried count and the method
// are lines of their own, after the heading, because a gate copy committed before them matches the
// verdict line exactly and would read any extra field there as no verdict at all.
//
//   node verdict.mjs <results.json>            prints the lines; exit 2 refuses the results
//   node verdict.mjs --carried <results.json>  prints the PR body's carried-findings section, if any
//   node verdict.mjs --method <results.json>   prints the PR body's line on how the review ran
//   node verdict.mjs --accepted <results.json> prints the review body's accepted-gaps section, if any
//   node verdict.mjs --post-merge <results.json> prints the review body's after-the-merge section, if any
//   node verdict.mjs --settled <results.json>  prints the review body's settled-by-Decisions section, if any
//   node verdict.mjs --findings <results.json> --reviewer <self|pr>
//                                              prints the round's AUTOPILOT_FINDINGS line, once its
//                                              fixes are in, for the pass to record (desk/bin/findings.mjs)
//   node verdict.mjs --check <body.md> <head>  exit 0 when the repo's review gate (its own
//                                              scripts/desk/review-gate.mjs, else desk's) reads the
//                                              body's verdict at that full head SHA; 1 naming why not
//   node verdict.mjs --anchors <results.json> <head>
//                                              before Phase 4's refuter calls: marks each finding whose
//                                              file:line does not exist at head REJECTED, "anchor":
//                                              "missing", rewrites the file and prints one line for each
//
// results.json, written by the reviewer once every finder and refuter has answered:
//
//   { "sha": "<full reviewed SHA>", "round": 1, "gaps": 0, "skipped_files": 0,
//     "seats": [ { "role": "correctness", "vendor": "claude", "status": "ran" },
//                { "role": "codex", "vendor": "codex", "status": "ran" } ],
//     "findings": [ { "id": "F1", "seat": "correctness", "severity": "P1", "where": "src/a.ts:12",
//                     "result": "CONFIRMED", "refuted_by": "codex", "deferred": false },
//                   { "id": "C1", "seat": "codex", "severity": "P2", "result": "REJECTED", "refuted_by": "claude" } ] }
//
// A seat whose named agent was not available, and whose brief a general-purpose agent ran instead,
// is "fallback": true; so is a named seat (NAMED_SEATS) whose "agent" is general-purpose, flag or
// not. The heading and the method marker count them. A seat routed to general-purpose by design
// (simplicity, domain) is not a fallback, so naming that agent alone never counts.
//
// From round 2 the finders read only the fix range, the commits since the previous round, so the
// results carry "since": the full SHA that round reviewed. Only then may a P2 be "carried": true,
// left for the PR body or a follow-up ticket instead of blocking. P0 and P1 always block. On round 1
// a P2 is carried only when it was split to a follow-up ticket already filed for it, which its
// "follow_up" names: with no round 2 to run when nothing else needs a fix, it would block for good.
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
// A criterion a dated entry in the ticket's Decisions section settles (it names the criterion, the
// evidence and who decided) is met, or met as the entry amends it: it is never a gap, and is listed in
// "settled", quoting the entry as the ticket holds it (`<yyyy-mm-dd> <who>: <what>`, settlingEntry):
//
//   "settled": [ { "gap": "AC3", "entry": "2026-11-26 ben: AC3 measured at 212 lines on the 2026-11-26 window, under 300" } ]
//
// It never changes a count: the verdict cites the entry in its own section (--settled).
//
// A criterion only a live system can check (a production run, a staging call, playback on a device)
// is not open either: it leaves "gaps" and is listed in "post_merge", each naming what it needs and
// the step that checks it once the PR has merged:
//
//   "post_merge": [ { "gap": "AC7", "needs": "production", "step": "fill in the switch date at the production relay run" } ]
//
// `needs` is one of POST_MERGE_NEEDS: anything a test, a local run or a preview can check before the
// merge is a gap, and refused here. The items go on a marker line of their own after the accepted line,
// as JSON, for the autopilot pass to keep as follow-on steps once the PR merges (pass.mjs). Like the
// accepted line it never decides clean.
//
// A finding whose cited file, or line, does not exist at the reviewed head cannot be right, so it is
// rejected before any refuter call (checkAnchors): "result": "REJECTED", "anchor": "missing" and no
// refuted_by, the one REJECTED finding without one. The heading counts them, and nothing else does.
//
// A finding the reviewer fixed once the round was read is "fixed": true, set after the fix commits and
// before --findings runs. It never changes the counts: they attest the reviewed SHA, fixed or not. Only
// a counted finding can be fixed, never a carried, deferred, rejected or premise one.
//
// "rests_on", when given, lists the repo-relative paths the seats read and the changed files, and from
// round 2 the previous round's list too, since a fix-range round reads only part of what its verdict
// attests. A list that cannot be whole is left out. It goes on a line of its own after the method
// marker, for the autopilot pass to carry the verdict past a rebase or a base merge only while none of
// them changed (desk/bin/undraft.mjs restsOnCarries). It never decides clean.
//
// "targeted", on a round the autopilot pass narrowed after a base move (references/targeted.md),
// records what it re-read and what it carried: { "from": "<full SHA of the clean review it carries>",
// "range": "<base range>", "files": [the base's changed files], "users": [the PR's files using them] }.
// Its `since` is `from`. It goes on a marker line and a visible line after the rests-on line, and
// never decides clean: the counts are this round's, at this head.
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
//   - a carried finding is an outstanding P2 on round 2 or later, or on round 1 naming its follow-up
//     ticket, never deferred, with a file:line;
//     it counts in `carried`, not in p2, and an unrefuted one still counts in unrefuted;
//   - an accepted gap names its criterion, who accepted it, when, and the PR comment or review that
//     records it, once each: one without all four is refused, never counted out of gaps;
//   - a post-merge criterion names its criterion, a live-only need and its step, once, and is not also
//     accepted: one a test could check before the merge is refused, never counted out of gaps;
//   - a settled criterion quotes a dated Decisions entry that names it, who decided and the evidence,
//     once, and is neither accepted nor left for after the merge.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CLEAN = 'p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0'
// The round from which the finders read only the fix range and a P2 may be carried.
const FIX_RANGE_ROUND = 2
const TOP = ['sha', 'round', 'since', 'gaps', 'accepted', 'post_merge', 'settled', 'skipped_files', 'seats', 'findings', 'rests_on', 'targeted', 'codex']
const TARGETED = ['from', 'range', 'files', 'users']
const REPO_PATH = (p) => typeof p === 'string' && !!p && !/[\r\n]/.test(p) && !p.startsWith('/')
// With the codex lever on, the model and effort each codex role ran at, as `desk-codex settings` prints them.
const CODEX_ROLES = ['finder', 'refuter']
const CODEX_RUN = /^[A-Za-z0-9][A-Za-z0-9._-]*:[a-z]+$/
// With more than one Codex login, the logins the calls ran on, as `desk-codex: on Codex login <name>` names them.
// A found login is named after its folder, so a name is any text on one line with no edge spaces.
const codexLogins = (s) => typeof s === 'string' && s.split(', ').every((n) => n && n === n.trim() && !/[\u0000-\u001f]/.test(n))
const ACCEPTED = ['gap', 'by', 'at', 'url']
// The record of an acceptance: a comment or a review on a pull request, linked by its anchor.
const ACCEPT_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+#(?:issuecomment-\d+|pullrequestreview-\d+|discussion_r\d+)$/
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
const POST_MERGE = ['gap', 'needs', 'step']
const SETTLED = ['gap', 'entry']
// A ticket's Decisions entry as desk-jira's template writes it, bullet dropped: date, who, then what.
const DECISION_ENTRY = /^(\d{4}-\d{2}-\d{2})\s+([^:\r\n]*[^\s:])\s*:\s*(.+)$/
// A criterion's label, as the ticket numbers it: AC3, DoD2.
const CRITERION = /\b(?:AC|DoD)\s?\d+\b/gi
const label = (s) => String(s).replace(/\s+/g, '').toUpperCase()

// A Decisions entry (`<yyyy-mm-dd> <who>: <what>`, a leading `*` or `-` allowed) read as settling the
// criterion `gap` (AC3, DoD2): { date, who, criterion }, or null. It settles it only when it is dated,
// names who decided, names that criterion, and says more than the label: the evidence or the ruling. One
// naming several criteria settles each it names. The desk pass's own entry (`<date> desk pass: issue
// #<n> changed …`) reports criteria changed on the issue, and settles none.
export function settlingEntry(entry, gap) {
  const m = DECISION_ENTRY.exec(String(entry ?? '').trim().replace(/^[-*]\s+/, ''))
  if (!m || /^desk pass$/i.test(m[2].trim())) return null
  const [, date, who, what] = m
  const criterion = label(gap ?? '')
  if (!criterion || !(what.match(CRITERION) ?? []).map(label).includes(criterion)) return null
  const said = what.replace(CRITERION, ' ').replace(/[\s:;,.()"'`—–-]+/g, ' ').trim()
  return said ? { date, who: who.trim(), criterion } : null
}
// What only exists once the PR has merged: the production system, a shared staging one, a deployed
// build, a physical device, or a third party's live service. A unit, integration or local check is none.
const POST_MERGE_NEEDS =['production', 'staging', 'deployed', 'device', 'third-party']
const POST_MERGE_STEP_MAX = 300
const SEAT = ['role', 'agent', 'vendor', 'status', 'reason', 'note', 'fallback']
const FINDING = ['id', 'seat', 'severity', 'where', 'title', 'result', 'refuted_by', 'duplicate_of', 'deferred', 'carried', 'fixed', 'follow_up', 'anchor']
// The anchor check's one mark: the cited file or line is not there at head.
const ANCHOR_MISSING = 'missing'
// A follow-up ticket's key, as a tracker key is written: ABC-123.
const FOLLOW_UP = /^[A-Z][A-Z0-9_]*-\d+$/
const SEVERITIES = ['P0', 'P1', 'P2', 'PREMISE']
const RESULTS = ['CONFIRMED', 'REJECTED', 'DUPLICATE', 'UNREFUTED']
export const VENDORS = ['claude', 'codex']

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
  const postMerge = r.post_merge ?? []
  if (!Array.isArray(postMerge)) no('post_merge must list each criterion left for after the merge ([] or left out when there are none)')
  const later = new Set()
  postMerge.forEach((p, i) => {
    keysOf(p, POST_MERGE, `post_merge[${i}]`)
    if (typeof p.gap !== 'string' || !p.gap.trim() || /[\r\n]/.test(p.gap)) no(`post_merge[${i}].gap names the criterion, as AC7`)
    const name = `post-merge criterion ${p.gap}`
    if (later.has(p.gap)) no(`${name} is listed twice`)
    later.add(p.gap)
    if (named.has(p.gap)) no(`${name} is also accepted: a criterion is accepted or left for after the merge, not both`)
    if (!POST_MERGE_NEEDS.includes(p.needs)) no(`${name}: needs must be one of ${POST_MERGE_NEEDS.join(', ')}; a criterion a test, a local run or a preview can check before the merge is a gap`)
    if (typeof p.step !== 'string' || !p.step.trim() || /[\r\n]/.test(p.step) || p.step.length > POST_MERGE_STEP_MAX) no(`${name}: step says on one line, within ${POST_MERGE_STEP_MAX} characters, what checks it after the merge`)
  })
  const settled = r.settled ?? []
  if (!Array.isArray(settled)) no('settled must list each criterion a Decisions entry settles ([] or left out when there are none)')
  const met = new Set()
  settled.forEach((x, i) => {
    keysOf(x, SETTLED, `settled[${i}]`)
    if (typeof x.gap !== 'string' || !x.gap.trim() || /[\r\n]/.test(x.gap)) no(`settled[${i}].gap names the criterion, as AC3`)
    const name = `settled criterion ${x.gap}`
    if (met.has(x.gap)) no(`${name} is listed twice`)
    met.add(x.gap)
    if (named.has(x.gap) || later.has(x.gap)) no(`${name} is also ${named.has(x.gap) ? 'accepted' : 'left for after the merge'}: a criterion a Decisions entry settles is met, not open`)
    if (typeof x.entry !== 'string' || /[\r\n]/.test(x.entry) || !settlingEntry(x.entry, x.gap)) no(`${name}: entry quotes, on one line, the ticket's dated Decisions entry that settles it, as "<yyyy-mm-dd> <who>: <what>", naming ${x.gap} and the evidence`)
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
    if (s.reason != null && (s.status !== 'died' || typeof s.reason !== 'string' || !s.reason.trim())) no(`seat ${s.role}: reason says why a seat died, as "timed out"`)
    seats.set(s.role, s)
  })
  if (r.codex != null) {
    keysOf(r.codex, [...CODEX_ROLES, 'login'], 'codex')
    for (const role of CODEX_ROLES) if (role in r.codex && !CODEX_RUN.test(String(r.codex[role]))) no(`codex.${role} is <model>:<effort>, as desk-codex settings prints it`)
    if ('login' in r.codex && !codexLogins(r.codex.login)) no('codex.login names the Codex logins the calls ran on, as desk-codex prints them, comma-separated')
  }
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
    if (f.fixed != null && typeof f.fixed !== 'boolean') no(`${name}: fixed must be true or false`)
    if (f.fixed) {
      if (f.carried || f.deferred) no(`${name}: a ${f.carried ? 'carried' : 'deferred'} finding is left unfixed, so it is not fixed`)
      if (f.severity === 'PREMISE' || f.result === 'REJECTED') no(`${name}: only an outstanding finding can be fixed`)
    }
    const anchorless = f.anchor != null
    if (anchorless) {
      if (f.anchor !== ANCHOR_MISSING) no(`${name}: anchor is "${ANCHOR_MISSING}", set by the anchor check, or left out (${JSON.stringify(f.anchor)})`)
      if (f.severity === 'PREMISE' || f.result !== 'REJECTED') no(`${name}: a finding whose anchor is missing is REJECTED before any refuter call`)
      if (f.refuted_by != null) no(`${name}: a finding rejected for a missing anchor reached no refuter, so it has no refuted_by`)
    }
    if (f.follow_up != null && !FOLLOW_UP.test(String(f.follow_up))) no(`${name}: follow_up must be the follow-up ticket's key, e.g. ABC-123 (${JSON.stringify(f.follow_up)})`)
    if (f.carried) {
      const at = f.where ? ` at ${f.where}` : ''
      if (f.severity !== 'P2') no(`${name}${at} is ${f.severity}: only a P2 can be carried, and a P0 or P1 blocks`)
      if (!fixRange && f.follow_up == null) no(`${name}${at}: a P2 is carried only from round ${FIX_RANGE_ROUND}; on round ${r.round} it is fixed, or split to a filed follow-up ticket named in follow_up`)
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
    } else if (!anchorless) {
      if (!VENDORS.includes(f.refuted_by)) no(`${name}: refuted_by must be the refuter's vendor, claude or codex, not its agent (${JSON.stringify(f.refuted_by ?? null)})`)
      if (f.refuted_by === seat.vendor) cross = false
    }
    if (f.result === 'DUPLICATE' && (f.duplicate_of == null || f.duplicate_of === f.id)) no(`${name}: a DUPLICATE names the finding it duplicates in duplicate_of`)
    if (f.result !== 'DUPLICATE' && f.duplicate_of != null) no(`${name}: only a DUPLICATE has duplicate_of`)
  })
  const byId = new Map(r.findings.map((f) => [f.id, f]))
  const RANK = { P0: 0, P1: 1, P2: 2 }
  const counted = (f) => f.result === 'CONFIRMED' || f.result === 'UNREFUTED'
  const carried = []
  let fixed = 0
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
    else {
      n[f.severity.toLowerCase()]++
      if (f.fixed) fixed++
    }
    if (f.result === 'UNREFUTED') n.unrefuted++
    if (f.deferred) n.deferred++
  }
  let restsOn = null
  if (r.rests_on != null) {
    if (!Array.isArray(r.rests_on)) no('rests_on must list the repo-relative paths the seats read')
    r.rests_on.forEach((p, i) => {
      if (!REPO_PATH(p)) no(`rests_on[${i}] must be a repo-relative path on one line`)
    })
    restsOn = [...new Set(r.rests_on)].sort()
  }
  let targeted = null
  if (r.targeted != null) {
    const x = r.targeted
    keysOf(x, TARGETED, 'targeted')
    if (!fixRange) no(`a targeted round follows a review of the PR, so it is round ${FIX_RANGE_ROUND} or later`)
    if (!/^[0-9a-f]{40}$/.test(String(x.from ?? ''))) no('targeted.from must be the full SHA of the clean review it carries')
    if (x.from !== r.since) no('a targeted round reads on from the review it carries: since must be targeted.from')
    if (!/^[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}$/.test(String(x.range ?? ''))) no('targeted.range must be the base range, <sha>..<sha>')
    if (!Array.isArray(x.files) || !x.files.length || !x.files.every(REPO_PATH)) no("targeted.files must list the base's changed files, repo-relative")
    if (!Array.isArray(x.users ?? []) || !(x.users ?? []).every(REPO_PATH)) no("targeted.users must list the PR's files that use them, repo-relative ([] when none)")
    targeted = { from: x.from, range: x.range, files: [...new Set(x.files)].sort(), users: [...new Set(x.users ?? [])].sort() }
  }
  const died = [...seats.values()].filter((s) => s.status === 'died').map((s) => (s.reason ? `${s.role} (${s.reason.trim()})` : s.role))
  n.partial += died.length
  const fallback = [...seats.values()]
    .filter((s) => s.fallback === true || (NAMED_SEATS.includes(s.role) && s.agent === 'general-purpose'))
    .map((s) => s.role)
  const refuters = [...new Set(r.findings.filter((f) => f.severity !== 'PREMISE' && f.refuted_by != null).map((f) => f.refuted_by))]
  const anchorMissing = r.findings.filter((f) => f.anchor === ANCHOR_MISSING).length
  return { sha, round: r.round, since: fixRange ? r.since : null, n, carried, accepted, anchorMissing,
    postMerge: postMerge.map((p) => ({ gap: p.gap.trim(), needs: p.needs, step: p.step.trim() })),
    settled: settled.map((x) => ({ gap: x.gap.trim(), ...settlingEntry(x.entry, x.gap), entry: x.entry.trim().replace(/^[-*]\s+/, '') })), restsOn, targeted, fixed,
    refuterVendor: refuters.length > 1 ? 'mixed' : refuters[0] ?? null,
    vendor: cross ? 'codex-cross' : 'same-vendor', died, skipped, fallback, codex: r.codex ?? null,
    codexRead: [...seats.values()].some((s) => s.vendor === 'codex' && s.status === 'ran') }
}

// Why the verdict refuses a results file, as it prints it, or null when it reads it: the one check the
// verdict runs before every output, and the prose check's contract for the results file.
export function validateResults(r) {
  try { tally(r) } catch (e) { if (e instanceof VerdictError) return e.message; throw e }
  return null
}

// The anchor check, run before Phase 4's refuter calls: each finding citing a file that does not exist
// at `head`, or a line past that file's end, comes back REJECTED with "anchor": "missing" and no
// refuted_by, so no refuter is called for it. Everything else comes back as it was: a finding with no
// file:line, a PREMISE, one already refuted, or a path outside the repo is the refuter's to judge.
// Returns { findings, rejected }, rejected listing the findings it marked. Throws VerdictError when
// head is not a commit here, so a failed git call never reads as every anchor missing.
export function checkAnchors(findings, head, { cwd = process.cwd() } = {}) {
  if (!Array.isArray(findings)) no('findings must be a list')
  const run = (dir, args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (!/^[0-9a-f]{40}$/.test(String(head ?? ''))) no('head must be the full 40-character reviewed SHA')
  if (run(cwd, ['cat-file', '-e', `${head}^{commit}`]).status !== 0) no(`${head.slice(0, 9)} is not a commit in ${cwd}`)
  const top = (run(cwd, ['rev-parse', '--show-toplevel']).stdout || '').trim()
  if (!top) no(`${cwd} is not inside a checkout`)
  // A cited path is from the repo's top, and a pathspec is read from the directory git runs in.
  const git = (...args) => run(top, args)
  const lines = new Map()
  // The cited file's line count at head, 0 when no file is there. git grep counts the lines of each
  // file under the pathspec, a last line with no newline included, and exits 1 when it matched none:
  // an empty file, or no file. Any other exit is git failing, which throws rather than reject.
  const lineCount = (path) => {
    if (!lines.has(path)) {
      const r = git('--literal-pathspecs', 'grep', '--no-color', '--text', '-z', '-c', '-e', '', head, '--', path)
      if (r.status !== 0 && r.status !== 1) no(`cannot count the lines of ${path} at ${head.slice(0, 9)}: ${(r.stderr || '').trim() || `git exited ${r.status}`}`)
      // -z prints each file as <head>:<path>\0<count>\n; a directory lists its files, never itself.
      const own = (r.stdout || '').split('\n').find((l) => l.startsWith(`${head}:${path}\0`))
      lines.set(path, own ? Number(own.slice(own.indexOf('\0') + 1)) : 0)
    }
    return lines.get(path)
  }
  const rejected = []
  const out = findings.map((f) => {
    if (!f || typeof f !== 'object' || f.severity === 'PREMISE' || f.result != null) return f
    const m = /^([^\s:]+):(\d+)/.exec(String(f.where ?? ''))
    if (!m) return f
    let path = m[1]
    if (path.startsWith('/')) {
      if (!path.startsWith(`${top}/`)) return f
      path = path.slice(top.length + 1).replace(/^\/+/, '')
    }
    // One file has many spellings (./a, a//b, a/./b, a/x/../b): the tree knows only the plain one.
    path = posix.normalize(path)
    if (path === '..' || path.startsWith('../') || path === '.') return f
    const line = Number(m[2])
    if (line >= 1 && line <= lineCount(path)) return f
    const marked = { ...f, result: 'REJECTED', anchor: ANCHOR_MISSING }
    delete marked.refuted_by
    rejected.push(marked)
    return marked
  })
  return { findings: out, rejected }
}

// How the anchor check reports a finding it rejected.
export const anchorLine = (f, head) => `${f.id ?? 'finding'} REJECTED: anchor not found, ${f.where} does not exist at ${head.slice(0, 7)}`

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
  const later = t.postMerge.length ? `criteria left for after the merge: ${t.postMerge.length}` : ''
  const anchors = t.anchorMissing ? `findings rejected for a missing anchor: ${t.anchorMissing}` : ''
  const kept = [carried, accepted, later, anchors].filter(Boolean)
  const verdict = isClean(n)
    ? `${carried ? 'No P0 or P1 findings' : 'No P0, P1 or P2 findings'}${kept.map((k) => `; ${k}`).join('')}`
    : `not clean: ${[...parts, ...kept].join(', ')}`
  const range = t.targeted ? `, targeted after base range ${t.targeted.range}` : t.since ? `, fix range ${t.since.slice(0, 7)}..${t.sha.slice(0, 7)}` : ''
  const fell = t.fallback.length ? ` · ${plural(t.fallback.length, 'fallback seat')} (${t.fallback.join(', ')})` : ''
  const heading = `**desk-review, round ${t.round}${range}: ${verdict} at \`${t.sha.slice(0, 7)}\`** · ${how(t)}${fell}`
  const lines = ['<!-- desk-review:local -->', marker, heading]
  if (t.since) lines.push(`<!-- desk-review:carried v=1 p2=${t.carried.length} since=${t.since} -->`)
  // Round 1 has no fix range, so its line, only when it carried a split P2, has no since.
  else if (t.carried.length) lines.push(`<!-- desk-review:carried v=1 p2=${t.carried.length} -->`)
  if (t.accepted.length) lines.push(`<!-- desk-review:accepted v=1 gaps=${t.accepted.length} -->`)
  if (t.postMerge.length) lines.push(postMergeMarker(t.postMerge))
  lines.push(`<!-- desk-review:method v=1 fallback=${t.fallback.length} -->`)
  // JSON with every ">" escaped, so no path can close the comment.
  if (t.restsOn) lines.push(`<!-- desk-review:rests-on v=1 files=${JSON.stringify(t.restsOn).replace(/>/g, '\\u003e')} -->`)
  if (t.targeted) lines.push(...targetedLines(t))
  return lines.join('\n')
}

// The post-merge line: the count, then the items as JSON with every ">" escaped, so no step can close
// the comment. desk/bin/undraft.mjs postMergeIn reads it back.
const postMergeMarker = (items) => `<!-- desk-review:post-merge v=1 gaps=${items.length} items=${JSON.stringify(items).replace(/>/g, '\\u003e')} -->`

// What a targeted round re-read at this head and what it carried from the clean review it follows.
const code = (p) => `\`${p.replace(/`/g, "'")}\``
function targetedLines(t) {
  const x = t.targeted
  const users = x.users.length ? `the PR's code that uses them, ${x.users.map(code).join(', ')}` : "the PR's code that uses them (none of its changed files names one)"
  return [
    `<!-- desk-review:targeted v=1 from=${x.from} range=${x.range} -->`,
    `Targeted re-review at \`${t.sha.slice(0, 7)}\`: re-reviewed ${x.files.map(code).join(', ')}, which the base range \`${x.range}\` changed, and ${users}. ` +
      `Carried, not re-read: the rest of the review posted on \`${x.from.slice(0, 7)}\`, whose own diff is unchanged.`,
  ]
}

const how = (t) => `${t.vendor === 'codex-cross'
  ? 'codex read the diff cold · refuted cross-vendor'
  : `same-vendor${t.codexRead ? '' : ' · codex did not read the diff'}`}${codexRuns(t)}`
const codexRuns = (t) => {
  const runs = CODEX_ROLES.filter((role) => t.codex?.[role]).map((role) => `${role} ${t.codex[role].replace(':', ' at ')}`)
  const on = t.codex?.login ? ` · on Codex login${t.codex.login.includes(',') ? 's' : ''} ${t.codex.login}` : ''
  return runs.length ? ` · codex ${runs.join(', ')}${on}` : on
}

// The PR body's line on how the review ran: its rounds, its vendor and its fallback seats.
export function methodLine(r) {
  const t = tally(r)
  const roles = t.fallback.length ? ` (${t.fallback.join(', ')})` : ''
  return `desk-review: ${plural(t.round, 'round')}, last at \`${t.sha.slice(0, 7)}\` · ${how(t)} · fallback seats: ${t.fallback.length}${roles}`
}

// Who ran a round: desk-ticket's Stage 4b self-review, a review of the PR, or the blind audit.
const REVIEWERS = ['self', 'pr', 'audit']

// The round's findings as one marker line the pass records in the ticket's findings file: the counts
// the verdict attests, how many of them the round then fixed, whether it carried a clean review past a
// base move (a targeted round), and who refuted (claude, codex, mixed, or null with nothing refuted).
export function findingsLine(r, reviewer) {
  if (!REVIEWERS.includes(reviewer)) no(`--reviewer must be one of ${REVIEWERS.join(', ')}`)
  const t = tally(r)
  return `AUTOPILOT_FINDINGS: ${JSON.stringify({ round: t.round, reviewer, head: t.sha, p0: t.n.p0, p1: t.n.p1, p2: t.n.p2,
    fixed: t.fixed, carried: !!t.targeted, refuter_vendor: t.refuterVendor })}`
}

// The PR body's section for the carried findings, file:line each, or '' when none are carried.
export function carriedSection(r) {
  const t = tally(r)
  if (!t.carried.length) return ''
  const rows = t.carried.map((f) => `- \`${f.where}\`${f.title ? ` ${f.title}` : ''}${f.id ? ` (${f.id})` : ''}${f.follow_up ? `, follow-up ${f.follow_up}` : ''}`)
  return [
    '### Carried review findings',
    t.since
      ? `desk-review round ${t.round} read the fix range ${t.since.slice(0, 7)}..${t.sha.slice(0, 7)}. ` +
        `These P2 findings are left for later: from round ${FIX_RANGE_ROUND} only P0 and P1 block.`
      : `desk-review round ${t.round} read the whole branch at ${t.sha.slice(0, 7)}. ` +
        'These P2 findings were split to the follow-up tickets named, rather than fixed here.',
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

// The review body's section for the criteria left for after the merge: each with what it needs and the
// step that checks it; '' when there are none. Its heading never names requirement gaps, which a reader
// of the body (fix-tries.mjs reviewGaps) takes for the open ones.
export function postMergeSection(r) {
  const t = tally(r)
  if (!t.postMerge.length) return ''
  return [
    '### After the merge',
    'Only a live system can check these criteria, so the verdict does not count them in `gaps`. Each becomes a follow-on step for after the merge:',
    ...t.postMerge.map((p) => `- ${p.gap} (needs ${p.needs}): ${p.step}`),
  ].join('\n')
}

// The review body's section for the criteria the ticket's Decisions settle: each with the entry it
// rests on and who decided; '' when there are none. Its heading never names requirement gaps, which a
// reader of the body (fix-tries.mjs reviewGaps) takes for the open ones.
export function settledSection(r) {
  const t = tally(r)
  if (!t.settled.length) return ''
  return [
    '### Settled by the ticket\'s Decisions',
    'A dated Decisions entry on the ticket settles each of these criteria, so the verdict counts it met, as the entry amends it:',
    ...t.settled.map((x) => `- ${x.gap}: decided by ${x.who} on ${x.date}: "${x.entry}"`),
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
} else if (isMain && process.argv[2] === '--anchors') {
  // node verdict.mjs --anchors <results.json> <head sha>: run from a checkout holding head.
  try {
    const [file, head, ...rest] = process.argv.slice(3)
    if (!file || !head || rest.length) no('usage: verdict.mjs --anchors <results.json> <full head sha>')
    let r
    try { r = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { no(`cannot read ${file}: ${e.message}`) }
    if (!r || typeof r !== 'object' || !Array.isArray(r.findings)) no(`${file} has no findings list`)
    const { findings, rejected } = checkAnchors(r.findings, head)
    if (rejected.length) writeFileSync(file, `${JSON.stringify({ ...r, findings }, null, 2)}\n`)
    for (const f of rejected) process.stdout.write(`${anchorLine(f, head)}\n`)
    process.stdout.write(`anchors: ${plural(rejected.length, 'finding')} rejected for a missing anchor, ${findings.length - rejected.length} left as they were\n`)
  } catch (e) {
    process.stderr.write(`verdict.mjs: ${e.message}\n`)
    process.exit(2)
  }
} else if (isMain) {
  try {
    const args = process.argv.slice(2)
    let reviewer = null
    if (args[0] === '--findings') {
      const at = args.indexOf('--reviewer')
      if (at < 0) no('usage: verdict.mjs --findings <results.json> --reviewer <self|pr>')
      reviewer = args.splice(at, 2)[1] ?? ''
    }
    const modes = { '--carried': carriedSection, '--method': methodLine, '--accepted': acceptedSection, '--post-merge': postMergeSection, '--settled': settledSection, '--findings': (r) => findingsLine(r, reviewer) }
    const mode = Object.hasOwn(modes, args[0] ?? '') ? args[0] : null
    const [file, ...rest] = mode ? args.slice(1) : args
    if (!file || rest.length) no('usage: verdict.mjs [--carried | --method | --accepted | --post-merge | --settled | --findings … --reviewer <self|pr>] <results.json>')
    let r
    try { r = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { no(`cannot read ${file}: ${e.message}`) }
    const refused = validateResults(r)
    if (refused) no(refused)
    const out = mode ? modes[mode](r) : render(r)
    if (out) process.stdout.write(`${out}\n`)
  } catch (e) {
    process.stderr.write(`verdict.mjs: ${e.message}\n`)
    process.exit(2)
  }
}
