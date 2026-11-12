// Gráficos en SVG puro (sin librerías). Todos devuelven una cadena de marcado.
// Los colores usan variables CSS (var(--blue), etc.) para adaptarse al tema claro/oscuro.
import { normPdf, fmtPriceNum, fmtAxisNum } from "./util.js";

const W = 640, H = 300;
const REG = new Map(); // metadatos para el cursor interactivo

export const fmtPrice = fmtPriceNum;
export const pct = (x, d = 1) => (x == null || !isFinite(x) ? "—" : (x >= 0 ? "+" : "") + (x * 100).toFixed(d).replace(".", ",") + " %");
export const pctPlain = (x, d = 0) => (x == null || !isFinite(x) ? "—" : (x * 100).toFixed(d).replace(".", ",") + " %");

function scaler(d0, d1, r0, r1) { const k = (r1 - r0) / ((d1 - d0) || 1); return (v) => r0 + (v - d0) * k; }
const f1 = (n) => (Math.round(n * 10) / 10).toString();
const line = (pts) => pts.map((p, i) => (i ? "L" : "M") + f1(p[0]) + " " + f1(p[1])).join(" ");

function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

function axes({ x0, x1, y0, y1, L, R, T, B, yFmt, xLabels = [] }) {
  const sx = scaler(x0, x1, L, W - R), sy = scaler(y0, y1, H - B, T);
  let g = "";
  for (const v of niceTicks(y0, y1, 4)) {
    const y = sy(v);
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${f1(y)}" y2="${f1(y)}"/><text class="ax" x="${L - 8}" y="${f1(y + 4)}" text-anchor="end">${yFmt(v)}</text>`;
  }
  for (const xl of xLabels) g += `<text class="ax" x="${f1(sx(xl.v))}" y="${H - 6}" text-anchor="${xl.anchor || "middle"}">${xl.t}</text>`;
  return { sx, sy, g };
}

const svg = (inner, label) => `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`;

// -------- sparkline --------
export function sparkline(values, { w = 120, h = 38, up = true } = {}) {
  const v = values.slice(-90);
  const lo = Math.min(...v), hi = Math.max(...v);
  const sx = scaler(0, v.length - 1, 2, w - 2), sy = scaler(lo, hi, h - 3, 3);
  const pts = v.map((x, i) => [sx(i), sy(x)]);
  const area = `${line(pts)} L${w - 2} ${h} L2 ${h} Z`;
  return `<svg class="spark ${up ? "up" : "down"}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path class="area" d="${area}"/><path class="ln" d="${line(pts)}"/></svg>`;
}

// -------- precio + abanico de Merton + objetivo / piso / compra --------
export function priceFanChart({ series, fan, target, stop, buy, S0 }) {
  const past = series.c.slice(-130);
  const nP = past.length;
  const Hd = fan[fan.length - 1].day;
  const all = [...past, ...fan.flatMap((f) => [f.p10, f.p90]), target, stop, buy].filter((v) => isFinite(v) && v > 0);
  let lo = Math.min(...all), hi = Math.max(...all);
  const padv = (hi - lo) * 0.08; lo -= padv; hi += padv;
  const a = axes({ x0: -nP, x1: Hd, y0: lo, y1: hi, L: 58, R: 14, T: 14, B: 26, yFmt: fmtAxisNum, xLabels: [{ v: -nP + 4, t: "hace 6 meses", anchor: "start" }, { v: 0, t: "hoy" }, { v: Hd, t: `+${Hd} días`, anchor: "end" }] });
  const { sx, sy } = a;
  const pastPts = past.map((v, i) => [sx(i - nP + 1), sy(v)]);
  const band = (k1, k2) => line(fan.map((f) => [sx(f.day), sy(f[k2])])) + " " + fan.slice().reverse().map((f) => `L${f1(sx(f.day))} ${f1(sy(f[k1]))}`).join(" ") + " Z";
  const refs = [
    { v: target, c: "var(--green)", t: "Objetivo", dy: -5 },
    { v: buy, c: "var(--teal)", t: "Compra ≤", dy: 12 },
    { v: stop, c: "var(--red)", t: "Piso", dy: 12 },
  ].filter((r) => isFinite(r.v) && r.v > lo && r.v < hi);
  const refSvg = refs.map((r) => `<line x1="${f1(sx(-40))}" x2="${f1(sx(Hd))}" y1="${f1(sy(r.v))}" y2="${f1(sy(r.v))}" stroke="${r.c}" stroke-width="1.4" stroke-dasharray="5 4" opacity=".85"/><text x="${f1(sx(Hd) - 4)}" y="${f1(sy(r.v) + r.dy)}" text-anchor="end" font-size="11" font-weight="600" fill="${r.c}">${r.t} ${fmtPrice(r.v)}</text>`).join("");
  REG.set("px", { x0: -nP, x1: Hd, y0: lo, y1: hi, L: 58, R: 14, T: 14, B: 26, past, dates: series.t.slice(-130), fan });
  const inner = `<defs><linearGradient id="gArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--blue)" stop-opacity=".32"/><stop offset="1" stop-color="var(--blue)" stop-opacity="0"/></linearGradient></defs>
    ${a.g}
    <path d="${line(pastPts)} L${f1(sx(0))} ${H - 26} L${f1(sx(-nP + 1))} ${H - 26} Z" fill="url(#gArea)"/>
    <path class="fan-o" d="${band("p10", "p90")}"/><path class="fan-i" d="${band("p25", "p75")}"/>
    <path d="${line(fan.map((f) => [sx(f.day), sy(f.p50)]))}" fill="none" stroke="var(--blue)" stroke-width="1.6" stroke-dasharray="3 3"/>
    <path d="${line(pastPts)}" fill="none" stroke="var(--blue)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" class="draw"/>
    ${refSvg}
    <circle cx="${f1(sx(0))}" cy="${f1(sy(S0))}" r="5" fill="var(--blue)" stroke="#fff" stroke-width="2"/>
    <g class="xh" style="display:none"><line y1="14" y2="${H - 26}" stroke="var(--text)" stroke-opacity=".35" stroke-width="1"/><circle r="5.5" fill="var(--bg-dot)" stroke="var(--blue)" stroke-width="2.5"/></g>`;
  return `<div class="chartwrap">${svg(inner, "Precio histórico, abanico de proyección, objetivo y piso").replace("<svg ", '<svg id="pxchart" ')}<div class="tip" hidden></div></div>`;
}

// -------- tasas: historia + abanico de Vasicek --------
export function ratesChart(part) {
  const hist = part.series.c.slice(-252).map((v) => v / 100);
  const nH = hist.length, path = part.path, Fd = 252;
  const all = [...hist, ...path.map((p) => p.lo), ...path.map((p) => p.hi), part.params.b];
  let lo = Math.min(...all), hi = Math.max(...all); const pv = (hi - lo) * 0.1; lo -= pv; hi += pv;
  const a = axes({ x0: -nH, x1: Fd, y0: lo, y1: hi, L: 50, R: 14, T: 14, B: 26, yFmt: (v) => (v * 100).toFixed(1).replace(".", ",") + "%", xLabels: [{ v: -nH + 4, t: "hace 1 año", anchor: "start" }, { v: 0, t: "hoy" }, { v: Fd, t: "+1 año", anchor: "end" }] });
  const { sx, sy } = a;
  const hp = hist.map((v, i) => [sx(i - nH + 1), sy(v)]);
  const fp = path.map((p) => [sx(p.t * 252), sy(p.m)]);
  const bandP = path.map((p) => [sx(p.t * 252), sy(p.hi)]);
  const bandN = path.slice().reverse().map((p) => `L${f1(sx(p.t * 252))} ${f1(sy(p.lo))}`).join(" ");
  const inner = `${a.g}
    <line x1="${f1(sx(-nH))}" x2="${f1(sx(Fd))}" y1="${f1(sy(part.params.b))}" y2="${f1(sy(part.params.b))}" stroke="var(--purple)" stroke-width="1.3" stroke-dasharray="6 4"/>
    <text x="${f1(sx(-nH) + 6)}" y="${f1(sy(part.params.b) - 6)}" font-size="11" font-weight="600" fill="var(--purple)">Promedio de largo plazo b = ${(part.params.b * 100).toFixed(2).replace(".", ",")} %</text>
    <path class="fan-o" d="${line(bandP)} ${bandN} Z"/>
    <path d="${line(hp)}" fill="none" stroke="var(--blue)" stroke-width="2.2" class="draw"/>
    <path d="${line(fp)}" fill="none" stroke="var(--blue)" stroke-width="1.8" stroke-dasharray="4 3"/>
    <circle cx="${f1(sx(0))}" cy="${f1(sy(part.r0))}" r="5" fill="var(--blue)" stroke="#fff" stroke-width="2"/>`;
  return svg(inner, "Tasa de interés: historia y proyección de Vasicek");
}

// -------- curva de rendimientos: modelo vs observado --------
export function curveChart(v) {
  const pts = v.curve.map((c) => ({ x: c.tau, y: c.yield, label: c.label }));
  const obs = v.observed.map((o) => ({ label: o.label, y: o.yield }));
  const xs = { "3 meses": 0.25, "5 años": 5, "10 años": 10, "30 años": 30 };
  const all = [...pts.map((p) => p.y), ...obs.map((o) => o.y)];
  let lo = Math.min(...all), hi = Math.max(...all); const pv = (hi - lo) * 0.2 || 0.005; lo -= pv; hi += pv;
  const a = axes({ x0: 0, x1: 30, y0: lo, y1: hi, L: 50, R: 18, T: 14, B: 26, yFmt: (t) => (t * 100).toFixed(1).replace(".", ",") + "%", xLabels: [{ v: 0.25, t: "3 meses", anchor: "start" }, { v: 5, t: "5 años" }, { v: 10, t: "10 años" }, { v: 30, t: "30 años", anchor: "end" }] });
  const { sx, sy } = a;
  const inner = `${a.g}<path d="${line(pts.map((p) => [sx(p.x), sy(p.y)]))}" fill="none" stroke="var(--purple)" stroke-width="2.2" stroke-linecap="round"/>
    ${pts.map((p) => `<circle cx="${f1(sx(p.x))}" cy="${f1(sy(p.y))}" r="4" fill="var(--purple)"/>`).join("")}
    ${obs.map((o) => `<circle cx="${f1(sx(xs[o.label] ?? 1))}" cy="${f1(sy(o.y))}" r="6" fill="var(--bg-dot)" stroke="var(--orange)" stroke-width="2.4"/>`).join("")}
    <text x="${W - 20}" y="22" text-anchor="end" font-size="11" font-weight="600" fill="var(--purple)">● Vasicek (sin prima de riesgo)</text>
    <text x="${W - 20}" y="38" text-anchor="end" font-size="11" font-weight="600" fill="var(--orange)">◯ Observado en el mercado</text>`;
  return svg(inner, "Curva de rendimientos: Vasicek frente a observada");
}

// -------- manada: dispersión vs |Rm| --------
export function herdChart(h) {
  const pts = h.pts.map((p) => ({ x: p.x * 100, y: p.y * 100 }));
  const xmax = Math.max(...pts.map((p) => p.x)) * 1.05, ymax = Math.max(...pts.map((p) => p.y)) * 1.1;
  const a = axes({ x0: 0, x1: xmax, y0: 0, y1: ymax, L: 50, R: 14, T: 14, B: 26, yFmt: (v) => v.toFixed(1).replace(".", ",") + "%", xLabels: [{ v: 0, t: "mercado casi quieto", anchor: "start" }, { v: xmax, t: "movimiento extremo del mercado (|Rm|)", anchor: "end" }] });
  const { sx, sy } = a;
  const f = h.full, col = h.recent.herding || f.herding ? "var(--orange)" : "var(--green)";
  const curve = [];
  for (let i = 0; i <= 40; i++) { const x = (xmax * i) / 40; const xr = x / 100; curve.push([sx(x), sy(Math.max(0, (f.alpha + f.g1 * xr + f.g2 * xr * xr) * 100))]); }
  const inner = `${a.g}${pts.map((p) => `<circle cx="${f1(sx(p.x))}" cy="${f1(sy(p.y))}" r="2.6" fill="var(--blue)" opacity=".45"/>`).join("")}
    <path d="${line(curve)}" fill="none" stroke="${col}" stroke-width="2.6" stroke-linecap="round"/>
    <text x="${W - 20}" y="24" text-anchor="end" font-size="11" font-weight="600" fill="${col}">γ₂ = ${f.g2.toFixed(2)} (t = ${f.t2.toFixed(1)}) ${f.herding ? "→ manada" : "→ sin manada"}</text>`;
  return svg(inner, "Dispersión de rendimientos frente al movimiento del mercado");
}

// -------- reversión a la media --------
export function meanRevChart(m) {
  const p = m.prices, eq = m.eqSeries, n = p.length;
  const up = eq.map((e) => e * Math.exp(m.sigU)), dn = eq.map((e) => e * Math.exp(-m.sigU));
  const all = [...p, ...up, ...dn];
  let lo = Math.min(...all), hi = Math.max(...all); const pv = (hi - lo) * 0.06; lo -= pv; hi += pv;
  const a = axes({ x0: 0, x1: n - 1, y0: lo, y1: hi, L: 58, R: 14, T: 14, B: 26, yFmt: fmtAxisNum, xLabels: [{ v: 0, t: "hace 2 años", anchor: "start" }, { v: n - 1, t: "hoy", anchor: "end" }] });
  const { sx, sy } = a;
  const band = line(up.map((v, i) => [sx(i), sy(v)])) + " " + dn.map((v, i) => [sx(i), sy(v)]).reverse().map((q) => `L${f1(q[0])} ${f1(q[1])}`).join(" ") + " Z";
  const inner = `${a.g}<path class="fan-o" d="${band}"/>
    <path d="${line(eq.map((v, i) => [sx(i), sy(v)]))}" fill="none" stroke="var(--purple)" stroke-width="1.8" stroke-dasharray="6 4"/>
    <path d="${line(p.map((v, i) => [sx(i), sy(v)]))}" fill="none" stroke="var(--blue)" stroke-width="2.1" class="draw"/>
    <circle cx="${f1(sx(n - 1))}" cy="${f1(sy(p[n - 1]))}" r="5" fill="var(--blue)" stroke="#fff" stroke-width="2"/>
    <text x="${W - 20}" y="24" text-anchor="end" font-size="11" font-weight="600" fill="var(--purple)">- - Equilibrio (tendencia) y banda ±1σ</text>`;
  return svg(inner, "Precio frente a su nivel de equilibrio");
}

// -------- colas: histograma del rendimiento a H días vs normal --------
export function tailChart(m) {
  const { bins, lo, hi } = m.hist, nb = bins.length, bw = (hi - lo) / nb;
  const total = bins.reduce((s, v) => s + v, 0);
  const mu = m.targetDaily * m.H, sd = m.totalVolYear * Math.sqrt(m.H / 252);
  const gauss = bins.map((_, i) => total * bw * normPdf((lo + (i + 0.5) * bw - mu) / sd) / sd);
  const ymax = Math.max(...bins, ...gauss) * 1.12;
  const a = axes({ x0: lo, x1: hi, y0: 0, y1: ymax, L: 14, R: 14, T: 14, B: 26, yFmt: () => "", xLabels: [{ v: lo + 0.02, t: "−50 %", anchor: "start" }, { v: -0.25, t: "−25 %" }, { v: 0, t: "0 %" }, { v: 0.25, t: "+25 %" }, { v: hi - 0.02, t: "+50 %", anchor: "end" }] });
  const { sx, sy } = a;
  const bars = bins.map((v, i) => { const x0 = lo + i * bw, red = x0 + bw <= -0.1; return `<rect x="${f1(sx(x0) + 1)}" y="${f1(sy(v))}" width="${f1(sx(x0 + bw) - sx(x0) - 2)}" height="${f1(H - 26 - sy(v))}" rx="2" fill="${red ? "var(--red)" : "var(--blue)"}" opacity="${red ? 0.8 : 0.55}"/>`; }).join("");
  const gp = line(gauss.map((g, i) => [sx(lo + (i + 0.5) * bw), sy(g)]));
  const inner = `${a.g}${bars}<path d="${gp}" fill="none" stroke="var(--orange)" stroke-width="2.2"/>
    <text x="${W - 20}" y="22" text-anchor="end" font-size="11" font-weight="600" fill="var(--orange)">— Sin saltos (normal)</text>
    <text x="${W - 20}" y="38" text-anchor="end" font-size="11" font-weight="600" fill="var(--red)">■ Caídas de más de 10 %</text>`;
  return svg(inner, "Distribución del rendimiento esperado con saltos frente a una normal");
}

// -------- medidor de señal (HTML) --------
export function gauge(score, small = false) {
  const x = Math.min(1, Math.max(-1, score));
  return `<div class="gauge ${small ? "sm" : ""}" data-v="${x.toFixed(3)}" role="img" aria-label="Señal ${score.toFixed(2)} entre −1 y 1"><div class="track"></div><i class="thumb" style="left:${(((x + 1) / 2) * 100).toFixed(1)}%"></i>${small ? "" : `<span class="l">Vender</span><span class="m">Esperar</span><span class="r">Comprar</span>`}</div>`;
}

// -------- cursor interactivo del gráfico de precio: sigue al puntero 1:1 --------
export function bindCrosshair(root) {
  const svg = root.querySelector("#pxchart"), m = REG.get("px");
  if (!svg || !m) return;
  const tip = root.querySelector(".tip"), g = svg.querySelector(".xh"), ln = g.querySelector("line"), dot = g.querySelector("circle");
  const sx = (d) => m.L + ((d - m.x0) / (m.x1 - m.x0)) * (W - m.L - m.R);
  const sy = (v) => H - m.B + ((v - m.y0) / (m.y1 - m.y0)) * (m.T - (H - m.B));
  const nP = m.past.length;
  const fmtDate = (ts) => new Date(ts * 1000).toLocaleDateString("es-CO", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
  const move = (e) => {
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    let d = m.x0 + ((x - m.L) / (W - m.L - m.R)) * (m.x1 - m.x0);
    d = Math.max(m.x0, Math.min(m.x1, d));
    let val, label, extra = "";
    if (d <= 0) {
      const i = Math.max(0, Math.min(nP - 1, Math.round(d) + nP - 1));
      val = m.past[i]; label = fmtDate(m.dates[i]); d = i - nP + 1;
    } else {
      let k = 0; while (k < m.fan.length - 2 && m.fan[k + 1].day < d) k++;
      const a = m.fan[k], b = m.fan[k + 1], u = (d - a.day) / (b.day - a.day || 1);
      const lerp = (p) => a[p] + (b[p] - a[p]) * u;
      val = lerp("p50"); label = `en ${Math.round(d)} días`;
      extra = `<span class="r">${fmtPrice(lerp("p10"))} – ${fmtPrice(lerp("p90"))}</span>`;
    }
    g.style.display = ""; ln.setAttribute("x1", sx(d)); ln.setAttribute("x2", sx(d)); dot.setAttribute("cx", sx(d)); dot.setAttribute("cy", sy(val));
    tip.hidden = false;
    tip.innerHTML = `<span class="d">${label}</span><b>${fmtPrice(val)}</b>${extra}`;
    const px = (sx(d) / W) * r.width, w = tip.offsetWidth;
    tip.style.transform = `translate(${Math.max(4, Math.min(r.width - w - 4, px - w / 2))}px, 6px)`;
  };
  const hide = () => { g.style.display = "none"; tip.hidden = true; };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("pointercancel", hide);
}
