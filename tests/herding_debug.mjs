import { readFileSync } from "node:fs";
import { buildCrossSection, analyzeHerding } from "../js/models/herding.js";
import { snapToSeries } from "../js/data.js";
const snap = JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url)));
for (const [reg, list] of Object.entries(snap.universes)) {
  const ser = list.map((s) => snapToSeries(snap, s));
  const cs = buildCrossSection(ser);
  const a = analyzeHerding(ser, null, { region: reg });
  const f = (x) => (x == null ? "NA" : x.toFixed(3));
  console.log(reg.padEnd(7), "acciones", ser.length, "días", cs.length, "| completo g2=", f(a.full?.g2), "t=", f(a.full?.t2), "| reciente g2=", f(a.recent?.g2), "t=", f(a.recent?.t2), "herding:", a.recent?.herding, "| mercado 20d:", f(a.mkt20), "| fin:", new Date(a.asOf * 1000).toISOString().slice(0, 10));
}
