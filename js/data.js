// Capa de datos: Yahoo Finance en vivo (a través de un proxy) con respaldo de datos guardados.
// Orden de intentos para cada serie:
//   1) /yahoo/...           → redirección de Netlify (netlify.toml) hacia Yahoo
//   2) APP_CONFIG.PROXY_URL → Cloudflare Worker (worker/yahoo-proxy.js), si se configuró
//   3) data/snapshot.json   → datos reales guardados el día de la compilación
const CFG = (typeof window !== "undefined" && window.APP_CONFIG) || {};

let snapshot = null;
let snapshotTried = false;
const cache = new Map();
const live = { fails: 0, disabledUntil: 0 };

export async function loadSnapshot() {
  if (snapshot || snapshotTried) return snapshot;
  snapshotTried = true;
  try {
    const r = await fetch("data/snapshot.json");
    if (r.ok) snapshot = await r.json();
  } catch (e) { snapshot = null; }
  return snapshot;
}
export function setSnapshot(s) { snapshot = s; snapshotTried = true; } // para pruebas en Node

export function snapToSeries(snap, sym) {
  const s = snap?.series?.[sym];
  if (!s) return null;
  return { sym, name: s.n, cur: s.cur, ex: s.ex, t: s.t.map((d) => d * 86400), c: s.c, source: "snapshot", generated: snap.generated };
}

export function regionOf(sym) {
  const s = sym.toUpperCase();
  if (/-(USD|EUR|USDT)$/.test(s)) return "CRYPTO";
  if (s.endsWith(".CL")) return "CO";
  if (/\.(SA|MX|SN|BA|LM)$/.test(s)) return "LATAM";
  if (/\.(L|PA|DE|MC|MI|AS|SW|ST|CO|HE|BR|LS|VI|OL|F|IR)$/.test(s)) return "EU";
  if (/\.(T|HK|SS|SZ|KS|KQ|NS|BO|AX|TW|SI|NZ|TWO)$/.test(s)) return "ASIA";
  return "US";
}
export const REGION_NAMES = { US: "Estados Unidos", CO: "Colombia", LATAM: "Latinoamérica", EU: "Europa", ASIA: "Asia-Pacífico", CRYPTO: "Criptomonedas" };

function parseChart(json, sym) {
  const res = json?.chart?.result?.[0];
  if (!res) return null;
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0]?.close || [];
  const adj = res.indicators?.adjclose?.[0]?.adjclose || null;
  const t = [], c = [];
  for (let k = 0; k < ts.length; k++) {
    const v = adj ? adj[k] : q[k];
    if (v == null || !isFinite(v) || v <= 0) continue;
    t.push(ts[k]); c.push(v);
  }
  if (t.length < 120) return null;
  const m = res.meta || {};
  return { sym, name: m.longName || m.shortName || sym, cur: m.currency || "", ex: m.fullExchangeName || m.exchangeName || "", t, c, source: "live", generated: new Date().toISOString() };
}

async function fetchJSON(url, ms = 9000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const text = await r.text();
    return JSON.parse(text); // si el servidor devuelve HTML (sin proxy) esto falla y se usa el respaldo
  } finally { clearTimeout(to); }
}

// En GitHub Pages no existe el proxy /yahoo de Netlify: ahí solo se usa el Cloudflare Worker de config.js
const ON_PAGES = typeof location !== "undefined" && /\.github\.io$/i.test(location.hostname);
function liveBases() {
  const b = ON_PAGES ? [] : ["/yahoo"];
  if (CFG.PROXY_URL) b.push(CFG.PROXY_URL.replace(/\/$/, ""));
  return b;
}
const liveAllowed = () => liveBases().length > 0 && Date.now() >= live.disabledUntil; // sin proxy disponible = sin conexión
function liveFailed() { if (++live.fails >= 2) { live.disabledUntil = Date.now() + 5 * 60e3; live.fails = 0; } }
function liveWorked() { live.fails = 0; live.disabledUntil = 0; }
export const liveStatus = () => ({ live: liveAllowed(), snapshot: !!snapshot });

export async function getSeries(sym, { range = "3y" } = {}) {
  const key = sym + "|" + range;
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    if (liveAllowed() && !CFG.FORCE_SNAPSHOT) {
      for (const b of liveBases()) {
        try {
          const j = await fetchJSON(`${b}/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`);
          const s = parseChart(j, sym);
          if (s) { liveWorked(); return s; }
        } catch (e) { /* intenta el siguiente */ }
      }
      liveFailed();
    }
    const snap = await loadSnapshot();
    const s = snapToSeries(snap, sym);
    if (s) return s;
    throw new Error(`No se pudieron obtener datos de ${sym}. Prueba con otro símbolo.`);
  })();
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}

export async function getRates() {
  const names = { irx: "^IRX", fvx: "^FVX", tnx: "^TNX", tyx: "^TYX" };
  const out = {};
  await Promise.all(Object.entries(names).map(async ([k, s]) => { try { out[k] = await getSeries(s); } catch (e) { /* opcional */ } }));
  return out;
}

// Canasta regional (para la tendencia y la manada). Si los datos guardados tienen más de 2 días y hay conexión,
// se descargan los 3 años de toda la canasta en lotes de 20 (una o dos peticiones) y se guardan para la sesión.
const uniCache = new Map();
const snapAgeDays = (snap) => (snap?.generated ? (Date.now() - Date.parse(snap.generated)) / 86400e3 : Infinity);
async function liveUniverse(region, list) {
  if (uniCache.has(region)) return uniCache.get(region);
  const p = (async () => {
    const out = [];
    for (let i = 0; i < list.length; i += 20) {
      const batch = list.slice(i, i + 20);
      let ok = false;
      for (const b of liveBases()) {
        try {
          const j = await fetchJSON(`${b}/spark?symbols=${batch.map(encodeURIComponent).join(",")}&range=3y&interval=1d`, 15000);
          for (const s of batch) {
            const r = j?.[s];
            if (!r?.timestamp) continue;
            const t = [], c = [];
            r.timestamp.forEach((ts, k) => { const v = r.close?.[k]; if (v != null && isFinite(v) && v > 0) { t.push(ts); c.push(v); } });
            if (t.length >= 250) out.push({ sym: s, name: s, cur: "", ex: "", t, c, source: "live" });
          }
          ok = true; break;
        } catch (e) { /* siguiente */ }
      }
      if (!ok) throw new Error("sin conexión");
    }
    if (out.length < Math.min(6, list.length)) throw new Error("canasta incompleta");
    return out;
  })();
  uniCache.set(region, p);
  p.catch(() => uniCache.delete(region));
  return p;
}
export async function getUniverse(region, excludeSym) {
  const snap = await loadSnapshot();
  const list = snap?.universes?.[region] || [];
  if (snapAgeDays(snap) > 2 && liveAllowed() && !CFG.FORCE_SNAPSHOT) {
    try { return (await liveUniverse(region, list)).filter((s) => s.sym !== excludeSym); } catch (e) { /* se usan los datos guardados */ }
  }
  return list.filter((s) => s !== excludeSym).map((s) => snapToSeries(snap, s)).filter(Boolean);
}
export const snapshotAge = async () => snapAgeDays(await loadSnapshot());

export async function search(q) {
  q = q.trim();
  if (!q) return [];
  if (liveAllowed() && !CFG.FORCE_SNAPSHOT) {
    for (const b of liveBases()) {
      try {
        const j = await fetchJSON(`${b}/search?q=${encodeURIComponent(q)}&quotesCount=9&newsCount=0`, 6000);
        const out = (j.quotes || []).filter((x) => x.symbol && ["EQUITY", "ETF", "INDEX", "CRYPTOCURRENCY", "MUTUALFUND", "CURRENCY"].includes(x.quoteType))
          .map((x) => ({ sym: x.symbol, name: x.longname || x.shortname || x.symbol, ex: x.exchDisp || "", type: x.quoteType }));
        if (out.length) { liveWorked(); return out; }
      } catch (e) { /* siguiente */ }
    }
    liveFailed();
  }
  const snap = await loadSnapshot();
  const ql = q.toLowerCase();
  return Object.entries(snap?.series || {})
    .filter(([sym, s]) => !sym.startsWith("^") && (sym.toLowerCase().includes(ql) || (s.n || "").toLowerCase().includes(ql)))
    .slice(0, 9).map(([sym, s]) => ({ sym, name: s.n, ex: s.ex, type: "EQUITY" }));
}

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

// ---------- cotización ligera (resumen del mercado), noticias e ideas precalculadas ----------
const quoteCache = new Map();
export async function getQuoteLite(sym) {
  const hit = quoteCache.get(sym);
  if (hit && Date.now() - hit.at < 60e3) return hit;
  if (liveAllowed() && !CFG.FORCE_SNAPSHOT) {
    for (const b of liveBases()) {
      try {
        const res = (await fetchJSON(`${b}/chart/${encodeURIComponent(sym)}?range=1d&interval=15m`, 8000))?.chart?.result?.[0];
        const m = res?.meta;
        if (m && m.regularMarketPrice != null && m.chartPreviousClose != null) {
          const out = { sym, price: m.regularMarketPrice, prev: m.chartPreviousClose, closes: (res.indicators?.quote?.[0]?.close || []).filter((v) => v != null), source: "live", at: Date.now() };
          quoteCache.set(sym, out);
          return out;
        }
      } catch (e) { /* siguiente */ }
    }
  }
  const s = snapToSeries(await loadSnapshot(), sym);
  if (!s || s.c.length < 3) return null;
  const n = s.c.length, out = { sym, price: s.c[n - 1], prev: s.c[n - 2], closes: s.c.slice(-40), source: "snapshot", at: Date.now() };
  quoteCache.set(sym, out);
  return out;
}

export async function getNews(sym, count = 6) {
  if (!liveAllowed() || CFG.FORCE_SNAPSHOT) { const e = new Error("Sin conexión"); e.code = "offline"; throw e; }
  let lastErr = null;
  for (const b of liveBases()) {
    try {
      const j = await fetchJSON(`${b}/search?q=${encodeURIComponent(sym)}&quotesCount=0&newsCount=${count}`, 9000);
      return (j.news || [])
        .filter((n) => n && n.title && typeof n.link === "string" && /^https:\/\//i.test(n.link))
        .slice(0, count)
        .map((n) => ({ title: String(n.title), publisher: n.publisher ? String(n.publisher) : "", link: n.link, time: n.providerPublishTime || 0 }));
    } catch (e) { lastErr = e; }
  }
  const e = new Error("No se pudieron cargar las noticias"); e.cause = lastErr; throw e;
}

export async function getIdeas() {
  const r = await fetch("data/ideas.json");
  if (!r.ok) throw new Error("No se pudieron cargar las ideas");
  return r.json();
}

// ---------- varios precios a la vez (lista estilo Yahoo), movimientos del día, dividendos e historial ----------
// Cotización de hasta 20 símbolos por petición. Devuelve { sym: { price, prev, closes, source } }.
export async function getSparks(syms) {
  const out = {};
  const todo = [];
  for (const s of syms) { const hit = quoteCache.get(s); if (hit && Date.now() - hit.at < 60e3) out[s] = hit; else todo.push(s); }
  if (todo.length && liveAllowed() && !CFG.FORCE_SNAPSHOT) {
    for (let i = 0; i < todo.length; i += 20) {
      const batch = todo.slice(i, i + 20);
      for (const b of liveBases()) {
        try {
          const j = await fetchJSON(`${b}/spark?symbols=${batch.map(encodeURIComponent).join(",")}&range=1d&interval=5m`, 9000);
          let any = false;
          for (const s of batch) {
            const r = j?.[s];
            const closes = (r?.close || []).filter((v) => v != null && isFinite(v));
            if (!r || !closes.length || r.chartPreviousClose == null) continue;
            const q = { sym: s, price: closes[closes.length - 1], prev: r.chartPreviousClose, closes, source: "live", at: Date.now() };
            quoteCache.set(s, q); out[s] = q; any = true;
          }
          if (any) { liveWorked(); break; }
        } catch (e) { /* siguiente */ }
      }
    }
  }
  const snap = await loadSnapshot();
  for (const s of syms) {
    if (out[s]) continue;
    const ser = snapToSeries(snap, s);
    if (ser && ser.c.length > 2) { const n = ser.c.length; out[s] = { sym: s, price: ser.c[n - 1], prev: ser.c[n - 2], closes: ser.c.slice(-30), source: "snapshot", at: Date.now() }; }
  }
  return out;
}

// Acciones de EE. UU. que más suben / bajan hoy (lista oficial de Yahoo). Sin conexión: el universo guardado.
export async function getMovers(kind = "gainers", count = 6) {
  if (liveAllowed() && !CFG.FORCE_SNAPSHOT) {
    for (const b of liveBases()) {
      try {
        const j = await fetchJSON(`${b}/screener?scrIds=day_${kind}&count=${count}`, 9000);
        const qs = j?.finance?.result?.[0]?.quotes || [];
        if (qs.length) return { source: "live", items: qs.slice(0, count).map((q) => ({ sym: q.symbol, name: q.shortName || q.longName || q.symbol, price: q.regularMarketPrice, ch: (q.regularMarketChangePercent || 0) / 100, cur: q.currency || "" })) };
      } catch (e) { /* siguiente */ }
    }
  }
  const snap = await loadSnapshot();
  const items = Object.entries(snap?.series || {}).filter(([s]) => !s.startsWith("^") && !s.endsWith("=X"))
    .map(([sym, s]) => { const n = s.c.length; return { sym, name: s.n, price: s.c[n - 1], ch: s.c[n - 1] / s.c[n - 2] - 1, cur: s.cur }; })
    .sort((a, b) => (kind === "gainers" ? b.ch - a.ch : a.ch - b.ch)).slice(0, count);
  return { source: "snapshot", items };
}

// Dividendos pagados en el último año (para el rendimiento por dividendo)
export async function getDividends(sym) {
  if (!liveAllowed() || CFG.FORCE_SNAPSHOT) return null;
  for (const b of liveBases()) {
    try {
      const res = (await fetchJSON(`${b}/chart/${encodeURIComponent(sym)}?range=1y&interval=1mo&events=div`, 9000))?.chart?.result?.[0];
      if (!res) continue;
      const divs = Object.values(res.events?.dividends || {});
      return { total: divs.reduce((s, d) => s + (d.amount || 0), 0), count: divs.length, price: res.meta?.regularMarketPrice };
    } catch (e) { /* siguiente */ }
  }
  return null;
}

// Tipo de cambio a pesos colombianos (para sumar un portafolio con monedas distintas)
export async function getFxToCOP(cur) {
  if (!cur || cur === "COP") return 1;
  const pence = cur === "GBp" || cur === "GBX"; // Londres cotiza en peniques
  const base = pence ? "GBP" : cur.toUpperCase();
  const sym = base === "USD" ? "COP=X" : `${base}COP=X`;
  try { const q = await getQuoteLite(sym); if (q && isFinite(q.price) && q.price > 0) return pence ? q.price / 100 : q.price; } catch (e) { /* sin dato */ }
  return null;
}

let trackP = null;
export function getTrackRecord() {
  return (trackP ||= fetch("data/backtest_report.json").then((r) => (r.ok ? r.json() : null)).catch(() => null));
}

// ---------- Taller de riesgo: diario con cierre sin ajustar y dividendos, cadena de opciones, sector ----------
const dailyCache = new Map();
const offlineErr = () => { const e = new Error("Sin conexión con Yahoo Finance"); e.code = "offline"; return e; };

// Serie diaria de `years` años: cierre SIN ajustar (para S0 y cantidades), cierre ajustado (para retornos) y dividendos
export async function getDailyFull(sym, { years = 4 } = {}) {
  const key = `${sym}|${years}`, hit = dailyCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < 10 * 60e3) return hit;
  if (!liveAllowed() || CFG.FORCE_SNAPSHOT) throw offlineErr();
  let lastErr = null;
  for (const b of liveBases()) {
    try {
      const j = await fetchJSON(`${b}/chart/${encodeURIComponent(sym)}?range=${years}y&interval=1d&events=div`, 25000);
      const res = j?.chart?.result?.[0];
      if (!res?.timestamp) throw new Error(j?.chart?.error?.description || "Sin datos");
      const q = res.indicators?.quote?.[0]?.close || [], adj = res.indicators?.adjclose?.[0]?.adjclose || null;
      let t = [], close = [], aj = [];
      for (let k = 0; k < res.timestamp.length; k++) {
        const c = q[k], a = adj ? adj[k] : c;
        if (c == null || !isFinite(c) || c <= 0 || a == null || !isFinite(a) || a <= 0) continue;
        t.push(res.timestamp[k]); close.push(c); aj.push(a);
      }
      if (t.length < 120) throw new Error("Muy pocos datos");
      // la sesión en curso viene incompleta: se excluye para no mezclar un retorno parcial
      const now = Date.now() / 1000, reg = res.meta?.currentTradingPeriod?.regular;
      let parcial = false;
      if (reg && now >= reg.start && now < reg.end && Math.floor(t[t.length - 1] / 86400) === Math.floor(now / 86400)) { t.pop(); close.pop(); aj.pop(); parcial = true; }
      const divs = Object.values(res.events?.dividends || {}).map((d) => ({ t: d.date, amount: d.amount })).sort((x, y) => x.t - y.t);
      const m = res.meta || {};
      const out = { sym, name: m.longName || m.shortName || sym, cur: m.currency || "", t, close, adj: aj, divs, source: "live", sesionParcialExcluida: parcial, fetchedAt: Date.now() };
      dailyCache.set(key, out);
      return out;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`No se pudieron obtener datos de ${sym}${lastErr ? ": " + lastErr.message : ""}`);
}

// Cadena de opciones (necesita el Worker o el servidor local: Yahoo pide credencial). Devuelve los vencimientos más cercanos a 1, 3 y 6 meses.
export async function getOptionsChain(sym, { targets = [30, 91, 182], now = Date.now() } = {}) {
  if (!liveAllowed() || CFG.FORCE_SNAPSHOT) throw offlineErr();
  const hoyDia = Math.floor(now / 86400000);
  const norm = (c) => ({ contractSymbol: c.contractSymbol, strike: +c.strike, bid: Number.isFinite(c.bid) ? c.bid : 0, ask: Number.isFinite(c.ask) ? c.ask : 0, volume: c.volume ?? 0, openInterest: c.openInterest ?? 0, impliedVolatility: Number.isFinite(c.impliedVolatility) ? c.impliedVolatility : NaN });
  let lastErr = null;
  for (const b of liveBases()) {
    try {
      const j0 = await fetchJSON(`${b}/options?symbol=${encodeURIComponent(sym)}`, 25000), r0 = j0?.optionChain?.result?.[0];
      if (!r0) throw new Error(j0?.optionChain?.error?.description || j0?.finance?.error?.description || "Sin cadena de opciones");
      const exps = r0.expirationDates || [];
      if (!exps.length) throw new Error("Este activo no tiene opciones listadas");
      const lista = exps.map((e) => ({ e, dias: Math.floor(e / 86400) - hoyDia })), usados = new Set(), elegidos = [];
      for (const obj of targets) { const c = lista.filter((x) => x.dias >= 5 && !usados.has(x.e)).sort((x, y) => Math.abs(x.dias - obj) - Math.abs(y.dias - obj))[0]; if (c) { usados.add(c.e); elegidos.push(c); } }
      const expirations = [];
      for (const x of elegidos) {
        let o = r0.options?.[0]?.expirationDate === x.e ? r0.options[0] : null;
        if (!o) { const jj = await fetchJSON(`${b}/options?symbol=${encodeURIComponent(sym)}&date=${x.e}`, 25000); o = jj?.optionChain?.result?.[0]?.options?.[0]; }
        if (o) expirations.push({ venc: new Date(x.e * 1000).toISOString().slice(0, 10), dias: x.dias, calls: (o.calls || []).map(norm), puts: (o.puts || []).map(norm) });
      }
      if (!expirations.length) throw new Error("No se pudieron leer los vencimientos");
      return { ticker: sym, hora: new Date().toISOString(), nListadas: exps.length, S0: r0.quote?.regularMarketPrice ?? null, expirations };
    } catch (e) { lastErr = e; }
  }
  throw new Error(`No se pudo bajar la cadena de opciones de ${sym}${lastErr ? ": " + lastErr.message : ""}`);
}

// Sector según Yahoo (opcional: requiere el Worker o el servidor local). Devuelve null si no está disponible.
const sectorCache = new Map();
export async function getYahooSector(sym) {
  if (sectorCache.has(sym)) return sectorCache.get(sym);
  let out = null;
  if (liveAllowed() && !CFG.FORCE_SNAPSHOT) {
    for (const b of liveBases()) { try { const j = await fetchJSON(`${b}/sector?symbol=${encodeURIComponent(sym)}`, 15000); if (j?.sector) { out = { sector: j.sector, industry: j.industry || "" }; break; } } catch (e) { /* siguiente */ } }
  }
  sectorCache.set(sym, out);
  return out;
}

// Mapa de sectores de Horizon (data/sectors.json)
let sectorMap = null;
export function setSectorMap(m) { sectorMap = m; }
export async function loadSectorMap() {
  if (sectorMap) return sectorMap;
  try { const r = await fetch("data/sectors.json"); if (r.ok) sectorMap = (await r.json()).sectores || {}; } catch (e) { /* sin mapa */ }
  return (sectorMap ||= {});
}

