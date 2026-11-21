// Desk.app's entry point: Electron's main process. Everything it does is in app.mjs.
import electron from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deskPaths, run } from './app.mjs';

const here = dirname(fileURLToPath(import.meta.url));
run(electron, { preload: join(here, 'preload.cjs'), page: join(here, 'status.html'), paths: deskPaths(join(here, 'desk-paths.json')) });
