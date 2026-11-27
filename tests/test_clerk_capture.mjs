// suite: Clerk sign-in capture (the script desk-pr documents parses, and refuses any key but sk_test_ before signing in)
// layer: L2
// covers: skills/desk-pr/references/screenshot-surfaces.md
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(join(root, 'skills/desk-pr/references/screenshot-surfaces.md'), 'utf8');
const section = doc.split('\n## Signed in with a sign-in token (Clerk)\n')[1]?.split('\n## ')[0] ?? '';
const script = /\n```js\n([\s\S]*?)\n```\n/.exec(section)?.[1] ?? '';
t('the Clerk section holds a capture script', script.length > 0, true);

const dir = scratch('clerk-capture-');
const file = join(dir, 'capture.mjs');
writeFileSync(file, script);
const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
t(`the capture script parses${check.stderr ? `: ${check.stderr.trim()}` : ''}`, check.status, 0);

// The script reads the key with desk's own desk-env.mjs from the installed desk home, so give it a
// home whose ~/.claude/desk/bin is this checkout's.
const home = join(dir, 'home');
mkdirSync(join(home, '.claude/desk'), { recursive: true });
symlinkSync(join(root, 'desk/bin'), join(home, '.claude/desk/bin'));

// AC5: any key but a development one is refused before anything signs in. The keys are built by
// concatenation so no key-shaped literal sits in the tree.
const run = (key) => {
  const env = join(dir, '.env.local');
  writeFileSync(env, `CLERK_SECRET_KEY="${key}"\n`);
  return spawnSync(process.execPath, [file, '3218', '/', join(dir, 'out.png'), 'user@example.com', env], { encoding: 'utf8', cwd: dir, timeout: 30000, env: { ...process.env, HOME: home } });
};
for (const prefix of ['sk_' + 'live_', 'pk_' + 'test_', '']) {
  const r = run(`${prefix}${'x'.repeat(20)}`);
  t(`AC5 a ${prefix || 'missing'} key is refused`, r.status !== 0 && r.stderr.includes("is not a development instance's (sk_test_), so no sign-in"), true);
  t(`AC5 and nothing signed in with the ${prefix || 'missing'} key`, r.stdout.includes('sign-in'), false);
}

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
