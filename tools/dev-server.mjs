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

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  try {
    let target = null;
    if (u.pathname.startsWith("/yahoo/chart/")) target = "https://query1.finance.yahoo.com/v8/finance/chart/" + u.pathname.slice("/yahoo/chart/".length) + u.search;
    else if (u.pathname === "/yahoo/search") target = "https://query1.finance.yahoo.com/v1/finance/search" + u.search;
    else if (u.pathname === "/yahoo/spark") target = "https://query1.finance.yahoo.com/v8/finance/spark" + u.search;
    else if (u.pathname === "/yahoo/screener") target = "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved" + u.search;
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
    res.writeHead(404, { "Content-Type": "text/plain" }); res.end("No encontrado");
  }
}).listen(port, "127.0.0.1", () => console.log(`http://localhost:${port}`));
