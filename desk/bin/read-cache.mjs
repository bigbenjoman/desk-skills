// GitHub reads kept on disk between merge-driver loops, each keyed by something that names one fixed
// answer (a commit SHA, a PR at its head SHA), so a driver looping every minute or two reads each once
// per CACHE_MS instead of once per loop. An entry older than CACHE_MS is read again: a check
// rerun on an unchanged commit, or a PR's file list against a base that moved, shows within that.
//
//   const c = openCache(path);   // path null: nothing kept, every read goes through
//   c.get(key) -> value | undefined, c.set(key, value[, { ttl }]), c.save()
//
// An entry set with its own `ttl` lasts that long instead (base-red's ETags, which a read
// past CACHE_MS sends so that GitHub can answer an unchanged one with a 304).
//
// The file is { <key>: { value, at[, ttl] } }. Two processes writing it at once lose one's new entries, which
// costs a read, never a wrong answer.
import { readFileSync } from 'node:fs';
import { writeJsonAtomic } from './dir-lock.mjs';

export const CACHE_MS = 30 * 60 * 1000;

export function openCache(path, { now = Date.now(), ttl = CACHE_MS } = {}) {
  let entries = {};
  if (path) {
    try {
      const j = JSON.parse(readFileSync(path, 'utf8'));
      if (j && typeof j === 'object' && !Array.isArray(j)) entries = j;
    } catch { /* no file yet, or unreadable: start empty */ }
  }
  let dirty = false;
  for (const [k, v] of Object.entries(entries)) {
    const at = Date.parse(v?.at);
    const keep = Number.isFinite(v?.ttl) ? v.ttl : ttl;
    if (!v || !Object.hasOwn(v, 'value') || !Number.isFinite(at) || now - at > keep) { delete entries[k]; dirty = true; }
  }
  return {
    get: (key) => (Object.hasOwn(entries, key) ? entries[key].value : undefined),
    set: (key, value, { ttl: own } = {}) => {
      entries[key] = { value, at: new Date(now).toISOString(), ...(Number.isFinite(own) ? { ttl: own } : {}) };
      dirty = true;
    },
    save: () => {
      if (!path || !dirty) return;
      try { writeJsonAtomic(path, entries); dirty = false; } catch { /* a cache that cannot be written only costs reads */ }
    },
  };
}
