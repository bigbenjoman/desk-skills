#!/usr/bin/env node
// Read-only `gh api`, for workers, whose settings deny `gh api` in every form because a GET cannot be
// told from a write by prefix. This parses the arguments instead and runs `gh api` only when they
// cannot write:
//
//   desk-gh read <endpoint> [flags]            a REST GET; fields only with `-X GET` (else gh POSTs)
//   desk-gh read graphql -f query='<query>'    a GraphQL query; a mutation or subscription is refused
//
// Refused with exit 1: any method but GET, a mutation or subscription, `--input`, a field read from a
// file (`-F k=@path`), a method-override header, and any flag not listed in FLAGS. Usage is exit 2;
// otherwise gh's own exit status.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// gh api's flags that cannot write, and whether each takes a value.
const FLAGS = {
  '-X': true, '--method': true, '-f': true, '--raw-field': true, '-F': true, '--field': true,
  '-H': true, '--header': true, '-q': true, '--jq': true, '-t': true, '--template': true,
  '-p': true, '--preview': true, '--cache': true, '--hostname': true,
  '-i': false, '--include': false, '--paginate': false, '--slurp': false, '--silent': false,
};
const FIELD = new Set(['-f', '--raw-field', '-F', '--field']);

// The top-level operation keywords of a GraphQL document, strings and comments aside.
export function operations(query) {
  const text = String(query).replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|#[^\n]*/g, ' ');
  const ops = [];
  let depth = 0;
  for (const m of text.matchAll(/[{}()]|[_A-Za-z][_0-9A-Za-z]*/g)) {
    const w = m[0];
    if (w === '{' || w === '(') depth++;
    else if (w === '}' || w === ')') depth--;
    else if (depth === 0 && ['query', 'mutation', 'subscription'].includes(w)) ops.push(w);
  }
  return ops;
}

// -> null when `gh api <args>` only reads, else why not.
export function refusal(args) {
  let endpoint = null;
  let method = null;
  const fields = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-') || a === '-') {
      if (endpoint != null) return `a second endpoint "${a}"`;
      endpoint = a;
      continue;
    }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (!(flag in FLAGS)) return `${flag} is not a read-only gh api flag`;
    if (!FLAGS[flag]) { if (eq > 0) return `${flag} takes no value`; continue; }
    const value = eq > 0 ? a.slice(eq + 1) : args[++i];
    if (value == null) return `${flag} needs a value`;
    if (flag === '-X' || flag === '--method') method = value.toUpperCase();
    else if (flag === '-H' || flag === '--header') { if (/^\s*x-http-method-override\s*:/i.test(value)) return 'a method-override header'; }
    else if (FIELD.has(flag)) {
      const k = value.indexOf('=');
      if (k < 1) return `${flag} "${value}" is not key=value`;
      if ((flag === '-F' || flag === '--field') && value.slice(k + 1).startsWith('@')) return `${flag} reads a file`;
      fields.push([value.slice(0, k), value.slice(k + 1)]);
    }
  }
  if (!endpoint) return 'no endpoint';
  if (method && method !== 'GET') return `method ${method}`;
  if (/graphql/i.test(endpoint)) {
    if (endpoint !== 'graphql') return `endpoint "${endpoint}": write it as graphql`;
    if (method) return 'a method for graphql';
    const query = fields.filter(([k]) => k === 'query');
    if (query.length !== 1) return 'graphql needs exactly one query field';
    const ops = operations(query[0][1]);
    const write = ops.find((o) => o !== 'query');
    if (write) return `a GraphQL ${write}`;
    return null;
  }
  if (fields.length && method !== 'GET') return 'fields without -X GET (gh would POST them)';
  return null;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd !== 'read' || !args.length) {
    console.error('usage: desk-gh read <endpoint> [gh api flags]   (read-only gh api: GET, or a graphql query)');
    process.exit(2);
  }
  const why = refusal(args);
  if (why) {
    console.error(`desk-gh: refused, not read-only: ${why}`);
    process.exit(1);
  }
  const r = spawnSync('gh', ['api', ...args], { stdio: 'inherit' });
  if (r.error) { console.error(`desk-gh: ${r.error.message}`); process.exit(1); }
  process.exit(r.status ?? 1);
}
