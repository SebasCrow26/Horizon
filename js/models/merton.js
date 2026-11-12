// Modelo de saltos de Merton (1976): difusión browniana + saltos de Poisson con tamaño lognormal.
//   dS/S = (μ − λk) dt + σ dW + (J − 1) dN ,  ln J ~ N(μJ, δ²),  k = e^{μJ + δ²/2} − 1
// Estimación por máxima verosimilitud sobre los rendimientos logarítmicos diarios (mezcla de normales
// ponderada por Poisson). La proyección se hace con Monte Carlo.
import {
  TRADING_DAYS, clamp, mean, std, median, quantile, normCdf, normPdf, poissonPmf,
  rng, randn, poissonSample, nelderMead, logReturns, nf, fmtPriceNum as fp } from "../util.js";

const NMAX = 5;

function nllMixture(theta, r) {
  const [m, u, v, muJ, w] = theta;
  const sigma = clamp(Math.exp(u), 1e-4, 0.2);
  const lam = clamp(Math.exp(v), 1e-4, 0.35);
  const delta = clamp(Math.exp(w), 1e-3, 0.5);
  const mJ = clamp(muJ, -0.5, 0.5);
  const wts = [];
  for (let n = 0; n <= NMAX; n++) wts.push(poissonPmf(n, lam));
  let ll = 0;
  for (let i = 0; i < r.length; i++) {
    let dens = 0;
    for (let n = 0; n <= NMAX; n++) {
      const s2 = sigma * sigma + n * delta * delta;
      const s = Math.sqrt(s2);
      const z = (r[i] - m - n * mJ) / s;
      dens += wts[n] * Math.exp(-0.5 * z * z) / (s * 2.5066282746);
    }
    ll += Math.log(dens + 1e-300);
  }
  // penalización suave para evitar soluciones degeneradas (parámetros fuera de rango)
  const pen = (Math.abs(u) > 12 ? 1e3 : 0) + (v > Math.log(0.35) ? 50 * (v - Math.log(0.35)) : 0);
  return -ll + pen;
}

function nllGauss(r) {
  const m = mean(r), s = std(r, 0);
  let ll = 0;
  for (const x of r) ll += Math.log(normPdf((x - m) / s) / s + 1e-300);
  return -ll;
}

export function fitMerton(r) {
  const med = median(r);
  const mad = median(r.map((x) => Math.abs(x - med))) * 1.4826;
  const s0 = Math.max(mad, 1e-4);
  const jumps = r.filter((x) => Math.abs(x - med) > 3.5 * s0);
  const lam0 = clamp(jumps.length / r.length, 0.003, 0.2);
  const muJ0 = jumps.length >= 3 ? mean(jumps.map((x) => x - med)) : -0.01;
  const del0 = jumps.length >= 3 ? Math.max(std(jumps.map((x) => x - med)), 3 * s0) : 3 * s0;

  const starts = [
    [med, Math.log(s0), Math.log(lam0), muJ0, Math.log(del0)],
    [med, Math.log(s0 * 1.1), Math.log(0.01), -0.02, Math.log(0.04)],
    [mean(r), Math.log(std(r) * 0.7), Math.log(0.02), 0, Math.log(std(r) * 2)],
  ];
  let best = null;
  for (const s of starts) {
    const res = nelderMead((th) => nllMixture(th, r), s, { maxIter: 700, step: 0.2 });
    if (!best || res.fx < best.fx) best = res;
  }
  const [m, u, v, muJ, w] = best.x;
  const sigma = clamp(Math.exp(u), 1e-4, 0.2), lam = clamp(Math.exp(v), 1e-4, 0.35);
  const delta = clamp(Math.exp(w), 1e-3, 0.5), mJ = clamp(muJ, -0.5, 0.5);
  const nll = best.fx, nllG = nllGauss(r);
  const LR = Math.max(0, 2 * (nllG - nll)); // contraste vs. modelo sin saltos (χ² con 3 g.l.; crítico 5 % = 7,81)
  const k = Math.exp(mJ + 0.5 * delta * delta) - 1;
  return { m, sigma, lam, muJ: mJ, delta, k, LR, jumpsSignificant: LR > 7.81, n: r.length, nll };
}

// ----- Black–Scholes y Merton para opciones europeas (comparación y valoración) -----
export function bsCall(S, K, T, r, sig) {
  if (T <= 0 || sig <= 0) return Math.max(0, S - K);
  const d1 = (Math.log(S / K) + (r + 0.5 * sig * sig) * T) / (sig * Math.sqrt(T));
  const d2 = d1 - sig * Math.sqrt(T);
  return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
}

// p: parámetros ANUALES {sigma, lam, muJ, delta}
export function mertonCall(S, K, T, r, p) {
  const k = Math.exp(p.muJ + 0.5 * p.delta ** 2) - 1;
  const lamP = p.lam * (1 + k);
  let price = 0;
  for (let n = 0; n <= 40; n++) {
    const sn = Math.sqrt(p.sigma ** 2 + (n * p.delta ** 2) / T);
    const rn = r - p.lam * k + (n * Math.log(1 + k)) / T;
    price += poissonPmf(n, lamP * T) * bsCall(S, K, T, rn, sn);
  }
  return price;
}

// ----- Simulación -----
// d: parámetros diarios; H días; devuelve rendimientos logarítmicos al horizonte
export function simulateTerminal(d, mDrift, H, nSim = 20000, seed = 7) {
  const rnd = rng(seed);
  const out = new Float64Array(nSim);
  const lamH = d.lam * H;
  const sdH = d.sigma * Math.sqrt(H);
  for (let i = 0; i < nSim; i++) {
    let R = mDrift * H + sdH * randn(rnd);
    const N = poissonSample(rnd, lamH);
    for (let j = 0; j < N; j++) R += d.muJ + d.delta * randn(rnd);
    out[i] = R;
  }
  return out;
}

// trayectorias para el abanico: cuantiles del precio en varios instantes
export function simulateFan(d, mDrift, S0, H, nPaths = 2500, seed = 11, points = 12) {
  const rnd = rng(seed);
  const steps = [];
  for (let i = 1; i <= points; i++) steps.push(Math.round((H * i) / points));
  const store = steps.map(() => new Float64Array(nPaths));
  for (let p = 0; p < nPaths; p++) {
    let R = 0, si = 0;
    for (let day = 1; day <= H; day++) {
      R += mDrift + d.sigma * randn(rnd);
      if (rnd() < d.lam) {
        const N = poissonSample(rnd, d.lam) || 1;
        for (let j = 0; j < N; j++) R += d.muJ + d.delta * randn(rnd);
      }
      if (day === steps[si]) { store[si][p] = R; si++; }
    }
  }
  const fan = [{ day: 0, p10: S0, p25: S0, p50: S0, p75: S0, p90: S0 }];
  steps.forEach((day, i) => {
    const s = Float64Array.from(store[i]).sort();
    fan.push({ day, p10: S0 * Math.exp(quantile(s, 0.1)), p25: S0 * Math.exp(quantile(s, 0.25)), p50: S0 * Math.exp(quantile(s, 0.5)), p75: S0 * Math.exp(quantile(s, 0.75)), p90: S0 * Math.exp(quantile(s, 0.9)) });
  });
  return fan;
}

// opts: { rf (anual, decimal), horizonDays, erp, shrink }
export function analyzeMerton(prices, opts = {}) {
  const H = opts.horizonDays || 63;
  const rf = opts.rf ?? 0.04;
  const erp = opts.erp ?? 0.05;
  const rho = opts.rho ?? rf + erp; // rendimiento exigido (CAPM) de esta acción
  const w = opts.shrink ?? 0.3; // peso de la media histórica (el resto va al prior CAPM)

  const r = logReturns(prices);
  const S0 = prices[prices.length - 1];
  const fit = fitMerton(r);

  const totVarD = fit.sigma ** 2 + fit.lam * (fit.muJ ** 2 + fit.delta ** 2);
  const priorDaily = rho / TRADING_DAYS - 0.5 * totVarD;
  const histMean = mean(r);
  const targetDaily = clamp(w * histMean + (1 - w) * priorDaily, -0.003, 0.003);
  const mDrift = targetDaily - fit.lam * fit.muJ; // deriva de la parte difusiva

  const sim = simulateTerminal(fit, mDrift, H);
  const sorted = Float64Array.from(sim).sort();
  const q = (p) => S0 * Math.exp(quantile(sorted, p));
  const n = sim.length;
  let up = 0, down10 = 0, er = 0;
  const rets = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const g = Math.exp(sim[i]) - 1;
    rets[i] = g; er += g;
    if (sim[i] > 0) up++;
    if (g < -0.1) down10++;
  }
  er /= n;
  const sortedRet = Float64Array.from(rets).sort();
  const k5 = Math.floor(n * 0.05);
  let es5 = 0; for (let i = 0; i < k5; i++) es5 += sortedRet[i]; es5 /= k5;
  const var5 = quantile(sortedRet, 0.05);

  const totalVolYear = Math.sqrt(totVarD * TRADING_DAYS);
  const sdH = std(Array.from(sim));
  // referencia sin saltos: misma volatilidad total, normal
  const gaussDown10 = normCdf((Math.log(0.9) - (targetDaily * H)) / (totalVolYear * Math.sqrt(H / TRADING_DAYS)));
  const rg = rng(99), gs = new Float64Array(n);
  for (let i = 0; i < n; i++) gs[i] = Math.exp(targetDaily * H + totalVolYear * Math.sqrt(H / TRADING_DAYS) * randn(rg)) - 1;
  gs.sort();
  let gaussEs5 = 0; for (let i = 0; i < k5; i++) gaussEs5 += gs[i]; gaussEs5 /= k5; // pérdida media en el peor 5 % sin saltos

  const rhoH = (rho * H) / TRADING_DAYS;
  const z = (er - rhoH) / (sdH || 1); // exceso sobre el rendimiento exigido (alfa), en desviaciones estándar
  let signal = Math.tanh(1.6 * z);
  const tailPenalty = clamp((-es5 - 0.25) / 0.25, 0, 0.4);
  signal *= 1 - tailPenalty;

  const confidence = clamp(0.35 + 0.35 * Math.min(1, fit.LR / 30) + 0.2 * Math.min(1, r.length / 700), 0.2, 0.9);

  const annual = { sigma: fit.sigma * Math.sqrt(TRADING_DAYS), lam: fit.lam * TRADING_DAYS, muJ: fit.muJ, delta: fit.delta, k: fit.k };
  const T = H / TRADING_DAYS;
  const callM = mertonCall(S0, S0, T, rf, annual);
  const callBS = bsCall(S0, S0, T, rf, totalVolYear);

  // histograma del rendimiento al horizonte (para el gráfico de colas)
  const bins = 41, lo = -0.5, hi = 0.5, hist = new Array(bins).fill(0);
  for (let i = 0; i < n; i++) {
    const b = Math.floor(((clamp(rets[i], lo, hi - 1e-9) - lo) / (hi - lo)) * bins);
    hist[b]++;
  }

  const jumpTxt = fit.jumpsSignificant
    ? `Se detectan saltos: unos ${nf(annual.lam, 1)} por año, con tamaño medio ${nf((fit.k * 100), 1)} %.`
    : `No hay saltos estadísticamente significativos: el comportamiento se parece a Black–Scholes.`;

  return {
    available: true,
    S0, H, rho, fit, annual, totalVolYear, targetDaily, mDrift, histMean,
    probUp: up / n, probDown10: down10 / n, gaussDown10, expReturn: er, es5, var5, gaussEs5,
    q: { p5: q(0.05), p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), p95: q(0.95) },
    fan: simulateFan(fit, mDrift, S0, H),
    hist: { bins: hist, lo, hi }, callM, callBS,
    signal, confidence, tailPenalty,
    headline: `Probabilidad de subir en ${H} días: ${nf((up / n * 100), 0)} %. Rango probable (p10–p90): ${fp(q(0.1))} – ${fp(q(0.9))}.`,
    detail: `${jumpTxt} En una caída fuerte (peor 5 % de los casos) se perdería en promedio ${nf((-es5 * 100), 1)} %. La probabilidad de caer más de 10 % es ${nf((down10 / n * 100), 1)} % con saltos, frente a ${nf((gaussDown10 * 100), 1)} % sin saltos.`,
  };
}
