# Capa de datos del gráfico de precio (rangos 1D…Todo, OHLCV, horario extendido). Se ejecuta una sola vez.
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.chdir(ROOT)
p = "js/data.js"
s = open(p, encoding="utf-8").read()
assert "export async function getChart" not in s

add = r'''
// ---------- gráfico de precio (estilo Yahoo Finance): rangos, OHLCV y horario extendido ----------
export const CHART_RANGES = {
  "1D": { range: "1d", interval: "1m", intraday: true, label: "1 día" },
  "5D": { range: "5d", interval: "5m", intraday: true, label: "5 días" },
  "1M": { range: "1mo", interval: "30m", intraday: true, label: "1 mes" },
  "6M": { range: "6mo", interval: "1d", label: "6 meses" },
  "YTD": { range: "ytd", interval: "1d", label: "en el año" },
  "1Y": { range: "1y", interval: "1d", label: "1 año" },
  "5Y": { range: "5y", interval: "1wk", label: "5 años" },
  "Todo": { range: "max", interval: "1mo", label: "todo" },
};
const chartCache = new Map();

function parseFull(json) {
  const res = json?.chart?.result?.[0];
  if (!res || !res.timestamp) return null;
  const q = res.indicators?.quote?.[0] || {};
  const t = [], o = [], h = [], l = [], c = [], v = [];
  for (let k = 0; k < res.timestamp.length; k++) {
    const cl = q.close?.[k];
    if (cl == null || !isFinite(cl)) continue;
    t.push(res.timestamp[k]); c.push(cl);
    o.push(q.open?.[k] ?? cl); h.push(q.high?.[k] ?? cl); l.push(q.low?.[k] ?? cl); v.push(q.volume?.[k] ?? 0);
  }
  return t.length >= 2 ? { t, o, h, l, c, v, hasOhlc: true, meta: res.meta || {} } : null;
}

// Devuelve { t,o,h,l,c,v, hasOhlc, meta, source, interval, fetchedAt }. Sin conexión solo hay rangos diarios (datos guardados).
export async function getChart(sym, key, { prepost = true, force = false } = {}) {
  const r = CHART_RANGES[key];
  if (!r) throw new Error("Rango desconocido");
  const ck = `${sym}|${key}|${r.intraday && prepost}`;
  const hit = chartCache.get(ck);
  const ttl = r.intraday ? 20e3 : 5 * 60e3;
  if (!force && hit && Date.now() - hit.fetchedAt < ttl) return hit;
  if (liveAllowed() && !CFG.FORCE_SNAPSHOT) {
    for (const b of liveBases()) {
      try {
        const url = `${b}/chart/${encodeURIComponent(sym)}?range=${r.range}&interval=${r.interval}${r.intraday && prepost ? "&includePrePost=true" : ""}`;
        const d = parseFull(await fetchJSON(url, 12000));
        if (d) { liveWorked(); const out = { ...d, source: "live", interval: r.interval, fetchedAt: Date.now() }; chartCache.set(ck, out); return out; }
      } catch (e) { /* siguiente */ }
    }
    liveFailed();
  }
  if (r.intraday) { const e = new Error("El gráfico del día necesita conexión con Yahoo Finance."); e.code = "offline"; throw e; }
  const snap = await loadSnapshot();
  const s = snapToSeries(snap, sym);
  if (!s) throw new Error(`No se pudieron obtener datos de ${sym}.`);
  let from = 0;
  const n = s.c.length;
  if (key === "6M") from = Math.max(0, n - 126);
  else if (key === "1Y") from = Math.max(0, n - 252);
  else if (key === "YTD") { const y = new Date(s.t[n - 1] * 1000).getUTCFullYear(); from = Math.max(0, s.t.findIndex((x) => new Date(x * 1000).getUTCFullYear() === y) - 1); }
  const t = s.t.slice(from), c = s.c.slice(from);
  const out = { t, o: c, h: c, l: c, c, v: c.map(() => 0), hasOhlc: false, meta: { currency: s.cur, chartPreviousClose: c[0], regularMarketPrice: c[c.length - 1], regularMarketTime: t[t.length - 1] }, source: "snapshot", interval: "1d", fetchedAt: Date.now(), limited: key === "5Y" || key === "Todo" };
  chartCache.set(ck, out);
  return out;
}
'''
s = s.rstrip() + "\n" + add
open(p, "w", encoding="utf-8").write(s)
print("data.js ok")
