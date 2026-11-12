# Menos carga de información: divulgación progresiva (lo esencial primero, el detalle un toque más abajo). Se ejecuta una sola vez.
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.chdir(ROOT)
p = "js/app.js"
s = open(p, encoding="utf-8").read()


def rep(a, b, n=1):
    global s
    assert s.count(a) == n, (s.count(a), a[:90])
    s = s.replace(a, b)


# 1) aviso legal: una línea + "Más información"
i = s.index("function disclaimer() {")
j = s.index("\n}\n", i) + 3
s = s[:i] + '''function disclaimer() {
  return `<div class="disclaimer">${ico("info", "")} <b>Herramienta educativa, no asesoría financiera.</b>
    <details class="how"><summary>Más información</summary><p>Las probabilidades y recomendaciones salen de modelos matemáticos aplicados a datos históricos de Yahoo Finance; no garantizan resultados. Ningún modelo predice el futuro: úsalos para ordenar tu análisis y gestionar el riesgo, y nunca inviertas más de lo que puedas perder.</p></details></div>`;
}
''' + s[j:]

# 2) "Cómo decide": la idea a la vista; fórmula, uso y límites desplegables
rep('<div class="formula">${f}</div><h4>Cómo lo usamos</h4><p class="explain">${how}</p><h4>Límites</h4><p class="explain">${lim}</p></div>`).join("")}',
    '<details class="how"><summary>Cómo funciona</summary><div class="formula">${f}</div><h4>Cómo lo usamos</h4><p class="explain">${how}</p><h4>Límites</h4><p class="explain">${lim}</p></details></div>`).join("")}')
rep('<div class="formula">S = Σ wᵢ · cᵢ · sᵢ / Σ wᵢ · pesos:',
    '<p class="explain"><b>Cada modelo da una señal y una confianza. Se combinan con pesos y se traducen a un veredicto.</b></p><details class="how"><summary>Ver pesos, umbrales y datos</summary><div class="formula">S = Σ wᵢ · cᵢ · sᵢ / Σ wᵢ · pesos:')
rep('lo indica arriba a la derecha.</p></div>', 'lo indica arriba a la derecha.</p></details></div>')
rep('<p class="lead">Cada modelo entrega una señal entre −1 y +1 y una confianza. Se combinan con pesos y se convierten en un veredicto. Aquí está todo.</p>',
    '<p class="lead">Cinco modelos opinan y se combinan en un solo veredicto. Toca cada uno para ver cómo funciona.</p>')

# 3) inicio: texto corto y tarjeta destacada con una frase
rep('<p class="lead">Escribe el nombre de una empresa, un fondo o una criptomoneda de cualquier parte del mundo. Te decimos con palabras simples si hoy conviene comprar, esperar o vender, y cuánto podrías ganar o perder. Por dentro trabajan cinco modelos financieros.</p>',
    '<p class="lead">Escribe una empresa, fondo o criptomoneda del mundo. Te decimos si hoy conviene comprar, esperar o vender, y cuánto podrías ganar o perder.</p>')
rep('<p class="explain">${summaryText(best)}</p>${C.gauge(best.score)}', '<p class="explain">${esc(GUIDE[best.verdict.key][1](best))}</p>${C.gauge(best.score)}')

# 4) tarjeta simple: solo lo esencial; el "en qué se basa" queda desplegable
a = s.index("const GUIDE = {")
b = s.index("const GLOSSARY = [")
s = s[:a] + '''const GUIDE = {
  buy: ["Buen momento para comprar", () => "Compra en 2 o 3 partes, no todo de una vez."],
  accumulate: ["Compra de a poco", (a) => `Divide tu dinero en 3 partes y compra una hoy.${a.verdict.cautious ? " Su precio puede caer fuerte: usa solo dinero que no necesites pronto." : ""}`],
  hold: ["Espera: hoy no hay ventaja clara", (a) => `Mejor esperar a que baje a ${fmtPrice(a.priceBuy)} o menos. Si ya la tienes, no hagas nada.`],
  reduce: ["Considera vender una parte", () => "El riesgo ahora pesa más que la ganancia posible."],
  sell: ["Mejor no comprarla ahora", () => "Si ya la tienes, es momento de vender o protegerte."],
};
''' + s[b:]

a = s.index("function scenarioRows(a, amount) {")
b = s.index("function bindGuide(a) {")
s = s[:a] + '''function scenarioRows(a, amount) {
  const bad = a.range.lo / a.S0 - 1, good = a.range.hi / a.S0 - 1, obj = a.upside;
  const row = (cls, t, p) => `<div class="sc ${cls}"><span>${t}</span><b>${signedMoney(amount * p)}</b><i>${pct(p, 0)}</i></div>`;
  return row("bad", "Si va mal", bad) + row("mid", "Lo esperable", obj) + row("good", "Si va bien", good);
}
function simpleCard(a) {
  const [title, textFn] = GUIDE[a.verdict.key];
  const sigs = a.contrib.map((c) => ({ n: TAB_SHORT[c.key], t: c.signal >= 0.1 ? "up" : c.signal <= -0.1 ? "down" : "flat" }));
  const ups = sigs.filter((x) => x.t === "up").length, downs = sigs.filter((x) => x.t === "down").length;
  const sum = ups > downs ? `${ups} de 5 modelos ven una subida` : downs > ups ? `${downs} de 5 modelos ven una bajada` : "Los modelos están divididos";
  const lab = { up: "Sube", down: "Baja", flat: "Neutral" };
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
      <p class="g-cap">“Mal” y “bien” son los extremos: pasan 1 de cada 10 veces.</p>
    </div>
    <p class="g-stop">${ico("shield")}<span>Si el precio cae a <b>${fmtPrice(a.stop)}</b> (${pct(a.downside, 0)}), conviene salir.</span></p>
    <p class="g-note">Son estimaciones, no promesas. Invierte solo dinero que no necesites pronto.</p>
    <details class="how g-more"><summary>¿En qué se basa?</summary>
      <div class="g-votes" aria-label="Qué ve cada modelo">${sigs.map((x) => `<span class="vote ${x.t}"><i></i>${x.n}<em>${lab[x.t]}</em></span>`).join("")}</div>
      <p class="g-sum">${sum}. En ${ten} de cada 10 casos parecidos, el precio terminó más alto después de ${hz}.</p>
      <div class="g-gloss"><h4>Palabras clave</h4><dl>${GLOSSARY.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join("")}</dl></div>
    </details>
  </section>`;
}
''' + s[b:]

# 5) paneles de modelo: números y explicación desplegables; ayudas de gráfico recortadas
rep('function panelFor(k, a) {', '''// Divulgación progresiva en cada panel: titular y gráfico a la vista; números y explicación un toque más abajo
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

function panelFor(k, a) {''')
rep('const p = $("#panel"); p.innerHTML = panelFor(k, a);', 'const p = $("#panel"); p.innerHTML = panelFor(k, a); tidyPanel(p);')
rep('  bindGuide(a);\n', '  bindGuide(a); clampHints(view);\n')
open(p, "w", encoding="utf-8").write(s)
print("app.js ok")

c = "css/style.css"
t = open(c, encoding="utf-8").read()
css = r'''
/* ============ Menos carga: divulgación progresiva ============ */
details.how { margin-top: .75rem; }
details.how > summary { cursor: pointer; font-weight: 700; font-size: .9rem; padding: .5rem 0; list-style: none; min-height: 2.25rem; display: flex; align-items: center; gap: .4rem; }
details.how > summary::-webkit-details-marker { display: none; }
details.how > summary::before { content: "+"; display: grid; place-items: center; width: 1.25rem; height: 1.25rem; border-radius: 50%; background: var(--chip); color: var(--blue); font-weight: 800; flex: none; }
details.how[open] > summary::before { content: "−"; }
details.how > :not(summary) { animation: fadein .25s ease both; }
.disclaimer details.how { margin-top: .25rem; } .disclaimer details.how p { margin-top: .25rem; }
.chartcard .hint.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; cursor: pointer; }
.chartcard .hint.clamp.open { display: block; -webkit-line-clamp: unset; }
.guide .g-cap { font-size: .75rem; color: var(--faint); margin-top: -.25rem; }
.guide .g-more { margin-top: 0; border-top: 1px solid var(--grid); padding-top: .25rem; }
.guide .g-more > :not(summary) { margin-top: .75rem; }
.g-gloss h4 { font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); }
.mcard details.how { margin-top: .5rem; }
'''
marker = "/* La × de quitar tiene su propio espacio"
assert t.count(marker) == 1
t = t.replace(marker, css + "\n" + marker)
open(c, "w", encoding="utf-8").write(t)
print("css ok")
