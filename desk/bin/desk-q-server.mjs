// desk-q's read from desk-ui's server (desk-ui.mjs GET /api/model): the listing the server already
// holds, so desk-q need not read every repo itself. Anything short of a listing this code knows, in
// SERVER_WAIT_MS, is null: no token file, no server, a refusal, a version it does not know. Then desk-q
// reads the files as it always has. The token goes only in the request's header, never argv or env.
import { request } from 'node:http';
import { MODEL_VERSION, modelRepos } from './desk-q-model.mjs';
import { port, readToken } from './desk-ui.mjs';

export const SERVER_WAIT_MS = 200;

// -> { repos, at } with a listing, { same: true, at } when the one dated `since` is still current, or null.
export function serverModel({ since = null, wait = SERVER_WAIT_MS } = {}) {
  const token = readToken();
  if (!token) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const end = (v) => { if (settled) return; settled = true; clearTimeout(timer); req.destroy(); resolve(v); };
    const p = port();
    const req = request({ host: '127.0.0.1', port: p, method: 'GET', agent: false,
      path: `/api/model${since == null ? '' : `?at=${encodeURIComponent(String(since))}`}`,
      headers: { Host: `127.0.0.1:${p}`, Authorization: `Bearer ${token}` } }, (res) => {
      if (res.statusCode !== 200) return end(null);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (body?.v === MODEL_VERSION && body.same === true && body.at === since) return end({ same: true, at: since });
          const repos = modelRepos(body);
          end(repos ? { repos, at: body.at } : null);
        } catch { end(null); }
      });
      res.on('error', () => end(null));
    });
    const timer = setTimeout(() => end(null), wait);
    req.on('error', () => end(null));
    req.end();
  });
}
