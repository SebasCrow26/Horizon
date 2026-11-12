// Descarga datos reales de Yahoo Finance y los guarda en data/snapshot.json
// (sirve como respaldo si el proxy en vivo falla el día de la presentación).
// Uso:  node tools/build_snapshot.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Universos para medir "comportamiento en manada" por región + tasas + acciones populares
export const UNIVERSES = {
  US: ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "JPM", "V", "JNJ", "WMT", "XOM", "PG", "UNH", "HD", "KO", "PEP", "BAC", "DIS", "NFLX", "CSCO", "ORCL", "MA", "CVX", "MRK"],
  CO: ["ECOPETROL.CL", "PFBCOLOM.CL", "ISA.CL", "GEB.CL", "NUTRESA.CL", "CEMARGOS.CL", "GRUPOSURA.CL", "BVC.CL", "CELSIA.CL", "PFAVAL.CL", "MINEROS.CL", "PFGRUPSURA.CL"],
  EU: ["ASML.AS", "SAP.DE", "SIE.DE", "MC.PA", "OR.PA", "TTE.PA", "SAN.MC", "ITX.MC", "NESN.SW", "NOVN.SW", "ROG.SW", "SHEL.L", "AZN.L", "HSBA.L", "ULVR.L", "BP.L", "ALV.DE", "AIR.PA"],
  ASIA: ["7203.T", "6758.T", "9984.T", "0700.HK", "9988.HK", "005930.KS", "000660.KS", "RELIANCE.NS", "TCS.NS", "INFY.NS", "HDFCBANK.NS", "BHP.AX", "CBA.AX", "1299.HK", "0005.HK"],
  LATAM: ["PETR4.SA", "VALE3.SA", "ITUB4.SA", "BBDC4.SA", "ABEV3.SA", "WEGE3.SA", "AMXB.MX", "WALMEX.MX", "GFNORTEO.MX", "FEMSAUBD.MX", "CEMEXCPO.MX", "BIMBOA.MX", "FALABELLA.SN", "SQM-B.SN"],
  CRYPTO: ["BTC-USD", "ETH-USD", "BNB-USD", "SOL-USD", "XRP-USD", "ADA-USD", "DOGE-USD", "AVAX-USD", "LINK-USD", "LTC-USD"]
};
const RATES = ["^IRX", "^FVX", "^TNX", "^TYX"];
const INDEXES = ["^GSPC", "^IXIC", "^FTSE", "^N225", "^BVSP", "^HSI", "^MXX"];
const EXTRA = ["EC", "CIB", "MELI", "TSM", "BRK-B", "SPY", "QQQ", "GLD", "TLT", "EEM"];

const all = new Set([...RATES, ...INDEXES, ...EXTRA, ...Object.values(UNIVERSES).flat()]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(sym, tries = 4) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=3y&interval=1d`;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) return null;
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      if (!res) return null;
      const ts = res.timestamp || [];
      const q = res.indicators?.quote?.[0]?.close || [];
      const adj = res.indicators?.adjclose?.[0]?.adjclose || null;
      const t = [], c = [];
      for (let k = 0; k < ts.length; k++) {
        const v = adj ? adj[k] : q[k];
        if (v == null || !isFinite(v) || v <= 0) continue;
        t.push(Math.floor(ts[k] / 86400));
        c.push(Math.round(v * 10000) / 10000);
      }
      if (t.length < 120) return null;
      const m = res.meta || {};
      return { n: m.longName || m.shortName || sym, cur: m.currency || "", ex: m.fullExchangeName || m.exchangeName || "", t, c };
    } catch (e) { await sleep(800); }
  }
  return null;
}

const syms = [...all];
const series = {};
let done = 0;
const queue = syms.slice();
async function worker() {
  while (queue.length) {
    const s = queue.shift();
    const d = await get(s);
    if (d) series[s] = d;
    done++;
    if (done % 15 === 0) console.log(`${done}/${syms.length}`);
    await sleep(120);
  }
}
await Promise.all(Array.from({ length: 5 }, worker));

const missing = syms.filter((s) => !series[s]);
const universes = {};
for (const [k, v] of Object.entries(UNIVERSES)) universes[k] = v.filter((s) => series[s]);

// Protección para la actualización automática: si Yahoo respondió mal (muchas series faltantes),
// no se reemplazan los datos buenos que ya existen.
if (Object.keys(series).length < syms.length * 0.9) {
  console.error(`Solo llegaron ${Object.keys(series).length} de ${syms.length} series: se conservan los datos anteriores.`);
  process.exit(1);
}
const out = { generated: new Date().toISOString(), universes, rates: RATES, series };
mkdirSync(join(root, "data"), { recursive: true });
writeFileSync(join(root, "data", "snapshot.json"), JSON.stringify(out));
const kb = Math.round(JSON.stringify(out).length / 1024);
console.log(`Listo: ${Object.keys(series).length} series, ${kb} KB. Sin datos: ${missing.join(", ") || "ninguno"}`);
for (const [k, v] of Object.entries(universes)) console.log(`  universo ${k}: ${v.length} acciones`);
