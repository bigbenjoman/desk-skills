// suite: scratch cleanup (every suite removes its temp dirs, pass or fail)
// A suite's scratch directories under the temp dir are removed when it exits: an .mjs suite makes them
// with scratch.mjs, and a shell suite that runs `mktemp -d` removes its directory in an EXIT trap. Left
// behind, a day of local runs once used every inode of a tmpfs /tmp and stopped every shell on the machine.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const DIR = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(DIR);

const direct = files.filter((f) => f.endsWith('.mjs') && f !== 'scratch.mjs' && /mkdtempSync\(join\(tmpdir\(\)/.test(readFileSync(join(DIR, f), 'utf8')));
t('no .mjs suite makes a temp dir that nothing removes: each uses scratch()', direct.join(', '), '');

const shells = files.filter((f) => f.endsWith('.sh') && f !== 'run.sh').filter((f) => /mktemp -d/.test(readFileSync(join(DIR, f), 'utf8')));
const untrapped = shells.filter((f) => {
  const s = readFileSync(join(DIR, f), 'utf8');
  return !/trap [^\n]*rm -rf "\$\w+"[^\n]*EXIT/.test(s) && !/trap (\w+) EXIT/.test(s);
});
t('every shell suite that makes a temp dir removes it in an EXIT trap', untrapped.join(', '), '');

// scratch() removes its directory when the process ends, and when it is killed.
const probe = (how) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { scratch } from ${JSON.stringify(join(DIR, 'scratch.mjs'))}; const d = scratch('desk-scratch-probe-'); console.log(d); ${how}`], { encoding: 'utf8', timeout: 10_000 });
  const d = r.stdout.trim().split('\n')[0];
  return d && !existsSync(d);
};
t('a suite that passes leaves nothing', probe(''), true);
t('nor one that fails', probe('process.exit(1);'), true);
t('nor one killed part way', probe("process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000);"), true);
t('it makes the directory under the temp dir with the prefix given', /desk-scratch-self-/.test(scratch('desk-scratch-self-')), true);

console.log(fails ? `scratch cleanup: ${fails} failed` : 'scratch cleanup: all checks passed');
process.exit(fails ? 1 : 0);
