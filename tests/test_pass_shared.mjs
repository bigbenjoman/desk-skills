// suite: pass phase: the shared snapshot and helpers (the registry read, logins, specs, link parks, resumes)
// layer: L1
import * as S from '../desk/bin/pass/shared.mjs';
import { withNoIo } from './pass_phase_trap.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);

// AC4: every helper below runs with process starts and file writes trapped (pass_phase_trap.mjs).
const { threw, calls } = withNoIo(() => {
  const NOW = Date.parse('2026-11-17T12:00:00.000Z');
  const AT = (iso) => Date.parse(iso) / 1000;

  // The registry read, as the snapshot every phase starts from.
  {
    const r = S.registryView({ ok: false, live: null, why: 'the registry of claude login a (/x): exited 1' });
    t('AC1 a failed registry read reads as unread', r.read, false);
    t('AC1 and its live sessions as unknown, not as none', j([r.sessions, r.liveSids]), '[null,null]');
    t('AC1 the failed read keeps why', r.why, 'the registry of claude login a (/x): exited 1');
    t('AC1 a registry with no list at all reads as unread too', S.registryView({}).read, false);
    const snap = S.phaseSnapshot({ tickets: {}, registry: r, now: NOW });
    t('AC1 the phase snapshot carries the unread registry', j([snap.registry.read, snap.registry.liveSids]), '[false,null]');
  }
  {
    const r = S.registryView({ ok: true, live: [{ sessionId: 's1', pid: 1 }, { sessionId: 's2', pid: 2 }, { sessionId: 's3', pid: 3, login: 'work' }] });
    t('AC2 a read registry lists every live session id it returned', j([r.read, [...r.liveSids]]), '[true,["s1","s2","s3"]]');
    t('AC2 and keeps each session', r.sessions.length, 3);
    const empty = S.registryView({ ok: true, live: [] });
    t('AC2 a read registry with no sessions is read and empty, not unread', j([empty.read, [...empty.liveSids]]), '[true,[]]');
    const snap = S.phaseSnapshot({ tickets: { A: { key: 'A' } }, registry: r, now: NOW });
    t('AC2 the phase snapshot carries the tickets, the registry and the time', j([Object.keys(snap.tickets), snap.registry.liveSids.has('s2'), snap.now]), j([['A'], true, NOW]));
  }

  // Logins, subscriptions and usage holds.
  t('a login is the repo\'s by its folder', j([S.sameLogin({ dir: '/a' }, { dir: '/a' }), S.sameLogin({ dir: '/a' }, { dir: '/b' }), S.sameLogin(null, { dir: '/a' }), S.sameLogin({ dir: '/a' }, null)]), '[true,false,false,false]');
  {
    const limit = { type: 'five_hour', resetsAt: AT('2026-11-17T13:00:00.000Z') };
    t('a worker at a limit before its reset is paused', S.pausedOn(limit, NOW), true);
    t('and still paused within the grace after its reset', S.pausedOn(limit, Date.parse('2026-11-17T13:20:00.000Z')), true);
    t('and no longer once the grace has passed', S.pausedOn(limit, Date.parse('2026-11-17T13:31:00.000Z')), false);
    t('a limit the worker answered since does not pause it', S.pausedOn({ ...limit, resumed: true }, NOW), false);
    t('a limit with no reset pauses until it lifts', S.pausedOn({ type: 'x' }, NOW), true);
    t('no limit is no pause', S.pausedOn(null, NOW), false);
    t('a limit lifted by its reset says so', S.liftedHow(limit, Date.parse('2026-11-17T13:00:00.000Z')), 'its reset at 2026-11-17 13:00 UTC passed');
    t('one lifted before its reset was the probe', S.liftedHow(limit, NOW), 'a probe call succeeded');
    t('a limit\'s reset reads as until', j([S.untilText(limit), S.untilText({})]), j([' until 2026-11-17 13:00 UTC', '']));
  }
  {
    const pinnedOff = { off: { name: 'work' }, fix: 'the row', email: 'a@b' };
    t('a row pinned to a subscription set off is recorded', S.subscriptionOffWrite(null, pinnedOff, '2026-11-17T12:00:00Z'), '{"since":"2026-11-17T12:00:00Z","email":"a@b","login":"work"}');
    t('the same pin already recorded is not written again', S.subscriptionOffWrite({ since: 'x', email: 'a@b', login: 'work' }, pinnedOff, 'y'), null);
    t('a pin that resolves again drops the record', S.subscriptionOffWrite({ email: 'a@b', login: 'work' }, { off: null }, 'y'), 'null');
    t('DESK_SUBSCRIPTION naming one is not recorded', S.subscriptionOffWrite(null, { ...pinnedOff, fix: 'DESK_SUBSCRIPTION' }, 'y'), null);
    t('nothing recorded and nothing off writes nothing', S.subscriptionOffWrite(null, { off: null }, 'y'), null);
  }

  // Scope and specs.
  {
    const q = { feature: true, spine: 'S', owners: { 'AC-1': 'C', 'AC-2': 'S' } };
    t('the spine is the queue\'s spine in feature mode', j([S.isSpineOf(q, { key: 'S' }), S.isSpineOf({ ...q, feature: false }, { key: 'S' }), S.isSpineOf(q, { key: 'C' })]), '[true,false,false]');
    t('a child owning criteria owns specs; the spine and a child owning none do not', j([S.ownsSpecsOf(q, { key: 'C' }), S.ownsSpecsOf(q, { key: 'S' }), S.ownsSpecsOf(q, { key: 'D' }), S.ownsSpecsOf({ ...q, feature: false }, { key: 'C' })]), '[true,false,false,false]');
    t('§4 Acceptance specs gives the directory and the {ids} command', j(S.acceptanceSpecsOf(['e2e/acceptance', 'pnpm test --grep {ids}'])), j({ specDir: 'e2e/acceptance', cmd: 'pnpm test --grep {ids}' }));
    t('a row with no {ids} command has none', j(S.acceptanceSpecsOf(['e2e/acceptance'])), j({ specDir: 'e2e/acceptance', cmd: null }));
    t('unset or none is neither', j([S.acceptanceSpecsOf(null), S.acceptanceSpecsOf(['none'])]), j([{ specDir: null, cmd: null }, { specDir: null, cmd: null }]));
  }

  // Link and build parks.
  {
    t('the links line names each reason', S.linksLine([{ why: 'jira-edit is ask' }, 'not on Jira']), 'Issue links not made: jira-edit is ask; not on Jira');
    t('a park\'s own words drop the links line', S.ownWords('Need X. Issue links not made: y'), 'Need X');
    t('a park with no links line keeps its words', j([S.ownWords('Need X'), S.ownWords(null)]), j(['Need X', '']));
    const steps = [{ step: 'Issue link not made: a', row: 'jira-edit' }, { step: 'Comment on DS-1', row: 'jira-comment' }];
    t('only link steps are kept as link steps', j(S.linkSteps(steps)), j([steps[0]]));
    t('anything not a list has none', j(S.linkSteps(undefined)), '[]');
    t('a merge-only park keeps its words after the link steps', S.parkFollowOn('  who merges #4?  ', steps), `follow_on=${j([steps[0], { step: 'who merges #4?', row: null }])}`);
    t('a park longer than a follow-on step is cut to it', JSON.parse(S.parkFollowOn('x'.repeat(900), []).slice('follow_on='.length))[0].step.length, 500);
    t('the links-made kind', S.LINKS_MADE, 'links-made');
    t('§4 Required and Advisory checks: none and unset are none', j(S.gateListsOf({ required: ['test'], advisory: ['none'] })), j({ required: ['test'], advisory: [] }));
    t('and unset', j(S.gateListsOf({ required: null, advisory: undefined })), j({ required: [], advisory: [] }));
  }

  // Handoffs and resumes.
  {
    t('handoff stages in stage order: every stage a resume starts at', j(S.HANDOFF_ORDER), '["3","4","4b","5","6","7","8","9"]');
    t('starting again from Stage 0', S.FROM_ZERO({ key: 'K-1' }), 'To start it again from Stage 0 instead: queue.mjs set K-1 handoff_stage=null, then queue.mjs requeue K-1');
    const ROW = 'Resume a killed worker (times)';
    t('resume unset is 2', j(S.resumeSetting(null, ROW)), j({ row: ROW, limit: 2, bad: null }));
    t('resume none is 0', S.resumeSetting('none', ROW).limit, 0);
    t('resume a whole number is that', S.resumeSetting(' 3 ', ROW).limit, 3);
    t('resume anything else is said and read as 0', j(S.resumeSetting('two', ROW)), j({ row: ROW, limit: 0, bad: `config §3b "${ROW}" is "two" — want a whole number; read as 0, so a killed worker is marked failed` }));
    const tk = { key: 'K-1', resumes: 2, session_id: 'sid', worktree: '/w' };
    t('a killed worker under the limit resumes', S.resumeRefusal(S.resumeSetting(null, ROW), { ...tk, resumes: 1 }, 'x'), null);
    t('at the limit it parks naming the row', S.resumeRefusal(S.resumeSetting(null, ROW), tk, 'its process died').park,
      `killed again (its process died) after 2 resume(s), the most config §3b "${ROW}" allows (2), so it is not resumed. Session sid, worktree /w. Requeue it for a fresh worker with queue.mjs requeue K-1`);
    t('with resuming off it fails', S.resumeRefusal(S.resumeSetting('0', ROW), tk, 'x').fail, `Resuming is off (config §3b "${ROW}" is 0), so it is marked failed`);
    t('a bad row says why it is off', S.resumeRefusal(S.resumeSetting('two', ROW), tk, 'x').fail.startsWith(`Resuming is off (config §3b "${ROW}" is "two"`), true);
    t('the boot time from DESK_BOOT_TIME, in epoch seconds or ISO, else the uptime', j([S.bootTime('1000', NOW, 5), S.bootTime('2026-11-17T10:00:00.000Z', NOW, 5), S.bootTime(undefined, NOW, 60)]),
      j([1000000, Date.parse('2026-11-17T10:00:00.000Z'), NOW - 60000]));
    const DRAIN = 'Maintenance drain limit (minutes)';
    const stopped = { reboot_stop_at: '2026-11-17T11:30:00.000Z', resume_why: 'stopped for a planned reboot' };
    t('a reboot after the stop resumes it', S.rebootReady(stopped, { bootMs: Date.parse('2026-11-17T11:45:00Z'), drainMins: 60, drainRow: DRAIN, now: NOW }).why,
      'the computer restarted at 2026-11-17T11:45:00Z after it stopped for a planned reboot');
    t('no reboot yet within the drain limit waits', S.rebootReady(stopped, { bootMs: Date.parse('2026-11-17T08:00:00Z'), drainMins: 60, drainRow: DRAIN, now: NOW }).wait,
      'stopped for a planned reboot, resumed after the computer restarts, or at 2026-11-17T12:30:00Z if it does not');
    t('no reboot by the drain limit resumes anyway', S.rebootReady(stopped, { bootMs: Date.parse('2026-11-17T08:00:00Z'), drainMins: 20, drainRow: DRAIN, now: NOW }).why,
      `no reboot was seen within 20 min (config §3b "${DRAIN}") of when it stopped for a planned reboot`);
  }

  // Live reads config.
  t('a §4 Live reads row that parses says nothing', S.liveReadsUnparsed({ errors: [], reads: [] }), null);
  t('one that does not names what does not parse', S.liveReadsUnparsed({ errors: ['"x"'], reads: [] }),
    'live reads: none run this pass, since config §4 Live reads does not parse: "x" (want `<name>: <command>`, or for a paid call `<name> [£0.10/call, £2/day]: <command>`). Run /desk-setup');
});
t('AC4 the helpers start no process and write no file, the queue included',j([threw, calls]), '[null,[]]');

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('all passed');
