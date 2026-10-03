#!/usr/bin/env node
// Read the facts plan-batch needs from Jira once, deterministically, and merge them into the ticket's
// triage record ($DESK_STATE/triage/<KEY>.json). Run by triage.sh after the model has written it, so
// plan-batch never needs the network and never takes a link from a model's summary.
//
//   ticket-facts.mjs <KEY>
//
// Adds, for a tracker key:
//   blockers     [{key, category}] — "is blocked by" (Blocks) links, with the blocker's status category
//   other_links  how many links of another type (not Blocks, not Relates) were ignored
//   size         XS|S|M|L|XL from the field named "Size", else a first description line "Size: M", else null
// or, when the read fails, facts_error instead (and no blockers), which plan-batch turns into a
// question: an unread link list must never read as "no blockers".
// A key that is not a tracker key gets links: "n/a".
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { stateDir, ticketKind } from './desk-env.mjs';

const key = process.argv[2];
const kind = ticketKind(key);
if (!kind.ok) { console.error(kind.error); process.exit(2); }
const path = join(stateDir(), 'triage', `${key}.json`);
if (!existsSync(path)) { console.error(`no triage record at ${path}`); process.exit(1); }
const rec = JSON.parse(readFileSync(path, 'utf8'));
for (const f of ['blockers', 'other_links', 'size', 'facts_error', 'links']) delete rec[f];

const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const asSize = (v) => {
  const s = String((v && typeof v === 'object' ? v.value ?? v.name : v) ?? '').trim().toUpperCase();
  return SIZES.includes(s) ? s : null;
};

if (kind.kind !== 'tracker') {
  rec.links = 'n/a';
} else {
  let issue = null;
  try {
    issue = JSON.parse(execFileSync('desk-jira', ['get', key, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }));
  } catch (e) {
    rec.facts_error = String(e.stderr ?? e.message ?? e).trim().split('\n').pop() || 'desk-jira get failed';
  }
  if (issue) {
    const links = issue.fields?.issuelinks ?? [];
    rec.blockers = links
      .filter((l) => l.inwardIssue && /blocked by/i.test(l.type?.inward ?? ''))
      .map((l) => ({ key: l.inwardIssue.key, category: l.inwardIssue.fields?.status?.statusCategory?.key ?? 'new' }));
    rec.other_links = links.filter((l) => !/block/i.test(l.type?.name ?? '') && !/^relates$/i.test(l.type?.name ?? '')).length;
    const sizeField = Object.entries(issue.names ?? {}).find(([, n]) => /^(t-shirt )?size$/i.test(String(n).trim()))?.[0];
    const firstLine = String(issue.fields?.description ?? '').split('\n').find((l) => l.trim()) ?? '';
    rec.size = (sizeField && asSize(issue.fields?.[sizeField]))
      ?? asSize(/^\s*\**size\**\s*:\s*\**\s*([a-z]+)/i.exec(firstLine)?.[1]);
  }
}

writeFileSync(path, `${JSON.stringify(rec, null, 2)}\n`);
console.log(`[facts] ${key}  ${rec.links === 'n/a' ? 'links n/a'
  : rec.facts_error ? `NOT READ: ${rec.facts_error}`
  : `blocked by ${rec.blockers.map((b) => b.key).join(', ') || 'nothing'}  size ${rec.size ?? '-'}`}`);
