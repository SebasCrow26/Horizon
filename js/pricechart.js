// Gráfico de precio estilo Yahoo Finance, dibujado en SVG propio (sin librerías):
// rangos 1D · 5D · 1M · 6M · YTD · 1Y · 5Y · Todo, área / línea / velas, volumen, horario extendido,
// línea punteada del cierre previo (verde por encima, rojo por debajo), etiqueta del último precio,
// cursor con detalle, zoom (arrastrar una zona, pellizcar, botones + / −, doble clic para volver) y desplazamiento
// cuando está acercado, y actualización automática cada 30 s mientras el mercado está abierto.
import { getChart, CHART_RANGES } from "./data.js";
import { fmtPriceNum } from "./util.js";

const KEY = "hz_chart";
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
const savePrefs = (o) => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { /* sin almacenamiento */ } };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const f1 = (x) => Math.round(x * 10) / 10;
const nfCompact = new Intl.NumberFormat("es-CO", { notation: "compact", maximumFractionDigits: 2 });
const RANGE_KEYS = Object.keys(CHART_RANGES);
const dtfCache = new Map();
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"], DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
// Fecha corta del eje en la zona horaria de la bolsa: "30 oct", "jun 2022", "jue 5"
function axisDate(tz, ms, kind) {
  const p = Object.fromEntries(dtf(tz, { year: "numeric", month: "numeric", day: "numeric", weekday: "short" }).formatToParts(ms).map((x) => [x.type, x.value]));
  const mon = MESES[(+p.month || 1) - 1];
  return kind === "my" ? `${mon} ${p.year}` : kind === "wd" ? `${String(p.weekday).replace(".", "")} ${p.day}` : `${p.day} ${mon}`;
}
const dtf = (tz, opt) => {
  const k = tz + JSON.stringify(opt);
  if (!dtfCache.has(k)) { try { dtfCache.set(k, new Intl.DateTimeFormat("es-CO", { timeZone: tz || "UTC", ...opt })); } catch (e) { dtfCache.set(k, new Intl.DateTimeFormat("es-CO", { timeZone: "UTC", ...opt })); } }
  return dtfCache.get(k);
};

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}
const fmtAt = (x, step) => {
  if (Math.abs(x) < step * 1e-6) x = 0;
  const d = step >= 1 ? 0 : Math.min(8, Math.ceil(-Math.log10(step) - 1e-9) + (Math.abs(step * 10 - Math.round(step * 10)) > 1e-9 ? 1 : 0));
  const big = Math.abs(x) >= 1000 ? 0 : d;
  return x.toLocaleString("es-CO", { minimumFractionDigits: big, maximumFractionDigits: big });
};

// Agrupa en velas más anchas para que sean legibles (p. ej. 811 minutos → ~60 velas)
function aggregate(d, maxBars) {
  const n = d.t.length;
  if (n <= maxBars) return { t: d.t, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v };
  const g = Math.ceil(n / maxBars), out = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < n; i += g) {
    const j = Math.min(n, i + g);
    out.t.push(d.t[i]); out.o.push(d.o[i]); out.c.push(d.c[j - 1]);
    out.h.push(Math.max(...d.h.slice(i, j))); out.l.push(Math.min(...d.l.slice(i, j)));
    out.v.push(d.v.slice(i, j).reduce((a, b) => a + b, 0));
  }
  return out;
}

// Velas intradía: se agrupan por intervalos de tiempo reales (5 min, 15 min, 1 h…). Así los activos poco negociados
// (muchos minutos sin operaciones) muestran velas con cuerpo y mechas, no rayitas planas.
function aggregateTime(d, maxBars) {
  const BUCKETS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 86400];
  let bucket = BUCKETS[BUCKETS.length - 1];
  for (const b of BUCKETS) { if (new Set(d.t.map((x) => Math.floor(x / b))).size <= maxBars) { bucket = b; break; } }
  const out = { t: [], o: [], h: [], l: [], c: [], v: [], bucket };
  let cur = null;
  for (let i = 0; i < d.t.length; i++) {
    const k = Math.floor(d.t[i] / bucket);
    if (k !== cur) { cur = k; out.t.push(d.t[i]); out.o.push(d.o[i]); out.h.push(d.h[i]); out.l.push(d.l[i]); out.c.push(d.c[i]); out.v.push(d.v[i] || 0); }
    else { const j = out.t.length - 1; out.h[j] = Math.max(out.h[j], d.h[i]); out.l[j] = Math.min(out.l[j], d.l[i]); out.c[j] = d.c[i]; out.v[j] += d.v[i] || 0; }
  }
  return out;
}

export function mountPriceChart(root, { sym, currency = "", onQuote } = {}) {
  const prefs = loadPrefs();
  const st = { range: RANGE_KEYS.includes(prefs.range) ? prefs.range : "1D", type: prefs.type || "area", vol: prefs.vol !== false, ext: prefs.ext !== false, data: null, error: null, offline: false, loading: true, geom: null, view: null /* {t0, t1} cuando hay zoom */ };
  const uid = "pxc" + Math.random().toString(36).slice(2, 7);
  let seq = 0, timer = 0, destroyed = false, ro = null;

  root.innerHTML = `<section class="glass pxc" aria-label="Gráfico de precio">
    <div class="pxc-ranges" role="tablist" aria-label="Periodo">${RANGE_KEYS.map((k) => `<button role="tab" data-r="${k}" title="${CHART_RANGES[k].label}">${k}</button>`).join("")}</div>
    <div class="pxc-opts">
      <span class="pxc-status" aria-live="polite"></span>
      <span class="pxc-ctl">
        <span class="pxc-types" role="group" aria-label="Tipo de gráfico"><button data-t="area">Área</button><button data-t="line">Línea</button><button data-t="candle">Velas</button></span>
        <button class="pxc-tg" data-tg="vol" aria-pressed="true">Volumen</button>
        <button class="pxc-tg" data-tg="ext" aria-pressed="true" title="Incluye operaciones antes y después del horario normal">Extendido</button>
        <span class="pxc-zoom" role="group" aria-label="Zoom"><button data-z="out" aria-label="Alejar" title="Alejar">−</button><button data-z="in" aria-label="Acercar" title="Acercar">+</button></span>
        <button class="pxc-tg pxc-reset" data-z="reset" hidden>Ver todo</button>
      </span>
    </div>
    <div class="pxc-plot"><svg class="pxc-svg" role="img" aria-label="Gráfico de precio"></svg><div class="pxc-tip" hidden></div><div class="pxc-sel" hidden></div></div>
    <p class="pxc-foot"></p></section>`;
  const $ = (s) => root.querySelector(s), $$ = (s) => [...root.querySelectorAll(s)];
  const plot = $(".pxc-plot"), svg = $(".pxc-svg"), tip = $(".pxc-tip");

  const isIntraday = () => !!CHART_RANGES[st.range].intraday;
  const syncControls = () => {
    $$("[data-r]").forEach((b) => {
      const off = st.offline && CHART_RANGES[b.dataset.r].intraday;
      b.classList.toggle("on", b.dataset.r === st.range); b.setAttribute("aria-selected", String(b.dataset.r === st.range));
      b.disabled = !!off; b.title = off ? "Necesita conexión con Yahoo Finance" : CHART_RANGES[b.dataset.r].label;
    });
    const noOhlc = st.data && !st.data.hasOhlc;
    $$("[data-t]").forEach((b) => { b.classList.toggle("on", b.dataset.t === st.type && !(noOhlc && b.dataset.t === "candle")); b.disabled = !!(noOhlc && b.dataset.t === "candle"); b.title = b.disabled ? "Las velas necesitan conexión con Yahoo Finance (los datos guardados solo traen el cierre)" : ""; });
    $("[data-tg=vol]").setAttribute("aria-pressed", String(st.vol));
    $("[data-z=reset]").hidden = !st.view;
    $("[data-z=in]").disabled = !st.data || st.data.c.length < 12;
    $("[data-z=out]").disabled = !st.view;
    const ex = $("[data-tg=ext]"); ex.setAttribute("aria-pressed", String(st.ext)); ex.hidden = !(isIntraday() && st.range !== "1M");
  };

  function setStatus() {
    const el = $(".pxc-status"), foot = $(".pxc-foot"), d = st.data;
    if (st.loading && !d) { el.innerHTML = `<span class="dot"></span>Cargando…`; foot.textContent = ""; return; }
    if (!d) { el.innerHTML = `<span class="dot off"></span>${esc(st.error?.message || "Sin datos")}`; foot.textContent = ""; return; }
    const n = d.c.length, ref = refPrice(d), last = d.c[n - 1], ch = last / ref - 1;
    const tz = d.meta.exchangeTimezoneName;
    const age = Date.now() / 1000 - d.t[n - 1];
    let left;
    if (d.source === "snapshot") left = `<span class="dot off"></span>Datos guardados · sin conexión`;
    else if (isIntraday() && age < 20 * 60) left = `<span class="dot live"></span>En vivo · ${new Date(d.fetchedAt).toLocaleTimeString("es-CO")}`;
    else left = `<span class="dot off"></span>${isIntraday() ? "Mercado cerrado · último dato " : "Último dato "}${dtf(tz, isIntraday() ? { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" }).format(d.t[n - 1] * 1000)}`;
    el.innerHTML = `${left}<b class="${ch >= 0 ? "pos" : "neg"}">${ch >= 0 ? "+" : "−"}${Math.abs(ch * 100).toFixed(2).replace(".", ",")} % ${d.limited ? "en los 3 años guardados" : st.range === "YTD" ? CHART_RANGES[st.range].label : "en " + CHART_RANGES[st.range].label}</b>`;
    foot.textContent = d.source === "snapshot"
      ? `Sin conexión: se muestran los datos diarios guardados${d.limited ? " (solo 3 años)" : ""}. El gráfico del día y las velas necesitan Yahoo Finance.`
      : `Datos de Yahoo Finance; en algunas bolsas llegan con hasta 15 minutos de retraso. ${st.view ? "Arrastra para moverte · doble clic o «Ver todo» para volver." : "Arrastra sobre una zona (o pellizca) para acercarte."}`;
  }

  const refPrice = (d) => (st.range === "1D" && d.meta.chartPreviousClose != null ? d.meta.chartPreviousClose : d.c[0]);

  // Ventana visible (zoom): recorta todas las series a [t0, t1]; con menos puntos, las velas se agrupan menos y se ve más detalle
  function visible(full) {
    if (!full || !st.view) return full;
    let i0 = full.t.findIndex((t) => t >= st.view.t0), i1 = full.t.length - 1;
    while (i1 > 0 && full.t[i1] > st.view.t1) i1--;
    if (i0 < 0 || i1 - i0 < 5) { st.view = null; return full; }
    const sl = (a) => a.slice(i0, i1 + 1);
    return { ...full, t: sl(full.t), o: sl(full.o), h: sl(full.h), l: sl(full.l), c: sl(full.c), v: sl(full.v), i0, i1 };
  }

  function draw() {
    const full = st.data, d = visible(full), zoomed = !!(st.view && d);
    syncControls(); setStatus();
    const W = Math.max(260, Math.floor(plot.clientWidth)), H = W < 520 ? 270 : 330;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
    if (!d) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="pxc-empty">${st.loading ? "" : esc(st.error?.message || "Sin datos")}</text>`; st.geom = null; return; }
    const L = 4, R = 64, T = 12, B = 26, pw = W - L - R, ph = H - T - B;
    const candle = st.type === "candle" && d.hasOhlc;
    const maxBars = Math.max(20, Math.floor(pw / 7));
    const S = candle ? (isIntraday() ? aggregateTime(d, maxBars) : aggregate(d, maxBars)) : d;
    const n = S.t.length, tz = d.meta.exchangeTimezoneName, is1D = st.range === "1D";
    // eje X: el día usa el horario real de la sesión; el resto reparte los puntos por igual (sin huecos de fin de semana)
    let x0 = S.t[0], x1 = S.t[n - 1];
    const cp = d.meta.currentTradingPeriod;
    if (is1D && cp && cp.regular && !zoomed) {
      const per = st.ext && cp.pre && cp.post ? [cp.pre.start, cp.post.end] : [cp.regular.start, cp.regular.end];
      const shift = Math.floor((S.t[0] - per[0]) / 86400) * 86400;
      x0 = Math.min(per[0] + shift, S.t[0]); x1 = Math.max(per[1] + shift, S.t[n - 1]);
    }
    if (x1 <= x0) x1 = x0 + 1;
    const xAt = (i) => (is1D ? L + ((S.t[i] - x0) / (x1 - x0)) * pw : L + ((i + 0.5) / n) * pw);
    const ref = refPrice(full);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { const a = candle ? S.l[i] : S.c[i], b = candle ? S.h[i] : S.c[i]; if (a < lo) lo = a; if (b > hi) hi = b; }
    if (!zoomed) { lo = Math.min(lo, ref); hi = Math.max(hi, ref); } // con zoom, la escala se ajusta solo a lo visible
    const allPositive = lo > 0;
    if (hi - lo < 1e-12) { hi += Math.abs(hi) * 0.01 || 1; lo -= Math.abs(lo) * 0.01 || 1; }
    const padv = (hi - lo) * 0.07; lo -= padv; hi += padv; if (allPositive && lo < 0) lo = 0;
    const yAt = (p) => T + ((hi - p) / (hi - lo)) * ph;
    const step = niceStep((hi - lo) / 4);
    const yTicks = []; for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) yTicks.push(v);
    const refY = Math.min(T + ph, Math.max(T, yAt(ref)));
    const last = S.c[n - 1], up = last >= ref, lastY = yAt(last);

    let g = "";
    // cuadrícula y etiquetas del eje de precio (a la derecha, como Yahoo)
    for (const v of yTicks) g += `<line x1="${L}" x2="${W - R}" y1="${f1(yAt(v))}" y2="${f1(yAt(v))}" class="pxc-grid"/><text x="${W - R + 8}" y="${f1(yAt(v)) + 4}" class="pxc-ytx">${fmtAt(v, step)}</text>`;
    // volumen
    const vmax = Math.max(...S.v, 0);
    if (st.vol && vmax > 0) {
      const bw = Math.max(1, Math.min(8, (pw / n) * 0.7)), vh = ph * 0.16;
      let dv = ""; for (let i = 0; i < n; i++) { if (!S.v[i]) continue; const x = f1(xAt(i)); dv += `M${x} ${T + ph}V${f1(T + ph - (S.v[i] / vmax) * vh)}`; }
      g += `<path d="${dv}" class="pxc-vol" style="stroke-width:${f1(bw)}px"/>`;
    }
    const pts = []; for (let i = 0; i < n; i++) pts.push(`${f1(xAt(i))} ${f1(yAt(S.c[i]))}`);
    const line = "M" + pts.join("L");
    g += `<defs><clipPath id="${uid}a"><rect x="${L}" y="${T}" width="${pw}" height="${Math.max(0, refY - T)}"/></clipPath><clipPath id="${uid}b"><rect x="${L}" y="${refY}" width="${pw}" height="${Math.max(0, T + ph - refY)}"/></clipPath></defs>`;
    if (candle) {
      const bw = Math.max(2, Math.min(10, (is1D && S.bucket ? (pw * S.bucket) / (x1 - x0) : pw / n) * 0.7));
      for (let i = 0; i < n; i++) {
        const x = f1(xAt(i)), col = S.c[i] >= S.o[i] ? "var(--green)" : "var(--red)", yo = yAt(S.o[i]), yc = yAt(S.c[i]);
        g += `<line x1="${x}" x2="${x}" y1="${f1(yAt(S.h[i]))}" y2="${f1(yAt(S.l[i]))}" style="stroke:${col}" stroke-width="1"/><rect x="${f1(x - bw / 2)}" y="${f1(Math.min(yo, yc))}" width="${f1(bw)}" height="${Math.max(1, f1(Math.abs(yo - yc)))}" style="fill:${col}"/>`;
      }
      if (ref >= lo && ref <= hi) g += `<line x1="${L}" x2="${W - R}" y1="${f1(refY)}" y2="${f1(refY)}" class="pxc-ref"/>`;
    } else {
      if (st.type === "area") {
        const area = `M${f1(xAt(0))} ${f1(refY)}L${pts.join("L")}L${f1(xAt(n - 1))} ${f1(refY)}Z`;
        g += `<path d="${area}" clip-path="url(#${uid}a)" class="pxc-fill" style="fill:var(--green)"/><path d="${area}" clip-path="url(#${uid}b)" class="pxc-fill" style="fill:var(--red)"/>`;
      }
      if (ref >= lo && ref <= hi) g += `<line x1="${L}" x2="${W - R}" y1="${f1(refY)}" y2="${f1(refY)}" class="pxc-ref"/>`;
      g += `<path d="${line}" clip-path="url(#${uid}a)" class="pxc-line" style="stroke:var(--green)"/><path d="${line}" clip-path="url(#${uid}b)" class="pxc-line" style="stroke:var(--red)"/>`;
      g += `<circle cx="${f1(xAt(n - 1))}" cy="${f1(lastY)}" r="3.5" style="fill:${up ? "var(--green)" : "var(--red)"}"/>`;
    }
    // etiquetas: último precio (color) y cierre previo (neutra)
    const tag = (y, txt, bg, fg) => `<g><rect x="${W - R + 3}" y="${f1(y - 9)}" width="${R - 6}" height="18" rx="5" style="fill:${bg}"/><text x="${W - R + 3 + (R - 6) / 2}" y="${f1(y) + 4}" text-anchor="middle" class="pxc-tag" style="fill:${fg}">${txt}</text></g>`;
    if (Math.abs(lastY - refY) > 20 && ref >= lo && ref <= hi) g += tag(refY, fmtPriceNum(ref), "var(--text)", "var(--bg1)");
    g += tag(Math.min(T + ph - 9, Math.max(T + 9, lastY)), fmtPriceNum(last), up ? "var(--green)" : "var(--red)", "#fff");
    // eje X
    const lab = (x, txt) => `<text x="${f1(x)}" y="${H - 7}" text-anchor="middle" class="pxc-xtx">${esc(txt)}</text>`;
    if (is1D) {
      const off = d.meta.gmtoffset ?? 0, want = pw < 420 ? 3 : 5, every = [900, 1800, 3600, 7200, 14400].find((e) => (x1 - x0) / e <= want) || 14400; // marcas más finas con zoom
      for (let tt = Math.ceil((x0 + off) / every) * every - off; tt < x1; tt += every) {
        const x = L + ((tt - x0) / (x1 - x0)) * pw; if (x < L + 14 || x > W - R - 14) continue;
        g += lab(x, dtf(tz, { hour: "numeric", minute: "2-digit" }).format(tt * 1000));
      }
    } else {
      const k = pw < 420 ? 4 : 6, kind = st.range === "5D" ? "wd" : (st.range === "5Y" || st.range === "Todo") ? "my" : "dm";
      for (let j = 0; j < k; j++) { const i = Math.round(((j + 0.5) / k) * (n - 1)); g += lab(xAt(i), axisDate(tz, S.t[i] * 1000, kind)); }
    }
    g += `<g class="pxc-xh" style="display:none"><line class="pxc-xhl" y1="${T}" y2="${T + ph}"/><circle r="4.5" class="pxc-xhd"/></g>`;
    svg.innerHTML = g;
    st.geom = { S, n, xs: Array.from({ length: n }, (_, i) => xAt(i)), yAt, ref, W, H, L, R, T, ph, pw, candle, tz, up };
  }

  // cursor: línea vertical + punto + detalle
  function hover(ev) {
    const gm = st.geom; if (!gm) return;
    const r = svg.getBoundingClientRect(), x = ((ev.clientX - r.left) / r.width) * gm.W;
    let lo = 0, hi = gm.n - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (gm.xs[mid] < x) lo = mid; else hi = mid; }
    const i = Math.abs(gm.xs[lo] - x) <= Math.abs(gm.xs[hi] - x) ? lo : hi, S = gm.S;
    const px = gm.xs[i], py = gm.yAt(S.c[i]), xh = svg.querySelector(".pxc-xh");
    xh.style.display = ""; xh.querySelector("line").setAttribute("x1", f1(px)); xh.querySelector("line").setAttribute("x2", f1(px));
    xh.querySelector("circle").setAttribute("cx", f1(px)); xh.querySelector("circle").setAttribute("cy", f1(py));
    const intr = CHART_RANGES[st.range].interval.match(/m$/) && CHART_RANGES[st.range].interval !== "1mo";
    const when = dtf(gm.tz, intr ? { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" }).format(S.t[i] * 1000);
    const chg = S.c[i] / gm.ref - 1;
    tip.innerHTML = `<span class="d">${esc(when)}</span><b>${fmtPriceNum(S.c[i])}</b>` +
      (gm.candle ? `<span class="r">A ${fmtPriceNum(S.o[i])} · Máx ${fmtPriceNum(S.h[i])} · Mín ${fmtPriceNum(S.l[i])}</span>` : "") +
      `<span class="r ${chg >= 0 ? "pos" : "neg"}">${chg >= 0 ? "+" : "−"}${Math.abs(chg * 100).toFixed(2).replace(".", ",")} %${S.v[i] ? ` · Vol ${nfCompact.format(S.v[i])}` : ""}</span>`;
    tip.hidden = false;
    const tw = tip.offsetWidth, left = Math.min(Math.max(px * (r.width / gm.W) + 12, 4), r.width - tw - 4);
    tip.style.transform = `translate(${f1(left)}px, ${f1(Math.max(4, py * (r.height / gm.H) - 54))}px)`;
  }
  const leave = () => { tip.hidden = true; const xh = svg.querySelector(".pxc-xh"); if (xh) xh.style.display = "none"; };
  // ---- zoom: se trabaja en índices de la serie completa (cada punto pesa igual, como el eje X) ----
  const win = () => { const n = st.data.t.length; if (!st.view) return [0, n - 1]; const v = visible(st.data); return v && v.i0 != null ? [v.i0, v.i1] : [0, n - 1]; };
  function setWin(a, b) {
    const n = st.data.t.length, minW = Math.min(n - 1, 10);
    let w = Math.max(minW, b - a);
    if (w >= n - 1) { st.view = null; draw(); return; }
    a = Math.max(0, Math.min(n - 1 - w, a)); b = a + w;
    st.view = { t0: st.data.t[Math.round(a)], t1: st.data.t[Math.round(b)] }; leave(); draw();
  }
  function zoomAt(frac, factor) { // frac: posición 0–1 dentro del área de precio que debe quedar quieta
    if (!st.data) return;
    const [a, b] = win(), w = b - a, c = a + frac * w, nw = w * factor;
    setWin(c - frac * nw, c - frac * nw + nw);
  }
  const fracOf = (clientX) => { const gm = st.geom, r = svg.getBoundingClientRect(); if (!gm) return 0.5; return Math.min(1, Math.max(0, (((clientX - r.left) / r.width) * gm.W - gm.L) / gm.pw)); };
  const sel = $(".pxc-sel");
  const ptrs = new Map();
  let drag = null; // { mode: "select" | "pan" | "pinch", ... }
  svg.addEventListener("pointerdown", (e) => {
    ptrs.set(e.pointerId, e.clientX);
    if (ptrs.size === 2 && st.data) { // pellizco con dos dedos
      const xs = [...ptrs.values()], [a, b] = win();
      drag = { mode: "pinch", d0: Math.max(20, Math.abs(xs[0] - xs[1])), f0: fracOf((xs[0] + xs[1]) / 2), a, b };
      sel.hidden = true; leave(); return;
    }
    if (e.pointerType === "mouse" && e.button === 0 && st.data) drag = { mode: st.view ? "pan" : "select", x0: e.clientX, moved: false, win: win() };
    else if (e.pointerType !== "mouse" && st.view && st.data) drag = { mode: "pan", x0: e.clientX, moved: false, win: win(), touch: true };
    hover(e);
  });
  svg.addEventListener("pointermove", (e) => {
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, e.clientX);
    if (drag?.mode === "pinch" && ptrs.size === 2) {
      const xs = [...ptrs.values()], d = Math.max(20, Math.abs(xs[0] - xs[1])), f = fracOf((xs[0] + xs[1]) / 2);
      const w0 = drag.b - drag.a, c = drag.a + drag.f0 * w0, nw = w0 * (drag.d0 / d);
      setWin(c - f * nw, c - f * nw + nw); return;
    }
    if (drag && (drag.mode === "select" || drag.mode === "pan")) {
      const dx = e.clientX - drag.x0;
      if (!drag.moved && Math.abs(dx) < 6) { hover(e); return; }
      if (!drag.moved) { drag.moved = true; try { svg.setPointerCapture(e.pointerId); } catch (_) { /* sin captura */ } leave(); }
      if (drag.mode === "select") {
        const r = plot.getBoundingClientRect(), x1 = Math.min(drag.x0, e.clientX) - r.left, x2 = Math.max(drag.x0, e.clientX) - r.left;
        sel.hidden = false; sel.style.transform = `translateX(${x1}px)`; sel.style.width = `${x2 - x1}px`;
      } else {
        const gm = st.geom, r = svg.getBoundingClientRect(), [a, b] = drag.win, w = b - a;
        const di = -(dx / r.width) * gm.W / gm.pw * w;
        setWin(a + di, b + di);
      }
      return;
    }
    hover(e);
  });
  const endDrag = (e) => {
    ptrs.delete(e.pointerId);
    if (!drag) return;
    if (drag.mode === "select" && drag.moved) {
      sel.hidden = true;
      const f1x = fracOf(Math.min(drag.x0, e.clientX)), f2x = fracOf(Math.max(drag.x0, e.clientX));
      if (f2x - f1x > 0.02) { const [a, b] = drag.win, w = b - a; setWin(a + f1x * w, a + f2x * w); }
    }
    if (drag.mode !== "pinch" || ptrs.size < 2) drag = null;
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", (e) => { endDrag(e); sel.hidden = true; leave(); });
  svg.addEventListener("pointerleave", (e) => { if (!drag) leave(); });
  svg.addEventListener("dblclick", () => { if (st.view) { st.view = null; draw(); } });
  // pellizco en el trackpad (llega como rueda con Ctrl) y desplazamiento horizontal cuando hay zoom; la rueda normal sigue moviendo la página
  svg.addEventListener("wheel", (e) => {
    if (!st.data) return;
    if (e.ctrlKey) { e.preventDefault(); zoomAt(fracOf(e.clientX), Math.exp(e.deltaY * 0.01)); }
    else if (st.view && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault(); const gm = st.geom, [a, b] = win(), w = b - a; const di = (e.deltaX / gm.pw) * w; setWin(a + di, b + di);
    }
  }, { passive: false });

  async function load({ silent = false, force = false } = {}) {
    const my = ++seq;
    if (!silent) { st.loading = true; if (!st.data) draw(); }
    try {
      const d = await getChart(sym, st.range, { prepost: st.ext, force });
      if (my !== seq || destroyed) return;
      st.data = d; st.error = null; st.offline = d.source === "snapshot";
      if (d.source === "live" && st.range === "1D" && d.meta.regularMarketPrice != null && onQuote) onQuote({ price: d.meta.regularMarketPrice, prev: d.meta.chartPreviousClose, time: d.meta.regularMarketTime, live: true });
    } catch (e) {
      if (my !== seq || destroyed) return;
      if (e.code === "offline" && !st.offline) { st.offline = true; st.range = "6M"; st.loading = false; return load({ silent }); } // sin conexión: pasa a un rango diario
      if (!silent) { st.data = null; st.error = e; }
    }
    st.loading = false; draw();
  }

  root.addEventListener("click", (e) => {
    const r = e.target.closest("[data-r]"), t = e.target.closest("[data-t]"), g = e.target.closest("[data-tg]");
    const z = e.target.closest("[data-z]");
    if (z && !z.disabled) { if (z.dataset.z === "reset") { st.view = null; draw(); } else zoomAt(0.5, z.dataset.z === "in" ? 0.6 : 1 / 0.6); return; }
    if (r && !r.disabled) { st.range = r.dataset.r; st.view = null; savePrefs({ range: st.range, type: st.type, vol: st.vol, ext: st.ext }); st.data = null; load(); }
    else if (t && !t.disabled) { st.type = t.dataset.t; savePrefs({ range: st.range, type: st.type, vol: st.vol, ext: st.ext }); draw(); }
    else if (g) {
      if (g.dataset.tg === "vol") { st.vol = !st.vol; draw(); } else { st.ext = !st.ext; st.view = null; st.data = null; load(); }
      savePrefs({ range: st.range, type: st.type, vol: st.vol, ext: st.ext });
    }
  });
  root.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const r = e.target.closest("[data-r]"); if (!r) return;
    const ks = RANGE_KEYS.filter((k) => !(st.offline && CHART_RANGES[k].intraday)), i = ks.indexOf(r.dataset.r), nx = ks[Math.max(0, Math.min(ks.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)))];
    e.preventDefault(); st.range = nx; st.view = null; st.data = null; load(); setTimeout(() => $(`[data-r="${nx}"]`)?.focus({ preventScroll: true }), 0);
  });

  ro = new ResizeObserver(() => { if (st.data || st.geom) draw(); });
  ro.observe(plot);
  timer = setInterval(() => {
    if (destroyed || !root.isConnected) { api.destroy(); return; }
    if (document.hidden || !isIntraday() || st.data?.source !== "live") return;
    load({ silent: true, force: true });
  }, 30000);
  syncControls(); draw(); load();

  const api = { destroy() { destroyed = true; clearInterval(timer); ro?.disconnect(); } };
  return api;
}
