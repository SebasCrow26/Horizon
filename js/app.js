// Horizon — controlador de la interfaz
import { getSeries, getRates, getUniverse, search, regionOf, REGION_NAMES, loadSnapshot, getIdeas, getSparks, getMovers, getFxToCOP, getTrackRecord } from "./data.js";
import { factorNotes } from "./models/factors.js";
import { journalEntries, journalRecord, journalEvaluate, journalSummary, journalReplace, journalClear, HORIZONS } from "./journal.js";
import { analyzeAll, MODEL_NAMES, WEIGHTS } from "./models/ensemble.js";
import * as C from "./charts.js";
import { fmtPrice, pct, pctPlain } from "./charts.js";
import { spring, project, rubberband, tracker } from "./motion.js";
import { mountPriceChart } from "./pricechart.js";
import { mountKeyStats, mountMarket, mountNews, mountStats } from "./extras.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const view = $("#view");


// ---------- almacenamiento seguro ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem("hz_" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("hz_" + k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } },
};
const DEFAULT_WATCH = ["AAPL", "NVDA", "MSFT", "MELI", "ECOPETROL.CL", "ISA.CL", "ASML.AS", "7203.T", "PETR4.SA", "BTC-USD", "GLD", "TLT"];
const QUICK = [["AAPL", "Apple"], ["NVDA", "Nvidia"], ["ECOPETROL.CL", "Ecopetrol"], ["TSM", "TSMC"], ["PETR4.SA", "Petrobras"], ["BTC-USD", "Bitcoin"], ["SAP.DE", "SAP"], ["0700.HK", "Tencent"]];
const state = { watch: store.get("watch", DEFAULT_WATCH), horizon: store.get("horizon", 63), mode: store.get("mode", "simple"), amount: store.get("amount", 1000000), theme: store.get("theme", matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") };
// Perfil (tolerancia al riesgo y costos de operar) y portafolio: se guardan solo en este dispositivo
state.profile = { risk: "media", commission: 0.5, fxSpread: 1, notify: false, ...store.get("profile", {}) };
state.pfMode = store.get("pfmode", "practice"); // "practice" = simulado (por defecto) · "real"
const PF_KEY = () => (state.pfMode === "practice" ? "portfolio_practice" : "portfolio");
const CLOSED_KEY = () => (state.pfMode === "practice" ? "closed_practice" : "closed");
const PRACTICE_START = 10000000;
state.portfolio = store.get(PF_KEY(), []);
let track = null; // resultados del backtest (data/backtest_report.json)
getTrackRecord().then((t) => { track = t; });
const saveProfile = () => store.set("profile", state.profile);
const savePortfolio = () => store.set(PF_KEY(), state.portfolio);
const practiceCash = () => store.get("practice_cash", store.get("practice_start", PRACTICE_START));
const setPracticeCash = (x) => store.set("practice_cash", Math.round(x));
function setPfMode(m) { state.pfMode = m; store.set("pfmode", m); state.portfolio = store.get(PF_KEY(), []); }

// ---------- tema ----------
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  $("#theme use").setAttribute("href", state.theme === "dark" ? "#i-sun" : "#i-moon");
  $('meta[name="theme-color"]').content = state.theme === "dark" ? "#000000" : "#f2f2f7";
}
$("#theme").addEventListener("click", () => { state.theme = state.theme === "dark" ? "light" : "dark"; store.set("theme", state.theme); applyTheme(); });
applyTheme();

// ---------- análisis con caché ----------
let ratesP = null;
const getRatesOnce = () => (ratesP ||= getRates());
const cache = new Map();
const tick = () => new Promise((r) => setTimeout(r, 0));

// Los modelos (máxima verosimilitud + 20.000 escenarios) tardan cientos de milisegundos: se calculan en
// un hilo aparte para que la pantalla siga respondiendo. Si el navegador no los permite, se calcula aquí.
const POOL = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
let workers = null, workerId = 0, workersBroken = false;
const pendingJobs = new Map();
function startWorkers() {
  if (workers) return workers;
  workers = [];
  if (typeof Worker === "undefined") return workers;
  try {
    for (let i = 0; i < POOL; i++) {
      const w = new Worker(new URL("./analysis-worker.js", import.meta.url), { type: "module" });
      w.busy = 0;
      w.onmessage = (e) => {
        const { id, result, error } = e.data, job = pendingJobs.get(id);
        if (!job) return;
        pendingJobs.delete(id); w.busy--;
        error ? job.reject(new Error(error)) : job.resolve(result);
      };
      w.onerror = () => { // el worker no cargó: lo pendiente se calcula aquí y se deja de usar
        workersBroken = true;
        for (const [id, job] of pendingJobs) { pendingJobs.delete(id); try { job.resolve(analyzeAll(job.args)); } catch (err) { job.reject(err); } }
      };
      workers.push(w);
    }
  } catch (e) { workers = []; }
  return workers;
}
function runAnalysis(args) {
  const ws = startWorkers();
  if (!ws.length || workersBroken) return Promise.resolve().then(() => analyzeAll(args));
  const w = ws.reduce((a, b) => (a.busy <= b.busy ? a : b));
  return new Promise((resolve, reject) => { const id = ++workerId; pendingJobs.set(id, { resolve, reject, args }); w.busy++; w.postMessage({ id, args }); });
}
// Procesa una lista con hasta `limit` tareas a la vez
async function mapLimit(items, limit, fn) {
  const it = items[Symbol.iterator]();
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { for (let r = it.next(); !r.done; r = it.next()) await fn(r.value); }));
}

function analyze(sym) {
  const key = sym + "|" + state.horizon;
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    const [series, rates] = await Promise.all([getSeries(sym), getRatesOnce()]);
    const region = regionOf(sym);
    const universe = await getUniverse(region, sym);
    const a = await runAnalysis({ series, rates, universe, region, horizonDays: state.horizon });
    a.series = series; a.region = region;
    setStatus(series);
    try { journalRecord(a); } catch (e) { /* el diario nunca debe romper el análisis */ }
    return a;
  })();
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}

function setStatus(series) {
  const el = $("#status");
  const live = series.source === "live";
  el.classList.toggle("snap", !live);
  const d = new Date((series.t[series.t.length - 1]) * 1000).toLocaleDateString("es-CO", { timeZone: "UTC", day: "numeric", month: "short" });
  $("span", el).textContent = live ? "Yahoo Finance · en vivo" : `Datos guardados · ${d}`;
  el.title = live ? "Datos descargados ahora desde Yahoo Finance" : "Sin conexión con Yahoo: se usan datos reales guardados al compilar la aplicación";
}

// ---------- utilidades de interfaz ----------
const ico = (n, cls = "") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const verdictChip = (v) => `<span class="verdict ${v.tone}">${esc(v.label)}</span>`;
const sigColor = (s) => (s >= 0.1 ? "var(--green)" : s > -0.1 ? "var(--orange)" : "var(--red)"); // verde sube · naranja neutral · rojo baja
const money = (x, cur) => `${fmtPrice(x)}${cur ? ` <span class="faint" style="font-size:.5em;font-weight:600">${esc(cur)}</span>` : ""}`;
const dayChange = (s) => { const c = s.c, n = c.length; return c[n - 1] / c[n - 2] - 1; };

function countUp(root = document) {
  for (const el of $$("[data-to]", root)) {
    const to = parseFloat(el.dataset.to), dec = +(el.dataset.dec || 0), suf = el.dataset.suf || "";
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = to.toFixed(dec).replace(".", ",") + suf; continue; }
    const t0 = performance.now(), dur = 900;
    const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = (to * e).toFixed(dec).replace(".", ",") + suf; if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
}

// ---------- barra de navegación ----------
function updateNav(route) {
  const nav = $("#nav"), ind = $(".ind", nav);
  const r = route === "detail" ? "home" : route;
  $$("a", nav).forEach((a) => a.classList.toggle("on", a.dataset.r === r));
  $$("#tabbar a").forEach((a) => a.classList.toggle("on", a.dataset.r === r));
  moveInd(nav, "nav");
}
addEventListener("resize", () => updateNav(currentRoute));

// ---------- buscador ----------
function searchBox() {
  return `<div class="search" role="search">
    <div class="field glass">${ico("search")}<input id="q" type="search" maxlength="40" placeholder="Busca cualquier acción del mundo: Apple, Ecopetrol, 7203.T, BTC-USD…" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="search" aria-label="Buscar un activo" aria-controls="sg"><button class="go" id="go">Analizar</button></div>
    <div class="suggest glass" id="sg" role="listbox"></div>
  </div>
  <div class="quick">${QUICK.map(([s, n]) => `<button class="chip" data-go="${esc(s)}">${esc(n)}</button>`).join("")}</div>`;
}
function bindSearch() {
  const q = $("#q"), sg = $("#sg");
  if (!q) return;
  let timer = 0, items = [], hl = -1, seq = 0;
  const close = () => { sg.classList.remove("open"); hl = -1; };
  const paint = () => {
    sg.innerHTML = items.map((x, i) => `<button role="option" data-sym="${esc(x.sym)}" class="${i === hl ? "hl" : ""}" title="${esc(x.name)}"><span class="sym">${esc(x.sym)}</span><span class="nmx"><span class="nm">${esc(x.name)}</span>${x.ex ? `<span class="ex">${esc(x.ex)}</span>` : ""}</span></button>`).join("");
    sg.classList.toggle("open", items.length > 0);
  };
  q.addEventListener("input", () => {
    clearTimeout(timer);
    const v = q.value;
    if (v.trim().length < 2) { close(); return; }
    timer = setTimeout(async () => { const my = ++seq; const r = await search(v); if (my !== seq) return; items = r; hl = -1; paint(); }, 220);
  });
  q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); hl = Math.min(items.length - 1, hl + 1); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); hl = Math.max(0, hl - 1); paint(); }
    else if (e.key === "Escape") close();
    else if (e.key === "Enter") { e.preventDefault(); go(hl >= 0 ? items[hl].sym : q.value); }
  });
  sg.addEventListener("click", (e) => { const b = e.target.closest("[data-sym]"); if (b) go(b.dataset.sym); });
  $("#go").addEventListener("click", () => go(q.value));
  document.addEventListener("click", (e) => { if (!e.target.closest(".search")) close(); }, { once: false });
  function go(s) { s = (s || "").trim().toUpperCase().replace(/\s+/g, ""); if (s) location.hash = "#/t/" + encodeURIComponent(s); }
}

// ---------- vistas ----------
let currentRoute = "home";
let pxc = null; // gráfico de precio de la pantalla de detalle (se destruye al salir)
let routeToken = 0; // identifica la pantalla vigente: las cargas antiguas no deben dibujar sobre la nueva

function disclaimer() {
  return `<div class="disclaimer">${ico("info", "")} <b>Herramienta educativa, no asesoría financiera.</b>
    <details class="how"><summary>Más información</summary><p>Las probabilidades y recomendaciones salen de modelos matemáticos aplicados a datos históricos de Yahoo Finance; no garantizan resultados. Ningún modelo predice el futuro: úsalos para ordenar tu análisis y gestionar el riesgo, y nunca inviertas más de lo que puedas perder.</p></details></div>`;
}

// ----- Resumen -----
function renderHome() {
  currentRoute = "home"; updateNav("home");
  const snapName = (s) => snapCache?.series?.[s]?.n || "";
  view.innerHTML = `
    <section class="hero rise">
      <div class="eyebrow">Tendencia, riesgo y un plan</div>
      <h1 class="title">¿En qué <em>invertir</em> hoy?</h1>
      ${searchBox()}
    </section>
    <div id="brief"></div>
    <h2 class="sec">Mercados hoy <small>toca uno para ver su análisis</small></h2>
    <div id="market"></div>
    <div id="top"></div>
    <h2 class="sec">Mi lista <small>${state.watch.length ? `${state.watch.length} activo${state.watch.length === 1 ? "" : "s"} · <a href="#/ranking" class="lnk">ordenar por señal</a>` : "Aún no tienes activos"}</small></h2>
    <div class="wl" id="wl">${state.watch.map((s, i) => wlRow(s, snapName(s), i)).join("")}
      <button class="wl-add interactive" data-focus-search>${ico("plus")}Agregar un activo</button>
    </div>${disclaimer()}`;
  bindSearch();
  mountMarket($("#market"));
  const my = routeToken;
  // 1) precios al instante (una sola petición para toda la lista); 2) veredictos a medida que se calculan
  getSparks(state.watch).then((q) => { if (my === routeToken) for (const s of state.watch) if (q[s]) fillPrice(s, q[s]); }).catch(() => {});
  const results = [];
  const syms = [...new Set([...state.watch, ...state.portfolio.map((h) => h.sym)])];
  mapLimit(syms, 3, async (sym) => {
    if (my !== routeToken) return;
    try { const a = await analyze(sym); if (my !== routeToken) return; if (state.watch.includes(sym)) { results.push(a); fillRow(sym, a); renderTop(results); } }
    catch (e) { if (my !== routeToken) return; failRow(sym, e); }
  }).then(() => { if (my === routeToken) renderBrief(); });
}

let snapCache = null;
const spark = (closes, up) => (closes && closes.length > 3 ? C.sparkline(closes, { up, w: 72, h: 30 }) : "");
function wlRow(sym, name, i) {
  return `<div class="wl-r interactive rise" style="--i:${Math.min(i, 12)}" data-row="${esc(sym)}" data-href="#/t/${encodeURIComponent(sym)}">
    <div class="wl-id"><b>${esc(sym)}</b><span class="nm">${esc(name || " ")}</span><span class="wl-v"><span class="skeleton" style="width:90px;height:11px;display:inline-block"></span></span></div>
    <div class="wl-sp"></div>
    <div class="wl-px"><b>&nbsp;</b><span class="pill">&nbsp;</span></div>
    <button class="rm" data-rm="${esc(sym)}" aria-label="Quitar ${esc(sym)} de mi lista">×</button></div>`;
}
function fillPrice(sym, q) {
  const el = $(`[data-row="${CSS.escape(sym)}"]`); if (!el || !isFinite(q.price)) return;
  const ch = q.prev ? q.price / q.prev - 1 : 0;
  $(".wl-px", el).innerHTML = `<b>${fmtPrice(q.price)}</b><span class="pill ${ch >= 0 ? "pos" : "neg"}">${pct(ch, 2)}</span>`;
  $(".wl-sp", el).innerHTML = spark(q.closes, ch >= 0);
}
function fillRow(sym, a) {
  const el = $(`[data-row="${CSS.escape(sym)}"]`); if (!el) return;
  $(".nm", el).textContent = a.name; $(".nm", el).title = a.name;
  $(".wl-v", el).innerHTML = `${verdictChip(a.verdict)}<span class="faint"> · sube ${Math.round(a.probUp * 10)} de 10</span>`;
  if (!$(".wl-px b", el).textContent.trim()) { const ch = dayChange(a.series); fillPrice(sym, { price: a.S0, prev: a.S0 / (1 + ch), closes: a.series.c.slice(-30) }); }
}
function failRow(sym, e) {
  const el = $(`[data-row="${CSS.escape(sym)}"]`); if (!el) return;
  $(".wl-v", el).innerHTML = `<span class="faint" title="${esc(e.message)}">Sin datos por ahora</span>`;
}

// "Hoy en tu lista": cambios de veredicto desde tu última visita, avisos del portafolio y lo que más se movió
async function renderBrief() {
  const box = $("#brief"); if (!box) return;
  const now = {};
  const done = [];
  for (const sym of state.watch) { const p = cache.get(sym + "|" + state.horizon); if (!p) continue; try { const a = await p; now[sym] = a.verdict.key; done.push(a); } catch (e) { /* sin datos */ } }
  const vh = store.get("vhist", { cur: {}, prev: {}, curAt: 0, prevAt: 0 });
  const differs = Object.keys(now).some((k) => vh.cur[k] !== now[k]);
  if (differs) { if (Object.keys(vh.cur).length) { vh.prev = vh.cur; vh.prevAt = vh.curAt; } vh.cur = now; vh.curAt = Date.now(); store.set("vhist", vh); }
  const lines = [];
  const alerts = await portfolioAlerts();
  for (const al of alerts) lines.push({ cls: al.level, ico: al.level === "neg" ? "shield" : "bell", html: al.html, href: "#/portafolio" });
  for (const a of done) {
    const before = vh.prev[a.symbol];
    if (before && before !== now[a.symbol] && vh.prevAt) lines.push({ cls: "", ico: "chart", html: `<b>${esc(a.symbol)}</b> pasó de ${esc(LABEL[before] || before)} a <b class="${a.verdict.tone}">${esc(a.verdict.label)}</b>`, href: "#/t/" + encodeURIComponent(a.symbol) });
  }
  const movers = done.map((a) => ({ a, ch: dayChange(a.series) })).sort((x, y) => Math.abs(y.ch) - Math.abs(x.ch));
  if (movers[0] && Math.abs(movers[0].ch) >= 0.015) { const m = movers[0]; lines.push({ cls: "", ico: "chart", html: `<b>${esc(m.a.symbol)}</b> es la que más se mueve de tu lista: <span class="${m.ch >= 0 ? "pos" : "neg"}">${pct(m.ch, 1)}</span>`, href: "#/t/" + encodeURIComponent(m.a.symbol) }); }
  const buys = done.filter((a) => a.verdict.key === "buy").map((a) => a.symbol);
  if (buys.length) lines.push({ cls: "", ico: "trophy", html: `Con tendencia fuerte hoy: <b>${buys.slice(0, 4).map(esc).join(", ")}</b>`, href: "#/ranking" });
  if (!lines.length) lines.push({ cls: "", ico: "info", html: "Sin cambios importantes en tu lista desde tu última visita." });
  const jn = journalEntries().length;
  if (jn) lines.push({ cls: "", ico: "chart", html: `Diario: ${jn} veredicto${jn === 1 ? "" : "s"} anotado${jn === 1 ? "" : "s"} para revisar si Horizon acierta`, href: "#/diario" });
  notifyAlerts(alerts);
  box.innerHTML = `<h2 class="sec">Hoy en tu lista <small>${new Date().toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long" })}</small></h2>
    <div class="brief glass rise">${lines.slice(0, 5).map((l) => `<${l.href ? `a href="${l.href}"` : "div"} class="br-l ${l.cls}">${ico(l.ico)}<span>${l.html}</span></${l.href ? "a" : "div"}>`).join("")}</div>`;
}
const LABEL = { buy: "Comprar", accumulate: "Comprar de a poco", hold: "Esperar", reduce: "Vender una parte", sell: "Vender" };

function skeletonCard(sym, i) {
  return `<div class="glass stock rise" style="--i:${i}" data-card="${esc(sym)}"><div class="top"><div><div class="sym">${esc(sym)}</div><div class="skeleton" style="width:130px;height:14px;margin-top:6px"></div></div></div><div class="skeleton" style="width:150px;height:30px"></div><div class="skeleton" style="width:100%;height:38px;margin-top:auto"></div></div>`;
}
function fillCard(sym, a) {
  const el = $(`[data-card="${CSS.escape(sym)}"]`);
  if (!el) return;
  const ch = dayChange(a.series);
  el.className = "glass stock interactive";
  el.dataset.href = "#/t/" + encodeURIComponent(sym);
  el.innerHTML = `<button class="rm" data-rm="${esc(sym)}" aria-label="Quitar ${esc(sym)} de mi lista">×</button>
    <div class="top"><div><div class="sym">${esc(sym)}</div><div class="nm" title="${esc(a.name)}">${esc(a.name)}</div></div>${verdictChip(a.verdict)}</div>
    <div class="row" style="justify-content:space-between;align-items:flex-end"><div><div class="px">${money(a.S0, a.currency)}</div><div class="chg ${ch >= 0 ? "pos" : "neg"}">${pct(ch, 2)} hoy</div></div>${C.sparkline(a.series.c, { up: a.series.c[a.series.c.length - 1] >= a.series.c[Math.max(0, a.series.c.length - 60)] })}</div>
    <div class="foot">${C.gauge(a.score, true)}<span class="muted" style="font-size:13px;font-weight:600">Sube <b style="color:var(--text)">${Math.round(a.probUp * 10)} de 10</b> veces</span></div>`;
}
function failCard(sym, e) {
  const el = $(`[data-card="${CSS.escape(sym)}"]`);
  if (!el) return;
  el.className = "glass stock";
  el.innerHTML = `<div class="top"><div><div class="sym">${esc(sym)}</div><div class="nm">Sin datos</div></div></div><p class="muted" style="font-size:13px">${esc(e.message)}</p><button class="chip" data-rm="${esc(sym)}">Quitar de mi lista</button>`;
}
function renderTop(results) {
  if (!results.length) return;
  const rank = (a) => ({ buy: 4, accumulate: a.verdict.cautious ? 2 : 3, hold: 1, reduce: 0, sell: -1 }[a.verdict.key] ?? 0);
  const best = [...results].sort((a, b) => rank(b) - rank(a) || b.score - a.score)[0];
  const hist = track?.byVerdict?.find((x) => x.key === best.verdict.key);
  const box = $("#top");
  if (!box) return;
  box.innerHTML = `<h2 class="sec">La más recomendada de tu lista <small>la de tendencia más fuerte, con el riesgo medido por los 5 modelos</small></h2>
    <div class="glass card interactive hero-card rise" data-href="#/t/${encodeURIComponent(best.symbol)}">
      <div><div class="eyebrow">${esc(best.symbol)} · ${esc(best.name)}</div>
        <div class="big ${best.verdict.tone}">${esc(best.verdict.label)}</div>
        <p class="explain">${esc(GUIDE[best.verdict.key][1](best))}</p>${C.gauge(best.score)}</div>
      <div class="kpis">${kpi("Probabilidad de subir", pctPlain(best.probUp), `en ${best.horizonDays} días`)}${kpi("Rango probable", `${fmtPrice(best.range.lo)} – ${fmtPrice(best.range.hi)}`, "1 de cada 10 queda fuera")}${kpi("Límite de pérdida", fmtPrice(best.stop), pct(best.downside))}${kpi("Historial de la señal", hist ? `${Math.round(hist.hit * 100)} de 100` : "—", hist ? "veces subió en 3 meses" : "")}</div>
    </div>`;
}
const kpi = (k, v, s = "") => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;

// ----- Descubrir: los 5 modelos aplicados a ~100 activos de todo el mundo (precalculado) -----
const DISC_REGIONS = [["all", "Todos"], ["US", "EE. UU."], ["CO", "Colombia"], ["LATAM", "Latinoamérica"], ["EU", "Europa"], ["ASIA", "Asia"], ["CRYPTO", "Cripto"]];
let discRegion = "all", discAll = false;
async function renderDescubrir() {
  currentRoute = "descubrir"; updateNav("descubrir");
  view.innerHTML = `<section class="hero rise"><div class="eyebrow">Oportunidades</div><h1 class="title">Descubrir</h1><p class="lead">Lo que más se mueve hoy y unos 100 activos del mundo ordenados de la mejor a la peor señal de Horizon.</p></section>
    <h2 class="sec">Lo que más se mueve hoy <small id="mv-src">Estados Unidos</small></h2>
    <div class="chips-row" id="mv-k"><button class="chip on" data-mv="gainers">Suben</button><button class="chip" data-mv="losers">Bajan</button></div>
    <div class="wl" id="movers"><div class="skeleton" style="height:120px;border-radius:18px"></div></div>
    <h2 class="sec">Ranking de los modelos</h2>
    <div id="disc"><div class="skeleton" style="height:70px;border-radius:18px"></div></div>${disclaimer()}`;
  const loadMovers = async (kind) => {
    const my2 = routeToken;
    const m = await getMovers(kind, 6).catch(() => ({ items: [] }));
    if (my2 !== routeToken || !$("#movers")) return;
    $("#mv-src").textContent = m.source === "live" ? "acciones de EE. UU. · Yahoo Finance" : "entre los activos guardados";
    $("#movers").innerHTML = m.items.length ? m.items.map((x) => `<a class="wl-r interactive" href="#/t/${encodeURIComponent(x.sym)}"><div class="wl-id"><b>${esc(x.sym)}</b><span class="nm">${esc(x.name)}</span></div><div class="wl-px"><b>${fmtPrice(x.price)}</b><span class="pill ${x.ch >= 0 ? "pos" : "neg"}">${pct(x.ch, 2)}</span></div></a>`).join("") : `<p class="muted" style="padding:1rem">No disponible ahora.</p>`;
  };
  loadMovers("gainers");
  $("#mv-k").addEventListener("click", (e) => { const b = e.target.closest("[data-mv]"); if (!b) return; $$("#mv-k .chip").forEach((x) => x.classList.toggle("on", x === b)); loadMovers(b.dataset.mv); });
  const my = routeToken;
  let ideas;
  try { ideas = await getIdeas(); } catch (e) {
    if (my !== routeToken) return;
    $("#disc").innerHTML = `<div class="glass card"><p>No se pudo cargar la lista.</p><button class="chip" id="disc-retry" style="margin-top:.75rem">Reintentar</button></div>`;
    $("#disc-retry")?.addEventListener("click", () => renderDescubrir());
    return;
  }
  if (my !== routeToken) return;
  const asOf = new Date(ideas.generated).toLocaleDateString("es-CO", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
  const draw = () => {
    const list = ideas.items.filter((i) => discRegion === "all" || i.region === discRegion);
    const shown = discAll ? list : list.slice(0, 12);
    $("#disc").innerHTML = `<div class="chips-row" role="group" aria-label="Región">${DISC_REGIONS.map(([k, t]) => `<button class="chip ${k === discRegion ? "on" : ""}" data-reg="${k}">${t}</button>`).join("")}</div>
      <div class="rank" id="disc-list">${list.length ? `<div class="r h"><span>#</span><span>Activo</span><span class="hide-m">Veredicto</span><span class="hide-m">Señal</span><span class="num hide-m">Sube</span><span class="num hide-m">Objetivo</span><span class="num hide-m">Riesgo</span></div>` +
        shown.map((a, i) => `<div class="r glass interactive" data-href="#/t/${encodeURIComponent(a.sym)}"><span class="n">${i + 1}</span>
        <span class="nm"><b>${esc(a.sym)}</b><span>${esc(a.name)}</span></span><span>${verdictChip(a)}</span><span class="hide-m">${C.gauge(a.score, true)}</span>
        <span class="num hide-m">${Math.round(a.probUp * 10)} de 10</span><span class="num hide-m ${a.upside >= 0 ? "pos" : "neg"}">${pct(a.upside, 0)}</span><span class="num hide-m ${a.risk === "alto" ? "neg" : a.risk === "medio" ? "" : "pos"}">${a.risk}</span></div>`).join("") : `<div class="rank-empty"><p>No hay activos en esta región.</p></div>`}</div>
      ${list.length > 12 ? `<button class="chip disc-more" id="disc-more">${discAll ? "Ver menos" : `Ver los ${list.length}`}</button>` : ""}
      <p class="disc-note">Cálculo a ${Math.round(ideas.horizonDays / 21)} meses con los datos del ${asOf}${(Date.now() - Date.parse(ideas.generated)) / 86400e3 > 3 ? ` (hace ${Math.round((Date.now() - Date.parse(ideas.generated)) / 86400e3)} días: puede estar desactualizado)` : ""}. Toca un activo para verlo con datos de hoy. No es una recomendación personalizada.</p>`;
    $("#disc").querySelectorAll("[data-reg]").forEach((b) => b.addEventListener("click", () => { discRegion = b.dataset.reg; discAll = false; draw(); }));
    $("#disc-more")?.addEventListener("click", () => { discAll = !discAll; draw(); });
  };
  draw();
}

// ----- Ranking -----
async function renderRanking() {
  currentRoute = "ranking"; updateNav("ranking");
  view.innerHTML = `<section class="hero rise"><div class="eyebrow">Comparador</div><h1 class="title">El <em>ranking</em> de tu lista</h1><p class="lead">Ordenado por la señal de tendencia, de la más fuerte a la más débil. El rango y el riesgo salen de los 5 modelos.</p></section>
    <div class="rank" id="rank"><div class="skeleton" style="height:70px;border-radius:24px"></div></div>${disclaimer()}`;
  const my = routeToken;
  if (!state.watch.length) {
    $("#rank").innerHTML = `<div class="rank-empty"><p>Tu lista está vacía.</p><p class="muted">Agrega un activo para ver aquí cómo se compara con los demás.</p><a class="chip" href="#/">Agregar un activo</a></div>`;
    return;
  }
  const out = [], failed = [];
  await mapLimit(state.watch, 3, async (sym) => {
    if (my !== routeToken) return;
    try { out.push(await analyze(sym)); } catch (e) { failed.push({ sym, msg: e.message }); }
  });
  if (my !== routeToken) return;
  failed.sort((a, b) => state.watch.indexOf(a.sym) - state.watch.indexOf(b.sym));
  out.sort((a, b) => b.score - a.score);
  // los activos sin datos no desaparecen: quedan al final con su motivo y llevan al detalle para reintentar
  const failedRows = failed.map((f) => `<div class="r glass interactive failed" data-href="#/t/${encodeURIComponent(f.sym)}" title="${esc(f.msg)}"><span class="n">–</span>
        <span class="nm"><b>${esc(f.sym)}</b><span>Sin datos por ahora · toca para reintentar</span></span><span class="muted">Sin veredicto</span></div>`).join("");
  $("#rank").innerHTML = out.length
    ? `<div class="r h"><span>#</span><span>Activo</span><span class="hide-m">Veredicto</span><span class="hide-m">Señal</span><span class="num hide-m">Sube</span><span class="num hide-m">Rango ${state.horizon} días</span><span class="num hide-m">Riesgo</span></div>` +
      out.map((a, i) => `<div class="r glass interactive rise" style="--i:${i}" data-href="#/t/${encodeURIComponent(a.symbol)}"><span class="n">${i + 1}</span>
        <span class="nm"><b>${esc(a.symbol)}</b><span>${esc(a.name)}</span></span><span>${verdictChip(a.verdict)}</span><span class="hide-m">${C.gauge(a.score, true)}</span>
        <span class="num hide-m">${pctPlain(a.probUp)}</span><span class="num hide-m">${fmtPrice(a.range.lo)} – ${fmtPrice(a.range.hi)}</span><span class="num hide-m ${a.riskLevel === "alto" ? "neg" : a.riskLevel === "medio" ? "" : "pos"}">${a.riskLevel}</span></div>`).join("")
    : "";
  if (!out.length) $("#rank").innerHTML = `<div class="rank-empty"><p>No se pudo analizar ningún activo de tu lista.</p><p class="muted">Revisa tu conexión y vuelve a intentarlo.</p><button class="chip" id="rk-retry">Reintentar</button></div>` + failedRows;
  else $("#rank").insertAdjacentHTML("beforeend", failedRows);
  $("#rk-retry")?.addEventListener("click", () => renderRanking());
}

// ----- Detalle -----
function summaryText(a) {
  const v = a.verdict.key, H = a.horizonDays;
  const base = `Probabilidad de subir en ${H} días: ${pctPlain(a.probUp)}; rango probable entre ${fmtPrice(a.range.lo)} y ${fmtPrice(a.range.hi)}.`;
  if (v === "buy") return `La tendencia es fuerte: le va mejor que a la mayoría de su mercado. ${base} Objetivo ${fmtPrice(a.target)} (${pct(a.upside)}) con un piso de protección en ${fmtPrice(a.stop)}.`;
  if (v === "accumulate") return `La tendencia está a favor, sin ser contundente${a.verdict.cautious ? ", pero el riesgo de caída brusca es alto: conviene entrar por etapas" : ", mejor por etapas"}. ${base} Objetivo ${fmtPrice(a.target)} y piso en ${fmtPrice(a.stop)}.`;
  if (v === "hold") return `La tendencia no da una ventaja clara. Si aún no la tienes, espera un precio de ${fmtPrice(a.priceBuy)} o menos; si ya la tienes, mantén con un piso en ${fmtPrice(a.stop)}. ${base}`;
  if (v === "reduce") return `La tendencia se debilitó: le va peor que a su mercado. Considera reducir la posición y proteger ganancias. ${base} Piso de protección: ${fmtPrice(a.stop)}.`;
  return `La tendencia está claramente en contra. Si la tienes, es momento de vender o proteger fuertemente; si no, evítala por ahora. ${base}`;
}

const MODEL_ICONS = { merton: "bolt", meanrev: "wave", realoptions: "tree", vasicek: "rate", herding: "crowd", gbm: "chart", bs: "shield", kou: "bolt", fractal: "wave" };
const TAB_ORDER = ["merton", "meanrev", "realoptions", "vasicek", "herding", "gbm", "bs", "kou", "fractal"];
const EXTRA_NAMES = { gbm: "Browniano geométrico (GBM)", bs: "Black–Scholes", kou: "Saltos de Kou", fractal: "Fractales y browniano fraccional" };
const modelName = (k) => MODEL_NAMES[k] || EXTRA_NAMES[k];
const modelOf = (a, k) => a.models[k] || a.extras?.[k] || { signal: 0, confidence: 0, available: false, headline: "No disponible", detail: "" };
const TAB_SHORT = { merton: "Merton", meanrev: "Reversión", realoptions: "Opciones", vasicek: "Vasicek", herding: "Manada", gbm: "GBM", bs: "Black–Scholes", kou: "Kou", fractal: "Fractal" }; // nombres cortos: en el celular caben los 5 modelos a la vez


// ----- Guía para principiantes: todo en palabras simples y en pesos, no en porcentajes ni jerga -----
const horizonLabel = (d) => (d === 21 ? "1 mes" : d === 63 ? "3 meses" : d === 126 ? "6 meses" : `${d} días`);
const money0 = (x) => "$" + Math.abs(Math.round(x)).toLocaleString("es-CO");
const signedMoney = (x) => (Math.round(x) === 0 ? "" : x < 0 ? "−" : "+") + money0(x);
const GUIDE = {
  buy: ["Buen momento para comprar", () => "Viene subiendo más que su mercado y el riesgo está controlado. Aun así, entra por partes."],
  accumulate: ["Compra de a poco", (a) => `La tendencia está a favor, pero no es contundente: entra por partes.${a.verdict.cautious ? " Su precio puede caer fuerte: usa solo dinero que no necesites pronto." : ""}`],
  hold: ["Espera: hoy no hay ventaja clara", () => "La tendencia no es ni buena ni mala. Si ya la tienes, mantén con tu límite de pérdida."],
  reduce: ["Considera vender una parte", () => "Viene peor que su mercado. Si la tienes, protege lo que llevas."],
  sell: ["Mejor no comprarla ahora", () => "La tendencia está claramente en contra. Si la tienes, considera salir."],
};
const GLOSSARY = [
  ["Veredicto", "La recomendación final: la tendencia dice la dirección y los 5 modelos ponen los precios y el riesgo."],
  ["Probabilidad de subir", "De cada 10 veces que se repitiera una situación parecida, en cuántas el precio terminaría más alto que hoy. No es una promesa."],
  ["Peores y mejores 1 de 10", "Casi siempre el resultado queda entre ambos extremos. Una de cada diez veces puede ser peor o mejor."],
  ["Piso de protección", "Precio al que conviene salir si las cosas van mal, para no perder más. Es tu límite de pérdida."],
  ["Comprar de a poco", "Dividir tu dinero en partes y comprar en distintos momentos, para no apostar todo a un solo precio."],
  ["Tendencia (momentum)", "Lo que viene subiendo más que los demás durante el último año suele seguir haciéndolo unos meses. Es de los efectos más estudiados en finanzas, aunque falla a veces."],
  ["Costos", "Comisión del comisionista y diferencia del cambio de pesos a dólares. Se pagan al comprar y otra vez al vender."],
  ["Acción, fondo (ETF), criptomoneda", "Cosas que se compran y venden en mercados. Una acción es un pedacito de una empresa; un ETF es una canasta de muchas."],
];
const isCrypto = (a) => a.region === "CRYPTO";
// Costo de ida y vuelta (comprar y vender) como fracción: comisión ×2 y, si no es en pesos, el cambio de moneda ×2
const roundTrip = (a) => 2 * ((+state.profile.commission || 0) + (a.currency && a.currency !== "COP" ? (+state.profile.fxSpread || 0) : 0)) / 100;
const net = (p, rt) => (1 + p) * (1 - rt) - 1;
function scenarioRows(a, amount) {
  const rt = roundTrip(a);
  // extremos: rango de Merton (calibrado en el backtest); centro: lo que rindió en promedio este veredicto en el backtest
  const hist = track?.byVerdict?.find((x) => x.key === a.verdict.key);
  const mid = hist ? Math.expm1(Math.log1p(hist.mean) * a.horizonDays / 63) : a.upside;
  const bad = net(a.range.lo / a.S0 - 1, rt), good = net(a.range.hi / a.S0 - 1, rt), obj = net(Math.min(Math.max(mid, a.range.lo / a.S0 - 1), a.range.hi / a.S0 - 1), rt);
  const row = (cls, t, p) => `<div class="sc ${cls}"><span>${t}</span><b>${signedMoney(amount * p)}</b><i>${pct(p, 0)}</i></div>`;
  return row("bad", "Si va mal", bad) + row("mid", hist ? "Lo típico" : "Lo esperable", obj) + row("good", "Si va bien", good) +
    (hist && obj <= 0 && mid > 0 ? `<p class="g-warn">Con estos costos (≈ ${pctPlain(rt, 1)} entre comprar y vender) la ganancia típica desaparece. Conviene buscar comisiones más bajas u operar menos veces con montos más grandes.</p>` : "") +
    `<p class="g-cap">${rt > 0 && !(hist && obj <= 0 && mid > 0) ? `Ya descuenta costos de comprar y vender (≈ ${pctPlain(rt, 1)}, ${money0(amount * rt)}). ` : ""}“Mal” y “bien” son los extremos: pasan 1 de cada 10 veces.${hist ? ` “Lo típico” es lo que rindió en promedio esta señal en la prueba de 10 años.` : ""}</p>`;
}

// Plan concreto a partir de lo que calculan los modelos: por partes, límite de pérdida, zona de ganancia y fecha de revisión
function buildPlan(a, amount) {
  const H = a.horizonDays, S0 = a.S0, sig = a.models.merton.totalVolYear * Math.sqrt(H / 252);
  const dip = Math.max(a.stop * 1.04, S0 * (1 - 0.5 * sig));
  const tp0 = a.target > S0 * 1.01 ? a.target : a.range.hi, tp1 = Math.max(tp0, a.range.hi);
  const review = new Date(Date.now() + H * (isCrypto(a) ? 1 : 1.45) * 86400e3).toLocaleDateString("es-CO", { day: "numeric", month: "long" });
  const rt = roundTrip(a);
  const loss = amount * (1 - a.stop / S0) + amount * rt;
  const base = { baja: 5, media: 10, alta: 15 }[state.profile.risk] || 10;
  const maxPct = base * (a.riskLevel === "alto" || isCrypto(a) ? 0.5 : 1);
  const stopStep = { t: `Sal si baja a ${fmtPrice(a.stop)}`, d: `con ${money0(amount)} perderías unos ${money0(loss)} (incluye costos)` };
  const tpStep = { t: `Toma ganancias entre ${fmtPrice(tp0)} y ${fmtPrice(tp1)}`, d: "vende una parte si llega a esa zona" };
  const rvStep = { t: `Revisa el ${review}`, d: "o antes si cambia el veredicto" };
  const k = a.verdict.key;
  let steps;
  if (k === "buy") steps = [{ t: "Compra la mitad hoy", d: `${money0(amount / 2)} a unos ${fmtPrice(S0)}` }, { t: "La otra mitad en 2 semanas", d: `o antes si baja a ${fmtPrice(dip)}` }, stopStep, tpStep, rvStep];
  else if (k === "accumulate") steps = [{ t: "Compra un tercio hoy", d: `${money0(amount / 3)} a unos ${fmtPrice(S0)}` }, { t: "Otro tercio en 2 semanas", d: `o antes si baja a ${fmtPrice(dip)}` }, { t: "El último en 4 semanas", d: "solo si el veredicto sigue a favor" }, stopStep, rvStep];
  else if (k === "hold") steps = [{ t: "No compres todavía", d: a.priceBuy < S0 * 0.995 ? `una entrada razonable sería ${fmtPrice(a.priceBuy)} o menos` : "espera a que la tendencia mejore" }, { t: "Si ya la tienes, mantén", d: `con tu límite de pérdida en ${fmtPrice(a.stop)}` }, rvStep];
  else if (k === "reduce") steps = [{ t: "Si la tienes, vende un tercio", d: "para asegurar parte de lo que llevas" }, { t: "Protege el resto", d: `sal si baja a ${fmtPrice(a.stop)}` }, { t: "Si no la tienes, no entres", d: "la tendencia está en contra" }, rvStep];
  else steps = [{ t: "Si la tienes, considera salir", d: "la tendencia está claramente en contra" }, { t: "Si no la tienes, evítala por ahora", d: `vuelve a mirarla el ${review}` }];
  return { steps, maxPct, buying: k === "buy" || k === "accumulate" };
}
function histLine(a) {
  const r = track?.byVerdict?.find((x) => x.key === a.verdict.key);
  if (!r) return "";
  const base = track.byVerdict.reduce((s, x) => s + x.hit * x.n, 0) / track.byVerdict.reduce((s, x) => s + x.n, 0);
  return `<p class="g-hist">${ico("chart")}<span><b>Historial:</b> en la prueba con ${track.nAssets} activos (${track.oos.from.slice(0, 4)}–${track.oos.to.slice(0, 4)}), cuando Horizon dijo «${esc(r.label)}», el precio subió ${Math.round(r.hit * 100)} de cada 100 veces en 3 meses; sin mirar la señal subía ${Math.round(base * 100)}.${a.horizonDays !== 63 ? " (Medido a 3 meses.)" : ""} <a class="lnk" href="#/metodo">Ver la prueba</a></span></p>`;
}
function simpleCard(a) {
  const [title, textFn] = GUIDE[a.verdict.key];
  const plan = buildPlan(a, state.amount);
  const lab = { up: "A favor", down: "En contra", flat: "Neutral" };
  const tv = factorNotes(a.factors).map((n) => ({ t: n.up > 0 ? "up" : n.up < 0 ? "down" : "flat", text: n.text }));
  const sigs = a.contrib.map((c) => ({ n: TAB_SHORT[c.key], t: c.signal >= 0.1 ? "up" : c.signal <= -0.1 ? "down" : "flat" }));
  const ten = Math.round(a.probUp * 10);
  const hz = horizonLabel(a.horizonDays);
  return `
  <div class="row rise" style="--i:1;margin:0 6px 14px;justify-content:space-between;flex-wrap:wrap;gap:10px">
    <div class="seg" id="mode" role="group" aria-label="Nivel de detalle"><i class="ind"></i><a href="javascript:void(0)" data-m="simple" class="${state.mode === "simple" ? "on" : ""}">Simple</a><a href="javascript:void(0)" data-m="full" class="${state.mode === "full" ? "on" : ""}">Ver los 5 modelos</a></div>
  </div>
  <section class="glass guide rise" style="--i:2" aria-label="En pocas palabras">
    <div class="g-label">En pocas palabras · a ${hz}</div>
    <h2 class="g-head ${a.verdict.tone}">${esc(title)}</h2>
    <p class="g-text">${esc(textFn(a))}</p>
    <div class="g-money">
      <label class="g-q" for="amt">Si inviertes <span class="g-in">$<input id="amt" type="text" inputmode="numeric" autocomplete="off" value="${Number(state.amount).toLocaleString("es-CO")}"></span> hoy, en ${hz} podrías tener:</label>
      <div id="scen">${scenarioRows(a, state.amount)}</div>
    </div>
    <div class="plan" id="plan">${planHTML(plan)}</div>
    ${histLine(a)}
    <p class="g-note">Son estimaciones, no promesas. Invierte solo dinero que no necesites pronto.</p>
    <details class="how g-more"><summary>¿En qué se basa?</summary>
      <h4 class="g-h">La tendencia decide la dirección</h4>
      <div class="g-trend">${tv.map((x) => `<div class="tv ${x.t}"><i></i><span>${esc(x.text)}</span><em>${lab[x.t]}</em></div>`).join("")}</div>
      <h4 class="g-h">Los 5 modelos miden el riesgo y los precios</h4>
      <p class="g-sum">El rango, el límite de pérdida y la zona de ganancia salen de los saltos de Merton, la reversión a la media y las opciones reales. En la prueba de 10 años, el rango acertó ${track?.coverage ? Math.round(track.coverage.inside * 100) : 82} de cada 100 veces. Su opinión sobre la dirección hoy: <b class="${a.verdict5.tone}">${esc(a.verdict5.label)}</b> (no anticipaba bien la dirección, por eso ya no decide).</p>
      <div class="g-votes" aria-label="Qué ve cada modelo">${sigs.map((x) => `<span class="vote ${x.t}"><i></i>${x.n}<em>${{ up: "Sube", down: "Baja", flat: "Neutral" }[x.t]}</em></span>`).join("")}</div>
      <h4 class="g-h">Noticias</h4>
      <p class="g-sum" id="g-news">Cargando el tono de las noticias…</p>
      <p class="g-sum">Según los saltos de Merton, en ${ten} de cada 10 escenarios el precio termina más alto después de ${hz}.</p>
      <div class="g-gloss"><h4>Palabras clave</h4><dl>${GLOSSARY.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join("")}</dl></div>
    </details>
  </section>`;
}
function planHTML(plan) {
  return `<h4 class="g-h">Plan posible</h4><ol class="plan-steps">${plan.steps.map((s, i) => `<li><span class="n">${i + 1}</span><div><b>${esc(s.t)}</b><span>${esc(s.d)}</span></div></li>`).join("")}</ol>
    ${plan.buying ? `<p class="g-size">Tamaño prudente: no más del <b>${plan.maxPct} %</b> del dinero que tienes para invertir (perfil de riesgo ${esc(state.profile.risk)} · <a class="lnk" href="#/portafolio">cambiar</a>).</p>` : ""}`;
}
function bindGuide(a) {
  const inp = $("#amt"); if (!inp) return;
  inp.addEventListener("input", () => {
    const n = Math.min(1e12, parseInt(inp.value.replace(/\D/g, "") || "0", 10));
    inp.value = n ? n.toLocaleString("es-CO") : "";
    state.amount = n || 0; store.set("amount", state.amount);
    $("#scen").innerHTML = scenarioRows(a, state.amount);
    $("#plan").innerHTML = planHTML(buildPlan(a, state.amount));
  });
  inp.addEventListener("focus", () => inp.select());
}

async function renderDetail(sym) {
  currentRoute = "detail"; updateNav("detail");
  view.innerHTML = `<a class="back" href="#/">${ico("back")}Mi lista</a>
    <div class="head"><div><div class="skeleton" style="width:min(320px,70vw);height:40px"></div><div class="skeleton" style="width:min(220px,50vw);height:14px;margin-top:12px"></div></div><div class="skeleton" style="width:130px;height:42px"></div></div>
    <section class="glass hero-card" aria-busy="true"><div><div class="skeleton" style="width:120px;height:12px"></div><div class="skeleton" style="width:min(280px,80%);height:54px;margin:14px 0"></div><div class="skeleton" style="height:14px;width:90%"></div><div class="skeleton" style="height:14px;width:70%;margin-top:8px"></div></div>
    <div class="kpis">${'<div class="kpi"><div class="skeleton" style="height:14px;width:60%"></div><div class="skeleton" style="height:26px;width:80%;margin-top:10px"></div></div>'.repeat(6)}</div></section>`;
  const my = routeToken;
  let a;
  try { [a, track] = await Promise.all([analyze(sym), getTrackRecord()]); }
  catch (e) {
    if (my !== routeToken) return;
    view.innerHTML = `<a class="back" href="#/">${ico("back")}Mi lista</a><div class="glass card rise"><h2>No pudimos analizar ${esc(sym)}</h2><p class="muted" style="margin:8px 0 12px">${esc(e.message)}</p><button class="chip" id="retry" style="margin-bottom:18px">Reintentar</button>${searchBox()}</div>`;
    bindSearch(); $("#retry")?.addEventListener("click", () => renderDetail(sym)); return;
  }
  if (my !== routeToken) return;
  const inList = state.watch.includes(sym);
  const ch = dayChange(a.series);
  const asOf = new Date(a.asOf * 1000).toLocaleDateString("es-CO", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
  const m = a.models;
  view.dataset.mode = state.mode;
  view.innerHTML = `
  <a class="back" href="#/">${ico("back")}Mi lista</a>
  <div class="head rise">
    <div><h1>${esc(a.name)}</h1><div class="sub">${esc(a.symbol)}${a.series.ex ? " · " + esc(a.series.ex) : ""} · ${esc(REGION_NAMES[a.region])} · cierre del ${asOf}</div></div>
    <div><div class="price">${money(a.S0, a.currency)}</div><div class="chg ${ch >= 0 ? "pos" : "neg"}" style="text-align:right;font-weight:600">${pct(ch, 2)} hoy</div></div>
  </div>
  <div id="pxc" class="rise" style="--i:1;margin-bottom:12px"></div>
  <div id="kstats" class="rise" style="--i:1;margin-bottom:12px"></div>
  <div id="stats" class="rise" style="--i:1;margin-bottom:12px"></div>
  <div id="news" class="rise" style="--i:1;margin-bottom:18px"></div>
  <div class="row rise" style="--i:1;margin:0 6px 18px;flex-wrap:wrap;justify-content:space-between">
    <div class="seg" id="hz" style="margin:0"><i class="ind"></i>${[[21, "1 mes"], [63, "3 meses"], [126, "6 meses"]].map(([d, t]) => `<a href="javascript:void(0)" data-h="${d}" class="${state.horizon === d ? "on" : ""}">${t}</a>`).join("")}</div>
    <div class="row" style="gap:8px;flex-wrap:wrap"><button class="chip" id="toggleList">${inList ? "✓ En mi lista · quitar" : "+ Agregar a mi lista"}</button><a class="chip" href="#/portafolio?add=${encodeURIComponent(sym)}">+ Portafolio</a><a class="chip" href="#/comparar/${encodeURIComponent(sym)},${encodeURIComponent(BENCH[a.region] || "SPY")}">Comparar</a></div>
  </div>

  ${simpleCard(a)}

  <section class="glass hero-card expert rise" style="--i:2">
    <div>
      <div class="eyebrow">Veredicto a ${a.horizonDays} días</div>
      <div class="big ${a.verdict.tone}">${esc(a.verdict.label)}</div>
      <p class="explain">${summaryText(a)}</p>
      ${C.gauge(a.score)}
      <div class="row muted" style="font-size:13px;gap:18px;flex-wrap:wrap"><span>Opinión de los 5 modelos <b class="${a.verdict5.tone}">${esc(a.verdict5.label)}</b></span><span>Señal de tendencia <b style="color:var(--text)">${a.score >= 0 ? "+" : ""}${a.score.toFixed(2).replace(".", ",")}</b></span><span>Acuerdo entre los 5 modelos <b style="color:var(--text)">${pctPlain(a.agreement)}</b></span><span>Confianza <b style="color:var(--text)">${pctPlain(a.confidence)}</b></span></div>
    </div>
    <div class="kpis">
      ${kpi("Probabilidad de subir", `<span data-to="${(a.probUp * 100).toFixed(1)}" data-dec="0" data-suf=" %">0 %</span>`, `en ${a.horizonDays} días (saltos de Merton)`)}
      ${kpi("Rango probable", `${fmtPrice(a.range.lo)} – ${fmtPrice(a.range.hi)}`, "percentiles 10 a 90")}
      ${kpi("Precio objetivo", fmtPrice(a.target), `${pct(a.upside)} desde hoy`)}
      ${kpi("Compra máxima", fmtPrice(a.priceBuy), pct(a.priceBuy / a.S0 - 1) + " · opciones reales")}
      ${kpi("Piso de protección", fmtPrice(a.stop), `${pct(a.downside)} · opciones reales`)}
      ${kpi("Riesgo de caída brusca", a.riskLevel[0].toUpperCase() + a.riskLevel.slice(1), `peor 5 %: ${pct(m.merton.es5, 0)}`)}
    </div>
  </section>

  <div class="two expert" style="margin-top:18px">
    <div class="glass card rise" style="--i:3"><h3 style="font-size:17px">¿Por qué este veredicto?</h3>
      <div class="reasons">${factorNotes(a.factors).map((n) => `<div class="reason"><span class="dot" style="background:${n.up > 0 ? "var(--green)" : n.up < 0 ? "var(--red)" : "var(--faint)"}"></span><div><b>Tendencia · ${({ mom12: "último año", regime: "su mercado", relStr: "frente a su mercado", volRatio: "nervios" })[n.key] || ""}</b>${esc(n.text)}</div></div>`).join("")}${a.reasons.map((r) => `<div class="reason"><span class="dot" style="background:${sigColor(r.signal)}"></span><div><b>${esc(r.name)} · señal ${r.signal >= 0 ? "+" : ""}${r.signal.toFixed(2).replace(".", ",")}</b>${esc(r.text)}</div></div>`).join("")}</div>
      ${a.flags.length ? `<div class="flags">${a.flags.map((f) => `<div class="flag">${ico("shield")}<span>${esc(f)}</span></div>`).join("")}</div>` : ""}
    </div>
    <div class="glass card rise" style="--i:4"><h3 style="font-size:17px">Qué opina cada uno de los 5 modelos</h3><p class="muted" style="font-size:13px;margin:2px 0 12px">Segunda opinión: desde el backtest ya no deciden la dirección. Barra a la derecha = sube; a la izquierda = baja.</p>
      ${a.contrib.map((c) => contribRow(c)).join("")}</div>
  </div>

  <div class="glass chartcard expert rise" style="--i:5"><h3>Precio y proyección a ${a.horizonDays} días</h3><div class="hint">La zona azul es el rango probable según el modelo de saltos de Merton (más oscura: 25–75 %; clara: 10–90 %). Las líneas marcan el objetivo, la compra máxima y el piso de protección.</div>
    ${C.priceFanChart({ series: a.series, fan: m.merton.fan, target: a.target, stop: a.stop, buy: a.priceBuy, S0: a.S0 })}</div>

  <div id="similar" class="rise" style="--i:6"></div>
  <div class="tabs expert" id="tabs" role="tablist">${TAB_ORDER.map((k, i) => `<button class="tab ${i === 0 ? "on" : ""}" role="tab" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-tab="${k}" aria-label="${modelName(k)}">${ico(MODEL_ICONS[k])}<span class="l">${modelName(k)}</span><span class="s">${TAB_SHORT[k]}</span><i class="sig" style="background:${sigColor(modelOf(a, k).signal || 0)}"></i></button>`).join("")}</div>
  <div id="panel" class="panel expert"></div>
  ${disclaimer()}`;

  const order = TAB_ORDER; let idx = 0;
  const showTab = (k, dir = 0, fromX) => {
    const i = order.indexOf(k); idx = i;
    $$(".tab").forEach((t) => { const on = t.dataset.tab === k; t.classList.toggle("on", on); t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; });
    const p = $("#panel"); p.innerHTML = panelFor(k, a); tidyPanel(p);
    if (dir) {
      const f = fromX ?? dir * 48; p.style.animation = "none";
      spring("panel-x", { from: f, to: 0, response: 0.42, onUpdate: (x) => { p.style.transform = `translateX(${x}px)`; p.style.opacity = String(1 - Math.min(1, Math.abs(x) / Math.abs(f)) * 0.85); }, onDone: () => { p.style.transform = ""; p.style.opacity = ""; } });
    } else { p.style.transform = ""; p.style.opacity = ""; p.style.animation = "none"; void p.offsetWidth; p.style.animation = ""; }
    // centra la pestaña activa dentro de su fila, sin mover nunca la página (scrollIntoView la desplazaba hasta las pestañas)
    const strip = $("#tabs"), tb = $(`.tab[data-tab="${k}"]`);
    if (strip && tb && strip.scrollWidth > strip.clientWidth) strip.scrollTo({ left: tb.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft - (strip.clientWidth - tb.offsetWidth) / 2, behavior: dir ? "smooth" : "auto" });
  };
  showTab("merton");
  $("#tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) { const to = order.indexOf(b.dataset.tab); showTab(b.dataset.tab, Math.sign(to - idx)); } });
  $("#tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const to = Math.max(0, Math.min(order.length - 1, idx + (e.key === "ArrowRight" ? 1 : -1)));
    showTab(order[to], Math.sign(to - idx)); $(`.tab[data-tab="${order[to]}"]`).focus({ preventScroll: true });
  });
  bindSwipe($("#panel"), () => idx, order.length, (to, dir, fromX) => showTab(order[to], dir, fromX));
  C.bindCrosshair(view);
  $("#toggleList").addEventListener("click", () => {
    const was = state.watch.slice();
    state.watch = inList ? state.watch.filter((x) => x !== sym) : [...state.watch, sym]; store.set("watch", state.watch);
    toast(inList ? `${sym} quitada de tu lista` : `${sym} agregada a tu lista`, { label: "Deshacer", fn: () => { state.watch = was; store.set("watch", was); if (currentRoute === "detail") renderDetail(sym); } });
    renderDetail(sym);
  });
  $("#hz").addEventListener("click", (e) => { const b = e.target.closest("[data-h]"); if (!b) return; state.horizon = +b.dataset.h; store.set("horizon", state.horizon); renderDetail(sym); });
  moveInd($("#hz"), "hz");
  moveInd($("#mode"), "mode");
  $("#mode").addEventListener("click", (e) => {
    const b = e.target.closest("[data-m]"); if (!b) return;
    state.mode = b.dataset.m; store.set("mode", state.mode); view.dataset.mode = state.mode;
    $$("#mode a").forEach((x) => x.classList.toggle("on", x === b)); moveInd($("#mode"), "mode");
  });
  bindGuide(a); clampHints(view);
  mountKeyStats($("#kstats"), { sym, series: a.series });
  mountNews($("#news"), { sym, onTone: (t) => { const g = $("#g-news"); if (g) g.innerHTML = t ? `Tono de los titulares recientes: <b class="${t.tone === "pos" ? "pos" : t.tone === "neg" ? "neg" : ""}">${esc(t.label)}</b> (${t.pos} buenas y ${t.neg} malas de ${t.n}). Es contexto: no cambia el veredicto.` : "No hay noticias disponibles ahora."; } });
  mountStats($("#stats"), { sym, series: a.series, beta: a.models.herding?.betaMkt, currency: a.currency });
  mountSimilar($("#similar"), a);
  if (pxc) pxc.destroy();
  pxc = mountPriceChart($("#pxc"), {
    sym, currency: a.currency,
    onQuote: ({ price, prev }) => { // el encabezado muestra el precio más reciente de Yahoo, no solo el cierre guardado
      const pe = $(".head .price"), ce = $(".head .chg");
      if (!pe || !ce || !isFinite(price)) return;
      pe.innerHTML = money(price, a.currency);
      if (prev) { const c = price / prev - 1; ce.className = "chg " + (c >= 0 ? "pos" : "neg"); ce.textContent = `${pct(c, 2)} hoy`; }
    },
  });
  countUp(view);
}

function contribRow(c) {
  const w = Math.min(1, Math.abs(c.value) / 0.25) * 50;
  return `<div style="margin:10px 0"><div class="row" style="justify-content:space-between;font-size:13.5px"><span style="font-weight:650">${esc(c.name)}</span><span class="muted">${c.signal >= 0 ? "+" : ""}${c.signal.toFixed(2).replace(".", ",")} · confianza ${pctPlain(c.confidence)} · peso ${pctPlain(c.weight)}</span></div>
    <div style="position:relative;height:8px;border-radius:99px;background:var(--chip);margin-top:6px"><i style="position:absolute;top:0;bottom:0;border-radius:99px;background:${sigColor(c.signal)};${c.value >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`};transition:width 1s var(--spring)"></i><i style="position:absolute;left:50%;top:-3px;bottom:-3px;width:2px;background:var(--faint);opacity:.6"></i></div></div>`;
}

function hurstChart(m) {
  const pts = m.dfa, W = 720, Hh = 230, L = 46, R = 14, T = 12, B = 30;
  const xs = pts.map((p) => Math.log10(p.s)), ys = pts.map((p) => Math.log10(p.F));
  const x0 = Math.min(...xs), x1 = Math.max(...xs), yMid = (Math.min(...ys) + Math.max(...ys)) / 2, span = Math.max(0.6, (Math.max(...ys) - Math.min(...ys)) * 1.35);
  const y0 = yMid - span / 2, y1 = yMid + span / 2;
  const sx = (v) => L + ((v - x0) / (x1 - x0 || 1)) * (W - L - R), sy = (v) => T + (1 - (v - y0) / (y1 - y0)) * (Hh - T - B);
  const fitY = (lx) => (m.fit.a + m.fit.b * lx * Math.LN10) / Math.LN10; // recta ajustada en log10
  const mx = (x0 + x1) / 2, ref = (lx) => fitY(mx) + 0.5 * (lx - mx);
  const dots = xs.map((x, i) => `<circle cx="${sx(x).toFixed(1)}" cy="${sy(ys[i]).toFixed(1)}" r="4.5" fill="var(--blue)"/>`).join("");
  const ticks = pts.map((p, i) => `<text class="pxc-xtx" x="${sx(xs[i]).toFixed(1)}" y="${Hh - 10}" text-anchor="middle">${p.s}</text>`).join("");
  return `<svg class="pxc-svg" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Exponente de Hurst ${f2(m.hurst, 2)}">
    <line class="pxc-ref" x1="${sx(x0)}" x2="${sx(x1)}" y1="${sy(ref(x0)).toFixed(1)}" y2="${sy(ref(x1)).toFixed(1)}"/>
    <line x1="${sx(x0)}" x2="${sx(x1)}" y1="${sy(fitY(x0)).toFixed(1)}" y2="${sy(fitY(x1)).toFixed(1)}" stroke="var(--orange)" stroke-width="2.2"/>
    ${dots}${ticks}<text class="pxc-xtx" x="${L}" y="${T + 10}">pendiente = H = ${f2(m.hurst, 2)} · punteada = 0,5</text>
    <text class="pxc-ytx" x="${W - R}" y="${T + 10}" text-anchor="end">eje: días por ventana</text></svg>`;
}
const stat = (k, v) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
const head = (m, name) => `<div class="glass card"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><div><div class="eyebrow">${name}</div><h3 style="font-size:20px;letter-spacing:-.02em;margin-top:4px">${esc(m.headline)}</h3></div><div class="muted" style="font-size:13px;text-align:right">Señal <b style="color:${sigColor(m.signal)}">${m.signal >= 0 ? "+" : ""}${m.signal.toFixed(2).replace(".", ",")}</b><br>Confianza ${pctPlain(m.confidence)}</div></div><p class="explain" style="margin-top:10px">${esc(m.detail)}</p>`;
const f2 = (x, d = 2) => (x == null || !isFinite(x) ? "—" : x.toFixed(d).replace(".", ","));

// Divulgación progresiva en cada panel: titular y gráfico a la vista; números y explicación un toque más abajo
function clampHints(root) {
  for (const h of $$(".chartcard .hint:not(.clamp)", root)) { h.classList.add("clamp"); h.title = "Toca para leer completo"; h.addEventListener("click", () => h.classList.toggle("open")); }
}
function tidyPanel(p) {
  const st = $(".stats", p);
  if (st) { const d = document.createElement("details"); d.className = "how"; d.innerHTML = "<summary>Ver los números del modelo</summary>"; st.replaceWith(d); d.append(st); }
  for (const h of $$("h4.eyebrow", p)) {
    if (h.textContent.trim() !== "Cómo leerlo") continue;
    const card = h.closest(".card"); if (!card) continue;
    const rest = [...card.childNodes].filter((n) => n !== h);
    const d = document.createElement("details"); d.className = "how"; d.innerHTML = "<summary>Cómo funciona este modelo</summary>";
    rest.forEach((n) => d.append(n)); h.remove(); card.append(d);
  }
  clampHints(p);
}

function panelFor(k, a) {
  const m = modelOf(a, k);
  if (!m.available && ["gbm", "bs", "kou", "fractal"].includes(k)) return head(m, EXTRA_NAMES[k]) + `</div>`;
  if (k === "gbm") {
    const mt = a.models.merton, ko = a.extras.kou;
    const row = (t, g, me, kk) => `<div class="r bt-r"><span>${t}</span><span class="num">${g}</span><span class="num">${me}</span><span class="num">${kk}</span></div>`;
    return head(m, "Movimiento browniano geométrico (GBM)") + `
      <div class="stats">${stat("Tendencia anual (μ)", pct(m.mu, 1))}${stat("Volatilidad anual (σ)", pctPlain(m.sigma, 1))}${stat("Probabilidad de subir", pctPlain(m.probUp, 0))}${stat("Rango p10–p90", `${fmtPrice(m.lo)} – ${fmtPrice(m.hi)}`)}
      ${stat("Prob. caer más de 10 %", pctPlain(m.probDown10, 1))}${stat("Pérdida media peor 5 %", pct(m.es5, 1))}${stat("Curtosis (normal = 3)", f2(m.kurt, 1))}${stat("¿Rendimientos normales?", m.normal ? "Sí" : `No (JB ${f2(m.jb, 0)})`)}</div></div>
    <div class="glass card" style="margin-top:18px"><h3 style="font-size:17px">El mismo riesgo visto por tres modelos</h3><p class="muted" style="font-size:13px;margin:2px 0 10px">El GBM no tiene saltos; Merton agrega saltos simétricos y Kou, saltos distintos para subidas y caídas.</p>
      <div class="rank bt">${`<div class="r h bt-r"><span></span><span class="num">GBM</span><span class="num">Merton</span><span class="num">Kou</span></div>`}
      ${row("Prob. caer más de 10 %", pctPlain(m.probDown10, 1), pctPlain(mt.probDown10, 1), ko?.available ? pctPlain(ko.probDown10, 1) : "—")}
      ${row("Pérdida media peor 5 %", pct(m.es5, 1), pct(mt.es5, 1), ko?.available ? pct(ko.es5, 1) : "—")}
      ${row("Probabilidad de subir", pctPlain(m.probUp, 0), pctPlain(mt.probUp, 0), ko?.available ? pctPlain(ko.probUp, 0) : "—")}</div></div>
    <div class="glass card" style="margin-top:18px"><h4 class="eyebrow">Cómo leerlo</h4><p class="explain">Es el modelo base de las finanzas: el precio crece con una tendencia y vibra al azar, con cambios que siguen una campana normal. En Horizon sirve de <b>punto de comparación</b>: la diferencia con Merton y Kou muestra cuánto riesgo aportan los saltos. Su probabilidad y su rango salen de forma exacta, sin simular.</p>
      <div class="formula">dS = μ·S·dt + σ·S·dW · ln(S_T/S₀) ~ N((μ − σ²/2)T, σ²T)</div></div>`;
  }
  if (k === "bs") {
    return head(m, "Black–Scholes (1973)") + `
      <div class="stats">${stat("Volatilidad anual", pctPlain(m.sigma, 1))}${stat(`Movimiento típico en ${m.H} días`, `±${pctPlain(m.move, 0)}`)}${stat("Opción de compra (al precio de hoy)", `${fmtPrice(m.call)} · ${pctPlain(m.call / m.S0, 1)}`)}${stat("Opción de venta (al precio de hoy)", `${fmtPrice(m.put)} · ${pctPlain(m.put / m.S0, 1)}`)}
      ${stat("Seguro contra caídas de 10 %", `${fmtPrice(m.put90)} · ${pctPlain(m.put90 / m.S0, 1)}`)}${stat("Apuesta a subir 10 %", `${fmtPrice(m.call110)} · ${pctPlain(m.call110 / m.S0, 1)}`)}${stat("Delta de la opción de compra", f2(m.delta, 2))}${stat("Prob. de terminar arriba (neutral al riesgo)", pctPlain(m.probITM, 0))}</div></div>
    <div class="glass card" style="margin-top:18px"><h4 class="eyebrow">Cómo leerlo</h4><p class="explain">Black–Scholes usa el GBM para ponerle precio a una opción. En Horizon responde <b>cuánto cuesta el riesgo</b>: cuánto pagarías por asegurarte contra una caída (opción de venta) o por apostar a una subida (opción de compra). No opina si el precio sube o baja, por eso su señal es neutral. En la pestaña de Merton se compara su precio con el de un modelo con saltos.</p>
      <div class="formula">C = S·N(d₁) − K·e^(−rT)·N(d₂) · d₁ = [ln(S/K) + (r + σ²/2)T] / (σ√T) · d₂ = d₁ − σ√T</div></div>`;
  }
  if (k === "kou") {
    return head(m, "Saltos de Kou (2002)") + `
      <div class="stats">${stat("Saltos por año", f2(m.lamYear, 1))}${stat("Subidas bruscas (3 años)", `${m.nUp} · ${pct(m.upSize, 1)} en promedio`)}${stat("Caídas bruscas (3 años)", `${m.nDown} · ${pct(-m.downSize, 1)} en promedio`)}${stat("Prob. de que un salto sea hacia arriba (p)", pctPlain(m.p, 0))}
      ${stat("Rango p10–p90", `${fmtPrice(m.q.p10)} – ${fmtPrice(m.q.p90)}`)}${stat("Probabilidad de subir", pctPlain(m.probUp, 0))}${stat("Prob. caer más de 10 %", pctPlain(m.probDown10, 1))}${stat("Pérdida media peor 5 %", pct(m.es5, 1))}</div></div>
    <div class="glass chartcard"><h3>Distribución del rendimiento a ${m.H} días</h3><div class="hint">Barras: 20.000 escenarios con saltos de Kou. Línea naranja: lo que diría un modelo sin saltos. En rojo, las caídas de más de 10 %.</div>${C.tailChart(m)}</div>
    <div class="glass card" style="margin-top:18px"><h4 class="eyebrow">Cómo leerlo</h4><p class="explain">Como Merton, suma saltos al GBM, pero cada salto sigue una <b>exponencial doble</b>: las subidas y las caídas bruscas pueden tener tamaños y frecuencias distintas. En Horizon complementa a Merton: muestra si esta acción <b>cae más fuerte de lo que sube</b>. Los saltos se detectan como los días que se alejan más de 3 desviaciones robustas de lo normal.</p>
      <div class="formula">dS/S = μ·dt + σ·dW + d(Σ(Vᵢ − 1)) · ln V ~ p·Exp(η₁) con +, (1 − p)·Exp(η₂) con −</div></div>`;
  }
  if (k === "fractal") {
    return head(m, "Fractales y browniano fraccional") + `
      <div class="stats">${stat("Exponente de Hurst (DFA)", f2(m.hurst, 2))}${stat("Hurst por R/S", f2(m.hurstRS, 2))}${stat("Dimensión fractal (D = 2 − H)", f2(m.D, 2))}${stat("Comportamiento", m.kind[0].toUpperCase() + m.kind.slice(1))}
      ${stat("Ajuste del gráfico log-log (R²)", f2(m.r2, 2))}${stat("Rango con browniano fraccional", `${fmtPrice(m.lo)} – ${fmtPrice(m.hi)}`)}${stat("Frente al rango del GBM", (m.widen >= 0 ? "+" : "−") + pctPlain(Math.abs(m.widen), 0))}${stat("Últimos 6 meses", pct(Math.exp(m.ret6) - 1, 1))}</div></div>
    <div class="glass chartcard"><h3>¿Tiene memoria el precio?</h3><div class="hint">Cada punto compara el tamaño de la ventana con la fluctuación que hay dentro de ella (escala logarítmica). La pendiente es el exponente de Hurst: la línea punteada es 0,5, el azar puro.</div>${hurstChart(m)}</div>
    <div class="glass card" style="margin-top:18px"><h4 class="eyebrow">Cómo leerlo</h4><p class="explain">Los precios tienen rasgos <b>fractales</b>: se ven parecidos en minutos, días o meses. El <b>exponente de Hurst</b> mide su memoria: 0,5 es una caminata al azar (lo que suponen el GBM y Black–Scholes); más de 0,5, tendencias que continúan; menos de 0,5, movimientos que se devuelven. El <b>browniano fraccional</b> generaliza el GBM con esa memoria: la dispersión crece como t^H en vez de t^0,5. En Horizon, si hay memoria sigue la dirección de los últimos 6 meses; si se devuelve, espera un rebote.</p>
      <div class="formula">F(s) ∝ s^H (DFA) · E[R/S] ∝ n^H · D = 2 − H · Var[B_H(t)] = σ²·t^(2H)</div></div>`;
  }
  if (k === "merton") {
    return head(m, "Saltos de Merton (1976)") + `
      <div class="stats">${stat("Saltos por año", f2(m.annual.lam, 1))}${stat("Tamaño medio del salto", pct(m.fit.k, 1))}${stat("Volatilidad normal (σ)", pctPlain(m.annual.sigma, 1))}${stat("Volatilidad total", pctPlain(m.totalVolYear, 1))}
      ${stat("Prob. caer más de 10 %", pctPlain(m.probDown10, 1))}${stat("…sin considerar saltos", pctPlain(m.gaussDown10, 1))}${stat("Pérdida media peor 5 %", pct(m.es5, 1))}${stat("¿Hay saltos reales?", m.fit.jumpsSignificant ? `Sí (LR ${f2(m.fit.LR, 0)})` : `No (LR ${f2(m.fit.LR, 1)})`)}</div></div>
    <div class="glass chartcard"><h3>Distribución del rendimiento a ${m.H} días</h3><div class="hint">Barras: 20.000 escenarios con saltos. Línea naranja: lo que diría un modelo sin saltos (Black–Scholes). Las colas rojas muestran el riesgo que el modelo normal subestima.</div>${C.tailChart(m)}</div>
    <div class="glass card" style="margin-top:18px"><h4 class="eyebrow">Cómo leerlo</h4><p class="explain">El precio se mueve por dos motivos: las <b>vibraciones normales</b> del día a día y los <b>saltos</b> cuando llega información importante. Merton agrega a Black–Scholes un proceso de Poisson de saltos. Aquí se estima por máxima verosimilitud con tus datos y se simulan escenarios para obtener la probabilidad de subir, el rango y el riesgo de cola. Una opción call ATM a ${m.H} días valdría <b>${fmtPrice(m.callM)}</b> con Merton y <b>${fmtPrice(m.callBS)}</b> con Black–Scholes.</p>
      <div class="formula">dS/S = (μ − λk)dt + σ dW + (J − 1)dN · ln J ~ N(μJ, δ²) · k = e^(μJ+δ²/2) − 1</div></div>`;
  }
  if (k === "meanrev") {
    return head(m, "Reversión a la media (Ornstein–Uhlenbeck)") + `
      <div class="stats">${stat("Desviación (z)", (m.z >= 0 ? "+" : "") + f2(m.z, 2) + " σ")}${stat("Vida media", isFinite(m.halfLife) ? f2(m.halfLife, 0) + " días" : "∞")}${stat("Dickey–Fuller (t)", f2(m.tDF, 2))}${stat("¿Revierte de verdad?", m.reverts ? "Sí" : "No concluyente")}
      ${stat("Equilibrio hoy", fmtPrice(m.eqNow))}${stat("Objetivo a " + a.horizonDays + " días", fmtPrice(m.target))}${stat("Frente a su media de 200 días", pct(m.vsMa200, 1))}${stat("Tendencia anual", pct(m.trend, 1))}</div></div>
    <div class="glass chartcard"><h3>Precio frente a su equilibrio</h3><div class="hint">La línea punteada es la tendencia de largo plazo y la banda, ±1 desviación. Cuando el precio se aleja mucho de la banda, el modelo espera que vuelva.</div>${C.meanRevChart(m)}</div>
    <div class="glass card" style="margin-top:18px"><h4 class="eyebrow">Cómo leerlo</h4><p class="explain">Se separa la tendencia del log-precio y se modela la desviación como un proceso que <b>vuelve a su promedio</b>. Una <b>vida media corta</b> significa que las desviaciones se corrigen rápido. La prueba de <b>Dickey–Fuller</b> dice si esa reversión es real o solo ruido: por debajo de −3,4 es sólida. Si no lo es, la señal pesa poco en el veredicto.</p>
      <div class="formula">du = −κ·u·dt + σ·dW · u_{t+1} = φ·u_t + ε · vida media = ln 2 / κ</div></div>`;
  }
  if (k === "realoptions") {
    return head(m, "Opciones reales") + `
      <div class="stats">${stat("Valor del proyecto V", fmtPrice(m.V0))}${stat("Costo de invertir I", fmtPrice(m.I))}${stat("VPN", pct(m.npvPct, 1))}${stat("Valor de esperar", pctPlain(m.waitPct, 1))}
      ${stat("Compra máxima", fmtPrice(m.priceBuy))}${stat("Umbral V/I", f2(m.mStar, 3))}${stat("Piso de protección", fmtPrice(m.stop))}${stat("Costo de asegurar el piso", pctPlain(m.putPct, 1))}</div></div>
    <div class="two" style="margin-top:18px">
      <div class="glass card"><h4 class="eyebrow">Qué hacer ahora</h4><div class="big ${m.signal > 0.1 ? "pos1" : m.signal > -0.1 ? "neu" : "neg1"}" style="font-size:30px;font-weight:800;margin:6px 0">${esc(m.action)}</div>
        <p class="explain">${m.signal > 0 ? `El precio (${fmtPrice(m.S0)}) ya está en o bajo el umbral de compra (${fmtPrice(m.priceBuy)}): el valor esperado supera el costo con margen suficiente.` : `El precio (${fmtPrice(m.S0)}) está por encima del umbral de compra (${fmtPrice(m.priceBuy)}): esperar a un precio menor conserva el valor de la opción.`}</p></div>
      <div class="glass card"><h4 class="eyebrow">Cómo leerlo</h4><p class="explain">Invertir es como <b>ejercer una opción</b>. Esperar tiene valor (opción de <b>diferir</b>) y tener una salida preparada también (opción de <b>abandonar</b>). Con un árbol binomial americano se calcula el precio máximo al que conviene entrar y el piso de protección. Como una acción se puede revender, la irreversibilidad es parcial y el margen exigido se limita a la volatilidad del horizonte.</p>
        <div class="formula">V = S·(1+E[R])/(1+ρ) · Diferir = Call americana(V, I) · Abandonar = Put americana(V, (1−L)·I)</div></div></div>`;
  }
  if (k === "vasicek") {
    if (!m.available) return head(m, "Vasicek (1977)") + `</div>`;
    const sh = m.short.params, lg = m.long.params;
    return head(m, "Vasicek (1977)") + `
      <div class="stats">${stat("Reversión a (a)", f2(lg.a, 2))}${stat("¿Revierte de verdad?", lg.significant ? `Sí (t = ${f2(lg.tDF, 1)})` : `No concluyente (t = ${f2(lg.tDF, 1)})`)}${stat("Promedio largo plazo (b)", pctPlain(lg.b, 2))}${stat("Volatilidad (σ)", pctPlain(lg.sigma, 2))}${stat("Vida media", f2(lg.halfLifeYears, 1) + " años")}
      ${stat("Tasa libre de riesgo esperada", pctPlain(m.rfAvg, 2))}${stat("Cambio esperado 10 años", (m.dLongPP >= 0 ? "+" : "") + f2(m.dLongPP, 2) + " pp")}${stat("Sensibilidad a tasas", f2(m.beta * 100, 2) + " % por pp")}${stat("Efecto esperado en precio", pct(m.impact, 2))}</div></div>
    <div class="two"><div class="glass chartcard"><h3>Tasa a 10 años del Tesoro de EE. UU.</h3><div class="hint">Línea azul: último año. Punteada y abanico: proyección de Vasicek a 1 año con banda del 90 %.</div>${C.ratesChart(m.long)}</div>
      <div class="glass chartcard"><h3>Curva de rendimientos</h3><div class="hint">Vasicek (morado) frente a lo observado (naranja). La diferencia refleja la prima de plazo que el modelo no incluye.</div>${C.curveChart(m)}</div></div>
    <div class="glass card" style="margin-top:18px"><h4 class="eyebrow">Cómo leerlo</h4><p class="explain">Vasicek modela una <b>tasa de interés que siempre vuelve a su promedio de largo plazo</b>. Aquí es el modelo macro: proyecta hacia dónde van las tasas, aporta la <b>tasa libre de riesgo</b> que usan los demás modelos y mide cuánto le afecta a esta acción un cambio de tasas (regresión sobre la tasa a 10 años). Por eso influye más en bonos y acciones de crecimiento que en un activo poco sensible. También valora bonos con fórmula cerrada: un bono cero a 10 años costaría ${fmtPrice(m.curve.find((c) => c.tau === 10)?.price * 100)} por cada 100 de valor nominal.</p>
      <div class="formula">dr = a·(b − r)·dt + σ·dW · P(0,τ) = A(τ)·e^(−B(τ)·r) · B = (1 − e^(−aτ))/a</div></div>`;
  }
  // manada
  if (!m.available) return head(m, "Comportamiento en manada") + `</div>`;
  return head(m, "Comportamiento en manada (CSAD)") + `
      <div class="stats">${stat("γ₂ en 2 años", f2(m.full.g2, 2))}${stat("t (2 años)", f2(m.full.t2, 2))}${stat("γ₂ últimos 120 días", f2(m.recent.g2, 2))}${stat("t (120 días)", f2(m.recent.t2, 2))}
      ${stat("Mercado, últimos 20 días", pct(m.mkt20, 1))}${stat("Correlación con el mercado (60 d)", m.corr60 == null ? "—" : f2(m.corr60, 2))}${stat("Correlación histórica", m.corrAll == null ? "—" : f2(m.corrAll, 2))}${stat("Acciones en el universo", m.nStocks)}</div></div>
    <div class="glass chartcard"><h3>Dispersión de rendimientos frente al movimiento del mercado</h3><div class="hint">Cada punto es un día. Si en los días de movimientos extremos la curva se dobla hacia abajo (γ₂ negativo y significativo), los inversionistas se están imitando.</div>${C.herdChart(m)}</div>
    <div class="glass card" style="margin-top:18px"><h4 class="eyebrow">Cómo leerlo</h4><p class="explain">Método de <b>Chang, Cheng y Khorana (2000)</b>. Mide qué tanto se separan los rendimientos de cada acción del mercado (CSAD). Normalmente, cuanto más se mueve el mercado, más se dispersan. Si pasa lo contrario, hay <b>manada</b>: todos compran o venden a la vez. En manada alcista aumenta el riesgo de burbuja y el modelo resta; en manada bajista, el pánico puede crear oportunidades y el modelo suma. Región analizada: <b>${esc(REGION_NAMES[m.region] || m.region)}</b>, con datos hasta el ${new Date(m.asOf * 1000).toLocaleDateString("es-CO", { timeZone: "UTC", day: "numeric", month: "long" })}.</p>
      <div class="formula">CSAD_t = α + γ₁·|R_m,t| + γ₂·R_m,t² + ε · manada si γ₂ &lt; 0 y es significativo</div></div>`;
}


// ----- Activos parecidos (correlación de 1 año con los activos guardados) -----
const BENCH = { US: "SPY", CO: "ECOPETROL.CL", LATAM: "EEM", EU: "^FTSE", ASIA: "^N225", CRYPTO: "BTC-USD" };
function mountSimilar(el, a) {
  const snap = snapCache; if (!snap || !el) return;
  const mine = new Map(a.series.t.slice(-253).map((t, i, arr) => [Math.floor(t / 86400), a.series.c.slice(-253)[i]]));
  const days = [...mine.keys()];
  const rets = (m) => { const r = []; for (let i = 1; i < days.length; i++) { const x = m.get(days[i - 1]), y = m.get(days[i]); r.push(x && y ? Math.log(y / x) : null); } return r; };
  const r0 = rets(mine);
  const out = [];
  for (const [sym, s] of Object.entries(snap.series)) {
    if (sym === a.symbol || sym.startsWith("^") || sym.endsWith("=X")) continue;
    const m = new Map(s.t.map((d, i) => [d, s.c[i]]));
    const r1 = rets(m);
    const xs = [], ys = [];
    for (let i = 0; i < r0.length; i++) if (r0[i] != null && r1[i] != null) { xs.push(r0[i]); ys.push(r1[i]); }
    if (xs.length < 120) continue;
    const mx = xs.reduce((p, v) => p + v, 0) / xs.length, my = ys.reduce((p, v) => p + v, 0) / ys.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    out.push({ sym, name: s.n, rho: sxy / Math.sqrt(sxx * syy) });
  }
  out.sort((x, y) => y.rho - x.rho);
  const top = out.slice(0, 5).filter((x) => x.rho > 0.3);
  if (!top.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<h2 class="sec" style="margin-top:22px">Se mueven parecido <small>correlación del último año · útil para no repetir el mismo riesgo</small></h2>
    <div class="chips-row">${top.map((x) => `<a class="chip" href="#/t/${encodeURIComponent(x.sym)}" title="${esc(x.name)}">${esc(x.sym)} <span class="faint">${x.rho.toFixed(2).replace(".", ",")}</span></a>`).join("")}</div>`;
}

// ----- Portafolio -----
async function holdingValues() {
  const syms = [...new Set(state.portfolio.map((h) => h.sym))];
  const quotes = syms.length ? await getSparks(syms) : {};
  const fx = {};
  for (const cur of new Set(state.portfolio.map((h) => h.cur || ""))) fx[cur] = await getFxToCOP(cur);
  return state.portfolio.map((h, idx) => {
    const q = quotes[h.sym];
    const price = q?.price ?? h.cost;
    const f = fx[h.cur || ""];
    const value = h.qty * price, cost = h.qty * h.cost;
    const valueCOP = f != null ? value * f : null;
    const basis = h.basisCOP ?? (f != null ? cost * f : null);
    const plCOP = valueCOP != null && basis != null ? valueCOP - basis : null;
    return { ...h, idx, price, prev: q?.prev, value, costTot: cost, pl: plCOP ?? value - cost, plPct: basis ? (valueCOP ?? 0) / basis - 1 : cost ? value / cost - 1 : 0, fx: f, valueCOP, plCOP, basisCOP: basis, live: q?.source === "live" };
  });
}
async function portfolioAlerts() {
  if (!state.portfolio.length) return [];
  const vals = await holdingValues().catch(() => []);
  const out = [];
  const tagP = state.pfMode === "practice" ? " (práctica)" : "";
  for (const h of vals) {
    if (h.stop && h.price <= h.stop) out.push({ key: `${h.sym}|stop`, level: "neg", html: `<b>${esc(h.sym)}</b> tocó tu límite de pérdida (${fmtPrice(h.stop)}): considera vender${tagP}`, text: `${h.sym} tocó tu límite de pérdida (${fmtPrice(h.stop)})${tagP}` });
    else if (h.target && h.price >= h.target) out.push({ key: `${h.sym}|target`, level: "pos", html: `<b>${esc(h.sym)}</b> llegó a tu zona de ganancia (${fmtPrice(h.target)}): considera vender una parte${tagP}`, text: `${h.sym} llegó a tu zona de ganancia (${fmtPrice(h.target)})${tagP}` });
    const p = cache.get(h.sym + "|" + state.horizon);
    if (p) { try { const a = await p; if (a.verdict.key === "sell" || a.verdict.key === "reduce") out.push({ key: `${h.sym}|v|${a.verdict.key}`, level: "", html: `Horizon ahora dice <b class="${a.verdict.tone}">${esc(a.verdict.label)}</b> para <b>${esc(h.sym)}</b>, que tienes en tu portafolio`, text: `Horizon ahora dice ${a.verdict.label} para ${h.sym}` }); } catch (e) { /* sin datos */ } }
  }
  return out;
}
// Avisos del sistema mientras la app está abierta (gratis; sin servidor no puede avisar con la app cerrada)
function notifyAlerts(alerts) {
  if (!state.profile.notify || typeof Notification === "undefined" || Notification.permission !== "granted" || !alerts.length) return;
  const today = new Date().toISOString().slice(0, 10);
  const sent = store.get("notified", { day: today, keys: [] });
  if (sent.day !== today) { sent.day = today; sent.keys = []; }
  for (const al of alerts) {
    if (sent.keys.includes(al.key)) continue;
    try { new Notification("Horizon", { body: al.text, icon: "icons/icon-192.png", tag: al.key }); } catch (e) { /* algunos navegadores solo permiten avisos desde un service worker */ }
    sent.keys.push(al.key);
  }
  store.set("notified", sent);
}
const COLORS = ["var(--blue)", "var(--orange)", "var(--green)", "var(--teal)", "var(--red)", "var(--yellow)", "#bf5af2", "#8e8e93"];
const cop = (x) => (x == null || !isFinite(x) ? "—" : (x < 0 ? "−$" : "$") + Math.abs(Math.round(x)).toLocaleString("es-CO"));

async function renderPortafolio(query) {
  currentRoute = "portafolio"; updateNav("portafolio");
  const addSym = (query.get("add") || "").toUpperCase();
  const my = routeToken;
  const P = state.pfMode === "practice";
  const closed = store.get(CLOSED_KEY(), []);
  view.innerHTML = `<section class="hero rise"><div class="eyebrow">${P ? "Simulado · no se compra nada" : "Tus inversiones"}</div><h1 class="title">${P ? "Portafolio de <em>práctica</em>" : "Mi <em>portafolio</em>"}</h1>
      <p class="lead">${P ? `Compra y vende con ${cop(store.get("practice_start", PRACTICE_START))} ficticios para ver cómo te iría, con costos y avisos reales. Nada sale de este dispositivo.` : "Lo que de verdad tienes, cuánto vas ganando y cuándo conviene actuar. Se guarda solo en este dispositivo."}</p>
      <div class="seg pf-mode" id="pf-mode" role="group" aria-label="Tipo de portafolio"><i class="ind"></i><a href="javascript:void(0)" data-v="practice" class="${P ? "on" : ""}">Práctica</a><a href="javascript:void(0)" data-v="real" class="${P ? "" : "on"}">Real</a></div></section>
    <div id="pf-sum"></div><div id="pf-alerts"></div><div id="pf-list"></div><div id="pf-closed"></div>
    <section class="glass card rise pf-form" id="pf-add">
      <details class="how" ${addSym || !state.portfolio.length ? "open" : ""}><summary>${P ? "Hacer una compra simulada" : "Registrar una compra"}</summary>
        <form id="pf-f" autocomplete="off">
          <label><span>Símbolo</span><input name="sym" required maxlength="20" placeholder="AAPL, ECOPETROL.CL…" value="${esc(addSym)}" autocapitalize="characters" spellcheck="false" list="pf-sg"><datalist id="pf-sg"></datalist></label>
          <label><span>Cantidad</span><input name="qty" required inputmode="decimal" placeholder="10"></label>
          <label><span>Precio de compra</span><input name="cost" required inputmode="decimal" placeholder="Se llena solo"></label>
          <label><span>Fecha</span><input name="date" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
          <p class="pf-hint muted" id="pf-hint">${P ? "Se descuenta del efectivo de práctica con la comisión y el costo de cambio de tu perfil. " : ""}Horizon fija tu límite de pérdida y tu zona de ganancia con los modelos.</p>
          <button class="btn" type="submit">${P ? "Comprar (simulado)" : "Guardar"}</button>
        </form></details></section>
    <section class="glass card rise pf-prof"><h3>Tu perfil</h3>
      <div class="pf-row"><span>Tolerancia al riesgo</span><div class="seg" id="pf-risk"><i class="ind"></i>${["baja", "media", "alta"].map((r) => `<a href="javascript:void(0)" data-v="${r}" class="${state.profile.risk === r ? "on" : ""}">${r[0].toUpperCase() + r.slice(1)}</a>`).join("")}</div></div>
      <div class="pf-row"><span>Plazo</span><div class="seg" id="pf-hz"><i class="ind"></i>${[[21, "1 mes"], [63, "3 meses"], [126, "6 meses"]].map(([d, t]) => `<a href="javascript:void(0)" data-v="${d}" class="${state.horizon === d ? "on" : ""}">${t}</a>`).join("")}</div></div>
      <div class="pf-row"><label for="pf-com">Comisión por operación</label><span class="pf-num"><input id="pf-com" inputmode="decimal" value="${String(state.profile.commission).replace(".", ",")}"> %</span></div>
      <div class="pf-row"><label for="pf-fx">Costo de cambiar pesos a otra moneda</label><span class="pf-num"><input id="pf-fx" inputmode="decimal" value="${String(state.profile.fxSpread).replace(".", ",")}"> %</span></div>
      <div class="pf-row"><span>Avisos en este dispositivo</span><button class="chip" id="pf-notify">${state.profile.notify && typeof Notification !== "undefined" && Notification.permission === "granted" ? "✓ Activados" : "Activar"}</button></div>
      ${P ? `<div class="pf-row"><span>Empezar la práctica de nuevo</span><button class="chip" id="pf-reset">Reiniciar</button></div>` : ""}
      <p class="pf-hint muted">El perfil cambia el tamaño sugerido de cada compra (baja 5 %, media 10 %, alta 15 % de lo que tienes para invertir). Los costos se descuentan de los escenarios. Los avisos funcionan mientras Horizon está abierto.</p>
    </section>
    <a class="glass card rise pf-diary interactive" href="#/diario">${ico("chart")}<span><b>Diario de Horizon</b><span class="muted">Revisa si los veredictos acertaron, sin comprar nada</span></span></a>
    ${disclaimer()}`;
  moveInd($("#pf-mode"), "pfm"); moveInd($("#pf-risk"), "pfr"); moveInd($("#pf-hz"), "pfh");
  $("#pf-mode").addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (!b || b.dataset.v === state.pfMode) return; setPfMode(b.dataset.v); renderPortafolio(new URLSearchParams()); });
  $("#pf-risk").addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (!b) return; state.profile.risk = b.dataset.v; saveProfile(); $$("#pf-risk a").forEach((x) => x.classList.toggle("on", x === b)); moveInd($("#pf-risk"), "pfr"); toast("Perfil de riesgo: " + b.dataset.v); });
  $("#pf-hz").addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (!b) return; state.horizon = +b.dataset.v; store.set("horizon", state.horizon); $$("#pf-hz a").forEach((x) => x.classList.toggle("on", x === b)); moveInd($("#pf-hz"), "pfh"); });
  const dec = (v) => { const n = parseFloat(String(v).replace(",", ".")); return isFinite(n) ? n : NaN; };
  $("#pf-com").addEventListener("change", (e) => { const n = dec(e.target.value); if (n >= 0 && n < 10) { state.profile.commission = n; saveProfile(); } });
  $("#pf-fx").addEventListener("change", (e) => { const n = dec(e.target.value); if (n >= 0 && n < 10) { state.profile.fxSpread = n; saveProfile(); } });
  $("#pf-notify").addEventListener("click", async (e) => {
    if (typeof Notification === "undefined") { toast("Este navegador no permite avisos"); return; }
    const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    state.profile.notify = perm === "granted"; saveProfile();
    e.target.textContent = state.profile.notify ? "✓ Activados" : "Activar";
    toast(state.profile.notify ? "Avisos activados" : "El navegador no dio permiso para avisos");
  });
  $("#pf-reset")?.addEventListener("click", () => {
    const was = { pf: state.portfolio.slice(), closed: store.get(CLOSED_KEY(), []), cash: practiceCash() };
    state.portfolio = []; savePortfolio(); store.set(CLOSED_KEY(), []); setPracticeCash(store.get("practice_start", PRACTICE_START));
    renderPortafolio(new URLSearchParams());
    toast("Práctica reiniciada", { label: "Deshacer", fn: () => { state.portfolio = was.pf; savePortfolio(); store.set(CLOSED_KEY(), was.closed); setPracticeCash(was.cash); if (currentRoute === "portafolio") renderPortafolio(new URLSearchParams()); } });
  });
  const feeRate = (cur) => ((+state.profile.commission || 0) + (cur && cur !== "COP" ? (+state.profile.fxSpread || 0) : 0)) / 100;
  // formulario: al escribir el símbolo se sugiere y se llena el precio actual
  const f = $("#pf-f");
  let sgT = 0;
  const fillPx = async () => {
    const s = f.sym.value.trim().toUpperCase(); if (!s) return;
    try { const q = (await getSparks([s]))[s]; if (q && !f.cost.value) f.cost.value = String(+q.price.toPrecision(6)).replace(".", ","); } catch (e) { /* sin precio */ }
  };
  f.sym.addEventListener("input", () => { clearTimeout(sgT); const v = f.sym.value; if (v.trim().length < 2) return; sgT = setTimeout(async () => { const r = await search(v); $("#pf-sg").innerHTML = r.map((x) => `<option value="${esc(x.sym)}">${esc(x.name)}</option>`).join(""); }, 250); });
  f.sym.addEventListener("change", fillPx);
  if (addSym) fillPx();
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const sym = f.sym.value.trim().toUpperCase().replace(/\s+/g, ""), qty = dec(f.qty.value), cost = dec(f.cost.value.replace(/\.(?=\d{3}(\D|$))/g, ""));
    if (!sym || !(qty > 0) || !(cost > 0)) { toast("Revisa el símbolo, la cantidad y el precio"); return; }
    const btn = $("button[type=submit]", f); btn.disabled = true; btn.textContent = "Analizando…";
    let a = null;
    try { a = await analyze(sym); } catch (err) { /* se guarda sin niveles */ }
    const cur = a?.currency || "";
    const fx = await getFxToCOP(cur);
    const basisCOP = fx != null ? qty * cost * fx * (1 + feeRate(cur)) : null;
    if (P) {
      if (basisCOP == null) { toast("No se pudo obtener el tipo de cambio: intenta de nuevo"); btn.disabled = false; btn.textContent = "Comprar (simulado)"; return; }
      if (basisCOP > practiceCash() + 1) { toast(`No alcanza: tienes ${cop(practiceCash())} y esta compra cuesta ${cop(basisCOP)}`); btn.disabled = false; btn.textContent = "Comprar (simulado)"; return; }
    }
    const h = { sym, qty, cost, date: f.date.value, cur, name: a?.name || sym, basisCOP: basisCOP != null ? Math.round(basisCOP) : null, stop: a ? +a.stop.toPrecision(6) : null, target: a ? +(a.target > a.S0 * 1.01 ? a.target : a.range.hi).toPrecision(6) : null, verdictAtBuy: a?.verdict.key || null };
    const cashBefore = practiceCash();
    state.portfolio.push(h); savePortfolio();
    if (P) setPracticeCash(cashBefore - basisCOP);
    toast(P ? `Compra simulada de ${sym}` : `${sym} agregada a tu portafolio`, { label: "Deshacer", fn: () => { state.portfolio = state.portfolio.filter((x) => x !== h); savePortfolio(); if (P) setPracticeCash(cashBefore); if (currentRoute === "portafolio") renderPortafolio(new URLSearchParams()); } });
    location.hash = "#/portafolio";
    if (currentRoute === "portafolio") renderPortafolio(new URLSearchParams());
  });
  const cash = P ? practiceCash() : 0;
  const realized = closed.reduce((a, c) => a + (c.plCOP || 0), 0);
  const closedHTML = closed.length ? `<h2 class="sec">Ventas <small>ganancia realizada ${cop(realized)}</small></h2><div class="wl">${closed.slice(-10).reverse().map((c) => `
      <div class="wl-r pf-r" data-href="#/t/${encodeURIComponent(c.sym)}"><div class="wl-id"><b>${esc(c.sym)}</b><span class="nm">${esc(String(c.qty).replace(".", ","))} · compra ${fmtPrice(c.cost)} → venta ${fmtPrice(c.price)} ${esc(c.cur || "")}</span><span class="wl-v faint">${esc(c.buyDate || "")} → ${esc(c.sellDate || "")}</span></div>
      <div class="wl-px"><b class="${c.plCOP >= 0 ? "pos" : "neg"}">${cop(c.plCOP)}</b><span class="pill ${c.plPct >= 0 ? "pos" : "neg"}">${pct(c.plPct, 1)}</span></div></div>`).join("")}</div>` : "";
  $("#pf-closed").innerHTML = closedHTML;
  if (!state.portfolio.length) {
    $("#pf-sum").innerHTML = P
      ? `<section class="glass card rise pf-sum"><div class="pf-tot"><span class="muted">Efectivo de práctica</span><b>${cop(cash)}</b>${closed.length ? `<span class="${realized >= 0 ? "pos" : "neg"}">${cop(realized)} ganados en ventas</span>` : ""}</div><p class="pf-hint muted">Busca un activo y pulsa «+ Portafolio», o usa el formulario de abajo. Prueba seguir el plan que sugiere Horizon y mira cómo te va.</p></section>`
      : `<div class="glass card rise"><p><b>Aún no tienes compras registradas.</b></p><p class="muted" style="margin-top:4px">Aquí van solo las inversiones que de verdad tengas. Para probar sin dinero, usa «Práctica».</p></div>`;
    return;
  }
  const vals = await holdingValues();
  if (my !== routeToken) return;
  const okCOP = vals.every((v) => v.valueCOP != null);
  const tot = vals.reduce((s, v) => s + (v.valueCOP ?? 0), 0), totPL = vals.reduce((s, v) => s + (v.plCOP ?? 0), 0);
  const totCost = tot - totPL;
  const todayISO = new Date().toISOString().slice(0, 10);
  const day = vals.reduce((s, v) => s + (v.prev && v.valueCOP != null && v.date !== todayISO ? (v.price - v.prev) * v.qty * v.fx : 0), 0); // lo comprado hoy no cuenta en el cambio del día
  // concentración: por activo, por región y en cripto (sobre lo invertido, sin contar el efectivo)
  const w = vals.map((v) => ({ sym: v.sym, w: tot ? (v.valueCOP ?? 0) / tot : 0, region: regionOf(v.sym) })).sort((x, y) => y.w - x.w);
  const byReg = {}; for (const x of w) byReg[x.region] = (byReg[x.region] || 0) + x.w;
  const warns = [];
  if (w[0] && w[0].w > 0.3 && w.length > 1) warns.push(`${w[0].sym} pesa ${Math.round(w[0].w * 100)} % de lo invertido: si le va mal, te afecta mucho.`);
  if (w.length === 1) warns.push("Todo lo invertido está en un solo activo. Repartirlo en varios baja el riesgo.");
  for (const [r, x] of Object.entries(byReg)) if (x > 0.7 && w.length > 2) warns.push(`${Math.round(x * 100)} % está en ${REGION_NAMES[r]}. Mirar otras regiones diversifica.`);
  if ((byReg.CRYPTO || 0) > 0.15) warns.push(`Las criptomonedas son ${Math.round(byReg.CRYPTO * 100)} % del total: suelen caer más de 50 % en malos años.`);
  const start = store.get("practice_start", PRACTICE_START), equity = tot + cash;
  $("#pf-sum").innerHTML = `<section class="glass card rise pf-sum">
      ${P ? `<div class="pf-tot"><span class="muted">Total de la práctica (efectivo + inversiones)</span><b>${okCOP ? cop(equity) : "—"}</b><span class="${equity - start >= 0 ? "pos" : "neg"}">${cop(equity - start)} (${pct(equity / start - 1, 1)}) desde que empezaste</span>${day ? `<span class="${day >= 0 ? "pos" : "neg"} muted-s">${cop(day)} hoy</span>` : ""}</div>
        <div class="pf-split"><span><span class="muted">Invertido</span><b>${okCOP ? cop(tot) : "—"}</b></span><span><span class="muted">Efectivo</span><b>${cop(cash)}</b></span><span><span class="muted">Abiertas</span><b class="${totPL >= 0 ? "pos" : "neg"}">${cop(totPL)}</b></span></div>`
      : `<div class="pf-tot"><span class="muted">Valor total</span><b>${okCOP ? cop(tot) : "—"}</b><span class="${totPL >= 0 ? "pos" : "neg"}">${cop(totPL)} (${pct(totCost ? totPL / totCost : 0, 1)}) desde la compra</span>${day ? `<span class="${day >= 0 ? "pos" : "neg"} muted-s">${cop(day)} hoy</span>` : ""}</div>`}
      <div class="alloc" role="img" aria-label="Reparto de lo invertido">${w.map((x, i) => `<i style="width:${(x.w * 100).toFixed(2)}%;background:${COLORS[i % COLORS.length]}" title="${esc(x.sym)} ${Math.round(x.w * 100)} %"></i>`).join("")}</div>
      <div class="alloc-l">${w.map((x, i) => `<span><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(x.sym)} ${Math.round(x.w * 100)} %</span>`).join("")}</div>
      ${warns.length ? `<div class="flags">${warns.map((t) => `<div class="flag">${ico("shield")}<span>${esc(t)}</span></div>`).join("")}</div>` : ""}
      ${okCOP ? "" : `<p class="pf-hint muted">No se pudo obtener el tipo de cambio de alguna moneda; esos activos no suman en pesos.</p>`}
      <p class="pf-hint muted">En pesos colombianos al cambio de hoy, con comisiones${vals.some((v) => !v.live) ? " · algunos precios son de datos guardados" : ""}.</p></section>`;
  $("#pf-list").innerHTML = `<h2 class="sec">Posiciones</h2><div class="wl">${vals.map((v) => `
    <div class="wl-r pf-r" data-href="#/t/${encodeURIComponent(v.sym)}">
      <div class="wl-id"><b>${esc(v.sym)}</b><span class="nm">${esc(v.qty.toLocaleString("es-CO"))} × ${fmtPrice(v.cost)} ${esc(v.cur || "")}</span><span class="wl-v" data-pfv="${esc(v.sym)}"><span class="faint">Límite ${v.stop ? fmtPrice(v.stop) : "—"} · Ganancia ${v.target ? fmtPrice(v.target) : "—"}</span></span></div>
      <div class="wl-px"><b>${v.valueCOP != null ? cop(v.valueCOP) : fmtPrice(v.value) + " " + esc(v.cur)}</b><span class="pill ${v.pl >= 0 ? "pos" : "neg"}">${pct(v.plPct, 1)}</span><button class="chip pf-sell" data-pfsell="${v.idx}">${P ? "Vender" : "Registrar venta"}</button></div>
      <button class="rm" data-pfrm="${v.idx}" aria-label="Borrar ${esc(v.sym)} sin registrar venta">×</button></div>`).join("")}</div>`;
  $("#pf-list").addEventListener("click", (e) => {
    const sell = e.target.closest("[data-pfsell]"), rm = e.target.closest("[data-pfrm]");
    if (!sell && !rm) return;
    e.stopPropagation(); e.preventDefault();
    const i = +(sell || rm).dataset[sell ? "pfsell" : "pfrm"], h = state.portfolio[i];
    if (!h) return;
    const was = { pf: state.portfolio.slice(), closed: store.get(CLOSED_KEY(), []), cash: practiceCash() };
    const undo = () => { state.portfolio = was.pf; savePortfolio(); store.set(CLOSED_KEY(), was.closed); if (P) setPracticeCash(was.cash); if (currentRoute === "portafolio") renderPortafolio(new URLSearchParams()); };
    if (rm) { state.portfolio.splice(i, 1); savePortfolio(); renderPortafolio(new URLSearchParams()); toast(`${h.sym} borrada (sin venta)`, { label: "Deshacer", fn: undo }); return; }
    // vender al precio actual: el dinero vuelve al efectivo (práctica) y la ganancia queda registrada
    const v = vals.find((x) => x.idx === i);
    if (!v || v.fx == null) { toast("No se pudo obtener el precio o el cambio: intenta de nuevo"); return; }
    const proceeds = v.qty * v.price * v.fx * (1 - feeRate(v.cur));
    const basis = v.basisCOP ?? v.qty * v.cost * v.fx;
    const c = { sym: h.sym, qty: h.qty, cost: h.cost, price: +v.price.toPrecision(6), cur: h.cur, buyDate: h.date, sellDate: new Date().toISOString().slice(0, 10), plCOP: Math.round(proceeds - basis), plPct: proceeds / basis - 1 };
    state.portfolio.splice(i, 1); savePortfolio();
    store.set(CLOSED_KEY(), [...was.closed, c]);
    if (P) setPracticeCash(was.cash + proceeds);
    renderPortafolio(new URLSearchParams());
    toast(`${P ? "Venta simulada" : "Venta registrada"}: ${h.sym} ${c.plCOP >= 0 ? "+" : "−"}${cop(Math.abs(c.plCOP)).replace("−", "")}`, { label: "Deshacer", fn: undo });
  }, { capture: true });
  // veredicto actual de cada posición y avisos
  mapLimit([...new Set(vals.map((v) => v.sym))], 3, async (sym) => {
    try { const a = await analyze(sym); if (my !== routeToken) return; $$(`[data-pfv="${CSS.escape(sym)}"]`).forEach((el) => el.insertAdjacentHTML("afterbegin", `${verdictChip(a.verdict)} · `)); } catch (e) { /* sin datos */ }
  }).then(async () => {
    if (my !== routeToken) return;
    const al = await portfolioAlerts();
    notifyAlerts(al);
    if (al.length) $("#pf-alerts").innerHTML = `<div class="brief glass rise">${al.map((l) => `<div class="br-l ${l.level}">${ico(l.level === "neg" ? "shield" : "bell")}<span>${l.html}</span></div>`).join("")}</div>`;
  });
}

// ----- Diario de Horizon: lo que dijo y qué pasó después -----
const dayStr = (d, opt = { day: "numeric", month: "short", year: "numeric" }) => new Date(d * 86400000).toLocaleDateString("es-CO", { timeZone: "UTC", ...opt });
async function renderDiario() {
  currentRoute = "diario"; updateNav("portafolio");
  const my = routeToken;
  view.innerHTML = `<a class="back" href="#/portafolio">${ico("back")}Portafolio</a>
    <section class="hero rise" style="padding-top:.5rem"><div class="eyebrow">La prueba en vivo</div><h1 class="title">Diario de <em>Horizon</em></h1>
      <p class="lead">Cada vez que abres un activo, Horizon anota lo que dijo. Al pasar 1 y 3 meses revisa qué pasó de verdad. Tú no compras nada: solo ves si la app acierta.</p></section>
    <div id="jr"><div class="skeleton" style="height:120px;border-radius:18px"></div></div>${disclaimer()}`;
  let updated = 0;
  try { updated = await journalEvaluate(); } catch (e) { /* sin conexión: se muestra lo que hay */ }
  if (my !== routeToken) return;
  const list = journalEntries();
  const rt = (e) => 2 * ((+state.profile.commission || 0) + (e.cur && e.cur !== "COP" ? (+state.profile.fxSpread || 0) : 0)) / 100;
  const sm = journalSummary(list, rt);
  const tableFor = (h) => {
    const rows = sm.rows[h].filter((r) => r.n);
    if (!rows.length) return `<p class="muted jr-empty">Todavía no hay resultados a ${h === 21 ? "1 mes" : "3 meses"}.${sm.total ? ` Los primeros llegan alrededor del ${dayStr((sm.since ?? 0) + Math.ceil(h * 1.4), { day: "numeric", month: "long" })}.` : ""}</p>`;
    return `<div class="rank bt"><div class="r h bt-r"><span>Veredicto</span><span class="num">Casos</span><span class="num">Subió</span><span class="num">Rend. medio</span><span class="num hide-m">Vs. S&P 500</span></div>${rows.map((r) => `<div class="r bt-r"><span class="${{ buy: "pos2", accumulate: "pos1", hold: "neu", reduce: "neg1", sell: "neg2" }[r.key]}">${esc(r.label)}</span><span class="num">${r.n}</span><span class="num">${Math.round(r.hit * 100)} de 100</span><span class="num ${r.mean >= 0 ? "pos" : "neg"}">${pct(r.mean, 1)}</span><span class="num hide-m ${r.excess == null ? "" : r.excess >= 0 ? "pos" : "neg"}">${r.excess == null ? "—" : pct(r.excess, 1)}</span></div>`).join("")}</div>`;
  };
  const recent = list.slice(-25).reverse();
  const today = Math.floor(Date.now() / 86400000);
  const status = (e) => {
    const o3 = e.out?.[63], o1 = e.out?.[21];
    if (o3) return `<span class="pill ${o3.r >= 0 ? "pos" : "neg"}">${pct(o3.r, 1)}</span><span class="faint jr-s">3 meses${o3.stopHit ? " · tocó el límite" : ""}</span>`;
    if (o1) return `<span class="pill ${o1.r >= 0 ? "pos" : "neg"}">${pct(o1.r, 1)}</span><span class="faint jr-s">1 mes · falta el de 3</span>`;
    const left = Math.max(0, e.day + Math.ceil(21 * 1.4) - today);
    return `<span class="pill">En curso</span><span class="faint jr-s">${left ? `1.er resultado en ${left} días` : "listo pronto"}</span>`;
  };
  const pl = sm.plan;
  $("#jr").innerHTML = `
    <section class="glass card rise pf-sum">
      <div class="pf-split"><span><span class="muted">Anotaciones</span><b>${sm.total}</b></span><span><span class="muted">Activos</span><b>${sm.assets}</b></span><span><span class="muted">Desde</span><b>${sm.since != null ? dayStr(sm.since, { day: "numeric", month: "short" }) : "—"}</b></span></div>
      <p class="pf-hint muted">Una anotación por activo por semana (o antes si cambia el veredicto). Se guarda solo en este dispositivo.${updated ? ` Hoy se completaron ${updated} resultados.` : ""}</p>
    </section>
    <h2 class="sec">Marcador a 3 meses</h2>${tableFor(63)}
    <h2 class="sec">Marcador a 1 mes</h2>${tableFor(21)}
    <h2 class="sec">Si hubieras seguido los planes</h2>
    <section class="glass card rise">${pl.n
      ? `<p class="jr-big ${pl.pl >= 0 ? "pos" : "neg"}">${cop(pl.pl)}</p><p class="muted">Con $1.000.000 en cada «Comprar» o «Comprar de a poco» (${pl.n} casos), saliendo en el límite de pérdida si se tocaba y si no a los 3 meses, ya con costos. Ganaron ${pl.wins} de ${pl.n}. Comprando el S&P 500 en las mismas fechas: <b class="${pl.plBench >= 0 ? "pos" : "neg"}">${cop(pl.plBench)}</b>.</p>`
      : `<p class="muted">Aparecerá cuando haya compras sugeridas con 3 meses de historia. Mientras tanto puedes practicar en el <a class="lnk" href="#/portafolio">portafolio de práctica</a>.</p>`}</section>
    <h2 class="sec">Últimas anotaciones</h2>
    ${recent.length ? `<div class="wl">${recent.map((e) => `<a class="wl-r interactive" href="#/t/${encodeURIComponent(e.sym)}"><div class="wl-id"><b>${esc(e.sym)}</b><span class="nm">${dayStr(e.day)} · ${fmtPrice(e.price)} ${esc(e.cur)}</span><span class="wl-v"><span class="verdict ${e.tone}">${esc(e.label)}</span></span></div><div class="wl-px">${status(e)}</div></a>`).join("")}</div>`
      : `<div class="glass card"><p class="muted">Aún no hay anotaciones. Abre cualquier activo o tu lista en «Mi lista» y Horizon empezará a anotar.</p></div>`}
    <div class="jr-tools"><button class="chip" id="jr-exp">Exportar copia</button><label class="chip" for="jr-imp">Importar copia</label><input type="file" id="jr-imp" accept="application/json,.json" hidden><button class="chip" id="jr-del">Borrar diario</button></div>
    <p class="disc-note">Exporta una copia de vez en cuando: si borras los datos del navegador, el diario se pierde.</p>`;
  $("#jr-exp").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ app: "Horizon", kind: "diario", exported: new Date().toISOString(), entries: journalEntries(), practice: { portfolio: store.get("portfolio_practice", []), closed: store.get("closed_practice", []), cash: practiceCash() } }, null, 1)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `horizon-diario-${new Date().toISOString().slice(0, 10)}.json`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $("#jr-imp").addEventListener("change", async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      const j = JSON.parse(await file.text());
      if (!Array.isArray(j.entries)) throw new Error("formato");
      const was = journalEntries();
      const byId = new Map([...was, ...j.entries].filter((x) => x && x.id && x.sym).map((x) => [x.id, x]));
      journalReplace([...byId.values()].sort((a, b) => a.day - b.day));
      toast(`Diario importado: ${byId.size} anotaciones`, { label: "Deshacer", fn: () => { journalReplace(was); if (currentRoute === "diario") renderDiario(); } });
      renderDiario();
    } catch (err) { toast("Ese archivo no es una copia del diario de Horizon"); }
  });
  $("#jr-del").addEventListener("click", () => {
    const was = journalEntries(); journalClear(); renderDiario();
    toast("Diario borrado", { label: "Deshacer", fn: () => { journalReplace(was); if (currentRoute === "diario") renderDiario(); } });
  });
}

// ----- Comparar (rendimiento de 1 año en la misma escala) -----
async function renderComparar(list) {
  currentRoute = "comparar"; updateNav("comparar");
  const syms = [...new Set(list.map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 4);
  view.innerHTML = `<a class="back" href="javascript:history.back()">${ico("back")}Atrás</a>
    <section class="hero rise" style="padding-top:.5rem"><h1 class="title">Comparar</h1><p class="lead">Cuánto habría crecido el mismo dinero en cada activo durante el último año.</p></section>
    <div class="chips-row" id="cmp-chips">${syms.map((s, i) => `<span class="chip cmp-chip"><i style="background:${COLORS[i]}"></i>${esc(s)}${syms.length > 1 ? `<button data-cmprm="${esc(s)}" aria-label="Quitar ${esc(s)}">×</button>` : ""}</span>`).join("")}
      ${syms.length < 4 ? `<form id="cmp-add" class="cmp-add"><input placeholder="+ Agregar" aria-label="Agregar un símbolo para comparar, por ejemplo MSFT" maxlength="20" autocapitalize="characters" spellcheck="false"></form>` : ""}</div>
    <div class="glass chartcard rise" id="cmp-chart"><div class="skeleton" style="height:240px;border-radius:12px"></div></div>
    <div class="rank rise" id="cmp-tab" style="margin-top:14px"></div>${disclaimer()}`;
  $("#cmp-chips").addEventListener("click", (e) => { const b = e.target.closest("[data-cmprm]"); if (b) location.hash = "#/comparar/" + syms.filter((x) => x !== b.dataset.cmprm).map(encodeURIComponent).join(","); });
  $("#cmp-add")?.addEventListener("submit", (e) => { e.preventDefault(); const v = $("input", e.target).value.trim().toUpperCase(); if (v) location.hash = "#/comparar/" + [...syms, v].map(encodeURIComponent).join(","); });
  const my = routeToken;
  const got = await Promise.all(syms.map((s) => getSeries(s).then((x) => x, () => null)));
  if (my !== routeToken) return;
  const ok = syms.map((s, i) => ({ s, ser: got[i], color: COLORS[i] })).filter((x) => x.ser);
  if (!ok.length) { $("#cmp-chart").innerHTML = `<p class="muted">No se pudieron cargar los datos.</p>`; return; }
  // eje de tiempo: últimos ~365 días del primero; cada serie toma su último precio conocido en cada fecha
  const end = Math.max(...ok.map((x) => x.ser.t[x.ser.t.length - 1])), start = end - 365 * 86400;
  const grid = ok[0].ser.t.filter((t) => t >= start);
  const lines = ok.map((x) => {
    let j = 0; const vals = [];
    for (const t of grid) { while (j + 1 < x.ser.t.length && x.ser.t[j + 1] <= t) j++; vals.push(x.ser.t[j] <= t ? x.ser.c[j] : null); }
    const b = vals.find((v) => v != null);
    return { ...x, pts: vals.map((v) => (v == null ? null : v / b - 1)) };
  });
  const W = Math.round(Math.min(720, Math.max(320, ($("#cmp-chart")?.clientWidth || 720) - 24))), Hh = W < 500 ? 220 : 260, pl = 46, pr = 12, pt = 12, pb = 26; // ancho real: el texto no se encoge en el celular
  const all = lines.flatMap((l) => l.pts.filter((v) => v != null));
  const lo = Math.min(0, ...all), hi = Math.max(0, ...all), pad = (hi - lo) * 0.08 || 0.05;
  const y = (v) => pt + (1 - (v - lo + pad) / (hi - lo + 2 * pad)) * (Hh - pt - pb);
  const x = (i) => pl + (i / Math.max(1, grid.length - 1)) * (W - pl - pr);
  const ticks = []; const step = (hi - lo) > 1 ? 0.5 : (hi - lo) > 0.4 ? 0.2 : (hi - lo) > 0.15 ? 0.05 : 0.02;
  for (let v = Math.ceil((lo - pad) / step) * step; v <= hi + pad; v += step) ticks.push(v);
  const months = []; let lastM = -1;
  grid.forEach((t, i) => { const d = new Date(t * 1000); if (d.getUTCMonth() !== lastM && d.getUTCDate() <= 7) { lastM = d.getUTCMonth(); if (i > 10 && i < grid.length - 10) months.push([i, d.toLocaleDateString("es-CO", { month: "short", timeZone: "UTC" })]); } });
  $("#cmp-chart").innerHTML = `<h3>Rendimiento en 1 año</h3><svg class="pxc-svg" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Comparación del rendimiento de ${ok.map((l) => l.s).join(", ")}">
    ${ticks.map((v) => `<line class="pxc-grid" x1="${pl}" x2="${W - pr}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="pxc-ytx" x="${pl - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v > 0 ? "+" : ""}${Math.round(v * 100)} %</text>`).join("")}
    <line class="pxc-ref" x1="${pl}" x2="${W - pr}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>
    ${months.map(([i, m]) => `<text class="pxc-xtx" x="${x(i).toFixed(1)}" y="${Hh - 6}" text-anchor="middle">${m}</text>`).join("")}
    ${lines.map((l) => `<path class="pxc-line" stroke="${l.color}" d="${l.pts.map((v, i) => (v == null ? "" : `${i && l.pts[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join("")}"/>`).join("")}
  </svg>`;
  const rows = await Promise.all(lines.map(async (l) => {
    const c = l.ser.c.filter((_, i) => l.ser.t[i] >= start);
    let peak = c[0], mdd = 0; for (const v of c) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
    const r = []; for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]));
    const m = r.reduce((p, v) => p + v, 0) / r.length, vol = Math.sqrt(r.reduce((p, v) => p + (v - m) ** 2, 0) / (r.length - 1) * (regionOf(l.s) === "CRYPTO" ? 365 : 252));
    let a = null; try { a = await analyze(l.s); } catch (e) { /* índices o sin datos */ }
    return { ...l, ret: c[c.length - 1] / c[0] - 1, mdd, vol, a };
  }));
  if (my !== routeToken) return;
  $("#cmp-tab").innerHTML = `<div class="r h cmp-r"><span>Activo</span><span class="num">1 año</span><span class="num hide-m">Peor caída</span><span class="num hide-m">Volatilidad</span><span>Veredicto</span></div>` +
    rows.map((r) => `<div class="r cmp-r interactive" data-href="#/t/${encodeURIComponent(r.s)}"><span class="nm"><b><i class="cmp-dot" style="background:${r.color}"></i>${esc(r.s)}</b><span>${esc(r.ser.name)}</span></span><span class="num ${r.ret >= 0 ? "pos" : "neg"}">${pct(r.ret, 0)}</span><span class="num hide-m neg">${pct(r.mdd, 0)}</span><span class="num hide-m">${Math.round(r.vol * 100)} %</span><span>${r.a ? verdictChip(r.a.verdict) : '<span class="faint">—</span>'}</span></div>`).join("");
}

// ----- Método -----
function renderMetodo() {
  currentRoute = "metodo"; updateNav("metodo");
  const cards = [
    ["merton", "bolt", "var(--orange)", "Saltos de Merton (1976)", "El precio no solo vibra: también da saltos cuando llega información importante.", "dS/S = (μ − λk)dt + σ dW + (J − 1)dN", "Estimamos σ, λ, μJ y δ por máxima verosimilitud con los rendimientos diarios y simulamos 20.000 escenarios a tu horizonte. Obtenemos la probabilidad de subir, el rango p10–p90, la pérdida media del peor 5 % y el precio de una opción con saltos.", "Con pocos saltos en la muestra el modelo se parece a Black–Scholes. La deriva histórica es ruidosa, por eso se mezcla 30 % con el rendimiento exigido por CAPM."],
    ["meanrev", "wave", "var(--purple)", "Reversión a la media", "Cuando un precio se aleja mucho de su nivel de equilibrio, tiende a volver.", "du = −κ·u·dt + σ·dW", "Quitamos la tendencia del log-precio, ajustamos un proceso de Ornstein–Uhlenbeck a la desviación y calculamos vida media, z-score, precio objetivo y una prueba de Dickey–Fuller para saber si la reversión es real.", "En acciones con tendencia fuerte la reversión es débil; por eso su peso se ajusta por la significancia de la prueba."],
    ["realoptions", "tree", "var(--teal)", "Opciones reales", "Invertir es como ejercer una opción: esperar y tener una salida preparada tienen valor.", "Diferir = Call americana(V, I) · Abandonar = Put americana(V, (1−L)I)", "Un árbol binomial (CRR) con 80 pasos valora la opción de diferir y la de abandonar. De ahí salen el precio máximo de compra y el piso de protección, con el costo de esperar igual al rendimiento esperado que se deja de ganar.", "Está adaptado a acciones (reversibles): el margen exigido se limita a la volatilidad del horizonte. Es un modelo de apoyo para entrar y salir, no un pronóstico."],
    ["vasicek", "rate", "var(--blue)", "Vasicek (1977)", "Las tasas de interés siempre tienden a volver a un promedio de equilibrio.", "dr = a(b − r)dt + σ dW", "Ajustamos Vasicek a los bonos del Tesoro (3 meses, 5, 10 y 30 años) con regresión AR(1) exacta. Proyectamos las tasas, obtenemos la tasa libre de riesgo esperada que usan los demás modelos, medimos la sensibilidad de la acción a las tasas y valoramos bonos con fórmula cerrada.", "Permite tasas negativas y no incluye prima de plazo. Para todos los mercados se usa como referencia la curva de EE. UU. porque Yahoo no ofrece curvas de otros países."],
    ["herding", "crowd", "var(--green)", "Comportamiento en manada", "A veces los inversionistas se imitan entre sí y los precios se mueven en bloque.", "CSAD = α + γ₁|Rm| + γ₂Rm² + ε", "Con una canasta de acciones de la misma región (hasta 25) calculamos la dispersión diaria de rendimientos y la regresión de Chang, Cheng y Khorana con errores robustos. Si γ₂ es negativo y significativo hay manada; según la dirección del mercado resta (burbuja) o suma (pánico).", "Es un fenómeno ocasional: la mayoría de los días no hay evidencia, y entonces el modelo no empuja el veredicto. La canasta usa datos guardados al compilar la aplicación."],
    ["gbm", "chart", "var(--blue)", "Browniano geométrico (GBM)", "La base: el precio crece con una tendencia y vibra al azar, sin saltos.", "dS = μS·dt + σS·dW", "Estimamos tendencia y volatilidad con 3 años de datos y calculamos en forma exacta la probabilidad de subir, el rango y el riesgo de cola. Sirve para comparar: lo que el GBM no ve son los saltos.", "Supone rendimientos normales; casi ninguna acción los tiene (la prueba de Jarque–Bera suele rechazarlo), por eso subestima las caídas bruscas."],
    ["bs", "shield", "var(--teal)", "Black–Scholes (1973)", "Le pone precio al riesgo: cuánto cuesta asegurarse contra una caída o apostar a una subida.", "C = S·N(d₁) − K·e^(−rT)·N(d₂)", "Con la volatilidad del último año valoramos opciones de compra y venta al horizonte elegido, el seguro contra caídas de 10 % y el movimiento típico esperado.", "Hereda los supuestos del GBM (volatilidad constante, sin saltos). No opina sobre la dirección."],
    ["kou", "bolt", "var(--orange)", "Saltos de Kou (2002)", "Como Merton, pero las caídas y las subidas bruscas pueden tener tamaños distintos.", "ln V ~ p·Exp(η₁) − (1 − p)·Exp(η₂)", "Detectamos los saltos (días a más de 3 desviaciones robustas), estimamos por separado frecuencia y tamaño de subidas y caídas, y simulamos 20.000 escenarios.", "Con pocos saltos en la muestra las estimaciones son inestables; por eso su confianza es menor."],
    ["fractal", "wave", "var(--green)", "Fractales y browniano fraccional", "¿El precio tiene memoria? El exponente de Hurst lo mide.", "F(s) ∝ s^H · D = 2 − H", "Calculamos el exponente de Hurst con DFA y con R/S, la dimensión fractal y un rango con browniano fraccional (dispersión que crece como t^H). Si hay memoria sigue la tendencia; si se devuelve, espera rebote.", "Con 3 años de datos diarios el exponente tiene error de varias centésimas; valores entre 0,45 y 0,55 se tratan como azar."],
  ];
  view.innerHTML = `<section class="hero rise"><div class="eyebrow">Transparencia</div><h1 class="title">Cómo <em>decide</em> Horizon</h1><p class="lead">La tendencia decide la dirección y los modelos ponen los precios y el riesgo. Abajo está la prueba con 10 años de datos.</p></section>
  ${cards.map(([k, i, c, t, idea, f, how, lim], n) => `<div class="glass mcard rise" style="--c:${c};--i:${n}"><h3><span class="ico">${ico(i)}</span>${t}</h3><p class="explain"><b>${idea}</b></p><details class="how"><summary>Cómo funciona</summary><div class="formula">${f}</div><h4>Cómo lo usamos</h4><p class="explain">${how}</p><h4>Límites</h4><p class="explain">${lim}</p></details></div>`).join("")}
  <div class="glass mcard rise"><h3><span class="ico" style="--c:var(--blue)">${ico("trophy")}</span>Cómo se arma el veredicto</h3>
    <p class="explain"><b>La tendencia decide si comprar, esperar o vender. Los cinco modelos ponen el rango, el límite de pérdida, la zona de ganancia y el nivel de riesgo.</b></p><details class="how"><summary>Ver fórmulas, umbrales y datos</summary><h4>Versión actual: la tendencia</h4><p class="explain">Desde el backtest, la dirección del veredicto la decide la <b>tendencia</b> (momentum de 12 meses frente a su canasta regional, fuerza relativa a 6 meses y si subió o bajó en el año, con un castigo si está más nerviosa de lo normal). Umbrales: Comprar ≥ 0,45 · Comprar de a poco ≥ 0,20 · Esperar · Vender una parte ≤ −0,20 · Vender ≤ −0,45. Los 5 modelos fijan el rango, el precio objetivo, la compra máxima, el piso de protección y el nivel de riesgo.</p><h4>Opinión de los 5 modelos (versión 1, hoy segunda opinión)</h4><div class="formula">S = Σ wᵢ · cᵢ · sᵢ / Σ wᵢ · pesos: ${Object.entries(WEIGHTS).map(([k, w]) => `${MODEL_NAMES[k]} ${Math.round(w * 100)} %`).join(", ")}</div>
    <p class="explain">Cada señal sᵢ se multiplica por la confianza cᵢ del modelo, de modo que un modelo poco fiable pesa menos. La suma se lleva a la escala −1 a +1 y se traduce así: <b>Comprar</b> (≥ 0,30), <b>Comprar de a poco</b> (0,12 a 0,30), <b>Esperar</b> (−0,12 a 0,12), <b>Vender una parte</b> (−0,30 a −0,12) y <b>Vender</b> (≤ −0,30). Si el riesgo de caída brusca es alto, una compra se rebaja a "Comprar con cautela". El precio objetivo mezcla el centro de Merton con el equilibrio de la reversión (según su fiabilidad).</p>
    <h4>Datos</h4><p class="explain">Precios diarios ajustados de Yahoo Finance (3 años) para cualquier símbolo del mundo, y bonos del Tesoro de EE. UU. (^IRX, ^FVX, ^TNX, ^TYX). Si Yahoo no responde, la aplicación usa datos reales guardados de unos 100 activos y lo indica arriba a la derecha.</p></details></div>
  <div id="bt"></div>
  ${disclaimer()}`;
  getTrackRecord().then((t) => { if (t && $("#bt")) $("#bt").innerHTML = backtestCard(t); });
}

function backtestCard(t) {
  const row = (r) => `<div class="r bt-r"><span>${esc(r.label)}</span><span class="num">${r.n.toLocaleString("es-CO")}</span><span class="num">${Math.round(r.hit * 100)} de 100</span><span class="num ${r.mean >= 0 ? "pos" : "neg"}">${pct(r.mean, 1)}</span><span class="num hide-m ${r.excess >= 0 ? "pos" : "neg"}">${pct(r.excess, 1)}</span></div>`;
  const head = `<div class="r h bt-r"><span>Veredicto</span><span class="num">Casos</span><span class="num">Subió</span><span class="num">Rend. medio</span><span class="num hide-m">Vs. mercado</span></div>`;
  const s = t.strategies || {}, m = t.models || {};
  return `<div class="glass mcard rise"><h3><span class="ico" style="--c:var(--green)">${ico("chart")}</span>¿Funciona? La prueba con datos del pasado</h3>
    <p class="explain"><b>Se recalculó lo que Horizon habría dicho cada mes entre ${t.oos.from.slice(0, 4)} y ${t.oos.to.slice(0, 4)} en ${t.nAssets} activos, usando solo la información disponible en cada fecha, y se miró qué pasó 3 meses después (${t.oos.n.toLocaleString("es-CO")} casos).</b></p>
    <details class="how"><summary>Ver los resultados</summary>
      <h4>Versión actual: la tendencia decide</h4><div class="rank bt">${head}${t.byVerdict.map(row).join("")}</div>
      <h4>Versión anterior: los 5 modelos decidían</h4><div class="rank bt">${head}${(t.byVerdict5 || []).map(row).join("")}</div>
      <p class="explain">Con la versión anterior, «Comprar» rendía menos que «Vender»: la señal iba al revés. Con la tendencia el orden es el correcto (los «Comprar» suben más seguido que los «Vender»), pero la ventaja frente al mercado es pequeña (${pct(s.v2Buy?.excess ?? 0, 1)} cada 3 meses) y no es estadísticamente segura (correlación de rangos ${(t.ic?.trend?.ic ?? 0).toFixed(3).replace(".", ",")}, t ≈ ${(t.ic?.trend?.t ?? 0).toFixed(1).replace(".", ",")}).</p>
      <h4>Lo que sí funciona bien: medir el riesgo</h4>
      <p class="explain">El rango «si va mal / si va bien» debía contener el precio final 80 de cada 100 veces y lo hizo <b>${Math.round((t.coverage?.inside ?? 0) * 100)}</b>. Por eso el plan usa los modelos para el límite de pérdida, la zona de ganancia y el tamaño de la compra.</p>
      <h4>¿Y con inteligencia artificial?</h4>
      <p class="explain">Se entrenó una regresión logística y un random forest con las señales, siempre avanzando en el tiempo. No mejoraron: AUC ${(m.logit_all?.auc ?? 0).toFixed(2).replace(".", ",")} y ${(m.rf?.auc ?? 0).toFixed(2).replace(".", ",")} (0,50 es azar). Con precios de acciones es fácil que un modelo memorice el pasado y falle con datos nuevos, así que no se usan.</p>
      <h4>La prueba en vivo</h4><p class="explain">El <a class="lnk" href="#/diario">Diario de Horizon</a> anota lo que la app dice desde hoy y mide qué pasa después, para confirmar (o no) estos resultados con datos que el modelo nunca vio.</p>
      <h4>Límites</h4><p class="explain">Solo empresas que existen hoy (sesgo de sobrevivencia); una década mayormente alcista; sin costos en la prueba; 3 meses de horizonte. Que algo haya funcionado no garantiza que siga funcionando.</p>
    </details></div>`;
}

// ---------- movimiento e interacción (Apple Design) ----------
// Indicador de los controles segmentados: resorte interrumpible (parte del valor y la velocidad actuales)
function moveInd(seg, key) {
  const ind = $(".ind", seg), on = $("a.on", seg);
  if (!ind || !on) return;
  const tx = on.offsetLeft, w = on.offsetWidth;
  if (!ind.dataset.ready) { ind.style.width = w + "px"; ind.style.transform = `translateX(${tx}px)`; ind.dataset.x = tx; ind.dataset.w = w; ind.dataset.ready = "1"; return; }
  spring(key + "x", { from: +ind.dataset.x, to: tx, response: 0.42, damping: 0.9, onUpdate: (x) => { ind.style.transform = `translateX(${x}px)`; ind.dataset.x = x; } });
  spring(key + "w", { from: +ind.dataset.w, to: w, response: 0.42, damping: 0.9, onUpdate: (x) => { ind.style.width = x + "px"; ind.dataset.w = x; } });
}

// Aviso con acción "Deshacer" (retroalimentación de estado + perdón de errores)
const toastEl = document.createElement("div");
toastEl.className = "glass toast"; toastEl.setAttribute("role", "status"); toastEl.setAttribute("aria-live", "polite");
document.body.append(toastEl);
let toastT = 0;
function hideToast() {
  toastEl.classList.remove("on");
  spring("toast", { from: 0, to: 80, response: 0.4, onUpdate: (y) => { toastEl.style.transform = `translate(-50%, ${y}px)`; } });
}
function toast(msg, action) {
  toastEl.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="undo">${esc(action.label)}</button>` : ""}`;
  toastEl.classList.add("on");
  spring("toast", { from: 70, to: 0, response: 0.45, onUpdate: (y) => { toastEl.style.transform = `translate(-50%, ${y}px)`; } });
  const undo = $(".undo", toastEl);
  if (undo) undo.onclick = () => { clearTimeout(toastT); hideToast(); action.fn(); };
  clearTimeout(toastT); toastT = setTimeout(hideToast, 5200);
}

// Medidores: la perilla llega al valor con un resorte casi crítico
let gid = 0;
function animateGauges(root) {
  for (const g of $$(".gauge:not([data-anim])", root)) {
    g.dataset.anim = "1";
    const th = $(".thumb", g), to = ((+g.dataset.v + 1) / 2) * 100, key = "g" + ++gid;
    th.style.left = "50%";
    spring(key, { from: 50, to, response: 0.75, damping: 0.88, onUpdate: (p) => { th.style.left = p + "%"; } });
  }
}
// Tarjetas navegables: accesibles con teclado
function a11yLinks(root) { for (const el of $$("[data-href]:not([tabindex])", root)) { el.tabIndex = 0; el.setAttribute("role", "link"); } }
new MutationObserver(() => { animateGauges(view); a11yLinks(view); }).observe(view, { childList: true, subtree: true });
document.addEventListener("keydown", (e) => {
  const el = e.target;
  if ((e.key === "Enter" || e.key === " ") && el.matches?.("[data-href]")) { e.preventDefault(); location.hash = el.dataset.href; }
});

// Deslizar entre modelos: sigue al dedo 1:1, con resistencia en los bordes y proyección del impulso al soltar
function bindSwipe(p, getI, count, goTo) {
  let id = null, sx = 0, sy = 0, drag = false, x = 0;
  const tr = tracker();
  p.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || e.target.closest("svg.chart")) return;
    id = e.pointerId; sx = e.clientX; sy = e.clientY; drag = false; tr.reset(); tr.add(e.clientX);
  });
  p.addEventListener("pointermove", (e) => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!drag) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) { drag = true; try { p.setPointerCapture(id); } catch (_) { /* sin captura */ } }
      else return;
    }
    tr.add(e.clientX);
    const i = getI(), edge = (dx > 0 && i === 0) || (dx < 0 && i === count - 1);
    x = edge ? rubberband(dx, p.offsetWidth) : dx;
    p.style.animation = "none"; p.style.transform = `translateX(${x}px)`; p.style.opacity = String(1 - Math.min(0.5, Math.abs(x) / p.offsetWidth));
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    if (!drag) return;
    drag = false;
    const v = tr.velocity(), i = getI(), proj = x + project(v, 0.99);
    const dirn = proj < 0 ? 1 : -1, to = i + dirn;
    if (Math.abs(proj) > p.offsetWidth * 0.3 && to >= 0 && to < count) {
      p.style.transform = ""; p.style.opacity = "";
      goTo(to, dirn, dirn * Math.min(160, p.offsetWidth * 0.3)); // el nuevo panel entra desde el lado del gesto
    } else {
      spring("panel-x", { from: x, to: 0, velocity: v, response: 0.35, damping: 0.85, onUpdate: (xx) => { p.style.transform = `translateX(${xx}px)`; p.style.opacity = String(1 - Math.min(0.5, Math.abs(xx) / p.offsetWidth)); }, onDone: () => { p.style.transform = ""; p.style.opacity = ""; } });
    }
  };
  p.addEventListener("pointerup", end); p.addEventListener("pointercancel", end);
}

// ---------- router y eventos globales ----------
let lastDepth = 0, firstRoute = true;
function route() {
  const h = location.hash.replace(/^#/, "") || "/";
  const depth = h.startsWith("/t/") || h.startsWith("/comparar/") ? 2 : 0;
  const dir = depth > lastDepth ? "forward" : depth < lastDepth ? "back" : "tab";
  lastDepth = depth;
  const render = () => {
    routeToken++; if (pxc) { pxc.destroy(); pxc = null; }
    scrollTo(0, 0); // al cambiar de pantalla se empieza siempre arriba
    const [path, qs] = h.split("?");
    if (h.startsWith("/t/")) renderDetail(decodeURIComponent(h.slice(3)));
    else if (path === "/portafolio") renderPortafolio(new URLSearchParams(qs || ""));
    else if (path === "/diario") renderDiario();
    else if (path.startsWith("/comparar/")) renderComparar(decodeURIComponent(path.slice(10)).split(","));
    else if (h === "/ranking") renderRanking();
    else if (h === "/descubrir") renderDescubrir();
    else if (h === "/metodo") renderMetodo();
    else renderHome();
  };
  // La transición de vista anima solo el cambio de pantalla; la carga de datos sigue después sin bloquear
  if (!firstRoute && document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.documentElement.dataset.nav = dir;
    document.startViewTransition(() => { render(); });
  } else render();
  firstRoute = false;
}
addEventListener("hashchange", route);

document.addEventListener("click", (e) => {
  const rm = e.target.closest("[data-rm]");
  if (rm) {
    e.stopPropagation();
    const was = state.watch.slice(), sy = rm.dataset.rm;
    state.watch = state.watch.filter((x) => x !== sy); store.set("watch", state.watch); renderHome();
    toast(`${sy} quitada de tu lista`, { label: "Deshacer", fn: () => { state.watch = was; store.set("watch", was); if (currentRoute === "home") renderHome(); } });
    return;
  }
  const quick = e.target.closest("[data-go]");
  if (quick) { location.hash = "#/t/" + encodeURIComponent(quick.dataset.go); return; }
  if (e.target.closest("[data-focus-search]")) { $("#q")?.focus({ preventScroll: true }); scrollTo({ top: 0, behavior: "smooth" }); return; }
  const card = e.target.closest("[data-href]");
  if (card) location.hash = card.dataset.href;
});

snapCache = await loadSnapshot();
route();
