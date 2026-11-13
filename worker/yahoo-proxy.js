// Cloudflare Worker: proxy mínimo hacia Yahoo Finance con CORS y caché de 10 minutos.
// Cómo usarlo (2 minutos, sin instalar nada):
//   1. dash.cloudflare.com → Workers & Pages → Create → "Hello World" → Deploy → Edit code.
//   2. Borra el contenido, pega este archivo completo y pulsa Deploy.
//   3. Copia la dirección (https://xxxx.workers.dev) en config.js → PROXY_URL.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" };

// Yahoo exige una "credencial" (cookie + crumb) para opciones y perfil. Se obtiene con dos llamadas y se reutiliza ~25 min.
let CRUMB = { cookie: "", crumb: "", at: 0 };
async function getCrumb(force) {
  if (!force && CRUMB.crumb && Date.now() - CRUMB.at < 25 * 60e3) return CRUMB;
  let ultimo = null;
  for (let k = 0; k < 4; k++) { // el apretón de manos de Yahoo falla de vez en cuando: se reintenta
    try {
      const r1 = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA }, redirect: "manual" });
      const sc = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [r1.headers.get("set-cookie")].filter(Boolean);
      const cookie = sc.map((c) => c.split(";")[0]).join("; ");
      const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: cookie } });
      const crumb = (await r2.text()).trim();
      if (!crumb || crumb.includes("<") || crumb.length > 40) throw new Error("credencial inválida");
      CRUMB = { cookie, crumb, at: Date.now() };
      return CRUMB;
    } catch (e) { ultimo = e; await new Promise((r) => setTimeout(r, 400 * (k + 1))); }
  }
  throw new Error("No se pudo obtener la credencial de Yahoo: " + (ultimo?.message || ultimo));
}
async function yahooAuthed(buildUrl) {
  for (let intento = 0; intento < 2; intento++) {
    const { cookie, crumb } = await getCrumb(intento > 0);
    const up = await fetch(buildUrl(crumb), { headers: { "User-Agent": UA, Accept: "application/json", Cookie: cookie } });
    if (up.status !== 401 && up.status !== 403) return up;
  }
  return fetch(buildUrl(CRUMB.crumb), { headers: { "User-Agent": UA, Accept: "application/json", Cookie: CRUMB.cookie } });
}
const jsonResp = (body, status = 200, maxAge = 0) => new Response(body, { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store" } });

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/options") {
        const sym = url.searchParams.get("symbol") || "", date = url.searchParams.get("date");
        const up = await yahooAuthed((c) => `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(sym)}?crumb=${encodeURIComponent(c)}${date ? "&date=" + encodeURIComponent(date) : ""}`);
        return jsonResp(await up.text(), up.status);
      }
      if (url.pathname === "/sector") {
        const sym = url.searchParams.get("symbol") || "";
        const up = await yahooAuthed((c) => `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=assetProfile&crumb=${encodeURIComponent(c)}`);
        const j = await up.json().catch(() => null), ap = j?.quoteSummary?.result?.[0]?.assetProfile;
        return jsonResp(JSON.stringify({ sector: ap?.sector || null, industry: ap?.industry || null }), 200, 86400);
      }
    } catch (e) { return jsonResp(JSON.stringify({ error: String(e.message || e) }), 502); }
    let target = null;
    if (url.pathname.startsWith("/chart/")) target = "https://query1.finance.yahoo.com/v8/finance/chart/" + url.pathname.slice(7) + url.search;
    else if (url.pathname === "/search") target = "https://query1.finance.yahoo.com/v1/finance/search" + url.search;
    else if (url.pathname === "/spark") target = "https://query1.finance.yahoo.com/v8/finance/spark" + url.search;
    else if (url.pathname === "/screener") target = "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved" + url.search;
    if (!target) return new Response("Proxy de Yahoo Finance activo", { headers: CORS });

    const cache = caches.default;
    const key = new Request(target);
    let res = await cache.match(key);
    if (!res) {
      const up = await fetch(target, { headers: { "User-Agent": UA, Accept: "application/json" } });
      res = new Response(up.body, up);
      if (up.ok) {
        res.headers.set("Cache-Control", "public, max-age=600");
        ctx.waitUntil(cache.put(key, res.clone()));
      }
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
    return out;
  },
};
