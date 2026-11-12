# Formato numérico en español para los textos de los modelos y precios diminutos. Se ejecuta una sola vez.
import os
import re

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.chdir(ROOT)


def rd(p):
    return open(p, encoding="utf-8").read()


def wr(p, s):
    open(p, "w", encoding="utf-8").write(s)


# 1) util.js: formateadores comunes
u = rd("js/util.js")
assert "export const nf =" not in u
u = u.rstrip() + '''

// ---- formato en español (coma decimal) para textos de modelos y precios ----
export const nf = (x, d = 2) => (x == null || !isFinite(x) ? "—" : x.toFixed(d).replace(".", ","));
// Precio: los decimales dependen de la magnitud (SHIB-USD = 0,00000890; BRK-A = 882.360)
export const fmtPriceNum = (x) => {
  if (x == null || !isFinite(x)) return "—";
  const a = Math.abs(x);
  const d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : a === 0 ? 2 : Math.min(10, Math.max(4, 2 - Math.floor(Math.log10(a))));
  return x.toLocaleString("es-CO", { minimumFractionDigits: d, maximumFractionDigits: d });
};
// Etiquetas de eje: igual, sin ceros finales (0,000006 en vez de 0,00000600) para que quepan
export const fmtAxisNum = (x) => {
  const s = fmtPriceNum(x);
  return Math.abs(x) < 1 && s.includes(",") ? s.replace(/0+$/, "").replace(/,$/, ",0") : s;
};
'''
wr("js/util.js", u)

# 2) charts.js: usa el formateador común
c = rd("js/charts.js")
c = c.replace('import { normPdf } from "./util.js";', 'import { normPdf, fmtPriceNum, fmtAxisNum } from "./util.js";')
i = c.index("export const fmtPrice = (x) => {")
j = c.index("};\n", i) + 3
c = c[:i] + "export const fmtPrice = fmtPriceNum;\n" + c[j:]
assert c.count("yFmt: fmtPrice") == 2
c = c.replace("yFmt: fmtPrice", "yFmt: fmtAxisNum")
wr("js/charts.js", c)

# 3) modelos: precios con fmtPriceNum; el resto de .toFixed(n) con coma decimal
price_fixes = {
    "js/models/merton.js": [("${q(0.1).toFixed(2)} – ${q(0.9).toFixed(2)}", "${fp(q(0.1))} – ${fp(q(0.9))}")],
    "js/models/meanreversion.js": [("${target.toFixed(2)}", "${fp(target)}")],
    "js/models/realoptions.js": [
        ("${priceBuy.toFixed(2)}. Piso de protección: ${stop.toFixed(2)}", "${fp(priceBuy)}. Piso de protección: ${fp(stop)}"),
        ("${V0.toFixed(2)} frente a un costo de ${I.toFixed(2)}", "${fp(V0)} frente a un costo de ${fp(I)}"),
        ("en o bajo ${priceBuy.toFixed(2)}", "en o bajo ${fp(priceBuy)}"),
    ],
}
rx = re.compile(r"(\([^()]*\)|[\w.]+(?:\([^()]*\))?)\.toFixed\((\d)\)")
for p in ["js/models/merton.js", "js/models/meanreversion.js", "js/models/realoptions.js", "js/models/vasicek.js", "js/models/herding.js", "js/models/ensemble.js"]:
    s = rd(p)
    for a, b in price_fixes.get(p, []):
        assert s.count(a) == 1, (p, a)
        s = s.replace(a, b)
    s, n = rx.subn(lambda m: f"nf({m.group(1)}, {m.group(2)})", s)
    need = ["nf"] + (["fmtPriceNum as fp"] if p in price_fixes else [])
    m = re.search(r'import \{([^}]*)\} from "\.\./util\.js";', s)
    if m:
        s = s.replace(m.group(0), "import {" + m.group(1).rstrip() + ", " + ", ".join(need) + ' } from "../util.js";', 1)
    else:
        s = s.replace("\nimport ", '\nimport { ' + ", ".join(need) + ' } from "../util.js";\nimport ', 1)
    wr(p, s)
    print(p, "toFixed->nf:", n)
print("ok")
