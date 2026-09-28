# 伊豆大島・東海汽船 就航予測システム

東海汽船の伊豆大島関連便について、未来の気象・海象から気象欠航リスクを検出するシステムです。現在はマスター仕様の Phase 1 を実装中です。

## 現在の機能

1便の予定情報を受け取り、Open-Meteoから監査済み11地点の5日予報を取得し、学習時と同じ時間窓で127特徴量を生成・検証します。提供モデルが監査済み127入力と一致するときだけ推論します。不一致や欠損時は数値を捏造せず `prediction_unavailable` にします。

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

終了コード `2` と `MODEL_INCOMPATIBLE` は、提供された131入力モデルを意図どおり拒否した状態です。詳細は [Phase 1 status](docs/phase-1-status.md) を参照してください。

## 構成

- `src/config`: 監査済み地点・航路対応
- `src/forecast`: Open-Meteo取得と正規化
- `src/ml`: 特徴量生成、検証、モデル互換性確認、推論
- `models`: 提供されたCloudflare用モデル（現状は131入力）
- `docs/model`: 監査済みモデル入力仕様と監査結果
- `test`: unit/integration相当のローカルテスト

秘密情報は現在不要です。将来の環境変数は値をコミットせず `.env.example` に名前と説明だけを追加します。
