// upload-images.mjs in a scratch directory, for the suites that run it end to end (test_upload_log,
// test_pr_composer): an images directory, a saved login for `user`, a scratch config for
// acme/widgets, and a fakes directory first on PATH for the caller's stub gh. Each suite brings its
// own fake Playwright through `env` (DESK_PLAYWRIGHT).
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');

export function uploadSandbox(T, { user }) {
  for (const d of ['images', 'fakes', 'home']) mkdirSync(join(T, d));
  writeFileSync(join(T, 'profile.github-session.json'),
    `{"user":"${user}","cookies":[{"name":"user_session","value":"v","domain":"github.com","path":"/"}],"origins":[]}\n`);
  mkdirSync(join(T, 'cfg', 'repos', 'acme__widgets'), { recursive: true });
  writeFileSync(join(T, 'cfg', 'repos', 'acme__widgets', 'config.md'), '## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/widgets` |\n');
  const images = join(T, 'images');
  const deskHome = join(T, 'desk');
  // -> spawnSync's result, plus how long the run took and its stdout and stderr together.
  const upload = (env = {}) => {
    const start = Date.now();
    const r = spawnSync('node', [join(BIN, 'upload-images.mjs'), '7', images], { cwd: T, encoding: 'utf8', timeout: 90000, env: {
      ...process.env, HOME: join(T, 'home'), PATH: `${join(T, 'fakes')}:${process.env.PATH}`, DESK_HOME: deskHome,
      DESK_UPLOAD_APPROVED: '1', DESK_BROWSER_PROFILE: join(T, 'profile'), DESK_GH_REPO: 'acme/widgets',
      DESK_REPO_OVERRIDE: 'acme/widgets', DESK_CONFIG_ROOT: join(T, 'cfg'), ...env,
    } });
    return { ...r, ms: Date.now() - start, out: `${r.stdout}${r.stderr}` };
  };
  return { images, fakes: join(T, 'fakes'), deskHome, upload };
}
