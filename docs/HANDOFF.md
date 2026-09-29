# 別端末への開発引き継ぎ

最終更新: 2026-09-28

## リポジトリと公開環境

- GitHub: https://github.com/hareharenohara/oshima-transport-forecast
- 開発ブランチ: `main`
- Preview UI/API: https://tokai-kisen-forecast-preview.hareharenohara.workers.dev
- Cloudflare Worker: `tokai-kisen-forecast-preview`
- Preview D1: `tokai-kisen-forecast-preview`（APAC）
- Cron: 日本時間の偶数時（0時、2時、…、22時）。CloudflareのUTC設定は `0 1,3,5,7,9,11,13,15,17,19,21,23 * * *`
- AI: Groq（整理 `openai/gpt-oss-20b`、最終 `openai/gpt-oss-120b`）を主系とし、Geminiを副系にする
- Preview Worker version: `bab273f9-0dea-4af0-80e8-3e314626d6fe`

GitHubの `main` が正本です。OneDrive上の元フォルダやDownloads内のZIPがなくても、現在のWorker、モデル、マイグレーション、UI、テストは復元できます。再学習だけは元データZIPが別途必要です。

## 新しい端末での開始手順

```powershell
git clone https://github.com/hareharenohara/oshima-transport-forecast.git
cd oshima-transport-forecast
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm worker:check
```

動作確認済みの開発環境はNode.js `24.19.0`、pnpm `11.19.0`、Python `3.10.6`、Wrangler `4.141.0` です。Pythonはモデル再学習時だけ必要です。

## Cloudflareを操作する場合

```powershell
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm exec wrangler d1 migrations list tokai-kisen-forecast-preview --remote --env preview
```

Cloudflareアカウントは `hareharenohara` のGitHubアカウントとは別の認証です。別端末ではブラウザOAuthによるWranglerログインが必要です。

Previewへ反映する手順:

```powershell
pnpm typecheck
pnpm test
pnpm worker:check
pnpm exec wrangler d1 migrations apply tokai-kisen-forecast-preview --remote --env preview
pnpm exec wrangler deploy --env preview
```

新しいマイグレーションがない場合、migrations applyは何も変更しません。

## Gemini APIキー

キーの値はGitHubに保存していません。Cloudflare previewには `GEMINI_API_KEY` Secretとして登録済みです。そのため、通常のpreviewデプロイだけなら再入力は不要です。

別端末でGeminiを含むローカル実行を行う場合:

```powershell
Copy-Item .dev.vars.example .dev.vars.preview
```

作成した `.dev.vars.preview` にキーを入力します。このファイルは `.gitignore` 対象です。キーをチャット、コミット、README、`wrangler.jsonc` に記載しないでください。

Cloudflare Secretを再登録する必要がある場合だけ、次を実行します。

```powershell
pnpm exec wrangler secret put GEMINI_API_KEY --env preview
```

## ローカルD1とWorker

```powershell
pnpm db:migrate:local
pnpm worker:dev
```

ローカルD1は `.wrangler/` に作成され、Git管理されません。別端末のローカルD1が空なのは正常です。リモートpreview D1には便・予測履歴があります。

## 実装済み

- 監査済み127特徴量の生成・欠損拒否
- V1ロジスティック回帰85%＋地点分離V2 GBDT 15%によるML推論（V1は切り戻し用に保持）
- JMA MSM、ECMWF IFS、GFS、ECMWF WAM、GFS Waveの比較
- Gemini 3.5 Flash-Lite整理とGemini 3.8 Flash最終評価
- Gemini障害時のMLフォールバック
- D1への追記型予測履歴
- 2時間Cron、重複実行防止、実行ログ
- 公式時刻表に基づく基幹便のダイヤ同期
- 日別、便一覧、便詳細のスマホUI
- PWA、オフライン時の最終取得値表示、ログイン不要のPush通知設定
- Preview Worker/D1へのデプロイ

## 現在の注意点

- 手動検証で保存した既存20便のAI状態は、意図的にGeminiを無効化したため `unavailable` です。UIではML暫定値として表示します。
- 通常CronではCloudflare Secretが渡るため、以後の履歴ではGemini評価を試行します。
- A/B/C運航日カレンダーに依存する一部ジェット便は、推測を避けてまだ収録していません。
- 風、波、うねりの時系列はD1にまだ保存していないため、UIグラフは未実装です。
- Production D1のIDはプレースホルダーです。`--env production` でデプロイしないでください。
- このサービスは公式運航情報ではありません。
- PreviewにはVAPID鍵3種がSecret登録済みで、migration `0003_phase5_push.sql` も適用済みです。秘密鍵はGitに保存していません。

## 次に行う作業

1. 予報時系列の保存用マイグレーションを追加する。
2. Cronで風速、突風、波高、波周期、うねり高の代表系列を保存する。
3. 便詳細に時系列グラフを追加する。
4. 通常CronでGemini生成履歴が保存されたことを確認する。
5. A/B/C運航日カレンダーを公式資料から安全に構造化する。
6. 完成確認後にproduction D1を作成する。

## 状態確認コマンド

```powershell
git status --short --branch
git log -5 --oneline
pnpm test
pnpm exec wrangler d1 execute tokai-kisen-forecast-preview --remote --env preview --command "SELECT status, target_count, success_count, error_count, duration_ms FROM forecast_runs ORDER BY run_at DESC LIMIT 5;"
```

関連文書:

- `docs/spec.md`: マスター仕様
- `docs/phase-1-status.md`: 特徴量とモデル
- `docs/phase-2-status.md`: 複数モデルとGemini
- `docs/phase-3-status.md`: D1、Cron、ダイヤ
- `docs/phase-4-status.md`: スマホUI
- `docs/api.md`: API仕様
