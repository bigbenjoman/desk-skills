// A worker cannot make Jira issue links (worker contract Stage 8), so it asks the pass for one with
//   AUTOPILOT_LINK: <KEY> <type> <OTHER>
// one per line, the arguments `desk-jira link` takes. The pass reads them when the worker ends on DONE
// or PARK, and makes each one config §3 jira-edit grants; it keeps why it did not make any other, with
// the command, as a follow-on step on the ticket (pass.mjs keepLinks).
//
// A request is made only between two tickets of the worker's own project, and never of the Blocks type
// (Blocks, blocks, blocked-by): those change the order a batch spawns in, so they stay the person's.

export const LINK_MARK = 'AUTOPILOT_LINK';

const KEY = /^[A-Z][A-Z0-9]*-[0-9]+$/;
const project = (key) => String(key).replace(/-[0-9]+$/, '');
// A type as desk-jira link matches it: any case, hyphens or underscores for spaces, "is" optional.
const norm = (w) => w.toLowerCase().replace(/[-_\s]+/g, ' ').trim().replace(/^is /, '');
const BLOCKS = new Set(['blocks', 'blocked by']);

// The command that makes a request, as the person would run it.
export const linkCommand = (r) => `desk-jira link ${r.key} ${r.type} ${r.other}`;

// Each distinct AUTOPILOT_LINK request in [name, value] markers, in order: { raw, key, type, other },
// with `why` set on one that does not read.
export function linkRequests(markers) {
  const seen = new Set();
  const out = [];
  for (const [k, v] of markers) {
    if (k !== LINK_MARK) continue;
    const raw = String(v ?? '').trim();
    if (seen.has(raw)) continue;
    seen.add(raw);
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length !== 3) { out.push({ raw, why: 'not "<KEY> <type> <OTHER>"' }); continue; }
    const [key, type, other] = parts;
    out.push({ raw, key, type, other });
  }
  return out;
}

// Whether the pass may make request `r` for ticket `ticket`: { make: true } or { make: false, why }.
// `perm` is config §3 jira-edit; `onJira` whether §4 Tracker is jira.
export function linkCall(r, { ticket, perm, onJira }) {
  if (r.why) return { make: false, why: `the request does not read (${r.why}): ${r.raw}` };
  if (!onJira) return { make: false, why: `the tracker is not Jira, so there is nothing to link: ${r.raw}` };
  for (const k of [r.key, r.other]) if (!KEY.test(k)) return { make: false, why: `${k} is not an issue key: ${r.raw}` };
  if (r.key === r.other) return { make: false, why: `an issue cannot be linked to itself: ${r.raw}` };
  const own = project(ticket);
  const outside = [r.key, r.other].find((k) => project(k) !== own);
  if (outside) return { make: false, why: `${outside} is not in ${ticket}'s project ${own}, so the pass does not link it: ${linkCommand(r)}` };
  if (BLOCKS.has(norm(r.type))) return { make: false, why: `a Blocks link changes the order tickets spawn in, so it is yours to make: ${linkCommand(r)}` };
  if (perm !== 'yes') return { make: false, why: `config §3 jira-edit is "${perm}", so the pass did not make it: ${linkCommand(r)}` };
  return { make: true };
}

// Whether `desk-jira link` output says the link is there, read back.
export const linkMade = (out) => /^(linked: .* \(read back\)|already linked: )/m.test(String(out ?? ''));
