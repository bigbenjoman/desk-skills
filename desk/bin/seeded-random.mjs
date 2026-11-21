// A small repeatable random source, so the same seed always draws the same numbers: the forecast
// (desk-q-eta.mjs), the bench's arm order (bench.mjs) and the tests of the levers draw use it.
//
//   import { seededRandom } from './seeded-random.mjs'
//   const random = seededRandom(42);   random() -> a uniform number in [0, 1)

// mulberry32 for seed `seed`, taken as an unsigned 32-bit integer.
export function seededRandom(seed) {
  let s = Number(seed) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32;
  };
}
