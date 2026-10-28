#!/usr/bin/env node
// The scripted half of desk-groom: every per-ticket check that reads the same every run, so the
// groom proposes from evidence rather than prose re-derived by hand across the whole backlog. It only
// reads: Jira through desk-jira, the repo through git against origin/<default>.
//
//   node groom-scan.mjs scan --repo <root> --default <branch> --project <§4 Jira project key>
//        [--priority <§4 Priority field>] [--fields <§4 Other fields, comma-separated>]
//        [--done <§4 Done state>] [--in-progress <§4 In-progress state>] [--size <§4 Size field>]
//        [--jql <jql>] [--queue <DESK_QUEUE>] [--json]   a finding that writes to a ticket the running
//        batch holds is left alone (kind `left`, nothing proposed)
//   node groom-scan.mjs verdict <results.json> --scan <scan.json>   verifiers' per-criterion results
//        in, checked against the criteria the scan (--json) read from each ticket: close or keep open
//   node groom-scan.mjs preclose <KEY> --scan <scan.json> [--repo <owner/name>]   just before an
//        approved close is written: the key's open PRs and Jira status read again; exit 0 to close
//   node groom-scan.mjs approval --scan <scan.json> [--add <settled.json>] [--report] [--json]   every
//        proposal as one numbered list of desk-jira gate blocks; --report asks nothing (the weekly run)
//   node groom-scan.mjs held --queue <DESK_QUEUE> <KEY>...   exit 1 when a batch now holds any of them
//
// `--queue` is the standing batch's queue; each named batch's queue in `batches/<name>/` beside it is
// read too, so a ticket any of the repo's batches holds is left alone.
//   node groom-scan.mjs readback <approval.json> --approved <all | 1,3-5>   each approved write read back
//        from Jira, a description's rendered HTML checked for <del; exit 1 when any did not land
//   node groom-scan.mjs priority <EPIC>... [--queue <DESK_QUEUE>] [--state <DESK_STATE>] [--json]   the
//        epics' open children and their open blockers not in the queue, in Blocks order, with the
//        files they share: the message for the batch's orchestrator to admit, or the next batch
//
// `scan` prints one block per finding (or a JSON array with --json). A finding is
//   {check, ticket, other?, evidence: [line], propose: [desk-jira command], verify?: brief}
// where `check` is landed, duplicate, link, stale, field, title or blocker per ticket, and coverage,
// children, loose, priority or status per epic (groomEpics). A finding with `verify` is a candidate
// only: a read-only verifier settles it before anything is proposed (SKILL.md). Every finding also
// has `kind`: `fix` (one correct fix, proposed), `question` (no single correct fix: `question`,
// `options` and `recommend`, and nothing proposed; a loose ticket, a blocker rescope) or `report`
// (a gap to report, nothing to write).

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { keyMatches, prsForKey } from '../../desk-cleanup/bin/cleanup-scan.mjs'

// desk-design.mjs's `sections`, the one reading of a ticket's headings. It sits in desk/bin, installed
// at ~/.claude/desk/bin by install.sh; DESK_ENV_MJS or DESK_HOME point elsewhere, and a source
// checkout of desk-skills finds its own copy.
const deskBin = [
  process.env.DESK_ENV_MJS && dirname(process.env.DESK_ENV_MJS),
  process.env.DESK_HOME && join(process.env.DESK_HOME, 'bin'),
  join(homedir(), '.claude', 'desk', 'bin'),
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'desk', 'bin'),
].filter(Boolean).find((d) => existsSync(join(d, 'desk-design.mjs')))
if (!deskBin) { console.error('groom-scan: desk-design.mjs not found in desk/bin. Run install.sh from desk-skills.'); process.exit(2) }
const { sections } = await import(pathToFileURL(join(deskBin, 'desk-design.mjs')).href)

// ---- pure parts (exported for tests/test_groom.mjs) ------------------------------------------

const KEY = /\b[A-Z][A-Z0-9]*-\d+\b/g
const STOP = new Set('a an and the of to for in on at by with from into onto is are be it its this that when then each every one all any no not or as so per via than only'.split(' '))
const isDone = (category) => category === 'done'
const isEpic = (i) => /^epic$/i.test(i.type) || i.level === 1
const quote = (s) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > 140 ? `${t.slice(0, 137)}...` : t }
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`)

// Jira wiki text as prose: escapes dropped, {{monospace}} kept as `code` so spans read one way.
export const plain = (wiki) => String(wiki ?? '').replace(/\\([-_*+^~?#{}[\]|!])/g, '$1').replace(/\{\{(.*?)\}\}/g, '`$1`')

// One open ticket from `desk-jira get --json`, reduced to what the checks read.
export function ticketOf(issue, fieldIds = []) {
  const f = issue.fields ?? {}
  // As desk-jira's JQ_VAL reads a value: a list joined, an option, user or other object by its name.
  // Only null, '' and [] are blank.
  const val = (v) => (v == null || v === '' ? null
    : Array.isArray(v) ? (v.length ? v.map(val).join(', ') : null)
      : typeof v === 'object' ? v.value ?? v.name ?? v.displayName ?? v.accountId ?? JSON.stringify(v) : v)
  return {
    key: issue.key,
    type: f.issuetype?.name ?? '',
    level: f.issuetype?.hierarchyLevel ?? 0,
    summary: f.summary ?? '',
    text: plain(f.description),
    created: f.created ?? '',
    status: f.status?.name ?? '',
    category: f.status?.statusCategory?.key ?? 'new',
    parent: f.parent?.key ?? null,
    fields: Object.fromEntries(fieldIds.map((id) => [id, val(f[id])])),
    names: issue.names ?? {},
    links: (f.issuelinks ?? []).map((l) => {
      const other = l.inwardIssue ?? l.outwardIssue
      return {
        type: l.type?.name ?? '',
        verb: l.inwardIssue ? l.type?.inward ?? '' : l.type?.outward ?? '',
        key: other?.key,
        category: other?.fields?.status?.statusCategory?.key ?? 'new',
      }
    }),
  }
}

// AC1:/DoD1: items, wherever the ticket writes them (`# AC1: …`, `AC2 (name): …`).
export function criteriaOf(text) {
  const out = []
  for (const l of String(text).split(/\r?\n/)) {
    const m = /\b((?:AC|DoD)\d+)\b(?:\s*\([^)]*\))?\s*[:.]\s*(\S.*)$/.exec(l)
    if (m && !out.some((c) => c.id === m[1])) out.push({ id: m[1], text: m[2].trim() })
  }
  return out
}

// `path:line` and `path:line-line` citations, URLs left out.
export function citationsOf(text) {
  const out = []
  for (const m of String(text).matchAll(/(?<![\w/.:-])((?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z][A-Za-z0-9]{0,5}):(\d+)(?:[-–](\d+))?(?![\w/])/g)) {
    const at = String(text).lastIndexOf(' ', m.index)
    if (/:\/\//.test(String(text).slice(at + 1, m.index + m[0].length))) continue
    out.push({ path: m[1], line: Number(m[2]), end: m[3] ? Number(m[3]) : Number(m[2]), cite: m[0], index: m.index })
  }
  return out
}

// Code spans that name something: a command, flag, field, file or function, not a plain word.
const NAMED = /[-_.()/=]|[a-z][A-Z]/
export function spansOf(line) {
  return [...String(line).matchAll(/`([^`\n]{3,80})`/g)].map((m) => ({ span: m[1].trim(), index: m.index })).filter((s) => NAMED.test(s.span) && /[A-Za-z]/.test(s.span))
}
const ADDS = /\b(?:adds?|added|adding|new|introduces?|creates?|exports?|a (?:new )?(?:command|flag|row|field|setting|option))\b[^`]{0,30}$/i
const CHANGES = /\b(?:change[sd]?|edit(?:s|ed)?|rework(?:s|ed)?|replace[sd]?|fix(?:es|ed)?|move[sd]?|rename[sd]?|split(?:s)?|update[sd]?|extend(?:s|ed)?|rewrite[s]?)\b/i
const fnName = (span) => /^([A-Za-z_$][\w$.]*)\(/.exec(span)?.[1] ?? null

// A code span that states something about main: a function, a long flag or a repo file. Commands with
// arguments and placeholders say nothing a grep can check.
const PATH = /^(?:\w[\w.-]*\/)+[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,5}$|^\w[\w.-]*\.(?:mjs|cjs|js|jsx|ts|tsx|py|sh|md|json|ya?ml|toml)$/
export function premiseName(span) {
  if (/[<>\s]/.test(span.replace(/\(.*\)$/, ''))) return null
  const fn = fnName(span)
  if (fn) return { name: fn, kind: 'function' }
  if (/^--[a-z][\w-]*$/.test(span)) return { name: span, kind: 'flag' }
  if (PATH.test(span)) return { name: span, kind: 'file' }
  return null
}
// Sections that say what the work will do, not what main holds now.
const FUTURE = /^(?:acceptance|criteria|definition of done|outcome|out of scope|verification|design)\b/i

// What a ticket adds and uses: {adds: Map span→line, uses: Map span→line, changes: Map fn→line}.
export function namesOf(t) {
  const adds = new Map(), uses = new Map(), changes = new Map()
  for (const line of t.text.split(/\r?\n/)) for (const { span, index } of spansOf(line)) {
    if (ADDS.test(line.slice(Math.max(0, index - 60), index))) { if (!adds.has(span)) adds.set(span, line) } else if (!uses.has(span)) uses.set(span, line)
    const fn = fnName(span)
    if (fn && CHANGES.test(line) && !changes.has(fn)) changes.set(fn, line)
  }
  return { adds, uses, changes }
}

const words = (s) => new Set(String(s).toLowerCase().replace(/^[^:]{1,30}:\s+/, '').match(/[a-z0-9][a-z0-9'-]*/g)?.filter((w) => w.length > 2 && !STOP.has(w)) ?? [])
export function similarity(a, b) {
  const x = words(a), y = words(b)
  const shared = [...x].filter((w) => y.has(w))
  return { score: shared.length / (new Set([...x, ...y]).size || 1), shared }
}

// The newer of two tickets: created later, else the higher number.
export const newer = (a, b) => (a.created && b.created && a.created !== b.created ? (a.created > b.created ? a : b)
  : Number(a.key.split('-').pop()) > Number(b.key.split('-').pop()) ? a : b)

// A title's area prefix, `desk-groom:` in `desk-groom: check …`.
export const prefixOf = (summary) => /^([A-Za-z0-9][\w ./+-]{0,30}?):\s/.exec(String(summary))?.[1] ?? null

// The prefix most of an epic's other children share, when at least two and half of them do.
export function sharedPrefix(siblings, self) {
  const others = siblings.filter((s) => s.key !== self)
  const count = new Map()
  for (const s of others) { const p = prefixOf(s.summary); if (p) count.set(p, (count.get(p) ?? 0) + 1) }
  const [best, n] = [...count].sort((a, b) => b[1] - a[1])[0] ?? [null, 0]
  return best && n >= 2 && n * 2 >= others.length ? best : null
}

const DEPENDS = /\b(?:after|needs?|requires?|depends? on|blocked by|build(?:s)? on|builds on|waits? for|once|until|on top of|follows?|reads? .{0,30} from)\b/i
const FEEDS = /\b(?:before|blocks|unblocks|feeds|is needed by)\b/i
const linked = (t, other) => t.links.some((l) => l.key === other)

// Blocks links that form a loop through open tickets: [[A, B, …, A]], each loop once.
export function blockerCycles(tickets) {
  const open = new Map(tickets.map((t) => [t.key, t]))
  const by = (k) => (open.get(k)?.links ?? []).filter((l) => l.type === 'Blocks' && /blocked by/i.test(l.verb) && open.has(l.key)).map((l) => l.key)
  const seen = new Set(), out = []
  for (const start of open.keys()) {
    const walk = (k, path) => {
      for (const n of by(k)) {
        if (n === start) { const id = [...path].sort().join(' '); if (!seen.has(id)) { seen.add(id); out.push([...path, start]) } }
        else if (!path.includes(n) && n > start) walk(n, [...path, n])
      }
    }
    walk(start, [start])
  }
  return out
}

// Over this many open blockers, a ticket waits on a set that keeps growing ("every feature").
export const BLOCKER_FANIN = 10

// Every check over the open tickets. `siblings` maps a parent to [{key, summary}] (its children,
// done ones included); `repo` answers from origin/<default> (repoAt below, or a test's own).
export function groom({ tickets, siblings = {}, repo, fields = [], priority = null, done = 'Done' }) {
  const out = []
  const work = tickets.filter((t) => !isEpic(t))
  const open = new Map(tickets.map((t) => [t.key, t]))
  const names = new Map(work.map((t) => [t.key, namesOf(t)]))
  // Every name an open ticket says it adds: a premise naming one is pending work, not stale.
  const pending = new Set([...names.values()].flatMap((n) => [...n.adds.keys()].map((s) => premiseName(s)?.name ?? s)))
  const add = (f) => out.push(f)

  for (const t of work) {
    // ---- landed: work already on main, under this key or another (AC1)
    const own = repo.commitsNaming(t.key)
    const cited = [...new Set(citationsOf(t.text).map((c) => repo.resolve(c.path)).filter(Boolean))]
    // A commit under another key counts when it touches a file the ticket cites and its subject
    // shares two words with the title: a busy file alone is every ticket's candidate.
    const others = cited.length ? repo.commitsTouching(cited, t.created)
      .filter((c) => !keyMatches(c.subject, t.key) && (c.subject.match(KEY) ?? []).length && similarity(c.subject, t.summary).shared.length >= 2) : []
    const present = [...names.get(t.key).adds.keys()].filter((s) => repo.has(s))
    if (own.length || others.length || present.length) {
      add({
        check: 'landed', ticket: t.key,
        evidence: [
          ...own.map((c) => `${c.sha.slice(0, 8)} on main names ${t.key}: ${quote(c.subject)}`),
          ...others.map((c) => `${c.sha.slice(0, 8)} on main touches ${c.files.join(', ')} since ${t.key} was filed: ${quote(c.subject)}`),
          ...present.map((s) => `\`${s}\`, which ${t.key} says it adds, is already on main`),
        ],
        criteria: criteriaOf(t.text),
        // The status the verdict rests on: `preclose` refuses the close if Jira has moved since.
        status: t.status,
        propose: [`desk-jira transition ${t.key} ${shq(done)}`],
        verify: 'landed',
      })
    }

    // ---- stale citations: a file or line main no longer matches (AC4)
    for (const c of citationsOf(t.text)) {
      const path = repo.resolve(c.path)
      if (!path) {
        const moved = repo.renamedTo(c.path)
        // A file of the same name is a guess at the move, so a verifier checks it too.
        add({ check: 'stale', ticket: t.key, evidence: [`cites ${c.cite}, but ${c.path} is not on main${moved ? `; the one file named ${moved.split('/').pop()} is ${moved}` : ''}`],
          edit: moved ? { from: c.cite, to: c.cite.replace(c.path, moved) } : null,
          propose: [`desk-jira edit ${t.key} description=@<${t.key} description with the edit>`], verify: 'stale' })
        continue
      }
      const lines = repo.lines(path)
      // The names written beside the citation, on its line, are what it claims sits at that line.
      const start = t.text.lastIndexOf('\n', c.index) + 1
      const named = spansOf(t.text.slice(start).split('\n')[0])
        .filter((s) => start + s.index + s.span.length + 2 >= c.index - 40 && start + s.index <= c.index + c.cite.length + 40)
        .map((s) => fnName(s.span) ?? s.span).filter((s) => !/:\d+/.test(s))
      if (c.end > lines.length) {
        add({ check: 'stale', ticket: t.key, evidence: [`cites ${c.cite}, but ${path} has ${lines.length} lines on main`], edit: null,
          propose: [`desk-jira edit ${t.key} description=@<${t.key} description with the edit>`], verify: 'stale' })
        continue
      }
      for (const name of named) {
        const window = lines.slice(Math.max(0, c.line - 4), c.end + 3).join('\n')
        if (window.includes(name)) continue
        // The new line only where the name is a whole word on exactly one line; else a verifier picks.
        const word = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`)
        const hits = lines.flatMap((l, i) => (word.test(l) ? [i + 1] : []))
        const at = hits.length === 1 ? hits[0] : null
        add({ check: 'stale', ticket: t.key,
          evidence: [`cites \`${name}\` at ${c.cite}, but line ${c.line} of ${path} on main is "${quote(lines[c.line - 1] ?? '')}"${at ? `; \`${name}\` is at line ${at}`
            : hits.length ? `; \`${name}\` is on lines ${hits.slice(0, 10).join(', ')}` : `, and \`${name}\` is not in it`}`],
          edit: at ? { from: c.cite, to: `${c.path}:${at}` } : null,
          propose: [`desk-jira edit ${t.key} description=@<${t.key} description with the edit>`], verify: at ? undefined : 'stale' })
        break
      }
    }

    // ---- stale premises: a line with no citation that names a function, flag or file main does not
    // have (AC4). Criteria and other sections about the work to come are left out, as is any name an
    // open ticket adds. A premise is a verifier's call: the name may live outside this repo.
    const parts = sections(t.text)
    for (const s of parts.filter((x) => !FUTURE.test(x.name))) for (const l of s.lines) {
      if (citationsOf(l.text).length || /\b(?:AC|DoD)\d+\b/.test(l.text)) continue
      const gone = [...new Set(spansOf(l.text).map((x) => premiseName(x.span)).filter(Boolean)
        .filter((p) => !pending.has(p.name) && !(p.kind === 'file' ? repo.exists(p.name) : repo.has(p.name)))
        .map((p) => `\`${p.name}\``))]
      if (!gone.length) continue
      add({ check: 'stale', ticket: t.key,
        evidence: [`${s.name || 'description'}: "${quote(l.text)}" names ${gone.join(', ')}, which main does not have`],
        edit: null, propose: [`desk-jira edit ${t.key} description=@<${t.key} description with the edit>`], verify: 'stale' })
    }

    // ---- blank §4 Priority and §4 Other fields, and the title's area prefix (AC5)
    const sibs = t.parent ? siblings[t.parent] ?? [] : []
    const parent = t.parent ? open.get(t.parent) : null
    for (const id of fields) {
      if (t.fields[id] !== null && t.fields[id] !== '') continue
      // A priority follows the epic it serves; a size or any other field is the ticket's own.
      const from = id !== priority || !t.parent ? null
        : parent?.fields?.[id] ? { value: parent.fields[id], why: `${t.parent}'s value` }
          : modal(work.filter((x) => x.parent === t.parent && x.key !== t.key), id)
      add({ check: 'field', ticket: t.key, field: id,
        evidence: [`${t.names[id] ?? id} is blank`, from ? `proposed from ${from.why}` : 'nothing to take it from: judge it (a size from desk-jira\'s scale)'],
        value: from?.value ?? null,
        propose: [`desk-jira edit ${t.key} ${id}=${from ? shq(from.value) : '<value>'}`] })
    }
    const want = sibs.length ? sharedPrefix(sibs, t.key) : null
    const has = prefixOf(t.summary)
    if (want && has !== want) {
      // A different prefix is replaced, not stacked: `admit: x`, never `admit: import: x`.
      const title = `${want}: ${has ? t.summary.slice(has.length + 1).trimStart() : t.summary}`
      add({ check: 'title', ticket: t.key, evidence: [`${sibs.filter((s) => s.key !== t.key && prefixOf(s.summary) === want).length} of ${t.parent}'s other children start "${want}:", and "${quote(t.summary)}" ${has ? `starts "${has}:"` : 'has no prefix'}`],
        propose: [`desk-jira edit ${t.key} summary=${shq(title)}`] })
    }

    // ---- dead blockers: Done ones, and a set that can never all be Done (AC6)
    const blockers = t.links.filter((l) => l.type === 'Blocks' && /blocked by/i.test(l.verb))
    for (const b of blockers.filter((l) => isDone(l.category))) {
      add({ check: 'blocker', ticket: t.key, other: b.key, evidence: [`blocked by ${b.key}, which is Done`], propose: [`desk-jira unlink ${t.key} ${b.key} Blocks`] })
    }
    // Which blockers the work truly needs is the user's call (DS-239 AC5): asked, with the ones the
    // ticket's own text names recommended as the ones to keep.
    const live = blockers.filter((l) => !isDone(l.category))
    if (live.length > BLOCKER_FANIN) {
      const keys = live.map((l) => l.key)
      const named = keys.filter((k) => new RegExp(`\\b${k}\\b`).test(t.text))
      const keep = named.length && named.length < keys.length
        ? `keep ${named.join(', ')}, which ${t.key} names, and unlink the other ${keys.length - named.length}: ${keys.filter((k) => !named.includes(k)).join(', ')}` : null
      const cut = `unlink all ${keys.length}, and link again any one ${t.key} truly waits on`
      const all = `keep all ${keys.length}: ${t.key} truly waits on every one`
      add({ check: 'blocker', kind: 'question', ticket: t.key, rescope: true,
        evidence: [`held behind ${keys.length} open blockers (${keys.join(', ')}), a set that keeps growing and never all reaches Done`,
          named.length ? `${t.key}'s text names ${named.join(', ')}` : `${t.key}'s text names none of them`],
        question: `Which of its ${keys.length} open blockers does ${t.key} truly need?`,
        options: [...(keep ? [keep] : []), cut, all], recommend: keep ?? (named.length ? all : cut), propose: [] })
    }

    // ---- missing links: named in prose, or a name another open ticket adds or changes (AC3)
    for (const s of parts.filter((x) => !/^children\b/i.test(x.name))) for (const l of s.lines) {
      for (const k of new Set(l.text.match(KEY) ?? [])) {
        if (k === t.key || k === t.parent || !open.has(k) || isEpic(open.get(k)) || linked(t, k)) continue
        if (out.some((f) => f.check === 'link' && f.ticket === t.key && f.other === k)) continue
        // Only wording that orders the two is evidence; a bare mention proposes nothing.
        const where = `${s.name || 'description'}: ${l.text}`
        const verb = DEPENDS.test(where) ? 'blocked-by' : FEEDS.test(l.text) ? 'blocks' : null
        if (!verb) continue
        add({ check: 'link', ticket: t.key, other: k, evidence: [`${t.key} names ${k} in ${quote(where)}`], propose: [`desk-jira link ${t.key} ${verb} ${k}`] })
      }
    }
  }

  // ---- missing links from names, between pairs of open tickets (AC3)
  for (const a of work) for (const b of work) {
    if (a.key === b.key || linked(a, b.key)) continue
    const na = names.get(a.key), nb = names.get(b.key)
    if (out.some((f) => f.check === 'link' && [f.ticket, f.other].includes(a.key) && [f.ticket, f.other].includes(b.key))) continue
    const used = [...na.uses.keys()].find((s) => nb.adds.has(s) && !na.adds.has(s) && !repo.has(s))
    if (used) {
      add({ check: 'link', ticket: a.key, other: b.key,
        evidence: [`${b.key} adds \`${used}\`: ${quote(nb.adds.get(used))}`, `${a.key} uses it: ${quote(na.uses.get(used))}`],
        propose: [`desk-jira link ${a.key} blocked-by ${b.key}`] })
      continue
    }
    const fn = a.key < b.key && [...na.changes.keys()].find((n) => nb.changes.has(n))
    if (fn) {
      add({ check: 'link', ticket: a.key, other: b.key,
        evidence: [`both change \`${fn}\``, `${a.key}: ${quote(na.changes.get(fn))}`, `${b.key}: ${quote(nb.changes.get(fn))}`],
        propose: [`desk-jira link ${a.key} relates-to ${b.key}`] })
    }
  }

  // ---- duplicates: two open tickets with nearly the same title (AC2)
  for (let i = 0; i < work.length; i++) for (let j = i + 1; j < work.length; j++) {
    const a = work[i], b = work[j]
    if (a.links.some((l) => l.key === b.key && l.type === 'Duplicate') || a.parent === b.key || b.parent === a.key) continue
    const sim = similarity(a.summary, b.summary)
    if (sim.score < 0.5 || sim.shared.length < 3) continue
    const n = newer(a, b), o = n === a ? b : a
    add({ check: 'duplicate', ticket: n.key, other: o.key,
      evidence: [`"${quote(n.summary)}" and "${quote(o.summary)}" share ${sim.shared.join(', ')} (${Math.round(sim.score * 100)}%)`, `${n.key} is the newer`],
      propose: [`desk-jira link ${n.key} duplicates ${o.key}`, `desk-jira transition ${n.key} ${shq(done)}`], verify: 'duplicate' })
  }

  // ---- blocker loops can never all be Done (AC6). Which link to cut is the user's call (DS-239 AC5):
  // one option per link, the first whose blocked ticket's text does not name its blocker recommended.
  for (const loop of blockerCycles(work)) {
    const pairs = loop.slice(0, -1).map((k, i) => ({ k, by: loop[i + 1], names: new RegExp(`\\b${loop[i + 1]}\\b`).test(open.get(k).text) }))
    const opt = (p) => `${p.k} does not need ${p.by}: desk-jira unlink ${p.k} ${p.by} Blocks`
    add({ check: 'blocker', kind: 'question', ticket: loop[0], rescope: true,
      evidence: [`Blocks links loop: ${loop.join(' blocked by ')}`,
        ...pairs.map((p) => `${p.k} ${p.names ? 'names' : 'does not name'} ${p.by} in its text`)],
      question: `${loop.slice(0, -1).join(', ')} wait on each other in a loop: which link goes?`,
      options: pairs.map(opt), recommend: opt(pairs.find((p) => !p.names) ?? pairs[0]), propose: [] })
  }
  return out
}

// ---- epic checks: coverage, Children lists, loose tickets, the priority path, status ----------

// An epic no outcome lives in: never recommended as a home for a loose ticket.
const BUCKET = /\b(?:misc(?:ellaneous)?|backlog|bucket|catch[- ]?all|other|general|loose|unsorted|uncategori[sz]ed|odds and ends|chores?|tech(?:nical)? debt)\b/i
const BAG_STOP = new Set('given then when after before today ben user users ticket tickets epic epics run runs groom'.split(' '))
// Words for matching a ticket to an epic or a criterion: the title's prefix kept, plurals and 's folded.
const bag = (s) => new Set((String(s).toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [])
  .map((w) => w.replace(/'s$/, '').replace(/(?<=[a-z]{3})s$/, '')).filter((w) => w.length > 2 && !STOP.has(w) && !BAG_STOP.has(w)))
const sectionText = (t, re) => (sections(t.text).find((x) => re.test(x.name))?.lines ?? []).map((l) => l.text).join('\n')
const about = (t) => `${t.summary}\n${sectionText(t, /^outcome\b/i)}`
// A child closed in a status other than the Done state (won't do, cancelled): it covers nothing.
const dropped = (c, done) => isDone(c.category) && c.status && c.status.toLowerCase() !== String(done).toLowerCase()

// A priority's place, highest first: P0 above P1, Highest above Lowest. Null for a value with no order.
const NAMED_PRIORITY = ['highest', 'high', 'medium', 'low', 'lowest']
export function priorityRank(v) {
  if (v == null || v === '') return null
  const p = /^P(\d+)$/i.exec(String(v).trim())
  if (p) return Number(p[1])
  const i = NAMED_PRIORITY.indexOf(String(v).trim().toLowerCase())
  return i < 0 ? null : i
}

// An epic's Children section: a row per line that starts with a key, `# KEY (size): label`.
export function childrenSection(text) {
  const s = sections(text).find((x) => /^children\b/i.test(x.name))
  if (!s) return null
  const rows = []
  for (const l of s.lines) {
    const m = /^(\s*(?:[#*-]+\s*)?)([A-Z][A-Z0-9]*-\d+)\b\s*(?:\(([^)]*)\))?\s*[:–-]?\s*(.*)$/.exec(l.text)
    if (m) rows.push({ mark: m[1], key: m[2], size: m[3] ?? null, label: m[4].trim(), line: l.text })
  }
  return { name: s.name, rows }
}

// How well a text fits another: the shared words, and their share of the first text's words.
function fit(a, b) {
  const x = bag(a), y = bag(b)
  const shared = [...x].filter((w) => y.has(w))
  return { shared, score: shared.length / (x.size || 1) }
}

// Two candidates this close are a judgement call, not a pick.
export const TIE = 0.85

// Every epic check. `children` maps an open epic to its Jira children in rank order (ticketOf records,
// done ones included); `lookup` maps a key a Children section lists but Jira does not have under that
// epic to its record, or null when Jira has no such issue.
export function groomEpics({ tickets, children = {}, lookup = {}, priority = null, size = null, done = 'Done', inProgress = 'In Progress' }) {
  const out = []
  const open = new Map(tickets.map((t) => [t.key, t]))
  const epics = tickets.filter(isEpic)
  const work = tickets.filter((t) => !isEpic(t))

  for (const e of epics) {
    const kids = children[e.key] ?? []
    const live = kids.filter((c) => !dropped(c, done))
    const sec = childrenSection(e.text)

    // ---- coverage: a DoD item no open or done child covers (AC1). A child covers it when it names
    // the item, the item names the child, or the child's Children row names the item or its label
    // ("(ticket checks child)"). Children that only share its words go to a verifier.
    for (const d of criteriaOf(e.text).filter((c) => c.id.startsWith('DoD'))) {
      const id = new RegExp(`\\b${d.id}\\b`)
      const label = /\(([^()]+?)\s+child\)/i.exec(d.text)?.[1]?.toLowerCase()
      const covers = live.filter((c) => {
        const row = sec?.rows.find((r) => r.key === c.key)
        return id.test(c.text) || new RegExp(`\\b${c.key}\\b`).test(d.text)
          || (row && (id.test(row.line) || (label && row.label.toLowerCase().includes(label))))
      })
      if (covers.length) continue
      const near = live.map((c) => ({ c, ...fit(d.text, about(c)) })).filter((x) => x.shared.length >= 2)
        .sort((a, b) => b.shared.length - a.shared.length || (a.c.key < b.c.key ? -1 : 1))
      out.push({ check: 'coverage', kind: 'report', ticket: e.key, item: d.id,
        evidence: [`${d.id}: "${quote(d.text)}": no open or done child of ${e.key} names it, or is named by it`,
          ...near.map((x) => `${x.c.key} shares ${x.shared.join(', ')}: "${quote(x.c.summary)}"`)],
        ...(near.length ? { candidates: near.map((x) => x.c.key), verify: 'coverage' } : {}), propose: [] })
    }

    // ---- Children section against Jira's children (AC2)
    if (sec) {
      const byKey = new Map(kids.map((c) => [c.key, c]))
      const listed = new Set(sec.rows.map((r) => r.key))
      const mark = sec.rows[0]?.mark || '# '
      // A new row as the section writes them: `# KEY (size): the title less its area prefix`.
      const row = (c, sz = size && c.fields?.[size]) => `${mark}${c.key}${sz ? ` (${sz})` : ''}: ${prefixOf(c.summary) ? c.summary.slice(prefixOf(c.summary).length + 1).trim() : c.summary}`
      const evidence = [], lines = [], placed = new Set()
      const unlisted = (c) => { if (placed.has(c.key)) return; placed.add(c.key); if (dropped(c, done)) { evidence.push(`${c.key} is a child but is not listed; it was closed as ${c.status}, so it stays off the list`); return } evidence.push(`${c.key} is a child of ${e.key} in Jira but is not listed: "${quote(c.summary)}"`); lines.push(row(c)) }
      for (const r of sec.rows) {
        const c = byKey.get(r.key)
        const split = (c ?? lookup[r.key])?.links?.filter((l) => /split to/i.test(l.verb)).map((l) => l.key) ?? []
        if (split.length) {
          evidence.push(`${r.key} is listed, but was split into ${split.join(', ')}`)
          for (const k of split) if (byKey.has(k) && !listed.has(k)) unlisted(byKey.get(k))
          continue
        }
        if (!c) {
          const o = lookup[r.key]
          evidence.push(o ? `${r.key} is listed, but is not a child of ${e.key} in Jira${o.parent ? ` (its parent is ${o.parent})` : ''}` : `${r.key} is listed, but Jira has no such issue`)
          continue
        }
        if (dropped(c, done)) { evidence.push(`${r.key} is listed, but was closed as ${c.status}`); continue }
        const f = fit(r.label.replace(/^[^:]{1,30}:\s+/, ''), c.summary)
        if (r.label && f.shared.length < 2 && f.score < 0.25) {
          evidence.push(`${r.key} is listed as "${quote(r.label)}", but is now "${quote(c.summary)}"`)
          lines.push(row(c, r.size ?? undefined))
          continue
        }
        lines.push(r.line)
      }
      for (const c of kids) if (!listed.has(c.key)) unlisted(c)
      if (evidence.length) {
        out.push({ check: 'children', kind: 'fix', ticket: e.key, evidence, section: lines,
          propose: [`desk-jira edit ${e.key} description=@<${e.key} description with its ${sec.name} section as below>`] })
      }
    }

    // ---- status: started or finished children move the epic (AC7). An epic with none is left alone.
    if (kids.length && !isDone(e.category)) {
      if (kids.every((c) => isDone(c.category))) {
        out.push({ check: 'status', kind: 'fix', ticket: e.key, evidence: [`every child of ${e.key} is done: ${kids.map((c) => `${c.key} (${c.status || 'done'})`).join(', ')}`],
          propose: [`desk-jira transition ${e.key} ${shq(done)}`] })
      } else if (e.category === 'new') {
        const started = kids.filter((c) => c.category !== 'new')
        if (started.length) {
          out.push({ check: 'status', kind: 'fix', ticket: e.key, evidence: [`${e.key} is ${e.status || 'To Do'}, but ${started.map((c) => `${c.key} is ${c.status || c.category}`).join(', ')}`],
            propose: [`desk-jira transition ${e.key} ${shq(inProgress)}`] })
        }
      }
    }
  }

  // ---- loose tickets: no parent epic. Always a question, never a move (AC3), and two epics that fit
  // about equally are a judgement call with both as options (AC5).
  const homes = epics.filter((e) => !BUCKET.test(e.summary))
  for (const t of work.filter((x) => !x.parent && x.level >= 0)) {
    const fits = homes.map((e) => ({ e, ...fit(about(t), [about(e), ...(children[e.key] ?? []).map((c) => c.summary)].join('\n')) }))
      .filter((x) => x.shared.length >= 2).sort((a, b) => b.score - a.score || b.shared.length - a.shared.length || (a.e.key < b.e.key ? -1 : 1))
    const top = fits[0], next = fits[1]
    const opt = (x) => `${x.e.key} (${x.e.summary})`
    const fresh = `a new epic: "${t.summary}" (draft title: say the outcome it serves)`
    const tie = top && next && next.score >= top.score * TIE
    out.push({ check: 'loose', kind: 'question', ticket: t.key,
      evidence: [`${t.key} has no parent epic: "${quote(t.summary)}"`,
        ...fits.slice(0, 3).map((x) => `${x.e.key} shares ${x.shared.join(', ')} (${Math.round(x.score * 100)}%)`),
        ...(top ? [] : ['no open epic shares two words with it'])],
      question: tie ? `${t.key} fits ${top.e.key} and ${next.e.key} about equally: which epic does it serve?` : `Which epic does ${t.key} serve?`,
      options: top ? [opt(top), ...(tie ? [opt(next)] : []), fresh] : [fresh],
      recommend: top ? opt(top) : fresh,
      ...(top ? {} : { title: t.summary }),
      propose: [] })
  }

  // ---- the priority path: a ticket above the epic it works against (AC4). Highest ticket first, so an
  // epic rises at most once and every later ticket is already met by the raise.
  const byRank = (t) => priorityRank(t.fields[priority]) ?? Infinity
  const raised = new Map(), lowered = []
  if (priority) for (const t of [...work].sort((a, b) => byRank(a) - byRank(b))) {
    const tp = priorityRank(t.fields[priority])
    if (tp == null) continue
    const against = [...new Set([t.parent, ...t.links.filter((l) => l.type === 'Blocks' && /^blocks$/i.test(l.verb)).map((l) => l.key)].filter(Boolean))]
    for (const k of against) {
      const e = open.get(k)
      const ev = raised.get(k) ?? e?.fields?.[priority]
      const ep = e && isEpic(e) ? priorityRank(ev) : null
      if (ep == null || tp >= ep) continue
      // Raise the epic when most of its other open children sit as high as the ticket; else the
      // ticket comes down to the epic's.
      const others = (children[k] ?? []).filter((c) => c.key !== t.key && !isDone(c.category))
      const high = others.filter((c) => { const r = priorityRank(open.get(c.key)?.fields?.[priority] ?? c.fields?.[priority]); return r != null && r <= tp })
      const raise = others.length > 0 && high.length * 2 >= others.length
      const tv = t.fields[priority]
      const f = { check: 'priority', kind: 'fix', ticket: t.key, other: k, ...(raise ? { raise: k } : {}),
        evidence: [`${t.key} is ${tv}, above ${k === t.parent ? 'its parent epic' : 'the epic it blocks,'} ${k}, at ${ev}`,
          `${high.length} of ${k}'s ${others.length} other open children are at ${tv} or higher${high.length ? ` (${high.map((c) => c.key).join(', ')})` : ''}`,
          raise ? `so ${k} rises to ${tv}` : `so ${t.key} comes down to ${ev}`],
        propose: [raise ? `desk-jira edit ${k} ${priority}=${shq(tv)}` : `desk-jira edit ${t.key} ${priority}=${shq(ev)}`] }
      if (raise) raised.set(k, tv); else lowered.push({ f, tp })
      out.push(f)
    }
  }
  // A ticket lowered before a lower-ranked sibling raised the epic comes down only to where the epic
  // ends, and not at all when the raise already meets it.
  for (const { f, tp } of lowered) {
    const v = raised.get(f.other)
    if (v == null) continue
    if (priorityRank(v) <= tp) { out.splice(out.indexOf(f), 1); continue }
    f.evidence[2] = `so ${f.ticket} comes down to ${v}, where ${f.other} rises to`
    f.propose = [`desk-jira edit ${f.ticket} ${priority}=${shq(v)}`]
  }
  return out
}

// The value most of an epic's other open children hold for a field, when one does.
function modal(sibs, id) {
  const count = new Map()
  for (const s of sibs) { const v = s.fields?.[id]; if (v) count.set(v, (count.get(v) ?? 0) + 1) }
  const [value, n] = [...count].sort((a, b) => b[1] - a[1])[0] ?? [null, 0]
  return value ? { value, why: `${n} of the parent's other children` } : null
}

// "Already fixed" (desk-jira): close only when every criterion is MET with a file:line, nothing is
// left open in scope, and no PR on the key is still open. Anything else stays open, defaulting to NOT MET.
// `expected` is the criteria ids the scan read from the ticket, so one the verifier left out is NOT
// MET; null when the scan named no landed candidate for the key, which never closes.
export function closeVerdict(r, expected) {
  const criteria = r.criteria ?? []
  const notMet = criteria.filter((c) => !(c.met === true && /\S+:\d+/.test(String(c.cite ?? ''))))
  const reasons = [
    ...(expected ? [] : [`the scan named no landed candidate for ${r.ticket}`]),
    ...(criteria.length ? [] : ['no criteria were checked']),
    ...(expected ?? []).filter((id) => !criteria.some((c) => c.id === id)).map((id) => `${id} NOT MET (not checked)`),
    ...notMet.map((c) => `${c.id ?? '?'} NOT MET${c.cite ? '' : ' (no file:line)'}`),
    ...(r.open_prs ?? []).map((n) => `PR #${n} on the key is still open`),
    ...(r.scope_left ?? []).map((s) => `scope still open: ${s}`),
  ]
  return { ticket: r.ticket, close: reasons.length === 0, reasons }
}

// The same close, re-checked just before it is written: approval can come an hour after the verdict,
// and a PR opened on the key in that gap, or a status someone moved, still keeps the ticket open.
// `before` is the status the scan read; `prs` the open PRs `gh pr list` found, null with
// `prsError` when the search failed, which never reads as "no PR"; `status` likewise with `statusError`.
export function precloseCheck({ ticket, before, status = null, statusError = null, prs = null, prsError = null }) {
  const reasons = [
    ...(before ? [] : [`the scan named no landed candidate for ${ticket}`]),
    ...(prs ? prsForKey(prs, ticket).map((p) => `PR #${p.number} on the key opened after the verdict`)
      : [`the open-PR check did not run (${prsError || 'gh pr list failed'})`]),
    ...(status == null ? [`the Jira status check did not run (${statusError || 'desk-jira get failed'})`]
      : before && status.toLowerCase() !== before.toLowerCase() ? [`${ticket} is now ${status}, not ${before} as at the verdict`] : []),
  ]
  return { ticket, close: reasons.length === 0, reasons, report: reasons.length ? `kept open: ${reasons.join('; ')}` : `close: no open PR on the key, still ${status}` }
}

// ---- the running batch: what the groom leaves alone ------------------------------------------

// The autopilot queue (queue.mjs) as the groom reads it. The batch holds every ticket it has not
// finished: queued, triaged, held or parked, running, and failed (a failed one waits on a requeue).
// `keys` is every ticket in the queue, done ones included, which a priority hand-off never re-sends.
export function batchOf(q) {
  const tickets = q?.tickets ?? {}
  const held = new Map(Object.entries(tickets).filter(([, t]) => t?.state !== 'done').map(([k, t]) => [k, t?.state ?? '?']))
  return { name: q?.batch ?? null, supervised: q?.supervised === true, running: held.size > 0, held, keys: new Set(Object.keys(tickets)) }
}

// The standing batch (first) with each named batch's tickets folded into `held` and `keys`, so a
// ticket any batch holds is left alone and never handed on again. `of` names the batch holding each
// held key; `name`, `running` and `supervised` stay the standing batch's, which a hand-off goes to.
export function batchesOf(qs) {
  const [first, ...rest] = qs.map(batchOf)
  const of = new Map([...first.held.keys()].map((k) => [k, first.name]))
  for (const b of rest) {
    for (const [k, s] of b.held) { first.held.set(k, s); of.set(k, b.name) }
    for (const k of b.keys) first.keys.add(k)
  }
  return { ...first, of }
}
const batchName = (batch, k) => batch.of?.get(k) ?? batch.name ?? '?'

// Every key a finding would write to: the ticket, the other side of a link, and each key its commands
// and options name.
const keysOf = (f) => new Set([f.ticket, f.other, ...[...(f.propose ?? []), ...(f.options ?? [])].flatMap((p) => String(p).match(KEY) ?? [])].filter(Boolean))

// A finding that would write to a ticket the batch holds is left alone: no proposal, no question and
// no verifier, only the line saying why. The batch's worker or orchestrator owns that ticket now.
export function leaveBatch(findings, batch) {
  return findings.map((f) => {
    const hit = [...keysOf(f)].filter((k) => batch.held.has(k))
    if (!hit.length) return f
    const { verify, ...rest } = f
    const names = [...new Set(hit.map((k) => batchName(batch, k)))]
    const left = names.map((n) => `${hit.filter((k) => batchName(batch, k) === n).map((k) => `${k} is ${batch.held.get(k)}`).join(', ')} in batch ${n}`).join('; ')
    return { ...rest, kind: 'left', propose: [], left }
  })
}

// ---- the approval list: every proposal in one list, nothing written before the user approves -----

const NEEDS = { landed: 'jira-close', duplicate: 'jira-close', status: 'jira-transition' }
export const needsOf = (f) => NEEDS[f.check] ?? 'jira-edit'

// The scan's settled fixes plus the proposals step 3's verifiers settled (`added`, the same finding
// shape), numbered in one list. A `verify first` candidate with no settled proposal is `unsettled`:
// listed, so a verifier that never ran is visible rather than silently dropped.
export function approvalOf(findings, added = []) {
  const settled = new Set(added.map((a) => `${a.check} ${a.ticket}`))
  const fixes = [...findings.filter((f) => f.kind === 'fix' && !f.verify && f.propose?.length), ...added.filter((a) => a.propose?.length)]
  return {
    items: fixes.map((f, i) => ({ n: i + 1, ...f, kind: 'fix', needs: needsOf(f) })),
    questions: findings.filter((f) => f.kind === 'question'),
    gaps: findings.filter((f) => f.kind === 'report'),
    left: findings.filter((f) => f.kind === 'left'),
    unsettled: findings.filter((f) => f.kind !== 'left' && f.verify && !settled.has(`${f.check} ${f.ticket}`)),
  }
}

// The list as desk-jira gate blocks. A report-only run (the weekly one) says so in every block and
// asks nothing.
export function approvalText(a, { report = false } = {}) {
  const state = report ? 'report only' : 'awaiting approval'
  const out = []
  for (const f of a.items) {
    const op = f.propose.every((p) => /^desk-jira transition\b/.test(p)) ? 'TRANSITION' : 'EDIT'
    out.push(`[${f.n}] JIRA ${op} — ${state}`, `target : ${f.ticket}`, `check  : ${f.check}`, `needs  : ${f.needs}`, 'evidence:',
      ...f.evidence.map((e) => `  ${e}`), '---', ...f.propose,
      ...(f.edit ? [`  from: ${f.edit.from}`, `  to  : ${f.edit.to}`] : []), ...(f.section ?? []).map((l) => `  section: ${l}`), '')
  }
  for (const f of a.questions) {
    const opts = [f.recommend, ...(f.options ?? []).filter((o) => o !== f.recommend)].filter(Boolean)
    out.push(`QUESTION — ${f.check}`, `target : ${f.ticket}`, 'evidence:', ...f.evidence.map((e) => `  ${e}`), '---', f.question ?? '',
      ...opts.map((o, i) => `  ${i + 1}. ${o}${i === 0 ? ' (Recommended)' : ''}`), '')
  }
  for (const f of a.gaps) out.push(`gap: ${f.ticket}: ${f.evidence[0] ?? f.check}`)
  for (const f of a.unsettled) out.push(`not settled by a verifier: ${f.check} ${f.ticket}`)
  for (const f of a.left) out.push(`left alone: ${f.check} ${f.ticket}: ${f.left}`)
  out.push('', report
    ? `REPORT ONLY: ${a.items.length} proposals and ${a.questions.length} questions. Nothing is asked and nothing is written.`
    : `${a.items.length} proposals, ${a.questions.length} questions. Nothing is written until you approve: answer with the numbers to write (all, 1,3-5, or none).`)
  return out.join('\n')
}

// "all", "none", or "1,3-5": the approved item numbers, or null for anything else.
export function approvedNumbers(answer, count) {
  const s = String(answer).trim().toLowerCase()
  if (s === 'all') return Array.from({ length: count }, (_, i) => i + 1)
  if (s === 'none') return []
  const out = new Set()
  for (const part of s.split(/\s*,\s*/)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!m) return null
    const [a, b] = [Number(m[1]), Number(m[2] ?? m[1])]
    if (a < 1 || b > count || a > b) return null
    for (let i = a; i <= b; i++) out.add(i)
  }
  return [...out].sort((x, y) => x - y)
}

// ---- the read-back: each approved write, read again from Jira after it went -----------------------

// A desk-jira command as its shell words, the quotes shq adds undone, also inside a word
// (`summary='a title'`).
export function commandWords(cmd) {
  return (String(cmd).match(/(?:'[^']*'|\\.|[^\s'\\])+/g) ?? []).map((w) => w.replace(/'([^']*)'|\\(.)/g, (_, q, e) => q ?? e))
}

// What one written command should now read as on `issue` (desk-jira get --json), and `rendered`,
// the description's rendered HTML (read for a description edit only). `item` is the approved finding,
// whose `edit.to` or Children `section` the new description must carry. `link` and `unlink` are read
// back by desk-jira itself as they are written, which exits 1 when the link is not as asked.
export function readbackOf(cmd, issue, rendered = null, item = {}) {
  const [, op, key, ...rest] = commandWords(cmd)
  if (op === 'link' || op === 'unlink') return { cmd, ok: true, why: `read back by desk-jira ${op} as it was written` }
  const t = issue ? ticketOf(issue, []) : null
  if (!t) return { cmd, ok: false, why: `${key} could not be read back` }
  const res = (ok, why) => ({ cmd, ok, why })
  if (op === 'transition') return res(t.status.toLowerCase() === String(rest[0]).toLowerCase(), `status is ${t.status}`)
  if (op === 'edit') {
    const [, id, value] = /^([^=]+)=(.*)$/s.exec(rest[0] ?? '') ?? []
    if (id === 'description') {
      const del = (String(rendered ?? '').match(/<del/g) ?? []).length
      const want = [...(item.edit?.to ? [item.edit.to] : []), ...(item.section ?? []).flatMap((l) => l.match(KEY) ?? [])]
      const missing = want.filter((w) => !t.text.includes(w))
      if (rendered == null) return res(false, 'the rendered description could not be read')
      return res(!del && !missing.length, [del ? `${del} <del in the rendered HTML: a hyphen read as strikethrough, escape it and edit again` : 'no <del in the rendered HTML',
        ...missing.map((w) => `missing: ${w}`)].join('; '))
    }
    if (id === 'summary') return res(t.summary === value, `summary is ${t.summary}`)
    const got = ticketOf(issue, [id]).fields[id]
    // `<value>`: the scan had nothing to copy and the user chose the value, so any value is the write.
    if (/^<.*>$/.test(value)) return res(got != null && got !== '', `${id} is ${got ?? 'blank'}`)
    return res(String(got) === value, `${id} is ${got ?? 'blank'}`)
  }
  return res(false, `no read-back for "desk-jira ${op}"`)
}

// ---- a priority epic's open work, handed to the batch's orchestrator --------------------------

// Every open child of each priority epic, in rank order, then transitively every open ticket one of
// them is blocked by, less the tickets already in the batch's queue. `childrenOf(epic)` and `get(key)`
// read Jira (get gives null for a ticket that could not be read); `filesOf(t)` the files a ticket
// touches. The list is in Blocks order, every blocker before what it blocks; a Blocks loop keeps its
// tickets in the order found and is named.
export function priorityHandoff({ epics, childrenOf, get, batch, filesOf = () => [] }) {
  const found = new Map(), why = new Map(), unread = []
  const todo = []
  for (const e of epics) for (const c of childrenOf(e)) if (!isDone(c.category) && !found.has(c.key)) { found.set(c.key, c); why.set(c.key, `child of ${e}`); todo.push(c.key) }
  while (todo.length) {
    const k = todo.shift()
    for (const l of found.get(k).links) {
      if (l.type !== 'Blocks' || l.verb !== 'is blocked by' || isDone(l.category) || found.has(l.key) || unread.includes(l.key)) continue
      const b = get(l.key)
      if (!b) { unread.push(l.key); continue }
      if (isDone(b.category)) continue
      found.set(b.key, b); why.set(b.key, `blocks ${k}`); todo.push(b.key)
    }
  }
  const blockersOf = (k) => found.get(k).links.filter((l) => l.type === 'Blocks' && l.verb === 'is blocked by' && found.has(l.key)).map((l) => l.key)
  // Blocks order: repeatedly take the first ticket, in the order found, whose blockers are all placed.
  const order = [], rest = [...found.keys()]
  while (rest.length) {
    const i = rest.findIndex((k) => blockersOf(k).every((b) => order.includes(b)))
    if (i < 0) break
    order.push(...rest.splice(i, 1))
  }
  const loop = [...rest]
  order.push(...rest)
  const list = order.filter((k) => !batch.keys.has(k)).map((k) => ({ key: k, summary: found.get(k).summary, why: why.get(k), after: blockersOf(k) }))
  const byFile = new Map()
  for (const { key } of list) for (const f of new Set(filesOf(found.get(key)))) byFile.set(f, [...(byFile.get(f) ?? []), key])
  return {
    epics, batch: batch.running ? { name: batch.name, supervised: batch.supervised } : null, list,
    inBatch: order.filter((k) => batch.keys.has(k)), loop, unread,
    shared: [...byFile].filter(([, ks]) => ks.length > 1).map(([file, keys]) => ({ file, keys })),
  }
}

// The files a ticket names: its citations and the repo files its code spans name.
export const filesNamed = (t) => [...new Set([...citationsOf(t.text).map((c) => c.path),
  ...t.text.split(/\r?\n/).flatMap((l) => spansOf(l).map((s) => premiseName(s.span)).filter((p) => p?.kind === 'file').map((p) => p.name))])]

// The hand-off as the message the orchestrator reads, or, with no batch running, as the next batch.
export function handoffText(h) {
  const to = !h.batch ? 'as the next batch: no batch is running'
    : h.batch.supervised ? `for batch ${h.batch.name ?? '?'}, which the supervisor runs: no orchestrator session to send it to, so the user admits it`
      : `for batch ${h.batch.name ?? '?'} to triage and admit`
  const out = [`Priority work from desk-groom (${h.epics.join(', ')}), ${to}. The groom has not run queue.mjs admit.`, '']
  if (!h.list.length) out.push('Nothing to add: every open child and blocker is already in the queue.')
  h.list.forEach((x, i) => out.push(`${i + 1}. ${x.key}  ${x.summary}  (${x.why}${x.after.length ? `; after ${x.after.join(', ')}` : ''})`))
  if (h.shared.length) out.push('', 'Files they share:', ...h.shared.map((s) => `  ${s.file}: ${s.keys.join(', ')}`))
  if (h.loop.length) out.push('', `Blocks loop, order not settled: ${h.loop.join(', ')}`)
  if (h.inBatch.length) out.push('', `Already in the queue: ${h.inBatch.join(', ')}`)
  if (h.unread.length) out.push('', `Blockers that could not be read: ${h.unread.join(', ')}`)
  return out.join('\n')
}

// ---- origin/<default>, read with git ----------------------------------------------------------

export function repoAt(root, branch) {
  const ref = `origin/${branch}`
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 })
  const tryGit = (...a) => { try { return git(...a) } catch { return null } }
  const files = git('ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean)
  const fileSet = new Set(files)
  const cache = new Map(), grep = new Map()
  // `--format=%x1e%H%x09%s --name-only`: one record per commit, its files on the lines after.
  const parseLog = (out) => (out ?? '').split('\x1e').filter((b) => b.trim()).map((b) => {
    const [head, ...rest] = b.trim().split('\n')
    const [sha, subject] = head.split('\t')
    return { sha, subject: subject ?? '', files: rest.filter(Boolean) }
  })
  return {
    resolve(p) {
      if (fileSet.has(p)) return p
      if (p.includes('/')) return null
      const hits = files.filter((f) => f === p || f.endsWith(`/${p}`))
      return hits.length === 1 ? hits[0] : null
    },
    // A file the text names, at its path or under any directory: `bin/x.mjs` for `skills/a/bin/x.mjs`.
    exists(p) { return fileSet.has(p) || files.some((f) => f.endsWith(`/${p}`)) },
    lines(p) { if (!cache.has(p)) cache.set(p, (tryGit('show', `${ref}:${p}`) ?? '').split('\n')); return cache.get(p) },
    has(s) {
      if (!grep.has(s)) grep.set(s, spawnSync('git', ['-C', root, 'grep', '-q', '-F', '-e', s, ref], { stdio: 'ignore' }).status === 0)
      return grep.get(s)
    },
    commitsNaming(key) {
      return parseLog(tryGit('log', ref, '-i', '--fixed-strings', `--grep=${key}`, '--format=%x1e%H%x09%s', '--name-only'))
        .filter((c) => keyMatches(c.subject, key))
    },
    commitsTouching(paths, since) {
      const a = ['log', ref, '--no-merges', '--format=%x1e%H%x09%s', '--name-only']
      if (since) a.push(`--since=${String(since).slice(0, 19)}`)
      return parseLog(tryGit(...a, '--', ...paths)).map((c) => ({ ...c, files: c.files.filter((f) => paths.includes(f)) }))
    },
    renamedTo(p) {
      const base = p.split('/').pop()
      const hits = files.filter((f) => f.split('/').pop() === base)
      return hits.length === 1 ? hits[0] : null
    },
  }
}

// ---- Jira, read with desk-jira ----------------------------------------------------------------

const jira = (...a) => JSON.parse(execFileSync('desk-jira', [...a, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }))
const die = (m) => { console.error(`groom-scan: ${m}`); process.exit(2) }

function args(a) {
  const o = { _: [] }
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { const k = a[i].slice(2); o[k] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true } else o._.push(a[i])
  }
  return o
}

// Jira Cloud gives at most 100 issues a page with fields; more than one page is refused rather than
// groomed in part, since a truncated backlog reads as a clean one.
function scan(o) {
  for (const k of ['repo', 'default', 'project']) if (!o[k] || o[k] === true) die(`scan needs --${k}`)
  const fields = String(o.fields && o.fields !== true ? o.fields : '').split(',').map((s) => s.trim()).filter((s) => s && s !== 'none')
  const ids = [...new Set([o.priority, ...fields].filter((s) => s && s !== true && s !== 'none'))]
  const jql = o.jql && o.jql !== true ? o.jql : `project = ${o.project} AND statusCategory != Done ORDER BY key ASC`
  const page = jira('search', jql, '100')
  if (page.isLast === false || page.nextPageToken) die(`more than 100 open tickets match "${jql}": narrow it with --jql (one epic, or a key range) and groom each part`)
  const tickets = (page.issues ?? []).map((i) => ticketOf(jira('get', i.key), ids))
  const siblings = {}
  for (const p of new Set(tickets.map((t) => t.parent).filter(Boolean))) {
    siblings[p] = jira('children', p).map((c) => ({ key: c.key, summary: c.fields?.summary ?? '' }))
  }
  const priority = o.priority && o.priority !== true && o.priority !== 'none' ? o.priority : null
  const done = o.done && o.done !== true ? o.done : 'Done'
  // Each open epic's children in rank order. Those in the scan are already read; one outside it is
  // read in full where the epic has DoD items to cover, or where it is open and its priority counts
  // on the priority path. A key its Children section lists that Jira does not have under it is
  // looked up, null only when Jira answers 404: any other failure stops the scan, since a failed
  // read reported as a missing issue would propose deleting a valid row.
  const byKey = new Map(tickets.map((t) => [t.key, t]))
  const children = {}, lookup = {}
  const read = (k) => {
    try { return ticketOf(jira('get', k), ids) } catch (err) {
      if (/\bHTTP 404\b/.test(String(err.stderr ?? ''))) return null
      die(`could not read ${k}: ${String(err.stderr ?? err.message).trim()}`)
    }
  }
  for (const e of tickets.filter(isEpic)) {
    const dod = criteriaOf(e.text).some((c) => c.id.startsWith('DoD'))
    children[e.key] = jira('children', e.key).map((c) => {
      const t = ticketOf(c, ids)
      return byKey.get(c.key) ?? (dod || (priority && !isDone(t.category)) ? read(c.key) : null) ?? t
    })
    for (const r of childrenSection(e.text)?.rows ?? []) {
      if (!children[e.key].some((c) => c.key === r.key) && !(r.key in lookup)) lookup[r.key] = byKey.get(r.key) ?? read(r.key)
    }
  }
  let findings = [
    ...groom({ tickets, siblings, repo: repoAt(o.repo, o.default), fields: ids, priority, done }),
    ...groomEpics({ tickets, children, lookup, priority, size: o.size && o.size !== true && o.size !== 'none' ? o.size : null, done,
      inProgress: o['in-progress'] && o['in-progress'] !== true ? o['in-progress'] : 'In Progress' }),
  ].map((f) => ({ kind: 'fix', ...f }))
  const batch = readBatches(o.queue)
  findings = leaveBatch(findings, batch)
  if (o.json) { console.log(JSON.stringify(findings, null, 2)); return }
  console.log(`groom-scan: ${tickets.length} open tickets, ${findings.length} findings (origin/${o.default})`)
  for (const f of findings) {
    console.log(`\n${f.check.padEnd(9)} ${f.ticket}${f.other ? ` · ${f.other}` : ''}${f.kind === 'fix' ? '' : `   [${f.kind}]`}${f.verify ? '   [verify first]' : ''}`)
    for (const e of f.evidence) console.log(`  evidence: ${e}`)
    if (f.edit) console.log(`  edit    : ${f.edit.from} -> ${f.edit.to}`)
    for (const c of f.criteria ?? []) console.log(`  criterion ${c.id}: ${quote(c.text)}`)
    if (f.question) console.log(`  question: ${f.question}`)
    for (const x of f.options ?? []) console.log(`  option  : ${x}${x === f.recommend ? '   (recommended)' : ''}`)
    for (const p of f.propose) console.log(`  propose : ${p}`)
    for (const l of f.section ?? []) console.log(`  section : ${l}`)
    if (f.left) console.log(`  left    : ${f.left}`)
  }
}

// The batch's queue (queue.mjs, `desk-env paths` DESK_QUEUE). None there is no batch; one that will
// not parse stops the groom, since an unread batch read as none would propose writes to its tickets.
function readQueue(path) {
  if (!path || path === true || !existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (err) { die(`could not read the batch queue ${path}: ${err.message}`) }
}
// The repo's batches from its standing queue's path: that queue, then each named batch's queue in
// `batches/<name>/` beside it (an archived one, under `.done`, is not a batch), as batchesOf reads them.
function readBatches(path) {
  const named = []
  if (path && path !== true) {
    const dir = join(dirname(path), 'batches')
    let names = []
    try { names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort() } catch { /* no named batches */ }
    for (const n of names) {
      const q = readQueue(join(dir, n, 'queue.json'))
      if (q) named.push({ ...q, batch: q.batch ?? n })
    }
  }
  return batchesOf([readQueue(path), ...named])
}
const readJson = (p, what) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch (err) { die(`could not read ${what} ${p}: ${err.message}`) } }

// Every proposal as one approval list. --report (the weekly run) prints it and asks nothing.
function approval(o) {
  if (!o.scan || o.scan === true) die('approval needs --scan <the scan\'s --json output> [--add <settled proposals.json>] [--report] [--json]')
  const a = approvalOf(readJson(o.scan, 'the scan'), o.add && o.add !== true ? [].concat(readJson(o.add, 'the settled proposals')) : [])
  console.log(o.json ? JSON.stringify(a, null, 2) : approvalText(a, { report: !!o.report }))
}

// Just before the approved list is written: any of these keys the batch now holds is left alone.
function held(o) {
  const batch = readBatches(o.queue)
  const hit = o._.filter((k) => batch.held.has(k))
  for (const k of hit) console.log(`left alone: ${k} is ${batch.held.get(k)} in batch ${batchName(batch, k)}`)
  process.exit(hit.length ? 1 : 0)
}

// After the approved items are written: each one's commands read back from Jira. Exits 1 when any did
// not land as proposed, or a description's rendered HTML has a <del.
function readback(o) {
  const file = o._[0]
  if (!file || !o.approved || o.approved === true) die('readback needs <the approval --json output> --approved <all | 1,3-5>')
  const a = readJson(file, 'the approval list')
  const nums = approvedNumbers(o.approved, a.items.length)
  if (!nums) die(`--approved ${o.approved}: want all, none or numbers from 1 to ${a.items.length}`)
  const get = (k) => { try { return jira('get', k) } catch { return null } }
  const html = (k) => {
    try { return JSON.parse(execFileSync('desk-jira', ['api', `api/2/issue/${k}?fields=description&expand=renderedFields`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).renderedFields?.description ?? '' } catch { return null }
  }
  let bad = 0
  for (const f of a.items.filter((x) => nums.includes(x.n))) {
    for (const cmd of f.propose) {
      const [, op, key, field] = commandWords(cmd)
      const r = readbackOf(cmd, op === 'link' || op === 'unlink' ? null : get(key), op === 'edit' && /^description=/.test(field ?? '') ? html(key) : null, f)
      if (!r.ok) bad++
      console.log(`${r.ok ? 'ok  ' : 'FAIL'} [${f.n}] ${cmd}: ${r.why}`)
    }
  }
  process.exit(bad ? 1 : 0)
}

// A priority epic's open work for the batch's orchestrator (or the next batch). It never admits.
function priority(o) {
  const epics = o._.flatMap((e) => e.split(',')).filter(Boolean)
  if (!epics.length) die('priority needs one or more epic keys [--queue <DESK_QUEUE>] [--state <DESK_STATE>] [--json]')
  const get = (k) => { try { return ticketOf(jira('get', k)) } catch { return null } }
  const childrenOf = (e) => jira('children', e).map((c) => ticketOf(c)).map((c) => (isDone(c.category) ? c : get(c.key) ?? c))
  const filesOf = (t) => {
    const rec = o.state && o.state !== true ? join(o.state, 'triage', `${t.key}.json`) : null
    try { const s = rec && JSON.parse(readFileSync(rec, 'utf8')).files_in_scope; if (Array.isArray(s)) return s } catch { /* no triage record */ }
    return filesNamed(t)
  }
  const h = priorityHandoff({ epics, childrenOf, get, batch: readBatches(o.queue), filesOf })
  console.log(o.json ? JSON.stringify(h, null, 2) : handoffText(h))
}

function verdict(o) {
  const file = o._[0]
  if (!file || !o.scan || o.scan === true) die('verdict needs a results file and --scan <the scan\'s --json output>')
  const results = [].concat(JSON.parse(readFileSync(file, 'utf8')))
  const landed = new Map(JSON.parse(readFileSync(o.scan, 'utf8')).filter((f) => f.check === 'landed').map((f) => [f.ticket, (f.criteria ?? []).map((c) => c.id)]))
  const out = results.map((r) => closeVerdict(r, landed.get(r.ticket) ?? null))
  console.log(JSON.stringify(out, null, 2))
}

// Run just before each approved close is written: the key's open PRs and its Jira status, read again
// now. Exits 0 only when the close may go out; 1 keeps the ticket open, its `report` saying why.
function preclose(o) {
  const ticket = o._[0]
  if (!ticket || !o.scan || o.scan === true) die('preclose needs a ticket key and --scan <the scan\'s --json output>')
  const before = JSON.parse(readFileSync(o.scan, 'utf8')).find((f) => f.check === 'landed' && f.ticket === ticket)?.status ?? null
  const gh = spawnSync('gh', ['pr', 'list', ...(o.repo && o.repo !== true ? ['--repo', o.repo] : []), '--search', ticket, '--state', 'open',
    '--limit', '100', '--json', 'number,title,headRefName,isDraft,createdAt'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  let prs = null, prsError = null
  try { if (gh.status === 0) prs = JSON.parse(gh.stdout); else prsError = `gh pr list failed: ${String(gh.stderr || gh.error?.message || '').trim().split('\n')[0]}` } catch { prsError = 'gh pr list gave no JSON' }
  let status = null, statusError = null
  try { status = jira('get', ticket).fields?.status?.name ?? null; if (!status) statusError = 'desk-jira get gave no status' } catch (err) { statusError = `desk-jira get failed: ${String(err.stderr || err.message).trim().split('\n')[0]}` }
  const out = precloseCheck({ ticket, before, status, statusError, prs, prsError })
  console.log(JSON.stringify(out, null, 2))
  process.exit(out.close ? 0 : 1)
}

const real = (p) => { try { return realpathSync(p) } catch { return p } }
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const [cmd, ...rest] = process.argv.slice(2)
  const run = { scan, verdict, preclose, approval, held, readback, priority }[cmd]
  if (!run) die('usage: groom-scan.mjs scan|verdict|preclose|approval|held|readback|priority … (see the header)')
  run(args(rest))
}
