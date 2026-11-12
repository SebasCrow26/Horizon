# Conecta el gráfico estilo Yahoo a la pantalla de detalle y añade sus estilos. Se ejecuta una sola vez.
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.chdir(ROOT)

# --- pricechart.js: hora local para "En vivo"
p = "js/pricechart.js"
s = open(p, encoding="utf-8").read()
a = 'dtf(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d.fetchedAt)'
assert s.count(a) == 1
s = s.replace(a, 'new Date(d.fetchedAt).toLocaleTimeString("es-CO")')
open(p, "w", encoding="utf-8").write(s)

# --- app.js
p = "js/app.js"
s = open(p, encoding="utf-8").read()


def rep(a, b):
    global s
    assert s.count(a) == 1, (s.count(a), a[:80])
    s = s.replace(a, b)


rep('import { spring, project, rubberband, tracker } from "./motion.js";', 'import { spring, project, rubberband, tracker } from "./motion.js";\nimport { mountPriceChart } from "./pricechart.js";')
rep('let routeToken = 0;', 'let pxc = null; // gráfico de precio de la pantalla de detalle (se destruye al salir)\nlet routeToken = 0;')
# destruir el gráfico al cambiar de pantalla
rep('  const render = () => {\n    routeToken++;', '  const render = () => {\n    routeToken++; if (pxc) { pxc.destroy(); pxc = null; }')
# hueco del gráfico entre el encabezado y los controles
rep('''  <div class="row rise" style="--i:1;margin:0 6px 18px;flex-wrap:wrap;justify-content:space-between">''', '''  <div id="pxc" class="rise" style="--i:1;margin-bottom:18px"></div>
  <div class="row rise" style="--i:1;margin:0 6px 18px;flex-wrap:wrap;justify-content:space-between">''')
# montaje (después de pintar el detalle) + actualización del precio del encabezado en vivo
rep('  bindGuide(a); clampHints(view);\n', '''  bindGuide(a); clampHints(view);
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
''')
open(p, "w", encoding="utf-8").write(s)
print("app.js ok")

# --- estilos
c = "css/style.css"
t = open(c, encoding="utf-8").read()
assert "pxc-ranges" not in t
t = t.rstrip() + '''

/* ============ Gráfico de precio (estilo Yahoo Finance) ============ */
.pxc { padding: .75rem .75rem .5rem; }
.pxc-ranges { display: flex; gap: .125rem; overflow-x: auto; scrollbar-width: none; padding: 0 .125rem .5rem; }
.pxc-ranges::-webkit-scrollbar { display: none; }
.pxc-ranges button { flex: none; padding: .375rem .75rem; border-radius: 8px; font-size: .8125rem; font-weight: 600; color: var(--muted); min-height: 2rem; }
.pxc-ranges button.on { background: var(--chip); color: var(--text); }
.pxc-ranges button:disabled { opacity: .35; cursor: not-allowed; }
.pxc-opts { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem .75rem; padding: 0 .375rem .5rem; }
.pxc-status { display: flex; align-items: center; gap: .4rem; font-size: .75rem; color: var(--muted); flex-wrap: wrap; }
.pxc-status b { font-weight: 700; margin-left: .25rem; font-variant-numeric: tabular-nums; }
.pxc-status .dot { width: .5rem; height: .5rem; border-radius: 50%; background: var(--orange); flex: none; }
.pxc-status .dot.live { background: var(--green); } .pxc-status .dot.off { background: var(--faint); }
.pxc-ctl { display: flex; align-items: center; gap: .375rem; flex-wrap: wrap; }
.pxc-types { display: flex; background: var(--chip); border-radius: 8px; padding: 2px; }
.pxc-types button, .pxc-tg { font-size: .75rem; font-weight: 600; padding: .25rem .625rem; border-radius: 6px; color: var(--muted); min-height: 1.75rem; }
.pxc-types button.on { background: var(--seg-thumb); color: var(--text); box-shadow: 0 1px 3px rgba(0, 0, 0, .15); }
.pxc-types button:disabled { opacity: .35; }
.pxc-tg { background: var(--chip); border-radius: 8px; }
.pxc-tg[aria-pressed="true"] { color: var(--blue); }
.pxc-plot { position: relative; touch-action: pan-y; }
.pxc-svg { display: block; width: 100%; height: auto; cursor: crosshair; user-select: none; -webkit-user-select: none; }
.pxc-grid { stroke: var(--grid); stroke-width: .5; }
.pxc-ytx, .pxc-xtx { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }
.pxc-tag { font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }
.pxc-vol { stroke: var(--muted); opacity: .4; fill: none; }
.pxc-ref { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 4; }
.pxc-fill { opacity: .22; }
.pxc-line { fill: none; stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; }
.pxc-xhl { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 2 3; }
.pxc-xhd { fill: var(--text); stroke: var(--bg1); stroke-width: 2; }
.pxc-tip { position: absolute; left: 0; top: 0; z-index: 5; pointer-events: none; display: flex; flex-direction: column; gap: 1px; padding: .4rem .65rem; border-radius: 10px; font-size: .75rem; background: color-mix(in srgb, var(--card2) 90%, transparent); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); box-shadow: 0 4px 16px rgba(0, 0, 0, .25); white-space: nowrap; }
.pxc-tip[hidden] { display: none; }
.pxc-tip b { font-size: 1rem; font-variant-numeric: tabular-nums; } .pxc-tip .d { color: var(--muted); font-weight: 600; } .pxc-tip .r { color: var(--muted); font-variant-numeric: tabular-nums; }
.pxc-tip .r.pos { color: var(--green); } .pxc-tip .r.neg { color: var(--red); }
.pxc-foot { font-size: .6875rem; color: var(--faint); padding: .25rem .375rem 0; }
.pxc-empty { fill: var(--muted); font-size: 13px; }
@media (max-width: 480px) { .pxc { padding: .5rem .5rem .375rem; } .pxc-ranges button { padding: .375rem .5rem; } }
'''
open(c, "w", encoding="utf-8").write(t)
print("css ok")
