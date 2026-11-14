// suite: review findings (each review round's counts, harvested from the marker it prints)
// verdict.mjs --findings prints a round's counts from its results file, and the pass records each
// AUTOPILOT_FINDINGS line a worker printed in the ticket's findings file, once, and a round that ended
// without one in its run record. Pure: no git, no GitHub; a scratch state directory only.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findingsLine, render, VerdictError } from '../skills/desk-review/bin/verdict.mjs'
import { reviewRounds, recordFindings, recordCarry, parseFindings, findingsPath, runsPath } from '../desk/bin/findings.mjs'
import { spawnRecords } from '../desk/bin/phase0-report.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'skills', 'desk-review', 'bin', 'verdict.mjs')
let fails = 0
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`) }

const SHA = '0123456789abcdef0123456789abcdef01234567'
const PREV = 'fedcba9876543210fedcba9876543210fedcba98'
const seat = (role, vendor = 'claude') => ({ role, vendor, status: 'ran' })
const base = (o = {}) => ({ sha: SHA, round: 1, gaps: 0, skipped_files: 0, seats: [seat('correctness'), seat('codex', 'codex')], findings: [], ...o })
const f = (o = {}) => ({ id: 'F1', seat: 'correctness', severity: 'P1', where: 'src/a.ts:12', result: 'CONFIRMED', refuted_by: 'codex', ...o })
const line = (r, who) => JSON.parse(findingsLine(r, who).replace(/^AUTOPILOT_FINDINGS: /, ''))
const refused = (fn) => { try { fn(); return 'accepted' } catch (e) { return e instanceof VerdictError ? e.message : `threw ${e}` } }

// A worker log in stream-json: each string is one assistant text block.
const said = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const logOf = (...texts) => texts.map(said).join('\n') + '\n'
const marker = (o) => `AUTOPILOT_FINDINGS: ${JSON.stringify({ round: 1, reviewer: 'self', head: SHA, p0: 0, p1: 0, p2: 0, fixed: 0, carried: false, refuter_vendor: 'codex', ...o })}`

const dir = mkdtempSync(join(tmpdir(), 'review-findings-'))
const jsonl = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
let n = 0
const harvest = (key, ...texts) => {
  const log = join(dir, `w${++n}.log`)
  writeFileSync(log, logOf(...texts))
  return recordFindings(dir, key, log, 'sess-1')
}

// ---- AC1: a Stage 4b review that finds 1 P0 and 1 P2 and fixes both
const ac1 = base({ findings: [f({ severity: 'P0', fixed: true }), f({ id: 'F2', severity: 'P2', fixed: true })] })
const l1 = line(ac1, 'self')
t('AC1 the line counts what the round found and fixed', [l1.reviewer, l1.p0, l1.p1, l1.p2, l1.fixed].join(), 'self,1,0,1,2')
t('AC1 fixed leaves the verdict untouched', render(ac1), render(base({ findings: [f({ severity: 'P0' }), f({ id: 'F2', severity: 'P2' })] })))
harvest('AC-1', 'AUTOPILOT_STAGE: 4b/9 self-review', findingsLine(ac1, 'self'), 'AUTOPILOT_STAGE: 5/9 evidence')
const w1 = jsonl(findingsPath(dir, 'AC-1'))
t('AC1 one line is appended to the ticket\'s findings file', w1.length, 1)
t('AC1 its fields', [w1[0].ticket, w1[0].reviewer, w1[0].p0, w1[0].p1, w1[0].p2, w1[0].fixed].join(), 'AC-1,self,1,0,1,2')
t('AC1 a round with its line is not noted missing', jsonl(runsPath(dir, 'AC-1')).length, 0)

// ---- AC2: a PR review round on head abc1234 that finds 2 P1 and fixes none
const ac2 = base({ findings: [f(), f({ id: 'F2' })] })
t('AC2 verdict.mjs counts 2 P1 and none fixed', [line(ac2, 'pr').p1, line(ac2, 'pr').fixed].join(), '2,0')
harvest('AC-2', marker({ reviewer: 'pr', head: 'abc1234', p1: 2 }))
const w2 = jsonl(findingsPath(dir, 'AC-2'))[0]
t('AC2 its line has reviewer pr, head abc1234, p1=2, fixed=0', [w2.reviewer, w2.head, w2.p1, w2.fixed].join(), 'pr,abc1234,2,0')

// ---- AC3: three rounds, three lines, and a second read of the same log adds none
const r3 = (round) => marker({ round, ...(round > 1 ? {} : { p1: 1, fixed: 1 }) })
harvest('AC-3', 'AUTOPILOT_STAGE: 4b/9 self-review', r3(1), r3(2), r3(3), 'AUTOPILOT_STAGE: 5/9 evidence')
t('AC3 three lines with rounds 1, 2 and 3', jsonl(findingsPath(dir, 'AC-3')).map((l) => l.round).join(), '1,2,3')
const again = join(dir, 'again.log')
writeFileSync(again, logOf(r3(1), r3(2), r3(3)))
recordFindings(dir, 'AC-3', again, 'sess-1')
t('AC3 harvesting the log again writes nothing new', jsonl(findingsPath(dir, 'AC-3')).length, 3)

// ---- AC4: a review that ends without printing the findings marker
const verdictOut = render(base({ findings: [f()] }))
harvest('AC-4', 'AUTOPILOT_STAGE: 4b/9 self-review', verdictOut, 'AUTOPILOT_STAGE: 5/9 evidence')
t('AC4 no line is written', jsonl(findingsPath(dir, 'AC-4')).length, 0)
const runs4 = jsonl(runsPath(dir, 'AC-4'))
t('AC4 the run record notes the round\'s findings were missing', JSON.stringify(runs4.map((r) => r.findings_missing)), JSON.stringify([{ head: SHA, round: 1 }]))
t('AC4 the note is not read as a worker start', spawnRecords(dir).length, 0)
harvest('AC-4b', 'AUTOPILOT_STAGE: 4b/9 self-review', 'Review done, fixes committed.', 'AUTOPILOT_DONE: pr=12 jira=Review')
t('AC4 a Stage 4b closed with no line is noted too', JSON.stringify(jsonl(runsPath(dir, 'AC-4b'))[0]?.findings_missing), '{"reviewer":"self","stage":1}')
harvest('AC-4c', 'AUTOPILOT_STAGE: 4b/9 self-review', 'AUTOPILOT_STAGE: 5/9 evidence', marker({}))
t('AC4 a line printed just after the stage moved on still counts', jsonl(runsPath(dir, 'AC-4c')).length, 0)
harvest('AC-4d', 'AUTOPILOT_STAGE: 4b/9 self-review', 'AUTOPILOT_PARK: waiting on the test lock')
t('AC4 a Stage 4b still being worked is not missing', jsonl(runsPath(dir, 'AC-4d')).length, 0)
harvest('AC-4e', 'AUTOPILOT_STAGE: 4b/9 self-review', 'AUTOPILOT_FINDINGS: {"round": 1}', 'AUTOPILOT_STAGE: 5/9 evidence')
t('AC4 a line that does not read is noted, never written', [jsonl(findingsPath(dir, 'AC-4e')).length, jsonl(runsPath(dir, 'AC-4e')).some((r) => r.findings_unreadable)].join(), '0,true')
harvest('AC-4f', 'AUTOPILOT_STAGE: 4b/9 self-review', 'SELF-REVIEW skipped: §4 Local review command is none', 'AUTOPILOT_STAGE: 5/9 evidence')
t('AC4 a Stage 4b stated as skipped is not missing', jsonl(runsPath(dir, 'AC-4f')).length, 0)
harvest('AC-4g', 'AUTOPILOT_STAGE: 4b/9 self-review', 'AUTOPILOT_STAGE: 5/9 evidence', 'AUTOPILOT_DONE: pr=3 jira=Review review=SKIPPED (none configured)')
t('AC4 a Stage 4b its DONE says was skipped is not missing', jsonl(runsPath(dir, 'AC-4g')).length, 0)
// A round that parked at its verdict and printed its line in a later session's log.
harvest('AC-4h', marker({ reviewer: 'pr', round: 3, p1: 1 }))
harvest('AC-4h', render(base({ round: 3, since: PREV, findings: [f()] })))
t('AC4 a verdict an earlier log recorded the line for is not missing', jsonl(runsPath(dir, 'AC-4h')).length, 0)
const toolOnly = join(dir, 'tool.log')
writeFileSync(toolOnly, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: marker({}) }] } })}\n`)
t('AC4 a marker only in a tool result is not the worker printing it', reviewRounds(readFileSync(toolOnly, 'utf8')).lines.length, 0)

// ---- AC5: a review whose verdict was carried over a rebase
const targeted = base({ round: 2, since: PREV, targeted: { from: PREV, range: 'aaaaaaa..bbbbbbb', files: ['src/a.ts'], users: [] } })
t('AC5 a targeted round prints carried true', line(targeted, 'pr').carried, true)
t('AC5 a full round prints carried false', line(base(), 'pr').carried, false)
harvest('AC-5', findingsLine(targeted, 'pr'))
t('AC5 its recorded line has carried true', jsonl(findingsPath(dir, 'AC-5'))[0]?.carried, true)
// The pass carrying a verdict to a rebased head with no round run there.
const HEAD2 = '89abcdef0123456789abcdef0123456789abcdef'
const reviews = [{ author: { login: 'me' }, body: render(base({ sha: PREV })) }]
const carry = (key, from = PREV) => recordCarry(dir, key, { head: HEAD2, from, reviews, handle: 'me' })
const carriedLine = carry('AC-5c')
t('AC5 a carry the pass reads writes a pr line at the new head', [carriedLine?.reviewer, carriedLine?.head, carriedLine?.round, carriedLine?.fixed, carriedLine?.carried, carriedLine?.from].join(), `pr,${HEAD2},1,0,true,${PREV}`)
carry('AC-5c')
t('AC5 the same carry read on the next pass adds nothing', jsonl(findingsPath(dir, 'AC-5c')).length, 1)
t('AC5 a verdict not posted on the carried commit writes nothing', carry('AC-5d', SHA), null)
t('AC5 a verdict someone else posted writes nothing', recordCarry(dir, 'AC-5e', { head: HEAD2, from: PREV, reviews, handle: 'other' }), null)

// ---- refuter vendor and what fixed may mark
t('refuter_vendor: codex refuted every finding', line(base({ findings: [f()] }), 'self').refuter_vendor, 'codex')
t('refuter_vendor: both vendors refuted', line(base({ findings: [f(), f({ id: 'F2', refuted_by: 'claude' })] }), 'self').refuter_vendor, 'mixed')
t('refuter_vendor: nothing refuted', line(base(), 'self').refuter_vendor, null)
t('a carried finding is not fixed', refused(() => line(base({ round: 2, since: PREV, findings: [f({ severity: 'P2', carried: true, fixed: true })] }), 'self')), 'finding F1: a carried finding is left unfixed, so it is not fixed')
t('a rejected finding is not fixed', refused(() => line(base({ findings: [f({ result: 'REJECTED', fixed: true })] }), 'self')), 'finding F1: only an outstanding finding can be fixed')
t('fixed is true or false', refused(() => line(base({ findings: [f({ fixed: 1 })] }), 'self')), 'finding F1: fixed must be true or false')
t('a duplicate dropped behind its target is not counted fixed', line(base({ findings: [f({ fixed: true }), f({ id: 'F2', result: 'DUPLICATE', duplicate_of: 'F1', fixed: true })] }), 'self').fixed, 1)
t('an unknown reviewer is refused', refused(() => findingsLine(base(), 'bot')), '--reviewer must be one of self, pr, audit')
t('a line fixing more than it found does not read', parseFindings(JSON.stringify({ round: 1, reviewer: 'self', head: SHA, p0: 0, p1: 1, p2: 0, fixed: 2, carried: false })).why, 'fixed is more than the round found')

// ---- the CLI
const results = join(dir, 'results.json')
writeFileSync(results, JSON.stringify(ac1))
const cli = spawnSync(process.execPath, [SCRIPT, '--findings', results, '--reviewer', 'self'], { encoding: 'utf8' })
t('CLI prints the findings line', cli.stdout.trim(), findingsLine(ac1, 'self'))
const noWho = spawnSync(process.execPath, [SCRIPT, '--findings', results], { encoding: 'utf8' })
t('CLI refuses --findings without --reviewer', [noWho.status, /--reviewer/.test(noWho.stderr)].join(), '2,true')
t('CLI default mode is unchanged', spawnSync(process.execPath, [SCRIPT, results], { encoding: 'utf8' }).stdout.trim(), render(ac1))

rmSync(dir, { recursive: true, force: true })
if (fails) { console.log(`\n${fails} failed`); process.exit(1) }
console.log('\nall passed')
