// GBM calibrado como en el Taller de valoración y riesgo: proyección bajo la medida física P y evaluación rolling.
// Créditos: el diseño (calibración, simulación y evaluación contra el pronóstico ingenuo) parte del taller de Felipe Pulido;
// este código es una implementación propia. Se verifica contra una referencia en Python (tests/gbm_reference.py).
//
//   σ̂ = √D · s_x                       (s_x: desviación estándar muestral, divisor n−1, de los log-retornos diarios)
//   μ̂_total = D · x̄ + σ̂²/2            (rendimiento esperado anual total)
//   â = μ̂_total − q                     (deriva del spot ex-dividendo; q = dividend yield continuo anual)
//   S_{t+Δt} = S_t · exp[(â − σ̂²/2)Δt + σ̂ √Δt · Z],   Z ~ N(0,1),  Δt = 1/D,  D = 252
import { rng, randn, quantile } from "./util.js";
import { D } from "./risk.js";

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const logRet = (P) => P.slice(1).map((p, k) => Math.log(p / P[k]));

// Parámetros a partir de una serie de precios (ajustados) de entrenamiento
export function calibrate(prices, q = 0) {
  const x = logRet(prices), n = x.length, xbar = mean(x);
  const s = Math.sqrt(x.reduce((a, v) => a + (v - xbar) ** 2, 0) / (n - 1));
  const sigma = Math.sqrt(D) * s, muTotal = D * xbar + (sigma * sigma) / 2;
  return { n, xbar, s, sigma, muTotal, q, a: muTotal - q };
}

// Dividend yield continuo anual: ln(1 + dividendos de los últimos 12 meses / S0)
export function dividendYield(divs, S0, asOfSec) {
  const desde = asOfSec - 365 * 86400;
  const suma = (divs || []).filter((d) => d.t > desde && d.t <= asOfSec).reduce((s, d) => s + d.amount, 0);
  return { q: Math.log1p(suma / S0), suma12m: suma };
}

// Simulación de trayectorias. Devuelve estadísticas, 40 caminos de muestra y la banda 10–90
export function simulateGBM({ S0, a, sigma, steps, nPaths = 10000, seed = 123, keep = 40, withBands = true }) {
  const dt = 1 / D, drift = (a - (sigma * sigma) / 2) * dt, vol = sigma * Math.sqrt(dt), r = rng(seed);
  const all = new Float32Array(nPaths * (steps + 1)), ST = new Float64Array(nPaths);
  let positivos = true;
  for (let k = 0; k < nPaths; k++) {
    let ls = Math.log(S0);
    all[k * (steps + 1)] = S0;
    for (let t = 1; t <= steps; t++) { ls += drift + vol * randn(r); const s = Math.exp(ls); if (!(s > 0)) positivos = false; all[k * (steps + 1) + t] = s; }
    ST[k] = Math.exp(ls);
  }
  const T = steps * dt, media = mean(Array.from(ST)), teor = S0 * Math.exp(a * T);
  const sd = Math.sqrt(Array.from(ST).reduce((acc, v) => acc + (v - media) ** 2, 0) / (nPaths - 1)), se = sd / Math.sqrt(nPaths);
  const bands = { p10: [], p50: [], p90: [] }, col = new Float64Array(nPaths);
  for (let t = 0; withBands && t <= steps; t++) {
    for (let k = 0; k < nPaths; k++) col[k] = all[k * (steps + 1) + t];
    const s = col.slice().sort();
    bands.p10.push(quantile(s, 0.1)); bands.p50.push(quantile(s, 0.5)); bands.p90.push(quantile(s, 0.9));
  }
  const sample = []; for (let k = 0; k < Math.min(keep, nPaths); k++) sample.push(Array.from(all.slice(k * (steps + 1), (k + 1) * (steps + 1))));
  return { S0, a, sigma, steps, nPaths, seed, T, ST, media, teorica: teor, ee: se, z: (media - teor) / se, todosPositivos: positivos, bands, sample };
}

// Evaluación rolling: en cada origen t se reestiman μ_total y σ con los `window` log-retornos que terminan en t y se pronostica
// la serie ajustada H sesiones adelante:  P̂_{t+H|t} = P_t · exp(μ̂_total · H / D).  Se compara con el ingenuo P̂ = P_t.
//   RMSE = √(media e²),  MAPE = 100 · media(|e| / P_{t+H}),  e = pronóstico − observado.
export function rollingEval({ P, H, window = 252, firstOrigin }) {
  const M = P.length - 1, o0 = firstOrigin ?? window;
  if (o0 < window) throw new Error("El primer origen necesita al menos " + window + " retornos previos.");
  const f = [], nv = [], obs = [], origenes = [];
  for (let t = o0; t + H <= M; t++) {
    const { muTotal } = calibrate(P.slice(t - window, t + 1));
    f.push(P[t] * Math.exp((muTotal * H) / D)); nv.push(P[t]); obs.push(P[t + H]); origenes.push(t);
  }
  const m = obs.length;
  const rmse = (p) => Math.sqrt(mean(p.map((v, i) => (v - obs[i]) ** 2)));
  const mape = (p) => 100 * mean(p.map((v, i) => Math.abs(v - obs[i]) / obs[i]));
  return { H, m, origenes, pronostico: f, ingenuo: nv, observado: obs, RMSE: rmse(f), RMSE_ingenuo: rmse(nv), razon: rmse(f) / rmse(nv), MAPE: mape(f), MAPE_ingenuo: mape(nv) };
}
