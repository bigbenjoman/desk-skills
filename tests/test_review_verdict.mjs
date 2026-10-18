// desk-review's verdict script: the counts, the vendor and the heading come from the finder and
// refuter results, and no results with an open finding, partial coverage or a dead seat can print
// the clean verdict. Pure: no git, no GitHub, no codex.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, tally, isClean, CLEAN, VerdictError } from '../skills/desk-review/bin/verdict.mjs'

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
t('duplicate finding: not counted twice', marker(base({ findings: [f(), f({ id: 'F2', result: 'DUPLICATE' })] })).includes(' p1=1 '), true)
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
  for (const result of ['CONFIRMED', 'REJECTED', 'DUPLICATE', 'UNREFUTED']) {
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

// ---- results it refuses, each on the guard it names
const want = (name, r, msg) => { const got = refused(r); t(name, got.includes(msg) ? msg : got, msg) }
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

// ---- the CLI, and SKILL.md's documented forms
const T = mkdtempSync(join(tmpdir(), 'desk-verdict-'))
process.on('exit', () => rmSync(T, { recursive: true, force: true }))
writeFileSync(join(T, 'ok.json'), JSON.stringify(base()))
writeFileSync(join(T, 'bad.json'), JSON.stringify(base({ gaps: undefined })))
const ok = spawnSync('node', [SCRIPT, join(T, 'ok.json')], { encoding: 'utf8' })
t('CLI prints the three lines', `${ok.status} ${ok.stdout.trim().split('\n').length}`, '0 3')
t('CLI first line is the review marker', ok.stdout.startsWith('<!-- desk-review:local -->\n'), true)
const bad = spawnSync('node', [SCRIPT, join(T, 'bad.json')], { encoding: 'utf8' })
t('CLI refuses with exit 2 and prints nothing', `${bad.status} ${bad.stdout === ''} ${bad.stderr.includes('gaps is required')}`, '2 true true')
const none = spawnSync('node', [SCRIPT], { encoding: 'utf8' })
t('CLI with no file refuses', none.status, 2)

const SKILL = readFileSync(join(ROOT, 'skills', 'desk-review', 'SKILL.md'), 'utf8').split('\n')
const template = marker(base()).replace(`sha=${SHA}`, 'sha=<full reviewed SHA>')
t('SKILL.md shows the marker form verdict.mjs prints', SKILL.includes(template), true)
t('SKILL.md states the clean verdict verdict.mjs tests', SKILL.some((l) => l.includes(`\`${CLEAN}\``)), true)

console.log(fails ? `${fails} failed` : 'all verdict checks passed')
process.exit(fails ? 1 : 0)
