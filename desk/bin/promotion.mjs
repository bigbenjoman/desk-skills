// The daily promotion window: going to production is asked once a day, in the last check-in slot,
// as one question per repo covering every PR merged to the default branch since config §4 "Promotion
// ref", with a staging-check page listing what each PR leaves a person to look at. A merged fix for a
// production breakage is asked at once (urgentPromotion). Skills never deploy production: a "go" is
// recorded in the batch notes, and the repo's own promotion steps are the person's.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import * as E from './desk-env.mjs';

// A PR title or body line that starts this way is a fix for a live production breakage.
export const PRODUCTION_BROKEN = /^\s*production broken\b/i;
const FULL_SHA = /^[0-9a-f]{40}$/;

// The check-in slot that carries the promotion question: the day's last.
export const promotionSlot = (times, slotId) => !!slotId && slotId.slice(11) === [...times].sort().at(-1);

// The §4 row: {ref} or {why} when there is nothing to promote from.
export function promotionRef(raw) {
  if (raw == null || raw === '' || /^todo\b/i.test(raw)) return { why: 'config §4 "Promotion ref" is unset' };
  if (E.isNone(raw)) return { why: 'config §4 "Promotion ref" is none' };
  return { ref: String(raw).trim() };
}

// `git log --first-parent --format=%H%x09%s` lines -> the PR numbers merged, oldest first. A merge
// commit reads "Merge pull request #N from …", a squash "<title> (#N)".
export function mergedPrs(log) {
  const out = [];
  for (const line of String(log ?? '').split('\n').reverse()) {
    const subject = line.split('\t').slice(1).join('\t');
    const n = /^Merge pull request #(\d+)\b/.exec(subject)?.[1] ?? /\(#(\d+)\)\s*$/.exec(subject)?.[1];
    if (n && !out.includes(Number(n))) out.push(Number(n));
  }
  return out;
}

// What a PR body's `### Testing` section leaves to a person: its unchecked task items (desk-pr).
export function personSteps(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  const from = lines.findIndex((l) => /^###\s+Testing\s*$/i.test(l.trim()));
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

// The staging-check page, as markdown.
export function renderStagingPage({ slug, ref, range, prs, staging }) {
  const where = staging?.length && !E.isNone(staging) ? staging : null;
  const look = prs.filter((p) => p.steps.length);
  const nothing = prs.filter((p) => !p.steps.length);
  const lines = [`# Staging check: ${slug}`, '',
    `${prs.length} PR(s) merged since \`${ref}\`, \`${range.from.slice(0, 7)}..${range.to.slice(0, 7)}\`. ` +
    `Check them on ${where ? where.map((s) => `\`${s}\``).join(', ') : 'staging (config §4 "Staging" is unset)'}.`, ''];
  if (look.length) {
    lines.push('## To look at', '');
    for (const p of look) {
      lines.push(`### [#${p.number} ${p.title}](${p.url})${p.broken ? ' (production broken)' : ''}`, '');
      for (const s of p.steps) lines.push(`- [ ] ${s}`);
      lines.push('');
    }
  }
  if (nothing.length) {
    lines.push('## Nothing to look at', '', 'Their Testing sections leave no steps to a person.', '');
    for (const p of nothing) lines.push(`- [#${p.number} ${p.title}](${p.url})${p.broken ? ' (production broken)' : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// One repo's promotion: {why} when it has no Promotion ref or the range cannot be read, {empty: true}
// when nothing merged since it, else {range, prs, page} with the page's text. `exec` runs git and gh.
export function promotionFor({ slug, root, ghRepo, def, ref: raw, staging, exec = run }) {
  const r = promotionRef(raw);
  if (r.why) return { why: r.why };
  const git = (...a) => exec('git', ['-C', root, ...a]);
  try { git('fetch', '-q', 'origin'); } catch { /* offline: read what is already fetched */ }
  let from, to, log;
  try {
    from = git('rev-parse', '--verify', `${r.ref}^{commit}`);
    to = git('rev-parse', '--verify', `origin/${def}^{commit}`);
    log = git('log', '--first-parent', '--format=%H%x09%s', `${from}..${to}`);
  } catch (e) {
    return { why: `config §4 "Promotion ref" \`${r.ref}\` or \`origin/${def}\` does not resolve in ${root}: ${String(e.stderr ?? e.message).trim().split('\n')[0]}` };
  }
  if (!FULL_SHA.test(from) || !FULL_SHA.test(to)) return { why: `could not read the range ${r.ref}..origin/${def} in ${root}` };
  const numbers = mergedPrs(log);
  if (!numbers.length) return { empty: true };
  const prs = numbers.map((n) => {
    let v = {};
    try { v = JSON.parse(exec('gh', ['pr', 'view', String(n), '--repo', ghRepo, '--json', 'number,title,url,body'])); } catch { /* listed by number */ }
    const pr = { number: n, title: v.title ?? '(title not read)', url: v.url ?? `https://github.com/${ghRepo}/pull/${n}`, body: v.body ?? '' };
    return { number: n, title: pr.title, url: pr.url, steps: personSteps(pr.body), broken: isProductionBroken(pr) };
  });
  const range = { from, to };
  return { range, prs, page: renderStagingPage({ slug, ref: r.ref, range, prs, staging }) };
}

// A repo's promotion inputs from its own config, for the digest, which reads every repo's.
export function promotionInputs(slug) {
  const v = (id) => E.repoConfigValue(slug, id);
  const staging = E.repoConfigValues(slug, 'staging');
  return { slug, root: E.expandHome(v('repo-root')), ghRepo: v('gh-repo'), def: v('default-branch') ?? 'main', ref: v('promotion-ref'), staging };
}

const stateFile = (state) => join(state, 'promotion.json');
export const readPromotionState = (state) => { try { return JSON.parse(readFileSync(stateFile(state), 'utf8')); } catch { return {}; } };
const writePromotionState = (state, s) => { mkdirSync(state, { recursive: true }); writeFileSync(stateFile(state), `${JSON.stringify(s, null, 2)}\n`); };

// Writes a promotion's page beside the digest's and returns its question, or a note when the range
// was already approved and is waiting on the repo's own promotion steps.
export function promotionQuestion({ slug, state, p, dir, name }) {
  const page = join(dir, `${name}-${slug}-staging.md`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(page, p.page);
  const range = `${p.range.from.slice(0, 12)}..${p.range.to.slice(0, 12)}`;
  const approved = readPromotionState(state).approved;
  return { key: `promotion:${slug}:${p.range.to}`, range, page, count: p.prs.length, approved: approved?.to === p.range.to ? approved : null };
}

// A "go" for a range: recorded in the batch notes and the repo's promotion state. Promoting is the
// repo's own process, run by the person as today.
export function approve({ slug, state, range, by, now = new Date() }) {
  const m = /^([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})$/.exec(String(range ?? ''));
  if (!m) return { ok: false, why: `'${range}' is not a <from>..<to> commit range` };
  const at = now.toISOString();
  const s = readPromotionState(state);
  const to = s.offered?.to?.startsWith(m[2]) ? s.offered.to : m[2];
  const from = s.offered?.from?.startsWith(m[1]) ? s.offered.from : m[1];
  appendFileSync(join(state, 'batch-notes.md'), `- [promotion] ${at} ${by} approved promoting ${slug} \`${from}..${to}\` to production. Run this repo's own promotion steps; skills never deploy production.\n`);
  writePromotionState(state, { ...s, approved: { from, to, at, by } });
  return { ok: true, from, to };
}

// Records the range a question offered, so a "go" given with short SHAs is written out in full.
export const recordOffered = (state, range) => writePromotionState(state, { ...readPromotionState(state), offered: range });

// Pushed between check-ins: the promotion question for a range holding a merged production-broken
// fix that has not been pushed yet. Read only when `merged` (the batch's merged PR numbers) has one
// no pass has looked at, so a quiet pass makes no network call. Returns {push, page, range} or null.
export function urgentPromotion({ inputs, state, dir, merged = [], now = new Date(), exec = run }) {
  if (promotionRef(inputs.ref).why) return null;
  const seen = readPromotionState(state).seen ?? [];
  const unseen = merged.filter((n) => !seen.includes(n));
  if (!unseen.length) return null;
  writePromotionState(state, { ...readPromotionState(state), seen: [...seen, ...unseen] });
  const p = promotionFor({ ...inputs, exec });
  if (!p.prs) return null;
  const s = readPromotionState(state);
  const pushed = s.urgent ?? [];
  const fresh = p.prs.filter((x) => x.broken && !pushed.includes(x.number));
  if (!fresh.length) return null;
  const name = `urgent-${now.toISOString().slice(0, 16).replace(/[:]/g, '')}`;
  const q = promotionQuestion({ slug: inputs.slug, state, p, dir, name });
  writePromotionState(state, { ...s, urgent: [...pushed, ...fresh.map((x) => x.number)], offered: p.range });
  return {
    push: { key: `${q.key}:urgent`, text: `${inputs.slug}: production-broken fix ${fresh.map((x) => `#${x.number}`).join(', ')} merged; promote ${q.range} (${q.count} PR(s)) now? ${q.page}` },
    page: q.page, range: q.range,
  };
}
