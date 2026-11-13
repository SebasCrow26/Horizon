// Prueba de integración del Taller: corre todo el flujo con datos completos (sintéticos) y con el respaldo real (modo reducido).
// Uso: node tests/taller-run.test.mjs   (antes: python -X utf8 -I tests/strategies_reference.py y tests/options_reference.py)
import { readFileSync } from "node:fs";
import { setSnapshot, setSectorMap } from "../js/data.js";
import { correrTaller, archivosResultados, TICKERS_DEFECTO, PARAMS_DEFECTO, semilla } from "../js/taller-run.js";
import { cargarPrecios, tablaSectores, buildZip } from "../js/taller-data.js";
import { riskTable, covMatrix } from "../js/risk.js";

const F = (n) => JSON.parse(readFileSync(new URL(n, import.meta.url)));
let ok = 0, fallos = 0;
const cond = (n, c) => { if (c) ok++; else { fallos++; console.log(`  ✗ ${n}`); } };
const casi = (n, a, b, tol) => cond(`${n}: ${a} vs ${b}`, Math.abs(a - b) <= tol);

// ---------- 1) datos completos: 8 acciones sintéticas, 900 retornos ----------
console.log("1) Flujo completo con datos completos (partición 504 / 252)");
const X = F("./fixtures/strategies_prices.json"), chain = F("./fixtures/options_chain.json");
const series = X.tickers.map((sym, i) => ({ sym, name: sym, cur: "USD", t: X.dias.map((d) => d * 86400), adj: X.precios.map((r) => r[i]), close: X.precios.map((r) => r[i] * 1.02), divs: i === 2 ? [{ t: X.dias.at(-30) * 86400, amount: 1.2 }, { t: X.dias.at(-120) * 86400, amount: 1.1 }] : [], source: "test" }));
const sectores = tablaSectores(X.tickers, Object.fromEntries(X.tickers.map((t, i) => [t, X.sector[i]])), {}, {}, "prueba");
const res = correrTaller({ series, sectores, params: { Hlista: [1, 5], tickerOpcion: "AAA", nMC: 20000, nTray: 5000 }, meta: { fuente: "Sintético", consulta: "prueba" }, chain });
cond("ventana completa 504 + 252", res.nTrain === 504 && res.nTest === 252 && !res.ventana.reducido);
cond("hay un aviso por no ser diez acciones", res.avisos.some((a) => /diez acciones/.test(a)));
cond("sesiones comunes = 901", res.calidad.info.sesiones_comunes === 901);
const n = res.tickers.length;
for (const k of ["iguales", "inverso", "minvar"]) casi(`los pesos ${k} suman 1`, res.pesos[k].reduce((s, v) => s + v, 0), 1, 1e-9);
cond("mínimo VaR respeta 2 % – 20 %", res.pesos.minvar.every((v) => v >= 0.02 - 1e-7 && v <= 0.2 + 1e-7));
cond("mínimo VaR respeta el 35 % por sector", res.asignacion.porSector.every((s) => s.minvar <= s.limite + 1e-7));
const rt = riskTable({ R: res.R.slice(0, 504), X: res.R.slice(0, 504).map((r) => r.map((v) => Math.log1p(v))), w: res.pesos.iguales, B: 100000, alpha: 0.99, h: 10, nMC: 20000, seed: 123 });
casi("VaR histórico de pesos iguales = el del motor directo", res.varTabla.iguales.hist.VaR, rt.hist.VaR, 1e-9);
casi("VaR normal de pesos iguales = el del motor directo", res.varTabla.iguales.normal.VaR, rt.normal.VaR, 1e-9);
cond("el VaR de mínimo riesgo es menor que el de pesos iguales (normal)", res.varTabla.minvar.normal.VaR < res.varTabla.iguales.normal.VaR);
cond("3 carteras × 3 estreses", res.estres.length === 9);
cond("excepciones: 252 días evaluados", res.backtestVaR.n === 252 && res.backtestVaR.banderas.length === 252 && res.backtestVaR.vars.length === 252);
cond("excepciones: p-valor entre 0 y 1", res.backtestVaR.pValor >= 0 && res.backtestVaR.pValor <= 1);
cond("5 estrategias con métricas finitas", res.estrategias.length === 5 && res.estrategias.every((e) => [e.retorno, e.vol, e.maxDD, e.costo].every(Number.isFinite) && e.W.length === 253));
cond("el presupuesto de riesgo deja efectivo y su VaR es ≤ V̄", res.asignacion.presupuesto.f < 1 ? Math.abs(res.asignacion.presupuesto.VaRfinal - 5000) < 1e-6 : res.asignacion.presupuesto.VaRfinal <= 5000);
casi("cantidades enteras: invertido + residual = capital", res.asignacion.enteras.invertido + res.asignacion.enteras.residual, 100000, 1e-6);
cond("S0 usa el cierre SIN ajustar (≈ 2 % por encima del ajustado en esta prueba)", Math.abs(res.S0[0] / series[0].adj.at(-1) - 1.02) < 1e-9);
cond("q de AAA… la acción con dividendos tiene q > 0 y las demás 0", res.param[2].q > 0 && res.param.filter((_, i) => i !== 2).every((x) => x.q === 0));
cond("a = μ − q", res.param.every((x) => Math.abs(x.a - (x.mu_total - x.q)) < 1e-12));
cond("rolling H=1 con m = 252 y H=5 con m = 248", res.rolling[1].info.m === 252 && res.rolling[5].info.m === 248);
cond("GBM: 8 filas, todas positivas y |z| < 4", res.gbm.length === 8 && res.gbm.every((g) => g.todos_positivos && Math.abs(g.z) < 4));
cond("opciones: 9 candidatos", res.opciones && res.opciones.candidatos.length === 9);
cond("control CRR presente (≈ 10,45)", Math.abs(res.controlCRR.N500 - 10.4506) < 0.01);
cond("semillas distintas por acción", semilla(res.params, 0) !== semilla(res.params, 1));
const arch = archivosResultados(res), nombres = arch.map((a) => a.name);
cond("exporta resumen, LEEME y los CSV", ["resumen.json", "LEEME.txt", "var_es.csv", "estrategias.csv", "curvas_patrimonio.csv", "rolling_H1.csv", "rolling_H5.csv", "opciones_candidatos.csv", "calidad_datos.csv", "sectores.csv"].every((x) => nombres.includes(x)));
const resumen = JSON.parse(arch.find((a) => a.name === "resumen.json").data);
cond("el resumen guarda la semilla y los parámetros", resumen.semilla_base === 123 && resumen.parametros.capital_B === 100000 && resumen.parametros.limite_por_sector === 0.35);
cond("el resumen acredita a Felipe Pulido", /Felipe Pulido/.test(resumen.creditos));
cond("el ZIP se arma", buildZip(arch).length > 5000);

// ---------- 2) respaldo real: modo reducido ----------
console.log("2) Respaldo guardado real (10 acciones por defecto, modo reducido)");
const snap = F("../data/snapshot.json"); setSnapshot(snap); setSectorMap(F("../data/sectors.json").sectores);
const tk = TICKERS_DEFECTO.map((x) => x[0]);
const carga = await cargarPrecios({ tickers: tk, fuente: "respaldo" });
const sec2 = tablaSectores(tk, Object.fromEntries(TICKERS_DEFECTO), {}, F("../data/sectors.json").sectores, "prueba");
const r2 = correrTaller({ series: carga.series, sectores: sec2, params: { Hlista: [1] }, meta: carga.meta, avisos: carga.avisos });
cond("modo reducido: 499 + 252", r2.ventana.reducido && r2.nTrain === 499 && r2.nTest === 252);
cond("avisa del modo reducido y de que solo hay precios ajustados", r2.avisos.some((a) => /Modo reducido/.test(a)) && r2.avisos.some((a) => /AJUSTADO/.test(a)));
cond("diez acciones y 5 sectores: sin avisos de cantidad ni de sectores", !r2.avisos.some((a) => /diez acciones|cuatro sectores/.test(a)));
cond("sectores del mapa de Horizon", r2.sectorDe.join() === "Tecnología,Tecnología,Financiero,Financiero,Energía,Salud,Salud,Consumo básico,Consumo básico,Consumo básico");
cond("mínimo VaR cumple los límites (datos reales)", r2.pesos.minvar.every((v) => v >= 0.02 - 1e-7 && v <= 0.2 + 1e-7) && r2.asignacion.porSector.every((s) => s.minvar <= s.limite + 1e-7));
cond("5 estrategias con datos reales", r2.estrategias.length === 5 && r2.estrategias.every((e) => Number.isFinite(e.retorno)));
cond("sin cadena de opciones: opciones = null (no se inventa)", r2.opciones === null);
console.log(`   ventana de prueba ${r2.fechas.prueba[0]} → ${r2.fechas.prueba[1]} · VaR 99 % a 10 sesiones (mínimo VaR, histórico) = ${r2.varTabla.minvar.hist.VaR.toFixed(0)} USD`);

// ---------- 3) errores claros ----------
console.log("3) Errores claros");
const lanza = (n, f, pat) => { try { f(); fallos++; console.log(`  ✗ ${n}: no lanzó`); } catch (e) { if (pat.test(e.message)) ok++; else { fallos++; console.log(`  ✗ ${n}: ${e.message}`); } } };
lanza("una sola acción", () => correrTaller({ series: series.slice(0, 1), sectores, params: {} }), /al menos dos/);
lanza("límite sectorial imposible", () => correrTaller({ series, sectores, params: { limSector: 0.1, wmax: 0.2 } }), /solo se puede invertir/);
lanza("pocos datos", () => correrTaller({ series: series.map((s) => ({ ...s, t: s.t.slice(0, 300), adj: s.adj.slice(0, 300), close: s.close.slice(0, 300) })), sectores, params: {} }), /al menos 504/);

console.log(`\nTaller (integración): ${ok} comprobaciones correctas, ${fallos} fallos`);
if (fallos) process.exit(1);
console.log("Taller (integración): todo en orden");
