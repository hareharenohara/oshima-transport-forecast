# 伊豆大島・東海汽船 就航予測システム

東海汽船の伊豆大島関連便について、未来の気象・海象から気象欠航リスクを検出するシステムです。現在はマスター仕様の Phase 1 を実装中です。

## 現在の機能

1便の予定情報を受け取り、Open-Meteoから監査済み11地点の5日予報を取得し、学習時と同じ時間窓で127特徴量を生成・検証して欠航確率を返します。不一致や欠損時は数値を捏造せず `prediction_unavailable` にします。

## セットアップと検証

```powershell
pnpm install
pnpm typecheck
pnpm test
```

実API確認例（日時は現在から4日以内のJSTに変更）:

```powershell
pnpm predict -- --departure 2026-09-29T08:00:00+09:00 --arrival 2026-09-29T09:45:00+09:00 --terminal 東京 --ship jet --voyage 1100 --direction to_oshima
```

監査済み127特徴量モデルは提供時系列データから再構築済みです。再学習方法と評価値は [Phase 1 status](docs/phase-1-status.md) を参照してください。

## モデル再学習

提供データZIPから次の3ファイルを `data/` に展開します（`data/` はGit管理外です）。

- `02_weather_hourly_raw.csv`
- `02_marine_hourly_raw.csv`
- `03_ml_dataset_training_eligible.csv`

その後、監査済み時間窓を再構築して学習します。

```powershell
python scripts/rebuild_audited_training_features.py
python scripts/retrain_model_127.py
```

評価成果物は `artifacts/model_training_v1_127/` に生成されます。採用モデルを変更する際は、評価値とゴールデンテストを確認してから `models/cloudflare_portable_model.json` を更新します。

## 構成

- `src/config`: 監査済み地点・航路対応
- `src/forecast`: Open-Meteo取得と正規化
- `src/ml`: 特徴量生成、検証、モデル互換性確認、推論
- `models`: 監査済み127入力モデルと提供された旧131入力モデル
- `docs/model`: 監査済みモデル入力仕様と監査結果
- `test`: unit/integration相当のローカルテスト

秘密情報は現在不要です。将来の環境変数は値をコミットせず `.env.example` に名前と説明だけを追加します。
