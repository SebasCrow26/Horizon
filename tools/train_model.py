# Backtest walk-forward, paso 2: ¿los veredictos predicen algo? y entrenamiento del modelo que usa la app.
# Lee data/backtest_rows.csv (tools/backtest_dataset.mjs) y:
#   1) Evalúa fuera de muestra, avanzando en el tiempo: en cada fecha se entrena SOLO con observaciones cuyo
#      resultado ya se conocía (fecha + horizonte + margen < fecha de prueba) y se predice lo que viene.
#   2) Compara: tasa base, probabilidad de Merton (lo que hoy muestra la app), ensamble calibrado,
#      logística con los 5 modelos, logística con todas las señales y random forest.
#   3) Mide el valor práctico: rendimiento por veredicto, frente al mercado, y si funcionan el piso y el objetivo.
#   4) Entrena la logística final con todo (solo informativa: no mejoró fuera de muestra, la app no la usa).
#   5) Escribe data/backtest_report.json (resultados que muestra la app y el informe).
# Uso: python -X utf8 -I tools/train_model.py
import json, sys, math
from pathlib import Path
import numpy as np, pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, brier_score_loss, log_loss

ROOT = Path(__file__).resolve().parent.parent
FEATURES = ["merton", "meanrev", "realoptions", "vasicek", "herding", "mom12", "mom1", "volRatio", "hi52", "regime", "relStr"]
MODEL5 = FEATURES[:5]
H = 63
PURGE_DAYS = 100          # margen en días de calendario (63 sesiones ≈ 91 días)
BURN_IN_DAYS = 2 * 365    # primeros 2 años de fechas de prueba solo sirven para entrenar
RETRAIN_EVERY = 63        # se reentrena cada ~2 meses de calendario

df = pd.read_csv(ROOT / "data" / "backtest_rows.csv")
df = df.dropna(subset=[f"fwd{H}"]).copy()
df["y"] = (df[f"fwd{H}"] > 0).astype(int)
df["excess"] = df[f"fwd{H}"] - df[f"mkt{H}"]
df = df.sort_values("day").reset_index(drop=True)
date = lambda d: pd.Timestamp(int(d) * 86400, unit="s").strftime("%Y-%m-%d")
print(f"Observaciones: {len(df)} · activos: {df.sym.nunique()} · fechas: {date(df.day.min())} a {date(df.day.max())} · suben: {df.y.mean():.1%}")

def make(kind):
    if kind == "rf":
        return RandomForestClassifier(n_estimators=300, max_depth=4, min_samples_leaf=60, max_features=0.5, random_state=7, n_jobs=-1)
    return LogisticRegression(C=0.1, max_iter=2000)

def walk_forward(df):
    out = {k: np.full(len(df), np.nan) for k in ["base", "ens", "logit5", "logit_all", "rf"]}
    start = df.day.min() + BURN_IN_DAYS
    t = start
    while t <= df.day.max():
        test = (df.day >= t) & (df.day < t + RETRAIN_EVERY)
        train = df.day <= t - PURGE_DAYS
        if test.sum() and train.sum() > 500:
            tr, te = df[train], df[test]
            out["base"][test.values] = tr.y.mean()
            for name, cols in [("ens", ["score"]), ("logit5", MODEL5), ("logit_all", FEATURES), ("rf", FEATURES)]:
                sc = StandardScaler().fit(tr[cols])
                m = make("rf" if name == "rf" else "logit").fit(sc.transform(tr[cols]), tr.y)
                out[name][test.values] = m.predict_proba(sc.transform(te[cols]))[:, 1]
        t += RETRAIN_EVERY
    return out

pred = walk_forward(df)
oos = ~np.isnan(pred["logit_all"])
d = df[oos].copy()
for k, v in pred.items(): d["p_" + k] = v[oos]
d["p_merton"] = d["probUp"]
print(f"Fuera de muestra: {len(d)} observaciones · {date(d.day.min())} a {date(d.day.max())}")

def metrics(p, y):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return {"auc": float(roc_auc_score(y, p)), "brier": float(brier_score_loss(y, p)), "logloss": float(log_loss(y, p)), "acc": float(((p > 0.5) == y).mean())}

names = {"base": "Tasa base (sin modelo)", "merton": "Probabilidad de Merton (la app hoy)", "ens": "Ensamble actual calibrado", "logit5": "Logística · 5 modelos", "logit_all": "Logística · 5 modelos + señales de mercado", "rf": "Random forest · todas las señales"}
comp = {}
base_brier = brier_score_loss(d.y, d.p_base)
print("\nModelo                                         AUC    Brier  Mejora Brier  Aciertos")
for k in ["base", "merton", "ens", "logit5", "logit_all", "rf"]:
    m = metrics(d["p_" + k].values, d.y.values)
    m["brierSkill"] = 1 - m["brier"] / base_brier
    # AUC promedio por fecha (evita que el ciclo del mercado infle el resultado)
    by = [roc_auc_score(g.y, g["p_" + k]) for _, g in d.groupby("day") if g.y.nunique() == 2 and len(g) >= 10]
    m["aucByDate"] = float(np.mean(by)) if by else None
    comp[k] = m
    print(f"{names[k]:45s} {m['auc']:.3f}  {m['brier']:.4f}  {m['brierSkill']:+.2%}      {m['acc']:.1%}   (AUC por fecha {m['aucByDate']:.3f})")

# Intervalo de confianza del AUC (bootstrap por fecha, para respetar que los activos se mueven juntos)
rng = np.random.default_rng(7)
days = d.day.unique()
def boot_auc(col, n=300):
    vals = []
    groups = {k: g for k, g in d.groupby("day")}
    for _ in range(n):
        pick = rng.choice(days, len(days), replace=True)
        s = pd.concat([groups[k] for k in pick])
        if s.y.nunique() == 2: vals.append(roc_auc_score(s.y, s[col]))
    return [float(np.percentile(vals, 5)), float(np.percentile(vals, 95))]
for k in ["merton", "ens", "logit_all", "rf"]:
    comp[k]["aucCI90"] = boot_auc("p_" + k)
    print(f"  IC 90 % del AUC · {names[k]}: {comp[k]['aucCI90'][0]:.3f} – {comp[k]['aucCI90'][1]:.3f}")

# ----- valor práctico: estrategias (cada mes, rendimiento a 3 meses; medias por fecha) -----
def strat(mask_fn):
    r, x, n = [], [], []
    for _, g in d.groupby("day"):
        sel = g[mask_fn(g)]
        if len(sel): r.append(sel[f"fwd{H}"].mean()); x.append(sel.excess.mean()); n.append(len(sel))
    r = np.array(r)
    return {"mean": float(np.expm1(r.mean())) if len(r) else None, "hit": float((r > 0).mean()) if len(r) else None, "excess": float(np.mean(x)) if x else None, "periods": len(r), "avgN": float(np.mean(n)) if n else 0}
strategies = {
    "all": ("Comprar todo (equiponderado)", lambda g: g.index == g.index),
    "v2Buy": ("Tendencia (v2): Comprar / Comprar de a poco", lambda g: g.verdict.isin(["buy", "accumulate"])),
    "v2Avoid": ("Tendencia (v2): Vender / Vender una parte", lambda g: g.verdict.isin(["sell", "reduce"])),
    "v1Buy": ("5 modelos (v1): Comprar / Comprar de a poco", lambda g: g.verdict5.isin(["buy", "accumulate"])),
    "v1Avoid": ("5 modelos (v1): Vender / Vender una parte", lambda g: g.verdict5.isin(["sell", "reduce"])),
    "mlTop": ("Quinto con mayor probabilidad (logística)", lambda g: g.p_logit_all >= g.p_logit_all.quantile(0.8)),
    "mlBottom": ("Quinto con menor probabilidad (logística)", lambda g: g.p_logit_all <= g.p_logit_all.quantile(0.2)),
    "rfTop": ("Quinto con mayor probabilidad (random forest)", lambda g: g.p_rf >= g.p_rf.quantile(0.8)),
}
strat_out = {}
print("\nEstrategia (cada mes, a 3 meses)                    Rend. medio  Meses >0  Vs. mercado")
for k, (label, fn) in strategies.items():
    s = strat(fn); s["label"] = label; strat_out[k] = s
    print(f"{label:52s} {s['mean']:+7.2%}    {s['hit']:.0%}      {s['excess']:+.2%}")

# ----- por veredicto actual -----
order = ["buy", "accumulate", "hold", "reduce", "sell"]
labels = {"buy": "Comprar", "accumulate": "Comprar de a poco", "hold": "Esperar", "reduce": "Vender una parte", "sell": "Vender"}
def verdict_table(col, title):
    rows = []
    print(f"\n{title}\nVeredicto           n     Subió   Rend. medio  Vs. mercado  Tocó el piso  Llegó al objetivo")
    for v in order:
        g = d[d[col] == v]
        if not len(g): continue
        row = {"key": v, "label": labels[v], "n": int(len(g)), "hit": float(g.y.mean()), "mean": float(np.expm1(g[f"fwd{H}"].mean())), "excess": float(g.excess.mean()),
               "beatMkt": float((g.excess > 0).mean()),
               "stopHit": float((g[f"min{H}"] <= np.log1p(g.downside)).mean()), "targetHit": float((g[f"max{H}"] >= np.log1p(g.upside.clip(lower=0.001))).mean())}
        rows.append(row)
        print(f"{labels[v]:18s} {row['n']:5d}  {row['hit']:6.1%}   {row['mean']:+7.2%}     {row['excess']:+6.2%}      {row['stopHit']:6.1%}        {row['targetHit']:6.1%}")
    return rows
by_verdict = verdict_table("verdict", "VEREDICTO v2 (tendencia)")
by_verdict5 = verdict_table("verdict5", "VEREDICTO v1 (5 modelos, el de la entrega)")
def ic(col, tgt="excess"):
    v = [g[col].corr(g[tgt], method="spearman") for _, g in d.groupby("day") if len(g) >= 15 and g[col].nunique() > 1]
    v = np.array([x for x in v if x == x])
    return {"ic": float(v.mean()), "t": float(v.mean() / v.std() * np.sqrt(len(v) / 3)), "n": int(len(v))}
ics = {"trend": ic("score"), "fiveModels": ic("score5")}
print("\nCorrelación de rangos por fecha con el rendimiento vs. mercado:", ics)
r = np.exp(d[f"fwd{H}"])
coverage = {"inside": float(((r >= d.lo) & (r <= d.hi)).mean()), "below": float((r < d.lo).mean()), "above": float((r > d.hi).mean())}
print("Cobertura del rango p10–p90 (debería ser 80 %):", coverage)

# ----- calibración del modelo final (fuera de muestra) por tramos de probabilidad -----
bins = [0, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 1.0]
d["bin"] = pd.cut(d.p_logit_all, bins, include_lowest=True)
calib = []
print("\nProbabilidad dicha   n     Subió de verdad   Rend. medio")
for b, g in d.groupby("bin", observed=True):
    if len(g) < 30: continue
    row = {"lo": float(b.left), "hi": float(b.right), "n": int(len(g)), "said": float(g.p_logit_all.mean()), "hit": float(g.y.mean()), "mean": float(np.expm1(g[f"fwd{H}"].mean())), "excess": float(g.excess.mean())}
    calib.append(row)
    print(f"{row['lo']:.2f}–{row['hi']:.2f} ({row['said']:.0%})  {row['n']:5d}   {row['hit']:6.1%}          {row['mean']:+.2%}")

# ----- por región -----
by_region = {}
for r, g in d.groupby("region"):
    if g.y.nunique() < 2 or len(g) < 100: continue
    by_region[r] = {"n": int(len(g)), "aucMerton": float(roc_auc_score(g.y, g.p_merton)), "aucLogit": float(roc_auc_score(g.y, g.p_logit_all)), "base": float(g.y.mean())}
print("\nPor región:", {k: f"AUC {v['aucLogit']:.3f} (Merton {v['aucMerton']:.3f}, n={v['n']})" for k, v in by_region.items()})

# ----- modelo final: logística con todo el historial -----
sc = StandardScaler().fit(df[FEATURES])
final = LogisticRegression(C=0.1, max_iter=2000).fit(sc.transform(df[FEATURES]), df.y)
coef = dict(zip(FEATURES, final.coef_[0].round(4).tolist()))
print("\nCoeficientes finales (estandarizados):", coef, "intercepto", round(float(final.intercept_[0]), 4))

best = max(["merton", "ens", "logit_all", "rf"], key=lambda k: comp[k]["auc"])
model = {
    "generated": pd.Timestamp.now().isoformat(), "features": FEATURES,
    "byHorizon": {str(H): {"intercept": float(final.intercept_[0]), "coef": final.coef_[0].tolist(), "mean": sc.mean_.tolist(), "scale": sc.scale_.tolist(), "baseRate": float(df.y.mean())}},
    "calibration": calib, "byVerdict": by_verdict,
    "oosLogit": {"n": int(len(d)), "from": date(d.day.min()), "to": date(d.day.max()), "auc": comp["logit_all"]["auc"], "aucMerton": comp["merton"]["auc"], "aucCI90": comp["logit_all"]["aucCI90"], "brierSkill": comp["logit_all"]["brierSkill"]},
}
report = {"generated": model["generated"], "horizon": H, "nObs": int(len(df)), "nAssets": int(df.sym.nunique()), "from": date(df.day.min()), "to": date(df.day.max()),
          "oos": {"n": int(len(d)), "from": date(d.day.min()), "to": date(d.day.max())}, "models": {k: {**v, "label": names[k]} for k, v in comp.items()}, "best": best, "strategies": strat_out,
          "byVerdict": by_verdict, "byVerdict5": by_verdict5, "ic": ics, "coverage": coverage, "logitModel": model, "calibration": calib, "byRegion": by_region, "coef": coef}
(ROOT / "data" / "backtest_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
print("\nGuardado: data/model.json y data/backtest_report.json")
