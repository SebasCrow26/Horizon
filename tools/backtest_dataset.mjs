// Backtest walk-forward, paso 1: reconstruye lo que Horizon habría dicho en el pasado.
// Para cada activo y cada ~mes (21 sesiones) de los últimos 10 años:
//   • corta TODOS los datos (activo, canasta regional y tasas) en esa fecha → nada del futuro
//   • usa una ventana de 3 años, igual que la app
//   • corre los 5 modelos + señales de mercado y guarda variables y veredicto
//   • mide qué pasó después: rendimiento a 21/63/126 sesiones, mínimo y máximo del camino, mercado
// Resultado: data/backtest_rows.csv (lo lee tools/train_model.py). No se sube a Netlify.
// Uso: node tools/backtest_dataset.mjs [hilos]
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";

const HORIZONS = [21, 63, 126];
const STEP = 21;
const WINDOW_DAYS = 3 * 365; // ventana de calendario (como range=3y en la app)

if (isMainThread) {
  const hist = JSON.parse(readFileSync(new URL("../data/history.json", import.meta.url)));
  const syms = Object.keys(hist.series).filter((s) => !s.startsWith("^") && !/=X$/.test(s));
  const nThreads = Math.max(1, Math.min(+process.argv[2] || cpus().length - 1, 10));
  const chunks = Array.from({ length: nThreads }, (_, i) => syms.filter((_, j) => j % nThreads === i));
  const t0 = Date.now();
  let header = null, rows = [], done = 0;
  await Promise.all(chunks.map((chunk) => new Promise((res, rej) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { chunk } });
    w.on("message", (m) => {
      if (m.rows) { header ||= m.header; rows.push(...m.rows); done++; if (done % 10 === 0) console.log(`${done}/${syms.length} activos · ${rows.length} filas · ${Math.round((Date.now() - t0) / 1000)} s`); }
    });
    w.on("error", rej); w.on("exit", res);
  })));
  writeFileSync(new URL("../data/backtest_rows.csv", import.meta.url), [header.join(","), ...rows.map((r) => r.join(","))].join("\n"));
  console.log(`Listo: ${rows.length} observaciones de ${syms.length} activos en ${Math.round((Date.now() - t0) / 1000)} s → data/backtest_rows.csv`);
} else {
  const { snapToSeries, regionOf } = await import("../js/data.js");
  const { analyzeAll } = await import("../js/models/ensemble.js");
  const { FEATURES } = await import("../js/models/factors.js");
  const hist = JSON.parse(readFileSync(new URL("../data/history.json", import.meta.url)));
  const full = (s) => snapToSeries(hist, s);
  const rateSyms = { irx: "^IRX", fvx: "^FVX", tnx: "^TNX", tyx: "^TYX" };
  const ratesFull = Object.fromEntries(Object.entries(rateSyms).map(([k, s]) => [k, full(s)]).filter(([, v]) => v));
  // corta una serie a (fecha − ventana, fecha]
  const cut = (s, tEnd, win = WINDOW_DAYS) => {
    if (!s) return null;
    const tStart = tEnd - win * 86400;
    let a = 0, b = s.t.length;
    while (a < b && s.t[a] <= tStart) a++;
    while (b > a && s.t[b - 1] > tEnd) b--;
    return { ...s, t: s.t.slice(a, b), c: s.c.slice(a, b) };
  };
  const header = ["sym", "region", "day", "price", ...FEATURES, "score", "verdict", "score5", "verdict5", "pMom", "pRel", "probUp", "risk", "upside", "downside", "lo", "hi", "priceBuy",
    ...HORIZONS.flatMap((h) => [`fwd${h}`, `min${h}`, `max${h}`, `mkt${h}`])];
  // índice regional equiponderado (para comparar contra "el mercado")
  const mktCache = {};
  const regionalMarket = (region) => {
    if (mktCache[region]) return mktCache[region];
    const uni = (hist.universes[region] || []).map(full).filter(Boolean);
    const maps = uni.map((s) => new Map(s.t.map((t, i) => [Math.floor(t / 86400), s.c[i]])));
    const days = [...new Set(uni.flatMap((s) => s.t.map((t) => Math.floor(t / 86400))))].sort((a, b) => a - b);
    const lv = new Map(); let acc = 0, prev = null;
    for (const d of days) {
      if (prev != null) { const r = []; for (const m of maps) { const a = m.get(prev), b = m.get(d); if (a && b) r.push(Math.log(b / a)); } if (r.length >= 3) acc += r.reduce((x, y) => x + y, 0) / r.length; }
      lv.set(d, acc); prev = d;
    }
    return (mktCache[region] = { days, lv });
  };
  const mktAt = (M, day) => { let lo = 0, hi = M.days.length - 1; if (day < M.days[0]) return null; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (M.days[mid] <= day) lo = mid; else hi = mid - 1; } return M.lv.get(M.days[lo]); };

  for (const sym of workerData.chunk) {
    const S = full(sym), region = regionOf(sym), M = regionalMarket(region);
    const uniFull = (hist.universes[region] || []).filter((x) => x !== sym).map(full).filter(Boolean);
    const rows = [];
    const firstT = S.t[0] + WINDOW_DAYS * 86400 * 0.97;
    const i0 = S.t.findIndex((t) => t >= firstT);
    if (i0 < 0) { parentPort.postMessage({ header, rows }); continue; }
    // fechas de evaluación: cada STEP sesiones desde la primera con 3 años de historia
    for (let i = i0; i + Math.min(...HORIZONS) < S.t.length; i += STEP) {
      const tEnd = S.t[i];
      const series = cut(S, tEnd);
      if (series.c.length < 250) continue;
      const rates = Object.fromEntries(Object.entries(ratesFull).map(([k, v]) => [k, cut(v, tEnd)]));
      const universe = uniFull.map((u) => cut(u, tEnd)).filter((u) => u.c.length > 120);
      let a;
      try { a = analyzeAll({ series, rates, universe, region, horizonDays: 63 }); } catch (e) { continue; }
      if (!a.features) continue;
      const p0 = S.c[i], day = Math.floor(tEnd / 86400), m0 = mktAt(M, day);
      const fw = HORIZONS.flatMap((h) => {
        if (i + h >= S.t.length) return ["", "", "", ""];
        const path = S.c.slice(i + 1, i + h + 1);
        const m1 = mktAt(M, Math.floor(S.t[i + h] / 86400));
        return [Math.log(S.c[i + h] / p0), Math.log(Math.min(...path) / p0), Math.log(Math.max(...path) / p0), m0 != null && m1 != null ? m1 - m0 : ""].map((x) => (x === "" ? "" : +x.toFixed(5)));
      });
      rows.push([sym, region, day, +p0.toFixed(4), ...a.features.map((x) => +x.toFixed(5)), +a.score.toFixed(4), a.verdict.key, +a.score5.toFixed(4), a.verdict5.key, +(a.trend.pMom ?? 0.5).toFixed(3), +(a.trend.pRel ?? 0.5).toFixed(3), +a.probUp.toFixed(4), a.riskLevel,
        +a.upside.toFixed(4), +a.downside.toFixed(4), +(a.range.lo / p0).toFixed(4), +(a.range.hi / p0).toFixed(4), +(a.priceBuy / p0).toFixed(4), ...fw]);
    }
    parentPort.postMessage({ header, rows });
  }
}
