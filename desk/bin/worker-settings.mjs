#!/usr/bin/env node
// Generate the --settings file for a headless worker or a triage pass.
//
//   worker-settings.mjs worker --ticket SV-XXX --wt <worktree> --out <file> [--dry]
//   worker-settings.mjs triage --ticket SV-XXX --out <file>
//
// Prints one `CONFIG_DENIED: <§3 key> (<setting>)` line per capability the user's config §3 does not
// grant, so the spawner can tell the worker what it must park on instead of attempting.
//
// Hard-won details, each of which failed silently once:
//   - A worker's fs access is scoped to its cwd, and `.claude/` is write-protected, so the skills
//     tree and its own state dir both need explicit grants.
//   - Neither permission mode is sufficient alone. `acceptEdits` auto-approves edits but denies Bash;
//     `dontAsk` allows allow-listed Bash but denies edits. So grant BOTH explicitly: Edit/Write
//     scoped to the worktree, plus the Bash toolchain. Deny still wins over allow.
//   - Absolute paths in Edit/Write rules need a DOUBLE leading slash: Write(//abs/...) is honoured,
//     Write(/abs/...) is SILENTLY IGNORED, in both directions.
//   - A malformed --settings file is silently IGNORED in --print mode, handing the worker full
//     permissions while looking locked down. So this validates before writing.
//   - A denial reported by a worker may be the FILESYSTEM sandbox, not the rule list: /tmp (locks)
//     and /proc (meminfo) sit outside the worktree and need additionalDirectories, which no
//     Bash(...) rule can substitute for.
//   - Bash rules match the command string as written. A binary allowed by name AND by absolute
//     path must be DENIED by both too, or `/usr/bin/git push` walks past a `git push` deny. So every
//     rule for a binary, allow or deny, is built by `bash()` below; never write one by hand.
//   - Prefix rules cannot stop an allowed interpreter (`node -e`, `python3 -c`, `bun`) from shelling
//     out. The deny list stops the ordinary command forms; the contract and the preflight do the rest.
import { writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
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
  console.error('usage: worker-settings.mjs worker --ticket SV-XXX --wt <worktree> --out <file> [--dry]\n       worker-settings.mjs triage --ticket SV-XXX --out <file>');
  process.exit(2);
}

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
// Two rule shapes, and mixing them fails silently (verified with `claude -p`):
//   - a pattern with no `*` is a PREFIX and gets `:*`:        Bash(git push:*)
//   - a pattern with a `*` is a GLOB and is written verbatim:  Bash(git -C * push*)
// A rule with a `*` in the middle that also ends in `:*` never matches anything, so
// `Bash(git -C * push:*)` let `git -C /tmp push origin main` run. `*` can match empty, so the spaces
// around it are part of the pattern: `push *--tags*` catches `push --tags x`, `push * --tags*` does not.
// Never glob a short flag as `*-f*`: it matches branch names like `fix/SV-1-foo`.
const rule = (f, pat) => (pat.includes('*') ? `Bash(${f}${pat})` : `Bash(${f}${pat}:*)`);
const bash = (bin, ...subs) => (subs.length ? subs : ['']).flatMap((sub) => forms(bin).map((f) => rule(f, sub)));

// A git subcommand, also after the global flags that can precede it.
const git = (sub) => [` ${sub}`, ` -C * ${sub}*`, ` -c * ${sub}*`];
// A short flag anywhere in the arguments after `lead`, without matching it inside another word.
const shortFlag = (lead, flag) => [`${lead} ${flag}*`, `${lead} * ${flag}`, `${lead} * ${flag} *`];
// Force pushes in every position: long flags (covers --force-with-lease), -f, and a +refspec.
const FORCE_PUSH = [' push', ' -C * push', ' -c * push'].flatMap((lead) => [
  `${lead} *--force*`, ...shortFlag(lead, '-f'), `${lead} +*`, `${lead} * +*`,
]);
// Everything `gh api` can write with: an explicit method, a graphql mutation, or a REST call carrying
// fields (which gh sends as POST unless told otherwise). Graphql reads also take -f, so the field
// guard is limited to REST endpoints.
const GH_API_WRITES = [
  ...['POST', 'PATCH', 'PUT', 'DELETE'].flatMap((m) => [m, m.toLowerCase()])
    .flatMap((m) => [` api *-X ${m}*`, ` api *-X${m}*`, ` api *--method ${m}*`, ` api *--method=${m}*`]),
  ' api graphql *mutation*',
  ...[' api repos/*', ' api /repos/*'].flatMap((ep) => [
    `${ep} -f *`, `${ep} -F *`, `${ep}--field*`, `${ep}--raw-field*`, `${ep}--input*`]),
  ' api -f *', ' api -F *', ' api --field*', ' api --raw-field*', ' api --input*',
];

const STATE = E.stateDir();
const BIN = E.binDir();
const allow = [];
const deny = [];
const dirs = new Set([STATE, E.skillsDir()]);
const denied = [];

if (mode === 'triage') {
  // Read-only by construction: no Edit, Write only to the triage records, every mutating command denied.
  allow.push(
    ...bash('git', ' log', ' show', ' diff', ' branch'),
    'Bash(rg:*)', 'Bash(grep:*)', 'Bash(find:*)', 'Bash(ls:*)', 'Bash(cat:*)',
    'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)',
    ...bash('desk-jira', ' get', ' search', ' comments'),
    ...bash('gh', ' pr list', ' pr view'),
    `Write(${abs(STATE)}/triage/**)`,
  );
  deny.push(
    ...['commit', 'push', 'checkout', 'stash', 'worktree'].flatMap((s) => bash('git', ...git(s))),
    ...bash('gh', ' pr create', ' pr edit', ' pr merge', ' pr review', ' pr ready', ' pr comment', ' issue comment', ...GH_API_WRITES),
    ...bash('desk-jira', ' edit', ' comment', ' transition', ' create', ' attach', ' labels'),
    ...bash('bun'),
  );
} else {
  const WT = opt.wt.replace(/\/+$/, '');
  allow.push(
    `Edit(${abs(WT)}/**)`, `Write(${abs(WT)}/**)`, `Write(${abs(STATE)}/**)`,
    ...bash('bun'), ...bash('mise'), ...bash('node'), 'Bash(python3:*)',
    ...bash('git'), ...bash('gh'), ...bash('desk-jira'), ...bash('docker'),
    'Bash(rg:*)', 'Bash(grep:*)', 'Bash(find:*)', 'Bash(ls:*)', 'Bash(cat:*)',
    'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(sed:*)', 'Bash(awk:*)',
    'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)', 'Bash(diff:*)', 'Bash(ps:*)', 'Bash(pgrep:*)',
    'Bash(psql:*)', 'Bash(createdb:*)', 'Bash(flock:*)',
    `Bash(${BIN}/with-lock.sh:*)`, ...(tilde(BIN) ? [`Bash(${tilde(BIN)}/with-lock.sh:*)`] : []),
    `Bash(${BIN}/desk-env.mjs:*)`,
  );

  // Never a worker's, whatever config §3 says: the orchestrator merges and undrafts.
  deny.push(
    ...bash('gh', ' pr merge', ' pr ready',
      ' pr review *--approve*', ' pr review *--request-changes*',
      ...shortFlag(' pr review', '-a'), ...shortFlag(' pr review', '-r'),
      ' api *pulls/*/merge*', ' api graphql *mergePullRequest*', ' api graphql *enablePullRequestAutoMerge*',
      ' api graphql *markPullRequestReadyForReview*'),
    ...bash('git', ...FORCE_PUSH, ...git('stash')), // the stash is shared across every worktree
    'Bash(pkill:*)', 'Bash(killall:*)',
    ...bash('docker', ' compose down'), 'Bash(docker-compose down:*)',
    ...bash('bun', ' run --filter @studia-portal/web test'), // the portal's full Vitest suite never terminates
  );

  // Config §3 -> allow or deny. A headless worker cannot ask, so anything short of `yes` is denied
  // here and the worker parks with the exact payload instead. Enforcement is the rule, not the
  // wording: a worker can print a flawless "awaiting approval" block and then post the Jira
  // comment anyway.
  const gated = [
    ['git-push', bash('git', ...git('push'))],
    ['pr-open', bash('gh', ' pr create')],
    ['pr-edit', bash('gh', ' pr edit')],
    ['pr-self-review-comment', bash('gh', ' pr review', ' pr comment', ' issue comment')],
    ['pr-reply', bash('gh', ...GH_API_WRITES)],
    ['pr-update-branch', bash('gh', ' pr update-branch')],
    ['ci-rerun', bash('gh', ' run rerun')],
    ['jira-comment', bash('desk-jira', ' comment')],
    ['jira-transition', bash('desk-jira', ' transition')],
    ['jira-create', bash('desk-jira', ' create', ' attach')],
    ['jira-edit', bash('desk-jira', ' edit', ' labels', ' attach')],
  ];
  for (const [id, rules] of gated) {
    const p = E.permission(id);
    if (p !== 'yes') { deny.push(...rules); denied.push(`${E.permissionKey(id)} (${p})`); }
  }

  // Cross-vendor refutation. Without an allow rule `dontAsk` refuses the binary before it runs and
  // every pullbot review silently becomes same-vendor — so
  // the allow exists only where the user agreed to send diffs to Codex, and is an explicit deny
  // otherwise.
  const codexPerm = E.permission('codex-review');
  if (codexPerm === 'yes') allow.push(...bash('codex'));
  else { deny.push(...bash('codex')); denied.push(`${E.permissionKey('codex-review')} (${codexPerm})`); }

  // Figma: reads only, and only where the user granted reading linked Figma files. A worker cannot ask.
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
      ...bash('git', ...git('push')),
      ...bash('gh', ' pr create', ' pr edit', ' pr review', ' pr comment', ' issue comment', ' pr update-branch', ' run rerun', ' api'),
      ...bash('desk-jira', ' edit', ' comment', ' transition', ' create', ' attach', ' labels'),
    );
  }

  // An allow-list does NOT imply deny-everything-else: Write($WT/**) still permits writing the main
  // checkout and sibling worktrees. Deny every OTHER working tree by name; that is the only thing
  // that actually enforces "never touch a worktree that is not yours".
  let list = '';
  try { list = execFileSync('git', ['-C', WT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* no git yet */ }
  for (const line of list.split('\n')) {
    const other = /^worktree (.+)$/.exec(line)?.[1];
    if (other && other !== WT) deny.push(`Write(${abs(other)}/**)`, `Edit(${abs(other)}/**)`);
  }

  const mem = E.memoryDir();
  if (existsSync(mem)) dirs.add(mem);
  const lock = E.lockDir();
  dirs.add(lock);
  try { const real = realpathSync(lock); if (real !== lock) dirs.add(real); } catch { /* created on first lock */ }
  if (platform() === 'linux') dirs.add('/proc');
}

const settings = { permissions: { allow: [...new Set(allow)], deny: [...new Set(deny)], additionalDirectories: [...dirs] } };

// Validate before writing: an empty deny list or a missing toolchain rule means something upstream
// went wrong, and a silently-ignored settings file is full permissions.
const p = JSON.parse(JSON.stringify(settings)).permissions;
if (!p.deny.length) { console.error('FAIL: deny list is empty — refusing to write settings'); process.exit(1); }
if (mode === 'worker' && !p.allow.some((a) => a.startsWith('Bash(bun'))) { console.error('FAIL: no bun allow rule'); process.exit(1); }
if ([...p.allow, ...p.deny].some((a) => /^(Edit|Write)\(\/[^/]/.test(a))) { console.error('FAIL: single-slash absolute rule would be ignored'); process.exit(1); }
const deadGlob = [...p.allow, ...p.deny].filter((a) => /^Bash\(.*\*.*:\*\)$/.test(a));
if (deadGlob.length) { console.error(`FAIL: a mid-pattern * with a trailing :* never matches: ${deadGlob[0]}`); process.exit(1); }

mkdirSync(dirname(opt.out), { recursive: true });
writeFileSync(opt.out, `${JSON.stringify(settings, null, 2)}\n`);
for (const d of denied) console.log(`CONFIG_DENIED: ${d}`);
