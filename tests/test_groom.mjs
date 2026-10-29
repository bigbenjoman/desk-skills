// suite: desk-groom ticket and epic checks (landed work, duplicates, links, stale text, fields, blockers, epics)
// desk-groom's scripted checks against a stub Jira and a fixture repo with its own origin: one case
// per DS-238 criterion (per ticket) and per DS-239 criterion (per epic), plus the close rule a
// verifier's results go through. Nothing reads the real Jira, GitHub or this checkout's history.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { criteriaOf, citationsOf, closeVerdict, sharedPrefix, prefixOf, newer, plain, premiseName, priorityRank, ticketOf, groomEpics, precloseCheck,
  batchOf, batchesOf, approvedNumbers, commandWords, readbackOf, priorityHandoff, handoffText, filesNamed, orderOf } from '../skills/desk-groom/bin/groom-scan.mjs'

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
t('fields: a filled list or user is set; null, empty and [] are blank',
  ticketOf({ key: 'K-1', fields: { a: [{ value: 'x' }, { value: 'y' }], b: { accountId: 'q1', displayName: 'Ben' }, c: [], d: '' } }, ['a', 'b', 'c', 'd', 'e']).fields,
  { a: 'x, y', b: 'Ben', c: null, d: null, e: null })

// AC1: a close needs every criterion the ticket has MET with a file:line, and no open PR on the key.
const met = (id, cite = 'lib/admit.mjs:1') => ({ id, met: true, cite })
t('AC1 every criterion met with a cite closes', closeVerdict({ ticket: 'K-1', criteria: [met('AC1'), met('AC2')] }, ['AC1', 'AC2']).close, true)
t('AC1 partly done stays open, naming what is not met', closeVerdict({ ticket: 'K-1', criteria: [met('AC1'), { id: 'AC2', met: false }] }, ['AC1', 'AC2']), { ticket: 'K-1', close: false, reasons: ['AC2 NOT MET (no file:line)'] })
t('AC1 a criterion the verifier left out is NOT MET', closeVerdict({ ticket: 'K-1', criteria: [met('AC1')] }, ['AC1', 'AC2', 'AC3']).reasons, ['AC2 NOT MET (not checked)', 'AC3 NOT MET (not checked)'])
t('AC1 met without a file:line is NOT MET', closeVerdict({ ticket: 'K-1', criteria: [{ id: 'AC1', met: true }] }, ['AC1']).close, false)
t('AC1 an unanswered criterion defaults to NOT MET', closeVerdict({ ticket: 'K-1', criteria: [{ id: 'AC1' }] }, ['AC1']).close, false)
t('AC1 no criteria checked is never a close', closeVerdict({ ticket: 'K-1', criteria: [] }, []).reasons, ['no criteria were checked'])
t('AC1 a key the scan named no candidate for is never a close', closeVerdict({ ticket: 'K-1', criteria: [met('AC1')] }, null).reasons, ['the scan named no landed candidate for K-1'])
t('AC1 an open PR on the key vetoes', closeVerdict({ ticket: 'K-1', criteria: [met('AC1')], open_prs: [7] }, ['AC1']).reasons, ['PR #7 on the key is still open'])

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
writeFileSync(join(R, 'lib', 'cells.mjs'), '// cells\n\n\n\nexport function trimCell(s) {\n  return s.trim()\n}\nconst retrimCell = 1\nconst x = trimCell(y)\n')
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
  // AC5: a title with a prefix other than the one its siblings share
  'KAN-15': iss('import: log each admitted key', '', { parent: epic }),
  // AC2: the same defect twice
  'KAN-20': iss('export: the csv export drops the header row', '', { created: '2026-01-01T00:00:00.000+0000' }),
  'KAN-21': iss('export: csv export drops the header row on download', '', { created: '2026-02-01T00:00:00.000+0000' }),
  // AC3: a command one adds and another uses; prose naming a dependency; one changing the same function
  'KAN-30': iss('queue: pause a ticket', 'This adds a new command {{queue.mjs pause}} and exports {{pauseAll()}}.'),
  'KAN-31': iss('digest: show paused tickets', 'The digest lists the tickets held by {{queue.mjs pause}}.'),
  'KAN-32': iss('desk-q: a paused badge', 'h2. Build on\n* KAN-30\'s command.'),
  'KAN-33': iss('export: a note on the csv format', 'Write the format down in {{docs.md}}.'),
  'KAN-34': iss('supervisor: skip paused tickets', 'Also reads {{queue.mjs pause}}, after KAN-30.', { issuelinks: [relates('KAN-30')] }),
  'KAN-35': iss('parse: skip blank lines', 'Rework {{parseRow()}} to skip blank lines.'),
  'KAN-36': iss('parse: keep quoted commas in one cell', 'Fix {{parseRow()}} so quoted commas stay in one cell.'),
  // AC3: ordering words about something else in the same paragraph; the key as the subject that reads
  'KAN-37': iss('retry: send review findings back to a fix worker', 'h2. Outcome\nFor Ben, running supervised batches. KAN-31 sends a red check or a conflict back to a fix worker, but a draft PR whose posted review found a P0 or P1 still waits for Ben (KAN-30 AC12 draws it in Needs you as {{draft · review not clean: 1 P1}}). A review finding is a code change a worker can make. After this, the pass sends it back to a fix worker with the findings in its briefing, at most twice, re-reviews the new head, and only a finding still open after the second try reaches Ben.'),
  'KAN-38': iss('records: write the fix and stuck records', 'h2. Out of scope\n* KAN-30 and KAN-31 read the {{fix}} and {{stuck}} records this writes.'),
  // AC4: a moved function, a moved file, a line past the end
  'KAN-40': iss('import: read the header once', 'The rule lives in {{parseRow()}} at {{lib/parse.mjs:3}}.'),
  'KAN-41': iss('render: pad the table', 'Rendering starts in {{src/render.mjs:2}}.'),
  'KAN-42': iss('import: trim cells', 'See {{lib/parse.mjs:400}}.'),
  // AC4: a name on more than one line of the file, so the new line is a verifier's call
  'KAN-44': iss('cells: pad each cell', 'The rule lives in {{trimCell()}} at {{lib/cells.mjs:1}}.'),
  // AC4: premises with no citation: names main no longer has, beside ones it has and one KAN-30 adds
  'KAN-46': iss('import: skip the byte order mark', 'h2. Context\nThe header is read by {{readHeader()}} in {{lib/parse.mjs}} and {{lib/header.mjs}}, behind the {{--bom}} flag; {{pauseAll()}} stops it.\nRows go through {{parseRow()}} in {{docs.md}}.'),
  // AC4: a criterion says what the work will add, so it is no premise
  'KAN-47': iss('notes: a strict mode', 'h2. Acceptance criteria\n# AC1: Given {{--strict}}, when {{checkStrict()}} runs, then rows are checked.'),
  // AC3: a bare mention of another ticket, with nothing that orders them
  'KAN-45': iss('notes: a glossary page', 'See KAN-30 for context.'),
  // AC6: held behind a set that keeps growing, and a loop
  'KAN-60': iss('readme: document every feature', 'Documents the flags KAN-70 and KAN-71 add.', { issuelinks: Array.from({ length: 11 }, (_, i) => blocks(`KAN-${70 + i}`)) }),
  'KAN-61': iss('loop: the first half', '', { issuelinks: [blocks('KAN-62'), blocks('KAN-62', 'new', 'out')] }),
  'KAN-62': iss('loop: the second half', '', { issuelinks: [blocks('KAN-61'), blocks('KAN-61', 'new', 'out')] }),

  // ---- DS-239 epic checks
  // AC1, AC2, AC4, AC7: an epic in To Do with DoD items, a Children section that names a split, a
  // closed, a renamed, a foreign and a missing ticket, and a P1 child ranked above it
  'KAN-100': iss('Search: find any ticket by its words', 'h2. Outcome\nFor Ben, finding a ticket by its words.\n\nh2. Definition of done\n'
    + '# DoD1: Given a query, when search runs, then matching tickets are listed (index child).\n'
    + '# DoD2: Given a ticket, when its title changes, then the index follows it (KAN-102).\n'
    + '# DoD3: Given a misspelt query, when search runs, then near matches are suggested.\n'
    + '# DoD4: Given an archived project, when search runs, then its tickets are left out.\n'
    + '# DoD5: Given two hits, when search runs, then the closer one ranks first.\n'
    + '# DoD6: Given a quoted phrase, when search runs, then only exact phrases count.\n\nh2. Children\n'
    + '# KAN-101 (S): index: build the word index\n# KAN-102 (S): reindex on title change\n# KAN-103 (M): ranking\n'
    + '# KAN-107 (S): the old query parser\n# KAN-108 (S): highlight the hits\n# KAN-109 (S): export results\n# KAN-199 (S): gone',
  { issuetype: { name: 'Epic', hierarchyLevel: 1 } }),
  'KAN-101': iss('search: build the word index', '', { parent: { key: 'KAN-100' } }),
  'KAN-102': iss('search: reindex a ticket when its title changes', '', { parent: { key: 'KAN-100' }, status: { name: 'Done', statusCategory: { key: 'done' } } }),
  'KAN-103': iss('search: rank the hits', '', { parent: { key: 'KAN-100' }, status: { name: 'Done', statusCategory: { key: 'done' } },
    issuelinks: ['KAN-105', 'KAN-106'].map((key) => ({ id: `s-${key}`, type: { name: 'Issue split', inward: 'split from', outward: 'split to' }, outwardIssue: { key, fields: { status: { name: 'To Do', statusCategory: { key: 'new' } } } } })) }),
  'KAN-104': iss('search: suggest near matches for a misspelt query', '', { parent: { key: 'KAN-100' }, [P]: { value: 'P1' } }),
  'KAN-105': iss('search: rank by title', 'Covers KAN-100\'s DoD5.', { parent: { key: 'KAN-100' } }),
  'KAN-106': iss('search: rank by recency', '', { parent: { key: 'KAN-100' } }),
  'KAN-107': iss('search: a query parser', 'Owns DoD6.', { parent: { key: 'KAN-100' }, status: { name: 'Won\'t Do', statusCategory: { key: 'done' } } }),
  'KAN-108': iss('search: bold each match in results', '', { parent: { key: 'KAN-100' } }),
  'KAN-109': iss('admit: export results', '', { parent: epic }),
  // AC4: P2, blocking an epic at P3; its own parent is at P2 too
  'KAN-111': iss('admit: index each admitted ticket', '', { parent: epic, [P]: { value: 'P2' }, issuelinks: [blocks('KAN-100', 'new', 'out')] }),
  // AC7: an epic in progress whose every child is done, and one with no children
  'KAN-120': iss('Exports: every table as csv', '', { issuetype: { name: 'Epic', hierarchyLevel: 1 }, status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } }),
  'KAN-121': iss('exports: the queue as csv', '', { parent: { key: 'KAN-120' }, status: { name: 'Done', statusCategory: { key: 'done' } } }),
  'KAN-122': iss('exports: the digest as csv', '', { parent: { key: 'KAN-120' }, status: { name: 'Done', statusCategory: { key: 'done' } } }),
  'KAN-130': iss('Plugins: load third-party plugins', '', { issuetype: { name: 'Epic', hierarchyLevel: 1 } }),
  // AC3, AC5: a loose ticket with one home, one that fits two epics, one that fits only a bucket
  'KAN-140': iss('search: rank exact title matches first', ''),
  'KAN-141': iss('notifications: a weekly digest of parked tickets', ''),
  'KAN-142': iss('theme: a colour picker for the terminal', ''),
  'KAN-150': iss('Notifications: email a digest of parked tickets', '', { issuetype: { name: 'Epic', hierarchyLevel: 1 } }),
  'KAN-151': iss('Notifications: post a digest of parked tickets to Slack', '', { issuetype: { name: 'Epic', hierarchyLevel: 1 } }),
  'KAN-160': iss('Misc: odds and ends (colour picker, terminal)', '', { issuetype: { name: 'Epic', hierarchyLevel: 1 } }),
  // AC4: most of an epic's children sit above it, so the epic rises, once
  'KAN-170': iss('Layout: fit desk-q to any width', '', { issuetype: { name: 'Epic', hierarchyLevel: 1 }, [P]: { value: 'P4' } }),
  'KAN-171': iss('layout: wrap long titles', '', { parent: { key: 'KAN-170' }, [P]: { value: 'P2' } }),
  'KAN-172': iss('layout: drop columns on narrow screens', '', { parent: { key: 'KAN-170' }, [P]: { value: 'P2' } }),
}
issues['KAN-30'].issuelinks = [{ id: 'r-KAN-34', type: { name: 'Relates', inward: 'relates to', outward: 'relates to' }, inwardIssue: { key: 'KAN-34', fields: { status: { name: 'To Do', statusCategory: { key: 'new' } } } } }]
const fixture = { issues,
  children: { 'KAN-1': ['KAN-10', 'KAN-11', 'KAN-12', 'KAN-13', 'KAN-14', 'KAN-15', 'KAN-109', 'KAN-111'],
    'KAN-100': ['KAN-101', 'KAN-102', 'KAN-103', 'KAN-104', 'KAN-105', 'KAN-106', 'KAN-107', 'KAN-108'],
    'KAN-120': ['KAN-121', 'KAN-122'], 'KAN-170': ['KAN-171', 'KAN-172'] },
  search: Object.keys(issues).filter((k) => issues[k].status?.statusCategory?.key !== 'done') }
writeFileSync(join(T, 'fixture.json'), JSON.stringify(fixture))
// The stub writes the port it listens on (a free one if this one is taken) to the ready file.
const ASKED = 20000 + Math.floor(Math.random() * 20000), READY = join(T, 'stub.port')
stub = spawn('python3', [join(SRC, 'tests', 'stub_jira.py'), String(ASKED), join(T, 'requests.log'), '', join(T, 'fixture.json')],
  { stdio: 'ignore', env: { ...process.env, STUB_READY: READY } })
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
for (let i = 0; i < 300 && !existsSync(READY); i++) sleep(100)
const PORT = existsSync(READY) ? Number(readFileSync(READY, 'utf8')) : 0
if (!PORT) { console.log(`FAIL the Jira stub (tests/stub_jira.py) did not listen on port ${ASKED} within 30 s`); process.exit(1) }

const slug = /^SLUG='(.*)'$/m.exec(sh(R, 'node', env.DESK_ENV_MJS, 'where'))?.[1]
t('the fixture repo has a slug', !!slug, true)
const cfg = join(env.DESK_CONFIG_ROOT, 'repos', slug); mkdirSync(cfg, { recursive: true })
writeFileSync(join(cfg, 'config.md'), `## 4. Tracker\n\n| Field | Value |\n|---|---|\n| Tracker | \`jira\` |\n| Jira site | \`http://127.0.0.1:${PORT}\` |\n| Jira project | \`KAN\` "x" |\n`)
writeFileSync(join(cfg, 'jira-email'), 'me@example.com'); writeFileSync(join(cfg, 'atlassian-token'), 'good-token', { mode: 0o600 })

const run = (...a) => spawnSync('node', [SCAN, ...a], { cwd: R, env, encoding: 'utf8' })
const r = run('scan', '--repo', R, '--default', 'main', '--project', 'KAN', '--priority', P, '--fields', S, '--size', S, '--done', 'Done', '--in-progress', 'In Progress', '--json')
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
const PER_TICKET = ['landed', 'duplicate', 'link', 'stale', 'field', 'title', 'blocker']
t('AC1 the epic is not checked per ticket', found.filter((f) => f.ticket === 'KAN-1' && PER_TICKET.includes(f.check)).length, 0)

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
t('AC3 nothing from a bare mention of another ticket', found.filter((f) => f.check === 'link' && [f.ticket, f.other].includes('KAN-45')).length, 0)
t('AC3 nothing where a link already exists', found.filter((f) => f.check === 'link' && [f.ticket, f.other].includes('KAN-34')).length, 0)
t('AC3 ordering words about something else in the paragraph link nothing', of('link', 'KAN-37').length, 0)
t('AC3 a key that reads what this writes is blocked by it', cmds('link', 'KAN-38'), ['desk-jira link KAN-38 blocks KAN-30', 'desk-jira link KAN-38 blocks KAN-31'])
t('order: wording before the key, in its clause', ['Build on DS-279\'s `stateOf`.', 'Ship it after DS-279 merges.', 'Reads the stuck record from DS-279.', 'Lands before DS-279.'].map((l) => orderOf(l, 'DS-279')),
  ['blocked-by', 'blocked-by', 'blocked-by', 'blocks'])
t('order: the key as the subject of a dependency', ['DS-279 reads the records this writes.', 'DS-280 and DS-279 need this.'].map((l) => orderOf(l, 'DS-279')), ['blocks', 'blocks'])
t('order: a word in another sentence, after the key or in brackets orders nothing',
  ['This waits for review. DS-279 is in scope.', 'DS-279 lands after this.', 'It still waits for Ben (DS-279 draws it); after this it moves.', 'See DS-279 for context.'].map((l) => orderOf(l, 'DS-279')),
  [null, null, null, null])
t('order: the nearest word before the key wins', orderOf('Once merged, this goes before DS-279.', 'DS-279'), 'blocks')
t('order: wording before the key outranks a verb after it', ['Ship after DS-279 reads the records.', 'Once DS-279 reads its config, wire it in.', 'This needs what DS-279 reads.'].map((l) => orderOf(l, 'DS-279')),
  ['blocked-by', 'blocked-by', 'blocked-by'])
t('order: every mention of the key is read', orderOf('See DS-279 for context. Ship after DS-279 merges.', 'DS-279'), 'blocked-by')
t('order: mentions that disagree order nothing', orderOf('Lands before DS-279. Then after DS-279 merges, retry.', 'DS-279'), null)

// AC4
const moved = of('stale', 'KAN-40')[0] ?? {}
t('AC4 a function that moved: the stale text and the edit', moved.edit, { from: 'lib/parse.mjs:3', to: 'lib/parse.mjs:15' })
t('AC4 its evidence quotes the line main has now', /line 3 of lib\/parse\.mjs on main is "\/\/ line 3"/.test((moved.evidence ?? [])[0]), true)
t('AC4 a file that moved', of('stale', 'KAN-41')[0]?.edit, { from: 'src/render.mjs:2', to: 'lib/render.mjs:2' })
t('AC4 and, found by its name alone, goes to a verifier', of('stale', 'KAN-41')[0]?.verify, 'stale')
const twice = of('stale', 'KAN-44')[0] ?? {}
t('AC4 a name on two lines: no edit, a verifier picks', [twice.edit, twice.verify], [null, 'stale'])
t('AC4 the lines it is on, whole words only', /`trimCell` is on lines 5, 9$/.test((twice.evidence ?? [])[0]), true)
t('AC4 a line past the end goes to a verifier', of('stale', 'KAN-42')[0]?.verify, 'stale')
t('AC4 a citation main still matches is not stale', of('stale', 'KAN-10').length, 0)
const premise = of('stale', 'KAN-46')
t('AC4 a premise with no citation: one finding for the line that names what main lacks', premise.length, 1)
t('AC4 it lists the stale text and the names gone, not the ones main has or another ticket adds',
  (premise[0]?.evidence ?? [])[0], 'Context: "The header is read by `readHeader()` in `lib/parse.mjs` and `lib/header.mjs`, behind the `--bom` flag; `pauseAll()` stops it." names `readHeader`, `lib/header.mjs`, `--bom`, which main does not have')
t('AC4 and proposes the edit, once a verifier has the corrected text', [premise[0]?.propose, premise[0]?.verify], [['desk-jira edit KAN-46 description=@<KAN-46 description with the edit>'], 'stale'])
t('AC4 a criterion is no premise', of('stale', 'KAN-47').length, 0)
t('AC4 premise names: a function, flag or file; not a command or a placeholder',
  ['parseRow(line)', '--bom', 'lib/a.mjs', 'docs.md', 'queue.mjs pause', '<state>/x.json', '-v'].map((s) => premiseName(s)?.kind ?? null),
  ['function', 'flag', 'file', 'file', null, null, null])

// AC5
t('AC5 a blank priority takes the epic\'s value', cmds('field', 'KAN-11'), [`desk-jira edit KAN-11 ${P}=P2`])
t('AC5 a title missing its siblings\' prefix', cmds('title', 'KAN-12'), ["desk-jira edit KAN-12 summary='admit: count the rows'"])
t('AC5 a title with a prefix other than its siblings\' is retitled, the old prefix replaced', cmds('title', 'KAN-15'), ["desk-jira edit KAN-15 summary='admit: log each admitted key'"])
t('AC5 and says which prefix it has', /and "import: log each admitted key" starts "import:"$/.test(of('title', 'KAN-15')[0]?.evidence?.[0]), true)
t('AC5 only those two: a title with the shared prefix is left alone', found.filter((f) => f.check === 'title').map((f) => f.ticket), ['KAN-12', 'KAN-15'])
t('AC5 no field finding where every field is set', found.filter((f) => f.check === 'field').length, 1)

// AC6
t('AC6 a Done blocker is unlinked', cmds('blocker', 'KAN-13'), ['desk-jira unlink KAN-13 KAN-14 Blocks'])
const fan = of('blocker', 'KAN-60')[0] ?? {}
t('AC6 a set of blockers that keeps growing is rescoped', fan.rescope, true)
// DS-239 AC5: which blockers it needs, and which link in a loop goes, are asked, never proposed
t('DS-239 AC5 a rescope of many blockers is a question that proposes nothing', [fan.kind, fan.question, fan.propose], ['question', 'Which of its 11 open blockers does KAN-60 truly need?', []])
t('DS-239 AC5 keeping the blockers its text names is recommended', [fan.recommend, fan.options?.length], [`keep KAN-70, KAN-71, which KAN-60 names, and unlink the other 9: ${Array.from({ length: 9 }, (_, i) => `KAN-${72 + i}`).join(', ')}`, 3])
const loops = found.filter((f) => f.check === 'blocker' && f.rescope && /loop/.test(f.evidence[0]))
t('AC6 a Blocks loop is rescoped, once', loops.map((f) => f.ticket), ['KAN-61'])
t('DS-239 AC5 a loop is a question, one option per link, and proposes nothing', [loops[0]?.kind, loops[0]?.options, loops[0]?.recommend, loops[0]?.propose],
  ['question', ['KAN-61 does not need KAN-62: desk-jira unlink KAN-61 KAN-62 Blocks', 'KAN-62 does not need KAN-61: desk-jira unlink KAN-62 KAN-61 Blocks'],
    'KAN-61 does not need KAN-62: desk-jira unlink KAN-61 KAN-62 Blocks', []])

// ---- DS-239: the epic checks
const one = (check, ticket) => of(check, ticket)[0] ?? {}
// AC1
const gaps = of('coverage', 'KAN-100')
t('DS-239 AC1 a DoD item no child covers is a gap, naming it', gaps.map((f) => f.item), ['DoD3', 'DoD4', 'DoD6'])
t('DS-239 AC1 the gap quotes the item', /^DoD4: "Given an archived project, when search runs, then its tickets are left out\."/.test(gaps.find((f) => f.item === 'DoD4')?.evidence?.[0]), true)
t('DS-239 AC1 a child sharing its words is a candidate for a verifier', [gaps.find((f) => f.item === 'DoD3')?.candidates, gaps.find((f) => f.item === 'DoD3')?.verify], [['KAN-104'], 'coverage'])
t('DS-239 AC1 a gap with no near child goes straight to the report', gaps.find((f) => f.item === 'DoD4')?.verify, undefined)
t('DS-239 AC1 a gap proposes nothing', gaps.flatMap((f) => f.propose), [])
t('DS-239 AC1 a child closed as won\'t do covers nothing', gaps.some((f) => f.item === 'DoD6'), true)
t('DS-239 AC1 an epic with no DoD has no coverage findings', found.filter((f) => f.check === 'coverage' && f.ticket !== 'KAN-100').length, 0)
// AC2
const kids = one('children', 'KAN-100')
t('DS-239 AC2 the corrected Children section', kids.section, ['# KAN-101 (S): index: build the word index', '# KAN-102 (S): reindex on title change',
  '# KAN-105 (S): rank by title', '# KAN-106 (S): rank by recency', '# KAN-108 (S): bold each match in results', '# KAN-104 (S): suggest near matches for a misspelt query'])
t('DS-239 AC2 a split, a closed, a renamed, a foreign and a missing child, and an unlisted one, each reported', kids.evidence, [
  'KAN-103 is listed, but was split into KAN-105, KAN-106',
  'KAN-105 is a child of KAN-100 in Jira but is not listed: "search: rank by title"',
  'KAN-106 is a child of KAN-100 in Jira but is not listed: "search: rank by recency"',
  'KAN-107 is listed, but was closed as Won\'t Do',
  'KAN-108 is listed as "highlight the hits", but is now "search: bold each match in results"',
  'KAN-109 is listed, but is not a child of KAN-100 in Jira (its parent is KAN-1)',
  'KAN-199 is listed, but Jira has no such issue',
  'KAN-104 is a child of KAN-100 in Jira but is not listed: "search: suggest near matches for a misspelt query"'])
t('DS-239 AC2 proposed as one description edit', kids.propose, ['desk-jira edit KAN-100 description=@<KAN-100 description with its Children section as below>'])
t('DS-239 AC2 an epic with no Children section gets none', found.filter((f) => f.check === 'children').map((f) => f.ticket), ['KAN-100'])
// AC3, AC5
const home = one('loose', 'KAN-140')
t('DS-239 AC3 a loose ticket is a question with a recommended epic', [home.kind, home.recommend, home.propose], ['question', 'KAN-100 (Search: find any ticket by its words)', []])
t('DS-239 AC3 with a new epic as the other option', home.options?.at(-1)?.startsWith('a new epic: '), true)
const none = one('loose', 'KAN-142')
t('DS-239 AC3 no fitting epic: a new epic, with a proposed title', [none.recommend?.startsWith('a new epic: '), none.title], [true, 'theme: a colour picker for the terminal'])
t('DS-239 AC3 never a catch-all bucket epic', found.filter((f) => f.check === 'loose').some((f) => (f.options ?? []).some((o) => o.startsWith('KAN-160'))), false)
t('DS-239 AC3 a ticket with a parent is not loose', of('loose', 'KAN-104').length + of('loose', 'KAN-10').length, 0)
t('DS-239 AC3 an epic is not loose', of('loose', 'KAN-100').length, 0)
const two = one('loose', 'KAN-141')
t('DS-239 AC5 two epics that fit equally: both are options', two.options?.slice(0, 2).map((o) => o.split(' ')[0]), ['KAN-150', 'KAN-151'])
t('DS-239 AC5 asked as a judgement call, with a recommendation and no fix', [/about equally/.test(two.question), !!two.recommend, two.propose], [true, true, []])
// AC4
t('DS-239 AC4 a P1 child above its P3 epic comes down', one('priority', 'KAN-104').propose, [`desk-jira edit KAN-104 ${P}=P3`])
t('DS-239 AC4 with the evidence', one('priority', 'KAN-104').evidence, ['KAN-104 is P1, above its parent epic KAN-100, at P3', '0 of KAN-100\'s 4 other open children are at P1 or higher', 'so KAN-104 comes down to P3'])
t('DS-239 AC4 a ticket above the epic it blocks', [one('priority', 'KAN-111').other, one('priority', 'KAN-111').propose], ['KAN-100', [`desk-jira edit KAN-111 ${P}=P3`]])
t('DS-239 AC4 most children above the epic: the epic rises, once', found.filter((f) => f.check === 'priority' && f.other === 'KAN-170').flatMap((f) => f.propose), [`desk-jira edit KAN-170 ${P}=P2`])
t('DS-239 AC4 no pair where the ticket is at or below its epic', found.filter((f) => f.check === 'priority').map((f) => f.ticket).sort(), ['KAN-104', 'KAN-111', 'KAN-171'])
// AC7
t('DS-239 AC7 an epic in To Do with started or done children goes to In Progress', one('status', 'KAN-100').propose, ["desk-jira transition KAN-100 'In Progress'"])
t('DS-239 AC7 naming the children it rests on', one('status', 'KAN-100').evidence, ['KAN-100 is To Do, but KAN-102 is Done, KAN-103 is Done, KAN-107 is Won\'t Do'])
t('DS-239 AC7 an epic whose every child is done goes to Done', [one('status', 'KAN-120').propose, one('status', 'KAN-120').evidence], [['desk-jira transition KAN-120 Done'], ['every child of KAN-120 is done: KAN-121 (Done), KAN-122 (Done)']])
t('DS-239 AC7 an epic with no children is left alone', of('status', 'KAN-130').length + of('status', 'KAN-150').length, 0)
t('DS-239 AC7 an epic with only open children is left alone', of('status', 'KAN-170').length, 0)
// AC6: every finding is a fix (proposed), a question (asked, nothing proposed) or a report
t('DS-239 AC6 every fix is proposed and never asked', found.filter((f) => f.kind === 'fix' && (!f.propose.length || f.options || f.question)).map((f) => `${f.check} ${f.ticket}`), [])
t('DS-239 AC6 every question has options and a recommendation, and proposes nothing', found.filter((f) => f.kind === 'question' && (!(f.options?.length) || !f.options.includes(f.recommend) || f.propose.length)).map((f) => f.ticket), [])
t('DS-239 AC6 only loose tickets and blocker rescopes are asked by the scan', [...new Set(found.filter((f) => f.kind === 'question').map((f) => f.check))].sort(), ['blocker', 'loose'])
t('DS-239 AC6 a Done blocker is a fix, not a question', of('blocker', 'KAN-13').map((f) => f.kind), ['fix'])
t('DS-239 AC6 every finding has a kind', found.filter((f) => !['fix', 'question', 'report'].includes(f.kind)).length, 0)
t('DS-239 priority order: P0 first, named priorities, unknown values', ['P0', 'P3', 'Highest', 'low', 'urgent', null].map(priorityRank), [0, 3, 0, 3, null, null])
// An epic at P3 under a P0 child and three P1s: the P1s raise it to P1, so the P0 comes down only to P1,
// and a P1 the raise already meets is not lowered at all.
const rec = (key, p, extra = {}) => ticketOf({ key, fields: { summary: `work ${key}`, [P]: { value: p }, ...extra } }, [P])
const path = (kids, ...more) => {
  const ep = rec('E-1', 'P3', { issuetype: { name: 'Epic', hierarchyLevel: 1 } })
  const ks = kids.map(([k, p]) => rec(k, p, { parent: { key: 'E-1' } }))
  return groomEpics({ tickets: [ep, ...ks, ...more], children: { 'E-1': ks }, priority: P }).filter((f) => f.check === 'priority').map((f) => [f.ticket, f.propose[0], f.evidence[2]])
}
t('DS-239 AC4 a lowering settles at the epic\'s raised priority', path([['A-1', 'P0'], ['B-1', 'P1'], ['C-1', 'P1'], ['D-1', 'P1']]),
  [['A-1', `desk-jira edit A-1 ${P}=P1`, 'so A-1 comes down to P1, where E-1 rises to'], ['B-1', `desk-jira edit E-1 ${P}=P1`, 'so E-1 rises to P1']])
// Two P1 children each see one of three siblings at P1 and come down; a P1 ticket blocking the epic sees
// two of its four children there and raises it, which meets both children, so neither is lowered.
const blocker = rec('T-1', 'P1', { issuelinks: [{ type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'E-1' } }] })
t('DS-239 AC4 a lowering the raise already meets is dropped', path([['B-1', 'P1'], ['C-1', 'P1'], ['D-1', 'P3'], ['F-1', 'P3']], blocker).map((x) => x.slice(0, 2)),
  [['T-1', `desk-jira edit E-1 ${P}=P1`]])

// Read only: the scan sent no write to Jira.
const writes = spawnSync('grep', ['-cE', '"method": "(PUT|DELETE)"|issueLink"|/transitions|/comment', join(T, 'requests.log')], { encoding: 'utf8' }).stdout.trim()
t('the scan wrote nothing to Jira', writes, '0')

// The text form and the verdict command
const text = run('scan', '--repo', R, '--default', 'main', '--project', 'KAN', '--priority', P, '--fields', S)
t('the text form counts the tickets', /^groom-scan: 46 open tickets, \d+ findings/.test(text.stdout), true)
t('the text form marks a question and its recommended option', /\nloose +KAN-141 +\[question\]\n(?:.*\n)*? {2}option {2}: KAN-150 .*\(recommended\)/.test(text.stdout), true)
writeFileSync(join(T, 'scan.json'), r.stdout)
writeFileSync(join(T, 'results.json'), JSON.stringify([{ ticket: 'KAN-10', criteria: [met('AC1')] }, { ticket: 'KAN-33', criteria: [{ id: 'AC1', met: false }] }, { ticket: 'KAN-31', criteria: [met('AC1')] }]))
const v = run('verdict', join(T, 'results.json'), '--scan', join(T, 'scan.json'))
t('verdict closes only the fully met scan candidate', v.status === 0 ? JSON.parse(v.stdout).map((x) => [x.ticket, x.close]) : v.stderr, [['KAN-10', true], ['KAN-33', false], ['KAN-31', false]])
t('verdict refuses without the scan', run('verdict', join(T, 'results.json')).status, 2)

// preclose: an approved close is checked again just before it is written. A fake gh answers the open-PR
// search from $T/gh-prs.json, or fails while $T/gh-fail exists; the stub Jira has KAN-10 in To Do.
const pr = (number, title, headRefName = 'feat/x') => ({ number, title, headRefName, isDraft: true, createdAt: '2026-10-27T10:32:00Z' })
t('DS-283 AC1 a PR on the key keeps it open, named', precloseCheck({ ticket: 'K-1', before: 'In Progress', status: 'In Progress', prs: [pr(233, 'feat: K-1 the hold flag'), pr(9, 'K-12 other')] }),
  { ticket: 'K-1', close: false, reasons: ['PR #233 on the key opened after the verdict'], report: 'kept open: PR #233 on the key opened after the verdict' })
t('DS-283 AC2 no PR on the key and the same status closes', precloseCheck({ ticket: 'K-1', before: 'In Progress', status: 'in progress', prs: [pr(9, 'K-12 other', 'fix/K-1-2')] }).close, true)
t('DS-283 AC3 a status moved since the verdict keeps it open, naming it', precloseCheck({ ticket: 'K-1', before: 'To Do', status: 'Done', prs: [] }).report, 'kept open: K-1 is now Done, not To Do as at the verdict')
t('DS-283 AC4 a failed search is a check that did not run, never no PR', precloseCheck({ ticket: 'K-1', before: 'To Do', status: 'To Do', prs: null, prsError: 'gh pr list failed: HTTP 502' }).report,
  'kept open: the open-PR check did not run (gh pr list failed: HTTP 502)')
t('DS-283 a failed Jira read keeps it open', precloseCheck({ ticket: 'K-1', before: 'To Do', status: null, statusError: 'desk-jira get failed: HTTP 500', prs: [] }).close, false)
t('DS-283 a key the scan named no landed candidate for is never a close', precloseCheck({ ticket: 'K-1', before: null, status: 'To Do', prs: [] }).reasons, ['the scan named no landed candidate for K-1'])
t('DS-283 the scan records the status each landed verdict rests on', of('landed', 'KAN-10').map((f) => f.status), ['To Do'])
const fakeBin = join(T, 'fake-bin'); mkdirSync(fakeBin)
writeFileSync(join(fakeBin, 'gh'), `#!/bin/sh\necho "$@" >> '${join(T, 'gh.log')}'\nif [ -e '${join(T, 'gh-fail')}' ]; then echo 'HTTP 502: Bad Gateway' >&2; exit 1; fi\ncat '${join(T, 'gh-prs.json')}'\n`, { mode: 0o755 })
const pre = (scanFile = join(T, 'scan.json')) => {
  const x = spawnSync('node', [SCAN, 'preclose', 'KAN-10', '--scan', scanFile, '--repo', 'acme/groom'], { cwd: R, env: { ...env, PATH: `${fakeBin}:${env.PATH}` }, encoding: 'utf8' })
  return x.stdout ? { code: x.status, ...JSON.parse(x.stdout) } : { code: x.status, err: x.stderr }
}
writeFileSync(join(T, 'gh-prs.json'), JSON.stringify([pr(233, 'feat(admit): KAN-10 hold on admit'), pr(234, 'KAN-100 search')]))
t('DS-283 AC1 preclose: a PR opened after the verdict keeps it open', [pre().code, pre().report], [1, 'kept open: PR #233 on the key opened after the verdict'])
t('DS-283 preclose searches the repo\'s open PRs for the key', /pr list --repo acme\/groom --search KAN-10 --state open/.test(spawnSync('cat', [join(T, 'gh.log')], { encoding: 'utf8' }).stdout), true)
writeFileSync(join(T, 'gh-prs.json'), JSON.stringify([pr(234, 'KAN-100 search')]))
t('DS-283 AC2 preclose: no PR on the key closes', [pre().code, pre().close], [0, true])
writeFileSync(join(T, 'scan-moved.json'), JSON.stringify(found.map((f) => (f.check === 'landed' && f.ticket === 'KAN-10' ? { ...f, status: 'In Review' } : f))))
t('DS-283 AC3 preclose: a status moved since the verdict keeps it open', [pre(join(T, 'scan-moved.json')).code, pre(join(T, 'scan-moved.json')).report], [1, 'kept open: KAN-10 is now To Do, not In Review as at the verdict'])
writeFileSync(join(T, 'gh-fail'), '')
t('DS-283 AC4 preclose: a failed search keeps it open and says so', [pre().code, pre().report], [1, 'kept open: the open-PR check did not run (gh pr list failed: HTTP 502: Bad Gateway)'])
t('DS-283 preclose refuses without the scan', spawnSync('node', [SCAN, 'preclose', 'KAN-10'], { cwd: R, env, encoding: 'utf8' }).status, 2)

// ---- DS-240: one approval list, the running batch left alone, a priority epic handed off
const jiraWrites = () => spawnSync('cat', [join(T, 'requests.log')], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((q) => q.method !== 'GET' && !q.path.startsWith('/rest/api/3/search/jql')).length
t('DS-240 AC1 the scan wrote nothing to Jira', jiraWrites(), 0)

// AC2: a queue whose batch runs KAN-21, holds KAN-11 and KAN-30, and finished KAN-14
const Q = join(T, 'queue.json')
writeFileSync(Q, JSON.stringify({ batch: 'groom-7', tickets: { 'KAN-21': { state: 'running' }, 'KAN-11': { state: 'parked' }, 'KAN-30': { state: 'triaged' }, 'KAN-14': { state: 'done' } } }))
const rq = run('scan', '--repo', R, '--default', 'main', '--project', 'KAN', '--priority', P, '--fields', S, '--size', S, '--done', 'Done', '--in-progress', 'In Progress', '--queue', Q, '--json')
t('DS-240 AC2 the scan with a queue exits 0', rq.status, 0)
const inQ = rq.status === 0 ? JSON.parse(rq.stdout) : []
const names = (f, k) => [f.ticket, f.other, ...f.propose, ...(f.options ?? [])].some((s) => new RegExp(`\\b${k}\\b`).test(s ?? ''))
const on = (k) => inQ.filter((f) => names(f, k))
t('DS-240 AC2 a running ticket gets no proposal', on('KAN-21').map((f) => [f.check, f.kind, f.propose.length]), [['duplicate', 'left', 0], ['loose', 'left', 0]])
t('DS-240 AC2 and says why', on('KAN-21')[0]?.left, 'KAN-21 is running in batch groom-7')
t('DS-240 AC2 nor does a held one, nor a link to one', [...new Set(on('KAN-11').concat(on('KAN-30')).map((f) => `${f.kind} ${f.propose.length}`))], ['left 0'])
t('DS-240 AC2 a left candidate gets no verifier', on('KAN-21').some((f) => f.verify), false)
t('DS-240 AC2 a ticket the batch finished is groomed as before', cmds('blocker', 'KAN-13'), inQ.filter((f) => f.check === 'blocker' && f.ticket === 'KAN-13').flatMap((f) => f.propose))
t('DS-240 AC2 every other finding is unchanged', inQ.filter((f) => f.kind !== 'left').length, found.filter((f) => !['KAN-21', 'KAN-11', 'KAN-30'].some((k) => names(f, k))).length)
writeFileSync(join(T, 'bad-queue.json'), '{')
t('DS-240 AC2 an unreadable queue stops the scan', run('scan', '--repo', R, '--default', 'main', '--project', 'KAN', '--queue', join(T, 'bad-queue.json')).status, 2)
t('DS-240 AC2 no queue file is no batch', batchOf(null).running, false)
t('DS-240 AC2 held: a key the batch now holds exits 1', [run('held', '--queue', Q, 'KAN-12', 'KAN-14').status, run('held', '--queue', Q, 'KAN-12', 'KAN-21').stdout.trim()], [0, 'left alone: KAN-21 is running in batch groom-7'])

// DS-306: a named batch beside the standing queue holds its tickets too; an archived one does not.
const Q2 = join(T, 'two', 'queue.json')
mkdirSync(join(T, 'two', 'batches', 'X-1'), { recursive: true })
mkdirSync(join(T, 'two', 'batches', '.done', 'X-0'), { recursive: true })
writeFileSync(Q2, JSON.stringify({ batch: 'groom-7', tickets: { 'KAN-21': { state: 'running' } } }))
writeFileSync(join(T, 'two', 'batches', 'X-1', 'queue.json'), JSON.stringify({ batch: 'X-1', tickets: { 'KAN-13': { state: 'running' }, 'KAN-12': { state: 'done' } } }))
writeFileSync(join(T, 'two', 'batches', '.done', 'X-0', 'queue.json'), JSON.stringify({ batch: 'X-0', tickets: { 'KAN-12': { state: 'parked' } } }))
t('DS-306 AC4 held: a key the named batch holds exits 1, naming that batch', [run('held', '--queue', Q2, 'KAN-13').status, run('held', '--queue', Q2, 'KAN-13', 'KAN-21').stdout.trim()], [1, 'left alone: KAN-13 is running in batch X-1\nleft alone: KAN-21 is running in batch groom-7'])
t('DS-306 AC4 a ticket a named batch finished, or an archived batch holds, is not held', run('held', '--queue', Q2, 'KAN-12').status, 0)
const rq2 = run('scan', '--repo', R, '--default', 'main', '--project', 'KAN', '--priority', P, '--fields', S, '--size', S, '--done', 'Done', '--in-progress', 'In Progress', '--queue', Q2, '--json')
const inQ2 = rq2.status === 0 ? JSON.parse(rq2.stdout) : []
t('DS-306 AC4 the scan leaves the named batch\'s ticket alone, naming its batch', inQ2.filter((f) => f.check === 'blocker' && f.ticket === 'KAN-13').map((f) => [f.kind, f.propose.length, /KAN-13 is running in batch X-1/.test(f.left)]), [['left', 0, true]])
t('DS-306 AC4 and still the standing batch\'s', on('KAN-21').map((f) => f.left).join(' | '), inQ2.filter((f) => names(f, 'KAN-21')).map((f) => f.left).join(' | '))
t('DS-306 batchesOf keeps the standing batch\'s name for a hand-off, and every batch\'s keys', (() => { const b = batchesOf([{ batch: 's', tickets: {} }, { batch: 'X-1', tickets: { 'A-1': { state: 'done' } } }]); return [b.name, b.running, [...b.keys]] })(), ['s', false, ['A-1']])

// AC1: every proposal in one list, awaiting approval; the weekly run only reports
writeFileSync(join(T, 'scan-q.json'), JSON.stringify(inQ))
const ap = run('approval', '--scan', join(T, 'scan-q.json'))
const apText = ap.stdout
t('DS-240 AC1 approval prints every settled fix as one numbered list', (apText.match(/^\[\d+\] JIRA /gm) ?? []).length, inQ.filter((f) => f.kind === 'fix' && !f.verify && f.propose.length).length)
t('DS-240 AC1 every block is awaiting approval', (apText.match(/^\[\d+\] JIRA \w+ — awaiting approval$/gm) ?? []).length, (apText.match(/^\[\d+\] JIRA /gm) ?? []).length)
t('DS-240 AC1 and it ends by asking for the numbers to write', /Nothing is written until you approve/.test(apText), true)
t('DS-240 AC1 a block names the §3 row it needs', /check {2}: status\nneeds {2}: jira-transition/.test(apText), true)
t('DS-240 AC1 a question is asked, its recommendation first', /^QUESTION — loose\ntarget : KAN-140[\s\S]*?\n {2}1\. .* \(Recommended\)$/m.test(apText), true)
t('DS-240 AC1 a candidate no verifier settled is listed, not dropped', /not settled by a verifier: landed KAN-10/.test(apText), true)
t('DS-240 AC1 a left finding is listed as left alone', /left alone: duplicate KAN-21: KAN-21 is running in batch groom-7/.test(apText), true)
const rep = run('approval', '--scan', join(T, 'scan-q.json'), '--report').stdout
t('DS-240 AC1 --report: no block awaits approval, nothing is asked', [/awaiting approval|answer with the numbers/.test(rep), /^REPORT ONLY: .*Nothing is asked and nothing is written\.$/m.test(rep), /— report only$/m.test(rep)], [false, true, true])
writeFileSync(join(T, 'settled.json'), JSON.stringify([{ ...of('landed', 'KAN-10')[0], verify: undefined }]))
const apAdd = JSON.parse(run('approval', '--scan', join(T, 'scan-q.json'), '--add', join(T, 'settled.json'), '--json').stdout)
t('DS-240 AC1 a verified close joins the list, as jira-close', apAdd.items.filter((i) => i.ticket === 'KAN-10').map((i) => i.needs), ['jira-close'])
t('DS-240 AC1 and is no longer unsettled', apAdd.unsettled.some((f) => f.ticket === 'KAN-10' && f.check === 'landed'), false)
t('DS-240 AC1 approval wrote nothing to Jira', jiraWrites(), 0)
t('DS-240 approved numbers: all, ranges, none, and a bad answer', [approvedNumbers('all', 3), approvedNumbers('1,3-4', 5), approvedNumbers('none', 2), approvedNumbers('2,9', 3), approvedNumbers('yes', 3)], [[1, 2, 3], [1, 3, 4], [], null, null])

// AC1: after approval each write is read back; a description is checked in the rendered HTML
const items = [
  { n: 1, check: 'field', ticket: 'KAN-12', evidence: [], propose: [`desk-jira edit KAN-12 ${P}=P2`] },
  { n: 2, check: 'link', ticket: 'KAN-31', evidence: [], propose: ['desk-jira link KAN-31 blocked-by KAN-30'] },
  { n: 3, check: 'stale', ticket: 'KAN-12', evidence: [], edit: { from: 'old', to: 'the new line' }, propose: ['desk-jira edit KAN-12 description=@<KAN-12 description with the edit>'] },
  { n: 4, check: 'field', ticket: 'KAN-15', evidence: [], propose: [`desk-jira edit KAN-15 ${P}=P1`] },
]
writeFileSync(join(T, 'approved.json'), JSON.stringify({ items }))
const back = (nums) => run('readback', join(T, 'approved.json'), '--approved', nums)
t('DS-240 AC1 read-back: a write that did not go fails', [back('1').status, /^FAIL \[1\] .*customfield_10207 is P3$/m.test(back('1').stdout)], [1, true])
sh(R, 'desk-jira', 'edit', 'KAN-12', `${P}=P2`); sh(R, 'desk-jira', 'link', 'KAN-31', 'blocked-by', 'KAN-30')
t('DS-240 AC1 read-back: a field and a link that landed pass', [back('1,2').status, back('1,2').stdout.split('\n').filter((l) => l.startsWith('ok')).length], [0, 2])
t('DS-240 AC1 read-back: only approved items are read', /\[4\]/.test(back('1,2').stdout), false)
sh(R, 'desk-jira', 'edit', 'KAN-12', 'description=the new line, a -struck- word')
t('DS-240 AC1 read-back: a <del in the rendered description fails', [back('3').status, /1 <del in the rendered HTML/.test(back('3').stdout)], [1, true])
sh(R, 'desk-jira', 'edit', 'KAN-12', 'description=the new line, a \\-struck\\- word')
t('DS-240 AC1 read-back: escaped, it passes', [back('3').status, back('3').stdout.trim()], [0, 'ok   [3] desk-jira edit KAN-12 description=@<KAN-12 description with the edit>: no <del in the rendered HTML'])
sh(R, 'desk-jira', 'edit', 'KAN-12', 'description=something else')
t('DS-240 AC1 read-back: an edit whose text is missing fails', /missing: the new line/.test(back('3').stdout), true)
const issue = (fields) => ({ key: 'K-1', fields: { summary: 's', status: { name: 'Done', statusCategory: { key: 'done' } }, ...fields } })
t('DS-240 read-back: a transition', [readbackOf('desk-jira transition K-1 Done', issue({})).ok, readbackOf("desk-jira transition K-1 'In Progress'", issue({})).ok], [true, false])
t('DS-240 read-back: an issue that could not be read fails', readbackOf('desk-jira transition K-1 Done', null).ok, false)
t('DS-240 command words: a quote inside a word, and an escaped quote', [commandWords("desk-jira edit K-1 summary='admit: count the rows'"), commandWords("x 'it'\\''s'")],
  [['desk-jira', 'edit', 'K-1', 'summary=admit: count the rows'], ['x', "it's"]])
t('DS-240 read-back: a quoted title with spaces that landed passes', [readbackOf("desk-jira edit K-1 summary='admit: count the rows'", issue({ summary: 'admit: count the rows' })).ok,
  readbackOf("desk-jira edit K-1 summary='admit: count the rows'", issue({ summary: 'admit: count' })).ok], [true, false])
t('DS-240 read-back: a <value> the user chose passes when set, fails when blank', [readbackOf(`desk-jira edit K-1 ${P}=<value>`, issue({ [P]: { value: 'P2' } })).ok,
  readbackOf(`desk-jira edit K-1 ${P}=<value>`, issue({})).ok], [true, false])
t('DS-240 read-back: a link or unlink rests on desk-jira\'s own read-back', [readbackOf('desk-jira link K-1 blocked-by K-2', null), readbackOf('desk-jira unlink K-1 K-2 Blocks', null)].map((r) => r.ok), [true, true])

// AC3: a priority epic's open work, less the queue, in Blocks order, with the files it shares
const tk = (key, { links = [], text = '', category = 'new' } = {}) => ({ key, summary: `${key} work`, text, category, links: links.map((k) => ({ type: 'Blocks', verb: 'is blocked by', key: k, category: 'new' })) })
const world = { A: tk('A', { links: ['B'], text: 'In `lib/x.mjs:3`.' }), B: tk('B', { links: ['C'] }), C: tk('C', { text: 'Edits `lib/x.mjs`.' }), D: tk('D', { category: 'done' }), F: tk('F'), G: tk('G', { links: ['H'] }), H: tk('H', { links: ['G'] }) }
const hand = (epics, kids, queue) => priorityHandoff({ epics, childrenOf: (e) => kids[e].map((k) => world[k]), get: (k) => world[k] ?? null, batch: batchOf(queue), filesOf: filesNamed })
const h1 = hand(['E'], { E: ['A', 'D', 'F'] }, { batch: 'b-3', tickets: { F: { state: 'triaged' } } })
t('DS-240 AC3 every open child and, transitively, every open blocker, in Blocks order', h1.list.map((x) => [x.key, x.why, x.after]), [['C', 'blocks B', []], ['B', 'blocks A', ['C']], ['A', 'child of E', ['B']]])
t('DS-240 AC3 a done child is left out, one in the queue is named apart', [h1.list.some((x) => x.key === 'D'), h1.inBatch], [false, ['F']])
t('DS-240 AC3 the files they share', h1.shared, [{ file: 'lib/x.mjs', keys: ['C', 'A'] }])
t('DS-240 AC3 the message goes to the batch to admit, never admitted here', /^Priority work from desk-groom \(E\), for batch b-3 to triage and admit\. The groom has not run queue\.mjs admit\./.test(handoffText(h1)), true)
// A fake orchestrator: reads the message as it arrives and admits what it lists, in its order
const orchestrator = (text) => {
  const to = /for batch (\S+?)[,\s]/.exec(text)?.[1] ?? null
  const admitted = [...text.matchAll(/^\d+\. (\S+) .*?(?:; after ([^)]+))?\)$/gm)].map((m) => ({ key: m[1], after: m[2] ? m[2].split(', ') : [] }))
  return { to, admitted: admitted.map((a) => a.key), blockersFirst: admitted.every((a, i) => a.after.every((b) => admitted.findIndex((x) => x.key === b) < i)) }
}
t('DS-240 AC3 a fake orchestrator receives the hand-off: its batch, every key, blockers first', orchestrator(handoffText(h1)), { to: 'b-3', admitted: ['C', 'B', 'A'], blockersFirst: true })
const hs = hand(['E'], { E: ['A'] }, { batch: 'b-4', supervised: true, tickets: { F: { state: 'running' } } })
t('DS-240 AC3 a supervised batch: the message says no session will receive it', /for batch b-4, which the supervisor runs: no orchestrator session to send it to, so the user admits it\./.test(handoffText(hs)), true)
const h2 = hand(['E', 'E2'], { E: ['G'], E2: ['H', 'A'] }, null)
t('DS-240 AC3 two epics, a Blocks loop named', [h2.list.map((x) => x.key), h2.loop], [['C', 'B', 'A', 'G', 'H'], ['G', 'H']])
t('DS-240 AC3 with no batch running it is offered as the next batch', [h2.batch, /as the next batch: no batch is running/.test(handoffText(h2))], [null, true])
t('DS-240 AC3 a blocker that cannot be read is named', priorityHandoff({ epics: ['E'], childrenOf: () => [tk('Y', { links: ['Z'] })], get: () => null, batch: batchOf(null) }).unread, ['Z'])
writeFileSync(Q, JSON.stringify({ batch: 'groom-7', tickets: { 'KAN-171': { state: 'running' } } }))
const pr170 = run('priority', 'KAN-170', '--queue', Q, '--json')
const pj = pr170.status === 0 ? JSON.parse(pr170.stdout) : {}
t('DS-240 AC3 priority from Jira: the open child not in the queue', [pr170.status, (pj.list ?? []).map((x) => x.key), pj.inBatch, pj.batch], [0, ['KAN-172'], ['KAN-171'], { name: 'groom-7', supervised: false }])
t('DS-240 AC3 the queue is not written', spawnSync('cat', [Q], { encoding: 'utf8' }).stdout, JSON.stringify({ batch: 'groom-7', tickets: { 'KAN-171': { state: 'running' } } }))

console.log(fails ? `${fails} FAILED` : 'all groom checks passed')
process.exit(fails ? 1 : 0)
