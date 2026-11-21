// PR reads kept for one pass. Several steps of a pass read the same PR (its status, a park's clear, a
// hold, the undraft check, the base gate), each a gh call of about half a second, and a pass spends
// most of its time waiting on such calls. Every `gh pr view <n> --repo <r> --json <fields>` (with no other flag, or
// `--jq .<one field>` asking for that field alone) keeps the fields it read, by PR, and a later one
// whose fields were all read already is answered from them. A PR's body and comments are always read
// again: an upload or a ledger comment changes them without going through the pass's own runner. Any
// other command that may change a PR (a gh write, a push, a script) drops everything kept.

// Fields never answered from what was kept.
export const FRESH_PR_FIELDS = new Set(['body', 'comments']);
// The gh subcommands that only read.
const GH_READS = { pr: ['view', 'list', 'checks', 'diff', 'status'], run: ['view', 'list'], variable: ['list'], repo: ['view'] };
// Commands other than gh and git that never change a PR.
const NO_PR_WRITES = ['desk-jira', 'lsof', 'ps', 'claude'];

// The PR view `args` asks for -> { key, fields, jq } (jq: the one field a `--jq .<field>` prints), or
// null when it is not one this keeps.
export function prViewOf(args) {
  const [a, b, n, r, repo, j, fields, jq, path, ...rest] = args ?? [];
  if (a !== 'pr' || b !== 'view' || !/^\d+$/.test(String(n)) || r !== '--repo' || !repo || j !== '--json'
    || !/^[A-Za-z]+(,[A-Za-z]+)*$/.test(String(fields)) || rest.length) return null;
  const key = `${repo}#${n}`;
  if (jq === undefined) return { key, fields: fields.split(','), jq: null };
  const one = jq === '--jq' && path !== undefined && /^\.([A-Za-z]+)$/.exec(String(path));
  return one && fields === one[1] ? { key, fields: [one[1]], jq: one[1] } : null;
}

// Whether running `cmd args` may change what a PR read gives.
export function mayChangePr(cmd, args = []) {
  if (cmd === 'gh') {
    if (args[0] === 'api') {
      return args.some((x, i) => ((x === '-X' || x === '--method') && String(args[i + 1]).toUpperCase() !== 'GET')
        || /^--method=/.test(String(x)) && !/^--method=GET$/i.test(String(x)) || /\bmutation\b/.test(String(x)));
    }
    return !GH_READS[args[0]]?.includes(args[1]);
  }
  if (cmd === 'git') { const i = args[0] === '-C' ? 2 : 0; return args[i] === 'push'; }
  return !NO_PR_WRITES.includes(cmd);
}

// One pass's kept reads. `before(cmd, args)` -> what the read prints (a string) when it is a kept PR
// view answered from them, else undefined; `after(cmd, args, out)` keeps what a PR view printed once it
// succeeded; `clear()` drops everything.
export function prReads() {
  const kept = new Map();
  const answer = (p) => {
    const had = kept.get(p.key);
    if (!had || !p.fields.every((f) => !FRESH_PR_FIELDS.has(f) && had.fields.has(f))) return undefined;
    if (p.jq) return typeof had.v[p.jq] === 'string' ? had.v[p.jq] : undefined;
    return JSON.stringify(Object.fromEntries(p.fields.filter((f) => f in had.v).map((f) => [f, had.v[f]])));
  };
  const keep = (p, out) => {
    if (p.jq) return;
    let v; try { v = JSON.parse(out); } catch { return; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return;
    const had = kept.get(p.key) ?? { fields: new Set(), v: {} };
    for (const f of p.fields) { had.fields.add(f); if (f in v) had.v[f] = v[f]; else delete had.v[f]; }
    kept.set(p.key, had);
  };
  return {
    // Before running: the kept answer, or undefined (and, for a command that may change a PR, nothing is kept after it).
    before(cmd, args) {
      const p = cmd === 'gh' ? prViewOf(args) : null;
      if (p) return answer(p);
      if (mayChangePr(cmd, args)) kept.clear();
      return undefined;
    },
    // After a command succeeded with `out`.
    after(cmd, args, out) {
      const p = cmd === 'gh' ? prViewOf(args) : null;
      if (p) keep(p, out);
    },
    clear: () => kept.clear(),
    get size() { return kept.size; },
  };
}
