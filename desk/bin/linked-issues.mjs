#!/usr/bin/env node
// Closes the GitHub issues in this repo that a ticket's web links name, once every ticket linking each
// one is done, with a comment naming those tickets and their merged PRs. Run after a ticket goes to
// §4 Done state. Jira cannot search web-link URLs, so the tickets linking an issue are this one (its
// status read directly) plus a text search of the project for the issue's URL or #<n>, each confirmed
// by its own web links; a search with more hits than one page leaves the issue open. Where
// §3 gh-close-linked-issue is not yes, nothing is closed and the issue is named as ready to close.
// A ticket with no such link, or a repo with no Jira tracker, prints nothing.
//
//   linked-issues.mjs <TICKET> [--repo <owner/name>]   (the repo defaults to this one, §0 GitHub repo)
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { keyPattern } from './batch-state.mjs';

// The number of the issue a web link names in <repo> (owner/name), or null.
export function issueOf(url, repo) {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+\/[^/\s#?]+)\/issues\/(\d+)(?:[/#?]\S*)?$/i.exec(String(url ?? '').trim());
  return m && m[1].toLowerCase() === String(repo ?? '').toLowerCase() ? Number(m[2]) : null;
}
// The issues in <repo> a Jira remotelink list names, ascending, each once.
export const linkedIssues = (links, repo) => [...new Set((Array.isArray(links) ? links : [])
  .map((l) => issueOf(l?.object?.url, repo)).filter((n) => n != null))].sort((a, b) => a - b);

// The other tickets in <project> that may link issue <n>: any whose text names its URL or #<n>.
export const issueJql = (project, ticket, repo, n) =>
  `project = "${project}" AND key != ${ticket} AND (text ~ "\\"https://github.com/${repo}/issues/${n}\\"" OR text ~ "\\"#${n}\\"")`;
export const SEARCH_MAX = 100;

const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0, out: r.stdout ?? '', err: String(r.stderr || r.error?.message || '').trim() };
};
const why = (r) => r.err.split('\n').pop() || r.out.trim().split('\n').pop() || 'no output';
const parse = (r) => { try { return JSON.parse(r.out); } catch { return undefined; } };
const isDone = (fields, doneState) => fields?.status?.statusCategory?.key === 'done' || (!!doneState && fields?.status?.name === doneState);

// One line per issue the ticket links in <repo>: closed, ready to close, left open or not read. `run`
// is (cmd, args) -> {ok, out, err}; `perm` is §3 gh-close-linked-issue's value, or null when unset.
export function closeLinkedIssues({ ticket, repo, project, doneState, perm, run = sh }) {
  const linksOf = (key) => {
    const r = run('desk-jira', ['api', `api/2/issue/${key}/remotelink`]);
    const v = r.ok ? parse(r) : undefined;
    return Array.isArray(v) ? { links: v } : { why: r.ok ? 'not a list' : why(r) };
  };
  const own = linksOf(ticket);
  if (!own.links) return [`${ticket}: its web links could not be read (${own.why}), so no GitHub issue was checked`];
  const issuesHere = linkedIssues(own.links, repo);
  if (!issuesHere.length) return [];
  // The ticket's own status is read directly: a search straight after its move to Done can still
  // return the old status.
  const ownRead = run('desk-jira', ['api', `api/2/issue/${ticket}?fields=status`]);
  const ownFields = ownRead.ok ? parse(ownRead)?.fields : undefined;
  if (!ownFields?.status) return [`${ticket}: its status could not be read (${ownRead.ok ? 'no status' : why(ownRead)}), so no GitHub issue was checked`];
  const self = { key: ticket, done: isDone(ownFields, doneState), status: ownFields.status.name ?? 'unknown' };
  const lines = [];
  for (const n of issuesHere) {
    const ref = `${repo}#${n}`;
    const found = run('desk-jira', ['search', issueJql(project, ticket, repo, n), String(SEARCH_MAX), '--json']);
    const res = found.ok ? parse(found) : undefined;
    const issues = res?.issues;
    if (!Array.isArray(issues)) { lines.push(`${ref} left open: the tickets linking it could not be searched (${found.ok ? 'no issues list' : why(found)})`); continue; }
    if (res.nextPageToken || issues.length >= SEARCH_MAX) { lines.push(`${ref} left open: ${SEARCH_MAX} or more tickets mention it, so not every ticket linking it could be checked`); continue; }
    const linking = [self];
    let unread = null;
    for (const i of issues) {
      if (typeof i?.key !== 'string' || !E.SAFE_ID.test(i.key) || i.key === ticket) continue;
      const l = linksOf(i.key);
      if (!l.links) { unread = `${i.key}'s web links could not be read (${l.why})`; break; }
      if (!linkedIssues(l.links, repo).includes(n)) continue;
      linking.push({ key: i.key, done: isDone(i.fields, doneState), status: i.fields?.status?.name ?? 'unknown' });
    }
    if (unread) { lines.push(`${ref} left open: ${unread}`); continue; }
    const open = linking.filter((t) => !t.done);
    if (open.length) { lines.push(`${ref} left open: ${open.map((t) => `${t.key} is ${t.status}`).join(', ')}`); continue; }
    const state = run('gh', ['issue', 'view', String(n), '--repo', repo, '--json', 'state']);
    const st = state.ok ? parse(state)?.state : undefined;
    if (!st) { lines.push(`${ref} left open: its state could not be read (${state.ok ? 'no state' : why(state)})`); continue; }
    if (st !== 'OPEN') { lines.push(`${ref} already ${String(st).toLowerCase()}`); continue; }
    const named = linking.map((t) => t.key).sort().map((key) => {
      const r = run('gh', ['pr', 'list', '--repo', repo, '--state', 'merged', '--search', key, '--json', 'number,title,headRefName', '--limit', '30']);
      const prs = (r.ok ? parse(r) : null);
      if (!Array.isArray(prs)) return `${key} (merged PRs not read)`;
      const names = new RegExp(keyPattern(key));
      const ns = prs.filter((p) => names.test(`${p?.title ?? ''} ${p?.headRefName ?? ''}`)).map((p) => p.number).sort((a, b) => a - b);
      return `${key} (${ns.length ? ns.map((x) => `#${x}`).join(', ') : 'no merged PR'})`;
    });
    const comment = `Closed by desk: every ticket filed for this issue is done: ${named.join(', ')}.`;
    if (perm !== 'yes') {
      lines.push(`${ref} is ready to close (config §3 gh-close-linked-issue is ${perm ?? 'unset'}): gh issue close ${n} --repo ${repo} --comment '${comment}'`);
      continue;
    }
    const closed = run('gh', ['issue', 'close', String(n), '--repo', repo, '--comment', comment]);
    lines.push(closed.ok ? `${ref} closed: ${comment}` : `${ref} not closed: ${why(closed)} — close it by hand: gh issue close ${n} --repo ${repo} --comment '${comment}'`);
  }
  return lines;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--repo');
  const repo = at < 0 ? E.ghRepo() : args.splice(at, 2)[1];
  const [ticket] = args;
  if (!ticket || args.length > 1 || !E.SAFE_ID.test(ticket) || !/^[^/\s]+\/[^/\s]+$/.test(repo ?? '')) {
    console.error('usage: linked-issues.mjs <TICKET> [--repo <owner/name>]'); process.exit(2);
  }
  const tracker = String(E.configValue('tracker') ?? '').trim().toLowerCase();
  if (tracker !== 'jira' || E.ticketKind(ticket).kind !== 'tracker') process.exit(0);
  const project = E.configValue('jira-project');
  if (!project || E.isNone(project)) { console.error('linked-issues: config §4 Jira project is not set — run /desk-setup'); process.exit(2); }
  for (const line of closeLinkedIssues({ ticket, repo, project, doneState: E.configValue('done-state'), perm: E.permissionOrUnset('gh-close-linked-issue') })) {
    console.log(line);
  }
}
