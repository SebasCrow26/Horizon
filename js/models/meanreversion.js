// Reversión a la media (proceso de Ornstein–Uhlenbeck sobre el precio).
// Se separa la tendencia de largo plazo del log-precio y se modela la desviación u_t alrededor de ella:
//   du = −κ u dt + σ dW   (discreto: u_{t+1} = φ u_t + ε, φ = e^{−κ Δt})
// Vida media = ln2 / κ.  Prueba de Dickey–Fuller para saber si la reversión es estadísticamente real.
import { TRADING_DAYS, ols, clamp, std, mean, nf, fmtPriceNum as fp } from "../util.js";

export function analyzeMeanReversion(prices, { horizonDays = 63 } = {}) {
  const N = prices.length;
  const x = prices.map(Math.log);
  const idx = x.map((_, i) => [i / TRADING_DAYS]);

  // 1) tendencia: ln P = c + g·t
  const tr = ols(idx, x);
  const c0 = tr.beta[0], g = tr.beta[1];
  const u = x.map((v, i) => v - (c0 + g * (i / TRADING_DAYS)));

  // 2) AR(1) sobre la desviación
  const f = ols(u.slice(0, -1).map((v) => [v]), u.slice(1));
  const phi = clamp(f.beta[1], 0.0, 0.99999);
  const tDF = (f.beta[1] - 1) / f.se[1];
  const kappa = -Math.log(Math.max(phi, 1e-6)) * TRADING_DAYS; // por año
  const halfLife = phi > 0 && phi < 1 ? Math.LN2 / -Math.log(phi) : Infinity; // en días de mercado
  const sigU = std(u);
  const uNow = u[N - 1];
  const z = sigU > 0 ? uNow / sigU : 0;

  // 3) proyección al horizonte
  const H = horizonDays;
  const gProj = clamp(g, -0.2, 0.25);
  const eqNow = Math.exp(c0 + g * ((N - 1) / TRADING_DAYS));
  const lnEqH = c0 + g * ((N - 1) / TRADING_DAYS) + gProj * (H / TRADING_DAYS);
  const uH = uNow * Math.pow(phi, H);
  const varUH = (f.sigma ** 2) * (1 - Math.pow(phi, 2 * H)) / (1 - phi * phi || 1e-9);
  const target = Math.exp(lnEqH + uH);
  const S0 = prices[N - 1];
  const sdH = Math.sqrt(Math.max(varUH, 1e-8));
  const range = { p10: Math.exp(lnEqH + uH - 1.2816 * sdH), p90: Math.exp(lnEqH + uH + 1.2816 * sdH) };

  // 4) fiabilidad
  let rel = tDF < -3.4 ? 1 : tDF < -2.9 ? 0.65 : tDF < -2.4 ? 0.4 : 0.2;
  if (!(halfLife >= 5 && halfLife <= 180)) rel *= 0.6;
  const signal = Math.tanh(-z / 1.4) * rel;
  const confidence = clamp(0.2 + 0.7 * rel, 0.15, 0.9);

  const ma200 = mean(prices.slice(-200));
  const state = z > 1.5 ? "muy por encima de su nivel de equilibrio (cara)" : z > 0.5 ? "algo por encima de su equilibrio"
    : z < -1.5 ? "muy por debajo de su nivel de equilibrio (barata)" : z < -0.5 ? "algo por debajo de su equilibrio" : "cerca de su equilibrio";
  const reverts = tDF < -2.9;

  // serie de desviaciones para el gráfico (últimos 2 años)
  const keep = Math.min(N, 504);
  return {
    available: true, S0, N, trend: g, trendR2: tr.r2, phi, kappa, halfLife, tDF, reverts, z, sigU,
    eqNow, target, range, expReturn: target / S0 - 1, ma200, vsMa200: S0 / ma200 - 1,
    devSeries: u.slice(-keep), prices: prices.slice(-keep), eqSeries: x.slice(-keep).map((_, i) => Math.exp(c0 + g * ((N - keep + i) / TRADING_DAYS))),
    signal, confidence, reliability: rel,
    headline: `El precio está ${state}. Precio objetivo a ${H} días: ${fp(target)} (${nf((target / S0 - 1) * 100, 1)} %).`,
    detail: (reverts
      ? `La reversión es estadísticamente significativa (Dickey–Fuller t = ${nf(tDF, 2)}): las desviaciones se corrigen con una vida media de unos ${nf(halfLife, 0)} días.`
      : `La reversión NO es estadísticamente significativa (t = ${nf(tDF, 2)}): las desviaciones tardan en corregirse (vida media ≈ ${isFinite(halfLife) ? nf(halfLife, 0) : "∞"} días), por eso la señal pesa poco.`) +
      ` Tendencia de largo plazo: ${nf((g * 100), 1)} % anual.`,
  };
}
