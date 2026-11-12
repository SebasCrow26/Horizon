# Integra datos clave, resumen del mercado, noticias y la pantalla "Descubrir". Se ejecuta una sola vez.
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.chdir(ROOT)


def rd(p):
    return open(p, encoding="utf-8").read()


def wr(p, s):
    open(p, "w", encoding="utf-8").write(s)


# ================= data.js =================
s = rd("js/data.js")
assert "export async function getQuoteLite" not in s
s = s.rstrip() + r'''

// ---------- cotización ligera (resumen del mercado), noticias e ideas precalculadas ----------
const quoteCache = new Map();
export async function getQuoteLite(sym) {
  const hit = quoteCache.get(sym);
  if (hit && Date.now() - hit.at < 60e3) return hit;
  if (liveAllowed() && !CFG.FORCE_SNAPSHOT) {
    for (const b of liveBases()) {
      try {
        const res = (await fetchJSON(`${b}/chart/${encodeURIComponent(sym)}?range=1d&interval=15m`, 8000))?.chart?.result?.[0];
        const m = res?.meta;
        if (m && m.regularMarketPrice != null && m.chartPreviousClose != null) {
          const out = { sym, price: m.regularMarketPrice, prev: m.chartPreviousClose, closes: (res.indicators?.quote?.[0]?.close || []).filter((v) => v != null), source: "live", at: Date.now() };
          quoteCache.set(sym, out);
          return out;
        }
      } catch (e) { /* siguiente */ }
    }
  }
  const s = snapToSeries(await loadSnapshot(), sym);
  if (!s || s.c.length < 3) return null;
  const n = s.c.length, out = { sym, price: s.c[n - 1], prev: s.c[n - 2], closes: s.c.slice(-40), source: "snapshot", at: Date.now() };
  quoteCache.set(sym, out);
  return out;
}

export async function getNews(sym, count = 6) {
  if (!liveAllowed() || CFG.FORCE_SNAPSHOT) { const e = new Error("Sin conexión"); e.code = "offline"; throw e; }
  let lastErr = null;
  for (const b of liveBases()) {
    try {
      const j = await fetchJSON(`${b}/search?q=${encodeURIComponent(sym)}&quotesCount=0&newsCount=${count}`, 9000);
      return (j.news || [])
        .filter((n) => n && n.title && typeof n.link === "string" && /^https:\/\//i.test(n.link))
        .slice(0, count)
        .map((n) => ({ title: String(n.title), publisher: n.publisher ? String(n.publisher) : "", link: n.link, time: n.providerPublishTime || 0 }));
    } catch (e) { lastErr = e; }
  }
  const e = new Error("No se pudieron cargar las noticias"); e.cause = lastErr; throw e;
}

export async function getIdeas() {
  const r = await fetch("data/ideas.json");
  if (!r.ok) throw new Error("No se pudieron cargar las ideas");
  return r.json();
}
'''
wr("js/data.js", s)

# ================= index.html: navegación =================
h = rd("index.html")
a = '    <a href="#/ranking" data-r="ranking">Ranking</a>'
assert h.count(a) == 1
h = h.replace(a, '    <a href="#/descubrir" data-r="descubrir">Descubrir</a>\n' + a)
a = '  <a href="#/ranking" data-r="ranking"><svg><use href="#i-trophy"/></svg>Ranking</a>'
assert h.count(a) == 1
h = h.replace(a, '  <a href="#/descubrir" data-r="descubrir"><svg><use href="#i-compass"/></svg>Descubrir</a>\n' + a)
a = '    <symbol id="i-trophy"'
assert h.count(a) == 1
h = h.replace(a, '    <symbol id="i-compass" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/></symbol>\n' + a)
wr("index.html", h)

# ================= app.js =================
s = rd("js/app.js")


def rep(a, b):
    global s
    assert s.count(a) == 1, (s.count(a), a[:90])
    s = s.replace(a, b)


rep('import { mountPriceChart } from "./pricechart.js";', 'import { mountPriceChart } from "./pricechart.js";\nimport { mountKeyStats, mountMarket, mountNews } from "./extras.js";')
rep('REGION_NAMES, loadSnapshot } from "./data.js";', 'REGION_NAMES, loadSnapshot, getIdeas } from "./data.js";')

# inicio: resumen del mercado antes de "La más recomendada"
rep('    <div id="top"></div>\n    <h2 class="sec">Mi lista', '    <h2 class="sec">Mercados hoy <small>toca uno para ver su análisis</small></h2>\n    <div id="market"></div>\n    <div id="top"></div>\n    <h2 class="sec">Mi lista')
rep('  bindSearch();\n  const results = [];', '  bindSearch();\n  mountMarket($("#market"));\n  const results = [];')

# detalle: datos clave y noticias bajo el gráfico
rep('  <div id="pxc" class="rise" style="--i:1;margin-bottom:18px"></div>', '  <div id="pxc" class="rise" style="--i:1;margin-bottom:12px"></div>\n  <div id="kstats" class="rise" style="--i:1;margin-bottom:12px"></div>\n  <div id="news" class="rise" style="--i:1;margin-bottom:18px"></div>')
rep('  if (pxc) pxc.destroy();\n  pxc = mountPriceChart(', '  mountKeyStats($("#kstats"), { sym, series: a.series });\n  mountNews($("#news"), { sym });\n  if (pxc) pxc.destroy();\n  pxc = mountPriceChart(')

# ruta
rep('    else if (h === "/ranking") renderRanking();', '    else if (h === "/ranking") renderRanking();\n    else if (h === "/descubrir") renderDescubrir();')

# pantalla Descubrir (antes de renderRanking)
disc = r'''// ----- Descubrir: los 5 modelos aplicados a ~100 activos de todo el mundo (precalculado) -----
const DISC_REGIONS = [["all", "Todos"], ["US", "EE. UU."], ["CO", "Colombia"], ["LATAM", "Latinoamérica"], ["EU", "Europa"], ["ASIA", "Asia"], ["CRYPTO", "Cripto"]];
let discRegion = "all", discAll = false;
async function renderDescubrir() {
  currentRoute = "descubrir"; updateNav("descubrir");
  view.innerHTML = `<section class="hero rise"><div class="eyebrow">Oportunidades</div><h1 class="title">Descubrir</h1><p class="lead">Los 5 modelos analizaron unos 100 activos del mundo. Aquí están ordenados de la mejor a la peor señal.</p></section>
    <div id="disc"><div class="skeleton" style="height:70px;border-radius:18px"></div></div>${disclaimer()}`;
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
      <p class="disc-note">Cálculo a ${Math.round(ideas.horizonDays / 21)} meses con los datos guardados el ${asOf}. Toca un activo para verlo con datos actualizados. No es una recomendación personalizada.</p>`;
    $("#disc").querySelectorAll("[data-reg]").forEach((b) => b.addEventListener("click", () => { discRegion = b.dataset.reg; discAll = false; draw(); }));
    $("#disc-more")?.addEventListener("click", () => { discAll = !discAll; draw(); });
  };
  draw();
}

'''
rep('// ----- Ranking -----', disc + '// ----- Ranking -----')
wr("js/app.js", s)

# ================= css =================
c = rd("css/style.css").rstrip()
assert "kstats" not in c
c += r'''

/* ============ Datos clave, mercados, noticias y Descubrir ============ */
.kstats { padding: .5rem 1.25rem 1rem; display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: 0 1.5rem; }
.ks { display: flex; flex-direction: column; gap: .125rem; padding: .625rem 0; border-top: .5px solid var(--sep); min-width: 0; }
.ks .k { font-size: .75rem; color: var(--muted); }
.ks b { font-size: .9375rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.ks.range { grid-column: span 2; }
@media (max-width: 380px) { .ks.range { grid-column: span 1; } }
.rbar { position: relative; height: 4px; border-radius: 2px; background: var(--chip); margin-top: .5rem; }
.rbar i { position: absolute; top: 50%; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%; background: var(--text); box-shadow: 0 0 0 2px var(--card); }
.mk-row { display: flex; gap: .625rem; overflow-x: auto; scroll-snap-type: x proximity; padding: 0 .375rem .5rem; margin: 0 -.375rem; scrollbar-width: none; }
.mk-row::-webkit-scrollbar { display: none; }
.mk { flex: none; scroll-snap-align: start; width: 9.25rem; padding: .75rem .875rem; border-radius: 14px; background: var(--card); display: flex; flex-direction: column; gap: .125rem; position: relative; overflow: hidden; }
.mk .n { font-size: .75rem; color: var(--muted); font-weight: 500; }
.mk b { font-size: 1.125rem; font-weight: 700; letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
.mk .c { font-size: .8125rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.mk .c.pos { color: var(--green); } .mk .c.neg { color: var(--red); }
.mk svg.spark { position: absolute; right: .5rem; bottom: .5rem; width: 3.25rem; height: 1.5rem; opacity: .9; }
.mk:active { background: var(--card2); }
.skeleton-tile { opacity: .5; }
.newscard { padding: .25rem 1.25rem; }
.newscard details.how { margin-top: 0; }
.news-list { list-style: none; display: flex; flex-direction: column; }
.news-list li { border-top: .5px solid var(--sep); }
.news-list a { display: flex; flex-direction: column; gap: .125rem; padding: .75rem 0; }
.news-list .t { font-size: .9375rem; font-weight: 500; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.news-list .m { font-size: .75rem; color: var(--muted); }
.news-list a:active .t { color: var(--blue); }
.news-msg { padding: .5rem 0 .75rem; font-size: .875rem; } .news-foot { font-size: .6875rem; color: var(--faint); padding: .25rem 0 .75rem; }
.chips-row { display: flex; gap: .5rem; overflow-x: auto; scrollbar-width: none; padding: 0 .125rem .75rem; }
.chips-row::-webkit-scrollbar { display: none; }
.chips-row .chip { flex: none; } .chip.on { background: var(--text); color: var(--bg1); }
.disc-more { margin: 1rem auto 0; display: block; } .disc-note { font-size: .75rem; color: var(--faint); margin: 1rem .5rem 0; }
@media (max-width: 860px) { .tabbar a { padding-left: .5rem; padding-right: .5rem; } }
'''
wr("css/style.css", c)
print("ok")
