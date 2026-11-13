// Opciones reales aplicadas a la decisión de invertir en una acción.
// Idea: invertir es como ejercer una opción. Esperar tiene valor (opción de diferir) y tener una
// salida preparada también (opción de abandonar). Se valoran con un árbol binomial CRR (americano):
//   · Valor del proyecto  V0 = S0 · (1 + E[rend.]) / (1 + ρ)   → qué tanto "vale" más que su precio
//   · Costo de inversión  I  = S0 · (1 + costo de transacción)
//   · Opción de diferir   = call americana sobre V con strike I (costo de esperar δ = rendimiento esperado que se deja de ganar)
//   · Opción de abandonar = put americana con piso (1 − L)·I
// Salida: precio máximo al que conviene comprar, piso de protección y qué hacer ahora.
import { clamp, nf, fmtPriceNum as fp } from "../util.js";

// Probabilidad neutral al riesgo del árbol CRR. Se VERIFICA que quede en (0, 1) (condición de no arbitraje d < e^{(r−δ)Δt} < u);
// no se recorta. Si no se cumple, se aumentan los pasos (Δt más chico) hasta que se cumpla; si ni así, se avisa con un error.
export function crrParams({ T, r, delta, sigma, steps = 80, maxSteps = 5120 }) {
  let n = steps;
  for (;;) {
    const dt = T / n, sq = sigma * Math.sqrt(dt), u = Math.exp(sq), d = 1 / u;
    const p = (Math.exp((r - delta) * dt) - d) / (u - d);
    if (p > 0 && p < 1) return { steps: n, dt, sq, u, d, p, disc: Math.exp(-r * dt), pasosAumentados: n !== steps };
    if (n >= maxSteps) throw new Error(`El árbol viola la condición de no arbitraje: pQ = ${p.toFixed(4)} fuera de (0, 1) incluso con ${n} pasos (r = ${r}, δ = ${delta}, σ = ${sigma}, T = ${T}).`);
    n *= 2;
  }
}

function lattice({ V0, K, T, r, delta, sigma, type, steps: steps0 = 80 }) {
  const { steps, sq, p, disc } = crrParams({ T, r, delta, sigma, steps: steps0 });
  const payoff = (v) => (type === "call" ? Math.max(v - K, 0) : Math.max(K - v, 0));
  const vals = new Float64Array(steps + 1);
  for (let j = 0; j <= steps; j++) vals[j] = payoff(V0 * Math.exp((2 * j - steps) * sq));
  let rootCont = 0, rootEx = payoff(V0);
  for (let i = steps - 1; i >= 0; i--) {
    for (let j = 0; j <= i; j++) {
      const cont = disc * (p * vals[j + 1] + (1 - p) * vals[j]);
      const ex = payoff(V0 * Math.exp((2 * j - i) * sq));
      if (i === 0) rootCont = cont;
      vals[j] = Math.max(cont, ex);
    }
  }
  return { value: vals[0], rootCont, rootEx };
}

// menor cociente V/K con el que conviene invertir YA (frontera de ejercicio en t = 0)
function entryTrigger(params) {
  const ok = (x) => { const l = lattice({ ...params, V0: x * params.K, type: "call" }); return l.rootEx >= l.rootCont - 1e-10 && l.rootEx > 0; };
  let lo = 1, hi = 2.5;
  if (!ok(hi)) return hi;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid; }
  return hi;
}

// eView: rendimiento esperado (aritmético) al horizonte; rho: rendimiento exigido anual (CAPM)
export function analyzeRealOptions({ S0, sigma, rBar, eView, rho, horizonDays = 63, tcost = 0.003, divYield = 0 }) {
  const T = horizonDays / 252;
  const rhoH = rho * T;
  const k = (1 + eView) / (1 + rhoH);
  const V0 = S0 * k;
  const I = S0 * (1 + tcost);
  const npv = V0 - I;
  // costo de esperar δ: rendimiento esperado en exceso (sobre la tasa libre) que se deja de ganar por no invertir
  const excessAnnual = Math.pow(1 + eView, 1 / T) - 1 - Math.max(rBar, 0);
  const delta = clamp(excessAnnual + divYield, 0.01, 0.6);
  const base = { K: I, T, r: Math.max(rBar, 0), delta, sigma: Math.max(sigma, 0.05) };

  const callV = lattice({ ...base, V0, type: "call" });
  const mTree = entryTrigger(base); // umbral del árbol para una inversión irreversible
  // Una acción se puede revender: la irreversibilidad es parcial, así que el margen exigido se limita
  // a la volatilidad del horizonte (reversibilidad parcial, Dixit y Pindyck).
  const mCap = 1 + clamp(0.6 * Math.max(sigma, 0.05) * Math.sqrt(T), 0.03, 0.15);
  const mStar = Math.min(mTree, mCap);
  const priceBuy = V0 / mStar / (1 + tcost); // compra si el precio es ≤ a este valor

  const L = clamp(1.5 * sigma * Math.sqrt(T), 0.06, 0.30);
  const stop = I * (1 - L);
  const putV = lattice({ ...base, V0: S0 * 1, K: stop, delta: 0, type: "put" });

  const waitValue = Math.max(0, callV.value - Math.max(npv, 0));
  const ratio = S0 / priceBuy;

  let action, signal;
  if (S0 <= priceBuy) { action = "Invertir ya"; signal = clamp(0.4 + 3 * Math.log(priceBuy / S0), 0.4, 1); }
  else if (ratio <= 1.04) { action = "Entrar por etapas"; signal = clamp(-1.5 * Math.log(ratio), -0.35, 0) + 0.15; }
  else { action = "Esperar un mejor precio"; signal = -clamp(1.5 * Math.log(ratio), 0, 0.35); }

  const confidence = clamp(0.4 + 0.3 * Math.min(1, Math.abs(Math.log(k)) / 0.08), 0.3, 0.7);
  return {
    available: true, S0, V0, I, k, npv, npvPct: npv / S0, delta, sigma, rBar, T, mStar, mTree, mCap,
    priceBuy, stop, stopPct: L, callValue: callV.value, callPct: callV.value / S0,
    putValue: putV.value, putPct: putV.value / S0, waitValue, waitPct: waitValue / S0, action,
    signal, confidence,
    headline: `${action}. Precio máximo de compra: ${fp(priceBuy)}. Piso de protección: ${fp(stop)}.`,
    detail: `El valor esperado del proyecto es ${fp(V0)} frente a un costo de ${fp(I)} (VPN ${nf((npv / S0 * 100), 1)} %). ` +
      `Esperar vale ${nf((callV.value / S0 * 100), 1)} % del precio, así que solo se invierte ya si el precio está en o bajo ${fp(priceBuy)} (V/I ≥ ${nf(mStar, 2)}). ` +
      `Asegurar un piso de ${nf((L * 100), 0)} % costaría ${nf((putV.value / S0 * 100), 1)} % del precio.`,
  };
}
