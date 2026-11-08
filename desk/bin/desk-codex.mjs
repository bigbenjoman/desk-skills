#!/usr/bin/env node
// The one way a review runs codex with the codex lever on (config §3b Phase 0 levers).
//
//   desk-codex probe                         CODEX_OK, from a passing probe under an hour old or a new one
//   desk-codex finder  [--cd <dir>] <prompt>  the cold finder's call
//   desk-codex refuter [--cd <dir>] <prompt>  one refutation
//   desk-codex settings                      the model, effort and timeout each role runs at
//
// Every call is `codex exec --sandbox read-only --skip-git-repo-check` with the model and effort config
// §3b "Codex review" names for its role, passed on the command line so ~/.codex/config.toml's own
// model and effort never apply. Its stdin is /dev/null, so it never waits on a terminal. Stdout is
// codex's final message alone, read from its --output-last-message file: the progress codex prints
// is dropped. A call still running at the row's timeout is ended, with its process group, and prints
// `desk-codex: timed out after <n>s` on stderr, exit 124: the review records that seat as died.
// A worker can pass no codex flag through this: only a role, --cd and the prompt.
//
// With more than one Codex login, each call and probe runs on the one codex-login.mjs picks, with
// CODEX_HOME set for it, and says `desk-codex: on Codex login <name>` on stderr for the review record.
// With every usable Codex login at its limit no call runs: it says why, naming the earliest reset, exit
// 75, and the review records the seat as died.
//
// Exit: 0 answered · codex's own non-zero exit · 124 timed out · 75 no Codex login can take it · 2 usage
// · 3 lever off or §3 refuses.
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as E from './desk-env.mjs';
import { codexCallLogin } from './codex-login.mjs';
import { codexExec, execArgs } from './codex-exec.mjs';

const PROBE_PROMPT = 'Reply with exactly: CODEX_OK';
const PROBE_FRESH_MS = 60 * 60 * 1000;
const say = (m) => process.stderr.write(`desk-codex: ${m}\n`);
const usage = () => { say('usage: desk-codex probe | finder [--cd <dir>] <prompt> | refuter [--cd <dir>] <prompt> | settings'); process.exit(2); };

let cfg;
try {
  if (!E.leverOn('codex')) { say('the codex lever is off (config §3b Phase 0 levers): run codex as the review skill says for the lever off'); process.exit(3); }
  if (E.permission('codex-review') === 'no') { say('config §3 codex-review is no: nothing is sent to codex'); process.exit(3); }
  cfg = E.codexReview();
} catch (e) { say(e.message); process.exit(3); }

const describe = () => `finder ${cfg.finder.model} at ${cfg.finder.effort} · refuter ${cfg.refuter.model} at ${cfg.refuter.effort} · timeout ${cfg.timeout}s`;

// The login this call runs on, picked once per call. Settings needs none.
let pick = { login: null, env: process.env, dead: null };
const choose = () => {
  try { pick = codexCallLogin(); } catch (e) { pick = { dead: `the Codex logins could not be read (${e.message})` }; }
  if (pick.dead) { say(`${pick.dead}, so no codex call ran`); process.exit(75); }
};
const onLogin = () => pick.login?.name ?? null;

// The last probe result, per repo, in the state directory a worker is granted, and the Codex login it
// ran on when there is a choice. Any answered call counts as a pass and any failed one as a failure, so
// a seat that ran out of usage is not reused, and a pass on one login says nothing about another.
const recordPath = () => { try { return join(E.stateDir(), 'codex-probe.json'); } catch { return null; } };
const readRecord = () => { try { return JSON.parse(readFileSync(recordPath(), 'utf8')); } catch { return null; } };
const writeRecord = (ok) => {
  const p = recordPath();
  if (!p) return;
  const login = onLogin();
  try { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, `${JSON.stringify({ ok, at: new Date().toISOString(), ...(login ? { login } : {}) })}\n`); } catch { /* unrecorded: the next probe runs */ }
};

function run(role, prompt, cd) {
  const { model, effort } = role === 'probe' ? cfg.refuter : cfg[role];
  const dir = mkdtempSync(join(tmpdir(), 'desk-codex-'));
  const last = join(dir, 'last-message.txt');
  if (onLogin()) say(`on Codex login ${onLogin()}`);
  // Sets the exit code and returns, never process.exit: a pipe write on macOS is asynchronous, and
  // exiting at once would cut a long final message short.
  codexExec({ args: execArgs({ sandbox: 'read-only', cd, model, effort, last, prompt }), last, env: pick.env, timeout: cfg.timeout }).then(({ code, timedOut, message: msg, tail, error }) => {
    rmSync(dir, { recursive: true, force: true });
    if (error) { writeRecord(false); say(`codex did not start: ${error}`); process.exit(127); }
    if (timedOut) { writeRecord(false); say(`timed out after ${cfg.timeout}s (${role}, ${model} at ${effort})`); process.exitCode = 124; return; }
    const answered = code === 0 && msg.trim() !== '' && (role !== 'probe' || msg.includes('CODEX_OK'));
    writeRecord(answered);
    if (msg) process.stdout.write(msg.endsWith('\n') ? msg : `${msg}\n`);
    if (code !== 0) { say(`codex exited ${code} (${role}, ${model} at ${effort}): ${tail.trim().split('\n').slice(-5).join(' | ') || 'no error text'}`); process.exitCode = code; return; }
    if (!answered) { say(`codex answered ${msg.trim() ? 'without CODEX_OK' : 'with no final message'} (${role}, ${model} at ${effort})`); process.exitCode = 1; return; }
    if (role === 'probe') say(describe());
    process.exitCode = 0;
  });
}

const [role, ...rest] = process.argv.slice(2);
if (role === 'settings') {
  if (rest.length) usage();
  console.log(`finder=${cfg.finder.model}:${cfg.finder.effort} refuter=${cfg.refuter.model}:${cfg.refuter.effort} timeout=${cfg.timeout}`);
} else if (role === 'probe') {
  if (rest.length) usage();
  choose();
  const r = readRecord();
  const age = r?.ok === true && (r.login ?? null) === onLogin() ? Date.now() - Date.parse(r.at) : NaN;
  if (age >= 0 && age < PROBE_FRESH_MS) {
    console.log('CODEX_OK');
    say(`a probe passed ${Math.round(age / 60000)} min ago${onLogin() ? ` on Codex login ${onLogin()}` : ''}, so none ran · ${describe()}`);
  } else run('probe', PROBE_PROMPT);
} else if (E.CODEX_ROLES.includes(role)) {
  let cd = null;
  if (rest[0] === '--cd') {
    cd = rest[1];
    try { if (!cd || !statSync(cd).isDirectory()) throw new Error(); } catch { say(`--cd ${cd ?? ''} is not a directory`); process.exit(2); }
    rest.splice(0, 2);
  }
  if (rest.length !== 1 || !rest[0].trim()) usage();
  choose();
  run(role, rest[0], cd);
} else usage();
