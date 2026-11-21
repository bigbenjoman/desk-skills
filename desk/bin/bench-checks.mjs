// The checks a merged PR added or changed in its hidden tests, and how many of them a run passed.
//
// A check is a call to a helper whose one-line definition prints FAIL (tests/run.sh's suites:
// `t('name', got, want)`, `check "name" '<test>'`), named by the string its call starts with. The PR's
// checks are those whose call, to its closing parenthesis, spans a line its test diff adds, changes or
// removes, from its base to its merge. tests/run.sh prints a `FAIL <name>` line per failing check and
// no line per passing one, under a `== <suite label>` heading, so a check passed when its suite ran to
// the end and printed no FAIL line naming it. A run where a check's suite crashed or is missing is
// not measured. Output from any other runner is not read: its checks are not measured.

const IDENT = '[A-Za-z_$][\\w$]*';
const DEFS = [
  new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})\\s*=\\s*(?:async\\s*)?(?:\\(|function\\b|${IDENT}\\s*=>)`),
  new RegExp(`\\bfunction\\s+(${IDENT})\\s*\\(`),
  /(?:^|[\s;:])([A-Za-z_]\w*)\s*\(\)\s*\{/,
];

// The check helpers defined on these lines: each whose definition line prints FAIL.
export function helpersIn(text) {
  const out = new Set();
  for (const line of String(text).split('\n')) {
    if (!/FAIL/.test(line)) continue;
    for (const re of DEFS) { const m = re.exec(line); if (m) { out.add(m[1]); break; } }
  }
  return out;
}

// `git diff -U0` text -> Map of path -> where its merge side changed: each added or changed line's
// number, and n + 0.5 for lines removed between merge lines n and n + 1.
export function changedAt(diff) {
  const out = new Map();
  let file = null;
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('+++ ')) { file = line === '+++ /dev/null' ? null : line.slice(4).replace(/^b\//, ''); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!file || !hunk) continue;
    const [from, count] = [Number(hunk[1]), hunk[2] === undefined ? 1 : Number(hunk[2])];
    const at = count ? Array.from({ length: count }, (_, i) => from + i) : [from + 0.5];
    out.set(file, [...(out.get(file) ?? []), ...at]);
  }
  return out;
}

// The last line (1-based) of the call whose `(` is at `lines[row][col]`: where its parentheses close,
// strings and line comments skipped. The call's own line when they never close.
function callEnd(lines, row, col) {
  let depth = 0, quote = null;
  for (let r = row; r < Math.min(lines.length, row + 200); r++) {
    const s = lines[r];
    for (let i = r === row ? col : 0; i < s.length; i++) {
      const ch = s[i];
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
      if (ch === '/' && s[i + 1] === '/') break;
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return r + 1;
    }
    if (quote !== '`') quote = null;
  }
  return row + 1;
}

// The last line (1-based) of the shell command starting on `lines[row]`: it runs on while a line
// ends in a backslash.
function shellEnd(lines, row) {
  let r = row;
  while (r + 1 < lines.length && /\\$/.test(lines[r])) r++;
  return r + 1;
}

// tests/run.sh's label for a suite: its first `# suite: ` or `// suite: ` line in the first ten,
// else its file name.
export function suiteLabel(text, file) {
  const line = String(text).split('\n').slice(0, 10).find((l) => /^(#|\/\/) suite: /.test(l));
  return line ? line.slice(line.indexOf(' suite: ') + 8) : file.split('/').pop();
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A quoted name -> the regex source its printed form matches: an interpolation matches anything.
// null when the name is nearly all interpolation, since it would match every check.
function namePattern(quote, body) {
  const interp = quote === "'" ? null : quote === '`' ? /\$\{[^}]*\}/g : /\$\{[^}]*\}|\$\w+/g;
  const parts = interp ? body.split(interp) : [body];
  const literal = parts.map((p) => p.replace(/\\(.)/g, '$1'));
  if (literal.join('').replace(/\s/g, '').length < 3) return null;
  return { name: literal.join('…'), pattern: literal.map(escape).join('.*?') };
}

// The checks the PR added or changed. `diff` is `git diff -U0 <base> <merge> -- <run files>`, `defs`
// the merge commit's lines that mention FAIL in those files' directories, `texts` each run file's
// text at the merge. -> { checks: [{ file, suite, name, pattern }], why? }
export function findChecks({ diff, defs, texts }) {
  const helpers = [...helpersIn(defs)];
  if (!helpers.length) return { checks: [], why: 'no check helper that prints FAIL is defined beside the hidden tests' };
  const call = new RegExp(`(^|[^\\w$.])(${helpers.map(escape).join('|')})(?:\\(\\s*|\\s+)(['"\`])((?:\\\\.|(?!\\3)[^\\\\])*)\\3`, 'g');
  const checks = [];
  const seen = new Set();
  for (const [file, at] of changedAt(diff)) {
    if (!Object.hasOwn(texts, file)) continue;
    const suite = suiteLabel(texts[file], file);
    const lines = String(texts[file]).split('\n');
    lines.forEach((line, row) => {
      for (const m of line.matchAll(call)) {
        const col = m.index + m[1].length + m[2].length;
        const end = line[col] === '(' ? callEnd(lines, row, col) : shellEnd(lines, row);
        if (!at.some((n) => n >= row + 1 && n <= end)) continue;
        const p = namePattern(m[3], m[4]);
        if (!p || seen.has(`${suite}\n${p.pattern}`)) continue;
        seen.add(`${suite}\n${p.pattern}`);
        checks.push({ file, suite, ...p });
      }
    });
  }
  return checks.length ? { checks } : { checks, why: 'no check the PR added or changed in its hidden tests calls a check helper with a quoted name' };
}

// Why a run's checks are not measured when its hidden tests stopped part way.
export const UNFINISHED = 'the hidden tests did not finish';

// tests/run.sh's trailers, and bench.mjs's `$ <command>` line, each printed after a blank line.
const TRAILER = /^(\$ |all passed: |FAILURES above|failed suites:|flaked:|over budget:)/;

// A run's test-output.log -> Map of suite label -> { ok, fails: [text], failed }: its passing checks
// (tests/run.sh's `ok: <n>`), its FAIL lines, and whether it failed (a non-zero exit, or no checks
// ran). Headings and trailers count only after a blank line, as tests/run.sh prints them, so a suite's
// own output cannot open or close a section. A retried suite's first run is skipped: its retry is
// what counted.
export function suiteSections(log) {
  const out = new Map();
  let cur = null, skipping = false, prev = '';
  for (const line of String(log).split('\n')) {
    const after = prev === '';
    prev = line;
    const head = after && /^== (.*)$/.exec(line);
    if (head) { cur = { ok: 0, fails: [], failed: false }; out.set(head[1], cur); skipping = false; continue; }
    if (!cur) continue;
    if (after && TRAILER.test(line)) { cur = null; continue; }
    if (line === '-- first run') { skipping = true; continue; }
    if (line === '-- retry') { skipping = false; continue; }
    if (skipping) continue;
    const ok = /^ok: (\d+)$/.exec(line);
    if (ok) cur.ok = Number(ok[1]);
    else if (/^FAIL /.test(line)) cur.fails.push(line.replace(/^FAIL +/, ''));
    else if (/^(exit [1-9]\d*|no checks ran)$/.test(line)) cur.failed = true;
  }
  return out;
}

// The checks each suite ran in a run where all of them passed (bench-build's run at the merge
// commit): suite label -> count.
export function suiteCounts(log) {
  return Object.fromEntries([...suiteSections(log)].map(([label, s]) => [label, s.ok]));
}

// How many of `added.checks` the run whose output is `log` passed. -> { passed, of } | { passed: null,
// of, why }. Not measured, never 0, when a check's suite is missing, or ran fewer checks than
// `added.suites` (suiteCounts) says it has, so stopped part way, or, with no count for it, failed
// naming no check.
export function tallyChecks(added, log) {
  const { checks, suites = {} } = added;
  const sections = suiteSections(log);
  const unread = (why) => ({ passed: null, of: checks.length, why });
  if (!sections.size) return unread('the test output has no tests/run.sh suite headings to read checks from');
  for (const label of new Set(checks.map((c) => c.suite))) {
    const s = sections.get(label);
    if (!s) return unread(`the test output has no section for suite ${label}`);
    const ran = s.ok + s.fails.length;
    if (Object.hasOwn(suites, label) ? ran < suites[label] : s.failed && !s.fails.length) {
      return unread(`${UNFINISHED}: suite ${label} ran ${ran} of its ${suites[label] ?? 'checks'}`);
    }
  }
  let passed = 0;
  for (const c of checks) {
    const re = new RegExp(`^${c.pattern}(?::|$)`);
    if (!sections.get(c.suite).fails.some((f) => re.test(f))) passed += 1;
  }
  return { passed, of: checks.length };
}
