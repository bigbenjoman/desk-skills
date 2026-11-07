// suite: desk-review verdict (never clean with an open finding, partial or a dead seat)
// desk-review's verdict script: the counts, the vendor and the heading come from the finder and
// refuter results, and no results with an open finding, partial coverage or a dead seat can print
// the clean verdict. Pure: no git, no GitHub, no codex.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, tally, isClean, carriedSection, acceptedSection, methodLine, CLEAN, VerdictError, gateRejects } from '../skills/desk-review/bin/verdict.mjs'
import { reviewGaps } from '../desk/bin/fix-tries.mjs'

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
t('method line: rounds, vendor and fallback count', methodLine(fellBack), 'desk-review: 1 round, last at `0123456` · codex read the diff cold · refuted cross-vendor · fallback seats: 2 (correctness, requirements)')
t('method line: same-vendor is said', methodLine(r2([], { seats: [seat('correctness')] })), 'desk-review: 2 rounds, last at `0123456` · same-vendor · codex did not read the diff · fallback seats: 0')

// ---- results it refuses, each on the guard it names
const want = (name, r, msg) => { const got = refused(r); t(name, got.includes(msg) ? msg : got, msg) }
want('refuses fallback that is not a boolean', base({ seats: [{ ...seat('correctness'), fallback: 'yes' }] }), 'fallback must be true or false')
want('refuses a carried P1, naming it', r3([p2({ severity: 'P1' })]), 'finding F1 at src/a.ts:12 is P1: only a P2 can be carried')
want('refuses a carried P0, naming it', r3([p2({ id: 'F7', severity: 'P0', where: 'src/x.ts:9' })]), 'finding F7 at src/x.ts:9 is P0: only a P2 can be carried')
want('refuses a carried P2 on round 1', base({ findings: [p2()] }), 'carried only from round 2; on round 1 it is fixed')
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
const T = mkdtempSync(join(tmpdir(), 'desk-verdict-'))
process.on('exit', () => rmSync(T, { recursive: true, force: true }))
writeFileSync(join(T, 'ok.json'), JSON.stringify(base()))
writeFileSync(join(T, 'bad.json'), JSON.stringify(base({ gaps: undefined })))
const ok = spawnSync('node', [SCRIPT, join(T, 'ok.json')], { encoding: 'utf8' })
t('CLI prints the four lines', `${ok.status} ${ok.stdout.trim().split('\n').length}`, '0 4')
t('CLI first line is the review marker', ok.stdout.startsWith('<!-- desk-review:local -->\n'), true)
const bad = spawnSync('node', [SCRIPT, join(T, 'bad.json')], { encoding: 'utf8' })
t('CLI refuses with exit 2 and prints nothing', `${bad.status} ${bad.stdout === ''} ${bad.stderr.includes('gaps is required')}`, '2 true true')
const none = spawnSync('node', [SCRIPT], { encoding: 'utf8' })
t('CLI with no file refuses', none.status, 2)
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
  const dir = mkdtempSync(join(tmpdir(), 'verdict-check-'))
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

console.log(fails ? `${fails} failed` : 'all verdict checks passed')
process.exit(fails ? 1 : 0)
