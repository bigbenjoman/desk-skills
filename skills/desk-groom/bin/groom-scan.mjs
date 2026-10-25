#!/usr/bin/env node
// The scripted half of desk-groom: every per-ticket check that reads the same every run, so the
// groom proposes from evidence rather than prose re-derived by hand across the whole backlog. It only
// reads: Jira through desk-jira, the repo through git against origin/<default>.
//
//   node groom-scan.mjs scan --repo <root> --default <branch> --project <§4 Jira project key>
//        [--priority <§4 Priority field>] [--fields <§4 Other fields, comma-separated>]
//        [--done <§4 Done state>] [--jql <jql>] [--json]
//   node groom-scan.mjs verdict <results.json>     a verifier's per-criterion results in, close or keep out
//
// `scan` prints one block per finding (or a JSON array with --json). A finding is
//   {check, ticket, other?, evidence: [line], propose: [desk-jira command], verify?: brief}
// where `check` is landed, duplicate, link, stale, field, title or blocker. A finding with `verify`
// is a candidate only: a read-only verifier settles it before anything is proposed (SKILL.md).

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { keyMatches } from '../../desk-cleanup/bin/cleanup-scan.mjs'

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
  const val = (v) => (v && typeof v === 'object' ? v.value ?? v.name ?? null : v ?? null)
  return {
    key: issue.key,
    type: f.issuetype?.name ?? '',
    level: f.issuetype?.hierarchyLevel ?? 0,
    summary: f.summary ?? '',
    text: plain(f.description),
    created: f.created ?? '',
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

// The ticket's sections: [{name, lines: [{n, text}]}], `h2.` or markdown headings.
function sections(text) {
  const lines = String(text).split(/\r?\n/)
  const head = lines.some((l) => /^\s*h[1-6]\.\s+/i.test(l)) ? /^\s*h[1-6]\.\s+(.*)$/i : /^\s*#{1,6}\s+(.*?)\s*$/
  const out = [{ name: '', lines: [] }]
  lines.forEach((l, i) => { const m = head.exec(l); if (m) out.push({ name: m[1].trim(), lines: [] }); else out.at(-1).lines.push({ n: i + 1, text: l }) })
  return out
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
        propose: [`desk-jira transition ${t.key} ${shq(done)}`],
        verify: 'landed',
      })
    }

    // ---- stale citations: a file or line main no longer matches (AC4)
    for (const c of citationsOf(t.text)) {
      const path = repo.resolve(c.path)
      if (!path) {
        const moved = repo.renamedTo(c.path)
        add({ check: 'stale', ticket: t.key, evidence: [`cites ${c.cite}, but ${c.path} is not on main${moved ? `; it is now ${moved}` : ''}`],
          edit: moved ? { from: c.cite, to: c.cite.replace(c.path, moved) } : null,
          propose: [`desk-jira edit ${t.key} description=@<${t.key} description with the edit>`], verify: moved ? undefined : 'stale' })
        continue
      }
      const lines = repo.lines(path)
      // The names written beside the citation, on its line, are what it claims sits at that line.
      const from = Math.max(t.text.lastIndexOf('\n', c.index) + 1, c.index - 40)
      const to = Math.min(...[t.text.indexOf('\n', c.index), t.text.length].filter((n) => n >= 0), c.index + c.cite.length + 40)
      const named = spansOf(t.text.slice(from, to)).map((s) => fnName(s.span) ?? s.span).filter((s) => !/:\d+/.test(s))
      if (c.end > lines.length) {
        add({ check: 'stale', ticket: t.key, evidence: [`cites ${c.cite}, but ${path} has ${lines.length} lines on main`], edit: null,
          propose: [`desk-jira edit ${t.key} description=@<${t.key} description with the edit>`], verify: 'stale' })
        continue
      }
      for (const name of named) {
        const window = lines.slice(Math.max(0, c.line - 4), c.end + 3).join('\n')
        if (window.includes(name)) continue
        const at = lines.findIndex((l) => l.includes(name))
        add({ check: 'stale', ticket: t.key,
          evidence: [`cites \`${name}\` at ${c.cite}, but line ${c.line} of ${path} on main is "${quote(lines[c.line - 1] ?? '')}"${at >= 0 ? `; \`${name}\` is at line ${at + 1}` : `, and \`${name}\` is not in it`}`],
          edit: at >= 0 ? { from: c.cite, to: `${c.path}:${at + 1}` } : null,
          propose: [`desk-jira edit ${t.key} description=@<${t.key} description with the edit>`], verify: at >= 0 ? undefined : 'stale' })
        break
      }
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
    if (want && !prefixOf(t.summary)) {
      const title = `${want}: ${t.summary}`
      add({ check: 'title', ticket: t.key, evidence: [`${sibs.filter((s) => prefixOf(s.summary) === want).length} of ${t.parent}'s other children start "${want}:", and "${quote(t.summary)}" has no prefix`],
        propose: [`desk-jira edit ${t.key} summary=${shq(title)}`] })
    }

    // ---- dead blockers: Done ones, and a set that can never all be Done (AC6)
    const blockers = t.links.filter((l) => l.type === 'Blocks' && /blocked by/i.test(l.verb))
    for (const b of blockers.filter((l) => isDone(l.category))) {
      add({ check: 'blocker', ticket: t.key, other: b.key, evidence: [`blocked by ${b.key}, which is Done`], propose: [`desk-jira unlink ${t.key} ${b.key} Blocks`] })
    }
    const live = blockers.filter((l) => !isDone(l.category))
    if (live.length > BLOCKER_FANIN) {
      add({ check: 'blocker', ticket: t.key, evidence: [`held behind ${live.length} open blockers (${live.map((l) => l.key).join(', ')}), a set that keeps growing and never all reaches Done`],
        rescope: true, propose: ['rescope: keep only the blockers the work truly needs, and unlink the rest', ...live.map((l) => `desk-jira unlink ${t.key} ${l.key} Blocks`)] })
    }

    // ---- missing links: named in prose, or a name another open ticket adds or changes (AC3)
    const parts = sections(t.text)
    for (const s of parts.filter((x) => !/^children\b/i.test(x.name))) for (const l of s.lines) {
      for (const k of new Set(l.text.match(KEY) ?? [])) {
        if (k === t.key || k === t.parent || !open.has(k) || isEpic(open.get(k)) || linked(t, k)) continue
        if (out.some((f) => f.check === 'link' && f.ticket === t.key && f.other === k)) continue
        const where = `${s.name || 'description'}: ${l.text}`
        const verb = DEPENDS.test(where) ? 'blocked-by' : FEEDS.test(l.text) ? 'blocks' : 'relates-to'
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

  // ---- blocker loops can never all be Done (AC6)
  for (const loop of blockerCycles(work)) {
    add({ check: 'blocker', ticket: loop[0], evidence: [`Blocks links loop: ${loop.join(' blocked by ')}`], rescope: true,
      propose: [`rescope: one of these does not need the other; unlink that pair (desk-jira unlink <KEY> <OTHER> Blocks)`] })
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
export function closeVerdict(r) {
  const criteria = r.criteria ?? []
  const notMet = criteria.filter((c) => !(c.met === true && /\S+:\d+/.test(String(c.cite ?? ''))))
  const reasons = [
    ...(criteria.length ? [] : ['no criteria were checked']),
    ...notMet.map((c) => `${c.id ?? '?'} NOT MET${c.cite ? '' : ' (no file:line)'}`),
    ...(r.open_prs ?? []).map((n) => `PR #${n} on the key is still open`),
    ...(r.scope_left ?? []).map((s) => `scope still open: ${s}`),
  ]
  return { ticket: r.ticket, close: reasons.length === 0, reasons }
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
  const findings = groom({ tickets, siblings, repo: repoAt(o.repo, o.default), fields: ids, priority, done: o.done && o.done !== true ? o.done : 'Done' })
  if (o.json) { console.log(JSON.stringify(findings, null, 2)); return }
  console.log(`groom-scan: ${tickets.length} open tickets, ${findings.length} findings (origin/${o.default})`)
  for (const f of findings) {
    console.log(`\n${f.check.padEnd(9)} ${f.ticket}${f.other ? ` · ${f.other}` : ''}${f.verify ? '   [verify first]' : ''}`)
    for (const e of f.evidence) console.log(`  evidence: ${e}`)
    if (f.edit) console.log(`  edit    : ${f.edit.from} -> ${f.edit.to}`)
    for (const c of f.criteria ?? []) console.log(`  criterion ${c.id}: ${quote(c.text)}`)
    for (const p of f.propose) console.log(`  propose : ${p}`)
  }
}

function verdict(o) {
  const file = o._[0]
  if (!file) die('verdict needs a results file')
  const results = [].concat(JSON.parse(readFileSync(file, 'utf8')))
  const out = results.map(closeVerdict)
  console.log(JSON.stringify(out, null, 2))
}

const real = (p) => { try { return realpathSync(p) } catch { return p } }
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const [cmd, ...rest] = process.argv.slice(2)
  const run = { scan, verdict }[cmd]
  if (!run) die('usage: groom-scan.mjs scan|verdict … (see the header)')
  run(args(rest))
}
