// Verifica js/gbm.js contra la referencia en Python y contra la teoría de la lognormal.
// Antes:  python -X utf8 -I tests/strategies_reference.py && python -X utf8 -I tests/gbm_reference.py     Luego:  node tests/gbm.test.mjs
import { readFileSync } from "node:fs";
import { calibrate, dividendYield, simulateGBM, rollingEval } from "../js/gbm.js";

const F = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const X = F("strategies_prices.json"), E = F("gbm_expected.json");
let ok = 0, fallos = 0;
const casi = (nombre, a, b, abs, rel = 0) => { const e = Math.abs(a - b), l = abs + rel * Math.abs(b); if (e <= l) ok++; else { fallos++; console.log(`  ✗ ${nombre}: JS ${a} vs referencia ${b} (error ${e.toExponential(2)} > ${l.toExponential(2)})`); } };
const igual = (nombre, a, b) => { if (a === b) ok++; else { fallos++; console.log(`  ✗ ${nombre}: ${a} ≠ ${b}`); } };

const P = X.precios.slice(-757), n = P[0].length, col = (i) => P.map((r) => r[i]);

console.log("1) Calibración μ = D·x̄ + σ²/2,  a = μ − q");
for (let i = 0; i < n; i++) {
  const c = calibrate(col(i).slice(0, 505), E.q[i]), r = E.calibracion[i];
  igual(`n retornos activo ${i}`, c.n, r.n);
  casi(`x̄ activo ${i}`, c.xbar, r.xbar, 1e-15); casi(`s activo ${i}`, c.s, r.s, 1e-14); casi(`σ activo ${i}`, c.sigma, r.sigma, 1e-13);
  casi(`μ total activo ${i}`, c.muTotal, r.muTotal, 1e-12); casi(`a = μ − q activo ${i}`, c.a, r.a, 1e-12);
}

console.log("2) Dividend yield continuo");
const dy = dividendYield(E.dividendos.divs, E.dividendos.S0, E.dividendos.asOf);
casi("suma de 12 meses", dy.suma12m, E.dividendos.suma12m, 1e-12); casi("q = ln(1 + div/S0)", dy.q, E.dividendos.q, 1e-14);

console.log("3) Evaluación rolling (RMSE, MAPE y pronóstico ingenuo)");
for (const H of [1, 5, 10, 21]) {
  for (let i = 0; i < n; i++) {
    const r = rollingEval({ P: col(i), H, window: 252, firstOrigin: 504 }), ref = E.rolling[String(H)][i];
    igual(`m (H=${H}, activo ${i})`, r.m, ref.m);
    casi(`RMSE (H=${H}, activo ${i})`, r.RMSE, ref.RMSE, 1e-9, 1e-12); casi(`RMSE ingenuo (H=${H}, activo ${i})`, r.RMSE_ingenuo, ref.RMSE_ingenuo, 1e-9, 1e-12);
    casi(`razón (H=${H}, activo ${i})`, r.razon, ref.razon, 1e-12); casi(`MAPE (H=${H}, activo ${i})`, r.MAPE, ref.MAPE, 1e-9, 1e-12); casi(`MAPE ingenuo (H=${H}, activo ${i})`, r.MAPE_ingenuo, ref.MAPE_ingenuo, 1e-9, 1e-12);
  }
}
igual("m = 253 − H para H = 1", rollingEval({ P: col(0), H: 1, firstOrigin: 504 }).m, 252);

console.log("4) Simulación del GBM frente a la teoría (10.000 trayectorias, semilla fija)");
const t = E.teoria, s = simulateGBM({ S0: t.S0, a: t.a, sigma: t.sigma, steps: t.steps, nPaths: 10000, seed: 123 });
casi("T en años", s.T, t.T, 1e-15);
igual("todas las trayectorias son positivas", s.todosPositivos, true);
igual("40 caminos de muestra", s.sample.length, 40);
igual("cada camino tiene steps + 1 puntos", s.sample[0].length, t.steps + 1);
casi("la media simulada está a < 4 errores estándar de S0·e^(aT)", Math.abs(s.z) < 4 ? 0 : 1, 0, 0);
casi("S0·e^(aT)", s.teorica, t.media, 1e-9);
const ST = Array.from(s.ST).sort((x, y) => x - y), q = (p) => ST[Math.floor(p * (ST.length - 1))];
casi("cuantil 10 % simulado (≤ 1,5 % de error)", q(0.1), t.q10, 0, 0.015);
casi("mediana simulada (≤ 1,5 %)", q(0.5), t.q50, 0, 0.015);
casi("cuantil 90 % simulado (≤ 1,5 %)", q(0.9), t.q90, 0, 0.015);
casi("banda p10 final", s.bands.p10.at(-1), t.q10, 0, 0.015); casi("banda p90 final", s.bands.p90.at(-1), t.q90, 0, 0.015);
casi("la banda parte en S0", s.bands.p50[0], t.S0, 1e-9);
const s2 = simulateGBM({ S0: t.S0, a: t.a, sigma: t.sigma, steps: t.steps, nPaths: 10000, seed: 123 });
igual("reproducible con la misma semilla", s2.media, s.media);
igual("distinta con otra semilla", simulateGBM({ S0: t.S0, a: t.a, sigma: t.sigma, steps: 20, nPaths: 5000, seed: 1 }).media !== simulateGBM({ S0: t.S0, a: t.a, sigma: t.sigma, steps: 20, nPaths: 5000, seed: 2 }).media, true);

console.log(`\nGBM: ${ok} comprobaciones correctas, ${fallos} fallos`);
if (fallos) process.exit(1);
console.log("GBM: todo en orden");
