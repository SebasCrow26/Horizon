// Datos del Taller de riesgo: carga (Yahoo, datos guardados o CSV con procedencia), calidad de datos, ventanas 504/252,
// sectores corregibles y exportación de resultados (ZIP con CSV y resumen de parámetros y semilla).
// Créditos: el diseño (sesiones comunes con reporte de descartes, procedencia del CSV, sectores corregibles, exportación)
// parte del Taller de valoración y riesgo de Felipe Pulido; este código es una implementación propia.
import { dayKey } from "./util.js";
import { getDailyFull, loadSnapshot, snapToSeries, loadSectorMap, getYahooSector } from "./data.js";

const SECTOR_NULO = "Sin clasificar";
const isoDia = (day) => new Date(day * 86400000).toISOString().slice(0, 10);

// ---------- CSV ----------
function parseFecha(txt) {
  const s = String(txt).trim().replace(/^"|"$/g, "");
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/); // dd/mm/aaaa (formato en español)
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]) / 86400000;
  return NaN;
}
// Primera columna = fecha; las demás, un ticker cada una. Acepta coma o punto y coma (con decimales con coma).
export function parseCSV(text, etiqueta = "CSV") {
  const lineas = String(text).replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lineas.length < 3) throw new Error(`${etiqueta}: el archivo necesita una fila de encabezado y al menos dos filas de datos.`);
  const delim = (lineas[0].match(/;/g) || []).length > (lineas[0].match(/,/g) || []).length ? ";" : ",";
  const cortar = (l) => l.split(delim).map((x) => x.trim().replace(/^"|"$/g, ""));
  const enc = cortar(lineas[0]);
  if (enc.length < 2) throw new Error(`${etiqueta}: se esperan al menos dos columnas (fecha y un ticker).`);
  const tickers = enc.slice(1).map((x) => x.toUpperCase());
  if (new Set(tickers).size !== tickers.length) throw new Error(`${etiqueta}: hay tickers repetidos en el encabezado.`);
  const series = Object.fromEntries(tickers.map((t) => [t, { t: [], c: [] }]));
  let malas = 0;
  for (const l of lineas.slice(1)) {
    const c = cortar(l), day = parseFecha(c[0]);
    if (!Number.isFinite(day)) { malas++; continue; }
    tickers.forEach((t, i) => {
      const v = parseFloat(String(c[i + 1] ?? "").replace(delim === ";" ? "," : "", delim === ";" ? "." : ""));
      if (Number.isFinite(v)) { series[t].t.push(day * 86400); series[t].c.push(v); }
    });
  }
  if (malas > lineas.length / 2) throw new Error(`${etiqueta}: no se pudieron leer las fechas (usa aaaa-mm-dd o dd/mm/aaaa).`);
  return { tickers, series };
}

// ---------- calidad: duplicados, sesiones comunes y descartes ----------
export function dedupe(t, vals) {
  const m = new Map();
  let dup = 0;
  for (let i = 0; i < t.length; i++) { const k = dayKey(t[i]); if (m.has(k)) dup++; m.set(k, vals[i]); } // la última fila del día manda
  const dias = [...m.keys()].sort((a, b) => a - b);
  return { dias, valores: dias.map((d) => m.get(d)), duplicados: dup };
}

// seriesList = [{ sym, t:[seg], adj:[precio ajustado] }]. Devuelve la tabla de calidad y las sesiones comunes (todas con precio > 0).
export function qualityReport(seriesList) {
  const porSerie = seriesList.map((s) => { const d = dedupe(s.t, s.adj); const nopos = d.valores.filter((v) => !(v > 0)).length; return { sym: s.sym, filas: s.t.length, ...d, nopos }; });
  const mapas = porSerie.map((s) => { const m = new Map(); s.dias.forEach((d, i) => { if (s.valores[i] > 0) m.set(d, s.valores[i]); }); return m; });
  const union = new Set(); porSerie.forEach((s) => s.dias.forEach((d) => union.add(d)));
  const comunes = [...union].filter((d) => mapas.every((m) => m.has(d))).sort((a, b) => a - b);
  const descartadas = [...union].filter((d) => !mapas.every((m) => m.has(d))).sort((a, b) => a - b);
  const tabla = porSerie.map((s, i) => {
    const vs = [...mapas[i].values()];
    return { ticker: s.sym, filas: s.filas, fechas_unicas: s.dias.length, duplicados: s.duplicados, primera: s.dias.length ? isoDia(s.dias[0]) : "—", ultima: s.dias.length ? isoDia(s.dias.at(-1)) : "—", faltantes: union.size - mapas[i].size, pct_faltantes: union.size ? (100 * (union.size - mapas[i].size)) / union.size : 0, no_positivos: s.nopos, minimo: vs.length ? Math.min(...vs) : NaN, maximo: vs.length ? Math.max(...vs) : NaN };
  });
  return {
    info: { filas_descargadas: porSerie.reduce((a, s) => a + s.filas, 0), duplicados: porSerie.reduce((a, s) => a + s.duplicados, 0), sesiones_comunes: comunes.length, sesiones_descartadas: descartadas.length, fechas_descartadas: descartadas.map(isoDia) },
    tabla, comunes,
  };
}

// ---------- partición entrenamiento / prueba ----------
// El taller pide los últimos 756 retornos: 504 de entrenamiento y 252 de prueba. Con menos datos se usa el MODO REDUCIDO:
// la prueba sigue siendo de 252 y se entrena con los que haya (mínimo 252), avisando de ello.
export function ventanas(nRetornos, { nTrain = 504, nTest = 252 } = {}) {
  if (nRetornos >= nTrain + nTest) return { nTrain, nTest, usados: nTrain + nTest, reducido: false, mensaje: "" };
  if (nRetornos >= 2 * nTest) { const tr = nRetornos - nTest; return { nTrain: tr, nTest, usados: nRetornos, reducido: true, mensaje: `Modo reducido: hay ${nRetornos} retornos comunes y el taller pide ${nTrain + nTest}. Se entrena con ${tr} (en vez de ${nTrain}) y se prueba con ${nTest}. Para la partición completa usen Yahoo Finance con 4 años o suban un CSV más largo.` }; }
  throw new Error(`Se necesitan al menos ${2 * nTest} retornos comunes (${nTest} de entrenamiento y ${nTest} de prueba) y hay ${nRetornos}. Amplíen el rango de fechas o usen otro conjunto de acciones.`);
}
export function fechasVentanas(dias, w) { // dias: números de día de los precios comunes (uno más que los retornos)
  const T = dias.length - 1, ini = T - w.usados; // retornos usados: ini .. T-1
  return { entrenamiento: [isoDia(dias[ini + 1]), isoDia(dias[ini + w.nTrain])], prueba: [isoDia(dias[ini + w.nTrain + 1]), isoDia(dias[T])] };
}

// ---------- sectores (corregibles) ----------
// sector final = el que escribe el usuario (si lo hay), si no el de Yahoo, si no el mapa de Horizon.
// Yahoo da los sectores en inglés: se traducen a las mismas etiquetas que usa el mapa de Horizon para poder compararlos
export const SECTOR_YAHOO_ES = { "Technology": "Tecnología", "Financial Services": "Financiero", "Healthcare": "Salud", "Energy": "Energía", "Consumer Defensive": "Consumo básico", "Consumer Cyclical": "Consumo discrecional", "Communication Services": "Comunicaciones", "Industrials": "Industriales", "Basic Materials": "Materiales", "Utilities": "Servicios públicos", "Real Estate": "Bienes raíces" };
export function tablaSectores(tickers, usuario = {}, yahoo = {}, mapa = {}, sello = "") {
  return tickers.map((t) => {
    const u = (usuario[t] || "").trim(), y = yahoo[t] ? SECTOR_YAHOO_ES[yahoo[t]] || yahoo[t] : null, h = mapa[t] || null, ref = y || h;
    const sector = u || y || h || SECTOR_NULO;
    return { ticker: t, sector, sector_yahoo: y || "—", sector_horizon: h || "—", sector_usuario: u || "—", fuente: u ? "Usuario" : y ? "Yahoo Finance" : h ? "Mapa de Horizon" : "Sin dato", correccion_manual: !!(u && ref && u.toLowerCase() !== ref.toLowerCase()), consulta: sello };
  });
}

// ---------- carga de precios ----------
// fuente: "yahoo" | "respaldo" | "csv". Devuelve series [{sym, name, cur, t, adj, close, divs, sinAjustar}] y los avisos.
export async function cargarPrecios({ tickers, fuente, years = 4, csvAjustado = null, csvSinAjustar = null, procedencia = "" }) {
  const avisos = [], series = [];
  if (fuente === "yahoo") {
    const errores = [];
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(4, tickers.length) }, async () => {
      while (i < tickers.length) {
        const sym = tickers[i++];
        try { const d = await getDailyFull(sym, { years }); series.push(d); if (d.sesionParcialExcluida) avisos.push(`${sym}: se excluyó la sesión en curso (venía incompleta).`); } catch (e) { errores.push(`${sym} (${e.message.replace(/^No se pudieron obtener datos de [^:]*:? ?/, "") || "sin datos"})`); }
      }
    }));
    if (errores.length) { const e = new Error("No se pudieron bajar: " + errores.join("; ") + ". Revisen los símbolos o la conexión."); e.code = errores.some((x) => /Sin conexión/.test(x)) ? "offline" : "datos"; throw e; }
    series.sort((a, b) => tickers.indexOf(a.sym) - tickers.indexOf(b.sym));
    return { series, avisos, meta: { fuente: "Yahoo Finance (gráfico diario, cierre sin ajustar y ajustado, dividendos)", consulta: new Date().toISOString(), years } };
  }
  if (fuente === "respaldo") {
    const snap = await loadSnapshot(), faltan = [];
    for (const sym of tickers) { const s = snapToSeries(snap, sym); if (!s) { faltan.push(sym); continue; } series.push({ sym, name: s.name, cur: s.cur, t: s.t, adj: s.c, close: s.c, divs: [], sinAjustar: true, source: "snapshot" }); }
    if (faltan.length) throw new Error("El respaldo guardado no tiene: " + faltan.join(", ") + ".");
    avisos.push("Datos guardados: solo traen el cierre AJUSTADO (3 años). S0 es el ajustado, q = 0 salvo que lo escriban a mano, y las cantidades enteras son aproximadas. Con Yahoo Finance se usa el cierre sin ajustar y los dividendos.");
    return { series, avisos, meta: { fuente: "Respaldo guardado (data/snapshot.json)", consulta: snap?.generated || "", years: 3 } };
  }
  if (fuente === "csv") {
    if (!csvAjustado) throw new Error("Suban el CSV de precios ajustados.");
    if (!String(procedencia).trim()) throw new Error("Escriban de dónde salió el CSV (el taller pide registrar la procedencia).");
    const aj = parseCSV(csvAjustado, "CSV de precios ajustados"), sin = csvSinAjustar ? parseCSV(csvSinAjustar, "CSV de cierres sin ajustar") : null;
    const faltan = tickers.filter((t) => !aj.series[t]);
    if (faltan.length) throw new Error("El CSV no tiene columnas para: " + faltan.join(", ") + ".");
    for (const sym of tickers) { const s = aj.series[sym], c = sin?.series[sym]; series.push({ sym, name: sym, cur: "", t: s.t, adj: s.c, close: c ? alinearCierre(s, c) : s.c, divs: [], sinAjustar: !c, source: "csv" }); }
    avisos.push("El CSV no trae dividendos: q = 0 salvo en las acciones donde lo escriban a mano.");
    if (!sin) avisos.push("No se subió el CSV de cierres sin ajustar: S0 es el último precio ajustado.");
    return { series, avisos, meta: { fuente: `CSV subido (${String(procedencia).trim()})`, consulta: new Date().toISOString(), years: null } };
  }
  throw new Error("Fuente de datos desconocida: " + fuente);
}
function alinearCierre(aj, sin) { // cierres sin ajustar en las mismas fechas que los ajustados (si falta uno, se usa el ajustado de ese día)
  const m = new Map(); sin.t.forEach((t, i) => m.set(dayKey(t), sin.c[i]));
  return aj.t.map((t, i) => m.get(dayKey(t)) ?? aj.c[i]);
}

// Sectores de Yahoo (si el Worker o el servidor local lo permiten) y mapa de Horizon
export async function sectoresReferencia(tickers) {
  const mapa = await loadSectorMap(), yahoo = {};
  await Promise.all(tickers.map(async (t) => { const r = await getYahooSector(t); if (r?.sector) yahoo[t] = r.sector; }));
  return { mapa, yahoo };
}

// ---------- exportación ----------
export function toCSV(filas, columnas) {
  const esc = (v) => { if (v == null || (typeof v === "number" && !Number.isFinite(v))) return ""; const s = typeof v === "number" ? String(v) : String(v); return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return "﻿" + [columnas.join(","), ...filas.map((f) => columnas.map((c) => esc(f[c])).join(","))].join("\r\n") + "\r\n";
}
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_T[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
// ZIP sin compresión (método "store"), nombres UTF-8. files = [{ name, data: string | Uint8Array }]
export function buildZip(files, fecha = new Date()) {
  const enc = new TextEncoder(), locales = [], central = [];
  const dosT = ((fecha.getHours() << 11) | (fecha.getMinutes() << 5) | (fecha.getSeconds() >> 1)) & 0xFFFF, dosD = (((Math.max(1980, fecha.getFullYear()) - 1980) << 9) | ((fecha.getMonth() + 1) << 5) | fecha.getDate()) & 0xFFFF;
  let offset = 0;
  for (const f of files) {
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data, name = enc.encode(f.name), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true); lh.setUint16(10, dosT, true); lh.setUint16(12, dosD, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    locales.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosT, true); ch.setUint16(14, dosD, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const csize = central.reduce((s, p) => s + p.length, 0), eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, files.length, true); eo.setUint16(10, files.length, true); eo.setUint32(12, csize, true); eo.setUint32(16, offset, true);
  const partes = [...locales, ...central, new Uint8Array(eo.buffer)], out = new Uint8Array(partes.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of partes) { out.set(p, o); o += p.length; }
  return out;
}
