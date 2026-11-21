// suite: levers cli (levers decide and levers undo: Ben's own call on a lever, and the undo of a lever change)
// covers: desk/bin/levers.mjs desk/bin/levers-auto.mjs desk/bin/lever-changes.mjs desk/bin/lever-log.mjs desk/bin/levers-trips.mjs
// `levers.mjs` runs as a subprocess on a scratch HOME and desk config root holding two repos; admission
// (assignPin), each lever's state (leverStatesIn) and the needs-you items (the levers view) read the
// lever log it writes through the same readers the pass uses.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = scratch('levers-cli-');
for (const k of Object.keys(process.env)) if (/^(DESK_|AUTOPILOT_)/.test(k)) delete process.env[k];
const CONFIG = join(T, 'config');
Object.assign(process.env, { HOME: join(T, 'home'), DESK_CONFIG_ROOT: CONFIG, DESK_HOME: join(T, 'deskhome'), DESK_MACHINE: join(T, 'none.md'), GIT_CONFIG_NOSYSTEM: '1' });

const AA = 'sophos-education__ai-agents';
const DS = 'bigbenjoman__desk-skills';
for (const [slug, gh] of [[AA, 'sophos-education/ai-agents'], [DS, 'bigbenjoman/desk-skills']]) {
  mkdirSync(join(CONFIG, 'repos', slug), { recursive: true });
  writeFileSync(join(CONFIG, 'repos', slug, 'config.md'), `# desk config

## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`${gh}\` |
| Default branch | \`main\` |

## 3b. Cost and autonomy
| Field | Recommended | Your setting |
|---|---|---|
| Phase 0 levers | \`none\` | \`auto\` |
`);
}

const { assignPin, leverStatesIn } = await import('../desk/bin/levers-auto.mjs');
const { read, logFile } = await import('../desk/bin/lever-log.mjs');
const { REGISTRY } = await import('../desk/bin/lever-registry.mjs');
const { recordLeverDecision } = await import('../desk/bin/lever-changes.mjs');
const { buildView, autopilotRoot } = await import('../desk/bin/levers-view.mjs');
const { onArm } = await import('../desk/bin/levers-trips.mjs');

const state = (slug) => join(process.env.HOME, '.desk-autopilot', slug);
const decisions = (slug) => (existsSync(join(state(slug), 'decisions.jsonl')) ? readFileSync(join(state(slug), 'decisions.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const raw = (slug) => (existsSync(logFile(slug)) ? readFileSync(logFile(slug), 'utf8') : '');
const events = (slug) => read(slug).events;
const levers = (...args) => spawnSync('node', [join(BIN, 'levers.mjs'), ...args], { encoding: 'utf8' });
const reset = (slug) => rmSync(state(slug), { recursive: true, force: true });
const at = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const line = (e) => `${JSON.stringify({ v: 1, repo: AA, ...e })}\n`;
const ev = { eval_id: 'evl_x', evidence_file: 'levers-evidence/evl_x.jsonl' };

// codex paused in ai-agents after two turn-offs: reverted, back on trial, then frozen with its
// needs-you item.
function paused(lever = 'codex') {
  reset(AA);
  mkdirSync(state(AA), { recursive: true });
  writeFileSync(logFile(AA), [
    line({ id: 'e1', at: at(20), kind: 'transition', lever, from: 'trial', to: 'reverted', actor: 'levers-auto', reason_code: 'guardrail_ci_reds', reason: 'CI reds rose', ...ev }),
    line({ id: 'e2', at: at(15), kind: 'transition', lever, from: 'reverted', to: 'trial', actor: 'ben', reason_code: 'ben_override', reason: 'try again' }),
    line({ id: 'e3', at: at(2), kind: 'transition', lever, from: 'trial', to: 'frozen', actor: 'levers-auto', reason_code: 'frozen_second_revert', reason: 'second revert', ...ev }),
    line({ id: 'e4', at: at(2), kind: 'needs_you', lever, actor: 'levers-auto', reason_code: 'frozen_second_revert', reason: `${lever} is frozen in ai-agents after its second revert`, ...ev }),
  ].join(''));
}
const ALL_AUTO = Object.fromEntries(Object.keys(REGISTRY).map((n) => [n, 'auto']));
const admit = (key, registry = REGISTRY) => assignPin(key, { slug: AA, states: ALL_AUTO, frozen: false, values: { 'worker-location': 'local' }, random: () => 0.1, registry }).pin;
const codexItems = () => buildView({ root: autopilotRoot(), configRoot: CONFIG }).panels.waiting.items.filter((i) => i.kind === 'lever' && i.repo === 'ai-agents' && i.lever === 'codex').length;

// ---- AC1 to AC4: levers decide ai-agents codex off -----------------------------------------------------
paused();
t('AC4 before: needs-you lists the paused lever', codexItems(), 1);
const before = events(AA).length;
const r1 = levers('decide', 'ai-agents', 'codex', 'off');
const o1 = events(AA).slice(before);
const e1 = o1[0] ?? {};
t('AC1 exactly one event is appended', o1.length, 1);
t('AC1 an override by ben to off on codex, reason ben_override', [e1.kind, e1.actor, e1.to, e1.lever, e1.reason_code], ['override', 'ben', 'off', 'codex', 'ben_override']);
t('AC1 it carries a decision id', /^[0-9a-f]{16}$/.test(e1.decision_id ?? ''), true);
const d1 = decisions(AA);
t('AC1 one decisions.jsonl line with that id', [d1.length, d1[0]?.id], [1, e1.decision_id]);
t('AC1 the decision names its lever, so the digest and needs-you leave it to the Levers section', d1[0]?.lever, 'codex');
t('AC2 exits 0', r1.status, 0);
t('AC2 its line', r1.stdout.trim(), `levers decide: override recorded in ai-agents/levers.jsonl (codex → off, actor ben, decision ${e1.decision_id}) · decision logged in decisions.jsonl`);
const s3 = leverStatesIn(events(AA)).codex;
t('AC3 the lever reads overridden off', [s3.state, s3.value], ['overridden', 'off']);
t('AC4 needs-you no longer lists it', codexItems(), 0);
// codex, paused, is out of the set with no arm before the call too, so the pin is shown on wrappers,
// a lever on trial: it draws an arm, and once set off by levers decide it is out of the set with no arm.
t('AC3 wrappers on trial draws an arm before the call', Object.hasOwn(admit('AA-2').arms, 'wrappers'), true);
levers('decide', 'ai-agents', 'wrappers', 'off');
const p3w = admit('AA-3');
t('AC3 set off by levers decide, wrappers is pinned off on the next ticket, with no arm', [p3w.set.includes('wrappers'), Object.hasOwn(p3w.arms, 'wrappers'), leverStatesIn(events(AA)).wrappers.state], [false, false, 'overridden']);
levers('undo', 'ai-agents', 'wrappers');

// ---- AC11: undo Ben's own call ------------------------------------------------------------------------
const r11 = levers('undo', 'ai-agents', 'codex');
const o11 = events(AA).filter((e) => e.kind === 'override').at(-1);
t('AC11 exits 0', r11.status, 0);
t('AC11 an override naming the undone decision puts codex back to paused (frozen)', [o11.actor, o11.to, o11.undoes], ['ben', 'frozen', e1.decision_id]);
t('AC11 the lever reads frozen again', leverStatesIn(events(AA)).codex.state, 'frozen');
t('AC11 its needs-you item is listed again', codexItems(), 1);
t('AC11 it prints the lever, the repo and the state it is back in', r11.stdout.trim(), `Put codex back to frozen in ai-agents, undoing your decision ${e1.decision_id}. Its needs-you item is listed again.`);
t('AC11 the undo is logged with its own id', decisions(AA).at(-1).id, o11.decision_id);

// Undo back to a plain state is that state, not a call by hand: codex, on its initial trial before
// Ben's call, reads on that trial again, unpinned, as it did.
reset(AA);
const rOff = levers('decide', 'ai-agents', 'codex', 'off');
t('undo to a plain state: the call pins codex off', [rOff.status, leverStatesIn(events(AA)).codex.state], [0, 'overridden']);
const rBack = levers('undo', 'ai-agents', 'codex');
const oBack = events(AA).at(-1);
t('undo to a plain state: the override goes back to its initial trial with no value, and the lever reads that trial as it did', [rBack.status, oBack.to, Object.hasOwn(oBack, 'value'), leverStatesIn(events(AA)).codex], [0, 'trial', false, { state: 'trial', at: null, id: null }]);

// Undo back to a trial keeps the trial: the next ticket draws under the trial id it had before the call.
reset(AA);
const tidBefore = admit('AA-20').trial_ids.wrappers;
levers('decide', 'ai-agents', 'wrappers', 'off');
levers('undo', 'ai-agents', 'wrappers');
t('undo back to trial: the next ticket draws under the same trial id', [leverStatesIn(events(AA)).wrappers.state, admit('AA-21').trial_ids.wrappers], ['trial', tidBefore]);

// Undo back to an adopt keeps its holdback start.
reset(AA);
mkdirSync(state(AA), { recursive: true });
const adAt = at(3);
writeFileSync(logFile(AA), line({ id: 'ad1', at: adAt, kind: 'transition', lever: 'wrappers', from: 'trial', to: 'adopted', actor: 'levers-auto', reason_code: 'adopt_all_conditions', reason: 'every adopt condition held', ...ev }));
levers('decide', 'ai-agents', 'wrappers', 'off');
levers('undo', 'ai-agents', 'wrappers');
const sAd = leverStatesIn(events(AA)).wrappers;
t('undo back to adopted: the holdback runs from the adopt, not the undo', [sAd.state, sAd.at, sAd.id], ['adopted', adAt, 'ad1']);
const pinnedBefore = { levers: { set: ['wrappers'], arms: {}, at: at(2) } };
t('undo back to adopted: a ticket pinned on before the call still counts toward its trips', onArm(pinnedBefore, 'wrappers', sAd, AA, events(AA)), true);

// Undo back to a kept quality-risk lever keeps its pair trial, and the pair's recorded verdict with it.
{
  const { pairTrial, qualityTrials } = await import('../desk/bin/levers-auto.mjs');
  reset(AA);
  mkdirSync(state(AA), { recursive: true });
  writeFileSync(logFile(AA), [
    line({ id: 'kc', at: at(10), kind: 'transition', lever: 'codex', from: 'trial', to: 'adopted', actor: 'levers-auto', reason_code: 'adopt_all_conditions', reason: 'every adopt condition held', ...ev }),
    line({ id: 'kr', at: at(9), kind: 'transition', lever: 'review-reuse', from: 'trial', to: 'adopted', actor: 'levers-auto', reason_code: 'adopt_all_conditions', reason: 'every adopt condition held', ...ev }),
  ].join(''));
  const pair = () => pairTrial({ slug: AA, events: events(AA), states: ALL_AUTO, values: null });
  const p0 = pair();
  writeFileSync(logFile(AA), raw(AA) + line({ id: 'pv', at: at(5), kind: 'pair', trial_id: p0.id, from: 'trial', to: 'reverted', actor: 'levers-audit', reason_code: 'audit_p0', reason: 'a blind audit found a P0' }));
  t('kept pair: the audit reverted the pair', pair().state, 'reverted');
  levers('decide', 'ai-agents', 'codex', 'off');
  levers('undo', 'ai-agents', 'codex');
  const p1 = pair();
  t('undo back to a kept pair: the pair keeps its trial id and its reverted verdict, so no ticket draws it again', [leverStatesIn(events(AA)).codex.state, p1.id, p1.state, qualityTrials({ slug: AA, events: events(AA), states: ALL_AUTO, values: null }).some((q) => q.key === p1.key)], ['adopted', p0.id, 'reverted', false]);

  // A blind audit P0 on the pair's on arm recorded while codex was off: the undo that restores the pair
  // trial reverts it at once, before any ticket can be drawn into it again.
  const { auditFile } = await import('../desk/bin/levers-audit.mjs');
  writeFileSync(logFile(AA), raw(AA).split('\n').filter((l) => l && JSON.parse(l).kind !== 'pair' && !JSON.parse(l).decision_id).map((l) => `${l}\n`).join(''));
  t('a fresh kept pair is on trial', pair().state, 'trial');
  levers('decide', 'ai-agents', 'codex', 'off');
  writeFileSync(auditFile(AA), `${JSON.stringify({ v: 1, at: at(0), repo: AA, ticket: 'AA-9', pr: 9, merge_commit: 'a'.repeat(40), lever: 'codex', arm: 'on', trial_id: p0.id, p0: 1, p1: 0, p2: 0 })}\n`);
  const rP = levers('undo', 'ai-agents', 'codex');
  t('undo back to a pair with a P0 recorded while it was off: the pair trial is reverted in the same call, and it says so', [rP.status, pair().id, pair().state, / so that trial is reverted now\.$/.test(rP.stdout.trim())], [0, p0.id, 'reverted', true]);

  // The same for a lever on trial alone: the undo that restores its trial trips it in the same write.
  reset(AA);
  levers('decide', 'ai-agents', 'codex', 'off');
  writeFileSync(auditFile(AA), `${JSON.stringify({ v: 1, at: at(0), repo: AA, ticket: 'AA-8', pr: 8, merge_commit: 'b'.repeat(40), lever: 'codex', arm: 'on', trial_id: `${AA}/codex/initial`, p0: 1, p1: 0, p2: 0 })}\n`);
  const rT = levers('undo', 'ai-agents', 'codex');
  const tripped = events(AA).filter((e) => e.kind === 'trip');
  t('undo back to a trial with a P0 recorded while it was off: the trial is tripped in the same call, and the trip is logged', [rT.status, leverStatesIn(events(AA)).codex.state, tripped.map((e) => [e.from, e.to, e.trip]), decisions(AA).some((d) => d.lever_event != null && d.lever_event === tripped[0]?.id)], [0, 'reverted', [['trial', 'reverted', 'audit-p0']], true]);
  // That undo, its decision line lost: a re-run looks past the trip its replay wrote, and finishes it.
  const nT = events(AA).length;
  const undoT = events(AA).filter((e) => e.kind === 'override').at(-1).decision_id;
  writeFileSync(join(state(AA), 'decisions.jsonl'), `${JSON.stringify(decisions(AA)[0])}\n`);
  const rTRe = levers('undo', 'ai-agents', 'codex');
  t('an undo re-run after a lost decision line, with a replayed trip in its write, finishes it and logs the trip', [rTRe.status, events(AA).length, decisions(AA).some((d) => d.id === undoT), decisions(AA).some((d) => d.lever_event === tripped[0]?.id), leverStatesIn(events(AA)).codex.state], [0, nT, true, true, 'reverted']);
  // An undo whose decision line was lost, with a trip a pass wrote after it: a re-run still finishes it.
  reset(AA);
  levers('decide', 'ai-agents', 'codex', 'off');
  levers('undo', 'ai-agents', 'codex');
  const undoP = events(AA).filter((e) => e.kind === 'override').at(-1).decision_id;
  writeFileSync(join(state(AA), 'decisions.jsonl'), `${JSON.stringify(decisions(AA)[0])}\n`);
  writeFileSync(logFile(AA), raw(AA) + line({ id: 'tp', at: new Date(Date.now() + 1000).toISOString(), kind: 'trip', lever: 'codex', from: 'trial', to: 'reverted', actor: 'trip', reason_code: 'post_merge_revert', reason: 'reverted', trip: 'post-merge-revert', ticket: 'AA-7', evidence_file: 'post-merge.jsonl', evidence_line: 1 }));
  const nP = events(AA).length;
  const rPRe = levers('undo', 'ai-agents', 'codex');
  t('an undo re-run after a lost decision line, with a pass trip after it, finishes it and writes nothing', [rPRe.status, events(AA).length, decisions(AA).some((d) => d.id === undoP), leverStatesIn(events(AA)).codex.state], [0, nP, true, 'reverted']);
  // The same lost line, then desk adopts the lever: the re-run undoes the adopt, the latest change.
  writeFileSync(logFile(AA), raw(AA) + line({ id: 'ra', at: new Date(Date.now() + 2000).toISOString(), kind: 'transition', lever: 'codex', from: 'reverted', to: 'adopted', actor: 'levers-auto', reason_code: 'adopt_all_conditions', reason: 'every adopt condition held', ...ev }));
  writeFileSync(join(state(AA), 'decisions.jsonl'), `${JSON.stringify(decisions(AA)[0])}\n`);
  const rAd = levers('undo', 'ai-agents', 'codex');
  const oAd = events(AA).at(-1);
  t('an undo re-run with desk\'s adopt after a lost decision line turns the adopt off', [rAd.status, oAd.kind, oAd.undoes_event, leverStatesIn(events(AA)).codex.state, rAd.stdout.trim()], [0, 'override', 'ra', 'overridden', 'Turned off codex in ai-agents. It stays off until you set it back.']);
  t('a trial with no such P0 is restored as it was', (() => { reset(AA); levers('decide', 'ai-agents', 'codex', 'off'); levers('undo', 'ai-agents', 'codex'); return [leverStatesIn(events(AA)).codex.state, events(AA).some((e) => e.kind === 'trip')]; })(), ['trial', false]);
}

// A run that wrote its override but stopped before its decision line is finished by running it again.
reset(AA);
levers('decide', 'ai-agents', 'wrappers', 'off');
const n1 = events(AA).length;
rmSync(join(state(AA), 'decisions.jsonl'));
const rRe = levers('decide', 'ai-agents', 'wrappers', 'off');
t('a decide re-run after a lost decision line writes no second override and logs the first', [rRe.status, events(AA).length, decisions(AA).map((d) => d.id)], [0, n1, [events(AA).at(-1).decision_id]]);
levers('undo', 'ai-agents', 'wrappers');
const n2 = events(AA).length;
const undoId = events(AA).filter((e) => e.kind === 'override').at(-1).decision_id;
writeFileSync(join(state(AA), 'decisions.jsonl'), `${JSON.stringify(decisions(AA)[0])}\n`);
const rReU = levers('undo', 'ai-agents', 'wrappers');
t('an undo re-run after a lost decision line finishes it, and does not undo the undo', [rReU.status, events(AA).length, decisions(AA).at(-1).id, leverStatesIn(events(AA)).wrappers.state], [0, n2, undoId, 'trial']);

// ---- AC5: trial, on a quality-risk lever and a low-risk one ----------------------------------------------
paused();
const r5c = levers('decide', 'ai-agents', 'codex', 'trial');
const e5c = events(AA).at(-1);
t('AC5 codex: exits 0, and the override records to trial', [r5c.status, e5c.kind, e5c.to, e5c.lever], [0, 'override', 'trial', 'codex']);
const p5c = admit('AA-4');
t('AC5 codex: the next ticket admitted is assigned a codex arm under the new trial, as any lever on trial is', [['on', 'off'].includes(p5c.arms.codex), p5c.trial_ids.codex], [true, `${AA}/codex/${e5c.id}`]);
paused('wrappers');
const r5 = levers('decide', 'ai-agents', 'wrappers', 'trial');
const e5 = events(AA).at(-1);
t('AC5 exits 0, and the override records to trial', [r5.status, e5.kind, e5.to, e5.lever], [0, 'override', 'trial', 'wrappers']);
t('AC5 the lever reads on trial', leverStatesIn(events(AA)).wrappers.state, 'trial');
const p5 = admit('AA-5');
t('AC5 the next ticket admitted draws a wrappers arm under the new trial', [['on', 'off'].includes(p5.arms.wrappers), p5.trial_ids.wrappers], [true, `${AA}/wrappers/${e5.id}`]);

// ---- AC6 to AC8: refusals that write nothing --------------------------------------------------------------
paused();
const snap = () => [raw(AA), decisions(AA).length];
const s0 = snap();
const r6 = levers('decide', 'ai-agents', 'nosuch', 'off');
t('AC6 an undeclared lever exits 2 and writes nothing', [r6.status, snap()], [2, s0]);
t('AC6 it names the declared levers', r6.stderr.includes(`declared: ${Object.keys(REGISTRY).join(', ')}`), true);
const r7 = levers('decide', 'nosuch', 'codex', 'off');
t('AC7 an unconfigured repo exits 2 and writes nothing', [r7.status, snap()], [2, s0]);
t('AC7 it names the configured repos', r7.stderr.includes(`configured: desk-skills (${DS}), ai-agents (${AA})`), true);
const r8 = levers('decide', 'ai-agents', 'codex', 'maybe');
t('AC8 another choice exits 2 and writes nothing', [r8.status, snap()], [2, s0]);
t('AC8 it names the two choices', r8.stderr.includes('off or trial'), true);

// ---- AC9: the name desk-q shows, or the slug ---------------------------------------------------------------
const strip = ({ v, id, at: _at, decision_id: _d, reason, ...rest }) => rest;
const stripD = ({ id, at: _at, ...rest }) => rest;
paused();
levers('decide', 'ai-agents', 'codex', 'off');
const byName = [logFile(AA), strip(events(AA).at(-1)), stripD(decisions(AA).at(-1))];
paused();
levers('decide', AA, 'codex', 'off');
const bySlug = [logFile(AA), strip(events(AA).at(-1)), stripD(decisions(AA).at(-1))];
t('AC9 the name and the slug append the same events to the same files', bySlug, byName);

// ---- AC10: undo desk's own adopt -----------------------------------------------------------------------------
reset(DS);
mkdirSync(state(DS), { recursive: true });
const adopt = { v: 1, id: 'a1', at: at(3), repo: DS, kind: 'transition', lever: 'wrappers', from: 'trial', to: 'adopted', actor: 'levers-auto', reason_code: 'adopt_all_conditions', reason: 'every adopt condition held', ...ev };
writeFileSync(logFile(DS), `${JSON.stringify(adopt)}\n`);
const [adoptCall] = recordLeverDecision([adopt], { slug: DS, state: state(DS) });
const r10 = levers('undo', 'desk-skills', 'wrappers');
const e10 = events(DS).at(-1);
t('AC10 exits 0', r10.status, 0);
t('AC10 an override by ben turns wrappers off, reason ben_override, with a decision id', [e10.kind, e10.actor, e10.to, e10.lever, e10.reason_code, /^[0-9a-f]{16}$/.test(e10.decision_id ?? '')], ['override', 'ben', 'off', 'wrappers', 'ben_override', true]);
const d10 = decisions(DS).at(-1);
t('AC10 one decisions.jsonl line with that id, overriding desk\'s adopt call', [d10.id, d10.override_of], [e10.decision_id, adoptCall.id]);
t('AC10 the lever reads overridden off', [leverStatesIn(events(DS)).wrappers.state, leverStatesIn(events(DS)).wrappers.value], ['overridden', 'off']);
t('AC10 its line', r10.stdout.trim(), 'Turned off wrappers in desk-skills. It stays off until you set it back.');

// ---- AC12: nothing to undo -----------------------------------------------------------------------------------
reset(DS);
const r12 = levers('undo', 'desk-skills', 'wrappers');
t('AC12 exits 0 and writes nothing', [r12.status, raw(DS), decisions(DS).length], [0, '', 0]);
t('AC12 its line', r12.stdout.trim(), "wrappers has never been adopted in desk-skills, so there's nothing to undo.");

// Undoing a settled adopt overrides the adopt call desk logged against the adopt, as undoing the adopt does.
reset(DS);
mkdirSync(state(DS), { recursive: true });
const settle = { ...adopt, id: 'a2', at: at(1), from: 'adopted', to: 'settled', reason_code: 'holdback_ended', reason: 'holdback ended' };
writeFileSync(logFile(DS), [adopt, settle].map((e) => `${JSON.stringify(e)}\n`).join(''));
const [settledCall] = recordLeverDecision([adopt], { slug: DS, state: state(DS) });
const rSet = levers('undo', 'desk-skills', 'wrappers');
t('undo of a settled adopt overrides the adopt call', [rSet.status, decisions(DS).at(-1).override_of], [0, settledCall.id]);

// A lever the repo's Phase 0 levers row does not leave to auto is refused, writing nothing: admission
// never reads the lever log for it.
const ROW = 'acme__pinned';
mkdirSync(join(CONFIG, 'repos', ROW), { recursive: true });
writeFileSync(join(CONFIG, 'repos', ROW, 'config.md'), '# desk config\n\n## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/pinned` |\n\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Phase 0 levers | `none` | `auto wrappers` |\n');
const rPin = levers('decide', 'pinned', 'wrappers', 'off');
t('a lever the row names is refused, exit 2, writing nothing', [rPin.status, raw(ROW), rPin.stderr.includes('named in pinned\'s Phase 0 levers row')], [2, '', true]);
writeFileSync(join(CONFIG, 'repos', ROW, 'config.md'), '# desk config\n\n## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/pinned` |\n\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Phase 0 levers | `none` | `none` |\n');
const rNone = levers('undo', 'pinned', 'wrappers');
t('a repo whose row is not auto is refused, exit 2, writing nothing', [rNone.status, raw(ROW), rNone.stderr.includes('is not auto')], [2, '', true]);
rmSync(join(CONFIG, 'repos', ROW), { recursive: true, force: true });

const ru = levers('decide', 'ai-agents', 'codex');
t('usage: a missing choice exits 2', ru.status, 2);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
