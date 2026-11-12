// Descarga 10 años de precios diarios (cierre ajustado) de los mismos activos del snapshot y los guarda en
// data/history.json. Solo lo usa el backtest (tools/backtest.mjs); NO se sube a Netlify.
// Uso: node tools/build_history.mjs
import { readFileSync, writeFileSync } from "node:fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const snap = JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url)));
const syms = Object.keys(snap.series);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(sym, tries = 4) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=10y&interval=1d`;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) return null;
      const res = (await r.json())?.chart?.result?.[0];
      if (!res) return null;
      const ts = res.timestamp || [], q = res.indicators?.quote?.[0]?.close || [], adj = res.indicators?.adjclose?.[0]?.adjclose || null;
      const t = [], c = [];
      for (let k = 0; k < ts.length; k++) {
        const v = adj ? adj[k] : q[k];
        if (v == null || !isFinite(v) || v <= 0) continue;
        const d = Math.floor(ts[k] / 86400);
        if (t.length && d === t[t.length - 1]) { c[c.length - 1] = v; continue; }
        t.push(d); c.push(Math.round(v * 10000) / 10000);
      }
      if (t.length < 300) return null;
      const m = res.meta || {};
      return { n: m.longName || m.shortName || sym, cur: m.currency || "", ex: m.fullExchangeName || "", t, c };
    } catch (e) { await sleep(800); }
  }
  return null;
}

const series = {}, queue = syms.slice();
let done = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  while (queue.length) {
    const s = queue.shift();
    const d = await get(s);
    if (d) series[s] = d;
    if (++done % 20 === 0) console.log(`${done}/${syms.length}`);
    await sleep(120);
  }
}));
const out = { generated: new Date().toISOString(), universes: snap.universes, rates: snap.rates, series };
writeFileSync(new URL("../data/history.json", import.meta.url), JSON.stringify(out));
const lens = Object.values(series).map((s) => s.t.length).sort((a, b) => a - b);
console.log(`Listo: ${Object.keys(series).length}/${syms.length} series · días: mín ${lens[0]}, mediana ${lens[lens.length >> 1]}, máx ${lens[lens.length - 1]}`);
console.log("Sin datos:", syms.filter((s) => !series[s]).join(", ") || "ninguno");
