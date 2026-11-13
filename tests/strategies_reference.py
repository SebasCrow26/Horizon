"""
Referencia independiente en Python (numpy + scipy) para verificar js/strategies.js.
Genera precios sintéticos correlacionados (semilla fija), los guarda en tests/fixtures/strategies_prices.json y calcula las
estrategias fuera de muestra con las MISMAS reglas documentadas en js/strategies.js. Resultado: tests/fixtures/strategies_expected.json

Uso:  python -X utf8 -I tests/strategies_reference.py
Reglas (iguales en JS y Python):
  • Ventana: últimos 757 precios comunes = 756 retornos; entrenamiento = primeros 504; prueba = últimos 252.
  • Se rebalancea el día i0 = 504 (compra inicial) y, en las mensuales, el primer día de cada mes calendario dentro de la prueba.
  • En un rebalanceo del día t se estima con los 504 retornos conocidos hasta ese día: R[t-504 .. t-1]. Se opera al precio de t.
  • Costo = c · Σ|valor nuevo − valor actual| (c = pb/10.000), descontado del patrimonio (punto fijo). El efectivo gana r (continua, /252 por día).
  • Mínimo VaR = mínima varianza con 2 %–20 % por activo y límite por sector (los pesos óptimos de VaR normal y varianza coinciden).
"""
import datetime as dt
import json
import os

import numpy as np
from scipy.optimize import minimize

RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FIX = os.path.join(RAIZ, "tests", "fixtures")
os.makedirs(FIX, exist_ok=True)

TICKERS = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"]
SECTOR = ["Tec", "Tec", "Fin", "Fin", "Ene", "Ene", "Sal", "Sal"]
B, ALPHA, H, RF, COSTO_PB = 100000.0, 0.99, 10, 0.038, 10.0
WMIN, WMAX, LIM, VBAR = 0.02, 0.20, 0.25, 5000.0   # límite sectorial 25 %: sí aprieta con estos datos (sectores de 2 activos al tope 20 %)
N_TRAIN, N_TEST = 504, 252

# ---- precios sintéticos: GBM con factor común (correlación) y volatilidades distintas ----
rng = np.random.default_rng(20261112)
n, Tdias = len(TICKERS), 900
cargas = rng.uniform(0.4, 0.9, n)
vol = rng.uniform(0.15, 0.40, n) / np.sqrt(252)
mu = rng.uniform(0.02, 0.14, n) / 252
f = rng.standard_normal(Tdias)
eps = rng.standard_normal((Tdias, n))
ret = mu + vol * (cargas * f[:, None] + np.sqrt(1 - cargas ** 2) * eps)
P_all = 100 * np.exp(np.vstack([np.zeros(n), np.cumsum(ret, axis=0)]))   # 901 filas
# fechas: días hábiles consecutivos desde 2023-01-02 (número de día desde 1970)
d0 = dt.date(2023, 1, 2)
dias, d = [], d0
while len(dias) < P_all.shape[0]:
    if d.weekday() < 5:
        dias.append((d - dt.date(1970, 1, 1)).days)
    d += dt.timedelta(days=1)
json.dump({"tickers": TICKERS, "sector": SECTOR, "dias": dias, "precios": P_all.round(8).tolist()},
          open(os.path.join(FIX, "strategies_prices.json"), "w"))
P_all = np.array(json.load(open(os.path.join(FIX, "strategies_prices.json")))["precios"])  # exactamente lo que verá JS

# ---- ventana de 757 precios ----
P = P_all[-(N_TRAIN + N_TEST + 1):]
D_ = dias[-(N_TRAIN + N_TEST + 1):]
R = P[1:] / P[:-1] - 1.0


def mes(dia):
    f_ = dt.date(1970, 1, 1) + dt.timedelta(days=int(dia))
    return f_.year * 12 + f_.month


idx_sector = {}
for i, s in enumerate(SECTOR):
    idx_sector.setdefault(s, []).append(i)
GRUPOS = [(LIM, idx) for idx in idx_sector.values()]


def minvar(Sigma):
    cons = [{"type": "eq", "fun": lambda w: w.sum() - 1.0, "jac": lambda w: np.ones(n)}]
    for lim, idx in GRUPOS:
        cons.append({"type": "ineq", "fun": lambda w, idx=idx, lim=lim: lim - w[idx].sum()})
    esc = 1e4
    r = minimize(lambda w: esc * (w @ Sigma @ w), np.full(n, 1.0 / n), jac=lambda w: esc * 2 * (Sigma @ w),
                 bounds=[(WMIN, WMAX)] * n, constraints=cons, method="SLSQP", options={"ftol": 1e-16, "maxiter": 2000})
    return r.x


def var_hist_activo(Rw, i, h, alpha):
    perd = []
    for t in range(0, len(Rw) - h + 1):
        perd.append(-(np.prod(1.0 + Rw[t:t + h, i]) - 1.0))
    return float(np.quantile(perd, alpha, method="inverted_cdf"))


from scipy.stats import norm
Z = norm.ppf(ALPHA)


def objetivo(estrategia, t, V):
    Rw = R[t - N_TRAIN:t]
    if estrategia == "iguales":
        return np.full(n, 1.0 / n)
    if estrategia == "inverso":
        v = np.array([var_hist_activo(Rw, i, H, ALPHA) for i in range(n)])
        w = 1.0 / v
        return w / w.sum()
    w = minvar(np.cov(Rw, rowvar=False, ddof=1))
    if estrategia in ("minvar_estatica", "minvar_mensual"):
        return w
    if estrategia == "presupuesto_mensual":
        S = np.cov(Rw, rowvar=False, ddof=1)
        var_full = V * Z * np.sqrt(H * w @ S @ w)
        f_ = min(1.0, VBAR / var_full)
        return f_ * w
    raise ValueError(estrategia)


def simular(estrategia, mensual):
    c = COSTO_PB / 1e4
    i0 = N_TRAIN
    unidades = np.zeros(n)
    efectivo = B
    W, log = [], []
    costo_total = rot_total = 0.0
    for t in range(i0, i0 + N_TEST + 1):
        if t > i0:
            efectivo *= np.exp(RF / 252)
        V = float(unidades @ P[t] + efectivo)
        reb = (t == i0) or (mensual and mes(D_[t]) != mes(D_[t - 1]))
        if reb:
            a = objetivo(estrategia, t, V)
            actual = unidades * P[t]
            costo = 0.0
            for _ in range(200):
                nuevo = a * (V - costo)
                nc = c * float(np.abs(nuevo - actual).sum())
                if abs(nc - costo) < 1e-13:
                    costo = nc
                    break
                costo = nc
            nuevo = a * (V - costo)
            rot_total += float(np.abs(nuevo - actual).sum())
            costo_total += costo
            unidades = nuevo / P[t]
            efectivo = (V - costo) - float(nuevo.sum())
            V = float(unidades @ P[t] + efectivo)
            log.append({"t": t, "costo": costo, "efectivo": efectivo, "f": float(a.sum())})
        W.append(V)
    W = np.array(W)
    d_ = W[1:] / W[:-1] - 1
    pico = np.maximum.accumulate(W)
    rf_d = np.exp(RF / 252) - 1
    return {"W": W.tolist(), "retorno": float(W[-1] / B - 1), "vol": float(d_.std(ddof=1) * np.sqrt(252)),
            "sharpe": float((d_.mean() - rf_d) / d_.std(ddof=1) * np.sqrt(252)),
            "maxDD": float(((pico - W) / pico).max()), "costo": costo_total, "rotacion": rot_total / B,
            "rebalanceos": len(log), "efectivoFinal": float(efectivo), "fUltimo": log[-1]["f"]}


salida = {"params": {"B": B, "alpha": ALPHA, "h": H, "r": RF, "costoPb": COSTO_PB, "wmin": WMIN, "wmax": WMAX, "lim": LIM, "vbar": VBAR},
          "gruposSector": [{"limit": lim, "idx": idx} for lim, idx in GRUPOS], "estrategias": {}}
for nombre, mensual in [("iguales", False), ("inverso", False), ("minvar_estatica", False), ("minvar_mensual", True), ("presupuesto_mensual", True)]:
    salida["estrategias"][nombre] = simular(nombre, mensual)
# entero de acciones (compra inicial con mínimo VaR estático)
w0 = objetivo("minvar_estatica", N_TRAIN, B)
S0 = P[N_TRAIN]
cant = np.floor(B * w0 / S0)
inv = float((cant * S0).sum())
salida["enteras"] = {"w": w0.tolist(), "S0": S0.tolist(), "cantidades": cant.tolist(), "invertido": inv, "residual": B - inv,
                     "pesosNuevos": ((cant * S0) / inv).tolist(),
                     "VaRNormal": float(inv * Z * np.sqrt(H * ((cant * S0) / inv) @ np.cov(R[:N_TRAIN], rowvar=False, ddof=1) @ ((cant * S0) / inv)))}
json.dump(salida, open(os.path.join(FIX, "strategies_expected.json"), "w"), indent=1)
for k, v in salida["estrategias"].items():
    print(f"{k:22s} retorno {v['retorno']*100:7.3f} %  vol {v['vol']*100:6.2f} %  maxDD {v['maxDD']*100:6.2f} %  costo {v['costo']:8.2f}  reb {v['rebalanceos']}")
