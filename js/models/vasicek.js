// Modelo de Vasicek (1977): dr = a (b − r) dt + σ dW
// Se usa sobre las tasas de interés (bonos del Tesoro de EE. UU. que entrega Yahoo) para:
//   (1) proyectar hacia dónde van las tasas, (2) obtener la tasa libre de riesgo esperada que usan
//   los demás modelos, (3) medir cuánto le afectan a cada acción los cambios de tasa, (4) valorar bonos.
import { ols, TRADING_DAYS, clamp, std, alignByDay, logReturns, nf } from "../util.js";

const DT = 1 / TRADING_DAYS;

// r: tasas en decimal (0.043 = 4,3 %)
export function fitVasicek(r) {
  const x = r.slice(0, -1), y = r.slice(1);
  const f = ols(x.map((v) => [v]), y);
  const alpha = f.beta[0], phi = f.beta[1];
  const tDF = (phi - 1) / f.se[1]; // estadístico Dickey–Fuller (valor crítico 5 %: −2,86)
  const meanReverts = phi < 0.9999;
  const a = meanReverts ? Math.max(-Math.log(phi) / DT, 0.02) : 0.02;
  const b = phi < 0.9999 ? alpha / (1 - phi) : r.reduce((s, v) => s + v, 0) / r.length;
  const varE = f.sigma ** 2;
  const sigma = Math.sqrt(Math.max(1e-12, varE * (2 * a) / (1 - Math.exp(-2 * a * DT))));
  return { a, b, sigma, phi, tDF, significant: tDF < -2.86, halfLifeYears: Math.LN2 / a, n: r.length };
}

export const expectedRate = (p, r0, h) => p.b + (r0 - p.b) * Math.exp(-p.a * h);
export const rateVariance = (p, h) => (p.sigma ** 2) * (1 - Math.exp(-2 * p.a * h)) / (2 * p.a);
// tasa corta promedio esperada entre hoy y h años
export const avgExpectedRate = (p, r0, h) => p.b + (r0 - p.b) * (1 - Math.exp(-p.a * h)) / (p.a * h);

// Precio de un bono cero cupón P(0,τ) y su rendimiento (fórmulas cerradas de Vasicek)
export function bond(p, r0, tau) {
  const B = (1 - Math.exp(-p.a * tau)) / p.a;
  const A = Math.exp((p.b - (p.sigma ** 2) / (2 * p.a ** 2)) * (B - tau) - (p.sigma ** 2) * B * B / (4 * p.a));
  const price = A * Math.exp(-B * r0);
  return { tau, price, yield: -Math.log(price) / tau };
}

// Abanico de proyección: media y banda 90 % a lo largo de h años
export function ratePath(p, r0, h, steps = 24) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = (h * i) / steps;
    const m = expectedRate(p, r0, t);
    const sd = i === 0 ? 0 : Math.sqrt(rateVariance(p, t));
    out.push({ t, m, lo: m - 1.645 * sd, hi: m + 1.645 * sd });
  }
  return out;
}

const last = (a) => a[a.length - 1];

// rates: { irx, tnx, fvx, tyx } cada una {t:[seg], c:[%]} ; stock: {t, c}
export function analyzeVasicek(rates, stock, { horizonDays = 63 } = {}) {
  const h = horizonDays / TRADING_DAYS;
  const short = rates.irx || rates.tnx;
  const long = rates.tnx || rates.irx;
  if (!short || !long) return { available: false, signal: 0, confidence: 0, headline: "Sin datos de tasas" };

  const rs = short.c.map((v) => v / 100);
  const rl = long.c.map((v) => v / 100);
  const ps = fitVasicek(rs), pl = fitVasicek(rl);
  const r0s = last(rs), r0l = last(rl);

  const rfAvg = avgExpectedRate(ps, r0s, h); // tasa libre de riesgo esperada en el horizonte
  const longExp = expectedRate(pl, r0l, h);
  const dLongPP = (longExp - r0l) * 100; // cambio esperado de la tasa a 10 años, en puntos porcentuales

  // sensibilidad de la acción a cambios de la tasa a 10 años (rend. diario vs Δ tasa en pp)
  let beta = 0, tBeta = 0, nReg = 0;
  if (stock) {
    const al = alignByDay(stock, long);
    if (al.t.length > 120) {
      const rets = logReturns(al.a);
      const dy = [];
      for (let i = 1; i < al.b.length; i++) dy.push(al.b[i] - al.b[i - 1]); // ya en puntos porcentuales
      const f = ols(dy.map((v) => [v]), rets);
      beta = f.beta[1]; tBeta = f.t[1]; nReg = rets.length;
    }
  }
  const sdH = stock ? std(logReturns(stock.c.slice(-253))) * Math.sqrt(horizonDays) : 0.15;
  // efecto esperado en el precio por el cambio esperado de tasas (beta suavizada si no es significativa)
  const shrink = Math.min(1, Math.abs(tBeta) / 2);
  const impact = beta * shrink * dLongPP;
  const z = sdH > 0 ? impact / sdH : 0;
  const signal = Math.tanh(3 * z);

  const confidence = clamp(0.25 + 0.35 * Math.min(1, Math.abs(tBeta) / 3) + 0.25 * (pl.significant ? 1 : 0.3), 0.15, 0.85);

  const regime = r0l > pl.b + 0.003 ? "por encima de su promedio de largo plazo: se espera que bajen"
    : r0l < pl.b - 0.003 ? "por debajo de su promedio de largo plazo: se espera que suban"
    : "cerca de su promedio de largo plazo";

  const obs = { "3 meses": rates.irx, "5 años": rates.fvx, "10 años": rates.tnx, "30 años": rates.tyx };
  const curve = [0.25, 2, 5, 10, 30].map((tau) => ({ ...bond(ps, r0s, tau), label: tau < 1 ? "3 meses" : tau + " años" }));
  const observed = Object.entries(obs).filter(([, s]) => s).map(([label, s]) => ({ label, yield: last(s.c) / 100 }));

  return {
    available: true,
    short: { name: "Tasa corta (3 meses)", params: ps, r0: r0s, path: ratePath(ps, r0s, Math.max(h, 1)), series: short },
    long: { name: "Tasa a 10 años", params: pl, r0: r0l, path: ratePath(pl, r0l, Math.max(h, 1)), series: long },
    rfAvg, longExp, dLongPP, beta, tBeta, nReg, impact, sdH, curve, observed, regime,
    signal, confidence,
    headline: `Tasa a 10 años ${nf((r0l * 100), 2)} %, ${regime}.`,
    detail: `Vasicek proyecta la tasa a 10 años en ${nf((longExp * 100), 2)} % dentro de ${horizonDays} días (${dLongPP >= 0 ? "+" : ""}${nf(dLongPP, 2)} pp). ` +
      (stock ? `Cada punto de alza en la tasa ha movido a esta acción ${nf((beta * 100), 2)} % en promedio (t = ${nf(tBeta, 1)}), así que el efecto esperado de tasas es ${nf((impact * 100), 2)} %.` : ""),
  };
}
