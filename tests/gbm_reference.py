"""
Referencia independiente en Python (numpy + scipy) para verificar js/gbm.js.
Usa los precios sintéticos de tests/fixtures/strategies_prices.json (genéralos con tests/strategies_reference.py).
Salida: tests/fixtures/gbm_expected.json

Uso:  python -X utf8 -I tests/gbm_reference.py
"""
import json
import os

import numpy as np
from scipy.stats import norm

RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FIX = os.path.join(RAIZ, "tests", "fixtures")
X = json.load(open(os.path.join(FIX, "strategies_prices.json")))
P_all = np.array(X["precios"])
D = 252
P = P_all[-757:]
N_TRAIN = 504


def calibrar(precios, q=0.0):
    x = np.diff(np.log(precios))
    xbar = x.mean()
    s = x.std(ddof=1)
    sigma = np.sqrt(D) * s
    mu = D * xbar + sigma ** 2 / 2
    return {"n": len(x), "xbar": float(xbar), "s": float(s), "sigma": float(sigma), "muTotal": float(mu), "q": q, "a": float(mu - q)}


def rolling(serie, H, window=252, o0=504):
    M = len(serie) - 1
    f, nv, obs = [], [], []
    for t in range(o0, M - H + 1):
        mu = calibrar(serie[t - window:t + 1])["muTotal"]
        f.append(serie[t] * np.exp(mu * H / D))
        nv.append(serie[t])
        obs.append(serie[t + H])
    f, nv, obs = map(np.array, (f, nv, obs))
    rm = lambda p: float(np.sqrt(np.mean((p - obs) ** 2)))
    mp = lambda p: float(100 * np.mean(np.abs(p - obs) / obs))
    return {"H": H, "m": int(len(obs)), "RMSE": rm(f), "RMSE_ingenuo": rm(nv), "razon": rm(f) / rm(nv), "MAPE": mp(f), "MAPE_ingenuo": mp(nv)}


n = P.shape[1]
cal = [calibrar(P[:N_TRAIN + 1, i], q=0.01 * (i % 3)) for i in range(n)]
salida = {"calibracion": cal, "q": [0.01 * (i % 3) for i in range(n)], "rolling": {}}
for H in (1, 5, 10, 21):
    salida["rolling"][str(H)] = [rolling(P[:, i], H) for i in range(n)]

# dividendos: yield continuo con la suma de los últimos 12 meses
S0 = 100.0
divs = [{"t": 1700000000 - k * 90 * 86400, "amount": 0.5 + 0.1 * k} for k in range(6)]
asof = 1700000000
suma = sum(d["amount"] for d in divs if asof - 365 * 86400 < d["t"] <= asof)
salida["dividendos"] = {"divs": divs, "S0": S0, "asOf": asof, "suma12m": suma, "q": float(np.log1p(suma / S0))}

# simulación: valores teóricos exactos para comparar con la estadística de la simulación en JS
a, sg, steps = 0.08, 0.25, 126
T = steps / D
mu_ln, sd_ln = (a - sg ** 2 / 2) * T, sg * np.sqrt(T)
salida["teoria"] = {"S0": 100.0, "a": a, "sigma": sg, "steps": steps, "T": T,
                    "media": 100.0 * float(np.exp(a * T)),
                    "q10": 100.0 * float(np.exp(mu_ln + sd_ln * norm.ppf(0.10))),
                    "q50": 100.0 * float(np.exp(mu_ln)),
                    "q90": 100.0 * float(np.exp(mu_ln + sd_ln * norm.ppf(0.90)))}
json.dump(salida, open(os.path.join(FIX, "gbm_expected.json"), "w"), indent=1)
r = salida["rolling"]["1"][0]
print("calibración y rolling listos | activo 1, H=1: m =", r["m"], "RMSE GBM", round(r["RMSE"], 4), "ingenuo", round(r["RMSE_ingenuo"], 4))
