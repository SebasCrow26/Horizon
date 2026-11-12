// Modelos complementarios (no cambian el veredicto; se muestran y opinan como los demás):
//   • GBM — movimiento browniano geométrico: la base sin saltos (rendimientos normales)
//   • Black–Scholes — valoración de opciones sobre el GBM: cuánto cuesta apostar o asegurarse
//   • Kou (2002) — saltos con difusión, con saltos doble-exponenciales (subidas y caídas con tamaños distintos)
//   • Fractales / browniano fraccional — exponente de Hurst (DFA y R/S), dimensión fractal y rango con memoria
import { TRADING_DAYS, clamp, mean, std, median, quantile, normCdf, rng, randn, poissonSample, logReturns, ols, nf, fmtPriceNum as fp } from "../util.js";

const Z90 = 1.2815515655; // cuantil 90 % de la normal
const pctTxt = (x, d = 1) => `${x >= 0 ? "+" : "−"}${nf(Math.abs(x * 100), d)} %`;

// deriva diaria (log) usada por todos los modelos: 30 % histórica + 70 % la exigida por CAPM (igual que Merton)
function driftDaily(r, rho, varD) {
  return clamp(0.3 * mean(r) + 0.7 * (rho / TRADING_DAYS - 0.5 * varD), -0.003, 0.003);
}
const sigFrom = (er, rhoH, sdH) => Math.tanh(1.6 * ((er - rhoH) / (sdH || 1)));

// ---------------- GBM ----------------
export function analyzeGBM(prices, { horizonDays: H = 63, rho = 0.09 } = {}) {
  const r = logReturns(prices).slice(-756);
  const S0 = prices[prices.length - 1];
  const sd = std(r), m = driftDaily(r, rho, sd * sd);
  const sH = sd * Math.sqrt(H), mH = m * H;
  const probUp = normCdf(mH / sH);
  const er = Math.exp(mH + 0.5 * sH * sH) - 1;
  const lo = S0 * Math.exp(mH - Z90 * sH), hi = S0 * Math.exp(mH + Z90 * sH);
  const probDown10 = normCdf((Math.log(0.9) - mH) / sH);
  // pérdida media en el peor 5 % (forma cerrada de la lognormal)
  const z5 = -1.6448536, es5 = Math.exp(mH + 0.5 * sH * sH) * normCdf(z5 - sH) / 0.05 - 1;
  // ¿los rendimientos son normales? (Jarque–Bera)
  const mu = mean(r), n = r.length;
  let m2 = 0, m3 = 0, m4 = 0;
  for (const x of r) { const d = x - mu; m2 += d * d; m3 += d * d * d; m4 += d * d * d * d; }
  m2 /= n; m3 /= n; m4 /= n;
  const skew = m3 / Math.pow(m2, 1.5), kurt = m4 / (m2 * m2);
  const jb = (n / 6) * (skew * skew + ((kurt - 3) ** 2) / 4);
  const normal = jb < 5.99; // 5 % con 2 grados de libertad
  const signal = sigFrom(er, (rho * H) / TRADING_DAYS, sH);
  return {
    available: true, S0, H, mu: m * TRADING_DAYS + 0.5 * sd * sd * TRADING_DAYS, sigma: sd * Math.sqrt(TRADING_DAYS),
    probUp, expReturn: er, lo, hi, probDown10, es5, skew, kurt, jb, normal,
    signal, confidence: normal ? 0.5 : 0.3,
    headline: `Sin saltos, el rango probable a ${H} días es ${fp(lo)} – ${fp(hi)} y sube ${nf(probUp * 100, 0)} de cada 100 veces.`,
    detail: `El GBM supone que los cambios diarios siguen una campana normal. ${normal ? "Aquí esa suposición es razonable." : `Aquí no se cumple: la curtosis es ${nf(kurt, 1)} (una normal tiene 3), es decir, hay más días extremos de los que el GBM espera. Por eso puede quedarse corto en las caídas más bruscas: compáralo con Merton y Kou, que agregan saltos.`}`,
  };
}

// ---------------- Black–Scholes ----------------
function bs(S, K, T, r, s, put = false) {
  if (T <= 0 || s <= 0) return Math.max(0, put ? K - S : S - K);
  const d1 = (Math.log(S / K) + (r + 0.5 * s * s) * T) / (s * Math.sqrt(T)), d2 = d1 - s * Math.sqrt(T);
  return put ? K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1) : S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
}
export function analyzeBlackScholes(prices, { horizonDays: H = 63, rf = 0.04 } = {}) {
  const r = logReturns(prices).slice(-252);
  const S0 = prices[prices.length - 1], sigma = std(r) * Math.sqrt(TRADING_DAYS), T = H / TRADING_DAYS;
  const call = bs(S0, S0, T, rf, sigma), put = bs(S0, S0, T, rf, sigma, true);
  const put90 = bs(S0, S0 * 0.9, T, rf, sigma, true), call110 = bs(S0, S0 * 1.1, T, rf, sigma);
  const d1 = (Math.log(1) + (rf + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T)), d2 = d1 - sigma * Math.sqrt(T);
  const move = sigma * Math.sqrt(T); // movimiento "normal" esperado (1 desviación) en el horizonte
  return {
    available: true, S0, H, sigma, T, rf, call, put, put90, call110, delta: normCdf(d1), probITM: normCdf(d2), move,
    signal: 0, confidence: 0.5, // es un modelo de valoración: no opina sobre la dirección
    headline: `Asegurarse contra caídas de más de 10 % durante ${H} días costaría ${nf((put90 / S0) * 100, 1)} % del precio.`,
    detail: `Con una volatilidad anual de ${nf(sigma * 100, 0)} %, el mercado de opciones "esperaría" un movimiento típico de ±${nf(move * 100, 0)} % en ${H} días. Una opción de compra al precio de hoy valdría ${fp(call)} (${nf((call / S0) * 100, 1)} % del precio) y una de venta ${fp(put)}. Black–Scholes no opina si sube o baja: pone precio al riesgo.`,
  };
}

// ---------------- Kou: saltos doble-exponenciales ----------------
export function analyzeKou(prices, { horizonDays: H = 63, rho = 0.09, nSim = 20000 } = {}) {
  const r = logReturns(prices).slice(-756);
  const S0 = prices[prices.length - 1], n = r.length;
  const med = median(r);
  const sc = 1.4826 * median(r.map((x) => Math.abs(x - med))); // volatilidad robusta (no la inflan los saltos)
  const thr = 3 * sc;
  const ups = [], downs = [], normal = [];
  for (const x of r) { const d = x - med; if (d > thr) ups.push(d); else if (d < -thr) downs.push(-d); else normal.push(x); }
  const nJ = ups.length + downs.length;
  const lam = nJ / n; // saltos por día
  const p = nJ ? ups.length / nJ : 0.5;
  const mUp = ups.length ? mean(ups) : thr * 1.3, mDown = downs.length ? mean(downs) : thr * 1.3;
  const eta1 = 1 / mUp, eta2 = 1 / mDown; // tamaño medio = 1/η
  const sigma = std(normal);
  const EJ = p / eta1 - (1 - p) / eta2;
  const varD = sigma * sigma + lam * (p * 2 / (eta1 * eta1) + (1 - p) * 2 / (eta2 * eta2));
  const target = driftDaily(r, rho, varD), mD = target - lam * EJ;
  const g = rng(31), sim = new Float64Array(nSim);
  for (let i = 0; i < nSim; i++) {
    let x = mD * H + sigma * Math.sqrt(H) * randn(g);
    const k = poissonSample(g, lam * H);
    for (let j = 0; j < k; j++) { const u = Math.max(1e-12, g()); x += g() < p ? -Math.log(u) / eta1 : Math.log(u) / eta2; }
    sim[i] = x;
  }
  const sorted = Float64Array.from(sim).sort();
  let up = 0, down10 = 0, er = 0;
  const rets = new Float64Array(nSim);
  for (let i = 0; i < nSim; i++) { const v = Math.exp(sim[i]) - 1; rets[i] = v; er += v; if (sim[i] > 0) up++; if (v < -0.1) down10++; }
  er /= nSim;
  const sr = Float64Array.from(rets).sort(), k5 = Math.floor(nSim * 0.05);
  let es5 = 0; for (let i = 0; i < k5; i++) es5 += sr[i]; es5 /= k5;
  const sdH = std(Array.from(sim));
  const totalVolYear = Math.sqrt(varD * TRADING_DAYS);
  // histograma (mismo formato que Merton, para reutilizar el gráfico de colas)
  const bins = 41, lo = -0.5, hi = 0.5, hist = new Array(bins).fill(0);
  for (let i = 0; i < nSim; i++) hist[Math.floor(((clamp(rets[i], lo, hi - 1e-9) - lo) / (hi - lo)) * bins)]++;
  const asym = mDown / mUp, freqAsym = ups.length ? downs.length / ups.length : null;
  const enough = nJ >= 6;
  return {
    available: true, S0, H, lam, lamYear: lam * TRADING_DAYS, p, eta1, eta2, upSize: Math.expm1(mUp), downSize: -Math.expm1(-mDown), nUp: ups.length, nDown: downs.length, sigma: sigma * Math.sqrt(TRADING_DAYS),
    probUp: up / nSim, expReturn: er, es5, probDown10: down10 / nSim, q: { p10: S0 * Math.exp(quantile(sorted, 0.1)), p50: S0 * Math.exp(quantile(sorted, 0.5)), p90: S0 * Math.exp(quantile(sorted, 0.9)) },
    hist: { bins: hist, lo, hi }, targetDaily: target, totalVolYear, asym, freqAsym,
    signal: sigFrom(er, (rho * H) / TRADING_DAYS, sdH) * (1 - clamp((-es5 - 0.25) / 0.25, 0, 0.4)), confidence: enough ? 0.55 : 0.3,
    headline: enough
      ? `Caídas bruscas: ${downs.length} en 3 años, de ${pctTxt(Math.expm1(-mDown))} en promedio. Subidas bruscas: ${ups.length}, de ${pctTxt(Math.expm1(mUp))}.`
      : "Hay muy pocos saltos en los datos para separar subidas y caídas bruscas.",
    detail: `En 3 años hubo ${ups.length} saltos hacia arriba y ${downs.length} hacia abajo (unos ${nf(lam * TRADING_DAYS, 1)} por año). A diferencia de Merton, Kou deja que las caídas y las subidas tengan tamaños distintos. Con eso, la probabilidad de caer más de 10 % en ${H} días es ${nf((down10 / nSim) * 100, 1)} % y la pérdida media en el peor 5 % de los casos sería ${nf(-es5 * 100, 1)} %.`,
  };
}

// ---------------- Fractales y browniano fraccional ----------------
function dfa(r, scales) {
  const mu = mean(r);
  const y = []; let acc = 0; for (const x of r) { acc += x - mu; y.push(acc); }
  const pts = [];
  for (const s of scales) {
    const nSeg = Math.floor(y.length / s); if (nSeg < 4) continue;
    let tot = 0;
    for (let k = 0; k < nSeg; k++) {
      const seg = y.slice(k * s, (k + 1) * s);
      const xs = seg.map((_, i) => i), xm = (s - 1) / 2, ym = mean(seg);
      let sxy = 0, sxx = 0; for (let i = 0; i < s; i++) { sxy += (xs[i] - xm) * (seg[i] - ym); sxx += (xs[i] - xm) ** 2; }
      const b = sxy / sxx, a = ym - b * xm;
      for (let i = 0; i < s; i++) tot += (seg[i] - (a + b * i)) ** 2;
    }
    pts.push({ s, F: Math.sqrt(tot / (nSeg * s)) });
  }
  return pts;
}
function rescaledRange(r, scales) {
  const pts = [];
  for (const s of scales) {
    const nSeg = Math.floor(r.length / s); if (nSeg < 2) continue;
    let sum = 0, cnt = 0;
    for (let k = 0; k < nSeg; k++) {
      const seg = r.slice(k * s, (k + 1) * s), m = mean(seg);
      let acc = 0, mx = -Infinity, mn = Infinity; for (const x of seg) { acc += x - m; mx = Math.max(mx, acc); mn = Math.min(mn, acc); }
      const sd = std(seg, 0); if (sd > 0) { sum += (mx - mn) / sd; cnt++; }
    }
    if (cnt) pts.push({ s, RS: sum / cnt });
  }
  return pts;
}
const slope = (pts, key) => { const f = ols(pts.map((p) => [Math.log(p.s)]), pts.map((p) => Math.log(p[key]))); return { b: f.beta[1], a: f.beta[0], r2: f.r2 }; };

export function analyzeFractal(prices, { horizonDays: H = 63, rho = 0.09 } = {}) {
  const r = logReturns(prices).slice(-756);
  const S0 = prices[prices.length - 1];
  const scales = [8, 12, 16, 24, 32, 48, 64, 96, 128, 180];
  const fd = dfa(r, scales), rs = rescaledRange(r, scales);
  if (fd.length < 4) return { available: false, signal: 0, confidence: 0, headline: "No hay datos suficientes para medir la memoria del precio.", detail: "" };
  const d = slope(fd, "F"), q = slope(rs, "RS");
  const Hh = clamp(d.b, 0.2, 0.9); // exponente de Hurst (DFA, más robusto)
  const D = 2 - Hh; // dimensión fractal del gráfico de precios
  const sd = std(r), m = driftDaily(r, rho, sd * sd);
  // browniano fraccional: la dispersión crece como τ^H en vez de τ^0,5
  const sH = sd * Math.pow(H, Hh), sGBM = sd * Math.sqrt(H);
  const lo = S0 * Math.exp(m * H - Z90 * sH), hi = S0 * Math.exp(m * H + Z90 * sH);
  // señal: con memoria (H > 0,55) se sigue la dirección de los últimos 6 meses; con anti-memoria (H < 0,45) se espera rebote
  const n = prices.length, ret6 = Math.log(prices[n - 1] / prices[Math.max(0, n - 127)]);
  let signal = 0;
  if (Hh > 0.55) signal = Math.tanh((Hh - 0.5) * 8) * Math.sign(ret6);
  else if (Hh < 0.45) signal = -Math.tanh((0.5 - Hh) * 8) * Math.sign(ret6);
  const kind = Hh > 0.55 ? "persistente" : Hh < 0.45 ? "antipersistente" : "aleatorio";
  return {
    available: true, S0, H, hurst: Hh, hurstRS: q.b, r2: d.r2, D, kind, lo, hi, widen: sH / sGBM - 1, dfa: fd, rs, fit: d, ret6,
    signal: clamp(signal, -1, 1), confidence: clamp(0.25 + 0.4 * d.r2, 0.2, 0.6),
    headline: kind === "persistente" ? `Hurst = ${nf(Hh, 2)}: el precio tiene memoria; las tendencias tienden a continuar.`
      : kind === "antipersistente" ? `Hurst = ${nf(Hh, 2)}: el precio tiende a devolverse; las subidas suelen corregirse.`
      : `Hurst = ${nf(Hh, 2)}: el precio se comporta casi como una caminata aleatoria, sin memoria clara.`,
    detail: `El exponente de Hurst mide la memoria del precio: 0,5 es azar puro (lo que supone el GBM), más de 0,5 indica tendencias que persisten y menos de 0,5, que tiende a devolverse. La dimensión fractal del gráfico es ${nf(D, 2)} (más cerca de 1 = más suave; de 2 = más irregular). Con un browniano fraccional, el rango a ${H} días sería ${fp(lo)} – ${fp(hi)}, ${Math.abs(sH / sGBM - 1) < 0.02 ? "casi igual al del GBM" : `${nf(Math.abs(sH / sGBM - 1) * 100, 0)} % ${sH > sGBM ? "más ancho" : "más angosto"} que el del GBM`}.`,
  };
}
