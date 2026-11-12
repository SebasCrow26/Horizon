// Calcula el veredicto de los 5 modelos para todos los activos guardados y lo deja en data/ideas.json
// (alimenta la pantalla "Descubrir"). Uso: node tools/build_ideas.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { setSnapshot, snapToSeries, regionOf } from "../js/data.js";
import { analyzeAll } from "../js/models/ensemble.js";

const snap = JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url)));
setSnapshot(snap);
const rates = {};
for (const [k, s] of Object.entries({ irx: "^IRX", fvx: "^FVX", tnx: "^TNX", tyx: "^TYX" })) rates[k] = snapToSeries(snap, s);

const items = [];
for (const sym of Object.keys(snap.series)) {
  if (sym.startsWith("^")) continue; // los índices no se compran
  const series = snapToSeries(snap, sym);
  const region = regionOf(sym);
  const universe = (snap.universes[region] || []).filter((x) => x !== sym).map((x) => snapToSeries(snap, x));
  try {
    const a = analyzeAll({ series, rates, universe, region, horizonDays: 63 });
    items.push({
      sym, name: series.name, cur: series.cur, region, price: a.S0, key: a.verdict.key, label: a.verdict.label, tone: a.verdict.tone,
      score: +a.score.toFixed(3), probUp: +a.probUp.toFixed(3), upside: +a.upside.toFixed(3), downside: +a.downside.toFixed(3),
      risk: a.riskLevel, agreement: +a.agreement.toFixed(2), lo: a.range.lo, hi: a.range.hi,
    });
  } catch (e) { console.warn("sin análisis:", sym, e.message); }
}
items.sort((x, y) => y.score - x.score);
writeFileSync(new URL("../data/ideas.json", import.meta.url), JSON.stringify({ generated: snap.generated, horizonDays: 63, items }));
const dist = {};
items.forEach((i) => (dist[i.label] = (dist[i.label] || 0) + 1));
console.log(`ideas.json: ${items.length} activos · datos al ${snap.generated}`);
console.log(dist);
console.log("Top 5:", items.slice(0, 5).map((i) => `${i.sym} ${i.score}`).join(", "));
