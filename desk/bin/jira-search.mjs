// One `key in (...)` Jira search through desk-jira, shared by everything that asks Jira about many keys
// at once (digest.mjs doneParks, ticket-facts.mjs --blockers), so none asks once per key.
import { spawnSync } from 'node:child_process';

// Keys per search: Jira's largest page for a search returning fields.
export const KEY_CHUNK = 100;
const SEARCH_TIMEOUT_MS = 30 * 1000;

// One desk-jira search, one page, run from `cwd` with `env` (the current process's when left out),
// asking for `fields` beside desk-jira's own: {ok, issues} or {ok: false, why}. A page with more
// behind it read nothing about the keys past it, so it is a failure rather than a partial answer,
// unless `partial`, where the page is the answer and `more` says whether anything lies behind it.
export function jiraSearch({ cwd, env, partial = false } = {}, jql, max, fields = []) {
  const args = ['search', jql, String(max), ...(fields.length ? [`--fields=${fields.join(',')}`] : []), '--json'];
  const r = spawnSync('desk-jira', args, { cwd, env, encoding: 'utf8', timeout: SEARCH_TIMEOUT_MS, maxBuffer: 64 << 20 });
  const why = `${r.stderr ?? ''}${r.error?.message ?? ''}`.trim().split('\n').pop() || `desk-jira exited ${r.status ?? r.signal}`;
  if (r.status !== 0) return { ok: false, why };
  let res;
  try { res = JSON.parse(r.stdout); } catch { return { ok: false, why: 'desk-jira search did not return JSON' }; }
  if (!Array.isArray(res?.issues)) return { ok: false, why: `desk-jira search returned no issue list${res?.errorMessages?.length ? ` (${res.errorMessages.join('; ')})` : ''}` };
  if (partial) return { ok: true, issues: res.issues, more: !!res.nextPageToken };
  if (res.nextPageToken) return { ok: false, why: `Jira returned fewer than ${max} issues a page` };
  return { ok: true, issues: res.issues };
}

// `keys`' issues, one `key in (...)` search per KEY_CHUNK keys, each run as `search(jql, max)` (which
// answers as jiraSearch does): {ok, issues: Map of key to issue} or {ok: false, why}. Any search
// failing, or throwing, fails the whole read; a key Jira does not return is absent from the map.
export function keySearch(keys, search) {
  const issues = new Map();
  for (let i = 0; i < keys.length; i += KEY_CHUNK) {
    const chunk = keys.slice(i, i + KEY_CHUNK);
    let res;
    try { res = search(`key in (${chunk.join(', ')})`, chunk.length); } catch (e) { res = { ok: false, why: e.message }; }
    if (!res?.ok) return { ok: false, why: res?.why ?? 'the search failed' };
    for (const issue of res.issues) if (chunk.includes(issue?.key)) issues.set(issue.key, issue);
  }
  return { ok: true, issues };
}
