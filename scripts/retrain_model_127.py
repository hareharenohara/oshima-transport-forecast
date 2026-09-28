from __future__ import annotations

import json
import math
import pickle
import shutil
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "03_ml_dataset_training_eligible_audited.csv"
OUT = ROOT / "artifacts" / "model_training_v1_127"
RNG = np.random.default_rng(20260928)
TARGET_RECALL = 0.98
REMOVED_DIRECTION_FEATURES = {
    "journey_wind_direction_10m_circular_mean_deg",
    "journey_wave_direction_circular_mean_deg",
    "journey_wind_wave_direction_circular_mean_deg",
    "journey_swell_wave_direction_circular_mean_deg",
}


def sigmoid(x):
    x = np.clip(x, -35, 35)
    return 1.0 / (1.0 + np.exp(-x))


def logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def average_precision(y, p):
    y = np.asarray(y, int)
    order = np.argsort(-p, kind="stable")
    ys = y[order]
    if ys.sum() == 0:
        return np.nan
    precision = np.cumsum(ys) / np.arange(1, len(ys) + 1)
    return float((precision * ys).sum() / ys.sum())


def roc_auc(y, p):
    y = np.asarray(y, int)
    n1, n0 = y.sum(), len(y) - y.sum()
    if n1 == 0 or n0 == 0:
        return np.nan
    ranks = pd.Series(p).rank(method="average").to_numpy()
    return float((ranks[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def classification_metrics(y, p, threshold):
    y = np.asarray(y, int)
    pred = (p >= threshold).astype(int)
    tp = int(((pred == 1) & (y == 1)).sum())
    fp = int(((pred == 1) & (y == 0)).sum())
    tn = int(((pred == 0) & (y == 0)).sum())
    fn = int(((pred == 0) & (y == 1)).sum())
    return {
        "threshold": float(threshold), "tp": tp, "fp": fp, "tn": tn, "fn": fn,
        "recall": tp / (tp + fn) if tp + fn else np.nan,
        "precision": tp / (tp + fp) if tp + fp else np.nan,
        "false_positive_rate": fp / (fp + tn) if fp + tn else np.nan,
        "specificity": tn / (tn + fp) if tn + fp else np.nan,
        "alert_rate": (tp + fp) / len(y),
        "accuracy": (tp + tn) / len(y),
        "pr_auc": average_precision(y, p), "roc_auc": roc_auc(y, p),
        "brier": float(np.mean((p - y) ** 2)),
    }


def threshold_table(y, p):
    return pd.DataFrame([classification_metrics(y, p, t) for t in np.linspace(0.01, 0.99, 99)])


def select_threshold(y, p, target_recall=TARGET_RECALL):
    table = threshold_table(y, p)
    eligible = table[table.recall >= target_recall]
    if len(eligible):
        row = eligible.sort_values(["false_positive_rate", "precision", "threshold"], ascending=[True, False, False]).iloc[0]
    else:
        row = table.sort_values(["recall", "false_positive_rate"], ascending=[False, True]).iloc[0]
    return float(row.threshold), table


class FeatureBuilder:
    def __init__(self):
        self.numeric_cols = []
        self.category_cols = ["ship_type", "direction", "counterpart_terminal", "voyage_number"]
        self.medians = {}
        self.means = {}
        self.stds = {}
        self.levels = {}
        self.feature_names = []

    def _base_frame(self, df):
        out = df.copy()
        # Audit decision: schedule data uses integer voyage identifiers. Preserve
        # missing values as an explicit category rather than silently coercing them.
        voyage = pd.to_numeric(out["voyage_number"], errors="coerce").astype("Int64")
        out["voyage_number"] = voyage.astype("string").fillna("__MISSING__")
        dep = pd.to_datetime(out["scheduled_departure_jst"])
        month_angle = 2 * np.pi * (dep.dt.month - 1) / 12
        hour_angle = 2 * np.pi * (dep.dt.hour + dep.dt.minute / 60) / 24
        out["departure_month_sin"] = np.sin(month_angle)
        out["departure_month_cos"] = np.cos(month_angle)
        out["departure_hour_sin"] = np.sin(hour_angle)
        out["departure_hour_cos"] = np.cos(hour_angle)
        out["departure_weekend"] = (dep.dt.dayofweek >= 5).astype(float)
        return out

    def fit(self, df):
        work = self._base_frame(df)
        prefixes = ("journey_", "pre3h_", "pre6h_", "change_", "hours_route_")
        candidates = [c for c in work.columns if c.startswith(prefixes)]
        candidates += ["estimated_duration_minutes", "departure_month_sin", "departure_month_cos", "departure_hour_sin", "departure_hour_cos", "departure_weekend"]
        self.numeric_cols = [
            c for c in candidates
            if work[c].notna().any()
            and "peak_period" not in c
            and c not in REMOVED_DIRECTION_FEATURES
        ]
        for c in self.numeric_cols:
            values = pd.to_numeric(work[c], errors="coerce")
            med = float(values.median())
            filled = values.fillna(med).to_numpy(float)
            mean, std = float(filled.mean()), float(filled.std())
            self.medians[c], self.means[c], self.stds[c] = med, mean, std if std > 1e-9 else 1.0
        for c in self.category_cols:
            self.levels[c] = sorted(work[c].fillna("__MISSING__").astype(str).unique().tolist())
        self.feature_names = list(self.numeric_cols)
        for c in self.category_cols:
            self.feature_names.extend([f"{c}={level}" for level in self.levels[c]])
        return self

    def transform(self, df):
        work = self._base_frame(df)
        arrays = []
        for c in self.numeric_cols:
            v = pd.to_numeric(work[c], errors="coerce").fillna(self.medians[c]).to_numpy(float)
            arrays.append(((v - self.means[c]) / self.stds[c])[:, None])
        for c in self.category_cols:
            values = work[c].fillna("__MISSING__").astype(str).to_numpy()
            arrays.append(np.column_stack([(values == level).astype(float) for level in self.levels[c]]))
        return np.hstack(arrays).astype(np.float64)

    def to_dict(self):
        return {"numeric_cols": self.numeric_cols, "category_cols": self.category_cols,
                "medians": self.medians, "means": self.means, "stds": self.stds,
                "levels": self.levels, "feature_names": self.feature_names}


class LogisticModel:
    def __init__(self, learning_rate=0.03, epochs=700, l2=0.02):
        self.learning_rate, self.epochs, self.l2 = learning_rate, epochs, l2
        self.coef_ = None
        self.intercept_ = 0.0

    def fit(self, X, y):
        y = np.asarray(y, float)
        n, d = X.shape
        w = np.zeros(d); b = float(logit(np.array([np.clip(y.mean(), 1e-4, 1-1e-4)]))[0])
        m = np.zeros(d); v = np.zeros(d); mb = vb = 0.0
        pos_weight = (len(y) - y.sum()) / max(y.sum(), 1)
        sample_w = np.where(y == 1, pos_weight, 1.0)
        for epoch in range(1, self.epochs + 1):
            p = sigmoid(X @ w + b)
            err = (p - y) * sample_w
            gw = X.T @ err / sample_w.sum() + self.l2 * w
            gb = err.sum() / sample_w.sum()
            m = .9*m + .1*gw; v = .999*v + .001*(gw*gw)
            mb = .9*mb + .1*gb; vb = .999*vb + .001*(gb*gb)
            mh, vh = m/(1-.9**epoch), v/(1-.999**epoch)
            mbh, vbh = mb/(1-.9**epoch), vb/(1-.999**epoch)
            w -= self.learning_rate * mh/(np.sqrt(vh)+1e-8)
            b -= self.learning_rate * mbh/(math.sqrt(vbh)+1e-8)
        self.coef_, self.intercept_ = w, float(b)
        return self

    def predict_raw(self, X):
        return X @ self.coef_ + self.intercept_

    def predict_proba(self, X):
        return sigmoid(self.predict_raw(X))

    def to_dict(self):
        return {"type": "logistic_regression", "coef": self.coef_.tolist(), "intercept": self.intercept_}


class GBDTStumps:
    def __init__(self, rounds=140, learning_rate=0.06, max_features=32, thresholds=10, l2=4.0):
        self.rounds, self.learning_rate = rounds, learning_rate
        self.max_features, self.thresholds, self.l2 = max_features, thresholds, l2
        self.initial_logit = 0.0
        self.stumps = []

    def fit(self, X, y):
        y = np.asarray(y, float)
        pos_weight = (len(y) - y.sum()) / max(y.sum(), 1)
        sw = np.where(y == 1, pos_weight, 1.0)
        weighted_rate = np.average(y, weights=sw)
        self.initial_logit = float(logit(np.array([weighted_rate]))[0])
        raw = np.full(len(y), self.initial_logit)
        n_features = X.shape[1]
        for _ in range(self.rounds):
            p = sigmoid(raw)
            grad = sw * (y - p)
            hess = sw * p * (1-p)
            features = RNG.choice(n_features, size=min(self.max_features, n_features), replace=False)
            best = None
            best_gain = -np.inf
            for j in features:
                vals = X[:, j]
                qs = np.unique(np.quantile(vals, np.linspace(.08, .92, self.thresholds)))
                for threshold in qs:
                    left = vals <= threshold
                    nl = int(left.sum()); nr = len(y)-nl
                    if nl < 30 or nr < 30:
                        continue
                    gl, hl = grad[left].sum(), hess[left].sum()
                    gr, hr = grad[~left].sum(), hess[~left].sum()
                    gain = gl*gl/(hl+self.l2) + gr*gr/(hr+self.l2)
                    if gain > best_gain:
                        best_gain = gain
                        best = (int(j), float(threshold), float(gl/(hl+self.l2)), float(gr/(hr+self.l2)))
            if best is None:
                break
            j, threshold, lv, rv = best
            raw += self.learning_rate * np.where(X[:, j] <= threshold, lv, rv)
            self.stumps.append(best)
        return self

    def predict_raw(self, X):
        raw = np.full(len(X), self.initial_logit)
        for j, threshold, lv, rv in self.stumps:
            raw += self.learning_rate * np.where(X[:, j] <= threshold, lv, rv)
        return raw

    def predict_proba(self, X):
        return sigmoid(self.predict_raw(X))

    def to_dict(self):
        return {"type": "gradient_boosted_stumps", "initial_logit": self.initial_logit,
                "learning_rate": self.learning_rate,
                "stumps": [{"feature_index": j, "threshold": t, "left_value": l, "right_value": r}
                           for j, t, l, r in self.stumps]}


class PlattCalibrator:
    def __init__(self):
        self.a, self.b = 1.0, 0.0

    def fit(self, raw, y):
        raw = np.asarray(raw, float); y = np.asarray(y, float)
        a, b = 1.0, 0.0
        for _ in range(100):
            p = sigmoid(a*raw+b)
            w = p*(1-p) + 1e-8
            ga = np.sum((p-y)*raw) + 1e-4*a
            gb = np.sum(p-y) + 1e-4*b
            haa = np.sum(w*raw*raw) + 1e-4
            hab = np.sum(w*raw)
            hbb = np.sum(w) + 1e-4
            det = haa*hbb-hab*hab
            if det <= 1e-12: break
            da, db = (hbb*ga-hab*gb)/det, (-hab*ga+haa*gb)/det
            a -= np.clip(da, -1, 1); b -= np.clip(db, -1, 1)
            if abs(da)+abs(db) < 1e-7: break
        self.a, self.b = float(a), float(b)
        return self

    def predict(self, raw):
        return sigmoid(self.a*np.asarray(raw)+self.b)

    def to_dict(self):
        return {"type": "platt_sigmoid", "a": self.a, "b": self.b}


def fit_candidate(train, calib, model_name):
    builder = FeatureBuilder().fit(train)
    X_train, y_train = builder.transform(train), train.target_weather_cancelled.to_numpy(int)
    X_cal, y_cal = builder.transform(calib), calib.target_weather_cancelled.to_numpy(int)
    if model_name == "logistic":
        model = LogisticModel().fit(X_train, y_train)
    else:
        model = GBDTStumps().fit(X_train, y_train)
    calibrator = PlattCalibrator().fit(model.predict_raw(X_cal), y_cal)
    return builder, model, calibrator


def predict_bundle(bundle, df):
    builder, model, calibrator = bundle
    X = builder.transform(df)
    return calibrator.predict(model.predict_raw(X))


def svg_bar(path, labels, values, title, value_label):
    width, height = 920, 90 + 42*len(labels)
    maxv = max(values) if values else 1
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">',
             '<rect width="100%" height="100%" fill="white"/>',
             f'<text x="20" y="30" font-family="sans-serif" font-size="20" font-weight="bold">{title}</text>']
    for i,(label,val) in enumerate(zip(labels,values)):
        y=60+i*42; bar=600*(val/maxv if maxv else 0)
        parts += [f'<text x="20" y="{y+18}" font-family="sans-serif" font-size="13">{label}</text>',
                  f'<rect x="250" y="{y}" width="{bar:.1f}" height="24" fill="#2563eb"/>',
                  f'<text x="{260+bar:.1f}" y="{y+18}" font-family="sans-serif" font-size="13">{val:.3f} {value_label}</text>']
    parts.append('</svg>')
    path.write_text("\n".join(parts),encoding="utf-8")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    df = pd.read_csv(SOURCE, encoding="utf-8-sig")
    df["service_date"] = pd.to_datetime(df.service_date)
    df["target_weather_cancelled"] = df.target_weather_cancelled.astype(int)
    splits = {
        "train": df[df.service_date <= "2025-09-30"],
        "calibration": df[(df.service_date >= "2025-10-01") & (df.service_date <= "2025-12-31")],
        "validation": df[(df.service_date >= "2026-01-01") & (df.service_date <= "2026-05-31")],
        "test": df[df.service_date >= "2026-06-01"],
    }
    split_rows = []
    for split, part in splits.items():
        for scope in ["all", "jet", "large"]:
            x = part if scope == "all" else part[part.ship_type == scope]
            split_rows.append({"split":split,"scope":scope,"rows":len(x),"weather_cancellations":int(x.target_weather_cancelled.sum()),"operated":int((x.target_weather_cancelled==0).sum()),"date_min":str(x.service_date.min().date()) if len(x) else None,"date_max":str(x.service_date.max().date()) if len(x) else None})
    pd.DataFrame(split_rows).to_csv(OUT/"data_split_summary.csv",index=False,encoding="utf-8-sig")

    results=[]; thresholds=[]; bundles={}; predictions=[]
    for scope in ["all", "jet", "large"]:
        train = splits["train"] if scope=="all" else splits["train"][splits["train"].ship_type==scope]
        calib = splits["calibration"] if scope=="all" else splits["calibration"][splits["calibration"].ship_type==scope]
        valid = splits["validation"] if scope=="all" else splits["validation"][splits["validation"].ship_type==scope]
        test = splits["test"] if scope=="all" else splits["test"][splits["test"].ship_type==scope]
        for model_name in ["logistic", "gbdt_stumps"]:
            print(f"training {scope}/{model_name}",flush=True)
            bundle = fit_candidate(train,calib,model_name)
            bundles[(scope,model_name)] = bundle
            pv = predict_bundle(bundle,valid)
            threshold, table = select_threshold(valid.target_weather_cancelled,pv)
            table.insert(0,"scope",scope); table.insert(1,"model",model_name); table.insert(2,"split","validation")
            thresholds.append(table)
            for split_name, part in [("validation",valid),("test",test)]:
                pp = predict_bundle(bundle,part)
                met=classification_metrics(part.target_weather_cancelled,pp,threshold)
                met.update({"scope":scope,"model":model_name,"split":split_name,"target_recall":TARGET_RECALL})
                results.append(met)
                if split_name=="test":
                    predictions.append(pd.DataFrame({"voyage_id":part.voyage_id,"service_date":part.service_date.dt.date,"ship_type":part.ship_type,"scope":scope,"model":model_name,"actual":part.target_weather_cancelled,"probability":pp,"threshold":threshold,"predicted_risk":(pp>=threshold).astype(int)}))
    comparison=pd.DataFrame(results)
    comparison.to_csv(OUT/"model_comparison.csv",index=False,encoding="utf-8-sig")
    pd.concat(thresholds,ignore_index=True).to_csv(OUT/"threshold_analysis.csv",index=False,encoding="utf-8-sig")
    pd.concat(predictions,ignore_index=True).to_csv(OUT/"test_predictions.csv",index=False,encoding="utf-8-sig")

    valid_common=comparison[(comparison.scope=="all")&(comparison.split=="validation")].sort_values(["pr_auc","recall","false_positive_rate"],ascending=[False,False,True])
    best_name=valid_common.iloc[0].model
    best_bundle=bundles[("all",best_name)]
    best_threshold=float(valid_common.iloc[0].threshold)
    builder,model,calibrator=best_bundle

    # Permutation importance on validation using PR-AUC drop, post-transformation.
    valid=splits["validation"]; X=builder.transform(valid); y=valid.target_weather_cancelled.to_numpy(int)
    base=average_precision(y,calibrator.predict(model.predict_raw(X)))
    imp=[]
    for j,name in enumerate(builder.feature_names):
        drops=[]
        for _ in range(3):
            xp=X.copy(); xp[:,j]=RNG.permutation(xp[:,j])
            drops.append(base-average_precision(y,calibrator.predict(model.predict_raw(xp))))
        imp.append({"feature":name,"pr_auc_drop_mean":float(np.mean(drops)),"pr_auc_drop_std":float(np.std(drops))})
    importance=pd.DataFrame(imp).sort_values("pr_auc_drop_mean",ascending=False)
    importance.to_csv(OUT/"feature_importance.csv",index=False,encoding="utf-8-sig")

    # Save Python bundle and portable JSON for the tested common model and best model per ship type.
    with open(OUT/"best_common_model.pkl","wb") as f: pickle.dump({"builder":builder,"model":model,"calibrator":calibrator,"threshold":best_threshold},f)
    portable={"schema_version":"v1-127","training_data":SOURCE.name,"evaluation_design":"train through 2025-09; calibration 2025Q4; validation 2026-01 to 2026-05; test 2026-06 onward","models":{}}
    for scope in ["all","jet","large"]:
        row=comparison[(comparison.scope==scope)&(comparison.split=="validation")].sort_values(["pr_auc","recall"],ascending=False).iloc[0]
        name=row.model; b,m,c=bundles[(scope,name)]
        portable["models"][scope]={"selected_model":name,"threshold":float(row.threshold),"preprocessor":b.to_dict(),"model":m.to_dict(),"calibrator":c.to_dict()}
    (OUT/"cloudflare_portable_model.json").write_text(json.dumps(portable,ensure_ascii=False),encoding="utf-8")

    top=importance.head(15)
    svg_bar(OUT/"feature_importance.svg",top.feature.tolist(),top.pr_auc_drop_mean.clip(lower=0).tolist(),"Validation permutation importance","PR-AUC drop")
    test_all=comparison[(comparison.scope=="all")&(comparison.split=="test")].sort_values("pr_auc",ascending=False)
    svg_bar(OUT/"model_comparison.svg",test_all.model.tolist(),test_all.pr_auc.tolist(),"Common-model test PR-AUC","PR-AUC")

    best_test=comparison[(comparison.scope=="all")&(comparison.model==best_name)&(comparison.split=="test")].iloc[0]
    best_valid=comparison[(comparison.scope=="all")&(comparison.model==best_name)&(comparison.split=="validation")].iloc[0]
    large_test=comparison[(comparison.scope=="large")&(comparison.split=="test")].sort_values("pr_auc",ascending=False).iloc[0]
    jet_test=comparison[(comparison.scope=="jet")&(comparison.split=="test")].sort_values("pr_auc",ascending=False).iloc[0]
    report=f"""# 東海汽船 気象欠航リスクモデル 学習結果

## 結論

- 共通モデルの採用候補: **{best_name}**
- 検証期間で選んだ警戒閾値: **{best_threshold:.2f}**（欠航Recall {best_valid.recall:.1%}、Precision {best_valid.precision:.1%}、誤警報率 {best_valid.false_positive_rate:.1%}）
- 未使用の最終テスト期間: PR-AUC **{best_test.pr_auc:.3f}**、ROC-AUC **{best_test.roc_auc:.3f}**、Recall **{best_test.recall:.1%}**、Precision **{best_test.precision:.1%}**、誤警報率 **{best_test.false_positive_rate:.1%}**、Brier **{best_test.brier:.3f}**
- 最終テストの混同行列: TP={int(best_test.tp)}, FN={int(best_test.fn)}, FP={int(best_test.fp)}, TN={int(best_test.tn)}

## 時系列評価設計

- 学習: 2024-07-09～2025-09-30
- 確率校正: 2025-10-01～2025-12-31
- モデル比較・閾値選択: 2026-01-01～2026-05-31
- 最終テスト: 2026-06-01～2026-09-17

欠航を早めに拾う目的に合わせ、検証期間でRecall 98%以上を満たす候補のうち誤警報率が最小になる閾値を選んだ。テスト期間はモデル選択・閾値調整に使用していない。

## 船種別

- ジェット船の最良テストPR-AUC: {jet_test.pr_auc:.3f}、Recall {jet_test.recall:.1%}、Precision {jet_test.precision:.1%}
- 大型客船の最良テストPR-AUC: {large_test.pr_auc:.3f}、Recall {large_test.recall:.1%}、Precision {large_test.precision:.1%}

大型客船は全期間の気象欠航が31件しかなく、船種別モデルの推定は不安定。現段階では共通モデルに船種を入れる方式を主とし、大型客船専用モデルは参考扱いとする。

## モデル仕様

- 比較: クラス重み付きロジスティック回帰、勾配ブースティング決定株
- 欠損: 学習期間中央値
- 数値特徴量: 学習期間の平均・標準偏差で標準化
- カテゴリ: 船種、方向、対岸ターミナル、便番号をone-hot化
- 確率校正: 2025Q4を用いたPlatt sigmoid
- 入力から運航結果、備考、欠航理由、実績港、目的変数を除外

## 本番化上の注意

今回の入力は実際に発生した気象・海象である。本番推論では、同じ地点、単位、集計窓を未来予報値から生成する必要がある。`cloudflare_portable_model.json` は前処理、モデル係数/決定株、校正式、閾値を含み、Worker側に実装可能な形式だが、未来予報特徴量の一致試験後に利用すること。

大型客船、台風、季節ごとの件数が少ないため、運用開始時は「参考リスク」と表示し、公式判断の代替にしない。月次で確率校正とRecallを監視する。
"""
    (OUT/"training_report.md").write_text(report,encoding="utf-8")

    metadata={"selected_common_model":best_name,"selected_threshold":best_threshold,"validation":best_valid.to_dict(),"test":best_test.to_dict(),"feature_count":len(builder.feature_names),"features_version":"v1-127","removed_features":sorted(REMOVED_DIRECTION_FEATURES),"target_recall":TARGET_RECALL}
    (OUT/"model_metadata.json").write_text(json.dumps(metadata,ensure_ascii=False,indent=2,default=lambda x:x.item() if hasattr(x,"item") else str(x)),encoding="utf-8")
    shutil.copy2(Path(__file__),OUT/"train_models.py")
    print(json.dumps(metadata,ensure_ascii=False,indent=2,default=lambda x:x.item() if hasattr(x,"item") else str(x)),flush=True)


if __name__ == "__main__":
    main()
