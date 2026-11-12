// Comportamiento en manada (herding) — método CSAD de Chang, Cheng y Khorana (2000).
//   CSAD_t = media_i | R_i,t − R_m,t |        (dispersión de los rendimientos alrededor del mercado)
//   CSAD_t = α + γ1 |R_m,t| + γ2 R_m,t² + ε
// Sin manada, la dispersión crece con los movimientos del mercado (γ2 ≥ 0). Si γ2 < 0 y es significativo,
// en días de movimientos extremos los inversionistas se imitan y la dispersión se comprime.
import { ols, invert, clamp, mean, std, dayKey, TRADING_DAYS, sum, nf } from "../util.js";

// series: [{sym, t:[seg], c:[...]}] del universo de la región
export function buildCrossSection(series, minShare = 0.6, minStocks = 6) {
  const maps = series.map((s) => {
    const m = new Map();
    for (let i = 0; i < s.t.length; i++) m.set(dayKey(s.t[i]), s.c[i]);
    return m;
  });
  const count = new Map();
  for (const m of maps) for (const d of m.keys()) count.set(d, (count.get(d) || 0) + 1);
  const days = [...count.entries()].filter(([, c]) => c >= minShare * series.length).map(([d]) => d).sort((a, b) => a - b);
  const out = [];
  for (let k = 1; k < days.length; k++) {
    const rets = [];
    for (const m of maps) {
      const a = m.get(days[k - 1]), b = m.get(days[k]);
      if (a && b) rets.push(Math.log(b / a));
    }
    if (rets.length < minStocks) continue;
    const rm = mean(rets);
    const csad = mean(rets.map((r) => Math.abs(r - rm)));
    out.push({ day: days[k], rm, csad, n: rets.length });
  }
  return out;
}

// OLS con errores estándar robustos (HC1)
function olsHC(X, y) {
  const base = ols(X, y);
  const rows = X.map((r) => [1, ...r]);
  const k = rows[0].length, n = y.length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const r of rows) for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) XtX[a][b] += r[a] * r[b];
  const inv = invert(XtX);
  const meat = Array.from({ length: k }, () => new Array(k).fill(0));
  rows.forEach((r, i) => {
    const e2 = base.resid[i] ** 2;
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) meat[a][b] += e2 * r[a] * r[b];
  });
  const V = inv.map((row) => meat[0].map((_, j) => sum(row.map((v, m) => v * meat[m][j]))));
  const V2 = V.map((row) => meat[0].map((_, j) => sum(row.map((v, m) => v * inv[m][j]))));
  const adj = n / Math.max(1, n - k);
  const se = V2.map((row, a) => Math.sqrt(Math.max(0, row[a] * adj)));
  const t = base.beta.map((b, a) => (se[a] > 0 ? b / se[a] : 0));
  return { ...base, se, t };
}

function herdTest(cs) {
  if (cs.length < 40) return null;
  const X = cs.map((d) => [Math.abs(d.rm), d.rm * d.rm]);
  const y = cs.map((d) => d.csad);
  const f = olsHC(X, y);
  return { alpha: f.beta[0], g1: f.beta[1], g2: f.beta[2], t2: f.t[2], t1: f.t[1], r2: f.r2, n: cs.length, herding: f.beta[2] < 0 && f.t[2] < -1.645 };
}

// stock: {t,c} (opcional) para medir cuánto se está pegando al mercado
export function analyzeHerding(universeSeries, stock, { region = "US" } = {}) {
  if (!universeSeries || universeSeries.length < 6) {
    return { available: false, signal: 0, confidence: 0.1, headline: "No hay suficientes acciones de la región para medir manada.", detail: "" };
  }
  const cs = buildCrossSection(universeSeries);
  if (cs.length < 60) return { available: false, signal: 0, confidence: 0.1, headline: "Muy pocos días en común para medir manada.", detail: "" };

  const full = herdTest(cs.slice(-504));
  const recent = herdTest(cs.slice(-120)) || full;
  const mkt20 = cs.slice(-20).reduce((s, d) => s + d.rm, 0);
  const mkt60 = cs.slice(-60).reduce((s, d) => s + d.rm, 0);

  // Acción vs mercado: correlación reciente vs histórica
  let corr60 = null, corrAll = null, betaMkt = null;
  if (stock) {
    const mm = new Map(cs.map((d) => [d.day, d.rm]));
    const sd = new Map(); for (let i = 1; i < stock.t.length; i++) sd.set(dayKey(stock.t[i]), Math.log(stock.c[i] / stock.c[i - 1]));
    const a = [], b = [];
    for (const d of cs) if (sd.has(d.day)) { a.push(sd.get(d.day)); b.push(mm.get(d.day)); }
    const corr = (x, y) => { const mx = mean(x), my = mean(y); let n = 0, dx = 0, dy = 0; for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; } return n / Math.sqrt(dx * dy || 1); };
    if (a.length > 80) {
      corrAll = corr(a.slice(-504), b.slice(-504)); corr60 = corr(a.slice(-60), b.slice(-60));
      const aa = a.slice(-504), bb = b.slice(-504), mb = mean(bb), ma = mean(aa);
      let cv = 0, vr = 0; for (let i = 0; i < aa.length; i++) { cv += (aa[i] - ma) * (bb[i] - mb); vr += (bb[i] - mb) ** 2; }
      betaMkt = vr > 0 ? cv / vr : null; // beta de la acción frente al promedio de su región
    }
  }

  const t2 = recent.t2;
  // evidencia: reciente (120 días) o, si no, histórica (2 años) con menor peso
  const evid = recent.herding ? { t: t2, w: 1, src: "reciente" } : full && full.herding ? { t: full.t2, w: 0.6, src: "histórica" } : null;
  const intensity = evid ? clamp(Math.abs(evid.t) / 3, 0.3, 1) * evid.w : 0;
  let state = "sin evidencia de manada", signal = 0;
  if (evid) {
    const tag = evid.src === "histórica" ? " (patrón histórico)" : "";
    if (mkt20 > 0.04) { state = "manada alcista, riesgo de burbuja" + tag; signal = -0.6 * intensity; }
    else if (mkt20 < -0.04) { state = "manada bajista, pánico contagioso" + tag; signal = 0.5 * intensity; }
    else { state = "régimen de manada en mercado lateral" + tag; signal = -0.1 * intensity; }
  }
  const confidence = evid ? clamp(0.3 + 0.5 * Math.min(1, Math.abs(evid.t) / 3) * evid.w, 0.3, 0.8) : 0.35;

  const pts = cs.slice(-250).map((d) => ({ x: Math.abs(d.rm), y: d.csad }));
  return {
    available: true, region, nStocks: universeSeries.length, nDays: cs.length,
    full, recent, mkt20, mkt60, corr60, corrAll, betaMkt, state, pts, intensity, asOf: cs[cs.length - 1].day * 86400,
    signal, confidence,
    headline: `Mercado ${region}: ${state}.`,
    detail: `Se midió con ${universeSeries.length} acciones de la región. En 2 años γ₂ = ${nf(full.g2, 2)} (t = ${nf(full.t2, 2)}) y en los últimos 120 días γ₂ = ${nf(recent.g2, 2)} (t = ${nf(t2, 2)}). ${evid ? "La dispersión se comprime cuando el mercado se mueve mucho: los inversionistas se están imitando." : "No hay compresión significativa de la dispersión: no se detecta manada."}` +
      (corr60 != null ? ` La correlación de esta acción con su mercado es ${nf(corr60, 2)} en 60 días (${nf(corrAll, 2)} histórica).` : ""),
  };
}
