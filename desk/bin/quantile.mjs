// The q-quantile of the finite numbers in xs, or null when there are none. Linear interpolation
// between closest ranks, so the median of an even count is the mean of the two. Imports nothing, so
// tests/plan_shards.mjs can use it from a scratch copy of the test runner.
export function quantile(xs, q) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (pos - lo);
}
