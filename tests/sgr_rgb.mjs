// The colour an SGR colour code draws, as [r, g, b], for the desk-q suites' contrast checks.

const CUBE = [0, 95, 135, 175, 215, 255];
// A 256-colour code's colour: the greys from 232, the 6x6x6 cube from 16; null below 16.
export const xterm256 = (n) => (n >= 232 && n <= 255 ? [0, 0, 0].map(() => 8 + 10 * (n - 232))
  : n >= 16 && n <= 231 ? [CUBE[Math.floor((n - 16) / 36)], CUBE[Math.floor((n - 16) / 6) % 6], CUBE[(n - 16) % 6]] : null);
// A 256-colour foreground or background (38;5;n, 48;5;n) or a 24-bit foreground (38;2;r;g;b); null otherwise.
export const rgbOfSgr = (code) => (/^[34]8;5;\d+$/.test(code) ? xterm256(Number(code.split(';')[2]))
  : /^38;2;\d+;\d+;\d+$/.test(code) ? code.split(';').slice(2).map(Number) : null);
