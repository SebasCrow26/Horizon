// Orquestador del Taller de riesgo: une datos, GBM, opciones, VaR/ES, asignación, estrategias y evaluación rolling.
// Es el equivalente del "analisis.correr" del Taller de valoración y riesgo de Felipe Pulido (implementación propia en JavaScript).
import { covMatrix, riskTable, stress, exceptionsBacktest, riskBudget, minVariance, riskContributions, varNormal, alignMany } from "./risk.js";
import { calibrate, dividendYield, simulateGBM, rollingEval } from "./gbm.js";
import { backtest, ESTRATEGIAS, inverseVarWeights, equalWeights, minVarWeights, integerAllocation, drawdowns, N_TRAIN, N_TEST } from "./strategies.js";
import { qualityReport, ventanas, fechasVentanas, tablaSectores, dedupe, toCSV } from "./taller-data.js";
import { analizarCadena, controlCRR } from "./options.js";

export const VERSION_TALLER = "Horizon · Taller de riesgo 1.0";
export const TICKERS_DEFECTO = [["AAPL", "Tecnología"], ["MSFT", "Tecnología"], ["JPM", "Financiero"], ["BAC", "Financiero"], ["XOM", "Energía"], ["JNJ", "Salud"], ["UNH", "Salud"], ["KO", "Consumo básico"], ["PG", "Consumo básico"], ["WMT", "Consumo básico"]];
export const PARAMS_DEFECTO = {
  B: 100000, alpha: 0.99, h: 10, r: 0.038, nMC: 20000,                         // mercado y VaR
  nTray: 10000, seed: 123, horizonteGBM: 126,                                   // GBM
  tipo: "call", estilo: "americana", N: 500, costoT: 0, oiMin: 100, spreadMax: 0.10, tickerOpcion: null, // opciones
  wmin: 0.02, wmax: 0.20, limSector: 0.35, vbar: 5000, costBps: 10,             // asignación y estrategias
  Hlista: [1],                                                                  // evaluación rolling
};
export const semilla = (p, i) => p.seed + i; // una semilla distinta y reproducible por acción

const col = (M, i) => M.map((r) => r[i]);
function grupos(labels, limite) { const m = new Map(); labels.forEach((l, i) => { if (!m.has(l)) m.set(l, []); m.get(l).push(i); }); return [...m.entries()].map(([sector, idx]) => ({ sector, idx, limit: limite })); }
function validarLimites(g, wmax, n) {
  const cap = g.reduce((s, x) => s + Math.min(x.limit, x.idx.length * wmax), 0);
  if (cap < 1 - 1e-9) throw new Error(`Con ${(g[0].limit * 100).toFixed(0)} % por sector y ${(wmax * 100).toFixed(0)} % por acción solo se puede invertir ${(cap * 100).toFixed(0)} % de ${n} acciones en ${g.length} sectores. Suban el límite sectorial o el máximo por acción, o agreguen sectores.`);
}

// series: [{ sym, name, cur, t, adj, close, divs, sinAjustar }]. sectores: tabla de tablaSectores(). chain: cadena de opciones (opcional).
export function correrTaller({ series, sectores, params: p0 = {}, qManual = {}, meta = {}, avisos: avisosPrevios = [], chain = null }) {
  const p = { ...PARAMS_DEFECTO, ...p0 }, avisos = [...avisosPrevios];
  const tickers = series.map((s) => s.sym), n = tickers.length;
  if (n < 2) throw new Error("Pongan al menos dos acciones en la tabla.");
  const sectorDe = tickers.map((t) => sectores.find((s) => s.ticker === t)?.sector ?? "Sin clasificar");

  // ---- datos: sesiones comunes, retornos y ventanas ----
  const calidad = qualityReport(series.map((s) => ({ sym: s.sym, t: s.t, adj: s.adj })));
  const mapa = (campo) => series.map((s) => { const m = new Map(), d = dedupe(s.t, s[campo]); d.dias.forEach((k, i) => m.set(k, d.valores[i])); return m; });
  const mA = mapa("adj"), mC = mapa("close"), comunes = calidad.comunes;
  if (comunes.length < 3) throw new Error("No hay sesiones comunes suficientes entre las acciones.");
  const Pfull = comunes.map((d) => mA.map((m) => m.get(d))), Cfull = comunes.map((d) => mC.map((m) => m.get(d)));
  const Rfull = Pfull.slice(1).map((row, k) => row.map((v, i) => v / Pfull[k][i] - 1)), Xfull = Pfull.slice(1).map((row, k) => row.map((v, i) => Math.log(v / Pfull[k][i])));
  const w = ventanas(Rfull.length, { nTrain: N_TRAIN, nTest: N_TEST });
  if (w.reducido) avisos.push(w.mensaje);
  const ini = Rfull.length - w.usados, P = Pfull.slice(ini), days = comunes.slice(ini), R = Rfull.slice(ini), X = Xfull.slice(ini);
  const nTrain = w.nTrain, nTest = w.nTest, Rtr = R.slice(0, nTrain), Xtr = X.slice(0, nTrain);
  const fechas = { retornos_disponibles: Rfull.length, ventana: w, ...fechasVentanas(comunes, w) };
  const S0 = Cfull[Cfull.length - 1].slice(), fechaS0 = new Date(comunes.at(-1) * 86400000).toISOString().slice(0, 10), asOf = comunes.at(-1) * 86400;
  if (series.some((s) => s.sinAjustar)) avisos.push("Alguna serie no trae cierre sin ajustar: S0 es el último precio ajustado (las cantidades enteras son aproximadas).");

  // ---- parámetros del GBM calibrados con el entrenamiento ----
  const Ptr = P.slice(0, nTrain + 1), param = tickers.map((t, i) => {
    const dv = dividendYield(series[i].divs, S0[i], asOf), q = qManual[t] != null && Number.isFinite(qManual[t]) ? qManual[t] : dv.q, cal = calibrate(col(Ptr, i), q);
    return { ticker: t, sector: sectorDe[i], S0_sin_ajustar: S0[i], dividendos_12m: dv.suma12m, q, q_origen: qManual[t] != null && Number.isFinite(qManual[t]) ? "manual" : series[i].divs?.length ? "dividendos de 12 meses" : "sin dividendos", sigma: cal.sigma, mu_total: cal.muTotal, a: cal.a, n_retornos: cal.n };
  });
  const SigmaR = covMatrix(Rtr, 1), sd = SigmaR.map((r, i) => Math.sqrt(r[i])), corr = SigmaR.map((r, i) => r.map((v, j) => v / (sd[i] * sd[j])));

  // ---- carteras (se estiman con el entrenamiento) ----
  const g = grupos(sectorDe, p.limSector);
  validarLimites(g, p.wmax, n);
  const lim = { wmin: p.wmin, wmax: p.wmax, groups: g.map((x) => ({ limit: x.limit, idx: x.idx })) };
  const pesos = { iguales: equalWeights(n), inverso: inverseVarWeights(Rtr, p.h, p.alpha), minvar: minVarWeights(Rtr, lim) }, wLibre = minVarWeights(Rtr, { wmin: p.wmin, wmax: p.wmax });
  const nombresCartera = { iguales: "Pesos iguales", inverso: "Inverso al VaR individual", minvar: "Mínimo VaR" };
  const varTabla = {}, perdidas = {}, estres = [];
  for (const [k, wk] of Object.entries(pesos)) {
    const rt = riskTable({ R: Rtr, X: Xtr, w: wk, B: p.B, alpha: p.alpha, h: p.h, nMC: p.nMC, seed: p.seed });
    varTabla[k] = { nombre: nombresCartera[k], hist: rt.hist, normal: rt.normal, mc: rt.mc }; perdidas[k] = { hist: rt.lossesHist, mc: rt.lossesMC };
    for (const e of stress({ w: wk, B: p.B, SigmaR, h: p.h, alpha: p.alpha, groups: sectorDe })) estres.push({ cartera: nombresCartera[k], ...e });
  }
  // excepciones del VaR diario con la cartera de mínimo VaR (pesos constantes)
  const bt = exceptionsBacktest(R, pesos.minvar, p.B, p.alpha, 252, nTrain);
  const backtestVaR = { ...bt, dias: bt.indices.map((t) => days[t + 1]), cartera: nombresCartera.minvar };

  // ---- asignación: pesos por acción y por sector, montos enteros y presupuesto de riesgo ----
  const sectoresUnicos = g.map((x) => x.sector), sumaSector = (wk, idx) => idx.reduce((s, i) => s + wk[i], 0);
  const pesosTabla = tickers.map((t, i) => ({ ticker: t, sector: sectorDe[i], iguales: pesos.iguales[i], inverso: pesos.inverso[i], minvar: pesos.minvar[i], minvar_sin_limite_sectorial: wLibre[i] }));
  const porSector = g.map((x) => ({ sector: x.sector, iguales: sumaSector(pesos.iguales, x.idx), inverso: sumaSector(pesos.inverso, x.idx), minvar: sumaSector(pesos.minvar, x.idx), sin_limite: sumaSector(wLibre, x.idx), limite: x.limit }));
  const fueraInverso = [...tickers.filter((t, i) => pesos.inverso[i] < p.wmin - 1e-9 || pesos.inverso[i] > p.wmax + 1e-9), ...porSector.filter((s) => s.inverso > s.limite + 1e-9).map((s) => s.sector)];
  const ent = integerAllocation({ w: pesos.minvar, B: p.B, S0, SigmaR, h: p.h, alpha: p.alpha });
  const montos = tickers.map((t, i) => ({ ticker: t, sector: sectorDe[i], peso: pesos.minvar[i], monto_ideal: p.B * pesos.minvar[i], S0_sin_ajustar: S0[i], cantidad: ent.cantidades[i], monto: ent.montos[i], peso_nuevo: ent.pesosNuevos[i] }));
  const vFull = varNormal(SigmaR, pesos.minvar, p.B, p.alpha, p.h).VaR, vLibre = varNormal(SigmaR, wLibre, p.B, p.alpha, p.h).VaR;
  const presupuesto = riskBudget({ w: pesos.minvar, B: p.B, VaRfull: vFull, Vbar: p.vbar });
  const asignacion = {
    pesos: pesosTabla, porSector, fueraInverso, contribuciones: riskContributions(SigmaR, pesos.minvar).map((c, i) => ({ ticker: tickers[i], contribucion: c })),
    enteras: { ...ent, VaRNormalCompleto: vFull }, montos, sinLimiteSector: { w: wLibre, VaR: vLibre, costoLimite: vFull - vLibre },
    presupuesto: { ...presupuesto, VaRCompleto: vFull, Vbar: p.vbar, montosTabla: tickers.map((t, i) => ({ ticker: t, sector: sectorDe[i], peso: pesos.minvar[i], monto: presupuesto.montos[i] })) },
  };

  // ---- estrategias fuera de muestra (con costos) ----
  const params = { B: p.B, alpha: p.alpha, h: p.h, r: p.r, costBps: p.costBps, wmin: p.wmin, wmax: p.wmax, groups: lim.groups, vbar: p.vbar, nTrain, nTest };
  const estrategias = Object.keys(ESTRATEGIAS).map((k) => { const r = backtest({ P, days, clave: k, params }); return { ...r, dd: drawdowns(r.W) }; });

  // ---- evaluación rolling del GBM ----
  const rolling = {};
  for (const H of [...p.Hlista].sort((a, b) => a - b)) {
    const filas = tickers.map((t, i) => { const r = rollingEval({ P: col(P, i), H, window: 252, firstOrigin: nTrain }); return { ticker: t, m: r.m, RMSE: r.RMSE, RMSE_ingenuo: r.RMSE_ingenuo, razon: r.razon, MAPE: r.MAPE, MAPE_ingenuo: r.MAPE_ingenuo, serie: r }; });
    const o0 = filas[0].serie.origenes[0], oN = filas[0].serie.origenes.at(-1);
    rolling[H] = { H, filas, info: { H, m: filas[0].m, primer_origen: new Date(days[o0] * 86400000).toISOString().slice(0, 10), primer_objetivo: new Date(days[o0 + H] * 86400000).toISOString().slice(0, 10), ultimo_objetivo: new Date(days[oN + H] * 86400000).toISOString().slice(0, 10) }, dias: filas[0].serie.origenes.map((o) => days[o + H]) };
  }

  // ---- GBM: chequeo de todas las acciones (la proyección de cada una se simula en la pestaña) ----
  const gbm = param.map((q, i) => { const s = simulateGBM({ S0: q.S0_sin_ajustar, a: q.a, sigma: q.sigma, steps: p.horizonteGBM, nPaths: p.nTray, seed: semilla(p, i), keep: 0, withBands: false }); return { ticker: q.ticker, S0: q.S0_sin_ajustar, a: q.a, sigma: q.sigma, T_años: s.T, media_simulada: s.media, S0_e_aT: s.teorica, ee: s.ee, z: s.z, todos_positivos: s.todosPositivos, media_ok: Math.abs(s.z) < 1.96 }; });

  // ---- opciones ----
  let opciones = null;
  const iOpc = Math.max(0, tickers.indexOf(p.tickerOpcion ?? tickers[0]));
  if (chain) {
    const q = param[iOpc];
    opciones = analizarCadena({ ticker: tickers[iOpc], S0: q.S0_sin_ajustar, a: q.a, sigma: q.sigma, q: q.q, r: p.r, chain, tipo: p.tipo, estilo: p.estilo, N: p.N, costoT: p.costoT, oiMin: p.oiMin, spreadMax: p.spreadMax, nTray: p.nTray, seed: semilla(p, iOpc) });
  }

  if (tickers.length !== 10) avisos.push(`El taller pide diez acciones y la tabla tiene ${tickers.length}.`);
  if (new Set(sectorDe).size < 4) avisos.push("El taller pide al menos cuatro sectores.");
  const sinSector = tickers.filter((t, i) => sectorDe[i] === "Sin clasificar");
  if (sinSector.length) avisos.push("Sin sector: " + sinSector.join(", ") + ". Escríbanlo en la tabla para que cuente en el límite sectorial.");

  return {
    version: VERSION_TALLER, runId: Date.now().toString(36), params: p, meta: { ...meta, fecha_s0: fechaS0 }, avisos, tickers, sectorDe, sectores,
    calidad, fechas, dias: days, P, R, ventana: w, S0, fechaS0, param, SigmaR, corr, pesos, nombresCartera, varTabla, perdidas, estres, backtestVaR,
    asignacion, estrategias, rolling, gbm, opciones, tickerOpcion: tickers[iOpc], controlCRR: controlCRR(), nTrain, nTest,
  };
}

// ---------- exportación: CSV + resumen de parámetros y semilla ----------
const f4 = (x) => (Number.isFinite(x) ? +x.toFixed(10) : x);
export function archivosResultados(res) {
  const p = res.params, out = [];
  const csv = (nombre, filas, cols) => out.push({ name: nombre, data: toCSV(filas, cols) });
  const resumen = {
    herramienta: res.version, creditos: "Diseño del análisis de riesgo basado en el Taller de valoración y riesgo de Felipe Pulido; implementación propia en JavaScript, verificada contra una referencia en Python (numpy y scipy).",
    ejecutado: new Date().toISOString(), fuente_de_datos: res.meta.fuente, consulta_de_datos: res.meta.consulta, fecha_S0: res.fechaS0,
    semilla_base: p.seed, semillas_por_accion: Object.fromEntries(res.tickers.map((t, i) => [t, semilla(p, i)])), escenarios_Monte_Carlo_VaR: p.nMC, trayectorias_GBM: p.nTray,
    parametros: { capital_B: p.B, confianza_alpha: p.alpha, horizonte_VaR_h: p.h, tasa_libre_r: p.r, horizonte_GBM_sesiones: p.horizonteGBM, peso_minimo: p.wmin, peso_maximo: p.wmax, limite_por_sector: p.limSector, presupuesto_de_riesgo_Vbar: p.vbar, costo_pb: p.costBps, horizontes_rolling_H: p.Hlista, opcion: { ticker: res.tickerOpcion, tipo: p.tipo, estilo: p.estilo, pasos_N: p.N, costo_terminal: p.costoT, interes_abierto_minimo: p.oiMin, spread_maximo: p.spreadMax } },
    ventanas: { retornos_comunes: res.fechas.retornos_disponibles, entrenamiento: { retornos: res.nTrain, desde: res.fechas.entrenamiento[0], hasta: res.fechas.entrenamiento[1] }, prueba: { retornos: res.nTest, desde: res.fechas.prueba[0], hasta: res.fechas.prueba[1] }, modo_reducido: res.ventana.reducido },
    acciones: res.tickers.map((t, i) => ({ ticker: t, sector: res.sectorDe[i], fuente_del_sector: res.sectores[i]?.fuente })), avisos: res.avisos,
    entorno: typeof navigator !== "undefined" ? navigator.userAgent : "Node.js", decimales: "punto decimal; separador de campos: coma; codificación UTF-8",
  };
  out.push({ name: "resumen.json", data: JSON.stringify(resumen, null, 2) });
  out.push({ name: "LEEME.txt", data: `Resultados del Taller de riesgo de Horizon\r\n${res.version}\r\nEjecutado: ${resumen.ejecutado}\r\nFuente de datos: ${res.meta.fuente} (consulta ${res.meta.consulta})\r\nSemilla base: ${p.seed} (una semilla distinta por acción: semilla base + posición)\r\n\r\nArchivos: calidad_datos, sectores, parametros_gbm, var_es, estres, asignacion, montos, presupuesto_de_riesgo, estrategias, curvas_patrimonio, rolling_H*, gbm_chequeo, opciones_*.\r\nresumen.json guarda todos los parámetros para repetir la ejecución.\r\n${resumen.creditos}\r\nHerramienta educativa: no es asesoría financiera.\r\n` });
  csv("calidad_datos.csv", res.calidad.tabla, ["ticker", "filas", "fechas_unicas", "duplicados", "primera", "ultima", "faltantes", "pct_faltantes", "no_positivos", "minimo", "maximo"]);
  csv("sectores.csv", res.sectores, ["ticker", "sector", "sector_yahoo", "sector_horizon", "sector_usuario", "fuente", "correccion_manual", "consulta"]);
  csv("parametros_gbm.csv", res.param.map((x) => ({ ...x, S0_sin_ajustar: f4(x.S0_sin_ajustar) })), ["ticker", "sector", "S0_sin_ajustar", "dividendos_12m", "q", "q_origen", "sigma", "mu_total", "a", "n_retornos"]);
  csv("var_es.csv", Object.entries(res.varTabla).map(([k, v]) => ({ cartera: v.nombre, VaR_hist: v.hist.VaR, ES_hist: v.hist.ES, peor_hist: v.hist.peor, VaR_normal: v.normal.VaR, ES_normal: v.normal.ES, VaR_MC: v.mc.VaR, ES_MC: v.mc.ES, peor_MC: v.mc.peor, bloques: v.hist.bloques, bloques_sin_solape: v.hist.bloquesSinSolape, VaR_hist_sin_solape: v.hist.VaRSinSolape })), ["cartera", "VaR_hist", "ES_hist", "peor_hist", "VaR_normal", "ES_normal", "VaR_MC", "ES_MC", "peor_MC", "bloques", "bloques_sin_solape", "VaR_hist_sin_solape"]);
  csv("estres.csv", res.estres.map((e) => ({ cartera: e.cartera, escenario: e.escenario, perdida_USD: e.perdida })), ["cartera", "escenario", "perdida_USD"]);
  csv("excepciones_VaR.csv", [{ cartera: res.backtestVaR.cartera, dias_evaluados: res.backtestVaR.n, excepciones: res.backtestVaR.x, esperadas: res.backtestVaR.esperadas, LR_Kupiec: res.backtestVaR.LR, p_valor: res.backtestVaR.pValor, alpha: res.backtestVaR.alpha, ventana: res.backtestVaR.ventana }], ["cartera", "dias_evaluados", "excepciones", "esperadas", "LR_Kupiec", "p_valor", "alpha", "ventana"]);
  csv("asignacion.csv", res.asignacion.pesos, ["ticker", "sector", "iguales", "inverso", "minvar", "minvar_sin_limite_sectorial"]);
  csv("asignacion_por_sector.csv", res.asignacion.porSector, ["sector", "iguales", "inverso", "minvar", "sin_limite", "limite"]);
  csv("montos.csv", res.asignacion.montos, ["ticker", "sector", "peso", "monto_ideal", "S0_sin_ajustar", "cantidad", "monto", "peso_nuevo"]);
  csv("presupuesto_de_riesgo.csv", res.asignacion.presupuesto.montosTabla, ["ticker", "sector", "peso", "monto"]);
  csv("estrategias.csv", res.estrategias.map((e) => ({ estrategia: e.nombre, patrimonio_final: e.W.at(-1), retorno: e.retorno, volatilidad_anual: e.vol, sharpe: e.sharpe, drawdown_max: e.maxDD, costos_USD: e.costo, rotacion: e.rotacion, rebalanceos: e.rebalanceos, efectivo_final: e.efectivoFinal })), ["estrategia", "patrimonio_final", "retorno", "volatilidad_anual", "sharpe", "drawdown_max", "costos_USD", "rotacion", "rebalanceos", "efectivo_final"]);
  csv("curvas_patrimonio.csv", res.estrategias[0].W.map((_, k) => ({ fecha: new Date(res.estrategias[0].dias[k] * 86400000).toISOString().slice(0, 10), ...Object.fromEntries(res.estrategias.map((e) => [e.nombre, e.W[k]])) })), ["fecha", ...res.estrategias.map((e) => e.nombre)]);
  for (const [H, r] of Object.entries(res.rolling)) csv(`rolling_H${H}.csv`, r.filas.map(({ serie, ...x }) => x), ["ticker", "m", "RMSE", "RMSE_ingenuo", "razon", "MAPE", "MAPE_ingenuo"]);
  csv("gbm_chequeo.csv", res.gbm, ["ticker", "S0", "a", "sigma", "T_años", "media_simulada", "S0_e_aT", "ee", "z", "todos_positivos", "media_ok"]);
  csv("control_CRR.csv", [{ N500: res.controlCRR.N500, valor_esperado_BS: res.controlCRR.BS, put_europea: res.controlCRR.put_europea, put_americana: res.controlCRR.put_americana }], ["N500", "valor_esperado_BS", "put_europea", "put_americana"]);
  if (res.opciones) csv("opciones_candidatos.csv", res.opciones.candidatos.map((c) => ({ ...c, elegido: res.opciones.candidatos.indexOf(c) === res.opciones.elegido })), ["plazo", "vencimiento", "dias_calendario", "beta", "cuantil_GBM", "strike", "contrato", "bid", "ask", "medio", "spread_rel", "volumen", "interes_abierto", "vol_implicita", "P_ejercicio", "P_beneficio", "E_ganancia", "V_CRR_sigma_hist", "V_CRR_vol_impl", "elegido"]);
  return out;
}
