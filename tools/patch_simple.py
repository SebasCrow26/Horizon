# Guía para principiantes: tarjeta "En pocas palabras", modo Simple/Completo, pasos en el inicio. Se ejecuta una sola vez.
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.chdir(ROOT)
p = "js/app.js"
s = open(p, encoding="utf-8").read()


def rep(a, b, n=1):
    global s
    assert s.count(a) == n, (s.count(a), a[:80])
    s = s.replace(a, b)


# 3 pasos en el inicio (solo la línea con 6 espacios dentro de renderHome)
rep('      ${searchBox()}\n', '      ${searchBox()}\n      <ol class="steps" aria-label="Cómo usar Horizonte"><li><b>1</b><span>Busca una empresa o toca una de tu lista</span></li><li><b>2</b><span>Lee el veredicto: comprar, esperar o vender</span></li><li><b>3</b><span>Mira cuánto podrías ganar o perder antes de invertir</span></li></ol>\n')

# tarjetas del inicio: probabilidad en "de cada 10"
rep('Sube: <b style="color:var(--text)">${pctPlain(a.probUp)}</b>', 'Sube <b style="color:var(--text)">${Math.round(a.probUp * 10)} de 10</b> veces')

# detalle: marcar lo avanzado y colocar la tarjeta simple
rep('  <section class="glass hero-card rise" style="--i:2">', '  ${simpleCard(a)}\n\n  <section class="glass hero-card expert rise" style="--i:2">')
rep('<div class="two" style="margin-top:18px">\n    <div class="glass card rise" style="--i:3"><h3 style="font-size:17px">¿Por qué este veredicto?', '<div class="two expert" style="margin-top:18px">\n    <div class="glass card rise" style="--i:3"><h3 style="font-size:17px">¿Por qué este veredicto?')
rep('<div class="glass chartcard rise" style="--i:5">', '<div class="glass chartcard expert rise" style="--i:5">')
rep('<div class="tabs" id="tabs" role="tablist">', '<div class="tabs expert" id="tabs" role="tablist">')
rep('<div id="panel" class="panel"></div>', '<div id="panel" class="panel expert"></div>')
rep('  const m = a.models;\n  view.innerHTML = `\n  <a class="back"', '  const m = a.models;\n  view.dataset.mode = state.mode;\n  view.innerHTML = `\n  <a class="back"')

# manejadores
rep('  moveInd($("#hz"), "hz");\n', '''  moveInd($("#hz"), "hz");
  moveInd($("#mode"), "mode");
  $("#mode").addEventListener("click", (e) => {
    const b = e.target.closest("[data-m]"); if (!b) return;
    state.mode = b.dataset.m; store.set("mode", state.mode); view.dataset.mode = state.mode;
    $$("#mode a").forEach((x) => x.classList.toggle("on", x === b)); moveInd($("#mode"), "mode");
  });
  bindGuide(a);
''')

helper = r'''
// ----- Guía para principiantes: todo en palabras simples y en pesos, no en porcentajes ni jerga -----
const horizonLabel = (d) => (d === 21 ? "1 mes" : d === 63 ? "3 meses" : d === 126 ? "6 meses" : `${d} días`);
const money0 = (x) => "$" + Math.abs(Math.round(x)).toLocaleString("es-CO");
const signedMoney = (x) => (Math.round(x) === 0 ? "" : x < 0 ? "−" : "+") + money0(x);
const GUIDE = {
  buy: ["Es un buen momento para comprar", () => "Los modelos ven más posibilidades de que suba que de que baje. Aun así, no pongas todo de una vez: compra en 2 o 3 partes."],
  accumulate: ["Compra de a poco", (a) => `Hay una ventaja moderada. Divide tu dinero en 3 partes: compra una hoy y las otras en las próximas semanas.${a.verdict.cautious ? " Ojo: su precio puede caer fuerte de golpe, así que usa solo dinero que no necesites pronto." : ""}`],
  hold: ["Espera: hoy no hay una ventaja clara", (a) => `Si aún no la tienes, es mejor esperar a que el precio baje a ${fmtPrice(a.priceBuy)} o menos. Si ya la tienes, no hagas nada por ahora.`],
  reduce: ["Considera vender una parte", () => "Ahora pesa más el riesgo que la ganancia posible. Si ya la tienes, vender una parte protege lo que has ganado."],
  sell: ["Mejor no comprarla ahora", () => "Si ya la tienes, es momento de vender o proteger tu dinero. Si no, evítala por ahora."],
};
const GLOSSARY = [
  ["Veredicto", "La recomendación final de los 5 modelos juntos: comprar, esperar o vender."],
  ["Probabilidad de subir", "De cada 10 veces que se repitiera una situación parecida, en cuántas el precio terminaría más alto que hoy. No es una promesa."],
  ["Peores y mejores 1 de 10", "Casi siempre el resultado queda entre ambos extremos. Una de cada diez veces puede ser peor o mejor."],
  ["Piso de protección", "Precio al que conviene salir si las cosas van mal, para no perder más. Es tu límite de pérdida."],
  ["Comprar de a poco", "Dividir tu dinero en partes y comprar en distintos momentos, para no apostar todo a un solo precio."],
  ["Acción, fondo (ETF), criptomoneda", "Cosas que se compran y venden en mercados. Una acción es un pedacito de una empresa; un ETF es una canasta de muchas."],
];
function scenarioRows(a, amount) {
  const bad = a.range.lo / a.S0 - 1, good = a.range.hi / a.S0 - 1, obj = a.upside;
  const row = (cls, t, p) => `<div class="sc ${cls}"><span>${t}</span><b>${signedMoney(amount * p)}</b><i>${pct(p, 0)}</i></div>`;
  return row("bad", "Si va mal (uno de los peores 1 de 10)", bad) + row("mid", "Resultado razonable", obj) + row("good", "Si va bien (uno de los mejores 1 de 10)", good);
}
function simpleCard(a) {
  const [title, textFn] = GUIDE[a.verdict.key];
  const sigs = a.contrib.map((c) => ({ n: TAB_SHORT[c.key], t: c.signal >= 0.1 ? "up" : c.signal <= -0.1 ? "down" : "flat" }));
  const ups = sigs.filter((x) => x.t === "up").length, downs = sigs.filter((x) => x.t === "down").length;
  const sum = ups > downs ? `${ups} de 5 modelos ven una subida` : downs > ups ? `${downs} de 5 modelos ven una bajada` : "Los modelos están divididos";
  const lab = { up: "Sube", down: "Baja", flat: "Neutral" };
  const ten = Math.round(a.probUp * 10);
  return `
  <div class="row rise" style="--i:1;margin:0 6px 14px;justify-content:space-between;flex-wrap:wrap;gap:10px">
    <div class="seg" id="mode" role="group" aria-label="Nivel de detalle"><i class="ind"></i><a href="javascript:void(0)" data-m="simple" class="${state.mode === "simple" ? "on" : ""}">Simple</a><a href="javascript:void(0)" data-m="full" class="${state.mode === "full" ? "on" : ""}">Ver los 5 modelos</a></div>
  </div>
  <section class="glass guide rise" style="--i:2" aria-label="En pocas palabras">
    <div class="g-label">En pocas palabras · a ${horizonLabel(a.horizonDays)}</div>
    <h2 class="g-head ${a.verdict.tone}">${esc(title)}</h2>
    <p class="g-text">${esc(textFn(a))}</p>
    <div class="g-votes" aria-label="Qué ve cada modelo">${sigs.map((x) => `<span class="vote ${x.t}"><i></i>${x.n}<em>${lab[x.t]}</em></span>`).join("")}</div>
    <p class="g-sum">${sum}. En ${ten} de cada 10 casos parecidos, el precio terminó más alto después de ${horizonLabel(a.horizonDays)}.</p>
    <div class="g-money">
      <label class="g-q" for="amt">Si inviertes <span class="g-in">$<input id="amt" type="text" inputmode="numeric" autocomplete="off" value="${Number(state.amount).toLocaleString("es-CO")}"></span> hoy, en ${horizonLabel(a.horizonDays)} podrías tener:</label>
      <div id="scen">${scenarioRows(a, state.amount)}</div>
      <p class="g-stop">${ico("shield")}<span>Tu límite de pérdida: si el precio cae a <b>${fmtPrice(a.stop)}</b> (${pct(a.downside, 0)}), conviene salir para no perder más.</span></p>
    </div>
    <p class="g-note"><b>Importante:</b> son estimaciones, no promesas. Nadie puede asegurar ganancias. Invierte solo dinero que no necesites pronto y nunca todo en un mismo lugar.</p>
    <details class="g-gloss"><summary>¿Qué significan estas palabras?</summary><dl>${GLOSSARY.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join("")}</dl></details>
  </section>`;
}
function bindGuide(a) {
  const inp = $("#amt"); if (!inp) return;
  inp.addEventListener("input", () => {
    const n = Math.min(1e12, parseInt(inp.value.replace(/\D/g, "") || "0", 10));
    inp.value = n ? n.toLocaleString("es-CO") : "";
    state.amount = n || 0; store.set("amount", state.amount);
    $("#scen").innerHTML = scenarioRows(a, state.amount);
  });
  inp.addEventListener("focus", () => inp.select());
}

'''
rep('async function renderDetail(sym) {', helper + 'async function renderDetail(sym) {')
open(p, "w", encoding="utf-8").write(s)
print("app.js ok")

c = "css/style.css"
t = open(c, encoding="utf-8").read()
css = r'''
/* ============ Guía para principiantes ============ */
[data-mode="simple"] .expert { display: none !important; }
.steps { list-style: none; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .75rem; margin-top: 1.25rem; max-width: 640px; }
.steps li { display: flex; gap: .6rem; align-items: flex-start; font-size: .8125rem; line-height: 1.35; color: var(--muted); }
.steps b { flex: none; width: 1.5rem; height: 1.5rem; border-radius: 50%; display: grid; place-items: center; font-size: .75rem; background: var(--chip); color: var(--text); }
@media (max-width: 560px) { .steps { grid-template-columns: 1fr; gap: .5rem; } }
.guide { padding: 1.75rem; display: flex; flex-direction: column; gap: 1rem; margin-bottom: 1rem; }
.guide .g-label { font-size: .8125rem; font-weight: 600; color: var(--muted); }
.guide .g-head { font-size: clamp(1.6rem, 5.5vw, 2.4rem); line-height: 1.1; letter-spacing: -.025em; font-weight: 800; }
.guide .g-head.pos2 { color: var(--green); } .guide .g-head.pos1 { color: var(--teal); } .guide .g-head.neu { color: var(--orange); } .guide .g-head.neg1 { color: #ff7a45; } .guide .g-head.neg2 { color: var(--red); }
.guide .g-text { font-size: 1.0625rem; line-height: 1.5; }
.g-votes { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: .4rem; }
.vote { display: flex; flex-direction: column; align-items: center; gap: .15rem; padding: .55rem .2rem; border-radius: 14px; background: var(--chip); font-size: .6875rem; font-weight: 700; text-align: center; min-width: 0; color: var(--muted); }
.vote em { font-style: normal; font-weight: 800; font-size: .75rem; } .vote i { width: .5rem; height: .5rem; border-radius: 50%; background: currentColor; }
.vote.up { color: var(--green); } .vote.down { color: var(--red); } .vote.flat { color: var(--orange); }
.g-sum { font-size: .875rem; color: var(--muted); }
.g-money { display: flex; flex-direction: column; gap: .75rem; padding-top: .25rem; }
.g-q { font-size: 1rem; font-weight: 650; line-height: 1.9; }
.g-in { display: inline-flex; align-items: center; gap: .15rem; padding: .15rem .75rem; margin: 0 .2rem; border-radius: 999px; background: var(--chip); border: 1px solid var(--stroke); font-weight: 800; }
.g-in input { width: 9.5ch; min-width: 4ch; background: none; border: 0; outline: 0; font-size: 1rem; font-weight: 800; font-variant-numeric: tabular-nums; }
.g-in:focus-within { box-shadow: 0 0 0 3px color-mix(in srgb, var(--blue) 45%, transparent); }
#scen { display: grid; gap: .5rem; }
.sc { display: grid; grid-template-columns: 1fr auto; column-gap: .75rem; align-items: baseline; padding: .75rem 1rem; border-radius: 16px; background: var(--chip); }
.sc span { font-size: .8125rem; color: var(--muted); font-weight: 600; grid-column: 1; }
.sc b { font-size: 1.25rem; font-weight: 800; letter-spacing: -.02em; font-variant-numeric: tabular-nums; grid-column: 2; grid-row: 1 / span 2; text-align: right; align-self: center; }
.sc i { font-style: normal; font-size: .75rem; color: var(--faint); font-variant-numeric: tabular-nums; grid-column: 1; }
.sc.bad b { color: var(--red); } .sc.good b { color: var(--green); } .sc.mid b { color: var(--text); }
.g-stop { display: flex; gap: .6rem; align-items: flex-start; font-size: .875rem; color: var(--muted); }
.g-stop svg { width: 1.1rem; height: 1.1rem; flex: none; margin-top: .1rem; } .g-stop b { color: var(--text); }
.g-note { font-size: .8125rem; color: var(--muted); padding: .75rem 1rem; border-radius: 14px; background: color-mix(in srgb, var(--orange) 10%, transparent); border: 1px solid color-mix(in srgb, var(--orange) 28%, transparent); }
.g-note b { color: var(--text); }
.g-gloss summary { cursor: pointer; font-weight: 700; font-size: .9rem; padding: .35rem 0; list-style: none; } .g-gloss summary::-webkit-details-marker { display: none; }
.g-gloss summary::before { content: "+ "; color: var(--blue); } .g-gloss[open] summary::before { content: "− "; }
.g-gloss dl { display: grid; gap: .25rem; margin-top: .5rem; } .g-gloss dt { font-weight: 750; font-size: .875rem; margin-top: .5rem; } .g-gloss dd { font-size: .8125rem; color: var(--muted); line-height: 1.45; }
@media (max-width: 480px) { .guide { padding: 1.25rem; } .vote { font-size: .625rem; } }
'''
marker = "/* La × de quitar tiene su propio espacio"
assert t.count(marker) == 1
t = t.replace(marker, css + "\n" + marker)
open(c, "w", encoding="utf-8").write(t)
print("css ok")
