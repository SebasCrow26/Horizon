# Cálculo en segundo plano (Web Worker) + arreglos del ranking. Se ejecuta una sola vez.
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.chdir(ROOT)
p = "js/app.js"
s = open(p, encoding="utf-8").read()


def rep(a, b):
    global s
    assert s.count(a) == 1, (s.count(a), a[:90])
    s = s.replace(a, b)


# ---------- 1) análisis fuera del hilo principal ----------
rep('const tick = () => new Promise((r) => setTimeout(r, 0));\n', '''const tick = () => new Promise((r) => setTimeout(r, 0));

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
''')
rep('''    await tick();
    const a = analyzeAll({ series, rates, universe, region, horizonDays: state.horizon });''', '''    const a = await runAnalysis({ series, rates, universe, region, horizonDays: state.horizon });''')

# ---------- 2) inicio: hasta 3 activos a la vez ----------
rep('''  (async () => {
    for (const sym of state.watch) {
      if (my !== routeToken) return;
      try { const a = await analyze(sym); results.push(a); fillCard(sym, a); }
      catch (e) { failCard(sym, e); }
      renderTop(results);
    }
  })();''', '''  mapLimit(state.watch, 3, async (sym) => {
    if (my !== routeToken) return;
    try { const a = await analyze(sym); if (my !== routeToken) return; results.push(a); fillCard(sym, a); }
    catch (e) { if (my !== routeToken) return; failCard(sym, e); }
    renderTop(results);
  });''')

# ---------- 3) ranking ----------
rep('''  const out = [];
  for (const sym of state.watch) { if (my !== routeToken) return; try { out.push(await analyze(sym)); } catch (e) { /* se omite */ } }
  if (my !== routeToken) return;
  out.sort((a, b) => b.score - a.score);''', '''  if (!state.watch.length) {
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
        <span class="nm"><b>${esc(f.sym)}</b><span>Sin datos por ahora · toca para reintentar</span></span><span class="muted">Sin veredicto</span></div>`).join("");''')
rep('''    : `<p class="muted">No se pudo analizar ningún activo de tu lista.</p>`;''', '''    : "";
  if (!out.length) $("#rank").innerHTML = `<div class="rank-empty"><p>No se pudo analizar ningún activo de tu lista.</p><p class="muted">Revisa tu conexión y vuelve a intentarlo.</p><button class="chip" id="rk-retry">Reintentar</button></div>` + failedRows;
  else $("#rank").insertAdjacentHTML("beforeend", failedRows);
  $("#rk-retry")?.addEventListener("click", () => renderRanking());''')
open(p, "w", encoding="utf-8").write(s)
print("app.js ok")

c = "css/style.css"
t = open(c, encoding="utf-8").read()
t = t.rstrip() + '''
/* ---- Ranking ---- */
.rank .nm b { overflow-wrap: anywhere; }
.rank .r.failed .nm span, .rank .r.failed .muted { color: var(--faint); }
.rank-empty { padding: 1.5rem 1.25rem; display: flex; flex-direction: column; align-items: flex-start; gap: .5rem; }
.rank-empty p:first-child { font-weight: 600; font-size: 1.0625rem; }
@media (max-width: 860px) {
  /* en celular: número | símbolo y nombre; el veredicto va debajo, nunca le quita espacio al símbolo */
  .rank .r { grid-template-columns: 1.75rem minmax(0, 1fr); grid-template-areas: "n nm" "n v"; column-gap: .5rem; row-gap: .125rem; align-items: start; }
  .rank .r > .n { grid-area: n; }
  .rank .r > .nm { grid-area: nm; overflow: visible; }
  .rank .r > span:nth-child(3) { grid-area: v; }
  .rank .nm span { white-space: normal; }
}
'''
open(c, "w", encoding="utf-8").write(t)
print("css ok")
