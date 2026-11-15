// The machine's screenshot upload log: one JSON line per file upload-images.mjs uploads or stalls
// on, across every repo, so GitHub's real upload limit can be read from desk's own history.
//   {"at":"<ISO time>","repo":"o/r","pr":7,"file":"after-desktop.png","result":"uploaded"}
//   {"at":…,"result":"throttled","uploads_last_minute":5,"uploads_last_hour":41}
// A throttled line counts the files this machine uploaded in the minute and the hour before it.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deskHome } from './desk-env.mjs';

export const uploadLogFile = () => join(deskHome(), 'upload-log.jsonl');

// Every readable line, oldest first; a torn or hand-edited line is skipped rather than fatal.
export function readUploadLog(file = uploadLogFile()) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap((l) => {
    if (!l.trim()) return [];
    try { const e = JSON.parse(l); return e && typeof e === 'object' ? [e] : []; } catch { return []; }
  });
}

// Files uploaded in the minute and the hour before `at`.
export function uploadsBefore(entries, at) {
  const now = at.getTime();
  const times = entries.filter((e) => e.result === 'uploaded').map((e) => Date.parse(e.at))
    .filter((t) => Number.isFinite(t) && t <= now);
  return {
    uploads_last_minute: times.filter((t) => now - t < 60_000).length,
    uploads_last_hour: times.filter((t) => now - t < 3_600_000).length,
  };
}

// Appends one line and returns it. `result` is 'uploaded' or 'throttled'.
export function logUpload({ repo, pr, file, result, at = new Date() }, logFile = uploadLogFile()) {
  const line = { at: at.toISOString(), repo, pr: Number(pr), file, result };
  if (result === 'throttled') Object.assign(line, uploadsBefore(readUploadLog(logFile), at));
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `${JSON.stringify(line)}\n`);
  return line;
}
