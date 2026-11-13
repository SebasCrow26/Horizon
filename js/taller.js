// Taller de riesgo de Horizon: una sola pantalla con seis pestañas (Datos · GBM · Opciones · Riesgo · Asignación · Evaluación).
// Créditos: el diseño del análisis parte del Taller de valoración y riesgo de Felipe Pulido (Streamlit). Esta es una herramienta
// equivalente en JavaScript: entradas editables, ejecución, tablas, gráficos y exportación de resultados (CSV + parámetros + semilla).
import { cargarPrecios, tablaSectores, sectoresReferencia, buildZip } from "./taller-data.js";
import { correrTaller, archivosResultados, TICKERS_DEFECTO, PARAMS_DEFECTO, semilla } from "./taller-run.js";
import { getOptionsChain, loadSectorMap } from "./data.js";
import { detalleContrato } from "./options.js";
import { simulateGBM } from "./gbm.js";
import * as TC from "./tallercharts.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = (x, d = 2) => (Number.isFinite(x) ? x.toLocaleString("es-CO", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—");
const usd = (x, d = 0) => (Number.isFinite(x) ? "USD " + nf(x, d) : "—");
const pc = (x, d = 1) => (Number.isFinite(x) ? nf(x * 100, d) + " %" : "—");
const dia = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
const tick = () => new Promise((r) => setTimeout(r, 30));
const store = {
  get(k, d) { try { const v = localStorage.getItem("hz_" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("hz_" + k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } },
};

const GRUPOS = [
  ["Mercado y riesgo", [
    { k: "B", l: "Capital (USD)", s: 1, min: 1000, max: 1e9, step: 1000 }, { k: "alpha", l: "Confianza del VaR (%)", s: 100, min: 90, max: 99.9, step: 0.1 },
    { k: "h", l: "Horizonte del VaR (sesiones)", s: 1, min: 1, max: 60, step: 1 }, { k: "r", l: "Tasa libre de riesgo (% anual)", s: 100, min: 0, max: 30, step: 0.1 },
    { k: "nMC", l: "Escenarios Monte Carlo", s: 1, min: 1000, max: 200000, step: 1000 }, { k: "seed", l: "Semilla", s: 1, min: 0, max: 2e9, step: 1 },
  ]],
  ["GBM y opción", [
    { k: "nTray", l: "Trayectorias GBM (mín. 5.000)", s: 1, min: 5000, max: 50000, step: 1000 }, { k: "horizonteGBM", l: "Horizonte del GBM (sesiones)", s: 1, min: 5, max: 504, step: 1 },
    { k: "tickerOpcion", l: "Acción para la opción (vacío = la primera)", t: "text" }, { k: "tipo", l: "Tipo de opción", t: "select", op: [["call", "Call"], ["put", "Put"]] },
    { k: "estilo", l: "Estilo", t: "select", op: [["americana", "Americana"], ["europea", "Europea"]] }, { k: "N", l: "Pasos del árbol", s: 1, min: 10, max: 2000, step: 10 },
    { k: "costoT", l: "Costo terminal (USD por acción)", s: 1, min: 0, max: 1000, step: 0.01 }, { k: "oiMin", l: "Interés abierto mínimo", s: 1, min: 0, max: 1e6, step: 10 },
    { k: "spreadMax", l: "Spread máximo bid/ask (%)", s: 100, min: 1, max: 100, step: 1 },
  ]],
  ["Asignación y estrategias", [
    { k: "wmin", l: "Peso mínimo por acción (%)", s: 100, min: 0, max: 50, step: 0.5 }, { k: "wmax", l: "Peso máximo por acción (%)", s: 100, min: 1, max: 100, step: 0.5 },
    { k: "limSector", l: "Límite por sector (%)", s: 100, min: 5, max: 100, step: 1 }, { k: "vbar", l: "Presupuesto de riesgo V̄ (USD)", s: 1, min: 100, max: 1e9, step: 100 },
    { k: "costBps", l: "Costo de operar (puntos básicos)", s: 1, min: 0, max: 500, step: 1 },
  ]],
  ["Evaluación rolling", [{ k: "Hlista", l: "Horizontes H en sesiones (separados por coma)", t: "text" }]],
];

// ---------- piezas de HTML ----------
const kpi = (k, v, s = "", cls = "") => `<div class="kpi"><div class="k">${k}</div><div class="v ${cls}">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
const card = (inner, cls = "") => `<div class="glass tl-card ${cls}">${inner}</div>`;
const sec = (t, s = "") => `<h2 class="sec">${t}${s ? `<small>${s}</small>` : ""}</h2>`;
const how = (t, inner) => `<details class="how"><summary>${t}</summary>${inner}</details>`;
const note = (t, tone = "") => `<div class="flag tl-note ${tone}"><span>${t}</span></div>`;
function tbl(head, rows, { hi = -1, lefts = [0] } = {}) {
  const L = new Set(lefts);
  return `<div class="tl-scroll"><table class="tl-tbl"><thead><tr>${head.map((h, i) => `<th class="${L.has(i) ? "" : "num"}">${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r, k) => `<tr class="${k === hi ? "hi" : ""}">${r.map((c, i) => `<td class="${L.has(i) ? "" : "num"}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
const select = (key, opts, cur) => `<label class="tl-sel"><select data-k="${key}">${opts.map((o, i) => `<option value="${i}" ${i === cur ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></label>`;

// ---------- formulario ----------
const fmtCampo = (v, s) => (v == null ? "" : String(+(v * s).toPrecision(10)));
function filaTicker(t = "", s = "", q = "") {
  return `<div class="tl-row"><input class="tl-t" value="${esc(t)}" maxlength="14" placeholder="Símbolo" aria-label="Símbolo" autocapitalize="characters" spellcheck="false"><input class="tl-s" value="${esc(s)}" placeholder="Sector" aria-label="Sector (opcional)"><input class="tl-q" value="${esc(q)}" inputmode="decimal" placeholder="q % (opc.)" aria-label="Dividend yield manual en % (opcional)"><button type="button" class="tl-x" aria-label="Quitar acción">×</button></div>`;
}
function formHTML(sv, ico) {
  const filas = sv.filas || TICKERS_DEFECTO.map(([t]) => [t, "", ""]);
  const P = { ...PARAMS_DEFECTO, ...(sv.params || {}) };
  const campos = GRUPOS.map(([g, cs]) => `<details class="how tl-group"><summary>${g}</summary><div class="tl-fields">${cs.map((c) => {
    const v = P[c.k];
    if (c.t === "select") return `<label>${c.l}<select data-p="${c.k}">${c.op.map(([val, tx]) => `<option value="${val}" ${v === val ? "selected" : ""}>${tx}</option>`).join("")}</select></label>`;
    if (c.t === "text") return `<label>${c.l}<input data-p="${c.k}" type="text" value="${esc(c.k === "Hlista" ? (v || [1]).join(", ") : v ?? "")}" spellcheck="false"></label>`;
    return `<label>${c.l}<input data-p="${c.k}" type="number" inputmode="decimal" min="${c.min}" max="${c.max}" step="${c.step}" value="${fmtCampo(v, c.s)}"></label>`;
  }).join("")}</div></details>`).join("");
  return card(`
    <div class="tl-step"><b>1 · Datos</b><div class="tl-seg" role="tablist" id="tl-src">
      ${[["yahoo", "Yahoo Finance"], ["respaldo", "Datos guardados"], ["csv", "Subir CSV"]].map(([k, l]) => `<button type="button" role="tab" data-src="${k}" aria-selected="${(sv.fuente || "yahoo") === k}">${l}</button>`).join("")}</div>
      <p class="muted tl-hint" id="tl-srchint"></p></div>
    <div id="tl-csv" class="tl-csv" hidden>
      <label>CSV de precios ajustados (fecha + una columna por acción)<input type="file" id="tl-f1" accept=".csv,text/csv"></label>
      <label>CSV de cierres sin ajustar (opcional, mismo formato)<input type="file" id="tl-f2" accept=".csv,text/csv"></label>
      <label>Procedencia de los datos (obligatoria)<input type="text" id="tl-prov" value="${esc(sv.prov || "")}" placeholder="Ej.: descargado de Yahoo Finance el 10/11/2026"></label>
    </div>
    <div class="tl-step"><b>2 · Acciones y sectores</b>
      <p class="muted tl-hint">Diez acciones de EE. UU. en al menos cuatro sectores. Si dejan el sector en blanco se usa el de Yahoo Finance (o el mapa de Horizon); si lo escriben, manda lo que escriban y queda registrado como corrección manual. «q» es el dividend yield anual en % (si lo dejan vacío se calcula con los dividendos de 12 meses).</p>
      <div class="tl-rows" id="tl-rows">${filas.map((f) => filaTicker(...f)).join("")}</div>
      <div class="tl-tools"><button type="button" class="chip" id="tl-add">${ico("plus")} Agregar acción</button><button type="button" class="chip" id="tl-reset">Restablecer las diez</button>
        <label class="tl-years">Años de historia<select id="tl-years">${[3, 4, 5].map((y) => `<option ${y === (sv.years || 4) ? "selected" : ""}>${y}</option>`).join("")}</select></label></div></div>
    <div class="tl-step"><b>3 · Parámetros</b><div class="tl-groups">${campos}</div></div>
    <div class="tl-run"><button type="button" class="btn" id="tl-go">Ejecutar análisis</button><span class="muted" id="tl-busy" role="status" aria-live="polite"></span></div>
    <div id="tl-err" class="tl-err" hidden></div>`, "tl-form");
}
const HINT_SRC = {
  yahoo: "Precios diarios de Yahoo Finance: cierre sin ajustar (para S₀), cierre ajustado (para los retornos) y dividendos. También la cadena de opciones y los sectores. Necesita conexión y el servidor local o el Worker actualizado.",
  respaldo: "Precios reales guardados al compilar la app (3 años, solo cierre ajustado). Sirve sin conexión, pero no hay cadena de opciones y la partición queda en modo reducido.",
  csv: "Suban sus propios precios y escriban de dónde salieron. Sin cadena de opciones.",
};

// ---------- entrada y salida del formulario ----------
function leerFormulario(root) {
  const fuente = $("#tl-src [aria-selected=true]", root)?.dataset.src || "yahoo";
  const filas = $$(".tl-row", root).map((r) => [$(".tl-t", r).value.trim().toUpperCase(), $(".tl-s", r).value.trim(), $(".tl-q", r).value.trim()]).filter((f) => f[0]);
  const tickers = filas.map((f) => f[0]);
  if (new Set(tickers).size !== tickers.length) throw new Error("Hay símbolos repetidos en la tabla.");
  if (tickers.length < 2) throw new Error("Pongan al menos dos acciones (el taller pide diez).");
  if (tickers.length > 20) throw new Error("Máximo 20 acciones por análisis.");
  const usuario = {}, qManual = {};
  for (const [t, s, q] of filas) {
    if (s) usuario[t] = s;
    if (q !== "") { const v = parseFloat(q.replace(",", ".")); if (!(v >= 0 && v < 30)) throw new Error(`El q de ${t} debe ser un porcentaje entre 0 y 30.`); qManual[t] = Math.log1p(v / 100) ; }
  }
  const params = {};
  for (const [, cs] of GRUPOS) for (const c of cs) {
    const el = $(`[data-p="${c.k}"]`, root);
    if (c.t === "select") params[c.k] = el.value;
    else if (c.k === "Hlista") {
      const hs = [...new Set(el.value.split(/[ ,;]+/).filter(Boolean).map(Number))];
      if (!hs.length || hs.some((h) => !Number.isInteger(h) || h < 1 || h > 252)) throw new Error("Los horizontes H deben ser enteros entre 1 y 252, por ejemplo: 1, 5, 21.");
      if (hs.length > 4) throw new Error("Pongan como máximo cuatro horizontes H.");
      params.Hlista = hs;
    } else if (c.t === "text") params[c.k] = el.value.trim().toUpperCase() || null;
    else {
      const v = parseFloat(el.value.replace(",", "."));
      if (!Number.isFinite(v) || v < c.min || v > c.max) throw new Error(`«${c.l}» debe estar entre ${c.min.toLocaleString("es-CO")} y ${c.max.toLocaleString("es-CO")}.`);
      params[c.k] = +(v / c.s).toPrecision(12);
    }
  }
  if (params.wmin >= params.wmax) throw new Error("El peso mínimo debe ser menor que el máximo.");
  if (params.tickerOpcion && !tickers.includes(params.tickerOpcion)) throw new Error("La acción de la opción debe estar en la tabla.");
  return { fuente, filas, tickers, usuario, qManual, params, years: +$("#tl-years", root).value, prov: $("#tl-prov", root).value };
}
const guardarForm = (c) => store.set("taller", { fuente: c.fuente, filas: c.filas, params: c.params, years: c.years, prov: c.prov });

// ---------- pestañas ----------
const TABS = [["datos", "Datos"], ["gbm", "GBM"], ["opciones", "Opciones"], ["riesgo", "Riesgo"], ["asignacion", "Asignación"], ["evaluacion", "Evaluación"]];
const CARTERAS = [["iguales", "Pesos iguales"], ["inverso", "Inverso al VaR"], ["minvar", "Mínimo VaR"]];

function tabDatos(res) {
  const c = res.calidad, f = res.fechas, w = res.ventana, m = res.meta;
  const sect = tbl(["Acción", "Sector usado", "Yahoo Finance", "Mapa de Horizon", "Escrito por ustedes", "Fuente", "Corrección"], res.sectores.map((s) => [`<b>${esc(s.ticker)}</b>`, esc(s.sector), esc(s.sector_yahoo), esc(s.sector_horizon), esc(s.sector_usuario), esc(s.fuente), s.correccion_manual ? "Sí" : "No"]), { lefts: [0, 1, 2, 3, 4, 5, 6] });
  const cal = tbl(["Acción", "Filas", "Fechas únicas", "Duplicados", "Primera", "Última", "Faltantes", "% falt.", "No positivos", "Mínimo", "Máximo"], c.tabla.map((x) => [`<b>${esc(x.ticker)}</b>`, x.filas, x.fechas_unicas, x.duplicados, x.primera, x.ultima, x.faltantes, nf(x.pct_faltantes, 1), x.no_positivos, nf(x.minimo), nf(x.maximo)]), { lefts: [0, 4, 5] });
  const par = tbl(["Acción", "Sector", "S₀ (sin ajustar)", "Dividendos 12 m", "q", "σ anual", "μ total", "â = μ − q", "Retornos"], res.param.map((x) => [`<b>${esc(x.ticker)}</b>`, esc(x.sector), nf(x.S0_sin_ajustar), nf(x.dividendos_12m), pc(x.q, 2), pc(x.sigma), pc(x.mu_total), pc(x.a), x.n_retornos]), { lefts: [0, 1] });
  const desc = c.info.fechas_descartadas.length ? (c.info.fechas_descartadas.length <= 8 ? c.info.fechas_descartadas.join(", ") : `${c.info.fechas_descartadas.slice(0, 8).join(", ")}… (y ${c.info.fechas_descartadas.length - 8} más)`) : "ninguna";
  const norm = res.dias.map((d) => d);
  const series = res.tickers.map((t, i) => ({ name: t, color: TC.COLS[i % TC.COLS.length], x: norm, y: res.P.map((r) => (r[i] / res.P[0][i]) * 100), width: 1.5 }));
  const eq = res.R.map((r) => r.reduce((s, v) => s + v, 0) / r.length);
  return `
    ${sec("Datos", "de dónde salen y cómo se limpian")}
    ${card(`<div class="stats">
      ${kpi("Fuente", esc(m.fuente.split(" (")[0]), `consulta ${esc(String(m.consulta).slice(0, 10))}`)}
      ${kpi("Sesiones comunes", c.info.sesiones_comunes, `${c.info.sesiones_descartadas} descartadas`)}
      ${kpi("Entrenamiento", `${res.nTrain} retornos`, `${f.entrenamiento[0]} → ${f.entrenamiento[1]}`)}
      ${kpi("Prueba", `${res.nTest} retornos`, `${f.prueba[0]} → ${f.prueba[1]}`)}</div>
      ${w.reducido ? note(esc(w.mensaje), "warn") : `<p class="explain">Partición completa: 504 sesiones para estimar y 252 para probar fuera de muestra. Todo lo que se estima usa solo el entrenamiento.</p>`}
      <p class="explain">Solo se usan las sesiones en las que <b>todas</b> las acciones tienen precio positivo. Fechas descartadas: ${esc(desc)}.</p>`)}
    ${sec("Sectores", "corregibles")}
    ${card(`<p class="explain">El sector de cada acción sale de Yahoo Finance; si no responde, del mapa de Horizon; y si ustedes escriben uno en la tabla de arriba, manda el suyo. Se comparan las tres fuentes y se marca cuando hay corrección manual.</p>${sect}`)}
    ${TC.lineChart({ title: "Precios ajustados (base 100)", hint: "Cada acción parte de 100 en la primera sesión común.", series, xDates: true, height: 300, yFmt: (v) => nf(v, 0) })}
    ${TC.heatmap({ title: "Correlación de retornos diarios", hint: "Solo con el período de entrenamiento.", labels: res.tickers, matrix: res.corr })}
    ${TC.histChart({ title: "Retorno diario de la cartera de pesos iguales", hint: `${res.R.length} sesiones. Las barras son los datos; no se supone que sean normales.`, datasets: [{ name: "Retorno diario", color: TC.COLS[0], data: eq }], bins: 40, xFmt: (v) => nf(v * 100, 1) + " %" })}
    ${sec("Calidad de los datos")}
    ${card(`<p class="explain">Filas descargadas: ${c.info.filas_descargadas.toLocaleString("es-CO")} · duplicados eliminados: ${c.info.duplicados}. Una fecha repetida se queda con su última cotización.</p>${cal}`)}
    ${sec("Parámetros calibrados", "con el entrenamiento")}
    ${card(`${par}${how("Cómo se calibran", `<div class="formula">σ̂ = √252 · s · μ̂ = 252 · x̄ + σ̂²/2 · â = μ̂ − q</div><p class="explain">x̄ y s son la media y la desviación estándar muestral de los log-retornos diarios de entrenamiento. q = ln(1 + dividendos de 12 meses / S₀). S₀ es el último cierre <b>sin ajustar</b>.</p>`)}`)}`;
}

function simGBM(T, i) {
  const k = "g" + i;
  if (!T.sim[k]) { const res = T.res, q = res.param[i]; T.sim[k] = simulateGBM({ S0: q.S0_sin_ajustar, a: q.a, sigma: q.sigma, steps: res.params.horizonteGBM, nPaths: res.params.nTray, seed: semilla(res.params, i), keep: 40, withBands: true }); }
  return T.sim[k];
}
function tabGBM(T) {
  const res = T.res, i = T.sel.gbm, q = res.param[i], s = simGBM(T, i), steps = s.steps, xs = Array.from({ length: steps + 1 }, (_, t) => t);
  const teor = xs.map((t) => q.S0_sin_ajustar * Math.exp((q.a * t) / 252));
  const series = [...s.sample.map((p) => ({ color: TC.COLS[0], x: xs, y: p, width: 0.8, opacity: 0.3, hover: false })), { name: "Mediana simulada", color: TC.COLS[0], x: xs, y: s.bands.p50, width: 2 }, { name: "S₀·e^(â·t) (teórica)", color: TC.COLS[2], x: xs, y: teor, width: 1.8, dash: "6 4" }];
  const ok = Math.abs(s.z) < 1.96;
  const chk = tbl(["Acción", "S₀", "â", "σ", "Media simulada", "S₀·e^(âT)", "Err. est.", "z", "Positivos", "Coincide"], res.gbm.map((g, k) => [`<b>${esc(g.ticker)}</b>`, nf(g.S0), pc(g.a), pc(g.sigma), nf(g.media_simulada), nf(g.S0_e_aT), nf(g.ee, 3), nf(g.z), g.todos_positivos ? "Sí" : "No", g.media_ok ? "Sí" : "No"]), { hi: i });
  return `
    ${sec("Proyección con GBM", "medida real P")}
    ${card(`<div class="tl-pick">${select("gbm", res.tickers, i)}<span class="muted">${esc(q.sector)} · ${s.nPaths.toLocaleString("es-CO")} trayectorias · semilla ${semilla(res.params, i)}</span></div>
      <div class="stats">${kpi("S₀", nf(q.S0_sin_ajustar), "cierre sin ajustar")}${kpi("σ anual", pc(q.sigma))}${kpi("â = μ − q", pc(q.a), `μ ${pc(q.mu_total)} · q ${pc(q.q, 2)}`)}${kpi("Horizonte", `${steps} sesiones`, `T = ${nf(s.T, 3)} años`)}</div>`)}
    ${TC.lineChart({ title: `${esc(res.tickers[i])}: 40 trayectorias y banda 10–90`, hint: "Las líneas finas son 40 de las trayectorias; la banda cubre del percentil 10 al 90 de todas.", series, band: { x: xs, lo: s.bands.p10, hi: s.bands.p90, color: TC.COLS[0], opacity: 0.16 }, height: 320, xLabel: "sesiones", yFmt: (v) => nf(v, v > 100 ? 0 : 2) })}
    ${card(`<h3>¿La simulación reproduce la teoría?</h3><div class="stats">${kpi("Media simulada de S_T", nf(s.media), "")}${kpi("S₀·e^(âT) teórico", nf(s.teorica))}${kpi("Error estándar", nf(s.ee, 3))}${kpi("z", nf(s.z), ok ? "dentro de ±1,96: coincide" : "fuera de ±1,96: revisar", ok ? "pos" : "neg")}</div>
      <p class="explain">Con un GBM la <b>media</b> de S_T es S₀·e^(âT); la mediana es menor porque la distribución es asimétrica. Se compara la media simulada con la teórica en errores estándar. ${s.todosPositivos ? "Todos los precios simulados son positivos." : "<b>Hay precios no positivos: revisar.</b>"}</p>`)}
    ${TC.histChart({ title: `Distribución de S_T (${esc(res.tickers[i])})`, hint: "Precio simulado al final del horizonte.", datasets: [{ name: "S_T simulado", color: TC.COLS[0], data: s.ST }], bins: 48, vlines: [{ v: s.media, label: "media simulada", color: TC.COLS[3] }, { v: s.teorica, label: "S₀·e^(âT)", color: TC.COLS[2], row: 1, dash: "2 3" }], xFmt: (v) => nf(v, v > 100 ? 0 : 2) })}
    ${sec("Chequeo de las diez acciones")}${card(chk)}
    ${card(how("Cómo se simula", `<div class="formula">S(t+Δt) = S(t)·exp[(â − σ²/2)Δt + σ√Δt·Z], Z ~ N(0,1), Δt = 1/252</div><p class="explain">Cada acción usa su propia semilla (semilla base + posición en la tabla), así que repetir con los mismos parámetros da exactamente lo mismo.</p>`))}`;
}

function tabOpciones(T) {
  const res = T.res, o = res.opciones, cc = res.controlCRR;
  const control = `${sec("Control del árbol", "se valida solo")}
    ${card(`<div class="stats">${kpi("Call europea, N = 500", nf(cc.N500, 4), `Black–Scholes ${nf(cc.BS, 4)}`)}${kpi("Put europea", nf(cc.put_europea, 4))}${kpi("Put americana", nf(cc.put_americana, 4), "≥ la europea")}</div><p class="explain">Datos del control: S₀ = K = 100, T = 1 año, r = 5 %, σ = 20 %. Con N = 500 el árbol da ${nf(cc.N500, 4)} y se acerca a 10,4506 (el valor de Black–Scholes) al subir N.</p>`)}
    ${TC.lineChart({ title: "Convergencia del árbol", hint: "Precio de la call europea de control al aumentar los pasos N.", series: [{ name: "Árbol CRR", color: TC.COLS[0], x: cc.convergencia.map((c) => Math.log10(c.N)), y: cc.convergencia.map((c) => c.precio), dots: true, width: 1.8 }], hlines: [{ v: cc.BS, label: `Black–Scholes ${nf(cc.BS, 4)}`, color: TC.COLS[2] }], xFmt: (v) => Math.round(10 ** v).toLocaleString("es-CO"), height: 250, legend: false, xLabel: "pasos N (escala log)" })}`;
  if (!o) return `${sec("Opciones")}${card(`<p><b>No hay cadena de opciones en esta ejecución.</b></p><p class="explain">${esc(res.notaOpciones || "Use Yahoo Finance como fuente para traer la cadena real.")}</p><p class="explain">No se inventan precios: sin cadena no hay tabla de candidatos ni comparación con el mercado. El árbol sí se valida con el control de abajo.</p>`)}${control}`;
  const idx = T.sel.opc ?? o.elegido ?? 0, det = T.det[idx] ||= detalleContrato(o, idx), c = det.fila;
  const filas = o.candidatos.map((x) => [`<b>${esc(x.plazo)}</b>`, x.vencimiento, nf(x.strike), nf(x.beta, 2), x.usable ? `${nf(x.bid)} / ${nf(x.ask)}` : "sin cotización", x.usable ? pc(x.spread_rel, 1) : "—", x.interes_abierto.toLocaleString("es-CO"), pc(x.vol_implicita), pc(x.P_ejercicio), pc(x.P_beneficio), nf(x.E_ganancia), nf(x.V_CRR_sigma_hist), nf(x.V_CRR_vol_impl), `<button type="button" class="chip tl-pickbtn" data-opc="${o.candidatos.indexOf(x)}">${o.candidatos.indexOf(x) === idx ? "Viendo" : "Ver"}</button>`]);
  const m = det.mercado;
  return `
    ${sec("Opciones", `${esc(o.ticker)} · ${o.tipo === "call" ? "call" : "put"} ${o.estilo}`)}
    ${card(`<div class="stats">${kpi("Cadena", esc(String(o.hora).slice(0, 16).replace("T", " ")), `${o.n_vencimientos_listados} vencimientos listados`)}${kpi("Plazos usados", o.plazos.map((p) => `${p.dias_calendario} d`).join(" · "), o.plazos.map((p) => p.vencimiento).join(" · "))}${kpi("S₀ · σ · â", `${nf(o.S0)}`, `σ ${pc(o.sigma)} · â ${pc(o.a)}`)}${kpi("Elegido", o.elegido == null ? "ninguno" : `K ${nf(o.candidatos[o.elegido].strike)} · ${esc(o.candidatos[o.elegido].plazo)}`, "regla de abajo")}</div>
      <p class="explain">Para cada plazo (≈ 1, 3 y 6 meses) se toman los strikes más cercanos a los cuantiles 25, 50 y 75 % de S_T bajo el GBM: <b>9 candidatos</b>. P(ejercicio) y P(beneficio) salen de ${res.params.nTray.toLocaleString("es-CO")} escenarios con los mismos números aleatorios en todos. Beneficio = valor al vencimiento − (ask · e^(rT) + costo terminal). <b>Ojo:</b> â viene del pasado reciente (${pc(o.a)} al año); si el mercado no lo repite, estas probabilidades son optimistas, sobre todo en las calls.</p>
      ${o.notas.map((n) => note(esc(n), "warn")).join("")}
      ${tbl(["Plazo", "Vence", "Strike", "Cuantil", "Bid / Ask", "Spread", "Int. abierto", "Vol. impl.", "P(ejerc.)", "P(benef.)", "E[gan.]", "V_CRR σ hist.", "V_CRR vol. impl.", ""], filas, { hi: idx, lefts: [0, 1] })}
      ${how("Regla de elección", `<p class="explain">Se descartan los contratos sin bid/ask válido, con interés abierto menor a ${res.params.oiMin}, con spread mayor a ${pc(res.params.spreadMax, 0)} o con ganancia esperada no positiva bajo P. Entre los que quedan se elige el de mayor P(beneficio). Que un contrato «pase» no es una recomendación de comprarlo.</p>`)}`)}
    ${TC.premiumChart({ title: "Prima teórica frente al mercado", hint: "La barra gris es el rango bid–ask; el punto azul, el árbol con σ histórica; el rombo naranja, el árbol con la volatilidad implícita. El plazo elegido está sombreado.", cands: o.candidatos, elegido: idx })}
    ${sec(`Contrato ${esc(c.strike)} · ${esc(c.plazo)}`, esc(c.contrato || ""))}
    ${card(`<div class="stats">${kpi("P(ejercicio)", pc(c.P_ejercicio))}${kpi("P(beneficio)", pc(c.P_beneficio))}${kpi("E[ganancia]", c.E_ganancia == null ? "—" : usd(c.E_ganancia, 2), "por acción")}${kpi("V_CRR (σ hist.)", nf(c.V_CRR_sigma_hist), `${o.N} pasos`)}</div>
      ${m ? `<p class="explain">Mercado: bid ${nf(m.bid)} · ask ${nf(m.ask)} · medio ${nf(m.medio)}. El árbol con σ histórica da ${nf(m.V_CRR)} (${m.delta >= 0 ? "+" : ""}${nf(m.delta)}, ${pc(m.delta_rel)} del medio): ${m.dentro ? "<b>cae dentro</b> del bid–ask" : "<b>cae fuera</b> del bid–ask"}. Con la volatilidad implícita (${pc(m.vol_implicita)}) da ${nf(m.V_CRR_vol_impl)}. Una diferencia grande suele reflejar que la σ histórica no es la que el mercado espera.</p>` : note("Este contrato no tiene bid/ask válido: no se puede comparar con el mercado ni calcular el beneficio.", "warn")}
      ${c.nota ? note(esc(c.nota), "warn") : ""}
      ${tbl(["â", "σ", "P(ejercicio)", "P(beneficio)"], det.sens.map((x) => [pc(x.a), pc(x.sigma), pc(x.P_ejercicio), pc(x.P_beneficio)]), { lefts: [] })}
      <p class="explain">Sensibilidad: â ± 5 puntos y σ ×0,8 / ×1 / ×1,2 con los mismos escenarios.</p>`)}
    ${TC.histChart({ title: "Precio al vencimiento (S_T)", hint: "Con la deriva y la volatilidad calibradas. Las líneas marcan el strike y el punto de equilibrio.", datasets: [{ name: "S_T simulado", color: TC.COLS[0], data: det.ST }], bins: 48, vlines: [{ v: c.strike, label: "strike", color: TC.COLS[2] }, ...(c.usable ? [{ v: o.tipo === "call" ? c.strike + c.ask * Math.exp(o.params.r * c.T_valoracion) + o.params.costoT : c.strike - c.ask * Math.exp(o.params.r * c.T_valoracion) - o.params.costoT, label: "equilibrio", color: TC.COLS[3], row: 1 }] : [])], xFmt: (v) => nf(v, 0) })}
    ${det.arbol ? TC.treeChart({ title: "Árbol de 3 pasos", hint: "S es el precio del subyacente y V el valor del contrato; el borde verde marca ejercicio anticipado.", arbol: det.arbol, K: c.strike, tipo: o.tipo }) : ""}
    ${det.conv ? TC.lineChart({ title: "Convergencia de este contrato", hint: "Valor del árbol al subir los pasos.", series: [{ name: "Árbol CRR", color: TC.COLS[0], x: det.conv.map((d) => Math.log10(d.N)), y: det.conv.map((d) => d.precio), dots: true }], xFmt: (v) => Math.round(10 ** v).toLocaleString("es-CO"), height: 250, legend: false, xLabel: "pasos N (escala log)" }) : ""}
    ${card(`<p class="explain">p_Q = (e^((r−q)Δt) − d)/(u − d) se <b>verifica</b> entre 0 y 1; si no lo está, el árbol aumenta los pasos o avisa, nunca recorta.</p><p class="explain">Valor de la prima con σ ×0,8 / ×1 / ×1,2: ${det.precio_sigma.map((x) => nf(x.V_CRR)).join(" · ")}.</p>`)}
    ${control}`;
}

function tabRiesgo(T) {
  const res = T.res, p = res.params, bt = res.backtestVaR, mv = res.varTabla.minvar;
  const filas = CARTERAS.flatMap(([k]) => { const v = res.varTabla[k]; return [[`<b>${esc(v.nombre)}</b>`, usd(v.hist.VaR), usd(v.hist.ES), usd(v.normal.VaR), usd(v.normal.ES), usd(v.mc.VaR), usd(v.mc.ES)]]; });
  const per = res.perdidas.minvar, ndays = bt.dias;
  const ptsEx = bt.banderas.map((b, k) => (b ? { x: ndays[k], y: bt.perdidas[k], color: TC.COLS[3], r: 4, title: `${dia(ndays[k])}: pérdida ${usd(bt.perdidas[k])} > VaR ${usd(bt.vars[k])}` } : null)).filter(Boolean);
  const okK = bt.pValor >= 0.05;
  const estr = tbl(["Cartera", "Escenario", "Pérdida"], res.estres.map((e) => [esc(e.cartera), esc(e.escenario), usd(e.perdida)]), { lefts: [0, 1] });
  return `
    ${sec("Riesgo", `VaR y ES al ${pc(p.alpha, 1)} a ${p.h} sesiones`)}
    ${card(`<p class="explain">Capital ${usd(p.B)}. Las tres carteras se arman y se miden con el período de <b>entrenamiento</b>. VaR = pérdida que no se supera con probabilidad ${pc(p.alpha, 1)}; ES = pérdida media cuando sí se supera.</p>
      ${tbl(["Cartera", "VaR histórico", "ES histórico", "VaR normal", "ES normal", "VaR Monte Carlo", "ES Monte Carlo"], filas)}
      ${how("Qué hace cada método", `<p class="explain"><b>Histórico:</b> bloques de ${p.h} sesiones que se solapan (${mv.hist.bloques} bloques), cuantil ⌈nα⌉ y promedio de la cola. <b>Normal:</b> VaR = B·z·√(h·wᵀΣw). <b>Monte Carlo:</b> ${p.nMC.toLocaleString("es-CO")} escenarios de un GBM conjunto con la matriz de covarianzas (Cholesky) y semilla ${p.seed}.</p>`)}`)}
    ${TC.barChart({ title: "VaR por método y cartera", hint: "Pérdida en USD.", labels: CARTERAS.map(([, n]) => n), series: [{ name: "Histórico", color: TC.COLS[0], values: CARTERAS.map(([k]) => res.varTabla[k].hist.VaR) }, { name: "Normal", color: TC.COLS[2], values: CARTERAS.map(([k]) => res.varTabla[k].normal.VaR) }, { name: "Monte Carlo", color: TC.COLS[1], values: CARTERAS.map(([k]) => res.varTabla[k].mc.VaR) }], yFmt: (v) => nf(v, 0) })}
    ${TC.histChart({ title: "Distribución de pérdidas (Mínimo VaR)", hint: `Pérdidas a ${p.h} sesiones. Positivo = pérdida.`, datasets: [{ name: "Histórico", color: TC.COLS[0], data: per.hist }, { name: "Monte Carlo", color: TC.COLS[2], data: per.mc }], bins: 50, vlines: [{ v: mv.hist.VaR, label: "VaR hist.", color: TC.COLS[3] }, { v: mv.hist.ES, label: "ES hist.", color: TC.COLS[4], row: 1 }], xFmt: (v) => nf(v, 0) })}
    ${sec("Estrés")}${card(`<p class="explain">Pérdida inmediata de cada cartera en tres escenarios fijos. No son pronósticos: muestran cuánto duele si pasa.</p>${estr}`)}
    ${sec("Excepciones del VaR", "prueba de Kupiec")}
    ${card(`<div class="stats">${kpi("Días evaluados", bt.n, `cartera ${esc(bt.cartera)}`)}${kpi("Excepciones", bt.x, `esperadas ${nf(bt.esperadas, 1)}`, bt.x > bt.esperadas * 2 ? "neg" : "")}${kpi("Estadístico LR", nf(bt.LR, 3))}${kpi("p-valor Kupiec", nf(bt.pValor, 3), okK ? "no se rechaza el modelo" : "se rechaza al 5 %", okK ? "pos" : "neg")}</div>
      <p class="explain">Cada día se estima el VaR a 1 día con las ${bt.ventana} sesiones anteriores y se compara con la pérdida real del día, con los pesos constantes del Mínimo VaR. Con ${pc(p.alpha, 1)} de confianza se esperan ${nf(bt.esperadas, 1)} excepciones en ${bt.n} días. ${okK ? "El número observado es compatible con eso." : "El número observado no es compatible con eso: el VaR subestima o sobrestima el riesgo."}</p>`)}
    ${TC.lineChart({ title: "Pérdida diaria frente al VaR a 1 día", hint: "Los puntos rojos son las excepciones: días en que la pérdida superó el VaR.", series: [{ name: "Pérdida diaria", color: TC.COLS[0], x: ndays, y: bt.perdidas, width: 1.2 }, { name: `VaR ${pc(bt.alpha, 1)} (1 día)`, color: TC.COLS[2], x: ndays, y: bt.vars, width: 1.8 }], points: ptsEx, xDates: true, yFmt: (v) => nf(v, 0), height: 280 })}`;
}

function tabAsignacion(T) {
  const res = T.res, p = res.params, a = res.asignacion, e = a.enteras, b = a.presupuesto, lib = a.sinLimiteSector;
  const w = tbl(["Acción", "Sector", ...CARTERAS.map(([, n]) => n), "Mín. VaR sin límite sectorial"], a.pesos.map((x) => [`<b>${esc(x.ticker)}</b>`, esc(x.sector), pc(x.iguales), pc(x.inverso), pc(x.minvar), pc(x.minvar_sin_limite_sectorial)]), { lefts: [0, 1] });
  const sec2 = tbl(["Sector", ...CARTERAS.map(([, n]) => n), "Sin límite", "Límite"], a.porSector.map((x) => [`<b>${esc(x.sector)}</b>`, pc(x.iguales), pc(x.inverso), pc(x.minvar), pc(x.sin_limite), pc(x.limite, 0)]));
  const cant = tbl(["Acción", "Peso", "Monto ideal", "S₀", "Acciones", "Monto real", "Peso real"], a.montos.map((x) => [`<b>${esc(x.ticker)}</b>`, pc(x.peso), usd(x.monto_ideal), nf(x.S0_sin_ajustar), x.cantidad.toLocaleString("es-CO"), usd(x.monto), pc(x.peso_nuevo)]));
  const pres = tbl(["Acción", "Peso", "Monto con presupuesto"], b.montosTabla.map((x) => [`<b>${esc(x.ticker)}</b>`, pc(x.peso), usd(x.monto)]));
  const rc = a.contribuciones;
  const E = res.estrategias, met = tbl(["Estrategia", "Retorno", "Volatilidad", "Sharpe", "Caída máxima", "Costos", "Rotación", "Rebalanceos", "Efectivo final"], E.map((s) => [`<b>${esc(s.nombre)}</b>`, pc(s.retorno), pc(s.vol), nf(s.sharpe), pc(-s.maxDD), usd(s.costo), nf(s.rotacion, 2) + "×", s.rebalanceos, usd(s.efectivoFinal)]));
  const dias = E[0].dias, curvas = E.map((s, k) => ({ name: s.nombre, color: TC.COLS[k % TC.COLS.length], x: dias, y: s.W, width: 1.8 }));
  const dds = E.map((s, k) => ({ name: s.nombre, color: TC.COLS[k % TC.COLS.length], x: dias, y: s.dd, width: 1.5 }));
  const sel = T.sel.est, S = E[sel], names = E.map((s) => s.nombre);
  const logT = tbl(["Fecha", "Costo", "Invertido", "Efectivo", ...res.tickers], S.log.map((r) => [dia(r.fecha), usd(r.costo, 2), pc(r.invertido), usd(r.efectivo), ...r.pesos.map((x) => pc(x, 1))]), { lefts: [0] });
  return `
    ${sec("Asignación", "tres formas de repartir el capital")}
    ${card(`<p class="explain">Igual al peso de cada acción, inverso a su VaR individual, y el Mínimo VaR (el reparto de menor riesgo con ${pc(p.wmin, 0)}–${pc(p.wmax, 0)} por acción y ${pc(p.limSector, 0)} por sector). Se estiman con el entrenamiento.</p>${w}
      ${a.fueraInverso.length ? note(`El inverso al VaR no respeta los límites en: ${esc(a.fueraInverso.join(", "))}. Es solo una comparación: ignora correlaciones y límites.`, "warn") : ""}`)}
    ${TC.barChart({ title: "Peso por acción", hint: "Cada acción con las tres reglas.", labels: res.tickers, series: CARTERAS.map(([k, n], i) => ({ name: n, color: TC.COLS[i], values: a.pesos.map((x) => x[k]) })), pctAxis: true })}
    ${TC.barChart({ title: "Peso por sector", hint: `La línea roja es el límite del ${pc(p.limSector, 0)}.`, labels: a.porSector.map((x) => x.sector), series: CARTERAS.map(([k, n], i) => ({ name: n, color: TC.COLS[i], values: a.porSector.map((x) => x[k]) })), hlines: [{ v: p.limSector, label: "límite sectorial", color: TC.COLS[3] }], pctAxis: true })}
    ${card(`${sec2}<p class="explain">Costo del límite sectorial: el VaR normal del Mínimo VaR sube de ${usd(lib.VaR)} (sin límite) a ${usd(e.VaRNormalCompleto)} (con límite), ${usd(lib.costoLimite)} más. Es el precio de no concentrarse en un sector.</p>`)}
    ${sec("Montos y cantidades", "Mínimo VaR")}
    ${card(`<p class="explain">Se compran acciones enteras al último cierre sin ajustar; lo que sobra queda en efectivo y no tiene riesgo.</p>${cant}<div class="stats">${kpi("Invertido", usd(e.invertido))}${kpi("Efectivo sobrante", usd(e.residual))}${kpi("VaR normal", usd(e.VaRNormal), `${p.h} sesiones`)}</div>`)}
    ${sec("Presupuesto de riesgo", `V̄ = ${usd(p.vbar)}`)}
    ${card(`<div class="stats">${kpi("Fracción invertida", pc(b.f), b.f < 1 ? "el resto queda en efectivo" : "el VaR ya cabe en el presupuesto")}${kpi("Efectivo", usd(b.efectivo))}${kpi("VaR resultante", usd(b.VaRfinal), `completo ${usd(b.VaRCompleto)}`)}</div><p class="explain">Se invierte la fracción f = mín(1, V̄ / VaR completo) del capital con los pesos del Mínimo VaR, así el VaR no supera el presupuesto.</p>${pres}`)}
    ${TC.barChart({ title: "Contribución al riesgo (Mínimo VaR)", hint: "Cuánto aporta cada acción a la varianza de la cartera; suman 100 %.", labels: res.tickers, series: [{ name: "Contribución", color: TC.COLS[0], values: rc.map((x) => x.contribucion) }], pctAxis: true })}
    ${sec("Fuera de muestra", `${res.nTest} sesiones con costos`)}
    ${card(`<p class="explain">Se simulan cinco estrategias durante la ventana de prueba, que el modelo no vio. Las mensuales rebalancean el primer día de cada mes con los ${res.nTrain} retornos anteriores. Costo de operar: ${p.costBps} puntos básicos sobre lo que se compra y se vende; el efectivo rinde la tasa libre de riesgo.</p>${met}
      ${note("Este resultado es una sola ventana de un año. Compara formas de repartir el capital; no promete rendimientos futuros.")}`)}
    ${TC.lineChart({ title: "Patrimonio", hint: `Parten de ${usd(p.B)}.`, series: curvas, xDates: true, yFmt: (v) => nf(v, 0), height: 300 })}
    ${TC.lineChart({ title: "Caída desde el máximo (drawdown)", hint: "Cuánto está por debajo de su máximo anterior.", series: dds, xDates: true, yFmt: (v) => nf(v * 100, 0) + " %", height: 260 })}
    ${card(`<h3>Rebalanceos</h3><div class="tl-pick">${select("est", names, sel)}</div>${logT}`)}`;
}

function tabEvaluacion(T) {
  const res = T.res, Hs = Object.keys(res.rolling).map(Number).sort((a, b) => a - b), H = Hs[T.sel.H] ?? Hs[0], r = res.rolling[H], i = T.sel.rol, f = r.filas[i], s = f.serie;
  const gana = r.filas.filter((x) => x.razon < 1).length;
  const tab = tbl(["Acción", "Pronósticos", "RMSE", "RMSE ingenuo", "Razón", "MAPE", "MAPE ingenuo", "¿Gana al ingenuo?"], r.filas.map((x, k) => [`<b>${esc(x.ticker)}</b>`, x.m, nf(x.RMSE), nf(x.RMSE_ingenuo), nf(x.razon, 3), nf(x.MAPE, 2) + " %", nf(x.MAPE_ingenuo, 2) + " %", x.razon < 1 ? "Sí" : "No"]), { hi: i });
  return `
    ${sec("Evaluación rolling", "¿el GBM pronostica mejor que no hacer nada?")}
    ${card(`<div class="tl-pick">${select("H", Hs.map((h) => `H = ${h} sesión${h > 1 ? "es" : ""}`), Hs.indexOf(H))}</div>
      <p class="explain">En cada fecha de origen se reestiman μ y σ con las 252 sesiones anteriores y se pronostica el precio H sesiones adelante: P̂ = P_t · e^(μ̂·H/252). Se compara con el pronóstico ingenuo (el precio de hoy). Origen entre ${r.info.primer_origen} y el último objetivo ${r.info.ultimo_objetivo}; ${r.info.m} pronósticos por acción.</p>
      <div class="stats">${kpi("Acciones donde gana el GBM", `${gana} de ${r.filas.length}`, "razón RMSE menor que 1", gana > r.filas.length / 2 ? "pos" : "")}${kpi("Razón RMSE media", nf(r.filas.reduce((a, x) => a + x.razon, 0) / r.filas.length, 3), "1 = igual al ingenuo")}</div>
      ${tab}
      ${note("Una razón cercana a 1 significa que el modelo casi no mejora a «el precio de mañana es el de hoy». Con precios de acciones es lo esperable: el valor de este análisis es medirlo, no esconderlo.")}`)}
    ${card(`<div class="tl-pick">${select("rol", res.tickers, i)}<span class="muted">RMSE ${nf(f.RMSE)} · ingenuo ${nf(f.RMSE_ingenuo)} · MAPE ${nf(f.MAPE, 2)} %</span></div>`)}
    ${TC.lineChart({ title: `${esc(f.ticker)}: pronóstico frente a lo observado`, hint: `Cada punto es el pronóstico hecho ${H} sesión${H > 1 ? "es" : ""} antes para esa fecha.`, series: [{ name: "Observado", color: TC.COLS[0], x: r.dias, y: s.observado, width: 1.8 }, { name: "Pronóstico GBM", color: TC.COLS[2], x: r.dias, y: s.pronostico, width: 1.4 }, { name: "Ingenuo", color: TC.COLS[4], x: r.dias, y: s.ingenuo, width: 1.2, dash: "4 4" }], xDates: true, yFmt: (v) => nf(v, 0), height: 300 })}
    ${TC.barChart({ title: "RMSE del GBM frente al ingenuo", hint: "Por debajo de la línea roja el GBM gana; por encima, pierde. Las diferencias suelen ser de décimas de punto porcentual.", labels: res.tickers, series: [{ name: "Diferencia de RMSE", color: TC.COLS[0], values: r.filas.map((x) => x.razon - 1) }], hlines: [{ v: 0, label: "igual al ingenuo", color: TC.COLS[3] }], yFmt: (v) => nf(v * 100, 1) + " %" })}`;
}

const PANELS = { datos: (T) => tabDatos(T.res), gbm: tabGBM, opciones: tabOpciones, riesgo: tabRiesgo, asignacion: tabAsignacion, evaluacion: tabEvaluacion };

// ---------- resumen superior ----------
function resumen(res) {
  const p = res.params, a = res.varTabla.iguales.normal.VaR, m = res.varTabla.minvar.normal.VaR, bt = res.backtestVaR;
  const E = Object.fromEntries(res.estrategias.map((s) => [s.clave, s])), mm = E.minvar_mensual, ig = E.iguales;
  return `<div class="glass tl-card tl-sum">
    <h2>Resultado</h2>
    <div class="stats">
      ${kpi(`VaR ${pc(p.alpha, 0)} a ${p.h} sesiones`, usd(res.varTabla.minvar.hist.VaR), `Mínimo VaR · histórico · ES ${usd(res.varTabla.minvar.hist.ES)}`)}
      ${kpi("Menos riesgo que repartir igual", pc(1 - m / a, 0), `VaR normal ${usd(m)} frente a ${usd(a)}`, m < a ? "pos" : "")}
      ${kpi("Excepciones del VaR", `${bt.x} de ${bt.n}`, `esperadas ${nf(bt.esperadas, 1)} · Kupiec p = ${nf(bt.pValor, 2)}`, bt.pValor >= 0.05 ? "pos" : "neg")}
      ${kpi("Caída máxima fuera de muestra", pc(-mm.maxDD), `Mínimo VaR mensual · pesos iguales ${pc(-ig.maxDD)}`, mm.maxDD < ig.maxDD ? "pos" : "")}
    </div>
    ${res.avisos.length ? `<div class="tl-avisos">${res.avisos.map((x) => note(esc(x), "warn")).join("")}</div>` : ""}
    <div class="tl-actions"><button type="button" class="btn" id="tl-zip">Descargar resultados (ZIP)</button><span class="muted">CSV de cada tabla, resumen.json con parámetros y semilla (${p.seed}) y LEEME.</span></div>
  </div>`;
}

// ---------- pantalla ----------
export function renderTaller({ view, ico, disclaimer, toast, alive }) {
  const sv = store.get("taller", {});
  view.innerHTML = `
    <section class="hero rise"><div class="eyebrow">Taller de riesgo</div><h1 class="title">Armar un portafolio con el <em>riesgo medido</em></h1>
    <p class="lead">Diez acciones, un capital y una pregunta: ¿cuánto se puede perder y cómo repartirlo? Horizon calcula el VaR y el ES, simula el precio, valora opciones con datos reales y prueba el reparto fuera de muestra.</p></section>
    ${formHTML(sv, ico)}
    <div id="tl-out" aria-live="polite"></div>
    ${card(`<p class="explain"><b>Créditos.</b> El diseño de este análisis parte del <i>Taller de valoración y riesgo</i> de <b>Felipe Pulido</b> (Streamlit). Horizon lo reimplementa en JavaScript, sin servidor, y cada cálculo se verifica contra una referencia independiente en Python (numpy y scipy): 600+ comprobaciones automáticas.</p>
      ${how("Por qué JavaScript y no Streamlit", `<p class="explain">Es una herramienta equivalente: tiene entradas editables, un botón que ejecuta el análisis, tablas, gráficos y exportación de resultados con parámetros y semilla. La diferencia es que corre en el navegador (también en el celular) y no necesita Python ni un servidor.</p>`)}`, "tl-credit")}
    ${disclaimer()}`;
  const root = view, out = $("#tl-out", root);
  let T = null;

  const setSrc = (k) => { $$("#tl-src button", root).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.src === k))); $("#tl-csv", root).hidden = k !== "csv"; $("#tl-srchint", root).textContent = HINT_SRC[k]; };
  setSrc(sv.fuente || "yahoo");
  $("#tl-src", root).addEventListener("click", (e) => { const b = e.target.closest("[data-src]"); if (b) setSrc(b.dataset.src); });

  // sectores de referencia como sugerencia en la tabla
  const rows = $("#tl-rows", root);
  let mapaSug = {};
  const fill = () => $$(".tl-row", rows).forEach((r) => { const t = $(".tl-t", r).value.trim().toUpperCase(); $(".tl-s", r).placeholder = mapaSug[t] || "Sector"; });
  loadSectorMap().then((mapa) => { mapaSug = mapa; if (alive()) fill(); });
  rows.addEventListener("change", (e) => { if (e.target.classList?.contains("tl-t")) fill(); });
  rows.addEventListener("click", (e) => { const x = e.target.closest(".tl-x"); if (x) x.closest(".tl-row").remove(); });
  $("#tl-add", root).addEventListener("click", () => { rows.insertAdjacentHTML("beforeend", filaTicker()); fill(); $$(".tl-t", rows).at(-1).focus(); });
  $("#tl-reset", root).addEventListener("click", () => { rows.innerHTML = TICKERS_DEFECTO.map(([t]) => filaTicker(t)).join(""); fill(); });

  const err = (m) => { const el = $("#tl-err", root); el.hidden = !m; el.textContent = m || ""; };
  const busy = (m) => { $("#tl-busy", root).textContent = m || ""; $("#tl-go", root).disabled = !!m; };

  $("#tl-go", root).addEventListener("click", async () => {
    err(""); out.innerHTML = "";
    let cfg;
    try { cfg = leerFormulario(root); } catch (e) { err(e.message); return; }
    guardarForm(cfg);
    try {
      busy("Cargando precios…");
      const csv = cfg.fuente === "csv" ? { csvAjustado: await $("#tl-f1", root).files[0]?.text(), csvSinAjustar: await $("#tl-f2", root).files[0]?.text(), procedencia: cfg.prov } : {};
      const carga = await cargarPrecios({ tickers: cfg.tickers, fuente: cfg.fuente, years: cfg.years, ...csv });
      if (!alive()) return;
      let yahoo = {}, mapa = await loadSectorMap(), avisos = [...carga.avisos], chain = null, notaOpciones = "";
      if (cfg.fuente === "yahoo") {
        busy("Consultando sectores…");
        try { yahoo = (await sectoresReferencia(cfg.tickers)).yahoo; } catch (e) { /* queda el mapa de Horizon */ }
        if (!Object.keys(yahoo).length) avisos.push("Yahoo Finance no entregó sectores (el Worker puede estar sin actualizar): se usó el mapa de Horizon.");
        busy("Trayendo la cadena de opciones…");
        const tk = cfg.params.tickerOpcion || cfg.tickers[0];
        try { chain = await getOptionsChain(tk); } catch (e) { notaOpciones = `No se pudo traer la cadena de opciones de ${tk}: ${e.message}`; avisos.push(notaOpciones); }
      } else notaOpciones = "Con esta fuente de datos no hay cadena de opciones. Elijan Yahoo Finance para traerla.";
      if (!alive()) return;
      const sectores = tablaSectores(cfg.tickers, cfg.usuario, yahoo, mapa, new Date().toISOString().slice(0, 10));
      busy("Calculando riesgo, simulaciones y estrategias…");
      await tick();
      const res = correrTaller({ series: carga.series, sectores, params: cfg.params, qManual: cfg.qManual, meta: carga.meta, avisos, chain });
      res.notaOpciones = notaOpciones;
      T = { res, tab: "datos", sim: {}, det: {}, sel: { gbm: 0, opc: null, est: 3, rol: 0, H: 0 } };
      pintar();
      $("#tl-resultados", root)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    } catch (e) { err(e.message || String(e)); }
    finally { busy(""); }
  });

  function pintar() {
    out.innerHTML = `<div id="tl-resultados">${resumen(T.res)}
      <div class="tl-tabs" role="tablist">${TABS.map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === T.tab}">${l}</button>`).join("")}</div>
      <div id="tl-panel" role="tabpanel"></div></div>`;
    panel();
  }
  function panel() {
    $$(".tl-tabs [role=tab]", out).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === T.tab)));
    const el = $("#tl-panel", out);
    TC.setChartWidth((el.clientWidth || 720) - 36);
    try { el.innerHTML = PANELS[T.tab](T); } catch (e) { el.innerHTML = note(esc("No se pudo dibujar esta pestaña: " + e.message), "warn"); }
    TC.bindTallerHover(el);
  }
  out.addEventListener("click", (e) => {
    const tb = e.target.closest("[data-tab]");
    if (tb) { T.tab = tb.dataset.tab; panel(); return; }
    const pk = e.target.closest("[data-opc]");
    if (pk) { T.sel.opc = +pk.dataset.opc; panel(); return; }
    if (e.target.closest("#tl-zip")) {
      try {
        const zip = buildZip(archivosResultados(T.res)), url = URL.createObjectURL(new Blob([zip], { type: "application/zip" })), a = document.createElement("a");
        a.href = url; a.download = `horizon-taller-${new Date().toISOString().slice(0, 10)}.zip`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast("Resultados descargados");
      } catch (er) { err("No se pudo armar el ZIP: " + er.message); }
    }
  });
  out.addEventListener("change", (e) => { const s = e.target.closest("select[data-k]"); if (s && T) { T.sel[s.dataset.k] = +s.value; if (s.dataset.k === "H") T.sel.rol = Math.min(T.sel.rol, T.res.tickers.length - 1); panel(); } });
}
