"""
Referencia independiente en Python (numpy + scipy) para verificar js/risk.js.
Definiciones basadas en el Taller de valoración y riesgo de Felipe Pulido.
Calcula con los mismos datos guardados (data/snapshot.json) las mismas cantidades y las deja en
tests/fixtures/risk_expected.json. tests/risk.test.mjs las compara contra la implementación en JavaScript.

Uso:  python -X utf8 -I tests/risk_reference.py
"""
import json
import os

import numpy as np
from scipy import stats
from scipy.optimize import minimize

RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
snap = json.load(open(os.path.join(RAIZ, "data", "snapshot.json"), encoding="utf-8"))

TICKERS = ["AAPL", "MSFT", "JPM", "XOM", "JNJ", "KO", "GLD", "TLT", "ISA.CL", "ECOPETROL.CL"]
SECTOR = {"AAPL": "Tecnología", "MSFT": "Tecnología", "JPM": "Financiero", "XOM": "Energía", "ECOPETROL.CL": "Energía",
          "JNJ": "Salud", "KO": "Consumo", "GLD": "Oro", "TLT": "Bonos", "ISA.CL": "Servicios públicos"}
B, ALPHA, H = 100000.0, 0.99, 10
WMIN, WMAX, LIM = 0.02, 0.20, 0.35
N_MC = 400000

# --- datos: solo sesiones comunes (sin rellenar huecos) ---
series = {}
for s in TICKERS:
    d = snap["series"][s]
    series[s] = {int(t): float(c) for t, c in zip(d["t"], d["c"]) if c is not None and c > 0}
dias = sorted(set.intersection(*[set(v) for v in series.values()]))
P = np.array([[series[s][d] for s in TICKERS] for d in dias])
R = P[1:] / P[:-1] - 1.0
X = np.log(P[1:] / P[:-1])
T, n = R.shape
Sigma = np.cov(R, rowvar=False, ddof=1)


def perdidas_bloque(w, h, paso=1):
    out = []
    for t in range(0, T - h + 1, paso):
        bloque = np.prod(1.0 + R[t:t + h], axis=0) - 1.0
        out.append(-B * float(w @ bloque))
    return np.array(out)


def var_es(perd, alpha):
    var = float(np.quantile(perd, alpha, method="inverted_cdf"))
    return var, float(perd[perd >= var].mean()), float(perd.max()), int((perd >= var).sum()), int((perd == var).sum())


def normal(w, h, alpha, S=Sigma):
    sd = float(np.sqrt(h * w @ S @ w))
    z = stats.norm.ppf(alpha)
    return B * z * sd, B * sd * stats.norm.pdf(z) / (1 - alpha)


def mc(w, h, alpha, nsim, seed=2026):
    m = X.mean(axis=0)
    L = np.linalg.cholesky(np.cov(X, rowvar=False, ddof=1))
    rng = np.random.default_rng(seed)
    eps = rng.standard_normal((nsim, n))
    lr = h * m + np.sqrt(h) * (eps @ L.T)
    ret = (np.expm1(lr) * w).sum(axis=1)
    perd = -B * ret
    return var_es(perd, alpha)


def estres(w, h, alpha):
    grupos = {}
    for t, x in zip(TICKERS, w):
        grupos[SECTOR[t]] = grupos.get(SECTOR[t], 0.0) + x
    g = max(grupos, key=grupos.get)
    sd = np.sqrt(np.diag(Sigma)) * 1.5
    S3 = 0.8 * np.outer(sd, sd)
    np.fill_diagonal(S3, sd ** 2)
    return [0.10 * B, B * (0.20 * grupos[g] + 0.05 * (1 - grupos[g])), normal(w, h, alpha, S3)[0], g]


def kupiec(x, nobs, p):
    ph = x / nobs

    def ll(q):
        return ((nobs - x) * np.log1p(-q) if nobs - x > 0 else 0.0) + (x * np.log(q) if x > 0 else 0.0)

    LR = max(0.0, -2 * (ll(p) - ll(ph)))
    return LR, float(stats.chi2.sf(LR, 1))


def excepciones(w, alpha, ventana=252):
    perd = -B * (R @ w)
    x = nn = 0
    for t in range(ventana, len(perd)):
        var = np.quantile(perd[t - ventana:t], alpha, method="inverted_cdf")
        x += int(perd[t] > var)
        nn += 1
    return x, nn


def minvar(wmin, wmax, grupos=None):
    cons = [{"type": "eq", "fun": lambda w: w.sum() - 1.0, "jac": lambda w: np.ones(n)}]
    for lim, idx in (grupos or []):
        cons.append({"type": "ineq", "fun": lambda w, idx=idx, lim=lim: lim - w[idx].sum()})
    esc = 1e4
    r = minimize(lambda w: esc * (w @ Sigma @ w), np.full(n, 1.0 / n), jac=lambda w: esc * 2 * (Sigma @ w),
                 bounds=[(wmin, wmax)] * n, constraints=cons, method="SLSQP", options={"ftol": 1e-16, "maxiter": 2000})
    return r.x.tolist(), float(r.x @ Sigma @ r.x), bool(r.success)


w_eq = np.full(n, 1.0 / n)
perd = perdidas_bloque(w_eq, H)
hv, hes, hpeor, hcola, hemp = var_es(perd, ALPHA)
nv, nes = normal(w_eq, H, ALPHA)
mv, mes, mpeor, _, _ = mc(w_eq, H, ALPHA, N_MC)
perd_ns = perdidas_bloque(w_eq, H, H)

idx_sector = {}
for i, t in enumerate(TICKERS):
    idx_sector.setdefault(SECTOR[t], []).append(i)
grupos = [(LIM, idx) for idx in idx_sector.values() if len(idx) > 1] + [(LIM, idx) for idx in idx_sector.values() if len(idx) == 1]
wA, objA, okA = minvar(WMIN, WMAX)
wB, objB, okB = minvar(WMIN, WMAX, grupos)
# caso interior (sin límites activos): solución cerrada Σ⁻¹1 / (1ᵀΣ⁻¹1)
inv1 = np.linalg.solve(Sigma, np.ones(n))
w_cerrada = (inv1 / inv1.sum()).tolist()
wC, objC, okC = minvar(-5.0, 5.0)
# caso en que el límite sectorial SÍ aprieta: Tecnología y Energía al 10 % (sin límite pesan 12,4 % y 12,3 %)
LIM_AJ = {"Tecnología": 0.10, "Energía": 0.10}
grupos_aj = [(LIM_AJ[sec], idx_sector[sec]) for sec in LIM_AJ]
wD, objD, okD = minvar(WMIN, WMAX, grupos_aj)

wB_arr = np.array(wB)
xb, nb = excepciones(wB_arr, ALPHA)
LRb, pb = kupiec(xb, nb, 1 - ALPHA)

casos_kupiec = []
for x, nobs, p in [(5, 250, 0.01), (0, 250, 0.01), (2, 250, 0.01), (12, 500, 0.01), (30, 250, 0.05), (250, 250, 0.99)]:
    LR, pv = kupiec(x, nobs, p)
    casos_kupiec.append({"x": x, "n": nobs, "p": p, "LR": LR, "pValor": pv})

salida = {
    "tickers": TICKERS, "sector": [SECTOR[t] for t in TICKERS], "B": B, "alpha": ALPHA, "h": H, "wmin": WMIN, "wmax": WMAX, "lim": LIM,
    "sesionesComunes": len(dias), "retornos": int(T), "SigmaR": Sigma.tolist(),
    "iguales": {"w": w_eq.tolist(), "hist": {"VaR": hv, "ES": hes, "peor": hpeor, "bloques": int(len(perd)), "cola": hcola, "empates": hemp,
                                             "VaRSinSolape": float(var_es(perd_ns, ALPHA)[0]), "bloquesSinSolape": int(len(perd_ns))},
                "normal": {"VaR": nv, "ES": nes}, "mc": {"VaR": mv, "ES": mes, "escenarios": N_MC},
                "estres": estres(w_eq, H, ALPHA)},
    "gruposAjustados": [{"limit": lim, "idx": idx} for lim, idx in grupos_aj],
    "optimo": {"ajustado": {"w": wD, "obj": objD, "ok": okD}, "acotado": {"w": wA, "obj": objA, "ok": okA}, "sectores": {"w": wB, "obj": objB, "ok": okB}, "interior": {"w": wC, "obj": objC, "ok": okC, "cerrada": w_cerrada}},
    "gruposSector": [{"limit": lim, "idx": idx} for lim, idx in grupos],
    "backtest": {"x": xb, "n": nb, "LR": LRb, "pValor": pb},
    "kupiec": casos_kupiec,
}
os.makedirs(os.path.join(RAIZ, "tests", "fixtures"), exist_ok=True)
with open(os.path.join(RAIZ, "tests", "fixtures", "risk_expected.json"), "w", encoding="utf-8") as f:
    json.dump(salida, f, ensure_ascii=False, indent=1)
print("referencia lista:", len(dias), "sesiones comunes;", T, "retornos;", "SLSQP ok:", okA, okB, okC, okD)
print("VaR hist / normal / MC (iguales):", round(hv, 2), round(nv, 2), round(mv, 2))
