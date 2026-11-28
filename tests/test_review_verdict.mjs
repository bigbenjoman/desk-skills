// suite: desk-review verdict (never clean with an open finding, partial or a dead seat)
// layer: L2
// desk-review's verdict script: the counts, the vendor and the heading come from the finder and
// refuter results, and no results with an open finding, partial coverage or a dead seat can print
// the clean verdict. No GitHub and no codex; git only in a scratch repo, for the anchor check.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, tally, isClean, carriedSection, acceptedSection, postMergeSection, settledSection, settlingEntry, methodLine, CLEAN, VerdictError, gateRejects, validateResults, checkAnchors, anchorLine } from '../skills/desk-review/bin/verdict.mjs'
import { reviewGaps, reviewFix, personGapsCall, personGapsIn, measureOf, personGapLines, ANSWERED_ITEM } from '../desk/bin/fix-tries.mjs'
import { settledCriteria, answerEntry, ticketDecisions } from '../desk/bin/decisions-change.mjs'
import { parseVerdict as undraftVerdict, verdictAt, postMergeIn, postMergeSteps } from '../desk/bin/undraft.mjs'
import { scratch } from './scratch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'skills', 'desk-review', 'bin', 'verdict.mjs')
let fails = 0
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`) }

const SHA = '0123456789abcdef0123456789abcdef01234567'
const seat = (role, vendor = 'claude', status = 'ran') => ({ role, vendor, status })
const base = (o = {}) => ({ sha: SHA, round: 1, gaps: 0, skipped_files: 0,
  seats: [seat('correctness'), seat('codex', 'codex')], findings: [], ...o })
const f = (o = {}) => ({ id: 'F1', seat: 'correctness', severity: 'P1', where: 'src/a.ts:12', result: 'CONFIRMED', refuted_by: 'codex', ...o })
const marker = (r) => render(r).split('\n')[1]
const heading = (r) => render(r).split('\n')[2]
const reads = (r) => marker(r).includes(` ${CLEAN} `)
const refused = (r) => { try { render(r); return 'accepted' } catch (e) { return e instanceof VerdictError ? e.message : `threw ${e}` } }

// ---- the four verification cases on the ticket
t('clean: marker carries the clean verdict', reads(base()), true)
t('clean: codex read cold and refuted, so codex-cross', marker(base()).includes(' vendor=codex-cross round=1 -->'), true)
t('clean: heading leads with no findings', heading(base()).startsWith('**desk-review, round 1: No P0, P1 or P2 findings at `0123456`**'), true)
t('open P1: not clean', reads(base({ findings: [f()] })), false)
t('open P1: counted', marker(base({ findings: [f()] })).includes(' p1=1 '), true)
t('open P1: heading says so', heading(base({ findings: [f()] })).includes('not clean: 1 P1 outstanding'), true)
t('partial: not clean', reads(base({ skipped_files: 3 })), false)
t('partial: counted', marker(base({ skipped_files: 3 })).includes(' partial=3 '), true)
t('partial: heading names the files', heading(base({ skipped_files: 3 })).includes('3 files not reviewed'), true)
const died = base({ seats: [seat('correctness', 'claude', 'died'), seat('codex', 'codex')] })
t('reviewer died: not clean', reads(died), false)
t('reviewer died: counted in partial', marker(died).includes(' partial=1 '), true)
t('reviewer died: heading names the seat', heading(died).includes('correctness seat died'), true)
const codexDied = base({ seats: [seat('correctness'), seat('codex', 'codex', 'died')] })
t('codex cold died: not clean', reads(codexDied), false)
t('codex cold died: same-vendor', marker(codexDied).includes(' vendor=same-vendor '), true)
// With the codex lever on: a timed-out call is a dead seat that says why, and the record shows the
// model and effort each codex role ran at.
const timedOut = base({ seats: [seat('correctness'), { ...seat('codex', 'codex', 'died'), reason: 'timed out' }] })
t('DS-445 AC2 codex timed out: not clean, same-vendor', [reads(timedOut), marker(timedOut).includes(' partial=1 vendor=same-vendor ')].join(), 'false,true')
t('DS-445 AC2 codex timed out: the heading says why it died', heading(timedOut).includes('codex (timed out) seat died'), true)
t('DS-445 a reason is only for a seat that died', refused(base({ seats: [seat('correctness'), { ...seat('codex', 'codex'), reason: 'timed out' }] })), 'seat codex: reason says why a seat died, as "timed out"')
const runs = base({ seats: [seat('correctness'), seat('codex', 'codex')], codex: { finder: 'gpt-6.1-sol:medium', refuter: 'gpt-6.1-sol:low' } })
t('DS-445 AC4 the heading shows the model and effort each codex role ran at', heading(runs).endsWith('refuted cross-vendor · codex finder gpt-6.1-sol at medium, refuter gpt-6.1-sol at low'), true)
t('DS-445 AC4 and so does the PR body line', methodLine(runs).includes('· codex finder gpt-6.1-sol at medium, refuter gpt-6.1-sol at low ·'), true)
t('DS-445 AC4 the counts are untouched', marker(runs), marker(base({ seats: [seat('correctness'), seat('codex', 'codex')] })))
t('DS-445 a codex run that is not <model>:<effort> is refused', refused(base({ codex: { finder: 'gpt-6.1-sol' } })), 'codex.finder is <model>:<effort>, as desk-codex settings prints it')
t('DS-445 an unknown codex role is refused', refused(base({ codex: { probe: 'a:low' } })), 'unknown field codex.probe')
const onLogins = base({ codex: { finder: 'gpt-6.1-sol:medium', refuter: 'gpt-6.1-sol:low', login: 'default, login-2' } })
t('DS-470 AC1 the heading names the Codex logins the calls ran on', heading(onLogins).endsWith('refuter gpt-6.1-sol at low · on Codex logins default, login-2'), true)
t('DS-470 AC1 one login reads singular', heading(base({ codex: { login: 'login-2' } })).endsWith('refuted cross-vendor · on Codex login login-2'), true)
t('DS-470 AC1 the counts are untouched', marker(onLogins), marker(base()))
t('DS-470 a found login named after its folder is accepted', heading(base({ codex: { login: 'default, work@example.com' } })).endsWith('· on Codex logins default, work@example.com'), true)
for (const login of ['', 'a\nb', 'a, ', ' a', 7]) t(`DS-470 a login that is not a name is refused: ${JSON.stringify(login)}`, refused(base({ codex: { login } })), 'codex.login names the Codex logins the calls ran on, as desk-codex prints them, comma-separated')

// ---- refutation outcomes and the vendor
t('rejected finding: clean', reads(base({ findings: [f({ result: 'REJECTED' })] })), true)
t('duplicate finding: not counted twice', marker(base({ findings: [f(), f({ id: 'F2', result: 'DUPLICATE', duplicate_of: 'F1' })] })).includes(' p1=1 '), true)
// The merge that hides a finding: codex confirms F1, Claude rejects codex's C1 at the same line, and F1 is
// recorded as the duplicate. F1 still stands.
const hidden = base({ findings: [f({ id: 'C1', seat: 'codex', refuted_by: 'claude', result: 'REJECTED' }), f({ result: 'DUPLICATE', duplicate_of: 'C1' })] })
t('duplicate of a rejected finding: still counted, not clean', `${reads(hidden)} ${marker(hidden).includes(' p1=1 ')}`, 'false true')
const milder = base({ findings: [f({ id: 'F1', severity: 'P2' }), f({ id: 'F2', severity: 'P0', result: 'DUPLICATE', duplicate_of: 'F1' })] })
t('duplicate of a milder finding: counted at its own severity', marker(milder).includes(' p0=1 p1=0 p2=1 '), true)
const unref = base({ findings: [f({ result: 'UNREFUTED', refuted_by: undefined })] })
t('unrefuted: counted in its p field and in unrefuted', marker(unref).includes(' p1=1 p2=0 deferred=0 gaps=0 unrefuted=1 '), true)
t('unrefuted: same-vendor', marker(unref).includes(' vendor=same-vendor '), true)
t('deferred: counted in deferred and its p field', marker(base({ findings: [f({ severity: 'P2', deferred: true })] })).includes(' p2=1 deferred=1 '), true)
t('open gap: not clean', reads(base({ gaps: 1 })), false)
t('open gap: heading', heading(base({ gaps: 2 })).includes('2 requirement gaps open'), true)
t('premise: counted nowhere', reads(base({ findings: [f({ severity: 'PREMISE', result: undefined, refuted_by: undefined })] })), true)
const codexFinding = base({ seats: [seat('correctness'), seat('codex', 'codex')], findings: [f({ seat: 'codex', refuted_by: 'claude', result: 'REJECTED' })] })
t('codex finding refuted by Claude: still codex-cross', marker(codexFinding).includes(' vendor=codex-cross '), true)
t('Claude finding refuted by Claude: same-vendor', marker(base({ findings: [f({ refuted_by: 'claude', result: 'REJECTED' })] })).includes(' vendor=same-vendor '), true)
t('codex finding refuted by codex: same-vendor', marker(base({ findings: [f({ seat: 'codex', refuted_by: 'codex', result: 'REJECTED' })] })).includes(' vendor=same-vendor '), true)
const noCodex = base({ seats: [seat('correctness')] })
t('no codex seat: same-vendor, still clean', `${reads(noCodex)} ${marker(noCodex).includes(' vendor=same-vendor ')}`, 'true true')
t('no codex seat: heading says codex did not read', heading(noCodex).endsWith('same-vendor · codex did not read the diff'), true)

// ---- exhaustively: clean exactly when nothing is open, nothing skipped, no seat died, no gap
let combos = 0, wrong = 0
for (const severity of ['P0', 'P1', 'P2', 'PREMISE', null]) {
  for (const result of ['CONFIRMED', 'REJECTED', 'UNREFUTED']) {
    for (const deferred of [false, true]) {
      for (const status of ['ran', 'died']) {
        for (const codexStatus of ['ran', 'died', null]) {
          for (const skipped of [0, 1]) {
            for (const gaps of [0, 1]) {
              const seats = [seat('correctness'), seat('lena-2', 'claude', status), ...(codexStatus ? [seat('codex', 'codex', codexStatus)] : [])]
              const findings = severity ? [f({ seat: 'correctness', severity, deferred,
                ...(severity === 'PREMISE' ? { result: undefined, refuted_by: undefined } : { result, refuted_by: result === 'UNREFUTED' ? undefined : 'codex' }) })] : []
              const r = base({ seats, findings, skipped_files: skipped, gaps })
              const open = severity && severity !== 'PREMISE' && (result === 'CONFIRMED' || result === 'UNREFUTED')
              const shouldBeClean = !open && status === 'ran' && codexStatus !== 'died' && !skipped && !gaps
              combos++
              if (reads(r) !== shouldBeClean || isClean(tally(r).n) !== shouldBeClean) wrong++
              if (reads(r) && !heading(r).includes('No P0, P1 or P2 findings')) wrong++
              if (!reads(r) && !heading(r).includes('not clean: ')) wrong++
            }
          }
        }
      }
    }
  }
}
t(`every combination (${combos}) reads clean only when it is`, wrong, 0)

// Every merge of one duplicate into another finding: clean only when neither stands.
let dupCombos = 0, dupWrong = 0
const RANK = { P0: 0, P1: 1, P2: 2 }
for (const targetResult of ['CONFIRMED', 'REJECTED', 'UNREFUTED']) {
  for (const targetSev of ['P0', 'P1', 'P2']) {
    for (const dupSev of ['P0', 'P1', 'P2']) {
      const r = base({ findings: [
        f({ id: 'C1', seat: 'codex', severity: targetSev, result: targetResult, refuted_by: targetResult === 'UNREFUTED' ? undefined : 'claude' }),
        f({ id: 'F1', severity: dupSev, result: 'DUPLICATE', duplicate_of: 'C1' })] })
      const targetOpen = targetResult !== 'REJECTED'
      const dupStands = !(targetOpen && RANK[targetSev] <= RANK[dupSev])
      const n = tally(r).n
      dupCombos++
      if (reads(r) !== (!targetOpen && !dupStands)) dupWrong++
      if (n.p0 + n.p1 + n.p2 !== (targetOpen ? 1 : 0) + (dupStands ? 1 : 0)) dupWrong++
    }
  }
}
t(`every duplicate merge (${dupCombos}) keeps a finding that stands`, dupWrong, 0)

// ---- round 3: the fix range, and P2 findings carried rather than blocking
const SINCE = 'fedcba9876543210fedcba9876543210fedcba98'
const r3 = (findings = [], o = {}) => base({ round: 3, since: SINCE, findings, ...o })
const p2 = (o = {}) => f({ severity: 'P2', carried: true, title: 'name reads as a count', ...o })
t('round 3: heading names the fix range it read', heading(r3()).startsWith('**desk-review, round 3, fix range fedcba9..0123456: No P0, P1 or P2 findings at `0123456`**'), true)
t('round 3: the carried line records the range', render(r3()).split('\n')[3], `<!-- desk-review:carried v=1 p2=0 since=${SINCE} -->`)
t('round 1: no carried line', render(base()).includes('desk-review:carried'), false)
t('round 3: the method line follows the carried line', render(r3()).split('\n')[4], '<!-- desk-review:method v=1 fallback=0 -->')
const onlyCarried = r3([p2(), p2({ id: 'F2', where: 'src/b.ts:4' })])
t('only carried P2s: the marker reads clean', reads(onlyCarried), true)
t('only carried P2s: p2 is 0 in the marker', marker(onlyCarried).includes(' p1=0 p2=0 deferred=0 '), true)
t('only carried P2s: the carried line counts them', render(onlyCarried).split('\n')[3].includes(' p2=2 '), true)
t('only carried P2s: heading says none block and how many carried', heading(onlyCarried).includes(': No P0 or P1 findings; P2 findings carried: 2 at `0123456`**'), true)
t('only carried P2s: tally counts them apart from n', `${tally(onlyCarried).carried.length} ${isClean(tally(onlyCarried).n)}`, '2 true')
const carriedAndP1 = r3([p2(), f({ id: 'F2' })])
t('a carried P2 beside an open P1: not clean', reads(carriedAndP1), false)
t('a carried P2 beside an open P1: heading names both', heading(carriedAndP1).includes('not clean: 1 P1 outstanding, P2 findings carried: 1'), true)
t('an uncarried P2 on round 3 still blocks', reads(r3([f({ severity: 'P2' })])), false)
t('a carried P2 whose refutation did not run still blocks', reads(r3([p2({ result: 'UNREFUTED', refuted_by: undefined })])), false)
t('a carried duplicate of a carried P2 counts once', render(r3([p2(), p2({ id: 'F2', result: 'DUPLICATE', duplicate_of: 'F1' })])).split('\n')[3].includes(' p2=1 '), true)
const section = carriedSection(onlyCarried).split('\n')
t('carried section: its heading', section[0], '### Carried review findings')
t('carried section: names the fix range', section[1].includes('fix range fedcba9..0123456'), true)
t('carried section: file:line each', section.slice(2).join('|'), '- `src/a.ts:12` name reads as a count (F1)|- `src/b.ts:4` name reads as a count (F2)')
t('carried section: empty when nothing is carried', carriedSection(r3()), '')

// ---- round 2 reads the fix range from round 1's reviewed SHA, and carries P2s as round 3 does
const r2 = (findings = [], o = {}) => base({ round: 2, since: SINCE, findings, ...o })
t('DS-368 AC1 round 2: heading names the fix range it read', heading(r2()).startsWith('**desk-review, round 2, fix range fedcba9..0123456: No P0, P1 or P2 findings at `0123456`**'), true)
t('DS-368 AC1 round 2: the carried line records the range', render(r2()).split('\n')[3], `<!-- desk-review:carried v=1 p2=0 since=${SINCE} -->`)
const r2Carried = r2([p2(), p2({ id: 'F2', where: 'src/b.ts:4' })])
t('DS-368 AC2 round 2, only carried P2s: the marker reads clean', reads(r2Carried), true)
t('DS-368 AC2 round 2, only carried P2s: heading says none block and how many carried', heading(r2Carried).includes(': No P0 or P1 findings; P2 findings carried: 2 at `0123456`**'), true)
t('DS-368 AC2 round 2: the carried section names the range and the round', carriedSection(r2Carried).split('\n')[1], 'desk-review round 2 read the fix range fedcba9..0123456. These P2 findings are left for later: from round 2 only P0 and P1 block.')
t('DS-368 AC3 round 2 with a P1 is not clean', reads(r2([p2(), f({ id: 'F2' })])), false)
t('DS-368 AC3 round 2 with a P0 is not clean', reads(r2([f({ severity: 'P0' })])), false)
t('DS-368 an uncarried P2 on round 2 still blocks', reads(r2([f({ severity: 'P2' })])), false)

// ---- DS-648: on round 1 a P2 split to a filed follow-up ticket is carried, so no round 2 is needed
const r1Split = base({ findings: [p2({ follow_up: 'DS-999' })] })
const r1Lines = render(r1Split).split('\n')
t('DS-648 AC1 round 1, only a split P2: the marker reads clean', reads(r1Split), true)
t('DS-648 AC1 round 1, only a split P2: heading says none block and one carried', heading(r1Split).includes('round 1: No P0 or P1 findings; P2 findings carried: 1 at `0123456`**'), true)
t('DS-648 AC1 round 1: the carried line counts it, with no since', r1Lines[3], '<!-- desk-review:carried v=1 p2=1 -->')
t('DS-648 AC1 round 1: the method line follows the carried line', r1Lines[4], '<!-- desk-review:method v=1 fallback=0 -->')
const r1Section = carriedSection(r1Split).split('\n')
t('DS-648 AC1 round 1: the carried section reads the whole branch, not a fix range', r1Section[1], 'desk-review round 1 read the whole branch at 0123456. These P2 findings were split to the follow-up tickets named, rather than fixed here.')
t('DS-648 AC1 round 1: the carried section names the follow-up', r1Section[2], '- `src/a.ts:12` name reads as a count (F1), follow-up DS-999')
t('DS-648 a follow-up is named on a later round too', carriedSection(r2([p2({ follow_up: 'DS-999' })])).split('\n')[2], '- `src/a.ts:12` name reads as a count (F1), follow-up DS-999')
t('DS-648 round 1, a split P2 beside an open P1: not clean', reads(base({ findings: [p2({ follow_up: 'DS-999' }), f({ id: 'F2' })] })), false)
t('DS-648 round 1 with a follow-up on an uncarried P2: still blocks', reads(base({ findings: [f({ severity: 'P2', follow_up: 'DS-999' })] })), false)

// ---- DS-317: a requirement gap the person accepted is out of gaps, and counted on a line of its own
const URL = 'https://github.com/acme/shop/pull/705#issuecomment-2440001'
const acc = (o = {}) => ({ gap: 'AC3', by: 'bigbenjoman', at: '2026-10-29', url: URL, ...o })
const before = base({ gaps: 1 })
const after = base({ gaps: 0, accepted: [acc()] })
t('DS-317 AC1 the round before the acceptance is not clean', reads(before), false)
t('DS-317 AC1 the same round with the gap accepted reads clean at the same head', `${reads(after)} ${marker(after).includes(` sha=${SHA} `)}`, 'true true')
t('DS-317 AC1 the verdict line is the one every gate reads, gaps=0', marker(after), marker(base()))
t('DS-317 AC1 the accepted line counts it', render(after).split('\n')[3], '<!-- desk-review:accepted v=1 gaps=1 -->')
t('DS-317 AC1 the method line follows it', render(after).split('\n')[4], '<!-- desk-review:method v=1 fallback=0 -->')
t('DS-317 AC1 the heading says it was accepted', heading(after).startsWith('**desk-review, round 1: No P0, P1 or P2 findings; requirement gaps accepted: 1 at `0123456`**'), true)
const accSec = acceptedSection(after).split('\n')
t('DS-317 AC1 the body section: its heading names no open gaps', accSec[0], '### Accepted gaps')
t('DS-317 AC1 the body names who accepted it, when, and links the record', accSec[2], `- AC3: accepted by \`bigbenjoman\` on 2026-10-29, ${URL}`)
t('DS-317 AC1 a full timestamp is shown as its date', acceptedSection(base({ accepted: [acc({ at: '2026-10-29T14:59:53Z' })] })).split('\n')[2].includes(' on 2026-10-29, '), true)
t('DS-317 the section is empty when nothing is accepted', acceptedSection(base()), '')
t('DS-317 AC2 a gap with no acceptance still counts', `${reads(base({ gaps: 1, accepted: [] }))} ${marker(base({ gaps: 1, accepted: [] })).includes(' gaps=1 ')}`, 'false true')
t('DS-317 AC2 no accepted line when none is accepted', render(base({ accepted: [] })).includes('desk-review:accepted'), false)
const oneOfTwo = base({ gaps: 1, accepted: [acc()] })
t('DS-317 one gap accepted beside one open: not clean', reads(oneOfTwo), false)
t('DS-317 one gap accepted beside one open: heading names both', heading(oneOfTwo).includes('not clean: 1 requirement gap open, requirement gaps accepted: 1'), true)
// The pass reads a review body's open gaps by its gaps heading; an accepted one is not open.
const posted = [render(oneOfTwo), '', '### Requirement gaps', '- AC2: no retry on a 429', '', acceptedSection(oneOfTwo)].join('\n')
t('DS-317 the body\'s accepted gap is not read as an open one', JSON.stringify(reviewGaps(posted)), JSON.stringify(['AC2: no retry on a 429']))
const accAndCarried = r2([p2()], { accepted: [acc(), acc({ gap: 'AC4' })] })
t('DS-317 with carried P2s: clean, heading names both', heading(accAndCarried).includes(': No P0 or P1 findings; P2 findings carried: 1; requirement gaps accepted: 2 at `0123456`**'), true)
t('DS-317 with carried P2s: the accepted line follows the carried line', render(accAndCarried).split('\n').slice(3, 6).map((l) => l.split(' ')[1]).join(' '), 'desk-review:carried desk-review:accepted desk-review:method')
t('DS-317 an accepted gap never hides a P1', reads(base({ accepted: [acc()], findings: [f()] })), false)

// ---- the seats a general-purpose agent stood in for
const gp = (role, o = {}) => ({ ...seat(role), agent: 'general-purpose', ...o })
const fellBack = base({ seats: [{ ...seat('correctness'), agent: 'lena-code-reviewer', fallback: true }, gp('requirements', { fallback: true }), gp('simplicity'), seat('codex', 'codex')] })
const byDesign = base({ seats: [seat('correctness'), gp('simplicity'), gp('domain'), seat('codex', 'codex')] })
t('fallback: a seat general-purpose by design is not one', render(byDesign).split('\n')[3], '<!-- desk-review:method v=1 fallback=0 -->')
t('fallback: the method line counts every fallback seat', render(fellBack).split('\n')[3], '<!-- desk-review:method v=1 fallback=2 -->')
t('fallback: none is 0, never left out', render(base()).split('\n')[3], '<!-- desk-review:method v=1 fallback=0 -->')
t('fallback: the verdict line is unchanged', marker(fellBack), marker(base()))
t('fallback: the heading names the seats', heading(fellBack).endsWith('refuted cross-vendor · 2 fallback seats (correctness, requirements)'), true)
t('fallback: it never decides clean', reads(fellBack), true)

// ---- the files the review rests on, on a line of their own after the method line
const rests = base({ rests_on: ['src/b.ts', 'src/a.ts', 'src/b.ts'] })
t('DS-448 AC1 the rests-on line follows the method line, sorted and once each', render(rests).split('\n').slice(3).join(' | '), '<!-- desk-review:method v=1 fallback=0 --> | <!-- desk-review:rests-on v=1 files=["src/a.ts","src/b.ts"] -->')
t('DS-448 the verdict line is unchanged', marker(rests), marker(base()))
t('DS-448 it never decides clean', reads(base({ rests_on: [] })), true)
t('DS-448 no rests_on prints no line', render(base()).includes('rests-on'), false)
t('DS-448 a path holding ">" cannot close the comment', render(base({ rests_on: ['a-->b'] })).split('\n').at(-1), '<!-- desk-review:rests-on v=1 files=["a--\\u003eb"] -->')
t('DS-448 an absolute path is refused', refused(base({ rests_on: ['/etc/x'] })), 'rests_on[0] must be a repo-relative path on one line')
t('DS-448 a list is required', refused(base({ rests_on: 'src/a.ts' })), 'rests_on must list the repo-relative paths the seats read')
// ---- DS-449: a targeted round records what it re-reviewed and what it carried, at which heads
const tg = (o = {}) => ({ from: SINCE, range: 'aaaaaaaaaaaa..bbbbbbbbbbbb', files: ['src/helper.js'], users: ['src/a.js'], ...o })
const targeted = r2([], { targeted: tg(), rests_on: ['src/a.js', 'src/helper.js'] })
const tLines = render(targeted).split('\n')
t('DS-449 AC2 the targeted marker follows the rests-on line, naming the review it carries and the base range', tLines.at(-2), `<!-- desk-review:targeted v=1 from=${SINCE} range=aaaaaaaaaaaa..bbbbbbbbbbbb -->`)
t('DS-449 AC2 its line says what was re-reviewed at this head and what was carried from which', tLines.at(-1), 'Targeted re-review at `0123456`: re-reviewed `src/helper.js`, which the base range `aaaaaaaaaaaa..bbbbbbbbbbbb` changed, and the PR\'s code that uses them, `src/a.js`. Carried, not re-read: the rest of the review posted on `fedcba9`, whose own diff is unchanged.')
t('DS-449 AC2 the heading names the base range, not a fix range', heading(targeted).startsWith('**desk-review, round 2, targeted after base range aaaaaaaaaaaa..bbbbbbbbbbbb: No P0, P1 or P2 findings at `0123456`**'), true)
t('DS-449 the verdict line is a round 2 verdict at this head, as before', marker(targeted), marker(r2()))
t('DS-449 a clean targeted round reads clean', reads(targeted), true)
t('DS-449 AC3 one with a P1 is not clean', reads(r2([{ id: 'F1', seat: 'correctness', severity: 'P1', where: 'src/a.js:2', result: 'CONFIRMED', refuted_by: 'codex' }], { targeted: tg() })), false)
t('DS-449 with no PR file using them, the line says so', render(r2([], { targeted: tg({ users: [] }) })).includes("the PR's code that uses them (none of its changed files names one)"), true)
t('DS-449 no targeted prints no targeted line', render(r2()).includes('targeted'), false)
t('DS-449 a targeted round 1 is refused', refused(base({ targeted: tg() })), 'a targeted round follows a review of the PR, so it is round 2 or later')
t('DS-449 its since must be the review it carries', refused(r2([], { targeted: tg({ from: SHA.replace('0', 'f') }) })), 'a targeted round reads on from the review it carries: since must be targeted.from')
t('DS-449 the base range is checked', refused(r2([], { targeted: tg({ range: 'main' }) })), 'targeted.range must be the base range, <sha>..<sha>')
t('DS-449 it names at least one changed file', refused(r2([], { targeted: tg({ files: [] }) })), "targeted.files must list the base's changed files, repo-relative")
t('DS-449 an unknown field is refused', refused(r2([], { targeted: tg({ why: 'x' }) })), 'unknown field targeted.why')
t('method line: rounds, vendor and fallback count', methodLine(fellBack), 'desk-review: 1 round, last at `0123456` · codex read the diff cold · refuted cross-vendor · fallback seats: 2 (correctness, requirements)')
t('method line: same-vendor is said', methodLine(r2([], { seats: [seat('correctness')] })), 'desk-review: 2 rounds, last at `0123456` · same-vendor · codex did not read the diff · fallback seats: 0')

// ---- results it refuses, each on the guard it names
const want = (name, r, msg) => { const got = refused(r); t(name, got.includes(msg) ? msg : got, msg) }
want('refuses fallback that is not a boolean', base({ seats: [{ ...seat('correctness'), fallback: 'yes' }] }), 'fallback must be true or false')
want('refuses a carried P1, naming it', r3([p2({ severity: 'P1' })]), 'finding F1 at src/a.ts:12 is P1: only a P2 can be carried')
want('refuses a carried P0, naming it', r3([p2({ id: 'F7', severity: 'P0', where: 'src/x.ts:9' })]), 'finding F7 at src/x.ts:9 is P0: only a P2 can be carried')
want('refuses a carried P2 on round 1', base({ findings: [p2()] }), 'carried only from round 2; on round 1 it is fixed')
want('DS-648 AC2 refuses a round-1 carried P2 naming no follow-up, naming it', base({ findings: [p2({ id: 'F4', where: 'src/d.ts:7' })] }), 'finding F4 at src/d.ts:7: a P2 is carried only from round 2; on round 1 it is fixed, or split to a filed follow-up ticket named in follow_up')
want('DS-648 AC3 refuses a round-1 carried P1 even with a follow-up', base({ findings: [p2({ severity: 'P1', follow_up: 'DS-999' })] }), 'finding F1 at src/a.ts:12 is P1: only a P2 can be carried')
want('DS-648 AC3 refuses a round-1 carried P0 even with a follow-up', base({ findings: [p2({ id: 'F7', severity: 'P0', where: 'src/x.ts:9', follow_up: 'DS-999' })] }), 'finding F7 at src/x.ts:9 is P0: only a P2 can be carried')
want('DS-648 refuses a follow-up that is not a ticket key', base({ findings: [p2({ follow_up: 'later' })] }), "finding F1: follow_up must be the follow-up ticket's key")
want('DS-648 refuses an empty follow-up', base({ findings: [p2({ follow_up: '' })] }), "finding F1: follow_up must be the follow-up ticket's key")
want('DS-648 a round-1 split P2 is still never deferred too', base({ findings: [p2({ follow_up: 'DS-999', deferred: true })] }), 'carried or deferred, not both')
want('DS-368 refuses a carried P1 on round 2, naming it', r2([p2({ severity: 'P1' })]), 'finding F1 at src/a.ts:12 is P1: only a P2 can be carried')
want('DS-368 refuses a carried P0 on round 2, naming it', r2([p2({ id: 'F7', severity: 'P0', where: 'src/x.ts:9' })]), 'finding F7 at src/x.ts:9 is P0: only a P2 can be carried')
want('DS-368 AC1 refuses round 2 with no fix range', base({ round: 2 }), 'round 2 reads only the fix range')
want('refuses a finding carried and deferred', r3([p2({ deferred: true })]), 'carried or deferred, not both')
want('refuses a carried finding with no file:line', r3([p2({ where: 'src/a.ts' })]), 'where as file:line')
want('refuses a carried REJECTED finding', r3([p2({ result: 'REJECTED' })]), 'not outstanding')
want('refuses carried that is not a boolean', r3([p2({ carried: 'yes' })]), 'carried must be true or false')
want('refuses round 3 with no fix range', base({ round: 3 }), 'reads only the fix range')
want('refuses a fix range that is not a full SHA', r3([], { since: 'fedcba9' }), 'reads only the fix range')
want('refuses an empty fix range', r3([], { since: SHA }), 'fix range is empty')
want('refuses a fix range on round 1', base({ since: SINCE }), 'since is for round 2 on; round 1 reads the whole branch')
want('refuses a short SHA', base({ sha: '0123456' }), 'full 40-character')
want('refuses round 0', base({ round: 0 }), 'round must be')
want('refuses gaps left out', base({ gaps: undefined }), 'gaps is required')
want('refuses skipped_files left out', base({ skipped_files: undefined }), 'skipped_files is required')
want('refuses findings left out', base({ findings: undefined }), 'findings is required')
want('refuses a negative count', base({ skipped_files: -1 }), 'whole number')
want('refuses an unknown field (a typo)', { ...base(), skiped_files: 2 }, 'unknown field results.skiped_files')
want('refuses an unknown finding field', base({ findings: [{ ...f(), severity2: 'P0' }] }), 'unknown field findings[0].severity2')
want('refuses no correctness seat', base({ seats: [seat('codex', 'codex')] }), 'must include correctness')
want('refuses a seat with no status', base({ seats: [{ role: 'correctness', vendor: 'claude' }] }), 'status must be ran or died')
want('refuses a finding from an unknown seat', base({ findings: [f({ seat: 'nadia' })] }), 'not in seats')
want('refuses a finding from a dead seat', base({ seats: [seat('correctness'), seat('nadia', 'claude', 'died')], findings: [f({ seat: 'nadia' })] }), 'died, so it raised nothing')
want('refuses a finding with no result', base({ findings: [f({ result: undefined })] }), 'result must be one of')
want('refuses a refuted finding with no refuter', base({ findings: [f({ refuted_by: undefined })] }), 'refuted_by must be')
want('#763 refuses an agent as the refuter, naming the vendor it wants', base({ findings: [f({ refuted_by: 'ada-devils-advocate' })] }), 'refuted_by must be the refuter\'s vendor, claude or codex, not its agent ("ada-devils-advocate")')
{
  const doc = readFileSync(join(ROOT, 'skills', 'desk-review', 'SKILL.md'), 'utf8')
  const example = JSON.parse(doc.match(/desk-review-results-<run>\.json`[\s\S]*?```json\n([\s\S]*?)```/)[1].replace('<full reviewed SHA>', SHA))
  t('DS-845 AC2 the skill\'s results example is accepted', refused(example), 'accepted')
  t('DS-845 AC2 the example refutes each seat\'s finding by the other vendor',
    example.findings.map((x) => `${x.seat}:${x.refuted_by}`).join(), 'correctness:codex,codex:claude')
  t('DS-845 AC1 the field description names the vendor, not an agent',
    /`refuted_by`: `claude` or `codex`, not an agent;\s+absent when `UNREFUTED`/.test(doc), true)
}
want('refuses an UNREFUTED finding naming a refuter', base({ findings: [f({ result: 'UNREFUTED' })] }), 'has no refuted_by')
want('refuses P3', base({ findings: [f({ severity: 'P3' })] }), 'severity must be')
want('refuses a finding listed twice', base({ findings: [f(), f()] }), 'listed twice')
want('refuses a DUPLICATE naming nothing', base({ findings: [f({ result: 'DUPLICATE' })] }), 'names the finding it duplicates')
want('refuses a DUPLICATE of a missing finding', base({ findings: [f({ result: 'DUPLICATE', duplicate_of: 'F9' })] }), 'is not in findings')
want('refuses a DUPLICATE of a DUPLICATE', base({ findings: [f({ id: 'F0' }), f({ id: 'F2', result: 'DUPLICATE', duplicate_of: 'F0' }), f({ id: 'F3', result: 'DUPLICATE', duplicate_of: 'F2' })] }), 'is itself a DUPLICATE')
want('refuses duplicate_of on a non-duplicate', base({ findings: [f({ duplicate_of: 'F0' })] }), 'only a DUPLICATE')
want('DS-317 refuses accepted that is not a list', base({ accepted: acc() }), 'accepted must list each accepted gap')
want('DS-317 refuses an accepted gap naming no criterion', base({ accepted: [acc({ gap: ' ' })] }), 'accepted[0].gap names the criterion')
want('DS-317 refuses an accepted gap listed twice', base({ accepted: [acc(), acc()] }), 'accepted gap AC3 is listed twice')
want('DS-317 refuses an accepted gap with nobody who accepted it', base({ accepted: [acc({ by: undefined })] }), 'by is the GitHub login')
want('DS-317 refuses an accepted gap with no date', base({ accepted: [acc({ at: 'yesterday' })] }), 'at is the date it was recorded')
want('DS-317 refuses an accepted gap with no link', base({ accepted: [acc({ url: undefined })] }), 'url links the PR comment or review')
want('DS-317 refuses a link to the PR, not the record', base({ accepted: [acc({ url: 'https://github.com/acme/shop/pull/705' })] }), 'url links the PR comment or review')
want('DS-317 refuses a link to a Jira comment', base({ accepted: [acc({ url: 'https://acme.atlassian.net/browse/VPL-371?focusedCommentId=10419' })] }), 'url links the PR comment or review')
want('DS-317 refuses an unknown accepted field (accepting a finding)', base({ accepted: [acc({ finding: 'F1' })] }), 'unknown field accepted[0].finding')
for (const anchor of ['pullrequestreview-311', 'discussion_r12']) {
  t(`DS-317 a link to a ${anchor.split(/[-_]/)[0]} is a record`, reads(base({ accepted: [acc({ url: `https://github.com/acme/shop/pull/705#${anchor}` })] })), true)
}

// ---- the CLI, and SKILL.md's documented forms
const T = scratch('desk-verdict-')
writeFileSync(join(T, 'ok.json'), JSON.stringify(base()))
writeFileSync(join(T, 'bad.json'), JSON.stringify(base({ gaps: undefined })))
const ok = spawnSync('node', [SCRIPT, join(T, 'ok.json')], { encoding: 'utf8' })
t('CLI prints the four lines', `${ok.status} ${ok.stdout.trim().split('\n').length}`, '0 4')
t('CLI first line is the review marker', ok.stdout.startsWith('<!-- desk-review:local -->\n'), true)
const bad = spawnSync('node', [SCRIPT, join(T, 'bad.json')], { encoding: 'utf8' })
t('CLI refuses with exit 2 and prints nothing', `${bad.status} ${bad.stdout === ''} ${bad.stderr.includes('gaps is required')}`, '2 true true')
const none = spawnSync('node', [SCRIPT], { encoding: 'utf8' })
t('CLI with no file refuses', none.status, 2)
// DS-882: the verdict refuses through the exported results validator, and prints what it returns.
{
  const agentRefuter = base({ findings: [f({ refuted_by: 'ada-devils-advocate' })] })
  writeFileSync(join(T, 'agent.json'), JSON.stringify(agentRefuter))
  const AGENT = 'finding F1: refuted_by must be the refuter\'s vendor, claude or codex, not its agent ("ada-devils-advocate")'
  const r = spawnSync('node', [SCRIPT, join(T, 'agent.json')], { encoding: 'utf8' })
  t('DS-882 AC1 an agent as refuter is refused with the same message and exit code', JSON.stringify([r.status, r.stdout, r.stderr]), JSON.stringify([2, '', `verdict.mjs: ${AGENT}\n`]))
  t('DS-882 AC2 the results validator returns the message the verdict printed', validateResults(agentRefuter), r.stderr.replace(/^verdict\.mjs: /, '').trimEnd())
  t('DS-882 a results file the verdict reads gives null', validateResults(base()), null)
}
writeFileSync(join(T, 'r3.json'), JSON.stringify(onlyCarried))
const r3cli = spawnSync('node', [SCRIPT, join(T, 'r3.json')], { encoding: 'utf8' })
t('CLI on round 3 prints five lines', `${r3cli.status} ${r3cli.stdout.trim().split('\n').length}`, '0 5')
const meth = spawnSync('node', [SCRIPT, '--method', join(T, 'ok.json')], { encoding: 'utf8' })
t('CLI --method prints the PR body line', `${meth.status} ${meth.stdout.startsWith('desk-review: 1 round, last at ')}`, '0 true')
const sec = spawnSync('node', [SCRIPT, '--carried', join(T, 'r3.json')], { encoding: 'utf8' })
t('CLI --carried prints the section', `${sec.status} ${sec.stdout.startsWith('### Carried review findings\n')}`, '0 true')
const noSec = spawnSync('node', [SCRIPT, '--carried', join(T, 'ok.json')], { encoding: 'utf8' })
t('CLI --carried with nothing carried prints nothing', `${noSec.status} ${JSON.stringify(noSec.stdout)}`, '0 ""')
writeFileSync(join(T, 'acc.json'), JSON.stringify(after))
const accCli = spawnSync('node', [SCRIPT, join(T, 'acc.json')], { encoding: 'utf8' })
t('DS-317 CLI with an accepted gap prints five lines', `${accCli.status} ${accCli.stdout.trim().split('\n').length}`, '0 5')
const accOut = spawnSync('node', [SCRIPT, '--accepted', join(T, 'acc.json')], { encoding: 'utf8' })
t('DS-317 CLI --accepted prints the section', `${accOut.status} ${accOut.stdout.startsWith('### Accepted gaps\n')}`, '0 true')
const noAcc = spawnSync('node', [SCRIPT, '--accepted', join(T, 'ok.json')], { encoding: 'utf8' })
t('DS-317 CLI --accepted with nothing accepted prints nothing', `${noAcc.status} ${JSON.stringify(noAcc.stdout)}`, '0 ""')

// ---- DS-570: a criterion only a live system can check is left for after the merge, out of gaps, and
// the posted body carries it for the pass to keep as a follow-on step once the PR merges.
const pm = (o = {}) => ({ gap: 'AC7', needs: 'production', step: 'fill in the switch date at the production relay run', ...o })
const later = base({ gaps: 0, post_merge: [pm(), pm({ gap: 'AC8', needs: 'staging', step: 'place a test call on staging -> it rings' })] })
const laterLines = render(later).split('\n')
t('DS-570 AC1 only post-merge criteria open: the verdict reads clean', reads(later), true)
t('DS-570 AC1 the verdict line is the one every gate reads, gaps=0', marker(later), marker(base()))
t('DS-570 AC1 the heading names them', heading(later).startsWith('**desk-review, round 1: No P0, P1 or P2 findings; criteria left for after the merge: 2 at `0123456`**'), true)
t('DS-570 AC1 the post-merge line follows the heading, before the method line', laterLines.slice(3, 5).map((l) => l.split(' ')[1]).join(' '), 'desk-review:post-merge desk-review:method')
t('DS-570 the post-merge line escapes ">" so no step closes the comment', laterLines[3].endsWith(' -->') && !laterLines[3].slice(0, -3).includes('>'), true)
const laterBody = [render(later), '', '### Requirement gaps', 'None', '', postMergeSection(later)].join('\n')
const laterReview = { pr: 7, head: SHA, verdict: undraftVerdict(laterBody), body: laterBody, comments: [] }
t('DS-570 AC1 the undraft step reads it clean at the head', verdictAt(laterReview.verdict, SHA, CLEAN).clean, true)
t('DS-570 AC1 no fix try for it', reviewFix({ key: 'X-1' }, laterReview, { judgement: 'yes' }), null)
t('DS-570 AC1 and no park for the person', personGapsCall(laterReview, { judgement: 'yes' }), null)
t('DS-570 AC1 the body\'s after-the-merge section is not read as open gaps', JSON.stringify(reviewGaps(laterBody)), '[]')
const pmSec = postMergeSection(later).split('\n')
t('DS-570 the body section: its heading names no gaps', pmSec[0], '### After the merge')
t('DS-570 the body section names each criterion, its need and its step', pmSec[2], '- AC7 (needs production): fill in the switch date at the production relay run')
t('DS-570 the section is empty when none is left for after the merge', postMergeSection(base()), '')
t('DS-570 no post-merge line when none is left for after the merge', render(base({ post_merge: [] })).includes('desk-review:post-merge'), false)
t('DS-570 AC2 the pass reads back each criterion from the posted body', JSON.stringify(postMergeIn(laterBody)), JSON.stringify(later.post_merge))
t('DS-570 AC2 DS-785 AC2 DS-788 AC5 each one is a follow-on step naming no §3 row, its step alone, a staging one gated on main', JSON.stringify(postMergeSteps(laterBody)[1]), JSON.stringify({ step: 'place a test call on staging -> it rings', row: null, from: 'review', after: 'main' }))
t('DS-785 AC2 a production criterion is gated on production', postMergeSteps(laterBody)[0]?.after, 'production')
const gateFor = (needs) => postMergeSteps(render(base({ gaps: 0, post_merge: [pm({ needs })] })))[0]?.after ?? 'none'
t('DS-785 AC2 deployed is gated on main; device and third-party on the merge alone', ['deployed', 'device', 'third-party'].map(gateFor).join(), 'main,none,none')
t('DS-570 AC2 a body with no post-merge line keeps none', JSON.stringify(postMergeSteps(render(base()))), '[]')
t('DS-570 AC2 a post-merge line whose count disagrees with its items keeps none', postMergeIn(laterBody.replace('post-merge v=1 gaps=2', 'post-merge v=1 gaps=3')).length, 0)
const pmAndGap = base({ gaps: 1, post_merge: [pm()] })
t('DS-570 a post-merge criterion beside an open gap: not clean', reads(pmAndGap), false)
t('DS-570 a post-merge criterion never hides a P1', reads(base({ post_merge: [pm()], findings: [f()] })), false)
// AC3: a criterion a test, a local run or a preview can check is no post-merge criterion.
for (const needs of ['unit', 'integration', 'local', 'preview', undefined]) {
  t(`DS-570 AC3 refuses a post-merge criterion that needs ${needs ?? 'nothing'}`, refused(base({ post_merge: [pm({ needs })] })).includes('needs must be one of production, staging, deployed, device, third-party; a criterion a test, a local run or a preview can check before the merge is a gap'), true)
}
t('DS-570 refuses post_merge that is not a list', refused(base({ post_merge: pm() })).startsWith('post_merge must list each criterion'), true)
t('DS-570 refuses a post-merge criterion naming no criterion', refused(base({ post_merge: [pm({ gap: ' ' })] })).startsWith('post_merge[0].gap names the criterion'), true)
t('DS-570 refuses a post-merge criterion listed twice', refused(base({ post_merge: [pm(), pm()] })), 'post-merge criterion AC7 is listed twice')
t('DS-570 refuses a criterion both accepted and left for after the merge', refused(base({ accepted: [acc({ gap: 'AC7' })], post_merge: [pm()] })).includes('is also accepted'), true)
t('DS-570 refuses a post-merge criterion with no step', refused(base({ post_merge: [pm({ step: '' })] })).includes('step says on one line'), true)
t('DS-570 refuses a step over two lines', refused(base({ post_merge: [pm({ step: 'a\nb' })] })).includes('step says on one line'), true)
t('DS-570 refuses an unknown post-merge field', refused(base({ post_merge: [pm({ high_risk: false })] })), 'unknown field post_merge[0].high_risk')
writeFileSync(join(T, 'pm.json'), JSON.stringify(later))
const pmCli = spawnSync('node', [SCRIPT, join(T, 'pm.json')], { encoding: 'utf8' })
t('DS-570 CLI with post-merge criteria prints five lines', `${pmCli.status} ${pmCli.stdout.trim().split('\n').length}`, '0 5')
const pmOut = spawnSync('node', [SCRIPT, '--post-merge', join(T, 'pm.json')], { encoding: 'utf8' })
t('DS-570 CLI --post-merge prints the section', `${pmOut.status} ${pmOut.stdout.startsWith('### After the merge\n')}`, '0 true')
const noPm = spawnSync('node', [SCRIPT, '--post-merge', join(T, 'ok.json')], { encoding: 'utf8' })
t('DS-570 CLI --post-merge with none prints nothing', `${noPm.status} ${JSON.stringify(noPm.stdout)}`, '0 ""')

// ---- DS-596: a requirement gap's results file through the CLI, then as the pass reads the posted
// body. A gap a worker's own logged decision caused is code: untagged, it earns a fix try. One only
// the person can close keeps its PERSON'S CALL tag and goes to the person.
const { parseVerdict } = await import('../desk/templates/scripts/desk/review-gate.mjs')
const gapReview = (name, gap) => {
  writeFileSync(join(T, name), JSON.stringify(base({ gaps: 1 })))
  const out = spawnSync('node', [SCRIPT, join(T, name)], { encoding: 'utf8' })
  const body = [out.stdout.trim(), '', '### Requirement gaps', gap].join('\n')
  return { status: out.status, review: { pr: 7, head: SHA, verdict: parseVerdict(body), body, comments: [] } }
}
const codeGap = '- AC2: "the ticket parks" — the diff keeps the link as a follow-on step instead, a call this ticket\'s worker logged; reversing it closes the gap'
const personGap = '- PERSON\'S CALL · AC4: "the nightly job finishes on production" — passes only on the deployed build; accept it on the PR once it has run. Recommended: accept it after the first nightly run'
const byCode = gapReview('gap-code.json', codeGap)
t('DS-596 AC3 the code gap\'s results file: the CLI counts one open gap', `${byCode.status} ${byCode.review.verdict?.gaps}`, '0 1')
const codeFix = reviewFix({ fix_tries: [] }, byCode.review, { judgement: 'yes' })
t('DS-596 AC3 a gap the worker\'s own decision caused carries no PERSON\'S CALL tag, so it earns a fix try', `${codeFix?.call} ${JSON.stringify(codeFix?.fix.gaps)} ${codeFix?.fix.person_gaps}`, `requeue ${JSON.stringify([codeGap.slice(2)])} undefined`)
t('DS-596 AC3 and is not put to the person', personGapsCall(byCode.review, { judgement: 'yes' }), null)
const byPerson = gapReview('gap-person.json', personGap)
t('DS-596 AC4 the person gap\'s results file: the CLI counts one open gap', `${byPerson.status} ${byPerson.review.verdict?.gaps}`, '0 1')
t('DS-596 AC4 a gap only the person can close keeps its tag and earns no fix try', reviewFix({ fix_tries: [] }, byPerson.review, { judgement: 'yes' }), null)
t('DS-596 AC4 it goes to the person, named', personGapsCall(byPerson.review, { judgement: 'yes' })?.why, `review gaps only you can settle: ${personGap.slice(2)}`)

// A named seat that ran as general-purpose is named in the heading.
const as = (role, agent) => ({ ...seat(role), agent })
const ranAsGp = base({ seats: [as('correctness', 'general-purpose'), as('frontend', 'general-purpose'), as('security', 'nadia-security-auditor'), as('simplicity', 'general-purpose'), seat('codex', 'codex')] })
t('AC3 the heading names each fallback seat', heading(ranAsGp).endsWith(' · 2 fallback seats (correctness, frontend)'), true)
t('AC3 the method line counts them without the flag', render(ranAsGp).split('\n')[3], '<!-- desk-review:method v=1 fallback=2 -->')
t('AC3 a fallback alone leaves the verdict clean', reads(ranAsGp), true)
t('AC3 seats that ran as their named agent add nothing', heading(base({ seats: [as('correctness', 'lena-code-reviewer'), seat('codex', 'codex')] })).includes('fallback'), false)

const SKILL = readFileSync(join(ROOT, 'skills', 'desk-review', 'SKILL.md'), 'utf8').split('\n')
const template = marker(base()).replace(`sha=${SHA}`, 'sha=<full reviewed SHA>')
t('SKILL.md shows the marker form verdict.mjs prints', SKILL.includes(template), true)
t('SKILL.md states the clean verdict verdict.mjs tests', SKILL.some((l) => l.includes(`\`${CLEAN}\``)), true)
// From round 2 the finders read only the fix range: the dispatch template's diff command must say so,
// for a branch and a PR, or round 2 rereads the whole branch whatever verdict.mjs records as `since`.
const dispatch = SKILL.join('\n').match(/^3\. The diff command[\s\S]*?(?=^4\. )/m)?.[0] ?? ''
t('DS-368 AC1 the finder diff command switches to the fix range from round 2', dispatch.includes('**From round 2, the fix range instead**'), true)
t('the finder diff command has a fix-range form for a branch', dispatch.includes('git diff "<since>..HEAD"'), true)
t('the finder diff command has a fix-range form for a PR', dispatch.includes('git diff "<since>..refs/desk-review/pr-<n>"'), true)
t('the fix-range rule names since as the previous round\'s SHA', SKILL.some((l) => l.includes("git diff <previous round's reviewed SHA>..HEAD")), true)
// A fix range reads only what changed, so it is safe only after a whole read of a branch that has
// only grown since: after a partial round, a rebase or a base merge, the round reads the whole branch.
const whole = SKILL.join('\n').match(/^\*\*The fix range holds only when[\s\S]*?(?=\n\n(?!- ))/m)?.[0] ?? ''
t('the fix range falls back to the merge base', whole.includes('`since` is the branch\'s merge base, `git merge-base origin/<base> HEAD`'), true)
t('after a partial previous round', whole.includes('**The previous verdict was partial**'), true)
t('after a rebase', whole.includes('`git merge-base --is-ancestor <since> HEAD` fails'), true)
t('after a base merge', whole.includes('`git log --merges --oneline <since>..HEAD` prints anything'), true)

// DS-422 AC5: --check reads a review body as the repo's review gate does, before the worker pushes.
{
  const gate = await import('../desk/templates/scripts/desk/review-gate.mjs')
  const H = 'b'.repeat(40)
  const body = (marker, heading = `## desk-review: clean at \`${H.slice(0, 9)}\`, round 1`) => `<!-- desk-review:local -->\n${marker}\n\n${heading}\n`
  const clean = (o = {}) => `<!-- desk-review:verdict v=1 sha=${o.sha ?? H} p0=0 p1=${o.p1 ?? 0} p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=${o.vendor ?? 'codex-cross'} round=1 -->`
  t('DS-422 AC5 a clean verdict at the head reads', gateRejects(body(clean()), H, gate), null)
  t('DS-422 AC5 an old-format marker is rejected', /reads no verdict/.test(gateRejects(body('<!-- desk-review:verdict sha=bbb p0=0 -->'), H, gate)), true)
  t('DS-422 AC5 a verdict for another commit is rejected', /attests ccccccccc, not the head bbbbbbbbb/.test(gateRejects(body(clean({ sha: 'c'.repeat(40) })), H, gate)), true)
  t('DS-422 AC5 a vendor the gate does not take is rejected', /vendor=same-vendor, and the gate requires codex-cross/.test(gateRejects(body(clean({ vendor: 'same-vendor' })), H, gate, 'codex-cross')), true)
  t('DS-422 AC5 a heading contradicting a clean marker is rejected', /lists "1 P1"/.test(gateRejects(body(clean(), '## desk-review: 1 P1'), H, gate)), true)
  t('DS-422 AC5 counts handed on are no format fault', gateRejects(body(clean({ p1: 1 }), '## desk-review: 1 P1'), H, gate), null)
  t('DS-422 AC5 a repo gate exporting only parseVerdict still checks the marker and its head', `${gateRejects(body(clean()), H, { parseVerdict: gate.parseVerdict })} ${/attests/.test(gateRejects(body(clean({ sha: 'c'.repeat(40) })), H, { parseVerdict: gate.parseVerdict }))}`, 'null true')
  const dir = scratch('verdict-check-')
  const f = join(dir, 'report.md')
  writeFileSync(f, body(clean({ sha: 'c'.repeat(40) })))
  const r = spawnSync('node', [SCRIPT, '--check', f, H], { cwd: dir, encoding: 'utf8' })
  t('DS-422 AC5 --check exits 1 naming why', `${r.status} ${/^REJECTED by .*review-gate\.mjs: its verdict marker attests/.test(r.stdout)}`, '1 true')
  writeFileSync(f, body(clean()))
  t('DS-422 AC5 --check exits 0 on a body the gate reads', spawnSync('node', [SCRIPT, '--check', f, H], { cwd: dir, encoding: 'utf8' }).status, 0)
  mkdirSync(join(dir, 'scripts/desk'), { recursive: true })
  writeFileSync(join(dir, 'scripts/desk/review-gate.mjs'), 'export const other = 1\n')
  const r2 = spawnSync('node', [SCRIPT, '--check', f, H], { cwd: dir, encoding: 'utf8' })
  t('DS-422 AC5 --check exits 2 on a repo gate it cannot read a verdict with', `${r2.status} ${/exports no parseVerdict/.test(r2.stderr)}`, '2 true')
  rmSync(dir, { recursive: true, force: true })
}

// The anchor check: a finding whose file:line does not exist at head is rejected before any refuter call.
{
  const dir = scratch('verdict-anchors-')
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const git = (...a) => spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' })
  git('init', '-q')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/a.ts'), 'one\ntwo\nthree\n')
  writeFileSync(join(dir, 'src/b.ts'), 'no newline at the end')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  const head = git('rev-parse', 'HEAD').stdout.trim()
  // A file added after the reviewed head is not there at head, even though it is on disk.
  writeFileSync(join(dir, 'src/later.ts'), 'x\n')
  const finding = (id, where, o = {}) => ({ id, seat: 'correctness', severity: 'P1', where, ...o })
  const fixture = [finding('F1', 'src/gone.ts:3'), finding('F2', 'src/a.ts:4'), finding('F3', 'src/a.ts:3')]
  // The refuter, stubbed around the check as Phase 4 runs it: only findings still without a result.
  const refuted = []
  const refute = (fs) => fs.map((x) => (x.result ? x : (refuted.push(x.id), { ...x, result: 'CONFIRMED', refuted_by: 'codex' })))
  const { findings, rejected } = checkAnchors(fixture, head, { cwd: dir })
  const after = refute(findings)
  t('DS-1022 AC1 a finding citing a missing file is REJECTED, anchor missing', JSON.stringify([after[0].result, after[0].anchor, 'refuted_by' in after[0]]), '["REJECTED","missing",false]')
  t('DS-1022 AC2 a finding citing a line past the end is REJECTED, anchor missing', JSON.stringify([after[1].result, after[1].anchor]), '["REJECTED","missing"]')
  t('DS-1022 AC1/AC2 both print "anchor not found"', rejected.map((x) => anchorLine(x, head)).every((l) => l.includes('REJECTED: anchor not found')), true)
  t('DS-1022 AC3 the valid finding is refuted as before, and the refuter is called once', `${refuted.join()} ${after[2].result} ${'anchor' in after[2]}`, 'F3 CONFIRMED false')
  t('DS-1022 the fixture passed in is left as it was', fixture.every((x) => x.result == null), true)
  const left = (where, o) => checkAnchors([finding('F1', where, o)], head, { cwd: dir }).rejected.length
  t('DS-1022 the last line of a file with no final newline exists', left('src/b.ts:1'), 0)
  t('DS-1022 a line range is anchored by its first line', [left('src/a.ts:2-9'), left('src/a.ts:5-9')].join(), '0,1')
  t('DS-1022 line 0 is no line', left('src/a.ts:0'), 1)
  t('DS-1022 a file added after head is not there at head', left('src/later.ts:1'), 1)
  t('DS-1022 a directory is not a file', left('src:1'), 1)
  t('DS-1022 ./ and the repo\'s absolute path name the same file', [left('./src/a.ts:1'), left(`${git('rev-parse', '--show-toplevel').stdout.trim()}/src/a.ts:1`)].join(), '0,0')
  t('DS-1022 every spelling of a file that is there is there', ['src//a.ts:1', 'src/./a.ts:3', 'src/x/../a.ts:2', './/src/a.ts:1'].map((w) => left(w)).join(), '0,0,0,0')
  t('DS-1022 a file named like another is not it', [left('src/a.t:1'), left('src/a.ts.bak:1'), left('a.ts:1')].join(), '1,1,1')
  const top = git('rev-parse', '--show-toplevel').stdout.trim()
  const fromSrc = (where) => checkAnchors([finding('F1', where)], head, { cwd: join(dir, 'src') }).rejected.length
  t('DS-1022 a path is read from the repo\'s top, whatever directory the check runs in', [fromSrc('src/a.ts:3'), fromSrc(`${top}/src/a.ts:3`), fromSrc('a.ts:1'), fromSrc('src/a.ts:4')].join(), '0,0,1,1')
  t('DS-1022 a doubled slash after the repo\'s absolute path is the same file', left(`${top}//src/a.ts:1`), 0)
  writeFileSync(join(dir, 'src/empty.ts'), '')
  writeFileSync(join(dir, 'src/[a].ts'), 'only\n')
  git('add', '.')
  git('commit', '-q', '-m', 'empty')
  const head2 = git('rev-parse', 'HEAD').stdout.trim()
  const at2 = (where) => checkAnchors([finding('F1', where)], head2, { cwd: dir }).rejected.length
  t('DS-1022 an empty file has no line 1', at2('src/empty.ts:1'), 1)
  t('DS-1022 a name with glob characters is read literally', [at2('src/[a].ts:1'), at2('src/[a].ts:2'), at2('src/*.ts:1')].join(), '0,1,1')
  t('DS-1022 a finding with no file:line, a path outside the repo, a PREMISE or a refuted one is the refuter\'s',
    [left('src/gone.ts'), left(undefined), left('/elsewhere/x.ts:1'), left('../x.ts:1'), left('src/gone.ts:1', { severity: 'PREMISE' }), left('src/gone.ts:1', { result: 'CONFIRMED', refuted_by: 'codex' })].join(), '0,0,0,0,0,0')
  const thrown = (fn) => { try { fn(); return 'returned' } catch (e) { return e instanceof VerdictError ? 'refused' : `threw ${e}` } }
  t('DS-1022 a head that is not a commit is refused, never every anchor missing', thrown(() => checkAnchors(fixture, 'f'.repeat(40), { cwd: dir })), 'refused')

  // AC4: the verdict counts them, and reads them as the REJECTED findings they are.
  const results = base({ findings: after })
  t('DS-1022 AC4 the heading counts the anchor rejections', heading(results).includes('not clean: 1 P1 outstanding, findings rejected for a missing anchor: 2'), true)
  t('DS-1022 AC4 the counts are untouched by them', marker(results).includes(' p0=0 p1=1 p2=0 '), true)
  t('DS-1022 AC4 a clean review shows the count too', heading(base({ findings: after.slice(0, 2) })).startsWith('**desk-review, round 1: No P0, P1 or P2 findings; findings rejected for a missing anchor: 2 at'), true)
  t('DS-1022 AC4 a clean review still reads clean to the gate', reads(base({ findings: after.slice(0, 2) })), true)
  t('DS-1022 AC4 no anchor rejection, no count', heading(results).includes('anchor') && !heading(base({ findings: [after[2]] })).includes('anchor'), true)
  t('DS-1022 anchor rejections leave the run cross-vendor', marker(base({ findings: after })).includes(' vendor=codex-cross '), true)
  t('DS-1022 an anchor is only missing', refused(base({ findings: [{ ...after[0], anchor: 'stale' }] })), 'finding F1: anchor is "missing", set by the anchor check, or left out ("stale")')
  t('DS-1022 a missing anchor is REJECTED', refused(base({ findings: [{ ...after[0], result: 'CONFIRMED' }] })), 'finding F1: a finding whose anchor is missing is REJECTED before any refuter call')
  t('DS-1022 a missing anchor reached no refuter', refused(base({ findings: [{ ...after[0], refuted_by: 'codex' }] })), 'finding F1: a finding rejected for a missing anchor reached no refuter, so it has no refuted_by')
  t('DS-1022 any other REJECTED finding still names its refuter', /refuted_by must be the refuter's vendor/.test(refused(base({ findings: [f({ result: 'REJECTED', refuted_by: undefined })] }))), true)

  // The --anchors mode rewrites the results file and prints a line for each rejection.
  const file = join(dir, 'results.json')
  writeFileSync(file, JSON.stringify(base({ sha: head, findings: fixture })))
  const run = spawnSync('node', [SCRIPT, '--anchors', file, head], { cwd: dir, encoding: 'utf8' })
  const written = JSON.parse(readFileSync(file, 'utf8')).findings
  t('DS-1022 --anchors exits 0', run.status, 0)
  t('DS-1022 --anchors prints a line for each', run.stdout.split('\n').filter((l) => /^F[12] REJECTED: anchor not found, src\/(gone|a)\.ts:[34] does not exist at /.test(l)).length, 2)
  t('DS-1022 --anchors rewrites the file', written.map((x) => x.anchor ?? '-').join(), 'missing,missing,-')
  const bad = spawnSync('node', [SCRIPT, '--anchors', file, 'f'.repeat(40)], { cwd: dir, encoding: 'utf8' })
  t('DS-1022 --anchors exits 2 on a head it cannot find', `${bad.status} ${/is not a commit/.test(bad.stderr)}`, '2 true')
}

// ---- issue-1694: a dated Decisions entry naming the criterion, the evidence and who decided settles it
{
  const ENTRY = '2026-11-26 ben: AC3 measured at 212 lines on the 2026-11-26 window, under 300'
  const settled = base({ gaps: 0, settled: [{ gap: 'AC3', entry: ENTRY }] })
  t('issue-1694 AC1 a criterion a Decisions entry settles is no gap: the verdict reads clean', reads(settled), true)
  const sec = settledSection(settled)
  t('issue-1694 AC1 the verdict cites the entry and who decided', [sec.startsWith("### Settled by the ticket's Decisions"), sec.includes(`- AC3: decided by ben on 2026-11-26: "${ENTRY}"`)].join(' '), 'true true')
  t('issue-1694 AC1 its heading never names requirement gaps, so the pass reads none open', reviewGaps([render(settled), '', '### Requirement gaps', 'None', '', sec].join('\n')).length, 0)
  t('issue-1694 AC1 the section is empty when nothing is settled', settledSection(base()), '')
  t('issue-1694 AC1 a bulleted entry reads the same', settlingEntry(`* ${ENTRY}`, 'AC3')?.who, 'ben')
  const no = (entry, gap = 'AC3') => /settled criterion AC3: entry quotes/.test(refused(base({ settled: [{ gap, entry }] })))
  t('issue-1694 AC1 an entry with no date, no one deciding, another criterion or nothing past the label settles nothing',
    [no('ben: AC3 measured at 212'), no('2026-11-26 AC3 measured at 212'), no('2026-11-26 ben: AC4 measured at 212'), no('2026-11-26 ben: AC3.')].join(' '), 'true true true true')
  t('issue-1694 AC1 a settled criterion is not also accepted or left for after the merge',
    /also accepted/.test(refused(base({ settled: [{ gap: 'AC3', entry: ENTRY }], accepted: [{ gap: 'AC3', by: 'ben', at: '2026-11-26', url: 'https://github.com/a/b/pull/1#issuecomment-2' }] }))), true)
  t('issue-1694 AC1 the desk pass\'s refresh entry names criteria changed, and settles none', settlingEntry('2026-11-27 desk pass: issue #1 changed after PR #9 was opened: acceptance criteria added or changed: "AC5: x"', 'AC5'), null)
  t('issue-1694 AC1 nor listed twice', /listed twice/.test(refused(base({ settled: [{ gap: 'AC3', entry: ENTRY }, { gap: 'AC3', entry: ENTRY }] }))), true)
  const file = ['# issue-1', '', '## Acceptance criteria', '1. AC3: under 300 lines', '', '## Decisions', `* ${ENTRY}`, '* 2026-11-27 ben: AC4', '* 2026-11-27 ben: the badge is blue', '* 2026-11-27 desk pass: issue #1 changed after PR #9 was opened, and this file was refreshed from it: acceptance criteria added or changed: "AC5: x"', ''].join('\n')
  t('issue-1694 the pass reads the criteria a ticket file settles by the same rule', JSON.stringify(settledCriteria(file)), '["AC3"]')
  const entry = answerEntry({ text: 'AC3: 212', who: 'ben', today: '2026-11-28' })
  t('issue-1694 AC2 an answer naming a criterion is a Decisions entry desk-review reads as settling it', JSON.stringify([entry, settlingEntry(entry, 'AC3')?.criterion]), JSON.stringify(['* 2026-11-28 ben (answer.mjs): AC3: 212', 'AC3']))
  t('issue-1694 AC2 an answer naming no criterion is no entry', answerEntry({ text: 'the short copy', who: 'ben', today: '2026-11-28' }), null)
}

// ---- issue-1694 AC3: a measurement no worker can run is asked once, naming the command
{
  const CMD = 'python3 scripts/claude_activity.py --window 2026-11-26'
  const gap = `PERSON'S CALL · AC3: "under 300 lines on the 2026-11-26 window" — MEASURE: \`${CMD}\`: Python is refused for workers`
  const review = { verdict: { p0: 0, p1: 0, p2: 0, deferred: 0, gaps: 1, unrefuted: 0, partial: 0 }, body: `### Requirement gaps\n- ${gap}\n` }
  t('issue-1694 AC3 the gap names its command', measureOf(gap), CMD)
  const asked = personGapsCall(review, { judgement: 'yes', settled: [] })
  const item = personGapsIn(asked?.why)
  t('issue-1694 AC3 unanswered, it goes to the person once, as one item: run this and reply with the number',
    [asked?.call, item.length, item[0]?.includes(`run \`${CMD}\` and reply with the number, naming AC3 ("AC3: <number>")`)].join(' '), 'stuck 1 true')
  t('issue-1694 AC3 it earns no fix try while unanswered', reviewFix({}, { pr: 1, head: 'a'.repeat(40), ...review }, { judgement: 'yes', settled: [] }), null)
  // The person's answer, as answer.mjs keeps it, settles AC3 in the ticket file.
  const file = ['# issue-1', '', '## Decisions', answerEntry({ text: 'AC3: 212 lines', who: 'ben', today: '2026-11-28' }), ''].join('\n')
  const settled = () => settledCriteria(file)
  t('issue-1694 AC3 once answered, it is never put to the person again', personGapsCall(review, { judgement: 'yes', settled }), null)
  const sent = reviewFix({}, { pr: 1, head: 'a'.repeat(40), ...review }, { judgement: 'yes', settled })
  t('issue-1694 AC3 a review that raises it anyway goes to a worker to cite the entry, untagged',
    [sent?.call, sent?.fix?.gaps?.length, /PERSON'S CALL/.test(sent?.fix?.gaps?.[0]), /post the verdict again with it under settled/.test(sent?.fix?.gaps?.[0]), (sent?.fix?.person_gaps ?? []).length].join(' '), 'requeue 1 false true 0')
  t('issue-1694 AC3 a measurement on a criterion nothing settles is still asked', personGapsCall(review, { judgement: 'yes', settled: () => ['AC4'] })?.call, 'stuck')
  t('issue-1694 a gap with no MEASURE command is not a measurement', measureOf("PERSON'S CALL · AC2: \"x\" — pick one. Recommended: A"), null)
  t('issue-1694 the Decisions entry is in the file where the restart reads it', ticketDecisions(file).length, 1)

  // A DoD criterion, as the ticket numbers it: asked as DoD2, and not asked again once settled.
  const dod = `PERSON'S CALL · DoD2: "the feature runs end to end in under a minute" — MEASURE: \`${CMD}\`: Python is refused for workers`
  const dodReview = { ...review, body: `### Requirement gaps\n- ${dod}\n` }
  const dodAsk = personGapsIn(personGapsCall(dodReview, { judgement: 'yes', settled: [] })?.why)[0] ?? ''
  t('issue-1694 AC3 a DoD measurement asks for DoD2 by its label', dodAsk.includes('naming DoD2 ("DoD2: <number>")'), true)
  const dodFile = ['# e', '', '## Decisions', answerEntry({ text: 'DoD2: 41 seconds', who: 'ben', today: '2026-11-28' }), ''].join('\n')
  t('issue-1694 AC3 a settled DoD measurement is never put to the person again', JSON.stringify([settledCriteria(dodFile), personGapsCall(dodReview, { judgement: 'yes', settled: () => settledCriteria(dodFile) })]), JSON.stringify([['DOD2'], null]))

  // A draft's gaps, as needs-you quotes them: the measurement's ask, or answered and untagged.
  const lines = personGapLines([gap, 'AC5: "x" — the badge is missing on the list'], { settled: [] })
  t('issue-1694 AC3 on a draft a measurement is quoted with its ask, and any other gap as written', [lines[0].includes(`run \`${CMD}\` and reply with the number`), lines[1]].join(' | '), 'true | AC5: "x" — the badge is missing on the list')
  const done = personGapLines([gap], { settled })
  t('issue-1694 AC3 on a draft an answered measurement is untagged and marked answered, not asked again', [done[0].endsWith(ANSWERED_ITEM), /PERSON'S CALL/.test(done[0]), /reply with the number/.test(done[0])].join(' '), 'true false false')
}

// ---- issue-1694: the pass's settled criteria are desk-review's own reading, entry by entry
{
  const entries = [
    '2026-11-26 ben: AC3 measured at 212 lines', '2026-11-26 ben: AC3 and DoD2 both measured: 212 lines, 41 s', '2026-11-26 ben: AC3',
    '2026-11-26 ben: AC3.', 'ben: AC3 measured', '2026-11-26 AC3 measured', '2026-11-27 desk pass: issue #1 changed: "AC5: x"',
    '2026-11-28 ben (answer.mjs): DoD1: 7', '2026-11-28 ben: dod4 ruled met by the call on the 27th',
  ]
  const review = (e) => [...new Set((e.match(/\b(?:AC|DoD)\s?\d+\b/gi) ?? []).map((c) => c.replace(/\s+/g, '').toUpperCase()))].filter((c) => settlingEntry(e, c))
  const pass = (e) => settledCriteria(`## Decisions\n* ${e}\n`)
  t('issue-1694 the pass and the review read every entry alike', entries.filter((e) => JSON.stringify(review(e)) !== JSON.stringify(pass(e))).join(' / '), '')
  t('issue-1694 and they settle what the rule says', JSON.stringify(entries.map(pass)), JSON.stringify([['AC3'], ['AC3', 'DOD2'], [], [], [], [], [], ['DOD1'], ['DOD4']]))
}

console.log(fails ? `${fails} failed` : 'all verdict checks passed')
process.exit(fails ? 1 : 0)
