# Horizon

Aplicación web para apoyar decisiones de inversión con datos de Yahoo Finance de mercados de todo el mundo.

- **Dirección (comprar / esperar / vender):** tendencia, con momentum de 12 meses frente a la canasta regional y fuerza relativa.
- **Precios y riesgo:** cinco modelos. Vasicek (tasas), saltos de Merton, reversión a la media, opciones reales y comportamiento en manada.
- **Plan posible:** compra por partes, límite de pérdida, zona de ganancia, costos y tamaño según el perfil.
- **Además:** portafolio, comparador, tono de noticias y la prueba completa con 10 años de datos (en «Cómo decide»).

Es una herramienta educativa, no asesoría financiera. La prueba con datos del pasado muestra que la ventaja frente al mercado es pequeña.

## Correr en local
```
node tools/dev-server.mjs 5188
```
Abrir http://localhost:5188/. Pruebas de los modelos: `node tests/models.test.mjs`.

## Datos
- `data/snapshot.json`: 3 años de precios (respaldo sin conexión). Se actualiza cada noche con GitHub Actions.
- `data/ideas.json`: ranking de Descubrir.
- `data/backtest_report.json`: resultados del backtest. Se actualizan el día 1 de cada mes.

Despliegue y actualización automática: ver `GUIA_Actualizacion_Automatica.md`.
