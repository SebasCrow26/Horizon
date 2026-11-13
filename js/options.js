// Opciones: árbol binomial CRR (europeo y americano), Black–Scholes de control, árbol de 3 pasos, convergencia y análisis de una
// cadena real de opciones (vencimientos, strikes por cuantiles del GBM, probabilidades y prima teórica frente al mercado).
// Créditos: el diseño del análisis (3 vencimientos, 9 candidatos, P(ejercicio), P(beneficio), comparación con bid/ask) parte del
// Taller de valoración y riesgo de Felipe Pulido; este código es una implementación propia verificada en tests/options.test.mjs.
//
//   Δt = T/N,  u = e^{σ√Δt},  d = 1/u,  p_Q = (e^{(r−q)Δt} − d)/(u − d)   → se VERIFICA 0 < p_Q < 1 (no se recorta)
//   V_cont = e^{−rΔt}[p_Q V_up + (1 − p_Q) V_down];  americana: V = max(V_cont, ejercicio)
//   Π_T = H(S_T) − A·e^{rT} − c_T   (A = prima pagada = ask;  H = payoff del contrato)
//   Q_β(S_T) = S0·exp[(a − σ²/2)T + σ√T·Φ⁻¹(β)],  β ∈ {0,25; 0,50; 0,75}
import { rng, randn } from "./util.js";
import { normCdfP, normInv } from "./risk.js";

// ---------- árbol CRR ----------
export function crrQ({ T, r, q = 0, sigma, N }) {
  if (!(T > 0) || !(sigma > 0) || !(N >= 1)) throw new Error("Parámetros inválidos para el árbol (T, σ y N deben ser positivos).");
  const dt = T / N, sq = sigma * Math.sqrt(dt), u = Math.exp(sq), d = 1 / u, p = (Math.exp((r - q) * dt) - d) / (u - d);
  if (!(p > 0 && p < 1)) throw new Error(`El árbol viola la condición de no arbitraje: pQ = ${p.toFixed(6)} no está en (0, 1) con N = ${N} (r = ${r}, q = ${q}, σ = ${sigma}, T = ${T}). Aumenten N o revisen los parámetros.`);
  return { dt, sq, u, d, p, disc: Math.exp(-r * dt) };
}

export function crrPrice({ S0, K, T, r, q = 0, sigma, N = 500, tipo = "call", estilo = "europea" }) {
  const { sq, p, disc } = crrQ({ T, r, q, sigma, N });
  const call = tipo === "call", am = estilo === "americana";
  const pay = (s) => (call ? Math.max(s - K, 0) : Math.max(K - s, 0));
  const V = new Float64Array(N + 1);
  for (let j = 0; j <= N; j++) V[j] = pay(S0 * Math.exp((2 * j - N) * sq));
  for (let i = N - 1; i >= 0; i--) {
    for (let j = 0; j <= i; j++) {
      const cont = disc * (p * V[j + 1] + (1 - p) * V[j]);
      V[j] = am ? Math.max(cont, pay(S0 * Math.exp((2 * j - i) * sq))) : cont;
    }
  }
  return V[0];
}

// Árbol de 3 pasos con todos los nodos (para dibujarlo): precios del subyacente, valor del contrato y decisión de ejercicio
export function crrTree3({ S0, K, T, r, q = 0, sigma, tipo = "call", estilo = "europea" }) {
  const N = 3, { sq, u, d, p, disc } = crrQ({ T, r, q, sigma, N });
  const call = tipo === "call", am = estilo === "americana", pay = (s) => (call ? Math.max(s - K, 0) : Math.max(K - s, 0));
  const S = [], V = [], ejerce = [];
  for (let i = 0; i <= N; i++) { S.push([]); V.push(new Array(i + 1).fill(0)); ejerce.push(new Array(i + 1).fill(false)); for (let j = 0; j <= i; j++) S[i].push(S0 * Math.exp((2 * j - i) * sq)); }
  for (let j = 0; j <= N; j++) V[N][j] = pay(S[N][j]);
  for (let i = N - 1; i >= 0; i--) for (let j = 0; j <= i; j++) {
    const cont = disc * (p * V[i + 1][j + 1] + (1 - p) * V[i + 1][j]), ex = pay(S[i][j]);
    if (am && ex > cont) { V[i][j] = ex; ejerce[i][j] = true; } else V[i][j] = cont;
  }
  return { N, u, d, p, S, V, ejerce };
}

export function bsPrice({ S0, K, T, r, q = 0, sigma, tipo = "call" }) {
  const sd = sigma * Math.sqrt(T), d1 = (Math.log(S0 / K) + (r - q + (sigma * sigma) / 2) * T) / sd, d2 = d1 - sd;
  return tipo === "call" ? S0 * Math.exp(-q * T) * normCdfP(d1) - K * Math.exp(-r * T) * normCdfP(d2) : K * Math.exp(-r * T) * normCdfP(-d2) - S0 * Math.exp(-q * T) * normCdfP(-d1);
}

export const NS_CONV = [10, 25, 50, 100, 200, 500, 1000, 2000, 5000];
export function convergence(par, Ns = NS_CONV) { return Ns.map((N) => ({ N, precio: crrPrice({ ...par, N }) })); }

// Control del taller: call europea con S0 = K = 100, T = 1, r = 0,05, q = 0, σ = 0,20 → el árbol converge al valor de Black–Scholes (10,4506)
export function controlCRR() {
  const par = { S0: 100, K: 100, T: 1, r: 0.05, q: 0, sigma: 0.2 };
  return {
    parametros: par, N500: crrPrice({ ...par, N: 500, tipo: "call", estilo: "europea" }), BS: bsPrice({ ...par, tipo: "call" }),
    put_europea: crrPrice({ ...par, N: 500, tipo: "put", estilo: "europea" }), put_americana: crrPrice({ ...par, N: 500, tipo: "put", estilo: "americana" }),
    call_americana: crrPrice({ ...par, N: 500, tipo: "call", estilo: "americana" }),
    convergencia: convergence({ ...par, tipo: "call", estilo: "europea" }),
  };
}

// ---------- cadena de opciones ----------
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const validoBA = (bid, ask) => Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid;

export function elegirPlazos(expirations, objetivos = [30, 91, 182]) {
  const usadas = new Set(), out = [];
  const nombres = ["1 mes", "3 meses", "6 meses"];
  objetivos.forEach((obj, k) => {
    const c = expirations.filter((e) => e.dias >= 5 && !usadas.has(e.venc)).sort((x, y) => Math.abs(x.dias - obj) - Math.abs(y.dias - obj))[0];
    if (c) { usadas.add(c.venc); out.push({ plazo: nombres[k], ...c }); }
  });
  return out;
}

// Strike listado más cercano al cuantil; si ya se usó, se toma el vecino más cercano disponible
function strikeCercano(strikes, objetivo, usados) {
  const lib = strikes.filter((k) => !usados.has(k)).sort((a, b) => Math.abs(a - objetivo) - Math.abs(b - objetivo));
  return lib.length ? lib[0] : null;
}

// ctx: { S0, a, sigma, q, r, chain:{expirations:[{venc,dias,calls,puts}], hora, nListadas}, tipo, estilo, N, costoT, oiMin, spreadMax, nTray, seed }
export function analizarCadena(ctx) {
  const { S0, a, sigma, q = 0, r, chain, tipo = "call", estilo = "americana", N = 500, costoT = 0, oiMin = 100, spreadMax = 0.1, nTray = 10000, seed = 123 } = ctx;
  const plazos = elegirPlazos(chain.expirations);
  const R = rng(seed), Z = new Float64Array(nTray); for (let k = 0; k < nTray; k++) Z[k] = randn(R); // los mismos números aleatorios en todas las combinaciones
  const stFor = (T, a_, s_) => { const out = new Float64Array(nTray), m = (a_ - (s_ * s_) / 2) * T, v = s_ * Math.sqrt(T); for (let k = 0; k < nTray; k++) out[k] = S0 * Math.exp(m + v * Z[k]); return out; };
  const pay = (s, K) => (tipo === "call" ? Math.max(s - K, 0) : Math.max(K - s, 0));
  const stats = (ST, K, A, T) => {
    const cap = A * Math.exp(r * T) + costoT;
    let ex = 0, pb = 0, eg = 0;
    for (let k = 0; k < nTray; k++) { const h = pay(ST[k], K); if (tipo === "call" ? ST[k] > K : ST[k] < K) ex++; const pi = h - cap; if (pi > 0) pb++; eg += pi; }
    return { P_ejercicio: ex / nTray, P_beneficio: Number.isFinite(A) ? pb / nTray : NaN, E_ganancia: Number.isFinite(A) ? eg / nTray : NaN };
  };
  const candidatos = [];
  for (const pl of plazos) {
    const lista = tipo === "call" ? pl.calls : pl.puts, T = pl.dias / 365, ST = stFor(T, a, sigma);
    const strikes = [...new Set(lista.map((c) => c.strike))].sort((x, y) => x - y), usados = new Set();
    for (const beta of [0.25, 0.5, 0.75]) {
      const Qb = S0 * Math.exp((a - (sigma * sigma) / 2) * T + sigma * Math.sqrt(T) * normInv(beta)), K = strikeCercano(strikes, Qb, usados);
      if (K == null) continue;
      usados.add(K);
      const c = lista.find((x) => x.strike === K), bid = c.bid, ask = c.ask, usable = validoBA(bid, ask), medio = usable ? (bid + ask) / 2 : NaN;
      const s = stats(ST, K, usable ? ask : NaN, T);
      let Vh = NaN, Vi = NaN, nota = "";
      try { Vh = crrPrice({ S0, K, T, r, q, sigma, N, tipo, estilo }); } catch (e) { nota = e.message; }
      const iv = c.impliedVolatility;
      if (Number.isFinite(iv) && iv > 0.005) { try { Vi = crrPrice({ S0, K, T, r, q, sigma: iv, N, tipo, estilo }); } catch (e) { nota += " " + e.message; } }
      candidatos.push({
        plazo: pl.plazo, vencimiento: pl.venc, dias_calendario: pl.dias, T_valoracion: T, beta, cuantil_GBM: Qb, strike: K, contrato: c.contractSymbol, bid, ask, medio,
        spread_rel: usable ? (ask - bid) / medio : NaN, volumen: c.volume ?? 0, interes_abierto: c.openInterest ?? 0, vol_implicita: iv, ...s, V_CRR_sigma_hist: Vh, V_CRR_vol_impl: Vi, usable, nota,
      });
    }
  }
  const elegibles = candidatos.map((c, i) => ({ c, i })).filter(({ c }) => c.usable && c.interes_abierto >= oiMin && c.spread_rel <= spreadMax && c.E_ganancia > 0);
  elegibles.sort((x, y) => y.c.P_beneficio - x.c.P_beneficio);
  const notas = [];
  if (!elegibles.length) notas.push("Ningún contrato cumple a la vez bid/ask válido, el interés abierto y el spread pedidos, con ganancia esperada positiva bajo P. Se puede elegir otro de la tabla.");
  return { ticker: ctx.ticker, S0, sigma, a, q, hora: chain.hora, n_vencimientos_listados: chain.nListadas ?? chain.expirations.length, plazos: plazos.map((p) => ({ plazo: p.plazo, vencimiento: p.venc, dias_calendario: p.dias, T_valoracion: p.dias / 365 })), candidatos, elegido: elegibles.length ? elegibles[0].i : null, notas, tipo, estilo, N, params: { r, costoT, oiMin, spreadMax, nTray, seed } };
}

// Detalle de un contrato de la tabla: sensibilidad a a y σ, prima frente al mercado, árbol de 3 pasos y convergencia
export function detalleContrato(opc, idx) {
  const c = opc.candidatos[idx], { S0, sigma, a, q } = opc, { r, costoT, nTray, seed } = opc.params, { tipo, estilo } = opc, T = c.T_valoracion;
  const R = rng(seed), Z = new Float64Array(nTray); for (let k = 0; k < nTray; k++) Z[k] = randn(R);
  const cap = c.usable ? c.ask * Math.exp(r * T) + costoT : NaN;
  const calc = (a_, s_) => {
    const m = (a_ - (s_ * s_) / 2) * T, v = s_ * Math.sqrt(T); let ex = 0, pb = 0;
    for (let k = 0; k < nTray; k++) { const st = S0 * Math.exp(m + v * Z[k]), h = tipo === "call" ? Math.max(st - c.strike, 0) : Math.max(c.strike - st, 0); if (tipo === "call" ? st > c.strike : st < c.strike) ex++; if (h - cap > 0) pb++; }
    return { P_ejercicio: ex / nTray, P_beneficio: Number.isFinite(cap) ? pb / nTray : NaN };
  };
  const sens = [];
  for (const da of [-0.05, 0, 0.05]) for (const ms of [0.8, 1, 1.2]) sens.push({ a: a + da, sigma: sigma * ms, ...calc(a + da, sigma * ms) });
  const precio_sigma = [0.8, 1, 1.2].map((ms) => { let V = NaN; try { V = crrPrice({ S0, K: c.strike, T, r, q, sigma: sigma * ms, N: opc.N, tipo, estilo }); } catch (e) { /* queda NaN */ } return { sigma_mult: ms, sigma: sigma * ms, V_CRR: V }; });
  let mercado = null;
  if (c.usable) {
    const m = c.medio, V = c.V_CRR_sigma_hist;
    mercado = { contrato: c.contrato, bid: c.bid, ask: c.ask, medio: m, V_CRR: V, delta: V - m, delta_rel: (V - m) / m, dentro: c.bid <= V && V <= c.ask, sigma_historica: sigma, vol_implicita: c.vol_implicita, V_CRR_vol_impl: c.V_CRR_vol_impl, hora: opc.hora };
  }
  let arbol = null, conv = null;
  try { arbol = crrTree3({ S0, K: c.strike, T, r, q, sigma, tipo, estilo }); } catch (e) { /* sin árbol */ }
  try { conv = convergence({ S0, K: c.strike, T, r, q, sigma, tipo, estilo }); } catch (e) { /* sin convergencia */ }
  const ST = new Float64Array(nTray), m0 = (a - (sigma * sigma) / 2) * T, v0 = sigma * Math.sqrt(T);
  for (let k = 0; k < nTray; k++) ST[k] = S0 * Math.exp(m0 + v0 * Z[k]);
  return { fila: c, sens, precio_sigma, mercado, arbol, conv, ST };
}
