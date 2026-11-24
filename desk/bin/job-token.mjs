// tests/run.sh's job tokens: with the machine profile's job-tokens row on, each suite run.sh starts
// holds one token from the broker's job pool (leases.mjs, slot job), test-lock-slots x test-cap across
// the machine, so the suites running at once are bounded per suite rather than per whole run.
//
//   node job-token.mjs lever                                  # on or off; a value but on or off is off
//   node job-token.mjs take --pid <owner> --worktree <dir> -- <suite>   # waits for a token; prints its id
//   node job-token.mjs release <id> --pid <owner>             # gives it back
//
// `take` waits in the job pool's queue, oldest first, for as long as it takes, saying once on stderr
// what it waits on and its place. The owner is the run.sh job that runs the suite: its token is
// released when the suite exits, and lapses at the broker's next command where that job exits first
// (a run.sh killed mid-run).
//
// Exit codes: 0 granted, released, or the lever is off (nothing printed); 2 usage; 4 the lease store is
// unreadable; 1 the broker failed otherwise. run.sh runs the suite without a token on any failure.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { EXIT_OK, EXIT_UNREADABLE, LeaseStoreError, acquire, capacities, poolOf, release } from './leases.mjs';
import { JOB_TOKENS_KEY, jobTokensOn } from './machine.mjs';
import { tilde } from './logins.mjs';

// Each waiting try reads the process table, and a suite takes seconds, so once a second is enough.
const POLL_MS = 1000;
// A slot lease is held while its owner lives whatever its TTL, so this only dates it.
const TTL_S = 600;
const on = () => jobTokensOn(E.machineValue(JOB_TOKENS_KEY));

const USAGE = 'usage: job-token.mjs lever | take --pid <owner> --worktree <dir> -- <suite> | release <id> --pid <owner>';
const pidOf = (v) => (/^\d+$/.test(v ?? '') && Number(v) > 0 ? Number(v) : null);

function take(pid, worktree, suite) {
  if (!on()) return EXIT_OK;
  const say = (s) => console.error(s);
  try {
    const p = poolOf('slot', 'job', capacities(E));
    const r = acquire({ kind: 'slot', key: 'job', units: 1, ttl: TTL_S, label: `job ${suite} in ${tilde(worktree)}`, pid, wait: Infinity,
      queue: { worktree, cmd: suite, express: false } }, {
      env: E, mode: 'on', caps: () => capacities(E), poll: POLL_MS,
      onWait: (why, at) => say(`run.sh: ${suite} waits for ${p.one} (${p.capacity} on this machine)${at ? `, position ${at.position} of ${at.waiting}` : ''}: ${why}`),
    });
    if (r.lease) console.log(r.lease.id);
    return r.code;
  } catch (e) {
    if (e instanceof LeaseStoreError) { say(`run.sh: leases were unreadable (${e.message}), so ${suite} runs without a job token`); return EXIT_UNREADABLE; }
    say(`run.sh: the lease broker failed (${e.message}), so ${suite} runs without a job token`);
    return 1;
  }
}

function cli(argv) {
  const [sub, ...rest] = argv;
  const at = rest.indexOf('--');
  const head = at < 0 ? rest : rest.slice(0, at);
  const opt = (n) => { const i = head.indexOf(`--${n}`); return i < 0 ? null : head[i + 1]; };
  if (sub === 'lever' && !rest.length) { console.log(on() ? 'on' : 'off'); return EXIT_OK; }
  if (sub === 'take') {
    const pid = pidOf(opt('pid')), worktree = opt('worktree'), words = at < 0 ? [] : rest.slice(at + 1);
    if (pid && worktree && words.length === 1) return take(pid, worktree, words[0]);
  }
  if (sub === 'release') {
    const pid = pidOf(opt('pid')), id = head[0];
    if (pid && id && !id.startsWith('--')) {
      try { return release(id, pid, { env: E }).code; } catch (e) { console.error(`run.sh: job token ${id} was not released (${e.message}); it lapses when its owner exits`); return 1; }
    }
  }
  console.error(USAGE);
  return 2;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) process.exit(cli(process.argv.slice(2)));
