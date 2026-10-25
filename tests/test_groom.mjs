// suite: desk-groom ticket checks (landed work, duplicates, links, stale text, fields, blockers)
// desk-groom's scripted per-ticket checks against a stub Jira and a fixture repo with its own
// origin: one case per DS-238 criterion, plus the close rule a verifier's results go through. Nothing
// reads the real Jira, GitHub or this checkout's history.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { criteriaOf, citationsOf, closeVerdict, sharedPrefix, prefixOf, newer, plain } from '../skills/desk-groom/bin/groom-scan.mjs'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCAN = join(SRC, 'skills', 'desk-groom', 'bin', 'groom-scan.mjs')
let fails = 0
const t = (name, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want); const ok = g === w; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${g}${ok ? '' : ` (want ${w})`}`) }

// ---- pure parts
t('criteria: AC items, a named one included', criteriaOf('h2. Acceptance criteria\n# AC1: Given a, then b.\n# AC2 (priority path): Given c, then d.\nDoD3: e').map((c) => c.id), ['AC1', 'AC2', 'DoD3'])
t('citations: path:line and a range, never a URL', citationsOf('see `a/b.mjs:12` and c.sh:3-9, not https://x.io/a.mjs:4').map((c) => c.cite), ['a/b.mjs:12', 'c.sh:3-9'])
t('plain: wiki escapes dropped, monospace as code', plain('run {{desk\\-jira link}} now'), 'run `desk-jira link` now')
t('prefix: the area before the colon', prefixOf('desk-groom: check each ticket'), 'desk-groom')
t('prefix: none on a plain title', prefixOf('check each ticket'), null)
t('shared prefix: most of the others share it', sharedPrefix([{ key: 'A-1', summary: 'x: a' }, { key: 'A-2', summary: 'x: b' }, { key: 'A-3', summary: 'c' }], 'A-3'), 'x')
t('shared prefix: one sibling is not a pattern', sharedPrefix([{ key: 'A-1', summary: 'x: a' }, { key: 'A-2', summary: 'b' }], 'A-2'), null)
t('newer: created later wins over the key', newer({ key: 'A-9', created: '2026-01-01' }, { key: 'A-2', created: '2026-03-01' }).key, 'A-2')

// AC1: a close needs every criterion MET with a file:line, and no open PR on the key.
const met = (id, cite = 'lib/admit.mjs:1') => ({ id, met: true, cite })
t('AC1 every criterion met with a cite closes', closeVerdict({ ticket: 'K-1', criteria: [met('AC1'), met('AC2')] }).close, true)
t('AC1 partly done stays open, naming what is not met', closeVerdict({ ticket: 'K-1', criteria: [met('AC1'), { id: 'AC2', met: false }] }), { ticket: 'K-1', close: false, reasons: ['AC2 NOT MET (no file:line)'] })
t('AC1 met without a file:line is NOT MET', closeVerdict({ ticket: 'K-1', criteria: [{ id: 'AC1', met: true }] }).close, false)
t('AC1 an unanswered criterion defaults to NOT MET', closeVerdict({ ticket: 'K-1', criteria: [{ id: 'AC1' }] }).close, false)
t('AC1 no criteria checked is never a close', closeVerdict({ ticket: 'K-1', criteria: [] }).reasons, ['no criteria were checked'])
t('AC1 an open PR on the key vetoes', closeVerdict({ ticket: 'K-1', criteria: [met('AC1')], open_prs: [7] }).reasons, ['PR #7 on the key is still open'])

// ---- fixture repo: origin/main holds the files the tickets cite, and the work landed under KAN-50
const T = realpathSync(mkdtempSync(join(tmpdir(), 'desk-groom-')))
let stub = null
process.on('exit', () => { if (stub) stub.kill(); rmSync(T, { recursive: true, force: true }) })
writeFileSync(join(T, 'gitconfig'), '[user]\n\temail = t@example.com\n\tname = t\n[init]\n\tdefaultBranch = main\n')
const env = { ...process.env, HOME: join(T, 'home'), GIT_CONFIG_GLOBAL: join(T, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  DESK_CONFIG_ROOT: join(T, 'home', '.config', 'desk'), DESK_ENV_MJS: join(SRC, 'desk', 'bin', 'desk-env.mjs'), PATH: `${join(SRC, 'bin')}:${process.env.PATH}` }
for (const k of ['DESK_CONFIG', 'DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_DEFAULT_BRANCH', 'DESK_AUTOPILOT_WORKER',
  'JIRA_SITE', 'JIRA_TOKEN', 'JIRA_EMAIL', 'JIRA_EMAIL_FILE', 'JIRA_TOKEN_FILE', 'JIRA_PROJECT', 'JIRA_PRIORITY_FIELD']) delete env[k]
mkdirSync(env.HOME)
const sh = (cwd, cmd, ...a) => { const r = spawnSync(cmd, a, { cwd, env, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`${cmd} ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim() }
const git = (cwd, ...a) => sh(cwd, 'git', ...a)
const O = join(T, 'origin.git'), R = join(T, 'repo')
git(T, 'init', '-q', '--bare', O); git(T, 'init', '-q', R)
mkdirSync(join(R, 'lib'))
writeFileSync(join(R, 'lib', 'admit.mjs'), 'export const FLAGS = []\n')
writeFileSync(join(R, 'lib', 'parse.mjs'), `${Array.from({ length: 20 }, (_, i) => (i === 14 ? 'export function parseRow(line) {' : `// line ${i + 1}`)).join('\n')}\n`)
writeFileSync(join(R, 'lib', 'render.mjs'), 'export const a = 1\nexport const b = 2\n')
git(R, 'add', '.'); git(R, 'commit', '-q', '-m', 'init')
writeFileSync(join(R, 'lib', 'admit.mjs'), "export const FLAGS = ['--hold']\n")
git(R, 'commit', '-q', '-am', 'feat(admit): KAN-50 the --hold flag holds a ticket on admit')
writeFileSync(join(R, 'docs.md'), 'the export format\n'); git(R, 'add', '.')
git(R, 'commit', '-q', '-m', 'docs: KAN-33 note the export format')
git(R, 'remote', 'add', 'origin', O); git(R, 'push', '-q', 'origin', 'main'); git(R, 'fetch', '-q', 'origin')
// A GitHub-shaped origin gives the repo its config slug; origin/main stays as fetched.
git(R, 'remote', 'set-url', 'origin', 'git@github.com:acme/groom.git')

// ---- stub Jira: the open backlog, one or more tickets per criterion
const P = 'customfield_10207', S = 'customfield_10208'
const blocks = (key, category = 'new', dir = 'in') => ({ id: `${key}-${dir}`, type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  [dir === 'in' ? 'inwardIssue' : 'outwardIssue']: { key, fields: { summary: key, status: { name: category === 'done' ? 'Done' : 'To Do', statusCategory: { key: category } } } } })
const relates = (key) => ({ id: `r-${key}`, type: { name: 'Relates', inward: 'relates to', outward: 'relates to' }, outwardIssue: { key, fields: { status: { name: 'To Do', statusCategory: { key: 'new' } } } } })
const epic = { key: 'KAN-1', fields: { summary: 'Admitting tickets' } }
const iss = (summary, description = '', extra = {}) => ({ summary, description, [P]: { value: 'P3' }, [S]: { value: 'S' }, ...extra })
const issues = {
  'KAN-1': iss('Admitting tickets', '', { issuetype: { name: 'Epic', hierarchyLevel: 1 }, [P]: { value: 'P2' }, [S]: { value: 'L' } }),
  // AC1: KAN-10's flag landed on main under KAN-50
  'KAN-10': iss('admit: take a --hold flag that holds the ticket', 'h2. Acceptance criteria\n# AC1: Given a key, when it is admitted with --hold, then it is held.\n\nThis adds a {{--hold}} flag; the flags live in {{lib/admit.mjs:1}}.', { parent: epic, created: '2020-01-01T00:00:00.000+0000' }),
  // AC5: a blank priority, taken from the epic; a title with no prefix its siblings share
  'KAN-11': iss('admit: list held tickets in the digest', '', { parent: epic, [P]: null }),
  'KAN-12': iss('count the rows', '', { parent: epic }),
  // AC6: blocked by a Done ticket
  'KAN-13': iss('admit: refuse a key twice', '', { parent: epic, issuelinks: [blocks('KAN-14', 'done')] }),
  'KAN-14': iss('admit: show the hold in desk-q', '', { parent: epic, status: { name: 'Done', statusCategory: { key: 'done' } } }),
  // AC2: the same defect twice
  'KAN-20': iss('export: the csv export drops the header row', '', { created: '2026-01-01T00:00:00.000+0000' }),
  'KAN-21': iss('export: csv export drops the header row on download', '', { created: '2026-02-01T00:00:00.000+0000' }),
  // AC3: a command one adds and another uses; prose naming a dependency; one changing the same function
  'KAN-30': iss('queue: pause a ticket', 'This adds a new command {{queue.mjs pause}}.'),
  'KAN-31': iss('digest: show paused tickets', 'The digest lists the tickets held by {{queue.mjs pause}}.'),
  'KAN-32': iss('desk-q: a paused badge', 'h2. Build on\n* KAN-30\'s command.'),
  'KAN-33': iss('export: a note on the csv format', 'Write the format down in {{docs.md}}.'),
  'KAN-34': iss('supervisor: skip paused tickets', 'Also reads {{queue.mjs pause}}, after KAN-30.', { issuelinks: [relates('KAN-30')] }),
  'KAN-35': iss('parse: skip blank lines', 'Rework {{parseRow()}} to skip blank lines.'),
  'KAN-36': iss('parse: keep quoted commas in one cell', 'Fix {{parseRow()}} so quoted commas stay in one cell.'),
  // AC4: a moved function, a moved file, a line past the end
  'KAN-40': iss('import: read the header once', 'The rule lives in {{parseRow()}} at {{lib/parse.mjs:3}}.'),
  'KAN-41': iss('render: pad the table', 'Rendering starts in {{src/render.mjs:2}}.'),
  'KAN-42': iss('import: trim cells', 'See {{lib/parse.mjs:400}}.'),
  // AC6: held behind a set that keeps growing, and a loop
  'KAN-60': iss('readme: document every feature', '', { issuelinks: Array.from({ length: 11 }, (_, i) => blocks(`KAN-${70 + i}`)) }),
  'KAN-61': iss('loop: the first half', '', { issuelinks: [blocks('KAN-62'), blocks('KAN-62', 'new', 'out')] }),
  'KAN-62': iss('loop: the second half', '', { issuelinks: [blocks('KAN-61'), blocks('KAN-61', 'new', 'out')] }),
}
issues['KAN-30'].issuelinks = [{ id: 'r-KAN-34', type: { name: 'Relates', inward: 'relates to', outward: 'relates to' }, inwardIssue: { key: 'KAN-34', fields: { status: { name: 'To Do', statusCategory: { key: 'new' } } } } }]
const fixture = { issues, children: { 'KAN-1': ['KAN-10', 'KAN-11', 'KAN-12', 'KAN-13', 'KAN-14'] },
  search: Object.keys(issues).filter((k) => k !== 'KAN-14') }
writeFileSync(join(T, 'fixture.json'), JSON.stringify(fixture))
const PORT = 20000 + Math.floor(Math.random() * 20000)
stub = spawn('python3', [join(SRC, 'tests', 'stub_jira.py'), String(PORT), join(T, 'requests.log'), '', join(T, 'fixture.json')], { stdio: 'ignore' })

const slug = /^SLUG='(.*)'$/m.exec(sh(R, 'node', env.DESK_ENV_MJS, 'where'))?.[1]
t('the fixture repo has a slug', !!slug, true)
const cfg = join(env.DESK_CONFIG_ROOT, 'repos', slug); mkdirSync(cfg, { recursive: true })
writeFileSync(join(cfg, 'config.md'), `## 4. Tracker\n\n| Field | Value |\n|---|---|\n| Tracker | \`jira\` |\n| Jira site | \`http://127.0.0.1:${PORT}\` |\n| Jira project | \`KAN\` "x" |\n`)
writeFileSync(join(cfg, 'jira-email'), 'me@example.com'); writeFileSync(join(cfg, 'atlassian-token'), 'good-token', { mode: 0o600 })
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
for (let i = 0; i < 50 && spawnSync('desk-jira', ['whoami'], { cwd: R, env }).status !== 0; i++) sleep(100)

const run = (...a) => spawnSync('node', [SCAN, ...a], { cwd: R, env, encoding: 'utf8' })
const r = run('scan', '--repo', R, '--default', 'main', '--project', 'KAN', '--priority', P, '--fields', S, '--done', 'Done', '--json')
t('scan exits 0', r.status, 0)
if (r.status !== 0) console.log(r.stderr)
const found = r.status === 0 ? JSON.parse(r.stdout) : []
const of = (check, ticket) => found.filter((f) => f.check === check && f.ticket === ticket)
const cmds = (check, ticket) => of(check, ticket).flatMap((f) => f.propose)

// AC1
const landed = of('landed', 'KAN-10')[0] ?? {}
t('AC1 work landed under another key is a close candidate', landed.verify, 'landed')
t('AC1 its evidence names the commit under KAN-50', (landed.evidence ?? []).some((e) => /KAN-50 the --hold flag/.test(e)), true)
t('AC1 and says the flag it adds is already on main', (landed.evidence ?? []).some((e) => /`--hold`, which KAN-10 says it adds, is already on main/.test(e)), true)
t('AC1 the criteria go to the verifier', (landed.criteria ?? []).map((c) => c.id), ['AC1'])
t('AC1 the proposal is the Done state, once verified', landed.propose, ['desk-jira transition KAN-10 Done'])
t('AC1 work landed under its own key is a candidate too', of('landed', 'KAN-33').length, 1)
t('AC1 a ticket with nothing on main is not', of('landed', 'KAN-31').length, 0)
t('AC1 the epic is not checked per ticket', found.filter((f) => f.ticket === 'KAN-1').length, 0)

// AC2
t('AC2 the newer duplicate is linked and closed', cmds('duplicate', 'KAN-21'), ['desk-jira link KAN-21 duplicates KAN-20', 'desk-jira transition KAN-21 Done'])
t('AC2 and verified first', of('duplicate', 'KAN-21')[0]?.verify, 'duplicate')
t('AC2 no other pair reads as a duplicate', found.filter((f) => f.check === 'duplicate').length, 1)

// AC3
t('AC3 a command one ticket adds and another uses is a dependency', cmds('link', 'KAN-31'), ['desk-jira link KAN-31 blocked-by KAN-30'])
t('AC3 with both lines as evidence', of('link', 'KAN-31')[0]?.evidence?.length, 2)
t('AC3 a ticket that builds on another in prose', cmds('link', 'KAN-32'), ['desk-jira link KAN-32 blocked-by KAN-30'])
t('AC3 two tickets that change the same function relate', cmds('link', 'KAN-35'), ['desk-jira link KAN-35 relates-to KAN-36'])
t('AC3 nothing without evidence', of('link', 'KAN-33').length, 0)
t('AC3 nothing where a link already exists', found.filter((f) => f.check === 'link' && [f.ticket, f.other].includes('KAN-34')).length, 0)

// AC4
const moved = of('stale', 'KAN-40')[0] ?? {}
t('AC4 a function that moved: the stale text and the edit', moved.edit, { from: 'lib/parse.mjs:3', to: 'lib/parse.mjs:15' })
t('AC4 its evidence quotes the line main has now', /line 3 of lib\/parse\.mjs on main is "\/\/ line 3"/.test((moved.evidence ?? [])[0]), true)
t('AC4 a file that moved', of('stale', 'KAN-41')[0]?.edit, { from: 'src/render.mjs:2', to: 'lib/render.mjs:2' })
t('AC4 a line past the end goes to a verifier', of('stale', 'KAN-42')[0]?.verify, 'stale')
t('AC4 a citation main still matches is not stale', of('stale', 'KAN-10').length, 0)

// AC5
t('AC5 a blank priority takes the epic\'s value', cmds('field', 'KAN-11'), [`desk-jira edit KAN-11 ${P}=P2`])
t('AC5 a title missing its siblings\' prefix', cmds('title', 'KAN-12'), ["desk-jira edit KAN-12 summary='admit: count the rows'"])
t('AC5 no field finding where every field is set', found.filter((f) => f.check === 'field').length, 1)

// AC6
t('AC6 a Done blocker is unlinked', cmds('blocker', 'KAN-13'), ['desk-jira unlink KAN-13 KAN-14 Blocks'])
const fan = of('blocker', 'KAN-60')[0] ?? {}
t('AC6 a set of blockers that keeps growing is rescoped', [fan.rescope, fan.propose?.length], [true, 12])
t('AC6 a Blocks loop is rescoped, once', found.filter((f) => f.check === 'blocker' && f.rescope && /loop/.test(f.evidence[0])).map((f) => f.ticket), ['KAN-61'])

// Read only: the scan sent no write to Jira.
const writes = spawnSync('grep', ['-cE', '"method": "(PUT|DELETE)"|issueLink"|/transitions|/comment', join(T, 'requests.log')], { encoding: 'utf8' }).stdout.trim()
t('the scan wrote nothing to Jira', writes, '0')

// The text form and the verdict command
const text = run('scan', '--repo', R, '--default', 'main', '--project', 'KAN', '--priority', P, '--fields', S)
t('the text form counts the tickets', /^groom-scan: 20 open tickets, \d+ findings/.test(text.stdout), true)
writeFileSync(join(T, 'results.json'), JSON.stringify([{ ticket: 'KAN-10', criteria: [met('AC1')] }, { ticket: 'KAN-33', criteria: [{ id: 'AC1', met: false }] }]))
const v = run('verdict', join(T, 'results.json'))
t('verdict closes only the fully met ticket', v.status === 0 ? JSON.parse(v.stdout).map((x) => [x.ticket, x.close]) : v.stderr, [['KAN-10', true], ['KAN-33', false]])

console.log(fails ? `${fails} FAILED` : 'all groom checks passed')
process.exit(fails ? 1 : 0)
