// "1 commit", "3 updates".
export const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
// A commit as the window shows it: its first 8 characters.
export const short = (sha) => String(sha ?? '').slice(0, 8);
