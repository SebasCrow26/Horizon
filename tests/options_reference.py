"""
Referencia independiente en Python (numpy + scipy) para verificar js/options.js.
Genera una cadena de opciones sintética (tests/fixtures/options_chain.json) y calcula, con fórmulas cerradas y un árbol CRR propio,
lo que js/options.js debe reproducir. Salida: tests/fixtures/options_expected.json

Uso:  python -X utf8 -I tests/options_reference.py
"""
import json
import os

import numpy as np
from scipy.stats import norm

RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FIX = os.path.join(RAIZ, "tests", "fixtures")
os.makedirs(FIX, exist_ok=True)

S0, A_DRIFT, SIGMA, Q, R = 100.0, 0.10, 0.28, 0.01, 0.04
TIPO, ESTILO, N = "call", "americana", 200
COSTO_T, OI_MIN, SPREAD_MAX = 0.0, 100, 0.10


def crr(S, K, T, r, q, sigma, n, tipo, estilo):
    dt = T / n
    u = np.exp(sigma * np.sqrt(dt))
    d = 1.0 / u
    p = (np.exp((r - q) * dt) - d) / (u - d)
    assert 0 < p < 1
    disc = np.exp(-r * dt)
    j = np.arange(n + 1)
    ST = S * u ** j * d ** (n - j)
    pay = (lambda s: np.maximum(s - K, 0)) if tipo == "call" else (lambda s: np.maximum(K - s, 0))
    V = pay(ST)
    for i in range(n - 1, -1, -1):
        V = disc * (p * V[1:i + 2] + (1 - p) * V[0:i + 1])
        if estilo == "americana":
            Si = S * u ** np.arange(i + 1) * d ** (i - np.arange(i + 1))
            V = np.maximum(V, pay(Si))
    return float(V[0])


def bs(S, K, T, r, q, sigma, tipo):
    sd = sigma * np.sqrt(T)
    d1 = (np.log(S / K) + (r - q + sigma ** 2 / 2) * T) / sd
    d2 = d1 - sd
    if tipo == "call":
        return float(S * np.exp(-q * T) * norm.cdf(d1) - K * np.exp(-r * T) * norm.cdf(d2))
    return float(K * np.exp(-r * T) * norm.cdf(-d2) - S * np.exp(-q * T) * norm.cdf(-d1))


# ---- cadena sintética ----
rng = np.random.default_rng(7)
DIAS = [7, 14, 30, 45, 60, 91, 120, 182, 273]
STRIKES = [round(60 + 2.5 * k, 1) for k in range(37)]   # 60 … 150
expirations = []
for dias in DIAS:
    T = dias / 365
    filas = {"calls": [], "puts": []}
    for tipo, clave in (("call", "calls"), ("put", "puts")):
        for K in STRIKES:
            iv = 0.30 + 0.0006 * abs(K - 100)
            px = bs(S0, K, T, R, Q, iv, tipo)
            s = float(rng.uniform(0.02, 0.18))
            bid = px * (1 - s / 2) if px > 0.15 and rng.random() > 0.08 else 0.0
            ask = px * (1 + s / 2) if px > 0.05 else 0.05
            filas[clave].append({"contractSymbol": f"TST{dias:03d}{tipo[0].upper()}{int(K * 1000):08d}", "strike": K,
                                 "bid": round(bid, 4), "ask": round(ask, 4), "impliedVolatility": round(iv, 6),
                                 "openInterest": int(rng.integers(0, 2500)), "volume": int(rng.integers(0, 900))})
    expirations.append({"venc": f"2027-01-{(dias % 27) + 1:02d}", "dias": dias, **filas})
chain = {"hora": "2026-11-12T20:00:00Z", "nListadas": len(expirations), "expirations": expirations}
json.dump(chain, open(os.path.join(FIX, "options_chain.json"), "w"))
chain = json.load(open(os.path.join(FIX, "options_chain.json")))   # exactamente lo que verá JS


def valido(b, a):
    return b > 0 and a >= b


# ---- selección de plazos y strikes ----
usadas, plazos = set(), []
for nombre, obj in (("1 mes", 30), ("3 meses", 91), ("6 meses", 182)):
    cands = sorted([e for e in chain["expirations"] if e["dias"] >= 5 and e["venc"] not in usadas], key=lambda e: abs(e["dias"] - obj))
    if cands:
        usadas.add(cands[0]["venc"])
        plazos.append((nombre, cands[0]))

filas = []
for nombre, e in plazos:
    lista = e["calls"] if TIPO == "call" else e["puts"]
    T = e["dias"] / 365
    strikes = sorted({c["strike"] for c in lista})
    usados = set()
    for beta in (0.25, 0.5, 0.75):
        Qb = S0 * np.exp((A_DRIFT - SIGMA ** 2 / 2) * T + SIGMA * np.sqrt(T) * norm.ppf(beta))
        libres = sorted([k for k in strikes if k not in usados], key=lambda k: abs(k - Qb))
        K = libres[0]
        usados.add(K)
        c = next(x for x in lista if x["strike"] == K)
        bid, ask = c["bid"], c["ask"]
        us = valido(bid, ask)
        medio = (bid + ask) / 2 if us else None
        sd = SIGMA * np.sqrt(T)
        mu = (A_DRIFT - SIGMA ** 2 / 2) * T
        d1 = (np.log(S0 / K) + (A_DRIFT + SIGMA ** 2 / 2) * T) / sd
        d2 = d1 - sd
        z2 = (np.log(S0 / K) + mu) / sd            # (ln(S0/K) + (a − σ²/2)T) / (σ√T)
        pe = float(norm.cdf(z2)) if TIPO == "call" else float(norm.cdf(-z2))
        cap = ask * np.exp(R * T) + COSTO_T
        if us:
            if TIPO == "call":
                umbral = K + cap
                pb = float(norm.cdf((np.log(S0 / umbral) + mu) / sd))
                eg = float(S0 * np.exp(A_DRIFT * T) * norm.cdf(d1) - K * norm.cdf(d2) - cap)
            else:
                umbral = K - cap
                pb = float(norm.cdf((np.log(umbral / S0) - mu) / sd)) if umbral > 0 else 0.0
                eg = float(K * norm.cdf(-d2) - S0 * np.exp(A_DRIFT * T) * norm.cdf(-d1) - cap)
        else:
            pb = eg = None
        iv = c["impliedVolatility"]
        filas.append({"plazo": nombre, "vencimiento": e["venc"], "dias": e["dias"], "beta": beta, "cuantil": float(Qb), "strike": K,
                      "contrato": c["contractSymbol"], "bid": bid, "ask": ask, "medio": medio,
                      "spread_rel": ((ask - bid) / medio) if us else None, "oi": c["openInterest"], "usable": us,
                      "P_ejercicio": pe, "P_beneficio": pb, "E_ganancia": eg,
                      "V_CRR_hist": crr(S0, K, T, R, Q, SIGMA, N, TIPO, ESTILO), "V_CRR_iv": crr(S0, K, T, R, Q, iv, N, TIPO, ESTILO)})

elegibles = [(i, f) for i, f in enumerate(filas) if f["usable"] and f["oi"] >= OI_MIN and f["spread_rel"] <= SPREAD_MAX and f["E_ganancia"] > 0]
elegibles.sort(key=lambda x: -x[1]["P_beneficio"])

# ---- controles del árbol ----
par = dict(S=100.0, K=100.0, T=1.0, r=0.05, q=0.0, sigma=0.20)
ctrl = {"BS_call": bs(100, 100, 1, 0.05, 0, 0.2, "call"),
        "N500_call_eu": crr(100, 100, 1, 0.05, 0, 0.2, 500, "call", "europea"),
        "N500_put_eu": crr(100, 100, 1, 0.05, 0, 0.2, 500, "put", "europea"),
        "N500_put_am": crr(100, 100, 1, 0.05, 0, 0.2, 500, "put", "americana"),
        "N500_call_am": crr(100, 100, 1, 0.05, 0, 0.2, 500, "call", "americana"),
        "conv": {str(n_): crr(100, 100, 1, 0.05, 0, 0.2, n_, "call", "europea") for n_ in (10, 25, 50, 100, 200, 500, 1000)},
        "arbol3": {"call_am_q": crr(100, 95, 0.5, 0.05, 0.03, 0.3, 3, "call", "americana"), "put_am": crr(100, 105, 0.5, 0.05, 0.0, 0.3, 3, "put", "americana"),
                   "put_eu": crr(100, 105, 0.5, 0.05, 0.0, 0.3, 3, "put", "europea")},
        "bs_q": bs(100, 90, 0.75, 0.04, 0.02, 0.25, "put")}
salida = {"params": {"S0": S0, "a": A_DRIFT, "sigma": SIGMA, "q": Q, "r": R, "tipo": TIPO, "estilo": ESTILO, "N": N, "costoT": COSTO_T, "oiMin": OI_MIN, "spreadMax": SPREAD_MAX},
          "plazos": [{"plazo": n_, "venc": e["venc"], "dias": e["dias"]} for n_, e in plazos], "candidatos": filas,
          "elegido": elegibles[0][0] if elegibles else None, "elegibles": [i for i, _ in elegibles], "control": ctrl}
json.dump(salida, open(os.path.join(FIX, "options_expected.json"), "w"), indent=1)
print("opciones listas:", len(filas), "candidatos;", len(elegibles), "elegibles; elegido:", salida["elegido"], "| BS call de control:", round(ctrl["BS_call"], 4))
