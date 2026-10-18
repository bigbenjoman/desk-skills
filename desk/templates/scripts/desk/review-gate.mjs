#!/usr/bin/env node
// The checks .github/workflows/desk-gate.yml runs on a pull request. Copied into a repo by
// /desk-setup; it needs nothing but Node 20 (global fetch) and, for claude-md, a checkout.
//
//   node scripts/desk/review-gate.mjs verdict     the PR's latest desk-review verdict is clean at its head
//   node scripts/desk/review-gate.mjs claude-md   no tracked CLAUDE.md is over 20,000 characters
//   node scripts/desk/review-gate.mjs approval    a PR touching $PROTECTED has an approval at its head,
//                                                 unless it is a small fix, docs or chore change
//
// Reads GH_TOKEN, REPO (owner/name), PR and HEAD_SHA from the environment. Exits 1 with an
// ::error:: line naming the reason, 0 with a ::notice:: line otherwise.
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LOCAL_MARKER = '<!-- desk-review:local -->';
const VERDICT = new RegExp(
  '^<!--\\s*desk-review:verdict\\s+v=1\\s+sha=(?<sha>[0-9a-f]{7,40})' +
    '\\s+p0=(?<p0>\\d+)\\s+p1=(?<p1>\\d+)\\s+p2=(?<p2>\\d+)\\s+deferred=(?<deferred>\\d+)' +
    '\\s+gaps=(?<gaps>\\d+)\\s+unrefuted=(?<unrefuted>\\d+)\\s+partial=(?<partial>\\d+)' +
    '\\s+vendor=(?<vendor>[a-z-]+)\\s+round=(?<round>\\d+)\\s*-->$',
);
export const COUNTS = ['p0', 'p1', 'p2', 'deferred', 'gaps', 'unrefuted', 'partial'];
// Only someone who can push to the repo can attest a review or approve one: on a public repo anyone
// can post a review. `writers` below is the set of logins main() confirmed have write access, read
// from the permission endpoint; author_association cannot say it (MEMBER is any org member, read
// access included).

// The verdict a review body carries, with the visible heading (its first non-blank line after the
// markers), or null. A desk-review:reply or any body not opening with the local marker has none.
export function parseVerdict(body) {
  const lines = (body || '').split(/\r?\n/);
  if (lines[0].trim() !== LOCAL_MARKER) return null;
  const m = VERDICT.exec((lines[1] || '').trim());
  if (!m) return null;
  const v = { ...m.groups };
  for (const k of [...COUNTS, 'round']) v[k] = Number(v[k]);
  v.heading = lines.slice(2).map((l) => l.trim()).find((l) => l) || '';
  return v;
}

// The heading is what a person reads and the marker what this gate reads, so the two must not say
// different things. desk-review writes the heading freehand, so this checks what it states rather
// than one fixed form: findings, a SHA or a round a clean marker contradicts.
export function headingMismatch(v) {
  if (!v.heading) return 'the review has no visible heading under its markers';
  const listed = v.heading.match(/\b[1-9]\d* (?:P0|P1|P2|deferred)\b/);
  if (listed) return `its heading lists "${listed[0]}" while the marker reads clean`;
  for (const [, sha] of v.heading.matchAll(/`([0-9a-f]{7,40})`/g)) {
    if (!v.sha.startsWith(sha)) return `its heading names ${sha} but the marker attests ${v.sha.slice(0, 9)}`;
  }
  const round = v.heading.match(/\bround (\d+)\b/i);
  if (round && Number(round[1]) !== v.round) {
    return `its heading says round ${round[1]} but the marker says ${v.round}`;
  }
  return null;
}

// reviews: the REST list, oldest first. Returns { ok, message }. Only the latest verdict counts: an
// older clean one never stands in for a newer dirty one, and a head with none is not reviewed.
export function checkVerdict(reviews, head, writers, { vendor = '' } = {}) {
  const verdicts = reviews
    .filter((r) => writers.has(r.user?.login))
    .map((r) => parseVerdict(r.body))
    .filter(Boolean);
  if (!verdicts.length) {
    return { ok: false, message: `No desk-review verdict on this PR. Run /desk-review and post it.` };
  }
  const v = verdicts[verdicts.length - 1];
  const at = v.sha.slice(0, 9);
  if (v.sha !== head) {
    return { ok: false, message: `The latest desk-review verdict is at ${at}, not the head ${head.slice(0, 9)}. Review this head.` };
  }
  const dirty = COUNTS.filter((k) => v[k] !== 0).map((k) => `${k}=${v[k]}`);
  if (dirty.length) return { ok: false, message: `The desk-review verdict at ${at} is not clean: ${dirty.join(' ')}.` };
  if (vendor && v.vendor !== vendor) {
    return { ok: false, message: `The desk-review verdict at ${at} was refuted ${v.vendor}, and this gate needs ${vendor}.` };
  }
  const bad = headingMismatch(v);
  if (bad) return { ok: false, message: `The desk-review review at ${at} disagrees with its own verdict: ${bad}.` };
  return { ok: true, message: `desk-review clean at ${at}, round ${v.round}, ${v.vendor}.` };
}

export const CLAUDE_MD_LIMIT = 20000;

// files: [{ path, text }]. Characters, not bytes: the limit is the reviewer's loader's.
export function checkClaudeMd(files, limit = CLAUDE_MD_LIMIT) {
  const over = files
    .map((f) => ({ path: f.path, chars: [...f.text].length }))
    .filter((f) => f.chars > limit);
  if (!over.length) return { ok: true, message: `${files.length} CLAUDE.md file(s), none over ${limit} characters.` };
  return {
    ok: false,
    message: over
      .map((f) => `${f.path} is ${f.chars} characters, over the ${limit} the reviewer loads; the rest is dropped. ` +
        'Split it: move sections into files it imports with @path, or into a CLAUDE.md in the directory they cover.')
      .join(' '),
  };
}

// The pull-request title's conventional-commit type, and whether it merges without an approval.
export const TITLE_TYPE = /^[a-z]+(\([a-z0-9./_-]+\))?!?:/;
export function titleType(title) {
  const m = TITLE_TYPE.exec(title || '');
  return m ? m[0] : '';
}
export function exemptType(type, exemptTypes) {
  return new RegExp(`^(${exemptTypes})(\\([a-z0-9./_-]+\\))?:$`).test(type);
}

// The review states that set where a reviewer stands; a later COMMENTED review changes nothing.
const DECIDING = ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'];

// pr: { title, author, head }; files: [{ filename, previous_filename?, additions, deletions }];
// reviews: REST list; writers: as checkVerdict. env: { protected, generated, fileLimit,
// exemptTypes } as the workflow sets them.
export function checkApproval(pr, files, reviews, writers, env) {
  if (!env.protected) return { ok: true, message: 'No protected paths are set (PROTECTED is empty). No approval needed.' };
  const prot = new RegExp(env.protected);
  const gen = new RegExp(env.generated);
  const counted = files.filter((f) => !gen.test(f.filename));
  const lines = counted.reduce((n, f) => n + f.additions + f.deletions, 0);
  // A rename's old path counts too, or moving a file out of a protected path needs no one.
  const touched = files.flatMap((f) => [f.filename, f.previous_filename]).filter((p) => p && prot.test(p));
  if (!touched.length) return { ok: true, message: `${counted.length} changed files, no protected path touched. No approval needed.` };

  const type = titleType(pr.title);
  const reasons = [];
  if (!exemptType(type, env.exemptTypes)) {
    reasons.push(`a \`${type || 'untyped'}\` title, and only ${env.exemptTypes.split('|').join(', ')} merge without an approval`);
  }
  if (counted.length > env.fileLimit) {
    reasons.push(`**${counted.length}** changed files, over the ${env.fileLimit}-file limit (${lines} lines)`);
  }
  const named = touched.slice(0, 5).map((p) => `\`${p}\``).join(', ');
  if (!reasons.length) {
    return { ok: true, message: `A \`${type}\` change of ${counted.length} files touching ${named}. Small enough to need no approval.` };
  }

  // An approval counts only at the exact head: a push after it voids it, or a PR could be approved
  // while benign and then loosen the very regex that judges it. The author never counts.
  const last = new Map();
  for (const r of reviews) {
    if (r.user?.login === pr.author || !writers.has(r.user?.login)) continue;
    if (DECIDING.includes(r.state)) last.set(r.user.login, r);
  }
  const approvals = [...last.values()].filter((r) => r.state === 'APPROVED');
  const atHead = approvals.find((r) => r.commit_id === pr.head);
  const why = `It touches ${named}${touched.length > 5 ? ` and ${touched.length - 5} more` : ''} with ${reasons.join('; ')}.`;
  if (atHead) return { ok: true, message: `${why} Approved at the head by ${atHead.user.login}.` };
  const stale = approvals.length ? ` ${approvals.map((r) => r.user.login).join(', ')} approved an earlier commit; it needs approving again at this head.` : '';
  return { ok: false, message: `${why} One approval at the head from someone with write access clears it.${stale}` };
}

// missing: what a 404 returns instead of failing, for a lookup where "not found" is an answer.
async function api(path, missing) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`https://api.github.com/${path}${sep}per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    });
    if (res.status === 404 && missing !== undefined) return missing;
    // Never read a failed call as "no reviews": that reports a token problem as the author's omission.
    if (!res.ok) throw new Error(`GET ${path} returned ${res.status}: an API or token failure, not a missing review`);
    const body = await res.json();
    if (!Array.isArray(body)) return body;
    out.push(...body);
    if (body.length < 100) return out;
  }
}

function report({ ok, message }) {
  console.log(`${ok ? '::notice::' : '::error::'}${message}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  process.exitCode = ok ? 0 : 1;
}

// The logins among these reviews' authors who can push to REPO. The permission endpoint maps
// maintain to write, so admin and write are every role that can.
async function writersOf(reviews) {
  const writers = new Set();
  for (const login of new Set(reviews.map((r) => r.user?.login).filter(Boolean))) {
    // A login that is no collaborator 404s: not a writer, never a reason to fail the run.
    const p = await api(`repos/${process.env.REPO}/collaborators/${encodeURIComponent(login)}/permission`, {});
    if (['admin', 'write'].includes(p.permission)) writers.add(login);
  }
  return writers;
}

async function main(mode) {
  const { REPO, PR, HEAD_SHA } = process.env;
  const pulls = `repos/${REPO}/pulls/${PR}`;
  if (mode === 'verdict') {
    const reviews = (await api(`${pulls}/reviews`)).filter((r) => parseVerdict(r.body));
    return report(checkVerdict(reviews, HEAD_SHA, await writersOf(reviews), { vendor: process.env.REQUIRE_VENDOR || '' }));
  }
  if (mode === 'claude-md') {
    const paths = execFileSync('git', ['ls-files', '-z', '--', 'CLAUDE.md', '**/CLAUDE.md'], { encoding: 'utf8' })
      .split('\0').filter(Boolean);
    return report(checkClaudeMd(paths.map((path) => ({ path, text: readFileSync(path, 'utf8') }))));
  }
  if (mode === 'approval') {
    // The title is read live: a pull_request_review run carries it as it stood when the event fired.
    const pr = await api(pulls);
    const reviews = (await api(`${pulls}/reviews`)).filter((r) => DECIDING.includes(r.state));
    return report(checkApproval(
      { title: pr.title, author: pr.user.login, head: HEAD_SHA },
      await api(`${pulls}/files`),
      reviews,
      await writersOf(reviews),
      {
        protected: process.env.PROTECTED || '',
        generated: process.env.GENERATED,
        fileLimit: Number(process.env.FILE_LIMIT),
        exemptTypes: process.env.EXEMPT_TYPES,
      },
    ));
  }
  console.error('usage: review-gate.mjs verdict | claude-md | approval');
  process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((e) => { console.log(`::error::${e.message}`); process.exitCode = 1; });
}
