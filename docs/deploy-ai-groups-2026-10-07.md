# 直接120b評価・日数別集約の公開記録

- 公開先: https://tokai-kisen-forecast-preview.hareharenohara.workers.dev
- Worker: tokai-kisen-forecast-preview
- Version: 36375194-f76b-4d0b-8d8a-1c41efc427ec
- AI: openai/gpt-oss-120b、整理モデルなし
- Prompt: assessment-v12-groq-direct-groups
- 適用した追加DB変更: 0015_group_forecasts.sql のみ（集約評価テーブルと索引）
- 更新設定: `0,10,30 * * * *`（日数別時刻の判定）、`20,40,50 * * * *`（公開通知確認）、`0 18 * * *`（03:00 JST時刻表同期）

型チェック、全95件のローカルテスト、Workerの公開前ビルドが成功しました。公開後のhealthで120b直接評価・整理なし・集約対象2/3/4日先を確認。公開一覧APIが正常応答し、全日付にgroup_forecasts配列を返すこと、公開画面スクリプトに集約表示が含まれ構文が正常なことを確認しました。

公開直後の新しい集約評価はまだ0件でした。各日数の次回定期更新から順次生成されます。AIの実際の返却品質、使用トークン量、無料日次枠への収まりは、稼働後のAI監査記録で別途確認する必要があります。手動でAI評価を追加実行したり、既存予測履歴を削除したりはしていません。

仕様: [更新時刻と集約評価](forecast-update-schedule-2026-10-07.md)
