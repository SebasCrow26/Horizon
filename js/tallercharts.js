// Gráficos del Taller de riesgo en SVG propio (sin librerías). Usan las variables de color de Horizon (tema claro/oscuro).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const COLS = ["#0a84ff", "#30d158", "#ff9f0a", "#ff453a", "#64d2ff", "#ffd60a", "#ac8e68", "#bf5af2", "#5e5ce6", "#ff6482"];
let W = 680;
export const setChartWidth = (w) => { W = Math.max(300, Math.min(900, Math.round(w))); };
const f1 = (x) => Math.round(x * 10) / 10;
const REG = new Map();
let uid = 0;

export function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || Math.abs(hi) || 1, raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p, step = (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p, ticks = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) ticks.push(+v.toFixed(12));
  return { ticks, step };
}
export const numFmt = (step) => { const d = step >= 1 ? 0 : Math.min(8, Math.ceil(-Math.log10(step) - 1e-9)); return (x) => x.toLocaleString("es-CO", { minimumFractionDigits: d, maximumFractionDigits: d }); };
const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const dateFmt = (day) => { const d = new Date(day * 86400000); return `${d.getUTCDate()} ${MES[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`; };
const card = (title, hint, body, legend = "") => `<div class="glass chartcard tlc-card"><h3>${esc(title)}</h3>${hint ? `<div class="hint">${esc(hint)}</div>` : ""}${legend}${body}</div>`;
const legendHtml = (items) => (items.length ? `<div class="tlc-legend">${items.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>` : "");
const frame = (inner, H, id = "") => `<div class="tlc-wrap"${id ? ` data-id="${id}"` : ""}><svg class="tlc" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">${inner}</svg>${id ? `<div class="pxc-tip" hidden></div>` : ""}</div>`;

// ---------- líneas ----------
// series: [{name,color,x,y,dash,width,opacity,dots}], band:{x,lo,hi,color,opacity}, hlines/vlines:[{v,label,color,dash}], points:[{x,y,color,r,title}]
export function lineChart({ title, hint, series, band = null, hlines = [], vlines = [], points = [], height = 300, xDates = false, xFmt = null, yFmt = null, legend = true, xLabel = "", step = false }) {
  const L = 62, R = 16, T = 14, B = 30, pw = W - L - R, ph = height - T - B;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const eat = (x, y) => { if (Number.isFinite(x)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); } if (Number.isFinite(y)) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); } };
  for (const s of series) s.x.forEach((x, i) => eat(x, s.y[i]));
  if (band) band.x.forEach((x, i) => { eat(x, band.lo[i]); eat(x, band.hi[i]); });
  hlines.forEach((h) => eat(NaN, h.v)); vlines.forEach((v) => eat(v.v, NaN)); points.forEach((p) => eat(p.x, p.y));
  if (!(x1 > x0)) { x1 = x0 + 1; }
  if (!(y1 > y0)) { y1 = y0 + 1; y0 -= 1; }
  const padY = (y1 - y0) * 0.06; y0 -= padY; y1 += padY;
  const sx = (x) => L + ((x - x0) / (x1 - x0)) * pw, sy = (y) => T + ((y1 - y) / (y1 - y0)) * ph;
  const { ticks, step: st } = niceTicks(y0, y1, 5), yf = yFmt || numFmt(st);
  let g = ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${f1(sy(t))}" y2="${f1(sy(t))}" class="pxc-grid"/><text x="${L - 8}" y="${f1(sy(t)) + 4}" text-anchor="end" class="pxc-ytx">${yf(t)}</text>`).join("");
  const nx = 6, xf = xFmt || (xDates ? (v) => dateFmt(v) : numFmt(niceTicks(x0, x1, nx).step));
  for (let k = 0; k <= nx; k++) { const xv = x0 + ((x1 - x0) * k) / nx; g += `<text x="${f1(sx(xv))}" y="${height - 8}" text-anchor="${k === 0 ? "start" : k === nx ? "end" : "middle"}" class="pxc-xtx">${esc(xf(xv))}</text>`; }
  if (xLabel) g += `<text x="${W - R}" y="${T + 10}" text-anchor="end" class="pxc-xtx">${esc(xLabel)}</text>`;
  if (band) {
    const up = band.x.map((x, i) => `${f1(sx(x))} ${f1(sy(band.hi[i]))}`), dn = band.x.map((x, i) => `${f1(sx(x))} ${f1(sy(band.lo[i]))}`).reverse();
    g += `<path d="M${up.join("L")}L${dn.join("L")}Z" style="fill:${band.color || COLS[0]}" opacity="${band.opacity ?? 0.18}"/>`;
  }
  for (const h of hlines) g += `<line x1="${L}" x2="${W - R}" y1="${f1(sy(h.v))}" y2="${f1(sy(h.v))}" stroke="${h.color || "var(--muted)"}" stroke-width="1" stroke-dasharray="${h.dash ?? "4 4"}"/>${h.label ? `<text x="${W - R - 4}" y="${f1(sy(h.v)) - 4}" text-anchor="end" class="pxc-xtx" fill="${h.color || "var(--muted)"}">${esc(h.label)}</text>` : ""}`;
  for (const v of vlines) g += `<line y1="${T}" y2="${T + ph}" x1="${f1(sx(v.v))}" x2="${f1(sx(v.v))}" stroke="${v.color || "var(--muted)"}" stroke-width="1" stroke-dasharray="${v.dash ?? "4 4"}"/>${v.label ? `<text x="${f1(sx(v.v)) + 4}" y="${T + 12}" class="pxc-xtx" fill="${v.color || "var(--muted)"}">${esc(v.label)}</text>` : ""}`;
  for (const s of series) {
    const pts = s.x.map((x, i) => [f1(sx(x)), f1(sy(s.y[i]))]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
    let d = "M" + pts.map((p) => p.join(" ")).join("L");
    if (step) { d = "M" + pts.map((p, i) => (i ? `${p[0]} ${pts[i - 1][1]}L${p[0]} ${p[1]}` : p.join(" "))).join("L"); }
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 1.8}" stroke-linejoin="round" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} opacity="${s.opacity ?? 1}"/>`;
    if (s.dots) g += pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="${s.color}"/>`).join("");
  }
  for (const p of points) g += `<circle cx="${f1(sx(p.x))}" cy="${f1(sy(p.y))}" r="${p.r ?? 4}" fill="${p.color || COLS[3]}">${p.title ? `<title>${esc(p.title)}</title>` : ""}</circle>`;
  g += `<g class="pxc-xh" style="display:none"><line class="pxc-xhl" y1="${T}" y2="${T + ph}"/></g>`;
  const id = "tl" + ++uid;
  REG.set(id, { L, R, T, ph, W, H: height, x0, x1, sx, sy, series: series.filter((s) => s.hover !== false), xf, yf, xDates });
  return card(title, hint, frame(g, height, id), legend ? legendHtml(series.filter((s) => s.name)) : "");
}

// Cursor de los gráficos de línea: línea vertical y valores de cada serie en el punto más cercano
export function bindTallerHover(root) {
  for (const wrap of root.querySelectorAll(".tlc-wrap[data-id]")) {
    if (wrap.dataset.bound) continue;
    wrap.dataset.bound = "1";
    const cfg = REG.get(wrap.dataset.id), svg = wrap.querySelector("svg"), tip = wrap.querySelector(".pxc-tip"), xh = svg.querySelector(".pxc-xh");
    if (!cfg) continue;
    const move = (ev) => {
      const r = svg.getBoundingClientRect(), x = ((ev.clientX - r.left) / r.width) * cfg.W, xv = cfg.x0 + ((x - cfg.L) / (cfg.W - cfg.L - cfg.R)) * (cfg.x1 - cfg.x0);
      const base = cfg.series[0]; if (!base) return;
      let bi = 0, bd = Infinity; base.x.forEach((v, i) => { const d = Math.abs(v - xv); if (d < bd) { bd = d; bi = i; } });
      const px = cfg.sx(base.x[bi]);
      xh.style.display = ""; const ln = xh.querySelector("line"); ln.setAttribute("x1", f1(px)); ln.setAttribute("x2", f1(px));
      const rows = cfg.series.map((s) => { let k = 0, kd = Infinity; s.x.forEach((v, i) => { const d = Math.abs(v - base.x[bi]); if (d < kd) { kd = d; k = i; } }); return Number.isFinite(s.y[k]) ? `<span class="r"><i style="background:${s.color}"></i>${esc(s.name || "")} <b>${esc(cfg.yf(s.y[k]))}</b></span>` : ""; }).join("");
      tip.innerHTML = `<span class="d">${esc(cfg.xf(base.x[bi]))}</span>${rows}`;
      tip.hidden = false;
      const tw = tip.offsetWidth, left = Math.min(Math.max((px / cfg.W) * r.width + 12, 4), r.width - tw - 4);
      tip.style.transform = `translate(${f1(left)}px, 8px)`;
    };
    const out = () => { tip.hidden = true; xh.style.display = "none"; };
    svg.addEventListener("pointermove", move); svg.addEventListener("pointerdown", move); svg.addEventListener("pointerleave", out); svg.addEventListener("pointercancel", out);
  }
}

// ---------- histograma ----------
// datasets: [{name,color,data,outline}] (el primero va relleno; los demás, solo contorno). vlines: [{v,label,color}]
export function histChart({ title, hint, datasets, bins = 40, vlines = [], height = 280, xFmt = null, density = true }) {
  const L = 56, R = 16, T = 14, B = 30, pw = W - L - R, ph = height - T - B;
  const all = datasets.flatMap((d) => Array.from(d.data));
  let lo = Math.min(...all), hi = Math.max(...all);
  vlines.forEach((v) => { lo = Math.min(lo, v.v); hi = Math.max(hi, v.v); });
  if (!(hi > lo)) hi = lo + 1;
  const bw = (hi - lo) / bins, hs = datasets.map((d) => { const c = new Array(bins).fill(0); for (const x of d.data) c[Math.min(bins - 1, Math.max(0, Math.floor((x - lo) / bw)))]++; return density ? c.map((v) => v / d.data.length / bw) : c; });
  const ymax = Math.max(...hs.flat()) * 1.08, sx = (x) => L + ((x - lo) / (hi - lo)) * pw, sy = (y) => T + (1 - y / ymax) * ph;
  const { step } = niceTicks(lo, hi, 6), xf = xFmt || numFmt(step);
  let g = `<line x1="${L}" x2="${W - R}" y1="${T + ph}" y2="${T + ph}" class="pxc-grid"/>`;
  for (let k = 0; k <= 6; k++) { const xv = lo + ((hi - lo) * k) / 6; g += `<text x="${f1(sx(xv))}" y="${height - 8}" text-anchor="${k === 0 ? "start" : k === 6 ? "end" : "middle"}" class="pxc-xtx">${esc(xf(xv))}</text>`; }
  g += `<text x="${L - 8}" y="${T + 10}" text-anchor="end" class="pxc-ytx">${density ? "densidad" : "casos"}</text>`;
  hs.forEach((h, k) => {
    if (k === 0) g += h.map((v, i) => `<rect x="${f1(sx(lo + i * bw)) + 0.5}" y="${f1(sy(v))}" width="${Math.max(0.5, f1(pw / bins) - 1)}" height="${f1(T + ph - sy(v))}" fill="${datasets[0].color}" opacity=".55"/>`).join("");
    else g += `<path d="M${h.map((v, i) => `${f1(sx(lo + (i + 0.5) * bw))} ${f1(sy(v))}`).join("L")}" fill="none" stroke="${datasets[k].color}" stroke-width="2"/>`;
  });
  for (const v of vlines) g += `<line y1="${T}" y2="${T + ph}" x1="${f1(sx(v.v))}" x2="${f1(sx(v.v))}" stroke="${v.color || "var(--red)"}" stroke-width="1.6" stroke-dasharray="${v.dash ?? "5 4"}"/><text x="${f1(sx(v.v)) + 4}" y="${T + 12 + (v.row ?? 0) * 13}" class="pxc-xtx" fill="${v.color || "var(--red)"}">${esc(v.label)}</text>`;
  return card(title, hint, frame(g, height), legendHtml(datasets.map((d) => ({ name: d.name, color: d.color }))));
}

// ---------- barras agrupadas ----------
export function barChart({ title, hint, labels, series, hlines = [], height = 280, yFmt = null, pctAxis = false }) {
  const L = 56, R = 16, T = 14, B = 52, pw = W - L - R, ph = height - T - B;
  const vals = series.flatMap((s) => s.values).concat(hlines.map((h) => h.v)), hi = Math.max(...vals, 0) * 1.1 || 1, lo = Math.min(0, ...vals);
  const sy = (y) => T + ((hi - y) / (hi - lo)) * ph, { ticks, step } = niceTicks(lo, hi, 5), yf = yFmt || (pctAxis ? (v) => (v * 100).toLocaleString("es-CO", { maximumFractionDigits: 0 }) + " %" : numFmt(step));
  let g = ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${f1(sy(t))}" y2="${f1(sy(t))}" class="pxc-grid"/><text x="${L - 8}" y="${f1(sy(t)) + 4}" text-anchor="end" class="pxc-ytx">${yf(t)}</text>`).join("");
  const gw = pw / labels.length, bw = Math.min(26, (gw * 0.8) / series.length);
  labels.forEach((lab, i) => {
    const cx = L + gw * (i + 0.5);
    series.forEach((s, k) => { const x = cx - (bw * series.length) / 2 + k * bw, y = sy(Math.max(0, s.values[i])), h = Math.abs(sy(s.values[i]) - sy(0)); g += `<rect x="${f1(x)}" y="${f1(Math.min(sy(0), sy(s.values[i])))}" width="${f1(bw - 1)}" height="${f1(h)}" fill="${s.color}" rx="2"><title>${esc(lab)} · ${esc(s.name)}: ${esc(yf(s.values[i]))}</title></rect>`; });
    g += `<text transform="translate(${f1(cx)} ${height - B + 14}) rotate(${labels.length > 6 ? -35 : 0})" text-anchor="${labels.length > 6 ? "end" : "middle"}" class="pxc-xtx">${esc(lab)}</text>`;
  });
  for (const h of hlines) g += `<line x1="${L}" x2="${W - R}" y1="${f1(sy(h.v))}" y2="${f1(sy(h.v))}" stroke="${h.color || "var(--red)"}" stroke-width="1.4" stroke-dasharray="5 4"/><text x="${W - R - 4}" y="${f1(sy(h.v)) - 4}" text-anchor="end" class="pxc-xtx" fill="${h.color || "var(--red)"}">${esc(h.label)}</text>`;
  return card(title, hint, frame(g, height), legendHtml(series.map((s) => ({ name: s.name, color: s.color }))));
}

// ---------- mapa de calor (correlaciones) ----------
export function heatmap({ title, hint, labels, matrix }) {
  const n = labels.length, L = 64, T = 52, cell = Math.min(46, (W - L - 20) / n), H = T + cell * n + 12;
  let g = "";
  labels.forEach((l, i) => { g += `<text x="${L + cell * (i + 0.5)}" y="${T - 8}" text-anchor="middle" class="pxc-xtx">${esc(l)}</text><text x="${L - 6}" y="${T + cell * (i + 0.5) + 4}" text-anchor="end" class="pxc-xtx">${esc(l)}</text>`; });
  matrix.forEach((row, i) => row.forEach((v, j) => { const a = Math.min(1, Math.abs(v)); g += `<rect x="${L + cell * j}" y="${T + cell * i}" width="${cell - 1}" height="${cell - 1}" rx="3" style="fill:${v >= 0 ? "var(--blue)" : "var(--red)"}" opacity="${(0.12 + 0.78 * a).toFixed(2)}"><title>${esc(labels[i])} · ${esc(labels[j])}: ${v.toFixed(2)}</title></rect>${n <= 12 && cell >= 30 ? `<text x="${L + cell * (j + 0.5)}" y="${T + cell * (i + 0.5) + 4}" text-anchor="middle" class="pxc-xtx" style="fill:var(--text)">${v.toFixed(2).replace(".", ",")}</text>` : ""}`; }));
  return card(title, hint, frame(g, H));
}

// ---------- árbol de 3 pasos ----------
export function treeChart({ title, hint, arbol, K, tipo }) {
  const Wt = Math.max(W, 540), H = 300, mx = 56, my = 30, lw = (Wt - 2 * mx) / 3, dy = 58, mid = H / 2;
  const pos = (i, j) => [mx + lw * i, mid - (j - i / 2) * dy];
  let g = "";
  for (let i = 0; i < 3; i++) for (let j = 0; j <= i; j++) { const [x, y] = pos(i, j); for (const jj of [j, j + 1]) { const [x2, y2] = pos(i + 1, jj); g += `<line x1="${f1(x)}" y1="${f1(y)}" x2="${f1(x2)}" y2="${f1(y2)}" stroke="var(--muted)" stroke-width="1" opacity=".5"/>`; } }
  for (let i = 0; i <= 3; i++) for (let j = 0; j <= i; j++) {
    const [x, y] = pos(i, j), ex = arbol.ejerce[i][j];
    g += `<rect x="${f1(x - 40)}" y="${f1(y - 19)}" width="80" height="38" rx="9" style="fill:var(--card2);stroke:${ex ? "var(--green)" : "var(--stroke)"};stroke-width:${ex ? 2 : 1}"/><text x="${f1(x)}" y="${f1(y) - 3}" text-anchor="middle" class="pxc-xtx" style="fill:var(--muted)">S ${arbol.S[i][j].toLocaleString("es-CO", { maximumFractionDigits: 2 })}</text><text x="${f1(x)}" y="${f1(y) + 12}" text-anchor="middle" class="pxc-xtx" style="fill:var(--text);font-weight:700">V ${arbol.V[i][j].toLocaleString("es-CO", { maximumFractionDigits: 2 })}</text>`;
  }
  for (let i = 0; i <= 3; i++) g += `<text x="${f1(mx + lw * i)}" y="${H - 6}" text-anchor="middle" class="pxc-xtx">t = ${i}</text>`;
  return card(title, hint, `<div class="tl-scroll"><svg class="tlc" style="min-width:${Wt}px" viewBox="0 0 ${Wt} ${H}" role="img" preserveAspectRatio="xMidYMid meet">${g}</svg></div>`);
}

// ---------- prima teórica frente al mercado: bid–ask, V_CRR (σ histórica) y V_CRR (vol. implícita) ----------
export function premiumChart({ title, hint, cands, elegido }) {
  const H = 310, L = 56, R = 16, T = 18, B = 64, pw = W - L - R, ph = H - T - B;
  const vals = cands.flatMap((c) => [c.bid, c.ask, c.V_CRR_sigma_hist, c.V_CRR_vol_impl]).filter(Number.isFinite), hi = Math.max(...vals, 1) * 1.1;
  const sy = (y) => T + (1 - y / hi) * ph, { ticks, step } = niceTicks(0, hi, 5), yf = numFmt(step), gw = pw / cands.length;
  let g = ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${f1(sy(t))}" y2="${f1(sy(t))}" class="pxc-grid"/><text x="${L - 8}" y="${f1(sy(t)) + 4}" text-anchor="end" class="pxc-ytx">${yf(t)}</text>`).join("");
  cands.forEach((c, i) => {
    const cx = L + gw * (i + 0.5);
    if (i === elegido) g += `<rect x="${f1(cx - gw / 2)}" y="${T}" width="${f1(gw)}" height="${ph}" style="fill:var(--blue)" opacity=".10"/>`;
    if (c.usable) g += `<line x1="${f1(cx)}" x2="${f1(cx)}" y1="${f1(sy(c.bid))}" y2="${f1(sy(c.ask))}" stroke="var(--muted)" stroke-width="6" stroke-linecap="round" opacity=".55"><title>Bid ${c.bid} – Ask ${c.ask}</title></line>`;
    if (Number.isFinite(c.V_CRR_sigma_hist)) g += `<circle cx="${f1(cx - 7)}" cy="${f1(sy(c.V_CRR_sigma_hist))}" r="4.5" style="fill:var(--blue)"><title>V_CRR con σ histórica: ${c.V_CRR_sigma_hist.toFixed(2)}</title></circle>`;
    if (Number.isFinite(c.V_CRR_vol_impl)) g += `<rect x="${f1(cx + 3)}" y="${f1(sy(c.V_CRR_vol_impl)) - 4}" width="8" height="8" style="fill:var(--orange)" transform="rotate(45 ${f1(cx + 7)} ${f1(sy(c.V_CRR_vol_impl))})"><title>V_CRR con vol. implícita: ${c.V_CRR_vol_impl.toFixed(2)}</title></rect>`;
    g += `<text transform="translate(${f1(cx)} ${H - B + 14}) rotate(-35)" text-anchor="end" class="pxc-xtx">${esc(c.plazo.replace(" meses", "m").replace(" mes", "m"))} · K ${c.strike}</text>`;
  });
  return card(title, hint, frame(g, H), legendHtml([{ name: "Bid–ask del mercado", color: "var(--muted)" }, { name: "V_CRR con σ histórica", color: "var(--blue)" }, { name: "V_CRR con vol. implícita", color: "var(--orange)" }]));
}
