// Verificación de js/risk.js contra la referencia independiente en Python (numpy + scipy) y contra casos analíticos.
// Antes:  python -X utf8 -I tests/risk_reference.py   (genera tests/fixtures/risk_expected.json)
// Luego:  node tests/risk.test.mjs
import { readFileSync } from "node:fs";
import { snapToSeries } from "../js/data.js";
import {
  alignMany, covMatrix, erfc, normCdfP, normInv, varEs, blockLosses, varNormal, mcLosses, stress, kupiec, exceptionsBacktest,
  riskBudget, minVariance, riskContributions,
} from "../js/risk.js";

const snap = JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url)));
const E = JSON.parse(readFileSync(new URL("./fixtures/risk_expected.json", import.meta.url)));
let ok = 0, fallos = 0;
const casi = (nombre, obtenido, esperado, tolAbs, tolRel = 0) => {
  const err = Math.abs(obtenido - esperado), lim = tolAbs + tolRel * Math.abs(esperado);
  if (err <= lim) { ok++; return; }
  fallos++; console.log(`  ✗ ${nombre}: JS ${obtenido} vs referencia ${esperado} (error ${err.toExponential(2)} > ${lim.toExponential(2)})`);
};
const igual = (nombre, a, b) => { if (a === b) { ok++; } else { fallos++; console.log(`  ✗ ${nombre}: ${a} ≠ ${b}`); } };
const maxDif = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

// ---------- 1) casos analíticos de la normal ----------
console.log("1) Distribución normal");
casi("Φ⁻¹(0,975)", normInv(0.975), 1.959963984540054, 1e-12);
casi("Φ⁻¹(0,99)", normInv(0.99), 2.3263478740408408, 1e-12);
casi("Φ⁻¹(0,9)", normInv(0.9), 1.2815515655446004, 1e-12);
casi("Φ⁻¹(0,5)", normInv(0.5), 0, 1e-14);
casi("Φ⁻¹(1e-6)", normInv(1e-6), -4.753424308822899, 1e-10);
casi("erfc(1)", erfc(1), 0.15729920705028513, 1e-14);
casi("erfc(3)", erfc(3), 2.209049699858544e-05, 1e-17);
casi("erfc(-1)", erfc(-1), 1.8427007929497148, 1e-14);
casi("Φ(1,96)", normCdfP(1.96), 0.9750021048517795, 1e-14);

// ---------- 2) datos reales: alineación y covarianza ----------
console.log("2) Datos reales: sesiones comunes y covarianza");
const lista = E.tickers.map((s) => snapToSeries(snap, s));
const al = alignMany(lista);
igual("sesiones comunes", al.info.sesionesComunes, E.sesionesComunes);
igual("retornos", al.info.retornos, E.retornos);
const Sg = covMatrix(al.R, 1);
casi("covarianza (diferencia máxima)", Math.max(...Sg.map((r, i) => maxDif(r, E.SigmaR[i]))), 0, 1e-14);

// ---------- 3) VaR y ES de la cartera de pesos iguales ----------
console.log("3) VaR y ES (histórico, normal, Monte Carlo)");
const w = E.iguales.w, { B, alpha, h } = E;
const Hh = varEs(blockLosses(al.R, w, B, h), alpha), ref = E.iguales;
casi("VaR histórico", Hh.VaR, ref.hist.VaR, 1e-6);
casi("ES histórico", Hh.ES, ref.hist.ES, 1e-6);
casi("peor pérdida histórica", Hh.worst, ref.hist.peor, 1e-6);
igual("bloques", Hh.n, ref.hist.bloques);
igual("observaciones en la cola", Hh.tail, ref.hist.cola);
igual("empates con el VaR", Hh.ties, ref.hist.empates);
const Hn = varEs(blockLosses(al.R, w, B, h, h), alpha);
igual("bloques sin solape", Hn.n, ref.hist.bloquesSinSolape);
casi("VaR histórico sin solape", Hn.VaR, ref.hist.VaRSinSolape, 1e-6);
const N = varNormal(Sg, w, B, alpha, h);
casi("VaR normal", N.VaR, ref.normal.VaR, 1e-6);
casi("ES normal", N.ES, ref.normal.ES, 1e-6);
const mc = varEs(mcLosses(al.X, w, B, h, 200000, 7), alpha); // la referencia usa otro generador: se compara dentro del error de muestreo
casi("VaR Monte Carlo (≤ 2 %)", mc.VaR, ref.mc.VaR, 0, 0.02);
casi("ES Monte Carlo (≤ 2 %)", mc.ES, ref.mc.ES, 0, 0.02);

// ---------- 4) estrés ----------
console.log("4) Estrés");
const st = stress({ w, B, SigmaR: Sg, h, alpha, groups: E.sector });
casi("estrés: todas caen 10 %", st[0].perdida, ref.estres[0], 1e-9);
casi("estrés: sector con más peso", st[1].perdida, ref.estres[1], 1e-9);
casi("estrés: crisis (σ×1,5 y ρ 0,8)", st[2].perdida, ref.estres[2], 1e-6);
igual("sector más pesado", st[1].sector, ref.estres[3]);

// ---------- 5) Kupiec y excepciones ----------
console.log("5) Prueba de Kupiec");
for (const c of E.kupiec) { const k = kupiec(c.x, c.n, c.p); casi(`Kupiec LR (x=${c.x}, n=${c.n}, p=${c.p})`, k.LR, c.LR, 1e-10); casi(`Kupiec p-valor (x=${c.x}, n=${c.n})`, k.pValor, c.pValor, 1e-10); }

// ---------- 6) optimizador de mínimo riesgo ----------
console.log("6) Portafolio de mínimo riesgo (contra SLSQP de scipy)");
const idxSector = E.gruposSector.map((g) => ({ limit: g.limit, idx: g.idx }));
const A = minVariance(Sg, { wmin: E.wmin, wmax: E.wmax });
casi("acotado: diferencia máxima de pesos", maxDif(A.w, E.optimo.acotado.w), 0, 1e-6);
casi("acotado: objetivo", A.objetivo, E.optimo.acotado.obj, 0, 1e-8);
casi("acotado: violación de restricciones", A.violacionMax, 0, 1e-9);
const Bs = minVariance(Sg, { wmin: E.wmin, wmax: E.wmax, groups: idxSector });
casi("con sectores: diferencia máxima de pesos", maxDif(Bs.w, E.optimo.sectores.w), 0, 1e-6);
casi("con sectores: objetivo", Bs.objetivo, E.optimo.sectores.obj, 0, 1e-8);
casi("con sectores: violación de restricciones", Bs.violacionMax, 0, 1e-9);
const aj = E.gruposAjustados.map((g) => ({ limit: g.limit, idx: g.idx }));
const D2 = minVariance(Sg, { wmin: E.wmin, wmax: E.wmax, groups: aj });
casi("límite sectorial ACTIVO: diferencia máxima de pesos", maxDif(D2.w, E.optimo.ajustado.w), 0, 1e-6);
casi("límite sectorial ACTIVO: objetivo", D2.objetivo, E.optimo.ajustado.obj, 0, 1e-8);
casi("límite sectorial ACTIVO: violación", D2.violacionMax, 0, 1e-9);
for (const g of aj) casi("el sector queda justo en su límite", g.idx.reduce((s, i) => s + D2.w[i], 0), g.limit, 1e-8);
igual("el límite sectorial cambió la solución", maxDif(D2.w, A.w) > 1e-3, true);
const C = minVariance(Sg, { wmin: -5, wmax: 5 });
casi("interior vs solución cerrada Σ⁻¹1/(1ᵀΣ⁻¹1)", maxDif(C.w, E.optimo.interior.cerrada), 0, 1e-8);
casi("interior vs SLSQP", maxDif(C.w, E.optimo.interior.w), 0, 1e-6);
const sumaW = Bs.w.reduce((s, v) => s + v, 0);
casi("los pesos suman 1", sumaW, 1, 1e-12);
const rc = riskContributions(Sg, Bs.w);
casi("las contribuciones al riesgo suman 1", rc.reduce((s, v) => s + v, 0), 1, 1e-12);
const imposible = minVariance(Sg, { wmin: 0.2, wmax: 0.2 });
igual("límites imposibles se detectan", imposible.exito, false);

// ---------- 7) excepciones del VaR diario con la cartera óptima ----------
console.log("7) Excepciones del VaR diario");
const bt = exceptionsBacktest(al.R, Bs.w, B, alpha, 252);
igual("excepciones", bt.x, E.backtest.x);
igual("días evaluados", bt.n, E.backtest.n);
casi("Kupiec del backtest: LR", bt.LR, E.backtest.LR, 1e-9);
casi("Kupiec del backtest: p-valor", bt.pValor, E.backtest.pValor, 1e-9);

// ---------- 8) presupuesto de riesgo ----------
console.log("8) Presupuesto de riesgo");
const pr = riskBudget({ w: Bs.w, B, VaRfull: 8000, Vbar: 5000 });
casi("f = V̄ / VaR", pr.f, 0.625, 1e-12);
casi("efectivo", pr.efectivo, 37500, 1e-9);
casi("VaR final = V̄", pr.VaRfinal, 5000, 1e-9);
casi("montos + efectivo = capital", pr.montos.reduce((s, v) => s + v, 0) + pr.efectivo, B, 1e-6);
igual("f = 1 si el VaR ya cabe", riskBudget({ w, B, VaRfull: 3000, Vbar: 5000 }).f, 1);

console.log(`\nRiesgo: ${ok} comprobaciones correctas, ${fallos} fallos`);
if (fallos) process.exit(1);
console.log("Riesgo: todo en orden");
