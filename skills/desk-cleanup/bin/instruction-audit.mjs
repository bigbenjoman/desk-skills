// What Claude Code loads into every session at launch, measured, and where each oversized part could
// move so that a session loads it only when its work reaches it. Only reads: every proposal is a diff
// printed for the user to approve, and nothing here writes a file.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative, sep } from 'node:path'

// Claude Code's own target for one CLAUDE.md; the same bound holds for anything else read at launch.
export const INSTRUCTION_CAP_LINES = 200
// The Agent Skills limit on a description, and the listing every session carries one of per skill.
export const DESCRIPTION_CAP = 1024
// Claude Code loads MEMORY.md into every session and worker on every call; past this it is a document.
export const MEMORY_INDEX_CAP = { bytes: 6144, lines: 60 }
// Claude Code follows @ imports this many hops deep.
const IMPORT_DEPTH = 5

const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }
export const real = (p) => { try { return realpathSync(p) } catch { return p } }
const fence = (l) => /^\s*(```|~~~)/.test(l)
export const linesOf = (text) => { const l = String(text).split('\n'); if (l.at(-1) === '') l.pop(); return l }
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'section'

// The index's entries that run past one line: a bullet, heading or paragraph with continuation lines.
export function longEntries(text) {
  const out = []; let cur = null
  String(text).split('\n').forEach((l, i) => {
    if (!l.trim()) { cur = null; return }
    const heading = /^\s*#/.test(l)
    if (cur && !heading && !/^\s*([-*+]|\d+[.)])\s/.test(l)) { cur.lines++; return }
    cur = heading ? null : { first: l.trim().replace(/^([-*+]|\d+[.)])\s*/, ''), lines: 1, start: i }
    if (cur) out.push(cur)
  })
  return out.filter((e) => e.lines > 1)
}

// A file's level-2 sections (level-1 where it has no level 2), outside code fences, as line ranges.
export function sections(lines) {
  const heads = []; let inFence = false
  lines.forEach((l, i) => {
    if (fence(l)) inFence = !inFence
    const m = !inFence && l.match(/^(#{1,2})\s+(.*?)\s*$/)
    if (m) heads.push({ level: m[1].length, heading: m[2].trim(), start: i })
  })
  const level = heads.some((h) => h.level === 2) ? 2 : 1
  const top = heads.filter((h) => h.level <= level)
  return top.map((h, k) => ({ ...h, count: (top[k + 1]?.start ?? lines.length) - h.start })).filter((h) => h.level === level)
}

// The files a file pulls in with @path, outside code fences and code spans, that exist.
export function importsOf(text, file, home) {
  const out = []; let inFence = false
  for (const l of String(text).split('\n')) {
    if (fence(l)) { inFence = !inFence; continue }
    if (inFence) continue
    for (const m of l.replace(/`[^`]*`/g, '').matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.-][\w./~-]*)/g)) {
      const ref = m[1].replace(/[.,;:]+$/, '')
      const p = ref.startsWith('~/') ? join(home, ref.slice(2)) : resolve(dirname(file), ref)
      if (isFile(p)) out.push(p)
    }
  }
  return [...new Set(out)]
}

// The frontmatter's line range: lines[1 .. end-1] are YAML, lines[end] is the closing ---.
function frontmatter(lines) {
  if (lines[0]?.trim() !== '---') return null
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  return end > 0 ? { end } : null
}
export const scopedRule = (text) => { const l = linesOf(text); const fm = frontmatter(l); return Boolean(fm && l.slice(1, fm.end).some((x) => /^paths\s*:/.test(x))) }

// One frontmatter field (`description` by default): its text, and the lines it takes.
export function descriptionOf(text, key = 'description') {
  const lines = linesOf(text); const fm = frontmatter(lines)
  if (!fm) return null
  const at = new RegExp(`^${key}\\s*:`)
  const i = lines.findIndex((l, k) => k > 0 && k < fm.end && at.test(l))
  if (i < 0) return null
  let v = lines[i].replace(at, '').trim(); let j = i + 1
  const block = /^[>|][-+]?\s*$/.test(v)
  if (block) v = ''
  while (j < fm.end && (/^\s+\S/.test(lines[j]) || (block && !lines[j].trim()))) v += ` ${lines[j++].trim()}`
  while (j > i + 1 && !lines[j - 1].trim()) j--
  v = v.trim()
  if (!block) v = v.replace(/^(["'])([\s\S]*)\1$/, '$2')
  return { text: v, start: i, count: j - i, end: fm.end }
}

function rulesIn(dir) {
  if (!isDir(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => { const p = join(dir, e.name); return isDir(p) ? rulesIn(p) : e.name.endsWith('.md') ? [p] : [] })
}

// skillOverrides from the user, project and local settings, the later winning as Claude Code merges them.
function skillOverrides(root, home) {
  const out = {}
  for (const f of [join(home, '.claude', 'settings.json'), join(root, '.claude', 'settings.json'), join(root, '.claude', 'settings.local.json')]) {
    try { Object.assign(out, JSON.parse(readFileSync(f, 'utf8')).skillOverrides ?? {}) } catch { /* absent or unreadable */ }
  }
  return out
}

// Every file Claude Code reads into a session started at `root`, in the order it reads them. Rules
// with `paths:`, subdirectory CLAUDE.md files, skill bodies and memory topic files load on demand
// and are not here; an @ import loads with the file that names it, so it is.
export function launchFiles({ root, home, memoryPath = null, policy = [] }) {
  root = real(root); home = real(home)
  const rows = []; const seen = new Set()
  const add = (kind, path, extra = {}) => {
    if (!isFile(path) || seen.has(real(path))) return null
    seen.add(real(path))
    const text = readFileSync(path, 'utf8')
    const row = { kind, path: real(path), text, bytes: Buffer.byteLength(text), lines: linesOf(text).length, ...extra }
    rows.push(row); return row
  }
  const withImports = (row, depth = 0) => {
    if (!row || depth >= IMPORT_DEPTH) return
    for (const p of importsOf(row.text, row.path, home)) withImports(add('import', p, { parent: row.path }), depth + 1)
  }
  for (const p of policy) withImports(add('policy', p))
  withImports(add('CLAUDE.md', join(home, '.claude', 'CLAUDE.md')))
  for (const p of rulesIn(join(home, '.claude', 'rules'))) if (!scopedRule(readFileSync(p, 'utf8'))) withImports(add('rule', p))
  const dirs = []
  for (let d = root; ; d = dirname(d)) { dirs.unshift(d); if (dirname(d) === d) break }
  for (const d of dirs) {
    for (const [kind, f] of [['CLAUDE.md', 'CLAUDE.md'], ['CLAUDE.md', join('.claude', 'CLAUDE.md')], ['AGENTS.md', 'AGENTS.md'], ['CLAUDE.local.md', 'CLAUDE.local.md']]) withImports(add(kind, join(d, f)))
  }
  for (const p of rulesIn(join(root, '.claude', 'rules'))) if (!scopedRule(readFileSync(p, 'utf8'))) withImports(add('rule', p))
  if (memoryPath) add('MEMORY.md', memoryPath)
  // What the skill listing carries for each skill, by Claude Code's rules: skillOverrides `off` and
  // `user-invocable-only`, and `disable-model-invocation: true`, leave it out; `name-only` lists the
  // name alone; otherwise the description, with `when_to_use` after it.
  const override = skillOverrides(root, home)
  const described = (kind, path, name) => {
    if (!isFile(path) || seen.has(real(path))) return
    const text = readFileSync(path, 'utf8'); const d = descriptionOf(text)
    if (!d) return
    seen.add(real(path))
    const mode = kind === 'skill' ? override[name] : undefined
    if (kind === 'skill' && (mode === 'off' || mode === 'user-invocable-only' || /^true$/i.test(descriptionOf(text, 'disable-model-invocation')?.text ?? ''))) return
    if (mode === 'name-only') { rows.push({ kind, name, path: real(path), text, description: d, listed: 'name-only', bytes: Buffer.byteLength(name), chars: 0 }); return }
    const when = kind === 'skill' ? descriptionOf(text, 'when_to_use')?.text : ''
    const listed = when ? `${d.text} ${when}` : d.text
    rows.push({ kind, name, path: real(path), text, description: d, bytes: Buffer.byteLength(listed), chars: listed.length })
  }
  for (const base of [join(home, '.claude'), join(root, '.claude')]) {
    const skills = join(base, 'skills')
    if (isDir(skills)) for (const n of readdirSync(skills).sort()) described('skill', join(skills, n, 'SKILL.md'), n)
    const agents = join(base, 'agents')
    if (isDir(agents)) for (const n of readdirSync(agents).sort()) if (n.endsWith('.md')) described('agent', join(agents, n), n.replace(/\.md$/, ''))
  }
  return rows
}

const INSTRUCTION = new Set(['policy', 'CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md', 'rule', 'import'])
// `imported` is the lines of the files it @ imports, which load with it and so count towards its cap.
export function overCap(row, imported = 0) {
  if (INSTRUCTION.has(row.kind)) return row.lines + imported > INSTRUCTION_CAP_LINES ? `over cap ${INSTRUCTION_CAP_LINES} lines${imported ? ` with its imports (${row.lines + imported})` : ''}` : ''
  if (row.kind === 'MEMORY.md') return row.bytes > MEMORY_INDEX_CAP.bytes || row.lines > MEMORY_INDEX_CAP.lines ? `over cap ${MEMORY_INDEX_CAP.bytes} B or ${MEMORY_INDEX_CAP.lines} lines` : ''
  return row.chars > DESCRIPTION_CAP ? `over cap ${DESCRIPTION_CAP} chars` : ''
}

// A unified diff of two line arrays, three lines of context; [] when they are the same.
export function unifiedDiff(from, to, a, b, ctx = 3) {
  const n = a.length, m = b.length; const ops = []
  if (n * m > 2e7) ops.push(...a.map((l) => ['-', l]), ...b.map((l) => ['+', l]))
  else {
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    let i = 0, j = 0
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++ } else if (L[i + 1][j] >= L[i][j + 1]) ops.push(['-', a[i++]]); else ops.push(['+', b[j++]])
    }
    while (i < n) ops.push(['-', a[i++]])
    while (j < m) ops.push(['+', b[j++]])
  }
  const changed = ops.flatMap((o, k) => (o[0] === ' ' ? [] : [k]))
  if (!changed.length) return []
  const groups = []
  for (const k of changed) { const g = groups.at(-1); if (g && k - g[1] <= 2 * ctx) g[1] = k; else groups.push([k, k]) }
  const oldAt = [], newAt = []; let o = 0, w = 0
  for (const op of ops) { oldAt.push(o); newAt.push(w); if (op[0] !== '+') o++; if (op[0] !== '-') w++ }
  const out = [`--- ${from}`, `+++ ${to}`]
  for (const [s, e] of groups) {
    const lo = Math.max(0, s - ctx), hi = Math.min(ops.length - 1, e + ctx), slice = ops.slice(lo, hi + 1)
    const oc = slice.filter((x) => x[0] !== '+').length, nc = slice.filter((x) => x[0] !== '-').length
    out.push(`@@ -${oc ? oldAt[lo] + 1 : oldAt[lo]},${oc} +${nc ? newAt[lo] + 1 : newAt[lo]},${nc} @@`, ...slice.map(([c, l]) => c + l))
  }
  return out
}

// The directories under root a section's text names, deepest existing prefix of each path.
function dirsNamed(text, root) {
  const dirs = new Set()
  for (const m of text.matchAll(/(?:^|[\s`'"(])((?:[\w@.-]+\/)+)/g)) {
    const segs = m[1].split('/').filter(Boolean)
    if (['.', '..', '~'].includes(segs[0])) continue
    let d = ''
    for (const s of segs) { const next = d ? `${d}/${s}` : s; if (isDir(join(root, next))) d = next; else break }
    if (d) dirs.add(d)
  }
  return [...dirs]
}
const commonDir = (dirs) => {
  const parts = dirs.map((d) => d.split('/'))
  const out = []
  for (let i = 0; parts.every((p) => i < p.length && p[i] === parts[0][i]); i++) out.push(parts[0][i])
  return out.join('/')
}

// Where one section of an oversized file goes. A file outside the repo becomes a user skill; inside,
// a section naming one directory goes to that directory's CLAUDE.md, one naming several to a rule
// scoped to them, and one naming none to a project skill. Each of those loads only when needed.
// A rule or skill gets a name no file and no other move already has, so its frontmatter is never
// appended to an existing one. `used` holds the paths this audit has already proposed.
export function targetFor(section, text, row, root, home, used = new Set()) {
  const inRepo = row.path.startsWith(root + sep)
  const free = (at) => { let s = slug(section.heading); while (existsSync(at(s)) || used.has(at(s))) s += '-2'; used.add(at(s)); return s }
  if (inRepo) {
    const dirs = dirsNamed(text, root)
    const common = dirs.length ? commonDir(dirs) : ''
    // .claude/CLAUDE.md and every unscoped file under .claude/rules load at launch, so text moved
    // there would still load in every session.
    const atLaunch = common === '.claude' || common === '.claude/rules' || common.startsWith('.claude/rules/')
    if (common && !atLaunch) return { kind: 'subdirectory CLAUDE.md', path: join(root, common, 'CLAUDE.md'), body: text.split('\n') }
    if (dirs.length) {
      const tops = dirs.filter((d) => !dirs.some((o) => o !== d && d.startsWith(`${o}/`))).sort()
      const s = free((x) => join(root, '.claude', 'rules', `${x}.md`))
      return { kind: 'path-scoped rule', path: join(root, '.claude', 'rules', `${s}.md`), body: ['---', 'paths:', ...tops.map((d) => `  - "${d}/**"`), '---', '', ...text.split('\n')] }
    }
  }
  const base = inRepo ? join(root, '.claude', 'skills') : join(home, '.claude', 'skills')
  const s = free((x) => join(base, x))
  return {
    kind: 'skill reference',
    path: join(base, s, 'SKILL.md'),
    body: ['---', `name: ${s}`, 'description: >-', `  Use when the work involves ${section.heading.replace(/[*_`]/g, '')}.`, '---', '', ...text.split('\n')],
  }
}

// The moves that bring one oversized file under its cap, largest section first: the source's new
// lines, and each target's lines to add.
export function planFor(row, { root, home, memoryDir, used = new Set(), imported = 0 }) {
  const lines = linesOf(row.text)
  if (row.kind === 'MEMORY.md') {
    const topics = new Set()
    const moves = longEntries(row.text).map((e) => {
      let s = slug(e.first.split(/\s+/).slice(0, 6).join(' ')); while (topics.has(s)) s += '-2'; topics.add(s)
      const body = lines.slice(e.start, e.start + e.lines).map((l, k) => (k ? l.trim() : l.trim().replace(/^([-*+]|\d+[.)])\s*/, '')))
      return { from: e.start, count: e.lines, heading: e.first, size: e.lines, replace: [`- [${e.first}](${s}.md)`], target: { kind: 'memory topic file', path: join(memoryDir ?? dirname(row.path), `${s}.md`), body: [`# ${e.first}`, '', ...body] } }
    })
    return moves
  }
  if (row.kind === 'skill' || row.kind === 'agent') {
    const d = row.description; const t = d.text
    const first = t.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? t
    const kept = first.length <= DESCRIPTION_CAP ? first : t.slice(0, t.lastIndexOf(' ', DESCRIPTION_CAP - 1))
    const rest = t.slice(kept.length).trim()
    // when_to_use is listed after the description, so it moves into the body with the rest.
    const w = row.kind === 'skill' ? descriptionOf(row.text, 'when_to_use') : null
    const moves = []
    if (rest) moves.push({ from: d.start, count: d.count, heading: 'description', size: rest.length, replace: ['description: >-', `  ${kept}`], target: null })
    if (w) moves.push({ from: w.start, count: w.count, heading: 'when_to_use', size: w.text.length, replace: [], target: null })
    if (moves.length) Object.assign(moves[0], { insertAfter: d.end, insert: ['', '## When to use', '', ...[rest, w?.text].filter(Boolean).flatMap((x, k) => (k ? ['', x] : [x]))] })
    return moves
  }
  // A section holding an @ line stays, or its import would move with it. Moves clear only the file's
  // own lines: where its imports keep it over the cap anyway, they are what to slim, so plan none.
  const secs = sections(lines).filter((s) => !importsOf(lines.slice(s.start, s.start + s.count).join('\n'), row.path, home).length)
    .sort((a, b) => b.count - a.count || a.start - b.start)
  if (imported && lines.length + imported - secs.reduce((s, x) => s + x.count, 0) > INSTRUCTION_CAP_LINES) return []
  const moves = []; let left = lines.length + imported
  for (const sec of secs) {
    if (left <= INSTRUCTION_CAP_LINES) break
    const text = lines.slice(sec.start, sec.start + sec.count).join('\n').replace(/\n+$/, '')
    moves.push({ from: sec.start, count: sec.count, heading: sec.heading, size: sec.count, replace: [], target: targetFor(sec, text, row, root, home, used) })
    left -= sec.count
  }
  return moves.sort((a, b) => a.from - b.from)
}

const shown = (p, root, home) => (p.startsWith(root + sep) ? relative(root, p) : p.startsWith(home + sep) ? `~/${relative(home, p)}` : p)
const label = (p, root, home) => (p.startsWith(root + sep) ? [`a/${relative(root, p)}`, `b/${relative(root, p)}`] : [shown(p, root, home), shown(p, root, home)])

// The audit's lines: each file read at launch with its size, any doctor output verbatim, then for each
// oversized file the moves proposed and every change they make as a diff. skill-doctor, when given,
// owns the skill and agent descriptions: the audit lists their sizes and judges none of them.
export function auditReport(rows, { root, home, memoryDir = null, doctor = {} }) {
  root = real(root); home = real(home)
  const out = []; const pad = (k) => k.padEnd(15)
  const judged = (r) => !((r.kind === 'skill' || r.kind === 'agent') && doctor['skill-doctor'] !== undefined)
  // The lines a file's @ imports add, at every depth; an import's own row is judged on its own lines.
  const below = (p) => rows.filter((x) => x.kind === 'import' && x.parent === p).reduce((s, x) => s + x.lines + below(x.path), 0)
  const imported = (r) => (INSTRUCTION.has(r.kind) && r.kind !== 'import' ? below(r.path) : 0)
  for (const r of rows) {
    const over = judged(r) ? overCap(r, imported(r)) : ''
    const size = r.listed === 'name-only' ? 'listed by name only' : r.kind === 'skill' || r.kind === 'agent' ? `${r.chars} chars of description` : `${r.bytes} B · ${r.lines} lines`
    const where = r.kind === 'skill' || r.kind === 'agent' ? `${r.name} (${shown(r.path, root, home)})` : shown(r.path, root, home)
    const note = r.kind === 'import' ? ` · loads with ${shown(r.parent, root, home)}: an @ import does not reduce what loads` : ''
    out.push(`launch : ${pad(r.kind)} · ${where} · ${size}${over ? ` · ${over}` : ''}${note}`)
  }
  out.push(`launch : ${pad('total')} · ${rows.length} files · ${rows.reduce((s, r) => s + r.bytes, 0)} B read into every session`)
  for (const [name, text] of Object.entries(doctor)) {
    const l = linesOf(text ?? '')
    out.push(`${name} : ${l[0] ?? '(no output)'}`, ...l.slice(1).map((x) => `${' '.repeat(name.length)} : ${x}`))
  }
  if (doctor['skill-doctor'] !== undefined) out.push('launch : skill and agent descriptions are judged by skill-doctor above, not here')

  const proposals = []; const diffs = []; const targets = new Map(); const used = new Set()
  const advice = { 'MEMORY.md': 'every entry is one line: shorten the longest', skill: 'nothing to move: shorten the description', agent: 'nothing to move: shorten the description' }
  for (const r of rows.filter((x) => judged(x) && overCap(x, imported(x)))) {
    const moves = planFor(r, { root, home, memoryDir, used, imported: imported(r) })
    if (!moves.length) {
      const big = rows.filter((x) => x.kind === 'import' && x.parent === r.path).sort((a, b) => b.lines + below(b.path) - (a.lines + below(a.path)))[0]
      const slim = big && sections(linesOf(r.text)).length ?`its @ imports keep it over the cap: slim ${shown(big.path, root, home)} (${big.lines + below(big.path)} lines with its own imports)` : null
      proposals.push(`propose : ${shown(r.path, root, home)} · ${slim ?? advice[r.kind] ?? 'nothing to move: split it into headed sections by topic first'}`)
      continue
    }
    // Inserts land after the frontmatter, past every range a move removes, so they go in first and
    // shift none of those ranges.
    const old = linesOf(r.text); let next = [...old]
    for (const mv of moves.filter((m) => m.insertAfter !== undefined)) next.splice(mv.insertAfter + 1, 0, ...mv.insert)
    for (const mv of [...moves].sort((a, b) => b.from - a.from)) next.splice(mv.from, mv.count, ...mv.replace)
    while (next.length && next.at(-1) === '') next.pop()
    for (const mv of moves) {
      const to = mv.target ? `${mv.target.kind} ${shown(mv.target.path, root, home)}` : 'the skill body, which loads only when it runs'
      proposals.push(`propose : ${shown(r.path, root, home)} · "${mv.heading}" (${mv.size} ${r.kind === 'skill' || r.kind === 'agent' ? 'chars' : 'lines'}) → ${to}`)
      if (mv.target) {
        const t = targets.get(mv.target.path) ?? { body: [] }
        t.body.push(...(t.body.length ? [''] : []), ...mv.target.body); targets.set(mv.target.path, t)
      }
    }
    diffs.push(...unifiedDiff(...label(r.path, root, home), old, next))
  }
  for (const [path, t] of targets) {
    const before = isFile(path) ? linesOf(readFileSync(path, 'utf8')) : null
    const after = before ? [...before, '', ...t.body] : t.body
    const [a, b] = label(path, root, home)
    diffs.push(...unifiedDiff(before ? a : '/dev/null', b, before ?? [], after))
  }
  out.push(...proposals)
  if (diffs.length) out.push('diff :', ...diffs)
  return out
}
