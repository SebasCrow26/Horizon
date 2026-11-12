// Pruebas de los modelos: (1) recuperación de parámetros con datos sintéticos, (2) datos reales guardados.
// Uso: node tests/models.test.mjs
import { readFileSync } from "node:fs";
import { rng, randn, poissonSample, std, mean } from "../js/util.js";
import { fitMerton } from "../js/models/merton.js";
import { fitVasicek } from "../js/models/vasicek.js";
import { analyzeMeanReversion } from "../js/models/meanreversion.js";
import { analyzeAll } from "../js/models/ensemble.js";
import { setSnapshot, snapToSeries, regionOf } from "../js/data.js";

const fmt = (x, d = 3) => (x == null || !isFinite(x) ? "NA" : x.toFixed(d));
let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "OK " : "FALLA"}  ${name} ${extra}`); if (!ok) failures++; };

// ---------- 1) Merton sintético ----------
{
  const r = rng(1), n = 1500, sig = 0.010, lam = 0.02, muJ = -0.03, del = 0.03, m = 0.0004;
  const x = [];
  for (let i = 0; i < n; i++) {
    let v = m + sig * randn(r);
    const N = poissonSample(r, lam);
    for (let j = 0; j < N; j++) v += muJ + del * randn(r);
    x.push(v);
  }
  const f = fitMerton(x);
  console.log(`Merton sintético: sigma=${fmt(f.sigma, 4)} (real ${sig}) lam=${fmt(f.lam, 4)} (real ${lam}) muJ=${fmt(f.muJ, 4)} (real ${muJ}) delta=${fmt(f.delta, 4)} (real ${del}) LR=${fmt(f.LR, 1)}`);
  check("Merton detecta saltos", f.jumpsSignificant);
  check("Merton: sigma cercana", Math.abs(f.sigma - sig) < 0.003);
  check("Merton: lambda del orden correcto", f.lam > 0.005 && f.lam < 0.06);
  check("Merton: salto medio negativo", f.muJ < 0);
}

// ---------- 2) Vasicek sintético ----------
{
  const r = rng(2), a = 0.8, b = 0.04, s = 0.012, dt = 1 / 252, n = 3000;
  let x = 0.02; const xs = [x];
  for (let i = 0; i < n; i++) {
    const sd = Math.sqrt((s * s * (1 - Math.exp(-2 * a * dt))) / (2 * a));
    x = b + (x - b) * Math.exp(-a * dt) + sd * randn(r);
    xs.push(x);
  }
  const f = fitVasicek(xs);
  console.log(`Vasicek sintético: a=${fmt(f.a)} (real ${a}) b=${fmt(f.b, 4)} (real ${b}) sigma=${fmt(f.sigma, 4)} (real ${s}) tDF=${fmt(f.tDF, 2)}`);
  check("Vasicek: b cercano", Math.abs(f.b - b) < 0.01);
  check("Vasicek: sigma cercana", Math.abs(f.sigma - s) / s < 0.15);
  check("Vasicek: a positivo y del orden correcto", f.a > 0.2 && f.a < 3);
}

// ---------- 3) Reversión sintética ----------
{
  const r = rng(3), n = 750, phi = 0.97;
  let u = 0; const p = [];
  for (let i = 0; i < n; i++) { u = phi * u + 0.012 * randn(r); p.push(100 * Math.exp(0.0003 * i + u)); }
  const m = analyzeMeanReversion(p);
  console.log(`Reversión sintética: phi=${fmt(m.phi)} (real ${phi}) vida media=${fmt(m.halfLife, 1)} (real ${fmt(Math.LN2 / -Math.log(phi), 1)}) tDF=${fmt(m.tDF, 2)}`);
  check("Reversión: phi cercano", Math.abs(m.phi - phi) < 0.04);
}

// ---------- 4) Datos reales guardados ----------
const snap = JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url)));
setSnapshot(snap);
const rates = {};
for (const [k, s] of Object.entries({ irx: "^IRX", fvx: "^FVX", tnx: "^TNX", tyx: "^TYX" })) rates[k] = snapToSeries(snap, s);
const universeOf = (sym) => (snap.universes[regionOf(sym)] || []).filter((s) => s !== sym).map((s) => snapToSeries(snap, s));

const tickers = process.argv.slice(2).length ? process.argv.slice(2) : ["AAPL", "NVDA", "MSFT", "TSLA", "ECOPETROL.CL", "ISA.CL", "7203.T", "ASML.AS", "PETR4.SA", "BTC-USD", "GLD", "TLT", "MELI", "EC", "SAN.MC", "RELIANCE.NS"];
console.log("\nSímbolo        Precio   Veredicto               Score  P(sube) ES5%   Mert  Reve  Opc   Vasi  Manada | Compra≤  Piso   Objetivo");
const t0 = Date.now();
const dist = {};
for (const sym of tickers) {
  const series = snapToSeries(snap, sym);
  if (!series) { console.log(sym.padEnd(14), "sin datos"); continue; }
  try {
    const a = analyzeAll({ series, rates, universe: universeOf(sym), region: regionOf(sym) });
    const sg = (k) => fmt(a.models[k].signal, 2).padStart(5);
    dist[a.verdict.label] = (dist[a.verdict.label] || 0) + 1;
    console.log(`${sym.padEnd(14)} ${fmt(a.S0, 2).padStart(8)}  ${a.verdict.label.padEnd(22)} ${fmt(a.score, 2).padStart(5)}  ${fmt(a.probUp * 100, 0).padStart(5)}  ${fmt(a.models.merton.es5 * 100, 0).padStart(5)}  ${sg("merton")} ${sg("meanrev")} ${sg("realoptions")} ${sg("vasicek")} ${sg("herding")}  | ${fmt(a.priceBuy, 2).padStart(8)} ${fmt(a.stop, 2).padStart(7)} ${fmt(a.target, 2).padStart(8)}`);
    for (const k of Object.keys(a.models)) {
      const m = a.models[k];
      if (m.available !== false && (!isFinite(m.signal) || !isFinite(m.confidence))) { console.log("   NaN en", k); failures++; }
    }
  } catch (e) { console.log(sym.padEnd(14), "ERROR:", e.message); failures++; }
}
console.log(`\nTiempo: ${Date.now() - t0} ms para ${tickers.length} acciones. Distribución de veredictos:`, dist);
console.log(failures ? `\n${failures} FALLAS` : "\nTodo en orden");
process.exit(failures ? 1 : 0);
