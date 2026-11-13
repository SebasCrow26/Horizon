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
Abrir http://localhost:5188/ (el Taller está en `#/taller`). Pruebas de los modelos: `node tests/models.test.mjs`.

## Datos
- `data/snapshot.json`: 3 años de precios (respaldo sin conexión). Se actualiza cada noche con GitHub Actions.
- `data/ideas.json`: ranking de Descubrir.
- `data/backtest_report.json`: resultados del backtest. Se actualizan el día 1 de cada mes.

Despliegue y actualización automática: ver `GUIA_Actualizacion_Automatica.md`.

## Taller de riesgo (rama `integracion-riesgo`)
Pantalla **Taller** (`#/taller`): arma un portafolio de diez acciones de EE. UU. con el riesgo medido. Es una herramienta equivalente a la app de Streamlit del taller original: entradas editables, botón «Ejecutar análisis», seis pestañas (Datos · GBM · Opciones · Riesgo · Asignación · Evaluación) y descarga de un ZIP con los CSV, `resumen.json` (parámetros y semilla) y un LEEME. Corre en el navegador, sin Python ni servidor.

| Módulo | Qué hace |
|---|---|
| `js/taller-data.js` | Carga (Yahoo, datos guardados o CSV con procedencia), sesiones comunes, informe de calidad, partición 504/252, sectores corregibles, ZIP |
| `js/gbm.js` | Calibración (μ = 252·x̄ + σ²/2, â = μ − q), simulación con semilla, evaluación rolling (RMSE y MAPE frente al ingenuo) |
| `js/options.js` | Árbol CRR europeo/americano (verifica pQ ∈ (0,1)), Black–Scholes de control (10,4506), árbol de 3 pasos, convergencia, 3 vencimientos × 3 strikes por cuantiles, P(ejercicio), P(beneficio), prima frente a bid/ask |
| `js/risk.js` | VaR y ES (histórico, normal, Monte Carlo), estrés, excepciones + Kupiec, presupuesto de riesgo, mínimo VaR con límites por acción y sector |
| `js/strategies.js` | Cinco estrategias fuera de muestra con costos y rebalanceo mensual, montos y acciones enteras |
| `js/taller-run.js` | Orquesta todo y arma los archivos de resultados |
| `js/taller.js`, `js/tallercharts.js` | Pantalla y gráficos (SVG propio) |

**Pruebas** (cada motor se compara con una referencia independiente en Python, numpy y scipy):
```
python -X utf8 -I tests/risk_reference.py
python -X utf8 -I tests/strategies_reference.py
python -X utf8 -I tests/gbm_reference.py
python -X utf8 -I tests/options_reference.py
node tests/risk.test.mjs && node tests/strategies.test.mjs && node tests/gbm.test.mjs && node tests/options.test.mjs
node tests/taller-data.test.mjs && node tests/taller-run.test.mjs && node tests/models.test.mjs
```
**Cadena de opciones y sectores** vienen de Yahoo Finance con un «crumb» que solo se puede pedir desde un servidor: funcionan con `node tools/dev-server.mjs` y, en GitHub Pages, con `worker/yahoo-proxy.js` **redesplegado** (rutas `/options` y `/sector`). Sin eso, el Taller avisa y sigue sin opciones; nunca inventa precios.

**Límites que conviene decir en voz alta:** con «Datos guardados» solo hay 3 años y precio ajustado (modo reducido, 499 + 252 retornos); la evaluación rolling muestra que el GBM casi no mejora al pronóstico ingenuo; el resultado fuera de muestra es una sola ventana de un año; no hay promesa de rendimiento.

## Créditos
El diseño del análisis de riesgo (definiciones de VaR y ES, escenarios de estrés, excepciones con Kupiec, portafolio de mínimo VaR con límites por sector y presupuesto de riesgo) parte del **Taller de valoración y riesgo de Felipe Pulido** (Valoración de Activos, Universidad Externado de Colombia). El diseño visual del Taller (seis pestañas y su orden) también parte de ese taller. El código de Horizon es una implementación propia en JavaScript.

