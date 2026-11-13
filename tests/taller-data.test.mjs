// Verifica js/taller-data.js: CSV, calidad de datos, ventanas 504/252, sectores y exportación ZIP (validada con Python).
// Uso: node tests/taller-data.test.mjs
import { writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseCSV, dedupe, qualityReport, ventanas, fechasVentanas, tablaSectores, toCSV, crc32, buildZip, cargarPrecios } from "../js/taller-data.js";

let ok = 0, fallos = 0;
const igual = (n, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) ok++; else { fallos++; console.log(`  ✗ ${n}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); } };
const casi = (n, a, b, tol) => { if (Math.abs(a - b) <= tol) ok++; else { fallos++; console.log(`  ✗ ${n}: ${a} vs ${b}`); } };
const lanza = async (n, f, pat) => { try { await f(); fallos++; console.log(`  ✗ ${n}: no lanzó error`); } catch (e) { if (pat.test(e.message)) ok++; else { fallos++; console.log(`  ✗ ${n}: ${e.message}`); } } };
const D = (iso) => Date.UTC(...iso.split("-").map((v, i) => (i === 1 ? +v - 1 : +v))) / 1000;

console.log("1) CSV");
const a = parseCSV("Date,AAA,bbb\n2026-01-02,100,50\n2026-01-05,101.5,\n2026-01-06,102,51\n");
igual("tickers en mayúscula", a.tickers, ["AAA", "BBB"]); igual("AAA: 3 precios", a.series.AAA.c, [100, 101.5, 102]); igual("BBB: salta el vacío", a.series.BBB.c, [50, 51]);
const b = parseCSV("Fecha;AAA;BBB\n02/01/2026;100,5;50,25\n05/01/2026;101,5;50,75\n06/01/2026;102;51\n");
igual("punto y coma + coma decimal", b.series.AAA.c, [100.5, 101.5, 102]); casi("fecha dd/mm/aaaa", b.series.AAA.t[0], D("2026-01-02"), 0);
igual("BOM al inicio", parseCSV("﻿d,X\n2026-01-01,1\n2026-01-02,2\n").series.X.c, [1, 2]);
await lanza("sin filas de datos", () => parseCSV("Date,AAA\n"), /encabezado/);
await lanza("una sola columna", () => parseCSV("Date\n2026-01-01\n2026-01-02\n"), /dos columnas/);
await lanza("tickers repetidos", () => parseCSV("Date,AAA,AAA\n2026-01-01,1,1\n2026-01-02,2,2\n"), /repetidos/);
await lanza("fechas ilegibles", () => parseCSV("Date,AAA\nhola,1\nmundo,2\nfoo,3\n"), /fechas/);

console.log("2) Calidad: duplicados, sesiones comunes y descartes");
const d1 = dedupe([D("2026-01-02"), D("2026-01-02"), D("2026-01-05")], [10, 11, 12]);
igual("duplicado: se cuenta y manda la última fila", [d1.duplicados, d1.valores], [1, [11, 12]]);
const S1 = { sym: "AAA", t: [D("2026-01-02"), D("2026-01-05"), D("2026-01-06"), D("2026-01-06"), D("2026-01-07")], adj: [10, 11, 12, 12.5, 13] };
const S2 = { sym: "BBB", t: [D("2026-01-02"), D("2026-01-06"), D("2026-01-07"), D("2026-01-08")], adj: [20, 21, 0, 23] };
const q = qualityReport([S1, S2]);
igual("filas descargadas", q.info.filas_descargadas, 9); igual("fechas duplicadas", q.info.duplicados, 1);
igual("sesiones comunes (se excluye el precio 0 y los huecos)", q.info.sesiones_comunes, 2);
igual("fechas descartadas", q.info.fechas_descartadas, ["2026-01-05", "2026-01-07", "2026-01-08"]); igual("sesiones descartadas", q.info.sesiones_descartadas, 3);
igual("tabla: BBB tiene 1 no positivo", q.tabla[1].no_positivos, 1); igual("tabla: primera y última de AAA", [q.tabla[0].primera, q.tabla[0].ultima], ["2026-01-02", "2026-01-07"]);
casi("tabla: % faltantes de AAA (1 de 5)", q.tabla[0].pct_faltantes, 20, 1e-9);

console.log("3) Ventanas 504 / 252");
igual("completa", ventanas(756), { nTrain: 504, nTest: 252, usados: 756, reducido: false, mensaje: "" });
igual("de sobra: se usan los últimos 756", ventanas(900).usados, 756);
const red = ventanas(751); igual("reducido: 499 + 252", [red.nTrain, red.nTest, red.reducido], [499, 252, true]); igual("el aviso explica el modo reducido", /Modo reducido/.test(red.mensaje), true);
await lanza("menos de 504 retornos", () => ventanas(400), /al menos 504/);
const dias = Array.from({ length: 757 }, (_, i) => 20000 + i), fv = fechasVentanas(dias, ventanas(756));
igual("la prueba termina en la última fecha", fv.prueba[1], new Date((20000 + 756) * 86400000).toISOString().slice(0, 10));
igual("entrenamiento y prueba son contiguos", new Date(fv.prueba[0]).getTime() - new Date(fv.entrenamiento[1]).getTime(), 86400000);

console.log("4) Sectores corregibles");
const st = tablaSectores(["AAA", "BBB", "CCC", "DDD"], { BBB: "Energía", CCC: "Tecnología" }, { AAA: "Technology", CCC: "Technology" }, { AAA: "Tecnología", BBB: "Salud", DDD: "Financiero" }, "2026-11-12 20:00");
igual("Yahoo manda sobre el mapa (y se traduce al español)", [st[0].sector, st[0].fuente], ["Tecnología", "Yahoo Finance"]);
igual("el usuario manda y queda como corrección manual", [st[1].sector, st[1].fuente, st[1].correccion_manual], ["Energía", "Usuario", true]);
igual("igual al de referencia no es corrección", st[2].correccion_manual, false);
igual("mapa de Horizon cuando Yahoo no responde", [st[3].sector, st[3].fuente], ["Financiero", "Mapa de Horizon"]);
igual("sin ningún dato", tablaSectores(["ZZZ"])[0].sector, "Sin clasificar");

console.log("5) Cargas con error claro");
await lanza("CSV sin procedencia", () => cargarPrecios({ tickers: ["AAA"], fuente: "csv", csvAjustado: "d,AAA\n2026-01-01,1\n2026-01-02,2\n" }), /procedencia/);
await lanza("CSV sin archivo", () => cargarPrecios({ tickers: ["AAA"], fuente: "csv", procedencia: "x" }), /CSV de precios ajustados/);
await lanza("CSV sin una columna", () => cargarPrecios({ tickers: ["AAA", "ZZZ"], fuente: "csv", csvAjustado: "d,AAA\n2026-01-01,1\n2026-01-02,2\n", procedencia: "Bloomberg 10/11/2026" }), /ZZZ/);
const csvOk = await cargarPrecios({ tickers: ["AAA"], fuente: "csv", csvAjustado: "d,AAA\n2026-01-01,10\n2026-01-02,11\n", csvSinAjustar: "d,AAA\n2026-01-01,12\n2026-01-02,13\n", procedencia: "Bloomberg 10/11/2026" });
igual("CSV con sin ajustar: usa esos cierres", csvOk.series[0].close, [12, 13]); igual("registra la procedencia", /Bloomberg/.test(csvOk.meta.fuente), true);
await lanza("fuente desconocida", () => cargarPrecios({ tickers: ["A"], fuente: "x" }), /desconocida/);

console.log("6) Exportación: CSV y ZIP");
const csv = toCSV([{ a: 1, b: 'tiene "comillas", y coma', c: NaN }, { a: 2.5, b: "ñandú", c: null }], ["a", "b", "c"]);
igual("CSV: comillas escapadas", csv.includes('"tiene ""comillas"", y coma"'), true); igual("CSV: NaN y null quedan vacíos", csv.split("\r\n")[1].endsWith(","), true);
igual("CRC32 de '123456789' (valor estándar)", crc32(new TextEncoder().encode("123456789")), 0xCBF43926);
const zip = buildZip([{ name: "resumen.txt", data: "Taller: parámetros y semilla\nñ á é" }, { name: "datos/tabla.csv", data: csv }]);
const tmp = new URL("./fixtures/_tmp.zip", import.meta.url);
writeFileSync(tmp, zip);
const py = `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(z.namelist()); print(z.read('resumen.txt').decode('utf-8').replace('\\n','|')); print(len(z.read('datos/tabla.csv')))`;
const sal = execFileSync("python", ["-X", "utf8", "-I", "-c", py, tmp.pathname.replace(/^\/([A-Za-z]:)/, "$1")], { encoding: "utf8" }).split(/\r?\n/);
unlinkSync(tmp);
igual("Python abre el ZIP y los nombres coinciden", sal[0], "['resumen.txt', 'datos/tabla.csv']"); igual("el contenido UTF-8 se conserva", sal[1], "Taller: parámetros y semilla|ñ á é"); igual("el tamaño del CSV coincide", +sal[2], new TextEncoder().encode(csv).length);

console.log(`\nDatos del taller: ${ok} comprobaciones correctas, ${fallos} fallos`);
if (fallos) process.exit(1);
console.log("Datos del taller: todo en orden");
