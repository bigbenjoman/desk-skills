// A cloud ticket's tracker steps, as a decision. A cloud session has no tracker access, so once its PR
// shows (pass.mjs advanceCloud sets tracker_steps=due) the pass makes the steps a local worker's Stage 8
// would: the PR-link comment under §3 jira-comment (posted once: its marker is looked for first) and
// the move to §4 Review state under §3 jira-transition, by the transition whose target is that state
// (none: no move; a ticket already in it or in §4 Done state is not moved back). A step whose row is
// not yes is put to the person once, with its command; a failed read or write leaves the ticket due,
// so the next pass tries again. A generator run by runSteps: each read and write is an action.
//
// The snapshot:
//   tickets      the queue's tickets, by key
//   dry          a dry run: say what it would do, change nothing
//   tracker      a Set of the keys the tracker holds (empty off Jira)
//   repo         owner/name, for the PR's URL
//   comment      §3 jira-comment's setting, and commentRow its key; move and moveRow for jira-transition
//   review       §4 Review state ('' unset, or none), and done §4 Done state
//   now          the time, as an ISO string
//
// Actions, beside set and report, with what their handlers give back:
//   { type: 'post-once', key, mark, body }   → { ok, posted, out }: the comment, unless one holding mark is there
//   { type: 'status', key }                  → { ok, status, out }: the ticket's status name
//   { type: 'transitions', key }             → { ok, list: [{ id, to }], out }
//   { type: 'transition', key, id }          → { ok, out }
import { set, say } from './shared.mjs';

export const cloudMark = (key) => `(${key}/desk-autopilot cloud PR)`;
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const isNone = (v) => /^none$/i.test(String(v ?? '').trim());

export function* decideTrackerSteps(s) {
  for (const t of Object.values(s.tickets)) {
    if (t.tracker_steps !== 'due') continue;
    const pr = t.result?.pr;
    if (s.dry) { yield say(t.key, 'advanced', `${t.key} tracker steps (dry run): would comment PR #${pr} and move it to §4 Review state`); continue; }
    if (!s.tracker.has(t.key) || pr == null) { yield set(t.key, 'tracker_steps=none'); continue; }
    const body = `PR #${pr}, opened by a cloud session: https://github.com/${s.repo}/pull/${pr} ${cloudMark(t.key)}`;
    const did = []; const asks = []; let failed = null;
    if (s.comment !== 'yes') asks.push(`config §3 ${s.commentRow} is "${s.comment}": post the PR link with desk-jira comment ${t.key} "${body}"`);
    else {
      const r = yield { type: 'post-once', key: t.key, mark: cloudMark(t.key), body };
      if (!r?.ok) failed = r?.read === false ? `its comments could not be read (${r?.out})` : `the PR-link comment was refused (${r?.out})`;
      else if (r.posted) did.push(`commented the link to PR #${pr}`);
    }
    if (!failed && s.review && !isNone(s.review)) {
      if (s.move !== 'yes') asks.push(`config §3 ${s.moveRow} is "${s.move}": move it to ${s.review} with desk-jira transition ${t.key} <the transition to ${s.review}> (desk-jira transitions ${t.key} lists them)`);
      else {
        const st = yield { type: 'status', key: t.key };
        if (!st?.ok || !st.status) failed = `its status could not be read (${st?.out})`;
        else if (!same(st.status, s.review) && !same(st.status, s.done)) {
          const list = yield { type: 'transitions', key: t.key };
          const to = list?.ok ? list.list.find((x) => same(x.to, s.review)) : null;
          if (!list?.ok) failed = `its transitions could not be read (${list?.out})`;
          else if (!to) asks.push(`no transition from ${st.status} leads to ${s.review}: move it by hand (desk-jira transitions ${t.key} lists what it can do)`);
          else {
            const r = yield { type: 'transition', key: t.key, id: to.id };
            if (r?.ok) did.push(`moved it from ${st.status} to ${s.review}`); else failed = `the move to ${s.review} was refused (${r?.out})`;
          }
        }
      }
    }
    if (failed) { yield say(t.key, 'failed', `${t.key}: cloud PR #${pr}'s tracker steps not all made, ${failed}: tried again next pass`); continue; }
    yield set(t.key, `tracker_steps=${s.now}`);
    if (did.length) yield say(t.key, 'advanced', `${t.key} cloud PR #${pr} → tracker: ${did.join(', and ')}`);
    for (const a of asks) yield say(t.key, 'waiting', `${t.key}: cloud PR #${pr}'s tracker step is yours: ${a}`);
  }
}
