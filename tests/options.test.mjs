// Verifica js/options.js contra la referencia en Python (CRR con numpy, Black–Scholes con scipy y probabilidades analíticas).
// Antes:  python -X utf8 -I tests/options_reference.py     Luego:  node tests/options.test.mjs
import { readFileSync } from "node:fs";
import { crrQ, crrPrice, crrTree3, bsPrice, convergence, controlCRR, elegirPlazos, analizarCadena, detalleContrato } from "../js/options.js";

const F = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const chain = F("options_chain.json"), E = F("options_expected.json");
let ok = 0, fallos = 0;
const casi = (nombre, a, b, abs, rel = 0) => { const e = Math.abs(a - b), l = abs + rel * Math.abs(b); if (e <= l) ok++; else { fallos++; console.log(`  ✗ ${nombre}: JS ${a} vs referencia ${b} (error ${e.toExponential(2)} > ${l.toExponential(2)})`); } };
const igual = (nombre, a, b) => { if (a === b) ok++; else { fallos++; console.log(`  ✗ ${nombre}: ${a} ≠ ${b}`); } };
const lanza = (nombre, f, patron) => { try { f(); fallos++; console.log(`  ✗ ${nombre}: no lanzó error`); } catch (e) { if (patron.test(e.message)) ok++; else { fallos++; console.log(`  ✗ ${nombre}: error inesperado: ${e.message}`); } } };

console.log("1) Árbol CRR y Black–Scholes");
const c = E.control;
casi("Black–Scholes call de control = 10,4506", bsPrice({ S0: 100, K: 100, T: 1, r: 0.05, q: 0, sigma: 0.2, tipo: "call" }), c.BS_call, 1e-12);
casi("BS con dividendos (put)", bsPrice({ S0: 100, K: 90, T: 0.75, r: 0.04, q: 0.02, sigma: 0.25, tipo: "put" }), c.bs_q, 1e-12);
const ctrl = controlCRR();
casi("CRR call europea N = 500 (idéntico a Python)", ctrl.N500, c.N500_call_eu, 1e-10);
casi("CRR put europea N = 500", ctrl.put_europea, c.N500_put_eu, 1e-10);
casi("CRR put americana N = 500", ctrl.put_americana, c.N500_put_am, 1e-10);
casi("CRR call americana (q = 0) N = 500", ctrl.call_americana, c.N500_call_am, 1e-10);
igual("put americana vale más que la europea", ctrl.put_americana > ctrl.put_europea + 0.1, true);
casi("call americana = europea cuando q = 0", ctrl.call_americana, ctrl.N500, 1e-9);
casi("el árbol de N = 500 está a < 0,01 de Black–Scholes", Math.abs(ctrl.N500 - ctrl.BS) < 0.01 ? 0 : 1, 0, 0);
for (const f of ctrl.convergencia) if (c.conv[String(f.N)] !== undefined) casi(`convergencia N = ${f.N} (idéntica a Python)`, f.precio, c.conv[String(f.N)], 1e-10);
casi("a N = 5000 el error frente a BS es < 0,003", Math.abs(ctrl.convergencia.at(-1).precio - ctrl.BS) < 0.003 ? 0 : 1, 0, 0);
casi("árbol de 3 pasos: call americana con dividendos", crrPrice({ S0: 100, K: 95, T: 0.5, r: 0.05, q: 0.03, sigma: 0.3, N: 3, tipo: "call", estilo: "americana" }), c.arbol3.call_am_q, 1e-10);
const t3 = crrTree3({ S0: 100, K: 105, T: 0.5, r: 0.05, q: 0, sigma: 0.3, tipo: "put", estilo: "americana" });
casi("árbol de 3 pasos (nodos): valor en la raíz", t3.V[0][0], c.arbol3.put_am, 1e-10);
casi("árbol de 3 pasos: u·d = 1", t3.u * t3.d, 1, 1e-14);
igual("el árbol de 3 pasos ejerce alguna vez (put americana)", t3.ejerce.flat().some(Boolean), true);
casi("árbol de 3 pasos europeo", crrPrice({ S0: 100, K: 105, T: 0.5, r: 0.05, q: 0, sigma: 0.3, N: 3, tipo: "put", estilo: "europea" }), c.arbol3.put_eu, 1e-10);

console.log("2) Condición de no arbitraje de pQ (se verifica, no se recorta)");
lanza("σ muy chica y deriva grande", () => crrQ({ T: 1, r: 0.5, q: 0, sigma: 0.01, N: 10 }), /no arbitraje/);
lanza("pQ fuera de (0,1) en el precio", () => crrPrice({ S0: 100, K: 100, T: 1, r: 0.5, q: 0, sigma: 0.01, N: 10, tipo: "call" }), /no arbitraje/);
lanza("parámetros inválidos", () => crrQ({ T: 0, r: 0.04, q: 0, sigma: 0.2, N: 10 }), /inválidos/);
const q0 = crrQ({ T: 1, r: 0.05, q: 0, sigma: 0.2, N: 500 });
igual("con parámetros normales pQ ∈ (0,1)", q0.p > 0 && q0.p < 1, true);

console.log("3) Cadena: vencimientos, strikes por cuantiles y tabla de candidatos");
const P = E.params, base = { S0: P.S0, a: P.a, sigma: P.sigma, q: P.q, r: P.r, chain, tipo: P.tipo, estilo: P.estilo, N: P.N, costoT: P.costoT, oiMin: P.oiMin, spreadMax: P.spreadMax, nTray: 200000, seed: 123, ticker: "TST" };
const pl = elegirPlazos(chain.expirations);
igual("3 vencimientos", pl.length, 3);
igual("vencimientos elegidos (1, 3 y 6 meses)", JSON.stringify(pl.map((x) => x.dias)), JSON.stringify(E.plazos.map((x) => x.dias)));
const opc = analizarCadena(base);
igual("9 candidatos", opc.candidatos.length, 9);
E.candidatos.forEach((f, i) => {
  const k = opc.candidatos[i], tag = `${f.plazo} β=${f.beta}`;
  igual(`${tag}: plazo`, k.plazo, f.plazo); igual(`${tag}: strike`, k.strike, f.strike); igual(`${tag}: contrato`, k.contrato, f.contrato);
  casi(`${tag}: cuantil del GBM`, k.cuantil_GBM, f.cuantil, 1e-9);
  igual(`${tag}: usable (bid/ask válidos)`, k.usable, f.usable);
  if (f.usable) { casi(`${tag}: precio medio`, k.medio, f.medio, 1e-12); casi(`${tag}: spread relativo`, k.spread_rel, f.spread_rel, 1e-12); }
  casi(`${tag}: P(ejercicio) (MC vs analítica ≤ 0,006)`, k.P_ejercicio, f.P_ejercicio, 0.006);
  if (f.usable) { casi(`${tag}: P(beneficio) (≤ 0,006)`, k.P_beneficio, f.P_beneficio, 0.006); casi(`${tag}: ganancia esperada (≤ 0,5 USD)`, k.E_ganancia, f.E_ganancia, 0.5); }
  casi(`${tag}: prima CRR con σ histórica (idéntica a Python)`, k.V_CRR_sigma_hist, f.V_CRR_hist, 1e-9);
  casi(`${tag}: prima CRR con vol. implícita (idéntica)`, k.V_CRR_vol_impl, f.V_CRR_iv, 1e-9);
});
const strikesUnicos = new Set(opc.candidatos.filter((x) => x.plazo === "1 mes").map((x) => x.strike));
igual("en un mismo plazo no se repite el strike (se toma el vecino)", strikesUnicos.size, 3);

console.log("4) Regla de elección del contrato");
if (opc.elegido !== null) {
  const el = opc.candidatos[opc.elegido];
  igual("el elegido tiene bid/ask válido", el.usable, true); igual("el elegido cumple interés abierto", el.interes_abierto >= P.oiMin, true);
  igual("el elegido cumple el spread máximo", el.spread_rel <= P.spreadMax, true); igual("el elegido tiene ganancia esperada positiva", el.E_ganancia > 0, true);
  const elegiblesJS = opc.candidatos.filter((x) => x.usable && x.interes_abierto >= P.oiMin && x.spread_rel <= P.spreadMax && x.E_ganancia > 0);
  igual("el elegido tiene la mayor P(beneficio) entre los elegibles", Math.max(...elegiblesJS.map((x) => x.P_beneficio)), el.P_beneficio);
  igual("coincide con el elegido por la referencia analítica (o su P(beneficio) difiere < 0,01)", opc.elegido === E.elegido || Math.abs(el.P_beneficio - E.candidatos[E.elegido].P_beneficio) < 0.01, true);
} else igual("no hay elegido y la referencia tampoco", E.elegido, null);
const sinFiltro = analizarCadena({ ...base, oiMin: 1e9 });
igual("si ninguno cumple el filtro no hay elegido y se avisa", sinFiltro.elegido === null && sinFiltro.notas.length === 1, true);

console.log("5) Detalle del contrato: sensibilidad, prima frente al mercado, árbol y convergencia");
const idx = opc.elegido ?? opc.candidatos.findIndex((x) => x.usable), det = detalleContrato(opc, idx);
igual("9 combinaciones de a y σ", det.sens.length, 9);
const centro = det.sens.find((s) => Math.abs(s.a - P.a) < 1e-12 && Math.abs(s.sigma - P.sigma) < 1e-12);
casi("la combinación central reproduce P(beneficio)", centro.P_beneficio, det.fila.P_beneficio, 1e-12);
const cs = det.sens.filter((s) => Math.abs(s.sigma - P.sigma) < 1e-12).sort((x, y) => x.a - y.a);
igual("subir a sube P(ejercicio) en una call", cs[0].P_ejercicio < cs[1].P_ejercicio && cs[1].P_ejercicio < cs[2].P_ejercicio, true);
igual("la prima teórica sube con σ", det.precio_sigma[0].V_CRR < det.precio_sigma[1].V_CRR && det.precio_sigma[1].V_CRR < det.precio_sigma[2].V_CRR, true);
casi("δ = V_CRR − precio medio", det.mercado.delta, det.mercado.V_CRR - det.mercado.medio, 1e-12);
casi("δ relativo", det.mercado.delta_rel, (det.mercado.V_CRR - det.mercado.medio) / det.mercado.medio, 1e-12);
igual("'dentro del bid/ask' es coherente", det.mercado.dentro, det.fila.bid <= det.mercado.V_CRR && det.mercado.V_CRR <= det.fila.ask);
igual("árbol de 3 pasos presente", det.arbol.N, 3); igual("convergencia presente", det.conv.length, 9);
const sinBA = opc.candidatos.findIndex((x) => !x.usable);
if (sinBA >= 0) igual("contrato sin bid/ask válido: no se inventa la comparación", detalleContrato(opc, sinBA).mercado, null);

console.log(`\nOpciones: ${ok} comprobaciones correctas, ${fallos} fallos`);
if (fallos) process.exit(1);
console.log("Opciones: todo en orden");
