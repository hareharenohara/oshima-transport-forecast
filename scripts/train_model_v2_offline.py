"""Train and compare point-preserving V2 candidates without production writes."""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from retrain_model_127 import (  # noqa: E402
    FeatureBuilder,
    GBDTStumps,
    LogisticModel,
    PlattCalibrator,
    average_precision,
    classification_metrics,
    fit_candidate,
    predict_bundle,
    roc_auc,
    select_threshold,
    sigmoid,
    logit,
)
from offline_model_benchmark import (  # noqa: E402
    calibration_table,
    expected_calibration_error,
    grouped_bootstrap,
    log_loss,
)


SOURCE_V1 = ROOT / "data" / "03_ml_dataset_training_eligible_audited.csv"
SOURCE_V2 = ROOT / "data" / "04_ml_dataset_training_eligible_v2_points.csv"
OUT = ROOT / "artifacts" / "model_v2_offline"


class V2FeatureBuilder(FeatureBuilder):
    """Use fixed point columns and the unchanged schedule/calendar features."""

    def fit(self, df: pd.DataFrame):
        work = self._base_frame(df)
        point_columns = sorted(column for column in work.columns if column.startswith("point__"))
        calendar = [
            "estimated_duration_minutes",
            "departure_month_sin",
            "departure_month_cos",
            "departure_hour_sin",
            "departure_hour_cos",
            "departure_weekend",
        ]
        self.numeric_cols = point_columns + calendar
        for column in self.numeric_cols:
            values = pd.to_numeric(work[column], errors="coerce")
            median = float(values.median()) if values.notna().any() else 0.0
            filled = values.fillna(median).to_numpy(float)
            mean, std = float(filled.mean()), float(filled.std())
            self.medians[column] = median
            self.means[column] = mean
            self.stds[column] = std if std > 1e-9 else 1.0
        for column in self.category_cols:
            self.levels[column] = sorted(work[column].fillna("__MISSING__").astype(str).unique().tolist())
        self.feature_names = list(self.numeric_cols)
        for column in self.category_cols:
            self.feature_names.extend(f"{column}={level}" for level in self.levels[column])
        return self


class V2HybridFeatureBuilder(FeatureBuilder):
    """Keep V1 route context and add only decision-critical point signals."""

    TERMINAL_POINT = {
        "東京": "tokyo_port",
        "横浜": "tokyo_bay_mouth",
        "久里浜": "uraga_channel",
        "熱海": "atami_offshore",
        "伊東": "ito_offshore",
        "稲取": "inatori_offshore",
        "館山": "tateyama_offshore",
    }
    FIXED_POINTS = ["oshima_north_okata", "oshima_west_motomachi", "sagami_central", "uraga_channel"]
    SUFFIXES = [
        "wind_speed_10m_max",
        "wind_gusts_10m_max",
        "pressure_msl_min",
        "wave_height_max",
        "wave_period_mean",
        "swell_wave_height_max",
        "swell_wave_period_mean",
        "pre3h_wind_gusts_10m_max",
        "pre3h_wave_height_max",
        "change_6h_wind_speed_10m",
        "change_6h_wave_height",
        "hours_wind_ge_10ms_pre6_to_arrival",
        "hours_wave_ge_2_5m_pre6_to_arrival",
    ]

    def _base_frame(self, df: pd.DataFrame):
        out = super()._base_frame(df)
        for suffix in self.SUFFIXES:
            role_column = f"role__counterpart_terminal__{suffix}"
            out[role_column] = np.nan
            for terminal, point in self.TERMINAL_POINT.items():
                selected = out.counterpart_terminal == terminal
                out.loc[selected, role_column] = out.loc[selected, f"point__{point}__{suffix}"]
        return out

    def fit(self, df: pd.DataFrame):
        work = self._base_frame(df)
        prefixes = ("journey_", "pre3h_", "pre6h_", "change_", "hours_route_")
        v1_numeric = [
            column
            for column in work.columns
            if column.startswith(prefixes)
            and "peak_period" not in column
            and "circular_mean_deg" not in column
        ]
        point_numeric = [f"point__{point}__{suffix}" for point in self.FIXED_POINTS for suffix in self.SUFFIXES]
        role_numeric = [f"role__counterpart_terminal__{suffix}" for suffix in self.SUFFIXES]
        calendar = [
            "estimated_duration_minutes",
            "departure_month_sin",
            "departure_month_cos",
            "departure_hour_sin",
            "departure_hour_cos",
            "departure_weekend",
        ]
        self.numeric_cols = v1_numeric + point_numeric + role_numeric + calendar
        for column in self.numeric_cols:
            values = pd.to_numeric(work[column], errors="coerce")
            median = float(values.median()) if values.notna().any() else 0.0
            filled = values.fillna(median).to_numpy(float)
            mean, std = float(filled.mean()), float(filled.std())
            self.medians[column] = median
            self.means[column] = mean
            self.stds[column] = std if std > 1e-9 else 1.0
        for column in self.category_cols:
            self.levels[column] = sorted(work[column].fillna("__MISSING__").astype(str).unique().tolist())
        self.feature_names = list(self.numeric_cols)
        for column in self.category_cols:
            self.feature_names.extend(f"{column}={level}" for level in self.levels[column])
        return self


class DayBalancedLogisticModel(LogisticModel):
    """Limit repeated voyages on one weather-event day from dominating fit."""

    def fit_with_dates(self, x: np.ndarray, y: np.ndarray, dates: np.ndarray):
        y = np.asarray(y, float)
        date_keys = pd.Series(dates).astype(str)
        counts = pd.DataFrame({"date": date_keys, "target": y}).groupby(["date", "target"])["target"].transform("size").to_numpy(float)
        base = 1.0 / counts
        positive_total = base[y == 1].sum()
        negative_total = base[y == 0].sum()
        class_weight = negative_total / max(positive_total, 1e-9)
        sample_weight = base * np.where(y == 1, class_weight, 1.0)

        n, dimensions = x.shape
        weights = np.zeros(dimensions)
        intercept = float(logit(np.array([np.clip(y.mean(), 1e-4, 1 - 1e-4)]))[0])
        moment = np.zeros(dimensions)
        variance = np.zeros(dimensions)
        moment_intercept = variance_intercept = 0.0
        for epoch in range(1, self.epochs + 1):
            probability = sigmoid(x @ weights + intercept)
            error = (probability - y) * sample_weight
            gradient = x.T @ error / sample_weight.sum() + self.l2 * weights
            gradient_intercept = error.sum() / sample_weight.sum()
            moment = 0.9 * moment + 0.1 * gradient
            variance = 0.999 * variance + 0.001 * (gradient * gradient)
            moment_intercept = 0.9 * moment_intercept + 0.1 * gradient_intercept
            variance_intercept = 0.999 * variance_intercept + 0.001 * (gradient_intercept * gradient_intercept)
            corrected_moment = moment / (1 - 0.9**epoch)
            corrected_variance = variance / (1 - 0.999**epoch)
            corrected_intercept_moment = moment_intercept / (1 - 0.9**epoch)
            corrected_intercept_variance = variance_intercept / (1 - 0.999**epoch)
            weights -= self.learning_rate * corrected_moment / (np.sqrt(corrected_variance) + 1e-8)
            intercept -= self.learning_rate * corrected_intercept_moment / (math.sqrt(corrected_intercept_variance) + 1e-8)
        self.coef_, self.intercept_ = weights, float(intercept)
        return self


def fit_v2(train: pd.DataFrame, calibration: pd.DataFrame, kind: str, l2: float = 0.02):
    builder = V2FeatureBuilder().fit(train)
    x_train = builder.transform(train)
    y_train = train.target_weather_cancelled.to_numpy(int)
    if kind == "logistic":
        model = LogisticModel(learning_rate=0.025, epochs=900, l2=l2).fit(x_train, y_train)
    else:
        model = GBDTStumps(rounds=180, learning_rate=0.05, max_features=48, thresholds=10, l2=6.0).fit(x_train, y_train)
    raw_calibration = model.predict_raw(builder.transform(calibration))
    calibrator = PlattCalibrator().fit(raw_calibration, calibration.target_weather_cancelled.to_numpy(int))
    return builder, model, calibrator


def fit_v2_hybrid(train: pd.DataFrame, calibration: pd.DataFrame, kind: str, l2: float = 0.02):
    builder = V2HybridFeatureBuilder().fit(train)
    x_train = builder.transform(train)
    y_train = train.target_weather_cancelled.to_numpy(int)
    if kind == "logistic":
        model = LogisticModel(learning_rate=0.025, epochs=900, l2=l2).fit(x_train, y_train)
    else:
        model = GBDTStumps(rounds=180, learning_rate=0.05, max_features=40, thresholds=10, l2=6.0).fit(x_train, y_train)
    raw_calibration = model.predict_raw(builder.transform(calibration))
    calibrator = PlattCalibrator().fit(raw_calibration, calibration.target_weather_cancelled.to_numpy(int))
    return builder, model, calibrator


def fit_v2_hybrid_day_balanced(train: pd.DataFrame, calibration: pd.DataFrame, l2: float):
    builder = V2HybridFeatureBuilder().fit(train)
    model = DayBalancedLogisticModel(learning_rate=0.025, epochs=900, l2=l2).fit_with_dates(
        builder.transform(train),
        train.target_weather_cancelled.to_numpy(int),
        train.service_date.to_numpy(),
    )
    raw_calibration = model.predict_raw(builder.transform(calibration))
    calibrator = PlattCalibrator().fit(raw_calibration, calibration.target_weather_cancelled.to_numpy(int))
    return builder, model, calibrator


def prediction(bundle, frame: pd.DataFrame) -> np.ndarray:
    builder, model, calibrator = bundle
    return calibrator.predict(model.predict_raw(builder.transform(frame)))


def metric_row(name: str, version: str, split: str, frame: pd.DataFrame, probability: np.ndarray, threshold: float) -> dict:
    metrics = classification_metrics(frame.target_weather_cancelled, probability, threshold)
    reliability = calibration_table(frame.target_weather_cancelled.to_numpy(), probability)
    metrics.update(
        {
            "candidate": name,
            "version": version,
            "split": split,
            "feature_count": None,
            "log_loss": log_loss(frame.target_weather_cancelled.to_numpy(), probability),
            "ece_10": expected_calibration_error(reliability),
            "mean_probability": float(probability.mean()),
            "actual_rate": float(frame.target_weather_cancelled.mean()),
        }
    )
    if split == "test":
        metrics.update(grouped_bootstrap(frame, probability))
    return metrics


def active_missingness(frame: pd.DataFrame) -> pd.DataFrame:
    records = []
    points = sorted({column.split("__")[1] for column in frame.columns if column.startswith("point__")})
    for point in points:
        active_column = f"point__{point}__route_active"
        active = frame[active_column] == 1
        columns = [column for column in frame.columns if column.startswith(f"point__{point}__") and column != active_column]
        for column in columns:
            records.append(
                {
                    "point": point,
                    "feature": column,
                    "active_rows": int(active.sum()),
                    "missing_active_rows": int(frame.loc[active, column].isna().sum()),
                    "missing_active_rate": float(frame.loc[active, column].isna().mean()) if active.any() else np.nan,
                }
            )
    return pd.DataFrame(records)


def feature_spec(builder: V2FeatureBuilder) -> pd.DataFrame:
    rows = []
    units = {
        "wind_speed_10m": "m/s",
        "wind_gusts_10m": "m/s",
        "pressure_msl": "hPa",
        "wave_height": "m",
        "wave_period": "s",
        "swell_wave_height": "m",
        "swell_wave_period": "s",
        "route_active": "0/1",
        "hours_": "hours",
        "direction": "sin/cos",
        "estimated_duration_minutes": "minutes",
    }
    for index, name in enumerate(builder.feature_names, 1):
        unit = "standardized numeric"
        for token, candidate in units.items():
            if token in name:
                unit = candidate
                break
        if "=" in name:
            unit = "0/1"
        rows.append({"model_index": index, "feature_name": name, "unit_before_standardization": unit})
    return pd.DataFrame(rows)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    v1 = pd.read_csv(SOURCE_V1, encoding="utf-8-sig")
    v2 = pd.read_csv(SOURCE_V2, encoding="utf-8-sig")
    for frame in (v1, v2):
        frame["service_date"] = pd.to_datetime(frame.service_date)
        frame["target_weather_cancelled"] = frame.target_weather_cancelled.astype(int)
    if not v1[["voyage_id", "target_weather_cancelled"]].equals(v2[["voyage_id", "target_weather_cancelled"]]):
        raise RuntimeError("V1/V2 voyage order or target changed")

    train_v1 = v1[v1.service_date <= "2025-09-30"]
    calibration_v1 = v1[(v1.service_date >= "2025-10-01") & (v1.service_date <= "2025-12-31")]
    validation_v1 = v1[(v1.service_date >= "2026-01-01") & (v1.service_date <= "2026-05-31")]
    test_v1 = v1[v1.service_date >= "2026-06-01"]
    train_v2 = v2[v2.service_date <= "2025-09-30"]
    calibration_v2 = v2[(v2.service_date >= "2025-10-01") & (v2.service_date <= "2025-12-31")]
    validation_v2 = v2[(v2.service_date >= "2026-01-01") & (v2.service_date <= "2026-05-31")]
    test_v2 = v2[v2.service_date >= "2026-06-01"]

    candidates = {
        "v1_logistic": ("v1-127", fit_candidate(train_v1, calibration_v1, "logistic"), validation_v1, test_v1),
        "v1_gbdt": ("v1-127", fit_candidate(train_v1, calibration_v1, "gbdt_stumps"), validation_v1, test_v1),
        "v2_logistic_l2_002": ("v2-point-1", fit_v2(train_v2, calibration_v2, "logistic", 0.02), validation_v2, test_v2),
        "v2_logistic_l2_010": ("v2-point-1", fit_v2(train_v2, calibration_v2, "logistic", 0.10), validation_v2, test_v2),
        "v2_logistic_l2_050": ("v2-point-1", fit_v2(train_v2, calibration_v2, "logistic", 0.50), validation_v2, test_v2),
        "v2_gbdt": ("v2-point-1", fit_v2(train_v2, calibration_v2, "gbdt"), validation_v2, test_v2),
        "v2_hybrid_logistic_l2_002": ("v2-hybrid-1", fit_v2_hybrid(train_v2, calibration_v2, "logistic", 0.02), validation_v2, test_v2),
        "v2_hybrid_logistic_l2_010": ("v2-hybrid-1", fit_v2_hybrid(train_v2, calibration_v2, "logistic", 0.10), validation_v2, test_v2),
        "v2_hybrid_logistic_l2_050": ("v2-hybrid-1", fit_v2_hybrid(train_v2, calibration_v2, "logistic", 0.50), validation_v2, test_v2),
        "v2_hybrid_gbdt": ("v2-hybrid-1", fit_v2_hybrid(train_v2, calibration_v2, "gbdt"), validation_v2, test_v2),
        "v2_hybrid_day_balanced_l2_002": ("v2-hybrid-1", fit_v2_hybrid_day_balanced(train_v2, calibration_v2, 0.02), validation_v2, test_v2),
        "v2_hybrid_day_balanced_l2_010": ("v2-hybrid-1", fit_v2_hybrid_day_balanced(train_v2, calibration_v2, 0.10), validation_v2, test_v2),
    }

    rows = []
    predictions = []
    probability_cache = {}
    thresholds = {}
    for name, (version, bundle, validation, test) in candidates.items():
        print(f"evaluating {name}", flush=True)
        validation_probability = predict_bundle(bundle, validation) if version == "v1-127" else prediction(bundle, validation)
        threshold, _ = select_threshold(validation.target_weather_cancelled, validation_probability)
        thresholds[name] = threshold
        for split, frame, probability in (
            ("validation", validation, validation_probability),
            ("test", test, predict_bundle(bundle, test) if version == "v1-127" else prediction(bundle, test)),
        ):
            row = metric_row(name, version, split, frame, probability, threshold)
            row["feature_count"] = len(bundle[0].feature_names)
            rows.append(row)
            probability_cache[(name, split)] = probability
            predictions.append(
                pd.DataFrame(
                    {
                        "voyage_id": frame.voyage_id,
                        "service_date": frame.service_date.dt.date,
                        "candidate": name,
                        "split": split,
                        "actual": frame.target_weather_cancelled,
                        "probability": probability,
                    }
                )
            )

    # Blend ratio is selected on validation only. The hybrid tree contributes
    # point-specific nonlinear risk while V1 logistic anchors calibration.
    blend_scores = []
    validation_actual = validation_v2.target_weather_cancelled.to_numpy(int)
    for v2_weight in np.linspace(0, 1, 21):
        probability = (
            (1 - v2_weight) * probability_cache[("v1_logistic", "validation")]
            + v2_weight * probability_cache[("v2_hybrid_gbdt", "validation")]
        )
        blend_scores.append((average_precision(validation_actual, probability), -log_loss(validation_actual, probability), float(v2_weight)))
    _, _, v2_weight = max(blend_scores)
    blend_name = "v2_ensemble_v1_logistic_plus_hybrid_gbdt"
    validation_blend = (
        (1 - v2_weight) * probability_cache[("v1_logistic", "validation")]
        + v2_weight * probability_cache[("v2_hybrid_gbdt", "validation")]
    )
    blend_threshold, _ = select_threshold(validation_actual, validation_blend)
    for split, frame in (("validation", validation_v2), ("test", test_v2)):
        probability = (
            (1 - v2_weight) * probability_cache[("v1_logistic", split)]
            + v2_weight * probability_cache[("v2_hybrid_gbdt", split)]
        )
        row = metric_row(blend_name, "v2-ensemble-1", split, frame, probability, blend_threshold)
        row["feature_count"] = len(candidates["v2_hybrid_gbdt"][1][0].feature_names)
        row["v2_weight"] = v2_weight
        rows.append(row)
        predictions.append(
            pd.DataFrame(
                {
                    "voyage_id": frame.voyage_id,
                    "service_date": frame.service_date.dt.date,
                    "candidate": blend_name,
                    "split": split,
                    "actual": frame.target_weather_cancelled,
                    "probability": probability,
                }
            )
        )

    metrics = pd.DataFrame(rows)
    metrics.to_csv(OUT / "model_comparison.csv", index=False, encoding="utf-8-sig")
    pd.concat(predictions, ignore_index=True).to_csv(OUT / "predictions.csv", index=False, encoding="utf-8-sig")
    missingness = active_missingness(v2)
    missingness.to_csv(OUT / "active_point_missingness.csv", index=False, encoding="utf-8-sig")

    validation_v2_rows = metrics[(metrics.version.str.startswith("v2-")) & (metrics.split == "validation")]
    best_name = validation_v2_rows.sort_values(["pr_auc", "brier"], ascending=[False, True]).iloc[0].candidate
    best_bundle = candidates[best_name][1] if best_name in candidates else candidates["v2_hybrid_gbdt"][1]
    spec = feature_spec(best_bundle[0])
    spec.to_csv(OUT / "model_input_specification_v2.csv", index=False, encoding="utf-8-sig")

    v1_bundle = candidates["v1_logistic"][1]
    hybrid_bundle = candidates["v2_hybrid_gbdt"][1]
    portable = {
        "schema_version": "v2-ensemble-1",
        "status": "offline_candidate_not_for_production",
        "probability_meaning": "probability of weather/marine cancellation for the voyage",
        "blend": {
            "v1_weight": 1 - v2_weight,
            "v2_weight": v2_weight,
            "decision_threshold": blend_threshold,
        },
        "v1_component": {
            "schema_version": "v1-127",
            "preprocessor": v1_bundle[0].to_dict(),
            "model": v1_bundle[1].to_dict(),
            "calibrator": v1_bundle[2].to_dict(),
        },
        "v2_component": {
            "schema_version": "v2-hybrid-1",
            "preprocessor": hybrid_bundle[0].to_dict(),
            "model": hybrid_bundle[1].to_dict(),
            "calibrator": hybrid_bundle[2].to_dict(),
        },
    }
    (OUT / "offline_portable_model_v2.json").write_text(json.dumps(portable, ensure_ascii=False), encoding="utf-8")

    test_rows = metrics[metrics.split == "test"].sort_values("pr_auc", ascending=False)
    best_test = test_rows[test_rows.candidate == best_name].iloc[0]
    baseline = test_rows[test_rows.candidate == "v1_logistic"].iloc[0]
    ensemble = test_rows[test_rows.candidate == blend_name].iloc[0]
    report = f"""# 地点分離ML V2 オフライン学習結果

## 結論

- 検証期間で選ばれたV2候補: **{best_name}**（入力 {int(best_test.feature_count)}特徴量）
- V2最終テスト: PR-AUC {best_test.pr_auc:.4f}, ROC-AUC {best_test.roc_auc:.4f}, Brier {best_test.brier:.4f}, Log Loss {best_test.log_loss:.4f}
- V2閾値評価: Recall {best_test.recall:.1%}, Precision {best_test.precision:.1%}, 誤警報率 {best_test.false_positive_rate:.1%}
- V1現行再現: PR-AUC {baseline.pr_auc:.4f}, Brier {baseline.brier:.4f}, Recall {baseline.recall:.1%}, Precision {baseline.precision:.1%}
- PR-AUC差: {best_test.pr_auc - baseline.pr_auc:+.4f}、Brier差: {best_test.brier - baseline.brier:+.4f}
- 検証期間だけで比率を決めたV1/V2ブレンド（V2比率 {v2_weight:.0%}）: PR-AUC {ensemble.pr_auc:.4f}, Brier {ensemble.brier:.4f}, Recall {ensemble.recall:.1%}, Precision {ensemble.precision:.1%}
- 本番モデル、Worker、`models/` は変更していない。

## V2の変更点

- 全11地点を分離する298特徴量案と、V1の航路情報へ重要地点を追加する192特徴量案を比較。
- 選択候補は後者。大島北、大島西、相模灘中央、浦賀、対岸港について、最大風速、最大突風、最低気圧、最大波高、波周期、最大うねり、うねり周期、3/6時間変化、基準超過時間を地点別に保持。
- 航路全体の文脈を残しながら、重要地点が平均値に埋もれない構成。
- 単位、元データ、JST時間窓、気象海象欠航ラベルの意味はV1から変更していない。

## 評価設計

- 学習: 2024-07-09〜2025-09-30
- Platt校正: 2025Q4
- モデル・閾値選択: 2026-01〜05
- 最終テスト: 2026-06〜09-17
- 信頼区間: 運航日単位1,000回ブートストラップ

## 制約

- 岡田と元町は海洋APIの返却グリッドが同一で、海況の実質的な分離はできない。天気地点は別座標。
- 入力は実測・再解析で、当時の予報スナップショットではない。
- テスト期間を見た後の本番採用には、今後蓄積する予報スナップショットでの追加検証が必要。
"""
    (OUT / "README.md").write_text(report, encoding="utf-8")
    summary = {
        "selected_v2_candidate_on_validation": best_name,
        "v2_feature_count": int(best_test.feature_count),
        "v2_test_pr_auc": float(best_test.pr_auc),
        "v1_test_pr_auc": float(baseline.pr_auc),
        "v2_test_brier": float(best_test.brier),
        "v1_test_brier": float(baseline.brier),
        "ensemble_v2_weight": v2_weight,
        "ensemble_test_pr_auc": float(ensemble.pr_auc),
        "ensemble_test_brier": float(ensemble.brier),
        "production_modified": False,
    }
    (OUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
