// Tono de los titulares de noticias con un diccionario financiero (en el espíritu de Loughran y McDonald, 2011):
// palabras que en finanzas suelen ser buenas o malas noticias. Corre en el navegador, sin claves ni servidores.
// Es una ayuda para leer el contexto, NO entra en el veredicto: no hay historial gratuito de noticias para probarlo.
const POS = [
  "beat", "beats", "tops", "topped", "surpass", "exceed", "record", "upgrade", "upgraded", "outperform", "raises", "raised", "raise guidance", "boost", "boosts",
  "surge", "surges", "soar", "soars", "jump", "jumps", "rally", "rallies", "gain", "gains", "climb", "climbs", "rebound", "rebounds", "rise", "rises", "rising",
  "strong", "stronger", "robust", "growth", "grows", "profit", "profitable", "win", "wins", "won", "approval", "approved", "breakthrough", "expands", "expansion",
  "buyback", "dividend hike", "partnership", "deal", "contract", "launch", "launches", "optimistic", "bullish", "upbeat", "accelerat", "momentum", "all-time high",
  "sube", "suben", "subió", "gana", "ganancia", "ganancias", "récord", "crece", "crecimiento", "dispara", "mejora", "alza", "repunta", "utilidad", "utilidades",
];
const NEG = [
  "miss", "misses", "missed", "downgrade", "downgraded", "underperform", "cut", "cuts", "lower guidance", "warns", "warning", "plunge", "plunges", "tumble", "tumbles",
  "sink", "sinks", "slump", "slumps", "drop", "drops", "fall", "falls", "fell", "decline", "declines", "slide", "slides", "crash", "sell-off", "selloff", "loss", "losses",
  "weak", "weaker", "lawsuit", "sued", "probe", "investigation", "fraud", "recall", "layoff", "layoffs", "bankruptcy", "default", "delay", "delays", "halt", "fine", "fined",
  "penalty", "risk", "risks", "concern", "concerns", "fear", "fears", "bearish", "pessimis", "downturn", "recession", "inflation", "tariff", "tariffs", "ban", "strike",
  "cae", "caen", "cayó", "pierde", "pérdida", "pérdidas", "baja", "desploma", "demanda", "multa", "investigación", "riesgo", "crisis", "recorte", "despidos", "quiebra",
];
const NEGATORS = /\b(not|no|never|without|fails? to|didn't|doesn't|won't|sin|nunca)\b/;

const norm = (s) => " " + String(s || "").toLowerCase().replace(/[“”"'’()[\],.:;!?]/g, " ").replace(/\s+/g, " ") + " ";
function hits(text, list) {
  let n = 0;
  const found = [];
  for (const w of list) {
    // prefijos como "accelerat" o "pessimis" se buscan al inicio de palabra; el resto, como palabra completa
    const re = w.endsWith("t") && w.length > 8 || w === "pessimis" ? new RegExp(`\\s${w}`) : new RegExp(`\\s${w.replace(/-/g, "\\-")}\\s`);
    if (re.test(text)) { n++; found.push(w); }
  }
  return { n, found };
}

// Devuelve { score ∈ [−1, 1], tone: "pos" | "neg" | "neu", words }
export function headlineTone(title) {
  const t = norm(title);
  let p = hits(t, POS), q = hits(t, NEG);
  let pn = p.n, nn = q.n;
  if (NEGATORS.test(t)) [pn, nn] = [nn * 0.5 + (pn ? 0 : 0), pn + nn * 0.5]; // "not beat" ≈ malo; "no losses" ≈ algo bueno
  const score = (pn - nn) / (pn + nn + 1);
  return { score, tone: score > 0.2 ? "pos" : score < -0.2 ? "neg" : "neu", words: [...p.found, ...q.found] };
}

// Resumen de varios titulares; los recientes pesan más (vida media de 3 días)
export function newsTone(items) {
  if (!items?.length) return null;
  const now = Date.now() / 1000;
  let sw = 0, s = 0, pos = 0, neg = 0;
  for (const it of items) {
    const h = it.tone || headlineTone(it.title);
    const w = it.time ? Math.pow(0.5, Math.max(0, now - it.time) / (3 * 86400)) : 0.5;
    sw += w; s += w * h.score;
    if (h.tone === "pos") pos++; else if (h.tone === "neg") neg++;
  }
  const score = sw ? s / sw : 0;
  const label = score > 0.12 ? "mayormente positivo" : score < -0.12 ? "mayormente negativo" : pos + neg === 0 ? "neutral" : "mixto";
  return { score, label, pos, neg, n: items.length, tone: score > 0.12 ? "pos" : score < -0.12 ? "neg" : "neu" };
}
