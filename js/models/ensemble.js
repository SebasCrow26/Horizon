// Combina los 5 modelos en un veredicto: comprar / acumular / mantener / reducir / vender.
// Cada modelo entrega una señal s ∈ [−1, 1] y una confianza c ∈ [0, 1]. La señal combinada es
//   S = Σ w_i · c_i · s_i / Σ w_i        (la confianza atenúa el peso de cada modelo)
import { clamp, TRADING_DAYS, nf } from "../util.js";
import { analyzeVasicek } from "./vasicek.js";
import { analyzeMerton } from "./merton.js";
import { analyzeMeanReversion } from "./meanreversion.js";
import { analyzeHerding } from "./herding.js";
import { analyzeRealOptions } from "./realoptions.js";
import { computeFactors, computeTrend, marketIndex, featureVector, predictML } from "./factors.js";

export const WEIGHTS = { merton: 0.30, meanrev: 0.26, realoptions: 0.20, vasicek: 0.14, herding: 0.10 };
export const MODEL_NAMES = {
  merton: "Saltos de Merton", meanrev: "Reversión a la media", realoptions: "Opciones reales",
  vasicek: "Vasicek (tasas)", herding: "Comportamiento en manada",
};

// Umbrales de la señal de tendencia (versión 2). Los de la señal de los 5 modelos (versión 1) eran ±0,12 / ±0,30.
export const THRESHOLDS = { buy: 0.45, accumulate: 0.2 };
export function verdictFor(S, riskLevel, th = THRESHOLDS) {
  let v;
  if (S >= th.buy) v = { key: "buy", label: "Comprar", tone: "pos2" };
  else if (S >= th.accumulate) v = { key: "accumulate", label: "Comprar de a poco", tone: "pos1" };
  else if (S > -th.accumulate) v = { key: "hold", label: "Esperar", tone: "neu" };
  else if (S > -th.buy) v = { key: "reduce", label: "Vender una parte", tone: "neg1" };
  else v = { key: "sell", label: "Vender", tone: "neg2" };
  if (riskLevel === "alto" && (v.key === "buy" || v.key === "accumulate")) v = { key: "accumulate", label: "Comprar con cautela", tone: "pos1", cautious: true };
  return v;
}

export function analyzeAll({ series, rates, universe, region, horizonDays = 63, erp = 0.05, model = null }) {
  const prices = series.c;
  if (!prices || prices.length < 250) throw new Error("Se necesitan al menos 250 días de datos.");
  const S0 = prices[prices.length - 1];

  const vasicek = analyzeVasicek(rates, series, { horizonDays });
  const rf = vasicek.available ? vasicek.rfAvg : 0.04;
  const herding = analyzeHerding(universe, series, { region });
  const beta = clamp(herding.betaMkt ?? 1, 0.2, 2.5);
  const rho = rf + beta * erp; // rendimiento exigido (CAPM)
  const merton = analyzeMerton(prices, { rf, rho, horizonDays, erp });
  const meanrev = analyzeMeanReversion(prices, { horizonDays });

  // visión combinada del rendimiento esperado: Merton + reversión (según su fiabilidad)
  const wMR = meanrev.reliability;
  const eView = (merton.expReturn + wMR * meanrev.expReturn) / (1 + wMR);
  const realoptions = analyzeRealOptions({ S0, sigma: merton.totalVolYear, rBar: rf, eView, rho, horizonDays });

  const models = { merton, meanrev, realoptions, vasicek, herding };
  let num = 0, den = 0, agreeW = 0, activeW = 0;
  const contrib = [];
  for (const [k, w] of Object.entries(WEIGHTS)) {
    const m = models[k];
    const s = m.available === false ? 0 : m.signal, c = m.available === false ? 0 : m.confidence;
    num += w * c * s; den += w;
    contrib.push({ key: k, name: MODEL_NAMES[k], signal: s, confidence: c, weight: w, value: w * c * s });
  }
  const score5 = clamp(num / den * 2.4, -1, 1); // opinión de los 5 modelos (factor 2,4: lleva ±0,4 a ±1)
  for (const c of contrib) { if (Math.abs(c.signal) >= 0.1) { activeW += c.weight; if (Math.sign(c.signal) === Math.sign(score5)) agreeW += c.weight; } }
  const agreement = activeW > 0 ? agreeW / activeW : 0;
  const confidence = clamp(contrib.reduce((s, c) => s + c.weight * c.confidence, 0) / den, 0, 1);

  // Dirección: tendencia (momentum + fuerza relativa). El backtest de 10 años mostró que la opinión de los
  // 5 modelos no anticipaba la dirección, pero sus rangos de riesgo sí están calibrados (≈ 82 % dentro de p10–p90).
  const factors = computeFactors(series, universe, marketIndex(universe));
  const trend = computeTrend(factors, universe);
  const S = trend.available ? trend.score : score5;
  const riskLevel = merton.es5 < -0.30 ? "alto" : merton.es5 < -0.18 ? "medio" : "bajo";
  const verdict = verdictFor(S, riskLevel);

  // precio objetivo: mezcla del centro de Merton y del equilibrio de reversión (si es fiable)
  const wm = 1, wr = meanrev.reliability * 0.8;
  const target = (wm * merton.q.p50 + wr * meanrev.target) / (wm + wr);

  const reasons = [];
  const byAbs = [...contrib].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  for (const c of byAbs.slice(0, 4)) {
    const m = models[c.key];
    reasons.push({ key: c.key, name: c.name, signal: c.signal, text: m.headline });
  }
  const flags = [];
  if (riskLevel === "alto") flags.push("Riesgo de caída brusca alto: en el peor 5 % de los casos se pierde " + nf((-merton.es5 * 100), 0) + " %.");
  if (herding.available && herding.recent?.herding && herding.mkt20 > 0.04) flags.push("Manada alcista en el mercado: posible sobrevaloración colectiva.");
  if (herding.available && herding.recent?.herding && herding.mkt20 < -0.04) flags.push("Manada bajista: el pánico puede ser contagioso (y a veces una oportunidad).");
  if (vasicek.available && Math.abs(vasicek.impact) > 0.01) flags.push(`Las tasas de interés ${vasicek.impact > 0 ? "darían viento a favor" : "serían un viento en contra"} (${nf((vasicek.impact * 100), 1)} %).`);
  if (!meanrev.reverts) flags.push("La reversión a la media no es estadísticamente significativa en esta acción.");

  // señales de mercado (momentum, tendencia del mercado, volatilidad) y modelo entrenado con el backtest
  const features = factors.available ? featureVector(contrib, factors) : null;
  const mlModel = model && model.byHorizon ? model.byHorizon[String(horizonDays)] : null;
  const ml = features && mlModel ? predictML(mlModel, features) : null;

  return {
    factors, features, ml, trend, score5, verdict5: verdictFor(score5, riskLevel, { buy: 0.30, accumulate: 0.12 }),
    symbol: series.sym, name: series.name, currency: series.cur, S0, horizonDays, rf, erp,
    models, contrib, score: S, confidence, agreement, verdict, riskLevel,
    target, expReturn: merton.expReturn, probUp: merton.probUp,
    range: { lo: merton.q.p10, hi: merton.q.p90 }, stop: realoptions.stop, priceBuy: realoptions.priceBuy,
    upside: target / S0 - 1, downside: realoptions.stop / S0 - 1,
    reasons, flags, asOf: series.t[series.t.length - 1], source: series.source,
  };
}
