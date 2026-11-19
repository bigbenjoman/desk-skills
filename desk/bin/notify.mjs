// A desktop notification for the supervisor, on whatever this computer can show one with: osascript on
// macOS; on Linux notify-send where it is on PATH, then, under WSL, a Windows toast through
// powershell.exe, each tried in turn. A computer with none of them, or on Linux none that works (no
// notification daemon on the session bus is a lasting state), shows nothing, and says why.
//   notify(title, body) -> { via, error }: via names what showed it, or on macOS what failed to (null
//                          when nothing could), and error is null once it was shown
// DESK_PLATFORM stands in for the platform in tests, as in run-by.mjs.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { platform } from './run-by.mjs';

const onPath = (cmd) => (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, cmd)));

// A PowerShell single-quoted string: only the quote itself needs doubling.
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
// A toast from Windows' own notifier for PowerShell, so it needs no module installed. Passed encoded,
// so no character of the title or body is read by a shell on either side.
export function toastScript(title, body) {
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    '$t = $x.GetElementsByTagName(\'text\')',
    `$t.Item(0).AppendChild($x.CreateTextNode(${psQuote(title)})) | Out-Null`,
    `$t.Item(1).AppendChild($x.CreateTextNode(${psQuote(body)})) | Out-Null`,
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
  ].join('\n');
}

// -> [[command, args], ...] for this computer, in the order to try them; empty with nothing that can show one.
export function notifiers(title, body, { plat = platform(), has = onPath } = {}) {
  if (plat === 'darwin') return [['osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]]];
  if (plat !== 'linux') return [];
  return [
    ...(has('notify-send') ? [['notify-send', ['--app-name=desk', title, body]]] : []),
    ...(has('powershell.exe') ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(toastScript(title, body), 'utf16le').toString('base64')]]] : []),
  ];
}

export function notify(title, body) {
  const tries = notifiers(title, body);
  if (!tries.length) return { via: null, error: platform() === 'linux' ? 'neither notify-send nor powershell.exe is on PATH' : `nothing shows one on ${platform()}` };
  const failed = [];
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000 });
    if (r.status === 0) return { via: cmd, error: null };
    failed.push(`${cmd}: ${r.error?.message ?? (String(r.stderr ?? '').trim() || `exited ${r.status}`)}`);
  }
  // A failed osascript is retried by the next tick, as before; on Linux one that fails keeps failing.
  return { via: platform() === 'darwin' ? 'osascript' : null, error: failed.join('; ') };
}
