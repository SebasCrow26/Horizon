// Estrategias de asignación y su evaluación fuera de muestra (con costos), más cantidades enteras.
// Funciones puras. Se verifican contra una referencia independiente en Python (tests/strategies_reference.py).
// Créditos: el diseño (comparar pesos iguales, inverso al VaR y mínimo VaR; rebalanceo mensual; presupuesto de riesgo)
// parte del Taller de valoración y riesgo de Felipe Pulido; este código es una implementación propia.
//
// Reglas (iguales en JS y Python):
//   • Ventana: últimos 757 precios comunes = 756 retornos; entrenamiento = primeros 504; prueba = últimos 252.
//     (Modo reducido: si hay menos retornos, la prueba sigue siendo de 252 y se entrena con los que haya, mínimo 252; params.nTrain / params.nTest.)
//   • Se rebalancea el día i0 = 504 (compra inicial) y, en las mensuales, el primer día de cada mes calendario de la prueba.
//   • En un rebalanceo del día t se estima con los 504 retornos conocidos hasta ese día: R[t−504 .. t−1]. Se opera al precio de t.
//   • Costo = c · Σ|valor nuevo − valor actual| (c = pb / 10.000), descontado del patrimonio (punto fijo). El efectivo gana r (continua, /252 por día).
//   • Mínimo VaR = mínima varianza con límites por activo y por sector (con media cero el VaR normal y la varianza se minimizan en el mismo punto).
import { covMatrix, minVariance, blockLosses, varEs, normInv, D } from "./risk.js";

export const N_TRAIN = 504, N_TEST = 252;
export const ESTRATEGIAS = {
  iguales: { nombre: "Pesos iguales", mensual: false },
  inverso: { nombre: "Inverso al VaR individual", mensual: false },
  minvar_estatica: { nombre: "Mínimo VaR (estática)", mensual: false },
  minvar_mensual: { nombre: "Mínimo VaR (rebalanceo mensual)", mensual: true },
  presupuesto_mensual: { nombre: "Mínimo VaR con presupuesto de riesgo (mensual)", mensual: true },
};

const monthKey = (day) => { const d = new Date(day * 86400000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const sumAbs = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);

// VaR histórico a h sesiones de CADA activo por separado (pérdida por unidad de capital)
export function individualVaR(Rw, h, alpha) {
  const n = Rw[0].length;
  return Array.from({ length: n }, (_, i) => varEs(blockLosses(Rw.map((r) => [r[i]]), [1], 1, h), alpha).VaR);
}
// w_i ∝ 1/VaR_i: solo mira el riesgo de cada acción por separado (ignora correlaciones y límites); sirve como comparación
export function inverseVarWeights(Rw, h, alpha) {
  const w = individualVaR(Rw, h, alpha).map((v) => 1 / v), s = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / s);
}
export const equalWeights = (n) => new Array(n).fill(1 / n);
export function minVarWeights(Rw, { wmin, wmax, groups }) {
  const r = minVariance(covMatrix(Rw, 1), { wmin, wmax, groups });
  if (!r.exito) throw new Error("No se pudo resolver el mínimo VaR: " + r.mensaje);
  return r.w;
}

// Fracciones objetivo del patrimonio en cada activo (el resto queda en efectivo) para una estrategia en el día t
export function targetFractions(clave, { R, t, V, params }) {
  const { alpha, h, wmin, wmax, groups, vbar } = params, nTrain = params.nTrain ?? N_TRAIN, Rw = R.slice(t - nTrain, t), n = R[0].length;
  if (clave === "iguales") return equalWeights(n);
  if (clave === "inverso") return inverseVarWeights(Rw, h, alpha);
  const w = minVarWeights(Rw, { wmin, wmax, groups });
  if (clave === "presupuesto_mensual") {
    const S = covMatrix(Rw, 1);
    let q = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) q += w[i] * S[i][j] * w[j];
    const varFull = V * normInv(alpha) * Math.sqrt(h * q), f = Math.min(1, vbar / varFull);
    return w.map((x) => f * x);
  }
  return w; // minvar_estatica y minvar_mensual
}

// P: precios comunes (≥ 757 filas × n), days: número de día de cada fila. Devuelve patrimonio diario y métricas.
export function backtest({ P, days, clave, params }) {
  const { B, r, costBps } = params, c = costBps / 1e4, mensual = ESTRATEGIAS[clave].mensual;
  const nTrain = params.nTrain ?? N_TRAIN, nTest = params.nTest ?? N_TEST, need = nTrain + nTest + 1;
  if (P.length < need) throw new Error(`Se necesitan ${need} sesiones comunes y hay ${P.length}.`);
  const Pw = P.slice(-need), Dw = days.slice(-need), n = Pw[0].length;
  const R = Pw.slice(1).map((row, k) => row.map((p, i) => p / Pw[k][i] - 1));
  const i0 = nTrain;
  let units = new Array(n).fill(0), cash = B, costTotal = 0, rot = 0;
  const W = [], log = [], g = Math.exp(r / D);
  for (let t = i0; t <= i0 + nTest; t++) {
    if (t > i0) cash *= g;
    let V = cash; for (let i = 0; i < n; i++) V += units[i] * Pw[t][i];
    const reb = t === i0 || (mensual && monthKey(Dw[t]) !== monthKey(Dw[t - 1]));
    if (reb) {
      const a = targetFractions(clave, { R, t, V, params });
      const cur = units.map((u, i) => u * Pw[t][i]);
      let cost = 0, nuevo = a;
      for (let k = 0; k < 200; k++) {
        nuevo = a.map((x) => x * (V - cost));
        const nc = c * sumAbs(nuevo, cur);
        if (Math.abs(nc - cost) < 1e-13) { cost = nc; break; }
        cost = nc;
      }
      nuevo = a.map((x) => x * (V - cost));
      rot += sumAbs(nuevo, cur); costTotal += cost;
      units = nuevo.map((v, i) => v / Pw[t][i]);
      cash = (V - cost) - nuevo.reduce((s, v) => s + v, 0);
      V = cash; for (let i = 0; i < n; i++) V += units[i] * Pw[t][i];
      log.push({ t, fecha: Dw[t], costo: cost, efectivo: cash, invertido: a.reduce((s, v) => s + v, 0), pesos: a.slice() });
    }
    W.push(V);
  }
  return { clave, nombre: ESTRATEGIAS[clave].nombre, W, ...metricas(W, B, r), costo: costTotal, rotacion: rot / B, rebalanceos: log.length, log, efectivoFinal: cash, dias: Dw.slice(i0) };
}

export function metricas(W, B, r) {
  const d = W.slice(1).map((v, k) => v / W[k] - 1), m = d.reduce((s, v) => s + v, 0) / d.length;
  const sd = Math.sqrt(d.reduce((s, v) => s + (v - m) ** 2, 0) / (d.length - 1));
  let pico = -Infinity, dd = 0;
  for (const v of W) { pico = Math.max(pico, v); dd = Math.max(dd, (pico - v) / pico); }
  return { retorno: W[W.length - 1] / B - 1, vol: sd * Math.sqrt(D), sharpe: ((m - (Math.exp(r / D) - 1)) / sd) * Math.sqrt(D), maxDD: dd };
}
export function drawdowns(W) { let pico = -Infinity; return W.map((v) => { pico = Math.max(pico, v); return (v - pico) / pico; }); }

// Montos y cantidades por acción: al redondear hacia abajo a acciones enteras sobra efectivo (sin riesgo)
export function integerAllocation({ w, B, S0, SigmaR, h, alpha }) {
  const qty = w.map((x, i) => Math.floor((B * x) / S0[i]));
  const invested = qty.reduce((s, q, i) => s + q * S0[i], 0), wNew = qty.map((q, i) => (q * S0[i]) / invested);
  let q2 = 0; for (let i = 0; i < wNew.length; i++) for (let j = 0; j < wNew.length; j++) q2 += wNew[i] * SigmaR[i][j] * wNew[j];
  return {
    cantidades: qty, montos: qty.map((q, i) => q * S0[i]), invertido: invested, residual: B - invested, pesosNuevos: wNew,
    VaRNormal: invested * normInv(alpha) * Math.sqrt(h * q2),
  };
}
