// suite: desk-review verdict (never clean with an open finding, partial or a dead seat)
// desk-review's verdict script: the counts, the vendor and the heading come from the finder and
// refuter results, and no results with an open finding, partial coverage or a dead seat can print
// the clean verdict. Pure: no git, no GitHub, no codex.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, tally, isClean, carriedSection, methodLine, CLEAN, VerdictError } from '../skills/desk-review/bin/verdict.mjs'

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

console.log(fails ? `${fails} failed` : 'all verdict checks passed')
process.exit(fails ? 1 : 0)
