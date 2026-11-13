// Verifica js/strategies.js contra la referencia independiente en Python.
// Antes:  python -X utf8 -I tests/strategies_reference.py     Luego:  node tests/strategies.test.mjs
import { readFileSync } from "node:fs";
import { covMatrix } from "../js/risk.js";
import { backtest, ESTRATEGIAS, integerAllocation, equalWeights, inverseVarWeights, metricas, drawdowns, N_TRAIN } from "../js/strategies.js";

const F = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const X = F("strategies_prices.json"), E = F("strategies_expected.json");
let ok = 0, fallos = 0;
const casi = (nombre, a, b, abs, rel = 0) => { const e = Math.abs(a - b), l = abs + rel * Math.abs(b); if (e <= l) ok++; else { fallos++; console.log(`  ✗ ${nombre}: JS ${a} vs referencia ${b} (error ${e.toExponential(2)} > ${l.toExponential(2)})`); } };
const igual = (nombre, a, b) => { if (a === b) ok++; else { fallos++; console.log(`  ✗ ${nombre}: ${a} ≠ ${b}`); } };

const p = E.params;
const params = { B: p.B, alpha: p.alpha, h: p.h, r: p.r, costBps: p.costoPb, wmin: p.wmin, wmax: p.wmax, groups: E.gruposSector.map((g) => ({ limit: g.limit, idx: g.idx })), vbar: p.vbar };

for (const clave of Object.keys(E.estrategias)) {
  console.log(`Estrategia: ${ESTRATEGIAS[clave].nombre}`);
  const ref = E.estrategias[clave];
  const r = backtest({ P: X.precios, days: X.dias, clave, params });
  casi("patrimonio final (rel. 1e-6)", r.W[r.W.length - 1], ref.W[ref.W.length - 1], 0, 1e-6);
  casi("curva de patrimonio: diferencia máxima relativa", Math.max(...r.W.map((v, i) => Math.abs(v - ref.W[i]) / ref.W[i])), 0, 1e-6);
  casi("retorno total", r.retorno, ref.retorno, 1e-7);
  casi("volatilidad anual", r.vol, ref.vol, 1e-6);
  casi("Sharpe", r.sharpe, ref.sharpe, 1e-4);
  casi("drawdown máximo", r.maxDD, ref.maxDD, 1e-7);
  casi("costos totales (USD)", r.costo, ref.costo, 1e-3);
  casi("rotación", r.rotacion, ref.rotacion, 1e-6);
  igual("número de rebalanceos", r.rebalanceos, ref.rebalanceos);
  casi("efectivo final", r.efectivoFinal, ref.efectivoFinal, 1e-2);
  casi("fracción invertida en el último rebalanceo", r.log[r.log.length - 1].invertido, ref.fUltimo, 1e-6);
}

console.log("Reglas básicas");
const est = backtest({ P: X.precios, days: X.dias, clave: "iguales", params });
casi("estática compra una sola vez: costo = c·B/(1+c)", est.costo, (params.B * 1e-3) / 1.001, 1e-9);
igual("estática: un solo rebalanceo", est.rebalanceos, 1);
igual("mensual: compra inicial + 12 meses = 13", backtest({ P: X.precios, days: X.dias, clave: "minvar_mensual", params }).rebalanceos, 13);
const presupuesto = backtest({ P: X.precios, days: X.dias, clave: "presupuesto_mensual", params });
igual("el presupuesto de riesgo deja efectivo (f < 1)", presupuesto.log.every((l) => l.invertido < 1 - 1e-9), true);
igual("sin información del futuro: la curva empieza en B menos el costo inicial", Math.abs(est.W[0] - (params.B - est.log[0].costo)) < 1e-6, true);
let falla = false; try { backtest({ P: X.precios.slice(0, 700), days: X.dias.slice(0, 700), clave: "iguales", params }); } catch (e) { falla = /757|sesiones comunes/.test(e.message); }
igual("pocas sesiones: se avisa con un error claro", falla, true);

console.log("Cantidades enteras");
const Pw = X.precios.slice(-(N_TRAIN + 253)), R = Pw.slice(1).map((row, k) => row.map((v, i) => v / Pw[k][i] - 1));
const w0 = E.enteras.w, int = integerAllocation({ w: w0, B: params.B, S0: E.enteras.S0, SigmaR: covMatrix(R.slice(0, N_TRAIN), 1), h: params.h, alpha: params.alpha });
igual("cantidades", JSON.stringify(int.cantidades), JSON.stringify(E.enteras.cantidades));
casi("invertido", int.invertido, E.enteras.invertido, 1e-8);
casi("efectivo residual", int.residual, E.enteras.residual, 1e-8);
casi("VaR normal con acciones enteras", int.VaRNormal, E.enteras.VaRNormal, 1e-6);
casi("invertido + residual = capital", int.invertido + int.residual, params.B, 1e-9);

console.log("Métricas auxiliares");
casi("drawdown de una curva conocida", Math.min(...drawdowns([100, 120, 90, 110, 130, 104])), -0.25, 1e-12);
casi("máximo drawdown (metricas)", metricas([100, 120, 90, 110, 130, 104], 100, 0).maxDD, 0.25, 1e-12);
casi("pesos iguales suman 1", equalWeights(8).reduce((s, v) => s + v, 0), 1, 1e-15);
casi("pesos inversos al VaR suman 1", inverseVarWeights(R.slice(0, N_TRAIN), params.h, params.alpha).reduce((s, v) => s + v, 0), 1, 1e-12);

console.log(`\nEstrategias: ${ok} comprobaciones correctas, ${fallos} fallos`);
if (fallos) process.exit(1);
console.log("Estrategias: todo en orden");
