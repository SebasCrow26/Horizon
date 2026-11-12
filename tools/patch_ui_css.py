# Aplica las mejoras de diseño (Apple Design) al CSS y al HTML. Se ejecuta una sola vez.
import re, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.chdir(ROOT)


def patch(path, pairs):
    s = open(path, encoding="utf-8").read()
    for a, b in pairs:
        n = s.count(a)
        assert n == 1, (path, "esperaba 1 coincidencia y hay", n, a[:80])
        s = s.replace(a, b)
    open(path, "w", encoding="utf-8").write(s)


css = open("css/style.css", encoding="utf-8").read()


def conv_px(m):
    n = float(m.group(1))
    if n == 0:
        return "0"
    return (f"{n / 16:.4f}").rstrip("0").rstrip(".") + "rem"


def repl(m):
    prop, sp, val = m.group(1), m.group(2), m.group(3)
    return f"{prop}:{sp}{re.sub(r'(-?[0-9]+(?:[.][0-9]+)?)px', conv_px, val)}"


pat = re.compile(r"\b(font-size|padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|row-gap|column-gap|gap)\s*:(\s*)([^;}{]+)")
before = len(re.findall("px", css))
css = pat.sub(repl, css)
print("menciones de px:", before, "->", len(re.findall("px", css)))

old_rm = re.search(r"@media \(prefers-reduced-motion: reduce\) \{.*?\n\}\n", css, re.S)
assert old_rm, "bloque reduced-motion no encontrado"
css = css.replace(old_rm.group(0), "")

css += open(os.path.join("tools", "extra_ui.css"), encoding="utf-8").read()
open("css/style.css", "w", encoding="utf-8").write(css)

patch("index.html", [
    ('<a href="#/" data-r="home">Resumen</a>', '<a href="#/" data-r="home">Mi lista</a>'),
    ('<a href="#/metodo" data-r="metodo">Método</a>\n  </nav>', '<a href="#/metodo" data-r="metodo">Cómo decide</a>\n  </nav>'),
    ('<svg><use href="#i-home"/></svg>Resumen</a>', '<svg><use href="#i-home"/></svg>Mi lista</a>'),
    ('<svg><use href="#i-book"/></svg>Método</a>', '<svg><use href="#i-book"/></svg>Cómo decide</a>'),
    ('<header class="topbar glass">', '<div class="edge" aria-hidden="true"></div><div class="edge b" aria-hidden="true"></div>\n<header class="topbar glass">'),
])
print("css y html listos")
