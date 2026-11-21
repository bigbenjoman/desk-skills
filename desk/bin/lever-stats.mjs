// The levers evaluation's statistics, with no dependency: a robust (Student-t) linear fit of log cost
// on the arm with repo and size as covariates, and a seeded bootstrap of per-ticket rows that every
// interval and probability is read from.
//
//   import { tFit, costRatio, bootstrap, interval, rateRatio, meanDiff } from './lever-stats.mjs'

// Degrees of freedom of the Student-t errors: heavy enough tails that one runaway ticket cannot move
// the cost estimate on its own.
export const T_DF = 4;
// Bootstrap replicates behind each interval and probability.
export const REPLICATES = 400;
// A ticket that spent nothing is costed at this floor, so its log is defined.
export const COST_FLOOR_USD = 0.01;

// Solves A x = b by Gaussian elimination with partial pivoting; null when A is singular.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-10) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

function weightedLs(y, X, w) {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => Array(p).fill(0));
  const b = Array(p).fill(0);
  for (let i = 0; i < y.length; i++) {
    const xi = X[i];
    for (let j = 0; j < p; j++) {
      b[j] += w[i] * xi[j] * y[i];
      for (let k = j; k < p; k++) A[j][k] += w[i] * xi[j] * xi[k];
    }
  }
  for (let j = 0; j < p; j++) for (let k = 0; k < j; k++) A[j][k] = A[k][j];
  return solve(A, b);
}

// The Student-t regression of y on the columns of X (each row an array, intercept included), fitted
// by iteratively reweighted least squares with `df` fixed. -> coefficients, or null when X is singular.
export function tFit(y, X, { df = T_DF, iterations = 50, tolerance = 1e-9 } = {}) {
  if (!y.length || y.length < X[0].length) return null;
  let w = y.map(() => 1);
  let beta = weightedLs(y, X, w);
  for (let it = 0; beta && it < iterations; it++) {
    const r = y.map((v, i) => v - X[i].reduce((s, x, j) => s + x * beta[j], 0));
    const s2 = Math.max(r.reduce((s, v, i) => s + w[i] * v * v, 0) / y.length, 1e-12);
    w = r.map((v) => (df + 1) / (df + (v * v) / s2));
    const next = weightedLs(y, X, w);
    if (!next) return beta;
    const moved = Math.max(...next.map((v, j) => Math.abs(v - beta[j])));
    beta = next;
    if (moved < tolerance) break;
  }
  return beta;
}

// The cost ratio of the on arm to the off arm: exp of the arm's coefficient in the Student-t fit of log
// cost on the arm, the repo and the size, each covariate's levels as indicators against its first
// level present. Rows are { cost, on: bool, repo, size }. -> ratio, or null when either arm is empty or
// the fit is singular.
export function costRatio(rows) {
  if (!rows.some((r) => r.on) || !rows.some((r) => !r.on)) return null;
  const levels = (key) => [...new Set(rows.map((r) => String(r[key] ?? '')))].sort().slice(1);
  const repos = levels('repo');
  const sizes = levels('size');
  const X = rows.map((r) => [1, r.on ? 1 : 0, ...repos.map((l) => (String(r.repo ?? '') === l ? 1 : 0)), ...sizes.map((l) => (String(r.size ?? '') === l ? 1 : 0))]);
  const y = rows.map((r) => Math.log(Math.max(r.cost, COST_FLOOR_USD)));
  const beta = tFit(y, X);
  return beta ? Math.exp(beta[1]) : null;
}

// The ratio of two arms' rates, each the sum of `num` over the sum of `den` across its rows; equal zero
// rates are a ratio of 1. -> ratio (Infinity when only the off arm is zero), or null with an empty arm.
export function rateRatio(rows, num, den = () => 1) {
  const sums = { on: [0, 0], off: [0, 0] };
  for (const r of rows) {
    const a = r.on ? sums.on : sums.off;
    a[0] += num(r);
    a[1] += den(r);
  }
  if (!sums.on[1] || !sums.off[1]) return null;
  const on = sums.on[0] / sums.on[1];
  const off = sums.off[0] / sums.off[1];
  if (off === 0) return on === 0 ? 1 : Infinity;
  return on / off;
}

// The on arm's mean of `value` less the off arm's. -> difference, or null with an empty arm.
export function meanDiff(rows, value) {
  const on = rows.filter((r) => r.on);
  const off = rows.filter((r) => !r.on);
  if (!on.length || !off.length) return null;
  const mean = (xs) => xs.reduce((s, r) => s + value(r), 0) / xs.length;
  return mean(on) - mean(off);
}

// `replicates` values of `stat`, each over a resample with replacement of every stratum to its own
// size (strata are arrays of rows), from the seeded `random`. A replicate whose stat is null is dropped.
export function bootstrap(strata, stat, { random, replicates = REPLICATES }) {
  const out = [];
  for (let b = 0; b < replicates; b++) {
    const sample = [];
    for (const s of strata) for (let i = 0; i < s.length; i++) sample.push(s[Math.floor(random() * s.length)]);
    const v = stat(sample);
    if (v != null && !Number.isNaN(v)) out.push(v);
  }
  return out;
}

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  if (lo === hi || !Number.isFinite(sorted[lo]) || !Number.isFinite(sorted[hi])) return sorted[lo === hi ? lo : at - lo < 0.5 ? lo : hi];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
};

// The 90% interval of `draws` and the share of them for which `pred` holds.
//   -> { lo90, hi90, p }, every figure null with no draws
export function interval(draws, pred = () => false) {
  if (!draws.length) return { lo90: null, hi90: null, p: null };
  const s = [...draws].sort((a, b) => a - b);
  return { lo90: quantile(s, 0.05), hi90: quantile(s, 0.95), p: draws.filter(pred).length / draws.length };
}

// A 32-bit seed from a string, so one evaluation's bootstrap draws the same numbers every time.
export function seedOf(text) {
  let h = 2166136261;
  for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
