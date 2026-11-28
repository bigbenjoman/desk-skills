// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';

// The real build, as install.sh makes it, into a scratch directory under node_modules. desk-ui serves
// it under default-src 'self', so anything inlined (a script, a style, a data: font) would not load.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'node_modules', '.cache', 'desk-app-build-test');
let html;
let assets;

beforeAll(async () => {
  await build({ root, logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
  html = readFileSync(join(out, 'index.html'), 'utf8');
  assets = readdirSync(join(out, 'assets'));
}, 120_000);

describe('the build loads under the desk-ui CSP', () => {
  it('has no inline script, style or handler in its page', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc="\/assets\//);
      expect(body.trim()).toBe('');
    }
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/);
  });

  it('ships its fonts as files beside it, not as data: URLs', () => {
    expect(assets.filter((f) => /^geist-sans-.*\.woff2$/.test(f)).length).toBeGreaterThan(0);
    expect(assets.filter((f) => /^geist-mono-.*\.woff2$/.test(f)).length).toBeGreaterThan(0);
    const css = assets.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
    expect(css).toMatch(/url\(\/assets\/geist-sans-/);
    expect(css).not.toMatch(/url\(["']?data:/);
  });
});
