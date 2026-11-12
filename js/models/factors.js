// Señales de mercado complementarias a los 5 modelos (todas usan solo datos hasta hoy):
//   • momentum 12-1: lo que subió en el último año (sin el último mes) tiende a seguir subiendo unos meses
//   • último mes: a corto plazo suele haber un pequeño rebote en sentido contrario
//   • volatilidad actual frente a la normal del activo (EWMA vs 1 año)
//   • distancia al máximo de 52 semanas
//   • estado del mercado: índice regional (canasta equiponderada) frente a su promedio de 200 días
//   • fuerza relativa: rendimiento a 6 meses del activo menos el del mercado
// Además define el vector de variables que usa la regresión logística entrenada con el backtest (data/model.json).
import { clamp, mean, std, logReturns } from "../util.js";
import { buildCrossSection } from "./herding.js";

const lr = (a, b) => (a > 0 && b > 0 ? Math.log(b / a) : 0);

// Índice de mercado regional (log acumulado de la canasta equiponderada) alineado por día
export function marketIndex(universe) {
  if (!universe || universe.length < 4) return null;
  const cs = buildCrossSection(universe, 0.6, 4);
  if (cs.length < 60) return null;
  let acc = 0;
  return cs.map((d) => ({ day: d.day, lv: (acc += d.rm) }));
}

export function computeFactors(series, universe, mkt = marketIndex(universe)) {
  const c = series.c, n = c.length;
  const out = { available: n >= 260 };
  if (!out.available) return out;
  out.mom12 = clamp(lr(c[n - 253], c[n - 22]), -1.5, 1.5);
  out.mom1 = clamp(lr(c[n - 22], c[n - 1]), -0.6, 0.6);
  const r = logReturns(c.slice(-253));
  const sdY = std(r);
  let ew = sdY * sdY;
  for (const x of r) ew = 0.94 * ew + 0.06 * x * x; // EWMA (RiskMetrics, λ = 0,94)
  out.volNow = Math.sqrt(ew);
  out.volYear = sdY;
  out.volRatio = clamp(Math.log(Math.sqrt(ew) / sdY), -1.2, 1.2);
  out.hi52 = clamp(lr(Math.max(...c.slice(-252)), c[n - 1]), -1.5, 0);
  out.ret6 = lr(c[n - 127], c[n - 1]);
  if (mkt && mkt.length > 210) {
    const m = mkt.length, ma200 = mean(mkt.slice(-200).map((x) => x.lv));
    out.regime = clamp(mkt[m - 1].lv - ma200, -0.5, 0.5);
    out.mkt6 = mkt[m - 1].lv - mkt[Math.max(0, m - 127)].lv;
    out.relStr = clamp(out.ret6 - out.mkt6, -1.5, 1.5);
  } else { out.regime = 0; out.mkt6 = 0; out.relStr = 0; }
  return out;
}

// ---------- Tendencia: la señal de dirección del veredicto ----------
// Reglas fijadas de antemano según la literatura (no ajustadas a nuestros datos):
//   • momentum 12-1 de corte transversal: Jegadeesh y Titman (1993) — se compara con su canasta regional
//   • momentum de serie de tiempo: Moskowitz, Ooi y Pedersen (2012) — ¿subió o bajó en el último año?
//   • fuerza relativa a 6 meses frente al mercado
//   • castigo si está mucho más nerviosa de lo normal (la tendencia se rompe más en volatilidad alta)
// T = 0,45·(percentil momentum) + 0,25·(percentil fuerza relativa) + 0,30·tanh(momentum / 25 %) − castigo, en [−1, 1]
const pctRank = (arr, x) => (arr.length ? (arr.filter((v) => v < x).length + 0.5 * arr.filter((v) => v === x).length) / arr.length : 0.5);
export function computeTrend(f, universe, mkt) {
  if (!f.available) return { available: false, score: 0 };
  const peers = (universe || []).filter((u) => u.c.length >= 260);
  const mom = [], rel = [];
  for (const u of peers) {
    const c = u.c, n = c.length;
    mom.push(lr(c[n - 253], c[n - 22]));
    rel.push(lr(c[n - 127], c[n - 1]) - (f.mkt6 || 0));
  }
  const pMom = peers.length >= 5 ? pctRank(mom, f.mom12) : 0.5 + 0.5 * Math.tanh(f.mom12 / 0.25);
  const pRel = peers.length >= 5 ? pctRank(rel, f.relStr) : 0.5 + 0.5 * Math.tanh(f.relStr / 0.2);
  const ts = Math.tanh(f.mom12 / 0.25);
  const penalty = f.volRatio > 0.3 ? Math.min(0.25, (f.volRatio - 0.3) * 0.5) : 0;
  const score = clamp(0.45 * (2 * pMom - 1) + 0.25 * (2 * pRel - 1) + 0.30 * ts - penalty, -1, 1);
  return { available: true, score, pMom, pRel, ts, penalty, nPeers: peers.length };
}

// Orden fijo de variables del modelo entrenado (debe coincidir con tools/train_model.py)
export const FEATURES = ["merton", "meanrev", "realoptions", "vasicek", "herding", "mom12", "mom1", "volRatio", "hi52", "regime", "relStr"];
export function featureVector(contrib, f) {
  const by = Object.fromEntries(contrib.map((c) => [c.key, c.signal * c.confidence]));
  return FEATURES.map((k) => (k in by ? by[k] : f[k] ?? 0));
}

// Probabilidad de que el precio suba en el horizonte según la regresión logística del backtest
export function predictML(model, x) {
  if (!model || !model.coef || model.coef.length !== x.length) return null;
  let z = model.intercept;
  for (let i = 0; i < x.length; i++) z += model.coef[i] * (x[i] - model.mean[i]) / (model.scale[i] || 1);
  const p = 1 / (1 + Math.exp(-z));
  const parts = x.map((v, i) => ({ key: FEATURES[i], z: model.coef[i] * (v - model.mean[i]) / (model.scale[i] || 1) }));
  return { p, z, parts };
}

// Textos simples para mostrar en la app
export function factorNotes(f) {
  if (!f.available) return [];
  const pc = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round((Math.exp(x) - 1) * 100))} %`;
  const notes = [];
  notes.push({ key: "mom12", up: f.mom12 > 0.05 ? 1 : f.mom12 < -0.05 ? -1 : 0, text: `Último año (sin el último mes): ${pc(f.mom12)}` });
  notes.push({ key: "regime", up: f.regime > 0.02 ? 1 : f.regime < -0.02 ? -1 : 0, text: f.regime > 0.02 ? "Su mercado está en tendencia alcista" : f.regime < -0.02 ? "Su mercado está en tendencia bajista" : "Su mercado está de lado" });
  notes.push({ key: "relStr", up: f.relStr > 0.05 ? 1 : f.relStr < -0.05 ? -1 : 0, text: f.relStr > 0.05 ? "Le va mejor que a su mercado en 6 meses" : f.relStr < -0.05 ? "Le va peor que a su mercado en 6 meses" : "Va parecido a su mercado" });
  notes.push({ key: "volRatio", up: f.volRatio > 0.25 ? -1 : 0, text: f.volRatio > 0.25 ? "Está más nerviosa de lo normal" : f.volRatio < -0.25 ? "Está más tranquila de lo normal" : "Volatilidad normal" });
  return notes;
}
