// install.sh's own functions, one at a time: each is taken from install.sh and run under its shell
// options with its output helpers stubbed (note, ok, warn, wrote and show_err print their kind first).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// `root` the checkout holding install.sh, `env` the function's environment. -> (name, more env) -> { code, out }
export function installShFn(root, env, timeout = 30000) {
  return (name, more = {}) => {
    const r = spawnSync('bash', ['-c', `set -euo pipefail
eval "$(sed -n '/^${name}() {$/,/^}$/p' "$1")"
note(){ echo "note: $*"; }; ok(){ echo "ok: $*"; }; warn(){ echo "warn: $*"; }; wrote(){ echo "wrote: $*"; }; show_err(){ echo "err: $*"; }
has(){ command -v "$1" >/dev/null 2>&1; }
declare -F ${name} >/dev/null || { echo "no ${name} in install.sh"; exit 9; }
${name}`, 'sh', join(root, 'install.sh')], { env: { ...env, ...more }, encoding: 'utf8', timeout });
    return { code: r.status, out: r.stdout + r.stderr };
  };
}
