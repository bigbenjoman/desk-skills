// What the window tests share: a JSON response, and a desk-ui server whose stream the test drives.
// Only tests import it.
import { act } from '@testing-library/react';
import { vi } from 'vitest';

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// A server that answers setup and `snapshot`, and whose `send(event, data)` is the server emitting a change.
export function stubServer(snapshot) {
  const s = { streams: [] };
  s.get = vi.fn(async (url) => {
    if (url === '/api/setup') return json({ installed: true, checkout: '~/studia/desk-skills', repos: 4, found: [] });
    if (url === '/api/snapshot') return json(snapshot);
    return json({ error: { code: 'not_found' } }, 404);
  });
  s.Events = class {
    constructor(url) { this.url = url; this.on = {}; s.streams.push(this); queueMicrotask(() => this.onopen?.()); }
    addEventListener(name, f) { this.on[name] = f; }
    close() {}
  };
  s.send = (event, data) => act(() => { for (const es of s.streams) es.on[event]?.({ data: JSON.stringify(data) }); });
  return s;
}
