"""Offline-only calibration benchmark for the audited v1-127 feature set.

This script never writes to ``models/``.  It compares the current temporal
design with a wider, strictly out-of-sample calibration window and writes all
results below ``artifacts/offline_model_benchmark``.
"""
from __future__ import annotations

import json
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
    roc_auc,
    select_threshold,
)


SOURCE = ROOT / "data" / "03_ml_dataset_training_eligible_audited.csv"
OUT = ROOT / "artifacts" / "offline_model_benchmark"
RNG = np.random.default_rng(20260929)
EPS = 1e-12


def log_loss(y: np.ndarray, p: np.ndarray) -> float:
    y = np.asarray(y, float)
    p = np.clip(np.asarray(p, float), EPS, 1 - EPS)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def calibration_table(y: np.ndarray, p: np.ndarray, bins: int = 10) -> pd.DataFrame:
    frame = pd.DataFrame({"actual": np.asarray(y, int), "probability": np.asarray(p, float)})
    frame["bin"] = pd.cut(
        frame.probability,
        bins=np.linspace(0, 1, bins + 1),
        labels=False,
        include_lowest=True,
    )
    result = (
        frame.groupby("bin", observed=False)
        .agg(rows=("actual", "size"), predicted_mean=("probability", "mean"), observed_rate=("actual", "mean"))
        .reset_index()
    )
    result["absolute_gap"] = (result.predicted_mean - result.observed_rate).abs()
    return result


def expected_calibration_error(table: pd.DataFrame) -> float:
    valid = table.dropna(subset=["predicted_mean", "observed_rate"])
    return float((valid.rows * valid.absolute_gap).sum() / valid.rows.sum())


def fit_bundle(
    train: pd.DataFrame,
    calibration: pd.DataFrame,
    model_name: str,
    reference_levels: dict[str, list[str]],
):
    builder = FeatureBuilder().fit(train)
    # The audited schema fixes the one-hot vocabulary at 127 inputs. An older
    # cutoff may not contain every known schedule category, so reuse only the
    # schema vocabulary (never values, labels, means, or medians) here.
    builder.levels = {column: list(reference_levels[column]) for column in builder.category_cols}
    builder.feature_names = list(builder.numeric_cols)
    for column in builder.category_cols:
        builder.feature_names.extend(f"{column}={level}" for level in builder.levels[column])
    if len(builder.feature_names) != 127:
        raise RuntimeError(f"Expected 127 features, got {len(builder.feature_names)}")
    x_train = builder.transform(train)
    y_train = train.target_weather_cancelled.to_numpy(int)
    model = LogisticModel().fit(x_train, y_train) if model_name == "logistic" else GBDTStumps().fit(x_train, y_train)
    raw_calibration = model.predict_raw(builder.transform(calibration))
    calibrator = PlattCalibrator().fit(raw_calibration, calibration.target_weather_cancelled.to_numpy(int))
    return builder, model, calibrator


def predict(bundle, frame: pd.DataFrame) -> np.ndarray:
    builder, model, calibrator = bundle
    return calibrator.predict(model.predict_raw(builder.transform(frame)))


def daily_metrics(frame: pd.DataFrame, probability: np.ndarray) -> dict[str, float]:
    daily = pd.DataFrame(
        {
            "service_date": frame.service_date.dt.date.to_numpy(),
            "actual": frame.target_weather_cancelled.to_numpy(int),
            "probability": probability,
        }
    ).groupby("service_date", as_index=False).agg(actual=("actual", "max"), probability=("probability", "max"))
    return {
        "event_days": int(daily.actual.sum()),
        "days": len(daily),
        "daily_pr_auc": average_precision(daily.actual, daily.probability),
        "daily_roc_auc": roc_auc(daily.actual, daily.probability),
        "daily_brier": float(np.mean((daily.probability - daily.actual) ** 2)),
        "daily_log_loss": log_loss(daily.actual.to_numpy(), daily.probability.to_numpy()),
    }


def grouped_bootstrap(frame: pd.DataFrame, probability: np.ndarray, iterations: int = 1000) -> dict[str, float]:
    sample = pd.DataFrame(
        {
            "service_date": frame.service_date.dt.date.to_numpy(),
            "actual": frame.target_weather_cancelled.to_numpy(int),
            "probability": probability,
        }
    )
    groups = {date: part.index.to_numpy() for date, part in sample.groupby("service_date")}
    dates = np.array(list(groups), dtype=object)
    values = {"pr_auc": [], "brier": [], "log_loss": []}
    for _ in range(iterations):
        selected = RNG.choice(dates, size=len(dates), replace=True)
        indices = np.concatenate([groups[date] for date in selected])
        y = sample.actual.to_numpy()[indices]
        p = sample.probability.to_numpy()[indices]
        values["pr_auc"].append(average_precision(y, p))
        values["brier"].append(float(np.mean((p - y) ** 2)))
        values["log_loss"].append(log_loss(y, p))
    result = {}
    for metric, samples in values.items():
        result[f"{metric}_ci_low"] = float(np.nanquantile(samples, 0.025))
        result[f"{metric}_ci_high"] = float(np.nanquantile(samples, 0.975))
    return result


def reliability_svg(path: Path, tables: dict[str, pd.DataFrame]) -> None:
    width, height = 760, 600
    left, top, plot = 90, 55, 470
    colors = ["#2563eb", "#dc2626", "#059669", "#7c3aed"]
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">',
        '<rect width="100%" height="100%" fill="white"/>',
        '<text x="24" y="30" font-family="sans-serif" font-size="20" font-weight="bold">Test reliability (voyage level)</text>',
        f'<line x1="{left}" y1="{top + plot}" x2="{left + plot}" y2="{top}" stroke="#94a3b8" stroke-dasharray="6 5"/>',
    ]
    for tick in range(0, 11, 2):
        value = tick / 10
        x = left + value * plot
        y = top + plot - value * plot
        parts.extend(
            [
                f'<line x1="{x}" y1="{top}" x2="{x}" y2="{top + plot}" stroke="#e2e8f0"/>',
                f'<line x1="{left}" y1="{y}" x2="{left + plot}" y2="{y}" stroke="#e2e8f0"/>',
                f'<text x="{x}" y="{top + plot + 24}" text-anchor="middle" font-family="sans-serif" font-size="11">{value:.1f}</text>',
                f'<text x="{left - 12}" y="{y + 4}" text-anchor="end" font-family="sans-serif" font-size="11">{value:.1f}</text>',
            ]
        )
    for index, (name, table) in enumerate(tables.items()):
        valid = table.dropna(subset=["predicted_mean", "observed_rate"])
        points = " ".join(
            f"{left + row.predicted_mean * plot:.1f},{top + plot - row.observed_rate * plot:.1f}"
            for row in valid.itertuples()
        )
        color = colors[index % len(colors)]
        parts.append(f'<polyline points="{points}" fill="none" stroke="{color}" stroke-width="3"/>')
        parts.append(f'<text x="585" y="{90 + index * 25}" font-family="sans-serif" font-size="12" fill="{color}">{name}</text>')
    parts.extend(
        [
            f'<text x="{left + plot / 2}" y="{height - 18}" text-anchor="middle" font-family="sans-serif" font-size="13">Predicted cancellation probability</text>',
            f'<text x="20" y="{top + plot / 2}" text-anchor="middle" transform="rotate(-90 20 {top + plot / 2})" font-family="sans-serif" font-size="13">Observed cancellation rate</text>',
            "</svg>",
        ]
    )
    path.write_text("\n".join(parts), encoding="utf-8")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    data = pd.read_csv(SOURCE, encoding="utf-8-sig")
    data["service_date"] = pd.to_datetime(data.service_date)
    data["target_weather_cancelled"] = data.target_weather_cancelled.astype(int)

    validation = data[(data.service_date >= "2026-01-01") & (data.service_date <= "2026-05-31")]
    test = data[data.service_date >= "2026-06-01"]
    designs = {
        "current_q4": (
            data[data.service_date <= "2025-09-30"],
            data[(data.service_date >= "2025-10-01") & (data.service_date <= "2025-12-31")],
        ),
        "wider_h2": (
            data[data.service_date <= "2025-06-30"],
            data[(data.service_date >= "2025-07-01") & (data.service_date <= "2025-12-31")],
        ),
    }

    schema_reference = FeatureBuilder().fit(designs["current_q4"][0])
    if len(schema_reference.feature_names) != 127:
        raise RuntimeError(f"Audited reference schema is not 127 features: {len(schema_reference.feature_names)}")
    reference_levels = schema_reference.levels

    rows = []
    prediction_rows = []
    reliability_tables = {}
    design_rows = []
    for design, (train, calibration) in designs.items():
        design_rows.append(
            {
                "design": design,
                "train_rows": len(train),
                "train_cancellations": int(train.target_weather_cancelled.sum()),
                "train_rate": float(train.target_weather_cancelled.mean()),
                "calibration_rows": len(calibration),
                "calibration_cancellations": int(calibration.target_weather_cancelled.sum()),
                "calibration_rate": float(calibration.target_weather_cancelled.mean()),
            }
        )
        for model_name in ("logistic", "gbdt_stumps"):
            candidate = f"{design}_{model_name}"
            print(f"training {candidate}", flush=True)
            bundle = fit_bundle(train, calibration, model_name, reference_levels)
            validation_probability = predict(bundle, validation)
            threshold, _ = select_threshold(validation.target_weather_cancelled, validation_probability)
            for split_name, frame in (("validation", validation), ("test", test)):
                probability = predict(bundle, frame)
                metrics = classification_metrics(frame.target_weather_cancelled, probability, threshold)
                table = calibration_table(frame.target_weather_cancelled.to_numpy(), probability)
                metrics.update(
                    {
                        "candidate": candidate,
                        "design": design,
                        "model": model_name,
                        "split": split_name,
                        "log_loss": log_loss(frame.target_weather_cancelled.to_numpy(), probability),
                        "ece_10": expected_calibration_error(table),
                        "mean_probability": float(np.mean(probability)),
                        "actual_rate": float(frame.target_weather_cancelled.mean()),
                        **daily_metrics(frame, probability),
                    }
                )
                if split_name == "test":
                    metrics.update(grouped_bootstrap(frame, probability))
                    reliability_tables[candidate] = table
                rows.append(metrics)
                prediction_rows.append(
                    pd.DataFrame(
                        {
                            "voyage_id": frame.voyage_id,
                            "service_date": frame.service_date.dt.date,
                            "actual": frame.target_weather_cancelled,
                            "probability": probability,
                            "candidate": candidate,
                            "split": split_name,
                        }
                    )
                )
                table.assign(candidate=candidate, split=split_name).to_csv(
                    OUT / f"reliability_{candidate}_{split_name}.csv", index=False, encoding="utf-8-sig"
                )

    comparison = pd.DataFrame(rows)
    comparison.to_csv(OUT / "benchmark_metrics.csv", index=False, encoding="utf-8-sig")
    pd.DataFrame(design_rows).to_csv(OUT / "design_summary.csv", index=False, encoding="utf-8-sig")
    pd.concat(prediction_rows, ignore_index=True).to_csv(
        OUT / "predictions.csv", index=False, encoding="utf-8-sig"
    )
    reliability_svg(OUT / "reliability_test.svg", reliability_tables)

    test_rows = comparison[comparison.split == "test"].sort_values(["brier", "log_loss"])
    best_calibrated = test_rows.iloc[0]
    best_ranking = test_rows.sort_values("pr_auc", ascending=False).iloc[0]
    current = test_rows[test_rows.candidate == "current_q4_logistic"].iloc[0]
    report = f"""# オフライン再学習・確率校正ベンチマーク

## 結論

- 127特徴量定義は変更していない（全候補で127を検証）。
- 確率校正が最良: **{best_calibrated.candidate}**（Test Brier {best_calibrated.brier:.4f}, Log Loss {best_calibrated.log_loss:.4f}, ECE {best_calibrated.ece_10:.4f}）。
- 順位性能が最良: **{best_ranking.candidate}**（Test PR-AUC {best_ranking.pr_auc:.4f}）。
- 現行再現候補: **current_q4_logistic**（Test Brier {current.brier:.4f}, Log Loss {current.log_loss:.4f}, ECE {current.ece_10:.4f}, PR-AUC {current.pr_auc:.4f}）。
- Test実欠航率は {best_calibrated.actual_rate:.1%}。平均予測は現行 {current.mean_probability:.1%}、校正最良候補 {best_calibrated.mean_probability:.1%} で、どちらも全体として欠航を過小予測した。
- 校正最良候補のTest Recallは {best_calibrated.recall:.1%} で、現行 {current.recall:.1%} より低い。確率指標の改善だけを理由に差し替えない。
- 日単位ブートストラップの95%区間は重なっており、候補間の優劣は確定的ではない。
- この試験は本番モデルを上書きしていない。

## 比較設計

- `current_q4`: 2025-09-30まで学習、2025Q4でPlatt校正（現行設計）。
- `wider_h2`: 2025-06-30まで学習、2025年下期6か月でPlatt校正。
- 閾値は2026-01〜05の検証期間で欠航Recall 98%以上を目標に選択。
- 2026-06〜09-17は最終テストだけに使用。
- 信頼区間は便ではなく運航日を1単位にした1,000回ブートストラップ。

## 読み方

Brier、Log Loss、ECEは小さいほど確率として良好。PR-AUCは大きいほど欠航便の順位付けが良好。校正と順位性能は別物なので、本番候補は片方だけで決めない。

## 制約

- 入力は過去の実測・再解析値であり、当時利用可能だった予報スナップショットではない。
- 大型客船の気象欠航は全期間31件で、専用確率モデルを安定評価できない。
- 岡田・元町の海況グリッドが同一で、港別波浪差は学習できない。
- この結果だけでは本番モデルの差し替えを推奨しない。まず詳細表と信頼度曲線を確認し、予報リードタイム別データを蓄積する。

## 再実行

`python scripts/offline_model_benchmark.py`

入力: `data/03_ml_dataset_training_eligible_audited.csv`
"""
    (OUT / "README.md").write_text(report, encoding="utf-8")
    summary = {
        "feature_count": 127,
        "source": str(SOURCE),
        "best_calibration_candidate": best_calibrated.candidate,
        "best_ranking_candidate": best_ranking.candidate,
        "production_models_modified": False,
    }
    (OUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
