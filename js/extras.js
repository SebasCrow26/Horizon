// Piezas tipo Yahoo Finance: datos clave del activo, resumen del mercado y noticias.
import { getChart, getQuoteLite, getNews, getDividends } from "./data.js";
import { headlineTone, newsTone } from "./sentiment.js";
import { fmtPriceNum } from "./util.js";
import * as C from "./charts.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const compact = new Intl.NumberFormat("es-CO", { notation: "compact", maximumFractionDigits: 2 });
const fixed = (x, d) => x.toLocaleString("es-CO", { minimumFractionDigits: d, maximumFractionDigits: d });
const pctSigned = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(2).replace(".", ",")} %`;

// ---------- datos clave ----------
function openOf(d) {
  const cp = d.meta.currentTradingPeriod;
  if (!cp?.regular) return null;
  const shift = Math.floor((d.t[0] - (cp.pre?.start ?? cp.regular.start)) / 86400) * 86400;
  const i = d.t.findIndex((t) => t >= cp.regular.start + shift);
  return i >= 0 ? d.o[i] : null;
}
const rangeRow = (label, lo, hi, now) => {
  const pos = hi > lo && now != null ? Math.min(100, Math.max(0, ((now - lo) / (hi - lo)) * 100)) : null;
  return `<div class="ks range"><span class="k">${label}</span><b>${fmtPriceNum(lo)} – ${fmtPriceNum(hi)}</b>${pos != null ? `<div class="rbar" role="img" aria-label="El precio está al ${Math.round(pos)} % de este rango"><i style="left:${pos.toFixed(1)}%"></i></div>` : ""}</div>`;
};

export async function mountKeyStats(el, { sym, series }) {
  let d = null;
  try { d = await getChart(sym, "1D", { prepost: true }); } catch (e) { /* se usan los datos diarios guardados */ }
  if (!el.isConnected) return;
  const rows = [];
  const c = series?.c || [];
  if (d && d.source === "live") {
    const m = d.meta, price = m.regularMarketPrice;
    if (m.chartPreviousClose != null) rows.push(`<div class="ks"><span class="k">Cierre previo</span><b>${fmtPriceNum(m.chartPreviousClose)}</b></div>`);
    const op = openOf(d); if (op != null) rows.push(`<div class="ks"><span class="k">Apertura</span><b>${fmtPriceNum(op)}</b></div>`);
    if (m.regularMarketDayLow != null && m.regularMarketDayHigh != null) rows.push(rangeRow("Rango del día", m.regularMarketDayLow, m.regularMarketDayHigh, price));
    if (m.fiftyTwoWeekLow != null && m.fiftyTwoWeekHigh != null) rows.push(rangeRow("Rango de 52 semanas", m.fiftyTwoWeekLow, m.fiftyTwoWeekHigh, price));
    if (m.regularMarketVolume) rows.push(`<div class="ks"><span class="k">Volumen</span><b>${compact.format(m.regularMarketVolume)}</b></div>`);
  } else if (c.length > 30) { // sin conexión: lo que se puede calcular con los cierres guardados
    const w = c.slice(-252), n = c.length;
    rows.push(`<div class="ks"><span class="k">Cierre previo</span><b>${fmtPriceNum(c[n - 2])}</b></div>`);
    rows.push(rangeRow("Rango de 52 semanas", Math.min(...w), Math.max(...w), c[n - 1]));
  }
  if (!rows.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<section class="glass kstats" aria-label="Datos clave">${rows.join("")}</section>`;
}

// ---------- resumen del mercado ----------
const TILES = [["^GSPC", "S&P 500", 0], ["^IXIC", "Nasdaq", 0], ["^DJI", "Dow Jones", 0], ["COP=X", "Dólar en pesos", 2], ["BTC-USD", "Bitcoin", 0], ["CL=F", "Petróleo", 2], ["GC=F", "Oro", 0]];

export function mountMarket(el) {
  el.innerHTML = `<div class="mk-row" role="list">${TILES.map(([s, n]) => `<a class="mk skeleton-tile" role="listitem" data-s="${esc(s)}" href="#/t/${encodeURIComponent(s)}"><span class="n">${esc(n)}</span><b>&nbsp;</b><span class="c">&nbsp;</span></a>`).join("")}</div>`;
  for (const [s, n, dec] of TILES) {
    getQuoteLite(s).then((q) => {
      const tile = el.querySelector(`[data-s="${CSS.escape(s)}"]`);
      if (!tile) return;
      if (!q || !isFinite(q.price) || !isFinite(q.prev)) { tile.remove(); return; }
      const ch = q.price / q.prev - 1;
      tile.classList.remove("skeleton-tile");
      tile.innerHTML = `<span class="n">${esc(n)}</span><b>${fixed(q.price, dec)}</b><span class="c ${ch >= 0 ? "pos" : "neg"}">${pctSigned(ch)}</span>${q.closes.length > 3 ? C.sparkline(q.closes, { up: ch >= 0 }) : ""}`;
    }).catch(() => el.querySelector(`[data-s="${CSS.escape(s)}"]`)?.remove());
  }
}

// ---------- noticias ----------
const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
function ago(sec) {
  const d = Math.max(0, Date.now() / 1000 - sec);
  if (d < 3600) return rtf.format(-Math.max(1, Math.round(d / 60)), "minute");
  if (d < 86400) return rtf.format(-Math.round(d / 3600), "hour");
  return rtf.format(-Math.round(d / 86400), "day");
}

// Las noticias se cargan al abrir la pantalla: el resumen del tono queda visible y la lista, plegada.
const TONE_TXT = { pos: "Buena noticia", neg: "Mala noticia", neu: "Neutral" };
export function mountNews(el, { sym, onTone } = {}) {
  el.innerHTML = `<section class="glass newscard"><details class="how"><summary>Noticias recientes <span class="news-tone muted">· cargando…</span></summary><div class="news-body" aria-live="polite"></div></details></section>`;
  const body = el.querySelector(".news-body"), toneEl = el.querySelector(".news-tone");
  const load = async () => {
    body.innerHTML = `<p class="muted news-msg">Cargando…</p>`;
    try {
      const items = (await getNews(sym, 8)).map((n) => ({ ...n, tone: headlineTone(n.title) }));
      if (!el.isConnected) return;
      const sum = newsTone(items);
      toneEl.className = "news-tone " + (sum ? sum.tone : "muted");
      toneEl.textContent = sum ? `· tono ${sum.label}` : "· sin noticias";
      onTone?.(sum, items);
      body.innerHTML = items.length
        ? `<ul class="news-list">${items.map((n) => `<li><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer"><span class="t"><i class="tone-dot ${n.tone.tone}" title="${TONE_TXT[n.tone.tone]}" aria-label="${TONE_TXT[n.tone.tone]}"></i>${esc(n.title)}</span><span class="m">${esc(n.publisher || "Yahoo Finance")}${n.time ? " · " + esc(ago(n.time)) : ""}</span></a></li>`).join("")}</ul>
           <p class="news-foot">Titulares de Yahoo Finance. El punto de color es una lectura automática del tono con un diccionario financiero (${sum.pos} buenas, ${sum.neg} malas). Es contexto: no cambia el veredicto, porque no hay un historial gratuito de noticias para comprobar que ayude a predecir.</p>`
        : `<p class="muted news-msg">No hay noticias recientes para este activo.</p>`;
    } catch (e) {
      if (!el.isConnected) return;
      toneEl.className = "news-tone muted"; toneEl.textContent = e.code === "offline" ? "· necesitan conexión" : "· no disponibles";
      onTone?.(null, []);
      body.innerHTML = `<p class="muted news-msg">${esc(e.code === "offline" ? "Las noticias necesitan conexión con Yahoo Finance." : "No se pudieron cargar las noticias.")} <button class="chip" data-retry>Reintentar</button></p>`;
      body.querySelector("[data-retry]")?.addEventListener("click", load);
    }
  };
  load();
}

// ---------- estadísticas del activo calculadas con su historia (como la pestaña "Statistics" de Yahoo) ----------
export async function mountStats(el, { sym, series, beta, currency }) {
  const c = series.c, n = c.length;
  if (n < 60) { el.innerHTML = ""; return; }
  const w = c.slice(-252);
  let peak = w[0], mdd = 0;
  for (const v of w) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
  const r = []; for (let i = 1; i < w.length; i++) r.push(Math.log(w[i] / w[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const vol = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1) * 252);
  const y = new Date(series.t[n - 1] * 1000).getUTCFullYear();
  const iy = series.t.findIndex((t) => new Date(t * 1000).getUTCFullYear() === y);
  const ytd = iy > 0 ? c[n - 1] / c[iy - 1] - 1 : null;
  const row = (k, v, cls = "") => `<div class="ks"><span class="k">${k}</span><b class="${cls}">${v}</b></div>`;
  const pc = (x) => (x == null ? "—" : pctSigned(x).replace(/,(\d)\d/, ",$1"));
  const rows = [
    row("Rendimiento 1 año", pc(c[n - 1] / w[0] - 1), c[n - 1] >= w[0] ? "pos" : "neg"),
    ytd != null ? row("En lo que va del año", pc(ytd), ytd >= 0 ? "pos" : "neg") : "",
    row("Caída máxima (1 año)", pc(mdd), "neg"),
    row("Volatilidad anual", fixed(vol * 100, 0) + " %"),
    beta != null && isFinite(beta) ? row("Beta frente a su mercado", fixed(beta, 2)) : "",
    `<div class="ks" data-div><span class="k">Dividendo (12 meses)</span><b class="muted">…</b></div>`,
  ];
  el.innerHTML = `<section class="glass kstats" aria-label="Estadísticas">${rows.join("")}</section>`;
  const dv = el.querySelector("[data-div] b");
  const d = await getDividends(sym).catch(() => null);
  if (!el.isConnected || !dv) return;
  if (d && d.count && d.price) { dv.className = ""; dv.textContent = `${fmtPriceNum(d.total)} ${currency || ""} · ${fixed(d.total / d.price * 100, 1)} %`; }
  else if (d) { dv.textContent = "No paga"; }
  else el.querySelector("[data-div]").remove();
}
