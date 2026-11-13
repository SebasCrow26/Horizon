// Servidor local para probar: sirve la carpeta y reenvía /yahoo/* a Yahoo (igual que Netlify).
// Uso: node tools/dev-server.mjs [puerto]
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const port = Number(process.argv[2] || 8765);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

// Yahoo exige una "credencial" (cookie + crumb) para opciones y perfil: se obtiene aquí, igual que hace el Worker de Cloudflare.
let crumbState = { cookie: "", crumb: "", at: 0 };
async function getCrumb(force = false) {
  if (!force && crumbState.crumb && Date.now() - crumbState.at < 25 * 60e3) return crumbState;
  let ultimo = null;
  for (let k = 0; k < 4; k++) { // el apretón de manos de Yahoo falla de vez en cuando: se reintenta
    try {
      const r1 = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA }, redirect: "manual" });
      const sc = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [r1.headers.get("set-cookie")].filter(Boolean);
      const cookie = sc.map((c) => c.split(";")[0]).join("; ");
      const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: cookie } });
      const crumb = (await r2.text()).trim();
      if (!crumb || crumb.includes("<") || crumb.length > 40) throw new Error("credencial inválida");
      crumbState = { cookie, crumb, at: Date.now() };
      return crumbState;
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
  return fetch(buildUrl(crumbState.crumb), { headers: { "User-Agent": UA, Accept: "application/json", Cookie: crumbState.cookie } });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  try {
    let target = null;
    if (u.pathname.startsWith("/yahoo/chart/")) target = "https://query1.finance.yahoo.com/v8/finance/chart/" + u.pathname.slice("/yahoo/chart/".length) + u.search;
    else if (u.pathname === "/yahoo/search") target = "https://query1.finance.yahoo.com/v1/finance/search" + u.search;
    else if (u.pathname === "/yahoo/spark") target = "https://query1.finance.yahoo.com/v8/finance/spark" + u.search;
    else if (u.pathname === "/yahoo/screener") target = "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved" + u.search;
    if (u.pathname === "/yahoo/options") {
      const sym = u.searchParams.get("symbol") || "", date = u.searchParams.get("date");
      const up = await yahooAuthed((c) => `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(sym)}?crumb=${encodeURIComponent(c)}${date ? "&date=" + encodeURIComponent(date) : ""}`);
      res.writeHead(up.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(Buffer.from(await up.arrayBuffer()));
    }
    if (u.pathname === "/yahoo/sector") {
      const sym = u.searchParams.get("symbol") || "";
      const up = await yahooAuthed((c) => `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=assetProfile&crumb=${encodeURIComponent(c)}`);
      const j = await up.json().catch(() => null), ap = j?.quoteSummary?.result?.[0]?.assetProfile;
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ sector: ap?.sector || null, industry: ap?.industry || null }));
    }
    if (target) {
      const up = await fetch(target, { headers: { "User-Agent": UA, Accept: "application/json" } });
      res.writeHead(up.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(Buffer.from(await up.arrayBuffer()));
    }
    let p = normalize(decodeURIComponent(u.pathname)).replace(/^[/\\]+/, "");
    if (!p || p.endsWith("/")) p += "index.html";
    const file = join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  } catch (e) {
    if (u.pathname.startsWith("/yahoo/")) { console.error("Error en", u.pathname, "→", e?.message || e, e?.cause?.message || ""); res.writeHead(502, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: String(e?.message || e), detalle: String(e?.cause?.message || "") })); }
    res.writeHead(404, { "Content-Type": "text/plain" }); res.end("No encontrado");
  }
}).listen(port, "127.0.0.1", () => console.log(`http://localhost:${port}`));
