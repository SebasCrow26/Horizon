# Aplica las mejoras de interacción (Apple Design) a js/app.js. Se ejecuta una sola vez.
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.chdir(ROOT)
s = open("js/app.js", encoding="utf-8").read()


def rep(a, b, times=1):
    global s
    n = s.count(a)
    assert n == times, ("esperaba", times, "coincidencias y hay", n, a[:90])
    s = s.replace(a, b)


# 1) importaciones
rep('import { fmtPrice, pct, pctPlain } from "./charts.js";',
    'import { fmtPrice, pct, pctPlain } from "./charts.js";\nimport { spring, project, rubberband, tracker } from "./motion.js";')

# 2) barra de navegación con indicador de resorte
rep('''  const on = $("a.on", nav);
  if (on) { ind.style.width = on.offsetWidth + "px"; ind.style.transform = `translateX(${on.offsetLeft - 4}px)`; }
}''', '''  moveInd(nav, "nav");
}''')

# 3) etiquetas específicas
s = s.replace('${ico("back")}Resumen</a>', '${ico("back")}Mi lista</a>')

# 4) esqueleto con la forma final de la pantalla de detalle
rep('''view.innerHTML = `<a class="back" href="#/">${ico("back")}Mi lista</a><div class="glass card" style="height:260px"><div class="skeleton" style="height:100%"></div></div>`;''',
    '''view.innerHTML = `<a class="back" href="#/">${ico("back")}Mi lista</a>
    <div class="head"><div><div class="skeleton" style="width:min(320px,70vw);height:40px"></div><div class="skeleton" style="width:min(220px,50vw);height:14px;margin-top:12px"></div></div><div class="skeleton" style="width:130px;height:42px"></div></div>
    <section class="glass hero-card" aria-busy="true"><div><div class="skeleton" style="width:120px;height:12px"></div><div class="skeleton" style="width:min(280px,80%);height:54px;margin:14px 0"></div><div class="skeleton" style="height:14px;width:90%"></div><div class="skeleton" style="height:14px;width:70%;margin-top:8px"></div></div>
    <div class="kpis">${'<div class="kpi"><div class="skeleton" style="height:14px;width:60%"></div><div class="skeleton" style="height:26px;width:80%;margin-top:10px"></div></div>'.repeat(6)}</div></section>`;''')

# 5) estado de error con "Reintentar"
rep('<p class="muted" style="margin:8px 0 16px">${esc(e.message)}</p>', '<p class="muted" style="margin:8px 0 12px">${esc(e.message)}</p><button class="chip" id="retry" style="margin-bottom:18px">Reintentar</button>')
rep('bindSearch(); return;', 'bindSearch(); $("#retry")?.addEventListener("click", () => renderDetail(sym)); return;')

# 6) pestañas accesibles
rep('role="tab" data-tab="${k}">', 'role="tab" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-tab="${k}">')

# 7) bloque de pestañas, deslizar, aviso con deshacer e indicador de horizonte
start = s.index('  const showTab = (k) =>')
end_marker = '  countUp(view);'
end = s.index(end_marker, start)
new_block = '''  const order = TAB_ORDER; let idx = 0;
  const showTab = (k, dir = 0, fromX) => {
    const i = order.indexOf(k); idx = i;
    $$(".tab").forEach((t) => { const on = t.dataset.tab === k; t.classList.toggle("on", on); t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; });
    const p = $("#panel"); p.innerHTML = panelFor(k, a);
    if (dir) {
      const f = fromX ?? dir * 48; p.style.animation = "none";
      spring("panel-x", { from: f, to: 0, response: 0.42, onUpdate: (x) => { p.style.transform = `translateX(${x}px)`; p.style.opacity = String(1 - Math.min(1, Math.abs(x) / Math.abs(f)) * 0.85); }, onDone: () => { p.style.transform = ""; p.style.opacity = ""; } });
    } else { p.style.transform = ""; p.style.opacity = ""; p.style.animation = "none"; void p.offsetWidth; p.style.animation = ""; }
    $(`.tab[data-tab="${k}"]`)?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  };
  showTab("merton");
  $("#tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) { const to = order.indexOf(b.dataset.tab); showTab(b.dataset.tab, Math.sign(to - idx)); } });
  $("#tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const to = Math.max(0, Math.min(order.length - 1, idx + (e.key === "ArrowRight" ? 1 : -1)));
    showTab(order[to], Math.sign(to - idx)); $(`.tab[data-tab="${order[to]}"]`).focus();
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
'''
s = s[:start] + new_block + s[end:]

# 8) router con transiciones de vista direccionales
a = s.index("function route() {")
b = s.index('addEventListener("hashchange", route);')
s = s[:a] + '''let lastDepth = 0, firstRoute = true;
function route() {
  const h = location.hash.replace(/^#/, "") || "/";
  const depth = h.startsWith("/t/") ? 2 : 0;
  const dir = depth > lastDepth ? "forward" : depth < lastDepth ? "back" : "tab";
  lastDepth = depth;
  const render = () => {
    scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    if (h.startsWith("/t/")) renderDetail(decodeURIComponent(h.slice(3)));
    else if (h === "/ranking") renderRanking();
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
''' + s[b:]

# 9) quitar de la lista con "Deshacer"
rep('''if (rm) { e.stopPropagation(); state.watch = state.watch.filter((s) => s !== rm.dataset.rm); store.set("watch", state.watch); renderHome(); return; }''',
    '''if (rm) {
    e.stopPropagation();
    const was = state.watch.slice(), sy = rm.dataset.rm;
    state.watch = state.watch.filter((x) => x !== sy); store.set("watch", state.watch); renderHome();
    toast(`${sy} quitada de tu lista`, { label: "Deshacer", fn: () => { state.watch = was; store.set("watch", was); if (currentRoute === "home") renderHome(); } });
    return;
  }''')

# 10) infraestructura (resortes, aviso, medidores, deslizar): antes del router
extra = open(os.path.join("tools", "extra_ui.js"), encoding="utf-8").read()
rep("// ---------- router y eventos globales ----------", extra + "// ---------- router y eventos globales ----------")

open("js/app.js", "w", encoding="utf-8").write(s)
print("app.js listo")
