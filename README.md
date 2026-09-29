# 伊豆大島・東海汽船 就航予測システム

東海汽船の伊豆大島関連便について、未来の気象・海象から気象欠航リスクを検出し、複数予報モデルとGeminiの二段階評価を返すシステムです。Phase 1・2と、Phase 3のD1/Cron preview基盤を実装済みです。

Preview Worker: `https://tokai-kisen-forecast-preview.hareharenohara.workers.dev`

別端末で開発を再開する場合は [開発引き継ぎガイド](docs/HANDOFF.md) を最初に参照してください。

Cronは公式時刻表から確認済みの基幹便をD1へ同期してから、4日先までの未出航便を予測します。同一Cron内のOpen-Meteo予報は全便で共有されます。

ルートURLではスマホ向けUI「島ゆき予報」を配信します。日別サマリー、便一覧、便詳細、ML暫定値、確信度、モデル別欠航リスク、予測推移、前回比較を表示します。ライト/ダーク表示はOS設定に追従し、手動で選んだ設定も保存します。

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

Worker APIのローカル起動:

```powershell
pnpm worker:types
pnpm db:migrate:local
pnpm worker:dev -- --env preview
```

別のターミナルから `GET http://127.0.0.1:8787/health`、`POST http://127.0.0.1:8787/api/predict`、または `POST http://127.0.0.1:8787/api/assess` を呼び出します。保存済み結果は `GET /api/days`、`GET /api/services/:id`、`GET /api/services/:id/history` で取得できます。`/api/assess` は複数モデル比較、Gemini 3.5 Flash-Liteによる整理、Gemini 3.8 Flashによる最終評価を順に実行します。Geminiが失敗した場合もML比較結果を返します。リクエスト仕様は [API](docs/api.md) にあります。

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

APIキーはローカルの `.dev.vars.preview` またはCloudflare Secretだけに保存します。

## Gemini APIキー

キーをチャット、ソースコード、`wrangler.jsonc`へ記載しないでください。ローカルpreviewでは `.dev.vars.example` を `.dev.vars.preview` へコピーし、`GEMINI_API_KEY` の値を入力します。このファイルはGit管理から除外されています。

Cloudflare previewへ登録する場合は、次を実行して表示される非表示プロンプトへキーを入力します。

```powershell
pnpm exec wrangler secret put GEMINI_API_KEY --env preview
```

productionは公開準備時に `--env production` で別途登録します。
