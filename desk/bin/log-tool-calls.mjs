// The tool calls a worker log (claude's stream-json) shows refused or ending in error, read once for
// phase0-report.mjs's denial counts and levers-trips.mjs's trips.
//
//   import { toolOutcomes } from './log-tool-calls.mjs'
//   toolOutcomes(text) -> [{ line, session, tool, input, denied, exit, text }]
export const DENIED = /Permission to use \S+.*\bdenied\b/;
const EXIT = /^Exit code (\d+)/;
export const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text ?? '').join('\n') : '');
const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

// Each call refused (a permission_denied event, or an errored result whose text says denied) or ending
// in a non-zero exit, in order, once per tool_use id, with the 1-based line its outcome is on and the
// session of the start that line is in. `text` is the result's first line after any `Exit code` line.
export function toolOutcomes(text) {
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
      push(d.tool_use_id, d.tool_name, { denied: true, exit: null, text: null });
    } else if (d?.type === 'user') {
      for (const c of d.message?.content ?? []) {
        if (c?.type !== 'tool_result' || !c.is_error) continue;
        const body = textOf(c.content);
        if (DENIED.test(body)) push(c.tool_use_id, null, { denied: true, exit: null, text: firstLine(body) });
        else {
          const m = EXIT.exec(body.trim());
          if (m && Number(m[1]) !== 0) push(c.tool_use_id, null, { denied: false, exit: Number(m[1]), text: firstLine(body.trim().split('\n').slice(1).join('\n')) });
        }
      }
    }
  });
  return out;
}
