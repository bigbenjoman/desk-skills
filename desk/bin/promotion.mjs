// The daily promotion window: going to production is asked once a day, in the last check-in slot,
// as one question per repo covering everything merged to the default branch since config §4
// "Promotion ref", with a staging-check page listing what each PR leaves a person to look at. A
// merged fix for a production breakage is asked at once (urgentPromotion). Skills never deploy
// production: a "go" is recorded in the batch notes, and the repo's own promotion steps are the person's.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import * as E from './desk-env.mjs';

// A PR title or body line that starts this way is a fix for a live production breakage.
export const PRODUCTION_BROKEN = /^\s*production broken\b/i;
const FULL_SHA = /^[0-9a-f]{40}$/;

// The check-in slot that carries the promotion question: the day's last.
export const promotionSlot = (times, slotId) => !!slotId && slotId.slice(11) === [...times].sort().at(-1);

// The §4 row, as desk-env reads it (null when unset): {ref} or {why} when there is nothing to promote
// from. A remote branch must be a production branch by desk's one test of that.
export function promotionRef(raw) {
  if (raw == null) return { why: 'config §4 "Promotion ref" is unset' };
  if (E.isNone(raw)) return { why: 'config §4 "Promotion ref" is none' };
  const ref = String(raw).trim();
  const branch = /^origin\/(.+)$/.exec(ref)?.[1];
  if (branch && !E.PRODUCTION_BRANCH.test(branch)) return { why: `config §4 "Promotion ref" \`${ref}\` is not a production branch (production, prod or release)` };
  return { ref };
}

// `git log --first-parent --format=%H%x09%s` lines, oldest first, as {prs, loose}: the PR numbers
// merged (a merge commit reads "Merge pull request #N from …", a squash "<title> (#N)") and every
// commit naming no PR, as a rebase merge or a direct push lands.
export function rangeCommits(log) {
  const prs = [];
  const loose = [];
  for (const line of String(log ?? '').split('\n').filter(Boolean).reverse()) {
    const [sha, ...rest] = line.split('\t');
    const subject = rest.join('\t');
    const n = /^Merge pull request #(\d+)\b/.exec(subject)?.[1] ?? /\(#(\d+)\)\s*$/.exec(subject)?.[1];
    if (!n) loose.push({ sha, subject });
    else if (!prs.includes(Number(n))) prs.push(Number(n));
  }
  return { prs, loose };
}

// What a PR body's Testing section leaves to a person: its unchecked task items (desk-pr).
export function personSteps(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  const from = lines.findIndex((l) => /^#{2,3}\s+Testing\b/i.test(l.trim()));
  if (from < 0) return [];
  const steps = [];
  for (const l of lines.slice(from + 1)) {
    if (/^#{1,3}\s/.test(l.trim()) || l.trim() === '<!-- desk-pr: end -->') break;
    const m = /^\s*[-*]\s+\[ \]\s+(.+)$/.exec(l);
    if (m) steps.push(m[1].trim());
  }
  return steps;
}

export const isProductionBroken = (pr) => [pr.title, ...String(pr.body ?? '').split(/\r?\n/)].some((l) => PRODUCTION_BROKEN.test(l ?? ''));

// The staging-check page, as markdown. A PR whose body could not be read is never filed under
// "Nothing to look at": nobody knows what it leaves.
export function renderStagingPage({ slug, ref, range, prs, loose = [], staging }) {
  const where = staging?.length && !E.isNone(staging) ? staging : null;
  const tag = (p) => (p.broken ? ' (production broken)' : '');
  const link = (p) => `[#${p.number} ${p.title}](${p.url})`;
  const look = prs.filter((p) => !p.unread && p.steps.length);
  const nothing = prs.filter((p) => !p.unread && !p.steps.length);
  const unread = prs.filter((p) => p.unread);
  const lines = [`# Staging check: ${slug}`, '',
    `${prs.length} PR(s)${loose.length ? ` and ${loose.length} commit(s) with no PR` : ''} merged since \`${ref}\`, \`${range.from.slice(0, 7)}..${range.to.slice(0, 7)}\`. ` +
    `Check them on ${where ? where.map((s) => `\`${s}\``).join(', ') : 'staging (config §4 "Staging" is unset)'}.`, ''];
  if (look.length) {
    lines.push('## To look at', '');
    for (const p of look) {
      lines.push(`### ${link(p)}${tag(p)}`, '');
      for (const s of p.steps) lines.push(`- [ ] ${s}`);
      lines.push('');
    }
  }
  if (unread.length) {
    lines.push('## Not read', '', 'Their PR bodies could not be read: check each one\'s Testing section by hand.', '');
    for (const p of unread) lines.push(`- [ ] ${link(p)}`);
    lines.push('');
  }
  if (loose.length) {
    lines.push('## Commits with no PR', '');
    for (const c of loose) lines.push(`- [ ] \`${c.sha.slice(0, 7)}\` ${c.subject}`);
    lines.push('');
  }
  if (nothing.length) {
    lines.push('## Nothing to look at', '', 'Their Testing sections leave no steps to a person.', '');
    for (const p of nothing) lines.push(`- ${link(p)}${tag(p)}`);
    lines.push('');
  }
  return lines.join('\n');
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// One repo's promotion: {why} when it has no Promotion ref or the range cannot be read, {empty: true}
// when nothing landed since it, else {range, prs, loose, fetched, page}. `exec` runs git and gh.
export function promotionFor({ slug, root, ghRepo, def, ref: raw, staging, exec = run }) {
  const r = promotionRef(raw);
  if (r.why) return { why: r.why };
  const git = (...a) => exec('git', ['-C', root, ...a]);
  let fetched = true;
  try { git('fetch', '-q', 'origin'); } catch { fetched = false; }
  let from, to, log;
  try {
    from = git('rev-parse', '--verify', `${r.ref}^{commit}`);
    to = git('rev-parse', '--verify', `origin/${def}^{commit}`);
    log = git('log', '--first-parent', '--format=%H%x09%s', `${from}..${to}`);
  } catch (e) {
    return { why: `config §4 "Promotion ref" \`${r.ref}\` or \`origin/${def}\` does not resolve in ${root}: ${String(e.stderr ?? e.message).trim().split('\n')[0]}` };
  }
  if (!FULL_SHA.test(from) || !FULL_SHA.test(to)) return { why: `could not read the range ${r.ref}..origin/${def} in ${root}` };
  const c = rangeCommits(log);
  if (!c.prs.length && !c.loose.length) return { empty: true };
  const prs = c.prs.map((n) => {
    let v = null;
    try { v = JSON.parse(exec('gh', ['pr', 'view', String(n), '--repo', ghRepo, '--json', 'number,title,url,body'])); } catch { /* listed as not read */ }
    if (!v?.url) return { number: n, title: '(not read)', url: `https://github.com/${ghRepo}/pull/${n}`, steps: [], broken: false, unread: true };
    return { number: n, title: v.title, url: v.url, steps: personSteps(v.body), broken: isProductionBroken(v), unread: false };
  });
  const range = { from, to };
  return { range, prs, loose: c.loose, fetched, page: renderStagingPage({ slug, ref: r.ref, range, prs, loose: c.loose, staging }) };
}

// A repo's promotion inputs from its own config, for the digest, which reads every repo's.
export function promotionInputs(slug) {
  const v = (id) => E.repoConfigValue(slug, id);
  return { slug, root: E.expandHome(v('repo-root')), ghRepo: v('gh-repo'), def: v('default-branch') ?? 'main', ref: v('promotion-ref'), staging: E.repoConfigValues(slug, 'staging') };
}

const stateFile = (state) => join(state, 'promotion.json');
export const readPromotionState = (state) => { try { return JSON.parse(readFileSync(stateFile(state), 'utf8')); } catch { return {}; } };
const updatePromotionState = (state, change) => {
  mkdirSync(state, { recursive: true });
  writeFileSync(stateFile(state), `${JSON.stringify({ ...readPromotionState(state), ...change }, null, 2)}\n`);
};

// Writes a promotion's page beside the digest's and returns its question.
export function promotionQuestion({ slug, p, dir, name }) {
  const page = join(dir, `${name}-${slug}-staging.md`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(page, p.page);
  const range = `${p.range.from.slice(0, 12)}..${p.range.to.slice(0, 12)}`;
  return { key: `promotion:${slug}:${p.range.to}`, range, page, count: p.prs.length + p.loose.length };
}

// The range a question offered, so a "go" given with short SHAs is written out in full. The evening
// question covers any urgent one still carried, so that one stops being pushed.
export const recordOffered = (state, range) => updatePromotionState(state, { offered: range, urgent_push: null });

// A "go" for a range: recorded in the batch notes. Promoting is the repo's own process, run by the
// person as today.
export function approve({ slug, state, range, by, now = new Date() }) {
  const m = /^([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})$/.exec(String(range ?? ''));
  if (!m) return { ok: false, why: `'${range}' is not a <from>..<to> commit range` };
  const offered = readPromotionState(state).offered;
  const to = offered?.to?.startsWith(m[2]) ? offered.to : m[2];
  const from = offered?.from?.startsWith(m[1]) ? offered.from : m[1];
  appendFileSync(join(state, 'batch-notes.md'), `- [promotion] ${now.toISOString()} ${by} approved promoting ${slug} \`${from}..${to}\` to production. Run this repo's own promotion steps; skills never deploy production.\n`);
  updatePromotionState(state, { urgent_push: null });
  return { ok: true, from, to };
}

// Pushed between check-ins: the promotion question for a range holding a merged production-broken
// fix. The range is read only when `merged` (the batch's merged PR numbers) holds one no pass has
// read, so a quiet pass makes no network call. A PR is read once its body was read, or once a fetched
// range does not hold it (it merged into a batch base); anything else is read again next pass. The
// push is carried on every pass until the evening question or a "go", as the digest's is, so a
// notification that failed goes out again. Returns {push, page} or null.
export function urgentPromotion({ inputs, state, dir, merged = [], now = new Date(), exec = run }) {
  if (promotionRef(inputs.ref).why) return null;
  const s = readPromotionState(state);
  const carried = s.urgent_push ? { push: s.urgent_push, page: null } : null;
  const read = s.seen ?? [];
  const unread = merged.filter((n) => !read.includes(n));
  if (!unread.length) return carried;
  const p = promotionFor({ ...inputs, exec });
  if (p.why) return carried;
  const prs = p.prs ?? [];
  const inRange = new Set(prs.filter((x) => !x.unread).map((x) => x.number));
  const notInRange = (n) => !prs.some((x) => x.number === n);
  updatePromotionState(state, { seen: [...read, ...unread.filter((n) => inRange.has(n) || (p.fetched && notInRange(n)))] });
  const pushed = s.urgent ?? [];
  const fresh = prs.filter((x) => x.broken && !pushed.includes(x.number));
  if (!fresh.length) return carried;
  const q = promotionQuestion({ slug: inputs.slug, p, dir, name: `urgent-${now.toISOString().slice(0, 16).replace(/:/g, '')}` });
  const push = { key: `${q.key}:urgent`, text: `${inputs.slug}: production-broken fix ${fresh.map((x) => `#${x.number}`).join(', ')} merged; promote ${q.range} (${q.count} change(s)) now? ${q.page}` };
  updatePromotionState(state, { urgent: [...pushed, ...fresh.map((x) => x.number)], offered: p.range, urgent_push: push });
  return { push, page: q.page };
}
