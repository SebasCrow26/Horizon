// Utilidades numéricas: estadística básica, distribución normal, Poisson, aleatorios con semilla,
// regresión OLS y el optimizador Nelder–Mead. Sin dependencias externas.

export const TRADING_DAYS = 252;

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const sum = (a) => a.reduce((s, v) => s + v, 0);
export const mean = (a) => (a.length ? sum(a) / a.length : NaN);

export function variance(a, ddof = 1) {
  const n = a.length;
  if (n <= ddof) return NaN;
  const m = mean(a);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] - m) ** 2;
  return s / (n - ddof);
}
export const std = (a, ddof = 1) => Math.sqrt(variance(a, ddof));

export function quantile(sorted, q) {
  const n = sorted.length;
  if (!n) return NaN;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(a) {
  const s = Float64Array.from(a).sort();
  return quantile(s, 0.5);
}

// ---------- normal ----------
export const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

// Función de error (Abramowitz–Stegun 7.1.26, error < 1.5e-7)
function erf(x) {
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

// ---------- Poisson ----------
const LOGFACT = [0];
export function logFactorial(n) {
  for (let i = LOGFACT.length; i <= n; i++) LOGFACT[i] = LOGFACT[i - 1] + Math.log(i);
  return LOGFACT[n];
}
export const poissonPmf = (n, lam) => (lam <= 0 ? (n === 0 ? 1 : 0) : Math.exp(-lam + n * Math.log(lam) - logFactorial(n)));

// ---------- aleatorios con semilla ----------
export function rng(seed = 12345) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function randn(r) {
  let u = 0, v = 0;
  while (u === 0) u = r();
  v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
export function poissonSample(r, lam) {
  if (lam <= 0) return 0;
  if (lam > 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * randn(r)));
  const L = Math.exp(-lam);
  let k = 0, p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}

// ---------- series ----------
export function logReturns(prices) {
  const out = new Array(prices.length - 1);
  for (let i = 1; i < prices.length; i++) out[i - 1] = Math.log(prices[i] / prices[i - 1]);
  return out;
}

// ---------- OLS (ecuaciones normales; sirve para pocas variables) ----------
// X: matriz n×k (sin columna de unos; se agrega si intercept=true). Devuelve coeficientes, errores estándar, t, R².
export function ols(X, y, intercept = true) {
  const n = y.length;
  const rows = X.map((r) => (intercept ? [1, ...r] : r));
  const k = rows[0].length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += rows[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += rows[i][a] * rows[i][b];
    }
  }
  const inv = invert(XtX);
  const beta = inv.map((row) => sum(row.map((v, j) => v * Xty[j])));
  const resid = new Array(n);
  let sse = 0;
  for (let i = 0; i < n; i++) {
    let fit = 0;
    for (let a = 0; a < k; a++) fit += rows[i][a] * beta[a];
    resid[i] = y[i] - fit;
    sse += resid[i] ** 2;
  }
  const dof = Math.max(1, n - k);
  const s2 = sse / dof;
  const se = inv.map((row, a) => Math.sqrt(Math.max(0, s2 * row[a])));
  const t = beta.map((b, a) => (se[a] > 0 ? b / se[a] : 0));
  const ym = mean(y);
  let sst = 0;
  for (let i = 0; i < n; i++) sst += (y[i] - ym) ** 2;
  return { beta, se, t, resid, sigma: Math.sqrt(s2), r2: sst > 0 ? 1 - sse / sst : 0, n };
}

export function invert(M) {
  const n = M.length;
  const A = M.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-14) throw new Error("Matriz singular");
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c];
    for (let j = 0; j < 2 * n; j++) A[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((r) => r.slice(n));
}

// ---------- Nelder–Mead ----------
export function nelderMead(f, x0, { maxIter = 800, tol = 1e-9, step = 0.1 } = {}) {
  const n = x0.length;
  let pts = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] += Math.abs(p[i]) > 1e-8 ? p[i] * step : step * 0.05;
    pts.push(p);
  }
  let vals = pts.map(f);
  for (let it = 0; it < maxIter; it++) {
    const idx = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
    pts = idx.map((i) => pts[i]);
    vals = idx.map((i) => vals[i]);
    if (Math.abs(vals[n] - vals[0]) < tol * (1 + Math.abs(vals[0]))) break;
    const cen = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cen[j] += pts[i][j] / n;
    const move = (c, p, t) => c.map((v, j) => v + t * (p[j] - v));
    const xr = move(cen, pts[n], -1), fr = f(xr);
    if (fr < vals[0]) {
      const xe = move(cen, pts[n], -2), fe = f(xe);
      if (fe < fr) { pts[n] = xe; vals[n] = fe; } else { pts[n] = xr; vals[n] = fr; }
    } else if (fr < vals[n - 1]) {
      pts[n] = xr; vals[n] = fr;
    } else {
      const xc = fr < vals[n] ? move(cen, pts[n], -0.5) : move(cen, pts[n], 0.5), fc = f(xc);
      if (fc < Math.min(fr, vals[n])) { pts[n] = xc; vals[n] = fc; }
      else {
        for (let i = 1; i <= n; i++) { pts[i] = move(pts[0], pts[i], 0.5); vals[i] = f(pts[i]); }
      }
    }
  }
  let best = 0;
  for (let i = 1; i <= n; i++) if (vals[i] < vals[best]) best = i;
  return { x: pts[best], fx: vals[best] };
}

// ---------- fechas ----------
export const dayKey = (ts) => Math.floor(ts / 86400);

// Alinea dos series {t:[...], c:[...]} por día calendario (intersección)
export function alignByDay(a, b) {
  const mb = new Map();
  for (let i = 0; i < b.t.length; i++) mb.set(dayKey(b.t[i]), b.c[i]);
  const t = [], ca = [], cb = [];
  for (let i = 0; i < a.t.length; i++) {
    const k = dayKey(a.t[i]);
    if (mb.has(k)) { t.push(a.t[i]); ca.push(a.c[i]); cb.push(mb.get(k)); }
  }
  return { t, a: ca, b: cb };
}

// ---- formato en español (coma decimal) para textos de modelos y precios ----
export const nf = (x, d = 2) => (x == null || !isFinite(x) ? "—" : x.toFixed(d).replace(".", ","));
// Precio: los decimales dependen de la magnitud (SHIB-USD = 0,00000890; BRK-A = 882.360)
export const fmtPriceNum = (x) => {
  if (x == null || !isFinite(x)) return "—";
  const a = Math.abs(x);
  const d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : a === 0 ? 2 : Math.min(10, Math.max(4, 2 - Math.floor(Math.log10(a))));
  return x.toLocaleString("es-CO", { minimumFractionDigits: d, maximumFractionDigits: d });
};
// Etiquetas de eje: igual, sin ceros finales (0,000006 en vez de 0,00000600) para que quepan
export const fmtAxisNum = (x) => {
  const s = fmtPriceNum(x);
  return Math.abs(x) < 1 && s.includes(",") ? s.replace(/0+$/, "").replace(/,$/, ",0") : s;
};
