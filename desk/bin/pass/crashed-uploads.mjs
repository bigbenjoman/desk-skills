// The "crashed uploads" step of a pass, as a decision: which tickets' crashed screenshot uploads are
// tried again, dropped or found already filled. Pure: it reads only the snapshot it is given.
//
// An upload that crashed is tried again from the directory it was given, not from a round's log line:
// a ticket requeued for a fix starts a round whose log names no screenshots. A running worker is left
// to finish, since it may still edit the body, and a PR the ticket has moved off drops the record.
//
// The snapshot:
//   tickets   the queue's tickets, by key
//   allowed   §3 pr-images is yes, or the person approved this pass's uploads
//   uploaded  a Set of the keys whose upload already ran or was recorded this pass
//   now       the time, in ms
//   bodies    { [pr]: { body, why } } for each PR crashedUploadBodies names: body null where it
//             could not be read, why the read's last line of output
import { dragCells } from '../evidence.mjs';
import { UPLOAD_TRIES } from '../undraft.mjs';

// What t's crash calls for before its PR body is read: null for nothing, 'moved' when the ticket's PR
// is no longer the one that crashed, 'body' when the body decides.
function screen(t, s) {
  const c = t.upload_crash;
  if (!c || t.state === 'running' || s.uploaded.has(t.key) || (!c.busy && !c.throttled && c.tries >= UPLOAD_TRIES)) return null;
  if (Date.parse(c.throttled) > s.now) return null;
  const cur = t.result?.pr ?? t.draft_pr;
  return cur != null && Number(cur) !== Number(c.pr) ? 'moved' : 'body';
}

// The PRs whose bodies the decision needs, given a snapshot without `bodies`.
export function crashedUploadBodies(s) {
  if (!s.allowed) return [];
  return [...new Set(Object.values(s.tickets).filter((t) => screen(t, s) === 'body').map((t) => t.upload_crash.pr))];
}

// -> actions, in ticket order:
//   { type: 'set', key, fields }            queue fields to set on the ticket
//   { type: 'report', key, list, line }     a line for the pass's report list `list`
//   { type: 'upload', key, pr, dir }        put the ticket's screenshots in PR #pr's body from dir
export function decideCrashedUploads(s) {
  if (!s.allowed) return [];
  const out = [];
  for (const t of Object.values(s.tickets)) {
    const step = screen(t, s);
    if (!step) continue;
    const c = t.upload_crash;
    if (step === 'moved') { out.push({ type: 'set', key: t.key, fields: ['upload_crash=null'] }); continue; }
    // A body with no cell left was filled after all (the crash came after the uploader's edit, or the
    // evidence workflow filled it): uploading again would duplicate its assets and read as incomplete.
    const { body, why } = s.bodies?.[c.pr] ?? { body: null, why: 'its body was not read' };
    if (body == null) {
      out.push({ type: 'report', key: t.key, list: 'failed', line: `${t.key}: the crashed upload to PR #${c.pr} waits for the next pass, since its body could not be read (${why})` });
      continue;
    }
    if (!dragCells(body)) {
      out.push({ type: 'set', key: t.key, fields: ['upload_crash=null', 'images_uploaded=true'] },
        { type: 'report', key: t.key, list: 'advanced', line: `${t.key} #${c.pr} has no screenshot cell left, so its crashed upload is not tried again` });
      continue;
    }
    out.push({ type: 'upload', key: t.key, pr: String(c.pr), dir: c.dir });
  }
  return out;
}
