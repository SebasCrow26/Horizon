// Riesgo de portafolio: VaR y ES (histórico, normal y Monte Carlo), estrés, excepciones con la prueba de Kupiec,
// presupuesto de riesgo y portafolio de mínimo riesgo con límites por activo y por sector.
// Funciones puras, sin dependencias del navegador. Se verifican contra una referencia independiente en Python
// (numpy + scipy) en tests/risk.test.mjs.
//
// Créditos: el diseño del análisis (definiciones, escenarios de estrés, límites y presupuesto de riesgo) parte del
// Taller de valoración y riesgo de Felipe Pulido; este código es una implementación propia en JavaScript.
//
// Convenciones (las mismas del taller de valoración y riesgo):
//   • B = capital en la moneda del portafolio; w = pesos que suman 1 (solo largos); h = sesiones; α = confianza.
//   • Se usan solo las sesiones en que están TODOS los activos; no se rellenan huecos ni se inventan retornos.
//   • Pérdida L = −B · (retorno del portafolio). VaR_α = L₍⌈nα⌉₎ (cuantil de la CDF empírica inversa).
//   • ES = promedio de las pérdidas ≥ VaR (los empates con el VaR entran a la cola).
import { TRADING_DAYS, dayKey, rng, randn, normPdf } from "./util.js";

export const D = TRADING_DAYS;
const SQRT2 = Math.SQRT2, SQRTPI = Math.sqrt(Math.PI);

// ---------- distribución normal de alta precisión (error ~1e-15) ----------
function erfSeries(x) {
  let term = x, sum = x;
  const x2 = x * x;
  for (let n = 1; n < 100; n++) {
    term *= -x2 / n;
    const add = term / (2 * n + 1);
    sum += add;
    if (Math.abs(add) < 1e-18 * Math.abs(sum)) break;
  }
  return (2 / SQRTPI) * sum;
}
export function erfc(x) {
  if (x < 0) return 2 - erfc(-x);
  if (x <= 2.5) return 1 - erfSeries(x);
  let t = x; // fracción continua: erfc(x) = e^{-x²}/√π · 1/(x + (1/2)/(x + 1/(x + (3/2)/(x + …))))
  for (let k = 80; k >= 1; k--) t = x + k / 2 / t;
  return Math.exp(-x * x) / (SQRTPI * t);
}
export const normCdfP = (x) => 0.5 * erfc(-x / SQRT2);
// Inversa de la normal: aproximación de Acklam + un paso de Halley con la CDF precisa
export function normInv(p) {
  if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : p === 1 ? Infinity : NaN;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  let x;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else if (p <= 1 - pl) { const q = p - 0.5, r = q * q; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  else { const q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const e = normCdfP(x) - p, u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

// ---------- álgebra lineal pequeña ----------
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
export function covMatrix(M, ddof = 1) {
  const T = M.length, n = M[0].length, mu = new Array(n).fill(0);
  for (const row of M) for (let i = 0; i < n; i++) mu[i] += row[i];
  for (let i = 0; i < n; i++) mu[i] /= T;
  const S = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const row of M) for (let i = 0; i < n; i++) { const di = row[i] - mu[i]; for (let j = i; j < n; j++) S[i][j] += di * (row[j] - mu[j]); }
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) { S[i][j] /= T - ddof; S[j][i] = S[i][j]; }
  return S;
}
const quad = (w, S) => { let s = 0; for (let i = 0; i < w.length; i++) { let r = 0; for (let j = 0; j < w.length; j++) r += S[i][j] * w[j]; s += w[i] * r; } return s; };
export function cholesky(S) {
  const n = S.length;
  const tr = S.reduce((s, r, i) => s + r[i], 0) / n;
  for (let jit = 0; jit < 8; jit++) {
    const ridge = jit === 0 ? 0 : tr * 1e-12 * 10 ** jit;
    const L = Array.from({ length: n }, () => new Array(n).fill(0));
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let s = S[i][j] + (i === j ? ridge : 0);
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) { if (s <= 0) { ok = false; break; } L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
      }
    }
    if (ok) return L;
  }
  throw new Error("La matriz de covarianza no es definida positiva.");
}
function cholSolve(L, b) {
  const n = L.length, y = new Array(n), x = new Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
  return x;
}
function solveDense(M, b) { // eliminación gaussiana con pivote parcial; lanza error si es singular
  const n = b.length, A = M.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-13) throw new Error("singular");
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = c + 1; r < n; r++) { const f = A[r][c] / A[c][c]; for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = A[i][n]; for (let k = i + 1; k < n; k++) s -= A[i][k] * x[k]; x[i] = s / A[i][i]; }
  return x;
}

// ---------- datos: alinear por sesiones comunes ----------
// list = [{ sym, t:[segundos], c:[precio] }, …] → precios y retornos solo en las sesiones donde están todos
export function alignMany(list) {
  const maps = list.map((s) => { const m = new Map(); for (let i = 0; i < s.t.length; i++) { const c = s.c[i]; if (isFinite(c) && c > 0) m.set(dayKey(s.t[i]), c); } return m; });
  const days = [...maps[0].keys()].filter((d) => maps.every((m) => m.has(d))).sort((a, b) => a - b);
  const P = days.map((d) => maps.map((m) => m.get(d)));
  const R = [], X = [];
  for (let t = 1; t < P.length; t++) { R.push(P[t].map((p, i) => p / P[t - 1][i] - 1)); X.push(P[t].map((p, i) => Math.log(p / P[t - 1][i]))); }
  return {
    tickers: list.map((s) => s.sym), days, P, R, X,
    info: { filasPorSerie: list.map((s) => s.t.length), sesionesComunes: days.length, retornos: R.length },
  };
}

// ---------- VaR y ES ----------
// Cuantil de la CDF empírica inversa: L₍⌈nα⌉₎, y ES = promedio de las pérdidas ≥ VaR (con empates)
export function varEs(losses, alpha) {
  const s = Float64Array.from(losses).sort();
  const n = s.length;
  const k = Math.min(n, Math.max(1, Math.ceil(n * alpha - 1e-9)));
  const VaR = s[k - 1];
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) if (s[i] >= VaR) { sum += s[i]; cnt++; }
  return { VaR, ES: sum / cnt, worst: s[n - 1], tail: cnt, ties: s.filter((x) => x === VaR).length, n };
}

// Retornos compuestos de bloques de h sesiones que se solapan (por activo) → pérdidas de la cartera con pesos al inicio
export function blockLosses(R, w, B, h, step = 1) {
  const T = R.length, n = w.length;
  const L = Array.from({ length: T + 1 }, () => new Array(n).fill(0));
  for (let t = 0; t < T; t++) for (let i = 0; i < n; i++) L[t + 1][i] = L[t][i] + Math.log1p(R[t][i]);
  const out = [];
  for (let t = 0; t + h <= T; t += step) { let r = 0; for (let i = 0; i < n; i++) r += w[i] * Math.expm1(L[t + h][i] - L[t][i]); out.push(-B * r); }
  return out;
}

export function varNormal(SigmaR, w, B, alpha, h) {
  const z = normInv(alpha), sd = Math.sqrt(h * quad(w, SigmaR));
  return { VaR: B * z * sd, ES: (B * sd * normPdf(z)) / (1 - alpha), sigmaH: sd };
}

// GBM conjunto bajo la medida física: log-retorno de h sesiones ~ N(h·x̄, h·Σ_x). Cartera sin rebalanceo.
export function mcLosses(X, w, B, h, nSim = 20000, seed = 123) {
  const n = w.length, T = X.length, m = new Array(n).fill(0);
  for (const row of X) for (let i = 0; i < n; i++) m[i] += row[i] / T;
  const L = cholesky(covMatrix(X, 1)), r = rng(seed), out = new Float64Array(nSim), eps = new Array(n), sh = Math.sqrt(h);
  for (let k = 0; k < nSim; k++) {
    for (let i = 0; i < n; i++) eps[i] = randn(r);
    let ret = 0;
    for (let i = 0; i < n; i++) { let z = 0; for (let j = 0; j <= i; j++) z += L[i][j] * eps[j]; ret += w[i] * Math.expm1(h * m[i] + sh * z); }
    out[k] = -B * ret;
  }
  return out;
}

// Tabla de riesgo completa de una cartera
export function riskTable({ R, X, w, B, alpha = 0.99, h = 10, nMC = 20000, seed = 123 }) {
  const SigmaR = covMatrix(R, 1);
  const hist = blockLosses(R, w, B, h), histNo = blockLosses(R, w, B, h, h);
  const H = varEs(hist, alpha), Hn = varEs(histNo, alpha);
  const N = varNormal(SigmaR, w, B, alpha, h);
  const mcL = mcLosses(X, w, B, h, nMC, seed), M = varEs(mcL, alpha);
  return {
    alpha, h, B, SigmaR,
    hist: { VaR: H.VaR, ES: H.ES, peor: H.worst, bloques: H.n, bloquesSinSolape: Hn.n, VaRSinSolape: Hn.VaR, cola: H.tail, empates: H.ties },
    normal: { VaR: N.VaR, ES: N.ES },
    mc: { VaR: M.VaR, ES: M.ES, peor: M.worst, escenarios: nMC },
    lossesHist: hist, lossesMC: mcL,
  };
}

// ---------- estrés ----------
// groups: etiqueta de sector por activo (p. ej. ["Tecnología","Energía",…])
export function stress({ w, B, SigmaR, h, alpha, groups }) {
  const n = w.length;
  const s1 = 0.1 * B;
  const wg = {};
  groups.forEach((g, i) => { wg[g] = (wg[g] || 0) + w[i]; });
  const [gMax, wMax] = Object.entries(wg).sort((a, b) => b[1] - a[1])[0];
  const s2 = B * (0.2 * wMax + 0.05 * (1 - wMax));
  const sd = Array.from({ length: n }, (_, i) => Math.sqrt(SigmaR[i][i]) * 1.5);
  const S3 = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? sd[i] * sd[i] : 0.8 * sd[i] * sd[j])));
  const s3 = varNormal(S3, w, B, alpha, h).VaR;
  return [
    { clave: "baja10", escenario: "Todas las acciones caen 10 %", perdida: s1 },
    { clave: "sector", escenario: `${gMax} (el sector con más peso) cae 20 % y el resto 5 %`, perdida: s2, sector: gMax },
    { clave: "crisis", escenario: `Crisis: volatilidades ×1,5 y correlaciones 0,8 (VaR normal a ${h} sesiones)`, perdida: s3 },
  ];
}

// ---------- excepciones del VaR diario y prueba de Kupiec ----------
export function kupiec(x, n, p) {
  const ph = x / n;
  const ll = (q) => (n - x) * (q < 1 ? Math.log1p(-q) : 0) + (x > 0 ? x * Math.log(q) : 0);
  const LR = Math.max(0, -2 * (ll(p) - ll(ph)));
  return { x, n, esperadas: n * p, LR, pValor: erfc(Math.sqrt(LR / 2)) }; // P(χ²₁ > LR)
}
// Cada día se estima el VaR a 1 día con las 252 sesiones anteriores (pesos constantes) y se compara con la pérdida del día
export function exceptionsBacktest(R, w, B, alpha = 0.99, window = 252, from = window) {
  const loss = R.map((row) => -B * row.reduce((s, v, i) => s + w[i] * v, 0));
  let x = 0, n = 0;
  const flags = [], perdidas = [], vars = [], indices = [];
  for (let t = Math.max(window, from); t < loss.length; t++) {
    const { VaR } = varEs(loss.slice(t - window, t), alpha);
    const ex = loss[t] > VaR;
    if (ex) x++;
    n++; flags.push(ex); perdidas.push(loss[t]); vars.push(VaR); indices.push(t);
  }
  return { ...kupiec(x, n, 1 - alpha), alpha, ventana: window, banderas: flags, perdidas, vars, indices };
}

// ---------- presupuesto de riesgo ----------
// f = min(1, V̄ / VaR totalmente invertido); lo demás queda en efectivo
export function riskBudget({ w, B, VaRfull, Vbar }) {
  const f = Math.min(1, Vbar / VaRfull);
  return { f, montos: w.map((x) => f * B * x), efectivo: (1 - f) * B, VaRfinal: f * VaRfull };
}

// ---------- portafolio de mínimo riesgo ----------
// min wᵀΣw  s.a.  Σw = 1,  wmin ≤ wᵢ ≤ wmax,  Σ_{i∈s} wᵢ ≤ L_s.  (Minimizar el VaR normal es minimizar wᵀΣw.)
// Método: ADMM (como OSQP) con paso de "pulido" que resuelve exactamente el conjunto activo.
export function minVariance(Sigma, opts = {}) {
  const n = Sigma.length;
  const arr = (v, d) => (Array.isArray(v) ? v : new Array(n).fill(v ?? d));
  const wmin = arr(opts.wmin, 0), wmax = arr(opts.wmax, 1), groups = opts.groups || [];
  if (wmin.reduce((s, v) => s + v, 0) > 1 + 1e-12 || wmax.reduce((s, v) => s + v, 0) < 1 - 1e-12) return { exito: false, mensaje: "Los límites por activo no permiten sumar 100 %." };
  const tr = Sigma.reduce((s, r, i) => s + r[i], 0) / n;
  const P = Sigma.map((r) => r.map((v) => v / tr));
  const A = [new Array(n).fill(1)], lo = [1], up = [1];
  for (let i = 0; i < n; i++) { const e = new Array(n).fill(0); e[i] = 1; A.push(e); lo.push(wmin[i]); up.push(wmax[i]); }
  for (const g of groups) { const e = new Array(n).fill(0); for (const i of g.idx) e[i] = 1; A.push(e); lo.push(-1e20); up.push(g.limit); }
  const m = A.length, sigma = 1e-6, alphaR = 1.6, tol = 1e-10;
  let rho = 0.1;
  const rhoVec = () => A.map((_, i) => (i === 0 ? rho * 1e3 : rho));
  const factor = () => {
    const K = P.map((r, i) => r.map((v, j) => v + (i === j ? sigma : 0)));
    const rv = rhoVec();
    for (let k = 0; k < m; k++) for (let i = 0; i < n; i++) if (A[k][i]) for (let j = 0; j < n; j++) if (A[k][j]) K[i][j] += rv[k];
    return cholesky(K);
  };
  let Lc = factor();
  let x = new Array(n).fill(1 / n), z = A.map((r) => r.reduce((s, v, i) => s + v * x[i], 0)), y = new Array(m).fill(0);
  let converged = false, it = 0;
  const Ax = (v) => A.map((r) => r.reduce((s, a, i) => s + a * v[i], 0));
  const Px = (v) => P.map((r) => r.reduce((s, a, i) => s + a * v[i], 0));
  for (it = 1; it <= 50000; it++) {
    const rv = rhoVec(), rhs = x.map((v) => sigma * v);
    for (let k = 0; k < m; k++) { const c = rv[k] * z[k] - y[k]; if (c) for (let i = 0; i < n; i++) if (A[k][i]) rhs[i] += c; }
    const xt = cholSolve(Lc, rhs), zt = Ax(xt);
    const xn = xt.map((v, i) => alphaR * v + (1 - alphaR) * x[i]);
    const zr = zt.map((v, k) => alphaR * v + (1 - alphaR) * z[k]);
    const zn = zr.map((v, k) => Math.min(up[k], Math.max(lo[k], v + y[k] / rv[k])));
    const yn = y.map((v, k) => v + rv[k] * (zr[k] - zn[k]));
    x = xn; z = zn; y = yn;
    if (it % 10 === 0) {
      const ax = Ax(x), px = Px(x);
      const aty = new Array(n).fill(0); for (let k = 0; k < m; k++) if (y[k]) for (let i = 0; i < n; i++) aty[i] += A[k][i] * y[k];
      const rp = Math.max(...ax.map((v, k) => Math.abs(v - z[k]))), rd = Math.max(...px.map((v, i) => Math.abs(v + aty[i])));
      const sp = Math.max(1, Math.max(...ax.map(Math.abs)), Math.max(...z.map((v) => Math.abs(Math.min(1e6, v))))), sd = Math.max(1, Math.max(...px.map(Math.abs)), Math.max(...aty.map(Math.abs)));
      if (rp <= tol * sp && rd <= tol * sd) { converged = true; break; }
      if (it % 50 === 0) { // adapta ρ según el balance entre residuos primal y dual
        const ratio = Math.sqrt((rp / sp) / (rd / sd + 1e-30));
        if (ratio > 5 || ratio < 0.2) { rho = Math.min(1e6, Math.max(1e-6, rho * ratio)); Lc = factor(); }
      }
    }
  }
  const obj = (v) => quad(v, Sigma);
  let w = x.slice(), pulido = false;
  // pulido: restricciones activas (por los multiplicadores) tratadas como igualdades → solución exacta
  try {
    const act = [];
    for (let k = 0; k < m; k++) {
      if (k === 0) act.push([k, 1]);
      else if (y[k] > 1e-9) act.push([k, up[k]]);
      else if (y[k] < -1e-9) act.push([k, lo[k]]);
    }
    const na = act.length, M = Array.from({ length: n + na }, () => new Array(n + na).fill(0)), rhs = new Array(n + na).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) M[i][j] = P[i][j];
    act.forEach(([k, b], r) => { for (let i = 0; i < n; i++) { M[i][n + r] = A[k][i]; M[n + r][i] = A[k][i]; } rhs[n + r] = b; });
    const sol = solveDense(M, rhs).slice(0, n);
    const ok = Ax(sol).every((v, k) => v >= lo[k] - 1e-10 && v <= up[k] + 1e-10);
    if (ok && obj(sol) <= obj(w) + 1e-12 * Math.abs(obj(w))) { w = sol; pulido = true; }
  } catch (e) { /* se queda con la solución de ADMM */ }
  const ax = Ax(w);
  const viol = Math.max(0, ...ax.map((v, k) => Math.max(lo[k] - v, v - up[k])), Math.abs(ax[0] - 1));
  return { exito: converged || pulido, mensaje: converged ? "Convergió" : pulido ? "Resuelto con el conjunto activo" : "No convergió", w, iteraciones: it, violacionMax: viol, objetivo: obj(w), pulido };
}

// Contribución de cada activo al riesgo (VaR normal): w_i (Σw)_i / (wᵀΣw), suma 1
export function riskContributions(Sigma, w) {
  const Sw = Sigma.map((r) => r.reduce((s, v, j) => s + v * w[j], 0)), tot = w.reduce((s, v, i) => s + v * Sw[i], 0);
  return w.map((v, i) => (v * Sw[i]) / tot);
}
