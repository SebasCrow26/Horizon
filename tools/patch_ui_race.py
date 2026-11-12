# Evita que una carga asíncrona antigua pise la pantalla actual (condición de carrera al navegar rápido).
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.chdir(ROOT)
s = open("js/app.js", encoding="utf-8").read()


def rep(a, b):
    global s
    n = s.count(a)
    assert n == 1, ("esperaba 1 coincidencia y hay", n, a[:90])
    s = s.replace(a, b)


rep('let currentRoute = "home";', 'let currentRoute = "home";\nlet routeToken = 0; // identifica la pantalla vigente: las cargas antiguas no deben dibujar sobre la nueva')

# Mi lista
rep('''  const results = [];
  (async () => {
    for (const sym of state.watch) {''', '''  const results = [];
  const my = routeToken;
  (async () => {
    for (const sym of state.watch) {
      if (my !== routeToken) return;''')

# Ranking
rep('''  const out = [];
  for (const sym of state.watch) { try { out.push(await analyze(sym)); }''', '''  const my = routeToken;
  const out = [];
  for (const sym of state.watch) { if (my !== routeToken) return; try { out.push(await analyze(sym)); }''')
rep('''  out.sort((a, b) => b.score - a.score);
  $("#rank").innerHTML''', '''  if (my !== routeToken) return;
  out.sort((a, b) => b.score - a.score);
  $("#rank").innerHTML''')

# Detalle
rep('''  let a;
  try { a = await analyze(sym); }
  catch (e) {
    view.innerHTML''', '''  const my = routeToken;
  let a;
  try { a = await analyze(sym); }
  catch (e) {
    if (my !== routeToken) return;
    view.innerHTML''')
rep('''  const inList = state.watch.includes(sym);''', '''  if (my !== routeToken) return;
  const inList = state.watch.includes(sym);''')

# el router marca la pantalla vigente
rep('''  const render = () => {
    scrollTo(''', '''  const render = () => {
    routeToken++;
    scrollTo(''')

open("js/app.js", "w", encoding="utf-8").write(s)
print("app.js corregido")
