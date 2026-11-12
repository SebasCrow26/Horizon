// Diario de decisiones: anota lo que Horizon dijo (no lo que hiciste) y, al pasar 1 y 3 meses, revisa qué pasó.
// Todo se guarda solo en este dispositivo (localStorage "hz_journal"). Nada se compra ni se envía a ningún lado.
import { getSeries } from "./data.js";

const KEY = "hz_journal";
const MAX = 3000;
const BENCH = "SPY"; // referencia: el S&P 500
export const HORIZONS = [21, 63]; // sesiones de bolsa ≈ 1 y 3 meses

export function journalEntries() {
  try { const v = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function save(list) { try { localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX))); } catch (e) { /* sin almacenamiento */ } }
export function journalReplace(list) { save(Array.isArray(list) ? list : []); }
export function journalClear() { save([]); }

// Anota el veredicto de hoy. Una anotación por activo por semana, o antes si el veredicto cambió.
export function journalRecord(a) {
  if (!a || !a.symbol || !isFinite(a.S0) || !a.asOf) return;
  const list = journalEntries();
  const day = Math.floor(a.asOf / 86400);
  const e = {
    id: `${a.symbol}|${day}`, sym: a.symbol, name: a.name, cur: a.currency || "", day, at: Date.now(),
    price: +a.S0.toPrecision(8), v: a.verdict.key, label: a.verdict.label, tone: a.verdict.tone, score: +a.score.toFixed(3),
    v5: a.verdict5?.key, stop: +a.stop.toPrecision(8), target: +(a.target > a.S0 * 1.01 ? a.target : a.range.hi).toPrecision(8),
    lo: +a.range.lo.toPrecision(8), hi: +a.range.hi.toPrecision(8), probUp: +a.probUp.toFixed(3), region: a.region, out: {},
  };
  let last = -1;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].sym === a.symbol) { last = i; break; }
  if (last >= 0) {
    const p = list[last];
    if (p.day === day) { if (p.v !== e.v || p.price !== e.price) { list[last] = { ...e, out: p.out || {} }; save(list); } return; } // mismo día: se actualiza
    if (day - p.day < 7 && p.v === e.v) return; // misma semana y mismo veredicto: no se repite
  }
  list.push(e); save(list);
}

// Busca el cierre del día de la anotación (o el anterior) y el de N sesiones después
function idxAtDay(series, day) {
  let lo = 0, hi = series.t.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (Math.floor(series.t[mid] / 86400) <= day) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

// Completa los resultados que ya se pueden medir. Devuelve cuántas anotaciones se actualizaron.
export async function journalEvaluate() {
  const list = journalEntries();
  const today = Math.floor(Date.now() / 86400000);
  const due = list.filter((e) => HORIZONS.some((h) => e.out?.[h] == null && today - e.day >= Math.ceil(h * 1.4)));
  if (!due.length) return 0;
  let bench = null;
  try { bench = await getSeries(BENCH); } catch (err) { /* sin referencia */ }
  const bySym = new Map();
  let changed = 0;
  for (const e of due) {
    let s = bySym.get(e.sym);
    if (s === undefined) { try { s = await getSeries(e.sym); } catch (err) { s = null; } bySym.set(e.sym, s); }
    if (!s) continue;
    const i0 = idxAtDay(s, e.day);
    if (i0 < 0) continue;
    e.out ||= {};
    for (const h of HORIZONS) {
      if (e.out[h] != null || i0 + h >= s.c.length) continue;
      const p0 = s.c[i0], path = s.c.slice(i0 + 1, i0 + h + 1);
      const r = s.c[i0 + h] / p0 - 1;
      let m = null;
      if (bench) { const j0 = idxAtDay(bench, e.day), j1 = idxAtDay(bench, Math.floor(s.t[i0 + h] / 86400)); if (j0 >= 0 && j1 > j0) m = bench.c[j1] / bench.c[j0] - 1; }
      // los niveles se guardaron en precios de ese día; se escalan por si el cierre ajustado cambió
      const k = p0 / e.price;
      e.out[h] = { r: +r.toFixed(5), m: m == null ? null : +m.toFixed(5), min: +(Math.min(...path) / p0 - 1).toFixed(5), max: +(Math.max(...path) / p0 - 1).toFixed(5),
        stopHit: Math.min(...path) <= e.stop * k, targetHit: Math.max(...path) >= e.target * k, at: Date.now() };
      changed++;
    }
  }
  if (changed) {
    const byId = new Map(due.map((e) => [e.id, e]));
    save(list.map((x) => byId.get(x.id) || x));
  }
  return changed;
}

const ORDER = ["buy", "accumulate", "hold", "reduce", "sell"];
const LABELS = { buy: "Comprar", accumulate: "Comprar de a poco", hold: "Esperar", reduce: "Vender una parte", sell: "Vender" };
// Marcador: por veredicto y horizonte; y cuánto habría dado seguir los planes de compra ($1.000.000 por idea)
export function journalSummary(list, roundTripOf = () => 0) {
  const rows = {};
  for (const h of HORIZONS) {
    rows[h] = ORDER.map((k) => {
      const ev = list.filter((e) => e.v === k && e.out?.[h]);
      if (!ev.length) return { key: k, label: LABELS[k], n: 0 };
      const rs = ev.map((e) => e.out[h].r), ex = ev.filter((e) => e.out[h].m != null).map((e) => e.out[h].r - e.out[h].m);
      return { key: k, label: LABELS[k], n: ev.length, hit: rs.filter((r) => r > 0).length / rs.length, mean: rs.reduce((a, b) => a + b, 0) / rs.length,
        excess: ex.length ? ex.reduce((a, b) => a + b, 0) / ex.length : null, beat: ex.length ? ex.filter((x) => x > 0).length / ex.length : null };
    });
  }
  // seguir los planes: comprar en "Comprar"/"Comprar de a poco", salir en el límite de pérdida si se tocó, si no a los 3 meses; con costos
  const buys = list.filter((e) => (e.v === "buy" || e.v === "accumulate") && e.out?.[63]);
  let pl = 0, wins = 0, plBench = 0;
  for (const e of buys) {
    const o = e.out[63], stopRet = e.stop / e.price - 1;
    const r = o.stopHit ? stopRet : o.r;
    const net = (1 + r) * (1 - roundTripOf(e)) - 1;
    pl += 1e6 * net; if (net > 0) wins++;
    if (o.m != null) plBench += 1e6 * o.m;
  }
  const pending = list.filter((e) => HORIZONS.some((h) => !e.out?.[h]));
  const nextDay = pending.length ? Math.min(...pending.map((e) => e.day + Math.ceil(21 * 1.4))) : null;
  return { rows, plan: { n: buys.length, pl, wins, plBench }, total: list.length, assets: new Set(list.map((e) => e.sym)).size,
    since: list.length ? Math.min(...list.map((e) => e.day)) : null, nextDay, evaluated: list.filter((e) => e.out?.[21]).length };
}
