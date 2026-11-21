// The checks a merged PR added or changed in its hidden tests, and how many of them a run passed.
//
// A check is a call to a helper whose one-line definition prints FAIL (tests/run.sh's suites:
// `t('name', got, want)`, `check "name" '<test>'`), named by the string its call starts with. The PR's
// checks are those whose call is on a line its test diff adds or changes, from its base to its merge.
// tests/run.sh prints a `FAIL <name>` line per failing check and no line per passing one, under a
// `== <suite label>` heading, so a check passed when its suite ran, printed no FAIL line naming it,
// and did not fail without naming any check (a crash). Output from any other runner is not read:
// its checks are not measured.

const IDENT = '[A-Za-z_$][\\w$]*';
const DEFS = [
  new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})\\s*=\\s*(?:async\\s*)?(?:\\(|function\\b|${IDENT}\\s*=>)`),
  new RegExp(`\\bfunction\\s+(${IDENT})\\s*\\(`),
  /^\s*([A-Za-z_]\w*)\s*\(\)\s*\{/,
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

// `git diff -U0` text -> Map of path -> the lines its merge side adds or changes.
export function addedLines(diff) {
  const out = new Map();
  let file = null;
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('+++ ')) { file = line === '+++ /dev/null' ? null : line.slice(4).replace(/^b\//, ''); continue; }
    if (file && line.startsWith('+')) out.set(file, [...(out.get(file) ?? []), line.slice(1)]);
  }
  return out;
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
  const call = new RegExp(`(?:^|[^\\w$.])(?:${helpers.map(escape).join('|')})(?:\\(\\s*|\\s+)(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`, 'g');
  const checks = [];
  const seen = new Set();
  for (const [file, lines] of addedLines(diff)) {
    if (!Object.hasOwn(texts, file)) continue;
    const suite = suiteLabel(texts[file], file);
    for (const line of lines) {
      for (const m of line.matchAll(call)) {
        const p = namePattern(m[1], m[2]);
        if (!p || seen.has(`${suite}\n${p.pattern}`)) continue;
        seen.add(`${suite}\n${p.pattern}`);
        checks.push({ file, suite, ...p });
      }
    }
  }
  return checks.length ? { checks } : { checks, why: 'no line the PR added or changed in its hidden tests calls a check helper with a quoted name' };
}

const TRAILER = /^(\$ |all passed: |FAILURES above|failed suites:|flaked:|over budget:)/;

// A run's test-output.log -> Map of suite label -> { fails: [text], crashed }. A retried suite's first
// run is skipped: its retry is what counted.
export function suiteSections(log) {
  const out = new Map();
  let cur = null, skipping = false;
  for (const line of String(log).split('\n')) {
    const head = /^== (.*)$/.exec(line);
    if (head) { cur = { fails: [], why: false }; out.set(head[1], cur); skipping = false; continue; }
    if (!cur) continue;
    if (TRAILER.test(line)) { cur = null; continue; }
    if (line === '-- first run') { skipping = true; continue; }
    if (line === '-- retry') { skipping = false; continue; }
    if (skipping) continue;
    if (/^FAIL /.test(line)) cur.fails.push(line.replace(/^FAIL +/, ''));
    else if (/^(exit [1-9]\d*|no checks ran)$/.test(line)) cur.why = true;
  }
  for (const s of out.values()) { s.crashed = s.why && !s.fails.length; delete s.why; }
  return out;
}

// How many of `checks` the run whose output is `log` passed. -> { passed, of } | { passed: null, of, why }
export function tallyChecks(checks, log) {
  const sections = suiteSections(log);
  if (!sections.size) return { passed: null, of: checks.length, why: 'the test output has no tests/run.sh suite headings to read checks from' };
  let passed = 0;
  for (const c of checks) {
    const s = sections.get(c.suite);
    const re = new RegExp(`^${c.pattern}(?::|$)`);
    if (s && !s.crashed && !s.fails.some((f) => re.test(f))) passed += 1;
  }
  return { passed, of: checks.length };
}
