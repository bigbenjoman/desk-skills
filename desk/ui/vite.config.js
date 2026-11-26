import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The build is served by the desk-ui server from ~/.claude/desk/ui/dist, under a CSP of
// default-src 'self': nothing is inlined that the policy would refuse.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0, modulePreload: { polyfill: false } },
  test: { environment: 'jsdom', include: ['src/**/*.test.{js,jsx}'] },
});
