// The tool calls a worker log (claude's stream-json) shows refused or ending in error, read once for
// phase0-report.mjs's denial counts and levers-trips.mjs's trips.
//
//   import { toolOutcomes, bashCalls, codexCalls } from './log-tool-calls.mjs'
//   toolOutcomes(text) -> [{ line, session, tool, input, denied, exit, text }]
//   bashCalls(text)    -> [{ line, session, command, exit }], every Bash call with a result, 0 when it
//                         did not error, null when it was refused
//   codexCalls(text)   -> bashCalls narrowed to the review's desk-codex finder and refuter calls
//   waitCalls(text)    -> [{ line, session, kind }], each desk-wait, ps, tail or TaskStop call
export const DENIED = /Permission to use \S+.*\bdenied\b/;
const EXIT = /^Exit code (\d+)/;
export const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text ?? '').join('\n') : '');
const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

// Every tool call's outcome in a stream-json log, in order, once per tool_use id: a permission_denied
// event, or a tool result. `line` is the 1-based line it is on, `session` the start that line is in,
// `body` the result's text (null for a permission_denied event), `error` whether it errored and
// `denied` whether it was refused.
function outcomes(text) {
  const out = [];
  const calls = new Map();
  const seen = new Set();
  let session = null;
  String(text ?? '').split('\n').forEach((raw, i) => {
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    if (d?.type === 'system' && d.subtype === 'init') { session = d.session_id ?? null; return; }
    const push = (id, tool, o) => {
      if (id && seen.has(id)) return;
      if (id) seen.add(id);
      const c = calls.get(id);
      out.push({ line: i + 1, session, tool: tool ?? c?.name ?? null, input: c?.input ?? null, ...o });
    };
    if (d?.type === 'assistant') {
      for (const c of d.message?.content ?? []) if (c?.type === 'tool_use') calls.set(c.id, { name: c.name, input: c.input });
    } else if (d?.type === 'system' && d.subtype === 'permission_denied') {
      push(d.tool_use_id, d.tool_name, { error: true, denied: true, body: null });
    } else if (d?.type === 'user') {
      for (const c of d.message?.content ?? []) {
        if (c?.type !== 'tool_result') continue;
        const body = textOf(c.content);
        push(c.tool_use_id, null, { error: !!c.is_error, denied: !!c.is_error && DENIED.test(body), body });
      }
    }
  });
  return out;
}

// Each call refused (a permission_denied event, or an errored result whose text says denied) or ending
// in a non-zero exit, in order, once per tool_use id, with the 1-based line its outcome is on and the
// session of the start that line is in. `text` is the result's first line after any `Exit code` line.
export function toolOutcomes(text) {
  const out = [];
  for (const { line, session, tool, input, error, denied, body } of outcomes(text)) {
    if (denied) { out.push({ line, session, tool, input, denied: true, exit: null, text: body == null ? null : firstLine(body) }); continue; }
    const m = error ? EXIT.exec(body.trim()) : null;
    if (m && Number(m[1]) !== 0) out.push({ line, session, tool, input, denied: false, exit: Number(m[1]), text: firstLine(body.trim().split('\n').slice(1).join('\n')) });
  }
  return out;
}

// Every Bash call that has a result, in order, once per tool_use id, with the 1-based line of its
// result: `exit` is the result's `Exit code` (0 for one that did not error), null for a refused call or
// an error with no exit code.
export function bashCalls(text) {
  return outcomes(text).filter((o) => o.tool === 'Bash').map(({ line, session, input, error, denied, body }) => {
    const m = error && !denied ? EXIT.exec(body.trim()) : null;
    return { line, session, command: String(input?.command ?? ''), exit: !error ? 0 : m ? Number(m[1]) : null };
  });
}

// The calls a worker spends waiting on its own suite or the test lock, so a report can count them per
// session: `desk-wait` (desk-wait.mjs, any path before it), `ps` or `tail` (a Bash call that
// starts with one), or `TaskStop` (the tool, or the KillShell and KillBash it replaced). In order, once
// per tool_use id, as [{ line, session, kind }]; a call refused still counts, since it cost a turn.
const WAIT_CALL = /(?:^|[\s/;&|])desk-wait\.mjs(?:\s|$)/;
const LEADING = /^\s*(?:\S*\/)?(ps|tail)(?:\s|$)/;
export function waitCalls(text) {
  const out = [];
  for (const { line, session, tool, input } of outcomes(text)) {
    let kind = null;
    if (['TaskStop', 'KillShell', 'KillBash'].includes(tool)) kind = 'TaskStop';
    else if (tool === 'Bash') {
      const cmd = String(input?.command ?? '');
      kind = WAIT_CALL.test(cmd) ? 'desk-wait' : LEADING.exec(cmd)?.[1] ?? null;
    }
    if (kind) out.push({ line, session, kind });
  }
  return out;
}

// A review's call through desk-codex for a finder or a refutation, any path before it.
const CODEX_CALL = /(?:^|[\s/;&|])desk-codex(?:\.mjs)?\s+(?:finder|refuter)(?:\s|$)/;
export const codexCalls = (text) => bashCalls(text).filter((c) => CODEX_CALL.test(c.command));
