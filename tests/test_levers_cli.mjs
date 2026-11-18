// suite: levers cli (levers decide and levers undo: Ben's own call on a lever, and the undo of a lever change)
// covers: desk/bin/levers.mjs desk/bin/levers-auto.mjs desk/bin/lever-changes.mjs desk/bin/lever-log.mjs
// `levers.mjs` runs as a subprocess on a scratch HOME and desk config root holding two repos; admission
// (assignPin), each lever's state (leverStatesIn) and the needs-you items (the levers view) read the
// lever log it writes through the same readers the pass uses.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'levers-cli-'));
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
const { REGISTRY, ENTRIES, loadRegistry } = await import('../desk/bin/lever-registry.mjs');
const { recordLeverDecision } = await import('../desk/bin/lever-changes.mjs');
const { buildView, autopilotRoot } = await import('../desk/bin/levers-view.mjs');

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
function paused() {
  reset(AA);
  mkdirSync(state(AA), { recursive: true });
  writeFileSync(logFile(AA), [
    line({ id: 'e1', at: at(20), kind: 'transition', lever: 'codex', from: 'trial', to: 'reverted', actor: 'levers-auto', reason_code: 'guardrail_ci_reds', reason: 'CI reds rose', ...ev }),
    line({ id: 'e2', at: at(15), kind: 'transition', lever: 'codex', from: 'reverted', to: 'trial', actor: 'ben', reason_code: 'ben_override', reason: 'try again' }),
    line({ id: 'e3', at: at(2), kind: 'transition', lever: 'codex', from: 'trial', to: 'frozen', actor: 'levers-auto', reason_code: 'frozen_second_revert', reason: 'second revert', ...ev }),
    line({ id: 'e4', at: at(2), kind: 'needs_you', lever: 'codex', actor: 'levers-auto', reason_code: 'frozen_second_revert', reason: 'codex is frozen in ai-agents after its second revert', ...ev }),
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
const p3 = admit('AA-1');
t('AC3 the next ticket admitted has codex pinned off, with no arm', [p3.set.includes('codex'), Object.hasOwn(p3.arms, 'codex')], [false, false]);
t('AC4 needs-you no longer lists it', codexItems(), 0);

// ---- AC11: undo Ben's own call ------------------------------------------------------------------------
const r11 = levers('undo', 'ai-agents', 'codex');
const o11 = events(AA).filter((e) => e.kind === 'override').at(-1);
t('AC11 exits 0', r11.status, 0);
t('AC11 an override naming the undone decision puts codex back to paused (frozen)', [o11.actor, o11.to, o11.undoes], ['ben', 'frozen', e1.decision_id]);
t('AC11 the lever reads frozen again', leverStatesIn(events(AA)).codex.state, 'frozen');
t('AC11 its needs-you item is listed again', codexItems(), 1);
t('AC11 it prints the lever, the repo and the state it is back in', r11.stdout.trim(), `Put codex back to frozen in ai-agents, undoing your decision ${e1.decision_id}. Its needs-you item is listed again.`);
t('AC11 the undo is logged with its own id', decisions(AA).at(-1).id, o11.decision_id);

// Undo back to a plain state is that state, not a call by hand: a quality-risk lever that was simply off
// reads off again, unpinned, as it did before Ben's call.
reset(AA);
const rOff = levers('decide', 'ai-agents', 'codex', 'off');
t('undo to plain off: the call pins codex off', [rOff.status, leverStatesIn(events(AA)).codex.state], [0, 'overridden']);
const rBack = levers('undo', 'ai-agents', 'codex');
const oBack = events(AA).at(-1);
t('undo to plain off: the override goes back to off with no value, and the lever reads plain off', [rBack.status, oBack.to, Object.hasOwn(oBack, 'value'), leverStatesIn(events(AA)).codex], [0, 'off', false, { state: 'off', at: oBack.at, id: oBack.id }]);

// ---- AC5: trial -----------------------------------------------------------------------------------------
paused();
const r5 = levers('decide', 'ai-agents', 'codex', 'trial');
const e5 = events(AA).at(-1);
t('AC5 exits 0, and the override records to trial', [r5.status, e5.kind, e5.to], [0, 'override', 'trial']);
t('AC5 the lever reads on trial', leverStatesIn(events(AA)).codex.state, 'trial');
// Admission draws arms for the low-risk layer; a lever that could be paused after two turn-offs on
// trial is drawn there, as here.
const DRAWN = loadRegistry({ ...ENTRIES, codex: { ...ENTRIES.codex, layer: 'low-risk', trialled: true } });
const p5 = admit('AA-5', DRAWN);
t('AC5 the next ticket admitted draws a codex arm under the new trial', [['on', 'off'].includes(p5.arms.codex), p5.trial_ids.codex], [true, `${AA}/codex/${e5.id}`]);

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

const ru = levers('decide', 'ai-agents', 'codex');
t('usage: a missing choice exits 2', ru.status, 2);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
