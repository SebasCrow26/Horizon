// Cloudflare Worker: proxy mínimo hacia Yahoo Finance con CORS y caché de 10 minutos.
// Cómo usarlo (2 minutos, sin instalar nada):
//   1. dash.cloudflare.com → Workers & Pages → Create → "Hello World" → Deploy → Edit code.
//   2. Borra el contenido, pega este archivo completo y pulsa Deploy.
//   3. Copia la dirección (https://xxxx.workers.dev) en config.js → PROXY_URL.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" };

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
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
