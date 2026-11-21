// The "evidence failures" step of a pass, as a decision: drafts whose evidence run failed, or filled no
// cell (undraft.mjs `evidence-failed`). The failure is the repo's, so one fix ticket is filed and
// admitted for each failure (the workflow and its run log's first error line, evidence.mjs failureKey),
// and every PR it fails waits on that ticket rather than going to the person. Once the ticket is done,
// each waiting PR's run is started again at its head; one that then fails the same way, or whose fix
// failed or left the batch, is the person's.
//
// A generator run by runSteps (run-phase.mjs): where a fix stands, admitting it, filing it and starting
// a run again are yielded, and what each handler returns is what the yield gives back. Before filing,
// the decision groups the failures and asks for each fix; after, it settles each PR on what was filed.
// Pure: it reads only the snapshot and those answers.
//
// The snapshot:
//   items   [{ t, n, head, c, rec, cells, log }] for each draft whose call is `evidence-failed`, in the
//           order the drafts were read: t its ticket, c the undraft call, rec the undraft record so far,
//           cells its PR body's screenshot cells, log its run's failed log ('' for a run that did not
//           fail, null where it could not be read)
//   fixes   the fixes started so far (evidence.mjs readFixes), not changed by the decision
//   at      the pass's time, PASS_AT
//   dry     a dry run: nothing is filed, admitted or written
//
// The actions:
//   { type: 'out', line }                       a line for the report's list of changes
//   { type: 'report', key, list, line }         a line for the pass's report list `list`
//   { type: 'save-undraft', key, rec }          the ticket's undraft record, saved where it changed
//   { type: 'fix-state', fix }                  where fix ticket `fix` stands (a yield, given back as
//                                               { st: 'done' | 'open' | 'gone' | 'lost', at? })
//   { type: 'admit', fix }                      admit `fix` again (a yield, given back as { ok, why })
//   { type: 'file', group }                     file and admit the fix for one failure (a yield, given
//                                               back as { fix, why } or { why } when none was filed)
//   { type: 'start-evidence', key, n, head, c, rec }  start the PR's evidence run again (a yield, given
//                                               back as the undraft record after it)
//   { type: 'write-fixes', fixes }              the fixes, as the step leaves them
import { firstErrorLine, failureKey, evidenceFixPlan } from '../evidence.mjs';

const out = (line) => ({ type: 'out', line });
const save = (t, rec) => ({ type: 'save-undraft', key: t.key, rec });
const prList = (prs) => prs.map((p) => `#${p.n}`).join(', ');
const cap = (s) => `${s[0].toUpperCase()}${s.slice(1)}`;

export function* decideEvidenceFailures(s) {
  const fixes = structuredClone(s.fixes ?? {});
  const failures = [];
  for (const it of s.items) {
    const { t, n, c } = it;
    if (it.log == null) {
      yield out(`undraft: PR #${n} (${t.key}) stays draft for now: ${c.why}, and its run's log could not be read; the next pass tries again`);
      yield save(t, { ...it.rec, call: 'wait', why: `${c.why}; its run's log is read at the next pass`, action: null });
      continue;
    }
    const line = firstErrorLine(it.log);
    failures.push({ ...it, ticket: t.key, key: failureKey(c.workflow, line), workflow: c.workflow, line, run: c.runId, url: c.url, at: c.at ?? null });
  }
  // Where each fix stands. Done is kept, with when, so a fix whose ticket has left the queue still
  // reads as done and a failure that comes back after it is told apart. One in no batch is admitted
  // again, and so is one filed but refused by admission.
  const states = {};
  for (const rec of Object.values(fixes)) {
    if (!rec.fix) continue;
    const st = rec.done_at ? { st: 'done' } : yield { type: 'fix-state', fix: rec.fix };
    if (st.st === 'done' && !rec.done_at) rec.done_at = st.at ?? s.at;
    if (st.st === 'lost' && rec.admitted !== false) { rec.admitted = false; rec.admit_error = `${rec.fix} is in no batch`; }
    states[rec.fix] = st.st === 'lost' ? 'open' : st.st;
    if (rec.admitted === false && !s.dry) {
      const a = yield { type: 'admit', fix: rec.fix };
      if (a.ok) { rec.admitted = true; delete rec.admit_error; } else rec.admit_error = a.why;
    }
  }
  const plan = evidenceFixPlan(failures, fixes, (fix) => states[fix] ?? 'open');
  const filed = new Map();
  for (const g of plan.file) {
    if (s.dry) { yield out(`undraft (dry run): would file and admit one fix for \`${g.key}\`, for PR(s) ${prList(g.prs)}`); continue; }
    const f = yield { type: 'file', group: g };
    filed.set(g.key, f);
    if (f.fix) fixes[g.key] = { workflow: g.workflow, line: g.line, run: g.run, url: g.url, fix: f.fix, at: s.at, admitted: !f.why, ...(f.why ? { admit_error: f.why } : {}), prs: {} };
    yield out(f.fix ? `evidence: filed ${f.fix} to fix \`${g.key}\` for PR(s) ${prList(g.prs)}${f.why ? `, but it was not admitted (${f.why})` : ', admitted to the batch'}`
      : `evidence: no fix filed for \`${g.key}\`: ${f.why}`);
  }
  // A failure no fix could be started or admitted for is one item for the person, on the lowest PR it
  // fails (so the item stays put from pass to pass), naming the others, which wait on it.
  const stuck = (p) => (p.call === 'file' || p.call === 'wait') && (!(p.fix ?? filed.get(p.key)?.fix) || fixes[p.key]?.admitted === false);
  const lead = new Map();
  for (const p of plan.prs) if (stuck(p)) lead.set(p.key, [...(lead.get(p.key) ?? []), p.n].sort((a, b) => a - b));
  for (const p of plan.prs) {
    const { t, n, head, c } = p;
    let rec = p.rec;
    const fix = p.fix ?? filed.get(p.key)?.fix ?? null;
    const fr = fix ? fixes[p.key] : null;
    const err = p.line ? `: "${p.line}"` : '';
    const person = (why) => {
      rec = { ...rec, call: 'person', why: `${c.why}${err}; ${why}`, action: c.action };
      return { type: 'report', key: t.key, list: 'waiting', line: `${t.key}: DRAFT — PR #${n} stays draft: ${rec.why}. ${cap(c.action)}` };
    };
    if (s.dry && p.call === 'file') { yield save(t, rec); continue; }
    if (p.call === 'person') yield person(p.why);
    else if (stuck(p)) {
      const [first, ...rest] = lead.get(p.key);
      const why = fix ? `${fix} was filed to fix it for the repo but not admitted (${fr.admit_error ?? 'refused'}): /desk-admit ${fix}`
        : `no fix could be started for it for the repo (${filed.get(p.key)?.why ?? 'none filed'})`;
      if (n === first) yield person(`${why}${rest.length ? `. PR(s) ${rest.map((x) => `#${x}`).join(', ')} fail the same way and wait on this` : ''}`);
      else {
        rec = { ...rec, call: 'evidence-fix', why: `${c.why}${err}; ${fix ? `${fix} fixes it` : 'its fix'} once PR #${first}'s item is settled`, action: null };
        yield out(`undraft: PR #${n} (${t.key}) stays draft: ${rec.why}`);
      }
    } else if (p.call === 'rerun') {
      const prev = fr.prs[n]?.rerun ?? null;
      rec = yield {
        type: 'start-evidence', key: t.key, n, head,
        c: { workflow: c.workflow, why: `${fix} fixed its evidence workflow \`${c.workflow}\`, so it runs again`, cells: p.cells },
        rec: { ...rec, call: 'evidence', why: `${fix} fixed its evidence workflow, so it runs again`, action: null },
      };
      // Only a run that started counts as run again: one GitHub refused is started at the next pass.
      fr.prs[n] = { ticket: t.key, head, rerun: rec.call === 'person' ? prev : head };
    } else {
      fr.prs[n] = { ticket: t.key, head, rerun: fr.prs[n]?.rerun ?? null };
      rec = { ...rec, call: 'evidence-fix', why: `${c.why}${err}; ${fix} fixes it for the repo, then the run is started again`, action: null };
      yield out(`undraft: PR #${n} (${t.key}) stays draft: ${rec.why}`);
    }
    yield save(t, rec);
  }
  if (!s.dry) yield { type: 'write-fixes', fixes };
}
