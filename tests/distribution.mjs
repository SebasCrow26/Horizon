import { readFileSync } from "node:fs";
import { setSnapshot, snapToSeries, regionOf } from "../js/data.js";
import { analyzeAll } from "../js/models/ensemble.js";
const snap = JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url)));
setSnapshot(snap);
const rates = {}; for (const [k, s] of Object.entries({ irx: "^IRX", fvx: "^FVX", tnx: "^TNX", tyx: "^TYX" })) rates[k] = snapToSeries(snap, s);
const rows = [];
for (const sym of Object.keys(snap.series)) {
  if (sym.startsWith("^")) continue;
  const series = snapToSeries(snap, sym);
  const uni = (snap.universes[regionOf(sym)] || []).filter((x) => x !== sym).map((x) => snapToSeries(snap, x));
  try { const a = analyzeAll({ series, rates, universe: uni, region: regionOf(sym) }); rows.push({ sym, S: a.score, v: a.verdict.label, up: a.probUp, buyGap: a.priceBuy / a.S0, m: a.models.merton.signal, r: a.models.meanrev.signal, o: a.models.realoptions.signal, va: a.models.vasicek.signal, h: a.models.herding.signal }); } catch (e) { console.log(sym, "error", e.message); }
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; };
const S = rows.map((r) => r.S);
console.log("n =", rows.length, "| score p5/p25/p50/p75/p95:", [0.05, 0.25, 0.5, 0.75, 0.95].map((p) => q(S, p).toFixed(2)).join(" / "));
const dist = {}; rows.forEach((r) => (dist[r.v] = (dist[r.v] || 0) + 1)); console.log(dist);
for (const k of ["m", "r", "o", "va", "h"]) console.log("señal", k.padEnd(2), "p5/p50/p95:", [0.05, 0.5, 0.95].map((p) => q(rows.map((r) => r[k]), p).toFixed(2)).join(" / "));
console.log("Compra≤ / precio: p5/p50/p95:", [0.05, 0.5, 0.95].map((p) => q(rows.map((r) => r.buyGap), p).toFixed(2)).join(" / "));
console.log("P(sube) p5/p50/p95:", [0.05, 0.5, 0.95].map((p) => q(rows.map((r) => r.up), p).toFixed(2)).join(" / "));
const top = [...rows].sort((a, b) => b.S - a.S);
console.log("Top 5:", top.slice(0, 5).map((r) => `${r.sym} ${r.S.toFixed(2)}`).join(", "));
console.log("Bottom 5:", top.slice(-5).map((r) => `${r.sym} ${r.S.toFixed(2)}`).join(", "));
