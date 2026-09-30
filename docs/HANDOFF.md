# 別端末への開発引き継ぎ

> **最新の引き継ぎは [HANDOFF-2026-09-30.md](HANDOFF-2026-09-30.md) を参照してください。**
> 今回の未保存作業は `codex/handoff-2026-09-30` に保存しています。mainだけでは取得できません。
> 以下は2026-09-29時点の旧記録です。Cron、UI、次の作業は更新されています。

最終更新: 2026-09-29

## リポジトリと公開環境

- GitHub: https://github.com/hareharenohara/oshima-transport-forecast
- 正本ブランチ: `main`
- 引継ぎ時の最新コミット: `fc65b70 feat: compact header and show update schedule`
- Preview UI/API: https://tokai-kisen-forecast-preview.hareharenohara.workers.dev
- Preview Worker version: `93e2a1cc-8dbd-481b-a1d5-3d6c23048a5d`
- Preview D1: `tokai-kisen-forecast-preview`（binding `DB`）
- Cron: 日本時間の偶数時（0時、2時、…、22時）
- Cloudflare cron: `0 1,3,5,7,9,11,13,15,17,19,21,23 * * *`

GitHubの `main` が正本です。Production D1はまだプレースホルダーなので、`--env production` ではデプロイしないでください。

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

動作確認済み環境はNode.js `24.19.0`、pnpm `11.19.0`、Python `3.10.6`、Wrangler `4.141.0`です。通常開発ではPythonは不要です。

## Cloudflareを操作する場合

別端末では最初にWranglerへログインします。

```powershell
pnpm exec wrangler login
pnpm exec wrangler whoami
```

Previewへ反映する前に検証します。

```powershell
pnpm typecheck
pnpm test
pnpm worker:check
pnpm exec wrangler deploy --env preview
```

マイグレーションを追加した場合だけ、デプロイ前に以下を実行します。

```powershell
pnpm exec wrangler d1 migrations apply tokai-kisen-forecast-preview --remote --env preview
```

## APIキー

GroqとGeminiのキーはGitHubに保存していません。Cloudflare previewにはSecretとして登録済みなので、通常のpreviewデプロイでは再入力不要です。ローカルでAI呼び出しを試す場合だけ `.dev.vars.example` から `.dev.vars.preview` を作り、手元のキーを入力します。キーをソース、文書、チャットへ記載しないでください。

## 現在の判定ロジック

- AI評価は `S / A / B / C / D` の5段階
- `S`: 就航の可能性が高い
- `A`: 就航寄り
- `B`: 判断が分かれる
- `C`: 欠航寄り
- `D`: 欠航の可能性が高い
- 気象・海象・航路上の予報を先に評価し、MLは最後に参考情報として渡す
- Groq `openai/gpt-oss-20b`で整理し、`openai/gpt-oss-120b`で最終判断
- Groq障害時はGeminiへフォールバック
- 最大4便ずつに分割し、トークン量を抑えて全便を処理
- AIコメントは日本語を指示しているが、英語検出による強制再生成はユーザー判断で入れていない

## 現在のUI

- 日別カードは初期状態で閉じる
- 日別評価は便ごとのAI評価の平均を丸め、5分割バーで表示
- 日付の横に出帆港予測を表示
- 便一覧は `時間 → 船種 → 航路 → 評価` の1行表示
- 高速ジェット船は `JF`、大型客船は `大型船`
- 便詳細のAI評価も5分割表示
- 確信度、ML参考値の円グラフ、不要な開発者向け見出しは画面から非表示
- AI評価履歴は保存済みの実在する `S/A/B/C/D` のみを表示
- 風・突風・波高・波周期・うねり高のグラフに日本時間の横軸を表示
- ヘッダーは「大島航路予報」と操作ボタンだけに縮小
- 上部に最終更新時刻と次回更新予定時刻を表示
- 予測情報の注意書きはページ下部に配置

## PWAの状態

HTTPS、Manifest、standalone表示、Service Worker、オフライン時の保存済み予測、Push通知は実装済みです。2026-09-29の点検で、次の改善候補を確認しています。

1. バージョン付きCSS・JavaScriptをService Workerの初回キャッシュへ直接含める。
2. キャッシュ版をUIの版と連動させる。
3. 192px、512px、maskable用の正式なPNGアイコンを作る。
4. 初回インストール直後のオフライン起動テストを追加する。

島・船・波を使ったアイコン試作1案はユーザーが却下したため、実装・デプロイ・Git保存していません。次回は別デザインから検討します。

## ユーザーとの進め方

UIや仕様を変更するときは、すぐ編集せず具体的な改善案を先に提示し、ユーザーの許可後に実装します。許可後はテスト、Previewデプロイ、配信確認、GitHubへのpushまで行います。

## 次に検討する作業

1. 正式なPWAアイコンの別案を試作する。
2. 承認されたアイコンを192px、512px、maskable版へ書き出してManifestへ設定する。
3. Service Workerの初回キャッシュとキャッシュ版管理を強化する。
4. Android実機でホーム画面追加、更新、オフライン起動を確認する。
5. UIを継続確認し、日別カードや便詳細の文言・余白を調整する。
6. 完成確認後にProduction D1を作成する。

## 状態確認コマンド

```powershell
git status --short --branch
git log -5 --oneline
pnpm test
pnpm exec wrangler d1 execute tokai-kisen-forecast-preview --remote --env preview --command "SELECT status, target_count, success_count, error_count, duration_ms FROM forecast_runs ORDER BY run_at DESC LIMIT 5;"
```

関連文書:

- `docs/spec.md`: マスター仕様
- `docs/ai-ordinal-assessment.md`: AI段階評価
- `docs/phase-1-status.md`: 特徴量とモデル
- `docs/phase-2-status.md`: 複数モデルとAI
- `docs/phase-3-status.md`: D1、Cron、ダイヤ
- `docs/phase-4-status.md`: スマホUI
- `docs/phase-5-status.md`: PWAと通知
- `docs/phase-6-status.md`: 公開前検証
- `docs/api.md`: API仕様
