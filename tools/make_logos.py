# Genera los logos de la app a partir de los dos PNG entregados (modo oscuro = ícono azul, modo claro = símbolo azul sobre transparente).
import glob
import os
import shutil

from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.chdir(ROOT)
DL = os.path.join(os.path.expanduser("~"), "Downloads")
f1 = [p for p in glob.glob(os.path.join(DL, "Curva de crecimiento minimalista-1.png"))][0]
f2 = [p for p in glob.glob(os.path.join(DL, "*cono azul de barras ascendentes.png"))][0]
os.makedirs("icons/originales", exist_ok=True)
shutil.copy(f1, "icons/originales/icono-azul.png")
shutil.copy(f2, "icons/originales/logo-azul-sobre-blanco.png")

# 1) Ícono de app: fondo azul completo, símbolo blanco (iOS le aplica sus esquinas)
ic = Image.open(f1).convert("RGB")
side = min(ic.size)
ic = ic.crop(((ic.width - side) // 2, (ic.height - side) // 2, (ic.width + side) // 2, (ic.height + side) // 2))
for n, name in [(180, "apple-touch-icon"), (192, "icon-192"), (512, "icon-512"), (32, "favicon-32")]:
    ic.resize((n, n), Image.LANCZOS).save(f"icons/{name}.png", optimize=True)

# Barra superior (modo oscuro): mismo ícono recortado más cerca del dibujo para que el símbolo se lea a 30 px
cx, cy, half = ic.width * 0.5, ic.height * 0.49, ic.width * 0.40
ic.crop((round(cx - half), round(cy - half), round(cx + half), round(cy + half))).resize((128, 128), Image.LANCZOS).save("icons/logo-dark.png", optimize=True)

# 2) Modo claro: el símbolo azul sobre blanco pasa a azul sobre transparente (alfa a partir del canal rojo; el azul es (0,122,255))
sy = Image.open(f2).convert("RGB")
r = sy.split()[0]
alpha = r.point(lambda v: max(0, min(255, round((255 - v) * 255 / 255))))
out = Image.new("RGBA", sy.size, (0, 122, 255, 0))
out.putalpha(alpha)
# Mismo recorte que el ícono oscuro: el dibujo queda exactamente del mismo tamaño y en el mismo lugar en ambos temas
box = (round(cx - half), round(cy - half), round(cx + half), round(cy + half))
out = out.crop(box).resize((128, 128), Image.LANCZOS)
out.save("icons/logo-light.png", optimize=True)
print("logos listos; ambos", out.size)
for n in sorted(os.listdir("icons")):
    p = os.path.join("icons", n)
    if os.path.isfile(p):
        print(" ", n, os.path.getsize(p) // 1024, "KB")
