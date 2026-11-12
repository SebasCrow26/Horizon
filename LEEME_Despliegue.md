# Horizon · cómo desplegarlo (5 minutos)

La carpeta que se sube es **`Horizon_Deploy`** (o su `.zip`). Es una página estática: no necesita instalar nada.

## Opción A · Netlify (recomendada)

1. Entra a **app.netlify.com** → *Add new site* → *Deploy manually*.
2. Arrastra la carpeta `Horizon_Deploy` (o el zip). En unos segundos te da un link `https://algo.netlify.app`.
3. Ábrelo y mira arriba a la derecha:
   - **"Yahoo Finance · en vivo"** → todo funciona con datos del día. Listo.
   - **"Datos guardados · 11 nov"** → Yahoo no respondió desde el servidor de Netlify (a veces bloquea servidores en la nube). La app **sigue funcionando** con datos reales guardados de unos 100 activos. Si quieres datos en vivo, usa la Opción B.
4. Prueba rápida del proxy: abre `https://TU-SITIO.netlify.app/yahoo/chart/AAPL?range=1mo&interval=1d`. Si ves un texto largo que empieza con `{"chart":`, el modo en vivo funciona.

## Opción B · datos en vivo con un Worker de Cloudflare (gratis, sin instalar nada)

1. dash.cloudflare.com → *Workers & Pages* → *Create* → *Hello World* → *Deploy* → *Edit code*.
2. Borra todo, pega el contenido de **`yahoo-proxy.js`** (está en esta carpeta) y pulsa *Deploy*.
3. Copia la dirección que te da (`https://xxxx.workers.dev`).
4. Abre `config.js` dentro de `Horizon_Deploy`, pon esa dirección en `PROXY_URL` y vuelve a subir la carpeta a Netlify:
   ```js
   PROXY_URL: "https://xxxx.workers.dev",
   ```

## Si lo subes a Cloudflare Pages en vez de Netlify

*Workers & Pages* → *Create* → *Pages* → *Upload assets* → arrastra `Horizon_Deploy`. Cloudflare Pages no lee `netlify.toml`, así que para datos en vivo necesitas la Opción B (el Worker). Sin Worker funciona con los datos guardados.

## Para la presentación (plan de respaldo)

- Si el día de la presentación no hay internet o Yahoo falla, la app usa sola los datos guardados y lo indica arriba. No se rompe nada.
- Para forzar siempre los datos guardados, en `config.js` pon `FORCE_SNAPSHOT: true`.
- Puedes buscar **cualquier** símbolo de Yahoo (por ejemplo `AAPL`, `ECOPETROL.CL`, `7203.T`, `0700.HK`, `BTC-USD`). En modo guardado solo están los ~100 activos incluidos.

## Qué contiene

| Carpeta o archivo | Para qué sirve |
|---|---|
| `index.html`, `css/`, `js/` | La aplicación |
| `js/models/` | Los 5 modelos: Vasicek, saltos de Merton, opciones reales, manada y reversión a la media |
| `data/snapshot.json` | Datos reales guardados de Yahoo (11 de noviembre de 2026) |
| `netlify.toml` | Reenvía `/yahoo/*` a Yahoo Finance (modo en vivo en Netlify) |
| `config.js` | Dirección del Worker y modo demostración |
