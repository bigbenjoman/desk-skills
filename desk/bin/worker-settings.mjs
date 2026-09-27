#!/usr/bin/env node
// Generate the --settings file for a headless worker or a triage pass.
//
//   worker-settings.mjs worker --ticket <TICKET> --wt <worktree> --out <file>
//                              [--branch <branch>] [--database <name|none|shared>] [--dry]
//   worker-settings.mjs triage --ticket <TICKET> --out <file>
//
// Prints one `CONFIG_DENIED: <§3 key> (<setting>)` line per capability the user's config §3 does not
// grant, so the spawner can tell the worker what it must park on instead of attempting; one
// `CONFIG_WARN: <text>` line per configured command that could not be allow-listed; and, in worker
// mode, one `TOOLCHAIN_PROBE: <command>` line per toolchain binary: the harmless `<bin> --version`
// (behind §4 Command prefix) the preflight runs to prove each allow rule actually executes.
//
// THE MODEL: an explicit allow-list. The worker runs under `dontAsk`, which refuses anything no allow
// rule matches, so safety comes from what is ALLOWED, and the deny list is a second line for the forms
// that matter most. Nothing is allowed wholesale that can run another program or change git's or gh's
// own configuration:
//   - git: named read and local-write subcommands only (status, diff, log, show, add, commit, restore,
//     checkout/switch, rebase, merge, fetch, clean, ...). `git push` exists only as exact rules for the
//     ticket's own branch (--branch). `git config`, `git -c`, `git -C`, aliases (any unknown
//     subcommand), `git stash`, `rebase --exec` and `--upload-pack` are refused.
//   - gh: named read subcommands, plus `pr create --draft`, `pr edit`, `pr comment`, `pr review`,
//     `pr update-branch`, `run rerun` each only where its §3 row is `yes`. `gh api` (any method) and
//     `gh alias` are denied: a GET cannot be told from a write by prefix.
//   - the toolchain: the exact §4 command items (and their `<pm> run <script>` twins), behind §4
//     Command prefix where there is one; never the package manager, the prefix binary, node or python
//     by name. A command item with a directory runs through `with-lock.sh <lock> --cwd <dir> -- <cmd>`.
//   - database migrate and seed only where setup-worktree provisioned a per-ticket database.
//
// WHAT PREFIX RULES CANNOT STOP, said plainly: a worker edits code and then runs the repo's own test,
// build and dev commands, and git runs the repo's own hooks; all of that executes code the worker
// wrote. The allow-list stops the ordinary command forms (pushing elsewhere, merging, rewriting git
// or gh config, reaching another worktree, a production database URL) and leaves the rest to the
// worker contract, the preflight, and the orchestrator reviewing every PR before it merges. Also:
// the allowed local git subcommands (fetch, checkout, switch) can move a local branch that no
// worktree has checked out (git refuses for any branch that is); nothing local reaches the remote
// except the exact pushes of the ticket's own branch. And a rule matches the command string, so
// output redirection inside an allowed command is the harness's to police, not this list's.
//
// Hard-won details, each of which failed silently once:
//   - A worker's fs access is scoped to its cwd, and `.claude/` is write-protected, so the skills
//     tree and its own state dir both need explicit grants (additionalDirectories, for reading).
//   - Neither permission mode is sufficient alone. `acceptEdits` auto-approves edits but denies Bash;
//     `dontAsk` allows allow-listed Bash but denies edits. So grant BOTH explicitly: Edit/Write
//     scoped to the worktree, plus the Bash allow-list. Deny still wins over allow.
//   - File rules are Edit(...) only. Claude Code matches every file-writing tool against Edit rules
//     and IGNORES Write(...) rules (it says so at startup), so a Write deny protects nothing.
//   - Absolute paths in Edit rules need a DOUBLE leading slash: Edit(//abs/...) is honoured,
//     Edit(/abs/...) is SILENTLY IGNORED, in both directions.
//   - Workers are launched with --setting-sources "" (spawn-worker.sh, triage.sh), so the user's own
//     settings, which may allow Bash(*), never widen this list. That also drops the user-level
//     attribution hook, so it is re-registered here.
//   - A malformed --settings file is silently IGNORED in --print mode, handing the worker full
//     permissions while looking locked down. So this validates before writing.
//   - A denial reported by a worker may be the FILESYSTEM sandbox, not the rule list: /tmp (locks)
//     and /proc (meminfo) sit outside the worktree and need additionalDirectories.
//   - Bash rules match the command string as written. A binary allowed by name AND by absolute
//     path must be DENIED by both too, or `/usr/bin/git push` walks past a `git push` deny. So every
//     rule for a binary, allow or deny, is built by `bash()` below; never write one by hand.
import { writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { platform } from 'node:os';
import * as E from './desk-env.mjs';

const [mode, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i++) {
  const k = rest[i];
  if (k === '--dry') opt.dry = true;
  else if (k.startsWith('--')) opt[k.slice(2)] = rest[++i];
}
if (!['worker', 'triage'].includes(mode) || !opt.ticket || !opt.out || (mode === 'worker' && !opt.wt)) {
  console.error('usage: worker-settings.mjs worker --ticket <TICKET> --wt <worktree> --out <file> [--branch <b>] [--database <db|none|shared>] [--dry]\n       worker-settings.mjs triage --ticket <TICKET> --out <file>');
  process.exit(2);
}
if (!E.SAFE_ID.test(opt.ticket) || opt.ticket.includes('..')) { console.error(`FAIL: ticket '${opt.ticket}' is not a safe id`); process.exit(2); }

const which = (bin) => {
  try { return execFileSync('sh', ['-c', 'command -v "$1"', '_', bin], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
};
const abs = (p) => `/${p}`; // absolute path p -> //p, the only form the Edit/Write matcher honours
const tilde = (p) => (p.startsWith(`${E.HOME}/`) ? `~${p.slice(E.HOME.length)}` : null);
const formsCache = new Map();
// Every spelling a binary can be invoked by: bare name, the absolute path `command -v` resolves, and
// that path with ~ for $HOME.
const forms = (bin) => {
  if (!formsCache.has(bin)) {
    const out = [bin];
    const path = which(bin);
    if (path && path.startsWith('/')) out.push(path);
    const t = path && tilde(path);
    if (t) out.push(t);
    formsCache.set(bin, [...new Set(out)]);
  }
  return formsCache.get(bin);
};
// Three rule shapes, and mixing them fails silently (verified with `claude -p`):
//   - a pattern with no `*` is a PREFIX and gets `:*`:        Bash(git status:*)
//   - a pattern with a `*` is a GLOB and is written verbatim:  Bash(git * --upload-pack*)
//   - an EXACT rule has neither and matches only that string: Bash(git push origin fix/ABC-1)
// A rule with a `*` in the middle that also ends in `:*` never matches anything. `*` can match empty,
// so the spaces around it are part of the pattern. Never glob a short flag as `*-f*`: it matches
// branch names like `fix/ABC-1-foo`.
const rule = (f, pat) => (pat.includes('*') ? `Bash(${f}${pat})` : `Bash(${f}${pat}:*)`);
const bash = (bin, ...subs) => (subs.length ? subs : ['']).flatMap((sub) => forms(bin).map((f) => rule(f, sub)));
const exact = (bin, tail) => forms(bin).map((f) => `Bash(${f}${tail})`);
// A short flag anywhere in the arguments after `lead`, without matching it inside another word.
const shortFlag = (lead, flag) => [`${lead} ${flag}*`, `${lead} * ${flag}`, `${lead} * ${flag} *`];

// ---- this repo's config ----------------------------------------------------------------------
// A config row desk-env.mjs does not know yet (it throws on an unknown id) reads as unset.
const cfg = (id) => { try { return E.configValue(id); } catch { return null; } };
const cfgList = (id) => { try { const v = E.configValues(id); return v && !E.isNone(v) ? v : []; } catch { return []; } };
const isNone = (v) => v != null && /^none\b/i.test(String(v).trim());
const BIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
// Never allowed even as the exact configured command: a prefix rule for `rm -rf build` also matches
// `rm -rf build /`, and a shell, fetcher or privilege tool is an allow-everything. git, gh and docker
// have their own rules.
const NO_EXACT = new Set(['rm', 'sudo', 'doas', 'curl', 'wget', 'eval', 'exec', 'xargs', 'env', 'git', 'gh', 'docker',
  'cd', 'source', '.', 'sh', 'bash', 'zsh', 'dash', 'fish', 'nohup', 'time', 'timeout', 'npx', 'pnpx', 'bunx', 'uvx']);
// Words never probed with `--version` (not toolchain binaries).
const NOT_A_TOOL = new Set(['cd', 'source', '.', 'env', 'exec', 'time', 'nohup']);
// Porting check: `bun` below is one entry in a generic list of package managers §4 may name as
// forbidden, not a default toolchain. Nothing is allowed from this list; it only feeds deny rules.
const KNOWN_PMS = ['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'deno', 'uv', 'uvx', 'pip', 'pip3', 'pipx', 'poetry', 'pdm', 'hatch', 'cargo', 'go', 'gradle', 'mvn', 'bundle', 'composer', 'mix'];

const prefixRaw = cfg('command-prefix');
const PREFIX = prefixRaw && !isNone(prefixRaw) ? prefixRaw.trim() : '';
const pmItems = cfgList('package-manager');
const pmRaw = pmItems.join(' ');
const PM = pmItems.length ? (/^[^\s,;(]+/.exec(pmItems[0].trim())?.[0] ?? '') : '';
// "pnpm (npm, npx forbidden)" / `pnpm` `npm is forbidden`: every known package manager named after
// the primary one, in a value that says forbidden/blocked/never/not allowed, is denied.
const FORBIDDEN = pmRaw && /forbid|block|never|not allowed|banned|disallow/i.test(pmRaw)
  ? KNOWN_PMS.filter((b) => b !== PM && new RegExp(`(^|[^A-Za-z0-9_-])${b}([^A-Za-z0-9_-]|$)`).test(pmRaw.slice(PM.length)))
  : [];

// Which database the worktree was given (setup-worktree.sh's `database=` line). Migrate and seed
// write to a database, so they are allowed only against a per-ticket one.
const DATABASE = (opt.database ?? 'none').trim();
const HAS_TICKET_DB = /^[a-z0-9_]{1,63}$/.test(DATABASE) && !['none', 'shared', 'unknown'].includes(DATABASE);
const PG_CONTAINER = /^postgres container\s+(\S+)$/i.exec((cfg('local-db') ?? '').trim())?.[1] ?? null;

// The §4 command rows a worker may run, and the lock each takes when wrapped by with-lock.sh.
const LOCK_OF = { 'test-cmd': 'test', 'integration-cmd': 'test', 'typecheck-cmd': 'tsc', 'e2e-cmd': 'browser' };
const TOOL_IDS = ['install-cmd', 'dev-cmd', 'typecheck-cmd', 'lint-cmd', 'test-cmd', 'integration-cmd', 'e2e-cmd', 'build-cmd', 'agents-sync',
  ...(HAS_TICKET_DB ? ['db-migrate-cmd', 'seed-cmd'] : [])];
const warns = [];
const items = [];
for (const id of TOOL_IDS) {
  for (const raw of cfgList(id)) {
    const { dir, cmd } = E.parseCommandItem(raw);
    if (/&&|\|\||[;|<>`]|\$\(/.test(cmd) || /^\s*\w+=/.test(cmd)) {
      warns.push(`§4 ${E.CONFIG_ROWS[id].row} item "${raw}" is a compound or env-prefixed shell command — not allow-listed; write it as \`<dir>: <command>\``);
      continue;
    }
    const bin = cmd.split(/\s+/)[0];
    if (NO_EXACT.has(bin)) { warns.push(`§4 ${E.CONFIG_ROWS[id].row} item "${raw}" starts with ${bin}, which is never allow-listed`); continue; }
    items.push({ id, dir, cmd, bin });
  }
}
// `<pm> run <script>` and `<pm> <script>` are the same command for pnpm, yarn and bun (and for npm's
// lifecycle scripts), so allow the twin of each configured form.
const PM_BUILTINS = new Set(['install', 'i', 'add', 'remove', 'rm', 'exec', 'dlx', 'x', 'run', 'create', 'init', 'publish', 'link', 'unlink', 'update', 'up', 'upgrade', 'config', 'set', 'env', 'store', 'patch', 'pack']);
function twins(cmd) {
  const w = cmd.split(/\s+/);
  if (w[0] !== PM || w.length < 2) return [cmd];
  const npmLife = new Set(['test', 'start', 'stop', 'restart']);
  if (w[1] === 'run' && w[2] && !w[2].startsWith('-')) {
    if (PM !== 'npm' || npmLife.has(w[2])) return [cmd, [w[0], ...w.slice(2)].join(' ')];
  } else if (!w[1].startsWith('-') && !PM_BUILTINS.has(w[1]) && (PM !== 'npm' || npmLife.has(w[1])) && ['pnpm', 'yarn', 'bun', 'npm'].includes(PM)) {
    return [cmd, [w[0], 'run', ...w.slice(1)].join(' ')];
  }
  return [cmd];
}
const withPrefix = (c) => [c, ...(PREFIX ? [`${PREFIX} ${c}`] : [])];

const STATE = E.stateDir();
const BIN = E.binDir();
const BIN_FORMS = [BIN, ...(tilde(BIN) ? [tilde(BIN)] : [])];
const T = opt.ticket;
const allow = [];
const deny = [];
const dirs = new Set([STATE, E.skillsDir()]);
const denied = [];

// Read-only commands, each with the forms that would make it write or execute denied. Deliberately
// absent: sed and awk (both can execute: GNU sed `e`, awk `system()`), cp and mv (they write anywhere,
// past the Write rules), sort and uniq (`--compress-program`, output files), xargs, tee.
const READS = ['rg', 'grep', 'find', 'ls', 'cat', 'head', 'tail', 'wc', 'diff', 'jq', 'pwd', 'basename', 'dirname', 'realpath', 'stat', 'du', 'file', 'tr', 'cut'];
const READ_DENY = [
  ...bash('rg', ' *--pre*'),
  ...bash('find', ' *-exec*', ' *-execdir*', ' *-ok *', ' *-okdir*', ' *-delete*', ' *-fprint*', ' *-fls*'),
];

// git subcommands that read, or write only inside this worktree. Anything else, including an alias,
// matches no allow rule and is refused.
const GIT_READ = [' status', ' diff', ' log', ' show', ' rev-parse', ' rev-list', ' merge-base', ' merge-tree', ' ls-files',
  ' grep', ' blame', ' describe', ' cat-file', ' branch --show-current', ' branch -a', ' branch -r', ' branch --list',
  ' worktree list', ' remote -v', ' remote get-url'];
const GIT_LOCAL = [' add', ' commit', ' restore', ' checkout', ' switch', ' merge', ' fetch', ' clean'];
// `rebase` takes bundled short flags (`-qx cmd` runs cmd), so it is allowed only in these exact forms.
const GIT_REBASE = [' rebase --continue', ' rebase --abort', ' rebase --skip', ` rebase origin/${E.defaultBranch()}`];
// The ways a permitted git subcommand could reach outside it: another repo or config, an external
// program, an output file anywhere.
const GIT_DENY = [
  ' config', ' -c*', ' -C*', ' --git-dir*', ' --work-tree*', ' --exec-path*', ' --namespace*', ' --config-env*',
  ' stash', ' worktree add', ' worktree remove', ' worktree move', ' submodule', ' filter-branch', ' update-ref',
  ' * --upload-pack*', ' * --receive-pack*', ' *--exec=*', ' rebase *--exec*', ...shortFlag(' rebase', '-x'),
  ' *--output*', ' grep *--open-files-in-pager*', ...shortFlag(' grep', '-O'),
];
const GH_READ = [' pr view', ' pr list', ' pr checks', ' pr diff', ' run view', ' run list', ' issue view', ' repo view'];
// Never a worker's, whatever config §3 says: the orchestrator merges and undrafts. `gh api` and
// `gh alias` in every form, because neither can be scoped by prefix.
const GH_DENY = [' api', ' alias', ' extension', ' ext', ' pr merge', ' pr ready', ' pr close', ' pr reopen', ' pr checkout',
  ' secret', ' variable', ' workflow', ' release', ' repo edit', ' repo delete', ' repo create', ' repo fork', ' auth',
  ' pr review *--approve*', ' pr review *--request-changes*', ...shortFlag(' pr review', '-a'), ...shortFlag(' pr review', '-r'),
  ' pr create *--draft=*'];
const JIRA_READ = [' get', ' search', ' comments', ' whoami', ' fields'];

if (mode === 'triage') {
  // Read-only by construction: no Edit, Write only to this ticket's triage records.
  allow.push(
    ...bash('git', ...GIT_READ),
    ...READS.flatMap((b) => bash(b)),
    ...bash('desk-jira', ...JIRA_READ),
    ...bash('gh', ' pr list', ' pr view', ' issue view'),
    `Edit(${abs(STATE)}/triage/${T}.json)`, `Edit(${abs(STATE)}/triage/${T}.challenge.json)`,
  );
  deny.push(
    ...READ_DENY,
    ...bash('git', ...GIT_DENY, ...GIT_LOCAL, ' rebase', ' push', ' worktree'),
    ...bash('gh', ...GH_DENY, ' pr create', ' pr edit', ' pr comment', ' pr review', ' issue comment', ' run rerun'),
    ...bash('desk-jira', ' edit', ' comment', ' transition', ' create', ' attach', ' labels'),
    ...[...new Set([PM, ...FORBIDDEN])].filter(Boolean).flatMap((b) => bash(b)),
  );
} else {
  const WT = opt.wt.replace(/\/+$/, '');
  const DEFAULT = E.defaultBranch();

  // ---- files ---------------------------------------------------------------------------------
  // The worktree, and in the state dir only this ticket's park file and screenshots. Not answers/
  // (a worker must not answer itself), not workers/ (its own settings), not the queue or the locks.
  allow.push(
    `Edit(${abs(WT)}/**)`, `Edit(${abs(WT)}/**)`,
    `Edit(${abs(STATE)}/parks/${T}.json)`, `Edit(${abs(STATE)}/parks/${T}.*)`,
    `Edit(${abs(STATE)}/images/${T}/**)`, `Edit(${abs(STATE)}/images/${T}/**)`,
  );
  // Inside the worktree, the harness's own settings (which it may reload) and git's pointer file.
  deny.push(
    `Edit(${abs(WT)}/.claude/settings.json)`, `Edit(${abs(WT)}/.claude/settings.json)`,
    `Edit(${abs(WT)}/.claude/settings.local.json)`, `Edit(${abs(WT)}/.claude/settings.local.json)`,
    `Edit(${abs(WT)}/.git)`, `Edit(${abs(WT)}/.git)`, `Edit(${abs(WT)}/.git/**)`,
  );

  // ---- reads, desk-env, git, gh, desk-jira -----------------------------------------------------
  allow.push(
    ...READS.flatMap((b) => bash(b)),
    'Bash(mkdir:*)', 'Bash(ps:*)', 'Bash(pgrep:*)',
    ...bash('git', ...GIT_READ, ...GIT_LOCAL), ...GIT_REBASE.flatMap((t) => exact('git', t)),
    ...bash('gh', ...GH_READ),
    ...bash('desk-jira', ...JIRA_READ),
    // desk-env is read-only (where, get, list, perm, mem, heavy, port-in-use): the shim on PATH, its
    // installed path, and the module behind it.
    'Bash(desk-env:*)', `Bash(${E.HOME}/.local/bin/desk-env:*)`, 'Bash(~/.local/bin/desk-env:*)',
    ...BIN_FORMS.flatMap((b) => [`Bash(${b}/desk-env.mjs:*)`, `Bash(node ${b}/desk-env.mjs:*)`]),
    // A script from the worktree's installed packages (the contract's `node <wt>/node_modules/tsx/…`).
    // This runs code, like the test command does; `..` is denied so it cannot leave node_modules.
    ...withPrefix(`node ${WT}/node_modules/`).map((c) => `Bash(${c}:*)`),
  );
  deny.push(
    ...READ_DENY,
    ...bash('git', ...GIT_DENY),
    ...bash('gh', ...GH_DENY),
    'Bash(node *..*)', 'Bash(pkill:*)', 'Bash(killall:*)', 'Bash(merge-driver.sh:*)',
    ...BIN_FORMS.flatMap((b) => [`Bash(${b}/merge-driver.sh:*)`, `Bash(bash ${b}/merge-driver.sh:*)`, `Bash(${b}/pass.mjs:*)`, `Bash(node ${b}/pass.mjs:*)`,
      `Bash(${b}/answer.mjs:*)`, `Bash(node ${b}/answer.mjs:*)`, `Bash(${b}/queue.mjs:*)`, `Bash(node ${b}/queue.mjs:*)`]),
    ...bash('docker', ' compose down', ' rm', ' run', ' system', ' volume'), 'Bash(docker-compose down:*)',
  );

  // ---- the toolchain: exact configured commands only ------------------------------------------
  const lockForms = (lock, dir, cmd) => BIN_FORMS.flatMap((b) => withPrefix(cmd).flatMap((c) => [
    ...(dir === '.' ? [`${b}/with-lock.sh ${lock} ${c}`] : []),
    `${b}/with-lock.sh ${lock} --cwd ${dir} -- ${c}`,
  ]));
  const probeBins = new Set();
  for (const it of items) {
    for (const cmd of twins(it.cmd)) {
      if (it.dir === '.') allow.push(...withPrefix(cmd).map((c) => rule(c, '')));
      // A directory item has no bare form (the worker cannot `cd`), so it runs through with-lock.sh:
      // under its lock where it has one, else `nolock`, which only changes directory.
      const lock = LOCK_OF[it.id] ?? 'nolock';
      if (lock !== 'nolock' || it.dir !== '.') allow.push(...lockForms(lock, it.dir, cmd).map((c) => rule(c, '')));
    }
    if (BIN_NAME.test(it.bin) && !NOT_A_TOOL.has(it.bin)) probeBins.add(it.bin);
  }
  if (PM && BIN_NAME.test(PM)) {
    probeBins.add(PM);
    allow.push(...withPrefix(`${PM} install`).map((c) => `Bash(${c})`)); // exactly, no arguments
  }
  for (const f of FORBIDDEN) probeBins.delete(f);
  // `<bin> --version`, exactly, is the preflight's proof that each toolchain binary executes.
  for (const b of probeBins) allow.push(...withPrefix(`${b} --version`).map((c) => `Bash(${c})`));
  // Screenshot capture under the browser lock, with an installed package runner from the worktree.
  allow.push(...BIN_FORMS.flatMap((b) => withPrefix(`node ${WT}/node_modules/`).map((c) => `Bash(${b}/with-lock.sh browser ${c}:*)`)));

  // A package manager's one-off runner fetches and executes an arbitrary package. Denied in every
  // form this repo's config does not itself use (deny beats allow, so a used form is left to the
  // allow-list, which permits only the exact configured command).
  const RUNNERS = { npm: [' exec', ' x'], pnpm: [' exec', ' dlx'], yarn: [' dlx', ' exec'], bun: [' x'], uv: [' tool run', ' tool install'] };
  const usesRunner = (pm, sub) => items.some((i) => new RegExp(`^${pm}(\\s+\\S+)*?${sub.replace(' ', '\\s+')}(\\s|$)`).test(i.cmd));
  for (const [pm, subs] of Object.entries(RUNNERS)) {
    for (const sub of subs) {
      if (usesRunner(pm, sub)) continue;
      // The mid-command glob only for a word no script name is likely to be (`exec`, `dlx`, `tool run`).
      deny.push(...bash(pm, sub, ...(sub.length > 3 ? [` *${sub} *`] : [])), ...(PREFIX ? [rule(`${PREFIX} ${pm}`, sub)] : []));
    }
  }
  for (const rb of ['npx', 'pnpx', 'bunx', 'uvx']) deny.push(...bash(rb), ...(PREFIX ? [rule(`${PREFIX} ${rb}`, '')] : []));
  // Package managers config §4 names as forbidden in this repo, by name and by path.
  deny.push(...FORBIDDEN.flatMap((b) => bash(b)));

  // ---- database ---------------------------------------------------------------------------------
  if (HAS_TICKET_DB && PG_CONTAINER) {
    allow.push(...[`docker exec ${PG_CONTAINER} psql -d ${DATABASE}`, `docker exec ${PG_CONTAINER} psql -U postgres -d ${DATABASE}`,
      `docker exec -i ${PG_CONTAINER} psql -d ${DATABASE}`, `docker exec -i ${PG_CONTAINER} psql -U postgres -d ${DATABASE}`].map((c) => `Bash(${c}:*)`),
    'Bash(docker ps:*)');
  }

  // ---- config §3 -> allow, or a deny plus a CONFIG_DENIED line -----------------------------------
  // A headless worker cannot ask, so anything short of `yes` is denied and the worker parks with
  // the exact payload. Enforcement is the rule, not the wording.
  const grant = (id, rules, denyRules = rules) => {
    const p = E.permission(id);
    if (p === 'yes') allow.push(...rules);
    else { deny.push(...denyRules); denied.push(`${E.permissionKey(id)} (${p})`); }
    return p === 'yes';
  };

  // git push: only this ticket's branch, only as exact commands, never the default branch.
  const BRANCH = (opt.branch ?? '').trim();
  const branchOk = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(BRANCH) && !BRANCH.includes('..') && !BRANCH.endsWith('.lock') && BRANCH !== DEFAULT;
  const FORCE = [...[' push *--force', ' push *--force *', ' push *--force-if-includes*', ' push *--mirror*', ' push *--all*', ' push *--delete*',
    ' push +*', ' push * +*'], ...shortFlag(' push', '-f'), ...shortFlag(' push', '-d')];
  if (!branchOk) {
    deny.push(...bash('git', ' push'));
    denied.push(`${E.permissionKey('git-push')} (no usable branch for this ticket${BRANCH ? `: '${BRANCH}'` : ''})`);
  } else {
    const pushes = [` push -u origin ${BRANCH}`, ` push --set-upstream origin ${BRANCH}`, ` push origin ${BRANCH}`];
    if (grant('git-push', pushes.flatMap((p) => exact('git', p)), bash('git', ' push'))) {
      const lease = E.permission('git-force-with-lease');
      if (lease === 'yes') allow.push(...exact('git', ` push --force-with-lease origin ${BRANCH}`), ...exact('git', ` push --force-with-lease -u origin ${BRANCH}`));
      else { FORCE.push(' push *--force-with-lease*'); denied.push(`${E.permissionKey('git-force-with-lease')} (${lease})`); }
    }
  }
  deny.push(...bash('git', ...FORCE));

  const REPO = (() => { try { return E.ghRepo(); } catch { return null; } })();
  const draftForms = [' pr create --draft', ...(REPO ? [` pr create --repo ${REPO} --draft`] : [])];
  grant('pr-open', bash('gh', ...draftForms), bash('gh', ' pr create'));
  grant('pr-edit', bash('gh', ' pr edit'));
  // The self-review post is a COMMENTED review; --approve / --request-changes stay denied above.
  const selfReview = grant('pr-self-review-comment', bash('gh', ' pr review', ' pr comment'), bash('gh', ' pr review'));
  // Replies go in as PR comments: resolving a thread needs `gh api graphql`, which no worker has.
  if (!grant('pr-reply', bash('gh', ' pr comment'), []) && !selfReview) deny.push(...bash('gh', ' pr comment', ' issue comment'));
  grant('pr-update-branch', bash('gh', ' pr update-branch'));
  grant('ci-rerun', bash('gh', ' run rerun'));
  deny.push(...bash('gh', ' issue comment', ' issue edit', ' issue close', ' issue create'));
  grant('jira-comment', bash('desk-jira', ' comment'));
  grant('jira-transition', bash('desk-jira', ' transition'));
  grant('jira-create', bash('desk-jira', ' create'));
  grant('jira-edit', bash('desk-jira', ' edit', ' labels'));
  if (!(E.permission('jira-create') === 'yes' && E.permission('jira-edit') === 'yes')) deny.push(...bash('desk-jira', ' attach'));
  else allow.push(...bash('desk-jira', ' attach'));

  // Cross-vendor refutation, read-only only. Without an allow rule `dontAsk` refuses the binary and
  // every review silently becomes same-vendor, so it exists only where the user agreed to send diffs
  // to Codex. A sandbox other than read-only, or a config override, is denied.
  const codexPerm = E.permission('codex-review');
  if (codexPerm === 'yes') {
    allow.push(...bash('codex', ' exec --sandbox read-only'), ...exact('codex', ' --version'));
    deny.push(...bash('codex', ' *danger*', ' *--full-auto*', ' *--yolo*', ' *--config*', ' * -c *', ' *--sandbox=*', ' * -s *', ' *workspace-write*'));
  } else { deny.push(...bash('codex')); denied.push(`${E.permissionKey('codex-review')} (${codexPerm})`); }

  // Figma: reads only, and only where the user granted reading linked Figma files.
  const figmaRead = ['get_design_context', 'get_screenshot', 'get_metadata', 'get_variable_defs',
    'get_code_connect_map', 'get_context_for_code_connect', 'search_design_system', 'get_libraries',
    'get_figjam', 'get_motion_context', 'download_assets', 'read_skill_uri', 'get_figma_skill'];
  const figmaWrite = ['use_figma', 'create_new_file', 'upload_assets', 'add_code_connect_map',
    'send_code_connect_mappings', 'weave_run_tool', 'weave_upload_asset'];
  const figmaPerm = E.permission('read-figma');
  if (figmaPerm === 'yes') allow.push(...figmaRead.map((t) => `mcp__claude_ai_Figma__${t}`));
  else denied.push(`${E.permissionKey('read-figma')} (${figmaPerm})`);
  deny.push(...figmaWrite.map((t) => `mcp__claude_ai_Figma__${t}`));

  if (opt.dry) {
    deny.push(
      ...bash('git', ' push'),
      ...bash('gh', ' pr create', ' pr edit', ' pr review', ' pr comment', ' issue comment', ' pr update-branch', ' run rerun'),
      ...bash('desk-jira', ' edit', ' comment', ' transition', ' create', ' attach', ' labels'),
    );
  }

  // An allow-list does NOT imply deny-everything-else for files: deny every OTHER working tree by name.
  let list = '';
  try { list = execFileSync('git', ['-C', WT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* no git yet */ }
  for (const line of list.split('\n')) {
    const other = /^worktree (.+)$/.exec(line)?.[1];
    if (other && other !== WT) deny.push(`Edit(${abs(other)}/**)`, `Edit(${abs(other)}/**)`);
  }

  const mem = E.memoryDir();
  if (existsSync(mem)) dirs.add(mem);
  const lock = E.lockDir();
  dirs.add(lock);
  try { const real = realpathSync(lock); if (real !== lock) dirs.add(real); } catch { /* created on first lock */ }
  if (platform() === 'linux') dirs.add('/proc');
  opt.probes = [...probeBins].map((b) => `${PREFIX ? `${PREFIX} ` : ''}${b} --version`);
}

const settings = { permissions: { allow: [...new Set(allow)], deny: [...new Set(deny)], additionalDirectories: [...dirs] } };
// The attribution hook normally lives in the user's settings, which workers do not load.
const HOOK = join(E.HOME, '.claude', 'hooks', 'deny-ai-attribution.py');
if (existsSync(HOOK)) {
  settings.hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `python3 "${HOOK}"`, timeout: 10 }] }] };
}

// Validate before writing: a silently-ignored settings file is full permissions.
const p = JSON.parse(JSON.stringify(settings)).permissions;
if (!p.deny.length) { console.error('FAIL: deny list is empty — refusing to write settings'); process.exit(1); }
if (mode === 'worker' && !opt.probes.length) {
  console.error('FAIL: no toolchain allow rule — config §4 Package manager and the Toolchain command rows are unset. Run /desk-setup; refusing to guess a toolchain.');
  process.exit(1);
}
if ([...p.allow, ...p.deny].some((a) => /^(Edit|Write)\(\/[^/]/.test(a))) { console.error('FAIL: single-slash absolute rule would be ignored'); process.exit(1); }
const deadGlob = [...p.allow, ...p.deny].filter((a) => /^Bash\(.*\*.*:\*\)$/.test(a));
if (deadGlob.length) { console.error(`FAIL: a mid-pattern * with a trailing :* never matches: ${deadGlob[0]}`); process.exit(1); }
// Nothing that runs arbitrary programs may be allowed by bare name.
const WHOLESALE = ['git', 'gh', 'node', 'python', 'python3', 'bash', 'sh', 'docker', 'flock', 'env', 'npx', PM, PREFIX.split(/\s+/)[0]].filter(Boolean);
const wholesale = p.allow.filter((a) => WHOLESALE.some((b) => forms(b).some((f) => a === `Bash(${f}:*)`)) || /with-lock\.sh:\*\)$/.test(a));
if (wholesale.length) { console.error(`FAIL: wholesale allow rule would bypass the deny list: ${wholesale[0]}`); process.exit(1); }

mkdirSync(dirname(opt.out), { recursive: true });
writeFileSync(opt.out, `${JSON.stringify(settings, null, 2)}\n`);
for (const d of denied) console.log(`CONFIG_DENIED: ${d}`);
for (const w of warns) console.log(`CONFIG_WARN: ${w}`);
if (mode === 'worker') for (const pr of opt.probes) console.log(`TOOLCHAIN_PROBE: ${pr}`);
